import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearBindingCache } from "../plugin/server/agent-bindings";
import { clearJsonFileCache } from "../plugin/server/data-files";
import { handleDecisionsAnswer } from "../plugin/server/decision-rpc";
import { clearDecisionStoreCache } from "../plugin/server/decision-store";
import { createMissionDecisionStore } from "../plugin/server/mission-decisions";
import { isLegacyMission, offerMerges, offerTransfer } from "../plugin/server/mission-ownership";
import { clearRequestIndexCache, createMissionRoster, requestIndexOf } from "../plugin/server/mission-roster";
import { createMissionStore } from "../plugin/server/mission-store";
import { clearRequestRegistryCache, createRequestRegistry } from "../plugin/server/request-registry";
import { dataFolder, removeDataFolders } from "./helpers/data-folder";
import { fakeCli } from "./helpers/fake-cli";
import { fakePaseo, type FakeAgent } from "./helpers/fake-paseo";

/**
 * One owner per request (mission runtime design §5.2, §5.3): the owner's merge
 * card for a legacy one-repo mission and the transfer card a Main asks, both
 * applied through the one transfer function. The XAI case: an owner's
 * mission over the repos of the legacy missions AIAS and XSPA. A fake Paseo
 * and a temporary data folder only.
 */

const XAI = "mis-00000000a1";
const AIAS = "mis-00000000b2";
const XSPA = "mis-00000000c3";
const OTHER = "mis-00000000d4";
const R1 = "req-20261010T100000Z";
const R2 = "req-20261010T100001Z";
const HOME_WS = "wks_home";
const NOW = new Date("2026-10-10T12:00:00.000Z");
let home: string;

const worker = (id: string, workspaceId: string, status: string): FakeAgent => ({ id, provider: "bm-worker", workspaceId, status, labels: { "bm.role": "worker" } });

beforeEach(() => {
  home = dataFolder("bm-ownership-");
  clearRequestIndexCache();
  clearRequestRegistryCache();
  clearDecisionStoreCache();
  mkdirSync(join(home, "ui"), { recursive: true });
  writeFileSync(join(home, "ui", "missions-home.json"), JSON.stringify({ schemaVersion: 1, workspaceId: HOME_WS, directory: join(home, "missions", "home") }));
  const ids = [XAI, AIAS, XSPA, OTHER];
  const store = createMissionStore(home, { now: () => NOW, newId: () => ids.shift()!, env: {} });
  expect(store.create({ code: "XAI", name: "XAI", goal: "Ship XAI.", repos: ["repo-a", "repo-b"], createdBy: "owner", mainId: "main-x" }).ok).toBe(true);
  expect(store.create({ code: "AIAS", name: "aias", goal: "", repos: ["repo-a"], createdBy: "legacy", legacyWorkspaceId: "repo-a", mainId: "main-a" }).ok).toBe(true);
  expect(store.create({ code: "XSPA", name: "xspa", goal: "", repos: ["repo-b"], createdBy: "legacy", legacyWorkspaceId: "repo-b", mainId: "main-b" }).ok).toBe(true);
  expect(store.create({ code: "WEB", name: "Web", goal: "The website.", repos: ["repo-c"], createdBy: "owner", mainId: "main-w" }).ok).toBe(true);
  const roster = createMissionRoster(home, { now: () => NOW, env: {} });
  const registry = createRequestRegistry(home, { backfill: () => [] });
  roster.add(AIAS, { requestId: R1, workspaceId: "repo-a", topic: "old aias work", workerId: "w-1" });
  registry.register("repo-a", R1, { source: "tool", managerId: "main-a", workerId: "w-1" });
  roster.add(XAI, { requestId: R2, workspaceId: "repo-b", topic: "xai work", workerId: "w-2" });
  registry.register("repo-b", R2, { source: "tool", managerId: "main-x", workerId: "w-2" });
});

afterEach(() => {
  clearRequestIndexCache();
  clearRequestRegistryCache();
  clearDecisionStoreCache();
  clearBindingCache();
  clearJsonFileCache();
  removeDataFolders();
});

const log = () => {};
const cardsOf = (missionId: string) => createMissionDecisionStore(home).list(missionId);

describe("the merge card (design §5.2)", () => {
  it("XAI over the repos of AIAS and XSPA is offered two cards, once; a mission holding no legacy repo and a legacy one are offered none", () => {
    expect(isLegacyMission(createMissionStore(home).get(AIAS)!)).toBe(true);
    expect(offerMerges(home, XAI, { now: NOW, log })).toEqual([`m:${XAI}:1`, `m:${XAI}:2`]);
    expect(cardsOf(XAI).map((card) => [card.options[0]!.action, card.question.split("\n")[0]])).toEqual([
      [{ kind: "mission-merge", missionId: XAI, from: AIAS }, "Merge mission AIAS (repo-a) into XAI"],
      [{ kind: "mission-merge", missionId: XAI, from: XSPA }, "Merge mission XSPA (repo-b) into XAI"],
    ]);
    expect(offerMerges(home, XAI, { now: NOW, log })).toEqual([]);
    expect(offerMerges(home, OTHER, { now: NOW, log })).toEqual([]);
    expect(offerMerges(home, AIAS, { now: NOW, log })).toEqual([]);
  });

  it("applying it moves the legacy mission's requests, closes it merged, and marks its Main without archiving it", async () => {
    offerMerges(home, XAI, { now: NOW, log });
    const { paseo } = fakePaseo({ agents: [worker("w-1", "repo-a", "idle")] });
    const { cli, calls } = fakeCli();
    await handleDecisionsAnswer({ id: `m:${XAI}:1`, optionKey: "apply" }, paseo, { home, now: () => NOW, cli, log });
    expect(createMissionRoster(home).list(AIAS)).toEqual([]);
    expect(createMissionRoster(home).list(XAI).map((entry) => entry.requestId)).toEqual([R2, R1]);
    expect(requestIndexOf(home, R1)).toMatchObject({ missionId: XAI });
    expect(createRequestRegistry(home).get("repo-a", R1)).toMatchObject({ managerId: "main-x", missionId: XAI });
    expect(createMissionStore(home).get(AIAS)).toMatchObject({ state: "closed", closedAt: NOW.toISOString(), mergedInto: XAI });
    expect(calls).toContainEqual(["agent", "update", "main-a", "--label", "bm.replacedBy=main-x", "--json"]);
    expect(calls.some((call) => call.includes("--name") && call.some((part) => part.endsWith("· merged into XAI")))).toBe(true);
    expect(calls.some((call) => call.includes("archive"))).toBe(false);
    expect(createMissionStore(home).journal(XAI).map((line) => line.text)).toContain(`Mission AIAS merged in (m:${XAI}:1): ${R1}.`);
    // The other card still waits.
    expect(createMissionDecisionStore(home).get(`m:${XAI}:2`)?.status).toBe("open");
  });

  it("is refused while a Worker of the legacy mission runs a turn; keep as is moves nothing and is not asked again", async () => {
    offerMerges(home, XAI, { now: NOW, log });
    const busy = fakePaseo({ agents: [worker("w-1", "repo-a", "running")] });
    await expect(handleDecisionsAnswer({ id: `m:${XAI}:1`, optionKey: "apply" }, busy.paseo, { home, now: () => NOW, cli: fakeCli().cli, log })).rejects.toMatchObject({
      code: "E_MISSION_INVALID",
      message: expect.stringContaining(`a Worker of mission AIAS is running a turn (${R1})`),
    });
    expect(createMissionStore(home).get(AIAS)?.state).toBe("open");
    await handleDecisionsAnswer({ id: `m:${XAI}:1`, optionKey: "keep" }, busy.paseo, { home, now: () => NOW, cli: fakeCli().cli, log });
    expect(createMissionRoster(home).list(AIAS).map((entry) => entry.requestId)).toEqual([R1]);
    expect(createMissionStore(home).journal(XAI).at(-1)?.text).toBe(`The owner kept things as they are (m:${XAI}:1).`);
    expect(offerMerges(home, XAI, { now: NOW, log })).toEqual([]);
  });
});

describe("the transfer card (design §5.3)", () => {
  it("opens one card on the source mission; the owner's tap moves the requests; the same move twice is refused", async () => {
    const source = createMissionStore(home).get(AIAS)!;
    const offered = offerTransfer(home, source, { to: XAI, requestIds: [R1], reason: "XAI owns this work" }, { now: NOW, log, askedBy: "main-a" });
    expect(offered).toEqual({ ok: true, decisionId: `m:${AIAS}:1` });
    expect(offerTransfer(home, source, { to: XAI, requestIds: [R1], reason: "again" }, { now: NOW, log, askedBy: "main-a" })).toEqual({ ok: false, reasons: [`the owner's card m:${AIAS}:1 asks this move already`] });
    expect(offerTransfer(home, source, { to: XAI, requestIds: [R2], reason: "not ours" }, { now: NOW, log, askedBy: "main-a" })).toEqual({ ok: false, reasons: [`not on mission AIAS's roster: ${R2}`] });
    const { paseo } = fakePaseo({ agents: [] });
    await handleDecisionsAnswer({ id: `m:${AIAS}:1`, optionKey: "apply" }, paseo, { home, now: () => NOW, cli: fakeCli().cli, log });
    expect(createMissionRoster(home).list(XAI).map((entry) => entry.requestId)).toEqual([R2, R1]);
    expect(createRequestRegistry(home).get("repo-a", R1)).toMatchObject({ managerId: "main-x", missionId: XAI });
    expect(createMissionStore(home).journal(AIAS).at(-1)?.text).toBe(`request ${R1} moved to mission XAI: XAI owns this work`);
    // The legacy mission stays open: only a merge closes it.
    expect(createMissionStore(home).get(AIAS)?.state).toBe("open");
  });
});
