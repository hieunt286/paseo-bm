/**
 * The one Beads Orchestrator agent (Orchestrator design §3.3, ADR-014 decision
 * 1, REQ-075 a): `orchestrator.open-preview` and `orchestrator.open`.
 *
 * - The Orchestrator is the non-archived agent labelled `bm.role=orchestrator`
 *   and `bm.orchestrator=main`, in any workspace. `open` returns it when it
 *   exists and creates it only when it does not, so there is one per machine.
 * - It lives in a workspace of its own: `<data folder>/orchestrator/home`, a
 *   folder the plugin creates (`0700`) with a short `README.md`, opened as a
 *   workspace with `paseo.workspaces.open({ cwd })` (Q-077, verified on an
 *   isolated daemon — design §3.3).
 * - It is created as the first design's assessment agent was
 *   (`assessment.ts`): provider `bm-orchestrator/<profile model>` (the bare
 *   alias without a model), mode by the Reviewer rule
 *   (`assessmentPostureOf`, never `dangerous`/`planning`), the labels above
 *   plus `bm.version`, the title "Beads Orchestrator", and a short first
 *   prompt. The `agent.create` hook adds its instructions and its tools.
 * - No usable profile or provider → `E_ORCHESTRATOR_UNAVAILABLE`, nothing
 *   created (`assessmentTargetOf`).
 * - Paseo fixes an agent's system prompt when it is created, so each
 *   Orchestrator carries `bm.instructions=<hash of its instructions>`; one
 *   without the current hash is **outdated**. One created before the endpoint's
 *   secret was made has lost its tools (design §5.1). Either way
 *   `open { recreate: true }` creates a new one, and so does every wake-up
 *   (`wakeableOrchestrator`, design §3.3), so the owner never has to. A
 *   wake-up also replaces a current one more than a day old, when it is idle
 *   and the owner has not written to it for 2 hours (design §6B.6). The
 *   newest labelled agent is the Orchestrator, so the new one takes over and
 *   the old one stays in the user's list.
 *
 * The plugin never archives, stops or deletes the Orchestrator (ADR-005): the
 * user asked for it and owns it.
 */
import { join } from "node:path";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import {
  DashboardError,
  orchestratorOpenPreviewRpc,
  orchestratorOpenRpc,
  type OrchestratorOpenInput,
  type OrchestratorOpenOutput,
  type OrchestratorOpenPreviewOutput,
} from "../shared/contracts";
import { PLUGIN_VERSION } from "../shared/version";
import { listAllAgents } from "./agent-role";
import {
  assessmentPostureOf,
  assessmentProviderSelection,
  assessmentStartedBroken,
  assessmentTargetOf,
  type AssessmentAgentSnapshot,
} from "./assessment";
import { DataHomeError, TRACES_DIR_NAME, ensureDataHome, resolveDataHome, unusableDataHomeMessage, type DataHomeDeps } from "./data-home";
import { readTimelinePages, type LiveTimelinePaseo } from "./live-timeline";
import { isPluginNotice } from "./notices";
import { ORCHESTRATOR_INSTRUCTIONS } from "./orchestrator-instructions";
import { INSTRUCTIONS_LABEL, instructionsHashOf } from "./instructions-label";
import { orchestratorDirOf } from "./orchestrator-store";
import { ensureStoreDir, writeStoreFileAtomically } from "./trace-store";

/** The label pair that marks the one Orchestrator (design §3.3). */
export const ORCHESTRATOR_ROLE_LABEL = "bm.role";
export const ORCHESTRATOR_ROLE_VALUE = "orchestrator";
export const ORCHESTRATOR_MAIN_LABEL = "bm.orchestrator";
export const ORCHESTRATOR_MAIN_VALUE = "main";

/**
 * The label that says which instructions an Orchestrator was created with
 * (design §3.3): the first 12 hex digits of their SHA-256, so the label stays
 * small. An agent without this value is outdated.
 */
export const ORCHESTRATOR_INSTRUCTIONS_LABEL = INSTRUCTIONS_LABEL;
export const ORCHESTRATOR_INSTRUCTIONS_HASH = instructionsHashOf(ORCHESTRATOR_INSTRUCTIONS);

/** Title of the Orchestrator agent. */
export const ORCHESTRATOR_TITLE = "Beads Orchestrator";

/** The folder of its own workspace, under `<data folder>/orchestrator/`. */
export const ORCHESTRATOR_HOME_DIR_NAME = "home";

/**
 * Where the Orchestrator is created (design §3.3): `"own"` — in its own
 * workspace, which the plugin server opens itself (Q-077 verified). `"choose"`
 * would be the fallback, where the user picks a workspace.
 */
export const ORCHESTRATOR_WORKSPACE = "own" as const;

/** What the home folder's `README.md` says, so a user who finds it knows what it is. */
export const ORCHESTRATOR_HOME_README = `# Beads Orchestrator

This folder is the workspace of paseo-bm's Beads Orchestrator: the agent that
reads the work of every paseo-bm project on this machine and tells their Beads
Managers what to do. It sends a command itself only in a project where you
turned Autopilot on, or right after you tell it to in its chat; otherwise it
asks you in the Inbox of Beads Manager, with the command ready on an option. It
never asks for a commit, push or deploy, or to touch real data, unless you said
so, and it asks you on big decisions.

It holds no project. paseo-bm created it; you may delete it after you archive
the Beads Orchestrator agent.
`;

/**
 * How the first message of every Orchestrator starts, in every version of the
 * plugin: the rest of its first line (where it was opened from) and of the
 * message (its tools) changes, so the chat check matches these words, never
 * the whole text.
 */
export const ORCHESTRATOR_FIRST_PROMPT_START = "The user opened you from ";

/** The first message of a new Orchestrator: its tools, and to wait for the user. */
export const ORCHESTRATOR_FIRST_PROMPT = [
  `${ORCHESTRATOR_FIRST_PROMPT_START}the Inbox of Beads Manager (paseo-bm).`,
  "Your tools: bm_projects (where the paseo-bm projects stand), bm_request (one request), bm_agent_messages (recent messages of a paseo-bm agent), bm_decisions (the owner's decisions, their answers and grants), bm_repo (read-only git in a project's workspace), bm_note (your notes on a project), bm_ask_owner (put a decision to the owner, with a prepared command per option), bm_send_command (a command to a project's Manager, within the owner's authority), bm_direct_worker (correct a Worker or answer its questions, on the same terms; its Manager gets a copy), bm_set_autopilot (only when the owner asks) and bm_assessment (the result of a workflow assessment).",
  "Do not look at any project yet. Reply with one short line saying you are ready, then wait for the user.",
].join("\n");

/**
 * True when a timeline item of the Orchestrator's chat is the owner's own
 * words (design §6A (b), ADR-015 decision 3): a `user_message` carrying
 * `clientMessageId` — typed in the app — that is neither one of the plugin's
 * notices (`BM-EVENTS`, `BM-ANSWER`, …: the notice queue sends through the
 * app's own path, so the text tells them apart), nor the plugin's first prompt
 * of any version (`ORCHESTRATOR_FIRST_PROMPT_START`).
 */
export function isOwnerWord(item: unknown): boolean {
  const message = item as { type?: unknown; text?: unknown; clientMessageId?: unknown } | null | undefined;
  if (message?.type !== "user_message" || typeof message.text !== "string") return false;
  if (typeof message.clientMessageId !== "string" || message.clientMessageId === "") return false;
  const text = message.text.trim();
  return text !== "" && !isPluginNotice(text) && !text.startsWith(ORCHESTRATOR_FIRST_PROMPT_START);
}

/** A current Orchestrator older than this is replaced by a fresh one at a wake-up (design §6B.6) … */
export const FRESH_ORCHESTRATOR_AFTER_MS = 24 * 3_600_000;
/** … when it is idle and the owner has not written in its chat for this long. */
export const OWNER_QUIET_MS = 2 * 3_600_000;
/** How far back its chat is read for the owner's newest message: 5 pages of 200 entries. */
const QUIET_PAGES = 5;
const QUIET_PAGE_LIMIT = 200;

/** What a listed agent carries that the lookup reads; `PaseoAgent` is structurally assignable. */
export interface OrchestratorAgentSnapshot {
  id: string;
  createdAt?: string;
  labels?: Record<string, string>;
  archivedAt?: string | null;
  /** As `agents.list` gives it; the daily replacement (design §6B.6) needs one that is not running. */
  status?: string;
}

/** The SDK slice `open-preview` and `open` use; `PaseoApi` is structurally assignable. */
export interface OrchestratorAgentPaseo {
  agents: {
    list(options: {
      filter: { labels?: Record<string, string>; includeArchived: boolean };
      page: { limit: number; cursor?: string };
    }): Promise<{
      entries: Array<{ agent: OrchestratorAgentSnapshot }>;
      pageInfo?: { nextCursor: string | null; hasMore: boolean };
    }>;
  };
  workspaces: {
    open(input: { cwd: string }): Promise<{ readonly id: string }>;
    ref(workspaceId: string): {
      agents: {
        create(options: {
          config: { provider: string; modeId?: string; featureValues?: Record<string, unknown> };
          title: string;
          labels: Record<string, string>;
          prompt: string;
        }): Promise<{ readonly id: string; current(): AssessmentAgentSnapshot | null }>;
      };
    };
  };
}

export interface OrchestratorAgentDeps extends DataHomeDeps {
  log?: (message: string) => void;
  /**
   * Whether the Orchestrator has lost its tools (design §5.1); the same check
   * `orchestrator.state` reports as `toolsStale`. False by default, so
   * `recreate` then never creates a second one.
   */
  isToolsStale?: (agent: { id: string; createdAt: string | null }) => boolean;
  /** The clock of the daily replacement (design §6B.6); `new Date()` by default. */
  now?: () => Date;
}

/** Newest first by `createdAt`; ties (or unparsable times) broken by id so the choice is stable. */
function newestFirst(a: OrchestratorAgentSnapshot, b: OrchestratorAgentSnapshot): number {
  const byTime = Date.parse(b.createdAt ?? "") - Date.parse(a.createdAt ?? "");
  if (byTime !== 0 && !Number.isNaN(byTime)) return byTime;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

/**
 * The Orchestrator agent, or null when there is none: the newest non-archived
 * agent with both labels. The label filter is checked again here, so a host
 * that ignores the filter cannot make another agent the Orchestrator.
 */
export async function findOrchestratorAgent(paseo: OrchestratorAgentPaseo): Promise<OrchestratorAgentSnapshot | null> {
  const labels = { [ORCHESTRATOR_ROLE_LABEL]: ORCHESTRATOR_ROLE_VALUE, [ORCHESTRATOR_MAIN_LABEL]: ORCHESTRATOR_MAIN_VALUE };
  const all = await listAllAgents((options) => paseo.agents.list(options), { labels, includeArchived: false });
  const found = all
    .filter(
      (agent) =>
        !agent.archivedAt &&
        agent.labels?.[ORCHESTRATOR_ROLE_LABEL] === ORCHESTRATOR_ROLE_VALUE &&
        agent.labels?.[ORCHESTRATOR_MAIN_LABEL] === ORCHESTRATOR_MAIN_VALUE,
    )
    .sort(newestFirst);
  return found[0] ?? null;
}

/** True when the Orchestrator was created with other instructions than this plugin's, or before they were labelled. */
export function isOutdatedOrchestrator(agent: Pick<OrchestratorAgentSnapshot, "labels">): boolean {
  return agent.labels?.[ORCHESTRATOR_INSTRUCTIONS_LABEL] !== ORCHESTRATOR_INSTRUCTIONS_HASH;
}

/** Why the Orchestrator should be replaced, or null when it is current (design §3.3, §5.1). */
function replacementReasonOf(agent: OrchestratorAgentSnapshot, deps: OrchestratorAgentDeps): string | null {
  if (deps.isToolsStale?.({ id: agent.id, createdAt: agent.createdAt ?? null }) === true) return "lost its tools";
  if (isOutdatedOrchestrator(agent)) return "has outdated instructions";
  return null;
}

/**
 * "is more than a day old" when a current Orchestrator should make way for a
 * fresh one (design §6B.6), else null: created more than 24 hours ago, not
 * running or starting, and the owner's newest message in its chat
 * (`isOwnerWord`) is more than 2 hours old — or there is none. Its chat is read
 * only when the first two hold; an unknown creation time or status, a chat
 * that cannot be read (no entry), or an owner's message without a time keeps
 * it. Its notes survive in the store, and the new one reads them through
 * `bm_projects`.
 */
async function dayOldReasonOf(paseo: OrchestratorAgentPaseo, agent: OrchestratorAgentSnapshot, deps: OrchestratorAgentDeps): Promise<string | null> {
  const now = (deps.now ?? (() => new Date()))().getTime();
  const created = Date.parse(agent.createdAt ?? "");
  if (Number.isNaN(created) || now - created <= FRESH_ORCHESTRATOR_AFTER_MS) return null;
  if (typeof agent.status !== "string" || agent.status === "running" || agent.status === "initializing") return null;
  let newestOwner = Number.NEGATIVE_INFINITY;
  const read = await readTimelinePages(paseo as unknown as LiveTimelinePaseo, agent.id, { pages: QUIET_PAGES, limit: QUIET_PAGE_LIMIT }, (entries) => {
    for (const entry of entries) {
      if (!isOwnerWord(entry.item)) continue;
      const at = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : Number.NaN;
      // An owner's message with no time counts as just now: it keeps the Orchestrator.
      newestOwner = Math.max(newestOwner, Number.isNaN(at) ? now : at);
    }
  });
  if (read === 0 || now - newestOwner <= OWNER_QUIET_MS) return null;
  return "is more than a day old";
}

/** `<data folder>/orchestrator/home`. */
export function orchestratorHomeOf(home: string): string {
  return join(orchestratorDirOf(home), ORCHESTRATOR_HOME_DIR_NAME);
}

/**
 * Creates `<data folder>/orchestrator/home` (`0700`, no symlink on the way, as
 * every store folder) and writes its `README.md` when the text differs.
 * Returns the folder. No data folder → `E_DATA_HOME_UNAVAILABLE`; a failed
 * write → `E_ORCHESTRATOR_WRITE_FAILED`.
 */
export function ensureOrchestratorHome(deps: DataHomeDeps = {}): string {
  let home: string | null;
  try {
    home = resolveDataHome(deps).home;
  } catch {
    home = null;
  }
  if (home === null) {
    throw new DashboardError("E_DATA_HOME_UNAVAILABLE", `cannot open the Orchestrator: ${unusableDataHomeMessage(deps)}`);
  }
  const folder = orchestratorHomeOf(home);
  const location = { tracesDir: join(home, TRACES_DIR_NAME) };
  try {
    ensureDataHome(home, deps);
    ensureStoreDir(location.tracesDir, folder);
    writeStoreFileAtomically(location, join(folder, "README.md"), ORCHESTRATOR_HOME_README);
  } catch (error) {
    const detail = error instanceof DataHomeError || error instanceof DashboardError ? error.message : String(error);
    throw new DashboardError("E_ORCHESTRATOR_WRITE_FAILED", `cannot prepare the Orchestrator's folder ${folder}: ${detail}`, {
      cause: error,
    });
  }
  return folder;
}

/**
 * `orchestrator.open-preview` (design §8): whether the Orchestrator exists,
 * the provider and model it runs (or would run) on, and where it lives.
 * Creates nothing and writes nothing. When the agent exists and its profile
 * can no longer be read, the provider is the agent's own and the model
 * unknown, so the user can still reopen it.
 */
export async function handleOrchestratorOpenPreview(paseo: OrchestratorAgentPaseo): Promise<OrchestratorOpenPreviewOutput> {
  const existing = await findOrchestratorAgent(paseo);
  if (existing === null) {
    const target = await assessmentTargetOf(paseo);
    return { exists: false, provider: target.provider, model: target.model, workspace: ORCHESTRATOR_WORKSPACE };
  }
  try {
    const target = await assessmentTargetOf(paseo);
    return { exists: true, provider: target.provider, model: target.model, workspace: ORCHESTRATOR_WORKSPACE };
  } catch (error) {
    if (!(error instanceof DashboardError) || error.code !== "E_ORCHESTRATOR_UNAVAILABLE") throw error;
    const provider = (existing as { provider?: unknown }).provider;
    return {
      exists: true,
      provider: typeof provider === "string" && provider !== "" ? provider : "bm-orchestrator",
      model: null,
      workspace: ORCHESTRATOR_WORKSPACE,
    };
  }
}

/** The creation in flight, so two clicks at once create one agent. */
let opening: Promise<OrchestratorOpenOutput> | null = null;

async function openOnce(
  paseo: OrchestratorAgentPaseo,
  deps: OrchestratorAgentDeps,
  recreate: boolean,
  retire: string | null = null,
): Promise<OrchestratorOpenOutput> {
  const existing = await findOrchestratorAgent(paseo);
  // A stale or outdated one is replaced only on request, and a day-old one only
  // while it is still the one a wake-up judged (`retire`); none is ever archived (ADR-005).
  const replace = existing !== null && ((recreate && replacementReasonOf(existing, deps) !== null) || existing.id === retire);
  if (existing !== null && !replace) return { agentId: existing.id, created: false };

  const target = await assessmentTargetOf(paseo);
  const folder = ensureOrchestratorHome(deps);
  const log = deps.log ?? ((message: string) => console.warn(message));
  const workspace = await paseo.workspaces.open({ cwd: folder });
  const posture = await assessmentPostureOf(paseo, target, folder, log);
  const handle = await paseo.workspaces.ref(workspace.id).agents.create({
    config: { provider: assessmentProviderSelection(target), ...posture },
    title: ORCHESTRATOR_TITLE,
    labels: {
      [ORCHESTRATOR_ROLE_LABEL]: ORCHESTRATOR_ROLE_VALUE,
      [ORCHESTRATOR_MAIN_LABEL]: ORCHESTRATOR_MAIN_VALUE,
      "bm.version": PLUGIN_VERSION,
      [ORCHESTRATOR_INSTRUCTIONS_LABEL]: ORCHESTRATOR_INSTRUCTIONS_HASH,
    },
    prompt: ORCHESTRATOR_FIRST_PROMPT,
  });
  if (assessmentStartedBroken(handle.current())) {
    // Kept, not archived (ADR-005): its chat shows the provider's error, and the next open reopens it.
    const snapshot = handle.current();
    log(`[paseo-bm] the Beads Orchestrator ${handle.id} did not start: ${snapshot?.lastError ?? "its provider is unavailable"}`);
  }
  return { agentId: handle.id, created: true };
}

/**
 * `orchestrator.open` (design §3.3, §5.1, §8): the one Orchestrator, created
 * in its own workspace when there is none — or, with `recreate: true`, when
 * the one there has lost its tools or is outdated. Calls that overlap share
 * one creation.
 * `workspaceId` is ignored while the workspace is its own
 * (`ORCHESTRATOR_WORKSPACE`).
 */
export async function handleOrchestratorOpen(
  input: OrchestratorOpenInput,
  paseo: OrchestratorAgentPaseo,
  deps: OrchestratorAgentDeps = {},
): Promise<OrchestratorOpenOutput> {
  return openShared(paseo, deps, input.recreate === true, null);
}

/** One creation at a time: a call that overlaps one in flight gets its result. */
async function openShared(paseo: OrchestratorAgentPaseo, deps: OrchestratorAgentDeps, recreate: boolean, retire: string | null): Promise<OrchestratorOpenOutput> {
  if (opening !== null) return opening;
  opening = openOnce(paseo, deps, recreate, retire);
  try {
    return await opening;
  } finally {
    opening = null;
  }
}

/**
 * The Orchestrator a plugin notice may wake (design §3.3): the main one when
 * it is current; a new one, created as `orchestrator.open { confirmed: true,
 * recreate: true }` creates it, when the newest is outdated or has lost its
 * tools — the owner consented to an Orchestrator when first opening it, and
 * waking one that ignores Autopilot or has no tools helps nobody — or when a
 * current one is more than a day old, idle, and the owner has been quiet in
 * its chat for 2 hours (design §6B.6, `dayOldReasonOf`), so its context stays
 * small; null when there is none, since the plugin never creates one the
 * owner never opened.
 *
 * The old one is left to the owner: never archived, stopped or messaged
 * (ADR-005). One log line says it was replaced. A replacement that fails
 * (no profile, no data folder) is logged and the old one is returned, so the
 * notice still reaches an agent that can tell the owner.
 *
 * `found` is the Orchestrator the caller already listed; it is looked up when
 * left out. Replacing goes through `handleOrchestratorOpen`, which lists again,
 * so two wake-ups at once, or one with an older list, create one agent.
 */
export async function wakeableOrchestrator(
  paseo: OrchestratorAgentPaseo,
  deps: OrchestratorAgentDeps = {},
  found?: OrchestratorAgentSnapshot | null,
): Promise<OrchestratorAgentSnapshot | null> {
  const existing = found === undefined ? await findOrchestratorAgent(paseo) : found;
  if (existing === null) return null;
  const log = deps.log ?? ((message: string) => console.warn(message));
  const stale = replacementReasonOf(existing, deps);
  let reason: string | null;
  try {
    reason = stale ?? (await dayOldReasonOf(paseo, existing, deps));
  } catch (error) {
    log(`[paseo-bm] could not tell whether the Beads Orchestrator ${existing.id} is a day old: ${error instanceof Error ? error.message : String(error)}`);
    reason = null;
  }
  if (reason === null) return existing;
  try {
    const opened = await openShared(paseo, deps, true, stale === null ? existing.id : null);
    if (opened.agentId === existing.id) return existing;
    if (opened.created) {
      log(`[paseo-bm] the Beads Orchestrator ${existing.id} ${reason}; created ${opened.agentId} to take over (the old one stays in your agent list)`);
    }
    return { id: opened.agentId };
  } catch (error) {
    log(
      `[paseo-bm] the Beads Orchestrator ${existing.id} ${reason} and could not be replaced: ${error instanceof Error ? error.message : String(error)}`,
    );
    return existing;
  }
}

/** Registers `orchestrator.open-preview` and `orchestrator.open`; called from `registerOrchestratorRpcs`. */
export function registerOrchestratorAgentRpcs(server: PluginServerContext, deps: OrchestratorAgentDeps = {}): void {
  server.handle(orchestratorOpenPreviewRpc, (_input, { paseo }) => handleOrchestratorOpenPreview(paseo));
  server.handle(orchestratorOpenRpc, (input, { paseo }) => handleOrchestratorOpen(input, paseo, deps));
}
