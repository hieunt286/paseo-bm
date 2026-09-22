/**
 * "Wait until the reset" (delta 20260921 §4.4.9, REQ-065 e): one timer per
 * Wait click, for any role (phase 2a-16 offers the Worker's only).
 *
 * The owner accepted it as a narrow exception to the root design's "no
 * background task" rule (Q6 a): each wait has exactly one timer, set by the
 * user's click; it is written to the incidents file (`waiting`, `waitUntil`)
 * and set again after a plugin reload; a status change of the incident ends
 * it; nothing scans the disk or repeats.
 *
 * Paseo hands a plugin no SDK handle when it loads (no start-up event, and
 * `PluginServerContext` carries no `paseo`), so the timers of `waiting`
 * incidents are set again at the first hook or fallback RPC that brings one —
 * the same once-per-run pattern as the label scan of delta 20260918g. A timer
 * already past due fires at once.
 *
 * When it fires: the stopped agent archived, gone, running or already replaced
 * (`bm.replacedBy`) → `expired`. Otherwise it is sent `RESUME_NOTICE`, the
 * incident becomes `resumed`, and its Manager chat gets a `BM-FALLBACK` with
 * `status: resumed`. Never throws into a timer: failures cost one log line.
 */
import { decidePending, notifyFallback, type FallbackAction, type FallbackRpcDeps } from "./fallback-rpc";
import { readIncidents, updateIncidents } from "./fallback-state";
import { REPLACED_BY_LABEL } from "./fallback-detect";
import { asRecord, reasonOf } from "./role-choices";
import { installHomeOf } from "./role-extras";
import { TIMED_OUT, withTimeout } from "./role-mode";
import { DashboardError, FALLBACK_MAX_WAIT_MS, type FallbackIncident } from "../shared/contracts";

/** What the stopped agent is sent when its usage reset (agent-facing, so English). */
export const RESUME_NOTICE = "BM-RESUME The usage limit that stopped you has reset. Continue from where you stopped; do not redo finished work.";

/** The agent is resumed this long after `resetsAt`. */
export const WAIT_GRACE_MS = 60_000;

/** A reset further ahead than this is not waited for; the card offers Wait by the same limit. */
export const MAX_WAIT_MS = FALLBACK_MAX_WAIT_MS;

type Timer = ReturnType<typeof setTimeout>;

export interface WaiterDeps {
  now?: () => Date;
  log?: (message: string) => void;
  setTimer?: (fire: () => void, ms: number) => Timer;
  clearTimer?: (timer: Timer) => void;
  /** The Manager chat notice; `notifyFallback` by default. */
  notify?: (incident: FallbackIncident, paseo: unknown) => Promise<unknown>;
  /** The install home when the caller knows it (tests); looked up otherwise. */
  home?: string | null;
}

/** The part of the SDK a resume uses; `PaseoApi` is structurally assignable. */
interface ResumePaseo {
  agents: { ref(agentId: string): { refresh(): Promise<{ agent?: unknown } | null>; send(text: string): Promise<void> } };
}

export interface FallbackWaiter {
  /** The `wait` action of `fallback.act`. */
  wait: FallbackAction;
  /** Sets the timers of every `waiting` incident, once per plugin run. Never throws. */
  ensureArmed(paseo: unknown): Promise<void>;
  /** Ends the timer of one incident (its status changed). */
  cancel(incidentId: string): void;
  /** Ends every timer (plugin cleanup). */
  clear(): void;
}

export function createFallbackWaiter(deps: WaiterDeps = {}): FallbackWaiter {
  const log = deps.log ?? ((message: string) => console.warn(message));
  const now = deps.now ?? (() => new Date());
  const setTimer =
    deps.setTimer ??
    ((fire: () => void, ms: number) => {
      const timer = setTimeout(fire, ms);
      timer.unref?.();
      return timer;
    });
  const clearTimer = deps.clearTimer ?? ((timer: Timer) => clearTimeout(timer));
  const notify = deps.notify ?? ((incident: FallbackIncident, paseo: unknown) => notifyFallback(incident, paseo));
  const timers = new Map<string, Timer>();
  let armed = false;

  const homeOf = async (paseo: unknown, known?: string | null): Promise<string | null> => {
    if (known !== undefined) return known;
    if (deps.home !== undefined) return deps.home;
    const found = await withTimeout(installHomeOf(paseo));
    return found === TIMED_OUT ? null : found;
  };

  const cancel = (incidentId: string): void => {
    const timer = timers.get(incidentId);
    if (timer !== undefined) clearTimer(timer);
    timers.delete(incidentId);
  };

  /** Moves a `waiting` incident to `resumed` or `expired`; null when it is no longer waiting. */
  const finish = async (home: string, incidentId: string, status: "resumed" | "expired"): Promise<FallbackIncident | null> => {
    let finished: FallbackIncident | null = null;
    await updateIncidents(
      home,
      (incidents) => {
        const index = incidents.findIndex((incident) => incident.id === incidentId && incident.status === "waiting");
        if (index === -1) return null;
        finished = { ...incidents[index]!, status };
        return incidents.map((incident, at) => (at === index ? finished! : incident));
      },
      log,
    );
    return finished;
  };

  const fire = async (incidentId: string, paseo: unknown, home: string): Promise<void> => {
    timers.delete(incidentId);
    try {
      const current = readIncidents(home, log).incidents.find((incident) => incident.id === incidentId);
      // Any other status means the wait was ended by a later decision.
      if (current === undefined || current.status !== "waiting") return;
      const ref = (paseo as ResumePaseo).agents.ref(current.agentId);
      const snapshot = asRecord((await ref.refresh())?.agent);
      const status = snapshot?.["status"];
      const labels = asRecord(snapshot?.["labels"]) ?? {};
      const gone = snapshot === null || snapshot["archivedAt"] != null || status === "closed";
      const busy = status === "running" || status === "initializing";
      if (gone || busy || Object.prototype.hasOwnProperty.call(labels, REPLACED_BY_LABEL)) {
        await finish(home, incidentId, "expired");
        return;
      }
      await ref.send(RESUME_NOTICE);
      const resumed = await finish(home, incidentId, "resumed");
      if (resumed !== null) await notify(resumed, paseo);
    } catch (error) {
      log(`[paseo-bm] resuming the agent of fallback incident ${incidentId} failed: ${reasonOf(error)}`);
    }
  };

  const arm = (incident: FallbackIncident, paseo: unknown, home: string): void => {
    cancel(incident.id);
    const due = incident.waitUntil === null ? Number.NaN : Date.parse(incident.waitUntil);
    const delay = Number.isNaN(due) ? 0 : Math.max(0, due - now().getTime());
    timers.set(
      incident.id,
      setTimer(() => void fire(incident.id, paseo, home), delay),
    );
  };

  const wait: FallbackAction = async (incident, paseo, rpcDeps: FallbackRpcDeps) => {
    const home = await homeOf(paseo, rpcDeps.home);
    if (home === null) throw new DashboardError("E_FALLBACK_NOT_FOUND", "paseo-bm cannot find its install home");
    const resetsAt = incident.resetsAt === null ? Number.NaN : Date.parse(incident.resetsAt);
    const at = (rpcDeps.now ?? now)();
    if (Number.isNaN(resetsAt)) throw new DashboardError("E_FALLBACK_NO_RESET", "the reset time of this limit is not known");
    if (resetsAt - at.getTime() > MAX_WAIT_MS) throw new DashboardError("E_FALLBACK_NO_RESET", "the limit resets more than 7 days from now");
    const waiting = await decidePending(
      home,
      incident.id,
      (current) => ({ ...current, status: "waiting", decidedAt: at.toISOString(), waitUntil: new Date(resetsAt + WAIT_GRACE_MS).toISOString() }),
      log,
    );
    arm(waiting, paseo, home);
    return waiting;
  };

  return {
    wait,
    cancel,
    async ensureArmed(paseo: unknown): Promise<void> {
      if (armed) return;
      armed = true;
      try {
        const home = await homeOf(paseo);
        if (home === null) {
          armed = false;
          return;
        }
        for (const incident of readIncidents(home, log).incidents) {
          if (incident.status === "waiting" && !timers.has(incident.id)) arm(incident, paseo, home);
        }
      } catch (error) {
        armed = false;
        log(`[paseo-bm] setting the fallback wait timers failed: ${reasonOf(error)}`);
      }
    },
    clear(): void {
      for (const timer of timers.values()) clearTimer(timer);
      timers.clear();
    },
  };
}
