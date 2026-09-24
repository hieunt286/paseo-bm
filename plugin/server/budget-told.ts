/**
 * Which review-budget overruns the Manager has already been told about
 * (diagnosis 2026-09-23, fault L5).
 *
 * This used to be a `Set<string>` in `contribute()`'s closure, so a plugin
 * reload or a daemon restart wiped it and the same overrun was announced again:
 * req-20260923T021315Z was told at "5 review calls" twice, 47 minutes and one
 * restart apart, with the count unchanged.
 *
 * ONE NOTICE PER REQUEST, unchanged. That is the shipped decision (delta
 * 20260917c §4.7, pinned by test/plugin-review-budget.test.ts: "a later turn of
 * the Worker or of a new Reviewer does not repeat it"), and persisting it is
 * the whole fix. It does mean one observed behaviour goes away: the 9-call
 * notice of req-20260922T135101Z, which followed a 7-call notice for the same
 * request, only went out because the 05:54 restart had cleared the Set. It was
 * the accident, not the rule. The count is stored anyway, so a reader of the
 * file can see which overrun was announced.
 *
 * Reads never repair the file. A corrupt or too-new file reads as "nothing told"
 * — the safe direction, because one notice too many only costs the user a
 * question, while one too few loses the only warning they get. Writing over a
 * newer version's file is refused.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { UI_DIR_NAME } from "./install-home";
import { assertNoSymlinkOnPath, ensureStoreDir, writeStoreFileAtomically, type TraceStoreLocation } from "./trace-store";

/** Bumped only when the shape below changes incompatibly. */
export const BUDGET_TOLD_SCHEMA_VERSION = 1;
export const BUDGET_TOLD_FILE_NAME = "budget-told.json";
/** Oldest entries go first once there are more; a request only matters while it runs. */
export const BUDGET_TOLD_LIMIT = 500;

const budgetToldFileSchema = z.object({
  schemaVersion: z.number().int().positive(),
  told: z.array(z.object({ key: z.string().min(1), calls: z.number().int().nonnegative(), at: z.string() })),
});

type Entry = { key: string; calls: number; at: string };

export function budgetToldPath(location: TraceStoreLocation): string {
  return join(dirname(location.tracesDir), UI_DIR_NAME, BUDGET_TOLD_FILE_NAME);
}

function readFile(location: TraceStoreLocation): { told: Entry[]; notices: string[]; tooNew: boolean } {
  const path = budgetToldPath(location);
  // Before the read, so a symlinked path is refused rather than followed.
  assertNoSymlinkOnPath(dirname(location.tracesDir), path);

  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { told: [], notices: [], tooNew: false };
    return { told: [], notices: [`Could not read the review-budget notices already sent (${(error as Error).message}).`], tooNew: false };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { told: [], notices: ["The review-budget file is not valid JSON; treating every overrun as untold."], tooNew: false };
  }
  const result = budgetToldFileSchema.safeParse(parsed);
  if (!result.success) {
    return { told: [], notices: ["The review-budget file does not have the expected shape; treating every overrun as untold."], tooNew: false };
  }
  if (result.data.schemaVersion > BUDGET_TOLD_SCHEMA_VERSION) {
    return {
      told: [],
      notices: [
        `The review-budget file is version ${result.data.schemaVersion}, newer than this plugin understands (${BUDGET_TOLD_SCHEMA_VERSION}); nothing will be written to it.`,
      ],
      tooNew: true,
    };
  }
  return { told: result.data.told, notices: [], tooNew: false };
}

/** Why a notice may or may not go out; see `BudgetTold.claim`. */
export type ClaimResult = "claimed" | "told" | "sending";

/** What `checkReviewBudget` needs; the file-backed one is `createBudgetTold()`. */
export interface BudgetTold {
  /**
   * May a notice for `key` go out?
   *
   * - `"claimed"` — yes, and the key is now CLAIMED: `commit` or `release` must
   *   follow.
   * - `"told"` — no, this request was already announced, at any count. `calls`
   *   is recorded, not compared: the budget is announced once per request.
   * - `"sending"` — no, another turn end is sending it right now.
   *
   * The two refusals are NOT interchangeable. Only `"told"` means nothing more
   * will ever be sent for this request; `"sending"` means a turn end is midway
   * through, and whatever it left behind belongs to it (review b3 re-review).
   */
  claim(location: TraceStoreLocation, key: string, calls: number): ClaimResult;
  /** The notice went out; remember it across reloads. */
  commit(location: TraceStoreLocation, key: string, calls: number): void;
  /** The notice did not go out; let a later turn end try again. */
  release(key: string): void;
}

export function createBudgetTold(log: (message: string) => void = (message) => console.warn(message)): BudgetTold {
  /** Keys a turn end is sending right now, with the count it claimed. */
  const claiming = new Map<string, number>();
  /** The file, read once and kept in step with what we write. */
  let cache: Map<string, number> | null = null;

  const load = (location: TraceStoreLocation): Map<string, number> => {
    if (cache !== null) return cache;
    const { told, notices } = readFile(location);
    for (const notice of notices) log(`[paseo-bm] ${notice}`);
    cache = new Map(told.map((entry) => [entry.key, entry.calls]));
    return cache;
  };

  return {
    claim(location, key, calls) {
      if (claiming.has(key)) return "sending";
      let known: number | undefined;
      try {
        known = load(location).get(key);
      } catch (error) {
        // A symlinked path throws; treat it as untold and say so once.
        log(`[paseo-bm] could not read the review-budget notices already sent: ${error instanceof Error ? error.message : String(error)}`);
        known = undefined;
      }
      if (known !== undefined) return "told";
      claiming.set(key, calls);
      return "claimed";
    },
    commit(location, key, calls) {
      claiming.delete(key);
      try {
        const current = readFile(location);
        if (current.tooNew) {
          // A newer version owns the file; the in-memory note still stops a repeat this session.
          (cache ??= new Map()).set(key, calls);
          return;
        }
        const others = current.told.filter((entry) => entry.key !== key);
        const told = [...others, { key, calls, at: new Date().toISOString() }].slice(-BUDGET_TOLD_LIMIT);
        ensureStoreDir(location.tracesDir, join(dirname(location.tracesDir), UI_DIR_NAME));
        writeStoreFileAtomically(location, budgetToldPath(location), `${JSON.stringify({ schemaVersion: BUDGET_TOLD_SCHEMA_VERSION, told }, null, 2)}\n`);
        cache = new Map(told.map((entry) => [entry.key, entry.calls]));
      } catch (error) {
        // Never throw into an agent's turn end: the notice already went out, and
        // the in-memory note keeps this session from repeating it.
        log(`[paseo-bm] could not record that the review-budget notice for ${key} was sent: ${error instanceof Error ? error.message : String(error)}`);
        (cache ??= new Map()).set(key, calls);
      }
    },
    release(key) {
      claiming.delete(key);
    },
  };
}
