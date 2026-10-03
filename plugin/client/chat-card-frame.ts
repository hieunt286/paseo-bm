/**
 * The frame every chat card but a decision is drawn in (`CardFrame`,
 * `ui.tsx`; experience concept §5.1), its time, what Details lists, and a
 * notice's compact line. Split from `chat-cards.ts` (code review 2026-09-30
 * §4).
 *
 * A finished card reads its request's finish from `traces.list`
 * (`verificationOfRequest`; autonomy design §C.3, §C.6): a finished-unverified
 * request's chip is "Finished — unverified" in the warning tone, and Details
 * list each check, file and bead with its label. A request that is not
 * checked, or whose finish is not known yet, reads "Finished" as before.
 *
 * Pure: no React, no React Native, no `server/` import.
 */
import { COORDINATION_HANDOFF_AUTHORITY, RETIRED_AUTOPILOT, decisionIdOfAuthority, policyClassOfAuthority, type CommandBlock } from "../shared/orchestrator-command";
import type { ChatPeer, TraceSummary, TraceVerification } from "../shared/contracts";
import { soleWorkerOf } from "../shared/sole-worker";
import { MAX_BODY_LINES, meaningfulLines, type ChatCard, type ReportFacts } from "./chat-card-parse";
import { actorName, markOf, ownerWarning, partiesOf, party } from "./chat-card-parties";
import { ago, localTimeText } from "./format";
import { kindBarTone, type Badge, type RoleMarkKind, type Tone } from "./tone";
import { plural, shorten } from "../shared/text";
import { FINISHED_UNVERIFIED_CHIP, isShownVerification, verificationDetailLines } from "./verification-view";

/** Everything `CardFrame` draws above the actions (experience concept §5.1). */
export interface CardFrameView {
  actor: { mark: RoleMarkKind | null; name: string };
  /** Who it is for; null when the card has no one in particular. */
  recipient: string | null;
  /** `your answer 14:02`, `Policy · scope`, …; null for a plain report. */
  authority: string | null;
  time: string;
  /** The one status chip, or none. */
  chip: Badge | null;
  title: string;
  /** A neutral tag on the title line (tier, effects, grant); null for none. */
  tag: string | null;
  /** At most `MAX_BODY_LINES`. */
  body: string[];
  /**
   * The tone the card is outlined in, or null for none. Drawn as the kind
   * bar (`kindBarOf`), never as a coloured border (change-014 outcome 6).
   */
  outline: Tone | null;
  /**
   * The 3 px bar at the card's left that marks its kind, or null for none.
   * Absent: derived from the outline, then the chip (`kindBarOf`).
   */
  bar?: Tone | null;
  /**
   * The card's kind at the right of its meta line, in small mono capitals and
   * the kind's colour (`DECISION · SCOPE`; change-014 mockup); absent or null
   * for none.
   */
  label?: { text: string; tone: Tone } | null;
  /** The 16px icon at the left of the meta line, a Lucide name; absent: the actor's role icon. */
  icon?: string | null;
  /** One line under the actions: an outcome or an error. */
  status: { text: string; tone: Tone } | null;
}

/**
 * The tone of a card's kind bar: its own `bar` when set, else the first of its
 * outline and its chip that marks a kind (`kindBarTone`). A settled card has
 * none.
 */
export function kindBarOf(view: Pick<CardFrameView, "bar" | "outline" | "chip">): Tone | null {
  if (view.bar !== undefined) return view.bar;
  return kindBarTone(view.outline) ?? kindBarTone(view.chip?.tone ?? null);
}

/** The dot that opens a compact line. */
export const NOTICE_DOT = "●";

/** A notice's compact line after its dot: `<project> · <what happened> — <gist> · <time ago>`; unknown parts are left out. */
export function noticeLine(card: ChatCard, at: Date, now: Date): string {
  const notice = card.notice;
  if (notice === null) return card.gist;
  const when = Number.isNaN(at.getTime()) ? "—" : ago(at.toISOString(), now);
  const what = card.gist === "" ? notice.what : `${notice.what} — ${card.gist}`;
  return [notice.project, what, when === "—" ? null : when].filter((part) => part !== null).join(" · ");
}

/** A value that opens with "none" says nothing: the readers' rule (`blocksCompletion`, the trace). */
function isNoneLike(text: string | null): boolean {
  return text === null || /^\s*none\b/i.test(text);
}

const PHASE_WORDS: Readonly<Record<string, { chip: Badge; title: string }>> = {
  received: { chip: { text: "Received", tone: "info" }, title: "Request received" },
  "documents-done": { chip: { text: "Working", tone: "info" }, title: "Documents done" },
  "beads-done": { chip: { text: "Working", tone: "info" }, title: "Beads planned" },
  "bead-implemented": { chip: { text: "Working", tone: "info" }, title: "A bead is done" },
  blocked: { chip: { text: "Blocked", tone: "warning" }, title: "Blocked" },
  // Design §16.11: a bound Worker's report on a stop; not finished, not blocked.
  stopped: { chip: { text: "Stopped", tone: "warning" }, title: "Stopped" },
};

function beadsLine(report: ReportFacts): string | null {
  const parts = [
    report.beads.created > 0 ? `${report.beads.created} created` : null,
    report.beads.updated > 0 ? `${report.beads.updated} updated` : null,
    report.beads.closed > 0 ? `${report.beads.closed} closed` : null,
  ].filter((part) => part !== null);
  return parts.length === 0 ? null : `Beads: ${parts.join(", ")}`;
}

/** Longest `blockers` text on a body line: the whole text is in Details. */
export const BODY_BLOCKERS_CHARS = 160;

function withIssues(card: ChatCard, lines: Array<string | null>): string[] {
  const kept = lines.filter((line): line is string => line !== null && line !== "");
  if (card.formatIssues.length === 0) return kept.slice(0, MAX_BODY_LINES);
  // The template problem always shows: it takes the last line.
  return [...kept.slice(0, MAX_BODY_LINES - 1), "This message breaks its template: see Details."];
}

const VERDICT_CHIP = (verdict: string | null): Badge | null => {
  if (verdict === null) return null;
  const text = verdict.toLowerCase();
  if (/pass|approved/.test(text)) return { text: "Passed", tone: "success" };
  if (/changes/.test(text)) return { text: "Changes required", tone: "warning" };
  if (/stopped/.test(text)) return { text: "Stopped", tone: "muted" };
  return { text: verdict, tone: "muted" };
};

const INTENT_CHIP: Readonly<Record<string, Badge>> = {
  answer: { text: "Answer", tone: "info" },
  continue: { text: "Continue", tone: "info" },
  redirect: { text: "Redirect", tone: "warning" },
  stop: { text: "Stop", tone: "warning" },
  release: { text: "Release", tone: "warning" },
  handoff: { text: "Handoff", tone: "info" },
  other: { text: "Command", tone: "info" },
};

/**
 * On whose authority a command went, in words (autonomy design §A.7, §B.9); a
 * version 1 block says how it left. A block of Phase 1 history sent on a
 * project's Autopilot, retired since (§B.8), says so. A handoff goes on the
 * owner's Settings → Coordination switch (§G.6): "Coordination · handoff".
 */
export function commandAuthorityText(command: CommandBlock): string {
  const retired = "Autopilot (retired)";
  if (command.authority === COORDINATION_HANDOFF_AUTHORITY) return "Coordination · handoff";
  if (command.authority === null) return command.via === RETIRED_AUTOPILOT ? retired : command.via === "tab" ? "from the tab" : "approved in chat";
  if (command.authority === RETIRED_AUTOPILOT) return retired;
  if (command.authority === "owner") return command.via === "tab" ? "your command" : "your word in chat";
  const delegated = policyClassOfAuthority(command.authority);
  if (delegated !== null) return `Policy · ${delegated}`;
  return "your decision";
}

/** A command's effects as its tag: `no effects`, or the effects it may have, with how many are approved. */
export function commandEffectsText(command: CommandBlock): string | null {
  if (command.version === 1) return null;
  if (command.effects.length === 0) return "no effects";
  return command.approved.length === 0 ? `effects: ${command.effects.join(", ")}` : `approved: ${command.approved.join(", ")}`;
}

/**
 * The Worker a `to: worker` command is for, as its card names it, or null (a
 * Manager's command, or no single Worker fits). In a Worker's own chat it is
 * the chat's agent.
 */
export function commandWorkerName(card: ChatCard, owner: ChatPeer | null, peers: readonly ChatPeer[]): string | null {
  const command = card.command;
  if (command === null || command.to !== "worker") return null;
  const peer = !command.copy && owner?.role === "worker" ? owner : soleWorkerOf(peers, command.requestId);
  return peer === null ? null : actorName(party(peer, "worker"));
}

/** The command's body without its `BM-ANSWERS` block, as up to `limit` plain lines. */
function commandBodyLines(command: CommandBlock, limit: number): string[] {
  return meaningfulLines(command.body, false).slice(0, limit);
}

export interface FrameContext {
  owner: ChatPeer | null;
  peers: readonly ChatPeer[];
  /** The message's time in the timeline. */
  at: Date;
  now: Date;
  /** A finished card's request's finish (`verificationOfRequest`); absent or null while not known. */
  verification?: TraceVerification | null;
}

/**
 * The finish of the request a card names, from `traces.list` rows (autonomy
 * design §C.6: the card reads it by its request); null when the card names
 * none, or no row of that request carries one.
 */
export function verificationOfRequest(rows: ReadonlyArray<Pick<TraceSummary, "requestId" | "verification">> | undefined, requestId: string | null): TraceVerification | null {
  if (requestId === null || rows === undefined) return null;
  return rows.find((row) => row.requestId === requestId && row.verification !== undefined)?.verification ?? null;
}

/** The frame of every card but `decision` (`decisionCardView`) and `notice` (`noticeLine`). */
export function cardFrameOf(card: ChatCard, context: FrameContext): CardFrameView {
  const { from, to } = partiesOf(card, context.owner, context.peers);
  const frame: CardFrameView = {
    actor: { mark: markOf(from.role), name: actorName(from) },
    recipient: actorName(to),
    authority: null,
    time: localTimeText(context.at, context.now),
    chip: null,
    title: card.gist,
    tag: null,
    body: [],
    outline: null,
    status: null,
  };
  switch (card.type) {
    case "progress": {
      const report = card.report!;
      const words = report.phase === null ? null : (PHASE_WORDS[report.phase] ?? null);
      const lead = card.gist;
      return {
        ...frame,
        chip: words?.chip ?? { text: "Working", tone: "info" },
        title: words?.title ?? "Progress",
        tag: report.tier,
        body: withIssues(card, [
          lead,
          beadsLine(report),
          isNoneLike(report.blockers) ? null : `Waiting on: ${shorten(report.blockers!, BODY_BLOCKERS_CHARS)}`,
        ]),
      };
    }
    case "finished": {
      const report = card.report!;
      const changed = [
        report.filesChanged > 0 ? `${plural(report.filesChanged, "file")} changed` : null,
        report.beads.closed > 0 ? `${plural(report.beads.closed, "bead")} closed` : null,
      ].filter((part) => part !== null);
      // Autonomy design §C.3: a finished-unverified request says so, in the warning tone.
      const unverified = isShownVerification(context.verification) && context.verification.unverified;
      return {
        ...frame,
        chip: unverified ? { text: FINISHED_UNVERIFIED_CHIP, tone: "warning" } : { text: "Finished", tone: "success" },
        title: card.gist || "Request finished",
        tag: report.tier,
        outline: unverified ? "warning" : "success",
        body: withIssues(card, [
          changed.length === 0 ? null : changed.join(" · "),
          isNoneLike(report.checks) ? null : `Checks: ${shorten(report.checks!, 120)}`,
          report.decided > 0 ? `Decided on its own: ${report.decided} (see Details)` : null,
        ]),
      };
    }
    case "verdict": {
      const review = card.review!;
      const blocking = review.blocking;
      return {
        ...frame,
        chip: VERDICT_CHIP(review.verdict),
        title: card.gist || "Review verdict",
        body: withIssues(card, [blocking === null ? null : blocking === 0 ? "No blocking findings" : `${plural(blocking, "blocking finding")}`]),
      };
    }
    case "brief": {
      const lines = meaningfulLines(card.text, false);
      return { ...frame, title: lines[0] ?? card.gist, body: withIssues(card, lines.slice(1, 1 + MAX_BODY_LINES)) };
    }
    case "action": {
      const command = card.command!;
      const recipient = command.to === "manager" ? "Manager" : (commandWorkerName(card, context.owner, context.peers) ?? "Worker");
      return {
        ...frame,
        actor: command.from === "orchestrator" ? { mark: "orchestrator", name: "Orchestrator" } : { mark: null, name: "You" },
        recipient,
        authority: commandAuthorityText(command),
        chip: command.intent === null ? null : (INTENT_CHIP[command.intent] ?? null),
        title: command.re,
        tag: commandEffectsText(command),
        body: withIssues(card, [...commandBodyLines(command, command.why === null ? MAX_BODY_LINES : MAX_BODY_LINES - 1), command.why === null ? null : `Why: ${command.why}`]),
      };
    }
    default:
      return frame;
  }
}

/**
 * What Details lists above the whole message: the ids and the machine facts,
 * never on the card's face — for a finished card, its request's checks, files
 * and beads with their labels (`verification`, autonomy design §C.3).
 */
export function detailLinesOf(card: ChatCard, owner: ChatPeer | null, verification: TraceVerification | null = null): string[] {
  const lines: string[] = [];
  const warning = ownerWarning(owner);
  if (warning !== null) lines.push(warning);
  if (card.requestId !== null) lines.push(`Request: ${card.requestId}`);
  if (card.review?.batchId != null) lines.push(`Batch: ${card.review.batchId}`);
  if (card.review?.verdict != null) lines.push(`Verdict: ${card.review.verdict}`);
  if (card.report !== null && card.report.phase !== null) lines.push(`Phase: ${card.report.phase}`);
  if (card.type === "finished" && isShownVerification(verification)) lines.push(...verificationDetailLines(verification));
  const command = card.command;
  if (command !== null) {
    lines.push(`From: ${command.from} · via: ${command.via} · to: ${command.to}`);
    if (command.intent !== null) lines.push(`Intent: ${command.intent}`);
    if (command.version === 2) lines.push(`Effects: ${command.effects.join(", ") || "none"} · approved: ${command.approved.join(", ") || "none"}`);
    if (command.authority !== null) lines.push(`Authority: ${command.authority}`);
    const decisionId = decisionIdOfAuthority(command.authority);
    if (decisionId !== null) lines.push(`Decision: ${decisionId}`);
    if (command.limits.length > 0) lines.push(`Limits: ${command.limits.join(", ")}`);
  }
  if (card.formatIssues.length > 0) {
    lines.push("This message breaks the template:");
    lines.push(...card.formatIssues.map((issue) => `• ${issue}`));
  }
  return lines;
}
