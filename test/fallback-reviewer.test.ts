import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearBindingCache, createBindingStore } from "../plugin/server/agent-bindings";
import { binderOf } from "../plugin/server/agent-tools";
import { createAlertStore } from "../plugin/server/alert-store";
import { createReviewerResend, createReviewerSwitch, linkReplacementReviewer, replacedReviewerLine, reviewerInstructions } from "../plugin/server/fallback-reviewer";
import { checkOffToolReviewer } from "../plugin/server/off-tool-reviewer";
import { clearRequestRegistryCache, createRequestRegistry } from "../plugin/server/request-registry";
import { applyAgentTools, type AgentCreateRequest } from "../plugin/server/role-hook";
import { reviewCallsOf } from "../plugin/server/traces";
import { reviewerBriefLineOf } from "../plugin/shared/notices";
import { PLUGIN_VERSION } from "../plugin/shared/version";
import { msg, turn } from "./fixtures/orchestrator-traces";
import { fallbackNotice, handleFallbackAct } from "../plugin/server/fallback-rpc";
import { ROLE_FALLBACK_STATE_FILE } from "../plugin/server/fallback-state";
import { forgetModes } from "../plugin/server/role-mode";
import type { FallbackIncident } from "../plugin/shared/contracts";
import { fakePaseo, type FakeCreateRequest } from "./helpers/fake-paseo";

/**
 * Delta 20260921 §4.5.1 (REQ-066 b): a stopped Reviewer is replaced by its
 * Worker. The plugin creates no agent; it sends the Worker the exact
 * create_agent call, links the new Reviewer when it appears, and can resend
 * the instructions if the notice queue lost them. Fake daemon, temporary home.
 */

const OLD = "rev-1";
const NEW = "rev-2";
const WORKER = "wrk-1";
const MANAGER = "mgr-1";

const CANDIDATE = { position: 1, alias: "bm-reviewer-fallback-1", baseProvider: "codex", model: "gpt-5.6-sol", thinkingOptionId: "high", modeId: null };

const incident = (overrides: Partial<FallbackIncident> = {}): FallbackIncident => ({
  id: "fb-0000000000ee",
  role: "reviewer",
  workspaceId: "wks_1",
  requestId: "req-20260922T050000Z",
  agentId: OLD,
  agentProvider: "bm-reviewer/claude-opus-5",
  agentModel: "claude-opus-5",
  parentId: WORKER,
  managerId: MANAGER,
  class: "L1",
  signal: "failed",
  message: "usage limit",
  perModelWindow: false,
  resetsAt: null,
  candidate: CANDIDATE,
  status: "pending",
  detectedAt: "2026-09-22T05:00:00.000Z",
  decidedAt: null,
  waitUntil: null,
  replacementId: null,
  error: null,
  ...overrides,
});

const MODES: Record<string, unknown[]> = {
  "bm-reviewer-fallback-1": [
    { id: "auto", label: "Auto", colorTier: "moderate" },
    { id: "full-access", label: "Full access", colorTier: "dangerous" },
  ],
  "bm-reviewer-fallback-2": [],
};

/** A daemon holding these agents, with Claude, Codex and Pi and the Reviewer's chain configured. */
function daemon(snapshots: Record<string, object> = {}) {
  const fake = fakePaseo({
    agents: Object.entries(snapshots).map(([id, snapshot]) => ({ ...snapshot, id })),
    providers: { available: ["claude", "codex", "pi"], modes: MODES },
    config: { providers: { "bm-reviewer": { extends: "claude" }, "bm-reviewer-fallback-1": { extends: "codex" } } },
  });
  return { paseo: fake.paseo, create: fake.api.agents.create };
}

let root: string;
let home: string;
const log = vi.fn();
const read = (): FallbackIncident[] => JSON.parse(readFileSync(join(home, ROLE_FALLBACK_STATE_FILE), "utf8")).incidents;
const write = (incidents: FallbackIncident[]) => writeFileSync(join(home, ROLE_FALLBACK_STATE_FILE), JSON.stringify({ version: 1, incidents }));
const NOW = () => new Date("2026-09-22T05:05:00.000Z");

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "bm-fallback-reviewer-"));
  home = join(root, ".paseo-bm");
  mkdirSync(home);
  log.mockReset();
  forgetModes();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("the instructions to the Worker", () => {
  it("name the exact create_agent call, word for word", () => {
    expect(reviewerInstructions(incident(), "auto", "high")).toBe(
      [
        "The user chose to replace Reviewer rev-1. Create the new Reviewer now with create_agent:",
        "provider `bm-reviewer-fallback-1/gpt-5.6-sol`, settings.modeId `auto`,",
        "settings.thinkingOptionId `high`, and the labels you give any Reviewer plus `bm.replaces` = `rev-1`.",
        "Send it, unchanged, the message you sent rev-1. This is the same review call, not a new one.",
      ].join("\n"),
    );
  });

  it("say not to pass a mode for a provider without modes, and leave out an unset thinking level", () => {
    const text = reviewerInstructions(incident(), null, null);
    expect(text).toContain("\nprovider `bm-reviewer-fallback-1/gpt-5.6-sol`, do not pass settings.modeId,\n");
    expect(text).toContain("\nand the labels you give any Reviewer plus `bm.replaces` = `rev-1`.\n");
    expect(text).not.toContain("thinkingOptionId");
  });
});

describe("Switch for a Reviewer", () => {
  it("creates no agent: records switched and sends the Worker its BM-FALLBACK with the instructions; the Manager is sent nothing", async () => {
    write([incident()]);
    const { paseo, create } = daemon();
    const enqueue = vi.fn<(target: string, kind: string, text: string) => Promise<"sent">>(async () => "sent");
    const reviewerSwitch = createReviewerSwitch({ log, enqueue });
    const { incident: after } = await handleFallbackAct({ incidentId: "fb-0000000000ee", action: "switch" }, paseo, {
      home,
      log,
      now: NOW,
      actions: { switch: reviewerSwitch },
    });
    expect(create).not.toHaveBeenCalled();
    expect(after).toMatchObject({ status: "switched", replacementId: null, decidedAt: "2026-09-22T05:05:00.000Z" });
    expect(enqueue.mock.calls.map((call) => call[0])).toEqual([WORKER]);
    const toWorker = enqueue.mock.calls[0]![2];
    expect(toWorker).toBe(
      fallbackNotice({ ...incident(), status: "switched", decidedAt: "2026-09-22T05:05:00.000Z" }, (alias) => (alias === "bm-reviewer" ? "claude" : null), reviewerInstructions(incident(), "auto", "high")),
    );
    expect(toWorker).toContain("\nstatus: switched\n");
    expect(toWorker).toContain("\nreplacement: none\n");
    expect(enqueue.mock.calls.some((call) => call[0] === MANAGER)).toBe(false);
  });

  it("tells the Worker not to pass a mode when the candidate's provider has none", async () => {
    const pi = { ...CANDIDATE, alias: "bm-reviewer-fallback-2", baseProvider: "pi", model: "pi-default", thinkingOptionId: null, position: 2 };
    write([incident({ candidate: pi })]);
    const enqueue = vi.fn<(target: string, kind: string, text: string) => Promise<"sent">>(async () => "sent");
    await createReviewerSwitch({ log, enqueue })(incident({ candidate: pi }), daemon().paseo, { home, now: NOW });
    expect(enqueue.mock.calls[0]![2]).toContain("provider `bm-reviewer-fallback-2/pi-default`, do not pass settings.modeId,");
  });

  it("refuses without a candidate or a known Worker, leaving the incident pending", async () => {
    write([incident({ candidate: null }), incident({ id: "fb-0000000000ef", parentId: null })]);
    const action = createReviewerSwitch({ log, enqueue: async () => "sent" });
    await expect(action(incident({ candidate: null }), daemon().paseo, { home })).rejects.toMatchObject({ code: "E_FALLBACK_NO_CANDIDATE" });
    await expect(action(incident({ id: "fb-0000000000ef", parentId: null }), daemon().paseo, { home })).rejects.toMatchObject({ code: "E_FALLBACK_CREATE_FAILED" });
    expect(read().map((entry) => entry.status)).toEqual(["pending", "pending"]);
  });
});

describe("the replacement Reviewer", () => {
  /** The replacement as its Worker creates it: same workspace, child of the Worker, same request. */
  const replacement = (overrides: { workspaceId?: string; labels?: Record<string, string> } = {}) => ({
    id: NEW,
    workspaceId: overrides.workspaceId ?? "wks_1",
    labels: { "bm.role": "reviewer", "bm.replaces": OLD, "paseo.parent-agent-id": WORKER, "bm.requestId": "req-20260922T050000Z", ...overrides.labels },
  });

  it("completes the incident when a Reviewer with bm.replaces appears, and labels the old one", async () => {
    write([incident({ status: "switched" })]);
    const { paseo } = daemon({ [NEW]: replacement() });
    const setLabels = vi.fn(async () => ({ ok: true as const }));
    const linked = await linkReplacementReviewer(NEW, "bm-reviewer-fallback-1/gpt-5.6-sol", paseo, { home, log, setLabels });
    expect(linked).toMatchObject({ replacementId: NEW });
    expect(read()[0]).toMatchObject({ status: "switched", replacementId: NEW });
    expect(setLabels).toHaveBeenCalledWith(OLD, { "bm.replacedBy": NEW });
  });

  it("ignores any other new agent: no label, not a Reviewer, or no switched incident for it", async () => {
    write([incident({ status: "switched" })]);
    const setLabels = vi.fn(async () => ({ ok: true as const }));
    const noLabel = daemon({ [NEW]: { id: NEW, labels: { "bm.role": "reviewer" } } });
    expect(await linkReplacementReviewer(NEW, "bm-reviewer", noLabel.paseo, { home, log, setLabels })).toBeNull();
    expect(await linkReplacementReviewer(NEW, "bm-worker", daemon({ [NEW]: { labels: { "bm.replaces": OLD } } }).paseo, { home, log, setLabels })).toBeNull();
    const other = daemon({ [NEW]: replacement({ labels: { "bm.replaces": "rev-9" } }) });
    expect(await linkReplacementReviewer(NEW, "bm-reviewer", other.paseo, { home, log, setLabels })).toBeNull();
    expect(setLabels).not.toHaveBeenCalled();
    expect(read()[0]!.replacementId).toBeNull();
  });

  it.each([
    ["another workspace", replacement({ workspaceId: "wks_other" })],
    ["another Worker's child", replacement({ labels: { "paseo.parent-agent-id": "wrk-9" } })],
    ["a Reviewer with no parent", { id: NEW, workspaceId: "wks_1", labels: { "bm.role": "reviewer", "bm.replaces": OLD } }],
    ["another request", replacement({ labels: { "bm.requestId": "req-20260922T999999Z" } })],
  ])("never lets a Reviewer of %s claim the incident, even with the right bm.replaces (review b7)", async (_label, snapshot) => {
    write([incident({ status: "switched" })]);
    const setLabels = vi.fn(async () => ({ ok: true as const }));
    expect(await linkReplacementReviewer(NEW, "bm-reviewer", daemon({ [NEW]: snapshot }).paseo, { home, log, setLabels })).toBeNull();
    expect(setLabels).not.toHaveBeenCalled();
    expect(read()[0]!.replacementId).toBeNull();
  });

  it("accepts a replacement without a request label, as long as workspace and Worker match", async () => {
    write([incident({ status: "switched" })]);
    const snapshot = replacement();
    delete (snapshot.labels as Record<string, string>)["bm.requestId"];
    const linked = await linkReplacementReviewer(NEW, "bm-reviewer", daemon({ [NEW]: snapshot }).paseo, { home, log, setLabels: async () => ({ ok: true }) });
    expect(linked).toMatchObject({ replacementId: NEW });
  });
});

describe("Resend to Worker", () => {
  it("sends the same instructions again for a switched Reviewer whose replacement never appeared", async () => {
    write([incident({ status: "switched", decidedAt: "2026-09-22T05:05:00.000Z" })]);
    const enqueue = vi.fn<(target: string, kind: string, text: string) => Promise<"sent">>(async () => "sent");
    const resend = createReviewerResend({ log, enqueue });
    const { incident: after } = await handleFallbackAct({ incidentId: "fb-0000000000ee", action: "resend" }, daemon().paseo, { home, log, actions: { resend } });
    expect(after.status).toBe("switched");
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue.mock.calls[0]![0]).toBe(WORKER);
    expect(enqueue.mock.calls[0]![2]).toContain("The user chose to replace Reviewer rev-1.");
  });

  it("is refused once the replacement exists, or for an incident that was never switched", async () => {
    write([incident({ status: "switched", replacementId: NEW }), incident({ id: "fb-0000000000ef" })]);
    const resend = createReviewerResend({ log, enqueue: async () => "sent" });
    for (const id of ["fb-0000000000ee", "fb-0000000000ef"]) {
      await expect(handleFallbackAct({ incidentId: id, action: "resend" }, daemon().paseo, { home, log, actions: { resend } })).rejects.toMatchObject({
        code: "E_FALLBACK_NOT_PENDING",
      });
    }
  });
});

// ---------------------------------------------------------------------------
// Design §16.9: a bound Worker's replacement Reviewer, created by the plugin.
// ---------------------------------------------------------------------------

describe("Switch for a bound Worker's Reviewer (design §16.9)", () => {
  const REQ = "req-20260922T050000Z";
  const CALL = "out-0000000000c1";
  const BRIEF = "Review batch b1 of request req-20260922T050000Z.\nstages: implementation\nscope:\nsrc/date.ts";
  const ROLE_URL = (role: string) => `http://127.0.0.1:4567/mcp/${role}`;

  afterEach(() => {
    clearBindingCache();
    clearRequestRegistryCache();
  });

  /** The Worker bound with the creation tools, and the batch its Reviewer `OLD` was created for. */
  function boundWorld(options: { bindWorker?: boolean } = {}) {
    const store = createBindingStore(home);
    if (options.bindWorker !== false) {
      const { token, tokenSha256 } = store.issue({ role: "worker", workspaceId: "wks_1", requestId: REQ, parentId: MANAGER });
      store.attach(token, "worker");
      store.settle(tokenSha256, WORKER);
    }
    const registry = createRequestRegistry(home, { backfill: () => [] });
    registry.register("wks_1", REQ, { source: "tool", managerId: MANAGER, workerId: WORKER });
    registry.addReviewCall("wks_1", REQ, "b1", { callId: CALL, kind: "create", reviewerId: "", at: "2026-09-22T04:50:00.000Z" }, BRIEF);
    registry.noteReviewer("wks_1", REQ, "b1", OLD, CALL);
    const fake = fakePaseo({
      agents: [
        { id: WORKER, provider: "bm-worker/claude-opus-5", status: "idle", workspaceId: "wks_1", cwd: "/repo", labels: { "bm.role": "worker", "bm.requestId": REQ, "paseo.parent-agent-id": MANAGER } },
        { id: OLD, provider: "bm-reviewer/claude-opus-5", status: "idle", workspaceId: "wks_1", labels: { "bm.role": "reviewer", "bm.requestId": REQ, "bm.batchId": "b1", "paseo.parent-agent-id": WORKER } },
      ],
      workspaces: [{ id: "wks_1", directory: "/repo" }],
      providers: { available: ["claude", "codex", "pi"], modes: MODES },
      config: { providers: { "bm-reviewer": { extends: "claude" }, "bm-reviewer-fallback-1": { extends: "codex" } } },
      created: (request: FakeCreateRequest) => {
        applyAgentTools({ config: { ...request.config, cwd: request.cwd } } as unknown as AgentCreateRequest, { urlFor: ROLE_URL, bindings: store }, "codex");
        return {};
      },
    });
    const enqueue = vi.fn<(target: string, kind: string, text: string) => Promise<"sent">>(async () => "sent");
    const setLabels = vi.fn(async () => ({ ok: true as const }));
    const reviewerSwitch = createReviewerSwitch({ log, enqueue, setLabels, bindings: () => store, binder: binderOf(ROLE_URL, store, () => {}) });
    return { store, fake, enqueue, setLabels, reviewerSwitch };
  }

  it("creates the replacement itself from the stored brief, bound for the same batch, its first line carrying the replaced call; the Worker is informed", async () => {
    write([incident()]);
    const { store, fake, enqueue, setLabels, reviewerSwitch } = boundWorld();
    const { incident: after } = await handleFallbackAct({ incidentId: "fb-0000000000ee", action: "switch" }, fake.paseo, { home, log, now: NOW, actions: { switch: reviewerSwitch } });

    expect(fake.creates).toHaveLength(1);
    const { options } = fake.creates[0]!;
    expect(options).toMatchObject({
      config: { provider: "bm-reviewer-fallback-1/gpt-5.6-sol", modeId: "auto", thinkingOptionId: "high" },
      cwd: "/repo",
      parent: WORKER,
      labels: { "bm.role": "reviewer", "bm.requestId": REQ, "bm.batchId": "b1", "bm.version": PLUGIN_VERSION, "bm.replaces": OLD },
    });
    expect(options.prompt).toBe(`${reviewerBriefLineOf(REQ, "b1", CALL)}\n${BRIEF}`);
    expect(store.bindingOfAgent("created-1")).toMatchObject({ role: "reviewer", state: "bound", requestId: REQ, batchId: "b1", parentId: WORKER });
    expect(after).toMatchObject({ status: "switched", replacementId: "created-1", decidedAt: "2026-09-22T05:05:00.000Z" });
    expect(setLabels).toHaveBeenCalledWith(OLD, { "bm.replacedBy": "created-1" });
    expect(createRequestRegistry(home).get("wks_1", REQ)!.reviews.batches[0]).toMatchObject({ reviewerIds: [OLD, "created-1"], calls: [{ callId: CALL }] });

    // The Worker: an informational BM-FALLBACK, no recipe.
    expect(enqueue.mock.calls.map((call) => call[0])).toEqual([WORKER]);
    const toWorker = enqueue.mock.calls[0]![2];
    expect(toWorker.startsWith("BM-FALLBACK")).toBe(true);
    expect(toWorker).toContain(replacedReviewerLine(OLD, "created-1", "b1"));
    expect(toWorker).toContain("Reviewer rev-1 was replaced by created-1 for batch b1; its review reaches you as before.");
    expect(toWorker).not.toContain("create_agent");

    // Counted once: the replaced call's id is the replacement's first line.
    const records = [
      turn({ agentId: OLD, role: "reviewer", sent: [msg(OLD, "2026-09-22T04:51:00.000Z", `${reviewerBriefLineOf(REQ, "b1", CALL)}\n${BRIEF}`)] }),
      turn({ agentId: "created-1", role: "reviewer", sent: [msg("created-1", "2026-09-22T05:06:00.000Z", options.prompt!)] }),
    ];
    expect(reviewCallsOf([OLD, "created-1"], records, [], [{ callId: CALL }])).toBe(1);

    // Never off-tool: the plugin's own creation.
    const deps = { home, bindings: store, log: () => {} };
    expect(await checkOffToolReviewer({ id: "created-1", provider: "bm-reviewer-fallback-1/gpt-5.6-sol", parentAgentId: WORKER, workspaceId: "wks_1" }, fake.paseo, deps)).toBeNull();
    expect(createAlertStore(home).list({ open: true })).toEqual([]);
  });

  it("an unbound Worker keeps the recipe: no agent created", async () => {
    write([incident()]);
    const { fake, enqueue, reviewerSwitch } = boundWorld({ bindWorker: false });
    const { incident: after } = await handleFallbackAct({ incidentId: "fb-0000000000ee", action: "switch" }, fake.paseo, { home, log, now: NOW, actions: { switch: reviewerSwitch } });
    expect(fake.creates).toEqual([]);
    expect(after).toMatchObject({ status: "switched", replacementId: null });
    expect(enqueue.mock.calls[0]![2]).toContain("Create the new Reviewer now with create_agent:");
  });

  it("a creation Paseo refuses records the incident failed: a second click never creates two", async () => {
    write([incident()]);
    const { fake, reviewerSwitch } = boundWorld();
    fake.api.agents.create.mockRejectedValueOnce(new Error("provider refused"));
    await expect(handleFallbackAct({ incidentId: "fb-0000000000ee", action: "switch" }, fake.paseo, { home, log, now: NOW, actions: { switch: reviewerSwitch } })).rejects.toThrow("provider refused");
    expect(read()[0]).toMatchObject({ status: "failed", replacementId: null });
  });
});
