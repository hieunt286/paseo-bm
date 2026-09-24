/**
 * Where "Mark as answered" is remembered (delta 20260918d-card-replies §4.9,
 * REQ-059 k; owner decision Q16 a).
 *
 * A mark says the user considers a question card answered, even if its Worker
 * still looks like it waits. It must survive an app reload, so it lives in a
 * small file of the install home, next to the launcher's pinned order, and is
 * written through the same machinery: the no-follow path guard and the atomic
 * temp-then-rename the trace store uses.
 *
 * Reads never repair the file. A corrupt or too-new file reads as "no marks"
 * and says so; writing over a newer version's file is refused.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { UI_DIR_NAME } from "./install-home";
import { assertNoSymlinkOnPath, ensureStoreDir, writeStoreFileAtomically, type TraceStoreLocation } from "./trace-store";
import { DashboardError } from "../shared/contracts";

/** Bumped only when the shape below changes incompatibly. */
export const ANSWER_MARKS_SCHEMA_VERSION = 1;
export const ANSWER_MARKS_FILE_NAME = "answer-marks.json";
/** Oldest marks go first once there are more: a mark only matters for a live card. */
export const ANSWER_MARKS_LIMIT = 500;
export const ANSWER_MARK_KEY_MAX = 400;

const answerMarksFileSchema = z.object({
  schemaVersion: z.number().int().positive(),
  marks: z.array(z.object({ key: z.string(), at: z.string() })),
});

export interface AnswerMarks {
  /** Card keys, oldest first. */
  keys: string[];
  /** What could not be read, in the user's terms. Empty when all is well. */
  notices: string[];
  /** True when the file on disk is newer than this plugin understands. */
  tooNew: boolean;
}

/** True when `text` holds an ASCII control character (codes 0-31 and 127). */
function hasControlCharacter(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code < 32 || code === 127) return true;
  }
  return false;
}

/** A key this store accepts: a card key is `agentId|requestId|questionIds`. */
export function isAnswerMarkKey(key: unknown): key is string {
  return typeof key === "string" && key.length > 0 && key.length <= ANSWER_MARK_KEY_MAX && !hasControlCharacter(key);
}

export function answerMarksPath(location: TraceStoreLocation): string {
  return join(dirname(location.tracesDir), UI_DIR_NAME, ANSWER_MARKS_FILE_NAME);
}

function readMarks(location: TraceStoreLocation): { marks: Array<{ key: string; at: string }>; notices: string[]; tooNew: boolean } {
  const path = answerMarksPath(location);
  // Before the read, so a symlinked path is refused rather than followed.
  assertNoSymlinkOnPath(dirname(location.tracesDir), path);

  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { marks: [], notices: [], tooNew: false };
    return { marks: [], notices: [`Could not read the answered marks (${(error as Error).message}).`], tooNew: false };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { marks: [], notices: ["The answered-marks file is not valid JSON; no card is marked."], tooNew: false };
  }
  const result = answerMarksFileSchema.safeParse(parsed);
  if (!result.success) {
    return { marks: [], notices: ["The answered-marks file does not have the expected shape; no card is marked."], tooNew: false };
  }
  if (result.data.schemaVersion > ANSWER_MARKS_SCHEMA_VERSION) {
    return {
      marks: [],
      notices: [
        `The answered-marks file is version ${result.data.schemaVersion}, newer than this plugin understands (${ANSWER_MARKS_SCHEMA_VERSION}); no card is marked and nothing will be written.`,
      ],
      tooNew: true,
    };
  }
  const marks = result.data.marks.filter((mark) => isAnswerMarkKey(mark.key));
  const dropped = result.data.marks.length - marks.length;
  return { marks, notices: dropped > 0 ? [`Ignored ${dropped} unusable mark(s) in the answered-marks file.`] : [], tooNew: false };
}

/** The marks, or none. Never throws for a bad file; throws only for a symlinked path. */
export function readAnswerMarks(location: TraceStoreLocation): AnswerMarks {
  const { marks, notices, tooNew } = readMarks(location);
  return { keys: marks.map((mark) => mark.key), notices, tooNew };
}

/** Adds (as the newest) or removes one mark. Refuses a bad key and a newer file. */
export function writeAnswerMark(location: TraceStoreLocation, key: string, marked: boolean, now: () => Date = () => new Date()): AnswerMarks {
  if (!isAnswerMarkKey(key)) {
    throw new DashboardError("E_TRACE_STORE_UNWRITABLE", `not a usable card key: ${JSON.stringify(String(key).slice(0, 60))}`);
  }
  const current = readMarks(location);
  if (current.tooNew) {
    throw new DashboardError("E_TRACE_STORE_UNWRITABLE", "the answered-marks file was written by a newer version of paseo-bm; refusing to overwrite it");
  }
  const others = current.marks.filter((mark) => mark.key !== key);
  const marks = (marked ? [...others, { key, at: now().toISOString() }] : others).slice(-ANSWER_MARKS_LIMIT);
  ensureStoreDir(location.tracesDir, join(dirname(location.tracesDir), UI_DIR_NAME));
  writeStoreFileAtomically(
    location,
    answerMarksPath(location),
    `${JSON.stringify({ schemaVersion: ANSWER_MARKS_SCHEMA_VERSION, marks }, null, 2)}\n`,
  );
  return { keys: marks.map((mark) => mark.key), notices: [], tooNew: false };
}
