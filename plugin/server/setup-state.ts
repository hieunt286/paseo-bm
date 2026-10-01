/**
 * `<data home>/ui/setup-state.json` — what the plugin remembers about setting
 * up this machine (Technical Design §5.3, §5.4).
 *
 * This file replaces the only part of the installer's `install.json` the plugin
 * still needs. Three of its five fields exist because an undo has to be exact:
 *
 * - `agentTools` is present **if and only if** paseo-bm turned
 *   `daemon.mcp.injectIntoAgents` on, and carries the value that was there
 *   before. Without it, "Remove paseo-bm's settings" would either leave the
 *   switch on for every agent on the machine or turn off a switch the user set
 *   themselves. It is written *before* the patch for the same reason.
 * - `rolesCreated` is what lets Setup say the three roles were created with
 *   defaults — and where the Reviewer went, when it went to another model
 *   family — and can be changed in the Agents tab.
 * - `cleanedUpAt` is the mark that stops the plugin creating the roles again
 *   after the user removed them — which is why the cleanup button keeps this
 *   one file and deletes the rest (design §7.13.7).
 *
 * `skillsRun` is only ever displayed. `orchestratorCreatedAt` is when the
 * plugin created the fourth role, `bm-orchestrator`; it is a field of its own
 * rather than a fourth value of `rolesCreated.roles` because 0.4.1 parses the
 * whole file with the three-role enum below, and one value it does not know
 * would make it read the file as empty and lose `agentTools` and
 * `cleanedUpAt` (orchestrator design §3.2, §10). An older release drops the
 * unknown field and keeps the rest.
 *
 * The file never holds a secret or a path to one, and reads never repair it: a
 * file from a newer build reads as empty and is not overwritten, because
 * rewriting it would destroy a field this build cannot represent. The file
 * rules are every store's (`data-files.ts` `createJsonFileStore`, code review
 * 2026-09-30 §3.1), with one code for every failure — a symlink on the way, a
 * write that fails, a newer file refused: `E_DATA_HOME_UNAVAILABLE`, the data
 * folder cannot be used. A file that cannot be read or parsed reads as empty,
 * and the next write replaces it.
 */
import { join } from "node:path";
import { z } from "zod";
import { DashboardError } from "../shared/contracts";
import { createJsonFileStore, type JsonFileStore } from "./data-files";
import { UI_DIR_NAME } from "./data-home";
import { resolveDataHome, type DataHomeDeps, type DataHomeResolution } from "./data-home";

/** Bumped only when the shape below changes incompatibly. */
export const SETUP_STATE_SCHEMA_VERSION = 1;
export const SETUP_STATE_FILE_NAME = "setup-state.json";

/**
 * The roles `rolesCreated.roles` may name, in the order Setup lists them.
 * Three on purpose: see `orchestratorCreatedAt` above.
 */
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
  /**
   * The Reviewer's own provider and model, only when it was created on
   * another model family's provider than `baseProvider` (autonomy design
   * §C.5). Optional, so a file without it reads as before; 0.4.1 drops it.
   */
  reviewer: z.object({ baseProvider: z.string().min(1), model: z.string().min(1) }).optional(),
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
  /** When the plugin created `bm-orchestrator`; `null` when it did not. */
  orchestratorCreatedAt: string | null;
}

/** The file's content after its `schemaVersion` (1), all or nothing: one field that does not validate makes the file read as empty. */
const setupStateBodySchema = z.object({
  agentTools: agentToolsMarkSchema.nullish(),
  rolesCreated: rolesCreatedMarkSchema.nullish(),
  skillsRun: skillsRunMarkSchema.nullish(),
  cleanedUpAt: z.string().min(1).nullish(),
  orchestratorCreatedAt: z.string().min(1).nullish(),
});

/** What every field reads as before anything has been set up. */
export function emptySetupState(): SetupState {
  return { agentTools: null, rolesCreated: null, skillsRun: null, cleanedUpAt: null, orchestratorCreatedAt: null };
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
function requireDataHome(deps: SetupStateDeps): string {
  const resolution = deps.resolution ?? resolveDataHome(deps);
  if (resolution.home === null) {
    throw unavailable(`the paseo-bm data folder is not usable: ${resolution.reason}`);
  }
  return resolution.home;
}

/** `<data home>/ui/setup-state.json`. */
export function setupStatePath(home: string): string {
  return join(home, UI_DIR_NAME, SETUP_STATE_FILE_NAME);
}

/** The file in the data folder `home`. Creating it touches nothing on disk. */
function setupStateFile(home: string): JsonFileStore<SetupState> {
  return createJsonFileStore<SetupState>({
    home,
    dir: UI_DIR_NAME,
    file: SETUP_STATE_FILE_NAME,
    version: SETUP_STATE_SCHEMA_VERSION,
    versionKey: "schemaVersion",
    parse: (body) => {
      const result = setupStateBodySchema.safeParse(body);
      if (!result.success) throw new Error("the setup state does not have the expected shape");
      return {
        agentTools: result.data.agentTools ?? null,
        rolesCreated: result.data.rolesCreated ?? null,
        skillsRun: result.data.skillsRun ?? null,
        cleanedUpAt: result.data.cleanedUpAt ?? null,
        orchestratorCreatedAt: result.data.orchestratorCreatedAt ?? null,
      };
    },
    empty: emptySetupState,
    codes: { unwritable: "E_DATA_HOME_UNAVAILABLE" },
  });
}

/**
 * The stored setup state, or the empty one.
 *
 * Nothing is created: a missing folder and a missing file both read as empty,
 * which is what a machine that has never been set up looks like.
 */
export function readSetupState(deps: SetupStateDeps = {}): SetupState {
  return setupStateFile(requireDataHome(deps)).read();
}

/** Replaces the whole file. `updateSetupState` is the usual way in. */
export function writeSetupState(state: SetupState, deps: SetupStateDeps = {}): SetupState {
  setupStateFile(requireDataHome(deps)).write(state);
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
  return setupStateFile(requireDataHome(deps)).update((current) => ({ ...current, ...patch }));
}
