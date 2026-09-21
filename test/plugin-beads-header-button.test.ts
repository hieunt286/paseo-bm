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
