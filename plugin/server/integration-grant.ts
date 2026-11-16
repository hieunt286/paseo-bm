/**
 * The owner's standing integration grant (delivery line design §4.3, ADR-035
 * decision 3): one yes per mission × repo lets the placement's Workers push
 * the mission branch to `origin` and open or update its merge request into
 * the integration branch. Committing on the branch needs no grant (§4.1);
 * merging stays on the forge.
 *
 * - **Asked once** (`openIntegrationCardIfNeeded`): the first time a
 *   placement's request reports `finished` with a commit and the placement
 *   has no grant, the plugin opens an `ownerOnly` `m:` card, subject
 *   `integration` (a code subject: no precedent answers it). Option a carries
 *   `integration.grant { missionId, repo }`, a mission action kind, so only
 *   the owner's own tap answers it: no policy, level, Main, Orchestrator or
 *   precedent. The plugin never opens a card for the repo twice; the owner
 *   asks again from the mission page (`askIntegrationAgain`, RPC
 *   `mission.integration.ask`) after "Not now" or a revoke.
 * - **Granted** (`applyIntegrationDecision`, from `decisions.answer`): the
 *   placement's `integration` becomes `granted`, scoped to its branch and
 *   target; the journal, the Main and the placement's live Workers
 *   (`BM-SETTINGS`) are told.
 * - **Used** (`integrationCoverOf`): the action boundary allows a request
 *   whose findings are all `integration` or `forgeRead` while the grant is
 *   `granted` and its scope matches the placement; each use is a journal
 *   line, nothing is spent. The Worker watch reads the same grant
 *   (`integrationWindowOf`): a push it covers raises no `danger`.
 * - **Revoked** (`revokeIntegration`, RPC `mission.integration.revoke`):
 *   `revokedAt` is set, the placement's live Workers get `BM-SETTINGS`, the
 *   journal a `decision` line.
 *
 * **The local merge** (ADR-045 decision 4, mission line plan §5.3) follows the
 * same card: one `ownerOnly` `m:` card per mission × repo, subject
 * `local-merge`, opened at the first `finished` that passes the finish gate
 * with a commit (`openLocalMergeCardIfNeeded`), its option a carrying
 * `integration.local-merge`, so only the owner's own tap grants. The grant is
 * `Placement.localMerge` on the mission branch's placement, and holds while its
 * target is the placement's (`localMergeHolds`). Its Yes and Revoke tell the
 * journal and the Main; Workers have nothing to change.
 *
 * Never throws: a failure is a refusal or one log line.
 */
import { UNSETTLED_STATUSES, type Decision } from "../shared/decisions";
import type { HeldFinding, MissionBranch } from "../shared/effectful-actions";
import type { IntegrationGrantAction, IntegrationLocalMergeAction } from "../shared/mission-change";
import { INTEGRATION_SUBJECT, LOCAL_MERGE_SUBJECT } from "../shared/question-subjects";
import { createMissionDecisionStore, missionOfDecisionId } from "./mission-decisions";
import { createMissionStore, journalQuietly, type Mission, type Placement } from "./mission-store";
import { tellMain, type MissionAnswerDeps } from "./mission-tools";
import { laneOf, placementEntryOf } from "./placements";
import { errorText } from "./rpc-kit";
import { integrationNotice, notifyPlacementWorkers, type SettingsNoticeDeps, type SettingsPaseo } from "./settings-notices";

/** The placement a workspace is, with its mission and the boundary's view of it (§4.2); null for any other workspace. Never throws. */
export function missionBranchOf(home: string | null, workspaceId: string | null): { missionId: string; placement: Placement; mission: MissionBranch } | null {
  if (home === null || workspaceId === null) return null;
  try {
    const entry = placementEntryOf(home, workspaceId);
    if (entry === null) return null;
    const placement = (createMissionStore(home).get(entry.missionId)?.placements ?? []).filter((place) => place.workspaceId === workspaceId).at(-1);
    if (placement === undefined || placement.directory === null) return null;
    return { missionId: entry.missionId, placement, mission: { directory: placement.directory, branch: placement.branch, target: placement.target, remote: "origin" } };
  } catch {
    return null;
  }
}

/** True while the placement's grant is `granted` and scoped to its branch and target on `origin`. Pure. */
export function grantHolds(placement: Pick<Placement, "branch" | "target" | "integration">): boolean {
  const grant = placement.integration;
  return grant !== null && grant.state === "granted" && grant.scope.remote === "origin" && grant.scope.branch === placement.branch && grant.scope.target === placement.target;
}

/**
 * The boundary's step after the one-time grants, before the policy (§4.3):
 * true when every finding is `integration` or `forgeRead` and the grant
 * holds. An unreadable finding is never covered. Pure.
 */
export function integrationCoverOf(findings: readonly HeldFinding[], placement: Pick<Placement, "branch" | "target" | "integration">): boolean {
  return grantHolds(placement) && findings.length > 0 && findings.every((finding) => !finding.unreadable && (finding.integration === true || finding.forgeRead === true));
}

/** When the placement's grant covered pushes: from `grantedAt`, until `revokedAt`; null when it never did (§4.3, the Worker watch). Pure. */
export function integrationWindowOf(placement: Pick<Placement, "branch" | "target" | "integration">): { grantedAt: string; revokedAt: string | null } | null {
  const grant = placement.integration;
  if (grant === null || grant.scope.branch !== placement.branch || grant.scope.target !== placement.target) return null;
  return { grantedAt: grant.grantedAt, revokedAt: grant.state === "revoked" ? (grant.revokedAt ?? grant.grantedAt) : null };
}

/** The Runtime facts line of a placement (design §3.4): `Integration: <branch> → <target>; commit: yes; push/MR: yes|no.`, the Runtime facts line's own text (`role-instructions.ts` `integrationLine`). Pure. */
export function integrationFactLine(placement: Pick<Placement, "branch" | "target" | "integration">): string {
  return `Integration: ${placement.branch} → ${placement.target}; commit: yes; push/MR: ${grantHolds(placement) ? "yes" : "no"}.`;
}

/** Journals one use of the grant by the boundary (§4.3): nothing is spent. Never throws. */
export function journalIntegrationUse(home: string, missionId: string, placement: Placement, use: { agentId: string; requestId: string | null; what: readonly string[] }, log: (message: string) => void): void {
  const decisionId = placement.integration?.decisionId;
  const text = `The integration grant${decisionId === undefined ? "" : ` ${decisionId}`} allowed ${use.what.join("; ")} for ${use.agentId}${use.requestId === null ? "" : ` (request ${use.requestId})`}.`;
  journalQuietly(createMissionStore(home), missionId, { kind: "decision", by: "plugin", text, ...(decisionId === undefined ? {} : { ref: decisionId }) }, log);
}

/** The card's question, word for word (§4.3). */
export function integrationQuestionOf(placement: Pick<Placement, "branch" | "target">): string {
  return `Push \`${placement.branch}\` and open its merge request into \`${placement.target}\`? Later pushes and updates of this merge request are then covered; merging stays on GitLab.`;
}

/** The integration grant action a card's option carries, or null. Pure. */
function grantActionOf(option: Decision["options"][number] | undefined): IntegrationGrantAction | null {
  return option?.action?.kind === "integration.grant" ? option.action : null;
}

/** True for the plugin's integration card: an `m:` card one of whose options carries `integration.grant`. Pure. */
export function isIntegrationCard(decision: Pick<Decision, "options">): boolean {
  return decision.options.some((option) => grantActionOf(option) !== null);
}

/** The integration card of the mission's placement (§4.3): `ownerOnly`, release, a "Yes" carrying the grant and a "Not now"; none recommended. Pure. */
export function integrationCardOf(id: string, missionId: string, placement: Placement, requestId: string | null, at: string): Decision {
  return {
    id,
    workspaceId: missionId,
    requestId,
    askedBy: { role: "plugin", agentId: null },
    askedAt: at,
    round: null,
    question: integrationQuestionOf(placement),
    subject: INTEGRATION_SUBJECT,
    class: "release",
    ownerOnly: true,
    options: [
      { key: "a", label: "Yes, for this mission and repository", recommended: false, effects: ["push"], action: { kind: "integration.grant", missionId, repo: placement.repo } },
      { key: "b", label: "Not now — keep committing locally", recommended: false, effects: ["none"] },
    ],
    status: "open",
    settledAt: null,
    needsConfirmation: null,
    answer: null,
    grant: null,
    delivery: null,
    supersedes: null,
    supersededBy: null,
  };
}

/** The newest placement of `repo` in the mission, with its index; null when it has none. */
function newestPlacement(mission: Mission, repo: string): { index: number; placement: Placement } | null {
  const placements = mission.placements ?? [];
  for (let index = placements.length - 1; index >= 0; index -= 1) if (placements[index]!.repo === repo) return { index, placement: placements[index]! };
  return null;
}

/**
 * Opens the owner's integration card for the mission's placement of `repo`
 * (§4.3) when it is `ready`, has no grant and no card for it was ever opened.
 * Called from `bm_report` on a `finished` that reports a commit. Returns the
 * card's id, or null when none was opened. Never throws.
 */
export function openIntegrationCardIfNeeded(home: string, missionId: string, repo: string, deps: { now: Date; log: (message: string) => void; requestId?: string | null }): string | null {
  try {
    const store = createMissionStore(home);
    const mission = store.get(missionId);
    if (mission === null || mission.state !== "open") return null;
    const found = newestPlacement(mission, repo);
    if (found === null || found.placement.state !== "ready" || found.placement.integration !== null) return null;
    const cards = createMissionDecisionStore(home);
    // Asked once: an open card waits, a "Not now" stands; the owner reopens it from the mission page.
    if (cards.list(missionId).some((decision) => decision.options.some((option) => grantActionOf(option)?.repo === repo))) return null;
    const id = cards.nextId(missionId);
    cards.open(integrationCardOf(id, missionId, found.placement, deps.requestId ?? null, deps.now.toISOString()));
    journalQuietly(store, missionId, { kind: "decision", by: "plugin", text: `The owner is asked on ${id} to allow pushing ${found.placement.branch} and its merge request into ${found.placement.target}.`, ref: id }, deps.log);
    return id;
  } catch (error) {
    deps.log(`[paseo-bm] the integration card of mission ${missionId} for ${repo} could not be opened: ${errorText(error)}`);
    return null;
  }
}

/**
 * The owner's "Ask me again" from the mission page (§4.3, RPC
 * `mission.integration.ask`): a fresh integration card for the mission's
 * placement of `repo`, as the plugin's first one. Refused when the mission is
 * not open, has no ready worktree of `repo`, the grant holds, or a card for it
 * is open. Never throws.
 */
export function askIntegrationAgain(home: string, missionId: string, repo: string, deps: { now: Date; log: (message: string) => void }): { ok: true; decisionId: string } | { ok: false; reasons: string[] } {
  try {
    const store = createMissionStore(home);
    const mission = store.get(missionId);
    if (mission === null) return { ok: false, reasons: [`unknown mission ${missionId}`] };
    if (mission.state !== "open") return { ok: false, reasons: [`mission ${mission.code} is not open`] };
    const found = newestPlacement(mission, repo);
    if (found === null) return { ok: false, reasons: [`mission ${mission.code} has no worktree of ${repo}`] };
    if (found.placement.state !== "ready") return { ok: false, reasons: [`the worktree of ${repo} in mission ${mission.code} is ${found.placement.state}`] };
    if (found.placement.integration?.state === "granted") return { ok: false, reasons: [`push and merge request are already allowed for ${found.placement.branch}; nothing was asked`] };
    const cards = createMissionDecisionStore(home);
    const open = cards.list(missionId, UNSETTLED_STATUSES).find((decision) => decision.options.some((option) => grantActionOf(option)?.repo === repo));
    if (open !== undefined) return { ok: false, reasons: [`${open.id} already asks you about ${found.placement.branch}; nothing was asked`] };
    const id = cards.nextId(missionId);
    cards.open(integrationCardOf(id, missionId, found.placement, null, deps.now.toISOString()));
    journalQuietly(store, missionId, { kind: "decision", by: "owner", text: `The owner asked again on ${id} to allow pushing ${found.placement.branch} and its merge request into ${found.placement.target}.`, ref: id }, deps.log);
    return { ok: true, decisionId: id };
  } catch (error) {
    return { ok: false, reasons: [`the mission cannot be written: ${errorText(error)}`] };
  }
}

/** Why the owner's answer `optionKey` on an integration card cannot be applied now; none for "Not now" or words. Never throws. */
export function integrationAnswerRefusalsOf(decision: Decision, optionKey: string | null, home: string): string[] {
  const chosen = decision.options.find((option) => option.key === optionKey);
  const action = grantActionOf(chosen) ?? localMergeActionOf(chosen);
  if (action === null) return [];
  try {
    const mission = createMissionStore(home).get(action.missionId);
    if (mission === null || mission.state !== "open") return [`mission ${mission?.code ?? action.missionId} is not open`];
    const found = newestPlacement(mission, action.repo);
    if (found === null) return [`mission ${mission.code} has no worktree of ${action.repo}`];
    if (found.placement.state === "retired" || found.placement.state === "archived" || found.placement.state === "failed") return [`the worktree of ${action.repo} in mission ${mission.code} is ${found.placement.state}`];
    return [];
  } catch (error) {
    return [`the mission cannot be read: ${errorText(error)}`];
  }
}

export interface IntegrationDeps {
  home: string;
  now: Date;
  log: (message: string) => void;
  /** The RPC's Paseo handle: the placement's Workers and the Main are told through it. */
  paseo?: unknown;
  cli?: MissionAnswerDeps["cli"];
  /** The notice queue's enqueue; the default queue otherwise (tests pin it). */
  enqueue?: SettingsNoticeDeps["enqueue"];
}

/** Writes the placement `find` picks as `next` makes it; the placement after the write, or the refusal. */
function writePlacement(home: string, missionId: string, repo: string, find: (mission: Mission, repo: string) => { index: number; placement: Placement } | null, next: (placement: Placement) => Placement | { refusal: string }): { ok: true; placement: Placement } | { ok: false; reasons: string[] } {
  const out: { written: Placement | null; refusal: string | null } = { written: null, refusal: null };
  const result = createMissionStore(home).update(missionId, (mission) => {
    const found = find(mission, repo);
    if (found === null) return { reasons: [`mission ${mission.code} has no worktree of ${repo}`] };
    const written = next(found.placement);
    if ("refusal" in written) {
      out.refusal = written.refusal;
      return null;
    }
    out.written = written;
    return { ...mission, placements: (mission.placements ?? []).map((placement, index) => (index === found.index ? written : placement)) };
  });
  if (out.refusal !== null) return { ok: false, reasons: [out.refusal] };
  if (!result.ok) return { ok: false, reasons: result.reasons };
  return out.written === null ? { ok: false, reasons: [`mission ${missionId} has no worktree of ${repo}`] } : { ok: true, placement: out.written };
}

/** Writes the placement's grant as `next` makes it; the placement after the write, or the refusal. */
function writeGrant(home: string, missionId: string, repo: string, next: (placement: Placement) => Placement["integration"] | { refusal: string }): { ok: true; placement: Placement } | { ok: false; reasons: string[] } {
  return writePlacement(home, missionId, repo, newestPlacement, (placement) => {
    const integration = next(placement);
    return integration !== null && "refusal" in integration ? integration : { ...placement, integration };
  });
}

/** Tells the placement's live Workers their new `Integration:` line (§3.4); 0 without a Paseo handle or workspace. */
async function notifyWorkers(placement: Placement, deps: IntegrationDeps): Promise<number> {
  const paseo = deps.paseo as SettingsPaseo | null | undefined;
  if (placement.workspaceId === null || typeof paseo?.agents?.list !== "function") return 0;
  return notifyPlacementWorkers(placement.workspaceId, integrationNotice(integrationFactLine(placement)), paseo, { log: deps.log, ...(deps.enqueue === undefined ? {} : { enqueue: deps.enqueue }) });
}

/**
 * After the owner's answer on an integration card is recorded (§4.3): on
 * their own "Yes", the placement's grant becomes `granted` and the Workers
 * and the Main are told; "Not now" or words is a journal line and a word to
 * the Main. Never throws.
 */
export async function applyIntegrationDecision(decision: Decision, deps: IntegrationDeps): Promise<void> {
  const missionId = missionOfDecisionId(decision.id);
  const answer = decision.answer;
  if (missionId === null || answer === null || decision.status !== "answered") return;
  const store = createMissionStore(deps.home, { now: () => deps.now });
  const tell: MissionAnswerDeps = { home: deps.home, now: deps.now, log: deps.log, ...(deps.paseo === undefined ? {} : { paseo: deps.paseo }), ...(deps.cli === undefined ? {} : { cli: deps.cli }) };
  try {
    const action = answer.by === "owner" ? grantActionOf(decision.options.find((option) => option.key === answer.optionKey)) : null;
    if (action === null) {
      const how = answer.optionKey === null ? `answered in words: ${answer.words ?? ""}` : "chose not now: the branch stays local";
      journalQuietly(store, missionId, { kind: "decision", by: "owner", text: `On integration (${decision.id}) the owner ${how}.`, ref: decision.id }, deps.log);
      await tellMain(missionId, decision.id, `On integration card ${decision.id} the owner ${how}.`, tell);
      return;
    }
    const at = deps.now.toISOString();
    const written = writeGrant(deps.home, missionId, action.repo, (placement) => ({
      state: "granted",
      decisionId: decision.id,
      grantedAt: at,
      revokedAt: null,
      scope: { remote: "origin", branch: placement.branch, target: placement.target },
      mr: placement.integration?.mr ?? null,
    }));
    if (!written.ok) {
      journalQuietly(store, missionId, { kind: "decision", by: "plugin", text: `${decision.id} could not be applied: ${written.reasons.join("; ")}`, ref: decision.id }, deps.log);
      return;
    }
    const { branch, target } = written.placement;
    journalQuietly(store, missionId, { kind: "decision", by: "owner", text: `The owner allowed pushing ${branch} and its merge request into ${target} (${decision.id}).`, ref: decision.id }, deps.log);
    await notifyWorkers(written.placement, deps);
    await tellMain(missionId, decision.id, `The owner allowed pushing ${branch} and its merge request into ${target} on card ${decision.id}; merging stays on the forge.`, tell);
  } catch (error) {
    deps.log(`[paseo-bm] applying ${decision.id} failed: ${errorText(error)}`);
  }
}

/**
 * The owner's revoke (§4.3, `mission.integration.revoke`): the placement's
 * grant becomes `revoked` with `revokedAt`, its live Workers get
 * `BM-SETTINGS`, the journal a `decision` line. Refused when the mission has
 * no worktree of `repo` or no grant to revoke. Never throws.
 */
export async function revokeIntegration(missionId: string, repo: string, deps: IntegrationDeps): Promise<{ ok: true; placement: Placement; notified: number } | { ok: false; reasons: string[] }> {
  try {
    const at = deps.now.toISOString();
    const written = writeGrant(deps.home, missionId, repo, (placement) =>
      placement.integration?.state === "granted" ? { ...placement.integration, state: "revoked", revokedAt: at } : { refusal: `push and merge request are not allowed for ${placement.branch}; nothing was changed` },
    );
    if (!written.ok) return written;
    const store = createMissionStore(deps.home, { now: () => deps.now });
    journalQuietly(store, missionId, { kind: "decision", by: "owner", text: `The owner revoked pushing ${written.placement.branch} and its merge request into ${written.placement.target}.`, ...(written.placement.integration === null ? {} : { ref: written.placement.integration.decisionId }) }, deps.log);
    return { ok: true, placement: written.placement, notified: await notifyWorkers(written.placement, deps) };
  } catch (error) {
    return { ok: false, reasons: [`the mission cannot be written: ${errorText(error)}`] };
  }
}

// ---------------------------------------------------------------------------
// The local merge (ADR-045 decision 4).
// ---------------------------------------------------------------------------

/** True while the placement's local-merge grant is `granted` and names its target. Pure. */
export function localMergeHolds(placement: Pick<Placement, "target" | "localMerge">): boolean {
  return placement.localMerge?.state === "granted" && placement.localMerge.target === placement.target;
}

/** The local-merge card's question, word for word. */
export function localMergeQuestionOf(placement: Pick<Placement, "branch" | "target">): string {
  return `Merge \`${placement.branch}\` into your local \`${placement.target}\` by fast-forward whenever a request passes its checks? Nothing is pushed; push and tag stay yours.`;
}

/** The local-merge action a card's option carries, or null. Pure. */
function localMergeActionOf(option: Decision["options"][number] | undefined): IntegrationLocalMergeAction | null {
  return option?.action?.kind === "integration.local-merge" ? option.action : null;
}

/** True for the plugin's local-merge card: an `m:` card one of whose options carries `integration.local-merge`. Pure. */
export function isLocalMergeCard(decision: Pick<Decision, "options">): boolean {
  return decision.options.some((option) => localMergeActionOf(option) !== null);
}

/** The local-merge card of the mission branch's placement: `ownerOnly`, release, a "Yes" carrying the grant and a "Not now"; none recommended. Pure. */
export function localMergeCardOf(id: string, missionId: string, placement: Placement, requestId: string | null, at: string): Decision {
  return {
    ...integrationCardOf(id, missionId, placement, requestId, at),
    question: localMergeQuestionOf(placement),
    subject: LOCAL_MERGE_SUBJECT,
    options: [
      { key: "a", label: "Yes, for this mission and repository", recommended: false, effects: ["commit"], action: { kind: "integration.local-merge", missionId, repo: placement.repo } },
      { key: "b", label: "Not now — keep the work on its branch", recommended: false, effects: ["none"] },
    ],
  };
}

/** The mission branch's placement of `repo`, with its index; null when it has none. */
function missionBranchPlacement(mission: Mission, repo: string): { index: number; placement: Placement } | null {
  const placements = mission.placements ?? [];
  for (let index = placements.length - 1; index >= 0; index -= 1) if (placements[index]!.repo === repo && laneOf(placements[index]!) === 1) return { index, placement: placements[index]! };
  return null;
}

/** A local-merge card of `repo` in `cards`. */
const asksLocalMergeOf = (decision: Decision, repo: string): boolean => decision.options.some((option) => localMergeActionOf(option)?.repo === repo);

/**
 * Opens the owner's local-merge card for the mission's `repo` when its mission
 * branch's placement is `ready`, has no grant and no card for it was ever
 * opened. Called from `bm_report` on a `finished` that passed the finish gate
 * with a commit. Returns the card's id, or null when none was opened. Never
 * throws.
 */
export function openLocalMergeCardIfNeeded(home: string, missionId: string, repo: string, deps: { now: Date; log: (message: string) => void; requestId?: string | null }): string | null {
  try {
    const store = createMissionStore(home);
    const mission = store.get(missionId);
    if (mission === null || mission.state !== "open") return null;
    const found = missionBranchPlacement(mission, repo);
    if (found === null || found.placement.state !== "ready" || found.placement.localMerge !== undefined) return null;
    const cards = createMissionDecisionStore(home);
    // Asked once: an open card waits, a "Not now" stands; the owner reopens it from the mission page.
    if (cards.list(missionId).some((decision) => asksLocalMergeOf(decision, repo))) return null;
    const id = cards.nextId(missionId);
    cards.open(localMergeCardOf(id, missionId, found.placement, deps.requestId ?? null, deps.now.toISOString()));
    journalQuietly(store, missionId, { kind: "decision", by: "plugin", text: `The owner is asked on ${id} to allow fast-forwarding ${found.placement.target} to what ${found.placement.branch} passes.`, ref: id }, deps.log);
    return id;
  } catch (error) {
    deps.log(`[paseo-bm] the local-merge card of mission ${missionId} for ${repo} could not be opened: ${errorText(error)}`);
    return null;
  }
}

/**
 * The owner's "Ask me again" for the local merge (`mission.integration.ask`,
 * `what: "local-merge"`): a fresh card, as the plugin's first one. Refused when
 * the mission is not open, has no ready worktree of `repo`, the grant holds, or
 * a card for it is open. Never throws.
 */
export function askLocalMergeAgain(home: string, missionId: string, repo: string, deps: { now: Date; log: (message: string) => void }): { ok: true; decisionId: string } | { ok: false; reasons: string[] } {
  try {
    const store = createMissionStore(home);
    const mission = store.get(missionId);
    if (mission === null) return { ok: false, reasons: [`unknown mission ${missionId}`] };
    if (mission.state !== "open") return { ok: false, reasons: [`mission ${mission.code} is not open`] };
    const found = missionBranchPlacement(mission, repo);
    if (found === null) return { ok: false, reasons: [`mission ${mission.code} has no worktree of ${repo}`] };
    if (found.placement.state !== "ready") return { ok: false, reasons: [`the worktree of ${repo} in mission ${mission.code} is ${found.placement.state}`] };
    if (localMergeHolds(found.placement)) return { ok: false, reasons: [`the local merge into ${found.placement.target} is already allowed; nothing was asked`] };
    const cards = createMissionDecisionStore(home);
    const open = cards.list(missionId, UNSETTLED_STATUSES).find((decision) => asksLocalMergeOf(decision, repo));
    if (open !== undefined) return { ok: false, reasons: [`${open.id} already asks you about the local merge into ${found.placement.target}; nothing was asked`] };
    const id = cards.nextId(missionId);
    cards.open(localMergeCardOf(id, missionId, found.placement, null, deps.now.toISOString()));
    journalQuietly(store, missionId, { kind: "decision", by: "owner", text: `The owner asked again on ${id} to allow fast-forwarding ${found.placement.target} to what ${found.placement.branch} passes.`, ref: id }, deps.log);
    return { ok: true, decisionId: id };
  } catch (error) {
    return { ok: false, reasons: [`the mission cannot be written: ${errorText(error)}`] };
  }
}

/**
 * After the owner's answer on a local-merge card is recorded: on their own
 * "Yes", the mission branch's placement gets the grant and the journal and the
 * Main are told; "Not now" or words is a journal line and a word to the Main.
 * Never throws.
 */
export async function applyLocalMergeDecision(decision: Decision, deps: IntegrationDeps): Promise<void> {
  const missionId = missionOfDecisionId(decision.id);
  const answer = decision.answer;
  if (missionId === null || answer === null || decision.status !== "answered") return;
  const store = createMissionStore(deps.home, { now: () => deps.now });
  const tell: MissionAnswerDeps = { home: deps.home, now: deps.now, log: deps.log, ...(deps.paseo === undefined ? {} : { paseo: deps.paseo }), ...(deps.cli === undefined ? {} : { cli: deps.cli }) };
  try {
    const action = answer.by === "owner" ? localMergeActionOf(decision.options.find((option) => option.key === answer.optionKey)) : null;
    if (action === null) {
      const how = answer.optionKey === null ? `answered in words: ${answer.words ?? ""}` : "chose not now: nothing is merged";
      journalQuietly(store, missionId, { kind: "decision", by: "owner", text: `On the local merge (${decision.id}) the owner ${how}.`, ref: decision.id }, deps.log);
      await tellMain(missionId, decision.id, `On local-merge card ${decision.id} the owner ${how}.`, tell);
      return;
    }
    const at = deps.now.toISOString();
    const written = writePlacement(deps.home, missionId, action.repo, missionBranchPlacement, (placement) => ({ ...placement, localMerge: { state: "granted", decisionId: decision.id, grantedAt: at, revokedAt: null, target: placement.target } }));
    if (!written.ok) {
      journalQuietly(store, missionId, { kind: "decision", by: "plugin", text: `${decision.id} could not be applied: ${written.reasons.join("; ")}`, ref: decision.id }, deps.log);
      return;
    }
    const { branch, target } = written.placement;
    journalQuietly(store, missionId, { kind: "decision", by: "owner", text: `The owner allowed fast-forwarding ${target} to what ${branch} passes (${decision.id}).`, ref: decision.id }, deps.log);
    await tellMain(missionId, decision.id, `The owner allowed fast-forwarding the local ${target} to what ${branch} passes, on card ${decision.id}; nothing is pushed.`, tell);
  } catch (error) {
    deps.log(`[paseo-bm] applying ${decision.id} failed: ${errorText(error)}`);
  }
}

/**
 * The owner's revoke of the local merge (`mission.integration.revoke`, `what:
 * "local-merge"`): `revokedAt` is set and the journal gets a `decision` line.
 * Refused when the mission has no worktree of `repo` or no grant to revoke.
 * Never throws.
 */
export function revokeLocalMerge(missionId: string, repo: string, deps: Pick<IntegrationDeps, "home" | "now" | "log">): { ok: true; placement: Placement } | { ok: false; reasons: string[] } {
  try {
    const at = deps.now.toISOString();
    const written = writePlacement(deps.home, missionId, repo, missionBranchPlacement, (placement) =>
      placement.localMerge?.state === "granted" ? { ...placement, localMerge: { ...placement.localMerge, state: "revoked", revokedAt: at } } : { refusal: `the local merge into ${placement.target} is not allowed; nothing was changed` },
    );
    if (!written.ok) return written;
    const store = createMissionStore(deps.home, { now: () => deps.now });
    journalQuietly(store, missionId, { kind: "decision", by: "owner", text: `The owner revoked fast-forwarding ${written.placement.target} to what ${written.placement.branch} passes.`, ...(written.placement.localMerge === undefined ? {} : { ref: written.placement.localMerge.decisionId }) }, deps.log);
    return written;
  } catch (error) {
    return { ok: false, reasons: [`the mission cannot be written: ${errorText(error)}`] };
  }
}
