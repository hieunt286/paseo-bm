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
  installHomeOf,
  readRoleExtras,
  saveRoleExtra,
  type Role,
} from "./role-extras";
import { skillsStatus, type SkillDeps } from "./setup-skills";
import { LATEST_KNOWN, installTool, toolsStatus, type ToolDeps } from "./setup-tools";
import { toolsSeen } from "./tools-check";
import {
  DashboardError,
  rolesInstructionsRpc,
  rolesSaveExtraRpc,
  setupInstallToolRpc,
  setupStatusRpc,
  type SetupStatus,
} from "../shared/contracts";

export interface SetupDeps extends ToolDeps, SkillDeps {}

async function requireHome(paseo: unknown, deps: SetupDeps): Promise<string> {
  const home = await installHomeOf(paseo, deps);
  if (home === null) throw new DashboardError("E_ROLE_EXTRA_INVALID", "cannot save: the paseo-bm install home cannot be found");
  return home;
}

export async function handleSetupStatus(paseo: unknown, deps: SetupDeps = {}): Promise<SetupStatus> {
  const home = await installHomeOf(paseo, deps);
  const extras = home === null ? { manager: "", worker: "", reviewer: "" } : readRoleExtras(home);
  return {
    tools: await toolsStatus(deps),
    latestCheckedOn: LATEST_KNOWN.checkedOn,
    skills: skillsStatus(deps),
    extras: { manager: extras.manager.length, worker: extras.worker.length, reviewer: extras.reviewer.length },
    paseoTools: toolsSeen(),
  };
}

export async function handleRolesInstructions(input: { role: Role }, paseo: unknown, deps: SetupDeps = {}) {
  const home = await installHomeOf(paseo, deps);
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
  server.handle(setupInstallToolRpc, (input) => installTool(input.tool));
  server.handle(rolesInstructionsRpc, (input, context) => handleRolesInstructions(input, context.paseo));
  server.handle(rolesSaveExtraRpc, (input, context) => handleRolesSaveExtra(input, context.paseo));
}
