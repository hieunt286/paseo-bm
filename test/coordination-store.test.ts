import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { COORDINATION_DIR_NAME, COORDINATION_SETTINGS_FILE, createCoordinationStore } from "../plugin/server/coordination-store";
import {
  handleCoordinationSet,
  handleCoordinationSettings,
  readCoordinationSettings,
  registerCoordinationRpcs,
  type CoordinationRpcDeps,
} from "../plugin/server/coordination-rpc";
import { createAlertStore } from "../plugin/server/alert-store";
import { CLEANUP_DELETES } from "../plugin/server/setup-machine";
import { alertKeyOf } from "../plugin/shared/alerts";
import type { Usage } from "../plugin/shared/contracts";
import { turnTokensOf } from "../plugin/shared/eval-metrics/tokens";
import { AGENT_TOOLS, MANAGER_SERVER_TOOLS, ORCHESTRATOR_SERVER_TOOLS } from "../plugin/shared/bm-tools";
import { DASHBOARD_ERROR_CODES, DashboardError, coordinationSetRpc, coordinationSettingsRpc } from "../plugin/shared/contracts";
import {
  ADVICE_EVERY_FINISHED,
  COMPACTION_PROVIDERS,
  COMPACT_CONTEXT_SHARE,
  COMPACT_MANAGER_TOKENS_PER_TURN,
  COMPACT_MAX_PER_AGENT,
  COMPACT_WORKER_TOKENS_PER_TURN,
  COORDINATION_BOUNDS,
  COORDINATION_FILE_VERSION,
  COORDINATION_KEYS,
  DEFAULT_COORDINATION_SETTINGS,
  GOVERNOR_BOUNDS,
  GOVERNOR_SETTINGS,
  HANDOFF_MAX_PER_REQUEST,
  HANDOFF_REQUEST_TOKENS,
  MAINTENANCE_CEILING_FACTOR,
  RETIRED_COORDINATION_KEYS,
  REVIEW_CALLS_PER_BATCH,
  REVIEW_MAX_REREVIEWS,
  ROLLOVER_BEADS,
  ROLLOVER_CEILING_FACTOR,
  ROLLOVER_TOKENS,
  ROLLOVER_CONTEXT_TOKENS,
  ROLLOVER_TURNS,
  atMaintenanceCeiling,
  compactCrossingOf,
  compactionOnFor,
  coordinationChangeSchema,
  coordinationRuleOf,
  coordinationSettingsOf,
  handoffCrossingOf,
  liveCoordinationChangeSchema,
  type CoordinationSettings,
} from "../plugin/shared/coordination";
import { WORKER, at, turn } from "./fixtures/orchestrator-traces";

/**
 * Settings → Coordination (autonomy design §G.7, ADR-021): the store
 * `<data>/coordination/settings.json` with the alerts store's file rules, and
 * the owner's RPCs `coordination.settings` / `coordination.set`. A temporary
 * data folder named by `PASEO_BM_HOME` only; never the real HOME.
 */

let root: string;
let home: string;
let logs: string[];
let deps: CoordinationRpcDeps;

const store = () => createCoordinationStore(home);
const file = () => join(home, COORDINATION_DIR_NAME, COORDINATION_SETTINGS_FILE);
const fileBytes = () => (existsSync(file()) ? readFileSync(file(), "utf8") : null);
const modeOf = (path: string) => statSync(path).mode & 0o777;
const advice = (value: unknown) => ({ key: "advice.everyFinished", value });
/** Every setting at its default but the advice cadence. */
const withAdvice = (everyFinished: number): CoordinationSettings => ({ ...DEFAULT_COORDINATION_SETTINGS, advice: { everyFinished } });

function writeFile(body: unknown): string {
  mkdirSync(join(home, COORDINATION_DIR_NAME), { recursive: true });
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
  root = mkdtempSync(join(tmpdir(), "bm-coordination-"));
  home = join(root, "data");
  logs = [];
  deps = { env: { PASEO_BM_HOME: home }, homedir: () => root, log: (message) => logs.push(message) };
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("the settings (autonomy design §G.7)", () => {
  it("has the advice cadence of Phase 2: default 5, 0 = off, bounded", () => {
    expect(COORDINATION_FILE_VERSION).toBe(1);
    expect(DEFAULT_COORDINATION_SETTINGS.advice).toEqual({ everyFinished: 5 });
    expect(ADVICE_EVERY_FINISHED).toEqual({ min: 0, max: 50, default: 5 });
    for (const value of [0, 1, 5, 50]) expect(coordinationChangeSchema.safeParse(advice(value)).success).toBe(true);
    for (const value of [-1, 51, 2.5, "5", null, Number.NaN]) expect(coordinationChangeSchema.safeParse(advice(value)).success).toBe(false);
    // Change-008 C2 split the one threshold of the first design by role: the old key is no setting.
    expect(coordinationChangeSchema.safeParse({ key: "compact.tokensPerTurn", value: 390_000 }).success).toBe(false);
  });
});

describe("the store", () => {
  it("reads the defaults and creates nothing, then a 0700 folder and a 0600 file on the first write; cleanup deletes the folder", () => {
    expect(store().read()).toEqual(DEFAULT_COORDINATION_SETTINGS);
    expect(existsSync(home)).toBe(false);
    expect(store().set(advice(3))).toEqual(withAdvice(3));
    expect(modeOf(join(home, COORDINATION_DIR_NAME))).toBe(0o700);
    expect(modeOf(file())).toBe(0o600);
    expect(readdirSync(join(home, COORDINATION_DIR_NAME))).toEqual([COORDINATION_SETTINGS_FILE]);
    expect(JSON.parse(readFileSync(file(), "utf8"))).toEqual({ version: 1, ...withAdvice(3) });
    expect(store().read()).toEqual(withAdvice(3));
    expect(CLEANUP_DELETES).toContain(COORDINATION_DIR_NAME);
  });

  it("keeps 0: advice off is a value, not a missing one", () => {
    store().set(advice(0));
    expect(store().read().advice.everyFinished).toBe(0);
  });

  it("reads a value out of its bounds as the default, on its own, and ignores unknown keys", () => {
    writeFile({ version: 1, advice: { everyFinished: 500, cadence: "daily" }, compact: { enabled: true }, extra: 1 });
    expect(store().read()).toEqual(DEFAULT_COORDINATION_SETTINGS);
    for (const value of [-1, 2.5, "7", null]) {
      writeFile({ version: 1, advice: { everyFinished: value } });
      expect(store().read()).toEqual(DEFAULT_COORDINATION_SETTINGS);
    }
    writeFile({ version: 1, advice: { everyFinished: 8 }, unknown: { deep: true } });
    expect(store().read()).toEqual(withAdvice(8));
    // The next write keeps the settings it knows and drops the rest.
    store().set(advice(9));
    expect(JSON.parse(readFileSync(file(), "utf8"))).toEqual({ version: 1, ...withAdvice(9) });
  });

  it("reads a corrupt file, one without a version and one of an older version as the defaults", () => {
    for (const body of ["{not json", "[]", JSON.stringify({ advice: { everyFinished: 8 } }), JSON.stringify({ version: 0, advice: { everyFinished: 8 } })]) {
      writeFile(body);
      expect(store().read()).toEqual(DEFAULT_COORDINATION_SETTINGS);
    }
  });

  it("reads a file from a newer paseo-bm as the defaults and never writes it", () => {
    const newer = writeFile({ version: 2, advice: { everyFinished: 8 } });
    expect(store().read()).toEqual(DEFAULT_COORDINATION_SETTINGS);
    expect(codeOf(() => store().set(advice(3)))).toBe("E_COORDINATION_WRITE_FAILED");
    expect(() => store().set(advice(3))).toThrow(/newer paseo-bm/);
    expect(fileBytes()).toBe(newer);
  });

  it("refuses an unknown key or a value out of its bounds, writing nothing", () => {
    store().set(advice(4));
    const before = fileBytes();
    for (const change of [advice(-1), advice(51), advice(2.5), advice("6"), { key: "compact.enabled", value: "yes" }, { key: "compact.tokensPerTurn", value: 5 }, { value: 3 }, null]) {
      expect(codeOf(() => store().set(change))).toBe("E_COORDINATION_INVALID");
    }
    expect(fileBytes()).toBe(before);
  });

  it("refuses a symlinked coordination folder and writes nothing through it", () => {
    const elsewhere = join(root, "elsewhere");
    mkdirSync(elsewhere);
    mkdirSync(home);
    symlinkSync(elsewhere, join(home, COORDINATION_DIR_NAME));
    expect(() => store().read()).toThrow();
    expect(() => store().set(advice(3))).toThrow();
    expect(readdirSync(elsewhere)).toEqual([]);
  });
});

describe("readCoordinationSettings, for the plugin's own readers", () => {
  it("reads the stored settings", () => {
    store().set(advice(7));
    expect(readCoordinationSettings(deps)).toEqual(withAdvice(7));
  });

  it("reads the defaults, never throwing, with no usable data folder or an unreadable store (one log line)", () => {
    expect(readCoordinationSettings({ env: { PASEO_BM_HOME: "relative/path" }, homedir: () => root })).toEqual(DEFAULT_COORDINATION_SETTINGS);
    mkdirSync(home);
    symlinkSync(join(root), join(home, COORDINATION_DIR_NAME));
    expect(readCoordinationSettings(deps)).toEqual(DEFAULT_COORDINATION_SETTINGS);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatch(/could not read the coordination settings/);
  });
});

describe("coordination.settings and coordination.set (the owner's RPCs)", () => {
  it("coordination.settings reads the settings and the defaults, and writes nothing", () => {
    const output = handleCoordinationSettings(deps);
    expect(coordinationSettingsRpc.output.parse(output)).toEqual({ settings: DEFAULT_COORDINATION_SETTINGS, defaults: DEFAULT_COORDINATION_SETTINGS });
    expect(existsSync(home)).toBe(false);
    store().set(advice(0));
    expect(handleCoordinationSettings(deps).settings).toEqual(withAdvice(0));
  });

  it("coordination.set saves one setting and returns every setting", () => {
    const output = handleCoordinationSet(advice(12), deps);
    expect(coordinationSetRpc.output.parse(output)).toEqual({ settings: withAdvice(12) });
    expect(store().read()).toEqual(withAdvice(12));
    expect(handleCoordinationSet(advice(0), deps).settings.advice.everyFinished).toBe(0);
  });

  it("refuses an out-of-range value or an unknown setting with E_COORDINATION_INVALID, writing nothing", () => {
    handleCoordinationSet(advice(6), deps);
    const before = fileBytes();
    for (const input of [advice(-1), advice(51), advice(1e9), advice(4.5), advice("5"), { key: "handoff.enabled", value: 0 }, { key: "guard.compact", value: null }, {}]) {
      expect(coordinationSetRpc.input.safeParse(input).success).toBe(false);
      expect(codeOf(() => handleCoordinationSet(input, deps))).toBe("E_COORDINATION_INVALID");
    }
    expect(fileBytes()).toBe(before);
    expect(() => handleCoordinationSet(advice(51), deps)).toThrow(/from 0 \(off\) to 50; nothing was saved/);
  });

  it("checks the change before the data folder, and refuses without one (E_DATA_HOME_UNAVAILABLE)", () => {
    const unusable = { env: { PASEO_BM_HOME: "relative/path" }, homedir: () => root };
    expect(codeOf(() => handleCoordinationSet(advice(99), unusable))).toBe("E_COORDINATION_INVALID");
    expect(codeOf(() => handleCoordinationSet(advice(3), unusable))).toBe("E_DATA_HOME_UNAVAILABLE");
    expect(existsSync(home)).toBe(false);
  });

  it("refuses a store from a newer paseo-bm with E_COORDINATION_WRITE_FAILED, leaving it as it is", () => {
    const newer = writeFile({ version: 2, advice: { everyFinished: 8 } });
    expect(codeOf(() => handleCoordinationSet(advice(3), deps))).toBe("E_COORDINATION_WRITE_FAILED");
    expect(fileBytes()).toBe(newer);
  });

  it("answers an unwritable store with its own code, not the trace store's (code review 2026-09-30 §3.2)", () => {
    const elsewhere = join(root, "elsewhere");
    mkdirSync(elsewhere);
    mkdirSync(home);
    symlinkSync(elsewhere, join(home, COORDINATION_DIR_NAME));
    expect(codeOf(() => handleCoordinationSet(advice(3), deps))).toBe("E_COORDINATION_WRITE_FAILED");
    expect(readdirSync(elsewhere)).toEqual([]);
  });

  it("answers a data folder that cannot be created with E_DATA_HOME_UNAVAILABLE", () => {
    writeFileSync(join(root, "plain-file"), "");
    const uncreatable = { ...deps, env: { PASEO_BM_HOME: join(root, "plain-file", "data") } };
    expect(codeOf(() => handleCoordinationSet(advice(3), uncreatable))).toBe("E_DATA_HOME_UNAVAILABLE");
  });

  it("registers both RPCs, and their codes are in the registry", () => {
    const handle = vi.fn();
    registerCoordinationRpcs({ handle } as unknown as Parameters<typeof registerCoordinationRpcs>[0], deps);
    expect(handle.mock.calls.map(([contract]) => (contract as { name: string }).name)).toEqual(["coordination.settings", "coordination.set"]);
    const set = handle.mock.calls.find(([contract]) => contract === coordinationSetRpc)![1] as (input: unknown) => unknown;
    expect(set(advice(2))).toEqual({ settings: withAdvice(2) });
    const read = handle.mock.calls.find(([contract]) => contract === coordinationSettingsRpc)![1] as (input: unknown) => unknown;
    expect(read({})).toEqual({ settings: withAdvice(2), defaults: DEFAULT_COORDINATION_SETTINGS });
    expect(DASHBOARD_ERROR_CODES).toContain("E_COORDINATION_INVALID");
    expect(DASHBOARD_ERROR_CODES).toContain("E_COORDINATION_WRITE_FAILED");
  });

  it("are the owner's only: no agent tool sets these settings (PRD REQ-136 c)", () => {
    const names = [...ORCHESTRATOR_SERVER_TOOLS, ...MANAGER_SERVER_TOOLS, ...AGENT_TOOLS].map((tool) => tool.name);
    expect(names.length).toBeGreaterThan(0);
    expect(names.filter((name) => /coordination|cadence|settings/i.test(name))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Phase 3: compaction and handoff (autonomy design §G.7; change-008 C2; bead 7gxw.9).
// ---------------------------------------------------------------------------

const NOW = new Date("2026-09-30T12:00:00.000Z");
const LATER = new Date("2026-10-01T09:30:00.000Z");
const numberKeys = Object.keys(COORDINATION_BOUNDS) as Array<keyof typeof COORDINATION_BOUNDS>;

describe("the compaction and handoff settings: keys, defaults and bounds (§G.7 as derived at the Phase 3 start)", () => {
  it("adds eight keys after the advice cadence, in the order Settings shows them", () => {
    expect(COORDINATION_KEYS).toEqual([
      "advice.everyFinished",
      "compact.enabled",
      "compact.managerTokensPerTurn",
      "compact.workerTokensPerTurn",
      "compact.contextShare",
      "compact.maxPerAgent",
      "handoff.enabled",
      "handoff.requestTokens",
      "handoff.maxPerRequest",
      // Mission runtime design §3.2: a Main's context, compacted in place.
      "main.compact",
      "main.contextShare",
      "main.contextTokens",
      "main.hardShare",
      // Delivery line design §5.2: the re-reviews of one batch.
      "review.maxRereviews",
      // Delivery line design §5.3: the calls one milestone batch is paid for in the request's cap.
      "review.callsPerBatch",
      // Delivery line design §2.6: size rollover.
      "rollover.enabled",
      "rollover.beads",
      "rollover.turns",
      "rollover.tokens",
      // ADR-036, delivery line design §17.3: the Worker turn's own context.
      "rollover.contextTokens",
      "rollover.ceilingFactor",
      // Delivery line design §6.6: the maintenance ceiling.
      "maintenance.ceilingFactor",
      // ADR-036, delivery line design §17.1: CI, off by default.
      "integration.ci",
      // Missions Phase 2: the governor's thresholds and window (missions design §9.2, §9.3).
      ...GOVERNOR_SETTINGS.map((name) => `governor.${name}`),
    ]);
  });

  it("defaults to the Phase 2 measurement: each role's p75 per turn, the request p80, both mechanisms on", () => {
    expect(DEFAULT_COORDINATION_SETTINGS).toEqual({
      advice: { everyFinished: 5 },
      compact: { enabled: true, managerTokensPerTurn: 390_000, workerTokensPerTurn: 5_700_000, contextShare: 0.5, maxPerAgent: 2 },
      handoff: { enabled: true, requestTokens: 150_000_000, maxPerRequest: 2 },
      main: { compact: true, contextShare: 0.6, contextTokens: 150_000, hardShare: 0.85 },
      review: { maxRereviews: 3, callsPerBatch: 3 },
      rollover: { enabled: true, beads: 15, turns: 40, tokens: 50_000_000, contextTokens: 250_000, ceilingFactor: 2 },
      maintenance: { ceilingFactor: 2 },
      integration: { ci: "off" },
      governor: DEFAULT_COORDINATION_SETTINGS.governor,
      guard: { compact: { countsFrom: null, switchedOff: null }, handoff: { countsFrom: null, switchedOff: null } },
    });
    // "On for the providers the compaction spike passed" (§G.5 Verified): all three; any other provider never compacts.
    expect(COMPACTION_PROVIDERS).toEqual(["claude", "codex", "opencode"]);
    for (const provider of COMPACTION_PROVIDERS) expect(compactionOnFor(DEFAULT_COORDINATION_SETTINGS, provider)).toBe(true);
    for (const provider of ["pi", "copilot", "unknown", null]) expect(compactionOnFor(DEFAULT_COORDINATION_SETTINGS, provider)).toBe(false);
    const off = { compact: { ...DEFAULT_COORDINATION_SETTINGS.compact, enabled: false } };
    expect(compactionOnFor(off, "claude")).toBe(false);
  });

  it("bounds every number: its minimum, default and maximum accepted, one step outside refused, a fraction only where a share is", () => {
    expect(COMPACT_MANAGER_TOKENS_PER_TURN).toEqual({ min: 50_000, max: 100_000_000, default: 390_000, whole: true });
    expect(COMPACT_WORKER_TOKENS_PER_TURN).toEqual({ min: 50_000, max: 100_000_000, default: 5_700_000, whole: true });
    expect(COMPACT_CONTEXT_SHARE).toEqual({ min: 0.1, max: 0.9, default: 0.5, whole: false });
    expect(COMPACT_MAX_PER_AGENT).toEqual({ min: 1, max: 5, default: 2, whole: true });
    expect(HANDOFF_REQUEST_TOKENS).toEqual({ min: 10_000_000, max: 1_000_000_000, default: 150_000_000, whole: true });
    expect(HANDOFF_MAX_PER_REQUEST).toEqual({ min: 1, max: 5, default: 2, whole: true });
    for (const key of numberKeys) {
      const { min, max, default: fallback, whole } = COORDINATION_BOUNDS[key];
      const ok = (value: unknown) => liveCoordinationChangeSchema.safeParse({ key, value }).success;
      for (const value of [min, fallback, max]) expect(ok(value), `${key} ${value}`).toBe(true);
      const step = whole ? 1 : 0.01;
      for (const value of [min - step, max + step, String(fallback), null, true, Number.NaN, Number.POSITIVE_INFINITY]) expect(ok(value), `${key} ${String(value)}`).toBe(false);
      expect(ok(min + 0.5), `${key} fraction`).toBe(!whole);
    }
    expect(liveCoordinationChangeSchema.safeParse({ key: "compact.contextShare", value: 0.55 }).success).toBe(true);
  });

  it("switches each mechanism with true or false only", () => {
    for (const key of ["compact.enabled", "handoff.enabled"]) {
      for (const value of [true, false]) expect(liveCoordinationChangeSchema.safeParse({ key, value }).success).toBe(true);
      for (const value of [1, 0, "true", null]) expect(liveCoordinationChangeSchema.safeParse({ key, value }).success).toBe(false);
    }
  });

  it("says each key's rule in one sentence, which every refusal repeats", () => {
    expect(coordinationRuleOf("advice.everyFinished")).toBe("advice.everyFinished must be a whole number from 0 (off) to 50");
    expect(coordinationRuleOf("compact.enabled")).toBe("compact.enabled must be true (on) or false (off)");
    expect(coordinationRuleOf("compact.managerTokensPerTurn")).toBe("compact.managerTokensPerTurn must be a whole number from 50000 to 100000000");
    expect(coordinationRuleOf("compact.contextShare")).toBe("compact.contextShare must be a number from 0.1 to 0.9");
    expect(coordinationRuleOf("handoff.maxPerRequest")).toBe("handoff.maxPerRequest must be a whole number from 1 to 5");
    expect(coordinationRuleOf("compact.tokensPerTurn")).toBeNull();
    expect(coordinationRuleOf(undefined)).toBeNull();
  });
});

// Delivery line design §2.6: the size rollover settings.
describe("the rollover settings: keys, defaults and bounds (delivery line design §2.6)", () => {
  it("defaults to on, 15 beads, 40 turns, 50M tokens and a factor of 2, each in its bounds", () => {
    expect([ROLLOVER_BEADS, ROLLOVER_TURNS, ROLLOVER_TOKENS, ROLLOVER_CONTEXT_TOKENS, ROLLOVER_CEILING_FACTOR]).toEqual([
      { min: 3, max: 100, default: 15, whole: true },
      { min: 10, max: 500, default: 40, whole: true },
      { min: 10_000_000, max: 1_000_000_000, default: 50_000_000, whole: true },
      { min: 100_000, max: 900_000, default: 250_000, whole: true },
      { min: 1.5, max: 5, default: 2, whole: false },
    ]);
    expect(coordinationRuleOf("rollover.enabled")).toBe("rollover.enabled must be true (on) or false (off)");
    expect(coordinationRuleOf("rollover.ceilingFactor")).toBe("rollover.ceilingFactor must be a number from 1.5 to 5");
    for (const value of [true, false]) expect(liveCoordinationChangeSchema.safeParse({ key: "rollover.enabled", value }).success).toBe(true);
    expect(liveCoordinationChangeSchema.safeParse({ key: "rollover.enabled", value: 1 }).success).toBe(false);
  });

  it("reads a file an older build wrote at the defaults, and each rollover key on its own", () => {
    writeFile({ version: 1, review: { maxRereviews: 2 } });
    expect(store().read().rollover).toEqual(DEFAULT_COORDINATION_SETTINGS.rollover);
    writeFile({ version: 1, rollover: { enabled: false, beads: 2, turns: 30, ceilingFactor: 3.5 } });
    expect(store().read().rollover).toEqual({ enabled: false, beads: 15, turns: 30, tokens: 50_000_000, contextTokens: 250_000, ceilingFactor: 3.5 });
    expect(codeOf(() => handleCoordinationSet({ key: "rollover.tokens", value: 9_999_999 }, deps))).toBe("E_COORDINATION_INVALID");
    // ADR-036 §17.3: rollover.contextTokens in 100k to 900k; out of its bounds, read at its default.
    for (const value of [99_999, 900_001]) expect(codeOf(() => handleCoordinationSet({ key: "rollover.contextTokens", value }, deps))).toBe("E_COORDINATION_INVALID");
    writeFile({ version: 1, rollover: { contextTokens: 50_000 } });
    expect(store().read().rollover.contextTokens).toBe(250_000);
    writeFile({ version: 1, rollover: { contextTokens: 400_000 } });
    expect(store().read().rollover.contextTokens).toBe(400_000);
  });
});

// Delivery line design §6.6: the maintenance ceiling.
describe("the maintenance ceiling setting (delivery line design §6.6)", () => {
  it("defaults to a factor of 2 in 1.5 to 5; an older file reads it at its default, and it is judged against a crossing", () => {
    expect(MAINTENANCE_CEILING_FACTOR).toEqual({ min: 1.5, max: 5, default: 2, whole: false });
    expect(coordinationRuleOf("maintenance.ceilingFactor")).toBe("maintenance.ceilingFactor must be a number from 1.5 to 5");
    writeFile({ version: 1, rollover: { beads: 20 } });
    expect(store().read().maintenance).toEqual({ ceilingFactor: 2 });
    writeFile({ version: 1, maintenance: { ceilingFactor: 9 } });
    expect(store().read().maintenance).toEqual({ ceilingFactor: 2 });
    writeFile({ version: 1, maintenance: { ceilingFactor: 2.5 } });
    expect(store().read().maintenance).toEqual({ ceilingFactor: 2.5 });
    expect(codeOf(() => handleCoordinationSet({ key: "maintenance.ceilingFactor", value: 1.4 }, deps))).toBe("E_COORDINATION_INVALID");
    const settings = DEFAULT_COORDINATION_SETTINGS;
    expect(atMaintenanceCeiling({ figure: "requestTokens", value: 299_999_999, threshold: 150_000_000 }, settings)).toBe(false);
    expect(atMaintenanceCeiling({ figure: "requestTokens", value: 300_000_000, threshold: 150_000_000 }, settings)).toBe(true);
    expect(atMaintenanceCeiling(null, settings)).toBe(false);
  });
});

// Delivery line design §5.6: review.maxRereviews and review.callsPerBatch are the review settings; the review budget per tier is retired.
describe("the review settings: keys, defaults and bounds; the retired review budget ignored, dropped and refused", () => {
  const NEW = ["review.maxRereviews", "review.callsPerBatch"] as const;

  it("defaults to 3 re-reviews and 3 calls per milestone batch, each a whole number in its bounds", () => {
    // Delivery line design §5.2: the re-reviews of one batch, 1 to 6, 3 by default.
    expect(REVIEW_MAX_REREVIEWS).toEqual({ min: 1, max: 6, default: 3, whole: true });
    expect(coordinationRuleOf("review.maxRereviews")).toBe("review.maxRereviews must be a whole number from 1 to 6");
    // Delivery line design §5.3: the calls of one milestone batch in the cap, 2 to 6, 3 by default.
    expect(REVIEW_CALLS_PER_BATCH).toEqual({ min: 2, max: 6, default: 3, whole: true });
    expect(coordinationRuleOf("review.callsPerBatch")).toBe("review.callsPerBatch must be a whole number from 2 to 6");
    expect(DEFAULT_COORDINATION_SETTINGS.review).toEqual({ maxRereviews: 3, callsPerBatch: 3 });
    // The retired keys are no setting: no rule, not among the keys.
    expect(RETIRED_COORDINATION_KEYS).toEqual(["review.smallBudget", "review.mediumBudget", "review.largeBudget"]);
    for (const key of RETIRED_COORDINATION_KEYS) {
      expect(coordinationRuleOf(key)).toBeNull();
      expect(COORDINATION_KEYS as readonly string[]).not.toContain(key);
    }
  });

  it("bounds the new keys: refuses one step outside with E_COORDINATION_INVALID and writes nothing; saves the bounds; the file stays version 1", () => {
    for (const key of NEW) {
      const { min, max } = COORDINATION_BOUNDS[key];
      for (const value of [min - 1, max + 1, 2.5]) {
        expect(codeOf(() => handleCoordinationSet({ key, value }, deps)), `${key} ${value}`).toBe("E_COORDINATION_INVALID");
        expect(existsSync(file()), `${key} ${value}`).toBe(false);
      }
    }
    handleCoordinationSet({ key: "review.maxRereviews", value: 6 }, deps);
    handleCoordinationSet({ key: "review.callsPerBatch", value: 2 }, deps);
    const before = fileBytes();
    expect(() => handleCoordinationSet({ key: "review.maxRereviews", value: 0 }, deps)).toThrow("review.maxRereviews must be a whole number from 1 to 6; nothing was saved");
    expect(fileBytes()).toBe(before);
    const body = JSON.parse(fileBytes()!) as { version: number; review: unknown };
    expect(body.version).toBe(COORDINATION_FILE_VERSION);
    expect(COORDINATION_FILE_VERSION).toBe(1);
    expect(body.review).toEqual({ maxRereviews: 6, callsPerBatch: 2 });
    expect(readCoordinationSettings(deps).review).toEqual({ maxRereviews: 6, callsPerBatch: 2 });
  });

  it("refuses an old review.*Budget key with E_COORDINATION_INVALID, whatever its value, and writes nothing", () => {
    for (const key of RETIRED_COORDINATION_KEYS) {
      for (const value of [2, 4, 8]) {
        expect(codeOf(() => handleCoordinationSet({ key, value }, deps)), `${key} ${value}`).toBe("E_COORDINATION_INVALID");
        expect(codeOf(() => store().set({ key, value })), `${key} ${value}`).toBe("E_COORDINATION_INVALID");
      }
      expect(() => handleCoordinationSet({ key, value: 4 }, deps)).toThrow(
        `${key} no longer exists: review.maxRereviews and review.callsPerBatch set the review cap; nothing was saved`,
      );
    }
    expect(existsSync(file())).toBe(false);
    // A decision stored with one still parses (shared/decisions.ts reads the wide schema); only a live change is ever applied.
    expect(coordinationChangeSchema.safeParse({ key: "review.largeBudget", value: 6 }).success).toBe(true);
    expect(liveCoordinationChangeSchema.safeParse({ key: "review.largeBudget", value: 6 }).success).toBe(false);
  });

  it("ignores an older file's review budget on read and drops it on the next write; each new key is read on its own", () => {
    writeFile({ version: 1, advice: { everyFinished: 7 }, compact: { enabled: false }, handoff: { maxPerRequest: 3 } });
    expect(store().read().review).toEqual({ maxRereviews: 3, callsPerBatch: 3 });
    writeFile({ version: 1, review: { smallBudget: 3, mediumBudget: 5, largeBudget: 6, maxRereviews: 9, callsPerBatch: 4 } });
    expect(store().read().review).toEqual({ maxRereviews: 3, callsPerBatch: 4 });
    expect(coordinationSettingsOf({ review: { smallBudget: 3, largeBudget: 8 } }).review).toEqual({ maxRereviews: 3, callsPerBatch: 3 });
    // The next write keeps what was read, in bounds, and the version; the old keys are gone.
    store().set({ key: "review.maxRereviews", value: 2 });
    const body = JSON.parse(fileBytes()!) as { version: number; review: Record<string, unknown> };
    expect(body).toMatchObject({ version: 1 });
    expect(body.review).toEqual({ maxRereviews: 2, callsPerBatch: 4 });
  });
});

describe("the compaction and handoff settings in the store and the owner's RPCs", () => {
  const values: Record<string, { value: number | boolean | string; read: (settings: CoordinationSettings) => unknown }> = {
    "compact.enabled": { value: false, read: (settings) => settings.compact.enabled },
    "compact.managerTokensPerTurn": { value: 500_000, read: (settings) => settings.compact.managerTokensPerTurn },
    "compact.workerTokensPerTurn": { value: 8_000_000, read: (settings) => settings.compact.workerTokensPerTurn },
    "compact.contextShare": { value: 0.65, read: (settings) => settings.compact.contextShare },
    "compact.maxPerAgent": { value: 3, read: (settings) => settings.compact.maxPerAgent },
    "handoff.enabled": { value: false, read: (settings) => settings.handoff.enabled },
    "handoff.requestTokens": { value: 200_000_000, read: (settings) => settings.handoff.requestTokens },
    "handoff.maxPerRequest": { value: 1, read: (settings) => settings.handoff.maxPerRequest },
    "main.compact": { value: false, read: (settings) => settings.main.compact },
    "main.contextShare": { value: 0.7, read: (settings) => settings.main.contextShare },
    "main.contextTokens": { value: 200_000, read: (settings) => settings.main.contextTokens },
    "main.hardShare": { value: 0.9, read: (settings) => settings.main.hardShare },
    "review.maxRereviews": { value: 5, read: (settings) => settings.review.maxRereviews },
    "review.callsPerBatch": { value: 4, read: (settings) => settings.review.callsPerBatch },
    "rollover.enabled": { value: false, read: (settings) => settings.rollover.enabled },
    "rollover.beads": { value: 20, read: (settings) => settings.rollover.beads },
    "rollover.turns": { value: 60, read: (settings) => settings.rollover.turns },
    "rollover.tokens": { value: 80_000_000, read: (settings) => settings.rollover.tokens },
    "rollover.contextTokens": { value: 300_000, read: (settings) => settings.rollover.contextTokens },
    "rollover.ceilingFactor": { value: 2.5, read: (settings) => settings.rollover.ceilingFactor },
    "maintenance.ceilingFactor": { value: 3, read: (settings) => settings.maintenance.ceilingFactor },
    "integration.ci": { value: "on", read: (settings) => settings.integration.ci },
    ...Object.fromEntries(
      GOVERNOR_SETTINGS.map((name) => [`governor.${name}`, { value: GOVERNOR_BOUNDS[name].default + 1, read: (settings: CoordinationSettings) => settings.governor[name] }]),
    ),
  };

  it("coordination.set saves each field on its own and coordination.settings reads it back; nothing else changes", () => {
    expect(Object.keys(values)).toEqual(COORDINATION_KEYS.slice(1));
    for (const [key, { value, read }] of Object.entries(values)) {
      rmSync(home, { recursive: true, force: true });
      const output = handleCoordinationSet({ key, value }, deps);
      expect(read(coordinationSetRpc.output.parse(output).settings), key).toBe(value);
      expect(read(handleCoordinationSettings(deps).settings), key).toBe(value);
      // Only the one setting: every other reads as its default (the owner's switch also records itself in `guard`).
      const others = Object.entries(values).filter(([other]) => other !== key);
      for (const [other, { read: readOther }] of others) expect(readOther(output.settings), `${key} → ${other}`).toBe(readOther(DEFAULT_COORDINATION_SETTINGS));
      expect(output.settings.advice).toEqual(DEFAULT_COORDINATION_SETTINGS.advice);
    }
  });

  it("integration.ci (ADR-036): off by default and in a file without it; off or on only, refused otherwise with its rule", () => {
    expect(handleCoordinationSettings(deps).settings.integration).toEqual({ ci: "off" });
    expect(coordinationSettingsOf({ version: 1, integration: { ci: "maybe" } }).integration).toEqual({ ci: "off" });
    expect(coordinationSettingsOf({ version: 1, integration: { ci: "on" } }).integration).toEqual({ ci: "on" });
    expect(handleCoordinationSet({ key: "integration.ci", value: "on" }, deps).settings.integration).toEqual({ ci: "on" });
    expect(handleCoordinationSet({ key: "integration.ci", value: "off" }, deps).settings.integration).toEqual({ ci: "off" });
    const before = fileBytes();
    for (const value of [true, 1, "yes", null]) {
      expect(coordinationSetRpc.input.safeParse({ key: "integration.ci", value }).success, String(value)).toBe(false);
      expect(() => handleCoordinationSet({ key: "integration.ci", value }, deps)).toThrow('integration.ci must be "off" or "on"; nothing was saved');
    }
    expect(fileBytes()).toBe(before);
  });

  it("refuses each field out of its bounds with its rule and E_COORDINATION_INVALID, writing nothing", () => {
    handleCoordinationSet(advice(6), deps);
    const before = fileBytes();
    for (const key of numberKeys) {
      const { min, max } = COORDINATION_BOUNDS[key];
      for (const value of [min - 1, max + 1, "1"]) {
        expect(coordinationSetRpc.input.safeParse({ key, value }).success, `${key} ${String(value)}`).toBe(false);
        expect(codeOf(() => handleCoordinationSet({ key, value }, deps))).toBe("E_COORDINATION_INVALID");
      }
      expect(() => handleCoordinationSet({ key, value: max * 2 }, deps)).toThrow(`${coordinationRuleOf(key)}; nothing was saved`);
    }
    expect(codeOf(() => handleCoordinationSet({ key: "compact.enabled", value: "on" }, deps))).toBe("E_COORDINATION_INVALID");
    expect(fileBytes()).toBe(before);
  });

  it("reads each stored field on its own: one out of its bounds reads as its default and costs no other", () => {
    writeFile({
      version: 1,
      advice: { everyFinished: 7 },
      compact: { enabled: false, managerTokensPerTurn: 10, workerTokensPerTurn: 6_000_000, contextShare: 0.95, maxPerAgent: 3 },
      handoff: { enabled: "no", requestTokens: 120_000_000, maxPerRequest: 0 },
    });
    expect(store().read()).toEqual({
      ...DEFAULT_COORDINATION_SETTINGS,
      advice: { everyFinished: 7 },
      compact: { enabled: false, managerTokensPerTurn: 390_000, workerTokensPerTurn: 6_000_000, contextShare: 0.5, maxPerAgent: 3 },
      handoff: { enabled: true, requestTokens: 120_000_000, maxPerRequest: 2 },
    });
    // A Phase 2 file (the advice cadence only) reads Phase 3's settings as their defaults.
    expect(coordinationSettingsOf({ version: 1, advice: { everyFinished: 9 } })).toEqual(withAdvice(9));
  });

  it("keeps the guard's figures only while the mechanism is off, and a countsFrom only when it is a time", () => {
    const switchedOff = { at: NOW.toISOString(), met: 6, checked: 10 };
    const body = (enabled: boolean, countsFrom: unknown) => ({ version: 1, compact: { enabled }, guard: { compact: { countsFrom, switchedOff } } });
    expect(coordinationSettingsOf(body(false, NOW.toISOString())).guard.compact).toEqual({ countsFrom: NOW.toISOString(), switchedOff });
    expect(coordinationSettingsOf(body(true, "yesterday")).guard.compact).toEqual({ countsFrom: null, switchedOff: null });
  });

  it("the owner turning a mechanism on from off makes A-12 count afresh from then and ends the guard's switch-off; off keeps the count", () => {
    const at = (date: Date) => createCoordinationStore(home, { now: () => date });
    writeFile({ version: 1, compact: { enabled: false }, guard: { compact: { countsFrom: null, switchedOff: { at: NOW.toISOString(), met: 6, checked: 10 } } } });
    expect(at(LATER).set({ key: "compact.enabled", value: true }).guard.compact).toEqual({ countsFrom: LATER.toISOString(), switchedOff: null });
    // Setting it on again changes nothing; off keeps where the count starts.
    expect(at(NOW).set({ key: "compact.enabled", value: true }).guard.compact.countsFrom).toBe(LATER.toISOString());
    expect(at(NOW).set({ key: "compact.enabled", value: false }).guard.compact).toEqual({ countsFrom: LATER.toISOString(), switchedOff: null });
    // The handoff guard is its own.
    expect(store().read().guard.handoff).toEqual({ countsFrom: null, switchedOff: null });
  });

  it("the guard's switchOff only ever switches off, records when and why, changes no figure, and writes nothing when already off", () => {
    const guarded = createCoordinationStore(home, { now: () => LATER });
    store().set({ key: "compact.workerTokensPerTurn", value: 8_000_000 });
    const off = guarded.switchOff("compact", { met: 6, checked: 10 });
    expect(off.compact).toEqual({ ...DEFAULT_COORDINATION_SETTINGS.compact, enabled: false, workerTokensPerTurn: 8_000_000 });
    expect(off.guard.compact).toEqual({ countsFrom: null, switchedOff: { at: LATER.toISOString(), met: 6, checked: 10 } });
    expect(off.handoff).toEqual(DEFAULT_COORDINATION_SETTINGS.handoff);
    const bytes = fileBytes();
    expect(guarded.switchOff("compact", { met: 2, checked: 10 })).toEqual(off);
    expect(fileBytes()).toBe(bytes);
    // A file from a newer paseo-bm is never written.
    const newer = writeFile({ version: 2, compact: { enabled: true } });
    expect(codeOf(() => guarded.switchOff("handoff", { met: 1, checked: 10 }))).toBe("E_COORDINATION_WRITE_FAILED");
    expect(fileBytes()).toBe(newer);
  });

  it("the owner turning a mechanism on through coordination.set ends its coordination-off alert, and only that one", () => {
    const alerts = createAlertStore(home);
    for (const subject of ["compact", "handoff"]) alerts.raise({ workspaceId: null, kind: "coordination-off", subject, detail: "Only 6 of its last 10 met their goal." });
    handleCoordinationSet({ key: "compact.maxPerAgent", value: 3 }, deps);
    handleCoordinationSet({ key: "compact.enabled", value: false }, deps);
    expect(alerts.list({ open: true }).map((alert) => alert.subject)).toEqual(["compact", "handoff"]);
    handleCoordinationSet({ key: "compact.enabled", value: true }, { ...deps, now: () => LATER });
    expect(alerts.list({ open: true }).map((alert) => alert.key)).toEqual([alertKeyOf("coordination-off", null, "handoff")]);
    expect(alerts.get(alertKeyOf("coordination-off", null, "compact"))?.clearedAt).toBe(LATER.toISOString());
  });
});

describe("the crossing rule (change-008 C2): tokens per turn only where the counts cover the turn, else the context share", () => {
  const S = DEFAULT_COORDINATION_SETTINGS;
  const usage = (model: string, input: number, cached: number, context?: { used: number; max: number }): Usage => ({
    inputTokens: input,
    cachedInputTokens: cached,
    outputTokens: 100,
    costUsd: null,
    costBasis: "unavailable",
    model,
    pricesUpdatedAt: null,
    ...(context === undefined ? {} : { contextUsed: context.used, contextMax: context.max }),
  });
  const workerTurn = (model: string, input: number, cached: number, context?: { used: number; max: number }) =>
    turnTokensOf(turn({ agentId: WORKER, role: "worker", at: at(1), turnId: "t-1", toolCalls: 12, usage: usage(model, input, cached, context) }));

  it("a Claude Worker turn at 5,700,000 tokens read crosses; a Codex Worker turn at 5,700,000 does not; a Codex turn at a context share of 0.5 does", () => {
    const claude = workerTurn("claude-opus-5", 200_000, 5_500_000, { used: 60_000, max: 1_000_000 });
    expect(claude).toMatchObject({ provider: "claude", coverage: "turn", tokensRead: 5_700_000 });
    expect(compactCrossingOf("worker", claude, S)).toEqual({ figure: "tokensPerTurn", value: 5_700_000, threshold: 5_700_000 });

    const codex = workerTurn("gpt-5.6-sol", 5_700_000, 5_000_000, { used: 100_000, max: 258_400 });
    expect(codex).toMatchObject({ provider: "codex", coverage: "last-call", tokensRead: 5_700_000 });
    expect(compactCrossingOf("worker", codex, S)).toBeNull();

    const codexHalfFull = workerTurn("gpt-5.6-sol", 129_200, 120_000, { used: 129_200, max: 258_400 });
    expect(codexHalfFull.contextShare).toBe(0.5);
    expect(compactCrossingOf("worker", codexHalfFull, S)).toEqual({ figure: "contextShare", value: 0.5, threshold: 0.5 });
  });

  it("judges each role by its own threshold, and an OpenCode turn like a Codex one", () => {
    const turnOf = (tokensRead: number, coverage: "turn" | "last-call" | "unknown", contextShare: number | null = null) => ({ coverage, tokensRead, contextShare });
    expect(compactCrossingOf("manager", turnOf(390_000, "turn"), S)).toEqual({ figure: "tokensPerTurn", value: 390_000, threshold: 390_000 });
    expect(compactCrossingOf("manager", turnOf(389_999, "turn"), S)).toBeNull();
    expect(compactCrossingOf("worker", turnOf(390_000, "turn"), S)).toBeNull();
    const openCode = workerTurn("opencode/big-pickle", 10, 6_000_000, { used: 90_000, max: 200_000 });
    expect(openCode.coverage).toBe("last-call");
    expect(compactCrossingOf("worker", openCode, S)).toBeNull();
    expect(compactCrossingOf("worker", turnOf(9_000_000, "unknown", 0.2), S)).toBeNull();
    expect(compactCrossingOf("manager", turnOf(10, "last-call", 0.6), S)).toEqual({ figure: "contextShare", value: 0.6, threshold: 0.5 });
  });

  it("counts either figure on Claude, tokens first; a turn without a reported context is judged by its tokens alone", () => {
    const both = { coverage: "turn" as const, tokensRead: 6_000_000, contextShare: 0.7 };
    expect(compactCrossingOf("worker", both, S)?.figure).toBe("tokensPerTurn");
    expect(compactCrossingOf("worker", { ...both, tokensRead: 100_000 }, S)).toEqual({ figure: "contextShare", value: 0.7, threshold: 0.5 });
    expect(compactCrossingOf("worker", { ...both, tokensRead: 100_000, contextShare: null }, S)).toBeNull();
    expect(compactCrossingOf("worker", { coverage: "turn", tokensRead: null, contextShare: null }, S)).toBeNull();
    // The owner's thresholds, not the defaults, decide.
    const owner = { compact: { ...S.compact, workerTokensPerTurn: 8_000_000, contextShare: 0.8 } };
    expect(compactCrossingOf("worker", both, owner)).toBeNull();
  });

  it("a request crosses handoff.requestTokens when its tokens read since it started or its last handoff reach it", () => {
    expect(handoffCrossingOf(150_000_000, S)).toEqual({ figure: "requestTokens", value: 150_000_000, threshold: 150_000_000 });
    expect(handoffCrossingOf(149_999_999, S)).toBeNull();
    expect(handoffCrossingOf(null, S)).toBeNull();
    expect(handoffCrossingOf(120_000_000, { handoff: { ...S.handoff, requestTokens: 100_000_000 } })?.threshold).toBe(100_000_000);
  });
});
