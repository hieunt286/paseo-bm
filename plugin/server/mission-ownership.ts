/**
 * One owner per request (mission runtime design §5.2, §5.3, ADR-033 decision
 * 4, REQ-206): the owner's cards that move requests between missions, both
 * applied through `transferRequests` (`mission-transfer.ts`).
 *
 * - **Merge** (`offerMerges`): a legacy one-repo mission (`createdBy:
 *   legacy`, goal `""`, exactly one repo) whose repo an open mission of the
 *   owner or the orchestrator holds gets one `m:` card on the holding mission,
 *   "Merge mission <legacy> (<repo>) into <code>", its "apply" option carrying
 *   `mission-merge { from }`. Offered when a mission is created, when a Main's
 *   `bm_mission_start` settles, when a repo is added, and once per plugin
 *   run for every open mission (`createLegacyMigration`); asked once per
 *   pair, so the owner's "keep as is" stands. Applying it moves every roster request of the legacy mission,
 *   closes it (`mergedInto`), and labels its Main `bm.replacedBy` with the
 *   holding mission's Main, titled "· merged into <code>": nothing is archived
 *   (ADR-005). Refused while a Worker of the legacy mission runs a turn
 *   (`busyRequestsOf`, §5.4).
 * - **Transfer** (`offerTransfer`): the source Main's `bm_mission_update {
 *   transfer: { to, requestIds, reason } }` opens an `m:` card on its mission
 *   whose "apply" option carries `mission-transfer`; the owner's tap moves them.
 *
 * Every card is answered through `decisions.answer` (`decision-rpc.ts`):
 * `ownershipAnswerRefusalsOf` first, nothing written on a refusal, then
 * `applyOwnershipDecision`. Never throws.
 */
import { join } from "node:path";
import { isAnswerable, type Decision } from "../shared/decisions";
import type { MissionMergeAction, MissionTransferAction } from "../shared/mission-change";
import { TRACES_DIR_NAME } from "./data-home";
import { REPLACED_BY_LABEL } from "./fallback-detect";
import { createMissionDecisionStore, missionOfDecisionId } from "./mission-decisions";
import { busyRequestsOf, createMissionRoster, stopActiveRequests } from "./mission-roster";
import { createMissionStore, journalQuietly, type Mission } from "./mission-store";
import { tellMain, type MissionAnswerDeps } from "./mission-tools";
import { transferRefusalsOf, transferRequests, type TransferDeps } from "./mission-transfer";
import { setAgentLabel, setAgentTitle, type PaseoCliDeps } from "./paseo-cli";
import { mergedMainTitleOf } from "./role-title";
import { errorText } from "./rpc-kit";
import { readWorkspaceMeta } from "./trace-store";

type OwnershipAction = MissionMergeAction | MissionTransferAction;

/** True for a legacy one-repo mission (§5.2). Pure. */
export function isLegacyMission(mission: Pick<Mission, "createdBy" | "charter">): boolean {
  return mission.createdBy === "legacy" && mission.charter.goal === "" && mission.charter.repos.length === 1;
}

/** The open legacy missions whose repo `holding` holds; none unless `holding` is an open mission of the owner or the orchestrator. Never throws. */
export function legacyOverlapsOf(home: string, holding: Mission): Mission[] {
  if (holding.state !== "open" || holding.createdBy === "legacy") return [];
  try {
    const store = createMissionStore(home);
    return store
      .list()
      .filter((entry) => entry.state === "open" && entry.missionId !== holding.missionId)
      .map((entry) => store.get(entry.missionId))
      .filter((mission): mission is Mission => mission !== null && mission.state === "open" && isLegacyMission(mission) && holding.charter.repos.includes(mission.charter.repos[0]!));
  } catch {
    return [];
  }
}

function repoNameOf(home: string, workspaceId: string): string {
  try {
    return readWorkspaceMeta({ tracesDir: join(home, TRACES_DIR_NAME) }, workspaceId)?.lastKnownName ?? workspaceId;
  } catch {
    return workspaceId;
  }
}

/** An `m:` card of `mission` asked by the plugin, "apply" carrying `action`, and "keep as is". */
function cardOf(id: string, mission: Mission, question: string, applyLabel: string, action: OwnershipAction, at: string, askedBy: string | null): Decision {
  return {
    id,
    workspaceId: mission.missionId,
    requestId: null,
    askedBy: { role: "plugin", agentId: askedBy },
    askedAt: at,
    round: null,
    question,
    subject: null,
    class: "scope",
    options: [
      { key: "apply", label: applyLabel, recommended: true, effects: [], action },
      { key: "keep", label: "Keep as is", recommended: false, effects: [] },
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

/** The ownership action the chosen option carries, or null. Pure. */
export function chosenOwnershipAction(decision: Decision, optionKey: string | null): OwnershipAction | null {
  const action = decision.options.find((option) => option.key === optionKey)?.action;
  return action?.kind === "mission-merge" || action?.kind === "mission-transfer" ? action : null;
}

/** True for an `m:` card one of whose options carries a merge or a transfer. Pure. */
export function isOwnershipCard(decision: Pick<Decision, "options">): boolean {
  return decision.options.some((option) => option.action?.kind === "mission-merge" || option.action?.kind === "mission-transfer");
}

/**
 * Opens the merge cards `missionId` is owed (see the module comment): one per
 * open legacy mission whose repo it holds, unless a card for that pair was
 * ever opened. Returns the cards opened. Never throws: a failure is one
 * log line.
 */
export function offerMerges(home: string, missionId: string, deps: { now: Date; log: (message: string) => void }): string[] {
  const opened: string[] = [];
  try {
    const holding = createMissionStore(home).get(missionId);
    if (holding === null) return [];
    const cards = createMissionDecisionStore(home);
    const earlier = cards.list(missionId);
    for (const legacy of legacyOverlapsOf(home, holding)) {
      // Asked once per pair: an open card waits, and a "keep as is" stands.
      const asked = earlier.some((decision) => decision.options.some((option) => option.action?.kind === "mission-merge" && option.action.from === legacy.missionId));
      if (asked) continue;
      const repo = legacy.charter.repos[0]!;
      const requests = createMissionRoster(home).list(legacy.missionId).length;
      const question = [
        `Merge mission ${legacy.code} (${repoNameOf(home, repo)}) into ${holding.code}`,
        `- mission ${holding.code} holds ${repoNameOf(home, repo)}, which the older one-repo mission ${legacy.code} also holds`,
        `- its ${requests === 1 ? "1 request moves" : `${requests} requests move`} to ${holding.code}, with their Workers`,
        `- mission ${legacy.code} closes; its Main is marked merged, never archived`,
      ].join("\n");
      const id = cards.nextId(missionId);
      cards.open(cardOf(id, holding, question, "Merge it", { kind: "mission-merge", missionId, from: legacy.missionId }, deps.now.toISOString(), null));
      journalQuietly(createMissionStore(home), missionId, { kind: "decision", by: "plugin", text: `The owner is asked on ${id} to merge mission ${legacy.code} into ${holding.code}.`, ref: id }, deps.log);
      opened.push(id);
    }
  } catch (error) {
    deps.log(`[paseo-bm] the merge cards of mission ${missionId} could not be opened: ${errorText(error)}`);
  }
  return opened;
}

/**
 * The transfer card the source Main asked (§5.3): refused (reasons) as
 * `transferRefusalsOf` refuses, or when an open card asks the same move; else
 * the card's id. Never throws.
 */
export function offerTransfer(
  home: string,
  source: Mission,
  transfer: { to: string; requestIds: readonly string[]; reason: string },
  deps: { now: Date; log: (message: string) => void; askedBy: string | null },
): { ok: true; decisionId: string } | { ok: false; reasons: string[] } {
  try {
    const reasons = transferRefusalsOf(home, { from: source.missionId, to: transfer.to, requestIds: transfer.requestIds });
    if (reasons.length > 0) return { ok: false, reasons };
    const target = createMissionStore(home).get(transfer.to)!;
    const cards = createMissionDecisionStore(home);
    const wanted = [...transfer.requestIds].sort().join(",");
    const same = cards
      .list(source.missionId)
      .find((decision) => isAnswerable(decision) && decision.options.some((option) => option.action?.kind === "mission-transfer" && option.action.to === transfer.to && [...option.action.requestIds].sort().join(",") === wanted));
    if (same !== undefined) return { ok: false, reasons: [`the owner's card ${same.id} asks this move already`] };
    const question = [
      `Move ${transfer.requestIds.length === 1 ? `request ${transfer.requestIds[0]}` : `requests ${transfer.requestIds.join(", ")}`} from mission ${source.code} to ${target.code}`,
      `- because ${transfer.reason.replace(/\s+/g, " ").slice(0, 300)}`,
      `- their Workers report to ${target.code}'s Main from then on`,
    ].join("\n");
    const id = cards.nextId(source.missionId);
    cards.open(cardOf(id, source, question, "Move them", { kind: "mission-transfer", missionId: source.missionId, to: transfer.to, requestIds: [...transfer.requestIds], reason: transfer.reason }, deps.now.toISOString(), deps.askedBy));
    journalQuietly(createMissionStore(home), source.missionId, { kind: "decision", by: "main", text: `The Main asked the owner (${id}) to move ${transfer.requestIds.join(", ")} to mission ${target.code}.`, ref: id }, deps.log);
    return { ok: true, decisionId: id };
  } catch (error) {
    return { ok: false, reasons: [`the card could not be opened: ${errorText(error)}`] };
  }
}

/** Why the owner's answer `optionKey` on an ownership card cannot be applied now; none for "keep" or words. Never throws. */
export async function ownershipAnswerRefusalsOf(decision: Decision, optionKey: string | null, paseo: unknown, home: string): Promise<string[]> {
  const action = chosenOwnershipAction(decision, optionKey);
  if (action === null) return [];
  try {
    if (action.kind === "mission-transfer") return transferRefusalsOf(home, { from: action.missionId, to: action.to, requestIds: action.requestIds });
    const store = createMissionStore(home);
    const holding = store.get(action.missionId);
    const legacy = store.get(action.from);
    const reasons: string[] = [];
    if (holding === null || holding.state !== "open") reasons.push(`mission ${holding?.code ?? action.missionId} is not open`);
    if (legacy === null || legacy.state !== "open") reasons.push(`mission ${legacy?.code ?? action.from} is closed already`);
    if (reasons.length > 0) return reasons;
    if (paseo === null || paseo === undefined) return ["paseo-bm has no connection to Paseo yet; try again in a moment"];
    const busy = await busyRequestsOf(home, paseo, action.from);
    if (busy.length > 0) reasons.push(`a Worker of mission ${legacy!.code} is running a turn (${busy.map((entry) => entry.requestId).join(", ")}); merge it once that turn ends`);
    return reasons;
  } catch (error) {
    return [`the missions cannot be read: ${errorText(error)}`];
  }
}

export interface OwnershipAnswerDeps extends MissionAnswerDeps {
  bindings?: TransferDeps["bindings"];
  cli?: PaseoCliDeps;
}

/**
 * After the owner's answer on an ownership card is recorded: the merge or the
 * transfer of the option they chose, only on the owner's own answer; keep as
 * is, or words, is a journal line and a word to the mission's Main. Never throws.
 */
export async function applyOwnershipDecision(decision: Decision, deps: OwnershipAnswerDeps): Promise<void> {
  const missionId = missionOfDecisionId(decision.id);
  const answer = decision.answer;
  if (missionId === null || answer === null || decision.status !== "answered") return;
  const store = createMissionStore(deps.home, { now: () => deps.now });
  const transferDeps: TransferDeps = {
    home: deps.home,
    now: deps.now,
    paseo: deps.paseo,
    log: deps.log,
    ...(deps.bindings === undefined ? {} : { bindings: deps.bindings }),
    ...(deps.cli === undefined ? {} : { cli: deps.cli }),
  };
  try {
    const action = answer.by === "owner" ? chosenOwnershipAction(decision, answer.optionKey) : null;
    if (action === null) {
      const how = answer.optionKey === null ? `answered in words: ${answer.words ?? ""}` : "kept things as they are";
      journalQuietly(store, missionId, { kind: "decision", by: "owner", text: `The owner ${how} (${decision.id}).`, ref: decision.id }, deps.log);
      await tellMain(missionId, decision.id, `The owner ${how} on card ${decision.id}.`, deps);
      return;
    }
    if (action.kind === "mission-transfer") {
      const done = await transferRequests({ from: action.missionId, to: action.to, requestIds: action.requestIds, reason: action.reason, by: "owner", ref: decision.id }, transferDeps);
      if (!done.ok) journalQuietly(store, missionId, { kind: "decision", by: "plugin", text: `${decision.id} could not be applied: ${done.reasons.join("; ")}`, ref: decision.id }, deps.log);
      return;
    }
    await merge(action, decision.id, store, transferDeps, deps);
  } catch (error) {
    deps.log(`[paseo-bm] applying ${decision.id} failed: ${errorText(error)}`);
  }
}

/** The merge (see the module comment). */
async function merge(action: MissionMergeAction, decisionId: string, store: ReturnType<typeof createMissionStore>, transferDeps: TransferDeps, deps: OwnershipAnswerDeps): Promise<void> {
  const holding = store.get(action.missionId);
  const legacy = store.get(action.from);
  if (holding === null || legacy === null) return;
  const requestIds = createMissionRoster(deps.home).list(legacy.missionId).map((entry) => entry.requestId);
  if (requestIds.length > 0) {
    const moved = await transferRequests({ from: legacy.missionId, to: holding.missionId, requestIds, reason: `mission ${legacy.code} merged into ${holding.code}`, by: "owner", ref: decisionId, tell: false }, transferDeps);
    if (!moved.ok) {
      journalQuietly(store, holding.missionId, { kind: "decision", by: "plugin", text: `${decisionId} could not be applied: ${moved.reasons.join("; ")}`, ref: decisionId }, deps.log);
      return;
    }
  }
  const closed = store.update(legacy.missionId, (mission) => ({ ...mission, state: "closed", closedAt: deps.now.toISOString(), mergedInto: holding.missionId }));
  if (!closed.ok) {
    journalQuietly(store, holding.missionId, { kind: "decision", by: "plugin", text: `${decisionId}: mission ${legacy.code} could not be closed: ${closed.reasons.join("; ")}`, ref: decisionId }, deps.log);
    return;
  }
  stopActiveRequests(deps.home, legacy.missionId, deps.log);
  journalQuietly(store, legacy.missionId, { kind: "charter", by: "owner", text: `Merged into mission ${holding.code} (${decisionId}).`, ref: holding.missionId }, deps.log);
  journalQuietly(store, holding.missionId, { kind: "charter", by: "owner", text: `Mission ${legacy.code} merged in (${decisionId}): ${requestIds.length === 0 ? "no request" : requestIds.join(", ")}.`, ref: legacy.missionId }, deps.log);
  if (legacy.mainId !== null && holding.mainId !== null) {
    const marked = await setAgentLabel(legacy.mainId, REPLACED_BY_LABEL, holding.mainId, deps.cli).catch((error: unknown) => ({ ok: false as const, reason: errorText(error) }));
    if (!marked.ok) deps.log(`[paseo-bm] the Main ${legacy.mainId} of the merged mission ${legacy.code} could not be marked: ${marked.reason}`);
    const titled = await setAgentTitle(legacy.mainId, mergedMainTitleOf(legacy.code, legacy.name, holding.code), deps.cli).catch((error: unknown) => ({ ok: false as const, reason: errorText(error) }));
    if (!titled.ok) deps.log(`[paseo-bm] the Main ${legacy.mainId} of the merged mission ${legacy.code} could not be retitled: ${titled.reason}`);
  }
  await tellMain(holding.missionId, decisionId, `The owner merged mission ${legacy.code} into yours: ${requestIds.length === 0 ? "it had no request" : `${requestIds.join(", ")} and their Workers report to you now`}.`, deps);
}
