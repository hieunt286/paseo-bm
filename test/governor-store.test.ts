import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAlertStore } from "../plugin/server/alert-store";
import { governedLadderOf } from "../plugin/server/command-authority";
import { createCoordinationStore } from "../plugin/server/coordination-store";
import { familyFiguresOf, type GovernorFigure } from "../plugin/server/governor-figures";
import {
  GOVERNOR_FILE,
  NUDGE_RETRY_MS,
  charterLineOf,
  createGovernor,
  createGovernorStore,
  ladderStepOf,
  nudgeCommandOf,
  type FamilyState,
  type LadderFacts,
} from "../plugin/server/governor-store";
import { checkInterventions, createInterventionStore } from "../plugin/server/intervention-store";
import { createMissionRoster } from "../plugin/server/mission-roster";
import { createMissionStore, type Mission } from "../plugin/server/mission-store";
import { createOrchestratorStore } from "../plugin/server/orchestrator-store";
import { DEFAULT_COORDINATION_SETTINGS } from "../plugin/shared/coordination";
import { commandBlockOf, parseCommandBlock } from "../plugin/shared/orchestrator-command";
import { fakePaseo } from "./helpers/fake-paseo";

/**
 * The governor's ladder (missions design §9.3, §9.4): the pure steps, the
 * nudge command, the store `orchestrator/governor.json`, and the runner on a
 * temporary data folder — steps 1 and 2 with no model, the reset on
 * recovery. No daemon: a fake Paseo handle and a fake notice queue.
 */

const T0 = new Date("2026-10-09T12:00:00.000Z");
const minutes = (n: number): Date => new Date(T0.getTime() + n * 60_000);
const WINDOW = { windowMinutes: 30, windowTurns: 5 };

const stalled = (crossed: boolean): GovernorFigure => ({ family: "stuck", id: "stalled", value: crossed ? 1 : 0, threshold: 1, op: ">=", crossed, detail: null });
const facts = (at: Date, mainTurns = 0): LadderFacts => ({ now: at, mainTurns, settings: WINDOW });

describe("ladderStepOf: the steps code takes (§9.3)", () => {
  it("records a crossing (1), nudges at the next recomputation (2), and marks a re-plan due after 30 minutes and 5 Main turns (3)", () => {
    const one = ladderStepOf(null, [stalled(true)], facts(T0, 10));
    expect(one.action).toBe("record");
    expect(one.state).toMatchObject({ step: 1, since: T0.toISOString(), lastAction: { kind: "record" } });

    const two = ladderStepOf(one.state, [stalled(true)], facts(minutes(1), 10));
    expect(two.action).toBe("nudge");
    expect(two.state).toMatchObject({ step: 2, since: T0.toISOString(), lastAction: { at: minutes(1).toISOString(), kind: "nudge" }, mainTurnsAt: 10 });

    // The window needs both: the minutes and the Main's turns.
    expect(ladderStepOf(two.state, [stalled(true)], facts(minutes(40), 14)).action).toBe("none");
    expect(ladderStepOf(two.state, [stalled(true)], facts(minutes(20), 20)).action).toBe("none");
    const three = ladderStepOf(two.state, [stalled(true)], facts(minutes(31), 15));
    expect(three.action).toBe("replan-due");
    expect(three.state).toMatchObject({ step: 3, lastAction: { kind: "replan-due" }, mainTurnsAt: 10 });

    // Steps 3 and 4 are the model's: code leaves them.
    expect(ladderStepOf(three.state, [stalled(true)], facts(minutes(90), 40))).toEqual({ state: three.state, action: "none" });
    expect(ladderStepOf({ ...three.state, step: 4 }, [stalled(true)], facts(minutes(90), 40)).action).toBe("none");
  });

  it("resets the family to 0 when its figures are back under their thresholds, from any step", () => {
    for (const step of [1, 2, 3, 4]) {
      const current: FamilyState = { step, since: T0.toISOString(), figures: [stalled(true)], lastAction: { at: T0.toISOString(), kind: "nudge", id: "cmd-1" }, mainTurnsAt: 3 };
      const reset = ladderStepOf(current, [stalled(false)], facts(minutes(5)));
      expect(reset.action, `step ${step}`).toBe("reset");
      expect(reset.state).toEqual({ step: 0, since: null, figures: [stalled(false)], lastAction: { at: minutes(5).toISOString(), kind: "reset", id: null }, mainTurnsAt: null });
    }
    // At rest, figures under their thresholds change nothing but the figures.
    expect(ladderStepOf(null, [stalled(false)], facts(T0))).toEqual({ state: { step: 0, since: null, figures: [stalled(false)], lastAction: null, mainTurnsAt: null }, action: "none" });
  });

  it("tries a failed nudge again only after NUDGE_RETRY_MS", () => {
    const failed: FamilyState = { step: 1, since: T0.toISOString(), figures: [], lastAction: { at: T0.toISOString(), kind: "nudge-failed", id: null }, mainTurnsAt: null };
    expect(ladderStepOf(failed, [stalled(true)], facts(new Date(T0.getTime() + NUDGE_RETRY_MS - 1))).action).toBe("none");
    expect(ladderStepOf(failed, [stalled(true)], facts(new Date(T0.getTime() + NUDGE_RETRY_MS))).action).toBe("nudge");
  });

  it("counts the window again from a bm_govern step on a family at step 1 or 2: both its minutes and its Main turns (governedLadderOf)", () => {
    const nudged = ladderStepOf(ladderStepOf(null, [stalled(true)], facts(T0, 10)).state, [stalled(true)], facts(minutes(1), 10)).state;
    expect(nudged).toMatchObject({ step: 2, mainTurnsAt: 10 });
    // A re-plan 20 minutes and 3 Main turns after the nudge: the family stays at 2, its window restarts.
    const replanned = governedLadderOf({ stuck: nudged }, "replan", [], { at: minutes(21).toISOString(), id: "cmd-gov", mainTurns: 13 }).stuck!;
    expect(replanned).toEqual({ ...nudged, lastAction: { at: minutes(21).toISOString(), kind: "replan", id: "cmd-gov" }, mainTurnsAt: 13 });
    // Due after 30 minutes and 5 Main turns from the nudge, but not from the re-plan.
    expect(ladderStepOf(replanned, [stalled(true)], facts(minutes(40), 16)).action).toBe("none");
    // 30 minutes from the re-plan, 4 turns: not yet; 5 turns, 29 minutes: not yet.
    expect(ladderStepOf(replanned, [stalled(true)], facts(minutes(51), 17)).action).toBe("none");
    expect(ladderStepOf(replanned, [stalled(true)], facts(minutes(50), 18)).action).toBe("none");
    expect(ladderStepOf(replanned, [stalled(true)], facts(minutes(51), 18))).toMatchObject({ action: "replan-due", state: { step: 3, mainTurnsAt: 13 } });

    // An arbitration naming the family's figure, and a nudge at step 2, restart it the same way; at step 1 the family waits for code's nudge.
    const arbitrated = governedLadderOf({ stuck: nudged }, "arbitrate", ["stalled"], { at: minutes(21).toISOString(), id: "cmd-arb", mainTurns: 13 }).stuck!;
    expect(arbitrated).toMatchObject({ step: 2, lastAction: { at: minutes(21).toISOString(), kind: "arbitrate" }, mainTurnsAt: 13 });
    expect(governedLadderOf({ stuck: nudged }, "nudge", [], { at: minutes(21).toISOString(), id: "cmd-n", mainTurns: 13 }).stuck).toMatchObject({ step: 2, mainTurnsAt: 13 });
    const recorded = ladderStepOf(null, [stalled(true)], facts(T0, 10)).state;
    expect(governedLadderOf({ stuck: recorded }, "replan", [], { at: minutes(1).toISOString(), id: "cmd-gov", mainTurns: 11 }).stuck).toMatchObject({ step: 1, lastAction: { kind: "replan" }, mainTurnsAt: 11 });
    // At step 3 and above the turns stay as they were: a re-plan moves 3 to 4.
    const due = { ...nudged, step: 3 };
    expect(governedLadderOf({ stuck: due }, "replan", [], { at: minutes(40).toISOString(), id: "cmd-gov", mainTurns: 20 }).stuck).toMatchObject({ step: 4, mainTurnsAt: 10 });
    expect(governedLadderOf({ stuck: { ...due, step: 4 } }, "arbitrate", ["stalled"], { at: minutes(40).toISOString(), id: "cmd-arb", mainTurns: 20 }).stuck).toMatchObject({ step: 4, mainTurnsAt: 10 });
  });
});

const MISSION_ID = "mis-0123456789";
const REQUEST = "req-20261009T100000Z";

describe("nudgeCommandOf: the step-2 BM-COMMAND", () => {
  const mission = {
    code: "PAY",
    charter: { goal: "Ship card payments\nand refunds", repos: ["repo-a"], nonGoals: [], doneCriteria: [], budget: null, confirmedAt: null },
  } satisfies Pick<Mission, "code" | "charter">;

  it("goes from the Orchestrator to the Main on governor:nudge, with no effect, naming the figures, the charter line and the window", () => {
    const figure: GovernorFigure = { ...stalled(true), detail: REQUEST };
    const command = nudgeCommandOf(mission, "stuck", [figure, { ...stalled(false), id: "oldCards" }], WINDOW);
    const block = commandBlockOf(command);
    expect(parseCommandBlock(block)).toMatchObject({ from: "orchestrator", to: "manager", requestId: null, authority: "governor:nudge", effects: [], approved: [], intent: "other" });
    expect(block).toContain("re: Governor: stuck figures of mission PAY crossed");
    expect(block).toContain(`- stalled 1 (threshold ≥ 1; ${REQUEST})`);
    expect(block).not.toContain("oldCards");
    expect(block).toContain("Charter: Goal: Ship card payments");
    expect(block).toContain("Re-plan or explain in one line in your next reply; the governor checks again in 30 minutes and 5 more of your turns.");
  });

  it("names the charter line each family concerns", () => {
    const full = {
      ...mission,
      charter: {
        ...mission.charter,
        repos: ["repo-a", "repo-b"],
        doneCriteria: [{ id: "D1", text: "cards pay", status: "open" as const, at: null, evidence: null }],
        budget: { requests: 10, workers: 3, reviewCalls: null, days: 5 },
      },
    };
    expect(charterLineOf(full, "mess")).toBe("Repos: repo-a, repo-b; at most 3 Workers");
    expect(charterLineOf(full, "overengineering")).toBe("Done criteria: 1, first open D1 cards pay");
    expect(charterLineOf(full, "drift")).toBe("Open done criteria: D1 cards pay");
    expect(charterLineOf(full, "stuck")).toBe("Goal: Ship card payments");
    expect(charterLineOf(full, "budget")).toBe("Budget: requests 10, workers 3, review calls none, days 5");
  });
});

describe("the store and the runner on a data folder", () => {
  let home: string;
  let clock: Date;
  let logs: string[];
  let ids: number;
  const enqueue = vi.fn<(target: string, kind: string, text: string) => Promise<"queued">>(async () => "queued");

  const journal = () => createMissionStore(home).journal(MISSION_ID).filter((line) => line.kind === "governor");
  const governor = () =>
    createGovernor({ home: () => home, now: () => clock, log: (line) => logs.push(line), queue: { enqueue }, store: { newId: () => `cmd-${++ids}` }, redactEnv: {} });
  const paseo = () => fakePaseo().paseo as never;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "bm-governor-"));
    clock = T0;
    logs = [];
    ids = 0;
    enqueue.mockClear();
    const created = createMissionStore(home, { newId: () => MISSION_ID, env: {} }).create({ code: "PAY", name: "Payments", goal: "Ship card payments", repos: ["repo-a"], createdBy: "owner", mainId: "main-1" });
    if (!created.ok) throw new Error(created.reasons.join("; "));
    createMissionRoster(home, { env: {} }).add(MISSION_ID, { requestId: REQUEST, workspaceId: "repo-a", topic: "cards", workerId: "w1" });
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("keeps each mission's ladder in orchestrator/governor.json, 0600, and skips a family state that does not validate", () => {
    const store = createGovernorStore(home);
    expect(store.path).toBe(join(home, "orchestrator", GOVERNOR_FILE));
    expect(store.ladder(MISSION_ID)).toEqual({});
    const state: FamilyState = { step: 1, since: T0.toISOString(), figures: [stalled(true)], lastAction: { at: T0.toISOString(), kind: "record", id: null }, mainTurnsAt: null };
    store.put(MISSION_ID, { stuck: state });
    expect(store.ladder(MISSION_ID)).toEqual({ stuck: state });
    expect(statSync(store.path).mode & 0o777).toBe(0o600);
    const body = JSON.parse(readFileSync(store.path, "utf8")) as { version: number };
    expect(body.version).toBe(1);
    writeFileSync(store.path, JSON.stringify({ version: 1, missions: { [MISSION_ID]: { stuck: state, mess: { step: 9 } } } }));
    expect(createGovernorStore(home).ladder(MISSION_ID)).toEqual({ stuck: state });
    // A newer file reads as empty.
    writeFileSync(store.path, JSON.stringify({ version: 2, missions: { [MISSION_ID]: { stuck: state } } }));
    expect(createGovernorStore(home).ladder(MISSION_ID)).toEqual({});
  });

  it("records, nudges the current Main through the command pipeline, and resets on recovery — with no model", async () => {
    const alerts = createAlertStore(home);
    alerts.raise({ workspaceId: "repo-a", kind: "request-stalled", subject: REQUEST, detail: "idle-unfinished" });

    const first = await governor().recompute(MISSION_ID, paseo());
    expect(first?.actions).toEqual([{ family: "stuck", action: "record", commandId: null, reason: null }]);
    expect(familyFiguresOf(first!.figures, "stuck").find((entry) => entry.id === "stalled")).toMatchObject({ value: 1, crossed: true });
    expect(journal().map((line) => line.text)).toEqual([`stuck crossed: stalled 1 (threshold ≥ 1; ${REQUEST})`]);
    expect(enqueue).not.toHaveBeenCalled();

    clock = minutes(1);
    const second = await governor().recompute(MISSION_ID, paseo());
    expect(second?.actions).toEqual([{ family: "stuck", action: "nudge", commandId: "cmd-1", reason: null }]);
    expect(enqueue).toHaveBeenCalledTimes(1);
    const [target, kind, text] = enqueue.mock.calls[0]!;
    expect([target, kind]).toEqual(["main-1", "command:cmd-1"]);
    expect(parseCommandBlock(text)).toMatchObject({ from: "orchestrator", to: "manager", authority: "governor:nudge", effects: [] });
    const [stored] = createOrchestratorStore(home).listCommands();
    expect(stored).toMatchObject({ id: "cmd-1", missionId: MISSION_ID, managerId: "main-1", requestId: null });
    expect(createGovernorStore(home).ladder(MISSION_ID).stuck).toMatchObject({ step: 2, lastAction: { kind: "nudge", id: "cmd-1" }, mainTurnsAt: 0 });
    expect(journal().at(-1)).toMatchObject({ text: "stuck: nudged the Main (command cmd-1)", ref: "cmd-1" });
    // Missions design §9.3: the nudge is in the intervention log (A-12).
    expect(createInterventionStore(home).list()).toMatchObject([
      { kind: "govern", step: "nudge", trigger: "governor", targetAgentId: "main-1", missionId: MISSION_ID, families: ["stuck"], commandId: "cmd-1", at: minutes(1).toISOString(), outcome: "pending" },
    ]);

    // Still crossed, inside the window: nothing more.
    clock = minutes(2);
    expect((await governor().recompute(MISSION_ID, paseo()))?.actions).toEqual([]);

    alerts.clearWhere((alert) => alert.subject === REQUEST);
    clock = minutes(3);
    const third = await governor().recompute(MISSION_ID, paseo());
    expect(third?.actions).toEqual([{ family: "stuck", action: "reset", commandId: null, reason: null }]);
    expect(createGovernorStore(home).ladder(MISSION_ID).stuck).toMatchObject({ step: 0, since: null, lastAction: { kind: "reset" } });
    expect(journal().at(-1)?.text).toBe("stuck back under its thresholds");
    // Back under within its window: the nudge met its outcome.
    expect(checkInterventions(home, { now: () => minutes(3), log: () => {} }).map((entry) => [entry.kind, entry.outcome])).toEqual([["govern", "met"]]);
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(logs).toEqual([]);
  });

  it("keeps a family bm_govern wrote while a nudge was being delivered (GovernorStore.update)", async () => {
    createAlertStore(home).raise({ workspaceId: "repo-a", kind: "request-stalled", subject: REQUEST });
    await governor().recompute(MISSION_ID, paseo());
    const replanned: FamilyState = { step: 4, since: T0.toISOString(), figures: [], lastAction: { at: T0.toISOString(), kind: "replan", id: "cmd-gov" }, mainTurnsAt: null };
    // The nudge's delivery awaits; meanwhile bm_govern records a re-plan of another family.
    enqueue.mockImplementationOnce(async () => {
      createGovernorStore(home).update(MISSION_ID, (current) => ({ ...current, mess: replanned }));
      return "queued";
    });
    clock = minutes(1);
    expect((await governor().recompute(MISSION_ID, paseo()))?.actions).toEqual([{ family: "stuck", action: "nudge", commandId: "cmd-1", reason: null }]);
    const ladder = createGovernorStore(home).ladder(MISSION_ID);
    expect(ladder.mess).toEqual(replanned);
    expect(ladder.stuck).toMatchObject({ step: 2, lastAction: { kind: "nudge", id: "cmd-1" } });
    expect(ladder.drift).toMatchObject({ step: 0 });
  });

  it("reads the owner's governor.* thresholds at each recomputation", async () => {
    const roster = createMissionRoster(home, { env: {} });
    roster.add(MISSION_ID, { requestId: "req-20261009T110000Z", workspaceId: "repo-c", topic: "outside", workerId: "w2" });
    expect((await governor().recompute(MISSION_ID, paseo()))?.actions).toEqual([{ family: "drift", action: "record", commandId: null, reason: null }]);
    createCoordinationStore(home).set({ key: "governor.outsideCharter", value: 2 });
    clock = minutes(1);
    expect((await governor().recompute(MISSION_ID, paseo()))?.actions).toEqual([{ family: "drift", action: "reset", commandId: null, reason: null }]);
    expect(DEFAULT_COORDINATION_SETTINGS.governor.outsideCharter).toBe(1);
  });

  it("leaves the family at step 1 when the mission has no Main, and tries again after NUDGE_RETRY_MS", async () => {
    createMissionStore(home).update(MISSION_ID, (current) => ({ ...current, mainId: null }));
    createAlertStore(home).raise({ workspaceId: "repo-a", kind: "request-stalled", subject: REQUEST });
    await governor().recompute(MISSION_ID, paseo());
    clock = minutes(1);
    const failed = await governor().recompute(MISSION_ID, paseo());
    expect(failed?.actions).toEqual([{ family: "stuck", action: "nudge-failed", commandId: null, reason: "mission PAY has no Main" }]);
    expect(createGovernorStore(home).ladder(MISSION_ID).stuck).toMatchObject({ step: 1, lastAction: { kind: "nudge-failed" } });
    expect(logs).toEqual(["[paseo-bm] the governor could not nudge the Main of mission PAY on stuck: mission PAY has no Main"]);
    clock = minutes(5);
    expect((await governor().recompute(MISSION_ID, paseo()))?.actions).toEqual([]);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("recomputes on a recorded turn of the mission's Worker or Main, and every open mission on the pass; never a closed one", async () => {
    createAlertStore(home).raise({ workspaceId: "repo-a", kind: "request-stalled", subject: REQUEST });
    expect((await governor().turnRecorded({ agentId: "w1", requestId: REQUEST }, paseo()))?.missionId).toBe(MISSION_ID);
    expect((await governor().turnRecorded({ agentId: "main-1", requestId: null }, paseo()))?.missionId).toBe(MISSION_ID);
    expect(await governor().turnRecorded({ agentId: "someone", requestId: null }, paseo())).toBeNull();
    expect((await governor().pass(paseo())).map((outcome) => outcome.missionId)).toEqual([MISSION_ID]);
    createMissionStore(home).update(MISSION_ID, (current) => ({ ...current, state: "closed", closedAt: T0.toISOString() }));
    expect(await governor().pass(paseo())).toEqual([]);
    expect(await governor().recompute(MISSION_ID, paseo())).toBeNull();
  });

  it("creates nothing on disk for a data folder without missions", async () => {
    const empty = mkdtempSync(join(tmpdir(), "bm-governor-empty-"));
    try {
      mkdirSync(join(empty, "x"));
      expect(await createGovernor({ home: () => empty }).pass(paseo())).toEqual([]);
      expect(existsSync(join(empty, "orchestrator"))).toBe(false);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});
