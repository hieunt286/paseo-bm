/**
 * A small Markdown reader for bead descriptions.
 *
 * Plugins may only use React Native primitives, so there is no Markdown
 * library to lean on. Bead descriptions use a narrow subset — headings,
 * lists, task boxes, code blocks, quotes, tables and inline `code` / **bold** —
 * and this turns exactly that into blocks a renderer can draw. Anything else
 * stays a plain paragraph, so nothing is ever lost.
 *
 * Pure: no React, no React Native.
 */

export type Inline = { text: string; bold?: boolean; code?: boolean; italic?: boolean };

export type MarkdownBlock =
  | { kind: "heading"; level: number; spans: Inline[] }
  | { kind: "paragraph"; spans: Inline[] }
  | { kind: "bullet"; depth: number; spans: Inline[]; checked?: boolean }
  | { kind: "numbered"; depth: number; number: string; spans: Inline[] }
  | { kind: "quote"; spans: Inline[] }
  | { kind: "code"; language: string | null; text: string }
  | { kind: "table"; header: string[]; rows: string[][] }
  | { kind: "rule" };

/** `**bold**`, `*italic*`, `` `code` `` — no nesting, which bead text never needs. */
export function parseInline(text: string): Inline[] {
  const spans: Inline[] = [];
  const pattern = /(`[^`]+`|\*\*[^*]+\*\*|__[^_]+__|\*[^*\s][^*]*\*)/g;
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (index > last) spans.push({ text: text.slice(last, index) });
    const token = match[0];
    if (token.startsWith("`")) spans.push({ text: token.slice(1, -1), code: true });
    else if (token.startsWith("**") || token.startsWith("__")) spans.push({ text: token.slice(2, -2), bold: true });
    else spans.push({ text: token.slice(1, -1), italic: true });
    last = index + token.length;
  }
  if (last < text.length) spans.push({ text: text.slice(last) });
  return spans.length === 0 ? [{ text: "" }] : spans;
}

const cells = (line: string) =>
  line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());

export function parseMarkdown(source: string): MarkdownBlock[] {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const blocks: MarkdownBlock[] = [];
  let paragraph: string[] = [];
  const flush = () => {
    if (paragraph.length > 0) blocks.push({ kind: "paragraph", spans: parseInline(paragraph.join(" ")) });
    paragraph = [];
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;

    const fence = /^\s*```\s*([\w-]*)\s*$/.exec(line);
    if (fence !== null) {
      flush();
      const body: string[] = [];
      index += 1;
      while (index < lines.length && !/^\s*```\s*$/.test(lines[index]!)) {
        body.push(lines[index]!);
        index += 1;
      }
      blocks.push({ kind: "code", language: fence[1] === "" ? null : fence[1]!, text: body.join("\n") });
      continue;
    }

    if (line.trim() === "") {
      flush();
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading !== null) {
      flush();
      blocks.push({ kind: "heading", level: heading[1]!.length, spans: parseInline(heading[2]!.trim()) });
      continue;
    }

    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flush();
      blocks.push({ kind: "rule" });
      continue;
    }

    const next = lines[index + 1];
    if (line.includes("|") && next !== undefined && /^\s*\|?\s*:?-{2,}/.test(next)) {
      flush();
      const header = cells(line);
      const rows: string[][] = [];
      index += 2;
      while (index < lines.length && lines[index]!.includes("|") && lines[index]!.trim() !== "") {
        rows.push(cells(lines[index]!));
        index += 1;
      }
      index -= 1;
      blocks.push({ kind: "table", header, rows });
      continue;
    }

    const bullet = /^(\s*)[-*+]\s+(?:\[([ xX])\]\s+)?(.*)$/.exec(line);
    if (bullet !== null) {
      flush();
      const block: MarkdownBlock = {
        kind: "bullet",
        depth: Math.floor(bullet[1]!.length / 2),
        spans: parseInline(bullet[3]!),
      };
      if (bullet[2] !== undefined) block.checked = bullet[2].toLowerCase() === "x";
      blocks.push(block);
      continue;
    }

    const numbered = /^(\s*)(\d+)[.)]\s+(.*)$/.exec(line);
    if (numbered !== null) {
      flush();
      blocks.push({
        kind: "numbered",
        depth: Math.floor(numbered[1]!.length / 2),
        number: numbered[2]!,
        spans: parseInline(numbered[3]!),
      });
      continue;
    }

    const quote = /^\s*>\s?(.*)$/.exec(line);
    if (quote !== null) {
      flush();
      blocks.push({ kind: "quote", spans: parseInline(quote[1]!) });
      continue;
    }

    paragraph.push(line.trim());
  }
  flush();
  return blocks;
}
