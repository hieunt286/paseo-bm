import { z } from "zod";
import { DECISION_ID_PATTERN, SUBJECT_PATTERN, carriesPreparedChange, decisionKindOf, type Decision } from "./decisions";
import { timeOrZero } from "./time";

/**
 * The owner's precedents (autonomy design §B.6, §B.9; PRD REQ-124): a
 * standing answer for a subject, in one project or in all of them, for a
 * limited time. Experience concept X-2: precedents per project replace the
 * per-role additional instructions.
 *
 * Kept in `<data folder>/autonomy/precedents.json`
 * (`server/precedent-store.ts`) = `{ version: 1, entries: Precedent[] }`, and
 * served by `precedents.list`, `precedents.save` and `precedents.end`
 * (`server/autonomy-rpc.ts`). A precedent is made from an answered decision
 * (**Save as precedent** on its card) or by the owner in Settings → Autonomy.
 * Saving one with the scope and subject of an active one supersedes that one
 * (REQ-124 c). A decision that opens on the subject of an active one is
 * resolved by it, whatever its class (`precedentResolutionOf`,
 * applied by `server/precedent-resolve.ts`); the owner's own answer that
 * differs from it supersedes it (`precedentsContradictedBy`). Injecting
 * precedents into agents is `t9lm.13`'s.
 *
 * This module is `shared/`, so it stays free of Node and React Native imports;
 * every time comes in as an argument.
 */

/** The file format this build reads and writes. */
export const PRECEDENTS_FILE_VERSION = 1;

/** The scope of a precedent that holds in every project; any other scope is one workspace id. */
export const PRECEDENT_SCOPE_ALL = "all";

/** How long a precedent lasts when its saver names no expiry (§B.6). */
export const DEFAULT_PRECEDENT_DAYS = 30;
/** The longest expiry a save may ask for. */
export const MAX_PRECEDENT_DAYS = 365;
/**
 * Longest precedent text. The text goes into agents' runtime facts
 * (`## Owner precedents`, newest 20), so it is kept to an option label's
 * length rather than the 4,000 characters of an answer in own words.
 */
export const MAX_PRECEDENT_TEXT_CHARS = 1000;
/** Longest workspace id a scope names; the same cap as the trace store's workspace ids. */
export const MAX_PRECEDENT_SCOPE_CHARS = 128;
/** Longest source decision id kept. */
export const MAX_PRECEDENT_SOURCE_CHARS = 200;

/** `p:<uuid>`: a precedent id, which an answer `by: precedent` names as its `precedentId`. */
export const PRECEDENT_ID_PATTERN = /^p:[A-Za-z0-9-]{1,64}$/;

const DAY_MS = 24 * 60 * 60 * 1000;

/** An ISO time that parses: a precedent's times are compared, so an unreadable one makes the entry unusable. */
const readableTimeSchema = z
  .string()
  .min(1)
  .refine((value) => !Number.isNaN(Date.parse(value)), { message: "not a readable time" });

/** `all`, or the one workspace id a precedent holds in. */
export const precedentScopeSchema = z.string().min(1).max(MAX_PRECEDENT_SCOPE_CHARS);

export const precedentSchema = z.object({
  id: z.string().regex(PRECEDENT_ID_PATTERN),
  scope: precedentScopeSchema,
  /** The decision slug it answers (`SUBJECT_PATTERN`): a decision opening with it is the one it bears on. */
  subject: z.string().regex(SUBJECT_PATTERN),
  /** The standing answer: an option's label or the owner's words. */
  text: z.string().min(1).max(MAX_PRECEDENT_TEXT_CHARS),
  /** The answered decision it was saved from; null when the owner wrote it in Settings. */
  sourceDecisionId: z.string().min(1).max(MAX_PRECEDENT_SOURCE_CHARS).nullable(),
  createdAt: readableTimeSchema,
  /** When it stops holding; ending it sets this to the moment it was ended. */
  expiresAt: readableTimeSchema,
  /**
   * What replaced it; null while it stands: the newer precedent of the same
   * scope and subject, or the owner's decision on its subject answered
   * differently (REQ-124 c, `precedentsContradictedBy`).
   */
  supersededBy: z.union([z.string().regex(PRECEDENT_ID_PATTERN), z.string().regex(DECISION_ID_PATTERN)]).nullable(),
});
export type Precedent = z.infer<typeof precedentSchema>;

/**
 * `precedents.save`'s input (§B.9). With `decisionId`, the subject and the
 * text come from that answered decision (a given `text` replaces the answer:
 * it is editable before saving) and `scope` is `all` or the decision's own
 * workspace. Without it, `scope`, `subject` and `text` are all the owner's.
 */
export const precedentSaveInputSchema = z.object({
  decisionId: z.string().min(1).optional(),
  scope: precedentScopeSchema,
  subject: z.string().regex(SUBJECT_PATTERN).optional(),
  text: z.string().optional(),
  expiresInDays: z.number().int().min(1).max(MAX_PRECEDENT_DAYS).optional(),
});
export type PrecedentSaveInput = z.infer<typeof precedentSaveInputSchema>;

/** What a save stores, checked: everything but the id and the times. */
export interface PrecedentDraft {
  scope: string;
  subject: string;
  text: string;
  sourceDecisionId: string | null;
  expiresInDays: number;
}

/** Why `precedents.save` refuses; each refusal writes nothing. */
export interface PrecedentRefusal {
  code: "E_PRECEDENT_INVALID";
  detail: string;
}

/** True while a precedent holds: not superseded and not yet expired (or ended). */
export function isActive(precedent: Pick<Precedent, "expiresAt" | "supersededBy">, now: Date): boolean {
  return precedent.supersededBy === null && Date.parse(precedent.expiresAt) > now.getTime();
}

/** The precedents newest first (by `createdAt`, later in the file first on a tie). */
export function newestFirst(precedents: readonly Precedent[]): Precedent[] {
  return precedents
    .map((precedent, index) => ({ precedent, index }))
    .sort((a, b) => timeOrZero(b.precedent.createdAt) - timeOrZero(a.precedent.createdAt) || b.index - a.index)
    .map(({ precedent }) => precedent);
}

/** Every active precedent, newest first. */
export function activePrecedents(precedents: readonly Precedent[], now: Date): Precedent[] {
  return newestFirst(precedents.filter((precedent) => isActive(precedent, now)));
}

/** The active precedents that hold in one workspace: its own and the global ones, newest first. */
export function activeFor(precedents: readonly Precedent[], workspaceId: string, now: Date): Precedent[] {
  return activePrecedents(precedents, now).filter((precedent) => precedent.scope === workspaceId || precedent.scope === PRECEDENT_SCOPE_ALL);
}

/** When a precedent saved at `at` expires. */
export function expiresAtOf(at: Date, days: number): string {
  return new Date(at.getTime() + days * DAY_MS).toISOString();
}

/**
 * The text an answered decision gives a precedent (§B.9): the chosen option's
 * label, else the owner's words; null for an answer confirmed in a chat, whose
 * text the plugin never read.
 */
export function precedentTextOf(decision: Pick<Decision, "answer" | "options">): string | null {
  const answer = decision.answer;
  if (answer === null) return null;
  const option = answer.optionKey === null ? undefined : decision.options.find((entry) => entry.key === answer.optionKey);
  if (option !== undefined) return option.label;
  return answer.words;
}

/**
 * Why an answered decision cannot become a precedent, or null when it can:
 * it must be answered by the owner (not by the Orchestrator, the policy or a
 * precedent) and carry a subject, without which nothing could match it (§B.9).
 */
export function whyNotPrecedent(decision: Pick<Decision, "id" | "status" | "answer" | "subject" | "options">): string | null {
  if (decision.status !== "answered" || decision.answer === null) {
    return `decision ${decision.id} is ${decision.status}; only an answered decision becomes a precedent`;
  }
  if (decision.answer.by !== "owner") return `decision ${decision.id} was not answered by you; only your own answer becomes a precedent`;
  if (decision.subject === null) return `decision ${decision.id} has no subject, so no later question could match it`;
  // Autonomy design §G.4: a change of your settings, not an answer to stand for a subject.
  if (carriesPreparedChange(decision)) return `decision ${decision.id} is about your settings; it is not an answer that stands for later questions`;
  return null;
}

function refusal(detail: string): { refusal: PrecedentRefusal } {
  return { refusal: { code: "E_PRECEDENT_INVALID", detail: `${detail}; nothing was saved` } };
}

/** The text as stored: trimmed, 1–`MAX_PRECEDENT_TEXT_CHARS` characters; a refusal's reason otherwise. */
function checkedText(text: string): { text: string } | { refusal: PrecedentRefusal } {
  const trimmed = text.trim();
  if (trimmed === "") return refusal("the precedent's text is empty");
  if ([...trimmed].length > MAX_PRECEDENT_TEXT_CHARS) {
    return refusal(`the precedent's text is longer than ${MAX_PRECEDENT_TEXT_CHARS} characters; shorten it`);
  }
  return { text: trimmed };
}

/**
 * `precedents.save`'s checks of the input alone, before the data folder is
 * looked at: its shape, a blank or too long text, and — without a decision —
 * the scope, subject and text the owner must give.
 */
export function checkPrecedentSaveInput(input: unknown): { input: PrecedentSaveInput } | { refusal: PrecedentRefusal } {
  const parsed = precedentSaveInputSchema.safeParse(input);
  if (!parsed.success) {
    const field = String(parsed.error.issues[0]?.path[0] ?? "");
    const expected: Readonly<Record<string, string>> = {
      decisionId: "a decision id",
      scope: `"${PRECEDENT_SCOPE_ALL}" or a project`,
      subject: "a subject of lowercase letters, digits and dashes (at most 60)",
      text: "text",
      expiresInDays: `a whole number of days from 1 to ${MAX_PRECEDENT_DAYS}`,
    };
    const what = expected[field];
    if (what === undefined) return refusal("expected { scope, subject, text } or { decisionId, scope }");
    const got = JSON.stringify(((input ?? {}) as Record<string, unknown>)[field] ?? null);
    return refusal(`${field} ${got} is not ${what}`);
  }
  const checked = parsed.data;
  if (checked.text !== undefined) {
    const text = checkedText(checked.text);
    if ("refusal" in text) return text;
  }
  if (checked.decisionId === undefined) {
    if (checked.subject === undefined) return refusal("a precedent written in Settings needs a subject");
    if (checked.text === undefined) return refusal("a precedent written in Settings needs its text");
  }
  return { input: checked };
}

/**
 * The precedent a checked input saves. With `decisionId`, `decision` is that
 * decision (the caller has looked it up): it must be the owner's answered
 * decision with a subject, the scope `all` or its own workspace, a given
 * subject its own, and a text given or read from its answer.
 */
export function precedentDraftOf(input: PrecedentSaveInput, decision: Decision | null): { draft: PrecedentDraft } | { refusal: PrecedentRefusal } {
  const expiresInDays = input.expiresInDays ?? DEFAULT_PRECEDENT_DAYS;
  if (input.decisionId === undefined) {
    const text = checkedText(input.text ?? "");
    if ("refusal" in text) return text;
    if (input.subject === undefined) return refusal("a precedent written in Settings needs a subject");
    return { draft: { scope: input.scope, subject: input.subject, text: text.text, sourceDecisionId: null, expiresInDays } };
  }
  if (decision === null || decision.id !== input.decisionId) return refusal(`decision ${input.decisionId} was not found`);
  const why = whyNotPrecedent(decision);
  if (why !== null) return refusal(why);
  if (input.scope !== PRECEDENT_SCOPE_ALL && input.scope !== decision.workspaceId) {
    return refusal(`a precedent saved from a decision holds in its own project or in all projects, not in ${JSON.stringify(input.scope)}`);
  }
  const subject = decision.subject!;
  if (input.subject !== undefined && input.subject !== subject) {
    return refusal(`decision ${decision.id} is about "${subject}", not "${input.subject}"`);
  }
  const answerText = precedentTextOf(decision);
  if (input.text === undefined && answerText === null) {
    return refusal(`the answer to decision ${decision.id} was confirmed in a chat and has no text; write the precedent's text`);
  }
  const text = checkedText(input.text ?? answerText ?? "");
  if ("refusal" in text) return text;
  return { draft: { scope: input.scope, subject, text: text.text, sourceDecisionId: decision.id, expiresInDays } };
}

// ---------------------------------------------------------------------------
// Precedents at work on decisions (§B.6, §B.9; REQ-124 b, c).
// ---------------------------------------------------------------------------

/** Two texts as a precedent compares them: surrounding and repeated whitespace aside, character for character. */
export function sameAnswerText(a: string, b: string): boolean {
  return a.replace(/\s+/g, " ").trim() === b.replace(/\s+/g, " ").trim();
}

/** The active precedents of `subject` that hold in `workspaceId`, in the order they apply: the workspace's own, then the global ones, newest first in each. */
function bearingOn(precedents: readonly Precedent[], workspaceId: string, subject: string, now: Date): Precedent[] {
  const matching = activeFor(precedents, workspaceId, now).filter((precedent) => precedent.subject === subject);
  return [...matching.filter((precedent) => precedent.scope === workspaceId), ...matching.filter((precedent) => precedent.scope !== workspaceId)];
}

/**
 * The active precedent a decision bears on (§B.6): one with the decision's
 * subject that holds in its workspace — the workspace's own before a global
 * one, the newest of each. Null for a decision without a subject.
 */
export function precedentFor(decision: Pick<Decision, "workspaceId" | "subject">, precedents: readonly Precedent[], now: Date): Precedent | null {
  if (decision.subject === null) return null;
  return bearingOn(precedents, decision.workspaceId, decision.subject, now)[0] ?? null;
}

/** What a precedent answers (§B.9): the option whose label is its text, else its text as the owner's own words. */
export function precedentAnswerOf(decision: Pick<Decision, "options">, precedent: Pick<Precedent, "text">): { optionKey: string } | { words: string } {
  const option = decision.options.find((entry) => sameAnswerText(entry.label, precedent.text));
  return option === undefined ? { words: precedent.text } : { optionKey: option.key };
}

/** The one-line reason a precedent's answer carries (`answer.reason`, at most 300 characters): its subject, scope and day. */
export function precedentReasonOf(precedent: Pick<Precedent, "subject" | "scope" | "createdAt">): string {
  return `The owner's precedent on "${precedent.subject}"${precedent.scope === PRECEDENT_SCOPE_ALL ? " for all projects" : ""}, saved ${precedent.createdAt.slice(0, 10)}`;
}

/** What a precedent does to a decision that opens: answers it, or is shown on its card as a suggestion only. */
export type PrecedentResolution =
  | { kind: "resolve"; precedent: Precedent; answer: { optionKey: string } | { words: string } }
  | { kind: "suggest"; precedent: Precedent; why: "no-option" };

/**
 * What an active precedent does to an `open` decision (§B.6, §B.9):
 * - `resolve`: it answers it — `answer` —, whatever its class (ADR-025: no
 *   class is the owner's by rule). An `owner` or `shadow` cell does not stop
 *   it: a precedent is the owner's own standing answer.
 * - `suggest`: it is only shown on the card — for a fallback incident's
 *   decision when the precedent names none of its options (`no-option`):
 *   only an option there runs an action.
 *
 * Null when no active precedent bears on it, or it is not `open`. Pure.
 */
export function precedentResolutionOf(decision: Decision, precedents: readonly Precedent[], now: Date): PrecedentResolution | null {
  // Autonomy design §B.7: the owner's override corrects what a precedent or the policy answered; none answers it.
  // §D.2: nor a held request, which only the owner allows (change-009 C6).
  if (decisionKindOf(decision.id) === "override" || decisionKindOf(decision.id) === "held") return null;
  // Autonomy design §G.4: a prepared change of the owner's settings is theirs alone; no precedent answers or suggests it.
  if (decision.status !== "open" || carriesPreparedChange(decision)) return null;
  const precedent = precedentFor(decision, precedents, now);
  if (precedent === null) return null;
  const answer = precedentAnswerOf(decision, precedent);
  if ("words" in answer && decisionKindOf(decision.id) === "fallback") return { kind: "suggest", precedent, why: "no-option" };
  return { kind: "resolve", precedent, answer };
}

/**
 * The active precedents an owner's answer supersedes (REQ-124 c, §B.9): those
 * of the decision's subject that hold in its workspace, in the order they
 * apply (the workspace's, then the global ones), up to the first whose text
 * the answer repeats — so the next decision on the subject meets the owner's
 * latest word, never an older one it contradicts. Empty unless the owner
 * answered, with an option or own words, a decision with a subject. Pure.
 */
export function precedentsContradictedBy(decision: Decision, precedents: readonly Precedent[], now: Date): Precedent[] {
  // A decision about the owner's settings (§G.4) answers no subject: its prepared change saves its own precedent.
  if (decision.status !== "answered" || decision.answer?.by !== "owner" || decision.subject === null || carriesPreparedChange(decision)) return [];
  const text = precedentTextOf(decision);
  if (text === null) return [];
  const out: Precedent[] = [];
  for (const precedent of bearingOn(precedents, decision.workspaceId, decision.subject, now)) {
    if (sameAnswerText(precedent.text, text)) break;
    out.push(precedent);
  }
  return out;
}

/** The precedents a parsed file body holds: each entry read on its own, a malformed one skipped alone. */
export function precedentsOf(entries: readonly unknown[]): Precedent[] {
  const out: Precedent[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    const parsed = precedentSchema.safeParse(entry);
    // A second entry under an id already read is as unusable as a broken one.
    if (!parsed.success || seen.has(parsed.data.id)) continue;
    seen.add(parsed.data.id);
    out.push(parsed.data);
  }
  return out;
}
