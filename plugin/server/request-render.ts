/**
 * One request as text, for the Orchestrator's `bm_request` (Orchestrator
 * design §5.2; autonomy design §A.9), and the cut every bounded Orchestrator
 * read shares (`cutText`).
 *
 * - `buildRequestContent` turns one request's `TraceDetail` — built by
 *   `traces.get`, never re-derived here — into text. Pure: every piece goes
 *   through the collector's `redactText`, and above `REQUEST_MAX_CHARS` the
 *   longest messages are cut first, each keeping its start and end around
 *   `TRUNCATED_MARKER`.
 *
 * It was the first design's assessment content (`assessment.ts`); the
 * assessment and the rule flags it carried are retired (autonomy design §B.8,
 * §B.9), and the request's figures are what is left.
 *
 * Characters are counted in code points, so a cut never splits one.
 */
import type { ParsedReport, TraceDetail, TraceMessage, TraceVerification, Usage } from "../shared/contracts";
import { redactText } from "./collector";

/** The most characters `bm_request` returns with `detail: "full"` (design §5.2). */
export const REQUEST_MAX_CHARS = 60_000;

/** What marks the place a message was cut (design §5.2, `roles/orchestrator.md`). */
export const TRUNCATED_MARKER = "...[truncated]";

/** The marker on a line of its own, between the kept start and end. */
const CUT = `\n${TRUNCATED_MARKER}\n`;

/**
 * One piece of the content: a heading line, and the text under it. Only
 * `text` is ever cut; a section heading is a part with an empty text.
 */
export interface RequestPart {
  title: string;
  text: string;
}

export interface RequestContent {
  /** The text handed out. */
  text: string;
  /** Length of `text` in code points; never above the cap. */
  chars: number;
  /** `ceil(chars / 4)`: for display only, labelled "approx." (design §5.2). */
  approxTokens: number;
  /** True when a message was cut to fit the cap. */
  truncated: boolean;
}

/** The token estimate of design §5.2: characters / 4, rounded up. */
export function approxTokensOf(chars: number): number {
  return Math.ceil(chars / 4);
}

function lengthOf(text: string): number {
  return Array.from(text).length;
}

/**
 * `text` cut to at most `limit` code points (never below the marker's own
 * length): its start and its end, the marker between them. Shorter text is
 * returned as it is.
 */
export function cutText(text: string, limit: number): string {
  const chars = Array.from(text);
  if (chars.length <= limit) return text;
  const keep = Math.max(0, limit - lengthOf(CUT));
  const head = Math.ceil(keep / 2);
  const tail = keep - head;
  return `${chars.slice(0, head).join("")}${CUT}${tail > 0 ? chars.slice(chars.length - tail).join("") : ""}`;
}

/** The parts as one text: each heading with its text below it, a blank line between parts. */
export function renderParts(parts: readonly RequestPart[]): string {
  return parts.map((part) => (part.text === "" ? part.title : `${part.title}\n${part.text}`)).join("\n\n");
}

/**
 * The parts cut to fit `maxChars` once rendered, longest texts first: every
 * text longer than one common limit is cut to that limit, the largest limit
 * that fits, so a short message is only touched when every longer one has
 * already been cut to its length. If even the headings do not fit, the whole
 * rendered text is cut last (`single`), so the cap always holds.
 */
export function capParts(
  parts: readonly RequestPart[],
  maxChars: number,
): { parts: RequestPart[]; truncated: boolean; single: string | null } {
  const rendered = renderParts(parts);
  const total = lengthOf(rendered);
  if (total <= maxChars) return { parts: [...parts], truncated: false, single: null };

  const lengths = parts.map((part) => lengthOf(part.text));
  const budget = maxChars - (total - lengths.reduce((sum, length) => sum + length, 0));
  const floor = lengthOf(CUT);
  const sizeAt = (limit: number): number => lengths.reduce((sum, length) => sum + Math.min(length, limit), 0);

  let low = floor;
  let high = Math.max(floor, ...lengths);
  if (sizeAt(low) > budget) {
    const cut = parts.map((part) => ({ ...part, text: cutText(part.text, floor) }));
    return { parts: cut, truncated: true, single: cutText(renderParts(cut), maxChars) };
  }
  // The largest limit whose total still fits.
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (sizeAt(middle) <= budget) low = middle;
    else high = middle - 1;
  }
  return { parts: parts.map((part) => ({ ...part, text: cutText(part.text, low) })), truncated: true, single: null };
}

// ---------------------------------------------------------------------------
// The parts of one request (design §5.2).
// ---------------------------------------------------------------------------

const section = (title: string): RequestPart => ({ title: `## ${title}`, text: "" });
const NONE: RequestPart = { title: "(none recorded)", text: "" };

function messagePart(message: TraceMessage, extra: string[] = []): RequestPart {
  const heading = [message.agentId ?? "user", message.at, ...extra];
  if (message.truncated) heading.push("cut when it was recorded");
  return { title: `### ${heading.join(" · ")}`, text: message.text };
}

function listed(label: string, values: readonly string[]): string | null {
  return values.length === 0 ? null : `${label}: ${values.join(", ")}`;
}

function reportPart(report: ParsedReport): RequestPart {
  const lines = [
    report.tier === null ? null : `tier: ${report.tier}`,
    report.requestId === null ? null : `requestId: ${report.requestId}`,
    listed("files changed", report.filesChanged),
    listed("beads created", report.beadsCreated),
    listed("beads updated", report.beadsUpdated),
    listed("beads closed", report.beadsClosed),
    listed("beads ready", report.beadsReady),
    report.reviewFindingsOpen === null ? null : `review findings open: ${report.reviewFindingsOpen}`,
    report.buildAndTests === null ? null : `build and tests: ${report.buildAndTests}`,
    listed("skills used", report.skillsUsed),
    listed("decided", report.decided ?? []),
    report.blockers === null ? null : `blockers: ${report.blockers}`,
    report.guardrail === null ? null : `guardrail: ${report.guardrail.raw}`,
    listed("fields that could not be read", [...report.unparsedFields, ...report.incompleteFields]),
  ].filter((line): line is string => line !== null);
  return {
    title: `### ${report.phase ?? "unknown phase"} · ${report.agentId} · ${report.at}`,
    text: lines.join("\n"),
  };
}

function usageLine(usage: Usage): string {
  const cost = usage.costUsd === null ? "cost unknown" : `cost $${usage.costUsd.toFixed(4)} (${usage.costBasis})`;
  return `input ${usage.inputTokens}, cached input ${usage.cachedInputTokens}, output ${usage.outputTokens} tokens; ${cost}`;
}

/**
 * The request's finish in one line (autonomy design §C.3): finished-unverified
 * or not, and each check its report names with its label (§C.2).
 */
function finishLineOf(verification: TraceVerification): string {
  const verdict = verification.unverified ? `unverified (code changed; checks ${verification.checks})` : `checks ${verification.checks}`;
  const named = verification.named.map((claim) => `${claim.check} (${claim.label})`).join(", ");
  return `finish: ${verdict}${named === "" ? "" : ` — ${named}`}`;
}

function duration(ms: number | null): string {
  return ms === null ? "unknown" : `${Math.round(ms / 1000)} s`;
}

function orNone(parts: RequestPart[]): RequestPart[] {
  return parts.length === 0 ? [NONE] : parts;
}

/** Every part of design §5.2, in a fixed order, before redaction and the cap. */
export function requestPartsOf(detail: TraceDetail): RequestPart[] {
  const reviewCalls = detail.reviewCalls === null ? "unknown" : String(detail.reviewCalls);
  const figures = [
    `duration: ${duration(detail.durationMs)} (${detail.timing.basis})`,
    `Manager turns: ${detail.timing.managerTurns.length}`,
    ...[...detail.timing.workers, ...detail.timing.reviewers].map(
      (agent) => `${agent.role} ${agent.agentId}: ${duration(agent.ms)}, ${agent.state}`,
    ),
    `tokens, whole request: ${usageLine(detail.usage)}`,
    ...detail.usageByAgent.map((entry) => `tokens, ${entry.role} ${entry.agentId}: ${usageLine(entry.usage)}`),
    `review calls: ${reviewCalls}`,
    ...(detail.guardrailReported === null ? [] : [`review guardrail reported: ${detail.guardrailReported.raw}`]),
    `beads: created ${detail.beadCounts.created.count}, updated ${detail.beadCounts.updated.count}, closed ${detail.beadCounts.closed.count}`,
  ];
  const skills = detail.skills.map((entry) => `${entry.skill} (${entry.agentId}, ${entry.at ?? "time unknown"})`);

  return [
    {
      title: "# The request",
      text: [
        `traceId: ${detail.traceId}`,
        `requestId: ${detail.requestId ?? "none"}`,
        `requested at: ${detail.requestedAt}`,
        `state: ${detail.state}`,
        ...(detail.verification === undefined ? [] : [finishLineOf(detail.verification)]),
        `linked to its agents: ${detail.linking}`,
        ...(detail.agentsMissing.length === 0 ? [] : [`agents no longer in Paseo: ${detail.agentsMissing.join(", ")}`]),
      ].join("\n"),
    },
    section("The request, verbatim"),
    ...(detail.sent.userRequest === null ? [NONE] : [messagePart(detail.sent.userRequest)]),
    { title: "## Size", text: detail.tier ?? "not reported" },
    section("The Worker's initial prompt"),
    ...orNone(detail.sent.workerInitialPrompts.map((message) => messagePart(message))),
    section("BM-REPORTs by milestone"),
    ...orNone(detail.received.reports.map(reportPart)),
    section("Review requests"),
    ...orNone(
      detail.sent.reviewRequests.map((message) => messagePart(message, message.batchId === null ? [] : [`batch ${message.batchId}`])),
    ),
    section("BM-REVIEWs"),
    ...orNone(
      detail.received.reviews.map((review) => ({
        title: `### ${review.agentId} · ${review.at}`,
        text: [
          `batch: ${review.batchId ?? "unknown"}`,
          `verdict: ${review.verdict ?? "unknown"}`,
          `blocking findings: ${review.blockingCount ?? "unknown"}`,
        ].join("\n"),
      })),
    ),
    section("The Manager's replies to the user"),
    ...orNone(detail.received.managerReplies.map((message) => messagePart(message))),
    section("The user's messages"),
    ...orNone(detail.userMessages.map((message) => messagePart(message))),
    {
      title: "## Feature-workflow steps",
      text: [
        ...detail.workflowSteps.map(
          (step) => `- ${step.step}: ${step.status} (${step.confidence})${step.note === null ? "" : ` — ${step.note}`}`,
        ),
        ...(skills.length === 0 ? [] : [`skills loaded: ${skills.join("; ")}`]),
      ].join("\n"),
    },
    { title: "## Time, tokens and review calls", text: figures.join("\n") },
  ];
}

/**
 * What `bm_request` returns (autonomy design §A.9): every part through
 * `redactText` (with `env`, the process's own by default), then cut to
 * `maxChars`. Redaction comes first so a cut never leaves half a secret behind.
 *
 * `noteWhenCut` is one line put above the content only when something had to
 * be cut; the cap then holds for the note and the content together.
 */
export function buildRequestContent(
  detail: TraceDetail,
  options: { env?: NodeJS.ProcessEnv; maxChars?: number; noteWhenCut?: string } = {},
): RequestContent {
  const env = options.env ?? process.env;
  const maxChars = options.maxChars ?? REQUEST_MAX_CHARS;
  const redacted = requestPartsOf(detail).map((part) => ({
    title: redactText(part.title, env),
    text: redactText(part.text, env),
  }));
  let capped = capParts(redacted, maxChars);
  let note = "";
  if (capped.truncated && options.noteWhenCut !== undefined) {
    note = `${options.noteWhenCut.replace(/\s+/g, " ").trim()}\n`;
    capped = capParts(redacted, Math.max(0, maxChars - lengthOf(note)));
  }
  const text = `${note}${capped.single ?? renderParts(capped.parts)}`;
  const chars = lengthOf(text);
  return { text, chars, approxTokens: approxTokensOf(chars), truncated: capped.truncated };
}
