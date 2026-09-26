import { describe, expect, it } from "vitest";
import { ACTION_KINDS, isMigrateReport, isPluginAction } from "../src/action.js";
import type { Action, MigrateReport } from "../src/action.js";
import { EXIT_CODES } from "../src/exit-codes.js";

/**
 * The report model, after 0.4.0 shrank it to one command's (WP-406).
 *
 * This file used to pin a vocabulary five commands shared: config actions,
 * `skip` / `conflict` / `delete` / `keep`, the per-location grouping and the
 * plan and check summaries. Those went with `install`, `uninstall` and `doctor`;
 * what is left is what the migration actually emits, which is what the JSON
 * contract of Design §4.4 now promises.
 */

const CREATE: Action = {
  kind: "create",
  target: "installHome/home.json",
  reason: "custom-install-home",
};

const PLUGIN: Action = {
  kind: "plugin",
  target: "paseo-bm",
  reason: "switch-to-npm",
  from: "/fake/home/.paseo-bm/plugin/0.3.1",
  to: "npm:paseo-bm-plugin@0.4.0",
};

describe("action vocabulary", () => {
  it("lists exactly the kinds the migration plans", () => {
    expect([...ACTION_KINDS]).toEqual(["create", "update", "plugin"]);
  });

  it("narrows the plugin action, the only one with from/to", () => {
    expect(isPluginAction(PLUGIN)).toBe(true);
    expect(isPluginAction(CREATE)).toBe(false);
    if (isPluginAction(PLUGIN)) {
      expect(PLUGIN.from).toContain("plugin/0.3.1");
      expect(PLUGIN.to).toBe("npm:paseo-bm-plugin@0.4.0");
    }
  });
});

describe("report discrimination", () => {
  // 0.4.0 renders one report: the migration's. The install and uninstall plans
  // and the doctor findings went with the commands that produced them.
  const plan: MigrateReport = {
    schemaVersion: 1,
    command: "migrate",
    mode: "preview",
    paseoBmVersion: "0.4.0",
    paseo: { cliVersion: "0.9.2", daemonVersion: "0.9.2", home: "/fake/.paseo", pluginsEnabled: true },
    roles: [],
    skills: null,
    warnings: [],
    result: { exitCode: EXIT_CODES.ok, pluginState: "running" },
    actions: [CREATE, PLUGIN],
    migration: { outcome: "migrated", from: "/h/.paseo-bm/plugin/0.3.1", to: "npm:paseo-bm-plugin@0.4.0", fallback: null },
  };

  it("narrows the one report there is", () => {
    expect(isMigrateReport(plan)).toBe(true);
  });

  it("lets the same plan describe a preview and an applied run", () => {
    const applied: MigrateReport = { ...plan, mode: "applied" };
    expect(applied.actions).toBe(plan.actions);
  });
});
