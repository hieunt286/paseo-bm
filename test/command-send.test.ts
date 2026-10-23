import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  COMMAND_LIMIT_MESSAGE,
  COMMAND_LIMIT_PER_REQUEST,
  HANDOFF_OFF_MESSAGE,
  INTERRUPT_REFUSED_MESSAGE,
  commandRefusalOf,
  commandsSentForMission,
  governorPoolOf,
  missionPoolSpentMessage,
  poolSpentUntil,
  sendCommand,
} from "../plugin/server/command-send";
import { createCoordinationStore } from "../plugin/server/coordination-store";
import { COORDINATION_HANDOFF_AUTHORITY, HANDOFF_INTENT, governorAuthorityOf, type CommandInput } from "../plugin/shared/orchestrator-command";
import { createMissionStore } from "../plugin/server/mission-store";
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
    const sent = await sendCommand({ home, now: NOW, paseo: fakePaseo().paseo as never, workspaceId: "ws-1", command: handoff, targetId: "m", copyTo: null, backstop: false, loopGuard: "count", intervention: null, queue: { enqueue } });
    expect(sent).toEqual({ ok: false, stage: "check", reason: HANDOFF_OFF_MESSAGE });
    expect(enqueue).not.toHaveBeenCalled();
    expect(createOrchestratorStore(home).listCommands()).toHaveLength(COMMAND_LIMIT_PER_REQUEST);
  });
});

describe("a governor command (missions design §9.4): only to the mission's current Main, its loop guard per mission", () => {
  const NOW = new Date("2026-10-09T12:00:00.000Z");
  const nudge: CommandInput = {
    from: "orchestrator",
    via: "chat",
    to: "manager",
    requestId: null,
    re: "Governor: stuck figures of mission PAY crossed",
    body: "Re-plan or explain in one line in your next reply.",
    intent: "other",
    effects: [],
    authority: governorAuthorityOf("nudge"),
    approved: [],
  };
  const missionOf = (code: string, id: string, mainId: string | null) => {
    const created = createMissionStore(home, { newId: () => id, env: {} }).create({ code, name: code, goal: "g", repos: ["repo-a"], createdBy: "owner", mainId });
    if (!created.ok) throw new Error(created.reasons.join("; "));
  };
  const check = (over: Partial<Parameters<typeof commandRefusalOf>[0]> = {}) =>
    commandRefusalOf({ home, now: NOW, workspaceId: "home-ws", command: nudge, backstop: false, loopGuard: "refuse", targetId: "main-1", missionId: "mis-0000000001", log: () => {}, ...over });

  it("refuses one without its mission, to an agent that is not the current Main, or to a closed mission", () => {
    missionOf("PAY", "mis-0000000001", "main-1");
    expect(check()).toBeNull();
    expect(check({ missionId: undefined })).toBe("a governor command names its mission");
    expect(check({ missionId: "mis-00000000ff" })).toBe("unknown mission mis-00000000ff");
    expect(check({ targetId: "main-old" })).toBe("main-old is not the current Main of mission PAY");
    createMissionStore(home).update("mis-0000000001", (mission) => ({ ...mission, state: "closed", closedAt: NOW.toISOString() }));
    expect(check()).toBe("mission PAY is closed");
  });

  it("counts each pool per mission in 24 hours (delivery line design §8.1): no kind spends another's, and other missions are apart", async () => {
    missionOf("PAY", "mis-0000000001", "main-1");
    missionOf("SHIP", "mis-0000000002", "main-2");
    const enqueue = vi.fn(async () => "sent" as const);
    let n = 0;
    const of = (step: "nudge" | "replan" | "arbitrate"): CommandInput => ({ ...nudge, authority: governorAuthorityOf(step) });
    const send = (missionId: string, targetId: string, step: "nudge" | "replan" | "arbitrate", by?: "code" | "model") =>
      sendCommand({
        home,
        now: NOW,
        paseo: fakePaseo().paseo as never,
        workspaceId: "home-ws",
        command: of(step),
        targetId,
        missionId,
        ...(by === undefined ? {} : { governorBy: by }),
        copyTo: null,
        backstop: false,
        loopGuard: "refuse",
        intervention: null,
        queue: { enqueue },
        store: { newId: () => `cmd-${++n}`, now: () => NOW },
        redactEnv: {},
      });
    const until = new Date(NOW.getTime() + 24 * 3_600_000);
    // The defaults: 6 code nudges, 3 re-plans, 4 arbitrations, 4 others.
    for (const [step, by, quota, pool] of [
      ["nudge", "code", 6, "codeNudge"],
      ["replan", undefined, 3, "replan"],
      ["arbitrate", undefined, 4, "arbitrate"],
      ["nudge", "model", 4, "other"],
    ] as const) {
      for (let i = 0; i < quota; i += 1) expect((await send("mis-0000000001", "main-1", step, by)).ok, `${pool} ${i}`).toBe(true);
      expect(await send("mis-0000000001", "main-1", step, by)).toEqual({ ok: false, stage: "check", reason: missionPoolSpentMessage(pool, until) });
    }
    // Another mission's pools are its own.
    expect((await send("mis-0000000002", "main-2", "replan")).ok).toBe(true);
    const commands = createOrchestratorStore(home).listCommands();
    expect(commandsSentForMission(commands, "mis-0000000001", NOW)).toBe(17);
    expect(commandsSentForMission(commands, "mis-0000000001", NOW, "codeNudge")).toBe(6);
    expect(commandsSentForMission(commands, "mis-0000000001", NOW, "replan")).toBe(3);
    expect(commandsSentForMission(commands, "mis-0000000001", NOW, "arbitrate")).toBe(4);
    expect(commandsSentForMission(commands, "mis-0000000001", NOW, "other")).toBe(4);
    expect(commandsSentForMission(commands, "mis-0000000002", NOW)).toBe(1);
    expect(commandsSentForMission(commands, "mis-0000000001", new Date(NOW.getTime() + 24 * 3_600_000 + 1))).toBe(0);
    // Each entry keeps its mission, its step and who wrote it; `model` when the caller names none.
    expect(commands.find((entry) => entry.id === "cmd-1")).toMatchObject({ missionId: "mis-0000000001", governorStep: "nudge", by: "code" });
    expect(commands.find((entry) => entry.id === "cmd-7")).toMatchObject({ missionId: "mis-0000000001", governorStep: "replan", by: "model" });
    expect(missionPoolSpentMessage("replan", until)).toBe(
      "This mission's re-plan commands are spent until 2026-10-10T12:00:00.000Z; paseo-bm puts the figures in the Main's daily digest. Nothing was sent",
    );
  });

  it("counts an entry stored before the pools in other, and frees a pool when its oldest counted entry leaves the window", () => {
    const store = createOrchestratorStore(home, { now: () => new Date(NOW.getTime() - 3 * 3_600_000) });
    store.appendCommand({ workspaceId: "home-ws", managerId: "main-1", requestId: null, situation: "", command: "Re-plan.", reason: "", sentText: "Re-plan.", outcome: "sent", missionId: "mis-0000000001" });
    const [old] = store.listCommands();
    expect(old!.governorStep).toBeUndefined();
    expect(governorPoolOf(old!)).toBe("other");
    expect(governorPoolOf({ governorStep: "nudge" })).toBe("other");
    expect(governorPoolOf({ governorStep: "nudge", by: "code" })).toBe("codeNudge");
    expect(governorPoolOf({ governorStep: "arbitrate", by: "model" })).toBe("arbitrate");
    const later = createOrchestratorStore(home, { now: () => new Date(NOW.getTime() - 3_600_000) });
    for (let i = 0; i < 3; i += 1) {
      later.appendCommand({ workspaceId: "home-ws", managerId: "main-1", requestId: null, situation: "", command: "c", reason: "", sentText: "c", outcome: "sent", missionId: "mis-0000000001" });
    }
    const commands = createOrchestratorStore(home).listCommands();
    expect(poolSpentUntil(commands, "mis-0000000001", "other", NOW, 5)).toBeNull();
    // Four in the pool, a quota of 4: room again once the oldest (3 hours ago) leaves.
    expect(poolSpentUntil(commands, "mis-0000000001", "other", NOW, 4)).toEqual(new Date(NOW.getTime() + 21 * 3_600_000));
    // A quota of 2: the second oldest must leave, an hour ago plus a day.
    expect(poolSpentUntil(commands, "mis-0000000001", "other", NOW, 2)).toEqual(new Date(NOW.getTime() + 23 * 3_600_000));
    expect(poolSpentUntil(commands, "mis-0000000001", "replan", NOW, 1)).toBeNull();
  });
});
