/**
 * Fallback incidents: one record per agent turn that ended on a provider-plan
 * failure (delta 20260921 §4.4.2, §4.4.5, REQ-065 a, g, i, j).
 *
 * `registerFallbackDetection` adds one `agent.turn_ended` handler. For a turn
 * `classifyTurn` recognises (L1, L2, L4, L5) it builds the incident:
 *
 * 1. dedupe — an agent with a `pending`, `waiting` or `switched` incident gets
 *    no second one;
 * 2. usage — only for L1, on base provider `claude` or `codex`, with the role's
 *    policy not `off`: ONE `providers.listUsage()` within 5 s (owner decision
 *    Q2 a: the daemon calls the provider's usage API only AFTER a detected
 *    failure). `resetsAt` is the latest reset among the exhausted windows;
 *    `perModelWindow` is true when every exhausted window is per model;
 * 3. candidate — the first entry after the failed agent's position in the
 *    role's chain that survives the four skip rules of §4.4.5;
 * 4. `managerId` — the chat whose card shows it;
 * 5. writes it `pending`, or `dismissed` when the policy is `off` (recorded all
 *    the same, so phase 2a-18 has real data), and tells the listeners
 *    (`onFallbackIncident`) — the BM-FALLBACK notice and the card.
 *
 * `<install home>/role-fallback-state.json` is user data like
 * `role-extras.json` (F9): mode 0600, temp file then rename, symlink refused,
 * never touched by an update, `--prune` or uninstall. At most 200 incidents,
 * the oldest finished ones dropped first; every read-modify-write runs under
 * one in-process mutex. A file that does not parse is never overwritten:
 * nothing is recorded, with one log line each time, until it is fixed or deleted.
 *
 * Never throws into an agent turn: every failure costs one `[paseo-bm]` line.
 */
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { roleOfProvider } from "./agent-role";
import { redactText, sliceLastTurn, type CollectorPaseo } from "./collector";
import { classifyTurn, quietReply } from "./fallback-detect";
import { chainOf, readRoleFallback, type FallbackChain } from "./fallback-settings";
import { TRACES_DIR_NAME } from "./install-home";
import { PARENT_AGENT_LABEL } from "./manager";
import { providerId } from "./provider-id";
import { asRecord, availableProviders, nonEmpty, reasonOf } from "./role-choices";
import { installHomeOf } from "./role-extras";
import { TIMED_OUT, withTimeout } from "./role-mode";
import { writeStoreFileAtomically } from "./trace-store";
import { fallbackAlias, positionOfAlias } from "../shared/fallback";
import { fallbackIncidentSchema, type BmRole, type FallbackIncident } from "../shared/contracts";
import type { FallbackClass } from "../shared/fallback-patterns";

export const ROLE_FALLBACK_STATE_FILE = "role-fallback-state.json";

/** Incidents kept; the oldest finished ones go first. */
export const MAX_INCIDENTS = 200;

/** Longest verbatim failure message kept. */
export const MAX_INCIDENT_MESSAGE_CHARS = 500;

/** Budget of the one `listUsage` call of an incident (§4.4.5 step 2). */
export const USAGE_TIMEOUT_MS = 5000;

/** Base providers whose usage Paseo can read (proposal S6) and whose L1 is worth a `listUsage`. */
export const USAGE_PROVIDERS: readonly string[] = ["claude", "codex"];

/** Model families a per-model window names (`seven_day_opus`), and that §4.4.5 compares. */
const MODEL_FAMILY = /(opus|sonnet|haiku|gpt)/i;

/** Statuses of an incident still being decided or acted on; dedupe also counts `switched`. */
const OPEN_STATUSES: ReadonlySet<FallbackIncident["status"]> = new Set(["pending", "waiting"]);
const DEDUPE_STATUSES: ReadonlySet<FallbackIncident["status"]> = new Set(["pending", "waiting", "switched"]);

const stateFileSchema = z.object({ version: z.literal(1), incidents: z.array(fallbackIncidentSchema) });

const defaultLog = (message: string): void => console.warn(message);

// ---------------------------------------------------------------------------
// The file.
// ---------------------------------------------------------------------------

/** The incidents in `home`; `error` when the file exists but cannot be used. Never throws. */
export function readIncidents(home: string, log: (message: string) => void = defaultLog): { incidents: FallbackIncident[]; error: string | null } {
  const path = join(home, ROLE_FALLBACK_STATE_FILE);
  const invalid = (reason: string) => {
    log(`[paseo-bm] ${path} is not usable (${reason}); no fallback incident is recorded until it is fixed or deleted.`);
    return { incidents: [], error: reason };
  };
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return { incidents: [], error: null };
    return invalid(reasonOf(error));
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return invalid(`not JSON: ${reasonOf(error)}`);
  }
  const result = stateFileSchema.safeParse(parsed);
  if (!result.success) {
    const issue = result.error.issues[0];
    return invalid(issue === undefined ? "unexpected content" : `${issue.path.join(".") || "(root)"}: ${issue.message}`);
  }
  return { incidents: result.data.incidents, error: null };
}

/**
 * Agent id → the agent that replaced it, for every `switched` incident with a
 * replacement: with the `bm.replacedBy` label, how the one-Worker rule and the
 * agent tree know a replaced agent even when labelling it failed (§4.4.8).
 */
export function replacementsOf(incidents: readonly FallbackIncident[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const incident of incidents) {
    if (incident.status === "switched" && incident.replacementId !== null) out.set(incident.agentId, incident.replacementId);
  }
  return out;
}

/**
 * `replacementsOf` the incidents in the install home of `paseo`, within the
 * lookup budget; empty when either cannot be read. Never throws.
 */
export async function replacementsFor(paseo: unknown, deps: { homedir?: () => string; home?: string | null } = {}): Promise<Map<string, string>> {
  try {
    const found = deps.home !== undefined ? deps.home : await withTimeout(installHomeOf(paseo, deps.homedir === undefined ? {} : { homedir: deps.homedir }));
    if (found === null || found === TIMED_OUT) return new Map();
    return replacementsOf(readIncidents(found, () => {}).incidents);
  } catch {
    return new Map();
  }
}

/** At most `MAX_INCIDENTS`: the oldest finished incidents go first, then the oldest of all. */
export function capIncidents(incidents: readonly FallbackIncident[]): FallbackIncident[] {
  const kept = [...incidents];
  while (kept.length > MAX_INCIDENTS) {
    const finished = kept.findIndex((incident) => !OPEN_STATUSES.has(incident.status));
    kept.splice(finished === -1 ? 0 : finished, 1);
  }
  return kept;
}

let queue: Promise<unknown> = Promise.resolve();

/** Runs `work` after every update queued before it; a failure does not block the next one. */
function serialised<T>(work: () => Promise<T> | T): Promise<T> {
  const run = queue.then(work, work);
  queue = run.catch(() => undefined);
  return run;
}

/**
 * Read-modify-write of the incidents under the mutex. `change` returns the new
 * list, or `null` to write nothing. Returns what was written, or `null` when
 * nothing was (no change, or an unusable file). Throws when the write fails.
 */
export function updateIncidents(
  home: string,
  change: (incidents: FallbackIncident[]) => FallbackIncident[] | null,
  log: (message: string) => void = defaultLog,
): Promise<FallbackIncident[] | null> {
  return serialised(() => {
    const read = readIncidents(home, log);
    if (read.error !== null) return null;
    const next = change(read.incidents);
    if (next === null) return null;
    const incidents = capIncidents(next);
    writeStoreFileAtomically(
      { tracesDir: join(home, TRACES_DIR_NAME) },
      join(home, ROLE_FALLBACK_STATE_FILE),
      `${JSON.stringify({ version: 1, incidents }, null, 2)}\n`,
    );
    return incidents;
  });
}

// ---------------------------------------------------------------------------
// Usage (§4.4.5 step 2).
// ---------------------------------------------------------------------------

export interface UsageFacts {
  resetsAt: string | null;
  perModelWindow: boolean;
}

const NO_USAGE: UsageFacts = { resetsAt: null, perModelWindow: false };

/**
 * The reset time and window kind of `baseProvider`'s exhausted windows, from
 * ONE `providers.listUsage()` raced against `USAGE_TIMEOUT_MS`. A window is
 * exhausted at `usedPct >= 100` or `remainingPct <= 0`. Failure, timeout or no
 * exhausted window → `{ resetsAt: null, perModelWindow: false }`. Never throws.
 */
export async function usageOf(paseo: unknown, baseProvider: string, log: (message: string) => void = defaultLog): Promise<UsageFacts> {
  const providers = (paseo as { providers?: { listUsage?: unknown } } | null | undefined)?.providers;
  const listUsage = providers?.listUsage;
  if (typeof listUsage !== "function") return NO_USAGE;
  try {
    const result = await withTimeout(listUsage.call(providers) as Promise<{ providers?: unknown } | null | undefined>, USAGE_TIMEOUT_MS);
    if (result === TIMED_OUT) {
      log(`[paseo-bm] reading the usage of ${baseProvider} took longer than ${USAGE_TIMEOUT_MS} ms; the fallback card shows no reset time.`);
      return NO_USAGE;
    }
    const entry = (Array.isArray(result?.providers) ? (result.providers as unknown[]) : [])
      .map(asRecord)
      .find((candidate) => candidate?.["providerId"] === baseProvider);
    const windows = Array.isArray(entry?.["windows"]) ? (entry["windows"] as unknown[]).map(asRecord) : [];
    const exhausted = windows.filter((window): window is Record<string, unknown> => {
      if (window === null) return false;
      const used = window["usedPct"];
      const remaining = window["remainingPct"];
      return (typeof used === "number" && used >= 100) || (typeof remaining === "number" && remaining <= 0);
    });
    if (exhausted.length === 0) return NO_USAGE;
    let latest: { iso: string; at: number } | null = null;
    for (const window of exhausted) {
      const iso = nonEmpty(window["resetsAt"]);
      const at = iso === null ? Number.NaN : Date.parse(iso);
      if (iso !== null && !Number.isNaN(at) && (latest === null || at > latest.at)) latest = { iso, at };
    }
    const perModelWindow = exhausted.every((window) => MODEL_FAMILY.test(String(window["id"] ?? "")));
    return { resetsAt: latest?.iso ?? null, perModelWindow };
  } catch (error) {
    log(`[paseo-bm] could not read the usage of ${baseProvider} (${reasonOf(error)}); the fallback card shows no reset time.`);
    return NO_USAGE;
  }
}

// ---------------------------------------------------------------------------
// Candidate (§4.4.5 step 3).
// ---------------------------------------------------------------------------

/** The model family of a model id (`claude-opus-5` → `opus`), or null. */
export function modelFamilyOf(model: string | null): string | null {
  return model === null ? null : (MODEL_FAMILY.exec(model)?.[1]?.toLowerCase() ?? null);
}

export interface CandidateInput {
  role: BmRole;
  chain: FallbackChain;
  /** Position of the failed agent's alias: 0 for the main alias, 1…3 for a fallback. */
  failedPosition: number;
  failedBaseProvider: string | null;
  failedModel: string | null;
  cls: FallbackClass;
  perModelWindow: boolean;
  /** Aliases that already failed in the same scope (request, or workspace for a Manager). */
  failedAliases: ReadonlySet<string>;
  /** Available base providers; `null` when Paseo cannot say (the rule is then not applied). */
  available: ReadonlySet<string> | null;
}

/**
 * The first entry after the failed agent's position that survives the four
 * skip rules, or null when the chain is exhausted:
 * 1. its alias already failed in the same scope;
 * 2. its base provider is not available;
 * 3. it shares the failed agent's base provider and the class is L2 or L4, or
 *    L1 without `perModelWindow` (a plan or login failure hits the whole provider);
 * 4. L1 with `perModelWindow`, same base provider and the same model family.
 */
export function candidateOf(input: CandidateInput): FallbackIncident["candidate"] {
  for (const [index, entry] of input.chain.entries.entries()) {
    const position = index + 1;
    if (position <= input.failedPosition) continue;
    const alias = fallbackAlias(input.role, position);
    if (input.failedAliases.has(alias)) continue;
    if (input.available !== null && !input.available.has(entry.baseProvider)) continue;
    const sameProvider = input.failedBaseProvider !== null && entry.baseProvider === input.failedBaseProvider;
    if (sameProvider && (input.cls === "L2" || input.cls === "L4" || (input.cls === "L1" && !input.perModelWindow))) continue;
    if (sameProvider && input.cls === "L1" && input.perModelWindow) {
      const family = modelFamilyOf(input.failedModel);
      if (family !== null && family === modelFamilyOf(entry.model)) continue;
    }
    return { position, alias, baseProvider: entry.baseProvider, model: entry.model, thinkingOptionId: entry.thinkingOptionId, modeId: entry.modeId };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Recording one incident.
// ---------------------------------------------------------------------------

/** The part of the SDK a snapshot read uses; `PaseoApi` is structurally assignable. */
interface SnapshotPaseo {
  agents: { ref(agentId: string): { refresh(): Promise<{ agent?: unknown } | null> } };
}

/** Gets each written incident, the Paseo handle of the hook that wrote it, the role's policy then, and the install home. */
export type IncidentListener = (
  incident: FallbackIncident,
  paseo: unknown,
  context: { policy: FallbackChain["policy"]; home: string },
) => void | Promise<void>;
const listeners = new Set<IncidentListener>();

/** Subscribes to every incident written (the BM-FALLBACK notice and the card); returns the remover. */
export function onFallbackIncident(listener: IncidentListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export interface RecordDeps {
  paseo: unknown;
  home: string;
  now?: () => Date;
  log?: (message: string) => void;
  /** 12 hex characters; tests pass a fixed one. */
  randomHex?: () => string;
}

/** An agent snapshot (`refresh()`), raced against the lookup budget; null when unreadable. */
async function snapshotOf(paseo: unknown, agentId: string): Promise<Record<string, unknown> | null> {
  try {
    const ref = (paseo as SnapshotPaseo).agents.ref(agentId);
    const result = await withTimeout(ref.refresh());
    return result === TIMED_OUT ? null : asRecord(result?.agent);
  } catch {
    return null;
  }
}

const labelsOf = (snapshot: Record<string, unknown> | null): Record<string, unknown> => asRecord(snapshot?.["labels"]) ?? {};

/** The model the agent runs: `runtimeInfo.model` first (AGENTS.md), else the configured one. */
function modelOf(snapshot: Record<string, unknown> | null): string | null {
  return nonEmpty(asRecord(snapshot?.["runtimeInfo"])?.["model"]) ?? nonEmpty(snapshot?.["model"]);
}

/** The `extends` of every alias, from one `config.get()` under the lookup budget; `{}` when unreadable. */
async function aliasBases(paseo: unknown): Promise<Record<string, string>> {
  const config = (paseo as { config?: { get?: unknown } } | null | undefined)?.config;
  if (typeof config?.get !== "function") return {};
  try {
    const result = await withTimeout(config.get.call(config) as Promise<{ config?: unknown } | null | undefined>);
    if (result === TIMED_OUT) return {};
    const providers = asRecord(asRecord(result?.config)?.["providers"]) ?? {};
    const out: Record<string, string> = {};
    for (const [id, entry] of Object.entries(providers)) {
      const base = nonEmpty(asRecord(entry)?.["extends"]);
      if (base !== null) out[id] = base;
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * Builds and writes the incident of one classified turn (§4.4.5 steps 1–5).
 * Returns it, or null when nothing was written: the agent already has an open
 * incident, the turn has no workspace, or the file cannot be used. Never throws.
 */
export async function recordIncident(
  event: { agent: { id: string; provider: string; workspaceId?: string | null } },
  signal: { class: FallbackClass; signal: "failed" | "completed"; message: string },
  deps: RecordDeps,
): Promise<FallbackIncident | null> {
  const log = deps.log ?? defaultLog;
  const now = deps.now ?? (() => new Date());
  try {
    const agentId = event.agent.id;
    const agentProvider = event.agent.provider;
    const role = roleOfProvider(agentProvider);
    const workspaceId = event.agent.workspaceId ?? null;
    if (role === null || workspaceId === null) return null;
    const hasOpen = (incidents: readonly FallbackIncident[]) =>
      incidents.some((incident) => incident.agentId === agentId && DEDUPE_STATUSES.has(incident.status));

    const existing = readIncidents(deps.home, log);
    if (existing.error !== null || hasOpen(existing.incidents)) return null;

    const chain = chainOf(readRoleFallback(deps.home, log).file, role);
    const snapshot = await snapshotOf(deps.paseo, agentId);
    const labels = labelsOf(snapshot);
    const requestId = role === "manager" ? null : nonEmpty(labels["bm.requestId"]);
    const agentModel = modelOf(snapshot);
    const alias = providerId(agentProvider) ?? agentProvider;
    const bases = await aliasBases(deps.paseo);
    const failedBaseProvider = bases[alias] ?? null;

    const usage =
      signal.class === "L1" && chain.policy !== "off" && failedBaseProvider !== null && USAGE_PROVIDERS.includes(failedBaseProvider)
        ? await usageOf(deps.paseo, failedBaseProvider, log)
        : NO_USAGE;

    const scope = (incident: FallbackIncident) =>
      incident.role === role && (role === "manager" ? incident.workspaceId === workspaceId : requestId !== null && incident.requestId === requestId);
    const failedAliases = new Set(existing.incidents.filter(scope).map((incident) => providerId(incident.agentProvider) ?? incident.agentProvider));
    failedAliases.add(alias);
    const candidate = candidateOf({
      role,
      chain,
      failedPosition: positionOfAlias(alias) ?? 0,
      failedBaseProvider,
      failedModel: agentModel,
      cls: signal.class,
      perModelWindow: usage.perModelWindow,
      failedAliases,
      available: await availableProviders(deps.paseo),
    });

    const parentId = role === "manager" ? null : nonEmpty(labels[PARENT_AGENT_LABEL]);
    let managerId: string | null;
    if (role === "manager") managerId = agentId;
    else if (role === "worker") managerId = parentId;
    else managerId = parentId === null ? null : nonEmpty(labelsOf(await snapshotOf(deps.paseo, parentId))[PARENT_AGENT_LABEL]);

    const detectedAt = now().toISOString();
    const off = chain.policy === "off";
    const incident: FallbackIncident = {
      id: `fb-${(deps.randomHex ?? (() => randomBytes(6).toString("hex")))()}`,
      role,
      workspaceId,
      requestId,
      agentId,
      agentProvider,
      agentModel,
      parentId,
      managerId,
      class: signal.class,
      signal: signal.signal,
      // Verbatim but masked like every trace record (REQ-048b), then cut.
      message: redactText(signal.message).slice(0, MAX_INCIDENT_MESSAGE_CHARS),
      perModelWindow: usage.perModelWindow,
      resetsAt: usage.resetsAt,
      candidate,
      status: off ? "dismissed" : "pending",
      detectedAt,
      decidedAt: off ? detectedAt : null,
      waitUntil: null,
      replacementId: null,
      error: null,
    };
    // The usage call ran outside the lock: check again that no incident of
    // this agent was written meanwhile, and append in the same step.
    const written = await updateIncidents(deps.home, (incidents) => (hasOpen(incidents) ? null : [...incidents, incident]), log);
    if (written === null) return null;
    for (const listener of listeners) {
      try {
        await listener(incident, deps.paseo, { policy: chain.policy, home: deps.home });
      } catch (error) {
        log(`[paseo-bm] a fallback incident listener failed: ${reasonOf(error)}`);
      }
    }
    return incident;
  } catch (error) {
    log(`[paseo-bm] recording a fallback incident for ${event?.agent?.id ?? "(unknown)"} failed: ${reasonOf(error)}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Registration.
// ---------------------------------------------------------------------------

export type FallbackHost = Partial<Pick<PluginServerContext, "on">>;

export interface RegisterFallbackOptions {
  log?: (message: string) => void;
  now?: () => Date;
  /** The install home; tests pass one, the plugin looks it up (and keeps it once found). */
  home?: () => Promise<string | null>;
  /** Hears the SDK handle of every paseo-bm turn end (the wait timers are set again from it, §4.4.9). */
  onPaseo?: (paseo: unknown) => void;
}

/**
 * Adds the `agent.turn_ended` handler that classifies the turn and records an
 * incident. An ordinary turn costs nothing: the install home and the user's
 * patterns are only read for a paseo-bm turn that failed, or that completed
 * with a short reply and nothing else (N2), and `classifyTurn` makes no daemon
 * call before its text classifies. Returns the remover; on a host without
 * `on` it does nothing.
 */
export function registerFallbackDetection(host: FallbackHost, options: RegisterFallbackOptions = {}): () => void {
  if (typeof host.on !== "function") return () => {};
  const log = options.log ?? defaultLog;
  let knownHome: string | null = null;
  const homeOf = async (paseo: unknown): Promise<string | null> => {
    if (options.home !== undefined) return options.home();
    if (knownHome !== null) return knownHome;
    const found = await withTimeout(installHomeOf(paseo));
    knownHome = found === TIMED_OUT ? null : found;
    return knownHome;
  };
  const remove = host.on("agent.turn_ended", async (event, context) => {
    try {
      const outcome = event?.outcome?.kind;
      if (roleOfProvider(event?.agent?.provider) === null) return;
      const handle = (context as { paseo?: unknown } | undefined)?.paseo;
      if (handle !== undefined) options.onPaseo?.(handle);
      if (outcome !== "failed" && outcome !== "completed") return;
      const text =
        outcome === "failed"
          ? nonEmpty((event.outcome as { error?: { message?: unknown } }).error?.message)
          : quietReply(sliceLastTurn(Array.isArray(event.timeline) ? event.timeline : []));
      if (text === null) return;
      const paseo = (context as { paseo?: unknown } | undefined)?.paseo;
      if (paseo === undefined) return;
      const home = await homeOf(paseo);
      if (home === null) return;
      const patterns = readRoleFallback(home, log).file.patterns ?? null;
      const signal = await classifyTurn(event, { paseo: paseo as CollectorPaseo, patterns, log });
      if (signal === null) return;
      await recordIncident(event, signal, { paseo, home, log, ...(options.now === undefined ? {} : { now: options.now }) });
    } catch (error) {
      log(`[paseo-bm] fallback detection failed: ${reasonOf(error)}`);
    }
  });
  return () => {
    if (typeof remove === "function") remove();
  };
}
