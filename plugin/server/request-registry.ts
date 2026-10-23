/**
 * The request registry (design §16.4, ADR-027 decisions 2 and 7).
 *
 * One file per workspace, `<data folder>/requests/<workspaceId>.json`, in a
 * `0700` folder, `0600`, a `createJsonFileStore` file: atomic temp → fsync →
 * rename, no symlink, a newer `schemaVersion` read as empty and never written,
 * and a file that cannot be used is never overwritten. Every write is one
 * synchronous read-modify-write: the plugin server is one thread, so that is
 * the file's mutex.
 *
 * - **Generating a `requestId`**: `req-` + the current UTC second as
 *   `YYYYMMDDTHHMMSSZ`; a taken id moves one second on until it is free, so
 *   the format stays the one `checkBlocks` and every reader accept. An id is
 *   taken when **any** workspace's registry or the request index of the
 *   mission rosters holds it (missions design §2.3), so a Main creating
 *   Workers in two repos in one second gets two ids.
 * - **Backfill, once**: when a workspace's file is created, it is filled from
 *   that workspace's trace records (`source: "backfill"`, `createdAt` = the
 *   earliest record). Never again.
 * - **The hand path keeps working**: an id an unbound Manager typed is
 *   registered `agent-typed` when the plugin first sees it — the collector's
 *   record, or `agent.created` of its Worker (`creation-settle.ts`), both
 *   through `sightRequestId`.
 * - **The bound path is checked** (ADR-027 decision 7): for an agent whose
 *   creator is bound — its parent has a live binding, or the plugin created it
 *   itself (`agent-bindings.ts`, `liveBindingOf`) — a `bm.requestId` that is not registered
 *   counts as missing and is logged once per agent per run.
 *   `knownRequestIdOf` is the one way the plugin reads that label.
 * - **Bounds**: at most 2,000 requests per workspace; the oldest finished go
 *   first, then the oldest; a request with a `pending` outbox record
 *   (`outbox.ts`, §16.7) is never dropped.
 *
 * Readers never throw; a store that cannot be read reads as empty.
 */
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { parentOf } from "./agent-role";
import { createBindingStore, liveBindingOf, type AgentBinding } from "./agent-bindings";
import { assertNoSymlink, clearJsonFileCache, createJsonFileStore, entriesOf, type JsonFileStore } from "./data-files";
import { clearRequestIndexCache, missionManagerOf, requestIndex, requestIndexOf } from "./mission-roster";
import { createOutbox, isOpenRecord } from "./outbox";
import { dataHome } from "./rpc-kit";
import { WORKSPACE_ID_PATTERN, readRecords } from "./trace-store";
import { parseReviews } from "../shared/bm-report";
import { REVIEW_MILESTONES, type ReviewMilestone } from "../shared/bm-tools";
import { timeOrZero } from "../shared/time";
import { settleItemsOf, waitingSchema, type WaitItem, type Waiting } from "../shared/waits";

/** The registry's folder in the data folder (§16.4); the cleanup button deletes it (§7.13.7). */
export const REQUESTS_DIR_NAME = "requests";
export const REQUEST_REGISTRY_VERSION = 1;
/** The most requests one workspace's file keeps (§16.4). */
export const MAX_REQUESTS_PER_WORKSPACE = 2_000;
/** The one shape of a request id (`checkBlocks`). */
export const REQUEST_ID_PATTERN = /^req-\d{8}T\d{6}Z$/;
/** The label the hand path carries the request on. */
export const REQUEST_ID_LABEL = "bm.requestId";

export type RequestSource = "tool" | "backfill" | "agent-typed";

const reviewCallSchema = z.object({
  callId: z.string(),
  kind: z.enum(["create", "rereview"]),
  reviewerId: z.string(),
  at: z.string(),
  /** Delivery line design §17.2: the working tree at the call, as a git tree object id; none without git or from an older build. */
  tree: z.string().optional(),
});

/**
 * One result of a batch (delivery line design §5.2): a review record's verdict
 * and blocking count, or a no-verdict (`verdict: "no-verdict"`, `blocking:
 * null`). The convergence rule reads them; never the outbox, which keeps
 * records for 7 days.
 */
const reviewResultSchema = z.object({
  at: z.string(),
  recordId: z.string(),
  verdict: z.string(),
  blocking: z.number().int().nonnegative().nullable(),
});

const reviewBatchSchema = z.object({
  batchId: z.string(),
  reviewerIds: z.array(z.string()),
  brief: z.string(),
  calls: z.array(reviewCallSchema),
  /** Delivery line design §5.1: the batch's milestone; none on a batch an older build opened. */
  milestone: z.enum(REVIEW_MILESTONES).optional(),
  /** Delivery line design §5.2: its results, oldest first; none on a batch an older build opened (read from the trace instead). */
  results: z.array(reviewResultSchema).optional(),
});

const requestSchema = z.object({
  requestId: z.string().regex(REQUEST_ID_PATTERN),
  workspaceId: z.string().min(1),
  createdAt: z.string(),
  source: z.enum(["tool", "backfill", "agent-typed"]),
  managerId: z.string().nullable(),
  /** Missions design §2.3: the request's mission, a cache of the roster (an older build drops it; readers fall back to the request index). */
  missionId: z.string().min(1).optional(),
  workerIds: z.array(z.string()),
  tier: z.enum(["Small", "Medium", "Large"]).nullable(),
  finishedAt: z.string().nullable(),
  reviews: z.object({
    batches: z.array(reviewBatchSchema),
    grants: z.array(z.object({ decisionId: z.string(), calls: z.number().int().nullable(), untilCleanBatch: z.string().nullable() })),
  }),
  /** Delivery line design §2.2: the request this one continues; absent on the first of a chain. */
  continuationOf: z.string().regex(REQUEST_ID_PATTERN).optional(),
  /** Delivery line design §2.2: the first request of the chain; absent = the request itself. */
  chainRootId: z.string().regex(REQUEST_ID_PATTERN).optional(),
  /** Delivery line design §2.2: the request that continues this one, set on the predecessor. */
  continuedBy: z.string().regex(REQUEST_ID_PATTERN).optional(),
  /** Delivery line design §2.2: why this request was continued, by what figure, and when. */
  rollover: z.object({ reason: z.enum(["follow-up", "size"]), figure: z.string(), at: z.string() }).optional(),
  /** Delivery line design §2.6: the newest rollover notice its Worker got (`soft` or `now`), at what figure, and when. */
  rolloverAsked: z.object({ level: z.enum(["soft", "now"]), figure: z.string(), at: z.string() }).optional(),
  /** Delivery line design §6.2: what a `blocked` report waits on, by id; absent (or null) = no structured wait. */
  waiting: waitingSchema.nullable().optional(),
  /**
   * Delivery line design §4.8: the workspaces it was moved out of (`move`), oldest first; its outbox
   * records and traces stay readable under those. Absent: it never moved.
   */
  movedFrom: z.array(z.object({ workspaceId: z.string().min(1), at: z.string() })).optional(),
});

export type RegisteredRequest = z.infer<typeof requestSchema>;

/**
 * True for a bound request (delivery line design §2.3): one the plugin's tools
 * created (`bm_create_worker` → `generate`, `source: "tool"`). Its `finished`
 * and `stopped` are terminal; a hand-written (`agent-typed`) or backfilled one
 * keeps today's reopening. Pure.
 */
export function isBoundRequest<T extends Pick<RegisteredRequest, "source">>(request: T | null | undefined): request is T {
  return request?.source === "tool";
}

/**
 * A request's place in its chain (delivery line design §2.7): 2 for the first
 * continuation, walking `previousOf` back from the request it continues
 * (`continuationOf`) until a request continues none or is not known; null
 * when it continues none. Bounded against a loop. Pure.
 */
export function chainPositionOf(continuationOf: string | null | undefined, previousOf: (requestId: string) => string | null | undefined): number | null {
  if (continuationOf === null || continuationOf === undefined) return null;
  const seen = new Set<string>();
  let position = 1;
  let previous: string | null | undefined = continuationOf;
  while (previous !== null && previous !== undefined && !seen.has(previous) && position < 1_000) {
    seen.add(previous);
    position += 1;
    previous = previousOf(previous);
  }
  return position;
}

/**
 * The refusal of a later `bm_report` on a finished bound request (delivery
 * line design §2.3): it names the request that goes on with its work, or the
 * Main. Pure.
 */
export function finishedRequestRefusal(request: Pick<RegisteredRequest, "requestId" | "continuedBy">): string {
  const next = request.continuedBy === undefined ? "ask your Main" : `its work goes on as ${request.continuedBy}`;
  return `Request ${request.requestId} is finished; ${next}. Nothing was stored or sent.`;
}

interface RegistryFile {
  requests: RegisteredRequest[];
}

/** `req-` + the UTC second of `at` as `YYYYMMDDTHHMMSSZ`. */
export function requestIdAt(at: Date): string {
  return `req-${at.toISOString().slice(0, 19).replace(/[-:]/g, "")}Z`;
}

function isUsableWorkspaceId(workspaceId: unknown): workspaceId is string {
  return typeof workspaceId === "string" && WORKSPACE_ID_PATTERN.test(workspaceId) && workspaceId !== "." && workspaceId !== "..";
}

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function newEntry(workspaceId: string, requestId: string, createdAt: string, source: RequestSource, managerId: string | null, workerIds: string[]): RegisteredRequest {
  return { requestId, workspaceId, createdAt, source, managerId, workerIds, tier: null, finishedAt: null, reviews: { batches: [], grants: [] } };
}

/**
 * At most `MAX_REQUESTS_PER_WORKSPACE` of `requests`, in their order: the
 * oldest finished ones go first, then the oldest unfinished; one `keep` holds
 * is never dropped (§16.4).
 */
export function capRequests(workspaceId: string, requests: readonly RegisteredRequest[], keep: (workspaceId: string, requestId: string) => boolean): RegisteredRequest[] {
  const excess = requests.length - MAX_REQUESTS_PER_WORKSPACE;
  if (excess <= 0) return requests.slice();
  const rank = (request: RegisteredRequest): number => (request.finishedAt !== null ? 0 : 1e15) + timeOrZero(request.createdAt);
  const drop = new Set(
    requests
      .map((request, index) => ({ request, index }))
      .filter(({ request }) => !keep(workspaceId, request.requestId))
      .sort((a, b) => rank(a.request) - rank(b.request) || a.index - b.index)
      .slice(0, excess)
      .map(({ index }) => index),
  );
  return requests.filter((_, index) => !drop.has(index));
}

/**
 * The requests a workspace's trace records name, for the one backfill: each
 * id with the time of its earliest record, its first Manager and its Workers
 * in the order they first recorded a turn. Never throws: a store that cannot
 * be read gives none.
 */
export function requestsFromTraces(home: string, workspaceId: string, log: (message: string) => void = () => {}): RegisteredRequest[] {
  try {
    const { records } = readRecords({ tracesDir: join(home, "traces") }, workspaceId);
    const found = new Map<string, { at: number; createdAt: string; managers: Array<[number, string]>; workers: Array<[number, string]> }>();
    for (const record of records) {
      const requestId = record.requestId;
      if (requestId === null || !REQUEST_ID_PATTERN.test(requestId)) continue;
      const createdAt = record.startedAt ?? record.at;
      const at = timeOrZero(createdAt);
      const entry = found.get(requestId) ?? { at, createdAt, managers: [], workers: [] };
      if (at < entry.at) {
        entry.at = at;
        entry.createdAt = createdAt;
      }
      if (record.role === "manager") entry.managers.push([at, record.agentId]);
      if (record.role === "worker") entry.workers.push([at, record.agentId]);
      found.set(requestId, entry);
    }
    const ordered = (agents: Array<[number, string]>): string[] => [...new Set(agents.sort((a, b) => a[0] - b[0]).map(([, id]) => id))];
    return [...found.entries()]
      .sort((a, b) => a[1].at - b[1].at || a[0].localeCompare(b[0]))
      .map(([requestId, entry]) => newEntry(workspaceId, requestId, entry.createdAt, "backfill", ordered(entry.managers)[0] ?? null, ordered(entry.workers)));
  } catch (error) {
    log(`[paseo-bm] could not read the trace records of workspace ${workspaceId} for the request registry: ${error instanceof Error ? error.message : String(error)}`);
    return [];
  }
}

export interface RequestRegistryDeps {
  now?: () => Date;
  log?: (message: string) => void;
  /** The requests a new workspace file starts with; that workspace's trace records by default (`requestsFromTraces`). */
  backfill?: (workspaceId: string) => RegisteredRequest[];
  /**
   * True for a request the bound must not drop: one with a `pending` or
   * `queued` outbox record (design §16.7) — the data folder's outbox by default.
   */
  keepRequest?: (workspaceId: string, requestId: string) => boolean;
}

export interface RequestRegistry {
  /** The workspace's requests, oldest first. Never throws: none for a file that cannot be read. */
  list(workspaceId: string): RegisteredRequest[];
  /** One request, or null. Never throws. */
  get(workspaceId: string, requestId: string): RegisteredRequest | null;
  /** True when the workspace's registry holds `requestId`. Never throws. */
  has(workspaceId: string, requestId: string): boolean;
  /**
   * A new request with a fresh id (`source: "tool"`), with its mission when it
   * has one (§2.3), and for a continuation the request it continues and its
   * chain's root (delivery line design §2.2). Throws when the file cannot be
   * written.
   */
  generate(workspaceId: string, init: { managerId: string | null; missionId?: string | null; continuationOf?: string; chainRootId?: string }): RegisteredRequest;
  /**
   * Registers `requestId` when the workspace does not hold it yet, and adds
   * `workerId` to its Workers (newest last) and `managerId` when it has none.
   * Returns the entry, or null for an id of another shape. Throws when the
   * file cannot be written.
   */
  register(workspaceId: string, requestId: string, init: { source: RequestSource; managerId?: string | null; workerId?: string | null }): RegisteredRequest | null;
  /** Appends `workerId` to a registered request's Workers; false when the request is not registered. Throws when the file cannot be written. */
  addWorker(workspaceId: string, requestId: string, workerId: string): boolean;
  /**
   * Missions design §3.4 step 2: the request's Manager becomes `managerId` (a
   * mission's new Main). False when the request is not registered. Throws when
   * the file cannot be written. A split (§9.6) passes the request's new
   * `missionId` too, so the entry's cache names it.
   */
  reassignManager(workspaceId: string, requestId: string, managerId: string | null, missionId?: string): boolean;
  /**
   * A report of the request was stored (design §16.6, `bm_report`): `tier`
   * becomes the report's, and `finishedAt` is `at` for a `finished` report and
   * null for any other phase (a request its Worker goes on with is not
   * finished; a stopped one is not either). A bound request's `finishedAt`,
   * once set, is never cleared (delivery line design §2.3). False when the
   * request is not registered. Throws when the file cannot be written.
   */
  noteReport(workspaceId: string, requestId: string, report: { tier: "Small" | "Medium" | "Large"; phase: string; at: string }): boolean;
  /**
   * Delivery line design §2.2, §2.4: the request `continuedBy` continues this
   * one, why and by what figure. False when the request is not registered.
   * Throws when the file cannot be written.
   */
  noteContinuedBy(workspaceId: string, requestId: string, continuedBy: string, rollover: NonNullable<RegisteredRequest["rollover"]>): boolean;
  /**
   * Delivery line design §2.6: a rollover notice went to the request's Worker;
   * null forgets it (a soft notice the wake gate held at its send, asked again
   * later). False when the request is not registered. Throws when the file
   * cannot be written.
   */
  noteRolloverAsked(workspaceId: string, requestId: string, asked: NonNullable<RegisteredRequest["rolloverAsked"]> | null): boolean;
  /**
   * Records one review call (design §16.8), in one write: `bm_create_reviewer`
   * opens the batch with its brief (`kind: create`, refused with
   * `"batch-taken"` when the batch already has a Reviewer or a creation call);
   * `bm_rereview` adds to an existing batch (`"no-batch"` otherwise). The call
   * is written BEFORE the tool creates or sends. Throws when the file cannot
   * be written.
   */
  addReviewCall(
    workspaceId: string,
    requestId: string,
    batchId: string,
    call: ReviewCall,
    brief?: string,
    milestone?: ReviewMilestone,
  ): "added" | "no-request" | "no-batch" | "batch-taken";
  /**
   * Appends one result to its batch (delivery line design §5.2), once per
   * record. A batch an older build opened has no `results` and gets none
   * (`"older-batch"`): its results are read from the trace. Throws when the
   * file cannot be written.
   */
  addReviewResult(workspaceId: string, requestId: string, batchId: string, result: ReviewResult): "added" | "known" | "no-request" | "no-batch" | "older-batch";
  /**
   * A failed creation or send removes its call (design §16.8); a batch left
   * with neither a call nor a Reviewer goes with it. Throws when the file
   * cannot be written.
   */
  removeReviewCall(workspaceId: string, requestId: string, callId: string): boolean;
  /**
   * The Reviewer a creation call made: set on the call and appended to its
   * batch's Reviewers (newest last). Throws when the file cannot be written.
   */
  noteReviewer(workspaceId: string, requestId: string, batchId: string, reviewerId: string, callId?: string | null): boolean;
  /**
   * Appends an answered `review-budget` decision's grant (design §16.8), once
   * per decision. Throws when the file cannot be written.
   */
  addGrant(workspaceId: string, requestId: string, grant: ReviewBudgetGrant): "added" | "known" | "no-request";
  /**
   * Delivery line design §6.2: the request's structured wait — set by a
   * `blocked` report, cleared (null) by any other report or by the wake; a
   * cleared wait leaves no key. False when the request is not registered.
   * Throws when the file cannot be written.
   */
  setWaiting(workspaceId: string, requestId: string, waiting: Waiting | null): boolean;
  /**
   * Delivery line design §6.3: the unsettled items of the request's wait that
   * `match` takes become settled at `settle.at`, with their fact. The wait as
   * it is now, or null when none changed (no wait, no such item). Throws when
   * the file cannot be written.
   */
  settleWaitItems(workspaceId: string, requestId: string, match: (item: WaitItem) => boolean, settle: { at: string; fact?: string | ((item: WaitItem) => string | undefined) }): Waiting | null;
  /**
   * Delivery line design §4.8: the request leaves `fromWorkspaceId`'s file and
   * joins `toWorkspaceId`'s as it is, its `workspaceId` the new one and the old
   * one appended to `movedFrom` (a handoff of a request from before the
   * cut-over into its mission's placement). Its outbox records and traces stay
   * where they were written. Safe because request ids are unique. `"moved"`;
   * `"no-request"` when the source does not hold it; `"taken"` when the target
   * already does (nothing written). Throws when a file cannot be written (a
   * copy written to the target is taken out again first).
   */
  move(fromWorkspaceId: string, toWorkspaceId: string, requestId: string): "moved" | "no-request" | "taken";
}

/** One review call the registry holds (design §16.4). */
export type ReviewCall = z.infer<typeof reviewCallSchema>;
/** One review batch of a request (design §16.4). */
export type ReviewBatch = RegisteredRequest["reviews"]["batches"][number];
/** One result of a batch (delivery line design §5.2). */
export type ReviewResult = z.infer<typeof reviewResultSchema>;

/**
 * True for a creating call whose Reviewer never got its id: Paseo's late
 * error, or a reload in the creation. A create creates; since ADR-036 a
 * re-review does too (delivery line design §17.2), and an older build's
 * re-review always named its Reviewer.
 */
export function isEmptyCreateCall(call: Pick<ReviewCall, "kind" | "reviewerId">): boolean {
  return (call.kind === "create" || call.kind === "rereview") && call.reviewerId === "";
}
/**
 * The newest call of a batch by its time (of those `keep` accepts; the last
 * in the batch's order on a tie), or undefined when it has none: the call a
 * turn or a replacement answers when nothing names one (design §16.9,
 * §16.10), and the call `finished` waits on (§16.15).
 */
export function newestCallOf(batch: Pick<ReviewBatch, "calls">, keep: (call: ReviewCall) => boolean = () => true): ReviewCall | undefined {
  let newest: ReviewCall | undefined;
  for (const call of batch.calls) {
    if (keep(call) && (newest === undefined || timeOrZero(call.at) >= timeOrZero(newest.at))) newest = call;
  }
  return newest;
}
/** One grant of a `review-budget` decision (design §16.4, §16.8). */
export type ReviewBudgetGrant = RegisteredRequest["reviews"]["grants"][number];

/**
 * The registry's default drop guard (§16.4): a request with a `pending`
 * outbox record. Each guard reads the outbox once, at its first
 * question, so make one per trim.
 * A store that cannot be read keeps nothing.
 */
export function outboxKeeps(home: string): (workspaceId: string, requestId: string) => boolean {
  let read: { workspaceId: string; open: Set<string> } | null = null;
  return (workspaceId, requestId) => {
    if (read === null || read.workspaceId !== workspaceId) {
      const open = new Set(
        createOutbox(home)
          .list(workspaceId)
          .filter(isOpenRecord)
          .map((record) => record.requestId),
      );
      read = { workspaceId, open };
    }
    return read.open.has(requestId);
  };
}

/** The verdict a no-verdict record stands for in a batch's results (delivery line design §5.2). */
export const NO_VERDICT_RESULT = "no-verdict";

/**
 * Appends the result a `review` or `no-verdict` outbox record carries to its
 * batch (delivery line design §5.2): the review's verdict and its
 * `blockingCount`, or `no-verdict` with `blocking: null`. `bm_review` and the
 * unbound final-answer path call it with the review they store, the
 * missing-verdict check with its no-verdict. The request is read in its
 * repo's registry (missions design §6), else in `workspaceId`'s. Never
 * throws: a failure is one log line.
 */
export function noteReviewResult(
  home: string,
  workspaceId: string,
  record: { id: string; kind: string; requestId: string | null; batchId: string | null; from: string; createdAt: string; text: string },
  log: (message: string) => void = (message) => console.warn(message),
): void {
  if (record.requestId === null || record.batchId === null || (record.kind !== "review" && record.kind !== "no-verdict")) return;
  try {
    let result: ReviewResult;
    if (record.kind === "no-verdict") {
      result = { at: record.createdAt, recordId: record.id, verdict: NO_VERDICT_RESULT, blocking: null };
    } else {
      const review = parseReviews(record.text, { agentId: record.from, at: record.createdAt }).find((entry) => entry.verdict !== null);
      if (review === undefined) return;
      result = { at: record.createdAt, recordId: record.id, verdict: review.verdict!, blocking: review.blockingCount };
    }
    const place = requestIndexOf(home, record.requestId)?.workspaceId ?? workspaceId;
    createRequestRegistry(home, { log }).addReviewResult(place, record.requestId, record.batchId, result);
  } catch (error) {
    log(`[paseo-bm] could not record the result ${record.id} of batch ${record.batchId} of ${record.requestId}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Drops the read cache and the once-per-run log memory; tests only. */
export function clearRequestRegistryCache(): void {
  clearJsonFileCache();
  clearRequestIndexCache();
  loggedAgents.clear();
}

/** The registry of the data folder `home`. Creating it touches nothing on disk. */
export function createRequestRegistry(home: string, deps: RequestRegistryDeps = {}): RequestRegistry {
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? ((message: string) => console.warn(message));
  // A fresh read of the outbox per trim: the guard must see the records of now.
  const keepFor = (): ((workspaceId: string, requestId: string) => boolean) => deps.keepRequest ?? outboxKeeps(home);
  const backfill = deps.backfill ?? ((workspaceId: string) => requestsFromTraces(home, workspaceId, log));

  const fileOf = (workspaceId: string): JsonFileStore<RegistryFile> =>
    createJsonFileStore<RegistryFile>({
      home,
      dir: REQUESTS_DIR_NAME,
      file: `${workspaceId}.json`,
      version: REQUEST_REGISTRY_VERSION,
      versionKey: "schemaVersion",
      parse: (body) => ({ requests: entriesOf(requestSchema, body["requests"]) }),
      empty: () => ({ requests: [] }),
      cap: (value) => ({ requests: capRequests(workspaceId, value.requests, keepFor()) }),
      codes: { unwritable: "E_TRACE_STORE_UNWRITABLE" },
      // The ids of requests in flight: a file that cannot be read is fixed or deleted by hand, never replaced.
      keepUnusable: true,
      cached: true,
    });

  /** Every request id of every workspace's registry and of the request index (§2.3). Never throws. */
  const machineWideIds = (): Set<string> => {
    const ids = new Set(requestIndex(home).keys());
    let names: string[];
    try {
      assertNoSymlink(home, join(home, REQUESTS_DIR_NAME), "E_TRACE_STORE_UNWRITABLE");
      names = readdirSync(join(home, REQUESTS_DIR_NAME));
    } catch {
      return ids;
    }
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      for (const request of list(name.slice(0, -".json".length))) ids.add(request.requestId);
    }
    return ids;
  };

  const list = (workspaceId: string): RegisteredRequest[] => {
    if (!isUsableWorkspaceId(workspaceId)) return [];
    try {
      return fileOf(workspaceId).read().requests;
    } catch {
      return [];
    }
  };

  /** One read-modify-write of a workspace's file; a new file starts from the backfill. Throws on a write failure. */
  const update = (workspaceId: string, change: (requests: RegisteredRequest[]) => RegisteredRequest[] | null): void => {
    if (!isUsableWorkspaceId(workspaceId)) throw new Error(`workspace id is not usable as a file name: ${JSON.stringify(workspaceId)}`);
    const file = fileOf(workspaceId);
    // Backfill once: only the write that creates the file reads the trace store.
    const created = file.inspect().state === "missing";
    file.update((current) => {
      const start = created ? backfill(workspaceId).filter((entry) => REQUEST_ID_PATTERN.test(entry.requestId)) : current.requests;
      const next = change(start);
      return next === null ? null : { requests: next };
    });
  };

  return {
    list,
    get: (workspaceId, requestId) => list(workspaceId).find((request) => request.requestId === requestId) ?? null,
    has: (workspaceId, requestId) => list(workspaceId).some((request) => request.requestId === requestId),
    generate(workspaceId, init) {
      let made: RegisteredRequest | null = null;
      const elsewhere = machineWideIds();
      update(workspaceId, (requests) => {
        const taken = new Set([...elsewhere, ...requests.map((request) => request.requestId)]);
        const at = now();
        let second = Math.floor(at.getTime() / 1000) * 1000;
        let requestId = requestIdAt(new Date(second));
        while (taken.has(requestId)) {
          second += 1000;
          requestId = requestIdAt(new Date(second));
        }
        const entry = newEntry(workspaceId, requestId, at.toISOString(), "tool", init.managerId, []);
        made = {
          ...entry,
          ...(typeof init.missionId === "string" && init.missionId !== "" ? { missionId: init.missionId } : {}),
          ...(init.continuationOf === undefined ? {} : { continuationOf: init.continuationOf, chainRootId: init.chainRootId ?? init.continuationOf }),
        };
        return [...requests, made];
      });
      return made!;
    },
    register(workspaceId, requestId, init) {
      if (!REQUEST_ID_PATTERN.test(requestId)) return null;
      let entry: RegisteredRequest | null = null;
      update(workspaceId, (requests) => {
        const index = requests.findIndex((request) => request.requestId === requestId);
        const workerId = nonEmpty(init.workerId);
        const managerId = nonEmpty(init.managerId);
        if (index === -1) {
          entry = newEntry(workspaceId, requestId, now().toISOString(), init.source, managerId, workerId === null ? [] : [workerId]);
          return [...requests, entry];
        }
        const found = requests[index]!;
        const addsWorker = workerId !== null && !found.workerIds.includes(workerId);
        const addsManager = managerId !== null && found.managerId === null;
        entry = found;
        if (!addsWorker && !addsManager) return null;
        entry = { ...found, workerIds: addsWorker ? [...found.workerIds, workerId] : found.workerIds, managerId: addsManager ? managerId : found.managerId };
        return requests.map((request, at) => (at === index ? entry! : request));
      });
      return entry;
    },
    addWorker(workspaceId, requestId, workerId) {
      let found = false;
      update(workspaceId, (requests) => {
        const index = requests.findIndex((request) => request.requestId === requestId);
        if (index === -1) return null;
        found = true;
        const request = requests[index]!;
        if (request.workerIds.includes(workerId)) return null;
        return requests.map((entry, at) => (at === index ? { ...entry, workerIds: [...entry.workerIds, workerId] } : entry));
      });
      return found;
    },
    reassignManager(workspaceId, requestId, managerId, missionId) {
      let found = false;
      update(workspaceId, (requests) => {
        const index = requests.findIndex((request) => request.requestId === requestId);
        if (index === -1) return null;
        found = true;
        const request = requests[index]!;
        if (request.managerId === managerId && (missionId === undefined || request.missionId === missionId)) return null;
        return requests.map((entry, at) => (at === index ? { ...entry, managerId, ...(missionId === undefined ? {} : { missionId }) } : entry));
      });
      return found;
    },
    noteReport(workspaceId, requestId, report) {
      let found = false;
      update(workspaceId, (requests) => {
        const index = requests.findIndex((request) => request.requestId === requestId);
        if (index === -1) return null;
        found = true;
        const request = requests[index]!;
        // Delivery line design §2.3: a finished bound request stays finished; the hand path reopens.
        const finishedAt = isBoundRequest(request) && request.finishedAt !== null ? request.finishedAt : report.phase === "finished" ? report.at : null;
        if (request.tier === report.tier && request.finishedAt === finishedAt) return null;
        return requests.map((entry, at) => (at === index ? { ...entry, tier: report.tier, finishedAt } : entry));
      });
      return found;
    },
    noteContinuedBy(workspaceId, requestId, continuedBy, rollover) {
      let found = false;
      update(workspaceId, (requests) =>
        withRequest(requests, requestId, (request) => {
          found = true;
          return { ...request, continuedBy, rollover };
        }),
      );
      return found;
    },
    noteRolloverAsked(workspaceId, requestId, rolloverAsked) {
      let found = false;
      update(workspaceId, (requests) =>
        withRequest(requests, requestId, (request) => {
          found = true;
          if (rolloverAsked !== null) return { ...request, rolloverAsked };
          const rest = { ...request };
          delete rest.rolloverAsked;
          return rest;
        }),
      );
      return found;
    },
    addReviewCall(workspaceId, requestId, batchId, call, brief, milestone) {
      let outcome: "added" | "no-request" | "no-batch" | "batch-taken" = "no-request";
      update(workspaceId, (requests) =>
        withRequest(requests, requestId, (request) => {
          const batches = request.reviews.batches;
          const index = batches.findIndex((batch) => batch.batchId === batchId);
          const batch = index === -1 ? null : batches[index]!;
          if (call.kind === "create") {
            if (batch !== null && (batch.reviewerIds.length > 0 || batch.calls.some((entry) => entry.kind === "create"))) {
              outcome = "batch-taken";
              return null;
            }
            const opened: ReviewBatch = {
              batchId,
              reviewerIds: batch?.reviewerIds ?? [],
              brief: brief ?? batch?.brief ?? "",
              calls: [...(batch?.calls ?? []), call],
              ...(milestone !== undefined ? { milestone } : batch?.milestone !== undefined ? { milestone: batch.milestone } : {}),
              // A batch this build opens records its results from the start (§5.2).
              results: batch?.results ?? [],
            };
            outcome = "added";
            return { ...request, reviews: { ...request.reviews, batches: batch === null ? [...batches, opened] : batches.map((entry, at) => (at === index ? opened : entry)) } };
          }
          if (batch === null) {
            outcome = "no-batch";
            return null;
          }
          outcome = "added";
          return { ...request, reviews: { ...request.reviews, batches: batches.map((entry, at) => (at === index ? { ...entry, calls: [...entry.calls, call] } : entry)) } };
        }),
      );
      return outcome;
    },
    removeReviewCall(workspaceId, requestId, callId) {
      let removed = false;
      update(workspaceId, (requests) =>
        withRequest(requests, requestId, (request) => {
          const batches = request.reviews.batches
            .map((batch) => {
              const calls = batch.calls.filter((call) => call.callId !== callId);
              if (calls.length !== batch.calls.length) removed = true;
              return { ...batch, calls };
            })
            // A batch whose only call failed was never opened.
            .filter((batch) => batch.calls.length > 0 || batch.reviewerIds.length > 0);
          return removed ? { ...request, reviews: { ...request.reviews, batches } } : null;
        }),
      );
      return removed;
    },
    addReviewResult(workspaceId, requestId, batchId, result) {
      let outcome: "added" | "known" | "no-request" | "no-batch" | "older-batch" = "no-request";
      update(workspaceId, (requests) =>
        withRequest(requests, requestId, (request) => {
          const index = request.reviews.batches.findIndex((batch) => batch.batchId === batchId);
          if (index === -1) {
            outcome = "no-batch";
            return null;
          }
          const batch = request.reviews.batches[index]!;
          if (batch.results === undefined) {
            outcome = "older-batch";
            return null;
          }
          if (batch.results.some((entry) => entry.recordId === result.recordId)) {
            outcome = "known";
            return null;
          }
          outcome = "added";
          const next = { ...batch, results: [...batch.results, result] };
          return { ...request, reviews: { ...request.reviews, batches: request.reviews.batches.map((entry, at) => (at === index ? next : entry)) } };
        }),
      );
      return outcome;
    },
    noteReviewer(workspaceId, requestId, batchId, reviewerId, callId = null) {
      let noted = false;
      update(workspaceId, (requests) =>
        withRequest(requests, requestId, (request) => {
          const index = request.reviews.batches.findIndex((batch) => batch.batchId === batchId);
          if (index === -1) return null;
          noted = true;
          const batch = request.reviews.batches[index]!;
          const next = {
            ...batch,
            reviewerIds: batch.reviewerIds.includes(reviewerId) ? batch.reviewerIds : [...batch.reviewerIds, reviewerId],
            calls: batch.calls.map((call) => (callId !== null && call.callId === callId ? { ...call, reviewerId } : call)),
          };
          return { ...request, reviews: { ...request.reviews, batches: request.reviews.batches.map((entry, at) => (at === index ? next : entry)) } };
        }),
      );
      return noted;
    },
    addGrant(workspaceId, requestId, grant) {
      let outcome: "added" | "known" | "no-request" = "no-request";
      update(workspaceId, (requests) =>
        withRequest(requests, requestId, (request) => {
          if (request.reviews.grants.some((entry) => entry.decisionId === grant.decisionId)) {
            outcome = "known";
            return null;
          }
          outcome = "added";
          return { ...request, reviews: { ...request.reviews, grants: [...request.reviews.grants, grant] } };
        }),
      );
      return outcome;
    },
    setWaiting(workspaceId, requestId, waiting) {
      let found = false;
      update(workspaceId, (requests) =>
        withRequest(requests, requestId, (request) => {
          found = true;
          if (waiting === null) {
            if (request.waiting === undefined) return null;
            const rest = { ...request };
            delete rest.waiting;
            return rest;
          }
          return { ...request, waiting };
        }),
      );
      return found;
    },
    settleWaitItems(workspaceId, requestId, match, settle) {
      let now: Waiting | null = null;
      update(workspaceId, (requests) =>
        withRequest(requests, requestId, (request) => {
          if (request.waiting === undefined || request.waiting === null) return null;
          now = settleItemsOf(request.waiting, match, settle);
          return now === null ? null : { ...request, waiting: now };
        }),
      );
      return now;
    },
    move(fromWorkspaceId, toWorkspaceId, requestId) {
      const found = list(fromWorkspaceId).find((request) => request.requestId === requestId);
      if (found === undefined || fromWorkspaceId === toWorkspaceId) return "no-request";
      if (list(toWorkspaceId).some((request) => request.requestId === requestId)) return "taken";
      const moved: RegisteredRequest = { ...found, workspaceId: toWorkspaceId, movedFrom: [...(found.movedFrom ?? []), { workspaceId: fromWorkspaceId, at: now().toISOString() }] };
      const written = { taken: false };
      update(toWorkspaceId, (requests) => {
        written.taken = requests.some((request) => request.requestId === requestId);
        return written.taken ? null : [...requests, moved];
      });
      if (written.taken) return "taken";
      try {
        update(fromWorkspaceId, (requests) => (requests.some((request) => request.requestId === requestId) ? requests.filter((request) => request.requestId !== requestId) : null));
      } catch (error) {
        update(toWorkspaceId, (requests) => requests.filter((request) => request.requestId !== requestId));
        throw error;
      }
      return "moved";
    },
  };
}

/** `requests` with `requestId`'s entry changed by `change` (null: nothing to write), or null when it is not registered. */
function withRequest(
  requests: RegisteredRequest[],
  requestId: string,
  change: (request: RegisteredRequest) => RegisteredRequest | null,
): RegisteredRequest[] | null {
  const index = requests.findIndex((request) => request.requestId === requestId);
  if (index === -1) return null;
  const next = change(requests[index]!);
  return next === null ? null : requests.map((request, at) => (at === index ? next : request));
}

// ---------------------------------------------------------------------------
// Reading `bm.requestId`: the hand path trusted, the bound path checked.
// ---------------------------------------------------------------------------

/** What `knownRequestIdOf` reads of an agent: a snapshot, a directory entry or a hook's agent. */
export interface RequestAgent {
  id: string;
  workspaceId: string | null;
  labels?: Readonly<Record<string, unknown>> | null;
  /** The agent that created it (`agent.created`'s `parentAgentId`, else the `paseo.parent-agent-id` label). */
  parentAgentId?: string | null;
}

export interface RequestTrustDeps {
  /** The data folder; looked up when absent, `null` means none (every label is then trusted, as before). */
  home?: string | null;
  log?: (message: string) => void;
}

/** Agents whose unregistered label was logged in this run: one line per agent (§16.4). */
const loggedAgents = new Set<string>();

/**
 * True when `agent`'s creator is bound (§16.4): the plugin created it itself
 * with a token (it has a binding of its own, live or revoked), or its parent
 * has a live (bound) binding (`liveBindingOf`). Pure over `bindings`.
 */
export function creatorIsBound(agent: Pick<RequestAgent, "id" | "labels" | "parentAgentId">, bindings: readonly AgentBinding[]): boolean {
  if (bindings.some((binding) => binding.agentId === agent.id && binding.state !== "pending")) return true;
  return liveBindingOf(bindings, parentOf(agent)) !== null;
}

function homeOf(deps: RequestTrustDeps): string | null {
  return deps.home !== undefined ? deps.home : dataHome();
}

/**
 * The request an agent's `bm.requestId` label names, as far as the plugin
 * trusts it (§16.4) — the one way the plugin reads that label:
 *
 * - no label → null;
 * - the agent's creator is unbound (the hand path) → the label, as before;
 * - the creator is bound → the label only when the workspace's registry holds
 *   it; otherwise null, logged once per agent per run. Never a new request.
 *
 * Never throws: a store that cannot be read trusts the label, as before.
 */
export function knownRequestIdOf(agent: RequestAgent, deps: RequestTrustDeps = {}): string | null {
  const label = nonEmpty(agent.labels?.[REQUEST_ID_LABEL]);
  if (label === null) return null;
  try {
    const home = homeOf(deps);
    if (home === null) return label;
    if (!creatorIsBound(agent, createBindingStore(home).list())) return label;
    if (agent.workspaceId !== null && createRequestRegistry(home).has(agent.workspaceId, label)) return label;
    if (!loggedAgents.has(agent.id)) {
      loggedAgents.add(agent.id);
      (deps.log ?? ((message: string) => console.warn(message)))(
        `[paseo-bm] agent ${agent.id} carries bm.requestId=${label}, which no tool of its bound creator registered; it is read as no request.`,
      );
    }
    return null;
  } catch {
    return label;
  }
}

/** A request id the plugin sees on a recorded turn or a new Worker. */
export interface RequestSighting {
  workspaceId: string | null;
  requestId: string | null;
  /** The role of the agent it was seen on; only a Manager's or a Worker's sighting registers anything. */
  role: string | null;
  agentId: string;
  parentAgentId: string | null;
}

/**
 * The hand path's registration (§16.4): a request id an UNBOUND Manager
 * issued is registered `agent-typed` the first time the plugin sees it, with
 * the Worker it was seen on. A bound Manager's ids come only from its tools,
 * so nothing seen under one is registered. Returns true when the id is (now)
 * registered by this sighting. Never throws; a failure is one log line.
 */
export function sightRequestId(sighting: RequestSighting, deps: RequestTrustDeps & Pick<RequestRegistryDeps, "now" | "backfill" | "keepRequest"> = {}): boolean {
  const log = deps.log ?? ((message: string) => console.warn(message));
  const { workspaceId, requestId, role, agentId, parentAgentId } = sighting;
  if (workspaceId === null || requestId === null || !REQUEST_ID_PATTERN.test(requestId) || !isUsableWorkspaceId(workspaceId)) return false;
  if (role !== "manager" && role !== "worker") return false;
  try {
    const home = homeOf(deps);
    if (home === null) return false;
    const bindings = createBindingStore(home).list();
    // Missions design §3.4 step 4: a Worker of a mission's request is its current Main's (the registry's), the parent label otherwise.
    const managerId = role === "manager" ? agentId : (missionManagerOf(home, requestId) ?? parentAgentId);
    if (role === "manager" ? liveBindingOf(bindings, agentId) !== null : creatorIsBound({ id: agentId, parentAgentId }, bindings)) return false;
    const registry = createRequestRegistry(home, { ...deps, log });
    const known = registry.get(workspaceId, requestId);
    // Seen before, with this Worker: nothing to write (the usual case, every turn).
    if (known !== null && (role !== "worker" || known.workerIds.includes(agentId)) && (managerId === null || known.managerId !== null)) return true;
    return registry.register(workspaceId, requestId, { source: "agent-typed", managerId, workerId: role === "worker" ? agentId : null }) !== null;
  } catch (error) {
    log(`[paseo-bm] could not register request ${requestId} of workspace ${workspaceId}: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}
