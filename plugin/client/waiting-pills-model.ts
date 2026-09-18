/**
 * Which "questions waiting" pills a Manager's chat shows (delta
 * 20260918d-card-replies §4.8, REQ-059 j): one per Worker whose latest report
 * asks the user something, as `chat.waiting` answers.
 *
 * Pure: no React, no React Native, no `server/` import.
 */
import type { WaitingWorker } from "../shared/contracts";
import { partyName, toChatCard } from "./chat-cards";

/** How often the pills are read again. The pill of an answered Worker goes within one period. */
export const WAITING_POLL_MS = 15_000;

/** A Lucide icon name, as the host's other buttons use. */
export const WAITING_PILL_ICON = "MessageCircleQuestion";

/** The composer pill of one waiting Worker. */
export interface WaitingPill {
  id: string;
  /** Changes whenever the pill must be redrawn. */
  key: string;
  label: string;
  title: string;
  entry: WaitingWorker;
}

export function pillIdOf(workerId: string): string {
  return `bm-waiting-${workerId}`;
}

/** The report's questions, as the card reads them; 0 when the text has none. */
export function questionCountOf(entry: WaitingWorker): number {
  return toChatCard({ type: "user_message", text: entry.text }, "complete")?.questions.length ?? 0;
}

export function pillOf(entry: WaitingWorker): WaitingPill | null {
  const count = questionCountOf(entry);
  if (count === 0) return null;
  const name = partyName({ role: "worker", id: entry.workerId, title: entry.workerTitle });
  const label = `${name} · ${count} ${count === 1 ? "question" : "questions"}`;
  return {
    id: pillIdOf(entry.workerId),
    key: [entry.managerId, entry.workspaceId, label, entry.at ?? ""].join("|"),
    label,
    title: `Questions from ${name} about ${entry.requestId}`,
    entry,
  };
}

/**
 * What to add, redraw and remove, given the pills shown now (`id → key`) and
 * the latest `chat.waiting` answer. A pill whose key did not change is left alone.
 */
export function planPills(
  current: ReadonlyMap<string, string>,
  waiting: readonly WaitingWorker[],
): { add: WaitingPill[]; update: WaitingPill[]; remove: string[] } {
  const next = new Map<string, WaitingPill>();
  for (const entry of waiting) {
    const pill = pillOf(entry);
    if (pill !== null && !next.has(pill.id)) next.set(pill.id, pill);
  }
  const add: WaitingPill[] = [];
  const update: WaitingPill[] = [];
  for (const pill of next.values()) {
    const shown = current.get(pill.id);
    if (shown === undefined) add.push(pill);
    else if (shown !== pill.key) update.push(pill);
  }
  const remove = [...current.keys()].filter((id) => !next.has(id));
  return { add, update, remove };
}
