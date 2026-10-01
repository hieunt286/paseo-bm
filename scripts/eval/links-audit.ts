/**
 * The A-10 links audit (evaluation design §4 A-10; autonomy design §E.3,
 * §E.4; change-011 C4, C8): draws sampled outputs of the window's finished
 * requests, rebuilds each one's chain with `plugin/server/links.ts`'
 * `deriveChain`, and judges it complete or not, naming the missing links.
 *
 *   npm run eval:replay -- --links-sample 30 --seed <n> [--since …] [--until …] [--json]
 *
 * The definition it implements was fixed in evaluation design §4 before any
 * field sample; change it there first, never after seeing a result.
 *
 * Read-only: the store comes from `eval-store.ts` `readStore` (no lock, no
 * write), the bead store from `beads-store.ts` `readBeads`, precedents from
 * the precedent store's reader, and the commits from one bounded `git log`
 * per request under `repo-tool.ts`' read-only prefix and environment. The
 * chain is rebuilt from the store alone, as §E.1 says for the audit: Paseo's
 * agent list is never read, so the handoff link is not judged.
 *
 * The output holds numbers, link kinds and ids only: never a message, a bead
 * title, a reason or a path (a file output carries no id).
 */
import { execFileSync } from "node:child_process";
import { statSync } from "node:fs";
import type { TraceRecord } from "../../plugin/shared/contracts.js";
import { decisionSchema, type Decision } from "../../plugin/shared/decisions.js";
import { recordStart, type EvalWindow } from "../../plugin/shared/eval-metrics.js";
import { CHECKS_VERDICTS, type ChecksVerdict } from "../../plugin/shared/evidence.js";
import type { Precedent } from "../../plugin/shared/precedents.js";
import { readBeads } from "../../plugin/server/beads-store.js";
import type { StoreRead } from "../../plugin/server/eval-store.js";
import {
  LINKS_GIT_MAX_BYTES,
  LINKS_GIT_MAX_COMMITS,
  commitSpanOf,
  deriveChain,
  parseGitLog,
  type ChainContext,
  type CommitsRead,
  type Link,
  type RequestChain,
  type SourceRead,
} from "../../plugin/server/links.js";
import { createPrecedentStore } from "../../plugin/server/precedent-store.js";
import { GIT_READ_ONLY_PREFIX, REPO_TIMEOUT_MS } from "../../plugin/server/repo-tool.js";
import { traceOfRequest } from "../../plugin/server/request-trace.js";
import { reconstructTraces, type ReconstructedTrace } from "../../plugin/server/traces.js";

/** Where the definition this audit implements is written. */
export const A10_DEFINITION = "evaluation design §4 A-10 (fixed 2026-10-01, before any field sample)";

/** The kinds of output, in the order the draw takes and fills them. */
export const OUTPUT_KINDS = ["bead", "file", "decision"] as const;
export type OutputKind = (typeof OUTPUT_KINDS)[number];

/** The PRD's six required links. */
export const A10_LINKS = ["request", "decisions", "beads", "change", "review", "turns"] as const;
export type A10Link = (typeof A10_LINKS)[number];

export type LinkJudgement = "found" | "absent" | "missing";

/** The largest sample the command line takes. */
export const LINKS_SAMPLE_MAX = 1000;
/** The largest seed: an unsigned 32-bit integer. */
export const LINKS_SEED_MAX = 0xffff_ffff;

export interface LinksSample {
  size: number;
  seed: number;
}

/** One output of a finished request, before the draw. `id` is the bead or decision id, or the file's path (kept in memory only). */
export interface Output {
  kind: OutputKind;
  workspaceId: string;
  requestId: string;
  id: string;
}

export interface JudgedOutput {
  kind: OutputKind;
  workspaceId: string;
  requestId: string;
  /** The bead or decision id; null for a file, whose path is never printed. */
  id: string | null;
  complete: boolean;
  links: Record<A10Link, LinkJudgement>;
  /** The required links judged missing, in `A10_LINKS` order. */
  missing: A10Link[];
  /** The request's check verdict: shown, not required. `none` when it has no finish to check. */
  checks: ChecksVerdict | "none";
}

type ByKind<T> = Record<OutputKind, T>;

export interface LinksAudit {
  definition: string;
  sample: number;
  seed: number;
  population: {
    /** Finished requests of the window, by the metrics' own rule (a `finished` report, earliest activity in the window). */
    finishedRequests: number;
    /** Finished requests the store-only rebuild holds no trace for: their decisions are outputs judged with the request link missing. */
    requestsWithoutChain: number;
    outputs: ByKind<number>;
  };
  draw: {
    /** What each kind is due: the sample split evenly, the remainder to the first kinds. */
    quota: ByKind<number>;
    drawn: ByKind<number>;
    /** Drawn above the kind's quota, filling a short kind. */
    filledFromOthers: ByKind<number>;
    total: number;
  };
  complete: number;
  incomplete: number;
  /** complete ÷ drawn; null when nothing was drawn. */
  rate: number | null;
  byKind: ByKind<{ drawn: number; complete: number }>;
  /** Over the drawn outputs: how each required link was judged. */
  links: Record<A10Link, Record<LinkJudgement, number>>;
  /** Over the drawn outputs: how many had each required link missing. */
  missingByLink: Record<A10Link, number>;
  /** Why a link found by `links.ts` still counts missing. */
  causes: {
    /** A bead the request names that the workspace's bead store does not hold, or a bead store that was not read. */
    beadNotInStore: number;
    /** A change whose only link is a commit by path and time (change-011 C4). */
    changeOnlyCommitByTime: number;
  };
  /** The check verdicts of the drawn outputs' requests: shown, not required. */
  checks: Record<ChecksVerdict | "none", number>;
  unknowns: {
    /** Stored decisions of the audited workspaces that did not validate. */
    invalidDecisions: number;
    /** Drawn outputs whose request's commits could not be read (commits are not required). */
    commitsUnread: number;
  };
  /** Every drawn output, in draw order. */
  outputs: JudgedOutput[];
}

// ── The draw ────────────────────────────────────────────────────────────────

/** A seeded generator in [0, 1) (mulberry32): the same seed, the same sequence, on every machine. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const compareOutputs = (a: Output, b: Output): number =>
  compareText(a.workspaceId, b.workspaceId) || compareText(a.requestId, b.requestId) || compareText(a.id, b.id);

const zeroByKind = (): ByKind<number> => ({ bead: 0, file: 0, decision: 0 });

/** Each kind's due share of `size`: an even split, the remainder to the first kinds of `OUTPUT_KINDS`. */
export function quotaOf(size: number): ByKind<number> {
  const base = Math.floor(size / OUTPUT_KINDS.length);
  const rest = size - base * OUTPUT_KINDS.length;
  const quota = zeroByKind();
  OUTPUT_KINDS.forEach((kind, index) => (quota[kind] = base + (index < rest ? 1 : 0)));
  return quota;
}

/**
 * The seeded draw (evaluation design §4 A-10). Each kind's outputs are put in
 * a fixed order (workspace, request, id) and shuffled with one generator
 * seeded by `seed`, the kinds in `OUTPUT_KINDS` order; each kind gives up to
 * its quota; a short kind's remainder is filled from the others in turn, each
 * giving its next shuffled output, until the sample is full or nothing is left.
 */
export function drawOutputs(population: ByKind<readonly Output[]>, sample: LinksSample): { drawn: Output[]; quota: ByKind<number>; filledFromOthers: ByKind<number> } {
  const random = seededRandom(sample.seed);
  const shuffled: ByKind<Output[]> = { bead: [], file: [], decision: [] };
  for (const kind of OUTPUT_KINDS) {
    const list = [...population[kind]].sort(compareOutputs);
    for (let index = list.length - 1; index > 0; index -= 1) {
      const swap = Math.floor(random() * (index + 1));
      [list[index], list[swap]] = [list[swap]!, list[index]!];
    }
    shuffled[kind] = list;
  }
  const quota = quotaOf(sample.size);
  const taken = zeroByKind();
  const drawn: Output[] = [];
  for (const kind of OUTPUT_KINDS) {
    const count = Math.min(quota[kind], shuffled[kind].length);
    drawn.push(...shuffled[kind].slice(0, count));
    taken[kind] = count;
  }
  const filledFromOthers = zeroByKind();
  let open = true;
  while (drawn.length < sample.size && open) {
    open = false;
    for (const kind of OUTPUT_KINDS) {
      if (drawn.length >= sample.size) break;
      if (taken[kind] >= shuffled[kind].length) continue;
      drawn.push(shuffled[kind][taken[kind]]!);
      taken[kind] += 1;
      filledFromOthers[kind] += 1;
      open = true;
    }
  }
  return { drawn, quota, filledFromOthers };
}

// ── Reading, read-only ──────────────────────────────────────────────────────

/** Runs one git command and returns its output; throws on a non-zero exit. */
export type SyncGitRunner = (args: readonly string[], options: { cwd: string; maxBytes: number }) => string;

/** As `repo-tool.ts` runs git: no prompt, no optional lock, no lazy fetch, no pager, and no repository named by this process's environment. */
function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_NAMESPACE"]) {
    delete env[name];
  }
  return { ...env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", GIT_NO_LAZY_FETCH: "1", GIT_PAGER: "cat", PAGER: "cat" };
}

/** The default runner: `execFileSync("git", args)`, no shell, `repo-tool.ts`' timeout, output capped at `maxBytes`. The replay is synchronous. */
export const runGitSync: SyncGitRunner = (args, { cwd, maxBytes }) =>
  execFileSync("git", [...args], {
    cwd,
    env: gitEnv(),
    timeout: REPO_TIMEOUT_MS,
    maxBuffer: maxBytes,
    encoding: "utf8",
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });

/** The commits of a request's span, read as `links.ts` reads them: `HEAD`, no merges, `--relative`, capped. Never throws. */
export function readCommitsSync(directory: string | null, span: { since: string; until: string }, git: SyncGitRunner): CommitsRead {
  if (directory === null) return { ok: false, reason: "The workspace folder is not known, so its commits were not read." };
  try {
    if (!statSync(directory).isDirectory()) return { ok: false, reason: "The workspace folder is not a folder." };
  } catch {
    return { ok: false, reason: "The workspace folder does not exist." };
  }
  try {
    const stdout = git(
      [
        ...GIT_READ_ONLY_PREFIX,
        "log",
        "--no-merges",
        "--no-renames",
        "--no-decorate",
        "--no-show-signature",
        "--relative",
        "--name-only",
        `--max-count=${LINKS_GIT_MAX_COMMITS + 1}`,
        `--since=${span.since}`,
        `--until=${span.until}`,
        "--format=%x1e%H%x1f%cI%x1f%B%x1f",
      ],
      { cwd: directory, maxBytes: LINKS_GIT_MAX_BYTES },
    );
    const commits = parseGitLog(stdout);
    return { ok: true, commits: commits.slice(0, LINKS_GIT_MAX_COMMITS), truncated: commits.length > LINKS_GIT_MAX_COMMITS };
  } catch {
    return { ok: false, reason: "git log failed, or the folder is not in a git repository." };
  }
}

function beadsOf(directory: string | null): ChainContext["beads"] {
  if (directory === null) return { ok: false, reason: "the workspace folder is not known." };
  try {
    const { present, beads } = readBeads(directory);
    return { ok: true, value: { present, beads } };
  } catch {
    return { ok: false, reason: "the bead store could not be read." };
  }
}

function precedentsOf(home: string): SourceRead<readonly Precedent[]> {
  try {
    return { ok: true, value: createPrecedentStore(home).read() };
  } catch {
    return { ok: false, reason: "precedents.json could not be read." };
  }
}

// ── The population ──────────────────────────────────────────────────────────

/** Whether `ms` is inside the window, as the metrics decide it (evaluation design §4). */
function inWindow(ms: number | null, window: EvalWindow): boolean {
  const since = window.since === null ? null : Date.parse(window.since);
  const until = window.until === null ? null : Date.parse(window.until);
  if (since === null && until === null) return true;
  if (ms === null) return false;
  return (since === null || ms >= since) && (until === null || ms <= until);
}

/**
 * The finished requests of the window, by the metrics' rule: a request is the
 * records sharing a `requestId`, in the window when its earliest activity is,
 * finished when a report of it says `finished`. Each goes with the workspace
 * of its earliest record. Sorted by workspace and request.
 */
export function finishedRequestsOf(records: readonly TraceRecord[], window: EvalWindow): Array<{ workspaceId: string; requestId: string }> {
  const byRequest = new Map<string, { workspaceId: string; firstAt: number; start: number | null }>();
  const finished = new Set<string>();
  for (const record of records) {
    for (const report of record.reports) {
      const requestId = report.requestId ?? record.requestId;
      if (requestId !== null && report.phase === "finished") finished.add(requestId);
    }
    if (record.requestId === null) continue;
    const at = Date.parse(record.at);
    const start = recordStart(record);
    const facts = byRequest.get(record.requestId);
    if (facts === undefined) {
      byRequest.set(record.requestId, { workspaceId: record.workspaceId, firstAt: Number.isNaN(at) ? Number.POSITIVE_INFINITY : at, start });
      continue;
    }
    if (!Number.isNaN(at) && at < facts.firstAt) {
      facts.firstAt = at;
      facts.workspaceId = record.workspaceId;
    }
    if (start !== null && (facts.start === null || start < facts.start)) facts.start = start;
  }
  const out: Array<{ workspaceId: string; requestId: string }> = [];
  for (const [requestId, facts] of byRequest) {
    const earliest = facts.start ?? (Number.isFinite(facts.firstAt) ? facts.firstAt : null);
    if (finished.has(requestId) && inWindow(earliest, window)) out.push({ workspaceId: facts.workspaceId, requestId });
  }
  return out.sort((a, b) => compareText(a.workspaceId, b.workspaceId) || compareText(a.requestId, b.requestId));
}

/** No commits: the population is drawn from the request's own records, never from git. */
const NO_COMMITS: CommitsRead = { ok: true, commits: [], truncated: false };

interface Workspace {
  traces: ReconstructedTrace[];
  directory: string | null;
  context: Omit<ChainContext, "commits">;
}

// ── The judgement ───────────────────────────────────────────────────────────

/** A link as A-10 counts it: absent counts only when the chain states why. */
function judged(link: Pick<Link<unknown>, "status" | "reason">): LinkJudgement {
  return link.status === "absent" && (link.reason === null || link.reason.trim() === "") ? "missing" : link.status;
}

/** The six required links of a chain (evaluation design §4 A-10); a null chain has only its decision to show. */
export function judgeChain(chain: RequestChain | null): {
  links: Record<A10Link, LinkJudgement>;
  beadNotInStore: boolean;
  changeOnlyCommitByTime: boolean;
  checks: ChecksVerdict | "none";
  commitsUnread: boolean;
} {
  if (chain === null) {
    return {
      links: { request: "missing", decisions: "missing", beads: "missing", change: "missing", review: "missing", turns: "missing" },
      beadNotInStore: false,
      changeOnlyCommitByTime: false,
      checks: "none",
      commitsUnread: false,
    };
  }
  const beadNotInStore = chain.beads.status === "found" && chain.beads.items.some((bead) => bead.inStore !== true);
  const changeOnlyCommitByTime = chain.changes.items.some((change) => change.onlyCommitByTime);
  return {
    links: {
      request: "found",
      decisions: judged(chain.decisions),
      beads: beadNotInStore ? "missing" : judged(chain.beads),
      change: changeOnlyCommitByTime ? "missing" : judged(chain.changes),
      review: judged(chain.reviews),
      turns: judged(chain.turns),
    },
    beadNotInStore,
    changeOnlyCommitByTime,
    checks: chain.checks.verdict ?? "none",
    commitsUnread: chain.commits.status === "missing",
  };
}

export interface LinksAuditInput {
  store: StoreRead;
  /** The data folder, for the precedents. */
  home: string;
  /** The records the replay kept (its `--workspace` and `--version`), which decide the finished requests. */
  records: readonly TraceRecord[];
  window: EvalWindow;
  sample: LinksSample;
  git?: SyncGitRunner;
}

/** The audit of one data folder (evaluation design §4 A-10). Reads, never writes. */
export function auditLinks(input: LinksAuditInput): LinksAudit {
  const { store, sample } = input;
  const git = input.git ?? runGitSync;
  const finished = finishedRequestsOf(input.records, input.window);
  const precedents = precedentsOf(input.home);
  const workspaceIds = [...new Set(finished.map((entry) => entry.workspaceId))];

  let invalidDecisions = 0;
  const decisionsByWorkspace = new Map<string, Decision[]>();
  for (const raw of store.decisions ?? []) {
    const workspaceId = typeof raw === "object" && raw !== null ? (raw as { workspaceId?: unknown }).workspaceId : undefined;
    if (typeof workspaceId !== "string" || !workspaceIds.includes(workspaceId)) continue;
    const parsed = decisionSchema.safeParse(raw);
    if (!parsed.success) {
      invalidDecisions += 1;
      continue;
    }
    const list = decisionsByWorkspace.get(workspaceId) ?? [];
    list.push(parsed.data);
    decisionsByWorkspace.set(workspaceId, list);
  }

  const workspaces = new Map<string, Workspace>();
  const workspaceOf = (workspaceId: string): Workspace => {
    let workspace = workspaces.get(workspaceId);
    if (workspace === undefined) {
      // The whole workspace's records, every version: a chain needs all of its request's turns.
      const records = store.records.filter((record) => record.workspaceId === workspaceId);
      const directory = store.workspaces.get(workspaceId)?.directory ?? null;
      workspace = {
        traces: reconstructTraces({ records, agents: [], replacementIds: [] }),
        directory,
        context: {
          workspaceId,
          agents: null,
          workspaceDirectory: directory,
          decisions: { ok: true, value: decisionsByWorkspace.get(workspaceId) ?? [] },
          precedents,
          beads: beadsOf(directory),
          // Nothing the chain shows is printed, so no secret is needed to mask it.
          env: {},
        },
      };
      workspaces.set(workspaceId, workspace);
    }
    return workspace;
  };

  // The population: every output of every finished request, from its own records.
  const population: ByKind<Output[]> = { bead: [], file: [], decision: [] };
  const traceByRequest = new Map<string, ReconstructedTrace | null>();
  const requestKey = (workspaceId: string, requestId: string): string => `${workspaceId}\n${requestId}`;
  let requestsWithoutChain = 0;
  for (const { workspaceId, requestId } of finished) {
    const workspace = workspaceOf(workspaceId);
    const trace = traceOfRequest(workspace.traces, { requestId }) ?? null;
    traceByRequest.set(requestKey(workspaceId, requestId), trace);
    const chain = trace === null ? null : deriveChain(trace, { ...workspace.context, commits: NO_COMMITS });
    const base = { workspaceId, requestId };
    if (chain === null) {
      requestsWithoutChain += 1;
      const own = (decisionsByWorkspace.get(workspaceId) ?? []).filter((decision) => decision.requestId === requestId);
      for (const decision of own) population.decision.push({ kind: "decision", ...base, id: decision.id });
      continue;
    }
    for (const bead of chain.beads.items) population.bead.push({ kind: "bead", ...base, id: bead.id });
    for (const change of chain.changes.items) population.file.push({ kind: "file", ...base, id: change.path });
    for (const decision of chain.decisions.items) population.decision.push({ kind: "decision", ...base, id: decision.id });
  }

  const { drawn, quota, filledFromOthers } = drawOutputs(population, sample);

  // The judgement: each drawn output's request chain, with its commits.
  const chains = new Map<string, RequestChain | null>();
  const chainOf = (workspaceId: string, requestId: string): RequestChain | null => {
    const key = requestKey(workspaceId, requestId);
    if (chains.has(key)) return chains.get(key)!;
    const trace = traceByRequest.get(key) ?? null;
    let chain: RequestChain | null = null;
    if (trace !== null) {
      const workspace = workspaceOf(workspaceId);
      chain = deriveChain(trace, { ...workspace.context, commits: readCommitsSync(workspace.directory, commitSpanOf(trace), git) });
    }
    chains.set(key, chain);
    return chain;
  };

  const links = Object.fromEntries(A10_LINKS.map((link) => [link, { found: 0, absent: 0, missing: 0 }])) as Record<A10Link, Record<LinkJudgement, number>>;
  const missingByLink = Object.fromEntries(A10_LINKS.map((link) => [link, 0])) as Record<A10Link, number>;
  const checks = Object.fromEntries([...CHECKS_VERDICTS, "none"].map((verdict) => [verdict, 0])) as Record<ChecksVerdict | "none", number>;
  const byKind: ByKind<{ drawn: number; complete: number }> = { bead: { drawn: 0, complete: 0 }, file: { drawn: 0, complete: 0 }, decision: { drawn: 0, complete: 0 } };
  const causes = { beadNotInStore: 0, changeOnlyCommitByTime: 0 };
  let commitsUnread = 0;
  const outputs: JudgedOutput[] = drawn.map((output) => {
    const judgement = judgeChain(chainOf(output.workspaceId, output.requestId));
    const missing = A10_LINKS.filter((link) => judgement.links[link] === "missing");
    const complete = missing.length === 0;
    for (const link of A10_LINKS) links[link][judgement.links[link]] += 1;
    for (const link of missing) missingByLink[link] += 1;
    checks[judgement.checks] += 1;
    byKind[output.kind].drawn += 1;
    if (complete) byKind[output.kind].complete += 1;
    if (judgement.beadNotInStore) causes.beadNotInStore += 1;
    if (judgement.changeOnlyCommitByTime) causes.changeOnlyCommitByTime += 1;
    if (judgement.commitsUnread) commitsUnread += 1;
    return {
      kind: output.kind,
      workspaceId: output.workspaceId,
      requestId: output.requestId,
      id: output.kind === "file" ? null : output.id,
      complete,
      links: judgement.links,
      missing,
      checks: judgement.checks,
    };
  });

  const complete = outputs.filter((output) => output.complete).length;
  const drawnByKind = zeroByKind();
  for (const output of drawn) drawnByKind[output.kind] += 1;
  return {
    definition: A10_DEFINITION,
    sample: sample.size,
    seed: sample.seed,
    population: {
      finishedRequests: finished.length,
      requestsWithoutChain,
      outputs: { bead: population.bead.length, file: population.file.length, decision: population.decision.length },
    },
    draw: { quota, drawn: drawnByKind, filledFromOthers, total: drawn.length },
    complete,
    incomplete: outputs.length - complete,
    rate: outputs.length === 0 ? null : complete / outputs.length,
    byKind,
    links,
    missingByLink,
    causes,
    checks,
    unknowns: { invalidDecisions, commitsUnread },
    outputs,
  };
}

// ── Markdown ────────────────────────────────────────────────────────────────

const percent = (rate: number | null): string => (rate === null ? "unknown" : `${(100 * rate).toFixed(1)} %`);

/** The audit as Markdown lines: numbers and link kinds only; the per-output rows are in `--json`. */
export function renderLinksAudit(audit: LinksAudit): string[] {
  const lines: string[] = ["## Links audit (A-10)", ""];
  const { population, draw } = audit;
  lines.push(
    `Definition: ${audit.definition}. Seed ${audit.seed} · sample ${audit.sample} · finished requests ${population.finishedRequests} (without a rebuilt chain ${population.requestsWithoutChain}).`,
    "",
  );
  lines.push(`**Complete chains: ${audit.complete} / ${draw.total} (${percent(audit.rate)}).**`, "");
  lines.push("| Kind | Outputs in the population | Quota | Drawn | Filled from others | Complete |", "|---|---|---|---|---|---|");
  for (const kind of OUTPUT_KINDS) {
    lines.push(`| ${kind} | ${population.outputs[kind]} | ${draw.quota[kind]} | ${draw.drawn[kind]} | ${draw.filledFromOthers[kind]} | ${audit.byKind[kind].complete} |`);
  }
  lines.push("");
  lines.push("| Required link | Found | Absent, stated why | Missing |", "|---|---|---|---|");
  for (const link of A10_LINKS) lines.push(`| ${link} | ${audit.links[link].found} | ${audit.links[link].absent} | ${audit.links[link].missing} |`);
  lines.push("");
  lines.push(
    `Missing although found: a bead not in the bead store ${audit.causes.beadNotInStore} · a change linked only by a commit by time ${audit.causes.changeOnlyCommitByTime}.`,
    `Check verdicts (shown, not required): ${[...CHECKS_VERDICTS, "none" as const].map((verdict) => `${verdict} ${audit.checks[verdict]}`).join(" · ")}.`,
    `Unknowns: decisions that did not validate ${audit.unknowns.invalidDecisions} · outputs whose commits were not read ${audit.unknowns.commitsUnread}. Per-output rows in --json.`,
  );
  return lines;
}
