import { describe, expect, it } from "vitest";
import {
  cardFrameOf,
  chatCardSchema,
  commandAuthorityText,
  commandEffectsText,
  commandWorkerName,
  detailLinesOf,
  eventsNoticeOf,
  eventsOf,
  eventTone,
  eventWhat,
  noticeLine,
  toChatCards,
  type ChatCard,
} from "../plugin/client/chat-cards";
import { commandBlockOf, type CommandInput } from "../plugin/shared/orchestrator-command";
import { eventLineOf, eventsMessageOf } from "../plugin/server/event-bus";
import type { ChatPeer } from "../plugin/shared/contracts";

/**
 * Cards v2 of the Orchestrator's blocks (autonomy design §A.12): a delivered
 * `BM-COMMAND` is an `action` card, a Manager's copy of a Worker command one
 * notice line, and a batched `BM-EVENTS` message one compact line. There is
 * no command card, copy card or event card any more.
 */

const REQUEST = "req-20260929T081500Z";
const DECISION = "o:3f1c2b9a-0d4e-4c55-9f00-1234567890ab";

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
const workerA = peer({ id: "w1aaaaaaaaaa", title: "Checkout fix", parentId: "m1", requestId: REQUEST });
const workerB = peer({ id: "w2bbbbbbbbbb", title: "Search index", parentId: "m1", requestId: "req-20260929T090000Z" });

const input = (overrides: Partial<CommandInput> = {}): CommandInput => ({
  from: "orchestrator",
  via: "chat",
  to: "manager",
  requestId: REQUEST,
  re: "Carry on with the checkout fix",
  body: "Tell the Worker to run the tests again and report.",
  why: "The last report stopped before the tests.",
  intent: "continue",
  effects: ["commit"],
  approved: [],
  ...overrides,
});

/** A command as the Manager or Worker receives it: through the notice queue, with a clientMessageId. */
const received = (text: string) => toChatCards({ type: "user_message", text, clientMessageId: "sdk-message-id" }, "complete");
const commandCard = (overrides: Partial<CommandInput> = {}): ChatCard => received(commandBlockOf(input(overrides)))![0]!;
const AT = new Date("2026-09-29T10:00:00Z");
const NOW = new Date("2026-09-29T10:12:30Z");
const frame = (card: ChatCard, owner: ChatPeer | null = manager, peers: ChatPeer[] = [workerA]) => cardFrameOf(card, { owner, peers, at: AT, now: NOW });

describe("a delivered BM-COMMAND becomes an action card", () => {
  it("keeps the parsed block, its request and its subject, and round-trips the schema", () => {
    const card = commandCard();
    expect(card).toMatchObject({
      type: "action",
      direction: "received",
      requestId: REQUEST,
      gist: "Carry on with the checkout fix",
      command: { version: 2, from: "orchestrator", via: "chat", to: "manager", copy: false, intent: "continue", effects: ["commit"] },
      decision: null,
      notice: null,
    });
    expect(chatCardSchema.parse(card)).toEqual(card);
    expect(JSON.parse(JSON.stringify(card))).toEqual(card);
    // Also without a clientMessageId, and never from the agent's own message.
    expect(toChatCards({ type: "user_message", text: card.text }, "complete")?.[0]?.type).toBe("action");
    expect(toChatCards({ type: "assistant_message", text: card.text }, "complete")).toBeUndefined();
  });

  it("draws intent → target, authority, effects and the body in the one frame", () => {
    const view = frame(commandCard());
    expect(view).toMatchObject({
      actor: { mark: "orchestrator", name: "Orchestrator" },
      recipient: "Manager",
      authority: "your word in chat",
      chip: { text: "Continue", tone: "info" },
      title: "Carry on with the checkout fix",
      tag: "effects: commit",
      body: ["Tell the Worker to run the tests again and report.", "Why: The last report stopped before the tests."],
      outline: null,
    });
    // No id on the card's face: the request and the decision are in Details.
    expect(JSON.stringify(view)).not.toContain(REQUEST);
    expect(detailLinesOf(commandCard(), manager)).toContain(`Request: ${REQUEST}`);
  });

  it("says on whose authority it went and what it may do", () => {
    const text = (overrides: Partial<CommandInput>) => commandAuthorityText(commandCard(overrides).command!);
    expect(text({ from: "owner", via: "tab", authority: "owner" })).toBe("your command");
    expect(text({ via: "autopilot", authority: "autopilot" })).toBe("Autopilot");
    expect(text({ authority: `decision:${DECISION}`, approved: ["commit"] })).toBe("your decision");
    expect(commandEffectsText(commandCard({ effects: [] }).command!)).toBe("no effects");
    expect(commandEffectsText(commandCard({ effects: ["commit", "push"], approved: ["push"], authority: `decision:${DECISION}` }).command!)).toBe("approved: push");
    // The decision behind the command is named in Details only.
    const decided = commandCard({ authority: `decision:${DECISION}`, approved: ["commit"] });
    expect(JSON.stringify(frame(decided))).not.toContain(DECISION);
    expect(detailLinesOf(decided, manager)).toContain(`Decision: ${DECISION}`);
  });

  it("still reads a version 1 block, by how it left", () => {
    const v1 = [
      "BM-COMMAND",
      "from: orchestrator",
      "via: autopilot",
      "to: manager",
      `requestId: ${REQUEST}`,
      "re: Carry on",
      "limits: no-commit-push-deploy, no-real-data",
      "",
      "Run the tests.",
    ].join("\n");
    const card = received(v1)![0]!;
    expect(card).toMatchObject({ type: "action", command: { version: 1, intent: null, authority: null } });
    expect(frame(card)).toMatchObject({ authority: "Autopilot", chip: null, tag: null, title: "Carry on" });
    expect(detailLinesOf(card, manager)).toContain("Limits: no-commit-push-deploy, no-real-data");
  });

  it("names the Worker: the chat's own agent, or the one live Worker of the request", () => {
    const direct = commandCard({ to: "worker" });
    expect(commandWorkerName(direct, workerA, [manager, workerA])).toBe("Worker · Checkout fix");
    expect(frame(direct, workerA, [manager]).recipient).toBe("Worker · Checkout fix");
    // No title: the role alone, never an id. Two live Workers of the request, or none: no guess.
    expect(commandWorkerName(direct, manager, [manager, { ...workerA, title: null }])).toBe("Worker");
    expect(commandWorkerName(direct, manager, [manager, workerA, { ...workerB, requestId: REQUEST }])).toBeNull();
    expect(frame(direct, manager, [manager, workerB]).recipient).toBe("Worker");
    expect(commandWorkerName(commandCard(), manager, [manager, workerA])).toBeNull();
  });

  it("is the owner's own when it comes from the tab", () => {
    expect(frame(commandCard({ from: "owner", via: "tab", authority: "owner" })).actor).toEqual({ mark: null, name: "You" });
  });

  it("keeps the body to the card's lines: the rest is in Details", () => {
    const body = ["Do this:", "", "- run the tests", "- report", "- stop", "- and more"].join("\n");
    const view = frame(commandCard({ body, why: null }));
    expect(view.body).toEqual(["Do this:", "run the tests", "report"]);
    expect(frame(commandCard({ body })).body).toHaveLength(3);
  });
});

describe("a Manager's copy of a Worker command is a notice line, not a card", () => {
  it("says what was sent to whom, in one line", () => {
    const copy = commandCard({ to: "worker", copy: true });
    expect(copy).toMatchObject({ type: "notice", command: null, notice: { marker: "BM-COMMAND", what: "Copy of a command to the Worker: Carry on with the checkout fix", tone: "muted" } });
    expect(chatCardSchema.parse(copy)).toEqual(copy);
    expect(noticeLine(copy, AT, NOW)).toBe("Copy of a command to the Worker: Carry on with the checkout fix · 12 min ago");
  });

  it("falls back to the generic notice line when the block does not parse, and leaves a quote alone", () => {
    const broken = commandBlockOf(input()).replace("via: chat", "via: carrier-pigeon");
    expect(received(broken)).toEqual([expect.objectContaining({ type: "notice", command: null, notice: expect.objectContaining({ marker: "BM-COMMAND" }) })]);
    expect(received(`Look:\n\n${commandBlockOf(input())}`)).toBeUndefined();
  });
});

describe("BM-EVENTS is one compact line (autonomy design §A.8)", () => {
  const events = eventsMessageOf([
    eventLineOf({ type: "request.finished", workspaceId: "ws-a", requestId: REQUEST, managerId: "m1", at: "2026-09-29T10:00:00Z" }),
    eventLineOf({ type: "decision.opened", workspaceId: "ws-a", requestId: REQUEST, decisionId: `q:${REQUEST}:Q1`, askedBy: "w1aaaaaaaaaa" }),
    eventLineOf({ type: "decision.opened", workspaceId: "ws-a", requestId: REQUEST, decisionId: `q:${REQUEST}:Q2`, askedBy: "w1aaaaaaaaaa" }),
  ]);

  it("reads each event line of the plugin's message", () => {
    expect(eventsOf(events)).toEqual([
      { type: "request.finished", detail: null },
      { type: "decision.opened", detail: null },
      { type: "decision.opened", detail: null },
    ]);
  });

  it("counts the events and says what happened, without ids", () => {
    const card = received(events)![0]!;
    expect(card).toMatchObject({ type: "notice", notice: { marker: "BM-EVENTS", what: "3 events: a request finished, a decision was opened", tone: "info" } });
    expect(chatCardSchema.parse(card)).toEqual(card);
    const line = noticeLine(card, AT, NOW);
    expect(line).toBe("3 events: a request finished, a decision was opened · 12 min ago");
    expect(line).not.toContain(REQUEST);
  });

  it("colours the dot by the most urgent event", () => {
    expect(eventTone({ type: "worker.signal", detail: "danger" })).toBe("danger");
    expect(eventTone({ type: "request.stalled", detail: "idle-unfinished" })).toBe("warning");
    expect(eventTone({ type: "request.finished", detail: null })).toBe("success");
    const risky = eventsMessageOf(["- request.finished — project ws-a, …", "- worker.signal danger — project ws-a, Worker w1, …"]);
    expect(eventsNoticeOf(risky)).toEqual({ what: "2 events: a request finished, a Worker ran a risky command", tone: "danger" });
  });

  it("says an event, stall reason or signal it does not know as written", () => {
    expect(eventWhat({ type: "request.stalled", detail: "review-over-budget" })).toBe("a review went over its budget");
    expect(eventWhat({ type: "worker.signal", detail: "sleepy" })).toBe("a Worker signal: sleepy");
    expect(eventWhat({ type: "project.renamed", detail: null })).toBe("event: project.renamed");
    expect(eventsNoticeOf("BM-EVENTS\nnothing here")).toEqual({ what: "Events for the Orchestrator", tone: "muted" });
  });

  it("leaves the retired BM-EVENT and BM-STALL notices to Paseo", () => {
    expect(received("BM-EVENT finished\nProject: Checkout (ws-a)")).toBeUndefined();
    expect(received("BM-STALL idle-unfinished\nProject: Checkout (ws-a)")).toBeUndefined();
  });
});
