/**
 * RPCs behind Settings' set-up blocks (from the Setup screen, delta 20260916-setup-screen).
 */
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { resolveDataHome } from "./data-home";
import { agentToolsIn, readRoleConfig, type ConfigPaseo, type RoleConfigView } from "./config-writer";
import { cleanupPaseoBm, grantAgentTools, providerLogins } from "./setup-machine";
import { ROLE_NAMES, ensureRoles, roleId } from "./setup-roles";
import { emptySetupState, readSetupState } from "./setup-state";
import { installSkills, skillsStatus, type SkillDeps } from "./setup-skills";
import { LATEST_KNOWN, installTool, keptToolsStatus, type ToolDeps } from "./setup-tools";
import { toolsSeen } from "./tools-check";
import {
  setupCleanupRpc,
  setupEnsureRolesRpc,
  setupGrantAgentToolsRpc,
  setupInstallSkillsRpc,
  setupInstallToolRpc,
  setupStatusRpc,
  type SetupStatus,
} from "../shared/contracts";

export interface SetupDeps extends ToolDeps, SkillDeps {}

export async function handleSetupStatus(paseo: unknown, deps: SetupDeps = {}, options: { fresh?: boolean } = {}): Promise<SetupStatus> {
  return {
    tools: await keptToolsStatus(options, deps),
    latestCheckedOn: LATEST_KNOWN.checkedOn,
    skills: skillsStatus(deps),
    paseoTools: toolsSeen(),
    setup: await machineSetup(paseo, deps),
  };
}

/**
 * Everything Settings shows about this machine, read only (§7.13.5).
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
  };
}

export function registerSetupRpcs(server: PluginServerContext): void {
  server.handle(setupStatusRpc, (input, context) => handleSetupStatus(context.paseo, {}, { fresh: input.fresh === true }));
  server.handle(setupEnsureRolesRpc, (input, context) =>
    ensureRoles(context.paseo, input.resume === undefined ? {} : { resume: input.resume }),
  );
  server.handle(setupCleanupRpc, (input, context) => cleanupPaseoBm(context.paseo, { deleteData: input.deleteData }));
  server.handle(setupGrantAgentToolsRpc, (_input, context) => grantAgentTools(context.paseo));
  server.handle(setupInstallSkillsRpc, () => installSkills());
  server.handle(setupInstallToolRpc, (input) => installTool(input.tool));
}
