/**
 * Mission decisions (`m:`, missions design §4.1): a mission change that needs
 * the owner, a split and an arbitration that changes a goal, stored as
 * decisions with the id `m:<missionId>:<n>` in
 * `<data folder>/missions/<missionId>.decisions.json` = `{ version: 1, entries }`.
 *
 * The decision schema is the per-workspace store's (`shared/decisions.ts`),
 * with the id (and `supersedes`/`supersededBy`) widened to the `m:` shape here
 * only: the per-workspace store and `DECISION_ID_PATTERN` are untouched, so no
 * other path opens, answers or lists an `m:` decision by accident. The file
 * rules and the bound are that store's (`decision-store.ts`): a
 * `createJsonFileStore` file, open decisions never evicted, the
 * `DECISION_SETTLED_LIMIT` newest settled ones kept. Readers never throw.
 */
import { z } from "zod";
import { decisionSchema, type Decision, type DecisionStatus, type TransitionRefusal, type TransitionResult } from "../shared/decisions";
import { createJsonFileStore, type JsonFileStore } from "./data-files";
import { DECISIONS_FILE_VERSION, capDecisions } from "./decision-store";
import { MISSIONS_DIR_NAME, MISSION_ID_PATTERN } from "./mission-store";

/** `m:<missionId>:<n>`. */
export const MISSION_DECISION_ID_PATTERN = /^m:(mis-[0-9a-f]{10}):([1-9]\d{0,5})$/;

const missionDecisionIdSchema = z.string().regex(MISSION_DECISION_ID_PATTERN);

/** A stored `m:` decision: the decision schema, its ids of the `m:` shape. */
export const missionDecisionSchema = decisionSchema.safeExtend({
  id: missionDecisionIdSchema,
  supersedes: missionDecisionIdSchema.nullable(),
  supersededBy: missionDecisionIdSchema.nullable(),
});

/** True for an `m:` decision id. */
export function isMissionDecisionId(id: string): boolean {
  return MISSION_DECISION_ID_PATTERN.test(id);
}

/** True for the Main's question (`bm_owner_question`, mission runtime design §4.6): an `m:` decision whose options carry no action, keyed `a`, `b`, …. Pure. */
export function isMainQuestion(decision: Pick<Decision, "id" | "options">): boolean {
  return isMissionDecisionId(decision.id) && decision.options.length > 0 && decision.options.every((option) => option.action === undefined) && decision.options[0]!.key === "a";
}

/** The mission an `m:` id names, or null. */
export function missionOfDecisionId(id: string): string | null {
  return MISSION_DECISION_ID_PATTERN.exec(id)?.[1] ?? null;
}

export type MissionDecisionMutation =
  | { status: "updated"; decision: Decision; previous: Decision }
  | { status: "not-found" }
  /** The transition refused; nothing was written. */
  | { status: "refused"; decision: Decision; refusal: TransitionRefusal; message: string };

export interface MissionDecisionStore {
  /** The mission's decisions in file order, optionally of some statuses only. Never throws. */
  list(missionId: string, statuses?: readonly DecisionStatus[]): Decision[];
  /** The decision with this `m:` id, or null. Never throws. */
  get(id: string): Decision | null;
  /** The next free id of the mission: `m:<missionId>:<highest n + 1>`. Never throws. */
  nextId(missionId: string): string;
  /**
   * Stores a new decision, idempotently by id (an id already stored returns the
   * stored one, `created: false`). Throws on a decision that does not
   * validate, and when the file cannot be written.
   */
  open(decision: Decision): { decision: Decision; created: boolean };
  /** Applies a pure transition (`shared/decisions.ts`) and writes the result; a refusal writes nothing. Throws when the file cannot be written. */
  transition(id: string, step: (decision: Decision) => TransitionResult): MissionDecisionMutation;
}

/** The `m:` decision store of the data folder `home`. Creating it touches nothing on disk. */
export function createMissionDecisionStore(home: string): MissionDecisionStore {
  const fileOf = (missionId: string): JsonFileStore<{ entries: Decision[] }> => {
    if (!MISSION_ID_PATTERN.test(missionId)) throw new Error(`not a mission id: ${JSON.stringify(missionId)}`);
    return createJsonFileStore<{ entries: Decision[] }>({
      home,
      dir: MISSIONS_DIR_NAME,
      file: `${missionId}.decisions.json`,
      version: DECISIONS_FILE_VERSION,
      parse: (body) => ({
        entries: (Array.isArray(body["entries"]) ? (body["entries"] as unknown[]) : []).flatMap((entry) => {
          const valid = missionDecisionSchema.safeParse(entry);
          // An entry of another mission is as unusable as a broken one.
          return valid.success && missionOfDecisionId(valid.data.id) === missionId ? [valid.data] : [];
        }),
      }),
      empty: () => ({ entries: [] }),
      cap: ({ entries }) => ({ entries: capDecisions(entries) }),
      codes: { unwritable: "E_TRACE_STORE_UNWRITABLE", tooNew: "E_DECISION_WRITE_FAILED" },
      cached: true,
    });
  };

  const list = (missionId: string, statuses?: readonly DecisionStatus[]): Decision[] => {
    try {
      const entries = fileOf(missionId).read().entries;
      return statuses === undefined ? entries : entries.filter((entry) => statuses.includes(entry.status));
    } catch {
      return [];
    }
  };

  return {
    list,
    get(id) {
      const missionId = missionOfDecisionId(id);
      return missionId === null ? null : (list(missionId).find((entry) => entry.id === id) ?? null);
    },
    nextId(missionId) {
      const highest = Math.max(0, ...list(missionId).map((entry) => Number(MISSION_DECISION_ID_PATTERN.exec(entry.id)?.[2] ?? 0)));
      return `m:${missionId}:${highest + 1}`;
    },
    open(input) {
      const decision = missionDecisionSchema.parse(input);
      let stored: Decision = decision;
      let created = false;
      fileOf(missionOfDecisionId(decision.id)!).update((current) => {
        const existing = current.entries.find((entry) => entry.id === decision.id);
        if (existing !== undefined) {
          stored = existing;
          return null;
        }
        created = true;
        return { entries: [...current.entries, decision] };
      });
      return { decision: stored, created };
    },
    transition(id, step) {
      const missionId = missionOfDecisionId(id);
      if (missionId === null) return { status: "not-found" };
      let outcome: MissionDecisionMutation = { status: "not-found" };
      fileOf(missionId).update((current) => {
        const index = current.entries.findIndex((entry) => entry.id === id);
        if (index === -1) return null;
        const previous = current.entries[index]!;
        const result = step(previous);
        if (!result.ok) {
          outcome = { status: "refused", decision: previous, refusal: result.refusal, message: result.message };
          return null;
        }
        const next = missionDecisionSchema.parse(result.decision);
        if (next.id !== previous.id) throw new Error(`a transition may not change the id of decision ${id}`);
        outcome = { status: "updated", decision: next, previous };
        return { entries: current.entries.map((entry, at) => (at === index ? next : entry)) };
      });
      return outcome;
    },
  };
}
