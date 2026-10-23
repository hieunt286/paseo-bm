import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  MAX_LIVE_LINKS_PER_REQUEST,
  MAX_PEER_CHAIN_DEPTH,
  MAX_PEER_GIST,
  MAX_PEER_LINKS,
  MAX_PEER_MESSAGES,
  PEERS_DIR_NAME,
  PEER_LINK_ID_PATTERN,
  actOf,
  capPeerLinks,
  chainFor,
  createPeerLinkStore,
  gistOf,
  isLiveLink,
  linkViewOf,
  newLinkId,
  resolveProject,
  resolveProjectIn,
  routeOf,
  type NewPeerLink,
  type PeerLink,
} from "../plugin/server/peer-links";
import { clearJsonFileCache } from "../plugin/server/data-files";
import type { DashboardPaseo, ListedWorkspace } from "../plugin/server/paseo-directory";
import { CLEANUP_DELETES } from "../plugin/server/setup-machine";
import { dataFolder, removeDataFolders } from "./helpers/data-folder";

/**
 * Peer links (design §7.17.1, §7.17.2, §7.17.6; ADR-028): the store, its
 * states and bounds, the chain rule and resolving a project. Temporary data
 * folders only.
 */

const A = "wks_a";
const B = "wks_b";
const C = "wks_c";
const D = "wks_d";
const REQ_A = "req-20261009T100000Z";
const REQ_B = "req-20261009T110000Z";
const REQ_C = "req-20261009T120000Z";
const T0 = new Date("2026-10-09T10:00:00.000Z");

afterEach(() => {
  clearJsonFileCache();
  removeDataFolders();
});

function ids(): () => string {
  let n = 0;
  return () => `peer-${(++n).toString(16).padStart(12, "0")}`;
}

function store(home: string, env: NodeJS.ProcessEnv = {}) {
  return createPeerLinkStore(home, { now: () => T0, newId: ids(), env });
}

function ask(overrides: Partial<NewPeerLink> = {}): NewPeerLink {
  return {
    kind: "work",
    from: { workspaceId: A, requestId: REQ_A, agentId: "wrk-a", role: "worker" },
    to: { workspaceId: B, managerId: "mgr-b" },
    text: "Add the /export endpoint; we need CSV with these columns.",
    ...overrides,
  };
}

function created(result: ReturnType<ReturnType<typeof store>["createLink"]>): PeerLink {
  if (!result.ok) throw new Error(result.reasons.join("\n"));
  return result.link;
}

function link(overrides: Partial<PeerLink> = {}): PeerLink {
  return {
    linkId: newLinkId(),
    createdAt: T0.toISOString(),
    kind: "work",
    from: { workspaceId: A, requestId: REQ_A, agentId: "wrk-a", role: "worker" },
    to: { workspaceId: B, managerId: "mgr-b", requestId: null, workerId: null },
    chain: { workspaces: [A], depth: 1 },
    waitingSince: null,
    text: "ask",
    state: "open",
    takenAt: null,
    answeredAt: null,
    closedAt: null,
    closedBy: null,
    messages: [],
    ...overrides,
  };
}

describe("the link store (design §7.17.1)", () => {
  it("writes peers/links.json, 0700 / 0600, schemaVersion 1, an open link with a masked ask", () => {
    const home = dataFolder();
    const links = store(home, { PASEO_PASSWORD: "sekret-value-123" });
    const made = created(links.createLink(ask({ text: "use --password hunter2 and sekret-value-123" })));

    expect(made.linkId).toMatch(PEER_LINK_ID_PATTERN);
    expect(made).toMatchObject({
      state: "open",
      createdAt: T0.toISOString(),
      to: { workspaceId: B, managerId: "mgr-b", requestId: null, workerId: null },
      chain: { workspaces: [A], depth: 1 },
      waitingSince: null,
      messages: [],
    });
    expect(made.text).not.toContain("hunter2");
    expect(made.text).not.toContain("sekret-value-123");

    const path = join(home, PEERS_DIR_NAME, "links.json");
    expect(links.path).toBe(path);
    expect(statSync(dirname(path)).mode & 0o777).toBe(0o700);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const body = JSON.parse(readFileSync(path, "utf8"));
    expect(body.schemaVersion).toBe(1);
    expect(body.links).toHaveLength(1);
    expect(links.get(made.linkId)).toEqual(made);
    expect(links.list()).toEqual([made]);
  });

  it("creating the store touches nothing; a missing file reads as no links", () => {
    const home = dataFolder();
    const links = store(home);
    expect(links.list()).toEqual([]);
    expect(links.get("peer-000000000001")).toBeNull();
    expect(existsSync(join(home, PEERS_DIR_NAME))).toBe(false);
  });

  it("a file of a newer schemaVersion reads as empty and is never written", () => {
    const home = dataFolder();
    mkdirSync(join(home, PEERS_DIR_NAME), { mode: 0o700 });
    const path = join(home, PEERS_DIR_NAME, "links.json");
    const newer = `${JSON.stringify({ schemaVersion: 2, links: [link()] })}\n`;
    writeFileSync(path, newer, { mode: 0o600 });
    const links = store(home);

    expect(links.list()).toEqual([]);
    expect(() => links.createLink(ask())).toThrow();
    expect(readFileSync(path, "utf8")).toBe(newer);
  });

  it("an unusable file is left as it is; readers never throw", () => {
    const home = dataFolder();
    mkdirSync(join(home, PEERS_DIR_NAME), { mode: 0o700 });
    const path = join(home, PEERS_DIR_NAME, "links.json");
    writeFileSync(path, "not json", { mode: 0o600 });
    const links = store(home);

    expect(links.list()).toEqual([]);
    expect(links.linksOfRequest(A, REQ_A, "asker")).toEqual([]);
    expect(links.liveLinksFrom(A, REQ_A)).toEqual([]);
    expect(() => links.createLink(ask())).toThrow();
    expect(readFileSync(path, "utf8")).toBe("not json");
  });

  it("an entry that does not validate costs only itself", () => {
    const home = dataFolder();
    mkdirSync(join(home, PEERS_DIR_NAME), { mode: 0o700 });
    const good = link({ linkId: "peer-00000000000a" });
    writeFileSync(join(home, PEERS_DIR_NAME, "links.json"), JSON.stringify({ schemaVersion: 1, links: [{ linkId: "bad" }, good] }), { mode: 0o600 });
    expect(store(home).list()).toEqual([good]);
  });

  it("keeps the ask to 20,000 characters", () => {
    const links = store(dataFolder());
    expect(created(links.createLink(ask({ text: "x".repeat(25_000) }))).text).toHaveLength(20_000);
  });
});

describe("states (design §7.17.1)", () => {
  it("open → taken → answered → closed, with the times and who closed it", () => {
    const links = store(dataFolder());
    const made = created(links.createLink(ask()));
    expect(isLiveLink(made)).toBe(true);

    const taken = links.takeLink(made.linkId, { workspaceId: B, requestId: REQ_B, workerId: "wrk-b" });
    expect(taken).toMatchObject({ ok: true, link: { state: "taken", takenAt: T0.toISOString(), to: { requestId: REQ_B, workerId: "wrk-b", managerId: "mgr-b" } } });
    expect(isLiveLink(links.get(made.linkId)!)).toBe(true);

    expect(links.markAnswered(made.linkId)).toMatchObject({ ok: true, link: { state: "answered", answeredAt: T0.toISOString() } });
    expect(isLiveLink(links.get(made.linkId)!)).toBe(false);
    // A later finished reply keeps it answered.
    expect(links.markAnswered(made.linkId)).toMatchObject({ ok: true, link: { state: "answered" } });

    expect(links.closeLink(made.linkId, "asker")).toMatchObject({ ok: true, link: { state: "closed", closedAt: T0.toISOString(), closedBy: "asker" } });
    expect(isLiveLink(links.get(made.linkId)!)).toBe(false);
  });

  it("the answering side may close an open link (declined)", () => {
    const links = store(dataFolder());
    const made = created(links.createLink(ask()));
    expect(links.closeLink(made.linkId, "answerer")).toMatchObject({ ok: true, link: { state: "closed", closedBy: "answerer" } });
  });

  it("takeLink refuses another workspace, a link another request holds and a closed link", () => {
    const links = store(dataFolder());
    const made = created(links.createLink(ask()));

    expect(links.takeLink(made.linkId, { workspaceId: C, requestId: REQ_B, workerId: "wrk-c" })).toEqual({
      ok: false,
      reasons: [`link ${made.linkId} asks another project (${B}), not this one`],
    });
    links.takeLink(made.linkId, { workspaceId: B, requestId: REQ_B, workerId: "wrk-b" });
    expect(links.takeLink(made.linkId, { workspaceId: B, requestId: REQ_C, workerId: "wrk-b2" })).toEqual({
      ok: false,
      reasons: [`link ${made.linkId} is taken by request ${REQ_B}`],
    });
    links.closeLink(made.linkId, "answerer");
    expect(links.takeLink(made.linkId, { workspaceId: B, requestId: REQ_B, workerId: "wrk-b" })).toEqual({ ok: false, reasons: [`link ${made.linkId} is closed`] });
  });

  it("the request that holds a link takes it again with a successor Worker, its state kept", () => {
    const links = store(dataFolder());
    const made = created(links.createLink(ask()));
    links.takeLink(made.linkId, { workspaceId: B, requestId: REQ_B, workerId: "wrk-b" });
    expect(links.takeLink(made.linkId, { workspaceId: B, requestId: REQ_B, workerId: "wrk-b" })).toMatchObject({ ok: true, link: { to: { workerId: "wrk-b" } } });
    expect(links.takeLink(made.linkId, { workspaceId: B, requestId: REQ_B, workerId: "wrk-b2" })).toMatchObject({ ok: true, link: { state: "taken", to: { workerId: "wrk-b2" } } });
    links.markAnswered(made.linkId);
    expect(links.takeLink(made.linkId, { workspaceId: B, requestId: REQ_B, workerId: "wrk-b3" })).toMatchObject({ ok: true, link: { state: "answered", to: { workerId: "wrk-b3" } } });
  });

  it("markAnswered refuses an open or closed link; closeLink refuses a closed one", () => {
    const links = store(dataFolder());
    const made = created(links.createLink(ask()));
    expect(links.markAnswered(made.linkId)).toEqual({ ok: false, reasons: [`link ${made.linkId} is open; only a taken link is answered`] });
    links.closeLink(made.linkId, "asker");
    expect(links.markAnswered(made.linkId)).toEqual({ ok: false, reasons: [`link ${made.linkId} is closed; only a taken link is answered`] });
    expect(links.closeLink(made.linkId, "answerer")).toEqual({ ok: false, reasons: [`link ${made.linkId} is closed already`] });
  });

  it("every change refuses an unknown link", () => {
    const links = store(dataFolder());
    const unknown = { ok: false, reasons: ["unknown link peer-0000000000ff"] };
    expect(links.takeLink("peer-0000000000ff", { workspaceId: B, requestId: REQ_B, workerId: null })).toEqual(unknown);
    expect(links.markAnswered("peer-0000000000ff")).toEqual(unknown);
    expect(links.closeLink("peer-0000000000ff", "asker")).toEqual(unknown);
    expect(links.appendMessage("peer-0000000000ff", { recordId: "out-000000000001", workspaceId: A, side: "asker", agentId: "wrk-a", kind: "peer", text: "hi" })).toEqual(unknown);
  });
});

describe("messages (design §7.17.1)", () => {
  it("appends a masked one-line gist of at most 300 characters, once per record id", () => {
    const links = store(dataFolder(), { PASEO_PASSWORD: "sekret-value-123" });
    const made = created(links.createLink(ask()));
    const result = links.appendMessage(made.linkId, {
      recordId: "out-000000000001",
      workspaceId: B,
      side: "answerer",
      agentId: "wrk-b",
      kind: "peer-reply",
      phase: "finished",
      text: `Done.\nThe key is sekret-value-123.\n${"y".repeat(400)}`,
    });
    expect(result.ok).toBe(true);
    const message = links.get(made.linkId)!.messages[0]!;
    expect(message).toMatchObject({ recordId: "out-000000000001", workspaceId: B, side: "answerer", agentId: "wrk-b", kind: "peer-reply", phase: "finished", at: T0.toISOString() });
    expect(message.gist).toHaveLength(MAX_PEER_GIST);
    expect(message.gist).not.toContain("\n");
    expect(message.gist).not.toContain("sekret-value-123");
    expect(message.gist.endsWith("…")).toBe(true);

    links.appendMessage(made.linkId, { recordId: "out-000000000001", workspaceId: B, side: "answerer", agentId: "wrk-b", kind: "peer-reply", text: "again" });
    expect(links.get(made.linkId)!.messages).toHaveLength(1);
    expect(gistOf("  short \n text ")).toBe("short text");
  });

  it("keeps the newest 200 messages of a link; a phase defaults to null", () => {
    const links = store(dataFolder());
    const made = created(links.createLink(ask()));
    for (let n = 1; n <= MAX_PEER_MESSAGES + 5; n += 1) {
      links.appendMessage(made.linkId, { recordId: `out-${n.toString(16).padStart(12, "0")}`, workspaceId: A, side: "asker", agentId: "wrk-a", kind: "peer-message", text: `m${n}` });
    }
    const messages = links.get(made.linkId)!.messages;
    expect(messages).toHaveLength(MAX_PEER_MESSAGES);
    expect(messages[0]!.gist).toBe("m6");
    expect(messages.at(-1)!.gist).toBe(`m${MAX_PEER_MESSAGES + 5}`);
    expect(messages[0]!.phase).toBeNull();
  });

  it("keeps a message's act and refs (delivery line design §9.1, §11); an older message without them reads as an answer naming nothing", () => {
    const home = dataFolder();
    const links = store(home);
    const made = created(links.createLink(ask()));
    links.appendMessage(made.linkId, { recordId: "out-000000000001", workspaceId: B, side: "answerer", agentId: "wrk-b", kind: "peer-message", text: "Agreed.", act: "agree", refs: { contracts: ["C2@v3"] } });
    links.appendMessage(made.linkId, { recordId: "out-000000000002", workspaceId: A, side: "asker", agentId: "wrk-a", kind: "peer-message", text: "Thanks.", refs: {} });
    const [typed, plain] = links.get(made.linkId)!.messages;
    expect(typed).toMatchObject({ act: "agree", refs: { contracts: ["C2@v3"] } });
    expect(plain!.act).toBeUndefined();
    expect(plain!.refs).toBeUndefined();
    expect(actOf(plain!)).toBe("answer");
    // A file written before Phase 9 parses as it is.
    const older = { ...made, messages: [{ recordId: "out-000000000003", workspaceId: B, side: "answerer", agentId: "wrk-b", at: T0.toISOString(), kind: "peer-message", phase: null, gist: "old" }] };
    clearJsonFileCache();
    writeFileSync(join(home, PEERS_DIR_NAME, "links.json"), JSON.stringify({ schemaVersion: 1, links: [older] }), { mode: 0o600 });
    expect(actOf(store(home).get(made.linkId)!.messages[0]!)).toBe("answer");
  });

  it("refuses a message on a closed link", () => {
    const links = store(dataFolder());
    const made = created(links.createLink(ask()));
    links.closeLink(made.linkId, "asker");
    expect(links.appendMessage(made.linkId, { recordId: "out-000000000001", workspaceId: A, side: "asker", agentId: "wrk-a", kind: "peer-message", text: "hi" })).toEqual({
      ok: false,
      reasons: [`link ${made.linkId} is closed`],
    });
  });
});

describe("which requests carry a link, and waiting (design §7.17.1, §7.17.5)", () => {
  it("linksOfRequest reads the asker side by from and the answering side by to, per workspace", () => {
    const links = store(dataFolder());
    const first = created(links.createLink(ask()));
    const second = created(links.createLink(ask({ to: { workspaceId: C, managerId: null } })));
    links.takeLink(first.linkId, { workspaceId: B, requestId: REQ_B, workerId: "wrk-b" });

    expect(links.linksOfRequest(A, REQ_A, "asker").map((entry) => entry.linkId)).toEqual([first.linkId, second.linkId]);
    expect(links.linksOfRequest(B, REQ_B, "answerer").map((entry) => entry.linkId)).toEqual([first.linkId]);
    // The same request id in another workspace is another request.
    expect(links.linksOfRequest(B, REQ_A, "asker")).toEqual([]);
    expect(links.linksOfRequest(C, REQ_B, "answerer")).toEqual([]);

    links.closeLink(second.linkId, "asker");
    expect(links.liveLinksFrom(A, REQ_A).map((entry) => entry.linkId)).toEqual([first.linkId]);
  });

  it("setWaiting marks only the live links the request asked; clearWaiting clears them all", () => {
    const links = store(dataFolder());
    const first = created(links.createLink(ask()));
    const second = created(links.createLink(ask({ to: { workspaceId: C, managerId: null } })));
    const other = created(links.createLink(ask({ from: { workspaceId: D, requestId: REQ_A, agentId: "wrk-d", role: "worker" } })));
    links.closeLink(second.linkId, "answerer");

    const at = "2026-10-09T10:05:00.000Z";
    const set = links.setWaiting(A, REQ_A, [first.linkId, second.linkId, other.linkId], at);
    expect(set.map((entry) => entry.linkId)).toEqual([first.linkId]);
    expect(links.get(first.linkId)!.waitingSince).toBe(at);
    expect(links.get(second.linkId)!.waitingSince).toBeNull();
    expect(links.get(other.linkId)!.waitingSince).toBeNull();

    expect(links.clearWaiting(A, REQ_A)).toBe(1);
    expect(links.get(first.linkId)!.waitingSince).toBeNull();
    expect(links.clearWaiting(A, REQ_A)).toBe(0);
  });
});

describe("bounds and the chain (design §7.17.6)", () => {
  it("at most 10 live links per request; a closed one frees a place", () => {
    const links = store(dataFolder());
    const made = Array.from({ length: MAX_LIVE_LINKS_PER_REQUEST }, () => created(links.createLink(ask())));
    expect(links.createLink(ask())).toEqual({
      ok: false,
      reasons: [`request ${REQ_A} already has 10 live links (at most 10); close one with bm_peer_reply close: true first`],
    });
    // Another workspace's request with the same id is not bound by A's.
    expect(links.createLink(ask({ from: { workspaceId: D, requestId: REQ_A, agentId: "wrk-d", role: "worker" } })).ok).toBe(true);
    links.closeLink(made[0]!.linkId, "asker");
    expect(links.createLink(ask()).ok).toBe(true);
  });

  it("refuses asking its own workspace", () => {
    const links = store(dataFolder());
    expect(links.createLink(ask({ to: { workspaceId: A, managerId: null } }))).toEqual({ ok: false, reasons: ["a project cannot ask itself; ask another project"] });
    expect(links.list()).toEqual([]);
  });

  it("a link asked by a request that took links gets their workspaces plus A and one more depth", () => {
    const links = store(dataFolder());
    // C asks B; B's request takes it; B asks D.
    const cb = created(links.createLink(ask({ from: { workspaceId: C, requestId: REQ_C, agentId: "wrk-c", role: "worker" } })));
    links.takeLink(cb.linkId, { workspaceId: B, requestId: REQ_B, workerId: "wrk-b" });
    const bd = created(links.createLink(ask({ from: { workspaceId: B, requestId: REQ_B, agentId: "wrk-b", role: "worker" }, to: { workspaceId: D, managerId: null } })));
    expect(bd.chain).toEqual({ workspaces: [C, B], depth: 2 });
  });

  it("refuses a target already in the chain, naming the link to reply on", () => {
    const links = store(dataFolder());
    const ab = created(links.createLink(ask()));
    links.takeLink(ab.linkId, { workspaceId: B, requestId: REQ_B, workerId: "wrk-b" });
    expect(links.createLink(ask({ from: { workspaceId: B, requestId: REQ_B, agentId: "wrk-b", role: "worker" }, to: { workspaceId: A, managerId: null } }))).toEqual({
      ok: false,
      reasons: [`project ${A} is already in this chain of asks; reply on link ${ab.linkId} with bm_peer_reply instead`],
    });
  });

  it("a carried link answered or closed no longer counts: its asker may be asked again, and the refusal names only a live link", () => {
    const links = store(dataFolder());
    const fromB = { workspaceId: B, requestId: REQ_B, agentId: "wrk-b", role: "worker" as const };
    // A asks B twice; B's request takes both, so it cannot ask A back.
    const first = created(links.createLink(ask()));
    const second = created(links.createLink(ask()));
    links.takeLink(first.linkId, { workspaceId: B, requestId: REQ_B, workerId: "wrk-b" });
    links.takeLink(second.linkId, { workspaceId: B, requestId: REQ_B, workerId: "wrk-b" });
    links.closeLink(first.linkId, "asker");
    expect(links.createLink(ask({ from: fromB, to: { workspaceId: A, managerId: null } }))).toEqual({
      ok: false,
      reasons: [`project ${A} is already in this chain of asks; reply on link ${second.linkId} with bm_peer_reply instead`],
    });
    // Once no carried link is live, the chain starts afresh.
    links.markAnswered(second.linkId);
    expect(created(links.createLink(ask({ from: fromB, to: { workspaceId: A, managerId: null } }))).chain).toEqual({ workspaces: [B], depth: 1 });
    // The depth too counts only live carried links.
    const cb = created(links.createLink(ask({ from: { workspaceId: C, requestId: REQ_C, agentId: "wrk-c", role: "worker" } })));
    links.takeLink(cb.linkId, { workspaceId: B, requestId: REQ_B, workerId: "wrk-b" });
    expect(chainFor(links.list(), fromB, D)).toEqual({ ok: true, chain: { workspaces: [C, B], depth: 2 } });
    links.closeLink(cb.linkId, "answerer");
    expect(chainFor(links.list(), fromB, D)).toEqual({ ok: true, chain: { workspaces: [B], depth: 1 } });
  });

  it("refuses a fourth link of a chain", () => {
    const links = store(dataFolder());
    const E = "wks_e";
    const REQ_D = "req-20261009T130000Z";
    const ab = created(links.createLink(ask()));
    links.takeLink(ab.linkId, { workspaceId: B, requestId: REQ_B, workerId: "wrk-b" });
    const bc = created(links.createLink(ask({ from: { workspaceId: B, requestId: REQ_B, agentId: "wrk-b", role: "worker" }, to: { workspaceId: C, managerId: null } })));
    links.takeLink(bc.linkId, { workspaceId: C, requestId: REQ_C, workerId: "wrk-c" });
    const cd = created(links.createLink(ask({ from: { workspaceId: C, requestId: REQ_C, agentId: "wrk-c", role: "worker" }, to: { workspaceId: D, managerId: null } })));
    expect(cd.chain).toEqual({ workspaces: [A, B, C], depth: MAX_PEER_CHAIN_DEPTH });
    links.takeLink(cd.linkId, { workspaceId: D, requestId: REQ_D, workerId: "wrk-d" });

    expect(links.createLink(ask({ from: { workspaceId: D, requestId: REQ_D, agentId: "wrk-d", role: "worker" }, to: { workspaceId: E, managerId: null } }))).toEqual({
      ok: false,
      reasons: ["this ask would be link 4 of a chain of projects (at most 3); answer what you can on the link you carry with bm_peer_reply"],
    });
  });

  it("chainFor gives one line per reason", () => {
    const live = Array.from({ length: MAX_LIVE_LINKS_PER_REQUEST }, () => link());
    const result = chainFor(live, { workspaceId: A, requestId: REQ_A }, A);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reasons).toHaveLength(2);
  });

  it("past 2,000 links the oldest closed go, then the oldest answered; live links never", () => {
    const at = (n: number): string => new Date(T0.getTime() + n * 1000).toISOString();
    const live = Array.from({ length: MAX_PEER_LINKS - 2 }, (_, n) => link({ createdAt: at(100 + n), state: n % 2 === 0 ? "open" : "taken" }));
    const answeredOld = link({ linkId: "peer-0000000000a1", createdAt: at(1), state: "answered" });
    const answeredNew = link({ linkId: "peer-0000000000a2", createdAt: at(50), state: "answered" });
    const closedOld = link({ linkId: "peer-0000000000c1", createdAt: at(60), state: "closed" });
    const closedNew = link({ linkId: "peer-0000000000c2", createdAt: at(70), state: "closed" });
    const all = [answeredOld, closedNew, ...live, answeredNew, closedOld];

    // Two past the cap: both closed go, the answered stay.
    const kept = capPeerLinks(all);
    expect(kept).toHaveLength(MAX_PEER_LINKS);
    expect(kept.map((entry) => entry.linkId)).not.toContain(closedOld.linkId);
    expect(kept.map((entry) => entry.linkId)).not.toContain(closedNew.linkId);
    expect(kept).toContain(answeredOld);

    // Three past: then the oldest answered.
    const more = capPeerLinks([...all, link({ createdAt: at(5000) })]);
    expect(more).toHaveLength(MAX_PEER_LINKS);
    expect(more.map((entry) => entry.linkId)).not.toContain(answeredOld.linkId);
    expect(more).toContain(answeredNew);

    // Only live links: none dropped.
    const allLive = Array.from({ length: MAX_PEER_LINKS + 2 }, () => link());
    expect(capPeerLinks(allLive)).toHaveLength(MAX_PEER_LINKS + 2);
  });

  it("the store applies the cap on write", () => {
    const home = dataFolder();
    mkdirSync(join(home, PEERS_DIR_NAME), { mode: 0o700 });
    const closed = Array.from({ length: MAX_PEER_LINKS }, (_, n) => link({ linkId: `peer-${(0x100000 + n).toString(16).padStart(12, "0")}`, state: "closed" }));
    writeFileSync(join(home, PEERS_DIR_NAME, "links.json"), JSON.stringify({ schemaVersion: 1, links: closed }), { mode: 0o600 });
    const links = store(home);
    const made = created(links.createLink(ask()));
    const listed = links.list();
    expect(listed).toHaveLength(MAX_PEER_LINKS);
    expect(listed.map((entry) => entry.linkId)).not.toContain(closed[0]!.linkId);
    expect(listed.at(-1)).toEqual(made);
  });
});

describe("resolving a project (design §7.17.2)", () => {
  const listed: ListedWorkspace[] = [
    { id: A, archived: false, directory: "/work/app" },
    { id: B, archived: false, directory: "/work/api" },
    { id: C, archived: true, directory: "/work/old" },
    { id: D, archived: false, directory: "/work/api/packages/sdk" },
  ];

  it("by workspace id", () => {
    expect(resolveProjectIn(listed, B, A)).toEqual({ ok: true, workspaceId: B, directory: "/work/api" });
    expect(resolveProjectIn(listed, ` ${B} `, A)).toMatchObject({ ok: true, workspaceId: B });
  });

  it("by absolute folder: the workspace's own directory, or the deepest one that contains it", () => {
    expect(resolveProjectIn(listed, "/work/api", A)).toMatchObject({ ok: true, workspaceId: B });
    expect(resolveProjectIn(listed, "/work/api/", A)).toMatchObject({ ok: true, workspaceId: B });
    expect(resolveProjectIn(listed, "/work/api/src/routes", A)).toMatchObject({ ok: true, workspaceId: B });
    expect(resolveProjectIn(listed, "/work/api/packages/sdk/src", A)).toMatchObject({ ok: true, workspaceId: D });
    // A sibling whose name starts the same is not inside.
    expect(resolveProjectIn(listed, "/work/api-v2", A).ok).toBe(false);
  });

  it("refuses an unknown, an archived and the caller's own workspace, naming what was given", () => {
    expect(resolveProjectIn(listed, "wks_zz", A)).toEqual({ ok: false, reasons: ['unknown project "wks_zz": no workspace Paseo lists has that id or folder (bm_peers lists them)'] });
    expect(resolveProjectIn(listed, "/elsewhere", A)).toEqual({ ok: false, reasons: ['unknown project "/elsewhere": no workspace Paseo lists has that id or folder (bm_peers lists them)'] });
    expect(resolveProjectIn(listed, "relative/api", A).ok).toBe(false);
    expect(resolveProjectIn(listed, C, A)).toEqual({ ok: false, reasons: [`project "${C}" is archived`] });
    expect(resolveProjectIn(listed, "/work/old/src", A)).toEqual({ ok: false, reasons: ['project "/work/old/src" is archived'] });
    expect(resolveProjectIn(listed, A, A)).toEqual({ ok: false, reasons: [`project "${A}" is your own workspace; ask another project`] });
    expect(resolveProjectIn(listed, "/work/app/src", A)).toEqual({ ok: false, reasons: ['project "/work/app/src" is your own workspace; ask another project'] });
    expect(resolveProjectIn(listed, "  ", A).ok).toBe(false);
  });

  it("refuses an unreadable list and two unarchived workspaces of one folder; an archived twin does not count", () => {
    expect(resolveProjectIn(null, B, A)).toEqual({ ok: false, reasons: [`cannot read Paseo's workspaces to find project "${B}"; try again`] });
    const twins: ListedWorkspace[] = [...listed, { id: "wks_twin", archived: false, directory: "/work/api" }];
    expect(resolveProjectIn(twins, "/work/api", A)).toEqual({ ok: false, reasons: [`project "/work/api" names more than one workspace (${B}, wks_twin); give its workspace id`] });
    const archivedTwin: ListedWorkspace[] = [...listed, { id: "wks_twin", archived: true, directory: "/work/api" }];
    expect(resolveProjectIn(archivedTwin, "/work/api", A)).toMatchObject({ ok: true, workspaceId: B });
  });

  it("resolveProject reads Paseo's list and never throws", async () => {
    const paseo = (entries: Array<Record<string, unknown>> | Error): DashboardPaseo =>
      ({
        agents: { list: async () => ({ entries: [] }) },
        workspaces: {
          list: async () => {
            if (entries instanceof Error) throw entries;
            return { entries };
          },
        },
      }) as DashboardPaseo;
    const live = paseo([
      { id: A, directory: "/work/app" },
      { id: B, directory: "/work/api" },
      { id: C, directory: "/work/old", archivedAt: "2026-10-01T00:00:00.000Z" },
    ]);
    await expect(resolveProject(live, "/work/api/src", A)).resolves.toMatchObject({ ok: true, workspaceId: B });
    await expect(resolveProject(live, C, A)).resolves.toMatchObject({ ok: false });
    await expect(resolveProject(paseo(new Error("down")), B, A)).resolves.toMatchObject({ ok: false });
  });
});

describe("routes (missions design §2.6)", () => {
  const MIS = "mis-0000000001";
  const asker = { workspaceId: A, requestId: REQ_A, agentId: "wrk-a", role: "worker" as const };

  it("a project link is written as before, without route or missionId; any other route carries both", () => {
    const links = store(dataFolder());
    const plain = created(links.createLink(ask()));
    expect("route" in plain || "missionId" in plain).toBe(false);
    expect(routeOf(plain)).toBe("project");
    const main = created(links.createLink(ask({ route: "ask-main", missionId: MIS, to: { workspaceId: B, managerId: "main-1" } })));
    expect(main).toMatchObject({ route: "ask-main", missionId: MIS, state: "open", to: { workspaceId: B, managerId: "main-1", requestId: null, workerId: null } });
    expect(links.get(main.linkId)).toEqual(main);
  });

  it("an ask-main link cannot ask its own repo; a worker link may join two Workers of one repo, taken at once", () => {
    const links = store(dataFolder());
    expect(links.createLink(ask({ route: "ask-main", missionId: MIS, to: { workspaceId: A, managerId: "main-1" } }))).toEqual({
      ok: false,
      reasons: ["a project cannot ask itself; ask another project"],
    });
    const pair = created(links.createLink(ask({ route: "worker", missionId: MIS, to: { workspaceId: A, managerId: "main-1", requestId: REQ_B, workerId: "wrk-b" } })));
    expect(pair).toMatchObject({ state: "taken", takenAt: T0.toISOString(), to: { workspaceId: A, requestId: REQ_B, workerId: "wrk-b" }, chain: { workspaces: [A], depth: 1 } });
    expect(links.linksOfRequest(A, REQ_B, "answerer").map((entry) => entry.linkId)).toEqual([pair.linkId]);
  });

  it("the chain rule is for project links only: a request carrying a worker link starts a fresh chain, and may ask its asker's repo", () => {
    const links = store(dataFolder());
    created(links.createLink(ask({ route: "worker", missionId: MIS, to: { workspaceId: B, managerId: "main-1", requestId: REQ_B, workerId: "wrk-b" } })));
    const fromB = { workspaceId: B, requestId: REQ_B };
    expect(chainFor(links.list(), fromB, A)).toEqual({ ok: true, chain: { workspaces: [B], depth: 1 } });
    expect(chainFor(links.list(), fromB, A, "ask-main")).toEqual({ ok: true, chain: { workspaces: [B], depth: 1 } });
    // The live-links bound still counts every route.
    for (let index = 1; index < MAX_LIVE_LINKS_PER_REQUEST; index += 1) created(links.createLink(ask({ route: "ask-main", missionId: MIS, to: { workspaceId: C, managerId: "main-1" } })));
    expect(chainFor(links.list(), asker, C, "ask-main")).toMatchObject({ ok: false });
  });

  it("a mission link has no asking request: no bound per request, and its own home is no refusal", () => {
    const links = store(dataFolder());
    const from = { workspaceId: "wks_home", requestId: null, agentId: "main-1", role: "manager" as const };
    const made = created(links.createLink(ask({ route: "mission", missionId: MIS, from, to: { workspaceId: "wks_home", managerId: "main-2" } })));
    expect(made).toMatchObject({ route: "mission", missionId: MIS, from: { requestId: null }, state: "open", chain: { workspaces: ["wks_home"], depth: 1 } });
    expect(linkViewOf(made, "wks_home", false)).toMatchObject({ route: "mission", direction: "asked of us", ourRequestId: null, theirRequestId: null });
  });

  it("turnToWorker turns an open ask-main into a worker link taken by the other request; nothing else", () => {
    const links = store(dataFolder());
    const asked = created(links.createLink(ask({ route: "ask-main", missionId: MIS, to: { workspaceId: B, managerId: "main-1" } })));
    const to = { workspaceId: C, requestId: REQ_C, workerId: "wrk-c", managerId: "main-1" };
    expect(links.turnToWorker(asked.linkId, to)).toMatchObject({ ok: true, link: { route: "worker", state: "taken", takenAt: T0.toISOString(), to, from: asker } });
    const refusal = { ok: false, reasons: [`link ${asked.linkId} is not an open ask of a Worker to its Main`] };
    expect(links.turnToWorker(asked.linkId, to)).toEqual(refusal);
    const plain = created(links.createLink(ask()));
    expect(links.turnToWorker(plain.linkId, to)).toEqual({ ok: false, reasons: [`link ${plain.linkId} is not an open ask of a Worker to its Main`] });
  });

  it("a stored link of an older build reads as a project link", () => {
    const view = linkViewOf(link(), A);
    expect(routeOf(link())).toBe("project");
    expect("route" in view).toBe(false);
  });
});

describe("cleanup (design §7.17.1, §7.13.7)", () => {
  it("setup.cleanup deletes peers/ with the data", () => {
    expect(CLEANUP_DELETES).toContain(PEERS_DIR_NAME);
    expect(PEERS_DIR_NAME).toBe("peers");
  });
});
