/**
 * Role registration — turn three decided roles into three derived providers and
 * three agent profiles inside Paseo's `config.json`
 * (REQ-031(a)(b)(d), Design §3.4, ADR-006 decisions 1, 2, 3, 5, 9).
 *
 * This is the module that makes the three roles visible to the user: the
 * derived providers are what `paseoTools` can be narrowed on, and the agent
 * profiles are what shows up in Paseo's model picker and what the Manager names
 * when it creates a Worker.
 *
 * ## What a derived provider is allowed to contain
 *
 * Exactly three keys: `extends`, `label`, and — for the two roles that get
 * them — `paseoTools`. **No `command`, no `env`** (ADR-006 decision 2). That
 * omission is the product's credential promise expressed as code: a role runs
 * the same binary and the same logged-in session as the provider the user
 * already configured, so paseo-bm never creates a per-role home directory,
 * never copies a token, and never isolates a login. paseo-room does the
 * opposite, and inherits the credential-management duty that comes with it.
 *
 * Adding `command` or `env` here would break that promise silently, which is
 * why {@link roleProviderEntry} builds the object literally rather than
 * spreading anything from the caller.
 *
 * ## Why the Reviewer is different, and how far that goes
 *
 * `paseoTools` is set for `bm-manager` and `bm-worker` and left off entirely for
 * `bm-reviewer` (ADR-006 decision 3). Note what this is *not*: it is not a
 * guarantee. ADR-006 decision 9 records that once the global
 * `daemon.mcp.injectIntoAgents` switch is on — and the install flow turns it on
 * — this per-provider narrowing may have no effect at all. The rule "the
 * Reviewer does not create agents" therefore also has to live in the role
 * instructions (`plugin/roles/reviewer.md`, WP-116), and acceptance has to check
 * on a real daemon whether the Reviewer actually receives agent-management
 * tools. This module contributes the configuration layer and nothing more.
 *
 * ## Writing only our own entries
 *
 * Nothing here writes to the file. Everything is expressed as a
 * {@link ConfigEdit} and handed to {@link applyConfigEdit}, which merges
 * `daemon.agentProfiles` entry by entry and refuses any id outside the `bm-`
 * prefix (ADR-006 decision 5). The array is never replaced: a `room-*` or
 * user-authored entry keeps its position and its bytes. Re-running an install
 * produces the same three entries, so the edit reports no change and no bytes
 * are written at all.
 */

import type { RoleName, RoleRecord } from "../record.js";
import { roleId } from "../record.js";
import type { PaseoAdapter } from "../paseo/adapter.js";
import type { NodeFsApi } from "../fs-guard.js";
import type {
  AgentProfileEntry,
  ApplyConfigEditResult,
  ConfigEdit,
  JsonValue,
} from "../paseo/config.js";
import { applyConfigEdit } from "../paseo/config.js";
import type { RoleSelection } from "./config.js";
import { roleGrantsPaseoTools, toRoleRecord } from "./config.js";

/**
 * The `notes` each agent profile carries. Paseo shows this next to the profile,
 * so it answers the only question a user has in front of a model picker: when
 * would I pick this one?
 *
 * English, like everything else an agent or an agent-facing surface reads
 * (REQ-032a). The Reviewer's note repeats its constraint on purpose — see
 * ADR-006 decision 9.
 */
export const ROLE_PROFILE_NOTES: Readonly<Record<RoleName, string>> = {
  manager:
    "paseo-bm Manager — the agent you talk to. It delegates every request to a Beads Worker " +
    "and reports progress back; it does not do the work itself and never archives or deletes an agent.",
  worker:
    "paseo-bm Worker — does the work in the repository: documents, beads, then implementation, " +
    "spawning a Beads Reviewer after each batch of changes. It never commits and never pushes.",
  reviewer:
    "paseo-bm Reviewer — read-only review of the batch of changes just made. It reports findings " +
    "by severity, does not edit anything, and must never create or stop an agent.",
};

/**
 * One derived provider, exactly as it is written to `agents.providers.<id>`.
 *
 * The absent keys are the point: no `command` and no `env`, so the role reuses
 * the base provider's binary and login session (ADR-006 decision 2). Declared
 * as a type alias rather than an interface so it is assignable to
 * {@link JsonValue}.
 */
export type RoleProviderEntry = {
  /** The user's own provider this role inherits everything from. */
  readonly extends: string;
  /** What Paseo shows for the provider — the role's display name. */
  readonly label: string;
  /** Present only for the roles that are granted Paseo's agent tools. */
  readonly paseoTools?: { readonly enabled: true };
};

/** One agent profile, exactly as it is written into `daemon.agentProfiles[]`. */
export type RoleProfileEntry = AgentProfileEntry & {
  readonly id: string;
  readonly name: string;
  /** Always the derived provider, never the base one. */
  readonly provider: string;
  readonly model: string;
  readonly notes: string;
};

/**
 * The derived provider for one role.
 *
 * `paseoTools` follows {@link roleGrantsPaseoTools} and not
 * `selection.paseoTools`: there is one source of truth for "which roles get
 * agent tools", and it is the function ADR-006 decision 3 is written into.
 * `configureRoles` fills `selection.paseoTools` from that same function, so in
 * practice the two always agree — but if they ever did not, the Reviewer would
 * still come out without the key.
 */
export function roleProviderEntry(selection: RoleSelection): RoleProviderEntry {
  const entry: RoleProviderEntry = {
    extends: selection.provider,
    label: selection.displayName,
  };
  // Omitted, not set to false: ADR-006 says the key is simply not declared for
  // the Reviewer, and an absent key is what an uninstall leaves behind too.
  return roleGrantsPaseoTools(selection.role) ? { ...entry, paseoTools: { enabled: true } } : entry;
}

/**
 * The agent profile for one role.
 *
 * `modeId` and `thinkingOptionId` are deliberately **not** written. Paseo treats
 * them as optional, Phase 1 never asks the user for either, and `toRoleRecord`
 * records them as `null` meaning "not set". Writing an explicit `null` into
 * Paseo's file would claim a choice nobody made.
 */
export function roleProfileEntry(selection: RoleSelection): RoleProfileEntry {
  const id = roleId(selection.role);
  return {
    id,
    name: selection.displayName,
    provider: id,
    model: selection.model,
    notes: ROLE_PROFILE_NOTES[selection.role],
  };
}

/** A caller handed in something that cannot be registered. A programming error. */
export class RoleRegistrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RoleRegistrationError";
  }
}

/**
 * The complete `ConfigEdit` for a set of roles: the derived providers and the
 * agent profiles, and nothing else.
 *
 * It carries no `pluginsEnabled` and no `mcpInject`. Those are a separate
 * consent (ADR-006 decision 4) and belong to the install flow, which is free to
 * merge this edit with them into a single write.
 *
 * Order follows the order of `selections`, which `configureRoles` fixes as
 * manager, worker, reviewer — so a re-run produces a byte-identical edit.
 */
export function roleRegistrationEdit(selections: readonly RoleSelection[]): ConfigEdit {
  const seen = new Set<RoleName>();
  const providers: Record<string, JsonValue> = {};
  const profiles: RoleProfileEntry[] = [];

  for (const selection of selections) {
    if (seen.has(selection.role)) {
      throw new RoleRegistrationError(
        `Role "${selection.role}" was given twice. Each of the three roles maps to exactly one ` +
          `provider and one profile, so registering it twice would silently discard one of them.`,
      );
    }
    seen.add(selection.role);
    providers[roleId(selection.role)] = roleProviderEntry(selection);
    profiles.push(roleProfileEntry(selection));
  }

  return { providers, profiles };
}

export interface RegisterRolesOptions {
  /** Paseo's home, as reported by `paseo daemon status`. */
  readonly paseoHome: string;
  /** paseo-bm's install home; the config backup goes under it. */
  readonly installHome: string;
  /** The decided roles, normally all three, in `ROLE_NAMES` order. */
  readonly selections: readonly RoleSelection[];
  /** Only `daemonReload` is used — paseo-bm never restarts the daemon. */
  readonly adapter: Pick<PaseoAdapter, "daemonReload">;
  /** Filesystem seam; tests inject the guarded one. */
  readonly fs?: NodeFsApi;
  /** Backup directory override, for tests and for a shared install backup. */
  readonly backupDir?: string;
  /** Clock for the default backup stamp. */
  readonly now?: Date;
}

export interface RoleRegistrationResult {
  /** Everything the write path saw: backup, changed paths, reload, verification. */
  readonly config: ApplyConfigEditResult;
  /** The `roles[]` entries for the install record, in the order registered. */
  readonly roles: readonly RoleRecord[];
  /** `agents.providers` ids written, in order. */
  readonly providerIds: readonly string[];
  /** `daemon.agentProfiles[]` ids written, in order. */
  readonly profileIds: readonly string[];
  /**
   * True when the file actually changed. False on a re-run where all six
   * entries already held the right value — no bytes written, no reload.
   */
  readonly changed: boolean;
}

/**
 * Registers the derived providers and the agent profiles, then reports what the
 * install record needs to remember.
 *
 * Idempotent by construction: {@link roleRegistrationEdit} is a pure function of
 * the selections, and `applyConfigEdit` compares entry by entry and writes
 * nothing when every entry already matches.
 */
export async function registerRoles(options: RegisterRolesOptions): Promise<RoleRegistrationResult> {
  const edit = roleRegistrationEdit(options.selections);
  const result = await applyConfigEdit({
    paseoHome: options.paseoHome,
    installHome: options.installHome,
    edit,
    adapter: options.adapter,
    ...(options.fs === undefined ? {} : { fs: options.fs }),
    ...(options.backupDir === undefined ? {} : { backupDir: options.backupDir }),
    ...(options.now === undefined ? {} : { now: options.now }),
  });

  return {
    config: result,
    roles: options.selections.map(toRoleRecord),
    providerIds: Object.keys(edit.providers ?? {}),
    profileIds: (edit.profiles ?? []).map((profile) => profile.id),
    changed: result.written,
  };
}
