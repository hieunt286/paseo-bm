/**
 * The answers a bound Manager proposed with `bm_answers` (design §16.6;
 * autonomy REQ-117 e), held in memory until that Manager's turn ends.
 *
 * A Manager relays no answer as text: only the owner's own words may answer
 * a question in chat (rule (b), `via: chat-manager`). So `bm_answers` only
 * proposes, keyed by the Manager's id and the start of the turn it was called
 * in (the collector's start mark, `currentTurnStartOf`), and the decision
 * materialiser takes the proposals of that turn at its end: it settles them
 * only when the turn holds the owner's own message, and drops them otherwise.
 *
 * Nothing here is written to disk: a plugin reload during the turn loses the
 * proposals, and the owner answers on the card. Bounded: at most
 * `MAX_PROPOSALS` turns are held, the oldest dropped first.
 */
import type { Answer } from "../shared/bm-questions";

/** The most Manager turns whose proposals are held at once. */
export const MAX_PROPOSALS = 200;

/** One proposal: the request and its answers, as a `BM-ANSWERS` block reads (`Qn`, `a — label` or `other — words`). */
export interface ProposedAnswers {
  requestId: string;
  answers: Answer[];
}

/** Proposals by `<managerId>|<turn start>`, in insertion order. */
const held = new Map<string, ProposedAnswers[]>();

const keyOf = (managerId: string, turnStartedAt: string): string => `${managerId}|${turnStartedAt}`;

/**
 * Holds `proposal` for the Manager's turn that started at `turnStartedAt`. A
 * later proposal of the same request and question in the same turn replaces
 * the earlier answer.
 */
export function proposeAnswers(managerId: string, turnStartedAt: string, proposal: ProposedAnswers): void {
  const key = keyOf(managerId, turnStartedAt);
  const kept = (held.get(key) ?? []).map((entry) =>
    entry.requestId !== proposal.requestId ? entry : { ...entry, answers: entry.answers.filter((answer) => !proposal.answers.some((next) => next.id === answer.id)) },
  );
  held.delete(key);
  held.set(key, [...kept.filter((entry) => entry.answers.length > 0), proposal]);
  while (held.size > MAX_PROPOSALS) {
    const oldest = held.keys().next().value;
    if (oldest === undefined) break;
    held.delete(oldest);
  }
}

/**
 * Takes (and forgets) the proposals of the Manager's turn that started at
 * `turnStartedAt`, with any older turn's of that Manager, which ended without
 * a record. None for a turn without a start mark.
 */
export function takeProposedAnswers(managerId: string, turnStartedAt: string | null): ProposedAnswers[] {
  if (turnStartedAt === null) return [];
  const taken = held.get(keyOf(managerId, turnStartedAt)) ?? [];
  for (const key of [...held.keys()]) {
    const [agent, start] = [key.slice(0, key.lastIndexOf("|")), key.slice(key.lastIndexOf("|") + 1)];
    if (agent === managerId && start <= turnStartedAt) held.delete(key);
  }
  return taken;
}

/** What is held for one Manager turn, without taking it; tests only. */
export function proposedAnswersOf(managerId: string, turnStartedAt: string): ProposedAnswers[] {
  return held.get(keyOf(managerId, turnStartedAt)) ?? [];
}

/** Forgets every proposal, as a plugin reload does; tests only. */
export function clearProposedAnswers(): void {
  held.clear();
}
