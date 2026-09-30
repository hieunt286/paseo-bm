/**
 * The Orchestrator's assessment (Orchestrator design §5): what is sent to the
 * `bm-orchestrator` agent and where it will run.
 *
 * - `buildAssessmentContent` (§5.2) turns one request's `TraceDetail` — built
 *   by `traces.get`, never re-derived here — and its flags (§4) into the text
 *   the agent receives. Pure: every piece goes through the collector's
 *   `redactText`, and above `ASSESSMENT_MAX_CHARS` the longest messages are cut
 *   first, each keeping its start and end around `TRUNCATED_MARKER`.
 * - `assessmentTargetOf` (§5.4) reads the `bm-orchestrator` profile and the
 *   provider its alias extends, and fails `E_ORCHESTRATOR_UNAVAILABLE` when
 *   either is missing or the provider is not `available`.
 * - `startAssessmentAgent` (§5.1 step 3) creates the one `bm-orchestrator`
 *   agent of an assessment, its mode chosen under the Reviewer rule. It never
 *   archives, stops or deletes it (REQ-075 g).
 *
 * The first design's turn-end reader of the assessment agent is gone
 * (Orchestrator design §5.5, §11): a workflow assessment reaches the store
 * through the Orchestrator's `bm_assessment` tool.
 *
 * Characters are counted in code points, so a cut never splits one.
 */
import {
  DashboardError,
  type ParsedReport,
  type TraceDetail,
  type TraceMessage,
  type Usage,
} from "../shared/contracts";
import type { Flag } from "../shared/orchestrator-rules";
import { aliasBases } from "./alias-bases";
import { redactText } from "./collector";
import { availableProviders } from "./role-choices";
import { capabilityOf, chooseModeId, featuresFor, modesFor, profileOf, runPostureOf } from "./role-mode";
import { PLUGIN_VERSION } from "../shared/version";

/** The most characters sent to the assessment agent (design §5.2). */
export const ASSESSMENT_MAX_CHARS = 60_000;

/** What marks the place a message was cut (design §5.2, `roles/orchestrator.md`). */
export const TRUNCATED_MARKER = "...[truncated]";

/** The marker on a line of its own, between the kept start and end. */
const CUT = `\n${TRUNCATED_MARKER}\n`;

/** The profile and provider alias of the assessment agent (design §3.1). */
export const ORCHESTRATOR_PROVIDER_ID = "bm-orchestrator";

/**
 * One piece of the content: a heading line, and the text under it. Only
 * `text` is ever cut; a section heading is a part with an empty text.
 */
export interface AssessmentPart {
  title: string;
  text: string;
}

export interface AssessmentContent {
  /** What the agent receives as its first message. */
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
export function renderParts(parts: readonly AssessmentPart[]): string {
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
  parts: readonly AssessmentPart[],
  maxChars: number,
): { parts: AssessmentPart[]; truncated: boolean; single: string | null } {
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

const section = (title: string): AssessmentPart => ({ title: `## ${title}`, text: "" });
const NONE: AssessmentPart = { title: "(none recorded)", text: "" };

function messagePart(message: TraceMessage, extra: string[] = []): AssessmentPart {
  const heading = [message.agentId ?? "user", message.at, ...extra];
  if (message.truncated) heading.push("cut when it was recorded");
  return { title: `### ${heading.join(" · ")}`, text: message.text };
}

function listed(label: string, values: readonly string[]): string | null {
  return values.length === 0 ? null : `${label}: ${values.join(", ")}`;
}

function reportPart(report: ParsedReport): AssessmentPart {
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

function duration(ms: number | null): string {
  return ms === null ? "unknown" : `${Math.round(ms / 1000)} s`;
}

function flagPart(flag: Flag): AssessmentPart {
  const evidence = flag.evidence.map(
    (entry) => `- ${entry.kind} · ${entry.agentId} · ${entry.at ?? "time unknown"}: ${entry.excerpt}`,
  );
  return {
    title: `### ${flag.rule} · ${flag.severity} · ${flag.state}`,
    text: [`observed: ${flag.observed}`, `why: ${flag.why}`, ...(evidence.length === 0 ? [] : ["evidence:", ...evidence])].join(
      "\n",
    ),
  };
}

function orNone(parts: AssessmentPart[]): AssessmentPart[] {
  return parts.length === 0 ? [NONE] : parts;
}

/** Every part of design §5.2, in a fixed order, before redaction and the cap. */
export function assessmentPartsOf(detail: TraceDetail, flags: readonly Flag[]): AssessmentPart[] {
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
      title: "# The request to assess",
      text: [
        `traceId: ${detail.traceId}`,
        `requestId: ${detail.requestId ?? "none"}`,
        `requested at: ${detail.requestedAt}`,
        `state: ${detail.state}`,
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
    section("Flags the plugin's rules already raised"),
    ...orNone(flags.map(flagPart)),
  ];
}

/**
 * The content sent to the assessment agent (design §5.2), and what
 * `bm_request` returns (autonomy design §A.9): every part through
 * `redactText` (with `env`, the process's own by default), then cut to
 * `maxChars`. Redaction comes first so a cut never leaves half a secret behind.
 *
 * `noteWhenCut` is one line put above the content only when something had to
 * be cut; the cap then holds for the note and the content together.
 */
export function buildAssessmentContent(
  detail: TraceDetail,
  flags: readonly Flag[],
  options: { env?: NodeJS.ProcessEnv; maxChars?: number; noteWhenCut?: string } = {},
): AssessmentContent {
  const env = options.env ?? process.env;
  const maxChars = options.maxChars ?? ASSESSMENT_MAX_CHARS;
  const redacted = assessmentPartsOf(detail, flags).map((part) => ({
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

// ---------------------------------------------------------------------------
// Where it runs (design §5.1, §5.4).
// ---------------------------------------------------------------------------

export interface AssessmentTarget {
  /** The provider the `bm-orchestrator` alias extends (`claude`, `codex`, …). */
  provider: string;
  /** The profile's model; null when the profile sets none (the provider's default). */
  model: string | null;
  /** The mode set by hand on the profile; null when it sets none. Used only under the Reviewer rule. */
  modeId: string | null;
}

/**
 * The provider and model the assessment agent will run on, from the
 * `bm-orchestrator` profile and the provider its alias extends. Fails
 * `E_ORCHESTRATOR_UNAVAILABLE` — and nothing may be created — when the profile
 * cannot be read or does not exist, the alias names no provider, or Paseo does
 * not report that provider as available (including when it cannot say).
 */
export async function assessmentTargetOf(paseo: unknown): Promise<AssessmentTarget> {
  const unavailable = (detail: string) => new DashboardError("E_ORCHESTRATOR_UNAVAILABLE", detail);
  const quiet = (): void => {};
  const [profile, bases] = await Promise.all([profileOf(paseo, ORCHESTRATOR_PROVIDER_ID, quiet), aliasBases(paseo)]);
  if (profile === null) {
    throw unavailable(
      `Paseo has no ${ORCHESTRATOR_PROVIDER_ID} profile paseo-bm can read; open Beads Manager → Settings to create the Beads Orchestrator role`,
    );
  }
  const provider = bases[ORCHESTRATOR_PROVIDER_ID];
  if (provider === undefined) {
    throw unavailable(`the ${ORCHESTRATOR_PROVIDER_ID} provider names no provider it extends; choose one in Settings → Agents`);
  }
  const available = await availableProviders(paseo);
  if (available === null) throw unavailable(`Paseo cannot say whether ${provider} is available right now; try again`);
  if (!available.has(provider)) throw unavailable(`${provider} is not available in Paseo right now`);
  return { provider, model: profile.model, modeId: profile.modeId };
}

// ---------------------------------------------------------------------------
// Creating the assessment agent (design §5.1 step 3, §5.4, §9).
// ---------------------------------------------------------------------------

/** Title of every assessment agent (design §5.1). */
export const ASSESSMENT_AGENT_TITLE = "Beads Orchestrator — assessment";

/** Label naming the assessment an agent was created for. */
export const ASSESSMENT_ID_LABEL = "bm.assessmentId";

/** What a just-created agent says about itself; the fields `manager.ts` reads for a broken start. */
export interface AssessmentAgentSnapshot {
  status?: string;
  providerUnavailable?: boolean;
  lastError?: string;
}

/**
 * A just-created agent. Deliberately without `archive`: the plugin never
 * archives, stops or deletes the assessment agent (REQ-075 g) — the user asked
 * for it and cleans it up.
 */
export interface AssessmentAgentHandle {
  readonly id: string;
  current(): AssessmentAgentSnapshot | null;
}

/** The SDK slice the creation uses; `PaseoApi` is structurally assignable. */
export interface AssessmentCreatePaseo {
  workspaces: {
    ref(workspaceId: string): {
      agents: {
        create(options: {
          config: { provider: string; modeId?: string; featureValues?: Record<string, unknown> };
          title: string;
          labels: Record<string, string>;
          prompt: string;
        }): Promise<AssessmentAgentHandle>;
      };
    };
  };
}

/** What `startAssessmentAgent` needs; the caller has built the content and written the `pending` line. */
export interface AssessmentStart {
  workspaceId: string;
  /** The workspace's folder, for the mode and feature lookups; undefined when unknown. */
  cwd: string | undefined;
  target: AssessmentTarget;
  assessmentId: string;
  /** Becomes `bm.requestId` when the trace has one. */
  requestId: string | null;
  /** The content, exactly as the preview measured it. */
  prompt: string;
  log?: (message: string) => void;
}

/** `bm-orchestrator/<profile model>`, or the bare alias when the profile sets no model. */
export function assessmentProviderSelection(target: AssessmentTarget): string {
  return target.model === null ? ORCHESTRATOR_PROVIDER_ID : `${ORCHESTRATOR_PROVIDER_ID}/${target.model}`;
}

/**
 * The start posture of the assessment agent, chosen as `fallback-switch.ts`
 * chooses a replacement Worker's but under the Reviewer rule (design §3.1):
 * the daemon refuses a creation whose mode it cannot inherit, so the mode is
 * passed explicitly. Tiered providers (Claude, Codex) get `chooseModeId` —
 * never a `dangerous` or `planning` mode; an untiered one (OpenCode) a listed
 * mode and `auto_accept: false`; a provider without modes (Pi) neither.
 */
export async function assessmentPostureOf(
  paseo: unknown,
  target: AssessmentTarget,
  cwd: string | undefined,
  log: (message: string) => void,
): Promise<{ modeId?: string; featureValues?: Record<string, unknown> }> {
  const modes = await modesFor(paseo, ORCHESTRATOR_PROVIDER_ID, log, cwd);
  const capability = capabilityOf(modes);
  const features = capability === "untiered" ? await featuresFor(paseo, assessmentProviderSelection(target), cwd, log) : null;
  const posture = runPostureOf("orchestrator", capability, modes ?? [], features, target.modeId);
  const modeId =
    capability === "tiered" && modes !== null
      ? chooseModeId("orchestrator", modes, undefined, target.modeId)
      : (posture?.modeId ?? undefined);
  const featureValues = posture?.featureValues ?? undefined;
  return {
    ...(modeId !== undefined ? { modeId } : {}),
    ...(featureValues !== undefined ? { featureValues } : {}),
  };
}

/** The snapshot of a just-created agent says its provider could not start (as `manager.ts` reads it). */
export function assessmentStartedBroken(snapshot: AssessmentAgentSnapshot | null): boolean {
  return snapshot !== null && (snapshot.status === "error" || snapshot.providerUnavailable === true);
}

/**
 * Creates the one `bm-orchestrator` agent of an assessment in the request's
 * workspace (design §5.1 step 3), with the content as its first message. The
 * `agent.create` hook adds the role's instructions and the `bm_assessment`
 * tool. Throws what the SDK throws; returns the handle whether or not the
 * agent started, so the caller records a broken start.
 */
export async function startAssessmentAgent(paseo: AssessmentCreatePaseo, start: AssessmentStart): Promise<AssessmentAgentHandle> {
  const log = start.log ?? ((message: string) => console.warn(message));
  const posture = await assessmentPostureOf(paseo, start.target, start.cwd, log);
  return paseo.workspaces.ref(start.workspaceId).agents.create({
    config: { provider: assessmentProviderSelection(start.target), ...posture },
    title: ASSESSMENT_AGENT_TITLE,
    labels: {
      "bm.role": "orchestrator",
      "bm.version": PLUGIN_VERSION,
      ...(start.requestId !== null ? { "bm.requestId": start.requestId } : {}),
      [ASSESSMENT_ID_LABEL]: start.assessmentId,
    },
    prompt: start.prompt,
  });
}
