import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  MAX_JOURNAL_LINES,
  MAX_JOURNAL_TEXT,
  MAX_MISSION_GOAL,
  MAX_MISSION_NAME,
  MAX_NON_GOALS,
  MISSIONS_DIR_NAME,
  MISSION_ID_PATTERN,
  createMissionStore,
  newMissionId,
  type NewMission,
} from "../plugin/server/mission-store";
import {
  MISSION_DECISION_ID_PATTERN,
  createMissionDecisionStore,
  missionOfDecisionId,
} from "../plugin/server/mission-decisions";
import { DECISION_SETTLED_LIMIT } from "../plugin/server/decision-store";
import { clearJsonFileCache } from "../plugin/server/data-files";
import { CLEANUP_DELETES } from "../plugin/server/setup-machine";
import { answerDecision, withdrawDecision } from "../plugin/shared/decisions";
import { dataFolder, removeDataFolders } from "./helpers/data-folder";
import { makeDecision } from "./helpers/decisions";

/**
 * Missions (missions design §2.1, §2.2, §4.1): the mission store, its index,
 * its journal and the `m:` decision store. Temporary data folders only.
 */

const T0 = new Date("2026-10-09T10:00:00.000Z");
const SECRET = "sk-mission-secret-123";
const ENV = { PASEO_PASSWORD: SECRET } as NodeJS.ProcessEnv;

afterEach(() => {
  clearJsonFileCache();
  removeDataFolders();
});

function ids(): () => string {
  let n = 0;
  return () => `mis-${(++n).toString(16).padStart(10, "0")}`;
}

function store(home: string) {
  return createMissionStore(home, { now: () => T0, newId: ids(), env: ENV });
}

function mission(overrides: Partial<NewMission> = {}): NewMission {
  return { code: "PAY", name: "Payments", goal: "Ship the export.", repos: ["wks_a", "wks_b"], createdBy: "owner", mainId: "main-1", ...overrides };
}

function created(result: ReturnType<ReturnType<typeof store>["create"]>) {
  if (!result.ok) throw new Error(result.reasons.join("\n"));
  return result.mission;
}

describe("missions (§2.1)", () => {
  it("creates nothing on a read and writes { schemaVersion: 1, ...mission } 0600 in a 0700 folder", () => {
    const home = dataFolder();
    const missions = store(home);
    expect(missions.list()).toEqual([]);
    expect(missions.get("mis-0000000001")).toBeNull();
    expect(existsSync(join(home, MISSIONS_DIR_NAME))).toBe(false);

    const made = created(missions.create(mission()));
    expect(made.missionId).toMatch(MISSION_ID_PATTERN);
    expect(newMissionId()).toMatch(MISSION_ID_PATTERN);
    const path = join(home, MISSIONS_DIR_NAME, `${made.missionId}.json`);
    expect(statSync(join(home, MISSIONS_DIR_NAME)).mode & 0o777).toBe(0o700);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const body = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    expect(Object.keys(body)[0]).toBe("schemaVersion");
    expect(body).toMatchObject({ schemaVersion: 1, missionId: made.missionId, code: "PAY", state: "open", mainId: "main-1" });
    expect(made.mainHistory).toEqual([{ agentId: "main-1", from: T0.toISOString(), to: null, reason: "created" }]);
    expect(made.charter).toEqual({ goal: "Ship the export.", repos: ["wks_a", "wks_b"], nonGoals: [], doneCriteria: [], budget: null, confirmedAt: null });
    expect(missions.get(made.missionId)).toEqual(made);
  });

  it("masks and bounds every text field on each write", () => {
    const home = dataFolder();
    const missions = store(home);
    const made = created(missions.create(mission({ name: `${SECRET} ${"n".repeat(200)}`, goal: "g".repeat(MAX_MISSION_GOAL + 50) })));
    expect(made.name).not.toContain(SECRET);
    expect(made.name.length).toBe(MAX_MISSION_NAME);
    expect(made.charter.goal.length).toBe(MAX_MISSION_GOAL);
    const updated = missions.update(made.missionId, (current) => ({
      ...current,
      charter: { ...current.charter, nonGoals: Array.from({ length: 30 }, (_, n) => `no ${n} ${SECRET}`) },
      plan: { text: `step 1 uses ${SECRET}`, updatedAt: T0.toISOString() },
    }));
    if (!updated.ok) throw new Error(updated.reasons.join("\n"));
    expect(updated.mission.charter.nonGoals).toHaveLength(MAX_NON_GOALS);
    expect(JSON.stringify(updated.mission)).not.toContain(SECRET);
    expect(readFileSync(join(home, MISSIONS_DIR_NAME, `${made.missionId}.json`), "utf8")).not.toContain(SECRET);
  });

  it("keeps a code unique among open missions, and lets a closed one's code be reused", () => {
    const home = dataFolder();
    const missions = store(home);
    const first = created(missions.create(mission()));
    const refused = missions.create(mission({ name: "Other" }));
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.reasons).toEqual([`code PAY is taken by the open mission Payments (${first.missionId})`]);
    const bad = missions.create(mission({ code: "pay" }));
    expect(bad.ok).toBe(false);

    const second = created(missions.create(mission({ code: "OPS", name: "Ops" })));
    expect(missions.update(second.missionId, (current) => ({ ...current, code: "PAY" })).ok).toBe(false);

    expect(missions.update(first.missionId, (current) => ({ ...current, state: "closed", closedAt: T0.toISOString() })).ok).toBe(true);
    const third = created(missions.create(mission({ name: "Payments 2" })));
    expect(missions.byCode("PAY")?.missionId).toBe(third.missionId);
    // Reopening the first would hold PAY twice.
    expect(missions.update(first.missionId, (current) => ({ ...current, state: "open", closedAt: null })).ok).toBe(false);
  });

  it("refuses an unknown mission, a changed id and an invalid mission; null changes nothing", () => {
    const home = dataFolder();
    const missions = store(home);
    const made = created(missions.create(mission()));
    expect(missions.update("mis-ffffffffff", (current) => current)).toEqual({ ok: false, reasons: ["unknown mission mis-ffffffffff"] });
    expect(missions.update(made.missionId, (current) => ({ ...current, missionId: "mis-ffffffffff" })).ok).toBe(false);
    expect(missions.update(made.missionId, (current) => ({ ...current, code: "lower" })).ok).toBe(false);
    expect(missions.update(made.missionId, () => ({ reasons: ["no"] }))).toEqual({ ok: false, reasons: ["no"] });
    expect(missions.update(made.missionId, () => null)).toEqual({ ok: true, mission: made });
  });

  it("replaces the Main: the current history entry ends, a new one starts", () => {
    const home = dataFolder();
    const missions = store(home);
    const made = created(missions.create(mission()));
    const replaced = missions.setMain(made.missionId, "main-2", "replaced");
    if (!replaced.ok) throw new Error(replaced.reasons.join("\n"));
    expect(replaced.mission.mainId).toBe("main-2");
    expect(replaced.mission.mainHistory).toEqual([
      { agentId: "main-1", from: T0.toISOString(), to: T0.toISOString(), reason: "created" },
      { agentId: "main-2", from: T0.toISOString(), to: null, reason: "replaced" },
    ]);
    expect(missions.list()[0]?.mainId).toBe("main-2");
  });

  it("never overwrites a mission file that cannot be used, and reads it as missing", () => {
    const home = dataFolder();
    const missions = store(home);
    const made = created(missions.create(mission()));
    const path = join(home, MISSIONS_DIR_NAME, `${made.missionId}.json`);
    writeFileSync(path, "{ not json");
    expect(missions.get(made.missionId)).toBeNull();
    expect(() => missions.setMain(made.missionId, "main-2", "owner")).not.toThrow();
    expect(readFileSync(path, "utf8")).toBe("{ not json");
  });
});

describe("the index (§2.1)", () => {
  it("keeps one entry per mission, rewritten with each mission write", () => {
    const home = dataFolder();
    const missions = store(home);
    const a = created(missions.create(mission()));
    const b = created(missions.create(mission({ code: "OPS", name: "Ops", repos: ["wks_c"], mainId: null })));
    const index = JSON.parse(readFileSync(join(home, MISSIONS_DIR_NAME, "index.json"), "utf8")) as { schemaVersion: number; missions: unknown[] };
    expect(index.schemaVersion).toBe(1);
    expect(index.missions).toEqual([
      { missionId: a.missionId, code: "PAY", name: "Payments", state: "open", mainId: "main-1", repos: ["wks_a", "wks_b"] },
      { missionId: b.missionId, code: "OPS", name: "Ops", state: "open", mainId: null, repos: ["wks_c"] },
    ]);
    expect(missions.byCode("OPS")?.missionId).toBe(b.missionId);
    expect(missions.byCode("NONE")).toBeNull();
  });

  it("rebuilds a missing or stale index from the mission files", () => {
    const home = dataFolder();
    const missions = store(home);
    const a = created(missions.create(mission()));
    const indexPath = join(home, MISSIONS_DIR_NAME, "index.json");

    writeFileSync(indexPath, JSON.stringify({ schemaVersion: 1, missions: [] }));
    expect(missions.list().map((entry) => entry.missionId)).toEqual([a.missionId]);

    // A mission file written behind the index's back (newer than it).
    const path = join(home, MISSIONS_DIR_NAME, `${a.missionId}.json`);
    const body = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    writeFileSync(path, JSON.stringify({ ...body, name: "Renamed" }));
    const later = new Date(Date.now() + 60_000);
    utimesSync(path, later, later);
    clearJsonFileCache();
    expect(missions.list()[0]?.name).toBe("Renamed");

    writeFileSync(indexPath, "broken");
    expect(missions.list()[0]?.name).toBe("Renamed");
    expect(JSON.parse(readFileSync(indexPath, "utf8")).missions).toHaveLength(1);
  });
});

describe("the journal (§2.2)", () => {
  it("appends one masked line per event and reads the newest", () => {
    const home = dataFolder();
    const missions = store(home);
    const made = created(missions.create(mission()));
    missions.appendJournal(made.missionId, { kind: "charter", by: "owner", text: "Charter confirmed" });
    missions.appendJournal(made.missionId, { kind: "note", by: "main-1", text: `uses\n${SECRET} ${"x".repeat(900)}`, ref: "D1" });
    const lines = missions.journal(made.missionId);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toEqual({ at: T0.toISOString(), kind: "charter", by: "owner", text: "Charter confirmed" });
    expect(lines[1]?.ref).toBe("D1");
    expect(lines[1]?.text).not.toContain(SECRET);
    expect(lines[1]?.text).not.toContain("\n");
    expect(lines[1]?.text.length).toBe(MAX_JOURNAL_TEXT);
    expect(missions.journal(made.missionId, 1)).toEqual([lines[1]]);
    expect(missions.journal(made.missionId, 0)).toEqual([]);
    expect(statSync(join(home, MISSIONS_DIR_NAME, `${made.missionId}.journal.jsonl`)).mode & 0o777).toBe(0o600);
  });

  it("skips a line that does not parse and keeps the newest MAX_JOURNAL_LINES", () => {
    const home = dataFolder();
    const missions = store(home);
    const made = created(missions.create(mission()));
    const path = join(home, MISSIONS_DIR_NAME, `${made.missionId}.journal.jsonl`);
    const line = (n: number) => JSON.stringify({ at: T0.toISOString(), kind: "note", by: "main-1", text: `line ${n}` });
    writeFileSync(path, `${Array.from({ length: MAX_JOURNAL_LINES }, (_, n) => line(n)).join("\n")}\nhalf a li`, { mode: 0o600 });
    expect(missions.journal(made.missionId, MAX_JOURNAL_LINES + 10)).toHaveLength(MAX_JOURNAL_LINES);
    missions.appendJournal(made.missionId, { kind: "note", by: "main-1", text: "newest" });
    const kept = readFileSync(path, "utf8").trim().split("\n");
    expect(kept).toHaveLength(MAX_JOURNAL_LINES);
    expect(missions.journal(made.missionId, 1)[0]?.text).toBe("newest");
  });
});

describe("m: decisions (§4.1)", () => {
  const MISSION = "mis-00000000aa";
  const decision = (n: number) => makeDecision({ id: `m:${MISSION}:${n}`, requestId: null, askedBy: { role: "plugin", agentId: "main-1" }, round: null });

  it("stores them in missions/<missionId>.decisions.json with the decision schema", () => {
    const home = dataFolder();
    const decisions = createMissionDecisionStore(home);
    expect(decisions.list(MISSION)).toEqual([]);
    expect(decisions.nextId(MISSION)).toBe(`m:${MISSION}:1`);
    expect(decisions.open(decision(1))).toEqual({ decision: decision(1), created: true });
    expect(decisions.open(decision(1)).created).toBe(false);
    expect(decisions.nextId(MISSION)).toBe(`m:${MISSION}:2`);
    const path = join(home, MISSIONS_DIR_NAME, `${MISSION}.decisions.json`);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ version: 1, entries: [decision(1)] });
    expect(decisions.get(`m:${MISSION}:1`)).toEqual(decision(1));
    expect(missionOfDecisionId(`m:${MISSION}:1`)).toBe(MISSION);
    expect(MISSION_DECISION_ID_PATTERN.test("q:req-20261009T100000Z:Q1")).toBe(false);
    // The per-workspace store is untouched.
    expect(existsSync(join(home, "decisions"))).toBe(false);
  });

  it("refuses an id of another shape, and answers through the shared transitions", () => {
    const home = dataFolder();
    const decisions = createMissionDecisionStore(home);
    expect(() => decisions.open(makeDecision())).toThrow();
    decisions.open(decision(1));
    const answered = decisions.transition(`m:${MISSION}:1`, (found) => answerDecision(found, { via: "inbox", optionKey: "a", at: T0.toISOString() }));
    expect(answered.status).toBe("updated");
    expect(decisions.list(MISSION, ["answered"])).toHaveLength(1);
    const again = decisions.transition(`m:${MISSION}:1`, (found) => withdrawDecision(found, { at: T0.toISOString() }));
    expect(again.status).toBe("refused");
    expect(decisions.transition(`m:${MISSION}:9`, (found) => withdrawDecision(found, { at: T0.toISOString() }))).toEqual({ status: "not-found" });
  });

  it("keeps every open decision and the newest settled ones", () => {
    const home = dataFolder();
    const settled = Array.from({ length: DECISION_SETTLED_LIMIT + 2 }, (_, n) =>
      makeDecision({ ...decision(n + 1), status: "withdrawn", settledAt: new Date(T0.getTime() + n * 1000).toISOString() }),
    );
    mkdirSync(join(home, MISSIONS_DIR_NAME), { mode: 0o700 });
    writeFileSync(join(home, MISSIONS_DIR_NAME, `${MISSION}.decisions.json`), JSON.stringify({ version: 1, entries: settled }), { mode: 0o600 });
    const decisions = createMissionDecisionStore(home);
    decisions.open(decision(DECISION_SETTLED_LIMIT + 3));
    const kept = decisions.list(MISSION);
    expect(kept).toHaveLength(DECISION_SETTLED_LIMIT + 1);
    expect(kept[0]?.id).toBe(`m:${MISSION}:3`);
    expect(kept.at(-1)?.status).toBe("open");
  });
});

describe("cleanup", () => {
  it("deletes missions/ with the rest", () => {
    expect(CLEANUP_DELETES).toContain(MISSIONS_DIR_NAME);
  });
});
