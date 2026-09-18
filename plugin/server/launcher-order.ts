/**
 * Where the Beads Manager screen keeps the order the owner pinned.
 *
 * The screen lists workspaces newest-activity-first. The owner asked to drag
 * some to the top and have them stay there (delta 20260917e §4.1, decision
 * Q26): pinned rows keep the owner's order, everything else keeps the activity
 * sort.
 *
 * **Why a file and not `useSettings`.** Paseo has a settings mechanism and the
 * Dashboard's settings screen uses it — but on 2026-09-17 the daemon log showed
 * eight `Plugin paseo-bm does not contribute RPC settings.paseo-bm.read`
 * errors, so that path is already broken. Its cause is a separate bead. Pinning
 * is written through the machinery that is known to work: the same install-home
 * resolver, no-follow path guard and atomic temp-then-rename the trace store
 * uses.
 *
 * Reads never repair the file. A corrupt or too-new file reads as "nothing
 * pinned" and says so, because silently rewriting the owner's file is how an
 * ordering preference turns into lost data.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import {
  WORKSPACE_ID_PATTERN,
  assertNoSymlinkOnPath,
  ensureStoreDir,
  writeStoreFileAtomically,
  type TraceStoreLocation,
} from "./trace-store";
import { DashboardError } from "../shared/contracts";

/** Bumped only when the shape below changes incompatibly. */
export const LAUNCHER_ORDER_SCHEMA_VERSION = 1;

/** Directory inside the install home for UI state that is not trace data. */
export const UI_DIR_NAME = "ui";

export const LAUNCHER_ORDER_FILE_NAME = "launcher-order.json";

const launcherOrderFileSchema = z.object({
  schemaVersion: z.number().int().positive(),
  pinned: z.array(z.string()),
});

export interface LauncherOrder {
  /** Workspace ids, in the order the owner put them. */
  pinned: string[];
  /** What could not be read, in the user's terms. Empty when all is well. */
  notices: string[];
  /** True when the file on disk is newer than this plugin understands. */
  tooNew: boolean;
}

/** The install home is the parent of the traces directory. */
function uiDir(location: TraceStoreLocation): string {
  return join(dirname(location.tracesDir), UI_DIR_NAME);
}

export function launcherOrderPath(location: TraceStoreLocation): string {
  return join(uiDir(location), LAUNCHER_ORDER_FILE_NAME);
}

/**
 * The pinned order, or an empty one. Never throws for a bad file: an unreadable
 * preference must not take the whole screen down with it.
 */
export function readLauncherOrder(location: TraceStoreLocation): LauncherOrder {
  const path = launcherOrderPath(location);
  // The guard runs before the read, so a symlinked path is refused rather than
  // followed out of the install home.
  assertNoSymlinkOnPath(dirname(location.tracesDir), path);

  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { pinned: [], notices: [], tooNew: false };
    return { pinned: [], notices: [`Could not read the pinned order (${(error as Error).message}).`], tooNew: false };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { pinned: [], notices: ["The pinned order file is not valid JSON; nothing is pinned."], tooNew: false };
  }

  const result = launcherOrderFileSchema.safeParse(parsed);
  if (!result.success) {
    return { pinned: [], notices: ["The pinned order file does not have the expected shape; nothing is pinned."], tooNew: false };
  }
  if (result.data.schemaVersion > LAUNCHER_ORDER_SCHEMA_VERSION) {
    return {
      pinned: [],
      notices: [
        `The pinned order file is version ${result.data.schemaVersion}, newer than this plugin understands (${LAUNCHER_ORDER_SCHEMA_VERSION}); nothing is pinned and nothing will be written.`,
      ],
      tooNew: true,
    };
  }

  // An id that could not name a directory cannot be one of ours. Dropping it is
  // safe here; writing is where a bad id is refused outright.
  const pinned = result.data.pinned.filter((id) => WORKSPACE_ID_PATTERN.test(id));
  const dropped = result.data.pinned.length - pinned.length;
  return {
    pinned,
    notices: dropped > 0 ? [`Ignored ${dropped} unusable workspace id(s) in the pinned order.`] : [],
    tooNew: false,
  };
}

/**
 * Replaces the pinned order.
 *
 * Refuses when the file on disk is newer than this plugin understands: the
 * alternative is silently discarding whatever a later version wrote.
 */
export function writeLauncherOrder(location: TraceStoreLocation, pinned: readonly string[]): LauncherOrder {
  for (const id of pinned) {
    if (!WORKSPACE_ID_PATTERN.test(id)) {
      throw new DashboardError("E_TRACE_STORE_UNWRITABLE", `not a usable workspace id: ${JSON.stringify(id)}`);
    }
  }
  const current = readLauncherOrder(location);
  if (current.tooNew) {
    throw new DashboardError(
      "E_TRACE_STORE_UNWRITABLE",
      "the pinned order file was written by a newer version of paseo-bm; refusing to overwrite it",
    );
  }

  // Duplicates would make a row appear twice; first position wins.
  const unique = [...new Set(pinned)];
  ensureStoreDir(location.tracesDir, uiDir(location));
  writeStoreFileAtomically(
    location,
    launcherOrderPath(location),
    `${JSON.stringify({ schemaVersion: LAUNCHER_ORDER_SCHEMA_VERSION, pinned: unique }, null, 2)}\n`,
  );
  return { pinned: unique, notices: [], tooNew: false };
}
