import { describe, expect, it, vi } from "vitest";
import { releaseNotesView } from "../plugin/client/release-notes-model";
import type { ReleaseNote } from "../plugin/client/release-notes.generated";
import { allNodes, pressables, renderTree, texts } from "./helpers/element-tree";

const notes: readonly ReleaseNote[] = [
  { version: "2.0.0", title: "paseo-bm 2.0.0", summary: "Two", gitUrl: "https://example.test/v2", blocks: [
    { kind: "heading", text: "Changes" },
    { kind: "paragraph", text: "A paragraph" },
    { kind: "bullet", text: "A bullet" },
    { kind: "code", text: "paseo plugin update paseo-bm" },
  ] },
  { version: "1.0.0", title: "paseo-bm 1.0.0", summary: "One", gitUrl: "https://example.test/v1", blocks: [] },
];

describe("release notes model", () => {
  it("defaults to latest, allows an older selection, and falls back to the tag", () => {
    expect(releaseNotesView("1.0.0", "2.0.0", null, notes).selected?.version).toBe("2.0.0");
    expect(releaseNotesView("1.0.0", "2.0.0", "1.0.0", notes).selected?.version).toBe("1.0.0");
    expect(releaseNotesView("1.0.0", "3.0.0", null, notes)).toMatchObject({ selected: null, missing: true, sourceUrl: expect.stringContaining("/releases/tag/v3.0.0") });
  });
});

const sectionPath = "../plugin/client/settings-section.tsx";
type Component = (props: Record<string, unknown>) => unknown;
const { ReleaseNotesBlock } = await import(sectionPath) as { ReleaseNotesBlock: Component };
const styles = new Proxy({}, { get: (_target, key) => ({ name: String(key) }) });
const theme = { colors: new Proxy({}, { get: (_target, key) => `#${String(key)}` }) };

describe("ReleaseNotesBlock", () => {
  it("renders the generated block kinds, version controls and source action", () => {
    const select = vi.fn();
    const tree = renderTree(ReleaseNotesBlock({ installedVersion: "0.5.2", latestVersion: "0.5.3", selectedVersion: "0.5.3", onSelect: select, styles, theme }));
    expect(texts(tree)).toEqual(expect.arrayContaining(["Release notes", "paseo-bm 0.5.3", "View this release on GitHub"]));
    expect(allNodes(tree).some((node) => node.type === "Text" && JSON.stringify(node.props.style).includes("monospace"))).toBe(true);
    const older = pressables(tree).find((node) => node.props.accessibilityLabel === "Show release notes for 0.5.2");
    expect(older).toBeDefined();
    if (typeof older!.props.onPress !== "function") throw new Error("release selector has no press handler");
    older!.props.onPress();
    expect(select).toHaveBeenCalledWith("0.5.2");
    expect(pressables(tree).some((node) => node.props.accessibilityLabel === "Open release notes source for 0.5.3")).toBe(true);
  });

  it("shows a safe missing-note fallback", () => {
    const tree = renderTree(ReleaseNotesBlock({ installedVersion: "0.5.3", latestVersion: "9.0.0", selectedVersion: null, onSelect: vi.fn(), styles, theme }));
    expect(texts(tree)).toContain("Release notes for 9.0.0 are not bundled.");
    expect(pressables(tree).some((node) => node.props.accessibilityLabel === "Open release notes source for 9.0.0")).toBe(true);
  });
});
