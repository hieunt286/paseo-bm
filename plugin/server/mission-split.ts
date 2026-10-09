/**
 * A Main's split suggestion (missions design §9.6, §9.7; ADR-029): when the
 * owner, asked by the Main, says that work they gave is another mission, the
 * Main suggests it to the governor with `bm_split_mission`; the governor
 * reads it (`bm_missions`, `splitSuggestions`) and decides with
 * `bm_create_main` — which runs on the source mission's `split` cell, or opens
 * the owner's `m:` card — or tells the Main why not with `bm_govern`.
 *
 * - **`bm_split_mission { name, code, goal, repos, requestIds?, reason }`**,
 *   for the current Main of an open mission: checked as `bm_create_main`
 *   checks a split (`splitRefusalsOf`), bar the source Main's running turn —
 *   the caller is that Main, in its own turn — and refused for a code a
 *   suggestion still open already names (`openSplitSuggestionsOf`). On
 *   success it appends a `split-suggested` journal line carrying the fields
 *   (`mission-store.ts`) and publishes `mission.split` to the Orchestrator
 *   through the event bus (`event-bus.ts`), keyed per mission and code,
 *   settled once a mission takes the code or the source mission closes, and
 *   held by the bus's 15-minute mission window like the other mission events.
 * - The Main never creates the mission and never asks the owner to: the reply
 *   tells it to say in one line that the suggestion is with the governor.
 *
 * Common rules (§7.15): a refusal is one line per reason and writes nothing; a
 * pending binding is refused by the shared guard; the caller's mission comes
 * from its binding, never from the input. Text is masked by the mission
 * store. Nothing here throws into the endpoint.
 */
import type { ToolCaller } from "./agent-bindings";
import { MISSION_SPLIT_FACE, schemaIssues } from "../shared/bm-tools";
import type { MissionSplit } from "../shared/mission-change";
import type { ServerToolAnswer, ServerTools } from "./decision-tools";
import type { MissionSplitEvent } from "./event-bus";
import { splitRefusalsOf } from "./governor-tools";
import { createMissionStore, openSplitSuggestionsOf, type JournalEntry } from "./mission-store";
import { MISSION_NOT_BOUND_MESSAGE, NOT_A_MAIN_MESSAGE, missionOfMain, resolveRepos } from "./mission-tools";
import { listedWorkspaces, type DashboardPaseo } from "./paseo-directory";
import { errorText } from "./rpc-kit";
import { actingTools, answered, boundAs, fixThese, refused, withoutNulls } from "./tool-kit";

const NOTHING = "Nothing was recorded or sent.";
const NO_PASEO = `paseo-bm has no connection to Paseo yet; try again in a moment. ${NOTHING}`;
/** What `bm_split_mission`'s reply tells the Main (§9.6). */
export const SPLIT_SUGGESTED_SAID =
  "The governor (the Orchestrator) decides: it creates the mission and its Main, or the owner is asked on a card, or it tells you why not. Tell the owner in one line that the new mission is with the governor; do not create it yourself or ask the owner to.";

export interface MissionSplitToolDeps {
  /** The last Paseo handle a hook or RPC brought; null before any did. */
  paseo: () => unknown;
  /** The data folder (the endpoint's). */
  home: () => string;
  log: (message: string) => void;
  now?: () => Date;
  /** Where `mission.split` goes: the event bus's `publish`. None: the journal line only. */
  publish?: (events: readonly MissionSplitEvent[], paseo: unknown) => unknown;
}

interface SplitInput {
  name: string;
  code: string;
  goal: string;
  repos: string[];
  requestIds?: string[];
  reason: string;
}

/** The bound Manager's `bm_split_mission` (see the module comment), as a server-run tool the endpoint composes with its others. Never throws. */
export function createMissionSplitTools(deps: MissionSplitToolDeps): ServerTools {
  const now = deps.now ?? (() => new Date());

  const suggest = async (raw: unknown, caller: ToolCaller | null): Promise<ServerToolAnswer> => {
    const main = boundAs(caller, "manager");
    if (main === null) return refused(MISSION_NOT_BOUND_MESSAGE);
    const input = withoutNulls(raw ?? {}) as SplitInput;
    const issues = schemaIssues(MISSION_SPLIT_FACE.inputSchema, input);
    if (issues.length > 0) return fixThese("bm_split_mission", issues);
    const home = deps.home();
    const mission = missionOfMain(home, main);
    if (mission === null) return refused(NOT_A_MAIN_MESSAGE);
    const paseo = deps.paseo();
    if (paseo === null || paseo === undefined) return refused(NO_PASEO);
    const at = now();
    const split: MissionSplit = {
      name: input.name.trim(),
      code: input.code,
      goal: input.goal.trim(),
      repos: [...new Set(input.repos)],
      requestIds: [...new Set(input.requestIds ?? [])],
      reason: input.reason.trim(),
    };
    const reasons = await splitRefusalsOf(home, mission, split, paseo, at, { mainMayRun: true });
    const store = createMissionStore(home, { now });
    for (const entry of store.list().filter((candidate) => candidate.state === "open")) {
      const open = openSplitSuggestionsOf(home, entry.missionId).find((suggestion) => suggestion.code === split.code);
      if (open === undefined) continue;
      reasons.push(
        entry.missionId === mission.missionId
          ? `code ${split.code}: you suggested that mission already (${open.at}); the governor decides it`
          : `code ${split.code}: mission ${entry.code}'s Main suggested a mission with it already (${open.at}); ask the owner for another code`,
      );
    }
    if (reasons.length > 0) return refused([...reasons, NOTHING].join("\n"));

    const repos = resolveRepos(split.repos, await listedWorkspaces(paseo as DashboardPaseo), home, "repos").ids;
    const requests = split.requestIds.length === 0 ? "no request" : `requests ${split.requestIds.join(", ")}`;
    let line: JournalEntry;
    try {
      line = store.appendJournal(mission.missionId, {
        kind: "split-suggested",
        by: "main",
        text: `On the owner's yes the Main suggested a new mission ${split.code} "${split.name}" (repos ${repos.join(", ")}; ${requests}) to the governor: ${split.reason}`,
        ref: main.agentId,
        split: { ...split, repos },
      });
    } catch (error) {
      return refused(`The suggestion could not be written: ${errorText(error)}. ${NOTHING}`);
    }
    const stored = line.split ?? { ...split, repos };
    const event: MissionSplitEvent = { type: "mission.split", missionId: mission.missionId, ...stored, at: line.at };
    if (deps.publish !== undefined) {
      try {
        await deps.publish([event], paseo);
      } catch (error) {
        deps.log(`[paseo-bm] the split suggestion ${split.code} of mission ${mission.code} is recorded, but publishing it to the governor failed: ${errorText(error)}`);
      }
    }
    return answered({ suggested: { code: stored.code, name: stored.name, repos: stored.repos, requestIds: stored.requestIds }, governor: SPLIT_SUGGESTED_SAID });
  };

  return actingTools([MISSION_SPLIT_FACE], { bm_split_mission: suggest }, NOTHING);
}
