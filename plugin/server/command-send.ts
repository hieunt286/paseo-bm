/**
 * The one way a command of the Orchestrator's leaves (Orchestrator design §6A,
 * §6B.1, §6B.4; autonomy design §A.6, §A.7; code review 2026-09-30 §2.1,
 * §3.3): `bm_send_command`, `bm_direct_worker` and the delivery of the
 * prepared command of an option chosen by the owner, the owner's policy or an
 * owner precedent (`orchestrator-decisions.ts`) all call `sendCommand`.
 *
 * The caller checks its target (a live paseo-bm Manager or Worker of the
 * project) and the authority, and builds the block. Then, in this order:
 *
 * 1. **Checks, before anything leaves:** the block can be written; the
 *    backstop, for a command the Orchestrator sends itself (a prepared
 *    command's text was checked against its effects when it was asked,
 *    `bm_ask_owner`); the loop guard (`commandsSentFor`: at most 12 commands
 *    for one request — or one project, without a request — in 24 hours,
 *    whichever way they went); an interrupt only while the Worker's danger
 *    allowance is open; a handoff (`coordination:handoff`, autonomy design
 *    §G.6) only while the owner's Settings → Coordination has handoff on. A
 *    refusal sends, records and spends nothing.
 * 2. **The grant is claimed** (`claimGrant`), so two sends never spend one.
 * 3. **Delivered** through the notice queue (`command:<id>`, or the kind the
 *    caller names), or — an interrupt — sent at once. A target that cannot be
 *    reached gives the claim back and records nothing.
 * 4. **Once delivered:** the grant is spent (`spendGrant`); the command is
 *    appended to the commands store (`proposals.json`, source `chat`, its
 *    secrets masked) under
 *    its id, which is what the loop guard counts; the intervention it is, if
 *    any, is logged with that id (`interventionOfCommand`); a Worker's Manager
 *    gets the `copy: yes` block through the queue.
 *
 * The loop guard counts every delivered command. It refuses every one but the
 * prepared command of the owner's own answer, which it counts and never
 * refuses: the owner is who its refusal sends the Orchestrator to.
 *
 * Nothing after delivery fails the send: a grant that cannot be marked used,
 * a record or an intervention that cannot be written, and a copy that cannot
 * be delivered are reported in the result or as one log line.
 */
import { randomUUID } from "node:crypto";
import { redactText } from "./collector";
import { createDecisionStore } from "./decision-store";
import type { BmEvent } from "./event-bus";
import { interventionOfCommand, recordIntervention } from "./intervention-store";
import { noticeQueue, type NoticePaseo, type NoticeQueue } from "./notice-queue";
import { commandKindOf } from "./orchestrator-state";
import { createOrchestratorStore, type OrchestratorStoreDeps } from "./orchestrator-store";
import { undeclaredCategoriesOf, undeclaredRefusalOf } from "../shared/decision-gate";
import { useGrant, type Effect } from "../shared/decisions";
import { isSentCommand, type Proposal } from "../shared/orchestrator";
import { COORDINATION_HANDOFF_AUTHORITY, commandBlockOf, commandInputProblems, commandOf, type CommandInput } from "../shared/orchestrator-command";
import { readCoordinationSettings } from "./coordination-rpc";
import { errorText } from "./rpc-kit";
import { timeOrZero } from "../shared/time";

/** The loop guard (Orchestrator design §6A): at most this many commands the Orchestrator sends for one request … */
export const COMMAND_LIMIT_PER_REQUEST = 12;
/** … within this many hours. */
export const COMMAND_LIMIT_WINDOW_HOURS = 24;
/** Why a command was refused at the loop guard (design §6A). */
export const COMMAND_LIMIT_MESSAGE = `you sent ${COMMAND_LIMIT_PER_REQUEST} commands for this request in ${COMMAND_LIMIT_WINDOW_HOURS} hours; ask the owner with bm_ask_owner`;

/** Why `bm_direct_worker` refused an interrupt (design §6B.4, ADR-016 decision 2). */
export const INTERRUPT_REFUSED_MESSAGE =
  "interrupt is allowed only while a danger signal of this Worker is open; send it without interrupt, and the Worker gets it when its turn ends";

/** Why a handoff was refused at the send (autonomy design §G.6, change-008 C3): its authority is the owner's switch. */
export const HANDOFF_OFF_MESSAGE = "handoff is off in the owner's Settings → Coordination; only the owner turns it on";

/**
 * How many commands the Orchestrator's commands store holds (`isSentCommand`:
 * source `chat`, or `autopilot` from before Phase 2) for this request — or,
 * with no request id, for this project without a request — in the 24 hours
 * before `now` (design §6A). Every delivered command is there, whichever way
 * it went. Pure.
 */
export function commandsSentFor(
  commands: readonly Proposal[],
  workspaceId: string,
  requestId: string | null,
  now: Date,
): number {
  const since = now.getTime() - COMMAND_LIMIT_WINDOW_HOURS * 3_600_000;
  return commands.filter(
    (entry) =>
      isSentCommand(entry) &&
      entry.workspaceId === workspaceId &&
      entry.requestId === requestId &&
      timeOrZero(entry.settledAt ?? entry.at) > since,
  ).length;
}

/** True when the loop guard has no room left for this request (or project) now. Reads only. */
export function loopGuardFull(home: string, workspaceId: string, requestId: string | null, now: Date, store: OrchestratorStoreDeps = {}): boolean {
  return commandsSentFor(createOrchestratorStore(home, store).listCommands(), workspaceId, requestId, now) >= COMMAND_LIMIT_PER_REQUEST;
}

// ---------------------------------------------------------------------------
// The grant a command spends.
// ---------------------------------------------------------------------------

/** Decisions whose grant a command in flight is spending, so two sends never spend one (the store takes no lock). */
const grantsInFlight = new Set<string>();

/** True while a command in flight is spending the grant of `decisionId`. */
export function grantInFlight(decisionId: string): boolean {
  return grantsInFlight.has(decisionId);
}

/**
 * Marks the grant `decisionId` as being spent; returns what gives it back
 * when the command is not delivered, or null when another send already is
 * spending it. Synchronous, so no other call can come between the check and
 * the mark.
 */
function claimGrant(decisionId: string | null): (() => void) | null {
  if (decisionId === null) return () => {};
  if (grantsInFlight.has(decisionId)) return null;
  grantsInFlight.add(decisionId);
  return () => grantsInFlight.delete(decisionId);
}

/**
 * Spends the grant of `decisionId` on a delivered command (`useGrant`, one
 * use); null when done, else what went wrong. A grant that could not be
 * marked used stays claimed in this run of the plugin, so it is not spent twice.
 */
function spendGrant(decisionId: string | null, workspaceId: string, effects: readonly Effect[], home: string, now: Date): string | null {
  if (decisionId === null) return null;
  let problem: string;
  try {
    const result = createDecisionStore(home).transition(decisionId, (decision) => useGrant(decision, { effects, at: now.toISOString() }), workspaceId);
    if (result.status === "updated") {
      grantsInFlight.delete(decisionId);
      return null;
    }
    problem = result.status === "refused" ? result.message : `decision ${decisionId} is gone`;
  } catch (error) {
    problem = errorText(error);
  }
  return `The plugin could not mark the grant of decision ${decisionId} as used (${problem}); do not use it again.`;
}

// ---------------------------------------------------------------------------
// Who gets the copy.
// ---------------------------------------------------------------------------

/** The agent facts `copyRecipientOf` reads (`workingAgents` in `orchestrator-tool-context.ts` gives them). */
export interface CommandAgent {
  id: string;
  role: string;
  workspaceId: string | null;
  archived: boolean;
}

/**
 * Who gets the `copy: yes` block of a command to a Worker (ADR-016 decision
 * 2): the Worker's own Manager — the agent that created it — when that is a
 * non-archived paseo-bm Manager of the project; else null.
 */
export function copyRecipientOf<A extends CommandAgent>(agents: readonly A[], worker: { parentAgentId: string | null }, workspaceId: string): A | null {
  return agents.find((agent) => agent.id === worker.parentAgentId && agent.role === "manager" && !agent.archived && agent.workspaceId === workspaceId) ?? null;
}

// ---------------------------------------------------------------------------
// The pipeline.
// ---------------------------------------------------------------------------

/** A command of the Orchestrator's, ready to leave: the caller checked its target and its authority. */
export interface CommandSend {
  /** The data folder. */
  home: string;
  now: Date;
  paseo: NoticePaseo;
  workspaceId: string;
  /** The block (`from: orchestrator`); `to` names the target's role. */
  command: CommandInput;
  /** The Manager or Worker it goes to. */
  targetId: string;
  /** A Worker's Manager, who gets the `copy: yes` block (`copyRecipientOf`); null for none. */
  copyTo: string | null;
  /** The decision whose grant the command spends once delivered; null when it spends none. */
  grantOf: string | null;
  /** The effects that grant covers. */
  approved: readonly Effect[];
  /** Checks the text against its declared effects: every command the Orchestrator sends itself. */
  backstop: boolean;
  /** `refuse` for every command but the prepared command of the owner's own answer, which the loop guard counts and never refuses (`count`). */
  loopGuard: "refuse" | "count";
  /** Sends it at once, replacing the Worker's running turn; allowed only while its danger allowance is `open`. */
  interrupt?: { open: boolean };
  /** The notice-queue kind; `command:<id>` by default. */
  kind?: string;
  /**
   * What the intervention log reads (autonomy design §G.3): the request it is
   * logged against, whether it went on the owner's word in the chat, and the
   * events of the wake whose turn sent it. Null: never logged.
   */
  intervention: { requestId: string | null; ownerAsked: boolean; wakeEvents: () => Promise<readonly BmEvent[]> } | null;
  /** The queue it goes through; the plugin's shared one by default. */
  queue?: Pick<NoticeQueue, "enqueue">;
  /** The commands store's own deps (fixed ids and time in tests); its `newId` names the command. */
  store?: OrchestratorStoreDeps;
  /** The environment whose secrets are masked in the stored copy; the plugin's own by default. */
  redactEnv?: NodeJS.ProcessEnv;
  log?: (message: string) => void;
}

/** What became of a command. */
export type CommandSendResult =
  | {
      ok: true;
      /** The command's id: its entry in the commands store, and on its intervention entry. */
      id: string;
      /** The block as sent. */
      text: string;
      /** Delivered now, or held for the target's turn end. */
      outcome: "sent" | "queued";
      /** The Manager's copy: how it went, or null when there was none to send. */
      copy: "sent" | "queued" | "failed" | null;
      /** Why the grant could not be marked used; null when it was, or there was none. */
      spent: string | null;
      /** Why the command could not be recorded; null when it was. It was delivered either way. */
      unrecorded: string | null;
    }
  | {
      ok: false;
      /** `check`: refused before anything left; `delivery`: the target could not be reached. Nothing was sent, recorded or spent. */
      stage: "check" | "delivery";
      reason: string;
    };

function delivered(outcome: string): outcome is "sent" | "queued" {
  return outcome === "sent" || outcome === "queued";
}

/** What the checks of a send read (`commandRefusalOf`). */
export type CommandCheck = Pick<CommandSend, "home" | "now" | "workspaceId" | "command" | "backstop" | "loopGuard" | "interrupt" | "store" | "log">;

/**
 * Why `spec` would be refused before anything leaves (the module comment's
 * step 1), or null when it would go. Reads only: a caller that must act
 * before the send — the plugin-created handoff successor (design §16.9) —
 * checks first, so a refusal still creates nothing.
 */
export function commandRefusalOf(spec: CommandCheck): string | null {
  const log = spec.log ?? ((message: string) => console.warn(message));
  const { command, workspaceId, home, now } = spec;
  const problems = commandInputProblems(command);
  if (problems.length > 0) return `the command cannot be sent as a BM-COMMAND block: ${problems.join("; ")}`;
  // A handoff goes on the owner's Settings switch, read now: off, it sends nothing (change-008 C3).
  if (command.authority === COORDINATION_HANDOFF_AUTHORITY && !readCoordinationSettings({ home, log }).handoff.enabled) return HANDOFF_OFF_MESSAGE;
  if (spec.backstop) {
    const undeclared = undeclaredCategoriesOf(`${command.re}\n${command.body}`, command.effects ?? []);
    if (undeclared.length > 0) return undeclaredRefusalOf(undeclared);
  }
  // The loop guard: an Orchestrator and a Manager answering each other stop here, before anything is sent.
  if (spec.loopGuard === "refuse" && loopGuardFull(home, workspaceId, command.requestId ?? null, now, spec.store)) return COMMAND_LIMIT_MESSAGE;
  if (spec.interrupt !== undefined && spec.interrupt.open !== true) return INTERRUPT_REFUSED_MESSAGE;
  return null;
}

/**
 * Sends one command of the Orchestrator's (see the module comment). Resolves
 * with a refusal rather than throwing; only a queue that throws rejects —
 * after giving the grant back — as nothing was delivered.
 */
export async function sendCommand(spec: CommandSend): Promise<CommandSendResult> {
  const log = spec.log ?? ((message: string) => console.warn(message));
  const { command, workspaceId, home, now } = spec;

  const refusal = commandRefusalOf(spec);
  if (refusal !== null) return { ok: false, stage: "check", reason: refusal };
  const requestId = command.requestId ?? null;
  const interrupt = spec.interrupt !== undefined;

  const text = commandBlockOf(command);
  const id = (spec.store?.newId ?? randomUUID)();
  const kind = spec.kind ?? commandKindOf(id);
  const role = command.to === "worker" ? "Worker" : "Manager";
  const queue = spec.queue ?? noticeQueue;

  const release = claimGrant(spec.grantOf);
  if (release === null) return { ok: false, stage: "check", reason: `the grant of decision ${spec.grantOf} is being used by another command` };
  let outcome: "sent" | "queued";
  if (interrupt) {
    // The one send that replaces a running turn: the danger allowance is open (ADR-016 decision 2).
    try {
      await spec.paseo.agents.ref(spec.targetId).send(text);
    } catch (error) {
      release();
      return { ok: false, stage: "delivery", reason: `${role} ${spec.targetId} could not be reached (${errorText(error)})` };
    }
    outcome = "sent";
  } else {
    let queued: Awaited<ReturnType<NoticeQueue["enqueue"]>>;
    try {
      queued = await queue.enqueue(spec.targetId, kind, text, spec.paseo);
    } catch (error) {
      release();
      throw error;
    }
    if (!delivered(queued)) {
      release();
      return { ok: false, stage: "delivery", reason: `${role} ${spec.targetId} could not be reached` };
    }
    outcome = queued;
  }

  const spent = spendGrant(spec.grantOf, workspaceId, spec.approved, home, now);
  let unrecorded: string | null = null;
  try {
    const stored = commandOf(command);
    // The stored copy is masked like every other record of the data folder
    // (base design §9); the target got the text as it was.
    const masked = (value: string): string => redactText(value, spec.redactEnv);
    createOrchestratorStore(home, spec.store).appendCommand({
      id,
      workspaceId,
      // A Worker command names the Manager that gets the copy.
      managerId: command.to === "worker" ? spec.copyTo : spec.targetId,
      requestId,
      situation: masked(stored.re),
      command: masked(stored.body),
      reason: masked(stored.why ?? ""),
      sentText: masked(text),
      outcome,
      ...(command.to === "worker" ? { to: "worker" as const, workerId: spec.targetId } : {}),
    });
  } catch (error) {
    unrecorded = errorText(error);
  }
  if (spec.intervention !== null) {
    try {
      const events = await spec.intervention.wakeEvents();
      const facts = {
        workspaceId,
        requestId: spec.intervention.requestId,
        to: command.to,
        targetAgentId: spec.targetId,
        interrupt,
        ownerAsked: spec.intervention.ownerAsked,
        commandId: id,
      };
      recordIntervention(home, interventionOfCommand(facts, events), { now: () => now, log });
    } catch (error) {
      log(`[paseo-bm] could not log the Orchestrator's intervention: ${errorText(error)}`);
    }
  }
  let copy: "sent" | "queued" | "failed" | null = null;
  if (spec.copyTo !== null) {
    // The copy keeps one line of command the Manager can see (ADR-016 decision 2).
    try {
      const copied = await queue.enqueue(spec.copyTo, kind, commandBlockOf({ ...command, copy: true }), spec.paseo);
      copy = delivered(copied) ? copied : "failed";
    } catch {
      copy = "failed";
    }
  }
  return { ok: true, id, text, outcome, copy, spent, unrecorded };
}
