import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearBindingCache, createBindingStore, type BindingStore } from "../plugin/server/agent-bindings";
import { binderOf } from "../plugin/server/agent-tools";
import { createAlertStore } from "../plugin/server/alert-store";
import type { BmEvent } from "../plugin/server/event-bus";
import {
  OFF_TOOL_CANCEL_WAITS_MS,
  cancelOffToolReviewer,
  checkOffToolReviewer,
  clearOffToolAlert,
  clearOffToolAlertsOfRequest,
  offToolReviewerOf,
  type OffToolReviewer,
} from "../plugin/server/off-tool-reviewer";
import type { CancelResult } from "../plugin/server/paseo-cli";
import { clearRequestRegistryCache } from "../plugin/server/request-registry";
import { clearPluginReviewers, createPluginReviewer, type ReviewerCreationPaseo } from "../plugin/server/review-tools";
import { applyAgentTools, type AgentCreateRequest } from "../plugin/server/role-hook";
import { reconstructTraces, type AgentFacts } from "../plugin/server/traces";
import { alertKeyOf } from "../plugin/shared/alerts";
import { fakePaseo, type FakeCreateRequest } from "./helpers/fake-paseo";
import { msg, turn } from "./fixtures/orchestrator-traces";

/**
 * Off-tool Reviewers (design §16.8; ADR-027 decision 10): a Reviewer a bound
 * Worker creates with Paseo's create_agent is counted, raises the
 * `off-tool-reviewer` Inbox alert and an `off-tool-review` worker.signal, and
 * is cancelled at once through the Paseo CLI (spike S5, bead .16:
 * `cancelOffToolReviewer`, here with a fake cancel); the plugin's own
 * Reviewers, and one an unbound Worker creates, raise neither.
 */

const WS = "wks_1";
const REQ = "req-20261003T100000Z";
const MANAGER = "agent-manager";
const WORKER = "agent-worker";
const HAND_WORKER = "agent-hand-worker";
const ROLE_URL = (role: string) => `http://127.0.0.1:4567/mcp/${role}`;
const T0 = new Date("2026-10-03T10:00:00.000Z");
const roots: string[] = [];

afterEach(() => {
  clearBindingCache();
  clearRequestRegistryCache();
  clearPluginReviewers();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function dataFolder(): string {
  const root = mkdtempSync(join(tmpdir(), "bm-off-tool-"));
  roots.push(root);
  const home = join(root, ".paseo-bm");
  mkdirSync(home);
  return home;
}

function bindWorker(store: BindingStore, agentId: string, creationTools = true): void {
  const { token, tokenSha256 } = store.issue({ role: "worker", workspaceId: WS, requestId: REQ, parentId: MANAGER, creationTools });
  store.attach(token, "worker");
  store.settle(tokenSha256, agentId);
}

function setup() {
  const home = dataFolder();
  const store = createBindingStore(home);
  bindWorker(store, WORKER);
  const published: BmEvent[][] = [];
  const cancelled: OffToolReviewer[] = [];
  const deps = {
    home,
    bindings: store,
    publish: async (events: readonly BmEvent[]) => {
      published.push([...events]);
    },
    cancel: async (finding: OffToolReviewer) => {
      cancelled.push(finding);
    },
    now: () => T0,
    log: () => {},
  };
  return { home, store, deps, published, cancelled };
}

const created = (id: string, parentAgentId: string | null, provider = "bm-reviewer/gpt-5.6") => ({ id, provider, parentAgentId, workspaceId: WS });

describe("the off-tool decision (design §16.8)", () => {
  it("a Reviewer whose parent is a Worker bound with the creation tools, and which the plugin did not create, is off-tool", () => {
    const { store } = setup();
    bindWorker(store, HAND_WORKER, false);
    const bindings = store.list();
    expect(offToolReviewerOf(created("rev-1", WORKER), bindings, () => false)).toEqual({ reviewerId: "rev-1", workerId: WORKER, workspaceId: WS, requestId: REQ });
    // A fallback alias runs the role in its name.
    expect(offToolReviewerOf(created("rev-1", WORKER, "bm-reviewer-fallback-1/claude-sonnet-5"), bindings, () => false)).not.toBeNull();
    // The plugin's own: created by createPluginReviewer, or with a binding of its own.
    expect(offToolReviewerOf(created("rev-1", WORKER), bindings, (id) => id === "rev-1")).toBeNull();
    // A Worker bound before the creation tools, an unbound Worker, no parent, not a Reviewer.
    expect(offToolReviewerOf(created("rev-1", HAND_WORKER), bindings, () => false)).toBeNull();
    expect(offToolReviewerOf(created("rev-1", "agent-nobody"), bindings, () => false)).toBeNull();
    expect(offToolReviewerOf(created("rev-1", null), bindings, () => false)).toBeNull();
    expect(offToolReviewerOf(created("wrk-9", WORKER, "bm-worker/claude-opus-5"), bindings, () => false)).toBeNull();
  });
});

describe("an off-tool Reviewer (design §16.8)", () => {
  it("raises the off-tool-reviewer alert naming Worker, request and Reviewer, the off-tool-review signal, and goes to the cancel hook", async () => {
    const { home, deps, published, cancelled } = setup();
    const finding = await checkOffToolReviewer(created("rev-1", WORKER), null, deps);
    expect(finding).toEqual({ reviewerId: "rev-1", workerId: WORKER, workspaceId: WS, requestId: REQ });

    const key = alertKeyOf("off-tool-reviewer", WS, "rev-1");
    const [alert] = createAlertStore(home).list({ open: true });
    expect(alert).toMatchObject({ key, kind: "off-tool-reviewer", subject: "rev-1", workspaceId: WS });
    expect(alert!.detail).toContain(WORKER);
    expect(alert!.detail).toContain(REQ);
    expect(alert!.detail).toContain("rev-1");

    expect(published).toEqual([
      [{ type: "worker.signal", workspaceId: WS, workerId: WORKER, requestKey: REQ, signal: "off-tool-review", turnStart: T0.toISOString(), alertKey: key, since: T0.toISOString() }],
    ]);
    expect(cancelled).toEqual([finding]);

    // Raised once while open: a second sight publishes nothing more.
    await checkOffToolReviewer(created("rev-1", WORKER), null, deps);
    expect(published).toHaveLength(1);
    // Archiving the Reviewer clears it.
    expect(clearOffToolAlert(home, "rev-1")).toEqual([key]);
  });

  it("its alert also clears when its request ends (finished or stopped, from bm_report): only that request's, in that workspace", async () => {
    const { home, deps } = setup();
    await checkOffToolReviewer(created("rev-1", WORKER), null, deps);
    expect(clearOffToolAlertsOfRequest(home, "wks_other", REQ)).toEqual([]);
    expect(clearOffToolAlertsOfRequest(home, WS, "req-20261003T110000Z")).toEqual([]);
    expect(clearOffToolAlertsOfRequest(null, WS, REQ)).toEqual([]);
    expect(clearOffToolAlertsOfRequest(home, WS, REQ)).toEqual([alertKeyOf("off-tool-reviewer", WS, "rev-1")]);
    expect(createAlertStore(home).list({ open: true })).toEqual([]);
  });

  it("is counted through the activity stream: its parent is one of the request's Workers", () => {
    const facts = (id: string, role: AgentFacts["role"], parentAgentId: string | null, requestIdLabel: string | null): AgentFacts => ({
      id,
      role,
      status: "idle",
      parentAgentId,
      createdAt: "2026-10-03T10:01:00.000Z",
      requestIdLabel,
      batchIdLabel: null,
      archived: false,
    });
    const records = [
      turn({ agentId: MANAGER, role: "manager", workspaceId: WS, requestId: REQ, at: "2026-10-03T10:00:00.000Z", sent: [msg(MANAGER, "2026-10-03T10:00:00.000Z", "Fix the dates.", "user")] }),
      turn({ agentId: "rev-off", role: "reviewer", workspaceId: WS, at: "2026-10-03T10:05:00.000Z", sent: [msg("rev-off", "2026-10-03T10:05:00.000Z", "Review my diff, please.", "agent")] }),
    ];
    // The off-tool Reviewer carries no request label; its Worker none either: the registry's workerIds link it.
    const agents = [facts(WORKER, "worker", MANAGER, REQ), facts("rev-off", "reviewer", "agent-unlabelled-worker", null)];
    const requests = [{ requestId: REQ, workerIds: [WORKER, "agent-unlabelled-worker"], reviews: { batches: [{ calls: [{ callId: "out-000000000001" }] }] } }];
    const trace = reconstructTraces({ records, agents, requests }).find((entry) => entry.requestId === REQ)!;
    expect(trace.reviewerIds).toContain("rev-off");
    // The tool call and the off-tool Reviewer's prompt.
    expect(trace.reviewCalls).toBe(2);
  });

  it("a Reviewer created by the plugin raises neither, even when agent.created comes before its id is known", async () => {
    const { home, store, deps, published, cancelled } = setup();
    let sight: Promise<OffToolReviewer | null> | null = null;
    const fake = fakePaseo({
      config: { providers: { "bm-reviewer": { extends: "codex" } } },
      created: (request: FakeCreateRequest, { n }) => {
        applyAgentTools({ config: { ...request.config, cwd: request.cwd } } as unknown as AgentCreateRequest, { urlFor: ROLE_URL, bindings: store }, "codex");
        // Paseo's agent.created, while agents.create has not returned yet.
        sight = checkOffToolReviewer(created(`created-${n}`, WORKER), null, deps);
        return {};
      },
    });
    const { reviewerId } = await createPluginReviewer(
      fake.paseo as unknown as ReviewerCreationPaseo,
      { workspaceId: WS, requestId: REQ, workerId: WORKER, batchId: "b1", cwd: "/repo", prompt: "BM-BRIEF reviewer …", alias: "bm-reviewer", model: "gpt-5.6", base: "codex" },
      { binder: binderOf(ROLE_URL, store, () => {}), log: () => {} },
    );
    expect(reviewerId).toBe("created-1");
    expect(await sight).toBeNull();
    // Seen again afterwards (a replay): still its own.
    expect(await checkOffToolReviewer(created("created-1", WORKER), null, deps)).toBeNull();
    expect(createAlertStore(home).list({ open: true })).toEqual([]);
    expect(published).toEqual([]);
    expect(cancelled).toEqual([]);
  });

  it("a Reviewer an unbound Worker created raises neither", async () => {
    const { home, deps, published } = setup();
    expect(await checkOffToolReviewer(created("rev-2", HAND_WORKER), null, deps)).toBeNull();
    expect(createAlertStore(home).list({ open: true })).toEqual([]);
    expect(published).toEqual([]);
  });
});

describe("cancelling an off-tool Reviewer (design §16.8 step 4, spike S5)", () => {
  const FINDING: OffToolReviewer = { reviewerId: "5ea413fa-1b2c-4d5e-8f90-a1b2c3d4e5f6", workerId: WORKER, workspaceId: WS, requestId: REQ };

  /** A fake cancel answering `answers` in turn (the last one sticks), and the waits it was given. */
  function fakeCancel(...answers: CancelResult[]) {
    const ids: string[] = [];
    const slept: number[] = [];
    const logs: string[] = [];
    const deps = {
      cancel: async (agentId: string) => {
        ids.push(agentId);
        return answers[Math.min(ids.length, answers.length) - 1]!;
      },
      sleep: async (ms: number) => {
        slept.push(ms);
      },
      log: (message: string) => logs.push(message),
    };
    return { deps, ids, slept, logs };
  }

  it("cancels the Reviewer's running turn at once, by its id", async () => {
    const { deps, ids, slept, logs } = fakeCancel({ ok: true, stopped: true });
    expect(await cancelOffToolReviewer(FINDING, deps)).toBe(true);
    expect(ids).toEqual([FINDING.reviewerId]);
    expect(slept).toEqual([]);
    expect(logs).toEqual([`[paseo-bm] cancelled the off-tool Reviewer ${FINDING.reviewerId} of Worker ${WORKER}.`]);
  });

  it("tries again while its first turn has not started, and gives up after the last wait", async () => {
    const started = fakeCancel({ ok: true, stopped: false }, { ok: true, stopped: true });
    expect(await cancelOffToolReviewer(FINDING, started.deps)).toBe(true);
    expect(started.slept).toEqual([OFF_TOOL_CANCEL_WAITS_MS[0]]);

    const never = fakeCancel({ ok: true, stopped: false });
    expect(await cancelOffToolReviewer(FINDING, never.deps)).toBe(false);
    expect(never.ids).toHaveLength(OFF_TOOL_CANCEL_WAITS_MS.length + 1);
    expect(never.slept).toEqual([...OFF_TOOL_CANCEL_WAITS_MS]);
    expect(never.logs).toEqual([`[paseo-bm] the off-tool Reviewer ${FINDING.reviewerId} had no running turn to cancel.`]);
  });

  it("a failed cancel is logged with the Reviewer's id, and the alert stays", async () => {
    const { home, deps } = setup();
    const logs: string[] = [];
    const failing = fakeCancel({ ok: false, reason: "the `paseo` command was not found" });
    const finding = await checkOffToolReviewer(created("rev-1", WORKER), null, {
      ...deps,
      log: (message: string) => logs.push(message),
      cancel: (found: OffToolReviewer) => cancelOffToolReviewer(found, failing.deps),
    });
    expect(finding).not.toBeNull();
    expect(failing.ids).toEqual(["rev-1"]);
    expect(logs).toContain("[paseo-bm] could not cancel the off-tool Reviewer rev-1: the `paseo` command was not found");
    expect(createAlertStore(home).list({ open: true }).map((alert) => alert.subject)).toEqual(["rev-1"]);
  });
});
