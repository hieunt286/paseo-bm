/**
 * The Missions screen's model (missions design §10; the approved mockup
 * `docs/design/mockups/missions-screen.html`, artboards A–F): what the list
 * card, a mission's page, the New mission form and a project's memory show,
 * and the words of §10.3 — the mission classes, the level sentences, one
 * sentence per governor figure, the Main's state chip.
 *
 * The data comes from `missions.list`, `mission.get` and `memory.list`
 * (`shared/contracts/missions.ts`); `missions.tsx` reads it and draws this.
 *
 * Pure: no React, no React Native, no `server/` import.
 */
import type { MemoryListOutput, MissionFigure, MissionGetOutput, MissionPlacement, MissionRow, MissionSignal, MissionSummary, MissionsCreateInput } from "../shared/contracts";
import { MISSION_CLASSES, DEFAULT_MISSION_LEVEL, type MissionClass, type MissionLevel } from "../shared/autonomy";
import { MISSION_CHANGE_CODE_PATTERN } from "../shared/mission-change";
import { ago, clockText, localTimeText, ordinal, shortRequestOf, shortSpan } from "./format";
import type { Badge, Tone } from "./tone";
import type { ConfirmDialog } from "./ui-types";

/** A repository's name by its workspace id; null when no project of that id is known. */
export type NameOf = (workspaceId: string) => string | null;

// ---------------------------------------------------------------------------
// The words (§10.3).
// ---------------------------------------------------------------------------

/** What each mission class lets the Main do, on the page's level card. */
export const MISSION_CLASS_WORDS: Readonly<Record<MissionClass, string>> = {
  proceed: "going on to the next step",
  staffing: "creating Workers",
  "scope-repo": "adding a repository",
  "answer-technical": "Workers' technical questions your repos keep for you",
  "answer-effects": "Workers' questions with effects your repos keep for you",
  split: "splitting the mission",
};

/** The list card's short words. */
export const MISSION_CLASS_SHORT: Readonly<Record<MissionClass, string>> = {
  proceed: "proceed",
  staffing: "staffing",
  "scope-repo": "scope",
  "answer-technical": "answers",
  "answer-effects": "effects",
  split: "split",
};

/** Both answer classes on the same side read as one phrase (the artboard's "Yours:"). */
const BOTH_ANSWERS = "Workers' questions your repos keep for you";

/** What the Main does by itself at each level. */
export const MISSION_LEVEL_SENTENCES: Readonly<Record<MissionLevel, string>> = {
  0: "The Main asks you before each step.",
  1: "The Main goes on to next steps by itself.",
  2: "The Main goes on to next steps and creates Workers by itself.",
  3: "The Main goes on to next steps, creates Workers and decides Workers' technical questions by itself.",
  4: "The Main goes on to next steps, creates Workers, decides Workers' technical questions, adds repositories, decides questions with effects and lets the governor split the mission.",
};

/** The form's line under the level: "Level 2: the Main goes on to next steps and creates Workers by itself." */
export function levelSentenceOf(level: MissionLevel): string {
  const sentence = MISSION_LEVEL_SENTENCES[level];
  return `Level ${level}: ${sentence.charAt(0).toLowerCase()}${sentence.slice(1)}`;
}

/** The in-place confirmation of level 3 or 4 (`levelNeedsConfirmation`, `shared/autonomy.ts`); `code` names the mission (null in the New mission form). */
export function levelConfirmDialog(level: MissionLevel, code: string | null): ConfirmDialog {
  const answers = level === 4 ? "its Workers' questions, those with effects included, and add repositories" : "its Workers' technical questions";
  return {
    title: code === null ? `Use level ${level}?` : `Set ${code} to level ${level}?`,
    body: `At level ${level} the Main decides ${answers} that your repos keep for you. What an answer lets a Worker do still passes each repo's action boundary. You can lower the level at any time.`,
    confirmLabel: `Set level ${level}`,
    cancelLabel: "Cancel",
    defaultAction: "cancel",
  };
}

/** The in-place confirmation of Close mission. */
export function closeMissionDialog(code: string): ConfirmDialog {
  return {
    title: `Close ${code}?`,
    body: "The mission closes: its Main is not replaced and its files stay. A Worker of the mission still at work must stop first.",
    bodyTone: "plain",
    confirmLabel: "Close mission",
    confirmKind: "danger",
    cancelLabel: "Cancel",
    defaultAction: "cancel",
  };
}

/** Class words joined with " · ", the two answer classes as one phrase when both are on the same side. */
export function classWordsOf(classes: readonly MissionClass[]): string {
  const both = classes.includes("answer-technical") && classes.includes("answer-effects");
  const words: string[] = [];
  for (const name of MISSION_CLASSES) {
    if (!classes.includes(name)) continue;
    if (both && name === "answer-effects") continue;
    words.push(both && name === "answer-technical" ? BOTH_ANSWERS : MISSION_CLASS_WORDS[name]);
  }
  return words.join(" · ");
}

/** The list card's "level 2 · proceed, staffing". */
export function levelLineOf(summary: Pick<MissionSummary, "level" | "delegated">): string {
  if (summary.delegated.length === 0) return `level ${summary.level} · nothing delegated`;
  return `level ${summary.level} · ${MISSION_CLASSES.filter((name) => summary.delegated.includes(name)).map((name) => MISSION_CLASS_SHORT[name]).join(", ")}`;
}

/** The Main's state chip (§10.2): its Paseo status in words and a square's tone. */
export const MAIN_STATE_CHIPS: Readonly<Record<MissionSummary["main"]["state"], Badge>> = {
  idle: { text: "Main idle", tone: "success" },
  working: { text: "Main working", tone: "info" },
  stopped: { text: "Main stopped", tone: "danger" },
  none: { text: "No Main", tone: "muted" },
};

/** The governor's families as the page names them. */
const FAMILY_LABELS: Readonly<Record<MissionSignal["family"], string>> = {
  mess: "Mess",
  overengineering: "Overengineering",
  drift: "Drift",
  stuck: "Stuck",
  budget: "Budget",
};
const FAMILIES = ["mess", "overengineering", "drift", "stuck", "budget"] as const;

/** `1 Worker`, `3 Workers`. */
function count(value: number, one: string, many = `${one}s`): string {
  return `${value} ${value === 1 ? one : many}`;
}

// ---------------------------------------------------------------------------
// Figures in words (§10.3): one sentence per `GOVERNOR_FIGURES` id.
// ---------------------------------------------------------------------------

/** What a figure's sentence reads from: its value, threshold and detail, and the repos' names. */
interface FigureWords {
  /** The list chip's words: "4 Workers on one area". */
  short: (figure: MissionFigure, nameOf: NameOf) => string;
  /** The page's sentence, without the threshold: "4 Workers wrote docs/01-prd.md today". */
  long: (figure: MissionFigure, nameOf: NameOf) => string;
}

/** The part of a detail after `<id>: ` (the writers' and re-asks' details lead with a workspace or request id). */
function afterKey(detail: string | null): string | null {
  if (detail === null) return null;
  const at = detail.indexOf(": ");
  return at === -1 ? detail : detail.slice(at + 2);
}

/** A list of workspace ids by their names. */
function namesOf(detail: string | null, nameOf: NameOf): string | null {
  if (detail === null) return null;
  return detail
    .split(", ")
    .map((id) => nameOf(id) ?? id)
    .join(", ");
}

const of = (detail: string | null, lead = " of ") => (detail === null ? "" : `${lead}${detail}`);

function budget(name: string): FigureWords {
  return {
    short: (figure) => `${name} budget at ${figure.value}%`,
    long: (figure) => `${figure.value}% of the ${name} budget used${figure.detail === null ? "" : ` (${figure.detail})`}`,
  };
}

/** Every figure id of `GOVERNOR_FIGURES` (`server/governor-figures.ts`), in its order, with its words. */
export const FIGURE_WORDS: Readonly<Record<string, FigureWords>> = {
  writersOnOneFile: {
    short: (figure) => `${count(figure.value, "Worker")} on one area`,
    long: (figure) => `${count(figure.value, "Worker")} wrote ${afterKey(figure.detail) ?? "one file"} today`,
  },
  workersInOneRepo: {
    short: (figure, nameOf) => `${count(figure.value, "Worker")} in ${figure.detail === null ? "one repository" : (nameOf(figure.detail) ?? figure.detail)}`,
    long: (figure, nameOf) => `${count(figure.value, "Worker")} at work in ${figure.detail === null ? "one repository" : (nameOf(figure.detail) ?? figure.detail)}`,
  },
  reAsks: {
    short: (figure) => count(figure.value, "re-ask"),
    long: (figure) => `${count(figure.value, "re-ask")} of one subject in a request${of(afterKey(figure.detail), ": ")}`,
  },
  dropped: {
    short: (figure) => `${figure.value} dropped`,
    long: (figure) => `${figure.value} ${figure.value === 1 ? "delivery or command" : "deliveries or commands"} dropped`,
  },
  uncommittedHours: {
    short: () => "uncommitted work left",
    long: (figure, nameOf) => `work left uncommitted${of(namesOf(figure.detail, nameOf), " in ")} for ${figure.value} h with no Worker`,
  },
  processDocsPerCriterion: {
    short: (figure) => `${figure.value} documents per criterion`,
    long: (figure) => `${figure.value} process documents per done criterion`,
  },
  beadsPerFinishedRequest: {
    short: (figure) => `${figure.value} beads per request`,
    long: (figure) => `${figure.value} beads per finished request`,
  },
  tierRaised: {
    short: (figure) => count(figure.value, "tier raise"),
    long: (figure) => `${count(figure.value, "request")} raised their tier after received`,
  },
  reviewCapReached: {
    short: (figure) => `${count(figure.value, "review cap")} reached`,
    long: (figure) => `${count(figure.value, "request")} reached their review cap`,
  },
  unconvergedBatches: {
    short: (figure) => `${count(figure.value, "batch", "batches")} not converging`,
    long: (figure) => `${count(figure.value, "review batch", "review batches")} stopped converging in 24 h`,
  },
  openApprovals: {
    short: (figure) => `${count(figure.value, "approval")} waiting`,
    long: (figure) => `${count(figure.value, "approval")} wait on you`,
  },
  mainTurnsSinceCriterion: {
    short: (figure) => `${count(figure.value, "turn")} without progress`,
    long: (figure) => `${count(figure.value, "Main turn")} since a done criterion moved`,
  },
  finishedSinceCriterion: {
    short: (figure) => `${count(figure.value, "request")} without progress`,
    long: (figure) => `${count(figure.value, "request")} finished since a done criterion moved`,
  },
  outsideCharter: {
    short: (figure) => `${figure.value} outside the charter`,
    long: (figure, nameOf) => `${figure.value} ${figure.value === 1 ? "request or link" : "requests or links"} outside the charter${of(namesOf(figure.detail, nameOf), ": ")}`,
  },
  behindIntegration: {
    short: (figure) => `${count(figure.value, "commit")} behind`,
    long: (figure, nameOf) => `the mission branch${of(namesOf(figure.detail, nameOf), " of ")} is ${count(figure.value, "commit")} behind its integration branch`,
  },
  stalled: {
    short: (figure) => `${figure.value} stalled`,
    long: (figure) => `${count(figure.value, "request")} stalled${of(figure.detail, ": ")}`,
  },
  unansweredLinks: {
    short: (figure) => count(figure.value, "unanswered link"),
    long: (figure) => `${count(figure.value, "link")} unanswered${of(figure.detail, ": ")}`,
  },
  oldCards: {
    short: (figure) => `${count(figure.value, "old card")}`,
    long: (figure) => `${count(figure.value, "card")} waiting on you for over a day${of(figure.detail, ": ")}`,
  },
  unpushedNoMr: {
    short: () => "no merge request",
    long: (figure, nameOf) => `the mission branch${of(namesOf(figure.detail, nameOf), " of ")} has had commits with no merge request for ${figure.value} h`,
  },
  ciRed: {
    short: () => "CI red",
    long: (figure, nameOf) => `CI red${of(namesOf(figure.detail, nameOf), " in ")} for ${figure.value} min`,
  },
  mrConflicting: {
    short: (figure) => `${count(figure.value, "merge request")} conflicting`,
    long: (figure, nameOf) => `${count(figure.value, "merge request")} cannot merge for conflicts${of(namesOf(figure.detail, nameOf), ": ")}`,
  },
  requestsBudget: budget("requests"),
  workersBudget: budget("Workers"),
  reviewCallsBudget: budget("review calls"),
  daysBudget: budget("days"),
};

/** A figure the screen has no words for (a newer server's): its id and value. */
const FALLBACK_WORDS: FigureWords = { short: (figure) => `${figure.id} ${figure.value}`, long: (figure) => `${figure.id} ${figure.value}` };

/** The page's sentence of a figure: "4 Workers wrote docs/01-prd.md today (threshold 2)". */
export function figureSentenceOf(figure: MissionFigure, nameOf: NameOf, threshold = true): string {
  const words = (FIGURE_WORDS[figure.id] ?? FALLBACK_WORDS).long(figure, nameOf);
  return threshold ? `${words} (threshold ${figure.threshold})` : words;
}

/** The list chip's words of a figure. */
function figureShortOf(figure: MissionFigure, nameOf: NameOf): string {
  return (FIGURE_WORDS[figure.id] ?? FALLBACK_WORDS).short(figure, nameOf);
}

/** The governor's last action in words, as the page says it. */
const ACTION_WORDS: Readonly<Record<string, string>> = {
  record: "recorded",
  nudge: "Main nudged",
  "nudge-failed": "nudge not delivered",
  "replan-due": "re-plan due",
  replan: "Main asked to re-plan",
  arbitrate: "arbitrated",
};

/** "Main nudged 12 min ago" (page), "nudged 12 min ago" (list), "Main nudged" (phone, `withAge` false); null for none. */
function actionOf(signal: MissionSignal, now: Date, form: "page" | "list" | "phone"): string | null {
  const word = signal.lastAction === null ? undefined : ACTION_WORDS[signal.lastAction.kind];
  if (word === undefined || signal.lastAction === null) return null;
  if (form === "phone") return word;
  const said = `${form === "list" ? word.replace(/^Main /, "") : word} ${ago(signal.lastAction.at, now)}`;
  if (form === "list" || signal.replanDueAt === null) return said;
  const due = Date.parse(signal.replanDueAt) - now.getTime();
  if (Number.isNaN(due)) return said;
  return `${said}, re-plan due ${due <= 0 ? "now" : `in ${shortSpan(due)}`}`;
}

/** The tone of a family at a step: escalated or stopping (4) is danger, else warning. */
function signalTone(signal: MissionSignal): Tone {
  return signal.step >= 4 ? "danger" : "warning";
}

/** The list card's governor chip: "Governor: 4 Workers on one area — nudged 12 min ago". */
function signalChipOf(signal: MissionSignal, now: Date, nameOf: NameOf): Badge {
  const first = signal.crossed[0];
  const what = first === undefined ? FAMILY_LABELS[signal.family].toLowerCase() : figureShortOf(first, nameOf);
  const action = actionOf(signal, now, "list");
  return { text: `Governor: ${what}${action === null ? "" : ` — ${action}`}`, tone: signalTone(signal) };
}

/** One line of the page's Governor: the family, its first crossed figure, and what the governor did. */
export interface GovernorLine {
  label: string;
  text: string;
  tone: Tone;
}

/** The page's governor lines (step ≥ 1), then the quiet families as one line (§10.2). */
export function governorLinesOf(
  governor: readonly MissionSignal[],
  now: Date,
  nameOf: NameOf,
  compact = false,
): { lines: GovernorLine[]; quiet: GovernorLine | null } {
  const active = FAMILIES.map((family) => governor.find((signal) => signal.family === family && signal.step >= 1)).filter((signal) => signal !== undefined);
  const lines = active.map((signal) => {
    const first = signal.crossed[0];
    const sentence = first === undefined ? "signalled" : figureSentenceOf(first, nameOf, !compact);
    const action = actionOf(signal, now, compact ? "phone" : "page");
    return { label: `${FAMILY_LABELS[signal.family]}:`, text: action === null ? sentence : `${sentence} — ${action}`, tone: signalTone(signal) };
  });
  const quietFamilies = FAMILIES.filter((family) => !active.some((signal) => signal.family === family));
  const quiet =
    quietFamilies.length === 0
      ? null
      : {
          label: `${quietFamilies.map((family, index) => (index === 0 ? FAMILY_LABELS[family] : FAMILY_LABELS[family].toLowerCase())).join(", ")}:`,
          text: "within the charter",
          tone: "success" as const,
        };
  return { lines, quiet };
}

// ---------------------------------------------------------------------------
// The list (artboards A, C).
// ---------------------------------------------------------------------------

export interface MissionCardView {
  missionId: string;
  code: string;
  name: string;
  open: boolean;
  main: Badge;
  level: string;
  repos: string[];
  /** "3 live Workers · 7 requests". */
  counts: string;
  /** Met criteria of those not dropped, 0..1. */
  progress: number;
  criteria: string;
  /** "2 questions for you", one governor chip per family at step ≥ 1. */
  attention: Badge[];
  /** "No questions · no signals" when there is nothing to attend; else null. */
  quiet: string | null;
  /** A closed card's one line: "closed 2026-10-08 · xspace-ai-assistant". */
  closedLine: string | null;
  /** The phone's lines: "2 repositories · 3 live Workers · Main idle", then "Done 5 of 11 · 2 questions · 1 signal". */
  phoneLine: string;
  phoneParts: Badge[];
}

const dateOf = (at: string | null) => (at === null ? "—" : at.slice(0, 10));

/** A list card's view of one mission. */
export function missionCardOf(summary: MissionSummary, now: Date, nameOf: NameOf = () => null): MissionCardView {
  const names = summary.repos.map((repo) => repo.name);
  const lookup: NameOf = (id) => summary.repos.find((repo) => repo.workspaceId === id)?.name ?? nameOf(id);
  const { met, total } = summary.criteria;
  const attention: Badge[] = [
    ...(summary.questions > 0 ? [{ text: `${count(summary.questions, "question")} for you`, tone: "warning" as const }] : []),
    ...summary.signals.filter((signal) => signal.step >= 1).map((signal) => signalChipOf(signal, now, lookup)),
  ];
  const signals = summary.signals.filter((signal) => signal.step >= 1).length;
  return {
    missionId: summary.missionId,
    code: summary.code,
    name: summary.name,
    open: summary.state === "open",
    main: MAIN_STATE_CHIPS[summary.main.state],
    level: levelLineOf(summary),
    repos: names,
    counts: `${count(summary.liveWorkers, "live Worker")} · ${count(summary.requests, "request")}`,
    progress: total === 0 ? 0 : Math.min(1, met / total),
    criteria: `Done criteria ${met} of ${total}`,
    attention,
    quiet: attention.length === 0 ? "No questions · no signals" : null,
    closedLine: summary.state === "closed" ? [`closed ${dateOf(summary.closedAt)}`, ...(names.length === 0 ? [] : [names.join(", ")])].join(" · ") : null,
    phoneLine: `${count(names.length, "repository", "repositories")} · ${count(summary.liveWorkers, "live Worker")} · ${MAIN_STATE_CHIPS[summary.main.state].text}`,
    phoneParts: [
      { text: `Done ${met} of ${total}`, tone: "plain" },
      ...(summary.questions > 0 ? [{ text: count(summary.questions, "question"), tone: "warning" as const }] : []),
      ...(signals > 0 ? [{ text: count(signals, "signal"), tone: "warning" as const }] : []),
    ],
  };
}

/** The list: open missions, then closed ones, in the server's order (§10.4). */
export function missionListOf(missions: readonly MissionSummary[], now: Date, nameOf?: NameOf): { open: MissionCardView[]; closed: MissionCardView[] } {
  const cards = missions.map((summary) => missionCardOf(summary, now, nameOf));
  return { open: cards.filter((card) => card.open), closed: cards.filter((card) => !card.open) };
}

// ---------------------------------------------------------------------------
// A mission's page (artboards B, D).
// ---------------------------------------------------------------------------

export interface MissionStat {
  label: string;
  /** The phone's label: "Done", "Workers", "For you". */
  short: string;
  value: string;
  shortValue: string;
  hint: string | null;
  tone: Tone;
}

export interface CriterionView {
  id: string;
  /** "D1 Chat UI talks to backend endpoint /api/chat"; a dropped one ends "— dropped". */
  line: string;
  status: "open" | "met" | "dropped";
}

export interface WorkerRowView {
  requestId: string;
  repo: string;
  /** "req-…042844Z". */
  request: string;
  topic: string | null;
  /** The Worker's first 7; null when the request has none. */
  worker: string | null;
  workerId: string | null;
  phase: Badge;
  /** "↔ ai-assistant · 3", or "—". */
  links: string;
  /** Still at work (not finished, not stopped): the phone lists only these. */
  active: boolean;
}

export interface MissionPageView {
  missionId: string;
  code: string;
  name: string;
  open: boolean;
  main: Badge;
  /** A closed mission's "closed 2026-10-08"; null while open. */
  closedLine: string | null;
  stats: MissionStat[];
  charter: {
    label: string;
    goal: string;
    repos: Array<{ workspaceId: string; name: string }>;
    /** "Shell registration (xspace-shell) · mobile layout"; null when none. */
    nonGoals: string | null;
    criteria: CriterionView[];
  };
  level: {
    level: MissionLevel;
    decides: string;
    yours: string;
    sentence: string;
  };
  governor: { lines: GovernorLine[]; quiet: GovernorLine | null };
  phoneGovernor: GovernorLine[];
  rows: WorkerRowView[];
  /** The phone's "+ 1 finished" under its active rows; null when there is none. */
  restLine: string | null;
  contracts: Array<{ id: string; title: string; parties: string; version: string }>;
  journal: Array<{ time: string; text: string }>;
  plan: { text: string; meta: string };
  /** The header's Main card (mission runtime design §7, artboards G and H); null from an older server. */
  mains: MainHistoryView | null;
  /** The In flight card (mission runtime design §7); null from an older server. */
  inFlight: InFlightView | null;
  /** The Repositories card (delivery line design §4.9, artboards I and J); null when no repo has a worktree of the mission. */
  repositories: RepositoriesView | null;
}

/** Push and merge request of one repo (delivery line design §4.3): what the row says and the action beside it. */
export interface RepoPushView {
  /** "allowed since 10:42", "waiting for you", "not now", "revoked 12:10", "—". */
  text: string;
  tone: Tone;
  /** The phone's line: "Push & MR allowed", "Push & MR: waiting for you"; null before any card. */
  phone: string | null;
  /** Revoke beside a grant, Answer beside the open card, "Ask me again" after not now or a revoke (§4.3); null otherwise. */
  action: "revoke" | "answer" | "ask" | null;
  /** The integration card's id, for Answer. */
  decisionId: string | null;
}

/** One row of the Repositories card (artboards I and J). */
export interface RepoRowView {
  workspaceId: string;
  name: string;
  branch: string;
  target: string;
  /** The phone's branch: "m/INO/…" for a mission branch. */
  shortBranch: string;
  /** "↑4 ↓0"; "not read yet" before paseo-bm's first read of the line. */
  counts: string;
  /** "● uncommitted" (warning) or "clean"; null when unknown. */
  dirty: Badge | null;
  /** "last commit 11:52"; null when unknown. */
  lastCommit: string | null;
  /** "!42 open" with its link; the phone shows `short` ("!42"). Null without a merge request. */
  mr: { text: string; short: string; tone: Tone; url: string } | null;
  /** "CI passed", "CI failed", "CI running", "CI not run"; null when unknown, and always while `integration.ci` is off. */
  ci: Badge | null;
  push: RepoPushView;
}

export interface RepositoriesView {
  /** "each mission writes on its own branch · read 12:40". */
  meta: string;
  /** The merge request column's header: "Merge request · CI"; "Merge request" while `integration.ci` is off (ADR-036). */
  mrHeader: string;
  rows: RepoRowView[];
}

/** One Main of the mission, newest first (artboard G). */
export interface MainRowView {
  agentId: string;
  /** Its id's first 7. */
  short: string;
  from: string;
  /** "now" for the current Main. */
  until: string;
  why: string;
  /** The phone's one word: created, replaced, handoff, fallback, you asked. */
  shortWhy: string;
  current: boolean;
}

export interface MainHistoryView {
  /** "3 Mains since 2026-10-10 08:12" (wide), "3 Mains" (phone). */
  count: string;
  shortCount: string;
  rows: MainRowView[];
}

export interface InFlightRequestView {
  requestId: string;
  request: string;
  topic: string;
  repo: string;
  worker: string | null;
  workerId: string | null;
  state: Badge;
  /** The phone's words: another request named by its topic. */
  phoneState: string;
  lastReport: string;
  /** The commit's first 7 within `lastReport` ("committed a1b2c3d"), drawn in mono; null when none. */
  commit: string | null;
  active: boolean;
  /**
   * Delivery line design §2.7 (artboard I): "continues req-…105259Z · 3rd of
   * its chain" under the topic of a request that continues another and is not
   * continued itself; null otherwise.
   */
  chain: { request: string; position: string | null } | null;
  /** The phone's line (artboard J): "continues Review and propose the feature · 3rd"; null without a chain. */
  phoneChain: string | null;
  /** "→ req-…124012Z" after "finished" when another request continues it (artboard I); null otherwise. */
  next: string | null;
}

export interface InFlightQuestionView {
  id: string;
  who: Badge;
  /** "Q1" or the decision id. */
  label: string;
  request: string | null;
  text: string;
  /** The question alone (the phone's line). */
  question: string;
  meta: string;
  /** The owner's to answer: an "Answer" that opens the Inbox. */
  yours: boolean;
}

export interface InFlightView {
  meta: string;
  requests: InFlightRequestView[];
  /** The phone's "+ 1 finished"; null when none. */
  restLine: string | null;
  questions: InFlightQuestionView[];
  /** The Main's open questions to the owner. */
  asks: Array<{ id: string; text: string; meta: string }>;
  links: Array<{ id: string; who: string; text: string }>;
}

/** How many criteria the charter card shows before "+ N more". */
export const CRITERIA_SHOWN = 4;
/** Journal lines on a wide page; the phone's sub-view shows `JOURNAL_PHONE`. */
export const JOURNAL_DESKTOP = 5;
export const JOURNAL_PHONE = 20;

const PHASE_TONES: Readonly<Record<MissionRow["phase"], Tone>> = { working: "info", finished: "success", stopped: "muted", blocked: "warning" };

/** One row of "Workers by repository". */
function workerRowOf(row: MissionRow): WorkerRowView {
  const questions = row.ownerQuestions.length === 0 ? "" : ` · ${row.ownerQuestions.join(", ")} for you`;
  return {
    requestId: row.requestId,
    repo: row.repo.name,
    request: shortRequestOf(row.requestId),
    topic: row.topic,
    worker: row.workerId === null ? null : row.workerId.slice(0, 7),
    workerId: row.workerId,
    phase: { text: `${row.phase}${questions}`, tone: PHASE_TONES[row.phase] },
    links: row.links.length === 0 ? "—" : row.links.map((link) => `↔ ${link.repo.name} · ${link.messages}`).join(", "),
    active: row.phase === "working" || row.phase === "blocked",
  };
}

/** Why a Main changed, in words (mission runtime design §7). */
const MAIN_REASON_WORDS: Readonly<Record<string, string>> = {
  created: "created with the mission",
  replaced: "replaced",
  handoff: "handoff — its context was full; this Main carries on",
  fallback: "fallback — its provider plan stopped it",
  owner: "you asked",
};

const timeOrDate = (at: string, now: Date): string => localTimeText(new Date(at), now) || "—";

/** The header's Main card from `mission.get`'s `mainHistory`, newest first; null with none. */
export function mainHistoryOf(history: NonNullable<MissionGetOutput["mainHistory"]> | undefined, now: Date): MainHistoryView | null {
  if (history === undefined || history.length === 0) return null;
  const rows = [...history]
    .sort((a, b) => b.from.localeCompare(a.from))
    .map((entry) => ({
      agentId: entry.agentId,
      short: entry.agentId.slice(0, 7),
      from: timeOrDate(entry.from, now),
      until: entry.to === null ? "now" : timeOrDate(entry.to, now),
      why: MAIN_REASON_WORDS[entry.reason] ?? entry.reason,
      shortWhy: entry.reason === "owner" ? "you asked" : entry.reason,
      current: entry.to === null,
    }));
  const oldest = history.reduce((first, entry) => (entry.from < first ? entry.from : first), history[0]!.from);
  const count = history.length === 1 ? "1 Main" : `${history.length} Mains`;
  const first = new Date(oldest);
  const day = Number.isNaN(first.getTime()) ? "—" : `${first.getFullYear()}-${String(first.getMonth() + 1).padStart(2, "0")}-${String(first.getDate()).padStart(2, "0")}`;
  return { count: `${count} since ${day} ${clockText(first)}`.trim(), shortCount: count, rows };
}

type MissionState = NonNullable<MissionGetOutput["inFlight"]>;

const REQUEST_STATE_TONES: Readonly<Record<MissionState["requests"][number]["state"], Tone>> = {
  working: "info",
  "waiting-owner": "warning",
  "waiting-main": "warning",
  "waiting-other": "plain",
  finished: "success",
  stopped: "muted",
};

const REQUEST_ID_IN_TEXT = /req-\d{8}T\d{6}Z/g;

/** The In flight card from `mission.get`'s `inFlight` (mission runtime design §7, artboards G and H); null from an older server. */
export function inFlightOf(state: MissionState | undefined, now: Date): InFlightView | null {
  if (state === undefined) return null;
  const topicOf = new Map(state.requests.map((request) => [request.requestId, request.topic]));
  const qnsOf = (requestId: string, decider: "owner" | "main") =>
    state.questions.filter((question) => question.requestId === requestId && (decider === "owner" ? question.decider === "owner" || question.recommend : question.decider === "main" && !question.recommend)).map((question) => question.qn ?? question.id);
  const requests = state.requests.map((request): InFlightRequestView => {
    const waitingOn = request.waitingOn ?? "other work";
    const words =
      request.state === "waiting-owner"
        ? ["waiting for you", ...qnsOf(request.requestId, "owner")].join(" · ")
        : request.state === "waiting-main"
          ? ["waiting for the Main", ...qnsOf(request.requestId, "main")].join(" · ")
          : request.state === "waiting-other"
            ? `waiting for ${waitingOn.replace(REQUEST_ID_IN_TEXT, (id) => shortRequestOf(id))}`
            : request.state;
    const phone = request.state === "waiting-other" ? `waiting for ${waitingOn.replace(REQUEST_ID_IN_TEXT, (id) => topicOf.get(id) ?? shortRequestOf(id))}` : words;
    // Delivery line design §2.7: the chain is told on its newest request; the one it continues points on with "→".
    const continuedBy = request.continuedBy ?? null;
    const continuationOf = continuedBy === null ? (request.continuationOf ?? null) : null;
    const position = request.chainPosition ?? null;
    const nth = position !== null && position >= 3 ? ordinal(position) : null;
    return {
      requestId: request.requestId,
      request: shortRequestOf(request.requestId),
      topic: request.topic,
      repo: request.repo ?? request.workspaceId,
      worker: request.workerId === null ? null : request.workerId.slice(0, 7),
      workerId: request.workerId,
      state: { text: words, tone: REQUEST_STATE_TONES[request.state] },
      phoneState: phone,
      // Delivery line design §4.6 (artboard I): "finished · committed a1b2c3d · 11:58".
      lastReport:
        request.lastReport === null
          ? "—"
          : [request.lastReport.phase, ...(request.committed === true ? [`committed${request.commit == null ? "" : ` ${request.commit.slice(0, 7)}`}`] : []), timeOrDate(request.lastReport.at, now)].join(" · "),
      commit: request.lastReport !== null && request.committed === true && request.commit != null ? request.commit.slice(0, 7) : null,
      active: request.state !== "finished" && request.state !== "stopped",
      chain: continuationOf === null ? null : { request: shortRequestOf(continuationOf), position: nth === null ? null : `${nth} of its chain` },
      phoneChain: continuationOf === null ? null : [`continues ${topicOf.get(continuationOf) || shortRequestOf(continuationOf)}`, ...(nth === null ? [] : [nth])].join(" · "),
      next: request.state === "finished" && continuedBy !== null ? `→ ${shortRequestOf(continuedBy)}` : null,
    };
  });
  const finished = requests.filter((request) => request.state.text === "finished").length;
  const stopped = requests.filter((request) => request.state.text === "stopped").length;
  const rest = [...(finished > 0 ? [`${finished} finished`] : []), ...(stopped > 0 ? [`${stopped} stopped`] : [])];
  const questions = state.questions.map((question): InFlightQuestionView => {
    const yours = question.decider === "owner" || question.recommend;
    const who: Badge = yours
      ? { text: "you decide", tone: "warning" }
      : { text: question.decider === "main" ? "the Main decides" : question.decider === "orchestrator" ? "the Orchestrator decides" : "paseo-bm", tone: "muted" };
    const recommended = question.recommended === null ? [] : [`recommended: ${question.recommended}`];
    return {
      id: question.id,
      who,
      label: question.qn ?? question.id,
      request: question.requestId === null ? null : shortRequestOf(question.requestId),
      text: `${question.class}${question.subject === null ? "" : `, ${question.subject}`} — ${question.question}`,
      question: question.question,
      meta: (yours ? recommended : [`asked ${timeOrDate(question.askedAt, now)}`, ...recommended]).join(" · "),
      yours,
    };
  });
  const asks = state.asks
    .filter((ask) => ask.byMain !== false)
    .map((ask) => ({ id: ask.id, text: ask.question, meta: [...(ask.recommended == null ? [] : [`recommended: ${ask.recommended}`]), `m:…:${ask.id.split(":").at(-1) ?? ""}`].join(" · ") }));
  const links = state.links.map((link) => ({
    id: link.linkId,
    who: link.waitingSince === null ? link.state : `waiting ${shortSpan(now.getTime() - (Date.parse(link.waitingSince) || now.getTime()))}`,
    text: `${link.partner} · ${link.gist}`,
  }));
  return { meta: `what the Main knows · read ${clockText(new Date(state.at)) || "—"}`, requests, restLine: rest.length === 0 ? null : `+ ${rest.join(" · ")}`, questions, asks, links };
}

/** The merge request's number as the forge writes it: "!42" (GitLab), "#42" (GitHub), else "MR". Pure. */
export function mrNumberOf(url: string): string {
  const gitlab = /\/merge_requests\/(\d+)/.exec(url);
  if (gitlab !== null) return `!${gitlab[1]}`;
  const github = /\/pull\/(\d+)/.exec(url);
  return github === null ? "MR" : `#${github[1]}`;
}

/** The merge request's state in the mockup's words: open, merged, conflicting (and closed). */
function mrStateOf(mr: NonNullable<MissionPlacement["mr"]>): Badge {
  const state = (mr.state ?? "").toLowerCase();
  if (state === "merged") return { text: "merged", tone: "success" };
  if (state === "closed") return { text: "closed", tone: "muted" };
  return mr.mergeable === false ? { text: "conflicting", tone: "danger" } : { text: "open", tone: "info" };
}

const CI_WORDS: Readonly<Record<string, Badge>> = {
  success: { text: "CI passed", tone: "success" },
  failure: { text: "CI failed", tone: "danger" },
  pending: { text: "CI running", tone: "plain" },
  "not-run": { text: "CI not run", tone: "muted" },
};

/** Push and merge request in the mockup's words (delivery line design §4.3). */
function pushOf(integration: MissionPlacement["integration"], now: Date): RepoPushView {
  const id = integration.decisionId;
  switch (integration.state) {
    case "allowed":
      return { text: `allowed since ${integration.at === null ? "—" : timeOrDate(integration.at, now)}`, tone: "plain", phone: "Push & MR allowed", action: "revoke", decisionId: id };
    case "waiting":
      return { text: "waiting for you", tone: "warning", phone: "Push & MR: waiting for you", action: "answer", decisionId: id };
    case "not-now":
      return { text: "not now", tone: "muted", phone: "Push & MR: not now", action: "ask", decisionId: id };
    case "revoked":
      return { text: `revoked${integration.at === null ? "" : ` ${timeOrDate(integration.at, now)}`}`, tone: "muted", phone: "Push & MR: revoked", action: "ask", decisionId: id };
    default:
      return { text: "—", tone: "muted", phone: null, action: null, decisionId: id };
  }
}

/**
 * The Repositories card from `mission.get`'s summary (delivery line design
 * §4.9, artboards I and J); null when no repo has a placement. With
 * `integration.ci` off (§17.1) the merge request shows without CI.
 */
export function repositoriesOf(summary: Pick<MissionSummary, "code" | "repos" | "ci">, now: Date): RepositoriesView | null {
  const placed = summary.repos.flatMap((repo) => (repo.placement === undefined ? [] : [{ repo, placement: repo.placement }]));
  if (placed.length === 0) return null;
  const ciShown = summary.ci !== "off";
  const prefix = `m/${summary.code}/`;
  const rows = placed.map(({ repo, placement }): RepoRowView => {
    const read = placement.readAt !== null;
    return {
      workspaceId: repo.workspaceId,
      name: repo.name,
      branch: placement.branch,
      target: placement.target,
      shortBranch: placement.branch.startsWith(prefix) ? `${prefix}…` : placement.branch,
      counts: read ? `↑${placement.ahead ?? "?"} ↓${placement.behind ?? "?"}` : "not read yet",
      dirty: !read || placement.dirty === null ? null : placement.dirty ? { text: "● uncommitted", tone: "warning" } : { text: "clean", tone: "plain" },
      lastCommit: placement.lastCommitAt === null ? null : `last commit ${timeOrDate(placement.lastCommitAt, now)}`,
      mr: placement.mr === null ? null : (() => {
        const state = mrStateOf(placement.mr);
        const number = mrNumberOf(placement.mr.url);
        return { text: `${number} ${state.text}`, short: number, tone: state.tone, url: placement.mr.url };
      })(),
      ci: !ciShown || placement.ci === null ? null : (CI_WORDS[placement.ci] ?? null),
      push: pushOf(placement.integration, now),
    };
  });
  const newest = placed.reduce<string | null>((latest, { placement }) => (placement.readAt !== null && (latest === null || placement.readAt > latest) ? placement.readAt : latest), null);
  return {
    meta: ["each mission writes on its own branch", ...(newest === null ? [] : [`read ${clockText(new Date(newest)) || "—"}`])].join(" · "),
    mrHeader: ciShown ? "Merge request · CI" : "Merge request",
    rows,
  };
}

/** The in-place confirmation of Revoke (delivery line design §4.3). */
export function revokeIntegrationDialog(code: string, row: Pick<RepoRowView, "name" | "branch" | "target">): ConfirmDialog {
  return {
    title: `Revoke push and merge request for ${row.name}?`,
    body: `${code}'s Workers stop pushing ${row.branch} and updating its merge request into ${row.target}; they go on committing on the branch. The merge request stays as it is.`,
    bodyTone: "plain",
    confirmLabel: "Revoke",
    confirmKind: "danger",
    cancelLabel: "Cancel",
    defaultAction: "cancel",
  };
}

/** A mission's page from `mission.get`. */
export function missionPageOf(page: MissionGetOutput, now: Date, nameOf: NameOf = () => null): MissionPageView {
  const { summary, charter } = page;
  const lookup: NameOf = (id) => summary.repos.find((repo) => repo.workspaceId === id)?.name ?? nameOf(id);
  // `mission.get` checks the level is 0–4 (`shared/contracts/missions.ts`).
  const level = summary.level as MissionLevel;
  const { delegated } = summary;
  const yours = MISSION_CLASSES.filter((name) => !summary.delegated.includes(name));
  const workersBudget = charter.budget?.workers ?? null;
  const rows = page.rows.map(workerRowOf);
  const finished = rows.filter((row) => row.phase.tone === "success").length;
  const stopped = rows.filter((row) => !row.active && row.phase.tone !== "success").length;
  const rest = [...(finished > 0 ? [`${finished} finished`] : []), ...(stopped > 0 ? [`${stopped} stopped`] : [])];
  return {
    missionId: summary.missionId,
    code: summary.code,
    name: summary.name,
    open: summary.state === "open",
    main: MAIN_STATE_CHIPS[summary.main.state],
    closedLine: summary.state === "closed" ? `closed ${dateOf(summary.closedAt)}` : null,
    stats: [
      { label: "Done criteria", short: "Done", value: `${summary.criteria.met} / ${summary.criteria.total}`, shortValue: `${summary.criteria.met}/${summary.criteria.total}`, hint: null, tone: "plain" },
      { label: "Live Workers", short: "Workers", value: String(summary.liveWorkers), shortValue: String(summary.liveWorkers), hint: workersBudget === null ? null : `budget ${workersBudget}`, tone: "plain" },
      { label: "Questions for you", short: "For you", value: String(summary.questions), shortValue: String(summary.questions), hint: null, tone: summary.questions > 0 ? "warning" : "plain" },
    ],
    charter: {
      label: charter.confirmedAt === null ? "Charter · not confirmed" : `Charter · confirmed ${dateOf(charter.confirmedAt)}`,
      goal: charter.goal,
      repos: summary.repos.map((repo) => ({ workspaceId: repo.workspaceId, name: repo.name })),
      nonGoals: charter.nonGoals.length === 0 ? null : charter.nonGoals.join(" · "),
      criteria: charter.criteria.map((criterion) => ({
        id: criterion.id,
        line: `${criterion.id} ${criterion.text}${criterion.status === "dropped" ? " — dropped" : ""}`,
        status: criterion.status,
      })),
    },
    level: {
      level,
      decides: delegated.length === 0 ? "nothing on its own" : classWordsOf(delegated),
      yours: yours.length === 0 ? "nothing — every class is the Main's" : classWordsOf(yours),
      sentence: MISSION_LEVEL_SENTENCES[level],
    },
    governor: governorLinesOf(page.governor, now, lookup),
    phoneGovernor: (() => {
      const phone = governorLinesOf(page.governor, now, lookup, true);
      return phone.lines.length > 0 ? phone.lines : phone.quiet === null ? [] : [phone.quiet];
    })(),
    rows,
    restLine: rest.length === 0 ? null : `+ ${rest.join(" · ")}`,
    contracts: page.contracts.map((contract) => ({
      id: contract.id,
      title: `${contract.id} ${contract.title}`,
      parties: `${contract.provider.name} → ${contract.consumers.map((repo) => repo.name).join(", ") || "—"}`,
      version: `v${contract.version} · ${localTimeText(new Date(contract.updatedAt), now) || "—"}`,
    })),
    journal: page.journal.map((line) => ({ time: clockText(new Date(line.at)) || "—", text: line.text })),
    plan: {
      text: page.plan.text.trim() === "" ? "No plan yet." : page.plan.text,
      meta: page.plan.updatedAt === null ? "not written yet · read-only" : `updated ${localTimeText(new Date(page.plan.updatedAt), now) || "—"} by the Main · read-only`,
    },
    mains: mainHistoryOf(page.mainHistory, now),
    inFlight: inFlightOf(page.inFlight, now),
    repositories: repositoriesOf(summary, now),
  };
}

/**
 * The projects "+ Add" offers (`mission-projects.html`, artboard N): listed
 * projects not in the charter yet — by workspace, and by project when
 * `projectOf` knows the charter's workspaces (a repo chosen through another
 * workspace of the same project is in the mission).
 */
export function addableReposOf<T extends { id: string; name: string; projectId?: string }>(
  projects: readonly T[],
  repos: ReadonlyArray<{ workspaceId: string }>,
  projectOf: (workspaceId: string) => string | null = () => null,
): T[] {
  const inMission = new Set(repos.map((repo) => projectOf(repo.workspaceId)).filter((id): id is string => id !== null));
  return projects.filter((project) => !repos.some((repo) => repo.workspaceId === project.id) && (project.projectId === undefined || !inMission.has(project.projectId)));
}

// ---------------------------------------------------------------------------
// New mission (artboard E) and Rename.
// ---------------------------------------------------------------------------

export interface MissionDraft {
  name: string;
  code: string;
  goal: string;
  repos: string[];
  level: MissionLevel;
}

export const EMPTY_MISSION_DRAFT: MissionDraft = { name: "", code: "", goal: "", repos: [], level: DEFAULT_MISSION_LEVEL };

export const MAX_MISSION_NAME = 80;
export const MAX_MISSION_GOAL = 4_000;

/** The short code as typed: upper case, no spaces, at most 8 characters. */
export function codeAsTyped(text: string): string {
  return text.toUpperCase().replace(/\s+/g, "").slice(0, 8);
}

/** Why a name and a short code cannot be used, one line each; empty when they can. */
export function nameAndCodeErrors(name: string, code: string): string[] {
  const errors: string[] = [];
  const trimmed = name.trim();
  if (trimmed.length < 1 || trimmed.length > MAX_MISSION_NAME) errors.push(`Name: 1 to ${MAX_MISSION_NAME} characters.`);
  if (!MISSION_CHANGE_CODE_PATTERN.test(code)) errors.push("Short code: a capital letter, then 1 to 7 capitals or digits (AIX, ORA2).");
  return errors;
}

/** Why the New mission form cannot be sent, one line each; empty when it can. */
export function missionDraftErrors(draft: MissionDraft): string[] {
  return [
    ...nameAndCodeErrors(draft.name, draft.code),
    ...(draft.goal.length > MAX_MISSION_GOAL ? [`Goal: at most ${MAX_MISSION_GOAL.toLocaleString("en-US")} characters.`] : []),
    ...(draft.repos.length === 0 ? ["Projects: choose at least one."] : []),
  ];
}

/** `missions.create`'s input from a valid draft. */
export function createInputOf(draft: MissionDraft): MissionsCreateInput {
  const goal = draft.goal.trim();
  return { name: draft.name.trim(), code: draft.code, repos: [...draft.repos], ...(goal === "" ? {} : { goal }) };
}

/** A project toggled in the draft (its row's checkbox). */
export function toggleRepo(draft: MissionDraft, workspaceId: string): MissionDraft {
  return { ...draft, repos: draft.repos.includes(workspaceId) ? draft.repos.filter((id) => id !== workspaceId) : [...draft.repos, workspaceId] };
}

/** `mission.change`'s rename: only what changed; null when nothing did. */
export function renameInputOf(missionId: string, current: { name: string; code: string }, name: string, code: string): { missionId: string; name?: string; code?: string } | null {
  const trimmed = name.trim();
  const change = { ...(trimmed !== current.name ? { name: trimmed } : {}), ...(code !== current.code ? { code } : {}) };
  return Object.keys(change).length === 0 ? null : { missionId, ...change };
}

// ---------------------------------------------------------------------------
// Project memory (artboard F).
// ---------------------------------------------------------------------------

type MemoryEntry = MemoryListOutput["entries"][number];

export interface MemoryView {
  title: string;
  count: string;
  rows: Array<{ id: string; kind: MemoryEntry["kind"]; text: string; source: string }>;
}

/** "Q2" of a decision id that ends with one, else the id. */
function questionOf(decisionId: string): string {
  return /(Q\d+)$/.exec(decisionId)?.[1] ?? decisionId;
}

/**
 * Where an entry came from (§10.2): "owner, Q2 · 2026-10-09" for the owner's
 * answer, "Worker 733918b" for a Worker's, "owner · all projects" for a
 * precedent of every project.
 */
export function memorySourceOf(entry: Pick<MemoryEntry, "kind" | "source" | "by" | "at">): string {
  const date = dateOf(entry.at);
  const id7 = entry.by.agentId === null ? null : entry.by.agentId.slice(0, 7);
  if (entry.by.role === "worker") return id7 === null ? "a Worker" : `Worker ${id7}`;
  if (entry.by.role === "main") return id7 === null ? "the Main" : `Main ${id7}`;
  if (entry.kind === "precedent" && /all projects/i.test(entry.source)) return "owner · all projects";
  const answer = /^the owner's answer to (\S+)$/.exec(entry.source);
  if (answer !== null) return `owner, ${questionOf(answer[1]!)} · ${date}`;
  if (entry.kind === "precedent") return entry.source === "" ? `owner · ${date}` : `owner, ${questionOf(entry.source)} · ${date}`;
  // A source written by hand may already name the owner or carry the date: neither is said twice.
  const dated = (text: string): string => (text.includes(date) ? text : `${text} · ${date}`);
  const said = entry.source.replace(/^owner\b[,·\s]*/i, "").trim();
  if (entry.by.role === "owner") return said === "" || said === date ? `owner · ${date}` : `owner, ${dated(said)}`;
  return entry.source === "" ? date : dated(entry.source);
}

/** A project's memory from `memory.list`. */
export function memoryViewOf(memory: MemoryListOutput): MemoryView {
  return {
    title: `Memory · ${memory.name}`,
    count: count(memory.total, "entry", "entries"),
    rows: memory.entries.map((entry) => ({ id: entry.id, kind: entry.kind, text: entry.text, source: memorySourceOf(entry) })),
  };
}
