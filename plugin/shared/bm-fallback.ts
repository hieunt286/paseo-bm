/**
 * Reader for the plugin's `BM-FALLBACK` notice (delta 20260921 §4.4.6).
 *
 * The plugin writes the block (`server/fallback-notices.ts`); the Manager chat
 * shows it as a card. It reaches the chat as a message a language model may
 * quote back, so this reader is forgiving in the same way as `bm-report.ts`:
 * key case and spacing do not matter, unknown keys are ignored, `none` /
 * `unknown` read as null, and a quoted block (`> `) still reads. It returns
 * `null` only when there is no marker line or no usable `incident:` id. The
 * card never trusts the text for its state: it reads `fallback.incidents`.
 */

/** First line of the notice. */
export const BM_FALLBACK_MARKER = "BM-FALLBACK";

/** How the notice and the Worker handover name each class. */
export const FALLBACK_CLASS_LABELS: Readonly<Record<"L1" | "L2" | "L4" | "L5", string>> = {
  L1: "L1 usage limit",
  L2: "L2 billing",
  L4: "L4 login",
  L5: "L5 provider unavailable",
};

const MARKER = /^\s*>?\s*(?:[-*]\s*)?bm-fallback\s*$/i;
const KEY_VALUE = /^\s*>?\s*([A-Za-z][A-Za-z0-9 _-]*)\s*:\s*(.*)$/;
const INCIDENT_ID = /^fb-[0-9a-f]{12}$/;
const ABSENT = new Set(["", "none", "unknown", "n/a", "-", "null"]);

export const FALLBACK_STATUSES = ["pending", "switched", "waiting", "resumed", "dismissed", "exhausted", "expired", "failed"] as const;
export type FallbackNoticeStatus = (typeof FALLBACK_STATUSES)[number];

/** What a `BM-FALLBACK` block says; a field it cannot read is `null`. */
export interface ParsedFallbackNotice {
  incident: string;
  role: "manager" | "worker" | "reviewer" | null;
  agent: string | null;
  requestId: string | null;
  status: FallbackNoticeStatus | null;
  /** `L1`, `L2`, `L4` or `L5`, from the `class:` line (`L1 usage limit`). */
  class: "L1" | "L2" | "L4" | "L5" | null;
  provider: string | null;
  message: string | null;
  resetsAt: string | null;
  candidate: string | null;
  replacement: string | null;
}

function valueOf(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  const trimmed = raw.trim().replace(/^`+|`+$/g, "").trim();
  return ABSENT.has(trimmed.toLowerCase()) ? null : trimmed;
}

/**
 * Parses the first `BM-FALLBACK` block of `text`, reading key lines up to the
 * first blank line after at least one key. Never throws.
 */
export function parseFallbackNotice(text: unknown): ParsedFallbackNotice | null {
  if (typeof text !== "string") return null;
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => MARKER.test(line));
  if (start === -1) return null;
  const fields = new Map<string, string>();
  for (const line of lines.slice(start + 1)) {
    const match = KEY_VALUE.exec(line);
    if (match === null) {
      if (line.trim() === "" && fields.size > 0) break;
      continue;
    }
    const key = match[1]!.replace(/[\s_-]/g, "").toLowerCase();
    if (!fields.has(key)) fields.set(key, match[2] ?? "");
  }
  const incident = valueOf(fields.get("incident"));
  if (incident === null || !INCIDENT_ID.test(incident)) return null;
  const role = valueOf(fields.get("role"))?.toLowerCase() ?? null;
  const status = valueOf(fields.get("status"))?.toLowerCase() ?? null;
  const cls = /^(L[1245])\b/i.exec(valueOf(fields.get("class")) ?? "")?.[1]?.toUpperCase() ?? null;
  return {
    incident,
    role: role === "manager" || role === "worker" || role === "reviewer" ? role : null,
    agent: valueOf(fields.get("agent")),
    requestId: valueOf(fields.get("requestid")),
    status: (FALLBACK_STATUSES as readonly string[]).includes(status ?? "") ? (status as FallbackNoticeStatus) : null,
    class: cls === "L1" || cls === "L2" || cls === "L4" || cls === "L5" ? cls : null,
    provider: valueOf(fields.get("provider")),
    message: valueOf(fields.get("message")),
    resetsAt: valueOf(fields.get("resetsat")),
    candidate: valueOf(fields.get("candidate")),
    replacement: valueOf(fields.get("replacement")),
  };
}
