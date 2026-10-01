import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sendCommand } from "../plugin/server/command-send";
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
