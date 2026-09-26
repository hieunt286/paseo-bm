/**
 * `<data home>/ui/setup-state.json` — what the plugin remembers about setting
 * up this machine (Technical Design §5.3, §5.4).
 *
 * This file replaces the only part of the installer's `install.json` the plugin
 * still needs. Three of its four fields exist because an undo has to be exact:
 *
 * - `agentTools` is present **if and only if** paseo-bm turned
 *   `daemon.mcp.injectIntoAgents` on, and carries the value that was there
 *   before. Without it, "Remove paseo-bm's settings" would either leave the
 *   switch on for every agent on the machine or turn off a switch the user set
 *   themselves. It is written *before* the patch for the same reason.
 * - `rolesCreated` is what lets Setup say the three roles were created with
 *   defaults and can be changed in the Agents tab.
 * - `cleanedUpAt` is the mark that stops the plugin creating the roles again
 *   after the user removed them — which is why the cleanup button keeps this
 *   one file and deletes the rest (design §7.13.7).
 *
 * `skillsRun` is only ever displayed.
 *
 * The file never holds a secret or a path to one, and reads never repair it: a
 * file from a newer build reads as empty and is not overwritten, because
 * rewriting it would destroy a field this build cannot represent.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { DashboardError } from "../shared/contracts";
import { UI_DIR_NAME } from "./data-home";
import { ensureDataHome, resolveDataHome, type DataHomeDeps, type DataHomeResolution } from "./data-home";
import { assertNoSymlinkOnPath, ensureStoreDir, writeStoreFileAtomically } from "./trace-store";

/** Bumped only when the shape below changes incompatibly. */
export const SETUP_STATE_SCHEMA_VERSION = 1;
export const SETUP_STATE_FILE_NAME = "setup-state.json";

/** The roles the plugin creates, in the order Setup lists them. */
export const SETUP_ROLE_NAMES = ["manager", "worker", "reviewer"] as const;
export type SetupRoleName = (typeof SETUP_ROLE_NAMES)[number];

const agentToolsMarkSchema = z.object({
  /** Who turned the switch on: this plugin, or the 0.4.0 CLI on behalf of a 0.3.x install. */
  setBy: z.enum(["plugin", "installer"]),
  /** What `daemon.mcp.injectIntoAgents` was before. */
  previous: z.boolean(),
  at: z.string().min(1),
});

const rolesCreatedMarkSchema = z.object({
  at: z.string().min(1),
  roles: z.array(z.enum(SETUP_ROLE_NAMES)),
  baseProvider: z.string().min(1),
  model: z.string().min(1),
});

const skillsRunMarkSchema = z.object({
  at: z.string().min(1),
  command: z.string().min(1),
  code: z.number().int(),
  outcome: z.enum(["ok", "failed", "timeout"]),
});

export type AgentToolsMark = z.infer<typeof agentToolsMarkSchema>;
export type RolesCreatedMark = z.infer<typeof rolesCreatedMarkSchema>;
export type SkillsRunMark = z.infer<typeof skillsRunMarkSchema>;

/** Everything the file holds, without the schema version. */
export interface SetupState {
  agentTools: AgentToolsMark | null;
  rolesCreated: RolesCreatedMark | null;
  skillsRun: SkillsRunMark | null;
  cleanedUpAt: string | null;
}

const setupStateFileSchema = z.object({
  schemaVersion: z.number().int().positive(),
  agentTools: agentToolsMarkSchema.nullish(),
  rolesCreated: rolesCreatedMarkSchema.nullish(),
  skillsRun: skillsRunMarkSchema.nullish(),
  cleanedUpAt: z.string().min(1).nullish(),
});

/** What every field reads as before anything has been set up. */
export function emptySetupState(): SetupState {
  return { agentTools: null, rolesCreated: null, skillsRun: null, cleanedUpAt: null };
}

export interface SetupStateDeps extends DataHomeDeps {
  /**
   * A data folder resolved already. An RPC handler resolves once and passes it
   * down, so the whole request agrees on one folder even if the environment
   * changes underneath it.
   */
  resolution?: DataHomeResolution;
}

function unavailable(detail: string, cause?: unknown): DashboardError {
  return new DashboardError("E_DATA_HOME_UNAVAILABLE", detail, cause ? { cause } : undefined);
}

/** The data folder, or the coded error that says why there is none. */
function requireDataHome(deps: SetupStateDeps): { home: string; tracesDir: string } {
  const resolution = deps.resolution ?? resolveDataHome(deps);
  if (resolution.home === null) {
    throw unavailable(`the paseo-bm data folder is not usable: ${resolution.reason}`);
  }
  return { home: resolution.home, tracesDir: resolution.tracesDir };
}

/** `<data home>/ui/setup-state.json`. */
export function setupStatePath(home: string): string {
  return join(home, UI_DIR_NAME, SETUP_STATE_FILE_NAME);
}

/**
 * Reads the file without touching it.
 *
 * `tooNew` is separate from the state because the two answers are different:
 * an absent file and a file this build cannot read both give the empty state,
 * but only the second one makes writing unsafe.
 */
function readFile(home: string): { state: SetupState; tooNew: boolean } {
  const path = setupStatePath(home);
  // Before the read, so a symlinked `ui/` or file is refused, not followed.
  // The guard speaks the trace store's code; every failure of this file is one
  // thing to the caller — the data folder cannot be used — so it is re-coded.
  try {
    assertNoSymlinkOnPath(home, path);
  } catch (error) {
    throw unavailable(`cannot use ${path}: ${error instanceof Error ? error.message : String(error)}`, error);
  }

  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return { state: emptySetupState(), tooNew: false };
    throw unavailable(`cannot read ${path}`, error);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { state: emptySetupState(), tooNew: false };
  }

  const result = setupStateFileSchema.safeParse(parsed);
  if (!result.success) return { state: emptySetupState(), tooNew: false };
  if (result.data.schemaVersion > SETUP_STATE_SCHEMA_VERSION) {
    return { state: emptySetupState(), tooNew: true };
  }

  return {
    state: {
      agentTools: result.data.agentTools ?? null,
      rolesCreated: result.data.rolesCreated ?? null,
      skillsRun: result.data.skillsRun ?? null,
      cleanedUpAt: result.data.cleanedUpAt ?? null,
    },
    tooNew: false,
  };
}

/**
 * The stored setup state, or the empty one.
 *
 * Nothing is created: a missing folder and a missing file both read as empty,
 * which is what a machine that has never been set up looks like.
 */
export function readSetupState(deps: SetupStateDeps = {}): SetupState {
  return readFile(requireDataHome(deps).home).state;
}

/** Replaces the whole file. `updateSetupState` is the usual way in. */
export function writeSetupState(state: SetupState, deps: SetupStateDeps = {}): SetupState {
  const { home, tracesDir } = requireDataHome(deps);
  const path = setupStatePath(home);

  if (readFile(home).tooNew) {
    throw unavailable(
      `${path} was written by a newer paseo-bm than this one (schemaVersion above ${SETUP_STATE_SCHEMA_VERSION}); refusing to overwrite it`,
    );
  }

  try {
    ensureDataHome(home, deps);
    ensureStoreDir(tracesDir, dirname(path));
    const body = JSON.stringify({ schemaVersion: SETUP_STATE_SCHEMA_VERSION, ...state }, null, 2);
    writeStoreFileAtomically({ tracesDir }, path, `${body}\n`);
  } catch (error) {
    if (error instanceof DashboardError && error.code === "E_DATA_HOME_UNAVAILABLE") throw error;
    throw unavailable(`cannot write ${path}: ${error instanceof Error ? error.message : String(error)}`, error);
  }

  return state;
}

/**
 * Sets the named fields and leaves the rest as they were.
 *
 * Read-modify-write in one call, because every caller is recording one thing
 * (the switch it is about to flip, the roles it just created) and must not
 * blank out what another part of Setup recorded earlier.
 */
export function updateSetupState(patch: Partial<SetupState>, deps: SetupStateDeps = {}): SetupState {
  const resolution = deps.resolution ?? resolveDataHome(deps);
  const withResolution: SetupStateDeps = { ...deps, resolution };
  const current = readSetupState(withResolution);
  return writeSetupState({ ...current, ...patch }, withResolution);
}
