/**
 * Settings → Coordination's compaction and handoff cards (autonomy design
 * §G.5–§G.7; bead `7gxw.9`; drawn as the approved mockup): each mechanism its
 * own card, with its switch, how often it helped, and its thresholds as
 * number fields read in their own units ("390 K", "50 %") inside their
 * bounds, then Save; and the review card (delivery line design §5.6): the
 * re-reviews per batch and the review calls per milestone batch as number
 * fields, the cap per request they make (read-only), then Save; and the
 * rollover card (delivery line design §2.6, §6.6, §12 item 4), drawn with
 * the mechanisms' card: its switch, saved at once both ways (it lets nothing
 * act without the owner), the rollover figures, where a rollover is asked
 * now, and the maintenance ceiling. The − and + steps and each card's own
 * defaults stay here for callers that step.
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
  type CoordinationChange,
  type CoordinationMechanism,
  type CoordinationSettings,
} from "../shared/coordination";
import type { Tier } from "../shared/contracts";
import { reviewCapOf, REVIEW_MILESTONES_MAX } from "../shared/orchestrator-rules";
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
  | "handoff.maxPerRequest"
  | "rollover.beads"
  | "rollover.turns"
  | "rollover.tokens"
  | "rollover.contextTokens"
  | "rollover.ceilingFactor"
  | "maintenance.ceilingFactor";

/** The cards drawn as a mechanism's: compaction, handoff, then rollover. */
export type CoordinationCard = CoordinationMechanism | "rollover";
export const COORDINATION_CARDS: readonly CoordinationCard[] = [...COORDINATION_MECHANISMS, "rollover"];

/** Each card's thresholds, in the order it shows them. */
export const MECHANISM_THRESHOLDS: Readonly<Record<CoordinationCard, readonly ThresholdKey[]>> = {
  compact: ["compact.managerTokensPerTurn", "compact.workerTokensPerTurn", "compact.contextShare", "compact.maxPerAgent"],
  handoff: ["handoff.requestTokens", "handoff.maxPerRequest"],
  rollover: ["rollover.beads", "rollover.turns", "rollover.tokens", "rollover.contextTokens", "rollover.ceilingFactor", "maintenance.ceilingFactor"],
};

/** The edited values not saved yet. */
export type ThresholdDraft = Partial<Record<ThresholdKey, number>>;

const MECHANISM_WORDS: Readonly<
  Record<CoordinationCard, { title: string; heading: string; word: string; meaning: string; note: string | null; onBody: string }>
> = {
  compact: {
    title: "Compaction",
    heading: "Compact",
    word: "compaction",
    meaning: "Shrink a Main's or Worker's conversation at a safe point, then restore what matters from the records.",
    note: "A Claude turn is judged by its tokens read, a Codex or OpenCode turn by how full its context is.",
    onBody: "paseo-bm may then compact a Main's or a Worker's conversation without asking you, when it crosses your thresholds.",
  },
  handoff: {
    title: "Handoff",
    heading: "Handoff",
    word: "handoff",
    meaning: "Move a heavy request to a fresh Worker with a brief and the old Worker's note.",
    note: null,
    onBody: "paseo-bm may then hand a heavy request to a fresh Worker under its Main without asking you, when it crosses your thresholds.",
  },
  rollover: {
    title: "Rollover",
    heading: "Rollover",
    word: "rollover",
    meaning: "Finish a request that grew past one of these figures and go on in a fresh request with what remains.",
    note: "At the maintenance ceiling, or after 30 minutes, a compaction or handoff goes without waiting for a safe point.",
    onBody: "",
  },
};

const THRESHOLD_WORDS: Readonly<Record<ThresholdKey, { label: string; spoken: string }>> = {
  "compact.managerTokensPerTurn": { label: "Main reads more than, per turn", spoken: "Main turn threshold" },
  "compact.workerTokensPerTurn": { label: "Worker reads more than, per turn", spoken: "Worker turn threshold" },
  "compact.contextShare": { label: "Or its context window is fuller than", spoken: "Context threshold" },
  "compact.maxPerAgent": { label: "At most, per agent", spoken: "Compactions per agent" },
  "handoff.requestTokens": { label: "A request has read more than", spoken: "Request threshold" },
  "handoff.maxPerRequest": { label: "At most, per request", spoken: "Handoffs per request" },
  "rollover.beads": { label: "A request has closed beads", spoken: "Rollover beads" },
  "rollover.turns": { label: "Or its Worker turns reach", spoken: "Rollover turns" },
  "rollover.tokens": { label: "Or it has read", spoken: "Rollover tokens" },
  "rollover.contextTokens": { label: "Or its context reaches", spoken: "Rollover context" },
  "rollover.ceilingFactor": { label: "Finish now at, × a figure", spoken: "Rollover now" },
  "maintenance.ceilingFactor": { label: "Skip the safe point at, × a threshold", spoken: "Maintenance ceiling" },
};

const TOKEN_KEYS: ReadonlySet<ThresholdKey> = new Set(["compact.managerTokensPerTurn", "compact.workerTokensPerTurn", "handoff.requestTokens", "rollover.tokens", "rollover.contextTokens"]);
/** The factors, read as "2 ×" and stepped by a half. */
const FACTOR_KEYS: ReadonlySet<CoordinationNumberKey> = new Set(["rollover.ceilingFactor", "maintenance.ceilingFactor"]);

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

/** A threshold's value in words: "5.7M tokens read", "context 250k", "50% of the window", "2×", "15 beads", "at most 2". */
export function thresholdValueText(key: ThresholdKey, value: number): string {
  if (key === "rollover.contextTokens") return `context ${tokenCountText(value)}`;
  if (TOKEN_KEYS.has(key)) return `${tokenCountText(value)} tokens read`;
  if (key === "compact.contextShare") return `${Math.round(value * 100)}% of the window`;
  if (FACTOR_KEYS.has(key)) return `${trimmed(value)}×`;
  if (key === "rollover.beads") return `${value} beads`;
  if (key === "rollover.turns") return `${value} turns`;
  return `at most ${value}`;
}

/** The numeric settings a field of the Coordination cards edits as text. */
export type CoordinationNumberKey = keyof typeof COORDINATION_BOUNDS;

/** A setting as its field shows it (the approved mockup): "390 K", "5.7 M", "50 %", "2". */
export function coordinationInputText(key: CoordinationNumberKey, value: number): string {
  if (TOKEN_KEYS.has(key as ThresholdKey)) {
    if (value >= 1_000_000) return `${trimmed(value / 1_000_000)} M`;
    if (value >= 1_000) return `${trimmed(value / 1_000)} K`;
    return String(value);
  }
  if (key === "compact.contextShare") return `${Math.round(value * 100)} %`;
  if (FACTOR_KEYS.has(key)) return `${trimmed(value)} ×`;
  return String(value);
}

/** What a field's label says, for a refusal: its own label, or the setting in a few words. */
const FIELD_NAMES: Readonly<Partial<Record<CoordinationNumberKey, string>>> = {
  "review.maxRereviews": "Re-reviews per batch",
  "review.callsPerBatch": "Calls per milestone batch",
};

/**
 * A field's text as a value: a token count with an optional K or M ("390 K",
 * "5.7M", "390000"), the context share in percent ("50 %", "50"), a factor
 * with an optional × ("2.5 ×", "2.5"), any other a whole number. Outside its bounds, or not a number, it says why, in the
 * field's own units.
 */
export function parseCoordinationInput(key: CoordinationNumberKey, text: string): { value: number; error: null } | { value: null; error: string } {
  const bounds = COORDINATION_BOUNDS[key];
  const name = FIELD_NAMES[key] ?? THRESHOLD_WORDS[key as ThresholdKey]?.label ?? key;
  const range = `${coordinationInputText(key, bounds.min)} to ${coordinationInputText(key, bounds.max)}`;
  const refuse = { value: null, error: `${name}: a number from ${range}.` } as const;
  const trimmedText = text.trim();
  let value: number;
  if (TOKEN_KEYS.has(key as ThresholdKey)) {
    const match = /^(\d+(?:\.\d+)?)\s*([kKmM])?$/.exec(trimmedText);
    if (match === null) return refuse;
    const unit = match[2]?.toLowerCase();
    value = Math.round(Number(match[1]) * (unit === "m" ? 1_000_000 : unit === "k" ? 1_000 : 1));
  } else if (key === "compact.contextShare") {
    const match = /^(\d+(?:\.\d+)?)\s*%?$/.exec(trimmedText);
    if (match === null) return refuse;
    value = Math.round(Number(match[1])) / 100;
  } else if (FACTOR_KEYS.has(key)) {
    const match = /^(\d+(?:\.\d+)?)\s*[×xX]?$/.exec(trimmedText);
    if (match === null) return refuse;
    value = Math.round(Number(match[1]) * 100) / 100;
  } else {
    if (!/^\d+$/.test(trimmedText)) return refuse;
    value = Number(trimmedText);
  }
  if (!(value >= bounds.min && value <= bounds.max)) return refuse;
  return { value, error: null };
}

/** The text of the fields being typed in, by setting; a field not in it shows its value. */
export type CoordinationInputs = Partial<Record<CoordinationNumberKey, string>>;

/** The refusals of the fields being typed in, in the given order. */
export function inputErrorsOf(keys: readonly CoordinationNumberKey[], inputs: CoordinationInputs): string[] {
  return keys.flatMap((key) => {
    const text = inputs[key];
    if (text === undefined) return [];
    const parsed = parseCoordinationInput(key, text);
    return parsed.error === null ? [] : [parsed.error];
  });
}

/**
 * How often the mechanism helped, beside its switch: the A-12 figures the
 * guard switched it off on ("helped 6 of 10"); "helped —" while there are none.
 */
export function helpedText(mechanism: CoordinationMechanism, settings: CoordinationSettings): string {
  const off = settings.guard[mechanism].switchedOff;
  return off === null ? "helped —" : `helped ${off.met} of ${off.checked}`;
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
 * by 5 points, a factor by a half, a count by one.
 */
export function stepThreshold(key: ThresholdKey, value: number, step: -1 | 1): number {
  const bounds = COORDINATION_BOUNDS[key];
  const next = TOKEN_KEYS.has(key)
    ? tokenStep(value, step)
    : key === "compact.contextShare"
      ? Math.round((value + step * 0.05) * 100) / 100
      : FACTOR_KEYS.has(key)
        ? value + step * 0.5
        : value + step;
  return Math.min(bounds.max, Math.max(bounds.min, next));
}

/** The stored value of a threshold. */
function storedValue(settings: CoordinationSettings, key: ThresholdKey): number {
  const [group, field] = key.split(".") as ["compact" | "handoff" | "rollover" | "maintenance", string];
  return (settings[group] as unknown as Record<string, number>)[field]!;
}

/** The value a card shows: the draft's, else the stored one. */
export function thresholdValueOf(settings: CoordinationSettings, draft: ThresholdDraft, key: ThresholdKey): number {
  return draft[key] ?? storedValue(settings, key);
}

/** The draft's changes of `mechanism`'s thresholds, in the card's order: what Save sends, one `coordination.set` each. */
export function changedThresholds(mechanism: CoordinationCard, settings: CoordinationSettings, draft: ThresholdDraft): CoordinationChange[] {
  return MECHANISM_THRESHOLDS[mechanism].flatMap((key) => {
    const value = draft[key];
    return value === undefined || value === storedValue(settings, key) ? [] : [{ key, value } as CoordinationChange];
  });
}

/** The draft that shows `mechanism`'s defaults (saved only by Save). */
export function defaultsDraft(mechanism: CoordinationCard, defaults: CoordinationSettings): ThresholdDraft {
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
  /** The value as its field shows it: "390 K". */
  inputText: string;
  /** What a screen reader says for the field. */
  accessibilityLabel: string;
  decrease: StepButton;
  increase: StepButton;
}

export interface MechanismCardView {
  /** The card; `integration` is the CI card (`ciCardView`), drawn with the same controls. */
  mechanism: CoordinationCard | "integration";
  title: string;
  /** "helped 6 of 10", "helped —"; null for rollover, which A-12 does not judge. */
  helped: string | null;
  meaning: string;
  /** How a turn is judged; null when there is nothing to add. */
  note: string | null;
  status: { text: string; tone: Tone };
  /** Turn off (at once) or Turn on… (after a confirmation; rollover's Turn on, at once). */
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
export function mechanismStatus(mechanism: CoordinationCard, settings: CoordinationSettings, now: Date): { text: string; tone: Tone } {
  if (settings[mechanism].enabled) return { text: "On", tone: "success" };
  const off = mechanism === "rollover" ? null : settings.guard[mechanism].switchedOff;
  if (off === null) return { text: "Off", tone: "muted" };
  return {
    text: `Switched off by paseo-bm ${ago(off.at, now)}: only ${off.met} of its last ${off.checked} met their goal (target ${targetOf(off.checked)}).`,
    tone: "warning",
  };
}

export function mechanismCardView(input: {
  mechanism: CoordinationCard;
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
      inputText: coordinationInputText(key, value),
      accessibilityLabel: `${spoken}: ${thresholdValueText(key, value)}`,
      decrease: { enabled: !saving && lower !== value, label: "−", accessibilityLabel: `${spoken}: lower to ${thresholdValueText(key, lower)}` },
      increase: { enabled: !saving && higher !== value, label: "+", accessibilityLabel: `${spoken}: raise to ${thresholdValueText(key, higher)}` },
    };
  });
  const changed = changedThresholds(mechanism, settings, draft).length > 0;
  const atDefaults = MECHANISM_THRESHOLDS[mechanism].every((key) => thresholdValueOf(settings, draft, key) === storedValue(defaults, key));
  return {
    mechanism,
    title: words.heading,
    helped: mechanism === "rollover" ? null : helpedText(mechanism, settings),
    meaning: words.meaning,
    note: words.note,
    status: mechanismStatus(mechanism, settings, now),
    toggle: on
      ? { turnsOn: false, enabled: !saving, label: "Turn off", accessibilityLabel: `Turn ${words.word} off now` }
      : mechanism === "rollover"
        ? { turnsOn: true, enabled: !saving, label: "Turn on", accessibilityLabel: `Turn ${words.word} on now` }
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

// ── The review card (delivery line design §5.3, §5.6) ───────────────────────

/** The review settings, in the order the card shows them. */
export const REVIEW_KEYS = ["review.maxRereviews", "review.callsPerBatch"] as const;
export type ReviewKey = (typeof REVIEW_KEYS)[number];

/** The tiers the caps line shows, in its order. */
const CAP_TIERS: readonly Tier[] = ["Small", "Medium", "Large"];

/** The edited review settings not saved yet. */
export type ReviewDraft = Partial<Record<ReviewKey, number>>;

/** The card's words. */
export const REVIEW_WORDS = {
  title: "Review",
  meaning: "A batch is re-reviewed while its blocking findings fall; each milestone batch adds its calls to the request's cap.",
} as const;

const REVIEW_ROW_WORDS: Readonly<Record<ReviewKey, { label: string; spoken: string; unit: (value: number) => string }>> = {
  "review.maxRereviews": { label: "Re-reviews per batch", spoken: "Re-reviews per batch", unit: (value) => `${value} re-review${value === 1 ? "" : "s"}` },
  "review.callsPerBatch": { label: "Calls per milestone batch", spoken: "Review calls per milestone batch", unit: (value) => `${value} review call${value === 1 ? "" : "s"}` },
};

/** A review setting in words: "3 re-reviews", "3 review calls". */
export function reviewValueText(key: ReviewKey, value: number): string {
  return REVIEW_ROW_WORDS[key].unit(value);
}

/** A review setting one down or up, kept within its bounds. */
export function stepReview(key: ReviewKey, value: number, step: -1 | 1): number {
  const bounds = COORDINATION_BOUNDS[key];
  return Math.min(bounds.max, Math.max(bounds.min, value + step));
}

function storedReview(settings: CoordinationSettings, key: ReviewKey): number {
  return key === "review.maxRereviews" ? settings.review.maxRereviews : settings.review.callsPerBatch;
}

/** The value the card shows: the draft's, else the stored one. */
export function reviewValueOf(settings: CoordinationSettings, draft: ReviewDraft, key: ReviewKey): number {
  return draft[key] ?? storedReview(settings, key);
}

/**
 * The cap per request at `callsPerBatch` (§5.3: at each tier's most milestone
 * batches), in a line the card shows read-only: "Cap per request: Small 3,
 * Medium 6, Large 12 calls".
 */
export function reviewCapsText(callsPerBatch: number): string {
  const caps = CAP_TIERS.map((tier) => `${tier} ${reviewCapOf(tier, REVIEW_MILESTONES_MAX[tier], { callsPerBatch })}`);
  return `Cap per request: ${caps.join(", ")} calls`;
}

/** The draft's changes, in the card's order: what Save sends, one `coordination.set` each. */
export function changedReview(settings: CoordinationSettings, draft: ReviewDraft): CoordinationChange[] {
  return REVIEW_KEYS.flatMap((key) => {
    const value = draft[key];
    return value === undefined || value === storedReview(settings, key) ? [] : [{ key, value } as CoordinationChange];
  });
}

/** The draft that shows the defaults (saved only by Save). */
export function reviewDefaultsDraft(defaults: CoordinationSettings): ReviewDraft {
  return Object.fromEntries(REVIEW_KEYS.map((key) => [key, storedReview(defaults, key)]));
}

export interface ReviewRowView {
  key: ReviewKey;
  label: string;
  valueText: string;
  inputText: string;
  accessibilityLabel: string;
  decrease: StepButton;
  increase: StepButton;
}

export interface ReviewCardView {
  title: string;
  meaning: string;
  rows: ReviewRowView[];
  /** The cap per request the shown `review.callsPerBatch` makes, read-only. */
  caps: string;
  /** Enabled while a setting differs from the stored one. */
  save: StepButton;
  /** Offered while a shown setting is not its default. */
  reset: StepButton | null;
}

export function reviewCardView(input: {
  settings: CoordinationSettings;
  defaults: CoordinationSettings;
  draft: ReviewDraft;
  saving: boolean;
}): ReviewCardView {
  const { settings, defaults, draft, saving } = input;
  const rows = REVIEW_KEYS.map((key): ReviewRowView => {
    const value = reviewValueOf(settings, draft, key);
    const lower = stepReview(key, value, -1);
    const higher = stepReview(key, value, 1);
    const spoken = REVIEW_ROW_WORDS[key].spoken;
    return {
      key,
      label: REVIEW_ROW_WORDS[key].label,
      valueText: reviewValueText(key, value),
      inputText: String(value),
      accessibilityLabel: `${spoken}: ${reviewValueText(key, value)}`,
      decrease: { enabled: !saving && lower !== value, label: "−", accessibilityLabel: `${spoken}: lower to ${reviewValueText(key, lower)}` },
      increase: { enabled: !saving && higher !== value, label: "+", accessibilityLabel: `${spoken}: raise to ${reviewValueText(key, higher)}` },
    };
  });
  const changed = changedReview(settings, draft).length > 0;
  const atDefaults = REVIEW_KEYS.every((key) => reviewValueOf(settings, draft, key) === storedReview(defaults, key));
  return {
    title: REVIEW_WORDS.title,
    meaning: REVIEW_WORDS.meaning,
    rows,
    caps: reviewCapsText(reviewValueOf(settings, draft, "review.callsPerBatch")),
    save: { enabled: !saving && changed, label: saving ? "Saving…" : "Save", accessibilityLabel: "Save the review settings" },
    reset: atDefaults ? null : { enabled: !saving, label: "Use the defaults", accessibilityLabel: "Set the review settings back to their defaults" },
  };
}

// ---------------------------------------------------------------------------
// The Coordination group as a whole (change-014 outcome 5): open on the
// screen, under one line of what it is, ending with one reset.
// ---------------------------------------------------------------------------

/** What the Coordination group is, in one line under its title. */
export const COORDINATION_MEANING =
  "When paseo-bm compacts an agent or hands a request to a fresh Worker, for every project. Each switches itself off if it stops helping.";

/** The drafts of the whole group, every value at its default: the thresholds of both mechanisms and of rollover, the review settings. */
export interface CoordinationDefaultsDraft {
  thresholds: ThresholdDraft;
  review: ReviewDraft;
}

export function coordinationDefaultsDraft(defaults: CoordinationSettings): CoordinationDefaultsDraft {
  return {
    thresholds: Object.assign({}, ...COORDINATION_CARDS.map((mechanism) => defaultsDraft(mechanism, defaults))) as ThresholdDraft,
    review: reviewDefaultsDraft(defaults),
  };
}

/**
 * "Reset coordination to defaults": fills every card with its defaults, as
 * each card's own "Use the defaults" does; nothing is saved until a card's
 * Save. The switches are left as they are.
 */
export function coordinationResetView(saving: boolean): StepButton {
  return {
    enabled: !saving,
    label: "Reset coordination to defaults",
    accessibilityLabel: "Fill every coordination setting with its default; each card saves with its own Save",
  };
}

// ── The CI card (ADR-036, delivery line design §17.1) ───────────────────────

/** The CI card's words. */
export const CI_CARD_WORDS = {
  title: "CI",
  meaning: "Read a merge request's pipeline as evidence and show it. Off: verified is a check paseo-bm saw pass, and no agent waits on a pipeline.",
} as const;

/**
 * The CI card (`integration.ci`), drawn with a mechanism card's controls: its
 * switch, saved at once both ways (it lets nothing act without the owner),
 * On or Off, and no figures.
 */
export function ciCardView(settings: CoordinationSettings, saving: boolean): MechanismCardView {
  const on = settings.integration.ci === "on";
  return {
    mechanism: "integration",
    title: CI_CARD_WORDS.title,
    helped: null,
    meaning: CI_CARD_WORDS.meaning,
    note: null,
    status: on ? { text: "On", tone: "success" } : { text: "Off", tone: "muted" },
    toggle: { turnsOn: !on, enabled: !saving, label: on ? "Turn off" : "Turn on", accessibilityLabel: `Turn CI ${on ? "off" : "on"} now` },
    rows: [],
    save: { enabled: false, label: "Save", accessibilityLabel: "Save the CI setting" },
    reset: null,
  };
}

/** What the CI card's switch saves: `integration.ci` the other way. */
export function ciToggleChange(settings: CoordinationSettings): CoordinationChange {
  return { key: "integration.ci", value: settings.integration.ci === "on" ? "off" : "on" };
}
