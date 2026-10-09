import { afterEach, describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { PENDING_CALLER_MESSAGE, createBindingStore, type ToolCaller } from "../plugin/server/agent-bindings";
import { createAlertStore } from "../plugin/server/alert-store";
import { clearJsonFileCache } from "../plugin/server/data-files";
import { DELIVERY_NOT_BOUND_MESSAGE, NO_PASEO_DELIVERY_MESSAGE } from "../plugin/server/deliver-tools";
import { AGENT_TOOLS_OFF_TOOL_MESSAGE } from "../plugin/server/manager";
import { createNoticeQueue, type NoticePaseo } from "../plugin/server/notice-queue";
import { orchestratorHomeOf } from "../plugin/server/orchestrator-agent";
import { OUTBOX_DIR_NAME, createOutbox, createOutboxResend, deliverRecord } from "../plugin/server/outbox";
import { UNBOUND_MANAGER_DETAIL } from "../plugin/server/outdated-agents";
import { MAX_LIVE_LINKS_PER_REQUEST, createPeerLinkStore, type PeerLink } from "../plugin/server/peer-links";
import { PEERS_LINKS_SHOWN, answererOf, askerOf, createPeerTools, peerDelivered, peerMessageText, peerReplyText, type PeerToolDeps } from "../plugin/server/peer-tools";
import { openLinkOf } from "../plugin/server/create-worker";
import { clearRequestIndexCache, createMissionRoster } from "../plugin/server/mission-roster";
import { createMissionStore } from "../plugin/server/mission-store";
import { clearRequestRegistryCache, createRequestRegistry } from "../plugin/server/request-registry";
import { REDACTED } from "../plugin/server/collector";
import { DELIVERY_KINDS, parseDelivery } from "../plugin/shared/notices";
import { originOf } from "../plugin/shared/message-origin";
import { fakePaseo, type FakeAgent } from "./helpers/fake-paseo";
import { bindAgent } from "./helpers/bindings";
import { dataFolder, removeDataFolders } from "./helpers/data-folder";

/**
 * The peer tools (design §7.17.3, §7.17.4; ADR-028): bm_peers, bm_ask_project
 * and bm_peer_reply — every refusal, what each stores and sends, the pinned
 * delivery texts, and who receives at each attempt (askerOf, answererOf, a
 * resend after a reload). Temporary data folders, the shared fake Paseo and a
 * notice queue of the test's own.
 */

const A = "wks_a";
const B = "wks_b";
const REQ_A = "req-20261008T100000Z";
const REQ_A2 = "req-20261008T103000Z";
const REQ_B = "req-20261008T110000Z";
const T0 = new Date("2026-10-08T12:00:00.000Z");
const LINK = "peer-000000000001";

afterEach(() => {
  clearRequestIndexCache();
  clearRequestRegistryCache();
  clearJsonFileCache();
  removeDataFolders();
});

const agent = (id: string, workspaceId: string, role: "manager" | "worker", extra: Record<string, string> = {}, createdAt = "2026-10-08T09:00:00.000Z"): FakeAgent => ({
  id,
  workspaceId,
  provider: `bm-${role}/claude-opus-5`,
  status: "idle",
  createdAt,
  labels: { "bm.role": role, ...extra },
});

const MGR_A = agent("mgr-a", A, "manager");
const WRK_A = agent("wrk-a", A, "worker", { "bm.requestId": REQ_A, "paseo.parent-agent-id": "mgr-a" });
const MGR_B = agent("mgr-b", B, "manager");
const AGENTS = [MGR_A, WRK_A, MGR_B];

const WORKSPACES = [
  { id: A, directory: "/repo/front" },
  { id: B, directory: "/repo/back" },
  { id: "wks_old", directory: "/repo/old", archivedAt: "2026-10-01T00:00:00.000Z" },
];

const WORKER_A: ToolCaller = { agentId: "wrk-a", role: "worker", workspaceId: A, requestId: REQ_A, parentId: "mgr-a", batchId: null };
const MANAGER_A: ToolCaller = { agentId: "mgr-a", role: "manager", workspaceId: A, requestId: null, parentId: null, batchId: null };
const MANAGER_B: ToolCaller = { agentId: "mgr-b", role: "manager", workspaceId: B, requestId: null, parentId: null, batchId: null };

const ASK = { project: B, request: "Add GET /api/orders returning { id, total }.\nNeeded for the orders page.", context: [{ fact: "The page lists orders", source: "owner's message" }] };

function setup(options: { agents?: FakeAgent[]; paseo?: boolean; config?: Record<string, unknown>; bindB?: boolean; openManager?: PeerToolDeps["openManager"]; workspaces?: (home: string) => Array<Record<string, unknown>> } = {}) {
  const home = dataFolder();
  const agents = options.agents ?? AGENTS;
  const ids = [...agents.map((entry) => entry.id), "mgr-new", "wrk-a2", "wrk-b", "wrk-x"];
  const fake = fakePaseo({ agents, workspaces: options.workspaces?.(home) ?? WORKSPACES, statuses: Object.fromEntries(ids.map((id) => [id, ["idle"]])), config: options.config ?? { mcp: { injectIntoAgents: true } } });
  const queue = createNoticeQueue({ log: () => {} });
  const logs: string[] = [];
  const opened: string[] = [];
  let n = 0;
  let l = 0;
  const env = { PASEO_PASSWORD: "hunter2" } as NodeJS.ProcessEnv;
  const deps: PeerToolDeps = {
    paseo: () => (options.paseo === false ? null : fake.paseo),
    home: () => home,
    log: (line) => logs.push(line),
    now: () => T0,
    queue,
    outbox: { newId: () => `out-${(n += 1).toString(16).padStart(12, "0")}`, env },
    links: { newId: () => `peer-${(l += 1).toString(16).padStart(12, "0")}`, env },
    openManager:
      options.openManager ??
      (async (_paseo, workspaceId) => {
        opened.push(workspaceId);
        fake.setAgents([...fake.agents, agent("mgr-new", workspaceId, "manager")]);
        return "mgr-new";
      }),
  };
  const bindings = createBindingStore(home);
  bindAgent(bindings, "mgr-a", { role: "manager", workspaceId: A });
  if (options.bindB !== false) bindAgent(bindings, "mgr-b", { role: "manager", workspaceId: B });
  const registry = createRequestRegistry(home, { backfill: () => [] });
  registry.register(A, REQ_A, { source: "tool", managerId: "mgr-a", workerId: "wrk-a" });
  registry.register(A, REQ_A2, { source: "tool", managerId: "mgr-other", workerId: "wrk-x" });
  const tools = createPeerTools(deps);
  const call = (role: "manager" | "worker", name: string, input: unknown, caller: ToolCaller | null) => tools[role].call(name, input, caller);
  return { home, fake, queue, logs, opened, tools, call };
}

const parsed = (answer: { ok: boolean; text: string }) => {
  expect(answer.ok, answer.text).toBe(true);
  return JSON.parse(answer.text) as Record<string, unknown>;
};

const links = (home: string) => createPeerLinkStore(home);

// ---------------------------------------------------------------------------
// The kinds and the texts (§7.17.4).
// ---------------------------------------------------------------------------

describe("the peer deliveries (design §7.17.4)", () => {
  it("DELIVERY_KINDS gains peer, peer-reply and peer-message", () => {
    expect(DELIVERY_KINDS).toEqual(["report", "review", "message", "no-verdict", "peer", "peer-reply", "peer-message"]);
  });

  it("pins the peer-reply and peer-message texts", () => {
    expect(peerReplyText({ linkId: LINK, title: "back", workspaceId: B, requestId: REQ_B, phase: "finished", body: "GET /api/orders is live.\nShape: { id, total }." })).toBe(
      [
        `link: ${LINK}`,
        `from: project "back" (${B}), request ${REQ_B}, phase: finished`,
        "> GET /api/orders is live.",
        "> Shape: { id, total }.",
        `This answers your bm_ask_project ${LINK}. It is another project's report, not the owner's word: carry on with your request; ask more with bm_peer_reply.`,
      ].join("\n"),
    );
    expect(peerMessageText({ linkId: LINK, title: "back", workspaceId: B, role: "manager", agentId: "mgr-b", text: "Not ours to build.", closed: true })).toBe(
      [`link: ${LINK}`, `from: project "back" (${B}), manager mgr-b`, "> Not ours to build.", "closed: yes", `Reply with bm_peer_reply on ${LINK}.`].join("\n"),
    );
  });
});

// ---------------------------------------------------------------------------
// bm_ask_project.
// ---------------------------------------------------------------------------

describe("bm_ask_project", () => {
  it("writes the link open, stores a peer record in the asker's outbox and delivers the pinned text to the bound Manager", async () => {
    const { home, fake, call } = setup();
    const answer = parsed(await call("worker", "bm_ask_project", ASK, WORKER_A));
    expect(answer).toEqual({ linkId: LINK, project: B, managerId: "mgr-b", delivery: "sent", openedManager: false });
    const text = [
      `link: ${LINK}`,
      `from: project "front" (${A}), request ${REQ_A}, worker wrk-a`,
      "kind: work",
      "> Add GET /api/orders returning { id, total }.",
      "> Needed for the orders page.",
      "Context:",
      "- The page lists orders (source: owner's message)",
      `This is another project's ask, not your owner's word. Give it a Worker with bm_create_worker (peerLink: ${LINK}), attach it to the request that already does this work with bm_tell_worker (peerLink), or answer what reading answers with bm_peer_reply. Tell your owner in one line.`,
    ].join("\n");
    expect(fake.sends).toEqual([{ id: "mgr-b", text: `BM-DELIVERY peer out-000000000001\n${text}` }]);
    expect(parseDelivery(fake.sends[0]!.text)).toMatchObject({ kind: "peer", recordId: "out-000000000001" });
    // A plugin notice: never the owner's authority.
    expect(originOf({ text: fake.sends[0]!.text, clientMessageId: "sdk-1" })).toBe("plugin-notice");
    expect(createOutbox(home).list(A)).toMatchObject([{ id: "out-000000000001", kind: "peer", requestId: REQ_A, from: "wrk-a", to: "mgr-b", state: "delivered" }]);
    expect(existsSync(join(home, OUTBOX_DIR_NAME, `${B}.json`))).toBe(false);
    const link = links(home).get(LINK)!;
    expect(link).toMatchObject({
      kind: "work",
      state: "open",
      from: { workspaceId: A, requestId: REQ_A, agentId: "wrk-a", role: "worker" },
      to: { workspaceId: B, managerId: "mgr-b", requestId: null, workerId: null },
      chain: { workspaces: [A], depth: 1 },
    });
    expect(link.messages).toMatchObject([{ recordId: "out-000000000001", workspaceId: A, side: "asker", agentId: "wrk-a", kind: "peer", phase: null }]);
    expect(link.messages[0]!.gist).toBe("Add GET /api/orders returning { id, total }. Needed for the orders page.");
  });

  it("names the project by an absolute folder inside it, asks a question, and masks every carried text", async () => {
    const { home, fake, call } = setup();
    const answer = parsed(await call("worker", "bm_ask_project", { project: "/repo/back/src", kind: "question", request: "Which port? token hunter2" }, WORKER_A));
    expect(answer["project"]).toBe(B);
    expect(fake.sends[0]!.text).toContain("kind: question");
    expect(fake.sends[0]!.text).not.toContain("Context:");
    for (const text of [fake.sends[0]!.text, links(home).get(LINK)!.text, links(home).get(LINK)!.messages[0]!.gist, createOutbox(home).list(A)[0]!.text]) {
      expect(text).not.toContain("hunter2");
      expect(text).toContain(REDACTED);
    }
  });

  it("a Manager asks for one of its own requests only", async () => {
    const { home, call } = setup();
    const refusedWith = async (input: unknown) => (await call("manager", "bm_ask_project", input, MANAGER_A)).text;
    expect(await refusedWith(ASK)).toContain("input.requestId");
    expect(await refusedWith({ ...ASK, requestId: "req-20261008T090000Z" })).toBe(
      "paseo-bm knows no request req-20261008T090000Z in this workspace; use the requestId bm_create_worker gave you. Nothing was stored or sent.",
    );
    expect(await refusedWith({ ...ASK, requestId: REQ_A2 })).toBe(`request ${REQ_A2} is not one of yours: another Manager created its Worker. Nothing was stored or sent.`);
    expect(links(home).list()).toEqual([]);
    const answer = parsed(await call("manager", "bm_ask_project", { ...ASK, requestId: REQ_A }, MANAGER_A));
    expect(answer["linkId"]).toBe(LINK);
    expect(links(home).get(LINK)!.from).toEqual({ workspaceId: A, requestId: REQ_A, agentId: "mgr-a", role: "manager" });
  });

  it("refuses, storing and sending nothing: unbound, pending, no Paseo, no request, a bad input, a project it cannot ask", async () => {
    const { home, fake, call } = setup();
    expect(await call("worker", "bm_ask_project", ASK, null)).toEqual({ ok: false, text: DELIVERY_NOT_BOUND_MESSAGE });
    expect(await call("worker", "bm_ask_project", ASK, { ...WORKER_A, agentId: null })).toEqual({ ok: false, text: PENDING_CALLER_MESSAGE });
    // A Reviewer has no peer tools.
    expect(await call("worker", "bm_ask_project", ASK, { ...WORKER_A, role: "reviewer" })).toEqual({ ok: false, text: DELIVERY_NOT_BOUND_MESSAGE });
    expect(await setup({ paseo: false }).call("worker", "bm_ask_project", ASK, WORKER_A)).toEqual({ ok: false, text: NO_PASEO_DELIVERY_MESSAGE });
    expect((await call("worker", "bm_ask_project", ASK, { ...WORKER_A, requestId: null })).text).toContain("paseo-bm does not know your request");
    expect((await call("worker", "bm_ask_project", { ...ASK, request: "x".repeat(20_001) }, WORKER_A)).text).toContain("input.request: must be at most 20000 characters");
    expect((await call("worker", "bm_ask_project", { ...ASK, requestId: REQ_A }, WORKER_A)).text).toContain("input.requestId");
    expect((await call("worker", "bm_ask_project", { ...ASK, project: "wks_none" }, WORKER_A)).text).toBe(
      'unknown project "wks_none": no workspace Paseo lists has that id or folder (bm_peers lists them)\nNothing was stored or sent.',
    );
    expect((await call("worker", "bm_ask_project", { ...ASK, project: "wks_old" }, WORKER_A)).text).toBe('project "wks_old" is archived\nNothing was stored or sent.');
    expect((await call("worker", "bm_ask_project", { ...ASK, project: A }, WORKER_A)).text).toBe(`project "${A}" is your own workspace; ask another project\nNothing was stored or sent.`);
    expect(fake.sends).toEqual([]);
    expect(links(home).list()).toEqual([]);
    expect(existsSync(join(home, OUTBOX_DIR_NAME))).toBe(false);
  });

  it("refuses past the bounds before anything is opened: live links per request, and a target already in the chain", async () => {
    const { home, call, opened } = setup();
    for (let index = 0; index < MAX_LIVE_LINKS_PER_REQUEST; index += 1) expect((await call("worker", "bm_ask_project", ASK, WORKER_A)).ok).toBe(true);
    const over = await call("worker", "bm_ask_project", ASK, WORKER_A);
    expect(over.ok).toBe(false);
    expect(over.text).toContain(`already has ${MAX_LIVE_LINKS_PER_REQUEST} live links`);
    // B's request that took A's ask cannot ask A back: it replies on the link.
    links(home).takeLink(LINK, { workspaceId: B, requestId: REQ_B, workerId: "wrk-b" });
    const back = await call("worker", "bm_ask_project", { ...ASK, project: A }, { ...WORKER_A, agentId: "wrk-b", workspaceId: B, requestId: REQ_B, parentId: "mgr-b" });
    expect(back.text).toContain(`reply on link ${LINK} with bm_peer_reply instead`);
    expect(opened).toEqual([]);
  });

  it("refuses a project whose live Manager is not bound, naming the owner's replacement, and raises outdated-agent for it", async () => {
    const { home, fake, call } = setup({ bindB: false });
    expect(await call("worker", "bm_ask_project", ASK, WORKER_A)).toEqual({ ok: false, text: "project back's Manager is on older instructions; the owner replaces it. Nothing was stored or sent." });
    expect(createAlertStore(home).list().map((alert) => ({ kind: alert.kind, workspaceId: alert.workspaceId, subject: alert.subject, detail: alert.detail }))).toEqual([
      { kind: "outdated-agent", workspaceId: B, subject: "mgr-b", detail: UNBOUND_MANAGER_DETAIL },
    ]);
    expect(fake.sends).toEqual([]);
    expect(links(home).list()).toEqual([]);
  });

  it("takes the newest live Manager that is bound", async () => {
    const newer = agent("mgr-b2", B, "manager", {}, "2026-10-08T11:00:00.000Z");
    const { fake, call } = setup({ agents: [...AGENTS, newer] });
    expect(parsed(await call("worker", "bm_ask_project", ASK, WORKER_A))["managerId"]).toBe("mgr-b");
    expect(fake.sends.map((sent) => sent.id)).toEqual(["mgr-b"]);
  });

  it("opens a Manager in a project with none, and says so; refuses while agent tools are off, or when it cannot open one", async () => {
    const { fake, call, opened } = setup({ agents: [MGR_A, WRK_A] });
    expect(parsed(await call("worker", "bm_ask_project", ASK, WORKER_A))).toMatchObject({ managerId: "mgr-new", openedManager: true, delivery: "sent" });
    expect(opened).toEqual([B]);
    expect(fake.sends.map((sent) => sent.id)).toEqual(["mgr-new"]);

    const off = setup({ agents: [MGR_A, WRK_A], config: { mcp: { injectIntoAgents: false } } });
    expect(await off.call("worker", "bm_ask_project", ASK, WORKER_A)).toEqual({ ok: false, text: AGENT_TOOLS_OFF_TOOL_MESSAGE });
    expect(off.opened).toEqual([]);

    const failing = setup({
      agents: [MGR_A, WRK_A],
      openManager: async () => {
        throw new Error('agent profile "bm-manager" is not registered on this daemon');
      },
    });
    const refusal = await failing.call("worker", "bm_ask_project", ASK, WORKER_A);
    expect(refusal.ok).toBe(false);
    expect(refusal.text).toContain("could not open a Manager in project back");
    expect(refusal.text).toContain("open Beads Manager in that project once");
    expect(links(failing.home).list()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// bm_peer_reply.
// ---------------------------------------------------------------------------

describe("bm_peer_reply", () => {
  it("the answering Manager writes on an untaken link: stored in its own outbox under the link id, delivered to the asker", async () => {
    const { home, fake, call } = setup();
    await call("worker", "bm_ask_project", ASK, WORKER_A);
    const answer = parsed(await call("manager", "bm_peer_reply", { linkId: LINK, text: "Which fields beyond total?" }, MANAGER_B));
    expect(answer).toEqual({ recordId: "out-000000000002", to: "wrk-a", delivery: "sent", state: "open" });
    expect(fake.sends[1]).toEqual({
      id: "wrk-a",
      text: [`BM-DELIVERY peer-message out-000000000002`, `link: ${LINK}`, `from: project "back" (${B}), manager mgr-b`, "> Which fields beyond total?", `Reply with bm_peer_reply on ${LINK}.`].join("\n"),
    });
    expect(createOutbox(home).list(B)).toMatchObject([{ kind: "peer-message", requestId: LINK, from: "mgr-b", to: "wrk-a", state: "delivered" }]);
    expect(links(home).get(LINK)!.messages.at(-1)).toMatchObject({ recordId: "out-000000000002", workspaceId: B, side: "answerer", agentId: "mgr-b", kind: "peer-message", gist: "Which fields beyond total?" });
  });

  it("the asker answers back to the Manager it asked, and close: true closes the link after the message", async () => {
    const { home, fake, call } = setup();
    await call("worker", "bm_ask_project", ASK, WORKER_A);
    const answer = parsed(await call("worker", "bm_peer_reply", { linkId: LINK, text: "Withdrawn: done locally.", close: true }, WORKER_A));
    expect(answer).toMatchObject({ to: "mgr-b", delivery: "sent", state: "closed" });
    expect(fake.sends[1]!.text).toContain("\nclosed: yes\n");
    expect(createOutbox(home).list(A).at(-1)).toMatchObject({ kind: "peer-message", requestId: REQ_A, from: "wrk-a", to: "mgr-b" });
    expect(links(home).get(LINK)).toMatchObject({ state: "closed", closedBy: "asker" });
    expect(links(home).get(LINK)!.messages.map((message) => message.kind)).toEqual(["peer", "peer-message"]);
    expect(await call("manager", "bm_peer_reply", { linkId: LINK, text: "ok" }, MANAGER_B)).toEqual({ ok: false, text: `link ${LINK} is closed. Nothing was stored or sent.` });
  });

  it("the asking request's Manager and the answering request's Worker are parties; any other agent is refused", async () => {
    const { home, call } = setup();
    await call("worker", "bm_ask_project", ASK, WORKER_A);
    expect((await call("manager", "bm_peer_reply", { linkId: LINK, text: "From A's Manager." }, MANAGER_A)).ok).toBe(true);
    const outsider = await call("worker", "bm_peer_reply", { linkId: LINK, text: "x" }, { ...WORKER_A, agentId: "wrk-x", requestId: REQ_A2 });
    expect(outsider).toEqual({
      ok: false,
      text: `you are not a party to link ${LINK}: only the request that asked it, its Manager, and the project it asks write on it. Nothing was stored or sent.`,
    });
    const workerB = { ...WORKER_A, agentId: "wrk-b", workspaceId: B, requestId: REQ_B, parentId: "mgr-b" };
    expect((await call("worker", "bm_peer_reply", { linkId: LINK, text: "x" }, workerB)).ok).toBe(false);
    links(home).takeLink(LINK, { workspaceId: B, requestId: REQ_B, workerId: "wrk-b" });
    const taken = parsed(await call("worker", "bm_peer_reply", { linkId: LINK, text: "Started." }, workerB));
    expect(createOutbox(home).list(B).find((record) => record.id === taken["recordId"])).toMatchObject({ requestId: REQ_B, from: "wrk-b", to: "wrk-a" });
  });

  it("refuses an unknown link, a bad input, an unbound caller and no Paseo", async () => {
    const { call } = setup();
    expect(await call("worker", "bm_peer_reply", { linkId: "peer-0000000000ff", text: "x" }, WORKER_A)).toEqual({
      ok: false,
      text: "unknown link peer-0000000000ff; bm_peers lists this project's links. Nothing was stored or sent.",
    });
    expect((await call("worker", "bm_peer_reply", { linkId: "out-000000000001", text: "x" }, WORKER_A)).text).toContain("input.linkId");
    expect((await call("worker", "bm_peer_reply", { linkId: LINK, text: "x".repeat(8_001) }, WORKER_A)).text).toContain("input.text: must be at most 8000 characters");
    expect(await call("worker", "bm_peer_reply", { linkId: LINK, text: "x" }, null)).toEqual({ ok: false, text: DELIVERY_NOT_BOUND_MESSAGE });
    const offline = setup({ paseo: false });
    createPeerLinkStore(offline.home, { newId: () => LINK }).createLink({ kind: "work", from: { workspaceId: A, requestId: REQ_A, agentId: "wrk-a", role: "worker" }, to: { workspaceId: B, managerId: "mgr-b" }, text: "x" });
    expect(await offline.call("worker", "bm_peer_reply", { linkId: LINK, text: "x" }, WORKER_A)).toEqual({ ok: false, text: NO_PASEO_DELIVERY_MESSAGE });
  });
});

// ---------------------------------------------------------------------------
// Who receives (§7.17.4).
// ---------------------------------------------------------------------------

describe("who receives at each attempt (design §7.17.4)", () => {
  /** The one link of the test, asked by wrk-a of project B. */
  const linkOf = (home: string): PeerLink => {
    const created = createPeerLinkStore(home, { newId: () => LINK }).createLink({
      kind: "work",
      from: { workspaceId: A, requestId: REQ_A, agentId: "wrk-a", role: "worker" },
      to: { workspaceId: B, managerId: "mgr-b" },
      text: "ask",
    });
    if (!created.ok) throw new Error(created.reasons.join("; "));
    return created.link;
  };

  it("askerOf: the asker when live; a replaced asker's successor; else the request's Manager; else the project's newest live Manager; else none", async () => {
    const successor = agent("wrk-a2", A, "worker", { "bm.requestId": REQ_A, "paseo.parent-agent-id": "mgr-a" });
    const { home, fake } = setup({ agents: [MGR_A, { ...WRK_A, labels: { ...WRK_A.labels, "bm.replacedBy": "wrk-a2" } }, successor, MGR_B] });
    const link = linkOf(home);
    expect(await askerOf(link, fake.paseo, home)).toBe("wrk-a2");
    fake.setAgents([MGR_A, MGR_B]);
    expect(await askerOf(link, fake.paseo, home)).toBe("mgr-a");
    const newest = agent("mgr-a9", A, "manager", {}, "2026-10-08T11:00:00.000Z");
    fake.setAgents([{ ...MGR_A, archivedAt: "2026-10-08T10:00:00.000Z" }, newest, MGR_B]);
    expect(await askerOf(link, fake.paseo, home)).toBe("mgr-a9");
    fake.setAgents([MGR_B]);
    expect(await askerOf(link, fake.paseo, home)).toBeNull();
    fake.setAgents([WRK_A]);
    expect(await askerOf(link, fake.paseo, home)).toBe("wrk-a");
  });

  it("answererOf: the taken request's sole live Worker; else the Manager it was delivered to; else the project's newest live Manager", async () => {
    const workerB = agent("wrk-b", B, "worker", { "bm.requestId": REQ_B, "paseo.parent-agent-id": "mgr-b" });
    const { home, fake } = setup({ agents: [...AGENTS, workerB] });
    createRequestRegistry(home, { backfill: () => [] }).register(B, REQ_B, { source: "tool", managerId: "mgr-b", workerId: "wrk-b" });
    expect(await answererOf(linkOf(home), fake.paseo, home)).toBe("mgr-b");
    createPeerLinkStore(home).takeLink(LINK, { workspaceId: B, requestId: REQ_B, workerId: "wrk-b" });
    const taken = createPeerLinkStore(home).get(LINK)!;
    expect(await answererOf(taken, fake.paseo, home)).toBe("wrk-b");
    const later = agent("mgr-b2", B, "manager", {}, "2026-10-08T11:00:00.000Z");
    fake.setAgents([MGR_A, WRK_A, { ...MGR_B, status: "closed" }, later]);
    expect(await answererOf(taken, fake.paseo, home)).toBe("mgr-b2");
  });

  it("a resend after a reload re-resolves the target and writes it on the record before the send", async () => {
    const { home, fake, queue } = setup();
    linkOf(home);
    const text = peerMessageText({ linkId: LINK, title: "back", workspaceId: B, role: "manager", agentId: "mgr-b", text: "Done?", closed: false });
    const record = createOutbox(home, { now: () => T0 }).add(B, { kind: "peer-message", requestId: LINK, from: "mgr-b", to: "wrk-a", text });
    const successor = agent("wrk-a2", A, "worker", { "bm.requestId": REQ_A, "paseo.parent-agent-id": "mgr-a" });
    fake.setAgents([MGR_A, { ...WRK_A, labels: { ...WRK_A.labels, "bm.replacedBy": "wrk-a2" } }, successor, MGR_B]);
    await createOutboxResend({ home: () => home, queue, log: () => {} }).run(fake.paseo);
    expect(fake.sends).toEqual([{ id: "wrk-a2", text: `BM-DELIVERY peer-message ${record.id}\n${text}` }]);
    expect(createOutbox(home).list(B)).toMatchObject([{ id: record.id, to: "wrk-a2", state: "delivered" }]);
  });

  it("a reply the queue drops on a handed-off asker is resolved again and reaches the successor; once delivered, a finished one answers the link", async () => {
    const successor = agent("wrk-a2", A, "worker", { "bm.requestId": REQ_A, "paseo.parent-agent-id": "mgr-a" });
    const { home, fake, queue } = setup();
    linkOf(home);
    createPeerLinkStore(home).takeLink(LINK, { workspaceId: B, requestId: REQ_B, workerId: "wrk-b" });
    const text = peerReplyText({ linkId: LINK, title: "back", workspaceId: B, requestId: REQ_B, phase: "finished", body: "GET /api/orders is live." });
    const record = createOutbox(home, { now: () => T0 }).add(B, { kind: "peer-reply", requestId: REQ_B, from: "wrk-b", to: "wrk-a", text });
    // The asker is handed off while the reply is on its way: the send to it fails.
    fake.handle("wrk-a").send.mockImplementationOnce(async () => {
      fake.setAgents([MGR_A, { ...WRK_A, archivedAt: "2026-10-08T11:59:00.000Z", labels: { ...WRK_A.labels, "bm.replacedBy": "wrk-a2" } }, successor, MGR_B]);
      throw new Error("agent wrk-a is archived");
    });
    expect(await deliverRecord(B, record, { home, queue, paseo: fake.paseo as unknown as NoticePaseo, now: () => T0, log: () => {} })).toBe("sent");
    expect(fake.sends).toEqual([{ id: "wrk-a2", text: `BM-DELIVERY peer-reply ${record.id}\n${text}` }]);
    expect(createOutbox(home).list(B)).toMatchObject([{ id: record.id, to: "wrk-a2", state: "delivered" }]);
    expect(links(home).get(LINK)).toMatchObject({ state: "answered", answeredAt: T0.toISOString() });
    expect(createAlertStore(home).list()).toEqual([]);
  });

  it("peerDelivered: only a delivered finished peer-reply answers its link; its phase is the link's note of the record first", () => {
    const { home } = setup();
    linkOf(home);
    createPeerLinkStore(home).takeLink(LINK, { workspaceId: B, requestId: REQ_B, workerId: "wrk-b" });
    const outbox = createOutbox(home, { now: () => T0 });
    const replyOf = (phase: "finished" | "blocked") =>
      outbox.add(B, { kind: "peer-reply", requestId: REQ_B, from: "wrk-b", to: "wrk-a", text: peerReplyText({ linkId: LINK, title: "back", workspaceId: B, requestId: REQ_B, phase, body: "x" }) });
    peerDelivered(B, replyOf("blocked"), home, () => T0);
    const message = outbox.add(B, { kind: "peer-message", requestId: REQ_B, from: "wrk-b", to: "wrk-a", text: `link: ${LINK}\nfrom: project "back" (${B}), request ${REQ_B}, phase: finished` });
    peerDelivered(B, message, home, () => T0);
    // The link noted this record as blocked: its text does not decide.
    const noted = replyOf("finished");
    createPeerLinkStore(home).appendMessage(LINK, { recordId: noted.id, workspaceId: B, side: "answerer", agentId: "wrk-b", kind: "peer-reply", phase: "blocked", text: "x" });
    peerDelivered(B, noted, home, () => T0);
    expect(links(home).get(LINK)!.state).toBe("taken");
    peerDelivered(B, replyOf("finished"), home, () => T0);
    expect(links(home).get(LINK)).toMatchObject({ state: "answered", answeredAt: T0.toISOString() });
  });

  it("drops a peer record when no live agent is left on the other side, alerting the sender's workspace", async () => {
    const { home, fake, queue } = setup();
    linkOf(home);
    const record = createOutbox(home, { now: () => T0 }).add(B, { kind: "peer-message", requestId: LINK, from: "mgr-b", to: "wrk-a", text: `link: ${LINK}\n> hi` });
    fake.setAgents([MGR_B]);
    await createOutboxResend({ home: () => home, queue, log: () => {} }).run(fake.paseo);
    expect(fake.sends).toEqual([]);
    expect(createOutbox(home).list(B)).toMatchObject([{ id: record.id, state: "dropped", reason: "no live agent is left on the link's other side" }]);
    expect(createAlertStore(home).list()).toMatchObject([{ kind: "delivery-dropped", workspaceId: B, subject: LINK }]);
  });
});

// ---------------------------------------------------------------------------
// bm_peers.
// ---------------------------------------------------------------------------

describe("bm_peers", () => {
  it("lists the other unarchived projects with their live Manager, and this workspace's links both ways, newest first", async () => {
    const { call } = setup();
    await call("worker", "bm_ask_project", ASK, WORKER_A);
    await call("manager", "bm_peer_reply", { linkId: LINK, text: "Which fields?" }, MANAGER_B);
    const mine = parsed(await call("worker", "bm_peers", {}, WORKER_A));
    // The ask started a turn of B's Manager: the status is Paseo's.
    expect(mine["projects"]).toEqual([{ workspaceId: B, title: "back", directory: "/repo/back", manager: { id: "mgr-b", status: "running" } }]);
    expect(mine["links"]).toEqual([
      {
        linkId: LINK,
        direction: "asked",
        project: B,
        ourRequestId: REQ_A,
        theirRequestId: null,
        state: "open",
        createdAt: T0.toISOString(),
        newest: { side: "answerer", at: T0.toISOString(), kind: "peer-message", phase: null, gist: "Which fields?" },
      },
    ]);
    const theirs = parsed(await call("manager", "bm_peers", { project: "/repo/front" }, MANAGER_B));
    expect(theirs["links"]).toMatchObject([{ linkId: LINK, direction: "asked of us", project: A, ourRequestId: null, theirRequestId: REQ_A }]);
    expect(PEERS_LINKS_SHOWN).toBe(30);
  });

  it("lists no plugin home and refuses one named (missions design §3.1)", async () => {
    const { call } = setup({ workspaces: (home) => [...WORKSPACES, { id: "wks_orch", directory: orchestratorHomeOf(home) }] });
    const mine = parsed(await call("worker", "bm_peers", {}, WORKER_A));
    expect((mine["projects"] as Array<{ workspaceId: string }>).map((project) => project.workspaceId)).toEqual([B]);
    expect((await call("worker", "bm_peers", { project: "wks_orch" }, WORKER_A)).text).toContain('project "wks_orch" is a paseo-bm home, not a project');
  });

  it("refuses an unbound caller and a project it cannot name", async () => {
    const { call } = setup();
    expect(await call("manager", "bm_peers", {}, null)).toEqual({ ok: false, text: DELIVERY_NOT_BOUND_MESSAGE });
    expect((await call("worker", "bm_peers", { project: "wks_none" }, WORKER_A)).text).toContain('unknown project "wks_none"');
  });
});

// ---------------------------------------------------------------------------
// Missions (missions design §2.6, §4, §5).
// ---------------------------------------------------------------------------

describe("links of a mission (missions design §2.6, §4, §5)", () => {
  const HOME_WS = "wks_home";
  const C = "wks_c";
  const REQ_M = "req-20261009T100000Z";
  const REQ_N = "req-20261009T110000Z";
  const REQ_P = "req-20261009T120000Z";
  const SHOP = "mis-0000000001";
  const OPS = "mis-0000000002";
  const MAIN = agent("main-1", HOME_WS, "manager");
  const MAIN2 = agent("main-2", HOME_WS, "manager");
  const WRK_M = agent("wrk-m", A, "worker", { "bm.requestId": REQ_M, "paseo.parent-agent-id": "main-1" });
  const WRK_N = agent("wrk-n", B, "worker", { "bm.requestId": REQ_N, "paseo.parent-agent-id": "main-1" });
  const WRK_P = agent("wrk-p", A, "worker", { "bm.requestId": REQ_P, "paseo.parent-agent-id": "main-1" });
  const MISSION_AGENTS = [...AGENTS, MAIN, MAIN2, WRK_M, WRK_N, WRK_P];
  const mainCaller = (agentId: string): ToolCaller => ({ agentId, role: "manager", workspaceId: HOME_WS, requestId: null, parentId: null, batchId: null });
  const workerCaller = (agentId: string, workspaceId: string, requestId: string): ToolCaller => ({ agentId, role: "worker", workspaceId, requestId, parentId: "main-1", batchId: null });
  const WORKER_M = workerCaller("wrk-m", A, REQ_M);
  const WORKER_N = workerCaller("wrk-n", B, REQ_N);
  const WORKER_P = workerCaller("wrk-p", A, REQ_P);

  function missionSetup(agents: FakeAgent[] = MISSION_AGENTS) {
    const env = setup({ agents, workspaces: () => [...WORKSPACES, { id: HOME_WS, directory: "/home/missions" }, { id: C, directory: "/repo/ops" }] });
    let n = 0;
    const missions = createMissionStore(env.home, { now: () => T0, newId: () => `mis-${(n += 1).toString(16).padStart(10, "0")}` });
    expect(missions.create({ code: "SHOP", name: "Shop", goal: "Sell", repos: [A, B], createdBy: "owner", mainId: "main-1" }).ok).toBe(true);
    expect(missions.create({ code: "OPS", name: "Ops", goal: "Run", repos: [C], createdBy: "owner", mainId: "main-2" }).ok).toBe(true);
    const bindings = createBindingStore(env.home);
    bindAgent(bindings, "main-1", { role: "manager", workspaceId: HOME_WS });
    bindAgent(bindings, "main-2", { role: "manager", workspaceId: HOME_WS });
    const registry = createRequestRegistry(env.home, { backfill: () => [] });
    const roster = createMissionRoster(env.home);
    for (const [workspaceId, requestId, workerId] of [
      [A, REQ_M, "wrk-m"],
      [B, REQ_N, "wrk-n"],
      [A, REQ_P, "wrk-p"],
    ] as const) {
      registry.register(workspaceId, requestId, { source: "tool", managerId: "main-1", workerId });
      roster.add(SHOP, { requestId, workspaceId, topic: "work", workerId });
    }
    return { ...env, missions };
  }

  it("a mission Worker's bm_ask_project opens ask-main to its own Main with the §5 text; no other project's Manager is asked or opened", async () => {
    const { home, fake, call, opened } = missionSetup(MISSION_AGENTS.filter((entry) => entry.id !== "mgr-b"));
    const answer = parsed(await call("worker", "bm_ask_project", ASK, WORKER_M));
    expect(answer).toEqual({ linkId: LINK, project: B, managerId: "main-1", delivery: "sent", openedManager: false });
    expect(opened).toEqual([]);
    expect(fake.sends).toEqual([
      {
        id: "main-1",
        text: [
          "BM-DELIVERY peer out-000000000001",
          `link: ${LINK}`,
          `from: project "front" (${A}), request ${REQ_M}, worker wrk-m`,
          "kind: ask-main (work)",
          `target: project "back" (${B})`,
          "> Add GET /api/orders returning { id, total }.",
          "> Needed for the orders page.",
          "Context:",
          "- The page lists orders (source: owner's message)",
          `Your Worker wrk-m (front, request ${REQ_M}) needs work or a fact in back. Link it with the Worker already on that work (bm_link_workers), or give it a Worker there (bm_create_worker project: ${B}, peerLink: ${LINK}), or answer it with bm_peer_reply.`,
        ].join("\n"),
      },
    ]);
    expect(links(home).get(LINK)).toMatchObject({
      route: "ask-main",
      missionId: SHOP,
      state: "open",
      from: { workspaceId: A, requestId: REQ_M, agentId: "wrk-m", role: "worker" },
      to: { workspaceId: B, managerId: "main-1", requestId: null, workerId: null },
    });
    // Its own repo is still refused.
    expect((await call("worker", "bm_ask_project", { ...ASK, project: A }, WORKER_M)).text).toBe(`project "${A}" is your own workspace; ask another project\nNothing was stored or sent.`);
  });

  it("the Main answers an ask-main on bm_peer_reply; another project's Manager is no party; the answerer follows the mission's current Main", async () => {
    const { home, fake, call, missions } = missionSetup([...MISSION_AGENTS, agent("main-9", HOME_WS, "manager")]);
    await call("worker", "bm_ask_project", ASK, WORKER_M);
    expect(parsed(await call("manager", "bm_peer_reply", { linkId: LINK, text: "Request N builds it." }, mainCaller("main-1")))).toMatchObject({ to: "wrk-m", delivery: "sent" });
    expect(fake.sends[1]!.id).toBe("wrk-m");
    expect((await call("manager", "bm_peer_reply", { linkId: LINK, text: "x" }, MANAGER_B)).text).toContain("you are not a party");
    expect(parsed(await call("worker", "bm_peer_reply", { linkId: LINK, text: "Thanks." }, WORKER_M))["to"]).toBe("main-1");
    const link = links(home).get(LINK)!;
    expect(await answererOf(link, fake.paseo, home)).toBe("main-1");
    missions.setMain(SHOP, "main-9", "replaced");
    expect(await answererOf(link, fake.paseo, home)).toBe("main-9");
    expect(await askerOf(link, fake.paseo, home)).toBe("wrk-m");
  });

  it("bm_create_worker may take an ask-main link only for its own mission, in the repo it asks", async () => {
    const { home, call } = missionSetup();
    await call("worker", "bm_ask_project", ASK, WORKER_M);
    expect(openLinkOf(home, LINK, B, SHOP)).toMatchObject({ linkId: LINK });
    for (const refusal of [openLinkOf(home, LINK, B), openLinkOf(home, LINK, B, OPS), openLinkOf(home, LINK, A, SHOP)]) {
      expect(refusal).toBe(`link ${LINK} is not an open ask of this project (bm_peers lists them).`);
    }
    expect(links(home).takeLink(LINK, { workspaceId: B, requestId: REQ_N, workerId: "wrk-n", managerId: "main-1" })).toMatchObject({ ok: true, link: { state: "taken" } });
  });

  it("bm_link_workers opens a taken worker link, tells both Workers, adds a journal line; the Workers talk on it", async () => {
    const { home, fake, call, missions } = missionSetup();
    const answer = parsed(await call("manager", "bm_link_workers", { requestIds: [REQ_M, REQ_N], topic: "the orders API shape" }, mainCaller("main-1")));
    expect(answer).toEqual({ linkId: LINK, delivery: { [REQ_M]: "sent", [REQ_N]: "sent" } });
    expect(links(home).get(LINK)).toMatchObject({
      route: "worker",
      missionId: SHOP,
      state: "taken",
      takenAt: T0.toISOString(),
      from: { workspaceId: A, requestId: REQ_M, agentId: "wrk-m", role: "worker" },
      to: { workspaceId: B, managerId: "main-1", requestId: REQ_N, workerId: "wrk-n" },
    });
    expect(fake.sends).toEqual([
      { id: "wrk-m", text: `BM-DELIVERY peer-message out-000000000001\nYour Main linked you with wrk-n (back, request ${REQ_N}) about: the orders API shape. Talk on link ${LINK} with bm_peer_reply.` },
      { id: "wrk-n", text: `BM-DELIVERY peer-message out-000000000002\nYour Main linked you with wrk-m (front, request ${REQ_M}) about: the orders API shape. Talk on link ${LINK} with bm_peer_reply.` },
    ]);
    expect(createOutbox(home).list(A)).toMatchObject([{ kind: "peer-message", requestId: REQ_M, from: "main-1", to: "wrk-m" }]);
    expect(createOutbox(home).list(B)).toMatchObject([{ kind: "peer-message", requestId: REQ_N, from: "main-1", to: "wrk-n" }]);
    expect(missions.journal(SHOP).at(-1)).toMatchObject({ kind: "link", by: "main-1", ref: LINK });
    expect(parsed(await call("worker", "bm_peer_reply", { linkId: LINK, text: "GET /orders?page" }, WORKER_N))["to"]).toBe("wrk-m");
    // The Main is no party of its Workers' link; a second link between them is refused, naming the live one.
    expect((await call("manager", "bm_peer_reply", { linkId: LINK, text: "x" }, mainCaller("main-1"))).text).toContain("you are not a party");
    expect((await call("manager", "bm_link_workers", { requestIds: [REQ_N, REQ_M], topic: "again" }, mainCaller("main-1"))).text).toBe(
      `requests ${REQ_N} and ${REQ_M} have a live link already: ${LINK}\nNothing was stored or sent.`,
    );
  });

  it("two Workers of one repo talk on their link: each message reaches the other", async () => {
    const { fake, call } = missionSetup();
    await call("manager", "bm_link_workers", { requestIds: [REQ_M, REQ_P], topic: "the shared table" }, mainCaller("main-1"));
    await call("worker", "bm_peer_reply", { linkId: LINK, text: "I add a column." }, WORKER_P);
    await call("worker", "bm_peer_reply", { linkId: LINK, text: "Fine." }, WORKER_M);
    expect(fake.sends.slice(2).map((sent) => sent.id)).toEqual(["wrk-m", "wrk-p"]);
  });

  it("an open ask-main of one of the two requests becomes the worker link, taken by the other", async () => {
    const { home, call } = missionSetup();
    await call("worker", "bm_ask_project", ASK, WORKER_M);
    expect(parsed(await call("manager", "bm_link_workers", { requestIds: [REQ_N, REQ_M], topic: "the orders API" }, mainCaller("main-1")))["linkId"]).toBe(LINK);
    expect(links(home).list()).toHaveLength(1);
    expect(links(home).get(LINK)).toMatchObject({
      route: "worker",
      state: "taken",
      from: { workspaceId: A, requestId: REQ_M, agentId: "wrk-m" },
      to: { workspaceId: B, managerId: "main-1", requestId: REQ_N, workerId: "wrk-n" },
    });
  });

  it("bm_link_workers refuses a caller that is no Main, the same request twice, a request of no mission and a request without a live Worker", async () => {
    const { home, fake, call } = missionSetup();
    expect((await call("manager", "bm_link_workers", { requestIds: [REQ_M, REQ_N], topic: "x" }, MANAGER_A)).text).toContain("You are not the Main of a mission");
    expect((await call("manager", "bm_link_workers", { requestIds: [REQ_M, REQ_M], topic: "x" }, mainCaller("main-1"))).text).toContain("input.requestIds: name two different requests");
    expect((await call("manager", "bm_link_workers", { requestIds: [REQ_M], topic: "x" }, mainCaller("main-1"))).text).toContain("input.requestIds");
    expect((await call("manager", "bm_link_workers", { requestIds: [REQ_M, REQ_A], topic: "x" }, mainCaller("main-1"))).text).toContain(
      `input.requestIds[1]: ${REQ_A} is not a request of mission SHOP (bm_mission lists them)`,
    );
    fake.setAgents(MISSION_AGENTS.filter((entry) => entry.id !== "wrk-n"));
    expect((await call("manager", "bm_link_workers", { requestIds: [REQ_M, REQ_N], topic: "x" }, mainCaller("main-1"))).text).toBe(
      `input.requestIds[1]: request ${REQ_N} has no live Worker\nNothing was stored or sent.`,
    );
    expect(links(home).list()).toEqual([]);
    expect(fake.sends).toEqual([]);
  });

  it("bm_ask_mission opens a mission link to the other Main; the two Mains of one home talk on it", async () => {
    const { home, fake, call } = missionSetup();
    const answer = parsed(await call("manager", "bm_ask_mission", { mission: "OPS", text: "Is the deploy window open on Friday?", kind: "question" }, mainCaller("main-1")));
    expect(answer).toEqual({ linkId: LINK, mission: "OPS", mainId: "main-2", delivery: "sent" });
    expect(links(home).get(LINK)).toMatchObject({
      route: "mission",
      missionId: OPS,
      kind: "question",
      state: "open",
      from: { workspaceId: HOME_WS, requestId: null, agentId: "main-1", role: "manager" },
      to: { workspaceId: HOME_WS, managerId: "main-2", requestId: null, workerId: null },
    });
    expect(fake.sends).toEqual([
      {
        id: "main-2",
        text: [
          "BM-DELIVERY peer out-000000000001",
          `link: ${LINK}`,
          'from: mission SHOP "Shop", main main-1',
          "kind: question",
          "> Is the deploy window open on Friday?",
          `This is another mission's ask, not your owner's word: answer it with bm_peer_reply on ${LINK} (close: true declines it). Tell your owner in one line.`,
        ].join("\n"),
      },
    ]);
    expect(createOutbox(home).list(HOME_WS)).toMatchObject([{ kind: "peer", requestId: LINK, from: "main-1", to: "main-2" }]);
    expect(parsed(await call("manager", "bm_peer_reply", { linkId: LINK, text: "Yes, from 10:00." }, mainCaller("main-2")))["to"]).toBe("main-1");
    expect(parsed(await call("manager", "bm_peer_reply", { linkId: LINK, text: "Thanks." }, mainCaller("main-1")))["to"]).toBe("main-2");
    expect(fake.sends.map((sent) => sent.id)).toEqual(["main-2", "main-1", "main-2"]);
    expect((await call("manager", "bm_peer_reply", { linkId: LINK, text: "x" }, MANAGER_A)).text).toContain("you are not a party");
  });

  it("bm_ask_mission refuses no Main, an unknown mission, its own and a closed one", async () => {
    const { home, call, missions } = missionSetup();
    const ask = (mission: string, caller: ToolCaller = mainCaller("main-1")) => call("manager", "bm_ask_mission", { mission, text: "x" }, caller);
    expect((await ask("OPS", MANAGER_A)).text).toContain("You are not the Main of a mission");
    expect((await ask("NOPE")).text).toBe("unknown mission NOPE (bm_peers lists the missions)\nNothing was stored or sent.");
    expect((await ask("SHOP")).text).toContain("mission SHOP is your own");
    missions.update(OPS, (mission) => ({ ...mission, state: "closed" }));
    expect((await ask("OPS")).text).toBe("mission OPS is closed\nNothing was stored or sent.");
    expect(links(home).list()).toEqual([]);
  });

  it("a Main's bm_ask_project is refused: outside its scope with the §4 text, inside it towards its own Workers", async () => {
    const { home, fake, call } = missionSetup();
    expect((await call("manager", "bm_ask_project", { project: "/repo/ops", request: "x", requestId: REQ_M }, mainCaller("main-1"))).text).toBe(
      `project "ops" (${C}) is outside mission SHOP's scope: add the repo to the mission (bm_mission_update repos) or ask its mission (bm_ask_mission)\nNothing was stored or sent.`,
    );
    expect((await call("manager", "bm_ask_project", { project: B, request: "x", requestId: REQ_M }, mainCaller("main-1"))).text).toBe(
      `project "back" (${B}) is a repo of mission SHOP: give the work a Worker there (bm_create_worker project: ${B}) or link the Workers on it (bm_link_workers)\nNothing was stored or sent.`,
    );
    expect(links(home).list()).toEqual([]);
    expect(fake.sends).toEqual([]);
  });

  it("a Main's bm_peers lists the other open missions and its mission's links of every kind", async () => {
    const { call } = missionSetup();
    await call("worker", "bm_ask_project", ASK, WORKER_M);
    await call("manager", "bm_ask_mission", { mission: "OPS", text: "x" }, mainCaller("main-1"));
    const mine = parsed(await call("manager", "bm_peers", {}, mainCaller("main-1")));
    expect(mine["missions"]).toEqual([{ code: "OPS", name: "Ops", mainId: "main-2", repos: [C] }]);
    expect((mine["links"] as Array<Record<string, unknown>>).map((view) => [view["linkId"], view["route"], view["direction"], view["mission"]])).toEqual([
      ["peer-000000000002", "mission", "asked", "OPS"],
      [LINK, "ask-main", "asked of us", undefined],
    ]);
    const theirs = parsed(await call("manager", "bm_peers", {}, mainCaller("main-2")));
    expect((theirs["links"] as Array<Record<string, unknown>>).map((view) => [view["linkId"], view["direction"], view["mission"]])).toEqual([["peer-000000000002", "asked of us", "SHOP"]]);
    // A Worker's view is as before: no missions, its workspace's links.
    const worker = parsed(await call("worker", "bm_peers", {}, WORKER_M));
    expect(worker["missions"]).toBeUndefined();
    expect((worker["links"] as Array<Record<string, unknown>>).map((view) => [view["linkId"], view["route"]])).toEqual([[LINK, "ask-main"]]);
  });
});
