/**
 * Settings → Coordination (autonomy design §G.7, ADR-021): the store
 * `<data folder>/coordination/settings.json` =
 * `{ version: 1, advice: { everyFinished }, compact: { enabled,
 * managerTokensPerTurn, workerTokensPerTurn, contextShare, maxPerAgent },
 * handoff: { enabled, requestTokens, maxPerRequest }, review: { smallBudget,
 * mediumBudget, largeBudget }, guard: { compact, handoff } }`
 * (`shared/coordination.ts`). The owner's two RPCs over it,
 * `coordination.settings` and `coordination.set`, are in `coordination-rpc.ts`
 * (code review 2026-09-30 §3.2).
 *
 * Two writes: the owner's `set` (one setting; turning a mechanism on from off
 * makes A-12 count afresh from then), and the A-12 guard's `switchOff`
 * (`coordination-guard.ts`, §G.3), which can only switch compaction or
 * handoff off.
 *
 * The file rules are every store's (`data-files.ts` `createJsonFileStore`,
 * code review 2026-09-30 §3.1): the folder is created `0700` only by a write,
 * never by a read; the file is `0600` and replaced atomically; a symlink
 * anywhere below the data folder is refused (`E_TRACE_STORE_UNWRITABLE`, which
 * `coordination.set` answers as `E_COORDINATION_WRITE_FAILED`). A missing or
 * corrupt file reads as the defaults; each setting is read on its own, so one
 * that is missing or out of its bounds reads as its default and costs no
 * other; unknown keys are ignored and dropped by the next write; a file whose
 * `version` is newer than this build reads as the defaults and is never
 * written (`E_COORDINATION_WRITE_FAILED`). A refused change writes nothing.
 *
 * **No lock, on purpose:** every operation is synchronous and the plugin
 * server is one thread, so a read-modify-write cannot interleave.
 */
import { DashboardError } from "../shared/contracts";
import {
  COORDINATION_FILE_VERSION,
  DEFAULT_COORDINATION_SETTINGS,
  applyCoordinationChange,
  coordinationChangeSchema,
  coordinationRuleOf,
  coordinationSettingsOf,
  switchOffCoordination,
  type CoordinationMechanism,
  type CoordinationSettings,
} from "../shared/coordination";
import { createJsonFileStore } from "./data-files";

/** The folder inside the data folder; cleanup deletes it whole. */
export const COORDINATION_DIR_NAME = "coordination";
export const COORDINATION_SETTINGS_FILE = "settings.json";

export interface CoordinationStore {
  /** `<data folder>/coordination/settings.json`. */
  readonly path: string;
  /** Every setting, each missing or out-of-bounds one at its default. Throws only on a symlink. */
  read(): CoordinationSettings;
  /**
   * Applies one change and returns every setting. Throws, writing nothing, on
   * an unknown key or a value out of its bounds (`E_COORDINATION_INVALID`) and
   * on a file written by a newer paseo-bm (`E_COORDINATION_WRITE_FAILED`).
   */
  set(change: unknown): CoordinationSettings;
  /**
   * The A-12 guard's write (§G.3): `mechanism` off, recording when and on
   * what figures. Never turns anything on and changes no figure; an already
   * off mechanism writes nothing. Throws on a newer file, as `set` does.
   */
  switchOff(mechanism: CoordinationMechanism, figures: { met: number; checked: number }): CoordinationSettings;
}

export interface CoordinationStoreDeps {
  now?: () => Date;
}

/** The refusal of a change that is not one known setting with a value in its bounds. */
export function invalidCoordinationChange(change: unknown): DashboardError {
  const key = (change as { key?: unknown } | null | undefined)?.key;
  const rule = coordinationRuleOf(key);
  if (rule !== null) return new DashboardError("E_COORDINATION_INVALID", `${rule}; nothing was saved`);
  return new DashboardError("E_COORDINATION_INVALID", `${JSON.stringify(key ?? null)} is not a coordination setting; nothing was saved`);
}

/** The store rooted at the data folder `home`. Creating it touches nothing on disk. */
export function createCoordinationStore(home: string, deps: CoordinationStoreDeps = {}): CoordinationStore {
  const now = deps.now ?? (() => new Date());
  const file = createJsonFileStore<CoordinationSettings>({
    home,
    dir: COORDINATION_DIR_NAME,
    file: COORDINATION_SETTINGS_FILE,
    version: COORDINATION_FILE_VERSION,
    parse: coordinationSettingsOf,
    empty: () => DEFAULT_COORDINATION_SETTINGS,
    // A failed write keeps the code it has always had; `coordination.set` answers its own (rpc-kit `coded`).
    codes: { unwritable: "E_TRACE_STORE_UNWRITABLE", tooNew: "E_COORDINATION_WRITE_FAILED" },
  });

  return {
    path: file.path,

    read() {
      return file.read();
    },

    set(change) {
      const valid = coordinationChangeSchema.safeParse(change);
      if (!valid.success) throw invalidCoordinationChange(change);
      return file.update((settings) => applyCoordinationChange(settings, valid.data, now().toISOString()));
    },

    switchOff(mechanism, figures) {
      const at = now().toISOString();
      return file.update((settings) => (settings[mechanism].enabled ? switchOffCoordination(settings, mechanism, figures, at) : null)) ?? file.read();
    },
  };
}
