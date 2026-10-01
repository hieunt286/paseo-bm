import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { pluginSentBeside } from "../plugin/server/collector";
import { createCompactionStore } from "../plugin/server/compaction-store";
import { mergeExtras, readLiveExtras, LIVE_MAX_PAGES, type LiveTimelinePaseo } from "../plugin/server/live-timeline";
import { STATE_NOTICE_MARKER } from "../plugin/shared/notices";
import { fakePaseo } from "./helpers/fake-paseo";

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

/** The shared fake SDK with each agent's timeline, its pages listed newest first as Paseo 0.8 serves them back from the tail. */
const daemonWith = (pages: Record<string, Array<Array<{ item: unknown; timestamp: string }>>>) =>
  fakePaseo<LiveTimelinePaseo>({ timelines: Object.fromEntries(Object.entries(pages).map(([id, list]) => [id, { pages: [...list].reverse() }])) });

describe("reading an agent's timeline", () => {
  it("pages back to the start and collects skills and typed messages", async () => {
    const { paseo, refetches } = daemonWith({
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
    expect(refetches.map((call) => call.options.direction)).toEqual(["tail", "before"]);
  });

  it("masks secrets before a message leaves the server", async () => {
    const { paseo } = daemonWith({
      w1: [[{ item: typed("login with --password hunter2"), timestamp: "2026-09-16T08:40:00.000Z" }]],
    });
    const extras = await readLiveExtras(paseo, ["w1"], {});
    expect(extras.userMessages[0]?.text).toBe("login with --password [redacted]");
  });

  it("stops after a bounded number of pages", async () => {
    const endless = Array.from({ length: LIVE_MAX_PAGES + 10 }, () => [
      { item: relayed("x"), timestamp: "2026-09-16T08:00:00.000Z" },
    ]);
    const { paseo, refetches } = daemonWith({ w1: endless });
    await readLiveExtras(paseo, ["w1"], {});
    expect(refetches).toHaveLength(LIVE_MAX_PAGES);
  });

  it("keeps the plugin's own /compact and BM-STATE out of the owner's words; the owner's own /compact stays theirs (autonomy design §G.5)", async () => {
    const home = mkdtempSync(join(tmpdir(), "bm-live-sent-"));
    try {
      // The plugin's send log, written just before it sent w1 its /compact.
      createCompactionStore(home, { now: () => new Date("2026-09-30T08:00:00.000Z") }).logSend("w1", "/compact", "cmp-1");
      const brief = `${STATE_NOTICE_MARKER}\nFrom the paseo-bm plugin, not the owner: your context was just compacted.`;
      const { paseo } = daemonWith({
        w1: [
          [
            { item: typed("/compact"), timestamp: "2026-09-30T08:00:02.000Z" },
            { item: typed(brief), timestamp: "2026-09-30T08:00:30.000Z" },
            { item: typed("keep the date format"), timestamp: "2026-09-30T08:05:00.000Z" },
            // The same text again, hours later: past the log entry's window, so the owner's.
            { item: typed("/compact"), timestamp: "2026-09-30T11:00:00.000Z" },
          ],
        ],
        // The same text typed to an agent the plugin sent nothing.
        w2: [[{ item: typed("/compact"), timestamp: "2026-09-30T08:00:02.000Z" }]],
      });
      // The collector's own matcher, over the send log beside the trace store.
      const sent = pluginSentBeside({ tracesDir: join(home, "traces") });
      const extras = await readLiveExtras(paseo, ["w1", "w2"], {}, sent);
      const owners = extras.userMessages.map(({ agentId, at, text, origin }) => ({ agentId, at, text, origin })).sort((a, b) => a.at.localeCompare(b.at) || (a.agentId ?? "").localeCompare(b.agentId ?? ""));
      // w1's /compact of 08:00:02 is the plugin's, and its brief a notice: neither is the owner's.
      expect(owners).toEqual([
        { agentId: "w2", at: "2026-09-30T08:00:02.000Z", text: "/compact", origin: "user" },
        { agentId: "w1", at: "2026-09-30T08:05:00.000Z", text: "keep the date format", origin: "user" },
        { agentId: "w1", at: "2026-09-30T11:00:00.000Z", text: "/compact", origin: "user" },
      ]);
      // Without the send log, only the BM-STATE brief is known as the plugin's (by its marker).
      const unlogged = await readLiveExtras(paseo, ["w1"], {});
      expect(unlogged.userMessages.map((message) => message.text)).toEqual(["/compact", "keep the date format", "/compact"]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("adds nothing for an agent it cannot read, or a host without timeline access", async () => {
    const fake = daemonWith({});
    fake.handle("gone").timeline.refetch.mockRejectedValue(new Error("unknown agent"));
    expect(await readLiveExtras(fake.paseo, ["gone"], {})).toEqual({ skills: [], userMessages: [] });
    expect(await readLiveExtras(fakePaseo<LiveTimelinePaseo>({ omit: ["agents.ref"] }).paseo, ["w1"], {})).toEqual({ skills: [], userMessages: [] });
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
