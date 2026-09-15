// The payload tsconfig loads only React types; the daemon-side entry runs on
// Node, so it pulls Node's types in explicitly (client/ and shared/ must not).
/// <reference types="node" />
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { readFile } from "node:fs/promises";
import { ensureManager, listWorkspaceAgents } from "./server/manager";
import { describeRoles } from "./server/roles";
import { agentsListRpc, managerEnsureRpc, rolesDescribeRpc } from "./shared/contracts";

type ServerContribution = (server: PluginServerContext) => () => void;

/**
 * Location of the Manager instructions inside the installed payload. Resolved
 * relative to this entry, which sits at the payload root next to `roles/`.
 */
const MANAGER_INSTRUCTIONS_URL = new URL("./roles/manager.md", import.meta.url);

export function readManagerInstructions(): Promise<string> {
  return readFile(MANAGER_INSTRUCTIONS_URL, "utf8");
}

/**
 * Location of the install record. The installer copies this payload to
 * `<install home>/plugin/<version>/` (design §3.1), so the record sits two
 * directories above this entry. Resolved from the running payload rather than
 * from HOME, so `--home` / `PASEO_BM_HOME` installs are found too.
 */
export const INSTALL_RECORD_URL = new URL("../../install.json", import.meta.url);

/** Text of `install.json`, or `null` when there is none. */
export async function readInstallRecord(url: URL = INSTALL_RECORD_URL): Promise<string | null> {
  try {
    return await readFile(url, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/**
 * Server entry of the paseo-bm plugin.
 *
 * WP-112 registers `manager.ensure`, `agents.list` and `roles.describe`. All
 * three only read or create; there is deliberately no RPC that deletes or archives agents:
 * their lifecycle belongs to the user (ADR-005).
 *
 * This entry must never import from `client/`: that is a compile error.
 */
const contribute: ServerContribution = (server) => {
  server.handle(managerEnsureRpc, async (input, { paseo }) => {
    const result = await ensureManager(input, {
      paseo,
      readInstructions: readManagerInstructions,
    });
    if (result.otherManagerIds.length > 0) {
      console.warn(
        `[paseo-bm] workspace ${input.workspaceId} has ${result.otherManagerIds.length + 1} live Managers; using the newest (${result.agentId}). Left untouched: ${result.otherManagerIds.join(", ")}.`,
      );
    }
    return result;
  });
  server.handle(agentsListRpc, (input, { paseo }) => listWorkspaceAgents(input, { paseo }));
  server.handle(rolesDescribeRpc, () => describeRoles({ readRecord: () => readInstallRecord() }));
  return () => {};
};

export default contribute;
