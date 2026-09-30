/**
 * Insights' server side (autonomy design §A.12, experience concept §4.3):
 * `insights.summary`, the flow and cost figures of `shared/eval-metrics.ts`
 * over the plugin's own data folder.
 *
 * It reads with the replay's reader (`eval-store.ts`): files opened for
 * reading only, no lock, nothing written. Every number comes from
 * `computeEvalMetrics`; this file only picks the window, the workspace, and
 * which figures travel. Numbers only: no message text, no path, no label.
 */
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { insightsSummaryRpc, type InsightsSummary, type InsightsSummaryInput, type InsightsWindow } from "../shared/contracts";
import { computeEvalMetrics, type EvalMetrics, type EvalWindow } from "../shared/eval-metrics";
import { resolveDataHome, type DataHomeDeps } from "./data-home";
import { isReadableFolder, readStore, selectWorkspaces, workspaceDirectoriesOf } from "./eval-store";

export type InsightsRpcDeps = DataHomeDeps & {
  /** The clock the window ends at; `new Date()` by default. */
  now?: () => Date;
  /** Where an unreadable store is reported; `console.warn` by default. */
  log?: (message: string) => void;
};

const DAY_MS = 86_400_000;

/** Days of each window; `all` has no lower bound. */
export const INSIGHTS_WINDOW_DAYS: Readonly<Record<InsightsWindow, number | null>> = {
  "7d": 7,
  "30d": 30,
  "90d": 90,
  all: null,
};

/** The metric window of a key at `now`: `since` N days back, open at the end so nothing just written is cut. */
export function insightsWindowOf(key: InsightsWindow, now: Date): EvalWindow {
  const days = INSIGHTS_WINDOW_DAYS[key];
  return { since: days === null ? null : new Date(now.getTime() - days * DAY_MS).toISOString(), until: null };
}

function homeOf(deps: DataHomeDeps): string | null {
  try {
    return resolveDataHome(deps).home;
  } catch {
    return null;
  }
}

/** The figures Insights shows, taken from one metric set as they are. */
export function insightsSummaryOf(
  key: InsightsWindow,
  metrics: EvalMetrics,
  store: { malformedLines: number; unreadableFiles: number },
  available = true,
): InsightsSummary {
  const { a1, a8, a11, supplementary, unknowns } = metrics;
  return {
    available,
    window: { key, since: metrics.window.since, until: metrics.window.until },
    requests: { ...metrics.requests },
    requestsByDay: Object.entries(supplementary.requestsByDay).map(([day, requests]) => ({ day, requests })),
    questions: {
      asked: a1.finished.asked,
      reachedOwner: a1.finished.reachedOwner,
      answeredByAgents: a1.finished.answeredByAgents,
      perFinishedRequest: a1.perFinishedRequest === null ? null : { ...a1.perFinishedRequest },
    },
    ownerWait: { ...supplementary.ownerWait },
    timeToFinished: { medianMs: a11.medianMs, requests: a11.requests },
    tokens: {
      total: a8.tokens.total,
      byRole: { ...a8.tokens.byRole },
      perFinishedRequest: a8.perFinishedRequest === null ? null : { total: a8.perFinishedRequest.total, byRole: { ...a8.perFinishedRequest.byRole } },
      medianPerFinishedRequest: a8.medianPerFinishedRequest,
      finishedRequestsWithMissingUsage: a8.finishedRequestsWithMissingUsage,
    },
    errors: {
      failedTurns: { total: supplementary.failedTurns.total, byRole: { ...supplementary.failedTurns.byRole } },
      cancelledTurns: { total: supplementary.cancelledTurns.total, byRole: { ...supplementary.cancelledTurns.byRole } },
    },
    turnsByRole: { ...supplementary.turnsByRole },
    unknowns: {
      malformedLines: store.malformedLines,
      unreadableFiles: store.unreadableFiles,
      turnsWithoutUsage: unknowns.turnsWithoutUsage,
      requestsWithoutDuration: unknowns.requestsWithoutDuration,
    },
  };
}

/**
 * `insights.summary`. No usable data folder, or one that cannot be listed,
 * reads as `available: false` with every figure empty — the same shape, so the
 * screen draws dashes instead of failing.
 */
export function handleInsightsSummary(input: InsightsSummaryInput, deps: InsightsRpcDeps = {}): InsightsSummary {
  const window = insightsWindowOf(input.window, (deps.now ?? (() => new Date()))());
  const home = homeOf(deps);
  if (home === null || !isReadableFolder(home)) {
    return insightsSummaryOf(input.window, computeEvalMetrics({ records: [], window }), { malformedLines: 0, unreadableFiles: 0 }, false);
  }
  const store = readStore(home);
  const selection = selectWorkspaces(store, input.workspaceId === undefined ? null : new Set([input.workspaceId]));
  if (store.unknowns.unreadableFiles > 0) {
    (deps.log ?? ((message: string) => console.warn(message)))(
      `[paseo-bm] Insights skipped ${store.unknowns.unreadableFiles} unreadable file(s) of the data folder`,
    );
  }
  const metrics = computeEvalMetrics({
    records: selection.records,
    ...(selection.proposals === undefined ? {} : { proposals: selection.proposals }),
    ...(selection.stalls === undefined ? {} : { stalls: selection.stalls }),
    ...(selection.notes === undefined ? {} : { notes: selection.notes }),
    ...(selection.decisions === undefined ? {} : { decisions: selection.decisions }),
    ...(selection.wakes === undefined ? {} : { wakes: selection.wakes }),
    window,
    workspaceDirectories: workspaceDirectoriesOf(store),
  });
  return insightsSummaryOf(input.window, metrics, store.unknowns);
}

export function registerInsightsRpcs(server: PluginServerContext, deps: InsightsRpcDeps = {}): void {
  server.handle(insightsSummaryRpc, (input) => handleInsightsSummary(input, deps));
}
