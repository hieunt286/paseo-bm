/**
 * What this app session knows about answers sent from chat cards (delta
 * 20260918d-card-replies §4.9, REQ-059 k).
 *
 * A report can be drawn twice at once — in the chat and in a waiting pill's
 * popover — and the chat list may unmount a card while scrolling, so this
 * cannot live in a card's own state. Every copy subscribes here and redraws
 * when any copy writes. Nothing is kept across a reload: marks that must
 * survive one go to the install home (`answers.mark`).
 *
 * No React here: `chat-card.tsx` reads it through `useSyncExternalStore`.
 */

/** Answers sent from a card: when, the short summary, and to whom. */
export interface AnsweredRecord {
  at: Date;
  summary: string;
  to: string;
}

const answered = new Map<string, AnsweredRecord>();
const replied = new Map<string, Date>();
const listeners = new Set<() => void>();
let version = 0;

function notify(): void {
  version += 1;
  for (const listener of [...listeners]) listener();
}

/** The answers sent from the card with this `answeredKey`, or null. */
export function answeredRecord(key: string): AnsweredRecord | null {
  return answered.get(key) ?? null;
}

export function setAnswered(key: string, record: AnsweredRecord): void {
  answered.set(key, record);
  notify();
}

/** When a reply last went out from the card with this `answeredKey`, or null. */
export function repliedAt(key: string): Date | null {
  return replied.get(key) ?? null;
}

export function setReplied(key: string, at: Date): void {
  replied.set(key, at);
  notify();
}

/** Calls `listener` after every write; returns the unsubscribe. */
export function subscribeAnswers(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Changes on every write: the snapshot `useSyncExternalStore` compares. */
export function answersVersion(): number {
  return version;
}
