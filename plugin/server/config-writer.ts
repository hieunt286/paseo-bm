/**
 * The only path by which the plugin writes Paseo's configuration (delta
 * 20260921 §4.3.4, ADR-008).
 *
 * Paseo's `config.patch` deep-merges `providers` (so one alias can change
 * without touching another) but REPLACES the whole `agentProfiles` array, and
 * carries no revision or condition (proposal S10). So every write here:
 *
 * 1. reads the config and compares its `revision` with the one the caller saw
 *    when it showed the user the settings — different means another writer
 *    (Paseo's Settings, the installer) changed it meanwhile: nothing is written;
 * 2. builds the patch from EXACTLY the array just read, replacing only the
 *    `bm-*` role profile in place (`null` deletes a key, never writes `null`);
 * 3. writes it with ONE `config.patch`;
 * 4. reads it back and checks that the `bm-*` values it wrote are there —
 *    otherwise `E_ROLE_SETTINGS_WRITE_FAILED`; it never writes again, since
 *    that would replace the array once more;
 * 5. runs under one in-process mutex, so two saves never interleave.
 *
 * Residual risk the owner accepted (Q3 a, Q15 a): a change made in the app
 * exactly between steps 1 and 3 is overwritten and CANNOT be reported — the
 * array written back restores it as read, so the read-back looks unchanged.
 * Steps 1 and 3 only narrow that window to one handler's round trip.
 *
 * Scope (ADR-008 D2): provider ids must start with `bm-`; profiles only
 * `bm-manager`, `bm-worker`, `bm-reviewer`, and only when they already exist.
 * Creating one is `createRoleEntries` below — a separate path on purpose, so a
 * settings save can never bring a role into being as a side effect. The SDK
 * view is flat (design F12):
 * `config.providers` is `agents.providers`, `config.agentProfiles` is
 * `daemon.agentProfiles`. Never calls `paseo daemon reload`, never touches the
 * file itself.
 */
import { createHash } from "node:crypto";
import { DashboardError } from "../shared/contracts";

/** The part of Paseo's config the role settings live in. */
export interface RoleConfigView {
  providers?: Record<string, unknown> | null;
  agentProfiles?: ReadonlyArray<Record<string, unknown>> | null;
  /** Paseo's machine-wide agent-tools switch; see `setAgentTools`. */
  mcp?: { injectIntoAgents?: boolean } | null;
}

/** The SDK slice this module uses; `PaseoApi` is structurally assignable. */
export interface ConfigPaseo {
  config: {
    get(): Promise<{ config: RoleConfigView }>;
    patch(patch: Record<string, unknown>): Promise<unknown>;
  };
}

/** The three role profiles the plugin may edit. */
export const ROLE_PROFILE_IDS: readonly string[] = ["bm-manager", "bm-worker", "bm-reviewer"];

const isBmId = (id: string): boolean => id.startsWith("bm-");

/** JSON with object keys sorted at every level, so equal content gives equal text. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) out[key] = sortKeys((value as Record<string, unknown>)[key]);
    return out;
  }
  return value;
}

/**
 * The revision of the role settings: sha256 of the canonical JSON of every
 * `bm-*` provider and the WHOLE profile array (the whole array, because a
 * write replaces it). Shared with `roles.settings`, which hands it to the client.
 */
export function roleConfigRevision(config: RoleConfigView): string {
  const providers: Record<string, unknown> = {};
  const all = config.providers;
  if (all !== null && typeof all === "object" && !Array.isArray(all)) {
    for (const [id, entry] of Object.entries(all)) if (isBmId(id)) providers[id] = entry;
  }
  const profiles = Array.isArray(config.agentProfiles) ? config.agentProfiles : [];
  return createHash("sha256").update(canonicalJson({ providers, profiles })).digest("hex");
}

/** Reads the config and its revision. */
export async function readRoleConfig(paseo: ConfigPaseo): Promise<{ revision: string; config: RoleConfigView }> {
  const { config } = await paseo.config.get();
  return { revision: roleConfigRevision(config ?? {}), config: config ?? {} };
}

/** One write of the role settings. */
export interface RoleConfigWrite {
  /** The revision the caller showed the user. */
  expectedRevision: string;
  /** `bm-*` provider id → the keys to set (deep-merged by the daemon). */
  providers?: Record<string, Record<string, unknown>>;
  /** `bm-*` provider ids to delete. */
  removeProviders?: readonly string[];
  /** Role profile id → the keys to set; `null` deletes the key. */
  profiles?: Record<string, Record<string, unknown>>;
}

export interface RoleConfigWriteResult {
  revision: string;
  config: RoleConfigView;
}

let queue: Promise<unknown> = Promise.resolve();

/** Runs `work` after every write queued before it; a failure does not block the next one. */
function serialised<T>(work: () => Promise<T>): Promise<T> {
  const run = queue.then(work, work);
  queue = run.catch(() => undefined);
  return run;
}

function invalid(detail: string): DashboardError {
  return new DashboardError("E_ROLE_SETTINGS_INVALID", detail);
}

function checkScope(write: RoleConfigWrite, config: RoleConfigView): void {
  const providers = config.providers ?? {};
  for (const id of [...Object.keys(write.providers ?? {}), ...(write.removeProviders ?? [])]) {
    if (!isBmId(id)) throw invalid(`the plugin only writes bm-* providers, not "${id}"`);
  }
  for (const id of Object.keys(write.providers ?? {})) {
    if (ROLE_PROFILE_IDS.includes(id) && !Object.prototype.hasOwnProperty.call(providers, id)) {
      throw invalid(`provider "${id}" is not registered; open Beads Manager → Setup, which creates it`);
    }
  }
  for (const id of write.removeProviders ?? []) {
    if (ROLE_PROFILE_IDS.includes(id)) throw invalid(`provider "${id}" is a main role; only "Remove paseo-bm's settings" on Setup removes it`);
  }
  const profiles = Array.isArray(config.agentProfiles) ? config.agentProfiles : [];
  for (const id of Object.keys(write.profiles ?? {})) {
    if (!ROLE_PROFILE_IDS.includes(id)) throw invalid(`the plugin only edits the bm-manager, bm-worker and bm-reviewer profiles, not "${id}"`);
    if (!profiles.some((entry) => entry?.id === id)) throw invalid(`profile "${id}" is not registered; open Beads Manager → Setup, which creates it`);
  }
}

/** The profile array to write: the one just read, with only the named role profiles changed in place. */
function patchedProfiles(read: ReadonlyArray<Record<string, unknown>>, edits: Record<string, Record<string, unknown>>): Record<string, unknown>[] {
  return read.map((entry) => {
    const id = typeof entry?.id === "string" ? entry.id : null;
    if (id === null || !Object.prototype.hasOwnProperty.call(edits, id)) return entry;
    const next: Record<string, unknown> = { ...entry };
    for (const [key, value] of Object.entries(edits[id]!)) {
      if (value === null || value === undefined) delete next[key];
      else next[key] = value;
    }
    return next;
  });
}

/** True when every key of `wanted` is in `actual` with the same value, objects compared key by key. */
function contains(actual: unknown, wanted: unknown): boolean {
  if (wanted !== null && typeof wanted === "object" && !Array.isArray(wanted)) {
    if (actual === null || typeof actual !== "object" || Array.isArray(actual)) return false;
    return Object.entries(wanted as Record<string, unknown>).every(([key, value]) => contains((actual as Record<string, unknown>)[key], value));
  }
  return canonicalJson(actual) === canonicalJson(wanted);
}

/** What of the write the read-back does not show (Q15 a: the plugin checks its OWN entries). */
function missingFromReadBack(write: RoleConfigWrite, after: RoleConfigView): string[] {
  const missing: string[] = [];
  const providers = after.providers ?? {};
  for (const [id, entry] of Object.entries(write.providers ?? {})) {
    if (!contains((providers as Record<string, unknown>)[id], entry)) missing.push(`provider ${id}`);
  }
  for (const id of write.removeProviders ?? []) {
    if (Object.prototype.hasOwnProperty.call(providers, id)) missing.push(`removal of provider ${id}`);
  }
  const profiles = Array.isArray(after.agentProfiles) ? after.agentProfiles : [];
  for (const [id, edits] of Object.entries(write.profiles ?? {})) {
    const profile = profiles.find((entry) => entry?.id === id);
    const ok =
      profile !== undefined &&
      Object.entries(edits).every(([key, value]) =>
        value === null || value === undefined ? !Object.prototype.hasOwnProperty.call(profile, key) : contains(profile[key], value),
      );
    if (!ok) missing.push(`profile ${id}`);
  }
  return missing;
}

/**
 * Writes the role settings by the five steps above. Throws a coded
 * `DashboardError`: `E_ROLE_SETTINGS_CONFLICT` (revision changed, nothing
 * written), `E_ROLE_SETTINGS_INVALID` (out of scope), `E_ROLE_SETTINGS_WRITE_FAILED`
 * (the daemon refused the patch; it restores its own file on failure, S10).
 */
export function writeRoleConfig(paseo: ConfigPaseo, write: RoleConfigWrite): Promise<RoleConfigWriteResult> {
  return serialised(async () => {
    const { revision, config } = await readRoleConfig(paseo);
    if (revision !== write.expectedRevision) {
      throw new DashboardError("E_ROLE_SETTINGS_CONFLICT", "the configuration changed elsewhere; reopen Roles & models");
    }
    checkScope(write, config);

    const read = Array.isArray(config.agentProfiles) ? config.agentProfiles : [];
    const patch: Record<string, unknown> = {};
    if (write.providers !== undefined && Object.keys(write.providers).length > 0) patch.providers = write.providers;
    if (write.removeProviders !== undefined && write.removeProviders.length > 0) patch.removeProviders = [...write.removeProviders];
    // The array is only ever sent when a role profile changes: every other
    // write leaves `agentProfiles` alone and so cannot overwrite anything.
    if (write.profiles !== undefined && Object.keys(write.profiles).length > 0) patch.agentProfiles = patchedProfiles(read, write.profiles);
    if (Object.keys(patch).length === 0) return { revision, config };

    try {
      await paseo.config.patch(patch);
    } catch (error) {
      throw new DashboardError("E_ROLE_SETTINGS_WRITE_FAILED", error instanceof Error ? error.message : String(error), { cause: error });
    }

    const after = await readRoleConfig(paseo);
    const missing = missingFromReadBack(write, after.config);
    if (missing.length > 0) {
      throw new DashboardError("E_ROLE_SETTINGS_WRITE_FAILED", `Paseo did not keep the saved values (${missing.join(", ")})`);
    }
    return { revision: after.revision, config: after.config };
  });
}

/**
 * Creates the missing main-role entries, and only those (ADR-012 decision 4,
 * design §7.13.2).
 *
 * This is the one path that may bring a `bm-manager`, `bm-worker` or
 * `bm-reviewer` entry into being, and it is deliberately not part of
 * `writeRoleConfig`: a settings save must never create a role as a side effect,
 * and creation carries no `expectedRevision` because nobody showed the user
 * anything to be stale about — it runs when a role is absent, which is a fact
 * about the config, not about a screen.
 *
 * An entry that already exists is never touched, whatever it holds. Paseo's
 * configuration is the source of truth (ADR-008 decision 5): a user who changed
 * the Worker's model or its provider keeps that change.
 */
export interface CreateRoleEntriesResult extends RoleConfigWriteResult {
  /** The role ids created, in the order of `ROLE_PROFILE_IDS`; empty when nothing was missing. */
  created: string[];
}

export function createRoleEntries(
  paseo: ConfigPaseo,
  roles: Readonly<Record<string, { alias: Record<string, unknown>; profile: Record<string, unknown> }>>,
): Promise<CreateRoleEntriesResult> {
  return serialised(async () => {
    const failed = (detail: string, cause?: unknown): DashboardError =>
      new DashboardError("E_SETUP_ROLES_FAILED", detail, cause === undefined ? undefined : { cause });

    for (const id of Object.keys(roles)) {
      if (!ROLE_PROFILE_IDS.includes(id)) throw failed(`"${id}" is not one of the three main roles`);
    }

    // Read inside the lock: what is missing is decided from the config this
    // write is built on, never from a snapshot a caller took earlier.
    const { revision, config } = await readRoleConfig(paseo);
    const providers = (config.providers ?? {}) as Record<string, unknown>;
    const read = Array.isArray(config.agentProfiles) ? config.agentProfiles : [];

    const newProviders: Record<string, Record<string, unknown>> = {};
    const newProfiles: Record<string, unknown>[] = [];
    const created: string[] = [];
    for (const id of ROLE_PROFILE_IDS) {
      const wanted = roles[id];
      if (wanted === undefined) continue;
      const hasAlias = Object.prototype.hasOwnProperty.call(providers, id);
      const hasProfile = read.some((entry) => entry?.id === id);
      if (hasAlias && hasProfile) continue;
      if (!hasAlias) newProviders[id] = wanted.alias;
      // Appended at the end, because `agentProfiles` is replaced whole and the
      // order of everything already there must survive the write.
      if (!hasProfile) newProfiles.push(wanted.profile);
      created.push(id);
    }
    if (created.length === 0) return { revision, config, created };

    const patch: Record<string, unknown> = {};
    if (Object.keys(newProviders).length > 0) patch.providers = newProviders;
    if (newProfiles.length > 0) patch.agentProfiles = [...read, ...newProfiles];

    try {
      await paseo.config.patch(patch);
    } catch (error) {
      throw failed(error instanceof Error ? error.message : String(error), error);
    }

    // Read back: the entries written are there as written, and nothing else in
    // the array moved. A mismatch is reported, never patched over — a second
    // write would replace the array again on top of whatever went wrong.
    const after = await readRoleConfig(paseo);
    const missing = missingFromReadBack({ expectedRevision: revision, providers: newProviders }, after.config);
    const afterProfiles = Array.isArray(after.config.agentProfiles) ? after.config.agentProfiles : [];
    for (const profile of newProfiles) {
      const id = profile.id as string;
      if (!afterProfiles.some((entry) => contains(entry, profile))) missing.push(`profile ${id}`);
    }
    for (const [index, entry] of read.entries()) {
      if (!contains(afterProfiles[index], entry)) missing.push(`profile ${index + 1} of the ones already there`);
    }
    if (missing.length > 0) {
      throw failed(`Paseo did not keep the created roles (${missing.join(", ")})`);
    }
    return { revision: after.revision, config: after.config, created };
  });
}

/**
 * Turns Paseo's machine-wide agent-tools switch on or off
 * (`daemon.mcp.injectIntoAgents`, design §6.1).
 *
 * The only key outside `bm-*` the plugin ever writes, and the reason it takes
 * its own function: the switch gives EVERY agent on the machine the power to
 * create, message and stop other agents, not just paseo-bm's three, so it is
 * only ever reached from a button the user pressed after a warning (§7.13.3)
 * or from the cleanup that puts it back.
 *
 * Same mutex as every other write, so it cannot interleave with a role patch,
 * and the same read-back: Paseo saying yes is not the same as Paseo keeping it.
 */
export function setAgentTools(paseo: ConfigPaseo, value: boolean): Promise<RoleConfigWriteResult> {
  return serialised(async () => {
    const failed = (detail: string, cause?: unknown): DashboardError =>
      new DashboardError("E_SETUP_WRITE_FAILED", detail, cause === undefined ? undefined : { cause });

    try {
      await paseo.config.patch({ mcp: { injectIntoAgents: value } });
    } catch (error) {
      throw failed(error instanceof Error ? error.message : String(error), error);
    }

    const after = await readRoleConfig(paseo);
    if (agentToolsIn(after.config) !== value) {
      throw failed(`Paseo did not keep the agent tools switch (asked for ${value})`);
    }
    return after;
  });
}

/** `daemon.mcp.injectIntoAgents` as the SDK view reports it; a missing key is off. */
export function agentToolsIn(config: RoleConfigView): boolean {
  return (config as { mcp?: { injectIntoAgents?: unknown } }).mcp?.injectIntoAgents === true;
}

export interface RemoveAllResult extends RoleConfigWriteResult {
  removedProviders: string[];
  removedProfiles: string[];
}

/**
 * Removes every `bm-*` entry from Paseo's configuration in one patch
 * (design §7.13.7, ADR-012 decision 6).
 *
 * Paseo has no hook that runs when a plugin is removed, so "uninstall" is a
 * button; this is the write half of it. It takes the whole `bm-*` prefix — the
 * three roles and every fallback alias — because a leftover alias points at a
 * provider the user may later delete, and because a partial removal is the one
 * outcome a person cannot easily finish by hand.
 *
 * `restoreAgentTools` is `null` when Paseo's switch must be left alone: it is
 * only ever set when the setup state says paseo-bm turned it on.
 */
export function removeAllBmEntries(paseo: ConfigPaseo, restoreAgentTools: boolean | null): Promise<RemoveAllResult> {
  return serialised(async () => {
    const failed = (detail: string, cause?: unknown): DashboardError =>
      new DashboardError("E_SETUP_WRITE_FAILED", detail, cause === undefined ? undefined : { cause });

    const { revision, config } = await readRoleConfig(paseo);
    const providers = (config.providers ?? {}) as Record<string, unknown>;
    const read = Array.isArray(config.agentProfiles) ? config.agentProfiles : [];
    const removedProviders = Object.keys(providers).filter(isBmId);
    const removedProfiles = read.map((entry) => (typeof entry?.id === "string" ? entry.id : "")).filter(isBmId);

    const patch: Record<string, unknown> = {};
    if (removedProviders.length > 0) patch.removeProviders = removedProviders;
    // Sent only when there is one to take out: the array is replaced whole, so
    // an unnecessary send is an unnecessary chance to lose someone else's edit.
    if (removedProfiles.length > 0) patch.agentProfiles = read.filter((entry) => !isBmId(String(entry?.id ?? "")));
    if (restoreAgentTools !== null) patch.mcp = { injectIntoAgents: restoreAgentTools };
    if (Object.keys(patch).length === 0) return { revision, config, removedProviders, removedProfiles };

    try {
      await paseo.config.patch(patch);
    } catch (error) {
      throw failed(error instanceof Error ? error.message : String(error), error);
    }

    const after = await readRoleConfig(paseo);
    const left = Object.keys((after.config.providers ?? {}) as Record<string, unknown>).filter(isBmId);
    const leftProfiles = (Array.isArray(after.config.agentProfiles) ? after.config.agentProfiles : [])
      .map((entry) => String(entry?.id ?? ""))
      .filter(isBmId);
    const problems = [...left.map((id) => `provider ${id}`), ...leftProfiles.map((id) => `profile ${id}`)];
    if (restoreAgentTools !== null && agentToolsIn(after.config) !== restoreAgentTools) {
      problems.push(`the agent tools switch (asked for ${restoreAgentTools})`);
    }
    if (problems.length > 0) throw failed(`Paseo kept ${problems.join(", ")}`);
    return { revision: after.revision, config: after.config, removedProviders, removedProfiles };
  });
}
