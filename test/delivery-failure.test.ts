import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { INBOX_DIR_NAME, createAlertStore } from "../plugin/server/alert-store";
import { DELIVERY_FAILED_MARKER, tellFailedDelivery } from "../plugin/server/delivery-failure";
import type { ChannelQueue } from "../plugin/server/main-channel";
import { createRequestRegistry } from "../plugin/server/request-registry";

/** ADR-042 decision 5: a delivery that failed is told, on real stores in a temporary folder. */
const WS = "wks-a";
const REQ = "req-20261106T000000Z";
const failure = { workspaceId: WS, requestId: REQ, what: "the answers q:x:Q1", to: "wrk-1", reason: "the send failed" };

describe("tellFailedDelivery", () => {
  let home: string;
  let sent: Array<{ target: string; kind: string; text: string; wake: boolean }>;
  let queue: ChannelQueue;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "bm-delivery-failure-"));
    sent = [];
    queue = {
      enqueue: async (target, kind, text, _paseo, _callbacks, options) => {
        sent.push({ target, kind, text, wake: options?.wake === true });
        return "sent";
      },
    };
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  const register = () => createRequestRegistry(home, { backfill: () => [] }).register(WS, REQ, { source: "tool", managerId: "main-1", workerId: "wrk-1" });

  it("raises the delivery-dropped alert and wakes the request's Main with what did not arrive", async () => {
    register();
    await tellFailedDelivery(failure, { home, queue, log: () => {} });
    expect(createAlertStore(home).list({ open: true, kinds: ["delivery-dropped"] })).toMatchObject([{ workspaceId: WS, subject: REQ }]);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ target: "main-1", kind: `${DELIVERY_FAILED_MARKER}:${REQ}`, wake: true });
    expect(sent[0]!.text).toContain("what: the answers q:x:Q1");
    expect(sent[0]!.text.split("\n")[0]).toBe(DELIVERY_FAILED_MARKER);
  });

  it("does not send to the Main when the Main is what could not be reached; the alert stands", async () => {
    register();
    await tellFailedDelivery({ ...failure, to: "main-1" }, { home, queue, log: () => {} });
    expect(sent).toEqual([]);
    expect(createAlertStore(home).list({ open: true, kinds: ["delivery-dropped"] })).toHaveLength(1);
  });

  it("sends one notice per open alert (ADR-045 decision 14): a second drop and an updated detail send none; after the alert clears, the next drop sends one", async () => {
    register();
    const alerts = createAlertStore(home);
    await tellFailedDelivery(failure, { home, queue, log: () => {} });
    await tellFailedDelivery(failure, { home, queue, log: () => {} });
    expect(sent).toHaveLength(1);
    await tellFailedDelivery({ ...failure, what: "the answers q:x:Q2", reason: "another reason" }, { home, queue, log: () => {} });
    expect(sent).toHaveLength(1);
    expect(alerts.list({ open: true, kinds: ["delivery-dropped"] })[0]!.detail).toContain("the answers q:x:Q2");

    alerts.clearWhere((alert) => alert.kind === "delivery-dropped");
    await tellFailedDelivery(failure, { home, queue, log: () => {} });
    expect(sent).toHaveLength(2);
  });

  it("uses the caller's fuller line for the alert when it gives one", async () => {
    register();
    await tellFailedDelivery({ ...failure, detail: "The report out-1 was not delivered: gone." }, { home, queue, log: () => {} });
    expect(createAlertStore(home).list({ open: true, kinds: ["delivery-dropped"] })[0]!.detail).toBe("The report out-1 was not delivered: gone.");
  });

  it("sends no notice when the alert could not be raised", async () => {
    register();
    const logs: string[] = [];
    // A file where the alert store's folder should be: its write fails.
    writeFileSync(join(home, INBOX_DIR_NAME), "");
    await tellFailedDelivery(failure, { home, queue, log: (line) => logs.push(line) });
    expect(sent).toEqual([]);
    expect(logs.join("\n")).toContain("could not raise the delivery-dropped alert");
  });

  it("tells no Main for a finished or an unknown request", async () => {
    await tellFailedDelivery(failure, { home, queue, log: () => {} });
    expect(sent).toEqual([]);
    register();
    createRequestRegistry(home, { backfill: () => [] }).noteReport(WS, REQ, { tier: "Small", phase: "finished", at: "2026-11-06T01:00:00.000Z" });
    await tellFailedDelivery(failure, { home, queue, log: () => {} });
    expect(sent).toEqual([]);
  });
});
