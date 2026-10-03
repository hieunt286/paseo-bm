/**
 * The relay of an unbound Worker's blocks (design §16.10, §16.12; ADR-027
 * decision 9 as amended 2026-10-03, review finding K7).
 *
 * A Worker the plugin did not bind — created by hand by an unbound Manager, or
 * by a bound one on a provider that cannot take the tools — has no delivering
 * `bm_report`. It used to send its `BM-REPORT` itself with `send_agent_prompt`,
 * by the Manager id its brief gave; Haiku Managers never wrote that id, so no
 * report arrived (three runs). Now the plugin carries what the Worker writes,
 * as it already carries an unbound Reviewer's final `BM-REVIEW`
 * (`no-verdict.ts`).
 *
 * On `agent.turn_ended` of a `bm-worker*` agent with no live binding — after
 * the fallback detection, beside the missing-verdict check — every
 * `BM-REPORT` it wrote in its own assistant messages during the turn, with the
 * `BM-QUESTIONS` block right after it, is stored and delivered to its parent
 * (`parentOf`) as a `report` outbox record: the path a bound `bm_report`
 * takes. A block is relayed when:
 *
 * - it names a well-formed request id (`req-YYYYMMDDTHHMMSSZ`) and a phase;
 * - the Worker has a parent: one created by the owner reports in its chat;
 * - the same turn did not send a report of that request and phase itself with
 *   `send_agent_prompt` (an agent on older instructions): that copy reached
 *   the Manager already, and the materialiser reads it there;
 * - no record of the Worker holds the same text already (a turn end read
 *   again, a reload): a block is relayed once.
 *
 * The questions open through the materialiser's shared open path
 * (`openQuestions`), asked by the Worker, and a `finished` report expires the
 * request's unsettled questions (`expireQuestionsOf`) — what the Manager's
 * turn end did for a hand-sent block, which a `BM-DELIVERY` (a plugin notice)
 * no longer reaches. A `finished` or `stopped` report clears the request's
 * `delivery-dropped` alert, as `bm_report` does. Opened decisions go to
 * `onOpened` (the event bus), and a question a precedent answered at once to
 * `onSettled` (its delivery to the Worker).
 *
 * Nothing here throws into a turn end: a failure is one log line.
 */
import type { PluginLifecycleEvents } from "@getpaseo/plugin/server";
import { parentOf, roleOfProvider } from "./agent-role";
import { liveBindingOf, type BindingStore } from "./agent-bindings";
import { joinStreamedText, redactText, sliceLastTurn } from "./collector";
import { createDecisionStore } from "./decision-store";
import type { OnDecisionsSettled } from "./decision-rpc";
import { expireQuestionsOf, openQuestions, type OpenContext } from "./decision-materialiser";
import type { NoticePaseo, NoticeQueue } from "./notice-queue";
import { clearDroppedAlert, createOutbox, storeAndDeliver, type OutboxDeps } from "./outbox";
import { reasonOf } from "./role-choices";
import { checkBlocks } from "../shared/bm-format";
import { parseQuestions } from "../shared/bm-questions";
import { parseReports } from "../shared/bm-report";
import type { Decision } from "../shared/decisions";

type TurnEndedEvent = PluginLifecycleEvents["agent.turn_ended"];

/** A request id the relay accepts. */
const REQUEST_ID = /\breq-\d{8}T\d{6}Z\b/;

/** What one relay did, for the tests and the log. */
export interface RelayOutcome {
  status: "not-unbound-worker" | "no-parent" | "done" | "failed";
  /** The record ids it stored and delivered, oldest first. */
  relayed: string[];
  /** Blocks left out: already relayed, or sent by hand in the turn. */
  skipped: number;
}

export interface RelayDeps {
  /** The data folder. */
  home: string;
  /** The turn's Paseo handle. */
  paseo: unknown;
  /** The per-agent bindings: a Worker with a live one delivers through `bm_report`. */
  bindings: BindingStore | null;
  now?: () => Date;
  log?: (message: string) => void;
  queue?: Pick<NoticeQueue, "enqueue">;
  outbox?: Pick<OutboxDeps, "newId" | "env">;
  /** Decisions the relayed questions opened (the event bus's `decision.opened`). */
  onOpened?: (opened: readonly Decision[], paseo: unknown) => unknown;
  /** Decisions a precedent answered as they opened: their delivery to the Worker. */
  onSettled?: OnDecisionsSettled;
}

/** One `BM-REPORT` the turn wrote, with its `BM-QUESTIONS`. */
export interface WrittenReport {
  requestId: string;
  phase: string;
  /** The report block, then its questions block when it has one. */
  text: string;
  /** The questions block alone, or null. */
  questions: string | null;
}

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

/** A tool's own name, without its MCP server prefix. */
function toolBaseName(name: unknown): string {
  return typeof name === "string" ? (name.split(/__|\./).pop() ?? "") : "";
}

/** The request id (`req-YYYYMMDDTHHMMSSZ`) and phase of one report block, read forgivingly; null without both. */
function keyOf(text: string, checkedRequestId: string | null): { requestId: string; phase: string } | null {
  const report = parseReports(text, { agentId: "relay", at: new Date(0).toISOString() })[0];
  const requestId = REQUEST_ID.exec(checkedRequestId ?? "")?.[0] ?? REQUEST_ID.exec(report?.requestId ?? "")?.[0] ?? null;
  const phase = report?.phase ?? null;
  return requestId === null || phase === null ? null : { requestId, phase };
}

/**
 * Every `BM-REPORT` the agent wrote in its own messages in the turn that
 * ended last, each with the `BM-QUESTIONS` block that follows it in the same
 * message — template echoes left out (`checkBlocks`). Pure.
 */
export function writtenReportsOf(timeline: readonly unknown[]): WrittenReport[] {
  const replies = joinStreamedText(sliceLastTurn(timeline)).filter(
    (item): item is { type: "assistant_message"; text: string } => asRecord(item)?.["type"] === "assistant_message" && typeof asRecord(item)?.["text"] === "string",
  );
  const out: WrittenReport[] = [];
  for (const reply of replies) {
    const blocks = checkBlocks(reply.text);
    blocks.forEach((block, position) => {
      if (block.kind !== "BM-REPORT") return;
      const key = keyOf(block.text, block.requestId);
      if (key === null) return;
      const next = blocks[position + 1];
      const questions = next?.kind === "BM-QUESTIONS" ? next.text : null;
      out.push({ ...key, text: questions === null ? block.text : `${block.text}\n${questions}`, questions });
    });
  }
  return out;
}

/** `requestId|phase` of every report the turn sent itself with `send_agent_prompt`. Pure. */
export function handSentReportKeysOf(timeline: readonly unknown[]): Set<string> {
  const keys = new Set<string>();
  for (const raw of sliceLastTurn(timeline)) {
    const item = asRecord(raw);
    if (item === null || item["type"] !== "tool_call" || toolBaseName(item["name"]) !== "send_agent_prompt") continue;
    const input = asRecord(asRecord(item["detail"])?.["input"] ?? item["input"]);
    const prompt = input?.["prompt"];
    if (typeof prompt !== "string") continue;
    for (const report of parseReports(prompt, { agentId: "relay", at: new Date(0).toISOString() })) {
      if (report.requestId !== null && report.phase !== null) keys.add(`${report.requestId}|${report.phase}`);
    }
  }
  return keys;
}

/** The Worker's parent: the event's, else the `paseo.parent-agent-id` label of a fresh snapshot. */
async function parentOfWorker(agent: TurnEndedEvent["agent"], paseo: unknown): Promise<string | null> {
  const own = parentOf(agent as { parentAgentId?: unknown });
  if (own !== null) return own;
  try {
    const ref = (paseo as { agents?: { ref?: (id: string) => { refresh?: () => Promise<{ agent?: unknown } | null> } } } | null)?.agents?.ref?.(agent.id);
    const snapshot = (await ref?.refresh?.())?.agent as { parentAgentId?: unknown; labels?: unknown } | undefined;
    return parentOf(snapshot);
  } catch {
    return null;
  }
}

/**
 * Relays the blocks an unbound Worker wrote in the turn that just ended (see
 * the header). Never throws.
 */
export async function relayUnboundBlocks(event: TurnEndedEvent, deps: RelayDeps): Promise<RelayOutcome> {
  const log = deps.log ?? ((message: string) => console.warn(message));
  const outcome: RelayOutcome = { status: "not-unbound-worker", relayed: [], skipped: 0 };
  try {
    const agent = event?.agent;
    if (agent === undefined || roleOfProvider(agent.provider) !== "worker" || agent.workspaceId === null) return outcome;
    if (liveBindingOf(deps.bindings?.list() ?? [], agent.id) !== null) return outcome;
    const raw: unknown = (event as { timeline?: unknown }).timeline;
    const timeline: readonly unknown[] = Array.isArray(raw) ? raw : [];
    const written = writtenReportsOf(timeline);
    outcome.status = "done";
    if (written.length === 0) return outcome;
    const parentId = await parentOfWorker(agent, deps.paseo);
    if (parentId === null) return { ...outcome, status: "no-parent" };

    const workspaceId = agent.workspaceId;
    const now = deps.now ?? (() => new Date());
    const env = deps.outbox?.env ?? process.env;
    const handSent = handSentReportKeysOf(timeline);
    const outbox = createOutbox(deps.home, { now, ...deps.outbox });
    const delivery = {
      home: deps.home,
      log,
      now,
      ...deps.outbox,
      ...(deps.queue === undefined ? {} : { queue: deps.queue }),
      paseo: deps.paseo as NoticePaseo,
    };
    const store = createDecisionStore(deps.home, { log });
    const opened: Decision[] = [];
    const answered: Decision[] = [];
    for (const report of written) {
      const text = redactText(report.text, env);
      const known = outbox.list(workspaceId).some((record) => record.from === agent.id && record.kind === "report" && record.text === text);
      if (known || handSent.has(`${report.requestId}|${report.phase}`)) {
        outcome.skipped += 1;
        continue;
      }
      const at = now().toISOString();
      const { record } = await storeAndDeliver(workspaceId, { kind: "report", requestId: report.requestId, from: agent.id, to: parentId, text: report.text }, delivery, () => {
        // What the Manager's turn end did for a hand-sent block: open its questions, expire on finished.
        const set = report.questions === null ? null : parseQuestions(report.questions);
        if (set !== null && set.questions.length > 0) {
          const context: OpenContext = { home: deps.home, store, workspaceId, now: at, log, outcome: { opened, superseded: [], answered, reversed: [] } };
          openQuestions(context, { requestId: set.requestId ?? report.requestId, questions: set.questions, askedBy: agent.id, askedAt: at });
        }
        if (report.phase === "finished") expireQuestionsOf({ store, workspaceId, log }, report.requestId, at);
        if (report.phase === "finished" || report.phase === "stopped") clearDroppedAlert(deps.home, workspaceId, report.requestId, null, { now });
      });
      outcome.relayed.push(record.id);
    }
    if (opened.length > 0 && deps.onOpened !== undefined) {
      try {
        await deps.onOpened(opened, deps.paseo);
      } catch (error) {
        log(`[paseo-bm] the questions ${opened.map((decision) => decision.id).join(", ")} opened, but their events failed: ${reasonOf(error)}`);
      }
    }
    if (answered.length > 0 && deps.onSettled !== undefined) {
      try {
        await deps.onSettled(answered, { paseo: deps.paseo });
      } catch (error) {
        log(`[paseo-bm] ${answered.map((decision) => decision.id).join(", ")} answered at open, but the delivery failed: ${reasonOf(error)}`);
      }
    }
    return outcome;
  } catch (error) {
    log(`[paseo-bm] the relay of ${event?.agent?.id ?? "(unknown)"}'s blocks failed: ${reasonOf(error)}`);
    return { ...outcome, status: "failed" };
  }
}
