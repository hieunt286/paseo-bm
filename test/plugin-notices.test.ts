import { describe, expect, it } from "vitest";
import {
  BUDGET_NOTICE_MARKER,
  WORKER_STOP_NOTICE,
  WORKER_STOP_NOTICE_MARKER,
  isPluginNotice,
} from "../plugin/server/notices";
import { REVIEWER_STOP_NOTICE } from "../plugin/server/stop-propagation";
import { NEW_REQUEST_MARKER, stripNewRequestMarker } from "../plugin/shared/new-request";

/**
 * The plugin's own notices must be recognisable again after they are sent.
 *
 * Paseo's SDK attaches a `messageId` to every `send()`, and the daemon stores it
 * as `clientMessageId` — the field the collector uses to tell the user's own
 * words from a relayed message. Without this list the plugin's notices are
 * recorded as things the USER said: the Metric screen shows "you" saying
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
