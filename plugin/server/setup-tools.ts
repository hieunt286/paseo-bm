/**
 * The beads tools the Worker depends on — `br` and `bv` — and `bd` for
 * information (delta 20260916-setup-screen §3.4).
 *
 * Finding and version-checking is read-only. Installing runs only the
 * documented command for a tool that is missing, only when the user pressed
 * Install and confirmed it on the Setup screen.
 */
import { execFile } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { DashboardError } from "../shared/contracts";

export type ToolId = "br" | "bv" | "bd";

export interface ToolInfo {
  id: ToolId;
  name: string;
  purpose: string;
  required: boolean;
  path: string | null;
  version: string | null;
  latestKnown: string | null;
  installCommand: string | null;
  updateCommand: string | null;
  homepage: string;
}

/** Newest releases seen on the projects' pages, and when (not fetched at runtime). */
export const LATEST_KNOWN = { br: "0.6.0", bv: "v0.25.0", checkedOn: "2026-09-16" } as const;

const BR_SCRIPT =
  "curl -fsSL https://raw.githubusercontent.com/Dicklesworthstone/beads_rust/main/install.sh | bash -s -- --skip-skills";
/** Pinned to the commit the beads_viewer README asks installers to use. */
const BV_SCRIPT =
  "curl -fsSL https://raw.githubusercontent.com/Dicklesworthstone/beads_viewer/a43b8e85a39664381566abdfd85dc8fcbfdcb773/install.sh | bash";

const DESCRIPTIONS: Record<ToolId, { name: string; purpose: string; required: boolean; homepage: string }> = {
  br: {
    name: "br — beads_rust",
    purpose: "The issue tracker the Worker uses to create, update and close beads.",
    required: true,
    homepage: "https://github.com/Dicklesworthstone/beads_rust",
  },
  bv: {
    name: "bv — beads_viewer",
    purpose: "Triage and dependency views over the same beads (agents use its --robot-* modes).",
    required: true,
    homepage: "https://github.com/Dicklesworthstone/beads_viewer",
  },
  bd: {
    name: "bd — beads (Go)",
    purpose: "The original beads CLI. Optional when br is installed.",
    required: false,
    homepage: "https://github.com/steveyegge/beads",
  },
};

export interface ToolDeps {
  env?: NodeJS.ProcessEnv;
  homedir?: () => string;
  isExecutable?: (path: string) => boolean;
  run?: (file: string, args: string[], timeoutMs: number) => Promise<{ code: number; output: string }>;
}

function isExecutable(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function run(file: string, args: string[], timeoutMs: number): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      const code = error === null ? 0 : typeof (error as { code?: unknown }).code === "number" ? (error as { code: number }).code : 1;
      resolve({ code, output: `${stdout}${stderr}` });
    });
  });
}

/** The daemon's PATH, then the places the documented installers use. */
export function searchDirs(deps: ToolDeps = {}): string[] {
  const env = deps.env ?? process.env;
  const home = (deps.homedir ?? homedir)();
  const fromPath = (env.PATH ?? "").split(delimiter).filter((dir) => dir !== "");
  const extra = [join(home, ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin", join(home, ".cargo", "bin"), join(home, "go", "bin")];
  return [...new Set([...fromPath, ...extra])];
}

export function findTool(name: string, deps: ToolDeps = {}): string | null {
  const check = deps.isExecutable ?? isExecutable;
  for (const dir of searchDirs(deps)) {
    const candidate = join(dir, name);
    if (check(candidate)) return candidate;
  }
  return null;
}

/** First line of `--version` output, without the tool name. */
export function versionOf(output: string): string | null {
  const line = output.split("\n").map((part) => part.trim()).find((part) => part !== "");
  if (line === undefined) return null;
  return line.replace(/^(?:br|bv|bd)\s+(?:version\s+)?/i, "").trim() || null;
}

export function commandsFor(id: ToolId, brewPath: string | null): { install: string | null; update: string | null } {
  if (id === "bd") return { install: null, update: null };
  if (brewPath !== null) {
    return { install: `brew install dicklesworthstone/tap/${id}`, update: `brew upgrade dicklesworthstone/tap/${id}` };
  }
  const script = id === "br" ? BR_SCRIPT : BV_SCRIPT;
  return { install: script, update: script };
}

export async function toolsStatus(deps: ToolDeps = {}): Promise<ToolInfo[]> {
  const exec = deps.run ?? run;
  const brew = findTool("brew", deps);
  return Promise.all(
    (["br", "bv", "bd"] as const).map(async (id): Promise<ToolInfo> => {
      const path = findTool(id, deps);
      // Only ever `--version`: a bare `bv` opens an interactive TUI.
      const version = path === null ? null : versionOf((await exec(path, ["--version"], 5000)).output);
      const commands = commandsFor(id, brew);
      return {
        id,
        ...DESCRIPTIONS[id],
        path,
        version,
        latestKnown: id === "bd" ? null : LATEST_KNOWN[id],
        installCommand: commands.install,
        updateCommand: commands.update,
      };
    }),
  );
}

export const INSTALL_TIMEOUT_MS = 300_000;

/**
 * Runs the documented install command for a missing tool. The user pressed
 * Install and confirmed the exact command before this is called.
 */
export async function installTool(id: "br" | "bv", deps: ToolDeps = {}): Promise<{ command: string; code: number; tail: string[] }> {
  if (findTool(id, deps) !== null) {
    throw new DashboardError("E_TOOL_PRESENT", `${id} is already installed; update it with the command shown on the Setup screen`);
  }
  const command = commandsFor(id, findTool("brew", deps)).install!;
  const exec = deps.run ?? run;
  const env = deps.env ?? process.env;
  // A login shell, so the installer sees the user's usual PATH (brew, curl).
  const result = await exec(env.SHELL?.endsWith("zsh") ? "/bin/zsh" : "/bin/bash", ["-lc", command], INSTALL_TIMEOUT_MS);
  const tail = result.output.split("\n").filter((line) => line.trim() !== "").slice(-40);
  if (result.code !== 0) {
    throw new DashboardError("E_TOOL_INSTALL_FAILED", `\`${command}\` exited with ${result.code}: ${tail.slice(-3).join(" | ")}`);
  }
  return { command, code: result.code, tail };
}
