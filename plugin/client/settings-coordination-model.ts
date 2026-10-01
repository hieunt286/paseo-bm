/**
 * Settings → Coordination's compaction and handoff cards (autonomy design
 * §G.5–§G.7; bead `7gxw.9`): each mechanism its own card, with its switch,
 * its thresholds with − and + inside their bounds, Save and the defaults;
 * and below them the review budget card (§C.4, §G.7; bead `7gxw.12`): each
 * tier's review calls with − and + inside 2–8, Save and the defaults.
 *
 * - **The switch** saves at once. Turning off needs nothing more (§G.8: off
 *   at once); turning on asks first, Cancel being the default, because it
 *   lets the Orchestrator act without asking the owner (ADR-021).
 * - **The status** says On, Off, or that paseo-bm switched it off below
 *   A-12's target, with the figures (§G.3); the owner's turning it on counts
 *   A-12 afresh.
 * - **The thresholds** stay a local draft until Save, which sends one
 *   `coordination.set` per changed setting.
 *
 * Pure: no React, no React Native, no `server/` import.
 */
import { A12_TARGET } from "../shared/interventions";
import {
  COORDINATION_BOUNDS,
  COORDINATION_MECHANISMS,
  REVIEW_BUDGET_KEYS,
  type CoordinationChange,
  type CoordinationMechanism,
  type CoordinationSettings,
} from "../shared/coordination";
import type { Tier } from "../shared/contracts";
import { ago } from "./format";
import type { Tone } from "./tone";
import type { ConfirmDialog } from "./ui-types";

/** The settings a card edits with − and +. */
export type ThresholdKey =
  | "compact.managerTokensPerTurn"
  | "compact.workerTokensPerTurn"
  | "compact.contextShare"
  | "compact.maxPerAgent"
  | "handoff.requestTokens"
  | "handoff.maxPerRequest";

/** Each card's thresholds, in the order it shows them. */
export const MECHANISM_THRESHOLDS: Readonly<Record<CoordinationMechanism, readonly ThresholdKey[]>> = {
  compact: ["compact.managerTokensPerTurn", "compact.workerTokensPerTurn", "compact.contextShare", "compact.maxPerAgent"],
  handoff: ["handoff.requestTokens", "handoff.maxPerRequest"],
};

/** The edited values not saved yet. */
export type ThresholdDraft = Partial<Record<ThresholdKey, number>>;

const MECHANISM_WORDS: Readonly<Record<CoordinationMechanism, { title: string; word: string; meaning: string; note: string | null; onBody: string }>> = {
  compact: {
    title: "Compaction",
    word: "compaction",
    meaning: "When an agent's turns grow heavy, the Orchestrator may have it compact its conversation, without asking you.",
    note: "A Claude turn is judged by its tokens read, a Codex or OpenCode turn by how full its context is.",
    onBody: "The Orchestrator may then have a Manager or a Worker compact its conversation without asking you.",
  },
  handoff: {
    title: "Handoff",
    word: "handoff",
    meaning: "When a request grows very heavy, the Orchestrator may have the Manager hand it to a fresh Worker with a brief, without asking you.",
    note: null,
    onBody: "The Orchestrator may then have the Manager hand a heavy request to a fresh Worker without asking you.",
  },
};

const THRESHOLD_WORDS: Readonly<Record<ThresholdKey, { label: string; spoken: string }>> = {
  "compact.managerTokensPerTurn": { label: "Manager turn", spoken: "Manager turn threshold" },
  "compact.workerTokensPerTurn": { label: "Worker turn", spoken: "Worker turn threshold" },
  "compact.contextShare": { label: "Context", spoken: "Context threshold" },
  "compact.maxPerAgent": { label: "Per agent", spoken: "Compactions per agent" },
  "handoff.requestTokens": { label: "Request", spoken: "Request threshold" },
  "handoff.maxPerRequest": { label: "Per request", spoken: "Handoffs per request" },
};

const TOKEN_KEYS: ReadonlySet<ThresholdKey> = new Set(["compact.managerTokensPerTurn", "compact.workerTokensPerTurn", "handoff.requestTokens"]);

/** Up to two decimals, without trailing zeros. */
function trimmed(value: number): string {
  return String(Math.round(value * 100) / 100);
}

/** A token count in a few characters: 390k, 5.7M, 150M. */
export function tokenCountText(tokens: number): string {
  if (tokens >= 1_000_000) return `${trimmed(tokens / 1_000_000)}M`;
  if (tokens >= 1_000) return `${trimmed(tokens / 1_000)}k`;
  return String(tokens);
}

/** A threshold's value in words: "5.7M tokens read", "50% of the window", "at most 2". */
export function thresholdValueText(key: ThresholdKey, value: number): string {
  if (TOKEN_KEYS.has(key)) return `${tokenCountText(value)} tokens read`;
  if (key === "compact.contextShare") return `${Math.round(value * 100)}% of the window`;
  return `at most ${value}`;
}

/** 1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8 per power of ten: a token threshold's steps, about ten per decade. */
const TOKEN_LADDER = [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8] as const;

function tokenStep(value: number, step: -1 | 1): number {
  const exponent = Math.floor(Math.log10(Math.max(value, 1)));
  const rungs = [exponent - 1, exponent, exponent + 1].flatMap((power) => TOKEN_LADDER.map((mantissa) => Math.round(mantissa * 10 ** power)));
  const next = step === 1 ? rungs.filter((rung) => rung > value).sort((a, b) => a - b)[0] : rungs.filter((rung) => rung < value).sort((a, b) => b - a)[0];
  return next ?? value;
}

/**
 * A threshold one step down or up, kept within its bounds: a token threshold
 * to the next rung of `TOKEN_LADDER` (390k → 400k or 300k), the context share
 * by 5 points, a count by one.
 */
export function stepThreshold(key: ThresholdKey, value: number, step: -1 | 1): number {
  const bounds = COORDINATION_BOUNDS[key];
  const next = TOKEN_KEYS.has(key) ? tokenStep(value, step) : key === "compact.contextShare" ? Math.round((value + step * 0.05) * 100) / 100 : value + step;
  return Math.min(bounds.max, Math.max(bounds.min, next));
}

/** The stored value of a threshold. */
function storedValue(settings: CoordinationSettings, key: ThresholdKey): number {
  const [group, field] = key.split(".") as ["compact" | "handoff", string];
  return (settings[group] as unknown as Record<string, number>)[field]!;
}

/** The value a card shows: the draft's, else the stored one. */
export function thresholdValueOf(settings: CoordinationSettings, draft: ThresholdDraft, key: ThresholdKey): number {
  return draft[key] ?? storedValue(settings, key);
}

/** The draft's changes of `mechanism`'s thresholds, in the card's order: what Save sends, one `coordination.set` each. */
export function changedThresholds(mechanism: CoordinationMechanism, settings: CoordinationSettings, draft: ThresholdDraft): CoordinationChange[] {
  return MECHANISM_THRESHOLDS[mechanism].flatMap((key) => {
    const value = draft[key];
    return value === undefined || value === storedValue(settings, key) ? [] : [{ key, value } as CoordinationChange];
  });
}

/** The draft that shows `mechanism`'s defaults (saved only by Save). */
export function defaultsDraft(mechanism: CoordinationMechanism, defaults: CoordinationSettings): ThresholdDraft {
  return Object.fromEntries(MECHANISM_THRESHOLDS[mechanism].map((key) => [key, storedValue(defaults, key)]));
}

/** The mechanisms paseo-bm switched off below A-12's target, and still off (§G.3). */
export function switchedOffMechanisms(settings: CoordinationSettings): CoordinationMechanism[] {
  return COORDINATION_MECHANISMS.filter((mechanism) => !settings[mechanism].enabled && settings.guard[mechanism].switchedOff !== null);
}

/** Both switches in a few words: "compaction and handoff on", "compaction on, handoff off". */
export function mechanismsText(settings: CoordinationSettings): string {
  const { compact, handoff } = settings;
  if (compact.enabled === handoff.enabled) return `compaction and handoff ${compact.enabled ? "on" : "off"}`;
  return `compaction ${compact.enabled ? "on" : "off"}, handoff ${handoff.enabled ? "on" : "off"}`;
}

/** The switched-off mechanisms as the group's warning: "Compaction switched off below its target". */
export function switchedOffText(mechanisms: readonly CoordinationMechanism[]): string {
  if (mechanisms.length > 1) return "Compaction and handoff switched off below their target";
  return `${MECHANISM_WORDS[mechanisms[0] ?? "compact"].title} switched off below its target`;
}

/** A button of a card: whether it can be pressed, its label, what a screen reader says. */
export interface StepButton {
  enabled: boolean;
  label: string;
  accessibilityLabel: string;
}

export interface ThresholdRowView {
  key: ThresholdKey;
  label: string;
  valueText: string;
  decrease: StepButton;
  increase: StepButton;
}

export interface MechanismCardView {
  mechanism: CoordinationMechanism;
  title: string;
  meaning: string;
  /** How a turn is judged; null when there is nothing to add. */
  note: string | null;
  status: { text: string; tone: Tone };
  /** Turn off (at once) or Turn on… (after a confirmation). */
  toggle: StepButton & { turnsOn: boolean };
  rows: ThresholdRowView[];
  /** Enabled while a threshold differs from the stored one. */
  save: StepButton;
  /** Offered while a shown threshold is not its default. */
  reset: StepButton | null;
}

/** How many of `checked` entries A-12's target asks to be met: 8 of 10. */
function targetOf(checked: number): number {
  return Math.round(A12_TARGET * checked);
}

/** The status line: On, Off, or switched off below the target, with the figures. */
export function mechanismStatus(mechanism: CoordinationMechanism, settings: CoordinationSettings, now: Date): { text: string; tone: Tone } {
  if (settings[mechanism].enabled) return { text: "On", tone: "success" };
  const off = settings.guard[mechanism].switchedOff;
  if (off === null) return { text: "Off", tone: "muted" };
  return {
    text: `Switched off by paseo-bm ${ago(off.at, now)}: only ${off.met} of its last ${off.checked} met their goal (target ${targetOf(off.checked)}).`,
    tone: "warning",
  };
}

export function mechanismCardView(input: {
  mechanism: CoordinationMechanism;
  settings: CoordinationSettings;
  defaults: CoordinationSettings;
  draft: ThresholdDraft;
  saving: boolean;
  now: Date;
}): MechanismCardView {
  const { mechanism, settings, defaults, draft, saving, now } = input;
  const words = MECHANISM_WORDS[mechanism];
  const on = settings[mechanism].enabled;
  const rows = MECHANISM_THRESHOLDS[mechanism].map((key): ThresholdRowView => {
    const value = thresholdValueOf(settings, draft, key);
    const lower = stepThreshold(key, value, -1);
    const higher = stepThreshold(key, value, 1);
    const spoken = THRESHOLD_WORDS[key].spoken;
    return {
      key,
      label: THRESHOLD_WORDS[key].label,
      valueText: thresholdValueText(key, value),
      decrease: { enabled: !saving && lower !== value, label: "−", accessibilityLabel: `${spoken}: lower to ${thresholdValueText(key, lower)}` },
      increase: { enabled: !saving && higher !== value, label: "+", accessibilityLabel: `${spoken}: raise to ${thresholdValueText(key, higher)}` },
    };
  });
  const changed = changedThresholds(mechanism, settings, draft).length > 0;
  const atDefaults = MECHANISM_THRESHOLDS[mechanism].every((key) => thresholdValueOf(settings, draft, key) === storedValue(defaults, key));
  return {
    mechanism,
    title: words.title,
    meaning: words.meaning,
    note: words.note,
    status: mechanismStatus(mechanism, settings, now),
    toggle: on
      ? { turnsOn: false, enabled: !saving, label: "Turn off", accessibilityLabel: `Turn ${words.word} off now` }
      : { turnsOn: true, enabled: !saving, label: "Turn on…", accessibilityLabel: `Turn ${words.word} on, after a confirmation` },
    rows,
    save: { enabled: !saving && changed, label: saving ? "Saving…" : "Save", accessibilityLabel: `Save the ${words.word} thresholds` },
    reset: atDefaults ? null : { enabled: !saving, label: "Use the defaults", accessibilityLabel: `Set the ${words.word} thresholds back to their defaults` },
  };
}

/** The confirmation before a mechanism is turned on; Cancel is the default. */
export function turnOnDialog(mechanism: CoordinationMechanism, settings: CoordinationSettings): ConfirmDialog {
  const words = MECHANISM_WORDS[mechanism];
  const off = settings.guard[mechanism].switchedOff;
  const why = off === null ? "" : ` paseo-bm switched it off because only ${off.met} of its last ${off.checked} met their goal (target ${targetOf(off.checked)}).`;
  return {
    title: `Turn ${words.word} on?`,
    body: `${words.onBody}${why} Its record counts afresh from now.`,
    confirmLabel: "Turn on",
    cancelLabel: "Cancel",
    confirmAccessibilityLabel: `Turn ${words.word} on`,
    cancelAccessibilityLabel: `Keep ${words.word} off`,
    defaultAction: "cancel",
  };
}

// ── The review budget card (§C.4, §G.7; bead 7gxw.12) ──────────────────────

/** A tier's review-budget setting. */
export type ReviewBudgetKey = (typeof REVIEW_BUDGET_KEYS)[Tier];

/** The tiers in the order the card shows them. */
const BUDGET_TIERS: readonly Tier[] = ["Small", "Medium", "Large"];

/** The edited budgets not saved yet. */
export type ReviewBudgetDraft = Partial<Record<ReviewBudgetKey, number>>;

/** The card's words. */
export const REVIEW_BUDGET_WORDS = {
  title: "Review budget",
  meaning: "Review calls per request, by size: past them, the Worker asks you before another. Never below one review and its re-review.",
  note: "A new Worker gets these; one already working keeps the budget it started with.",
} as const;

/** A budget in words: "2 review calls". */
export function reviewBudgetValueText(value: number): string {
  return `${value} review call${value === 1 ? "" : "s"}`;
}

/** A budget one call down or up, kept within its bounds (2–8). */
export function stepReviewBudget(key: ReviewBudgetKey, value: number, step: -1 | 1): number {
  const bounds = COORDINATION_BOUNDS[key];
  return Math.min(bounds.max, Math.max(bounds.min, value + step));
}

function storedBudget(settings: CoordinationSettings, key: ReviewBudgetKey): number {
  const field = key.slice("review.".length) as keyof CoordinationSettings["review"];
  return settings.review[field];
}

/** The budget a card shows: the draft's, else the stored one. */
export function reviewBudgetValueOf(settings: CoordinationSettings, draft: ReviewBudgetDraft, key: ReviewBudgetKey): number {
  return draft[key] ?? storedBudget(settings, key);
}

/** The draft's changes, Small first: what Save sends, one `coordination.set` each. */
export function changedReviewBudget(settings: CoordinationSettings, draft: ReviewBudgetDraft): CoordinationChange[] {
  return BUDGET_TIERS.flatMap((tier) => {
    const key = REVIEW_BUDGET_KEYS[tier];
    const value = draft[key];
    return value === undefined || value === storedBudget(settings, key) ? [] : [{ key, value } as CoordinationChange];
  });
}

/** The draft that shows the defaults (saved only by Save). */
export function reviewBudgetDefaultsDraft(defaults: CoordinationSettings): ReviewBudgetDraft {
  return Object.fromEntries(BUDGET_TIERS.map((tier) => [REVIEW_BUDGET_KEYS[tier], storedBudget(defaults, REVIEW_BUDGET_KEYS[tier])]));
}

export interface ReviewBudgetRowView {
  tier: Tier;
  key: ReviewBudgetKey;
  label: string;
  valueText: string;
  decrease: StepButton;
  increase: StepButton;
}

export interface ReviewBudgetCardView {
  title: string;
  meaning: string;
  note: string;
  rows: ReviewBudgetRowView[];
  /** Enabled while a budget differs from the stored one. */
  save: StepButton;
  /** Offered while a shown budget is not its default. */
  reset: StepButton | null;
}

export function reviewBudgetCardView(input: {
  settings: CoordinationSettings;
  defaults: CoordinationSettings;
  draft: ReviewBudgetDraft;
  saving: boolean;
}): ReviewBudgetCardView {
  const { settings, defaults, draft, saving } = input;
  const rows = BUDGET_TIERS.map((tier): ReviewBudgetRowView => {
    const key = REVIEW_BUDGET_KEYS[tier];
    const value = reviewBudgetValueOf(settings, draft, key);
    const lower = stepReviewBudget(key, value, -1);
    const higher = stepReviewBudget(key, value, 1);
    const spoken = `Review budget of a ${tier} request`;
    return {
      tier,
      key,
      label: tier,
      valueText: reviewBudgetValueText(value),
      decrease: { enabled: !saving && lower !== value, label: "−", accessibilityLabel: `${spoken}: lower to ${reviewBudgetValueText(lower)}` },
      increase: { enabled: !saving && higher !== value, label: "+", accessibilityLabel: `${spoken}: raise to ${reviewBudgetValueText(higher)}` },
    };
  });
  const changed = changedReviewBudget(settings, draft).length > 0;
  const atDefaults = rows.every((row) => reviewBudgetValueOf(settings, draft, row.key) === storedBudget(defaults, row.key));
  return {
    title: REVIEW_BUDGET_WORDS.title,
    meaning: REVIEW_BUDGET_WORDS.meaning,
    note: REVIEW_BUDGET_WORDS.note,
    rows,
    save: { enabled: !saving && changed, label: saving ? "Saving…" : "Save", accessibilityLabel: "Save the review budget" },
    reset: atDefaults ? null : { enabled: !saving, label: "Use the defaults", accessibilityLabel: "Set the review budget back to its defaults" },
  };
}
