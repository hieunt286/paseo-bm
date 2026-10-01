/**
 * A role marker at the front of every paseo-bm agent's title, so its tab tells
 * the roles apart at a glance (owner choice 2026-10-01: a colour dot and the
 * role's initial). Paseo gives an agent no colour or icon of its own: a tab
 * shows the provider's icon and the title, and a provider alias has no icon,
 * so the title is the one place a role can show.
 *
 * Applied by the `before("agent.create")` hook to every creation it handles,
 * whoever asks for it. A creation without a title is left alone, so Paseo's
 * own naming still applies to it. paseo-bm's own screens show the title
 * without it (`withoutRoleMarker`), where the role is named anyway.
 */
import { roleOfProvider, type BmRole } from "./agent-role";

/** The marker of each role, followed by `TITLE_MARKER_SEPARATOR`. */
export const ROLE_TITLE_MARKERS: Readonly<Record<BmRole, string>> = {
  manager: "\u{1F7E3} M",
  worker: "\u{1F535} W",
  reviewer: "\u{1F7E0} R",
  orchestrator: "\u{1F7E2} O",
};

/** Between the marker and the title. */
export const TITLE_MARKER_SEPARATOR = " · ";

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
