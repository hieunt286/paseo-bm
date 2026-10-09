/**
 * A role marker at the front of every paseo-bm agent's title, so its tab tells
 * the roles apart at a glance (owner choice 2026-10-01: a colour dot and the
 * role's initial). Paseo gives an agent no colour or icon of its own: a tab
 * shows the provider's icon and the title, and a provider alias has no icon,
 * so the title is the one place a role can show.
 *
 * Applied by the `before("agent.create")` hook to every creation it handles,
 * whoever asks for it. A creation without a title is left alone, so Paseo's
 * own naming still applies to it; `createTitleMarker` marks that name at the
 * agent's first turn. paseo-bm's own screens show the title
 * without it (`withoutRoleMarker`), where the role is named anyway.
 */
import { roleOfProvider, type BmRole } from "./agent-role";
import { createMissionStore } from "./mission-store";
import { MAX_AGENT_TITLE_CHARS, setAgentTitle, type PaseoCliDeps } from "./paseo-cli";
import { dataHome } from "./rpc-kit";

/** The marker of each role, followed by `TITLE_MARKER_SEPARATOR`. */
export const ROLE_TITLE_MARKERS: Readonly<Record<BmRole, string>> = {
  manager: "\u{1F7E3} M",
  worker: "\u{1F535} W",
  reviewer: "\u{1F7E0} R",
  orchestrator: "\u{1F7E2} O",
};

/** Between the marker and the title. */
export const TITLE_MARKER_SEPARATOR = " · ";

/** A Main's mission (missions design §3.2): `bm.missionId=<missionId>`, `bm.missionCode=<code>`. */
export const MISSION_ID_LABEL = "bm.missionId";
export const MISSION_CODE_LABEL = "bm.missionCode";

/** The label that marks a replaced agent (`mission-replace.ts`, `fallback-detect.ts`). */
const REPLACED_BY_LABEL = "bm.replacedBy";

/** What an unassigned Main is called until `bm_mission_start` names its mission (§3.3). */
export const UNASSIGNED_MAIN_TITLE = "New mission";

/**
 * A Main's title, marked (§3.2): `🟣 M · <code> <name>`, at most
 * `MAX_AGENT_TITLE_CHARS`, the name on one line and cut at a word end. Pure.
 */
export function mainTitleOf(code: string, name: string): string {
  return titleWithin(code, name, MAX_AGENT_TITLE_CHARS);
}

/** After a replaced Main's mission title (§3.4 step 5). */
export const REPLACED_MAIN_SUFFIX = " · replaced";

/**
 * A replaced Main's title (§3.4 step 5): `mainTitleOf` + `REPLACED_MAIN_SUFFIX`,
 * the name cut so the whole stays within `MAX_AGENT_TITLE_CHARS`. Pure.
 */
export function replacedMainTitleOf(code: string, name: string): string {
  return `${titleWithin(code, name, MAX_AGENT_TITLE_CHARS - REPLACED_MAIN_SUFFIX.length)}${REPLACED_MAIN_SUFFIX}`;
}

/** `🟣 M · <code> <name>` in at most `limit` characters, the name on one line and cut at a word end. */
function titleWithin(code: string, name: string, limit: number): string {
  const prefix = withRoleMarker("manager", code);
  const room = limit - prefix.length - 1;
  const plain = name.replace(/\s+/g, " ").trim();
  if (plain === "" || room <= 0) return prefix.slice(0, limit);
  if (plain.length <= room) return `${prefix} ${plain}`;
  const cut = plain.slice(0, room + 1);
  const end = cut.lastIndexOf(" ");
  return `${prefix} ${(end > 0 ? cut.slice(0, end) : plain.slice(0, room)).trimEnd()}`;
}

/** `title` with its role's marker in front, or the title unchanged when it already has one. */
export function withRoleMarker(role: BmRole, title: string): string {
  const prefix = `${ROLE_TITLE_MARKERS[role]}${TITLE_MARKER_SEPARATOR}`;
  return title.startsWith(prefix) ? title : `${prefix}${title.trim()}`;
}

/**
 * `title` without a role marker in front: paseo-bm's own screens already name
 * the role beside a title, so they show it plain. Null stays null.
 */
export function withoutRoleMarker<T extends string | null | undefined>(title: T): T {
  if (typeof title !== "string") return title;
  for (const marker of Object.values(ROLE_TITLE_MARKERS)) {
    const prefix = `${marker}${TITLE_MARKER_SEPARATOR}`;
    if (title.startsWith(prefix)) return title.slice(prefix.length) as T;
  }
  return title;
}

/**
 * The request with its title marked, or `undefined` when nothing changes: not
 * a paseo-bm provider, no title, or a title already marked. Never throws.
 */
export function applyRoleTitle<T extends { config: { provider?: unknown; title?: unknown } }>(request: T): T | undefined {
  try {
    const config = (request as Partial<T> | null | undefined)?.config;
    if (config === null || typeof config !== "object") return undefined;
    const role = roleOfProvider(config.provider);
    const title = config.title;
    if (role === null || typeof title !== "string" || title.trim() === "") return undefined;
    const marked = withRoleMarker(role, title);
    return marked === title ? undefined : { ...request, config: { ...config, title: marked } };
  } catch {
    return undefined;
  }
}

/** The SDK slice `createTitleMarker` reads an agent's current title with. */
export interface TitlePaseo {
  agents: { ref(id: string): { refresh(): Promise<{ agent: { title?: string | null; labels?: Record<string, string> | null } } | null> } };
}

export interface TitleMarkerDeps {
  cli?: PaseoCliDeps;
  log?: (message: string) => void;
  /** A mission's code and name (§3.2); the data folder's mission store by default. */
  missionOf?: (missionId: string) => { code: string; name: string } | null;
}

/** The mission of the data folder, or null. Never throws. */
function storedMission(missionId: string): { code: string; name: string } | null {
  try {
    const home = dataHome();
    return home === null ? null : createMissionStore(home).get(missionId);
  } catch {
    return null;
  }
}

export type RemarkOutcome = "not-bm" | "already-marked" | "no-title" | "marked" | "failed";

/**
 * Puts the marker back on a paseo-bm agent whose title Paseo set after its
 * creation. Clearing an agent's conversation in the app archives it and
 * creates a new one with no title; Paseo then names it from its first message
 * (`prepareAgentMessage`, Paseo 0.9.2) without going through
 * `before("agent.create")`, so the marker is missing from then on.
 *
 * Called from `on("agent.turn_started")`, which comes after that naming. The
 * event's `title` is the one the agent was created with, so a title that is
 * not marked there is read again from a fresh snapshot. Each agent is settled
 * once per plugin process: a later rename by the owner stays as it is.
 *
 * A Main labelled `bm.missionId` (missions design §3.2) gets its whole title
 * back from its mission (`mainTitleOf`), not only the marker, untitled or not;
 * one labelled `bm.replacedBy` as well (§3.4 step 5) gets `replacedMainTitleOf`,
 * never the mission title its successor carries.
 */
export function createTitleMarker(deps: TitleMarkerDeps = {}) {
  const log = deps.log ?? ((message: string) => console.warn(message));
  const missionOf = deps.missionOf ?? storedMission;
  const settled = new Set<string>();

  async function remark(agent: { id: string; provider: unknown; title?: string | null }, paseo: TitlePaseo): Promise<RemarkOutcome> {
    const role = roleOfProvider(agent.provider);
    if (role === null) return "not-bm";
    if (settled.has(agent.id)) return "already-marked";
    if (isMarked(role, agent.title)) {
      settled.add(agent.id);
      return "already-marked";
    }
    // Marked before the first await: two turns starting together check it once.
    settled.add(agent.id);
    try {
      const snapshot = (await paseo.agents.ref(agent.id).refresh())?.agent;
      const title = snapshot?.title ?? null;
      const missionId = role === "manager" ? snapshot?.labels?.[MISSION_ID_LABEL] : undefined;
      const mission = typeof missionId === "string" && missionId !== "" ? missionOf(missionId) : null;
      const replaced = typeof snapshot?.labels?.[REPLACED_BY_LABEL] === "string";
      const wanted = mission === null ? null : (replaced ? replacedMainTitleOf : mainTitleOf)(mission.code, mission.name);
      if (wanted === null && (typeof title !== "string" || title.trim() === "")) {
        settled.delete(agent.id);
        return "no-title";
      }
      if (wanted === null ? isMarked(role, title) : title === wanted) return "already-marked";
      const marked = wanted ?? withRoleMarker(role, withoutRoleMarker(title as string)).slice(0, MAX_AGENT_TITLE_CHARS);
      const result = await setAgentTitle(agent.id, marked, deps.cli);
      if (!result.ok) {
        settled.delete(agent.id);
        log(`[paseo-bm] could not mark the title of ${agent.id}: ${result.reason}`);
        return "failed";
      }
      return "marked";
    } catch (error) {
      settled.delete(agent.id);
      log(`[paseo-bm] could not mark the title of ${agent.id}: ${error instanceof Error ? error.message : String(error)}`);
      return "failed";
    }
  }

  return { remark };
}

export type TitleMarker = ReturnType<typeof createTitleMarker>;

function isMarked(role: BmRole, title: string | null | undefined): boolean {
  return typeof title === "string" && title.startsWith(`${ROLE_TITLE_MARKERS[role]}${TITLE_MARKER_SEPARATOR}`);
}
