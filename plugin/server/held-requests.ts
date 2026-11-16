/**
 * The held queue (delivery line design §19.6, ADR-038 decision 5): work a
 * Main gave with `bm_create_worker` `after`, waiting for requests of its
 * mission to finish, kept by paseo-bm rather than in the Main's memory.
 *
 * `<data folder>/missions/<missionId>.held.json` =
 * `{ schemaVersion: 1, entries: [{ holdId, after, input, by, at, state, startedAs?, note? }] }`.
 *
 * - **Held:** the `bm_create_worker` input as the Main gave it, without
 *   `after`. Its id is `hold-<time>`: no request id until its Worker exists.
 * - **Started** (`startHeldRequests`, at the governor's pass, about each
 *   minute): when every id of `after` reads `passed` (`holdStateOf`), the
 *   Worker is created through `bm_create_worker` as the mission's Main, so
 *   staffing, lanes and the brief apply as for any request. The Main is told.
 * - **Reading `after`** (mission line plan §5.8): a hold id through its
 *   `startedAs`, a request id at the head of its chain, then that head's
 *   stored finish gate. A `gated` head with no result fails; only a head
 *   without the stamp, from before this build, reads as passed.
 * - **A step list** (ADR-045 decision 1): `proposeLine` stores `proposed`
 *   entries, which no pass reads; the owner's apply (`applyLine`) makes them
 *   `held`, each step after the previous one and the first on the slot alone,
 *   so an unrelated failing request cannot stop an approved line; "keep as
 *   is" cancels them (`dropLine`).
 * - **One at a time** (mission line plan §5.8): the pass takes due entries
 *   that are not steps first, oldest first, then steps, oldest first; a due
 *   entry waits silently while a sequential request runs. A `next` entry has
 *   an empty `after`, so it is due as soon as the slot is free. A slot Paseo's
 *   agent list cannot show is held, never free: the entry stays as it is.
 * - **Stops** (mission line plan §5.8, ADR-045 decision 2): a failed gate, a
 *   stopped request, a cancelled entry, an active head with an open
 *   `request-stalled` alert, an active head with no unarchived Worker, or one
 *   idle past the stall window with no alert and no live turn, which the stall
 *   watcher no longer looks at (an abandoned request). A held
 *   entry with one is `waiting-stopped`, its reasons in `note`; a stop that no
 *   longer holds returns it to `held`. A due entry whose slot is held by a
 *   stalled head stops with it. A `started` step stays `started`, whatever
 *   stops it: its stop is `toldKey` and `stopNote`, it is never created again,
 *   and it clears through a continuation or `bm_hold_cancel`.
 * - **A stall stop** ends only when the head has new activity
 *   (`progressSinceOf`, since the time in `toldKey`) or has ended: the stall
 *   watcher clearing the alert after its 24-hour window does not end it.
 * - **One notice per distinct failure,** by its key (`stopKeyOf`), across the
 *   mission's entries: what stops two entries is one failure. It says what the
 *   Main can do, never to create the Worker again, which would duplicate it.
 *   A notice that comes back dropped forgets its key (`forgetTold`), so a later
 *   pass tells it again; so does a release or a cancel, each for one entry,
 *   so that what else the failure stops, now or later, never waits unseen.
 * - **A passing line costs no Main turn** (ADR-045 decision 2): a step's start
 *   is a no-turn note, and `bm_report` stores the `finished` of a step with a
 *   next step (`lineStepOf`) as one; every notice here opens with those notes.
 * - **The result travels** (ADR-045 decision 3): a step that starts gets, in
 *   the context it is created with, the previous step's commit and branch,
 *   summary, contract and what it left, read at that moment. The stored entry
 *   keeps only what was written when it was held.
 * - **Released:** the Main's `bm_hold_release` on the owner's word. A released
 *   entry starts past the gate, the slot and the staffing rule's
 *   one-live-Worker line; the budget cap holds.
 * - **Cancelled:** the Main's `bm_hold_cancel`.
 * - **The owner's switch** (`line.supervised` off, ADR-045, The switch): a head
 *   satisfies `after` at `finished` alone, no gate, stall or no-Worker stop is
 *   read, and the pass does not wait for the slot. A stopped request and a
 *   cancelled entry still stop.
 *
 * Bounded: at most `MAX_HELD` waiting entries a mission; the newest
 * `MAX_SETTLED_HELD` settled ones are kept. Never throws to its callers.
 */
import { join } from "node:path";
import { z } from "zod";
import type { ToolCaller } from "./agent-bindings";
import { createAlertStore } from "./alert-store";
import { lineSupervisedOf } from "./coordination-store";
import { capBy, createJsonFileStore, entriesOf, type JsonFileStore } from "./data-files";
import { TRACES_DIR_NAME } from "./data-home";
import { enqueueNotice, type ChannelQueue } from "./main-channel";
import { createMissionRoster, requestIndexOf, runningRequestsOf, type RosterEntry } from "./mission-roster";
import { MISSIONS_DIR_NAME, createMissionStore, journalQuietly } from "./mission-store";
import type { NoticePaseo } from "./notice-queue";
import { createOutbox, markLeadShown, noTurnLeadOf } from "./outbox";
import { bmAgentsOf, type DashboardPaseo } from "./paseo-directory";
import { workspaceTracesOf } from "./request-trace";
import { errorText } from "./rpc-kit";
import { STALL_WINDOW_MS, progressSinceOf } from "./stall-watcher";
import { readRecords } from "./trace-store";
import { chainHeadOf, chainOf } from "./waits";
import { alertKeyOf } from "../shared/alerts";
import { shorten } from "../shared/text";
import { timeOrZero } from "../shared/time";

export const HELD_VERSION = 1;
/** The most waiting entries a mission holds. */
export const MAX_HELD = 30;
/** The settled entries kept, the newest. */
export const MAX_SETTLED_HELD = 50;
export const HOLD_ID_PATTERN = /^hold-\d{8}T\d{6,9}Z$/;

/** Where an approved step sits in its line (ADR-045 decision 1). */
const stepSchema = z.object({ lineId: z.string(), n: z.number().int(), of: z.number().int(), title: z.string(), acceptance: z.array(z.string()) });

const entrySchema = z.object({
  holdId: z.string().regex(HOLD_ID_PATTERN),
  /** Empty for `next` work and a line's first step: the sequential slot orders those. */
  after: z.array(z.string()),
  input: z.record(z.string(), z.unknown()),
  topic: z.string(),
  by: z.string(),
  at: z.string(),
  state: z.enum(["proposed", "held", "waiting-stopped", "started", "cancelled"]),
  startedAs: z.string().optional(),
  note: z.string().optional(),
  settledAt: z.string().optional(),
  /** New work the Main held to run next, on no request's result. */
  next: z.literal(true).optional(),
  step: stepSchema.optional(),
  /** Let through by `bm_hold_release`, on the owner's word. */
  released: z.literal(true).optional(),
  /** The distinct failure the Main was last told of (`stopKeyOf`). */
  toldKey: z.string().optional(),
  /** Why a `started` step cannot go on, while it cannot; it stays `started`. */
  stopNote: z.string().optional(),
});

export type HeldRequest = z.infer<typeof entrySchema>;

export const isSettled = (entry: HeldRequest) => entry.state === "started" || entry.state === "cancelled";
const isOpen = (entry: HeldRequest): boolean => entry.state === "held" || entry.state === "waiting-stopped";

function fileOf(home: string, missionId: string): JsonFileStore<{ entries: HeldRequest[] }> {
  return createJsonFileStore<{ entries: HeldRequest[] }>({
    home,
    dir: MISSIONS_DIR_NAME,
    file: `${missionId}.held.json`,
    version: HELD_VERSION,
    versionKey: "schemaVersion",
    parse: (body) => ({ entries: entriesOf(entrySchema, body["entries"]) }),
    empty: () => ({ entries: [] }),
    cap: ({ entries }) => {
      const settled = entries.flatMap((entry, index) => (isSettled(entry) ? [index] : []));
      const kept = new Set(capBy(settled, MAX_SETTLED_HELD, (index) => timeOrZero(entries[index]!.settledAt ?? entries[index]!.at)));
      return { entries: entries.filter((entry, index) => !isSettled(entry) || kept.has(index)) };
    },
    codes: { unwritable: "E_TRACE_STORE_UNWRITABLE" },
    keepUnusable: true,
    cached: true,
  });
}

/** A hold id at `now`: `hold-` and the compact UTC time. Pure. */
export const holdIdOf = (now: Date): string => `hold-${now.toISOString().replace(/[-:]/g, "").replace(/\.(\d{3})Z$/, "$1Z")}`;

/** The mission's held entries, oldest first (settled ones included). Never throws. */
export function heldRequestsOf(home: string, missionId: string): HeldRequest[] {
  try {
    return fileOf(home, missionId).read().entries;
  } catch {
    return [];
  }
}

/** Records a held request; refused past `MAX_HELD` waiting entries. Throws when the file cannot be written. */
export function holdRequest(home: string, missionId: string, init: Omit<HeldRequest, "holdId" | "at" | "state">, now: Date): { ok: true; entry: HeldRequest } | { ok: false; reason: string } {
  let result: { ok: true; entry: HeldRequest } | { ok: false; reason: string } = { ok: false, reason: "nothing was held" };
  fileOf(home, missionId).update((current) => {
    if (current.entries.filter((entry) => !isSettled(entry)).length >= MAX_HELD) {
      result = { ok: false, reason: `mission holds ${MAX_HELD} requests already; cancel one with bm_hold_cancel` };
      return null;
    }
    const taken = new Set(current.entries.map((entry) => entry.holdId));
    let at = now;
    while (taken.has(holdIdOf(at))) at = new Date(at.getTime() + 1);
    const entry = entrySchema.parse({ ...init, holdId: holdIdOf(at), at: now.toISOString(), state: "held" });
    result = { ok: true, entry };
    return { entries: [...current.entries, entry] };
  });
  return result;
}

/** One step a Main proposes (`bm_mission_update.steps`). */
export interface LineStepInput {
  title: string;
  request: string;
  acceptance: readonly string[];
  project?: string;
  context?: ReadonlyArray<{ fact: string; source: string }>;
}

/**
 * Stores `proposed` entries for `steps` in order, all of them or none (see the
 * module comment); refused past `MAX_HELD`. Each `input` is the
 * `bm_create_worker` input. Throws when the file cannot be written.
 */
export function proposeLine(home: string, missionId: string, line: { lineId: string; by: string; steps: readonly LineStepInput[] }, now: Date): { ok: true; entries: HeldRequest[] } | { ok: false; reason: string } {
  let result: { ok: true; entries: HeldRequest[] } | { ok: false; reason: string } = { ok: false, reason: "nothing was held" };
  fileOf(home, missionId).update((current) => {
    const waiting = current.entries.filter((entry) => !isSettled(entry)).length;
    if (waiting + line.steps.length > MAX_HELD) {
      result = { ok: false, reason: `mission holds ${waiting} requests and takes at most ${MAX_HELD}; cancel some with bm_hold_cancel` };
      return null;
    }
    const taken = new Set(current.entries.map((entry) => entry.holdId));
    let at = now;
    let previous: string | null = null;
    const entries = line.steps.map((step, index) => {
      while (taken.has(holdIdOf(at))) at = new Date(at.getTime() + 1);
      const holdId = holdIdOf(at);
      taken.add(holdId);
      const of = line.steps.length;
      const entry: HeldRequest = entrySchema.parse({
        holdId,
        after: previous === null ? [] : [previous],
        input: {
          request: `${step.request}\n\nAcceptance criteria:\n${step.acceptance.map((criterion) => `- ${criterion}`).join("\n")}`,
          context: [...(step.context ?? [])],
          planStep: `Step ${index + 1} of ${of}: ${step.title}`,
          ...(step.project === undefined ? {} : { project: step.project }),
        },
        topic: step.title,
        by: line.by,
        at: now.toISOString(),
        state: "proposed",
        step: { lineId: line.lineId, n: index + 1, of, title: step.title, acceptance: [...step.acceptance] },
      });
      previous = holdId;
      return entry;
    });
    result = { ok: true, entries };
    return { entries: [...current.entries, ...entries] };
  });
  return result;
}

/** Changes every `proposed` entry of `lineId`; how many. Throws when the file cannot be written. */
function changeLine(home: string, missionId: string, lineId: string, change: (entry: HeldRequest) => HeldRequest): number {
  let changed = 0;
  fileOf(home, missionId).update((current) => {
    const ours = (entry: HeldRequest) => entry.state === "proposed" && entry.step?.lineId === lineId;
    changed = current.entries.filter(ours).length;
    return changed === 0 ? null : { entries: current.entries.map((entry) => (ours(entry) ? change(entry) : entry)) };
  });
  return changed;
}

/** The owner's apply: the line's `proposed` entries become `held`. How many. Throws when the file cannot be written. */
export const applyLine = (home: string, missionId: string, lineId: string): number => changeLine(home, missionId, lineId, (entry) => ({ ...entry, state: "held" }));

/** The line's `proposed` entries are cancelled. How many. Throws when the file cannot be written. */
export const dropLine = (home: string, missionId: string, lineId: string, why: string, now: Date): number => changeLine(home, missionId, lineId, (entry) => ({ ...entry, state: "cancelled", note: why, settledAt: now.toISOString() }));

/** Changes one entry; false when it is not there or `change` keeps it. Never throws. */
function changeHeld(home: string, missionId: string, holdId: string, change: (entry: HeldRequest) => HeldRequest | null): boolean {
  let changed = false;
  try {
    fileOf(home, missionId).update((current) => {
      const at = current.entries.findIndex((entry) => entry.holdId === holdId);
      if (at === -1) return null;
      const next = change(current.entries[at]!);
      if (next === null) return null;
      changed = true;
      return { entries: current.entries.map((entry, index) => (index === at ? next : entry)) };
    });
  } catch {
    changed = false;
  }
  return changed;
}

/** `entry` without what a stop left on it. Pure. */
function withoutStop(entry: HeldRequest): HeldRequest {
  const rest = { ...entry };
  delete rest.note;
  delete rest.stopNote;
  return rest;
}

/** `entry` without the failure it was told of. Pure. */
function withoutTold(entry: HeldRequest): HeldRequest {
  const rest = { ...entry };
  delete rest.toldKey;
  return rest;
}

/** The failure `key` is told again at a later pass, for every entry that stands on it. Never throws. */
function forgetTold(home: string, missionId: string, key: string | undefined): void {
  if (key !== undefined) for (const { holdId, toldKey } of heldRequestsOf(home, missionId)) if (toldKey === key) changeHeld(home, missionId, holdId, withoutTold);
}

/** Cancels a held request, or a `started` step with a stop, whose Worker is left alone; why not, or null when done. Never throws. */
export function cancelHeld(home: string, missionId: string, holdId: string, why: string, now: Date): string | null {
  const found = heldRequestsOf(home, missionId).find((entry) => entry.holdId === holdId);
  if (found === undefined) return `no held request ${holdId} in this mission (bm_mission lists them)`;
  if (isSettled(found) && !(found.state === "started" && found.stopNote !== undefined)) return `held request ${holdId} is already ${found.state}`;
  changeHeld(home, missionId, holdId, (entry) => ({ ...withoutStop(entry), state: "cancelled", note: why, settledAt: now.toISOString() }));
  forgetTold(home, missionId, found.toldKey);
  return null;
}

/** Lets a `waiting-stopped` entry start at the next pass, past its stop (see the module comment); why not, or null when done. Never throws. */
export function releaseHeld(home: string, missionId: string, holdId: string): string | null {
  const found = heldRequestsOf(home, missionId).find((entry) => entry.holdId === holdId);
  if (found === undefined) return `no held request ${holdId} in this mission (bm_mission lists them)`;
  if (found.state !== "waiting-stopped") return `held request ${holdId} is ${found.state}, and only a waiting-stopped one is released`;
  if (!changeHeld(home, missionId, holdId, (entry) => (entry.state === "waiting-stopped" ? { ...withoutStop(entry), state: "held", released: true } : null))) return `held request ${holdId} could not be released: try again in a moment`;
  // The answer was for one entry, as a cancel is: whatever else this failure stops, now or later, is told again, or it would wait unseen.
  forgetTold(home, missionId, found.toldKey);
  return null;
}

/** What `after`, or one id of it, reads now (mission line plan §5.8); `at` is the stored gate's time, null when none was stored. */
export type HoldState =
  | { kind: "passed" }
  | { kind: "waiting" }
  | { kind: "stopped"; requestId: string }
  | { kind: "gate-failed"; requestId: string; reasons: string[]; at: string | null }
  | { kind: "stalled"; requestId: string; since: string }
  | { kind: "no-worker"; requestId: string };

type StopState = Exclude<HoldState, { kind: "passed" } | { kind: "waiting" }>;

/** What a pass knows beyond the stores. Absent, an active head stops only on its open alert. */
export interface StopFacts {
  /** The unarchived Workers Paseo listed at `at`, a resting one among them, and those in a live turn (`busy`); null when Paseo could not be read, and an active head then reads as waiting. */
  workers?: { ids: ReadonlySet<string>; busy?: ReadonlySet<string>; at: number } | null;
  /** The stall this entry was told of, while nothing has ended it. */
  toldStall?: { requestId: string; since: string } | null;
}

const isStop = (state: HoldState): state is StopState => state.kind !== "passed" && state.kind !== "waiting";


/** The open `request-stalled` alert's time for this request; null when none or when the store cannot be read. Never throws. */
function openStallSince(home: string, workspaceId: string, requestId: string): string | null {
  try {
    const alert = createAlertStore(home).get(alertKeyOf("request-stalled", workspaceId, requestId));
    return alert === null || alert.clearedAt !== null ? null : alert.since;
  } catch {
    return null;
  }
}

/**
 * When `head` last did anything, if none of its Workers is in a turn and that is past the stall window: the stall
 * watcher looks no further back, so an abandoned request would otherwise hold its slot in silence (mission line plan
 * §5.8). Records that cannot be read leave what the roster says. Null otherwise. Never throws.
 */
function idleSinceOf(home: string, head: RosterEntry, workspaceId: string, { busy, at }: NonNullable<StopFacts["workers"]>): string | null {
  let last = head.followUpAt ?? head.createdAt;
  const idle = () => at - timeOrZero(last) >= STALL_WINDOW_MS;
  if (busy === undefined || head.workerIds.some((id) => busy.has(id)) || !idle()) return null;
  try {
    for (const { agentId, endedAt } of readRecords({ tracesDir: join(home, TRACES_DIR_NAME) }, workspaceId).records) {
      if (head.workerIds.includes(agentId) && timeOrZero(endedAt) > timeOrZero(last)) last = endedAt;
    }
  } catch {
    // The roster's time stands.
  }
  return idle() ? last : null;
}

/** An `active` head of the roster: stalled, without a Worker, or at work. */
function activeHeadStateOf(home: string, head: RosterEntry, workspaceId: string, facts: StopFacts): HoldState {
  const workers = facts.workers ?? null;
  const since = openStallSince(home, workspaceId, head.requestId) ?? (facts.toldStall?.requestId === head.requestId ? facts.toldStall.since : null);
  // A request made after the list was read has a Worker the list cannot show.
  if (since === null && workers !== null && Date.parse(head.createdAt) < workers.at && !head.workerIds.some((id) => workers.ids.has(id))) return { kind: "no-worker", requestId: head.requestId };
  const stalled = since ?? (workers === null ? null : idleSinceOf(home, head, workspaceId, workers));
  return stalled === null ? { kind: "waiting" } : { kind: "stalled", requestId: head.requestId, since: stalled };
}

/** The head of `requestId`'s chain, read against its finish gate; with the owner's switch off, at `finished` alone. */
function headStateOf(home: string, missionId: string, requestId: string, facts: StopFacts = {}): HoldState {
  const head = chainHeadOf(home, requestId);
  const headId = head?.request.requestId ?? requestId;
  // A split may have moved the head to another mission: its roster entry is read where it lives.
  const entry = createMissionRoster(home).get(requestIndexOf(home, headId)?.missionId ?? missionId, headId);
  const state = entry?.state ?? null;
  if (state === "stopped") return { kind: "stopped", requestId: headId };
  const supervised = lineSupervisedOf(home);
  if (state === "active") return supervised ? activeHeadStateOf(home, entry!, head?.workspaceId ?? entry!.workspaceId, facts) : { kind: "waiting" };
  if (state !== "finished") return { kind: "waiting" };
  if (!supervised) return { kind: "passed" };
  if (head === null) return { kind: "gate-failed", requestId: headId, reasons: [`request ${headId} could not be read`], at: null };
  const gate = head.request.finishGate;
  if (gate !== undefined) return gate.passed ? { kind: "passed" } : { kind: "gate-failed", requestId: headId, reasons: gate.reasons, at: gate.at };
  return head.request.gated === true ? { kind: "gate-failed", requestId: headId, reasons: [`request ${headId} has no stored finish gate result`], at: null } : { kind: "passed" };
}

/** What one id of `after` reads now: a hold through its `startedAs`, a request at the head of its chain. Never throws. */
export function afterStateOf(home: string, missionId: string, id: string, facts: StopFacts = {}): HoldState {
  if (!HOLD_ID_PATTERN.test(id)) return headStateOf(home, missionId, id, facts);
  const held = heldRequestsOf(home, missionId).find((entry) => entry.holdId === id);
  if (held === undefined || held.state === "cancelled") return { kind: "stopped", requestId: id };
  if (held.state !== "started") return { kind: "waiting" };
  if (held.startedAs !== undefined) return headStateOf(home, missionId, held.startedAs, facts);
  return lineSupervisedOf(home) ? { kind: "gate-failed", requestId: id, reasons: [`held request ${id} started with no request id`], at: null } : { kind: "waiting" };
}

/** What a held request waits for now: the first stop of `after`, a stopped or failed head before a stalled or Worker-less one, else `waiting` while one is, else `passed`. Never throws. */
export function holdStateOf(home: string, missionId: string, entry: Pick<HeldRequest, "after">, facts: StopFacts = {}): HoldState {
  const states = entry.after.map((id) => afterStateOf(home, missionId, id, facts));
  const first = (kind: HoldState["kind"]) => states.find((state) => state.kind === kind);
  return first("stopped") ?? first("gate-failed") ?? first("stalled") ?? first("no-worker") ?? first("waiting") ?? { kind: "passed" };
}

/** A started entry whose head is active, stopped or not: its request is still at work. Never throws. */
function atWork(home: string, missionId: string, entry: HeldRequest): boolean {
  if (entry.state !== "started" || entry.startedAs === undefined) return false;
  const { kind } = headStateOf(home, missionId, entry.startedAs);
  return kind === "waiting" || kind === "stalled" || kind === "no-worker";
}

/** The live line of the mission: an entry still to run, or a started step whose head is at work; null when none. Never throws. */
export function liveLineOf(home: string, missionId: string): string | null {
  const live = heldRequestsOf(home, missionId).find((entry) => entry.step !== undefined && (entry.state === "proposed" || isOpen(entry) || atWork(home, missionId, entry)));
  return live?.step?.lineId ?? null;
}

/** Every step of the mission's live line, in order, for `bm_mission`; none when there is no live line. Never throws. */
export function liveLineStepsOf(home: string, missionId: string): Array<{ n: number; of: number; title: string; state: HeldRequest["state"]; holdId: string; startedAs?: string }> {
  const lineId = liveLineOf(home, missionId);
  if (lineId === null) return [];
  return heldRequestsOf(home, missionId).flatMap((entry) => (entry.step?.lineId === lineId ? [{ n: entry.step.n, of: entry.step.of, title: entry.step.title, state: entry.state, holdId: entry.holdId, ...(entry.startedAs === undefined ? {} : { startedAs: entry.startedAs }) }] : []));
}

/** The started step a request carries, as `bm_report` reads it. */
export interface LineStepOfRequest {
  step: NonNullable<HeldRequest["step"]>;
  /** A held entry follows it: the pass starts that entry or tells the one stop. */
  hasNext: boolean;
  /** Nothing of its line is still to run or at work. */
  lastOfLine: boolean;
}

/** The started step `requestId` carries, found through its chain back to the request it started as; null when it carries none. Never throws. */
export function lineStepOf(home: string, requestId: string, workspaceId: string): LineStepOfRequest | null {
  try {
    const missionId = requestIndexOf(home, requestId)?.missionId;
    if (missionId === undefined) return null;
    const chain = new Set(chainOf(home, requestId, workspaceId));
    const entries = heldRequestsOf(home, missionId);
    const entry = entries.find((candidate) => candidate.state === "started" && candidate.step !== undefined && candidate.startedAs !== undefined && chain.has(candidate.startedAs));
    if (entry === undefined) return null;
    const hasNext = entries.some((candidate) => isOpen(candidate) && candidate.after.includes(entry.holdId));
    const others = entries.filter((candidate) => candidate.holdId !== entry.holdId && candidate.step?.lineId === entry.step!.lineId);
    const lastOfLine = !others.some((candidate) => isOpen(candidate) || atWork(home, missionId, candidate));
    return { step: entry.step!, hasNext, lastOfLine };
  } catch {
    return null;
  }
}

/** How a held request is created: `bm_create_worker` as the mission's Main (the endpoint's own tool). */
export type CreateAsMain = (input: Record<string, unknown>, caller: ToolCaller) => Promise<{ ok: boolean; text: string }>;

/** The pass's caller: `bm_create_worker` does not repeat the slot refusal, nor, for a released entry, the staffing rule's one-live-Worker line. Set here only, never from a binding or an agent's input. */
export type HeldCaller = ToolCaller & { fromHeld: true; released?: true };

export interface HeldDeps {
  create: CreateAsMain;
  now?: () => Date;
  log: (message: string) => void;
  paseo?: NoticePaseo;
  queue?: ChannelQueue;
}

/** Tells the Main; `onDropped` hears when that failed, at once or from the queue later. */
async function tellMain(home: string, mainId: string, kind: string, text: string, deps: HeldDeps, onDropped: () => void = () => {}): Promise<void> {
  try {
    // ADR-045 decision 2: what a line did without a turn heads the turn it costs.
    const notes = noTurnLeadOf(home, mainId);
    const body = notes === null ? text : text.replace("\n", `\n${notes.text}\n`);
    const callbacks = { onDropped, ...(notes === null ? {} : { onSent: () => markLeadShown(home, notes, deps.now ?? (() => new Date()), deps.log) }) };
    if ((await enqueueNotice({ home, targetId: mainId, kind, text: body, callbacks, ...(deps.paseo === undefined ? {} : { paseo: deps.paseo }), ...(deps.queue === undefined ? {} : { queue: deps.queue }) })) === "dropped") onDropped();
  } catch (error) {
    deps.log(`[paseo-bm] could not tell Main ${mainId} about a held request: ${errorText(error)}`);
    onDropped();
  }
}

/** How every notice of the queue opens. */
const NOTICE_LEAD = "BM-DELIVERY held\nFrom the paseo-bm plugin, not the owner: ";
const heldNamed = (entry: HeldRequest): string => `held request ${entry.holdId} ("${entry.topic}")`;

/** The agents a pass read, the unarchived Workers among them, and the failures this mission was told of. */
interface MissionPass {
  home: string;
  missionId: string;
  mainId: string;
  deps: HeldDeps;
  agents: ListedAgents | null;
  workers: NonNullable<StopFacts["workers"]> | null;
  told: Set<string>;
}

type ListedAgents = Awaited<ReturnType<typeof bmAgentsOf>>;

/** One failure, however many entries it stops: what the Main is told once. Pure. */
function stopKeyOf(state: StopState): string {
  switch (state.kind) {
    case "gate-failed":
      return `${state.requestId}:${state.at ?? "no-result"}`;
    case "stalled":
      return `${state.requestId}:stall:${state.since}`;
    case "no-worker":
      return `${state.requestId}:no-worker`;
    case "stopped":
      return `${state.requestId}:${HOLD_ID_PATTERN.test(state.requestId) ? "cancelled" : "stopped"}`;
  }
}

/** The stall a `toldKey` names, or null. Pure. */
function toldStallOf(key: string | undefined): { requestId: string; since: string } | null {
  const match = key === undefined ? null : /^(.+?):stall:(.+)$/.exec(key);
  return match === null ? null : { requestId: match[1]!, since: match[2]! };
}

/** What happened to the request the stop names, after its id. Pure. */
function stopClauseOf(state: StopState): string {
  switch (state.kind) {
    case "gate-failed":
      return `did not pass its finish gate: ${state.reasons.join("; ")}`;
    case "stalled":
      return `has stalled since ${state.since}`;
    case "no-worker":
      return "has no live Worker";
    case "stopped":
      return HOLD_ID_PATTERN.test(state.requestId) ? "was cancelled" : "stopped";
  }
}

export const stopNoteOf = (state: StopState): string => `${state.requestId} ${stopClauseOf(state)}`;

/** `bm_tell_worker` where it is real: on an ended head it opens the continuation, on a stalled one it reaches the Worker, and on a head with no Worker or a cancelled entry it has nobody to tell. Pure. */
function tellOptionOf(state: StopState): string | null {
  if (HOLD_ID_PATTERN.test(state.requestId) || state.kind === "no-worker") return null;
  return `a continuation with bm_tell_worker on ${state.requestId}${state.kind === "stalled" ? ', about: "current"' : ""}`;
}

/** The notice of a stop: its reasons and the real options for the entry's state, never a new `bm_create_worker`, which would duplicate the work. Pure. */
function stopNoticeOf(entry: HeldRequest, state: StopState): string {
  const started = entry.state === "started";
  const options = [tellOptionOf(state), ...(started ? [`bm_hold_cancel on ${entry.holdId}, which settles the step and leaves its Worker alone`] : [`bm_hold_release on ${entry.holdId} only on the owner's word`, `bm_hold_cancel on ${entry.holdId}`])];
  const what = started
    ? `step ${entry.step!.n} of ${entry.step!.of} ("${entry.topic}", ${entry.holdId}) is started and cannot go on: ${stopNoteOf(state)}. It stays started and gets no second Worker.`
    : `${heldNamed(entry)} waits for ${state.requestId}, which ${stopClauseOf(state)}. It does not start by itself.`;
  return `${NOTICE_LEAD}${what} What you can do: ${options.filter((option) => option !== null).join("; or ")}. Tell the owner in one line.`;
}

/** The entry reads as stopped, with its reasons, and the Main hears of the failure once: a held entry is `waiting-stopped`, a started step keeps its state and shows a `stopNote`. Writes first, so that a failure the file cannot hold is told at a later pass rather than at every one. */
async function stopEntry(pass: MissionPass, entry: HeldRequest, state: StopState): Promise<void> {
  const note = stopNoteOf(state);
  const toldKey = stopKeyOf(state);
  const started = entry.state === "started";
  const same = entry.toldKey === toldKey && (started ? entry.stopNote === note : entry.state === "waiting-stopped" && entry.note === note);
  const written = same || changeHeld(pass.home, pass.missionId, entry.holdId, (current) => ((started ? current.state !== "started" : !isOpen(current)) ? null : started ? { ...current, stopNote: note, toldKey } : { ...current, state: "waiting-stopped", note, toldKey }));
  if (!written || pass.told.has(toldKey)) return;
  pass.told.add(toldKey);
  await tellMain(pass.home, pass.mainId, `held-stopped:${toldKey}`, stopNoticeOf(entry, state), pass.deps, () => {
    // The next entry on this failure, in this pass, tries in its turn.
    pass.told.delete(toldKey);
    forgetTold(pass.home, pass.missionId, toldKey);
  });
}

/** A stop that no longer holds: a held entry waits again, a started step goes on. A stall's key goes with it, so its head's records are not read again; any other stays, so a flapping stop is told once. */
function clearStop(pass: MissionPass, entry: HeldRequest): void {
  if (entry.state === "held") return;
  changeHeld(pass.home, pass.missionId, entry.holdId, (current) => {
    if (current.state !== entry.state) return null;
    const cleared = withoutStop(current);
    return { ...(toldStallOf(current.toldKey) === null ? cleared : withoutTold(cleared)), state: current.state === "started" ? "started" : "held" };
  });
}

/** Whether a stall told earlier has ended: its alert is gone and its head's records show progress since. Records that cannot be read end nothing. Never throws. */
async function stallEnded(pass: MissionPass, told: { requestId: string; since: string }): Promise<boolean> {
  const { home, deps } = pass;
  try {
    const head = chainHeadOf(home, told.requestId);
    if (head === null || head.request.requestId !== told.requestId || openStallSince(home, head.workspaceId, told.requestId) !== null) return false;
    const { traces } = await workspaceTracesOf({ location: { tracesDir: join(home, TRACES_DIR_NAME) }, paseo: deps.paseo as unknown as DashboardPaseo, home, allAgents: pass.agents ?? [] }, head.workspaceId);
    const trace = traces.find((candidate) => candidate.requestId === told.requestId);
    return trace !== undefined && progressSinceOf(trace, told.since);
  } catch (error) {
    deps.log(`[paseo-bm] could not read the records of request ${told.requestId}: ${errorText(error)}`);
    return false;
  }
}

async function stopFactsOf(pass: MissionPass, entry: HeldRequest): Promise<StopFacts> {
  const told = toldStallOf(entry.toldKey);
  return { workers: pass.workers, toldStall: told === null || (await stallEnded(pass, told)) ? null : told };
}

/** A started step is read like a held entry, but stays `started`: its stop is shown and told, and nothing here can create it again. */
async function judgeStartedStep(pass: MissionPass, step: HeldRequest): Promise<void> {
  const state = headStateOf(pass.home, pass.missionId, step.startedAs!, await stopFactsOf(pass, step));
  if (state.kind === "stalled" || state.kind === "no-worker") await stopEntry(pass, step, state);
  else if (step.stopNote !== undefined) clearStop(pass, step);
}

/** Where the facts of `previousStepFactsOf` come from. */
export const PREVIOUS_STEP_SOURCE = "the previous step's finished report";
/** The longest fact the previous step passes on (ADR-045 decision 3). */
export const PREVIOUS_STEP_FACT_CHARS = 500;

/** The previous step's result at this moment, as context facts for the next step's brief; none for a first step. Never throws. */
function previousStepFactsOf(home: string, entries: readonly HeldRequest[], entry: HeldRequest): Array<{ fact: string; source: string }> {
  const step = entry.step;
  const previous = step === undefined ? undefined : entries.find((candidate) => candidate.step?.lineId === step.lineId && candidate.step.n === step.n - 1);
  if (previous?.startedAs === undefined) return [];
  const head = chainHeadOf(home, previous.startedAs)?.request;
  if (head === undefined) return [];
  const left = head.forNextStep;
  const commit = head.finishGate?.commit ?? null;
  const facts = [
    commit === null ? null : `The previous step's commit: ${commit}${left?.branch === undefined ? "" : ` on branch ${left.branch}`}.`,
    left === undefined ? null : `What the previous step did: ${left.summary}`,
    left?.contract === undefined ? null : `The contract the previous step left: ${left.contract}`,
    left?.remaining === undefined ? null : `What the previous step left to do: ${left.remaining}`,
  ];
  return facts.flatMap((fact) => (fact === null ? [] : [{ fact: shorten(fact, PREVIOUS_STEP_FACT_CHARS), source: PREVIOUS_STEP_SOURCE }]));
}

/** Starts every held request that may start, and stops and tells the rest (see the module comment). Never throws. */
export async function startHeldRequests(home: string, deps: HeldDeps): Promise<void> {
  const now = deps.now ?? (() => new Date());
  try {
    const store = createMissionStore(home);
    // One walk of Paseo per pass, made only once a mission has something it can stop.
    let seen: Pick<MissionPass, "agents" | "workers"> | undefined;
    const seenAgents = async (): Promise<Pick<MissionPass, "agents" | "workers">> => {
      if (seen !== undefined) return seen;
      const all = deps.paseo === undefined ? [] : await bmAgentsOf(deps.paseo as unknown as DashboardPaseo, { home });
      const workers = all.filter(({ facts }) => facts.role === "worker" && !facts.archived).map(({ facts }) => facts);
      // `bmAgentsOf` answers none when Paseo cannot be read, and a mission's Main is always listed: none is unreadable.
      seen = all.length === 0 ? { agents: null, workers: null } : { agents: all, workers: { ids: new Set(workers.map(({ id }) => id)), busy: new Set(workers.filter(({ status }) => status === "running" || status === "initializing").map(({ id }) => id)), at: Date.now() } };
      return seen;
    };
    for (const summary of store.list().filter((mission) => mission.state === "open")) {
      const mission = store.get(summary.missionId);
      if (mission === null || mission.mainId === null) continue;
      const entries = heldRequestsOf(home, mission.missionId);
      const open = entries.filter(isOpen);
      // A started step is read while its head is at work, or while a stop of its own is still to clear.
      const steps = entries.filter((entry) => entry.state === "started" && entry.step !== undefined && entry.startedAs !== undefined && (entry.stopNote !== undefined || atWork(home, mission.missionId, entry)));
      if (open.length === 0 && steps.length === 0) continue;
      const pass: MissionPass = { home, missionId: mission.missionId, mainId: mission.mainId, deps, ...(await seenAgents()), told: new Set(entries.flatMap((entry) => (entry.toldKey === undefined ? [] : [entry.toldKey]))) };
      for (const step of steps) await judgeStartedStep(pass, step);
      // Read once and only for a due entry.
      let running: RosterEntry[] | null = null;
      let startedNow = false;
      const supervised = lineSupervisedOf(home);
      for (const entry of [...open.filter((held) => held.step === undefined), ...open.filter((held) => held.step !== undefined)]) {
        const released = entry.released === true;
        const facts = released ? {} : await stopFactsOf(pass, entry);
        const state: HoldState = released ? { kind: "passed" } : holdStateOf(home, mission.missionId, entry, facts);
        if (state.kind === "waiting") {
          clearStop(pass, entry);
          continue;
        }
        if (isStop(state)) {
          await stopEntry(pass, entry, state);
          continue;
        }
        const parallel = typeof entry.input["parallel"] === "string";
        if (supervised && !parallel && !released) {
          if (startedNow) {
            clearStop(pass, entry);
            continue;
          }
          // ADR-045 decision 1: a slot that cannot be read is held, and the entry stays as it is.
          if (deps.paseo !== undefined && pass.agents === null) continue;
          running ??= pass.agents === null ? [] : (await runningRequestsOf(home, deps.paseo, mission.missionId, pass.agents)).filter((request) => request.parallel !== true);
          if (running.length > 0) {
            const stalled = running.map((request) => headStateOf(home, mission.missionId, request.requestId, facts)).find((head) => head.kind === "stalled");
            if (stalled !== undefined && isStop(stalled)) await stopEntry(pass, entry, stalled);
            else clearStop(pass, entry);
            continue;
          }
        }
        const caller: HeldCaller = { agentId: mission.mainId, role: "manager", workspaceId: mission.workspaceId ?? "", requestId: null, parentId: null, batchId: null, missionId: mission.missionId, fromHeld: true, ...(released ? { released: true as const } : {}) };
        const stored = Array.isArray(entry.input["context"]) ? (entry.input["context"] as unknown[]) : [];
        // ADR-045 decision 3: read now and added to what is passed, never to the entry.
        const answer = await deps.create({ ...entry.input, context: [...previousStepFactsOf(home, entries, entry), ...stored] }, caller);
        if (!answer.ok) {
          // Kept held: the next pass tries again, and the Main hears why once.
          if (entry.note !== answer.text) {
            changeHeld(home, mission.missionId, entry.holdId, (current) => ({ ...current, note: answer.text, state: current.state === "waiting-stopped" ? "held" : current.state }));
            await tellMain(home, mission.mainId, `held-refused:${entry.holdId}`, `${NOTICE_LEAD}${heldNamed(entry)} could not start: ${answer.text}`, deps);
          }
          continue;
        }
        let parsed: { requestId?: string; workerId?: string } = {};
        try {
          parsed = JSON.parse(answer.text) as typeof parsed;
        } catch {
          // Started all the same, with no id to show for it.
        }
        const { requestId: startedAs = "", workerId = "" } = parsed;
        changeHeld(home, mission.missionId, entry.holdId, (current) => ({ ...withoutStop(current), state: "started", ...(startedAs === "" ? {} : { startedAs }), settledAt: now().toISOString() }));
        if (!parallel) startedNow = true;
        const why = released ? "the owner released it" : entry.after.length === 0 ? "no request was running" : `${entry.after.join(", ")} finished`;
        journalQuietly(createMissionStore(home), mission.missionId, { kind: "worker", by: "plugin", text: `Held request ${entry.holdId} started as ${startedAs || "a new request"}: ${why}.`, ref: startedAs || entry.holdId }, deps.log);
        if (entry.step !== undefined) {
          // ADR-045 decision 2: a step's start costs no Main turn; the note heads its next delivery, and one that cannot be written costs a log line.
          try {
            createOutbox(home, { now }).add(requestIndexOf(home, startedAs)?.workspaceId ?? mission.charter.repos[0] ?? "", { kind: "message", requestId: startedAs || entry.holdId, from: "plugin", to: mission.mainId, text: `Step ${entry.step.n} of ${entry.step.of} ("${entry.topic}", ${entry.holdId}) started as ${startedAs} with Worker ${workerId}, since ${why}.`, noTurn: true });
          } catch (error) {
            deps.log(`[paseo-bm] could not note the start of step ${entry.holdId}: ${errorText(error)}`);
          }
          continue;
        }
        await tellMain(
          home,
          mission.mainId,
          `held-started:${entry.holdId}`,
          `${NOTICE_LEAD}${heldNamed(entry)} started as ${startedAs} with Worker ${workerId}, since ${why}.`,
          deps,
        );
      }
    }
  } catch (error) {
    deps.log(`[paseo-bm] held requests could not be started: ${errorText(error)}`);
  }
}
