import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAlertStore } from "../plugin/server/alert-store";
import { handleAutonomyLedger } from "../plugin/server/autonomy-ledger-rpc";
import {
  clearRenewedDemotions,
  demoteOnReversal,
  handleAutonomyPolicy,
  handleAutonomyReset,
  handleAutonomySet,
  handleAutonomySetBoundary,
  handleAutonomySetChallenger,
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
import { alertKeyOf } from "../plugin/shared/alerts";
import { EMPTY_AUTONOMY_POLICY, boundaryOf, canDelegate, challengerOf, demotedAtOf, modeOf, type AutonomyPredictor } from "../plugin/shared/autonomy";
import { AGENT_TOOLS, MANAGER_SERVER_TOOLS, ORCHESTRATOR_SERVER_TOOLS } from "../plugin/shared/bm-tools";
import {
  DASHBOARD_ERROR_CODES,
  DashboardError,
  autonomyPolicyRpc,
  autonomyResetRpc,
  autonomySetBoundaryRpc,
  autonomySetChallengerRpc,
  autonomySetRpc,
  precedentsEndRpc,
  precedentsListRpc,
  precedentsSaveRpc,
} from "../plugin/shared/contracts";
import { DECISION_CLASSES, HARD_OWNER_CLASSES, PREPARED_CHANGE_KINDS, answerDecision, recordReversal, type Decision } from "../plugin/shared/decisions";
import { MANAGER, WORKER, WORKSPACE_ID, at, msg, turn } from "./fixtures/orchestrator-traces";
import { DECISION_WS, makeDecision, storedOrchestratorAnswer } from "./helpers/decisions";

/**
 * The owner's autonomy RPCs (autonomy design §B.2, §B.9; PRD REQ-121):
 * `autonomy.policy`, `autonomy.set`, `autonomy.reset` and
 * `autonomy.set-challenger`, with the negative
 * cases of the bead — `delegate` refused for release, data, security and cost
 * and without confirmation, unknown class or mode refused, each writing
 * nothing. A temporary data folder named by `PASEO_BM_HOME` only.
 */

const NOW = new Date("2026-09-30T10:00:00.000Z");
const AT = NOW.toISOString();
const DELEGABLE = DECISION_CLASSES.filter((decisionClass) => canDelegate(decisionClass));

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
    expect(autonomyPolicyRpc.output.parse(output)).toEqual({ policy: EMPTY_AUTONOMY_POLICY });
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
    expect(handleAutonomyPolicy({ workspaceId: "w9" }, deps).policy).toEqual(EMPTY_AUTONOMY_POLICY);
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

  it("records the predictor of a delegation: the one named, else recommended (eligibility is not checked here)", () => {
    const named = handleAutonomySet({ workspaceId: "w1", class: "scope", mode: "delegate", confirmed: true, predictor: "orchestrator" }, deps);
    expect(named.policy.projects["w1"]?.scope).toEqual({ mode: "delegate", predictor: "orchestrator", at: AT });
    const unnamed = handleAutonomySet({ workspaceId: "w1", class: "preference", mode: "delegate", confirmed: true }, deps);
    expect(unnamed.policy.projects["w1"]?.preference).toEqual({ mode: "delegate", predictor: "recommended", at: AT });
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

  it("refuses delegate for release, data, security and cost, with or without confirmed (E_AUTONOMY_OWNER_ONLY)", () => {
    expect([...HARD_OWNER_CLASSES].sort()).toEqual(["cost", "data", "release", "security"]);
    for (const decisionClass of HARD_OWNER_CLASSES) {
      for (const extra of [{}, { confirmed: true }, { confirmed: false }, { confirmed: true, predictor: "orchestrator" }]) {
        const input = { workspaceId: "w1", class: decisionClass, mode: "delegate", ...extra };
        expect(codeOf(() => handleAutonomySet(input, deps))).toBe("E_AUTONOMY_OWNER_ONLY");
      }
      expect(() => handleAutonomySet({ workspaceId: "w1", class: decisionClass, mode: "delegate", confirmed: true }, deps)).toThrow(
        new RegExp(`${decisionClass} decisions are always the owner's`),
      );
      // Also on a project with no file at all yet.
      expect(codeOf(() => handleAutonomySet({ workspaceId: "w2", class: decisionClass, mode: "delegate", confirmed: true }, deps))).toBe(
        "E_AUTONOMY_OWNER_ONLY",
      );
    }
    expect(fileBytes()).toBe(before);
  });

  it("refuses delegate without confirmed: true (E_AUTONOMY_NOT_CONFIRMED)", () => {
    for (const decisionClass of DELEGABLE) {
      for (const extra of [{}, { confirmed: false }, { predictor: "orchestrator" }]) {
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
      "E_AUTONOMY_OWNER_ONLY",
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
    handleAutonomySet({ workspaceId: "w2", class: "preference", mode: "delegate", confirmed: true, predictor: "orchestrator" }, deps);
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

  it("is the owner's only: no agent tool and no prepared change writes it; an autonomy.set carrying a boundary sets only its cell", () => {
    const names = [...ORCHESTRATOR_SERVER_TOOLS, ...MANAGER_SERVER_TOOLS, ...AGENT_TOOLS].map((tool) => tool.name);
    expect(names.filter((name) => /boundary/i.test(name))).toEqual([]);
    expect(PREPARED_CHANGE_KINDS).not.toContain("autonomy.set-boundary");
    expect(PREPARED_CHANGE_KINDS.filter((kind) => /boundary/.test(kind))).toEqual([]);
    const set = handleAutonomySet({ workspaceId: "w1", class: "scope", mode: "shadow", boundary: { w1: { enabled: true, at: AT } }, enabled: true, confirmed: true }, deps);
    expect(set.policy).not.toHaveProperty("boundary");
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

describe("demotion (autonomy design §B.4, §B.9; REQ-123 b)", () => {
  const WS = WORKSPACE_ID;
  const REQUEST = "req-20260929T073348Z";
  const DAY = 24 * 60 * 60 * 1000;
  const later = (days: number) => new Date(NOW.getTime() + days * DAY);
  const OPTIONS = [
    { key: "a", label: "One test file per module", recommended: true, effects: [] },
    { key: "b", label: "One test file", recommended: false, effects: [] },
  ];
  const idOf = (qn: string) => `q:${REQUEST}:${qn}`;
  const policyFile = () => fileBytes();
  const demotionAlerts = (open?: boolean) => createAlertStore(home).list({ kinds: ["autonomy-demoted"], ...(open === undefined ? {} : { open }) });
  const scopeKey = alertKeyOf("autonomy-demoted", WS, "scope");
  const materialiser = (): MaterialiserDeps => ({ home, now: () => NOW, log: (message) => logs.push(message), workerOf: async () => WORKER });

  /** Stores question `qn` of the request, of class scope, answered with its recommended option by `by` at `when`. */
  function answered(qn: string, by: "policy" | "precedent" | "owner", options: { when?: string; subject?: string; predictor?: AutonomyPredictor } = {}): Decision {
    const open = makeDecision({
      id: idOf(qn),
      workspaceId: WS,
      requestId: REQUEST,
      class: "scope",
      options: OPTIONS,
      subject: options.subject ?? "test-layout",
      prediction: { recommended: { optionKey: "a" }, orchestrator: null },
    });
    const delegated = by === "owner" ? {} : { class: "scope" as const, ...(by === "policy" ? { predictor: options.predictor ?? "recommended" } : { precedentId: "p:3f2a" }) };
    const result = answerDecision(open, { via: "inbox", optionKey: "a", at: options.when ?? at(4), by, ...delegated });
    if (!result.ok) throw new Error(result.message);
    createDecisionStore(home).open(open);
    createDecisionStore(home).transition(open.id, () => ({ ok: true, decision: result.decision }), WS);
    return result.decision;
  }
  const stored = (qn: string) => createDecisionStore(home).get(idOf(qn), WS);
  const delegateScope = (predictor: AutonomyPredictor = "recommended") =>
    handleAutonomySet({ workspaceId: WS, class: "scope", mode: "delegate", confirmed: true, predictor }, deps);

  /** The Manager turn that brings a Worker question asking `subject` again in the same request. */
  const reaskTurn = (qn: string, subject = "test-layout", when = at(5)) =>
    turn({
      agentId: MANAGER,
      role: "manager",
      workspaceId: WS,
      endedAt: when,
      sent: [
        msg(
          MANAGER,
          when,
          [
            "BM-REPORT",
            `requestId: ${REQUEST}`,
            "phase: blocked",
            "tier: Medium",
            "blockers: see BM-QUESTIONS",
            "",
            "BM-QUESTIONS",
            `requestId: ${REQUEST}`,
            `${qn}: Which test layout, again? [subject: ${subject}] [class: scope]`,
            "- a: One test file per module (recommended)",
            "- b: One test file",
          ].join("\n"),
          "agent",
        ),
      ],
    });
  /** A Worker turn that reopened a bead with `reason`. */
  const reopenTurn = (reason: string, when = at(10)) =>
    turn({
      agentId: WORKER,
      role: "worker",
      workspaceId: WS,
      parentAgentId: MANAGER,
      requestId: REQUEST,
      endedAt: when,
      evidence: [{ kind: "shell", detail: `br reopen bm-12 --reason "${reason}"`, agentId: WORKER, at: when }],
    });

  it("a re-ask with the same subject of what the policy answered takes the delegated class back to shadow at once, with one alert", async () => {
    delegateScope();
    const before = answered("Q1", "policy");
    await materialiseTurn(reaskTurn("Q2"), materialiser());
    const policy = readAutonomyPolicy(deps);
    expect(policy.projects[WS]?.scope).toEqual({ mode: "shadow", at: AT });
    expect(demotedAtOf(policy, WS, "scope")).toBe(AT);
    expect(demotionAlerts()).toEqual([
      {
        key: scopeKey,
        workspaceId: WS,
        kind: "autonomy-demoted",
        subject: "scope",
        since: AT,
        clearedAt: null,
        detail: `Scope decisions are back in Shadow: ${idOf("Q1")}, answered for you by the recommended option, was asked again in the same request. They come to you again; Insights offers Delegate? once the class earns it anew.`,
      },
    ]);
    // The answer already delivered is not touched: only the reversal is recorded on it.
    expect(stored("Q1")).toEqual({ ...before, reversals: [{ kind: "re-asked", at: at(5), ref: idOf("Q2") }] });

    // Another reversal in the same class finds it in shadow already: nothing more is written or raised.
    answered("Q3", "policy", { subject: "branch-name", when: at(6) });
    const bytes = policyFile();
    await materialiseTurn(reaskTurn("Q4", "branch-name", at(7)), materialiser());
    expect(stored("Q3")?.reversals).toHaveLength(1);
    expect(policyFile()).toBe(bytes);
    expect(demotionAlerts()).toHaveLength(1);
  });

  it("a bead reopened with a reason citing what a precedent answered demotes the class too", async () => {
    delegateScope();
    answered("Q1", "precedent");
    await materialiseTurn(reopenTurn(`the owner reversed q:${REQUEST}:Q1: one file after all`), materialiser());
    expect(modeOf(readAutonomyPolicy(deps), WS, "scope")).toBe("shadow");
    const [alert] = demotionAlerts(true);
    expect(alert?.detail).toContain("answered for you by your precedent, was reversed: a bead closed under it was reopened citing it");
  });

  it("an override from the digest demotes the class through the same function (the Override itself is bead t9lm.15)", () => {
    delegateScope("orchestrator");
    const reversed = recordReversal(answered("Q1", "policy", { predictor: "orchestrator" }), { kind: "overridden", at: AT, ref: "r:0d1e" });
    if (!reversed.ok) throw new Error(reversed.message);
    const result = demoteOnReversal(reversed.decision, "overridden", { home, now: () => NOW });
    expect(result).toMatchObject({ demoted: true, workspaceId: WS, class: "scope", alert: { key: scopeKey, clearedAt: null } });
    expect(result.demoted && result.alert?.detail).toContain("answered for you by the Orchestrator, was overridden by you");
    expect(modeOf(readAutonomyPolicy(deps), WS, "scope")).toBe("shadow");
    // Once more: the cell is not delegated any more.
    expect(demoteOnReversal(reversed.decision, "overridden", { home, now: () => NOW })).toEqual({ demoted: false, reason: `scope is not delegated in ${WS}` });
    expect(demotionAlerts()).toHaveLength(1);
  });

  it("the reversal of an owner's answer never demotes, nor does one in a cell that is not delegated or of a decision not answered", async () => {
    delegateScope();
    answered("Q1", "owner");
    await materialiseTurn(reaskTurn("Q2"), materialiser());
    expect(stored("Q1")?.reversals).toHaveLength(1);
    expect(modeOf(readAutonomyPolicy(deps), WS, "scope")).toBe("delegate");
    expect(demoteOnReversal(stored("Q1")!, "overridden", { home })).toEqual({ demoted: false, reason: `decision ${idOf("Q1")} was answered by the owner, not for the owner` });

    handleAutonomySet({ workspaceId: WS, class: "scope", mode: "shadow" }, deps);
    const bytes = policyFile();
    expect(demoteOnReversal(answered("Q3", "policy", { subject: "branch-name" }), "re-asked", { home }).demoted).toBe(false);
    expect(demoteOnReversal(makeDecision({ workspaceId: WS }), "re-asked", { home })).toEqual({ demoted: false, reason: `decision ${idOf("Q1")} is not answered` });
    expect(policyFile()).toBe(bytes);
    expect(demotionAlerts()).toEqual([]);
  });

  it("the alert clears on the owner's next change of that cell, and on a reset of the project", () => {
    const demote = () => {
      delegateScope();
      return demoteOnReversal(stored("Q1")!, "overridden", { home, now: () => NOW });
    };
    answered("Q1", "policy");
    expect(demote().demoted).toBe(true);
    // Another class, or another project, leaves it open.
    handleAutonomySet({ workspaceId: WS, class: "preference", mode: "shadow" }, deps);
    handleAutonomySet({ workspaceId: "wks_other", class: "scope", mode: "shadow" }, deps);
    expect(demotionAlerts(true).map((alert) => alert.key)).toEqual([scopeKey]);
    // The owner sets the cell: cleared.
    handleAutonomySet({ workspaceId: WS, class: "scope", mode: "owner" }, deps);
    expect(demotionAlerts(true)).toEqual([]);
    // Demoted again, it opens afresh; Return all to owner clears it, and keeps the demotion's time.
    expect(demote().demoted).toBe(true);
    expect(demotionAlerts(true).map((alert) => alert.key)).toEqual([scopeKey]);
    const reset = handleAutonomyReset({ workspaceId: WS }, deps).policy;
    expect(demotionAlerts(true)).toEqual([]);
    expect(modeOf(reset, WS, "scope")).toBe("owner");
    expect(demotedAtOf(reset, WS, "scope")).toBe(AT);
  });

  it("the alert clears once the class is eligible again: 20 agreeing owner answers over 14 days since the demotion", () => {
    delegateScope();
    answered("Q1", "policy");
    demoteOnReversal(stored("Q1")!, "overridden", { home, now: () => NOW });
    // Twenty answers the owner gave before the demotion count for nothing.
    const before = Array.from({ length: 20 }, (_, index) => answered(`Q${index + 10}`, "owner", { when: new Date(NOW.getTime() - (index + 1) * DAY).toISOString() }));
    const at40 = { ...deps, now: () => later(40) };
    expect(clearRenewedDemotions(before, at40)).toEqual([]);
    // Nineteen since: not yet.
    const since = Array.from({ length: 20 }, (_, index) => answered(`Q${index + 40}`, "owner", { when: later(index + 1).toISOString() }));
    createDecisionStore(home).transition(idOf("Q59"), (decision) => ({ ok: true, decision: { ...decision, status: "open", answer: null, settledAt: null } }), WS);
    expect(clearRenewedDemotions(since.slice(0, 19), at40)).toEqual([]);
    expect(handleAutonomyLedger({ workspaceId: WS }, deps).cells.find((cell) => cell.class === "scope")).toMatchObject({ count: 19, agreed: 19 });
    // The twentieth: eligible again, the alert clears; the policy is left as the owner will set it.
    createDecisionStore(home).transition(idOf("Q59"), () => ({ ok: true, decision: since[19]! }), WS);
    expect(clearRenewedDemotions([since[19]!], at40)).toEqual([scopeKey]);
    expect(demotionAlerts(true)).toEqual([]);
    expect(modeOf(readAutonomyPolicy(deps), WS, "scope")).toBe("shadow");
    // Answers the policy gave, or none, check nothing.
    expect(clearRenewedDemotions([stored("Q1")!], at40)).toEqual([]);
    expect(clearRenewedDemotions([], at40)).toEqual([]);
  });

  it("autonomy.ledger counts a demoted class from its demotion; the delegated figures stay whole", () => {
    delegateScope();
    const byPolicy = answered("Q1", "policy");
    for (let index = 0; index < 5; index += 1) answered(`Q${index + 10}`, "owner", { when: new Date(NOW.getTime() - (index + 1) * DAY).toISOString() });
    expect(handleAutonomyLedger({ workspaceId: WS }, deps).cells.find((cell) => cell.class === "scope")?.count).toBe(5);
    demoteOnReversal(byPolicy, "overridden", { home, now: () => NOW });
    answered("Q20", "owner", { when: later(1).toISOString() });
    const ledger = handleAutonomyLedger({ workspaceId: WS }, deps);
    expect(ledger.cells.filter((cell) => cell.class === "scope").map((cell) => [cell.predictor, cell.count])).toEqual([["recommended", 1]]);
    expect(ledger.delegated.map((cell) => [cell.class, cell.by, cell.count])).toEqual([["scope", "policy", 1]]);
  });
});

describe("registration", () => {
  it("registers the five policy RPCs and the three precedent RPCs, and their codes are in the registry", () => {
    const handle = vi.fn();
    registerAutonomyRpcs({ handle } as unknown as Parameters<typeof registerAutonomyRpcs>[0], deps);
    expect(handle.mock.calls.map(([contract]) => (contract as { name: string }).name)).toEqual([
      "autonomy.policy",
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
    expect(handler(autonomyPolicyRpc)({})).toEqual({ policy: { projects: { w1: { scope: { mode: "shadow", at: AT } } }, challenger: {} } });
    expect(handler(autonomyResetRpc)({ workspaceId: "w1" })).toEqual({ policy: EMPTY_AUTONOMY_POLICY });
    expect(handler(autonomySetChallengerRpc)({ workspaceId: "w1", enabled: true })).toEqual({ policy: { projects: {}, challenger: { w1: true } } });
    for (const code of ["E_AUTONOMY_OWNER_ONLY", "E_AUTONOMY_NOT_CONFIRMED", "E_AUTONOMY_INVALID", "E_AUTONOMY_WRITE_FAILED"]) {
      expect(DASHBOARD_ERROR_CODES).toContain(code);
    }
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
