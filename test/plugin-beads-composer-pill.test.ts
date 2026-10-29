import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BEADS_COMPOSER_PILL_ID,
  beadsComposerPill,
  planComposerPills,
  registerBeadsComposerPills,
  type ListedAgent,
} from "../plugin/client/beads-composer-pill";

/**
 * The "Beads" pill above every bm-* agent's composer (owner decision
 * 2026-10-25): Paseo 0.12's mobile workspace header draws no plugin header
 * buttons, so this is how a phone opens the Beads tab.
 */

/** The module as the phone runs it: Hermes, where a loop's closures share its last binding (see the header button's test). */
async function moduleOnHermes(): Promise<{ registerBeadsComposerPills: typeof registerBeadsComposerPills }> {
  const result = await build({
    entryPoints: [fileURLToPath(new URL("../plugin/client/beads-composer-pill.ts", import.meta.url))],
    bundle: true,
    format: "cjs",
    platform: "neutral",
    target: "es2020",
    supported: { "async-await": false },
    write: false,
    logLevel: "silent",
  });
  const eager = result.outputFiles[0]!.text.replaceAll("get: () => from[key]", "value: from[key]");
  const functionScoped = eager.replace(/\b(?:const|let)\b/g, "var");
  expect(functionScoped).not.toBe(eager);
  const module = { exports: {} };
  new Function("module", "exports", functionScoped)(module, module.exports);
  return module.exports as { registerBeadsComposerPills: typeof registerBeadsComposerPills };
}

const agent = (id: string, workspaceId: string | null, overrides: Partial<NonNullable<ListedAgent["agent"]>> = {}): ListedAgent => ({
  agent: { id, provider: "bm-worker", workspaceId, archivedAt: null, ...overrides },
});

describe("planning the composer pills", () => {
  it("adds a pill for each live bm-* agent without one, and removes the pills of agents that went or moved", () => {
    const listed = [
      agent("w1", "wks_a"),
      agent("m1", "wks_home", { provider: "bm-manager" }),
      agent("old", "wks_a", { archivedAt: "2026-10-20T00:00:00.000Z" }),
      agent("mine", "wks_a", { provider: "claude" }),
      agent("lost", null),
      { agent: null },
    ];
    expect(planComposerPills(new Set(["w1@wks_a", "gone@wks_a", "m1@wks_old"]), listed)).toEqual({
      add: [{ key: "m1@wks_home", agentId: "m1", workspaceId: "wks_home" }],
      remove: ["gone@wks_a", "m1@wks_old"],
    });
  });

  it("is a labelled action pill with the Beads tab's icon", () => {
    const openTab = vi.fn();
    const pill = beadsComposerPill(openTab);
    expect(pill).toMatchObject({ icon: "ListChecks", label: "Beads", title: "Open the Beads tab: this workspace's requests, beads and agents" });
    expect(pill.behavior.kind).toBe("action");
    if (pill.behavior.kind === "action") void pill.behavior.onPress();
    expect(openTab).toHaveBeenCalledTimes(1);
  });
});

describe("following the bm-* agents", () => {
  type Added = { id: string; workspaceId: string; agentId: string; button: ReturnType<typeof beadsComposerPill>; remove: ReturnType<typeof vi.fn> };
  let stop: (() => void) | undefined;
  afterEach(() => {
    stop?.();
    stop = undefined;
  });

  function fakeClient(lists: Array<ListedAgent[] | Error>) {
    const added: Added[] = [];
    let onUpdate: (() => void) | undefined;
    const unsubscribe = vi.fn();
    const client = {
      paseo: {
        agents: {
          list: vi.fn(async () => {
            const next = lists.length > 1 ? lists.shift()! : lists[0]!;
            if (next instanceof Error) throw next;
            return { entries: next };
          }),
          subscribe: vi.fn((handler: () => void) => {
            onUpdate = handler;
            return unsubscribe;
          }),
        },
      },
      addComposerPill: vi.fn((registration: Omit<Added, "remove">) => {
        const entry = { ...registration, remove: vi.fn() };
        added.push(entry);
        return { remove: entry.remove, update: vi.fn() };
      }),
      openPanel: vi.fn(),
    };
    return { client, added, update: () => onUpdate?.(), unsubscribe };
  }

  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

  it("adds one pill per live bm-* agent, each opening its own workspace's Beads tab", async () => {
    const fake = fakeClient([[agent("w1", "wks_a"), agent("w2", "wks_b"), agent("mine", "wks_b", { provider: "codex" })]]);
    stop = registerBeadsComposerPills(fake.client as never);
    await settle();

    expect(fake.added.map((entry) => [entry.id, entry.agentId, entry.workspaceId])).toEqual([
      [BEADS_COMPOSER_PILL_ID, "w1", "wks_a"],
      [BEADS_COMPOSER_PILL_ID, "w2", "wks_b"],
    ]);
    const second = fake.added[1]!.button.behavior;
    if (second.kind === "action") void second.onPress();
    expect(fake.client.openPanel).toHaveBeenCalledWith("bm-beads", { workspaceId: "wks_b" });
  });

  it("gives each pill its own workspace on the phone too, where a loop's closures share its last binding", async () => {
    const onHermes = await moduleOnHermes();
    const fake = fakeClient([[agent("w1", "wks_a"), agent("w2", "wks_b"), agent("w3", "wks_c")]]);
    stop = onHermes.registerBeadsComposerPills(fake.client as never);
    await settle();

    expect(fake.added.map((entry) => entry.workspaceId)).toEqual(["wks_a", "wks_b", "wks_c"]);
    for (const entry of fake.added) {
      if (entry.button.behavior.kind === "action") void entry.button.behavior.onPress();
    }
    expect(fake.client.openPanel.mock.calls).toEqual([
      ["bm-beads", { workspaceId: "wks_a" }],
      ["bm-beads", { workspaceId: "wks_b" }],
      ["bm-beads", { workspaceId: "wks_c" }],
    ]);
  });

  it("removes the pill of an agent that was archived, keeps the pills when a read fails, and removes all on cleanup", async () => {
    const fake = fakeClient([
      [agent("w1", "wks_a"), agent("w2", "wks_a")],
      [agent("w1", "wks_a"), agent("w2", "wks_a", { archivedAt: "2026-10-25T00:00:00.000Z" })],
      new Error("daemon unreachable"),
      [agent("w1", "wks_a")],
    ]);
    stop = registerBeadsComposerPills(fake.client as never);
    await settle();
    expect(fake.added).toHaveLength(2);

    fake.update();
    await settle();
    expect(fake.added[1]!.remove).toHaveBeenCalledTimes(1);
    expect(fake.added[0]!.remove).not.toHaveBeenCalled();

    fake.update();
    await settle();
    expect(fake.added[0]!.remove).not.toHaveBeenCalled();
    expect(fake.added).toHaveLength(2);

    stop();
    stop = undefined;
    expect(fake.added[0]!.remove).toHaveBeenCalledTimes(1);
    expect(fake.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("adds nothing on a host without composer pills, and does not break a client that cannot list agents", async () => {
    const older = { paseo: { agents: { list: vi.fn() } }, openPanel: vi.fn() };
    stop = registerBeadsComposerPills(older as never);
    await settle();
    expect(older.paseo.agents.list).not.toHaveBeenCalled();
    stop();
    const broken = { addComposerPill: vi.fn(), openPanel: vi.fn() };
    stop = registerBeadsComposerPills(broken as never);
    await settle();
    expect(broken.addComposerPill).not.toHaveBeenCalled();
  });
});
