import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NEW_REQUEST_MARKER } from "../plugin/shared/new-request";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  REDACTED,
  REFETCH_LIMIT,
  buildRecord,
  clearStartMarks,
  collectTurnEnded,
  evidenceFromItem,
  joinStreamedText,
  skillsFromItem,
  noteTurnStart,
  sliceLastTurn,
  redactText,
  registerCollector,
  type CollectorDeps,
} from "../plugin/server/collector";
import { clearTraceStoreCache, readRecords, withWorkspaceLock } from "../plugin/server/trace-store";
import { reconstructTraces } from "../plugin/server/traces";
import { TRACE_STORE_SCHEMA_VERSION, evidenceSchema, traceRecordSchema, traceRuntimeSchema } from "../plugin/shared/contracts";
import { PLUGIN_VERSION } from "../plugin/shared/version";

/**
 * WP-205: the turn collector.
 *
 * The property that matters most is negative: nothing here may throw into a
 * real agent turn. Every failure mode therefore has a test that asserts the
 * collector *returns* rather than rejects — out of space, no permission, a lock
 * it could not get, a host with no hooks at all.
 *
 * The other one is on-disk: secrets are masked BEFORE the append, so the test
 * greps the actual file rather than the in-memory record.
 */

const WS = "wks_1";
let home: string;
let location: { tracesDir: string };

interface FakeTurn {
  agent: {
    id: string;
    workspaceId: string | null;
    parentAgentId: string | null;
    provider: string;
    cwd: string;
    title: string | null;
  };
  turnId: string | null;
  outcome: { kind: "completed" | "failed" | "canceled"; error?: { message: string }; reason?: string };
  timeline: unknown[];
}

function turnEnded(overrides: Partial<FakeTurn> = {}): FakeTurn {
  return {
    agent: {
      id: "agent-worker",
      workspaceId: WS,
      parentAgentId: "agent-manager",
      provider: "bm-worker/claude-opus-5",
      cwd: "/Users/test/repo",
      title: "Beads Worker",
    },
    turnId: "turn-1",
    outcome: { kind: "completed" as const },
    timeline: [],
    ...overrides,
  };
}

/** The hooks are typed against Paseo's event shape; the fake is structurally close enough. */
const asEvent = (turn: FakeTurn) => turn as never;

const userMessage = (text: string) => ({ type: "user_message" as const, text });
const assistantMessage = (text: string) => ({ type: "assistant_message" as const, text });
const shellCall = (command: string) => ({
  type: "tool_call" as const,
  callId: "c1",
  name: "Bash",
  status: "completed" as const,
  error: null,
  detail: { type: "shell" as const, command },
});

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "bm-collector-"));
  location = { tracesDir: join(home, "traces") };
  clearStartMarks();
  clearTraceStoreCache();
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe("redaction", () => {
  it("masks the value of a secret environment variable wherever it appears", () => {
    const env = { PASEO_PASSWORD: "hunter2" } as NodeJS.ProcessEnv;
    expect(redactText("connect with hunter2 now", env)).toBe(`connect with ${REDACTED} now`);
  });

  it("masks a password-shaped flag value in three spellings", () => {
    const env = {} as NodeJS.ProcessEnv;
    expect(redactText("paseo --password s3cret", env)).toBe(`paseo --password ${REDACTED}`);
    expect(redactText("paseo --token=abc123", env)).toBe(`paseo --token=${REDACTED}`);
    expect(redactText('paseo --secret "a b"', env)).toBe(`paseo --secret ${REDACTED}`);
  });

  it("leaves ordinary text and an empty secret alone", () => {
    expect(redactText("nothing to hide", { PASEO_PASSWORD: "" } as NodeJS.ProcessEnv)).toBe(
      "nothing to hide",
    );
  });
});

describe("provider filtering", () => {
  it.each(["bm-manager", "bm-worker/claude-opus-5", "bm-reviewer/gpt-5.6-sol"])(
    "collects %s",
    async (provider) => {
      const built = await buildRecord(asEvent(turnEnded({ agent: { ...turnEnded().agent, provider } })), {
        location,
      });
      expect(built).not.toBeNull();
    },
  );

  it.each([
    ["bm-worker-fallback-1/claude-opus-5", "worker"],
    ["bm-reviewer-fallback-2", "reviewer"],
  ])("collects a turn of a fallback agent %s with its role (delta 20260921 §4.4.1)", async (provider, role) => {
    const built = await buildRecord(asEvent(turnEnded({ agent: { ...turnEnded().agent, provider } })), {
      location,
    });
    expect(built?.record.role).toBe(role);
  });

  it.each(["claude", "codex/gpt-5.6-sol", "opencode", "", "bm-worker-fallback-4"])("ignores %o", async (provider) => {
    const built = await buildRecord(asEvent(turnEnded({ agent: { ...turnEnded().agent, provider } })), {
      location,
    });
    expect(built).toBeNull();
  });

  it("writes nothing for a turn of the Orchestrator's assessment agent (orchestrator design §3.2)", async () => {
    // By the main alias or with a model: a 0.4.1 reader of the store must never meet the role.
    for (const provider of ["bm-orchestrator", "bm-orchestrator/claude-opus-5"]) {
      const turn = turnEnded({
        agent: { ...turnEnded().agent, id: "agent-orchestrator", parentAgentId: null, provider },
        timeline: [userMessage("Assess this request."), assistantMessage("BM-REPORT\nrequestId: req-1")],
      });
      noteTurnStart(asEvent({ ...turn, timeline: [] }));
      expect(await buildRecord(asEvent(turn), { location })).toBeNull();
      expect(await collectTurnEnded(asEvent(turn), { location })).toBe(false);
    }
    expect(readRecords(location, WS).records).toEqual([]);
    expect(existsSync(location.tracesDir)).toBe(false);
  });

  it("ignores an agent with no workspace", async () => {
    const built = await buildRecord(
      asEvent(turnEnded({ agent: { ...turnEnded().agent, workspaceId: null } })),
      { location },
    );
    expect(built).toBeNull();
  });
});

describe("record assembly", () => {
  it("splits sent and received, parses reports, and keeps evidence", async () => {
    const event = turnEnded({
      timeline: [
        userMessage("BM-REPORT\nrequestId: req-20260916T100000Z\nphase: beads-done\nbeadsCreated: bm-a1b"),
        assistantMessage("noted"),
        shellCall("br create --title=x"),
      ],
    });
    const built = await buildRecord(asEvent(event), { location, now: () => new Date("2026-09-16T10:00:00.000Z") });
    const record = built?.record;
    expect(record?.role).toBe("worker");
    expect(record?.sent).toHaveLength(1);
    expect(record?.received).toHaveLength(1);
    expect(record?.reports[0]?.beadsCreated).toEqual(["bm-a1b"]);
    expect(record?.requestId).toBe("req-20260916T100000Z");
    expect(record?.evidence).toEqual([
      { kind: "shell", detail: "br create --title=x", agentId: "agent-worker", at: "2026-09-16T10:00:00.000Z", status: "completed", callId: "c1" },
    ]);
    expect(built?.workspaceName).toBe("repo");
  });

  it("finds a requestId in a Worker initial prompt when no report carries one", async () => {
    const event = turnEnded({
      timeline: [userMessage("Your task...\nrequestId: req-20260916T090000Z\nrepo: /x")],
    });
    const built = await buildRecord(asEvent(event), { location });
    expect(built?.record.requestId).toBe("req-20260916T090000Z");
  });

  describe("a Manager relay prompt links the turn to its request (delta 20260917-workflow-skills §5.3)", () => {
    const managerAgent = { ...turnEnded().agent, id: "agent-manager", provider: "bm-manager/claude-opus-5", parentAgentId: null };
    // The live 2026-09-16 shape: an MCP tool call whose detail is `unknown` with the input kept.
    const relay = (prompt: string, name = "mcp__paseo__send_agent_prompt") => ({
      type: "tool_call" as const,
      callId: "c9",
      name,
      status: "completed" as const,
      error: null,
      detail: { type: "unknown" as const, input: { agentId: "agent-worker", prompt }, output: null },
    });

    it("reads Continue <requestId> at the start of the prompt", async () => {
      const event = turnEnded({
        agent: managerAgent,
        timeline: [userMessage("Đồng ý cả 4 mặc định. Bắt đầu viết code."), relay("Continue req-20260916T154448Z.\n\nĐồng ý cả 4 mặc định.")],
      });
      const built = await buildRecord(asEvent(event), { location });
      expect(built?.record.requestId).toBe("req-20260916T154448Z");
    });

    it.each(["**Continue** req-20260916T154448Z.", "Continue `req-20260916T154448Z`.", "  _Continue_ **req-20260916T154448Z**"])(
      "tolerates markdown around the relay form: %s (review bm-wp-220-nvk.1)",
      async (prompt) => {
        const event = turnEnded({ agent: managerAgent, timeline: [userMessage("ok"), relay(prompt)] });
        expect((await buildRecord(asEvent(event), { location }))?.record.requestId).toBe("req-20260916T154448Z");
      },
    );

    it("accepts the tool name without the MCP prefix", async () => {
      const event = turnEnded({ agent: managerAgent, timeline: [userMessage("ok"), relay("Continue req-20260916T154448Z.", "send_agent_prompt")] });
      expect((await buildRecord(asEvent(event), { location }))?.record.requestId).toBe("req-20260916T154448Z");
    });

    it("ignores a request id that is not the anchored Continue form", async () => {
      const event = turnEnded({
        agent: managerAgent,
        timeline: [userMessage("ok"), relay("Please also look at req-20260916T154448Z before you continue.")],
      });
      expect((await buildRecord(asEvent(event), { location }))?.record.requestId).toBeNull();
    });

    it("ignores the relay form in a Worker's own tool calls", async () => {
      const event = turnEnded({ timeline: [assistantMessage("sending"), relay("Continue req-20260916T154448Z.")] });
      expect((await buildRecord(asEvent(event), { location }))?.record.requestId).toBeNull();
    });

    it("never overrides a request id a report already gave", async () => {
      const event = turnEnded({
        agent: managerAgent,
        timeline: [
          userMessage("BM-REPORT\nrequestId: req-20260916T100000Z\nphase: finished"),
          relay("Continue req-20260916T154448Z."),
        ],
      });
      expect((await buildRecord(asEvent(event), { location }))?.record.requestId).toBe("req-20260916T100000Z");
    });

    it("leaves no provisional row for the user's answer once rebuilt", async () => {
      const opened = turnEnded({
        agent: managerAgent,
        turnId: "turn-open",
        timeline: [userMessage("Xây dựng hệ thống quản lý user."), assistantMessage("requestId: `req-20260916T154448Z`")],
      });
      const answer = turnEnded({
        agent: managerAgent,
        turnId: "turn-answer",
        timeline: [userMessage("Đồng ý cả 4 mặc định."), relay("Continue req-20260916T154448Z.\n\nĐồng ý cả 4 mặc định.")],
      });
      const first = await buildRecord(asEvent(opened), { location, now: () => new Date("2026-09-16T15:45:00.000Z") });
      const second = await buildRecord(asEvent(answer), { location, now: () => new Date("2026-09-16T15:57:12.000Z") });
      const rows = reconstructTraces({ records: [first!.record, second!.record], agents: [] }).filter(
        (trace) => trace.traceId !== "unknown",
      );
      expect(rows.map((trace) => trace.requestId)).toEqual(["req-20260916T154448Z"]);
      expect(rows[0]!.records).toHaveLength(2);
    });
  });

  it.each(["completed", "failed", "canceled"] as const)("records the %s outcome", async (kind) => {
    const event = turnEnded({ outcome: kind === "failed" ? { kind, error: { message: "boom" } } : { kind } });
    const built = await buildRecord(asEvent(event), { location });
    expect(built?.record.outcome).toBe(kind);
  });

  it("keeps startedAt null when the start hook never ran", async () => {
    const built = await buildRecord(asEvent(turnEnded()), { location });
    expect(built?.record.startedAt).toBeNull();
  });

  it("uses the start mark when the start hook did run", async () => {
    const started = turnEnded();
    noteTurnStart(asEvent(started), () => new Date("2026-09-16T09:59:00.000Z"));
    const built = await buildRecord(asEvent(turnEnded()), { location });
    expect(built?.record.startedAt).toBe("2026-09-16T09:59:00.000Z");
  });
});

describe("timestamps (assumption A-2)", () => {
  it("takes the turn's items and timestamps from one refetch, ignoring other turns", async () => {
    // The hook payload is the WHOLE conversation (verified against the shipped
    // daemon in WP-205.2), so the refetch entries for this turn — not the hook
    // payload — are the source of the record.
    const refetch = vi.fn(async () => ({
      entries: [
        { turnId: "turn-0", timestamp: "2026-09-16T09:00:00.000Z", item: userMessage("an older turn") },
        { turnId: "turn-1", timestamp: "2026-09-16T10:00:01.000Z", item: userMessage("one") },
        { turnId: "turn-1", timestamp: "2026-09-16T10:00:02.000Z", item: assistantMessage("two") },
      ],
      agent: {
        model: "claude-opus-5",
        lastUsage: { inputTokens: 100, cachedInputTokens: 20, outputTokens: 30, totalCostUsd: 0.5 },
      },
    }));
    const deps: CollectorDeps = {
      location,
      paseo: { agents: { ref: () => ({ timeline: { refetch } }) } },
    };
    const event = turnEnded({
      timeline: [userMessage("an older turn"), assistantMessage("old answer"), userMessage("one"), assistantMessage("two")],
    });
    const built = await buildRecord(asEvent(event), deps);

    expect(refetch).toHaveBeenCalledTimes(1);
    expect(built?.record.sent.map((message) => message.text)).toEqual(["one"]);
    expect(built?.record.received.map((message) => message.text)).toEqual(["two"]);
    expect(built?.record.sent[0]?.at).toBe("2026-09-16T10:00:01.000Z");
    expect(built?.record.received[0]?.at).toBe("2026-09-16T10:00:02.000Z");
    expect(built?.record.usage).toMatchObject({
      inputTokens: 100,
      cachedInputTokens: 20,
      outputTokens: 30,
      model: "claude-opus-5",
      // Tokens are this turn's; `totalCostUsd` is the agent's running session
      // total, so a per-turn record must not carry it (WP-214 defect 11).
      costUsd: null,
      costBasis: "unavailable",
    });
  });

  /**
   * WP-214 acceptance, defect 11. Observed on the real daemon: over twelve
   * Manager turns `lastUsage.totalCostUsd` rose 0.3956 → 0.4492 → 0.6749 →
   * 0.7948 → … → 2.2712 and never fell, while the token counts beside it went
   * up and down per turn. It is a session total. Summing it across a request's
   * turns would report several times the real bill, so the collector drops it
   * and the request cost is estimated from the per-turn tokens.
   */
  it("never records the provider cost, because it is a session total and turns would sum it", async () => {
    const costs = [0.3956435, 0.449232, 0.674862, 0.7948335];
    const seen: Array<number | null> = [];
    for (const [index, totalCostUsd] of costs.entries()) {
      const refetch = vi.fn(async () => ({
        entries: [{ item: userMessage(`turn ${index}`), turnId: "turn-1", timestamp: "2026-09-16T10:00:01.000Z" }],
        agent: { model: "claude-opus-5", lastUsage: { inputTokens: 4, cachedInputTokens: 100, outputTokens: 2, totalCostUsd } },
      }));
      const built = await buildRecord(
        asEvent(turnEnded({ timeline: [userMessage(`turn ${index}`)] })),
        { location: null, paseo: { agents: { ref: () => ({ timeline: { refetch } }) } } },
      );
      seen.push(built?.record.usage?.costUsd ?? null);
    }
    expect(seen).toEqual([null, null, null, null]);
  });

  /**
   * WP-214 acceptance, defect 10. A turn whose `turnId` was null took the
   * `turnId === null ? rawEntries : …` branch and recorded the ENTIRE
   * conversation as one turn: on the acceptance workspace that record carried
   * 13 inbound messages and 10 reports, and because its first message was
   * F-1's request text it folded into F-1 and multiplied that request's tokens.
   */
  it("a turn with no turn id records one turn, not the whole conversation", async () => {
    const entries = [
      { item: userMessage("request one"), turnId: "turn-1", timestamp: "2026-09-16T10:00:00.000Z" },
      { item: assistantMessage("answer one"), turnId: "turn-1", timestamp: "2026-09-16T10:00:01.000Z" },
      { item: userMessage("request two"), turnId: "turn-2", timestamp: "2026-09-16T10:05:00.000Z" },
      { item: assistantMessage("answer two"), turnId: "turn-2", timestamp: "2026-09-16T10:05:01.000Z" },
    ];
    const refetch = vi.fn(async () => ({ entries, agent: { model: "claude-opus-5", lastUsage: null } }));
    const built = await buildRecord(
      asEvent(turnEnded({ turnId: null, timeline: entries.map((entry) => entry.item) })),
      { location: null, paseo: { agents: { ref: () => ({ timeline: { refetch } }) } } },
    );

    expect(built?.record.sent.map((message) => message.text)).toEqual(["request two"]);
    expect(built?.record.received.map((message) => message.text)).toEqual(["answer two"]);
    // The timestamps still come from the entries, which is why the slice is
    // applied to them rather than falling back to the hook payload.
    expect(built?.record.sent[0]?.at).toBe("2026-09-16T10:05:00.000Z");
  });

  it("falls back to the last-user-message slice of the hook payload when refetch is unavailable", async () => {
    const now = () => new Date("2026-09-16T10:30:00.000Z");
    const whole = [
      userMessage("older request"),
      assistantMessage("older answer"),
      userMessage("current request"),
      assistantMessage("current answer"),
    ];
    const noSdk = await buildRecord(asEvent(turnEnded({ timeline: whole })), { location, now });
    // Only the tail from the last user message, so the whole conversation is
    // not re-recorded on every turn.
    expect(noSdk?.record.sent.map((message) => message.text)).toEqual(["current request"]);
    expect(noSdk?.record.received.map((message) => message.text)).toEqual(["current answer"]);
    expect(noSdk?.record.sent[0]?.at).toBe("2026-09-16T10:30:00.000Z");
    expect(noSdk?.record.usage).toBeNull();
    expect(sliceLastTurn(whole as never)).toHaveLength(2);
    expect(sliceLastTurn([assistantMessage("no user message at all")] as never)).toHaveLength(1);

    const failing: CollectorDeps = {
      location,
      now,
      paseo: {
        agents: {
          ref: () => ({
            timeline: {
              refetch: async () => {
                throw new Error("timeline gone");
              },
            },
          }),
        },
      },
    };
    const built = await buildRecord(asEvent(turnEnded({ timeline: [userMessage("x")] })), failing);
    expect(built?.record.sent[0]?.at).toBe("2026-09-16T10:30:00.000Z");
  });
});

describe("what the agent ran on (delta 20260918 §4.2)", () => {
  async function recordWith(agent: unknown) {
    const refetch = vi.fn(async () => ({ entries: [], agent }));
    const built = await buildRecord(asEvent(turnEnded()), {
      location: null,
      paseo: { agents: { ref: () => ({ timeline: { refetch } }) } },
    });
    return built!.record;
  }

  it("takes the running values (runtimeInfo) over the configuration, for all three fields", async () => {
    const record = await recordWith({
      model: "claude-sonnet-5",
      effectiveThinkingOptionId: "low",
      thinkingOptionId: "low",
      currentModeId: "default",
      runtimeInfo: { model: "claude-opus-5", thinkingOptionId: "high", modeId: "bypassPermissions" },
      lastUsage: { inputTokens: 1, cachedInputTokens: 0, outputTokens: 1 },
    });

    expect(record.runtime).toEqual({ model: "claude-opus-5", thinkingOptionId: "high", modeId: "bypassPermissions", provider: null });
    // `usage.model` keeps its old source, so an older plugin reads a new record the same way.
    expect(record.usage?.model).toBe("claude-sonnet-5");
  });

  it("without runtimeInfo: the configured model, the effective then the chosen thinking option, the current mode", async () => {
    expect(await recordWith({ model: "claude-opus-5", effectiveThinkingOptionId: "medium", thinkingOptionId: "low", currentModeId: "auto" }))
      .toMatchObject({ runtime: { model: "claude-opus-5", thinkingOptionId: "medium", modeId: "auto" } });
    expect(await recordWith({ model: "claude-opus-5", thinkingOptionId: "low", currentModeId: "auto" }))
      .toMatchObject({ runtime: { thinkingOptionId: "low" } });
    // No thinking value anywhere: the provider's default, recorded as null.
    expect(await recordWith({ model: "gpt-5.6-sol", currentModeId: "auto" }))
      .toMatchObject({ runtime: { model: "gpt-5.6-sol", thinkingOptionId: null, modeId: "auto" } });
  });

  it("a null the provider reports never hides a real fallback", async () => {
    const record = await recordWith({
      model: "claude-opus-5",
      currentModeId: "auto",
      runtimeInfo: { model: null, thinkingOptionId: null, modeId: null },
    });

    expect(record.runtime).toEqual({ model: "claude-opus-5", thinkingOptionId: null, modeId: "auto", provider: null });
  });

  it("no snapshot, or no refetch at all: runtime is null, like usage", async () => {
    expect((await recordWith(null)).runtime).toBeNull();
    const failing = await buildRecord(asEvent(turnEnded()), {
      location: null,
      paseo: { agents: { ref: () => ({ timeline: { refetch: async () => Promise.reject(new Error("gone")) } }) } },
    });
    expect(failing!.record.runtime).toBeNull();
    expect(failing!.record.usage).toBeNull();
  });

  it("a malformed snapshot costs the fields, never the turn", async () => {
    const record = await recordWith({ model: 42, runtimeInfo: "not an object", currentModeId: ["x"] });

    expect(record.runtime).toEqual({ model: null, thinkingOptionId: null, modeId: null, provider: null });
  });

  it("records whether the agent ran under the action boundary from its bm.boundary label, for the replay's split (autonomy design §D.2, change-010 C9)", async () => {
    expect((await recordWith({ currentModeId: "default", labels: { "bm.boundary": "on" } })).runtime).toMatchObject({ modeId: "default", boundary: "on" });
    expect((await recordWith({ labels: { "bm.boundary": "off" } })).runtime?.boundary).toBe("off");
    // No label, or one that is neither: nothing recorded (the replay reads unknown).
    expect((await recordWith({ labels: {} })).runtime).not.toHaveProperty("boundary");
    expect((await recordWith({ labels: { "bm.boundary": "maybe" } })).runtime).not.toHaveProperty("boundary");
  });
});

// delta 20260921 §4.2.7 (F7): the provider each turn ran on, so a model the
// bundled price table does not know can later be priced from its provider.
describe("the provider of each turn (runtime.provider)", () => {
  async function recordWith(agent: unknown) {
    const refetch = vi.fn(async () => ({ entries: [], agent }));
    const built = await buildRecord(asEvent(turnEnded()), {
      location: null,
      paseo: { agents: { ref: () => ({ timeline: { refetch } }) } },
    });
    return built!.record;
  }

  /** The reader a plugin built before this field shipped: `runtime` has three keys. */
  const oldRecordSchema = traceRecordSchema.extend({
    runtime: traceRuntimeSchema.omit({ provider: true }).nullable().optional(),
  });

  it("comes from the snapshot's own provider", async () => {
    const record = await recordWith({ provider: "bm-worker", model: "claude-opus-5", currentModeId: "bypassPermissions" });

    expect(record.runtime).toEqual({ model: "claude-opus-5", thinkingOptionId: null, modeId: "bypassPermissions", provider: "bm-worker" });
  });

  it.each([
    ["bm-worker/claude-opus-5", "bm-worker"],
    // OpenCode model ids carry a slash of their own (design F2): the provider
    // is everything before the FIRST one.
    ["bm-reviewer/anthropic/claude-sonnet-4-6", "bm-reviewer"],
    ["opencode", "opencode"],
  ])("a provider selection %s is recorded as the provider id %s", async (provider, expected) => {
    expect((await recordWith({ provider, model: "m" })).runtime?.provider).toBe(expected);
  });

  it("is null when the snapshot names none — never guessed from the hook event", async () => {
    // The event's agent is `bm-worker/claude-opus-5`; only the snapshot counts.
    expect((await recordWith({ model: "claude-opus-5" })).runtime?.provider).toBeNull();
    expect((await recordWith({ model: "claude-opus-5", provider: null })).runtime?.provider).toBeNull();
    expect((await recordWith({ model: "claude-opus-5", provider: "" })).runtime?.provider).toBeNull();
    expect((await recordWith({ model: "claude-opus-5", provider: 42 })).runtime?.provider).toBeNull();
  });

  it("runtime stays null, provider and all, when refetch fails or returns no snapshot", async () => {
    expect((await recordWith(null)).runtime).toBeNull();
    const failing = await buildRecord(asEvent(turnEnded()), {
      location: null,
      paseo: { agents: { ref: () => ({ timeline: { refetch: async () => Promise.reject(new Error("gone")) } }) } },
    });
    expect(failing!.record.runtime).toBeNull();
  });

  it("a new record parses with the reader that predates the field, which drops it", async () => {
    const record = await recordWith({ provider: "bm-worker", model: "claude-opus-5", currentModeId: "auto" });
    const onDisk = JSON.parse(JSON.stringify(record)) as unknown;

    const parsed = oldRecordSchema.parse(onDisk);
    expect(parsed.runtime).toEqual({ model: "claude-opus-5", thinkingOptionId: null, modeId: "auto" });
    expect(parsed.runtime).not.toHaveProperty("provider");
    // Everything else reads exactly as the new reader sees it.
    expect({ ...parsed, runtime: null }).toEqual({ ...traceRecordSchema.parse(onDisk), runtime: null });
    // The version does not move: an older reader never rejects it as too new.
    expect(parsed.v).toBe(1);
  });

  it("an old record without it parses with the new reader, runtime intact", () => {
    const old = oldRecordSchema.parse({
      v: 1,
      kind: "turn",
      at: "2026-09-18T10:00:00.000Z",
      workspaceId: WS,
      agentId: "agent-worker",
      role: "worker",
      turnId: "turn-old",
      requestId: null,
      parentAgentId: "agent-manager",
      agentCreatedAt: null,
      startedAt: null,
      endedAt: "2026-09-18T10:00:00.000Z",
      outcome: "completed",
      sent: [],
      received: [],
      reports: [],
      reviews: [],
      evidence: [],
      usage: null,
      runtime: { model: "claude-opus-5", thinkingOptionId: null, modeId: "auto" },
    });

    const parsed = traceRecordSchema.parse(JSON.parse(JSON.stringify(old)));
    expect(parsed.runtime).toEqual({ model: "claude-opus-5", thinkingOptionId: null, modeId: "auto" });
    expect(parsed.runtime).not.toHaveProperty("provider");
  });

  it("round-trips through the store, and an old line in the same file still reads", async () => {
    const snapshot = { provider: "bm-worker/claude-opus-5", model: "claude-opus-5", currentModeId: "auto" };
    const refetch = vi.fn(async () => ({ entries: [], agent: snapshot }));
    const now = () => new Date("2026-09-21T10:00:00.000Z");
    const paseo = { agents: { ref: () => ({ timeline: { refetch } }) } };
    expect(await collectTurnEnded(asEvent(turnEnded()), { location, now, paseo })).toBe(true);

    // A line written by a plugin built before the field: same file, no provider.
    const monthlyFile = join(location.tracesDir, WS, "events-202609.jsonl");
    const [line] = readFileSync(monthlyFile, "utf8").split("\n");
    const older = JSON.parse(line!) as { turnId: string; at: string; endedAt: string; runtime: Record<string, unknown> };
    older.turnId = "turn-0";
    older.at = older.endedAt = "2026-09-20T10:00:00.000Z";
    delete older.runtime["provider"];
    writeFileSync(monthlyFile, `${JSON.stringify(older)}\n${line}\n`);
    clearTraceStoreCache();

    const stored = readRecords(location, WS);
    expect(stored.skippedLines).toBe(0);
    expect(stored.records.map((record) => [record.turnId, record.runtime?.provider])).toEqual([
      ["turn-0", undefined],
      ["turn-1", "bm-worker"],
    ]);
  });
});

describe("evidence extraction", () => {
  it("records shell commands, written files and sub-agent traces", () => {
    const at = "2026-09-16T10:00:00.000Z";
    expect(evidenceFromItem(shellCall("br close bm-a1b") as never, "a", at)[0]).toMatchObject({
      kind: "shell",
      detail: "br close bm-a1b",
    });
    expect(
      evidenceFromItem(
        {
          type: "tool_call",
          callId: "c",
          name: "Write",
          status: "completed",
          error: null,
          detail: { type: "write", filePath: "docs/design/foo.md" },
        } as never,
        "a",
        at,
      )[0],
    ).toMatchObject({ kind: "file", detail: "docs/design/foo.md" });
    expect(
      evidenceFromItem(
        {
          type: "tool_call",
          callId: "c",
          name: "Task",
          status: "completed",
          error: null,
          detail: { type: "sub_agent", subAgentType: "general", description: "review", log: "" },
        } as never,
        "a",
        at,
      )[0],
    ).toMatchObject({ kind: "agent" });
    expect(evidenceFromItem(userMessage("hi") as never, "a", at)).toEqual([]);
  });

  it("masks secrets in a recorded command before it is kept, as in messages (REQ-048b)", () => {
    const at = "2026-09-30T10:00:00.000Z";
    const env = { PASEO_PASSWORD: "hunter2-pw" } as NodeJS.ProcessEnv;
    const [flag] = evidenceFromItem(shellCall("npm publish --token s3cr3t-value --access public") as never, "a", at, env);
    expect(flag!.detail).toBe("npm publish --token [redacted] --access public");
    const [value] = evidenceFromItem(shellCall("curl -u admin:hunter2-pw https://example.test") as never, "a", at, env);
    expect(value!.detail).not.toContain("hunter2-pw");
    expect(value!.detail).toContain("[redacted]");
  });
});

describe("collection end to end", () => {
  it("appends the record with secrets already masked on disk", async () => {
    const env = { PASEO_PASSWORD: "hunter2" } as NodeJS.ProcessEnv;
    const event = turnEnded({ timeline: [userMessage("the password is hunter2")] });
    const now = () => new Date("2026-09-16T10:00:00.000Z");
    expect(await collectTurnEnded(asEvent(event), { location, env, now })).toBe(true);

    const stored = readRecords(location, WS);
    expect(stored.records).toHaveLength(1);
    const monthlyFile = join(location.tracesDir, WS, "events-202609.jsonl");
    const raw = readFileSync(monthlyFile, "utf8");
    expect(raw).not.toContain("hunter2");
    expect(raw).toContain(REDACTED);
  });

  it("writes the workspace label so an orphaned workspace stays recognisable", async () => {
    await collectTurnEnded(asEvent(turnEnded()), { location });
    const meta = JSON.parse(readFileSync(join(location.tracesDir, WS, "meta.json"), "utf8")) as {
      lastKnownName: string;
      lastKnownDirectory: string;
    };
    expect(meta).toMatchObject({ lastKnownName: "repo", lastKnownDirectory: "/Users/test/repo" });
  });

  it("does nothing, and does not throw, when tracing is disabled", async () => {
    expect(await collectTurnEnded(asEvent(turnEnded()), { location: null })).toBe(false);
  });

  it("swallows a store failure and logs it", async () => {
    const log = vi.fn();
    // A regular file where a directory component must be: `mkdir -p` through it
    // fails with ENOTDIR at once, on every platform and for every uid, root
    // included.
    //
    // What stood here before was a path inside the Linux process filesystem,
    // which hung CI for the full six-hour job limit. That filesystem exists
    // only on Linux, and under it `mkdirSync(..., { recursive: true })` never
    // returns; being synchronous, no test timeout can interrupt it. Do not
    // reach for a system path to get an unwritable directory — see
    // docs/archive/design/paseo-bm-delta-20260921-ci-linux-hang.md for the diagnosis.
    const blocker = join(home, "not-a-directory");
    writeFileSync(blocker, "");
    const broken = { tracesDir: join(blocker, "traces") };
    expect(await collectTurnEnded(asEvent(turnEnded()), { location: broken, log })).toBe(false);
    expect(log).toHaveBeenCalledTimes(1);
    expect(String(log.mock.calls[0]?.[0])).toContain("[paseo-bm]");
  });

  it("drops the turn when the workspace lock cannot be had in time", async () => {
    const log = vi.fn();
    let release!: () => void;
    const gate = new Promise<void>((resolveGate) => {
      release = resolveGate;
    });
    const holder = withWorkspaceLock(WS, async () => {
      await gate;
    });
    await new Promise((r) => setTimeout(r, 5));

    const collected = await collectTurnEnded(asEvent(turnEnded()), { location, log, lockTimeoutMs: 10 });
    expect(collected).toBe(false);
    expect(log).toHaveBeenCalledTimes(1);
    expect(String(log.mock.calls[0]?.[0])).toContain("dropped one trace record");
    expect(readRecords(location, WS).records).toEqual([]);

    release();
    await holder;
    // The next turn still records: the drop cost one trace, not the feature.
    expect(await collectTurnEnded(asEvent(turnEnded({ turnId: "turn-2" })), { location, log })).toBe(true);
  });
});

describe("registration", () => {
  it("stays quiet on a host with no lifecycle hooks at all", () => {
    // House convention (same as registerStopPropagation): one missing host
    // capability must not become three log lines — the role hook's line is the
    // informative one there.
    const log = vi.fn();
    const remove = registerCollector({}, { log });
    expect(log).not.toHaveBeenCalled();
    expect(() => remove()).not.toThrow();
  });

  it("logs once on a host that has before() but no on()", () => {
    const log = vi.fn();
    const remove = registerCollector({ before: (() => () => {}) as never }, { log });
    expect(log).toHaveBeenCalledTimes(1);
    expect(String(log.mock.calls[0]?.[0])).toContain("no trace history");
    expect(() => remove()).not.toThrow();
  });

  it("registers both hooks and removes both", () => {
    const removeStarted = vi.fn();
    const removeEnded = vi.fn();
    const on = vi.fn((name: string) => (name === "agent.turn_started" ? removeStarted : removeEnded));
    const remove = registerCollector({ on } as never, {});
    expect(on.mock.calls.map((call) => call[0])).toEqual(["agent.turn_started", "agent.turn_ended"]);
    remove();
    expect(removeStarted).toHaveBeenCalledTimes(1);
    expect(removeEnded).toHaveBeenCalledTimes(1);
  });

  it("warns once, not per turn, when the store cannot be resolved", async () => {
    const log = vi.fn();
    const handlers = new Map<string, (event: unknown, context: unknown) => Promise<void> | void>();
    const on = vi.fn((name: string, handler: (event: unknown, context: unknown) => Promise<void> | void) => {
      handlers.set(name, handler);
      return () => {};
    });
    registerCollector({ on } as never, { log, resolveLocation: async () => null });
    expect(on).toHaveBeenCalledTimes(2);

    const ended = handlers.get("agent.turn_ended")!;
    await ended(asEvent(turnEnded()), { paseo: {} });
    await ended(asEvent(turnEnded({ turnId: "turn-2" })), { paseo: {} });
    expect(log).toHaveBeenCalledTimes(1);
    expect(String(log.mock.calls[0]?.[0])).toContain("trace store unavailable");
  });

  function collectorHandlers(options: Parameters<typeof registerCollector>[1]) {
    const handlers = new Map<string, (event: unknown, context: unknown) => Promise<void> | void>();
    const on = vi.fn((name: string, handler: (event: unknown, context: unknown) => Promise<void> | void) => {
      handlers.set(name, handler);
      return () => {};
    });
    registerCollector({ on } as never, options);
    return handlers;
  }

  it("runs onRecorded only after the turn's record can be read (delta 20260917c §4.7)", async () => {
    const seen: number[] = [];
    const context = { paseo: { marker: true } };
    const onRecorded = vi.fn((_event: unknown, input: { location: { tracesDir: string }; paseo: unknown; record: { agentId: string } }) => {
      seen.push(readRecords(input.location, WS).records.length);
      expect(input.paseo).toBe(context.paseo);
      // The record just written is handed over, so a step need not read the store back.
      expect(input.record).toEqual(readRecords(input.location, WS).records[0]);
    });
    const handlers = collectorHandlers({ resolveLocation: async () => location, onRecorded });
    await handlers.get("agent.turn_ended")!(asEvent(turnEnded()), context);
    expect(onRecorded).toHaveBeenCalledTimes(1);
    expect(seen).toEqual([1]);
  });

  it("does not run onRecorded when nothing was recorded", async () => {
    const onRecorded = vi.fn();
    // No store at all: the handler returns before collecting.
    const noStore = collectorHandlers({ resolveLocation: async () => null, onRecorded, log: () => {} });
    await noStore.get("agent.turn_ended")!(asEvent(turnEnded()), { paseo: {} });
    // A store, but a turn the collector does not record (not a paseo-bm agent).
    const handlers = collectorHandlers({ resolveLocation: async () => location, onRecorded, log: () => {} });
    const foreign = turnEnded();
    foreign.agent = { ...foreign.agent, provider: "claude" };
    await handlers.get("agent.turn_ended")!(asEvent(foreign), { paseo: {} });
    expect(readRecords(location, WS).records).toHaveLength(0);
    expect(onRecorded).not.toHaveBeenCalled();
  });

  it("logs a failing onRecorded instead of throwing into the agent's turn", async () => {
    const log = vi.fn();
    const handlers = collectorHandlers({
      resolveLocation: async () => location,
      log,
      onRecorded: async () => {
        throw new Error("budget boom");
      },
    });
    await expect(handlers.get("agent.turn_ended")!(asEvent(turnEnded()), { paseo: {} })).resolves.toBeUndefined();
    expect(readRecords(location, WS).records).toHaveLength(1);
    // Contained by its own guard, not by the collector's last line of defence:
    // the record is already written, so "trace collection failed" would be false.
    const lines = log.mock.calls.map((call) => String(call[0]));
    expect(lines).toEqual(["[paseo-bm] after-record step failed: budget boom"]);
  });

  it("resolves the store from the hook context and records through it", async () => {
    const handlers = new Map<string, (event: unknown, context: unknown) => Promise<void> | void>();
    const on = vi.fn((name: string, handler: (event: unknown, context: unknown) => Promise<void> | void) => {
      handlers.set(name, handler);
      return () => {};
    });
    const resolveLocation = vi.fn(async () => location);
    registerCollector({ on } as never, { resolveLocation });

    handlers.get("agent.turn_started")!(asEvent(turnEnded()), { paseo: {} });
    await handlers.get("agent.turn_ended")!(asEvent(turnEnded()), { paseo: {} });
    expect(resolveLocation).toHaveBeenCalledTimes(1);
    expect(readRecords(location, WS).records).toHaveLength(1);
    expect(readRecords(location, WS).records[0]?.startedAt).not.toBeNull();
  });

  it("hands every turn start's Paseo handle to onStarted, and contains its failure", () => {
    const handlers = new Map<string, (event: unknown, context: unknown) => Promise<void> | void>();
    const on = vi.fn((name: string, handler: (event: unknown, context: unknown) => Promise<void> | void) => {
      handlers.set(name, handler);
      return () => {};
    });
    const given: unknown[] = [];
    const log = vi.fn();
    let fail = false;
    registerCollector({ on } as never, {
      log,
      onStarted: (paseo) => {
        if (fail) throw new Error("boom");
        given.push(paseo);
      },
    });
    const paseo = { agents: {} };
    handlers.get("agent.turn_started")!(asEvent(turnEnded()), { paseo });
    handlers.get("agent.turn_started")!(asEvent(turnEnded()), {});
    expect(given).toEqual([paseo]);
    fail = true;
    expect(() => handlers.get("agent.turn_started")!(asEvent(turnEnded()), { paseo })).not.toThrow();
    expect(String(log.mock.calls[0]?.[0])).toContain("turn-start step failed: boom");
  });

  it("never lets a resolver failure escape into the agent turn", async () => {
    const log = vi.fn();
    const handlers = new Map<string, (event: unknown, context: unknown) => Promise<void> | void>();
    const on = vi.fn((name: string, handler: (event: unknown, context: unknown) => Promise<void> | void) => {
      handlers.set(name, handler);
      return () => {};
    });
    registerCollector({ on } as never, {
      log,
      resolveLocation: async () => {
        throw new Error("config exploded");
      },
    });
    await expect(handlers.get("agent.turn_ended")!(asEvent(turnEnded()), { paseo: {} })).resolves.toBeUndefined();
    expect(String(log.mock.calls[0]?.[0])).toContain("trace collection failed");
  });
});

/**
 * WP-214, D-8's delete leg: every one of F-1's 14 Worker records had no
 * request id, because a Worker's later turns rarely repeat it. The agent's own
 * `bm.requestId` label is read from the refetch snapshot instead.
 */
describe("request id from the agent's label", () => {
  it("stamps every turn of a labelled agent with its request id", async () => {
    const refetch = vi.fn(async () => ({
      entries: [{ item: userMessage("keep going"), turnId: "turn-1", timestamp: "2026-09-16T10:00:01.000Z" }],
      agent: { model: "claude-opus-5", lastUsage: null, labels: { "bm.role": "worker", "bm.requestId": "req-20260916T064147Z" } },
    }));
    const built = await buildRecord(asEvent(turnEnded({ timeline: [userMessage("keep going")] })), {
      location: null,
      paseo: { agents: { ref: () => ({ timeline: { refetch } }) } },
    });
    expect(built?.record.requestId).toBe("req-20260916T064147Z");
  });
});

/**
 * Owner request 2026-09-16, both facts verified on the real daemon: a message
 * typed in Paseo's app carries `clientMessageId` (15/15 on the owner's
 * Manager) and an agent's `send_agent_prompt` does not (43/43); Claude Code
 * loads a skill as a `Skill` tool call with the name in `detail.label`.
 */
describe("who wrote a message", () => {
  it("marks app-typed messages as the user's and agent-sent ones as an agent's", async () => {
    const typed = { type: "user_message" as const, text: "dùng cột amount_xu", messageId: "m1", clientMessageId: "c1" };
    const relayed = { type: "user_message" as const, text: "BM-REPORT\nphase: received", messageId: "m2" };
    const built = await buildRecord(asEvent(turnEnded({ timeline: [relayed, typed] })), { location: null });
    // The slice keeps the last user message onwards: the typed one.
    expect(built?.record.sent.map((message) => message.origin)).toEqual(["user"]);
    const onlyRelayed = await buildRecord(asEvent(turnEnded({ timeline: [relayed] })), { location: null });
    expect(onlyRelayed?.record.sent[0]?.origin).toBe("agent");
  });

  /**
   * `/bm-worker-new` puts a flag line in front of the user's request so the
   * Manager knows not to fold it into whatever is running (delta 20260917f).
   * The flag is the plugin's, the request is theirs: the line comes off here
   * and the message stays the user's. Treat it as a plugin notice instead and
   * `firstUserText` would skip the whole thing, so Work would show
   * a request with no words in it.
   */
  it("takes the new-request flag off, and still calls the message the user's", async () => {
    const flagged = {
      type: "user_message" as const,
      text: `${NEW_REQUEST_MARKER}\nSửa giúp tôi cái CI đang đỏ`,
      messageId: "m3",
      clientMessageId: "c3",
    };
    const built = await buildRecord(asEvent(turnEnded({ timeline: [flagged] })), { location: null });
    expect(built?.record.sent[0]?.text).toBe("Sửa giúp tôi cái CI đang đỏ");
    expect(built?.record.sent[0]?.origin).toBe("user");
  });
});

describe("plugin notices and streamed chunks", () => {
  // As the Reviewer e5fc4c82 received it on 2026-09-24.
  const notice = [
    "BM-FORMAT requestId: req-20260924T065116Z",
    "Your last BM-REVIEW broke the template:",
    "- BM-REVIEW checked: is missing",
    "- BM-REVIEW verdict: must be pass or changes-required",
    "Answer with the whole corrected BM-REVIEW block as your final message; do not review again.",
  ].join("\n");

  it("records a notice as a message, never as the review or report it names", async () => {
    const built = await buildRecord(asEvent(turnEnded({ timeline: [{ type: "user_message" as const, text: notice, messageId: "m1", clientMessageId: "c1" }] })), { location: null });
    expect(built?.record.sent[0]?.origin).toBe("agent");
    expect(built?.record.reviews).toEqual([]);
    expect(built?.record.reports).toEqual([]);
  });

  it("joins consecutive assistant chunks into one message, and nothing else", () => {
    const tool = { type: "tool_call", name: "Shell" };
    const joined = joinStreamedText([
      { type: "assistant_message", text: "Checking." },
      tool,
      { type: "assistant_message", text: "BM-REVIEW\nrequ", messageId: "a" },
      { type: "assistant_message", text: "estId: req-1", messageId: "a" },
      { type: "assistant_message", text: "Another message.", messageId: "b" },
      { type: "user_message", text: "hi" },
      { type: "user_message", text: "again" },
    ]);
    expect(joined.map((item) => (item as { text?: string }).text ?? "tool")).toEqual([
      "Checking.",
      "tool",
      "BM-REVIEW\nrequestId: req-1\n\nAnother message.",
      "hi",
      "again",
    ]);
  });

  // Bead 7gxw.12: the replay counted 7.48 reviews per reviewed request against a budget of 2 / 2 / 4.
  it("counts a review once, in its Reviewer's own reply: a re-review prompt quoting it and a Manager relaying it add none", async () => {
    const review = "BM-REVIEW\nrequestId: req-1\nbatchId: b1\nverdict: changes-required\nfindings:\n- severity: blocking\n  location: a.ts:1";
    const reviewer = { ...turnEnded().agent, id: "agent-reviewer", provider: "bm-reviewer/gpt-5.6", parentAgentId: "agent-worker" };
    const reReview = userMessage(`Re-review batch b1. Your review was:\n\n${review}\n\nThe blocking finding is fixed.`);
    const answer = assistantMessage("BM-REVIEW\nrequestId: req-1\nbatchId: b1\nverdict: pass\nfindings: none");
    const reviewed = await buildRecord(asEvent(turnEnded({ agent: reviewer, timeline: [reReview, answer] })), { location: null });
    expect(reviewed?.record.reviews).toMatchObject([{ agentId: "agent-reviewer", batchId: "b1", verdict: "pass", blockingCount: 0 }]);

    const manager = { ...turnEnded().agent, id: "agent-manager", provider: "bm-manager", parentAgentId: null };
    const relayed = await buildRecord(asEvent(turnEnded({ agent: manager, timeline: [userMessage(review), assistantMessage(`The Reviewer said:\n\n${review}`)] })), { location: null });
    expect(relayed?.record.reviews).toEqual([]);
    const worker = await buildRecord(asEvent(turnEnded({ timeline: [userMessage(review), assistantMessage(review)] })), { location: null });
    expect(worker?.record.reviews).toEqual([]);
  });
});

describe("skills an agent loaded", () => {
  const call = (name: string, detail: Record<string, unknown>) => ({
    type: "tool_call" as const,
    callId: "c1",
    name,
    status: "completed" as const,
    error: null,
    detail,
  });

  it("reads Claude Code's Skill tool call (verbatim shape)", () => {
    const item = call("Skill", {
      type: "plain_text",
      label: "feature-workflow",
      icon: "sparkles",
      text: "Launching skill: feature-workflow",
    });
    expect(skillsFromItem(item as never)).toEqual(["feature-workflow"]);
    expect(evidenceFromItem(item as never, "w1", "2026-09-16T10:00:00.000Z")).toEqual([
      { kind: "skill", detail: "feature-workflow", agentId: "w1", at: "2026-09-16T10:00:00.000Z" },
    ]);
  });

  it("counts reading a SKILL.md, from a file read or a shell read", () => {
    expect(skillsFromItem(call("Read", { type: "read", filePath: "/Users/x/.agents/skills/implementing-beads/SKILL.md" }) as never)).toEqual([
      "implementing-beads",
    ]);
    const shell = call("Bash", { type: "shell", command: "sed -n 1,200p ~/.codex/skills/polishing-beads/SKILL.md" });
    expect(skillsFromItem(shell as never)).toEqual(["polishing-beads"]);
    // The shell command itself is still recorded as shell evidence.
    expect(evidenceFromItem(shell as never, "w1", "t").map((entry) => entry.kind)).toEqual(["skill", "shell"]);
  });

  it("does not count looking for a skill as loading it", () => {
    // The Manager checks skills exactly like this, without loading any.
    const check = call("Bash", {
      type: "shell",
      command: 'for s in feature-workflow reviewing-plan; do test -f "$d/$s/SKILL.md" && echo ok; ls ~/.claude/skills/$s/SKILL.md; done',
    });
    expect(skillsFromItem(check as never)).toEqual([]);
  });
});

describe("the plugin version on every record (evaluation design §3)", () => {
  it("is written as the version of the plugin that built the record", async () => {
    const built = await buildRecord(asEvent(turnEnded()), { location: null });
    expect(built!.record.pluginVersion).toBe(PLUGIN_VERSION);
  });

  it("a record written before the field parses with the new reader, without a version", async () => {
    const built = await buildRecord(asEvent(turnEnded()), { location: null });
    const older = JSON.parse(JSON.stringify(built!.record)) as Record<string, unknown>;
    delete older.pluginVersion;
    const parsed = traceRecordSchema.parse(older);
    expect(parsed.pluginVersion).toBeUndefined();
    expect(parsed.v).toBe(1);
  });

  it("a reader that predates the field drops it and reads the rest the same", async () => {
    const built = await buildRecord(asEvent(turnEnded()), { location: null });
    const onDisk = JSON.parse(JSON.stringify(built!.record)) as unknown;
    const olderReader = traceRecordSchema.omit({ pluginVersion: true });
    const parsed = olderReader.parse(onDisk);
    expect(parsed).not.toHaveProperty("pluginVersion");
    const rest: Record<string, unknown> = { ...traceRecordSchema.parse(onDisk) };
    delete rest.pluginVersion;
    expect(parsed).toEqual(rest);
  });
});

/**
 * Autonomy design §G.2 (bead t9lm.21): what context measurement needs from each
 * record. The entry shapes are the ones the isolated Paseo 0.9.2 daemon
 * produced on 2026-09-30 for Claude, Codex and OpenCode (run note
 * `docs/archive/operations/paseo-bm-context-fields-run-20260930.md`).
 */
describe("context, compaction and tool calls per turn (autonomy design §G.2)", () => {
  const T = "2026-09-30T05:30:00.000Z";
  const entry = (item: unknown, turnId = "turn-1") => ({ item, turnId, timestamp: T });
  const tool = (callId: string, name: string, detail: Record<string, unknown>, status = "completed") => ({
    type: "tool_call" as const,
    callId,
    name,
    status,
    error: status === "failed" ? { message: "exit 1" } : null,
    detail,
  });
  const compaction = (fields: Record<string, unknown>) => ({ type: "compaction" as const, ...fields });

  async function recordOf(entries: unknown[], agent: unknown = { model: "claude-haiku-4-5", lastUsage: null }, timeline: unknown[] = []) {
    const refetch = vi.fn(async () => ({ entries, agent }));
    const built = await buildRecord(asEvent(turnEnded({ timeline })), {
      location: null,
      paseo: { agents: { ref: () => ({ timeline: { refetch } }) } },
    });
    return built!.record;
  }

  it.each([
    [
      "Claude",
      { inputTokens: 34, cachedInputTokens: 88287, outputTokens: 423, totalCostUsd: 0.0826, contextWindowMaxTokens: 200000, contextWindowUsedTokens: 29826 },
      { contextUsed: 29826, contextMax: 200000 },
    ],
    [
      "Codex",
      { inputTokens: 21573, cachedInputTokens: 21248, outputTokens: 5, contextWindowMaxTokens: 258400, contextWindowUsedTokens: 21578 },
      { contextUsed: 21578, contextMax: 258400 },
    ],
    [
      "OpenCode",
      { inputTokens: 35, cachedInputTokens: 19383, outputTokens: 3, contextWindowMaxTokens: 200000, contextWindowUsedTokens: 19421 },
      { contextUsed: 19421, contextMax: 200000 },
    ],
  ])("keeps the context %s reports with the turn's tokens", async (_provider, lastUsage, context) => {
    const record = await recordOf([entry(userMessage("go"))], { model: "m", lastUsage });
    expect(record.usage).toMatchObject({
      inputTokens: lastUsage.inputTokens,
      cachedInputTokens: lastUsage.cachedInputTokens,
      outputTokens: lastUsage.outputTokens,
      ...context,
    });
    expect(traceRecordSchema.parse(record).usage).toMatchObject(context);
  });

  it("leaves the context fields out when the provider does not report them — never zero", async () => {
    const tokensOnly = await recordOf([entry(userMessage("go"))], {
      model: "claude-opus-5-5",
      lastUsage: { inputTokens: 4, cachedInputTokens: 100, outputTokens: 2, totalCostUsd: 0.4 },
    });
    expect(tokensOnly.usage).toMatchObject({ inputTokens: 4, cachedInputTokens: 100, outputTokens: 2 });
    expect(tokensOnly.usage).not.toHaveProperty("contextUsed");
    expect(tokensOnly.usage).not.toHaveProperty("contextMax");

    // A value that is not a finite count is not a report either; a window of 0 is none.
    const odd = await recordOf([entry(userMessage("go"))], {
      model: "m",
      lastUsage: { inputTokens: 1, cachedInputTokens: 0, outputTokens: 1, contextWindowUsedTokens: "12", contextWindowMaxTokens: 0 },
    });
    expect(odd.usage).not.toHaveProperty("contextUsed");
    expect(odd.usage).not.toHaveProperty("contextMax");
    expect(traceRecordSchema.safeParse(odd).success).toBe(true);
  });

  it.each([
    [
      "Claude: the trigger and the size before it on the completed item",
      [compaction({ status: "loading" }), compaction({ status: "completed", trigger: "manual", preTokens: 29827 })],
      { trigger: "manual", preTokens: 29827, detail: "manual" },
    ],
    [
      "Codex: the trigger on both items, no size",
      [compaction({ status: "loading", trigger: "manual" }), compaction({ status: "completed", trigger: "manual" })],
      { trigger: "manual", preTokens: null, detail: "manual" },
    ],
    [
      "OpenCode: the trigger on the loading item only",
      [compaction({ status: "loading", trigger: "manual" }), compaction({ status: "completed" })],
      { trigger: "manual", preTokens: null, detail: "manual" },
    ],
    [
      "an automatic one, nothing said but the status",
      [compaction({ status: "completed" })],
      { trigger: null, preTokens: null, detail: "unknown" },
    ],
  ])("a compaction becomes one piece of evidence — %s", async (_case, items, expected) => {
    const record = await recordOf([entry(userMessage("/compact")), ...items.map((item) => entry(item))]);
    expect(record.evidence).toEqual([{ kind: "compaction", agentId: "agent-worker", at: T, ...expected }]);
    expect(traceRecordSchema.parse(record).evidence[0]).toMatchObject(expected);
  });

  it("a compaction still loading when the turn ended is not evidence; two compactions are two", async () => {
    expect((await recordOf([entry(userMessage("go")), entry(compaction({ status: "loading", trigger: "auto" }))])).evidence).toEqual([]);
    const twice = await recordOf([
      entry(compaction({ status: "loading", trigger: "auto" })),
      entry(compaction({ status: "completed", trigger: "auto", preTokens: 180000 })),
      entry(tool("c1", "Bash", { type: "shell", command: "npm test" })),
      entry(compaction({ status: "loading" })),
      entry(compaction({ status: "completed", preTokens: 170000 })),
    ]);
    expect(twice.evidence.map((item) => [item.kind, item.trigger ?? null, item.preTokens ?? null])).toEqual([
      ["compaction", "auto", 180000],
      ["shell", null, null],
      // The first compaction's trigger does not leak into the second.
      ["compaction", null, 170000],
    ]);
  });

  it("counts every tool call of the turn, whatever the tool or its outcome, and none of another turn", async () => {
    const record = await recordOf([
      entry(userMessage("an older turn"), "turn-0"),
      entry(tool("c0", "Bash", { type: "shell", command: "ls" }), "turn-0"),
      entry(userMessage("go")),
      entry(tool("c1", "Bash", { type: "shell", command: "ls" })),
      entry(tool("c2", "Read", { type: "read", filePath: "/repo/package.json" })),
      entry(tool("c3", "Grep", { type: "search", query: "add" })),
      entry(tool("c4", "mcp__paseo-bm__bm_review", { type: "unknown" })),
      entry(tool("c5", "shell", { type: "shell", command: "npm test" }, "failed")),
      entry(assistantMessage("DONE")),
    ]);
    expect(record.toolCalls).toBe(5);
    // Only the shell calls are evidence; the count is of all of them.
    expect(record.evidence.map((item) => item.kind)).toEqual(["shell", "shell"]);
    expect((await recordOf([entry(userMessage("hello")), entry(assistantMessage("hi"))])).toolCalls).toBe(0);
  });

  it("a turn longer than one refetch page is counted from the hook payload too", async () => {
    // The page holds only the tail of the turn: full, and its oldest entry already in this turn.
    const page = Array.from({ length: REFETCH_LIMIT }, (_, i) => entry(tool(`p${i}`, "Bash", { type: "shell", command: "ls" })));
    const whole = [
      userMessage("an older turn"),
      tool("old", "Bash", { type: "shell", command: "ls" }),
      userMessage("go"),
      ...Array.from({ length: REFETCH_LIMIT + 50 }, (_, i) => tool(`h${i}`, "Bash", { type: "shell", command: "ls" })),
    ];
    expect((await recordOf(page, undefined, whole)).toolCalls).toBe(REFETCH_LIMIT + 50);
    // A full page that starts in an earlier turn is the whole of this one.
    const fits = [entry(userMessage("before"), "turn-0"), ...page.slice(1)];
    expect((await recordOf(fits, undefined, whole)).toolCalls).toBe(REFETCH_LIMIT - 1);
  });

  it("without the refetch, counts the tool calls of the hook payload's last turn", async () => {
    const built = await buildRecord(
      asEvent(turnEnded({ timeline: [userMessage("old"), shellCall("ls"), userMessage("new"), shellCall("ls"), shellCall("pwd")] })),
      { location: null },
    );
    expect(built!.record.toolCalls).toBe(2);
  });

  it("a record written before these fields parses, and reads them as unknown", async () => {
    const built = await recordOf([entry(userMessage("go")), entry(tool("c1", "Bash", { type: "shell", command: "ls" }))], {
      model: "m",
      lastUsage: { inputTokens: 1, cachedInputTokens: 2, outputTokens: 3, contextWindowUsedTokens: 6, contextWindowMaxTokens: 200000 },
    });
    const older = JSON.parse(JSON.stringify(built)) as Record<string, unknown> & { usage: Record<string, unknown> };
    delete older.toolCalls;
    delete older.usage.contextUsed;
    delete older.usage.contextMax;
    const parsed = traceRecordSchema.parse(older);
    expect(parsed.toolCalls).toBeUndefined();
    expect(parsed.usage).not.toHaveProperty("contextUsed");
    expect(parsed.usage?.inputTokens).toBe(1);
  });
});

/**
 * Autonomy design §C.1 (bead 7gxw.2): a `shell` entry keeps the call's
 * `status`, `exitCode`, `cwd` and `callId`, and every `detail` is masked. The
 * shapes are the ones an isolated Paseo 0.9.2 daemon produced on 2026-09-30 for
 * one passing (`node --version`) and one failing (`node -e "process.exit(3)"`)
 * command per provider, with the paths replaced.
 */
describe("richer shell evidence (autonomy design §C.1)", () => {
  const T = "2026-09-30T14:18:25.963Z";
  const REPO = "/Users/test/repo";

  const claudePassed = {
    type: "tool_call",
    callId: "toolu_019YSXB2SNdEBnTpEZJRLsij",
    name: "Bash",
    detail: { type: "shell", command: "node --version", output: "v26.8.2" },
    status: "completed",
    error: null,
  };
  const claudeFailed = {
    type: "tool_call",
    callId: "toolu_01SCQjZyDrSsFYvYsD7Ci771",
    name: "Bash",
    detail: { type: "shell", command: 'node -e "process.exit(3)"' },
    status: "failed",
    error: { type: "tool_result", content: "Exit code 3", is_error: true, tool_use_id: "toolu_01SCQjZyDrSsFYvYsD7Ci771" },
  };
  const codexPassed = {
    type: "tool_call",
    callId: "exec-06710c86-d30e-4b8b-ad45-44bc648f0213",
    name: "shell",
    status: "completed",
    error: null,
    detail: { type: "shell", command: "node --version", cwd: REPO, output: "v26.8.2\n", exitCode: 0 },
  };
  const codexFailed = {
    type: "tool_call",
    callId: "exec-41c5b723-f995-4738-9b39-3a6fb4187be1",
    name: "shell",
    status: "failed",
    error: { message: "Tool call failed" },
    detail: { type: "shell", command: 'node -e "process.exit(3)"', cwd: REPO, exitCode: 3 },
  };
  const openCodePassed = {
    type: "tool_call",
    callId: "call_function_8d0ukxghxiur_1",
    name: "bash",
    status: "completed",
    detail: { type: "shell", command: "node --version", output: "v26.8.2\n" },
    error: null,
    metadata: { output: "v26.8.2\n", exit: 0, truncated: false },
  };
  const openCodeFailed = {
    type: "tool_call",
    callId: "call_function_368wwoik1kee_1",
    name: "bash",
    status: "completed",
    detail: { type: "shell", command: 'node -e "process.exit(3)"', output: "(no output)" },
    error: null,
    metadata: { output: "(no output)", exit: 3, truncated: false },
  };

  const shellOf = (item: unknown, env?: NodeJS.ProcessEnv) => {
    const entries = evidenceFromItem(item as never, "w1", T, env);
    expect(entries).toHaveLength(1);
    return entries[0]!;
  };

  it("Claude: a failed call keeps status failed and its callId, with no exit code; a completed one keeps no output", () => {
    // The bead's acceptance shape, then the captured one.
    const failed = shellOf({ type: "tool_call", callId: "c1", name: "Bash", status: "failed", error: { message: "exit 1" }, detail: { type: "shell", command: "npm test" } });
    expect(failed).toEqual({ kind: "shell", detail: "npm test", agentId: "w1", at: T, status: "failed", callId: "c1" });
    expect(failed).not.toHaveProperty("exitCode");
    expect(failed).not.toHaveProperty("cwd");

    expect(shellOf(claudeFailed)).toEqual({ kind: "shell", detail: 'node -e "process.exit(3)"', agentId: "w1", at: T, status: "failed", callId: claudeFailed.callId });
    const passed = shellOf(claudePassed);
    expect(passed).toEqual({ kind: "shell", detail: "node --version", agentId: "w1", at: T, status: "completed", callId: claudePassed.callId });
    expect(JSON.stringify(passed)).not.toContain("v26.8.2");
  });

  it("Codex: exit code 0 and non-zero, and the folder it ran in", () => {
    expect(shellOf(codexPassed)).toEqual({ kind: "shell", detail: "node --version", agentId: "w1", at: T, status: "completed", exitCode: 0, cwd: REPO, callId: codexPassed.callId });
    expect(shellOf(codexFailed)).toEqual({ kind: "shell", detail: 'node -e "process.exit(3)"', agentId: "w1", at: T, status: "failed", exitCode: 3, cwd: REPO, callId: codexFailed.callId });
  });

  it("OpenCode: a failing command is completed too, so its exit code comes from metadata.exit", () => {
    expect(shellOf(openCodePassed)).toEqual({ kind: "shell", detail: "node --version", agentId: "w1", at: T, status: "completed", exitCode: 0, callId: openCodePassed.callId });
    expect(shellOf(openCodeFailed)).toEqual({ kind: "shell", detail: 'node -e "process.exit(3)"', agentId: "w1", at: T, status: "completed", exitCode: 3, callId: openCodeFailed.callId });
  });

  it("an exit code is kept only as the provider gave it: the detail's first, null when it said none, never a guess", () => {
    const call = (detail: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ type: "tool_call", callId: "c9", name: "shell", status: "completed", error: null, detail: { type: "shell", command: "ls", ...detail }, ...extra });
    expect(shellOf(call({ exitCode: 2 }, { metadata: { exit: 0 } })).exitCode).toBe(2);
    expect(shellOf(call({ exitCode: null })).exitCode).toBeNull();
    expect(shellOf(call({ exitCode: null }, { metadata: { exit: 1 } })).exitCode).toBe(1);
    expect(shellOf(call({ exitCode: "0" }))).not.toHaveProperty("exitCode");
    expect(shellOf(call({ exitCode: 1.5 }))).not.toHaveProperty("exitCode");
    expect(shellOf(call({}, { metadata: { exit: "3" } }))).not.toHaveProperty("exitCode");
    // No status, no callId, a blank folder: the fields are left out, not invented.
    const bare = shellOf({ type: "tool_call", name: "shell", detail: { type: "shell", command: "ls", cwd: "  " } });
    expect(Object.keys(bare).sort()).toEqual(["agentId", "at", "detail", "kind"]);
  });

  it("the fields reach the record and the store, and no output does", async () => {
    const entries = [userMessage("go"), codexPassed, codexFailed, openCodeFailed, claudeFailed].map((item, index) => ({ item, turnId: "turn-1", timestamp: `2026-09-30T14:18:2${index}.000Z` }));
    const refetch = vi.fn(async () => ({ entries, agent: { model: "gpt-5.6-luna", lastUsage: null } }));
    const now = () => new Date("2026-09-30T14:19:00.000Z");
    expect(await collectTurnEnded(asEvent(turnEnded()), { location, now, paseo: { agents: { ref: () => ({ timeline: { refetch } }) } } })).toBe(true);

    const [record] = readRecords(location, WS).records;
    expect(record!.evidence.map((entry) => [entry.status, entry.exitCode ?? "none", entry.cwd ?? "none", entry.callId])).toEqual([
      ["completed", 0, REPO, codexPassed.callId],
      ["failed", 3, REPO, codexFailed.callId],
      ["completed", 3, "none", openCodeFailed.callId],
      ["failed", "none", "none", claudeFailed.callId],
    ]);
    const raw = readFileSync(join(location.tracesDir, WS, "events-202609.jsonl"), "utf8");
    expect(raw).not.toContain("v26.8.2");
    expect(raw).not.toContain("(no output)");
    expect(raw).not.toContain("Exit code 3");
  });

  it("a record written before these fields parses and reads back unchanged; v does not move", async () => {
    const before = {
      v: 1,
      kind: "turn",
      at: "2026-09-29T10:00:00.000Z",
      workspaceId: WS,
      agentId: "agent-worker",
      role: "worker",
      turnId: "turn-0",
      requestId: "req-old",
      parentAgentId: "agent-manager",
      agentCreatedAt: null,
      startedAt: null,
      endedAt: "2026-09-29T10:00:00.000Z",
      outcome: "completed",
      sent: [],
      received: [],
      reports: [],
      reviews: [],
      evidence: [
        { kind: "shell", detail: "npm test", agentId: "agent-worker", at: "2026-09-29T10:00:00.000Z" },
        { kind: "file", detail: "/Users/test/repo/math.js", agentId: "agent-worker", at: "2026-09-29T10:00:00.000Z" },
      ],
      usage: null,
      runtime: null,
      pluginVersion: "0.4.1",
    };
    expect(traceRecordSchema.parse(before)).toEqual(before);
    expect(TRACE_STORE_SCHEMA_VERSION).toBe(1);

    // Beside a new record in the same file, it still reads, and reads the same.
    const refetch = vi.fn(async () => ({ entries: [{ item: codexFailed, turnId: "turn-1", timestamp: T }], agent: null }));
    const now = () => new Date("2026-09-30T14:19:00.000Z");
    expect(await collectTurnEnded(asEvent(turnEnded()), { location, now, paseo: { agents: { ref: () => ({ timeline: { refetch } }) } } })).toBe(true);
    const monthlyFile = join(location.tracesDir, WS, "events-202609.jsonl");
    writeFileSync(monthlyFile, `${JSON.stringify(before)}\n${readFileSync(monthlyFile, "utf8")}`);
    clearTraceStoreCache();

    const stored = readRecords(location, WS);
    expect(stored.skippedLines).toBe(0);
    const byTurn = new Map(stored.records.map((record) => [record.turnId, record]));
    expect(byTurn.get("turn-0")).toEqual(before);
    expect(byTurn.get("turn-1")!.v).toBe(1);
    expect(byTurn.get("turn-1")!.evidence[0]).toMatchObject({ status: "failed", exitCode: 3, callId: codexFailed.callId });
  });

  it("a reader built before these fields drops them and reads the rest the same", async () => {
    const built = await buildRecord(asEvent(turnEnded({ timeline: [userMessage("go"), codexFailed] })), { location: null });
    const onDisk = JSON.parse(JSON.stringify(built!.record)) as unknown;
    const olderReader = traceRecordSchema.extend({ evidence: evidenceSchema.omit({ status: true, exitCode: true, cwd: true, callId: true }).array() });
    const parsed = olderReader.parse(onDisk);
    expect(parsed.evidence).toEqual([{ kind: "shell", detail: 'node -e "process.exit(3)"', agentId: "agent-worker", at: expect.any(String) }]);
  });

  it("masks a secret in every detail and in the folder before it is kept: shell, file, skill and sub-agent", async () => {
    const env = { PASEO_PASSWORD: "hunter2-pw" } as NodeJS.ProcessEnv;
    const shell = {
      ...codexPassed,
      detail: { type: "shell", command: "deploy --token abc && echo hunter2-pw", cwd: "/Users/test/hunter2-pw/repo --token abc", exitCode: 0 },
    };
    const [command] = evidenceFromItem(shell as never, "w1", T, env);
    expect(command!.detail).toBe(`deploy --token ${REDACTED} && echo ${REDACTED}`);
    expect(command!.cwd).toBe(`/Users/test/${REDACTED}/repo --token ${REDACTED}`);

    const tool = (name: string, detail: Record<string, unknown>) => ({ type: "tool_call", callId: "c2", name, status: "completed", error: null, detail });
    const [file] = evidenceFromItem(tool("Write", { type: "write", filePath: "/Users/test/repo/hunter2-pw.txt" }) as never, "w1", T, env);
    expect(file).toMatchObject({ kind: "file", detail: `/Users/test/repo/${REDACTED}.txt` });
    const [skill] = evidenceFromItem(tool("Skill", { type: "plain_text", label: "deploy --token abc hunter2-pw" }) as never, "w1", T, env);
    expect(skill).toMatchObject({ kind: "skill", detail: `deploy --token ${REDACTED} ${REDACTED}` });
    const [agent] = evidenceFromItem(tool("Task", { type: "sub_agent", subAgentType: "general", description: "use --token abc and hunter2-pw", log: "" }) as never, "w1", T, env);
    expect(agent).toMatchObject({ kind: "agent", detail: `general — use --token ${REDACTED} and ${REDACTED}` });

    // And on disk: neither value is anywhere in the file.
    const refetch = vi.fn(async () => ({ entries: [shell].map((item) => ({ item, turnId: "turn-1", timestamp: T })), agent: null }));
    const now = () => new Date("2026-09-30T14:19:00.000Z");
    expect(await collectTurnEnded(asEvent(turnEnded()), { location, now, env, paseo: { agents: { ref: () => ({ timeline: { refetch } }) } } })).toBe(true);
    const raw = readFileSync(join(location.tracesDir, WS, "events-202609.jsonl"), "utf8");
    expect(raw).not.toContain("hunter2-pw");
    expect(raw).not.toMatch(/--token abc/);
  });
});

/**
 * Autonomy design §G.5 (bead 7gxw.10): the plugin's `/compact` is a
 * `user_message` with a `clientMessageId` and no marker, so only the plugin's
 * send log tells it from the owner's; the `BM-STATE` brief after it carries
 * its marker. Neither is ever the owner's words — not for A-6, the owner's
 * texts, a new request segment or an answer in chat.
 */
describe("what the plugin sent for a compaction", () => {
  const typed = (text: string) => ({ type: "user_message" as const, text, messageId: "m1", clientMessageId: "c1" });

  it("a /compact matching the plugin's send log is the plugin's; the same text with no entry stays the owner's; a leading /compact decides nothing", async () => {
    const seen: Array<[string, string, string | null]> = [];
    const pluginSent = (agentId: string, text: string, at: string | null) => {
      seen.push([agentId, text, at]);
      return agentId === "agent-worker" && text === "/compact";
    };
    const now = () => new Date("2026-09-30T12:00:00.000Z");
    const plugin = await buildRecord(asEvent(turnEnded({ timeline: [typed("/compact")] })), { location: null, now, pluginSent });
    expect(plugin?.record.sent).toMatchObject([{ text: "/compact", origin: "agent" }]);
    expect(seen).toEqual([["agent-worker", "/compact", "2026-09-30T12:00:00.000Z"]]);
    // The owner's own /compact (no entry), or one of another agent: the owner's.
    const owner = await buildRecord(asEvent(turnEnded({ timeline: [typed("/compact keep the tests")] })), { location: null, now, pluginSent });
    expect(owner?.record.sent).toMatchObject([{ origin: "user" }]);
    const manager = await buildRecord(asEvent(turnEnded({ agent: { ...turnEnded().agent, id: "agent-manager", provider: "bm-manager" }, timeline: [typed("/compact")] })), { location: null, now, pluginSent });
    expect(manager?.record.sent).toMatchObject([{ origin: "user" }]);
    // No send log (no trace store): as before, the owner's.
    expect((await buildRecord(asEvent(turnEnded({ timeline: [typed("/compact")] })), { location: null, now }))?.record.sent).toMatchObject([{ origin: "user" }]);
  });

  it("the BM-STATE brief is a plugin notice, and its report-like lines are never parsed as a report; a relayed message is never looked up", async () => {
    const lookups: string[] = [];
    const pluginSent = (_agentId: string, text: string) => {
      lookups.push(text);
      return false;
    };
    const brief = "BM-STATE\nFrom the paseo-bm plugin, not the owner: your context was just compacted.\nrole: worker\nrequestId: req-20260930T100000Z\nlastReport: finished at t";
    const built = await buildRecord(asEvent(turnEnded({ timeline: [typed(brief)] })), { location: null, pluginSent });
    expect(built?.record.sent).toMatchObject([{ origin: "agent" }]);
    expect(built?.record.reports).toEqual([]);
    const relayed = await buildRecord(asEvent(turnEnded({ timeline: [{ type: "user_message" as const, text: "/compact", messageId: "m2" }] })), { location: null, pluginSent });
    expect(relayed?.record.sent).toMatchObject([{ origin: "agent" }]);
    // Only a message that would otherwise be the owner's is looked up.
    expect(lookups).toEqual([]);
  });
});
