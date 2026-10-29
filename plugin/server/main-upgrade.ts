/**
 * Outdated Mains handed over when idle (delivery line design §19.12; owner,
 * 2026-10-25: "replace the old Main when it is idle").
 *
 * Paseo fixes an agent's instructions when it is created, so after an update
 * of paseo-bm a running Main keeps the older `manager.md` until it is
 * replaced; until then it works by the old rules. Each minute
 * (`index.server.ts`), every open mission whose Main:
 *
 * - is live and idle (neither `running` nor `initializing`), not archived,
 *   closed or replaced;
 * - carries another `bm.instructions` hash than this build's for a Manager
 *   (`hasOutdatedInstructions`), and is older than `STAMP_GRACE_MS`;
 *
 * is handed over to a successor through the one path a Main's code handoff
 * takes (`handOverMain`: the mission state brief, then `replaceMain`), with a
 * notice that tells the successor why and to say so to the owner in one line.
 * Workers are not touched: they end with their requests. Once per Main per
 * process; nothing is archived (ADR-005). Never throws.
 */
import { REPLACED_BY_LABEL } from "./fallback-detect";
import { INSTRUCTIONS_LABEL, hasOutdatedInstructions } from "./instructions-label";
import { createMissionStore } from "./mission-store";
import { handOverMain, type MissionsHomeDeps, type MissionsPaseo } from "./missions-home";
import { STAMP_GRACE_MS } from "./outdated-agents";
import { errorText } from "./rpc-kit";

/** The Mains handed over in this process: one try each. */
const handedOver = new Set<string>();

/** The notice the successor reads after the mission state (§19.12). Pure. */
export function upgradeHandoffLineOf(oldMainId: string): string {
  return `You take this mission over from Main ${oldMainId}: it ran the instructions of an older paseo-bm, so after the update paseo-bm handed the mission over to you with the current ones. Its chat keeps the earlier conversation; start from the mission state above. In your first reply tell the owner in one line that you took over after the update and what is in flight, from that state.`;
}

/** The slice of a fetched agent this reads. */
interface MainSnapshot {
  status?: string;
  archivedAt?: string | null;
  createdAt?: string;
  labels?: Record<string, string>;
}

/** Whether a Main's snapshot is idle, live and on older instructions (see the module comment). Pure. */
export function isIdleOutdatedMain(agent: MainSnapshot | null, now: Date): boolean {
  if (agent === null || agent.archivedAt || agent.status === "closed") return false;
  if (agent.status === "running" || agent.status === "initializing") return false;
  const labels = agent.labels ?? {};
  if (labels[REPLACED_BY_LABEL] !== undefined) return false;
  if (!hasOutdatedInstructions(labels, "manager")) return false;
  if (labels[INSTRUCTIONS_LABEL] === undefined) {
    const created = typeof agent.createdAt === "string" ? Date.parse(agent.createdAt) : Number.NaN;
    if (!Number.isNaN(created) && now.getTime() - created < STAMP_GRACE_MS) return false;
  }
  return true;
}

/** Hands every idle outdated Main of an open mission over (see the module comment). Never throws. */
export async function replaceOutdatedMains(home: string, paseo: unknown, deps: MissionsHomeDeps & { handOver?: typeof handOverMain }): Promise<void> {
  const log = deps.log ?? ((message: string) => console.warn(message));
  const now = deps.now ?? (() => new Date());
  try {
    const store = createMissionStore(home);
    const handle = paseo as { agents?: { ref(id: string): { refresh(): Promise<{ agent?: unknown } | null> } } };
    for (const entry of store.list().filter((mission) => mission.state === "open" && mission.mainId !== null)) {
      const mainId = entry.mainId!;
      if (handedOver.has(mainId)) continue;
      let agent: MainSnapshot | null = null;
      try {
        agent = ((await handle.agents?.ref(mainId).refresh())?.agent ?? null) as MainSnapshot | null;
      } catch {
        agent = null;
      }
      if (!isIdleOutdatedMain(agent, now())) continue;
      const mission = store.get(entry.missionId);
      if (mission === null || mission.mainId !== mainId) continue;
      handedOver.add(mainId);
      try {
        const { handOver = handOverMain, ...homeDeps } = deps;
        const successor = await handOver(mission, paseo as MissionsPaseo, upgradeHandoffLineOf(mainId), { ...homeDeps, home, now, log });
        log(`[paseo-bm] Main ${mainId} of mission ${mission.code} ran older instructions; it was handed over to ${successor} while idle.`);
      } catch (error) {
        log(`[paseo-bm] Main ${mainId} of mission ${mission.code} runs older instructions but could not be handed over: ${errorText(error)}`);
      }
    }
  } catch (error) {
    log(`[paseo-bm] outdated Mains could not be checked: ${errorText(error)}`);
  }
}

/** Forgets the Mains handed over, as a plugin reload does; tests only. */
export function clearHandedOverMains(): void {
  handedOver.clear();
}
