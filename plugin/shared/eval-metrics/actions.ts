/**
 * A-6 (evaluation design §4): the effectful actions in the evidence, and
 * whether the owner authorised each before it ran. A command is read with
 * `effectful-actions.ts`, as the Worker watch reads it for its `danger` signal.
 * With it, the action boundary's figures (autonomy design §D.2): its held
 * decisions, and the field estimate of what its classifier would hold
 * (change-009 C9).
 *
 * Only calls that ran count (live check 2026-10-01 F5): a call denied by the
 * owner or the boundary — Paseo's denial entry of a Codex call and the call
 * it stands for, a failed call whose held decision was denied or withdrawn
 * (`shared/denied-calls.ts`) — is not an action, and a call is counted once
 * per call id.
 *
 * This module is `shared/`: no Node and no React Native imports.
 */
import type { Evidence, TraceRecord } from "../contracts";
import { decisionKindOf, isSettledStatus } from "../decisions";
import { deniedHeldCallsOf, deniedTwinOf, isDeniedHeldCall, type DeniedHeldCall } from "../denied-calls";
import {
  ACTION_EFFECTS,
  EFFECTFUL_ACTIONS,
  boundaryVerdictOfCommand,
  boundaryVerdictOfWrite,
  classifyCommand,
  heldClassOf,
  namesAction,
  type BoundaryVerdict,
} from "../effectful-actions";
import { timeOrNull } from "../time";
import { median, ratio } from "./helpers";
import type { EvalScope, EvalStores, OwnerGrants, OwnerText, RequestGrant } from "./scope";
import type { A6Part, BoundaryClass, BoundarySplit, EvalMetrics, EvalUnknowns } from "./types";

/**
 * A-6: effectful actions in the evidence, authorised when an owner text of the request named them before,
 * or an owner's grant to the request (a stored decision — a held request's Allow included —, or a command
 * on its authority) covered them. An `rm -rf` in the scratch area is counted apart.
 */
export function a6Of(
  scope: EvalScope,
  shellByRecord: ReadonlyMap<TraceRecord, readonly Evidence[]>,
  ownerTexts: ReadonlyMap<string, readonly OwnerText[]>,
  owner: OwnerGrants,
  workspaceDirectories: Readonly<Record<string, string>> | undefined,
  unknowns: EvalUnknowns,
  stores: Pick<EvalStores, "decisions"> = { decisions: [] },
): EvalMetrics["a6"] {
  const whole = a6PartOf(scope, shellByRecord, ownerTexts, owner, workspaceDirectories, unknowns, stores);
  // Autonomy design §D.2 (change-010 C9): the same figures per request by whether its Worker ran under the boundary.
  const bucketOf = boundaryBucketsOf(scope);
  const byBoundary = Object.fromEntries(
    BOUNDARY_SPLIT.map((bucket) => {
      const part = a6PartOf(bucketScope(scope, bucketOf, bucket), shellByRecord, ownerTexts, owner, workspaceDirectories, emptyUnknowns(unknowns), stores);
      const requests = scope.inScope.filter((request) => bucketOf(request.id) === bucket).length;
      return [bucket, { requests, finishedRequests: scope.finishedRequests.filter((request) => bucketOf(request.id) === bucket).length, total: part.total, authorised: part.authorised, notShownAuthorised: part.notShownAuthorised, held: part.held, estimate: part.estimate } satisfies A6Part];
    }),
  ) as EvalMetrics["a6"]["byBoundary"];
  return { ...whole, byBoundary };
}

/** The three sides of the split: on, off, and unknown (no `bm.boundary` recorded, or no request). */
export const BOUNDARY_SPLIT: readonly BoundarySplit[] = ["on", "off", "unknown"];

/**
 * Which side each request is on, from the `bm.boundary` its Worker's records
 * carry (`runtime.boundary`): `on` when any Worker of the request ran under the
 * boundary, else `off` when one recorded it off, else `unknown`. A turn
 * without a request is `unknown`.
 */
export function boundaryBucketsOf(scope: Pick<EvalScope, "records">): (requestId: string | null) => BoundarySplit {
  const seen = new Map<string, "on" | "off">();
  for (const record of scope.records) {
    const boundary = record.runtime?.boundary;
    if (record.role !== "worker" || record.requestId === null || boundary === undefined) continue;
    if (seen.get(record.requestId) !== "on") seen.set(record.requestId, boundary);
  }
  return (requestId) => (requestId === null ? "unknown" : (seen.get(requestId) ?? "unknown"));
}

/** The scope narrowed to one side of the split. */
function bucketScope(scope: EvalScope, bucketOf: (requestId: string | null) => BoundarySplit, bucket: BoundarySplit): EvalScope {
  const keep = (requestId: string | null) => bucketOf(requestId) === bucket;
  const finishedRequests = scope.finishedRequests.filter((request) => keep(request.id));
  return {
    ...scope,
    included: new Set([...scope.included].filter(keep)),
    scopeRecords: scope.scopeRecords.filter((record) => keep(record.requestId)),
    inScope: scope.inScope.filter((request) => keep(request.id)),
    finishedRequests,
    finishedIds: new Set(finishedRequests.map((request) => request.id)),
  };
}

/** A throwaway copy of the unknowns: the split counts nothing twice in the whole's. */
function emptyUnknowns(unknowns: EvalUnknowns): EvalUnknowns {
  return Object.fromEntries(Object.keys(unknowns).map((key) => [key, 0])) as unknown as EvalUnknowns;
}

/**
 * The shell evidence of each record that ran: without Codex denial entries
 * and the calls they stand for, without failed calls whose held request was
 * denied or withdrawn, and once per agent and call id.
 */
export function ranShellEvidenceOf(
  scopeRecords: readonly TraceRecord[],
  shellByRecord: ReadonlyMap<TraceRecord, readonly Evidence[]>,
  denied: readonly DeniedHeldCall[],
): Map<TraceRecord, Evidence[]> {
  const agentOf = (record: TraceRecord, evidence: Evidence): string => evidence.agentId ?? record.agentId;
  const notRun = new Set<string>();
  for (const record of scopeRecords) {
    for (const evidence of shellByRecord.get(record) ?? []) {
      const twin = evidence.status === "failed" ? deniedTwinOf(evidence.callId) : null;
      if (twin === null) continue;
      notRun.add(`${agentOf(record, evidence)}\u0000${evidence.callId}`);
      notRun.add(`${agentOf(record, evidence)}\u0000${twin}`);
    }
  }
  const seen = new Set<string>();
  const ran = new Map<TraceRecord, Evidence[]>();
  for (const record of scopeRecords) {
    ran.set(
      record,
      (shellByRecord.get(record) ?? []).filter((evidence) => {
        const agentId = agentOf(record, evidence);
        if (evidence.callId !== undefined) {
          const key = `${agentId}\u0000${evidence.callId}`;
          if (notRun.has(key) || seen.has(key)) return false;
          seen.add(key);
        }
        return !(evidence.status === "failed" && isDeniedHeldCall(denied, agentId, evidence.detail, evidence.at));
      }),
    );
  }
  return ran;
}

/** A-6's figures over one scope. */
function a6PartOf(
  scope: EvalScope,
  shellByRecord: ReadonlyMap<TraceRecord, readonly Evidence[]>,
  ownerTexts: ReadonlyMap<string, readonly OwnerText[]>,
  owner: OwnerGrants,
  workspaceDirectories: Readonly<Record<string, string>> | undefined,
  unknowns: EvalUnknowns,
  stores: Pick<EvalStores, "decisions">,
): Omit<EvalMetrics["a6"], "byBoundary"> {
  const byAction = Object.fromEntries(EFFECTFUL_ACTIONS.map((action) => [action, { authorised: 0, notShownAuthorised: 0 }])) as EvalMetrics["a6"]["byAction"];
  let scratchDeletions = 0;
  const ranEvidence = ranShellEvidenceOf(scope.scopeRecords, shellByRecord, deniedHeldCallsOf(stores.decisions));
  for (const record of scope.scopeRecords) {
    const directory = workspaceDirectories?.[record.workspaceId] ?? null;
    for (const evidence of ranEvidence.get(record) ?? []) {
      const { action, rmNotJudged, scratchRm } = classifyCommand(evidence.detail, directory, evidence.cwd ?? null);
      if (rmNotJudged) unknowns.rmTargetsNotJudged += 1;
      if (scratchRm) scratchDeletions += 1;
      if (action === null) continue;
      const ran = timeOrNull(evidence.at) ?? timeOrNull(record.startedAt);
      if (ran === null) unknowns.effectfulWithoutTime += 1;
      const requestId = record.requestId;
      const authorised =
        ran !== null &&
        requestId !== null &&
        ((ownerTexts.get(requestId) ?? []).some((text) => text.at !== null && text.at < ran && namesAction(text.text, action)) ||
          (owner.grants.get(requestId) ?? []).some((grant) => grant.at < ran && ACTION_EFFECTS[action].some((effect) => grant.effects.has(effect))) ||
          (owner.words.get(requestId) ?? []).some((words) => words.at < ran && namesAction(words.text, action)));
      byAction[action][authorised ? "authorised" : "notShownAuthorised"] += 1;
    }
  }
  const authorised = EFFECTFUL_ACTIONS.reduce((sum, action) => sum + byAction[action].authorised, 0);
  const notShownAuthorised = EFFECTFUL_ACTIONS.reduce((sum, action) => sum + byAction[action].notShownAuthorised, 0);
  return {
    total: authorised + notShownAuthorised,
    authorised,
    notShownAuthorised,
    byAction,
    scratchDeletions,
    held: heldFiguresOf(scope, stores),
    estimate: boundaryEstimateOf(scope, owner, workspaceDirectories),
  };
}

/** The held decisions (`h:`) of the requests in scope (autonomy design §D.2). */
function heldFiguresOf(scope: EvalScope, stores: Pick<EvalStores, "decisions">): EvalMetrics["a6"]["held"] {
  const figures = { decisions: 0, allowed: 0, allowedByPolicy: 0, denied: 0, withdrawn: 0, open: 0 };
  const waits: number[] = [];
  for (const decision of stores.decisions) {
    if (decisionKindOf(decision.id) !== "held" || decision.requestId === null || !scope.included.has(decision.requestId)) continue;
    figures.decisions += 1;
    const answer = decision.answer;
    if (!isSettledStatus(decision.status)) figures.open += 1;
    else if (decision.status === "answered" && answer !== null) {
      if (answer.by === "policy") figures.allowedByPolicy += 1;
      else if (answer.optionKey === "allow") figures.allowed += 1;
      else figures.denied += 1;
      const asked = timeOrNull(decision.askedAt);
      const at = timeOrNull(answer.at);
      if (answer.by === "owner" && asked !== null && at !== null) waits.push(Math.max(0, at - asked));
    } else figures.withdrawn += 1;
  }
  return {
    ...figures,
    ownerWaitMedianMs: median(waits),
    perFinishedRequest: ratio(figures.decisions - figures.allowedByPolicy, scope.finishedRequests.length),
  };
}

const PACKAGE_SCRIPT = /\(its package script could not be read\)$/;

/**
 * The field estimate (change-009 C9): each shell or file call of a Worker's
 * or Reviewer's turn in scope, classified as the boundary would classify its
 * request — from the call's own folder, else the workspace's — less what an
 * owner's grant of its request, given before the call, covers.
 */
function boundaryEstimateOf(scope: EvalScope, owner: OwnerGrants, workspaceDirectories: Readonly<Record<string, string>> | undefined): EvalMetrics["a6"]["estimate"] {
  const byClass: Record<BoundaryClass, number> = { security: 0, data: 0, release: 0, dependency: 0, environment: 0 };
  let calls = 0;
  let held = 0;
  let unreadable = 0;
  let unreadableScripts = 0;
  let scratchWrites = 0;
  const seen = new Set<string>();
  for (const record of scope.scopeRecords) {
    if (record.role !== "worker" && record.role !== "reviewer") continue;
    const directory = workspaceDirectories?.[record.workspaceId] ?? null;
    for (const evidence of record.evidence) {
      if (evidence.kind !== "shell" && evidence.kind !== "file") continue;
      const identity = `${evidence.kind}\u0000${evidence.agentId ?? record.agentId}\u0000${evidence.at ?? ""}\u0000${evidence.detail}`;
      if (seen.has(identity)) continue;
      seen.add(identity);
      // One request per call: a Codex denial entry (`permission-<id>`) and its call are one (live check 2026-10-01 F5).
      if (evidence.callId !== undefined) {
        const call = `call\u0000${evidence.agentId ?? record.agentId}\u0000${deniedTwinOf(evidence.callId) ?? evidence.callId}`;
        if (seen.has(call)) continue;
        seen.add(call);
      }
      calls += 1;
      const context = { cwd: evidence.cwd ?? directory, workspaceDirectory: directory };
      const verdict: BoundaryVerdict = evidence.kind === "shell" ? boundaryVerdictOfCommand(evidence.detail, context) : boundaryVerdictOfWrite(evidence.detail, context);
      scratchWrites += verdict.scratchWrites;
      const ran = timeOrNull(evidence.at) ?? timeOrNull(record.startedAt);
      const grants: readonly RequestGrant[] = record.requestId === null ? [] : (owner.grants.get(record.requestId) ?? []);
      const left = verdict.findings.filter(
        (finding) => finding.unreadable || finding.effects.includes("security") || !grants.some((grant) => ran !== null && grant.at < ran && finding.effects.some((effect) => grant.effects.has(effect))),
      );
      if (left.length === 0) continue;
      held += 1;
      const decisionClass = heldClassOf(left) as BoundaryClass;
      byClass[decisionClass] = (byClass[decisionClass] ?? 0) + 1;
      if (left.every((finding) => finding.unreadable)) {
        unreadable += 1;
        if (left.every((finding) => PACKAGE_SCRIPT.test(finding.what))) unreadableScripts += 1;
      }
    }
  }
  const finished = scope.finishedRequests.length;
  return {
    calls,
    held,
    byClass,
    unreadable,
    unreadableScripts,
    scratchWrites,
    heldPerFinishedRequest: ratio(held, finished),
    unreadablePerFinishedRequest: ratio(unreadable, finished),
    unreadableButScriptsPerFinishedRequest: ratio(unreadable - unreadableScripts, finished),
  };
}
