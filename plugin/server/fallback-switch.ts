/**
 * "Switch to <candidate>" for a stopped Worker (delta 20260921 §4.4.7,
 * REQ-065 d): the plugin creates the replacement Worker on the candidate's
 * fallback alias, with a handover built in code.
 *
 * 1. One switch at a time (in-process mutex; `fallback.act` also runs every
 *    card action one at a time, so a concurrent Wait or Dismiss cannot decide
 *    the incident while a Switch is under way — review b6): the incident must
 *    still be `pending` with a candidate, and the old Worker not already
 *    replaced (`bm.replacedBy`). A second click waits, then finds it decided.
 * 2. The candidate's base provider is still available.
 * 3. The handover (`fallback-handover.ts`, 5 s budget).
 * 4. `agents.create` on `bm-worker-fallback-<n>/<model>`, in the old Worker's
 *    directory, as a child of its Manager. The `agent.create` hook still runs,
 *    so the Worker gets its instructions and its start posture.
 * 5. `bm.replacedBy` on the old Worker (Paseo CLI); a failure only logs — the
 *    incident's `replacementId` excludes the old Worker too (§4.4.8).
 * 6. The old Worker's RUNNING Reviewers get the existing stop notice.
 * 7. `switched`, `replacementId`, `decidedAt`; the caller sends BM-FALLBACK.
 * 8. A creation that fails records `failed` with the error and returns
 *    `E_FALLBACK_CREATE_FAILED`: the incident never goes back to `pending`, so
 *    a repeated click can never create two Workers. A problem found BEFORE the
 *    creation (the old Worker cannot be read) creates nothing and leaves the
 *    incident pending.
 */
import { unusableDataHomeMessage } from "./data-home";
import { createLocationResolver, resolveLocationFromPaseo } from "./collector";
import { decidePending, type FallbackAction, type FallbackRpcDeps } from "./fallback-rpc";
import { REPLACED_BY_LABEL } from "./fallback-detect";
import { workerHandover } from "./fallback-handover";
import { readIncidents } from "./fallback-state";
import { setAgentLabels, type CliResult } from "./paseo-cli";
import { asRecord, availableProviders, nonEmpty, reasonOf } from "./role-choices";
import { dataHomeOf } from "./role-extras";
import { capabilityOf, chooseModeId, featuresFor, modesFor, runPostureOf } from "./role-mode";
import { stopRunningReviewers, type StopPaseo } from "./stop-propagation";
import type { TraceStoreLocation } from "./trace-store";
import { DashboardError, type FallbackIncident } from "../shared/contracts";
import { PLUGIN_VERSION } from "../shared/version";

/** Title of every replacement Worker. */
export const FALLBACK_WORKER_TITLE = "Beads Worker (fallback)";

/** Label a replacement agent carries: the id of the agent it replaces. */
export const REPLACES_LABEL = "bm.replaces";

/** The SDK slice a switch uses; `PaseoApi` is structurally assignable. */
export interface SwitchPaseo {
  agents: {
    create(options: {
      config: Record<string, unknown>;
      cwd: string;
      parent?: string;
      title: string;
      labels: Record<string, string>;
      prompt: string;
    }): Promise<{ id: string }>;
    ref(agentId: string): { refresh(): Promise<{ agent?: unknown } | null> };
  };
}

export interface SwitchDeps {
  log?: (message: string) => void;
  now?: () => Date;
  /** `setAgentLabels` of `paseo-cli.ts` by default. */
  setLabels?: (agentId: string, labels: Record<string, string>) => Promise<CliResult>;
  /** `stopRunningReviewers` of `stop-propagation.ts` by default. */
  stopReviewers?: (paseo: unknown, workerId: string, workspaceId: string | null) => Promise<unknown>;
  /** `workerHandover` by default. */
  handover?: (incident: FallbackIncident, deps: { paseo: unknown; location: TraceStoreLocation | null }) => Promise<string>;
  /** The workspace trace store; the collector's resolver by default. */
  location?: (paseo: unknown) => Promise<TraceStoreLocation | null>;
}

let queue: Promise<unknown> = Promise.resolve();

/** Runs `work` after every switch queued before it; a failure does not block the next one. */
function serialised<T>(work: () => Promise<T>): Promise<T> {
  const run = queue.then(work, work);
  queue = run.catch(() => undefined);
  return run;
}

/** The `switch` action of `fallback.act`, for the Worker. */
export function createWorkerSwitch(deps: SwitchDeps = {}): FallbackAction {
  const log = deps.log ?? ((message: string) => console.warn(message));
  const setLabels = deps.setLabels ?? ((agentId: string, labels: Record<string, string>) => setAgentLabels(agentId, labels));
  const stopReviewers =
    deps.stopReviewers ?? ((paseo: unknown, workerId: string, workspaceId: string | null) => stopRunningReviewers(paseo as StopPaseo, workerId, workspaceId));
  const handover = deps.handover ?? workerHandover;
  const location = deps.location ?? createLocationResolver(resolveLocationFromPaseo);

  return (incident, paseo, rpcDeps: FallbackRpcDeps) =>
    serialised(async () => {
      const now = rpcDeps.now ?? deps.now ?? (() => new Date());
      const home = rpcDeps.home !== undefined ? rpcDeps.home : dataHomeOf();
      if (home === null) throw new DashboardError("E_FALLBACK_NOT_FOUND", `${unusableDataHomeMessage()}; see Setup`);
      if (incident.role !== "worker") throw new DashboardError("E_FALLBACK_NO_CANDIDATE", `switching a ${incident.role} arrives in a later release`);

      // 1. Still pending (a second click finds it decided) and not replaced yet.
      const current = readIncidents(home, log).incidents.find((entry) => entry.id === incident.id);
      if (current === undefined) throw new DashboardError("E_FALLBACK_NOT_FOUND", `no fallback incident ${incident.id}`);
      if (current.status !== "pending") throw new DashboardError("E_FALLBACK_NOT_PENDING", `incident ${current.id} is ${current.status}, not pending`);
      const candidate = current.candidate;
      if (candidate === null) throw new DashboardError("E_FALLBACK_NO_CANDIDATE", "the fallback chain has no entry left for this Worker");
      const api = paseo as SwitchPaseo;
      let snapshot: Record<string, unknown> | null;
      try {
        snapshot = asRecord((await api.agents.ref(current.agentId).refresh())?.agent);
      } catch (error) {
        // Nothing was created: the incident stays pending, so the user can try again.
        throw new DashboardError("E_FALLBACK_CREATE_FAILED", `could not read Worker ${current.agentId}: ${reasonOf(error)}; try again`);
      }
      const labels = asRecord(snapshot?.["labels"]) ?? {};
      const replacedBy = nonEmpty(labels[REPLACED_BY_LABEL]);
      if (replacedBy !== null) throw new DashboardError("E_FALLBACK_NOT_PENDING", `Worker ${current.agentId} was already replaced by ${replacedBy}`);

      // 2. The candidate's provider is still there (when Paseo can say).
      const available = await availableProviders(paseo);
      if (available !== null && !available.has(candidate.baseProvider)) {
        throw new DashboardError("E_FALLBACK_NO_CANDIDATE", `${candidate.baseProvider} is not available in Paseo right now`);
      }

      const fail = async (detail: string): Promise<never> => {
        await decidePending(home, current.id, (entry) => ({ ...entry, status: "failed", decidedAt: now().toISOString(), error: detail }), log);
        throw new DashboardError("E_FALLBACK_CREATE_FAILED", detail);
      };
      const cwd = nonEmpty(snapshot?.["cwd"]);
      if (cwd === null) throw new DashboardError("E_FALLBACK_CREATE_FAILED", `the directory of Worker ${current.agentId} cannot be read`);

      // 3. The handover, within its own budget.
      const prompt = await handover(current, { paseo, location: await location(paseo).catch(() => null) });

      // 4. The replacement Worker; the agent.create hook adds its instructions.
      const alias = candidate.alias;
      const modes = await modesFor(paseo, alias, log, cwd);
      const capability = capabilityOf(modes);
      const features = capability === "untiered" ? await featuresFor(paseo, `${alias}/${candidate.model}`, cwd, log) : null;
      const posture = runPostureOf("worker", capability, modes ?? [], features, candidate.modeId);
      // Tiered (Claude, Codex): the Worker rule the hook applies, passed explicitly.
      const modeId =
        candidate.modeId ?? (capability === "tiered" && modes !== null ? chooseModeId("worker", modes, undefined, null) : (posture?.modeId ?? undefined));
      const featureValues = posture?.featureValues ?? undefined;
      let created: { id: string };
      try {
        created = await api.agents.create({
          config: {
            provider: `${alias}/${candidate.model}`,
            ...(candidate.thinkingOptionId !== null ? { thinkingOptionId: candidate.thinkingOptionId } : {}),
            ...(modeId !== undefined && capability !== "none" ? { modeId } : {}),
            ...(featureValues !== undefined ? { featureValues } : {}),
          },
          cwd,
          ...(current.managerId !== null ? { parent: current.managerId } : {}),
          title: FALLBACK_WORKER_TITLE,
          labels: {
            "bm.role": "worker",
            ...(current.requestId !== null ? { "bm.requestId": current.requestId } : {}),
            "bm.version": PLUGIN_VERSION,
            [REPLACES_LABEL]: current.agentId,
          },
          prompt,
        });
      } catch (error) {
        return fail(`could not create the fallback Worker on ${alias}/${candidate.model}: ${reasonOf(error)}`);
      }

      // 5. Mark the old Worker; the incident's replacementId excludes it even if this fails.
      try {
        const labelled = await setLabels(current.agentId, { [REPLACED_BY_LABEL]: created.id });
        if (!labelled.ok) log(`[paseo-bm] could not label Worker ${current.agentId} as replaced by ${created.id}: ${labelled.reason}`);
      } catch (error) {
        log(`[paseo-bm] could not label Worker ${current.agentId} as replaced by ${created.id}: ${reasonOf(error)}`);
      }

      // 6. The old Worker's running Reviewers stop.
      try {
        await stopReviewers(paseo, current.agentId, current.workspaceId);
      } catch (error) {
        log(`[paseo-bm] could not stop the Reviewers of Worker ${current.agentId}: ${reasonOf(error)}`);
      }

      // 7. Decided.
      return decidePending(
        home,
        current.id,
        (entry) => ({ ...entry, status: "switched", decidedAt: now().toISOString(), replacementId: created.id }),
        log,
      );
    });
}
