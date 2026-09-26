/**
 * Fallback chains: what the user saves for a role that hits its plan limit
 * (delta 20260921 §4.4.1–§4.4.3, REQ-065 f; ADR-008 D2, D4).
 *
 * A chain has a policy (`ask` shows a card, `off` does nothing, `auto` decides
 * at once by the card's rules — phase 2a-18, §4.6) and 0–3 entries. It lives
 * in two places, on purpose:
 *
 * - entry `n` runs on the alias `bm-<role>-fallback-<n>` in Paseo's config,
 *   so the `agent.create` hook recognises the role (`roleOfProvider`). Written
 *   through `config-writer.ts`, so the same `revision` guards it as a role save;
 * - the entry's model, thinking and mode, and the policy, live in the user's
 *   own file `<data folder>/role-fallback.json`: user data like
 *   `role-extras.json` (F9) — mode 0600, temp file then rename, symlink
 *   refused, no hash in `install.json`, never touched by an update, `--prune`
 *   or uninstall.
 *
 * Aliases are written first, then the file. A file write that fails after the
 * aliases is reported; the alias left behind is harmless (no entry uses it)
 * and the next save cleans it up. A file that does not parse is never
 * overwritten: the save is refused until the user fixes or deletes it, so a
 * hand-edited `patterns` block is never lost.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { unusableDataHomeMessage } from "./data-home";
import { canonicalJson, readRoleConfig, writeRoleConfig, type ConfigPaseo } from "./config-writer";
import { TRACES_DIR_NAME } from "./data-home";
import { costOf } from "./model-costs";
import { asRecord, availableProviders, checkRoleChoice, nonEmpty, reasonOf } from "./role-choices";
import { dataHomeOf } from "./role-extras";
import { capabilityOf, modesFor, type ProviderCapability } from "./role-mode";
import { writeStoreFileAtomically } from "./trace-store";
import { FALLBACK_ROLES, MAX_FALLBACK_ENTRIES, fallbackAlias, fallbackAliasOf, type FallbackRole } from "../shared/fallback";
import {
  DashboardError,
  fallbackEntryInputSchema,
  type BmRole,
  type FallbackEntryInput,
  type FallbackSettings,
  type RolesSaveFallbackInput,
} from "../shared/contracts";

export const ROLE_FALLBACK_FILE = "role-fallback.json";

const chainSchema = z.object({
  policy: z.enum(["ask", "off", "auto"]),
  entries: z.array(fallbackEntryInputSchema).max(MAX_FALLBACK_ENTRIES),
});

/** `role-fallback.json` (§4.4.2). `patterns` is edited by hand only and shared by every role. */
export const roleFallbackFileSchema = z.object({
  version: z.literal(1),
  roles: z
    .object({ manager: chainSchema.optional(), worker: chainSchema.optional(), reviewer: chainSchema.optional() })
    .default({}),
  patterns: z
    .object({
      L1: z.array(z.string()).optional(),
      L2: z.array(z.string()).optional(),
      L3: z.array(z.string()).optional(),
      L4: z.array(z.string()).optional(),
      L5: z.array(z.string()).optional(),
    })
    .optional(),
});

export type RoleFallbackFile = z.infer<typeof roleFallbackFileSchema>;
export type FallbackChain = z.infer<typeof chainSchema>;

/** A role the file does not mention: ask, with no entry (the card still offers Wait and "I'll handle it"). */
export const DEFAULT_CHAIN: FallbackChain = { policy: "ask", entries: [] };

const ROLE_LABELS: Readonly<Record<BmRole, string>> = { manager: "Manager", worker: "Worker", reviewer: "Reviewer" };

const defaultLog = (message: string): void => console.warn(message);

export interface RoleFallbackRead {
  /** The file as parsed, or the defaults when it is missing or invalid. */
  file: RoleFallbackFile;
  /** The JSON object as read, so a save keeps every key it does not own; `null` without a valid file. */
  raw: Record<string, unknown> | null;
  /** Why the file could not be used; `null` when it is valid or simply missing. */
  error: string | null;
}

const emptyFile = (): RoleFallbackFile => ({ version: 1, roles: {} });

/** Reads `role-fallback.json` in `home`. Never throws: an invalid file costs one log line and reads as the defaults. */
export function readRoleFallback(home: string, log: (message: string) => void = defaultLog): RoleFallbackRead {
  const path = join(home, ROLE_FALLBACK_FILE);
  const invalid = (reason: string): RoleFallbackRead => {
    log(`[paseo-bm] ${path} is not usable (${reason}); fallback chains use the defaults until it is fixed or deleted.`);
    return { file: emptyFile(), raw: null, error: reason };
  };
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return { file: emptyFile(), raw: null, error: null };
    return invalid(reasonOf(error));
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return invalid(`not JSON: ${reasonOf(error)}`);
  }
  const result = roleFallbackFileSchema.safeParse(parsed);
  if (!result.success) {
    const issue = result.error.issues[0];
    return invalid(issue === undefined ? "unexpected content" : `${issue.path.join(".") || "(root)"}: ${issue.message}`);
  }
  return { file: result.data, raw: asRecord(parsed), error: null };
}

/** A role's chain in the file, or the defaults. */
export function chainOf(file: RoleFallbackFile, role: BmRole): FallbackChain {
  const chain = file.roles[role];
  return chain === undefined ? { ...DEFAULT_CHAIN, entries: [] } : chain;
}

/** True when the file carries at least one detection pattern of its own. */
function patternsFromFile(file: RoleFallbackFile): boolean {
  return Object.values(file.patterns ?? {}).some((list) => Array.isArray(list) && list.length > 0);
}

/** Writes the file: atomic, 0600, no symlink on the way. Throws `E_ROLE_SETTINGS_WRITE_FAILED`. */
function writeRoleFallback(home: string, body: Record<string, unknown>): void {
  try {
    writeStoreFileAtomically({ tracesDir: join(home, TRACES_DIR_NAME) }, join(home, ROLE_FALLBACK_FILE), `${JSON.stringify(body, null, 2)}\n`);
  } catch (error) {
    throw new DashboardError("E_ROLE_SETTINGS_WRITE_FAILED", `could not write ${ROLE_FALLBACK_FILE}: ${reasonOf(error)}`, { cause: error });
  }
}

/**
 * A chain as Roles & models shows it: each entry with its alias, the
 * capability of its provider and its listed price. Lookups that fail give
 * `unknown` / `null` and one log line; never throws.
 */
export async function fallbackSettingsOf(
  role: BmRole,
  chain: FallbackChain,
  fromFile: boolean,
  paseo: unknown,
  log: (message: string) => void = defaultLog,
): Promise<FallbackSettings> {
  const capabilities = new Map<string, Promise<ProviderCapability>>();
  const capabilityFor = (provider: string): Promise<ProviderCapability> => {
    let known = capabilities.get(provider);
    if (known === undefined) {
      known = modesFor(paseo, provider, log).then(capabilityOf, () => "unknown" as const);
      capabilities.set(provider, known);
    }
    return known;
  };
  const entries = await Promise.all(
    chain.entries.map(async (entry, index) => ({
      position: index + 1,
      alias: fallbackAlias(role, index + 1),
      baseProvider: entry.baseProvider,
      model: entry.model,
      thinkingOptionId: entry.thinkingOptionId,
      modeId: entry.modeId,
      capability: await capabilityFor(entry.baseProvider),
      cost: await costOf(paseo, entry.baseProvider, entry.model, log).catch(() => null),
    })),
  );
  return { role, policy: chain.policy, entries, patternsFromFile: fromFile };
}

export interface FallbackDeps {
  log?: (message: string) => void;
  /** Home directory for locating the data folder (tests pass a temporary one). */
  homedir?: () => string;
  /** The data folder itself, when the caller already knows it (`null`: none); otherwise it is looked up. */
  home?: string | null;
}

/** The data folder, or `null` when it is unknown. Never throws. */
function homeOf(deps: FallbackDeps): string | null {
  if (deps.home !== undefined) return deps.home;
  return dataHomeOf(deps.homedir === undefined ? {} : { homedir: deps.homedir });
}

/**
 * The `fallback` of `roles.settings`: the chain of every role in
 * `FALLBACK_ROLES`, or `null` when none is offered. A data folder that cannot
 * be used reads as the defaults (a save then reports it); an invalid file adds
 * one warning.
 */
export async function fallbackForSettings(
  paseo: unknown,
  deps: FallbackDeps = {},
): Promise<{ fallback: Partial<Record<FallbackRole, FallbackSettings>> | null; warnings: string[] }> {
  if (FALLBACK_ROLES.length === 0) return { fallback: null, warnings: [] };
  const log = deps.log ?? defaultLog;
  const home = homeOf(deps);
  const read = home === null ? { file: emptyFile(), raw: null, error: null } : readRoleFallback(home, log);
  const warnings =
    read.error === null ? [] : [`${ROLE_FALLBACK_FILE} is not valid (${read.error}); fallback uses the defaults until you fix or delete it.`];
  const fromFile = patternsFromFile(read.file);
  const fallback: Partial<Record<FallbackRole, FallbackSettings>> = {};
  for (const role of FALLBACK_ROLES) fallback[role] = await fallbackSettingsOf(role, chainOf(read.file, role), fromFile, paseo, log);
  return { fallback, warnings };
}

let queue: Promise<unknown> = Promise.resolve();

/** Runs `work` after every save queued before it; a failure does not block the next one. */
function serialised<T>(work: () => Promise<T>): Promise<T> {
  const run = queue.then(work, work);
  queue = run.catch(() => undefined);
  return run;
}

/** The alias entry of fallback `n` of `role` (§4.4.1): a Reviewer alias never gets Paseo tools (ADR-006 D3). */
export function fallbackAliasEntry(role: BmRole, n: number, baseProvider: string): Record<string, unknown> {
  return {
    extends: baseProvider,
    label: `${ROLE_LABELS[role]} (fallback ${n})`,
    ...(role === "reviewer" ? {} : { paseoTools: { enabled: true } }),
  };
}

/** True when `existing` already holds every key of `wanted` with the same value. */
function holds(existing: unknown, wanted: Record<string, unknown>): boolean {
  const entry = asRecord(existing);
  return entry !== null && Object.entries(wanted).every(([key, value]) => canonicalJson(entry[key]) === canonicalJson(value));
}

/**
 * Handler body of `roles.save-fallback` (§4.4.3). Runs every check before any
 * write (`E_ROLE_SETTINGS_INVALID`): the role's chain is offered; the policy
 * is `ask`, `off` or `auto` (§4.6); at most three entries; each entry passes the checks of a
 * role save (the Reviewer's mode rule included); no two entries with the same
 * provider and model; no entry equal to the role's own provider and model.
 * Then the aliases (revision-checked, `E_ROLE_SETTINGS_CONFLICT` on a stale
 * one) and the file. An entry on the role's own base provider is warned about,
 * never refused.
 */
export function handleRolesSaveFallback(
  input: RolesSaveFallbackInput,
  paseo: unknown,
  deps: FallbackDeps = {},
): Promise<{ revision: string; fallback: FallbackSettings; warnings: string[] }> {
  return serialised(async () => {
    const log = deps.log ?? defaultLog;
    const invalid = (detail: string) => new DashboardError("E_ROLE_SETTINGS_INVALID", detail);
    const role = input.role;
    if (!(FALLBACK_ROLES as readonly string[]).includes(role)) {
      throw invalid(`fallback chains are not offered for the ${ROLE_LABELS[role] ?? String(role)} in this release`);
    }
    if (input.policy !== "ask" && input.policy !== "off" && input.policy !== "auto") throw invalid(`policy "${String(input.policy)}" is not a fallback policy`);
    const entries: FallbackEntryInput[] = Array.isArray(input.entries) ? input.entries : [];
    if (entries.length > MAX_FALLBACK_ENTRIES) throw invalid(`at most ${MAX_FALLBACK_ENTRIES} fallbacks per role, got ${entries.length}`);

    const available = await availableProviders(paseo);
    for (const entry of entries) await checkRoleChoice(role, entry, paseo, log, available);
    const seen = new Set<string>();
    for (const [index, entry] of entries.entries()) {
      const key = JSON.stringify([entry.baseProvider, entry.model]);
      if (seen.has(key)) throw invalid(`fallback ${index + 1} repeats ${entry.baseProvider} · ${entry.model}`);
      seen.add(key);
    }

    const { config } = await readRoleConfig(paseo as ConfigPaseo);
    const providers = asRecord(config.providers) ?? {};
    const mainId = `bm-${role}`;
    const mainBase = nonEmpty(asRecord(providers[mainId])?.["extends"]);
    const mainProfile = (Array.isArray(config.agentProfiles) ? config.agentProfiles : []).find((profile) => profile?.["id"] === mainId);
    const mainModel = nonEmpty(mainProfile?.["model"]);
    const warnings: string[] = [];
    for (const [index, entry] of entries.entries()) {
      if (entry.baseProvider !== mainBase) continue;
      if (entry.model === mainModel) throw invalid(`fallback ${index + 1} is the ${ROLE_LABELS[role]} itself (${entry.baseProvider} · ${entry.model})`);
      warnings.push(`Fallback ${index + 1} runs on ${entry.baseProvider} like the ${ROLE_LABELS[role]} itself: it only helps when the limit is per model.`);
    }

    const home = homeOf(deps);
    if (home === null) {
      throw new DashboardError("E_ROLE_SETTINGS_WRITE_FAILED", `${unusableDataHomeMessage()}; see Setup`);
    }
    const read = readRoleFallback(home, log);
    if (read.error !== null) throw invalid(`${ROLE_FALLBACK_FILE} is not valid (${read.error}); fix or delete it, then save again`);

    // Entry n on alias n, renumbered so n stays contiguous; aliases past the
    // new chain are removed. Only what differs is sent.
    const aliasWrites: Record<string, Record<string, unknown>> = {};
    for (const [index, entry] of entries.entries()) {
      const alias = fallbackAlias(role, index + 1);
      const wanted = fallbackAliasEntry(role, index + 1, entry.baseProvider);
      if (!holds(providers[alias], wanted)) aliasWrites[alias] = wanted;
    }
    const removals = Object.keys(providers).filter((id) => {
      const found = fallbackAliasOf(id);
      return found !== null && found.role === role && found.position > entries.length;
    });
    const written = await writeRoleConfig(paseo as ConfigPaseo, {
      expectedRevision: input.revision,
      providers: aliasWrites,
      removeProviders: removals,
    });

    const chain: FallbackChain = {
      policy: input.policy,
      entries: entries.map((entry) => ({
        baseProvider: entry.baseProvider,
        model: entry.model,
        thinkingOptionId: entry.thinkingOptionId,
        modeId: entry.modeId,
      })),
    };
    const raw = read.raw ?? {};
    writeRoleFallback(home, { ...raw, version: 1, roles: { ...(asRecord(raw["roles"]) ?? {}), [role]: chain } });

    const fallback = await fallbackSettingsOf(role, chain, patternsFromFile(read.file), paseo, log);
    return { revision: written.revision, fallback, warnings };
  });
}
