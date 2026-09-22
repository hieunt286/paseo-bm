import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fallbackNotice, handleFallbackAct, handleFallbackIncidents, notifyFallback } from "../plugin/server/fallback-rpc";
import { ROLE_FALLBACK_STATE_FILE } from "../plugin/server/fallback-state";
import { createNoticeQueue } from "../plugin/server/notice-queue";
import { isPluginNotice } from "../plugin/server/notices";
import { parseFallbackNotice } from "../plugin/shared/bm-fallback";
import type { FallbackIncident } from "../plugin/shared/contracts";

/**
 * Delta 20260921 §4.4.6, §4.4.10 (REQ-065 c): BM-FALLBACK to the Manager chat,
 * the `fallback.incidents` RPC and the card's "I'll handle it" action.
 */

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
  message: "You've hit your usage limit.\nYour limit resets at 3:40pm.",
  perModelWindow: false,
  resetsAt: "2026-09-21T15:40:00Z",
  candidate: { position: 1, alias: "bm-worker-fallback-1", baseProvider: "codex", model: "gpt-5.6-sol", thinkingOptionId: "high", modeId: "full-access" },
  status: "pending",
  detectedAt: "2026-09-21T14:00:00.000Z",
  decidedAt: null,
  waitUntil: null,
  replacementId: null,
  error: null,
  ...overrides,
});

const EXPECTED = [
  "BM-FALLBACK",
  "incident: fb-3f9a2c1d7e4b",
  "role: worker",
  "agent: wrk-1",
  "requestId: req-20260921T111242Z",
  "status: pending",
  "class: L1 usage limit",
  "provider: bm-worker (claude) · claude-opus-5",
  "message: You've hit your usage limit. Your limit resets at 3:40pm.",
  "resetsAt: 2026-09-21T15:40:00Z",
  "candidate: bm-worker-fallback-1 · codex · gpt-5.6-sol · thinking high",
  "replacement: none",
  "",
  "The worker stopped because of its provider plan. The user decides on the card in this chat. Tell the user in one line; do not create an agent yourself.",
].join("\n");

function fakePaseo(statuses: Record<string, string> = {}) {
  const sent: Array<{ id: string; text: string }> = [];
  const paseo = {
    agents: {
      ref: (id: string) => ({
        refresh: async () => ({ agent: { status: statuses[id] ?? "idle" } }),
        send: async (text: string) => void sent.push({ id, text }),
      }),
    },
    config: { get: async () => ({ config: { providers: { "bm-worker": { extends: "claude" }, "bm-worker-fallback-1": { extends: "codex" } } } }) },
  };
  return { paseo, sent, statuses };
}

let root: string;
let home: string;
const log = vi.fn();

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "bm-fallback-rpc-"));
  home = join(root, ".paseo-bm");
  mkdirSync(home);
  log.mockReset();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const writeIncidents = (incidents: FallbackIncident[]) =>
  writeFileSync(join(home, ROLE_FALLBACK_STATE_FILE), JSON.stringify({ version: 1, incidents }));

describe("BM-FALLBACK", () => {
  it("is the block of the design, word for word, with the message on one line", () => {
    expect(fallbackNotice(incident(), (alias) => (alias === "bm-worker" ? "claude" : null))).toBe(EXPECTED);
  });

  it("writes none / unknown for what is not known, and cuts the message to 300 characters", () => {
    const text = fallbackNotice(
      incident({ requestId: null, resetsAt: null, candidate: null, agentModel: null, message: "x".repeat(400) }),
      () => null,
    );
    expect(text).toContain("\nrequestId: none\n");
    expect(text).toContain("\nprovider: bm-worker (unknown) · unknown\n");
    expect(text).toContain("\nresetsAt: unknown\n");
    expect(text).toContain("\ncandidate: none\n");
    expect(text).toContain(`\nmessage: ${"x".repeat(300)}\n`);
  });

  it("reaches a running Manager at its next turn end, exactly", async () => {
    const queue = createNoticeQueue({ log: () => {} });
    const fake = fakePaseo({ "mgr-1": "running" });
    expect(await notifyFallback(incident(), fake.paseo, { enqueue: queue.enqueue, log })).toBe("queued");
    expect(fake.sent).toEqual([]);
    fake.statuses["mgr-1"] = "idle";
    await queue.turnEnded({ agent: { id: "mgr-1" } }, fake.paseo);
    expect(fake.sent).toEqual([{ id: "mgr-1", text: EXPECTED }]);
  });

  it("tells nobody when the incident has no Manager chat", async () => {
    const enqueue = vi.fn();
    expect(await notifyFallback(incident({ managerId: null }), fakePaseo().paseo, { enqueue, log })).toBeNull();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("is a plugin notice, as BM-RESUME is: never the user's words, never a review call", () => {
    expect(isPluginNotice(EXPECTED)).toBe(true);
    expect(isPluginNotice("BM-RESUME Your usage limit has reset. Carry on with what you were doing.")).toBe(true);
  });
});

describe("parseFallbackNotice", () => {
  it("reads the block the plugin writes", () => {
    expect(parseFallbackNotice(EXPECTED)).toEqual({
      incident: "fb-3f9a2c1d7e4b",
      role: "worker",
      agent: "wrk-1",
      requestId: "req-20260921T111242Z",
      status: "pending",
      class: "L1",
      provider: "bm-worker (claude) · claude-opus-5",
      message: "You've hit your usage limit. Your limit resets at 3:40pm.",
      resetsAt: "2026-09-21T15:40:00Z",
      candidate: "bm-worker-fallback-1 · codex · gpt-5.6-sol · thinking high",
      replacement: null,
    });
  });

  it("is forgiving: quoted, other key case, extra keys, none and unknown", () => {
    const quoted = EXPECTED.split("\n")
      .map((line) => `> ${line}`)
      .join("\n")
      .replace("> requestId: req-20260921T111242Z", "> Request_Id: none")
      .replace("> status: pending", "> STATUS: Switched\n> extra: ignored");
    expect(parseFallbackNotice(`Before.\n${quoted}`)).toMatchObject({ requestId: null, status: "switched", resetsAt: "2026-09-21T15:40:00Z" });
    expect(parseFallbackNotice(EXPECTED.replace("resetsAt: 2026-09-21T15:40:00Z", "resetsAt: unknown"))?.resetsAt).toBeNull();
  });

  it("gives null without a marker or a usable incident id, and null fields for values it does not know", () => {
    expect(parseFallbackNotice("incident: fb-3f9a2c1d7e4b")).toBeNull();
    expect(parseFallbackNotice("BM-FALLBACK\nincident: 42")).toBeNull();
    expect(parseFallbackNotice(42)).toBeNull();
    expect(parseFallbackNotice("BM-FALLBACK\nincident: fb-3f9a2c1d7e4b\nrole: boss\nstatus: maybe\nclass: L3 rate limit")).toMatchObject({
      role: null,
      status: null,
      class: null,
    });
  });
});

describe("fallback.incidents", () => {
  it("lists the incidents, filtered by workspace and by ids", async () => {
    const a = incident();
    const b = incident({ id: "fb-000000000001", workspaceId: "wks_2" });
    writeIncidents([a, b]);
    const paseo = fakePaseo().paseo;
    expect((await handleFallbackIncidents({}, paseo, { home })).incidents).toEqual([a, b]);
    expect((await handleFallbackIncidents({ workspaceId: "wks_2" }, paseo, { home })).incidents).toEqual([b]);
    expect((await handleFallbackIncidents({ ids: [a.id] }, paseo, { home })).incidents).toEqual([a]);
    expect((await handleFallbackIncidents({}, paseo, { home: null })).incidents).toEqual([]);
  });
});

describe("fallback.act", () => {
  const NOW = () => new Date("2026-09-21T14:05:00.000Z");

  it("dismiss marks a pending incident dismissed, touches no agent, and tells the Manager chat", async () => {
    writeIncidents([incident()]);
    const enqueue = vi.fn<(target: string, kind: string, text: string) => Promise<"sent">>(async () => "sent");
    const fake = fakePaseo();
    const { incident: after } = await handleFallbackAct({ incidentId: "fb-3f9a2c1d7e4b", action: "dismiss" }, fake.paseo, { home, now: NOW, enqueue, log });
    expect(after).toMatchObject({ status: "dismissed", decidedAt: "2026-09-21T14:05:00.000Z", replacementId: null });
    expect(JSON.parse(readFileSync(join(home, ROLE_FALLBACK_STATE_FILE), "utf8")).incidents[0].status).toBe("dismissed");
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue.mock.calls[0]![0]).toBe("mgr-1");
    expect(enqueue.mock.calls[0]![2]).toContain("\nstatus: dismissed\n");
    expect(fake.sent).toEqual([]);
  });

  it("refuses an incident that is no longer pending, and an unknown one", async () => {
    writeIncidents([incident({ status: "dismissed" })]);
    const paseo = fakePaseo().paseo;
    await expect(handleFallbackAct({ incidentId: "fb-3f9a2c1d7e4b", action: "dismiss" }, paseo, { home, log })).rejects.toMatchObject({
      code: "E_FALLBACK_NOT_PENDING",
    });
    await expect(handleFallbackAct({ incidentId: "fb-000000000009", action: "dismiss" }, paseo, { home, log })).rejects.toMatchObject({
      code: "E_FALLBACK_NOT_FOUND",
    });
  });

  it("hands switch and wait to the modules that implement them, with a coded error until then", async () => {
    writeIncidents([incident()]);
    const paseo = fakePaseo().paseo;
    await expect(handleFallbackAct({ incidentId: "fb-3f9a2c1d7e4b", action: "switch" }, paseo, { home, log })).rejects.toMatchObject({
      code: "E_FALLBACK_CREATE_FAILED",
    });
    await expect(handleFallbackAct({ incidentId: "fb-3f9a2c1d7e4b", action: "wait" }, paseo, { home, log })).rejects.toMatchObject({
      code: "E_FALLBACK_NO_RESET",
    });
    const wait = vi.fn(async (current: FallbackIncident) => ({ ...current, status: "waiting" as const }));
    const enqueue = vi.fn<(target: string, kind: string, text: string) => Promise<"sent">>(async () => "sent");
    await expect(
      handleFallbackAct({ incidentId: "fb-3f9a2c1d7e4b", action: "wait" }, paseo, { home, log, enqueue, actions: { wait } }),
    ).resolves.toMatchObject({ incident: { status: "waiting" } });
    expect(wait).toHaveBeenCalledTimes(1);
    expect(enqueue.mock.calls[0]![2]).toContain("\nstatus: waiting\n");
  });
});
