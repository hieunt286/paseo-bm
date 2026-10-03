/**
 * The Orchestrator's tools (Orchestrator design §5, ADR-014 decision 3),
 * served by `agent-tools.ts` at `/mcp/orchestrator/<secret>`. This module is
 * their registry: it lists them, checks each call's input against the tool's
 * schema, builds the call's context and dispatches it (code review 2026-09-30
 * §4). The tools live in:
 *
 * - `orchestrator-read-tools.ts`: `bm_projects`, `bm_request`,
 *   `bm_agent_messages` (§5.2), which only read; `bm_note` (§6B.4), the
 *   record the Orchestrator keeps of a project. The workflow assessment's
 *   tool is retired (autonomy design §B.9).
 * - `command-authority.ts`: `bm_send_command` (§6A, §6B.1, ADR-015) and
 *   `bm_direct_worker` (§6B.4, ADR-016), and the authority a command goes on
 *   (autonomy design §A.7, §B.9); both send through the one pipeline,
 *   `command-send.ts`.
 * - `orchestrator-decide-tools.ts`: `bm_ask_owner`, `bm_decisions`,
 *   `bm_decide` and `bm_predict` (autonomy design §A.3, §A.6, §A.9, §B.3,
 *   §B.5, §B.9).
 * - `repo-tool.ts`: `bm_repo` (§6B.4), read-only `git` in the project's folder.
 * - `orchestrator-findings.ts`: `bm_findings` (autonomy design §G.4), a
 *   project's measured findings for advice, read-only.
 * - `orchestrator-coordination-tools.ts`: `bm_compact` (autonomy design
 *   §G.5), a Manager's or a Worker's compaction, and `bm_handoff` (§G.6), a
 *   Worker's request handed to a successor its Manager creates, within the
 *   owner's Settings.
 * - `orchestrator-why.ts`: `bm_why` (autonomy design §E.2), the chain behind
 *   a bead, a changed file or a decision, from `links.ts`, read-only.
 * - `decision-ask.ts`: `bm_reply` (change-014 outcome 3, Ask back), the
 *   Orchestrator's reply to the owner's question about one of its `o:`
 *   decisions, appended to that decision's thread; it answers nothing.
 * - `orchestrator-tool-context.ts`: what they share — the call's context, the
 *   refusal, the paseo-bm agents and projects a tool may name.
 *
 * Only `bm_send_command`, `bm_direct_worker`, `bm_compact` and `bm_handoff`
 * reach a working agent — a Manager, or a Worker and its Manager; `bm_compact`
 * sends only the provider's `/compact` and the plugin's `BM-STATE` brief, to
 * the Manager or Worker it names; `bm_handoff` only the `BM-HANDOFF` note
 * request to the Worker it names and, later, the handoff `BM-COMMAND` to that
 * Worker's Manager, which creates the successor. Nothing here sends
 * to a Reviewer, creates, stops or archives, or writes to a repository.
 *
 * The endpoint is plain HTTP, so there is no hook or RPC context to take a
 * Paseo handle from. The creation hook hands one over (`usePaseo`) every time
 * a paseo-bm agent is created — and the Orchestrator only learns the
 * endpoint's secret from that hook, so a call that reaches these tools always
 * comes after a handle was given in this run of the plugin.
 *
 * Nothing here throws to the endpoint: a failure is a tool error the agent
 * reads.
 */
import { bmDirectWorker, bmSendCommand, type CommandToolDeps, type DirectInput, type SendInput } from "./command-authority";
import { resolveDataHome, type DataHomeDeps } from "./data-home";
import type { DecisionsQuery } from "./decision-tools";
import {
  bmAskOwner,
  bmDecide,
  bmDecisions,
  bmPredict,
  type AskOwnerInput,
  type DecideInput,
  type DecideToolDeps,
} from "./orchestrator-decide-tools";
import { bmCompact, bmHandoff, type CompactInput, type CoordinationToolDeps, type HandoffInput } from "./orchestrator-coordination-tools";
import { bmFindings } from "./orchestrator-findings";
import { bmAgentMessages, bmNote, bmProjects, bmRequest } from "./orchestrator-read-tools";
import { bmWhy, type WhyInput } from "./orchestrator-why";
import { replyToDecision } from "./decision-ask";
import { createOrchestratorStore } from "./orchestrator-store";
import {
  Refusal,
  agentListOf,
  refuse,
  type OrchestratorToolsPaseo,
  type ServerToolResult,
  type ToolContext,
} from "./orchestrator-tool-context";
import { bmRepo, type RepoInput, type RepoToolDeps } from "./repo-tool";
import { ORCHESTRATOR_SERVER_TOOLS, schemaIssues, type ReadDetail, type ToolFace } from "../shared/bm-tools";
import { DashboardError } from "../shared/contracts";
import { errorText } from "./rpc-kit";
import { fixThese } from "./tool-kit";

export interface OrchestratorToolsDeps extends DataHomeDeps, CommandToolDeps, DecideToolDeps, RepoToolDeps, Pick<CoordinationToolDeps, "compaction" | "handoff"> {
  now?: () => Date;
  /** Secrets to mask; the process's own by default. */
  redactEnv?: NodeJS.ProcessEnv;
}

export interface OrchestratorTools {
  /** The tools the Orchestrator's endpoint lists, in order. */
  readonly faces: readonly ToolFace[];
  /** True when `name` is one of these tools. */
  has(name: string): boolean;
  /** Keeps the handle a hook or RPC context brought; anything that is not one is ignored. */
  usePaseo(paseo: unknown): void;
  /** Runs one tool. Never throws. */
  call(name: string, input: unknown): Promise<ServerToolResult>;
}

function isPaseo(value: unknown): value is OrchestratorToolsPaseo {
  const candidate = value as { agents?: { list?: unknown }; workspaces?: { list?: unknown } } | null | undefined;
  return typeof candidate?.agents?.list === "function" && typeof candidate?.workspaces?.list === "function";
}

/** Creates the Orchestrator's tools. The handle comes later, through `usePaseo`. */
export function createOrchestratorTools(deps: OrchestratorToolsDeps = {}): OrchestratorTools {
  const faces: readonly ToolFace[] = ORCHESTRATOR_SERVER_TOOLS;
  const names = new Set(faces.map((face) => face.name));
  let paseo: OrchestratorToolsPaseo | null = null;

  const contextOf = (): ToolContext => {
    if (paseo === null) refuse("paseo-bm has no connection to Paseo yet; try again in a moment");
    let resolution: ReturnType<typeof resolveDataHome>;
    try {
      resolution = resolveDataHome(deps);
    } catch (error) {
      refuse(`the paseo-bm data folder cannot be used: ${errorText(error)}`);
    }
    if (resolution.home === null) refuse(`the paseo-bm data folder cannot be used: ${resolution.reason}`);
    return {
      paseo,
      home: resolution.home,
      location: { tracesDir: resolution.tracesDir },
      store: createOrchestratorStore(resolution.home, deps.store),
      now: (deps.now ?? (() => new Date()))(),
      env: deps.redactEnv ?? process.env,
      // One walk of `agents.list` per call, shared by every check of it.
      listed: agentListOf(paseo),
    };
  };

  const run = async (name: string, input: unknown): Promise<ServerToolResult> => {
    const face = faces.find((candidate) => candidate.name === name)!;
    const issues = schemaIssues(face.inputSchema, input);
    if (issues.length > 0) return fixThese(name, issues);
    const context = contextOf();
    switch (name) {
      case "bm_projects":
        return { ok: true, text: await bmProjects(input as { sinceHours?: number; detail?: ReadDetail }, context) };
      case "bm_request":
        return { ok: true, text: await bmRequest(input as { workspaceId: string; requestId: string; detail?: ReadDetail }, context, deps) };
      case "bm_agent_messages":
        return { ok: true, text: await bmAgentMessages(input as { agentId: string; limit?: number; detail?: ReadDetail }, context) };
      case "bm_send_command":
        return bmSendCommand(input as SendInput, context, deps);
      case "bm_decisions":
        return bmDecisions(input as DecisionsQuery, context);
      case "bm_ask_owner":
        return bmAskOwner(input as AskOwnerInput, context, deps);
      case "bm_decide":
        return bmDecide(input as DecideInput, context, deps);
      case "bm_predict":
        return bmPredict(input as DecideInput, context);
      case "bm_direct_worker":
        return bmDirectWorker(input as DirectInput, context, deps);
      case "bm_repo":
        return bmRepo(input as RepoInput, context, deps);
      case "bm_findings":
        return bmFindings(input as { workspaceId: string }, context, deps.log);
      case "bm_compact":
        return bmCompact(input as CompactInput, context, deps);
      case "bm_handoff":
        return bmHandoff(input as HandoffInput, context, deps);
      case "bm_why":
        return bmWhy(input as WhyInput, context, deps);
      case "bm_reply":
        // Change-014 outcome 3 (Ask back): the Orchestrator's reply to the owner's question about one of its decisions.
        return replyToDecision(input as { decisionId: string; text: string }, {
          kind: "orchestrator",
          home: context.home,
          now: context.now,
          env: context.env,
          ...(deps.log === undefined ? {} : { log: deps.log }),
        });
      default:
        return bmNote(input as { workspaceId: string; text: string; replace?: boolean }, context);
    }
  };

  return {
    faces,
    has: (name) => names.has(name),
    usePaseo(value) {
      if (isPaseo(value)) paseo = value;
    },
    async call(name, input) {
      if (!names.has(name)) return { ok: false, text: `Unknown tool: ${name}` };
      try {
        return await run(name, input);
      } catch (error) {
        if (error instanceof Refusal) return { ok: false, text: `Refused: ${error.message}.` };
        if (error instanceof DashboardError) return { ok: false, text: `Refused: ${error.message}.` };
        return { ok: false, text: `The tool failed: ${errorText(error)}. Try again later, or tell the user.` };
      }
    },
  };
}
