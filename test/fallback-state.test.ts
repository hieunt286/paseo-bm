import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ROLE_FALLBACK_FILE } from "../plugin/server/fallback-settings";
import {
  MAX_INCIDENTS,
  ROLE_FALLBACK_STATE_FILE,
  candidateOf,
  capIncidents,
  modelFamilyOf,
  onFallbackIncident,
  readIncidents,
  recordIncident,
  registerFallbackDetection,
  usageOf,
  type CandidateInput,
} from "../plugin/server/fallback-state";
import type { FallbackIncident } from "../plugin/shared/contracts";
import { fakePaseo } from "./helpers/fake-paseo";

/**
 * Delta 20260921 §4.4.5 (REQ-065 a, g, i, j): one incident per classified turn,
 * with the reset time (Claude/Codex L1 only, ONE listUsage call) and the next
 * candidate of the role's chain. Fake daemon, temporary install home; every
 * listUsage call is counted (owner decision Q2 a: no usage read before a failure).
 */

const REQ = "req-20260922T010000Z";
const WORKSPACE = "wks_1";
const MANAGER = "mgr-1";
const WORKER = "wrk-1";

const CODEX = { baseProvider: "codex", model: "gpt-5.6-sol", thinkingOptionId: "high", modeId: "full-access" };
const SONNET = { baseProvider: "claude", model: "claude-sonnet-5", thinkingOptionId: null, modeId: null };
const PI = { baseProvider: "pi", model: "pi-default", thinkingOptionId: null, modeId: null };

type Windows = Array<{ id: string; usedPct?: number | null; remainingPct?: number | null; resetsAt?: string | null }>;

/** The Worker `WORKER` under `MANAGER`, the providers' bases, and Claude's usage windows. */
function daemonWith(options: { windows?: Windows; available?: string[]; bases?: Record<string, string>; snapshots?: Record<string, object> } = {}) {
  const snapshots: Record<string, object> = {
    [WORKER]: { id: WORKER, model: "claude-opus-5", runtimeInfo: { model: "claude-opus-5" }, labels: { "bm.role": "worker", "bm.requestId": REQ, "paseo.parent-agent-id": MANAGER } },
    ...options.snapshots,
  };
  const bases = options.bases ?? { "bm-worker": "claude", "bm-worker-fallback-1": "codex", "bm-worker-fallback-2": "claude", "bm-reviewer": "codex" };
  const fake = fakePaseo({
    agents: Object.entries(snapshots).map(([id, snapshot]) => ({ ...snapshot, id })),
    providers: {
      available: options.available ?? ["claude", "codex", "pi"],
      usage: { requestId: "r", fetchedAt: "2026-09-22T10:00:00.000Z", providers: [{ providerId: "claude", status: "available", windows: options.windows ?? [] }] },
    },
    config: { providers: Object.fromEntries(Object.entries(bases).map(([id, base]) => [id, { extends: base }])) },
  });
  return { paseo: fake.paseo, listUsage: fake.api.providers.listUsage };
}

let root: string;
let home: string;
let logged: string[];
const log = (message: string) => void logged.push(message);
const NOW = () => new Date("2026-09-22T10:00:00.000Z");
let hex = 0;
const randomHex = () => (hex++).toString(16).padStart(12, "0");

function saveChain(policy: "ask" | "off", entries: unknown[]) {
  writeFileSync(join(home, ROLE_FALLBACK_FILE), JSON.stringify({ version: 1, roles: { worker: { policy, entries } } }));
}

const workerEvent = (provider = "bm-worker/claude-opus-5", agentId = WORKER) => ({ agent: { id: agentId, provider, workspaceId: WORKSPACE } });
const L1 = { class: "L1" as const, signal: "failed" as const, message: "You've hit your usage limit. Your limit resets at 3pm." };

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "bm-fallback-state-"));
  home = join(root, ".paseo-bm");
  mkdirSync(home);
  logged = [];
  hex = 0;
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("recordIncident", () => {
  it("records a pending L1 incident with the latest reset of the exhausted windows and the next candidate", async () => {
    saveChain("ask", [CODEX, SONNET]);
    const { paseo, listUsage } = daemonWith({
      windows: [
        { id: "five_hour", usedPct: 100, resetsAt: "2026-09-22T12:00:00.000Z" },
        { id: "seven_day", remainingPct: 0, resetsAt: "2026-09-25T00:00:00.000Z" },
        { id: "seven_day_opus", usedPct: 40, resetsAt: "2026-09-29T00:00:00.000Z" },
      ],
    });
    const incident = await recordIncident(workerEvent(), L1, { paseo, home, log, now: NOW, randomHex });
    expect(listUsage).toHaveBeenCalledTimes(1);
    expect(incident).toEqual({
      id: "fb-000000000000",
      role: "worker",
      workspaceId: WORKSPACE,
      requestId: REQ,
      agentId: WORKER,
      agentProvider: "bm-worker/claude-opus-5",
      agentModel: "claude-opus-5",
      parentId: MANAGER,
      managerId: MANAGER,
      class: "L1",
      signal: "failed",
      message: L1.message,
      perModelWindow: false,
      resetsAt: "2026-09-25T00:00:00.000Z",
      candidate: { position: 1, alias: "bm-worker-fallback-1", ...CODEX },
      status: "pending",
      detectedAt: "2026-09-22T10:00:00.000Z",
      decidedAt: null,
      waitUntil: null,
      replacementId: null,
      error: null,
    });
    const path = join(home, ROLE_FALLBACK_STATE_FILE);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ version: 1, incidents: [incident] });
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("dedupes: an agent with a pending incident gets no second one, and no second listUsage", async () => {
    saveChain("ask", [CODEX]);
    const { paseo, listUsage } = daemonWith({ windows: [{ id: "five_hour", usedPct: 100 }] });
    expect(await recordIncident(workerEvent(), L1, { paseo, home, log, now: NOW, randomHex })).not.toBeNull();
    expect(await recordIncident(workerEvent(), L1, { paseo, home, log, now: NOW, randomHex })).toBeNull();
    expect(listUsage).toHaveBeenCalledTimes(1);
    expect(readIncidents(home).incidents).toHaveLength(1);
  });

  it("with policy off records the incident as dismissed and never reads usage", async () => {
    saveChain("off", [CODEX]);
    const { paseo, listUsage } = daemonWith({ windows: [{ id: "five_hour", usedPct: 100 }] });
    const incident = await recordIncident(workerEvent(), L1, { paseo, home, log, now: NOW, randomHex });
    expect(incident).toMatchObject({ status: "dismissed", decidedAt: "2026-09-22T10:00:00.000Z", resetsAt: null });
    expect(listUsage).not.toHaveBeenCalled();
  });

  it.each(["L2", "L4", "L5"] as const)("never reads usage for %s", async (cls) => {
    saveChain("ask", [CODEX]);
    const { paseo, listUsage } = daemonWith();
    expect(await recordIncident(workerEvent(), { ...L1, class: cls }, { paseo, home, log, now: NOW, randomHex })).toMatchObject({ class: cls });
    expect(listUsage).not.toHaveBeenCalled();
  });

  it("never reads usage for an L1 on a base provider other than claude or codex", async () => {
    saveChain("ask", [CODEX]);
    const { paseo, listUsage } = daemonWith({ bases: { "bm-worker": "opencode", "bm-worker-fallback-1": "codex" } });
    expect(await recordIncident(workerEvent("bm-worker/big-pickle"), L1, { paseo, home, log, now: NOW, randomHex })).toMatchObject({ resetsAt: null });
    expect(listUsage).not.toHaveBeenCalled();
  });

  it("masks secrets like every trace record (REQ-048b) and cuts the message to 500 characters", async () => {
    saveChain("ask", []);
    const { paseo } = daemonWith();
    const message = `billing failed: run paseo login --token abc123secret ${"x".repeat(600)}`;
    const incident = await recordIncident(workerEvent(), { ...L1, class: "L2", message }, { paseo, home, log, now: NOW, randomHex });
    expect(incident?.message).toHaveLength(500);
    expect(incident?.message).toContain("--token [redacted]");
    expect(incident?.message).not.toContain("abc123secret");
  });

  it("finds a Reviewer's card in its Worker's Manager's chat", async () => {
    saveChain("ask", []);
    const { paseo } = daemonWith({
      snapshots: { "rev-1": { id: "rev-1", labels: { "bm.role": "reviewer", "bm.requestId": REQ, "paseo.parent-agent-id": WORKER } } },
    });
    const incident = await recordIncident(
      { agent: { id: "rev-1", provider: "bm-reviewer/gpt-5.6-sol", workspaceId: WORKSPACE } },
      { ...L1, class: "L2" },
      { paseo, home, log, now: NOW, randomHex },
    );
    expect(incident).toMatchObject({ role: "reviewer", parentId: WORKER, managerId: MANAGER });
  });

  it("records nothing for the Orchestrator: it has no fallback chain (orchestrator design §3.1)", async () => {
    saveChain("ask", [CODEX]);
    const { paseo, listUsage } = daemonWith();
    for (const provider of ["bm-orchestrator", "bm-orchestrator/claude-opus-5"]) {
      expect(await recordIncident(workerEvent(provider, "orc-1"), L1, { paseo, home, log, now: NOW, randomHex })).toBeNull();
    }
    expect(listUsage).not.toHaveBeenCalled();
    expect(existsSync(join(home, ROLE_FALLBACK_STATE_FILE))).toBe(false);
  });

  it("never overwrites an unusable state file, and records nothing", async () => {
    writeFileSync(join(home, ROLE_FALLBACK_STATE_FILE), "{broken");
    const { paseo } = daemonWith();
    expect(await recordIncident(workerEvent(), L1, { paseo, home, log, now: NOW, randomHex })).toBeNull();
    expect(readFileSync(join(home, ROLE_FALLBACK_STATE_FILE), "utf8")).toBe("{broken");
    expect(logged.some((line) => line.startsWith("[paseo-bm]") && line.includes("not usable"))).toBe(true);
  });

  it("records the first incident on a fresh data home: the write creates the folder (code review 2026-09-30 §2.4)", async () => {
    rmSync(home, { recursive: true });
    const { paseo } = daemonWith();
    const incident = await recordIncident(workerEvent(), { ...L1, class: "L4" }, { paseo, home, log, now: NOW, randomHex });
    expect(incident).not.toBeNull();
    expect(statSync(home).mode & 0o777).toBe(0o700);
    const path = join(home, ROLE_FALLBACK_STATE_FILE);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ version: 1, incidents: [incident] });
  });

  it("refuses a symlinked state file on a read, never following it, and records nothing (code review 2026-09-30 §2.4)", async () => {
    const outside = join(root, "outside.json");
    const target = JSON.stringify({ version: 1, incidents: [] });
    writeFileSync(outside, target);
    symlinkSync(outside, join(home, ROLE_FALLBACK_STATE_FILE));
    const read = readIncidents(home, log);
    expect(read.incidents).toEqual([]);
    expect(read.error).toMatch(/symlinked path/);
    expect(logged.some((line) => line.startsWith("[paseo-bm]") && line.includes("not usable"))).toBe(true);
    const { paseo } = daemonWith();
    expect(await recordIncident(workerEvent(), { ...L1, class: "L4" }, { paseo, home, log, now: NOW, randomHex })).toBeNull();
    expect(readFileSync(outside, "utf8")).toBe(target);
  });

  it("never writes a state file a newer paseo-bm wrote", async () => {
    const newer = JSON.stringify({ version: 2, incidents: [{ id: "from-a-newer-build" }] });
    writeFileSync(join(home, ROLE_FALLBACK_STATE_FILE), newer);
    expect(readIncidents(home, log).error).toMatch(/newer paseo-bm/);
    const { paseo } = daemonWith();
    expect(await recordIncident(workerEvent(), { ...L1, class: "L4" }, { paseo, home, log, now: NOW, randomHex })).toBeNull();
    expect(readFileSync(join(home, ROLE_FALLBACK_STATE_FILE), "utf8")).toBe(newer);
  });

  it("tells every listener, once per incident", async () => {
    saveChain("ask", [CODEX]);
    const { paseo } = daemonWith();
    const seen: string[] = [];
    const remove = onFallbackIncident((incident) => void seen.push(incident.id));
    await recordIncident(workerEvent(), { ...L1, class: "L4" }, { paseo, home, log, now: NOW, randomHex });
    await recordIncident(workerEvent(), { ...L1, class: "L4" }, { paseo, home, log, now: NOW, randomHex });
    remove();
    expect(seen).toHaveLength(1);
  });
});

describe("candidateOf — the four skip rules of §4.4.5", () => {
  const base = (overrides: Partial<CandidateInput>): CandidateInput => ({
    role: "worker",
    chain: { policy: "ask", entries: [CODEX, SONNET, PI] },
    failedPosition: 0,
    failedBaseProvider: "claude",
    failedModel: "claude-opus-5",
    cls: "L1",
    perModelWindow: false,
    failedAliases: new Set(["bm-worker"]),
    available: new Set(["claude", "codex", "pi"]),
    ...overrides,
  });

  it("takes the first entry after the failed agent's position", () => {
    expect(candidateOf(base({}))).toMatchObject({ position: 1, alias: "bm-worker-fallback-1", baseProvider: "codex" });
    expect(candidateOf(base({ failedPosition: 1, failedBaseProvider: "codex", failedModel: "gpt-5.6-sol" }))).toMatchObject({ position: 2 });
  });

  it("1. skips an alias that already failed in the same scope", () => {
    expect(candidateOf(base({ failedAliases: new Set(["bm-worker", "bm-worker-fallback-1"]), cls: "L5" }))).toMatchObject({ position: 2 });
  });

  it("2. skips a base provider that is not available", () => {
    expect(candidateOf(base({ available: new Set(["claude", "pi"]), cls: "L5" }))).toMatchObject({ position: 2 });
  });

  it("3. skips the failed agent's own base provider on L2, L4, and L1 without a per-model window", () => {
    const chain = { policy: "ask" as const, entries: [SONNET, CODEX] };
    for (const cls of ["L2", "L4", "L1"] as const) expect(candidateOf(base({ chain, cls }))).toMatchObject({ position: 2, baseProvider: "codex" });
    // L5 (provider unavailable) is not a plan failure: the rule does not apply.
    expect(candidateOf(base({ chain, cls: "L5" }))).toMatchObject({ position: 1, baseProvider: "claude" });
  });

  it("4. with a per-model window, skips the same provider only for the same model family", () => {
    const opus = { baseProvider: "claude", model: "claude-opus-4-6", thinkingOptionId: null, modeId: null };
    expect(candidateOf(base({ chain: { policy: "ask", entries: [opus, SONNET] }, perModelWindow: true }))).toMatchObject({ position: 2, model: "claude-sonnet-5" });
    expect(modelFamilyOf("claude-opus-5")).toBe("opus");
    expect(modelFamilyOf("gpt-5.6-sol")).toBe("gpt");
    expect(modelFamilyOf("pi-default")).toBeNull();
  });

  it("returns null when the chain is exhausted", () => {
    expect(candidateOf(base({ failedPosition: 3 }))).toBeNull();
    expect(candidateOf(base({ chain: { policy: "ask", entries: [] } }))).toBeNull();
    expect(candidateOf(base({ available: new Set(["claude"]), chain: { policy: "ask", entries: [CODEX, SONNET] } }))).toBeNull();
  });
});

describe("usageOf", () => {
  const withWindows = (windows: Windows) => daemonWith({ windows }).paseo;

  it("takes the latest reset among the exhausted windows only", async () => {
    const paseo = withWindows([
      { id: "five_hour", usedPct: 100, resetsAt: "2026-09-22T15:00:00.000Z" },
      { id: "seven_day", usedPct: 99, resetsAt: "2026-09-30T00:00:00.000Z" },
      { id: "seven_day_opus", remainingPct: 0, resetsAt: "2026-09-24T00:00:00.000Z" },
    ]);
    expect(await usageOf(paseo, "claude", log)).toEqual({ resetsAt: "2026-09-24T00:00:00.000Z", perModelWindow: false });
  });

  it("calls a window per model only when every exhausted window names a model family", async () => {
    expect(
      await usageOf(withWindows([{ id: "seven_day_opus", usedPct: 100 }, { id: "seven_day_sonnet", usedPct: 100 }, { id: "five_hour", usedPct: 20 }]), "claude", log),
    ).toEqual({ resetsAt: null, perModelWindow: true });
    expect(await usageOf(withWindows([{ id: "seven_day_opus", usedPct: 100 }, { id: "five_hour", usedPct: 100 }]), "claude", log)).toMatchObject({ perModelWindow: false });
  });

  it("gives nothing when no window is exhausted, the provider is missing, or the call fails", async () => {
    expect(await usageOf(withWindows([{ id: "five_hour", usedPct: 50 }]), "claude", log)).toEqual({ resetsAt: null, perModelWindow: false });
    expect(await usageOf(withWindows([{ id: "five_hour", usedPct: 100 }]), "codex", log)).toEqual({ resetsAt: null, perModelWindow: false });
    const failing = { providers: { listUsage: async () => Promise.reject(new Error("offline")) } };
    expect(await usageOf(failing, "claude", log)).toEqual({ resetsAt: null, perModelWindow: false });
    expect(logged.at(-1)).toMatch(/^\[paseo-bm\] could not read the usage of claude \(offline\)/);
  });
});

describe("capIncidents", () => {
  const incident = (n: number, status: FallbackIncident["status"]): FallbackIncident => ({
    id: `fb-${n.toString(16).padStart(12, "0")}`,
    role: "worker",
    workspaceId: WORKSPACE,
    requestId: REQ,
    agentId: `a-${n}`,
    agentProvider: "bm-worker",
    agentModel: null,
    parentId: null,
    managerId: null,
    class: "L1",
    signal: "failed",
    message: "",
    perModelWindow: false,
    resetsAt: null,
    candidate: null,
    status,
    detectedAt: "",
    decidedAt: null,
    waitUntil: null,
    replacementId: null,
    error: null,
  });

  it("keeps 200, dropping the oldest finished incident first, then the oldest of all", () => {
    const list = [incident(0, "pending"), incident(1, "dismissed"), ...Array.from({ length: MAX_INCIDENTS - 1 }, (_v, i) => incident(i + 2, "pending"))];
    const capped = capIncidents(list);
    expect(capped).toHaveLength(MAX_INCIDENTS);
    expect(capped.map((entry) => entry.agentId)).not.toContain("a-1");
    const allOpen = Array.from({ length: MAX_INCIDENTS + 1 }, (_v, i) => incident(i, "waiting"));
    expect(capIncidents(allOpen)[0]!.agentId).toBe("a-1");
  });
});

describe("registerFallbackDetection", () => {
  function host() {
    const handlers: Array<(event: unknown, context: unknown) => Promise<void>> = [];
    return {
      handlers,
      value: { on: vi.fn((_name: string, handler: (event: unknown, context: unknown) => Promise<void>) => (handlers.push(handler), () => {})) },
    };
  }

  it("records an incident for a failed Worker turn that classifies as L1", async () => {
    saveChain("ask", [CODEX]);
    const { paseo, listUsage } = daemonWith({ windows: [{ id: "five_hour", usedPct: 100, resetsAt: "2026-09-22T15:00:00.000Z" }] });
    const fake = host();
    registerFallbackDetection(fake.value as never, { log, now: NOW, home: () => home });
    await fake.handlers[0]!(
      { agent: { id: WORKER, provider: "bm-worker/claude-opus-5", workspaceId: WORKSPACE }, turnId: "t1", outcome: { kind: "failed", error: { message: L1.message } }, timeline: [] },
      { paseo },
    );
    expect(readIncidents(home).incidents).toMatchObject([{ agentId: WORKER, class: "L1", resetsAt: "2026-09-22T15:00:00.000Z", status: "pending" }]);
    expect(listUsage).toHaveBeenCalledTimes(1);
  });

  it("does not even look up the install home for an ordinary turn", async () => {
    const homeLookup = vi.fn(() => home);
    const fake = host();
    registerFallbackDetection(fake.value as never, { log, now: NOW, home: homeLookup });
    const { paseo } = daemonWith();
    const toolCall = { type: "tool_call", name: "Bash" };
    await fake.handlers[0]!(
      { agent: { id: WORKER, provider: "bm-worker", workspaceId: WORKSPACE }, turnId: "t2", outcome: { kind: "completed" }, timeline: [{ type: "user_message", text: "go" }, toolCall] },
      { paseo },
    );
    await fake.handlers[0]!({ agent: { id: "x", provider: "claude", workspaceId: WORKSPACE }, turnId: "t3", outcome: { kind: "failed", error: { message: "usage limit" } } }, { paseo });
    expect(homeLookup).not.toHaveBeenCalled();
  });

  it("does not even look up the install home for an Orchestrator's usage-limit turn (orchestrator design §3.1)", async () => {
    const homeLookup = vi.fn(() => home);
    const fake = host();
    registerFallbackDetection(fake.value as never, { log, now: NOW, home: homeLookup });
    const { paseo, listUsage } = daemonWith({ snapshots: { "orc-1": { id: "orc-1", labels: { "bm.role": "orchestrator" } } } });
    await fake.handlers[0]!(
      { agent: { id: "orc-1", provider: "bm-orchestrator/claude-opus-5", workspaceId: WORKSPACE }, turnId: "t1", outcome: { kind: "failed", error: { message: L1.message } }, timeline: [] },
      { paseo },
    );
    expect(homeLookup).not.toHaveBeenCalled();
    expect(listUsage).not.toHaveBeenCalled();
  });
});
