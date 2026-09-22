import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ROLE_FALLBACK_STATE_FILE, updateIncidents } from "../plugin/server/fallback-state";
import { noticeQueue } from "../plugin/server/notice-queue";
import { MAX_WAIT_MS, RESUME_NOTICE, WAIT_GRACE_MS, createFallbackWaiter } from "../plugin/server/fallback-wait";
import type { FallbackIncident } from "../plugin/shared/contracts";

/**
 * Delta 20260921 §4.4.9 (REQ-065 e, owner decision Q6 a): "Wait until the
 * reset" — one timer per click, written to the incidents file, set again after
 * a reload, ended by a status change. Fake timers, fake agents, temporary home.
 */

const NOW = new Date("2026-09-22T10:00:00.000Z");
const RESETS = "2026-09-22T12:00:00.000Z";

const incident = (overrides: Partial<FallbackIncident> = {}): FallbackIncident => ({
  id: "fb-0000000000aa",
  role: "worker",
  workspaceId: "wks_1",
  requestId: "req-20260922T090000Z",
  agentId: "wrk-1",
  agentProvider: "bm-worker/claude-opus-5",
  agentModel: "claude-opus-5",
  parentId: "mgr-1",
  managerId: "mgr-1",
  class: "L1",
  signal: "failed",
  message: "usage limit",
  perModelWindow: false,
  resetsAt: RESETS,
  candidate: null,
  status: "pending",
  detectedAt: "2026-09-22T09:59:00.000Z",
  decidedAt: null,
  waitUntil: null,
  replacementId: null,
  error: null,
  ...overrides,
});

function fakeAgents(snapshot: Record<string, unknown> = { status: "idle", labels: {} }) {
  const sent: Array<{ id: string; text: string }> = [];
  const state = { snapshot };
  const paseo = {
    agents: {
      ref: (id: string) => ({
        refresh: async () => ({ agent: state.snapshot }),
        send: async (text: string) => void sent.push({ id, text }),
      }),
    },
  };
  return { paseo, sent, state };
}

let root: string;
let home: string;
const log = vi.fn();
const read = (): FallbackIncident[] => JSON.parse(readFileSync(join(home, ROLE_FALLBACK_STATE_FILE), "utf8")).incidents;
const write = (incidents: FallbackIncident[]) => writeFileSync(join(home, ROLE_FALLBACK_STATE_FILE), JSON.stringify({ version: 1, incidents }));

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "bm-fallback-wait-"));
  home = join(root, ".paseo-bm");
  mkdirSync(home);
  log.mockReset();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
  noticeQueue.clear();
  rmSync(root, { recursive: true, force: true });
});

describe("the wait action", () => {
  it("records waiting until resetsAt + 60 s, then resumes the idle agent with the exact text and tells the Manager chat", async () => {
    write([incident()]);
    const notify = vi.fn(async () => undefined);
    const waiter = createFallbackWaiter({ home, log, notify });
    const { paseo, sent } = fakeAgents();
    const waiting = await waiter.wait(incident(), paseo, { home });
    expect(waiting).toMatchObject({ status: "waiting", decidedAt: NOW.toISOString(), waitUntil: "2026-09-22T12:01:00.000Z" });
    expect(read()[0]).toMatchObject({ status: "waiting" });

    await vi.advanceTimersByTimeAsync(2 * 60 * 60 * 1000 + WAIT_GRACE_MS - 1000);
    expect(sent).toEqual([]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(sent).toEqual([{ id: "wrk-1", text: RESUME_NOTICE }]);
    expect(RESUME_NOTICE).toBe("BM-RESUME The usage limit that stopped you has reset. Continue from where you stopped; do not redo finished work.");
    expect(read()[0]).toMatchObject({ status: "resumed" });
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ id: "fb-0000000000aa", status: "resumed" }), paseo);
  });

  it("refuses an unknown reset or one more than 7 days ahead with E_FALLBACK_NO_RESET, writing nothing", async () => {
    const waiter = createFallbackWaiter({ home, log });
    const { paseo } = fakeAgents();
    const far = new Date(NOW.getTime() + MAX_WAIT_MS + 60_000).toISOString();
    write([incident({ resetsAt: far })]);
    await expect(waiter.wait(incident({ resetsAt: far }), paseo, { home })).rejects.toMatchObject({ code: "E_FALLBACK_NO_RESET" });
    await expect(waiter.wait(incident({ resetsAt: null }), paseo, { home })).rejects.toMatchObject({ code: "E_FALLBACK_NO_RESET" });
    expect(read()[0]).toMatchObject({ status: "pending" });
  });

  it.each([
    ["running", { status: "running", labels: {} }],
    ["archived", { status: "idle", archivedAt: "2026-09-22T11:00:00.000Z", labels: {} }],
    ["already replaced", { status: "idle", labels: { "bm.replacedBy": "wrk-2" } }],
  ])("marks the incident expired, sending nothing, when the agent is %s at the reset", async (_label, snapshot) => {
    write([incident()]);
    const notify = vi.fn(async () => undefined);
    const waiter = createFallbackWaiter({ home, log, notify });
    const { paseo, sent } = fakeAgents(snapshot);
    await waiter.wait(incident(), paseo, { home });
    await vi.advanceTimersByTimeAsync(3 * 60 * 60 * 1000);
    expect(sent).toEqual([]);
    expect(read()[0]).toMatchObject({ status: "expired" });
    expect(notify).not.toHaveBeenCalled();
  });

  it("ends the wait when the incident's status changes: nothing is sent at the reset", async () => {
    write([incident()]);
    const waiter = createFallbackWaiter({ home, log });
    const { paseo, sent } = fakeAgents();
    await waiter.wait(incident(), paseo, { home });
    await updateIncidents(home, (incidents) => incidents.map((entry) => ({ ...entry, status: "dismissed" as const })));
    await vi.advanceTimersByTimeAsync(3 * 60 * 60 * 1000);
    expect(sent).toEqual([]);
    expect(read()[0]).toMatchObject({ status: "dismissed" });
    // And cancel() clears the timer outright.
    write([incident()]);
    await waiter.wait(incident(), paseo, { home });
    expect(vi.getTimerCount()).toBe(1);
    waiter.cancel("fb-0000000000aa");
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("after a plugin reload", () => {
  it("sets the timer of a waiting incident again, once per run", async () => {
    write([incident({ status: "waiting", decidedAt: NOW.toISOString(), waitUntil: "2026-09-22T12:01:00.000Z" })]);
    const waiter = createFallbackWaiter({ home, log });
    const { paseo, sent } = fakeAgents();
    await waiter.ensureArmed(paseo);
    await waiter.ensureArmed(paseo);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(2 * 60 * 60 * 1000 + WAIT_GRACE_MS);
    // The agent is resumed, then its Manager chat is told (the default notice, through the queue).
    expect(sent.map((entry) => entry.id)).toEqual(["wrk-1", "mgr-1"]);
    expect(sent[0]!.text).toBe(RESUME_NOTICE);
    expect(sent[1]!.text).toMatch(/^BM-FALLBACK\nincident: fb-0000000000aa\n[\s\S]*\nstatus: resumed\n/);
    expect(read()[0]).toMatchObject({ status: "resumed" });
  });

  it("fires at once for a wait already past due", async () => {
    write([incident({ status: "waiting", decidedAt: "2026-09-21T09:00:00.000Z", waitUntil: "2026-09-21T12:01:00.000Z" })]);
    const waiter = createFallbackWaiter({ home, log });
    const { paseo, sent } = fakeAgents();
    await waiter.ensureArmed(paseo);
    await vi.advanceTimersByTimeAsync(0);
    expect(sent[0]).toEqual({ id: "wrk-1", text: RESUME_NOTICE });
  });

  it("leaves pending, resumed and other incidents alone", async () => {
    write([incident(), incident({ id: "fb-0000000000bb", status: "resumed", waitUntil: "2026-09-21T12:01:00.000Z" })]);
    const waiter = createFallbackWaiter({ home, log });
    await waiter.ensureArmed(fakeAgents().paseo);
    expect(vi.getTimerCount()).toBe(0);
  });
});
