/**
 * The request history as the screens word it (WP-211.1, WP-211.2.2; REQ-048d,
 * REQ-054, REQ-055e): the notice that it is kept, its size against the
 * machine-wide threshold, and the confirmation a delete or a reassignment
 * waits on (`dashboard-actions.tsx`). Split from `dashboard-model.ts` (code
 * review 2026-09-30 §4).
 *
 * A destructive action always states what will be lost and defaults to "No".
 *
 * Pure: no React, no React Native, no `server/` import.
 */
import type { StoreSize, TraceDeleteScope } from "../shared/contracts";
import { formatBytes } from "./format";
import type { Badge } from "./tone";

/**
 * Told once where the stored history is managed, because Work's request
 * timelines show agent conversation (REQ-048d).
 */
export const PRIVACY_NOTICE =
  "paseo-bm stores the agents' conversation of each request on this machine, and Work shows it. You can delete it at any time: here, or from a request's Details.";

/** Said next to the machine-wide threshold, since Paseo has no per-workspace settings (REQ-055e). */
export const HOST_SCOPE_NOTICE = "This threshold applies to every workspace on this machine.";

// ---------------------------------------------------------------------------
// Storage.
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
