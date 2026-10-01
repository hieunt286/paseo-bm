import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAlertStore } from "../plugin/server/alert-store";
import { handleAutonomyLedger } from "../plugin/server/autonomy-ledger-rpc";
import {
  handleAutonomyPolicy,
  handleAutonomyReset,
  handleAutonomySet,
  handleAutonomySetBoundary,
  handleAutonomySetChallenger,
  handleAutonomySetLevel,
  handlePrecedentsEnd,
  handlePrecedentsList,
  handlePrecedentsSave,
  readActivePrecedents,
  readAutonomyPolicy,
  registerAutonomyRpcs,
  type AutonomyRpcDeps,
} from "../plugin/server/autonomy-rpc";
import { AUTONOMY_DIR_NAME, AUTONOMY_POLICY_FILE } from "../plugin/server/autonomy-store";
import { clearMaterialiserMemory, materialiseTurn, type MaterialiserDeps } from "../plugin/server/decision-materialiser";
import { DECISIONS_DIR_NAME, clearDecisionStoreCache, createDecisionStore } from "../plugin/server/decision-store";
import { PRECEDENTS_FILE } from "../plugin/server/precedent-store";
import { EMPTY_AUTONOMY_POLICY, LEVELS, boundaryOf, challengerOf, levelOf, modeOf } from "../plugin/shared/autonomy";
import { AGENT_TOOLS, MANAGER_SERVER_TOOLS, ORCHESTRATOR_SERVER_TOOLS } from "../plugin/shared/bm-tools";
import {
  DASHBOARD_ERROR_CODES,
  DashboardError,
  autonomyPolicyRpc,
  autonomyResetRpc,
  autonomySetBoundaryRpc,
  autonomySetChallengerRpc,
  autonomySetLevelRpc,
  autonomySetRpc,
  precedentsEndRpc,
  precedentsListRpc,
  precedentsSaveRpc,
} from "../plugin/shared/contracts";
import { DECISION_CLASSES, PREPARED_CHANGE_KINDS, answerDecision, type Decision } from "../plugin/shared/decisions";
import { MANAGER, WORKER, WORKSPACE_ID, at, msg, turn } from "./fixtures/orchestrator-traces";
import { DECISION_WS, makeDecision, storedOrchestratorAnswer } from "./helpers/decisions";

/**
 * The owner's autonomy RPCs (autonomy design §B.2, §B.9; PRD REQ-121):
 * `autonomy.policy`, `autonomy.set-level`, `autonomy.set`, `autonomy.reset`
 * and `autonomy.set-challenger`, with the negative cases — Turbo and Full auto
 * and `delegate` refused without confirmation, unknown level, class or mode
 * refused, each writing nothing; any class may be delegated (ADR-025). A temporary data folder named by `PASEO_BM_HOME` only.
 */

const NOW = new Date("2026-09-30T10:00:00.000Z");
const AT = NOW.toISOString();
const DELEGABLE = DECISION_CLASSES;

let root: string;
let home: string;
let logs: string[];
let deps: AutonomyRpcDeps;

const file = () => join(home, AUTONOMY_DIR_NAME, AUTONOMY_POLICY_FILE);
const fileBytes = () => (existsSync(file()) ? readFileSync(file(), "utf8") : null);

function codeOf(run: () => unknown): string | null {
  try {
    run();
    return null;
  } catch (error) {
    return error instanceof DashboardError ? error.code : `not a DashboardError: ${String(error)}`;
  }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "bm-autonomy-rpc-"));
  home = join(root, "data");
  logs = [];
  deps = { env: { PASEO_BM_HOME: home }, homedir: () => root, now: () => NOW, log: (message) => logs.push(message) };
  clearDecisionStoreCache();
  clearMaterialiserMemory();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("autonomy.policy", () => {
  it("reads every cell as owner on a new install, and writes nothing", () => {
    const output = handleAutonomyPolicy({}, deps);
    expect(autonomyPolicyRpc.output.parse(output)).toEqual({ policy: EMPTY_AUTONOMY_POLICY, levels: {} });
    for (const decisionClass of DECISION_CLASSES) expect(modeOf(output.policy, "w1", decisionClass)).toBe("owner");
    expect(existsSync(home)).toBe(false);
  });

  it("returns the whole policy, or one project's with workspaceId", () => {
    handleAutonomySet({ workspaceId: "w1", class: "scope", mode: "shadow" }, deps);
    handleAutonomySet({ workspaceId: "w2", class: "preference", mode: "shadow" }, deps);
    expect(Object.keys(handleAutonomyPolicy({}, deps).policy.projects).sort()).toEqual(["w1", "w2"]);
    expect(handleAutonomyPolicy({ workspaceId: "w2" }, deps).policy).toEqual({
      projects: { w2: { preference: { mode: "shadow", at: AT } } },
      challenger: {},
    });
    expect(handleAutonomyPolicy({ workspaceId: "w9" }, deps)).toEqual({ policy: EMPTY_AUTONOMY_POLICY, levels: { w9: 0 } });
  });

  it("reports each project's level: 0-4 as set, custom for cells that match no level (ADR-025)", () => {
    handleAutonomySetLevel({ workspaceId: "w1", level: 2 }, deps);
    handleAutonomySetLevel({ workspaceId: "w2", level: 4, confirmed: true }, deps);
    handleAutonomySetLevel({ workspaceId: "w3", level: 1 }, deps);
    handleAutonomySet({ workspaceId: "w3", class: "cost", mode: "delegate", confirmed: true }, deps);
    handleAutonomySetChallenger({ workspaceId: "w4", enabled: false }, deps);
    const output = handleAutonomyPolicy({}, deps);
    expect(autonomyPolicyRpc.output.parse(output)).toEqual(output);
    expect(output.levels).toEqual({ w1: 2, w2: 4, w3: "custom", w4: 0 });
    expect(handleAutonomyPolicy({ workspaceId: "w1" }, deps).levels).toEqual({ w1: 2 });
  });

  it("reads the empty policy, never throwing, with no usable data folder or an unreadable store (one log line)", () => {
    expect(readAutonomyPolicy({ env: { PASEO_BM_HOME: "relative/path" }, homedir: () => root })).toEqual(EMPTY_AUTONOMY_POLICY);
    mkdirSync(home);
    symlinkSync(root, join(home, AUTONOMY_DIR_NAME));
    expect(handleAutonomyPolicy({}, deps).policy).toEqual(EMPTY_AUTONOMY_POLICY);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatch(/could not read the autonomy policy/);
  });
});

describe("autonomy.set", () => {
  it("sets and reads back each mode for every delegable class", () => {
    for (const decisionClass of DELEGABLE) {
      for (const mode of ["shadow", "delegate", "owner"] as const) {
        const output = handleAutonomySet({ workspaceId: "w1", class: decisionClass, mode, confirmed: mode === "delegate" ? true : undefined }, deps);
        expect(autonomySetRpc.output.parse(output)).toEqual(output);
        expect(modeOf(output.policy, "w1", decisionClass)).toBe(mode);
        expect(modeOf(handleAutonomyPolicy({ workspaceId: "w1" }, deps).policy, "w1", decisionClass)).toBe(mode);
      }
    }
  });

  it("delegates any class, release and security included, to the Orchestrator with no predictor field (ADR-025; no agreement threshold, ADR-023)", () => {
    for (const decisionClass of ["release", "data", "security", "cost"] as const) {
      const output = handleAutonomySet({ workspaceId: "w1", class: decisionClass, mode: "delegate", confirmed: true }, deps);
      expect(output.policy.projects["w1"]?.[decisionClass]).toEqual({ mode: "delegate", at: AT });
    }
    // The predictor of builds before ADR-025 is refused, not dropped: there is no choice of predictor.
    expect(codeOf(() => handleAutonomySet({ workspaceId: "w1", class: "scope", mode: "delegate", confirmed: true, predictor: "orchestrator" }, deps))).toBe(
      "E_AUTONOMY_INVALID",
    );
  });

  it("needs no confirmation for owner and shadow", () => {
    expect(codeOf(() => handleAutonomySet({ workspaceId: "w1", class: "scope", mode: "shadow" }, deps))).toBeNull();
    expect(codeOf(() => handleAutonomySet({ workspaceId: "w1", class: "scope", mode: "owner", confirmed: false }, deps))).toBeNull();
  });
});

describe("autonomy.set refusals, each writing nothing", () => {
  let before: string | null;
  beforeEach(() => {
    handleAutonomySet({ workspaceId: "w1", class: "scope", mode: "shadow" }, deps);
    before = fileBytes();
  });

  it("refuses delegate without confirmed: true (E_AUTONOMY_NOT_CONFIRMED)", () => {
    for (const decisionClass of DELEGABLE) {
      for (const extra of [{}, { confirmed: false }]) {
        const input = { workspaceId: "w1", class: decisionClass, mode: "delegate", ...extra };
        expect(codeOf(() => handleAutonomySet(input, deps))).toBe("E_AUTONOMY_NOT_CONFIRMED");
      }
    }
    expect(fileBytes()).toBe(before);
  });

  it("refuses an unknown class, mode, predictor or project (E_AUTONOMY_INVALID)", () => {
    const inputs: unknown[] = [
      { workspaceId: "w1", class: "style", mode: "owner" },
      { workspaceId: "w1", class: "Scope", mode: "owner" },
      { workspaceId: "w1", class: "scope", mode: "autopilot" },
      { workspaceId: "w1", class: "scope", mode: "Delegate", confirmed: true },
      { workspaceId: "w1", class: "scope", mode: "delegate", confirmed: true, predictor: "manager" },
      { workspaceId: "w1", class: "scope", mode: "owner", confirmed: "yes" },
      { workspaceId: "", class: "scope", mode: "owner" },
      { workspaceId: "__proto__", class: "scope", mode: "owner" },
      { class: "scope", mode: "owner" },
      { workspaceId: "w1", mode: "owner" },
      { workspaceId: "w1", class: "scope" },
      null,
      "scope",
    ];
    for (const input of inputs) expect(codeOf(() => handleAutonomySet(input, deps))).toBe("E_AUTONOMY_INVALID");
    // The refusal names what was wrong.
    expect(() => handleAutonomySet(inputs[0], deps)).toThrow(/class "style" is not one of the nine decision classes; nothing was saved/);
    expect(() => handleAutonomySet(inputs[2], deps)).toThrow(/mode "autopilot" is not owner, shadow or delegate/);
    expect(() => handleAutonomySet(inputs[7], deps)).toThrow(/workspaceId "__proto__" is not a project/);
    expect(() => handleAutonomySet(null, deps)).toThrow(/expected \{ workspaceId, class, mode \}/);
    // The contract refuses the same inputs on the client side.
    for (const input of inputs.slice(0, 6)) expect(autonomySetRpc.input.safeParse(input).success).toBe(false);
    expect(fileBytes()).toBe(before);
  });

  it("checks the input before the data folder, and refuses without one (E_DATA_HOME_UNAVAILABLE)", () => {
    const unusable = { env: { PASEO_BM_HOME: "relative/path" }, homedir: () => root };
    expect(codeOf(() => handleAutonomySet({ workspaceId: "w1", class: "release", mode: "delegate", confirmed: true }, unusable))).toBe(
      "E_DATA_HOME_UNAVAILABLE",
    );
    expect(codeOf(() => handleAutonomySet({ workspaceId: "w1", class: "scope", mode: "delegate" }, unusable))).toBe("E_AUTONOMY_NOT_CONFIRMED");
    expect(codeOf(() => handleAutonomySet({ workspaceId: "w1", class: "scope", mode: "shadow" }, unusable))).toBe("E_DATA_HOME_UNAVAILABLE");
    expect(codeOf(() => handleAutonomyReset({ workspaceId: "w1" }, unusable))).toBe("E_DATA_HOME_UNAVAILABLE");
    expect(fileBytes()).toBe(before);
  });

  it("refuses a store it cannot write with E_AUTONOMY_WRITE_FAILED", () => {
    rmSync(join(home, AUTONOMY_DIR_NAME), { recursive: true });
    symlinkSync(root, join(home, AUTONOMY_DIR_NAME));
    expect(codeOf(() => handleAutonomySet({ workspaceId: "w1", class: "scope", mode: "shadow" }, deps))).toBe("E_AUTONOMY_WRITE_FAILED");
    expect(codeOf(() => handleAutonomyReset({ workspaceId: "w1" }, deps))).toBe("E_AUTONOMY_WRITE_FAILED");
  });

  it("answers a data folder that cannot be created with E_DATA_HOME_UNAVAILABLE, not a write code (code review 2026-09-30 §3.2)", () => {
    writeFileSync(join(root, "plain-file"), "");
    const uncreatable = { ...deps, env: { PASEO_BM_HOME: join(root, "plain-file", "data") } };
    expect(codeOf(() => handleAutonomySet({ workspaceId: "w1", class: "scope", mode: "shadow" }, uncreatable))).toBe("E_DATA_HOME_UNAVAILABLE");
    expect(codeOf(() => handleAutonomySetChallenger({ workspaceId: "w1", enabled: true }, uncreatable))).toBe("E_DATA_HOME_UNAVAILABLE");
    expect(codeOf(() => handlePrecedentsSave({ scope: "w1", subject: "x", text: "x" }, uncreatable))).toBe("E_DATA_HOME_UNAVAILABLE");
  });
});

describe("autonomy.reset", () => {
  it("returns every class of the project to owner in one action and leaves other projects untouched", () => {
    for (const decisionClass of DELEGABLE) {
      handleAutonomySet({ workspaceId: "w1", class: decisionClass, mode: decisionClass === "scope" ? "shadow" : "delegate", confirmed: true }, deps);
    }
    handleAutonomySet({ workspaceId: "w1", class: "release", mode: "shadow" }, deps);
    handleAutonomySet({ workspaceId: "w2", class: "preference", mode: "delegate", confirmed: true }, deps);
    const other = handleAutonomyPolicy({ workspaceId: "w2" }, deps).policy;

    const output = handleAutonomyReset({ workspaceId: "w1" }, deps);
    expect(autonomyResetRpc.output.parse(output)).toEqual(output);
    for (const decisionClass of DECISION_CLASSES) expect(modeOf(output.policy, "w1", decisionClass)).toBe("owner");
    expect(handleAutonomyPolicy({ workspaceId: "w2" }, deps).policy).toEqual(other);
    expect(modeOf(handleAutonomyPolicy({}, deps).policy, "w2", "preference")).toBe("delegate");
  });

  it("needs no confirmation, and refuses only an unknown project", () => {
    expect(autonomyResetRpc.input.safeParse({ workspaceId: "w1" }).success).toBe(true);
    expect(codeOf(() => handleAutonomyReset({ workspaceId: "w1" }, deps))).toBeNull();
    for (const input of [{}, { workspaceId: "" }, { workspaceId: 7 }, { workspaceId: "__proto__" }, null]) {
      expect(codeOf(() => handleAutonomyReset(input, deps))).toBe("E_AUTONOMY_INVALID");
    }
  });
});

describe("autonomy.set-level (ADR-025)", () => {
  it("writes each level's pattern in one write and reads it back", () => {
    for (const level of [0, 1, 2, 3, 4] as const) {
      const output = handleAutonomySetLevel({ workspaceId: "w1", level, confirmed: true }, deps);
      expect(autonomySetLevelRpc.output.parse(output)).toEqual(output);
      for (const decisionClass of DECISION_CLASSES) {
        const delegated = LEVELS[level]!.delegated.includes(decisionClass);
        expect(modeOf(output.policy, "w1", decisionClass)).toBe(delegated ? "delegate" : level === 0 ? "owner" : "shadow");
      }
      expect(challengerOf(output.policy, "w1")).toBe(level >= 1);
      expect(handleAutonomyPolicy({ workspaceId: "w1" }, deps).levels).toEqual({ w1: level });
      expect(JSON.parse(fileBytes()!)).toEqual({ version: 1, ...output.policy });
    }
  });

  it("keeps the action boundary and the other projects as they are", () => {
    handleAutonomySetBoundary({ workspaceId: "w1", enabled: true, confirmed: true }, deps);
    handleAutonomySet({ workspaceId: "w2", class: "scope", mode: "shadow" }, deps);
    const policy = handleAutonomySetLevel({ workspaceId: "w1", level: 3, confirmed: true }, deps).policy;
    expect(boundaryOf(policy, "w1")).toEqual({ enabled: true, at: AT });
    expect(policy.projects["w2"]).toEqual({ scope: { mode: "shadow", at: AT } });
    expect(levelOf(policy, "w1")).toBe(3);
  });

  it("refuses Turbo and Full auto without confirmed: true (E_AUTONOMY_NOT_CONFIRMED), and a bad level or project (E_AUTONOMY_INVALID), before the data folder, writing nothing", () => {
    handleAutonomySetLevel({ workspaceId: "w1", level: 2 }, deps);
    const before = fileBytes();
    for (const input of [{ workspaceId: "w1", level: 3 }, { workspaceId: "w1", level: 4, confirmed: false }, { workspaceId: "w2", level: 4 }]) {
      expect(codeOf(() => handleAutonomySetLevel(input, deps)), JSON.stringify(input)).toBe("E_AUTONOMY_NOT_CONFIRMED");
    }
    expect(() => handleAutonomySetLevel({ workspaceId: "w1", level: 3 }, deps)).toThrow(/Turbo lets the Orchestrator decide cost, release and data for you/);
    expect(() => handleAutonomySetLevel({ workspaceId: "w1", level: 4 }, deps)).toThrow(/Full auto lets the Orchestrator decide every class, security included/);
    for (const input of [{}, { workspaceId: "w1" }, { workspaceId: "w1", level: 5 }, { workspaceId: "w1", level: -1 }, { workspaceId: "w1", level: "2" }, { workspaceId: "w1", level: 1.5 }, { workspaceId: "__proto__", level: 1 }, { workspaceId: "w1", level: 1, confirmed: "yes" }, null]) {
      expect(codeOf(() => handleAutonomySetLevel(input, deps)), JSON.stringify(input)).toBe("E_AUTONOMY_INVALID");
    }
    expect(() => handleAutonomySetLevel({ workspaceId: "w1", level: 7 }, deps)).toThrow("level 7 is not a level from 0 to 4; nothing was saved");
    expect(fileBytes()).toBe(before);
    const unusable = { env: { PASEO_BM_HOME: "relative/path" }, homedir: () => root };
    expect(codeOf(() => handleAutonomySetLevel({ workspaceId: "w1", level: 4 }, unusable))).toBe("E_AUTONOMY_NOT_CONFIRMED");
    expect(codeOf(() => handleAutonomySetLevel({ workspaceId: "w1", level: 2 }, unusable))).toBe("E_DATA_HOME_UNAVAILABLE");
    rmSync(join(home, AUTONOMY_DIR_NAME), { recursive: true });
    symlinkSync(root, join(home, AUTONOMY_DIR_NAME));
    expect(codeOf(() => handleAutonomySetLevel({ workspaceId: "w1", level: 1 }, deps))).toBe("E_AUTONOMY_WRITE_FAILED");
  });
});

describe("autonomy.set-challenger (autonomy design §B.3, §B.9)", () => {
  it("is off by default; turns one project's challenger on and off with no confirmation, keeping its cells and the other projects", () => {
    expect(challengerOf(handleAutonomyPolicy({}, deps).policy, "w1")).toBe(false);
    handleAutonomySet({ workspaceId: "w1", class: "scope", mode: "shadow" }, deps);
    handleAutonomySet({ workspaceId: "w2", class: "preference", mode: "delegate", confirmed: true }, deps);
    const cells = handleAutonomyPolicy({}, deps).policy.projects;

    const on = handleAutonomySetChallenger({ workspaceId: "w1", enabled: true }, deps);
    expect(autonomySetChallengerRpc.output.parse(on)).toEqual(on);
    expect(on.policy).toEqual({ projects: cells, challenger: { w1: true } });
    expect(JSON.parse(fileBytes()!)).toEqual({ version: 1, projects: cells, challenger: { w1: true } });
    // A project with no cell at all (every class owner) takes it too.
    expect(handleAutonomySetChallenger({ workspaceId: "w3", enabled: true }, deps).policy.challenger).toEqual({ w1: true, w3: true });
    expect(handleAutonomyPolicy({ workspaceId: "w3" }, deps).policy).toEqual({ projects: {}, challenger: { w3: true } });

    // Off again: the owner's answer is kept as false, and the cells are untouched.
    const off = handleAutonomySetChallenger({ workspaceId: "w1", enabled: false }, deps);
    expect(off.policy).toEqual({ projects: cells, challenger: { w1: false, w3: true } });
    expect(challengerOf(off.policy, "w1")).toBe(false);
    // The same switch again writes nothing.
    const before = fileBytes();
    expect(handleAutonomySetChallenger({ workspaceId: "w1", enabled: false }, deps).policy).toEqual(off.policy);
    expect(fileBytes()).toBe(before);
    // Return all to owner leaves the challenger as it is.
    expect(handleAutonomyReset({ workspaceId: "w3" }, deps).policy.challenger).toEqual({ w1: false, w3: true });
  });

  it("refuses an unknown project or a value that is not a boolean (E_AUTONOMY_INVALID), before the data folder, writing nothing", () => {
    handleAutonomySetChallenger({ workspaceId: "w1", enabled: true }, deps);
    const before = fileBytes();
    for (const input of [{}, { workspaceId: "w1" }, { workspaceId: "w1", enabled: "yes" }, { workspaceId: "", enabled: true }, { workspaceId: "__proto__", enabled: true }, null]) {
      expect(codeOf(() => handleAutonomySetChallenger(input, deps)), JSON.stringify(input)).toBe("E_AUTONOMY_INVALID");
    }
    expect(() => handleAutonomySetChallenger({ workspaceId: "w1", enabled: 1 }, deps)).toThrow('enabled 1 is not true or false; nothing was saved');
    expect(() => handleAutonomySetChallenger({ workspaceId: "__proto__", enabled: true }, deps)).toThrow('workspaceId "__proto__" is not a project; nothing was saved');
    expect(fileBytes()).toBe(before);
    const unusable = { env: { PASEO_BM_HOME: "relative/path" }, homedir: () => root };
    expect(codeOf(() => handleAutonomySetChallenger({ workspaceId: "w1", enabled: "on" }, unusable))).toBe("E_AUTONOMY_INVALID");
    expect(codeOf(() => handleAutonomySetChallenger({ workspaceId: "w1", enabled: true }, unusable))).toBe("E_DATA_HOME_UNAVAILABLE");
    rmSync(join(home, AUTONOMY_DIR_NAME), { recursive: true });
    symlinkSync(root, join(home, AUTONOMY_DIR_NAME));
    expect(codeOf(() => handleAutonomySetChallenger({ workspaceId: "w1", enabled: false }, deps))).toBe("E_AUTONOMY_WRITE_FAILED");
  });
});

/**
 * The action boundary's switch per project (autonomy design §D.2, §B.2;
 * change-010 C2–C3): off by default, both directions confirmed, kept on every
 * write, untouched by a reset; only the owner sets it.
 */
describe("autonomy.set-boundary (autonomy design §D.2, change-010)", () => {
  it("is off by default; on and off each need confirmed: true, keep the cells, the challenger and the other projects", () => {
    expect(boundaryOf(handleAutonomyPolicy({}, deps).policy, "w1")).toBeNull();
    handleAutonomySet({ workspaceId: "w1", class: "scope", mode: "shadow" }, deps);
    handleAutonomySetChallenger({ workspaceId: "w1", enabled: true }, deps);
    const cells = handleAutonomyPolicy({}, deps).policy.projects;

    const on = handleAutonomySetBoundary({ workspaceId: "w1", enabled: true, confirmed: true }, deps);
    expect(autonomySetBoundaryRpc.output.parse(on)).toEqual(on);
    expect(on.policy).toEqual({ projects: cells, challenger: { w1: true }, boundary: { w1: { enabled: true, at: AT } } });
    expect(JSON.parse(fileBytes()!)).toEqual({ version: 1, projects: cells, challenger: { w1: true }, boundary: { w1: { enabled: true, at: AT } } });
    expect(handleAutonomyPolicy({ workspaceId: "w1" }, deps).policy.boundary).toEqual({ w1: { enabled: true, at: AT } });
    expect(handleAutonomyPolicy({ workspaceId: "w2" }, deps).policy).toEqual({ projects: {}, challenger: {} });
    // The same side again writes nothing and keeps when it was turned on.
    const before = fileBytes();
    expect(handleAutonomySetBoundary({ workspaceId: "w1", enabled: true, confirmed: true }, { ...deps, now: () => new Date("2026-10-02T00:00:00.000Z") }).policy.boundary).toEqual({ w1: { enabled: true, at: AT } });
    expect(fileBytes()).toBe(before);
    // Kept by every other write; untouched by Return all to owner.
    handleAutonomySet({ workspaceId: "w2", class: "preference", mode: "shadow" }, deps);
    handleAutonomySetChallenger({ workspaceId: "w1", enabled: false }, deps);
    expect(handleAutonomyReset({ workspaceId: "w1" }, deps).policy.boundary).toEqual({ w1: { enabled: true, at: AT } });

    // Off removes the entry (and the key with the last one).
    const off = handleAutonomySetBoundary({ workspaceId: "w1", enabled: false, confirmed: true }, deps);
    expect(off.policy).not.toHaveProperty("boundary");
    expect(JSON.parse(fileBytes()!)).not.toHaveProperty("boundary");
  });

  it("without confirmed: true either way → E_AUTONOMY_NOT_CONFIRMED; a bad input → E_AUTONOMY_INVALID; before the data folder, writing nothing", () => {
    handleAutonomySetBoundary({ workspaceId: "w1", enabled: true, confirmed: true }, deps);
    const before = fileBytes();
    for (const input of [{ workspaceId: "w2", enabled: true }, { workspaceId: "w2", enabled: true, confirmed: false }, { workspaceId: "w1", enabled: false }]) {
      expect(codeOf(() => handleAutonomySetBoundary(input, deps)), JSON.stringify(input)).toBe("E_AUTONOMY_NOT_CONFIRMED");
    }
    expect(() => handleAutonomySetBoundary({ workspaceId: "w1", enabled: false }, deps)).toThrow("turning the action boundary off needs the owner's confirmation; nothing was saved");
    for (const input of [{}, { workspaceId: "w1" }, { workspaceId: "w1", enabled: "yes", confirmed: true }, { workspaceId: "__proto__", enabled: true, confirmed: true }, { workspaceId: "w1", enabled: true, confirmed: "yes" }, null]) {
      expect(codeOf(() => handleAutonomySetBoundary(input, deps)), JSON.stringify(input)).toBe("E_AUTONOMY_INVALID");
    }
    expect(fileBytes()).toBe(before);
    const unusable = { env: { PASEO_BM_HOME: "relative/path" }, homedir: () => root };
    expect(codeOf(() => handleAutonomySetBoundary({ workspaceId: "w1", enabled: true }, unusable))).toBe("E_AUTONOMY_NOT_CONFIRMED");
    expect(codeOf(() => handleAutonomySetBoundary({ workspaceId: "w1", enabled: true, confirmed: true }, unusable))).toBe("E_DATA_HOME_UNAVAILABLE");
    rmSync(join(home, AUTONOMY_DIR_NAME), { recursive: true });
    symlinkSync(root, join(home, AUTONOMY_DIR_NAME));
    expect(codeOf(() => handleAutonomySetBoundary({ workspaceId: "w1", enabled: false, confirmed: true }, deps))).toBe("E_AUTONOMY_WRITE_FAILED");
  });

  it("a Phase 2/3 file, an absent and a malformed entry read as off; a malformed one is dropped by the next write", () => {
    mkdirSync(join(home, AUTONOMY_DIR_NAME), { recursive: true });
    const write = (body: unknown) => writeFileSync(join(home, AUTONOMY_DIR_NAME, AUTONOMY_POLICY_FILE), JSON.stringify(body));
    write({ version: 1, projects: {}, challenger: { w1: true } });
    expect(boundaryOf(readAutonomyPolicy(deps), "w1")).toBeNull();
    write({ version: 1, projects: {}, challenger: {}, boundary: { w1: { enabled: false, at: AT }, w2: { enabled: true }, w3: true, w4: { enabled: true, at: "later" }, w5: { enabled: true, at: AT } } });
    const read = readAutonomyPolicy(deps);
    for (const id of ["w1", "w2", "w3", "w4", "w6"]) expect(boundaryOf(read, id), id).toBeNull();
    expect(boundaryOf(read, "w5")).toEqual({ enabled: true, at: AT });
    handleAutonomySet({ workspaceId: "w1", class: "scope", mode: "shadow" }, deps);
    expect(JSON.parse(fileBytes()!).boundary).toEqual({ w5: { enabled: true, at: AT } });
    write({ version: 1, projects: {}, challenger: {}, boundary: "on" });
    expect(readAutonomyPolicy(deps)).toEqual(EMPTY_AUTONOMY_POLICY);
  });

  it("is the owner's only: no agent tool and no prepared change writes it; an autonomy.set carrying a boundary is refused", () => {
    const names = [...ORCHESTRATOR_SERVER_TOOLS, ...MANAGER_SERVER_TOOLS, ...AGENT_TOOLS].map((tool) => tool.name);
    expect(names.filter((name) => /boundary/i.test(name))).toEqual([]);
    expect(PREPARED_CHANGE_KINDS).not.toContain("autonomy.set-boundary");
    expect(PREPARED_CHANGE_KINDS.filter((kind) => /boundary/.test(kind))).toEqual([]);
    const carrying = { workspaceId: "w1", class: "scope", mode: "shadow", boundary: { w1: { enabled: true, at: AT } }, enabled: true, confirmed: true };
    expect(codeOf(() => handleAutonomySet(carrying, deps))).toBe("E_AUTONOMY_INVALID");
    expect(readAutonomyPolicy(deps)).not.toHaveProperty("boundary");
  });
});

describe("precedents (autonomy design §B.6, §B.9)", () => {
  const precedentsFile = () => join(home, AUTONOMY_DIR_NAME, PRECEDENTS_FILE);
  const precedentBytes = () => (existsSync(precedentsFile()) ? readFileSync(precedentsFile(), "utf8") : null);
  const later = (days: number) => new Date(NOW.getTime() + days * 24 * 60 * 60 * 1000);
  const at = (date: Date): AutonomyRpcDeps => ({ ...deps, now: () => date });

  function answered(overrides: Partial<Decision> = {}, answer: { optionKey?: string; words?: string } = { optionKey: "c" }): Decision {
    const result = answerDecision(makeDecision(overrides), { via: "inbox", optionKey: answer.optionKey ?? null, words: answer.words ?? null, at: AT });
    if (!result.ok) throw new Error(result.message);
    createDecisionStore(home).open(makeDecision(overrides));
    createDecisionStore(home).transition(result.decision.id, () => ({ ok: true, decision: result.decision }), result.decision.workspaceId);
    return result.decision;
  }

  it("lists none and writes nothing on a new install, and none without a usable data folder", () => {
    expect(precedentsListRpc.output.parse(handlePrecedentsList({}, deps))).toEqual({ precedents: [] });
    expect(readActivePrecedents({ env: { PASEO_BM_HOME: "relative/path" }, homedir: () => root })).toEqual([]);
    expect(existsSync(home)).toBe(false);
  });

  it("saves one written in Settings, lasting 30 days, and lists a project's own and the global ones", () => {
    const own = handlePrecedentsSave({ scope: "w1", subject: "test-layout", text: "  One test file per module. " }, deps);
    expect(precedentsSaveRpc.output.parse(own)).toEqual(own);
    expect(own).toMatchObject({
      precedent: { scope: "w1", subject: "test-layout", text: "One test file per module.", sourceDecisionId: null, createdAt: AT, expiresAt: later(30).toISOString(), supersededBy: null },
      superseded: [],
    });
    const global = handlePrecedentsSave({ scope: "all", subject: "commit-style", text: "Conventional commits.", expiresInDays: 7 }, at(later(1)));
    handlePrecedentsSave({ scope: "w2", subject: "test-layout", text: "Tests beside the code." }, at(later(2)));
    expect(global.precedent.expiresAt).toBe(later(8).toISOString());
    expect(handlePrecedentsList({ workspaceId: "w1" }, at(later(3))).precedents.map((p) => p.subject + "@" + p.scope)).toEqual(["commit-style@all", "test-layout@w1"]);
    expect(handlePrecedentsList({}, at(later(3))).precedents).toHaveLength(3);
    // Expired ones are no longer listed.
    expect(handlePrecedentsList({ workspaceId: "w1" }, at(later(10))).precedents.map((p) => p.subject)).toEqual(["test-layout"]);
    expect(handlePrecedentsList({ workspaceId: "w1" }, at(later(30))).precedents).toEqual([]);
  });

  it("saves one from the owner's answered decision: its subject, its answer as the text (or the text given), its project or all", () => {
    const decision = answered({}, { optionKey: "a" });
    const saved = handlePrecedentsSave({ decisionId: decision.id, scope: DECISION_WS }, deps);
    expect(saved.precedent).toMatchObject({ scope: DECISION_WS, subject: "push-backends", text: "Push contract only", sourceDecisionId: decision.id });
    // Saved again for all projects, with the text edited: a different scope supersedes nothing.
    const everywhere = handlePrecedentsSave({ decisionId: decision.id, scope: "all", text: "Push the contract only." }, deps);
    expect(everywhere).toMatchObject({ precedent: { scope: "all", text: "Push the contract only." }, superseded: [] });
    const words = answered({ id: "q:req-20260929T073348Z:Q2" }, { words: "Hold everything until Monday." });
    expect(handlePrecedentsSave({ decisionId: words.id, scope: "all" }, deps).precedent.text).toBe("Hold everything until Monday.");
  });

  it("supersedes the active precedent of the same scope and subject (REQ-124 c)", () => {
    const decision = answered();
    const first = handlePrecedentsSave({ decisionId: decision.id, scope: DECISION_WS }, deps).precedent;
    const second = handlePrecedentsSave({ scope: DECISION_WS, subject: "push-backends", text: "Push both." }, at(later(1)));
    expect(second.superseded).toEqual([first.id]);
    expect(handlePrecedentsList({ workspaceId: DECISION_WS }, at(later(1))).precedents).toEqual([second.precedent]);
  });

  it("ends a precedent: it expires now and leaves the list; ending it again changes nothing", () => {
    const { precedent } = handlePrecedentsSave({ scope: "w1", subject: "test-layout", text: "One test file per module." }, deps);
    const ended = handlePrecedentsEnd({ id: precedent.id }, at(later(2)));
    expect(precedentsEndRpc.output.parse(ended)).toEqual({ precedent: { ...precedent, expiresAt: later(2).toISOString() } });
    expect(handlePrecedentsList({}, at(later(2))).precedents).toEqual([]);
    const bytes = precedentBytes();
    expect(handlePrecedentsEnd({ id: precedent.id }, at(later(3)))).toEqual(ended);
    expect(precedentBytes()).toBe(bytes);
  });

  describe("refusals, each writing nothing", () => {
    let before: string | null;
    beforeEach(() => {
      handlePrecedentsSave({ scope: "w1", subject: "test-layout", text: "One test file per module." }, deps);
      before = precedentBytes();
    });

    it("refuses an input that is not a precedent (E_PRECEDENT_INVALID), before the data folder is looked at", () => {
      const unusable = { env: { PASEO_BM_HOME: "relative/path" }, homedir: () => root };
      for (const input of [
        null,
        {},
        { scope: "w1", subject: "Test Layout", text: "x" },
        { scope: "w1", subject: "x", text: " " },
        { scope: "w1", subject: "x" },
        { scope: "w1", text: "x" },
        { scope: "w1", subject: "x", text: "x", expiresInDays: 366 },
        { scope: "", subject: "x", text: "x" },
      ]) {
        expect(codeOf(() => handlePrecedentsSave(input, deps)), JSON.stringify(input)).toBe("E_PRECEDENT_INVALID");
        expect(codeOf(() => handlePrecedentsSave(input, unusable)), JSON.stringify(input)).toBe("E_PRECEDENT_INVALID");
      }
      expect(codeOf(() => handlePrecedentsSave({ scope: "w1", subject: "x", text: "x" }, unusable))).toBe("E_DATA_HOME_UNAVAILABLE");
      for (const input of [{}, { id: "" }, { id: "q:req:Q1" }, null]) expect(codeOf(() => handlePrecedentsEnd(input, deps))).toBe("E_PRECEDENT_INVALID");
      expect(precedentBytes()).toBe(before);
    });

    it("refuses a decision that is unknown, open, not the owner's, without a subject, or saved to another project", () => {
      expect(codeOf(() => handlePrecedentsSave({ decisionId: "q:req-20260929T073348Z:Q9", scope: "all" }, deps))).toBe("E_DECISION_NOT_FOUND");
      createDecisionStore(home).open(makeDecision({ id: "q:req-20260929T073348Z:Q3" }));
      expect(() => handlePrecedentsSave({ decisionId: "q:req-20260929T073348Z:Q3", scope: "all" }, deps)).toThrow(/E_PRECEDENT_INVALID: .*is open/);
      const noSubject = answered({ id: "q:req-20260929T073348Z:Q4", subject: null });
      expect(() => handlePrecedentsSave({ decisionId: noSubject.id, scope: "all" }, deps)).toThrow(/has no subject/);
      const decision = answered({ id: "q:req-20260929T073348Z:Q5" });
      expect(() => handlePrecedentsSave({ decisionId: decision.id, scope: "w9" }, deps)).toThrow(/its own project or in all projects/);
      expect(() => handlePrecedentsSave({ decisionId: decision.id, scope: "all", subject: "another" }, deps)).toThrow(/is about "push-backends"/);
      const byOrchestrator = storedOrchestratorAnswer(makeDecision({ id: "q:req-20260929T073348Z:Q6" }), { optionKey: "c", reason: "No effect.", at: AT });
      if (!byOrchestrator.ok) throw new Error(byOrchestrator.message);
      createDecisionStore(home).open(makeDecision({ id: "q:req-20260929T073348Z:Q6" }));
      createDecisionStore(home).transition(byOrchestrator.decision.id, () => ({ ok: true, decision: byOrchestrator.decision }), DECISION_WS);
      expect(() => handlePrecedentsSave({ decisionId: byOrchestrator.decision.id, scope: "all" }, deps)).toThrow(/not answered by you/);
      expect(precedentBytes()).toBe(before);
    });

    it("refuses an unknown precedent (E_PRECEDENT_NOT_FOUND) and a store it cannot write (E_PRECEDENT_WRITE_FAILED)", () => {
      expect(codeOf(() => handlePrecedentsEnd({ id: "p:nothing" }, deps))).toBe("E_PRECEDENT_NOT_FOUND");
      expect(precedentBytes()).toBe(before);
      rmSync(join(home, AUTONOMY_DIR_NAME), { recursive: true });
      symlinkSync(root, join(home, AUTONOMY_DIR_NAME));
      expect(codeOf(() => handlePrecedentsSave({ scope: "w1", subject: "x", text: "x" }, deps))).toBe("E_PRECEDENT_WRITE_FAILED");
      expect(codeOf(() => handlePrecedentsEnd({ id: "p:nothing" }, deps))).toBe("E_PRECEDENT_WRITE_FAILED");
      // Reading through the symlink reads none, with one log line.
      expect(handlePrecedentsList({}, deps)).toEqual({ precedents: [] });
      expect(logs.some((line) => /could not read the precedents/.test(line))).toBe(true);
    });

    it("refuses a decision it cannot read with E_DATA_HOME_UNAVAILABLE, never the precedents' write code", () => {
      const decision = answered({ id: "q:req-20260929T073348Z:Q7" });
      const dir = join(home, DECISIONS_DIR_NAME);
      renameSync(dir, join(root, "moved"));
      symlinkSync(join(root, "moved"), dir);
      clearDecisionStoreCache();
      expect(() => handlePrecedentsSave({ decisionId: decision.id, scope: "all" }, deps)).toThrow(/^E_DATA_HOME_UNAVAILABLE: cannot read the decision: /);
      expect(precedentBytes()).toBe(before);
    });
  });
});

describe("a reversal is only recorded (ADR-025 decision 4: no demotion)", () => {
  const WS = WORKSPACE_ID;
  const REQUEST = "req-20260929T073348Z";
  const OPTIONS = [
    { key: "a", label: "One test file per module", recommended: true, effects: [] },
    { key: "b", label: "One test file", recommended: false, effects: [] },
  ];
  const idOf = (qn: string) => `q:${REQUEST}:${qn}`;
  const materialiser = (): MaterialiserDeps => ({ home, now: () => NOW, log: (message) => logs.push(message), workerOf: async () => WORKER });

  /** Stores question `qn` of the request, of class scope, answered with its recommended option by `by`. */
  function answered(qn: string, by: "policy" | "precedent"): Decision {
    const open = makeDecision({
      id: idOf(qn),
      workspaceId: WS,
      requestId: REQUEST,
      class: "scope",
      options: OPTIONS,
      subject: "test-layout",
      prediction: { recommended: { optionKey: "a" }, orchestrator: null },
    });
    const delegated = by === "policy" ? { class: "scope" as const } : { class: "scope" as const, precedentId: "p:3f2a" };
    const result = answerDecision(open, { via: "inbox", optionKey: "a", at: at(4), by, ...delegated });
    if (!result.ok) throw new Error(result.message);
    createDecisionStore(home).open(open);
    createDecisionStore(home).transition(open.id, () => ({ ok: true, decision: result.decision }), WS);
    return result.decision;
  }

  const reaskTurn = (qn: string) =>
    turn({
      agentId: MANAGER,
      role: "manager",
      workspaceId: WS,
      endedAt: at(5),
      sent: [
        msg(
          MANAGER,
          at(5),
          [
            "BM-REPORT",
            `requestId: ${REQUEST}`,
            "phase: blocked",
            "tier: Medium",
            "blockers: see BM-QUESTIONS",
            "",
            "BM-QUESTIONS",
            `requestId: ${REQUEST}`,
            `${qn}: Which test layout, again? [subject: test-layout] [class: scope]`,
            "- a: One test file per module (recommended)",
            "- b: One test file",
          ].join("\n"),
          "agent",
        ),
      ],
    });

  it("a re-ask of what the policy answered records the reversal and leaves the cell, the level and the alerts as they were", async () => {
    handleAutonomySetLevel({ workspaceId: WS, level: 2 }, deps);
    const policyBefore = fileBytes();
    answered("Q1", "policy");
    await materialiseTurn(reaskTurn("Q2"), materialiser());
    expect(createDecisionStore(home).get(idOf("Q1"), WS)?.reversals).toEqual([{ kind: "re-asked", at: at(5), ref: idOf("Q2") }]);
    expect(fileBytes()).toBe(policyBefore);
    expect(levelOf(readAutonomyPolicy(deps), WS)).toBe(2);
    expect(createAlertStore(home).list({})).toEqual([]);
    // The ledger still counts the delegated answer, reversed.
    expect(handleAutonomyLedger({ workspaceId: WS }, deps).delegated).toMatchObject([{ class: "scope", by: "policy", count: 1, reversals: 1 }]);
  });
});

describe("registration", () => {
  it("registers the six policy RPCs and the three precedent RPCs, and their codes are in the registry", () => {
    const handle = vi.fn();
    registerAutonomyRpcs({ handle } as unknown as Parameters<typeof registerAutonomyRpcs>[0], deps);
    expect(handle.mock.calls.map(([contract]) => (contract as { name: string }).name)).toEqual([
      "autonomy.policy",
      "autonomy.set-level",
      "autonomy.set",
      "autonomy.reset",
      "autonomy.set-challenger",
      "autonomy.set-boundary",
      "precedents.list",
      "precedents.save",
      "precedents.end",
    ]);
    const handler = (contract: unknown) => handle.mock.calls.find(([registered]) => registered === contract)![1] as (input: unknown) => unknown;
    handler(autonomySetRpc)({ workspaceId: "w1", class: "scope", mode: "shadow" });
    expect(handler(autonomyPolicyRpc)({})).toEqual({ policy: { projects: { w1: { scope: { mode: "shadow", at: AT } } }, challenger: {} }, levels: { w1: 0 } });
    expect(handler(autonomyResetRpc)({ workspaceId: "w1" })).toEqual({ policy: EMPTY_AUTONOMY_POLICY });
    expect(handler(autonomySetChallengerRpc)({ workspaceId: "w1", enabled: true })).toEqual({ policy: { projects: {}, challenger: { w1: true } } });
    expect(handler(autonomySetLevelRpc)({ workspaceId: "w2", level: 1 })).toMatchObject({ policy: { challenger: { w1: true, w2: true } } });
    for (const code of ["E_AUTONOMY_NOT_CONFIRMED", "E_AUTONOMY_INVALID", "E_AUTONOMY_WRITE_FAILED"]) {
      expect(DASHBOARD_ERROR_CODES).toContain(code);
    }
    expect(DASHBOARD_ERROR_CODES).not.toContain("E_AUTONOMY_OWNER_ONLY");
    const saved = handler(precedentsSaveRpc)({ scope: "all", subject: "commit-style", text: "Conventional commits." }) as { precedent: { id: string } };
    expect(handler(precedentsListRpc)({})).toEqual({ precedents: [saved.precedent] });
    expect((handler(precedentsEndRpc)({ id: saved.precedent.id }) as { precedent: { expiresAt: string } }).precedent.expiresAt).toBe(AT);
    for (const code of ["E_PRECEDENT_INVALID", "E_PRECEDENT_NOT_FOUND", "E_PRECEDENT_WRITE_FAILED"]) expect(DASHBOARD_ERROR_CODES).toContain(code);
  });

  it("are the owner's: no agent tool sets the policy or saves or ends a precedent", () => {
    const names = [...ORCHESTRATOR_SERVER_TOOLS, ...MANAGER_SERVER_TOOLS, ...AGENT_TOOLS].map((tool) => tool.name);
    expect(names.length).toBeGreaterThan(0);
    expect(names.filter((name) => /autonomy|policy|delegat/i.test(name))).toEqual([]);
    expect(names.filter((name) => /precedent/i.test(name) && /save|end|add|set/i.test(name))).toEqual([]);
  });
});
