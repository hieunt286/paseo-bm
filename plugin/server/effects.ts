/**
 * Effects stated by what was done (delivery line design §7.3; ADR-035
 * decision 6; REQ-213 d): every sentence a tool, card or notice gives about
 * an effect comes from one function here, built from the record that was
 * written — the stored answer, its grant, the delivery, the change's result,
 * the arbitration — never from what the caller meant to do.
 *
 * - Each function returns `{ applied, sentence }`: `applied` is what was done
 *   (`EffectRecord`), null when nothing was; the sentence says so either way.
 * - `answerEffect`, `citedAnswerEffect`: an answer, as its answerer and as
 *   the Worker that receives it read it; `grantEffect`: the grant it carries.
 * - `changeEffect`: a prepared change of the owner's settings — applied,
 *   already so, written but inert, or failed; `missionCardEffect`: an `m:`
 *   card's change on the owner's tap.
 * - `deliveryEffect`, `commandDeliveryEffect`, `incidentActionEffect`: a
 *   delivery — delivered, queued, held, dropped, nothing sent;
 *   `noTurnEffect`: a message that starts no turn.
 * - `recommendationEffect`: a Main's recommendation; `arbitrationEffect`: an
 *   arbitration recorded, or a standing one returned.
 * - `nothingWas`, `nothingWasSentence`: the clause of a refusal or a repeat,
 *   which writes and sends nothing.
 *
 * `test/effects-guard.test.ts` keeps the modules of §7.3 from building such
 * a sentence themselves. Pure: no I/O.
 */
import type { Decision, DecisionDelivery, Effect } from "../shared/decisions";
import type { PreparedChangeResult } from "./prepared-changes";

/** What was done, as written. */
export type EffectRecord =
  | { kind: "answer"; decisionId: string; by: string; optionKey: string | null }
  | { kind: "grant"; decisionId: string; effects: Effect[]; expiresAt: string; usedAt: string | null }
  | { kind: "change"; text: string; wrote: boolean; inert?: string }
  | { kind: "mission-change"; decisionId: string }
  | { kind: "delivery"; to: string; outcome: "sent" | "queued" | "held" | "no-turn" }
  | { kind: "recommendation"; decisionId: string; optionKey: string }
  | { kind: "arbitration"; arbitrationId: string; at: string };

/** One effect: what was done (null: nothing), and the sentence that says it. */
export interface EffectStatement<R extends EffectRecord = EffectRecord> {
  applied: R | null;
  sentence: string;
}

/** The clause of a refusal or a repeat: `nothing was <what>`. */
export function nothingWas(what: string): string {
  return `nothing was ${what}`;
}

/** The same as a sentence of its own: `Nothing was <what>.` */
export function nothingWasSentence(what: string): string {
  return `Nothing was ${what}.`;
}

/** `Qn` of `q:<requestId>:<Qn>`. */
function questionIdOf(decisionId: string): string {
  return decisionId.slice(decisionId.lastIndexOf(":") + 1);
}

// ---------------------------------------------------------------------------
// Answers and grants.
// ---------------------------------------------------------------------------

/** The grant the stored decision carries: none (the Main's answer, an `o:` answer, an option without effects), or its effects and hour. */
export function grantEffect(decision: Pick<Decision, "id" | "grant">): EffectStatement<Extract<EffectRecord, { kind: "grant" }>> {
  const grant = decision.grant;
  if (grant === null) return { applied: null, sentence: "it grants nothing" };
  const applied = { kind: "grant" as const, decisionId: decision.id, effects: [...grant.effects], expiresAt: grant.expiresAt, usedAt: grant.usedAt };
  return {
    applied,
    sentence:
      grant.usedAt === null
        ? `it grants ${grant.effects.join(", ")} for one use until ${grant.expiresAt}`
        : `its grant of ${grant.effects.join(", ")} was used at ${grant.usedAt}`,
  };
}

/** What the delivery recorded on an answered question says, in the answerer's words, for `as` ("your answer, not the owner's"). */
function answerDeliveryText(delivery: DecisionDelivery | null, as: string): string {
  switch (delivery?.outcome) {
    case "sent":
      return `delivered to the Worker as ${as}`;
    case "queued":
      return `queued for the Worker as ${as}: it gets it when its current turn ends`;
    case "failed":
      return `recorded as ${as}, but not delivered to the Worker (the owner sees that in the Inbox)`;
    case "held":
      return `recorded as ${as}; held for the Worker: it gets it with what it waits on (delivery line design §6.4)`;
    default:
      return `recorded as ${as}; not delivered to the Worker yet`;
  }
}

/**
 * An answer as its answerer reads it (`bm_answer_worker`), from the stored
 * decision: whether it was recorded, what its delivery recorded, and its
 * grant. `as` names whose answer it is.
 */
export function answerEffect(decision: Pick<Decision, "id" | "status" | "answer" | "grant" | "delivery">, as: string): EffectStatement {
  const answer = decision.answer;
  if (decision.status !== "answered" || answer === null) return { applied: null, sentence: nothingWas("answered") };
  return {
    applied: { kind: "answer", decisionId: decision.id, by: answer.by, optionKey: answer.optionKey },
    sentence: `${answerDeliveryText(decision.delivery, as)}; ${grantEffect(decision).sentence}`,
  };
}

/**
 * The line a Worker's `BM-ANSWERS` message cites above the block for an
 * answer that is not the owner's own word: an owner precedent's (autonomy
 * design §B.6) or the mission's Main's (missions design §4), with the grant
 * the stored answer carries. Null for any other answer, which reads as the
 * owner's.
 */
export function citedAnswerEffect(decision: Pick<Decision, "id" | "subject" | "answer" | "grant">): EffectStatement | null {
  const answer = decision.answer;
  if (answer === null) return null;
  const qn = questionIdOf(decision.id);
  const applied: EffectRecord = { kind: "answer", decisionId: decision.id, by: answer.by, optionKey: answer.optionKey };
  if (answer.by === "precedent") {
    const subject = decision.subject === null ? "" : ` on "${decision.subject}"`;
    return { applied, sentence: `${qn} was answered by the owner's precedent ${answer.precedentId ?? ""}${subject}: it is the owner's standing answer.` };
  }
  if (answer.by === "main") {
    const grant = grantEffect(decision);
    const reason = answer.reason === undefined ? "" : ` (${answer.reason})`;
    return { applied, sentence: `${qn} was answered by your mission's Main, not the owner${reason}: ${grant.sentence}${grant.applied === null ? " beyond your rules" : ""}.` };
  }
  return null;
}

/** A Main's recommendation on a question the owner decides, as stored (`prediction.main`). */
export function recommendationEffect(decision: Pick<Decision, "id" | "prediction">): EffectStatement {
  const main = decision.prediction?.main ?? null;
  if (main === null) return { applied: null, sentence: nothingWas("recorded") };
  return { applied: { kind: "recommendation", decisionId: decision.id, optionKey: main.optionKey }, sentence: "recorded as your recommendation; the owner decides it" };
}

// ---------------------------------------------------------------------------
// Changes.
// ---------------------------------------------------------------------------

/**
 * A prepared change of the owner's settings, from what `applyPreparedChange`
 * wrote — applied, already so (nothing written), written but inert (a
 * precedent no question can match, delivery line design §7.4), or not
 * applied: the `change:` line of the Orchestrator's `BM-ANSWER`
 * (`for: "agent"`), or the daemon log line of `decisionId` (`for: "log"`).
 */
export function changeEffect(result: PreparedChangeResult, audience: { for: "agent" } | { for: "log"; decisionId: string }): EffectStatement {
  if (!result.applied) {
    return {
      applied: null,
      sentence:
        audience.for === "agent"
          ? `not applied (${result.reason}); ${nothingWas("changed")} — tell the owner, and set nothing yourself`
          : `[paseo-bm] decision ${audience.decisionId}: the owner's answer could not apply its change (${result.reason}); ${nothingWas("changed")}`,
    };
  }
  const applied: EffectRecord = { kind: "change", text: result.text, wrote: result.wrote, ...(result.inert === undefined ? {} : { inert: result.inert }) };
  if (result.inert !== undefined) {
    return {
      applied,
      sentence:
        audience.for === "agent"
          ? `written, but it answers nothing (${result.inert}) — it ${result.text}; tell the owner, and set nothing yourself`
          : `[paseo-bm] decision ${audience.decisionId}: the owner's answer wrote its change, but it answers nothing (${result.inert}): it ${result.text}`,
    };
  }
  return {
    applied,
    sentence:
      audience.for === "agent"
        ? `applied by the plugin — it ${result.text}${result.wrote ? "" : " (it was so already)"}; send nothing for it`
        : `[paseo-bm] decision ${audience.decisionId}: the owner's answer ${result.wrote ? "applied" : "found already applied"}: it ${result.text}`,
  };
}

/**
 * The owner's tap on "apply" of an `m:` card, from the mission store's
 * result: what the Main is told (`sentence`) and the journal line. `card`
 * names the card for the Main ("your card", "the governor's card"); on
 * success, `journal` and `main` say what it set.
 */
export function missionCardEffect(
  decisionId: string,
  card: string,
  result: { ok: true; journal: string; main: string } | { ok: false; reasons: readonly string[] },
): EffectStatement & { journal: string } {
  if (!result.ok) {
    const reasons = result.reasons.join("; ");
    return { applied: null, sentence: `The owner chose to apply ${card} ${decisionId}, but it could not be applied: ${reasons}.`, journal: `${decisionId} could not be applied: ${reasons}` };
  }
  return {
    applied: { kind: "mission-change", decisionId },
    sentence: `The owner applied ${card} ${decisionId}: ${result.main}.`,
    journal: `The owner applied ${decisionId}: ${result.journal}.`,
  };
}

// ---------------------------------------------------------------------------
// Deliveries.
// ---------------------------------------------------------------------------

/** A delivery's outcome as the queue or the store gives it; `replaced` waits in the queue as `queued` does; null: nothing was sent. */
export type DeliveryOutcome = "sent" | "queued" | "replaced" | "held" | "dropped" | "failed";

/**
 * A delivery of `what` to `to`, from its outcome: delivered, queued (until
 * the turn ends), held (until what the recipient waits for is settled),
 * dropped or failed (with `why`), or nothing sent (`outcome` null).
 */
export function deliveryEffect(input: { what: string; to?: string; outcome: DeliveryOutcome | null; why?: string }): EffectStatement {
  const to = input.to ?? "its agent";
  switch (input.outcome) {
    case null:
      return { applied: null, sentence: `${nothingWas("sent")}${input.to === undefined ? "" : ` to ${input.to}`}` };
    case "failed":
    case "dropped":
      return { applied: null, sentence: `${input.what} was not delivered${input.why === undefined ? "" : ` (${input.why})`}; ${nothingWas("sent")}` };
    case "sent":
      return { applied: { kind: "delivery", to, outcome: "sent" }, sentence: `${input.what} was delivered to ${to}` };
    case "queued":
    case "replaced":
      return { applied: { kind: "delivery", to, outcome: "queued" }, sentence: `${input.what} is queued: ${to} gets it when its current turn ends` };
    case "held":
      return { applied: { kind: "delivery", to, outcome: "held" }, sentence: `${input.what} is held: ${to} gets it once what it waits for is settled` };
  }
}

/**
 * A message that starts no turn (delivery line design §9.1: an `ack` or a
 * `close`), from its stored record: delivered as it was stored, read by `to`
 * in its `BM-STATE` and at the head of its next delivery.
 */
export function noTurnEffect(input: { what: string; to: string }): EffectStatement {
  return {
    applied: { kind: "delivery", to: input.to, outcome: "no-turn" },
    sentence: `${input.what} was delivered to ${input.to} without starting a turn: it reads it in its BM-STATE and at the head of its next delivery`,
  };
}

/** The prepared command of an option an owner precedent chose at once (`bm_ask_owner`), from the delivery recorded on the decision. */
export function commandDeliveryEffect(delivery: DecisionDelivery | null): EffectStatement {
  switch (delivery?.outcome) {
    case "sent":
      return { applied: { kind: "delivery", to: delivery.to, outcome: "sent" }, sentence: `The plugin delivered the option's command to ${delivery.to}, with the owner's authority.` };
    case "queued":
      return {
        applied: { kind: "delivery", to: delivery.to, outcome: "queued" },
        sentence: `The plugin queued the option's command for ${delivery.to}, with the owner's authority: it gets it when its current turn ends.`,
      };
    case "failed":
      return { applied: null, sentence: "The plugin could not deliver the option's command; a BM-ANSWER tells you why." };
    default:
      return { applied: null, sentence: "The option's command is not delivered yet; bm_decisions shows its delivery." };
  }
}

/** The option's action on a fallback incident the Orchestrator decided (`bm_decide`), from the delivery recorded on the decision. */
export function incidentActionEffect(delivery: DecisionDelivery | null): EffectStatement {
  switch (delivery?.outcome) {
    case "sent":
      return { applied: { kind: "delivery", to: delivery.to, outcome: "sent" }, sentence: "The plugin ran the option's action on the incident." };
    case "queued":
      return { applied: { kind: "delivery", to: delivery.to, outcome: "queued" }, sentence: `The option's action is queued: ${delivery.to} gets it when its current turn ends.` };
    case "failed":
      return { applied: null, sentence: "The plugin could not run the option's action; the owner sees that in the Inbox." };
    default:
      return { applied: null, sentence: "The option's action has not run yet; bm_decisions shows its delivery once it has." };
  }
}

// ---------------------------------------------------------------------------
// Arbitrations.
// ---------------------------------------------------------------------------

/**
 * `bm_arbitrate`'s first line: an arbitration that stands already (delivery
 * line design §8.2: returned, nothing written, sent or spent), or the one just
 * recorded, with what each Main was told (`told`) and the owner's card.
 */
export function arbitrationEffect(
  input:
    | { standing: { id: string; at: string }; area: string; ownerCode: string }
    | { recorded: { id: string; at: string; decisionId: string | null }; area: string; workspaceId: string; ownerCode: string; loserCode: string; told: readonly string[] },
): EffectStatement {
  if ("standing" in input) {
    return { applied: null, sentence: `Area ${input.area} was arbitrated as ${input.standing.id} on ${input.standing.at.slice(0, 10)} (owner: ${input.ownerCode}); ${nothingWas("sent")}.` };
  }
  const { recorded } = input;
  return {
    applied: { kind: "arbitration", arbitrationId: recorded.id, at: recorded.at },
    sentence: `Arbitration ${recorded.id} recorded: ${input.area} in ${input.workspaceId} belongs to mission ${input.ownerCode}; ${input.told.join("; ")}.${
      recorded.decisionId === null ? "" : ` The owner is asked on card ${recorded.decisionId} to change mission ${input.loserCode}'s goal.`
    }`,
  };
}
