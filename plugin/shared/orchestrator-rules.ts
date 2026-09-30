/**
 * The Orchestrator's rules: a fixed catalogue scored over one request, no LLM
 * (Orchestrator design §4.1, §4.2; REQ-072).
 *
 * `flagsOf` is pure and deterministic: the same `RuleInput` and `RuleFacts`
 * always give the same flags, in the order of `RULE_IDS`, at most one flag per
 * rule. A rule that lacks the data to decide returns `state: "unknown"` rather
 * than staying silent (REQ-072d); it never turns missing data into a pass.
 *
 * This module is `shared/`: it imports no server code. What only the server
 * knows comes in `RuleFacts` — the review budget (`server/review-budget.ts`),
 * the model-correction log (`server/orchestrator-store.ts`) and the workspace
 * folder.
 */
import type { Tier } from "./contracts";
import { fallbackAliasOf } from "./fallback";
import { guessLanguage, type GuessedLanguage } from "./language-guess";
import { isPluginNotice } from "./notices";
import { byAt } from "./order";
import type { ModelCorrection, RuleId } from "./orchestrator";
import type { RuleAgent, RuleInput, RuleMessage } from "./rule-input";

/** The longest excerpt a flag's evidence carries (design §4.1). */
export const EXCERPT_MAX_CHARS = 160;

/** How long after a model correction the corrected agent may start (design §4.3). */
export const CORRECTION_WINDOW_MS = 120_000;

export interface FlagEvidence {
  agentId: string;
  at: string | null;
  /**
   * Named after the trace store: `sent` is a message an agent RECEIVED (the
   * record's `sent`), `received` is what the agent wrote back.
   */
  kind: "report" | "sent" | "received" | "evidence" | "correction";
  /** At most `EXCERPT_MAX_CHARS` characters. */
  excerpt: string;
}

export interface Flag {
  rule: RuleId;
  severity: "info" | "warning";
  state: "raised" | "unknown";
  /** One English sentence: what was seen. */
  observed: string;
  /** One English sentence: why it matters. */
  why: string;
  evidence: FlagEvidence[];
}

export interface RuleFacts {
  /** `REVIEW_BUDGET` of `server/review-budget.ts`. */
  reviewBudget: Readonly<Record<Tier, number>>;
  /** The model-correction log (design §4.3), any order. */
  corrections: readonly ModelCorrection[];
  /** The workspace's folder; null when it is not known. */
  workspaceDirectory: string | null;
}

/** One line, whitespace collapsed, cut to `EXCERPT_MAX_CHARS` characters with an ellipsis. */
export function excerptOf(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  const chars = Array.from(line);
  return chars.length <= EXCERPT_MAX_CHARS ? line : `${chars.slice(0, EXCERPT_MAX_CHARS - 1).join("")}…`;
}

function flag(
  rule: RuleId,
  severity: Flag["severity"],
  state: Flag["state"],
  observed: string,
  why: string,
  evidence: FlagEvidence[],
): Flag {
  return {
    rule,
    severity,
    state,
    observed,
    why,
    // Oldest first, whatever order the rule found them in (a missing time first).
    evidence: [...evidence].sort(byAt).map((entry) => ({ ...entry, excerpt: excerptOf(entry.excerpt) })),
  };
}

type Report = RuleInput["reports"][number];

function reportEvidence(report: Report, detail: string): FlagEvidence {
  return {
    agentId: report.agentId,
    at: report.at,
    kind: "report",
    excerpt: `BM-REPORT phase: ${report.phase ?? "unreadable"}; ${detail}`,
  };
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

// ── process.small-heavy ─────────────────────────────────────────────────────

const PROCESS_DOC = /(?:^|[\\/])docs[\\/](?:plans|adr)[\\/]/;

/**
 * True for a path under `docs/plans/` or `docs/adr/`, relative or absolute: a
 * plan or an ADR is process weight a Small request never needs. Product and
 * design documents do not count — `worker.md` lets a Small request correct the
 * documents that describe it, and the evidence cannot tell creating from
 * editing. Shared with the live watcher (design §6.5), which must use the
 * same test.
 */
export function isProcessDocumentPath(path: string): boolean {
  return PROCESS_DOC.test(path);
}

/**
 * A tool call's evidence. The collector always records the agent that ran it;
 * the stored field is nullable only by schema, so a missing one becomes "".
 */
function toolEvidence(entry: RuleInput["fileEdits"][number], excerpt: string): FlagEvidence {
  return { agentId: entry.agentId ?? "", at: entry.at, kind: "evidence", excerpt };
}

function smallHeavy(input: RuleInput): Flag | null {
  const evidence: FlagEvidence[] = [];
  const beadReports = input.reports.filter((report) => report.beadsCreated.length > 0);
  for (const report of beadReports) {
    evidence.push(reportEvidence(report, `beadsCreated: ${report.beadsCreated.join(", ")}`));
  }
  for (const entry of input.brCreates) evidence.push(toolEvidence(entry, entry.detail));
  const beads = input.beadCounts.created.count > 0 || input.brCreates.length > 0;

  const docPaths = input.filesChanged.filter(isProcessDocumentPath);
  for (const path of docPaths) {
    const report = input.reports.find((candidate) => candidate.filesChanged.includes(path));
    if (report !== undefined) evidence.push(reportEvidence(report, `filesChanged: ${path}`));
  }
  const docEdits = input.fileEdits.filter((entry) => isProcessDocumentPath(entry.detail));
  for (const entry of docEdits) evidence.push(toolEvidence(entry, `edit/write ${entry.detail}`));
  const docs = docPaths.length > 0 || docEdits.length > 0;

  if (!beads && !docs) return null;
  const what = [beads ? "created beads" : null, docs ? "wrote or edited a plan or an ADR under docs/plans or docs/adr" : null]
    .filter((part) => part !== null)
    .join(" and ");
  const why =
    "A Small request is done and proved directly, without beads, plans or ADRs, so this much process suggests the size or the process is off.";
  if (input.tier === "Small") {
    return flag("process.small-heavy", "warning", "raised", `The Worker sized this request Small but ${what}.`, why, evidence);
  }
  if (input.tier === null) {
    return flag(
      "process.small-heavy",
      "warning",
      "unknown",
      `The Worker ${what}, but no report gave the request's tier.`,
      why,
      evidence,
    );
  }
  return null;
}

// ── process.no-review ───────────────────────────────────────────────────────

function noReview(input: RuleInput): Flag | null {
  if (input.state !== "completed") return null;
  if (input.tier === "Small") return null;
  const finished = input.reports.filter((report) => report.phase === "finished").at(-1);
  const evidence = finished === undefined ? [] : [reportEvidence(finished, `tier: ${finished.tier ?? "none"}`)];
  const why = "Medium and Large requests are reviewed by a Reviewer before they are finished.";
  if (input.tier === null) {
    if (input.reviewerIds.length > 0) return null;
    return flag(
      "process.no-review",
      "warning",
      "unknown",
      "The request finished without a Reviewer, and no report gave its tier.",
      why,
      evidence,
    );
  }
  if (input.reviewerIds.length === 0) {
    return flag(
      "process.no-review",
      "warning",
      "raised",
      `The ${input.tier} request finished without any Reviewer.`,
      why,
      evidence,
    );
  }
  if (input.reviewCalls === null) {
    return flag(
      "process.no-review",
      "warning",
      "unknown",
      `The ${input.tier} request has a Reviewer, but none of its turns was recorded, so whether it reviewed is not known.`,
      why,
      evidence,
    );
  }
  return null;
}

// ── review.over-budget ──────────────────────────────────────────────────────

/** A message a Reviewer received that is not a review call (`reviewCallsOf` in `server/traces.ts`). */
const REVIEW_BLOCK = /^\s*>?\s*(?:[-*]\s*)?bm-review\b/im;

function overBudget(input: RuleInput, facts: RuleFacts): Flag | null {
  const calls = input.reviewCalls;
  if (calls === null) return null;
  const evidence: FlagEvidence[] = input.inbound
    .filter((message) => message.role === "reviewer" && !isPluginNotice(message.text) && !REVIEW_BLOCK.test(message.text))
    .map((message) => ({ agentId: message.agentId, at: message.at, kind: "sent", excerpt: message.text }));
  const why = "Review calls past the tier's budget cost time and tokens the size of the request does not justify.";
  if (input.tier === null) {
    const smallest = Math.min(...Object.values(facts.reviewBudget));
    if (calls <= smallest) return null;
    return flag(
      "review.over-budget",
      "warning",
      "unknown",
      `The request made ${plural(calls, "review call")}, but no report gave its tier, so its budget is not known.`,
      why,
      evidence,
    );
  }
  const budget = facts.reviewBudget[input.tier];
  if (calls <= budget) return null;
  return flag(
    "review.over-budget",
    "warning",
    "raised",
    `The ${input.tier} request made ${plural(calls, "review call")}, over its budget of ${budget}.`,
    why,
    evidence,
  );
}

// ── agent.failed-first-turn ─────────────────────────────────────────────────

function failedFirstTurn(input: RuleInput): Flag | null {
  const firstTurn = new Map<string, RuleInput["turns"][number]>();
  for (const turn of input.turns) {
    if (turn.role !== "worker" && turn.role !== "reviewer") continue;
    if (!firstTurn.has(turn.agentId)) firstTurn.set(turn.agentId, turn);
  }
  const raised: FlagEvidence[] = [];
  const unknown: FlagEvidence[] = [];
  const roleOf = (agentId: string): string => {
    const role =
      input.agents.find((agent) => agent.agentId === agentId)?.role ??
      input.turns.find((turn) => turn.agentId === agentId)?.role;
    return role === "worker" ? "Worker" : role === "reviewer" ? "Reviewer" : "agent";
  };

  for (const [agentId, turn] of firstTurn) {
    if (turn.outcome !== "failed") continue;
    raised.push({
      agentId,
      at: turn.at,
      kind: "evidence",
      excerpt: `${roleOf(agentId)} turn ${turn.turnId ?? "(no id)"} ended failed; it was its first recorded turn`,
    });
  }
  for (const agent of input.agents) {
    if (firstTurn.has(agent.agentId)) continue;
    if (agent.state === "failed" && agent.lastActivityAt === null) {
      raised.push({
        agentId: agent.agentId,
        at: agent.startedAt,
        kind: "evidence",
        excerpt: `${roleOf(agent.agentId)} is in Paseo status ${agent.status ?? "error"} with no recorded turn`,
      });
    } else if (agent.state !== "running") {
      // Not running, no turn recorded: how its first turn ended was not seen.
      unknown.push({
        agentId: agent.agentId,
        at: agent.startedAt,
        kind: "evidence",
        excerpt: `${roleOf(agent.agentId)} has no recorded turn; Paseo status ${agent.status ?? "not listed"}`,
      });
    }
  }

  const why = "An agent that fails its first turn usually got a wrong model, mode or setting when it was created.";
  if (raised.length > 0) {
    return flag(
      "agent.failed-first-turn",
      "warning",
      "raised",
      raised.length === 1
        ? `A ${roleOf(raised[0]!.agentId)} of this request failed on its first turn.`
        : `${raised.length} Workers or Reviewers of this request failed on their first turn.`,
      why,
      raised,
    );
  }
  if (unknown.length > 0) {
    return flag(
      "agent.failed-first-turn",
      "warning",
      "unknown",
      "A Worker or Reviewer of this request has no recorded turn, so how its first turn ended is not known.",
      why,
      unknown,
    );
  }
  return null;
}

// ── agent.model-corrected ───────────────────────────────────────────────────

/**
 * The role a paseo-bm provider alias runs, when it is a Worker or Reviewer:
 * `bm-worker`, `bm-worker/<model>`, `bm-worker-fallback-<n>[/<model>]`.
 *
 * A pure copy of the part of `roleOfProvider` (`server/agent-role.ts`) the
 * rule needs: shared code must not import server code, and the rule only ever
 * matches Workers and Reviewers.
 */
export function workerOrReviewerOfAlias(alias: string): RuleAgent["role"] | null {
  const slash = alias.indexOf("/");
  const id = slash === -1 ? alias : alias.slice(0, slash);
  if (id === "bm-worker") return "worker";
  if (id === "bm-reviewer") return "reviewer";
  const role = fallbackAliasOf(id)?.role;
  return role === "worker" || role === "reviewer" ? role : null;
}

function sameFolder(left: string, right: string): boolean {
  const trim = (path: string) => (path.length > 1 ? path.replace(/[\\/]+$/, "") : path);
  return trim(left) === trim(right);
}

function msOf(at: string | null): number | null {
  if (at === null) return null;
  const ms = Date.parse(at);
  return Number.isNaN(ms) ? null : ms;
}

function correctionExcerpt(entry: ModelCorrection): string {
  return `inferred: ${entry.alias} asked for model "${entry.requested}", started on the profile's "${entry.profileModel}"`;
}

function modelCorrected(input: RuleInput, facts: RuleFacts): Flag | null {
  const requestedAt = msOf(input.requestedAt);
  const corrections = [...facts.corrections].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  const raised: FlagEvidence[] = [];
  const unknown: FlagEvidence[] = [];

  for (const entry of corrections) {
    const role = workerOrReviewerOfAlias(entry.alias);
    const at = msOf(entry.at);
    if (role === null || at === null) continue;
    const ofRole = input.agents.filter((agent) => agent.role === role);
    const inWindow = ofRole.filter((agent) => {
      const started = msOf(agent.startedAt);
      return started !== null && started >= at && started - at <= CORRECTION_WINDOW_MS;
    });
    if (facts.workspaceDirectory === null) {
      // The folder cannot be compared: a match in time is only a candidate.
      for (const agent of inWindow) unknown.push({ agentId: agent.agentId, at: entry.at, kind: "correction", excerpt: correctionExcerpt(entry) });
      continue;
    }
    if (!sameFolder(entry.cwd, facts.workspaceDirectory)) continue;
    for (const agent of inWindow) raised.push({ agentId: agent.agentId, at: entry.at, kind: "correction", excerpt: correctionExcerpt(entry) });
    // An agent with no start time cannot be placed in the window; a correction
    // of its role in this folder since the request began may have been its own.
    if (inWindow.length === 0 && requestedAt !== null && at >= requestedAt) {
      for (const agent of ofRole.filter((candidate) => msOf(candidate.startedAt) === null)) {
        unknown.push({ agentId: agent.agentId, at: entry.at, kind: "correction", excerpt: correctionExcerpt(entry) });
      }
    }
  }

  const why = "The creator asked for a model the role's profile does not name, so it is working from an outdated setting.";
  if (raised.length > 0) {
    return flag(
      "agent.model-corrected",
      "info",
      "raised",
      raised.length === 1
        ? "The plugin replaced the model asked for one agent of this request with its profile's model (matched by time, inferred)."
        : `The plugin replaced the model asked for ${raised.length} agents of this request with their profile's model (matched by time, inferred).`,
      why,
      raised,
    );
  }
  if (unknown.length > 0) {
    return flag(
      "agent.model-corrected",
      "info",
      "unknown",
      "A model correction may belong to an agent of this request, but its folder or start time is not known.",
      why,
      unknown,
    );
  }
  return null;
}

// ── report.malformed ────────────────────────────────────────────────────────

function malformed(input: RuleInput): Flag | null {
  const evidence: FlagEvidence[] = [];
  for (const report of input.reports) {
    const parts = [
      report.unparsedFields.length > 0 ? `unreadable: ${report.unparsedFields.join(", ")}` : null,
      report.incompleteFields.length > 0 ? `incomplete: ${report.incompleteFields.join(", ")}` : null,
    ].filter((part) => part !== null);
    if (parts.length > 0) evidence.push(reportEvidence(report, parts.join("; ")));
  }
  const badFields = evidence.length > 0;
  const finished = input.reports.filter((report) => report.phase === "finished").at(-1);
  const noReceived = input.state === "completed" && !input.reports.some((report) => report.phase === "received");
  // Reports reach the store through the Manager's turns: with none recorded, a
  // received report may have been sent and never seen.
  const managerSeen = input.managerAgentId !== null;
  const why = "The Manager and the Dashboard read the Worker's reports; a report they cannot read hides where the work stands.";

  if (noReceived && managerSeen && finished !== undefined) {
    evidence.push(reportEvidence(finished, "no received report before it"));
  }
  if (badFields || (noReceived && managerSeen)) {
    const observed = !badFields
      ? "The request finished without the Worker ever sending a received report."
      : noReceived && managerSeen
        ? "A report of this request has unreadable or incomplete fields, and the Worker never sent a received report."
        : "A report of this request has unreadable or incomplete fields.";
    return flag("report.malformed", "warning", "raised", observed, why, evidence);
  }
  if (noReceived) {
    return flag(
      "report.malformed",
      "warning",
      "unknown",
      "No received report was seen, but no Manager turn of this request was recorded to carry one.",
      why,
      finished === undefined ? [] : [reportEvidence(finished, "no Manager turn recorded")],
    );
  }
  return null;
}

// ── manager.language-mismatch ───────────────────────────────────────────────

function other(language: GuessedLanguage): GuessedLanguage | null {
  return language === "vi" ? "en" : language === "en" ? "vi" : null;
}

const LANGUAGE_NAME: Readonly<Record<"vi" | "en", string>> = { vi: "Vietnamese", en: "English" };

function languageMismatch(input: RuleInput): Flag | null {
  // Typed by the user to the Manager: messages typed to the Worker do not count.
  const typed = input.inbound.filter((message) => message.role === "manager" && message.origin === "user");
  const last = typed.at(-1);
  if (last === undefined) return null;
  const language = guessLanguage(last.text);
  const wrong = other(language);
  if (wrong === null) return null;

  const replies = input.managerReplies.filter((reply) => reply.agentId === last.agentId);
  const userEvidence: FlagEvidence = { agentId: last.agentId, at: last.at, kind: "sent", excerpt: last.text };
  const replyEvidence = (reply: RuleMessage): FlagEvidence => ({
    agentId: reply.agentId,
    at: reply.at,
    kind: "received",
    excerpt: reply.text,
  });
  const why = "The user's language is the one they type in; a report or notice in another language does not change it.";
  const names = { user: LANGUAGE_NAME[language as "vi" | "en"], reply: LANGUAGE_NAME[wrong as "vi" | "en"] };
  const mismatches = (reply: RuleMessage) => guessLanguage(reply.text) === wrong;

  // Every reply after the message counts, not only the first: the 2026-09-26
  // slip was a Manager that answered in the user's language, then switched
  // once an English BM-REPORT arrived.
  const after = replies.find((reply) => reply.at > last.at && mismatches(reply));
  if (after !== undefined) {
    return flag(
      "manager.language-mismatch",
      "warning",
      "raised",
      `The user wrote to the Manager in ${names.user}, but the Manager replied in ${names.reply}.`,
      why,
      [userEvidence, replyEvidence(after)],
    );
  }
  // A recorded time can be the write time: a reply with the message's own time
  // may be before or after it, so it proves nothing either way.
  const tied = replies.find((reply) => reply.at === last.at && mismatches(reply));
  if (tied === undefined) return null;
  return flag(
    "manager.language-mismatch",
    "warning",
    "unknown",
    `The user wrote in ${names.user} and the Manager replied in ${names.reply}, but their recorded times are equal, so the order is not known.`,
    why,
    [userEvidence, replyEvidence(tied)],
  );
}

// ── The catalogue ───────────────────────────────────────────────────────────

/**
 * Every flag of one request, in the order of `RULE_IDS`. Pure: reads only its
 * two arguments and changes neither.
 */
export function flagsOf(input: RuleInput, facts: RuleFacts): Flag[] {
  return [
    smallHeavy(input),
    noReview(input),
    overBudget(input, facts),
    failedFirstTurn(input),
    modelCorrected(input, facts),
    malformed(input),
    languageMismatch(input),
  ].filter((entry): entry is Flag => entry !== null);
}
