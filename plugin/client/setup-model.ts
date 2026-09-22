/**
 * What the Setup screen says (delta 20260916-setup-screen), and what its
 * Roles & models section shows and saves (delta 20260921 §4.3.1), without a
 * renderer.
 *
 * Pure: no React, no React Native, no `server/` import.
 */
import type {
  BmRole,
  RoleModelOption,
  RoleSetting,
  RolesOptions,
  RolesSaveSettingsInput,
  RolesSettings,
  SetupStatus,
} from "../shared/contracts";
import type { Badge, GraphNode } from "./dashboard-model";
import { errorMessageOf } from "./launch-manager";

export type SetupRole = "manager" | "worker" | "reviewer";
type Tool = SetupStatus["tools"][number];
type SkillRow = SetupStatus["skills"]["skills"][number];
type SkillState = SkillRow["claude"];
export type SkillAgent = "Claude" | "Codex" | "Pi" | "OpenCode";

/**
 * The skill columns, in order. Pi and OpenCode (delta 20260921 §4.2.6) are
 * optional in the payload: a column the server did not report is not shown.
 */
export const SKILL_COLUMNS: ReadonlyArray<{ key: "claude" | "codex" | "pi" | "opencode"; agent: SkillAgent }> = [
  { key: "claude", agent: "Claude" },
  { key: "codex", agent: "Codex" },
  { key: "pi", agent: "Pi" },
  { key: "opencode", agent: "OpenCode" },
];

export const SETUP_ROLES: ReadonlyArray<{ role: SetupRole; label: string; mark: GraphNode["kind"] }> = [
  { role: "manager", label: "Manager", mark: "request" },
  { role: "worker", label: "Worker", mark: "worker" },
  { role: "reviewer", label: "Reviewer", mark: "reviewer" },
];

/** Numeric comparison of `0.2.10` / `v0.25.0`; null when either is not a version. */
export function compareVersions(a: string, b: string): number | null {
  const parse = (value: string) => /(\d+)\.(\d+)(?:\.(\d+))?/.exec(value)?.slice(1).map((part) => Number(part ?? 0));
  const left = parse(a);
  const right = parse(b);
  if (left === undefined || right === undefined) return null;
  for (let index = 0; index < 3; index += 1) {
    const diff = (left[index] ?? 0) - (right[index] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

export function toolBadge(tool: Tool): Badge {
  if (tool.path === null) return tool.required ? { text: "Missing", tone: "danger" } : { text: "Not installed", tone: "muted" };
  if (tool.version !== null && tool.latestKnown !== null && (compareVersions(tool.version, tool.latestKnown) ?? 0) < 0) {
    return { text: `${tool.version} · ${tool.latestKnown} available`, tone: "warning" };
  }
  return { text: tool.version ?? "Installed", tone: "success" };
}

export function skillBadge(agent: SkillAgent, state: SkillState): Badge {
  switch (state) {
    case "ok":
      return { text: `${agent} ✓`, tone: "success" };
    case "broken":
      return { text: `${agent} broken`, tone: "danger" };
    default:
      return { text: `${agent} missing`, tone: "warning" };
  }
}

/** One chip per skill column the row has, in column order. */
export function skillChips(skill: SkillRow): Badge[] {
  return SKILL_COLUMNS.flatMap(({ key, agent }) => {
    const state = skill[key];
    return state === undefined ? [] : [skillBadge(agent, state)];
  });
}

/** Where each agent's skills were looked for, one entry per reported column. */
export function skillDirsText(dirs: SetupStatus["skills"]["dirs"]): string {
  return [
    `Claude: ${dirs.claude}`,
    `Codex: ${dirs.shared} or ${dirs.codex}`,
    ...(dirs.pi === undefined ? [] : [`Pi: ${dirs.pi}`]),
    ...(dirs.opencode === undefined ? [] : [`OpenCode: ${dirs.opencode}`]),
  ].join(" · ");
}

/** One line at the top: is this machine ready for the Beads agents? */
export function setupHeadline(status: SetupStatus): Badge {
  const missingTools = status.tools.filter((tool) => tool.required && tool.path === null).map((tool) => tool.id);
  const required = status.skills.skills.filter((skill) => skill.required).length;
  const counts = SKILL_COLUMNS.flatMap(({ key, agent }) => {
    const missing = status.skills.missingRequired[key];
    return missing === undefined ? [] : [{ agent, missing }];
  });
  const skills = `skills: ${counts.map((count) => `${count.agent} ${required - count.missing}/${required}`).join(", ")}`;
  if (missingTools.length > 0) {
    return { text: `Missing ${missingTools.join(" and ")} — the Worker cannot manage beads without it · ${skills}`, tone: "danger" };
  }
  const readyForOne = counts.some((count) => count.missing === 0);
  return { text: `br and bv ready · ${skills}`, tone: readyForOne ? "success" : "warning" };
}

/**
 * One warning per role whose last new agent had no Paseo tools (delta 20260921
 * §4.2.4, REQ-063 d); nothing for `ok`, `unknown` or an older server.
 */
export function paseoToolsWarnings(status: SetupStatus): string[] {
  const seen = status.paseoTools;
  if (seen === undefined) return [];
  return (["manager", "worker"] as const).flatMap((role) => {
    const entry = seen[role];
    if (entry === null || entry.state !== "missing") return [];
    const name = role === "manager" ? "Manager" : "Worker";
    return [
      `The last ${name} (${entry.agentId}) runs on ${entry.provider} without Paseo tools, so it cannot create or message other agents. On Pi, install the pi-mcp-adapter extension.`,
    ];
  });
}

export function extraCounter(length: number, max: number): string {
  return `${length.toLocaleString("en-US")} / ${max.toLocaleString("en-US")} characters`;
}

export function installWarning(tool: Tool): string {
  return tool.installCommand?.startsWith("brew ")
    ? `This runs Homebrew on this machine: ${tool.installCommand}`
    : `This downloads and runs the project's install script from GitHub on this machine: ${tool.installCommand ?? ""}`;
}

// ---------------------------------------------------------------------------
// Roles & models (delta 20260921 §4.3.1, REQ-064 a/d, REQ-063 h).
// ---------------------------------------------------------------------------

/** Shown under the Roles & models rows at all times. */
export const ROLES_APPLY_NOTICE = "Changes apply to agents created after you save. Running agents keep their model and thinking.";

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

/** The distinct base providers of the roles, whose `roles.options` label the rows; never a `bm-*` alias. */
export function rowOptionProviders(settings: RolesSettings): string[] {
  const out: string[] = [];
  for (const setting of settings.roles) {
    const provider = setting.baseProvider;
    if (provider !== null && !isRoleAlias(provider) && !out.includes(provider)) out.push(provider);
  }
  return out;
}

export interface RoleRow {
  role: BmRole;
  label: string;
  mark: GraphNode["kind"];
  setting: RoleSetting;
  text: string;
}

/** The rows of the section, in the order `roles.settings` returned them. */
export function roleRows(settings: RolesSettings, optionsOf: (provider: string) => RolesOptions | undefined): RoleRow[] {
  return settings.roles.map((setting) => {
    const known = SETUP_ROLES.find((entry) => entry.role === setting.role);
    const options = setting.baseProvider === null ? undefined : optionsOf(setting.baseProvider);
    return {
      role: setting.role,
      label: known?.label ?? setting.role,
      mark: known?.mark ?? "worker",
      setting,
      text: roleSettingText(setting, options),
    };
  });
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
 * Reviewer on a `tiered` provider is never offered a `dangerous` or
 * `planning` mode (§4.3.3).
 */
export function modeChoices(role: BmRole, options: RolesOptions | undefined): RoleChoice[] {
  if (options === undefined || options.capability === "none") return [];
  const modes = options.modes.filter((mode) => {
    if (role !== "reviewer" || options.capability !== "tiered") return true;
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
  role: BmRole;
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
export function saveSettingsInput(revision: string, role: BmRole, draft: RoleDraft): RolesSaveSettingsInput | null {
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
