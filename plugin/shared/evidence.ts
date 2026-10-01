/**
 * What a Worker's report claims, set against what its request's records show
 * (autonomy design §C.2, §C.6; REQ-130). Each check the report names in
 * `buildAndTests`, each file of `filesChanged` and each bead of `beadsClosed`
 * is `detected` when the evidence shows it and `self-reported` when only the
 * report says so; the request's checks as a whole are `detected`,
 * `self-reported`, `unverified` or `not-checked`.
 *
 * - **Named checks** are the backtick spans of `buildAndTests`, as the Worker
 *   is told to write them (`roles/worker.md`, "Proving a change"). A value
 *   naming checks only in words is self-reported; an empty one, or one that
 *   says nothing ran (`reportChecksOf`), is unverified.
 * - **A detected check** is one a shell entry of the request ran, the same
 *   command once normalised (`normalisedCommand`), with success, after the
 *   request's last file edit — and after its last handoff (design §G.6 step
 *   5): the successor proves again, so a run of the Worker it replaced never
 *   counts for it. The handoff is the successor's first turn: the first
 *   record of a Worker the plugin knows as a handoff's successor (its
 *   `bm.handoffFrom` label, `handoffSuccessors`), or else a Worker record
 *   whose first message holds a handoff brief (`shared/handoff.ts`) — the
 *   Manager may drop the brief's first line (Phase 3 live check, F2). A segment of a line joined only by `&&`, or a
 *   run of such segments, counts too: that line succeeds only when each does.
 *   A line also joined by `;`, `||`, `|` or `&` ends as its last part does, so
 *   it proves none of them (`andChainOf`): a piped `npm test | tail -5` is
 *   never detected, whether named or run.
 * - **Success** is `shellSucceeded`: an exit code, when present, decides;
 *   otherwise `status: completed`.
 * - **One call, its latest state.** The running and the finished entry of a
 *   call share its `callId`: they are one call, in the state of its latest
 *   entry, placed where it began. A check that began before the last edit
 *   ended did not see it.
 * - **Order** is by the entry's time, then by the records' order as given,
 *   then by the entry's place in its record: a record whose times all fell
 *   back to the write time (AGENTS.md) still keeps its timeline order.
 * - **Not checked.** A request that has shell entries, none of them with a
 *   `status`, was recorded before those fields existed (§C.1): its checks are
 *   neither detected nor unverified. A request with no shell entry at all ran
 *   no command, which any record would have shown, so it is judged as usual.
 * - **Files** match `file` (edit or write) entries by the path relative to the
 *   workspace folder: Claude records absolute paths, Codex relative ones.
 *   Without the folder, a relative path matches an absolute one ending in it.
 * - **Beads** match a `br close` of a successful line (`brActions`), under the
 *   same `&&` rule as checks, at any time.
 * - **Finished-unverified** (§C.3, `requestFinishOf`): a request whose latest
 *   report is `finished`, whose code changed and whose named checks are not
 *   all detected. Work, the finished card, `request.finished` and the
 *   delegation refusal (§C.6, change-008 C4) all read it from here.
 *
 * `shared/`, pure: no Node and no React Native imports, so the client can
 * read it too.
 */
import type { ParsedReport, TraceRecord } from "./contracts";
import { holdsHandoffBrief } from "./handoff";
import { reportChecksOf } from "./interventions";
import { andChainOf, brActions, normalisedCommand, shellSucceeded } from "./shell";
import { timeOrZero } from "./time";

/** How one claim of a report stands. */
export const CLAIM_LABELS = ["detected", "self-reported"] as const;
export type ClaimLabel = (typeof CLAIM_LABELS)[number];

/** How a request's checks stand as a whole (design §C.2). */
export const CHECKS_VERDICTS = ["detected", "self-reported", "unverified", "not-checked"] as const;
export type ChecksVerdict = (typeof CHECKS_VERDICTS)[number];

export interface CheckClaim {
  /** The check as named, normalised. */
  check: string;
  label: ClaimLabel;
}

export interface FileClaim {
  /** The path as the report gives it. */
  path: string;
  label: ClaimLabel;
}

export interface BeadClaim {
  id: string;
  label: ClaimLabel;
}

/** A report's claims, labelled. */
export interface Verification {
  /**
   * The request's checks: `detected` when every named check is; `unverified`
   * when none is named or the report says nothing ran; `not-checked` for a
   * request recorded before shell entries carried a status; `self-reported`
   * otherwise.
   */
  checks: ChecksVerdict;
  /** Each check the report names, once, in its order. */
  named: CheckClaim[];
  /** Each file of `filesChanged`, once, in its order. */
  files: FileClaim[];
  /** Each bead of `beadsClosed`, once, in its order. */
  beads: BeadClaim[];
  /** True when the report names a file changed, or a record of the request edited or wrote one. */
  changedFiles: boolean;
}

/**
 * One recorded turn of the request, as far as the labels read it: its role,
 * start and messages, when given, tell a successor's first turn (a handoff).
 */
export type VerificationRecord = Pick<TraceRecord, "agentId" | "endedAt" | "evidence"> & Partial<Pick<TraceRecord, "role" | "startedAt" | "sent">>;

export interface VerificationInput {
  /** The report whose claims are labelled (the request's latest, as a rule). */
  report: Pick<ParsedReport, "buildAndTests" | "filesChanged" | "beadsClosed">;
  /** Every record of the request, in time order, whatever the role. */
  records: readonly VerificationRecord[];
  /** The workspace folder, for file paths; null when unknown. */
  workspaceDirectory: string | null;
  /** The Workers that took the request over by a handoff (their `bm.handoffFrom` label, design §G.6); none when absent. */
  handoffSuccessors?: ReadonlySet<string>;
}

/**
 * The checks `buildAndTests` names: its backtick spans, normalised, once
 * each, in order. Empty for a value with none. Pure.
 */
export function namedChecksOf(buildAndTests: string | null): string[] {
  if (buildAndTests === null) return [];
  const named = new Set<string>();
  for (const match of buildAndTests.matchAll(/`([^`]+)`/g)) {
    const check = normalisedCommand(match[1]!);
    if (check !== "") named.add(check);
  }
  return [...named];
}

/** Where an entry falls: its time, then its record's place, then its own. */
interface Place {
  time: number;
  record: number;
  entry: number;
}

function isAfter(a: Place, b: Place): boolean {
  if (a.time !== b.time) return a.time > b.time;
  if (a.record !== b.record) return a.record > b.record;
  return a.entry > b.entry;
}

/** One shell call: where it began, and its latest state. */
interface ShellCall {
  began: Place;
  command: string;
  status: string | null;
  exitCode: number | null;
}

interface RequestEvidence {
  calls: ShellCall[];
  /** The latest `file` entry, or null when nothing was edited or written. */
  lastEdit: Place | null;
  /** The start of the latest successor's first turn (a handoff, design §G.6), or null when none. */
  lastHandoff: Place | null;
  editedPaths: string[];
  shellEntries: number;
  shellEntriesWithStatus: number;
}

function readEvidence(records: readonly VerificationRecord[], successors: ReadonlySet<string>): RequestEvidence {
  const calls: ShellCall[] = [];
  const byId = new Map<string, ShellCall>();
  const editedPaths: string[] = [];
  let lastEdit: Place | null = null;
  let lastHandoff: Place | null = null;
  let shellEntries = 0;
  let shellEntriesWithStatus = 0;
  const seen = new Set<string>();
  for (const [recordIndex, record] of records.entries()) {
    const first = record.sent?.[0];
    const successorsFirst = successors.has(record.agentId) && !seen.has(record.agentId);
    seen.add(record.agentId);
    if (record.role === "worker" && (successorsFirst || (first !== undefined && holdsHandoffBrief(first.text)))) {
      // Before the turn's own entries: what the successor runs in it counts.
      const place: Place = { time: timeOrZero(first?.at ?? record.startedAt ?? record.endedAt), record: recordIndex, entry: -1 };
      if (lastHandoff === null || isAfter(place, lastHandoff)) lastHandoff = place;
    }
    for (const [entryIndex, evidence] of record.evidence.entries()) {
      const place: Place = { time: timeOrZero(evidence.at ?? record.endedAt), record: recordIndex, entry: entryIndex };
      if (evidence.kind === "file") {
        editedPaths.push(evidence.detail);
        if (lastEdit === null || isAfter(place, lastEdit)) lastEdit = place;
        continue;
      }
      if (evidence.kind !== "shell") continue;
      shellEntries += 1;
      if (evidence.status !== undefined) shellEntriesWithStatus += 1;
      const state = { command: evidence.detail, status: evidence.status ?? null, exitCode: evidence.exitCode ?? null };
      const key = evidence.callId === undefined ? null : `${record.agentId}\n${evidence.callId}`;
      const known = key === null ? undefined : byId.get(key);
      if (known !== undefined) {
        Object.assign(known, state);
        continue;
      }
      const call: ShellCall = { began: place, ...state };
      calls.push(call);
      if (key !== null) byId.set(key, call);
    }
  }
  return { calls, lastEdit, lastHandoff, editedPaths, shellEntries, shellEntriesWithStatus };
}

/** The normalised `&&` segments of a line, or null when its status does not vouch for them. */
function chainOf(command: string): string[] | null {
  return andChainOf(command)?.map(normalisedCommand) ?? null;
}

/** True when `wanted` appears in `parts` as a run of consecutive segments. */
function containsRun(parts: readonly string[], wanted: readonly string[]): boolean {
  for (let start = 0; start + wanted.length <= parts.length; start += 1) {
    if (wanted.every((part, offset) => parts[start + offset] === part)) return true;
  }
  return false;
}

/** A POSIX path with `.`, `..` and repeated slashes resolved, as far as the text allows. `writers-observed.ts` places written files with it too. */
export function normalisedPath(path: string): string {
  const trimmed = path.trim();
  const absolute = trimmed.startsWith("/");
  const parts: string[] = [];
  for (const part of trimmed.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === ".." && parts.length > 0 && parts.at(-1) !== "..") parts.pop();
    else if (part !== ".." || !absolute) parts.push(part);
  }
  return `${absolute ? "/" : ""}${parts.join("/")}`;
}

/** A path as files are compared: relative to the workspace folder (already `normalisedPath`) when it lies below it. `server/links.ts` matches files with it too. */
export function pathKeyOf(path: string, workspace: string | null): string {
  const key = normalisedPath(path);
  if (workspace === null || workspace === "/") return key;
  return key.startsWith(`${workspace}/`) ? key.slice(workspace.length + 1) : key;
}

/** True when two path keys name one file; without the folder, a relative key matches an absolute one ending in it. */
export function sameFile(a: string, b: string, workspaceKnown: boolean): boolean {
  if (a === b) return true;
  if (workspaceKnown || a.startsWith("/") === b.startsWith("/")) return false;
  const [absolute, relative] = a.startsWith("/") ? [a, b] : [b, a];
  return relative !== "" && absolute.endsWith(`/${relative}`);
}

/**
 * The labels of one report's checks, files and beads against its request's
 * records (design §C.2, §C.6). Pure.
 */
export function verificationOf(input: VerificationInput): Verification {
  const { report, records } = input;
  const found = readEvidence(records, input.handoffSuccessors ?? new Set());
  const succeeded = found.calls.filter((call) => shellSucceeded(call.status, call.exitCode));

  // Checks: a successful run of the same command after the last edit, and after the last handoff (§G.6).
  const lastEdit = found.lastEdit;
  const lastHandoff = found.lastHandoff;
  const provingRuns = succeeded
    .filter((call) => (lastEdit === null || isAfter(call.began, lastEdit)) && (lastHandoff === null || isAfter(call.began, lastHandoff)))
    .map((call) => chainOf(call.command))
    .filter((parts): parts is string[] => parts !== null);
  const named: CheckClaim[] = namedChecksOf(report.buildAndTests).map((check) => {
    const wanted = chainOf(check);
    const detected = wanted !== null && provingRuns.some((parts) => containsRun(parts, wanted));
    return { check, label: detected ? "detected" : "self-reported" };
  });
  let checks: ChecksVerdict;
  if (found.shellEntries > 0 && found.shellEntriesWithStatus === 0) checks = "not-checked";
  else if (reportChecksOf(report.buildAndTests) === null) checks = "unverified";
  else if (named.length > 0 && named.every((claim) => claim.label === "detected")) checks = "detected";
  else checks = "self-reported";

  // Files: an edit or a write of the same path, relative to the workspace folder.
  const workspace = input.workspaceDirectory === null || input.workspaceDirectory.trim() === "" ? null : normalisedPath(input.workspaceDirectory);
  const edited = found.editedPaths.map((path) => pathKeyOf(path, workspace));
  const files: FileClaim[] = [];
  const claimedFiles = new Set<string>();
  for (const path of report.filesChanged) {
    const key = pathKeyOf(path, workspace);
    if (key === "" || claimedFiles.has(key)) continue;
    claimedFiles.add(key);
    files.push({ path, label: edited.some((other) => sameFile(key, other, workspace !== null)) ? "detected" : "self-reported" });
  }

  // Beads: a `br close` naming the bead, in a successful line whose status vouches for it.
  const closed = new Set<string>();
  for (const call of succeeded) {
    if (andChainOf(call.command) === null) continue;
    for (const action of brActions(call.command)) {
      if (action.verb === "close") for (const id of action.ids) closed.add(id.toLowerCase());
    }
  }
  const beads: BeadClaim[] = [...new Set(report.beadsClosed)].map((id) => ({ id, label: closed.has(id.toLowerCase()) ? "detected" : "self-reported" }));

  return { checks, named, files, beads, changedFiles: report.filesChanged.length > 0 || found.editedPaths.length > 0 };
}

/**
 * Finished-unverified (design §C.3): the request's code changed — its report
 * names a file, or a record edited one — and its named checks are not all
 * detected (`self-reported` or `unverified`). A request that is not checked
 * (§C.2) never is: it is shown as before. Pure.
 */
export function isFinishedUnverified(verification: Pick<Verification, "checks" | "changedFiles">): boolean {
  return verification.changedFiles && (verification.checks === "self-reported" || verification.checks === "unverified");
}

/** A request's finish, labelled (design §C.3): the claims of its latest report, which is `finished`. */
export interface RequestFinish extends Verification {
  /** When that `finished` report was sent. */
  reportAt: string;
  /** Finished-unverified (`isFinishedUnverified`). */
  unverified: boolean;
}

export interface RequestFinishInput {
  /** The request's reports; a report whose milestone could not be read is left out. */
  reports: ReadonlyArray<Pick<ParsedReport, "at" | "phase" | "buildAndTests" | "filesChanged" | "beadsClosed">>;
  /** Every record of the request, in time order, whatever the role. */
  records: readonly VerificationRecord[];
  /** The Workers that took the request over by a handoff (`VerificationInput`). */
  handoffSuccessors?: ReadonlySet<string>;
  /** The workspace folder, for file paths; null when unknown. */
  workspaceDirectory: string | null;
}

/**
 * The request's finish (design §C.3, §C.6): its latest report with a
 * milestone — by time, the later one of a tie — labelled against its records
 * when that report is `finished`; null otherwise (not finished yet, or a later
 * report ended the finish). Pure.
 */
export function requestFinishOf(input: RequestFinishInput): RequestFinish | null {
  let latest: RequestFinishInput["reports"][number] | null = null;
  for (const report of input.reports) {
    if (report.phase === null) continue;
    if (latest === null || timeOrZero(report.at) >= timeOrZero(latest.at)) latest = report;
  }
  if (latest?.phase !== "finished") return null;
  const verification = verificationOf({
    report: latest,
    records: input.records,
    workspaceDirectory: input.workspaceDirectory,
    ...(input.handoffSuccessors === undefined ? {} : { handoffSuccessors: input.handoffSuccessors }),
  });
  return { ...verification, reportAt: latest.at, unverified: isFinishedUnverified(verification) };
}
