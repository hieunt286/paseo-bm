/**
 * The decision card (experience concept §5.2): live from the decision store.
 * The same card in every chat and in the Inbox; answering anywhere shows
 * answered everywhere on the next read. Split from `chat-cards.ts` (code
 * review 2026-09-30 §4).
 *
 * Change-014 (ADR-025): at Co-pilot and up the Orchestrator's proposal is the
 * primary option ("Orchestrator suggests · …") with its reason under the
 * options; the asker's recommended option keeps its ★. A Worker's question or
 * an Orchestrator's decision can be asked back (`decisions.ask`) and shows its
 * conversation (`decisions.thread`); the decision stays open meanwhile.
 *
 * Pure: no React, no React Native, no `server/` import.
 */
import type { ChatPeer } from "../shared/contracts";
import { askableKindOf, hasOpenAsk, type DecisionThread } from "../shared/decision-threads";
import {
  decisionClassOf,
  decisionKindOf,
  declaredEffects,
  deliveryKindOf,
  effectsOfAnswer,
  isAnswerable,
  needsOwnerConfirmation,
  policyPredictorOf,
  realEffects,
  type AnswerVia,
  type ChatVia,
  type Decision,
  type Effect,
} from "../shared/decisions";
import { MAX_BODY_LINES, type ChatCard, type ChatRole, type DecisionSeed } from "./chat-card-parse";
import { actorName, party } from "./chat-card-parties";
import type { CardFrameView } from "./chat-card-frame";
import { codedReason, errorCodeOf } from "./errors";
import { ago, localTimeText } from "./format";
import type { Badge } from "./tone";
import type { ConfirmDialog } from "./ui-types";
import { shorten } from "../shared/text";

/** How often an unsettled decision is read again; a settled one is not read again. */
export const DECISION_POLL_MS = 5_000;
/** A decision the store does not have (yet) is looked for this long after its message: the materialiser runs at the end of the Manager's turn. */
export const DECISION_LOOKUP_WINDOW_MS = 10 * 60_000;

/** What `decisions.get` said about a card's decision. */
export type DecisionLookup =
  | { state: "loading" }
  | { state: "failed"; error: unknown }
  | { state: "missing" }
  | { state: "found"; decision: Decision };

/** The lookup of a `decisions.get` result: `E_DECISION_NOT_FOUND` is `missing`, any other failure `failed`. */
export function decisionLookupOf(result: { data?: { decision: Decision } | undefined; error?: unknown; isLoading?: boolean }): DecisionLookup {
  if (result.data !== undefined) return { state: "found", decision: result.data.decision };
  if (result.error !== undefined && result.error !== null) {
    return errorCodeOf(result.error) === "E_DECISION_NOT_FOUND" ? { state: "missing" } : { state: "failed", error: result.error };
  }
  return { state: "loading" };
}

/**
 * When to read the decision again: every `DECISION_POLL_MS` while it can
 * still be answered; never once it is settled; while it is not recorded or
 * unreadable, only within `DECISION_LOOKUP_WINDOW_MS` of its message, so an
 * old chat does not poll for decisions long gone.
 */
export function decisionPollMs(lookup: DecisionLookup, cardAt: Date, now: Date): number | false {
  if (lookup.state === "found") return isAnswerable(lookup.decision) ? DECISION_POLL_MS : false;
  const age = now.getTime() - cardAt.getTime();
  return Number.isNaN(age) || age > DECISION_LOOKUP_WINDOW_MS ? false : DECISION_POLL_MS;
}

/**
 * The line an open override's card carries (autonomy design §B.7): it
 * corrects an answer made for the owner, and the answer goes to the agent
 * that got the first one.
 */
export const OVERRIDE_CARD_LINE = "You are overriding an answer made for you. Your answer goes to the same agent and replaces it.";

/**
 * The line an open held request's card carries (autonomy design §D.2): what
 * waits, and that Paseo's own prompt answers it too.
 */
export const HELD_CARD_LINE = "The agent waits for this. Allow runs it once; Deny stops it. Paseo's own prompt in the agent's chat answers it too.";

/** The option key a words answer confirms under, in `DecisionUi.confirming`. */
export const OWN_WORDS = "*own-words*";

/** The card's own state: what the owner is doing on it right now. */
export interface DecisionUi {
  /** An option key (or `OWN_WORDS`) waiting for the confirmation step; null otherwise. */
  confirming: string | null;
  /** The own-words box, open when not null. */
  words: string | null;
  busy: boolean;
  /** What the last press could not do. */
  error: string | null;
}

export const DECISION_UI_IDLE: DecisionUi = { confirming: null, words: null, busy: false, error: null };

export interface DecisionButton {
  key: string;
  label: string;
  /**
   * The one primary action: the option the Orchestrator suggests when it
   * proposed one (Co-pilot and up, ADR-025), else the recommended option; the
   * others are secondary.
   */
  primary: boolean;
  /** Tapping it first asks for the confirmation (release, data, security, cost — X-4). */
  confirm: boolean;
  accessibilityLabel: string;
}

export interface DecisionCardView {
  frame: CardFrameView;
  /** The options, while the decision can be answered (`open` or `needs-confirmation`). */
  options: DecisionButton[];
  /** "Own words…" offered: while the decision can be answered. */
  ownWords: boolean;
  /** "Close as answered" / "Keep open", only while `needs-confirmation`, beside the options. */
  confirmChat: boolean;
  /** The in-place confirmation, Cancel first; null when none is asked. */
  confirm: ConfirmDialog | null;
  /** The Orchestrator's reason for the option it suggests, one muted line under the options; null when it proposed none or the options are hidden. */
  proposal: string | null;
  /** Ask back and the conversation (change-014 outcome 3); null on a decision whose asker cannot be asked. */
  askBack: AskBackView | null;
  details: string[];
}

/** Who wrote one entry of the conversation, oldest first. */
export interface ConversationEntry {
  key: string;
  who: string;
  text: string;
}

/** Ask back on a decision card: the conversation, the button, the box and the line under them. */
export interface AskBackView {
  /** "Ask back" offered: an unsettled `q:`/`o:` decision, no box, confirmation or own-words box open. */
  offered: boolean;
  /** What a screen reader hears for the Ask back button. */
  accessibilityLabel: string;
  /** The box, open: its label and whether Send can be pressed. */
  box: { label: string; placeholder: string; busy: boolean; sendEnabled: boolean } | null;
  /** The thread, oldest first; empty when nobody asked. */
  conversation: ConversationEntry[];
  /** Not delivered, waiting for the asker, sending, or what the last Send could not do. */
  status: { text: string; tone: "muted" | "warning" | "danger" } | null;
}

/** The card's Ask back state: the box (open when not null), the call in flight, and what the last Send said. */
export interface AskUi {
  text: string | null;
  busy: boolean;
  error: string | null;
  /** The last ask's delivery, from `decisions.ask`; null before one. */
  delivery: "sent" | "queued" | "failed" | null;
}

export const ASK_UI_IDLE: AskUi = { text: null, busy: false, error: null, delivery: null };

/** What a failed delivery of the owner's question says (the question is kept in the thread). */
export const ASK_NOT_DELIVERED = "Not delivered: the asker could not be reached; your question is kept.";

const VIA_WHERE: Readonly<Record<AnswerVia, string>> = {
  inbox: " in the Inbox",
  "chat-card": "",
  "chat-manager": " in the Manager's chat",
  "chat-worker": " in the Worker's chat",
  "chat-orchestrator": " in the Orchestrator's chat",
  autopilot: " on Autopilot",
  paseo: " in Paseo's own prompt",
};

const CHAT_WORDS: Readonly<Record<ChatVia, string>> = {
  "chat-manager": "the Manager's chat",
  "chat-worker": "the Worker's chat",
  "chat-orchestrator": "the Orchestrator's chat",
};

/**
 * Who answered a decision for the owner on their policy (§B.5, ADR-025): the
 * Orchestrator, the only predictor; "your earlier policy" for an answer a
 * build before ADR-025 stored with the recommended option as its predictor;
 * "your policy" for a held request the action boundary allowed (no predictor).
 */
function policyAnswererOf(decision: Decision): string {
  const predictor = policyPredictorOf(decision);
  return predictor === "orchestrator" ? "the Orchestrator" : predictor === "recommended" ? "your earlier policy" : "your policy";
}

const STATUS_CHIPS: Readonly<Record<Decision["status"], Badge>> = {
  open: { text: "Needs decision", tone: "warning" },
  "needs-confirmation": { text: "Needs confirmation", tone: "warning" },
  answered: { text: "Decided", tone: "success" },
  superseded: { text: "Superseded", tone: "muted" },
  withdrawn: { text: "Withdrawn", tone: "muted" },
  expired: { text: "Expired", tone: "muted" },
};

function agentNamed(id: string | null, agents: readonly ChatPeer[], fallback: ChatRole | null): string {
  const peer = id === null ? undefined : agents.find((candidate) => candidate.id === id);
  return actorName(party(peer, fallback));
}

function askerOf(role: DecisionSeed["asker"], agentId: string | null, agents: readonly ChatPeer[]): CardFrameView["actor"] {
  if (role === "orchestrator") return { mark: "orchestrator", name: "Orchestrator" };
  if (role === "plugin") return { mark: null, name: "paseo-bm plugin" };
  return { mark: "worker", name: agentNamed(agentId, agents, "worker") };
}

function effectWords(effects: readonly Effect[]): string {
  return effects.join(", ");
}

/** True when this answer needs the owner's confirmation first (X-4, `CONFIRM_EFFECTS`). */
export function choiceNeedsConfirmation(decision: Pick<Decision, "options">, choice: { optionKey: string } | { words: string }): boolean {
  return needsOwnerConfirmation(effectsOfAnswer(decision, "optionKey" in choice ? { optionKey: choice.optionKey } : { optionKey: null }));
}

function answerLines(decision: Decision, agents: readonly ChatPeer[]): string[] {
  const answer = decision.answer;
  const lines: string[] = [];
  if (answer !== null) {
    const option = answer.optionKey === null ? undefined : decision.options.find((entry) => entry.key === answer.optionKey);
    if (option !== undefined) lines.push(`✓ ${option.label}`);
    else if (answer.words !== null) lines.push(`${answer.by === "precedent" ? "Your precedent" : "Your words"}: ${shorten(answer.words, 160)}`);
    else lines.push(`Answered${VIA_WHERE[answer.via]} (confirmed by you).`);
  }
  const delivery = decision.delivery;
  if (delivery !== null) {
    const to = agentNamed(delivery.to, agents, null);
    const name = to === "Agent" ? "the agent" : to;
    lines.push(
      delivery.outcome === "sent" ? `Sent to ${name}.` : delivery.outcome === "queued" ? `Queued for ${name}: it goes when the agent is idle.` : `Could not deliver to ${name}.`,
    );
  }
  return lines;
}

function settledLine(decision: Decision): string | null {
  switch (decision.status) {
    case "superseded":
      return "Replaced by a newer question.";
    case "withdrawn":
      if (decisionKindOf(decision.id) === "held") return "The request was answered elsewhere, or its agent moved on.";
      return decision.id.startsWith("f:") ? "The incident was handled another way." : "The asker no longer needs an answer.";
    case "expired":
      // A Worker's question, and the owner's override of one, expires when its request finishes (autonomy design §A.3, §B.7).
      return deliveryKindOf(decision) === "question" ? "The request finished." : "Nobody answered in time.";
    default:
      return null;
  }
}

function grantTag(decision: Decision): string | null {
  const grant = decision.grant;
  if (grant === null) return null;
  return grant.usedAt === null ? `grant: ${effectWords(grant.effects)} 1×` : "grant used";
}

function decisionDetails(card: ChatCard, seed: DecisionSeed, decision: Decision | null): string[] {
  const lines = [`Decision: ${seed.id}`];
  const requestId = decision?.requestId ?? card.requestId;
  if (requestId !== null) lines.push(`Request: ${requestId}`);
  if (decision === null) return lines;
  lines.push(`Asked by: ${decision.askedBy.role}${decision.askedBy.agentId === null ? "" : ` ${decision.askedBy.agentId}`} at ${decision.askedAt}`);
  if (decision.subject !== null) lines.push(`Subject: ${decision.subject}`);
  // Stored, or read for a decision stored before classes (autonomy design §B.1, §B.9).
  lines.push(`Class: ${decisionClassOf(decision)}`);
  for (const option of decision.options) {
    const effects = realEffects(option.effects);
    lines.push(`${option.key}: ${option.label}${option.recommended ? " (recommended)" : ""} — effects: ${effects.length === 0 ? "none" : effectWords(effects)}`);
  }
  lines.push(`Status: ${decision.status}${decision.settledAt === null ? "" : ` at ${decision.settledAt}`}`);
  const proposal = proposalOf(decision);
  if (proposal !== null) lines.push(`Orchestrator suggests: ${proposal.optionKey} at ${decision.prediction!.orchestrator!.at}`);
  if (decision.answer !== null) {
    if (decision.answer.by === "orchestrator") lines.push("Answered by: the Orchestrator");
    if (decision.answer.by === "precedent") lines.push(`Answered by: your precedent ${decision.answer.precedentId ?? ""}`.trimEnd());
    if (decision.answer.by === "policy") {
      const predictor = policyPredictorOf(decision);
      const cls = decision.answer.class ?? decisionClassOf(decision);
      lines.push(`Answered by: ${policyAnswererOf(decision)} (${predictor === "recommended" ? `recommended option, ${cls}` : cls})`);
    }
    lines.push(`Answer via: ${decision.answer.via}`);
    // The Orchestrator's reason (bm_decide, change-004): in Details, never on the card's face.
    if (decision.answer.reason !== undefined) lines.push(`Reason: ${decision.answer.reason}`);
  }
  if (decision.grant !== null) {
    lines.push(`Grant: ${effectWords(decision.grant.effects)} until ${decision.grant.expiresAt}${decision.grant.usedAt === null ? "" : `, used at ${decision.grant.usedAt}`}`);
  }
  if (decision.delivery !== null) lines.push(`Delivery: ${decision.delivery.outcome} to ${decision.delivery.to} at ${decision.delivery.at} (${decision.delivery.kind})`);
  if (decision.supersedes !== null) lines.push(`Supersedes: ${decision.supersedes}`);
  if (decision.supersededBy !== null) lines.push(`Superseded by: ${decision.supersededBy}`);
  return lines;
}

export interface DecisionViewInput {
  card: ChatCard;
  lookup: DecisionLookup;
  /** The agents the card can name: the chat's owner and its peers. */
  agents: readonly ChatPeer[];
  ui: DecisionUi;
  /** The message's time in the timeline. */
  cardAt: Date;
  now: Date;
  /** The decision's Ask back thread (`decisions.thread`); absent or null while not read. */
  thread?: DecisionThread | null;
  /** The card's Ask back state; idle when absent. */
  ask?: AskUi;
}

/**
 * Everything a decision card draws, from its seed and the decision as the
 * store has it now. The same card in every chat and in the Inbox: answering
 * anywhere shows answered everywhere on the next read.
 */
export function decisionCardView(input: DecisionViewInput): DecisionCardView {
  const { card, lookup, agents, ui, now } = input;
  const seed = card.decision!;
  const decision = lookup.state === "found" ? lookup.decision : null;
  const frame: CardFrameView = {
    actor: askerOf(decision?.askedBy.role ?? seed.asker, decision?.askedBy.agentId ?? null, agents),
    recipient: "you",
    authority: null,
    time: decision === null ? localTimeText(input.cardAt, now) : `asked ${ago(decision.askedAt, now)}`,
    chip: null,
    title: decision?.question ?? seed.question,
    tag: null,
    body: [],
    outline: null,
    status: ui.error === null ? (ui.busy ? { text: "Sending your answer…", tone: "muted" } : null) : { text: ui.error, tone: "danger" },
  };
  const view: DecisionCardView = {
    frame,
    options: [],
    ownWords: false,
    confirmChat: false,
    confirm: null,
    proposal: null,
    askBack: null,
    details: decisionDetails(card, seed, decision),
  };

  if (decision === null) {
    const body =
      lookup.state === "loading"
        ? "Reading the decision…"
        : lookup.state === "failed"
          ? `Could not read the decision${codedReason(lookup.error)}`
          : seed.asker === "worker"
            ? "Not recorded yet: it opens once the Manager has read the report."
            : "This decision is not recorded.";
    return { ...view, frame: { ...frame, body: [body] } };
  }

  const chip = STATUS_CHIPS[decision.status];
  switch (decision.status) {
    case "open": {
      const declared = declaredEffects(decision);
      const held = decisionKindOf(decision.id) === "held";
      const controls = answerControls(decision, ui);
      return {
        ...view,
        ...controls,
        askBack: askBackOf(decision, ui, controls.confirm !== null, input.thread ?? null, input.ask ?? ASK_UI_IDLE),
        frame: {
          ...frame,
          chip,
          tag: declared.length === 0 ? null : `effects: ${effectWords(declared)}`,
          body: decisionKindOf(decision.id) === "override" ? [OVERRIDE_CARD_LINE] : held ? [HELD_CARD_LINE] : [],
          // A held action waits on the owner while its Worker is mid-call: the danger bar (change-014).
          ...(held ? { bar: "danger" as const } : {}),
        },
      };
    }
    case "needs-confirmation": {
      // Still answerable: the options stay, and closing it as answered in the chat is one more choice beside them.
      const declared = declaredEffects(decision);
      const where = decision.needsConfirmation === null ? "a chat" : CHAT_WORDS[decision.needsConfirmation.via];
      const at = decision.needsConfirmation === null ? "" : ` at ${localTimeText(new Date(decision.needsConfirmation.at), now)}`;
      const controls = answerControls(decision, ui);
      return {
        ...view,
        ...controls,
        askBack: askBackOf(decision, ui, controls.confirm !== null, input.thread ?? null, input.ask ?? ASK_UI_IDLE),
        frame: {
          ...frame,
          chip,
          tag: declared.length === 0 ? null : `effects: ${effectWords(declared)}`,
          body: [`You wrote in ${where}${at}. Choose an answer, or close it if that message answered it.`],
        },
        confirmChat: controls.confirm === null && ui.words === null,
      };
    }
    case "answered": {
      const answer = decision.answer!;
      // Settled either way, so no answer buttons: the Orchestrator's answer (bm_decide) is as final as the owner's.
      const by =
        answer.by === "orchestrator"
          ? "answered by the Orchestrator"
          : answer.by === "precedent"
            ? "answered by your precedent"
            : answer.by === "policy"
              ? `decided for you by ${policyAnswererOf(decision)}`
              : `answered by you${VIA_WHERE[answer.via]}`;
      return {
        ...view,
        askBack: askBackOf(decision, ui, false, input.thread ?? null, input.ask ?? ASK_UI_IDLE),
        frame: {
          ...frame,
          chip,
          authority: `${by} · ${localTimeText(new Date(answer.at), now)}`,
          tag: grantTag(decision),
          body: answerLines(decision, agents).slice(0, MAX_BODY_LINES),
        },
      };
    }
    default:
      return {
        ...view,
        askBack: askBackOf(decision, ui, false, input.thread ?? null, input.ask ?? ASK_UI_IDLE),
        frame: { ...frame, chip, body: [settledLine(decision) ?? ""].filter((line) => line !== "") },
      };
  }
}

/** The prefix of the option the Orchestrator suggests (Co-pilot and up, ADR-025). */
export const SUGGESTS_PREFIX = "Orchestrator suggests · ";

/**
 * The Orchestrator's proposal on a decision that can still be answered
 * (`prediction.orchestrator`, returned only at a level of 1 or more), when it
 * names one of the options; null otherwise.
 */
export function proposalOf(decision: Decision): { optionKey: string; reason: string } | null {
  const predicted = decision.prediction?.orchestrator ?? null;
  if (predicted === null || !isAnswerable(decision)) return null;
  return decision.options.some((option) => option.key === predicted.optionKey) ? { optionKey: predicted.optionKey, reason: predicted.reason } : null;
}

/** The answer buttons, Own words… and the in-place confirmation of a decision that can still be answered. */
function answerControls(decision: Decision, ui: DecisionUi): Pick<DecisionCardView, "options" | "ownWords" | "confirm" | "proposal"> {
  const proposal = proposalOf(decision);
  const options = decision.options.map(
    (option): DecisionButton => {
      const effects = realEffects(option.effects);
      const suggested = proposal?.optionKey === option.key;
      const label = option.recommended ? `${option.label} ★` : option.label;
      const why = [...(suggested ? ["the Orchestrator suggests it"] : []), ...(option.recommended ? ["recommended"] : [])];
      return {
        key: option.key,
        label: suggested ? `${SUGGESTS_PREFIX}${label}` : label,
        // The Orchestrator's proposal is the primary action; the asker's recommendation keeps its ★ but is secondary when they differ.
        primary: proposal === null ? option.recommended : suggested,
        confirm: needsOwnerConfirmation(effects),
        accessibilityLabel: `Answer: ${option.label}${why.length === 0 ? "" : ` (${why.join("; ")})`}${effects.length === 0 ? "" : `; allows ${effectWords(effects)}`}`,
      };
    },
  );
  let confirm: DecisionCardView["confirm"] = null;
  if (ui.confirming !== null) {
    const option = decision.options.find((entry) => entry.key === ui.confirming);
    const effects = effectsOfAnswer(decision, { optionKey: option?.key ?? null });
    confirm = {
      title: option === undefined ? "Send your own words?" : `Answer: ${option.label}?`,
      body: `This answer allows ${effectWords(effects)} once, within the hour. Nothing is sent until you confirm.`,
      confirmLabel: "Confirm and send",
      cancelLabel: "Cancel",
      defaultAction: "cancel",
    };
  }
  const shown = confirm === null && ui.words === null;
  return {
    options: shown ? options : [],
    // A held request is allowed or denied, never answered in words (§D.2).
    ownWords: confirm === null && decisionKindOf(decision.id) !== "held",
    confirm,
    proposal: shown && proposal !== null ? `Orchestrator: ${shorten(proposal.reason, 200)}` : null,
  };
}

/** Who the asker of an askable decision is, in the card's words. */
function askerWord(decision: Decision): "Worker" | "Orchestrator" {
  return askableKindOf(decision.id) === "orchestrator" ? "Orchestrator" : "Worker";
}

/**
 * Ask back (change-014 outcome 3): the conversation of a `q:` or `o:`
 * decision, oldest first, and — while it can still be answered — the button,
 * the box, and the line under them. Null for a held request, a fallback
 * incident or an override (no asker to ask), and for a settled decision
 * nobody asked about.
 */
function askBackOf(decision: Decision, ui: DecisionUi, confirming: boolean, thread: DecisionThread | null, ask: AskUi): AskBackView | null {
  if (askableKindOf(decision.id) === null) return null;
  const asker = askerWord(decision);
  const entries = thread?.entries ?? [];
  const conversation = entries.map((entry, index) => ({ key: `${index}:${entry.at}`, who: entry.by === "owner" ? "You" : asker, text: entry.text }));
  const accessibilityLabel = `Ask the ${asker} a question before you decide`;
  if (!isAnswerable(decision)) return conversation.length === 0 ? null : { offered: false, accessibilityLabel, box: null, conversation, status: null };
  const box =
    ask.text === null || confirming
      ? null
      : { label: `Ask the ${asker}`, placeholder: `Ask the ${asker} before you decide…`, busy: ask.busy, sendEnabled: !ask.busy && ask.text.trim() !== "" };
  const waiting = thread !== null && hasOpenAsk(thread);
  const status: AskBackView["status"] =
    ask.error !== null
      ? { text: ask.error, tone: "danger" }
      : ask.busy
        ? { text: "Sending your question…", tone: "muted" }
        : waiting && ask.delivery === "failed"
          ? { text: ASK_NOT_DELIVERED, tone: "warning" }
          : waiting
            ? { text: `Waiting for the ${asker}…`, tone: "muted" }
            : null;
  return { offered: box === null && !confirming && ui.words === null, accessibilityLabel, box, conversation, status };
}

/**
 * When to read a decision's thread again: every `DECISION_POLL_MS` while the
 * decision can be answered and the owner's question waits for its reply;
 * otherwise not (an ask from this card refreshes it at once).
 */
export function threadPollMs(decision: Decision | null, thread: DecisionThread | null | undefined): number | false {
  if (decision === null || thread == null || !isAnswerable(decision)) return false;
  return hasOpenAsk(thread) ? DECISION_POLL_MS : false;
}

export type DecisionAskResult = { ok: true; thread: DecisionThread; delivery: "sent" | "queued" | "failed" } | { ok: false; reason: string };

/** One Ask back: ONE `decisions.ask` call; the decision stays open. */
export async function runDecisionAsk(input: {
  id: string;
  text: string;
  ask: (input: { id: string; text: string }) => Promise<{ thread: DecisionThread; delivery: "sent" | "queued" | "failed" }>;
}): Promise<DecisionAskResult> {
  const text = input.text.trim();
  if (text === "") return { ok: false, reason: "Write your question first." };
  try {
    const { thread, delivery } = await input.ask({ id: input.id, text });
    return { ok: true, thread, delivery };
  } catch (failure) {
    return { ok: false, reason: `Could not ask${codedReason(failure)}` };
  }
}

export type DecisionChoice = { optionKey: string } | { words: string };

export type DecisionActResult = { ok: true; decision: Decision } | { ok: false; reason: string };

/**
 * One answer: ONE `decisions.answer` call with the card's surface. `confirmed`
 * is passed only after the owner confirmed on the card.
 */
export async function runDecisionAnswer(input: {
  id: string;
  choice: DecisionChoice;
  confirmed: boolean;
  via: "inbox" | "chat-card";
  answer: (input: { id: string; optionKey?: string; words?: string; confirmed?: true; via: "inbox" | "chat-card" }) => Promise<{ decision: Decision }>;
}): Promise<DecisionActResult> {
  if ("words" in input.choice && input.choice.words.trim() === "") return { ok: false, reason: "Write your answer first." };
  try {
    const { decision } = await input.answer({
      id: input.id,
      ...("optionKey" in input.choice ? { optionKey: input.choice.optionKey } : { words: input.choice.words }),
      ...(input.confirmed ? { confirmed: true as const } : {}),
      via: input.via,
    });
    return { ok: true, decision };
  } catch (failure) {
    return { ok: false, reason: `Could not answer${codedReason(failure)}` };
  }
}

/** The owner's tap on a decision that needs confirmation: ONE `decisions.confirm` call. */
export async function runDecisionConfirm(input: {
  id: string;
  answered: boolean;
  confirm: (input: { id: string; answered: boolean }) => Promise<{ decision: Decision }>;
}): Promise<DecisionActResult> {
  try {
    const { decision } = await input.confirm({ id: input.id, answered: input.answered });
    return { ok: true, decision };
  } catch (failure) {
    return { ok: false, reason: `Could not ${input.answered ? "close" : "reopen"} the decision${codedReason(failure)}` };
  }
}
