/**
 * Replacing a Main without losing work (missions design §3.4, REQ-188, M-27).
 *
 * `replaceMain(missionId, newMainId, reason, deps)` is the one function that
 * changes a mission's Main (mission runtime design §3.4): a new mission's
 * first Main, `mission.ensure`, a code handoff (`handOverMain`), a cleared
 * conversation's successor (`createMainSuccession`), the composer adoption
 * and the fallback switch of a Main (`fallback-manager.ts`). `createMain`
 * only creates the agent. Single flight per mission; idempotent (a mission
 * naming the successor already writes nothing); compare-and-set on
 * `expectedOld`. In the design's order:
 *
 * 1. the mission's `mainId` becomes the successor (`setMain`) and the journal
 *    gets exactly one `main` line — from here every record, handoff and link
 *    addressed to "the Main" resolves to it at delivery;
 * 2. every active request of the roster: registry `managerId` = new
 *    (`reassignManager`);
 * 3. every Worker of the mission — the roster's and the registry's, a bound
 *    Worker whose binding names an earlier Main, a live Worker labelled with
 *    one — gets its binding re-pointed (`reparent`); no Worker is told;
 * 4. a live Worker's `paseo.parent-agent-id` label is set to the successor
 *    through the Paseo CLI (a refusal costs one log line: readers go to the
 *    registry's `managerId` first);
 * 5. the old Main is marked `bm.replacedBy` (when it is not known to be
 *    archived) and, once marked, retitled `replacedMainTitleOf` through the
 *    Paseo CLI (`setAgentTitle`, as `syncMainTitle` titles a Main), so its
 *    tab no longer reads as the mission's Main.
 *
 * Then, the replacement complete: the old Main's proposed answers and proposed
 * mission start are dropped (one log line), the notice queue moves what it
 * holds for the old Main to the successor (`noticeQueue.retarget`), and every
 * `pending` outbox record addressed to an earlier Main
 * is delivered again, so it resolves to the successor (`outbox.ts`
 * `mainTargetOf`) — the ones a drop held while the mission had no live Main.
 *
 * Nothing here archives, stops or deletes an agent (ADR-005). Never throws:
 * every failure past step 1 is one log line, and the replacement goes on.
 */
import { PARENT_AGENT_LABEL, listAllAgents, parentOf, roleOfAgent } from "./agent-role";
import { createBindingStore, type BindingStore } from "./agent-bindings";
import { createMissionRoster } from "./mission-roster";
import { REPLACED_BY_LABEL } from "./fallback-detect";
import { createMissionStore, journalQuietly, type Mission } from "./mission-store";
import { noticeQueue, type NoticePaseo, type NoticeQueue } from "./notice-queue";
import { createOutbox, deliverRecord, isOpenRecord } from "./outbox";
import { setAgentLabel, setAgentTitle, type CliResult, type PaseoCliDeps } from "./paseo-cli";
import { dropProposedAnswersOf } from "./proposed-answers";
import { dropProposedMissionStartOf } from "./proposed-mission-starts";
import { createRequestRegistry, type RequestRegistry } from "./request-registry";
import { replacedMainTitleOf } from "./role-title";
import { errorText } from "./rpc-kit";

export interface ReplaceMainDeps {
  home: string;
  /** The caller's Paseo handle: which agents are live, and the queue's and the outbox's deliveries. */
  paseo?: unknown;
  /** The Main replaced, when the mission names the successor already (`createMain` wrote it); the mission's `mainId` otherwise. */
  replaced?: string | null;
  /**
   * Compare-and-set (mission runtime design §3.4): the Main the caller read;
   * when the mission names another by now, nothing is written or sent. Null for
   * a mission with no Main yet; undefined skips the check.
   */
  expectedOld?: string | null;
  bindings?: BindingStore;
  queue?: Pick<NoticeQueue, "enqueue" | "retarget">;
  /** Sets one label through the Paseo CLI; `setAgentLabel` with `cli` by default. */
  setLabel?: (agentId: string, key: string, value: string) => Promise<CliResult>;
  /** Sets an agent's title through the Paseo CLI; `setAgentTitle` with `cli` by default. */
  setTitle?: (agentId: string, title: string) => Promise<CliResult>;
  cli?: PaseoCliDeps;
  now?: () => Date;
  log?: (message: string) => void;
}

export type ReplaceMainResult =
  | { ok: true; replaced: string | null; requests: number; workers: string[]; moved: number; redelivered: number }
  | { ok: false; reasons: string[] };

/** The live agents with their labels; null when Paseo cannot be read (then every agent counts as live). */
async function liveAgentsOf(paseo: unknown): Promise<Map<string, Record<string, unknown>> | null> {
  type Lister = { list(options: unknown): Promise<{ entries: Array<{ agent: Record<string, unknown> }>; pageInfo?: { nextCursor: string | null; hasMore: boolean } }> };
  const agents = (paseo as { agents?: Partial<Lister> } | null | undefined)?.agents;
  if (typeof agents?.list !== "function") return null;
  try {
    const all = await listAllAgents((options) => (agents as Lister).list(options), { includeArchived: false });
    return new Map(all.filter((agent) => !agent["archivedAt"] && agent["status"] !== "closed").map((agent) => [String(agent["id"]), agent]));
  } catch {
    return null;
  }
}

type LiveAgents = Map<string, Record<string, unknown>> | null;

/**
 * §3.4 step 2 for `entries`: each request's registry `managerId` becomes
 * `newMainId` (and its cached `missionId` `missionId`, when given). Returns the
 * requests reassigned and every Worker the roster or the registry names.
 */
function reassignEntries(
  registry: RequestRegistry,
  entries: Iterable<{ requestId: string; workspaceId: string; workerIds: readonly string[] }>,
  newMainId: string,
  log: (message: string) => void,
  missionId?: string,
): { requests: number; workers: Set<string> } {
  const workers = new Set<string>();
  let requests = 0;
  for (const entry of entries) {
    try {
      if (registry.reassignManager(entry.workspaceId, entry.requestId, newMainId, missionId)) requests += 1;
    } catch (error) {
      log(`[paseo-bm] request ${entry.requestId} could not be reassigned to the Main ${newMainId}: ${errorText(error)}`);
    }
    for (const workerId of [...entry.workerIds, ...(registry.get(entry.workspaceId, entry.requestId)?.workerIds ?? [])]) workers.add(workerId);
  }
  return { requests, workers };
}

/**
 * §3.4 steps 3 and 4 for `workers`: each binding re-pointed to `newMainId`
 * (and given `missionId`, when given); each live one given the parent label.
 * No Worker is told (mission runtime design §3.4): every delivery resolves to
 * the current Main when it is sent. Each failure is one log line.
 */
async function repointWorkers(
  workers: Iterable<string>,
  newMainId: string,
  live: LiveAgents,
  deps: Pick<ReplaceMainDeps, "paseo" | "bindings"> & {
    queue: Pick<NoticeQueue, "enqueue">;
    setLabel: NonNullable<ReplaceMainDeps["setLabel"]>;
    log: (message: string) => void;
    missionId?: string;
  },
): Promise<void> {
  for (const workerId of workers) {
    deps.bindings?.reparent(workerId, newMainId);
    if (deps.missionId !== undefined) deps.bindings?.assignMission(workerId, deps.missionId);
    if (live !== null && !live.has(workerId)) continue;
    if (parentOf(live?.get(workerId)) === newMainId) continue;
    const labelled = await deps.setLabel(workerId, PARENT_AGENT_LABEL, newMainId).catch((error: unknown) => ({ ok: false as const, reason: errorText(error) }));
    if (!labelled.ok) deps.log(`[paseo-bm] Worker ${workerId} keeps its parent label (its Main is ${newMainId} now): ${labelled.reason}`);
  }
}

/** Each mission's replacement in flight: a second call waits for the first (mission runtime design §3.4). */
const replacing = new Map<string, Promise<unknown>>();

/**
 * The one function that changes a mission's Main (mission runtime design
 * §3.4): single flight per mission, idempotent (the mission naming
 * `newMainId` already writes nothing), compare-and-set on `expectedOld`; see
 * the module comment for its steps.
 */
export async function replaceMain(missionId: string, newMainId: string, reason: Mission["mainHistory"][number]["reason"], deps: ReplaceMainDeps): Promise<ReplaceMainResult> {
  const before = replacing.get(missionId) ?? Promise.resolve();
  const run = before.catch(() => undefined).then(() => replaceMainNow(missionId, newMainId, reason, deps));
  replacing.set(missionId, run);
  try {
    return await run;
  } finally {
    if (replacing.get(missionId) === run) replacing.delete(missionId);
  }
}

async function replaceMainNow(missionId: string, newMainId: string, reason: Mission["mainHistory"][number]["reason"], deps: ReplaceMainDeps): Promise<ReplaceMainResult> {
  const log = deps.log ?? ((message: string) => console.warn(message));
  const { home } = deps;
  const store = createMissionStore(home, deps.now === undefined ? {} : { now: deps.now });
  const mission = store.get(missionId);
  if (mission === null) return { ok: false, reasons: [`unknown mission ${missionId}`] };
  if (mission.mainId === newMainId) return { ok: true, replaced: null, requests: 0, workers: [], moved: 0, redelivered: 0 };
  if (deps.expectedOld !== undefined && mission.mainId !== deps.expectedOld) {
    return { ok: false, reasons: [`the mission's Main changed meanwhile (it is ${mission.mainId ?? "none"}, not ${deps.expectedOld ?? "none"})`] };
  }
  // A Main never replaces itself: a caller naming the successor as the one replaced (or a mission already
  // naming it) has no earlier Main to mark.
  const named = deps.replaced !== undefined ? deps.replaced : mission.mainId;
  const old = named === newMainId ? null : named;

  // 1. The mission names the successor.
  if (mission.mainId !== newMainId) {
    try {
      const set = store.setMain(missionId, newMainId, reason);
      if (!set.ok) return { ok: false, reasons: set.reasons };
    } catch (error) {
      return { ok: false, reasons: [errorText(error)] };
    }
    journalQuietly(store, missionId, { kind: "main", by: "plugin", text: old === null ? `Main ${newMainId} created.` : `Main ${newMainId} replaces ${old} (${reason}).`, ref: newMainId }, log);
  }
  const earlier = new Set([...mission.mainHistory.map((entry) => entry.agentId), ...(mission.mainId === null ? [] : [mission.mainId]), ...(old === null ? [] : [old])]);
  earlier.delete(newMainId);
  const live = await liveAgentsOf(deps.paseo);
  const isLive = (agentId: string) => live === null || live.has(agentId);
  const paseo = deps.paseo as NoticePaseo | undefined;
  const queue = deps.queue ?? noticeQueue;

  // 2. The open requests of the roster report to the successor.
  const registry = createRequestRegistry(home, { log });
  const active = createMissionRoster(home).list(missionId).filter((request) => request.state === "active");
  const { requests, workers } = reassignEntries(registry, active, newMainId, log);

  // 3. and 4. Its Workers: bindings, the notice, the parent label.
  const bindings = deps.bindings ?? createBindingStore(home);
  for (const binding of bindings?.list() ?? []) {
    if (binding.role === "worker" && binding.state === "bound" && binding.agentId !== null && binding.parentId !== null && earlier.has(binding.parentId)) workers.add(binding.agentId);
  }
  for (const [agentId, agent] of live ?? []) {
    const parent = parentOf(agent);
    if (parent !== null && earlier.has(parent) && roleOfAgent(agent)?.role === "worker") workers.add(agentId);
  }
  const setLabel = deps.setLabel ?? ((agentId: string, key: string, value: string) => setAgentLabel(agentId, key, value, deps.cli));
  await repointWorkers(workers, newMainId, live, { paseo, bindings, queue, setLabel, log });

  // 5. The old Main is marked and, once its labels say so, retitled; it is never archived (ADR-005).
  if (old !== null && isLive(old)) {
    const marked = await setLabel(old, REPLACED_BY_LABEL, newMainId).catch((error: unknown) => ({ ok: false as const, reason: errorText(error) }));
    if (!marked.ok) log(`[paseo-bm] Main ${newMainId} replaces ${old}, but ${old} could not be marked as replaced: ${marked.reason}`);
    const labels = (live?.get(old)?.["labels"] ?? {}) as Record<string, unknown>;
    if (marked.ok || typeof labels[REPLACED_BY_LABEL] === "string") {
      const setTitle = deps.setTitle ?? ((agentId: string, title: string) => setAgentTitle(agentId, title, deps.cli));
      const titled = await setTitle(old, replacedMainTitleOf(mission.code, mission.name)).catch((error: unknown) => ({ ok: false as const, reason: errorText(error) }));
      if (!titled.ok) log(`[paseo-bm] Main ${old} was replaced by ${newMainId}, but its title could not say so: ${titled.reason}`);
    }
  }

  // The replacement is complete: what was held for the old Main goes to the successor.
  let moved = 0;
  let redelivered = 0;
  if (old !== null) {
    const answers = dropProposedAnswersOf(old);
    const start = dropProposedMissionStartOf(old);
    if (answers || start) log(`[paseo-bm] the proposals Main ${old} made before it was replaced were dropped; the owner's words stay in its chat.`);
    moved = await queue.retarget(old, newMainId, paseo);
  }
  const outbox = createOutbox(home);
  // Every workspace: a mission link's records live in the home, a request's in its repo.
  for (const workspaceId of outbox.workspaces()) {
    for (const record of outbox.list(workspaceId).filter((entry) => isOpenRecord(entry) && earlier.has(entry.to))) {
      await deliverRecord(workspaceId, record, { home, queue, log, ...(paseo !== undefined ? { paseo } : {}), ...(deps.now !== undefined ? { now: deps.now } : {}) });
      redelivered += 1;
    }
  }
  log(`[paseo-bm] ${newMainId} is the Main of mission ${mission.code} now (${reason}${old === null ? "" : `, replacing ${old}`}).`);
  return { ok: true, replaced: old, requests, workers: [...workers], moved, redelivered };
}

/**
 * A split's moved requests (missions design §9.6: §3.4 steps 2–4 for those
 * requests only): each one's registry `managerId` becomes the new mission's
 * Main and its cached `missionId` the new mission; each of their Workers gets
 * its binding re-pointed and its mission, and when live the `BM-SETTINGS`
 * notice and its `paseo.parent-agent-id` label. The source mission and its
 * Main are untouched. Returns the Workers moved. Never throws: each failure
 * is one log line.
 */
export async function reassignRequests(
  missionId: string,
  requests: ReadonlyArray<{ requestId: string; workspaceId: string; workerIds: readonly string[] }>,
  newMainId: string,
  deps: Omit<ReplaceMainDeps, "replaced" | "setTitle" | "queue"> & { queue?: Pick<NoticeQueue, "enqueue"> },
): Promise<string[]> {
  const log = deps.log ?? ((message: string) => console.warn(message));
  const { workers } = reassignEntries(createRequestRegistry(deps.home, { log }), requests, newMainId, log, missionId);
  const live = await liveAgentsOf(deps.paseo);
  await repointWorkers(workers, newMainId, live, {
    paseo: deps.paseo,
    bindings: deps.bindings ?? createBindingStore(deps.home),
    queue: deps.queue ?? noticeQueue,
    setLabel: deps.setLabel ?? ((agentId: string, key: string, value: string) => setAgentLabel(agentId, key, value, deps.cli)),
    log,
    missionId,
  });
  return [...workers];
}

/**
 * The tools a replaced Main may no longer call (mission runtime design §3.6):
 * every bound Manager tool that writes or sends. Reads (`bm_mission`,
 * `bm_decisions`, `bm_repo`, `bm_peers`, `bm_memory`) still answer.
 */
export const MAIN_WRITE_TOOLS: ReadonlySet<string> = new Set([
  "bm_create_worker",
  "bm_tell_worker",
  "bm_answers",
  "bm_answer_worker",
  "bm_mission_update",
  "bm_split_mission",
  "bm_link_workers",
  "bm_ask_mission",
  "bm_peer_reply",
  "bm_owner_question",
]);

/**
 * Why a Manager's tool call is refused because another Main holds its mission
 * (mission runtime design §3.6), or null: the caller's binding names an open
 * mission whose `mainId` is another agent, and the tool writes or sends.
 * Never throws: a mission that cannot be read refuses nothing.
 */
export function replacedMainRefusalOf(home: string, caller: { agentId: string | null; missionId?: string | null } | null, tool: string): string | null {
  if (caller === null || caller.agentId === null || (caller.missionId ?? null) === null || !MAIN_WRITE_TOOLS.has(tool)) return null;
  try {
    const mission = createMissionStore(home).get(caller.missionId!);
    if (mission === null || mission.state !== "open" || mission.mainId === null || mission.mainId === caller.agentId) return null;
    return `You were replaced by Main ${mission.mainId} of mission ${mission.code}; tell the owner to continue in that Main's chat (the Missions screen opens it). Nothing was done.`;
  } catch {
    return null;
  }
}
