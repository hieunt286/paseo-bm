/**
 * The owner's autonomy RPCs (autonomy design §B.2, §B.9; PRD REQ-121) over the
 * policy store (`autonomy-store.ts`):
 *
 * - `autonomy.policy { workspaceId? }` reads only: the whole policy, or one
 *   project's, with each project's level (`levelOf`, ADR-025).
 * - `autonomy.set-level { workspaceId, level, confirmed? }` sets one
 *   project's level (ADR-025): its nine cells and its prediction switch in one
 *   write. Turbo and Full auto need `confirmed: true`
 *   (`E_AUTONOMY_NOT_CONFIRMED`); an unknown project or level is
 *   `E_AUTONOMY_INVALID`.
 * - `autonomy.set { workspaceId, class, mode, confirmed? }` sets one cell, of
 *   any class. `delegate` needs `confirmed: true` (`E_AUTONOMY_NOT_CONFIRMED`);
 *   an unknown class or mode is `E_AUTONOMY_INVALID`. `owner` and `shadow`
 *   need no confirmation.
 * - `autonomy.reset { workspaceId }` returns every class of that project to
 *   `owner` in one write, with no confirmation: it is the one-action safety
 *   path (REQ-121 d).
 * - `autonomy.set-challenger { workspaceId, enabled }` turns that project's
 *   Orchestrator challenger on or off (§B.3, off by default, DQ-4), with no
 *   confirmation: it only records the Orchestrator's predictions. Its cells
 *   stay as they are; an unknown project or a non-boolean is
 *   `E_AUTONOMY_INVALID`.
 * - `autonomy.set-boundary { workspaceId, enabled, confirmed }` turns that
 *   project's action boundary on or off (§D.2, change-010: off by default).
 *   Both directions need `confirmed: true` (`E_AUTONOMY_NOT_CONFIRMED`); off
 *   removes the entry and clears the project's `boundary-off` alerts.
 *
 * Every input is checked before the data folder is looked at, so a refusal
 * never depends on the machine; every refusal writes nothing. No usable data
 * folder, or one that cannot be created → `E_DATA_HOME_UNAVAILABLE`; a store
 * written by a newer paseo-bm or one that cannot be written →
 * `E_AUTONOMY_WRITE_FAILED` (rpc-kit `coded`, code review 2026-09-30 §3.2).
 *
 * These are the owner's RPCs (Settings) and the evaluation suite's; no agent
 * tool sets the policy, and nothing else writes it: an override or a
 * reversal is only recorded (ADR-025 decision 4, no demotion).
 *
 * The owner's precedents (§B.6, §B.9; PRD REQ-124) are served here too, over
 * `precedent-store.ts` in the same folder:
 *
 * - `precedents.list { workspaceId? }` reads only: the active precedents,
 *   newest first — every one, or a project's and the global ones.
 * - `precedents.save { decisionId?, scope, subject?, text?, expiresInDays? }`
 *   saves one from the owner's answered decision (**Save as precedent** on its
 *   card) or from Settings, superseding an active one of the same scope and
 *   subject.
 * - `precedents.end { id }` makes one expire now.
 *
 * Their input is checked before the data folder too; a refusal writes nothing
 * (`E_PRECEDENT_INVALID`, `E_PRECEDENT_NOT_FOUND`, `E_DECISION_NOT_FOUND`,
 * `E_DATA_HOME_UNAVAILABLE`, `E_PRECEDENT_WRITE_FAILED`). The decision a save
 * is made from is read with the read code (`READ_FAILED`), never a write one.
 */
import type { PluginServerContext } from "@getpaseo/plugin/server";
import {
  DashboardError,
  autonomyPolicyRpc,
  autonomyResetRpc,
  autonomySetBoundaryRpc,
  autonomySetChallengerRpc,
  autonomySetLevelRpc,
  autonomySetRpc,
  precedentsEndRpc,
  precedentsListRpc,
  precedentsSaveRpc,
  type AutonomyPolicyOutput,
  type AutonomySetOutput,
  type PrecedentsEndOutput,
  type PrecedentsListOutput,
  type PrecedentsSaveOutput,
} from "../shared/contracts";
import {
  EMPTY_AUTONOMY_POLICY,
  checkAutonomySet,
  checkAutonomySetBoundary,
  checkAutonomySetChallenger,
  checkAutonomySetLevel,
  isPolicyWorkspaceId,
  levelOf,
  levelsOf,
  policyOfProject,
  type AutonomyPolicy,
} from "../shared/autonomy";
import type { Alert } from "../shared/alerts";
import { PRECEDENT_ID_PATTERN, checkPrecedentSaveInput, precedentDraftOf, type Precedent } from "../shared/precedents";
import { createAlertStore } from "./alert-store";
import { createAutonomyStore, currentPolicy, invalidWorkspace } from "./autonomy-store";
import { createDecisionStore } from "./decision-store";
import { createPrecedentStore, type PrecedentStoreDeps } from "./precedent-store";
import { READ_FAILED, coded, dataHome, errorText, logOf, readOr, requireDataHome, type RpcHomeDeps } from "./rpc-kit";

export type AutonomyRpcDeps = RpcHomeDeps &
  PrecedentStoreDeps & {
    /** The clock a set cell and a precedent are stamped with, and precedents are read at. */
    now?: () => Date;
    /** Where an unreadable store is reported; `console.warn` by default. */
    log?: (message: string) => void;
  };

/**
 * The policy in effect, for the plugin's own readers (what a mode does when a
 * decision opens, the event scope). No usable data folder, or a store that
 * cannot be read, reads as the empty policy — every cell `owner`, the safe
 * side — at the cost of one log line (`currentPolicy`). Never throws.
 */
export function readAutonomyPolicy(deps: AutonomyRpcDeps = {}): AutonomyPolicy {
  const home = dataHome(deps);
  if (home === null) return EMPTY_AUTONOMY_POLICY;
  return currentPolicy(home, (reason) => logOf(deps)(`[paseo-bm] could not read the autonomy policy: ${reason}`));
}

/** `autonomy.policy`: reads only; with each project's level (ADR-025). */
export function handleAutonomyPolicy(input: { workspaceId?: string } = {}, deps: AutonomyRpcDeps = {}): AutonomyPolicyOutput {
  const policy = readAutonomyPolicy(deps);
  if (input.workspaceId === undefined) return { policy, levels: levelsOf(policy) };
  return { policy: policyOfProject(policy, input.workspaceId), levels: { [input.workspaceId]: levelOf(policy, input.workspaceId) } };
}

/** Runs a write with the data folder, coded by rpc-kit `coded` as `E_AUTONOMY_WRITE_FAILED`. */
function writing(deps: AutonomyRpcDeps, run: (home: string) => AutonomyPolicy): AutonomySetOutput {
  const home = requireDataHome(deps, "save");
  return coded("E_AUTONOMY_WRITE_FAILED", "save the autonomy policy", () => ({ policy: run(home) }));
}

/** `autonomy.set-level`: one project's level (ADR-025), checked before the data folder. Returns the whole policy. */
export function handleAutonomySetLevel(input: unknown, deps: AutonomyRpcDeps = {}): AutonomySetOutput {
  const checked = checkAutonomySetLevel(input);
  if ("refusal" in checked) throw new DashboardError(checked.refusal.code, checked.refusal.detail);
  const { change } = checked;
  const at = nowOf(deps).toISOString();
  return writing(deps, (home) => createAutonomyStore(home).setLevel(change, at));
}

/** `autonomy.set`: one cell, checked before the data folder. Returns the whole policy. */
export function handleAutonomySet(input: unknown, deps: AutonomyRpcDeps = {}): AutonomySetOutput {
  const checked = checkAutonomySet(input);
  if ("refusal" in checked) throw new DashboardError(checked.refusal.code, checked.refusal.detail);
  const { change } = checked;
  const at = nowOf(deps).toISOString();
  return writing(deps, (home) => createAutonomyStore(home).set(change, at));
}

/** `autonomy.reset`: every class of one project back to `owner`. Returns the whole policy. */
export function handleAutonomyReset(input: unknown, deps: AutonomyRpcDeps = {}): AutonomySetOutput {
  const workspaceId = (input as { workspaceId?: unknown } | null | undefined)?.workspaceId;
  if (!isPolicyWorkspaceId(workspaceId)) throw invalidWorkspace(workspaceId);
  return writing(deps, (home) => createAutonomyStore(home).reset(workspaceId));
}

/** `autonomy.set-challenger`: one project's challenger on or off, checked before the data folder. Returns the whole policy. */
export function handleAutonomySetChallenger(input: unknown, deps: AutonomyRpcDeps = {}): AutonomySetOutput {
  const checked = checkAutonomySetChallenger(input);
  if ("refusal" in checked) throw new DashboardError(checked.refusal.code, checked.refusal.detail);
  return writing(deps, (home) => createAutonomyStore(home).setChallenger(checked.change));
}

/**
 * `autonomy.set-boundary`: one project's action boundary on or off, checked
 * before the data folder (§D.2, change-010 C2). Returns the whole policy.
 * Turning it off clears the project's `boundary-off` alerts (C6).
 */
export function handleAutonomySetBoundary(input: unknown, deps: AutonomyRpcDeps = {}): AutonomySetOutput {
  const checked = checkAutonomySetBoundary(input);
  if ("refusal" in checked) throw new DashboardError(checked.refusal.code, checked.refusal.detail);
  const { change } = checked;
  const at = nowOf(deps).toISOString();
  return writing(deps, (home) => {
    const policy = createAutonomyStore(home).setBoundary(change, at);
    if (!change.enabled) clearAlerts(home, (alert) => alert.kind === "boundary-off" && alert.workspaceId === change.workspaceId, deps);
    return policy;
  });
}

function nowOf(deps: { now?: () => Date }): Date {
  return (deps.now ?? (() => new Date()))();
}

/** Clears the open alerts that match, after a policy change already written; a failure is one log line. */
function clearAlerts(home: string, match: (alert: Alert) => boolean, deps: AutonomyRpcDeps): void {
  try {
    createAlertStore(home, deps.now === undefined ? {} : { now: deps.now }).clearWhere(match);
  } catch (error) {
    logOf(deps)(`[paseo-bm] could not clear an alert after a policy change: ${errorText(error)}`);
  }
}

// ---------------------------------------------------------------------------
// Precedents (§B.6, §B.9).
// ---------------------------------------------------------------------------

/**
 * The active precedents, newest first — of one workspace and the global ones,
 * or all of them — for the plugin's own readers (injection, resolution). No
 * usable data folder, or a store that cannot be read, reads as none, at the
 * cost of one log line. Never throws.
 */
export function readActivePrecedents(deps: AutonomyRpcDeps = {}, workspaceId?: string): Precedent[] {
  return readOr(deps, "the precedents", [], (home) => createPrecedentStore(home, deps).active(nowOf(deps), workspaceId));
}

/** `precedents.list`: reads only. */
export function handlePrecedentsList(input: { workspaceId?: string } = {}, deps: AutonomyRpcDeps = {}): PrecedentsListOutput {
  return { precedents: readActivePrecedents(deps, input.workspaceId) };
}

/** Runs a precedent write with the data folder, coded by rpc-kit `coded` as `E_PRECEDENT_WRITE_FAILED`. */
function writingPrecedents<T>(deps: AutonomyRpcDeps, run: (home: string) => T): T {
  const home = requireDataHome(deps, "save");
  return coded("E_PRECEDENT_WRITE_FAILED", "save the precedents", () => run(home));
}

/**
 * `precedents.save`: the input checked before the data folder, then — for a
 * save from a decision — the decision read from the store and checked (the
 * owner's answer, a subject, the scope), then one write that also supersedes
 * an active precedent of the same scope and subject.
 */
export function handlePrecedentsSave(input: unknown, deps: AutonomyRpcDeps = {}): PrecedentsSaveOutput {
  const checked = checkPrecedentSaveInput(input);
  if ("refusal" in checked) throw new DashboardError(checked.refusal.code, checked.refusal.detail);
  const now = nowOf(deps);
  return writingPrecedents(deps, (home) => {
    const decisionId = checked.input.decisionId;
    const decision =
      decisionId === undefined
        ? null
        : coded(READ_FAILED, "read the decision", () => createDecisionStore(home, deps.log === undefined ? {} : { log: deps.log }).get(decisionId));
    if (decisionId !== undefined && decision === null) throw new DashboardError("E_DECISION_NOT_FOUND", `no decision ${decisionId}`);
    const drafted = precedentDraftOf(checked.input, decision);
    if ("refusal" in drafted) throw new DashboardError(drafted.refusal.code, drafted.refusal.detail);
    return createPrecedentStore(home, deps).save(drafted.draft, now);
  });
}

/** `precedents.end`: the precedent expires now; an unknown id is `E_PRECEDENT_NOT_FOUND`. */
export function handlePrecedentsEnd(input: unknown, deps: AutonomyRpcDeps = {}): PrecedentsEndOutput {
  const id = (input as { id?: unknown } | null | undefined)?.id;
  if (typeof id !== "string" || !PRECEDENT_ID_PATTERN.test(id)) {
    throw new DashboardError("E_PRECEDENT_INVALID", `${JSON.stringify(id ?? null)} is not a precedent id; nothing was ended`);
  }
  const now = nowOf(deps);
  const precedent = writingPrecedents(deps, (home) => createPrecedentStore(home, deps).end(id, now));
  if (precedent === null) throw new DashboardError("E_PRECEDENT_NOT_FOUND", `no precedent ${id}`);
  return { precedent };
}

export function registerAutonomyRpcs(server: PluginServerContext, deps: AutonomyRpcDeps = {}): void {
  server.handle(autonomyPolicyRpc, (input) => handleAutonomyPolicy(input, deps));
  server.handle(autonomySetLevelRpc, (input) => handleAutonomySetLevel(input, deps));
  server.handle(autonomySetRpc, (input) => handleAutonomySet(input, deps));
  server.handle(autonomyResetRpc, (input) => handleAutonomyReset(input, deps));
  server.handle(autonomySetChallengerRpc, (input) => handleAutonomySetChallenger(input, deps));
  server.handle(autonomySetBoundaryRpc, (input) => handleAutonomySetBoundary(input, deps));
  server.handle(precedentsListRpc, (input) => handlePrecedentsList(input, deps));
  server.handle(precedentsSaveRpc, (input) => handlePrecedentsSave(input, deps));
  server.handle(precedentsEndRpc, (input) => handlePrecedentsEnd(input, deps));
}
