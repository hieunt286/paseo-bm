/**
 * The replay: the programme's metrics computed from a paseo-bm data folder
 * (design docs/design/paseo-bm-evaluation.md §2, §5).
 *
 *   npm run eval:replay -- [--home <dir>] [--since ISO] [--until ISO]
 *                          [--workspace <id>]... [--version <x.y.z | ISO..ISO>] [--json]
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
 * - `decisions/<workspaceId>.json` (the stored decisions: A-1, A-2 (c), A-6);
 * - `orchestrator/proposals.json`, `orchestrator/stalls.json`,
 *   `orchestrator/wakes.json` (A-7) and the times of
 *   `orchestrator/notes/<workspaceId>.json`, when present.
 *
 * The output holds numbers only — no message text, no path — plus the window,
 * the filters and the workspace ids and labels, so a report can be pasted into
 * the repository.
 *
 * The plugin's modules use extension-less imports that Node cannot load, so
 * the npm script bundles this file with `tsup` (`tsup.eval.config.ts`) into
 * the git-ignored `.eval-dist/` and runs the bundle.
 */
import { homedir as nodeHomedir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { TraceRecord } from "../../plugin/shared/contracts.js";
import { computeEvalMetrics, workspaceOfStallKey, type EvalMetrics, type EvalNote, type EvalWindow } from "../../plugin/shared/eval-metrics.js";
import { resolveDataHome } from "../../plugin/server/data-home.js";
import { isReadableFolder, readStore, selectWorkspaces, workspaceDirectoriesOf, workspacesOfWake, type StoreRead } from "../../plugin/server/eval-store.js";

export const REPLAY_SCHEMA_VERSION = 1;

export const USAGE = `usage: npm run eval:replay -- [--home <dir>] [--since ISO] [--until ISO]
                            [--workspace <id>]... [--version <x.y.z | ISO..ISO>] [--json]

  --home <dir>        the paseo-bm data folder (default: PASEO_BM_HOME, else ~/.paseo-bm)
  --since, --until    inclusive window; a request counts when its earliest activity is inside
  --workspace <id>    only this workspace; repeat for several
  --version x.y.z     only records written by that plugin version (older records carry none)
  --version ISO..ISO  a version given as its time window (either side may be empty)
  --json              JSON instead of Markdown`;

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
}

export interface ReplayDeps {
  env?: Readonly<Record<string, string | undefined>>;
  homedir?: () => string;
  cwd?: () => string;
}

const RELEASE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/** An ISO time as the window carries it (normalised), or a usage error. */
function isoOf(value: string, flag: string): string {
  const ms = Date.parse(value);
  if (value.trim() === "" || Number.isNaN(ms)) throw new ReplayUsageError(`${flag} is not an ISO time: ${JSON.stringify(value)}`);
  return new Date(ms).toISOString();
}

/** Reads the command line. Throws `ReplayUsageError`; returns `null` for `--help`. */
export function parseReplayArgs(argv: readonly string[], deps: ReplayDeps = {}): ReplayOptions | null {
  let home: string | null = null;
  let since: string | null = null;
  let until: string | null = null;
  let version: VersionFilter | null = null;
  let json = false;
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
      default:
        throw new ReplayUsageError(`unknown argument: ${JSON.stringify(flag)}`);
    }
  }
  if (home === null) {
    const resolution = resolveDataHome({ env: deps.env ?? process.env, homedir: deps.homedir ?? nodeHomedir });
    if (resolution.home === null) throw new ReplayStoreError(`the paseo-bm data folder cannot be used: ${resolution.reason}`);
    home = resolution.home;
  }
  return { home, since, until, workspaces, version, json };
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
  let { records, proposals, stalls, notes, decisions, wakes } = selectWorkspaces(store, workspaceIds);
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
  }
  return { records, proposals, stalls, notes, decisions, wakes, recordsWithoutVersion, orchestratorEntriesNotAttributed };
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

/** The replay of one data folder: pure given the store that was read. */
export function buildReport(store: StoreRead, options: ReplayOptions): ReplayReport {
  const window = effectiveWindow(options);
  const filterIds = options.workspaces.length === 0 ? null : new Set(options.workspaces);
  const workspaceDirectories = workspaceDirectoriesOf(store);

  const run = (ids: ReadonlySet<string> | null) => {
    const selection = select(store, options, ids);
    const metrics = computeEvalMetrics({
      records: selection.records,
      ...(selection.proposals === undefined ? {} : { proposals: selection.proposals }),
      ...(selection.stalls === undefined ? {} : { stalls: selection.stalls }),
      ...(selection.notes === undefined ? {} : { notes: selection.notes }),
      ...(selection.decisions === undefined ? {} : { decisions: selection.decisions }),
      ...(selection.wakes === undefined ? {} : { wakes: selection.wakes }),
      window,
      workspaceDirectories,
    });
    return { selection, metrics };
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
  lines.push(`| A-8 tokens per finished request (mean / median) | ${formatValue(metrics.a8.perFinishedRequest?.total ?? null)} / ${formatValue(metrics.a8.medianPerFinishedRequest)} |`);
  lines.push(`| A-11 median request time, owner wait excluded (ms) | ${formatValue(metrics.a11.medianMs)} |`, "");

  lines.push("## Every metric", "", "| Metric | Value |", "|---|---|");
  for (const [path, value] of flatten(metrics)) lines.push(`| ${path} | ${formatValue(value)} |`);
  lines.push("");

  lines.push("## By workspace", "");
  if (report.byWorkspace.length === 0) {
    lines.push("No workspace has activity in the window.", "");
  } else {
    lines.push("| Workspace | Label | Requests | Finished | Asked | Reached owner | Recommended / answered | Tokens (finished) |", "|---|---|---|---|---|---|---|---|");
    for (const row of report.byWorkspace) {
      const m = row.metrics;
      const rec = m.supplementary.recommendedAgreement;
      lines.push(
        `| ${cell(row.workspaceId)} | ${cell(row.label ?? "")} | ${m.requests.inWindow} | ${m.requests.finished} | ${m.a1.all.asked} | ${m.a1.all.reachedOwner} | ${rec.recommended} / ${rec.answered} | ${m.a8.tokens.total} |`,
      );
    }
    lines.push("");
  }

  lines.push("## Unknowns", "", "| Unknown | Count |", "|---|---|");
  for (const [path, value] of flatten(report.unknowns)) lines.push(`| ${path} | ${formatValue(value)} |`);
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
  const report = buildReport(readStore(options.home), options);
  io.stdout(options.json ? `${JSON.stringify(report, null, 2)}\n` : renderMarkdown(report));
  return 0;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = runReplay(process.argv.slice(2), {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
  });
}
