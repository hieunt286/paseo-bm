/**
 * The references of a typed message (delivery line design §9.1; ADR-035
 * decision 8): `refs` names contracts at a version (`C2@v3`), outbox records
 * (`out-…`) and decisions (`q:…`, `m:…`, an arbitration `arb-…`), and each
 * id is checked here against the store that holds it — the missions of the
 * message, every workspace's outbox, the decision stores — with one refusal
 * line per unknown id. The act's own rules are here too: `agree` needs a
 * contract, `supersede` the record it replaces.
 *
 * Readers only: nothing here writes, and nothing throws (a store that cannot
 * be read knows no id).
 */
import { DECISION_ID_PATTERN } from "../shared/decisions";
import type { MessageAct, MessageRefs } from "../shared/bm-tools";
import { createDecisionStore } from "./decision-store";
import { ARBITRATION_ID_PATTERN, createArbitrationStore } from "./governor-conflicts";
import { createMissionDecisionStore, isMissionDecisionId } from "./mission-decisions";
import { createMissionStore, type Mission, type MissionContract } from "./mission-store";
import { createOutbox } from "./outbox";

/** `C2@v3` read: the contract id and the version. */
export function parseContractRef(ref: string): { id: string; version: number } | null {
  const match = /^(C\d{1,4})@v([1-9]\d{0,3})$/.exec(ref);
  return match === null ? null : { id: match[1]!, version: Number(match[2]) };
}

/** A contract a ref names, in the first of `missionIds` that holds it. */
export interface ResolvedContract {
  mission: Mission;
  contract: MissionContract;
  /** The version the ref names (at most the contract's current one). */
  version: number;
}

const missionsOf = (home: string, missionIds: readonly (string | null | undefined)[]): Mission[] => {
  const store = createMissionStore(home);
  const ids = [...new Set(missionIds.filter((id): id is string => typeof id === "string" && id !== ""))];
  return ids.map((id) => store.get(id)).filter((mission): mission is Mission => mission !== null);
};

/** The contract `ref` names in the first of `missionIds` that has it at that version or later, else null. Never throws. */
export function resolveContractRef(home: string, ref: string, missionIds: readonly (string | null | undefined)[]): ResolvedContract | null {
  const parsed = parseContractRef(ref);
  if (parsed === null) return null;
  try {
    for (const mission of missionsOf(home, missionIds)) {
      const contract = mission.contracts.find((entry) => entry.id === parsed.id);
      if (contract !== undefined && parsed.version <= contract.version) return { mission, contract, version: parsed.version };
    }
  } catch {
    // An unreadable store knows no contract.
  }
  return null;
}

const recordKnown = (home: string, id: string): boolean => {
  const outbox = createOutbox(home);
  return outbox.workspaces().some((workspaceId) => outbox.list(workspaceId).some((record) => record.id === id));
};

const decisionKnown = (home: string, id: string): boolean => {
  try {
    if (isMissionDecisionId(id)) return createMissionDecisionStore(home).get(id) !== null;
    if (ARBITRATION_ID_PATTERN.test(id)) return createArbitrationStore(home).get(id) !== null;
    return DECISION_ID_PATTERN.test(id) && createDecisionStore(home).get(id) !== null;
  } catch {
    return false;
  }
};

/**
 * One refusal line per id of `refs` no store knows (delivery line design
 * §9.1): a contract at a version none of `missionIds` has, a record no
 * outbox holds, a decision no decision store holds. Empty when every id is
 * known. Never throws.
 */
export function refsRefusals(home: string, refs: MessageRefs | undefined, missionIds: readonly (string | null | undefined)[]): string[] {
  if (refs === undefined) return [];
  const reasons: string[] = [];
  for (const ref of refs.contracts ?? []) {
    if (resolveContractRef(home, ref, missionIds) === null) reasons.push(`refs.contracts: unknown contract ${ref}; bm_mission lists the contracts and their versions`);
  }
  for (const id of refs.records ?? []) {
    if (!recordKnown(home, id)) reasons.push(`refs.records: unknown record ${id}`);
  }
  for (const id of refs.decisions ?? []) {
    if (!decisionKnown(home, id)) reasons.push(`refs.decisions: unknown decision ${id}`);
  }
  return reasons;
}

/** What an act needs of its `refs` (delivery line design §9.1): `agree` a contract, `supersede` the replaced record. Pure. */
export function actRefusals(act: MessageAct, refs: MessageRefs | undefined): string[] {
  if (act === "agree" && (refs?.contracts ?? []).length === 0) return ["act agree needs the contract it agrees to in refs.contracts (C2@v3)"];
  if (act === "supersede" && (refs?.records ?? []).length === 0) return ["act supersede needs the record it replaces in refs.records (out-…)"];
  return [];
}
