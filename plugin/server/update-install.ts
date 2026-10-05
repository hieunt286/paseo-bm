/** REQ-174: confirmed update of the fixed npm-installed paseo-bm plugin. */
import { execFile } from "node:child_process";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { updatesInstallRpc, type UpdatesInstallOutput } from "../shared/contracts";
import { redactText } from "./collector";
import { findTool } from "./setup-tools";
import { cachedLatestVersion } from "./update-check";
import type { RpcHomeDeps } from "./rpc-kit";

export const UPDATE_INSTALL_TIMEOUT_MS = 120_000;
export const UPDATE_INSTALL_MAX_BUFFER = 1024 * 1024;
export const UPDATE_COMMAND = "paseo plugin update paseo-bm" as const;
const LIST_ARGS = ["plugin", "ls", "--json"] as const;
const UPDATE_ARGS = ["plugin", "update", "paseo-bm", "--json"] as const;

interface Outcome {
  code: number;
  output: string;
  timedOut: boolean;
}

export type UpdateInstallRunner = (file: string, args: readonly string[], timeoutMs: number, maxBuffer: number) => Promise<Outcome>;

export interface UpdateInstallDeps extends RpcHomeDeps {
  find?: () => string | null;
  run?: UpdateInstallRunner;
  env?: NodeJS.ProcessEnv;
  latestVersion?: () => string | null;
}

function runExecFile(file: string, args: readonly string[], timeoutMs: number, maxBuffer: number): Promise<Outcome> {
  return new Promise((resolve) => {
    execFile(file, [...args], { timeout: timeoutMs, maxBuffer }, (error, stdout, stderr) => {
      const failure = error as (Error & { code?: unknown; killed?: boolean }) | null;
      resolve({
        code: failure === null ? 0 : typeof failure.code === "number" ? failure.code : 1,
        output: `${stdout}${stderr}`,
        timedOut: failure?.killed === true,
      });
    });
  });
}

function records(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null);
  if (typeof value !== "object" || value === null) return [];
  const record = value as Record<string, unknown>;
  return Array.isArray(record.plugins) ? records(record.plugins) : [record];
}

function jsonFrom(output: string): unknown {
  const start = Math.min(...[output.indexOf("["), output.indexOf("{")].filter((index) => index >= 0));
  const arrayEnd = output.lastIndexOf("]");
  const objectEnd = output.lastIndexOf("}");
  const end = Math.max(arrayEnd, objectEnd);
  if (!Number.isFinite(start) || end < start) return null;
  try {
    return JSON.parse(output.slice(start, end + 1));
  } catch {
    return null;
  }
}

export function installedNpmVersion(output: string): string | null | "unsupported" {
  const plugin = records(jsonFrom(output)).find((entry) => entry.id === "paseo-bm");
  if (plugin === undefined) return "unsupported";
  const installation = typeof plugin.installation === "object" && plugin.installation !== null ? plugin.installation as Record<string, unknown> : null;
  const identity = typeof installation?.identity === "object" && installation.identity !== null ? installation.identity as Record<string, unknown> : null;
  if (identity?.kind !== "npm" || identity.packageName !== "paseo-bm-plugin") return "unsupported";
  const revision = plugin.currentRevision ?? installation?.currentRevision;
  return typeof revision === "string" && revision !== "" ? revision : null;
}

function result(outcome: UpdatesInstallOutput["outcome"], message: string, error: UpdatesInstallOutput["error"]): UpdatesInstallOutput {
  return { outcome, message, command: UPDATE_COMMAND, error };
}

function detailOf(output: string, env: NodeJS.ProcessEnv): string {
  return redactText(output, env).split("\n").map((line) => line.trim()).find((line) => line !== "")?.slice(0, 240) ?? "no output";
}

export async function handleUpdatesInstall(deps: UpdateInstallDeps = {}): Promise<UpdatesInstallOutput> {
  const binary = (deps.find ?? (() => findTool("paseo")))();
  if (binary === null) return result("failed", "The `paseo` command was not found.", { code: "E_UPDATE_CLI_MISSING", message: "The `paseo` command was not found." });
  const run = deps.run ?? runExecFile;
  const inspect = await run(binary, LIST_ARGS, 5_000, UPDATE_INSTALL_MAX_BUFFER);
  const installed = inspect.code === 0 && !inspect.timedOut ? installedNpmVersion(inspect.output) : "unsupported";
  if (installed === "unsupported") {
    const message = "Update now supports only the npm paseo-bm-plugin install. For an old directory install, follow the migration guide in the plugin README.";
    return result("failed", message, { code: "E_UPDATE_SOURCE_UNSUPPORTED", message });
  }
  const expected = (deps.latestVersion ?? (() => cachedLatestVersion(deps)))();
  if (expected === null) {
    const message = "Check for updates again before updating.";
    return result("failed", message, { code: "E_UPDATE_TARGET_UNKNOWN", message });
  }
  const updated = await run(binary, UPDATE_ARGS, UPDATE_INSTALL_TIMEOUT_MS, UPDATE_INSTALL_MAX_BUFFER);
  if (updated.timedOut) {
    const message = "The update did not report a result within 120 seconds. Run `paseo plugin ls`, then retry the update command if the installed version is still old.";
    return result("unknown", message, { code: "E_UPDATE_RESULT_UNKNOWN", message });
  }
  if (updated.code !== 0) {
    const message = `The update command failed (${detailOf(updated.output, deps.env ?? process.env)}).`;
    return result("failed", message, { code: "E_UPDATE_INSTALL_FAILED", message });
  }
  const verified = await run(binary, LIST_ARGS, 5_000, UPDATE_INSTALL_MAX_BUFFER);
  const active = verified.code === 0 && !verified.timedOut ? installedNpmVersion(verified.output) : null;
  if (active !== expected) {
    const message = "The update command finished, but the active version could not be confirmed. Run `paseo plugin ls`, then retry the update command if needed.";
    return result("unknown", message, { code: "E_UPDATE_RESULT_UNKNOWN", message });
  }
  return result("updated", `Updated paseo-bm to ${expected}. Reopen Beads Manager if this screen does not refresh.`, null);
}

export function registerUpdateInstallRpc(server: PluginServerContext): void {
  server.handle(updatesInstallRpc, () => handleUpdatesInstall());
}
