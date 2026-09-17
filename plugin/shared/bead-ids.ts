/**
 * Strings in a message that look like bead ids (`bm-dcz`, `repo-37g`,
 * `cus-contact-uiux-redesign-u9zv.12`). Only a shape test: many hyphenated
 * words match too (`feature-workflow`), so callers keep only the ids the
 * workspace's bead store actually has.
 *
 * Pure and environment-neutral.
 */

const TOKEN = /(?<![A-Za-z0-9_./-])([a-z][a-z0-9]*(?:-[a-z0-9]+)+(?:\.\d+)*)(?![A-Za-z0-9_/-]|\.[A-Za-z0-9])/gi;
const REQUEST_ID = /^req-\d{8}t\d{6}z$/i;

/** Distinct candidates in order of first appearance, at most `limit`. */
export function beadIdCandidates(text: string, limit = 80): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(TOKEN)) {
    const id = match[1]!;
    if (REQUEST_ID.test(id) || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    if (out.length >= limit) break;
  }
  return out;
}
