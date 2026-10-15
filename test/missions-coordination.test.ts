import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearBindingCache } from "../plugin/server/agent-bindings";
import { createCompactionRunner } from "../plugin/server/compaction";
import { createCompactionStore } from "../plugin/server/compaction-store";
import { createCoordinationStore } from "../plugin/server/coordination-store";
import { clearJsonFileCache } from "../plugin/server/data-files";
import { createHandoffRunner, mainHandoffLineOf } from "../plugin/server/handoff";
import { createMissionRoster } from "../plugin/server/mission-roster";
import { createMissionStore } from "../plugin/server/mission-store";
import type { MissionsPaseo } from "../plugin/server/missions-home";
import { createNoticeQueue, type NoticeQueue } from "../plugin/server/notice-queue";
import type { PaseoCliDeps } from "../plugin/server/paseo-cli";
import { createRequestRegistry } from "../plugin/server/request-registry";
import type { TraceRecord, Usage } from "../plugin/shared/contracts";
import { turn } from "./fixtures/orchestrator-traces";
import { fakePaseo, type FakeAgent } from "./helpers/fake-paseo";
import { fakeCli } from "./helpers/fake-cli";
import { roleAliases, roleProfiles } from "./helpers/roles";

/**
 * Missions design §9.5 (WP-205), mission runtime design §3.5: a Main whose
 * real context crosses the owner's threshold, once it can no longer be
 * compacted in place, is handed over in code — a
 * successor created as `mission.ensure`'s replacement is, then §3.4's steps
 * (`replaceMain`, reason `handoff`) — and the mission keeps its requests.
 * A fake Paseo, a fake `paseo` CLI and a temporary data folder; no daemon.
 */

const MISSION = "mis-0123456789";
const MAIN = "main-1";
const WORKER = "worker-1";
const REPO = "wks-a";
const REQUEST = "req-20261009T100000Z";
const T0 = Date.parse("2026-10-09T10:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();

let root: string;
let home: string;
let queue: NoticeQueue;
let logs: string[];
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "bm-missions-coordination-"));
  home = join(root, ".paseo-bm");
  vi.stubEnv("HOME", root);
  vi.stubEnv("PASEO_BM_HOME", home);
  queue = createNoticeQueue({ log: () => {} });
  logs = [];
});
afterEach(() => {
  vi.unstubAllEnvs();
  clearJsonFileCache();
  clearBindingCache();
  rmSync(root, { recursive: true, force: true });
});

function daemon() {
  const agents: FakeAgent[] = [
    { id: MAIN, workspaceId: "wks-own", provider: "bm-manager", status: "idle", createdAt: iso(T0), labels: { "bm.role": "manager", "bm.missionId": MISSION }, archivedAt: null },
    { id: WORKER, workspaceId: REPO, provider: "bm-worker", status: "idle", createdAt: iso(T0), labels: { "bm.role": "worker", "bm.requestId": REQUEST, "paseo.parent-agent-id": MAIN }, archivedAt: null },
  ];
  return fakePaseo<MissionsPaseo>({
    agents,
    workspaces: [{ id: REPO, directory: "/repo/api" }],
    config: { providers: roleAliases("claude", ["manager", "worker"]), agentProfiles: roleProfiles("claude-opus-5", ["manager", "worker"]) },
    omit: ["providers"],
  });
}

/** The mission with its Main and one open request of its Worker in the repo. */
function seeded(): void {
  const created = createMissionStore(home, { newId: () => MISSION }).create({ code: "WEB", name: "Website", goal: "Ship it", repos: [REPO], createdBy: "owner", mainId: MAIN });
  if (!created.ok) throw new Error(created.reasons.join("; "));
  createMissionRoster(home).add(MISSION, { requestId: REQUEST, workspaceId: REPO, topic: "Login page", workerId: WORKER });
  createRequestRegistry(home).register(REPO, REQUEST, { source: "tool", managerId: MAIN, workerId: WORKER });
}

/**
 * A Claude turn of the Main with a real context of `context` tokens (mission
 * runtime design §3.1): the window not reported, so the Main's figure is
 * `main.contextTokens` (150,000). `read` is the turn's token sum, never a
 * Main's figure: the XAI turn read 427,000 over a context of 110,000.
 */
const usageOf = (context: number, read = context * 4): Usage => ({
  inputTokens: 1_000,
  cachedInputTokens: read - 1_000,
  outputTokens: 2_000,
  costUsd: null,
  costBasis: "unavailable",
  model: "claude-opus-5",
  pricesUpdatedAt: null,
  contextUsed: context,
});
const mainTurn = (context = 160_000, at = T0, read?: number): TraceRecord =>
  turn({ workspaceId: "wks-own", agentId: MAIN, role: "manager", turnId: `m-${context}-${at}`, at: iso(at), startedAt: iso(at), endedAt: iso(at), usage: usageOf(context, read) });

function runnerOf(cli: PaseoCliDeps) {
  return createHandoffRunner({
    home: () => home,
    now: () => new Date(T0),
    queue,
    log: (line) => logs.push(line),
    cli,
    readMainInstructions: async (_paseo, workspaceId, missionId) => `instructions ${workspaceId} ${missionId ?? "none"}`,
    setLabels: async () => ({ ok: true }),
  });
}

const ended = (record: TraceRecord) => ({ agent: { id: record.agentId }, timeline: [] });

describe("a Main's handoff in code (missions design §9.5, §3.4; mission runtime design §3.5)", () => {
  it("a Main that cannot be compacted in place and whose real context crosses gets a successor; the mission keeps its requests; no Worker is told", async () => {
    seeded();
    createCoordinationStore(home).set({ key: "main.compact", value: false });
    const fake = daemon();
    const { cli, calls } = fakeCli();
    const runner = runnerOf(cli);
    await runner.turnRecorded(ended(mainTurn()), mainTurn(), fake.paseo);

    // Created as mission.ensure's replacement: in the home, from the brief, labelled with the mission and bm.replaces.
    expect(fake.creates).toHaveLength(1);
    const { options } = fake.creates[0]!;
    expect(options.labels).toMatchObject({ "bm.missionId": MISSION, "bm.missionCode": "WEB", "bm.replaces": MAIN });
    const prompt = String(options.prompt);
    expect(prompt.split("\n")[0]).toBe("BM-BRIEF manager requestId: none mission: WEB");
    expect(prompt).toContain(`- ${REQUEST} in api: working; Worker ${WORKER}; no report yet; asked: Login page`);
    expect(prompt.split("\n").at(-1)).toBe(mainHandoffLineOf(MAIN, { figure: "contextTokens", value: 160_000, threshold: 150_000 }));
    expect(prompt).toContain("its context reached 160,000 tokens (threshold 150,000)");
    expect(prompt).toContain("In your first reply tell the owner in one line that you took over and what is in flight");

    // §3.4: the mission names the successor (reason handoff) once, its request reports to it, the old Main is marked.
    const successor = "created-1";
    const mission = createMissionStore(home).get(MISSION)!;
    expect(mission).toMatchObject({ mainId: successor, state: "open" });
    expect(mission.mainHistory.map((entry) => [entry.agentId, entry.reason])).toEqual([
      [MAIN, "created"],
      [successor, "handoff"],
    ]);
    expect(createMissionStore(home).journal(MISSION, 10).filter((line) => line.kind === "main").map((line) => line.text)).toEqual([`Main ${successor} replaces ${MAIN} (handoff).`]);
    expect(createMissionRoster(home).get(MISSION, REQUEST)).toMatchObject({ state: "active", workerIds: [WORKER] });
    expect(createRequestRegistry(home).get(REPO, REQUEST)).toMatchObject({ managerId: successor });
    // Mission runtime design §3.4: no Worker is told; deliveries resolve to the current Main.
    expect(fake.sends.map((sent) => sent.id)).toEqual([]);
    expect(calls).toContainEqual(["agent", "update", MAIN, "--label", `bm.replacedBy=${successor}`, "--json"]);
    expect(fake.archives).toEqual([]);

    // Once: a later turn of the old Main starts nothing more.
    await runner.turnRecorded(ended(mainTurn(300_000)), mainTurn(300_000), fake.paseo);
    await runnerOf(cli).turnRecorded(ended(mainTurn(300_000)), mainTurn(300_000), fake.paseo);
    expect(fake.creates).toHaveLength(1);
  });

  it("the XAI turn — 427,000 tokens read over a real context of 110,000 — neither compacts nor hands the Main over", async () => {
    seeded();
    const fake = daemon();
    const { cli } = fakeCli();
    const xai = mainTurn(110_000, T0, 427_000);
    await createCompactionRunner({ home: () => home, now: () => new Date(T0), queue, log: () => {} }).turnRecorded(ended(xai), xai, fake.paseo);
    await runnerOf(cli).turnRecorded(ended(xai), xai, fake.paseo);
    expect(createCompactionStore(home).list()).toEqual([]);
    expect(fake.creates).toEqual([]);
  });

  it("in-place compaction goes first, without an intervention; a successor only when the first turn after a compaction still reaches the hard figure", async () => {
    seeded();
    const fake = daemon();
    const { cli } = fakeCli();
    await createCompactionRunner({ home: () => home, now: () => new Date(T0), queue, log: () => {} }).turnRecorded(ended(mainTurn()), mainTurn(), fake.paseo);
    await runnerOf(cli).turnRecorded(ended(mainTurn()), mainTurn(), fake.paseo);
    expect(createCompactionStore(home).list()).toMatchObject([{ agentId: MAIN, role: "manager", interventionId: null }]);
    expect(fake.creates).toEqual([]);
    // The compaction completed and its state brief went out.
    const store = createCompactionStore(home, { now: () => new Date(T0) });
    store.update(store.list()[0]!.id, (entry) => ({ ...entry, state: "done", sentAt: iso(T0), compactedAt: iso(T0 + 1_000), briefAt: iso(T0 + 2_000), endedAt: iso(T0 + 2_000) }));
    // Below the hard figure (150,000 / 0.6 × 0.85 = 212,500): nothing.
    await runnerOf(cli).turnRecorded(ended(mainTurn(200_000, T0 + 5_000)), mainTurn(200_000, T0 + 5_000), fake.paseo);
    expect(fake.creates).toEqual([]);
    // A fresh runner judges the first turn after the compaction again: at the hard figure, a successor.
    await runnerOf(cli).turnRecorded(ended(mainTurn(220_000, T0 + 6_000)), mainTurn(220_000, T0 + 6_000), fake.paseo);
    expect(fake.creates).toHaveLength(1);
    expect(String(fake.creates[0]!.options.prompt)).toContain("its context stayed above the hard figure right after a compaction");
  });

  it("two compactions in a row that did not compact hand the Main over", async () => {
    seeded();
    const fake = daemon();
    const { cli } = fakeCli();
    const store = createCompactionStore(home, { now: () => new Date(T0) });
    for (const id of [1, 2]) {
      const entry = store.add({ workspaceId: "wks-own", requestId: null, agentId: MAIN, role: "manager", provider: "claude", interventionId: null, reason: `r${id}` });
      store.update(entry.id, (current) => ({ ...current, state: "failed", ending: "no-compaction", endedAt: iso(T0) }));
    }
    await runnerOf(cli).turnRecorded(ended(mainTurn(100_000)), mainTurn(100_000), fake.paseo);
    expect(fake.creates).toHaveLength(1);
    expect(String(fake.creates[0]!.options.prompt)).toContain("two compactions in a row did not compact its context");
  });

  it("nothing while handoff is off, below the threshold, or for a Manager that is no open mission's Main", async () => {
    seeded();
    createCoordinationStore(home).set({ key: "main.compact", value: false });
    const fake = daemon();
    const { cli } = fakeCli();
    await runnerOf(cli).turnRecorded(ended(mainTurn(100_000)), mainTurn(100_000), fake.paseo);
    await runnerOf(cli).turnRecorded(ended(mainTurn()), { ...mainTurn(), agentId: "agent-other-manager" }, fake.paseo);
    createCoordinationStore(home).set({ key: "handoff.enabled", value: false });
    await runnerOf(cli).turnRecorded(ended(mainTurn()), mainTurn(), fake.paseo);
    expect(fake.creates).toEqual([]);
    expect(createMissionStore(home).get(MISSION)).toMatchObject({ mainId: MAIN });
  });
});
