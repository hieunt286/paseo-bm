import { homedir } from "node:os";
import { resolve } from "node:path";
import { PathGuardError, assertWithinRoot, containsPath, toAbsolutePath } from "./paths-guard.js";

/**
 * Where a resolved value came from. The precedence contract is flag > env >
 * default (Design §4.2, REQ-014c); Paseo's home has one extra rung because
 * `paseo daemon status --json` is its source of truth (ADR-004).
 */
export type PathSource = "flag" | "env" | "daemon" | "default";

export interface ResolvedPath {
  readonly path: string;
  readonly source: PathSource;
}

/** Path flags from Design §4.2, already parsed out of argv. */
export interface PathFlags {
  /** `--home` */
  home?: string | undefined;
  /** `--paseo-home` */
  paseoHome?: string | undefined;
  /** `--claude-home` */
  claudeHome?: string | undefined;
  /** `--codex-home` */
  codexHome?: string | undefined;
}

export interface ResolveLayoutInput {
  flags?: PathFlags;
  env?: Readonly<Record<string, string | undefined>>;
  /** Overrides `os.homedir()`; integration tests run against a fake `$HOME`. */
  homeDir?: string;
  /** `home` from `paseo daemon status --json`, when it has already been read. */
  daemonPaseoHome?: string | undefined;
  /** Base for relative flag values. Defaults to `process.cwd()`. */
  cwd?: string;
}

export interface Layout {
  readonly homeDir: string;
  /** `~/.paseo-bm` — everything paseo-bm owns lives under here. */
  readonly installHome: ResolvedPath;
  /** Paseo's own home; we only ever read `config.json` inside it. */
  readonly paseoHome: ResolvedPath;
  /** Claude Code config directory. */
  readonly claudeHome: ResolvedPath;
  /** Codex config directory. */
  readonly codexHome: ResolvedPath;
  /** Shared agent directory used by the skills CLI (ADR-003). */
  readonly agentsHome: ResolvedPath;
}

export const ENV_VARS = {
  installHome: "PASEO_BM_HOME",
  paseoHome: "PASEO_HOME",
  claudeHome: "CLAUDE_CONFIG_DIR",
  codexHome: "CODEX_HOME",
} as const;

export const DEFAULT_DIR_NAMES = {
  installHome: ".paseo-bm",
  paseoHome: ".paseo",
  claudeHome: ".claude",
  codexHome: ".codex",
  agentsHome: ".agents",
} as const;

function pickEnv(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
): string | undefined {
  const value = env[name];
  if (value === undefined) {
    return undefined;
  }
  return value.trim().length === 0 ? undefined : value;
}

function pick(
  candidates: readonly (readonly [PathSource, string | undefined])[],
  fallback: string,
  options: { cwd: string; homeDir: string },
): ResolvedPath {
  for (const [source, raw] of candidates) {
    if (raw === undefined || raw.trim().length === 0) {
      continue;
    }
    return { path: toAbsolutePath(raw, options), source };
  }
  return { path: toAbsolutePath(fallback, options), source: "default" };
}

/**
 * Resolves every directory paseo-bm reads or writes, applying flag > env >
 * default, then refuses an install home that would make us write over the
 * user's own things.
 */
export function resolveLayout(input: ResolveLayoutInput = {}): Layout {
  const env = input.env ?? process.env;
  const flags = input.flags ?? {};
  const homeDir = resolve(input.homeDir ?? homedir());
  const options = { cwd: input.cwd ?? process.cwd(), homeDir };

  const paseoHome = pick(
    [
      ["flag", flags.paseoHome],
      ["env", pickEnv(env, ENV_VARS.paseoHome)],
      ["daemon", input.daemonPaseoHome],
    ],
    resolve(homeDir, DEFAULT_DIR_NAMES.paseoHome),
    options,
  );
  const claudeHome = pick(
    [
      ["flag", flags.claudeHome],
      ["env", pickEnv(env, ENV_VARS.claudeHome)],
    ],
    resolve(homeDir, DEFAULT_DIR_NAMES.claudeHome),
    options,
  );
  const codexHome = pick(
    [
      ["flag", flags.codexHome],
      ["env", pickEnv(env, ENV_VARS.codexHome)],
    ],
    resolve(homeDir, DEFAULT_DIR_NAMES.codexHome),
    options,
  );
  const installHome = pick(
    [
      ["flag", flags.home],
      ["env", pickEnv(env, ENV_VARS.installHome)],
    ],
    resolve(homeDir, DEFAULT_DIR_NAMES.installHome),
    options,
  );
  const agentsHome: ResolvedPath = {
    path: resolve(homeDir, DEFAULT_DIR_NAMES.agentsHome),
    source: "default",
  };

  const layout: Layout = { homeDir, installHome, paseoHome, claudeHome, codexHome, agentsHome };
  assertSafeInstallHome(layout);
  return layout;
}

/**
 * Refuses an install home that is `$HOME`, an ancestor of `$HOME`, or that
 * overlaps a directory belonging to Paseo or to an agent (Design §7). Runs
 * before anything is written, because everything under the install home is
 * ours to create, overwrite and later delete.
 */
export function assertSafeInstallHome(layout: Layout): string {
  const target = layout.installHome.path;

  // `$HOME` itself and anything above it. Being *inside* `$HOME` is normal:
  // that is where the default install home lives.
  if (target === layout.homeDir || containsPath(target, layout.homeDir)) {
    throw new PathGuardError(
      "unsafe-install-home",
      `Refusing to use ${target} as the install home: it is the home directory or contains it`,
      target,
      layout.homeDir,
    );
  }

  const protectedDirs: readonly (readonly [string, string])[] = [
    ["Paseo home", layout.paseoHome.path],
    ["Claude Code home", layout.claudeHome.path],
    ["Codex home", layout.codexHome.path],
    ["shared agent home", layout.agentsHome.path],
    ["Paseo home", resolve(layout.homeDir, DEFAULT_DIR_NAMES.paseoHome)],
    ["Claude Code home", resolve(layout.homeDir, DEFAULT_DIR_NAMES.claudeHome)],
    ["Codex home", resolve(layout.homeDir, DEFAULT_DIR_NAMES.codexHome)],
  ];

  for (const [label, dir] of protectedDirs) {
    if (target === dir || containsPath(target, dir) || containsPath(dir, target)) {
      throw new PathGuardError(
        "unsafe-install-home",
        `Refusing to use ${target} as the install home: it overlaps the ${label} at ${dir}`,
        target,
        dir,
      );
    }
  }

  return target;
}

export interface InstallPaths {
  readonly root: string;
  /** `install.json`, the ownership record (Design §3.2). */
  readonly record: string;
  /** `plugin/`, holding one directory per installed payload version. */
  readonly pluginRoot: string;
  /** `backups/`, holding one timestamped directory per backup. */
  readonly backupsRoot: string;
  /** `.lock`, the process lock taken by install and uninstall. */
  readonly lockFile: string;
  pluginVersionDir(version: string): string;
  backupDir(stamp: string): string;
}

/** The fixed layout inside the install home (Design §3.1). */
export function installPaths(installHome: string): InstallPaths {
  const root = resolve(installHome);
  const pluginRoot = resolve(root, "plugin");
  const backupsRoot = resolve(root, "backups");
  return {
    root,
    record: resolve(root, "install.json"),
    pluginRoot,
    backupsRoot,
    lockFile: resolve(root, ".lock"),
    pluginVersionDir: (version: string) => assertWithinRoot(pluginRoot, resolve(pluginRoot, version)),
    backupDir: (stamp: string) => assertWithinRoot(backupsRoot, resolve(backupsRoot, stamp)),
  };
}

/** Paseo's `config.json` — the only file paseo-bm ever reads inside `~/.paseo`. */
export function paseoConfigFile(paseoHome: string): string {
  return resolve(paseoHome, "config.json");
}
