/**
 * The decision card (experience concept §5.2): live from the decision store.
 * The same card in every chat and in the Inbox; answering anywhere shows
 * answered everywhere on the next read. Split from `chat-cards.ts` (code
 * review 2026-09-30 §4).
 *
 * Pure: no React, no React Native, no `server/` import.
 */
import type { ChatPeer } from "../shared/contracts";
import {
  decisionClassOf,
  decisionKindOf,
  declaredEffects,
  deliveryKindOf,
  effectsOfAnswer,
  isAnswerable,
  needsOwnerConfirmation,
  realEffects,
  type AnswerVia,
  type ChatVia,
  type Decision,
  type Effect,
  type Predictor,
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
  /** The recommended option is the one primary action; the others are secondary. */
  primary: boolean;
  /** Tapping it first asks for the confirmation (release, data, security, cost — X-4). */
  confirm: boolean;
  accessibilityLabel: string;
}

export interface DecisionCardView {
  frame: CardFrameView;
  /** The options, only while the decision is `open`. */
  options: DecisionButton[];
  /** "Own words…" offered: only while `open`. */
  ownWords: boolean;
  /** "Close as answered" / "Keep open", only while `needs-confirmation`. */
  confirmChat: boolean;
  /** The in-place confirmation, Cancel first; null when none is asked. */
  confirm: ConfirmDialog | null;
  details: string[];
}

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

/** Who decided a delegated class for the owner (autonomy design §B.5): the cell's predictor, in the card's words. */
const POLICY_PREDICTOR_WORDS: Readonly<Record<Predictor, string>> = {
  recommended: "recommended option",
  orchestrator: "the Orchestrator's choice",
};

/** The authority line of a decision the owner's policy answered (§B.5): "decided for you by the policy · recommended option". */
function policyAnsweredText(answer: NonNullable<Decision["answer"]>): string {
  return `decided for you by the policy · ${POLICY_PREDICTOR_WORDS[answer.predictor ?? "recommended"]}`;
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
  if (decision.answer !== null) {
    if (decision.answer.by === "orchestrator") lines.push("Answered by: the Orchestrator");
    if (decision.answer.by === "precedent") lines.push(`Answered by: your precedent ${decision.answer.precedentId ?? ""}`.trimEnd());
    if (decision.answer.by === "policy") {
      lines.push(`Answered by: your policy (${POLICY_PREDICTOR_WORDS[decision.answer.predictor ?? "recommended"]}${decision.answer.class === undefined ? "" : `, ${decision.answer.class} delegated`})`);
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
  const view: DecisionCardView = { frame, options: [], ownWords: false, confirmChat: false, confirm: null, details: decisionDetails(card, seed, decision) };

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
      const options = decision.options.map(
        (option): DecisionButton => {
          const effects = realEffects(option.effects);
          return {
            key: option.key,
            label: option.recommended ? `${option.label} ★` : option.label,
            primary: option.recommended,
            confirm: needsOwnerConfirmation(effects),
            accessibilityLabel: `Answer: ${option.label}${option.recommended ? " (recommended)" : ""}${effects.length === 0 ? "" : `; allows ${effectWords(effects)}`}`,
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
      const held = decisionKindOf(decision.id) === "held";
      return {
        ...view,
        frame: {
          ...frame,
          chip,
          tag: declared.length === 0 ? null : `effects: ${effectWords(declared)}`,
          body: decisionKindOf(decision.id) === "override" ? [OVERRIDE_CARD_LINE] : held ? [HELD_CARD_LINE] : [],
        },
        options: confirm === null && ui.words === null ? options : [],
        // A held request is allowed or denied, never answered in words (§D.2).
        ownWords: confirm === null && !held,
        confirm,
      };
    }
    case "needs-confirmation": {
      const where = decision.needsConfirmation === null ? "a chat" : CHAT_WORDS[decision.needsConfirmation.via];
      const at = decision.needsConfirmation === null ? "" : ` at ${localTimeText(new Date(decision.needsConfirmation.at), now)}`;
      return { ...view, frame: { ...frame, chip, body: [`You wrote in ${where}${at}. Did that answer it?`] }, confirmChat: true };
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
              ? policyAnsweredText(answer)
              : `answered by you${VIA_WHERE[answer.via]}`;
      return {
        ...view,
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
      return { ...view, frame: { ...frame, chip, body: [settledLine(decision) ?? ""].filter((line) => line !== "") } };
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
