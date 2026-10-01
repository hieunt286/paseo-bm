/**
 * The replay: the programme's metrics computed from a paseo-bm data folder
 * (design docs/design/paseo-bm-evaluation.md §2, §5).
 *
 *   npm run eval:replay -- [--home <dir>] [--since ISO] [--until ISO]
 *                          [--workspace <id>]... [--version <x.y.z | ISO..ISO>] [--json]
 *                          [--links-sample <n> --seed <n>]
 *
 * It reads, filters, hands everything to `plugin/shared/eval-metrics.ts` and
 * prints: every number comes from that module, none is computed here.
 *
 * Read-only by construction: the data folder is read by
 * `plugin/server/eval-store.ts` (shared with the Insights RPC), which opens
 * files for reading only, takes no lock and writes nothing, so it can run
 * against the owner's real `~/.paseo-bm` while the plugin writes to it. A line
 * that does not parse, or a record that does not validate, is counted and
 * skipped; a store file that cannot be read is counted and skipped.
 *
 * What is read:
 *
 * - `traces/<workspaceId>/events-<YYYYMM>.jsonl` — the turn records, with the
 *   Dashboard's de-duplication (`dedupeRecords`);
 * - `traces/<workspaceId>/meta.json` — the workspace's label (`lastKnownName`,
 *   printed) and directory (`lastKnownDirectory`, handed to A-6 only, never
 *   printed);
 * - `decisions/<workspaceId>.json` (the stored decisions: A-1, A-2 (c), A-4,
 *   A-5, A-6);
 * - `orchestrator/proposals.json`, `orchestrator/stalls.json`,
 *   `orchestrator/wakes.json` (A-7), `orchestrator/interventions.json`
 *   (A-12) and the times of `orchestrator/notes/<workspaceId>.json`, when
 *   present.
 *
 * The output holds numbers only — no message text, no path — plus the window,
 * the filters, the workspace ids and labels, and the ids of the heaviest
 * requests and of the compaction and handoff candidates (request ids; agent
 * ids in the JSON only), so a report can be pasted into the repository.
 *
 * `admission` holds the admission evidence (autonomy design §F.2,
 * `eval-metrics/admission.ts`): per error class a candidate specialist claims,
 * the figure that measures it, or none; a section of the Markdown too.
 *
 * `--links-sample <n> --seed <n>` adds the A-10 links audit
 * (`links-audit.ts`, evaluation design §4 A-10): it also reads the
 * workspaces' `.beads/issues.jsonl` and runs a read-only `git log` per drawn
 * request, and adds `linksAudit` to the JSON and a section to the Markdown.
 * Without it the output is as before.
 *
 * The plugin's modules use extension-less imports that Node cannot load, so
 * the npm script bundles this file with `tsup` (`tsup.eval.config.ts`) into
 * the git-ignored `.eval-dist/` and runs the bundle.
 */
import { homedir as nodeHomedir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { TraceRecord } from "../../plugin/shared/contracts.js";
import {
  EVAL_ROLES,
  REVIEW_TIERS,
  computeAdmissionEvidence,
  computeEvalMetrics,
  workspaceOfStallKey,
  type AdmissionEvidence,
  type EvalMetrics,
  type EvalNote,
  type EvalWindow,
  type OverrideCounts,
  type ReversalRate,
  type ReviewLiftFigures,
  type ReviewTier,
  type Spread,
  type SpreadByRole,
} from "../../plugin/shared/eval-metrics.js";
import { DECISION_CLASSES, REVERSAL_KINDS } from "../../plugin/shared/decisions.js";
import { resolveDataHome } from "../../plugin/server/data-home.js";
import {
  evalInputsOf,
  isReadableFolder,
  readStore,
  selectWorkspaces,
  workspaceDirectoriesOf,
  workspacesOfWake,
  type StoreRead,
} from "../../plugin/server/eval-store.js";
import { LINKS_SAMPLE_MAX, LINKS_SEED_MAX, auditLinks, renderLinksAudit, type LinksAudit, type LinksSample, type SyncGitRunner } from "./links-audit.js";

export const REPLAY_SCHEMA_VERSION = 1;

export const USAGE = `usage: npm run eval:replay -- [--home <dir>] [--since ISO] [--until ISO]
                            [--workspace <id>]... [--version <x.y.z | ISO..ISO>] [--json]
                            [--links-sample <n> --seed <n>]

  --home <dir>        the paseo-bm data folder (default: PASEO_BM_HOME, else ~/.paseo-bm)
  --since, --until    inclusive window; a request counts when its earliest activity is inside
  --workspace <id>    only this workspace; repeat for several
  --version x.y.z     only records written by that plugin version (older records carry none)
  --version ISO..ISO  a version given as its time window (either side may be empty)
  --json              JSON instead of Markdown
  --links-sample <n>  A-10: draw n outputs of the window's finished requests and judge each one's
                      chain (evaluation design §4); read-only; needs --seed
  --seed <n>          the draw's seed, an integer 0–${LINKS_SEED_MAX}, written down before the draw`;

/** A wrong command line: printed with the usage, exit code 2. */
export class ReplayUsageError extends Error {
  override name = "ReplayUsageError";
}

/** The data folder cannot be used: exit code 1. */
export class ReplayStoreError extends Error {
  override name = "ReplayStoreError";
}

export type VersionFilter = { kind: "release"; version: string } | { kind: "window"; since: string | null; until: string | null };

export interface ReplayOptions {
  home: string;
  since: string | null;
  until: string | null;
  workspaces: string[];
  version: VersionFilter | null;
  json: boolean;
  /** `--links-sample` and `--seed`: the A-10 links audit; null without them. */
  linksSample: LinksSample | null;
}

export interface ReplayDeps {
  env?: Readonly<Record<string, string | undefined>>;
  homedir?: () => string;
  cwd?: () => string;
  /** How the links audit runs git; `runGitSync` by default. */
  git?: SyncGitRunner;
}

const RELEASE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/** An ISO time as the window carries it (normalised), or a usage error. */
function isoOf(value: string, flag: string): string {
  const ms = Date.parse(value);
  if (value.trim() === "" || Number.isNaN(ms)) throw new ReplayUsageError(`${flag} is not an ISO time: ${JSON.stringify(value)}`);
  return new Date(ms).toISOString();
}

/** A whole number in `[min, max]`, or a usage error. */
function integerOf(value: string, flag: string, min: number, max: number): number {
  const number = /^\d+$/.test(value) ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(number) || number < min || number > max) throw new ReplayUsageError(`${flag} is a whole number from ${min} to ${max}: ${JSON.stringify(value)}`);
  return number;
}

/** Reads the command line. Throws `ReplayUsageError`; returns `null` for `--help`. */
export function parseReplayArgs(argv: readonly string[], deps: ReplayDeps = {}): ReplayOptions | null {
  let home: string | null = null;
  let since: string | null = null;
  let until: string | null = null;
  let version: VersionFilter | null = null;
  let json = false;
  let sampleSize: number | null = null;
  let seed: number | null = null;
  const workspaces: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index] as string;
    const value = (): string => {
      const next = argv[index + 1];
      if (next === undefined || next.startsWith("--")) throw new ReplayUsageError(`${flag} needs a value`);
      index += 1;
      return next;
    };
    switch (flag) {
      case "--help":
      case "-h":
        return null;
      case "--json":
        json = true;
        break;
      case "--home":
        home = resolve((deps.cwd ?? process.cwd)(), value());
        break;
      case "--since":
        since = isoOf(value(), "--since");
        break;
      case "--until":
        until = isoOf(value(), "--until");
        break;
      case "--workspace": {
        const id = value();
        if (!workspaces.includes(id)) workspaces.push(id);
        break;
      }
      case "--version": {
        if (version !== null) throw new ReplayUsageError("--version is given once");
        const text = value();
        if (RELEASE.test(text)) {
          version = { kind: "release", version: text };
        } else if (text.includes("..")) {
          const [from = "", to = "", ...rest] = text.split("..");
          if (rest.length > 0 || (from === "" && to === "")) throw new ReplayUsageError(`--version window is ISO..ISO: ${JSON.stringify(text)}`);
          version = { kind: "window", since: from === "" ? null : isoOf(from, "--version"), until: to === "" ? null : isoOf(to, "--version") };
        } else {
          throw new ReplayUsageError(`--version is x.y.z or ISO..ISO: ${JSON.stringify(text)}`);
        }
        break;
      }
      case "--links-sample":
        if (sampleSize !== null) throw new ReplayUsageError("--links-sample is given once");
        sampleSize = integerOf(value(), "--links-sample", 1, LINKS_SAMPLE_MAX);
        break;
      case "--seed":
        if (seed !== null) throw new ReplayUsageError("--seed is given once");
        seed = integerOf(value(), "--seed", 0, LINKS_SEED_MAX);
        break;
      default:
        throw new ReplayUsageError(`unknown argument: ${JSON.stringify(flag)}`);
    }
  }
  // The seed is written down before the draw (evaluation design §4 A-10), so it is never a default.
  if (sampleSize !== null && seed === null) throw new ReplayUsageError("--links-sample needs --seed");
  if (seed !== null && sampleSize === null) throw new ReplayUsageError("--seed goes with --links-sample");
  const linksSample = sampleSize !== null && seed !== null ? { size: sampleSize, seed } : null;
  if (home === null) {
    const resolution = resolveDataHome({ env: deps.env ?? process.env, homedir: deps.homedir ?? nodeHomedir });
    if (resolution.home === null) throw new ReplayStoreError(`the paseo-bm data folder cannot be used: ${resolution.reason}`);
    home = resolution.home;
  }
  return { home, since, until, workspaces, version, json, linksSample };
}

// ── Reading the store ───────────────────────────────────────────────────────
// The read-only reader lives in the plugin (`plugin/server/eval-store.ts`), so
// the Insights RPC reads exactly as the replay does.

export { readStore, type StoreRead };

// ── Filtering ───────────────────────────────────────────────────────────────

/** The later of two lower bounds / the earlier of two upper bounds; `null` is open. */
const later = (a: string | null, b: string | null): string | null => (a === null ? b : b === null ? a : Date.parse(a) >= Date.parse(b) ? a : b);
const earlier = (a: string | null, b: string | null): string | null => (a === null ? b : b === null ? a : Date.parse(a) <= Date.parse(b) ? a : b);

/** The window handed to the metric module: `--since/--until` intersected with a `--version` window. */
export function effectiveWindow(options: Pick<ReplayOptions, "since" | "until" | "version">): EvalWindow {
  const version = options.version?.kind === "window" ? options.version : null;
  return { since: later(options.since, version?.since ?? null), until: earlier(options.until, version?.until ?? null) };
}

const fieldOf = (entry: unknown, field: string): unknown => (typeof entry === "object" && entry !== null ? (entry as Record<string, unknown>)[field] : undefined);

interface Selection {
  records: TraceRecord[];
  proposals: unknown[] | undefined;
  stalls: Record<string, unknown> | undefined;
  notes: EvalNote[] | undefined;
  decisions: unknown[] | undefined;
  wakes: unknown[] | undefined;
  interventions: unknown[] | undefined;
  /** Records left out by `--version x.y.z` because they carry no version. */
  recordsWithoutVersion: number;
  /** Orchestrator entries left out by `--version x.y.z`: outside the version's span, or of a request of another version. */
  orchestratorEntriesNotAttributed: number;
}

/**
 * Applies `--workspace` and `--version x.y.z`. The time window is not applied
 * here: the metric module owns what "in the window" means.
 *
 * `--version x.y.z` keeps the records written by that version. The
 * Orchestrator's files and the decisions carry no version, so an entry is kept
 * when its time falls within the span of the kept records, and a proposal or
 * decision of a request that only another version recorded is left out.
 */
function select(store: StoreRead, options: ReplayOptions, workspaceIds: ReadonlySet<string> | null): Selection {
  let { records, proposals, stalls, notes, decisions, wakes, interventions } = selectWorkspaces(store, workspaceIds);
  let recordsWithoutVersion = 0;
  let orchestratorEntriesNotAttributed = 0;

  if (options.version?.kind === "release") {
    const wanted = options.version.version;
    recordsWithoutVersion = records.filter((record) => record.pluginVersion === undefined || record.pluginVersion === null).length;
    const otherRequests = new Set(records.filter((record) => record.pluginVersion !== wanted).map((record) => record.requestId));
    records = records.filter((record) => record.pluginVersion === wanted);
    for (const record of records) otherRequests.delete(record.requestId);
    const times = records.flatMap((record) => [Date.parse(record.startedAt ?? record.at), Date.parse(record.at)]).filter((ms) => !Number.isNaN(ms));
    const first = times.length === 0 ? null : Math.min(...times);
    const last = times.length === 0 ? null : Math.max(...times);
    const inSpan = (value: unknown): boolean => {
      const ms = typeof value === "string" ? Date.parse(value) : Number.NaN;
      return first !== null && last !== null && !Number.isNaN(ms) && ms >= first && ms <= last;
    };
    const keep = <T>(items: T[], test: (item: T) => boolean): T[] => {
      const kept = items.filter(test);
      orchestratorEntriesNotAttributed += items.length - kept.length;
      return kept;
    };
    if (proposals !== undefined) {
      proposals = keep(proposals, (entry) => {
        const requestId = fieldOf(entry, "requestId");
        return inSpan(fieldOf(entry, "at")) && !(typeof requestId === "string" && otherRequests.has(requestId));
      });
    }
    if (stalls !== undefined) stalls = Object.fromEntries(keep(Object.entries(stalls), ([, entry]) => inSpan(fieldOf(entry, "raisedAt"))));
    if (notes !== undefined) notes = keep(notes, (note) => inSpan(note.at));
    if (decisions !== undefined) {
      decisions = keep(decisions, (entry) => {
        const requestId = fieldOf(entry, "requestId");
        return inSpan(fieldOf(entry, "askedAt")) && !(typeof requestId === "string" && otherRequests.has(requestId));
      });
    }
    if (wakes !== undefined) wakes = keep(wakes, (entry) => inSpan(fieldOf(entry, "at")));
    if (interventions !== undefined) interventions = keep(interventions, (entry) => inSpan(fieldOf(entry, "at")));
  }
  return { records, proposals, stalls, notes, decisions, wakes, interventions, recordsWithoutVersion, orchestratorEntriesNotAttributed };
}

// ── The report ──────────────────────────────────────────────────────────────

/** Every metric except the window and the unknowns, which the report carries once at its top. */
export type ReplayMetrics = Omit<EvalMetrics, "window" | "unknowns">;

export interface ReplayUnknowns {
  store: StoreRead["unknowns"] & { recordsWithoutVersion: number; orchestratorEntriesNotAttributed: number };
  metrics: EvalMetrics["unknowns"];
}

export interface ReplayReport {
  schemaVersion: typeof REPLAY_SCHEMA_VERSION;
  window: EvalWindow;
  filters: { workspaces: string[]; version: VersionFilter | null };
  metrics: ReplayMetrics;
  byWorkspace: Array<{ workspaceId: string; label: string | null; metrics: ReplayMetrics; unknowns: EvalMetrics["unknowns"] }>;
  unknowns: ReplayUnknowns;
  /** The admission evidence per error class a candidate specialist claims (autonomy design §F.2), over every workspace in the filters. */
  admission: AdmissionEvidence;
  /** The A-10 links audit; present only with `--links-sample`. */
  linksAudit?: LinksAudit;
}

function split(metrics: EvalMetrics): { metrics: ReplayMetrics; unknowns: EvalMetrics["unknowns"] } {
  const { window, unknowns, ...rest } = metrics;
  void window;
  return { metrics: rest, unknowns };
}

/** True when a workspace has anything in the window worth a row. */
function hasActivity(metrics: EvalMetrics): boolean {
  const turns = Object.values(metrics.supplementary.turnsByRole).reduce((sum, count) => sum + count, 0);
  return metrics.requests.inWindow > 0 || turns > 0 || metrics.a7.wakes > 0;
}

/** The records the replay keeps for its `--workspace` and `--version`, which the links audit draws its finished requests from. */
export function selectedRecords(store: StoreRead, options: ReplayOptions): TraceRecord[] {
  return select(store, options, options.workspaces.length === 0 ? null : new Set(options.workspaces)).records;
}

/** The replay of one data folder: pure given the store that was read. */
export function buildReport(store: StoreRead, options: ReplayOptions): ReplayReport {
  const window = effectiveWindow(options);
  const filterIds = options.workspaces.length === 0 ? null : new Set(options.workspaces);
  const workspaceDirectories = workspaceDirectoriesOf(store);

  const run = (ids: ReadonlySet<string> | null) => {
    const selection = select(store, options, ids);
    const input = { ...evalInputsOf(selection), window, workspaceDirectories };
    const metrics = computeEvalMetrics(input);
    return { selection, input, metrics };
  };

  const whole = run(filterIds);
  const candidateIds = new Set<string>(whole.selection.records.map((record) => record.workspaceId));
  for (const key of Object.keys(whole.selection.stalls ?? {})) {
    const id = workspaceOfStallKey(key);
    if (id !== null) candidateIds.add(id);
  }
  for (const entry of whole.selection.wakes ?? []) for (const id of workspacesOfWake(entry)) if (filterIds === null || filterIds.has(id)) candidateIds.add(id);
  const byWorkspace: ReplayReport["byWorkspace"] = [];
  for (const id of [...candidateIds].sort()) {
    const { metrics } = run(new Set([id]));
    if (!hasActivity(metrics)) continue;
    byWorkspace.push({ workspaceId: id, label: store.workspaces.get(id)?.label ?? null, ...split(metrics) });
  }

  const { metrics, unknowns } = split(whole.metrics);
  return {
    schemaVersion: REPLAY_SCHEMA_VERSION,
    window,
    filters: { workspaces: [...options.workspaces], version: options.version },
    metrics,
    byWorkspace,
    unknowns: {
      store: {
        ...store.unknowns,
        recordsWithoutVersion: whole.selection.recordsWithoutVersion,
        orchestratorEntriesNotAttributed: whole.selection.orchestratorEntriesNotAttributed,
      },
      metrics: unknowns,
    },
    admission: computeAdmissionEvidence(whole.input, whole.metrics),
  };
}

// ── Markdown ────────────────────────────────────────────────────────────────

const cell = (text: string): string => text.replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/[\r\n]+/g, " ");

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return "unknown";
  if (typeof value === "boolean") return value ? "yes" : "no";
  if (typeof value === "number") return Number.isInteger(value) ? String(value) : value.toFixed(2);
  return String(value);
}

/** `[path, value]` for every leaf of a metrics object, in its key order. */
function flatten(value: unknown, path = ""): Array<[string, unknown]> {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) => flatten(child, path === "" ? key : `${path}.${key}`));
  }
  return [[path, value]];
}

const share = (part: number, whole: number | null): string => (whole === null || whole === 0 ? "unknown" : `${Math.round((100 * part) / whole)} %`);

/** Candidate rows printed per kind; the JSON carries them all. */
export const MARKDOWN_CANDIDATE_ROWS = 20;

/** The context and token figures (autonomy design §G.2) as their own tables: spreads, the heaviest requests, the candidates. */
function renderContext(context: EvalMetrics["context"], lines: string[]): void {
  const { turns, tokensRead, contextEstimate, candidates } = context;
  lines.push("## Context and tokens", "");
  lines.push(
    `Turns with usage: ${turns.withUsage} — Claude ${turns.byProvider.claude} (tokens summed over the turn's model calls) · Codex ${turns.byProvider.codex} and OpenCode ${turns.byProvider.opencode} (the last model call only; Codex's cached tokens inside its input) · unknown ${turns.byProvider.unknown} · repeated counts read as none ${turns.repeated} · with tool calls ${turns.withToolCalls}.`,
    `Context per turn: reported ${contextEstimate.reported} · estimated ${contextEstimate.estimated} (tokens read ÷ model calls — an estimate) · unknown ${contextEstimate.unknown}.`,
    "",
  );
  lines.push("| Figure | Count | Median | p75 | p80 | p90 | Max |", "|---|---|---|---|---|---|---|");
  const spreadRow = (label: string, spread: Spread) =>
    lines.push(`| ${label} | ${spread.count} | ${[spread.median, spread.p75, spread.p80, spread.p90, spread.max].map(formatValue).join(" | ")} |`);
  const groups: Array<[string, SpreadByRole]> = [
    ["Tokens read per turn", tokensRead.perTurn],
    ["Tokens read per request", tokensRead.perRequest],
    ["Tokens read per agent", tokensRead.perAgent],
    ["Context per turn", contextEstimate.perTurn],
  ];
  for (const [label, spreads] of groups) {
    spreadRow(`${label}, all`, spreads.all);
    for (const role of EVAL_ROLES) if (spreads.byRole[role].count > 0) spreadRow(`${label}, ${role}`, spreads.byRole[role]);
  }
  spreadRow("Context ÷ window per turn", contextEstimate.shareOfWindow);
  lines.push("");

  lines.push("### Heaviest requests", "");
  if (tokensRead.heaviestRequests.length === 0) lines.push("No request has usage in the window.", "");
  else {
    lines.push("| Workspace | Request | Tokens read | Manager | Worker | Reviewer | Turns | Finished |", "|---|---|---|---|---|---|---|---|");
    for (const row of tokensRead.heaviestRequests) {
      lines.push(
        `| ${cell(row.workspaceId)} | ${cell(row.requestId)} | ${row.tokensRead} | ${row.byRole.manager} | ${row.byRole.worker} | ${row.byRole.reviewer} | ${row.turns} | ${formatValue(row.finished)} |`,
      );
    }
    lines.push("");
  }

  const { thresholds } = candidates;
  lines.push("### Compaction and handoff candidates (an estimate)", "");
  lines.push(
    `At the §G.7 defaults from this window: compact.tokensPerTurn — Manager ${formatValue(thresholds.compactTokensPerTurn.manager)}, Worker ${formatValue(thresholds.compactTokensPerTurn.worker)} (the role's p75); handoff.requestTokens ${formatValue(thresholds.handoffRequestTokens)} (the requests' p80). Saving = tokens read after the crossing turn − the same model calls re-reading a ${thresholds.briefTokens}-token brief.`,
    "",
  );
  lines.push("| Kind | Candidates | Estimated saving (tokens) |", "|---|---|---|");
  lines.push(`| Compaction | ${candidates.compaction.candidates} | ${candidates.compaction.savingTokens} |`);
  lines.push(`| Handoff | ${candidates.handoff.candidates} | ${candidates.handoff.savingTokens} |`, "");
  const rows = [
    ...candidates.compaction.rows.slice(0, MARKDOWN_CANDIDATE_ROWS).map((row) => ["compaction", row] as const),
    ...candidates.handoff.rows.slice(0, MARKDOWN_CANDIDATE_ROWS).map((row) => ["handoff", row] as const),
  ];
  if (rows.length > 0) {
    lines.push("| Kind | Workspace | Request | Role | Turn | Crossed at | Turns after | Tokens read after | Calls after | Estimated saving |", "|---|---|---|---|---|---|---|---|---|---|");
    for (const [kind, row] of rows) {
      const calls = `${row.after.calls}${row.after.callsExact ? "" : " (at least)"}`;
      lines.push(
        `| ${kind} | ${cell(row.workspaceId)} | ${cell(row.requestId ?? "")} | ${row.role} | ${row.turn} / ${row.turns} | ${row.crossedAt} | ${row.after.turns} | ${row.after.tokensRead} | ${calls} | ${row.savingTokens} |`,
      );
    }
    const more = candidates.compaction.candidates + candidates.handoff.candidates - rows.length;
    lines.push("");
    if (more > 0) lines.push(`${more} more in --json.`, "");
  }
}

/** A rate as a percentage with one decimal, or "unknown" when there is nothing to take it over. */
const percent = (rate: number | null): string => (rate === null ? "unknown" : `${(100 * rate).toFixed(1)} %`);

/** The `Every metric` rows left to their own section: A-4 and the delegated and owner parts of A-5, per class. */
const DELEGATION_PATH = /^(?:a4|a5\.delegated|a5\.owner)\./;

/** `writers-observed` per workspace: a column of "By workspace", not rows of "Every metric" (autonomy design §F.1). */
const WRITERS_BY_WORKSPACE_PATH = /^supplementary\.writersObserved\.byWorkspace\./;

/**
 * A-4 and A-5 of delegated decisions per class (evaluation design §4), the
 * owner's own reversal rate beside A-5 as its reference.
 */
function renderDelegation(metrics: ReplayMetrics, lines: string[]): void {
  const { a4, a5 } = metrics;
  lines.push("## Delegated decisions (A-4, A-5)", "");
  lines.push(
    "Delegated: answered by the owner's policy or a precedent. A-4: overridden by the owner ÷ delegated. A-5: reversed in any way (re-asked, overridden, reopened citing it) ÷ delegated, beside the owner's own answers to Worker questions and Orchestrator decisions. Unknown with no decision, never 0.",
    "",
  );
  lines.push(
    "| Class | Delegated (policy / precedent) | Overridden | A-4 | Reversed (re-asked / overridden / reopened) | A-5 | Owner answered | Owner reversed | Owner rate |",
    "|---|---|---|---|---|---|---|---|---|",
  );
  const row = (label: string, overrides: OverrideCounts, delegated: ReversalRate, owner: ReversalRate) =>
    lines.push(
      `| ${label} | ${overrides.delegated} (${overrides.byPolicy} / ${overrides.byPrecedent}) | ${overrides.overridden} | ${percent(overrides.rate)} | ${delegated.reversed} (${REVERSAL_KINDS.map((kind) => delegated.byKind[kind]).join(" / ")}) | ${percent(delegated.rate)} | ${owner.decisions} | ${owner.reversed} | ${percent(owner.rate)} |`,
    );
  row("All classes", a4, a5.delegated, a5.owner);
  for (const decisionClass of DECISION_CLASSES) row(decisionClass, a4.byClass[decisionClass], a5.delegated.byClass[decisionClass], a5.owner.byClass[decisionClass]);
  lines.push("");
}

/** How each tier reads in the review lift tables. */
const TIER_LABELS: Readonly<Record<ReviewTier, string>> = { Small: "Small", Medium: "Medium", Large: "Large", unknown: "Tier unknown" };

/** One review lift row's figures: requests, reviews, batches, blocking findings, acted on, reviewed once, tokens per review. */
const liftCells = (figures: ReviewLiftFigures): string =>
  `${figures.requests} | ${figures.reviews} (${formatValue(figures.reviewsPerRequest)}) | ${figures.batches} | ${figures.blockingFindings} (${formatValue(figures.blockingPerBatch)}) | ${figures.actedOn.fixed} / ${figures.actedOn.found} (${figures.actedOn.reReviewedBatches}) | ${figures.actedOn.reviewedOnceBatches} | ${formatValue(figures.tokens.perReview)} (${figures.tokens.reviews}) |`;

const LIFT_HEADER = "Requests | Reviews (per request) | Batches | Blocking findings (per batch) | Acted on / found (batches reviewed again) | Batches reviewed once | Tokens per review (reviews counted) |";

/** A tier with anything to say: a reviewed request, or a request whose Reviewer sent no review. */
const liftHasActivity = (figures: ReviewLiftFigures): boolean => figures.requests + figures.unknown.requestsWithoutReview > 0;

/**
 * Review lift (autonomy design §C.4; evaluation design §4): per tier over
 * every workspace, what could not be counted, then per workspace — numbers,
 * workspace ids and labels only.
 */
function renderReviewLift(reviewLift: EvalMetrics["reviewLift"], labels: ReadonlyMap<string, string | null>, lines: string[]): void {
  lines.push("## Review lift", "");
  lines.push(
    "Per tier — a request's last reported tier — over the requests with a review. Blocking findings per batch: over every review of the batches whose counts are all known. Acted on: per batch reviewed again, its first review's blocking findings minus its last review's, at least 0; a batch reviewed once is counted apart. Tokens per review: the Reviewer turns' input + cached + output of the requests whose Reviewer turns all have usage. Unknown is never 0.",
    "",
  );
  lines.push(`| Tier | ${LIFT_HEADER}`, "|---|---|---|---|---|---|---|---|");
  const tiers: Array<[string, ReviewLiftFigures]> = [["All tiers", reviewLift.all], ...REVIEW_TIERS.map((tier): [string, ReviewLiftFigures] => [TIER_LABELS[tier], reviewLift.byTier[tier]])];
  for (const [label, figures] of tiers) lines.push(`| ${label} | ${liftCells(figures)}`);
  lines.push("");
  lines.push(
    "| Tier | Reviews without a batch | Reviews with an unknown blocking count | Batches with an unknown count | Batches reviewed again with an unknown first or last count | Reviewed requests without Reviewer tokens | Requests with Reviewer turns and no review |",
    "|---|---|---|---|---|---|---|",
  );
  for (const [label, { unknown }] of tiers) {
    lines.push(
      `| ${label} | ${unknown.reviewsWithoutBatch} | ${unknown.reviewsWithUnknownBlocking} | ${unknown.batchesWithUnknownBlocking} | ${unknown.reReviewedWithUnknownBlocking} | ${unknown.requestsWithoutReviewerTokens} | ${unknown.requestsWithoutReview} |`,
    );
  }
  lines.push("", `Reviewer turns without a request (in no figure): ${reviewLift.reviewerTurnsWithoutRequest}.`, "");

  const workspaces = Object.entries(reviewLift.byWorkspace);
  if (workspaces.length === 0) return;
  lines.push("### Review lift by workspace", "");
  lines.push(`| Workspace | Label | Tier | ${LIFT_HEADER}`, "|---|---|---|---|---|---|---|---|---|---|");
  for (const [workspaceId, split] of workspaces) {
    const label = cell(labels.get(workspaceId) ?? "");
    lines.push(`| ${cell(workspaceId)} | ${label} | All tiers | ${liftCells(split.all)}`);
    for (const tier of REVIEW_TIERS) if (liftHasActivity(split.byTier[tier])) lines.push(`| ${cell(workspaceId)} | ${label} | ${TIER_LABELS[tier]} | ${liftCells(split.byTier[tier])}`);
  }
  lines.push("");
}

/** Where the error classes of the admission evidence are written first. */
export const ADMISSION_TEMPLATE = "docs/operations/paseo-bm-specialist-admission-template.md";

/**
 * The admission evidence (autonomy design §F.2): one row per figure of each
 * error class a candidate claims, a class no figure measures on a row of its
 * own; then the two figures it adds. Numbers, class ids and candidates only.
 */
function renderAdmission(admission: AdmissionEvidence, lines: string[]): void {
  lines.push("## Admission evidence (autonomy design §F.2)", "");
  lines.push(
    `Per error class a candidate specialist claims (the classes of ${ADMISSION_TEMPLATE}), the figure that shows whether the current roles miss it, over ${admission.finishedRequests} finished request(s). "not measured": no replay figure measures the class — no evidence, no candidate. Unknown is never 0.`,
    "",
  );
  lines.push("| Class | Candidate | Figure | Value |", "|---|---|---|---|");
  for (const entry of admission.classes) {
    if (!entry.measured) {
      lines.push(`| ${entry.id} | ${entry.candidate} | not measured | — |`);
      continue;
    }
    for (const [figure, value] of Object.entries(entry.figures)) lines.push(`| ${entry.id} | ${entry.candidate} | ${figure} | ${formatValue(value)} |`);
  }
  const { verification: v, workerReading: w } = admission;
  lines.push(
    "",
    `Verification: ${v.labelled} of ${v.finished} finished requests labelled (${v.unknown.laterReportAfterFinish} with a later report after the finish); checks detected ${v.byChecks.detected} · self-reported ${v.byChecks["self-reported"]} · unverified ${v.byChecks.unverified} · not checked ${v.byChecks["not-checked"]}; code changed ${v.changedCode}, finished-unverified ${v.finishedUnverified} (${percent(v.share)}).`,
    `Worker reading: ${w.requests} finished request(s) with a Worker turn — ${w.withWrite} with a write inside the workspace (${w.beforeFirstWrite} of ${w.workerTokensRead} Worker tokens read before the first write, ${percent(w.share)}; a lower bound, the writing turn not counted), ${w.withoutWrite} without one (${w.withoutWriteTokensRead} tokens read), ${w.unknown.requestsWithoutUsage} with a Worker turn without usage.`,
    "",
  );
}

/** The report as Markdown tables: headline figures, every metric, per workspace, unknowns. */
export function renderMarkdown(report: ReplayReport): string {
  const { metrics } = report;
  const lines: string[] = [];
  const version =
    report.filters.version === null
      ? "any"
      : report.filters.version.kind === "release"
        ? report.filters.version.version
        : `${report.filters.version.since ?? ""}..${report.filters.version.until ?? ""}`;
  lines.push("# paseo-bm replay", "");
  lines.push(`Window: ${report.window.since ?? "open"} → ${report.window.until ?? "open"} · workspaces: ${report.filters.workspaces.length === 0 ? "all" : report.filters.workspaces.map(cell).join(", ")} · version: ${version} · schemaVersion ${report.schemaVersion}`, "");

  const agreement = metrics.supplementary.recommendedAgreement;
  lines.push("## Headline", "", "| Figure | Value |", "|---|---|");
  lines.push(`| Requests in window / finished | ${metrics.requests.inWindow} / ${metrics.requests.finished} |`);
  lines.push(`| Questions asked / reached the owner / answered by agents | ${metrics.a1.all.asked} / ${metrics.a1.all.reachedOwner} / ${metrics.a1.all.answeredByAgents} |`);
  lines.push(`| A-1 questions reaching the owner per finished request | ${formatValue(metrics.a1.perFinishedRequest?.reachedOwner ?? null)} |`);
  lines.push(`| Recommended option taken / answered | ${agreement.recommended} / ${agreement.answered} (${share(agreement.recommended, agreement.answered)}) |`);
  lines.push(`| A-4 delegated decisions overridden / delegated | ${metrics.a4.overridden} / ${metrics.a4.delegated} (${percent(metrics.a4.rate)}) |`);
  const { delegated, owner } = metrics.a5;
  lines.push(
    `| A-5 delegated decisions reversed / delegated · the owner's own reversed / answered | ${delegated.reversed} / ${delegated.decisions} (${percent(delegated.rate)}) · ${owner.reversed} / ${owner.decisions} (${percent(owner.rate)}) |`,
  );
  const { estimate, held } = metrics.a6;
  lines.push(
    `| A-6 action boundary, per finished request: held (estimate) · unreadable (estimate; not counting package scripts) · held decisions | ${formatValue(estimate.heldPerFinishedRequest)} · ${formatValue(estimate.unreadablePerFinishedRequest)} (${formatValue(estimate.unreadableButScriptsPerFinishedRequest)}) · ${formatValue(held.perFinishedRequest)} |`,
  );
  // Autonomy design §D.2 (change-010 C9): the same by whether the request's Worker ran under the boundary.
  const split = (["on", "off", "unknown"] as const).map((side) => {
    const part = metrics.a6.byBoundary[side];
    return `${side}: ${part.finishedRequests} · ${part.notShownAuthorised} / ${part.total} · ${formatValue(part.held.perFinishedRequest)} · ${formatValue(part.estimate.heldPerFinishedRequest)} (${formatValue(part.estimate.unreadablePerFinishedRequest)})`;
  });
  lines.push(
    `| A-6 by action boundary: finished requests · not shown authorised / effectful · held decisions · held (estimate; unreadable) per finished request | ${split.join("; ")} |`,
  );
  lines.push(`| A-8 tokens per finished request (mean / median) | ${formatValue(metrics.a8.perFinishedRequest?.total ?? null)} / ${formatValue(metrics.a8.medianPerFinishedRequest)} |`);
  const orchestrator = metrics.a8.orchestrator;
  lines.push(
    `| A-8 Orchestrator tokens from its wakes (window / per finished request) | ${formatValue(orchestrator.tokens)} / ${formatValue(orchestrator.perFinishedRequest)} (${orchestrator.wakesWithUsage} of ${orchestrator.wakes} wakes read) |`,
  );
  const { candidates } = metrics.context;
  lines.push(
    `| Compaction / handoff candidates, estimated saving in tokens (an estimate) | ${candidates.compaction.candidates}, ${candidates.compaction.savingTokens} / ${candidates.handoff.candidates}, ${candidates.handoff.savingTokens} |`,
  );
  const lift = metrics.reviewLift.all;
  lines.push(
    `| Review lift: blocking findings per batch · acted on / found on re-review · tokens per review | ${formatValue(lift.blockingPerBatch)} · ${lift.actedOn.fixed} / ${lift.actedOn.found} · ${formatValue(lift.tokens.perReview)} |`,
  );
  lines.push(`| A-11 median request time, owner wait excluded (ms) | ${formatValue(metrics.a11.medianMs)} |`);
  const writers = metrics.supplementary.writersObserved;
  lines.push(`| Writers observed: overlapping turn pairs / files / pairs not judged | ${writers.pairs} / ${writers.files} / ${writers.unknownPairs} |`);
  const checked = Object.entries(metrics.a12.byKind).filter(([, counts]) => counts.met + counts.missed > 0);
  lines.push(
    `| A-12 interventions met / checked, by kind | ${checked.length === 0 ? "none checked" : checked.map(([kind, counts]) => `${kind} ${counts.met} / ${counts.met + counts.missed}`).join(" · ")} |`,
    "",
  );

  // The context figures, review lift and the delegated decisions have their own sections: they read as tables, not as one row each.
  const { context, reviewLift, ...scalar } = metrics;
  lines.push("## Every metric", "", "| Metric | Value |", "|---|---|");
  for (const [path, value] of flatten(scalar)) if (!DELEGATION_PATH.test(path) && !WRITERS_BY_WORKSPACE_PATH.test(path)) lines.push(`| ${path} | ${formatValue(value)} |`);
  lines.push("");

  renderDelegation(metrics, lines);
  renderContext(context, lines);
  renderReviewLift(reviewLift, new Map(report.byWorkspace.map((row) => [row.workspaceId, row.label])), lines);
  renderAdmission(report.admission, lines);

  lines.push("## By workspace", "");
  if (report.byWorkspace.length === 0) {
    lines.push("No workspace has activity in the window.", "");
  } else {
    lines.push(
      "| Workspace | Label | Requests | Finished | Asked | Reached owner | Recommended / answered | Tokens (finished) | Writers observed (pairs / files / not judged) |",
      "|---|---|---|---|---|---|---|---|---|",
    );
    for (const row of report.byWorkspace) {
      const m = row.metrics;
      const rec = m.supplementary.recommendedAgreement;
      const writers = m.supplementary.writersObserved;
      lines.push(
        `| ${cell(row.workspaceId)} | ${cell(row.label ?? "")} | ${m.requests.inWindow} | ${m.requests.finished} | ${m.a1.all.asked} | ${m.a1.all.reachedOwner} | ${rec.recommended} / ${rec.answered} | ${m.a8.tokens.total} | ${writers.pairs} / ${writers.files} / ${writers.unknownPairs} |`,
      );
    }
    lines.push("");
  }

  lines.push("## Unknowns", "", "| Unknown | Count |", "|---|---|");
  for (const [path, value] of flatten(report.unknowns)) lines.push(`| ${path} | ${formatValue(value)} |`);
  if (report.linksAudit !== undefined) lines.push("", ...renderLinksAudit(report.linksAudit));
  return `${lines.join("\n")}\n`;
}

// ── Command ─────────────────────────────────────────────────────────────────

export interface ReplayIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

/** Runs the replay for a command line; returns the exit code (0, 1 store unusable, 2 usage). */
export function runReplay(argv: readonly string[], io: ReplayIo, deps: ReplayDeps = {}): number {
  let options: ReplayOptions | null;
  try {
    options = parseReplayArgs(argv, deps);
  } catch (error) {
    if (error instanceof ReplayUsageError) {
      io.stderr(`eval:replay: ${error.message}\n${USAGE}\n`);
      return 2;
    }
    if (error instanceof ReplayStoreError) {
      io.stderr(`eval:replay: ${error.message}\n`);
      return 1;
    }
    throw error;
  }
  if (options === null) {
    io.stdout(`${USAGE}\n`);
    return 0;
  }
  if (!isReadableFolder(options.home)) {
    io.stderr(`eval:replay: the data folder ${options.home} does not exist or cannot be read\n`);
    return 1;
  }
  const store = readStore(options.home);
  const report = buildReport(store, options);
  if (options.linksSample !== null) {
    report.linksAudit = auditLinks({
      store,
      home: options.home,
      records: selectedRecords(store, options),
      window: report.window,
      sample: options.linksSample,
      ...(deps.git === undefined ? {} : { git: deps.git }),
    });
  }
  io.stdout(options.json ? `${JSON.stringify(report, null, 2)}\n` : renderMarkdown(report));
  return 0;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = runReplay(process.argv.slice(2), {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
  });
}
