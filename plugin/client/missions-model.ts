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
import type { MemoryListOutput, MissionFigure, MissionGetOutput, MissionRow, MissionSignal, MissionSummary, MissionsCreateInput } from "../shared/contracts";
import { MISSION_CLASSES, DEFAULT_MISSION_LEVEL, type MissionClass, type MissionLevel } from "../shared/autonomy";
import { MISSION_CHANGE_CODE_PATTERN } from "../shared/mission-change";
import { ago, localTimeText, shortSpan } from "./format";
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

export const MISSION_LEVELS_SHOWN: readonly MissionLevel[] = [0, 1, 2, 3, 4];

/** The form's line under the level: "Level 2: the Main goes on to next steps and creates Workers by itself." */
export function levelSentenceOf(level: MissionLevel): string {
  const sentence = MISSION_LEVEL_SENTENCES[level];
  return `Level ${level}: ${sentence.charAt(0).toLowerCase()}${sentence.slice(1)}`;
}

/** Levels 3 and 4 let the Main answer its Workers' questions for the owner: they are confirmed in place. */
export function levelNeedsConfirmation(level: number): boolean {
  return level >= 3;
}

/** The in-place confirmation of level 3 or 4; `code` names the mission (null in the New mission form). */
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
export const FAMILY_LABELS: Readonly<Record<MissionSignal["family"], string>> = {
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
  reviewBudgetExhausted: {
    short: (figure) => `${count(figure.value, "review budget")} spent`,
    long: (figure) => `${count(figure.value, "request")} ran out of review budget`,
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
export function figureShortOf(figure: MissionFigure, nameOf: NameOf): string {
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
export function signalChipOf(signal: MissionSignal, now: Date, nameOf: NameOf): Badge {
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
}

/** How many criteria the charter card shows before "+ N more". */
export const CRITERIA_SHOWN = 4;
/** Journal lines on a wide page; the phone's sub-view shows `JOURNAL_PHONE`. */
export const JOURNAL_DESKTOP = 5;
export const JOURNAL_PHONE = 20;

/** "09:41", in the device's time zone; "—" for a time that does not read. */
export function clockOf(at: string): string {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return "—";
  const two = (value: number) => String(value).padStart(2, "0");
  return `${two(date.getHours())}:${two(date.getMinutes())}`;
}

const PHASE_TONES: Readonly<Record<MissionRow["phase"], Tone>> = { working: "info", finished: "success", stopped: "muted", blocked: "warning" };

/** "req-…042844Z": the request id's last 7. */
export function shortRequestOf(requestId: string): string {
  return requestId.length <= 11 ? requestId : `req-…${requestId.slice(-7)}`;
}

/** One row of "Workers by repository". */
export function workerRowOf(row: MissionRow): WorkerRowView {
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

/** A mission's page from `mission.get`. */
export function missionPageOf(page: MissionGetOutput, now: Date, nameOf: NameOf = () => null): MissionPageView {
  const { summary, charter } = page;
  const lookup: NameOf = (id) => summary.repos.find((repo) => repo.workspaceId === id)?.name ?? nameOf(id);
  const level = (MISSION_LEVELS_SHOWN.includes(summary.level as MissionLevel) ? summary.level : DEFAULT_MISSION_LEVEL) as MissionLevel;
  const delegated = MISSION_CLASSES.filter((name) => summary.delegated.includes(name));
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
    journal: page.journal.map((line) => ({ time: clockOf(line.at), text: line.text })),
    plan: {
      text: page.plan.text.trim() === "" ? "No plan yet." : page.plan.text,
      meta: page.plan.updatedAt === null ? "not written yet · read-only" : `updated ${localTimeText(new Date(page.plan.updatedAt), now) || "—"} by the Main · read-only`,
    },
  };
}

/** The projects "+ Add" offers: listed projects not in the charter yet. */
export function addableReposOf(projects: ReadonlyArray<{ id: string; name: string }>, repos: ReadonlyArray<{ workspaceId: string }>): Array<{ id: string; name: string }> {
  return projects.filter((project) => !repos.some((repo) => repo.workspaceId === project.id));
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
    ...(draft.repos.length === 0 ? ["Repositories: choose at least one."] : []),
  ];
}

/** `missions.create`'s input from a valid draft. */
export function createInputOf(draft: MissionDraft): MissionsCreateInput {
  const goal = draft.goal.trim();
  return { name: draft.name.trim(), code: draft.code, repos: [...draft.repos], ...(goal === "" ? {} : { goal }) };
}

/** A repository chip toggled in the draft. */
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
