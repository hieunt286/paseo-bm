import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NEW_REQUEST_MARKER } from "../plugin/shared/new-request";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  REDACTED,
  buildRecord,
  clearStartMarks,
  collectTurnEnded,
  evidenceFromItem,
  skillsFromItem,
  noteTurnStart,
  sliceLastTurn,
  redactText,
  registerCollector,
  type CollectorDeps,
} from "../plugin/server/collector";
import { clearTraceStoreCache, readRecords, withWorkspaceLock } from "../plugin/server/trace-store";
import { reconstructTraces } from "../plugin/server/traces";

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

  it.each(["claude", "codex/gpt-5.6-sol", "opencode", ""])("ignores %o", async (provider) => {
    const built = await buildRecord(asEvent(turnEnded({ agent: { ...turnEnded().agent, provider } })), {
      location,
    });
    expect(built).toBeNull();
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
      { kind: "shell", detail: "br create --title=x", agentId: "agent-worker", at: "2026-09-16T10:00:00.000Z" },
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

    expect(record.runtime).toEqual({ model: "claude-opus-5", thinkingOptionId: "high", modeId: "bypassPermissions" });
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

    expect(record.runtime).toEqual({ model: "claude-opus-5", thinkingOptionId: null, modeId: "auto" });
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

    expect(record.runtime).toEqual({ model: null, thinkingOptionId: null, modeId: null });
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
    // docs/design/paseo-bm-delta-20260921-ci-linux-hang.md for the diagnosis.
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
    const onRecorded = vi.fn((_event: unknown, input: { location: { tracesDir: string }; paseo: unknown }) => {
      seen.push(readRecords(input.location, WS).records.length);
      expect(input.paseo).toBe(context.paseo);
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
   * `firstUserText` would skip the whole thing, so the Metric screen would show
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
