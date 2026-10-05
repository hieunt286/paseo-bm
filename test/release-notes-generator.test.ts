import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

interface Entry { version: string; markdown: string }
interface Block { kind: "heading" | "paragraph" | "bullet" | "code"; text: string }
interface Note { version: string; summary: string; gitUrl: string; blocks: Block[] }
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

  it("extracts inert headings, paragraphs, bullets and code with a tagged Git source", () => {
    const note = parseReleaseNote("1.2.3", "# paseo-bm 1.2.3\n\n**Useful** [release](https://example.test).\n\n## Changes\n\n- One `thing`\n\n```bash\npaseo plugin update paseo-bm\n```\n");
    expect(note).toMatchObject({ version: "1.2.3", summary: "Useful release.", gitUrl: expect.stringContaining("/blob/v1.2.3/") });
    expect(note.blocks).toEqual([
      { kind: "paragraph", text: "Useful release." },
      { kind: "heading", text: "Changes" },
      { kind: "bullet", text: "One thing" },
      { kind: "code", text: "paseo plugin update paseo-bm" },
    ]);
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
  });
});
