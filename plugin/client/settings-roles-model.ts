/**
 * What Settings → Agents shows and saves about the roles: "Roles & models"
 * (delta 20260921 §4.3.1) — each role's provider, model, thinking and mode, and
 * its Edit form — with the fallback chains under a role (§4.4.3), and the
 * line that says when the Reviewer shares the Worker's model family (autonomy
 * design §C.5), without a renderer. The machine's set-up (tools, skills, agent tools, sign-in, data
 * folder, cleanup) is in `settings-machine-model.ts`.
 *
 * Pure: no React, no React Native, no `server/` import.
 */
import type {
  BmRole,
  FallbackEntryInput,
  FallbackSettings,
  RoleModelOption,
  RoleSetting,
  RolesOptions,
  RolesSaveFallbackInput,
  RolesSaveSettingsInput,
  RolesSettings,
  SetupRoleWithOrchestrator,
} from "../shared/contracts";
import { MAX_FALLBACK_ENTRIES } from "../shared/fallback";
import { modelFamily } from "../shared/model-family";
import type { Badge, RoleMarkKind } from "./tone";
import { errorMessageOf } from "./errors";

/** Every role Settings → Agents shows a card for, the Orchestrator included (orchestrator design §3.1). */
export type SetupRole = SetupRoleWithOrchestrator;

export const SETUP_ROLES: ReadonlyArray<{ role: SetupRole; label: string; mark: RoleMarkKind }> = [
  { role: "manager", label: "Manager", mark: "request" },
  { role: "worker", label: "Worker", mark: "worker" },
  { role: "reviewer", label: "Reviewer", mark: "reviewer" },
  { role: "orchestrator", label: "Orchestrator", mark: "orchestrator" },
];

// ---------------------------------------------------------------------------
// Roles & models (delta 20260921 §4.3.1, REQ-064 a/d, REQ-063 h).
// ---------------------------------------------------------------------------

/** Shown under the Roles & models rows at all times. */
export const ROLES_APPLY_NOTICE = "Changes apply to agents created after you save. Running agents keep their model and thinking.";

// ---------------------------------------------------------------------------
// A role's instructions, read only (design §7.12 `roles.instructions`, base PRD REQ-032 d).
// ---------------------------------------------------------------------------

/** The row button that opens and closes a role's instructions. */
export function instructionsButtonLabel(open: boolean): string {
  return open ? "Hide instructions" : "Instructions";
}

/**
 * Above a role's instructions: what the text holds for this role, and what a
 * creation adds to it (`runtimeFactsText`): a project's own precedents for the
 * Manager and the Worker, and for the Worker and the Reviewer a line on the
 * project's action boundary when its provider has one (`boundaryPostureOf`).
 */
export function instructionsNote(role: SetupRole, label: string): string {
  const parts =
    role === "manager"
      ? "its role instructions, its runtime facts and your global precedents. Created in a project, it also gets that project's precedents"
      : role === "worker"
        ? "its role instructions, its runtime facts and your global precedents. Created in a project, it also gets that project's precedents and may get a line on its action boundary"
        : role === "reviewer"
          ? "its role instructions. Created in a project, it may also get a line on its action boundary"
          : "its role instructions";
  return `What a new ${label} is created with now: ${parts}. Running agents keep the instructions they started with.`;
}

/** What a save refused with `E_ROLE_SETTINGS_CONFLICT` says, word for word. */
export const ROLES_CONFLICT_MESSAGE = "The configuration changed elsewhere; reopen Roles & models.";

/** Display names of the base providers paseo-bm documents; any other id is shown as it is. */
const PROVIDER_LABELS: ReadonlyMap<string, string> = new Map([
  ["claude", "Claude"],
  ["codex", "Codex"],
  ["opencode", "OpenCode"],
  ["pi", "Pi"],
]);

export function providerLabel(provider: string): string {
  return PROVIDER_LABELS.get(provider) ?? provider;
}

const isRoleAlias = (provider: string): boolean => /^bm-/i.test(provider.trim());

/** The options of a role's base provider, or `undefined` when they are for another provider (or not loaded). */
function optionsFor(provider: string | null, options: RolesOptions | undefined): RolesOptions | undefined {
  return provider !== null && options?.provider === provider ? options : undefined;
}

/**
 * One role row: `<provider> · <model> · thinking <id | provider default> · mode <label>`.
 * Labels come from `roles.options` of the role's base provider when it is
 * loaded, ids otherwise; the mode part is left out when no mode is set.
 */
export function roleSettingText(setting: RoleSetting, options?: RolesOptions): string {
  const listed = optionsFor(setting.baseProvider, options);
  const model = setting.model === null ? "model not set" : (listed?.models.find((entry) => entry.id === setting.model)?.label ?? setting.model);
  const parts = [
    setting.baseProvider === null ? "provider not set" : providerLabel(setting.baseProvider),
    model,
    `thinking ${setting.thinkingOptionId ?? "provider default"}`,
  ];
  if (setting.modeId !== null) {
    parts.push(`mode ${listed?.modes.find((entry) => entry.id === setting.modeId)?.label ?? setting.modeId}`);
  }
  return parts.join(" · ");
}

/**
 * The distinct base providers of the roles, then of their fallback entries,
 * whose `roles.options` label the rows; never a `bm-*` alias.
 */
export function rowOptionProviders(settings: RolesSettings): string[] {
  const out: string[] = [];
  const add = (provider: string | null) => {
    if (provider !== null && !isRoleAlias(provider) && !out.includes(provider)) out.push(provider);
  };
  for (const setting of settings.roles) add(setting.baseProvider);
  for (const chain of fallbackBlocks(settings)) for (const entry of chain.entries) add(entry.baseProvider);
  return out;
}

export interface RoleRow {
  role: SetupRole;
  label: string;
  mark: RoleMarkKind;
  setting: RoleSetting;
  text: string;
  /** The role's fallback chain, drawn under the row; `null`: no fallback block and no "Add fallback" button. */
  fallback: FallbackSettings | null;
}

/**
 * The rows of the section, one per role, in the order `roles.settings`
 * returned them. The Orchestrator's row has no fallback chain (orchestrator
 * design §3.1), whatever the server sends.
 */
export function roleRows(settings: RolesSettings, optionsOf: (provider: string) => RolesOptions | undefined): RoleRow[] {
  const chains = fallbackBlocks(settings);
  return settings.roles.map((setting) => {
    const known = SETUP_ROLES.find((entry) => entry.role === setting.role);
    const options = setting.baseProvider === null ? undefined : optionsOf(setting.baseProvider);
    return {
      role: setting.role,
      label: known?.label ?? setting.role,
      mark: known?.mark ?? "worker",
      setting,
      text: roleSettingText(setting, options),
      fallback: chains.find((chain) => chain.role === setting.role) ?? null,
    };
  });
}

/** Under the Reviewer's row when it runs on the Worker's model family (autonomy design §C.5, REQ-133). */
export const SAME_FAMILY_NOTICE = "The Reviewer runs on the same model family as the Worker, so its review is less independent.";

/**
 * `SAME_FAMILY_NOTICE`, in the warning tone, when the Reviewer's family
 * (`modelFamily`: the model's vendor, §C.6) is the Worker's; `null` when they
 * differ, or when either role or either family is unknown.
 */
export function reviewerFamilyNote(settings: RolesSettings): Badge | null {
  const familyOf = (role: SetupRole): string | null => {
    const setting = settings.roles.find((entry) => entry.role === role);
    return setting === undefined ? null : modelFamily(setting.baseProvider, setting.model);
  };
  const worker = familyOf("worker");
  return worker !== null && worker === familyOf("reviewer") ? { text: SAME_FAMILY_NOTICE, tone: "warning" } : null;
}

/** The providers whose Workers and Reviewers the action boundary can hold (autonomy design §D.2; `server/role-mode.ts` `BOUNDARY_MODES`). */
export const BOUNDARY_BASE_PROVIDERS: readonly string[] = ["claude", "codex"];

/** Where the action boundary is turned on, named in each line below. */
export const BOUNDARY_SETTINGS_POINTER = "Settings → Autonomy, per project";

/**
 * Under the Worker's and the Reviewer's rows (autonomy design §D.2, §D.4,
 * change-010 C6): whether the action boundary can apply to the role. It does
 * not for a mode set by hand on the profile (the owner's mode wins) or a
 * provider left on detection — a warning; otherwise one info line pointing to
 * Settings → Autonomy, where it is turned on per project. `null` for the
 * Manager and the Orchestrator, which it never covers.
 */
export function roleBoundaryNote(setting: RoleSetting): Badge | null {
  if (setting.role !== "worker" && setting.role !== "reviewer") return null;
  if (setting.modeId !== null) {
    return { text: `Action boundary: off for this role — its mode is set by hand, so its actions are only watched, even where the boundary is on (${BOUNDARY_SETTINGS_POINTER}).`, tone: "warning" };
  }
  if (setting.baseProvider === null || !BOUNDARY_BASE_PROVIDERS.includes(setting.baseProvider)) {
    const provider = setting.baseProvider === null ? "this provider" : providerLabel(setting.baseProvider);
    return { text: `Action boundary: off for this role — ${provider} is only watched, even where the boundary is on (${BOUNDARY_SETTINGS_POINTER}).`, tone: "warning" };
  }
  return { text: `Action boundary: held before it runs in the projects where you turn it on (${BOUNDARY_SETTINGS_POINTER}); watched elsewhere.`, tone: "muted" };
}

/** What the Edit form holds. `null` thinking / mode means "not set". */
export interface RoleDraft {
  baseProvider: string;
  model: string | null;
  thinkingOptionId: string | null;
  modeId: string | null;
}

/** A choice of the form; `id: null` is the "not set" choice. */
export interface RoleChoice {
  id: string | null;
  label: string;
}

/** The draft an Edit form opens with: the role as it is saved now. */
export function roleDraftOf(setting: RoleSetting): RoleDraft {
  return {
    baseProvider: setting.baseProvider ?? "",
    model: setting.model,
    thinkingOptionId: setting.thinkingOptionId,
    modeId: setting.modeId,
  };
}

/**
 * The base providers the form offers: those `roles.settings` reports as
 * available, plus the role's current one when it is missing from that list
 * (so the form always shows what is selected). Never a `bm-*` alias.
 */
export function providerChoices(available: readonly string[], current: string | null): string[] {
  const out = available.filter((provider) => provider.trim() !== "" && !isRoleAlias(provider));
  if (current !== null && current.trim() !== "" && !isRoleAlias(current) && !out.includes(current)) out.unshift(current);
  return out;
}

/** Thinking choices of a model: "Provider default" first; none (the field is hidden) when the model has no levels. */
export function thinkingChoices(model: RoleModelOption | null | undefined): RoleChoice[] {
  if (model === null || model === undefined || model.thinkingOptions.length === 0) return [];
  const fallback = model.defaultThinkingOptionId;
  const fallbackLabel = fallback === null ? null : (model.thinkingOptions.find((option) => option.id === fallback)?.label ?? fallback);
  return [
    { id: null, label: fallbackLabel === null ? "Provider default" : `Provider default (${fallbackLabel})` },
    ...model.thinkingOptions.map((option) => ({ id: option.id, label: option.label })),
  ];
}

/**
 * Mode choices of a provider for a role: "Not set" first. None (the field is
 * hidden) for capability `none` or when the provider lists no mode. The
 * Reviewer and the Orchestrator on a `tiered` provider are never offered a
 * `dangerous` or `planning` mode (§4.3.3; orchestrator design §3.1).
 */
export function modeChoices(role: SetupRole, options: RolesOptions | undefined): RoleChoice[] {
  if (options === undefined || options.capability === "none") return [];
  const guarded = role === "reviewer" || role === "orchestrator";
  const modes = options.modes.filter((mode) => {
    if (!guarded || options.capability !== "tiered") return true;
    const tier = (mode.colorTier ?? "").toLowerCase();
    return tier !== "dangerous" && tier !== "planning";
  });
  if (modes.length === 0) return [];
  return [{ id: null, label: "Not set" }, ...modes.map((mode) => ({ id: mode.id, label: mode.label }))];
}

/** `~$<in> / $<out> per 1M tokens`, or `null` when the model has no listed cost. */
export function modelPriceText(model: RoleModelOption | null | undefined): string | null {
  const cost = model?.cost ?? null;
  return cost === null ? null : `~$${cost.inputUsdPerMTok} / $${cost.outputUsdPerMTok} per 1M tokens`;
}

export interface RoleFormView {
  /** The draft with every value the chosen provider and model do not offer dropped. */
  draft: RoleDraft;
  providers: string[];
  models: RoleModelOption[];
  model: RoleModelOption | null;
  /** Empty: the Thinking field is hidden. */
  thinking: RoleChoice[];
  /** Empty: the Mode field is hidden. */
  modes: RoleChoice[];
  price: string | null;
  /** A line under the Mode field, e.g. when Paseo could not list the modes and saving clears the one set. */
  modeNote: string | null;
  /** Why Save cannot run yet; `null` when the draft is complete. */
  blocker: string | null;
  /** The draft differs from what is saved. */
  changed: boolean;
}

/**
 * Everything the Edit form shows, from the saved role, the available
 * providers, the user's draft and `roles.options` of the drafted provider
 * (`undefined` while it loads or when it failed).
 */
export function roleFormView(input: {
  role: SetupRole;
  setting: RoleSetting;
  available: readonly string[];
  draft: RoleDraft;
  options: RolesOptions | undefined;
}): RoleFormView {
  const { role, setting, draft } = input;
  const providers = providerChoices(input.available, setting.baseProvider);
  const options = draft.baseProvider === "" ? undefined : optionsFor(draft.baseProvider, input.options);
  if (options === undefined) {
    return {
      draft,
      providers,
      models: [],
      model: null,
      thinking: [],
      modes: [],
      price: null,
      modeNote: null,
      blocker: draft.baseProvider === "" ? "Pick a provider." : `Loading the models of ${providerLabel(draft.baseProvider)}…`,
      changed: draftChanged(setting, draft),
    };
  }
  const model = options.models.find((entry) => entry.id === draft.model) ?? null;
  const thinking = thinkingChoices(model);
  const modes = modeChoices(role, options);
  const normalized: RoleDraft = {
    baseProvider: draft.baseProvider,
    model: model?.id ?? null,
    thinkingOptionId: thinking.some((choice) => choice.id !== null && choice.id === draft.thinkingOptionId) ? draft.thinkingOptionId : null,
    modeId: modes.some((choice) => choice.id !== null && choice.id === draft.modeId) ? draft.modeId : null,
  };
  const label = providerLabel(draft.baseProvider);
  const blocker =
    normalized.model !== null ? null : options.models.length === 0 ? `Paseo lists no model for ${label}; pick another provider.` : "Pick a model.";
  const modeNote =
    options.capability === "unknown" && draft.modeId !== null
      ? `Paseo could not list the modes of ${label}; saving clears the mode \`${draft.modeId}\`.`
      : null;
  return {
    draft: normalized,
    providers,
    models: options.models,
    model,
    thinking,
    modes,
    price: modelPriceText(model),
    modeNote,
    blocker,
    changed: draftChanged(setting, normalized),
  };
}

/** True when the draft would change the saved role. */
export function draftChanged(setting: RoleSetting, draft: RoleDraft): boolean {
  return (
    (setting.baseProvider ?? "") !== draft.baseProvider ||
    setting.model !== draft.model ||
    setting.thinkingOptionId !== draft.thinkingOptionId ||
    setting.modeId !== draft.modeId
  );
}

/** The `roles.save-settings` input, or `null` while the draft has no provider or model. */
export function saveSettingsInput(revision: string, role: SetupRole, draft: RoleDraft): RolesSaveSettingsInput | null {
  if (draft.baseProvider === "" || draft.model === null) return null;
  return {
    revision,
    role,
    baseProvider: draft.baseProvider,
    model: draft.model,
    thinkingOptionId: draft.thinkingOptionId,
    modeId: draft.modeId,
  };
}

/** What a successful save shows under its row: "Saved." then each returned warning. */
export function savedNotes(result: { warnings: readonly string[] }): Badge[] {
  return [{ text: "Saved.", tone: "success" }, ...result.warnings.map((warning) => ({ text: warning, tone: "warning" as const }))];
}

export function isSettingsConflict(error: unknown): boolean {
  return /\bE_ROLE_SETTINGS_CONFLICT\b/.test(errorMessageOf(error));
}

/** What a failed save shows: the fixed conflict sentence, otherwise the server's message. */
export function saveErrorText(error: unknown): string {
  return isSettingsConflict(error) ? ROLES_CONFLICT_MESSAGE : errorMessageOf(error);
}

/** `roles.settings` after a save, before the refetch lands: the new revision and the saved role in place. */
export function applySavedRole(settings: RolesSettings, result: { revision: string; role: RoleSetting }): RolesSettings {
  return {
    ...settings,
    revision: result.revision,
    roles: settings.roles.map((setting) => (setting.role === result.role.role ? result.role : setting)),
  };
}

// ---------------------------------------------------------------------------
// Fallback chains (delta 20260921 §4.3.1, §4.4.3, REQ-065 f).
// ---------------------------------------------------------------------------

/**
 * The policy row under a role: `On a usage limit: (•) Ask me ( ) Off`. "Ask
 * me" is the default. The Auto switch was retired (ADR-022 decision 4): an
 * incident answers itself only where the owner delegates the Environment class.
 */
export const FALLBACK_POLICY_CHOICES: ReadonlyArray<{ id: FallbackDraft["policy"]; label: string }> = [
  { id: "ask", label: "Ask me" },
  { id: "off", label: "Off" },
];

/** Shown once under a role whose saved chain still had the retired Auto switch, until that chain is saved again. */
export const FALLBACK_AUTO_RETIRED_NOTICE =
  "Auto switch was retired: this role now asks you. Set the project to Cruise or above in Settings → Autonomy to let the Orchestrator answer it.";

/** The button beside that notice: saves the chain as shown, which ends the notice. */
export const FALLBACK_AUTO_RETIRED_ACK = "Got it";

/** The notice for `chain`, or `null` when its saved policy is Ask me or Off as stored. */
export function fallbackAutoRetiredNotice(chain: FallbackSettings): string | null {
  return chain.migratedFromAuto === true ? FALLBACK_AUTO_RETIRED_NOTICE : null;
}

/**
 * The chains to show, in role order: one block per role present in
 * `roles.settings.fallback`. The server decides which roles are offered
 * (`FALLBACK_ROLES`), so a later phase enables more blocks without a client
 * change. The Orchestrator never has one (orchestrator design §3.1).
 */
export function fallbackBlocks(settings: RolesSettings): FallbackSettings[] {
  const chains = settings.fallback;
  if (chains === null || chains === undefined) return [];
  return SETUP_ROLES.flatMap((entry) => {
    const chain = entry.role === "orchestrator" ? undefined : chains[entry.role];
    return chain === undefined ? [] : [chain];
  });
}

/** What a chain's block holds while the user edits it. */
export interface FallbackDraft {
  policy: FallbackSettings["policy"];
  entries: FallbackEntryInput[];
}

/** The draft a block starts from: the chain as saved. */
export function fallbackDraftOf(chain: FallbackSettings): FallbackDraft {
  return {
    policy: chain.policy,
    entries: chain.entries.map(({ baseProvider, model, thinkingOptionId, modeId }) => ({ baseProvider, model, thinkingOptionId, modeId })),
  };
}

/** One entry row: `<Provider> · <model> · thinking <id | provider default>`, plus the mode when one is set. */
export function fallbackEntryText(entry: FallbackEntryInput, options?: RolesOptions): string {
  const listed = optionsFor(entry.baseProvider, options);
  const parts = [
    providerLabel(entry.baseProvider),
    listed?.models.find((model) => model.id === entry.model)?.label ?? entry.model,
    `thinking ${entry.thinkingOptionId ?? "provider default"}`,
  ];
  if (entry.modeId !== null) parts.push(`mode ${listed?.modes.find((mode) => mode.id === entry.modeId)?.label ?? entry.modeId}`);
  return parts.join(" · ");
}

/** The listed price of a saved entry, as the Edit form shows it; `null` when unknown. */
export function fallbackPriceText(entry: FallbackSettings["entries"][number]): string | null {
  return entry.cost === null ? null : `~$${entry.cost.inputUsdPerMTok} / $${entry.cost.outputUsdPerMTok} per 1M tokens`;
}

/** True while another entry fits (at most three per role). */
export function canAddFallback(draft: FallbackDraft): boolean {
  return draft.entries.length < MAX_FALLBACK_ENTRIES;
}

/** The draft with `entry` appended; unchanged when the chain is full. */
export function addFallback(draft: FallbackDraft, entry: FallbackEntryInput): FallbackDraft {
  return canAddFallback(draft) ? { ...draft, entries: [...draft.entries, { ...entry }] } : draft;
}

/** The draft with entry `index` replaced (an entry edited in place). */
export function replaceFallback(draft: FallbackDraft, index: number, entry: FallbackEntryInput): FallbackDraft {
  if (index < 0 || index >= draft.entries.length) return draft;
  return { ...draft, entries: draft.entries.map((current, at) => (at === index ? { ...entry } : current)) };
}

/** The draft without entry `index`; the entries after it move up, so positions stay 1…n. */
export function removeFallback(draft: FallbackDraft, index: number): FallbackDraft {
  if (index < 0 || index >= draft.entries.length) return draft;
  return { ...draft, entries: draft.entries.filter((_entry, at) => at !== index) };
}

/** The draft with entry `index` moved one place up (`-1`) or down (`1`); unchanged at either end. */
export function moveFallback(draft: FallbackDraft, index: number, delta: -1 | 1): FallbackDraft {
  const target = index + delta;
  if (index < 0 || index >= draft.entries.length || target < 0 || target >= draft.entries.length) return draft;
  const entries = [...draft.entries];
  [entries[index], entries[target]] = [entries[target]!, entries[index]!];
  return { ...draft, entries };
}

/**
 * True when the draft would change the saved chain. A chain still stored with
 * the retired Auto switch always changes: any save writes Ask me or Off.
 */
export function fallbackDraftChanged(chain: FallbackSettings, draft: FallbackDraft): boolean {
  const saved = fallbackDraftOf(chain);
  return chain.migratedFromAuto === true || saved.policy !== draft.policy || JSON.stringify(saved.entries) !== JSON.stringify(draft.entries);
}

/** The `roles.save-fallback` input; `revision` is the one the block had when the user started editing it. */
export function saveFallbackInput(revision: string, role: BmRole, draft: FallbackDraft): RolesSaveFallbackInput {
  return { revision, role, policy: draft.policy, entries: draft.entries.map((entry) => ({ ...entry })) };
}

/**
 * An entry as the Edit form's `setting`, so the same form (`roleFormView`)
 * edits a fallback entry: `null` opens an empty form for "Add fallback".
 */
export function entryAsSetting(role: BmRole, entry: FallbackEntryInput | null): RoleSetting {
  return {
    role,
    providerId: role === "manager" ? "bm-manager" : role === "worker" ? "bm-worker" : "bm-reviewer",
    baseProvider: entry?.baseProvider ?? null,
    label: null,
    model: entry?.model ?? null,
    thinkingOptionId: entry?.thinkingOptionId ?? null,
    modeId: entry?.modeId ?? null,
    featureValues: {},
    capability: "unknown",
  };
}

/** The entry a completed Edit form describes, or `null` while it has no provider or model. */
export function entryOfDraft(draft: RoleDraft): FallbackEntryInput | null {
  if (draft.baseProvider === "" || draft.model === null) return null;
  return { baseProvider: draft.baseProvider, model: draft.model, thinkingOptionId: draft.thinkingOptionId, modeId: draft.modeId };
}
