/**
 * A link's events in the journals of the missions it concerns (mission
 * runtime design §2.3, ADR-033 decision 1): asked, taken, answered, closed.
 * The peer-link store calls `journalLinkEvent` after each change it writes,
 * so every path — a Worker's `bm_ask_project`, a Main's `bm_ask_mission`, a
 * link taken by `bm_create_worker` or `bm_tell_worker`, a reply, a close — is
 * in the mission's history. Never throws: a failure is one log line.
 */
import { createMissionStore, journalQuietly } from "./mission-store";
import { requestIndexOf } from "./mission-roster";
import type { PeerLink } from "./peer-links";

export type LinkEvent = "asked" | "taken" | "answered" | "closed";

/** The missions a link concerns: its asker's (by request or by Main), its answerer's, and the mission it was addressed to. Never throws. */
export function missionsOfLink(home: string, link: Pick<PeerLink, "from" | "to" | "missionId">): { asker: string[]; answerer: string[] } {
  const asker = new Set<string>();
  const answerer = new Set<string>();
  try {
    const store = createMissionStore(home);
    const byRequest = (requestId: string | null) => (requestId === null ? null : (requestIndexOf(home, requestId)?.missionId ?? null));
    const fromMission = byRequest(link.from.requestId) ?? store.openByMain(link.from.agentId)?.missionId ?? null;
    if (fromMission !== null) asker.add(fromMission);
    const toMission = byRequest(link.to.requestId) ?? link.missionId ?? (link.to.managerId === null ? null : (store.openByMain(link.to.managerId)?.missionId ?? null));
    if (toMission !== null) answerer.add(toMission);
  } catch {
    // No mission found: nothing to journal.
  }
  return { asker: [...asker], answerer: [...answerer] };
}

/** The journal line of a link event, for one side. Pure. */
export function linkEventLineOf(event: LinkEvent, link: Pick<PeerLink, "linkId" | "kind" | "text" | "from" | "to" | "closedBy">, side: "asker" | "answerer"): string {
  const gist = link.text.replace(/\s+/g, " ").trim();
  const short = gist.length <= 160 ? gist : `${gist.slice(0, 159)}…`;
  switch (event) {
    case "asked":
      return side === "asker"
        ? `Link ${link.linkId} asked ${link.to.workspaceId} (${link.kind}): ${short}`
        : `Link ${link.linkId} from ${link.from.workspaceId}${link.from.requestId === null ? "" : ` (${link.from.requestId})`} asks (${link.kind}): ${short}`;
    case "taken":
      return `Link ${link.linkId} taken by ${link.to.requestId ?? "a request"} (Worker ${link.to.workerId ?? "none"})`;
    case "answered":
      return `Link ${link.linkId} answered`;
    case "closed":
      return `Link ${link.linkId} closed by the ${link.closedBy ?? "owner"}`;
  }
}

/** Writes `event` of `link` to each mission it concerns, once per mission. Never throws. */
export function journalLinkEvent(home: string, event: LinkEvent, link: PeerLink, log: (message: string) => void = (message) => console.warn(message)): void {
  try {
    const { asker, answerer } = missionsOfLink(home, link);
    const store = createMissionStore(home);
    const written = new Set<string>();
    for (const [side, missions] of [["asker", asker], ["answerer", answerer]] as const) {
      for (const missionId of missions) {
        if (written.has(missionId)) continue;
        written.add(missionId);
        journalQuietly(store, missionId, { kind: "link", by: "plugin", text: linkEventLineOf(event, link, side), ref: link.linkId }, log);
      }
    }
  } catch (error) {
    log(`[paseo-bm] could not journal the ${event} of link ${link.linkId}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
