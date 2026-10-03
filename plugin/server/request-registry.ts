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
 *   the format stays the one `checkBlocks` and every reader accept.
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
 *   first, then the oldest; a request with a `pending` or `queued` outbox
 *   record (`outbox.ts`, §16.7) is never dropped.
 *
 * Readers never throw; a store that cannot be read reads as empty.
 */
import { join } from "node:path";
import { z } from "zod";
import { parentOf } from "./agent-role";
import { createBindingStore, liveBindingOf, type AgentBinding } from "./agent-bindings";
import { clearJsonFileCache, createJsonFileStore, entriesOf, type JsonFileStore } from "./data-files";
import { createOutbox } from "./outbox";
import { dataHome } from "./rpc-kit";
import { WORKSPACE_ID_PATTERN, readRecords } from "./trace-store";
import { timeOrZero } from "../shared/time";

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
});

const requestSchema = z.object({
  requestId: z.string().regex(REQUEST_ID_PATTERN),
  workspaceId: z.string().min(1),
  createdAt: z.string(),
  source: z.enum(["tool", "backfill", "agent-typed"]),
  managerId: z.string().nullable(),
  workerIds: z.array(z.string()),
  tier: z.enum(["Small", "Medium", "Large"]).nullable(),
  finishedAt: z.string().nullable(),
  reviews: z.object({
    batches: z.array(z.object({ batchId: z.string(), reviewerIds: z.array(z.string()), brief: z.string(), calls: z.array(reviewCallSchema) })),
    grants: z.array(z.object({ decisionId: z.string(), calls: z.number().int().nullable(), untilCleanBatch: z.string().nullable() })),
  }),
});

export type RegisteredRequest = z.infer<typeof requestSchema>;

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
  /** A new request with a fresh id (`source: "tool"`). Throws when the file cannot be written. */
  generate(workspaceId: string, init: { managerId: string | null }): RegisteredRequest;
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
   * A report of the request was stored (design §16.6, `bm_report`): `tier`
   * becomes the report's, and `finishedAt` is `at` for a `finished` report and
   * null for any other phase (a request its Worker goes on with is not
   * finished; a stopped one is not either). False when the request is not
   * registered. Throws when the file cannot be written.
   */
  noteReport(workspaceId: string, requestId: string, report: { tier: "Small" | "Medium" | "Large"; phase: string; at: string }): boolean;
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
  ): "added" | "no-request" | "no-batch" | "batch-taken";
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
}

/** One review call the registry holds (design §16.4). */
export type ReviewCall = z.infer<typeof reviewCallSchema>;
/** One review batch of a request (design §16.4). */
export type ReviewBatch = RegisteredRequest["reviews"]["batches"][number];
/** One grant of a `review-budget` decision (design §16.4, §16.8). */
export type ReviewBudgetGrant = RegisteredRequest["reviews"]["grants"][number];

/**
 * The registry's default drop guard (§16.4): a request with a `pending` or
 * `queued` outbox record. Each guard reads the outbox once, at its first
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
          .filter((record) => record.state === "pending" || record.state === "queued")
          .map((record) => record.requestId),
      );
      read = { workspaceId, open };
    }
    return read.open.has(requestId);
  };
}

/** Drops the read cache and the once-per-run log memory; tests only. */
export function clearRequestRegistryCache(): void {
  clearJsonFileCache();
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
      update(workspaceId, (requests) => {
        const taken = new Set(requests.map((request) => request.requestId));
        const at = now();
        let second = Math.floor(at.getTime() / 1000) * 1000;
        let requestId = requestIdAt(new Date(second));
        while (taken.has(requestId)) {
          second += 1000;
          requestId = requestIdAt(new Date(second));
        }
        made = newEntry(workspaceId, requestId, at.toISOString(), "tool", init.managerId, []);
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
    noteReport(workspaceId, requestId, report) {
      let found = false;
      update(workspaceId, (requests) => {
        const index = requests.findIndex((request) => request.requestId === requestId);
        if (index === -1) return null;
        found = true;
        const request = requests[index]!;
        const finishedAt = report.phase === "finished" ? report.at : null;
        if (request.tier === report.tier && request.finishedAt === finishedAt) return null;
        return requests.map((entry, at) => (at === index ? { ...entry, tier: report.tier, finishedAt } : entry));
      });
      return found;
    },
    addReviewCall(workspaceId, requestId, batchId, call, brief) {
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
            const opened = { batchId, reviewerIds: batch?.reviewerIds ?? [], brief: brief ?? batch?.brief ?? "", calls: [...(batch?.calls ?? []), call] };
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
    const managerId = role === "manager" ? agentId : parentAgentId;
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
