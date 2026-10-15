/**
 * The mission brief a governor wake opens with (missions design §20,
 * ADR-032 decision 2, REQ-197 b; mission runtime design §2.2): the one
 * mission state's rendering (`missionStateOf`, `renderMissionState`) and the
 * governor's newest notes on the mission — read from the stores when the
 * `BM-EVENTS` message is delivered, never from memory.
 *
 * - **What it holds:** the mission state's rendering — the mission, its
 *   done criteria, what is in flight, what waits on whom, links, the owner's
 *   recent exchange with the Main, the governor's raised families, the
 *   journal — then the governor's `BRIEF_NOTES` newest notes on the mission.
 * - **Bounds:** at most `BRIEF_MAX_CHARS` in all; the rendering drops its
 *   oldest lines first. Text is masked when the state is read. Synchronous:
 *   the notice queue composes the message at the idle moment.
 *
 * Never throws: a store it cannot read leaves its line out, and a mission it
 * cannot find is one line saying so.
 */
import { redactText } from "./collector";
import { missionStateOf } from "./mission-state";
import { createOrchestratorStore } from "./orchestrator-store";
import { renderMissionState } from "../shared/mission-state";

/** One text field of the brief, at most this long. */
export const BRIEF_TEXT_MAX = 300;
/** The governor's newest notes on the mission. */
export const BRIEF_NOTES = 3;
/** The whole brief of one mission, at most. */
export const BRIEF_MAX_CHARS = 3_000;

function cut(text: string, max = BRIEF_TEXT_MAX): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

function quietly<T>(read: () => T, fallback: T): T {
  try {
    return read();
  } catch {
    return fallback;
  }
}

/** The brief of one mission, as lines of text; see the module comment. Never throws. */
export function missionBriefOf(home: string, missionId: string, env: NodeJS.ProcessEnv = process.env): string {
  const state = quietly(() => missionStateOf(home, missionId, { env }), null);
  if (state === null) return `Mission ${missionId}: not found in the mission store.`;
  const notes = quietly(() => createOrchestratorStore(home).readNotes({ missionId }), []).slice(-BRIEF_NOTES);
  const notesLine = notes.length === 0 ? "" : `\nYour notes: ${notes.map((note) => `[${note.at}] ${cut(redactText(note.text, env), 200)}`).join(" ")}`;
  return `${renderMissionState(state, { maxChars: Math.max(500, BRIEF_MAX_CHARS - notesLine.length) })}${notesLine}`;
}
