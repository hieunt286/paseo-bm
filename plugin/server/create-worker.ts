/**
 * Workers the plugin creates itself for a bound Manager (design §16.6,
 * §16.9; ADR-027 decisions 2 and 7, ship point C).
 *
 * - `createPluginWorker` is the one creation: `bm-worker/<model>` from the
 *   `bm-worker` profile, the mode by the Worker rules (`modeFactsOf`, the same
 *   value a Manager's Runtime facts name, §7.2), `cwd` given, `parent` = the
 *   Manager, a concise title derived from the owner's request, labels `bm.role`, `bm.requestId`,
 *   `bm.version` (and the caller's extra ones, `bm.handoffFrom` for a handoff
 *   successor), and a token with a binding when the profile's base provider
 *   can carry one (`binderOf` issues none on any
 *   other provider: that Worker is unbound and keeps the hand path). The
 *   `agent.create` hook still runs, so the Worker gets its instructions, its
 *   profile's thinking and features, and the action boundary.
 * - `bm_create_worker` (`createWorkerCreationTools`) is the bound Manager's
 *   tool around it: a fresh `requestId` from the request registry (§16.4) with
 *   the caller as its `managerId`, then the Worker with its `BM-BRIEF` first
 *   prompt (`workerBriefOf`). The handoff successor (`handoff.ts`) uses the
 *   same creation with the stored brief. With `peerLink` (design §7.17.3) the
 *   new request takes an `open` link of the caller's workspace, and the brief
 *   carries the other project's ask in its own `peer:` / `peerAsk:` block —
 *   never as the owner's request — with the two `PEER_RULES`; only a Worker
 *   that will be bound may take one.
 *
 * **A Main** (missions design §3.3 "Placement", §4, §7): its Worker works in
 * the mission's repo `project` names (the only repo when the mission has one):
 * created through `paseo.workspaces.ref(<repo>).agents.create` — `parent` and
 * a `cwd` alone would place it in the Main's home — bound and registered in
 * that repo with the mission, added to the roster, with the mission, the plan
 * step, the contracts touching the repo and the repo's memory in its brief.
 * Without `staffing` delegated, the mission keeps one live Worker per repo and
 * at most its budget's Workers. A Manager of no mission keeps the path above.
 *
 * The caller's identity, workspace and folder come from its binding and its
 * own snapshot, never from what the agent typed. A refusal is one line per
 * reason and creates nothing; once the request id is generated it is never
 * reused, even when Paseo then refuses the Worker. Nothing here throws into
 * the endpoint.
 */
import { resolve, sep } from "node:path";
import { NO_BINDER, createBound, withoutTokenPaths, type AgentBinder, type ToolCaller } from "./agent-bindings";
import { aliasBases } from "./alias-bases";
import { TOOL_PROVIDERS } from "./agent-tools";
import type { ServerToolAnswer, ServerTools } from "./decision-tools";
import { AGENT_TOOLS_OFF_TOOL_MESSAGE, agentToolsOff } from "./manager";
import { bmAgentsOf, listedWorkspaces, type DashboardPaseo, type ListedWorkspace } from "./paseo-directory";
import { createPeerLinkStore, routeOf, type PeerLink } from "./peer-links";
import { peerBriefOf, titleIn } from "./peer-tools";
import { createMemoryStore, type MemoryEntry } from "./memory-store";
import { createMissionAutonomyStore } from "./mission-autonomy-store";
import { createMissionRoster } from "./mission-roster";
import { createMissionStore, type Mission } from "./mission-store";
import { isMissionsHome } from "./missions-home";
import { createRequestRegistry } from "./request-registry";
import { asRecord, nonEmpty, reasonOf } from "./role-choices";
import { creationProjectOf, modeFactsOf } from "./role-instructions";
import { profileOf } from "./role-mode";
import { actingTools, boundAs, fixThese, refused, withoutNulls } from "./tool-kit";
import { boundToolFacesFor, schemaIssues } from "../shared/bm-tools";
import { briefLineOf } from "../shared/notices";
import { shorten } from "../shared/text";
import { PLUGIN_VERSION } from "../shared/version";
import { redactText } from "./collector";

/** The profile and alias a plugin-created Worker is made from. */
export const WORKER_PROFILE_ID = "bm-worker";
/** Fallback title when an older stored handoff has no request text. */
export const WORKER_TITLE = "Beads Worker";
/** A request's masked meaning in the tab; `applyRoleTitle` adds the Worker marker. */
export const workerTitleOf = (request: string, env: NodeJS.ProcessEnv = process.env): string => shorten(redactText(request, env), 72) || WORKER_TITLE;
export const CREATE_WORKER_TOOL = "bm_create_worker";

/** The caller is not a bound Manager: it creates its Worker by hand. */
export const NOT_BOUND_MESSAGE =
  "bm_create_worker is only for a Manager paseo-bm created with its own tools, and you are not one: create the Worker with create_agent as your instructions say. Nothing was created.";
/** No Paseo handle has reached the plugin yet (as the Orchestrator's tools say, design §7.4). */
export const NO_PASEO_MESSAGE = "paseo-bm has no connection to Paseo yet; try again in a moment. Nothing was created.";
/** The `bm-worker` profile is missing (or Paseo's configuration cannot be read). */
export const NO_WORKER_PROFILE_MESSAGE =
  'There is no "bm-worker" profile on this machine, so no Worker can be created; tell the owner to open Beads Manager → Settings. Nothing was created.';
/** The line `workerBriefOf` puts after the repository: the scope rule of every request. */
export const SCOPE_LINE = "Do only what the request asks. Anything extra is a suggestion for the owner, not work.";

/** One fact the Manager passes, with where it comes from. */
export interface ContextFact {
  fact: string;
  source: string;
}

/**
 * What `bm_create_worker` takes (design §16.6). No `size`: a size the owner
 * stated stays in the request, in their words (ADR-027, amended 2026-10-03).
 * A `size` an agent on older instructions still passes is accepted and ignored.
 */
export interface CreateWorkerInput {
  request: string;
  context: ContextFact[];
  /** An open peer link the new request takes (§7.17.3). */
  peerLink?: string;
  /** A Main's: the mission repo the Worker works in (missions design §4). */
  project?: string;
  /** A Main's: the request's place in the mission's plan. */
  planStep?: string;
}

/** The newest active memory entries a Worker's brief carries, beside every `contract` entry (missions design §7). */
export const BRIEF_MEMORY_ENTRIES = 30;

/** One line: a newline inside a value would end it. */
const oneLine = (text: string): string => text.replace(/\s*\r?\n\s*/g, " ").trim();

/**
 * The first prompt of a Worker created by `bm_create_worker` (design §16.6):
 * the `BM-BRIEF` line, the request verbatim in a quoted block, the request id,
 * the repository and its `.beads/`, the scope rule, the Manager's id, a taken
 * link's `peer` lines (`peerBriefOf`; the request is then the Manager's own
 * words), then `Context:` with each fact and its source. A Main's Worker gets
 * its `mission` lines (`missionBriefLines`) after the Manager's id. Pure.
 */
export function workerBriefOf(input: {
  requestId: string;
  request: string;
  cwd: string;
  managerId: string;
  context: readonly ContextFact[];
  peer?: readonly string[];
  mission?: readonly string[];
}): string {
  const quoted = input.request
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => (line === "" ? ">" : `> ${line}`))
    .join("\n");
  const repository = input.cwd.replace(/\/+$/, "");
  return [
    briefLineOf("worker", input.requestId),
    input.peer === undefined ? "The owner's request, verbatim:" : "Your Manager's words:",
    quoted,
    "",
    `requestId: ${input.requestId}`,
    `repository: ${repository} (beads in ${repository}/.beads/)`,
    SCOPE_LINE,
    `managerAgentId: ${input.managerId}`,
    ...(input.mission ?? []),
    ...(input.peer ?? []),
    "Context:",
    ...(input.context.length === 0 ? ["- none"] : input.context.map((entry) => `- ${oneLine(entry.fact)} (source: ${oneLine(entry.source)})`)),
  ].join("\n");
}

/**
 * A Main's Worker's brief lines (missions design §4, §7): the mission, the
 * plan step, the mission's contracts touching the repo, then the repo's
 * memory — the newest `BRIEF_MEMORY_ENTRIES` active entries and every
 * `contract` entry, oldest first, each with its source. Pure.
 */
export function missionBriefLines(input: {
  mission: Pick<Mission, "code" | "name" | "contracts">;
  workspaceId: string;
  planStep?: string;
  memory: readonly MemoryEntry[];
  titleOf: (workspaceId: string) => string;
}): string[] {
  const { mission, workspaceId, titleOf } = input;
  const repo = titleOf(workspaceId);
  const contracts = mission.contracts.filter((contract) => contract.providerRepo === workspaceId || contract.consumerRepos.includes(workspaceId));
  const newest = new Set(input.memory.slice(-BRIEF_MEMORY_ENTRIES));
  const memory = input.memory.filter((entry) => newest.has(entry) || entry.kind === "contract");
  return [
    `mission: ${oneLine(mission.code)} ${oneLine(mission.name)}`,
    ...(input.planStep === undefined ? [] : [`plan: ${oneLine(input.planStep)}`]),
    ...(contracts.length === 0
      ? []
      : [
          `Mission contracts touching ${repo}:`,
          ...contracts.map(
            (contract) =>
              `- ${contract.id} v${contract.version} ${oneLine(contract.title)} (provider ${titleOf(contract.providerRepo)}; consumers ${contract.consumerRepos.map(titleOf).join(", ") || "none"}): ${oneLine(contract.text)}`,
          ),
        ]),
    ...(memory.length === 0 ? [] : [`Project memory (${repo}):`, ...memory.map((entry) => `- ${entry.kind}: ${oneLine(entry.text)} (source: ${oneLine(entry.source)})`)]),
  ];
}

/** The SDK slice a plugin-created Worker needs; `PaseoApi` is structurally assignable. */
export interface WorkerCreationPaseo {
  agents: {
    create(options: {
      config: Record<string, unknown>;
      cwd: string;
      parent?: string;
      title: string;
      labels: Record<string, string>;
      prompt: string;
    }): Promise<{ id: string }>;
    ref(agentId: string): { refresh(): Promise<{ agent?: unknown } | null> };
  };
  /** A Main's Workers are created in their repo's workspace (missions design §3.3 "Placement"). */
  workspaces?: {
    ref(workspaceId: string): {
      agents: { create(options: { config: Record<string, unknown>; parent?: string; title: string; labels: Record<string, string>; prompt: string }): Promise<{ id: string }> };
    };
  };
}

/** The `bm-worker` profile's model, or null when there is no such profile (or the configuration cannot be read). */
export async function workerProfileOf(paseo: unknown, log?: (message: string) => void): Promise<{ model: string | null } | null> {
  const profile = await profileOf(paseo, WORKER_PROFILE_ID, log);
  return profile === null ? null : { model: profile.model };
}

/** What `createPluginWorker` creates. */
export interface PluginWorkerSpec {
  workspaceId: string;
  requestId: string;
  /** The Manager: the Worker's `parent`, and the binding's. */
  managerId: string;
  /** The folder the Worker works in. */
  cwd: string;
  /** Its first prompt, starting with its `BM-BRIEF` line. */
  prompt: string;
  /** The semantic title derived from the owner's request. */
  title: string;
  /** The `bm-worker` profile's model (`workerProfileOf`). */
  model: string | null;
  /** Labels beside `bm.role`, `bm.requestId` and `bm.version` (`bm.handoffFrom`). */
  labels?: Record<string, string>;
  /**
   * The request's mission (missions design §4): the binding carries it, and
   * the Worker is created in `workspaceId` (`workspaces.ref`), never by `cwd`
   * and `parent` alone, which Paseo places in the parent's workspace.
   */
  missionId?: string;
}

export interface PluginWorkerDeps {
  /** Binds the Worker when its base provider can take the tools; none (unbound) when absent. */
  binder?: AgentBinder;
  log?: (message: string) => void;
}

/**
 * Creates one Worker for a request (see the module comment) and returns its
 * id. Throws what Paseo threw — its refusal, verbatim — after the binding was
 * discarded (`createBound`).
 */
export async function createPluginWorker(paseo: WorkerCreationPaseo, spec: PluginWorkerSpec, deps: PluginWorkerDeps = {}): Promise<{ workerId: string }> {
  const log = deps.log ?? ((message: string) => console.warn(message));
  // The Worker rules, as a Manager's Runtime facts name them (§7.2): the action boundary of the project included.
  const project = await creationProjectOf(spec.cwd, { workspaceId: spec.workspaceId }, log);
  const facts = await modeFactsOf("manager", paseo, spec.cwd, log, project.boundary);
  const modeId = facts.workerModeNone === true ? undefined : (facts.workerModeId ?? undefined);
  const base = (await aliasBases(paseo))[WORKER_PROFILE_ID] ?? null;
  const created = await createBound(
    deps.binder ?? NO_BINDER,
    { role: "worker", base, workspaceId: spec.workspaceId, requestId: spec.requestId, parentId: spec.managerId, ...(spec.missionId === undefined ? {} : { missionId: spec.missionId }) },
    (mcpServers) => {
      const options = {
        config: {
          provider: spec.model === null ? WORKER_PROFILE_ID : `${WORKER_PROFILE_ID}/${spec.model}`,
          ...(modeId !== undefined ? { modeId } : {}),
          ...(mcpServers !== undefined ? { mcpServers } : {}),
        },
        parent: spec.managerId,
        title: spec.title,
        labels: { "bm.role": "worker", "bm.requestId": spec.requestId, "bm.version": PLUGIN_VERSION, ...spec.labels },
        prompt: spec.prompt,
      };
      if (spec.missionId === undefined) return paseo.agents.create({ ...options, cwd: spec.cwd });
      if (paseo.workspaces === undefined) throw new Error("this Paseo cannot create an agent in a workspace");
      return paseo.workspaces.ref(spec.workspaceId).agents.create(options);
    },
    log,
  );
  return { workerId: created.id };
}

/** The folder of `agentId` (its snapshot's `cwd`), else its workspace's as Paseo lists it; null when neither can be read. Never throws. */
export async function folderOfAgent(paseo: unknown, agentId: string, workspaceId: string | null): Promise<string | null> {
  try {
    const ref = (paseo as Partial<WorkerCreationPaseo> | null)?.agents?.ref?.(agentId);
    const cwd = nonEmpty(asRecord((await ref?.refresh())?.agent)?.["cwd"]);
    if (cwd !== null) return cwd;
  } catch {
    // The workspace's folder, then.
  }
  try {
    if (workspaceId === null || typeof (paseo as Partial<DashboardPaseo> | null)?.workspaces?.list !== "function") return null;
    return (await listedWorkspaces(paseo as DashboardPaseo))?.find((entry) => entry.id === workspaceId)?.directory ?? null;
  } catch {
    return null;
  }
}

/**
 * The link `linkId` when it is `open` and asks `workspaceId` (§7.17.3), else
 * why it cannot be taken. Missions design §5: an `ask-main` link is taken only
 * for the mission it asks (`missionId`, the caller's), in the repo it names; a
 * `worker` or `mission` link never. Never throws.
 */
export function openLinkOf(home: string, linkId: string, workspaceId: string, missionId: string | null = null): PeerLink | string {
  const link = createPeerLinkStore(home).get(linkId);
  const route = link === null ? null : routeOf(link);
  const ours = route === "project" || (route === "ask-main" && missionId !== null && link!.missionId === missionId);
  return link !== null && ours && link.state === "open" && link.to.workspaceId === workspaceId
    ? link
    : `link ${linkId} is not an open ask of this project (bm_peers lists them).`;
}

/** Why a Worker that is not bound cannot take `linkId`. */
export const unboundPeerReason = (linkId: string): string =>
  `a Worker without paseo-bm's tools could neither report forPeer nor answer link ${linkId}; answer it with bm_peer_reply.`;

// ---------------------------------------------------------------------------
// A Main's Workers (missions design §4).
// ---------------------------------------------------------------------------

/** The caller's mission: its binding's, else the mission whose Main it is (the binding's is a cache, §2.3); null for none. Never throws. */
export function missionOfCaller(home: string, caller: Pick<ToolCaller, "agentId" | "missionId">): Mission | null {
  const store = createMissionStore(home);
  const missionId = caller.missionId ?? store.list().find((entry) => entry.mainId === caller.agentId)?.missionId ?? null;
  return missionId === null ? null : store.get(missionId);
}

/** True when `directory` is the data folder or inside it: the Missions and Orchestrator homes are no repos (§3.1). */
const inDataFolder = (home: string, directory: string): boolean => {
  const root = resolve(home);
  const folder = resolve(directory);
  return folder === root || folder.startsWith(`${root}${sep}`);
};

/** The repo of `mission` a new Worker works in, with its folder, or why there is none (one line each). Never throws. */
export function missionRepoOf(
  home: string,
  mission: Mission,
  project: string | undefined,
  listed: readonly ListedWorkspace[] | null,
): { workspaceId: string; directory: string } | string[] {
  const { code, charter } = mission;
  if (mission.state !== "open") return [`mission ${code} is closed`];
  const repos = charter.repos;
  if (repos.length === 0) return [`mission ${code} has no repo yet: add one with bm_mission_update repos`];
  const names = repos.map((workspaceId) => `${workspaceId} (${titleIn(listed, workspaceId)})`).join(", ");
  if (project === undefined && repos.length > 1) return [`input.project: mission ${code} works in ${repos.length} repos — ${names}; name the one the Worker works in`];
  const workspaceId = project ?? repos[0]!;
  if (!repos.includes(workspaceId)) return [`project ${workspaceId} is outside mission ${code}'s scope (${names}); add it with bm_mission_update repos first`];
  if (listed === null) return ["paseo-bm could not read Paseo's workspaces; try again in a moment"];
  const entry = listed.find((candidate) => candidate.id === workspaceId);
  if (entry === undefined || entry.archived) return [`project ${workspaceId} is archived or no longer listed in Paseo`];
  if (isMissionsHome(workspaceId, home) || (entry.directory !== null && inDataFolder(home, entry.directory))) return [`project ${workspaceId} is a paseo-bm home, not a repo`];
  if (entry.directory === null) return [`paseo-bm could not read the folder of project ${workspaceId} from Paseo; try again in a moment`];
  return { workspaceId, directory: entry.directory };
}

/**
 * The staffing rule (missions design §4): without `staffing` delegated, a
 * mission has at most one live Worker per repo and at most its budget's
 * `workers` live Workers in all. A live Worker: an unarchived Worker of an
 * `active` roster request its registry does not show finished. One line per
 * broken rule; none when it holds or is delegated.
 */
export async function staffingReasons(home: string, paseo: DashboardPaseo, mission: Mission, workspaceId: string, listed: readonly ListedWorkspace[] | null): Promise<string[]> {
  if (createMissionAutonomyStore(home).isDelegated(mission.missionId, "staffing")) return [];
  const registry = createRequestRegistry(home);
  const live = new Set(
    (await bmAgentsOf(paseo, { home })).filter(({ facts }) => facts.role === "worker" && !facts.archived).map(({ facts }) => facts.id),
  );
  const running = createMissionRoster(home)
    .list(mission.missionId)
    .filter((entry) => entry.state === "active" && (registry.get(entry.workspaceId, entry.requestId)?.finishedAt ?? null) === null && entry.workerIds.some((id) => live.has(id)));
  const reasons: string[] = [];
  const here = running.find((entry) => entry.workspaceId === workspaceId);
  const ask = "staffing is not delegated in this mission, so ask the owner first";
  if (here !== undefined) reasons.push(`mission ${mission.code} already has a live Worker in ${titleIn(listed, workspaceId)} (request ${here.requestId}): give it the work with bm_tell_worker, or ${ask}`);
  const cap = mission.charter.budget?.workers ?? null;
  if (cap !== null && running.length >= cap) reasons.push(`mission ${mission.code} has ${running.length} live Workers and its budget allows ${cap}: ${ask}`);
  return reasons;
}

// ---------------------------------------------------------------------------
// bm_create_worker.
// ---------------------------------------------------------------------------

export interface WorkerCreationToolDeps {
  /** The binder of the endpoint (read when a call comes); none (unbound Workers) when absent. */
  binder?: () => AgentBinder;
  /** The last Paseo handle a hook or RPC brought; null before any did. */
  paseo: () => unknown;
  /** The data folder (the endpoint's: it serves no tools without one). */
  home: () => string;
  log?: (message: string) => void;
}

/**
 * The bound Manager's `bm_create_worker` (design §16.6), as server-run tools
 * the endpoint composes with the Manager's others. Every call is a new
 * request. Never throws.
 */
export function createWorkerCreationTools(deps: WorkerCreationToolDeps): ServerTools {
  const log = deps.log ?? ((message: string) => console.warn(message));
  const faces = boundToolFacesFor("manager");
  const face = faces.find((candidate) => candidate.name === CREATE_WORKER_TOOL)!;

  const run = async (raw: unknown, toolCaller: ToolCaller | null): Promise<ServerToolAnswer> => {
    const caller = boundAs(toolCaller, "manager");
    if (caller === null) return refused(NOT_BOUND_MESSAGE);
    const managerId = caller.agentId;
    // An agent on older instructions may still pass `size`: accepted and ignored (the request carries it).
    const given = withoutNulls(raw);
    const input = given !== null && typeof given === "object" && !Array.isArray(given) ? Object.fromEntries(Object.entries(given).filter(([key]) => key !== "size")) : given;
    const issues = schemaIssues(face.inputSchema, input);
    if (issues.length > 0) return fixThese(CREATE_WORKER_TOOL, issues);
    const { request, context, peerLink, project, planStep } = input as unknown as CreateWorkerInput;
    const home = deps.home();
    // A Main works in its mission's repos; a Manager of no mission in its own folder.
    const mission = missionOfCaller(home, caller);
    if (mission === null && (project !== undefined || planStep !== undefined)) return refused("project and planStep are for the Main of a mission, and you are none: leave them out. Nothing was created.");
    if (mission === null && isMissionsHome(caller.workspaceId, home)) return refused("You have no mission yet: record it with bm_mission_start before you create a Worker. Nothing was created.");
    const paseo = deps.paseo();
    if (paseo === null || paseo === undefined) return refused(NO_PASEO_MESSAGE);
    // A Worker gets Paseo's tools only when it is created: one made now could not create a Reviewer.
    if (await agentToolsOff(paseo)) return refused(AGENT_TOOLS_OFF_TOOL_MESSAGE);
    const profile = await workerProfileOf(paseo, log);
    if (profile === null) return refused(NO_WORKER_PROFILE_MESSAGE);
    let workspaceId = caller.workspaceId;
    let cwd: string | null;
    let missionLines: string[] | undefined;
    if (mission === null) {
      // The Manager's own folder, read from Paseo — never a folder the agent typed.
      cwd = await folderOfAgent(paseo, managerId, caller.workspaceId);
      if (cwd === null) return refused(`paseo-bm could not read your folder from Paseo; try again in a moment. Nothing was created.`);
    } else {
      // The repo's folder as Paseo lists it, and the mission's rules for staffing it.
      const listed = await listedWorkspaces(paseo as DashboardPaseo);
      const repo = missionRepoOf(home, mission, project, listed);
      const reasons = Array.isArray(repo) ? repo : await staffingReasons(home, paseo as DashboardPaseo, mission, repo.workspaceId, listed);
      if (reasons.length > 0 || Array.isArray(repo)) return refused([...reasons, "Nothing was created."].join("\n"));
      ({ workspaceId, directory: cwd } = repo);
      missionLines = missionBriefLines({
        mission,
        workspaceId,
        ...(planStep === undefined ? {} : { planStep }),
        memory: createMemoryStore(home).active(workspaceId),
        titleOf: (id) => titleIn(listed, id),
      });
    }
    // A link is taken only by a Worker that will be bound: it alone reports forPeer and answers the link.
    let peer: string[] | undefined;
    if (peerLink !== undefined) {
      const link = openLinkOf(home, peerLink, workspaceId, mission?.missionId ?? null);
      if (typeof link === "string") return refused(`${link} Nothing was created.`);
      const base = (await aliasBases(paseo))[WORKER_PROFILE_ID] ?? null;
      if ((deps.binder?.() ?? NO_BINDER) === NO_BINDER || base === null || !TOOL_PROVIDERS.includes(base)) return refused(`${unboundPeerReason(peerLink)} Nothing was created.`);
      peer = peerBriefOf(link, titleIn(await listedWorkspaces(paseo as DashboardPaseo), link.from.workspaceId));
    }

    // The request id, registered before anything is created: once generated, it is never reused.
    let requestId: string;
    try {
      requestId = createRequestRegistry(home, { log }).generate(workspaceId, { managerId, ...(mission === null ? {} : { missionId: mission.missionId }) }).requestId;
    } catch (error) {
      return refused(`paseo-bm could not write its request registry (${reasonOf(error)}); nothing was created. Tell the owner in one line.`);
    }

    let workerId: string;
    try {
      const prompt = workerBriefOf({ requestId, request, cwd, managerId, context, ...(peer === undefined ? {} : { peer }), ...(missionLines === undefined ? {} : { mission: missionLines }) });
      ({ workerId } = await createPluginWorker(
        paseo as WorkerCreationPaseo,
        { workspaceId, requestId, managerId, cwd, prompt, title: workerTitleOf(request), model: profile.model, ...(mission === null ? {} : { missionId: mission.missionId }) },
        { binder: deps.binder?.(), log },
      ));
    } catch (error) {
      // Paseo's refusal, verbatim but for a token path (design §16.5: a token never reaches an agent or a log).
      // The registry keeps the request with no Worker, so its id is never reused.
      const reason = withoutTokenPaths(reasonOf(error));
      log(`[paseo-bm] ${CREATE_WORKER_TOOL} could not create the Worker of request ${requestId} for Manager ${managerId}: ${reason}`);
      return refused(`Paseo refused to create the Worker: ${reason}`);
    }

    try {
      createRequestRegistry(home, { log }).addWorker(workspaceId, requestId, workerId);
    } catch (error) {
      log(`[paseo-bm] could not add Worker ${workerId} to request ${requestId}: ${reasonOf(error)}`);
    }
    if (mission !== null) {
      // The roster is the mission's membership (§2.3); the journal says what happened.
      try {
        const topic = workerTitleOf(request);
        if (createMissionRoster(home).add(mission.missionId, { requestId, workspaceId, topic, workerId }) === null) log(`[paseo-bm] request ${requestId} is held by another mission's roster`);
        createMissionStore(home).appendJournal(mission.missionId, { kind: "worker", by: managerId, text: `Worker ${workerId} for request ${requestId} in ${workspaceId}: ${topic}`, ref: requestId });
      } catch (error) {
        log(`[paseo-bm] could not add request ${requestId} to mission ${mission.missionId}: ${reasonOf(error)}`);
      }
    }
    if (peerLink === undefined) return { ok: true, text: JSON.stringify({ workerId, requestId }) };
    let taken: string[] = [];
    try {
      const result = createPeerLinkStore(home).takeLink(peerLink, { workspaceId, requestId, workerId, managerId });
      if (!result.ok) taken = result.reasons;
    } catch (error) {
      taken = [reasonOf(error)];
    }
    if (taken.length > 0) log(`[paseo-bm] request ${requestId} could not take link ${peerLink}: ${taken.join("; ")}`);
    return { ok: true, text: JSON.stringify({ workerId, requestId, ...(taken.length > 0 ? { peerLinkNotTaken: taken.join("; ") } : {}) }) };
  };

  return actingTools(faces, { [CREATE_WORKER_TOOL]: run }, "Nothing was created");
}
