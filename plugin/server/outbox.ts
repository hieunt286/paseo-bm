/**
 * The outbox (design §16.7, ADR-027 decision 4): every report, review,
 * message and no-verdict a bound agent's tool produces is stored here BEFORE
 * the plugin delivers it, so a plugin reload never loses it.
 *
 * One file per workspace, `<data folder>/outbox/<workspaceId>.json`, in a
 * `0700` folder, `0600`, a `createJsonFileStore` file (read through its
 * `cached` option: it is read at every turn end): atomic temp → fsync →
 * rename, no symlink, a newer `schemaVersion` read as empty and never written.
 * Every write is one synchronous read-modify-write: the plugin server is one
 * thread, so that is the file's mutex.
 *
 * **Delivery** (`storeAndDeliver`, `deliverRecord`):
 * 1. the record is written `pending` first;
 * 2. it goes to the notice queue as `enqueue(to, "<kind>:<id>", text)` — a
 *    kind of its own, so "the newest of a kind replaces the older" never
 *    applies — with `BM-DELIVERY <kind> <recordId>` as its first line;
 * 3. the queue's callbacks record the outcome: `onSent` → `delivered` (at
 *    once, or at the target's idle moment), `onDropped` → `dropped` with its
 *    reason, one log line and the `delivery-dropped` Inbox alert naming the
 *    request; an input the queue refuses outright is `dropped` too. A record
 *    the queue holds stays `pending`. The alert clears when every drop of the
 *    request is followed by a delivered record with the same target and kind,
 *    or when the request reports `finished` or `stopped` (`clearDroppedAlert`).
 *
 * A record only moves from `pending` to `delivered` or `dropped`, and a
 * settled record never changes. A record can also be stored `withheld`:
 * settled at once and never sent (`add`'s `withheld`; the no-verdict of a
 * canceled Reviewer turn, which must not wake its stopped Worker). It raises
 * no alert and is no drop.
 *
 * **After a reload** (`createOutboxResend`): at the first hook or RPC with a
 * Paseo handle, every `pending` record of every workspace is enqueued again.
 * One sent just before the reload, whose outcome was not written yet, reaches
 * its target twice: nothing drops the second copy (the agent reads both), and
 * the trace reconstruction counts it once, by its record id.
 *
 * **Bounds**: a record stays until it is `delivered` or `dropped`; of those, at
 * most `OUTBOX_SETTLED_LIMIT` per workspace are kept, for `OUTBOX_SETTLED_MS`
 * (`compaction.ts` reads the newest report records here, the collector and
 * `format-check.ts` a bound agent's records, the request registry's trim the
 * open ones). `setup.cleanup` deletes `outbox/`.
 *
 * Readers never throw; a store that cannot be read reads as empty.
 */
import { randomBytes } from "node:crypto";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { DELIVERY_KINDS, OUTBOX_RECORD_ID_PATTERN, deliveryLineOf, type DeliveryKind } from "../shared/notices";
import { createAlertStore, type AlertInput } from "./alert-store";
import { redactText } from "./collector";
import { capBy, createJsonFileStore, entriesOf, type JsonFileStore } from "./data-files";
import { noticeQueue, type NoticeOutcome, type NoticePaseo, type NoticeQueue } from "./notice-queue";
import { errorText } from "./rpc-kit";
import { WORKSPACE_ID_PATTERN } from "./trace-store";
import { timeOrZero } from "../shared/time";

/** The outbox's folder in the data folder (§16.7); the cleanup button deletes it (§7.13.7). */
export const OUTBOX_DIR_NAME = "outbox";
export const OUTBOX_VERSION = 1;
/** Delivered or dropped records kept per workspace (§16.7). */
export const OUTBOX_SETTLED_LIMIT = 500;
/** How long a delivered or dropped record is kept (§16.7): 7 days. */
export const OUTBOX_SETTLED_MS = 7 * 24 * 60 * 60 * 1000;

const OUTBOX_STATES = ["pending", "delivered", "dropped", "withheld"] as const;

const recordSchema = z.object({
  id: z.string().regex(OUTBOX_RECORD_ID_PATTERN),
  kind: z.enum(DELIVERY_KINDS),
  requestId: z.string().min(1),
  batchId: z.string().nullable(),
  from: z.string().min(1),
  to: z.string().min(1),
  text: z.string(),
  createdAt: z.string(),
  state: z.enum(OUTBOX_STATES),
  outcomeAt: z.string().nullable(),
  reason: z.string().nullable(),
});

export type OutboxRecord = z.infer<typeof recordSchema>;

/** What a tool hands the outbox; the store adds the id, the time and the state. */
export interface OutboxInit {
  kind: DeliveryKind;
  requestId: string;
  batchId?: string | null;
  from: string;
  to: string;
  /** The block or message; masked with `redactText` before it is written. */
  text: string;
}

interface OutboxFile {
  records: OutboxRecord[];
}

/** True for a record still to be delivered. */
export function isOpenRecord(record: Pick<OutboxRecord, "state">): boolean {
  return record.state === "pending";
}

function isUsableWorkspaceId(workspaceId: unknown): workspaceId is string {
  return typeof workspaceId === "string" && WORKSPACE_ID_PATTERN.test(workspaceId) && workspaceId !== "." && workspaceId !== "..";
}

/**
 * The records a write keeps (§16.7): every open one; of the settled ones, those
 * settled within `OUTBOX_SETTLED_MS` of `now`, at most `OUTBOX_SETTLED_LIMIT`,
 * the newest. Order is kept.
 */
export function capOutbox(records: readonly OutboxRecord[], now: Date): OutboxRecord[] {
  const settledAt = (record: OutboxRecord): number => timeOrZero(record.outcomeAt ?? record.createdAt);
  const recent = records.filter((record) => isOpenRecord(record) || now.getTime() - settledAt(record) <= OUTBOX_SETTLED_MS);
  const settled = recent.filter((record) => !isOpenRecord(record));
  const kept = new Set(capBy(settled, OUTBOX_SETTLED_LIMIT, settledAt));
  return recent.filter((record) => isOpenRecord(record) || kept.has(record));
}

/** A fresh record id: `out-` + 12 hex digits. */
export function newRecordId(): string {
  return `out-${randomBytes(6).toString("hex")}`;
}

export interface OutboxDeps {
  now?: () => Date;
  /** The record id generator; `newRecordId` by default (tests pin it). */
  newId?: () => string;
  /** Secrets to mask in a record's text; the process's own by default. */
  env?: NodeJS.ProcessEnv;
}

export interface Outbox {
  /** The workspace's records, oldest first (shared with the read cache: never mutate them). Never throws: none for a file that cannot be read. */
  list(workspaceId: string): OutboxRecord[];
  /**
   * Stores a new `pending` record (text masked) — or, with `withheld`, one
   * settled `withheld` for that reason, which nothing delivers. Throws when
   * the file cannot be written.
   */
  add(workspaceId: string, init: OutboxInit, withheld?: string): OutboxRecord;
  /**
   * Settles a `pending` record as `delivered` or `dropped` (a settled record
   * never changes); returns the record as it is now, or null when there is
   * none. `reason` is kept for `dropped`. Throws when the file cannot be written.
   */
  settle(workspaceId: string, id: string, state: "delivered" | "dropped", reason?: string | null): { record: OutboxRecord; changed: boolean } | null;
  /** The workspaces with an outbox file. Never throws. */
  workspaces(): string[];
}

/** The outbox of the data folder `home`. Creating it touches nothing on disk. */
export function createOutbox(home: string, deps: OutboxDeps = {}): Outbox {
  const now = deps.now ?? (() => new Date());
  const newId = deps.newId ?? newRecordId;

  const fileOf = (workspaceId: string): JsonFileStore<OutboxFile> =>
    createJsonFileStore<OutboxFile>({
      home,
      dir: OUTBOX_DIR_NAME,
      file: `${workspaceId}.json`,
      version: OUTBOX_VERSION,
      versionKey: "schemaVersion",
      parse: (body) => ({ records: entriesOf(recordSchema, body["records"]) }),
      empty: () => ({ records: [] }),
      cap: (value) => ({ records: capOutbox(value.records, now()) }),
      codes: { unwritable: "E_TRACE_STORE_UNWRITABLE" },
      // Reports in flight: a file that cannot be read is fixed or deleted by hand, never replaced.
      keepUnusable: true,
      cached: true,
    });

  const requireWorkspace = (workspaceId: string): void => {
    if (!isUsableWorkspaceId(workspaceId)) throw new Error(`workspace id is not usable as a file name: ${JSON.stringify(workspaceId)}`);
  };

  return {
    list(workspaceId) {
      if (!isUsableWorkspaceId(workspaceId)) return [];
      try {
        return fileOf(workspaceId).read().records;
      } catch {
        return [];
      }
    },
    add(workspaceId, init, withheld) {
      requireWorkspace(workspaceId);
      let made: OutboxRecord | null = null;
      fileOf(workspaceId).update((current) => {
        const taken = new Set(current.records.map((record) => record.id));
        let id = newId();
        while (taken.has(id)) id = newId();
        const at = now().toISOString();
        made = recordSchema.parse({
          id,
          kind: init.kind,
          requestId: init.requestId,
          batchId: init.batchId ?? null,
          from: init.from,
          to: init.to,
          text: redactText(init.text, deps.env ?? process.env),
          createdAt: at,
          state: withheld === undefined ? "pending" : "withheld",
          outcomeAt: withheld === undefined ? null : at,
          reason: withheld ?? null,
        });
        return { records: [...current.records, made] };
      });
      return made!;
    },
    settle(workspaceId, id, state, reason = null) {
      requireWorkspace(workspaceId);
      let result: { record: OutboxRecord; changed: boolean } | null = null;
      fileOf(workspaceId).update((current) => {
        const index = current.records.findIndex((record) => record.id === id);
        if (index === -1) return null;
        const found = current.records[index]!;
        if (!isOpenRecord(found)) {
          result = { record: found, changed: false };
          return null;
        }
        const next: OutboxRecord = { ...found, state, outcomeAt: now().toISOString(), reason: state === "dropped" ? (reason ?? "not delivered") : null };
        result = { record: next, changed: true };
        return { records: current.records.map((record, at) => (at === index ? next : record)) };
      });
      return result;
    },
    workspaces() {
      try {
        return readdirSync(join(home, OUTBOX_DIR_NAME))
          .filter((name) => name.endsWith(".json"))
          .map((name) => name.slice(0, -".json".length))
          .filter(isUsableWorkspaceId);
      } catch {
        return [];
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Delivery.
// ---------------------------------------------------------------------------

/** What a delivery says: `BM-DELIVERY <kind> <recordId>`, then the record's text. */
export function deliveryTextOf(record: Pick<OutboxRecord, "kind" | "id" | "text">): string {
  return `${deliveryLineOf(record.kind, record.id)}\n${record.text}`;
}

/** The notice-queue kind of a record: its own, so no record ever replaces another. */
export function deliveryKindOf(record: Pick<OutboxRecord, "kind" | "id">): string {
  return `${record.kind}:${record.id}`;
}

export interface OutboxDeliveryDeps extends OutboxDeps {
  /** The data folder. */
  home: string;
  /** The notice queue; the plugin's shared one by default. */
  queue?: Pick<NoticeQueue, "enqueue">;
  /** The caller's Paseo handle; the queue's last one when absent. */
  paseo?: NoticePaseo;
  log?: (message: string) => void;
}

/** The `delivery-dropped` alert of a record (§16.7): about its request, the record in its detail. */
function droppedAlertOf(workspaceId: string, record: OutboxRecord): AlertInput {
  return {
    workspaceId,
    kind: "delivery-dropped",
    subject: record.requestId,
    detail: `The ${record.kind} ${record.id} from ${record.from} to ${record.to} was not delivered: ${record.reason ?? "not delivered"}.`,
  };
}

/**
 * True when every `dropped` record of `requestId` is followed by a delivered
 * record of the request with the same target and kind, created at or after
 * the drop (K4: a message to the Worker never covers a report lost on its
 * way to the Manager). Pure.
 */
export function dropsCovered(records: readonly OutboxRecord[], requestId: string): boolean {
  const ofRequest = records.filter((record) => record.requestId === requestId);
  return ofRequest
    .filter((record) => record.state === "dropped")
    .every((drop) =>
      ofRequest.some(
        (later) => later.state === "delivered" && later.to === drop.to && later.kind === drop.kind && timeOrZero(later.createdAt) >= timeOrZero(drop.outcomeAt ?? drop.createdAt),
      ),
    );
}

/**
 * Clears the `delivery-dropped` alert of `requestId` (§16.7, As built): when
 * `delivered` (a record of the request that just reached its target) leaves
 * every drop of the request covered (`dropsCovered`), or outright when the
 * request reported `finished` or `stopped` (`delivered` null). Returns the
 * cleared keys. Throws when the alert store cannot be written.
 */
export function clearDroppedAlert(home: string, workspaceId: string, requestId: string, delivered: OutboxRecord | null, deps: Pick<OutboxDeps, "now"> = {}): string[] {
  if (delivered !== null && !dropsCovered(createOutbox(home).list(workspaceId), requestId)) return [];
  return createAlertStore(home, deps).clearWhere((alert) => alert.kind === "delivery-dropped" && alert.workspaceId === workspaceId && alert.subject === requestId);
}

/**
 * Hands one record to the notice queue; the queue's callbacks record its
 * outcome (§16.7 steps 2–3). Never rejects: a store failure is one log line,
 * and the record stays as it was, to be sent again after a reload.
 */
export async function deliverRecord(workspaceId: string, record: OutboxRecord, deps: OutboxDeliveryDeps): Promise<NoticeOutcome> {
  const log = deps.log ?? ((message: string) => console.warn(message));
  const queue = deps.queue ?? noticeQueue;
  let told = false;

  const settle = (state: "delivered" | "dropped", reason: string | null = null): void => {
    told = true;
    try {
      const result = createOutbox(deps.home, deps).settle(workspaceId, record.id, state, reason);
      if (result === null || !result.changed) return;
      if (state === "delivered") {
        try {
          clearDroppedAlert(deps.home, workspaceId, record.requestId, result.record, deps);
        } catch (error) {
          log(`[paseo-bm] could not clear the delivery-dropped alert of request ${record.requestId}: ${errorText(error)}`);
        }
        return;
      }
      log(`[paseo-bm] the ${record.kind} ${record.id} of request ${record.requestId} to ${record.to} was not delivered: ${result.record.reason ?? "not delivered"}.`);
      try {
        createAlertStore(deps.home, deps).raise(droppedAlertOf(workspaceId, result.record));
      } catch (error) {
        log(`[paseo-bm] could not raise the delivery-dropped alert of ${record.id}: ${errorText(error)}`);
      }
    } catch (error) {
      log(`[paseo-bm] could not record the outcome of the ${record.kind} ${record.id}: ${errorText(error)}`);
    }
  };

  try {
    const outcome = await queue.enqueue(record.to, deliveryKindOf(record), deliveryTextOf(record), deps.paseo, {
      onSent: () => settle("delivered"),
      onDropped: (_targetId, _kind, reason) => settle("dropped", reason),
    });
    // An input the queue refuses outright calls no callback; `queued` and `replaced` settle later.
    if (outcome === "dropped" && !told) settle("dropped", "the notice queue refused it");
    return outcome;
  } catch (error) {
    log(`[paseo-bm] could not deliver the ${record.kind} ${record.id}: ${errorText(error)}`);
    return "dropped";
  }
}

/**
 * Stores `init` as a `pending` record, runs `before` once it is stored (a
 * throw there is one log line: the record is delivered all the same), then
 * delivers it (§16.7). Returns the record as stored and the queue's outcome.
 * Throws only when the record cannot be written — nothing is sent then.
 */
export async function storeAndDeliver(
  workspaceId: string,
  init: OutboxInit,
  deps: OutboxDeliveryDeps,
  before: (record: OutboxRecord) => void = () => {},
): Promise<{ record: OutboxRecord; outcome: NoticeOutcome }> {
  const record = createOutbox(deps.home, deps).add(workspaceId, init);
  try {
    before(record);
  } catch (error) {
    (deps.log ?? ((message: string) => console.warn(message)))(`[paseo-bm] after storing the ${record.kind} ${record.id}: ${errorText(error)}`);
  }
  return { record, outcome: await deliverRecord(workspaceId, record, deps) };
}

export interface OutboxResend {
  /** The first call with a Paseo handle re-sends the open records; every later call does nothing. Never rejects. */
  run(paseo: unknown): Promise<void>;
}

/**
 * Re-sends the outbox once per run, at the first hook or RPC that brings a
 * Paseo handle (§16.7): every `pending` record of every workspace is enqueued
 * again.
 */
export function createOutboxResend(deps: Omit<OutboxDeliveryDeps, "home" | "paseo"> & { home: () => string | null }): OutboxResend {
  let done = false;
  return {
    async run(paseo) {
      if (done || paseo === null || typeof paseo !== "object") return;
      done = true;
      try {
        const home = deps.home();
        if (home === null) return;
        const delivery: OutboxDeliveryDeps = { ...deps, home, paseo: paseo as NoticePaseo };
        const outbox = createOutbox(home, delivery);
        for (const workspaceId of outbox.workspaces()) {
          for (const record of outbox.list(workspaceId).filter(isOpenRecord)) await deliverRecord(workspaceId, record, delivery);
        }
      } catch (error) {
        (deps.log ?? ((message: string) => console.warn(message)))(`[paseo-bm] could not deliver the outbox again: ${errorText(error)}`);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Readers.
// ---------------------------------------------------------------------------

/** The `report` and `review` records `agentId` created from `from` to `to` (inclusive, ISO), oldest first. Never throws. */
export function recordsCreatedBy(home: string, workspaceId: string, agentId: string, from: string | null, to: string): OutboxRecord[] {
  const lower = from === null ? Number.NEGATIVE_INFINITY : timeOrZero(from);
  const upper = timeOrZero(to);
  return createOutbox(home)
    .list(workspaceId)
    .filter((record) => record.from === agentId && (record.kind === "report" || record.kind === "review"))
    .filter((record) => {
      const at = timeOrZero(record.createdAt);
      return at >= lower && at <= upper;
    });
}

/**
 * The newest `report` record of `agentId` that is `pending` or `delivered`
 * (§16.7: how `compaction.ts` reads a bound agent's reports), created at or
 * after `since` when given. Never throws.
 */
export function newestReportRecordOf(home: string, workspaceId: string, agentId: string, since: string | null = null): OutboxRecord | null {
  const lower = since === null ? Number.NEGATIVE_INFINITY : timeOrZero(since);
  return (
    createOutbox(home)
      .list(workspaceId)
      .filter((record) => record.from === agentId && record.kind === "report" && (record.state === "pending" || record.state === "delivered"))
      .filter((record) => timeOrZero(record.createdAt) >= lower)
      .at(-1) ?? null
  );
}
