/**
 * The simulated owner of the evaluation suite (design
 * docs/design/paseo-bm-evaluation.md §6.3).
 *
 * The suite must answer the same way on every run and every version, and must
 * count how much the owner had to do (A-3). So the owner is two layers:
 *
 * - **Pure** — the answer policy (`chooseWorkerAnswer`, `chooseDecisionAnswer`,
 *   `chooseStoredDecisionAnswer`), the text it sends (`workerAnswersBlock`, `workerReplyText`) and the
 *   Orchestrator miss rule (`isOrchestratorMiss`). No clock, no I/O.
 * - **I/O** — `SimulatedOwner`, which the driver calls with what it saw
 *   (`OwnerObservation`) and which acts through an injected `OwnerTransport`:
 *   a message to an agent, the way the app sends one (with `clientMessageId`,
 *   as `scripts/manual-test/send.mjs` does), or a plugin RPC.
 *
 * How the owner answers differs by version, so the channel is an adapter:
 *
 * - `0.4.1` — each open Worker question set gets a `BM-ANSWERS` block, sent to
 *   the waiting Worker as the card's Reply box sends it.
 * - `tree-autopilot` — the owner answers only what the Orchestrator puts to
 *   them: each pending decision through `orchestrator.ask { decisionId, text }`,
 *   each pending command proposal through `orchestrator.approve`. A Worker
 *   question the Orchestrator has not answered within ten minutes of being
 *   seen is answered as in `0.4.1` and logged as an Orchestrator miss, so the
 *   owner and the Orchestrator never answer the same question at once.
 * - `decision-rpc` — Phase 1 and later (autonomy design §A.13): the owner
 *   answers only through `decisions.answer`. It reads the unsettled decisions
 *   (`decisions.list { scope: "inbox" }`, or the list the driver passes) and
 *   answers each once, by the policy: the option an override names or the
 *   owner's words, else the recommended option. `confirmed: true` is sent
 *   exactly when the answer grants an effect of `CONFIRM_EFFECTS` — the card's
 *   in-place confirmation, one more action (`confirmations`). It never sends a message, never reads
 *   Worker questions, never calls a retired RPC (`chat.waiting`,
 *   `orchestrator.state`, `orchestrator.ask`/`approve`), and never answers a
 *   settled decision.
 *
 * The owner never answers a Paseo permission request: when the driver reports
 * one pending, the owner takes no action at all, from then on, and says the
 * scenario "needed a human".
 *
 * Every message and every answering RPC call is one action (A-3), as in every
 * channel (`tree-autopilot` also sends `confirmed: true` in its one call);
 * reading `orchestrator.state` or `decisions.list` is not. The in-place
 * confirmation an answer granting a release, data, security or cost effect
 * needs (X-4) is a real tap, so it is one more action; `confirmations` also
 * counts it on its own (A-3's target is 2 for such a decision, 1 otherwise —
 * autonomy PRD §5). Each answer is logged with its source and the policy rule
 * that chose it.
 */
import { answersText, type Pick, type Question, type QuestionOption } from "../../plugin/shared/bm-questions.js";
import {
  decisionSchema,
  effectsOfAnswer,
  isAnswerable,
  needsOwnerConfirmation,
  type Decision,
  type Effect,
} from "../../plugin/shared/decisions.js";
import type { Proposal } from "../../plugin/shared/orchestrator.js";
import { legacyOrchestratorStateRpc } from "./legacy-contracts.js";
import type { Owner } from "./scenario.js";

// ── Constants ────────────────────────────────────────────────────────────────

/** A Worker question the Orchestrator leaves this long is the owner's (design §6.3). */
export const ORCHESTRATOR_MISS_MS = 10 * 60 * 1000;

/**
 * The owner's words for a Worker question with no single recommended option
 * and no override: the card pre-fills nothing then, so a person would type.
 * Fixed, so every run answers alike.
 */
export const NO_RECOMMENDATION_WORDS = "No preference: choose what you think best and say which.";

/** The owner's words for a decision whose recommendation names none of its options (or that has none). */
export const FOLLOW_RECOMMENDATION_WORDS = "Go with your recommendation.";

/**
 * The head the chat card's Reply box put before what the user sent. Cards v2
 * (autonomy design §A.12) have no Reply box — the owner answers through
 * `decisions.answer` — but a Worker still reads a message in this shape as
 * the owner's typed answer, so the chat channel keeps writing it.
 */
export function workerReplyText(requestId: string, block: string): string {
  return `Reply from the user about \`${requestId}\`:\n\n${block.trim()}`;
}

// ── Policy (pure) ────────────────────────────────────────────────────────────

/** Which rule chose an answer. */
export type PolicyRule = "override" | "recommended" | "no-recommendation";

/** The answer to one Worker question, and why. */
export interface WorkerChoice {
  pick: Pick;
  rule: PolicyRule;
  /** The override keyword that matched, or null. */
  keyword: string | null;
  /** Why a matching override was not used (it named no option of the question), or null. */
  note: string | null;
}

/** The answer to one Orchestrator decision, and why. */
export interface DecisionChoice {
  /** The text sent as the owner's answer: an option as written, or words. */
  text: string;
  rule: PolicyRule;
  keyword: string | null;
  note: string | null;
}

type Override = Owner["overrides"][number];

/** The first override whose keyword appears in `text`, case-insensitively (scenario.ts: the first match wins). */
export function matchOverride(owner: Owner, text: string): Override | null {
  const haystack = text.toLowerCase();
  return owner.overrides.find((entry) => haystack.includes(entry.keyword.toLowerCase())) ?? null;
}

/** `"A"` → 0, `"B"` → 1, … */
function letterIndex(letter: string): number {
  return letter.toUpperCase().charCodeAt(0) - "A".charCodeAt(0);
}

function singleRecommended(options: readonly QuestionOption[]): QuestionOption | null {
  const marked = options.filter((option) => option.recommended);
  return marked.length === 1 ? marked[0]! : null;
}

/**
 * The owner's answer to one Worker question: an override whose keyword is in
 * the question text, else the one `(recommended)` option, else fixed words.
 * An override letter maps to the option key of the same letter (`A` → `a`); a
 * letter the question does not have falls through to the next rule, with a note.
 */
export function chooseWorkerAnswer(owner: Owner, question: Pick_<Question, "text" | "options">): WorkerChoice {
  const override = matchOverride(owner, question.text);
  let note: string | null = null;
  if (override !== null) {
    if ("words" in override.answer) {
      return { pick: { other: override.answer.words }, rule: "override", keyword: override.keyword, note: null };
    }
    const key = override.answer.option.toLowerCase();
    if (question.options.some((option) => option.key === key)) {
      return { pick: { key }, rule: "override", keyword: override.keyword, note: null };
    }
    note = `override "${override.keyword}" names option ${override.answer.option}, which the question does not have`;
  }
  const recommended = singleRecommended(question.options);
  if (recommended !== null) return { pick: { key: recommended.key }, rule: "recommended", keyword: null, note };
  return { pick: { other: NO_RECOMMENDATION_WORDS }, rule: "no-recommendation", keyword: null, note };
}

function normalised(text: string): string {
  return text.normalize("NFC").toLowerCase().replace(/\s+/g, " ").trim();
}

const WORD_CHAR = /[\p{L}\p{N}_]/u;

/** `needle` occurs in `haystack` as whole words: "no" is not in "know". */
function containsWords(haystack: string, needle: string): boolean {
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + 1)) {
    const before = at === 0 ? "" : haystack[at - 1]!;
    const after = haystack[at + needle.length] ?? "";
    const edgeBefore = before === "" || !WORD_CHAR.test(before) || !WORD_CHAR.test(needle[0]!);
    const edgeAfter = after === "" || !WORD_CHAR.test(after) || !WORD_CHAR.test(needle.at(-1)!);
    if (edgeBefore && edgeAfter) return true;
  }
  return false;
}

/**
 * The option a decision's recommendation names: the longest option whose text
 * appears in the recommendation as whole words (case- and
 * whitespace-insensitive), the first of equals; null when it names none.
 */
export function recommendedDecisionOption(options: readonly string[], recommendation: string): string | null {
  const reason = normalised(recommendation);
  if (reason === "") return null;
  let best: string | null = null;
  for (const option of options) {
    const text = normalised(option);
    if (text === "" || !containsWords(reason, text)) continue;
    if (best === null || text.length > normalised(best).length) best = option;
  }
  return best;
}

/**
 * The owner's answer to one Orchestrator decision (`command` holds the
 * question, `reason` the recommendation, `options` the buttons): an override
 * whose keyword is in the question — a letter is the option at that position,
 * as the tab's buttons are ordered — else the option the recommendation
 * names, else `FOLLOW_RECOMMENDATION_WORDS`.
 */
export function chooseDecisionAnswer(owner: Owner, decision: Pick_<Proposal, "command" | "reason" | "options">): DecisionChoice {
  const options = decision.options ?? [];
  const override = matchOverride(owner, decision.command);
  let note: string | null = null;
  if (override !== null) {
    if ("words" in override.answer) return { text: override.answer.words, rule: "override", keyword: override.keyword, note: null };
    const option = options[letterIndex(override.answer.option)];
    if (option !== undefined) return { text: option, rule: "override", keyword: override.keyword, note: null };
    note = `override "${override.keyword}" names option ${override.answer.option}, which the decision does not have`;
  }
  const recommended = recommendedDecisionOption(options, decision.reason);
  if (recommended !== null) return { text: recommended, rule: "recommended", keyword: null, note };
  return { text: FOLLOW_RECOMMENDATION_WORDS, rule: "recommended", keyword: null, note };
}

/** Exactly the `BM-ANSWERS` block of the plugin's cards (`answersText`), one line per question, in order. */
export function workerAnswersBlock(requestId: string, questions: readonly Question[], choices: ReadonlyMap<string, WorkerChoice>): string {
  const picks: Record<string, Pick> = {};
  for (const [id, choice] of choices) picks[id] = choice.pick;
  return answersText(requestId, questions, picks);
}

/** True once a Worker question first seen at `firstSeenAt` has waited `missAfterMs` without the Orchestrator answering it. */
export function isOrchestratorMiss(firstSeenAt: number, now: number, missAfterMs: number = ORCHESTRATOR_MISS_MS): boolean {
  return now - firstSeenAt >= missAfterMs;
}

/** The RPCs of the `decision-rpc` channel (`plugin/shared/contracts.ts`): the only ones it calls. */
export const DECISIONS_LIST_RPC = "decisions.list";
export const DECISIONS_ANSWER_RPC = "decisions.answer";

/** The owner's answer to one stored decision (autonomy design §A.3), and why. */
export interface StoredDecisionChoice {
  /** The option chosen, or null for an answer in words. */
  optionKey: string | null;
  /** The owner's own words, or null for an option. */
  words: string | null;
  rule: PolicyRule;
  keyword: string | null;
  note: string | null;
  /** What the answer grants (`effectsOfAnswer`). */
  effects: Effect[];
  /** True when those effects need the owner's explicit confirmation (`CONFIRM_EFFECTS`). */
  confirmed: boolean;
}

/** The recommendation an Orchestrator decision carries in its question (`Recommendation: …`), or null. */
export function recommendationOf(question: string): string | null {
  const match = /(?:^|\n)\s*Recommendation:\s*([\s\S]*)$/i.exec(question);
  const text = match?.[1]?.trim() ?? "";
  return text === "" ? null : text;
}

/**
 * The owner's answer to one stored decision, by the same policy as the other
 * channels: an override whose keyword is in the question — its words, or its
 * letter as the option of that key (`A` → `a`), else the option at that
 * position — then the one recommended option, then the option the question's
 * `Recommendation:` names, then fixed words (`FOLLOW_RECOMMENDATION_WORDS`
 * when the question recommends something, `NO_RECOMMENDATION_WORDS` when not).
 */
export function chooseStoredDecisionAnswer(owner: Owner, decision: Pick_<Decision, "question" | "options">): StoredDecisionChoice {
  const done = (optionKey: string | null, words: string | null, rule: PolicyRule, keyword: string | null, note: string | null): StoredDecisionChoice => {
    const effects = effectsOfAnswer(decision, { optionKey });
    return { optionKey, words, rule, keyword, note, effects, confirmed: needsOwnerConfirmation(effects) };
  };
  const options = decision.options;
  const override = matchOverride(owner, decision.question);
  let note: string | null = null;
  if (override !== null) {
    if ("words" in override.answer) return done(null, override.answer.words, "override", override.keyword, null);
    const letter = override.answer.option;
    const option = options.find((entry) => entry.key === letter.toLowerCase()) ?? options[letterIndex(letter)];
    if (option !== undefined) return done(option.key, null, "override", override.keyword, null);
    note = `override "${override.keyword}" names option ${letter}, which the decision does not have`;
  }
  const marked = options.filter((option) => option.recommended);
  if (marked.length === 1) return done(marked[0]!.key, null, "recommended", null, note);
  const recommendation = recommendationOf(decision.question);
  if (recommendation !== null) {
    const label = recommendedDecisionOption(
      options.map((option) => option.label),
      recommendation,
    );
    const named = label === null ? undefined : options.find((option) => option.label === label);
    if (named !== undefined) return done(named.key, null, "recommended", null, note);
    return done(null, FOLLOW_RECOMMENDATION_WORDS, "recommended", null, note);
  }
  return done(null, NO_RECOMMENDATION_WORDS, "no-recommendation", null, note);
}

/**
 * The decisions of a `decisions.list` answer that can still be answered
 * (`open`, `needs-confirmation`), oldest asked first, each id once. An entry
 * that does not parse as a decision is left out.
 */
export function answerableDecisions(listed: unknown): Decision[] {
  const entries = (listed !== null && typeof listed === "object" && Array.isArray((listed as { decisions?: unknown }).decisions)
    ? (listed as { decisions: unknown[] }).decisions
    : Array.isArray(listed)
      ? listed
      : []) as unknown[];
  const seen = new Set<string>();
  const out: Decision[] = [];
  for (const entry of entries) {
    const parsed = decisionSchema.safeParse(entry);
    if (!parsed.success || !isAnswerable(parsed.data) || seen.has(parsed.data.id)) continue;
    seen.add(parsed.data.id);
    out.push(parsed.data);
  }
  return out.sort((a, b) => a.askedAt.localeCompare(b.askedAt) || a.id.localeCompare(b.id));
}

/** TypeScript's `Pick`, renamed: `Pick` here is the answer type of bm-questions. */
type Pick_<T, K extends keyof T> = { [P in K]: T[P] };

// ── What the driver passes in ─────────────────────────────────────────────────

/** How the owner acts on the daemon. The driver wraps its DaemonClient; tests use a fake. */
export interface OwnerTransport {
  /** Sends `text` to the agent as the app does: a real user message, with a `clientMessageId`. */
  sendToAgent(agentId: string, text: string): Promise<void>;
  /** Calls a plugin RPC of paseo-bm by its contract name. */
  rpc(method: string, input: unknown): Promise<unknown>;
  /** Milliseconds since the epoch. */
  now(): number;
}

/** A Worker's open `BM-QUESTIONS`, as the driver saw it. */
export interface OpenWorkerQuestions {
  workerId: string;
  /** From the question block; null when the Worker gave none (then nothing can be answered). */
  requestId: string | null;
  questions: readonly Question[];
  /** When the driver first saw these questions (ms since the epoch): the miss rule counts from here. */
  firstSeenAt: number;
}

/** A Paseo permission request the driver saw pending. The owner never answers one. */
export interface PendingPermission {
  agentId: string;
  /** What Paseo shows for it, for the record. */
  title?: string;
}

/**
 * What the orchestrator part of the owner reads: the pending entries of
 * `orchestrator.state` of a build before Phase 1 (`legacy-contracts.ts`).
 */
export interface OrchestratorView {
  approvals: Proposal[];
  decisions?: Proposal[];
}

export interface OwnerObservation {
  /** `decision-rpc` only: the decisions the driver read (`decisions.list`); absent, the owner reads them itself. */
  decisions?: readonly unknown[];
  /** `decision-rpc` only: the workspace the owner reads its decisions from when it reads them itself; absent, every workspace. */
  workspaceId?: string;
  /** Worker questions still open (the driver drops a set once the Worker reported again). */
  workerQuestions?: readonly OpenWorkerQuestions[];
  /** `tree-autopilot` only: the state the driver read; absent, the owner reads `orchestrator.state` itself. */
  orchestratorState?: OrchestratorView;
  /** Pending Paseo permission requests. Any at all: the owner acts no more. */
  permissions?: readonly PendingPermission[];
}

// ── What the owner reports ───────────────────────────────────────────────────

export type ChannelName = "0.4.1" | "tree-autopilot" | "decision-rpc";

/**
 * Where an answer went:
 * - `worker-questions`: a `BM-ANSWERS` block to a Worker (channel `0.4.1`);
 * - `orchestrator-miss`: the same, in `tree-autopilot`, after the Orchestrator
 *   left the question ten minutes;
 * - `orchestrator-decision`: `orchestrator.ask` with a `decisionId`;
 * - `orchestrator-proposal`: `orchestrator.approve`;
 * - `decision`: `decisions.answer` on a stored decision (channel `decision-rpc`).
 */
export type AnswerSource = "worker-questions" | "orchestrator-miss" | "orchestrator-decision" | "orchestrator-proposal" | "decision";

export interface AnsweredItem {
  /** `Q<n>` for a Worker question, the proposal id for a decision or a proposal, the decision id for a stored decision. */
  id: string;
  /** The question as the owner saw it (a proposal's command). */
  question: string;
  /** The answer line (`a — …`, `other — …`) or the text sent. */
  answer: string;
  rule: PolicyRule | "approve-as-proposed";
  keyword: string | null;
  note: string | null;
}

export interface OwnerLogEntry {
  /** ISO time of the action. */
  at: string;
  channel: ChannelName;
  source: AnswerSource;
  /** The agent messaged, or the RPC called. */
  target: { agentId: string } | { rpc: string };
  workspaceId: string | null;
  requestId: string | null;
  items: AnsweredItem[];
  /** The exact message text or RPC input `text`. */
  text: string;
  /** Messages and answering calls this answer took; a `confirmed` answer's tap is one more (A-3). */
  actions: number;
  /** `decision-rpc`: the answer was sent with `confirmed: true` (its effects needed the owner's confirmation). */
  confirmed?: boolean;
  /** Set when the send or the call failed; the item is not tried again. */
  error: string | null;
}

export interface NeededHuman {
  at: string;
  permissions: PendingPermission[];
}

export interface OwnerCounts {
  /** Messages sent to agents. */
  messages: number;
  /** RPC calls that answered or approved. */
  rpcCalls: number;
  /** Answers sent with `confirmed: true` (X-4's in-place confirmation, one tap each). */
  confirmations: number;
  /** `messages + rpcCalls + confirmations`: every message, answering call and confirmation tap (A-3). */
  actions: number;
  /** Worker questions the owner answered because the Orchestrator had not. */
  misses: number;
}

export type OwnerStepResult =
  | { status: "acted"; entries: OwnerLogEntry[] }
  | { status: "idle"; entries: [] }
  | { status: "needed-a-human"; neededHuman: NeededHuman; entries: [] };

// ── Channels (I/O) ───────────────────────────────────────────────────────────

/** What a channel can do: the owner's policy and its counted, logged actions. */
export interface ChannelContext {
  readonly owner: Owner;
  readonly channel: ChannelName;
  readonly transport: OwnerTransport;
  readonly missAfterMs: number;
  /** Answers the still-unanswered questions of one Worker set with one message; null when none is left. */
  answerWorker(open: OpenWorkerQuestions, source: "worker-questions" | "orchestrator-miss"): Promise<OwnerLogEntry | null>;
  /** Answers or approves one pending Orchestrator entry once; null when already handled. */
  answerProposal(proposal: Proposal): Promise<OwnerLogEntry | null>;
  /** Answers one stored decision once through `decisions.answer`; null when already answered or no longer answerable. */
  answerDecision(decision: Decision): Promise<OwnerLogEntry | null>;
}

/** One way of answering: a channel in `CHANNELS`; the policy, the log and the counters are shared. */
export interface OwnerChannel {
  readonly name: ChannelName;
  step(observation: OwnerObservation, context: ChannelContext): Promise<OwnerLogEntry[]>;
}

function byFirstSeen(questions: readonly OpenWorkerQuestions[]): OpenWorkerQuestions[] {
  return [...questions].sort((a, b) => a.firstSeenAt - b.firstSeenAt || a.workerId.localeCompare(b.workerId));
}

function present(entries: Array<OwnerLogEntry | null>): OwnerLogEntry[] {
  return entries.filter((entry): entry is OwnerLogEntry => entry !== null);
}

/** Channel `0.4.1`: every open Worker question set, at once. */
export const channel041: OwnerChannel = {
  name: "0.4.1",
  async step(observation, context) {
    const entries: Array<OwnerLogEntry | null> = [];
    for (const open of byFirstSeen(observation.workerQuestions ?? [])) {
      entries.push(await context.answerWorker(open, "worker-questions"));
    }
    return present(entries);
  },
};

/** Pending decisions and command proposals of `orchestrator.state`, oldest first, each id once. */
export function pendingForOwner(view: OrchestratorView): Proposal[] {
  const seen = new Set<string>();
  const pending: Proposal[] = [];
  for (const entry of [...view.approvals, ...(view.decisions ?? [])]) {
    if (entry.status !== "pending" || seen.has(entry.id)) continue;
    seen.add(entry.id);
    pending.push(entry);
  }
  return pending.sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
}

/** Channel `tree-autopilot`: what the Orchestrator asks the owner, then the Worker questions it missed. */
export const channelTreeAutopilot: OwnerChannel = {
  name: "tree-autopilot",
  async step(observation, context) {
    const view = observation.orchestratorState ?? legacyOrchestratorStateRpc.output.parse(await context.transport.rpc(legacyOrchestratorStateRpc.name, {}));
    const entries: Array<OwnerLogEntry | null> = [];
    for (const proposal of pendingForOwner(view)) entries.push(await context.answerProposal(proposal));
    const now = context.transport.now();
    for (const open of byFirstSeen(observation.workerQuestions ?? [])) {
      if (!isOrchestratorMiss(open.firstSeenAt, now, context.missAfterMs)) continue;
      entries.push(await context.answerWorker(open, "orchestrator-miss"));
    }
    return present(entries);
  },
};

/**
 * Channel `decision-rpc`: every unsettled decision, oldest asked first, each
 * answered once through `decisions.answer`. Worker questions and Orchestrator
 * proposals in the observation are ignored: in this build the Inbox holds
 * everything that waits for the owner.
 */
export const channelDecisionRpc: OwnerChannel = {
  name: "decision-rpc",
  async step(observation, context) {
    const listed =
      observation.decisions ??
      (await context.transport.rpc(DECISIONS_LIST_RPC, { scope: "inbox", ...(observation.workspaceId === undefined ? {} : { workspaceId: observation.workspaceId }) }));
    const entries: Array<OwnerLogEntry | null> = [];
    for (const decision of answerableDecisions(listed)) {
      if (observation.workspaceId !== undefined && decision.workspaceId !== observation.workspaceId) continue;
      entries.push(await context.answerDecision(decision));
    }
    return present(entries);
  },
};

/** The implemented channels. */
export const CHANNELS: Readonly<Record<ChannelName, OwnerChannel>> = {
  "0.4.1": channel041,
  "tree-autopilot": channelTreeAutopilot,
  "decision-rpc": channelDecisionRpc,
};

export interface SimulatedOwnerOptions {
  /** The scenario's `owner` section. */
  owner: Owner;
  channel: ChannelName;
  transport: OwnerTransport;
  /** Tests only: the miss rule's wait; default ten minutes. */
  missAfterMs?: number;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function answerLine(question: Question, pick: Pick): string {
  if ("other" in pick) return `other — ${pick.other}`;
  const option = question.options.find((candidate) => candidate.key === pick.key);
  return `${pick.key} — ${option?.text ?? ""}`;
}

/**
 * The owner of one scenario run. The driver calls `step` with what it saw,
 * as often as it likes: an item is answered once, and never again.
 */
export class SimulatedOwner {
  readonly #options: Required<SimulatedOwnerOptions>;
  readonly #channel: OwnerChannel;
  readonly #log: OwnerLogEntry[] = [];
  /** `workerId|requestId|Qn` of every Worker question answered. */
  readonly #answeredQuestions = new Set<string>();
  /** Proposal ids answered or approved. */
  readonly #answeredProposals = new Set<string>();
  /** Stored decision ids answered (or tried) through `decisions.answer`. */
  readonly #answeredDecisions = new Set<string>();
  /** Worker sets with no request id, already logged. */
  readonly #unanswerable = new Set<string>();
  #counts: OwnerCounts = { messages: 0, rpcCalls: 0, confirmations: 0, actions: 0, misses: 0 };
  #neededHuman: NeededHuman | null = null;

  constructor(options: SimulatedOwnerOptions) {
    const channel = CHANNELS[options.channel] as OwnerChannel | undefined;
    if (channel === undefined) throw new Error(`Unknown owner channel "${options.channel}".`);
    this.#channel = channel;
    this.#options = { missAfterMs: ORCHESTRATOR_MISS_MS, ...options };
  }

  get channel(): ChannelName {
    return this.#options.channel;
  }

  /** Every answer so far, in the order given. */
  get log(): readonly OwnerLogEntry[] {
    return this.#log;
  }

  get counts(): Readonly<OwnerCounts> {
    return { ...this.#counts };
  }

  /** Set once a permission request was seen; the owner has not acted since. */
  get neededHuman(): NeededHuman | null {
    return this.#neededHuman;
  }

  /**
   * A-3 input: for each answer that reached its target, the actions it took.
   * A decision here is one thing put to the owner at one time — a Worker's
   * question set, an Orchestrator decision, a proposal.
   */
  ownerActionsPerDecision(): number[] {
    return this.#log.filter((entry) => entry.error === null).map((entry) => entry.actions + (entry.confirmed === true ? 1 : 0));
  }

  async step(observation: OwnerObservation): Promise<OwnerStepResult> {
    if (this.#neededHuman === null && (observation.permissions?.length ?? 0) > 0) {
      this.#neededHuman = { at: this.#isoNow(), permissions: [...observation.permissions!] };
    }
    if (this.#neededHuman !== null) return { status: "needed-a-human", neededHuman: this.#neededHuman, entries: [] };
    const entries = await this.#channel.step(observation, this.#context());
    return entries.length === 0 ? { status: "idle", entries: [] } : { status: "acted", entries };
  }

  #isoNow(): string {
    return new Date(this.#options.transport.now()).toISOString();
  }

  #context(): ChannelContext {
    return {
      owner: this.#options.owner,
      channel: this.#options.channel,
      transport: this.#options.transport,
      missAfterMs: this.#options.missAfterMs,
      answerWorker: (open, source) => this.#answerWorker(open, source),
      answerProposal: (proposal) => this.#answerProposal(proposal),
      answerDecision: (decision) => this.#answerDecision(decision),
    };
  }

  #record(entry: OwnerLogEntry, kind: "message" | "rpc", miss: boolean): OwnerLogEntry {
    this.#log.push(entry);
    if (kind === "message") this.#counts.messages += entry.actions;
    else this.#counts.rpcCalls += entry.actions;
    this.#counts.actions += entry.actions;
    if (entry.confirmed === true) {
      this.#counts.confirmations += 1;
      this.#counts.actions += 1;
    }
    if (miss) this.#counts.misses += 1;
    return entry;
  }

  async #answerWorker(open: OpenWorkerQuestions, source: "worker-questions" | "orchestrator-miss"): Promise<OwnerLogEntry | null> {
    const keyOf = (question: Question) => `${open.workerId}|${open.requestId ?? ""}|${question.id}`;
    const questions = open.questions.filter((question) => !this.#answeredQuestions.has(keyOf(question)));
    if (questions.length === 0) return null;
    const requestId = open.requestId;
    if (requestId === null) {
      // No request id, no block the Worker can match: logged once, never sent.
      const setKey = `${open.workerId}|${questions.map((question) => question.id).join(",")}`;
      if (this.#unanswerable.has(setKey)) return null;
      this.#unanswerable.add(setKey);
      const entry: OwnerLogEntry = {
        at: this.#isoNow(),
        channel: this.#options.channel,
        source,
        target: { agentId: open.workerId },
        workspaceId: null,
        requestId: null,
        items: [],
        text: "",
        actions: 0,
        error: "the questions carry no requestId, so no BM-ANSWERS block can answer them",
      };
      this.#log.push(entry);
      return entry;
    }
    const choices = new Map(questions.map((question) => [question.id, chooseWorkerAnswer(this.#options.owner, question)] as const));
    const text = workerReplyText(requestId, workerAnswersBlock(requestId, questions, choices));
    for (const question of questions) this.#answeredQuestions.add(keyOf(question));
    let error: string | null = null;
    try {
      await this.#options.transport.sendToAgent(open.workerId, text);
    } catch (failure) {
      error = errorText(failure);
    }
    return this.#record(
      {
        at: this.#isoNow(),
        channel: this.#options.channel,
        source,
        target: { agentId: open.workerId },
        workspaceId: null,
        requestId,
        items: questions.map((question) => {
          const choice = choices.get(question.id)!;
          return { id: question.id, question: question.text, answer: answerLine(question, choice.pick), rule: choice.rule, keyword: choice.keyword, note: choice.note };
        }),
        text,
        actions: 1,
        error,
      },
      "message",
      source === "orchestrator-miss",
    );
  }

  async #answerProposal(proposal: Proposal): Promise<OwnerLogEntry | null> {
    if (this.#answeredProposals.has(proposal.id)) return null;
    this.#answeredProposals.add(proposal.id);
    let method: string;
    let input: Record<string, unknown>;
    let item: AnsweredItem;
    let source: AnswerSource;
    if (proposal.kind === "decision") {
      const choice = chooseDecisionAnswer(this.#options.owner, proposal);
      method = "orchestrator.ask";
      input = { decisionId: proposal.id, text: choice.text };
      item = { id: proposal.id, question: proposal.command, answer: choice.text, rule: choice.rule, keyword: choice.keyword, note: choice.note };
      source = "orchestrator-decision";
    } else {
      // A proposed command is approved as proposed: the owner's Send on the tab.
      method = "orchestrator.approve";
      input = { proposalId: proposal.id, text: proposal.command, confirmed: true };
      item = { id: proposal.id, question: proposal.command, answer: proposal.command, rule: "approve-as-proposed", keyword: null, note: null };
      source = "orchestrator-proposal";
    }
    let error: string | null = null;
    try {
      await this.#options.transport.rpc(method, input);
    } catch (failure) {
      error = errorText(failure);
    }
    return this.#record(
      {
        at: this.#isoNow(),
        channel: this.#options.channel,
        source,
        target: { rpc: method },
        workspaceId: proposal.workspaceId,
        requestId: proposal.requestId,
        items: [item],
        text: String(input.text),
        actions: 1,
        error,
      },
      "rpc",
      false,
    );
  }

  async #answerDecision(decision: Decision): Promise<OwnerLogEntry | null> {
    // A settled decision is never answered; one answered (or tried) once never again.
    if (!isAnswerable(decision) || this.#answeredDecisions.has(decision.id)) return null;
    this.#answeredDecisions.add(decision.id);
    const choice = chooseStoredDecisionAnswer(this.#options.owner, decision);
    const input: Record<string, unknown> = {
      id: decision.id,
      ...(choice.optionKey === null ? { words: choice.words } : { optionKey: choice.optionKey }),
      via: "inbox",
      ...(choice.confirmed ? { confirmed: true } : {}),
    };
    const label = choice.optionKey === null ? null : (decision.options.find((option) => option.key === choice.optionKey)?.label ?? "");
    const answer = choice.optionKey === null ? (choice.words ?? "") : `${choice.optionKey} — ${label}`;
    let error: string | null = null;
    try {
      await this.#options.transport.rpc(DECISIONS_ANSWER_RPC, input);
    } catch (failure) {
      error = errorText(failure);
    }
    return this.#record(
      {
        at: this.#isoNow(),
        channel: this.#options.channel,
        source: "decision",
        target: { rpc: DECISIONS_ANSWER_RPC },
        workspaceId: decision.workspaceId,
        requestId: decision.requestId,
        items: [{ id: decision.id, question: decision.question, answer, rule: choice.rule, keyword: choice.keyword, note: choice.note }],
        text: answer,
        actions: 1,
        ...(choice.confirmed ? { confirmed: true } : {}),
        error,
      },
      "rpc",
      false,
    );
  }
}
