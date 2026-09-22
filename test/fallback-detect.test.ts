import { describe, expect, it, vi } from "vitest";
import {
  MAX_QUIET_REPLY_CHARS,
  REPLACED_BY_LABEL,
  classifyTurn,
  quietReply,
  quietTokens,
  type FallbackDetectDeps,
} from "../plugin/server/fallback-detect";
import { REFETCH_LIMIT } from "../plugin/server/collector";

/**
 * Delta 20260921 §4.4.4 (REQ-065 a, b): at the end of a turn of an agent whose
 * role has a fallback chain, N1 (a failed turn) and N2 (a completed turn that
 * did nothing but say a few words) are read and classified. Pure: the SDK is a
 * fake, nothing touches a daemon, a store or $HOME.
 */

interface FakeTurn {
  agent: { id: string; workspaceId: string | null; parentAgentId: string | null; provider: string; cwd: string; title: string | null };
  turnId: string | null;
  outcome: { kind: "completed" } | { kind: "failed"; error: { message: string } } | { kind: "canceled"; reason: string };
  timeline: unknown[];
}

const LIMIT = "You've hit your usage limit - resets 3pm (Europe/Paris)";

const user = (text: string, clientMessageId?: string) => ({ type: "user_message", text, ...(clientMessageId ? { clientMessageId } : {}) });
const said = (text: string) => ({ type: "assistant_message", text });
const toolCall = { type: "tool_call", callId: "c1", name: "Bash", status: "completed", error: null, detail: { type: "shell", command: "br ready" } };

function turn(overrides: Partial<FakeTurn> = {}): FakeTurn {
  return {
    agent: { id: "w-1", workspaceId: "wks_1", parentAgentId: "m-1", provider: "bm-worker/claude-opus-5", cwd: "/repo", title: "Beads Worker" },
    turnId: "turn-1",
    outcome: { kind: "completed" },
    timeline: [user("Continue req-20260921T111242Z."), said(LIMIT)],
    ...overrides,
  };
}

const failed = (message: string, rest: Partial<FakeTurn> = {}) => turn({ outcome: { kind: "failed", error: { message } }, ...rest });

/** The hook is typed against Paseo's event; the fake has the same shape. */
const asEvent = (value: FakeTurn) => value as never;

interface Snapshot {
  labels?: Record<string, string>;
  lastUsage?: { inputTokens?: number; cachedInputTokens?: number; outputTokens?: number } | null;
}

function deps(snapshot: Snapshot | null = { labels: { "bm.role": "worker" }, lastUsage: { inputTokens: 10, outputTokens: 0 } }, extra: Partial<FallbackDetectDeps> = {}) {
  const refetch = vi.fn(async () => ({ entries: [], agent: snapshot ?? undefined }));
  const log = vi.fn();
  const value: FallbackDetectDeps = { paseo: { agents: { ref: () => ({ timeline: { refetch } }) } }, log, ...extra };
  return { value, refetch, log };
}

describe("N1: a failed turn", () => {
  it("classifies outcome.error.message, even when the turn ran tools", async () => {
    const { value, refetch, log } = deps();
    const result = await classifyTurn(asEvent(failed(`  ${LIMIT}\n`, { timeline: [user("go"), toolCall] })), value);
    expect(result).toEqual({ class: "L1", signal: "failed", message: LIMIT });
    expect(refetch).toHaveBeenCalledTimes(1);
    expect(refetch).toHaveBeenCalledWith({ direction: "tail", limit: REFETCH_LIMIT });
    expect(log).not.toHaveBeenCalled();
  });

  it.each([
    ["Your credit balance is too low to access the Anthropic API", "L2"],
    ["Invalid API key - Please run /login", "L4"],
    ["spawn codex ENOENT", "L5"],
  ])("%s -> %s", async (message, cls) => {
    expect(await classifyTurn(asEvent(failed(message)), deps().value)).toMatchObject({ class: cls, signal: "failed" });
  });

  it("L3 and L6 are ignored, without a daemon call", async () => {
    const { value, refetch } = deps();
    expect(await classifyTurn(asEvent(failed("API Error: 529 Overloaded")), value)).toBeNull();
    expect(await classifyTurn(asEvent(failed("TypeError: cannot read properties of undefined")), value)).toBeNull();
    expect(await classifyTurn(asEvent(failed("")), value)).toBeNull();
    expect(refetch).not.toHaveBeenCalled();
  });

  it("a canceled turn is never classified", async () => {
    const { value, refetch } = deps();
    expect(await classifyTurn(asEvent(turn({ outcome: { kind: "canceled", reason: LIMIT } })), value)).toBeNull();
    expect(refetch).not.toHaveBeenCalled();
  });
});

describe("N2: a completed turn that only said a few words", () => {
  it("classifies the last assistant message when the turn produced no output tokens", async () => {
    const result = await classifyTurn(asEvent(turn()), deps().value);
    expect(result).toEqual({ class: "L1", signal: "completed", message: LIMIT });
  });

  it("classifies it when the provider reports no tokens and a person or an agent started the turn", async () => {
    const byUser = turn({ timeline: [user("please continue", "client-1"), said(LIMIT)] });
    expect(await classifyTurn(asEvent(byUser), deps({ labels: {}, lastUsage: null }).value)).toMatchObject({ class: "L1" });
    expect(await classifyTurn(asEvent(turn()), deps({ labels: {} }).value)).toMatchObject({ class: "L1" });
  });

  it("reads only the last turn of the hook payload, and its last assistant message", async () => {
    const timeline = [user("first"), toolCall, said("BM-REPORT\nphase: received"), user("Continue."), said("Working on it."), said(LIMIT)];
    expect(await classifyTurn(asEvent(turn({ timeline })), deps().value)).toMatchObject({ class: "L1", message: LIMIT });
  });

  it("a tool call in the turn -> null", async () => {
    const { value, refetch } = deps();
    expect(await classifyTurn(asEvent(turn({ timeline: [user("go"), toolCall, said(LIMIT)] })), value)).toBeNull();
    expect(refetch).not.toHaveBeenCalled();
  });

  it("a BM-REPORT or BM-REVIEW block in the agent's own reply -> null", async () => {
    const report = `BM-REPORT\nrequestId: req-20260921T111242Z\nphase: blocked\nblockers: ${LIMIT}`;
    const review = `BM-REVIEW\nbatchId: b-1\nverdict: changes-requested\nfindings: ${LIMIT}`;
    expect(await classifyTurn(asEvent(turn({ timeline: [user("go"), said(report)] })), deps().value)).toBeNull();
    expect(await classifyTurn(asEvent(turn({ timeline: [user("go"), said(review)] })), deps().value)).toBeNull();
    expect(await classifyTurn(asEvent(turn({ timeline: [user("go"), said(report), said(LIMIT)] })), deps().value)).toBeNull();
  });

  it("a block the agent RECEIVED does not hide its limit reply (a Worker woken by its Reviewer's verdict, REQ-065 a)", async () => {
    const review = "BM-REVIEW\nbatchId: b-1\nverdict: changes-requested";
    expect(await classifyTurn(asEvent(turn({ timeline: [user(review), said(LIMIT)] })), deps().value)).toMatchObject({ class: "L1", message: LIMIT });
  });

  it("output tokens > 0 -> null", async () => {
    const { value, refetch } = deps({ labels: {}, lastUsage: { inputTokens: 10, outputTokens: 42 } });
    expect(await classifyTurn(asEvent(turn()), value)).toBeNull();
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it("no tokens reported and the turn started by a plugin notice -> null", async () => {
    const notice = user("BM-BUDGET This request has used 3 of its 3 review calls.", "client-9");
    const event = turn({ timeline: [notice, said("Understood: the usage limit is reached, I stop here.")] });
    expect(await classifyTurn(asEvent(event), deps({ labels: {}, lastUsage: null }).value)).toBeNull();
    // With tokens reported, the token count decides, not the notice.
    expect(await classifyTurn(asEvent(event), deps({ labels: {}, lastUsage: { outputTokens: 0 } }).value)).toMatchObject({ class: "L1" });
  });

  it(`a last message longer than ${MAX_QUIET_REPLY_CHARS} characters, or none at all -> null`, async () => {
    const long = `${LIMIT} ${"x".repeat(MAX_QUIET_REPLY_CHARS)}`;
    expect(await classifyTurn(asEvent(turn({ timeline: [user("go"), said(long)] })), deps().value)).toBeNull();
    expect(await classifyTurn(asEvent(turn({ timeline: [user(LIMIT)] })), deps().value)).toBeNull();
    expect(await classifyTurn(asEvent(turn({ timeline: [user("go"), said(LIMIT), said("   ")] })), deps().value)).toBeNull();
  });

  it("a short reply that is L3 or L6 -> null, without a daemon call", async () => {
    const { value, refetch } = deps();
    expect(await classifyTurn(asEvent(turn({ timeline: [user("go"), said("Waiting for the Reviewer.")] })), value)).toBeNull();
    expect(await classifyTurn(asEvent(turn({ timeline: [user("go"), said("Too many requests, retrying.")] })), value)).toBeNull();
    expect(refetch).not.toHaveBeenCalled();
  });
});

describe("which agents are looked at", () => {
  it.each(["bm-reviewer/gpt-5.6-sol", "bm-manager", "claude", "bm-reviewer-fallback-1"])(
    "role not in FALLBACK_ROLES (%s) -> null, without a daemon call",
    async (provider) => {
      const { value, refetch } = deps();
      expect(await classifyTurn(asEvent(failed(LIMIT, { agent: { ...turn().agent, provider } })), value)).toBeNull();
      expect(refetch).not.toHaveBeenCalled();
    },
  );

  it("a fallback Worker alias is a Worker", async () => {
    const agent = { ...turn().agent, provider: "bm-worker-fallback-2/gpt-5.6-sol" };
    expect(await classifyTurn(asEvent(failed(LIMIT, { agent })), deps().value)).toMatchObject({ class: "L1" });
  });

  it("the bm.role label wins over the provider: a bm-worker labelled reviewer -> null", async () => {
    expect(await classifyTurn(asEvent(failed(LIMIT)), deps({ labels: { "bm.role": "reviewer" } }).value)).toBeNull();
  });

  it("an agent with a bm.replacedBy label -> null", async () => {
    expect(REPLACED_BY_LABEL).toBe("bm.replacedBy");
    const snapshot = { labels: { "bm.role": "worker", "bm.replacedBy": "w-2" }, lastUsage: { outputTokens: 0 } };
    expect(await classifyTurn(asEvent(failed(LIMIT)), deps(snapshot).value)).toBeNull();
    expect(await classifyTurn(asEvent(turn()), deps(snapshot).value)).toBeNull();
  });
});

describe("patterns and failures", () => {
  it("the file's patterns, handed in by the caller, replace the defaults of their class", async () => {
    const patterns = { L1: ["weekly allowance used up"] };
    expect(await classifyTurn(asEvent(failed("Weekly allowance used up")), deps(undefined, { patterns }).value)).toMatchObject({ class: "L1" });
    expect(await classifyTurn(asEvent(failed(LIMIT)), deps(undefined, { patterns }).value)).toBeNull();
  });

  it("a bad pattern from the file is dropped and logged; detection goes on", async () => {
    const { value, log } = deps(undefined, { patterns: { L1: ["[oops", "weekly allowance used up"] } });
    expect(await classifyTurn(asEvent(failed("weekly allowance used up")), value)).toMatchObject({ class: "L1" });
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]![0]).toMatch(/^\[paseo-bm\] /);
  });

  it("a refetch that fails, or returns no snapshot, costs one [paseo-bm] line and no classification", async () => {
    const log = vi.fn();
    const broken: FallbackDetectDeps = {
      paseo: { agents: { ref: () => ({ timeline: { refetch: () => Promise.reject(new Error("daemon gone")) } }) } },
      log,
    };
    await expect(classifyTurn(asEvent(failed(LIMIT)), broken)).resolves.toBeNull();
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]![0]).toMatch(/^\[paseo-bm\] .*w-1.*daemon gone/);

    const empty = deps(null);
    await expect(classifyTurn(asEvent(failed(LIMIT)), empty.value)).resolves.toBeNull();
    expect(empty.log).toHaveBeenCalledTimes(1);
  });

  it("never throws on a malformed event", async () => {
    const { value, log } = deps();
    await expect(classifyTurn({ outcome: { kind: "failed", error: { message: LIMIT } } } as never, value)).resolves.toBeNull();
    await expect(classifyTurn(null as never, value)).resolves.toBeNull();
    expect(log).toHaveBeenCalledTimes(2);
    expect(log.mock.calls.every(([line]) => String(line).startsWith("[paseo-bm] "))).toBe(true);
  });
});

describe("the N2 helpers", () => {
  it("quietReply returns the trimmed last assistant message of a turn that did nothing else", () => {
    expect(quietReply([user("go"), said("  first "), said(" last\n")])).toBe("last");
    expect(quietReply([user("go"), toolCall])).toBeNull();
    expect(quietReply([])).toBeNull();
  });

  it("quietTokens: tokens decide when reported; otherwise the first message must not be a plugin notice", () => {
    const usage = (outputTokens: number) => ({
      inputTokens: 1,
      cachedInputTokens: 0,
      outputTokens,
      costUsd: null,
      costBasis: "unavailable" as const,
      model: null,
      pricesUpdatedAt: null,
    });
    expect(quietTokens(usage(0), [user("BM-STOP stop")])).toBe(true);
    expect(quietTokens(usage(3), [user("go")])).toBe(false);
    expect(quietTokens(null, [user("go")])).toBe(true);
    expect(quietTokens(null, [user("BM-TOOLS Worker w-1 runs without Paseo tools.")])).toBe(false);
    expect(quietTokens(null, [said("no user message in this slice")])).toBe(true);
  });
});
