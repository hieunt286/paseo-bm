/**
 * Which "questions waiting" pills a Manager's chat shows (delta
 * 20260918d-card-replies §4.8, REQ-059 j): one per Worker whose latest report
 * asks the user something, as `chat.waiting` answers. And one per Manager
 * whose chat has fallback incidents waiting for the user's decision, counting
 * them (delta 20260921 §4.4.6, REQ-065 c).
 *
 * Pure: no React, no React Native, no `server/` import.
 */
import type { FallbackIncident, WaitingFallback, WaitingWorker } from "../shared/contracts";
import { partyName, toChatCard } from "./chat-cards";

/** How often the pills are read again. The pill of an answered Worker goes within one period. */
export const WAITING_POLL_MS = 15_000;

/** A Lucide icon name, as the host's other buttons use. */
export const WAITING_PILL_ICON = "MessageCircleQuestion";

/** The fallback pill's Lucide icon. */
export const FALLBACK_PILL_ICON = "TriangleAlert";

/** The composer pill of one waiting Worker. */
export interface WaitingPill {
  kind: "questions";
  id: string;
  /** Changes whenever the pill must be redrawn. */
  key: string;
  label: string;
  title: string;
  entry: WaitingWorker;
}

/** The composer pill of one Manager's pending fallback incidents. */
export interface FallbackPill {
  kind: "fallback";
  id: string;
  /** Changes whenever the pill must be redrawn. */
  key: string;
  label: string;
  title: string;
  managerId: string;
  workspaceId: string;
  /** Oldest first; never empty. */
  incidents: FallbackIncident[];
}

export type ComposerPill = WaitingPill | FallbackPill;

/**
 * FNV-1a 32-bit over the UTF-16 code units of `text`, as 8 hex digits. Small
 * and dependency-free; it only has to notice that a report's text changed.
 */
export function fnv1a32Hex(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

export function pillIdOf(workerId: string): string {
  return `bm-waiting-${workerId}`;
}

export function fallbackPillIdOf(managerId: string): string {
  return `bm-fallback-${managerId}`;
}

/**
 * The report's questions still OPEN, as the card reads them: the ones the
 * question–answer ledger holds an answer to are not counted (design delta
 * 20260924-qa-ledger §4.2). 0 when the text has none.
 */
export function questionCountOf(entry: WaitingWorker): number {
  const answered = new Set(entry.answered ?? []);
  return toChatCard({ type: "user_message", text: entry.text }, "complete")?.questions.filter((question) => !answered.has(question.id)).length ?? 0;
}

export function pillOf(entry: WaitingWorker): WaitingPill | null {
  const count = questionCountOf(entry);
  if (count === 0) return null;
  const name = partyName({ role: "worker", id: entry.workerId, title: entry.workerTitle });
  const label = `${name} · ${count} ${count === 1 ? "question" : "questions"}`;
  return {
    kind: "questions",
    id: pillIdOf(entry.workerId),
    // The text's hash too: without a timestamp, a new report with the same
    // number of questions would otherwise never reach the popover (delta
    // 20260918f F14).
    // `answered` too: a partly answered report must redraw its popover's card.
    key: [entry.managerId, entry.workspaceId, entry.requestId, label, entry.at ?? "", fnv1a32Hex(entry.text), (entry.answered ?? []).join(",")].join("|"),
    label,
    title: `Questions from ${name} about ${entry.requestId}`,
    entry,
  };
}

/**
 * One pill per Manager, counting the `pending` incidents whose `managerId` is
 * that Manager. `chat.waiting` already sends only those; the test is repeated
 * here so a pill never counts anything else.
 */
export function fallbackPillsOf(fallback: readonly WaitingFallback[]): FallbackPill[] {
  const byManager = new Map<string, { workspaceId: string; incidents: FallbackIncident[] }>();
  for (const entry of fallback) {
    if (entry.incident.status !== "pending" || entry.incident.managerId !== entry.managerId) continue;
    const group = byManager.get(entry.managerId) ?? { workspaceId: entry.workspaceId, incidents: [] };
    if (!group.incidents.some((incident) => incident.id === entry.incident.id)) group.incidents.push(entry.incident);
    byManager.set(entry.managerId, group);
  }
  return [...byManager].map(([managerId, { workspaceId, incidents }]) => {
    const count = incidents.length;
    const label = `Fallback · ${count} ${count === 1 ? "decision" : "decisions"}`;
    return {
      kind: "fallback",
      id: fallbackPillIdOf(managerId),
      key: [managerId, workspaceId, label, incidents.map((incident) => incident.id).join(",")].join("|"),
      label,
      title:
        count === 1
          ? "An agent stopped by its provider plan waits for your decision"
          : `${count} agents stopped by their provider plan wait for your decision`,
      managerId,
      workspaceId,
      incidents,
    };
  });
}

/** The chat a pill belongs to. */
export function pillChatOf(pill: ComposerPill): { managerId: string; workspaceId: string } {
  return pill.kind === "questions"
    ? { managerId: pill.entry.managerId, workspaceId: pill.entry.workspaceId }
    : { managerId: pill.managerId, workspaceId: pill.workspaceId };
}

/**
 * What to add, redraw and remove, given the pills shown now (`id → key`) and
 * the latest `chat.waiting` answer. A pill whose key did not change is left alone.
 */
export function planPills(
  current: ReadonlyMap<string, string>,
  waiting: readonly WaitingWorker[],
  fallback: readonly WaitingFallback[] = [],
): { add: ComposerPill[]; update: ComposerPill[]; remove: string[] } {
  const next = new Map<string, ComposerPill>();
  for (const entry of waiting) {
    const pill = pillOf(entry);
    if (pill !== null && !next.has(pill.id)) next.set(pill.id, pill);
  }
  for (const pill of fallbackPillsOf(fallback)) next.set(pill.id, pill);
  const add: ComposerPill[] = [];
  const update: ComposerPill[] = [];
  for (const pill of next.values()) {
    const shown = current.get(pill.id);
    if (shown === undefined) add.push(pill);
    else if (shown !== pill.key) update.push(pill);
  }
  const remove = [...current.keys()].filter((id) => !next.has(id));
  return { add, update, remove };
}
