/**
 * Save as precedent (autonomy design §B.6, §B.9; PRD REQ-124 a): the owner's
 * answer to a decision with a subject becomes a standing answer, from its
 * card; and the precedent an open decision's card suggests. Split from
 * `chat-cards.ts` (code review 2026-09-30 §4).
 *
 * Pure: no React, no React Native, no `server/` import.
 */
import { decisionKindOf, type Decision } from "../shared/decisions";
import {
  DEFAULT_PRECEDENT_DAYS,
  MAX_PRECEDENT_TEXT_CHARS,
  PRECEDENT_SCOPE_ALL,
  precedentAnswerOf,
  precedentFor,
  precedentTextOf,
  whyNotPrecedent,
  type Precedent,
} from "../shared/precedents";
import { shorten } from "../shared/text";
import type { DecisionChoice, DecisionUi } from "./chat-card-decision";
import { codedReason } from "./errors";
import type { Tone } from "./tone";

/** Where a precedent saved from a card holds: the decision's own project, or every project. */
export type PrecedentScopeChoice = "project" | "all";

/** The card's own state for saving its answer as a precedent. */
export interface PrecedentUi {
  /** The form, open when not null: the text (prefilled from the answer, editable) and the scope. */
  form: { text: string; scope: PrecedentScopeChoice } | null;
  busy: boolean;
  /** What the last save could not do. */
  error: string | null;
  /** The precedent this card saved, once saved. */
  saved: { scope: PrecedentScopeChoice; expiresAt: string } | null;
}

export const PRECEDENT_UI_IDLE: PrecedentUi = { form: null, busy: false, error: null, saved: null };

export const SAVE_AS_PRECEDENT_LABEL = "Save as precedent…";

export interface PrecedentScopeButton {
  scope: PrecedentScopeChoice;
  label: string;
  selected: boolean;
  accessibilityLabel: string;
}

export interface PrecedentOfferView {
  /** "Save as precedent…", while the form is closed and nothing was saved here. */
  offer: { label: string; accessibilityLabel: string } | null;
  /** The form: what saving does, the text, the scope, then Cancel first and Save. */
  form: {
    title: string;
    body: string;
    text: string;
    textLabel: string;
    /** Why the text cannot be saved as it is; null when it can. */
    textHint: string | null;
    scopes: PrecedentScopeButton[];
    cancelLabel: string;
    saveLabel: string;
    saveAccessibilityLabel: string;
    saveEnabled: boolean;
    busy: boolean;
  } | null;
  /** The saved line, or why the save failed. */
  status: { text: string; tone: Tone } | null;
}

const SCOPE_WORDS: Readonly<Record<PrecedentScopeChoice, string>> = { project: "this project", all: "all projects" };

/** The form a press on "Save as precedent…" opens: the answer's text, this project. */
export function precedentFormOf(decision: Decision): NonNullable<PrecedentUi["form"]> {
  return { text: precedentTextOf(decision) ?? "", scope: "project" };
}

/**
 * What the card offers for saving its answer as a precedent: nothing unless
 * the decision is answered by the owner and carries a subject (a precedent
 * without one could match nothing, §B.9).
 */
export function precedentOfferView(decision: Decision | null, ui: PrecedentUi): PrecedentOfferView | null {
  if (decision === null || whyNotPrecedent(decision) !== null) return null;
  const subject = decision.subject!;
  const status =
    ui.error !== null
      ? { text: ui.error, tone: "danger" as const }
      : ui.saved === null
        ? null
        : { text: `Saved as a precedent for ${SCOPE_WORDS[ui.saved.scope]} until ${ui.saved.expiresAt.slice(0, 10)}.`, tone: "success" as const };
  if (ui.form === null) {
    return {
      offer: ui.saved === null ? { label: SAVE_AS_PRECEDENT_LABEL, accessibilityLabel: `Save this answer as a precedent for "${subject}"` } : null,
      form: null,
      status,
    };
  }
  const length = [...ui.form.text.trim()].length;
  const textHint =
    length === 0 ? "Write the answer to keep." : length > MAX_PRECEDENT_TEXT_CHARS ? `At most ${MAX_PRECEDENT_TEXT_CHARS} characters (now ${length}).` : null;
  const scopes = (["project", "all"] as const).map(
    (scope): PrecedentScopeButton => ({
      scope,
      label: scope === "project" ? "This project" : "All projects",
      selected: ui.form!.scope === scope,
      accessibilityLabel: scope === "project" ? "Keep it for this project only" : "Keep it for every project",
    }),
  );
  return {
    offer: null,
    form: {
      title: `Save as precedent for "${subject}"?`,
      body: `Later questions on "${subject}" get this answer without asking you, for ${DEFAULT_PRECEDENT_DAYS} days. End it any time in Settings → More → Precedents.`,
      text: ui.form.text,
      textLabel: "The precedent's answer",
      textHint,
      scopes,
      cancelLabel: "Cancel",
      saveLabel: ui.busy ? "Saving…" : "Save precedent",
      saveAccessibilityLabel: `Save the precedent for ${SCOPE_WORDS[ui.form.scope]}`,
      saveEnabled: !ui.busy && textHint === null,
      busy: ui.busy,
    },
    status,
  };
}

export type PrecedentSaveResult = { ok: true; precedent: Precedent } | { ok: false; reason: string };

/**
 * One save: ONE `precedents.save` call with the decision's id, the text as
 * the owner left it, and the scope as `all` or the decision's workspace.
 */
export async function runPrecedentSave(input: {
  decision: Pick<Decision, "id" | "workspaceId">;
  form: NonNullable<PrecedentUi["form"]>;
  save: (input: { decisionId: string; scope: string; text: string }) => Promise<{ precedent: Precedent }>;
}): Promise<PrecedentSaveResult> {
  const text = input.form.text.trim();
  if (text === "") return { ok: false, reason: "Write the answer to keep first." };
  try {
    const { precedent } = await input.save({
      decisionId: input.decision.id,
      scope: input.form.scope === "all" ? PRECEDENT_SCOPE_ALL : input.decision.workspaceId,
      text,
    });
    return { ok: true, precedent };
  } catch (failure) {
    return { ok: false, reason: `Could not save the precedent${codedReason(failure)}` };
  }
}

/**
 * The precedent an open decision's card suggests (autonomy design §B.6): the
 * owner's active precedent on its subject that did not answer it — one asked
 * again — or one saved after it opened.
 */
export interface PrecedentSuggestionView {
  /** "Precedent: <text> (saved <date>)". */
  line: string;
  /**
   * Picks it: the option it names, or the own-words box with its text; null
   * while a confirmation or the own-words box is open, and for a fallback
   * incident when it names none of the options (only an option runs an action).
   */
  use: { label: string; accessibilityLabel: string; choice: DecisionChoice } | null;
}

export const USE_PRECEDENT_LABEL = "Use this answer";

/** What an open decision's card suggests from the precedents of its project (`precedents.list`); null when none bears on it. */
export function precedentSuggestionView(
  decision: Decision | null,
  precedents: readonly Precedent[] | undefined,
  ui: DecisionUi,
  now: Date,
): PrecedentSuggestionView | null {
  // Autonomy design §B.7: an override corrects what a precedent answered; it never suggests one back.
  if (decision === null || decision.status !== "open" || precedents === undefined || decisionKindOf(decision.id) === "override") return null;
  const precedent = precedentFor(decision, precedents, now);
  if (precedent === null) return null;
  const choice = precedentAnswerOf(decision, precedent);
  const canPick = ui.confirming === null && ui.words === null && !("words" in choice && decisionKindOf(decision.id) === "fallback");
  return {
    line: `Precedent: ${shorten(precedent.text, 160)} (saved ${precedent.createdAt.slice(0, 10)})`,
    use: canPick ? { label: USE_PRECEDENT_LABEL, accessibilityLabel: `Use your precedent's answer: ${shorten(precedent.text, 160)}`, choice } : null,
  };
}
