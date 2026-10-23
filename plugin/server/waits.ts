/**
 * Structured waits on the server (delivery line design §6.2, §6.3; ADR-035
 * decision 5): the request registry's `waiting`, set by a bound Worker's
 * `blocked` report, and the hooks that settle its items.
 *
 * | Item | Settled by | Hook |
 * |---|---|---|
 * | question | its decision answered, decided, expired or withdrawn | `settleQuestionWait`, from the decision store's `transition` |
 * | link | a reply or message from the answering side; the link closed; the link past its ceiling | `settleLinkWait`, where a message is appended or a link closed; `settleDeadWaitItems`, the stall pass |
 * | batch | a review or no-verdict record of it; its Reviewer gone with no verdict | `settleBatchWait`, from outbox `add`; `settleDeadWaitItems`, the stall pass |
 * | request | it, or the head of its chain, reports `finished` or `stopped` (or its roster says so); no live Worker is left on it | `settleRequestWaits`, the report's `before` step; `settleDeadWaitItems`, the stall pass |
 *
 * A settled request or link keeps its fact ("req-X finished: <summary>") for
 * the wake. Each hook returns the waits it changed and whether each is now
 * met (`SettledWait`), for the wake gate (design §6.4), which holds and
 * releases deliveries; the hooks here only record. Every wait is read where
 * its request's registry entry is: the workspace the report named, else the
 * request's repo (the request index, missions design §2.3).
 *
 * Nothing here throws: a failure is one log line.
 */
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { assertNoSymlink } from "./data-files";
import { createMissionRoster, requestIndexOf } from "./mission-roster";
import type { PeerLink } from "./peer-links";
import { REQUESTS_DIR_NAME, createRequestRegistry, type RegisteredRequest, type RequestRegistry } from "./request-registry";
import { errorText } from "./rpc-kit";
import { decisionKindOf, isAnswerable, type Decision } from "../shared/decisions";
import { linkCeilingFactOf, linkClosedFactOf, structuralWaitOf, type StructuralWaitFacts, type WaitQuestionFact, type WaitRequestFact } from "../shared/structural-wait";
import { requestFactOf, requestIdsInText, unsettledItemsOf, waitMet, waitRefsOf, type WaitItem, type WaitRef, type WakeOn, type Waiting } from "../shared/waits";

const defaultLog = (message: string): void => console.warn(message);

/** The most continuations followed to a chain's head, or back to its root. */
const MAX_CHAIN_STEPS = 50;

/** A wait a hook changed: where it is, as it is now, and whether it is met (design §6.2). */
export interface SettledWait {
  workspaceId: string;
  requestId: string;
  waiting: Waiting;
  met: boolean;
}

/** A request and the workspace whose registry holds it. */
export interface LocatedRequest {
  workspaceId: string;
  request: RegisteredRequest;
}

/** The workspaces with a registry file. Never throws. */
function registryWorkspaces(home: string): string[] {
  try {
    assertNoSymlink(home, join(home, REQUESTS_DIR_NAME), "E_TRACE_STORE_UNWRITABLE");
    return readdirSync(join(home, REQUESTS_DIR_NAME))
      .filter((name) => name.endsWith(".json"))
      .map((name) => name.slice(0, -".json".length));
  } catch {
    return [];
  }
}

/**
 * Where `requestId` is registered: in `hint`'s registry, else its repo's (the
 * request index), else any workspace's. Null when none holds it. Never throws.
 */
export function locateRequest(home: string, requestId: string, hint: string | null = null, registry: RequestRegistry = createRequestRegistry(home)): LocatedRequest | null {
  try {
    const tried = new Set<string>();
    const places = [hint, requestIndexOf(home, requestId)?.workspaceId ?? null];
    for (const workspaceId of places) {
      if (workspaceId === null || tried.has(workspaceId)) continue;
      tried.add(workspaceId);
      const request = registry.get(workspaceId, requestId);
      if (request !== null) return { workspaceId, request };
    }
    for (const workspaceId of registryWorkspaces(home)) {
      if (tried.has(workspaceId)) continue;
      const request = registry.get(workspaceId, requestId);
      if (request !== null) return { workspaceId, request };
    }
    return null;
  } catch {
    return null;
  }
}

/** The structured wait of a request (design §6.2), or null when it has none. Never throws. */
export function waitingOf(home: string, workspaceId: string, requestId: string): Waiting | null {
  return locateRequest(home, requestId, workspaceId)?.request.waiting ?? null;
}

/**
 * The head of `requestId`'s chain (delivery line design §2.7): the one
 * resolver from a request to the request whose Worker carries its work now —
 * its newest continuation, itself when none. Null when no registry holds it.
 * Never throws.
 */
export function chainHeadOf(home: string, requestId: string, hint: string | null = null, registry: RequestRegistry = createRequestRegistry(home, { log: () => {} })): LocatedRequest | null {
  const located = locateRequest(home, requestId, hint, registry);
  return located === null ? null : headOf(registry, home, located);
}

/** `requestId` and every request it continues, back to its chain's root (newest first); itself alone when no registry holds it. Never throws. */
export function chainOf(home: string, requestId: string, hint: string | null = null, registry: RequestRegistry = createRequestRegistry(home, { log: () => {} })): string[] {
  const located = locateRequest(home, requestId, hint, registry);
  return located === null ? [requestId] : chainBackOf(registry, home, located);
}

/** The head of `located`'s chain: its newest continuation, itself when none. */
function headOf(registry: RequestRegistry, home: string, located: LocatedRequest): LocatedRequest {
  let current = located;
  for (let step = 0; step < MAX_CHAIN_STEPS && current.request.continuedBy !== undefined; step += 1) {
    const next = locateRequest(home, current.request.continuedBy, current.workspaceId, registry);
    if (next === null) break;
    current = next;
  }
  return current;
}

/** `requestId` and every request it continues, back to the root of its chain. */
function chainBackOf(registry: RequestRegistry, home: string, located: LocatedRequest): string[] {
  const ids = [located.request.requestId];
  let current = located;
  for (let step = 0; step < MAX_CHAIN_STEPS && current.request.continuationOf !== undefined; step += 1) {
    const before = current.request.continuationOf;
    if (ids.includes(before)) break;
    ids.push(before);
    const next = locateRequest(home, before, current.workspaceId, registry);
    if (next === null) break;
    current = next;
  }
  return ids;
}

// ---------------------------------------------------------------------------
// Setting a wait (design §6.2).
// ---------------------------------------------------------------------------

/** What a bound Worker's `blocked` report waits on, as `bm_report` takes it. */
export interface BlockedWaitInput {
  waitingOn?: readonly string[];
  waitingOnPeers?: readonly string[];
  waitingOnRequests?: readonly string[];
  waitingOnBatches?: readonly string[];
  waitingFor?: string;
  wakeOn?: WakeOn;
}

/**
 * The `req-…` ids of `waitingFor` that become `request` items (design §6.2):
 * those paseo-bm knows, other than the Worker's own and those named already,
 * up to `room`. Never throws.
 */
export function promotedRequestIdsOf(home: string, workspaceId: string, own: string, input: BlockedWaitInput, room: number): string[] {
  const named = new Set(input.waitingOnRequests ?? []);
  return requestIdsInText(input.waitingFor, own)
    .filter((id) => !named.has(id) && locateRequest(home, id, workspaceId) !== null)
    .slice(0, Math.max(0, room));
}

/**
 * The wait a `blocked` report sets (design §6.2): its items by id — with the
 * `req-…` ids `waitingFor` names promoted — each unsettled, except an awaited
 * request whose chain already finished, which is settled with its fact at
 * once. Never throws.
 */
export function waitingForReport(
  home: string,
  report: { workspaceId: string; requestId: string; recordId: string; at: string },
  input: BlockedWaitInput,
  maxRequests: number,
): Waiting {
  const registry = createRequestRegistry(home);
  const explicit = input.waitingOnRequests ?? [];
  const promoted = promotedRequestIdsOf(home, report.workspaceId, report.requestId, input, maxRequests - explicit.length);
  const refs = waitRefsOf({ ...input, waitingOnRequests: [...explicit, ...promoted] });
  const items = refs.map((ref): WaitItem => {
    if (ref.kind !== "request") return { ...ref, settled: false };
    const located = locateRequest(home, ref.id, report.workspaceId, registry);
    if (located === null) return { ...ref, settled: false };
    const head = headOf(registry, home, located);
    if (head.request.finishedAt === null) return { ...ref, settled: false };
    return { ...ref, settled: true, settledAt: report.at, fact: requestFactOf(ref.id, "finished", null, head.request.requestId) };
  });
  return { since: report.at, reportRecordId: report.recordId, wakeOn: input.wakeOn ?? "all", items };
}

// ---------------------------------------------------------------------------
// Settling items (design §6.3).
// ---------------------------------------------------------------------------

type Settle = { at: string; fact?: string | ((item: WaitItem) => string | undefined) };

/** Settles the items `match` takes in the waits of `targets` (null: every registered request with a wait). */
function settleIn(home: string, targets: ReadonlyArray<{ workspaceId: string; requestId: string }> | null, match: (item: WaitItem) => boolean, settle: Settle, log: (message: string) => void): SettledWait[] {
  const out: SettledWait[] = [];
  try {
    const registry = createRequestRegistry(home, { log });
    const places: LocatedRequest[] = [];
    if (targets === null) {
      for (const workspaceId of registryWorkspaces(home)) {
        for (const request of registry.list(workspaceId)) if (unsettledItemsOf(request.waiting).some(match)) places.push({ workspaceId, request });
      }
    } else {
      for (const target of targets) {
        const located = locateRequest(home, target.requestId, target.workspaceId, registry);
        if (located !== null && unsettledItemsOf(located.request.waiting).some(match)) places.push(located);
      }
    }
    for (const { workspaceId, request } of places) {
      try {
        const waiting = registry.settleWaitItems(workspaceId, request.requestId, match, settle);
        if (waiting !== null) out.push({ workspaceId, requestId: request.requestId, waiting, met: waitMet(waiting) });
      } catch (error) {
        log(`[paseo-bm] could not settle the wait of request ${request.requestId}: ${errorText(error)}`);
      }
    }
  } catch (error) {
    log(`[paseo-bm] could not settle waits: ${errorText(error)}`);
  }
  return out;
}

/**
 * Settles every unsettled item naming `ref` (design §6.3) — in the wait of
 * `where` only when given, else in every wait — with `settle.fact`. Returns
 * the waits it changed, each with whether it is now met. Never throws.
 */
export function settleWaitItem(
  home: string,
  ref: WaitRef,
  settle: Settle,
  where: { workspaceId: string; requestId: string } | null = null,
  log: (message: string) => void = defaultLog,
): SettledWait[] {
  return settleIn(home, where === null ? null : [where], (item) => item.kind === ref.kind && item.id === ref.id, settle, log);
}

/**
 * The decision store's `transition` hook (design §6.3): a Worker question
 * that leaves the open states — answered, decided, expired or withdrawn —
 * settles the item that names it in its request's wait. Never throws.
 */
export function settleQuestionWait(home: string, previous: Decision, next: Decision, log: (message: string) => void = defaultLog): SettledWait[] {
  if (next.requestId === null || decisionKindOf(next.id) !== "question" || !isAnswerable(previous) || isAnswerable(next)) return [];
  return settleWaitItem(home, { kind: "question", id: next.id }, { at: next.settledAt ?? new Date().toISOString() }, { workspaceId: next.workspaceId, requestId: next.requestId }, log);
}

/**
 * Outbox `add`'s hook (design §6.3): a `review` or `no-verdict` record of a
 * batch settles the item naming that batch in its request's wait. Never throws.
 */
export function settleBatchWait(
  home: string,
  workspaceId: string,
  record: { kind: string; requestId: string | null; batchId: string | null; createdAt: string },
  log: (message: string) => void = defaultLog,
): SettledWait[] {
  if ((record.kind !== "review" && record.kind !== "no-verdict") || record.requestId === null || record.batchId === null) return [];
  return settleWaitItem(home, { kind: "batch", id: record.batchId }, { at: record.createdAt }, { workspaceId, requestId: record.requestId }, log);
}

/** What happened on a link that settles a wait on it (design §6.3). */
export type LinkSettlement = { kind: "message"; side: "asker" | "answerer"; text: string } | { kind: "closed"; by: "asker" | "answerer" } | { kind: "ceiling"; why: string };

/** The fact a link's settlement puts in the wake. */
function linkFactOf(linkId: string, how: LinkSettlement): string | null {
  if (how.kind === "message") return how.side === "answerer" ? `${linkId} answered: ${how.text}` : null;
  if (how.kind === "closed") return linkClosedFactOf(linkId, how.by);
  return linkCeilingFactOf(linkId, how.why);
}

/**
 * Where a link's message is appended or the link closed, and the stall pass
 * for its ceiling (design §6.3): a word from the answering side, the link
 * closed, or the link past its ceiling settles the item naming it in the
 * asking request's wait, with its fact. A word from the asker settles
 * nothing. Never throws.
 */
export function settleLinkWait(home: string, link: Pick<PeerLink, "linkId" | "from">, how: LinkSettlement, at: string, log: (message: string) => void = defaultLog): SettledWait[] {
  if (link.from.requestId === null) return [];
  const fact = linkFactOf(link.linkId, how);
  if (fact === null) return [];
  return settleWaitItem(home, { kind: "link", id: link.linkId }, { at, fact }, { workspaceId: link.from.workspaceId, requestId: link.from.requestId }, log);
}

/**
 * The report's `before` step (design §6.3): `requestId` reported `finished`
 * or `stopped`, so every wait on it — or on a request of its chain it
 * continues, for it is that chain's head — settles, with its fact. Never throws.
 */
export function settleRequestWaits(
  home: string,
  workspaceId: string,
  requestId: string,
  phase: "finished" | "stopped",
  summary: string | null,
  at: string,
  log: (message: string) => void = defaultLog,
): SettledWait[] {
  let chain = [requestId];
  try {
    const registry = createRequestRegistry(home, { log });
    const located = locateRequest(home, requestId, workspaceId, registry);
    if (located !== null) chain = chainBackOf(registry, home, located);
  } catch {
    // The request alone.
  }
  const named = new Set(chain);
  return settleIn(home, null, (item) => item.kind === "request" && named.has(item.id), { at, fact: (item) => requestFactOf(item.id, phase, summary, requestId) }, log);
}

/** What the stall pass knows of the links and agents at `at`, for `waitFactsOf` and `settleDeadWaitItems`. */
export interface DeadWaitFacts {
  /** The link store, as the pass read it. */
  links: readonly PeerLink[];
  /** Why a waited link no longer counts as a wait (`peerCeilingOf`), or null while it does. */
  ceilingOf: (link: PeerLink) => string | null;
  /** True for an agent that is live: not archived, closed or replaced. */
  isLive: (agentId: string) => boolean;
  /** True for an agent whose turn runs now (a Reviewer of an awaited batch); absent: none does, and a batch lives on its pending window only. */
  isRunning?: (agentId: string) => boolean;
  /** How long a review call may go without a running Reviewer (`PENDING_TTL_MS`); absent: a batch never dies of it. */
  pendingMs?: number;
  /**
   * What a question is now: `open` while answerable, `closed` once settled,
   * null when the decisions do not know it; absent: every question is unknown.
   * The caller reads the decision store (it imports this module).
   */
  question?: (decisionId: string) => WaitQuestionFact | null;
}

/**
 * The facts `structuralWaitOf` judges a wait by (delivery line design §6.5),
 * read from the stores of `home` and what the pass knows, each looked up once:
 * a question by `facts.question`; an awaited request at the head of its
 * chain — finished by its registry entry, stopped by its mission's roster —
 * with its Workers; a link from the link store and its ceiling; a batch's
 * Reviewer by `isRunning`, its calls against `pendingMs`. Never throws: a
 * lookup that fails knows nothing.
 */
export function waitFactsOf(home: string, facts: DeadWaitFacts, at: string, registry: RequestRegistry = createRequestRegistry(home)): StructuralWaitFacts {
  const links = new Map(facts.links.map((link) => [link.linkId, link]));
  const questions = new Map<string, WaitQuestionFact | null>();
  const questionOf = facts.question ?? (() => null);
  const requests = new Map<string, WaitRequestFact | null>();
  const rosterStateOf = (requestId: string): string | null => {
    const place = requestIndexOf(home, requestId);
    return place === null ? null : (createMissionRoster(home).get(place.missionId, requestId)?.state ?? null);
  };
  return {
    now: at,
    pendingMs: facts.pendingMs ?? Number.POSITIVE_INFINITY,
    question(id) {
      if (!questions.has(id)) {
        try {
          questions.set(id, questionOf(id));
        } catch {
          questions.set(id, null);
        }
      }
      return questions.get(id)!;
    },
    request(id) {
      if (!requests.has(id)) {
        try {
          const located = locateRequest(home, id, null, registry);
          if (located === null) requests.set(id, null);
          else {
            const head = headOf(registry, home, located);
            const roster = rosterStateOf(head.request.requestId);
            const state = head.request.finishedAt !== null || roster === "finished" ? "finished" : roster === "stopped" ? "stopped" : "active";
            requests.set(id, { headId: head.request.requestId, state, workers: head.request.workerIds.length, liveWorker: head.request.workerIds.some(facts.isLive) });
          }
        } catch {
          requests.set(id, null);
        }
      }
      return requests.get(id)!;
    },
    link(id) {
      const link = links.get(id);
      if (link === undefined) return null;
      return { state: link.state, closedBy: link.closedBy, ceiling: link.state === "open" || link.state === "taken" ? facts.ceilingOf(link) : null };
    },
    isRunning: (agentId) => facts.isRunning?.(agentId) ?? false,
  };
}

/**
 * The stall pass (design §6.3, §6.5): the dead items of every structured wait
 * — an awaited link answered, closed or past its ceiling; an awaited request
 * whose chain finished or stopped, or has no live Worker left; a batch whose
 * Reviewer is gone with no verdict; a question settled without its hook —
 * settle as facts (`structuralWaitOf`). Each settles once: the next pass
 * finds it settled. Returns the waits it changed, for the release that wakes
 * the Worker (design §6.4). Never throws.
 */
export function settleDeadWaitItems(home: string, facts: DeadWaitFacts, at: string, log: (message: string) => void = defaultLog): SettledWait[] {
  const out: SettledWait[] = [];
  try {
    const registry = createRequestRegistry(home, { log });
    const judged = waitFactsOf(home, facts, at, registry);
    for (const workspaceId of registryWorkspaces(home)) {
      for (const request of registry.list(workspaceId)) {
        if (unsettledItemsOf(request.waiting).length === 0) continue;
        const dead = new Map(structuralWaitOf(request, judged).dead.map((entry) => [`${entry.item.kind}:${entry.item.id}`, entry.fact]));
        if (dead.size === 0) continue;
        try {
          const waiting = registry.settleWaitItems(workspaceId, request.requestId, (item) => dead.has(`${item.kind}:${item.id}`), { at, fact: (item) => dead.get(`${item.kind}:${item.id}`) });
          if (waiting !== null) out.push({ workspaceId, requestId: request.requestId, waiting, met: waitMet(waiting) });
        } catch (error) {
          log(`[paseo-bm] could not settle the wait of request ${request.requestId}: ${errorText(error)}`);
        }
      }
    }
  } catch (error) {
    log(`[paseo-bm] could not look at the waits: ${errorText(error)}`);
  }
  return out;
}
