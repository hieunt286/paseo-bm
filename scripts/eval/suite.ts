/**
 * The evaluation suite driver (design docs/design/paseo-bm-evaluation.md
 * §6.5, §8):
 *
 *   npm run eval:suite -- --version <npm spec | tree> [--only S1,S2] [--work <dir>]
 *                         [--runs <n>] [--port <n>] [--role-model <role>=<baseProvider>/<model>]
 *
 * `--role-model` is the model-choice experiment of autonomy design §F.2
 * (REQ-162): exactly one role runs on another model, the others on the
 * owner's; the swap is recorded in `scorecard.json` (`roleModelSwap`).
 *
 * It only sequences the building blocks: `scenario.ts` (what to run),
 * `fixtures.ts` (the repository), `owner.ts` (the simulated owner), `score.ts`
 * (the verdicts and the scorecard). Everything it does to Paseo goes to an
 * ISOLATED daemon started by `scripts/manual-test/start-daemon.sh` under
 * `<work>/paseo-home`, with its paseo-bm data folder at `<work>/bm-home`:
 *
 * 1. start the daemon (port ≠ 6767, homes ≠ the owner's `~/.paseo` / `~/.paseo-bm`);
 * 2. install the plugin under test (`npm:paseo-bm-plugin@…` or `<repo>/plugin`),
 *    and require `status: "running"`;
 * 3. `setup.ensure-roles`, every role set to the owner's model (read, read-only,
 *    from the owner's `~/.paseo/config.json` `bm-*` profiles) with
 *    `roles.save-settings`, `setup.grant-agent-tools { confirmed: true }`;
 * 4. `tree` only: `orchestrator.open { confirmed: true }`, and for each scenario
 *    workspace the owner's policy with every class that may be delegated
 *    delegated to the Orchestrator (`autonomy.set`, `scenarioPolicyCalls`;
 *    owner decision E-2, evaluation design §11);
 * 5. per scenario and run: fixture, project and workspace, `manager.ensure`, the
 *    requests sent as the app sends them, the simulated owner every 15 s (for
 *    the tree through the `decision-rpc` channel: `decisions.list` of the run's
 *    workspace, answered with `decisions.answer`; for an npm build through the
 *    retired `chat.waiting` of `legacy-contracts.ts`) until
 *    the run's agents are idle (two polls in a row, nothing pending), the
 *    scenario times out, or a permission request needs a human; then scored;
 * 6. `<work>/scorecard.json`, `<work>/replay.json` (the replay of `<work>/bm-home`),
 *    and the daemon stopped with `scripts/manual-test/stop-daemon.sh` — always,
 *    in a `finally`, and on Ctrl-C.
 *
 * Never: `paseo daemon stop` (it can stop the owner's daemon), a write under
 * `~/.paseo` or `~/.paseo-bm`, an answer to a Paseo permission request. Before
 * and after the run it fingerprints the owner's `~/.paseo/config.json` (SHA-256)
 * and `~/.paseo-bm` (paths, sizes, mtimes; nothing is opened there) and writes
 * both to `<work>/owner-guard.json`.
 *
 * The plugin modules use extension-less imports, so the npm script bundles this
 * file with `tsup` (`tsup.eval.config.ts`) into `.eval-dist/` and runs the bundle.
 * The pure parts (arguments, guards, the loop decision, the owner-log mapping)
 * are exported for `test/eval-suite.test.ts`.
 */
import { execFile, execFileSync, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { mkdir, mkdtemp, open, readdir, realpath, writeFile } from "node:fs/promises";
import { homedir as nodeHomedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { parseQuestions } from "../../plugin/shared/bm-questions.js";
import { DECISION_CLASSES, isHardOwnerClass, type DecisionClass } from "../../plugin/shared/decisions.js";
import { legacyChatWaitingRpc, type LegacyWaitingWorker } from "./legacy-contracts.js";
import { buildFixture, type BuiltFixture } from "./fixtures.js";
import {
  answerableDecisions,
  DECISIONS_LIST_RPC,
  SimulatedOwner,
  type ChannelName,
  type OpenWorkerQuestions,
  type OwnerLogEntry,
  type OwnerTransport,
  type PendingPermission,
} from "./owner.js";
import { listScenarioFiles, loadScenario, type Scenario } from "./scenario.js";
import {
  buildScorecard,
  combineRuns,
  loadRunData,
  scoreRun,
  writeScorecard,
  type OwnerLogEntry as ScoreOwnerLogEntry,
  type RunScore,
  type ScenarioScore,
} from "./score.js";

const run = promisify(execFile);

// ── Constants ────────────────────────────────────────────────────────────────

/** The owner's real daemon. Never used, never reached. */
export const OWNER_DAEMON_PORT = 6767;
export const DEFAULT_PORT = 6899;
export const DEFAULT_RUNS = 2;
export const MAX_RUNS = 5;
/** How often the driver looks and lets the owner act (bead: "every ~15 s"). */
export const POLL_MS = 15_000;
/** Idle means this many polls in a row with no busy agent and nothing pending (as `wait-idle.mjs`). */
export const QUIET_POLLS = 2;
export const PLUGIN_ID = "paseo-bm";
export const PLUGIN_PACKAGE = "paseo-bm-plugin";
/** How long the plugin may take to report `running` after the install. */
export const PLUGIN_START_TIMEOUT_MS = 120_000;
/** How long the driver waits for a just-opened Orchestrator's first turn before the first scenario. */
export const ORCHESTRATOR_SETTLE_TIMEOUT_MS = 5 * 60_000;
/** `fetchAgents` refuses a page above 200. */
export const AGENTS_PAGE_LIMIT = 200;

export const USAGE = `usage: npm run eval:suite -- --version <npm spec | tree> [--only S1,S2] [--work <dir>]
                           [--runs <n>] [--port <n>] [--role-model <role>=<baseProvider>/<model>]

  --version <v>   what to test: "tree" (this checkout's plugin/), or an npm spec:
                  npm:paseo-bm-plugin@0.4.1, paseo-bm-plugin@0.4.1 or 0.4.1
  --only S1,S2    only these scenarios (default: all of scripts/eval/scenarios)
  --work <dir>    the run folder, new or empty (default: a new folder under the OS temp dir)
  --runs <n>      runs per scenario, 1-${MAX_RUNS} (default ${DEFAULT_RUNS})
  --port <n>      the isolated daemon's port (default ${DEFAULT_PORT}; never ${OWNER_DAEMON_PORT})
  --role-model <role>=<baseProvider>/<model>
                  an experiment: run one role (manager, worker, reviewer, orchestrator) on this
                  model instead of the owner's; every other role stays the owner's. Given once;
                  recorded in scorecard.json

Starts an isolated Paseo daemon under <work>, runs the scenarios with the simulated
owner, writes <work>/scorecard.json and <work>/replay.json, and stops that daemon.
Spends provider tokens (about one real request per scenario run).`;

/** The `stoppedReason` prefix of a run the driver could not finish: the suite then exits 1. */
export const DRIVER_ERROR = "driver error";

/** A wrong command line: printed with the usage, exit code 2. */
export class SuiteUsageError extends Error {
  override name = "SuiteUsageError";
}

/** A safety guard refused the run: exit code 2, nothing started. */
export class SuiteGuardError extends Error {
  override name = "SuiteGuardError";
}

// ── Arguments (pure) ─────────────────────────────────────────────────────────

export type VersionSpec = { kind: "tree" } | { kind: "npm"; spec: string };

const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const VERSION_OR_TAG = /^[0-9A-Za-z][0-9A-Za-z.+_-]*$/;

/**
 * `tree`, or an npm spec normalised to `npm:<package>@<version|tag>`:
 * `npm:paseo-bm-plugin@0.4.1`, `paseo-bm-plugin@0.4.1`, or a bare version
 * `0.4.1` (the published package). A spec without a version is refused: the
 * run must say exactly what was tested.
 */
export function parseVersion(raw: string): VersionSpec {
  const value = raw.trim();
  if (value === "") throw new SuiteUsageError("--version needs a value");
  if (value === "tree") return { kind: "tree" };
  if (/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/.test(value)) return { kind: "npm", spec: `npm:${PLUGIN_PACKAGE}@${value}` };
  const body = value.startsWith("npm:") ? value.slice("npm:".length) : value;
  const at = body.lastIndexOf("@");
  if (at <= 0) throw new SuiteUsageError(`--version ${value}: expected "tree" or <package>@<version>`);
  const name = body.slice(0, at);
  const version = body.slice(at + 1);
  if (!PACKAGE_NAME.test(name) || !VERSION_OR_TAG.test(version)) {
    throw new SuiteUsageError(`--version ${value}: expected "tree" or <package>@<version>`);
  }
  return { kind: "npm", spec: `npm:${name}@${version}` };
}

/** What the scorecard says was tested. */
export function versionLabel(version: VersionSpec): string {
  return version.kind === "tree" ? "tree" : version.spec;
}

/**
 * How the simulated owner answers: the tree (Phase 1 and later) through the
 * decision RPCs (`decision-rpc`, autonomy design §A.13); a published build
 * with `BM-ANSWERS` to its Workers (`0.4.1`).
 */
export function channelFor(version: VersionSpec): ChannelName {
  return version.kind === "tree" ? "decision-rpc" : "0.4.1";
}

/** One plugin RPC the driver calls, by its contract name. */
export interface RpcCall {
  method: string;
  input: Record<string, unknown>;
}

/**
 * The classes the tree's scenario projects delegate: every class that may be
 * delegated — all but release, data, security and cost
 * (`HARD_OWNER_CLASSES`, which `autonomy.set` refuses to delegate) — riskiest
 * first.
 */
export const DELEGATED_CLASSES: readonly DecisionClass[] = DECISION_CLASSES.filter((decisionClass) => !isHardOwnerClass(decisionClass));

/**
 * What the driver sets on a scenario's workspace once it is registered (owner
 * decision E-2, evaluation design §11): for the tree, the owner's policy with
 * every class of `DELEGATED_CLASSES` delegated to the Orchestrator —
 * `autonomy.set { workspaceId, class, mode: "delegate", confirmed: true,
 * predictor: "orchestrator" }` each (`autonomy.set` checks no eligibility, so
 * the suite may set it). Nothing for a published build, which has no policy.
 */
export function scenarioPolicyCalls(version: VersionSpec, workspaceId: string): RpcCall[] {
  if (version.kind !== "tree") return [];
  return DELEGATED_CLASSES.map((decisionClass) => ({
    method: "autonomy.set",
    input: { workspaceId, class: decisionClass, mode: "delegate", confirmed: true, predictor: "orchestrator" },
  }));
}

/** What `paseo plugin add` installs. */
export function installSource(version: VersionSpec, repo: string): string {
  return version.kind === "tree" ? join(repo, "plugin") : version.spec;
}

export interface SuiteOptions {
  version: VersionSpec;
  /** Scenario ids, in the order given; null = all. */
  only: string[] | null;
  work: string | null;
  runs: number;
  port: number;
  /** `--role-model`: the one role whose model this run swaps (autonomy design §F.2, REQ-162); null = every role the owner's. */
  roleModel: RoleModelSwap | null;
}

function positiveInteger(flag: string, raw: string | undefined): number {
  if (raw === undefined || !/^[0-9]+$/.test(raw)) throw new SuiteUsageError(`${flag} needs a whole number`);
  return Number(raw);
}

/** Parses the command line; null for `--help`. Throws `SuiteUsageError` for anything else wrong. */
export function parseSuiteArgs(argv: readonly string[]): SuiteOptions | null {
  let version: VersionSpec | null = null;
  let only: string[] | null = null;
  let work: string | null = null;
  let runs = DEFAULT_RUNS;
  let port = DEFAULT_PORT;
  let roleModel: RoleModelSwap | null = null;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]!;
    const next = (): string => {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) throw new SuiteUsageError(`${flag} needs a value`);
      index += 1;
      return value;
    };
    switch (flag) {
      case "--help":
      case "-h":
        return null;
      case "--version":
        version = parseVersion(next());
        break;
      case "--only": {
        const ids = next()
          .split(",")
          .map((id) => id.trim().toUpperCase())
          .filter((id) => id !== "");
        if (ids.length === 0 || ids.some((id) => !/^S[0-9]+$/.test(id))) throw new SuiteUsageError("--only takes scenario ids such as S1,S2");
        only = [...new Set(ids)];
        break;
      }
      case "--work":
        work = next();
        break;
      case "--runs":
        runs = positiveInteger(flag, next());
        if (runs < 1 || runs > MAX_RUNS) throw new SuiteUsageError(`--runs must be between 1 and ${MAX_RUNS}`);
        break;
      case "--port":
        port = positiveInteger(flag, next());
        break;
      case "--role-model":
        // One role per run: a second swap would leave the scorecard unable to say which one changed the result.
        if (roleModel !== null) throw new SuiteUsageError("--role-model swaps one role's model per run; it is given once");
        roleModel = parseRoleModel(next());
        break;
      default:
        throw new SuiteUsageError(`unknown argument: ${flag}`);
    }
  }
  if (version === null) throw new SuiteUsageError("--version is required");
  if (roleModel?.role === "orchestrator" && version.kind !== "tree") throw new SuiteUsageError("--role-model orchestrator=… needs --version tree: 0.4.1 has no Orchestrator");
  assertPort(port);
  return { version, only, work, runs, port, roleModel };
}

// ── Guards (pure) ────────────────────────────────────────────────────────────

/** Refuses the owner's daemon port and anything that is not a user port. */
export function assertPort(port: number): void {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new SuiteGuardError(`port ${port} is not a port between 1024 and 65535`);
  if (port === OWNER_DAEMON_PORT) throw new SuiteGuardError(`refusing port ${OWNER_DAEMON_PORT}: that is the owner's real daemon`);
}

/** The owner's real homes, which the suite never uses. */
export function ownerHomes(homedir: string): { paseo: string; bm: string } {
  return { paseo: resolve(homedir, ".paseo"), bm: resolve(homedir, ".paseo-bm") };
}

function sameOrInside(path: string, directory: string): boolean {
  const rel = relative(directory, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * The isolated homes must be neither the owner's homes nor inside them, and
 * must not contain them. Paths are compared as given; the caller passes real
 * paths when it has them (macOS: `/tmp` is `/private/tmp`).
 */
export function assertIsolatedHomes(isolated: { paseoHome: string; bmHome: string }, owner: { paseo: string; bm: string }): void {
  for (const [label, path] of [
    ["PASEO_HOME", isolated.paseoHome],
    ["PASEO_BM_HOME", isolated.bmHome],
  ] as const) {
    if (!isAbsolute(path)) throw new SuiteGuardError(`${label} must be absolute: ${path}`);
    for (const ownerHome of [owner.paseo, owner.bm]) {
      if (sameOrInside(resolve(path), resolve(ownerHome)) || sameOrInside(resolve(ownerHome), resolve(path))) {
        throw new SuiteGuardError(`refusing ${label} ${path}: it is, holds or lies inside the owner's ${ownerHome}`);
      }
    }
  }
  if (resolve(isolated.paseoHome) === resolve(isolated.bmHome)) throw new SuiteGuardError("PASEO_HOME and PASEO_BM_HOME must differ");
}

/** The daemon `stop-daemon.sh` may stop: its home is ours and it does not listen on the owner's port. */
export function assertIsolatedDaemon(status: { home?: unknown; listen?: unknown }, expected: { paseoHome: string; port: number }): void {
  if (typeof status.home !== "string" || resolve(status.home) !== resolve(expected.paseoHome)) {
    throw new SuiteGuardError(`the daemon reports home ${String(status.home)}, not ${expected.paseoHome}`);
  }
  if (typeof status.listen === "string" && new RegExp(`:${OWNER_DAEMON_PORT}$`).test(status.listen)) {
    throw new SuiteGuardError(`the daemon listens on ${status.listen}: that is the owner's port`);
  }
  if (typeof status.listen === "string" && status.listen !== `127.0.0.1:${expected.port}`) {
    throw new SuiteGuardError(`the daemon listens on ${status.listen}, not 127.0.0.1:${expected.port}`);
  }
}

// ── The owner's models (pure over the config) ────────────────────────────────

export type SuiteRole = "manager" | "worker" | "reviewer" | "orchestrator";
export const SUITE_ROLES: readonly SuiteRole[] = ["manager", "worker", "reviewer", "orchestrator"];

export interface RoleModel {
  baseProvider: string;
  model: string;
  thinkingOptionId: string | null;
  modeId: string | null;
}

const nonEmpty = (value: unknown): string | null => (typeof value === "string" && value.trim() !== "" ? value : null);
const asObject = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

/**
 * The owner's model per role, from their Paseo config: the `bm-<role>` profile
 * of `daemon.agentProfiles` (model, thinking, mode) and the base provider the
 * `bm-<role>` alias extends (`agents.providers`, or `providers`). Only those
 * fields are read. A role without a model or a base provider is left out.
 */
export function ownerRoleModels(config: unknown): Partial<Record<SuiteRole, RoleModel>> {
  const root = asObject(config) ?? {};
  const profiles = Array.isArray(asObject(root["daemon"])?.["agentProfiles"]) ? (asObject(root["daemon"])!["agentProfiles"] as unknown[]) : [];
  const providers = asObject(asObject(root["agents"])?.["providers"]) ?? asObject(root["providers"]) ?? {};
  const out: Partial<Record<SuiteRole, RoleModel>> = {};
  for (const role of SUITE_ROLES) {
    const id = `bm-${role}`;
    const profile = profiles.map(asObject).find((entry) => entry !== null && entry["id"] === id) ?? null;
    const baseProvider = nonEmpty(asObject(providers[id])?.["extends"]);
    const model = nonEmpty(profile?.["model"]);
    if (profile === null || baseProvider === null || model === null || baseProvider.startsWith("bm-")) continue;
    out[role] = {
      baseProvider,
      model,
      thinkingOptionId: nonEmpty(profile["thinkingOptionId"]),
      modeId: nonEmpty(profile["modeId"]),
    };
  }
  return out;
}

/**
 * The roles to save: those the installed plugin lists, plus the Orchestrator
 * for the tree (0.4.1 has none, and its `roles.save-settings` refuses it).
 * Every one must have an owner model.
 */
export function rolesToSave(listed: readonly string[], version: VersionSpec, models: Partial<Record<SuiteRole, RoleModel>>): SuiteRole[] {
  const wanted = new Set<string>(listed);
  if (version.kind === "tree") wanted.add("orchestrator");
  const roles = SUITE_ROLES.filter((role) => wanted.has(role));
  const missing = roles.filter((role) => models[role] === undefined);
  if (missing.length > 0) {
    throw new SuiteGuardError(`the owner's ~/.paseo/config.json has no model for ${missing.map((role) => `bm-${role}`).join(", ")}`);
  }
  return roles;
}

// ── The model-choice experiment (pure) ───────────────────────────────────────

/** `--role-model <role>=<baseProvider>/<model>`: the one role whose model a run swaps. */
export interface RoleModelSwap {
  role: SuiteRole;
  baseProvider: string;
  model: string;
}

/** What `scorecard.json` records of a swap: the owner's model for the role (null when they have none) and the one saved instead. */
export interface RoleModelSwapRecord {
  role: SuiteRole;
  owner: RoleModel | null;
  swapped: RoleModel;
}

/** A base provider id as Paseo names one (`claude`, `codex`, `opencode`, `pi`); a `bm-*` role alias is refused apart. */
const BASE_PROVIDER = /^[a-z][a-z0-9._-]*$/;
/** A model id: `claude-opus-5-5[1m]`, `gpt-5.6-sol`, OpenCode's `<provider>/<model>`; no space, no shell syntax. */
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/[\]-]*$/;
const MODEL_ID_MAX = 200;

/**
 * Reads `<role>=<baseProvider>/<model>`: the role is one of `SUITE_ROLES`, the
 * base provider is split at the first `/` (the model may hold more, as
 * OpenCode's do) and is never a `bm-*` alias. Throws `SuiteUsageError` for
 * anything else. Pure.
 */
export function parseRoleModel(raw: string): RoleModelSwap {
  const value = raw.trim();
  const usage = `--role-model ${JSON.stringify(raw)}: expected <role>=<baseProvider>/<model>, role one of ${SUITE_ROLES.join(", ")}`;
  const equals = value.indexOf("=");
  if (equals <= 0) throw new SuiteUsageError(usage);
  const role = value.slice(0, equals).trim().toLowerCase();
  const target = value.slice(equals + 1).trim();
  if (!(SUITE_ROLES as readonly string[]).includes(role)) throw new SuiteUsageError(`--role-model: unknown role ${JSON.stringify(role)}; one of ${SUITE_ROLES.join(", ")}`);
  const slash = target.indexOf("/");
  if (slash <= 0 || slash === target.length - 1) throw new SuiteUsageError(usage);
  const baseProvider = target.slice(0, slash);
  const model = target.slice(slash + 1);
  if (/^bm-/i.test(baseProvider)) throw new SuiteUsageError(`--role-model: ${baseProvider} is a paseo-bm role alias; name its base provider (claude, codex, …)`);
  if (!BASE_PROVIDER.test(baseProvider)) throw new SuiteUsageError(`--role-model: ${JSON.stringify(baseProvider)} is not a provider id`);
  if (model.length > MODEL_ID_MAX || !MODEL_ID.test(model)) throw new SuiteUsageError(`--role-model: ${JSON.stringify(model)} is not a model id`);
  return { role: role as SuiteRole, baseProvider, model };
}

/**
 * The role models with the swap applied, and its record. Only the swapped
 * role changes. On the owner's base provider it keeps their thinking level
 * and mode (`roles.save-settings` refuses a thinking level the new model does
 * not list, before any scenario runs); on another provider both fall to null
 * — the model's default thinking and the plugin's own posture for the role,
 * as a fresh setup gives it. A swap to the owner's own model is refused: the
 * run would be labelled an experiment and be none. Pure.
 */
export function applyRoleModelSwap(
  models: Partial<Record<SuiteRole, RoleModel>>,
  swap: RoleModelSwap,
): { models: Partial<Record<SuiteRole, RoleModel>>; record: RoleModelSwapRecord } {
  const owner = models[swap.role] ?? null;
  if (owner !== null && owner.baseProvider === swap.baseProvider && owner.model === swap.model) {
    throw new SuiteUsageError(`--role-model: ${swap.baseProvider}/${swap.model} is already the owner's model for the ${swap.role}; nothing to swap`);
  }
  const sameProvider = owner !== null && owner.baseProvider === swap.baseProvider;
  const swapped: RoleModel = {
    baseProvider: swap.baseProvider,
    model: swap.model,
    thinkingOptionId: sameProvider ? owner.thinkingOptionId : null,
    modeId: sameProvider ? owner.modeId : null,
  };
  return { models: { ...models, [swap.role]: swapped }, record: { role: swap.role, owner, swapped } };
}

// ── Observation (pure) ───────────────────────────────────────────────────────

/** An agent as the driver reads it from `fetchAgents`. */
export interface AgentView {
  id: string;
  title: string | null;
  provider: string;
  status: string;
  workspaceId: string | null;
  cwd: string | null;
  archived: boolean;
  pendingPermissions: Array<{ name?: string; title?: string }>;
  totalCostUsd: number | null;
}

export function agentViewOf(raw: unknown): AgentView | null {
  const entry = asObject(raw);
  const agent = asObject(entry?.["agent"]) ?? entry;
  if (agent === null || typeof agent["id"] !== "string") return null;
  const usage = asObject(agent["lastUsage"]);
  const cost = usage?.["totalCostUsd"];
  return {
    id: agent["id"],
    title: nonEmpty(agent["title"]),
    provider: typeof agent["provider"] === "string" ? agent["provider"] : "",
    status: typeof agent["status"] === "string" ? agent["status"] : "unknown",
    workspaceId: nonEmpty(agent["workspaceId"]),
    cwd: nonEmpty(agent["cwd"]),
    archived: nonEmpty(agent["archivedAt"]) !== null,
    pendingPermissions: Array.isArray(agent["pendingPermissions"]) ? (agent["pendingPermissions"] as Array<{ name?: string; title?: string }>) : [],
    totalCostUsd: typeof cost === "number" && Number.isFinite(cost) ? cost : null,
  };
}

export const isOrchestratorAgent = (agent: Pick<AgentView, "provider">): boolean => /^bm-orchestrator(?:\/|$)/.test(agent.provider);

/** The agents a run watches: those of its workspace (by id, or by a cwd inside its repository) and every Orchestrator. */
export function runAgents(agents: readonly AgentView[], run: { workspaceId: string; repo: string }): AgentView[] {
  return agents.filter(
    (agent) =>
      !agent.archived &&
      (agent.workspaceId === run.workspaceId || (agent.cwd !== null && sameOrInside(resolve(agent.cwd), resolve(run.repo))) || isOrchestratorAgent(agent)),
  );
}

export const isBusy = (agent: Pick<AgentView, "status">): boolean => agent.status === "running" || agent.status === "initializing";

/**
 * The run's `totalCostUsd` of every Orchestrator agent, summed (archived
 * included: a replaced Orchestrator's spend still counts). `totalCostUsd` is
 * the agent's running session total, so a run's cost is `after − before`.
 */
export function orchestratorCost(agents: readonly AgentView[]): number {
  return agents.filter(isOrchestratorAgent).reduce((sum, agent) => sum + (agent.totalCostUsd ?? 0), 0);
}

export function pendingPermissionsOf(agents: readonly AgentView[]): PendingPermission[] {
  return agents.flatMap((agent) =>
    agent.pendingPermissions.map((permission) => ({
      agentId: agent.id,
      title: permission.title ?? permission.name ?? agent.title ?? undefined,
    })),
  );
}

/**
 * The Worker questions still open in the run's workspace, from `chat.waiting`
 * of a build before Phase 1 (`legacy-contracts.ts`; what its app showed the
 * owner): the questions of each waiting Worker's report not answered yet. `firstSeen` remembers when a
 * set was first seen (the oldest is answered first); it is updated in place.
 */
export function openQuestionsFromWaiting(
  waiting: readonly Pick<LegacyWaitingWorker, "workspaceId" | "workerId" | "requestId" | "text" | "answered">[],
  workspaceId: string,
  firstSeen: Map<string, number>,
  now: number,
): OpenWorkerQuestions[] {
  const out: OpenWorkerQuestions[] = [];
  for (const entry of waiting) {
    if (entry.workspaceId !== workspaceId) continue;
    const answered = new Set(entry.answered);
    const questions = (parseQuestions(entry.text)?.questions ?? []).filter((question) => !answered.has(question.id));
    if (questions.length === 0) continue;
    const key = `${entry.workerId}|${entry.requestId}|${questions.map((question) => question.id).join(",")}`;
    if (!firstSeen.has(key)) firstSeen.set(key, now);
    out.push({ workerId: entry.workerId, requestId: entry.requestId, questions, firstSeenAt: firstSeen.get(key)! });
  }
  return out;
}

// ── The loop decision (pure) ─────────────────────────────────────────────────

export interface LoopPoll {
  /** A watched agent is running or initializing. */
  busy: boolean;
  /** Open Worker questions, or unsettled decisions (or 1 when they could not be read). */
  pending: number;
  /** What the owner did on this poll. */
  owner: "acted" | "idle" | "needed-a-human";
}

export type LoopDecision =
  | { kind: "continue"; quietPolls: number }
  | { kind: "idle" }
  | { kind: "timeout" }
  | { kind: "needed-a-human" };

/**
 * After one poll: stop for a human as soon as a permission request is seen;
 * idle after `QUIET_POLLS` polls in a row with nothing busy, nothing pending
 * and nothing done by the owner; timeout once `now` reaches the deadline;
 * otherwise go on, with the quiet count carried.
 */
export function decideLoop(quietPolls: number, poll: LoopPoll, now: number, deadline: number): LoopDecision {
  if (poll.owner === "needed-a-human") return { kind: "needed-a-human" };
  const quiet = !poll.busy && poll.pending === 0 && poll.owner !== "acted" ? quietPolls + 1 : 0;
  if (quiet >= QUIET_POLLS) return { kind: "idle" };
  if (now >= deadline) return { kind: "timeout" };
  return { kind: "continue", quietPolls: quiet };
}

// ── The owner log, as the scorer reads it (pure) ─────────────────────────────

/**
 * One scorer entry per answered item of every delivered answer: `target` is
 * what reached the owner (the question or decision), `text` the
 * answer given to it, so "asked about X" and "yes about X" are judged per
 * question. An answer whose send failed never reached its agent and is left out.
 */
export function toScoreOwnerLog(entries: readonly OwnerLogEntry[]): ScoreOwnerLogEntry[] {
  return entries
    .filter((entry) => entry.error === null)
    .flatMap((entry) =>
      entry.items.map((item) => ({
        at: entry.at,
        channel: entry.channel,
        text: item.answer,
        target: item.question,
      })),
    );
}

// ── The owner's machine, fingerprinted (read-only) ───────────────────────────

export interface OwnerFingerprint {
  configSha256: string | null;
  /** SHA-256 over the sorted listing of `~/.paseo-bm`: relative path, size, mtime. */
  bmListingSha256: string | null;
  /** The same over relative paths and sizes only: an mtime-only rewrite (the owner's own daemon) leaves it equal. */
  bmStructureSha256: string | null;
  bmEntries: number;
  listing: string[];
}

function listingOf(root: string, prefix = ""): string[] {
  const lines: string[] = [];
  let entries;
  try {
    entries = readdirSync(join(root, prefix), { withFileTypes: true });
  } catch {
    return lines;
  }
  for (const entry of entries) {
    const path = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    try {
      const stat = statSync(join(root, path), { bigint: true });
      lines.push(`${path}\t${entry.isDirectory() ? "dir" : String(stat.size)}\t${String(stat.mtimeNs)}`);
    } catch {
      lines.push(`${path}\t?\t?`);
    }
    if (entry.isDirectory()) lines.push(...listingOf(root, path));
  }
  return lines;
}

/** Hashes the owner's config and lists (stat only) their data folder. Opens nothing for writing. */
export function fingerprintOwner(homes: { paseo: string; bm: string }): OwnerFingerprint {
  let configSha256: string | null = null;
  try {
    configSha256 = createHash("sha256").update(readFileSync(join(homes.paseo, "config.json"))).digest("hex");
  } catch {
    configSha256 = null;
  }
  const listing = existsSync(homes.bm) ? listingOf(homes.bm).sort() : [];
  const structure = listing.map((line) => line.split("\t").slice(0, 2).join("\t"));
  return {
    configSha256,
    bmListingSha256: existsSync(homes.bm) ? createHash("sha256").update(listing.join("\n")).digest("hex") : null,
    bmStructureSha256: existsSync(homes.bm) ? createHash("sha256").update(structure.join("\n")).digest("hex") : null,
    bmEntries: listing.length,
    listing,
  };
}

/**
 * `identical`: config, paths, sizes and mtimes all equal. `sameContentShape`:
 * config, paths and sizes equal — what is left when only mtimes moved, which
 * the owner's own running daemon does (its stall watcher rewrites
 * `orchestrator/stalls.json` every minute).
 */
export function compareFingerprints(
  before: OwnerFingerprint,
  after: OwnerFingerprint,
): { identical: boolean; sameContentShape: boolean; changed: string[] } {
  const a = new Set(before.listing);
  const b = new Set(after.listing);
  const changed = [...before.listing.filter((line) => !b.has(line)).map((line) => `- ${line}`), ...after.listing.filter((line) => !a.has(line)).map((line) => `+ ${line}`)];
  const sameConfig = before.configSha256 === after.configSha256;
  return {
    identical: sameConfig && before.bmListingSha256 === after.bmListingSha256,
    sameContentShape: sameConfig && before.bmStructureSha256 === after.bmStructureSha256,
    changed,
  };
}

// ── I/O ──────────────────────────────────────────────────────────────────────

/** What the driver uses of the app's `DaemonClient` (`scripts/manual-test/client.mjs`). */
interface DaemonClientLike {
  fetchAgents(options?: unknown): Promise<unknown>;
  sendAgentMessage(agentId: string, text: string, options?: { messageId?: string }): Promise<void>;
  invokePluginRpc(pluginId: string, method: string, input: unknown): Promise<unknown>;
  cancelAgent(agentId: string): Promise<void>;
  close(): Promise<void>;
}

/** This checkout: the folder that has `plugin/paseo-plugin.json` and the manual-test kit, above this file. */
export function findRepoRoot(from: string = dirname(fileURLToPath(import.meta.url))): string {
  for (let dir = resolve(from); ; dir = dirname(dir)) {
    if (existsSync(join(dir, "plugin", "paseo-plugin.json")) && existsSync(join(dir, "scripts", "manual-test", "start-daemon.sh"))) return dir;
    if (dirname(dir) === dir) throw new Error(`cannot find the paseo-bm checkout above ${from}`);
  }
}

interface Io {
  log: (line: string) => void;
}

const stamp = (): string => new Date().toISOString().slice(11, 19);

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseJsonOutput(stdout: string, what: string): Record<string, unknown> {
  try {
    const value = asObject(JSON.parse(stdout));
    if (value !== null) return value;
  } catch {
    // fall through
  }
  throw new Error(`${what}: not a JSON object: ${stdout.slice(0, 300)}`);
}

class Suite {
  readonly #options: SuiteOptions;
  readonly #io: Io;
  readonly #repo: string;
  #work = "";
  #paseoHome = "";
  #bmHome = "";
  #env: NodeJS.ProcessEnv = {};
  #client: DaemonClientLike | null = null;
  #started = false;
  #stopped = false;

  constructor(options: SuiteOptions, io: Io, repo: string) {
    this.#options = options;
    this.#io = io;
    this.#repo = repo;
  }

  get work(): string {
    return this.#work;
  }

  async prepare(): Promise<void> {
    const work = this.#options.work === null ? await mkdtemp(join(tmpdir(), "bm-eval-suite-")) : resolve(this.#options.work);
    await mkdir(work, { recursive: true });
    this.#work = await realpath(work);
    const existing = await readdir(this.#work);
    if (existing.length > 0) throw new SuiteGuardError(`the run folder ${this.#work} is not empty; give a new or empty --work`);
    this.#paseoHome = join(this.#work, "paseo-home");
    this.#bmHome = join(this.#work, "bm-home");
    const owner = ownerHomes(nodeHomedir());
    const realOwner = { paseo: await realOrSame(owner.paseo), bm: await realOrSame(owner.bm) };
    assertIsolatedHomes({ paseoHome: this.#paseoHome, bmHome: this.#bmHome }, owner);
    assertIsolatedHomes({ paseoHome: this.#paseoHome, bmHome: this.#bmHome }, realOwner);
    assertPort(this.#options.port);
    // What env.sh would export: every child process (the paseo CLI, the daemon,
    // the plugin inside it) then targets the isolated daemon and data folder.
    this.#env = {
      ...process.env,
      PASEO_HOME: this.#paseoHome,
      PASEO_BM_HOME: this.#bmHome,
      BM_TEST_WS: `ws://127.0.0.1:${this.#options.port}/ws`,
      BM_TEST_WORK: this.#work,
    };
  }

  /** `paseo <args> --home <isolated> --json`, parsed. */
  async paseo(args: readonly string[], what: string): Promise<Record<string, unknown>> {
    const { stdout } = await run("paseo", [...args, "--home", this.#paseoHome, "--json"], { env: this.#env, cwd: this.#work, maxBuffer: 16 * 1024 * 1024 });
    return parseJsonOutput(stdout, what);
  }

  async startDaemon(): Promise<void> {
    const logPath = join(this.#work, "start-daemon.log");
    const handle = await open(logPath, "w");
    try {
      const code = await new Promise<number | null>((resolvePromise, reject) => {
        const child = spawn("bash", [join(this.#repo, "scripts", "manual-test", "start-daemon.sh"), this.#work, String(this.#options.port)], {
          env: this.#env,
          // A file, not a pipe: the daemon the script starts may keep its
          // stdout open, and a pipe would then never close.
          stdio: ["ignore", handle.fd, handle.fd],
        });
        this.#started = true;
        child.once("error", reject);
        child.once("exit", (exitCode) => resolvePromise(exitCode));
      });
      if (code !== 0) throw new Error(`start-daemon.sh exited ${code}; see ${logPath}`);
    } finally {
      await handle.close();
    }
    const status = await this.paseo(["daemon", "status"], "paseo daemon status");
    assertIsolatedDaemon(status, { paseoHome: this.#paseoHome, port: this.#options.port });
    this.#io.log(`${stamp()} isolated daemon up: ${String(status["listen"])} home ${this.#paseoHome}`);
  }

  /** Stops the isolated daemon with `stop-daemon.sh` (it checks home and port first). Never throws. */
  stopDaemon(): void {
    if (!this.#started || this.#stopped) return;
    this.#stopped = true;
    try {
      const out = execFileSync("bash", [join(this.#repo, "scripts", "manual-test", "stop-daemon.sh"), this.#work], { env: this.#env, encoding: "utf8" });
      this.#io.log(`${stamp()} ${out.trim()}`);
    } catch (error) {
      this.#io.log(`${stamp()} WARNING: stop-daemon.sh failed: ${errorText(error)}; stop it with: scripts/manual-test/stop-daemon.sh ${this.#work}`);
    }
  }

  async connect(): Promise<void> {
    // client.mjs reads BM_TEST_WS and refuses port 6767 itself.
    process.env.BM_TEST_WS = this.#env.BM_TEST_WS;
    const module = (await import(pathToFileURL(join(this.#repo, "scripts", "manual-test", "client.mjs")).href)) as {
      connect: (tag: string) => Promise<DaemonClientLike>;
    };
    this.#client = await module.connect("suite");
  }

  async closeClient(): Promise<void> {
    try {
      await this.#client?.close();
    } catch {
      // closing is best effort
    }
    this.#client = null;
  }

  get client(): DaemonClientLike {
    if (this.#client === null) throw new Error("not connected to the isolated daemon");
    return this.#client;
  }

  rpc(method: string, input: unknown): Promise<unknown> {
    return this.client.invokePluginRpc(PLUGIN_ID, method, input);
  }

  async agents(includeArchived = false): Promise<AgentView[]> {
    const list = asObject(await this.client.fetchAgents({ filter: { includeArchived }, page: { limit: AGENTS_PAGE_LIMIT } })) ?? {};
    const entries = (Array.isArray(list["entries"]) ? list["entries"] : Array.isArray(list["agents"]) ? list["agents"] : []) as unknown[];
    return entries.map(agentViewOf).filter((agent): agent is AgentView => agent !== null);
  }

  async installPlugin(): Promise<void> {
    const source = installSource(this.#options.version, this.#repo);
    const added = await this.paseo(["plugin", "add", source], `paseo plugin add ${source}`);
    let status = typeof added["status"] === "string" ? added["status"] : null;
    const deadline = Date.now() + PLUGIN_START_TIMEOUT_MS;
    while (status !== "running" && Date.now() < deadline) {
      await sleep(3_000);
      const listed = await run("paseo", ["plugin", "ls", "--home", this.#paseoHome, "--json"], { env: this.#env, cwd: this.#work });
      const value: unknown = JSON.parse(listed.stdout);
      const entries = (Array.isArray(value) ? value : (asObject(value)?.["plugins"] ?? [])) as unknown[];
      const mine = entries.map(asObject).find((entry) => entry?.["id"] === PLUGIN_ID);
      status = typeof mine?.["status"] === "string" ? mine["status"] : null;
    }
    if (status !== "running") throw new Error(`the plugin ${source} is not running (status ${String(status)}); see: PASEO_HOME=${this.#paseoHome} paseo plugin logs ${PLUGIN_ID} --home ${this.#paseoHome}`);
    this.#io.log(`${stamp()} plugin ${source}: running`);
  }

  async configure(models: Partial<Record<SuiteRole, RoleModel>>): Promise<void> {
    await this.rpc("setup.ensure-roles", {});
    const settings = asObject(await this.rpc("roles.settings", {})) ?? {};
    const listed = (Array.isArray(settings["roles"]) ? settings["roles"] : []).map((entry) => String(asObject(entry)?.["role"] ?? ""));
    let revision = String(settings["revision"] ?? "");
    for (const role of rolesToSave(listed, this.#options.version, models)) {
      const model = models[role]!;
      const saved = asObject(
        await this.rpc("roles.save-settings", {
          revision,
          role,
          baseProvider: model.baseProvider,
          model: model.model,
          thinkingOptionId: model.thinkingOptionId,
          modeId: model.modeId,
        }),
      );
      revision = String(saved?.["revision"] ?? revision);
      this.#io.log(`${stamp()} role ${role}: ${model.baseProvider} · ${model.model} · thinking ${model.thinkingOptionId ?? "default"} · mode ${model.modeId ?? "default"}`);
    }
    await this.rpc("setup.grant-agent-tools", { confirmed: true });
    this.#io.log(`${stamp()} agent tools granted on the isolated daemon`);
    if (this.#options.version.kind === "tree") {
      const opened = asObject(await this.rpc("orchestrator.open", { confirmed: true }));
      this.#io.log(`${stamp()} Orchestrator ${String(opened?.["agentId"])} (${opened?.["created"] ? "created" : "existing"})`);
      // Its first turn is not any scenario's work: wait it out, so the first
      // run's cost difference starts after it.
      const deadline = Date.now() + ORCHESTRATOR_SETTLE_TIMEOUT_MS;
      while (Date.now() < deadline && (await this.agents()).some((agent) => isOrchestratorAgent(agent) && isBusy(agent))) await sleep(5_000);
    }
  }

  async registerWorkspace(repo: string, title: string): Promise<string> {
    const project = await this.paseo(["project", "create", repo], "paseo project create");
    const projectId = nonEmpty(project["projectId"]);
    if (projectId === null) throw new Error(`paseo project create printed no projectId: ${JSON.stringify(project)}`);
    const workspace = await this.paseo(["workspace", "create", "--isolation", "local", "--path", repo, "--project", projectId, "--title", title], "paseo workspace create");
    const workspaceId = nonEmpty(workspace["workspaceId"]);
    if (workspaceId === null) throw new Error(`paseo workspace create printed no workspaceId: ${JSON.stringify(workspace)}`);
    return workspaceId;
  }

  async managerFor(workspaceId: string): Promise<string> {
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const out = asObject(await this.rpc("manager.ensure", { workspaceId }));
        const agentId = nonEmpty(out?.["agentId"]);
        if (agentId !== null) return agentId;
        lastError = new Error(`manager.ensure returned no agentId: ${JSON.stringify(out)}`);
      } catch (error) {
        lastError = error;
      }
      await sleep(3_000);
    }
    throw new Error(`manager.ensure failed: ${errorText(lastError)}`);
  }

  async runScenario(scenario: Scenario, runNumber: number): Promise<RunScore | null> {
    const id = `${scenario.id}-r${runNumber}`;
    const runDir = join(this.#work, "runs", id);
    await mkdir(runDir, { recursive: true });
    this.#io.log(`${stamp()} ── ${id}: ${scenario.title}`);
    const tree = this.#options.version.kind === "tree";
    const record: Record<string, unknown> = { scenario: scenario.id, run: runNumber, version: versionLabel(this.#options.version) };
    let fixture: BuiltFixture | null = null;
    let owner: SimulatedOwner | null = null;
    let workspaceId: string | null = null;
    let timedOut = false;
    let stoppedReason: string | null = null;
    let costBefore: number | null = null;
    let costAfter: number | null = null;
    try {
      fixture = await buildFixture({ scenario, runDir, tscPath: join(this.#repo, "node_modules", ".bin", "tsc") });
      workspaceId = await this.registerWorkspace(fixture.repo, id.toLowerCase());
      record["workspaceId"] = workspaceId;
      if (tree) costBefore = orchestratorCost(await this.agents(true));
      for (const call of scenarioPolicyCalls(this.#options.version, workspaceId)) await this.rpc(call.method, call.input);
      const managerId = await this.managerFor(workspaceId);
      record["managerId"] = managerId;
      this.#io.log(`${stamp()} workspace ${workspaceId}, Manager ${managerId}`);

      const transport: OwnerTransport = {
        sendToAgent: (agentId, text) => this.client.sendAgentMessage(agentId, text, { messageId: randomUUID() }),
        rpc: (method, input) => this.rpc(method, input),
        now: () => Date.now(),
      };
      owner = new SimulatedOwner({ owner: scenario.owner, channel: channelFor(this.#options.version), transport });

      const startedAt = Date.now();
      const deadline = startedAt + scenario.timeoutMinutes * 60_000;
      record["startedAt"] = new Date(startedAt).toISOString();
      for (const request of scenario.requests) {
        if (request.delaySeconds > 0) await sleep(request.delaySeconds * 1000);
        await this.client.sendAgentMessage(managerId, request.text, { messageId: randomUUID() });
        this.#io.log(`${stamp()} request sent to the Manager (${request.text.length} chars)`);
      }

      const firstSeen = new Map<string, number>();
      let quietPolls = 0;
      for (;;) {
        await sleep(POLL_MS);
        const now = Date.now();
        const watched = runAgents(await this.agents(), { workspaceId, repo: fixture.repo });
        const permissions = pendingPermissionsOf(watched);
        let pendingUnknown = false;
        let step;
        let pending: number;
        if (owner.channel === "decision-rpc") {
          // The Inbox of this build: the run's unsettled decisions. No retired RPC is read.
          let decisions: unknown[] = [];
          try {
            decisions = answerableDecisions(await this.rpc(DECISIONS_LIST_RPC, { scope: "inbox", workspaceId }));
          } catch (error) {
            pendingUnknown = true;
            this.#io.log(`${stamp()} ${DECISIONS_LIST_RPC} failed: ${errorText(error)}`);
          }
          step = await owner.step({ decisions, workspaceId, permissions });
          pending = pendingUnknown ? 1 : decisions.length;
        } else {
          let workerQuestions: OpenWorkerQuestions[] = [];
          try {
            const waiting = legacyChatWaitingRpc.output.parse(await this.rpc(legacyChatWaitingRpc.name, {}));
            workerQuestions = openQuestionsFromWaiting(waiting.waiting, workspaceId, firstSeen, now);
          } catch (error) {
            pendingUnknown = true;
            this.#io.log(`${stamp()} chat.waiting failed: ${errorText(error)}`);
          }
          step = await owner.step({ workerQuestions, permissions });
          pending = pendingUnknown ? 1 : workerQuestions.length;
        }
        const busy = watched.some(isBusy);
        const acted = step.status === "acted" ? ` · owner answered ${step.entries.length}` : "";
        this.#io.log(`${stamp()} ${watched.map((agent) => `${agent.title ?? agent.provider}:${agent.status}`).join(" | ")} · pending ${pending}${acted}`);
        const decision = decideLoop(quietPolls, { busy, pending, owner: step.status }, now, deadline);
        if (decision.kind === "continue") {
          quietPolls = decision.quietPolls;
          continue;
        }
        if (decision.kind === "timeout") {
          timedOut = true;
          stoppedReason = `timed out after ${scenario.timeoutMinutes} minutes`;
          // Stop what still runs in this workspace so it cannot spend or blur the
          // next run; never while a permission request waits (that is the human's).
          if (permissions.length === 0) {
            for (const agent of watched) {
              if (isBusy(agent) && !isOrchestratorAgent(agent)) await this.client.cancelAgent(agent.id).catch(() => undefined);
            }
          }
        } else if (decision.kind === "needed-a-human") {
          stoppedReason = `needed a human: permission request ${permissions.map((p) => `${p.agentId} (${p.title ?? "untitled"})`).join(", ")}`;
        }
        record["endedAt"] = new Date().toISOString();
        record["outcome"] = decision.kind;
        break;
      }
      if (tree) costAfter = orchestratorCost(await this.agents(true));
    } catch (error) {
      stoppedReason = `${DRIVER_ERROR}: ${errorText(error)}`;
      record["error"] = stoppedReason;
      this.#io.log(`${stamp()} ${id}: ${stoppedReason}`);
    }

    record["timedOut"] = timedOut;
    record["stoppedReason"] = stoppedReason;
    record["orchestratorCostUsd"] = { before: costBefore, after: costAfter };
    record["ownerCounts"] = owner?.counts ?? null;
    record["neededHuman"] = owner?.neededHuman ?? null;
    record["ownerLog"] = owner?.log ?? [];
    await writeFile(join(runDir, "run.json"), `${JSON.stringify(record, null, 2)}\n`);
    if (fixture === null) return null;

    const data = await loadRunData({ dataHome: this.#bmHome, repo: fixture.repo, workspaceId });
    const score = await scoreRun({
      scenario,
      fixture,
      run: runNumber,
      data,
      ownerLog: toScoreOwnerLog(owner?.log ?? []),
      suite: {
        ownerActionsPerDecision: owner?.ownerActionsPerDecision() ?? [],
        orchestratorCostUsd: tree && costBefore !== null && costAfter !== null ? Math.max(0, costAfter - costBefore) : null,
      },
      timedOut,
      stoppedReason,
    });
    this.#io.log(`${stamp()} ${id}: correct ${String(score.correct)} · boundary-clean ${String(score.boundaryClean)}${stoppedReason ? ` · ${stoppedReason}` : ""}`);
    return score;
  }

  /** `node .eval-dist/replay.js --home <work>/bm-home --json` into `<work>/replay.json` (the replay is its own bundle entry). */
  async writeReplay(): Promise<string | null> {
    const replay = join(this.#repo, ".eval-dist", "replay.js");
    if (!existsSync(replay) || !existsSync(this.#bmHome)) {
      this.#io.log(`${stamp()} replay skipped: ${existsSync(replay) ? "no data folder" : `${replay} is not built`}`);
      return null;
    }
    try {
      const { stdout } = await run(process.execPath, [replay, "--home", this.#bmHome, "--json"], { cwd: this.#repo, env: this.#env, maxBuffer: 64 * 1024 * 1024 });
      if (stdout.trim() === "") throw new Error("the replay printed nothing");
      const path = join(this.#work, "replay.json");
      await writeFile(path, stdout);
      return path;
    } catch (error) {
      this.#io.log(`${stamp()} replay failed: ${errorText(error)}`);
      return null;
    }
  }
}

async function realOrSame(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return resolve(path);
  }
}

async function loadScenarios(repo: string, only: string[] | null): Promise<Scenario[]> {
  // The bundle lives in .eval-dist/, so the scenario folder is found from the checkout, not from this file.
  const files = await listScenarioFiles(join(repo, "scripts", "eval", "scenarios"));
  const byId = new Map<string, string>(files.map((file) => [file.split("/").pop()!.replace(/\.json$/, ""), file]));
  const ids = only ?? [...byId.keys()];
  const unknown = ids.filter((id) => !byId.has(id));
  if (unknown.length > 0) throw new SuiteUsageError(`unknown scenario(s): ${unknown.join(", ")} (have ${[...byId.keys()].join(", ")})`);
  return Promise.all(ids.map((id) => loadScenario(byId.get(id)!)));
}

function readOwnerConfig(homes: { paseo: string }): unknown {
  try {
    return JSON.parse(readFileSync(join(homes.paseo, "config.json"), "utf8"));
  } catch (error) {
    throw new SuiteGuardError(`cannot read the owner's ${join(homes.paseo, "config.json")} for the role models: ${errorText(error)}`);
  }
}

/** Runs the suite for a command line; returns the exit code (0 done, 1 failed, 2 usage or guard). */
export async function runSuite(argv: readonly string[], io: Io = { log: (line) => console.log(line) }): Promise<number> {
  let options: SuiteOptions | null;
  try {
    options = parseSuiteArgs(argv);
  } catch (error) {
    if (error instanceof SuiteUsageError || error instanceof SuiteGuardError) {
      io.log(`eval:suite: ${error.message}\n${USAGE}`);
      return 2;
    }
    throw error;
  }
  if (options === null) {
    io.log(USAGE);
    return 0;
  }

  const repo = findRepoRoot();
  const owner = ownerHomes(nodeHomedir());
  let scenarios: Scenario[];
  let models: Partial<Record<SuiteRole, RoleModel>>;
  let roleModelSwap: RoleModelSwapRecord | null = null;
  const suite = new Suite(options, io, repo);
  try {
    scenarios = await loadScenarios(repo, options.only);
    models = ownerRoleModels(readOwnerConfig(owner));
    if (options.roleModel !== null) ({ models, record: roleModelSwap } = applyRoleModelSwap(models, options.roleModel));
    rolesToSave(["manager", "worker", "reviewer"], options.version, models);
    await suite.prepare();
  } catch (error) {
    if (error instanceof SuiteUsageError || error instanceof SuiteGuardError) {
      io.log(`eval:suite: ${error.message}`);
      return 2;
    }
    throw error;
  }

  const guardBefore = fingerprintOwner(owner);
  io.log(`${stamp()} run folder ${suite.work} · ${versionLabel(options.version)} · ${scenarios.map((s) => s.id).join(",")} × ${options.runs}`);
  if (roleModelSwap !== null) {
    const from = roleModelSwap.owner === null ? "no owner model" : `${roleModelSwap.owner.baseProvider}/${roleModelSwap.owner.model}`;
    io.log(`${stamp()} experiment: the ${roleModelSwap.role} runs ${roleModelSwap.swapped.baseProvider}/${roleModelSwap.swapped.model} instead of ${from}; every other role is the owner's`);
  }
  const onSignal = (signal: NodeJS.Signals) => {
    io.log(`${stamp()} ${signal}: stopping the isolated daemon`);
    suite.stopDaemon();
    process.exit(130);
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  let code = 0;
  const scored: ScenarioScore[] = [];
  try {
    await suite.startDaemon();
    await suite.connect();
    await suite.installPlugin();
    await suite.configure(models);
    for (const scenario of scenarios) {
      const runs: RunScore[] = [];
      for (let k = 1; k <= options.runs; k += 1) {
        const score = await suite.runScenario(scenario, k);
        if (score === null || (score.stoppedReason ?? "").startsWith(DRIVER_ERROR)) code = 1;
        if (score !== null) runs.push(score);
      }
      if (runs.length === 0) continue;
      // combineRuns compares two runs; with more, the first two decide stability and every run is kept.
      const combined = combineRuns(scenario, runs[0]!, runs[1] ?? null);
      scored.push({ ...combined, runs });
    }
  } catch (error) {
    io.log(`${stamp()} eval:suite failed: ${errorText(error)}`);
    code = 1;
  } finally {
    await suite.closeClient();
    suite.stopDaemon();
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
  }

  if (scored.length > 0) {
    const scorecard = buildScorecard({ pluginVersion: versionLabel(options.version), scenarios: scored, roleModelSwap });
    const path = await writeScorecard(suite.work, scorecard);
    const s = scorecard.summary;
    io.log(`${stamp()} scorecard ${path}: ${s.runs} run(s), ${s.correctRuns} correct, ${s.boundaryCleanRuns} boundary-clean, ${s.unknownRuns} unknown; stable ${s.stable}/${s.scenarios}`);
  } else {
    io.log(`${stamp()} no run was scored; no scorecard written`);
    code = 1;
  }
  const replay = await suite.writeReplay();
  if (replay !== null) io.log(`${stamp()} replay ${replay}`);

  const guardAfter = fingerprintOwner(owner);
  const comparison = compareFingerprints(guardBefore, guardAfter);
  await writeFile(
    join(suite.work, "owner-guard.json"),
    `${JSON.stringify(
      {
        before: { configSha256: guardBefore.configSha256, bmListingSha256: guardBefore.bmListingSha256, bmStructureSha256: guardBefore.bmStructureSha256, bmEntries: guardBefore.bmEntries },
        after: { configSha256: guardAfter.configSha256, bmListingSha256: guardAfter.bmListingSha256, bmStructureSha256: guardAfter.bmStructureSha256, bmEntries: guardAfter.bmEntries },
        identical: comparison.identical,
        sameContentShape: comparison.sameContentShape,
        changed: comparison.changed.slice(0, 200),
      },
      null,
      2,
    )}\n`,
  );
  io.log(
    comparison.identical
      ? `${stamp()} owner guard: ~/.paseo/config.json and ~/.paseo-bm unchanged`
      : comparison.sameContentShape
        ? `${stamp()} owner guard: ~/.paseo/config.json unchanged; ~/.paseo-bm has the same paths and sizes, only mtimes moved (${comparison.changed.length / 2} entr${comparison.changed.length === 2 ? "y" : "ies"}; the owner's own daemon rewrites some files every minute); see ${join(suite.work, "owner-guard.json")}`
        : `${stamp()} WARNING: the owner's ~/.paseo/config.json or ~/.paseo-bm changed during the run (the owner's own daemon may have written it); see ${join(suite.work, "owner-guard.json")}`,
  );
  return code;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runSuite(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error: unknown) => {
      console.error(`eval:suite: ${errorText(error)}`);
      process.exit(1);
    },
  );
}
