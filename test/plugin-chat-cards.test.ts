import { describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { appendRecord, clearTraceStoreCache } from "../plugin/server/trace-store";
import {
  answeredHow,
  answerSummary,
  answeredKey,
  answersDraft,
  chatCardSchema,
  drawAsCard,
  fallbackMarkdown,
  ownerWarning,
  isAnswered,
  recommendedPicks,
  replyControls,
  sentSummary,
  showsQuestions,
  startsOpen,
  stillWaiting,
  topicOf,
  markdownOf,
  markOf,
  outlineTone,
  partiesOf,
  partyName,
  questionHeading,
  quickReplies,
  replyTarget,
  replyText,
  sendReply,
  statusChip,
  summaryOf,
  toChatCard,
  beadChipsView,
  visibleBeads,
  withAnswersBlock,
  candidateCost,
  fallbackActError,
  fallbackCardOfIncident,
  fallbackCardView,
  fallbackNoticeCardSchema,
  listedCostProvider,
  localTimeText,
  lookupOf,
  runFallbackAction,
  waitDeadline,
  type ChatCard,
  type FallbackLookup,
} from "../plugin/client/chat-cards";
import { parseMarkdown } from "../plugin/client/markdown";
import { answeredRecord, answersVersion, repliedAt, setAnswered, setReplied, subscribeAnswers } from "../plugin/client/answer-state";
import type { Question } from "../plugin/shared/bm-questions";
import type { BeadRow } from "../plugin/shared/contracts";
import { handleChatPeers } from "../plugin/server/chat-rpc";
import { fallbackNotice } from "../plugin/server/fallback-rpc";
import type { DashboardPaseo } from "../plugin/server/dashboard-rpc";
import { DashboardError, FALLBACK_MAX_WAIT_MS, TRACE_STORE_SCHEMA_VERSION, type ChatPeer, type FallbackIncident } from "../plugin/shared/contracts";
import { soleWorkerOf } from "../plugin/shared/sole-worker";

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
  archived: false,
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

  it("cuts a long waiting-on text on the summary line (delta 20260918c, Q50)", () => {
    const long = "\"Continue\" does not tell me the result of the real-daemon check, and everything left waits on it. ".repeat(12);
    const summary = summaryOf(card(REPORT.replace("blockers: Q1 — keep the old label?", `blockers: ${long}`)));
    const waiting = summary.slice(summary.indexOf("waiting on: ") + "waiting on: ".length);
    expect(summary.startsWith("Large · beads 2 created, 1 closed · waiting on: ")).toBe(true);
    expect(waiting.length).toBeLessThanOrEqual(160);
    expect(waiting.endsWith("…")).toBe(true);
    expect(long.startsWith(waiting.slice(0, -1))).toBe(true);
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
      // The daemon applies a labels filter only when one is given (delta 20260918g lists with none).
      list: vi.fn(async ({ filter }: { filter: { labels?: Record<string, string> } }) => ({
        entries: [
          entry("m1", "manager", "wks_a"),
          entry("w1", "worker", "wks_a", { "bm.requestId": "req-1", "paseo.parent-agent-id": "m1" }),
          entry("w9", "worker", "wks_b"),
          entry("r1", "reviewer", "wks_a", { "bm.requestId": "req-1", "bm.batchId": "b2", "paseo.parent-agent-id": "w1" }),
        ].filter((e) => filter.labels === undefined || e.agent.labels["bm.role"] === filter.labels["bm.role"]),
      })),
    },
    workspaces: { list: vi.fn(async () => ({ entries: [] })) },
    config: { get: vi.fn(async () => ({ config: {} })) },
  });

  it("says which agents are archived (delta 20260918f F12)", async () => {
    const withArchived = paseo();
    const list = withArchived.agents.list;
    withArchived.agents.list = vi.fn(async (options: { filter: { labels?: Record<string, string> } }) => {
      const result = await list(options as never);
      const old = { agent: { ...entry("w0", "worker", "wks_a", { "bm.requestId": "req-1" }).agent, archivedAt: "2026-09-18T00:00:00.000Z" } };
      const wantsWorkers = options.filter.labels === undefined || options.filter.labels["bm.role"] === "worker";
      return wantsWorkers ? { entries: [...result.entries, old] } : result;
    }) as never;
    const result = await handleChatPeers({ agentId: "m1" }, withArchived, { homedir: () => "/nonexistent-bm-home" });
    expect(result.owner?.archived).toBe(false);
    expect(Object.fromEntries(result.peers.map((p) => [p.id, p.archived]))).toEqual({ w0: true, w1: false, r1: false });
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
      withUnlabelled.agents.list = vi.fn(async (options: { filter: { labels?: Record<string, string> } }) => {
        const result = await list(options as never);
        const wantsWorkers = options.filter.labels === undefined || options.filter.labels["bm.role"] === "worker";
        return wantsWorkers ? { entries: [...result.entries, entry("w0", "worker", "wks_a")] } : result;
      }) as never;
      const result = await handleChatPeers({ agentId: "m1" }, withUnlabelled, { homedir: () => home });
      expect(result.peers.find((p) => p.id === "w0")?.requestId).toBe("req-20260916T062244Z");
      expect(result.peers.find((p) => p.id === "w1")?.requestId).toBe("req-1");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("marks a Worker replaced by a fallback Worker: by its bm.replacedBy label, or by a switched incident (delta 20260921 §4.4.8)", async () => {
    const home = mkdtempSync(join(tmpdir(), "bm-chat-peers-replaced-"));
    try {
      mkdirSync(join(home, ".paseo-bm"), { recursive: true });
      writeFileSync(join(home, ".paseo-bm", "install.json"), JSON.stringify({ schemaVersion: 1 }));
      const switched = {
        id: "fb-0000000000dd", role: "worker", workspaceId: "wks_a", requestId: "req-1", agentId: "w0", agentProvider: "bm-worker",
        agentModel: null, parentId: "m1", managerId: "m1", class: "L1", signal: "failed", message: "", perModelWindow: false,
        resetsAt: null, candidate: null, status: "switched", detectedAt: "2026-09-22T00:00:00.000Z", decidedAt: "2026-09-22T00:01:00.000Z",
        waitUntil: null, replacementId: "w1", error: null,
      };
      writeFileSync(join(home, ".paseo-bm", "role-fallback-state.json"), JSON.stringify({ version: 1, incidents: [switched] }));
      const sdk = paseo();
      const list = sdk.agents.list;
      sdk.agents.list = vi.fn(async (options: { filter: { labels?: Record<string, string> } }) => {
        const result = await list(options as never);
        const extra = [
          // Label missing (labelling failed), but the incident says it was switched.
          entry("w0", "worker", "wks_a", { "bm.requestId": "req-1", "paseo.parent-agent-id": "m1" }),
          entry("w8", "worker", "wks_a", { "bm.requestId": "req-8", "bm.replacedBy": "w1" }),
        ];
        return options.filter.labels === undefined ? { entries: [...result.entries, ...extra] } : result;
      }) as never;
      const result = await handleChatPeers({ agentId: "m1" }, sdk, { homedir: () => home });
      const replaced = Object.fromEntries(result.peers.map((p) => [p.id, p.replaced]));
      expect(replaced).toEqual({ w1: false, r1: false, w0: true, w8: true });
      // So the request's Worker is the replacement, not the one it replaced.
      expect(soleWorkerOf(result.peers, "req-1")?.id).toBe("w1");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("has nothing for an agent that is not paseo-bm's", async () => {
    expect(await handleChatPeers({ agentId: "someone-else" }, paseo(), { homedir: () => "/nonexistent-bm-home" })).toEqual({ owner: null, peers: [], workspaceId: null });
  });
});

/**
 * The question card (delta 20260918c-question-cards §4.4): a Worker's
 * `blocked` report with a `BM-QUESTIONS` block, seen in the Manager's chat.
 */
const QUESTIONS = [
  "BM-QUESTIONS",
  "requestId: req-20260916T062244Z",
  "Q6: Storage — where does the list live?",
  "- a: the existing table: no migration. (recommended)",
  "- b: a file on disk: simplest.",
  "Q7: Sessions — rename the cookie?",
  "- a: keep it. (recommended)",
  "- b: rename it.",
].join("\n");
const ASKING = `${REPORT.replace("blockers: Q1 — keep the old label?", "blockers: 2 questions: Q6, Q7 — see BM-QUESTIONS")}\n\n${QUESTIONS}`;

describe("a report's questions", () => {
  it("are read into the card, and change the summary and the quick replies", () => {
    const asking = card(ASKING);
    expect(asking.questions.map((question) => question.id)).toEqual(["Q6", "Q7"]);
    expect(asking.questions[0]!.options).toEqual([
      { key: "a", text: "the existing table: no migration.", recommended: true },
      { key: "b", text: "a file on disk: simplest.", recommended: false },
    ]);
    expect(summaryOf(asking)).toBe("Large · beads 2 created, 1 closed · 2 questions waiting");
    expect(quickReplies(asking)).toEqual([]);
    expect(JSON.parse(JSON.stringify(asking))).toEqual(asking);
    expect(chatCardSchema.parse(asking).questions).toHaveLength(2);
  });

  it("are not taken from a block about another request", () => {
    expect(card(ASKING.replace("requestId: req-20260916T062244Z\nQ6", "requestId: req-20260916T081749Z\nQ6")).questions).toEqual([]);
  });

  it("leave an old-style report as it was", () => {
    const old = card(REPORT);
    expect(old.questions).toEqual([]);
    expect(summaryOf(old)).toBe("Large · beads 2 created, 1 closed · waiting on: Q1 — keep the old label?");
    expect(quickReplies(old)).toHaveLength(2);
    // A card built before the field existed still validates.
    const before: Partial<ChatCard> = { ...old };
    delete before.questions;
    expect(chatCardSchema.parse(before).questions).toEqual([]);
  });

  it("show buttons only in the Manager's chat, on the report it received", () => {
    const asking = card(ASKING);
    expect(showsQuestions(asking, manager)).toBe(true);
    expect(showsQuestions(asking, worker)).toBe(false);
    expect(showsQuestions(asking, reviewer)).toBe(false);
    expect(showsQuestions(asking, null)).toBe(false);
    expect(showsQuestions(card(ASKING, "assistant_message"), manager)).toBe(false);
    expect(showsQuestions(card(REPORT), manager)).toBe(false);
  });

  it("split a question into its topic and the rest", () => {
    expect(topicOf(card(ASKING).questions[0]!)).toEqual({ topic: "Storage", rest: "where does the list live?" });
    expect(topicOf({ id: "Q1", text: "No topic here", options: [] })).toEqual({ topic: null, rest: "No topic here" });
  });

  it("draw a bold heading of id and topic, and the question on its own line (delta 20260918d, Q5)", () => {
    expect(questionHeading(card(ASKING).questions[0]!)).toEqual({ heading: "Q6 · Storage", body: "where does the list live?" });
    expect(questionHeading({ id: "Q1", text: "No topic here", options: [] })).toEqual({ heading: "Q1", body: "No topic here" });
  });

  it("render as nested Markdown when the message is opened", () => {
    const blocks = parseMarkdown(markdownOf(QUESTIONS));
    expect(blocks[0]).toMatchObject({ kind: "paragraph", spans: [{ text: "BM-QUESTIONS", bold: true }] });
    const bullets = blocks.filter((block) => block.kind === "bullet");
    expect(bullets.map((block) => (block.kind === "bullet" ? block.depth : -1))).toEqual([0, 0, 1, 1, 0, 1, 1]);
    expect(bullets[1]).toMatchObject({ spans: [{ text: "Q6", bold: true }, { text: ": Storage — where does the list live?" }] });
    expect(bullets[2]).toMatchObject({ spans: [{ text: "a", bold: true }, { text: ": the existing table: no migration. (recommended)" }] });
  });
});

describe("choosing answers", () => {
  const questions = card(ASKING).questions;

  it("fills recommendations only into empty questions, and never pre-selects", () => {
    expect(recommendedPicks(questions, {})).toEqual({ Q6: { key: "a" }, Q7: { key: "a" } });
    expect(recommendedPicks(questions, { Q6: { key: "b" } })).toEqual({ Q6: { key: "b" }, Q7: { key: "a" } });
    expect(recommendedPicks(questions, { Q7: { other: "later" } })).toEqual({ Q6: { key: "a" }, Q7: { other: "later" } });
  });

  // Delta 20260918d (owner decision Q4): Send no longer waits for every
  // question. These cases replace `formComplete`'s: the same picks, now
  // checked one question at a time and in the block they produce.
  it("counts a pick as an answer only for an existing option or the user's own words", () => {
    const [q6, q7] = questions as [Question, Question];
    expect(isAnswered(q6, undefined)).toBe(false);
    expect(isAnswered(q6, { key: "a" })).toBe(true);
    expect(isAnswered(q6, { key: "z" })).toBe(false);
    expect(isAnswered(q7, { other: "   " })).toBe(false);
    expect(isAnswered(q7, { other: "rename next release" })).toBe(true);
  });

  it("writes a line only for each answered question", () => {
    const asking = card(ASKING);
    expect(answersDraft(asking, {})).toBe("");
    expect(answersDraft(asking, { Q6: { key: "z" }, Q7: { other: "   " } })).toBe("");
    expect(answersDraft(asking, { Q6: { key: "a" } })).toBe(
      ["BM-ANSWERS", "requestId: req-20260916T062244Z", "Q6: a — the existing table: no migration."].join("\n"),
    );
    expect(answersDraft(asking, { Q6: { key: "a" }, Q7: { other: "rename next release" } })).toBe(
      ["BM-ANSWERS", "requestId: req-20260916T062244Z", "Q6: a — the existing table: no migration.", "Q7: other — rename next release"].join("\n"),
    );
    // "Use recommendations", then Send: two actions still answer every question.
    expect(answersDraft(asking, recommendedPicks(questions, {}))).toBe(
      ["BM-ANSWERS", "requestId: req-20260916T062244Z", "Q6: a — the existing table: no migration.", "Q7: a — keep it."].join("\n"),
    );
    // No request, nothing to address the answers to.
    expect(answersDraft({ ...asking, requestId: null }, { Q6: { key: "a" } })).toBe("");
  });

  it("answers a question without options only in the user's own words", () => {
    const lone = [{ id: "Q9", text: "Anything else?", options: [{ key: "a", text: "no", recommended: true }] }];
    expect(recommendedPicks(lone, {})).toEqual({});
    expect(isAnswered(lone[0]!, { key: "a" })).toBe(false);
    expect(isAnswered(lone[0]!, { other: "no" })).toBe(true);
  });

  it("summarises only what was answered", () => {
    expect(answerSummary(questions, { Q6: { key: "a" }, Q7: { other: "rename it" } })).toBe("Q6 a, Q7 other");
    expect(answerSummary(questions, { Q6: { key: "b" }, Q7: { other: "  " } })).toBe("Q6 b");
  });
});

describe("the answers block in the Reply box", () => {
  const block = ["BM-ANSWERS", "requestId: req-20260916T062244Z", "Q6: a — the existing table: no migration."].join("\n");
  const older = ["BM-ANSWERS", "requestId: req-20260916T062244Z", "Q6: b — a file on disk: simplest.", "Q7: a — keep it."].join("\n");

  it("goes into an empty box", () => {
    expect(withAnswersBlock("", block)).toBe(block);
    expect(withAnswersBlock("", "")).toBe("");
  });

  it("replaces the old block and keeps the words below it", () => {
    const result = withAnswersBlock(`${older}\n\nShip it after lunch.`, block);
    expect(result.startsWith(block)).toBe(true);
    expect(result).toBe(`${block}\n\nShip it after lunch.`);
  });

  it("moves words typed above the old block below the new one", () => {
    const result = withAnswersBlock(`note\n\n${older}`, block);
    expect(result.startsWith(block)).toBe(true);
    expect(result).toBe(`${block}\n\nnote`);
  });

  it("keeps words from both sides, in order, without a double blank line", () => {
    const result = withAnswersBlock(`first\n\n${older}\n\nsecond`, block);
    expect(result.startsWith(block)).toBe(true);
    expect(result).toBe(`${block}\n\nfirst\n\nsecond`);
    expect(result).not.toContain("\n\n\n");
  });

  it("puts a block above words that had none", () => {
    const result = withAnswersBlock("OK", block);
    expect(result.startsWith(block)).toBe(true);
    expect(result).toBe(`${block}\n\nOK`);
  });

  it("leaves the words alone when there is no block to write", () => {
    expect(withAnswersBlock(`${older}\n\nShip it.`, "")).toBe("Ship it.");
    expect(withAnswersBlock(`\n${older}\n`, "")).toBe("");
    expect(withAnswersBlock("Just words.\nTwo lines.", "")).toBe("Just words.\nTwo lines.");
  });

  it("knows whether a sent reply still carried the answers", () => {
    const asking = card(ASKING);
    const picks = { Q6: { key: "a" }, Q7: { other: "rename it" } };
    const box = withAnswersBlock("Thanks.", answersDraft(asking, picks));
    expect(sentSummary(asking, picks, box)).toBe("Q6 a, Q7 other");
    expect(sentSummary(asking, picks, "Thanks.")).toBeNull();
    expect(sentSummary(asking, {}, "Thanks.")).toBeNull();
  });
});

describe("the answered memory", () => {
  const asking = card(ASKING);

  it("keys the answered memory on the chat, the request, the questions and the message", () => {
    expect(answeredKey("m1", asking)).toBe(answeredKey("m1", card(ASKING)));
    expect(answeredKey("m1", asking)).not.toBe(answeredKey("m2", asking));
    expect(answeredKey("m1", asking)).not.toBe(answeredKey("m1", card(`${ASKING}\nThat is all.`)));
  });
});

/**
 * Answers sent from a question card go through the Reply box (delta 20260918d
 * §4.1–§4.3). These replace the `sendAnswers` cases: the same peers and the
 * same failures, now on `sendReply` with the box the picks wrote.
 */
describe("sending the answers", () => {
  const asking = card(ASKING);
  const picks = { Q6: { key: "a" }, Q7: { other: "rename it next release" } };
  const box = withAnswersBlock("", answersDraft(asking, picks));
  const expected = replyText(asking, box);

  it("goes as one message to the asking Worker, block first", async () => {
    const refreshPeers = vi.fn(async () => ({ owner: manager, peers: [worker, otherWorker, reviewer] }));
    const send = vi.fn(async () => undefined);
    expect(await sendReply({ card: asking, text: box, refreshPeers, send })).toEqual({ ok: true, to: worker, text: expected });
    expect(refreshPeers).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith("w1", expected);
    expect(expected).toBe(
      [
        "Reply from the user about `req-20260916T062244Z`:",
        "",
        "BM-ANSWERS",
        "requestId: req-20260916T062244Z",
        "Q6: a — the existing table: no migration.",
        "Q7: other — rename it next release",
      ].join("\n"),
    );
  });

  it("carries the picks together with the user's own words (the owner's bug)", async () => {
    // The owner ticked an option, typed "OK" and pressed Send: only "OK" arrived.
    const withWords = withAnswersBlock("OK", answersDraft(asking, { Q6: { key: "a" } }));
    const send = vi.fn(async () => undefined);
    const result = await sendReply({ card: asking, text: withWords, refreshPeers: async () => ({ owner: manager, peers: [worker] }), send });
    expect(result.ok).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith("w1", replyText(asking, withWords));
    const sent = (send.mock.calls[0] as unknown as [string, string])[1];
    expect(sent).toContain("Q6: a — the existing table: no migration.");
    expect(sent).toContain("OK");
  });

  it("does not send when the Worker started running since the card was drawn", async () => {
    const send = vi.fn(async () => undefined);
    const result = await sendReply({
      card: asking,
      text: box,
      refreshPeers: async () => ({ owner: manager, peers: [{ ...worker, status: "running" }] }),
      send,
    });
    expect(result).toEqual({ ok: false, reason: expect.stringContaining("is working") });
    expect(send).not.toHaveBeenCalled();
  });

  it("reports a failed send and a failed refresh", async () => {
    expect(
      await sendReply({
        card: asking,
        text: box,
        refreshPeers: async () => ({ owner: manager, peers: [worker] }),
        send: async () => {
          throw new Error("Agent not found");
        },
      }),
    ).toEqual({ ok: false, reason: "Agent not found" });
    const send = vi.fn(async () => undefined);
    expect(
      await sendReply({
        card: asking,
        text: box,
        refreshPeers: async () => {
          throw new Error("daemon unreachable");
        },
        send,
      }),
    ).toEqual({ ok: false, reason: "daemon unreachable" });
    expect(send).not.toHaveBeenCalled();
  });

  it("sends nothing when nothing was picked or written", async () => {
    const refreshPeers = vi.fn(async () => ({ owner: manager, peers: [worker] }));
    const send = vi.fn(async () => undefined);
    const empty = withAnswersBlock("", answersDraft(asking, {}));
    expect(await sendReply({ card: asking, text: empty, refreshPeers, send })).toEqual({ ok: false, reason: "Write a reply first." });
    expect(refreshPeers).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });
});


/**
 * Every card's Reply box (delta 20260918d-card-replies §4.2, owner decision
 * Q4): the recipient comes from `chat.peers`, its status is read again just
 * before sending, and a running recipient is never sent to.
 */
describe("where a reply goes", () => {
  const asking = card(ASKING);
  const reviewCard = card(REVIEW);
  const instruction = card(INSTRUCTION);
  const lead = peer({ id: "w2", title: "PAKD fix", parentId: "m1", requestId: "req-20260916T081749Z" });
  const contact = peer({ id: "w1", title: "Contact redesign", parentId: "m1", requestId: "req-20260916T062244Z" });

  it("to the one Worker of a report's request, when it is idle or errored", () => {
    expect(replyTarget(asking, manager, [worker, otherWorker, reviewer])).toEqual({ peer: worker });
    expect(replyTarget(asking, manager, [{ ...worker, status: "error" }])).toEqual({ peer: { ...worker, status: "error" } });
  });

  it("to the live Worker when an archived one has the same request, and never to an archived agent (delta 20260918f F12)", () => {
    // A broken Worker the Manager replaced keeps the request label; the user archived it.
    const broken = peer({ id: "w0", title: "Broken", parentId: "m1", requestId: "req-20260916T062244Z", archived: true });
    expect(replyTarget(asking, manager, [broken, worker, reviewer])).toEqual({ peer: worker });
    expect(partiesOf(asking, manager, [broken, worker]).from.id).toBe("w1");
    // Only the archived one: still named on the card, but nothing is sent to it.
    expect(partiesOf(asking, manager, [broken]).from.id).toBe("w0");
    expect(replyTarget(asking, manager, [broken])).toEqual({ reason: "Worker · Broken is archived." });
  });

  it("nowhere when no single Worker has the report's request", () => {
    expect(replyTarget(asking, manager, [otherWorker])).toEqual({
      reason: "Cannot tell which Worker asked this: no single Worker has `req-20260916T062244Z`.",
    });
    const twin = peer({ id: "w3", requestId: "req-20260916T062244Z" });
    expect(replyTarget(asking, manager, [worker, twin])).toEqual({
      reason: "Cannot tell which Worker asked this: no single Worker has `req-20260916T062244Z`.",
    });
  });

  it("not now when the Worker is running, starting or closed", () => {
    for (const status of ["running", "initializing"]) {
      expect(replyTarget(asking, manager, [{ ...worker, status }])).toEqual({
        reason: "Worker · Contact redesign is working; a message now would replace its turn. Send when it stops.",
      });
    }
    expect(replyTarget(asking, manager, [{ ...worker, status: "closed" }])).toEqual({ reason: "Worker · Contact redesign is closed." });
  });

  it("guards a Reviewer's and a Manager's turn the same way", () => {
    // A review in its Worker's chat answers the Reviewer of that batch.
    expect(replyTarget(reviewCard, lead, [manager, reviewer])).toEqual({ peer: reviewer });
    expect(replyTarget(reviewCard, lead, [manager, { ...reviewer, status: "running" }])).toEqual({
      reason: "Reviewer r1 is working; a message now would replace its turn. Send when it stops.",
    });
    // A Manager's instruction in a Worker's chat answers that Manager.
    expect(replyTarget(instruction, contact, [manager, reviewer])).toEqual({ peer: manager });
    expect(replyTarget(instruction, contact, [{ ...manager, status: "running" }])).toEqual({
      reason: "Manager · Beads Manager is working; a message now would replace its turn. Send when it stops.",
    });
    expect(replyTarget(instruction, contact, [])).toEqual({ reason: "Cannot tell which Manager to send this to." });
  });
});

describe("sending a reply", () => {
  const asking = card(ASKING);
  const text = "Keep the old label.";
  const expected = replyText(asking, text);

  it("re-reads the peers, then sends one message to the recipient", async () => {
    const refreshPeers = vi.fn(async () => ({ owner: manager, peers: [worker, otherWorker, reviewer] }));
    const send = vi.fn(async () => undefined);
    expect(await sendReply({ card: asking, text, refreshPeers, send })).toEqual({ ok: true, to: worker, text: expected });
    expect(refreshPeers).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith("w1", expected);
  });

  it("does not send when the recipient started running since the card was drawn", async () => {
    const send = vi.fn(async () => undefined);
    const result = await sendReply({
      card: asking,
      text,
      refreshPeers: async () => ({ owner: manager, peers: [{ ...worker, status: "running" }] }),
      send,
    });
    expect(result).toEqual({ ok: false, reason: expect.stringContaining("is working") });
    expect(send).not.toHaveBeenCalled();
  });

  it("reports a failed send and a failed refresh", async () => {
    expect(
      await sendReply({
        card: asking,
        text,
        refreshPeers: async () => ({ owner: manager, peers: [worker] }),
        send: async () => {
          throw new Error("Agent not found");
        },
      }),
    ).toEqual({ ok: false, reason: "Agent not found" });
    const send = vi.fn(async () => undefined);
    expect(
      await sendReply({
        card: asking,
        text,
        refreshPeers: async () => {
          throw new Error("daemon unreachable");
        },
        send,
      }),
    ).toEqual({ ok: false, reason: "daemon unreachable" });
    expect(send).not.toHaveBeenCalled();
  });

  it("touches nothing while the box is blank", async () => {
    const refreshPeers = vi.fn(async () => ({ owner: manager, peers: [worker] }));
    const send = vi.fn(async () => undefined);
    expect(await sendReply({ card: asking, text: "  \n ", refreshPeers, send })).toEqual({ ok: false, reason: "Write a reply first." });
    expect(refreshPeers).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });
});

describe("related beads on a card (delta 20260918d, batch b4)", () => {
  const ids = ["bm-a", "bm-b", "bm-c", "bm-d", "bm-e", "bm-f", "bm-g"];

  it("shows two and folds the rest behind the … chip", () => {
    expect(visibleBeads([], false)).toEqual({ shown: [], hidden: 0 });
    expect(visibleBeads(ids.slice(0, 2), false)).toEqual({ shown: ["bm-a", "bm-b"], hidden: 0 });
    expect(visibleBeads(ids.slice(0, 3), false)).toEqual({ shown: ["bm-a", "bm-b"], hidden: 1 });
    expect(visibleBeads(ids, false)).toEqual({ shown: ["bm-a", "bm-b"], hidden: 5 });
  });

  it("shows every bead once the … chip was pressed", () => {
    expect(visibleBeads(ids, true)).toEqual({ shown: ids, hidden: 0 });
    expect(visibleBeads(ids, true).shown).not.toBe(ids);
  });

  it("counts only beads the store really has: two chips, then … for the rest found (delta 20260918f F10)", () => {
    // `beadIdCandidates` is a shape test: a report's text yields BM-REPORT,
    // BM-QUESTIONS and hyphenated words before the real ids. The lookup keeps
    // the ids the store has, in the order asked; only then are two shown.
    const found = ["bm-a", "bm-b", "bm-c"].map((id) => ({ id }) as unknown as BeadRow);
    expect(beadChipsView(found, false)).toEqual({ shown: found.slice(0, 2), hidden: 1 });
    expect(beadChipsView(found, true)).toEqual({ shown: found, hidden: 0 });
    expect(beadChipsView([], false)).toEqual({ shown: [], hidden: 0 });
  });

  it("hands the lookup every candidate, and lets BeadChips fold what it found", () => {
    const card = readFileSync(fileURLToPath(new URL("../plugin/client/chat-card.tsx", import.meta.url)), "utf8");
    const chips = readFileSync(fileURLToPath(new URL("../plugin/client/bead-chips.tsx", import.meta.url)), "utf8");
    expect(card).toMatch(/<BeadChips\b[^>]*\bids=\{beadIds\}/);
    expect(card).not.toMatch(/visibleBeads\(/);
    expect(chips).toMatch(/beadChipsView\(/);
    expect(chips).toMatch(/accessibilityLabel=\{`Show all \$\{/);
  });
});

describe("the Reply button and the Answered chip (delta 20260918d, batch b4, Q14)", () => {
  it("offers the Reply button until a reply went out, then the Answered chip", () => {
    expect(replyControls(true, false)).toEqual({ replyButton: true, answeredChip: false });
    expect(replyControls(true, true)).toEqual({ replyButton: false, answeredChip: true });
  });

  it("offers neither when the card cannot reply", () => {
    expect(replyControls(false, false)).toEqual({ replyButton: false, answeredChip: false });
    expect(replyControls(false, true)).toEqual({ replyButton: false, answeredChip: false });
  });
});

/**
 * One answered state for every copy of a card (delta 20260918d §4.9, batch b6,
 * owner decisions Q16 a, Q17 a): the session store every copy subscribes to,
 * and what `chat.waiting` says about a question card.
 */
describe("the session's answered state", () => {
  it("tells every subscriber about a write, and stops after unsubscribing", () => {
    const heard: number[] = [];
    const stop = subscribeAnswers(() => heard.push(answersVersion()));
    const before = answersVersion();
    setAnswered("m1|req-x|Q1|a", { at: new Date(0), summary: "Q1 a", to: "Worker · X" });
    setReplied("m1|req-x|Q1|a", new Date(1));
    expect(heard).toEqual([before + 1, before + 2]);
    expect(answeredRecord("m1|req-x|Q1|a")).toMatchObject({ summary: "Q1 a", to: "Worker · X" });
    expect(repliedAt("m1|req-x|Q1|a")).toEqual(new Date(1));
    stop();
    setReplied("m1|req-x|Q1|a", new Date(2));
    expect(heard).toHaveLength(2);
    expect(answeredRecord("unknown")).toBeNull();
    expect(repliedAt("unknown")).toBeNull();
  });
});

describe("a question card that is no longer waiting", () => {
  const asking = card(ASKING);
  const waitingEntry = {
    managerId: "m1",
    workspaceId: "wks_a",
    workerId: "w1",
    workerTitle: "Contact redesign",
    requestId: "req-20260916T062244Z",
    text: ASKING,
    at: null,
  };

  it("is still waiting only while chat.waiting lists this very report for this chat", () => {
    expect(stillWaiting(asking, "m1", [waitingEntry])).toBe(true);
    expect(stillWaiting(asking, "m2", [waitingEntry])).toBe(false);
    expect(stillWaiting(asking, "m1", [{ ...waitingEntry, requestId: "req-20260916T081749Z" }])).toBe(false);
    expect(stillWaiting(asking, "m1", [{ ...waitingEntry, text: `${ASKING}\nmore` }])).toBe(false);
    expect(stillWaiting(asking, "m1", [])).toBe(false);
  });

  it("counts as answered when sent, marked, or no longer listed — and not while unknown", () => {
    expect(answeredHow({ sent: true, marked: true, waiting: [], stillWaitingNow: false })).toBe("sent");
    expect(answeredHow({ sent: false, marked: true, waiting: null, stillWaitingNow: false })).toBe("marked");
    expect(answeredHow({ sent: false, marked: false, waiting: null, stillWaitingNow: false })).toBeNull();
    expect(answeredHow({ sent: false, marked: false, waiting: [waitingEntry], stillWaitingNow: true })).toBeNull();
    expect(answeredHow({ sent: false, marked: false, waiting: [], stillWaitingNow: false })).toBe("moved-on");
  });
});

describe("a finished report's card (delta 20260918d §4.10, req-20260918T074311Z)", () => {
  const FINISHED = REPORT.replace("phase: blocked", "phase: finished");
  const others = {
    received: card(REPORT.replace("phase: blocked", "phase: received")),
    "beads-done": card(REPORT.replace("phase: blocked", "phase: beads-done")),
    blocked: card(REPORT),
    "unreadable phase": card(REPORT.replace("phase: blocked", "phase: somewhere")),
    review: card(REVIEW, "assistant_message"),
    message: card(INSTRUCTION),
  };
  const source = readFileSync(fileURLToPath(new URL("../plugin/client/chat-card.tsx", import.meta.url)), "utf8");

  it("reads the cards it is tested with as intended", () => {
    expect(card(FINISHED)).toMatchObject({ type: "report", direction: "received", phase: "finished" });
    expect(card(FINISHED, "assistant_message")).toMatchObject({ type: "report", direction: "sent", phase: "finished" });
    expect(others["unreadable phase"]).toMatchObject({ type: "report", phase: null });
    expect(others.review.type).toBe("review");
    expect(others.message.type).toBe("message");
  });

  it("opens with the whole message showing, in the Manager's chat and in the Worker's own", () => {
    expect(startsOpen(card(FINISHED))).toBe(true);
    expect(startsOpen(card(FINISHED, "assistant_message"))).toBe(true);
  });

  /** One value per card of `others`, so a failure shows every card at once. */
  const each = <T>(of: (card: ChatCard) => T) => Object.fromEntries(Object.entries(others).map(([name, other]) => [name, of(other)]));
  const all = <T>(value: T) => Object.fromEntries(Object.keys(others).map((name) => [name, value]));

  it("leaves every other card folded", () => {
    expect(each(startsOpen)).toEqual(all(false));
  });

  it("wears a success outline, in the Manager's chat and in the Worker's own", () => {
    expect(outlineTone(card(FINISHED))).toBe("success");
    expect(outlineTone(card(FINISHED, "assistant_message"))).toBe("success");
  });

  it("leaves every other card with the usual border", () => {
    expect(each(outlineTone)).toEqual(all(null));
  });

  it("colours only the outer frame's border, at the usual width, never a left border", () => {
    expect(source).toContain("const outline = outlineTone(card);");
    expect(source).toContain(
      "<View style={[styles.card, { gap: 6, marginVertical: 4 }, outline === null ? null : { borderColor: toneColor(theme, outline) }]}>",
    );
    expect(source).not.toMatch(/borderLeft(Width|Color)/);
  });

  it("is the card's first open state, still toggled by its button", () => {
    expect(source).toContain("const [open, setOpen] = useState(() => startsOpen(card));");
    expect(source).not.toMatch(/\[open, setOpen\] = useState\(false\)/);
    expect(source).toContain("onPress={() => setOpen(!open)}");
  });
});

describe("ownerWarning (delta 20260918g §4.4)", () => {
  const peer = (labelled: boolean | undefined) => ({
    id: "f13a4e4e-18b6-4369-91c8-70c61460ef2d",
    role: "manager" as const,
    title: "Hãy pull code mới nhất từ branch dev về",
    status: "idle",
    parentId: null,
    requestId: null,
    batchId: null,
    archived: false,
    ...(labelled === undefined ? {} : { labelled }),
  });

  it("warns in the chat of an agent recognised only by its provider", () => {
    expect(ownerWarning(peer(false))).toEqual({
      chip: { text: "Not started by paseo-bm", tone: "warning" },
      line: "This agent has no bm.role label: it was started outside Beads Manager, and paseo-bm recognised it by its provider.",
    });
  });

  it("says nothing for a labelled agent, an older server's peer, or no owner", () => {
    expect(ownerWarning(peer(true))).toBeNull();
    expect(ownerWarning(peer(undefined))).toBeNull();
    expect(ownerWarning(null)).toBeNull();
  });
});

describe("formatIssues on cards (delta 20260918g §4.8)", () => {
  const REQ_G = "req-20260918T071130Z";
  const blockedReport = (options: string[]) =>
    [
      "BM-REPORT",
      `requestId: ${REQ_G}`,
      "phase: blocked",
      "tier: Large (changed: no)",
      "filesChanged: none",
      "beadsCreated: none",
      "beadsUpdated: none",
      "beadsClosed: none",
      "beadsReady: none",
      "reviewFindingsOpen: none",
      "buildAndTests: not run",
      "skillsUsed: feature-workflow",
      "blockers: 1 question: Q1 — see BM-QUESTIONS",
      "",
      "BM-QUESTIONS",
      `requestId: ${REQ_G}`,
      "Q1: Storage — where?",
      ...options,
    ].join("\n");
  const review = (verdict: string) =>
    ["BM-REVIEW", `requestId: ${REQ_G}`, "batchId: b4", "reviewKind: first", `verdict: ${verdict}`, "checked: the diff", "findings: none", "notChecked: none"].join("\n");

  it("lists the issues of a received block that breaks its template", () => {
    const card = toChatCard({ type: "user_message", text: blockedReport(["- a: the table.", "- b: a file."]) }, "complete")!;
    expect(card.formatIssues).toEqual(["BM-QUESTIONS Q1: needs exactly one option ending in (recommended) (found 0)"]);
  });

  it("is empty for a received block that follows its template", () => {
    const card = toChatCard({ type: "user_message", text: blockedReport(["- a: the table. (recommended)", "- b: a file."]) }, "complete")!;
    expect(card.formatIssues).toEqual([]);
  });

  it("checks a Reviewer's own review, but not a Worker quoting its report in its own chat", () => {
    const quoted = toChatCard({ type: "assistant_message", text: blockedReport(["- a: the table.", "- b: a file."]) }, "complete")!;
    expect(quoted.formatIssues).toEqual([]);
    const own = toChatCard({ type: "assistant_message", text: review("approved") }, "complete")!;
    expect(own.formatIssues).toEqual(["BM-REVIEW verdict: must be pass or changes-required"]);
  });

  it("never makes a card of what the user typed", () => {
    expect(toChatCard({ type: "user_message", text: review("approved"), clientMessageId: "c1" }, "complete")).toBeUndefined();
  });

  it("defaults to no issues for card data written before the field existed", () => {
    const older: Record<string, unknown> = { ...toChatCard({ type: "user_message", text: review("pass") }, "complete")! };
    delete older["formatIssues"];
    expect(chatCardSchema.parse(older).formatIssues).toEqual([]);
  });
});

describe("fallbackMarkdown (delta 20260918g §4.8, Q3 a)", () => {
  it("lays a report out like the card: one field per line, questions apart from their options", () => {
    const text = [
      "BM-REPORT",
      "requestId: req-20260918T070348Z",
      "phase: blocked",
      "blockers: 1 question: Q1 — see BM-QUESTIONS",
      "",
      "BM-QUESTIONS",
      "requestId: req-20260918T070348Z",
      "Q1: Storage — where?",
      "- a: the table. (recommended)",
      "- b: a file.",
    ].join("\n");
    const markdown = fallbackMarkdown({ text });
    expect(markdown).toBe(markdownOf(text));
    expect(markdown).toContain("- **phase**: blocked");
    expect(markdown).toContain("- **blockers**: 1 question: Q1 — see BM-QUESTIONS");
    expect(markdown).toContain("  - **a**: the table. (recommended)");
    // The raw text, rendered as Markdown, ran the fields into one paragraph.
    expect(markdown).not.toBe(text);
  });
});

describe("the fallback card (delta 20260921 §4.4.6, REQ-065 c)", () => {
  // Local times, so the labels read the same in every time zone.
  const NOW = new Date(2026, 8, 21, 14, 0);
  const at = (hours: number, minutes = 0, days = 0) => new Date(2026, 8, 21 + days, hours, minutes).toISOString();

  const incident = (overrides: Partial<FallbackIncident> = {}): FallbackIncident => ({
    id: "fb-3f9a2c1d7e4b",
    role: "worker",
    workspaceId: "wks_1",
    requestId: "req-20260921T111242Z",
    agentId: "wrk-1",
    agentProvider: "bm-worker/claude-opus-5",
    agentModel: "claude-opus-5",
    parentId: "mgr-1",
    managerId: "mgr-1",
    class: "L1",
    signal: "failed",
    message: "You've hit your usage limit.",
    perModelWindow: false,
    resetsAt: at(15, 40),
    candidate: { position: 1, alias: "bm-worker-fallback-1", baseProvider: "codex", model: "gpt-5.6-sol", thinkingOptionId: "high", modeId: null },
    status: "pending",
    detectedAt: "2026-09-21T14:00:00.000Z",
    decidedAt: null,
    waitUntil: null,
    replacementId: null,
    error: null,
    ...overrides,
  });
  /** The notice exactly as the plugin sends it. */
  const noticeOf = (overrides: Partial<FallbackIncident> = {}) => fallbackNotice(incident(overrides), () => "claude");
  const found = (overrides: Partial<FallbackIncident> = {}): FallbackLookup => ({ state: "found", incident: incident(overrides) });
  const cardOf = (text = noticeOf()) => toChatCard({ type: "user_message", text, clientMessageId: "sdk-message-id" }, "complete")!;
  const view = (lookup: FallbackLookup, cost: Parameters<typeof fallbackCardView>[3] = null) => fallbackCardView(cardOf(), lookup, NOW, cost);

  it("turns the plugin's notice into a fallback card, although Paseo stores a clientMessageId on it", () => {
    const card = cardOf();
    expect(chatCardSchema.parse(card)).toMatchObject({
      type: "fallback",
      direction: "received",
      requestId: "req-20260921T111242Z",
      questions: [],
      formatIssues: [],
      fallback: { incident: "fb-3f9a2c1d7e4b", role: "worker", agent: "wrk-1", class: "L1", provider: "bm-worker (claude) · claude-opus-5", message: "You've hit your usage limit." },
    });
    expect(toChatCard({ type: "user_message", text: noticeOf() }, "complete")?.type).toBe("fallback");
  });

  it("keeps no state of the notice: status, candidate and reset time come only from fallback.incidents", () => {
    expect(Object.keys(fallbackNoticeCardSchema.shape).sort()).toEqual(["agent", "class", "incident", "message", "provider", "role"]);
    expect(cardOf().fallback).not.toHaveProperty("status");
    // The notice says pending; the incident has been decided since: no button.
    const stale = fallbackCardView(cardOf(noticeOf({ status: "pending" })), found({ status: "dismissed" }), NOW, null);
    expect(stale.buttons).toEqual([]);
    expect(stale.statusLine).toEqual({ text: "Dismissed: you handle it.", tone: "muted" });
  });

  it("is made only for the notice itself, never for a quote of it", () => {
    expect(toChatCard({ type: "assistant_message", text: noticeOf() }, "complete")).toBeUndefined();
    expect(toChatCard({ type: "user_message", text: `The plugin said:\n\n${noticeOf()}`, clientMessageId: "c1" }, "complete")).toBeUndefined();
    expect(toChatCard({ type: "user_message", text: noticeOf().replace("fb-3f9a2c1d7e4b", "fb-nope"), clientMessageId: "c1" }, "complete")).toBeUndefined();
    // Every other card says it is not one.
    expect(toChatCard({ type: "user_message", text: REPORT }, "complete")?.fallback).toBeNull();
  });

  it("offers all three buttons for a pending incident with a candidate and a reset within 7 days", () => {
    const shown = view(found());
    expect(shown.buttons).toEqual([
      { action: "switch", label: "Switch to bm-worker-fallback-1 · Codex · gpt-5.6-sol" },
      { action: "wait", label: "Wait until 15:40" },
      { action: "dismiss", label: "I'll handle it" },
    ]);
    expect(shown.statusLine).toBeNull();
    expect(shown).toMatchObject({
      title: "Worker stopped by its provider plan",
      requestId: "req-20260921T111242Z",
      summary: "Usage limit (L1) · bm-worker · claude-opus-5",
      message: "You've hit your usage limit.",
      chip: { text: "pending", tone: "warning" },
    });
  });

  it("drops Switch without a candidate and Wait without a usable reset; I'll handle it stays", () => {
    const actions = (overrides: Partial<FallbackIncident>) => view(found(overrides)).buttons.map((button) => button.action);
    expect(actions({ candidate: null })).toEqual(["wait", "dismiss"]);
    expect(actions({ resetsAt: null })).toEqual(["switch", "dismiss"]);
    expect(actions({ resetsAt: "not a time" })).toEqual(["switch", "dismiss"]);
    expect(actions({ resetsAt: new Date(NOW.getTime() + FALLBACK_MAX_WAIT_MS + 60_000).toISOString() })).toEqual(["switch", "dismiss"]);
    expect(actions({ candidate: null, resetsAt: null })).toEqual(["dismiss"]);
  });

  it("waits up to exactly 7 days ahead, and resumes at once for a reset already past", () => {
    expect(waitDeadline(new Date(NOW.getTime() + FALLBACK_MAX_WAIT_MS).toISOString(), NOW)).not.toBeNull();
    expect(view(found({ resetsAt: at(10, 5, 1) })).buttons[1]).toEqual({ action: "wait", label: "Wait until tomorrow 10:05" });
    expect(view(found({ resetsAt: at(9, 0, 3) })).buttons[1]).toEqual({ action: "wait", label: "Wait until Thu 24 Sep 09:00" });
    expect(view(found({ resetsAt: at(13, 30) })).buttons[1]).toEqual({ action: "wait", label: "Resume now (the limit reset at 13:30)" });
  });

  it("names the candidate's price when one is known: the bundled table, then what Paseo lists", () => {
    const sonnet = { position: 1, alias: "bm-worker-fallback-1", baseProvider: "claude", model: "claude-sonnet-5", thinkingOptionId: null, modeId: null };
    expect(candidateCost(sonnet, null)).toEqual({ inputUsdPerMTok: 2, cacheReadUsdPerMTok: 0.2, outputUsdPerMTok: 10 });
    const listed = [{ id: "gpt-5.6-sol", label: "GPT-5.6-Sol", thinkingOptions: [], defaultThinkingOptionId: null, cost: { inputUsdPerMTok: 1.25, cacheReadUsdPerMTok: 0.125, outputUsdPerMTok: 10 } }];
    const cost = candidateCost(incident().candidate, listed);
    expect(view(found(), cost).buttons[0]!.label).toBe("Switch to bm-worker-fallback-1 · Codex · gpt-5.6-sol · ~$1.25 / $10 per 1M tokens");
    expect(candidateCost(incident().candidate, [])).toBeNull();
    expect(candidateCost(null, listed)).toBeNull();
    // Paseo is asked only for a pending candidate the table has no price for.
    expect(listedCostProvider(found())).toBe("codex");
    expect(listedCostProvider(found({ candidate: sonnet }))).toBeNull();
    expect(listedCostProvider(found({ status: "switched" }))).toBeNull();
    expect(listedCostProvider(found({ candidate: null }))).toBeNull();
    expect(listedCostProvider({ state: "loading" })).toBeNull();
  });

  it("shows no button, only one status line, once the incident is not pending", () => {
    const lines = Object.fromEntries(
      (
        [
          ["switched", { replacementId: "3d2c1b0a-9f8e-4d7c-b6a5-0123456789ab" }],
          ["waiting", { waitUntil: at(15, 41) }],
          ["resumed", {}],
          ["dismissed", {}],
          ["exhausted", {}],
          ["expired", {}],
          ["failed", { error: "E_FALLBACK_CREATE_FAILED: Paseo refused the new agent" }],
        ] as const
      ).map(([status, extra]) => {
        const shown = view(found({ status, ...extra }));
        expect(shown.buttons, status).toEqual([]);
        expect(shown.chip?.text, status).toBe(status);
        return [status, shown.statusLine?.text];
      }),
    );
    expect(lines).toEqual({
      switched: "Switched to bm-worker-fallback-1 · Codex · gpt-5.6-sol (agent 3d2c1b0a).",
      waiting: "Waiting until 15:41; then the Worker carries on.",
      resumed: "Resumed: the limit reset and the Worker was asked to carry on.",
      dismissed: "Dismissed: you handle it.",
      exhausted: "No fallback left to switch to.",
      expired: "Expired: by the reset the Worker was archived, running or already replaced.",
      failed: "Failed: E_FALLBACK_CREATE_FAILED: Paseo refused the new agent",
    });
  });

  it("offers nothing while the incident is unknown, unreadable or no longer recorded", () => {
    const loading = view({ state: "loading" });
    expect(loading).toMatchObject({ buttons: [], chip: null, statusLine: { text: "Checking the incident…", tone: "muted" } });
    // Until the incident is read, the notice's own words describe it.
    expect(loading.summary).toBe("Usage limit (L1) · bm-worker (claude) · claude-opus-5");
    const failed = view({ state: "failed", error: new DashboardError("E_FALLBACK_NOT_FOUND", "paseo-bm cannot find its install home") });
    expect(failed).toMatchObject({ buttons: [], statusLine: { text: "Could not read the incident (E_FALLBACK_NOT_FOUND): paseo-bm cannot find its install home", tone: "danger" } });
    expect(view({ state: "failed", error: new Error("daemon unreachable") }).statusLine?.text).toBe("Could not read the incident: daemon unreachable");
    expect(view(lookupOf("fb-3f9a2c1d7e4b", [incident({ id: "fb-000000000002" })]))).toMatchObject({ buttons: [], chip: null });
    expect(lookupOf("fb-3f9a2c1d7e4b", [incident()])).toEqual(found());
  });

  it("builds the same card for a waiting pill, from the incident alone", () => {
    const card = fallbackCardOfIncident(incident());
    expect(chatCardSchema.parse(card)).toMatchObject({ type: "fallback", requestId: "req-20260921T111242Z", fallback: { incident: "fb-3f9a2c1d7e4b", role: "worker" } });
    expect(fallbackCardView(card, found(), NOW, null).buttons.map((button) => button.action)).toEqual(["switch", "wait", "dismiss"]);
    expect(fallbackCardView(card, { state: "loading" }, NOW, null).summary).toBe("Usage limit (L1) · bm-worker · claude-opus-5");
  });

  it("presses a button with ONE fallback.act call, and shows a failure with its code", async () => {
    const decided = incident({ status: "dismissed", decidedAt: "2026-09-21T14:05:00.000Z" });
    const act = vi.fn(async () => ({ incident: decided }));
    expect(await runFallbackAction({ incidentId: "fb-3f9a2c1d7e4b", action: "dismiss", act })).toEqual({ ok: true, incident: decided });
    expect(act).toHaveBeenCalledTimes(1);
    expect(act).toHaveBeenCalledWith({ incidentId: "fb-3f9a2c1d7e4b", action: "dismiss" });

    const refused = vi.fn(async () => {
      throw new DashboardError("E_FALLBACK_NO_CANDIDATE", "bm-worker-fallback-1 is not available");
    });
    expect(await runFallbackAction({ incidentId: "fb-3f9a2c1d7e4b", action: "switch", act: refused })).toEqual({
      ok: false,
      reason: "Could not switch to the fallback (E_FALLBACK_NO_CANDIDATE): bm-worker-fallback-1 is not available",
    });
    expect(refused).toHaveBeenCalledTimes(1);
    expect(fallbackActError("wait", new DashboardError("E_FALLBACK_NO_RESET", "no reset time"))).toBe("Could not wait for the reset (E_FALLBACK_NO_RESET): no reset time");
    expect(fallbackActError("dismiss", new Error("socket closed"))).toBe("Could not record that you handle it: socket closed");
  });

  it("reads a time in the device's zone: today, tomorrow, yesterday, or the date", () => {
    expect(localTimeText(new Date(2026, 8, 21, 9, 5), NOW)).toBe("09:05");
    expect(localTimeText(new Date(2026, 8, 22, 0, 0), NOW)).toBe("tomorrow 00:00");
    expect(localTimeText(new Date(2026, 8, 20, 23, 59), NOW)).toBe("yesterday 23:59");
    expect(localTimeText(new Date(2026, 9, 1, 18, 30), NOW)).toBe("Thu 1 Oct 18:30");
  });
});
