/**
 * Continuations (delivery line design §2.4, §2.5, §2.7; ADR-035 decision 1).
 *
 * A bound request that is finished — or stopped — is final (§2.3). More work
 * on it goes on as a **continuation**: a new request of the same placement,
 * linked both ways (`continuationOf` / `chainRootId` on the new one,
 * `continuedBy` / `rollover` on the old), with a new Worker — always a new
 * one (§2.4 item 3). `openContinuation` is the one way to open it, through the
 * creation path every request takes (`createRequestWorker`); the mission's
 * staffing rule holds unchanged. A refused creation keeps the new id
 * registered with no Worker, and the old request is not marked continued.
 *
 * The new Worker's brief carries a block after its Manager's line (§2.5),
 * built from the stores with the handoff brief's helper
 * (`workerHandoverFacts`), masked and capped at the handoff brief's size.
 *
 * Nothing here throws: a failure is one refusal line.
 */
import { join } from "node:path";
import type { ParsedReport } from "../shared/contracts";
import { NO_BINDER, type AgentBinder } from "./agent-bindings";
import { readBeads } from "./beads-store";
import { redactText } from "./collector";
import {
  NO_WORKER_PROFILE_MESSAGE,
  createRequestWorker,
  folderOfAgent,
  missionBriefLines,
  missionRepoOf,
  peerLinesFor,
  staffingReasons,
  takeLinkQuietly,
  workerProfileOf,
  type ContextFact,
} from "./create-worker";
import { createDecisionStore } from "./decision-store";
import type { ServerToolAnswer } from "./decision-tools";
import { firstUserMessage, workerHandoverFacts } from "./fallback-handover";
import { HANDOFF_BRIEF_MAX_CHARS } from "./handoff";
import { AGENT_TOOLS_OFF_TOOL_MESSAGE, agentToolsOff } from "./manager";
import { createMemoryStore } from "./memory-store";
import { createMissionRoster, requestIndexOf } from "./mission-roster";
import { createMissionStore } from "./mission-store";
import { listedWorkspaces, titleIn, type DashboardPaseo } from "./paseo-directory";
import { createPeerLinkStore, isLiveLink } from "./peer-links";
import { repoKeyOf } from "./placements";
import { createRequestRegistry, isBoundRequest, type RegisteredRequest } from "./request-registry";
import { reasonOf } from "./role-choices";
import { refused } from "./tool-kit";
import { chainOf, locateRequest, type LocatedRequest } from "./waits";
import { decisionKindOf, isAnswerable } from "../shared/decisions";
import { BRIEF_PROMPT_MARKER } from "../shared/notices";
import { shorten } from "../shared/text";

export type ContinuationReason = NonNullable<RegisteredRequest["rollover"]>["reason"];

/**
 * How a bound request ended (delivery line design §2.3): `finished` by its
 * registry entry (or its roster), `stopped` by its mission's roster; null
 * while it runs, and for a hand-path request, which reopens. Never throws.
 */
export function endedPhaseOf(home: string, request: Pick<RegisteredRequest, "requestId" | "source" | "finishedAt">): "finished" | "stopped" | null {
  if (!isBoundRequest(request)) return null;
  if (request.finishedAt !== null) return "finished";
  try {
    const place = requestIndexOf(home, request.requestId);
    const state = place === null ? null : createMissionRoster(home).get(place.missionId, request.requestId)?.state;
    return state === "finished" || state === "stopped" ? state : null;
  } catch {
    return null;
  }
}

const list = (values: readonly string[] | null | undefined): string => (values === null || values === undefined || values.length === 0 ? "none" : [...new Set(values)].join(", "));

/**
 * The continuation's block of the brief (delivery line design §2.5): what it
 * continues and its place in the chain; the predecessor's last report; the
 * `feature:` labels of its beads; the chain's open questions and live links.
 * Masked, at most `HANDOFF_BRIEF_MAX_CHARS`. Never throws.
 */
export async function continuationLinesOf(
  home: string,
  prev: LocatedRequest,
  init: { reason: ContinuationReason; figure: string; cwd: string; report?: ParsedReport },
  paseo: unknown,
  log: (message: string) => void,
): Promise<string[]> {
  const { workspaceId, request } = prev;
  const chain = chainOf(home, request.requestId, workspaceId);
  const facts = await workerHandoverFacts(
    { workspaceId, requestId: request.requestId, agentId: request.workerIds.at(-1) ?? "" },
    { paseo, location: { tracesDir: join(home, "traces") }, log },
  );
  // A size finish's own report is not in the trace yet: the caller gives it.
  const report = init.report ?? facts.report;
  // `bm_report` writes its suggestions into `blockers`, each as "Suggestion (not done): …".
  const suggestions = [...(report?.blockers ?? "").matchAll(/Suggestion \(not done\): (.*?)(?=; Suggestion \(not done\):|$)/g)].map((match) => match[1]!.trim());
  let features: string[] = [];
  try {
    const beads = readBeads(init.cwd).beads;
    const ids = [...(report?.beadsClosed ?? []), ...(report?.beadsReady ?? []), ...(report?.beadsCreated ?? [])];
    features = ids.flatMap((id) => beads.get(id)?.labels.filter((label) => label.startsWith("feature:")) ?? []);
  } catch {
    // No labels: the beads cannot be read.
  }
  const ids = new Set(chain);
  let questions: string[] = [];
  try {
    const store = createDecisionStore(home, { log });
    questions = chain.flatMap((id) =>
      store
        .list({ workspaceId, requestId: id })
        .filter((decision) => decisionKindOf(decision.id) === "question" && isAnswerable(decision))
        .map((decision) => `- ${decision.id}: ${shorten(decision.question, 200)}`),
    );
  } catch (error) {
    log(`[paseo-bm] could not read the questions of the chain of ${request.requestId}: ${reasonOf(error)}`);
  }
  let links: string[] = [];
  try {
    links = createPeerLinkStore(home)
      .list()
      .filter((link) => isLiveLink(link) && (ids.has(link.from.requestId ?? "") || ids.has(link.to.requestId ?? "")))
      .map((link) => `- ${link.linkId} (${ids.has(link.from.requestId ?? "") ? "asked" : "answering"}, ${link.state}): ${shorten(link.text, 160)}`);
  } catch (error) {
    log(`[paseo-bm] could not read the links of the chain of ${request.requestId}: ${reasonOf(error)}`);
  }
  const lines = [
    `continues: ${request.requestId} (${init.reason}: ${init.figure})`,
    `chain: root ${request.chainRootId ?? request.requestId}, request ${chain.length + 1}`,
    `${request.requestId} last reported: ${report === null ? "nothing paseo-bm can read" : `${report.phase ?? "unknown"} at ${report.at}`}`,
    `tier: ${facts.tier ?? request.tier ?? "unknown"}`,
    `beadsClosed: ${list(report?.beadsClosed)}`,
    `beadsReady: ${list(report?.beadsReady)}`,
    `reviewFindingsOpen: ${report?.reviewFindingsOpen ?? "none"}`,
    `decided: ${list(report?.decided)}`,
    `suggestions: ${list(suggestions)}`,
    `buildAndTests: ${report?.buildAndTests ?? "unknown"}`,
    ...(report?.remaining === undefined ? [] : [`remaining: ${report.remaining.join("; ")}`]),
    `features: ${list(features)}`,
    questions.length === 0 ? "open questions of the chain: none" : "open questions of the chain (their answers come to you):",
    ...questions,
    links.length === 0 ? "live links of the chain: none" : "live links of the chain:",
    ...links,
  ];
  const block = redactText(lines.join("\n"));
  return (block.length <= HANDOFF_BRIEF_MAX_CHARS ? block : `${block.slice(0, HANDOFF_BRIEF_MAX_CHARS - 1)}…`).split("\n");
}

/**
 * A size continuation's request (delivery line design §2.4 item 2): the
 * chain root's request, verbatim — the quote of its first Worker's brief —
 * then "Remaining:" and the list. Never throws.
 */
export async function rolloverTextOf(home: string, prev: LocatedRequest, remaining: readonly string[], paseo: unknown): Promise<string> {
  const rootId = prev.request.chainRootId ?? prev.request.requestId;
  let words: string | null = null;
  try {
    const root = rootId === prev.request.requestId ? prev : locateRequest(home, rootId, prev.workspaceId);
    const first = root?.request.workerIds[0];
    const brief = first === undefined ? null : await firstUserMessage(paseo, first);
    if (brief !== null) {
      const lines = brief.startsWith(BRIEF_PROMPT_MARKER) ? brief.split("\n").slice(2) : [];
      const end = lines.findIndex((line) => !line.startsWith(">"));
      words = (end === -1 ? lines : lines.slice(0, end)).map((line) => line.replace(/^> ?/, "")).join("\n").trim() || brief;
    }
  } catch {
    // The root's words cannot be read: the line below says so.
  }
  return [words ?? `The request of ${rootId}; paseo-bm could not read its words.`, "", "Remaining:", ...remaining.map((item) => `- ${item}`)].join("\n");
}

export interface ContinuationInit {
  reason: ContinuationReason;
  /** The words the new Worker gets as its request: the Main's follow-up, verbatim, or a size rollover's `rolloverTextOf`. */
  text: string;
  /** What made it a continuation: `a follow-up after finished`, a size figure (§2.6). */
  figure: string;
  /** The Manager (the mission's current Main) the new Worker reports to. */
  managerId: string;
  source?: string;
  /** An open link of the placement the new request takes (§7.17.3). */
  peerLink?: string;
  /** The predecessor's final report, when the trace does not hold it yet (a size finish, §2.6). */
  report?: ParsedReport;
}

export interface ContinuationDeps {
  paseo: unknown;
  binder?: AgentBinder;
  log: (message: string) => void;
  now?: () => Date;
}

/**
 * Opens the continuation of `prev` (delivery line design §2.4): a new request
 * in `prev`'s placement with a new Worker briefed from the stores, linked
 * both ways once the Worker exists. Refused, creating nothing, as
 * `bm_create_worker` refuses (no Paseo tools, no profile, the mission's repo
 * or staffing rule, a link it cannot take). Never throws.
 */
export async function openContinuation(
  home: string,
  prev: LocatedRequest,
  init: ContinuationInit,
  deps: ContinuationDeps,
): Promise<{ requestId: string; workerId: string; peerLinkNotTaken?: string } | ServerToolAnswer> {
  const { paseo, log } = deps;
  const { workspaceId, request } = prev;
  try {
    if (await agentToolsOff(paseo)) return refused(AGENT_TOOLS_OFF_TOOL_MESSAGE);
    const profile = await workerProfileOf(paseo, log);
    if (profile === null) return refused(NO_WORKER_PROFILE_MESSAGE);
    const place = requestIndexOf(home, request.requestId);
    const mission = place === null ? null : createMissionStore(home).get(place.missionId);
    if (place !== null && mission === null) return refused(`paseo-bm could not read the mission of request ${request.requestId}; try again in a moment. Nothing was created.`);
    let cwd: string | null;
    let missionLines: string[] | undefined;
    if (mission === null) {
      // The predecessor's own folder: its Worker's, else its Manager's.
      cwd = await folderOfAgent(paseo, request.workerIds.at(-1) ?? init.managerId, workspaceId);
      if (cwd === null) return refused(`paseo-bm could not read the folder of request ${request.requestId} from Paseo; try again in a moment. Nothing was created.`);
    } else {
      const listed = await listedWorkspaces(paseo as DashboardPaseo);
      const repo = missionRepoOf(home, mission, workspaceId, listed);
      const reasons = Array.isArray(repo) ? repo : await staffingReasons(home, paseo as DashboardPaseo, mission, workspaceId, listed);
      if (reasons.length > 0 || Array.isArray(repo)) return refused([...reasons, "Nothing was created."].join("\n"));
      cwd = repo.directory;
      missionLines = missionBriefLines({ mission, workspaceId: repoKeyOf(home, workspaceId), memory: createMemoryStore(home).live(workspaceId), request: init.text, titleOf: (id) => titleIn(listed, id) });
    }
    const peer = init.peerLink === undefined ? undefined : await peerLinesFor(home, paseo, init.peerLink, workspaceId, mission?.missionId ?? null, deps.binder ?? NO_BINDER);
    if (typeof peer === "string") return refused(`${peer} Nothing was created.`);
    const lines = await continuationLinesOf(home, prev, { reason: init.reason, figure: init.figure, cwd, ...(init.report === undefined ? {} : { report: init.report }) }, paseo, log);
    const context: ContextFact[] = init.source === undefined ? [] : [{ fact: "the words above", source: init.source }];
    const made = await createRequestWorker(
      home,
      paseo,
      {
        tool: "bm_tell_worker",
        workspaceId,
        managerId: init.managerId,
        cwd,
        request: init.text,
        context,
        model: profile.model,
        mission,
        ...(missionLines === undefined ? {} : { missionLines }),
        ...(peer === undefined ? {} : { peer }),
        continuation: { of: request, lines },
      },
      { ...(deps.binder === undefined ? {} : { binder: deps.binder }), log },
    );
    if ("ok" in made) return made;
    try {
      const at = (deps.now?.() ?? new Date()).toISOString();
      createRequestRegistry(home, { log }).noteContinuedBy(workspaceId, request.requestId, made.requestId, { reason: init.reason, figure: init.figure, at });
    } catch (error) {
      log(`[paseo-bm] could not note that request ${made.requestId} continues ${request.requestId}: ${reasonOf(error)}`);
    }
    if (init.peerLink === undefined) return made;
    const taken = takeLinkQuietly(home, init.peerLink, { workspaceId, requestId: made.requestId, workerId: made.workerId, managerId: init.managerId }, log);
    return taken === null ? made : { ...made, peerLinkNotTaken: taken };
  } catch (error) {
    return refused(`paseo-bm could not open the continuation of ${request.requestId} (${reasonOf(error)}). Nothing was created.`);
  }
}
