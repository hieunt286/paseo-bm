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
 * newer version's file is refused. The file rules are every store's
 * (`data-files.ts` `createJsonFileStore`, code review 2026-09-30 §3.1), with
 * the code this file has always had, `E_TRACE_STORE_UNWRITABLE`; nothing here
 * throws into a turn end.
 */
import { dirname, join } from "node:path";
import { z } from "zod";
import { capBy, createJsonFileStore, type JsonFileStore } from "./data-files";
import { UI_DIR_NAME } from "./data-home";
import type { TraceStoreLocation } from "./trace-store";

/** Bumped only when the shape below changes incompatibly. */
export const BUDGET_TOLD_SCHEMA_VERSION = 1;
export const BUDGET_TOLD_FILE_NAME = "budget-told.json";
/** Oldest entries go first once there are more; a request only matters while it runs. */
export const BUDGET_TOLD_LIMIT = 500;

/** The file's content after its `schemaVersion` (1), all or nothing: one entry that does not validate makes the whole file untold. */
const budgetToldBodySchema = z.object({
  told: z.array(z.object({ key: z.string().min(1), calls: z.number().int().nonnegative(), at: z.string() })),
});

type Entry = { key: string; calls: number; at: string };

export function budgetToldPath(location: TraceStoreLocation): string {
  return join(dirname(location.tracesDir), UI_DIR_NAME, BUDGET_TOLD_FILE_NAME);
}

/** The file beside the trace store at `location`. Creating it touches nothing on disk. */
function toldFile(location: TraceStoreLocation): JsonFileStore<{ told: Entry[] }> {
  return createJsonFileStore({
    home: dirname(location.tracesDir),
    dir: UI_DIR_NAME,
    file: BUDGET_TOLD_FILE_NAME,
    version: BUDGET_TOLD_SCHEMA_VERSION,
    versionKey: "schemaVersion",
    parse: (body) => {
      const result = budgetToldBodySchema.safeParse(body);
      if (!result.success) throw new Error("it does not have the expected shape");
      return { told: result.data.told };
    },
    empty: () => ({ told: [] }),
    cap: ({ told }) => ({ told: capBy(told, BUDGET_TOLD_LIMIT) }),
    codes: { unwritable: "E_TRACE_STORE_UNWRITABLE" },
  });
}

/** What the file says, and a notice when it exists but cannot be used. Throws on a symlink, refused rather than followed. */
function readFile(location: TraceStoreLocation): { told: Entry[]; notices: string[] } {
  const found = toldFile(location).inspect();
  if (found.state === "too-new") {
    return { told: [], notices: [`The review-budget file is newer than this plugin understands (${found.problem}); nothing will be written to it.`] };
  }
  if (found.state === "unusable") {
    return { told: [], notices: [`The review-budget file cannot be used (${found.problem}); treating every overrun as untold.`] };
  }
  return { told: found.value.told, notices: [] };
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
        const file = toldFile(location);
        const current = file.inspect();
        if (current.state === "too-new") {
          // A newer version owns the file; the in-memory note still stops a repeat this session.
          (cache ??= new Map()).set(key, calls);
          return;
        }
        const others = current.value.told.filter((entry) => entry.key !== key);
        const { told } = file.write({ told: [...others, { key, calls, at: new Date().toISOString() }] });
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
