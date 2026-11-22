import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AGENT_CLEANUP_INTERVAL_MS, MAX_ARCHIVES_PER_PASS, archivedNotesOf, createAgentCleanup, finishedAgentsOf, type AgentCleanup } from "../plugin/server/agent-cleanup";
import { BINDINGS_FILE, createBindingStore } from "../plugin/server/agent-bindings";
import { resetRoleDisagreementLog } from "../plugin/server/agent-role";
import { COORDINATION_DIR_NAME, COORDINATION_SETTINGS_FILE, createCoordinationStore } from "../plugin/server/coordination-store";
import { UI_DIR_NAME } from "../plugin/server/data-home";
import { clearJsonFileCache } from "../plugin/server/data-files";
import { clearDecisionStoreCache, createDecisionStore } from "../plugin/server/decision-store";
import { clearRequestIndexCache, createMissionRoster } from "../plugin/server/mission-roster";
import { MAX_JOURNAL_TEXT, createMissionStore } from "../plugin/server/mission-store";
import { createOutbox } from "../plugin/server/outbox";
import { PEERS_DIR_NAME, PEER_LINKS_FILE_NAME, createPeerLinkStore } from "../plugin/server/peer-links";
import { clearRequestRegistryCache, createRequestRegistry } from "../plugin/server/request-registry";
import { bindAgent } from "./helpers/bindings";
import { dataFolder, removeDataFolders } from "./helpers/data-folder";
import { makeDecision } from "./helpers/decisions";
import { fakePaseo, type FakeAgent } from "./helpers/fake-paseo";

/**
 * Finished sub-agents are archived (ADR-049, delivery line design §20): which
 * Workers and Reviewers the pass archives, what keeps one, the owner's switch
 * and window, the hourly stamp, the cap, the journal and a failing archive.
 * Temporary data folders and the shared fake Paseo only; never a daemon.
 */

const NOW = new Date("2026-11-16T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const ago = (days: number): string => new Date(NOW.getTime() - days * DAY).toISOString();
const REPO = "wks_shop";
const OTHER = "wks_pay";

afterEach(() => {
  resetRoleDisagreementLog();
  clearRequestRegistryCache();
  clearRequestIndexCache();
  clearDecisionStoreCache();
  clearJsonFileCache();
  removeDataFolders();
});

type Role = "worker" | "reviewer" | "manager" | "orchestrator";

function world() {
  const home = dataFolder("bm-cleanup-");
  const missions = createMissionStore(home, { now: () => NOW });
  const mission = (code: string, repo: string) => {
    const made = missions.create({ code, name: code, goal: "Ship it.", repos: [repo], createdBy: "owner", mainId: `main-${code}` });
    if (!made.ok) throw new Error(made.reasons.join("; "));
    return made.mission.missionId;
  };
  const shop = mission("SHOP", REPO);
  let second = 0;
  const registry = createRequestRegistry(home, { log: () => {}, now: () => new Date(Date.UTC(2026, 10, 1) + (second += 1) * 1000) });
  const roster = createMissionRoster(home);
  /** A request as this build registers it: in its mission's roster when it has one, finished unless told otherwise. */
  const request = (options: { missionId?: string | null; workspaceId?: string; finished?: boolean; continues?: string } = {}) => {
    const workspaceId = options.workspaceId ?? REPO;
    const missionId = options.missionId === undefined ? shop : options.missionId;
    const { requestId } = registry.generate(workspaceId, {
      managerId: "main-1",
      ...(missionId === null ? {} : { missionId }),
      ...(options.continues === undefined ? {} : { continuationOf: options.continues }),
    });
    if (missionId !== null) roster.add(missionId, { requestId, workspaceId, topic: `work of ${requestId}`, workerId: `w-${requestId}`, ...(options.continues === undefined ? {} : { continuationOf: options.continues }) });
    if (options.continues !== undefined) registry.noteContinuedBy(workspaceId, options.continues, requestId, { reason: "size", figure: "40 turns", at: ago(6) });
    if (options.finished !== false) registry.noteReport(workspaceId, requestId, { tier: "Small", phase: "finished", at: ago(5) });
    return requestId;
  };
  /** A paseo-bm agent of `requestId`, idle, labelled, left alone for 6 days. */
  const agent = (id: string, requestId: string | null, over: Partial<FakeAgent> = {}, role: Role = "worker"): FakeAgent => ({
    id,
    workspaceId: REPO,
    provider: `bm-${role}`,
    status: "idle",
    labels: { "bm.role": role, ...(requestId === null ? {} : { "bm.requestId": requestId }) },
    createdAt: ago(10),
    updatedAt: ago(6),
    lastUserMessageAt: ago(7),
    pendingPermissions: [],
    ...over,
  });
  return { home, shop, mission, registry, roster, request, agent };
}
type World = ReturnType<typeof world>;

function run(home: string, agents: readonly FakeAgent[], options: { now?: () => Date; cleanup?: AgentCleanup; fake?: ReturnType<typeof fakePaseo> } = {}) {
  const logs: string[] = [];
  const fake = options.fake ?? fakePaseo({ agents });
  const cleanup = options.cleanup ?? createAgentCleanup({ now: options.now ?? (() => NOW), log: (message) => logs.push(message) });
  return { fake, logs, cleanup, pass: () => cleanup.pass(home, fake.paseo) };
}

const notes = (home: string, missionId: string) =>
  createMissionStore(home)
    .journal(missionId, 100)
    .filter((entry) => entry.kind === "note")
    .map((entry) => ({ by: entry.by, text: entry.text }));

describe("a finished Worker or Reviewer left alone for the window is archived (ADR-049)", () => {
  it("archives both, oldest last touch first, through Paseo's archive and nothing else; one journal note names each", async () => {
    const w = world();
    const first = w.request();
    const second = w.request();
    const worker = w.agent("worker-aaaaaaaa-1", first);
    const reviewer = w.agent("reviewer-bbbbbbbb-2", second, { updatedAt: ago(8), lastUserMessageAt: undefined }, "reviewer");
    const { fake, pass } = run(w.home, [worker, reviewer]);
    const result = await pass();
    expect(result.status).toBe("done");
    expect(result.archived.map((entry) => [entry.agentId, entry.role, entry.requestId, entry.missionId, entry.lastTouchAt])).toEqual([
      ["reviewer-bbbbbbbb-2", "reviewer", second, w.shop, ago(8)],
      ["worker-aaaaaaaa-1", "worker", first, w.shop, ago(6)],
    ]);
    expect(fake.archives).toEqual(["reviewer-bbbbbbbb-2", "worker-aaaaaaaa-1"]);
    // Only Paseo's unarchived agents are listed, and only archive changes anything: never a delete.
    expect(fake.lists.every((options) => options.filter?.includeArchived === false)).toBe(true);
    expect(fake.calls.every((call) => call === "agents.list" || call.startsWith("agent.archive:"))).toBe(true);
    expect(notes(w.home, w.shop)).toEqual([
      { by: "plugin", text: `Archived 2 finished agents left alone for 3 days: reviewer reviewer (${second}), worker worker-a (${first}).` },
    ]);
  });
});

/**
 * Each condition both ways: `arrange(w, true)` sets it so it keeps the agent,
 * `arrange(w, false)` the other way, and the agent is archived.
 */
const CONDITIONS: Array<{ name: string; arrange: (w: World, keeps: boolean) => FakeAgent }> = [
  { name: "running", arrange: (w, keeps) => w.agent("agent-1", w.request(), { status: keeps ? "running" : "idle" }) },
  { name: "initializing", arrange: (w, keeps) => w.agent("agent-1", w.request(), { status: keeps ? "initializing" : "closed" }) },
  { name: "a pending permission", arrange: (w, keeps) => w.agent("agent-1", w.request(), { pendingPermissions: keeps ? [{ id: "perm-1", name: "Bash" }] : [] }) },
  { name: "its request not finished", arrange: (w, keeps) => w.agent("agent-1", w.request({ finished: !keeps })) },
  {
    name: "its request not finished though the head of its chain is (a stopped request continued)",
    arrange: (w, keeps) => {
      const first = w.request({ finished: !keeps });
      w.request({ continues: first });
      return w.agent("agent-1", first);
    },
  },
  {
    name: "the head of its chain not finished",
    arrange: (w, keeps) => {
      const first = w.request();
      w.request({ continues: first, finished: !keeps });
      return w.agent("agent-1", first);
    },
  },
  { name: "its activity within the window", arrange: (w, keeps) => w.agent("agent-1", w.request(), { updatedAt: keeps ? ago(2.9) : ago(3.1), lastUserMessageAt: ago(5) }) },
  { name: "the owner's last message within the window", arrange: (w, keeps) => w.agent("agent-1", w.request(), { updatedAt: ago(5), lastUserMessageAt: keeps ? ago(1) : ago(4) }) },
  {
    name: "created within the window, with no activity or message",
    arrange: (w, keeps) => w.agent("agent-1", w.request(), { updatedAt: undefined, lastUserMessageAt: undefined, createdAt: keeps ? ago(1) : ago(4) }),
  },
  {
    name: "an open outbox record to it",
    arrange: (w, keeps) => {
      const elsewhere = w.request({ workspaceId: OTHER, missionId: null, finished: false });
      const outbox = createOutbox(w.home);
      const record = outbox.add(OTHER, { kind: "message", requestId: elsewhere, from: "main-1", to: "agent-1", text: "one more thing" });
      if (!keeps) outbox.settle(OTHER, record.id, "delivered");
      return w.agent("agent-1", w.request());
    },
  },
  {
    name: "an open outbox record of a request of its chain, held",
    arrange: (w, keeps) => {
      const first = w.request();
      const second = w.request({ continues: first });
      const outbox = createOutbox(w.home);
      const record = outbox.add(REPO, { kind: "report", requestId: first, from: "agent-old", to: "main-1", text: "BM-REPORT" });
      if (keeps) outbox.hold(REPO, record.id, true);
      else outbox.settle(REPO, record.id, "dropped", "test");
      return w.agent("agent-1", second);
    },
  },
  {
    name: "an open decision of a request of its chain",
    arrange: (w, keeps) => {
      const first = w.request();
      const second = w.request({ continues: first });
      createDecisionStore(w.home).open(makeDecision({ workspaceId: REPO, requestId: first, ...(keeps ? {} : { status: "expired", settledAt: ago(5) }) }));
      return w.agent("agent-1", second);
    },
  },
  {
    name: "a live peer link it asked",
    arrange: (w, keeps) => {
      const elsewhere = w.request();
      const links = createPeerLinkStore(w.home, { onEvent: () => {} });
      const asked = links.createLink({ kind: "question", from: { workspaceId: REPO, requestId: elsewhere, agentId: "agent-1", role: "worker" }, to: { workspaceId: OTHER, managerId: "mgr-pay" }, text: "Which currency?" });
      if (!asked.ok) throw new Error(asked.reasons.join("; "));
      if (!keeps) links.closeLink(asked.link.linkId, "asker");
      return w.agent("agent-1", w.request());
    },
  },
  {
    name: "a live peer link it took",
    arrange: (w, keeps) => {
      const theirs = w.request({ workspaceId: OTHER, missionId: null, finished: false });
      const elsewhere = w.request();
      const links = createPeerLinkStore(w.home, { onEvent: () => {} });
      const asked = links.createLink({ kind: "work", from: { workspaceId: OTHER, requestId: theirs, agentId: "w-pay", role: "worker" }, to: { workspaceId: REPO, managerId: "main-1" }, text: "Add a refund hook." });
      if (!asked.ok) throw new Error(asked.reasons.join("; "));
      const taken = links.takeLink(asked.link.linkId, { workspaceId: REPO, requestId: elsewhere, workerId: "agent-1" });
      if (!taken.ok || taken.link.state !== "taken") throw new Error("not taken");
      if (!keeps) links.closeLink(asked.link.linkId, "answerer");
      return w.agent("agent-1", w.request());
    },
  },
  {
    name: "a live peer link of a request of its chain (answered does not keep it)",
    arrange: (w, keeps) => {
      const theirs = w.request({ workspaceId: OTHER, missionId: null, finished: false });
      const first = w.request();
      const second = w.request({ continues: first });
      const links = createPeerLinkStore(w.home, { onEvent: () => {} });
      const asked = links.createLink({ kind: "work", from: { workspaceId: OTHER, requestId: theirs, agentId: "w-pay", role: "worker" }, to: { workspaceId: REPO, managerId: "main-1" }, text: "Add a refund hook." });
      if (!asked.ok) throw new Error(asked.reasons.join("; "));
      links.takeLink(asked.link.linkId, { workspaceId: REPO, requestId: first, workerId: "agent-old" });
      if (!keeps) links.markAnswered(asked.link.linkId);
      return w.agent("agent-1", second);
    },
  },
  {
    // Design §16.4: the creator is bound, so the label counts only where its workspace's registry holds it.
    name: "a request label its bound creator never registered in the agent's workspace",
    arrange: (w, keeps) => {
      bindAgent(createBindingStore(w.home), "main-1", { role: "manager", workspaceId: REPO });
      const requestId = keeps ? w.request({ workspaceId: OTHER, missionId: null }) : w.request();
      return w.agent("agent-1", requestId, { labels: { "bm.role": "worker", "bm.requestId": requestId, "paseo.parent-agent-id": "main-1" } });
    },
  },
  { name: "a request no registry holds", arrange: (w, keeps) => w.agent("agent-1", keeps ? "req-20990101T000000Z" : w.request()) },
  { name: "no request at all", arrange: (w, keeps) => w.agent("agent-1", keeps ? null : w.request()) },
];

describe("each eligibility and blocking condition, both ways (delivery line design §20.2)", () => {
  for (const { name, arrange } of CONDITIONS) {
    for (const keeps of [true, false]) {
      it(`${name}: ${keeps ? "kept" : "archived"}`, async () => {
        const w = world();
        const agent = arrange(w, keeps);
        const { fake, pass } = run(w.home, [agent]);
        const result = await pass();
        expect(result.status).toBe("done");
        expect(fake.archives).toEqual(keeps ? [] : ["agent-1"]);
        expect(finishedAgentsOf(w.home, [agent], { idleDays: 3, now: NOW }, () => {}).map((entry) => entry.agentId)).toEqual(keeps ? [] : ["agent-1"]);
      });
    }
  }
});

describe("never archived (ADR-049 Keeps)", () => {
  it("Mains, Orchestrators, unlabelled agents, a label the provider does not run, another provider's agent and an archived one; the rest of the pass goes on", async () => {
    const w = world();
    const disagreements: string[] = [];
    resetRoleDisagreementLog((line) => disagreements.push(line));
    const finished = w.request();
    const unlabelled = w.agent("worker-unlabelled", finished);
    delete unlabelled.labels!["bm.role"];
    const agents = [
      w.agent("main-old", finished, {}, "manager"),
      w.agent("orchestrator-old", null, {}, "orchestrator"),
      w.agent("orchestrator-req", finished, {}, "orchestrator"),
      unlabelled,
      w.agent("worker-labelled-reviewer", finished, { labels: { "bm.role": "reviewer", "bm.requestId": finished } }),
      w.agent("claude-labelled-worker", finished, { provider: "claude" }),
      w.agent("worker-archived", finished, { archivedAt: ago(4) }),
      w.agent("worker-free", finished),
    ];
    // A daemon that lists everything, archived agents too, so the pass's own checks are what is proved.
    const fake = fakePaseo({ agents, ignoresListFilter: true });
    const { pass } = run(w.home, agents, { fake });
    const result = await pass();
    expect(result.archived.map((entry) => entry.agentId)).toEqual(["worker-free"]);
    expect(fake.archives).toEqual(["worker-free"]);
    expect(disagreements).toHaveLength(2);
  });
});

describe("the owner's switch and window (Settings → Coordination → Archive finished agents)", () => {
  it("off: nothing is listed or archived and no hour is stamped; on again, the pass runs at once", async () => {
    const w = world();
    const agent = w.agent("agent-1", w.request());
    let now = NOW;
    const { fake, pass } = run(w.home, [agent], { now: () => now });
    createCoordinationStore(w.home).set({ key: "cleanup.archive", value: false });
    expect(await pass()).toEqual({ status: "off", archived: [], failed: [] });
    expect(fake.lists).toEqual([]);
    expect(fake.archives).toEqual([]);
    createCoordinationStore(w.home).set({ key: "cleanup.archive", value: true });
    now = new Date(NOW.getTime() + 60_000);
    expect((await pass()).status).toBe("done");
    expect(fake.archives).toEqual(["agent-1"]);
  });

  it("reads the window from the settings: 6 days alone is kept at 7 and archived at 5", async () => {
    const w = world();
    const agent = w.agent("agent-1", w.request(), { updatedAt: ago(6), lastUserMessageAt: ago(6.5) });
    createCoordinationStore(w.home).set({ key: "cleanup.idleDays", value: 7 });
    const kept = run(w.home, [agent]);
    expect((await kept.pass()).status).toBe("done");
    expect(kept.fake.archives).toEqual([]);
    createCoordinationStore(w.home).set({ key: "cleanup.idleDays", value: 5 });
    const archived = run(w.home, [agent]);
    await archived.pass();
    expect(archived.fake.archives).toEqual(["agent-1"]);
    expect(notes(w.home, w.shop).at(-1)!.text).toBe(`Archived 1 finished agent left alone for 5 days: worker agent-1 (${agent.labels!["bm.requestId"]}).`);
  });

  it("reads the switch from the file's own state: none uses the defaults; a corrupt file, one a newer build wrote, a switch that is not true or false and a window out of bounds archive nothing", async () => {
    const settingsFile = (home: string, text: string) => {
      mkdirSync(join(home, COORDINATION_DIR_NAME), { recursive: true });
      writeFileSync(join(home, COORDINATION_DIR_NAME, COORDINATION_SETTINGS_FILE), text);
    };
    const cases: Array<{ text: string | null; status: string; archived: string[] }> = [
      { text: null, status: "done", archived: ["agent-1"] },
      { text: "{ not json", status: "unreadable", archived: [] },
      { text: JSON.stringify({ version: 2, cleanup: { archive: true, idleDays: 3 } }), status: "unreadable", archived: [] },
      { text: JSON.stringify({ version: 1, cleanup: { archive: "false", idleDays: 3 } }), status: "off", archived: [] },
      { text: JSON.stringify({ version: 1, cleanup: { archive: true, idleDays: 0 } }), status: "unreadable", archived: [] },
      { text: JSON.stringify({ version: 1, cleanup: { archive: true, idleDays: 31 } }), status: "unreadable", archived: [] },
      { text: JSON.stringify({ version: 1, cleanup: "on" }), status: "unreadable", archived: [] },
      // A file an older build wrote has no cleanup group: the defaults.
      { text: JSON.stringify({ version: 1, line: { supervised: true } }), status: "done", archived: ["agent-1"] },
    ];
    for (const { text, status, archived } of cases) {
      const w = world();
      const agent = w.agent("agent-1", w.request());
      if (text !== null) settingsFile(w.home, text);
      const { fake, pass } = run(w.home, [agent]);
      expect((await pass()).status, String(text)).toBe(status);
      expect(fake.archives, String(text)).toEqual(archived);
      if (status !== "done") expect(fake.lists, String(text)).toEqual([]);
    }
  });

  it("settings that cannot be read archive nothing", async () => {
    const w = world();
    const agent = w.agent("agent-1", w.request());
    const elsewhere = join(w.home, "..", "elsewhere");
    mkdirSync(elsewhere);
    symlinkSync(elsewhere, join(w.home, COORDINATION_DIR_NAME));
    const { fake, pass } = run(w.home, [agent]);
    expect(await pass()).toEqual({ status: "unreadable", archived: [], failed: [] });
    expect(fake.lists).toEqual([]);
    expect(fake.archives).toEqual([]);
  });
});

describe("once an hour, at most 25 a pass", () => {
  it("a second pass within the hour lists nothing; one an hour after the first runs again", async () => {
    const w = world();
    let now = NOW;
    const { fake, pass } = run(w.home, [w.agent("agent-1", w.request())], { now: () => now });
    expect((await pass()).status).toBe("done");
    const listed = fake.lists.length;
    expect(listed).toBeGreaterThan(0);
    fake.setAgents([...fake.agents, w.agent("agent-2", w.request())]);
    now = new Date(NOW.getTime() + AGENT_CLEANUP_INTERVAL_MS - 1);
    expect(await pass()).toEqual({ status: "throttled", archived: [], failed: [] });
    expect(fake.lists).toHaveLength(listed);
    expect(fake.archives).toEqual(["agent-1"]);
    now = new Date(NOW.getTime() + AGENT_CLEANUP_INTERVAL_MS);
    expect((await pass()).archived.map((entry) => entry.agentId)).toEqual(["agent-2"]);
    expect(AGENT_CLEANUP_INTERVAL_MS).toBe(HOUR);
  });

  it("archives the 25 oldest last touches first; the next pass takes the rest", async () => {
    const w = world();
    expect(MAX_ARCHIVES_PER_PASS).toBe(25);
    const finished = w.request();
    // agent-00 was touched most recently, agent-29 longest ago.
    const agents = Array.from({ length: 30 }, (_, n) => w.agent(`agent-${String(n).padStart(2, "0")}`, finished, { updatedAt: ago(4 + n / 24), lastUserMessageAt: undefined }));
    let now = NOW;
    const { fake, pass } = run(w.home, agents, { now: () => now });
    const first = await pass();
    const oldestFirst = agents.map((agent) => agent.id).reverse();
    expect(first.archived.map((entry) => entry.agentId)).toEqual(oldestFirst.slice(0, 25));
    expect(fake.archives).toEqual(oldestFirst.slice(0, 25));
    now = new Date(NOW.getTime() + HOUR);
    const second = await pass();
    expect(second.archived.map((entry) => entry.agentId)).toEqual(oldestFirst.slice(25));
  });
});

describe("told: the journal of each mission, a log line for a request of no mission", () => {
  it("one note by the plugin per mission per pass, naming each agent; a request of no mission is logged; a later pass with nothing to archive writes none", async () => {
    const w = world();
    const pay = w.mission("PAY", OTHER);
    const shopWorker = w.request();
    const shopReview = w.request();
    const payWorker = w.request({ workspaceId: OTHER, missionId: pay });
    const loose = w.request({ missionId: null });
    // An entry of an older build has no mission in the registry: its mission comes from the request index.
    w.registry.register(REPO, "req-20261101T080000Z", { source: "backfill", managerId: "main-1" });
    w.registry.noteReport(REPO, "req-20261101T080000Z", { tier: "Small", phase: "finished", at: ago(5) });
    w.roster.add(w.shop, { requestId: "req-20261101T080000Z", workspaceId: REPO, topic: "older work", workerId: "w-older" });
    const alone = (days: number) => ({ updatedAt: ago(days), lastUserMessageAt: undefined });
    const agents = [
      w.agent("shop-worker-1", shopWorker, alone(9)),
      w.agent("shop-reviewer-1", shopReview, alone(8), "reviewer"),
      w.agent("shop-older-1", "req-20261101T080000Z", alone(7.5)),
      w.agent("pay-worker-1", payWorker, { ...alone(6.5), workspaceId: OTHER }),
      w.agent("loose-worker-1", loose, alone(6)),
    ];
    let now = NOW;
    const { logs, pass } = run(w.home, agents, { now: () => now });
    const result = await pass();
    expect(result.archived.map((entry) => [entry.agentId, entry.missionId])).toEqual([
      ["shop-worker-1", w.shop],
      ["shop-reviewer-1", w.shop],
      ["shop-older-1", w.shop],
      ["pay-worker-1", pay],
      ["loose-worker-1", null],
    ]);
    expect(notes(w.home, w.shop)).toEqual([
      { by: "plugin", text: `Archived 3 finished agents left alone for 3 days: worker shop-wor (${shopWorker}), reviewer shop-rev (${shopReview}), worker shop-old (req-20261101T080000Z).` },
    ]);
    expect(notes(w.home, pay)).toEqual([{ by: "plugin", text: `Archived 1 finished agent left alone for 3 days: worker pay-work (${payWorker}).` }]);
    expect(logs).toEqual([`[paseo-bm] archived finished worker loose-worker-1 of request ${loose} (no mission), left alone for 3 days.`]);
    now = new Date(NOW.getTime() + HOUR);
    expect((await pass()).archived).toEqual([]);
    expect(notes(w.home, w.shop)).toHaveLength(1);
    expect(notes(w.home, pay)).toHaveLength(1);
  });
});

describe("no name is lost to the journal's line limit", () => {
  /** The count a note says and the names it lists. */
  const parsed = (text: string) => {
    const match = /^Archived (\d+) finished agents? left alone for 3 days: (.*)\.$/.exec(text);
    if (match === null) throw new Error(`not an archive note: ${text}`);
    return { count: Number(match[1]), names: match[2]!.split(", ") };
  };

  it("25 archived agents of one mission go in as few notes as fit, each within the limit, naming every agent exactly once", async () => {
    const w = world();
    const agents = Array.from({ length: 25 }, (_, n) => w.agent(`agent-${String(n).padStart(2, "0")}-xyz`, w.request(), { updatedAt: ago(30 - n), lastUserMessageAt: undefined }));
    const { pass } = run(w.home, agents);
    expect((await pass()).archived).toHaveLength(25);
    const named = agents.map((agent) => `worker ${agent.id.slice(0, 8)} (${agent.labels!["bm.requestId"]})`);
    // One note could not hold them all.
    expect(`Archived 25 finished agents left alone for 3 days: ${named.join(", ")}.`.length).toBeGreaterThan(MAX_JOURNAL_TEXT);
    const written = notes(w.home, w.shop);
    expect(written.length).toBeGreaterThan(1);
    expect(written.every((note) => note.by === "plugin" && note.text.length <= MAX_JOURNAL_TEXT)).toBe(true);
    const parts = written.map((note) => parsed(note.text));
    for (const part of parts) expect(part.names).toHaveLength(part.count);
    expect(parts.flatMap((part) => part.names)).toEqual(named);
    // As few as fit: the next note's first name would not have fitted in the note before it.
    for (let at = 0; at + 1 < parts.length; at += 1) expect(archivedNotesOf([...parts[at]!.names, parts[at + 1]!.names[0]!], 3)).toHaveLength(2);
  });

  it("names that fit stay one note; a name too long for a note alone is never split", () => {
    expect(archivedNotesOf(["worker agent-1 (req-20261101T000001Z)"], 1)).toEqual(["Archived 1 finished agent left alone for 1 day: worker agent-1 (req-20261101T000001Z)."]);
    expect(archivedNotesOf([], 3)).toEqual([]);
    const long = "x".repeat(MAX_JOURNAL_TEXT);
    expect(archivedNotesOf([long, "worker b"], 3)).toEqual([`Archived 1 finished agent left alone for 3 days: ${long}.`, "Archived 1 finished agent left alone for 3 days: worker b."]);
  });
});

describe("a failure is one log line and keeps nothing else back", () => {
  it("an archive call that fails is logged and left for the next pass; the others are archived and journaled", async () => {
    const w = world();
    const finished = w.request();
    const alone = (days: number) => ({ updatedAt: ago(days), lastUserMessageAt: undefined });
    const agents = [w.agent("agent-1", finished, alone(9)), w.agent("agent-2", finished, alone(8)), w.agent("agent-3", finished, alone(7))];
    let now = NOW;
    const { fake, logs, pass } = run(w.home, agents, { now: () => now });
    fake.handle("agent-2").archive.mockRejectedValueOnce(new Error("daemon said no"));
    const result = await pass();
    expect(result.archived.map((entry) => entry.agentId)).toEqual(["agent-1", "agent-3"]);
    expect(result.failed.map((entry) => entry.agentId)).toEqual(["agent-2"]);
    expect(logs).toEqual([`[paseo-bm] could not archive finished worker agent-2 of request ${finished}; the next pass tries again: daemon said no`]);
    expect(notes(w.home, w.shop)).toEqual([{ by: "plugin", text: `Archived 2 finished agents left alone for 3 days: worker agent-1 (${finished}), worker agent-3 (${finished}).` }]);
    now = new Date(NOW.getTime() + HOUR);
    expect((await pass()).archived.map((entry) => entry.agentId)).toEqual(["agent-2"]);
  });

  it("agents that cannot be listed, or a Paseo without archive, archive nothing and say so once", async () => {
    const w = world();
    const agent = w.agent("agent-1", w.request());
    const failing = run(w.home, [agent]);
    failing.fake.api.agents.list.mockRejectedValue(new Error("daemon away"));
    expect(await failing.pass()).toEqual({ status: "failed", archived: [], failed: [] });
    expect(failing.logs).toEqual(["[paseo-bm] finished agents were not archived: the agents could not be listed: daemon away"]);
    const narrow = run(w.home, [agent], { fake: fakePaseo({ agents: [agent], omit: ["agents.ref"] }) });
    expect((await narrow.pass()).status).toBe("failed");
    expect(narrow.logs).toEqual(["[paseo-bm] finished agents were not archived: this Paseo cannot list or archive agents."]);
  });

  it("agent bindings that cannot be read keep every agent until they can, since no request label could be trusted", async () => {
    const w = world();
    const agent = w.agent("agent-1", w.request());
    const path = join(w.home, UI_DIR_NAME, BINDINGS_FILE);
    mkdirSync(join(w.home, UI_DIR_NAME), { recursive: true });
    writeFileSync(path, "{ not json");
    let now = NOW;
    const { fake, logs, pass } = run(w.home, [agent], { now: () => now });
    expect(await pass()).toEqual({ status: "done", archived: [], failed: [] });
    expect(fake.archives).toEqual([]);
    expect(logs).toEqual(["[paseo-bm] finished agents were not archived: the agent bindings could not be read, so no request label can be trusted."]);
    expect(finishedAgentsOf(w.home, [agent], { idleDays: 3, now: NOW }, () => {})).toEqual([]);
    rmSync(path);
    now = new Date(NOW.getTime() + HOUR);
    await pass();
    expect(fake.archives).toEqual(["agent-1"]);
  });

  it("a file of work still waiting that cannot be read keeps every agent until it can", async () => {
    const w = world();
    const agent = w.agent("agent-1", w.request());
    const path = join(w.home, PEERS_DIR_NAME, PEER_LINKS_FILE_NAME);
    mkdirSync(join(w.home, PEERS_DIR_NAME), { recursive: true });
    writeFileSync(path, "{ not json");
    let now = NOW;
    const { fake, logs, pass } = run(w.home, [agent], { now: () => now });
    expect(await pass()).toEqual({ status: "done", archived: [], failed: [] });
    expect(fake.archives).toEqual([]);
    expect(logs).toEqual(["[paseo-bm] finished agents were not archived: the work still waiting could not be read: a file of the outbox, the decisions or the peer links cannot be read"]);
    rmSync(path);
    now = new Date(NOW.getTime() + HOUR);
    await pass();
    expect(fake.archives).toEqual(["agent-1"]);
  });
});
