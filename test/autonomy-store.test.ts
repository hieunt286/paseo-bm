import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AUTONOMY_DIR_NAME, AUTONOMY_POLICY_FILE, createAutonomyStore } from "../plugin/server/autonomy-store";
import { CLEANUP_DELETES } from "../plugin/server/setup-machine";
import {
  AUTONOMY_FILE_VERSION,
  AUTONOMY_MODES,
  EMPTY_AUTONOMY_POLICY,
  LEVELS,
  autonomyPolicyOf,
  canDelegate,
  challengerOf,
  levelOf,
  levelsOf,
  modeOf,
  withLevel,
  type AutonomyPolicy,
} from "../plugin/shared/autonomy";
import { DashboardError } from "../plugin/shared/contracts";
import { DECISION_CLASSES, PREDICTORS } from "../plugin/shared/decisions";

/**
 * The autonomy policy store (autonomy design §B.2, ADR-018; PRD REQ-121):
 * `<data>/autonomy/policy.json` with the alerts store's file rules. A
 * temporary data folder only; never the real HOME.
 */

const AT = "2026-09-30T10:00:00.000Z";

let root: string;
let home: string;

const store = () => createAutonomyStore(home);
const file = () => join(home, AUTONOMY_DIR_NAME, AUTONOMY_POLICY_FILE);
const fileBytes = () => (existsSync(file()) ? readFileSync(file(), "utf8") : null);
const permissions = (path: string) => statSync(path).mode & 0o777;
const set = (workspaceId: string, decisionClass: string, mode: string, extra: Record<string, unknown> = {}) => ({
  workspaceId,
  class: decisionClass,
  mode,
  ...extra,
});

function writeFile(body: unknown): string {
  mkdirSync(join(home, AUTONOMY_DIR_NAME), { recursive: true });
  const text = typeof body === "string" ? body : JSON.stringify(body);
  writeFileSync(file(), text);
  return text;
}

function codeOf(run: () => unknown): string | null {
  try {
    run();
    return null;
  } catch (error) {
    return error instanceof DashboardError ? error.code : `not a DashboardError: ${String(error)}`;
  }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "bm-autonomy-"));
  home = join(root, "data");
});

afterEach(() => {
  chmodSync(root, 0o700);
  if (existsSync(join(home, AUTONOMY_DIR_NAME))) chmodSync(join(home, AUTONOMY_DIR_NAME), 0o700);
  rmSync(root, { recursive: true, force: true });
});

describe("the policy's vocabulary (shared/autonomy.ts)", () => {
  it("has three modes, the ledger's two measured predictions, and no class that cannot be delegated (ADR-025)", () => {
    expect(AUTONOMY_FILE_VERSION).toBe(1);
    expect(AUTONOMY_MODES).toEqual(["owner", "shadow", "delegate"]);
    // The agreement ledger's prediction keys: measured, not chosen.
    expect(PREDICTORS).toEqual(["recommended", "orchestrator"]);
    expect(DECISION_CLASSES.filter((decisionClass) => !canDelegate(decisionClass))).toEqual([]);
  });

  it("reads an absent cell, and an absent project, as owner (REQ-121 b)", () => {
    for (const decisionClass of DECISION_CLASSES) {
      expect(modeOf(EMPTY_AUTONOMY_POLICY, "w1", decisionClass)).toBe("owner");
    }
    const policy = autonomyPolicyOf({ projects: { w1: { scope: { mode: "shadow", at: AT } } } });
    expect(modeOf(policy, "w1", "scope")).toBe("shadow");
    expect(modeOf(policy, "w1", "preference")).toBe("owner");
    expect(modeOf(policy, "w2", "scope")).toBe("owner");
    // An inherited name is not a project.
    expect(modeOf(policy, "__proto__", "scope")).toBe("owner");
    expect(modeOf(policy, "constructor", "scope")).toBe("owner");
  });
});

describe("the store", () => {
  it("reads the empty policy and creates nothing, then a 0700 folder and a 0600 file on the first write; cleanup deletes the folder", () => {
    expect(store().read()).toEqual(EMPTY_AUTONOMY_POLICY);
    expect(existsSync(home)).toBe(false);
    const policy = store().set(set("w1", "scope", "shadow"), AT);
    expect(policy).toEqual({ projects: { w1: { scope: { mode: "shadow", at: AT } } }, challenger: {} });
    expect(permissions(join(home, AUTONOMY_DIR_NAME))).toBe(0o700);
    expect(permissions(file())).toBe(0o600);
    expect(JSON.parse(readFileSync(file(), "utf8"))).toEqual({ version: 1, ...policy });
    expect(store().read()).toEqual(policy);
    expect(CLEANUP_DELETES).toContain(AUTONOMY_DIR_NAME);
  });

  it("writes atomically: a temporary file renamed into place, none left behind, and a failed write leaves the file as it was", () => {
    store().set(set("w1", "scope", "shadow"), AT);
    store().set(set("w1", "preference", "delegate", { confirmed: true }), AT);
    expect(readdirSync(join(home, AUTONOMY_DIR_NAME))).toEqual([AUTONOMY_POLICY_FILE]);
    const before = fileBytes();
    // No temporary file can be created in a read-only folder: the write fails before the rename.
    chmodSync(join(home, AUTONOMY_DIR_NAME), 0o500);
    expect(() => store().set(set("w1", "scope", "owner"), AT)).toThrow();
    chmodSync(join(home, AUTONOMY_DIR_NAME), 0o700);
    expect(fileBytes()).toBe(before);
    expect(readdirSync(join(home, AUTONOMY_DIR_NAME))).toEqual([AUTONOMY_POLICY_FILE]);
  });

  it("records a delegated cell with no predictor (the Orchestrator's, ADR-025), any class, and when each cell was set", () => {
    store().set(set("w1", "preference", "delegate", { confirmed: true }), AT);
    store().set(set("w1", "release", "delegate", { confirmed: true }), "2026-09-30T11:00:00.000Z");
    expect(store().read().projects["w1"]).toEqual({
      preference: { mode: "delegate", at: AT },
      release: { mode: "delegate", at: "2026-09-30T11:00:00.000Z" },
    });
    store().set(set("w1", "release", "owner"), AT);
    expect(store().read().projects["w1"]?.release).toEqual({ mode: "owner", at: AT });
  });

  it("reads a stored recommended cell as the Orchestrator's delegate, and an older file's demotions are read past and dropped by the next write", () => {
    writeFile({
      version: 1,
      projects: { w1: { scope: { mode: "delegate", predictor: "recommended", at: AT }, preference: { mode: "shadow", at: AT } } },
      challenger: { w1: true },
      demotions: { w1: { preference: AT } },
    });
    const policy = store().read();
    expect(policy).toEqual({ projects: { w1: { scope: { mode: "delegate", at: AT }, preference: { mode: "shadow", at: AT } } }, challenger: { w1: true } });
    expect(modeOf(policy, "w1", "scope")).toBe("delegate");
    store().set(set("w1", "preference", "owner"), AT);
    const written = JSON.parse(readFileSync(file(), "utf8")) as Record<string, unknown>;
    expect(written).toEqual({ version: 1, projects: { w1: { scope: { mode: "delegate", at: AT }, preference: { mode: "owner", at: AT } } }, challenger: { w1: true } });
    expect(Object.keys(written)).not.toContain("demotions");
  });

  it("skips a malformed cell alone: unknown class or mode, a cell that is not an object; any class may be delegate", () => {
    writeFile({
      version: 1,
      projects: {
        w1: {
          scope: { mode: "shadow", at: AT },
          preference: { mode: "sometimes", at: AT },
          "reversible-technical": { mode: "delegate", at: AT },
          environment: "delegate",
          dependency: { mode: "delegate", predictor: "recommended", at: AT, note: "dropped" },
          release: { mode: "delegate", predictor: "recommended", at: AT },
          security: { mode: "delegate", predictor: "orchestrator", at: AT },
          style: { mode: "owner", at: AT },
        },
        w2: "not cells",
        w3: { data: { mode: "delegate", predictor: "recommended", at: AT } },
        "": { scope: { mode: "shadow", at: AT } },
      },
      challenger: { w1: true, w2: "yes", w3: false },
      extra: { ignored: true },
    });
    const policy = store().read();
    const w1 = {
      scope: { mode: "shadow", at: AT },
      "reversible-technical": { mode: "delegate", at: AT },
      dependency: { mode: "delegate", at: AT },
      release: { mode: "delegate", at: AT },
      security: { mode: "delegate", at: AT },
    };
    expect(policy).toEqual({ projects: { w1, w3: { data: { mode: "delegate", at: AT } } }, challenger: { w1: true, w3: false } });
    // The next write keeps what it could read, the challenger included, and drops the rest.
    store().set(set("w1", "scope", "owner"), AT);
    expect(JSON.parse(readFileSync(file(), "utf8"))).toEqual({
      version: 1,
      projects: { w1: { ...w1, scope: { mode: "owner", at: AT } }, w3: { data: { mode: "delegate", at: AT } } },
      challenger: { w1: true, w3: false },
    });
  });

  it("reads a corrupt file, one without a version and one of an older version as the empty policy", () => {
    const cells = { w1: { scope: { mode: "shadow", at: AT } } };
    for (const body of ["{not json", "[]", "null", JSON.stringify({ projects: cells }), JSON.stringify({ version: 0, projects: cells })]) {
      writeFile(body);
      expect(store().read()).toEqual(EMPTY_AUTONOMY_POLICY);
    }
  });

  it("reads a file from a newer paseo-bm as the empty policy and never writes it, not even to reset", () => {
    const newer = writeFile({ version: 2, projects: { w1: { scope: "delegate" } } });
    expect(store().read()).toEqual(EMPTY_AUTONOMY_POLICY);
    expect(codeOf(() => store().set(set("w1", "scope", "shadow"), AT))).toBe("E_AUTONOMY_WRITE_FAILED");
    expect(() => store().set(set("w1", "scope", "shadow"), AT)).toThrow(/newer paseo-bm/);
    expect(codeOf(() => store().reset("w1"))).toBe("E_AUTONOMY_WRITE_FAILED");
    expect(fileBytes()).toBe(newer);
  });

  it("resets one project in one write, leaving other projects and the challenger; a project with no cell writes nothing", () => {
    writeFile({
      version: 1,
      projects: { w1: { scope: { mode: "shadow", at: AT } }, w2: { preference: { mode: "delegate", at: AT } } },
      challenger: { w1: true },
    });
    expect(store().reset("w1")).toEqual({
      projects: { w2: { preference: { mode: "delegate", at: AT } } },
      challenger: { w1: true },
    });
    const after = fileBytes();
    expect(store().reset("w1")).toEqual(store().read());
    expect(fileBytes()).toBe(after);
    rmSync(join(home, AUTONOMY_DIR_NAME), { recursive: true });
    store().reset("w9");
    expect(existsSync(join(home, AUTONOMY_DIR_NAME))).toBe(false);
  });

  it("refuses a symlinked autonomy folder and writes nothing through it", () => {
    const elsewhere = join(root, "elsewhere");
    mkdirSync(elsewhere);
    mkdirSync(home);
    symlinkSync(elsewhere, join(home, AUTONOMY_DIR_NAME));
    expect(() => store().read()).toThrow();
    expect(() => store().set(set("w1", "scope", "shadow"), AT)).toThrow();
    expect(() => store().reset("w1")).toThrow();
    expect(readdirSync(elsewhere)).toEqual([]);
  });
});

describe("levels (ADR-025)", () => {
  const CRUISE = ["reversible-technical", "preference", "scope", "environment", "dependency"];
  const TURBO = [...CRUISE, "cost", "release", "data"];
  const delegatedOf = (policy: AutonomyPolicy, workspaceId: string) => DECISION_CLASSES.filter((decisionClass) => modeOf(policy, workspaceId, decisionClass) === "delegate");

  it("names five levels with their delegated classes", () => {
    expect(LEVELS.map((level) => [level.level, level.key, level.name])).toEqual([
      [0, "hands-on", "Hands-on"],
      [1, "co-pilot", "Co-pilot"],
      [2, "cruise", "Cruise"],
      [3, "turbo", "Turbo"],
      [4, "full-auto", "Full auto"],
    ]);
    expect(LEVELS[0]!.delegated).toEqual([]);
    expect(LEVELS[1]!.delegated).toEqual([]);
    expect([...LEVELS[2]!.delegated].sort()).toEqual([...CRUISE].sort());
    expect([...LEVELS[3]!.delegated].sort()).toEqual([...TURBO].sort());
    expect([...LEVELS[4]!.delegated].sort()).toEqual([...DECISION_CLASSES].sort());
  });

  it("writes each level's pattern in one write: its classes delegate, the rest shadow (owner at 0), the prediction switch on from 1, the boundary untouched", () => {
    writeFile({ version: 1, projects: { w2: { scope: { mode: "shadow", at: AT } } }, challenger: { w2: true }, boundary: { w1: { enabled: true, at: AT } } });
    for (const level of [0, 1, 2, 3, 4] as const) {
      const policy = store().setLevel({ workspaceId: "w1", level, confirmed: true }, AT);
      const delegated = delegatedOf(policy, "w1");
      expect(delegated.sort()).toEqual([...LEVELS[level]!.delegated].sort());
      for (const decisionClass of DECISION_CLASSES) {
        if (delegated.includes(decisionClass)) continue;
        expect(policy.projects["w1"]?.[decisionClass]).toEqual({ mode: level === 0 ? "owner" : "shadow", at: AT });
      }
      expect(Object.keys(policy.projects["w1"] ?? {})).toHaveLength(9);
      expect(challengerOf(policy, "w1")).toBe(level >= 1);
      expect(levelOf(policy, "w1")).toBe(level);
      // Other projects and the action boundary stay as they were.
      expect(policy.projects["w2"]).toEqual({ scope: { mode: "shadow", at: AT } });
      expect(policy.challenger["w2"]).toBe(true);
      expect(policy.boundary).toEqual({ w1: { enabled: true, at: AT } });
      expect(store().read()).toEqual(policy);
    }
  });

  it("refuses Turbo and Full auto without confirmed, an unknown level and a bad project, writing nothing", () => {
    expect(codeOf(() => store().setLevel({ workspaceId: "w1", level: 3 }, AT))).toBe("E_AUTONOMY_NOT_CONFIRMED");
    expect(codeOf(() => store().setLevel({ workspaceId: "w1", level: 4, confirmed: false }, AT))).toBe("E_AUTONOMY_NOT_CONFIRMED");
    expect(codeOf(() => store().setLevel({ workspaceId: "w1", level: 5, confirmed: true }, AT))).toBe("E_AUTONOMY_INVALID");
    expect(codeOf(() => store().setLevel({ workspaceId: "__proto__", level: 1 }, AT))).toBe("E_AUTONOMY_INVALID");
    expect(existsSync(home)).toBe(false);
    // Levels 0-2 need no confirmation.
    expect(levelOf(store().setLevel({ workspaceId: "w1", level: 2 }, AT), "w1")).toBe(2);
  });

  it("reads the owner's real policy (five classes delegated to the Orchestrator, predictions on, the rest unset) as Cruise", () => {
    writeFile({
      version: 1,
      projects: Object.fromEntries(
        ["wks_a", "wks_b"].map((workspaceId) => [workspaceId, Object.fromEntries(CRUISE.map((decisionClass) => [decisionClass, { mode: "delegate", predictor: "orchestrator", at: AT }]))]),
      ),
      challenger: { wks_a: true, wks_b: true },
    });
    const policy = store().read();
    expect(levelOf(policy, "wks_a")).toBe(2);
    expect(levelsOf(policy)).toEqual({ wks_a: 2, wks_b: 2 });
  });

  it("reads 0 with no delegate cell and predictions off, 1 with predictions on and none delegated, and custom otherwise", () => {
    expect(levelOf(EMPTY_AUTONOMY_POLICY, "w1")).toBe(0);
    const shadowOnly = autonomyPolicyOf({ projects: { w1: { scope: { mode: "shadow", at: AT } } }, challenger: {} });
    expect(levelOf(shadowOnly, "w1")).toBe(0);
    expect(levelOf({ ...shadowOnly, challenger: { w1: true } }, "w1")).toBe(1);
    const cruise = withLevel(EMPTY_AUTONOMY_POLICY, "w1", 2, AT);
    // One class more, or one fewer, than a level: custom.
    const extra = autonomyPolicyOf({ projects: { w1: { ...cruise.projects["w1"], cost: { mode: "delegate", at: AT } } }, challenger: { w1: true } });
    expect(levelOf(extra, "w1")).toBe("custom");
    const fewer = autonomyPolicyOf({ projects: { w1: { ...cruise.projects["w1"], scope: { mode: "owner", at: AT } } }, challenger: { w1: true } });
    expect(levelOf(fewer, "w1")).toBe("custom");
    // A delegated class with predictions off: custom.
    expect(levelOf({ ...cruise, challenger: { w1: false } }, "w1")).toBe("custom");
    // At level n the other classes may be owner or shadow.
    const ownerRest = autonomyPolicyOf({ projects: { w1: Object.fromEntries(CRUISE.map((decisionClass) => [decisionClass, { mode: "delegate", at: AT }])) }, challenger: { w1: true } });
    expect(levelOf(ownerRest, "w1")).toBe(2);
  });
});
