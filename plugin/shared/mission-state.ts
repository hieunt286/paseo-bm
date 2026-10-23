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
  /** Delivery line design §2.7: the request this one continues; absent or null when none. */
  continuationOf?: string | null;
  /** Delivery line design §2.7: the request that continues this one; absent or null when none. */
  continuedBy?: string | null;
  /** Delivery line design §2.7: its place in its chain (2 for the first continuation); absent or null when it continues none. */
  chainPosition?: number | null;
  /** Delivery line design §4.6: a placement request's `finished` was committed on its mission branch; absent or null when not one. */
  committed?: boolean | null;
  /** Delivery line design §4.6: whether that commit is verified; absent or null when not committed. */
  verified?: MissionLineVerified | null;
  /** Delivery line design §4.4: the commit its `finished` reported; absent or null when not committed or none was named. */
  commit?: string | null;
}

/** Delivery line design §4.6: verified, CI red, CI pending or unverified (`server/line-state.ts` `Verified`). */
export type MissionLineVerified = "verified" | "ci-red" | "pending" | "unverified";

/**
 * A mission's line in one repo (delivery line design §4.9): its newest
 * placement and what git, Paseo's descriptor and the newest report say of it.
 */
export interface MissionStatePlacement {
  /** The repo key. */
  repo: string;
  name: string | null;
  workspaceId: string | null;
  branch: string;
  target: string;
  state: string;
  /** From read-only git; null while not read, or unreadable. */
  dirty: boolean | null;
  ahead: number | null;
  behind: number | null;
  lastCommitAt: string | null;
  pushed: boolean | null;
  mr: { url: string; state: string | null; mergeable: boolean | null } | null;
  /** The forge's CI state: "none", "pending", "success", "failure" or "not-run"; null when unknown. */
  ci: string | null;
  /** The standing integration grant (§4.3), while granted. */
  grant: { at: string } | null;
  /** When paseo-bm last read the line with git (at most once a minute); null before its first read of the run. */
  readAt: string | null;
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
  /** The original ask. */
  gist: string;
  /** Delivery line design §9.3: the link's latest message, shown instead of its ask; absent or null when none. */
  last?: MissionStateLinkMessage | null;
}

/** A link's latest message (delivery line design §9.3). */
export interface MissionStateLinkMessage {
  /** Its act; an older message without one is an answer. */
  act: string;
  /** Who wrote it: the partner, or the agent of the mission's side. */
  by: string;
  at: string;
  gist: string;
  /** The ids its refs name, in order. */
  refs: string[];
}

/** A live contract of the mission (delivery line design §9.3). */
export interface MissionStateContract {
  id: string;
  version: number;
  /** proposed or agreed: a superseded or withdrawn contract is not in the state. */
  status: string;
  title: string;
  provider: string;
  consumers: string[];
}

/** The most contracts the rendering lists (delivery line design §9.3). */
export const MISSION_STATE_CONTRACTS = 10;

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
  /** Delivery line design §4.9: one line per repo with a placement; absent or empty: the mission has none. */
  placements?: MissionStatePlacement[];
  /** Delivery line design §9.3: the live contracts, proposed first; absent from an older state. */
  contracts?: MissionStateContract[];
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
 * by the roster (unless a follow-up came after the newest report — never for
 * a bound request, whose finished or stopped is final, delivery line design
 * §2.3); an open question for the owner; one for the Main; a `blocked` report
 * waiting on something else; otherwise working. Pure.
 */
export function requestStateOf(input: {
  rosterState: "active" | "finished" | "stopped";
  lastReport: { phase: string; at: string } | null;
  followUpAt: string | null;
  openDeciders: readonly Decider[];
  waitingOn: string | null;
  /** True for a request the plugin's tools created (delivery line design §2.3); absent = the hand path. */
  bound?: boolean;
}): MissionRequestState {
  const reportAt = input.lastReport === null ? Number.NEGATIVE_INFINITY : Date.parse(input.lastReport.at) || 0;
  const followedUp = input.bound !== true && input.followUpAt !== null && (Date.parse(input.followUpAt) || 0) > reportAt;
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

/** ", committed, verified" / ", uncommitted" of a placement request's finish (delivery line design §4.6); "" for any other. */
function committedWords(request: Pick<MissionStateRequest, "committed" | "verified">): string {
  if (request.committed === undefined || request.committed === null) return "";
  if (!request.committed) return ", uncommitted";
  const ci = request.verified === "verified" ? ", verified" : request.verified === "ci-red" ? ", CI red" : request.verified === "pending" ? ", CI pending" : "";
  return `, committed${ci}`;
}

/** One repo's line (delivery line design §4.9): `- back: m/XAI/back → develop, ready; ahead 3, behind 12; …`. Pure. */
export function placementLineOf(placement: MissionStatePlacement, now: number): string {
  const read =
    placement.readAt === null
      ? ["not read yet"]
      : [
          `ahead ${placement.ahead ?? "unknown"}, behind ${placement.behind ?? "unknown"}`,
          placement.dirty === true ? "uncommitted changes" : placement.dirty === false ? "clean" : "",
          placement.lastCommitAt === null ? "" : `last commit ${ago(placement.lastCommitAt, now)}`,
        ];
  const mr = placement.mr === null ? "no merge request" : `MR ${cut(placement.mr.url, 120)}${placement.mr.state === null ? "" : ` ${placement.mr.state}`}${placement.mr.mergeable === false ? ", conflicting" : ""}`;
  const parts = [
    `${placement.branch} → ${placement.target}, ${placement.state}`,
    ...read,
    placement.pushed === true ? "pushed" : placement.pushed === false ? "not pushed" : "",
    mr,
    placement.ci === null || placement.ci === "none" ? "" : `CI ${placement.ci}`,
    placement.grant === null ? "push & MR not allowed" : "push & MR allowed",
  ];
  return `- ${placement.name ?? placement.repo}: ${parts.filter((part) => part !== "").join("; ")}`;
}

/** One contract's line (delivery line design §9.3): `- C2 v3 proposed: <title> (provider <repo>; consumers <repos>)`. Pure. */
export function contractLineOf(contract: MissionStateContract): string {
  return `- ${contract.id} v${contract.version} ${contract.status}: ${cut(contract.title, 120)} (provider ${contract.provider}; consumers ${contract.consumers.length === 0 ? "none" : contract.consumers.join(", ")})`;
}

/**
 * One link's line (delivery line design §9.3): its latest message, not its
 * original ask — `- peer-… to mission B (question, open, waiting 2 h ago): last
 * answer by B 40 min ago: <gist> · refs C2@v3`; the ask while it has no message. Pure.
 */
export function linkLineOf(link: MissionStateLink, now: number): string {
  const head = `- ${link.linkId} ${link.direction === "out" ? "to" : "from"} ${link.partner} (${link.kind}, ${link.state}${link.waitingSince === null ? "" : `, waiting ${ago(link.waitingSince, now)}`})`;
  const last = link.last ?? null;
  if (last === null) return `${head}: ${cut(link.gist, 160)}`;
  return `${head}: last ${last.act} by ${last.by} ${ago(last.at, now)}: ${cut(last.gist, 160)}${last.refs.length === 0 ? "" : ` · refs ${last.refs.join(", ")}`}`;
}

/**
 * The order sections drop in when the rendering is too long (design §2.2;
 * delivery line design §9.3: Contracts after Recently and before Links).
 */
const DROP_ORDER = ["Recently", "Governor", "The owner said lately", "Contracts", "Links", "Yours to decide", "Waiting on the owner", "Lines", "In flight"] as const;

/**
 * The rendering of design §2.2: a header, then In flight, Lines (delivery
 * line design §4.9, when the mission has a placement), Contracts (§9.3),
 * Waiting on the owner, Yours to decide, Links, The owner said lately,
 * Governor, Recently, and where the rest is. Sections drop in `DROP_ORDER`,
 * and lines from the oldest, until it fits `maxChars`. The caller masks
 * nothing more: the state's text is masked when read. Pure.
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
        // Delivery line design §2.7: a finished request that was continued names its continuation.
        const words = request.state === "finished" && typeof request.continuedBy === "string" ? `finished → ${request.continuedBy}` : REQUEST_STATE_WORDS[request.state];
        return `- ${request.requestId} in ${request.repo ?? repoName(request.workspaceId)}: ${words}${committedWords(request)}; Worker ${request.workerId ?? "none"}; ${report}${follow}${waiting}${request.topic === "" ? "" : `; asked: ${cut(request.topic, 120)}`}`;
      }),
    },
    // Delivery line design §4.9: one line per repo; a mission with no placement has no section.
    ...((state.placements ?? []).length === 0 ? [] : [{ title: "Lines", lines: state.placements!.map((placement) => placementLineOf(placement, now)) }]),
    // Delivery line design §9.3: the live contracts, proposed first; the lines drop from the end (the oldest agreed).
    { title: "Contracts", lines: contractsInOrder(state.contracts ?? []).map(contractLineOf) },
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
      lines: state.links.map((link) => linkLineOf(link, now)),
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
  // Lines go from the oldest end of each section in `DROP_ORDER` (Contracts from its end: agreed after proposed), then whole sections, until it fits.
  for (const title of DROP_ORDER) {
    const part = kept.find((section) => section.title === title);
    while (part !== undefined && text.length > maxChars && part.lines.length > 0) {
      if (title === "Contracts") part.lines.pop();
      else part.lines.shift();
      text = render(kept);
    }
  }
  return text.length <= maxChars ? text : `${text.slice(0, maxChars - 1)}…`;
}

/** The live contracts (delivery line design §9.3): proposed first, then agreed, each in its order; at most `MISSION_STATE_CONTRACTS`. Pure. */
function contractsInOrder(contracts: readonly MissionStateContract[]): MissionStateContract[] {
  const live = contracts.filter((contract) => contract.status === "proposed" || contract.status === "agreed");
  return [...live.filter((contract) => contract.status === "proposed"), ...live.filter((contract) => contract.status !== "proposed")].slice(0, MISSION_STATE_CONTRACTS);
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
