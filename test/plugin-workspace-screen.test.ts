import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { allNodes, pressables, renderTree, texts, type RNode } from "./helpers/element-tree";

/**
 * Delta 20260918f: the pieces the Beads and Metric screens share, expanded with
 * the element-tree helper (hook-free views only). `react-native` is replaced by
 * named stand-ins, as in test/agent-tree.test.ts.
 */

vi.mock("react-native", () => {
  const make = (name: string) => Object.assign(() => null, { displayName: name, primitive: true });
  return {
    ActivityIndicator: make("ActivityIndicator"),
    Pressable: make("Pressable"),
    ScrollView: make("ScrollView"),
    Text: make("Text"),
    View: make("View"),
  };
});

// The root tsconfig has no `jsx`, so the .tsx module is loaded through a
// non-literal specifier that `tsc --noEmit` does not resolve.
const uiPath = "../plugin/client/ui.tsx";
const { BeadRowCard, WorkspaceScreenHeader } = (await import(uiPath)) as {
  BeadRowCard: (props: Record<string, unknown>) => unknown;
  WorkspaceScreenHeader: (props: Record<string, unknown>) => unknown;
};

const styles = {
  secondaryButton: { name: "secondaryButton" },
  secondaryButtonText: { name: "secondaryButtonText" },
  title: { name: "title" },
  card: { name: "card" },
  sectionTitle: { name: "sectionTitle" },
};
const theme = {
  colors: new Proxy({}, { get: (_target, key) => `#${String(key)}` }),
};

function header(props: Record<string, unknown>): Array<RNode | string> {
  return renderTree(WorkspaceScreenHeader({ styles, right: "RIGHT", backLabel: "Back to workspaces", ...props }));
}

const source = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");

describe("the header of the Beads and Metric screens", () => {
  it("draws ←, the title and the screen's own buttons, and names the ← for screen readers", () => {
    const onBack = vi.fn();
    const tree = header({ title: "Beads · repo", onBack });
    const [back] = pressables(tree);
    expect(back!.props.accessibilityLabel).toBe("Back to workspaces");
    expect(back!.props.onPress).toBe(onBack);
    expect(texts(tree)).toEqual(["←", "Beads · repo"]);
    // The right-hand side comes last in the row.
    const row = tree[0] as RNode;
    expect(row.children.at(-1)).toBe("RIGHT");
  });

  it("has no ← when there is nowhere to go back to (the workspace's own tab)", () => {
    const tree = header({ title: null });
    expect(pressables(tree)).toEqual([]);
    expect(texts(tree)).toEqual([]);
    // A spacer keeps the buttons on the right.
    expect(allNodes(tree).some((node) => node.type === "View" && JSON.stringify(node.props.style) === JSON.stringify({ flex: 1 }))).toBe(true);
  });

  it("puts the surface's status strip right under its row, and nothing when there is none (F3)", () => {
    const withStatus = header({ title: "Metric · repo", status: "STATUS" });
    expect(withStatus).toHaveLength(2);
    expect((withStatus[0] as RNode).type).toBe("View");
    expect(withStatus[1]).toBe("STATUS");
    expect(header({ title: "Metric · repo" })).toHaveLength(1);
  });

  it("gets the status strip on Metric and Beads inside the Beads Manager surface (F3)", () => {
    const launcher = source("../plugin/client/launcher.tsx");
    for (const screen of ["BeadsScreen", "DashboardPanel"]) {
      const start = launcher.indexOf(`<${screen}`);
      expect(start, screen).toBeGreaterThan(0);
      const element = launcher.slice(start, launcher.indexOf("/>", start));
      expect(element, screen).toMatch(/status=\{status\}/);
    }
    // Both screens hand it to their header.
    for (const file of ["../plugin/client/beads-screen.tsx", "../plugin/client/dashboard.tsx"]) {
      const text = source(file);
      const start = text.indexOf("<WorkspaceScreenHeader");
      expect(text.slice(start, text.indexOf("right=", start)), file).toMatch(/status=\{status\}/);
    }
  });

  it("labels the ← of Metric and Beads from backLabelOf, and every ← goes back through one helper (F4, S5)", () => {
    const launcher = source("../plugin/client/launcher.tsx");
    for (const screen of ["BeadsScreen", "DashboardPanel"]) {
      const start = launcher.indexOf(`<${screen}`);
      const element = launcher.slice(start, launcher.indexOf("/>", start));
      expect(element, screen).toMatch(/backLabel=\{backLabelOf\(view\)/);
      expect(element, screen).toMatch(/onBack=\{goBack\}/);
    }
    // The back navigation is written once, inside `goBack`.
    expect(launcher.match(/setView\(backOf\(view\) \?\? SURFACE_HOME_VIEW\)/g)).toHaveLength(1);
    expect(launcher).toMatch(/const goBack = \(\) => setView\(backOf\(view\) \?\? SURFACE_HOME_VIEW\);/);
    expect(launcher.match(/onPress=\{goBack\}/g)).toHaveLength(1);
  });

  it("reads the workspace figures through overviewPolling (F5)", () => {
    const launcher = source("../plugin/client/launcher.tsx");
    const start = launcher.indexOf('queryKey: ["paseo-bm", "launcher", "overview"]');
    expect(start).toBeGreaterThan(0);
    expect(launcher.slice(start, launcher.indexOf("});", start))).toMatch(/\.\.\.overviewPolling\(view\)/);
  });

  it("is the header both screens draw", () => {
    expect(source("../plugin/client/beads-screen.tsx")).toMatch(/<WorkspaceScreenHeader/);
    expect(source("../plugin/client/dashboard.tsx")).toMatch(/<WorkspaceScreenHeader/);
  });
});

describe("one bead row for the Beads screen and the Beads in this chat panel (S4)", () => {
  const bead = { id: "bm-1", title: "Lock an account", status: "in_progress", ready: false };
  const row = (open: boolean) =>
    renderTree(BeadRowCard({ bead, open, onToggle: vi.fn(), meta: "META", detail: "DETAIL", styles, theme }));

  it("draws the title with its status colour, not bold, and ▸ while closed; the meta; no detail", () => {
    const tree = row(false);
    const [press] = pressables(tree);
    expect(press!.props.accessibilityState).toEqual({ expanded: false });
    const title = allNodes(tree).find((node) => node.type === "Text")!;
    expect(texts(tree)[0]).toBe("▸ Lock an account");
    expect(title.props.numberOfLines).toBe(2);
    expect(title.props.style).toEqual([styles.sectionTitle, { fontWeight: "400", color: "#statusWarning" }]);
    expect(press!.children).toContain("META");
    expect(JSON.stringify(tree)).not.toContain("DETAIL");
  });

  it("shows ▾, the whole title and the detail once opened", () => {
    const tree = row(true);
    expect(texts(tree)[0]).toBe("▾ Lock an account");
    expect(allNodes(tree).find((node) => node.type === "Text")!.props.numberOfLines).toBeUndefined();
    expect((tree[0] as RNode).children.at(-1)).toBe("DETAIL");
  });

  it("is the row both lists draw", () => {
    expect(source("../plugin/client/beads-screen.tsx")).toMatch(/<BeadRowCard/);
    expect(source("../plugin/client/bead-chips.tsx")).toMatch(/<BeadRowCard/);
  });
});
