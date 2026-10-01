/**
 * Tokens and cost of a rebuilt trace (WP-206.1.2, WP-209; Dashboard Design §9;
 * code review 2026-09-30 §4): its token sums per model, role and agent, what
 * each agent ran on, and each agent's tokens and context over its turns.
 *
 * Never prices anything itself: the price table is handed in (`price`), so
 * this module never has to know about money. Pure, like the rebuild it reads
 * (`traces.ts`).
 */
import { byAt } from "../shared/order";
import { turnTokensOf } from "../shared/eval-metrics";
import { CONTEXT_TREND_MAX } from "../shared/contracts";
import type { AgentTokenFigures, RuntimeRow, TraceRecord, Usage } from "../shared/contracts";
import type { ReconstructedTrace } from "./traces";

/**
 * The model a turn actually ran on (delta 20260918 §4.2): the running model the
 * collector recorded in `runtime`, else the configured one in `usage`. Records
 * written before that delta only have the second. Every grouping by model uses
 * this one definition, so cost, the per-model lines and the overview agree.
 */
export function effectiveModel(record: Pick<TraceRecord, "runtime" | "usage">): string | null {
  return record.runtime?.model ?? record.usage?.model ?? null;
}

/**
 * Sums the tokens a trace used. Cost is left unpriced here (`unavailable`):
 * WP-209 owns the price table and applies it, so this module never has to know
 * about money.
 */
export function summariseUsage(trace: ReconstructedTrace): Usage {
  let inputTokens = 0;
  let cachedInputTokens = 0;
  let outputTokens = 0;
  let model: string | null = null;
  for (const record of trace.records) {
    if (record.usage === null) continue;
    inputTokens += record.usage.inputTokens;
    cachedInputTokens += record.usage.cachedInputTokens;
    outputTokens += record.usage.outputTokens;
    // The model the turn ran on, so a part priced below is priced as what ran.
    model = effectiveModel(record) ?? model;
  }
  return {
    inputTokens,
    cachedInputTokens,
    outputTokens,
    costUsd: null,
    costBasis: "unavailable",
    model,
    pricesUpdatedAt: null,
  };
}

const tokensOf = (usage: Usage) => usage.inputTokens + usage.cachedInputTokens + usage.outputTokens;

/**
 * A trace's records grouped by the model they ran on (`effectiveModel`, delta
 * 20260918 §4.3), in order of first appearance, each summed and still unpriced.
 * Parts without tokens are dropped. `key` is the model without a provider
 * prefix — `bm-worker/claude-opus-5` and `claude-opus-5` are one model, and the
 * price table accepts both — or `""` when no model is known.
 */
function modelParts(trace: ReconstructedTrace): Array<{ key: string; usage: Usage }> {
  const byModel = new Map<string, TraceRecord[]>();
  for (const record of trace.records) {
    if (record.usage === null) continue;
    const model = effectiveModel(record) ?? "";
    const key = model.slice(model.lastIndexOf("/") + 1);
    byModel.set(key, [...(byModel.get(key) ?? []), record]);
  }
  return [...byModel.entries()]
    .map(([key, records]) => ({ key, usage: summariseUsage({ ...trace, records }) }))
    .filter((part) => tokensOf(part.usage) > 0);
}

/**
 * Tokens and cost of a trace per model it ran on (delta 20260918 §4.3,
 * REQ-058d): the same parts `usageOfTrace` prices, so the lines add up to its
 * total. A model without a price keeps `costUsd: null` and shows tokens only.
 */
export function usageByModelOf(
  trace: ReconstructedTrace,
  price?: (usage: Usage) => Usage,
): Array<{ model: string | null; usage: Usage }> {
  return modelParts(trace).map((part) => {
    const model = part.key === "" ? null : part.key;
    const usage = { ...part.usage, model };
    return { model, usage: price === undefined ? usage : price(usage) };
  });
}

/**
 * Tokens and cost per role and model (delta 20260918 §4.3, REQ-058e): the
 * per-model parts of each role's records, so a role's lines add up to what its
 * agents used and a model is keyed the same way as everywhere else.
 */
export function usageByModelRoleOf(
  trace: ReconstructedTrace,
  price?: (usage: Usage) => Usage,
): Array<{ role: TraceRecord["role"]; model: string | null; usage: Usage }> {
  const roles = [...new Set(trace.records.map((record) => record.role))];
  return roles.flatMap((role) =>
    usageByModelOf({ ...trace, records: trace.records.filter((record) => record.role === role) }, price).map((entry) => ({
      role,
      ...entry,
    })),
  );
}

/**
 * What one agent ran on, turn by turn, folded into one row per distinct
 * combination in order of first appearance (delta 20260918 §4.3). A turn with
 * `runtime` gives a recorded row; one without keeps the model its `usage` knew,
 * and says thinking and mode were not recorded.
 */
export function runtimeRowsOf(trace: ReconstructedTrace, agentId: string): RuntimeRow[] {
  const rows = new Map<string, RuntimeRow>();
  for (const record of trace.records) {
    if (record.agentId !== agentId) continue;
    const runtime = record.runtime ?? null;
    const row: Omit<RuntimeRow, "turns"> =
      runtime === null
        ? { model: record.usage?.model ?? null, thinkingOptionId: null, modeId: null, recorded: false }
        : { model: effectiveModel(record), thinkingOptionId: runtime.thinkingOptionId, modeId: runtime.modeId, recorded: true };
    const key = JSON.stringify([row.model, row.thinkingOptionId, row.modeId, row.recorded]);
    const current = rows.get(key);
    rows.set(key, current === undefined ? { ...row, turns: 1 } : { ...current, turns: current.turns + 1 });
  }
  return [...rows.values()];
}

/**
 * A trace's total usage, priced per model (delta 20260917 §5.4).
 *
 * The total used to price the summed tokens of every agent with one model —
 * the model of the last record — so on 2026-09-16 the Codex Reviewers' tokens
 * were charged as claude-opus-5 and the total ($17.71) did not match the
 * agents ($0.68 + $14.55). Now each model is priced on its own, the money is
 * the sum of the priced parts, and tokens from a model without a price are
 * named in a notice instead of being priced wrongly or hiding the rest.
 */
export function usageOfTrace(
  trace: ReconstructedTrace,
  price?: (usage: Usage) => Usage,
): { usage: Usage; notice: string | null } {
  const parts = modelParts(trace);
  const total = summariseUsage(trace);
  // No tokens at all: nothing to split, so keep the plain result.
  if (parts.length === 0) return { usage: price === undefined ? total : price(total), notice: null };
  const model = parts.length === 1 && parts[0]!.key !== "" ? parts[0]!.key : null;
  if (price === undefined) return { usage: { ...total, model }, notice: null };

  let costUsd: number | null = null;
  let pricesUpdatedAt: string | null = null;
  const unpricedModels: string[] = [];
  let unpricedTokens = 0;
  for (const part of parts) {
    const priced = price(part.usage);
    if (priced.costUsd === null) {
      unpricedModels.push(part.key === "" ? "unknown model" : part.key);
      unpricedTokens += tokensOf(part.usage);
      continue;
    }
    costUsd = (costUsd ?? 0) + priced.costUsd;
    pricesUpdatedAt = pricesUpdatedAt ?? priced.pricesUpdatedAt;
  }
  return {
    usage: {
      ...total,
      model,
      costUsd: costUsd === null ? null : Math.round(costUsd * 10_000) / 10_000,
      costBasis: costUsd === null ? "unavailable" : "estimated",
      pricesUpdatedAt,
    },
    notice:
      unpricedModels.length === 0
        ? null
        : `Cost excludes ${unpricedTokens} tokens from models without a price: ${unpricedModels.join(", ")}.`,
  };
}

/**
 * Tokens of one agent inside a trace, priced per model when a price table is
 * given (an agent can switch models between turns).
 */
export function usageOfAgent(trace: ReconstructedTrace, agentId: string, price?: (usage: Usage) => Usage): Usage {
  return usageOfTrace({ ...trace, records: trace.records.filter((record) => record.agentId === agentId) }, price).usage;
}

const TOKEN_ROLE_ORDER: readonly AgentTokenFigures["role"][] = ["manager", "worker", "reviewer", "orchestrator", "unknown"];

/**
 * Tokens and context per agent (`traces.agents`, autonomy design §G.2 Shown).
 * Every turn of an agent is read with `turnTokensOf` beside its turn before it
 * that had usage, over all of `records` — as the metric module does — so a
 * request's first turn knows the agent's previous one; only the turns in
 * `scope` (all when absent) and of the agents `keep` accepts are counted. An
 * agent with no turn counted is left out. Managers first, then Workers,
 * Reviewers and the rest, each by their first counted turn.
 */
export function agentTokenFiguresOf(
  records: readonly TraceRecord[],
  options: {
    scope?: ReadonlySet<TraceRecord>;
    keep?: (agentId: string) => boolean;
    roleOf?: (agentId: string) => AgentTokenFigures["role"] | undefined;
  } = {},
): AgentTokenFigures[] {
  const byAgent = new Map<string, { figures: AgentTokenFigures; first: string; points: number[] }>();
  const lastWithUsage = new Map<string, TraceRecord>();
  for (const record of [...records].sort(byAt)) {
    const turn = turnTokensOf(record, lastWithUsage.get(record.agentId) ?? null);
    if (record.usage !== null) lastWithUsage.set(record.agentId, record);
    if (options.scope !== undefined && !options.scope.has(record)) continue;
    if (options.keep !== undefined && !options.keep(record.agentId)) continue;
    let entry = byAgent.get(record.agentId);
    if (entry === undefined) {
      entry = {
        figures: {
          agentId: record.agentId,
          role: options.roleOf?.(record.agentId) ?? record.role,
          turns: 0,
          turnsWithUsage: 0,
          tokensRead: 0,
          lastCallTurns: 0,
          contextTrend: [],
          contextTurns: 0,
          contextEstimated: 0,
          contextPeak: null,
          contextMax: null,
          compactions: 0,
        },
        first: record.at,
        points: [],
      };
      byAgent.set(record.agentId, entry);
    }
    const figures = entry.figures;
    figures.turns += 1;
    figures.compactions += record.evidence.filter((evidence) => evidence.kind === "compaction").length;
    if (record.usage?.contextMax !== undefined) figures.contextMax = record.usage.contextMax;
    if (turn.tokensRead !== null) {
      figures.turnsWithUsage += 1;
      figures.tokensRead += turn.tokensRead;
      if (turn.coverage === "last-call") figures.lastCallTurns += 1;
    }
    if (turn.context !== null) {
      figures.contextTurns += 1;
      if (turn.context.basis === "estimated") figures.contextEstimated += 1;
      figures.contextPeak = Math.max(figures.contextPeak ?? 0, turn.context.tokens);
      entry.points.push(turn.context.tokens);
    }
  }
  return [...byAgent.values()]
    .sort((a, b) => TOKEN_ROLE_ORDER.indexOf(a.figures.role) - TOKEN_ROLE_ORDER.indexOf(b.figures.role) || (a.first < b.first ? -1 : a.first > b.first ? 1 : 0))
    .map(({ figures, points }) => ({ ...figures, contextTrend: points.slice(-CONTEXT_TREND_MAX) }));
}
