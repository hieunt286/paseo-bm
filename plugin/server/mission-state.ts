/**
 * The mission state reader (mission runtime design §2.1, ADR-033 decision 1,
 * REQ-202): `missionStateOf(home, missionId)` composes what the stores hold
 * about one mission into `MissionState` (`shared/mission-state.ts`) — its
 * requests with their real state, open questions with their decider, the
 * Main's open asks, live links, the owner's recent exchange with the Main, the
 * governor's raised families, the journal's newest lines.
 *
 * Reads only, and runs no git: each placement's line is the one the
 * governor's 60-second pass last read (`line-watch.ts`, delivery line design
 * §4.9), and a request's `committed` is what its `finished` delivery said
 * (§4.6). Never throws: a store it cannot read leaves its part empty and
 * names it in `unknown`. Text is masked with `redactText`.
 */
import { join } from "node:path";
import { deciderOf, type AuthorityFacts } from "../shared/authority";
import { figureText } from "../shared/governor-figures";
import {
  MISSION_STATE_FINISHED_MS,
  MISSION_STATE_JOURNAL,
  MISSION_STATE_CONTRACTS,
  MISSION_STATE_OWNER_ENTRIES,
  requestStateOf,
  waitingOnOf,
  type MissionState,
  type MissionStateContract,
  type MissionStateLink,
  type MissionStatePlacement,
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
import { createMissionRoster, reportSummaryOf, requestIndexOf, type RosterEntry } from "./mission-roster";
import { contractStatusOf, createMissionStore, type Mission, type MissionContract } from "./mission-store";
import { finishedLineFactsOf, verifiedOf } from "./line-state";
import { integrationCiOf } from "./coordination-store";
import type { IntegrationCi } from "../shared/coordination";
import { cachedLineOf, newestPlacementsOf, placementStateOf, reportedLineOf, type ReportedLine } from "./line-watch";
import { mainPlacesOf } from "./missions-home";
import { newestReportRecordOf, reportPhaseOf } from "./outbox";
import { MAX_LIVE_LINKS_PER_REQUEST, actOf, createPeerLinkStore, isLiveLink, type PeerLink } from "./peer-links";
import { repoKeyOf } from "./placements";
import { refIdsOf } from "../shared/bm-tools";
import { chainPositionOf, createRequestRegistry, isBoundRequest, type RegisteredRequest } from "./request-registry";
import { readRecords, readWorkspaceMeta } from "./trace-store";

export interface MissionStateDeps {
  now?: () => Date;
  env?: NodeJS.ProcessEnv;
  log?: (message: string) => void;
  /** The resolver's facts; `authorityFactsOf(home)` by default. */
  facts?: AuthorityFacts;
  /** A repo's name; the trace store's last known name by default. */
  repoName?: (workspaceId: string) => string | null;
  /** The owner's `integration.ci` (ADR-036); the Coordination settings' by default. */
  ci?: IntegrationCi;
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

/** A link the state shows (delivery line design §9.1, §9.3): live, or closed within the last day so its close is read. */
function isShownLink(link: PeerLink, now: Date): boolean {
  return isLiveLink(link) || (link.state === "closed" && link.closedAt !== null && now.getTime() - (Date.parse(link.closedAt) || 0) <= MISSION_STATE_FINISHED_MS);
}

/**
 * A link as the state shows it, seen from its asking side (`out`) or its
 * answering side: its latest message, not its original ask (delivery line
 * design §9.3; a plain `peer` message is that ask).
 */
function linkStateOf(link: PeerLink, out: boolean, partner: string, text: (value: string, max: number) => string): MissionStateLink {
  const newest = link.messages.at(-1);
  const last =
    newest === undefined || (newest.kind === "peer" && (newest.act ?? "ask") === "ask")
      ? null
      : { act: actOf(newest), by: newest.side === (out ? "answerer" : "asker") ? partner : newest.agentId, at: newest.at, gist: text(newest.gist, 160), refs: refIdsOf(newest.refs) };
  return { linkId: link.linkId, route: link.route ?? "project", kind: link.kind, direction: out ? "out" : "in", partner, state: link.state, waitingSince: link.waitingSince, gist: text(link.text, 160), last };
}

/** The live contracts of `contracts` as the state shows them (delivery line design §9.3): proposed first, at most `MISSION_STATE_CONTRACTS`. */
function contractStatesOf(contracts: readonly MissionContract[], named: (workspaceId: string) => string, text: (value: string, max: number) => string): MissionStateContract[] {
  const live = contracts.filter((contract) => ["proposed", "agreed"].includes(contractStatusOf(contract)));
  return [...live.filter((contract) => contractStatusOf(contract) === "proposed"), ...live.filter((contract) => contractStatusOf(contract) === "agreed")]
    .slice(0, MISSION_STATE_CONTRACTS)
    .map((contract) => ({ id: contract.id, version: contract.version, status: contractStatusOf(contract), title: text(contract.title, 120), provider: named(contract.providerRepo), consumers: contract.consumerRepos.map(named) }));
}

/** The most links a request's state shows (delivery line design §9.3): the newest; as many as one request may ask. */
export const REQUEST_STATE_LINKS = MAX_LIVE_LINKS_PER_REQUEST;

/**
 * What a Worker's `BM-STATE` carries of its links and agreements (delivery
 * line design §9.3): the links its request asked or took — live, or closed
 * within the last day — with each one's latest message, newest last, at most
 * `REQUEST_STATE_LINKS`; and the live contracts of its mission whose provider
 * or consumers include its repo, proposed first. Never throws: a store it
 * cannot read gives nothing.
 */
export function requestLinksAndContractsOf(
  home: string,
  at: { workspaceId: string; requestId: string },
  deps: Pick<MissionStateDeps, "now" | "env" | "repoName"> = {},
): { links: MissionStateLink[]; contracts: MissionStateContract[] } {
  const now = (deps.now ?? (() => new Date()))();
  const env = deps.env ?? process.env;
  const text = (value: string, max: number) => cut(redactText(value, env), max);
  const location = { tracesDir: join(home, TRACES_DIR_NAME) };
  const named = (workspaceId: string): string => {
    try {
      return deps.repoName?.(workspaceId) ?? readWorkspaceMeta(location, workspaceId)?.lastKnownName ?? workspaceId;
    } catch {
      return workspaceId;
    }
  };
  const repo = repoKeyOf(home, at.workspaceId);
  let links: MissionStateLink[] = [];
  try {
    links = createPeerLinkStore(home)
      .list()
      .filter((link) => isShownLink(link, now))
      .flatMap((link) => {
        const out = link.from.workspaceId === at.workspaceId && link.from.requestId === at.requestId;
        const into = link.to.requestId === at.requestId && repoKeyOf(home, link.to.workspaceId) === repo;
        if (!out && !into) return [];
        return [linkStateOf(link, out, named((out ? link.to : link.from).workspaceId), text)];
      })
      .slice(-REQUEST_STATE_LINKS);
  } catch {
    links = [];
  }
  let contracts: MissionStateContract[] = [];
  try {
    const missionId = requestIndexOf(home, at.requestId)?.missionId ?? null;
    const mission = missionId === null ? null : createMissionStore(home).get(missionId);
    const touching = (mission?.contracts ?? []).filter((contract) => repoKeyOf(home, contract.providerRepo) === repo || contract.consumerRepos.some((consumer) => repoKeyOf(home, consumer) === repo));
    contracts = contractStatesOf(touching, named, text);
  } catch {
    contracts = [];
  }
  return { links, contracts };
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
  const ci = deps.ci ?? integrationCiOf(home);
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
  // Delivery line design §2.7: a chain is walked back through the mission's roster, the registry where the roster has no link.
  const rosterEntryOf = new Map(roster.map((entry) => [entry.requestId, entry]));
  const previousOf = (requestId: string): string | null => {
    const entry = rosterEntryOf.get(requestId);
    if (entry === undefined) return null;
    return entry.continuationOf ?? quietly("the registry", () => registry.get(entry.workspaceId, requestId), null as RegisteredRequest | null)?.continuationOf ?? null;
  };
  // Delivery line design §4.9: the newest git fields reported in each placement.
  const reportedIn = new Map<string, ReportedLine>();
  const requests: MissionStateRequest[] = roster.flatMap((entry) => {
    const report = quietly(`the reports of ${entry.requestId}`, () => newestReport(home, entry), null);
    const reported = report === null ? null : reportedLineOf(report);
    const known = reportedIn.get(entry.workspaceId);
    if (reported !== null && (known === undefined || (Date.parse(known.at) || 0) < (Date.parse(reported.at) || 0))) reportedIn.set(entry.workspaceId, reported);
    const finishedAt = report === null ? Date.parse(entry.createdAt) || 0 : Date.parse(report.at) || 0;
    const followUpAt = (entry as RosterEntry & { followUpAt?: string | null }).followUpAt ?? null;
    if (entry.state !== "active" && now.getTime() - finishedAt > MISSION_STATE_FINISHED_MS && (followUpAt === null || (Date.parse(followUpAt) || 0) <= finishedAt)) return [];
    const open = openOf.get(entry.requestId) ?? [];
    const waitingOn = report === null ? null : waitingOnOf(report.text);
    const registered = quietly("the registry", () => registry.get(entry.workspaceId, entry.requestId), null as RegisteredRequest | null);
    const workerId = entry.workerIds.at(-1) ?? registered?.workerIds.at(-1) ?? null;
    // Delivery line design §4.6: committed as the finished delivery said; verified again once Paseo reads the merge request's checks.
    // §17.1: with CI off, verified as the delivery said from the detected checks, a CI word of an older delivery read as unverified.
    const line = report?.phase === "finished" ? finishedLineFactsOf(report.text) : null;
    const cached = line?.committed === true && ci === "on" ? cachedLineOf(home, entry.workspaceId) : null;
    const pullRequest = cached?.descriptor?.pullRequest ?? null;
    const verified =
      line === null || !line.committed
        ? null
        : ci === "off"
          ? line.verified === "verified" ? "verified" : "unverified"
          : pullRequest === null
            ? line.verified
            : verifiedOf({ ci, committed: true, ...(reported === null ? {} : { integration: reported.integration }), aheadOfOrigin: cached?.line?.aheadOfOrigin ?? null, pullRequest });
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
          bound: isBoundRequest(registered),
        }),
        lastReport: report === null ? null : { phase: report.phase, at: report.at, line: text(report.line, 200) },
        followUpAt,
        waitingOn: waitingOn === null ? null : text(waitingOn, 200),
        // Delivery line design §2.7: the chain, as the roster and the registry hold it.
        continuationOf: entry.continuationOf ?? registered?.continuationOf ?? null,
        continuedBy: registered?.continuedBy ?? null,
        chainPosition: chainPositionOf(entry.continuationOf ?? registered?.continuationOf, previousOf),
        ...(line === null ? {} : { committed: line.committed, verified, commit: line.committed ? (reported?.integration.commit ?? null) : null }),
      },
    ];
  });

  // Links: live links one of the mission's requests asked or took, or addressed to the mission — and one closed within the last day, so its close is read (delivery line design §9.1).
  const requestIds = new Set(roster.map((entry) => entry.requestId));
  const mainIds = new Set([mission.mainId, ...mission.mainHistory.map((entry) => entry.agentId)].filter((id): id is string => id !== null));
  const links: MissionStateLink[] = quietly("the links", () => createPeerLinkStore(home).list(), [] as PeerLink[])
    .filter((link) => isShownLink(link, now))
    .flatMap((link): MissionStateLink[] => {
      const out = (link.from.requestId !== null && requestIds.has(link.from.requestId)) || mainIds.has(link.from.agentId);
      const into = (link.to.requestId !== null && requestIds.has(link.to.requestId)) || link.missionId === missionId || (link.to.managerId !== null && mainIds.has(link.to.managerId));
      if (!out && !into) return [];
      const partnerSide = out ? link.to : link.from;
      const partner = link.route === "mission" ? `mission ${out ? (link.missionId ?? "unknown") : "asker"}` : (repoName(partnerSide.workspaceId) ?? partnerSide.workspaceId);
      return [linkStateOf(link, out, partner, text)];
    });

  // Delivery line design §9.3: the live contracts, proposed first.
  const contracts = contractStatesOf(mission.contracts, (workspaceId) => repoName(workspaceId) ?? workspaceId, text);

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

  // Delivery line design §4.9: one line per repo, as last read; no git here.
  const placements: MissionStatePlacement[] = newestPlacementsOf(mission).map((placement) => {
    const shown = placementStateOf(
      placement,
      placement.workspaceId === null ? null : cachedLineOf(home, placement.workspaceId),
      placement.workspaceId === null ? null : (reportedIn.get(placement.workspaceId) ?? null),
      repoName(placement.repo),
      ci,
    );
    return { ...shown, mr: shown.mr === null ? null : { ...shown.mr, url: text(shown.mr.url, 300) } };
  });

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
    ...(placements.length === 0 ? {} : { placements }),
    contracts,
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
