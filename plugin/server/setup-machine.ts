/**
 * The machine-wide steps of Setup that need a press, not a default
 * (Technical Design §7.13.3; ADR-012 decision 5).
 *
 * Only one thing lives here so far: Paseo's agent-tools switch.
 *
 * `daemon.mcp.injectIntoAgents` is not paseo-bm's switch. Turning it on gives
 * EVERY agent on the machine the power to create, message and stop other
 * agents — not only the three roles — which is why it is a button with a
 * warning rather than something the plugin does on first use, and why the
 * value that was there before is written down before anything is patched. The
 * order matters: with no record, "Remove paseo-bm's settings" could not tell a
 * switch paseo-bm turned on from one the user set themselves, and would either
 * leave it on or turn off something that was never ours.
 *
 * The switch is not optional (design §13 Q-044, measured on Paseo 0.9.2 with a
 * positive control): a provider's own `paseoTools.enabled` does NOT give an
 * agent Paseo's tools while this is off, so without it a Manager cannot create
 * a Worker at all.
 */
import { lstatSync, readdirSync, rmSync } from "node:fs";
import { join, sep } from "node:path";
import { DashboardError } from "../shared/contracts";
import {
  agentToolsIn,
  readRoleConfig,
  removeAllBmEntries,
  setAgentTools,
  type ConfigPaseo,
  type RoleConfigView,
} from "./config-writer";
import { resolveDataHome } from "./data-home";
import { ROLE_FALLBACK_FILE } from "./fallback-settings";
import { ROLE_FALLBACK_STATE_FILE } from "./fallback-state";
import { ROLE_EXTRAS_FILE } from "./role-extras";
import { PLUGIN_ID, confirmInstallHome, installHomeFromPluginPath, type InstallHomeFs } from "./install-home";
import { UI_DIR_NAME } from "./data-home";
import { TIMED_OUT, withTimeout } from "./role-mode";
import { ROLE_NAMES, markCleanedUpThisRun, roleId, type RoleName } from "./setup-roles";
import { SETUP_STATE_FILE_NAME, emptySetupState, readSetupState, updateSetupState, type SetupStateDeps } from "./setup-state";

export interface GrantAgentToolsResult {
  injectIntoAgents: true;
  /** False when the switch was already on: nothing was written and nothing recorded. */
  changed: boolean;
}

export type GrantAgentToolsDeps = SetupStateDeps & { now?: () => Date };

/**
 * Turns Paseo's agent tools on, after the Setup screen confirmed it with the
 * user, and records that paseo-bm is the one who did it.
 */
export async function grantAgentTools(
  paseo: unknown,
  deps: GrantAgentToolsDeps = {},
): Promise<GrantAgentToolsResult> {
  const api = paseo as ConfigPaseo;
  const { config } = await readRoleConfig(api);
  // Already on: the user (or something else) turned it on, so paseo-bm must
  // not claim it — an undo that turned it off would take away what it never
  // gave.
  if (agentToolsIn(config)) return { injectIntoAgents: true, changed: false };

  // Written BEFORE the patch, and read first so a failure can put back exactly
  // what was there. A data folder that cannot hold the record stops the whole
  // thing: without it the switch could never be undone correctly.
  const previous = readSetupState(deps).agentTools;
  updateSetupState(
    { agentTools: { setBy: "plugin", previous: false, at: (deps.now?.() ?? new Date()).toISOString() } },
    deps,
  );

  try {
    await setAgentTools(api, true);
  } catch (error) {
    try {
      updateSetupState({ agentTools: previous }, deps);
    } catch {
      // The switch is off and the record says we turned it on: a cleanup would
      // set it to `previous` (false), which is where it already is. Reporting
      // the patch failure is what the user can act on.
    }
    if (error instanceof DashboardError) throw error;
    throw new DashboardError("E_SETUP_WRITE_FAILED", error instanceof Error ? error.message : String(error), { cause: error });
  }

  return { injectIntoAgents: true, changed: true };
}

// ---------------------------------------------------------------------------
// What `setup.status` reports about this machine (design §7.13.5).
// ---------------------------------------------------------------------------

/**
 * How a role's provider signs in, as constants.
 *
 * paseo-bm never runs a login command and never sees a credential (design §9):
 * it shows the command the tool documents and lets the user run it in their own
 * terminal. A provider not in this table gets no command rather than a guess.
 */
export const PROVIDER_LOGIN_COMMANDS: Readonly<Record<string, string>> = {
  claude: "claude auth login",
  codex: "codex login",
  opencode: "opencode providers login",
};

/** Pi has no login command paseo-bm knows; this is what Setup says instead. */
export const PI_PROVIDER_ID = "pi";
export const PI_SIGN_IN_GUIDANCE =
  "Pi has no login command paseo-bm knows; sign in the way Pi's own documentation describes, then open Setup again.";

/** The one thing kept out of a provider diagnostic: whether it is signed in. */
const LOGGED_IN_PATTERN = /"loggedIn"\s*:\s*(true|false)/;

export type LoginState = "logged-in" | "logged-out" | "unknown";

/**
 * Reads one boolean out of Paseo's provider diagnostic, and nothing else.
 *
 * The diagnostic is free text that can name paths, accounts and tokens, so only
 * the match of `LOGGED_IN_PATTERN` ever leaves this function — the text is
 * never stored, returned or logged. Anything the pattern does not find is
 * `unknown`: guessing "logged out" would send a user to re-authenticate a
 * provider that was fine.
 */
export function loginStateFromDiagnostic(value: unknown): LoginState {
  const record = value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
  const text = record?.["diagnostic"];
  if (typeof text !== "string") return "unknown";
  const loggedIn = LOGGED_IN_PATTERN.exec(text)?.[1];
  return loggedIn === "true" ? "logged-in" : loggedIn === "false" ? "logged-out" : "unknown";
}

export interface ProviderLogin {
  provider: string;
  /** The roles that run on this provider, in role order. */
  roles: RoleName[];
  state: LoginState;
  loginCommand: string | null;
  guidance: string | null;
}

/**
 * The sign-in state of every distinct provider the three roles run on.
 *
 * Distinct, because two roles usually share one provider and asking twice would
 * cost a round trip for the same answer. Every lookup is raced against the
 * usual budget and a miss is `unknown`, so a slow provider never holds up the
 * Setup screen.
 */
export async function providerLogins(paseo: unknown, config: RoleConfigView): Promise<ProviderLogin[]> {
  const providers = (config.providers ?? {}) as Record<string, { extends?: unknown } | undefined>;
  const byProvider = new Map<string, RoleName[]>();
  for (const role of ROLE_NAMES) {
    const base = providers[roleId(role)]?.extends;
    if (typeof base !== "string" || base.trim() === "") continue;
    byProvider.set(base, [...(byProvider.get(base) ?? []), role]);
  }

  const diagnostic = (paseo as { providers?: { diagnostic?: unknown } } | null | undefined)?.providers?.diagnostic;
  return Promise.all(
    [...byProvider].map(async ([provider, roles]): Promise<ProviderLogin> => {
      let state: LoginState = "unknown";
      if (typeof diagnostic === "function") {
        try {
          const answer = await withTimeout(
            (diagnostic as (id: string) => Promise<unknown>).call((paseo as { providers: unknown }).providers, provider),
          );
          if (answer !== TIMED_OUT) state = loginStateFromDiagnostic(answer);
        } catch {
          state = "unknown";
        }
      }
      return {
        provider,
        roles,
        state,
        loginCommand: PROVIDER_LOGIN_COMMANDS[provider] ?? null,
        guidance: provider === PI_PROVIDER_ID ? PI_SIGN_IN_GUIDANCE : null,
      };
    }),
  );
}

export interface InstallKind {
  /** `installer-directory`: this plugin is running from a 0.3.x installer-made directory. */
  kind: "installer-directory" | "other";
  pluginPath: string | null;
}

/**
 * Whether this plugin is running from a directory the old installer laid out.
 *
 * The shape of the registered path plus an `install.json` beside it is the
 * whole test — there is no `paseo plugin ls` call, because `config.get()` has
 * already been read and a directory install is exactly what the CLI wrote.
 * Setup uses it to show the banner that asks the user to run the migration
 * command once and move to the npm install.
 */
export function installKind(config: { plugins?: Record<string, unknown> | null }, fs: InstallHomeFs): InstallKind {
  const entry = config.plugins?.[PLUGIN_ID];
  const pluginPath =
    entry !== null && typeof entry === "object" && typeof (entry as { path?: unknown }).path === "string"
      ? ((entry as { path: string }).path)
      : null;
  if (pluginPath === null) return { kind: "other", pluginPath: null };
  const home = installHomeFromPluginPath(pluginPath);
  if (home === null) return { kind: "other", pluginPath };
  return { kind: confirmInstallHome(home, fs).ok ? "installer-directory" : "other", pluginPath };
}

// ---------------------------------------------------------------------------
// "Remove paseo-bm's settings" (design §7.13.7, ADR-012 decision 6).
// ---------------------------------------------------------------------------

export interface CleanupResult {
  removedProviders: string[];
  removedProfiles: string[];
  /**
   * `restored`: the switch was paseo-bm's and was put back. `left-on`: it was
   * on, but somebody else turned it on, so it stays. `off`: it was already off.
   */
  agentTools: "restored" | "left-on" | "off";
  /** `null` unless the user confirmed deleting the data folder's contents. */
  data: { deleted: string[]; kept: string[] } | null;
  nextCommand: "paseo plugin remove paseo-bm";
}

export const CLEANUP_NEXT_COMMAND = "paseo plugin remove paseo-bm" as const;

/**
 * The items in the data folder the plugin created, and may therefore delete.
 *
 * A fixed list, not a sweep: everything else in that folder belongs to somebody
 * else — `home.json` is the CLI's, `install.json`, `plugin/` and `backups/` are
 * the old installer's (and while the plugin runs from a directory install, its
 * own code is inside `plugin/`), and anything unrecognised is the user's.
 *
 * `ui/setup-state.json` is deliberately not here even though the plugin wrote
 * it: it carries `cleanedUpAt`, and without that mark one plugin reload before
 * the user gets around to `paseo plugin remove` would recreate the three roles
 * they just removed (REQ-012 e, owner decision D1).
 */
export const CLEANUP_DELETES: readonly string[] = [
  "traces",
  ROLE_EXTRAS_FILE,
  ROLE_FALLBACK_FILE,
  ROLE_FALLBACK_STATE_FILE,
];

export type CleanupDeps = SetupStateDeps & { now?: () => Date };

/**
 * Removes every trace of paseo-bm from Paseo's configuration, and optionally
 * the data the plugin wrote.
 *
 * The order is the point. The switch is restored and the entries removed first,
 * because that is the part the user cannot do by hand; the cleanup mark is
 * written next, so a plugin reload before `paseo plugin remove` does not
 * recreate the roles; the files go last and never throw, because a file that
 * will not delete is worth a line on screen, not an undone cleanup.
 */
export async function cleanupPaseoBm(
  paseo: unknown,
  input: { deleteData: boolean },
  deps: CleanupDeps = {},
): Promise<CleanupResult> {
  const api = paseo as ConfigPaseo;
  const { config } = await readRoleConfig(api);

  let state = emptySetupState();
  try {
    state = readSetupState(deps);
  } catch {
    // No readable state means no record that paseo-bm turned the switch on,
    // which is exactly the case where it must be left alone.
  }

  const on = agentToolsIn(config);
  const ours = state.agentTools !== null;
  const agentTools: CleanupResult["agentTools"] = !on ? "off" : ours ? "restored" : "left-on";
  const restore = agentTools === "restored" ? (state.agentTools?.previous ?? false) : null;

  const removed = await removeAllBmEntries(api, restore);

  // Only after the configuration is really clean: a mark written before a
  // failed patch would stop the roles being recreated while they still exist.
  markCleanedUpThisRun(true);
  try {
    updateSetupState({ cleanedUpAt: (deps.now?.() ?? new Date()).toISOString(), agentTools: null }, deps);
  } catch {
    // The in-run flag still holds until the plugin reloads; `data.kept` below
    // shows the user that the folder is not writable.
  }

  return {
    removedProviders: removed.removedProviders,
    removedProfiles: removed.removedProfiles,
    agentTools,
    data: input.deleteData ? deleteDataFiles(deps) : null,
    nextCommand: CLEANUP_NEXT_COMMAND,
  };
}

/**
 * Deletes exactly the items of `CLEANUP_DELETES`, plus everything in `ui/`
 * except the setup state. Never throws and never follows a symlink.
 */
function deleteDataFiles(deps: CleanupDeps): { deleted: string[]; kept: string[] } {
  const deleted: string[] = [];
  const kept: string[] = [];
  const resolution = resolveDataHome(deps);
  if (resolution.home === null) return { deleted, kept: [`the data folder could not be used (${resolution.reason})`] };
  const home = resolution.home;

  /**
   * The first symlink between the data folder and `relative`, or `null`.
   *
   * Checking only the last component is not enough, and that was the hole
   * review b1 found: `readdir` follows a symlinked `ui/`, and the `lstat` of
   * `ui/<name>` then resolves through it and reports an ordinary file, so the
   * delete lands outside the folder. Every component from the data folder down
   * is therefore checked before anything is read or removed.
   */
  const symlinkOn = (relative: string): string | null => {
    try {
      if (lstatSync(home).isSymbolicLink()) return "the data folder";
    } catch {
      return null;
    }
    let current = home;
    const walked: string[] = [];
    for (const part of relative.split(sep)) {
      if (part === "" || part === ".") continue;
      current = join(current, part);
      walked.push(part);
      let entry;
      try {
        entry = lstatSync(current);
      } catch {
        // Nothing below an absent component exists either, so nothing can be
        // reached through it.
        return null;
      }
      if (entry.isSymbolicLink()) return walked.join("/");
    }
    return null;
  };

  const remove = (relative: string): void => {
    const path = join(home, relative);
    const linked = symlinkOn(relative);
    if (linked !== null) {
      kept.push(`${relative} (${linked} is a symlink; paseo-bm did not create it)`);
      return;
    }
    try {
      lstatSync(path);
    } catch (error) {
      // Not there at all is not worth a line; anything else is.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") kept.push(`${relative} (${(error as Error).message})`);
      return;
    }
    try {
      rmSync(path, { recursive: true, force: false });
      deleted.push(relative);
    } catch (error) {
      kept.push(`${relative} (${(error as Error).message})`);
    }
  };

  for (const name of CLEANUP_DELETES) remove(name);

  const uiDir = join(home, UI_DIR_NAME);
  const uiLinked = symlinkOn(UI_DIR_NAME);
  let inUi: string[] = [];
  if (uiLinked !== null) {
    // Not even listed: `readdir` would follow the link.
    kept.push(`${UI_DIR_NAME} (${uiLinked} is a symlink; paseo-bm did not create it)`);
  } else {
    try {
      inUi = readdirSync(uiDir);
    } catch {
      inUi = [];
    }
  }
  for (const name of inUi) {
    if (name === SETUP_STATE_FILE_NAME) {
      kept.push(`${UI_DIR_NAME}/${name} (it records that you removed paseo-bm's settings)`);
      continue;
    }
    remove(join(UI_DIR_NAME, name));
  }

  // Everything else in the folder belongs to somebody else.
  try {
    if (lstatSync(home).isSymbolicLink()) throw new Error("the data folder is a symlink");
    for (const name of readdirSync(home)) {
      if (name === UI_DIR_NAME || (CLEANUP_DELETES as readonly string[]).includes(name)) continue;
      kept.push(`${name} (paseo-bm did not create it)`);
    }
  } catch {
    // The folder is gone or unreadable; there is nothing left to report.
  }

  return { deleted, kept };
}
