/**
 * The shared wording, formatting, confirmation logic and styles of the Beads
 * Manager surface's screens (WP-211.1; Dashboard Design §2.1, REQ-041 →
 * REQ-057): Work, Insights, Settings and the Beads board read them.
 *
 * Same split as `launch-manager.ts`: this file holds the logic, the wording and
 * the styles, so all of it is testable without React, and the screens only
 * arrange components. No React, no React Native, no JSX, no `server/` import.
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
import type { Confidence, StoreSize, TraceDeleteScope, TraceSummary, Usage } from "../shared/contracts";

/**
 * Told once where the stored history is managed, because Work's request
 * timelines show agent conversation (REQ-048d).
 */
export const PRIVACY_NOTICE =
  "paseo-bm stores the agents' conversation of each request on this machine, and Work shows it. You can delete it at any time: here, or from a request's Details.";

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

/**
 * Row title. A trace can exist without its request text — collection starts
 * when the plugin loads, so a request already in flight has no user turn on
 * record — and the screen has to say that instead of showing a blank line.
 */
export function excerptLine(excerpt: string | null): string {
  if (excerpt === null) return "Request text not recorded (this request started before the Dashboard did)";
  return excerpt.trim() === "" ? "(empty request)" : excerpt;
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
// Figures: cards and bars (Insights, and the Beads overview it shows).
// ---------------------------------------------------------------------------

export interface OverviewCard {
  label: string;
  value: string;
  hint: string;
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

/** Bar width as a share of the largest value, 0..1. */
export function barShare(bar: Bar, bars: readonly Bar[]): number {
  const max = Math.max(0, ...bars.map((entry) => entry.value));
  return max === 0 ? 0 : bar.value / max;
}

// ---------------------------------------------------------------------------
// Role marks.
// ---------------------------------------------------------------------------

/** What a role mark can stand for: the Manager (its request), a Worker, a Reviewer, or the Orchestrator. */
export type RoleMarkKind = "request" | "worker" | "reviewer" | "orchestrator";

/**
 * How each agent is drawn: a small Lucide icon on a soft tint of one theme
 * colour. `request` stands for the Manager, which handles the request. The
 * shape tells the role apart even where the colours look alike.
 */
export const ROLE_MARK: Readonly<Record<RoleMarkKind, { role: string; icon: string; tone: Tone }>> = {
  request: { role: "Manager", icon: "BotMessageSquare", tone: "info" },
  worker: { role: "Worker", icon: "Hammer", tone: "success" },
  reviewer: { role: "Reviewer", icon: "ScanEye", tone: "warning" },
  orchestrator: { role: "Orchestrator", icon: "Compass", tone: "muted" },
};

export function shorten(text: string, max: number): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length <= max ? line : `${line.slice(0, max - 1)}…`;
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
