/**
 * Workers the plugin creates itself for a bound Manager (design §16.6,
 * §16.9; ADR-027 decisions 2 and 7, ship point C).
 *
 * - `createPluginWorker` is the one creation: `bm-worker/<model>` from the
 *   `bm-worker` profile, the mode by the Worker rules (`modeFactsOf`, the same
 *   value a Manager's Runtime facts name, §7.2), `cwd` given, `parent` = the
 *   Manager, title `Beads Worker`, labels `bm.role`, `bm.requestId`,
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
 *   same creation with the stored brief.
 *
 * The caller's identity, workspace and folder come from its binding and its
 * own snapshot, never from what the agent typed. A refusal is one line per
 * reason and creates nothing; once the request id is generated it is never
 * reused, even when Paseo then refuses the Worker. Nothing here throws into
 * the endpoint.
 */
import { NO_BINDER, createBound, withoutTokenPaths, type AgentBinder, type ToolCaller } from "./agent-bindings";
import { aliasBases } from "./alias-bases";
import type { ServerToolAnswer, ServerTools } from "./decision-tools";
import { AGENT_TOOLS_OFF_TOOL_MESSAGE, agentToolsOff } from "./manager";
import { listedWorkspaces, type DashboardPaseo } from "./paseo-directory";
import { createRequestRegistry } from "./request-registry";
import { asRecord, nonEmpty, reasonOf } from "./role-choices";
import { creationProjectOf, modeFactsOf } from "./role-instructions";
import { profileOf } from "./role-mode";
import { actingTools, boundAs, fixThese, refused, withoutNulls } from "./tool-kit";
import { boundToolFacesFor, schemaIssues } from "../shared/bm-tools";
import { briefLineOf } from "../shared/notices";
import { PLUGIN_VERSION } from "../shared/version";

/** The profile and alias a plugin-created Worker is made from. */
export const WORKER_PROFILE_ID = "bm-worker";
/** Title of every Worker the plugin creates for a request (a fallback Worker has its own). */
export const WORKER_TITLE = "Beads Worker";
export const CREATE_WORKER_TOOL = "bm_create_worker";

/** The caller is not a bound Manager: it creates its Worker by hand. */
export const NOT_BOUND_MESSAGE =
  "bm_create_worker is only for a Manager paseo-bm created with its own tools, and you are not one: create the Worker with create_agent as your instructions say. Nothing was created.";
/** No Paseo handle has reached the plugin yet (as the Orchestrator's tools say, design §7.4). */
export const NO_PASEO_MESSAGE = "paseo-bm has no connection to Paseo yet; try again in a moment. Nothing was created.";
/** The `bm-worker` profile is missing (or Paseo's configuration cannot be read). */
export const NO_WORKER_PROFILE_MESSAGE =
  'There is no "bm-worker" profile on this machine, so no Worker can be created; tell the owner to open Beads Manager → Settings. Nothing was created.';
/** The line `workerBriefOf` puts after the size: the scope rule of every request. */
export const SCOPE_LINE = "Do only what the request asks. Anything extra is a suggestion for the owner, not work.";

export type WorkerSize = "Small" | "Medium" | "Large";

/** One fact the Manager passes, with where it comes from. */
export interface ContextFact {
  fact: string;
  source: string;
}

/** What `bm_create_worker` takes (design §16.6). */
export interface CreateWorkerInput {
  request: string;
  size?: WorkerSize;
  context: ContextFact[];
}

/** One line: a newline inside a value would end it. */
const oneLine = (text: string): string => text.replace(/\s*\r?\n\s*/g, " ").trim();

/**
 * The first prompt of a Worker created by `bm_create_worker` (design §16.6):
 * the `BM-BRIEF` line, the request verbatim in a quoted block, the request id,
 * the repository and its `.beads/`, the size when the owner stated one, the
 * scope rule, the Manager's id, then `Context:` with each fact and its source.
 * Pure.
 */
export function workerBriefOf(input: { requestId: string; request: string; cwd: string; managerId: string; size?: WorkerSize | null; context: readonly ContextFact[] }): string {
  const quoted = input.request
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => (line === "" ? ">" : `> ${line}`))
    .join("\n");
  const repository = input.cwd.replace(/\/+$/, "");
  return [
    briefLineOf("worker", input.requestId),
    "The owner's request, verbatim:",
    quoted,
    "",
    `requestId: ${input.requestId}`,
    `repository: ${repository} (beads in ${repository}/.beads/)`,
    ...(input.size === undefined || input.size === null ? [] : [`size: ${input.size} (the owner stated it)`]),
    SCOPE_LINE,
    `managerAgentId: ${input.managerId}`,
    "Context:",
    ...(input.context.length === 0 ? ["- none"] : input.context.map((entry) => `- ${oneLine(entry.fact)} (source: ${oneLine(entry.source)})`)),
  ].join("\n");
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
  /** The `bm-worker` profile's model (`workerProfileOf`). */
  model: string | null;
  /** Labels beside `bm.role`, `bm.requestId` and `bm.version` (`bm.handoffFrom`). */
  labels?: Record<string, string>;
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
    { role: "worker", base, workspaceId: spec.workspaceId, requestId: spec.requestId, parentId: spec.managerId },
    (mcpServers) =>
      paseo.agents.create({
        config: {
          provider: spec.model === null ? WORKER_PROFILE_ID : `${WORKER_PROFILE_ID}/${spec.model}`,
          ...(modeId !== undefined ? { modeId } : {}),
          ...(mcpServers !== undefined ? { mcpServers } : {}),
        },
        cwd: spec.cwd,
        parent: spec.managerId,
        title: WORKER_TITLE,
        labels: { "bm.role": "worker", "bm.requestId": spec.requestId, "bm.version": PLUGIN_VERSION, ...spec.labels },
        prompt: spec.prompt,
      }),
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
    const input = withoutNulls(raw);
    const issues = schemaIssues(face.inputSchema, input);
    if (issues.length > 0) return fixThese(CREATE_WORKER_TOOL, issues);
    const { request, size, context } = input as CreateWorkerInput;
    const home = deps.home();
    const paseo = deps.paseo();
    if (paseo === null || paseo === undefined) return refused(NO_PASEO_MESSAGE);
    // A Worker gets Paseo's tools only when it is created: one made now could not create a Reviewer.
    if (await agentToolsOff(paseo)) return refused(AGENT_TOOLS_OFF_TOOL_MESSAGE);
    const profile = await workerProfileOf(paseo, log);
    if (profile === null) return refused(NO_WORKER_PROFILE_MESSAGE);
    // The Manager's own folder, read from Paseo — never a folder the agent typed.
    const cwd = await folderOfAgent(paseo, managerId, caller.workspaceId);
    if (cwd === null) return refused(`paseo-bm could not read your folder from Paseo; try again in a moment. Nothing was created.`);

    // The request id, registered before anything is created: once generated, it is never reused.
    let requestId: string;
    try {
      requestId = createRequestRegistry(home, { log }).generate(caller.workspaceId, { managerId }).requestId;
    } catch (error) {
      return refused(`paseo-bm could not write its request registry (${reasonOf(error)}); nothing was created. Tell the owner in one line.`);
    }

    let workerId: string;
    try {
      const prompt = workerBriefOf({ requestId, request, cwd, managerId, size: size ?? null, context });
      ({ workerId } = await createPluginWorker(
        paseo as WorkerCreationPaseo,
        { workspaceId: caller.workspaceId, requestId, managerId, cwd, prompt, model: profile.model },
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
      createRequestRegistry(home, { log }).addWorker(caller.workspaceId, requestId, workerId);
    } catch (error) {
      log(`[paseo-bm] could not add Worker ${workerId} to request ${requestId}: ${reasonOf(error)}`);
    }
    return { ok: true, text: JSON.stringify({ workerId, requestId }) };
  };

  return actingTools(faces, { [CREATE_WORKER_TOOL]: run }, "Nothing was created");
}
