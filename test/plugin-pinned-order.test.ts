import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  dropIndex,
  movePinned,
  orderRows,
  pinAt,
  prunePinned,
  unpin,
} from "../plugin/client/pinned-order";

/**
 * The order the owner pinned (delta 20260917e §4.1, decision Q26).
 *
 * The rule every case below defends: a pinned order is the owner's stated
 * preference, so it is never forgotten because a read went wrong. It is only
 * ever narrowed when something is deliberately written.
 */

const rows = (...ids: string[]) => ids.map((id) => ({ id, label: id.toUpperCase() }));

describe("orderRows", () => {
  it("puts pinned rows first, in the owner's order, and leaves the rest as they came", () => {
    const { pinned, rest } = orderRows(rows("a", "b", "c", "d"), ["c", "a"]);
    expect(pinned.map((row) => row.id)).toEqual(["c", "a"]);
    expect(rest.map((row) => row.id)).toEqual(["b", "d"]);
  });

  it("keeps the activity order of everything unpinned", () => {
    // The daemon already sorted by activity; the unpinned block must not be
    // touched, or a new workspace would stop surfacing on its own.
    const { rest } = orderRows(rows("new", "old", "older"), []);
    expect(rest.map((row) => row.id)).toEqual(["new", "old", "older"]);
  });

  it("skips a pinned id that is not in this listing, without forgetting it", () => {
    // Archived, or one failed `workspaces.list`. Either way the order survives.
    const { pinned, rest } = orderRows(rows("a", "b"), ["gone", "b"]);
    expect(pinned.map((row) => row.id)).toEqual(["b"]);
    expect(rest.map((row) => row.id)).toEqual(["a"]);
  });

  it("never shows a row twice, even if the file lists it twice", () => {
    const { pinned, rest } = orderRows(rows("a", "b"), ["a", "a"]);
    expect(pinned.map((row) => row.id)).toEqual(["a"]);
    expect(rest.map((row) => row.id)).toEqual(["b"]);
  });
});

describe("pinAt", () => {
  it("pins a new row at the asked position", () => {
    expect(pinAt(["a", "b"], "c", 1)).toEqual(["a", "c", "b"]);
  });

  it("moves an already pinned row instead of duplicating it", () => {
    expect(pinAt(["a", "b", "c"], "c", 0)).toEqual(["c", "a", "b"]);
  });

  it("clamps a drop past either end instead of throwing", () => {
    expect(pinAt(["a", "b"], "c", 99)).toEqual(["a", "b", "c"]);
    expect(pinAt(["a", "b"], "c", -5)).toEqual(["c", "a", "b"]);
  });
});

describe("movePinned", () => {
  it("moves a row up and down", () => {
    expect(movePinned(["a", "b", "c"], "c", -1)).toEqual(["a", "c", "b"]);
    expect(movePinned(["a", "b", "c"], "a", 1)).toEqual(["b", "a", "c"]);
  });

  it("does nothing at the ends", () => {
    expect(movePinned(["a", "b"], "a", -1)).toEqual(["a", "b"]);
    expect(movePinned(["a", "b"], "b", 1)).toEqual(["a", "b"]);
  });

  it("does nothing for a row that is not pinned", () => {
    expect(movePinned(["a"], "z", -1)).toEqual(["a"]);
  });
});

describe("unpin", () => {
  it("removes just that row", () => {
    expect(unpin(["a", "b"], "a")).toEqual(["b"]);
    expect(unpin(["a", "b"], "z")).toEqual(["a", "b"]);
  });
});

describe("prunePinned", () => {
  it("drops ids that no longer name a listed workspace", () => {
    expect(prunePinned(["a", "gone", "b"], ["a", "b", "c"])).toEqual(["a", "b"]);
  });

  it("is the only place an id is forgotten", () => {
    // Pruning against an EMPTY listing would erase everything, which is why the
    // caller may only prune from a successful read. The function itself stays
    // honest about what it was told.
    expect(prunePinned(["a", "b"], [])).toEqual([]);
  });
});


describe("dropIndex", () => {
  it("turns a drag distance into a position", () => {
    expect(dropIndex(0, 0, 40, 3)).toBe(0);
    expect(dropIndex(0, 45, 40, 3)).toBe(1);
    expect(dropIndex(2, -80, 40, 3)).toBe(0);
  });

  it("clamps at both ends instead of running off the list", () => {
    expect(dropIndex(0, 1000, 40, 3)).toBe(2);
    expect(dropIndex(2, -1000, 40, 3)).toBe(0);
  });

  it("stays put when the list has not been measured", () => {
    // A drag against an unknown scale is not a request to move anywhere.
    expect(dropIndex(1, 500, 0, 3)).toBe(1);
    expect(dropIndex(1, 500, 40, 0)).toBe(1);
  });
});

/**
 * Source-level wiring. The screen has no renderer in this repo, so nothing else
 * would catch controls that exist but are never drawn, or a prune that moved to
 * the read path where a failed listing would erase the owner's order.
 */
describe("the launcher is actually wired to this model", () => {
  const launcher = readFileSync(
    fileURLToPath(new URL("../plugin/client/launcher.tsx", import.meta.url)),
    "utf8",
  );

  it("orders the rows it renders through orderRows", () => {
    expect(launcher).toMatch(/orderRows\(workspaces\.data \?\? \[\], pinned\)/);
    expect(launcher).toMatch(/\[\.\.\.ordered\.pinned, \.\.\.ordered\.rest\]\.map/);
  });

  it("draws the controls on every row", () => {
    expect(launcher).toMatch(/<PinControls/);
    expect(launcher).toMatch(/accessibilityLabel=\{`Move \$\{label\} up`\}/);
    expect(launcher).toMatch(/accessibilityLabel=\{`Move \$\{label\} down`\}/);
  });

  it("drags from a dedicated handle, which is what removes the scroll conflict", () => {
    // React Native gives a touch to the first child that claims it, so a
    // ScrollView only scrolls from touches nothing claimed. A handle that
    // claims on touch-start cannot fight the scroll.
    expect(launcher).toMatch(/onStartShouldSetPanResponder: \(\) => true/);
    expect(launcher).toMatch(/<DragHandle/);
    // Only pinned rows carry a handle: an unpinned row has no position to move
    // within.
    expect(launcher).toMatch(/\{isPinned \? \(\s*<DragHandle/);
  });

  it("stops the list scrolling while a row is being dragged", () => {
    expect(launcher).toMatch(/scrollEnabled=\{!dragging\}/);
    expect(launcher).toMatch(/onPanResponderGrant: \(\) => onDragging\(true\)/);
    // Both release paths put it back, or a terminated gesture would freeze the
    // list for good.
    expect(launcher).toMatch(/onPanResponderRelease[\s\S]{0,120}onDragging\(false\)/);
    expect(launcher).toMatch(/onPanResponderTerminate[\s\S]{0,80}onDragging\(false\)/);
  });

  it("drops through the same pinAt the buttons use, and only when it moved", () => {
    expect(launcher).toMatch(/const to = dropIndex\(index, gesture\.dy, rowHeight\(\), count\)/);
    expect(launcher).toMatch(/if \(to !== index\) onDrop\(to\)/);
    expect(launcher).toMatch(/onDrop=\{\(to\) => savePinned\(pinAt\(pinned, workspace\.id, to\)\)\}/);
  });

  it("never asks for the native driver", () => {
    // Paseo's renderer is react-native-web, which has none (P3).
    expect(launcher).not.toMatch(/useNativeDriver: true/);
  });

  it("prunes only when writing, never when reading", () => {
    // `prunePinned` against an empty listing erases everything, so it may only
    // run after a listing that actually arrived.
    const save = launcher.slice(launcher.indexOf("const savePinned"), launcher.indexOf("// Open the Dashboard"));
    expect(save).toMatch(/known === undefined \? \[\.\.\.next\] : prunePinned\(next/);
    expect(launcher.match(/prunePinned\(/g)).toHaveLength(1);
  });
});
