import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { COMMAND_LIMIT_MESSAGE, COMMAND_LIMIT_PER_REQUEST, HANDOFF_OFF_MESSAGE, INTERRUPT_REFUSED_MESSAGE, commandRefusalOf, sendCommand } from "../plugin/server/command-send";
import { createCoordinationStore } from "../plugin/server/coordination-store";
import { COORDINATION_HANDOFF_AUTHORITY, HANDOFF_INTENT, type CommandInput } from "../plugin/shared/orchestrator-command";
import { createOrchestratorStore } from "../plugin/server/orchestrator-store";
import { fakePaseo } from "./helpers/fake-paseo";

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "bm-command-send-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe("sendCommand: the stored copy (base design §9)", () => {
  it("masks secrets in what it stores, while the target gets the text as it was", async () => {
    const enqueue = vi.fn<(target: string, kind: string, text: string) => Promise<"sent">>(async () => "sent");
    const { paseo } = fakePaseo();
    const result = await sendCommand({
      home,
      now: new Date("2026-09-30T10:00:00.000Z"),
      paseo: paseo as never,
      workspaceId: "ws-1",
      command: {
        from: "orchestrator",
        via: "tab",
        to: "manager",
        requestId: "req-20260930T100000Z",
        re: "sign in with --password hunter2-secret",
        body: "Q2: the test account signs in with --password hunter2-secret; keep A4.",
        why: "The owner gave --token=tok-9f3a for the check.",
        intent: "answer",
      },
      targetId: "agent-manager",
      copyTo: null,
      grantOf: null,
      approved: [],
      backstop: false,
      loopGuard: "count",
      intervention: null,
      queue: { enqueue },
      store: { newId: () => "cmd-1" },
      redactEnv: {},
    });

    expect(result.ok).toBe(true);
    expect(enqueue.mock.calls[0]![2]).toContain("hunter2-secret");
    expect(enqueue.mock.calls[0]![2]).toContain("tok-9f3a");
    const [stored] = createOrchestratorStore(home).listCommands();
    for (const field of [stored!.situation, stored!.command, stored!.reason, stored!.sentText ?? ""]) {
      expect(field).not.toMatch(/hunter2-secret|tok-9f3a/);
    }
    expect(stored!.command).toContain("--password [redacted]");
    expect(readFileSync(join(home, "orchestrator", "proposals.json"), "utf8")).not.toMatch(/hunter2-secret|tok-9f3a/);
  });

  it("masks the plugin environment's secret values too", async () => {
    const enqueue = vi.fn<(target: string, kind: string, text: string) => Promise<"sent">>(async () => "sent");
    const { paseo } = fakePaseo();
    await sendCommand({
      home,
      now: new Date("2026-09-30T10:00:00.000Z"),
      paseo: paseo as never,
      workspaceId: "ws-1",
      command: { from: "orchestrator", via: "tab", to: "manager", requestId: null, re: "check the daemon", body: "Use daemon-pass-77 only to check.", intent: "other" },
      targetId: "agent-manager",
      copyTo: null,
      grantOf: null,
      approved: [],
      backstop: false,
      loopGuard: "count",
      intervention: null,
      queue: { enqueue },
      store: { newId: () => "cmd-2" },
      redactEnv: { PASEO_DAEMON_PASSWORD: "daemon-pass-77" },
    });
    expect(readFileSync(join(home, "orchestrator", "proposals.json"), "utf8")).not.toContain("daemon-pass-77");
  });
});

describe("commandRefusalOf: the send's checks, read without sending (design §16.9)", () => {
  const NOW = new Date("2026-10-03T10:00:00.000Z");
  const REQUEST = "req-20261003T090000Z";
  const handoff: CommandInput = {
    from: "orchestrator",
    via: "chat",
    to: "manager",
    requestId: REQUEST,
    re: "Request handed over",
    body: "For your information: Worker a was replaced by Worker b. Nothing is asked of you.",
    intent: HANDOFF_INTENT,
    effects: [],
    authority: COORDINATION_HANDOFF_AUTHORITY,
    approved: [],
  };
  const check = (over: Partial<Parameters<typeof commandRefusalOf>[0]> = {}) =>
    commandRefusalOf({ home, now: NOW, workspaceId: "ws-1", command: handoff, backstop: false, loopGuard: "refuse", log: () => {}, ...over });

  it("answers null when the send would go, and each refusal sendCommand gives — writing nothing", async () => {
    expect(check()).toBeNull();
    expect(check({ interrupt: { open: false } })).toBe(INTERRUPT_REFUSED_MESSAGE);
    expect(check({ command: { ...handoff, re: "" } })).toMatch(/^the command cannot be sent as a BM-COMMAND block: /);
    const store = createOrchestratorStore(home);
    for (let n = 0; n < COMMAND_LIMIT_PER_REQUEST; n += 1) {
      store.appendCommand({ id: `c${n}`, workspaceId: "ws-1", managerId: "m", requestId: REQUEST, situation: "s", command: "c", reason: "r", sentText: "BM-COMMAND", outcome: "sent" });
    }
    expect(check()).toBe(COMMAND_LIMIT_MESSAGE);
    // Counted, never refused, by the loop guard's "count".
    expect(check({ loopGuard: "count" })).toBeNull();
    createCoordinationStore(home).set({ key: "handoff.enabled", value: false });
    expect(check({ loopGuard: "count" })).toBe(HANDOFF_OFF_MESSAGE);
    // The same reason sendCommand gives, and nothing leaves.
    const enqueue = vi.fn(async () => "sent" as const);
    const sent = await sendCommand({ home, now: NOW, paseo: fakePaseo().paseo as never, workspaceId: "ws-1", command: handoff, targetId: "m", copyTo: null, grantOf: null, approved: [], backstop: false, loopGuard: "count", intervention: null, queue: { enqueue } });
    expect(sent).toEqual({ ok: false, stage: "check", reason: HANDOFF_OFF_MESSAGE });
    expect(enqueue).not.toHaveBeenCalled();
    expect(createOrchestratorStore(home).listCommands()).toHaveLength(COMMAND_LIMIT_PER_REQUEST);
  });
});
