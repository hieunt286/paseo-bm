import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearRequestIndexCache, createMissionRoster, noteFollowUp, noteRosterReport, reportSummaryOf } from "../plugin/server/mission-roster";
import { createMissionStore } from "../plugin/server/mission-store";
import { createPeerLinkStore } from "../plugin/server/peer-links";

/**
 * The writes that make the mission state complete (mission runtime design
 * §2.3, ADR-033 decision 1): a link's events in the journals of the missions
 * it concerns, a follow-up, a report's phase. A temporary data folder.
 */

const ASKER = "mis-000000000a";
const ANSWERER = "mis-000000000b";
const REQ_A = "req-20261010T033304Z";
const REQ_B = "req-20261010T034200Z";
const NOW = new Date("2026-10-10T05:00:00.000Z");
let root: string;
let home: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "bm-mission-events-"));
  home = join(root, "data");
  clearRequestIndexCache();
  for (const [missionId, code, repo, main] of [[ASKER, "XAI", "wks_front", "main-a"], [ANSWERER, "SHL", "wks_shell", "main-b"]] as const) {
    const made = createMissionStore(home, { newId: () => missionId, env: {} }).create({ code, name: code, goal: "g", repos: [repo], createdBy: "owner", mainId: main });
    if (!made.ok) throw new Error(made.reasons.join("; "));
  }
  createMissionRoster(home).add(ASKER, { requestId: REQ_A, workspaceId: "wks_front", topic: "G14", workerId: "w-front" });
  createMissionRoster(home).add(ANSWERER, { requestId: REQ_B, workspaceId: "wks_shell", topic: "remote", workerId: "w-shell" });
});

afterEach(() => {
  clearRequestIndexCache();
  rmSync(root, { recursive: true, force: true });
});

const linesOf = (missionId: string, kind?: string) => createMissionStore(home).journal(missionId, 50).filter((line) => kind === undefined || line.kind === kind).map((line) => line.text);

describe("a link's events are each mission's history (design §2.3)", () => {
  it("asked, taken, answered and closed are journaled once per mission concerned; an unchanged take writes nothing", () => {
    const links = createPeerLinkStore(home, { newId: () => "peer-000000000001", now: () => NOW });
    const asked = links.createLink({ kind: "work", from: { workspaceId: "wks_front", requestId: REQ_A, agentId: "w-front", role: "worker" }, to: { workspaceId: "wks_shell", managerId: "main-b" }, text: "Register the ai-assistant remote" });
    expect(asked.ok).toBe(true);
    expect(linesOf(ASKER, "link")).toEqual(["Link peer-000000000001 asked wks_shell (work): Register the ai-assistant remote"]);
    expect(linesOf(ANSWERER, "link")).toEqual(["Link peer-000000000001 from wks_front (req-20261010T033304Z) asks (work): Register the ai-assistant remote"]);

    links.takeLink("peer-000000000001", { workspaceId: "wks_shell", requestId: REQ_B, workerId: "w-shell", managerId: "main-b" });
    links.takeLink("peer-000000000001", { workspaceId: "wks_shell", requestId: REQ_B, workerId: "w-shell" });
    links.markAnswered("peer-000000000001");
    links.closeLink("peer-000000000001", "asker");
    const taken = `Link peer-000000000001 taken by ${REQ_B} (Worker w-shell)`;
    expect(linesOf(ASKER, "link").slice(1)).toEqual([taken, "Link peer-000000000001 answered", "Link peer-000000000001 closed by the asker"]);
    expect(linesOf(ANSWERER, "link").slice(1)).toEqual([taken, "Link peer-000000000001 answered", "Link peer-000000000001 closed by the asker"]);
  });

  it("a Main's ask of another mission is journaled on both, by the asking Main and the mission addressed", () => {
    createPeerLinkStore(home, { newId: () => "peer-000000000002", now: () => NOW }).createLink({
      kind: "work",
      route: "mission",
      missionId: ANSWERER,
      from: { workspaceId: "wks_home", requestId: null, agentId: "main-a", role: "manager" },
      to: { workspaceId: "wks_home", managerId: "main-b" },
      text: "Take XSPA's remaining work",
    });
    expect(linesOf(ASKER, "link")).toHaveLength(1);
    expect(linesOf(ANSWERER, "link")).toHaveLength(1);
  });

  it("a store given its own sink tells it instead, and a refused change tells nothing", () => {
    const told: string[] = [];
    const links = createPeerLinkStore(home, { newId: () => "peer-000000000003", now: () => NOW, onEvent: (event, link) => told.push(`${event} ${link.linkId}`) });
    links.createLink({ kind: "question", from: { workspaceId: "wks_front", requestId: REQ_A, agentId: "w-front", role: "worker" }, to: { workspaceId: "wks_shell", managerId: null }, text: "?" });
    expect(links.markAnswered("peer-000000000003").ok).toBe(false);
    expect(told).toEqual(["asked peer-000000000003"]);
    expect(linesOf(ASKER, "link")).toEqual([]);
  });
});

describe("follow-ups and report phases (design §2.3)", () => {
  it("a follow-up reopens the request with its time and a journal line; a blocked, finished or stopped report is a line, others are not", () => {
    noteRosterReport(home, REQ_A, "finished", () => {}, "BM-REPORT\nphase: finished\ntier: Small (changed: no) — pushed and opened MR !1");
    expect(createMissionRoster(home).get(ASKER, REQ_A)?.state).toBe("finished");
    noteFollowUp(home, REQ_A, "Lời owner: làm tiếp phần XSPA\nchi tiết", NOW.toISOString());
    expect(createMissionRoster(home).get(ASKER, REQ_A)).toMatchObject({ state: "active", followUpAt: NOW.toISOString() });
    noteRosterReport(home, REQ_A, "received", () => {}, "BM-REPORT\nphase: received");
    noteRosterReport(home, REQ_A, "blocked", () => {}, "BM-REPORT\nphase: blocked\ntier: Medium\nblockers: waiting on the owner: Q2, Q3.");
    expect(linesOf(ASKER, "worker")).toEqual([
      `${REQ_A} finished: pushed and opened MR !1`,
      `Follow-up to ${REQ_A}: Lời owner: làm tiếp phần XSPA`,
      `${REQ_A} blocked: waiting on the owner: Q2, Q3.`,
    ]);
    // A request of no mission is left alone.
    noteFollowUp(home, "req-20261010T999999Z", "x", NOW.toISOString());
  });

  it("reportSummaryOf reads the tier line's summary, else the blockers", () => {
    expect(reportSummaryOf("tier: Small — did it")).toBe("did it");
    expect(reportSummaryOf("tier: Small\nblockers: none")).toBe("");
    expect(reportSummaryOf("blockers: waiting for: X")).toBe("waiting for: X");
  });
});
