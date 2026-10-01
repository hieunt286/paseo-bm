import { describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { allNodes, pressables, renderTree, texts, type RNode } from "./helpers/element-tree";
import { appendRecord, clearTraceStoreCache } from "../plugin/server/trace-store";
import {
  CHAT_CARD_VERSION,
  MAX_BODY_LINES,
  chatCardSchema,
  decisionCardOf,
  fallbackDecisionSeed,
  toChatCards,
  type ChatCard,
} from "../plugin/client/chat-card-parse";
import { drawAsCard, markOf, ownerWarning, partiesOf, actorName } from "../plugin/client/chat-card-parties";
import { cardFrameOf, detailLinesOf, noticeLine, verificationOfRequest, type CardFrameView } from "../plugin/client/chat-card-frame";
import { localTimeText } from "../plugin/client/format";
import {
  DECISION_LOOKUP_WINDOW_MS,
  DECISION_POLL_MS,
  DECISION_UI_IDLE,
  OWN_WORDS,
  choiceNeedsConfirmation,
  decisionCardView,
  decisionLookupOf,
  decisionPollMs,
  runDecisionAnswer,
  runDecisionConfirm,
  type DecisionLookup,
  type DecisionUi,
} from "../plugin/client/chat-card-decision";
import { fallbackMarkdown, markdownOf } from "../plugin/client/chat-card-markdown";
import { parseMarkdown } from "../plugin/client/markdown";
import { handleChatPeers } from "../plugin/server/chat-rpc";
import { fallbackNotice } from "../plugin/server/fallback-rpc";
import { answerNoticeOf } from "../plugin/server/orchestrator-decisions";
import { stateBriefOf } from "../plugin/server/compaction";
import type { DashboardPaseo } from "../plugin/server/paseo-directory";
import { DashboardError, TRACE_STORE_SCHEMA_VERSION, type ChatPeer, type FallbackIncident, type TraceVerification } from "../plugin/shared/contracts";
import { answerDecision, confirmDecision, expireDecision, markNeedsConfirmation, supersedeDecision, withdrawDecision, type Decision } from "../plugin/shared/decisions";
import { storedOrchestratorAnswer } from "./helpers/decisions";
import { soleWorkerOf } from "../plugin/shared/sole-worker";
// Save as precedent on the decision card (autonomy design §B.6).
import { PRECEDENT_UI_IDLE, SAVE_AS_PRECEDENT_LABEL, precedentFormOf, precedentOfferView, runPrecedentSave, type PrecedentUi } from "../plugin/client/chat-card-precedent";
import { USE_PRECEDENT_LABEL, precedentSuggestionView } from "../plugin/client/chat-card-precedent";
import type { Precedent } from "../plugin/shared/precedents";
import { fakePaseo } from "./helpers/fake-paseo";

/**
 * Chat cards v2 (autonomy design §A.12, experience concept §5): one frame
 * for every card, decisions live from the store, and no reply box or other
 * question UI anywhere. The hook-free pieces (`CardFrame`, `CompactLine`,
 * `DecisionCardBody`) are expanded with the element-tree helper;
 * `react-native` and the SDK's icon are named stand-ins.
 */

// The root tsconfig has no `jsx`, so the .tsx modules load through non-literal specifiers.
const uiPath = "../plugin/client/ui.tsx";
const cardPath = "../plugin/client/chat-card.tsx";
const { CardFrame, CompactLine } = (await import(uiPath)) as {
  CardFrame: (props: Record<string, unknown>) => unknown;
  CompactLine: (props: Record<string, unknown>) => unknown;
};
const { DecisionCardBody } = (await import(cardPath)) as { DecisionCardBody: (props: Record<string, unknown>) => unknown };

const styles = new Proxy({}, { get: (_target, key) => ({ name: String(key) }) });
const theme = { colors: new Proxy({}, { get: (_target, key) => `#${String(key)}` }) };

const REQ = "req-20260916T062244Z";
const REPORT = [
  "BM-REPORT",
  `requestId: ${REQ}`,
  "phase: beads-done",
  "tier: Large (changed: no)",
  "filesChanged: docs/design/a.md",
  "beadsCreated: cus-a, cus-b",
  "beadsUpdated: none",
  "beadsClosed: cus-a",
  "beadsReady: none",
  "reviewFindingsOpen: none",
  "buildAndTests: not run",
  "skillsUsed: feature-workflow",
  "blockers: waiting for the staging database to come back",
].join("\n");
const QUESTIONS = [
  "BM-QUESTIONS",
  `requestId: ${REQ}`,
  "Q6: Storage — where does the list live?",
  "- a: the existing table: no migration. (recommended)",
  "- b: a file on disk: simplest. [effects: push]",
  "Q7: Sessions — rename the cookie?",
  "- a: keep it. (recommended)",
  "- b: rename it.",
].join("\n");
const ASKING = `${REPORT.replace("phase: beads-done", "phase: blocked").replace("blockers: waiting for the staging database to come back", "blockers: 2 questions: Q6, Q7 — see BM-QUESTIONS")}\n\n${QUESTIONS}`;
const FINISHED = `Contact form redesigned and tested.\n\n${REPORT.replace("phase: beads-done", "phase: finished")
  .replace("blockers: waiting for the staging database to come back", "blockers: none")
  .replace("buildAndTests: not run", "buildAndTests: npm test — 212 passed")}`;
const REVIEW = ["Checked the batch.", "", "---", "", "BM-REVIEW", "requestId: req-20260916T081749Z", "batchId: b1", "reviewKind: first", "verdict: pass", "checked: docs/x.md", "findings: none", "notChecked: none"].join("\n");
const INSTRUCTION = `CONTINUE — \`${REQ}\`\n\n## Decision: apply the 5-line fix to R3\n\nGo ahead.\nThen report.\nAnd stop.`;
const REVIEW_REQUEST = "You are the Reviewer (read only). requestId: req-20260916T081749Z. batchId: b1 (documents).\n\nRepo: /repo";

const cards = (text: string, type: "user_message" | "assistant_message" = "user_message", clientMessageId?: string) =>
  toChatCards({ type, text, ...(clientMessageId === undefined ? {} : { clientMessageId }) }, "complete");
const card = (text: string, type: "user_message" | "assistant_message" = "user_message") => cards(text, type)![0]!;

const peer = (overrides: Partial<ChatPeer>): ChatPeer => ({
  id: "x",
  role: "worker",
  title: null,
  status: "idle",
  parentId: null,
  requestId: null,
  batchId: null,
  labelled: true,
  archived: false,
  replaced: false,
  ...overrides,
});
const manager = peer({ id: "m1", role: "manager", title: "Beads Manager" });
const worker = peer({ id: "w1", title: "Contact redesign", parentId: "m1", requestId: REQ });
const otherWorker = peer({ id: "w2", title: "PAKD fix", parentId: "m1", requestId: "req-20260916T081749Z" });
const reviewer = peer({ id: "r1", role: "reviewer", parentId: "w2", requestId: "req-20260916T081749Z", batchId: "b1" });

const AT = new Date("2026-09-16T10:00:00Z");
const NOW = new Date("2026-09-16T10:12:00Z");
const frameOf = (c: ChatCard, owner: ChatPeer | null = manager, peers: ChatPeer[] = [worker, otherWorker, reviewer]) => cardFrameOf(c, { owner, peers, at: AT, now: NOW });

describe("which chat items become which cards", () => {
  it("turns a report that asks questions into one decision card per question", () => {
    const asked = cards(ASKING)!;
    expect(asked.map((c) => [c.type, c.decision?.id])).toEqual([
      ["decision", `q:${REQ}:Q6`],
      ["decision", `q:${REQ}:Q7`],
    ]);
    expect(asked[0]).toMatchObject({
      direction: "received",
      requestId: REQ,
      decision: {
        asker: "worker",
        questionId: "Q6",
        question: "Storage — where does the list live?",
        options: [
          { key: "a", label: "the existing table: no migration.", recommended: true },
          { key: "b", label: "a file on disk: simplest.", recommended: false },
        ],
      },
    });
    // The whole message stays with each card, for Details.
    expect(asked[1]!.text).toBe(ASKING);
  });

  it("turns a report into a progress or finished card, and a finished one that asks into both", () => {
    expect(card(REPORT)).toMatchObject({ type: "progress", formatIssues: [], report: { phase: "beads-done", tier: "Large", beads: { created: 2, updated: 0, closed: 1 }, filesChanged: 1 } });
    expect(card(REPORT.replace("phase: beads-done", "phase: received")).type).toBe("progress");
    // A blocked report that asks nothing is progress too.
    expect(card(REPORT.replace("phase: beads-done", "phase: blocked")).type).toBe("progress");
    expect(card(FINISHED)).toMatchObject({ type: "finished", gist: "Contact form redesigned and tested.", report: { checks: "npm test — 212 passed" } });
    expect(cards(`${FINISHED}\n\n${QUESTIONS}`)!.map((c) => c.type)).toEqual(["finished", "decision", "decision"]);
    // A questions block about another request asks nothing here.
    expect(cards(`${REPORT}\n\n${QUESTIONS.replace(`requestId: ${REQ}`, "requestId: req-20260101T000000Z")}`)!.map((c) => c.type)).toEqual(["progress"]);
  });

  it("turns a review into a verdict card, and a request brief or review request into a brief", () => {
    expect(card(REVIEW, "assistant_message")).toMatchObject({ type: "verdict", direction: "sent", review: { verdict: "pass", batchId: "b1", blocking: 0 }, formatIssues: [] });
    expect(card(INSTRUCTION)).toMatchObject({ type: "brief", requestId: REQ, gist: `CONTINUE — ${REQ}` });
    expect(card(REVIEW_REQUEST)).toMatchObject({ type: "brief", requestId: "req-20260916T081749Z" });
  });

  it("reads a message that explains the block formats as a brief, not a report or a verdict", () => {
    const request = `${REVIEW_REQUEST}\n\nAnswer with:\n\nBM-REVIEW\nrequestId: req-20260916T081749Z\nbatchId: b1\nverdict: approved | changes-required\n`;
    expect(card(request)).toMatchObject({ type: "brief", review: null });
    const reportFormat = `Report with:\n\nBM-REPORT\nrequestId: <requestId>\nphase: received | documents-done | finished\n\nfor \`${REQ}\``;
    expect(card(reportFormat)).toMatchObject({ type: "brief", report: null });
    expect(cards(reportFormat, "assistant_message")).toBeUndefined();
  });

  it("leaves everything else to Paseo — the owner's typed words above all", () => {
    expect(cards(INSTRUCTION, "user_message", "c1")).toBeUndefined();
    expect(cards(ASKING, "user_message", "c1")).toBeUndefined();
    // What an old card's Reply box sent is the owner's own message now.
    expect(cards(`Reply from the user about \`${REQ}\`:\n\nBM-ANSWERS\nrequestId: ${REQ}\nQ1: a — keep`, "user_message", "c1")).toBeUndefined();
    expect(cards("please summarise the file")).toBeUndefined();
    expect(cards(`Worker started on ${REQ}.`, "assistant_message")).toBeUndefined();
    expect(toChatCards({ type: "assistant_message", text: REVIEW }, "streaming")).toBeUndefined();
    expect(toChatCards({ type: "tool_call", text: REPORT }, "complete")).toBeUndefined();
    expect(cards("  ")).toBeUndefined();
    expect(toChatCards({ type: "user_message" }, "complete")).toBeUndefined();
  });

  it("keeps every card JSON and valid for the version 2 renderer", () => {
    expect(CHAT_CARD_VERSION).toBe(2);
    for (const c of [...cards(ASKING)!, card(REPORT), card(FINISHED), card(REVIEW, "assistant_message"), card(INSTRUCTION)]) {
      expect(chatCardSchema.parse(c)).toEqual(c);
      expect(JSON.parse(JSON.stringify(c))).toEqual(c);
    }
  });
});

describe("the plugin's own notices", () => {
  const notice = (text: string) => cards(text, "user_message", "sdk-message-id")!;
  const FORMAT = [
    `BM-FORMAT requestId: ${REQ}`,
    "Your last BM-REPORT broke the template:",
    '- BM-REPORT tier: must be "Small|Medium|Large (changed: no)"',
  ].join("\n");

  it("are one compact line each, though Paseo stores a clientMessageId on them", () => {
    const [format] = notice(FORMAT);
    expect(format).toMatchObject({ type: "notice", requestId: REQ, notice: { marker: "BM-FORMAT", what: "A block broke its template", tone: "warning" } });
    expect(chatCardSchema.parse(format)).toEqual(format);
    expect(noticeLine(format!, AT, NOW)).toBe("A block broke its template — Your last BM-REPORT broke the template: · 12 min ago");
    expect(notice("STOP: The Beads Worker that created you was stopped by the user.")[0]).toMatchObject({ type: "notice", notice: { marker: "STOP", what: "Asked to stop" } });
    // A message that only quotes a notice is not one.
    expect(cards(`The plugin said:\n\n${FORMAT}`, "user_message", "c1")).toBeUndefined();
  });

  it("make the owner's answer to a decision (BM-ANSWER) that decision's card", () => {
    const answered = ok(answerDecision(orchestratorDecision(), { via: "inbox", optionKey: "go", at: "2026-09-16T10:05:00.000Z" }));
    const [c] = notice(answerNoticeOf(answered));
    expect(c).toMatchObject({ type: "decision", requestId: REQ, decision: { id: O_ID, asker: "orchestrator", question: "Push the checkout fix now?" } });
    expect(chatCardSchema.parse(c)).toEqual(c);
    // Without a readable decision id it is only a notice line.
    expect(notice("BM-ANSWER\ndecisionId: nonsense")[0]).toMatchObject({ type: "notice", notice: { marker: "BM-ANSWER" } });
  });

  it("make a fallback incident (BM-FALLBACK) its decision f:<incidentId>, never the old fallback card", () => {
    const [c] = notice(fallbackNotice(incident(), () => "claude", "Create the replacement Reviewer."));
    expect(c).toMatchObject({
      type: "decision",
      requestId: "req-20260921T111242Z",
      decision: { id: "f:fb-3f9a2c1d7e4b", asker: "plugin", question: "The Worker was stopped by its provider plan", options: [] },
    });
    expect(chatCardSchema.parse(c)).toEqual(c);
    expect(fallbackDecisionSeed("fb 1", "worker")).toBeNull();
    // One that names no usable incident still is the plugin's: a notice line.
    expect(notice(fallbackNotice(incident(), () => "claude", "Create the replacement Reviewer.").replace("fb-3f9a2c1d7e4b", "fb-nope"))[0]).toMatchObject({ type: "notice", notice: { marker: "BM-FALLBACK" } });
  });

  it("title the state brief after a compaction (BM-STATE, autonomy design §G.5) instead of showing its marker", () => {
    const home = mkdtempSync(join(tmpdir(), "bm-state-card-"));
    try {
      const brief = stateBriefOf(
        {
          id: "cmp-1",
          workspaceId: "wks_1",
          requestId: REQ,
          agentId: "wrk-1",
          role: "worker",
          provider: "claude",
          interventionId: null,
          reason: "Over the threshold.",
          state: "compacting",
          requestedAt: "2026-09-16T09:50:00.000Z",
          sentAt: "2026-09-16T09:55:00.000Z",
          compactedAt: "2026-09-16T09:56:00.000Z",
          briefAt: null,
          endedAt: null,
          ending: null,
        },
        home,
        {},
      );
      const [c] = notice(brief);
      expect(c).toMatchObject({ type: "notice", notice: { marker: "BM-STATE", what: "State restored after compaction", tone: "muted" } });
      expect(chatCardSchema.parse(c)).toEqual(c);
      expect(noticeLine(c!, AT, NOW)).toMatch(/^State restored after compaction — From the paseo-bm plugin, not the owner/);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("who sent it and who gets it", () => {
  it("in the Manager's chat, a report and its questions come from the Worker of that request", () => {
    const { from, to } = partiesOf(card(REPORT), manager, [worker, otherWorker, reviewer]);
    expect(from).toEqual({ role: "worker", id: "w1", title: "Contact redesign" });
    expect(to.id).toBe("m1");
    expect(actorName(from)).toBe("Worker · Contact redesign");
    expect(partiesOf(cards(ASKING)![0]!, manager, [worker]).from.id).toBe("w1");
  });

  it("in a Worker's chat, a brief comes from its Manager; in a Reviewer's, from its parent Worker", () => {
    expect(partiesOf(card(INSTRUCTION), worker, [manager, otherWorker]).from.id).toBe("m1");
    expect(partiesOf(card(REVIEW_REQUEST), reviewer, [manager, worker, otherWorker]).from.id).toBe("w2");
    const sent = partiesOf(card(REVIEW, "assistant_message"), reviewer, [manager, worker, otherWorker]);
    expect(sent.from).toMatchObject({ role: "reviewer", id: "r1" });
    expect(sent.to.id).toBe("w2");
  });

  it("names a role, never an id, when no single agent fits", () => {
    const twins = [worker, peer({ id: "w3", requestId: REQ })];
    const { from } = partiesOf(card(REPORT), manager, twins);
    expect(from).toEqual({ role: "worker", id: null, title: null });
    expect(actorName(from)).toBe("Worker");
    expect(actorName({ role: "worker", id: "w3aaaaaaaaaa", title: null })).toBe("Worker");
  });

  it("draws a card only in a paseo-bm chat, and a sent block only for the role that writes it", () => {
    expect(drawAsCard(card(REPORT), manager)).toBe(true);
    expect(drawAsCard(card(REPORT), null)).toBe(false);
    expect(drawAsCard(card(REVIEW, "assistant_message"), reviewer)).toBe(true);
    expect(drawAsCard(card(REVIEW, "assistant_message"), manager)).toBe(false);
    expect(drawAsCard(card(REPORT, "assistant_message"), worker)).toBe(true);
    expect(drawAsCard(cards(ASKING, "assistant_message")![0]!, worker)).toBe(true);
    expect(drawAsCard(cards(ASKING, "assistant_message")![0]!, manager)).toBe(false);
  });

  it("maps roles to the graph icons", () => {
    expect([markOf("manager"), markOf("worker"), markOf("reviewer"), markOf("orchestrator"), markOf(null)]).toEqual(["request", "worker", "reviewer", "orchestrator", null]);
  });
});

describe("the one frame: actor → recipient · authority · time, one chip, ≤ 3 body lines, ids only in Details", () => {
  const faceOf = (view: CardFrameView) => [view.actor.name, view.recipient, view.authority, view.time, view.chip?.text, view.title, view.tag, ...view.body].join("\n");

  it("progress: the stage as the chip and title, beads and what it waits on", () => {
    const view = frameOf(card(REPORT));
    expect(view).toMatchObject({
      actor: { mark: "worker", name: "Worker · Contact redesign" },
      recipient: "Manager · Beads Manager",
      authority: null,
      chip: { text: "Working", tone: "info" },
      title: "Beads planned",
      tag: "Large",
      body: ["Beads: 2 created, 1 closed", "Waiting on: waiting for the staging database to come back"],
      outline: null,
    });
    expect(frameOf(card(REPORT.replace("phase: beads-done", "phase: received")))).toMatchObject({ chip: { text: "Received", tone: "info" }, title: "Request received" });
    expect(frameOf(card(REPORT.replace("phase: beads-done", "phase: blocked")))).toMatchObject({ chip: { text: "Blocked", tone: "warning" }, title: "Blocked" });
  });

  it("cuts a long waiting-on text: the whole text is in Details", () => {
    const long = "the result of the real-daemon check, which everything left waits on. ".repeat(12);
    const waiting = frameOf(card(REPORT.replace("blockers: waiting for the staging database to come back", `blockers: ${long}`))).body.at(-1)!;
    expect(waiting.length).toBeLessThanOrEqual("Waiting on: ".length + 160);
    expect(waiting.endsWith("…")).toBe(true);
  });

  it("finished: what changed, the checks and what it decided alone, in a success outline", () => {
    const view = frameOf(card(FINISHED));
    expect(view).toMatchObject({
      chip: { text: "Finished", tone: "success" },
      title: "Contact form redesigned and tested.",
      outline: "success",
      body: ["1 file changed · 1 bead closed", "Checks: npm test — 212 passed"],
    });
    const decided = card(FINISHED.replace("skillsUsed: feature-workflow", "skillsUsed: feature-workflow\ndecided: kept the old label; used the table"));
    expect(frameOf(decided).body.at(-1)).toMatch(/^Decided on its own: \d+ \(see Details\)$/);
  });

  it("verdict: Passed or Changes required, and the blocking count", () => {
    const view = frameOf(card(REVIEW, "assistant_message"), reviewer, [manager, worker, otherWorker]);
    expect(view).toMatchObject({ actor: { mark: "reviewer" }, recipient: "Worker · PAKD fix", chip: { text: "Passed", tone: "success" }, title: "Checked the batch.", body: ["No blocking findings"] });
    expect(frameOf(card(REVIEW.replace("verdict: pass", "verdict: changes-required"), "assistant_message"), reviewer).chip).toEqual({ text: "Changes required", tone: "warning" });
  });

  it("brief: the request quoted, a few lines of it", () => {
    const view = frameOf(card(INSTRUCTION), worker, [manager]);
    expect(view).toMatchObject({ actor: { mark: "request", name: "Manager · Beads Manager" }, chip: null, title: `CONTINUE — ${REQ}` });
    expect(view.body).toEqual(["Decision: apply the 5-line fix to R3", "Go ahead.", "Then report."]);
  });

  it("never shows more than three body lines, and no id of its own on the card's face", () => {
    for (const c of [card(REPORT), card(FINISHED), card(REVIEW, "assistant_message")]) {
      const view = frameOf(c, c.direction === "sent" ? reviewer : manager);
      expect(view.body.length).toBeLessThanOrEqual(MAX_BODY_LINES);
      expect(faceOf(view)).not.toMatch(/req-\d{8}T\d{6}Z/);
    }
    expect(faceOf(frameOf(card(REVIEW, "assistant_message"), reviewer))).not.toContain("b1");
    // A brief quotes the request as written, ids and all; it too keeps to three lines.
    expect(frameOf(card(INSTRUCTION), worker).body).toHaveLength(MAX_BODY_LINES);
    expect(detailLinesOf(card(REVIEW, "assistant_message"), reviewer)).toEqual(["Request: req-20260916T081749Z", "Batch: b1", "Verdict: pass"]);
    expect(detailLinesOf(card(REPORT), manager)).toEqual([`Request: ${REQ}`, "Phase: beads-done"]);
  });

  it("says a template problem on the card and lists it in Details", () => {
    const broken = cards(ASKING.replace("- a: the existing table: no migration. (recommended)", "- a: the existing table: no migration."))!;
    expect(broken[0]!.formatIssues).toEqual(["BM-QUESTIONS Q6: needs exactly one option ending in (recommended) (found 0)"]);
    const approved = card(REVIEW.replace("verdict: pass", "verdict: approved"), "assistant_message");
    expect(approved.formatIssues).toEqual(["BM-REVIEW verdict: must be pass or changes-required"]);
    expect(frameOf(approved, reviewer).body.at(-1)).toBe("This message breaks its template: see Details.");
    expect(detailLinesOf(approved, reviewer)).toEqual(expect.arrayContaining(["This message breaks the template:", "• BM-REVIEW verdict: must be pass or changes-required"]));
    // Only another agent's block is checked, or a Reviewer's own review: not a Worker quoting its report.
    expect(cards(ASKING.replace("(recommended)", ""), "assistant_message")![0]!.formatIssues).toEqual([]);
  });

  it("names an agent started outside Beads Manager in Details only", () => {
    const unlabelled = { ...manager, labelled: false };
    expect(ownerWarning(unlabelled)).toBe("This agent has no bm.role label: it was started outside Beads Manager, and paseo-bm recognised it by its provider.");
    expect(ownerWarning(manager)).toBeNull();
    expect(ownerWarning(null)).toBeNull();
    expect(detailLinesOf(card(REPORT), unlabelled)[0]).toBe(ownerWarning(unlabelled));
  });
});

// ---------------------------------------------------------------------------
// The decision card.
// ---------------------------------------------------------------------------

const Q_ID = `q:${REQ}:Q6`;
const O_ID = "o:3f1c2b9a-0d4e-4c55-9f00-1234567890ab";

function questionDecision(overrides: Partial<Decision> = {}): Decision {
  return {
    id: Q_ID,
    workspaceId: "wks_a",
    requestId: REQ,
    askedBy: { role: "worker", agentId: "w1" },
    askedAt: "2026-09-16T10:00:00.000Z",
    round: 1,
    question: "Storage — where does the list live?",
    subject: "storage",
    options: [
      { key: "a", label: "the existing table: no migration.", recommended: true, effects: ["none"] },
      { key: "b", label: "a file on disk: simplest.", recommended: false, effects: ["push"] },
    ],
    status: "open",
    settledAt: null,
    needsConfirmation: null,
    answer: null,
    grant: null,
    delivery: null,
    supersedes: null,
    supersededBy: null,
    ...overrides,
  };
}

function orchestratorDecision(): Decision {
  return questionDecision({
    id: O_ID,
    askedBy: { role: "orchestrator", agentId: null },
    round: null,
    question: "Push the checkout fix now?",
    subject: null,
    options: [
      { key: "go", label: "Push it", recommended: true, effects: ["push"] },
      { key: "hold", label: "Hold", recommended: false, effects: [] },
    ],
  });
}

function ok(result: ReturnType<typeof answerDecision>): Decision {
  if (!result.ok) throw new Error(result.message);
  return result.decision;
}

function incident(overrides: Partial<FallbackIncident> = {}): FallbackIncident {
  return {
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
    resetsAt: null,
    candidate: null,
    status: "pending",
    detectedAt: "2026-09-21T14:00:00.000Z",
    decidedAt: null,
    waitUntil: null,
    replacementId: null,
    error: null,
    ...overrides,
  };
}

const QCARD = cards(ASKING)![0]!;
const agents = [manager, worker];
const view = (lookup: DecisionLookup, ui: DecisionUi = DECISION_UI_IDLE, c: ChatCard = QCARD) => decisionCardView({ card: c, lookup, agents, ui, cardAt: AT, now: NOW });
const found = (decision: Decision): DecisionLookup => ({ state: "found", decision });

describe("the decision card's view (experience concept §5.2)", () => {
  it("offers the options while open: the recommended one is the primary action, a release asks for confirmation", () => {
    const shown = view(found(questionDecision()));
    expect(shown.frame).toMatchObject({
      actor: { mark: "worker", name: "Worker · Contact redesign" },
      recipient: "you",
      authority: null,
      time: "asked 12 min ago",
      chip: { text: "Needs decision", tone: "warning" },
      title: "Storage — where does the list live?",
      tag: "effects: push",
      body: [],
    });
    expect(shown.options).toEqual([
      { key: "a", label: "the existing table: no migration. ★", primary: true, confirm: false, accessibilityLabel: "Answer: the existing table: no migration. (recommended)" },
      { key: "b", label: "a file on disk: simplest.", primary: false, confirm: true, accessibilityLabel: "Answer: a file on disk: simplest.; allows push" },
    ]);
    expect(shown).toMatchObject({ ownWords: true, confirmChat: false, confirm: null });
    // Ids, effects per option and the subject are in Details.
    expect(shown.details).toEqual(expect.arrayContaining([`Decision: ${Q_ID}`, `Request: ${REQ}`, "Subject: storage", "b: a file on disk: simplest. — effects: push"]));
    // The class too (autonomy design §B.1): stored, or read by the effects for one stored before classes.
    expect(shown.details).toContain("Class: release");
    expect(view(found(questionDecision({ class: "security" }))).details).toContain("Class: security");
    expect(JSON.stringify(shown.frame)).not.toContain(Q_ID);
  });

  it("asks for the confirmation in place, Cancel first and the default, before a release, data, security or cost answer", () => {
    const decision = questionDecision();
    expect(choiceNeedsConfirmation(decision, { optionKey: "a" })).toBe(false);
    expect(choiceNeedsConfirmation(decision, { optionKey: "b" })).toBe(true);
    // Own words grant everything the decision declares.
    expect(choiceNeedsConfirmation(decision, { words: "use a file" })).toBe(true);
    expect(choiceNeedsConfirmation(questionDecision({ options: [{ key: "a", label: "x", recommended: true, effects: ["commit"] }] }), { words: "x" })).toBe(false);
    const confirming = view(found(decision), { ...DECISION_UI_IDLE, confirming: "b" });
    expect(confirming.confirm).toEqual({
      title: "Answer: a file on disk: simplest.?",
      body: "This answer allows push once, within the hour. Nothing is sent until you confirm.",
      confirmLabel: "Confirm and send",
      cancelLabel: "Cancel",
      defaultAction: "cancel",
    });
    expect(confirming.options).toEqual([]);
    expect(view(found(decision), { ...DECISION_UI_IDLE, words: "file", confirming: OWN_WORDS }).confirm?.title).toBe("Send your own words?");
    // The own-words box replaces the option buttons while it is open.
    expect(view(found(decision), { ...DECISION_UI_IDLE, words: "" }).options).toEqual([]);
  });

  it("shows an answer everywhere: who answered where and when, what, where it went, the grant", () => {
    const answered = ok(answerDecision(questionDecision(), { via: "inbox", optionKey: "b", at: "2026-09-16T10:02:00.000Z" }));
    const delivered = { ...answered, delivery: { to: "w1", kind: `answers:${REQ}`, at: "2026-09-16T10:02:01.000Z", outcome: "sent" as const } };
    const shown = view(found(delivered));
    expect(shown.frame).toMatchObject({
      chip: { text: "Decided", tone: "success" },
      authority: `answered by you in the Inbox · ${localTimeText(new Date("2026-09-16T10:02:00.000Z"), NOW)}`,
      tag: "grant: push 1×",
      body: ["✓ a file on disk: simplest.", "Sent to Worker · Contact redesign."],
    });
    expect(shown).toMatchObject({ options: [], ownWords: false, confirmChat: false, confirm: null });
    // Own words, a queued or failed delivery, a used grant.
    const words = ok(answerDecision(questionDecision(), { via: "chat-card", words: "Use a file, but not yet.", at: "2026-09-16T10:03:00.000Z" }));
    expect(view(found({ ...words, delivery: { to: "zz", kind: "k", at: "t", outcome: "queued" } })).frame.body).toEqual([
      "Your words: Use a file, but not yet.",
      "Queued for the agent: it goes when the agent is idle.",
    ]);
    expect(view(found({ ...words, delivery: { to: "w1", kind: "k", at: "t", outcome: "failed" } })).frame.body.at(-1)).toBe("Could not deliver to Worker · Contact redesign.");
    expect(view(found({ ...words, grant: { ...words.grant!, usedAt: "2026-09-16T10:05:00.000Z" } })).frame.tag).toBe("grant used");
    expect(view(found(ok(answerDecision(questionDecision(), { via: "chat-card", optionKey: "a", at: "2026-09-16T10:03:00.000Z" })))).frame.tag).toBeNull();
  });

  it("shows the Orchestrator's answer (bm_decide, change-004) as the Orchestrator's, its reason in Details, and no answer buttons", () => {
    const decided = ok(
      storedOrchestratorAnswer(questionDecision(), { optionKey: "a", reason: "No migration: the table already holds the list.", at: "2026-09-16T10:02:00.000Z" }),
    );
    const delivered = { ...decided, delivery: { to: "w1", kind: `answers:${REQ}`, at: "2026-09-16T10:02:01.000Z", outcome: "queued" as const } };
    const shown = view(found(delivered));
    expect(shown.frame).toMatchObject({
      chip: { text: "Decided", tone: "success" },
      authority: `answered by the Orchestrator · ${localTimeText(new Date("2026-09-16T10:02:00.000Z"), NOW)}`,
      body: ["✓ the existing table: no migration.", "Queued for Worker · Contact redesign: it goes when the agent is idle."],
    });
    // Settled: nothing to press but Details, and nothing read again.
    expect(shown).toMatchObject({ options: [], ownWords: false, confirmChat: false, confirm: null });
    expect(decisionPollMs(found(delivered), AT, NOW)).toBe(false);
    // The reason is in Details, never on the card's face; the owner is not named as the one who answered.
    expect(shown.details).toEqual(expect.arrayContaining(["Answered by: the Orchestrator", "Answer via: autopilot", "Reason: No migration: the table already holds the list."]));
    expect(JSON.stringify(shown.frame)).not.toContain("No migration: the table");
    expect(JSON.stringify(shown.frame)).not.toContain("answered by you");
  });

  it("shows the policy's answer (autonomy design §B.5) as Decided, decided for you by the policy, never as yours, with nothing to press but Details", () => {
    const scope = questionDecision({ class: "scope", options: [{ key: "a", label: "the existing table: no migration.", recommended: true, effects: ["commit"] }] });
    const decided = ok(
      answerDecision(scope, {
        by: "policy",
        via: "inbox",
        optionKey: "a",
        class: "scope",
        predictor: "recommended",
        reason: "The recommended option: scope is delegated to it in this project",
        at: "2026-09-16T10:02:00.000Z",
      }),
    );
    const delivered = { ...decided, delivery: { to: "w1", kind: `answers:${REQ}`, at: "2026-09-16T10:02:01.000Z", outcome: "sent" as const } };
    const shown = view(found(delivered));
    expect(shown.frame).toMatchObject({
      chip: { text: "Decided", tone: "success" },
      authority: `decided for you by the policy · recommended option · ${localTimeText(new Date("2026-09-16T10:02:00.000Z"), NOW)}`,
      tag: "grant: commit 1×",
      body: ["✓ the existing table: no migration.", "Sent to Worker · Contact redesign."],
    });
    expect(shown).toMatchObject({ options: [], ownWords: false, confirmChat: false, confirm: null });
    expect(shown.details).toEqual(
      expect.arrayContaining(["Class: scope", "Answered by: your policy (recommended option, scope delegated)", "Answer via: inbox", "Reason: The recommended option: scope is delegated to it in this project"]),
    );
    expect(JSON.stringify(shown.frame)).not.toContain("answered by you");
    // Settled: not read again; and not the owner's answer, so it cannot become a precedent.
    expect(decisionPollMs(found(delivered), AT, NOW)).toBe(false);
    expect(precedentOfferView(delivered, PRECEDENT_UI_IDLE)).toBeNull();
  });

  it("asks whether a chat message answered it, and closes it without a grant", () => {
    const marked = ok(markNeedsConfirmation(questionDecision(), { via: "chat-worker", at: "2026-09-16T10:04:00.000Z" }));
    const shown = view(found(marked));
    expect(shown.frame.chip).toEqual({ text: "Needs confirmation", tone: "warning" });
    expect(shown.frame.body).toEqual([`You wrote in the Worker's chat at ${localTimeText(new Date("2026-09-16T10:04:00.000Z"), NOW)}. Did that answer it?`]);
    expect(shown).toMatchObject({ confirmChat: true, options: [], ownWords: false });
    const closed = ok(confirmDecision(marked, { answered: true, at: "2026-09-16T10:05:00.000Z" }));
    expect(view(found(closed)).frame.body).toEqual(["Answered in the Worker's chat (confirmed by you)."]);
  });

  it("offers nothing once superseded, withdrawn or expired", () => {
    const superseded = ok(supersedeDecision(questionDecision(), { by: `q:${REQ}:Q9`, at: "2026-09-16T10:06:00.000Z" }));
    expect(view(found(superseded)).frame).toMatchObject({ chip: { text: "Superseded", tone: "muted" }, body: ["Replaced by a newer question."] });
    expect(view(found(superseded)).details).toContain(`Superseded by: q:${REQ}:Q9`);
    const fallbackCard = decisionCardOf(fallbackDecisionSeed("fb-3f9a2c1d7e4b", "worker")!, null);
    const withdrawn = ok(withdrawDecision(questionDecision({ id: "f:fb-3f9a2c1d7e4b", requestId: null, askedBy: { role: "plugin", agentId: null }, round: null }), { at: "2026-09-16T10:06:00.000Z" }));
    expect(view(found(withdrawn), DECISION_UI_IDLE, fallbackCard).frame).toMatchObject({
      actor: { mark: null, name: "paseo-bm plugin" },
      chip: { text: "Withdrawn" },
      body: ["The incident was handled another way."],
    });
    // A Worker's question expires when its request finishes (autonomy design §A.3).
    const expired = ok(expireDecision(questionDecision(), { at: "2026-09-16T10:06:00.000Z" }));
    expect(view(found(expired)).frame).toMatchObject({ chip: { text: "Expired", tone: "muted" }, body: ["The request finished."] });
    expect(view(found(expired)).details).toContain("Status: expired at 2026-09-16T10:06:00.000Z");
    expect(decisionPollMs(found(expired), AT, NOW)).toBe(false);
    const expiredIncident = ok(expireDecision(questionDecision({ id: "f:fb-3f9a2c1d7e4b", requestId: null, askedBy: { role: "plugin", agentId: null }, round: null }), { at: "2026-09-16T10:06:00.000Z" }));
    expect(view(found(expiredIncident), DECISION_UI_IDLE, fallbackCard).frame.body).toEqual(["Nobody answered in time."]);
    for (const settled of [superseded, withdrawn, expired]) expect(view(found(settled))).toMatchObject({ options: [], ownWords: false, confirmChat: false });
  });

  it("shows the seed until the store answers, and says why nothing can be answered", () => {
    expect(view({ state: "loading" })).toMatchObject({ options: [], ownWords: false, frame: { title: "Storage — where does the list live?", chip: null, body: ["Reading the decision…"] } });
    expect(view({ state: "missing" }).frame.body).toEqual(["Not recorded yet: it opens once the Manager has read the report."]);
    const orchestratorCard = cards(answerNoticeOf(ok(answerDecision(orchestratorDecision(), { via: "inbox", optionKey: "hold", at: "2026-09-16T10:05:00.000Z" }))), "user_message", "s")![0]!;
    expect(view({ state: "missing" }, DECISION_UI_IDLE, orchestratorCard).frame).toMatchObject({ actor: { mark: "orchestrator", name: "Orchestrator" }, body: ["This decision is not recorded."] });
    const failed = view({ state: "failed", error: new DashboardError("E_DECISION_WRITE_FAILED", "cannot read the store") });
    expect(failed.frame.body).toEqual(["Could not read the decision (E_DECISION_WRITE_FAILED): cannot read the store"]);
    expect(view({ state: "failed", error: new Error("daemon unreachable") }).frame.body).toEqual(["Could not read the decision: daemon unreachable"]);
  });

  it("reads E_DECISION_NOT_FOUND as not recorded, anything else as a failure", () => {
    const decision = questionDecision();
    expect(decisionLookupOf({ data: { decision } })).toEqual({ state: "found", decision });
    expect(decisionLookupOf({ error: new DashboardError("E_DECISION_NOT_FOUND", "no such decision") })).toEqual({ state: "missing" });
    expect(decisionLookupOf({ error: new Error("socket closed") }).state).toBe("failed");
    expect(decisionLookupOf({ error: null })).toEqual({ state: "loading" });
  });

  it("reads again every 5 s while it can be answered, never once settled, and looks for a missing one only for a while", () => {
    expect(DECISION_POLL_MS).toBe(5_000);
    expect(decisionPollMs(found(questionDecision()), AT, NOW)).toBe(5_000);
    expect(decisionPollMs(found(ok(markNeedsConfirmation(questionDecision(), { via: "chat-worker", at: "t" }))), AT, NOW)).toBe(5_000);
    expect(decisionPollMs(found(ok(answerDecision(questionDecision(), { via: "inbox", optionKey: "a", at: "2026-09-16T10:02:00.000Z" }))), AT, NOW)).toBe(false);
    expect(decisionPollMs({ state: "missing" }, AT, new Date(AT.getTime() + 60_000))).toBe(5_000);
    expect(decisionPollMs({ state: "missing" }, AT, new Date(AT.getTime() + DECISION_LOOKUP_WINDOW_MS + 1))).toBe(false);
    expect(decisionPollMs({ state: "failed", error: new Error("x") }, AT, new Date(AT.getTime() + DECISION_LOOKUP_WINDOW_MS + 1))).toBe(false);
  });
});

describe("answering from the card", () => {
  it("renders answered on the next poll once decisions.answer took it — in every card that shows it", async () => {
    // A fake store behind the two RPCs, as the server applies them.
    let stored = questionDecision();
    const answer = vi.fn(async (input: { id: string; optionKey?: string; words?: string; confirmed?: true; via: "inbox" | "chat-card" }) => {
      const result = answerDecision(stored, { via: input.via, optionKey: input.optionKey ?? null, words: input.words ?? null, at: "2026-09-16T10:02:00.000Z" });
      if (!result.ok) throw new DashboardError("E_DECISION_SETTLED", result.message);
      stored = result.decision;
      return { decision: stored };
    });
    const get = async () => ({ decision: stored });

    const before = decisionLookupOf({ data: await get() });
    expect(view(before).options.map((option) => option.key)).toEqual(["a", "b"]);
    const result = await runDecisionAnswer({ id: Q_ID, choice: { optionKey: "a" }, confirmed: false, via: "chat-card", answer });
    expect(result.ok).toBe(true);
    expect(answer).toHaveBeenCalledTimes(1);
    expect(answer).toHaveBeenCalledWith({ id: Q_ID, optionKey: "a", via: "chat-card" });

    // Another copy of the card (the Worker's chat, the Inbox) reads it on its next poll.
    const after = decisionLookupOf({ data: await get() });
    const shown = view(after);
    expect(shown.frame.chip).toEqual({ text: "Decided", tone: "success" });
    expect(shown.frame.body[0]).toBe("✓ the existing table: no migration.");
    expect(shown.options).toEqual([]);
    expect(decisionPollMs(after, AT, NOW)).toBe(false);

    // A second answer from a stale copy is refused and says why.
    const again = await runDecisionAnswer({ id: Q_ID, choice: { optionKey: "b" }, confirmed: true, via: "chat-card", answer });
    expect(again).toEqual({ ok: false, reason: `Could not answer (E_DECISION_SETTLED): decision ${Q_ID} is answered by the owner; it can no longer be answered` });
  });

  it("passes confirmed only after the owner confirmed, and own words as words", async () => {
    const answer = vi.fn(async () => ({ decision: questionDecision() }));
    await runDecisionAnswer({ id: Q_ID, choice: { optionKey: "b" }, confirmed: true, via: "inbox", answer });
    await runDecisionAnswer({ id: Q_ID, choice: { words: "Use a file." }, confirmed: false, via: "chat-card", answer });
    expect(answer.mock.calls).toEqual([
      [{ id: Q_ID, optionKey: "b", confirmed: true, via: "inbox" }],
      [{ id: Q_ID, words: "Use a file.", via: "chat-card" }],
    ]);
    expect(await runDecisionAnswer({ id: Q_ID, choice: { words: "  " }, confirmed: false, via: "chat-card", answer })).toEqual({ ok: false, reason: "Write your answer first." });
    expect(answer).toHaveBeenCalledTimes(2);
    const refused = vi.fn(async () => {
      throw new DashboardError("E_DECISION_NOT_CONFIRMED", "confirm the push first");
    });
    expect(await runDecisionAnswer({ id: Q_ID, choice: { optionKey: "b" }, confirmed: false, via: "chat-card", answer: refused })).toEqual({
      ok: false,
      reason: "Could not answer (E_DECISION_NOT_CONFIRMED): confirm the push first",
    });
  });

  it("closes or keeps open a decision that needs confirmation with ONE decisions.confirm call", async () => {
    const confirm = vi.fn(async () => ({ decision: questionDecision() }));
    expect(await runDecisionConfirm({ id: Q_ID, answered: true, confirm })).toEqual({ ok: true, decision: questionDecision() });
    expect(confirm).toHaveBeenCalledWith({ id: Q_ID, answered: true });
    const refused = vi.fn(async () => {
      throw new DashboardError("E_DECISION_NOT_NEEDS_CONFIRMATION", "it is open");
    });
    expect(await runDecisionConfirm({ id: Q_ID, answered: false, confirm: refused })).toEqual({
      ok: false,
      reason: "Could not reopen the decision (E_DECISION_NOT_NEEDS_CONFIRMATION): it is open",
    });
  });
});

// ---------------------------------------------------------------------------
// The drawn cards (element tree).
// ---------------------------------------------------------------------------

const noop = () => undefined;
function drawDecision(shown: ReturnType<typeof view>, ui: DecisionUi = DECISION_UI_IDLE, detailsOpen = false, handlers: Record<string, unknown> = {}) {
  return renderTree(
    DecisionCardBody({
      view: shown,
      ui,
      detailsOpen,
      onToggleDetails: noop,
      onChoose: noop,
      onOpenWords: noop,
      onWords: noop,
      onSendWords: noop,
      onCancel: noop,
      onConfirm: noop,
      onCloseInChat: noop,
      text: ASKING,
      styles,
      theme,
      compact: false,
      ...handlers,
    }),
  );
}
const labels = (nodes: Array<RNode | string>) => pressables(nodes).map((node) => node.props["accessibilityLabel"]);

describe("the drawn decision card", () => {
  it("draws the frame, the options with the recommended one primary, Own words… and Details — and labels every button", () => {
    const onChoose = vi.fn();
    const nodes = drawDecision(view(found(questionDecision())), DECISION_UI_IDLE, false, { onChoose });
    const shown = texts(nodes);
    expect(shown).toEqual(
      expect.arrayContaining(["Worker · Contact redesign", "→ you", "asked 12 min ago", "Needs decision", "Storage — where does the list live?", "effects: push", "the existing table: no migration. ★", "Own words…", "Details ▸"]),
    );
    expect(labels(nodes)).toEqual(["Answer: the existing table: no migration. (recommended)", "Answer: a file on disk: simplest.; allows push", "Answer in your own words", "Show details"]);
    const [primary, secondary] = pressables(nodes);
    // The middle style is the options' layout (row or stacked), pinned by test/plugin-decision-options-layout.test.ts.
    expect(primary!.props["style"]).toEqual([{ name: "button" }, expect.any(Object), { opacity: 1 }]);
    expect(secondary!.props["style"]).toEqual([{ name: "secondaryButton" }, expect.any(Object), { opacity: 1 }]);
    (primary!.props["onPress"] as () => void)();
    expect(onChoose).toHaveBeenCalledWith("a");
    // No id on the face; Details is closed.
    expect(shown.join("\n")).not.toContain(Q_ID);
  });

  it("has no reply box, no Answered chip, no Mark as answered, no Use recommendations — in any state", () => {
    const decision = questionDecision();
    const states = [
      drawDecision(view(found(decision))),
      drawDecision(view(found(ok(answerDecision(decision, { via: "inbox", optionKey: "a", at: "2026-09-16T10:02:00.000Z" }))))),
      drawDecision(view(found(ok(markNeedsConfirmation(decision, { via: "chat-worker", at: "2026-09-16T10:04:00.000Z" }))))),
      drawDecision(view({ state: "missing" })),
    ];
    for (const nodes of states) {
      expect(allNodes(nodes).filter((node) => node.type === "TextInput")).toEqual([]);
      const words = texts(nodes).join("\n");
      for (const retired of ["Mark as answered", "Use recommendations", "Reply", "Answered\n", "Clear"]) expect(words).not.toContain(retired);
    }
  });

  it("opens the own-words box only on request, with Cancel and Send", () => {
    const nodes = drawDecision(view(found(questionDecision()), { ...DECISION_UI_IDLE, words: "" }), { ...DECISION_UI_IDLE, words: "" });
    const input = allNodes(nodes).find((node) => node.type === "TextInput");
    expect(input?.props["accessibilityLabel"]).toBe("Your answer in your own words");
    expect(labels(nodes)).toEqual(["Cancel", "Send your answer", "Show details"]);
    expect(pressables(nodes)[1]!.props["disabled"]).toBe(true);
  });

  it("draws the confirmation with Cancel first, and nothing else to press but Details", () => {
    const nodes = drawDecision(view(found(questionDecision()), { ...DECISION_UI_IDLE, confirming: "b" }), { ...DECISION_UI_IDLE, confirming: "b" });
    expect(texts(nodes)).toEqual(expect.arrayContaining(["Answer: a file on disk: simplest.?", "This answer allows push once, within the hour. Nothing is sent until you confirm."]));
    expect(labels(nodes)).toEqual(["Cancel", "Confirm and send", "Show details"]);
  });

  it("draws Keep open / Close as answered for a decision that needs confirmation", () => {
    const onCloseInChat = vi.fn();
    const nodes = drawDecision(view(found(ok(markNeedsConfirmation(questionDecision(), { via: "chat-manager", at: "2026-09-16T10:04:00.000Z" })))), DECISION_UI_IDLE, false, { onCloseInChat });
    expect(labels(nodes)).toEqual(["Keep the decision open", "Close the decision as answered", "Show details"]);
    (pressables(nodes)[1]!.props["onPress"] as () => void)();
    expect(onCloseInChat).toHaveBeenCalledWith(true);
  });

  it("shows the ids and the whole message only when Details is open", () => {
    const nodes = drawDecision(view(found(questionDecision())), DECISION_UI_IDLE, true);
    const shown = texts(nodes);
    expect(shown).toEqual(expect.arrayContaining([`Decision: ${Q_ID}`, `Request: ${REQ}`, "Details ▾"]));
    expect(labels(nodes).at(-1)).toBe("Hide details");
  });

  it("disables every answer while one is being sent, and shows a refusal", () => {
    const busy = { ...DECISION_UI_IDLE, busy: true };
    const nodes = drawDecision(view(found(questionDecision()), busy), busy);
    expect(pressables(nodes).slice(0, 3).map((node) => node.props["disabled"])).toEqual([true, true, true]);
    expect(texts(nodes)).toContain("Sending your answer…");
    const refused = { ...DECISION_UI_IDLE, error: "Could not answer (E_DECISION_SETTLED): decision is answered" };
    expect(texts(drawDecision(view(found(questionDecision()), refused), refused))).toContain("Could not answer (E_DECISION_SETTLED): decision is answered");
  });
});

describe("the frame and the compact line, drawn", () => {
  it("draws at most three body lines and colours only the outline of a finished card", () => {
    const shown: CardFrameView = { ...frameOf(card(FINISHED)), body: ["one", "two", "three", "four"] };
    const nodes = renderTree(CardFrame({ view: shown, details: null, detailsOpen: false, onToggleDetails: noop, styles, theme }));
    expect(texts(nodes)).toEqual(expect.arrayContaining(["one", "two", "three"]));
    expect(texts(nodes)).not.toContain("four");
    const outer = nodes[0] as RNode;
    expect(outer.props["style"]).toEqual([{ name: "card" }, { gap: 6, marginVertical: 4 }, { borderColor: "#statusSuccess" }]);
    const plain = renderTree(CardFrame({ view: frameOf(card(REPORT)), details: null, detailsOpen: false, onToggleDetails: noop, styles, theme }))[0] as RNode;
    expect((plain.props["style"] as unknown[])[2]).toBeNull();
    // The outline only: no element of either card draws a left border.
    const styleKeys = (tree: Array<RNode | string>) =>
      allNodes(tree).flatMap((node) => [node.props["style"]].flat(Infinity).flatMap((style) => (typeof style === "object" && style !== null ? Object.keys(style) : [])));
    const keys = [...styleKeys(nodes), ...styleKeys([plain])];
    expect(keys).toContain("borderColor");
    expect(keys.filter((key) => key.startsWith("borderLeft"))).toEqual([]);
  });

  it("draws a notice as one line that opens to the whole notice", () => {
    const notice = cards(`BM-FORMAT requestId: ${REQ}\nYour last BM-REPORT broke the template:`, "user_message", "s")![0]!;
    const onToggle = vi.fn();
    const closed = renderTree(CompactLine({ tone: "warning", text: noticeLine(notice, AT, NOW), expanded: false, onToggle, details: "whole", styles, theme }));
    expect(texts(closed)).toEqual(["●", "A block broke its template — Your last BM-REPORT broke the template: · 12 min ago", "▸"]);
    expect(labels(closed)[0]).toBe("A block broke its template — Your last BM-REPORT broke the template: · 12 min ago. Show the whole notice");
    (pressables(closed)[0]!.props["onPress"] as () => void)();
    expect(onToggle).toHaveBeenCalled();
  });
});

describe("the message in Details", () => {
  it("renders report fields as a bold-key list, not one paragraph", () => {
    const blocks = parseMarkdown(markdownOf(["```", REPORT, "```", "", "Anything else?"].join("\n")));
    expect(blocks[0]).toMatchObject({ kind: "paragraph", spans: [{ text: "BM-REPORT", bold: true }] });
    const bullets = blocks.filter((block) => block.kind === "bullet");
    expect(bullets).toHaveLength(12);
    expect(bullets[0]).toMatchObject({ spans: [{ text: "requestId", bold: true }, { text: `: ${REQ}` }] });
    expect(blocks.some((block) => block.kind === "code")).toBe(false);
  });

  it("lays out a bolded marker, **BM-REPORT**, as a block too (Phase 3 live check F5)", () => {
    const bolded = REPORT.replace(/^BM-REPORT$/m, "**BM-REPORT**");
    expect(bolded).not.toBe(REPORT);
    const blocks = parseMarkdown(markdownOf(["```", bolded, "```"].join("\n")));
    expect(blocks[0]).toMatchObject({ kind: "paragraph", spans: [{ text: "BM-REPORT", bold: true }] });
    expect(blocks.filter((block) => block.kind === "bullet")).toHaveLength(12);
    expect(markdownOf("**BM-REVIEW** STOPPED").split("\n")[0]).toBe("**BM-REVIEW STOPPED**");
  });

  it("leaves free text as it is, and lays a plain-text card out the same way", () => {
    expect(markdownOf(INSTRUCTION)).toBe(INSTRUCTION);
    const markdown = fallbackMarkdown({ text: ASKING });
    expect(markdown).toBe(markdownOf(ASKING));
    expect(markdown).toContain("- **phase**: blocked");
    expect(markdown).toContain("  - **a**: the existing table: no migration. (recommended)");
  });
});

describe("chat.peers", () => {
  const agent = (id: string, role: string, workspaceId: string, labels: Record<string, string> = {}) => ({
    id,
    workspaceId,
    status: "idle",
    title: `${role} ${id}`,
    labels: { "bm.role": role, ...labels },
  });
  /** The shared fake SDK with the agents of two workspaces, and any `more`. */
  const paseo = (more: Array<ReturnType<typeof agent> & { archivedAt?: string }> = []) =>
    fakePaseo<DashboardPaseo>({
      agents: [
        agent("m1", "manager", "wks_a"),
        agent("w1", "worker", "wks_a", { "bm.requestId": "req-1", "paseo.parent-agent-id": "m1" }),
        agent("w9", "worker", "wks_b"),
        agent("r1", "reviewer", "wks_a", { "bm.requestId": "req-1", "bm.batchId": "b2", "paseo.parent-agent-id": "w1" }),
        ...more,
      ],
    }).paseo;

  it("says which agents are archived (delta 20260918f F12)", async () => {
    const withArchived = paseo([{ ...agent("w0", "worker", "wks_a", { "bm.requestId": "req-1" }), archivedAt: "2026-09-18T00:00:00.000Z" }]);
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
        sent: [{ agentId: null, at: "2026-09-16T09:59:00.000Z", text: `CONTINUE — \`${REQ}\``, truncated: false }],
      });
      clearTraceStoreCache();
      const withUnlabelled = paseo([agent("w0", "worker", "wks_a")]);
      const result = await handleChatPeers({ agentId: "m1" }, withUnlabelled, { homedir: () => home });
      expect(result.peers.find((p) => p.id === "w0")?.requestId).toBe(REQ);
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
      const switched = { ...incident({ id: "fb-0000000000dd", workspaceId: "wks_a", requestId: "req-1", agentId: "w0", parentId: "m1", managerId: "m1", message: "" }), status: "switched", decidedAt: "2026-09-22T00:01:00.000Z", replacementId: "w1" };
      writeFileSync(join(home, ".paseo-bm", "role-fallback-state.json"), JSON.stringify({ version: 1, incidents: [switched] }));
      const sdk = paseo([
        // Label missing (labelling failed), but the incident says it was switched.
        agent("w0", "worker", "wks_a", { "bm.requestId": "req-1", "paseo.parent-agent-id": "m1" }),
        agent("w8", "worker", "wks_a", { "bm.requestId": "req-8", "bm.replacedBy": "w1" }),
      ]);
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

describe("Save as precedent on the decision card (autonomy design §B.6, §B.9)", () => {
  const answeredBy = (answer: { optionKey?: string; words?: string }, overrides: Partial<Decision> = {}) =>
    ok(answerDecision(questionDecision(overrides), { via: "chat-card", optionKey: answer.optionKey ?? null, words: answer.words ?? null, at: "2026-09-16T10:02:00.000Z" }));
  const PRECEDENT = {
    id: "p:1",
    scope: "wks_a",
    subject: "storage",
    text: "the existing table: no migration.",
    sourceDecisionId: Q_ID,
    createdAt: "2026-09-16T10:03:00.000Z",
    expiresAt: "2026-10-16T10:03:00.000Z",
    supersededBy: null,
  };
  const on = { open: noop, text: noop, scope: noop, cancel: noop, save: noop };
  const drawWith = (decision: Decision, precedentUi: PrecedentUi, handlers: Partial<typeof on> = {}) =>
    drawDecision(view(found(decision)), DECISION_UI_IDLE, false, { precedent: precedentOfferView(decision, precedentUi), onPrecedent: { ...on, ...handlers } });

  it("is offered only on a decision the owner answered that carries a subject", () => {
    expect(precedentOfferView(answeredBy({ optionKey: "a" }), PRECEDENT_UI_IDLE)?.offer).toEqual({
      label: SAVE_AS_PRECEDENT_LABEL,
      accessibilityLabel: 'Save this answer as a precedent for "storage"',
    });
    // Open, needing confirmation, superseded; no subject; answered by the Orchestrator; not read yet: nothing.
    expect(precedentOfferView(questionDecision(), PRECEDENT_UI_IDLE)).toBeNull();
    expect(precedentOfferView(ok(markNeedsConfirmation(questionDecision(), { via: "chat-worker", at: "2026-09-16T10:04:00.000Z" })), PRECEDENT_UI_IDLE)).toBeNull();
    expect(precedentOfferView(ok(supersedeDecision(questionDecision(), { by: `q:${REQ}:Q9`, at: "2026-09-16T10:06:00.000Z" })), PRECEDENT_UI_IDLE)).toBeNull();
    expect(precedentOfferView(answeredBy({ optionKey: "a" }, { subject: null }), PRECEDENT_UI_IDLE)).toBeNull();
    const byOrchestrator = ok(storedOrchestratorAnswer(questionDecision(), { optionKey: "a", reason: "No migration.", at: "2026-09-16T10:02:00.000Z" }));
    expect(precedentOfferView(byOrchestrator, PRECEDENT_UI_IDLE)).toBeNull();
    expect(precedentOfferView(null, PRECEDENT_UI_IDLE)).toBeNull();

    // Drawn: one secondary button on the answered card, none on an open one — and no text box until pressed.
    const onOpen = vi.fn();
    const nodes = drawWith(answeredBy({ optionKey: "a" }), PRECEDENT_UI_IDLE, { open: onOpen });
    expect(labels(nodes)).toEqual(['Save this answer as a precedent for "storage"', "Show details"]);
    expect(allNodes(nodes).filter((node) => node.type === "TextInput")).toEqual([]);
    (pressables(nodes)[0]!.props["onPress"] as () => void)();
    expect(onOpen).toHaveBeenCalledOnce();
    expect(texts(drawWith(questionDecision(), PRECEDENT_UI_IDLE))).not.toContain(SAVE_AS_PRECEDENT_LABEL);
  });

  it("opens a form with the answer as the text, this project first, and Cancel before Save", () => {
    expect(precedentFormOf(answeredBy({ optionKey: "a" }))).toEqual({ text: "the existing table: no migration.", scope: "project" });
    expect(precedentFormOf(answeredBy({ words: "A file, later." }))).toEqual({ text: "A file, later.", scope: "project" });
    const decision = answeredBy({ optionKey: "a" });
    const ui: PrecedentUi = { ...PRECEDENT_UI_IDLE, form: precedentFormOf(decision) };
    const shown = precedentOfferView(decision, ui)!;
    expect(shown.offer).toBeNull();
    expect(shown.form).toMatchObject({
      title: 'Save as precedent for "storage"?',
      text: "the existing table: no migration.",
      textHint: null,
      cancelLabel: "Cancel",
      saveLabel: "Save precedent",
      saveEnabled: true,
    });
    expect(shown.form!.body).toMatch(/for 30 days — release, data, security and cost questions still come to you/);
    expect(shown.form!.scopes.map((scope) => [scope.label, scope.selected])).toEqual([
      ["This project", true],
      ["All projects", false],
    ]);

    const onScope = vi.fn();
    const onSave = vi.fn();
    const nodes = drawWith(decision, ui, { scope: onScope, save: onSave });
    expect(allNodes(nodes).find((node) => node.type === "TextInput")?.props["accessibilityLabel"]).toBe("The precedent's answer");
    // The scope choices, then Cancel first, then Save; every pressable labelled.
    expect(labels(nodes)).toEqual(["Keep it for this project only", "Keep it for every project", "Cancel", "Save the precedent for this project", "Show details"]);
    for (const button of pressables(nodes)) expect(String(button.props["accessibilityLabel"] ?? "")).not.toBe("");
    (pressables(nodes)[1]!.props["onPress"] as () => void)();
    expect(onScope).toHaveBeenCalledWith("all");
    (pressables(nodes)[3]!.props["onPress"] as () => void)();
    expect(onSave).toHaveBeenCalledOnce();
    // No id on the card's face.
    expect(texts(nodes).join("\n")).not.toContain(Q_ID);
  });

  it("will not save an empty or too long text, says it was saved, or why not", () => {
    const decision = answeredBy({ optionKey: "a" });
    const blank = precedentOfferView(decision, { ...PRECEDENT_UI_IDLE, form: { text: "  ", scope: "all" } })!;
    expect(blank.form).toMatchObject({ saveEnabled: false, textHint: "Write the answer to keep." });
    expect(precedentOfferView(decision, { ...PRECEDENT_UI_IDLE, form: { text: "x".repeat(1001), scope: "all" } })!.form?.textHint).toBe("At most 1000 characters (now 1001).");
    const busy = precedentOfferView(decision, { ...PRECEDENT_UI_IDLE, busy: true, form: { text: "x", scope: "all" } })!;
    expect(busy.form).toMatchObject({ saveEnabled: false, saveLabel: "Saving…", busy: true });
    expect(labels(drawWith(decision, { ...PRECEDENT_UI_IDLE, busy: true, form: { text: "x", scope: "all" } }))).not.toContain("Cancel");

    const saved = precedentOfferView(decision, { ...PRECEDENT_UI_IDLE, saved: { scope: "all", expiresAt: PRECEDENT.expiresAt } })!;
    expect(saved).toEqual({ offer: null, form: null, status: { text: "Saved as a precedent for all projects until 2026-10-16.", tone: "success" } });
    const refused = precedentOfferView(decision, { ...PRECEDENT_UI_IDLE, error: "Could not save the precedent (E_PRECEDENT_INVALID): no" })!;
    expect(refused.status).toEqual({ text: "Could not save the precedent (E_PRECEDENT_INVALID): no", tone: "danger" });
    const nodes = drawWith(decision, { ...PRECEDENT_UI_IDLE, saved: { scope: "project", expiresAt: PRECEDENT.expiresAt } });
    expect(texts(nodes)).toContain("Saved as a precedent for this project until 2026-10-16.");
    expect(labels(nodes)).toEqual(["Show details"]);
  });

  it("saves with ONE precedents.save call: the decision, its project or all, the text as left", async () => {
    const decision = answeredBy({ optionKey: "a" });
    const save = vi.fn(async () => ({ precedent: PRECEDENT }));
    expect(await runPrecedentSave({ decision, form: { text: " the table ", scope: "project" }, save })).toEqual({ ok: true, precedent: PRECEDENT });
    await runPrecedentSave({ decision, form: { text: "the table", scope: "all" }, save });
    expect(save.mock.calls).toEqual([
      [{ decisionId: Q_ID, scope: "wks_a", text: "the table" }],
      [{ decisionId: Q_ID, scope: "all", text: "the table" }],
    ]);
    expect(await runPrecedentSave({ decision, form: { text: " ", scope: "all" }, save })).toEqual({ ok: false, reason: "Write the answer to keep first." });
    expect(save).toHaveBeenCalledTimes(2);
    const refused = vi.fn(async () => {
      throw new DashboardError("E_PRECEDENT_INVALID", "decision has no subject; nothing was saved");
    });
    expect(await runPrecedentSave({ decision, form: { text: "x", scope: "all" }, save: refused })).toEqual({
      ok: false,
      reason: "Could not save the precedent (E_PRECEDENT_INVALID): decision has no subject; nothing was saved",
    });
  });
});

// A precedent on the card of an open decision it did not answer, and a decision a precedent answered (autonomy design §B.6).
describe("owner precedents on the decision card", () => {
  const STANDING: Precedent = {
    id: "p:7c1d",
    scope: "wks_a",
    subject: "storage",
    text: "the existing table: no migration.",
    sourceDecisionId: null,
    createdAt: "2026-09-12T09:00:00.000Z",
    expiresAt: "2026-10-12T09:00:00.000Z",
    supersededBy: null,
  };

  it("suggests the precedent on an open release question with the option it names; nothing when none bears on it", () => {
    // Option b pushes, so this question is a release one: the precedent did not answer it.
    const decision = questionDecision();
    expect(precedentSuggestionView(decision, [STANDING], DECISION_UI_IDLE, NOW)).toEqual({
      line: "Precedent: the existing table: no migration. (saved 2026-09-12)",
      use: { label: USE_PRECEDENT_LABEL, accessibilityLabel: "Use your precedent's answer: the existing table: no migration.", choice: { optionKey: "a" } },
    });
    // Its own words when no option is its text.
    expect(precedentSuggestionView(decision, [{ ...STANDING, text: "Keep it in memory" }], DECISION_UI_IDLE, NOW)?.use?.choice).toEqual({ words: "Keep it in memory" });
    // Nothing to pick while a confirmation or the own-words box is open; the line stays.
    const confirming = precedentSuggestionView(decision, [STANDING], { ...DECISION_UI_IDLE, confirming: "b" }, NOW);
    expect(confirming).toMatchObject({ line: expect.stringContaining("Precedent:"), use: null });
    expect(precedentSuggestionView(decision, [STANDING], { ...DECISION_UI_IDLE, words: "" }, NOW)?.use).toBeNull();
    // None: not read yet, another subject or project, expired, no subject, not open.
    expect(precedentSuggestionView(decision, undefined, DECISION_UI_IDLE, NOW)).toBeNull();
    expect(precedentSuggestionView(decision, [{ ...STANDING, subject: "sessions" }], DECISION_UI_IDLE, NOW)).toBeNull();
    expect(precedentSuggestionView(decision, [{ ...STANDING, scope: "wks_b" }], DECISION_UI_IDLE, NOW)).toBeNull();
    expect(precedentSuggestionView(decision, [{ ...STANDING, expiresAt: "2026-09-16T10:00:00.000Z" }], DECISION_UI_IDLE, NOW)).toBeNull();
    expect(precedentSuggestionView(questionDecision({ subject: null }), [STANDING], DECISION_UI_IDLE, NOW)).toBeNull();
    expect(precedentSuggestionView(ok(answerDecision(decision, { via: "inbox", optionKey: "a", at: "2026-09-16T10:02:00.000Z" })), [STANDING], DECISION_UI_IDLE, NOW)).toBeNull();
    expect(precedentSuggestionView(null, [STANDING], DECISION_UI_IDLE, NOW)).toBeNull();
    // A fallback incident's words run no action: shown, not offered.
    const fallback = questionDecision({ id: "f:fb-3f9a2c1d7e4b", requestId: null, askedBy: { role: "plugin", agentId: null }, round: null });
    expect(precedentSuggestionView(fallback, [{ ...STANDING, text: "Always wait" }], DECISION_UI_IDLE, NOW)?.use).toBeNull();
  });

  it("draws the suggestion first, labelled, and picks it on a press", () => {
    const onUseSuggestion = vi.fn();
    const decision = questionDecision();
    const suggestion = precedentSuggestionView(decision, [STANDING], DECISION_UI_IDLE, NOW);
    const nodes = drawDecision(view(found(decision)), DECISION_UI_IDLE, false, { suggestion, onUseSuggestion });
    expect(texts(nodes)).toEqual(expect.arrayContaining(["Precedent: the existing table: no migration. (saved 2026-09-12)", USE_PRECEDENT_LABEL]));
    expect(labels(nodes)[0]).toBe("Use your precedent's answer: the existing table: no migration.");
    (pressables(nodes)[0]!.props["onPress"] as () => void)();
    expect(onUseSuggestion).toHaveBeenCalledWith({ optionKey: "a" });
    // Without one, the card is as before.
    expect(labels(drawDecision(view(found(decision)), DECISION_UI_IDLE, false, { suggestion: null, onUseSuggestion }))).toEqual(labels(drawDecision(view(found(decision)))));
  });

  it("shows a decision a precedent answered as answered by your precedent, citing it in Details", () => {
    const decided = ok(
      answerDecision(questionDecision({ options: [{ key: "a", label: "the existing table: no migration.", recommended: true, effects: ["none"] }] }), {
        by: "precedent",
        precedentId: STANDING.id,
        reason: `The owner's precedent on "storage", saved 2026-09-12`,
        via: "inbox",
        optionKey: "a",
        at: "2026-09-16T10:02:00.000Z",
      }),
    );
    const shown = view(found(decided));
    expect(shown.frame).toMatchObject({
      chip: { text: "Decided", tone: "success" },
      authority: `answered by your precedent · ${localTimeText(new Date("2026-09-16T10:02:00.000Z"), NOW)}`,
      body: ["✓ the existing table: no migration."],
    });
    expect(shown.details).toEqual(expect.arrayContaining([`Answered by: your precedent ${STANDING.id}`, `Reason: The owner's precedent on "storage", saved 2026-09-12`]));
    expect(JSON.stringify(shown.frame)).not.toContain(STANDING.id);
    expect(JSON.stringify(shown.frame)).not.toContain("answered by you in");
    const inWords = ok(answerDecision(questionDecision(), { by: "precedent", precedentId: STANDING.id, via: "inbox", words: "Keep it in memory", at: "2026-09-16T10:02:00.000Z" }));
    expect(view(found(inWords)).frame.body[0]).toBe("Your precedent: Keep it in memory");
    // Not the owner's own answer, so it cannot become a precedent in turn.
    expect(precedentOfferView(decided, PRECEDENT_UI_IDLE)).toBeNull();
  });
});

describe("the finished card reads its request's finish (autonomy design §C.3, §C.6; bead 7gxw.4)", () => {
  const unverified: TraceVerification = {
    reportAt: "2026-09-16T10:00:00.000Z",
    checks: "self-reported",
    named: [
      { check: "npm test", label: "self-reported" },
      { check: "npm run lint", label: "detected" },
    ],
    files: [{ path: "src/contact.tsx", label: "detected" }],
    beads: [{ id: "bd-12", label: "self-reported" }],
    changedFiles: true,
    unverified: true,
  };
  const verified: TraceVerification = { ...unverified, checks: "detected", named: [{ check: "npm test", label: "detected" }], unverified: false };
  const finishedFrame = (verification: TraceVerification | null | undefined) =>
    cardFrameOf(card(FINISHED), { owner: manager, peers: [worker, otherWorker, reviewer], at: AT, now: NOW, ...(verification === undefined ? {} : { verification }) });

  it("chips Finished — unverified, in the warning tone, for an unverified finish; Finished otherwise", () => {
    expect(finishedFrame(unverified)).toMatchObject({ chip: { text: "Finished — unverified", tone: "warning" }, outline: "warning", title: "Contact form redesigned and tested." });
    for (const shownAsBefore of [verified, { ...unverified, checks: "not-checked" as const, unverified: false }, null, undefined]) {
      expect(finishedFrame(shownAsBefore)).toMatchObject({ chip: { text: "Finished", tone: "success" }, outline: "success" });
    }
    // The face keeps its body, and no path or bead id.
    expect(finishedFrame(unverified).body).toEqual(finishedFrame(null).body);
    const face = (view: CardFrameView) => [view.actor.name, view.recipient, view.authority, view.chip?.text, view.title, view.tag, ...view.body].join("\n");
    expect(face(finishedFrame(unverified))).not.toMatch(/src\/contact|bd-12/);
    // Only a finished card reads it.
    expect(cardFrameOf(card(REPORT), { owner: manager, peers: [], at: AT, now: NOW, verification: unverified }).chip).toEqual({ text: "Working", tone: "info" });
  });

  it("lists the checks, files and beads with their labels under Details", () => {
    expect(detailLinesOf(card(FINISHED), manager, unverified)).toEqual([
      `Request: ${REQ}`,
      "Phase: finished",
      "Finished — unverified: code changed, and not every check the report names was seen to pass after the last edit.",
      "Check: npm test — self-reported",
      "Check: npm run lint — detected ✓",
      "File: src/contact.tsx — detected",
      "Bead: bd-12 — self-reported",
    ]);
    expect(detailLinesOf(card(FINISHED), manager, verified).slice(2)).toEqual([
      "Checks: detected",
      "Check: npm test — detected ✓",
      "File: src/contact.tsx — detected",
      "Bead: bd-12 — self-reported",
    ]);
    // Not checked, or not known: as before.
    expect(detailLinesOf(card(FINISHED), manager, { ...unverified, checks: "not-checked", unverified: false })).toEqual([`Request: ${REQ}`, "Phase: finished"]);
    expect(detailLinesOf(card(FINISHED), manager)).toEqual([`Request: ${REQ}`, "Phase: finished"]);
    expect(detailLinesOf(card(REPORT), manager, unverified)).toEqual([`Request: ${REQ}`, "Phase: beads-done"]);
  });

  it("finds the finish by the card's request among the traces.list rows", () => {
    const rows = [
      { requestId: "req-other", verification: verified },
      { requestId: REQ },
      { requestId: REQ, verification: unverified },
    ];
    expect(verificationOfRequest(rows, REQ)).toEqual(unverified);
    expect(verificationOfRequest(rows, "req-none")).toBeNull();
    expect(verificationOfRequest(rows, null)).toBeNull();
    expect(verificationOfRequest(undefined, REQ)).toBeNull();
  });

  it("draws the warning chip and outline in the frame", () => {
    const nodes = renderTree(CardFrame({ view: finishedFrame(unverified), details: null, detailsOpen: false, onToggleDetails: noop, styles, theme }));
    expect(texts(nodes)).toContain("Finished — unverified");
    expect((nodes[0] as RNode).props["style"]).toEqual([{ name: "card" }, { gap: 6, marginVertical: 4 }, { borderColor: "#statusWarning" }]);
  });
});
