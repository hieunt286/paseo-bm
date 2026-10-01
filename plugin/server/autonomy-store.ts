/**
 * The owner's autonomy policy (autonomy design §B.2, ADR-018; PRD REQ-121):
 * the store `<data folder>/autonomy/policy.json` =
 * `{ version: 1, projects: { <workspaceId>: { <class>: { mode, predictor?, at } } }, challenger: { <workspaceId>: boolean }, demotions?: { <workspaceId>: { <class>: at } }, boundary?: { <workspaceId>: { enabled: true, at } } }`.
 * The schema and its pure rules are `shared/autonomy.ts`; the owner's RPCs over
 * it are `autonomy-rpc.ts`, and so is the demotion (§B.4), its one writer that
 * is not the owner.
 *
 * The file rules are every store's (`data-files.ts` `createJsonFileStore`,
 * code review 2026-09-30 §3.1): the folder is created `0700` only by a write,
 * never by a read; the file is `0600` and replaced atomically; a symlink
 * anywhere below the data folder is refused (`E_TRACE_STORE_UNWRITABLE`, as
 * a failed write). A missing or corrupt file reads as the empty policy (every
 * cell `owner`); each cell is read on its own, so a malformed one is skipped
 * alone and dropped by the next write; a file whose `version` is newer than
 * this build reads as the empty policy and is never written
 * (`E_AUTONOMY_WRITE_FAILED`). A refused change writes nothing.
 *
 * **No lock, on purpose:** every operation is synchronous and the plugin
 * server is one thread, so a read-modify-write cannot interleave.
 */
import { DashboardError } from "../shared/contracts";
import {
  AUTONOMY_FILE_VERSION,
  EMPTY_AUTONOMY_POLICY,
  autonomyPolicyOf,
  cellOfChange,
  cellsOf,
  checkAutonomySet,
  checkAutonomySetBoundary,
  checkAutonomySetChallenger,
  boundaryOf,
  isPolicyWorkspaceId,
  modeOf,
  withBoundary,
  withCell,
  withChallenger,
  withDemotion,
  withProjectReset,
  type AutonomyPolicy,
} from "../shared/autonomy";
import type { DecisionClass } from "../shared/decisions";
import { createJsonFileStore } from "./data-files";

/** The folder inside the data folder; cleanup deletes it whole. */
export const AUTONOMY_DIR_NAME = "autonomy";
export const AUTONOMY_POLICY_FILE = "policy.json";

export interface AutonomyStore {
  /** `<data folder>/autonomy/policy.json`. */
  readonly path: string;
  /** The policy, each malformed cell skipped. Throws only on a symlink. */
  read(): AutonomyPolicy;
  /**
   * Sets one cell, stamped `at`, and returns the whole policy. Throws, writing
   * nothing, on each refusal of `checkAutonomySet` and on a file written by a
   * newer paseo-bm (`E_AUTONOMY_WRITE_FAILED`).
   */
  set(input: unknown, at: string): AutonomyPolicy;
  /**
   * Returns every class of one project to `owner` in one write and returns the
   * whole policy. A project with no cell is already there: nothing is written.
   */
  reset(workspaceId: unknown): AutonomyPolicy;
  /**
   * Turns one project's challenger on or off (§B.3) and returns the whole
   * policy; its cells stay as they are. `false` is kept as the owner's
   * answer, not removed. A switch already in that state writes nothing.
   * Throws, writing nothing, on a refusal of `checkAutonomySetChallenger` and
   * on a file written by a newer paseo-bm (`E_AUTONOMY_WRITE_FAILED`).
   */
  setChallenger(input: unknown): AutonomyPolicy;
  /**
   * Turns one project's action boundary on (since `at`) or off (§D.2,
   * change-010 C2) and returns the whole policy; its cells stay as they are.
   * Off removes the entry. A switch already in that state writes nothing and
   * keeps the time it was turned on. Throws, writing nothing, on a refusal of
   * `checkAutonomySetBoundary` and on a file written by a newer paseo-bm
   * (`E_AUTONOMY_WRITE_FAILED`).
   */
  setBoundary(input: unknown, at: string): AutonomyPolicy;
  /**
   * Demotes one class of one project at `at` (§B.4): a `delegate` cell becomes
   * `shadow` and `at` its last demotion, in one write, and the whole policy is
   * returned. A cell that is not `delegate` writes nothing and returns null.
   * Throws, writing nothing, on a file written by a newer paseo-bm
   * (`E_AUTONOMY_WRITE_FAILED`).
   */
  demote(workspaceId: string, decisionClass: DecisionClass, at: string): AutonomyPolicy | null;
}

/**
 * The owner's policy as it is now, for a reader that goes on without it (code
 * review 2026-09-30 §3.5: the one policy read with a fallback): a store that
 * cannot be read reads as the empty policy — every class `owner`, no
 * challenger: the safe side. `onUnreadable`, when given, gets why (its
 * caller's one log line). Read at each call, so a cell set back meanwhile
 * counts. Never throws.
 */
export function currentPolicy(home: string, onUnreadable?: (reason: string) => void): AutonomyPolicy {
  try {
    return createAutonomyStore(home).read();
  } catch (error) {
    onUnreadable?.(error instanceof Error ? error.message : String(error));
    return EMPTY_AUTONOMY_POLICY;
  }
}

/** The refusal of a workspace id the policy cannot key a project by. */
export function invalidWorkspace(workspaceId: unknown): DashboardError {
  return new DashboardError("E_AUTONOMY_INVALID", `${JSON.stringify(workspaceId ?? null)} is not a project; nothing was saved`);
}

/** The store rooted at the data folder `home`. Creating it touches nothing on disk. */
export function createAutonomyStore(home: string): AutonomyStore {
  const file = createJsonFileStore<AutonomyPolicy>({
    home,
    dir: AUTONOMY_DIR_NAME,
    file: AUTONOMY_POLICY_FILE,
    version: AUTONOMY_FILE_VERSION,
    parse: autonomyPolicyOf,
    empty: () => EMPTY_AUTONOMY_POLICY,
    // A failed write keeps the code it has always had.
    codes: { unwritable: "E_TRACE_STORE_UNWRITABLE", tooNew: "E_AUTONOMY_WRITE_FAILED" },
  });
  // Throws, writing nothing, on a newer file: even a change that would write nothing is refused.
  const loadForWrite = (): AutonomyPolicy => file.readForWrite();
  const write = (policy: AutonomyPolicy): void => {
    file.write(policy);
  };

  return {
    path: file.path,

    read() {
      return file.read();
    },

    set(input, at) {
      const checked = checkAutonomySet(input);
      if ("refusal" in checked) throw new DashboardError(checked.refusal.code, checked.refusal.detail);
      const { change } = checked;
      const next = withCell(loadForWrite(), change.workspaceId, change.class, cellOfChange(change, at));
      write(next);
      return next;
    },

    reset(workspaceId) {
      if (!isPolicyWorkspaceId(workspaceId)) throw invalidWorkspace(workspaceId);
      const policy = loadForWrite();
      if (Object.keys(cellsOf(policy, workspaceId)).length === 0) return policy;
      const next = withProjectReset(policy, workspaceId);
      write(next);
      return next;
    },

    setChallenger(input) {
      const checked = checkAutonomySetChallenger(input);
      if ("refusal" in checked) throw new DashboardError(checked.refusal.code, checked.refusal.detail);
      const { workspaceId, enabled } = checked.change;
      const policy = loadForWrite();
      if (Object.hasOwn(policy.challenger, workspaceId) && policy.challenger[workspaceId] === enabled) return policy;
      const next = withChallenger(policy, workspaceId, enabled);
      write(next);
      return next;
    },

    setBoundary(input, at) {
      const checked = checkAutonomySetBoundary(input);
      if ("refusal" in checked) throw new DashboardError(checked.refusal.code, checked.refusal.detail);
      const { workspaceId, enabled } = checked.change;
      const policy = loadForWrite();
      if ((boundaryOf(policy, workspaceId) !== null) === enabled) return policy;
      const next = withBoundary(policy, workspaceId, enabled ? at : null);
      write(next);
      return next;
    },

    demote(workspaceId, decisionClass, at) {
      if (!isPolicyWorkspaceId(workspaceId)) return null;
      const policy = loadForWrite();
      if (modeOf(policy, workspaceId, decisionClass) !== "delegate") return null;
      const next = withDemotion(policy, workspaceId, decisionClass, at);
      write(next);
      return next;
    },
  };
}
