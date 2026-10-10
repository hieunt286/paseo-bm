import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

interface Entry { version: string; markdown: string }
interface Note { version: string; summary: string; sections: string[]; prereleases: string[]; gitUrl: string }
const generatorPath = "../scripts/generate-release-notes.mjs";
const { catalogFromDirectory, compareVersions, generateCatalog, parseReleaseNote } = await import(generatorPath) as {
  catalogFromDirectory: (dir?: string) => string;
  compareVersions: (left: string, right: string) => number;
  generateCatalog: (entries: Entry[]) => string;
  parseReleaseNote: (version: string, markdown: string) => Note;
};

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("release-note catalog generator", () => {
  it("orders release and prerelease versions by SemVer", () => {
    expect(["0.5.0-alpha.2", "0.5.0", "0.4.9"].sort((a, b) => compareVersions(b, a))).toEqual(["0.5.0", "0.5.0-alpha.2", "0.4.9"]);
  });

  it("keeps one summary paragraph and the section headings, inert, with a tagged Git source", () => {
    const note = parseReleaseNote("1.2.3", "# paseo-bm 1.2.3\n\n**Useful** [release](https://example.test). Update with:\n\n```bash\n## not a heading\npaseo plugin update paseo-bm\n```\n\n## Changes\n\n- One `thing`\n\nA body paragraph.\n\n### Detail\n");
    expect(note).toEqual({
      version: "1.2.3",
      summary: "Useful release.",
      sections: ["Changes", "Detail"],
      prereleases: [],
      gitUrl: expect.stringContaining("/blob/v1.2.3/"),
    });
    expect(parseReleaseNote("1.2.4", "# paseo-bm release notes — 1.2.4\n\n## Only\n").summary).toBe("paseo-bm 1.2.4");
  });

  it("folds a prerelease into its stable version and keeps one without a stable", () => {
    const note = (version: string) => ({ version, markdown: `# paseo-bm ${version}\n\nNote ${version}.\n` });
    const source = generateCatalog(["0.3.0-alpha.1", "0.3.0", "0.3.0-alpha.0", "0.4.0-alpha.0", "0.2.0"].map(note));
    const notes = JSON.parse(source.slice(source.indexOf("= [") + 2).replace(/;\s*$/, "")) as Note[];
    expect(notes.map((entry) => [entry.version, entry.prereleases])).toEqual([
      ["0.4.0-alpha.0", []],
      ["0.3.0", ["0.3.0-alpha.0", "0.3.0-alpha.1"]],
      ["0.2.0", []],
    ]);
    expect(notes[1]!.summary).toBe("Note 0.3.0.");
  });

  it("rejects a mismatched heading, duplicate version and unclosed fence", () => {
    expect(() => parseReleaseNote("1.2.3", "# paseo-bm 1.2.4\n")).toThrow(/same release version/);
    expect(() => parseReleaseNote("1.2.3", "# paseo-bm 1.2.3\n\n```\nno end\n")).toThrow(/unclosed/);
    expect(() => generateCatalog([
      { version: "1.2.3", markdown: "# paseo-bm 1.2.3\n" },
      { version: "1.2.3", markdown: "# paseo-bm 1.2.3\n" },
    ])).toThrow(/duplicate/);
  });

  it("is deterministic for a directory and emits safely escaped TypeScript", () => {
    const dir = mkdtempSync(join(tmpdir(), "bm-release-notes-"));
    dirs.push(dir);
    writeFileSync(join(dir, "paseo-bm-release-notes-1.0.0.md"), '# paseo-bm 1.0.0\n\nA "quote" and </script>.\n');
    const first = catalogFromDirectory(dir);
    const second = catalogFromDirectory(dir);
    expect(second).toBe(first);
    expect(first).toContain('\\"quote\\"');
    expect(first).not.toContain("</script>");
  });

  it("generates the checked-in catalog from every current authored release note", () => {
    const generated = catalogFromDirectory();
    const current = readFileSync(new URL("../plugin/client/release-notes.generated.ts", import.meta.url), "utf8");
    expect(current).toBe(generated);
    expect(generated).toContain('"version": "0.5.3"');
    expect(generated).not.toContain('"version": "0.3.0-alpha.7"');
    expect(generated).toContain('"0.3.0-alpha.7"');
  });
});
