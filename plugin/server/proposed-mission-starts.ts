/**
 * The missions an unassigned Main proposed with `bm_mission_start` (missions
 * design §4; REQ-184), held in memory until that Main's turn ends — the
 * `bm_answers` rule (`proposed-answers.ts`): only the owner names a mission,
 * so the tool only proposes, keyed by the Main's id and the start of the turn
 * it was called in (`currentTurnStartOf`), and the decision materialiser
 * settles it at that turn's end only when the turn holds the owner's own
 * message (`mission-tools.ts` `settleMissionStart`), and drops it otherwise.
 *
 * Nothing here is written to disk: a plugin reload during the turn loses the
 * proposal, and the Main calls again. Bounded: one proposal per Main (the
 * newest of its turn), at most `MAX_PROPOSED_STARTS` Mains, oldest dropped first.
 */

/** The most Mains whose proposals are held at once. */
export const MAX_PROPOSED_STARTS = 200;

/** A proposed mission, its repos resolved to workspace ids. */
export interface ProposedMissionStart {
  code: string;
  name: string;
  goal: string;
  repos: string[];
}

const held = new Map<string, { startedAt: string; proposal: ProposedMissionStart }>();

/** Holds `proposal` for the Main's turn that started at `turnStartedAt`; it replaces any earlier one. */
export function proposeMissionStart(mainId: string, turnStartedAt: string, proposal: ProposedMissionStart): void {
  held.delete(mainId);
  held.set(mainId, { startedAt: turnStartedAt, proposal });
  while (held.size > MAX_PROPOSED_STARTS) {
    const oldest = held.keys().next().value;
    if (oldest === undefined) break;
    held.delete(oldest);
  }
}

/**
 * Takes (and forgets) the proposal of the Main's turn that started at
 * `turnStartedAt`; an older turn's, which ended without a record, is
 * forgotten too. Null for none, or a turn without a start mark.
 */
export function takeProposedMissionStart(mainId: string, turnStartedAt: string | null): ProposedMissionStart | null {
  if (turnStartedAt === null) return null;
  const current = held.get(mainId);
  if (current === undefined || current.startedAt > turnStartedAt) return null;
  held.delete(mainId);
  return current.startedAt === turnStartedAt ? current.proposal : null;
}

/** Missions design §3.4: forgets the proposal held for `mainId`, a Main just replaced (the owner's words stay in the chat); true when there was any. */
export function dropProposedMissionStartOf(mainId: string): boolean {
  return held.delete(mainId);
}

/** What is held for one Main turn, without taking it; tests only. */
export function proposedMissionStartOf(mainId: string, turnStartedAt: string): ProposedMissionStart | null {
  const current = held.get(mainId);
  return current?.startedAt === turnStartedAt ? current.proposal : null;
}

/** Forgets every proposal, as a plugin reload does; tests only. */
export function clearProposedMissionStarts(): void {
  held.clear();
}
