/**
 * Ask back (change-014 outcome 3): the owner asks the asker of an open
 * decision a question from its card; the asker replies; the decision stays
 * open. The thread lives beside the decision (`decision-thread-store.ts`).
 *
 * - **`decisions.ask { id, text }`** — only for an unsettled `q:` or `o:`
 *   decision (`askableKindOf`): a held request's Worker is mid-call, a
 *   fallback incident and an override have no agent to ask. The owner's text
 *   is masked and appended to the thread, then delivered as a `BM-ASK` notice
 *   (`askNoticeOf`) through the notice queue — never into a running turn (the
 *   queue's K10 rule: a `send()` replaces a running turn, ADR-024) — with the
 *   kind `ask:<decisionId>`, so a newer ask replaces one still queued.
 * - **Who is asked.** A Worker question goes to the Worker that asked
 *   (`askedBy.agentId`), else to the request's sole live Worker, found as the
 *   answers' delivery finds it (`soleWorkerOfRequest`). An Orchestrator
 *   decision goes to the Orchestrator open now (`findOrchestratorAgent`), as
 *   its answer does. None found: the question stays in the thread, `failed`.
 * - **`decisions.thread { id }`** reads the thread.
 * - **`bm_reply { decisionId, text }`** — the Worker's face (`q:` only, at
 *   `/mcp/worker`, `createWorkerTools`) and the Orchestrator's (`o:` only, in
 *   `orchestrator-tools.ts`). The Worker's path does not say which agent
 *   calls, so a reply is accepted only while the decision is unsettled and
 *   its thread's last entry is the owner's: one reply per ask. It answers
 *   nothing.
 * - **`BM-REPLY <decisionId>`** — an agent created before `bm_reply` has no
 *   such tool (Paseo gives tools at creation), so the notice also lets it
 *   reply in its own chat. At a recorded Worker turn end
 *   (`createReplyFallback`), a message of the Worker's own (`received`) whose
 *   first line is `BM-REPLY <decisionId>` is appended the same way, by the
 *   same rule, and only from the agent the ask went to. The Orchestrator's
 *   turns are not recorded, so it replies with its tool only.
 *
 * Nothing here throws into a turn end; the RPCs answer coded errors.
 */
import type { PluginServerContext } from "@getpaseo/plugin/server";
import {
  DashboardError,
  decisionsAskRpc,
  decisionsThreadRpc,
  type DecisionsAskInput,
  type DecisionsAskOutput,
  type DecisionsThreadInput,
  type DecisionsThreadOutput,
  type TraceRecord,
} from "../shared/contracts";
import { WORKER_SERVER_TOOLS, schemaIssues } from "../shared/bm-tools";
import { REPLY_LINE_MARKER, askableKindOf, hasOpenAsk, replyLineOf, type AskableKind, type DecisionThread } from "../shared/decision-threads";
import { decisionKindOf, isSettledStatus, type Decision } from "../shared/decisions";
import { ASK_NOTICE_MARKER } from "../shared/notices";
import { resolveDataHome, type DataHomeDeps } from "./data-home";
import { soleWorkerOfRequest } from "./decision-delivery";
import { createDecisionStore } from "./decision-store";
import { createDecisionThreadStore } from "./decision-thread-store";
import type { ServerToolAnswer, ServerTools } from "./decision-tools";
import { noticeQueue, type NoticeOutcome, type NoticePaseo, type NoticeQueue } from "./notice-queue";
import { findOrchestratorAgent, type OrchestratorAgentPaseo } from "./orchestrator-agent";
import type { DashboardPaseo } from "./paseo-directory";
import { cutText } from "./request-render";
import { READ_FAILED, coded, errorText, logOf, requireDataHome, type RpcHomeDeps, type RpcLogDeps } from "./rpc-kit";
import { fixThese } from "./tool-kit";

/** The longest decision question quoted in a `BM-ASK`. */
export const ASK_QUOTED_QUESTION_MAX_CHARS = 300;

/** The notice-queue kind of an ask: one queued `BM-ASK` per decision and asker. */
export function askKindOf(decisionId: string): string {
  return `ask:${decisionId}`;
}

/**
 * The `BM-ASK` notice: the marker, the decision id, what the owner asks
 * (quoted, already masked), and what to do — self-contained, so an agent on
 * older instructions follows it too.
 */
export function askNoticeOf(decision: Pick<Decision, "id" | "question">, ownerText: string): string {
  const question = cutText(decision.question.replace(/\s+/g, " ").trim(), ASK_QUOTED_QUESTION_MAX_CHARS);
  return [
    ASK_NOTICE_MARKER,
    `decisionId: ${decision.id}`,
    `From the paseo-bm plugin: the owner asks about your open question before answering it. Your question: ${question}`,
    "The owner asks:",
    ...ownerText.split(/\r?\n/).map((line) => `> ${line}`),
    "Answer with bm_reply { decisionId, text } in a few lines; do not answer the decision yourself, do not ask it again, and carry on with what does not depend on it. The decision stays open until the owner chooses.",
    `If you have no bm_reply tool, reply in your chat starting with \`${REPLY_LINE_MARKER} ${decision.id}\` on the first line, then your answer.`,
  ].join("\n");
}

function isNoticePaseo(value: unknown): value is NoticePaseo & DashboardPaseo {
  const agents = (value as { agents?: { list?: unknown; ref?: unknown } } | null | undefined)?.agents;
  return typeof agents?.list === "function" && typeof agents?.ref === "function";
}

export interface DecisionAskDeps extends RpcHomeDeps, RpcLogDeps {
  now?: () => Date;
  /** Secrets to mask; the process's own by default. */
  redactEnv?: NodeJS.ProcessEnv;
  /** The queue the notice goes through; the plugin's shared one by default. */
  queue?: Pick<NoticeQueue, "enqueue">;
  /** The request's sole live Worker, for a question whose asker is not recorded; `soleWorkerOfRequest` by default. */
  workerOf?: (input: { workspaceId: string; requestId: string; home: string }, paseo: DashboardPaseo) => Promise<string | null>;
  /** The Orchestrator open now; `findOrchestratorAgent` by default. */
  orchestratorOf?: (paseo: unknown) => Promise<string | null>;
}

const reading = <T>(what: string, operation: () => T): T => coded(READ_FAILED, what, operation);
const writing = <T>(what: string, operation: () => T): T => coded("E_DECISION_WRITE_FAILED", what, operation);

/** Why a decision cannot be asked about, by its kind. */
const NOT_ASKABLE: Record<string, string> = {
  held: "a held action has no Ask back: its Worker is waiting inside the call; allow or deny it",
  fallback: "a fallback incident has no agent to ask; choose one of its actions",
  override: "an override is your own correction; answer it",
};

/** The agent the ask goes to, or null when none can be found now. */
async function askerOf(decision: Decision, kind: AskableKind, paseo: unknown, home: string, deps: DecisionAskDeps): Promise<string | null> {
  if (kind === "orchestrator") {
    const lookup = deps.orchestratorOf ?? (async (handle: unknown) => (await findOrchestratorAgent(handle as OrchestratorAgentPaseo))?.id ?? null);
    return isNoticePaseo(paseo) || deps.orchestratorOf !== undefined ? lookup(paseo) : null;
  }
  if (decision.askedBy.agentId !== null) return decision.askedBy.agentId;
  if (decision.requestId === null || !isNoticePaseo(paseo)) return null;
  return (deps.workerOf ?? soleWorkerOfRequest)({ workspaceId: decision.workspaceId, requestId: decision.requestId, home }, paseo);
}

/**
 * `decisions.ask`: stores the owner's question in the decision's thread and
 * delivers it to the asker as `BM-ASK`. Every refusal writes and sends
 * nothing; a failed delivery keeps the question (`delivery: failed`).
 */
export async function handleDecisionsAsk(input: DecisionsAskInput, paseo: unknown, deps: DecisionAskDeps = {}): Promise<DecisionsAskOutput> {
  if (typeof input.text !== "string" || input.text.trim() === "") throw new DashboardError("E_DECISION_ASK_INVALID", "the question is empty");
  const home = requireDataHome(deps, "ask about the decision");
  const log = logOf(deps);
  const decision = reading("read the decision", () => createDecisionStore(home, { log }).get(input.id));
  if (decision === null) throw new DashboardError("E_DECISION_NOT_FOUND", `no decision ${input.id}`);
  const kind = askableKindOf(decision.id);
  if (kind === null) {
    throw new DashboardError("E_DECISION_NOT_ASKABLE", `${decision.id}: ${NOT_ASKABLE[decisionKindOf(decision.id) ?? ""] ?? "this decision has no asker to ask"}`);
  }
  if (isSettledStatus(decision.status)) {
    throw new DashboardError("E_DECISION_SETTLED", `${decision.id} is ${decision.status}${decision.supersededBy === null ? "" : `; see ${decision.supersededBy}`}`);
  }

  let target: string | null = null;
  try {
    target = await askerOf(decision, kind, paseo, home, deps);
  } catch (error) {
    log(`[paseo-bm] could not find who asked ${decision.id}: ${errorText(error)}`);
  }
  const at = (deps.now?.() ?? new Date()).toISOString();
  const threads = createDecisionThreadStore(home, deps.redactEnv === undefined ? {} : { redactEnv: deps.redactEnv });
  const thread = writing("store the question", () =>
    threads.append(decision.workspaceId, decision.id, { by: "owner", text: input.text, at, ...(target === null ? {} : { agentId: target }) }),
  );
  if (thread === null) throw new DashboardError("E_DECISION_ASK_INVALID", "the question is empty once masked");
  if (target === null) {
    log(`[paseo-bm] the question about ${decision.id} is stored, but no ${kind === "question" ? "Worker" : "Beads Orchestrator"} was found to ask.`);
    return { thread, delivery: "failed" };
  }
  const ownerText = thread.entries.at(-1)!.text;
  const outcome: NoticeOutcome = await (deps.queue ?? noticeQueue).enqueue(
    target,
    askKindOf(decision.id),
    askNoticeOf(decision, ownerText),
    isNoticePaseo(paseo) ? paseo : undefined,
  );
  if (outcome === "dropped" || outcome === "replaced") log(`[paseo-bm] the question about ${decision.id} is stored, but could not be delivered to ${target}.`);
  return { thread, delivery: outcome === "sent" ? "sent" : outcome === "queued" ? "queued" : "failed" };
}

/** `decisions.thread`: the decision's thread, read only. */
export function handleDecisionsThread(input: DecisionsThreadInput, deps: RpcHomeDeps & RpcLogDeps = {}): DecisionsThreadOutput {
  const home = requireDataHome(deps, "read the thread");
  const decision = reading("read the decision", () => createDecisionStore(home, { log: logOf(deps) }).get(input.id));
  if (decision === null) throw new DashboardError("E_DECISION_NOT_FOUND", `no decision ${input.id}`);
  return { thread: reading("read the thread", () => createDecisionThreadStore(home).read(decision.workspaceId, decision.id)) };
}

// ---------------------------------------------------------------------------
// The asker's reply: bm_reply, and BM-REPLY in a Worker's own chat.
// ---------------------------------------------------------------------------

export interface ReplyContext {
  home: string;
  /** The kind of decision this asker may reply about: a Worker's `q:`, the Orchestrator's `o:`. */
  kind: AskableKind;
  /** Who replies, when known. */
  agentId?: string | null;
  /** When it is known, the reply must come from the agent the ask went to. */
  onlyFrom?: string;
  now?: Date;
  env?: NodeJS.ProcessEnv;
  log?: (message: string) => void;
}

const KIND_IDS: Record<AskableKind, string> = { question: "q:…", orchestrator: "o:…" };

/**
 * Appends the asker's reply to a decision's thread: only for an unsettled
 * decision of the asker's kind whose thread's last entry is the owner's.
 * Never throws: a refusal or a failure is a text for the agent.
 */
export function replyToDecision(input: { decisionId: string; text: string }, context: ReplyContext): ServerToolAnswer {
  const { decisionId } = input;
  if (askableKindOf(decisionId) !== context.kind) {
    return { ok: false, text: `Refused: bm_reply takes only a decision id ${KIND_IDS[context.kind]} that a BM-ASK notice named; ${decisionId} is not one.` };
  }
  try {
    const decision = createDecisionStore(context.home, context.log === undefined ? {} : { log: context.log }).get(decisionId);
    if (decision === null) return { ok: false, text: `Refused: there is no decision ${decisionId}.` };
    if (isSettledStatus(decision.status)) {
      return { ok: false, text: `Refused: ${decisionId} is already ${decision.status}; there is nothing to reply to. Carry on.` };
    }
    const threads = createDecisionThreadStore(context.home, context.env === undefined ? {} : { redactEnv: context.env });
    const at = (context.now ?? new Date()).toISOString();
    const accept = (thread: DecisionThread): boolean => {
      if (!hasOpenAsk(thread)) return false;
      const askedOf = thread.entries.at(-1)!.agentId;
      return context.onlyFrom === undefined || askedOf === undefined || askedOf === context.onlyFrom;
    };
    const agentId = context.agentId ?? null;
    const written = threads.append(decision.workspaceId, decisionId, { by: "asker", text: input.text, at, ...(agentId === null ? {} : { agentId }) }, accept);
    if (written === null) {
      return {
        ok: false,
        text: `Refused: the owner has no open question about ${decisionId} (none was asked, or your reply is already recorded). Call bm_reply only after a BM-ASK, once.`,
      };
    }
    return { ok: true, text: `Your reply is recorded with ${decisionId}; the owner reads it on the decision's card. The decision stays open until the owner chooses: carry on with what does not depend on it.` };
  } catch (error) {
    return { ok: false, text: `The tool failed: ${errorText(error)}. Try again later, or reply in your chat.` };
  }
}

export interface WorkerToolsDeps extends DataHomeDeps {
  now?: () => Date;
  /** Secrets to mask; the process's own by default. */
  redactEnv?: NodeJS.ProcessEnv;
  log?: (message: string) => void;
}

/** The Worker's server-run tools, served at `/mcp/worker` beside its block tool: `bm_reply` for its own questions. */
export function createWorkerTools(deps: WorkerToolsDeps = {}): ServerTools {
  const faces = WORKER_SERVER_TOOLS;
  const names = new Set(faces.map((face) => face.name));
  return {
    faces,
    has: (name) => names.has(name),
    async call(name, input) {
      const face = faces.find((candidate) => candidate.name === name);
      if (face === undefined) return { ok: false, text: `Unknown tool: ${name}` };
      const issues = schemaIssues(face.inputSchema, input);
      if (issues.length > 0) return fixThese(name, issues);
      let home: string | null;
      try {
        home = resolveDataHome(deps).home;
      } catch (error) {
        return { ok: false, text: `The tool failed: ${errorText(error)}. Reply in your chat instead.` };
      }
      if (home === null) return { ok: false, text: "The tool failed: paseo-bm has no usable data folder. Reply in your chat instead." };
      return replyToDecision(input as { decisionId: string; text: string }, {
        home,
        kind: "question",
        now: (deps.now ?? (() => new Date()))(),
        env: deps.redactEnv ?? process.env,
        ...(deps.log === undefined ? {} : { log: deps.log }),
      });
    },
  };
}

export interface ReplyFallbackDeps extends DataHomeDeps {
  /** The data folder; resolved otherwise. */
  home?: () => string | null;
  now?: () => Date;
  redactEnv?: NodeJS.ProcessEnv;
  log?: (message: string) => void;
}

/**
 * The `BM-REPLY <decisionId>` fallback: at a recorded Worker turn end, each of
 * the Worker's own messages whose first line is `BM-REPLY <decisionId>` is
 * appended to that decision's thread, by `replyToDecision`'s rule, and only
 * from the agent the ask went to. Never rejects.
 */
export function createReplyFallback(deps: ReplyFallbackDeps = {}): { afterTurn(record: TraceRecord): void } {
  const log = deps.log ?? ((message: string) => console.warn(message));
  const homeOf = (): string | null => {
    if (deps.home !== undefined) return deps.home();
    try {
      return resolveDataHome(deps).home;
    } catch {
      return null;
    }
  };
  return {
    afterTurn(record) {
      try {
        if (record.role !== "worker") return;
        const replies = record.received.map((message) => replyLineOf(message.text)).filter((reply) => reply !== null);
        if (replies.length === 0) return;
        const home = homeOf();
        if (home === null) return;
        for (const reply of replies) {
          const result = replyToDecision(reply, {
            home,
            kind: "question",
            agentId: record.agentId,
            onlyFrom: record.agentId,
            now: (deps.now ?? (() => new Date()))(),
            env: deps.redactEnv ?? process.env,
            log,
          });
          log(`[paseo-bm] BM-REPLY ${reply.decisionId} from ${record.agentId}: ${result.ok ? "recorded" : result.text}`);
        }
      } catch (error) {
        log(`[paseo-bm] reading a BM-REPLY failed: ${errorText(error)}`);
      }
    },
  };
}

export function registerDecisionAskRpcs(server: PluginServerContext, deps: DecisionAskDeps = {}): void {
  server.handle(decisionsAskRpc, (input, context) => handleDecisionsAsk(input, context?.paseo, deps));
  server.handle(decisionsThreadRpc, (input) => handleDecisionsThread(input, deps));
}
