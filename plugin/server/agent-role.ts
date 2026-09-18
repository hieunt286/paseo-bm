/**
 * Which paseo-bm role an agent has (delta 20260918g §4.1, REQ-061 a).
 *
 * The `bm.role` label is the usual answer, but it is not the only one: an agent
 * started from Paseo's own new-agent flow with a paseo-bm profile runs the role
 * (the `before("agent.create")` hook gives it the instructions) and carries no
 * label at all, because that hook can change `{ config, env }` only. The owner's
 * "Refactor Dependency" Manager was such an agent, and every lookup that
 * filtered on the label treated its chat as "not paseo-bm's" (bead bm-llmg).
 * So the provider decides whenever the label does not.
 *
 * Pure apart from `listAllAgents`, which only calls the `list` it is given.
 */
import { providerId } from "./provider-id";

export type BmRole = "manager" | "worker" | "reviewer";

/** The role, and whether it came from the `bm.role` label (true) or only from the provider (false). */
export interface RoleFact {
  role: BmRole;
  labelled: boolean;
}

/** Label key that names an agent's paseo-bm role. */
export const ROLE_LABEL = "bm.role";

/** The paseo-bm provider aliases and the role each one runs. */
export const ROLE_BY_PROVIDER: Readonly<Record<string, BmRole>> = {
  "bm-manager": "manager",
  "bm-worker": "worker",
  "bm-reviewer": "reviewer",
};

const ROLES: ReadonlySet<string> = new Set(["manager", "worker", "reviewer"]);

/** The role a provider selection (`bm-worker` or `bm-worker/<model>`) runs, or null. */
export function roleOfProvider(provider: unknown): BmRole | null {
  const id = providerId(provider);
  return id !== null && Object.prototype.hasOwnProperty.call(ROLE_BY_PROVIDER, id) ? ROLE_BY_PROVIDER[id]! : null;
}

/**
 * The role of an agent snapshot, or null when it is not a paseo-bm agent.
 * A valid `bm.role` label wins; otherwise the provider decides, which also
 * covers a label holding an unknown value. Never throws.
 */
export function roleOfAgent(agent: unknown): RoleFact | null {
  try {
    if (agent === null || typeof agent !== "object") return null;
    const { labels, provider } = agent as { labels?: unknown; provider?: unknown };
    const label =
      labels !== null && typeof labels === "object" ? (labels as Record<string, unknown>)[ROLE_LABEL] : undefined;
    if (typeof label === "string" && ROLES.has(label)) return { role: label as BmRole, labelled: true };
    const role = roleOfProvider(provider);
    return role === null ? null : { role, labelled: false };
  } catch {
    return null;
  }
}

/** Page size of every `agents.list` walk; the daemon caps a page at 200. */
export const LIST_PAGE_LIMIT = 200;

/**
 * Walks every page of an `agents.list` query and returns all snapshots.
 * A page without `pageInfo` is the last one, so a host (or fake) that pages
 * nothing still works.
 */
export async function listAllAgents<Filter, Snapshot>(
  list: (options: {
    filter: Filter;
    page: { limit: number; cursor?: string };
  }) => Promise<{
    entries: Array<{ agent: Snapshot }>;
    pageInfo?: { nextCursor: string | null; hasMore: boolean };
  }>,
  filter: Filter,
): Promise<Snapshot[]> {
  const found: Snapshot[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await list({
      filter,
      page: cursor === undefined ? { limit: LIST_PAGE_LIMIT } : { limit: LIST_PAGE_LIMIT, cursor },
    });
    for (const { agent } of page.entries) found.push(agent);
    if (!page.pageInfo?.hasMore || !page.pageInfo.nextCursor) break;
    cursor = page.pageInfo.nextCursor;
  }
  return found;
}
