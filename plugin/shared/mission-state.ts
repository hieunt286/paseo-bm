/**
 * The mission state (mission runtime design §2, ADR-033 decision 1,
 * REQ-202): what is in flight in a mission and whom it waits on — its shape,
 * the request-state rule and the one rendering every brief uses (the Main's
 * first prompt, its `BM-STATE` after a compaction, the governor's wake brief).
 * The reader is `server/mission-state.ts`.
 *
 * This module is `shared/`: no Node and no React Native imports.
 */
import type { Decider } from "./authority";

export const REQUEST_STATES = ["working", "waiting-owner", "waiting-main", "waiting-other", "finished", "stopped"] as const;
export type MissionRequestState = (typeof REQUEST_STATES)[number];

/** The rendering's cap (design §2.2): the `BM-STATE` brief's. */
export const MISSION_STATE_MAX_CHARS = 6_000;
/** How many entries of the owner's exchange with the Main the state keeps (design §2.1). */
export const MISSION_STATE_OWNER_ENTRIES = 6;
/** How many journal lines the state keeps. */
export const MISSION_STATE_JOURNAL = 10;
/** A finished or stopped request stays in the state this long after its newest report. */
export const MISSION_STATE_FINISHED_MS = 24 * 3_600_000;

export interface MissionStateRequest {
  requestId: string;
  workspaceId: string;
  repo: string | null;
  topic: string;
  workerId: string | null;
  state: MissionRequestState;
  lastReport: { phase: string; at: string; line: string } | null;
  followUpAt: string | null;
  waitingOn: string | null;
}

export interface MissionStateQuestion {
  id: string;
  requestId: string | null;
  qn: string | null;
  class: string;
  subject: string | null;
  decider: Decider;
  /** Rule 5 of the resolver: the Main recommends, the owner decides. */
  recommend: boolean;
  askedAt: string;
  question: string;
  recommended: string | null;
}

export interface MissionStateAsk {
  id: string;
  askedAt: string;
  question: string;
  options: string[];
  /** "a — label" of its recommended option; null when none (absent from an older state). */
  recommended?: string | null;
  /** True when a Main of the mission asked it (`bm_owner_question`, `bm_mission_update`); false for paseo-bm's own cards (governor, merge). */
  byMain?: boolean;
}

export interface MissionStateLink {
  linkId: string;
  route: string;
  kind: string;
  direction: "out" | "in";
  partner: string;
  state: string;
  waitingSince: string | null;
  gist: string;
}

export interface MissionState {
  at: string;
  mission: {
    missionId: string;
    code: string;
    name: string;
    state: "open" | "closed";
    goal: string;
    charterConfirmed: boolean;
    repos: Array<{ workspaceId: string; name: string | null }>;
    mainId: string | null;
    mainHistory: Array<{ agentId: string; from: string; to: string | null; reason: string }>;
  };
  /** The charter's done criteria: how many are met of how many, and the open ones. */
  criteria: { met: number; total: number; open: Array<{ id: string; text: string }> };
  requests: MissionStateRequest[];
  questions: MissionStateQuestion[];
  asks: MissionStateAsk[];
  links: MissionStateLink[];
  owner: Array<{ at: string; from: "owner" | "main"; text: string }>;
  governor: Array<{ family: string; step: number; since: string | null; crossed: string[] }>;
  journal: Array<{ at: string; kind: string; by: string; text: string }>;
  unknown: string[];
}

/**
 * A request's state (design §2.1), the first that holds: finished or stopped
 * by the roster (unless a follow-up came after the newest report); an open
 * question for the owner; one for the Main; a `blocked` report waiting on
 * something else; otherwise working. Pure.
 */
export function requestStateOf(input: {
  rosterState: "active" | "finished" | "stopped";
  lastReport: { phase: string; at: string } | null;
  followUpAt: string | null;
  openDeciders: readonly Decider[];
  waitingOn: string | null;
}): MissionRequestState {
  const reportAt = input.lastReport === null ? Number.NEGATIVE_INFINITY : Date.parse(input.lastReport.at) || 0;
  const followedUp = input.followUpAt !== null && (Date.parse(input.followUpAt) || 0) > reportAt;
  if ((input.rosterState === "finished" || input.rosterState === "stopped") && !followedUp) return input.rosterState;
  if (input.openDeciders.some((decider) => decider === "owner")) return "waiting-owner";
  if (input.openDeciders.some((decider) => decider === "main")) return "waiting-main";
  if (!followedUp && input.lastReport?.phase === "blocked" && input.waitingOn !== null) return "waiting-other";
  return "working";
}

/** The words of a request state. */
export const REQUEST_STATE_WORDS: Readonly<Record<MissionRequestState, string>> = {
  working: "working",
  "waiting-owner": "waiting for the owner",
  "waiting-main": "waiting for you (the Main)",
  "waiting-other": "waiting on other work",
  finished: "finished",
  stopped: "stopped",
};

function cut(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

/** How long ago `at` was, from `now`, in minutes or hours. */
function ago(at: string, now: number): string {
  const ms = now - (Date.parse(at) || now);
  if (ms < 60 * 60_000) return `${Math.max(0, Math.round(ms / 60_000))} min ago`;
  return `${Math.round(ms / 3_600_000)} h ago`;
}

/**
 * The rendering of design §2.2: a header, then In flight, Waiting on the
 * owner, Yours to decide, Links, The owner said lately, Governor, Recently,
 * and where the rest is. Sections drop from the end, and lines from the
 * oldest, until it fits `maxChars`. The caller masks nothing more: the state's
 * text is masked when read. Pure.
 */
export function renderMissionState(state: MissionState, options: { maxChars?: number } = {}): string {
  const maxChars = options.maxChars ?? MISSION_STATE_MAX_CHARS;
  const now = Date.parse(state.at) || 0;
  const repoName = (workspaceId: string) => state.mission.repos.find((repo) => repo.workspaceId === workspaceId)?.name ?? workspaceId;
  const header = `Mission ${state.mission.code} — ${cut(state.mission.name, 80)} (${state.mission.missionId}), ${state.mission.state}; Main ${state.mission.mainId ?? "none"}. State read ${state.at}.`;
  const criteria = `Done criteria: ${state.criteria.met} of ${state.criteria.total} met${state.criteria.open.length === 0 ? "" : `; open: ${state.criteria.open.map((criterion) => `${criterion.id} ${cut(criterion.text, 120)}`).join("; ")}`}`;
  const sections: Array<{ title: string; lines: string[] }> = [
    {
      title: "In flight",
      lines: state.requests.map((request) => {
        const report = request.lastReport === null ? "no report yet" : `${request.lastReport.phase} ${ago(request.lastReport.at, now)}${request.lastReport.line === "" ? "" : ` — ${cut(request.lastReport.line, 160)}`}`;
        const follow = request.followUpAt === null ? "" : `; follow-up told ${ago(request.followUpAt, now)}`;
        const waiting = request.state === "waiting-other" && request.waitingOn !== null ? `; waits on ${cut(request.waitingOn, 120)}` : "";
        return `- ${request.requestId} in ${request.repo ?? repoName(request.workspaceId)}: ${REQUEST_STATE_WORDS[request.state]}; Worker ${request.workerId ?? "none"}; ${report}${follow}${waiting}${request.topic === "" ? "" : `; asked: ${cut(request.topic, 120)}`}`;
      }),
    },
    {
      title: "Waiting on the owner",
      lines: [
        ...state.questions
          .filter((question) => question.decider === "owner")
          .map((question) => `- ${question.id} (${question.class}${question.recommend ? ", recommend with bm_answer_worker" : ""}): ${cut(question.question, 200)}`),
        ...state.asks.map((ask) => `- ${ask.id} (${ask.byMain === false ? "paseo-bm's card" : "your question"}): ${cut(ask.question, 200)}`),
      ],
    },
    {
      title: "Yours to decide",
      lines: state.questions
        .filter((question) => question.decider === "main")
        .map((question) => `- ${question.id} (${question.class}${question.subject === null ? "" : `, ${question.subject}`}): ${cut(question.question, 200)}${question.recommended === null ? "" : `; the Worker recommends ${question.recommended}`}`),
    },
    {
      title: "Links",
      lines: state.links.map(
        (link) => `- ${link.linkId} ${link.direction === "out" ? "to" : "from"} ${link.partner} (${link.kind}, ${link.state}${link.waitingSince === null ? "" : `, waiting ${ago(link.waitingSince, now)}`}): ${cut(link.gist, 160)}`,
      ),
    },
    {
      title: "The owner said lately",
      lines: state.owner.map((entry) => `- ${entry.at} ${entry.from === "owner" ? "owner" : "Main"}: ${cut(entry.text, 300)}`),
    },
    {
      title: "Governor",
      lines: state.governor.map((family) => `- ${family.family} at step ${family.step} since ${family.since ?? "unknown"}${family.crossed.length === 0 ? "" : ` (${family.crossed.join("; ")})`}`),
    },
    { title: "Recently", lines: state.journal.map((line) => `- ${line.at} ${line.kind} ${line.by}: ${cut(line.text, 200)}`) },
  ];
  const footer = "Read the whole mission with bm_mission.";
  const render = (parts: typeof sections): string =>
    [header, criteria, ...parts.flatMap((part) => (part.lines.length === 0 ? [`${part.title}: none`] : [`${part.title}:`, ...part.lines])), footer].join("\n");
  const kept = sections.map((part) => ({ ...part, lines: [...part.lines] }));
  let text = render(kept);
  // Lines go from the oldest end of the last sections first, then whole sections, until it fits.
  for (let index = kept.length - 1; text.length > maxChars && index >= 0; index -= 1) {
    while (text.length > maxChars && kept[index]!.lines.length > 0) {
      kept[index]!.lines.shift();
      text = render(kept);
    }
  }
  return text.length <= maxChars ? text : `${text.slice(0, maxChars - 1)}…`;
}

/** The first line of a field of a report block, or null. */
function fieldOf(text: string, key: string): string | null {
  return new RegExp(`^${key}:[ \\t]*(.*)$`, "m").exec(text)?.[1]?.trim() ?? null;
}

/**
 * What a `blocked` report waits on besides the owner (design §2.1): the text
 * after "waiting for" (or "waiting on") in its `blockers:` line, unless that
 * is the owner. Null when it names none. Pure.
 */
export function waitingOnOf(text: string): string | null {
  const blockers = fieldOf(text, "blockers");
  if (blockers === null) return null;
  const found = /waiting (?:for|on)\s*:?\s*([^;\n]+)/i.exec(blockers);
  if (found === null) return null;
  const what = found[1]!.trim();
  return /^the owner\b/i.test(what) || what === "" ? null : what;
}
