/**
 * The mission state reader (mission runtime design §2.1, ADR-033 decision 1,
 * REQ-202): `missionStateOf(home, missionId)` composes what the stores hold
 * about one mission into `MissionState` (`shared/mission-state.ts`) — its
 * requests with their real state, open questions with their decider, the
 * Main's open asks, live links, the owner's recent exchange with the Main, the
 * governor's raised families, the journal's newest lines.
 *
 * Reads only. Never throws: a store it cannot read leaves its part empty and
 * names it in `unknown`. Text is masked with `redactText`.
 */
import { join } from "node:path";
import { deciderOf, type AuthorityFacts } from "../shared/authority";
import { figureText } from "../shared/governor-figures";
import {
  MISSION_STATE_FINISHED_MS,
  MISSION_STATE_JOURNAL,
  MISSION_STATE_OWNER_ENTRIES,
  requestStateOf,
  waitingOnOf,
  type MissionState,
  type MissionStateLink,
  type MissionStateQuestion,
  type MissionStateRequest,
} from "../shared/mission-state";
import { UNSETTLED_STATUSES, decisionClassOf, type Decision } from "../shared/decisions";
import { redactText } from "./collector";
import { TRACES_DIR_NAME } from "./data-home";
import { authorityFactsOf } from "./authority-facts";
import { createDecisionStore } from "./decision-store";
import { createGovernorStore } from "./governor-store";
import { createMissionDecisionStore } from "./mission-decisions";
import { createMissionRoster, reportSummaryOf, type RosterEntry } from "./mission-roster";
import { createMissionStore, type Mission } from "./mission-store";
import { mainPlacesOf } from "./missions-home";
import { newestReportRecordOf, reportPhaseOf } from "./outbox";
import { createPeerLinkStore, isLiveLink, type PeerLink } from "./peer-links";
import { createRequestRegistry } from "./request-registry";
import { readRecords, readWorkspaceMeta } from "./trace-store";

export interface MissionStateDeps {
  now?: () => Date;
  env?: NodeJS.ProcessEnv;
  log?: (message: string) => void;
  /** The resolver's facts; `authorityFactsOf(home)` by default. */
  facts?: AuthorityFacts;
  /** A repo's name; the trace store's last known name by default. */
  repoName?: (workspaceId: string) => string | null;
}

function cut(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

/** What a report says in one line (design §2.1): `reportSummaryOf`. */
export const reportLineOf = reportSummaryOf;

export { waitingOnOf };

/** The newest report of a roster entry: its phase, time, line and record text. */
function newestReport(home: string, entry: RosterEntry): { phase: string; at: string; line: string; text: string } | null {
  for (const workerId of [...entry.workerIds].reverse()) {
    const record = newestReportRecordOf(home, entry.workspaceId, workerId);
    if (record === null) continue;
    return { phase: reportPhaseOf(record.text) ?? "unknown", at: record.createdAt, line: reportLineOf(record.text), text: record.text };
  }
  return null;
}

/** The missions state of `missionId` in the data folder `home`; null for an unknown mission. Never throws. */
export function missionStateOf(home: string, missionId: string, deps: MissionStateDeps = {}): MissionState | null {
  const now = (deps.now ?? (() => new Date()))();
  const env = deps.env ?? process.env;
  const log = deps.log ?? (() => {});
  const text = (value: string, max: number) => cut(redactText(value, env), max);
  const unknown: string[] = [];
  const quietly = <T>(what: string, read: () => T, fallback: T): T => {
    try {
      return read();
    } catch (error) {
      unknown.push(what);
      log(`[paseo-bm] the mission state of ${missionId} could not read ${what}: ${error instanceof Error ? error.message : String(error)}`);
      return fallback;
    }
  };
  const mission: Mission | null = quietly("the mission", () => createMissionStore(home).get(missionId), null);
  if (mission === null) return null;
  const facts = deps.facts ?? authorityFactsOf(home, log);
  const location = { tracesDir: join(home, TRACES_DIR_NAME) };
  const repoName = (workspaceId: string): string | null => {
    const given = deps.repoName?.(workspaceId) ?? null;
    if (given !== null) return given;
    try {
      return readWorkspaceMeta(location, workspaceId)?.lastKnownName ?? null;
    } catch {
      return null;
    }
  };

  // Questions: the unsettled q: of the roster's requests, and the mission's unsettled m: decisions.
  const roster = quietly("the roster", () => createMissionRoster(home).list(missionId), [] as RosterEntry[]);
  const decisions = createDecisionStore(home, { log });
  const questionOf = (decision: Decision): MissionStateQuestion => {
    const decider = deciderOf(decision, facts);
    const qn = decision.id.startsWith("q:") ? decision.id.slice(decision.id.lastIndexOf(":") + 1) : null;
    const recommended = decision.options.find((option) => option.recommended);
    return {
      id: decision.id,
      requestId: decision.requestId,
      qn,
      class: decisionClassOf(decision),
      subject: decision.subject,
      decider: decider.decider,
      recommend: decider.recommend,
      askedAt: decision.askedAt,
      question: text(decision.question.split("\n")[0] ?? "", 300),
      recommended: recommended === undefined ? null : `${recommended.key} — ${text(recommended.label, 120)}`,
    };
  };
  const openOf = new Map<string, MissionStateQuestion[]>();
  for (const entry of roster) {
    const open = quietly(`the decisions of ${entry.requestId}`, () => decisions.list({ workspaceId: entry.workspaceId, requestId: entry.requestId, statuses: UNSETTLED_STATUSES }), [] as Decision[]);
    openOf.set(entry.requestId, open.map(questionOf));
  }
  const missionCards = quietly("the mission's cards", () => createMissionDecisionStore(home).list(missionId, UNSETTLED_STATUSES), [] as Decision[]);

  // Requests: every active one, and those finished or stopped within the last day.
  const registry = createRequestRegistry(home, { log });
  const requests: MissionStateRequest[] = roster.flatMap((entry) => {
    const report = quietly(`the reports of ${entry.requestId}`, () => newestReport(home, entry), null);
    const finishedAt = report === null ? Date.parse(entry.createdAt) || 0 : Date.parse(report.at) || 0;
    const followUpAt = (entry as RosterEntry & { followUpAt?: string | null }).followUpAt ?? null;
    if (entry.state !== "active" && now.getTime() - finishedAt > MISSION_STATE_FINISHED_MS && (followUpAt === null || (Date.parse(followUpAt) || 0) <= finishedAt)) return [];
    const open = openOf.get(entry.requestId) ?? [];
    const waitingOn = report === null ? null : waitingOnOf(report.text);
    const workerId = entry.workerIds.at(-1) ?? quietly("the registry", () => registry.get(entry.workspaceId, entry.requestId)?.workerIds.at(-1) ?? null, null);
    return [
      {
        requestId: entry.requestId,
        workspaceId: entry.workspaceId,
        repo: repoName(entry.workspaceId),
        topic: text(entry.topic, 120),
        workerId,
        state: requestStateOf({
          rosterState: entry.state,
          lastReport: report,
          followUpAt,
          openDeciders: open.map((question) => question.decider),
          waitingOn,
        }),
        lastReport: report === null ? null : { phase: report.phase, at: report.at, line: text(report.line, 200) },
        followUpAt,
        waitingOn: waitingOn === null ? null : text(waitingOn, 200),
      },
    ];
  });

  // Links: live links one of the mission's requests asked or took, or addressed to the mission.
  const requestIds = new Set(roster.map((entry) => entry.requestId));
  const mainIds = new Set([mission.mainId, ...mission.mainHistory.map((entry) => entry.agentId)].filter((id): id is string => id !== null));
  const links: MissionStateLink[] = quietly("the links", () => createPeerLinkStore(home).list(), [] as PeerLink[])
    .filter((link) => isLiveLink(link))
    .flatMap((link): MissionStateLink[] => {
      const out = (link.from.requestId !== null && requestIds.has(link.from.requestId)) || mainIds.has(link.from.agentId);
      const into = (link.to.requestId !== null && requestIds.has(link.to.requestId)) || link.missionId === missionId || (link.to.managerId !== null && mainIds.has(link.to.managerId));
      if (!out && !into) return [];
      const partnerSide = out ? link.to : link.from;
      const partner = link.route === "mission" ? `mission ${out ? (link.missionId ?? "unknown") : "asker"}` : (repoName(partnerSide.workspaceId) ?? partnerSide.workspaceId);
      return [{ linkId: link.linkId, route: link.route ?? "project", kind: link.kind, direction: out ? "out" : "in", partner, state: link.state, waitingSince: link.waitingSince, gist: text(link.text, 160) }];
    });

  // The owner's exchange with the Main: owner-typed messages and the first paragraph of the Main's replies, newest last.
  const traced = mainPlacesOf(home, mission);
  const owner = traced
    .flatMap((workspaceId) => quietly("the Main's turns", () => readRecords(location, workspaceId).records, []))
        .filter((record) => mainIds.has(record.agentId))
        .flatMap((record) => [
          ...record.sent.filter((message) => message.origin === "user").map((message) => ({ at: message.at, from: "owner" as const, text: text(message.text, 300) })),
          ...record.received.slice(0, 1).map((message) => ({ at: message.at, from: "main" as const, text: text(message.text.split(/\n\s*\n/)[0] ?? "", 300) })),
        ])
        .filter((entry) => entry.text !== "")
        .sort((a, b) => (Date.parse(a.at) || 0) - (Date.parse(b.at) || 0))
        .slice(-MISSION_STATE_OWNER_ENTRIES);

  const ladder = quietly("the governor's ladder", () => createGovernorStore(home).ladder(missionId), {});
  const governor = Object.entries(ladder)
    .filter(([, state]) => state !== undefined && state.step > 0)
    .map(([family, state]) => ({ family, step: state!.step, since: state!.since, crossed: state!.figures.filter((figure) => figure.crossed).map(figureText) }));
  const journal = quietly("the journal", () => createMissionStore(home).journal(missionId, MISSION_STATE_JOURNAL), []).map((line) => ({ at: line.at, kind: line.kind, by: line.by, text: text(line.text, 200) }));

  return {
    at: now.toISOString(),
    mission: {
      missionId,
      code: mission.code,
      name: text(mission.name, 80),
      state: mission.state,
      goal: text(mission.charter.goal, 600),
      charterConfirmed: mission.charter.confirmedAt !== null,
      repos: mission.charter.repos.map((workspaceId) => ({ workspaceId, name: repoName(workspaceId) })),
      mainId: mission.mainId,
      mainHistory: mission.mainHistory.map((entry) => ({ agentId: entry.agentId, from: entry.from, to: entry.to, reason: entry.reason })),
    },
    criteria: {
      met: mission.charter.doneCriteria.filter((criterion) => criterion.status === "met").length,
      total: mission.charter.doneCriteria.length,
      open: mission.charter.doneCriteria.filter((criterion) => criterion.status === "open").map((criterion) => ({ id: criterion.id, text: text(criterion.text, 200) })),
    },
    requests: requests.sort((a, b) => (Date.parse(a.lastReport?.at ?? "") || 0) - (Date.parse(b.lastReport?.at ?? "") || 0)),
    questions: [...openOf.values()].flat().sort((a, b) => (Date.parse(a.askedAt) || 0) - (Date.parse(b.askedAt) || 0)),
    asks: missionCards.map((card) => {
      const recommended = card.options.find((option) => option.recommended);
      return {
        id: card.id,
        askedAt: card.askedAt,
        question: text(card.question.split("\n")[0] ?? "", 300),
        options: card.options.map((option) => text(option.label, 120)),
        recommended: recommended === undefined ? null : `${recommended.key} — ${text(recommended.label, 120)}`,
        byMain: mainIds.has(card.askedBy.agentId ?? ""),
      };
    }),
    links,
    owner,
    governor,
    journal,
    unknown,
  };
}
