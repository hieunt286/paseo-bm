/**
 * `bm_why` (autonomy design §E.2, REQ-151, REQ-152; change-011 C6): why a
 * bead, a changed file or a decision exists — the chain(s) of the request(s)
 * behind it, as `links.ts` derives them, for the Orchestrator.
 *
 * Read-only: it reads what `links.ts` reads (the trace store, the decision
 * file, `precedents.json`, the workspace's `issues.jsonl`, one bounded
 * read-only `git log` per request, Paseo's lists) and writes and sends
 * nothing.
 *
 * The answer is JSON: ids, statuses, labels and the masked one-line texts the
 * chain gives, every string masked once more. It is bounded as the §A.9 read
 * tools are: at most `REQUEST_SUMMARY_MAX_CHARS` by default and
 * `REQUEST_MAX_CHARS` with `detail: "full"`, its note included. Above the
 * bound the longest lists are cut first — a list inside a chain before the
 * list of chains — each ending in a `...[N more]` item, and a one-line note
 * comes first. `detail: "full"` adds each link's source, every turn, the
 * commits' files and the reviews one by one.
 *
 * An unknown project or id is a not-found answer (`found: false` and why),
 * never a throw.
 */
import { redactText } from "./collector";
import { chainsOfBead, chainsOfDecision, chainsOfFile, type DecisionLink, type Link, type LinkSource, type LinksDeps, type RequestChain } from "./links";
import { fixThese, workingAgentsOf, type ServerToolResult, type ToolContext } from "./orchestrator-tool-context";
import type { RepoToolDeps } from "./repo-tool";
import { REQUEST_MAX_CHARS, cutText } from "./request-render";
import { storedWorkspaceIds } from "./trace-store";
import { REQUEST_SUMMARY_MAX_CHARS, type ReadDetail } from "../shared/bm-tools";
import { timeOrZero } from "../shared/time";

export interface WhyInput {
  workspaceId: string;
  bead?: string;
  file?: string;
  decision?: string;
  detail?: ReadDetail;
}

/** What `bm_why` looks a chain up by: exactly one of them. */
export const WHY_LOOKUPS = ["bead", "file", "decision"] as const;
type WhyLookup = (typeof WHY_LOOKUPS)[number];

/** The note put first when the summary cut a list (autonomy design §A.9). */
export const WHY_BOUNDED_NOTE =
  'Bounded to 4,000 characters: the longest lists are cut first, each ending in "...[N more]". For up to 60,000 characters, call bm_why with detail: "full".';
/** The note put first when even `detail: "full"` cut a list. */
export const WHY_FULL_BOUNDED_NOTE =
  'Bounded to 60,000 characters: the longest lists are cut first, each ending in "...[N more]". Read one request with bm_request.';

/** A string cut when no list is left to cut is kept at least this long. */
const MIN_CUT_STRING = 80;
/** The short hash a summary shows. */
const SHORT_HASH = 12;

/** The item that ends a cut list. */
const MORE = /^\.\.\.\[(\d+) more\]$/;
const moreItem = (count: number): string => `...[${count} more]`;

// ---------------------------------------------------------------------------
// The view: what of a chain the Orchestrator reads.
// ---------------------------------------------------------------------------

type View = Record<string, unknown>;

function sourceOf(full: boolean, source: LinkSource | null): View {
  return full && source !== null ? { source: `${source.store}:${source.id}` } : {};
}

function linkView<T>(link: Link<T>, item: (value: T) => View): View {
  return { status: link.status, reason: link.reason, items: link.items.map(item) };
}

function decisionView(decision: DecisionLink, full: boolean): View {
  return {
    id: decision.id,
    kind: decision.kind,
    status: decision.status,
    question: decision.question,
    answeredBy: decision.answeredBy,
    answeredAt: decision.answeredAt,
    precedentId: decision.precedentId,
    supersedes: decision.supersedes,
    supersededBy: decision.supersededBy,
    ...sourceOf(full, decision.source),
  };
}

const hashOf = (hash: string, full: boolean): string => (full ? hash : hash.slice(0, SHORT_HASH));

/** One chain as `bm_why` hands it out: summary by default, each link's source and every turn with `full`. */
export function chainView(chain: RequestChain, full: boolean): View {
  const { request } = chain;
  return {
    request: {
      requestId: request.requestId,
      traceId: request.traceId === request.requestId ? null : request.traceId,
      requestedAt: request.requestedAt,
      text: request.text,
      state: request.state,
      tier: request.tier,
      linking: request.linking,
      basis: request.basis,
      workerIds: request.workerIds,
      reviewerIds: request.reviewerIds,
      ...sourceOf(full, request.source),
    },
    decisions: linkView(chain.decisions, (decision) => decisionView(decision, full)),
    precedents: linkView(chain.precedents, (precedent) => ({
      id: precedent.id,
      decisionId: precedent.decisionId,
      found: precedent.found,
      reason: precedent.reason,
      subject: precedent.subject,
      scope: precedent.scope,
      text: precedent.text,
      expiresAt: precedent.expiresAt,
      supersededBy: precedent.supersededBy,
      ...sourceOf(full, precedent.source),
    })),
    beads: linkView(chain.beads, (bead) => ({
      id: bead.id,
      actions: bead.actions,
      confidence: bead.confidence,
      via: bead.via,
      inStore: bead.inStore,
      recordReason: bead.recordReason,
      title: bead.title,
      status: bead.status,
      splitFrom: bead.splitFrom,
      ...sourceOf(full, bead.source),
    })),
    changes: linkView(chain.changes, (change) => ({
      path: change.path,
      label: change.label,
      via: change.via,
      commits: change.commits.map((hash) => hashOf(hash, full)),
      onlyCommitByTime: change.onlyCommitByTime,
      ...sourceOf(full, change.source),
    })),
    commits: {
      status: chain.commits.status,
      reason: chain.commits.reason,
      unlinked: chain.commits.unlinked,
      truncated: chain.commits.truncated,
      items: chain.commits.items.map((commit) => ({
        hash: hashOf(commit.hash, full),
        at: commit.at,
        subject: commit.subject,
        link: commit.link,
        beads: commit.beads,
        files: full ? commit.files : commit.files.length,
      })),
    },
    checks: {
      status: chain.checks.status,
      reason: chain.checks.reason,
      verdict: chain.checks.verdict,
      named: chain.checks.named,
      unverified: chain.checks.unverified,
      reportAt: chain.checks.reportAt,
      ...sourceOf(full, chain.checks.source),
    },
    reviews: linkView(chain.reviews, (batch) => ({
      batchId: batch.batchId,
      verdict: batch.verdict,
      reviews: full ? batch.reviews : batch.reviews.length,
      ...sourceOf(full, batch.source),
    })),
    turns: linkView(chain.turns, (agent) => ({
      agentId: agent.agentId,
      role: agent.role,
      count: agent.count,
      first: agent.first,
      last: agent.last,
      ...(full
        ? { turns: agent.turns.map((turn) => ({ key: turn.key, startedAt: turn.startedAt, endedAt: turn.endedAt, turnId: turn.turnId, outcome: turn.outcome })) }
        : {}),
    })),
    // Its edges are in `edges`, with the others.
    handoffs: { status: chain.handoffs.status, reason: chain.handoffs.reason },
    edges: chain.edges.map((edge) => ({ kind: edge.kind, from: edge.from, to: edge.to, ...sourceOf(full, edge.source) })),
    notices: chain.notices,
  };
}

/** `value` with every string masked, and without its null fields and empty lists. */
function compact(value: unknown, env: NodeJS.ProcessEnv): unknown {
  if (typeof value === "string") return redactText(value, env);
  if (Array.isArray(value)) return value.map((item) => compact(item, env));
  if (value === null || typeof value !== "object") return value;
  const out: View = {};
  for (const [key, item] of Object.entries(value)) {
    if (item === null || item === undefined || (Array.isArray(item) && item.length === 0)) continue;
    out[key] = compact(item, env);
  }
  return out;
}

// ---------------------------------------------------------------------------
// The bound: the longest lists cut first.
// ---------------------------------------------------------------------------

function realCount(list: readonly unknown[]): number {
  const last = list[list.length - 1];
  return typeof last === "string" && MORE.test(last) ? list.length - 1 : list.length;
}

function listsIn(value: unknown, out: unknown[][]): unknown[][] {
  if (Array.isArray(value)) {
    out.push(value);
    for (const item of value) listsIn(item, out);
  } else if (value !== null && typeof value === "object") {
    for (const item of Object.values(value)) listsIn(item, out);
  }
  return out;
}

/** The longest list that can still lose an item; the list of chains only when no list inside one can. */
function longestList(value: unknown, last: unknown): unknown[] | null {
  let best: unknown[] | null = null;
  let bestLength = -1;
  for (const list of listsIn(value, [])) {
    if (list === last || realCount(list) <= 1) continue;
    const length = JSON.stringify(list).length;
    if (length > bestLength) {
      best = list;
      bestLength = length;
    }
  }
  if (best !== null) return best;
  return Array.isArray(last) && realCount(last) > 1 ? last : null;
}

/** Drops items from the end of `list` until `excess` characters are gone (one item always stays), ending it in `...[N more]`. */
function dropFromEnd(list: unknown[], excess: number): void {
  let omitted = 0;
  if (realCount(list) < list.length) omitted = Number(MORE.exec(list.pop() as string)![1]);
  const need = excess + moreItem(omitted + list.length).length + 1;
  let removed = 0;
  while (list.length > 1 && removed < need) {
    removed += JSON.stringify(list.pop()).length + 1;
    omitted += 1;
  }
  list.push(moreItem(omitted));
}

/** Halves the longest string above `MIN_CUT_STRING` characters, ending it in "…"; false when there is none. */
function cutLongestString(value: unknown): boolean {
  let best: { holder: Record<string, unknown> | unknown[]; key: string | number; length: number } | null = null;
  const visit = (holder: Record<string, unknown> | unknown[]): void => {
    for (const [key, item] of Object.entries(holder)) {
      if (typeof item === "string") {
        const length = Array.from(item).length;
        if (length > MIN_CUT_STRING && !MORE.test(item) && (best === null || length > best.length)) {
          best = { holder, key: Array.isArray(holder) ? Number(key) : key, length };
        }
      } else if (item !== null && typeof item === "object") {
        visit(item as Record<string, unknown>);
      }
    }
  };
  if (value !== null && typeof value === "object") visit(value as Record<string, unknown>);
  if (best === null) return false;
  const { holder, key, length } = best as { holder: Record<string | number, unknown>; key: string | number; length: number };
  const keep = Math.max(MIN_CUT_STRING, Math.floor(length / 2)) - 1;
  holder[key] = `${Array.from(holder[key] as string).slice(0, keep).join("")}…`;
  return true;
}

/**
 * `value` as JSON of at most `maxChars` characters, `note` included: as it is
 * when it fits; else with `note` first and the longest lists cut first (the
 * list at `value.chains` last), then the longest strings; a text that still
 * does not fit is cut as `cutText` cuts. Mutates `value`.
 */
export function boundedJson(value: unknown, maxChars: number, note: string): string {
  let text = JSON.stringify(value);
  if (Array.from(text).length <= maxChars) return text;
  const budget = maxChars - Array.from(note).length - 1;
  const chains = (value as { chains?: unknown } | null)?.chains;
  for (let round = 0; round < 10_000; round += 1) {
    text = JSON.stringify(value);
    // UTF-16 length is never below the character count: fitting it fits the bound.
    const excess = text.length - budget;
    if (excess <= 0) return `${note}\n${text}`;
    const list = longestList(value, chains);
    if (list !== null) dropFromEnd(list, excess);
    else if (!cutLongestString(value)) break;
  }
  return `${note}\n${cutText(text, budget)}`;
}

// ---------------------------------------------------------------------------
// The tool.
// ---------------------------------------------------------------------------

/** Whether `workspaceId` is a paseo-bm project: a turn of it is stored, or one of its agents is paseo-bm's (as `requireProject`). */
async function isProject(workspaceId: string, context: ToolContext): Promise<boolean> {
  if (storedWorkspaceIds(context.location).includes(workspaceId)) return true;
  return (await workingAgentsOf(context)).some((agent) => agent.workspaceId === workspaceId);
}

/** Newest request first: a cut list of chains keeps the newest. */
function newestFirst(chains: readonly RequestChain[]): RequestChain[] {
  return [...chains].sort((a, b) => timeOrZero(b.request.requestedAt) - timeOrZero(a.request.requestedAt));
}

export async function bmWhy(input: WhyInput, context: ToolContext, deps: RepoToolDeps = {}): Promise<ServerToolResult> {
  const given = WHY_LOOKUPS.filter((key) => input[key] !== undefined);
  if (given.length !== 1) {
    const issue = given.length === 0 ? "input: give one of bead, file or decision" : `input: give only one of bead, file or decision, not ${given.join(" and ")}`;
    return { ok: false, text: fixThese("bm_why", [issue]) };
  }
  const kind: WhyLookup = given[0]!;
  const id = input[kind]!;
  const full = input.detail === "full";
  const env = context.env;
  const head = { workspaceId: input.workspaceId, lookup: { [kind]: redactText(id, env) } };

  if (!(await isProject(input.workspaceId, context))) {
    return { ok: true, text: JSON.stringify({ ...head, found: false, reason: `No paseo-bm project ${input.workspaceId}: use the workspaceId bm_projects gave.`, chains: [] }) };
  }

  const links: LinksDeps = { location: context.location, paseo: context.paseo, env, ...(deps.git === undefined ? {} : { git: deps.git }) };
  let answer: View;
  if (kind === "bead") {
    const result = await chainsOfBead(links, input.workspaceId, id);
    answer = { ...head, found: result.chains.length > 0, reason: result.reason, beadInStore: result.beadInStore, chains: newestFirst(result.chains) };
  } else if (kind === "file") {
    const result = await chainsOfFile(links, input.workspaceId, id);
    answer = { ...head, found: result.chains.length > 0, reason: result.reason, chains: newestFirst(result.chains) };
  } else {
    const result = await chainsOfDecision(links, input.workspaceId, id);
    answer = {
      ...head,
      found: result.decision !== null,
      reason: result.reason,
      decision: result.decision === null ? null : decisionView(result.decision, full),
      chains: newestFirst(result.chains),
    };
  }
  const chains = (answer["chains"] as RequestChain[]).map((chain) => compact(chainView(chain, full), env));
  // `found` always shows; `reason` (why nothing or no chain was found) only when there is one.
  const view = { ...(compact({ ...answer, chains: undefined }, env) as View), chains };
  const text = full ? boundedJson(view, REQUEST_MAX_CHARS, WHY_FULL_BOUNDED_NOTE) : boundedJson(view, REQUEST_SUMMARY_MAX_CHARS, WHY_BOUNDED_NOTE);
  return { ok: true, text };
}
