import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearBindingCache, createBindingStore } from "../plugin/server/agent-bindings";
import { clearJsonFileCache } from "../plugin/server/data-files";
import { clearRequestIndexCache, createMissionRoster, requestIndexOf } from "../plugin/server/mission-roster";
import { createMissionStore } from "../plugin/server/mission-store";
import { transferRefusalsOf, transferRequests, type TransferDeps } from "../plugin/server/mission-transfer";
import { createOutbox } from "../plugin/server/outbox";
import type { PaseoCliDeps } from "../plugin/server/paseo-cli";
import { clearRequestRegistryCache, createRequestRegistry } from "../plugin/server/request-registry";
import { dataFolder, removeDataFolders } from "./helpers/data-folder";
import { fakePaseo } from "./helpers/fake-paseo";

/**
 * One transfer function (mission runtime design §5.1, ADR-033 decision 4):
 * the roster, the registry and the Workers move together; both missions
 * journal it and both Mains are told. A fake Paseo and a temporary data
 * folder only.
 */

const A = "mis-00000000a1";
const B = "mis-00000000b2";
const C = "mis-00000000c3";
const RA = "req-20261010T100000Z";
const RA2 = "req-20261010T100002Z";
const HOME_WS = "wks_home";
const NOW = new Date("2026-10-10T12:00:00.000Z");
let home: string;
let cliCalls: string[][];
let deps: TransferDeps;

beforeEach(() => {
  home = dataFolder("bm-transfer-");
  clearRequestIndexCache();
  clearRequestRegistryCache();
  mkdirSync(join(home, "ui"), { recursive: true });
  writeFileSync(join(home, "ui", "missions-home.json"), JSON.stringify({ schemaVersion: 1, workspaceId: HOME_WS, directory: join(home, "missions", "home") }));
  const ids = [A, B, C];
  const store = createMissionStore(home, { now: () => NOW, newId: () => ids.shift()!, env: {} });
  expect(store.create({ code: "AIAS", name: "", goal: "", repos: ["repo-a"], createdBy: "legacy", mainId: "main-a" }).ok).toBe(true);
  expect(store.create({ code: "XAI", name: "XAI", goal: "Ship XAI.", repos: ["repo-a", "repo-b"], createdBy: "owner", mainId: "main-x" }).ok).toBe(true);
  expect(store.create({ code: "NEW", name: "New", goal: "g", repos: ["repo-a"], createdBy: "orchestrator", mainId: null }).ok).toBe(true);
  const roster = createMissionRoster(home, { now: () => NOW, env: {} });
  const registry = createRequestRegistry(home, { backfill: () => [] });
  const bindings = createBindingStore(home);
  for (const [requestId, workerId] of [
    [RA, "w-a"],
    [RA2, "w-a2"],
  ] as const) {
    roster.add(A, { requestId, workspaceId: "repo-a", topic: requestId, workerId });
    registry.register("repo-a", requestId, { source: "tool", managerId: "main-a", workerId });
    const issued = bindings.issue({ role: "worker", workspaceId: "repo-a", requestId, parentId: "main-a", missionId: A });
    bindings.attach(issued.token, "worker");
    bindings.settle(issued.tokenSha256, workerId);
  }
  cliCalls = [];
  const cli: PaseoCliDeps = { find: () => "/bin/paseo", run: async (_file, args) => (cliCalls.push(args), { code: 0, output: "", timedOut: false }) };
  const { paseo } = fakePaseo({
    agents: [
      { id: "w-a", provider: "bm-worker", status: "idle", workspaceId: "repo-a", labels: { "bm.role": "worker", "paseo.parent-agent-id": "main-a", "bm.requestId": RA } },
      { id: "w-a2", provider: "bm-worker", status: "idle", workspaceId: "repo-a", labels: { "bm.role": "worker", "paseo.parent-agent-id": "main-a", "bm.requestId": RA2 } },
    ],
  });
  deps = { home, now: NOW, paseo, log: () => {}, cli };
});

afterEach(() => {
  clearRequestIndexCache();
  clearRequestRegistryCache();
  clearBindingCache();
  clearJsonFileCache();
  removeDataFolders();
});

describe("transferRequests (design §5.1)", () => {
  it("moves the roster entry, the registry entry and the Worker together, journals both missions and tells both Mains", async () => {
    const done = await transferRequests({ from: A, to: B, requestIds: [RA], reason: "XAI owns repo-a now", by: "owner", ref: `m:${B}:1` }, deps);
    expect(done).toEqual({ ok: true, moved: [RA], workers: ["w-a"] });
    expect(createMissionRoster(home).list(A).map((entry) => entry.requestId)).toEqual([RA2]);
    expect(createMissionRoster(home).list(B).map((entry) => entry.requestId)).toEqual([RA]);
    expect(requestIndexOf(home, RA)).toMatchObject({ missionId: B });
    expect(createRequestRegistry(home).get("repo-a", RA)).toMatchObject({ managerId: "main-x", missionId: B });
    expect(createRequestRegistry(home).get("repo-a", RA2)).toMatchObject({ managerId: "main-a" });
    expect(createBindingStore(home).list().find((binding) => binding.agentId === "w-a")).toMatchObject({ parentId: "main-x", missionId: B });
    expect(cliCalls).toContainEqual(["agent", "update", "w-a", "--label", "paseo.parent-agent-id=main-x", "--json"]);
    expect(createMissionStore(home).journal(A).at(-1)).toMatchObject({ kind: "charter", by: "owner", text: `request ${RA} moved to mission XAI: XAI owns repo-a now` });
    expect(createMissionStore(home).journal(B).at(-1)).toMatchObject({ kind: "charter", by: "owner", text: `request ${RA} moved here from mission AIAS: XAI owns repo-a now` });
    const told = createOutbox(home).list(HOME_WS).filter((record) => record.kind === "message");
    expect(told.map((record) => [record.to, record.text.split("\n")[0]])).toEqual([
      ["main-a", `request ${RA} and their Workers moved to mission XAI (Main main-x): XAI owns repo-a now. Plan without them; ask that mission with bm_ask_mission.`],
      ["main-x", `request ${RA} and their Workers moved here from mission AIAS: XAI owns repo-a now. They report to you now.`],
    ]);
  });

  it("to a mission with no Main yet: the registry's mission and the bindings' mission only, nothing told when asked", async () => {
    const done = await transferRequests({ from: A, to: C, requestIds: [RA2], reason: "split", by: "orchestrator", ref: A, journal: false, tell: false }, deps);
    expect(done).toEqual({ ok: true, moved: [RA2], workers: ["w-a2"] });
    expect(createRequestRegistry(home).get("repo-a", RA2)).toMatchObject({ managerId: "main-a", missionId: C });
    expect(createBindingStore(home).list().find((binding) => binding.agentId === "w-a2")).toMatchObject({ parentId: "main-a", missionId: C });
    expect(cliCalls).toEqual([]);
    expect(createOutbox(home).list(HOME_WS)).toEqual([]);
    expect(createMissionStore(home).journal(C)).toEqual([]);
  });

  it("refuses, writing nothing: the same mission, an unknown or closed one, no request, a request off the source roster", async () => {
    expect(transferRefusalsOf(home, { from: A, to: A, requestIds: [RA] })).toEqual(["the source and the target are the same mission"]);
    expect(transferRefusalsOf(home, { from: A, to: "mis-0000000099", requestIds: [RA] })).toEqual(["the target mission mis-0000000099 does not exist"]);
    expect(transferRefusalsOf(home, { from: A, to: B, requestIds: [] })).toEqual(["no request is named"]);
    expect(transferRefusalsOf(home, { from: B, to: A, requestIds: [RA] })).toEqual([`not on mission XAI's roster: ${RA}`]);
    createMissionStore(home).update(B, (mission) => ({ ...mission, state: "closed", closedAt: NOW.toISOString() }));
    const refused = await transferRequests({ from: A, to: B, requestIds: [RA], reason: "r", by: "owner", ref: "x" }, deps);
    expect(refused).toEqual({ ok: false, reasons: ["the target mission XAI is closed"] });
    expect(createMissionRoster(home).list(A).map((entry) => entry.requestId)).toEqual([RA, RA2]);
  });
});
