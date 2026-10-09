/**
 * The Orchestrator's tools (Orchestrator design §5, ADR-014 decision 3),
 * served by `agent-tools.ts` at `/mcp/orchestrator/<secret>`. This module is
 * their registry: it lists them, checks each call's input against the tool's
 * schema, builds the call's context and dispatches it (code review 2026-09-30
 * §4). The tools live in:
 *
 * - `orchestrator-read-tools.ts`: `bm_projects`, `bm_request`,
 *   `bm_agent_messages` (§5.2) and `bm_missions` (missions design §9.1),
 *   which only read; `bm_note` (§6B.4), the record the Orchestrator keeps of
 *   a project. The workflow assessment's tool is retired (autonomy design
 *   §B.9).
 * - `command-authority.ts`: `bm_govern` (missions design §9.4), a governor
 *   command to a mission's current Main, and `bm_direct_worker` (§6B.4,
 *   ADR-016), narrowed to stopping a Worker at once (missions design §9.1);
 *   both send through the one pipeline, `command-send.ts`. `bm_send_command`
 *   is retired: `bm_govern` replaced it.
 * - `governor-tools.ts`: `bm_arbitrate` and `bm_create_main` (missions
 *   design §9.6), the governor's call between two missions and its split of
 *   one; a split without the source mission's `split` cell is the owner's
 *   `m:` card.
 * - `orchestrator-decide-tools.ts`: `bm_ask_owner` (prepared commands to a
 *   Main only), `bm_decisions`, and `bm_decide` and `bm_predict` for a
 *   fallback incident only — a Worker's question is its Main's or the
 *   owner's (autonomy design §A.3, §A.6, §A.9, §B.3, §B.5, §B.9; missions
 *   design §9.1).
 * - `repo-tool.ts`: `bm_repo` (§6B.4), read-only `git` in the project's folder.
 * - `orchestrator-findings.ts`: `bm_findings` (autonomy design §G.4), a
 *   project's measured findings for advice, read-only.
 * - `bm_compact` and `bm_handoff` are retired from the model (missions
 *   design §9.5): code runs compaction and handoff by itself.
 * - `orchestrator-why.ts`: `bm_why` (autonomy design §E.2), the chain behind
 *   a bead, a changed file or a decision, from `links.ts`, read-only.
 * - `decision-ask.ts`: `bm_reply` (change-014 outcome 3, Ask back), the
 *   Orchestrator's reply to the owner's question about one of its `o:`
 *   decisions, appended to that decision's thread; it answers nothing.
 * - `orchestrator-tool-context.ts`: what they share — the call's context, the
 *   refusal, the paseo-bm agents and projects a tool may name.
 *
 * Only `bm_govern`, `bm_arbitrate` (through `bm_govern`) and
 * `bm_direct_worker` reach a working agent — a Main, or a Worker (a stop) and
 * its Main; only `bm_create_main` creates one, a Main. Nothing here sends to
 * a Reviewer, archives, or writes to a repository.
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
import { bmDirectWorker, bmGovern, type CommandToolDeps, type DirectInput, type GovernInput } from "./command-authority";
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
import { bmFindings } from "./orchestrator-findings";
import { bmArbitrate, bmCreateMain, type ArbitrateInput, type CreateMainInput, type GovernorToolDeps } from "./governor-tools";
import { bmAgentMessages, bmMissions, bmNote, bmProjects, bmRequest, type NoteInput } from "./orchestrator-read-tools";
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

export interface OrchestratorToolsDeps extends DataHomeDeps, CommandToolDeps, DecideToolDeps, RepoToolDeps, GovernorToolDeps {
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
      case "bm_missions":
        return { ok: true, text: await bmMissions(input as { missionId?: string; closed?: boolean }, context) };
      case "bm_govern":
        return bmGovern(input as GovernInput, context, deps);
      case "bm_arbitrate":
        return bmArbitrate(input as ArbitrateInput, context, deps);
      case "bm_create_main":
        return bmCreateMain(input as CreateMainInput, context, deps);
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
        return bmNote(input as NoteInput, context);
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
