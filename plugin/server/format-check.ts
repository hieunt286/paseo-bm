/**
 * `BM-FORMAT`: the sender of a block that breaks its template is told, and
 * asked to send the whole corrected block again (delta 20260918g §4.7,
 * REQ-061 f, owner decisions Q2 a and Q8 a).
 *
 * Only timeline shapes verified on a real daemon are read: a `user_message`
 * with no `clientMessageId` is another agent's message, and an
 * `assistant_message` is the agent's own. The raw shape of a
 * `send_agent_prompt` tool call is not verified, so a block is checked where it
 * ARRIVES, at the turn end of the side that received it:
 *
 * | Block                      | Checked at the turn end of | Sender (told)                     |
 * |----------------------------|----------------------------|-----------------------------------|
 * | BM-REPORT (+ BM-QUESTIONS) | the Manager                | the one Worker with that request  |
 * | BM-ANSWERS                 | the Worker                 | its parent, when it is a Manager  |
 * | BM-REVIEW                  | the Reviewer (its own)     | the Reviewer itself               |
 *
 * Rules this module must never lose:
 * - **Never into a running turn.** `send()` on a running agent replaces its
 *   turn (review-budget.ts); a sender that is running or initializing is left
 *   for a later turn end. An archived or closed sender is never sent to:
 *   `send()` would un-archive it (ADR-005).
 * - **Only the latest block.** Each turn end of the checking side replaces the
 *   pending notice with the verdict on the newest block it received (a valid
 *   one clears it). At the SENDER's own turn end the checking side may not
 *   have seen the sender's newest block yet, so there the notice goes only if
 *   the checking side has received nothing since the block was checked (its
 *   `lastUserMessageAt` still equals the mark); otherwise it waits for the
 *   checking side's next turn end, which decides (design §4.7 errata).
 * - **A later chance always comes for reports and reviews.** A pending notice is
 *   looked at again at the next turn end of (1) the checking side, (2) the
 *   receiving side — the Manager for reports, the Worker for answers, the
 *   Reviewer's parent Worker for reviews — and (3) the sender itself. The
 *   Manager is woken after every Worker turn and a Worker when its Reviewer
 *   finishes (both `notifyOnFinish` by default). Answers have no such
 *   guarantee: that notice may never go, and the card chip still shows.
 * - **Bounded.** One notice per distinct block, at most `MAX_NOTICES` per
 *   sender, request and kind. State lives in memory; a reload starts afresh
 *   and never re-reads old blocks.
 *
 * Nothing here throws into an agent's turn end: a failure costs one log line.
 */
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { checkBlocks, issueText, type BlockKind, type CheckedBlock } from "../shared/bm-format";
import { roleOfProvider, type BmRole } from "./agent-role";
import { sliceLastTurn } from "./collector";
import { bmAgentsOf, requireLocation, type DashboardPaseo } from "./dashboard-rpc";
import { FORMAT_NOTICE_MARKER, isPluginNotice } from "./notices";
import { readRecords } from "./trace-store";
import { requestIdOfAgent, type AgentFacts } from "./traces";

/** Notices per sender, request and kind (owner decision Q8 a). */
export const MAX_NOTICES = 2;
/** Re-reads of a sender that still reads `running` at its own turn end, and the pause between them. */
export const OWN_TURN_REREADS = 5;
export const OWN_TURN_REREAD_MS = 1000;

export interface FormatAgentSnapshot {
  status?: string | null;
  archivedAt?: string | null;
  lastUserMessageAt?: string | null;
}

/** The SDK slice this module uses; `PaseoApi` is structurally close enough to be cast. */
export interface FormatPaseo extends Omit<DashboardPaseo, "agents"> {
  agents: Omit<DashboardPaseo["agents"], "ref"> & {
    ref(agentId: string): {
      refresh(): Promise<{ agent?: FormatAgentSnapshot | null } | null>;
      send(text: string): Promise<void>;
    };
  };
}

/** What the hook hands over; the timeline is the whole conversation. */
export interface FormatTurnEvent {
  agent: { id: string; workspaceId: string | null; parentAgentId: string | null; provider: string };
  turnId?: string | null;
  timeline: readonly unknown[];
}

interface Pending {
  key: string;
  kind: BlockKind;
  requestId: string | null;
  senderId: string;
  senderRole: BmRole;
  /** The side that checked the block: its turn end, and its `lastUserMessageAt` mark. */
  checkerId: string;
  mark: string | null;
  /** The receiving side's agent (Manager / Worker / the Reviewer's parent Worker). */
  receiverId: string | null;
  issues: string[];
  hash: string;
}

export interface FormatState {
  pending: Map<string, Pending>;
  /** Notices sent per `sender|requestId|kind`. */
  sent: Map<string, number>;
  /** Hashes of blocks already notified. */
  notifiedBlocks: Set<string>;
  /** Keys being sent right now, so two turn ends never send one notice twice. */
  sending: Set<string>;
}

export function createFormatState(): FormatState {
  return { pending: new Map(), sent: new Map(), notifiedBlocks: new Set(), sending: new Set() };
}

export interface FormatDeps {
  paseo: FormatPaseo;
  state: FormatState;
  log?: (message: string) => void;
  /** Pause between own-turn re-reads; tests pass an instant one. */
  sleep?: (ms: number) => Promise<void>;
  homedir?: () => string;
}

export type FormatOutcome = "ignored" | "checked";

/** The notice, word for word from design §4.7. */
export function formatNotice(kind: BlockKind, requestId: string | null, issues: readonly string[]): string {
  const last =
    kind === "BM-REVIEW"
      ? "Answer with the whole corrected BM-REVIEW block as your final message; do not review again."
      : "Send the whole corrected block again, to the same agent as before, in one message. Change nothing else and do not redo any work; then carry on exactly where you were.";
  return [
    `${FORMAT_NOTICE_MARKER} requestId: ${requestId ?? "unknown"}`,
    `Your last ${kind} broke the template:`,
    ...issues.map((issue) => `- ${issue}`),
    last,
  ].join("\n");
}

/** djb2, enough to tell two blocks apart. */
function hashOf(text: string): string {
  let hash = 5381;
  for (let index = 0; index < text.length; index += 1) hash = ((hash << 5) + hash + text.charCodeAt(index)) | 0;
  return (hash >>> 0).toString(36);
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface TimelineText {
  type: string;
  text: string;
  clientMessageId?: unknown;
}

function textItem(item: unknown): TimelineText | null {
  if (item === null || typeof item !== "object") return null;
  const { type, text } = item as { type?: unknown; text?: unknown };
  if ((type !== "user_message" && type !== "assistant_message") || typeof text !== "string") return null;
  return item as TimelineText;
}

/** The blocks of one message grouped as the sender sent them: a report with its questions is one unit. */
function unitsOf(blocks: readonly CheckedBlock[]): Array<{ kind: BlockKind; requestId: string | null; issues: string[]; text: string }> {
  const units: Array<{ kind: BlockKind; requestId: string | null; issues: string[]; text: string }> = [];
  for (const block of blocks) {
    const previous = units.at(-1);
    if (block.kind === "BM-QUESTIONS" && previous?.kind === "BM-REPORT") {
      previous.issues.push(...block.issues.map(issueText));
      previous.text += `\n\n${block.text}`;
      continue;
    }
    units.push({ kind: block.kind, requestId: block.requestId, issues: block.issues.map(issueText), text: block.text });
  }
  return units;
}

async function snapshotOf(paseo: FormatPaseo, agentId: string): Promise<FormatAgentSnapshot | null> {
  const result = await paseo.agents.ref(agentId).refresh();
  return result?.agent ?? null;
}

/** `bmAgentsOf` reads only `agents.list`; hand it exactly that. */
function directoryOf(paseo: FormatPaseo): DashboardPaseo {
  return { agents: { list: (options) => paseo.agents.list(options) }, workspaces: paseo.workspaces, config: paseo.config };
}

/** The Worker of the workspace that owns `requestId`, when exactly one does. */
async function workerOf(deps: FormatDeps, workspaceId: string, requestId: string | null): Promise<AgentFacts | null> {
  if (requestId === null) return null;
  const directory = directoryOf(deps.paseo);
  const workers = (await bmAgentsOf(directory)).filter((entry) => entry.workspaceId === workspaceId && entry.facts.role === "worker");
  let records: Parameters<typeof requestIdOfAgent>[1] = [];
  try {
    records = readRecords(await requireLocation(directory, { homedir: deps.homedir }), workspaceId).records;
  } catch {
    // Without a trace store only the labels are known.
  }
  const matches = workers.filter(({ facts }) => (facts.requestIdLabel ?? requestIdOfAgent(facts, records).requestId) === requestId);
  return matches.length === 1 ? matches[0]!.facts : null;
}

async function factsOfAgent(deps: FormatDeps, agentId: string | null): Promise<AgentFacts | null> {
  if (agentId === null) return null;
  return (await bmAgentsOf(directoryOf(deps.paseo))).find((entry) => entry.facts.id === agentId)?.facts ?? null;
}

/** Records the latest block of each sender/request/kind seen in this turn. */
async function detect(event: FormatTurnEvent, role: BmRole, deps: FormatDeps, log: (message: string) => void): Promise<void> {
  const items = sliceLastTurn(Array.isArray(event.timeline) ? event.timeline : [])
    .map(textItem)
    .filter((item): item is TimelineText => item !== null);
  const wanted: BlockKind = role === "manager" ? "BM-REPORT" : role === "worker" ? "BM-ANSWERS" : "BM-REVIEW";
  // Received from another agent (no clientMessageId, not the plugin's own notice) — or, for a Reviewer, its own words.
  const sources = items.filter((item) =>
    role === "reviewer"
      ? item.type === "assistant_message"
      : item.type === "user_message" && typeof item.clientMessageId !== "string" && !isPluginNotice(item.text),
  );
  const latest = new Map<string, { kind: BlockKind; requestId: string | null; issues: string[]; text: string }>();
  for (const item of sources) {
    for (const unit of unitsOf(checkBlocks(item.text))) {
      if (unit.kind !== wanted) continue;
      latest.set(`${unit.kind}|${unit.requestId ?? "?"}`, unit);
    }
  }
  if (latest.size === 0) return;

  let mark: string | null = null;
  let markRead = false;
  for (const unit of latest.values()) {
    let sender: { id: string; role: BmRole } | null;
    let receiverId: string | null;
    if (role === "manager") {
      const worker = event.agent.workspaceId === null ? null : await workerOf(deps, event.agent.workspaceId, unit.requestId);
      sender = worker === null ? null : { id: worker.id, role: "worker" };
      receiverId = event.agent.id;
    } else if (role === "worker") {
      const parent = await factsOfAgent(deps, event.agent.parentAgentId);
      sender = parent?.role === "manager" ? { id: parent.id, role: "manager" } : null;
      receiverId = event.agent.id;
    } else {
      sender = { id: event.agent.id, role: "reviewer" };
      receiverId = event.agent.parentAgentId;
    }
    if (sender === null) {
      if (unit.issues.length > 0) log(`[paseo-bm] a ${unit.kind} for ${unit.requestId ?? "an unknown request"} breaks the template, but its sender is not known; no BM-FORMAT sent.`);
      continue;
    }
    const key = `${sender.id}|${unit.requestId ?? "?"}|${unit.kind}`;
    if (unit.issues.length === 0) {
      deps.state.pending.delete(key);
      continue;
    }
    const hash = hashOf(unit.text);
    if (deps.state.notifiedBlocks.has(hash)) continue;
    if (!markRead) {
      mark = (await snapshotOf(deps.paseo, event.agent.id))?.lastUserMessageAt ?? null;
      markRead = true;
    }
    deps.state.pending.set(key, {
      key,
      kind: unit.kind,
      requestId: unit.requestId,
      senderId: sender.id,
      senderRole: sender.role,
      checkerId: event.agent.id,
      mark,
      receiverId,
      issues: unit.issues,
      hash,
    });
  }
}

/** Tries every pending notice this turn end is a chance for. */
async function flush(endedId: string, deps: FormatDeps, log: (message: string) => void): Promise<void> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const chances = [...deps.state.pending.values()].filter(
    (entry) => entry.checkerId === endedId || entry.receiverId === endedId || entry.senderId === endedId,
  );
  for (const entry of chances) {
    if (deps.state.sending.has(entry.key)) continue;
    deps.state.sending.add(entry.key);
    try {
      const counted = `${entry.senderId}|${entry.requestId ?? "?"}|${entry.kind}`;
      if ((deps.state.sent.get(counted) ?? 0) >= MAX_NOTICES) {
        deps.state.pending.delete(entry.key);
        log(`[paseo-bm] ${entry.kind} from ${entry.senderId} still breaks the template after ${MAX_NOTICES} notices; not asking again.`);
        continue;
      }
      const atSenderOnly = endedId === entry.senderId && endedId !== entry.checkerId && endedId !== entry.receiverId;
      if (atSenderOnly) {
        // The sender may have just sent a newer block the checking side has not
        // read yet: wait for the checking side's next turn end to decide.
        const checker = await snapshotOf(deps.paseo, entry.checkerId);
        if ((checker?.lastUserMessageAt ?? null) !== entry.mark) continue;
      }
      let sender = await snapshotOf(deps.paseo, entry.senderId);
      if (entry.senderId === endedId) {
        for (let reread = 0; reread < OWN_TURN_REREADS && isBusy(sender); reread += 1) {
          await sleep(OWN_TURN_REREAD_MS);
          sender = await snapshotOf(deps.paseo, entry.senderId);
        }
      }
      if (sender === null || sender.archivedAt != null || sender.status === "closed") {
        deps.state.pending.delete(entry.key);
        log(`[paseo-bm] ${entry.senderId} is archived, closed or gone; the BM-FORMAT notice was not sent.`);
        continue;
      }
      if (isBusy(sender)) continue;
      await deps.paseo.agents.ref(entry.senderId).send(formatNotice(entry.kind, entry.requestId, entry.issues));
      deps.state.pending.delete(entry.key);
      deps.state.sent.set(counted, (deps.state.sent.get(counted) ?? 0) + 1);
      deps.state.notifiedBlocks.add(entry.hash);
    } catch (error) {
      log(`[paseo-bm] could not send BM-FORMAT to ${entry.senderId}: ${describeError(error)}; trying again at a later turn end.`);
    } finally {
      deps.state.sending.delete(entry.key);
    }
  }
}

function isBusy(snapshot: FormatAgentSnapshot | null): boolean {
  return snapshot?.status === "running" || snapshot?.status === "initializing";
}

/** Handler body of `on("agent.turn_ended")`. Never throws. */
export async function checkTurnFormat(event: FormatTurnEvent, deps: FormatDeps): Promise<FormatOutcome> {
  const log = deps.log ?? ((message: string) => console.warn(message));
  try {
    const role = roleOfProvider(event?.agent?.provider);
    if (role === null) return "ignored";
    try {
      await detect(event, role, deps, log);
    } catch (error) {
      log(`[paseo-bm] checking the BM blocks of ${event.agent.id} failed: ${describeError(error)}`);
    }
    await flush(event.agent.id, deps, log);
    return "checked";
  } catch (error) {
    log(`[paseo-bm] the BM-FORMAT check failed: ${describeError(error)}`);
    return "ignored";
  }
}

export type FormatHost = Partial<Pick<PluginServerContext, "on">>;

/** Registers the check on `agent.turn_ended`; a no-op on a host without `on`. */
export function registerFormatCheck(host: FormatHost, state: FormatState = createFormatState()): () => void {
  if (typeof host.on !== "function") return () => {};
  const remove = host.on("agent.turn_ended", async (event, context) => {
    await checkTurnFormat(event as unknown as FormatTurnEvent, { paseo: context.paseo as unknown as FormatPaseo, state });
  });
  return typeof remove === "function" ? remove : () => {};
}
