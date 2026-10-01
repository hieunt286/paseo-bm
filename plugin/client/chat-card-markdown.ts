/**
 * The message in Details, and a card shown as plain text: a chat message as
 * Markdown, its report and review blocks one field per line. Split from
 * `chat-cards.ts` (code review 2026-09-30 §4).
 *
 * Pure: no React, no React Native, no `server/` import.
 */

/** A block's marker line, bolded or not (`**BM-REPORT**`, as `shared/bm-report.ts` reads it). */
const BLOCK_START = /^\s*>?\s*(?:```\s*)?(?:\*\*)?(BM-REPORT|BM-REVIEW|BM-QUESTIONS|BM-ANSWERS)\b/;
/** An option line of a `BM-QUESTIONS` block, nested under its question. */
const OPTION_LINE = /^>?\s*[-*]\s+(?:\(([a-z])\)|([a-z])\s*[:.)])\s*(.*)$/i;
const FENCE = /^\s*```\s*$/;
/** A top-level `key: value` line; indented lines belong to a list item above. */
const FIELD = /^>?\s?([A-Za-z][A-Za-z0-9_]*)\s*:\s*(.*)$/;

/**
 * The message as Markdown. Report and review blocks are `key: value` lines,
 * which Markdown would run together into one paragraph, so each becomes a list
 * item with the key in bold. The fences around a block are dropped.
 */
export function markdownOf(text: string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  let inBlock = false;
  lines.forEach((line, index) => {
    if (!inBlock && FENCE.test(line) && BLOCK_START.test(lines[index + 1] ?? "")) return;
    if (BLOCK_START.test(line)) {
      inBlock = true;
      out.push(`**${line.trim().replace(/^>?\s*(?:```\s*)?/, "").replace(/\*\*/g, "").trim()}**`);
      out.push("");
      return;
    }
    if (inBlock) {
      if (FENCE.test(line)) {
        inBlock = false;
        return;
      }
      const field = FIELD.exec(line);
      if (field !== null) {
        out.push(`- **${field[1]}**: ${field[2]}`);
        return;
      }
      const option = OPTION_LINE.exec(line);
      if (option !== null) {
        out.push(`  - **${option[1] ?? option[2]}**: ${option[3]}`);
        return;
      }
      if (line.trim() === "") inBlock = false;
    }
    out.push(line);
  });
  return out.join("\n");
}

/**
 * The Markdown of a message shown as plain text instead of a card (delta
 * 20260918g §4.8): laid out like Details, one field per line.
 */
export function fallbackMarkdown(card: { text: string }): string {
  return markdownOf(card.text);
}
