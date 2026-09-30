import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAlertStore } from "../plugin/server/alert-store";
import { handleInboxAlerts, registerInboxRpcs, type InboxRpcDeps } from "../plugin/server/inbox-rpc";
import { INBOX_ALERTS_MAX, inboxAlertsRpc } from "../plugin/shared/contracts";

/**
 * `inbox.alerts` (autonomy design §A.8, §A.12) against a temporary data
 * folder named by `PASEO_BM_HOME`. Never the real HOME.
 */

const T0 = Date.parse("2026-09-29T08:00:00.000Z");
let root: string;
let home: string;
let clock: number;
let deps: InboxRpcDeps;

const store = () => createAlertStore(home, { now: () => new Date(clock) });

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "bm-inbox-rpc-"));
  home = join(root, "data");
  clock = T0;
  deps = { env: { PASEO_BM_HOME: home }, homedir: () => root, log: () => undefined };
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("inbox.alerts", () => {
  it("reads nothing, and writes nothing, when no alert was ever raised", () => {
    expect(handleInboxAlerts({}, deps)).toEqual({ alerts: [], truncated: false });
  });

  it("returns the open alerts only, in ALERT_KINDS order and oldest first within a kind", () => {
    const s = store();
    s.raise({ workspaceId: "wks_1", kind: "fallback-failed", subject: "f:fb-000000000d01" });
    clock += 60_000;
    s.raise({ workspaceId: "wks_1", kind: "stuck", subject: "wrk-2", detail: "no tool call" });
    clock += 60_000;
    s.raise({ workspaceId: "wks_2", kind: "stuck", subject: "wrk-1" });
    s.raise({ workspaceId: "wks_2", kind: "request-stalled", subject: "req-A" });
    const cleared = s.raise({ workspaceId: "wks_1", kind: "danger", subject: "wrk-3" });
    s.clear(cleared.alert.key);

    const out = handleInboxAlerts({}, deps);
    expect(inboxAlertsRpc.output.parse(out)).toEqual(out);
    expect(out.alerts.map((alert) => `${alert.kind}:${alert.subject}`)).toEqual([
      "request-stalled:req-A",
      "stuck:wrk-2",
      "stuck:wrk-1",
      "fallback-failed:f:fb-000000000d01",
    ]);
    expect(out.alerts[1]).toMatchObject({ key: "stuck:wks_1:wrk-2", detail: "no tool call", clearedAt: null });
    expect(handleInboxAlerts({ workspaceId: "wks_2" }, deps).alerts.map((alert) => alert.subject)).toEqual(["req-A", "wrk-1"]);
  });

  it("stops at INBOX_ALERTS_MAX and says more were open", () => {
    const s = store();
    for (let n = 0; n <= INBOX_ALERTS_MAX; n += 1) s.raise({ workspaceId: "wks_1", kind: "stuck", subject: `wrk-${n}` });
    const out = handleInboxAlerts({}, deps);
    expect(out.alerts).toHaveLength(INBOX_ALERTS_MAX);
    expect(out.truncated).toBe(true);
  });

  it("reads as no alerts without a usable data folder", () => {
    expect(handleInboxAlerts({}, { env: { PASEO_BM_HOME: "relative/path" }, homedir: () => root })).toEqual({ alerts: [], truncated: false });
  });

  it("registers the one RPC", () => {
    const handle = vi.fn();
    registerInboxRpcs({ handle } as unknown as Parameters<typeof registerInboxRpcs>[0], deps);
    expect(handle.mock.calls.map(([contract]) => (contract as { name: string }).name)).toEqual(["inbox.alerts"]);
    store().raise({ workspaceId: "wks_1", kind: "stuck", subject: "wrk-1" });
    const handler = handle.mock.calls[0]![1] as (input: unknown) => { alerts: unknown[] };
    expect(handler({}).alerts).toHaveLength(1);
  });

  it("starts onRead (the outdated-agents pass) with the RPC's Paseo handle, never waiting for it or failing on it", () => {
    const handle = vi.fn();
    const onRead = vi.fn(() => new Promise<never>(() => {}));
    registerInboxRpcs({ handle } as unknown as Parameters<typeof registerInboxRpcs>[0], { ...deps, onRead });
    const handler = handle.mock.calls[0]![1] as (input: unknown, context?: unknown) => { alerts: unknown[] };
    const paseo = { agents: {} };
    expect(handler({}, { paseo })).toEqual({ alerts: [], truncated: false });
    expect(onRead).toHaveBeenCalledWith(paseo);

    const throwing = vi.fn();
    registerInboxRpcs({ handle: throwing } as unknown as Parameters<typeof registerInboxRpcs>[0], {
      ...deps,
      onRead: () => {
        throw new Error("boom");
      },
    });
    const broken = throwing.mock.calls[0]![1] as (input: unknown, context?: unknown) => { alerts: unknown[] };
    expect(broken({}, { paseo }).alerts).toEqual([]);
  });
});
