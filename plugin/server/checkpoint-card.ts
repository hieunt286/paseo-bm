/**
 * The owner's checkpoint card (delivery line design §4.8 steps 2, 4 and 5):
 * an `ownerOnly` `m:` card the plugin asks itself, one per repo whose shared
 * checkout holds the work of missions from before the cut-over.
 *
 * - **Offered** (`offerCheckpoints`, at the first Paseo handle of a run, then
 *   at most every ten minutes) once no mission Worker runs a turn in the
 *   repo's root: a "Checkpoint now" and a "Not now". While one does, the card
 *   says so: "Ask me again once they finish" (recommended) and "Checkpoint
 *   now anyway", with the warning that later shared-tree edits need a
 *   follow-up checkpoint.
 * - **A follow-up** is offered when a request in the root finished after the
 *   newest checkpoint and the root differs from it (read-only git): parented
 *   on that checkpoint branch.
 * - **The tap** (`prepareCheckpointAnswer`, from `decisions.answer`, before
 *   the answer is stored): the owner's own option that makes a checkpoint
 *   runs `checkpoint.ts` `makeCheckpoint`; when git refuses, nothing is
 *   answered and the card stays open. `applyCheckpointDecision` records the
 *   outcome, the journal of each mission it was for, and tells their Mains.
 *
 * The advice is the owner's action, never the plugin's: push the checkpoint
 * branch and merge its own merge request first. Never throws.
 */
import { existsSync } from "node:fs";
import { MAX_DECISION_TEXT_CHARS, answerDecision, type AnswerInput, type Decision, type DecisionOption } from "../shared/decisions";
import {
  addCheckpointOffer,
  cutOverSince,
  isOfferOpen,
  latestCheckpointOf,
  makeCheckpoint,
  offerOfCard,
  checkpointOffers,
  rootDiffersFrom,
  rootHasWork,
  settleCheckpointOffer,
  type CheckpointGit,
  type CheckpointOffer,
  type MadeCheckpoint,
} from "./checkpoint";
import { createMissionDecisionStore } from "./mission-decisions";
import { busyRequestsOf, createMissionRoster, type RosterEntry } from "./mission-roster";
import { createMissionStore, journalQuietly, type Mission } from "./mission-store";
import { tellMain, type MissionAnswerDeps } from "./mission-tools";
import { listedWorkspaces, type DashboardPaseo } from "./paseo-directory";
import { placementModeOn } from "./placement-create";
import { placementEntryOf } from "./placements";
import { runGit, type GitRunner } from "./repo-tool";
import { createRequestRegistry } from "./request-registry";
import { dataHome, errorText } from "./rpc-kit";

/** The card's subject: a plugin question no precedent answers (`ownerOnly`). */
export const CHECKPOINT_SUBJECT = "worktree-checkpoint";
const OFFER_EVERY_MS = 10 * 60_000;

export interface CheckpointCardDeps {
  log: (message: string) => void;
  /** Read-only git; `runGit` by default. */
  git?: GitRunner;
  now?: () => Date;
}

/** True for the plugin's checkpoint card: an `m:` card the plugin asked and an offer names. Never throws. */
export function isCheckpointCard(home: string, decision: Pick<Decision, "id" | "askedBy">): boolean {
  return decision.askedBy.role === "plugin" && offerOfCard(home, decision.id) !== null;
}

/** True when `optionKey` on the offer's card makes a checkpoint: "Checkpoint now" (a), or "Checkpoint now anyway" (b) while a Worker ran. Pure. */
export function makesCheckpoint(offer: Pick<CheckpointOffer, "busy">, optionKey: string | null): boolean {
  return optionKey === (offer.busy ? "b" : "a");
}

const codesOf = (missions: readonly Pick<Mission, "code">[]): string => missions.map((mission) => mission.code).join(", ");

/** The card's question (§4.8 steps 2 and 4), within the decision text cap. Pure. */
export function checkpointQuestionOf(offer: Pick<CheckpointOffer, "name" | "directory" | "parent">, missions: readonly Pick<Mission, "code">[], running: readonly string[], finished: string | null): string {
  const lines =
    offer.parent === null
      ? [
          `The shared checkout of ${offer.name} (${offer.directory}) holds the work of missions ${codesOf(missions)}; each mission now gets its own worktree and branch.`,
          "A checkpoint saves the checkout as it is — its commits, uncommitted and untracked files; ignored files stay out — on a new branch bm/checkpoint-<today's date>, without touching your HEAD, index or working tree. These missions' worktrees then branch from it.",
        ]
      : [
          `${finished ?? "A request"} finished with changes in the shared checkout of ${offer.name} (${offer.directory}) after the checkpoint ${offer.parent}.`,
          `A follow-up checkpoint saves the checkout as it is now on a new branch bm/checkpoint-<today's date>, parented on ${offer.parent}, without touching your HEAD, index or working tree. Worktrees made from now on branch from it.`,
        ];
  if (running.length > 0) lines.push(`Still working in it: ${running.join(", ")}. A checkpoint now misses what they change later; that needs a follow-up checkpoint.`);
  lines.push("Then, yours: push the checkpoint branch and merge its own merge request first; each mission's merge request then shows only its own changes. Tidying the shared checkout stays yours.");
  return lines.join("\n").slice(0, MAX_DECISION_TEXT_CHARS);
}

/** The card (§4.8 step 2): `ownerOnly`, data; options by whether a mission Worker still runs in the root. Pure. */
export function checkpointCardOf(id: string, missionId: string, offer: Pick<CheckpointOffer, "name" | "directory" | "parent" | "busy">, question: string, at: string): Decision {
  const option = (key: string, label: string, recommended = false): DecisionOption => ({ key, label, recommended, effects: [] });
  return {
    id,
    workspaceId: missionId,
    requestId: null,
    askedBy: { role: "plugin", agentId: null },
    askedAt: at,
    round: null,
    question,
    subject: CHECKPOINT_SUBJECT,
    class: "data",
    ownerOnly: true,
    options: offer.busy
      ? [option("a", "Ask me again once they finish", true), option("b", "Checkpoint now anyway")]
      : [option("a", offer.parent === null ? "Checkpoint now" : "Make the follow-up checkpoint", true), option("b", "Not now")],
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

/** The open missions, newest state read. Never throws. */
function openMissions(home: string): Mission[] {
  try {
    const store = createMissionStore(home);
    return store.list().flatMap((entry) => {
      if (entry.state !== "open") return [];
      const mission = store.get(entry.missionId);
      return mission !== null && mission.state === "open" ? [mission] : [];
    });
  } catch {
    return [];
  }
}

/** The newest request of `missions` living in the root `repo` that finished after `after`, as "<request> (mission <code>)"; null when none. */
function finishedInRootAfter(home: string, missions: readonly Mission[], repo: string, after: number): { text: string; missionId: string } | null {
  const registry = createRequestRegistry(home, { log: () => {} });
  let newest: { at: number; text: string; missionId: string } | null = null;
  for (const mission of missions) {
    for (const entry of createMissionRoster(home).list(mission.missionId)) {
      if (entry.workspaceId !== repo) continue;
      const at = Date.parse(registry.get(repo, entry.requestId)?.finishedAt ?? "");
      if (Number.isFinite(at) && at > after && (newest === null || at > newest.at)) newest = { at, text: `${entry.requestId} (mission ${mission.code})`, missionId: mission.missionId };
    }
  }
  return newest;
}

/**
 * Opens the checkpoint cards due now (see the module comment): at most one
 * open card per repo. Returns the ids opened. Never throws.
 */
export async function offerCheckpoints(home: string, paseo: unknown, deps: CheckpointCardDeps): Promise<string[]> {
  const opened: string[] = [];
  const now = deps.now ?? (() => new Date());
  const git = deps.git ?? runGit;
  try {
    if (!placementModeOn(home)) return opened;
    const since = cutOverSince(home);
    const missions = openMissions(home);
    const repos = [...new Set(missions.flatMap((mission) => mission.charter.repos))].filter((repo) => placementEntryOf(home, repo) === null);
    if (repos.length === 0) return opened;
    const listed = await listedWorkspaces(paseo as DashboardPaseo);
    if (listed === null) return opened;
    const running = new Map<string, RosterEntry[]>();
    const runningOf = async (missionId: string) => {
      // Running a turn now (`busyRequestsOf`): a Worker idle between turns does not hold the offer back forever.
      if (!running.has(missionId)) running.set(missionId, await busyRequestsOf(home, paseo, missionId).catch(() => []));
      return running.get(missionId)!;
    };
    for (const repo of repos) {
      const root = listed.find((entry) => entry.id === repo && !entry.archived);
      if (root?.directory === undefined || root.directory === null || !existsSync(root.directory)) continue;
      const offers = checkpointOffers(home, repo);
      const last = offers.at(-1);
      if (last !== undefined && isOfferOpen(home, last)) continue;
      const of = missions.filter((mission) => mission.charter.repos.includes(repo));
      const made = latestCheckpointOf(home, repo);
      const again = last !== undefined && (last.outcome === undefined || last.outcome.kind === "later" || last.outcome.kind === "failed");
      let parent: string | null = null;
      let missionsFor: Mission[] = of;
      let finished: { text: string; missionId: string } | null = null;
      if (made === null) {
        // The first checkpoint: for the missions from before the cut-over, while the root holds work.
        if (last !== undefined && !again) continue;
        missionsFor = since === null ? [] : of.filter((mission) => Date.parse(mission.createdAt) < Date.parse(since));
        if (missionsFor.length === 0 || !(await rootHasWork(git, root.directory))) continue;
      } else if (again) {
        parent = last.parent ?? made.branch;
      } else {
        // A follow-up (§4.8 step 5): a request in the root finished after the newest checkpoint (or its last offer) and changed the root.
        finished = finishedInRootAfter(home, of, repo, Math.max(Date.parse(made.at), Date.parse(last?.openedAt ?? made.at)));
        if (finished === null || (await rootDiffersFrom(git, root.directory, made.branch)) !== true) continue;
        parent = made.branch;
      }
      const busy = (await Promise.all(missionsFor.map(async (mission) => (await runningOf(mission.missionId)).filter((entry) => entry.workspaceId === repo).map((entry) => `${entry.requestId} (mission ${mission.code})`)))).flat();
      // "Ask me again once they finish": asked again once none runs.
      if (last?.outcome?.kind === "later" && busy.length > 0) continue;
      const cardMission = finished?.missionId ?? [...missionsFor].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))[0]?.missionId;
      if (cardMission === undefined) continue;
      const cards = createMissionDecisionStore(home);
      const at = now().toISOString();
      const offer: CheckpointOffer = {
        repo,
        directory: root.directory,
        name: root.directory.split("/").filter((part) => part !== "").at(-1) ?? repo,
        card: cards.nextId(cardMission),
        missionIds: missionsFor.map((mission) => mission.missionId),
        openedAt: at,
        parent,
        busy: busy.length > 0,
      };
      // The offer first: a card no offer names would be answered as an ordinary mission card.
      addCheckpointOffer(home, offer);
      cards.open(checkpointCardOf(offer.card, cardMission, offer, checkpointQuestionOf(offer, missionsFor, busy, finished?.text ?? null), at));
      journalQuietly(createMissionStore(home, { now }), cardMission, { kind: "decision", by: "plugin", text: `The owner is asked on ${offer.card} to checkpoint the shared checkout of ${offer.name}${parent === null ? "" : ` again (after ${parent})`}.`, ref: offer.card }, deps.log);
      opened.push(offer.card);
    }
  } catch (error) {
    deps.log(`[paseo-bm] the checkpoint cards could not be offered: ${errorText(error)}`);
  }
  return opened;
}

/**
 * Before the owner's answer on a checkpoint card is stored (§4.8 step 2): an
 * option that makes a checkpoint runs it now, on this tap, so a refusal of
 * git leaves the card open. `refusals` when it could not be made; `made`
 * when it was. Nothing runs for any other card, option, or an answer the
 * card would refuse. Never throws.
 */
export async function prepareCheckpointAnswer(
  home: string,
  decision: Decision,
  input: Omit<AnswerInput, "by">,
  deps: { git?: CheckpointGit } = {},
): Promise<{ refusals: string[]; made: MadeCheckpoint | null }> {
  const offer = offerOfCard(home, decision.id);
  if (offer === null || !makesCheckpoint(offer, input.optionKey ?? null) || !answerDecision(decision, input).ok) return { refusals: [], made: null };
  if (!existsSync(offer.directory)) return { refusals: [`the shared checkout ${offer.directory} is gone; nothing was made`], made: null };
  const missions = offer.missionIds.flatMap((missionId) => {
    const mission = createMissionStore(home).get(missionId);
    return mission === null ? [] : [mission];
  });
  const message = [
    `paseo-bm checkpoint of the shared checkout of ${offer.name}`,
    "",
    `The work of missions ${codesOf(missions) || "(none open)"} on the shared checkout, made on the owner's tap on ${decision.id}.`,
    "Commits, uncommitted and untracked files; ignored files left out. The owner's HEAD, index and working tree were not touched.",
  ].join("\n");
  try {
    return { refusals: [], made: await makeCheckpoint(offer.directory, { now: new Date(input.at), message, parent: offer.parent, ...(deps.git === undefined ? {} : { git: deps.git }) }) };
  } catch (error) {
    return { refusals: [`the checkpoint of ${offer.name} could not be made (${errorText(error)}); your HEAD, index and working tree are as they were, and nothing was answered`], made: null };
  }
}

/**
 * After the owner's answer on a checkpoint card is stored: the offer's
 * outcome (made, declined, or later), a journal line in each mission it was
 * for, and a word to their Mains. Never throws.
 */
export async function applyCheckpointDecision(decision: Decision, made: MadeCheckpoint | null, deps: { home: string; now: Date; log: (message: string) => void; paseo?: unknown; cli?: MissionAnswerDeps["cli"] }): Promise<void> {
  const offer = offerOfCard(deps.home, decision.id);
  const answer = decision.answer;
  if (offer === null || answer === null || decision.status !== "answered") return;
  try {
    const at = deps.now.toISOString();
    const kind = made !== null ? "made" : offer.busy ? "later" : "declined";
    settleCheckpointOffer(deps.home, decision.id, { at, kind, ...(made === null ? {} : { branch: made.branch, commit: made.commit }) });
    const store = createMissionStore(deps.home, { now: () => deps.now });
    const what =
      made !== null
        ? `The owner checkpointed the shared checkout of ${offer.name} as the branch ${made.branch} (${made.commit.slice(0, 12)}); new worktrees of the missions open at it branch from ${made.branch}. Pushing it and merging its merge request first is the owner's.`
        : kind === "later"
          ? `The owner asked to checkpoint the shared checkout of ${offer.name} once no mission Worker works in it.`
          : `The owner chose no checkpoint of the shared checkout of ${offer.name}; new worktrees branch from the integration branch.`;
    const tell: MissionAnswerDeps = { home: deps.home, now: deps.now, log: deps.log, ...(deps.paseo === undefined ? {} : { paseo: deps.paseo }), ...(deps.cli === undefined ? {} : { cli: deps.cli }) };
    for (const missionId of offer.missionIds) {
      if (store.get(missionId)?.state !== "open") continue;
      journalQuietly(store, missionId, { kind: "decision", by: "owner", text: `${what} (${decision.id})`, ref: decision.id }, deps.log);
      await tellMain(missionId, decision.id, `${what} (card ${decision.id})`, tell);
    }
  } catch (error) {
    deps.log(`[paseo-bm] applying ${decision.id} failed: ${errorText(error)}`);
  }
}

/** The pass the server runs at each shared Paseo handle: at the first of a run, then at most every ten minutes. */
export function createCheckpointOffers(deps: Partial<CheckpointCardDeps> & { home?: () => string | null } = {}): { run(paseo: unknown): Promise<void> } {
  const log = deps.log ?? ((message: string) => console.warn(message));
  const homeOf = deps.home ?? (() => dataHome());
  const now = deps.now ?? (() => new Date());
  let last: number | null = null;
  let running = false;
  return {
    async run(paseo) {
      const home = homeOf();
      if (home === null || running || (last !== null && now().getTime() - last < OFFER_EVERY_MS)) return;
      running = true;
      last = now().getTime();
      try {
        await offerCheckpoints(home, paseo, { ...deps, log, now });
      } finally {
        running = false;
      }
    },
  };
}
