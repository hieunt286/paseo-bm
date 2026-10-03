/**
 * Which paseo-bm role an agent has (design §16.3, ADR-027 decision 6).
 *
 * The provider decides, and only the provider: `bm-<role>`, `bm-<role>/<model>`
 * and the fallback aliases `bm-<role>-fallback-<n>` run their role, any other
 * provider runs none. The `bm.role` label is display only: it says whether the
 * agent was labelled (`RoleFact.labelled`), never which role it has, so no
 * agent can claim a role by carrying a label. An agent whose label disagrees
 * with its provider is logged once per plugin run.
 *
 * Pure apart from that log and `listAllAgents`, which only calls the `list`
 * it is given.
 */
import { fallbackAliasOf } from "../shared/fallback";
import { providerId } from "./provider-id";

export type BmRole = "manager" | "worker" | "reviewer" | "orchestrator";

/** The role (from the provider), and whether the `bm.role` label names that same role (true) or not (false). */
export interface RoleFact {
  role: BmRole;
  labelled: boolean;
}

/** Label key that names an agent's paseo-bm role. */
export const ROLE_LABEL = "bm.role";

/**
 * The four main paseo-bm provider aliases and the role each one runs. A
 * fallback alias `bm-<role>-fallback-<n>` runs the role in its name
 * (`roleOfProvider`, delta 20260921 §4.4.1); it is not listed here, and the
 * Orchestrator has none (orchestrator design §3.1).
 */
export const ROLE_BY_PROVIDER: Readonly<Record<string, BmRole>> = {
  "bm-manager": "manager",
  "bm-worker": "worker",
  "bm-reviewer": "reviewer",
  "bm-orchestrator": "orchestrator",
};

const ROLES: ReadonlySet<string> = new Set(["manager", "worker", "reviewer", "orchestrator"]);

/**
 * The role a provider selection runs, or null: `bm-worker` and
 * `bm-worker/<model>` run the Worker, and so do `bm-worker-fallback-<1..3>`
 * (with or without `/<model>`).
 */
export function roleOfProvider(provider: unknown): BmRole | null {
  const id = providerId(provider);
  if (id === null) return null;
  if (Object.prototype.hasOwnProperty.call(ROLE_BY_PROVIDER, id)) return ROLE_BY_PROVIDER[id]!;
  return fallbackAliasOf(id)?.role ?? null;
}

/** The `bm.role` label's value when it names a role, else null. Never throws. */
export function roleLabelOf(labels: unknown): BmRole | null {
  if (labels === null || typeof labels !== "object") return null;
  const label = (labels as Record<string, unknown>)[ROLE_LABEL];
  return typeof label === "string" && ROLES.has(label) ? (label as BmRole) : null;
}

/** Agents already logged for a disagreeing label in this plugin run. */
const disagreementLogged = new Set<string>();
let logDisagreement: (line: string) => void = (line) => console.warn(line);

/**
 * Test seam: routes the disagreement log to `log` (`console.warn` when
 * omitted) and forgets which agents were logged, as a new plugin run would.
 */
export function resetRoleDisagreementLog(log?: (line: string) => void): void {
  disagreementLogged.clear();
  logDisagreement = log ?? ((line) => console.warn(line));
}

function noteDisagreement(id: unknown, label: unknown, provider: unknown, role: BmRole | null): void {
  if (typeof id !== "string" || id === "" || disagreementLogged.has(id)) return;
  disagreementLogged.add(id);
  logDisagreement(
    `[paseo-bm] agent ${id} is labelled bm.role=${String(label)} but runs on ${String(provider)}; its role is ${role ?? "none"}`,
  );
}

/**
 * The role of an agent snapshot, or null when it is not a paseo-bm agent: the
 * provider's role (design §16.3). `labelled` is true iff the `bm.role` label
 * equals that role. A `bm.role` label that disagrees with the provider (a
 * different role, an unknown value, or any value on a non-`bm-*` provider) is
 * logged once per agent per plugin run and otherwise ignored. Never throws.
 */
export function roleOfAgent(agent: unknown): RoleFact | null {
  try {
    if (agent === null || typeof agent !== "object") return null;
    const { id, labels, provider } = agent as { id?: unknown; labels?: unknown; provider?: unknown };
    const label =
      labels !== null && typeof labels === "object" ? (labels as Record<string, unknown>)[ROLE_LABEL] : undefined;
    const role = roleOfProvider(provider);
    if (label !== undefined && label !== role) noteDisagreement(id, label, provider, role);
    return role === null ? null : { role, labelled: label === role };
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
