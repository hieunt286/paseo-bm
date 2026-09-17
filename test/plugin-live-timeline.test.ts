import { describe, expect, it, vi } from "vitest";
import { mergeExtras, readLiveExtras, LIVE_MAX_PAGES, type LiveTimelinePaseo } from "../plugin/server/live-timeline";

/**
 * Skills and user messages read from an agent's own timeline when a trace is
 * opened (owner, 2026-09-16: "I don't see skill information yet" — nothing
 * had run since the collector learned to record them).
 */
const skillCall = (label: string) => ({
  type: "tool_call",
  callId: "c",
  name: "Skill",
  status: "completed",
  error: null,
  detail: { type: "plain_text", label, icon: "sparkles", text: `Launching skill: ${label}` },
});
const typed = (text: string) => ({ type: "user_message", text, messageId: "m", clientMessageId: "c" });
const relayed = (text: string) => ({ type: "user_message", text, messageId: "m" });

/** A fake timeline paged newest-first, the way Paseo 0.8 serves it. */
function fakePaseo(pages: Record<string, Array<Array<{ item: unknown; timestamp: string }>>>): {
  paseo: LiveTimelinePaseo;
  calls: Array<{ agentId: string; options: Record<string, unknown> }>;
} {
  const calls: Array<{ agentId: string; options: Record<string, unknown> }> = [];
  const paseo: LiveTimelinePaseo = {
    agents: {
      ref: (agentId) => ({
        timeline: {
          refetch: vi.fn(async (options: Record<string, unknown>) => {
            calls.push({ agentId, options });
            const list = pages[agentId];
            if (list === undefined) throw new Error("unknown agent");
            const index = options.direction === "tail" ? 0 : (options.cursor as { page: number }).page;
            return {
              entries: list[index],
              hasOlder: index + 1 < list.length,
              startCursor: { page: index + 1 },
            };
          }),
        },
      }),
    },
  };
  return { paseo, calls };
}

describe("reading an agent's timeline", () => {
  it("pages back to the start and collects skills and typed messages", async () => {
    const { paseo, calls } = fakePaseo({
      w1: [
        [{ item: typed("dùng cột amount_xu"), timestamp: "2026-09-16T08:40:00.000Z" }],
        [
          { item: relayed("TIẾP TỤC — req-X"), timestamp: "2026-09-16T08:30:00.000Z" },
          { item: skillCall("feature-workflow"), timestamp: "2026-09-16T08:20:00.000Z" },
        ],
      ],
    });
    const extras = await readLiveExtras(paseo, ["w1"], {});
    expect(extras.skills).toEqual([{ agentId: "w1", skill: "feature-workflow", at: "2026-09-16T08:20:00.000Z" }]);
    expect(extras.userMessages.map((message) => message.text)).toEqual(["dùng cột amount_xu"]);
    expect(calls.map((call) => call.options.direction)).toEqual(["tail", "before"]);
  });

  it("masks secrets before a message leaves the server", async () => {
    const { paseo } = fakePaseo({
      w1: [[{ item: typed("login with --password hunter2"), timestamp: "2026-09-16T08:40:00.000Z" }]],
    });
    const extras = await readLiveExtras(paseo, ["w1"], {});
    expect(extras.userMessages[0]?.text).toBe("login with --password [redacted]");
  });

  it("stops after a bounded number of pages", async () => {
    const endless = Array.from({ length: LIVE_MAX_PAGES + 10 }, () => [
      { item: relayed("x"), timestamp: "2026-09-16T08:00:00.000Z" },
    ]);
    const { paseo, calls } = fakePaseo({ w1: endless });
    await readLiveExtras(paseo, ["w1"], {});
    expect(calls).toHaveLength(LIVE_MAX_PAGES);
  });

  it("adds nothing for an agent it cannot read, or a host without timeline access", async () => {
    const { paseo } = fakePaseo({});
    expect(await readLiveExtras(paseo, ["gone"], {})).toEqual({ skills: [], userMessages: [] });
    expect(await readLiveExtras({ agents: {} }, ["w1"], {})).toEqual({ skills: [], userMessages: [] });
  });
});

describe("merging recorded and live entries", () => {
  it("keeps each skill and message once, oldest first", () => {
    const merged = mergeExtras(
      {
        skills: [{ agentId: "w1", skill: "feature-workflow", at: "2026-09-16T08:25:00.000Z" }],
        userMessages: [{ agentId: "w1", at: "2026-09-16T08:40:00.000Z", text: "hi", truncated: false, origin: "user" }],
      },
      {
        skills: [
          { agentId: "w1", skill: "feature-workflow", at: "2026-09-16T08:20:00.000Z" },
          { agentId: "w1", skill: "implementing-beads", at: "2026-09-16T08:22:00.000Z" },
        ],
        userMessages: [
          { agentId: "w1", at: "2026-09-16T08:40:00.000Z", text: "hi", truncated: false, origin: "user" },
          { agentId: "w1", at: "2026-09-16T08:10:00.000Z", text: "earlier", truncated: false, origin: "user" },
        ],
      },
    );
    expect(merged.skills.map((entry) => [entry.skill, entry.at])).toEqual([
      ["feature-workflow", "2026-09-16T08:20:00.000Z"],
      ["implementing-beads", "2026-09-16T08:22:00.000Z"],
    ]);
    expect(merged.userMessages.map((message) => message.text)).toEqual(["earlier", "hi"]);
  });
});
