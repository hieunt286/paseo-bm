import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { PathFlags, PathSource } from "../src/layout.js";
import {
  ENV_VARS,
  installPaths,
  paseoConfigFile,
  resolveLayout,
} from "../src/layout.js";
import { PathGuardError } from "../src/paths-guard.js";

const HOME = "/home/tester";
const CWD = "/work/project";

type LayoutKey = "installHome" | "paseoHome" | "claudeHome" | "codexHome";

interface PrecedenceCase {
  key: LayoutKey;
  flagKey: keyof PathFlags;
  envVar: string;
  flagValue: string;
  envValue: string;
  defaultValue: string;
}

const precedenceCases: PrecedenceCase[] = [
  {
    key: "installHome",
    flagKey: "home",
    envVar: ENV_VARS.installHome,
    flagValue: "/opt/from-flag/bm",
    envValue: "/opt/from-env/bm",
    defaultValue: `${HOME}/.paseo-bm`,
  },
  {
    key: "paseoHome",
    flagKey: "paseoHome",
    envVar: ENV_VARS.paseoHome,
    flagValue: "/opt/from-flag/paseo",
    envValue: "/opt/from-env/paseo",
    defaultValue: `${HOME}/.paseo`,
  },
  {
    key: "claudeHome",
    flagKey: "claudeHome",
    envVar: ENV_VARS.claudeHome,
    flagValue: "/opt/from-flag/claude",
    envValue: "/opt/from-env/claude",
    defaultValue: `${HOME}/.claude`,
  },
  {
    key: "codexHome",
    flagKey: "codexHome",
    envVar: ENV_VARS.codexHome,
    flagValue: "/opt/from-flag/codex",
    envValue: "/opt/from-env/codex",
    defaultValue: `${HOME}/.codex`,
  },
];

describe("resolveLayout precedence: flag > env > default", () => {
  for (const testCase of precedenceCases) {
    const scenarios: { name: string; useFlag: boolean; useEnv: boolean; expected: string; source: PathSource }[] = [
      {
        name: "flag wins over env and default",
        useFlag: true,
        useEnv: true,
        expected: testCase.flagValue,
        source: "flag",
      },
      {
        name: "env wins over default",
        useFlag: false,
        useEnv: true,
        expected: testCase.envValue,
        source: "env",
      },
      {
        name: "default applies when neither is set",
        useFlag: false,
        useEnv: false,
        expected: testCase.defaultValue,
        source: "default",
      },
    ];

    for (const scenario of scenarios) {
      it(`${testCase.key}: ${scenario.name}`, () => {
        const layout = resolveLayout({
          homeDir: HOME,
          cwd: CWD,
          flags: scenario.useFlag ? { [testCase.flagKey]: testCase.flagValue } : {},
          env: scenario.useEnv ? { [testCase.envVar]: testCase.envValue } : {},
        });
        expect(layout[testCase.key].path).toBe(scenario.expected);
        expect(layout[testCase.key].source).toBe(scenario.source);
      });
    }

    it(`${testCase.key}: an empty env value counts as unset`, () => {
      const layout = resolveLayout({
        homeDir: HOME,
        cwd: CWD,
        env: { [testCase.envVar]: "   " },
      });
      expect(layout[testCase.key].path).toBe(testCase.defaultValue);
      expect(layout[testCase.key].source).toBe("default");
    });

    it(`${testCase.key}: a relative flag value resolves against cwd`, () => {
      const layout = resolveLayout({
        homeDir: HOME,
        cwd: CWD,
        flags: { [testCase.flagKey]: "local/dir" },
      });
      expect(layout[testCase.key].path).toBe(`${CWD}/local/dir`);
    });

    it(`${testCase.key}: a tilde value expands against the home directory`, () => {
      const layout = resolveLayout({
        homeDir: HOME,
        cwd: CWD,
        flags: { [testCase.flagKey]: "~/custom/dir" },
      });
      expect(layout[testCase.key].path).toBe(`${HOME}/custom/dir`);
    });
  }
});

describe("resolveLayout: Paseo home has the daemon as its extra rung", () => {
  const daemonHome = "/var/lib/paseo-daemon";
  const cases: { name: string; flags: PathFlags; env: Record<string, string>; expected: string; source: PathSource }[] = [
    {
      name: "flag beats the daemon",
      flags: { paseoHome: "/opt/flag/paseo" },
      env: { [ENV_VARS.paseoHome]: "/opt/env/paseo" },
      expected: "/opt/flag/paseo",
      source: "flag",
    },
    {
      name: "env beats the daemon",
      flags: {},
      env: { [ENV_VARS.paseoHome]: "/opt/env/paseo" },
      expected: "/opt/env/paseo",
      source: "env",
    },
    {
      name: "the daemon value beats the built-in default",
      flags: {},
      env: {},
      expected: daemonHome,
      source: "daemon",
    },
  ];

  for (const testCase of cases) {
    it(testCase.name, () => {
      const layout = resolveLayout({
        homeDir: HOME,
        cwd: CWD,
        flags: testCase.flags,
        env: testCase.env,
        daemonPaseoHome: daemonHome,
      });
      expect(layout.paseoHome.path).toBe(testCase.expected);
      expect(layout.paseoHome.source).toBe(testCase.source);
    });
  }

  it("falls back to ~/.paseo when the daemon has not been queried yet", () => {
    const layout = resolveLayout({ homeDir: HOME, cwd: CWD, env: {} });
    expect(layout.paseoHome.path).toBe(`${HOME}/.paseo`);
    expect(layout.paseoHome.source).toBe("default");
  });
});

describe("resolveLayout: the shared agent home", () => {
  it("is always ~/.agents; no flag or environment variable is defined for it", () => {
    const layout = resolveLayout({ homeDir: HOME, cwd: CWD, env: {} });
    expect(layout.agentsHome.path).toBe(`${HOME}/.agents`);
    expect(layout.agentsHome.source).toBe("default");
  });
});

describe("resolveLayout: refuses a dangerous install home", () => {
  const rejected: { name: string; home: string; flags?: PathFlags; env?: Record<string, string> }[] = [
    { name: "$HOME itself", home: HOME },
    { name: "$HOME with a trailing slash", home: `${HOME}/` },
    { name: "$HOME reached through traversal", home: `${HOME}/sub/..` },
    { name: "the parent of $HOME", home: dirname(HOME) },
    { name: "the filesystem root", home: "/" },
    { name: "~/.paseo", home: `${HOME}/.paseo` },
    { name: "a directory inside ~/.paseo", home: `${HOME}/.paseo/plugins/bm` },
    { name: "the parent of a custom Paseo home", home: "/opt/paseo", flags: { paseoHome: "/opt/paseo/home" } },
    { name: "~/.claude", home: `${HOME}/.claude` },
    { name: "a directory inside ~/.claude", home: `${HOME}/.claude/skills` },
    { name: "a custom Claude home from the environment", home: "/opt/claude-cfg", env: { [ENV_VARS.claudeHome]: "/opt/claude-cfg" } },
    { name: "~/.codex", home: `${HOME}/.codex` },
    { name: "a directory inside ~/.codex", home: `${HOME}/.codex/skills` },
    { name: "a custom Codex home from a flag", home: "/opt/codex-cfg/sub", flags: { codexHome: "/opt/codex-cfg" } },
    { name: "~/.agents", home: `${HOME}/.agents` },
    { name: "a directory inside ~/.agents", home: `${HOME}/.agents/skills` },
  ];

  for (const testCase of rejected) {
    it(`rejects ${testCase.name}`, () => {
      const call = (): unknown =>
        resolveLayout({
          homeDir: HOME,
          cwd: CWD,
          env: testCase.env ?? {},
          flags: { ...testCase.flags, home: testCase.home },
        });
      expect(call).toThrowError(PathGuardError);
      try {
        call();
        expect.unreachable("expected the install home to be refused");
      } catch (error) {
        expect((error as PathGuardError).reason).toBe("unsafe-install-home");
      }
    });
  }

  const accepted: { name: string; home: string }[] = [
    { name: "the default ~/.paseo-bm", home: `${HOME}/.paseo-bm` },
    { name: "another directory inside $HOME", home: `${HOME}/tools/paseo-bm` },
    { name: "a directory outside $HOME", home: "/opt/paseo-bm" },
    { name: "a sibling of ~/.paseo sharing its prefix", home: `${HOME}/.paseo-bm-data` },
  ];

  for (const testCase of accepted) {
    it(`accepts ${testCase.name}`, () => {
      const layout = resolveLayout({
        homeDir: HOME,
        cwd: CWD,
        env: {},
        flags: { home: testCase.home },
      });
      expect(layout.installHome.path).toBe(resolve(testCase.home));
    });
  }

  it("refuses before any write happens, using a temporary HOME", () => {
    const fakeHome = realpathSync(mkdtempSync(join(tmpdir(), "paseo-bm-home-")));
    try {
      expect(() =>
        resolveLayout({ homeDir: fakeHome, cwd: CWD, env: { [ENV_VARS.installHome]: fakeHome } }),
      ).toThrowError(PathGuardError);
      // Nothing was created: the guard runs before any filesystem work.
      expect(() => resolveLayout({ homeDir: fakeHome, cwd: CWD, env: {} })).not.toThrow();
    } finally {
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });
});

describe("installPaths", () => {
  let home: string;

  beforeEach(() => {
    home = realpathSync(mkdtempSync(join(tmpdir(), "paseo-bm-layout-")));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("describes the install home layout from Design §5.1", () => {
    mkdirSync(join(home, ".paseo-bm"), { recursive: true });
    const layout = resolveLayout({ homeDir: home, cwd: CWD, env: {} });
    const paths = installPaths(layout.installHome.path);

    expect(paths.root).toBe(join(home, ".paseo-bm"));
    expect(paths.record).toBe(join(paths.root, "install.json"));
    expect(paths.pluginRoot).toBe(join(paths.root, "plugin"));
    expect(paths.backupsRoot).toBe(join(paths.root, "backups"));
    expect(paths.lockFile).toBe(join(paths.root, ".lock"));
    expect(paths.pluginVersionDir("0.1.0")).toBe(join(paths.root, "plugin", "0.1.0"));
    expect(paths.backupDir("20260915T101500Z")).toBe(
      join(paths.root, "backups", "20260915T101500Z"),
    );
  });

  it("refuses a version or backup name that escapes the install home", () => {
    const paths = installPaths("/opt/paseo-bm");
    expect(() => paths.pluginVersionDir("../../etc")).toThrowError(PathGuardError);
    expect(() => paths.backupDir("../outside")).toThrowError(PathGuardError);
  });
});

describe("paseoConfigFile", () => {
  it("points at config.json, the only file we read inside the Paseo home", () => {
    expect(paseoConfigFile("/home/tester/.paseo")).toBe("/home/tester/.paseo/config.json");
  });
});
