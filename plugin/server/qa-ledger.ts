/**
 * The question–answer ledger: which of a request's questions were asked and
 * which were answered (design delta 20260924-qa-ledger §3).
 *
 * Before this file, "answered" existed nowhere. The Worker knew, and said
 * nothing until its next report; the card kept a note in the app session only;
 * the pill and the Manager guessed from "the latest report is `blocked` and
 * the Worker is idle" — which is also true while the Worker waits for its
 * Reviewer. On 2026-09-22/23 that guess showed answered questions as open for
 * up to 462 minutes a day, and the user answered the same question twice
 * twelve times (diagnosis 2026-09-24).
 *
 * What is recorded, and where it is read (§3.2):
 *
 * | Turn end of | Read from its timeline                                              | Recorded  |
 * |-------------|---------------------------------------------------------------------|-----------|
 * | a Manager   | `user_message` WITHOUT `clientMessageId` (an agent's) with `BM-QUESTIONS` | questions |
 * | a Worker    | `user_message` with `BM-ANSWERS` (`via: user` when it has `clientMessageId`) | answers   |
 *
 * The WHOLE timeline is read each time and recording is idempotent, so a
 * canceled turn, a reload or a missed hook is made good at the next turn end.
 *
 * THE RULE (§3.4): `(requestId, Qn)` is answered once the ledger holds any
 * answer to it, whatever the order. Workers number questions once per request
 * and ask an unanswered one again under its own number (worker.md), so an
 * answered number is never asked again; comparing times would need timestamps
 * the hook does not have (a timeline item carries none) and would make the
 * result depend on which of two hooks ran first.
 *
 * `BM-ANSWERED` (§5): a card answer goes straight to the Worker, so its
 * Manager never saw it and kept telling the user the question was open, then
 * relayed it again (2026-09-22T17:11Z, 2026-09-23T05:58Z). At a Worker's turn
 * end, the answers that (1) came from the app (`via: user`), (2) are in the
 * LAST turn, and (3) were new to the ledger at this very call go to the
 * Worker's Manager through the notice queue — never into a running turn. The
 * last-turn condition keeps an old answer, first recorded after an upgrade,
 * from waking the Manager; the "new" condition keeps a later turn end from
 * sending it again.
 *
 * The file lives beside `answer-marks.json` and is written the same way: no-
 * follow path guard, atomic temp-then-rename, never repaired on read, never
 * written over a newer version's file. Texts are masked like every trace
 * record (REQ-048b) before they are stored. Recording is synchronous from
 * read to write, so two turn ends handled at once cannot lose each other's
 * entries. Nothing here throws into an agent's turn end.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { parseAnswers, parseQuestions } from "../shared/bm-questions";
import { roleOfProvider } from "./agent-role";
import { createLocationResolver, redactText, resolveLocationFromPaseo, sliceLastTurn, type LocationResolver } from "./collector";
import { bmAgentsOf, type DashboardPaseo } from "./dashboard-rpc";
import { UI_DIR_NAME } from "./install-home";
import { enqueue, type NoticeOutcome, type NoticePaseo } from "./notice-queue";
import { ANSWERED_NOTICE_MARKER, isPluginNotice } from "./notices";
import { assertNoSymlinkOnPath, ensureStoreDir, writeStoreFileAtomically, type TraceStoreLocation } from "./trace-store";

/** Bumped only when the shape below changes incompatibly. */
export const QA_LEDGER_SCHEMA_VERSION = 1;
export const QA_LEDGER_FILE_NAME = "qa-ledger.json";
/** Requests kept; the least recently updated go first. A request only matters while it runs. */
export const QA_LEDGER_REQUEST_LIMIT = 300;
export const QA_LEDGER_QUESTION_LIMIT = 100;
export const QA_LEDGER_ANSWER_LIMIT = 200;
/** Longest stored question or answer, after masking. */
export const QA_LEDGER_TEXT_CHARS = 1000;

const questionSchema = z.object({ id: z.string().min(1), text: z.string(), at: z.string() });
const answerSchema = z.object({
  id: z.string().min(1),
  text: z.string(),
  via: z.enum(["user", "agent"]),
  workerId: z.string().nullable(),
  at: z.string(),
});
const requestSchema = z.object({
  requestId: z.string().min(1),
  workspaceId: z.string().nullable(),
  updatedAt: z.string(),
  questions: z.array(questionSchema),
  answers: z.array(answerSchema),
});
const fileSchema = z.object({ schemaVersion: z.number().int().positive(), requests: z.array(requestSchema) });

export type LedgerQuestion = z.infer<typeof questionSchema>;
export type LedgerAnswer = z.infer<typeof answerSchema>;
export type LedgerRequest = z.infer<typeof requestSchema>;

export interface QaLedger {
  requests: LedgerRequest[];
  /** What could not be read, in the user's terms. Empty when all is well. */
  notices: string[];
  /** The file on disk is newer than this plugin understands: never written over. */
  tooNew: boolean;
}

export function qaLedgerPath(location: TraceStoreLocation): string {
  return join(dirname(location.tracesDir), UI_DIR_NAME, QA_LEDGER_FILE_NAME);
}

/**
 * The ledger, or an empty one with a notice for a missing, unreadable, corrupt
 * or too-new file. Throws only for a symlinked path, like `answer-marks.ts`.
 */
export function readQaLedger(location: TraceStoreLocation): QaLedger {
  const path = qaLedgerPath(location);
  // Before the read, so a symlinked path is refused rather than followed.
  assertNoSymlinkOnPath(dirname(location.tracesDir), path);
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { requests: [], notices: [], tooNew: false };
    return { requests: [], notices: [`Could not read the question ledger (${(error as Error).message}).`], tooNew: false };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { requests: [], notices: ["The question ledger is not valid JSON; treating every question as unanswered."], tooNew: false };
  }
  const result = fileSchema.safeParse(parsed);
  if (!result.success) {
    return { requests: [], notices: ["The question ledger does not have the expected shape; treating every question as unanswered."], tooNew: false };
  }
  if (result.data.schemaVersion > QA_LEDGER_SCHEMA_VERSION) {
    return {
      requests: [],
      notices: [
        `The question ledger is version ${result.data.schemaVersion}, newer than this plugin understands (${QA_LEDGER_SCHEMA_VERSION}); nothing will be written to it.`,
      ],
      tooNew: true,
    };
  }
  return { requests: result.data.requests, notices: [], tooNew: false };
}

/** `readQaLedger` that never throws: a symlinked path reads as empty, with a notice. */
export function readQaLedgerSafely(location: TraceStoreLocation): QaLedger {
  try {
    return readQaLedger(location);
  } catch (error) {
    return { requests: [], notices: [`Could not read the question ledger: ${describeError(error)}`], tooNew: false };
  }
}

function requestOf(ledger: Pick<QaLedger, "requests">, requestId: string): LedgerRequest | undefined {
  return ledger.requests.find((entry) => entry.requestId === requestId);
}

/** The ids of `requestId`'s answered questions (the rule of §3.4). */
export function answeredIds(ledger: Pick<QaLedger, "requests">, requestId: string): Set<string> {
  return new Set((requestOf(ledger, requestId)?.answers ?? []).map((answer) => answer.id));
}

const idNumber = (id: string): number => Number.parseInt(id.replace(/^Q/, ""), 10);
const byNumber = (a: string, b: string): number => idNumber(a) - idNumber(b);

/** `requestId`'s asked questions with no answer yet, in number order. */
export function openQuestionIds(ledger: Pick<QaLedger, "requests">, requestId: string): string[] {
  const answered = answeredIds(ledger, requestId);
  return (requestOf(ledger, requestId)?.questions ?? []).map((question) => question.id).filter((id) => !answered.has(id)).sort(byNumber);
}

/** Every recorded question of `requestId` in number order, each with its most recently recorded answer or null. */
export function questionsWithAnswers(
  ledger: Pick<QaLedger, "requests">,
  requestId: string,
): Array<{ question: LedgerQuestion; answer: LedgerAnswer | null }> {
  const entry = requestOf(ledger, requestId);
  if (entry === undefined) return [];
  const latest = new Map<string, LedgerAnswer>();
  // Answers are kept in the order they were recorded: the last one wins.
  for (const answer of entry.answers) latest.set(answer.id, answer);
  return [...entry.questions].sort((a, b) => byNumber(a.id, b.id)).map((question) => ({ question, answer: latest.get(question.id) ?? null }));
}

/** Longest question or answer text in one `BM-HANDOVER` line (design §8). */
export const HANDOVER_TEXT_CHARS = 300;

const handoverText = (text: string): string => text.replace(/\s+/g, " ").trim().slice(0, HANDOVER_TEXT_CHARS);

/**
 * The `questions` lines of a Worker's `BM-HANDOVER` (design §8): every recorded
 * question in number order with its most recently recorded answer or `open`,
 * plus any answer whose question the ledger missed. Empty when the ledger
 * knows nothing of the request.
 */
export function handoverQuestionLines(ledger: Pick<QaLedger, "requests">, requestId: string): string[] {
  const listed = questionsWithAnswers(ledger, requestId);
  const known = new Set(listed.map((entry) => entry.question.id));
  const orphans = new Map<string, LedgerAnswer>();
  for (const answer of requestOf(ledger, requestId)?.answers ?? []) if (!known.has(answer.id)) orphans.set(answer.id, answer);
  const lines = [
    ...listed.map(({ question, answer }) => ({ id: question.id, text: handoverText(question.text), answer })),
    ...[...orphans].map(([id, answer]) => ({ id, text: "(question not recorded)", answer })),
  ].sort((a, b) => byNumber(a.id, b.id));
  return lines.map(({ id, text, answer }) => `- ${id}: ${text} → ${answer === null ? "open" : handoverText(answer.text)}`);
}

// ---------------------------------------------------------------------------
// What a timeline holds.
// ---------------------------------------------------------------------------

export interface FoundQuestion {
  requestId: string;
  id: string;
  text: string;
}

export interface FoundAnswer {
  requestId: string;
  id: string;
  text: string;
  via: "user" | "agent";
}

interface TimelineUserMessage {
  text: string;
  clientMessageId?: unknown;
}

function userMessage(item: unknown): TimelineUserMessage | null {
  if (item === null || typeof item !== "object") return null;
  const { type, text } = item as { type?: unknown; text?: unknown };
  if (type !== "user_message" || typeof text !== "string" || text === "") return null;
  return item as TimelineUserMessage;
}

const REQUEST_LINE = /^\s*(?:[-*]\s+)?requestId\s*:\s*`?(req-\d{8}T\d{6}Z)`?/im;
const ANY_REQUEST_ID = /\b(req-\d{8}T\d{6}Z)\b/;

/** Questions an agent sent the Manager: `BM-QUESTIONS` in a message without `clientMessageId`. */
export function questionsIn(items: readonly unknown[]): FoundQuestion[] {
  const out: FoundQuestion[] = [];
  for (const item of items) {
    const message = userMessage(item);
    if (message === null || typeof message.clientMessageId === "string" || isPluginNotice(message.text)) continue;
    const set = parseQuestions(message.text);
    if (set === null) continue;
    // A block without its own requestId belongs to the report right above it.
    const requestId = set.requestId ?? REQUEST_LINE.exec(message.text)?.[1] ?? null;
    if (requestId === null) continue;
    for (const question of set.questions) out.push({ requestId, id: question.id, text: question.text });
  }
  return out;
}

/** Answers that reached a Worker, from the app (`via: user`) or from an agent (`via: agent`). */
export function answersIn(items: readonly unknown[]): FoundAnswer[] {
  const out: FoundAnswer[] = [];
  for (const item of items) {
    const message = userMessage(item);
    if (message === null || isPluginNotice(message.text)) continue;
    const set = parseAnswers(message.text);
    // A block without its own requestId belongs to the request the message
    // names first: "Continue <requestId>." from the Manager, "Reply from the
    // user about `<requestId>`" from a card.
    const requestId = set?.requestId ?? ANY_REQUEST_ID.exec(message.text)?.[1] ?? null;
    if (set === null || requestId === null) continue;
    const via = typeof message.clientMessageId === "string" ? "user" : "agent";
    for (const answer of set.answers) out.push({ requestId, id: answer.id, text: answer.text, via });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Recording.
// ---------------------------------------------------------------------------

export interface RecordInput {
  workspaceId: string | null;
  /** The Worker the answers reached; null for questions. */
  workerId: string | null;
  questions: readonly FoundQuestion[];
  answers: readonly FoundAnswer[];
}

export interface RecordOptions {
  now?: () => Date;
  env?: NodeJS.ProcessEnv;
}

export interface RecordResult {
  /** Answers that were not in the ledger before this call, as stored. */
  addedAnswers: Array<LedgerAnswer & { requestId: string }>;
  /** The ledger as it is now. */
  ledger: QaLedger;
  /** False when nothing had to be written, or the file could not be written. */
  written: boolean;
}

function stored(text: string, env: NodeJS.ProcessEnv | undefined): string {
  const masked = redactText(text.replace(/\s+/g, " ").trim(), env);
  return masked.length <= QA_LEDGER_TEXT_CHARS ? masked : `${masked.slice(0, QA_LEDGER_TEXT_CHARS - 1)}…`;
}

/**
 * Adds what a turn end found. Synchronous from read to write. A question
 * already recorded only takes the newer text; an answer already recorded with
 * the same id and text is skipped. Throws on a symlinked path or a failed
 * write; the hook turns that into one log line.
 */
export function recordEntries(location: TraceStoreLocation, input: RecordInput, options: RecordOptions = {}): RecordResult {
  const now = (options.now ?? (() => new Date()))().toISOString();
  const ledger = readQaLedger(location);
  if (ledger.tooNew) return { addedAnswers: [], ledger, written: false };

  const requests = ledger.requests.map((entry) => ({ ...entry, questions: [...entry.questions], answers: [...entry.answers] }));
  const touched = new Set<string>();
  const entryFor = (requestId: string): LedgerRequest => {
    let entry = requests.find((candidate) => candidate.requestId === requestId);
    if (entry === undefined) {
      entry = { requestId, workspaceId: input.workspaceId, updatedAt: now, questions: [], answers: [] };
      requests.push(entry);
    }
    return entry;
  };

  // A question re-worded under the same number: only its newest wording in
  // this call is compared with the stored one, or a rescan of the whole
  // timeline would flip the text back and forth and rewrite the file each time.
  const newestQuestions = new Map<string, FoundQuestion>();
  for (const found of input.questions) newestQuestions.set(`${found.requestId}|${found.id}`, found);
  for (const found of newestQuestions.values()) {
    const entry = entryFor(found.requestId);
    const text = stored(found.text, options.env);
    const known = entry.questions.find((question) => question.id === found.id);
    if (known === undefined) {
      if (entry.questions.length >= QA_LEDGER_QUESTION_LIMIT) continue;
      entry.questions.push({ id: found.id, text, at: now });
      touched.add(entry.requestId);
    } else if (known.text !== text) {
      known.text = text;
      touched.add(entry.requestId);
    }
  }

  const addedAnswers: RecordResult["addedAnswers"] = [];
  for (const found of input.answers) {
    const entry = entryFor(found.requestId);
    const text = stored(found.text, options.env);
    if (text === "" || entry.answers.some((answer) => answer.id === found.id && answer.text === text)) continue;
    const answer: LedgerAnswer = { id: found.id, text, via: found.via, workerId: input.workerId, at: now };
    entry.answers.push(answer);
    if (entry.answers.length > QA_LEDGER_ANSWER_LIMIT) entry.answers.splice(0, entry.answers.length - QA_LEDGER_ANSWER_LIMIT);
    addedAnswers.push({ ...answer, requestId: entry.requestId });
    touched.add(entry.requestId);
  }

  if (touched.size === 0) return { addedAnswers, ledger: { ...ledger, requests }, written: false };
  for (const entry of requests) {
    if (!touched.has(entry.requestId)) continue;
    entry.updatedAt = now;
    if (entry.workspaceId === null) entry.workspaceId = input.workspaceId;
  }
  // The least recently updated go first; the order on disk is oldest first.
  const kept = [...requests].sort((a, b) => (a.updatedAt < b.updatedAt ? -1 : a.updatedAt > b.updatedAt ? 1 : 0)).slice(-QA_LEDGER_REQUEST_LIMIT);
  ensureStoreDir(location.tracesDir, join(dirname(location.tracesDir), UI_DIR_NAME));
  writeStoreFileAtomically(
    location,
    qaLedgerPath(location),
    `${JSON.stringify({ schemaVersion: QA_LEDGER_SCHEMA_VERSION, requests: kept }, null, 2)}\n`,
  );
  return { addedAnswers, ledger: { requests: kept, notices: [], tooNew: false }, written: true };
}

// ---------------------------------------------------------------------------
// The hook.
// ---------------------------------------------------------------------------

/** What the hook hands over; the timeline is the whole conversation. */
export interface QaTurnEvent {
  agent: { id: string; workspaceId: string | null; parentAgentId: string | null; provider: string };
  turnId?: string | null;
  timeline: readonly unknown[];
}

export interface QaTurnDeps {
  paseo: unknown;
  resolveLocation: LocationResolver;
  log?: (message: string) => void;
  now?: () => Date;
  env?: NodeJS.ProcessEnv;
  /** `enqueue` of the shared notice queue by default; tests pass a recorder. */
  notify?: (targetId: string, kind: string, text: string, paseo?: NoticePaseo) => Promise<NoticeOutcome>;
}

/** One `BM-ANSWERED` that went to the queue. */
export interface AnsweredNotice {
  managerId: string;
  requestId: string;
  outcome: NoticeOutcome;
}

export interface QaTurnOutcome {
  role: "manager" | "worker" | null;
  result: RecordResult | null;
  /** The `BM-ANSWERED` notices this turn end queued (§5). */
  notices?: AnsweredNotice[];
}

/** The queue kind of a request's `BM-ANSWERED`: one per request, so two Workers never replace each other's. */
export function answeredNoticeKind(requestId: string): string {
  return `${ANSWERED_NOTICE_MARKER}:${requestId}`;
}

/** The notice, word for word from design §5.3. */
export function answeredNotice(requestId: string, answered: readonly string[], open: readonly string[] | null): string {
  const ids = [...answered].sort(byNumber).join(", ");
  return [
    `${ANSWERED_NOTICE_MARKER} requestId: ${requestId}`,
    `The user answered ${ids} directly to the Worker (in its card or chat); the Worker has them. Those questions are closed: do not ask them again and do not relay answers to them. Tell the user in one line which Worker has its answers and what is still open.`,
    `Still open: ${open === null ? "unknown" : open.length === 0 ? "none" : [...open].sort(byNumber).join(", ")}.`,
  ].join("\n");
}

/**
 * The Manager a Worker's answers are reported to: its parent when that is a
 * live Manager (not archived, not closed, not replaced), otherwise the one
 * live Manager of its workspace; null when there is not exactly one.
 */
export async function managerOfWorker(paseo: unknown, worker: QaTurnEvent["agent"]): Promise<string | null> {
  const all = await bmAgentsOf(paseo as DashboardPaseo);
  const live = all.filter(
    ({ facts }) => facts.role === "manager" && !facts.archived && facts.status !== "closed" && (facts.replacedBy ?? null) === null,
  );
  const parent = live.find(({ facts }) => facts.id === worker.parentAgentId);
  if (parent !== undefined) return parent.facts.id;
  const here = live.filter((entry) => entry.workspaceId !== null && entry.workspaceId === worker.workspaceId);
  return here.length === 1 ? here[0]!.facts.id : null;
}

/** Queues one `BM-ANSWERED` per request for the answers of this turn end that qualify (§5.1). Never throws. */
async function tellManager(
  event: QaTurnEvent,
  timeline: readonly unknown[],
  result: RecordResult,
  deps: QaTurnDeps,
  log: (message: string) => void,
): Promise<AnsweredNotice[]> {
  const lastTurn = new Set(answersIn(sliceLastTurn(timeline)).map((answer) => `${answer.requestId}|${answer.id}`));
  const byRequest = new Map<string, string[]>();
  for (const answer of result.addedAnswers) {
    if (answer.via !== "user" || !lastTurn.has(`${answer.requestId}|${answer.id}`)) continue;
    const ids = byRequest.get(answer.requestId) ?? [];
    if (!ids.includes(answer.id)) ids.push(answer.id);
    byRequest.set(answer.requestId, ids);
  }
  if (byRequest.size === 0) return [];
  let managerId: string | null;
  try {
    managerId = await managerOfWorker(deps.paseo, event.agent);
  } catch (error) {
    log(`[paseo-bm] could not find the Manager of ${event.agent.id} to tell it about the user's answers: ${describeError(error)}`);
    return [];
  }
  if (managerId === null) {
    log(`[paseo-bm] ${event.agent.id} received the user's answers, but it has no single live Manager to tell; no BM-ANSWERED sent.`);
    return [];
  }
  const notify = deps.notify ?? enqueue;
  const out: AnsweredNotice[] = [];
  for (const [requestId, ids] of byRequest) {
    // No question recorded for the request (the Manager's turn end has not
    // been seen yet, or failed): what is open is unknown, never "none".
    const asked = (result.ledger.requests.find((entry) => entry.requestId === requestId)?.questions.length ?? 0) > 0;
    const text = answeredNotice(requestId, ids, asked ? openQuestionIds(result.ledger, requestId) : null);
    out.push({ managerId, requestId, outcome: await notify(managerId, answeredNoticeKind(requestId), text, deps.paseo as NoticePaseo) });
  }
  return out;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Handler body of `on("agent.turn_ended")`. Never throws. */
export async function recordTurn(event: QaTurnEvent, deps: QaTurnDeps): Promise<QaTurnOutcome> {
  const log = deps.log ?? ((message: string) => console.warn(message));
  try {
    const role = roleOfProvider(event?.agent?.provider);
    if (role !== "manager" && role !== "worker") return { role: null, result: null };
    const timeline = Array.isArray(event.timeline) ? event.timeline : [];
    const questions = role === "manager" ? questionsIn(timeline) : [];
    const answers = role === "worker" ? answersIn(timeline) : [];
    if (questions.length === 0 && answers.length === 0) return { role, result: null };
    const location = await deps.resolveLocation(deps.paseo);
    if (location === null) return { role, result: null };
    const result = recordEntries(
      location,
      { workspaceId: event.agent.workspaceId ?? null, workerId: role === "worker" ? event.agent.id : null, questions, answers },
      { now: deps.now, env: deps.env },
    );
    for (const notice of result.ledger.notices) log(`[paseo-bm] ${notice}`);
    const notices = role === "worker" ? await tellManager(event, timeline, result, deps, log) : [];
    return { role, result, notices };
  } catch (error) {
    log(`[paseo-bm] recording the questions and answers of ${event?.agent?.id ?? "an agent"} failed: ${describeError(error)}`);
    return { role: null, result: null };
  }
}

export type QaLedgerHost = Partial<Pick<PluginServerContext, "on">>;

export interface RegisterQaLedgerOptions {
  resolveLocation?: LocationResolver;
  log?: (message: string) => void;
}

/** Registers the ledger on `agent.turn_ended`; a no-op on a host without `on`. */
export function registerQaLedger(host: QaLedgerHost, options: RegisterQaLedgerOptions = {}): () => void {
  if (typeof host.on !== "function") return () => {};
  const resolveLocation = options.resolveLocation ?? createLocationResolver(resolveLocationFromPaseo);
  const remove = host.on("agent.turn_ended", async (event, context) => {
    await recordTurn(event as unknown as QaTurnEvent, { paseo: context.paseo, resolveLocation, log: options.log });
  });
  return typeof remove === "function" ? remove : () => {};
}
