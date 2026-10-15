import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearBindingCache, createBindingStore } from "../plugin/server/agent-bindings";
import { clearJsonFileCache } from "../plugin/server/data-files";
import { createHandoffStore } from "../plugin/server/handoff-store";
import { replaceMain } from "../plugin/server/mission-replace";
import { clearRequestIndexCache, createMissionRoster } from "../plugin/server/mission-roster";
import { createMissionStore } from "../plugin/server/mission-store";
import { createMainSuccession, ensureMissionsHome, type MissionsPaseo } from "../plugin/server/missions-home";
import { createNoticeQueue, noticeQueue, type NoticePaseo } from "../plugin/server/notice-queue";
import { createOrchestratorDecisionDelivery } from "../plugin/server/orchestrator-decisions";
import { createOutbox, storeAndDeliver } from "../plugin/server/outbox";
import type { PaseoCliDeps } from "../plugin/server/paseo-cli";
import { proposeAnswers, proposedAnswersOf } from "../plugin/server/proposed-answers";
import { createRequestRegistry } from "../plugin/server/request-registry";
import { answerDecision, type Decision } from "../plugin/shared/decisions";
import { fakePaseo, type FakeAgent } from "./helpers/fake-paseo";
import { makeDecision } from "./helpers/decisions";

/**
 * The replacement drill of missions design §3.4 and §12 (WP-109, REQ-188,
 * M-27): a Main is replaced while an unbound Worker, a bound one, a pending
 * handoff, a pending prepared command, a notice already queued and a pending
 * outbox report wait for it — and once more through a cleared conversation.
 * Everything reaches the new Main; nothing addressed to the old one is
 * dropped. Fake Paseo, fake CLI, a private notice queue; no daemon.
 */

const MISSION = "mis-0123456789";
const HOME_WS = "wks-own";
const REPO = "wks-a";
const R1 = "req-20261009T100000Z";
const R2 = "req-20261009T100001Z";
const OLD = "main-old";
const NEW = "main-new";
const NOW = new Date("2026-10-09T10:00:00.000Z");

/** What the drill hands the home, the queue and the outbox. */
type DrillPaseo = MissionsPaseo & NoticePaseo;

let root: string;
let home: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "bm-mission-replace-"));
  home = join(root, ".paseo-bm");
  vi.stubEnv("HOME", root);
  vi.stubEnv("PASEO_BM_HOME", home);
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  noticeQueue.clear();
  clearJsonFileCache();
  clearBindingCache();
  clearRequestIndexCache();
  rmSync(root, { recursive: true, force: true });
});

const manager = (id: string, status: string): FakeAgent => ({
  id,
  workspaceId: HOME_WS,
  status,
  provider: "bm-manager",
  createdAt: "2026-10-09T09:00:00.000Z",
  labels: { "bm.role": "manager", "bm.missionId": MISSION },
});
const worker = (id: string, requestId: string): FakeAgent => ({
  id,
  workspaceId: REPO,
  status: "idle",
  provider: "bm-worker",
  createdAt: "2026-10-09T09:30:00.000Z",
  labels: { "bm.role": "worker", "bm.requestId": requestId, "paseo.parent-agent-id": OLD },
});

/** The mission, its two requests (R1 by a bound Worker, R2 by an unbound one), both addressed to `OLD`. */
function seed() {
  createMissionStore(home, { newId: () => MISSION }).create({ code: "WEB", name: "Website", goal: "", repos: [REPO], createdBy: "owner", mainId: OLD });
  const registry = createRequestRegistry(home);
  const roster = createMissionRoster(home);
  for (const [requestId, workerId] of [
    [R1, "w-bound"],
    [R2, "w-unbound"],
  ] as const) {
    registry.register(REPO, requestId, { source: "tool", managerId: OLD, workerId });
    roster.add(MISSION, { requestId, workspaceId: REPO, topic: "Export", workerId });
  }
  const bindings = createBindingStore(home);
  const issued = bindings.issue({ role: "worker", workspaceId: REPO, requestId: R1, parentId: OLD });
  bindings.attach(issued.token, "worker");
  bindings.settle(issued.tokenSha256, "w-bound");
  return { bindings, registry };
}

const report = (requestId: string) => ["BM-REPORT", `requestId: ${requestId}`, "phase: implementing", "tier: Medium"].join("\n");

/** An `o:` decision whose option `a` is a prepared command to `OLD` about R1, answered by the owner. */
function answeredCommand(): Decision {
  const decision = makeDecision({
    id: "o:drill-1",
    workspaceId: REPO,
    requestId: R1,
    askedBy: { role: "orchestrator", agentId: "orch-1" },
    question: "Go on with the export?",
    subject: null,
    options: [
      { key: "a", label: "Go on", recommended: true, effects: ["none"], action: { kind: "command", to: "manager", agentId: OLD, intent: "continue", body: "Go on with the export.", effects: ["none"] } },
      { key: "b", label: "Hold", recommended: false, effects: ["none"] },
    ],
  });
  const answered = answerDecision(decision, { via: "inbox", optionKey: "a", at: NOW.toISOString() });
  if (!answered.ok) throw new Error("the drill's decision could not be answered");
  return answered.decision;
}

describe("the replacement drill (§3.4, §12)", () => {
  it("an unbound Worker, a pending handoff, a prepared command, a queued notice and a pending report all reach the new Main", async () => {
    const { bindings, registry } = seed();
    const fake = fakePaseo<DrillPaseo>({ agents: [manager(OLD, "running"), manager(NEW, "idle"), worker("w-bound", R1), worker("w-unbound", R2)] });
    const queue = createNoticeQueue({ log: () => {} });
    const log = vi.fn();

    // What waits for the old Main, which is busy.
    const handoff = createHandoffStore(home, { newId: () => "h1" }).add({ workspaceId: REPO, requestId: R1, workerId: "w-bound", managerId: OLD, interventionId: null, reason: "Heavy." });
    expect(handoff.missionId).toBe(MISSION);
    expect(await queue.enqueue(OLD, "BM-SETTINGS", "BM-SETTINGS a notice for the Main", fake.paseo)).toBe("queued");
    const pending = await storeAndDeliver(REPO, { kind: "report", requestId: R1, from: "w-bound", to: OLD, text: report(R1) }, { home, queue, paseo: fake.paseo, log });
    expect(pending.outcome).toBe("queued");
    proposeAnswers(OLD, "2026-10-09T09:59:00.000Z", { workspaceId: REPO, requestId: R1, answers: [] } as never);

    const labels: Array<[string, string, string]> = [];
    const titles: Array<[string, string]> = [];
    const result = await replaceMain(MISSION, NEW, "owner", {
      home,
      paseo: fake.paseo,
      queue,
      bindings,
      log,
      setLabel: async (...args) => (labels.push(args), { ok: true }),
      setTitle: async (...args) => (titles.push(args), { ok: true }),
    });

    expect(result).toMatchObject({ ok: true, replaced: OLD, requests: 2, moved: 2, redelivered: 1 });
    // 1. The mission names the successor.
    expect(createMissionStore(home).get(MISSION)).toMatchObject({ mainId: NEW });
    expect(createMissionStore(home).get(MISSION)!.mainHistory.map((entry) => [entry.agentId, entry.reason])).toEqual([
      [OLD, "created"],
      [NEW, "owner"],
    ]);
    // 2. The open requests.
    expect([registry.get(REPO, R1)?.managerId, registry.get(REPO, R2)?.managerId]).toEqual([NEW, NEW]);
    // 3. The bound Worker's binding; no Worker is told (mission runtime design §3.4).
    expect(bindings.bindingOfAgent("w-bound")?.parentId).toBe(NEW);
    expect(fake.sends.filter((send) => send.id.startsWith("w-"))).toEqual([]);
    // 4. and 5. The parent labels, and the old Main marked (never archived).
    expect(labels).toEqual([
      ["w-bound", "paseo.parent-agent-id", NEW],
      ["w-unbound", "paseo.parent-agent-id", NEW],
      [OLD, "bm.replacedBy", NEW],
    ]);
    // The old Main's title no longer reads as the mission's Main.
    expect(titles).toEqual([[OLD, "🟣 M · WEB Website · replaced"]]);
    expect(fake.archives).toEqual([]);
    // The old Main's proposals are dropped; its queue moved.
    expect(proposedAnswersOf(OLD, "2026-10-09T09:59:00.000Z")).toEqual([]);
    expect(queue.pending(OLD)).toEqual([]);
    // The new Main was idle: it got the queued notice at once; the report waits for its next idle moment.
    expect(fake.sends.filter((send) => send.id === NEW).map((send) => send.text)).toEqual(["BM-SETTINGS a notice for the Main"]);
    // On the new Main's channel (mission runtime design §6.2).
    expect(queue.pending(NEW).map((entry) => entry.kind)).toEqual([`BM-UPDATES:report:${pending.record.id}`]);
    expect(createOutbox(home).list(REPO)[0]).toMatchObject({ to: NEW, state: "pending" });
    fake.byId(NEW)!.status = "idle";
    await queue.turnEnded({ agent: { id: NEW } }, fake.paseo);
    expect(fake.sends.filter((send) => send.id === NEW).at(-1)?.text).toContain(`BM-DELIVERY report ${pending.record.id}`);
    expect(createOutbox(home).list(REPO)[0]).toMatchObject({ to: NEW, state: "delivered" });

    // The pending handoff's Manager is the new Main.
    expect(createHandoffStore(home).get("h1")).toMatchObject({ managerId: NEW, missionId: MISSION });
    // The unbound Worker's report, still addressed by its label's old parent, goes to the new Main.
    const late = await storeAndDeliver(REPO, { kind: "report", requestId: R2, from: "w-unbound", to: OLD, text: report(R2) }, { home, queue, paseo: fake.paseo, log });
    expect(late.record.to).toBe(OLD);
    expect(createOutbox(home).list(REPO).find((record) => record.id === late.record.id)).toMatchObject({ to: NEW });
    // The prepared command the owner chooses now goes to the new Main.
    fake.byId(NEW)!.status = "running";
    await createOrchestratorDecisionDelivery({ home: () => home, now: () => NOW, queue, log })([answeredCommand()], { paseo: fake.paseo });
    expect(queue.pending(NEW).map((entry) => entry.kind)).toContain("BM-UPDATES:command:o:drill-1");
    expect(queue.pending(OLD)).toEqual([]);
    expect(createOutbox(home).list(REPO).filter((record) => record.state === "dropped")).toEqual([]);
  });

  it("a cleared conversation: a report the archived Main could not take waits, and its successor gets it", async () => {
    const { bindings, registry } = seed();
    const fake = fakePaseo<DrillPaseo>({ agents: [manager(OLD, "idle"), worker("w-bound", R1)] });
    await ensureMissionsHome(fake.paseo, { home });
    // The successor's binding, as the creation hook binds a composer Manager.
    const issued = bindings.issue({ role: "manager", workspaceId: HOME_WS, origin: "hook" });
    bindings.attach(issued.token, "manager");
    bindings.settle(issued.tokenSha256, "new-1");
    const calls: string[][] = [];
    const cli: PaseoCliDeps = { find: () => "/bin/paseo", run: async (_file, args) => (calls.push(args), { code: 0, output: "", timedOut: false }) };
    const succession = createMainSuccession({ home, now: () => NOW, cli, bindings: () => bindings, log: () => {} });

    // Clearing archives the Main; a report sent then is not dropped: it waits for the mission's next Main.
    fake.byId(OLD)!.archivedAt = "2026-10-09T09:59:00.000Z";
    const held = await storeAndDeliver(REPO, { kind: "report", requestId: R1, from: "w-bound", to: OLD, text: report(R1) }, { home, paseo: fake.paseo, log: () => {} });
    expect(held.outcome).toBe("queued");
    expect(createOutbox(home).list(REPO)[0]).toMatchObject({ to: OLD, state: "pending" });
    expect(await succession.mainArchived(OLD)).toBeNull();

    fake.agents.push({ id: "new-1", workspaceId: HOME_WS, status: "idle", provider: "bm-manager", createdAt: "2026-10-09T10:00:00.000Z", labels: {} });
    expect(await succession.agentCreated({ id: "new-1", provider: "bm-manager", workspaceId: HOME_WS }, fake.paseo)).toBe(MISSION);

    expect(createMissionStore(home).get(MISSION)).toMatchObject({ mainId: "new-1" });
    expect(registry.get(REPO, R1)?.managerId).toBe("new-1");
    expect(bindings.bindingOfAgent("w-bound")?.parentId).toBe("new-1");
    expect(createOutbox(home).list(REPO)[0]).toMatchObject({ to: "new-1", state: "delivered" });
    expect(fake.sends.filter((send) => send.id === "new-1").map((send) => send.text.split("\n")[0])).toEqual([`BM-DELIVERY report ${held.record.id}`]);
    expect(fake.sends.find((send) => send.id === "w-bound")).toBeUndefined();
    expect(calls).toContainEqual(["agent", "update", "w-bound", "--label", "paseo.parent-agent-id=new-1", "--json"]);
    // The archived Main is not marked: it is not live.
    expect(calls.some((args) => args[2] === OLD)).toBe(false);
  });

  it("retitles the old Main only once its labels say bm.replacedBy: a refused label, or an archived Main, keeps its title", async () => {
    seed();
    const fake = fakePaseo<DrillPaseo>({ agents: [manager(OLD, "idle"), manager(NEW, "idle")] });
    const titles: string[] = [];
    const logs: string[] = [];
    const setTitle = async (agentId: string, title: string) => (titles.push(`${agentId} ${title}`), { ok: true as const });
    await replaceMain(MISSION, NEW, "owner", {
      home,
      paseo: fake.paseo,
      queue: createNoticeQueue({ log: () => {} }),
      setLabel: async (_agentId, key) => (key === "bm.replacedBy" ? { ok: false, reason: "refused" } : { ok: true }),
      setTitle,
      log: (line) => logs.push(line),
    });
    expect(titles).toEqual([]);
    expect(logs.some((line) => line.includes("could not be marked as replaced"))).toBe(true);

    // Already labelled by an earlier pass: the label's refusal does not stop the title.
    fake.byId(NEW)!.labels = { ...fake.byId(NEW)!.labels, "bm.replacedBy": "main-third" };
    fake.agents.push(manager("main-third", "idle"));
    await replaceMain(MISSION, "main-third", "owner", {
      home,
      paseo: fake.paseo,
      queue: createNoticeQueue({ log: () => {} }),
      setLabel: async () => ({ ok: false, reason: "refused" }),
      setTitle,
      log: () => {},
    });
    expect(titles).toEqual([`${NEW} 🟣 M · WEB Website · replaced`]);

    // An archived Main is never marked, so never retitled.
    fake.byId("main-third")!.archivedAt = "2026-10-09T10:01:00.000Z";
    fake.agents.push(manager("main-fourth", "idle"));
    await replaceMain(MISSION, "main-fourth", "owner", { home, paseo: fake.paseo, queue: createNoticeQueue({ log: () => {} }), setLabel: async () => ({ ok: true }), setTitle, log: () => {} });
    expect(titles).toHaveLength(1);
  });

  it("never replaces a Main with itself: the current Main named as the one replaced is no earlier Main", async () => {
    seed();
    const fake = fakePaseo<DrillPaseo>({ agents: [manager(OLD, "idle")] });
    const labels: string[] = [];
    const result = await replaceMain(MISSION, OLD, "replaced", {
      home,
      paseo: fake.paseo,
      replaced: OLD,
      setLabel: async (agentId, key, value) => {
        labels.push(`${agentId} ${key}=${value}`);
        return { ok: true };
      },
      log: () => {},
    });
    expect(result.ok).toBe(true);
    expect(labels.filter((line) => line.includes("bm.replacedBy"))).toEqual([]);
    expect(createMissionStore(home).get(MISSION)!.mainId).toBe(OLD);
  });

  it("a report to the archived Main of a closed mission is dropped, as before", async () => {
    seed();
    createMissionStore(home).update(MISSION, (mission) => ({ ...mission, state: "closed", closedAt: NOW.toISOString() }));
    const fake = fakePaseo<DrillPaseo>({ agents: [manager(OLD, "idle")] });
    fake.byId(OLD)!.archivedAt = "2026-10-09T09:59:00.000Z";
    const queue = createNoticeQueue({ log: () => {} });
    const dropped = await storeAndDeliver(REPO, { kind: "report", requestId: R1, from: "w-bound", to: OLD, text: report(R1) }, { home, queue, paseo: fake.paseo, log: () => {} });
    expect(dropped.outcome).toBe("dropped");
    expect(createOutbox(home).list(REPO)[0]).toMatchObject({ state: "dropped" });
  });
});
