import { describe, expect, it } from "vitest";
import {
  ACTION_KINDS,
  ACTION_LOCATIONS,
  CHECK_SEVERITIES,
  FILE_STATUS_REASONS,
  groupActionsByLocation,
  hasCheckErrors,
  isConfigAction,
  isDoctorReport,
  isWritingAction,
  summarizeActions,
  summarizeChecks,
} from "../src/action.js";
import type { Action, Check, DoctorReport, PlanReport } from "../src/action.js";
import { EXIT_CODES } from "../src/exit-codes.js";

const CREATE: Action = {
  kind: "create",
  target: "installHome/plugin/0.1.0/roles/worker.md",
  location: "install-home",
  reason: "missing",
};

const SKIP: Action = {
  kind: "skip",
  target: "installHome/plugin/0.1.0/roles/manager.md",
  location: "install-home",
  reason: "unchanged",
};

const CONFIG: Action = {
  kind: "config",
  target: "paseoHome/config.json#pluginsEnabled",
  location: "paseo-config",
  reason: "consent granted",
  from: false,
  to: true,
  consent: "interactive",
};

const PLUGIN: Action = {
  kind: "create",
  target: "paseoDaemon/plugins[paseo-bm]",
  location: "paseo-daemon",
  reason: "missing",
};

describe("action vocabulary", () => {
  it("lists exactly the kinds of Design §4.4", () => {
    expect([...ACTION_KINDS]).toEqual(["create", "update", "skip", "conflict", "delete", "keep", "config"]);
  });

  it("lists the ownership statuses of Design §5.3 as file reasons", () => {
    expect([...FILE_STATUS_REASONS]).toEqual(["unchanged", "outdated", "user-modified", "conflict", "missing"]);
  });

  it("lists the three severities of a doctor check", () => {
    expect([...CHECK_SEVERITIES]).toEqual(["ok", "warn", "error"]);
  });

  it("narrows config actions, which are the only ones with from/to", () => {
    expect(isConfigAction(CONFIG)).toBe(true);
    expect(isConfigAction(CREATE)).toBe(false);
    if (isConfigAction(CONFIG)) {
      expect(CONFIG.from).toBe(false);
      expect(CONFIG.to).toBe(true);
    }
  });

  it("counts create, update, delete and config as writes; skip, keep and conflict as not", () => {
    const writes: Action["kind"][] = ["create", "update", "delete", "config"];
    for (const kind of ACTION_KINDS) {
      const action = { ...CREATE, kind, from: null, to: null } as Action;
      expect(isWritingAction(action), kind).toBe(writes.includes(kind));
    }
  });
});

describe("summarizeActions", () => {
  it("counts every kind and reports whether anything is written", () => {
    const summary = summarizeActions([CREATE, SKIP, CONFIG, PLUGIN]);
    expect(summary.total).toBe(4);
    expect(summary.byKind).toEqual({
      create: 2,
      update: 0,
      skip: 1,
      conflict: 0,
      delete: 0,
      keep: 0,
      config: 1,
    });
    expect(summary.writes).toBe(true);
    expect(summary.conflicts).toBe(false);
  });

  it("reports a plan that only skips as writing nothing", () => {
    const summary = summarizeActions([SKIP]);
    expect(summary.writes).toBe(false);
    expect(summary.conflicts).toBe(false);
  });

  it("flags a conflict, which is what the caller turns into exit code 5", () => {
    const conflict: Action = { ...CREATE, kind: "conflict", reason: "user-modified" };
    const summary = summarizeActions([CREATE, conflict]);
    expect(summary.conflicts).toBe(true);
    expect(EXIT_CODES.conflict).toBe(5);
  });

  it("handles an empty plan, the idempotent re-run case of Design §9", () => {
    const summary = summarizeActions([]);
    expect(summary.total).toBe(0);
    expect(summary.writes).toBe(false);
  });
});

describe("groupActionsByLocation", () => {
  it("groups by destination in a fixed order, keeping planner order inside a group", () => {
    const grouped = groupActionsByLocation([CONFIG, CREATE, PLUGIN, SKIP]);
    expect(grouped.map((group) => group.location)).toEqual(["install-home", "paseo-config", "paseo-daemon"]);
    expect(grouped[0]?.actions).toEqual([CREATE, SKIP]);
    expect(grouped[0]?.label).toBe("Install home");
  });

  it("drops locations with nothing in them, so no heading is ever empty", () => {
    expect(groupActionsByLocation([CREATE]).map((group) => group.location)).toEqual(["install-home"]);
    expect(groupActionsByLocation([])).toEqual([]);
  });

  it("covers every declared location", () => {
    const all: Action[] = ACTION_LOCATIONS.map((location) => ({ ...CREATE, location }));
    expect(groupActionsByLocation(all).map((group) => group.location)).toEqual([...ACTION_LOCATIONS]);
  });
});

describe("checks", () => {
  const checks: readonly Check[] = [
    { id: "paseo-cli", severity: "ok", message: "Paseo CLI 0.8.0 answers", remediation: "" },
    { id: "skills", severity: "warn", message: "one skill is missing", remediation: "run the printed command" },
    { id: "plugin-status", severity: "error", message: "the plugin is disabled", remediation: "enable plugins" },
  ];

  it("counts by severity", () => {
    expect(summarizeChecks(checks)).toEqual({ ok: 1, warn: 1, error: 1 });
    expect(summarizeChecks([])).toEqual({ ok: 0, warn: 0, error: 0 });
  });

  it("treats only errors as drift, never warnings", () => {
    expect(hasCheckErrors(checks)).toBe(true);
    expect(hasCheckErrors(checks.filter((check) => check.severity !== "error"))).toBe(false);
  });
});

describe("report discrimination", () => {
  const base = {
    schemaVersion: 1,
    paseoBmVersion: "0.1.0",
    paseo: { cliVersion: "0.8.0", daemonVersion: "0.8.0", home: "/fake/.paseo", pluginsEnabled: true },
    roles: [],
    skills: null,
    warnings: [],
    result: { exitCode: EXIT_CODES.ok, pluginState: "running" },
  } as const;

  const plan: PlanReport = { ...base, command: "install", mode: "preview", actions: [CREATE] };
  const doctor: DoctorReport = {
    ...base,
    command: "doctor",
    mode: "preview",
    checks: [{ id: "paseo-cli", severity: "ok", message: "fine", remediation: "" }],
  };

  it("tells a doctor report from a plan report", () => {
    expect(isDoctorReport(doctor)).toBe(true);
    expect(isDoctorReport(plan)).toBe(false);
  });

  it("lets the same plan describe a preview and an applied run", () => {
    const applied: PlanReport = { ...plan, mode: "applied" };
    expect(applied.actions).toBe(plan.actions);
  });
});
