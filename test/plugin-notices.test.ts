import { describe, expect, it } from "vitest";
import {
  ANSWER_NOTICE_MARKER,
  BUDGET_NOTICE_MARKER,
  HANDOFF_NOTICE_MARKER,
  INTERRUPTED_NOTICE_MARKER,
  REPLACED_NOTICE_MARKER,
  STATE_NOTICE_MARKER,
  WORKER_STOP_NOTICE,
  WORKER_STOP_NOTICE_MARKER,
  isPluginNotice,
  noticeMarkerOf,
} from "../plugin/server/notices";
import { interruptedNoticeText } from "../plugin/server/interruption-watch";
import { REVIEWER_STOP_NOTICE } from "../plugin/server/stop-propagation";
import { NEW_REQUEST_MARKER, stripNewRequestMarker } from "../plugin/shared/new-request";

/**
 * The plugin's own notices must be recognisable again after they are sent.
 *
 * Paseo's SDK attaches a `messageId` to every `send()`, and the daemon stores it
 * as `clientMessageId` — the field the collector uses to tell the user's own
 * words from a relayed message. Without this list the plugin's notices are
 * recorded as things the USER said: a request's history shows "you" saying
 * `BM-BUDGET …`, counts it among your messages, and can take it for the request
 * text (review b2 of delta 20260917c).
 */
describe("isPluginNotice", () => {
  it("knows each notice the plugin can send", () => {
    expect(isPluginNotice(`${BUDGET_NOTICE_MARKER} requestId: req-1`)).toBe(true);
    expect(isPluginNotice(REVIEWER_STOP_NOTICE)).toBe(true);
    // Trailing text does not matter: the check is on the start.
    expect(isPluginNotice(`${WORKER_STOP_NOTICE} … extra text appended later`)).toBe(true);
    expect(isPluginNotice(WORKER_STOP_NOTICE)).toBe(true);
  });

  it("does not claim a person's message", () => {
    expect(isPluginNotice("Hãy dừng lại giúp tôi")).toBe(false);
    expect(isPluginNotice("stop all the workers please")).toBe(false);
    // A report is not a notice either: the collector has its own parser for it.
    expect(isPluginNotice("BM-REPORT\nrequestId: req-1\nphase: finished")).toBe(false);
  });

  it("knows BM-ANSWER as a whole word only: the owner's BM-ANSWERS block and the BM-ANSWERED notice keep their own reading (autonomy design §A.6)", () => {
    expect(isPluginNotice("BM-ANSWER\ndecisionId: o:1")).toBe(true);
    expect(isPluginNotice("BM-ANSWER")).toBe(true);
    expect(noticeMarkerOf("BM-ANSWER\ndecisionId: o:1")).toBe(ANSWER_NOTICE_MARKER);
    // An answers block typed by the owner is the owner's words, never a notice.
    expect(isPluginNotice("BM-ANSWERS\nrequestId: req-1\nQ1: a")).toBe(false);
    expect(noticeMarkerOf("BM-ANSWERS\nrequestId: req-1")).toBeNull();
    expect(noticeMarkerOf("BM-ANSWERED requestId: req-1")).toBe("BM-ANSWERED");
  });

  it("knows the BM-STATE brief after a compaction as a whole word; the /compact before it is no notice — the send log tells it apart (autonomy design §G.5)", () => {
    expect(STATE_NOTICE_MARKER).toBe("BM-STATE");
    expect(isPluginNotice("BM-STATE\nFrom the paseo-bm plugin, not the owner: your context was just compacted.")).toBe(true);
    expect(noticeMarkerOf("BM-STATE\nrole: worker")).toBe(STATE_NOTICE_MARKER);
    expect(isPluginNotice("BM-STATEMENT of work")).toBe(false);
    // The owner may type /compact too: a leading /compact is never a notice by its text.
    expect(isPluginNotice("/compact")).toBe(false);
    expect(isPluginNotice("/compact Keep: the owner's request")).toBe(false);
  });

  it("knows the BM-HANDOFF note request as a whole word; the successor's BM-HANDOFF-BRIEF, which the Manager sends, is no notice (autonomy design §G.6)", () => {
    expect(HANDOFF_NOTICE_MARKER).toBe("BM-HANDOFF");
    expect(isPluginNotice("BM-HANDOFF\nFrom the paseo-bm plugin, not the owner")).toBe(true);
    expect(noticeMarkerOf("BM-HANDOFF\nWrite your handoff note now")).toBe(HANDOFF_NOTICE_MARKER);
    expect(isPluginNotice("BM-HANDOFF-BRIEF h1\nrole: worker")).toBe(false);
    expect(isPluginNotice("BM-HANDOFFS are fine")).toBe(false);
  });

  it("knows the BM-REPLACED word to an outgoing Worker as a whole word (autonomy design §G.6; live check F4)", () => {
    expect(REPLACED_NOTICE_MARKER).toBe("BM-REPLACED");
    expect(isPluginNotice("BM-REPLACED\nFrom the paseo-bm plugin, not the owner: request req-1 is handed over")).toBe(true);
    expect(noticeMarkerOf("BM-REPLACED\nStop working on it")).toBe(REPLACED_NOTICE_MARKER);
    expect(isPluginNotice("BM-REPLACEDBY x")).toBe(false);
  });

  it("knows BM-INTERRUPTED as a whole word, so the notice is never the owner's words (ADR-024)", () => {
    expect(INTERRUPTED_NOTICE_MARKER).toBe("BM-INTERRUPTED");
    expect(isPluginNotice(interruptedNoticeText("2026-10-01T01:55:00.322Z"))).toBe(true);
    expect(noticeMarkerOf("BM-INTERRUPTED\ncutAt: x")).toBe(INTERRUPTED_NOTICE_MARKER);
    expect(isPluginNotice("BM-INTERRUPTEDX")).toBe(false);
  });

  it("is not fooled by a non-string", () => {
    for (const value of [null, undefined, 42, {}, ["BM-STOP"]]) {
      expect(isPluginNotice(value)).toBe(false);
    }
  });
});

describe("the Worker stop notice", () => {
  it("starts with the marker, so the collector recognises it", () => {
    expect(WORKER_STOP_NOTICE.startsWith(WORKER_STOP_NOTICE_MARKER)).toBe(true);
    expect(WORKER_STOP_NOTICE_MARKER).toBe("BM-STOP");
  });

  it("says who asked and that this is a stop", () => {
    expect(WORKER_STOP_NOTICE).toMatch(/user asked/i);
    expect(WORKER_STOP_NOTICE).toMatch(/this is a stop/i);
  });

  /**
   * The notice POINTS AT the Worker's stop rule instead of restating it. The
   * first draft of delta 20260917e restated it and got it wrong twice: it
   * dropped the mandatory `cancel_agent` on the Worker's own Reviewers, and it
   * asked for a `blocked` report, which `manager.md` renders as a numbered
   * question list — for a stop that has no questions.
   */
  it("does not restate the stop procedure", () => {
    expect(WORKER_STOP_NOTICE).toMatch(/follow your Stop rule/i);
    expect(WORKER_STOP_NOTICE).not.toMatch(/cancel_agent/i);
    expect(WORKER_STOP_NOTICE).not.toMatch(/blocked/i);
    expect(WORKER_STOP_NOTICE).not.toMatch(/BM-REPORT/);
  });
});

/**
 * The flag `/bm-worker-new` puts on the user's request (delta 20260917f).
 *
 * It is a flag on THEIR words, not a notice of the plugin's own, and the whole
 * design turns on that difference: treat it as a notice and the collector marks
 * the message `origin: "agent"`, `firstUserText` skips it, and the Dashboard
 * loses the request it was carrying.
 */
describe("the new-request flag", () => {
  const flagged = (request: string) => `${NEW_REQUEST_MARKER}\n${request}`;

  it("is NOT a plugin notice, or the Dashboard would lose the request", () => {
    expect(isPluginNotice(flagged("Sửa giúp tôi cái CI"))).toBe(false);
  });

  it("comes off, leaving exactly the user's words", () => {
    expect(stripNewRequestMarker(flagged("Sửa giúp tôi cái CI"))).toBe("Sửa giúp tôi cái CI");
    expect(stripNewRequestMarker(flagged("dòng một\ndòng hai"))).toBe("dòng một\ndòng hai");
  });

  it("leaves a message that never carried it alone", () => {
    expect(stripNewRequestMarker("Sửa giúp tôi cái CI")).toBe("Sửa giúp tôi cái CI");
    // A message that merely mentions the flag mid-text is not flagged.
    expect(stripNewRequestMarker(`xem ${NEW_REQUEST_MARKER} nhé`)).toBe(`xem ${NEW_REQUEST_MARKER} nhé`);
  });

  it("gives back nothing when the flag arrived with no request", () => {
    expect(stripNewRequestMarker(NEW_REQUEST_MARKER)).toBe("");
  });
});
