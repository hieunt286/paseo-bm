/**
 * Replacing a Main without losing work (missions design §3.4, REQ-188, M-27).
 *
 * `replaceMain(missionId, newMainId, reason, deps)` is the one path every
 * replacement takes once its successor exists: `mission.ensure` with
 * `replace` (`missions-home.ts`), a cleared conversation's successor
 * (`createMainSuccession`) and the fallback switch of a Main
 * (`fallback-manager.ts`). The callers create the successor (step 1's first
 * half, `bm.replaces` on it); here, in the design's order:
 *
 * 1. the mission's `mainId` becomes the successor (`setMain`, unless the
 *    caller's `createMain` wrote it already) — from here every record, handoff
 *    and link addressed to "the Main" resolves to it at delivery;
 * 2. every active request of the roster: registry `managerId` = new
 *    (`reassignManager`);
 * 3. every Worker of the mission — the roster's and the registry's, a bound
 *    Worker whose binding names an earlier Main, a live Worker labelled with
 *    one — gets its binding re-pointed (`reparent`) and, when live, the
 *    `BM-SETTINGS` "The Beads Manager you report to was replaced" notice;
 * 4. a live Worker's `paseo.parent-agent-id` label is set to the successor
 *    through the Paseo CLI (a refusal costs one log line: readers go to the
 *    registry's `managerId` first);
 * 5. the old Main is marked `bm.replacedBy` (when it is not known to be
 *    archived) and, once marked, retitled `replacedMainTitleOf` through the
 *    Paseo CLI (`setAgentTitle`, as `syncMainTitle` titles a Main), so its
 *    tab no longer reads as the mission's Main; the journal records the
 *    replacement.
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
import { createMissionStore, type Mission } from "./mission-store";
import { noticeQueue, type NoticePaseo, type NoticeQueue } from "./notice-queue";
import { SETTINGS_NOTICE_MARKER } from "./notices";
import { createOutbox, deliverRecord, isOpenRecord } from "./outbox";
import { setAgentLabel, setAgentTitle, type CliResult, type PaseoCliDeps } from "./paseo-cli";
import { dropProposedAnswersOf } from "./proposed-answers";
import { dropProposedMissionStartOf } from "./proposed-mission-starts";
import { createRequestRegistry } from "./request-registry";
import { replacedMainTitleOf } from "./role-title";
import { errorText } from "./rpc-kit";
import { managerIdNotice } from "./settings-notices";

/** The label that marks a replaced Main (§3.2: `findMain` skips it). */
export const REPLACED_BY_LABEL = "bm.replacedBy";

export interface ReplaceMainDeps {
  home: string;
  /** The caller's Paseo handle: which agents are live, and the queue's and the outbox's deliveries. */
  paseo?: unknown;
  /** The Main replaced, when the mission names the successor already (`createMain` wrote it); the mission's `mainId` otherwise. */
  replaced?: string | null;
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

/** See the module comment. */
export async function replaceMain(missionId: string, newMainId: string, reason: Mission["mainHistory"][number]["reason"], deps: ReplaceMainDeps): Promise<ReplaceMainResult> {
  const log = deps.log ?? ((message: string) => console.warn(message));
  const { home } = deps;
  const store = createMissionStore(home, deps.now === undefined ? {} : { now: deps.now });
  const mission = store.get(missionId);
  if (mission === null) return { ok: false, reasons: [`unknown mission ${missionId}`] };
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
    try {
      store.appendJournal(missionId, { kind: "main", by: "plugin", text: `Main ${newMainId} replaces ${old ?? "none"} (${reason}).`, ref: newMainId });
    } catch {
      // The journal is what happened, never state.
    }
  }
  const earlier = new Set([...mission.mainHistory.map((entry) => entry.agentId), ...(mission.mainId === null ? [] : [mission.mainId]), ...(old === null ? [] : [old])]);
  earlier.delete(newMainId);
  const live = await liveAgentsOf(deps.paseo);
  const isLive = (agentId: string) => live === null || live.has(agentId);
  const paseo = deps.paseo as NoticePaseo | undefined;
  const queue = deps.queue ?? noticeQueue;
  const setLabel = deps.setLabel ?? ((agentId: string, key: string, value: string) => setAgentLabel(agentId, key, value, deps.cli));
  const label = async (agentId: string, key: string, value: string, what: string): Promise<boolean> => {
    const result = await setLabel(agentId, key, value).catch((error: unknown) => ({ ok: false as const, reason: errorText(error) }));
    if (!result.ok) log(`[paseo-bm] ${what}: ${result.reason}`);
    return result.ok;
  };

  // 2. The open requests of the roster report to the successor.
  const registry = createRequestRegistry(home, { log });
  const roster = createMissionRoster(home).list(missionId);
  const workers = new Set<string>();
  let requests = 0;
  for (const entry of roster.filter((request) => request.state === "active")) {
    try {
      if (registry.reassignManager(entry.workspaceId, entry.requestId, newMainId)) requests += 1;
    } catch (error) {
      log(`[paseo-bm] request ${entry.requestId} could not be reassigned to the Main ${newMainId}: ${errorText(error)}`);
    }
    for (const workerId of [...entry.workerIds, ...(registry.get(entry.workspaceId, entry.requestId)?.workerIds ?? [])]) workers.add(workerId);
  }

  // 3. and 4. Its Workers: bindings, the notice, the parent label.
  const bindings = deps.bindings ?? createBindingStore(home);
  for (const binding of bindings?.list() ?? []) {
    if (binding.role === "worker" && binding.state === "bound" && binding.agentId !== null && binding.parentId !== null && earlier.has(binding.parentId)) workers.add(binding.agentId);
  }
  for (const [agentId, agent] of live ?? []) {
    const parent = parentOf(agent);
    if (parent !== null && earlier.has(parent) && roleOfAgent(agent)?.role === "worker") workers.add(agentId);
  }
  for (const workerId of workers) {
    bindings?.reparent(workerId, newMainId);
    if (!isLive(workerId)) continue;
    const outcome = await queue.enqueue(workerId, SETTINGS_NOTICE_MARKER, managerIdNotice(newMainId), paseo);
    if (outcome === "dropped") log(`[paseo-bm] Worker ${workerId} could not be told its new Main ${newMainId}.`);
    if (parentOf(live?.get(workerId)) !== newMainId) await label(workerId, PARENT_AGENT_LABEL, newMainId, `Worker ${workerId} keeps its parent label (its Main is ${newMainId} now)`);
  }

  // 5. The old Main is marked and, once its labels say so, retitled; it is never archived (ADR-005).
  if (old !== null && isLive(old)) {
    const marked = await label(old, REPLACED_BY_LABEL, newMainId, `Main ${newMainId} replaces ${old}, but ${old} could not be marked as replaced`);
    const labels = (live?.get(old)?.["labels"] ?? {}) as Record<string, unknown>;
    if (marked || typeof labels[REPLACED_BY_LABEL] === "string") {
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
  const registry = createRequestRegistry(deps.home, { log });
  const bindings = deps.bindings ?? createBindingStore(deps.home);
  const queue = deps.queue ?? noticeQueue;
  const setLabel = deps.setLabel ?? ((agentId: string, key: string, value: string) => setAgentLabel(agentId, key, value, deps.cli));
  const live = await liveAgentsOf(deps.paseo);
  const workers = new Set<string>();
  for (const entry of requests) {
    try {
      registry.reassignManager(entry.workspaceId, entry.requestId, newMainId, missionId);
    } catch (error) {
      log(`[paseo-bm] request ${entry.requestId} could not be reassigned to the Main ${newMainId}: ${errorText(error)}`);
    }
    for (const workerId of [...entry.workerIds, ...(registry.get(entry.workspaceId, entry.requestId)?.workerIds ?? [])]) workers.add(workerId);
  }
  for (const workerId of workers) {
    bindings?.reparent(workerId, newMainId);
    bindings?.assignMission(workerId, missionId);
    if (live !== null && !live.has(workerId)) continue;
    const outcome = await queue.enqueue(workerId, SETTINGS_NOTICE_MARKER, managerIdNotice(newMainId), deps.paseo as NoticePaseo | undefined);
    if (outcome === "dropped") log(`[paseo-bm] Worker ${workerId} could not be told its new Main ${newMainId}.`);
    if (parentOf(live?.get(workerId)) === newMainId) continue;
    const labelled = await setLabel(workerId, PARENT_AGENT_LABEL, newMainId).catch((error: unknown) => ({ ok: false as const, reason: errorText(error) }));
    if (!labelled.ok) log(`[paseo-bm] Worker ${workerId} keeps its parent label (its Main is ${newMainId} now): ${labelled.reason}`);
  }
  return [...workers];
}
