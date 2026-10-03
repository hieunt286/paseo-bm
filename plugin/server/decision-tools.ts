/**
 * `bm_decisions` (autonomy design §A.9, ADR-017): the decisions of the
 * decision store as an agent's tool reads them — bounded, redacted, newest
 * asked first.
 *
 * - The Orchestrator's face (`server/orchestrator-decide-tools.ts`) lists every
 *   decision of the machine, of one project or of one request, with the grant
 *   each answer gave.
 * - The Manager's face (`createManagerTools`, served at `/mcp/manager` by
 *   `agent-tools.ts`) lists the decisions of one request, without grants.
 *
 * Both only read: the store is opened read-only (a read never creates the
 * folder, never repairs a file), so the Manager's tools stay side-effect free
 * (ADR-010). No Paseo handle is needed.
 */
import type { ToolCaller } from "./agent-bindings";
import { cutText } from "./request-render";
import { redactText } from "./collector";
import { resolveDataHome, type DataHomeDeps } from "./data-home";
import { createDecisionStore, type DecisionFilter } from "./decision-store";
import { DECISIONS_TOOL_LIMIT, MANAGER_SERVER_TOOLS, schemaIssues, type DecisionsToolStatus, type ToolFace } from "../shared/bm-tools";
import { UNSETTLED_STATUSES, decisionClassOf, type Decision, type DecisionStatus, type PreparedAction } from "../shared/decisions";
import { preparedChangeTextOf } from "../shared/prepared-changes";
import { timeOrZero } from "../shared/time";

/** The longest owner's words `bm_decisions` hands out per decision; the rest is cut in the middle. */
export const DECISION_WORDS_MAX_CHARS = 1_000;

/** A server-run tool's answer: text for the agent, or why it was refused. */
export type ServerToolAnswer = { ok: boolean; text: string };

/** The tools a role's endpoint runs on the plugin server (`agent-tools.ts`). */
export interface ServerTools {
  readonly faces: readonly ToolFace[];
  has(name: string): boolean;
  /**
   * Runs one tool for `caller` (design §16.5): the bound agent a token path
   * names (`agentId: null` while its binding is pending), or null on the role
   * path — an unbound caller, whose tools only build or read. The endpoint
   * always passes it; absent reads as null. Never throws.
   */
  call(name: string, input: unknown, caller?: ToolCaller | null): Promise<ServerToolAnswer>;
}

export interface DecisionsQuery {
  workspaceId?: string;
  requestId?: string;
  status?: DecisionsToolStatus;
  limit?: number;
}

/** What a prepared action does, in one line. */
function actionLineOf(action: PreparedAction | undefined): string | null {
  if (action === undefined) return null;
  switch (action.kind) {
    case "answer-worker":
      return "the answer goes to the Worker";
    case "command":
      return `command to the ${action.to} ${action.agentId} (${action.intent}), delivered by the plugin when chosen`;
    case "fallback":
      return `fallback ${action.action} on incident ${action.target}`;
    case "permission":
      // Autonomy design §D.2: a held permission request, answered by the plugin once the owner chooses.
      return `${action.allow ? "allow" : "deny"} permission request ${action.requestId} of ${action.agentId}, sent by the plugin only when the owner chooses it`;
    default:
      // Autonomy design §G.4: a change of the owner's settings, applied only on the owner's own answer.
      return `${action.kind}: the plugin ${preparedChangeTextOf(action)}, only when the owner chooses it`;
  }
}

/** One decision as the tool hands it out: redacted, the owner's words cut, its class; the grant only when asked for. */
export function decisionSummaryOf(decision: Decision, env: NodeJS.ProcessEnv, options: { grant: boolean }) {
  const words = decision.answer?.words ?? null;
  return {
    id: decision.id,
    workspaceId: decision.workspaceId,
    requestId: decision.requestId,
    askedBy: decision.askedBy.role,
    askedAt: decision.askedAt,
    status: decision.status,
    subject: decision.subject,
    // Stored, or read for a decision stored before classes (autonomy design §B.1, §B.9).
    class: decisionClassOf(decision),
    question: redactText(decision.question, env),
    options: decision.options.map((option) => ({
      key: option.key,
      label: redactText(option.label, env),
      recommended: option.recommended,
      effects: option.effects,
      ...(option.action === undefined ? {} : { action: redactText(actionLineOf(option.action) ?? "", env) }),
    })),
    answer:
      decision.answer === null
        ? null
        : {
            // The owner, or the Orchestrator (`bm_decide`, with its reason).
            by: decision.answer.by,
            via: decision.answer.via,
            optionKey: decision.answer.optionKey,
            words: words === null ? null : cutText(redactText(words, env), DECISION_WORDS_MAX_CHARS),
            at: decision.answer.at,
            ...(decision.answer.reason === undefined ? {} : { reason: redactText(decision.answer.reason, env) }),
          },
    ...(options.grant ? { grant: decision.grant } : {}),
    delivery: decision.delivery,
    supersedes: decision.supersedes,
    supersededBy: decision.supersededBy,
  };
}

/**
 * The decisions matching `query` in the data folder `home`, newest asked
 * first, at most `limit`; `total` is how many matched. A folder that holds no
 * decisions reads as none.
 */
export function listDecisions(home: string, query: DecisionsQuery, log?: (message: string) => void): { decisions: Decision[]; total: number } {
  const statuses: readonly DecisionStatus[] | undefined =
    query.status === undefined ? undefined : query.status === "unsettled" ? UNSETTLED_STATUSES : [query.status];
  const filter: DecisionFilter = {
    ...(query.workspaceId === undefined ? {} : { workspaceId: query.workspaceId }),
    ...(query.requestId === undefined ? {} : { requestId: query.requestId }),
    ...(statuses === undefined ? {} : { statuses }),
  };
  const matched = createDecisionStore(home, log === undefined ? {} : { log })
    .list(filter)
    .map((decision, index) => ({ decision, index }))
    .sort((a, b) => timeOrZero(b.decision.askedAt) - timeOrZero(a.decision.askedAt) || b.index - a.index)
    .map(({ decision }) => decision);
  return { decisions: matched.slice(0, query.limit ?? DECISIONS_TOOL_LIMIT.default), total: matched.length };
}

/** `bm_decisions`' answer: JSON of the summaries, and whether more matched than were returned. */
export function decisionsText(home: string, query: DecisionsQuery, env: NodeJS.ProcessEnv, options: { grant: boolean }): string {
  const { decisions, total } = listDecisions(home, query);
  return JSON.stringify(
    { decisions: decisions.map((decision) => decisionSummaryOf(decision, env, options)), total, truncated: total > decisions.length },
    null,
    2,
  );
}

export interface ManagerToolsDeps extends DataHomeDeps {
  /** Secrets to mask; the process's own by default. */
  redactEnv?: NodeJS.ProcessEnv;
}

/**
 * The Manager's server-run tools: `bm_decisions { requestId, status? }`, the
 * decisions of that request from every project, without grants. Reads only;
 * no usable data folder reads as none.
 */
export function createManagerTools(deps: ManagerToolsDeps = {}): ServerTools {
  const faces = MANAGER_SERVER_TOOLS;
  const names = new Set(faces.map((face) => face.name));
  return {
    faces,
    has: (name) => names.has(name),
    async call(name, input) {
      const face = faces.find((candidate) => candidate.name === name);
      if (face === undefined) return { ok: false, text: `Unknown tool: ${name}` };
      const issues = schemaIssues(face.inputSchema, input);
      if (issues.length > 0) return { ok: false, text: `The call was refused. Fix these and call ${name} again:\n${issues.map((issue) => `- ${issue}`).join("\n")}` };
      const { requestId, status } = input as { requestId: string; status?: DecisionsToolStatus };
      try {
        const home = resolveDataHome(deps).home;
        const query: DecisionsQuery = { requestId, ...(status === undefined ? {} : { status }), limit: DECISIONS_TOOL_LIMIT.max };
        if (home === null) return { ok: true, text: JSON.stringify({ decisions: [], total: 0, truncated: false }, null, 2) };
        return { ok: true, text: decisionsText(home, query, deps.redactEnv ?? process.env, { grant: false }) };
      } catch (error) {
        return { ok: false, text: `The tool failed: ${error instanceof Error ? error.message : String(error)}. Try again later, or tell the user.` };
      }
    },
  };
}
