import { describe, expect, it, vi } from "vitest";
import {
  PLUGIN_ID,
  TRACES_DIR_NAME,
  confirmInstallHome,
  installHomeFromPluginPath,
  resolveInstallHome,
  type InstallHomeFs,
  type InstallHomePaseo,
} from "../plugin/server/install-home";

/**
 * WP-202: resolving `<install home>` from the path Paseo registered.
 *
 * No real HOME and no real daemon: the Paseo config and the one file read
 * (`install.json`) are both fakes, which is also how the tests prove the
 * resolver never writes anything — the fake exposes no write function at all.
 */

const HOME = "/Users/test";
const DEFAULT_INSTALL_HOME = `${HOME}/.paseo-bm`;
const CUSTOM_INSTALL_HOME = "/opt/bm-home";

function fakeFs(files: Record<string, string>): InstallHomeFs & { reads: string[] } {
  const reads: string[] = [];
  return {
    reads,
    readFileSync(path: string) {
      reads.push(path);
      const found = files[path];
      if (found === undefined) throw new Error(`ENOENT: ${path}`);
      return found;
    },
  };
}

function fakePaseo(plugins: Record<string, unknown> | undefined | Error): InstallHomePaseo {
  return {
    config: {
      get: vi.fn(async () => {
        if (plugins instanceof Error) throw plugins;
        return { config: { plugins } };
      }),
    },
  };
}

const record = (schemaVersion = 1) => JSON.stringify({ schemaVersion, version: "0.2.0" });

describe("installHomeFromPluginPath", () => {
  it("takes the install home two levels above the version directory", () => {
    expect(installHomeFromPluginPath(`${CUSTOM_INSTALL_HOME}/plugin/0.2.0`)).toBe(CUSTOM_INSTALL_HOME);
  });

  it.each(["", "   ", "relative/plugin/0.2.0", "/"])("rejects %o", (value) => {
    expect(installHomeFromPluginPath(value)).toBeNull();
  });
});

describe("confirmInstallHome", () => {
  it("accepts a readable profile at the understood schema version", () => {
    const fs = fakeFs({ [`${CUSTOM_INSTALL_HOME}/install.json`]: record() });
    expect(confirmInstallHome(CUSTOM_INSTALL_HOME, fs)).toEqual({ ok: true });
  });

  it("refuses a profile written by a newer paseo-bm instead of assuming it fits", () => {
    const fs = fakeFs({ [`${CUSTOM_INSTALL_HOME}/install.json`]: record(2) });
    const result = confirmInstallHome(CUSTOM_INSTALL_HOME, fs);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toContain("newer than this plugin understands");
  });

  it.each([
    ["broken JSON", "{not json"],
    ["no schemaVersion", JSON.stringify({ version: "0.2.0" })],
  ])("refuses %s", (_label, body) => {
    const fs = fakeFs({ [`${CUSTOM_INSTALL_HOME}/install.json`]: body });
    expect(confirmInstallHome(CUSTOM_INSTALL_HOME, fs).ok).toBe(false);
  });
});

describe("resolveInstallHome — the five approved cases", () => {
  it("1. resolves the standard registered path", async () => {
    const fs = fakeFs({ [`${DEFAULT_INSTALL_HOME}/install.json`]: record() });
    const result = await resolveInstallHome({
      paseo: fakePaseo({ [PLUGIN_ID]: { source: "directory", path: `${DEFAULT_INSTALL_HOME}/plugin/0.2.0` } }),
      fs,
      homedir: () => HOME,
    });
    expect(result).toEqual({
      home: DEFAULT_INSTALL_HOME,
      tracesDir: `${DEFAULT_INSTALL_HOME}/${TRACES_DIR_NAME}`,
      source: "plugin-path",
    });
  });

  it("2. resolves a non-default --home installation", async () => {
    const fs = fakeFs({ [`${CUSTOM_INSTALL_HOME}/install.json`]: record() });
    const result = await resolveInstallHome({
      paseo: fakePaseo({ [PLUGIN_ID]: { source: "directory", path: `${CUSTOM_INSTALL_HOME}/plugin/0.2.0` } }),
      fs,
      homedir: () => HOME,
    });
    expect(result).toEqual({
      home: CUSTOM_INSTALL_HOME,
      tracesDir: `${CUSTOM_INSTALL_HOME}/${TRACES_DIR_NAME}`,
      source: "plugin-path",
    });
  });

  it("3. reports a readable reason when install.json is missing everywhere", async () => {
    const result = await resolveInstallHome({
      paseo: fakePaseo({ [PLUGIN_ID]: { source: "directory", path: `${CUSTOM_INSTALL_HOME}/plugin/0.2.0` } }),
      fs: fakeFs({}),
      homedir: () => HOME,
    });
    expect(result.home).toBeNull();
    expect(result.home === null && result.reason).toContain("no readable install.json");
  });

  it("4. falls back to the default home when Paseo has no plugin entry", async () => {
    const fs = fakeFs({ [`${DEFAULT_INSTALL_HOME}/install.json`]: record() });
    const found = await resolveInstallHome({ paseo: fakePaseo({}), fs, homedir: () => HOME });
    expect(found).toMatchObject({ home: DEFAULT_INSTALL_HOME, source: "default-home" });

    const missing = await resolveInstallHome({ paseo: fakePaseo(undefined), fs: fakeFs({}), homedir: () => HOME });
    expect(missing.home).toBeNull();
    expect(missing.home === null && missing.reason).toContain(`no directory plugin registered as "${PLUGIN_ID}"`);
  });

  it("5. reports a readable reason when config.get() fails, and does not throw", async () => {
    const result = await resolveInstallHome({
      paseo: fakePaseo(new Error("daemon went away")),
      fs: fakeFs({}),
      homedir: () => HOME,
    });
    expect(result.home).toBeNull();
    expect(result.home === null && result.reason).toBe(
      "could not read the Paseo configuration: daemon went away",
    );
  });

  it("prefers the default home when the registered path is a developer checkout", async () => {
    const fs = fakeFs({ [`${DEFAULT_INSTALL_HOME}/install.json`]: record() });
    const result = await resolveInstallHome({
      paseo: fakePaseo({ [PLUGIN_ID]: { source: "directory", path: "/repo/checkout/plugin/dev" } }),
      fs,
      homedir: () => HOME,
    });
    expect(result).toMatchObject({ home: DEFAULT_INSTALL_HOME, source: "default-home" });
  });

  it("reads install.json and nothing else", async () => {
    const fs = fakeFs({ [`${DEFAULT_INSTALL_HOME}/install.json`]: record() });
    await resolveInstallHome({
      paseo: fakePaseo({ [PLUGIN_ID]: { source: "directory", path: `${DEFAULT_INSTALL_HOME}/plugin/0.2.0` } }),
      fs,
      homedir: () => HOME,
    });
    expect(fs.reads).toEqual([`${DEFAULT_INSTALL_HOME}/install.json`]);
  });
});
