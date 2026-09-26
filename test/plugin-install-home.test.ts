import { describe, expect, it } from "vitest";
import {
  PLUGIN_ID,
  confirmInstallHome,
  installHomeFromPluginPath,
  type InstallHomeFs,
} from "../plugin/server/install-home";

/**
 * Recognising an install the retired installer CLI laid out (design §7.13.6).
 *
 * This file used to cover `resolveInstallHome`, the way the plugin found its
 * data before 0.4.0. That resolver is gone — `data-home.ts` owns the question
 * now, and `test/plugin-data-home.test.ts` covers it — so what is left here is
 * the one thing Setup still asks: does this plugin run from a 0.3.x directory
 * install, and therefore need the migration banner?
 *
 * No real HOME and no real daemon: the one file read (`install.json`) is a fake,
 * which is also how these tests prove the module never writes anything — the
 * fake exposes no write function at all.
 */

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
  it("accepts a record the old installer wrote and nothing has migrated", () => {
    const fs = fakeFs({ [`${CUSTOM_INSTALL_HOME}/install.json`]: record() });
    expect(confirmInstallHome(CUSTOM_INSTALL_HOME, fs)).toEqual({ ok: true });
  });

  // Not a limitation: a schema-2 record means the migration already ran, and
  // that is exactly when Setup must not offer the banner — the command it points
  // at would refuse with exit 5.
  it("refuses a record that was already migrated", () => {
    const fs = fakeFs({ [`${CUSTOM_INSTALL_HOME}/install.json`]: record(2) });
    const result = confirmInstallHome(CUSTOM_INSTALL_HOME, fs);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toContain("already migrated");
  });

  it.each([
    ["broken JSON", "{not json"],
    ["no schemaVersion", JSON.stringify({ version: "0.2.0" })],
    ["a schemaVersion below 1", JSON.stringify({ schemaVersion: 0 })],
  ])("refuses %s", (_label, body) => {
    const fs = fakeFs({ [`${CUSTOM_INSTALL_HOME}/install.json`]: body });
    expect(confirmInstallHome(CUSTOM_INSTALL_HOME, fs).ok).toBe(false);
  });

  it("refuses a home with no record at all, and reads only install.json", () => {
    const fs = fakeFs({});

    expect(confirmInstallHome(CUSTOM_INSTALL_HOME, fs).ok).toBe(false);

    expect(fs.reads).toEqual([`${CUSTOM_INSTALL_HOME}/install.json`]);
  });
});

describe("the plugin id", () => {
  it("is the one the installer registered and Paseo still knows", () => {
    expect(PLUGIN_ID).toBe("paseo-bm");
  });
});
