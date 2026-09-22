import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createReviewerResend, createReviewerSwitch, linkReplacementReviewer, reviewerInstructions } from "../plugin/server/fallback-reviewer";
import { fallbackNotice, handleFallbackAct } from "../plugin/server/fallback-rpc";
import { ROLE_FALLBACK_STATE_FILE } from "../plugin/server/fallback-state";
import { forgetModes } from "../plugin/server/role-mode";
import { fallbackButtons } from "../plugin/client/chat-cards";
import type { FallbackIncident } from "../plugin/shared/contracts";

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

function fakeDaemon(snapshots: Record<string, unknown> = {}) {
  const create = vi.fn();
  const paseo = {
    agents: { create, ref: (id: string) => ({ refresh: async () => ({ agent: snapshots[id] ?? null }) }) },
    providers: {
      listAvailable: async () => ({ providers: ["claude", "codex", "pi"].map((provider) => ({ provider, available: true })) }),
      listModes: async (provider: string) => ({ provider, modes: MODES[provider] ?? [], error: null }),
    },
    config: { get: async () => ({ config: { providers: { "bm-reviewer": { extends: "claude" }, "bm-reviewer-fallback-1": { extends: "codex" } } } }) },
  };
  return { paseo, create };
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
  it("creates no agent: records switched and sends the Worker its BM-FALLBACK with the instructions; the Manager chat gets the card", async () => {
    write([incident()]);
    const { paseo, create } = fakeDaemon();
    const enqueue = vi.fn<(target: string, kind: string, text: string) => Promise<"sent">>(async () => "sent");
    const reviewerSwitch = createReviewerSwitch({ log, enqueue });
    const { incident: after } = await handleFallbackAct({ incidentId: "fb-0000000000ee", action: "switch" }, paseo, {
      home,
      log,
      now: NOW,
      enqueue,
      actions: { switch: reviewerSwitch },
    });
    expect(create).not.toHaveBeenCalled();
    expect(after).toMatchObject({ status: "switched", replacementId: null, decidedAt: "2026-09-22T05:05:00.000Z" });
    expect(enqueue.mock.calls.map((call) => call[0])).toEqual([WORKER, MANAGER]);
    const toWorker = enqueue.mock.calls[0]![2];
    expect(toWorker).toBe(
      fallbackNotice({ ...incident(), status: "switched", decidedAt: "2026-09-22T05:05:00.000Z" }, (alias) => (alias === "bm-reviewer" ? "claude" : null), reviewerInstructions(incident(), "auto", "high")),
    );
    expect(toWorker).toContain("\nstatus: switched\n");
    expect(toWorker).toContain("\nreplacement: none\n");
    expect(enqueue.mock.calls[1]![2]).toContain("do not create an agent yourself");
  });

  it("tells the Worker not to pass a mode when the candidate's provider has none", async () => {
    const pi = { ...CANDIDATE, alias: "bm-reviewer-fallback-2", baseProvider: "pi", model: "pi-default", thinkingOptionId: null, position: 2 };
    write([incident({ candidate: pi })]);
    const enqueue = vi.fn<(target: string, kind: string, text: string) => Promise<"sent">>(async () => "sent");
    await createReviewerSwitch({ log, enqueue })(incident({ candidate: pi }), fakeDaemon().paseo, { home, now: NOW });
    expect(enqueue.mock.calls[0]![2]).toContain("provider `bm-reviewer-fallback-2/pi-default`, do not pass settings.modeId,");
  });

  it("refuses without a candidate or a known Worker, leaving the incident pending", async () => {
    write([incident({ candidate: null }), incident({ id: "fb-0000000000ef", parentId: null })]);
    const action = createReviewerSwitch({ log, enqueue: async () => "sent" });
    await expect(action(incident({ candidate: null }), fakeDaemon().paseo, { home })).rejects.toMatchObject({ code: "E_FALLBACK_NO_CANDIDATE" });
    await expect(action(incident({ id: "fb-0000000000ef", parentId: null }), fakeDaemon().paseo, { home })).rejects.toMatchObject({ code: "E_FALLBACK_CREATE_FAILED" });
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
    const { paseo } = fakeDaemon({ [NEW]: replacement() });
    const setLabels = vi.fn(async () => ({ ok: true as const }));
    const linked = await linkReplacementReviewer(NEW, "bm-reviewer-fallback-1/gpt-5.6-sol", paseo, { home, log, setLabels });
    expect(linked).toMatchObject({ replacementId: NEW });
    expect(read()[0]).toMatchObject({ status: "switched", replacementId: NEW });
    expect(setLabels).toHaveBeenCalledWith(OLD, { "bm.replacedBy": NEW });
  });

  it("ignores any other new agent: no label, not a Reviewer, or no switched incident for it", async () => {
    write([incident({ status: "switched" })]);
    const setLabels = vi.fn(async () => ({ ok: true as const }));
    const noLabel = fakeDaemon({ [NEW]: { id: NEW, labels: { "bm.role": "reviewer" } } });
    expect(await linkReplacementReviewer(NEW, "bm-reviewer", noLabel.paseo, { home, log, setLabels })).toBeNull();
    expect(await linkReplacementReviewer(NEW, "bm-worker", fakeDaemon({ [NEW]: { labels: { "bm.replaces": OLD } } }).paseo, { home, log, setLabels })).toBeNull();
    const other = fakeDaemon({ [NEW]: replacement({ labels: { "bm.replaces": "rev-9" } }) });
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
    expect(await linkReplacementReviewer(NEW, "bm-reviewer", fakeDaemon({ [NEW]: snapshot }).paseo, { home, log, setLabels })).toBeNull();
    expect(setLabels).not.toHaveBeenCalled();
    expect(read()[0]!.replacementId).toBeNull();
  });

  it("accepts a replacement without a request label, as long as workspace and Worker match", async () => {
    write([incident({ status: "switched" })]);
    const snapshot = replacement();
    delete (snapshot.labels as Record<string, string>)["bm.requestId"];
    const linked = await linkReplacementReviewer(NEW, "bm-reviewer", fakeDaemon({ [NEW]: snapshot }).paseo, { home, log, setLabels: async () => ({ ok: true }) });
    expect(linked).toMatchObject({ replacementId: NEW });
  });
});

describe("Resend to Worker", () => {
  it("sends the same instructions again for a switched Reviewer whose replacement never appeared", async () => {
    write([incident({ status: "switched", decidedAt: "2026-09-22T05:05:00.000Z" })]);
    const enqueue = vi.fn<(target: string, kind: string, text: string) => Promise<"sent">>(async () => "sent");
    const resend = createReviewerResend({ log, enqueue });
    const { incident: after } = await handleFallbackAct({ incidentId: "fb-0000000000ee", action: "resend" }, fakeDaemon().paseo, { home, log, enqueue, actions: { resend } });
    expect(after.status).toBe("switched");
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue.mock.calls[0]![0]).toBe(WORKER);
    expect(enqueue.mock.calls[0]![2]).toContain("The user chose to replace Reviewer rev-1.");
  });

  it("is refused once the replacement exists, or for an incident that was never switched", async () => {
    write([incident({ status: "switched", replacementId: NEW }), incident({ id: "fb-0000000000ef" })]);
    const resend = createReviewerResend({ log, enqueue: async () => "sent" });
    for (const id of ["fb-0000000000ee", "fb-0000000000ef"]) {
      await expect(handleFallbackAct({ incidentId: id, action: "resend" }, fakeDaemon().paseo, { home, log, actions: { resend } })).rejects.toMatchObject({
        code: "E_FALLBACK_NOT_PENDING",
      });
    }
  });

  it("is the one button the card shows in that state", () => {
    const now = new Date("2026-09-22T05:10:00.000Z");
    expect(fallbackButtons(incident({ status: "switched" }), now, null)).toEqual([{ action: "resend", label: "Resend to Worker" }]);
    expect(fallbackButtons(incident({ status: "switched", replacementId: NEW }), now, null)).toEqual([]);
    expect(fallbackButtons(incident({ role: "worker", status: "switched" }), now, null)).toEqual([]);
  });
});
