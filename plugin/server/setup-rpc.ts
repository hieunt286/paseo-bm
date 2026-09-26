/**
 * RPCs of the Setup screen (delta 20260916-setup-screen).
 */
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { join } from "node:path";
import {
  BASE_INSTRUCTIONS,
  MAX_EXTRA_CHARS,
  ROLE_EXTRAS_FILE,
  fullInstructions,
  dataHomeOf,
  readRoleExtras,
  saveRoleExtra,
  type Role,
} from "./role-extras";
import { readFileSync } from "node:fs";
import { resolveDataHome, unusableDataHomeMessage } from "./data-home";
import { agentToolsIn, readRoleConfig, type ConfigPaseo, type RoleConfigView } from "./config-writer";
import { cleanupPaseoBm, grantAgentTools, installKind, providerLogins } from "./setup-machine";
import { ROLE_NAMES, ensureRoles, roleId } from "./setup-roles";
import { emptySetupState, readSetupState } from "./setup-state";
import { installSkills, skillsStatus, type SkillDeps } from "./setup-skills";
import { LATEST_KNOWN, installTool, toolsStatus, type ToolDeps } from "./setup-tools";
import { toolsSeen } from "./tools-check";
import {
  DashboardError,
  rolesInstructionsRpc,
  rolesSaveExtraRpc,
  setupCleanupRpc,
  setupEnsureRolesRpc,
  setupGrantAgentToolsRpc,
  setupInstallSkillsRpc,
  setupInstallToolRpc,
  setupStatusRpc,
  type SetupStatus,
} from "../shared/contracts";

export interface SetupDeps extends ToolDeps, SkillDeps {}

async function requireHome(paseo: unknown, deps: SetupDeps): Promise<string> {
  const home = dataHomeOf(deps);
  if (home === null) throw new DashboardError("E_ROLE_EXTRA_INVALID", `cannot save: ${unusableDataHomeMessage()}`);
  return home;
}

export async function handleSetupStatus(paseo: unknown, deps: SetupDeps = {}): Promise<SetupStatus> {
  const home = dataHomeOf(deps);
  const extras = home === null ? { manager: "", worker: "", reviewer: "" } : readRoleExtras(home);
  return {
    tools: await toolsStatus(deps),
    latestCheckedOn: LATEST_KNOWN.checkedOn,
    skills: skillsStatus(deps),
    extras: { manager: extras.manager.length, worker: extras.worker.length, reviewer: extras.reviewer.length },
    paseoTools: toolsSeen(),
    setup: await machineSetup(paseo, deps),
  };
}

/**
 * Everything the Setup screen shows about this machine, read only (§7.13.5).
 *
 * Every part degrades on its own: a configuration that cannot be read leaves
 * the roles unknown rather than failing the whole call, because the screen that
 * would tell the user how to fix it is the one asking.
 */
async function machineSetup(paseo: unknown, deps: SetupDeps): Promise<SetupStatus["setup"]> {
  let config: RoleConfigView = {};
  let readable = true;
  try {
    config = (await readRoleConfig(paseo as ConfigPaseo)).config;
  } catch {
    readable = false;
  }

  const providers = (config.providers ?? {}) as Record<string, unknown>;
  const profiles = Array.isArray(config.agentProfiles) ? config.agentProfiles : [];
  const present = ROLE_NAMES.filter(
    (role) =>
      Object.prototype.hasOwnProperty.call(providers, roleId(role)) && profiles.some((entry) => entry?.id === roleId(role)),
  );

  let state = emptySetupState();
  try {
    state = readSetupState(deps);
  } catch {
    // An unusable data folder is reported in `dataHome` below; the rest of the
    // screen is still worth showing.
  }

  const resolution = resolveDataHome(deps);
  return {
    roles: {
      present,
      missing: ROLE_NAMES.filter((role) => !present.includes(role)),
      created: state.rolesCreated,
      cleanedUpAt: state.cleanedUpAt,
    },
    agentTools: {
      injectIntoAgents: readable ? agentToolsIn(config) : null,
      setBy: state.agentTools?.setBy ?? null,
    },
    logins: await providerLogins(paseo, config),
    skillsRun: state.skillsRun,
    dataHome:
      resolution.home === null
        ? { path: null, source: null, reason: resolution.reason }
        : { path: resolution.home, source: resolution.source, reason: null },
    install: installKind(config as { plugins?: Record<string, unknown> | null }, {
      readFileSync: (path, encoding) => readFileSync(path, encoding),
    }),
  };
}

export async function handleRolesInstructions(input: { role: Role }, paseo: unknown, deps: SetupDeps = {}) {
  const home = dataHomeOf(deps);
  const extra = home === null ? "" : readRoleExtras(home)[input.role];
  return {
    base: BASE_INSTRUCTIONS[input.role],
    extra,
    full: fullInstructions(input.role, extra),
    path: home === null ? null : join(home, ROLE_EXTRAS_FILE),
    maxChars: MAX_EXTRA_CHARS,
  };
}

export async function handleRolesSaveExtra(input: { role: Role; text: string }, paseo: unknown, deps: SetupDeps = {}) {
  const roles = saveRoleExtra(await requireHome(paseo, deps), input.role, input.text);
  return { extra: roles[input.role], full: fullInstructions(input.role, roles[input.role]) };
}

export function registerSetupRpcs(server: PluginServerContext): void {
  server.handle(setupStatusRpc, (_input, context) => handleSetupStatus(context.paseo));
  server.handle(setupEnsureRolesRpc, (input, context) =>
    ensureRoles(context.paseo, input.resume === undefined ? {} : { resume: input.resume }),
  );
  server.handle(setupCleanupRpc, (input, context) => cleanupPaseoBm(context.paseo, { deleteData: input.deleteData }));
  server.handle(setupGrantAgentToolsRpc, (_input, context) => grantAgentTools(context.paseo));
  server.handle(setupInstallSkillsRpc, () => installSkills());
  server.handle(setupInstallToolRpc, (input) => installTool(input.tool));
  server.handle(rolesInstructionsRpc, (input, context) => handleRolesInstructions(input, context.paseo));
  server.handle(rolesSaveExtraRpc, (input, context) => handleRolesSaveExtra(input, context.paseo));
}
