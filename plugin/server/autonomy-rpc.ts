/**
 * The owner's autonomy RPCs (autonomy design §B.2, §B.9; PRD REQ-121) over the
 * policy store (`autonomy-store.ts`):
 *
 * - `autonomy.policy { workspaceId? }` reads only: the whole policy, or one
 *   project's.
 * - `autonomy.set { workspaceId, class, mode, confirmed?, predictor? }` sets
 *   one cell. `delegate` is refused for release, data, security and cost
 *   (`E_AUTONOMY_OWNER_ONLY`) and needs `confirmed: true`
 *   (`E_AUTONOMY_NOT_CONFIRMED`); an unknown class or mode is
 *   `E_AUTONOMY_INVALID`. `owner` and `shadow` need no confirmation.
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
 * These are the owner's RPCs (Settings, and Insights' Delegate? with the
 * promotion) and the evaluation suite's; no agent tool sets the policy.
 *
 * The demotion (§B.4, §B.9) is the plugin's own writer of the policy, beside
 * them: `demoteOnReversal` takes a delegated class back to `shadow` at once
 * when a decision the policy or a precedent answered is reversed, and raises
 * the Inbox alert `autonomy-demoted` (keyed by project and class). The alert
 * clears when the owner next sets that cell (`autonomy.set`) or resets the
 * project (`autonomy.reset`), or once the class is eligible again
 * (`clearRenewedDemotions`, after the owner's answers).
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
  eligibility,
  isPolicyWorkspaceId,
  policyOfProject,
  type AutonomyPolicy,
} from "../shared/autonomy";
import { agreementLedger } from "../shared/autonomy-ledger";
import { alertKeyOf, type Alert } from "../shared/alerts";
import { decisionClassOf, type Decision, type DecisionClass, type ReversalKind } from "../shared/decisions";
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

/** `autonomy.policy`: reads only. */
export function handleAutonomyPolicy(input: { workspaceId?: string } = {}, deps: AutonomyRpcDeps = {}): AutonomyPolicyOutput {
  const policy = readAutonomyPolicy(deps);
  return { policy: input.workspaceId === undefined ? policy : policyOfProject(policy, input.workspaceId) };
}

/** Runs a write with the data folder, coded by rpc-kit `coded` as `E_AUTONOMY_WRITE_FAILED`. */
function writing(deps: AutonomyRpcDeps, run: (home: string) => AutonomyPolicy): AutonomySetOutput {
  const home = requireDataHome(deps, "save");
  return coded("E_AUTONOMY_WRITE_FAILED", "save the autonomy policy", () => ({ policy: run(home) }));
}

/**
 * `autonomy.set`: one cell, checked before the data folder. Returns the whole
 * policy. The owner's change of the cell ends its `autonomy-demoted` alert.
 */
export function handleAutonomySet(input: unknown, deps: AutonomyRpcDeps = {}): AutonomySetOutput {
  const checked = checkAutonomySet(input);
  if ("refusal" in checked) throw new DashboardError(checked.refusal.code, checked.refusal.detail);
  const { change } = checked;
  const at = nowOf(deps).toISOString();
  return writing(deps, (home) => {
    const policy = createAutonomyStore(home).set(change, at);
    clearDemotionAlerts(home, (alert) => alert.workspaceId === change.workspaceId && alert.subject === change.class, deps);
    return policy;
  });
}

/**
 * `autonomy.reset`: every class of one project back to `owner`. Returns the
 * whole policy. Ends every `autonomy-demoted` alert of the project.
 */
export function handleAutonomyReset(input: unknown, deps: AutonomyRpcDeps = {}): AutonomySetOutput {
  const workspaceId = (input as { workspaceId?: unknown } | null | undefined)?.workspaceId;
  if (!isPolicyWorkspaceId(workspaceId)) throw invalidWorkspace(workspaceId);
  return writing(deps, (home) => {
    const policy = createAutonomyStore(home).reset(workspaceId);
    clearDemotionAlerts(home, (alert) => alert.workspaceId === workspaceId, deps);
    return policy;
  });
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

// ---------------------------------------------------------------------------
// Demotion (§B.4, §B.9; PRD REQ-123 b).
// ---------------------------------------------------------------------------

function nowOf(deps: { now?: () => Date }): Date {
  return (deps.now ?? (() => new Date()))();
}

/**
 * Clears the open `autonomy-demoted` alerts that match. Never throws: the
 * policy change it follows is already written, so a failure is one log line.
 */
function clearDemotionAlerts(home: string, match: (alert: Alert) => boolean, deps: AutonomyRpcDeps): void {
  try {
    createAlertStore(home, deps.now === undefined ? {} : { now: deps.now }).clearWhere((alert) => alert.kind === "autonomy-demoted" && match(alert));
  } catch (error) {
    logOf(deps)(`[paseo-bm] could not clear a demotion alert: ${errorText(error)}`);
  }
}

/** Clears the open alerts that match, after a policy change already written; a failure is one log line. */
function clearAlerts(home: string, match: (alert: Alert) => boolean, deps: AutonomyRpcDeps): void {
  try {
    createAlertStore(home, deps.now === undefined ? {} : { now: deps.now }).clearWhere(match);
  } catch (error) {
    logOf(deps)(`[paseo-bm] could not clear an alert after a policy change: ${errorText(error)}`);
  }
}

export interface DemotionDeps {
  /** The data folder. */
  home: string;
  now?: () => Date;
  log?: (message: string) => void;
}

export type DemotionResult =
  | { demoted: true; workspaceId: string; class: DecisionClass; alert: Alert | null }
  | { demoted: false; reason: string };

/** How each reversal kind reads in the alert. */
const REVERSED_HOW: Readonly<Record<ReversalKind, string>> = {
  "re-asked": "was asked again in the same request",
  overridden: "was overridden by you",
  reopened: "was reversed: a bead closed under it was reopened citing it",
};

/** A class in the owner's words, for a line written on the server: `Reversible technical`. */
function classWords(decisionClass: DecisionClass): string {
  const words = decisionClass.replace(/-/g, " ");
  return `${words.charAt(0).toUpperCase()}${words.slice(1)}`;
}

/** The alert's detail: which class went back to Shadow, and why (the decision's id is shown only on a tap). */
function demotionDetail(decision: Decision, decisionClass: DecisionClass, kind: ReversalKind): string {
  const answer = decision.answer!;
  const who =
    answer.by === "precedent" ? "your precedent" : answer.predictor === "orchestrator" ? "the Orchestrator" : "the recommended option";
  return (
    `${classWords(decisionClass)} decisions are back in Shadow: ${decision.id}, answered for you by ${who}, ${REVERSED_HOW[kind]}. ` +
    "They come to you again; Insights offers Delegate? once the class earns it anew."
  );
}

/**
 * Takes a delegated class back at once (§B.4, §B.9; PRD REQ-123 b), called
 * from every point that records a reversal: the materialiser's re-ask and
 * cited `br reopen` (§B.3) and the digest's Override (§B.7). When `decision`
 * was answered `by: policy | precedent` and its cell (the answer's class, else
 * the decision's) is `delegate`, the cell becomes `shadow`, stamped now, now
 * is the class's last demotion, and an `autonomy-demoted` alert is raised with
 * the class, the project and the reason. An answer of the owner, a cell that
 * is not `delegate` (already taken back, or never delegated) and a decision
 * not answered change nothing. It never touches a decision already delivered:
 * only what happens to the next decision of that class. Never throws: a
 * failure is one log line, and no alert is raised for a demotion that was not
 * written.
 */
export function demoteOnReversal(decision: Decision, kind: ReversalKind, deps: DemotionDeps): DemotionResult {
  const answer = decision.answer;
  if (decision.status !== "answered" || answer === null) return { demoted: false, reason: `decision ${decision.id} is not answered` };
  if (answer.by !== "policy" && answer.by !== "precedent") {
    return { demoted: false, reason: `decision ${decision.id} was answered by ${answer.by === "owner" ? "the owner" : answer.by}, not for the owner` };
  }
  const decisionClass = answer.class ?? decisionClassOf(decision);
  const { workspaceId } = decision;
  const now = nowOf(deps);
  let policy: AutonomyPolicy | null;
  try {
    policy = createAutonomyStore(deps.home).demote(workspaceId, decisionClass, now.toISOString());
  } catch (error) {
    logOf(deps)(`[paseo-bm] could not take ${decisionClass} in ${workspaceId} back to shadow after ${decision.id} ${kind}: ${errorText(error)}`);
    return { demoted: false, reason: "the policy could not be written" };
  }
  if (policy === null) return { demoted: false, reason: `${decisionClass} is not delegated in ${workspaceId}` };
  let alert: Alert | null = null;
  try {
    alert = createAlertStore(deps.home, { now: () => now }).raise({
      workspaceId,
      kind: "autonomy-demoted",
      subject: decisionClass,
      detail: demotionDetail(decision, decisionClass, kind),
    }).alert;
  } catch (error) {
    logOf(deps)(`[paseo-bm] ${decisionClass} in ${workspaceId} is back in shadow, but its Inbox alert failed: ${errorText(error)}`);
  }
  return { demoted: true, workspaceId, class: decisionClass, alert };
}

/**
 * Ends the `autonomy-demoted` alerts of the classes `settled` answered by the
 * owner that are eligible again (§B.9): a predictor's cell of that class,
 * counted from its demotion, passes `eligibility`. Called after every
 * settlement (the `onSettled` hook), since only an owner's answer can make a
 * class eligible. Reads the decisions only while such an alert is open. Never
 * throws; returns the keys it cleared.
 */
export function clearRenewedDemotions(settled: readonly Decision[], deps: AutonomyRpcDeps = {}): string[] {
  const answered = settled.filter((decision) => decision.status === "answered" && decision.answer?.by === "owner");
  if (answered.length === 0) return [];
  const home = dataHome(deps);
  if (home === null) return [];
  try {
    const keys = new Set(answered.map((decision) => alertKeyOf("autonomy-demoted", decision.workspaceId, decisionClassOf(decision))));
    const alerts = createAlertStore(home, deps.now === undefined ? {} : { now: deps.now });
    const open = alerts.list({ open: true, kinds: ["autonomy-demoted"] }).filter((alert) => keys.has(alert.key) && alert.workspaceId !== null);
    if (open.length === 0) return [];
    const policy = readAutonomyPolicy(deps);
    const decisions = createDecisionStore(home, { log: logOf(deps) });
    const now = nowOf(deps);
    const cleared: string[] = [];
    for (const workspaceId of new Set(open.map((alert) => alert.workspaceId!))) {
      const ledger = agreementLedger(decisions.list({ workspaceId, statuses: ["answered"] }), {
        workspaceId,
        ...(policy.demotions === undefined ? {} : { demotions: policy.demotions }),
      });
      for (const alert of open.filter((entry) => entry.workspaceId === workspaceId)) {
        const renewed = ledger.cells.some((cell) => cell.class === alert.subject && eligibility(cell, now).eligible);
        if (renewed && alerts.clear(alert.key)) cleared.push(alert.key);
      }
    }
    return cleared;
  } catch (error) {
    logOf(deps)(`[paseo-bm] could not check the demoted classes again: ${errorText(error)}`);
    return [];
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
  server.handle(autonomySetRpc, (input) => handleAutonomySet(input, deps));
  server.handle(autonomyResetRpc, (input) => handleAutonomyReset(input, deps));
  server.handle(autonomySetChallengerRpc, (input) => handleAutonomySetChallenger(input, deps));
  server.handle(autonomySetBoundaryRpc, (input) => handleAutonomySetBoundary(input, deps));
  server.handle(precedentsListRpc, (input) => handlePrecedentsList(input, deps));
  server.handle(precedentsSaveRpc, (input) => handlePrecedentsSave(input, deps));
  server.handle(precedentsEndRpc, (input) => handlePrecedentsEnd(input, deps));
}
