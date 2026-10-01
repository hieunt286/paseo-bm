/**
 * The A-12 guard of compaction and handoff (autonomy design §G.3, §G.7;
 * PRD A-12; bead `7gxw.9`): a mechanism the Orchestrator may start on its own
 * initiative is switched off while its interventions miss their expected
 * outcome too often, and the owner hears it in the Inbox.
 *
 * - **When:** A-12 of the kind — met / (met + missed) — is below its 80 %
 *   target (`A12_TARGET`) over its last `GUARD_ENTRIES` (10) checked entries
 *   of the intervention log (`intervention-store.ts`), counting only entries
 *   recorded since the owner last turned it on (`guard.<kind>.countsFrom`).
 *   With fewer than 10 checked entries nothing is judged; pending and
 *   unknown entries are not checked either way.
 * - **What:** the coordination store's `switchOff` (only ever off, never a
 *   figure), then one `coordination-off` Inbox alert for every project
 *   (`workspaceId` null, subject the kind) whose detail gives the figures and
 *   the way back.
 * - **How it recovers:** only the owner turns it on again — Settings →
 *   Coordination, or the owner's answer to advice carrying
 *   `coordination.set` — which ends the alert (`coordination-rpc.ts`) and makes
 *   A-12 count afresh from then, so the entries that switched it off never
 *   switch it off again.
 *
 * It runs after the intervention check (`index.server.ts`), when that pass
 * settled an entry of either kind. Never throws: a failure is one log line.
 */
import { COORDINATION_MECHANISMS, type CoordinationMechanism, type CoordinationSettings } from "../shared/coordination";
import { A12_TARGET, a12ShareOf, type InterventionEntry } from "../shared/interventions";
import { createAlertStore } from "./alert-store";
import { createCoordinationStore } from "./coordination-store";
import { resolveDataHome, type DataHomeDeps } from "./data-home";
import { createInterventionStore } from "./intervention-store";
import { errorText } from "./rpc-kit";

/** How many of a kind's newest checked entries A-12 is judged over. */
export const GUARD_ENTRIES = 10;

/** What the guard found for one kind: the met and missed of its last checked entries, and their A-12. */
export interface GuardVerdict {
  met: number;
  missed: number;
  checked: number;
  share: number;
}

/**
 * A-12 of `kind` over its last `GUARD_ENTRIES` checked (met or missed)
 * entries recorded from `countsFrom` (every entry when null), in log order.
 * The verdict when there are that many and their share is below `A12_TARGET`;
 * null otherwise. Pure.
 */
export function belowTargetOf(entries: readonly InterventionEntry[], kind: CoordinationMechanism, countsFrom: string | null): GuardVerdict | null {
  const from = countsFrom === null ? Number.NEGATIVE_INFINITY : Date.parse(countsFrom);
  const checked = entries
    .filter((entry) => entry.kind === kind && (entry.outcome === "met" || entry.outcome === "missed"))
    .filter((entry) => Number.isNaN(from) || Date.parse(entry.at) >= from)
    .slice(-GUARD_ENTRIES);
  if (checked.length < GUARD_ENTRIES) return null;
  const met = checked.filter((entry) => entry.outcome === "met").length;
  const missed = checked.length - met;
  const share = a12ShareOf(met, missed);
  return share !== null && share < A12_TARGET ? { met, missed, checked: checked.length, share } : null;
}

const MECHANISM_WORDS: Readonly<Record<CoordinationMechanism, { name: string; entries: string }>> = {
  compact: { name: "Compaction", entries: "compactions" },
  handoff: { name: "Handoff", entries: "handoffs" },
};

/** The alert's detail: the figures and the way back, in the owner's words. */
export function switchedOffDetail(mechanism: CoordinationMechanism, verdict: Pick<GuardVerdict, "met" | "checked">): string {
  const words = MECHANISM_WORDS[mechanism];
  const target = Math.round(A12_TARGET * verdict.checked);
  return `Only ${verdict.met} of its last ${verdict.checked} ${words.entries} met their goal (target ${target}). ${words.name} stays off until you turn it on in Settings → Coordination.`;
}

export interface CoordinationGuardDeps {
  now?: () => Date;
  log?: (message: string) => void;
}

/**
 * One pass over the data folder `home`: each mechanism that is on and below
 * target is switched off, with its alert. Returns the mechanisms it switched
 * off. Never throws.
 */
export function guardCoordination(home: string, deps: CoordinationGuardDeps = {}): CoordinationMechanism[] {
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? ((message: string) => console.warn(message));
  let settings: CoordinationSettings;
  let entries: InterventionEntry[];
  try {
    settings = createCoordinationStore(home, { now }).read();
    if (!COORDINATION_MECHANISMS.some((mechanism) => settings[mechanism].enabled)) return [];
    entries = createInterventionStore(home, { now }).list();
  } catch (error) {
    log(`[paseo-bm] could not check compaction and handoff against A-12: ${errorText(error)}`);
    return [];
  }
  const switched: CoordinationMechanism[] = [];
  for (const mechanism of COORDINATION_MECHANISMS) {
    if (!settings[mechanism].enabled) continue;
    const verdict = belowTargetOf(entries, mechanism, settings.guard[mechanism].countsFrom);
    if (verdict === null) continue;
    try {
      createCoordinationStore(home, { now }).switchOff(mechanism, { met: verdict.met, checked: verdict.checked });
    } catch (error) {
      log(`[paseo-bm] could not switch ${mechanism} off below A-12's target: ${errorText(error)}`);
      continue;
    }
    switched.push(mechanism);
    try {
      createAlertStore(home, { now }).raise({ workspaceId: null, kind: "coordination-off", subject: mechanism, detail: switchedOffDetail(mechanism, verdict) });
    } catch (error) {
      log(`[paseo-bm] switched ${mechanism} off below A-12's target but could not raise its Inbox alert: ${errorText(error)}`);
    }
  }
  return switched;
}

export interface CoordinationGuard {
  /** After an intervention check: guards the data folder when it settled a `compact` or `handoff` entry. Never throws. */
  afterCheck(settled: readonly InterventionEntry[]): CoordinationMechanism[];
}

/** The guard on the plugin's data folder. */
export function createCoordinationGuard(deps: CoordinationGuardDeps & DataHomeDeps = {}): CoordinationGuard {
  const log = deps.log ?? ((message: string) => console.warn(message));
  return {
    afterCheck(settled) {
      if (!settled.some((entry) => (COORDINATION_MECHANISMS as readonly string[]).includes(entry.kind))) return [];
      try {
        const home = resolveDataHome(deps).home;
        return home === null ? [] : guardCoordination(home, { ...deps, log });
      } catch (error) {
        log(`[paseo-bm] could not check compaction and handoff against A-12: ${errorText(error)}`);
        return [];
      }
    },
  };
}
