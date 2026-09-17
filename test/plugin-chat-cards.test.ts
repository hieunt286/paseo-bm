import { describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendRecord, clearTraceStoreCache } from "../plugin/server/trace-store";
import {
  chatCardSchema,
  drawAsCard,
  markdownOf,
  markOf,
  partiesOf,
  partyName,
  quickReplies,
  replyText,
  statusChip,
  summaryOf,
  toChatCard,
  type ChatCard,
} from "../plugin/client/chat-cards";
import { parseMarkdown } from "../plugin/client/markdown";
import { handleChatPeers } from "../plugin/server/chat-rpc";
import type { DashboardPaseo } from "../plugin/server/dashboard-rpc";
import { TRACE_STORE_SCHEMA_VERSION, type ChatPeer } from "../plugin/shared/contracts";

/**
 * Chat cards (delta 20260916-chat-cards). Message texts are the shapes
 * measured on the owner's workspace.
 */

const REPORT = [
  "BM-REPORT",
  "requestId: req-20260916T062244Z",
  "phase: blocked",
  "tier: Large (changed: no)",
  "filesChanged: docs/design/a.md",
  "beadsCreated: cus-a, cus-b",
  "beadsUpdated: none",
  "beadsClosed: cus-a",
  "beadsReady: none",
  "reviewFindingsOpen: none",
  "buildAndTests: not run",
  "blockers: Q1 — keep the old label?",
  "guardrail: total 3/10",
].join("\n");

const REVIEW = ["Checked the batch.", "", "---", "", "BM-REVIEW", "requestId: req-20260916T081749Z", "batchId: b1", "reviewKind: first", "verdict: pass", "checked: docs/x.md"].join("\n");

const INSTRUCTION = "TIẾP TỤC LÀM VIỆC — `req-20260916T062244Z`\n\n## Quyết định: ÁP BẢN SỬA 5 DÒNG CHO R3\n\nLàm đi.";

const REVIEW_REQUEST = "Bạn là Reviewer (chỉ đọc). requestId: req-20260916T081749Z. batchId: b1 (tài liệu).\n\nRepo: /repo";

describe("which chat items become cards", () => {
  it("turns a Worker report into a report card", () => {
    const card = toChatCard({ type: "user_message", text: REPORT }, "complete")!;
    expect(chatCardSchema.parse(card)).toMatchObject({
      type: "report",
      direction: "received",
      requestId: "req-20260916T062244Z",
      phase: "blocked",
      tier: "Large",
      beads: { created: 2, updated: 0, closed: 1 },
      blockers: "Q1 — keep the old label?",
    });
  });

  it("turns a Manager instruction and a review request into message cards", () => {
    expect(toChatCard({ type: "user_message", text: INSTRUCTION }, "complete")).toMatchObject({
      type: "message",
      requestId: "req-20260916T062244Z",
      gist: "TIẾP TỤC LÀM VIỆC — req-20260916T062244Z",
    });
    expect(toChatCard({ type: "user_message", text: REVIEW_REQUEST }, "complete")).toMatchObject({
      type: "message",
      requestId: "req-20260916T081749Z",
      batchId: "b1",
    });
  });

  it("turns a Reviewer's own finished verdict into a sent review card", () => {
    expect(toChatCard({ type: "assistant_message", text: REVIEW }, "complete")).toMatchObject({
      type: "review",
      direction: "sent",
      verdict: "pass",
      batchId: "b1",
    });
  });

  it("reads a review request that explains the verdict format as a message, not a verdict", () => {
    // Real Worker prompts paste the block format into every review request.
    const request = `${REVIEW_REQUEST}\n\nAnswer with:\n\nBM-REVIEW\nrequestId: req-20260916T081749Z\nbatchId: b1\nverdict: approved | changes-required\n`;
    expect(toChatCard({ type: "user_message", text: request }, "complete")).toMatchObject({ type: "message", verdict: null, batchId: "b1" });
    const reportFormat = "Report with:\n\nBM-REPORT\nrequestId: <requestId>\nphase: received | documents-done | finished\n\nfor `req-20260916T062244Z`";
    expect(toChatCard({ type: "user_message", text: reportFormat }, "complete")).toMatchObject({ type: "message", phase: null });
    expect(toChatCard({ type: "assistant_message", text: reportFormat }, "complete")).toBeUndefined();
  });

  it("leaves everything else to Paseo", () => {
    // Typed by the user, even when it names a request.
    expect(toChatCard({ type: "user_message", text: INSTRUCTION, clientMessageId: "c1" }, "complete")).toBeUndefined();
    // Another agent's message with nothing of paseo-bm's.
    expect(toChatCard({ type: "user_message", text: "please summarise the file" }, "complete")).toBeUndefined();
    // An ordinary answer, even one that names a request.
    expect(toChatCard({ type: "assistant_message", text: "Worker started on req-20260916T062244Z." }, "complete")).toBeUndefined();
    // A verdict still streaming.
    expect(toChatCard({ type: "assistant_message", text: REVIEW }, "streaming")).toBeUndefined();
    // Other item kinds and empty text.
    expect(toChatCard({ type: "tool_call", text: REPORT }, "complete")).toBeUndefined();
    expect(toChatCard({ type: "user_message", text: "  " }, "complete")).toBeUndefined();
    expect(toChatCard({ type: "user_message" }, "complete")).toBeUndefined();
  });
});

const peer = (overrides: Partial<ChatPeer>): ChatPeer => ({
  id: "x",
  role: "worker",
  title: null,
  status: "idle",
  parentId: null,
  requestId: null,
  batchId: null,
  ...overrides,
});
const manager = peer({ id: "m1", role: "manager", title: "Beads Manager" });
const worker = peer({ id: "w1", title: "Contact redesign", parentId: "m1", requestId: "req-20260916T062244Z" });
const otherWorker = peer({ id: "w2", title: "PAKD fix", parentId: "m1", requestId: "req-20260916T081749Z" });
const reviewer = peer({ id: "r1", role: "reviewer", parentId: "w2", requestId: "req-20260916T081749Z", batchId: "b1" });
const card = (text: string, type: "user_message" | "assistant_message" = "user_message") => toChatCard({ type, text }, "complete")!;

describe("who sent it and who gets it", () => {
  it("in the Manager's chat, a report comes from the Worker of that request", () => {
    const { from, to } = partiesOf(card(REPORT), manager, [worker, otherWorker, reviewer]);
    expect(from).toEqual({ role: "worker", id: "w1", title: "Contact redesign" });
    expect(to.id).toBe("m1");
    expect(partyName(from)).toBe("Worker · Contact redesign");
  });

  it("in a Worker's chat, an instruction comes from its Manager", () => {
    expect(partiesOf(card(INSTRUCTION), worker, [manager, otherWorker]).from.id).toBe("m1");
  });

  it("in a Reviewer's chat, a request comes from its parent Worker; its verdict goes back there", () => {
    expect(partiesOf(card(REVIEW_REQUEST), reviewer, [manager, worker, otherWorker]).from.id).toBe("w2");
    const sent = partiesOf(card(REVIEW, "assistant_message"), reviewer, [manager, worker, otherWorker]);
    expect(sent.from).toMatchObject({ role: "reviewer", id: "r1" });
    expect(sent.to.id).toBe("w2");
  });

  it("names a role without an id when no single agent fits", () => {
    const twins = [worker, peer({ id: "w3", requestId: "req-20260916T062244Z" })];
    const { from } = partiesOf(card(REPORT), manager, twins);
    expect(from).toEqual({ role: "worker", id: null, title: null });
    expect(partyName(from)).toBe("Worker (unknown)");
    // Not a paseo-bm chat at all.
    expect(partiesOf(card(INSTRUCTION), null, []).from).toEqual({ role: null, id: null, title: null });
  });

  it("draws a card only in a paseo-bm chat, and a sent block only for the role that writes it", () => {
    expect(drawAsCard(card(REPORT), manager)).toBe(true);
    expect(drawAsCard(card(REPORT), null)).toBe(false);
    expect(drawAsCard(card(REVIEW, "assistant_message"), reviewer)).toBe(true);
    // A Manager quoting a review is not a Reviewer's verdict.
    expect(drawAsCard(card(REVIEW, "assistant_message"), manager)).toBe(false);
    expect(drawAsCard(card(REPORT, "assistant_message"), worker)).toBe(true);
  });

  it("maps roles to the graph icons", () => {
    expect([markOf("manager"), markOf("worker"), markOf("reviewer"), markOf(null)]).toEqual(["request", "worker", "reviewer", null]);
  });
});

describe("what the card says", () => {
  it("colours the status and summarises a report", () => {
    const report = card(REPORT);
    expect(statusChip(report)).toEqual({ text: "blocked", tone: "warning" });
    expect(summaryOf(report)).toBe("Large · beads 2 created, 1 closed · waiting on: Q1 — keep the old label?");
    expect(statusChip(card(REVIEW, "assistant_message"))).toEqual({ text: "pass", tone: "success" });
    expect(statusChip(card(INSTRUCTION))).toBeNull();
  });

  it("renders report fields as a bold-key list, not one paragraph", () => {
    const blocks = parseMarkdown(markdownOf(["```", REPORT, "```", "", "Anything else?"].join("\n")));
    expect(blocks[0]).toMatchObject({ kind: "paragraph", spans: [{ text: "BM-REPORT", bold: true }] });
    const bullets = blocks.filter((block) => block.kind === "bullet");
    expect(bullets).toHaveLength(12);
    expect(bullets[0]).toMatchObject({ spans: [{ text: "requestId", bold: true }, { text: ": req-20260916T062244Z" }] });
    expect(blocks.some((block) => block.kind === "code")).toBe(false);
    expect(blocks.at(-1)).toMatchObject({ kind: "paragraph" });
  });

  it("leaves free text as it is", () => {
    expect(markdownOf(INSTRUCTION)).toBe(INSTRUCTION);
  });

  it("names the request in a reply, and offers quick answers only when the Worker waits", () => {
    expect(replyText(card(REVIEW_REQUEST), "  Looks right.  ")).toBe(
      "Reply from the user about `req-20260916T081749Z`, batch b1:\n\nLooks right.",
    );
    expect(quickReplies(card(REPORT))).toHaveLength(2);
    expect(quickReplies(card(REVIEW, "assistant_message"))).toEqual([]);
  });

  it("keeps card data JSON, as Paseo requires", () => {
    const data: ChatCard = card(REPORT);
    expect(JSON.parse(JSON.stringify(data))).toEqual(data);
  });
});

describe("chat.peers", () => {
  const entry = (id: string, role: string, workspaceId: string, labels: Record<string, string> = {}) => ({
    agent: { id, workspaceId, status: "idle", title: `${role} ${id}`, labels: { "bm.role": role, ...labels } },
  });
  const paseo = (): DashboardPaseo => ({
    agents: {
      list: vi.fn(async ({ filter }: { filter: { labels: Record<string, string> } }) => ({
        entries: [
          entry("m1", "manager", "wks_a"),
          entry("w1", "worker", "wks_a", { "bm.requestId": "req-1", "paseo.parent-agent-id": "m1" }),
          entry("w9", "worker", "wks_b"),
          entry("r1", "reviewer", "wks_a", { "bm.requestId": "req-1", "bm.batchId": "b2", "paseo.parent-agent-id": "w1" }),
        ].filter((e) => e.agent.labels["bm.role"] === filter.labels["bm.role"]),
      })),
    },
    workspaces: { list: vi.fn(async () => ({ entries: [] })) },
    config: { get: vi.fn(async () => ({ config: {} })) },
  });

  it("returns the owner and the paseo-bm agents of its workspace only", async () => {
    const result = await handleChatPeers({ agentId: "r1" }, paseo(), { homedir: () => "/nonexistent-bm-home" });
    expect(result.owner).toMatchObject({ id: "r1", role: "reviewer", parentId: "w1", requestId: "req-1", batchId: "b2" });
    expect(result.peers.map((p) => p.id).sort()).toEqual(["m1", "w1"]);
  });

  it("reads the request of an agent without a label from what it wrote", async () => {
    // Workers made by paseo-bm 0.1.0 carry no bm.requestId label (seen on the owner's workspace).
    const home = mkdtempSync(join(tmpdir(), "bm-chat-peers-"));
    try {
      mkdirSync(join(home, ".paseo-bm"), { recursive: true });
      writeFileSync(join(home, ".paseo-bm", "install.json"), JSON.stringify({ schemaVersion: 1 }));
      await appendRecord({ tracesDir: join(home, ".paseo-bm", "traces") }, {
        v: TRACE_STORE_SCHEMA_VERSION, kind: "turn", at: "2026-09-16T10:00:00.000Z", workspaceId: "wks_a", agentId: "w0",
        role: "worker", turnId: "t1", requestId: null, parentAgentId: null, agentCreatedAt: null, startedAt: null,
        endedAt: "2026-09-16T10:00:00.000Z", outcome: "completed", received: [], reports: [], reviews: [], evidence: [], usage: null,
        sent: [{ agentId: null, at: "2026-09-16T09:59:00.000Z", text: "TIẾP TỤC LÀM VIỆC — `req-20260916T062244Z`", truncated: false }],
      });
      clearTraceStoreCache();
      const withUnlabelled = paseo();
      const list = withUnlabelled.agents.list;
      withUnlabelled.agents.list = vi.fn(async (options: { filter: { labels: Record<string, string> } }) => {
        const result = await list(options as never);
        return options.filter.labels["bm.role"] === "worker" ? { entries: [...result.entries, entry("w0", "worker", "wks_a")] } : result;
      }) as never;
      const result = await handleChatPeers({ agentId: "m1" }, withUnlabelled, { homedir: () => home });
      expect(result.peers.find((p) => p.id === "w0")?.requestId).toBe("req-20260916T062244Z");
      expect(result.peers.find((p) => p.id === "w1")?.requestId).toBe("req-1");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("has nothing for an agent that is not paseo-bm's", async () => {
    expect(await handleChatPeers({ agentId: "someone-else" }, paseo(), { homedir: () => "/nonexistent-bm-home" })).toEqual({ owner: null, peers: [], workspaceId: null });
  });
});
