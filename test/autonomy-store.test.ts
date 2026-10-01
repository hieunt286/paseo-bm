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
  autonomyPolicyOf,
  canDelegate,
  modeOf,
  predictorOf,
} from "../plugin/shared/autonomy";
import { DashboardError } from "../plugin/shared/contracts";
import { DECISION_CLASSES, HARD_OWNER_CLASSES, PREDICTORS } from "../plugin/shared/decisions";

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
  it("has three modes, two predictors, and never delegates release, data, security or cost", () => {
    expect(AUTONOMY_FILE_VERSION).toBe(1);
    expect(AUTONOMY_MODES).toEqual(["owner", "shadow", "delegate"]);
    // The ledger's predictors are the policy's: one list (code review 2026-09-30 §3.5).
    expect(PREDICTORS).toEqual(["recommended", "orchestrator"]);
    expect(DECISION_CLASSES.filter((decisionClass) => !canDelegate(decisionClass))).toEqual(["security", "data", "release", "cost"]);
    expect([...HARD_OWNER_CLASSES].sort()).toEqual(["cost", "data", "release", "security"]);
  });

  it("reads an absent cell, and an absent project, as owner (REQ-121 b)", () => {
    for (const decisionClass of DECISION_CLASSES) {
      expect(modeOf(EMPTY_AUTONOMY_POLICY, "w1", decisionClass)).toBe("owner");
      expect(predictorOf(EMPTY_AUTONOMY_POLICY, "w1", decisionClass)).toBeNull();
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
    store().set(set("w1", "preference", "delegate", { confirmed: true, predictor: "orchestrator" }), AT);
    expect(readdirSync(join(home, AUTONOMY_DIR_NAME))).toEqual([AUTONOMY_POLICY_FILE]);
    const before = fileBytes();
    // No temporary file can be created in a read-only folder: the write fails before the rename.
    chmodSync(join(home, AUTONOMY_DIR_NAME), 0o500);
    expect(() => store().set(set("w1", "scope", "owner"), AT)).toThrow();
    chmodSync(join(home, AUTONOMY_DIR_NAME), 0o700);
    expect(fileBytes()).toBe(before);
    expect(readdirSync(join(home, AUTONOMY_DIR_NAME))).toEqual([AUTONOMY_POLICY_FILE]);
  });

  it("records the predictor of a delegated cell, recommended by default, and when each cell was set", () => {
    store().set(set("w1", "preference", "delegate", { confirmed: true }), AT);
    store().set(set("w1", "scope", "delegate", { confirmed: true, predictor: "orchestrator" }), "2026-09-30T11:00:00.000Z");
    const policy = store().read();
    expect(policy.projects["w1"]).toEqual({
      preference: { mode: "delegate", predictor: "recommended", at: AT },
      scope: { mode: "delegate", predictor: "orchestrator", at: "2026-09-30T11:00:00.000Z" },
    });
    expect(predictorOf(policy, "w1", "scope")).toBe("orchestrator");
    // Back to owner: the predictor goes with the delegation.
    store().set(set("w1", "scope", "owner", { predictor: "orchestrator" }), AT);
    expect(store().read().projects["w1"]?.scope).toEqual({ mode: "owner", at: AT });
  });

  it("skips a malformed cell alone: unknown class or mode, delegate without a predictor, delegate of a hard-owner class", () => {
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
    expect(policy).toEqual({
      projects: {
        w1: {
          scope: { mode: "shadow", at: AT },
          dependency: { mode: "delegate", predictor: "recommended", at: AT },
        },
      },
      challenger: { w1: true, w3: false },
    });
    for (const decisionClass of HARD_OWNER_CLASSES) {
      expect(modeOf(policy, "w1", decisionClass)).toBe("owner");
      expect(modeOf(policy, "w3", decisionClass)).toBe("owner");
    }
    // The next write keeps what it could read, the challenger included, and drops the rest.
    store().set(set("w1", "scope", "owner"), AT);
    expect(JSON.parse(readFileSync(file(), "utf8"))).toEqual({
      version: 1,
      projects: { w1: { scope: { mode: "owner", at: AT }, dependency: { mode: "delegate", predictor: "recommended", at: AT } } },
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
      projects: { w1: { scope: { mode: "shadow", at: AT } }, w2: { preference: { mode: "delegate", predictor: "recommended", at: AT } } },
      challenger: { w1: true },
    });
    expect(store().reset("w1")).toEqual({
      projects: { w2: { preference: { mode: "delegate", predictor: "recommended", at: AT } } },
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
