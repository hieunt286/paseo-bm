import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BEADS_HEADER_BUTTON_ID,
  beadsHeaderButton,
  planHeaderButtons,
  registerBeadsHeaderButtons,
} from "../plugin/client/beads-header-button";

/**
 * The "Beads" button on every open workspace's header (delta 20260918e §4.6,
 * REQ-060 o): Paseo 0.8's mobile app has no "+" menu, so this is how a phone
 * opens the Beads tab.
 */

/**
 * The module as the phone runs it. Paseo 0.8 compiles a client bundle with
 * esbuild (`compileTarget`: cjs, neutral, es2020, async lowered) and evaluates
 * it on Hermes, where a closure made inside a loop sees the loop's LAST
 * binding (Paseo's `makeHermesInteropEager` works around the same thing in
 * esbuild's interop getters). Turning every `let` / `const` into `var` gives
 * Node the same semantics.
 */
async function moduleOnHermes(): Promise<{ registerBeadsHeaderButtons: typeof registerBeadsHeaderButtons }> {
  const result = await build({
    entryPoints: [fileURLToPath(new URL("../plugin/client/beads-header-button.ts", import.meta.url))],
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
  return module.exports as { registerBeadsHeaderButtons: typeof registerBeadsHeaderButtons };
}

describe("planning the header buttons", () => {
  const listed = [{ id: "a" }, { id: "b" }, { id: "c", archivingAt: "2026-09-19T00:00:00.000Z" }];

  it("adds a button for each open workspace without one, and removes the buttons of workspaces that went", () => {
    expect(planHeaderButtons(new Set(["a", "gone", "c"]), listed)).toEqual({ add: ["b"], remove: ["gone", "c"] });
    expect(planHeaderButtons(new Set(), listed)).toEqual({ add: ["a", "b"], remove: [] });
  });

  it("is an icon-only action button", () => {
    const openTab = vi.fn();
    const button = beadsHeaderButton(openTab);
    expect(button).toMatchObject({ icon: "ListChecks", title: "Open the Beads tab: beads and metrics of this workspace" });
    expect("label" in button).toBe(false);
    expect(button.behavior.kind).toBe("action");
    if (button.behavior.kind === "action") void button.behavior.onPress();
    expect(openTab).toHaveBeenCalledTimes(1);
  });
});

describe("following the open workspaces", () => {
  type Added = { id: string; workspaceId: string; button: ReturnType<typeof beadsHeaderButton>; remove: ReturnType<typeof vi.fn> };
  let stop: (() => void) | undefined;
  afterEach(() => {
    stop?.();
    stop = undefined;
  });

  function fakeClient(lists: Array<Array<{ id: string; archivingAt?: string | null }> | Error>) {
    const added: Added[] = [];
    let onUpdate: (() => void) | undefined;
    const unsubscribe = vi.fn();
    const client = {
      paseo: {
        workspaces: {
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
      addHeaderButton: vi.fn((registration: Omit<Added, "remove">) => {
        const entry = { ...registration, remove: vi.fn() };
        added.push(entry);
        return { remove: entry.remove, update: vi.fn() };
      }),
      openPanel: vi.fn(),
    };
    return { client, added, update: () => onUpdate?.(), unsubscribe };
  }

  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

  it("adds one button per open workspace, each opening its own workspace's Beads tab", async () => {
    const fake = fakeClient([[{ id: "wks_a" }, { id: "wks_b" }, { id: "wks_c", archivingAt: "2026-09-19T00:00:00.000Z" }]]);
    stop = registerBeadsHeaderButtons(fake.client as never);
    await settle();

    expect(fake.added.map((entry) => [entry.id, entry.workspaceId])).toEqual([
      [BEADS_HEADER_BUTTON_ID, "wks_a"],
      [BEADS_HEADER_BUTTON_ID, "wks_b"],
    ]);
    const second = fake.added[1]!.button.behavior;
    if (second.kind === "action") void second.onPress();
    expect(fake.client.openPanel).toHaveBeenCalledWith("bm-beads", { workspaceId: "wks_b" });
  });

  it("gives each button its own workspace on the phone too, where a loop's closures share its last binding", async () => {
    const onHermes = await moduleOnHermes();
    const fake = fakeClient([[{ id: "wks_a" }, { id: "wks_b" }, { id: "wks_c" }]]);
    stop = onHermes.registerBeadsHeaderButtons(fake.client as never);
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

  it("removes the button of a workspace that went, keeps the buttons when a read fails, and removes all on cleanup", async () => {
    const fake = fakeClient([[{ id: "wks_a" }, { id: "wks_b" }], [{ id: "wks_a" }], new Error("daemon unreachable"), [{ id: "wks_a" }]]);
    stop = registerBeadsHeaderButtons(fake.client as never);
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

  it("does not break a client that cannot list workspaces", async () => {
    const client = { addHeaderButton: vi.fn(), openPanel: vi.fn() };
    stop = registerBeadsHeaderButtons(client as never);
    await settle();
    expect(client.addHeaderButton).not.toHaveBeenCalled();
  });
});
