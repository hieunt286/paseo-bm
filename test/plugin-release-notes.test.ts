import { describe, expect, it, vi } from "vitest";
import { releaseNotesView } from "../plugin/client/release-notes-model";
import type { ReleaseNote } from "../plugin/client/release-notes.generated";
import { pressables, renderTree, texts } from "./helpers/element-tree";

const notes: readonly ReleaseNote[] = [
  { version: "2.0.0", summary: "Two", sections: ["Changes", "Rollback"], prereleases: ["2.0.0-alpha.0", "2.0.0-alpha.1"], gitUrl: "https://example.test/v2" },
  { version: "1.0.0", summary: "One", sections: [], prereleases: [], gitUrl: "https://example.test/v1" },
  { version: "0.9.0-alpha.0", summary: "Early", sections: [], prereleases: [], gitUrl: "https://example.test/v0.9-alpha" },
];

describe("release notes model", () => {
  it("defaults to latest, allows an older selection, and falls back to the tag", () => {
    expect(releaseNotesView("1.0.0", "2.0.0", null, notes).selected?.version).toBe("2.0.0");
    expect(releaseNotesView("1.0.0", "2.0.0", "1.0.0", notes).selected?.version).toBe("1.0.0");
    expect(releaseNotesView("1.0.0", "3.0.0", null, notes)).toMatchObject({ selected: null, missing: true, sourceUrl: expect.stringContaining("/releases/tag/v3.0.0") });
  });

  it("lists every version, resolves a folded prerelease to its stable, and keeps a prerelease with no stable", () => {
    expect(releaseNotesView("1.0.0", "2.0.0", null, notes).notes.map((note) => note.version)).toEqual(["2.0.0", "1.0.0", "0.9.0-alpha.0"]);
    expect(releaseNotesView("2.0.0-alpha.1", null, null, notes)).toMatchObject({
      selectedVersion: "2.0.0",
      includes: "Includes 2.0.0-alpha.0, 2.0.0-alpha.1",
      sections: "In the full note: Changes · Rollback",
      sourceUrl: "https://example.test/v2",
      missing: false,
    });
    expect(releaseNotesView(null, null, "0.9.0-alpha.0", notes)).toMatchObject({ selectedVersion: "0.9.0-alpha.0", includes: null, sections: null });
  });
});

const sectionPath = "../plugin/client/settings-section.tsx";
type Component = (props: Record<string, unknown>) => unknown;
const { ReleaseNotesBlock } = await import(sectionPath) as { ReleaseNotesBlock: Component };
const styles = new Proxy({}, { get: (_target, key) => ({ name: String(key) }) });
const theme = { colors: new Proxy({}, { get: (_target, key) => `#${String(key)}` }) };

describe("ReleaseNotesBlock", () => {
  it("renders the summary, the folded prereleases and sections, version controls and source action", () => {
    const select = vi.fn();
    const tree = renderTree(ReleaseNotesBlock({ installedVersion: "0.5.2", latestVersion: "0.5.3", selectedVersion: "0.5.3", onSelect: select, styles, theme }));
    expect(texts(tree)).toEqual(expect.arrayContaining(["Release notes", "paseo-bm 0.5.3", "View this release on GitHub"]));
    expect(texts(tree).some((text) => text.startsWith("Agents decide the content"))).toBe(true);
    expect(texts(tree).some((text) => text.startsWith("In the full note: What changed"))).toBe(true);
    expect(pressables(tree).some((node) => node.props.accessibilityLabel === "Show release notes for 0.3.0-alpha.7")).toBe(false);
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

  it("shows a stable's note with the prereleases it includes", () => {
    const tree = renderTree(ReleaseNotesBlock({ installedVersion: "0.5.5", latestVersion: "0.5.5", selectedVersion: "0.3.0", onSelect: vi.fn(), styles, theme }));
    expect(texts(tree)).toContain("Includes 0.3.0-alpha.0, 0.3.0-alpha.1, 0.3.0-alpha.2, 0.3.0-alpha.3, 0.3.0-alpha.4, 0.3.0-alpha.5, 0.3.0-alpha.6, 0.3.0-alpha.7");
  });
});
