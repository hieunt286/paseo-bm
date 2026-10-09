/**
 * The plugin's own homes are not projects (missions design §3.1; REQ-185 b):
 * the Missions home (`missions-home.ts`) and the Orchestrator home
 * (`orchestrator-agent.ts`) are workspaces Paseo lists, and every project view
 * leaves them out through `isPluginHome`. `listedWorkspaces` stays raw: the
 * creation hook's `workspaceOfFolder` needs the Missions home to bind a Main
 * created there.
 */
import { isAbsolute, join, resolve } from "node:path";
import { TRACES_DIR_NAME } from "./data-home";
import { isMissionsHome } from "./missions-home";
import { orchestratorHomeOf } from "./orchestrator-agent";
import type { ListedWorkspace } from "./paseo-directory";
import { dataHome } from "./rpc-kit";
import { readWorkspaceMeta } from "./trace-store";

/** True when `directory` is one of the homes' folders. */
function isHomeFolder(directory: string, home: string): boolean {
  return isAbsolute(directory) && (isMissionsHome(directory, home) || resolve(directory) === resolve(orchestratorHomeOf(home)));
}

/**
 * True when `workspaceIdOrDirectory` is a plugin home: the Missions home's
 * cached id, either home's folder, or a workspace the trace store last saw in
 * one of those folders (the Orchestrator home's id is cached nowhere else).
 * Never throws.
 */
export function isPluginHome(workspaceIdOrDirectory: string | null | undefined, home: string | null = dataHome()): boolean {
  if (home === null || typeof workspaceIdOrDirectory !== "string" || workspaceIdOrDirectory === "") return false;
  try {
    if (isMissionsHome(workspaceIdOrDirectory, home) || isHomeFolder(workspaceIdOrDirectory, home)) return true;
    if (isAbsolute(workspaceIdOrDirectory)) return false;
    const seen = readWorkspaceMeta({ tracesDir: join(home, TRACES_DIR_NAME) }, workspaceIdOrDirectory)?.lastKnownDirectory ?? null;
    return seen !== null && isHomeFolder(seen, home);
  } catch {
    return false;
  }
}

/** `isPluginHome` of a workspace by its id or the directory a `listedWorkspaces` list gives it. Never throws. */
export function isPluginHomeIn(workspaceId: string, listed: readonly ListedWorkspace[] | null, home: string | null = dataHome()): boolean {
  return isPluginHome(workspaceId, home) || isPluginHome(listed?.find((entry) => entry.id === workspaceId)?.directory, home);
}
