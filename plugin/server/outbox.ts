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
 *    applies — with `BM-DELIVERY <kind> <recordId>` as its first line; to a
 *    mission's Main, as an item of its channel (`main-channel.ts`, mission
 *    runtime design §6.2), the same kind its key;
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
 * **Held** (delivery line design §6.4, `wake-gate.ts`): before its send, a
 * record goes through the wake gate. One the gate holds — to a bound Worker
 * waiting by structure on items it settles none of — moves to `held`, an open
 * state: kept, sent again after a reload (and gated again then), and back to
 * `pending` when the Worker's release carries it (`heldRecordItems`). The
 * gate is asked again at the send (`holdsAtSend`): one queued while its
 * Worker ran a turn that reported `blocked` moves to `held` then. One held
 * for a Worker a handoff replaced goes to its successor's release. A
 * record whose delivery meets the wait goes in the release, first. A record
 * stored with `atOnce` (`bm_tell_worker`'s `now: true`) is never held.
 * An older build skips a `held` record.
 *
 * **Steered** (delivery line design §19.5): such an `atOnce` message is the
 * owner's words (`isOwnerWords`), queued with `steer`: the queue sends it
 * into the Worker's running turn when its guards hold. The record then gains
 * `steeredAt`, and `replaced: true` when Paseo replaced the turn instead —
 * which also tells the request's Main and opens the owner's `turn-replaced`
 * Inbox alert (`reportTurnReplaced`).
 *
 * **No turn** (delivery line design §9.1): an `ack` or `close` on a link is
 * stored `delivered` with reason `no-turn` (`add` with `noTurn`) and never
 * enqueued, so neither the queue nor the wake gate sees it. Its target reads
 * it at the head of its next outbox delivery (`noTurnLeadOf`: every such
 * note no delivery carried yet; `shownAt` once one was sent) and in its
 * `BM-STATE`.
 *
 * **Peer deliveries** (design §7.17.4): a `peer`, `peer-reply` or
 * `peer-message` record's target is resolved again at every attempt — the
 * first send and every resend — through the link's asker or answering agent
 * (`peerTargetOf`, which `peer-tools.ts` registers with `usePeerTargets`:
 * the outbox imports nothing of the links), so a replaced asker's successor
 * gets the reply. A changed target is written on the record before the send; no live
 * agent on that side drops the record. A peer record the queue drops (its
 * target was archived or replaced while the record waited) is resolved again,
 * at most `PEER_RETARGETS` times per delivery: a different live agent gets it
 * (the target written on the record first), else it is `dropped`. A delivered
 * peer record is handed to the hook `peer-tools.ts` registers beside the
 * resolver (a delivered `finished` `peer-reply` answers its link). Its
 * `requestId` may be a link id (the answering Manager's message on a link no
 * request took yet).
 *
 * **Records addressed to a Main** (missions design §3.4, "resolve at
 * delivery"): any other record whose `to` is, or was, the Main of its
 * request's mission (the mission's `mainId` or `mainHistory`, or the
 * request's registry `managerId`) goes to the mission's current Main, resolved
 * at every attempt and after a queue drop (`mainTargetOf`; at most
 * `PEER_RETARGETS` times per delivery), the new target written on the record
 * first. While the mission is open, such a record the queue drops with no
 * other Main to go to is never `dropped`: it stays `pending` (one log line),
 * and the mission's next Main gets it (`mission-replace.ts` delivers it again)
 * — a cleared conversation archives the old Main before its successor exists.
 *
 * **After a reload** (`createOutboxResend`): at the first hook or RPC with a
 * Paseo handle, every open record of every workspace — `pending` or `held` —
 * is enqueued again, through the wake gate.
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
import { DELIVERY_KINDS, OUTBOX_RECORD_ID_PATTERN, PEER_DELIVERY_KINDS, deliveryLineOf, type DeliveryKind } from "../shared/notices";
import { createAlertStore, type AlertInput } from "./alert-store";
import { redactText } from "./collector";
import { capBy, createJsonFileStore, entriesOf, type JsonFileStore } from "./data-files";
import { missionManagerOf, requestIndexOf } from "./mission-roster";
import { MISSION_ID_PATTERN, createMissionStore } from "./mission-store";
import { enqueueNotice, type ChannelQueue } from "./main-channel";
import { noticeQueue, type NoticeCallbacks, type NoticeOutcome, type NoticePaseo, type SteerResult } from "./notice-queue";
import { isOwnerWords, reportTurnReplaced } from "./owner-words";
import { createRequestRegistry } from "./request-registry";
import { errorText } from "./rpc-kit";
import { WORKSPACE_ID_PATTERN } from "./trace-store";
import { settleBatchWait } from "./waits";
import { holdsAtSend, isReleasing, releaseWait, wakeGate, type HeldItem } from "./wake-gate";
import type { WaitRef } from "../shared/waits";
import { timeOrZero } from "../shared/time";

/** The outbox's folder in the data folder (§16.7); the cleanup button deletes it (§7.13.7). */
export const OUTBOX_DIR_NAME = "outbox";
export const OUTBOX_VERSION = 1;
/** Delivered or dropped records kept per workspace (§16.7). */
export const OUTBOX_SETTLED_LIMIT = 500;
/** How long a delivered or dropped record is kept (§16.7): 7 days. */
export const OUTBOX_SETTLED_MS = 7 * 24 * 60 * 60 * 1000;

const OUTBOX_STATES = ["pending", "delivered", "dropped", "withheld", "held"] as const;

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
  /** Delivered past the wake gate (delivery line design §6.4): `bm_tell_worker` with `now: true`. Absent otherwise. */
  atOnce: z.literal(true).optional(),
  /** A record that started no turn (delivery line design §9.1): when a delivery to its target carried it at its head. Absent until then. */
  shownAt: z.string().optional(),
  /** The owner's words steered into the Worker's running turn (delivery line design §19.5): when. Absent otherwise. */
  steeredAt: z.string().optional(),
  /** Paseo replaced that running turn instead of steering the words in (§19.5). Absent otherwise. */
  replaced: z.literal(true).optional(),
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
  /** Past the wake gate (delivery line design §6.4): `bm_tell_worker` with `now: true`. */
  atOnce?: boolean;
  /**
   * Starts no turn (delivery line design §9.1: an `ack` or a `close`): stored
   * `delivered` with reason `no-turn`, never enqueued; its target reads it at
   * the head of its next delivery (`noTurnLeadOf`).
   */
  noTurn?: boolean;
}

/** The reason a record that starts no turn is stored with (delivery line design §9.1). */
export const NO_TURN_REASON = "no-turn";
/** The most no-turn notes one delivery carries at its head; the newest are kept. */
export const MAX_NO_TURN_NOTES = 5;

interface OutboxFile {
  records: OutboxRecord[];
}

/** True for a record still to be delivered: `pending`, or `held` by the wake gate. */
export function isOpenRecord(record: Pick<OutboxRecord, "state">): boolean {
  return record.state === "pending" || record.state === "held";
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
   * settled `withheld` for that reason, which nothing delivers. A `review` or
   * `no-verdict` record settles the wait on its batch (`settleBatchWait`,
   * delivery line design §6.3). Throws when the file cannot be written.
   */
  add(workspaceId: string, init: OutboxInit, withheld?: string): OutboxRecord;
  /**
   * Settles an open record as `delivered` or `dropped` (a settled record
   * never changes); returns the record as it is now, or null when there is
   * none. `reason` is kept for `dropped`. Throws when the file cannot be written.
   */
  settle(workspaceId: string, id: string, state: "delivered" | "dropped", reason?: string | null): { record: OutboxRecord; changed: boolean } | null;
  /** Writes a new target on a `pending` record (§7.17.4); returns it as it is now, or null when there is none. Throws when the file cannot be written. */
  retarget(workspaceId: string, id: string, to: string): OutboxRecord | null;
  /**
   * Moves an open record to `held` (`held` true) or back to `pending`
   * (delivery line design §6.4); a settled record never changes. Returns it as
   * it is now, or null when there is none. Throws when the file cannot be written.
   */
  hold(workspaceId: string, id: string, held: boolean): OutboxRecord | null;
  /** The workspaces with an outbox file. Never throws. */
  workspaces(): string[];
  /** Notes that a delivery carried the no-turn record `id` at its head (delivery line design §9.1). Throws when the file cannot be written. */
  markShown(workspaceId: string, id: string, at: string): void;
  /** Notes that record `id` was steered into its target's running turn at `at`, and whether Paseo replaced that turn (§19.5). Throws when the file cannot be written. */
  markSteered(workspaceId: string, id: string, at: string, replaced: boolean): void;
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
          // Delivery line design §9.1: a record that starts no turn is delivered as it is stored.
          state: withheld !== undefined ? "withheld" : init.noTurn === true ? "delivered" : "pending",
          outcomeAt: withheld === undefined && init.noTurn !== true ? null : at,
          reason: withheld ?? (init.noTurn === true ? NO_TURN_REASON : null),
          ...(init.atOnce === true ? { atOnce: true } : {}),
        });
        return { records: [...current.records, made] };
      });
      // Delivery line design §6.3: a review or no-verdict of a batch settles the wait that names it.
      settleBatchWait(home, workspaceId, made!);
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
    retarget(workspaceId, id, to) {
      requireWorkspace(workspaceId);
      let result: OutboxRecord | null = null;
      fileOf(workspaceId).update((current) => {
        const index = current.records.findIndex((record) => record.id === id);
        if (index === -1) return null;
        const found = current.records[index]!;
        result = isOpenRecord(found) && found.to !== to ? { ...found, to } : found;
        return result === found ? null : { records: current.records.map((record, at) => (at === index ? result! : record)) };
      });
      return result;
    },
    hold(workspaceId, id, held) {
      requireWorkspace(workspaceId);
      let result: OutboxRecord | null = null;
      fileOf(workspaceId).update((current) => {
        const index = current.records.findIndex((record) => record.id === id);
        if (index === -1) return null;
        const found = current.records[index]!;
        const state = held ? "held" : "pending";
        result = isOpenRecord(found) && found.state !== state ? { ...found, state } : found;
        return result === found ? null : { records: current.records.map((record, at) => (at === index ? result! : record)) };
      });
      return result;
    },
    markShown(workspaceId, id, at) {
      requireWorkspace(workspaceId);
      fileOf(workspaceId).update((current) => {
        const index = current.records.findIndex((record) => record.id === id);
        if (index === -1 || current.records[index]!.shownAt !== undefined) return null;
        return { records: current.records.map((record, place) => (place === index ? { ...record, shownAt: at } : record)) };
      });
    },
    markSteered(workspaceId, id, at, replaced) {
      requireWorkspace(workspaceId);
      fileOf(workspaceId).update((current) => {
        const index = current.records.findIndex((record) => record.id === id);
        if (index === -1 || current.records[index]!.steeredAt !== undefined) return null;
        const steered = (record: OutboxRecord): OutboxRecord => ({ ...record, steeredAt: at, ...(replaced ? { replaced: true as const } : {}) });
        return { records: current.records.map((record, place) => (place === index ? steered(record) : record)) };
      });
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

/** What a delivery says: `BM-DELIVERY <kind> <recordId>`, then `lead` when given, then the record's text. */
export function deliveryTextOf(record: Pick<OutboxRecord, "kind" | "id" | "text">, lead: string | null = null): string {
  return `${deliveryLineOf(record.kind, record.id)}\n${lead === null ? "" : `${lead}\n`}${record.text}`;
}

/**
 * The line a `finished` or `stopped` report's delivery gains once its request
 * has a continuation (delivery line design §2.7): `continued: <new> by Worker
 * <id> (<reason>: <figure>)`; null otherwise. Never throws.
 */
export function continuedLineOf(home: string, workspaceId: string, record: Pick<OutboxRecord, "kind" | "requestId" | "text">): string | null {
  if (record.kind !== "report" || !/^phase: (?:finished|stopped)$/m.test(record.text)) return null;
  try {
    const registry = createRequestRegistry(home, { log: () => {} });
    const request = registry.get(workspaceId, record.requestId);
    if (request?.continuedBy === undefined || request.rollover === undefined) return null;
    const workerId = registry.get(workspaceId, request.continuedBy)?.workerIds[0] ?? "unknown";
    return `continued: ${request.continuedBy} by Worker ${workerId} (${request.rollover.reason}: ${request.rollover.figure})`;
  } catch {
    return null;
  }
}

/** True for a record stored as starting no turn (delivery line design §9.1). Pure. */
export function isNoTurnRecord(record: Pick<OutboxRecord, "state" | "reason">): boolean {
  return record.state === "delivered" && record.reason === NO_TURN_REASON;
}

/** The note a no-turn record leaves at the head of its target's next delivery: `noted: <link> from <agent> (act: ack · refs: …): <gist>`. Pure. */
export function noTurnNoteOf(record: Pick<OutboxRecord, "from" | "text">): string {
  const link = /^link: (\S+)$/m.exec(record.text)?.[1] ?? "a link";
  const header = /^(act: .+)$/m.exec(record.text)?.[1] ?? "act: ack";
  const quote = record.text
    .split("\n")
    .filter((line) => line.startsWith(">"))
    .map((line) => line.replace(/^>\s?/, ""))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  const gist = quote.length <= 200 ? quote : `${quote.slice(0, 199)}…`;
  return `noted: ${link} from ${record.from} (${header})${gist === "" ? "" : `: ${gist}`}`;
}

/** The notes the next delivery to a target opens with (delivery line design §9.1), and the records they come from. */
export interface NoTurnLead {
  /** The note lines, oldest first, at most `MAX_NO_TURN_NOTES`. */
  text: string;
  /** Every record not shown yet: marked shown once the delivery is sent. */
  records: Array<{ workspaceId: string; id: string }>;
}

/**
 * What the next delivery to `targetId` opens with (delivery line design
 * §9.1): one note per record that started no turn for it and no delivery
 * carried yet, oldest first, at most `MAX_NO_TURN_NOTES` (the newest). Null
 * when none. Never throws.
 */
export function noTurnLeadOf(home: string, targetId: string): NoTurnLead | null {
  try {
    const outbox = createOutbox(home);
    const notes: Array<{ workspaceId: string; record: OutboxRecord }> = [];
    for (const workspaceId of outbox.workspaces()) {
      for (const record of outbox.list(workspaceId)) {
        if (record.to === targetId && isNoTurnRecord(record) && record.shownAt === undefined) notes.push({ workspaceId, record });
      }
    }
    if (notes.length === 0) return null;
    notes.sort((a, b) => a.record.createdAt.localeCompare(b.record.createdAt));
    return {
      text: notes.slice(-MAX_NO_TURN_NOTES).map((note) => noTurnNoteOf(note.record)).join("\n"),
      records: notes.map((note) => ({ workspaceId: note.workspaceId, id: note.record.id })),
    };
  } catch {
    return null;
  }
}

/** Marks the records of `lead` shown (delivery line design §9.1). A failure is one log line: the note is shown again. */
function markLeadShown(home: string, lead: NoTurnLead | null, now: () => Date, log: (message: string) => void): void {
  if (lead === null) return;
  const outbox = createOutbox(home, { now });
  const at = now().toISOString();
  for (const { workspaceId, id } of lead.records) {
    try {
      outbox.markShown(workspaceId, id, at);
    } catch (error) {
      log(`[paseo-bm] could not note that the ${id} was shown: ${errorText(error)}`);
    }
  }
}

/** The notice-queue kind of a record: its own, so no record ever replaces another. */
export function deliveryKindOf(record: Pick<OutboxRecord, "kind" | "id">): string {
  return `${record.kind}:${record.id}`;
}

/** Who a peer record goes to now (§7.17.4): an agent id, null for none left, undefined to keep the stored target. */
export type PeerTargetResolver = (workspaceId: string, record: OutboxRecord, home: string, paseo: unknown) => Promise<string | null | undefined>;

/** What a peer record that just reached its target does to its link (§7.17.1); a throw is one log line. */
export type PeerDeliveredHook = (workspaceId: string, record: OutboxRecord, home: string, now: () => Date) => void;

/** The most times one delivery of a peer record the queue dropped resolves its target again (§7.17.4). */
export const PEER_RETARGETS = 2;

/** The resolver and the delivered hook `deliverRecord` uses for the peer kinds; `peer-tools.ts` registers them when it loads. */
const peerTargets: { resolve: PeerTargetResolver | null; delivered: PeerDeliveredHook | null } = { resolve: null, delivered: null };

/** Registers who peer records go to, and what a delivered one does (`peer-tools.ts`, at load). */
export function usePeerTargets(resolve: PeerTargetResolver, delivered: PeerDeliveredHook | null = null): void {
  peerTargets.resolve = resolve;
  peerTargets.delivered = delivered;
}

/** The mission a record of no request names by its `requestId` (`tellMain`): an `m:<missionId>:<n>` card, or the mission id itself; else null. */
function missionOfReference(requestId: string): string | null {
  const named = requestId.startsWith("m:") ? (requestId.split(":")[1] ?? "") : requestId;
  return MISSION_ID_PATTERN.test(named) ? named : null;
}

/**
 * Who a record addressed to a Main goes to now (missions design §3.4): the
 * current Main of its request's mission — or of the mission its `requestId`
 * names (`tellMain`'s `m:` card or mission id) — and whether the mission is
 * open (`hold`: a drop keeps it pending); null for a record of no mission, or
 * one whose `to` was never that mission's Main (a Worker, a Reviewer). Never throws.
 */
export function mainTargetOf(home: string, workspaceId: string, record: Pick<OutboxRecord, "requestId" | "to">): { to: string; hold: boolean } | null {
  try {
    const named = missionOfReference(record.requestId);
    const request = named === null ? createRequestRegistry(home).get(workspaceId, record.requestId) : null;
    const missionId = named ?? request?.missionId ?? requestIndexOf(home, record.requestId)?.missionId ?? null;
    const mission = missionId === null ? null : createMissionStore(home).get(missionId);
    if (mission === null) return null;
    const mains = new Set([...mission.mainHistory.map((entry) => entry.agentId), mission.mainId, request?.managerId ?? null]);
    if (!mains.has(record.to)) return null;
    return { to: mission.mainId ?? record.to, hold: mission.state === "open" };
  } catch {
    return null;
  }
}

export interface OutboxDeliveryDeps extends OutboxDeps {
  /** The data folder. */
  home: string;
  /** The notice queue; the plugin's shared one by default. */
  queue?: ChannelQueue;
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
 * Records a record's outcome (§16.7 step 3): `delivered` hands a peer record
 * to the delivered hook and clears what it covers of the request's drops;
 * `dropped` costs one log line and raises the `delivery-dropped` alert. A
 * failure is one log line.
 */
function recordOutcome(workspaceId: string, record: OutboxRecord, state: "delivered" | "dropped", reason: string | null, deps: OutboxDeliveryDeps): void {
  const log = deps.log ?? ((message: string) => console.warn(message));
  try {
    const result = createOutbox(deps.home, deps).settle(workspaceId, record.id, state, reason);
    if (result === null || !result.changed) return;
    if (state === "delivered") {
      if ((PEER_DELIVERY_KINDS as readonly string[]).includes(record.kind) && peerTargets.delivered !== null) {
        try {
          peerTargets.delivered(workspaceId, result.record, deps.home, deps.now ?? (() => new Date()));
        } catch (error) {
          log(`[paseo-bm] after delivering the ${record.kind} ${record.id}: ${errorText(error)}`);
        }
      }
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
}

/** What a delivery came to: the queue's outcome, or `held` by the wake gate (delivery line design §6.4). */
export type RecordOutcome = NoticeOutcome | "held";

/** The wait items a record settles as it is delivered (delivery line design §6.3): a review's or no-verdict's batch. */
function waitRefsOfRecord(record: OutboxRecord): WaitRef[] {
  return (record.kind === "review" || record.kind === "no-verdict") && record.batchId !== null ? [{ kind: "batch", id: record.batchId }] : [];
}

/** The Workers a handoff or a fallback replaced on `target`'s request: every one of its `workerIds` but the newest. Never throws. */
function replacedWorkersOf(home: string, target: { workspaceId?: string; requestId?: string; workerId: string }): Set<string> {
  if (target.workspaceId === undefined || target.requestId === undefined) return new Set();
  try {
    const ids = createRequestRegistry(home).get(target.workspaceId, target.requestId)?.workerIds ?? [];
    return new Set(ids.at(-1) === target.workerId ? ids.slice(0, -1) : []);
  } catch {
    return new Set();
  }
}

/**
 * The records held for a Worker (delivery line design §6.4), in every
 * workspace's outbox, as its release takes them: each goes back to `pending`
 * when released, and records its outcome as any delivery does. A record of
 * its request held for a Worker it replaced (a handoff) is its own now: it
 * is addressed to it when released. Never throws.
 */
export function heldRecordItems(home: string, target: { workspaceId?: string; requestId?: string; workerId: string }, now: () => Date = () => new Date()): HeldItem[] {
  const outbox = createOutbox(home, { now });
  const replaced = replacedWorkersOf(home, target);
  const out: HeldItem[] = [];
  for (const workspaceId of outbox.workspaces()) {
    for (const record of outbox.list(workspaceId)) {
      if (record.state !== "held") continue;
      const inherited = record.to !== target.workerId && record.requestId === target.requestId && replaced.has(record.to);
      if (record.to !== target.workerId && !inherited) continue;
      const deps: OutboxDeliveryDeps = { home, now };
      out.push({
        key: deliveryKindOf(record),
        block: deliveryTextOf(record),
        at: record.createdAt,
        release: () => {
          if (inherited) outbox.retarget(workspaceId, record.id, target.workerId);
          outbox.hold(workspaceId, record.id, false);
        },
        refs: waitRefsOfRecord(record),
        callbacks: {
          onSent: () => recordOutcome(workspaceId, record, "delivered", null, deps),
          onDropped: (_targetId, _kind, reason) => recordOutcome(workspaceId, record, "dropped", reason, deps),
          onHeld: () => void outbox.hold(workspaceId, record.id, true),
        },
      });
    }
  }
  return out;
}

/**
 * Hands one record to the notice queue; the queue's callbacks record its
 * outcome (§16.7 steps 2–3). A peer record the queue drops is resolved again
 * (§7.17.4, `PEER_RETARGETS`); the outcome returned is the last attempt's when
 * the drop came during the call. Before the send, the wake gate (delivery
 * line design §6.4): a record it holds is `held` (the outcome `held`); one
 * that meets the Worker's wait goes in its release, first. A record handed to
 * a release not yet sent is not sent again (`queued`). Never rejects: a
 * store failure is one log line, and the record stays as it was, to be sent
 * again after a reload.
 */
export async function deliverRecord(workspaceId: string, given: OutboxRecord, deps: OutboxDeliveryDeps): Promise<RecordOutcome> {
  const log = deps.log ?? ((message: string) => console.warn(message));
  const queue = deps.queue ?? noticeQueue;
  let record = given;
  // Delivery line design §2.7: a report whose request goes on as a continuation names it.
  const continuedLine = continuedLineOf(deps.home, workspaceId, given);
  /** What the delivery opens with: the notes that started no turn for its target (§9.1), then the continuation line. */
  let lead = continuedLine;
  const isPeer = (PEER_DELIVERY_KINDS as readonly string[]).includes(record.kind);

  const settle = (state: "delivered" | "dropped", reason: string | null = null): void => recordOutcome(workspaceId, record, state, reason, deps);

  const resolve = peerTargets.resolve;
  const paseo = deps.paseo;
  /** The link's side now (§7.17.4); a failed lookup keeps the stored target. Null when peer records are not resolved here. */
  const peerTarget =
    resolve !== null && isPeer && paseo !== undefined ? (): Promise<string | null | undefined> => resolve(workspaceId, record, deps.home, paseo).catch(() => undefined) : null;

  /** The mission's current Main for a record addressed to a Main (§3.4); null for any other record and every peer kind. */
  const mainTarget = isPeer ? null : () => mainTargetOf(deps.home, workspaceId, record);

  /** Writes a new target on the record before its send; false when the stored record is settled already (nothing to send). */
  const retarget = (to: string): boolean => {
    try {
      const now = createOutbox(deps.home, deps).retarget(workspaceId, record.id, to);
      if (now !== null && !isOpenRecord(now)) return false;
      record = now ?? { ...record, to };
    } catch (error) {
      log(`[paseo-bm] could not write the new target of the ${record.kind} ${record.id}: ${errorText(error)}`);
      record = { ...record, to };
    }
    return true;
  };

  /** Writes `held` or `pending` on the record; false when the store cannot be written. */
  const hold = (held: boolean): boolean => {
    try {
      createOutbox(deps.home, deps).hold(workspaceId, record.id, held);
      return true;
    } catch (error) {
      log(`[paseo-bm] could not mark the ${record.kind} ${record.id} ${held ? "held" : "pending"}: ${errorText(error)}`);
      return false;
    }
  };
  /** The wake gate's kind for this record: a tell with `now: true` is always at once. */
  const gateKind = record.atOnce === true ? "tell-now" : record.kind;
  /** Delivery line design §19.5: the owner's words go into the Worker's running turn when the queue's guards hold. */
  const steer = isOwnerWords({ via: "tell", now: record.kind === "message" && record.atOnce === true });
  /** The steer is written on the record; a replaced turn is told to the Main and the owner's Inbox. */
  const steered = (result: SteerResult): void => {
    try {
      // The outbox's own clock, as every other time on the record.
      createOutbox(deps.home, deps).markSteered(workspaceId, record.id, (deps.now ?? (() => new Date()))().toISOString(), result.replaced);
    } catch (error) {
      log(`[paseo-bm] could not note that the ${record.kind} ${record.id} was steered: ${errorText(error)}`);
    }
    if (!result.replaced) return;
    void reportTurnReplaced({
      home: deps.home,
      workspaceId,
      workerId: record.to,
      requestId: record.requestId,
      mainId: missionManagerOf(deps.home, record.requestId) ?? record.from,
      what: `the owner's words (${record.kind} ${record.id})`,
      turnBefore: result.turnBefore,
      turnAfter: result.turnAfter,
      ...(deps.paseo === undefined ? {} : { paseo: deps.paseo }),
      ...(deps.queue === undefined ? {} : { queue: deps.queue }),
      ...(deps.now === undefined ? {} : { now: deps.now }),
      log,
    });
  };
  const gateDeps = { ...(deps.now === undefined ? {} : { now: deps.now }), log };

  /** One enqueue of the record as it is now. Never rejects. */
  const attempt = async (retargets: number): Promise<RecordOutcome> => {
    const told = { any: false, held: false, again: null as Promise<RecordOutcome> | null };
    try {
      // A mission's Main gets it on its channel (mission runtime design §6.2), with what else is pending for it.
      const callbacks: NoticeCallbacks = {
        onSent: () => {
          told.any = true;
          settle("delivered");
          shown();
        },
        onDropped: (_targetId, _kind, reason) => {
          told.any = true;
          told.again = dropped(reason, retargets);
        },
        // Delivery line design §6.4: the gate held it at the send (its Worker reported `blocked` meanwhile).
        onHeld: () => {
          told.any = true;
          told.held = hold(true);
          if (!told.held) log(`[paseo-bm] the ${record.kind} ${record.id} held at its send stays pending: it goes again after a reload.`);
        },
        ...(steer ? { onSteered: (_targetId: string, _kind: string, result: SteerResult) => steered(result) } : {}),
      };
      const isHeld = holdsAtSend(deps.home, record.to, gateKind, waitRefsOfRecord(record), { workspaceId, requestId: record.requestId }, gateDeps);
      const outcome = await enqueueNotice({ home: deps.home, queue, targetId: record.to, kind: deliveryKindOf(record), text: deliveryTextOf(record, lead), ...(deps.paseo === undefined ? {} : { paseo: deps.paseo }), callbacks, isHeld, ...(steer ? { steer: true } : {}) });
      if (told.held) return "held";
      // A drop during this call that sent the record on: its outcome is this delivery's.
      if (told.again !== null) return await told.again;
      // An input the queue refuses outright calls no callback; `queued` and `replaced` settle later.
      if (outcome === "dropped" && !told.any) settle("dropped", "the notice queue refused it");
      return outcome;
    } catch (error) {
      log(`[paseo-bm] could not deliver the ${record.kind} ${record.id}: ${errorText(error)}`);
      return "dropped";
    }
  };

  /**
   * The queue dropped the record. A peer record's side is resolved again (at
   * most `PEER_RETARGETS` times): a different live agent gets it; else, and
   * for every other kind, it is `dropped`. Null when settled here.
   */
  const dropped = (reason: string, retargets: number): Promise<RecordOutcome> | null => {
    const main = mainTarget?.() ?? null;
    if (main !== null) {
      // §3.4: the mission's Main now, else held for its next Main while the mission is open.
      if (main.to !== record.to && retargets < PEER_RETARGETS) return retarget(main.to) ? attempt(retargets + 1) : Promise.resolve("dropped");
      if (main.hold) {
        log(`[paseo-bm] the ${record.kind} ${record.id} of request ${record.requestId} to the Main ${record.to} was not delivered (${reason}); it waits for the mission's next Main.`);
        return Promise.resolve("queued");
      }
    }
    if (peerTarget === null || retargets >= PEER_RETARGETS) {
      settle("dropped", reason);
      return null;
    }
    return (async (): Promise<RecordOutcome> => {
      const to = await peerTarget();
      if (typeof to !== "string" || to === record.to) {
        settle("dropped", reason);
        return "dropped";
      }
      return retarget(to) ? attempt(retargets + 1) : "dropped";
    })();
  };

  if (peerTarget !== null) {
    // §7.17.4: the link's side is resolved again at every attempt.
    const to = await peerTarget();
    if (to === null) {
      settle("dropped", "no live agent is left on the link's other side");
      return "dropped";
    }
    if (to !== undefined && to !== record.to) retarget(to);
  }
  // §3.4: a record addressed to a Main goes to the mission's Main now.
  const main = mainTarget?.() ?? null;
  if (main !== null && main.to !== record.to) retarget(main.to);
  // Delivery line design §9.1: what reached the target without a turn heads this delivery, and is shown once it is sent.
  const notes = noTurnLeadOf(deps.home, record.to);
  if (notes !== null) lead = continuedLine === null ? notes.text : `${notes.text}\n${continuedLine}`;
  const shown = (): void => markLeadShown(deps.home, notes, deps.now ?? (() => new Date()), log);
  // Delivery line design §6.4: the wake gate, for the target as resolved now.
  const key = deliveryKindOf(record);
  if (isReleasing(record.to, key)) return "queued";
  const gate = wakeGate(deps.home, record.to, gateKind, waitRefsOfRecord(record), { workspaceId, requestId: record.requestId }, gateDeps);
  // A record the store cannot hold is delivered.
  if (gate.action === "hold") return hold(true) ? "held" : attempt(0);
  if (record.state === "held") hold(false);
  if (gate.release !== null) {
    const callbacks: NoticeCallbacks = {
      onSent: () => {
        settle("delivered");
        shown();
      },
      onDropped: (_targetId, _kind, reason) => settle("dropped", reason),
      onHeld: () => void hold(true),
    };
    const outcome = await releaseWait(gate.release, { key, block: deliveryTextOf(record, lead), settles: gate.settles, refs: waitRefsOfRecord(record), callbacks }, deps);
    return outcome ?? "dropped";
  }
  return attempt(0);
}

/**
 * Stores `init` as a `pending` record, runs `before` once it is stored and
 * waits for it (a throw there is one log line: the record is delivered all
 * the same), then
 * delivers it (§16.7). Returns the record as stored and the queue's outcome.
 * Throws only when the record cannot be written — nothing is sent then.
 */
export async function storeAndDeliver(
  workspaceId: string,
  init: OutboxInit,
  deps: OutboxDeliveryDeps,
  before: (record: OutboxRecord) => void | Promise<void> = () => {},
): Promise<{ record: OutboxRecord; outcome: RecordOutcome }> {
  const record = createOutbox(deps.home, deps).add(workspaceId, init);
  try {
    await before(record);
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

/** The `phase:` of a report block, or null. Pure. */
export function reportPhaseOf(text: string): string | null {
  return /^phase:[ \t]*(\S+)/m.exec(text)?.[1] ?? null;
}

/**
 * How far a phase is along, for two reports created in the same second
 * (missions acceptance, 2026-10-09: `received` and `finished` in one turn):
 * `stopped` and `finished` > `blocked` > the working phases > `received`.
 */
function phaseRank(phase: string | null): number {
  switch (phase) {
    case "finished":
    case "stopped":
      return 3;
    case "blocked":
      return 2;
    case "documents-done":
    case "beads-done":
    case "bead-implemented":
      return 1;
    default:
      return 0;
  }
}

/**
 * The newest `report` record of `agentId` that is `pending` or `delivered`
 * (§16.7: how `compaction.ts` reads a bound agent's reports), created at or
 * after `since` when given. Newest is by `createdAt`, ties broken by the
 * phase's rank (`phaseRank`), then by the file's order: the file's order alone
 * is not the order of creation. Never throws.
 */
export function newestReportRecordOf(home: string, workspaceId: string, agentId: string, since: string | null = null): OutboxRecord | null {
  const lower = since === null ? Number.NEGATIVE_INFINITY : timeOrZero(since);
  let newest: OutboxRecord | null = null;
  for (const record of createOutbox(home).list(workspaceId)) {
    if (record.from !== agentId || record.kind !== "report" || (record.state !== "pending" && record.state !== "delivered")) continue;
    const at = timeOrZero(record.createdAt);
    if (at < lower) continue;
    if (newest !== null) {
      const best = timeOrZero(newest.createdAt);
      if (at < best || (at === best && phaseRank(reportPhaseOf(record.text)) < phaseRank(reportPhaseOf(newest.text)))) continue;
    }
    newest = record;
  }
  return newest;
}
