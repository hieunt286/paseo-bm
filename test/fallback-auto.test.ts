import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAutonomyStore } from "../plugin/server/autonomy-store";
import { clearDecisionStoreCache, createDecisionStore } from "../plugin/server/decision-store";
import { RECOMMENDED_WAIT_WINDOW_MS, recommendedActionOf } from "../plugin/server/fallback-decisions";
import { decidePending, registerFallbackRpcs, type FallbackAction } from "../plugin/server/fallback-rpc";
import { ROLE_FALLBACK_FILE } from "../plugin/server/fallback-settings";
import { ROLE_FALLBACK_STATE_FILE, recordIncident } from "../plugin/server/fallback-state";
import { createPrecedentStore } from "../plugin/server/precedent-store";
import { noticeQueue } from "../plugin/server/notice-queue";
import type { FallbackIncident } from "../plugin/shared/contracts";
import { fakePaseo } from "./helpers/fake-paseo";

/**
 * ADR-022 decision 4: the fallback chain's Auto switch is retired. A role's
 * policy is Ask me or Off; a file that still stores `auto` reads as Ask me. A
 * new incident becomes the owner's `f:` decision (class `environment`), and it
 * is answered without the owner only by the owner's autonomy policy (the
 * recommended option at open, where `environment` is delegated; the
 * Orchestrator's `bm_decide` is covered in `autonomy-delegation.test.ts`) or
 * by a precedent — then its action runs through `fallback.act`, as a click's
 * would. Nothing is sent to the Manager. Fake daemon, temporary data folder.
 */

const NOW = new Date("2026-09-22T07:00:00.000Z");
const at = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000).toISOString();
const CANDIDATE = { position: 1, alias: "bm-worker-fallback-1", baseProvider: "codex", model: "gpt-5.6-sol", thinkingOptionId: null, modeId: null };
const ID = "fb-000000000a01";

const incident = (overrides: Partial<FallbackIncident> = {}): FallbackIncident => ({
  id: ID,
  role: "worker",
  workspaceId: "wks_1",
  requestId: "req-20260922T070000Z",
  agentId: "wrk-1",
  agentProvider: "bm-worker/claude-opus-5",
  agentModel: "claude-opus-5",
  parentId: "mgr-1",
  managerId: "mgr-1",
  class: "L1",
  signal: "failed",
  message: "usage limit",
  perModelWindow: false,
  resetsAt: null,
  candidate: CANDIDATE,
  status: "pending",
  detectedAt: NOW.toISOString(),
  decidedAt: null,
  waitUntil: null,
  replacementId: null,
  error: null,
  ...overrides,
});

let root: string;
let home: string;
const log = vi.fn();
const read = (): FallbackIncident[] => JSON.parse(readFileSync(join(home, ROLE_FALLBACK_STATE_FILE), "utf8")).incidents;
const decisions = () => createDecisionStore(home).list();

/** Actions that only record their decision, as the real ones do at their last step. */
function actions() {
  const roles: string[] = [];
  const decide = (status: "switched" | "waiting"): FallbackAction =>
    vi.fn(async (current: FallbackIncident, _paseo: unknown, deps: { home?: string | null }) => {
      roles.push(`${status}:${current.role}`);
      return decidePending(deps.home!, current.id, (entry) => ({ ...entry, status, decidedAt: NOW.toISOString() }));
    });
  return { roles, switch: decide("switched"), wait: decide("waiting") };
}

/** The Worker `wrk-1` under its Manager `mgr-1`, on a machine with Claude and Codex. */
const daemon = () =>
  fakePaseo({
    agents: [
      { id: "wrk-1", labels: { "bm.role": "worker", "bm.requestId": "req-20260922T070000Z", "paseo.parent-agent-id": "mgr-1" } },
      { id: "mgr-1", status: "idle" },
    ],
    providers: { available: ["codex", "claude"] },
    config: { providers: { "bm-worker": { extends: "claude" }, "bm-worker-fallback-1": { extends: "codex" } } },
  });

/** A Worker's L2 incident recorded through the plugin's listener, with the chain stored under `policy`. */
async function recordUnder(policy: "ask" | "off" | "auto", acts: ReturnType<typeof actions>) {
  writeFileSync(join(home, ROLE_FALLBACK_FILE), JSON.stringify({ version: 1, roles: { worker: { policy, entries: [CANDIDATE] } } }));
  const remove = registerFallbackRpcs({ handle: vi.fn() } as never, { switch: acts.switch, wait: acts.wait });
  const { paseo, sends } = daemon();
  try {
    await recordIncident(
      { agent: { id: "wrk-1", provider: "bm-worker/claude-opus-5", workspaceId: "wks_1" } },
      { class: "L2", signal: "failed", message: "credit balance too low" },
      { paseo, home, log, now: () => NOW, randomHex: () => "000000000a01" },
    );
  } finally {
    remove();
  }
  return sends;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "bm-fallback-auto-"));
  home = join(root, ".paseo-bm");
  mkdirSync(home);
  log.mockReset();
  clearDecisionStoreCache();
});

afterEach(() => {
  noticeQueue.clear();
  rmSync(root, { recursive: true, force: true });
});

describe("recommendedActionOf (the option an incident's decision recommends)", () => {
  it("waits for a reset at most 30 minutes away, a past one included", () => {
    expect(RECOMMENDED_WAIT_WINDOW_MS).toBe(30 * 60 * 1000);
    expect(recommendedActionOf(incident({ resetsAt: at(30) }), NOW)).toBe("wait");
    expect(recommendedActionOf(incident({ resetsAt: at(5) }), NOW)).toBe("wait");
    expect(recommendedActionOf(incident({ resetsAt: at(-10) }), NOW)).toBe("wait");
    expect(recommendedActionOf(incident({ resetsAt: at(30), candidate: null }), NOW)).toBe("wait");
  });

  it("switches when the reset is further or unknown and there is a candidate, else recommends nothing", () => {
    expect(recommendedActionOf(incident({ resetsAt: at(31) }), NOW)).toBe("switch");
    expect(recommendedActionOf(incident({ resetsAt: null }), NOW)).toBe("switch");
    expect(recommendedActionOf(incident({ resetsAt: at(31), candidate: null }), NOW)).toBeNull();
    expect(recommendedActionOf(incident({ resetsAt: null, candidate: null }), NOW)).toBeNull();
  });
});

describe("a new incident after the Auto switch was retired (ADR-022 decision 4)", () => {
  it.each(["auto", "ask"] as const)("under a stored %s policy, runs no action: it stays pending and opens exactly one environment decision", async (policy) => {
    const acts = actions();
    const sent = await recordUnder(policy, acts);
    expect(acts.roles).toEqual([]);
    expect(read()[0]!.status).toBe("pending");
    const [decision, ...others] = decisions();
    expect(others).toEqual([]);
    expect(decision).toMatchObject({
      id: `f:${ID}`,
      status: "open",
      class: "environment",
      answer: null,
      workspaceId: "wks_1",
      requestId: "req-20260922T070000Z",
      askedBy: { role: "plugin", agentId: null },
    });
    expect(decision!.options.map((option) => [option.key, option.recommended, option.action])).toEqual([
      ["switch", true, { kind: "fallback", action: "switch", target: ID }],
      ["dismiss", false, { kind: "fallback", action: "dismiss", target: ID }],
    ]);
    expect(sent).toEqual([]);
  });

  it("is answered by itself when the owner delegates environment to the recommended option: by policy, run through fallback.act", async () => {
    createAutonomyStore(home).set({ workspaceId: "wks_1", class: "environment", mode: "delegate", confirmed: true, predictor: "recommended" }, new Date().toISOString());
    const acts = actions();
    const sent = await recordUnder("auto", acts);
    await vi.waitFor(() => expect(acts.roles).toEqual(["switched:worker"]));
    expect(read()[0]!.status).toBe("switched");
    await vi.waitFor(() =>
      expect(decisions()).toMatchObject([
        {
          id: `f:${ID}`,
          status: "answered",
          answer: { by: "policy", optionKey: "switch", class: "environment", predictor: "recommended" },
          delivery: { kind: "fallback:switch", outcome: "sent" },
        },
      ]),
    );
    expect(sent).toEqual([]);
  });

  it("is answered by itself when an owner precedent names one of its options: by precedent, run through fallback.act", async () => {
    createPrecedentStore(home, { newId: () => "prec-1" }).save(
      { scope: "wks_1", subject: "fallback-worker", text: "I'll handle it", sourceDecisionId: null, expiresInDays: 30 },
      new Date(),
    );
    const acts = actions();
    await recordUnder("auto", acts);
    await vi.waitFor(() => expect(read()[0]!.status).toBe("dismissed"));
    expect(acts.roles).toEqual([]);
    await vi.waitFor(() =>
      expect(decisions()).toMatchObject([{ id: `f:${ID}`, status: "answered", answer: { by: "precedent", optionKey: "dismiss" }, delivery: { kind: "fallback:dismiss", outcome: "sent" } }]),
    );
  });

  it("under Off, is recorded dismissed and opens no decision", async () => {
    const acts = actions();
    await recordUnder("off", acts);
    expect(read()[0]!.status).toBe("dismissed");
    expect(acts.roles).toEqual([]);
    expect(decisions()).toEqual([]);
  });
});
