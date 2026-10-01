/**
 * `links.why` (autonomy design §E.2, §E.4; change-011 C7): Work → request →
 * Why? reads the chain behind a request, or the chains behind a bead, a
 * changed file or a decision, over `links.ts`.
 *
 * Read-only: `links.ts` reads the stores (cached by mtime and size) and a
 * bounded, read-only `git log`; nothing is written. This file picks the
 * lookup, codes the failures with the codes that exist (no new one), and
 * bounds the answer (`LINKS_WHY_MAX_*`), leaving out each link's `source`.
 *
 * - an unknown request → `E_TRACE_NOT_FOUND`;
 * - an unknown decision → `E_DECISION_NOT_FOUND`;
 * - a bead no request names and the bead store does not hold →
 *   `E_BEAD_NOT_FOUND` (one a request names is answered even when the store
 *   no longer holds it: its chain says so);
 * - a bead or a file no request names → no chain, with the reason;
 * - no usable data folder, or a store that cannot be read →
 *   `E_DATA_HOME_UNAVAILABLE`.
 */
import { join } from "node:path";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import {
  DashboardError,
  LINKS_WHY_MAX_CHAINS,
  LINKS_WHY_MAX_ITEMS,
  LINKS_WHY_MAX_NESTED,
  linksWhyRpc,
  type LinksWhyInput,
  type LinksWhyOutput,
  type WhyChain,
  type WhyDecision,
} from "../shared/contracts";
import { TRACES_DIR_NAME } from "./data-home";
import { chainsOfBead, chainsOfDecision, chainsOfFile, requestChainOf, type DecisionLink, type Link, type LinksDeps, type RequestChain } from "./links";
import type { DashboardPaseo } from "./paseo-directory";
import type { GitRunner } from "./repo-tool";
import { READ_FAILED, errorText, requireDataHome, type RpcHomeDeps } from "./rpc-kit";

export type LinksRpcDeps = RpcHomeDeps & {
  /** How `git log` runs; `runGit` by default. */
  git?: GitRunner;
};

/** How `chainsOfDecision` says the decision store could not be read (links.ts `chainsOfDecision`). */
const DECISION_STORE_UNREADABLE = "The decision store could not be read";

const capped = <T>(items: readonly T[], max: number): { items: T[]; more: number } => ({
  items: items.slice(0, max),
  more: Math.max(0, items.length - max),
});

function linkOut<T, U>(link: Link<T>, map: (item: T) => U): { status: Link<T>["status"]; reason: string | null; items: U[]; more: number } {
  const { items, more } = capped(link.items, LINKS_WHY_MAX_ITEMS);
  return { status: link.status, reason: link.reason, items: items.map(map), more };
}

/** An item without the store it was read from: the ids it carries say which. */
function withoutSource<T extends { source: unknown }>(item: T): Omit<T, "source"> {
  const copy: Partial<T> = { ...item };
  delete copy.source;
  return copy as Omit<T, "source">;
}

function decisionOut(decision: DecisionLink): WhyDecision {
  return withoutSource(decision);
}

/** A chain as `links.why` sends it: bounded, without the sources. */
export function whyChainOf(chain: RequestChain): WhyChain {
  const edges = capped(chain.edges, LINKS_WHY_MAX_ITEMS);
  const edge = ({ kind, from, to }: RequestChain["edges"][number]) => ({ kind, from, to });
  return {
    workspaceId: chain.workspaceId,
    request: {
      requestId: chain.request.requestId,
      traceId: chain.request.traceId,
      requestedAt: chain.request.requestedAt,
      text: chain.request.text,
      state: chain.request.state,
      tier: chain.request.tier,
      linking: chain.request.linking,
      workerIds: chain.request.workerIds.slice(0, LINKS_WHY_MAX_NESTED),
      reviewerIds: chain.request.reviewerIds.slice(0, LINKS_WHY_MAX_NESTED),
      basis: chain.request.basis,
    },
    decisions: linkOut(chain.decisions, decisionOut),
    precedents: linkOut(chain.precedents, withoutSource),
    beads: linkOut(chain.beads, (bead) => ({ ...withoutSource(bead), splitFrom: bead.splitFrom.slice(0, LINKS_WHY_MAX_NESTED) })),
    changes: linkOut(chain.changes, (change) => ({ ...withoutSource(change), commits: change.commits.slice(0, LINKS_WHY_MAX_NESTED) })),
    commits: {
      ...linkOut(chain.commits, (commit) => ({
        ...withoutSource(commit),
        files: commit.files.slice(0, LINKS_WHY_MAX_NESTED),
        filesMore: Math.max(0, commit.files.length - LINKS_WHY_MAX_NESTED),
        beads: commit.beads.slice(0, LINKS_WHY_MAX_NESTED),
      })),
      unlinked: chain.commits.unlinked,
      truncated: chain.commits.truncated,
    },
    checks: {
      status: chain.checks.status,
      reason: chain.checks.reason,
      verdict: chain.checks.verdict,
      named: chain.checks.named.slice(0, LINKS_WHY_MAX_ITEMS).map(({ check, label }) => ({ check, label })),
      unverified: chain.checks.unverified,
      reportAt: chain.checks.reportAt,
    },
    reviews: linkOut(chain.reviews, ({ batchId, verdict, reviews }) => ({ batchId, verdict, reviews: reviews.slice(-LINKS_WHY_MAX_NESTED) })),
    turns: linkOut(chain.turns, ({ agentId, role, count, first, last }) => ({ agentId, role, count, first, last })),
    handoffs: linkOut(chain.handoffs, edge),
    edges: edges.items.map(edge),
    edgesMore: edges.more,
    notices: chain.notices,
  };
}

function chainsOut(chains: readonly RequestChain[], reason: string | null): Pick<LinksWhyOutput, "chains" | "more" | "reason"> {
  const { items, more } = capped(chains, LINKS_WHY_MAX_CHAINS);
  return { chains: items.map(whyChainOf), more, reason };
}

async function lookup(input: LinksWhyInput, deps: LinksDeps): Promise<LinksWhyOutput> {
  const { workspaceId } = input;
  if (input.requestId !== undefined) {
    const chain = await requestChainOf(deps, workspaceId, input.requestId);
    if (chain === null) throw new DashboardError("E_TRACE_NOT_FOUND", `no request ${input.requestId} in workspace ${workspaceId}`);
    return chainsOut([chain], null);
  }
  if (input.bead !== undefined) {
    const result = await chainsOfBead(deps, workspaceId, input.bead);
    if (result.chains.length === 0 && result.beadInStore === false) {
      throw new DashboardError("E_BEAD_NOT_FOUND", `no bead ${input.bead} in the bead store of workspace ${workspaceId}, and no request names it`);
    }
    return { ...chainsOut(result.chains, result.reason), beadInStore: result.beadInStore };
  }
  if (input.file !== undefined) {
    const result = await chainsOfFile(deps, workspaceId, input.file);
    return chainsOut(result.chains, result.reason);
  }
  const id = input.decision!;
  const result = await chainsOfDecision(deps, workspaceId, id);
  if (result.decision === null) {
    if (result.reason?.startsWith(DECISION_STORE_UNREADABLE) === true) throw new DashboardError(READ_FAILED, `cannot read the links: ${result.reason}`);
    throw new DashboardError("E_DECISION_NOT_FOUND", `no decision ${id} in workspace ${workspaceId}`);
  }
  return { ...chainsOut(result.chains, result.reason), decision: decisionOut(result.decision) };
}

/** `links.why`. Read-only. */
export async function handleLinksWhy(input: LinksWhyInput, paseo: DashboardPaseo | null, deps: LinksRpcDeps = {}): Promise<LinksWhyOutput> {
  const home = requireDataHome(deps, "read the links");
  const links: LinksDeps = {
    location: { tracesDir: join(home, TRACES_DIR_NAME) },
    paseo,
    ...(deps.env === undefined ? {} : { env: deps.env as NodeJS.ProcessEnv }),
    ...(deps.git === undefined ? {} : { git: deps.git }),
  };
  try {
    return await lookup(input, links);
  } catch (error) {
    if (error instanceof DashboardError) throw error;
    // A store under the data folder that cannot be read (links.ts never throws for git).
    throw new DashboardError(READ_FAILED, `cannot read the links: ${errorText(error)}`, { cause: error });
  }
}

export function registerLinksRpcs(server: PluginServerContext, deps: LinksRpcDeps = {}): void {
  // The SDK's `paseo` is structurally a `DashboardPaseo`; one cast, here.
  server.handle(linksWhyRpc, (input, context) => handleLinksWhy(input, (context?.paseo ?? null) as DashboardPaseo | null, deps));
}
