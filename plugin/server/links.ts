/**
 * Links, derived (autonomy design §E.1, REQ-150; change-011 C1–C5): the chain
 * behind a request — request → decisions (and the precedents behind their
 * answers) → beads → changes → commits → checks → review verdicts → turns —
 * and the lookups from a bead, a changed file or a decision back to the
 * request(s) whose chain holds it.
 *
 * Read-only, with no store of its own: every link is read from a store that
 * exists, by identity, and carries its source (`store`, `id`).
 *
 * - **The request** is the rebuilt trace (`request-trace.ts`
 *   `workspaceTracesOf` / `traceOfRequest`), the one rebuild the Dashboard,
 *   `bm_request` and the watchers read. Without Paseo's agent list (`paseo:
 *   null`, the audit) it is rebuilt from the store alone, and the handoff
 *   link, which needs the `bm.handoffFrom` label, is missing with that reason.
 * - **Decisions:** every decision whose `requestId` is the request's (`q:`,
 *   `o:`, `f:`, `h:`, `r:`); a precedent answer links to its precedent. A
 *   project-wide `o:` (null `requestId`) is in no chain.
 * - **Beads:** `trace-timing.ts` `beadActionsOf` (reports exact, `br`
 *   commands inferred), each bead's record from `beads-store.ts` `readBeads`,
 *   whose `Split-from: <id>` is an edge.
 * - **Changes:** the reports' `filesChanged` and the turns' edit/write `file`
 *   evidence, by the path relative to the workspace folder, labelled as
 *   `shared/evidence.ts` labels them. Commits add to them and are never
 *   required: one that names a bead of the request links to it; one that
 *   names no stored bead links by path and time, and is marked so.
 * - **Checks:** `trace-views.ts` `verificationOf`. **Reviews:** the trace's
 *   own `BM-REVIEW` blocks, by batch. **Turns:** the trace's records, keyed by
 *   agent and time (Paseo reuses turn ids).
 *
 * Every link is `found`, `absent` (the request never had one, and the chain
 * says why: complete for A-10) or `missing` (it should exist and was not
 * found, or its source could not be read: incomplete), never a throw.
 *
 * Supersession is kept as edges, never collapsed: a decision's
 * `supersedes`/`supersededBy`, a precedent's `supersededBy`, a bead's
 * `Split-from`, a handoff (`bm.handoffFrom`) and a fallback replacement
 * (`bm.replacedBy`).
 *
 * **Cache.** Each source is read again only when the mtime or size of a file
 * it comes from changed: the trace files and the workspace's `meta.json`, the
 * decision file, `precedents.json`, `issues.jsonl` (`readBeads`' own cache),
 * and for `git log` the repository's `HEAD`, `logs/HEAD` and `packed-refs`.
 * Paseo's lists are live reads. Nothing is written anywhere.
 *
 * The derivation (`deriveChain`) is pure, over already-read inputs, so the
 * audit and the tests run it on synthetic stores.
 */
import { readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { Confidence, TraceRecord } from "../shared/contracts";
import { beadIdCandidates } from "../shared/bead-ids";
import { decisionKindOf, type AnswerBy, type Decision } from "../shared/decisions";
import {
  normalisedPath,
  pathKeyOf,
  sameFile,
  verificationOf as claimsOf,
  type CheckClaim,
  type ChecksVerdict,
  type ClaimLabel,
} from "../shared/evidence";
import type { Precedent } from "../shared/precedents";
import { timeOrZero } from "../shared/time";
import { AUTONOMY_DIR_NAME } from "./autonomy-store";
import { readBeads, type BeadRecord } from "./beads-store";
import { createDecisionStore, decisionsDirOf } from "./decision-store";
import { bmAgentsOf, directoryIn, listedWorkspaces, type DashboardPaseo } from "./paseo-directory";
import { PRECEDENTS_FILE, createPrecedentStore } from "./precedent-store";
import { GIT_READ_ONLY_PREFIX, REPO_TIMEOUT_MS, runGit, type GitRunner } from "./repo-tool";
import { firstLine, lastActivityOf, traceOfRequest, workspaceTracesOf, type WorkspaceTraces } from "./request-trace";
import { errorText } from "./rpc-kit";
import { beadActionsOf } from "./trace-timing";
import { dataFolderOf, monthlyFiles, readWorkspaceMeta, type TraceStoreLocation } from "./trace-store";
import { verificationOf } from "./trace-views";
import { handoffSuccessorsOf, type AgentFacts, type ReconstructedTrace } from "./traces";

/** The most commits one `git log` of a request reads. */
export const LINKS_GIT_MAX_COMMITS = 200;
/** The largest `git log` output taken in. */
export const LINKS_GIT_MAX_BYTES = 1024 * 1024;
/** How long after the request's last recorded activity a commit still falls in its span. */
export const LINKS_GIT_SLACK_MS = 10 * 60 * 1000;

// ---------------------------------------------------------------------------
// The chain.
// ---------------------------------------------------------------------------

/** Where a link was read: the store and the id inside it. */
export interface LinkSource {
  store: "traces" | "decisions" | "precedents" | "beads" | "git" | "paseo";
  id: string;
}

/**
 * `found`: the link is there. `absent`: the request never had one, and
 * `reason` says why (no question asked, a Small request's beads or review, a
 * report saying `filesChanged: none`). `missing`: it should exist and was not
 * found, or its source could not be read; `reason` says which.
 */
export type LinkStatus = "found" | "absent" | "missing";

export interface Link<T> {
  status: LinkStatus;
  /** Why it is absent or missing; null when found. */
  reason: string | null;
  items: T[];
}

export interface RequestLink {
  source: LinkSource;
  requestId: string;
  traceId: string;
  requestedAt: string;
  /** The request's first line, masked; null when its text was not recorded. */
  text: string | null;
  state: ReconstructedTrace["state"];
  tier: ReconstructedTrace["tier"];
  /** How its agents were attached (`reconstructTraces`). */
  linking: Confidence;
  workerIds: string[];
  reviewerIds: string[];
  /** `live`: rebuilt with Paseo's agent list; `store-only`: from the trace store alone. */
  basis: "live" | "store-only";
}

export interface DecisionLink {
  source: LinkSource;
  id: string;
  kind: ReturnType<typeof decisionKindOf>;
  status: Decision["status"];
  askedAt: string;
  /** The question, masked, one line. */
  question: string | null;
  answeredBy: AnswerBy | null;
  answeredAt: string | null;
  precedentId: string | null;
  supersedes: string | null;
  supersededBy: string | null;
}

export interface PrecedentLink {
  source: LinkSource;
  id: string;
  /** The decision of the request it answered. */
  decisionId: string;
  /** False when `precedents.json` no longer holds it (`reason` says so). */
  found: boolean;
  reason: string | null;
  subject: string | null;
  scope: string | null;
  /** The standing answer, masked, one line. */
  text: string | null;
  createdAt: string | null;
  expiresAt: string | null;
  supersededBy: string | null;
}

export interface BeadLink {
  source: LinkSource;
  id: string;
  actions: Array<"created" | "updated" | "closed">;
  /** `exact` when a report names it, `inferred` when only a `br` command does. */
  confidence: Confidence;
  via: Array<"report" | "br">;
  /** True when the bead store holds it, false when not, null when the store was not read. */
  inStore: boolean | null;
  /** Why the record is not shown; null when it is. */
  recordReason: string | null;
  title: string | null;
  status: string | null;
  /** The beads it was split from (`Split-from:` in its description). */
  splitFrom: string[];
}

export type ChangeVia = "report" | "file-evidence" | "commit-bead" | "commit-path-time";

export interface ChangeLink {
  source: LinkSource;
  /** The path relative to the workspace folder (absolute when it lies outside, or the folder is unknown). */
  path: string;
  /** `detected` when a turn's edit or write shows it, `self-reported` when only a report names it, null when only a commit does. */
  label: ClaimLabel | null;
  via: ChangeVia[];
  /** Commits that touched it, by hash. */
  commits: string[];
  /** Its only link is a commit by path and time (A-10 counts it incomplete, change-011 C4). */
  onlyCommitByTime: boolean;
}

export interface CommitLink {
  source: LinkSource;
  hash: string;
  at: string;
  /** The subject line, masked. */
  subject: string | null;
  files: string[];
  /** `bead`: its message names a bead of the request; `path-and-time`: it names none and touches a file of the request in its span. */
  link: "bead" | "path-and-time";
  beads: string[];
}

export interface CommitLinks extends Link<CommitLink> {
  /** Commits of the span linked to nothing of the request. */
  unlinked: number;
  /** True when the span held more commits than `LINKS_GIT_MAX_COMMITS`. */
  truncated: boolean;
}

export interface CheckLink {
  status: LinkStatus;
  reason: string | null;
  source: LinkSource | null;
  verdict: ChecksVerdict | null;
  named: CheckClaim[];
  /** Finished-unverified (§C.3). */
  unverified: boolean;
  reportAt: string | null;
}

export interface ReviewBatch {
  source: LinkSource;
  batchId: string | null;
  reviews: Array<{ agentId: string; at: string; verdict: string | null; blockingCount: number | null }>;
  /** The batch's latest verdict. */
  verdict: string | null;
}

export interface TurnLink {
  source: LinkSource;
  /** `<agentId>@<at>`: never the turn id, which Paseo reuses. */
  key: string;
  at: string;
  startedAt: string | null;
  endedAt: string;
  turnId: string | null;
  outcome: TraceRecord["outcome"];
}

export interface AgentTurns {
  agentId: string;
  role: TraceRecord["role"];
  count: number;
  first: string;
  last: string;
  turns: TurnLink[];
}

/** A supersession, kept: `from` is what was replaced (or split, or handed over), `to` what replaced it. */
export interface ChainEdge {
  kind: "superseded-by" | "split-into" | "handoff" | "replaced-by";
  from: string;
  to: string;
  source: LinkSource;
}

export interface RequestChain {
  workspaceId: string;
  request: RequestLink;
  decisions: Link<DecisionLink>;
  precedents: Link<PrecedentLink>;
  beads: Link<BeadLink>;
  changes: Link<ChangeLink>;
  commits: CommitLinks;
  checks: CheckLink;
  reviews: Link<ReviewBatch>;
  turns: Link<AgentTurns>;
  /** Handoffs and replacements between the request's agents. */
  handoffs: Link<ChainEdge>;
  /** Every edge: decisions, precedents, beads, handoffs. */
  edges: ChainEdge[];
  notices: string[];
}

/** A source read, or why it could not be. */
export type SourceRead<T> = { ok: true; value: T } | { ok: false; reason: string };

/** The commits of a request's span: parsed, or why they are missing. */
export type CommitsRead = { ok: true; commits: GitCommit[]; truncated: boolean } | { ok: false; reason: string };

export interface GitCommit {
  hash: string;
  at: string;
  message: string;
  /** Relative to the workspace folder. */
  files: string[];
}

/** What `deriveChain` reads, already read. */
export interface ChainContext {
  workspaceId: string;
  /** The live agents of the workspace; null for a store-only rebuild. */
  agents: ReadonlyMap<string, AgentFacts> | null;
  workspaceDirectory: string | null;
  decisions: SourceRead<readonly Decision[]>;
  precedents: SourceRead<readonly Precedent[]>;
  /** The bead store; `present: false` when the workspace has none. */
  beads: SourceRead<{ present: boolean; beads: ReadonlyMap<string, BeadRecord> }>;
  commits: CommitsRead;
  env: NodeJS.ProcessEnv;
}

const found = <T>(items: T[]): Link<T> => ({ status: "found", reason: null, items });
const absent = <T>(reason: string): Link<T> => ({ status: "absent", reason, items: [] });
const missing = <T>(reason: string, items: T[] = []): Link<T> => ({ status: "missing", reason, items });

const SPLIT_FROM = /Split-from:\s*`?([A-Za-z0-9][A-Za-z0-9_.-]*[A-Za-z0-9])`?/gi;

/** The beads a description says a bead was split from (`Split-from: <id>`), once each. */
export function splitFromOf(description: string | null): string[] {
  if (description === null) return [];
  return [...new Set([...description.matchAll(SPLIT_FROM)].map((match) => match[1]!))];
}

function normalisedDirectory(directory: string | null): string | null {
  return directory === null || directory.trim() === "" ? null : normalisedPath(directory);
}

/** Whether the request had a Worker: none means the Manager answered it itself. */
function hadWorker(trace: ReconstructedTrace): boolean {
  return trace.workerIds.length > 0 || trace.records.some((record) => record.role === "worker");
}

const NO_WORKER = "No Worker took the request: the Manager answered it itself.";

function decisionLinkOf(decision: Decision, env: NodeJS.ProcessEnv): DecisionLink {
  return {
    source: { store: "decisions", id: decision.id },
    id: decision.id,
    kind: decisionKindOf(decision.id),
    status: decision.status,
    askedAt: decision.askedAt,
    question: firstLine(decision.question, env),
    answeredBy: decision.answer?.by ?? null,
    answeredAt: decision.answer?.at ?? null,
    precedentId: decision.answer?.precedentId ?? null,
    supersedes: decision.supersedes,
    supersededBy: decision.supersededBy,
  };
}

function decisionsOf(trace: ReconstructedTrace, context: ChainContext): { link: Link<DecisionLink>; decisions: Decision[] } {
  if (!context.decisions.ok) return { link: missing(`The decision store could not be read: ${context.decisions.reason}`), decisions: [] };
  const own = context.decisions.value.filter((decision) => decision.requestId === trace.requestId);
  if (own.length > 0) return { link: found(own.map((decision) => decisionLinkOf(decision, context.env))), decisions: own };
  const asked = trace.reports.some((report) => report.phase === "blocked");
  return {
    link: asked
      ? missing("A report of the request was blocked on a question, but no decision carries its id.")
      : absent("No decision carries the request's id: no question was asked."),
    decisions: [],
  };
}

function precedentsOf(decisions: readonly Decision[], context: ChainContext): Link<PrecedentLink> {
  const answered = decisions.filter((decision) => decision.answer?.by === "precedent" && decision.answer.precedentId !== undefined);
  if (answered.length === 0) return absent("No decision of the request was answered by a precedent.");
  if (!context.precedents.ok) return missing(`precedents.json could not be read: ${context.precedents.reason}`);
  const byId = new Map(context.precedents.value.map((precedent) => [precedent.id, precedent]));
  const items = answered.map((decision): PrecedentLink => {
    const id = decision.answer!.precedentId!;
    const precedent = byId.get(id);
    return {
      source: { store: "precedents", id },
      id,
      decisionId: decision.id,
      found: precedent !== undefined,
      reason: precedent === undefined ? `precedents.json no longer holds ${id} (evicted or removed).` : null,
      subject: precedent?.subject ?? null,
      scope: precedent?.scope ?? null,
      text: precedent === undefined ? null : firstLine(precedent.text, context.env),
      createdAt: precedent?.createdAt ?? null,
      expiresAt: precedent?.expiresAt ?? null,
      supersededBy: precedent?.supersededBy ?? null,
    };
  });
  return items.every((item) => item.found) ? found(items) : missing("A precedent that answered a decision of the request is no longer stored.", items);
}

function beadsOf(trace: ReconstructedTrace, context: ChainContext): Link<BeadLink> {
  const actions = beadActionsOf(trace);
  const byId = new Map<string, BeadLink>();
  const store = context.beads;
  const storeReason = !store.ok
    ? `The bead store was not read: ${store.reason}`
    : !store.value.present
      ? "The workspace has no .beads/issues.jsonl."
      : null;
  for (const action of ["created", "updated", "closed"] as const) {
    for (const id of actions[action].ids) {
      let link = byId.get(id);
      if (link === undefined) {
        const via = new Set((actions.evidenceById.get(id) ?? []).map((evidence) => (evidence.kind === "report" ? "report" : "br") as "report" | "br"));
        const record = store.ok && store.value.present ? (store.value.beads.get(id) ?? null) : null;
        link = {
          source: { store: "beads", id },
          id,
          actions: [],
          confidence: via.has("report") ? "exact" : "inferred",
          via: [...via].sort(),
          inStore: storeReason !== null ? (store.ok ? false : null) : record !== null,
          recordReason: storeReason ?? (record === null ? `${id} is not in the workspace's bead store.` : null),
          title: record === null ? null : firstLine(record.title, context.env),
          status: record?.status ?? null,
          splitFrom: splitFromOf(record?.description ?? null),
        };
        byId.set(id, link);
      }
      link.actions.push(action);
    }
  }
  if (byId.size > 0) return found([...byId.values()]);
  if (!hadWorker(trace)) return absent(NO_WORKER);
  const unknown = [actions.created, actions.updated, actions.closed].every((bucket) => bucket.confidence === "unknown");
  if (unknown) return missing("No report and no br command of the request names a bead.");
  return absent(trace.tier === "Small" ? "A Small request: its reports name no bead." : "Its reports name no bead (beadsCreated, beadsUpdated and beadsClosed: none).");
}

/** The request's changes from its own records: the reports' `filesChanged` and the turns' `file` evidence. */
function recordedChangesOf(trace: ReconstructedTrace, workspace: string | null): ChangeLink[] {
  const reported = [...new Set(trace.reports.flatMap((report) => report.filesChanged))];
  // Labelled as §C.2 labels a report's files: one report naming every file the request's reports name.
  const labelled = claimsOf({
    report: { buildAndTests: null, filesChanged: reported, beadsClosed: [] },
    records: trace.records,
    workspaceDirectory: workspace,
  }).files;
  const changes: ChangeLink[] = labelled.map((claim) => {
    const path = pathKeyOf(claim.path, workspace);
    return {
      source: { store: "traces", id: path },
      path,
      label: claim.label,
      via: claim.label === "detected" ? ["report", "file-evidence"] : ["report"],
      commits: [],
      onlyCommitByTime: false,
    };
  });
  for (const record of trace.records) {
    for (const evidence of record.evidence) {
      if (evidence.kind !== "file") continue;
      const path = pathKeyOf(evidence.detail, workspace);
      // Outside a known folder (a scratch file) it is not a change of the project.
      if (path === "" || (workspace !== null && path.startsWith("/"))) continue;
      if (changes.some((change) => sameFile(change.path, path, workspace !== null))) continue;
      changes.push({ source: { store: "traces", id: path }, path, label: "detected", via: ["file-evidence"], commits: [], onlyCommitByTime: false });
    }
  }
  return changes;
}

function changesLinkOf(trace: ReconstructedTrace, changes: ChangeLink[]): Link<ChangeLink> {
  if (changes.length > 0) return found(changes);
  if (!hadWorker(trace)) return absent(NO_WORKER);
  const finished = [...trace.reports].reverse().find((report) => report.phase === "finished");
  if (finished !== undefined && !(finished.incompleteFields ?? []).includes("filesChanged")) {
    return absent("The finished report says filesChanged: none, and no turn edited or wrote a file.");
  }
  return missing("No report of the request names a changed file, and no recorded turn edited one.");
}

/** Links the span's commits to the request, adding to `changes` (change-011 C4). */
function commitsOf(context: ChainContext, beadIds: ReadonlySet<string>, changes: ChangeLink[]): CommitLinks {
  if (!context.commits.ok) return { ...missing<CommitLink>(context.commits.reason), unlinked: 0, truncated: false };
  const stored = context.beads.ok && context.beads.value.present ? context.beads.value.beads : null;
  const items: CommitLink[] = [];
  let unlinked = 0;
  for (const commit of context.commits.commits) {
    const named = stored === null ? [] : beadIdCandidates(commit.message).filter((id) => stored.has(id));
    const ofRequest = named.filter((id) => beadIds.has(id));
    const touches = commit.files.some((file) => changes.some((change) => sameFile(change.path, file, true)));
    let link: CommitLink["link"];
    if (ofRequest.length > 0) link = "bead";
    // A commit naming only other requests' beads belongs to them.
    else if (named.length === 0 && touches) link = "path-and-time";
    else {
      unlinked += 1;
      continue;
    }
    const via: ChangeVia = link === "bead" ? "commit-bead" : "commit-path-time";
    for (const file of commit.files) {
      let change = changes.find((candidate) => sameFile(candidate.path, file, true));
      if (change === undefined) {
        change = { source: { store: "git", id: commit.hash }, path: file, label: null, via: [], commits: [], onlyCommitByTime: false };
        changes.push(change);
      }
      if (!change.via.includes(via)) change.via.push(via);
      if (!change.commits.includes(commit.hash)) change.commits.push(commit.hash);
    }
    items.push({
      source: { store: "git", id: commit.hash },
      hash: commit.hash,
      at: commit.at,
      subject: firstLine(commit.message, context.env),
      files: commit.files,
      link,
      beads: ofRequest,
    });
  }
  for (const change of changes) change.onlyCommitByTime = change.via.length > 0 && change.via.every((via) => via === "commit-path-time");
  const truncated = context.commits.truncated;
  const base =
    items.length > 0
      ? found(items)
      : absent<CommitLink>("No commit in the request's span names one of its beads or touches one of its files (a commit is not required).");
  return { ...base, unlinked, truncated };
}

function checksOf(trace: ReconstructedTrace, context: ChainContext): CheckLink {
  const verification = verificationOf(trace, { agents: context.agents ?? new Map(), workspaceDirectory: context.workspaceDirectory });
  if (verification === null) {
    return {
      status: "absent",
      reason: "The request's latest report is not finished: there is no finish to check.",
      source: null,
      verdict: null,
      named: [],
      unverified: false,
      reportAt: null,
    };
  }
  return {
    status: "found",
    reason: null,
    source: { store: "traces", id: `${trace.traceId}@${verification.reportAt}` },
    verdict: verification.checks,
    named: verification.named,
    unverified: verification.unverified,
    reportAt: verification.reportAt,
  };
}

function reviewsOf(trace: ReconstructedTrace): Link<ReviewBatch> {
  const batches = new Map<string, ReviewBatch>();
  for (const review of trace.reviews) {
    const key = review.batchId ?? "";
    let batch = batches.get(key);
    if (batch === undefined) {
      batch = { source: { store: "traces", id: `${trace.traceId}#${review.batchId ?? "unbatched"}` }, batchId: review.batchId, reviews: [], verdict: null };
      batches.set(key, batch);
    }
    batch.reviews.push({ agentId: review.agentId, at: review.at, verdict: review.verdict, blockingCount: review.blockingCount });
    batch.verdict = review.verdict;
  }
  if (batches.size > 0) return found([...batches.values()]);
  if (!hadWorker(trace)) return absent(NO_WORKER);
  if (trace.tier === "Small") return absent("A Small request: no review.");
  if (trace.reviewerIds.length > 0) return missing("Reviewers were called, but no BM-REVIEW of theirs was recorded.");
  return missing(
    trace.tier === null ? "No BM-REVIEW was recorded, and no report gave the request's tier." : `A ${trace.tier} request with no recorded BM-REVIEW.`,
  );
}

function turnsOf(trace: ReconstructedTrace): Link<AgentTurns> {
  const byAgent = new Map<string, AgentTurns>();
  for (const record of trace.records) {
    const key = `${record.agentId}@${record.at}`;
    const turn: TurnLink = {
      source: { store: "traces", id: key },
      key,
      at: record.at,
      startedAt: record.startedAt,
      endedAt: record.endedAt,
      turnId: record.turnId,
      outcome: record.outcome,
    };
    const agent = byAgent.get(record.agentId);
    if (agent === undefined) byAgent.set(record.agentId, { agentId: record.agentId, role: record.role, count: 1, first: record.at, last: record.at, turns: [turn] });
    else {
      agent.count += 1;
      agent.turns.push(turn);
      if (record.at < agent.first) agent.first = record.at;
      if (record.at > agent.last) agent.last = record.at;
    }
  }
  return byAgent.size > 0 ? found([...byAgent.values()]) : missing("No turn of the request was recorded.");
}

function handoffsOf(trace: ReconstructedTrace, agents: ReadonlyMap<string, AgentFacts> | null): Link<ChainEdge> {
  if (agents === null) {
    return missing("Paseo's agent list was not read (a store-only rebuild): a handoff is known only by the bm.handoffFrom and bm.replacedBy labels.");
  }
  const edges: ChainEdge[] = [];
  for (const [successor, from] of handoffSuccessorsOf(trace, agents)) {
    edges.push({ kind: "handoff", from, to: successor, source: { store: "paseo", id: `${successor}:bm.handoffFrom` } });
  }
  for (const id of [...trace.workerIds, ...trace.reviewerIds]) {
    const to = agents.get(id)?.replacedBy ?? null;
    if (to !== null && to !== "") edges.push({ kind: "replaced-by", from: id, to, source: { store: "paseo", id: `${id}:bm.replacedBy` } });
  }
  return edges.length > 0 ? found(edges) : absent("No agent of the request handed it over or was replaced (no bm.handoffFrom or bm.replacedBy label).");
}

/** A request's chain, from inputs already read. Pure. */
export function deriveChain(trace: ReconstructedTrace, context: ChainContext): RequestChain | null {
  if (trace.requestId === null) return null;
  const workspace = normalisedDirectory(context.workspaceDirectory);
  const notices: string[] = [];
  const request: RequestLink = {
    source: { store: "traces", id: trace.traceId },
    requestId: trace.requestId,
    traceId: trace.traceId,
    requestedAt: trace.requestedAt,
    text: firstLine(trace.requestText, context.env),
    state: trace.state,
    tier: trace.tier,
    linking: trace.linking,
    workerIds: trace.workerIds,
    reviewerIds: trace.reviewerIds,
    basis: context.agents === null ? "store-only" : "live",
  };
  if (workspace === null) notices.push("The workspace folder is not known: bead records and commits are not read, and paths are matched as recorded.");
  if (trace.agentsMissing.length > 0) notices.push(`${trace.agentsMissing.length} agent(s) of the request are no longer listed; their recorded turns are shown.`);

  const { link: decisions, decisions: own } = decisionsOf(trace, context);
  const precedents = precedentsOf(own, context);
  const beads = beadsOf(trace, context);
  const changeItems = recordedChangesOf(trace, workspace);
  const commits = commitsOf(context, new Set(beads.items.map((bead) => bead.id)), changeItems);
  if (commits.truncated) notices.push(`The request's span held more than ${LINKS_GIT_MAX_COMMITS} commits; only the newest were read.`);
  const changes = changesLinkOf(trace, changeItems);
  const handoffs = handoffsOf(trace, context.agents);

  const edges: ChainEdge[] = [];
  const seen = new Set<string>();
  const edge = (value: ChainEdge): void => {
    const key = `${value.kind}|${value.from}|${value.to}`;
    if (seen.has(key)) return;
    seen.add(key);
    edges.push(value);
  };
  for (const decision of decisions.items) {
    if (decision.supersedes !== null) edge({ kind: "superseded-by", from: decision.supersedes, to: decision.id, source: { store: "decisions", id: decision.id } });
    if (decision.supersededBy !== null) edge({ kind: "superseded-by", from: decision.id, to: decision.supersededBy, source: { store: "decisions", id: decision.id } });
  }
  for (const precedent of precedents.items) {
    if (precedent.supersededBy !== null) edge({ kind: "superseded-by", from: precedent.id, to: precedent.supersededBy, source: { store: "precedents", id: precedent.id } });
  }
  for (const bead of beads.items) {
    for (const parent of bead.splitFrom) edge({ kind: "split-into", from: parent, to: bead.id, source: { store: "beads", id: bead.id } });
  }
  for (const value of handoffs.items) edge(value);

  return {
    workspaceId: context.workspaceId,
    request,
    decisions,
    precedents,
    beads,
    changes,
    commits,
    checks: checksOf(trace, context),
    reviews: reviewsOf(trace),
    turns: turnsOf(trace),
    handoffs,
    edges,
    notices,
  };
}

/** The window `git log` reads for a request: its start to its last activity plus `LINKS_GIT_SLACK_MS`. */
export function commitSpanOf(trace: ReconstructedTrace): { since: string; until: string } {
  const until = new Date(timeOrZero(lastActivityOf(trace)) + LINKS_GIT_SLACK_MS).toISOString();
  return { since: trace.requestedAt, until };
}

/** The requests of `traces` whose beads (created, updated or closed) include `beadId`. Pure. */
export function tracesHoldingBead(traces: readonly ReconstructedTrace[], beadId: string): ReconstructedTrace[] {
  return traces.filter((trace) => {
    if (trace.requestId === null) return false;
    const actions = beadActionsOf(trace);
    return [actions.created, actions.updated, actions.closed].some((bucket) => bucket.ids.includes(beadId));
  });
}

/** The requests of `traces` whose reports or recorded edits name `path`. Pure. */
export function tracesHoldingFile(traces: readonly ReconstructedTrace[], path: string, workspaceDirectory: string | null): ReconstructedTrace[] {
  const workspace = normalisedDirectory(workspaceDirectory);
  const wanted = pathKeyOf(path, workspace);
  if (wanted === "") return [];
  return traces.filter(
    (trace) => trace.requestId !== null && recordedChangesOf(trace, workspace).some((change) => sameFile(change.path, wanted, workspace !== null)),
  );
}

/** `git log --format` output of `readCommits`, parsed. */
export function parseGitLog(stdout: string): GitCommit[] {
  const out: GitCommit[] = [];
  for (const chunk of stdout.split("\x1e")) {
    if (chunk.trim() === "") continue;
    const [hash = "", at = "", message = "", rest = ""] = chunk.split("\x1f");
    if (!/^[0-9a-f]{7,64}$/.test(hash.trim())) continue;
    const files = rest
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "");
    out.push({ hash: hash.trim(), at: at.trim(), message: message.trim(), files });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Reading the sources, cached by mtime and size.
// ---------------------------------------------------------------------------

export interface LinksDeps {
  location: TraceStoreLocation;
  /** Paseo's lists (live reads); null for a store-only rebuild. */
  paseo: DashboardPaseo | null;
  /** How `git log` runs; `runGit` by default. */
  git?: GitRunner;
  /** What masking reads secrets from; `process.env` by default. */
  env?: NodeJS.ProcessEnv;
  /** Replacement Reviewers (`reviewerReplacementsFor`); they change only a review-call count, never a link, so none by default. */
  replacementIds?: ReadonlySet<string>;
}

/** `path:mtime:size`, or `path:-` when it cannot be stat'ed. */
function stampOf(path: string): string {
  try {
    const stat = statSync(path);
    return `${path}:${stat.mtimeMs}:${stat.size}`;
  } catch {
    return `${path}:-`;
  }
}

interface Cached<T> {
  key: string;
  value: T;
}

const traceCache = new Map<string, Cached<{ traces: WorkspaceTraces; storedDirectory: string | null }>>();
const decisionCache = new Map<string, Cached<SourceRead<readonly Decision[]>>>();
const precedentCache = new Map<string, Cached<SourceRead<readonly Precedent[]>>>();
const gitDirCache = new Map<string, Cached<string | null>>();
const commitCache = new Map<string, Cached<CommitsRead>>();

/** Test-only: forgets every cached read of this module. */
export function clearLinksCache(): void {
  for (const cache of [traceCache, decisionCache, precedentCache, gitDirCache, commitCache]) cache.clear();
}

/** Never called: every rebuild hands `workspaceTracesOf` the agents it already has. */
const NO_PASEO: DashboardPaseo = {
  agents: { list: () => Promise.reject(new Error("no agent list in a store-only rebuild")) },
  workspaces: { list: () => Promise.reject(new Error("no workspace list in a store-only rebuild")) },
};

function agentsKeyOf(agents: readonly AgentFacts[] | null): string {
  return agents === null ? "store-only" : JSON.stringify([...agents].sort((a, b) => (a.id < b.id ? -1 : 1)));
}

async function tracesOf(
  deps: LinksDeps,
  workspaceId: string,
  agents: readonly AgentFacts[] | null,
): Promise<{ traces: WorkspaceTraces; storedDirectory: string | null }> {
  const tracesDir = resolve(deps.location.tracesDir);
  const metaPath = join(tracesDir, workspaceId, "meta.json");
  const key = [...monthlyFiles(deps.location, workspaceId), metaPath, join(tracesDir, "meta.json")].map(stampOf).join("|") + `|${agentsKeyOf(agents)}`;
  const cached = traceCache.get(workspaceId);
  if (cached?.key === key) return cached.value;
  const traces = await workspaceTracesOf(
    {
      location: deps.location,
      paseo: deps.paseo ?? NO_PASEO,
      allAgents: (agents ?? []).map((facts) => ({ workspaceId, facts })),
      replacementIds: deps.replacementIds ?? new Set(),
    },
    workspaceId,
  );
  const value = { traces, storedDirectory: readWorkspaceMeta(deps.location, workspaceId)?.lastKnownDirectory ?? null };
  traceCache.set(workspaceId, { key, value });
  return value;
}

function decisionsFor(home: string, workspaceId: string): SourceRead<readonly Decision[]> {
  const path = join(decisionsDirOf(home), `${workspaceId}.json`);
  const key = stampOf(path);
  const cached = decisionCache.get(path);
  if (cached?.key === key) return cached.value;
  let value: SourceRead<readonly Decision[]>;
  try {
    value = { ok: true, value: createDecisionStore(home, { log: () => undefined }).read(workspaceId).entries };
  } catch (error) {
    value = { ok: false, reason: errorText(error) };
  }
  decisionCache.set(path, { key, value });
  return value;
}

function precedentsFor(home: string): SourceRead<readonly Precedent[]> {
  const path = join(home, AUTONOMY_DIR_NAME, PRECEDENTS_FILE);
  const key = stampOf(path);
  const cached = precedentCache.get(path);
  if (cached?.key === key) return cached.value;
  let value: SourceRead<readonly Precedent[]>;
  try {
    value = { ok: true, value: createPrecedentStore(home).read() };
  } catch (error) {
    value = { ok: false, reason: errorText(error) };
  }
  precedentCache.set(path, { key, value });
  return value;
}

function beadsFor(directory: string | null): ChainContext["beads"] {
  if (directory === null) return { ok: false, reason: "the workspace folder is not known." };
  try {
    const { present, beads } = readBeads(directory);
    return { ok: true, value: { present, beads } };
  } catch (error) {
    return { ok: false, reason: errorText(error) };
  }
}

/** The git directory of the repository `directory` is in, found by `stat` (a worktree's `.git` file is read once per change); null outside one. */
function gitDirOf(directory: string): string | null {
  let current = resolve(directory);
  for (;;) {
    const dotGit = join(current, ".git");
    let isDirectory: boolean | null = null;
    try {
      isDirectory = statSync(dotGit).isDirectory();
    } catch {
      isDirectory = null;
    }
    if (isDirectory === true) return dotGit;
    if (isDirectory === false) {
      const key = stampOf(dotGit);
      const cached = gitDirCache.get(dotGit);
      if (cached?.key === key) return cached.value;
      let value: string | null = null;
      try {
        const named = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, "utf8"))?.[1]?.trim();
        if (named !== undefined && named !== "") value = isAbsolute(named) ? named : resolve(current, named);
      } catch {
        value = null;
      }
      gitDirCache.set(dotGit, { key, value });
      return value;
    }
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/** Why `git log` failed, in one masked line. */
function gitReason(error: unknown, env: NodeJS.ProcessEnv): string {
  const failure = error as NodeJS.ErrnoException & { killed?: boolean; signal?: string | null; stderr?: string };
  if (failure.code === "ENOENT") return "git is not installed on this machine.";
  if (failure.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") return `git log printed more than ${LINKS_GIT_MAX_BYTES / 1024} KB.`;
  if (failure.killed === true || typeof failure.signal === "string") return `git log took longer than ${REPO_TIMEOUT_MS / 1000} seconds.`;
  const said = firstLine(typeof failure.stderr === "string" ? failure.stderr : "", env) ?? firstLine(errorText(error), env) ?? "no reason given";
  return `git log failed: ${said}`;
}

/**
 * The commits reachable from `HEAD` in a request's span, read-only: one
 * bounded `git log` through `repo-tool.ts`'s runner and prefix, cached by the
 * repository's `HEAD`, `logs/HEAD` and `packed-refs`. Never rejects.
 */
async function readCommits(
  directory: string | null,
  span: { since: string; until: string },
  git: GitRunner,
  env: NodeJS.ProcessEnv,
): Promise<CommitsRead> {
  if (directory === null) return { ok: false, reason: "The workspace folder is not known, so its commits were not read." };
  try {
    if (!statSync(directory).isDirectory()) return { ok: false, reason: `The workspace folder ${directory} is not a folder.` };
  } catch {
    return { ok: false, reason: `The workspace folder ${directory} does not exist.` };
  }
  const gitDir = gitDirOf(directory);
  if (gitDir === null) return { ok: false, reason: "The workspace folder is not in a git repository." };
  const key = [join(gitDir, "HEAD"), join(gitDir, "logs", "HEAD"), join(gitDir, "packed-refs")].map(stampOf).join("|");
  const cacheKey = `${directory}\n${span.since}\n${span.until}`;
  const cached = commitCache.get(cacheKey);
  if (cached?.key === key) return cached.value;
  let value: CommitsRead;
  try {
    const { stdout } = await git(
      [
        ...GIT_READ_ONLY_PREFIX,
        "log",
        "--no-merges",
        "--no-renames",
        "--no-decorate",
        "--no-show-signature",
        "--relative",
        "--name-only",
        `--max-count=${LINKS_GIT_MAX_COMMITS + 1}`,
        `--since=${span.since}`,
        `--until=${span.until}`,
        "--format=%x1e%H%x1f%cI%x1f%B%x1f",
      ],
      { cwd: directory, maxBytes: LINKS_GIT_MAX_BYTES },
    );
    const commits = parseGitLog(stdout);
    value = { ok: true, commits: commits.slice(0, LINKS_GIT_MAX_COMMITS), truncated: commits.length > LINKS_GIT_MAX_COMMITS };
  } catch (error) {
    value = { ok: false, reason: gitReason(error, env) };
  }
  commitCache.set(cacheKey, { key, value });
  return value;
}

/** What one workspace's lookups share: its traces, directory and stores, read once per call. */
interface WorkspaceRead {
  traces: ReconstructedTrace[];
  agents: ReadonlyMap<string, AgentFacts> | null;
  directory: string | null;
  context: Omit<ChainContext, "commits">;
}

async function readWorkspace(deps: LinksDeps, workspaceId: string): Promise<WorkspaceRead> {
  const env = deps.env ?? process.env;
  // Paseo's lists are live reads, never cached.
  const [listed, all] = deps.paseo === null ? [null, null] : await Promise.all([listedWorkspaces(deps.paseo), bmAgentsOf(deps.paseo)]);
  const agents = all === null ? null : all.filter((entry) => entry.workspaceId === workspaceId).map((entry) => entry.facts);
  const { traces, storedDirectory } = await tracesOf(deps, workspaceId, agents);
  // As `bm_repo` resolves it: Paseo's list, else the folder the store last saw.
  const directory = directoryIn(listed, workspaceId) ?? storedDirectory;
  const home = dataFolderOf(deps.location.tracesDir);
  const agentMap = agents === null ? null : traces.agents;
  return {
    traces: traces.traces.filter((trace) => trace.requestId !== null),
    agents: agentMap,
    directory,
    context: {
      workspaceId,
      agents: agentMap,
      workspaceDirectory: directory,
      decisions: decisionsFor(home, workspaceId),
      precedents: precedentsFor(home),
      beads: beadsFor(directory),
      env,
    },
  };
}

async function chainIn(deps: LinksDeps, read: WorkspaceRead, trace: ReconstructedTrace): Promise<RequestChain | null> {
  const commits = await readCommits(read.directory, commitSpanOf(trace), deps.git ?? runGit, read.context.env);
  return deriveChain(trace, { ...read.context, commits });
}

async function chainsOf(deps: LinksDeps, read: WorkspaceRead, traces: readonly ReconstructedTrace[]): Promise<RequestChain[]> {
  const chains: RequestChain[] = [];
  for (const trace of traces) {
    const chain = await chainIn(deps, read, trace);
    if (chain !== null) chains.push(chain);
  }
  return chains;
}

/** The chain of one request, or null when the trace store holds no such request. */
export async function requestChainOf(deps: LinksDeps, workspaceId: string, requestId: string): Promise<RequestChain | null> {
  const read = await readWorkspace(deps, workspaceId);
  const trace = traceOfRequest(read.traces, { requestId });
  return trace === undefined ? null : chainIn(deps, read, trace);
}

export interface LookupResult {
  chains: RequestChain[];
  /** Why no chain holds it; null when one does. */
  reason: string | null;
}

/** The requests whose beads include `beadId`, with whether the bead store holds it (null when the store was not read). */
export async function chainsOfBead(deps: LinksDeps, workspaceId: string, beadId: string): Promise<LookupResult & { beadInStore: boolean | null }> {
  const read = await readWorkspace(deps, workspaceId);
  const beads = read.context.beads;
  const beadInStore = beads.ok ? beads.value.present && beads.value.beads.has(beadId) : null;
  const chains = await chainsOf(deps, read, tracesHoldingBead(read.traces, beadId));
  return { chains, beadInStore, reason: chains.length > 0 ? null : `No request's reports or br commands name ${beadId}.` };
}

/** The requests whose reports or recorded edits name `path` (relative to the workspace folder, or absolute). A file linked only by a commit is not looked up. */
export async function chainsOfFile(deps: LinksDeps, workspaceId: string, path: string): Promise<LookupResult> {
  const read = await readWorkspace(deps, workspaceId);
  const chains = await chainsOf(deps, read, tracesHoldingFile(read.traces, path, read.directory));
  return { chains, reason: chains.length > 0 ? null : `No request's reports or recorded edits name ${path}.` };
}

/**
 * The chain of the request a decision carries, with the decision itself.
 * `decision: null` when the store has no such id (or could not be read:
 * `reason` says which); a project-wide decision (null `requestId`) is in no
 * chain and comes back alone, saying so.
 */
export async function chainsOfDecision(deps: LinksDeps, workspaceId: string, decisionId: string): Promise<LookupResult & { decision: DecisionLink | null }> {
  const read = await readWorkspace(deps, workspaceId);
  const decisions = read.context.decisions;
  if (!decisions.ok) return { decision: null, chains: [], reason: `The decision store could not be read: ${decisions.reason}` };
  const decision = decisions.value.find((entry) => entry.id === decisionId);
  if (decision === undefined) return { decision: null, chains: [], reason: `No decision ${decisionId} is stored for this project.` };
  const link = decisionLinkOf(decision, read.context.env);
  if (decision.requestId === null) return { decision: link, chains: [], reason: "A project-wide decision (no request): it is in no request's chain." };
  const trace = traceOfRequest(read.traces, { requestId: decision.requestId });
  if (trace === undefined) {
    return { decision: link, chains: [], reason: `Its request ${decision.requestId} is not in the trace store (deleted, or never recorded).` };
  }
  const chain = await chainIn(deps, read, trace);
  return { decision: link, chains: chain === null ? [] : [chain], reason: null };
}
