/**
 * Role configuration — ask for the three roles, validate what the user typed,
 * and turn the result into `roles[]` entries for the install record
 * (REQ-027(a)(d)(e), Design §4.2 · §7 · §9.1, ADR-006 decisions 1 and 2).
 *
 * Nothing here writes anything, and nothing here touches `config.json`:
 * registering the derived providers and the agent profiles is WP-107's job.
 * This module only produces a decision.
 *
 * ## The two validation tiers, and why there are two
 *
 * Design §7 asks for one thing that cannot be done in one place: `--role` must
 * be checked "at argument-parsing time, before preflight and before any write",
 * *and* the provider/model pair must be one that "really exists in the list
 * Paseo returns". The first half needs no daemon; the second half is a daemon
 * round-trip, which is preflight's territory. So the check is split:
 *
 * 1. **Syntax, at parse time** — {@link parseRoleSpecs}, called from
 *    `runCli()` the moment argv has been parsed. It answers "is this
 *    `<role>=<provider>/<model>`, and is the role one of the three?" with no
 *    I/O at all. A failure is a command-line misuse: `E_BAD_ROLE_SPEC`, exit
 *    code 2, zero writes, and the command handler is never entered.
 * 2. **Existence, once a Paseo adapter exists** — {@link validateRoleSpecs},
 *    called by the install flow against {@link ProviderCatalog}. A failure is
 *    `E_PROVIDER_UNAVAILABLE`, still before any write, because the environment
 *    — not the command line — is what is wrong.
 *
 * Tier 1 never needs a daemon, so a typo is rejected instantly even on a
 * machine where Paseo is down. Tier 2 is where "does `codex/gpt-5.6-sol` exist
 * here?" is answered, with a list of what does exist.
 *
 * ## Why the Reviewer is asked its own question
 *
 * Q-020: the Reviewer is asked separately and is never defaulted to whatever
 * the Worker picked, so a user can put the review on a different provider and
 * get a genuinely independent second opinion. That is why
 * {@link configureRoles} asks three times instead of twice, and why the
 * non-interactive fallback derives the Reviewer's default from the catalogue
 * rather than copying the Worker's.
 */

import { diagnostic } from "../errors.js";
import type { UsageError } from "../flags.js";
import { PaseoCliError, parseJsonOutput } from "../paseo/adapter.js";
import type { PaseoInvocation } from "../paseo/adapter.js";
import type { Prompter } from "../prompter.js";
import { ROLE_NAMES, isRoleName, roleId } from "../record.js";
import type { RoleName, RoleRecord } from "../record.js";

/* ------------------------------------------------------------------ *
 * Tier 1 — syntax. No I/O, runs at argument-parsing time.
 * ------------------------------------------------------------------ */

/** The shape `--role` takes, quoted verbatim in every error message. */
export const ROLE_SPEC_SYNTAX = "<role>=<provider>/<model>";

/** Longer than any real `provider/model`; a longer value is a mistake, not a name. */
export const MAX_ROLE_SPEC_LENGTH = 200;

/**
 * Provider ids as Paseo reports them: `claude`, `codex`, `codex-lead`.
 * Deliberately no `/`, because the first `/` is the separator.
 */
const PROVIDER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Model ids are more varied than they look: `gpt-5.6-sol`, but also
 * `claude-opus-4-8[1m]` and `dx-ai-dev/Qwen/Qwen3.6-35B-A3B-FP8`. Brackets and
 * inner slashes are therefore legal, which is why the provider is split off at
 * the **first** `/` and everything after it is the model.
 */
const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/[\]-]*$/;

/** One `--role` value, after it has been taken apart. */
export interface RoleSpec {
  readonly role: RoleName;
  readonly provider: string;
  readonly model: string;
}

export type RoleSpecResult =
  | { readonly ok: true; readonly spec: RoleSpec }
  | { readonly ok: false; readonly error: UsageError };

export type RoleSpecsResult =
  | { readonly ok: true; readonly specs: readonly RoleSpec[] }
  | { readonly ok: false; readonly error: UsageError };

function badSpec(value: string, why: string): UsageError {
  const entry = diagnostic("E_BAD_ROLE_SPEC");
  return {
    code: entry.code,
    message: `--role ${value}: ${why}.`,
    hint: entry.remediation,
  };
}

/** Keep an absurd value out of the error message while still showing the start of it. */
function clip(value: string): string {
  return value.length <= 60 ? value : `${value.slice(0, 57)}...`;
}

/**
 * Take one `--role` value apart. Syntax only: the provider and the model are
 * *shapes* here, not facts — {@link validateRoleSpecs} is what decides whether
 * they exist.
 */
export function parseRoleSpec(value: string): RoleSpecResult {
  const raw = value.trim();
  if (raw.length === 0) {
    return { ok: false, error: badSpec('""', `the value is empty; expected ${ROLE_SPEC_SYNTAX}`) };
  }
  if (raw.length > MAX_ROLE_SPEC_LENGTH) {
    return {
      ok: false,
      error: badSpec(clip(raw), `the value is longer than ${String(MAX_ROLE_SPEC_LENGTH)} characters`),
    };
  }

  const equals = raw.indexOf("=");
  if (equals === -1) {
    return { ok: false, error: badSpec(clip(raw), `there is no "=", so no role is named; expected ${ROLE_SPEC_SYNTAX}`) };
  }

  const role = raw.slice(0, equals);
  const pair = raw.slice(equals + 1);
  if (!isRoleName(role)) {
    return {
      ok: false,
      error: badSpec(clip(raw), `"${role}" is not a role; the roles are ${ROLE_NAMES.join(", ")}`),
    };
  }

  const slash = pair.indexOf("/");
  if (slash === -1) {
    return {
      ok: false,
      error: badSpec(clip(raw), `there is no "/" between the provider and the model; expected ${ROLE_SPEC_SYNTAX}`),
    };
  }

  const provider = pair.slice(0, slash);
  const model = pair.slice(slash + 1);
  if (!PROVIDER_ID_PATTERN.test(provider)) {
    return {
      ok: false,
      error: badSpec(
        clip(raw),
        provider.length === 0
          ? "the provider is empty"
          : `"${clip(provider)}" is not a provider id (letters, digits, ".", "_" and "-")`,
      ),
    };
  }
  if (!MODEL_ID_PATTERN.test(model)) {
    return {
      ok: false,
      error: badSpec(
        clip(raw),
        model.length === 0 ? "the model is empty" : `"${clip(model)}" is not a model id`,
      ),
    };
  }

  return { ok: true, spec: { role, provider, model } };
}

/**
 * Take every `--role` value apart, in the order they were typed.
 *
 * A role given twice is rejected rather than resolved last-wins: `roles[]`
 * holds one entry per role, so two contradictory values for `worker` have no
 * correct answer and guessing one would silently discard a user's intent.
 */
export function parseRoleSpecs(values: readonly string[]): RoleSpecsResult {
  const specs: RoleSpec[] = [];
  const seen = new Set<RoleName>();
  for (const value of values) {
    const parsed = parseRoleSpec(value);
    if (!parsed.ok) {
      return { ok: false, error: parsed.error };
    }
    if (seen.has(parsed.spec.role)) {
      return {
        ok: false,
        error: badSpec(clip(value.trim()), `the role "${parsed.spec.role}" is given more than once`),
      };
    }
    seen.add(parsed.spec.role);
    specs.push(parsed.spec);
  }
  return { ok: true, specs };
}

/** The spec for one role, if `--role` named it. */
export function findRoleSpec(specs: readonly RoleSpec[], role: RoleName): RoleSpec | undefined {
  return specs.find((spec) => spec.role === role);
}

/* ------------------------------------------------------------------ *
 * Tier 2 — existence. Needs Paseo, so it runs after the adapter exists.
 * ------------------------------------------------------------------ */

/** `paseo provider ls --json`. Read-only; safe for `doctor`. */
export const PROVIDER_LIST_ARGV: readonly string[] = ["provider", "ls", "--json"];

/** `paseo provider models <provider> --json`. */
export function providerModelsArgv(providerId: string): readonly string[] {
  return ["provider", "models", providerId, "--json"];
}

/** One model Paseo offers for a provider. */
export interface ModelOption {
  readonly id: string;
  /** Human label, e.g. `GPT-5.6-Sol`; falls back to the id. */
  readonly label: string;
  /** Paseo's own default thinking option, or null when the provider has none. */
  readonly defaultThinkingOptionId: string | null;
}

/** One provider Paseo knows about. */
export interface ProviderSummary {
  readonly id: string;
  readonly label: string;
  /** False when Paseo reports the tool as not installed or not usable here. */
  readonly available: boolean;
}

/** A provider plus its models, for building a catalogue without a daemon. */
export interface ProviderEntry extends ProviderSummary {
  readonly models: readonly ModelOption[];
}

/**
 * What Paseo offers. Models are fetched per provider and cached, because
 * listing models for every provider on the machine would be a dozen extra
 * 15-second CLI calls for a question about two of them.
 */
export interface ProviderCatalog {
  readonly providers: readonly ProviderSummary[];
  models(providerId: string): Promise<readonly ModelOption[]>;
}

/** The slice of the Paseo adapter this module uses. A `PaseoAdapter` satisfies it. */
export interface PaseoRunner {
  run(args: readonly string[]): Promise<PaseoInvocation>;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function unexpected(argv: readonly string[], detail: string): PaseoCliError {
  return new PaseoCliError({
    reason: "unexpected-shape",
    message: `\`paseo ${argv.join(" ")}\` returned something unexpected: ${detail}.`,
    argv,
  });
}

/**
 * `provider ls`: an array, or an object wrapping one under `providers`.
 * Paseo 0.8.0 names the id field `provider`; `id` is accepted too so a rename
 * does not break the installer.
 */
export function parseProviderList(value: unknown, argv: readonly string[]): readonly ProviderSummary[] {
  const entries = Array.isArray(value) ? value : asRecord(value)?.["providers"];
  if (!Array.isArray(entries)) {
    throw unexpected(argv, "the payload is neither an array of providers nor an object with a `providers` array");
  }
  return entries.map((entry) => {
    const record = asRecord(entry);
    if (record === undefined) throw unexpected(argv, "a provider entry is not a JSON object");
    const id = asNonEmptyString(record["provider"]) ?? asNonEmptyString(record["id"]);
    if (id === undefined) throw unexpected(argv, "a provider entry has no string `provider`");
    const status = asNonEmptyString(record["status"]);
    return {
      id,
      label: asNonEmptyString(record["label"]) ?? id,
      // No status at all is treated as usable: refusing a provider because a
      // future Paseo dropped the field would be worse than offering it.
      available: status === undefined || status === "available",
    };
  });
}

/** `provider models <id>`: an array, or an object wrapping one under `models`. */
export function parseModelList(value: unknown, argv: readonly string[]): readonly ModelOption[] {
  const entries = Array.isArray(value) ? value : asRecord(value)?.["models"];
  if (!Array.isArray(entries)) {
    throw unexpected(argv, "the payload is neither an array of models nor an object with a `models` array");
  }
  return entries.map((entry) => {
    const record = asRecord(entry);
    if (record === undefined) throw unexpected(argv, "a model entry is not a JSON object");
    const id = asNonEmptyString(record["id"]) ?? asNonEmptyString(record["model"]);
    if (id === undefined) throw unexpected(argv, "a model entry has no string `id`");
    return {
      id,
      label: asNonEmptyString(record["model"]) ?? id,
      defaultThinkingOptionId: asNonEmptyString(record["defaultThinkingOptionId"]) ?? null,
    };
  });
}

/** Build a catalogue backed by the `paseo` CLI. Read-only calls only. */
export async function loadProviderCatalog(runner: PaseoRunner): Promise<ProviderCatalog> {
  const invocation = await runner.run(PROVIDER_LIST_ARGV);
  const providers = parseProviderList(parseJsonOutput(invocation), invocation.argv);
  const known = new Set(providers.map((provider) => provider.id));
  const cache = new Map<string, readonly ModelOption[]>();

  return {
    providers,
    async models(providerId: string): Promise<readonly ModelOption[]> {
      const cached = cache.get(providerId);
      if (cached !== undefined) {
        return cached;
      }
      // Asking Paseo about a provider it never listed would only produce a
      // confusing CLI error; an unknown provider simply has no models.
      if (!known.has(providerId)) {
        cache.set(providerId, []);
        return [];
      }
      const call = await runner.run(providerModelsArgv(providerId));
      const models = parseModelList(parseJsonOutput(call), call.argv);
      cache.set(providerId, models);
      return models;
    },
  };
}

/** A catalogue held in memory — used by tests and by anything that already has the data. */
export function createStaticCatalog(entries: readonly ProviderEntry[]): ProviderCatalog {
  const models = new Map(entries.map((entry) => [entry.id, entry.models]));
  return {
    providers: entries.map(({ id, label, available }) => ({ id, label, available })),
    models: (providerId: string) => Promise.resolve(models.get(providerId) ?? []),
  };
}

/** One `--role` value that parsed cleanly but names something Paseo does not have. */
export interface RoleSpecUnavailable {
  readonly code: "E_PROVIDER_UNAVAILABLE";
  readonly role: RoleName;
  readonly provider: string;
  readonly model: string;
  /** Which half is missing — the provider itself, or just the model. */
  readonly missing: "provider" | "model";
  readonly message: string;
  readonly remediation: string;
}

export type RoleCatalogCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly errors: readonly RoleSpecUnavailable[] };

/** At most this many ids are listed back to the user; a machine can have dozens. */
const MAX_LISTED = 10;

function listIds(ids: readonly string[]): string {
  const shown = ids.slice(0, MAX_LISTED).join(", ");
  return ids.length > MAX_LISTED ? `${shown}, ... (${String(ids.length)} in total)` : shown;
}

/**
 * Tier 2: check parsed specs against what Paseo actually offers.
 *
 * Every spec is checked, not just the first, so a user who got two of them
 * wrong is told both times instead of once per run.
 */
export async function validateRoleSpecs(
  specs: readonly RoleSpec[],
  catalog: ProviderCatalog,
): Promise<RoleCatalogCheck> {
  const entry = diagnostic("E_PROVIDER_UNAVAILABLE");
  const errors: RoleSpecUnavailable[] = [];

  for (const spec of specs) {
    const provider = catalog.providers.find((candidate) => candidate.id === spec.provider);
    if (provider === undefined) {
      errors.push({
        code: entry.code,
        role: spec.role,
        provider: spec.provider,
        model: spec.model,
        missing: "provider",
        message:
          `--role ${spec.role}=${spec.provider}/${spec.model}: Paseo has no provider "${spec.provider}". ` +
          `Providers here: ${listIds(catalog.providers.map((candidate) => candidate.id))}.`,
        remediation: entry.remediation,
      });
      continue;
    }

    const models = await catalog.models(provider.id);
    if (!models.some((model) => model.id === spec.model)) {
      errors.push({
        code: entry.code,
        role: spec.role,
        provider: spec.provider,
        model: spec.model,
        missing: "model",
        message:
          `--role ${spec.role}=${spec.provider}/${spec.model}: provider "${provider.id}" has no model ` +
          `"${spec.model}". Models here: ${listIds(models.map((model) => model.id))}.`,
        remediation: entry.remediation,
      });
    }
  }

  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

/* ------------------------------------------------------------------ *
 * Tier 3 — the questions, and the decision they produce.
 * ------------------------------------------------------------------ */

/** Default agent names, matching the names used throughout the documentation. */
export const DEFAULT_ROLE_DISPLAY_NAMES: Readonly<Record<RoleName, string>> = {
  manager: "Beads Manager",
  worker: "Beads Worker",
  reviewer: "Beads Reviewer",
};

/** How each role is referred to in a question. */
const ROLE_LABELS: Readonly<Record<RoleName, string>> = {
  manager: "Manager",
  worker: "Worker",
  reviewer: "Reviewer",
};

/**
 * ADR-006 decision 3: `paseoTools` is set for `bm-manager` and `bm-worker` and
 * deliberately not for `bm-reviewer`, so the Reviewer cannot spawn a review of
 * a review. Decision 9 records that this narrowing may be ineffective once the
 * global MCP switch is on, which is why the role instructions repeat the rule.
 */
export function roleGrantsPaseoTools(role: RoleName): boolean {
  return role !== "reviewer";
}

/** Where a role's configuration came from. Carried into the report, not into the record. */
export type RoleSelectionSource = "flag" | "prompt" | "record" | "default";

/** One fully decided role, before it becomes a `RoleRecord`. */
export interface RoleSelection {
  readonly role: RoleName;
  /**
   * The name shown for the agent — the `label` of the derived provider and the
   * `name` of the agent profile (WP-107). It is *not* part of `roles[]`:
   * Design §3.2 gives that array no name field.
   */
  readonly displayName: string;
  /** The user's own provider the derived provider will `extend`. Never a credential. */
  readonly provider: string;
  readonly model: string;
  readonly paseoTools: boolean;
  readonly source: RoleSelectionSource;
}

/** Why a role ended up on a value nobody chose. Never changes an exit code. */
export interface RoleConfigWarning {
  readonly role: RoleName;
  readonly reason: "non-interactive-default" | "recorded-provider-gone";
  readonly message: string;
}

export interface ConfigureRolesOptions {
  /** Specs from `--role`, already through tier 1 and normally through tier 2. */
  readonly specs: readonly RoleSpec[];
  readonly catalog: ProviderCatalog;
  readonly prompter: Prompter;
  /** `roles[]` from an existing install, reused unless `--reconfigure` is set. */
  readonly existing?: readonly RoleRecord[];
  /**
   * The names the roles already carry in Paseo's `config.json` — the `name` of
   * each `bm-<role>` agent profile, or the derived provider's `label`. `roles[]`
   * has no name field (Design §3.2), so this is the only place a name the user
   * chose survives between runs. Used only when a recorded entry is reused;
   * without it that reuse would reset every name to its default (bug bm-lev).
   */
  readonly existingNames?: Readonly<Partial<Record<RoleName, string>>>;
  /** `--reconfigure`: ask the whole configuration again even though it exists. */
  readonly reconfigure?: boolean;
}

export interface RoleConfiguration {
  /** All three roles, always, in `ROLE_NAMES` order. */
  readonly selections: readonly RoleSelection[];
  readonly warnings: readonly RoleConfigWarning[];
  /** Questions actually asked — evidence that a non-interactive run asked none. */
  readonly questionsAsked: number;
}

/** Raised when no role can be configured at all, e.g. Paseo offers no providers. */
export class RoleConfigError extends Error {
  readonly code = "E_PROVIDER_UNAVAILABLE" as const;

  constructor(message: string) {
    super(message);
    this.name = "RoleConfigError";
  }
}

/** The provider suggested first: the first one Paseo reports as usable. */
function defaultProvider(catalog: ProviderCatalog): ProviderSummary {
  const provider = catalog.providers.find((candidate) => candidate.available) ?? catalog.providers[0];
  if (provider === undefined) {
    throw new RoleConfigError(
      "Paseo reports no agent providers, so there is nothing to configure the roles with. " +
        diagnostic("E_PROVIDER_UNAVAILABLE").remediation,
    );
  }
  return provider;
}

async function defaultModel(catalog: ProviderCatalog, providerId: string): Promise<ModelOption> {
  const models = await catalog.models(providerId);
  const model = models[0];
  if (model === undefined) {
    throw new RoleConfigError(
      `Paseo reports no models for provider "${providerId}", so no role can be pointed at it. ` +
        diagnostic("E_PROVIDER_UNAVAILABLE").remediation,
    );
  }
  return model;
}

function providerChoices(catalog: ProviderCatalog): { value: string; label: string; hint?: string }[] {
  return catalog.providers.map((provider) => ({
    value: provider.id,
    label: `${provider.label} (${provider.id})`,
    ...(provider.available ? {} : { hint: "Paseo reports this one as unavailable here" }),
  }));
}

function modelChoices(models: readonly ModelOption[]): { value: string; label: string }[] {
  return models.map((model) => ({ value: model.id, label: `${model.label} (${model.id})` }));
}

/** The extra lines shown with the Reviewer's questions; Q-020 and ADR-006 decision 3. */
const REVIEWER_DETAILS: readonly string[] = [
  "The Reviewer is asked separately on purpose: picking a different provider from the Worker's",
  "gives the review an independent point of view. Nothing here copies the Worker's answer.",
  "The Reviewer is also the one role that is not granted Paseo tools, so it cannot spawn agents.",
];

/**
 * Ask for all three roles and return a complete configuration.
 *
 * Precedence per role: `--role` wins; then an existing record entry, unless
 * `--reconfigure`; then a question; and on a session with no terminal, a
 * catalogue default plus a warning. The last step is the rule that matters —
 * a non-interactive run must never block on a question it cannot ask, so this
 * function touches the prompter only when `prompter.interactive` is true.
 */
export async function configureRoles(options: ConfigureRolesOptions): Promise<RoleConfiguration> {
  const { specs, catalog, prompter } = options;
  const reconfigure = options.reconfigure ?? false;
  const existing = options.existing ?? [];
  const selections: RoleSelection[] = [];
  const warnings: RoleConfigWarning[] = [];
  let questionsAsked = 0;

  for (const role of ROLE_NAMES) {
    const paseoTools = roleGrantsPaseoTools(role);
    const recorded = existing.find((entry) => entry.role === role);
    const recordedIsUsable =
      recorded !== undefined && catalog.providers.some((provider) => provider.id === recorded.baseProvider);
    if (recorded !== undefined && !recordedIsUsable) {
      warnings.push({
        role,
        reason: "recorded-provider-gone",
        message:
          `The recorded provider "${recorded.baseProvider}" for the ${ROLE_LABELS[role]} is not in Paseo's ` +
          "provider list any more, so it is being configured again.",
      });
    }

    // 1. --role decides, and is never second-guessed by a question.
    const spec = findRoleSpec(specs, role);
    if (spec !== undefined) {
      selections.push({
        role,
        displayName: DEFAULT_ROLE_DISPLAY_NAMES[role],
        provider: spec.provider,
        model: spec.model,
        paseoTools,
        source: "flag",
      });
      continue;
    }

    // 2. What the last install recorded, unless the user asked to redo it.
    if (recorded !== undefined && recordedIsUsable && !reconfigure) {
      // Taken verbatim, not trimmed: any change would differ from config.json
      // and turn a no-op re-run into a rewrite.
      const existingName = options.existingNames?.[role];
      selections.push({
        role,
        displayName:
          existingName === undefined || existingName.trim().length === 0
            ? DEFAULT_ROLE_DISPLAY_NAMES[role]
            : existingName,
        provider: recorded.baseProvider,
        model: recorded.model,
        paseoTools,
        source: "record",
      });
      continue;
    }

    const suggestedProvider =
      recorded !== undefined && recordedIsUsable ? recorded.baseProvider : defaultProvider(catalog).id;

    // 3. No terminal: take a default and say so. Never hang on a question
    //    that cannot be answered (REQ-027e, Design §4.2).
    if (!prompter.interactive) {
      const model =
        recorded !== undefined && recordedIsUsable
          ? recorded.model
          : (await defaultModel(catalog, suggestedProvider)).id;
      selections.push({
        role,
        displayName: DEFAULT_ROLE_DISPLAY_NAMES[role],
        provider: suggestedProvider,
        model,
        paseoTools,
        source: "default",
      });
      warnings.push({
        role,
        reason: "non-interactive-default",
        message:
          `No terminal to ask on and no --role for the ${ROLE_LABELS[role]}, so it defaults to ` +
          `${suggestedProvider}/${model}. Pass --role ${role}=<provider>/<model> to choose.`,
      });
      continue;
    }

    // 4. Ask. Name, provider, model — one question each, per role.
    const details = role === "reviewer" ? REVIEWER_DETAILS : undefined;
    const displayName = await prompter.input({
      message: `Name for the ${ROLE_LABELS[role]} agent`,
      defaultValue: DEFAULT_ROLE_DISPLAY_NAMES[role],
      ...(details === undefined ? {} : { details }),
    });
    questionsAsked += 1;

    const provider = await prompter.select<string>({
      message: `Provider for the ${ROLE_LABELS[role]}`,
      choices: providerChoices(catalog),
      defaultValue: suggestedProvider,
    });
    questionsAsked += 1;

    const models = await catalog.models(provider);
    if (models.length === 0) {
      throw new RoleConfigError(
        `Paseo reports no models for provider "${provider}", so the ${ROLE_LABELS[role]} cannot use it. ` +
          diagnostic("E_PROVIDER_UNAVAILABLE").remediation,
      );
    }
    const recordedModelFits =
      recorded !== undefined && recorded.baseProvider === provider && models.some((m) => m.id === recorded.model);
    const model = await prompter.select<string>({
      message: `Model for the ${ROLE_LABELS[role]} (${provider})`,
      choices: modelChoices(models),
      defaultValue: recordedModelFits ? recorded.model : (models[0] as ModelOption).id,
    });
    questionsAsked += 1;

    selections.push({
      role,
      displayName: displayName.trim().length === 0 ? DEFAULT_ROLE_DISPLAY_NAMES[role] : displayName.trim(),
      provider,
      model,
      paseoTools,
      source: "prompt",
    });
  }

  return { selections, warnings, questionsAsked };
}

/**
 * Turn a decision into a `roles[]` entry.
 *
 * `providerId` and `profileId` are both `bm-<role>` (ADR-006 decision 1), and
 * `modeId` / `thinkingOptionId` stay null: Phase 1 never picks a mode or a
 * thinking option for the user, so "not set" is the honest value.
 */
export function toRoleRecord(selection: RoleSelection): RoleRecord {
  return {
    role: selection.role,
    providerId: roleId(selection.role),
    profileId: roleId(selection.role),
    baseProvider: selection.provider,
    model: selection.model,
    modeId: null,
    thinkingOptionId: null,
    paseoTools: selection.paseoTools,
  };
}

/** Every decided role as `roles[]`, in `ROLE_NAMES` order. */
export function toRoleRecords(configuration: RoleConfiguration): readonly RoleRecord[] {
  return configuration.selections.map(toRoleRecord);
}
