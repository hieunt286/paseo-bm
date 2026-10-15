import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearBindingCache } from "../plugin/server/agent-bindings";
import { clearJsonFileCache } from "../plugin/server/data-files";
import { clearDecisionStoreCache, createDecisionStore } from "../plugin/server/decision-store";
import { createGovernorStore } from "../plugin/server/governor-store";
import { createMemoryStore } from "../plugin/server/memory-store";
import { createPrecedentStore } from "../plugin/server/precedent-store";
import { createMissionAutonomyStore } from "../plugin/server/mission-autonomy-store";
import { createMissionDecisionStore } from "../plugin/server/mission-decisions";
import { clearRequestIndexCache, createMissionRoster } from "../plugin/server/mission-roster";
import { createMissionStore, type Mission } from "../plugin/server/mission-store";
import { missionCardOf } from "../plugin/server/mission-tools";
import {
  MEMORY_LIST_LIMIT,
  MISSION_PAGE_JOURNAL,
  handleMemoryList,
  handleMissionChange,
  handleMissionGet,
  handleMissionsList,
  registerMissionsRpcs,
} from "../plugin/server/missions-rpc";
import { ensureMissionsHome, missionsHomeDirOf, type MissionsPaseo } from "../plugin/server/missions-home";
import { createOutbox } from "../plugin/server/outbox";
import { createPeerLinkStore } from "../plugin/server/peer-links";
import { clearLinksCache } from "../plugin/server/links";
import { clearRequestRegistryCache } from "../plugin/server/request-registry";
import { clearTraceStoreCache } from "../plugin/server/trace-store";
import { mainTitleOf } from "../plugin/server/role-title";
import { memoryListRpc, missionChangeRpc, missionGetRpc, missionsListRpc } from "../plugin/shared/contracts";
import { answerDecision } from "../plugin/shared/decisions";
import { makeDecision } from "./helpers/decisions";
import { fakePaseo, type FakeAgent } from "./helpers/fake-paseo";
import { fakeCli } from "./helpers/fake-cli";

/**
 * WP-302 (missions design §10.2, §10.4): the Missions screen's RPCs over a
 * fixture data folder and a fake Paseo — missions.list, mission.get,
 * memory.list, and mission.change's refusals (nothing written) and effects
 * (journal, the Main told, retitled). A fake `paseo` CLI; no daemon.
 */

const NOW = new Date("2026-10-09T10:00:00.000Z");
const ago = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000);
const iso = (minutes: number) => ago(minutes).toISOString();
const DAY = 24 * 60;

const MAIN = "main-1";
const REQ1 = "req-20261009T090000Z";
const REQ2 = "req-20261009T091000Z";
const REQ3 = "req-20261009T092000Z";
const REQ_C = "req-20261009T093000Z";

/**
 * Every test runs in the same `root`, emptied after it; the fixture's data
 * folder is built there once (`beforeAll`) and kept in `template`, and a test
 * that asks for it gets a fresh copy at the same path, so every absolute path
 * the stores keep still holds. Every read cache is dropped between tests.
 */
let root: string;
let home: string;
let template: string;
let built: Awaited<ReturnType<typeof buildFixture>>;

function stubHome(): void {
  vi.stubEnv("HOME", root);
  vi.stubEnv("PASEO_BM_HOME", home);
}

function clearCaches(): void {
  clearJsonFileCache();
  clearBindingCache();
  clearRequestIndexCache();
  clearRequestRegistryCache();
  clearDecisionStoreCache();
  clearTraceStoreCache();
  clearLinksCache();
}

function emptyRoot(): void {
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root);
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "bm-missions-rpc-"));
  home = join(root, ".paseo-bm");
  template = mkdtempSync(join(tmpdir(), "bm-missions-rpc-template-"));
  stubHome();
  built = await buildFixture();
  cpSync(home, template, { recursive: true });
  vi.unstubAllEnvs();
  clearCaches();
  emptyRoot();
});
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(template, { recursive: true, force: true });
});
beforeEach(stubHome);
afterEach(() => {
  vi.unstubAllEnvs();
  clearCaches();
  emptyRoot();
});

const manager = (id: string, extra: Partial<FakeAgent> = {}): FakeAgent => ({ id, provider: "bm-manager", workspaceId: "wks-own", labels: { "bm.role": "manager" }, ...extra });
const worker = (id: string, workspaceId: string, extra: Partial<FakeAgent> = {}): FakeAgent => ({ id, provider: "bm-worker", workspaceId, labels: { "bm.role": "worker" }, ...extra });

const AGENTS: FakeAgent[] = [
  manager(MAIN, { status: "idle" }),
  manager("main-2", { status: "running" }),
  manager("main-3", { status: "error" }),
  manager("main-4", { status: "idle", archivedAt: iso(DAY) }),
  worker("wkr-1", "wks-a", { status: "running" }),
  worker("wkr-gone", "wks-a", { status: "idle", archivedAt: iso(30) }),
  worker("wkr-2", "wks-b", { status: "idle" }),
  worker("wkr-3", "wks-a", { status: "closed" }),
];

function daemon() {
  return fakePaseo<MissionsPaseo>({
    agents: AGENTS,
    workspaces: [
      { id: "wks-a", directory: "/repo/api" },
      { id: "wks-b", directory: "/repo/web" },
      { id: "wks-c", directory: "/repo/docs" },
      { id: "wks-own", directory: missionsHomeDirOf(home) },
    ],
  });
}

function missionAt(minutesAgo: number, init: { code: string; name: string; repos: string[]; mainId: string | null }): Mission {
  const created = createMissionStore(home, { now: () => ago(minutesAgo) }).create({ ...init, goal: `${init.name} goal`, createdBy: "owner" });
  if (!created.ok) throw new Error(created.reasons.join("; "));
  return created.mission;
}

function update(missionId: string, change: (mission: Mission) => Mission): Mission {
  const result = createMissionStore(home).update(missionId, change);
  if (!result.ok) throw new Error(result.reasons.join("; "));
  return result.mission;
}

/** WEB (open, two repos, three requests), BILL (open, newer, level 4), OPS and OLD (closed). Run once, by `beforeAll`. */
async function buildFixture() {
  const fake = daemon();
  await ensureMissionsHome(fake.paseo, { home });
  let web = missionAt(5 * DAY, { code: "WEB", name: "Website", repos: ["wks-a", "wks-b"], mainId: MAIN });
  web = update(web.missionId, (mission) => ({
    ...mission,
    charter: {
      ...mission.charter,
      nonGoals: ["No redesign"],
      confirmedAt: iso(4 * DAY),
      budget: { requests: 3, workers: null, reviewCalls: null, days: null },
      doneCriteria: [
        { id: "D1", text: "Invoices list", status: "met", at: iso(DAY), evidence: "shipped" },
        { id: "D2", text: "Invoice detail", status: "open", at: null, evidence: null },
        { id: "D3", text: "Invoice export", status: "dropped", at: iso(DAY), evidence: null },
      ],
    },
    plan: { text: "1. API\n2. UI", updatedAt: iso(60) },
    contracts: [{ id: "C1", title: "Invoice API", providerRepo: "wks-a", consumerRepos: ["wks-b"], text: "GET /invoices", version: 2, updatedAt: iso(90), source: "api/openapi.yaml" }],
  }));
  const bill = missionAt(2 * DAY, { code: "BILL", name: "Billing", repos: ["wks-c"], mainId: "main-2" });
  createMissionAutonomyStore(home).setLevel(bill.missionId, 4);
  const ops = missionAt(10 * DAY, { code: "OPS", name: "Ops", repos: ["wks-a"], mainId: "main-3" });
  update(ops.missionId, (mission) => ({ ...mission, state: "closed", closedAt: iso(3 * DAY) }));
  const old = missionAt(20 * DAY, { code: "OLD", name: "Old", repos: ["wks-b"], mainId: "main-4" });
  update(old.missionId, (mission) => ({ ...mission, state: "closed", closedAt: iso(DAY) }));

  // The roster: REQ1 (a live Worker, then an archived one; an open owner question), REQ2 (a blocked report), REQ3 (finished).
  const roster = createMissionRoster(home);
  roster.add(web.missionId, { requestId: REQ1, workspaceId: "wks-a", topic: "Invoice API", workerId: "wkr-1" });
  roster.add(web.missionId, { requestId: REQ1, workspaceId: "wks-a", topic: "Invoice API", workerId: "wkr-gone" });
  roster.add(web.missionId, { requestId: REQ2, workspaceId: "wks-b", topic: "Invoice screen", workerId: "wkr-2" });
  roster.add(web.missionId, { requestId: REQ3, workspaceId: "wks-a", topic: "", workerId: "wkr-3" });
  roster.setState(web.missionId, REQ3, "finished");
  const outbox = createOutbox(home, { now: () => ago(20) });
  outbox.add("wks-b", { kind: "report", requestId: REQ2, from: "wkr-2", to: MAIN, text: "BM-REPORT\nphase: blocked\nwaiting on the API" });

  // The questions: Q1 open (counted), Q2 answered and a question of a request of no mission (not counted); one open m: card.
  const decisions = createDecisionStore(home);
  decisions.open(makeDecision({ id: `q:${REQ1}:Q1`, workspaceId: "wks-a", requestId: REQ1, askedAt: iso(30) }));
  decisions.open(makeDecision({ id: `q:${REQ1}:Q2`, workspaceId: "wks-a", requestId: REQ1, askedAt: iso(40), subject: "export-format" }));
  decisions.transition(`q:${REQ1}:Q2`, (decision) => answerDecision(decision, { via: "inbox", optionKey: "c", words: null, at: iso(35) }), "wks-a");
  decisions.open(makeDecision({ id: "q:req-20261001T000000Z:Q1", workspaceId: "wks-a", requestId: "req-20261001T000000Z", askedAt: iso(30) }));
  const cards = createMissionDecisionStore(home);
  cards.open(missionCardOf(web, { goal: "Ship v2 and v3" }, { id: cards.nextId(web.missionId), mainId: MAIN, at: iso(10) }));

  // The links: REQ1 asked wks-b twice (one live with 2 messages, one closed) and took one of wks-c (1 message).
  const ids = ["peer-000000000001", "peer-000000000002", "peer-000000000003"];
  const links = createPeerLinkStore(home, { newId: () => ids.shift()!, now: () => ago(15) });
  const message = (linkId: string, workspaceId: string, agentId: string) => {
    const record = outbox.add(workspaceId, { kind: "peer", requestId: REQ1, from: agentId, to: "someone", text: "x" });
    links.appendMessage(linkId, { recordId: record.id, workspaceId, side: "asker", agentId, kind: "peer", text: "x" });
  };
  links.createLink({ kind: "question", from: { workspaceId: "wks-a", requestId: REQ1, agentId: "wkr-1", role: "worker" }, to: { workspaceId: "wks-b", managerId: null }, text: "Which fields?" });
  message("peer-000000000001", "wks-a", "wkr-1");
  message("peer-000000000001", "wks-a", "wkr-1");
  links.createLink({ kind: "question", from: { workspaceId: "wks-a", requestId: REQ1, agentId: "wkr-1", role: "worker" }, to: { workspaceId: "wks-b", managerId: null }, text: "Old" });
  message("peer-000000000002", "wks-a", "wkr-1");
  links.closeLink("peer-000000000002", "asker");
  links.createLink({ kind: "work", from: { workspaceId: "wks-c", requestId: REQ_C, agentId: "wkr-c", role: "worker" }, to: { workspaceId: "wks-a", managerId: null }, text: "Add a field" });
  links.takeLink("peer-000000000003", { workspaceId: "wks-a", requestId: REQ1, workerId: "wkr-1" });
  message("peer-000000000003", "wks-c", "wkr-c");

  // The ladder: WEB's budget nudged 12 min ago (step 2); OPS's mess at step 1, though OPS is closed.
  createGovernorStore(home).put(web.missionId, {
    budget: { step: 2, since: iso(20), figures: [], lastAction: { at: iso(12), kind: "nudge", id: "cmd-1" }, mainTurnsAt: 0 },
    mess: { step: 0, since: null, figures: [], lastAction: { at: iso(100), kind: "reset", id: null }, mainTurnsAt: null },
  });
  createGovernorStore(home).put(ops.missionId, { mess: { step: 1, since: iso(DAY), figures: [], lastAction: { at: iso(DAY), kind: "record", id: null }, mainTurnsAt: null } });

  const store = createMissionStore(home);
  for (let n = 1; n <= 55; n += 1) store.appendJournal(web.missionId, { kind: "note", by: "plugin", text: `line ${n}` });
  return { web: store.get(web.missionId)!, bill, ops, old };
}

/** A fresh copy of the fixture's data folder at `home`, and a fresh fake Paseo that has opened the Missions home. */
async function fixture() {
  cpSync(template, home, { recursive: true });
  const fake = daemon();
  await ensureMissionsHome(fake.paseo, { home });
  return { fake, ...structuredClone(built) };
}

const deps = (extra: Record<string, unknown> = {}) => ({ home, now: () => NOW, log: () => {}, ...extra });

describe("missions.list (§10.4)", () => {
  it("lists open missions newest first, then closed ones newest closed first, each summary as §10.2 reads it", async () => {
    const { fake, web, bill, ops, old } = await fixture();
    const listed = missionsListRpc.output.parse(await handleMissionsList(fake.paseo, deps()));
    expect(listed.missions.map((mission) => mission.code)).toEqual(["BILL", "WEB", "OLD", "OPS"]);
    const [billing, website, oldest, operations] = listed.missions;
    expect(website).toEqual({
      missionId: web.missionId,
      code: "WEB",
      name: "Website",
      state: "open",
      createdAt: iso(5 * DAY),
      closedAt: null,
      main: { agentId: MAIN, state: "idle" },
      level: 2,
      delegated: ["proceed", "staffing"],
      repos: [
        { workspaceId: "wks-a", name: "api" },
        { workspaceId: "wks-b", name: "web" },
      ],
      liveWorkers: 2,
      requests: 3,
      // D3 is dropped: 1 of 2.
      criteria: { met: 1, total: 2 },
      // Q1 and the m: card.
      questions: 2,
      signals: [
        {
          family: "budget",
          step: 2,
          crossed: [{ id: "requestsBudget", value: 100, threshold: 100, op: ">=", crossed: true, detail: "3 of 3" }],
          lastAction: { kind: "nudge", at: iso(12) },
          replanDueAt: new Date(NOW.getTime() + 18 * 60_000).toISOString(),
        },
      ],
    });
    // Level 4 delegates every class, in MISSION_CLASSES order.
    expect(billing).toMatchObject({ missionId: bill.missionId, main: { agentId: "main-2", state: "working" }, level: 4, liveWorkers: 0, requests: 0, questions: 0, signals: [] });
    expect(billing!.delegated).toEqual(["proceed", "staffing", "scope-repo", "answer-technical", "answer-effects", "split"]);
    expect(billing!.repos).toEqual([{ workspaceId: "wks-c", name: "docs" }]);
    expect(oldest).toMatchObject({ missionId: old.missionId, state: "closed", closedAt: iso(DAY), main: { agentId: "main-4", state: "none" } });
    // A closed mission's ladder is not climbed: no signals.
    expect(operations).toMatchObject({ missionId: ops.missionId, state: "closed", main: { agentId: "main-3", state: "stopped" }, signals: [] });
  });

  it("reads as none without a data folder or without missions", async () => {
    expect(await handleMissionsList(undefined, { home: null })).toEqual({ missions: [] });
    expect(await handleMissionsList(daemon().paseo, deps())).toEqual({ missions: [] });
  });
});

describe("mission.get (§10.4)", () => {
  it("returns the page: charter, every governor family, rows, contracts, the newest journal lines and the plan", async () => {
    const { fake, web } = await fixture();
    const page = missionGetRpc.output.parse(await handleMissionGet({ missionId: web.missionId }, fake.paseo, deps()));
    expect(page.summary.code).toBe("WEB");
    expect(page.charter).toEqual({
      goal: "Website goal",
      nonGoals: ["No redesign"],
      confirmedAt: iso(4 * DAY),
      criteria: [
        { id: "D1", text: "Invoices list", status: "met", at: iso(DAY) },
        { id: "D2", text: "Invoice detail", status: "open", at: null },
        { id: "D3", text: "Invoice export", status: "dropped", at: iso(DAY) },
      ],
      budget: { requests: 3, workers: null, reviewCalls: null, days: null },
    });
    expect(page.governor.map((signal) => [signal.family, signal.step])).toEqual([
      ["mess", 0],
      ["overengineering", 0],
      ["drift", 0],
      ["stuck", 0],
      ["budget", 2],
    ]);
    expect(page.governor[0]).toEqual({ family: "mess", step: 0, crossed: [], lastAction: { kind: "reset", at: iso(100) }, replanDueAt: null });
    expect(page.rows).toEqual([
      {
        repo: { workspaceId: "wks-a", name: "api" },
        requestId: REQ1,
        topic: "Invoice API",
        // wkr-gone is newer but archived: the newest live Worker.
        workerId: "wkr-1",
        phase: "blocked",
        ownerQuestions: ["Q1"],
        links: [
          { repo: { workspaceId: "wks-b", name: "web" }, messages: 2 },
          { repo: { workspaceId: "wks-c", name: "docs" }, messages: 1 },
        ],
      },
      { repo: { workspaceId: "wks-b", name: "web" }, requestId: REQ2, topic: "Invoice screen", workerId: "wkr-2", phase: "blocked", ownerQuestions: [], links: [] },
      { repo: { workspaceId: "wks-a", name: "api" }, requestId: REQ3, topic: null, workerId: "wkr-3", phase: "finished", ownerQuestions: [], links: [] },
    ]);
    expect(page.contracts).toEqual([
      { id: "C1", title: "Invoice API", provider: { workspaceId: "wks-a", name: "api" }, consumers: [{ workspaceId: "wks-b", name: "web" }], version: 2, updatedAt: iso(90) },
    ]);
    expect(page.journal).toHaveLength(MISSION_PAGE_JOURNAL);
    expect(page.journal[0]).toMatchObject({ kind: "note", by: "plugin", text: "line 55" });
    expect(page.journal.at(-1)!.text).toBe("line 6");
    expect(page.plan).toEqual({ text: "1. API\n2. UI", updatedAt: iso(60) });
  });

  it("a row is working when nothing blocks it, stopped as the roster says", async () => {
    const { fake, web } = await fixture();
    createOutbox(home, { now: () => ago(5) }).add("wks-b", { kind: "report", requestId: REQ2, from: "wkr-2", to: MAIN, text: "BM-REPORT\nphase: bead-implemented" });
    createMissionRoster(home).setState(web.missionId, REQ3, "stopped");
    const page = await handleMissionGet({ missionId: web.missionId }, fake.paseo, deps());
    expect(page.rows.map((row) => row.phase)).toEqual(["blocked", "working", "stopped"]);
  });

  it("reads a closed mission's governor as quiet", async () => {
    const { fake, ops } = await fixture();
    const page = await handleMissionGet({ missionId: ops.missionId }, fake.paseo, deps());
    expect(page.governor.every((signal) => signal.step === 0 && signal.crossed.length === 0 && signal.lastAction === null)).toBe(true);
    expect(page.summary.signals).toEqual([]);
  });

  it("refuses an unknown mission with E_MISSION_INVALID", async () => {
    const { fake } = await fixture();
    await expect(handleMissionGet({ missionId: "mis-0000000000" }, fake.paseo, deps())).rejects.toMatchObject({ code: "E_MISSION_INVALID" });
  });
});

describe("mission.change (§10.4)", () => {
  /** Everything a change could write. */
  const written = (missionId: string) => ({
    mission: createMissionStore(home).get(missionId),
    journal: createMissionStore(home).journal(missionId, 1_000).length,
    told: createOutbox(home).list("wks-own").length,
  });

  it("applies the owner's change at once: the mission, a charter journal line by owner, the Main told, retitled and relabelled", async () => {
    const { fake, web } = await fixture();
    const { cli, calls } = fakeCli();
    const output = missionChangeRpc.output.parse(
      await handleMissionChange({ missionId: web.missionId, name: "  Website v2 ", code: "WEBX", addRepos: ["wks-c", "wks-a"] }, fake.paseo, deps({ cli })),
    );
    expect(output.summary).toMatchObject({ missionId: web.missionId, code: "WEBX", name: "Website v2" });
    expect(output.summary.repos.map((repo) => repo.workspaceId)).toEqual(["wks-a", "wks-b", "wks-c"]);
    const stored = createMissionStore(home).get(web.missionId)!;
    expect(stored).toMatchObject({ code: "WEBX", name: "Website v2", charter: { repos: ["wks-a", "wks-b", "wks-c"] } });
    const lines = 'rename it "Website v2"; set its code to WEBX; add the repos wks-c';
    expect(createMissionStore(home).journal(web.missionId).at(-1)).toMatchObject({
      kind: "charter",
      by: "owner",
      text: `The owner changed the mission from the Missions screen: ${lines}.`,
    });
    const [told] = createOutbox(home).list("wks-own");
    expect(told).toMatchObject({ kind: "message", requestId: web.missionId, from: "owner", to: MAIN });
    expect(told!.text).toContain(`The owner changed your mission from the Missions screen: ${lines}.`);
    expect(calls).toEqual([
      ["agent", "update", MAIN, "--name", mainTitleOf("WEBX", "Website v2"), "--json"],
      ["agent", "update", MAIN, "--label", "bm.missionCode=WEBX", "--json"],
    ]);
  });

  it("closes a mission whose Workers are idle, and its active requests become stopped (mission runtime design §5.4)", async () => {
    const { fake, web } = await fixture();
    fake.byId("wkr-1")!.status = "idle";
    const { summary } = await handleMissionChange({ missionId: web.missionId, close: true }, fake.paseo, deps({ cli: fakeCli().cli }));
    expect(summary).toMatchObject({ state: "closed" });
    expect(createMissionRoster(home).list(web.missionId).map((entry) => [entry.requestId, entry.state])).toEqual(
      expect.arrayContaining([
        [REQ1, "stopped"],
        [REQ2, "stopped"],
      ]),
    );
  });

  it("closes a mission whose Workers have all finished, without retitling", async () => {
    const { fake, bill } = await fixture();
    const { cli, calls } = fakeCli();
    const { summary } = await handleMissionChange({ missionId: bill.missionId, close: true }, fake.paseo, deps({ cli }));
    expect(summary).toMatchObject({ state: "closed", closedAt: NOW.toISOString(), signals: [] });
    expect(calls).toEqual([]);
  });

  it.each([
    ["an unknown mission", { missionId: "mis-0000000000" }, "unknown mission mis-0000000000"],
    ["nothing to change", { name: "Website", addRepos: ["wks-a"] }, "nothing to change"],
    ["a code another open mission holds", { name: "Website v2", code: "BILL" }, "code BILL is taken by the open mission Billing"],
    ["a code of another shape", { code: "web" }, "code web is not 2 to 8 capital letters or digits, a letter first"],
    ["an empty name", { name: "  " }, "the name is empty"],
    ["a repo Paseo does not list", { addRepos: ["wks-nope"] }, "repo: wks-nope is not a workspace Paseo lists"],
    ["a plugin home", { addRepos: ["wks-own"] }, "repo: wks-own is a paseo-bm home, not a repository"],
    // Mission runtime design §5.4: only a Worker running a turn holds the close; REQ2's idle wkr-2 does not.
    ["closing while a Worker of the mission runs", { close: true as const }, `a Worker of mission WEB still runs (${REQ1})`],
  ])("refuses %s with E_MISSION_INVALID and writes nothing", async (_name, change, reason) => {
    const { fake, web } = await fixture();
    const { cli, calls } = fakeCli();
    const before = written(web.missionId);
    const input = { missionId: web.missionId, ...change };
    const failure = await handleMissionChange(input, fake.paseo, deps({ cli })).catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: "E_MISSION_INVALID" });
    expect((failure as Error).message).toContain(reason);
    expect(written(web.missionId)).toEqual(before);
    expect(calls).toEqual([]);
  });

  it("refuses a closed mission and writes nothing", async () => {
    const { fake, ops } = await fixture();
    const before = written(ops.missionId);
    await expect(handleMissionChange({ missionId: ops.missionId, name: "Ops 2" }, fake.paseo, deps({ cli: fakeCli().cli }))).rejects.toMatchObject({
      code: "E_MISSION_INVALID",
      message: expect.stringContaining("mission OPS is closed"),
    });
    expect(written(ops.missionId)).toEqual(before);
  });
});

describe("memory.list (§10.4)", () => {
  it("lists a repo's active entries newest first, named as its project", async () => {
    const fake = daemon();
    const add = (minutesAgo: number, text: string, by: { role: "owner" | "worker"; agentId: string | null }) => {
      const result = createMemoryStore(home, { now: () => ago(minutesAgo) }).add("wks-a", { kind: "fact", text, source: "owner, Q2", by: { ...by, missionId: null } });
      if (!result.ok) throw new Error(result.reasons.join("; "));
      return result.entry;
    };
    const first = add(30, "first", { role: "owner", agentId: null });
    add(20, "removed", { role: "worker", agentId: "wkr-1" });
    const third = add(10, "third", { role: "worker", agentId: "wkr-1" });
    const removed = createMemoryStore(home).active("wks-a").find((entry) => entry.text === "removed")!;
    createMemoryStore(home).remove("wks-a", removed.id);
    const listed = memoryListRpc.output.parse(await handleMemoryList({ workspaceId: "wks-a" }, fake.paseo, deps()));
    expect(listed).toEqual({
      workspaceId: "wks-a",
      name: "api",
      total: 2,
      entries: [
        { id: third.id, kind: "fact", text: "third", source: "owner, Q2", by: { role: "worker", agentId: "wkr-1" }, at: iso(10) },
        { id: first.id, kind: "fact", text: "first", source: "owner, Q2", by: { role: "owner", agentId: null }, at: iso(30) },
      ],
    });
    expect(MEMORY_LIST_LIMIT).toBe(300);
    expect(await handleMemoryList({ workspaceId: "wks-b" }, fake.paseo, deps())).toEqual({ workspaceId: "wks-b", name: "web", total: 0, entries: [] });
    // Artboard F: the owner's active precedents of the repo and of all projects show with the stored entries.
    const precedents = createPrecedentStore(home);
    const everywhere = precedents.save({ scope: "all", subject: "xone", text: "The UI never calls xOne directly", sourceDecisionId: null, expiresInDays: 30 }, ago(5)).precedent;
    const here = precedents.save({ scope: "wks-a", subject: "app-code", text: "appCode is fixed", sourceDecisionId: "q:req-1:Q2", expiresInDays: 30 }, ago(40)).precedent;
    precedents.save({ scope: "wks-b", subject: "other", text: "Another repo's", sourceDecisionId: null, expiresInDays: 30 }, ago(1));
    const merged = memoryListRpc.output.parse(await handleMemoryList({ workspaceId: "wks-a" }, fake.paseo, deps()));
    expect(merged.total).toBe(4);
    expect(merged.entries.map((entry) => [entry.id, entry.kind, entry.source])).toEqual([
      [everywhere.id, "precedent", "all projects"],
      [third.id, "fact", "owner, Q2"],
      [first.id, "fact", "owner, Q2"],
      [here.id, "precedent", "q:req-1:Q2"],
    ]);
  });
});

describe("registerMissionsRpcs", () => {
  it("registers the four contracts", () => {
    const handle = vi.fn();
    registerMissionsRpcs({ handle } as never);
    expect(handle.mock.calls.map(([contract]) => (contract as { name: string }).name)).toEqual(["missions.list", "mission.get", "mission.change", "memory.list"]);
  });
});
