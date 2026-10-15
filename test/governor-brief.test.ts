import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BRIEF_MAX_CHARS, missionBriefOf } from "../plugin/server/governor-brief";
import { createGovernorStore } from "../plugin/server/governor-store";
import { createMissionStore } from "../plugin/server/mission-store";
import { createOrchestratorStore } from "../plugin/server/orchestrator-store";
import { SIGNAL_NOTICE_MARKER, dangerSignalNoticeOf, isPluginNotice, noticeMarkerOf } from "../plugin/shared/notices";

/**
 * The mission brief a governor wake opens with (missions design §20,
 * ADR-032 decision 2), the danger log (A-13) and the Main's `BM-SIGNAL`
 * (ADR-032 decision 4). A temporary data folder — never the real HOME.
 */

const MISSION = "mis-0123456789";
const NOW = new Date("2026-10-10T08:00:00.000Z");
const SECRET = "hunter2-secret-value";
let root: string;
let home: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "bm-governor-brief-"));
  home = join(root, "data");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function mission(goal = "Answer through xOne.") {
  const store = createMissionStore(home, { newId: () => MISSION, env: {}, now: () => NOW });
  const made = store.create({ code: "AIX", name: "AI Assistant ↔ xOne", goal, repos: ["wks_fe", "wks_be"], createdBy: "owner", mainId: "main-1" });
  if (!made.ok) throw new Error(made.reasons.join("; "));
  return store;
}

describe("missionBriefOf (missions design §20)", () => {
  it("renders the mission state — mission, criteria, ladder above step 0, journal — then the governor's notes (mission runtime design §2.2)", () => {
    const store = mission();
    createGovernorStore(home).put(MISSION, {
      drift: {
        step: 2,
        since: "2026-10-10T07:00:00.000Z",
        figures: [{ family: "drift", id: "finishedSinceCriterion", value: 7, threshold: 6, op: ">", crossed: true, detail: "" }],
        lastAction: null,
        mainTurnsAt: null,
      },
      mess: { step: 0, since: null, figures: [], lastAction: null, mainTurnsAt: null },
    });
    createOrchestratorStore(home, { now: () => NOW }).appendNote({ missionId: MISSION }, "The owner wants the FE first.");
    store.appendJournal(MISSION, { kind: "governor", by: "governor", text: "drift crossed: finished 7 > 6" });

    const brief = missionBriefOf(home, MISSION, {});
    const lines = brief.split("\n");
    expect(lines[0]).toMatch(new RegExp(`^Mission AIX — AI Assistant ↔ xOne \\(${MISSION}\\), open; Main main-1\\.`));
    expect(brief).toContain("Done criteria: 0 of 0 met");
    expect(brief).toMatch(/Governor:\n- drift at step 2 since 2026-10-10T07:00:00\.000Z \(.*7.*6.*\)/);
    expect(brief).not.toContain("mess at step");
    expect(brief).toContain("Waiting on the owner: none");
    expect(brief).toContain("Your notes: [2026-10-10T08:00:00.000Z] The owner wants the FE first.");
    expect(brief).toMatch(/Recently:\n.*governor governor: drift crossed: finished 7 > 6/);
  });

  it("masks secrets, bounds its parts and its length, and says so when the mission is not found", () => {
    mission(`Use ${SECRET} and ${"long words ".repeat(400)}`);
    const brief = missionBriefOf(home, MISSION, { PASEO_PASSWORD: SECRET });
    expect(brief).not.toContain(SECRET);
    expect(brief.length).toBeLessThanOrEqual(BRIEF_MAX_CHARS);
    expect(missionBriefOf(home, "mis-ffffffffff", {})).toBe("Mission mis-ffffffffff: not found in the mission store.");
  });
});

describe("the danger log (missions design §20, A-13)", () => {
  it("records one entry per alert, fills each time once, and keeps ids and times only", () => {
    const store = createOrchestratorStore(home, { now: () => NOW });
    const base = { alertKey: "danger:wks:w1", workspaceId: "wks", workerId: "w1", requestId: "req-20261010T080000Z", missionId: MISSION, raisedAt: NOW.toISOString(), mainId: "main-1" };
    store.openDanger(base);
    // A second raise of the same alert keeps the first entry.
    store.openDanger({ ...base, raisedAt: "2026-10-10T09:00:00.000Z" });
    expect(store.noteDanger("danger:wks:w1", { mainToldAt: "2026-10-10T08:00:05.000Z" })).toBe(true);
    store.noteDanger("danger:wks:w1", { mainToldAt: "2026-10-10T08:09:00.000Z", endedAt: "2026-10-10T08:02:00.000Z" });
    expect(store.noteDanger("danger:unknown", { endedAt: NOW.toISOString() })).toBe(false);
    expect(store.readDangers()).toEqual([{ ...base, mainToldAt: "2026-10-10T08:00:05.000Z", governorToldAt: null, endedAt: "2026-10-10T08:02:00.000Z" }]);
  });
});

describe("BM-SIGNAL (missions design §20, ADR-032 decision 4)", () => {
  it("is a plugin notice that tells the Main what ran and that it may stop its Worker", () => {
    const text = dangerSignalNoticeOf({ workerId: "w1", requestId: null, workspaceId: "wks", since: NOW.toISOString(), evidence: "git push: git push origin main" });
    expect(text.split("\n")[0]).toBe(`${SIGNAL_NOTICE_MARKER} danger`);
    expect(text).toContain("your Worker w1 (request not known, repo wks)");
    expect(text).toContain("stop that Worker now with cancel_agent");
    expect(text).toContain("The governor is told in 3 minutes if the Worker still runs.");
    expect(isPluginNotice(text)).toBe(true);
    expect(noticeMarkerOf(text)).toBe(SIGNAL_NOTICE_MARKER);
    // A whole word: another word that starts the same is not the notice.
    expect(isPluginNotice("BM-SIGNALS are mine")).toBe(false);
  });
});
