/**
 * "Switch to <candidate>" for a stopped Manager (delta 20260921 §4.5.2,
 * REQ-066 c): the user is chatting with the Manager that stopped, so the
 * plugin creates the replacement in the same workspace, and the user opens it
 * from the usual entries (Beads Manager skips a replaced Manager).
 *
 * 1. The incident is still `pending` with a candidate (`fallback.act` runs one
 *    action at a time); the old Manager has no `bm.replacedBy`; the
 *    candidate's provider is available.
 * 2. `BM-HANDOVER` role manager (`managerHandover`, 5 s budget).
 * 3. `createManager` — the same path as `manager.ensure`, so the same
 *    instructions, Runtime facts and labels — on `bm-manager-fallback-<n>/<model>`,
 *    with the Manager rule's mode (`bm.modeSet` when one is chosen), the
 *    entry's thinking, `bm.replaces` = the old Manager, and the handover as
 *    its first message.
 * 4. `bm.replacedBy` on the old Manager; a failure only logs.
 * 5. Every live, non-replaced Worker of the workspace gets a `BM-SETTINGS`
 *    with the new Manager's id, through the notice queue.
 * 6. `switched` with `replacementId`; the caller sends BM-FALLBACK into the
 *    old Manager's chat.
 * 7. A creation that fails records `failed` and returns
 *    `E_FALLBACK_CREATE_FAILED`, never back to `pending`.
 */
import { unusableDataHomeMessage } from "./data-home";
import { peersOfWorkspace } from "./chat-peers";
import { createLocationResolver, resolveLocationFromPaseo } from "./collector";
import { bmAgentsOf, type DashboardPaseo } from "./dashboard-rpc";
import { REPLACED_BY_LABEL } from "./fallback-detect";
import { liveWorkersOf, managerHandover } from "./fallback-handover";
import { decidePending, type FallbackAction, type FallbackRpcDeps } from "./fallback-rpc";
import { readIncidents, replacementsOf } from "./fallback-state";
import { AGENT_TOOLS_OFF_SWITCH_MESSAGE, agentToolsOff, createManager, type ManagerPaseo } from "./manager";
import { enqueue as defaultEnqueue, type NoticeOutcome, type NoticePaseo } from "./notice-queue";
import { SETTINGS_NOTICE_MARKER } from "./notices";
import { setAgentLabels, type CliResult } from "./paseo-cli";
import { asRecord, availableProviders, nonEmpty, reasonOf } from "./role-choices";
import { currentInstructions } from "./role-extras";
import { capabilityOf, featuresFor, managerModeFor, modesFor, runPostureOf } from "./role-mode";
import { managerIdNotice } from "./settings-notices";
import type { TraceStoreLocation } from "./trace-store";
import { DashboardError, type FallbackIncident } from "../shared/contracts";

const REPLACES_LABEL = "bm.replaces";
const MODE_SET_LABEL = "bm.modeSet";

export interface ManagerSwitchDeps {
  log?: (message: string) => void;
  now?: () => Date;
  /** `setAgentLabels` of `paseo-cli.ts` by default. */
  setLabels?: (agentId: string, labels: Record<string, string>) => Promise<CliResult>;
  enqueue?: (targetId: string, kind: string, text: string, paseo?: NoticePaseo) => Promise<NoticeOutcome>;
  /** The Manager instructions; `currentInstructions("manager", paseo)` by default. */
  readInstructions?: (paseo: unknown) => Promise<string>;
  /** `managerHandover` by default. */
  handover?: (incident: FallbackIncident, deps: { paseo: unknown; location: TraceStoreLocation | null; incidents: readonly FallbackIncident[] | null }) => Promise<string>;
  /** The workspace trace store; the collector's resolver by default. */
  location?: (paseo: unknown) => Promise<TraceStoreLocation | null>;
}

/** The mode and features the replacement Manager starts with, by the candidate provider's capability. */
async function postureFor(
  paseo: unknown,
  candidate: NonNullable<FallbackIncident["candidate"]>,
  log: (message: string) => void,
): Promise<{ modeId?: string; featureValues?: Record<string, unknown> }> {
  const modes = await modesFor(paseo, candidate.alias, log);
  const capability = capabilityOf(modes);
  if (capability === "none") return {};
  if (capability === "tiered") {
    const modeId = managerModeFor(modes!, candidate.modeId);
    return modeId === undefined ? {} : { modeId };
  }
  if (capability === "untiered") {
    const features = await featuresFor(paseo, `${candidate.alias}/${candidate.model}`, undefined, log);
    const posture = runPostureOf("manager", capability, modes!, features, candidate.modeId);
    return {
      ...(typeof posture?.modeId === "string" ? { modeId: posture.modeId } : {}),
      ...(posture?.featureValues ? { featureValues: posture.featureValues } : {}),
    };
  }
  return candidate.modeId === null ? {} : { modeId: candidate.modeId };
}

/** The `switch` action of `fallback.act` for a Manager. */
export function createManagerSwitch(deps: ManagerSwitchDeps = {}): FallbackAction {
  const log = deps.log ?? ((message: string) => console.warn(message));
  const setLabels = deps.setLabels ?? ((agentId: string, labels: Record<string, string>) => setAgentLabels(agentId, labels));
  const enqueue = deps.enqueue ?? defaultEnqueue;
  const readInstructions = deps.readInstructions ?? ((paseo: unknown) => currentInstructions("manager", paseo));
  const handover = deps.handover ?? managerHandover;
  const location = deps.location ?? createLocationResolver(resolveLocationFromPaseo);

  return async (incident, paseo, rpcDeps: FallbackRpcDeps) => {
    const now = rpcDeps.now ?? deps.now ?? (() => new Date());
    const home = rpcDeps.home ?? null;
    if (home === null) throw new DashboardError("E_FALLBACK_NOT_FOUND", `${unusableDataHomeMessage()}; see Setup`);
    if (incident.role !== "manager") throw new DashboardError("E_FALLBACK_NO_CANDIDATE", `not a Manager incident (${incident.role})`);

    // 1. Still pending, with a candidate, and the old Manager not replaced yet.
    const incidents = readIncidents(home, log).incidents;
    const current = incidents.find((entry) => entry.id === incident.id);
    if (current === undefined) throw new DashboardError("E_FALLBACK_NOT_FOUND", `no fallback incident ${incident.id}`);
    if (current.status !== "pending") throw new DashboardError("E_FALLBACK_NOT_PENDING", `incident ${current.id} is ${current.status}, not pending`);
    const candidate = current.candidate;
    if (candidate === null) throw new DashboardError("E_FALLBACK_NO_CANDIDATE", "the fallback chain has no entry left for this Manager");
    let labels: Record<string, unknown>;
    try {
      const ref = (paseo as { agents: { ref(id: string): { refresh(): Promise<{ agent?: unknown } | null> } } }).agents.ref(current.agentId);
      labels = asRecord(asRecord((await ref.refresh())?.agent)?.["labels"]) ?? {};
    } catch (error) {
      // Nothing was created: the incident stays pending, so the user can try again.
      throw new DashboardError("E_FALLBACK_CREATE_FAILED", `could not read Manager ${current.agentId}: ${reasonOf(error)}; try again`);
    }
    const replacedBy = nonEmpty(labels[REPLACED_BY_LABEL]);
    if (replacedBy !== null) throw new DashboardError("E_FALLBACK_NOT_PENDING", `Manager ${current.agentId} was already replaced by ${replacedBy}`);
    const available = await availableProviders(paseo);
    if (available !== null && !available.has(candidate.baseProvider)) {
      throw new DashboardError("E_FALLBACK_NO_CANDIDATE", `${candidate.baseProvider} is not available in Paseo right now`);
    }
    // A Manager gets Paseo's tools only when it is created: one made now would
    // never create a Worker, and it would become the Manager Beads Manager opens.
    // Nothing was created: the incident stays pending.
    if (await agentToolsOff(paseo)) throw new DashboardError("E_FALLBACK_CREATE_FAILED", AGENT_TOOLS_OFF_SWITCH_MESSAGE);

    // 2. The handover, within its own budget.
    const prompt = await handover(current, { paseo, location: await location(paseo).catch(() => null), incidents });

    // 3. The replacement Manager, through the same path as manager.ensure.
    const posture = await postureFor(paseo, candidate, log);
    let created: { agentId: string };
    try {
      created = await createManager(paseo as ManagerPaseo, current.workspaceId, {
        providerSelection: `${candidate.alias}/${candidate.model}`,
        ...(posture.modeId !== undefined ? { modeId: posture.modeId } : {}),
        ...(candidate.thinkingOptionId !== null ? { thinkingOptionId: candidate.thinkingOptionId } : {}),
        ...(posture.featureValues !== undefined ? { featureValues: posture.featureValues } : {}),
        labels: { [REPLACES_LABEL]: current.agentId, ...(posture.modeId !== undefined ? { [MODE_SET_LABEL]: posture.modeId } : {}) },
        prompt,
        readInstructions: () => readInstructions(paseo),
      });
    } catch (error) {
      const detail = `could not create the fallback Manager on ${candidate.alias}/${candidate.model}: ${reasonOf(error)}`;
      await decidePending(home, current.id, (entry) => ({ ...entry, status: "failed", decidedAt: now().toISOString(), error: detail }), log);
      throw new DashboardError("E_FALLBACK_CREATE_FAILED", detail);
    }

    // 4. Mark the old Manager; Beads Manager also skips it by the incident.
    try {
      const labelled = await setLabels(current.agentId, { [REPLACED_BY_LABEL]: created.agentId });
      if (!labelled.ok) log(`[paseo-bm] could not label Manager ${current.agentId} as replaced by ${created.agentId}: ${labelled.reason}`);
    } catch (error) {
      log(`[paseo-bm] could not label Manager ${current.agentId} as replaced by ${created.agentId}: ${reasonOf(error)}`);
    }

    // 5. Every live Worker of the workspace reports to the new Manager from now on.
    try {
      const all = await bmAgentsOf(paseo as DashboardPaseo);
      const peers = await peersOfWorkspace(all, current.workspaceId, async () => [], replacementsOf(incidents));
      for (const worker of liveWorkersOf(peers)) {
        const outcome = await enqueue(worker.id, SETTINGS_NOTICE_MARKER, managerIdNotice(created.agentId), paseo as NoticePaseo);
        if (outcome === "dropped") log(`[paseo-bm] Worker ${worker.id} could not be told the new Manager ${created.agentId}.`);
      }
    } catch (error) {
      log(`[paseo-bm] telling the Workers of ${current.workspaceId} about the new Manager failed: ${reasonOf(error)}`);
    }

    // 6. Decided.
    return decidePending(
      home,
      current.id,
      (entry) => ({ ...entry, status: "switched", decidedAt: now().toISOString(), replacementId: created.agentId }),
      log,
    );
  };
}
