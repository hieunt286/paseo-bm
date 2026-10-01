/**
 * Tokens (evaluation design §4 A-8) and the context figures (autonomy design
 * §G.2): what each provider's counts mean (`tokenProviderOf`, `turnTokensOf`,
 * shared with the collector), the tokens of finished requests, and the tokens
 * read per turn, per request and per agent with the compaction and handoff
 * candidates the §G.7 defaults would have raised.
 *
 * This module is `shared/`: no Node and no React Native imports.
 */
import type { Evidence, TraceRecord } from "../contracts";
import { compareText, median, percentile, roleOf, tokensOf, zeroRoles } from "./helpers";
import type { EvalScope, RequestFacts } from "./scope";
import {
  EVAL_ROLES,
  TOKEN_PROVIDERS,
  type CandidateRow,
  type CandidateSet,
  type ContextCandidates,
  type EvalMetrics,
  type EvalRole,
  type HeavyRequest,
  type RoleCounts,
  type Spread,
  type SpreadByRole,
  type TokenProvider,
} from "./types";

// ── What a turn's counts mean (run note 2026-09-30 §4) ──────────────────────

/** What a turn's reported tokens cover: every model call of the turn, or its last call only. */
export type TokenCoverage = "turn" | "last-call" | "unknown";

export const TOKEN_COVERAGE: Readonly<Record<TokenProvider, TokenCoverage>> = { claude: "turn", codex: "last-call", opencode: "last-call", unknown: "unknown" };

/** A handoff brief's size (§G.6), and the rough rule that turns it into tokens. */
export const BRIEF_CHARACTERS = 6_000;
export const CHARACTERS_PER_TOKEN = 4;
export const BRIEF_TOKENS = BRIEF_CHARACTERS / CHARACTERS_PER_TOKEN;
/** How many of the heaviest requests are listed. */
export const HEAVIEST_REQUESTS = 5;

/**
 * The provider whose token counting a turn follows. A record keeps its
 * provider alias (`bm-worker`), not the alias's base, so the model id is the
 * sign: OpenCode names its models `<provider>/<model>`; Claude's start with
 * `claude` (or are Claude Code's `opus` / `sonnet` / `haiku`); Codex's are
 * OpenAI's (`gpt-…`, `o3`, `codex-…`). A snapshot naming one of the three as
 * its provider is taken at its word. Anything else is unknown.
 */
export function tokenProviderOf(record: Pick<TraceRecord, "runtime" | "usage">): TokenProvider {
  const provider = record.runtime?.provider ?? null;
  if (provider === "claude" || provider === "codex" || provider === "opencode") return provider;
  const model = (record.runtime?.model ?? record.usage?.model ?? "").trim().toLowerCase();
  if (model === "") return "unknown";
  if (model.includes("/")) return "opencode";
  if (/^claude(?:-|$)|^(?:opus|sonnet|haiku)(?:$|[-[])/.test(model)) return "claude";
  if (/^(?:gpt|codex)(?:-|$)|^o\d/.test(model)) return "codex";
  return "unknown";
}

/** What one turn's usage says about tokens and context (§G.2 Derived). */
export interface TurnTokens {
  provider: TokenProvider;
  coverage: TokenCoverage;
  /**
   * Tokens read in the turn: input + cached — Codex's input alone, its cached
   * tokens being part of it. On Claude the whole turn's; on Codex and OpenCode
   * the last model call's. null without usage; 0 for a repeated turn.
   */
  tokensRead: number | null;
  /** The turn repeated its agent's previous counts: OpenCode keeps them over a turn with no model call. */
  repeated: boolean;
  /**
   * The model calls `tokensRead` covers: 1 on a last-call provider; else the
   * tool calls + 1 — without `toolCalls`, a lower bound from the turn's shell,
   * file and sub-agent evidence (`callsExact` false).
   */
  calls: number;
  callsExact: boolean;
  /**
   * The context at the turn's end: `contextUsed` when reported; else an
   * estimate — tokens read ÷ (tool calls + 1), or a last-call provider's tokens
   * read as they are. null when neither can be had.
   */
  context: { tokens: number; basis: "reported" | "estimated" } | null;
  /** `context` ÷ the reported window; null without both. */
  contextShare: number | null;
}

/** Evidence that stands for one tool call each: a lower bound on a turn's tool calls when `toolCalls` was not recorded. */
const TOOL_CALL_EVIDENCE: ReadonlySet<Evidence["kind"]> = new Set(["shell", "file", "agent"]);

/**
 * One turn's tokens and context. `previous` is the same agent's turn before it
 * that had usage: an OpenCode turn with no tool call repeating its counts
 * exactly made no model call (run note §4, its `/compact` turn).
 */
export function turnTokensOf(record: TraceRecord, previous: TraceRecord | null = null): TurnTokens {
  const provider = tokenProviderOf(record);
  const coverage = TOKEN_COVERAGE[provider];
  const lastCall = coverage === "last-call";
  const toolCalls = record.toolCalls ?? record.evidence.filter((evidence) => TOOL_CALL_EVIDENCE.has(evidence.kind)).length;
  const calls = lastCall ? 1 : toolCalls + 1;
  const callsExact = lastCall || record.toolCalls !== undefined;
  const usage = record.usage;
  if (usage === null) return { provider, coverage, tokensRead: null, repeated: false, calls, callsExact, context: null, contextShare: null };
  const before = previous?.usage ?? null;
  const repeated =
    provider === "opencode" &&
    (record.toolCalls ?? 0) === 0 &&
    before !== null &&
    usage.inputTokens + usage.cachedInputTokens + usage.outputTokens > 0 &&
    usage.inputTokens === before.inputTokens &&
    usage.cachedInputTokens === before.cachedInputTokens &&
    usage.outputTokens === before.outputTokens;
  const tokensRead = repeated ? 0 : provider === "codex" ? usage.inputTokens : usage.inputTokens + usage.cachedInputTokens;
  let context: TurnTokens["context"] = null;
  if (!repeated) {
    if (usage.contextUsed !== undefined) context = { tokens: usage.contextUsed, basis: "reported" };
    else if (lastCall) context = { tokens: tokensRead, basis: "estimated" };
    else if (callsExact) context = { tokens: Math.round(tokensRead / calls), basis: "estimated" };
  }
  const contextShare = context !== null && usage.contextMax !== undefined ? context.tokens / usage.contextMax : null;
  return { provider, coverage, tokensRead, repeated, calls, callsExact, context, contextShare };
}

// ── A-8: tokens per finished request ────────────────────────────────────────

/**
 * A-8: tokens of finished requests, by role. The Orchestrator's own
 * (`orchestratorTokensOf`) and the suite's cost of it are given beside them.
 */
export function a8Of(
  finishedRequests: readonly RequestFacts[],
  orchestrator: EvalMetrics["a8"]["orchestrator"],
  orchestratorCostUsd: number | null,
): EvalMetrics["a8"] {
  const finishedCount = finishedRequests.length;
  const tokensByRole = zeroRoles();
  const perRequestTotals: number[] = [];
  let finishedWithMissingUsage = 0;
  for (const facts of finishedRequests) {
    let total = 0;
    for (const record of facts.records) {
      tokensByRole[roleOf(record)] += tokensOf(record);
      total += tokensOf(record);
    }
    perRequestTotals.push(total);
    if (facts.records.some((record) => record.usage === null)) finishedWithMissingUsage += 1;
  }
  const tokensTotal = EVAL_ROLES.reduce((sum, role) => sum + tokensByRole[role], 0);
  return {
    finishedRequests: finishedCount,
    tokens: { total: tokensTotal, byRole: tokensByRole },
    perFinishedRequest:
      finishedCount === 0
        ? null
        : {
            total: tokensTotal / finishedCount,
            byRole: Object.fromEntries(EVAL_ROLES.map((role) => [role, tokensByRole[role] / finishedCount])) as RoleCounts,
          },
    medianPerFinishedRequest: median(perRequestTotals),
    finishedRequestsWithMissingUsage: finishedWithMissingUsage,
    orchestratorCostUsd,
    orchestrator,
  };
}

// ── Context and tokens (autonomy design §G.2) ───────────────────────────────

/** The spread of a set of figures. */
export function spreadOf(values: readonly number[]): Spread {
  return {
    count: values.length,
    median: median(values),
    p75: percentile(values, 75),
    p80: percentile(values, 80),
    p90: percentile(values, 90),
    max: values.length === 0 ? null : values.reduce((max, value) => Math.max(max, value), Number.NEGATIVE_INFINITY),
  };
}

function spreadByRoleOf(entries: ReadonlyArray<{ role: EvalRole; value: number }>): SpreadByRole {
  return {
    all: spreadOf(entries.map((entry) => entry.value)),
    byRole: Object.fromEntries(EVAL_ROLES.map((role) => [role, spreadOf(entries.filter((entry) => entry.role === role).map((entry) => entry.value))])) as Record<EvalRole, Spread>,
  };
}

/** The turns after `index` with usage: their tokens read and model calls. */
function afterOf(records: readonly TraceRecord[], index: number, tokens: ReadonlyMap<TraceRecord, TurnTokens>, keep: (record: TraceRecord) => boolean): CandidateRow["after"] {
  const after = { turns: 0, tokensRead: 0, calls: 0, callsExact: true };
  for (const record of records.slice(index + 1)) {
    const turn = tokens.get(record);
    if (turn === undefined || turn.tokensRead === null || !keep(record)) continue;
    after.turns += 1;
    after.tokensRead += turn.tokensRead;
    after.calls += turn.calls;
    if (!turn.callsExact) after.callsExact = false;
  }
  return after;
}

const savingOf = (after: CandidateRow["after"]): number => Math.max(0, after.tokensRead - after.calls * BRIEF_TOKENS);

function candidateSetOf(rows: CandidateRow[]): CandidateSet {
  rows.sort(
    (a, b) =>
      b.savingTokens - a.savingTokens ||
      compareText(a.workspaceId, b.workspaceId) ||
      compareText(a.requestId ?? "", b.requestId ?? "") ||
      compareText(a.agentId ?? "", b.agentId ?? ""),
  );
  return { candidates: rows.length, savingTokens: rows.reduce((sum, row) => sum + row.savingTokens, 0), rows };
}

/** A request as the context figures read it: its records in the metric order. */
type ContextRequest = { id: string; records: readonly TraceRecord[]; finished: boolean };

/** One agent's turns in scope, oldest first, and its tokens read over them. */
interface AgentTurns {
  role: EvalRole;
  value: number;
  records: TraceRecord[];
}

/**
 * The compaction and handoff candidates at the §G.7 defaults as this scope
 * gives them: an agent (a Manager or a Worker) compacts at the p75 of its
 * role's tokens read per turn, a request hands off at the p80 of the
 * requests' tokens read.
 */
function candidatesOf(
  agents: ReadonlyMap<string, AgentTurns>,
  requests: readonly ContextRequest[],
  perTurn: SpreadByRole,
  perRequest: SpreadByRole,
  tokens: ReadonlyMap<TraceRecord, TurnTokens>,
): ContextCandidates {
  const turnOf = (record: TraceRecord): TurnTokens => tokens.get(record) ?? turnTokensOf(record);
  const compactAt = { manager: perTurn.byRole.manager.p75, worker: perTurn.byRole.worker.p75 };
  const handoffAt = perRequest.all.p80;
  const compaction: CandidateRow[] = [];
  for (const [agentId, agent] of [...agents.entries()].sort(([a], [b]) => compareText(a, b))) {
    if (agent.role !== "manager" && agent.role !== "worker") continue;
    const threshold = compactAt[agent.role];
    if (threshold === null) continue;
    const index = agent.records.findIndex((record) => {
      const read = turnOf(record).tokensRead;
      return read !== null && read > 0 && read >= threshold;
    });
    if (index < 0) continue;
    const trigger = agent.records[index]!;
    const after = afterOf(agent.records, index, tokens, () => true);
    compaction.push({
      workspaceId: trigger.workspaceId,
      requestId: trigger.requestId,
      agentId,
      role: agent.role,
      turn: index + 1,
      turns: agent.records.length,
      crossedAt: turnOf(trigger).tokensRead ?? 0,
      after,
      savingTokens: savingOf(after),
    });
  }
  const handoff: CandidateRow[] = [];
  if (handoffAt !== null) {
    for (const facts of requests) {
      let sum = 0;
      const index = facts.records.findIndex((record) => {
        sum += turnOf(record).tokensRead ?? 0;
        return sum > 0 && sum >= handoffAt;
      });
      if (index < 0) continue;
      const after = afterOf(facts.records, index, tokens, (record) => roleOf(record) === "worker");
      handoff.push({
        workspaceId: facts.records[index]!.workspaceId,
        requestId: facts.id,
        agentId: null,
        role: "worker",
        turn: index + 1,
        turns: facts.records.length,
        crossedAt: sum,
        after,
        savingTokens: savingOf(after),
      });
    }
  }
  return {
    estimate: true,
    thresholds: { compactTokensPerTurn: compactAt, handoffRequestTokens: handoffAt, briefTokens: BRIEF_TOKENS },
    compaction: candidateSetOf(compaction),
    handoff: candidateSetOf(handoff),
  };
}

/**
 * The context and token figures of one scope (`EvalMetrics.context`).
 * `scopeRecords` and each request's records are in the metric order (oldest
 * first); `tokens` holds every record's `turnTokensOf`.
 */
function contextFiguresOf(
  scopeRecords: readonly TraceRecord[],
  requests: readonly ContextRequest[],
  tokens: ReadonlyMap<TraceRecord, TurnTokens>,
): EvalMetrics["context"] {
  const turnOf = (record: TraceRecord): TurnTokens => tokens.get(record) ?? turnTokensOf(record);
  const byProvider = Object.fromEntries(TOKEN_PROVIDERS.map((provider) => [provider, 0])) as Record<TokenProvider, number>;
  const perTurn: Array<{ role: EvalRole; value: number }> = [];
  const contexts: Array<{ role: EvalRole; value: number }> = [];
  const shares: number[] = [];
  const byRole = zeroRoles();
  const agents = new Map<string, AgentTurns>();
  let withUsage = 0;
  let repeated = 0;
  let withToolCalls = 0;
  let reported = 0;
  let estimated = 0;
  for (const record of scopeRecords) {
    const turn = turnOf(record);
    const role = roleOf(record);
    if (record.toolCalls !== undefined) withToolCalls += 1;
    if (turn.context !== null) {
      if (turn.context.basis === "reported") reported += 1;
      else estimated += 1;
      contexts.push({ role, value: turn.context.tokens });
    }
    if (turn.contextShare !== null) shares.push(turn.contextShare);
    let agent = agents.get(record.agentId);
    if (agent === undefined) {
      agent = { role, value: 0, records: [] };
      agents.set(record.agentId, agent);
    }
    agent.records.push(record);
    if (turn.tokensRead === null) continue;
    withUsage += 1;
    byProvider[turn.provider] += 1;
    if (turn.repeated) repeated += 1;
    perTurn.push({ role, value: turn.tokensRead });
    byRole[role] += turn.tokensRead;
    agent.value += turn.tokensRead;
  }

  // Requests: every turn of a request in the window; a role counts for the requests where it had a turn with usage.
  const requestTotals: number[] = [];
  const requestRoleTotals: Array<{ role: EvalRole; value: number }> = [];
  const heavy: HeavyRequest[] = [];
  for (const facts of requests) {
    const roles = zeroRoles();
    const seen = new Set<EvalRole>();
    let total = 0;
    let turns = 0;
    for (const record of facts.records) {
      const read = turnOf(record).tokensRead;
      if (read === null) continue;
      turns += 1;
      total += read;
      roles[roleOf(record)] += read;
      seen.add(roleOf(record));
    }
    if (turns === 0) continue;
    requestTotals.push(total);
    for (const role of EVAL_ROLES) if (seen.has(role)) requestRoleTotals.push({ role, value: roles[role] });
    heavy.push({ requestId: facts.id, workspaceId: facts.records[0]!.workspaceId, tokensRead: total, byRole: roles, turns, finished: facts.finished });
  }
  const perRequest: SpreadByRole = { all: spreadOf(requestTotals), byRole: spreadByRoleOf(requestRoleTotals).byRole };
  heavy.sort((a, b) => b.tokensRead - a.tokensRead || compareText(a.workspaceId, b.workspaceId) || compareText(a.requestId, b.requestId));

  const agentEntries = [...agents.values()].filter((agent) => agent.records.some((record) => turnOf(record).tokensRead !== null));
  const perTurnSpread = spreadByRoleOf(perTurn);

  return {
    turns: { withUsage, byProvider, repeated, withToolCalls },
    tokensRead: {
      total: EVAL_ROLES.reduce((sum, role) => sum + byRole[role], 0),
      byRole,
      perTurn: perTurnSpread,
      perRequest,
      perAgent: spreadByRoleOf(agentEntries.map((agent) => ({ role: agent.role, value: agent.value }))),
      heaviestRequests: heavy.slice(0, HEAVIEST_REQUESTS),
    },
    contextEstimate: {
      reported,
      estimated,
      unknown: scopeRecords.length - reported - estimated,
      perTurn: spreadByRoleOf(contexts),
      shareOfWindow: spreadOf(shares),
    },
    candidates: candidatesOf(agents, requests, perTurnSpread, perRequest, tokens),
  };
}

/** Context and tokens (autonomy design §G.2): every turn read once, beside its agent's turn before it that had usage. */
export function contextOf(scope: EvalScope): EvalMetrics["context"] {
  const turnTokens = new Map<TraceRecord, TurnTokens>();
  const lastWithUsage = new Map<string, TraceRecord>();
  for (const record of scope.records) {
    turnTokens.set(record, turnTokensOf(record, lastWithUsage.get(record.agentId) ?? null));
    if (record.usage !== null) lastWithUsage.set(record.agentId, record);
  }
  return contextFiguresOf(scope.scopeRecords, scope.inScope, turnTokens);
}
