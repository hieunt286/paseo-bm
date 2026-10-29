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
 * at most its budget's Workers. From the cut-over (delivery line design §3.3),
 * the Worker works in the mission's placement of the repo — its worktree,
 * made at the first Worker (`placement-create.ts`) — with the placement's
 * lines in its brief (§3.4). While a mission from before the cut-over waits
 * for its repo's checkpoint (§4.8), its Worker works in the repo's root as
 * before, with `ROOT_WAIT_BRIEF_LINE` in its brief and no integration lines.
 * A Manager of no mission keeps the path above.
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
import { directoryIn, listedWorkspaces, titleIn, type DashboardPaseo, type ListedWorkspace } from "./paseo-directory";
import { createPeerLinkStore, routeOf, type PeerLink } from "./peer-links";
import { inCharter, laneOf, placementBlockOf, repoKeyOf } from "./placements";
import { ROOT_WAIT_BRIEF_LINE, ensureLane, ensurePlacement, placementBriefLines, placementModeOn, type PlacementDeps } from "./placement-create";
import { peerBriefOf } from "./peer-tools";
import { createMemoryStore, type MemoryEntry } from "./memory-store";
import { createMissionAutonomyStore } from "./mission-autonomy-store";
import { holdRequest } from "./held-requests";
import { createMissionRoster, runningRequestsOf } from "./mission-roster";
import { createMissionStore, journalQuietly, type Mission } from "./mission-store";
import { missionOfMain } from "./mission-tools";
import { isMissionsHome } from "./missions-home";
import { createRequestRegistry, type RegisteredRequest } from "./request-registry";
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
/** The caller's binding names a mission whose Main is another agent now (missions design §3.4). */
export const REPLACED_MAIN_MESSAGE =
  "You are no longer the Main of your mission: another Main took it over, so you create no Worker for it. Tell the owner in one line. Nothing was created.";
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
  /** A Main's: `"new"` runs it in a free or new lane of the repo (delivery line design §19.1). */
  lane?: "new";
  /** A Main's: hold it until these requests of the mission finish (§19.6). */
  after?: string[];
}

/** The memory a Worker's brief carries, in characters (delivery line design §18.2, ADR-037). */
export const BRIEF_MEMORY_CHARS = 6_000;
/** The longest memory line of a brief. */
export const BRIEF_MEMORY_ENTRY_CHARS = 400;
/** The line that names what a brief left out. */
export const briefMemoryMoreLine = (more: number): string => `- ${more} more ${more === 1 ? "entry" : "entries"} in this repo's memory: bm_memory read with a query.`;

/** One line: a newline inside a value would end it. */
const oneLine = (text: string): string => text.replace(/\s*\r?\n\s*/g, " ").trim();

/** `text` cut to `max` characters, an ellipsis last when cut. Pure. */
const cut = (text: string, max: number): string => (text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`);

/** The share of `BRIEF_MEMORY_CHARS` this mission's own entries may take first (§18.2). */
export const BRIEF_MEMORY_OWN_SHARE = 0.5;
/** A repo entry's kind, in the order a brief prefers it when relevance ties: rules first, then agreements. */
const KIND_ORDER: Readonly<Record<string, number>> = { convention: 0, contract: 1, decision: 2, fact: 3 };

/**
 * The features a text is matched by (§18.2): its words of two letters or more
 * and each pair of neighbouring words, case aside, so short Vietnamese
 * syllables count through their compounds ("nhập liệu"). Pure.
 */
function featuresOf(text: string): Set<string> {
  const words = text.normalize("NFC").toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? [];
  const features = new Set<string>(words);
  for (let index = 1; index < words.length; index += 1) features.add(`${words[index - 1]} ${words[index]}`);
  return features;
}

/** One memory line of a brief, within `BRIEF_MEMORY_ENTRY_CHARS`, its source kept. Pure. */
function memoryLineOf(entry: MemoryEntry): string {
  const head = `- ${entry.kind}: `;
  const tail = ` (source: ${cut(oneLine(entry.source), 120)})`;
  return `${head}${cut(oneLine(entry.text), BRIEF_MEMORY_ENTRY_CHARS - head.length - tail.length)}${tail}`;
}

/**
 * The memory lines of a Worker's brief (delivery line design §18.2), within
 * `BRIEF_MEMORY_CHARS`:
 * - **relevance** is the features an entry shares with the request and the
 *   plan step, each weighted by how rare it is among the live entries
 *   (ln(1 + N / entries holding it)), so common words count little;
 * - **the owner's own entries** (their notes, through the Orchestrator) come
 *   first, newest first: they are the owner's word;
 * - **this mission's entries** follow, by relevance then newest, up to
 *   `BRIEF_MEMORY_OWN_SHARE` of the budget;
 * - **the repo's other entries** follow, by relevance, then conventions
 *   before contracts, decisions and facts, then newest;
 * - what is left of the budget then takes the rest of either, in the same
 *   order. `more` counts the entries left out. Pure.
 */
export function briefMemoryOf(input: { live: readonly MemoryEntry[]; request: string; planStep?: string; missionId: string | null }): { lines: string[]; more: number } {
  const wanted = featuresOf(`${input.request} ${input.planStep ?? ""}`);
  const featured = input.live.map((entry) => featuresOf(`${entry.text} ${entry.subject ?? ""}`));
  const holding = new Map<string, number>();
  for (const features of featured) for (const feature of features) if (wanted.has(feature)) holding.set(feature, (holding.get(feature) ?? 0) + 1);
  const total = input.live.length;
  const scored = input.live.map((entry, index) => {
    let score = 0;
    for (const feature of featured[index]!) {
      const count = holding.get(feature);
      if (count !== undefined) score += Math.log(1 + total / count);
    }
    return { entry, index, owner: entry.by.role === "owner", own: input.missionId !== null && entry.by.missionId === input.missionId, score };
  });
  type Scored = (typeof scored)[number];
  const newer = (a: Scored, b: Scored) => Date.parse(b.entry.at) - Date.parse(a.entry.at) || b.index - a.index;
  const owner = scored.filter((item) => item.owner).sort(newer);
  const own = scored.filter((item) => item.own).sort((a, b) => b.score - a.score || newer(a, b));
  const rest = scored.filter((item) => !item.own).sort((a, b) => b.score - a.score || (KIND_ORDER[a.entry.kind] ?? 9) - (KIND_ORDER[b.entry.kind] ?? 9) || newer(a, b));
  const lines: string[] = [];
  const taken = new Set<number>();
  let used = 0;
  const fill = (items: readonly Scored[], limit: number) => {
    for (const item of items) {
      if (taken.has(item.index)) continue;
      const line = memoryLineOf(item.entry);
      if (used + line.length + 1 > limit) continue;
      lines.push(line);
      taken.add(item.index);
      used += line.length + 1;
    }
  };
  fill(owner, BRIEF_MEMORY_CHARS);
  fill(own, used + BRIEF_MEMORY_CHARS * BRIEF_MEMORY_OWN_SHARE);
  fill(rest, BRIEF_MEMORY_CHARS);
  fill(own, BRIEF_MEMORY_CHARS);
  return { lines, more: total - lines.length };
}

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
  /** Delivery line design §2.5: a continuation's block, after the Manager's line. */
  continuation?: readonly string[];
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
    ...(input.continuation ?? []),
    ...(input.mission ?? []),
    ...(input.peer ?? []),
    "Context:",
    ...(input.context.length === 0 ? ["- none"] : input.context.map((entry) => `- ${oneLine(entry.fact)} (source: ${oneLine(entry.source)})`)),
  ].join("\n");
}

/**
 * A Main's Worker's brief lines (missions design §4, §7): the mission, the
 * plan step, the mission's contracts touching the repo in full, then the
 * repo's live memory within its budget
 * (`briefMemoryOf`, delivery line design §18.2) and one line for the rest.
 * Pure.
 */
export function missionBriefLines(input: {
  mission: Pick<Mission, "missionId" | "code" | "name" | "contracts">;
  workspaceId: string;
  planStep?: string;
  /** The repo's live entries (`MemoryStore.live`). */
  memory: readonly MemoryEntry[];
  /** The words the Worker is given, to rank the memory by. */
  request: string;
  titleOf: (workspaceId: string) => string;
}): string[] {
  const { mission, workspaceId, titleOf } = input;
  const repo = titleOf(workspaceId);
  const contracts = mission.contracts.filter((contract) => contract.providerRepo === workspaceId || contract.consumerRepos.includes(workspaceId));
  const memory = briefMemoryOf({ live: input.memory, request: input.request, ...(input.planStep === undefined ? {} : { planStep: input.planStep }), missionId: mission.missionId });
  return [
    `mission: ${oneLine(mission.code)} ${oneLine(mission.name)}`,
    ...(input.planStep === undefined ? [] : [`plan: ${oneLine(input.planStep)}`]),
    ...(contracts.length === 0
      ? []
      : [
          `Mission contracts touching ${repo}:`,
          // The mission's own agreements the Worker builds to: in full, never ranked or cut.
          ...contracts.map(
            (contract) =>
              `- ${contract.id} v${contract.version} ${oneLine(contract.title)} (provider ${titleOf(contract.providerRepo)}; consumers ${contract.consumerRepos.map(titleOf).join(", ") || "none"}): ${oneLine(contract.text)}`,
          ),
        ]),
    ...(memory.lines.length === 0 && memory.more === 0
      ? []
      : [`Project memory (${repo}):`, ...memory.lines, ...(memory.more === 0 ? [] : [briefMemoryMoreLine(memory.more)])]),
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
    return directoryIn(await listedWorkspaces(paseo as DashboardPaseo), workspaceId);
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
  return link !== null && ours && link.state === "open" && repoKeyOf(home, link.to.workspaceId) === repoKeyOf(home, workspaceId)
    ? link
    : `link ${linkId} is not an open ask of this project (bm_peers lists them).`;
}

/** Why a Worker that is not bound cannot take `linkId`. */
export const unboundPeerReason = (linkId: string): string =>
  `a Worker without paseo-bm's tools could neither report forPeer nor answer link ${linkId}; answer it with bm_peer_reply.`;

// ---------------------------------------------------------------------------
// A Main's Workers (missions design §4).
// ---------------------------------------------------------------------------

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
  // Delivery line design §3.1: a placement of a charter repo is in the charter; a repo named by its key is that repo.
  const workspaceId = project ?? repos[0]!;
  if (!inCharter(home, mission, workspaceId)) return [`project ${workspaceId} is outside mission ${code}'s scope (${names}); add it with bm_mission_update repos first`];
  if (listed === null) return ["paseo-bm could not read Paseo's workspaces; try again in a moment"];
  const entry = listed.find((candidate) => candidate.id === workspaceId);
  if (entry === undefined || entry.archived) return [`project ${workspaceId} is archived or no longer listed in Paseo`];
  if (isMissionsHome(workspaceId, home) || (entry.directory !== null && inDataFolder(home, entry.directory))) return [`project ${workspaceId} is a paseo-bm home, not a repo`];
  if (entry.directory === null) return [`paseo-bm could not read the folder of project ${workspaceId} from Paseo; try again in a moment`];
  // Delivery line design §3.6: a retired, archived or failed placement takes no new agent.
  const blocked = placementBlockOf(home, workspaceId);
  if (blocked !== null) return [blocked];
  return { workspaceId, directory: entry.directory };
}

/**
 * The staffing rule (missions design §4): without `staffing` delegated, a
 * mission has at most one live Worker per repo and at most its budget's
 * `workers` live Workers in all. A live Worker: an unarchived Worker of an
 * `active` roster request its registry does not show finished. One line per
 * broken rule; none when it holds or is delegated.
 */
export async function staffingReasons(
  home: string,
  paseo: DashboardPaseo,
  mission: Mission,
  workspaceId: string,
  listed: readonly ListedWorkspace[] | null,
  options: { lane?: "new" } = {},
): Promise<string[]> {
  if (createMissionAutonomyStore(home).isDelegated(mission.missionId, "staffing")) return [];
  const running = await runningRequestsOf(home, paseo, mission.missionId);
  const reasons: string[] = [];
  // Delivery line design §3.7: one live Worker per placement, counted per repo as before; §19.1: a new lane adds one.
  const repo = repoKeyOf(home, workspaceId);
  const here = running.find((entry) => repoKeyOf(home, entry.workspaceId) === repo);
  const ask = "staffing is not delegated in this mission, so ask the owner first";
  if (options.lane === "new") reasons.push(`a new lane adds a live Worker to mission ${mission.code} in ${titleIn(listed, workspaceId)}: ${ask}`);
  else if (here !== undefined) reasons.push(`mission ${mission.code} already has a live Worker in ${titleIn(listed, workspaceId)} (request ${here.requestId}): give it the work with bm_tell_worker, run independent work in a new lane (lane: "new"), or ${ask}`);
  const cap = mission.charter.budget?.workers ?? null;
  if (cap !== null && running.length >= cap) reasons.push(`mission ${mission.code} has ${running.length} live Workers and its budget allows ${cap}: ${ask}`);
  return reasons;
}

/**
 * The `peer` lines of a brief for the open link `linkId` a new Worker takes
 * (§7.17.3), or why it cannot take it: the link is no open ask of
 * `workspaceId`, or the Worker would be unbound. Never throws.
 */
export async function peerLinesFor(home: string, paseo: unknown, linkId: string, workspaceId: string, missionId: string | null, binder: AgentBinder): Promise<string[] | string> {
  const link = openLinkOf(home, linkId, workspaceId, missionId);
  if (typeof link === "string") return link;
  const base = (await aliasBases(paseo))[WORKER_PROFILE_ID] ?? null;
  if (binder === NO_BINDER || base === null || !TOOL_PROVIDERS.includes(base)) return unboundPeerReason(linkId);
  return peerBriefOf(link, titleIn(await listedWorkspaces(paseo as DashboardPaseo), link.from.workspaceId));
}

/** The new request takes link `linkId`; why it could not, or null. Never throws. */
export function takeLinkQuietly(home: string, linkId: string, by: { workspaceId: string; requestId: string; workerId: string; managerId: string }, log: (message: string) => void): string | null {
  let reasons: string[] = [];
  try {
    const result = createPeerLinkStore(home).takeLink(linkId, by);
    if (!result.ok) reasons = result.reasons;
  } catch (error) {
    reasons = [reasonOf(error)];
  }
  if (reasons.length === 0) return null;
  log(`[paseo-bm] request ${by.requestId} could not take link ${linkId}: ${reasons.join("; ")}`);
  return reasons.join("; ");
}

/** What `createRequestWorker` makes: a new request and its Worker. */
export interface RequestWorkerSpec {
  /** The tool it runs for, in its log lines. */
  tool: string;
  workspaceId: string;
  managerId: string;
  cwd: string;
  request: string;
  context: readonly ContextFact[];
  model: string | null;
  mission: Mission | null;
  missionLines?: readonly string[];
  peer?: readonly string[];
  /** Delivery line design §2.4: the request a continuation continues, and its brief block (§2.5). */
  continuation?: { of: Pick<RegisteredRequest, "requestId" | "chainRootId">; lines: readonly string[] };
}

/**
 * The one creation path of a request and its Worker (design §16.6; delivery
 * line design §2.4): a fresh id registered first — never reused, even when
 * Paseo then refuses the Worker — the `BM-BRIEF` (`workerBriefOf`), the
 * Worker (`createPluginWorker`), then the registry's Worker and, for a
 * mission, the roster entry and the journal's `worker` line. The refusal, or
 * the ids. Never throws.
 */
export async function createRequestWorker(
  home: string,
  paseo: unknown,
  spec: RequestWorkerSpec,
  deps: { binder?: AgentBinder; log: (message: string) => void },
): Promise<{ requestId: string; workerId: string } | ServerToolAnswer> {
  const { log } = deps;
  const { workspaceId, managerId, cwd, request, mission, continuation } = spec;
  const chain = continuation === undefined ? {} : { continuationOf: continuation.of.requestId, chainRootId: continuation.of.chainRootId ?? continuation.of.requestId };
  // The request id, registered before anything is created: once generated, it is never reused.
  let requestId: string;
  try {
    requestId = createRequestRegistry(home, { log }).generate(workspaceId, { managerId, ...(mission === null ? {} : { missionId: mission.missionId }), ...chain }).requestId;
  } catch (error) {
    return refused(`paseo-bm could not write its request registry (${reasonOf(error)}); nothing was created. Tell the owner in one line.`);
  }

  let workerId: string;
  try {
    const prompt = workerBriefOf({
      requestId,
      request,
      cwd,
      managerId,
      context: spec.context,
      ...(spec.peer === undefined ? {} : { peer: spec.peer }),
      ...(spec.missionLines === undefined ? {} : { mission: spec.missionLines }),
      ...(continuation === undefined ? {} : { continuation: continuation.lines }),
    });
    ({ workerId } = await createPluginWorker(
      paseo as WorkerCreationPaseo,
      { workspaceId, requestId, managerId, cwd, prompt, title: workerTitleOf(request), model: spec.model, ...(mission === null ? {} : { missionId: mission.missionId }) },
      { ...(deps.binder === undefined ? {} : { binder: deps.binder }), log },
    ));
  } catch (error) {
    // Paseo's refusal, verbatim but for a token path (design §16.5: a token never reaches an agent or a log).
    // The registry keeps the request with no Worker, so its id is never reused.
    const reason = withoutTokenPaths(reasonOf(error));
    log(`[paseo-bm] ${spec.tool} could not create the Worker of request ${requestId} for Manager ${managerId}: ${reason}`);
    return refused(`Paseo refused to create the Worker: ${reason}`);
  }

  try {
    createRequestRegistry(home, { log }).addWorker(workspaceId, requestId, workerId);
  } catch (error) {
    log(`[paseo-bm] could not add Worker ${workerId} to request ${requestId}: ${reasonOf(error)}`);
  }
  if (mission !== null) {
    // The roster is the mission's membership (§2.3); the journal says what happened.
    const topic = workerTitleOf(request);
    try {
      if (createMissionRoster(home).add(mission.missionId, { requestId, workspaceId, topic, workerId, ...(chain.continuationOf === undefined ? {} : { continuationOf: chain.continuationOf }) }) === null) {
        log(`[paseo-bm] request ${requestId} is held by another mission's roster`);
      }
    } catch (error) {
      log(`[paseo-bm] could not add request ${requestId} to mission ${mission.missionId}: ${reasonOf(error)}`);
    }
    const continues = chain.continuationOf === undefined ? "" : ` (continues ${chain.continuationOf})`;
    journalQuietly(createMissionStore(home), mission.missionId, { kind: "worker", by: managerId, text: `Worker ${workerId} for request ${requestId} in ${workspaceId}${continues}: ${topic}`, ref: requestId }, log);
  }
  return { requestId, workerId };
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
  /** How a placement reads git and clones dependencies (delivery line design §3.3, §3.5); the real ones by default. */
  placements?: Pick<PlacementDeps, "git" | "clone">;
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
    const { request, context, peerLink, project, planStep, lane, after } = input as unknown as CreateWorkerInput;
    const home = deps.home();
    // A Main works in its mission's repos; a Manager of no mission in its own folder. A replaced Main works for none.
    const mission = missionOfMain(home, caller);
    if (mission === null && (caller.missionId ?? null) !== null) return refused(REPLACED_MAIN_MESSAGE);
    if (mission === null && (project !== undefined || planStep !== undefined || lane !== undefined || after !== undefined)) return refused("project, planStep, lane and after are for the Main of a mission, and you are none: leave them out. Nothing was created.");
    if (mission === null && isMissionsHome(caller.workspaceId, home)) return refused("You have no mission yet: record it with bm_mission_start before you create a Worker. Nothing was created.");
    // Delivery line design §19.6: work that waits for requests of the mission is held by paseo-bm, not created now.
    if (mission !== null && after !== undefined && after.length > 0) {
      const roster = createMissionRoster(home).list(mission.missionId);
      const unknown = after.filter((requestId) => !roster.some((entry) => entry.requestId === requestId));
      if (unknown.length > 0) return refused(`${unknown.join(", ")} ${unknown.length === 1 ? "is not a request" : "are not requests"} of mission ${mission.code} (bm_mission lists them). Nothing was created.`);
      const stopped = after.filter((requestId) => roster.find((entry) => entry.requestId === requestId)?.state === "stopped");
      if (stopped.length > 0) return refused(`${stopped.join(", ")} stopped, so work after ${stopped.length === 1 ? "it" : "them"} would never start: give it without after, or ask the owner. Nothing was created.`);
      const waiting = after.filter((requestId) => roster.find((entry) => entry.requestId === requestId)?.state !== "finished");
      if (waiting.length > 0) {
        const rest = Object.fromEntries(Object.entries(input as Record<string, unknown>).filter(([key]) => key !== "after"));
        const held = holdRequest(home, mission.missionId, { after: waiting, input: rest, topic: oneLine(request).slice(0, 120), by: caller.agentId }, new Date());
        if (!held.ok) return refused(`${held.reason}. Nothing was held.`);
        journalQuietly(createMissionStore(home), mission.missionId, { kind: "worker", by: caller.agentId, text: `Held ${held.entry.holdId} until ${waiting.join(", ")} finish: ${held.entry.topic}`, ref: held.entry.holdId }, log);
        return {
          ok: true,
          text: JSON.stringify({ held: held.entry.holdId, after: waiting, note: `paseo-bm creates its Worker when ${waiting.join(" and ")} finish${waiting.length === 1 ? "es" : ""}, within about a minute, and tells you; bm_hold_cancel cancels it` }),
        };
      }
    }
    const paseo = deps.paseo();
    if (paseo === null || paseo === undefined) return refused(NO_PASEO_MESSAGE);
    // A Worker gets Paseo's tools only when it is created: one made now could not create a Reviewer.
    if (await agentToolsOff(paseo)) return refused(AGENT_TOOLS_OFF_TOOL_MESSAGE);
    const profile = await workerProfileOf(paseo, log);
    if (profile === null) return refused(NO_WORKER_PROFILE_MESSAGE);
    let workspaceId = caller.workspaceId;
    let cwd: string | null;
    let missionLines: string[] | undefined;
    /** Why the Worker works in the shared checkout, not the mission's worktree (§4.8); told to the Main in the answer. */
    let notYet: string | null = null;
    /** The lane the Worker works in (§19.1); 1 is the mission branch. */
    let laneNumber = 1;
    if (mission === null) {
      // The Manager's own folder, read from Paseo — never a folder the agent typed.
      cwd = await folderOfAgent(paseo, managerId, caller.workspaceId);
      if (cwd === null) return refused(`paseo-bm could not read your folder from Paseo; try again in a moment. Nothing was created.`);
    } else {
      // The repo's folder as Paseo lists it, and the mission's rules for staffing it.
      const listed = await listedWorkspaces(paseo as DashboardPaseo);
      // Delivery line design §3.3: from the cut-over, the Worker works in the mission's placement of the repo.
      const placed = placementModeOn(home);
      const repo = missionRepoOf(home, mission, placed && project !== undefined ? repoKeyOf(home, project) : project, listed);
      if (lane === "new" && !placed) return refused("lanes need the mission's worktrees, which start after this repo's cut-over: leave lane out. Nothing was created.");
      const reasons = Array.isArray(repo) ? repo : await staffingReasons(home, paseo as DashboardPaseo, mission, repo.workspaceId, listed, lane === undefined ? {} : { lane });
      if (reasons.length > 0 || Array.isArray(repo)) return refused([...reasons, "Nothing was created."].join("\n"));
      ({ workspaceId, directory: cwd } = repo);
      const repoKey = repoKeyOf(home, workspaceId);
      let placementLines: string[] = [];
      if (placed) {
        // Delivery line design §19.1: independent work in a free or new lane; otherwise lane 1, the mission branch.
        const placement = lane === "new" ? await ensureLane(home, paseo, mission, repoKey, listed ?? [], { ...deps.placements, log }) : await ensurePlacement(home, paseo, mission, repoKey, listed ?? [], { ...deps.placements, log });
        if (placement.ok) {
          workspaceId = placement.placement.workspaceId!;
          cwd = placement.placement.directory!;
          placementLines = placementBriefLines(placement.placement);
          laneNumber = laneOf(placement.placement);
        } else if (placement.inRoot === true && workspaceId === repoKey) {
          // Delivery line design §4.8: no usable checkpoint yet, so the root, exactly as before the cut-over.
          log(`[paseo-bm] mission ${mission.code}'s Worker works in the shared checkout ${repoKey}: ${placement.reasons.join("; ")}`);
          placementLines = [ROOT_WAIT_BRIEF_LINE];
          notYet = `not yet: it works in the shared checkout ${titleIn(listed, repoKey)} because ${placement.reasons.join("; ")}`;
        } else return refused([...placement.reasons, "Nothing was created."].join("\n"));
      }
      missionLines = [
        ...missionBriefLines({
          mission,
          workspaceId: repoKey,
          ...(planStep === undefined ? {} : { planStep }),
          memory: createMemoryStore(home).live(repoKey),
          request,
          titleOf: (id) => titleIn(listed, id),
        }),
        ...placementLines,
      ];
    }
    // A link is taken only by a Worker that will be bound: it alone reports forPeer and answers the link.
    const peer = peerLink === undefined ? undefined : await peerLinesFor(home, paseo, peerLink, workspaceId, mission?.missionId ?? null, deps.binder?.() ?? NO_BINDER);
    if (typeof peer === "string") return refused(`${peer} Nothing was created.`);
    const made = await createRequestWorker(
      home,
      paseo,
      { tool: CREATE_WORKER_TOOL, workspaceId, managerId, cwd, request, context, model: profile.model, mission, ...(missionLines === undefined ? {} : { missionLines }), ...(peer === undefined ? {} : { peer }) },
      { binder: deps.binder?.(), log },
    );
    if ("ok" in made) return made;
    const { workerId, requestId } = made;
    const where = { ...(notYet === null ? {} : { worktree: notYet }), ...(laneNumber === 1 ? {} : { lane: laneNumber }) };
    if (peerLink === undefined) return { ok: true, text: JSON.stringify({ workerId, requestId, ...where }) };
    const taken = takeLinkQuietly(home, peerLink, { workspaceId, requestId, workerId, managerId }, log);
    return { ok: true, text: JSON.stringify({ workerId, requestId, ...where, ...(taken === null ? {} : { peerLinkNotTaken: taken }) }) };
  };

  return actingTools(faces, { [CREATE_WORKER_TOOL]: run }, "Nothing was created");
}
