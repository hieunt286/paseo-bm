/**
 * Everything the Dashboard shows and decides, without a renderer
 * (WP-211.1; Dashboard Design §2.1, REQ-041 → REQ-057).
 *
 * Same split as `launch-manager.ts`: this file holds the logic, the wording and
 * the styles, so all of it is testable without React, and `dashboard.tsx` only
 * arranges components. No React, no React Native, no JSX, no `server/` import.
 *
 * The wording rules are part of the product, not decoration:
 *
 * - every derived number says how sure it is (`exact` / `inferred` / `unknown`);
 * - a cost says whether it came from the tool or from the bundled price table,
 *   with the date of that table;
 * - a duration is labelled wall-clock, using the sentence the server sends;
 * - a destructive action always states what will be lost and defaults to "No".
 */
import type { PluginTheme } from "@getpaseo/plugin";
import type {
  BeadStats,
  Confidence,
  StoreSize,
  TraceDeleteScope,
  RuntimeRow,
  TraceDetail,
  TraceSummary,
  Usage,
  WorkflowStepResult,
  WorkspaceState,
} from "../shared/contracts";

/** Icon of the Dashboard (REQ-040a: same surface as the launcher). */
export const DASHBOARD_ICON = "LayoutDashboard";

/**
 * Told to the user once per screen, because a screenshot of this Dashboard
 * contains agent conversation (REQ-048d).
 */
export const PRIVACY_NOTICE =
  "This screen shows agent conversation that paseo-bm stores on this machine. You can delete it at any time from the Storage section.";

/** Said next to the machine-wide threshold, since Paseo has no per-workspace settings (REQ-055e). */
export const HOST_SCOPE_NOTICE = "This threshold applies to every workspace on this machine.";

// ---------------------------------------------------------------------------
// Formatting.
// ---------------------------------------------------------------------------

/** `null` becomes an em dash, never `0` (REQ-043d). */
export function formatDuration(ms: number | null): string {
  if (ms === null) return "—";
  if (ms < 1000) return `${ms} ms`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const restSeconds = seconds % 60;
  if (minutes < 60) return restSeconds === 0 ? `${minutes}m` : `${minutes}m ${restSeconds}s`;
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  return restMinutes === 0 ? `${hours}h` : `${hours}h ${restMinutes}m`;
}

/** Elapsed time of something still running, from a start timestamp. */
export function formatElapsed(startedAt: string | null, now: Date): string {
  if (startedAt === null) return "—";
  const start = Date.parse(startedAt);
  if (Number.isNaN(start)) return "—";
  return `${formatDuration(Math.max(0, now.getTime() - start))} so far`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

export function formatTokens(tokens: number): string {
  if (tokens < 1000) return String(tokens);
  if (tokens < 1_000_000) return `${(tokens / 1000).toFixed(tokens < 10_000 ? 1 : 0)}k`;
  return `${(tokens / 1_000_000).toFixed(1)}M`;
}

/**
 * Cost with its basis. An estimate always carries the word "estimated" and the
 * date of the price table; an unknown model shows no money at all (REQ-052).
 */
export function formatCost(usage: Usage): string {
  if (usage.costBasis === "unavailable" || usage.costUsd === null) return "cost unavailable";
  const amount = usage.costUsd < 0.01 ? `$${usage.costUsd.toFixed(4)}` : `$${usage.costUsd.toFixed(2)}`;
  if (usage.costBasis === "provider") return `${amount} (reported by the tool)`;
  return `${amount} (estimated, prices of ${usage.pricesUpdatedAt ?? "unknown date"})`;
}

/** Tokens broken out, so a cache-heavy run is visible rather than hidden in a total. */
export function formatUsage(usage: Usage): string {
  return `${formatTokens(usage.inputTokens)} in · ${formatTokens(usage.cachedInputTokens)} cached · ${formatTokens(usage.outputTokens)} out`;
}

// ---------------------------------------------------------------------------
// Labels.
// ---------------------------------------------------------------------------

/**
 * `plain` is the text colour itself: it says "read me" without a hue, and it is
 * what everywhere a bead shows uses since delta 20260925 §3.2 — four hues on a
 * list of beads were tiring to read.
 */
export type Tone = "muted" | "plain" | "info" | "warning" | "danger" | "success";

export interface Badge {
  text: string;
  tone: Tone;
}

export function stateBadge(state: TraceSummary["state"]): Badge {
  switch (state) {
    case "running":
      return { text: "Running", tone: "info" };
    case "waiting_user":
      return { text: "Waiting for you", tone: "warning" };
    case "completed":
      return { text: "Completed", tone: "success" };
    case "stopped":
      return { text: "Stopped", tone: "muted" };
    case "failed":
      return { text: "Failed", tone: "danger" };
    case "unknown":
      return { text: "Unknown", tone: "muted" };
  }
}

/** How the row was linked to its agents. `exact` is not shown: it is the norm. */
export function linkingBadge(linking: Confidence): Badge | null {
  switch (linking) {
    case "exact":
      return null;
    case "inferred":
      return { text: "Linked by time", tone: "warning" };
    case "unknown":
      return { text: "Not linked to a request", tone: "warning" };
  }
}

export function confidenceSuffix(confidence: Confidence): string {
  switch (confidence) {
    case "exact":
      return "";
    case "inferred":
      return " (inferred)";
    case "unknown":
      return " (unknown)";
  }
}

export function workspaceStateBadge(state: WorkspaceState): Badge | null {
  switch (state) {
    case "live":
      return null;
    case "archived":
      return { text: "Archived workspace", tone: "muted" };
    case "orphaned":
      return { text: "Workspace no longer in Paseo", tone: "warning" };
    case "unknown":
      return { text: "Workspace state unknown", tone: "muted" };
  }
}

/** Human names of the twelve steps, in the order the server returns them. */
export const STEP_LABELS: Readonly<Record<WorkflowStepResult["step"], string>> = {
  classify_tier: "Size classified",
  prd: "PRD",
  design: "Technical design",
  adr: "ADR",
  plan: "Implementation plan",
  review_plan: "Plan reviewed",
  convert_to_beads: "Converted to beads",
  polish_beads: "Beads polished",
  implement: "Implemented",
  review_batches: "Reviewed",
  build_and_tests: "Build and tests",
  close_with_evidence: "Closed with evidence",
};

/** One line summarising a bead count, with its confidence spelled out. */
export function beadCountLine(counts: TraceSummary["beadCounts"]): string {
  const part = (label: string, entry: { count: number; confidence: Confidence }) =>
    `${entry.count} ${label}${confidenceSuffix(entry.confidence)}`;
  return [
    part("created", counts.created),
    part("updated", counts.updated),
    part("closed", counts.closed),
  ].join(" · ");
}

/**
 * The claim the UI is allowed to make about beads.
 *
 * "No beads" may only be said on an `exact` empty count — anything else is
 * "not known" (REQ-044c).
 */
export function beadClaim(counts: TraceSummary["beadCounts"]): string {
  const { created } = counts;
  if (created.count > 0) return beadCountLine(counts);
  if (created.confidence === "exact") return "No beads were created for this request";
  return "Whether this request created beads is not known";
}

/**
 * Row title. A trace can exist without its request text — collection starts
 * when the plugin loads, so a request already in flight has no user turn on
 * record — and the screen has to say that instead of showing a blank line.
 */
export function excerptLine(excerpt: string | null): string {
  if (excerpt === null) return "Request text not recorded (this request started before the Dashboard did)";
  return excerpt.trim() === "" ? "(empty request)" : excerpt;
}

/** Reviewer agents and review calls are different numbers and are shown as such (REQ-042b). */
export function reviewerLine(trace: TraceSummary): string {
  const agents = `${trace.reviewerIds.length} reviewer${trace.reviewerIds.length === 1 ? "" : "s"}`;
  const calls = trace.reviewCalls === null ? "review calls unknown" : `${trace.reviewCalls} review call${trace.reviewCalls === 1 ? "" : "s"}`;
  const claimed = trace.guardrailReported?.total;
  const selfReported = claimed === undefined || claimed === null ? "" : ` · worker reported ${claimed}`;
  return `${agents} · ${calls}${selfReported}`;
}

/** True when the observed call count and the Worker's own count disagree (REQ-042c). */
export function guardrailMismatch(trace: TraceSummary): boolean {
  const claimed = trace.guardrailReported?.total;
  if (claimed === undefined || claimed === null || trace.reviewCalls === null) return false;
  return claimed !== trace.reviewCalls;
}

// ---------------------------------------------------------------------------
// Bead statistics and storage.
// ---------------------------------------------------------------------------

export interface StorageView {
  summary: string;
  warning: Badge | null;
}

/**
 * Storage line plus the warning, compared against the host-scoped threshold.
 *
 * The comparison lives here, in the client, because Paseo's settings RPCs are
 * client-facing; the server only reports bytes (design §3.6).
 */
export function storageView(store: StoreSize, warnAboveBytes: number): StorageView {
  // Bytes only, deliberately. `measureStore` counts deletable units, which is
  // not the number of rows the list shows: several unlinked agents collapse
  // into one "could not be linked" group. Printing that count next to a list
  // the user can count themselves produced two different numbers for the same
  // workspace during the WP-214 acceptance run, so the count now lives only
  // where it is exact — the delete preview, which counts what it will delete.
  const summary = `${formatBytes(store.workspaceBytes)} of traces here · ${formatBytes(store.bytes)} in total`;
  if (store.bytes > warnAboveBytes) {
    return {
      summary,
      warning: {
        text: `The trace store is over ${formatBytes(warnAboveBytes)}. Delete traces you no longer need. ${HOST_SCOPE_NOTICE}`,
        tone: "warning",
      },
    };
  }
  return { summary, warning: null };
}

// ---------------------------------------------------------------------------
// Grouping.
// ---------------------------------------------------------------------------

export interface TraceGroup {
  key: WorkspaceState;
  title: string;
  hint: string | null;
  traces: TraceSummary[];
}

/**
 * Splits rows into the groups design §3.7 defines. An orphaned workspace gets
 * the hint that its traces can be reassigned — that is the only way a user
 * finds the feature.
 */
export function groupTraces(traces: readonly TraceSummary[]): TraceGroup[] {
  const order: WorkspaceState[] = ["live", "archived", "orphaned", "unknown"];
  const titles: Record<WorkspaceState, string> = {
    live: "Requests",
    archived: "Archived workspace",
    orphaned: "Workspaces no longer in Paseo",
    unknown: "Workspace state unknown",
  };
  const hints: Record<WorkspaceState, string | null> = {
    live: null,
    archived: "This workspace is archived in Paseo. Its history is kept.",
    orphaned:
      "Paseo no longer lists this workspace. You can reassign these traces onto a workspace that exists, or delete them.",
    unknown: "Paseo's workspace list could not be read, so these traces are shown without a state.",
  };
  return order
    .map((key) => ({
      key,
      title: titles[key],
      hint: hints[key],
      traces: traces.filter((trace) => trace.workspaceState === key),
    }))
    .filter((group) => group.traces.length > 0);
}

// ---------------------------------------------------------------------------
// Destructive actions.
// ---------------------------------------------------------------------------

export type DeleteScope = TraceDeleteScope;

/** How far back the "delete older than" shortcut reaches. */
export const OLDER_THAN_DAYS = 30;

/** Cut-off timestamp for that shortcut, in UTC. */
export function olderThanCutoff(now: Date, days: number = OLDER_THAN_DAYS): string {
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
}

export interface PendingDelete {
  kind: "delete";
  scope: DeleteScope;
  /** What the dry run said would be lost. */
  preview: { traces: number; bytes: number };
  /** Requests in scope that still have a running agent, from the dry run. */
  running: number;
}

export interface PendingReassign {
  kind: "reassign";
  fromWorkspaceId: string;
  toWorkspaceId: string;
  preview: { traces: number; bytes: number };
}

export type PendingAction = PendingDelete | PendingReassign;

/** Wording of the confirmation. Always names what is lost, never just "are you sure". */
export function describeAction(action: PendingAction): { title: string; body: string[]; confirmLabel: string } {
  if (action.kind === "reassign") {
    return {
      title: "Reassign these traces?",
      body: [
        `${action.preview.traces} trace(s) (${formatBytes(action.preview.bytes)}) move from ${action.fromWorkspaceId} to ${action.toWorkspaceId}.`,
        "The traces keep the workspace they were recorded under; only where they are grouped changes.",
        "Nothing else on this machine is touched.",
      ],
      confirmLabel: "Reassign",
    };
  }

  const what =
    "traceId" in action.scope
      ? "this one request"
      : "before" in action.scope
        ? `every trace recorded before ${action.scope.before}`
        : "every trace of this workspace";
  const body = [
    `${action.preview.traces} trace(s) (${formatBytes(action.preview.bytes)}) will be deleted: ${what}.`,
    "This cannot be undone.",
    "Beads, documents, agents and Paseo conversations are not affected — only paseo-bm's own recording.",
  ];
  if (action.running > 0) {
    body.push(
      `${action.running} of them still have a running turn. What happens after this point will be recorded as a new trace.`,
    );
  }
  return { title: "Delete these traces?", body, confirmLabel: "Delete" };
}

/**
 * Confirmation gate for destructive actions.
 *
 * `confirm()` only does something when an action is pending, and nothing is
 * pending until `request()` was called with a dry-run result — which is what
 * makes "No" the default: the destructive call cannot be reached without a
 * preview first (REQ-054b).
 */
export interface ConfirmationGate {
  getPending(): PendingAction | null;
  subscribe(listener: () => void): () => void;
  request(action: PendingAction): void;
  cancel(): void;
  /** Hands the pending action to `run`, then clears it. No-ops when nothing is pending. */
  confirm<T>(run: (action: PendingAction) => Promise<T>): Promise<T | null>;
}

export function createConfirmationGate(): ConfirmationGate {
  let pending: PendingAction | null = null;
  const listeners = new Set<() => void>();
  const emit = () => {
    for (const listener of listeners) listener();
  };
  return {
    getPending: () => pending,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    request(action) {
      pending = action;
      emit();
    },
    cancel() {
      pending = null;
      emit();
    },
    async confirm(run) {
      const action = pending;
      if (action === null) return null;
      try {
        return await run(action);
      } finally {
        pending = null;
        emit();
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Overview: cards and charts (owner feedback after WP-214).
// ---------------------------------------------------------------------------

export interface OverviewCard {
  label: string;
  value: string;
  hint: string;
}

/**
 * How many times the requests on screen went wrong, whatever the reason
 * (REQ-069 g, delta 20260925 §3.5).
 *
 * `requests` counts requests by `traceId`, not rows: since delta 20260917e a
 * request that was followed up has one row per question, and "3 requests failed"
 * must not mean "3 questions of the same request". The three kinds are disjoint
 * by construction on the server (§3.4), so `total` is a count of failures.
 */
export interface ErrorTally {
  total: number;
  requests: number;
  failedTurns: number;
  agentErrors: number;
  fallbacks: number;
}

export function errorTally(traces: readonly TraceSummary[]): ErrorTally {
  const failing = new Set<string>();
  const tally: ErrorTally = { total: 0, requests: 0, failedTurns: 0, agentErrors: 0, fallbacks: 0 };
  for (const trace of traces) {
    // A row from a server built before the field says nothing, which is not the
    // same as saying zero — but there is nothing else to count, so it adds none.
    const errors = trace.errors;
    if (errors === undefined) continue;
    const sum = errors.failedTurns + errors.agentErrors + errors.fallbacks;
    if (sum === 0) continue;
    tally.failedTurns += errors.failedTurns;
    tally.agentErrors += errors.agentErrors;
    tally.fallbacks += errors.fallbacks;
    tally.total += sum;
    failing.add(trace.traceId);
  }
  return { ...tally, requests: failing.size };
}

/** English plural without a library: `1 request`, `2 requests`. */
function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/**
 * The "Errors" card. The hint says "request(s) with an error" on purpose: the
 * "Requests" card beside it counts rows, and two numbers in one row of cards
 * must not mean two different things by the same word.
 */
export function errorCard(tally: ErrorTally): OverviewCard {
  if (tally.total === 0) return { label: "Errors", value: "0", hint: "no error recorded" };
  const parts = [
    `${plural(tally.requests, "request")} with an error`,
    ...(tally.failedTurns === 0 ? [] : [plural(tally.failedTurns, "failed turn")]),
    ...(tally.agentErrors === 0 ? [] : [plural(tally.agentErrors, "agent error")]),
    ...(tally.fallbacks === 0 ? [] : [plural(tally.fallbacks, "provider fallback")]),
  ];
  return { label: "Errors", value: String(tally.total), hint: parts.join(" · ") };
}

/** Seven numbers that answer "what is going on here" at a glance. */
export function overviewCards(traces: readonly TraceSummary[], stats: BeadStats | null): OverviewCard[] {
  const count = (state: TraceSummary["state"]) => traces.filter((trace) => trace.state === state).length;
  const workers = new Set(traces.flatMap((trace) => trace.workerIds)).size;
  const reviewers = new Set(traces.flatMap((trace) => trace.reviewerIds)).size;
  const input = traces.reduce((sum, trace) => sum + trace.usage.inputTokens, 0);
  const cached = traces.reduce((sum, trace) => sum + trace.usage.cachedInputTokens, 0);
  const output = traces.reduce((sum, trace) => sum + trace.usage.outputTokens, 0);
  const priced = traces.filter((trace) => trace.usage.costUsd !== null);
  const cost = priced.reduce((sum, trace) => sum + (trace.usage.costUsd ?? 0), 0);
  const unpriced = traces.length - priced.length;

  const beads: OverviewCard =
    stats === null
      ? { label: "Beads", value: "…", hint: "loading" }
      : !stats.present
        ? { label: "Beads", value: "—", hint: "no .beads/ in this workspace" }
        : {
            label: "Beads",
            value: String(stats.total),
            hint: `${stats.inProgress} in progress · ${stats.open} not started · ${stats.closed} done`,
          };

  return [
    {
      label: "Requests",
      value: String(traces.length),
      hint: `${count("running")} running · ${count("waiting_user")} waiting · ${count("completed")} done`,
    },
    // Right after the request count, because it is read together with it.
    errorCard(errorTally(traces)),
    beads,
    { label: "Agents", value: String(workers + reviewers), hint: `${workers} workers · ${reviewers} reviewers` },
    {
      label: "Messages",
      value: String(traces.reduce((sum, trace) => sum + trace.messageCount, 0)),
      hint: "sent and received",
    },
    {
      label: "Tokens",
      value: formatTokens(input + cached + output),
      hint: `${formatTokens(input)} in · ${formatTokens(cached)} cached · ${formatTokens(output)} out`,
    },
    {
      label: "Cost",
      value: priced.length === 0 ? "—" : `$${cost.toFixed(2)}`,
      hint: unpriced === 0 ? "estimated" : `estimated · ${unpriced} request(s) unpriced`,
    },
  ];
}

export interface Bar {
  label: string;
  value: number;
  display: string;
  /** Opened when the bar is pressed. */
  agentId?: string;
  /** Second line under the label. */
  hint?: string;
}

/**
 * How a row says which turn of its request it is.
 *
 * Empty for a request nobody followed up, so those rows read exactly as they
 * always did — a lone "turn 1 of 1" would be noise on the majority of rows.
 */
export function turnLabel(turn: TraceSummary["turn"]): string {
  return turn === null ? "" : `turn ${turn.index} of ${turn.total} · `;
}

/**
 * Requests per day for the last `days` days, oldest first.
 *
 * Counts REQUESTS, not rows (owner decision Q27). Since delta 20260917e the
 * list carries one row per question asked, so a single request that went back
 * and forth ten times would otherwise read as ten requests and the day-to-day
 * comparison this chart exists for would be meaningless. Only the row that
 * opens a request is counted.
 */
export function requestsPerDay(traces: readonly TraceSummary[], now: Date, days = 7): Bar[] {
  const opening = traces.filter((trace) => trace.turn === null || trace.turn.index === 1);
  const bars: Bar[] = [];
  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const day = new Date(now.getTime() - offset * 86_400_000).toISOString().slice(0, 10);
    const value = opening.filter((trace) => trace.requestedAt.slice(0, 10) === day).length;
    bars.push({ label: day.slice(5), value, display: String(value) });
  }
  return bars;
}

/** The Workers that used the most tokens, across the listed requests. */
/**
 * Tokens and cost per model and role, over the same rows the overview cards
 * count (delta 20260918 §4.4, REQ-058e): which model each role actually runs
 * on, and what it costs. A model without a price shows tokens only; an unknown
 * model keeps its bar instead of vanishing from the total.
 */
export function tokensByModelRole(traces: readonly TraceSummary[]): Bar[] {
  const byPair = new Map<string, { label: string; tokens: number; cost: number | null }>();
  for (const trace of traces) {
    for (const entry of trace.usageByModelRole ?? []) {
      const label = `${entry.model ?? "unknown model"} · ${entry.role}`;
      const tokens = entry.usage.inputTokens + entry.usage.cachedInputTokens + entry.usage.outputTokens;
      const current = byPair.get(label);
      const cost = entry.usage.costUsd;
      byPair.set(label, {
        label,
        tokens: (current?.tokens ?? 0) + tokens,
        cost: cost === null ? (current?.cost ?? null) : (current?.cost ?? 0) + cost,
      });
    }
  }
  return [...byPair.values()]
    .filter((pair) => pair.tokens > 0)
    .sort((a, b) => b.tokens - a.tokens)
    .map((pair) => ({
      label: pair.label,
      value: pair.tokens,
      display: `${formatTokens(pair.tokens)}${pair.cost === null ? "" : ` · $${pair.cost.toFixed(2)}`}`,
    }));
}

export function heaviestWorkers(traces: readonly TraceSummary[], limit = 5): Bar[] {
  const byWorker = new Map<string, { title: string | null; tokens: number; cost: number | null; request: string }>();
  for (const trace of traces) {
    for (const worker of trace.workerUsage) {
      const tokens = worker.usage.inputTokens + worker.usage.cachedInputTokens + worker.usage.outputTokens;
      const current = byWorker.get(worker.agentId);
      const cost = worker.usage.costUsd;
      byWorker.set(worker.agentId, {
        title: current?.title ?? worker.title,
        tokens: (current?.tokens ?? 0) + tokens,
        cost: cost === null ? (current?.cost ?? null) : (current?.cost ?? 0) + cost,
        request: current?.request ?? shorten(excerptLine(trace.excerpt), 40),
      });
    }
  }
  return [...byWorker.entries()]
    .filter(([, worker]) => worker.tokens > 0)
    .sort((a, b) => b[1].tokens - a[1].tokens)
    .slice(0, limit)
    .map(([agentId, worker]) => ({
      agentId,
      label: shorten(worker.title ?? `Worker ${agentId.slice(0, 8)}`, 36),
      hint: worker.request,
      value: worker.tokens,
      display: `${formatTokens(worker.tokens)}${worker.cost === null ? "" : ` · $${worker.cost.toFixed(2)}`}`,
    }));
}

/** Bar width as a share of the largest value, 0..1. */
export function barShare(bar: Bar, bars: readonly Bar[]): number {
  const max = Math.max(0, ...bars.map((entry) => entry.value));
  return max === 0 ? 0 : bar.value / max;
}

// ---------------------------------------------------------------------------
// Request graph: Request → Workers → Reviewers, each node expandable.
// ---------------------------------------------------------------------------

export type GraphNodeKind = "request" | "worker" | "reviewer";

export interface ChipGroup {
  label: string;
  chips: Badge[];
  /** One line under the chips, e.g. what the colours mean. */
  note?: string;
}

/**
 * One workflow step as a coloured chip: green = done (a report said so),
 * blue = done (inferred from commands), grey = not needed for this size,
 * amber = unknown (nothing seen either way).
 */
export function stepChip(row: WorkflowStepResult): Badge {
  const label = STEP_LABELS[row.step];
  if (row.status === "done") {
    return row.confidence === "exact" ? { text: `✓ ${label}`, tone: "success" } : { text: `✓ ${label} ~`, tone: "info" };
  }
  if (row.status === "skipped") return { text: `– ${label}`, tone: "muted" };
  return { text: `? ${label}`, tone: "warning" };
}

export const STEP_LEGEND = "green done · blue done (inferred) · grey not needed · amber unknown";

function skillChips(skills: readonly string[]): Badge[] {
  return skills.map((skill) => ({ text: skill, tone: "info" as const }));
}

/**
 * How each agent is drawn on the graph: a small Lucide icon on a soft tint of
 * one theme colour. The request node stands for the Manager, which handled it.
 * The shape tells the role apart even where the colours look alike.
 */
export const ROLE_MARK: Readonly<Record<GraphNode["kind"], { role: string; icon: string; tone: Tone; does: string }>> = {
  request: { role: "Manager", icon: "BotMessageSquare", tone: "info", does: "takes the request, delegates" },
  worker: { role: "Worker", icon: "Hammer", tone: "success", does: "docs, beads and code" },
  reviewer: { role: "Reviewer", icon: "ScanEye", tone: "warning", does: "reviews each batch" },
};

export interface GraphNode {
  id: string;
  kind: GraphNodeKind;
  /** 0 for the request, 1 for workers, 2 for reviewers under their worker. */
  depth: number;
  title: string;
  subtitle: string;
  badge: Badge;
  /** Shown when the node is expanded; empty until the detail is loaded. */
  details: string[];
  /** Chip rows shown with the details. */
  chipGroups: ChipGroup[];
  /** Agent to open from the node, when it is an agent. */
  agentId: string | null;
}

export function shorten(text: string, max: number): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length <= max ? line : `${line.slice(0, max - 1)}…`;
}

const shortId = (id: string) => id.slice(0, 8);

function timeOf(ms: number | null, startedAt: string | null, now: Date): string {
  return ms === null ? formatElapsed(startedAt, now) : formatDuration(ms);
}

function usageLine(usage: Usage): string {
  return `${formatUsage(usage)} · ${formatCost(usage)}`;
}

const turnsText = (turns: number) => `${turns} turn${turns === 1 ? "" : "s"}`;

/**
 * One `Model: …` line per combination an agent ran on (delta 20260918 §4.4,
 * REQ-058 a–c). A turn written before the collector recorded thinking and mode
 * says so instead of guessing; a recorded `null` thinking option is the
 * provider's default, which is a different thing.
 */
export function runtimeLines(rows: readonly RuntimeRow[] | undefined): string[] {
  return (rows ?? []).map((row) => {
    if (!row.recorded) {
      return row.model === null
        ? `Model: not recorded · ${turnsText(row.turns)}`
        : `Model: ${row.model} · thinking/mode: not recorded · ${turnsText(row.turns)}`;
    }
    return `Model: ${row.model ?? "not recorded"} · thinking: ${row.thinkingOptionId ?? "provider default"} · mode: ${row.modeId ?? "unknown"} · ${turnsText(row.turns)}`;
  });
}

/** The agent's model when it ran on exactly one known model, for a node's subtitle. */
export function singleModelOf(rows: readonly RuntimeRow[] | undefined): string | null {
  const models = new Set((rows ?? []).map((row) => row.model).filter((model): model is string => model !== null));
  return models.size === 1 ? [...models][0]! : null;
}

/** `Tokens by model: …` for a request; a model without a price shows tokens only (REQ-058d). */
export function tokensByModelLine(entries: TraceDetail["usageByModel"]): string | null {
  if (entries === undefined || entries.length === 0) return null;
  const parts = entries.map(({ model, usage }) => {
    const tokens = `${formatTokens(usage.inputTokens + usage.cachedInputTokens + usage.outputTokens)} tokens`;
    return `${model ?? "unknown model"} ${tokens}${usage.costUsd === null ? "" : ` · ${formatCost(usage)}`}`;
  });
  return `Tokens by model: ${parts.join(" · ")}`;
}

/**
 * The nodes of one request, in display order. Reviewers sit under the Worker
 * when the request has exactly one (the normal case); with several Workers the
 * trace does not say which Worker a Reviewer served, so they sit under the
 * request instead of being attached on a guess.
 */
export function requestGraph(summary: TraceSummary, detail: TraceDetail | null, now: Date): GraphNode[] {
  const usageOf = (agentId: string) => detail?.usageByAgent.find((entry) => entry.agentId === agentId)?.usage;
  const runtimeOf = (agentId: string) => detail?.usageByAgent.find((entry) => entry.agentId === agentId)?.runtime;
  /** What the user typed to this agent. */
  const agentLines = (agentId: string): string[] => {
    if (detail === null) return [];
    const lines: string[] = [];
    for (const message of detail.userMessages.filter((entry) => entry.agentId === agentId)) {
      lines.push(`💬 You → ${shortId(agentId)} (${message.at.slice(11, 19)}): ${shorten(message.text, 300)}`);
    }
    return lines;
  };
  const duration =
    summary.state === "running" ? formatElapsed(summary.requestedAt, now) : formatDuration(summary.durationMs);

  const requestDetails: string[] = [];
  if (detail !== null) {
    requestDetails.push(
      `Asked: ${detail.sent.userRequest === null ? "not recorded" : shorten(detail.sent.userRequest.text, 400)}`,
    );
    const reply = detail.received.managerReplies.at(-1);
    if (reply !== undefined) requestDetails.push(`Answer: ${shorten(reply.text, 400)}`);
    requestDetails.push(`Time: ${duration} (wall clock, includes waiting for you)`);
    requestDetails.push(`Tokens: ${usageLine(summary.usage)}`);
    const byModel = tokensByModelLine(detail.usageByModel);
    if (byModel !== null) requestDetails.push(byModel);
    // The Manager has no node of its own, so what it ran on is listed here.
    for (const entry of detail.usageByAgent.filter((agent) => agent.role === "manager")) {
      for (const line of runtimeLines(entry.runtime)) requestDetails.push(`Manager ${shortId(entry.agentId)} — ${line}`);
    }
    requestDetails.push(`Beads: ${beadClaim(summary.beadCounts)}`);
    for (const bead of detail.beads.filter((entry) => entry.action === "created" || entry.action === "closed")) {
      requestDetails.push(`  ${bead.id} ${bead.action} · now ${bead.statusNow ?? "not in store"}${bead.title === null ? "" : ` · ${shorten(bead.title, 60)}`}`);
    }
    // The Manager is not a node of its own, so what the user told it lives here.
    const managers = new Set(detail.usageByAgent.filter((entry) => entry.role === "manager").map((entry) => entry.agentId));
    for (const message of detail.userMessages.filter((entry) => entry.agentId !== null && managers.has(entry.agentId))) {
      requestDetails.push(`💬 You → Manager (${message.at.slice(11, 19)}): ${shorten(message.text, 300)}`);
    }
    for (const badge of [linkingBadge(summary.linking), workspaceStateBadge(summary.workspaceState)]) {
      if (badge !== null) requestDetails.push(`Note: ${badge.text}`);
    }
    if (guardrailMismatch(summary)) requestDetails.push(`Note: review counts disagree (${reviewerLine(summary)})`);
    for (const notice of summary.notices) requestDetails.push(`Note: ${notice}`);
  }

  // The opened detail also reads agents' own timelines, so it can know more.
  const fromYou = Math.max(summary.userMessageCount, detail?.userMessages.length ?? 0);
  const requestChips: ChipGroup[] = [];
  if (detail !== null && detail.workflowSteps.length > 0) {
    requestChips.push({ label: "Workflow steps", chips: detail.workflowSteps.map(stepChip), note: STEP_LEGEND });
  }
  const allSkills = [...new Set(detail?.skills.map((entry) => entry.skill) ?? [])];
  if (allSkills.length > 0) requestChips.push({ label: "Skills used", chips: skillChips(allSkills) });
  const agentChips = (agentId: string): ChipGroup[] => {
    const skills = detail?.skills.filter((entry) => entry.agentId === agentId).map((entry) => entry.skill) ?? [];
    return skills.length === 0 ? [] : [{ label: "Skills loaded", chips: skillChips(skills) }];
  };

  const nodes: GraphNode[] = [
    {
      // Rows of one request share a `traceId`, so the turn has to be part of
      // the node id or two rows collide (delta 20260917e §4.3).
      id: `request:${summary.traceId}${summary.turn === null ? "" : `#${summary.turn.index}`}`,
      kind: "request",
      depth: 0,
      title: shorten(excerptLine(summary.excerpt), 90),
      subtitle: `${turnLabel(summary.turn)}${summary.tier ?? "size ?"} · ${duration} · ${formatTokens(summary.usage.inputTokens + summary.usage.cachedInputTokens + summary.usage.outputTokens)} tokens · ${formatCost(summary.usage)}${fromYou > 0 ? ` · 💬 ${fromYou} from you` : ""}`,
      badge: stateBadge(summary.state),
      details: requestDetails,
      chipGroups: requestChips,
      agentId: null,
    },
  ];

  const reviewerNode = (agentId: string, depth: number): GraphNode => {
    const timing = detail?.timing.reviewers.find((entry) => entry.agentId === agentId);
    const request = detail?.sent.reviewRequests.find((entry) => entry.agentId === agentId);
    const review = detail?.received.reviews.filter((entry) => entry.agentId === agentId).at(-1);
    const batch = request?.batchId ?? review?.batchId ?? null;
    const verdict = review?.verdict ?? null;
    const usage = usageOf(agentId);
    const details: string[] = [];
    if (detail !== null) {
      if (request !== undefined) details.push(`Asked to review: ${shorten(request.text, 300)}`);
      details.push(...agentLines(agentId));
      details.push(`Verdict: ${verdict ?? "none recorded"}${review?.blockingCount != null ? ` · ${review.blockingCount} blocking` : ""}`);
      if (timing !== undefined) details.push(`Time: ${timeOf(timing.ms, timing.startedAt, now)}`);
      if (usage !== undefined) details.push(`Tokens: ${usageLine(usage)}`);
      details.push(...runtimeLines(runtimeOf(agentId)));
    }
    const reviewerModel = singleModelOf(runtimeOf(agentId));
    return {
      id: `reviewer:${agentId}`,
      kind: "reviewer",
      depth,
      title: `Reviewer ${shortId(agentId)}${batch === null ? "" : ` · batch ${batch}`}`,
      subtitle: `${timing === undefined ? "reviewer" : timeOf(timing.ms, timing.startedAt, now)}${reviewerModel === null ? "" : ` · ${reviewerModel}`}`,
      badge:
        verdict === null
          ? { text: "No verdict", tone: "muted" }
          : { text: verdict, tone: /pass|approved/i.test(verdict) ? "success" : "warning" },
      details,
      chipGroups: agentChips(agentId),
      agentId,
    };
  };

  const single = summary.workerIds.length === 1;
  for (const workerId of summary.workerIds) {
    const timing = detail?.timing.workers.find((entry) => entry.agentId === workerId);
    const reports = detail?.received.reports.filter((report) => report.agentId === workerId) ?? [];
    const last = reports.at(-1);
    const usage = usageOf(workerId);
    const details: string[] = [];
    if (detail !== null) {
      const files = [...new Set(reports.flatMap((report) => report.filesChanged))];
      details.push(`Last report: ${last?.phase ?? "none"}`);
      details.push(`Files changed: ${files.length === 0 ? "none reported" : files.join(", ")}`);
      if (last?.buildAndTests != null) details.push(`Checks: ${shorten(last.buildAndTests, 200)}`);
      if (last?.blockers != null) details.push(`Open points: ${shorten(last.blockers, 300)}`);
      if (timing !== undefined) details.push(`Time: ${timeOf(timing.ms, timing.startedAt, now)}`);
      if (usage !== undefined) details.push(`Tokens: ${usageLine(usage)}`);
      details.push(...runtimeLines(runtimeOf(workerId)));
      details.push(...agentLines(workerId));
    }
    const fromUser = detail?.userMessages.filter((entry) => entry.agentId === workerId).length ?? 0;
    const workerModel = singleModelOf(runtimeOf(workerId));
    nodes.push({
      id: `worker:${workerId}`,
      kind: "worker",
      depth: 1,
      title: `Worker ${shortId(workerId)}`,
      subtitle: `${reviewerLine(summary)}${timing === undefined ? "" : ` · ${timeOf(timing.ms, timing.startedAt, now)}`}${workerModel === null ? "" : ` · ${workerModel}`}${fromUser > 0 ? ` · 💬 ${fromUser}` : ""}`,
      badge: stateBadge(timing?.state ?? summary.state),
      details,
      chipGroups: agentChips(workerId),
      agentId: workerId,
    });
    if (single) for (const reviewerId of summary.reviewerIds) nodes.push(reviewerNode(reviewerId, 2));
  }
  if (!single) for (const reviewerId of summary.reviewerIds) nodes.push(reviewerNode(reviewerId, 1));
  return nodes;
}

// ---------------------------------------------------------------------------
// Styles. Every colour comes from the theme; no literal colours.
// ---------------------------------------------------------------------------

export function toneColor(theme: PluginTheme, tone: Tone): string {
  switch (tone) {
    case "muted":
      return theme.colors.foregroundMuted;
    case "plain":
      return theme.colors.foreground;
    case "info":
      return theme.colors.accent;
    case "warning":
      return theme.colors.statusWarning;
    case "danger":
      return theme.colors.statusDanger;
    case "success":
      return theme.colors.statusSuccess;
  }
}

export function dashboardStyles(theme: PluginTheme, compact: boolean) {
  return {
    screen: { flex: 1, backgroundColor: theme.colors.surface0 },
    content: { padding: compact ? 12 : 24, gap: compact ? 8 : 12 },
    title: { color: theme.colors.foreground, fontSize: compact ? 18 : 24, fontWeight: "600" as const },
    sectionTitle: { color: theme.colors.foreground, fontSize: compact ? 14 : 16, fontWeight: "600" as const },
    body: { color: theme.colors.foregroundMuted, fontSize: compact ? 12 : 14 },
    mono: { color: theme.colors.foreground, fontSize: compact ? 11 : 13 },
    card: {
      gap: compact ? 6 : 8,
      padding: compact ? 10 : 14,
      borderRadius: 10,
      borderWidth: 1,
      borderColor: theme.colors.border,
      backgroundColor: theme.colors.surface1,
    },
    badge: { fontSize: compact ? 11 : 12, fontWeight: "600" as const },
    button: {
      paddingVertical: 10,
      paddingHorizontal: 14,
      borderRadius: 8,
      alignItems: "center" as const,
      backgroundColor: theme.colors.accent,
    },
    buttonText: { color: theme.colors.accentForeground, fontSize: compact ? 13 : 14 },
    dangerButton: {
      paddingVertical: 10,
      paddingHorizontal: 14,
      borderRadius: 8,
      alignItems: "center" as const,
      borderWidth: 1,
      borderColor: theme.colors.statusDanger,
      backgroundColor: theme.colors.surface2,
    },
    dangerButtonText: { color: theme.colors.statusDanger, fontSize: compact ? 13 : 14 },
    secondaryButton: {
      paddingVertical: 10,
      paddingHorizontal: 14,
      borderRadius: 8,
      alignItems: "center" as const,
      borderWidth: 1,
      borderColor: theme.colors.border,
      backgroundColor: theme.colors.surface2,
    },
    secondaryButtonText: { color: theme.colors.foreground, fontSize: compact ? 13 : 14 },
    spinner: { color: theme.colors.foregroundMuted },
    cards: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: compact ? 6 : 10 },
    statCard: {
      minWidth: compact ? 140 : 160,
      flexGrow: 1,
      gap: 2,
      padding: compact ? 10 : 12,
      borderRadius: 10,
      borderWidth: 1,
      borderColor: theme.colors.border,
      backgroundColor: theme.colors.surface1,
    },
    statValue: { color: theme.colors.foreground, fontSize: compact ? 20 : 26, fontWeight: "700" as const },
    barTrack: { flex: 1, height: 10, borderRadius: 5, backgroundColor: theme.colors.surface2 },
    barFill: { height: 10, borderRadius: 5, backgroundColor: theme.colors.accent },
    chipRow: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: 6 },
    chip: {
      paddingVertical: 2,
      paddingHorizontal: 8,
      borderRadius: 999,
      borderWidth: 1,
    },
    node: {
      gap: 4,
      paddingVertical: compact ? 6 : 8,
      paddingHorizontal: compact ? 8 : 10,
      borderLeftWidth: 2,
      borderLeftColor: theme.colors.border,
    },
  };
}
