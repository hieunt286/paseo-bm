/**
 * What the Setup screen says (delta 20260916-setup-screen), and what its
 * Roles & models section shows and saves (delta 20260921 §4.3.1), fallback
 * chains included (§4.4.3), without a renderer.
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
  SetupStatus,
} from "../shared/contracts";
import { MAX_FALLBACK_ENTRIES } from "../shared/fallback";
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

/**
 * The three sections of the Setup screen, one per configuration the owner named
 * (delta 20260925 §3.3): the beads tools, the agent skills, and everything about
 * the agents themselves. One long scroll was hard to read, so each is a tab.
 */
export type SetupTab = "tools" | "skills" | "agents";

export const SETUP_TABS: ReadonlyArray<{ key: SetupTab; label: string; hint: string }> = [
  { key: "tools", label: "Beads tools", hint: "br and bv on the daemon's PATH" },
  { key: "skills", label: "Agent skills", hint: "the skills each role needs" },
  { key: "agents", label: "Agents", hint: "models, modes and extra instructions" },
];

/** Where the screen opens; a reopened surface starts here again. */
export const DEFAULT_SETUP_TAB: SetupTab = "tools";

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

// ---------------------------------------------------------------------------
// Fallback chains (delta 20260921 §4.3.1, §4.4.3, REQ-065 f).
// ---------------------------------------------------------------------------

/**
 * The policy row under a role: `On a usage limit: (•) Ask me ( ) Auto switch ( ) Off`.
 * "Ask me" stays the default; "Auto switch" (phase 2a-18, §4.6) is chosen per role.
 */
export const FALLBACK_POLICY_CHOICES: ReadonlyArray<{ id: FallbackDraft["policy"]; label: string }> = [
  { id: "ask", label: "Ask me" },
  { id: "auto", label: "Auto switch" },
  { id: "off", label: "Off" },
];

/**
 * The warning shown under a role's policy while "Auto switch" is chosen (§4.6,
 * REQ-067 a): the plugin replaces the stopped agent without asking, which can
 * cost money; for the Manager, the chat being used can be replaced. `null` for
 * the other policies.
 */
export function fallbackPolicyWarning(role: BmRole, policy: FallbackDraft["policy"]): string | null {
  if (policy !== "auto") return null;
  const cost = `Auto switch replaces a stopped ${ROLE_NAMES[role]} without asking you; a fallback on a provider that bills by the token can cost money.`;
  return role === "manager" ? `${cost} The chat you use may be replaced.` : cost;
}

const ROLE_NAMES: Readonly<Record<BmRole, string>> = { manager: "Manager", worker: "Worker", reviewer: "Reviewer" };

/**
 * The chains to show, in role order: one block per role present in
 * `roles.settings.fallback`. The server decides which roles are offered
 * (`FALLBACK_ROLES`), so a later phase enables more blocks without a client change.
 */
export function fallbackBlocks(settings: RolesSettings): FallbackSettings[] {
  const chains = settings.fallback;
  if (chains === null || chains === undefined) return [];
  return SETUP_ROLES.map((entry) => chains[entry.role]).filter((chain): chain is FallbackSettings => chain !== undefined);
}

/** What a chain's block holds while the user edits it. */
export interface FallbackDraft {
  policy: "ask" | "off" | "auto";
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

/** True when the draft would change the saved chain. */
export function fallbackDraftChanged(chain: FallbackSettings, draft: FallbackDraft): boolean {
  const saved = fallbackDraftOf(chain);
  return saved.policy !== draft.policy || JSON.stringify(saved.entries) !== JSON.stringify(draft.entries);
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

// ---------------------------------------------------------------------------
// "Set up paseo-bm": the checklist a paseo.cafe install works through
// (0.4.0, design §7.13; Dashboard design §11.3).
// ---------------------------------------------------------------------------

/** Which of the plugin's own screens a row sends the user to, when it is not a button. */
export type ChecklistAction =
  | { kind: "ensure-roles" }
  | { kind: "grant-agent-tools" }
  | { kind: "install-skills" }
  | { kind: "open-tab"; tab: SetupTab }
  | { kind: "none" };

export interface ChecklistRow {
  key: "roles" | "agent-tools" | "skills" | "tools" | "sign-in";
  title: string;
  /** The one sentence that says what is wrong. */
  status: string;
  /** Label of the row's button, or `null` when the row is text only. */
  button: string | null;
  action: ChecklistAction;
  /** A command the user runs themselves, shown with a Copy button. */
  command: string | null;
}

/** The label Setup uses for the agent whose skills a provider needs. */
export function skillAgentOfProvider(provider: string): { key: "claude" | "codex" | "pi" | "opencode"; agent: SkillAgent } | null {
  const byProvider: Record<string, "claude" | "codex" | "pi" | "opencode"> = {
    claude: "claude",
    codex: "codex",
    pi: "pi",
    opencode: "opencode",
  };
  const key = byProvider[provider];
  return key === undefined ? null : (SKILL_COLUMNS.find((column) => column.key === key) ?? null);
}

/** `"manager"` → `"Manager"`, from the one list that names the roles. */
const roleLabel = (role: string): string => SETUP_ROLES.find((entry) => entry.role === role)?.label ?? role;

/**
 * The rows of the "Set up paseo-bm" card: what is still missing, in the order
 * a user has to do it, and nothing else.
 *
 * An empty list means the card is not shown at all — which is the state almost
 * every user is in, almost all the time. Anything that is merely unknown (a
 * provider whose sign-in could not be read, a skills column the server did not
 * report) produces no row: a checklist that lists things that may well be fine
 * teaches people to ignore it.
 */
export function setupChecklist(status: SetupStatus, rolesError?: string | null): ChecklistRow[] {
  const setup = status.setup;
  if (setup === undefined) return [];
  const rows: ChecklistRow[] = [];

  if (setup.roles.missing.length > 0) {
    const names = setup.roles.missing.map(roleLabel).join(", ");
    const detail = rolesError === undefined || rolesError === null || rolesError === "" ? "" : ` ${rolesError}`;
    rows.push({
      key: "roles",
      title: "Roles",
      status: `Not created: ${names}.${detail}`,
      button: "Try again",
      action: { kind: "ensure-roles" },
      command: null,
    });
  }

  if (setup.agentTools.injectIntoAgents === false) {
    rows.push({
      key: "agent-tools",
      title: "Agent tools",
      status: "Off — the Manager may not be able to create a Worker.",
      button: "Allow agent tools…",
      action: { kind: "grant-agent-tools" },
      command: null,
    });
  }

  // The skills row follows the WORKER's provider and no other: the Worker is
  // what runs the skills, so a Reviewer on a provider with none of them
  // installed is not a reason to interrupt anybody.
  const workerProvider = setup.logins.find((entry) => entry.roles.includes("worker"))?.provider ?? null;
  const column = workerProvider === null ? null : skillAgentOfProvider(workerProvider);
  const missingForWorker = column === null ? undefined : status.skills.missingRequired[column.key];
  if (column !== null && missingForWorker !== undefined && missingForWorker > 0) {
    const required = status.skills.skills.filter((skill) => skill.required).length;
    rows.push({
      key: "skills",
      title: "Agent skills",
      status: `Required skills for the Worker (${column.agent === "Claude" ? "Claude Code" : column.agent}): ${required - missingForWorker}/${required}. The Worker works with lower quality without them.`,
      button: "Install skills…",
      action: { kind: "install-skills" },
      command: null,
    });
  }

  const missingTools = status.tools.filter((tool) => (tool.id === "br" || tool.id === "bv") && tool.path === null).map((tool) => tool.id);
  if (missingTools.length > 0) {
    rows.push({
      key: "tools",
      title: "Beads tools",
      status: `Missing ${missingTools.join(" and ")} — the Worker cannot manage beads without it`,
      button: "Open Beads tools",
      action: { kind: "open-tab", tab: "tools" },
      command: null,
    });
  }

  for (const login of setup.logins) {
    if (login.state !== "logged-out") continue;
    const roles = login.roles.map(roleLabel).join(", ");
    rows.push({
      key: "sign-in",
      title: "Sign-in",
      status:
        login.loginCommand === null
          ? `\`${login.provider}\` (used by ${roles}) is not signed in. ${login.guidance ?? ""}`.trimEnd()
          : `\`${login.provider}\` (used by ${roles}) is not signed in. Sign in with: \`${login.loginCommand}\``,
      button: null,
      action: { kind: "none" },
      command: login.loginCommand,
    });
  }

  return rows;
}

/** The one line that tells a 0.3.x user to move to the npm install, or `null`. */
export const MIGRATION_BANNER_COMMAND = "npx paseo-bm@0.4.0";
export const MIGRATION_BANNER_TEXT =
  "This copy of paseo-bm was installed by the old npx installer. Switch it to the paseo.cafe install once: `npx paseo-bm@0.4.0`. Your roles, settings and history stay.";

export function migrationBanner(status: SetupStatus): { text: string; command: string } | null {
  return status.setup?.install.kind === "installer-directory"
    ? { text: MIGRATION_BANNER_TEXT, command: MIGRATION_BANNER_COMMAND }
    : null;
}

/** What Setup says after `setup.ensure-roles` answered. */
export type EnsureRolesLine =
  | { tone: "success"; text: string; dismissable: true; button: null }
  | { tone: "warning"; text: string; dismissable: false; button: "Set up again" }
  | { tone: "danger"; text: string; dismissable: false; button: "Try again" };

export function ensureRolesLine(
  result: { created: readonly string[]; baseProvider: string | null; model: string | null; skipped: "cleaned-up" | null } | null,
  error?: unknown,
): EnsureRolesLine | null {
  if (error !== undefined && error !== null) {
    return { tone: "danger", text: errorMessageOf(error), dismissable: false, button: "Try again" };
  }
  if (result === null) return null;
  if (result.skipped === "cleaned-up") {
    return {
      tone: "warning",
      text: "paseo-bm's settings were removed. Remove the plugin with `paseo plugin remove paseo-bm`, or set it up again.",
      dismissable: false,
      button: "Set up again",
    };
  }
  if (result.created.length === 0 || result.baseProvider === null || result.model === null) return null;
  return {
    tone: "success",
    text: `paseo-bm created its roles with defaults (${result.baseProvider} · ${result.model}). Change them in Agents.`,
    dismissable: true,
    button: null,
  };
}

/**
 * A confirmation the user must read before anything happens.
 *
 * Cancel is the default action and the one Escape takes, and the confirm button
 * is never the pre-focused one: both of these grant something machine-wide that
 * is awkward to take back, so an accidental Return must do nothing.
 */
export interface SetupDialog {
  title: string;
  body: string;
  confirmLabel: string;
  cancelLabel: string;
  /** What Escape and the default action do. */
  defaultAction: "cancel";
}

export const AGENT_TOOLS_DIALOG: SetupDialog = {
  title: "Allow Paseo's agent tools for every agent?",
  body:
    "The Manager and the Worker need Paseo's agent tools to create and message other agents. " +
    "Paseo has one switch for this (daemon.mcp.injectIntoAgents), and it applies to every agent on this machine, " +
    "not only paseo-bm's: any agent can then create, message and stop other agents. " +
    'paseo-bm records the current value so "Remove paseo-bm\'s settings" can turn it back off.',
  confirmLabel: "Allow for every agent",
  cancelLabel: "Cancel",
  defaultAction: "cancel",
};

export function skillsDialog(installCommand: string): SetupDialog {
  return {
    title: "Run the third-party skills CLI?",
    body:
      `${installCommand}\n\n` +
      "This downloads the skills from github.com/cuongntr/agent-skills (another author) with the `skills` CLI, " +
      "a third-party tool with its own data collection. paseo-bm never writes to your skills folders itself. " +
      "It can take up to 5 minutes.",
    confirmLabel: "Run it",
    cancelLabel: "Cancel",
    defaultAction: "cancel",
  };
}

// ---------------------------------------------------------------------------
// The state of each setup item, shown where the user manages it (0.4.0).
// ---------------------------------------------------------------------------

/** One line about the roles the plugin created, or `null` when it created none. */
export function rolesCreatedLine(status: SetupStatus): string | null {
  const created = status.setup?.roles.created;
  if (created === undefined || created === null) return null;
  const date = new Date(created.at);
  const when = Number.isNaN(date.getTime()) ? created.at : date.toLocaleDateString();
  return `Created by paseo-bm on ${when} with defaults (${created.baseProvider} · ${created.model}). Change them here.`;
}

export interface AgentToolsBlock {
  text: string;
  tone: "muted" | "warning";
  /** The button label, or `null` when there is nothing to press. */
  button: "Allow agent tools…" | null;
}

/** What the Agents tab says about Paseo's machine-wide switch. */
export function agentToolsBlock(status: SetupStatus): AgentToolsBlock | null {
  const agentTools = status.setup?.agentTools;
  if (agentTools === undefined) return null;
  if (agentTools.injectIntoAgents === null) {
    return { text: "Unknown — Paseo's configuration could not be read.", tone: "warning", button: null };
  }
  if (agentTools.injectIntoAgents) {
    return {
      text: agentTools.setBy === null ? "On for every agent" : "On for every agent, turned on by paseo-bm",
      tone: "muted",
      button: null,
    };
  }
  return { text: "Off — the Manager may not be able to create a Worker", tone: "warning", button: "Allow agent tools…" };
}

export interface SignInRow {
  provider: string;
  /** "used by Manager, Worker". */
  usedBy: string;
  text: string;
  tone: "muted" | "warning";
  /** Shown with a Copy button; `null` when there is no command to run. */
  command: string | null;
}

/**
 * One row per provider the three roles run on.
 *
 * paseo-bm never runs a login command: the row shows what the provider's own
 * tool documents and the user runs it themselves (design §9).
 */
export function signInRows(status: SetupStatus): SignInRow[] {
  return (status.setup?.logins ?? []).map((login) => {
    const usedBy = `used by ${login.roles.map(roleLabel).join(", ")}`;
    if (login.state === "logged-in") {
      return { provider: login.provider, usedBy, text: "Signed in", tone: "muted", command: null };
    }
    if (login.state === "unknown") {
      return { provider: login.provider, usedBy, text: "Unknown", tone: "muted", command: null };
    }
    return {
      provider: login.provider,
      usedBy,
      text: login.loginCommand === null ? (login.guidance ?? "Not signed in") : `Not signed in — sign in with \`${login.loginCommand}\``,
      tone: "warning",
      command: login.loginCommand,
    };
  });
}

/** When the skills CLI last ran, or `null` when it never has here. */
export function skillsRunLine(status: SetupStatus): string | null {
  const run = status.setup?.skillsRun;
  if (run === undefined || run === null) return null;
  const at = new Date(run.at);
  return `Last run: ${Number.isNaN(at.getTime()) ? run.at : at.toLocaleString()} · exit ${run.code}`;
}

/** The label above the skills command, now that Setup can run it. */
export const SKILLS_COMMAND_LABEL = "Install the required skills for Claude Code and Codex: press Install skills, or run it yourself";

/** True when some agent is still missing a required skill, whichever it is. */
export function anySkillMissing(status: SetupStatus): boolean {
  return SKILL_COLUMNS.some((column) => (status.skills.missingRequired[column.key] ?? 0) > 0);
}

export interface DataHomeLines {
  text: string;
  tone: "muted" | "danger";
}

/** The two lines of the "This install" block that talk about the data folder. */
export const PLUGIN_DIAGNOSTICS_LINE =
  "If paseo-bm does not load at all, check `paseo plugin ls` and `paseo plugin logs paseo-bm`.";

export function dataHomeLine(status: SetupStatus): DataHomeLines | null {
  const dataHome = status.setup?.dataHome;
  if (dataHome === undefined) return null;
  if (dataHome.path === null) {
    return { text: `paseo-bm cannot use its data folder: ${dataHome.reason ?? "no reason given"}`, tone: "danger" };
  }
  const source =
    dataHome.source === "env"
      ? "set by PASEO_BM_HOME"
      : dataHome.source === "pointer"
        ? "from ~/.paseo-bm/home.json"
        : "default";
  return { text: `Data folder: \`${dataHome.path}\` (${source})`, tone: "muted" };
}

// ---------------------------------------------------------------------------
// "Remove paseo-bm's settings" (0.4.0, design §7.13.7; ADR-012 decision 6).
// ---------------------------------------------------------------------------

export const CLEANUP_BUTTON_LABEL = "Remove paseo-bm's settings…";
export const CLEANUP_BUTTON_ACCESSIBILITY_LABEL = "Remove paseo-bm's roles and settings from Paseo";
export const CLEANUP_NEXT_LINE = "Now remove the plugin: `paseo plugin remove paseo-bm`";
export const CLEANUP_NEXT_COMMAND = "paseo plugin remove paseo-bm";

/**
 * The first of two confirmations: what the button takes away.
 *
 * It names the agents that will break, because that is the consequence a user
 * cannot see from the screen and cannot undo afterwards — the configuration
 * itself is one press away from being recreated.
 */
export function cleanupWarning(status: SetupStatus): string {
  const agentTools = status.setup?.agentTools;
  const alsoSwitch =
    agentTools !== undefined && agentTools.injectIntoAgents === true && agentTools.setBy !== null
      ? ", and turns Paseo's agent tools back off (paseo-bm turned them on)"
      : "";
  return (
    `This removes every bm-* provider and agent profile from Paseo (the three roles and their fallbacks)${alsoSwitch}. ` +
    "Agents already running on these roles will fail on their next turn: archive them first. Skills, br and bv stay."
  );
}

/** The second confirmation: the data, which is kept unless the user says otherwise. */
export function cleanupDataQuestion(status: SetupStatus): string {
  const path = status.setup?.dataHome.path ?? "the paseo-bm data folder";
  return (
    `Also delete paseo-bm's data in \`${path}\`: history (traces), extra instructions, fallback settings and incidents? ` +
    "One small file stays so the roles are not re-created before you remove the plugin, and files left by the old installer stay."
  );
}

export const CLEANUP_WARNING_DIALOG = { confirmLabel: "Remove settings", cancelLabel: "Cancel", defaultAction: "cancel" } as const;
export const CLEANUP_DATA_DIALOG = { keepLabel: "Keep my data", deleteLabel: "Delete data", defaultAction: "keep" } as const;

/** What `setup.cleanup` is sent, once both questions have an answer. */
export function cleanupInput(deleteData: boolean): { confirmed: true; deleteData: boolean } {
  return { confirmed: true, deleteData };
}

export interface CleanupReport {
  lines: string[];
  nextCommand: string;
}

/** What the screen shows once the cleanup has run. */
export function cleanupReport(result: {
  removedProviders: readonly string[];
  removedProfiles: readonly string[];
  agentTools: "restored" | "left-on" | "off";
  data: { deleted: readonly string[]; kept: readonly string[] } | null;
}): CleanupReport {
  const lines: string[] = [
    `Removed ${result.removedProviders.length} provider${result.removedProviders.length === 1 ? "" : "s"} and ${result.removedProfiles.length} agent profile${result.removedProfiles.length === 1 ? "" : "s"}.`,
  ];
  if (result.agentTools === "restored") lines.push("Paseo's agent tools are back to what they were before paseo-bm.");
  if (result.agentTools === "left-on") lines.push("Paseo's agent tools are left on — they were not turned on by paseo-bm.");
  if (result.agentTools === "off") lines.push("Paseo's agent tools were already off.");
  if (result.data !== null) {
    lines.push(result.data.deleted.length === 0 ? "No data files were deleted." : `Deleted: ${result.data.deleted.join(", ")}`);
    if (result.data.kept.length > 0) lines.push(`Kept: ${result.data.kept.join(", ")}`);
  } else {
    lines.push("Your data was kept.");
  }
  return { lines, nextCommand: CLEANUP_NEXT_COMMAND };
}
