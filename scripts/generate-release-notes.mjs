#!/usr/bin/env node
// Generates the client-side release-note catalog from docs/releases/, the
// single authored changelog source (Dashboard design §11.4).

import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const releasesDir = join(repoRoot, "docs", "releases");
const target = join(repoRoot, "plugin", "client", "release-notes.generated.ts");
const FILE = /^paseo-bm-release-notes-(.+)\.md$/;
const SEMVER = /^(?:v)?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function semver(value) {
  const matched = SEMVER.exec(value);
  if (matched === null) throw new Error(`invalid release-note version: ${value}`);
  return {
    core: [Number(matched[1]), Number(matched[2]), Number(matched[3])],
    prerelease: matched[4]?.split(".").map((part) => (/^(0|[1-9]\d*)$/.test(part) ? Number(part) : part)) ?? [],
  };
}

export function compareVersions(left, right) {
  const a = semver(left);
  const b = semver(right);
  for (let index = 0; index < 3; index += 1) {
    if (a.core[index] !== b.core[index]) return a.core[index] < b.core[index] ? -1 : 1;
  }
  if (a.prerelease.length === 0 || b.prerelease.length === 0) {
    return a.prerelease.length === b.prerelease.length ? 0 : a.prerelease.length === 0 ? 1 : -1;
  }
  for (let index = 0; index < Math.max(a.prerelease.length, b.prerelease.length); index += 1) {
    const av = a.prerelease[index];
    const bv = b.prerelease[index];
    if (av === undefined || bv === undefined) return av === bv ? 0 : av === undefined ? -1 : 1;
    if (av === bv) continue;
    if (typeof av === "number" && typeof bv === "string") return -1;
    if (typeof av === "string" && typeof bv === "number") return 1;
    return av < bv ? -1 : 1;
  }
  return 0;
}

function plainInline(value) {
  return value
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/[*_`~]/g, "")
    // Historical notes contain names retired from the shipped payload. Keep
    // their meaning without reintroducing those user-facing terms into the
    // current plugin bundle (plugin wording policy, ADR-026).
    .replace(/npx\s+paseo-bm(?:@[0-9A-Za-z.-]+)?(?:\s+[A-Za-z-]+)?/gi, "the legacy directory installer")
    .replace(/install home/gi, "directory installation")
    .trim();
}

function paragraph(lines, blocks) {
  const text = plainInline(lines.join(" ").replace(/\s+/g, " "));
  if (text !== "") blocks.push({ kind: "paragraph", text });
  lines.length = 0;
}

export function parseReleaseNote(version, markdown) {
  semver(version);
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const expected = new RegExp(`^#\\s+paseo-bm(?:\\s+release notes\\s+[—-])?\\s+${version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "i");
  if (!expected.test(lines[0] ?? "")) throw new Error(`${version}: first heading must name the same release version`);
  const title = plainInline((lines[0] ?? "").replace(/^#\s+/, ""));
  const blocks = [];
  const pending = [];
  let code = null;
  for (const line of lines.slice(1)) {
    if (line.startsWith("```")) {
      paragraph(pending, blocks);
      if (code === null) code = [];
      else {
        blocks.push({ kind: "code", text: plainInline(code.join("\n")) });
        code = null;
      }
      continue;
    }
    if (code !== null) {
      code.push(line);
      continue;
    }
    const heading = /^#{2,3}\s+(.+)$/.exec(line);
    const bullet = /^\s*(?:[-*+] |\d+[.)]\s+)(.+)$/.exec(line);
    if (heading !== null) {
      paragraph(pending, blocks);
      blocks.push({ kind: "heading", text: plainInline(heading[1]) });
    } else if (bullet !== null) {
      paragraph(pending, blocks);
      blocks.push({ kind: "bullet", text: plainInline(bullet[1]) });
    } else if (line.trim() === "") paragraph(pending, blocks);
    else pending.push(line.trim());
  }
  if (code !== null) throw new Error(`${version}: unclosed fenced code block`);
  paragraph(pending, blocks);
  const summary = blocks.find((block) => block.kind === "paragraph")?.text ?? title;
  return {
    version,
    title,
    summary,
    blocks,
    gitUrl: `https://github.com/hieunt286/paseo-bm/blob/v${version}/docs/releases/paseo-bm-release-notes-${version}.md`,
  };
}

export function generateCatalog(entries) {
  const seen = new Set();
  const notes = entries.map(({ version, markdown }) => {
    if (seen.has(version)) throw new Error(`duplicate release-note version: ${version}`);
    seen.add(version);
    return parseReleaseNote(version, markdown);
  }).sort((a, b) => compareVersions(b.version, a.version));
  return `// GENERATED FILE — do not edit.\n// Source: docs/releases/*.md via scripts/generate-release-notes.mjs.\n\nexport type ReleaseNoteBlock = { kind: "heading" | "paragraph" | "bullet" | "code"; text: string };\nexport interface ReleaseNote { version: string; title: string; summary: string; blocks: readonly ReleaseNoteBlock[]; gitUrl: string }\n\nexport const RELEASE_NOTES: readonly ReleaseNote[] = ${JSON.stringify(notes, null, 2)};\n`;
}

export function catalogFromDirectory(dir = releasesDir) {
  const entries = readdirSync(dir).sort().flatMap((name) => {
    const matched = FILE.exec(name);
    return matched === null ? [] : [{ version: matched[1], markdown: readFileSync(join(dir, name), "utf8") }];
  });
  return generateCatalog(entries);
}

function main() {
  const next = catalogFromDirectory();
  const current = existsSync(target) ? readFileSync(target, "utf8") : "";
  if (process.argv.includes("--check")) {
    if (current !== next) {
      console.error("plugin/client/release-notes.generated.ts is stale; run `npm run generate:release-notes`");
      process.exit(1);
    }
    console.log(`release notes: ${readdirSync(releasesDir).filter((name) => FILE.test(name)).length} entries current`);
    return;
  }
  if (current !== next) {
    writeFileSync(target, next);
    console.log("generated plugin/client/release-notes.generated.ts");
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
