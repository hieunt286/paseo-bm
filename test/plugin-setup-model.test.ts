import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  FALLBACK_POLICY_CHOICES,
  ROLES_APPLY_NOTICE,
  ROLES_CONFLICT_MESSAGE,
  DEFAULT_SETUP_TAB,
  SETUP_ROLES,
  SETUP_TABS,
  addFallback,
  applySavedRole,
  canAddFallback,
  compareVersions,
  entryAsSetting,
  entryOfDraft,
  fallbackBlocks,
  fallbackDraftChanged,
  fallbackDraftOf,
  fallbackEntryText,
  fallbackPolicyWarning,
  fallbackPriceText,
  moveFallback,
  removeFallback,
  replaceFallback,
  saveFallbackInput,
  extraCounter,
  installWarning,
  isSettingsConflict,
  modeChoices,
  modelPriceText,
  providerChoices,
  providerLabel,
  roleDraftOf,
  roleFormView,
  roleRows,
  roleSettingText,
  rowOptionProviders,
  saveErrorText,
  saveSettingsInput,
  savedNotes,
  setupHeadline,
  skillBadge,
  skillChips,
  skillDirsText,
  thinkingChoices,
  toolBadge,
  AGENT_TOOLS_DIALOG,
  CLEANUP_DATA_DIALOG,
  CLEANUP_NEXT_LINE,
  CLEANUP_WARNING_DIALOG,
  MIGRATION_BANNER_TEXT,
  cleanupDataQuestion,
  cleanupInput,
  cleanupReport,
  cleanupWarning,
  PLUGIN_DIAGNOSTICS_LINE,
  SKILLS_COMMAND_LABEL,
  agentToolsBlock,
  anySkillMissing,
  dataHomeLine,
  rolesCreatedLine,
  signInRows,
  skillsRunLine,
  ensureRolesLine,
  migrationBanner,
  setupChecklist,
  skillsDialog,
} from "../plugin/client/setup-model";
import type { FallbackSettings, RoleModelOption, RoleSetting, RolesOptions, RolesSettings, SetupStatus } from "../plugin/shared/contracts";

type Tool = SetupStatus["tools"][number];
const tool = (overrides: Partial<Tool>): Tool => ({
  id: "br",
  name: "br — beads_rust",
  purpose: "",
  required: true,
  path: "/opt/homebrew/bin/br",
  version: "0.6.0",
  latestKnown: "0.6.0",
  installCommand: "brew install dicklesworthstone/tap/br",
  updateCommand: "brew upgrade dicklesworthstone/tap/br",
  homepage: "",
  ...overrides,
});

const status = (tools: Tool[], missing: SetupStatus["skills"]["missingRequired"] = { claude: 0, codex: 0 }): SetupStatus => ({
  tools,
  latestCheckedOn: "2026-09-16",
  skills: {
    checkedAt: "",
    dirs: { shared: "", claude: "", codex: "" },
    skills: [1, 2, 3, 4, 5].map((n) => ({ name: `s${n}`, required: true, claude: "ok", codex: "ok", problem: null })),
    missingRequired: missing,
    installCommand: "",
  },
  extras: { manager: 0, worker: 0, reviewer: 0 },
});

describe("setup wording", () => {
  it("compares versions numerically, with or without a leading v", () => {
    expect(compareVersions("0.2.10", "0.6.0")).toBeLessThan(0);
    expect(compareVersions("v0.25.0", "v0.25.0")).toBe(0);
    expect(compareVersions("0.10.0", "0.9.9")).toBeGreaterThan(0);
    expect(compareVersions("dev", "0.1.0")).toBeNull();
  });

  it("marks a missing required tool red, an old one amber, a current one green", () => {
    expect(toolBadge(tool({ path: null, version: null }))).toEqual({ text: "Missing", tone: "danger" });
    expect(toolBadge(tool({ id: "bd", required: false, path: null }))).toEqual({ text: "Not installed", tone: "muted" });
    expect(toolBadge(tool({ version: "0.2.10" }))).toEqual({ text: "0.2.10 · 0.6.0 available", tone: "warning" });
    expect(toolBadge(tool({}))).toEqual({ text: "0.6.0", tone: "success" });
  });

  it("says in one line whether the machine is ready", () => {
    const bv = tool({ id: "bv", path: null, version: null });
    expect(setupHeadline(status([tool({}), bv]))).toMatchObject({ tone: "danger" });
    expect(setupHeadline(status([tool({}), bv])).text).toContain("Missing bv");
    expect(setupHeadline(status([tool({}), tool({ id: "bv" })], { claude: 2, codex: 0 }))).toEqual({
      text: "br and bv ready · skills: Claude 3/5, Codex 5/5",
      tone: "success",
    });
    expect(setupHeadline(status([tool({})], { claude: 1, codex: 1 })).tone).toBe("warning");
  });

  it("labels skills, counts characters, and names what Install will run", () => {
    expect(skillBadge("Claude", "ok")).toEqual({ text: "Claude ✓", tone: "success" });
    expect(skillBadge("Codex", "broken").tone).toBe("danger");
    expect(skillBadge("Codex", "missing").tone).toBe("warning");
    expect(extraCounter(1234, 8000)).toBe("1,234 / 8,000 characters");
    expect(installWarning(tool({}))).toContain("Homebrew");
    expect(installWarning(tool({ installCommand: "curl -fsSL x | bash" }))).toContain("install script from GitHub");
    expect(SETUP_ROLES.map((entry) => entry.mark)).toEqual(["request", "worker", "reviewer"]);
  });

  describe("Pi and OpenCode columns (delta 20260921 §4.2.6)", () => {
    type Row = SetupStatus["skills"]["skills"][number];
    const row = (overrides: Partial<Row>): Row => ({ name: "s1", required: true, claude: "ok", codex: "missing", problem: null, ...overrides });

    it("show a chip per reported column, in order, and none for a column an older server did not send", () => {
      expect(skillChips(row({ pi: "broken", opencode: "missing" }))).toEqual([
        { text: "Claude ✓", tone: "success" },
        { text: "Codex missing", tone: "warning" },
        { text: "Pi broken", tone: "danger" },
        { text: "OpenCode missing", tone: "warning" },
      ]);
      expect(skillChips(row({})).map((badge) => badge.text)).toEqual(["Claude ✓", "Codex missing"]);
      expect(skillBadge("Pi", "ok")).toEqual({ text: "Pi ✓", tone: "success" });
      expect(skillBadge("OpenCode", "ok")).toEqual({ text: "OpenCode ✓", tone: "success" });
    });

    it("name where each agent's skills were looked for", () => {
      const dirs = { shared: "/h/.agents/skills", claude: "/h/.claude/skills", codex: "/h/.codex/skills" };
      expect(skillDirsText(dirs)).toBe("Claude: /h/.claude/skills · Codex: /h/.agents/skills or /h/.codex/skills");
      expect(skillDirsText({ ...dirs, pi: "/h/.pi/agent/skills", opencode: "/h/.config/opencode/skill" })).toBe(
        "Claude: /h/.claude/skills · Codex: /h/.agents/skills or /h/.codex/skills · Pi: /h/.pi/agent/skills · OpenCode: /h/.config/opencode/skill",
      );
    });

    it("count in the headline, and one ready agent is enough", () => {
      const both = [tool({}), tool({ id: "bv" })];
      expect(setupHeadline(status(both, { claude: 5, codex: 5, pi: 0, opencode: 2 }))).toEqual({
        text: "br and bv ready · skills: Claude 0/5, Codex 0/5, Pi 5/5, OpenCode 3/5",
        tone: "success",
      });
      expect(setupHeadline(status(both, { claude: 5, codex: 5, pi: 1, opencode: 2 })).tone).toBe("warning");
    });
  });
});

/** Roles & models (delta 20260921 §4.3.1, REQ-064 a/d, REQ-063 h). */
describe("Roles & models", () => {
  const setting = (overrides: Partial<RoleSetting> & Pick<RoleSetting, "role">): RoleSetting => ({
    providerId: `bm-${overrides.role}` as RoleSetting["providerId"],
    baseProvider: "claude",
    label: null,
    model: "claude-opus-5",
    thinkingOptionId: null,
    modeId: null,
    featureValues: {},
    capability: "tiered",
    ...overrides,
  });

  const opus: RoleModelOption = {
    id: "claude-opus-5",
    label: "Opus 5",
    thinkingOptions: [
      { id: "medium", label: "Medium" },
      { id: "high", label: "High" },
    ],
    defaultThinkingOptionId: "medium",
    cost: { inputUsdPerMTok: 5, cacheReadUsdPerMTok: 0.5, outputUsdPerMTok: 25 },
  };
  const haiku: RoleModelOption = { id: "claude-haiku", label: "Haiku", thinkingOptions: [], defaultThinkingOptionId: null, cost: null };
  const claude: RolesOptions = {
    provider: "claude",
    capability: "tiered",
    models: [opus, haiku],
    modes: [
      { id: "plan", label: "Plan", colorTier: "planning" },
      { id: "default", label: "Default", colorTier: "safe" },
      { id: "acceptEdits", label: "Accept edits", colorTier: "moderate" },
      { id: "bypassPermissions", label: "Bypass", colorTier: "dangerous" },
    ],
    autoAccept: false,
  };
  const codex: RolesOptions = {
    provider: "codex",
    capability: "tiered",
    models: [{ id: "gpt-5.6-sol", label: "GPT-5.6-Sol", thinkingOptions: [{ id: "high", label: "High" }], defaultThinkingOptionId: null, cost: null }],
    modes: [
      { id: "auto", label: "Auto", colorTier: "moderate" },
      { id: "full-access", label: "Full access", colorTier: "DANGEROUS" },
    ],
    autoAccept: false,
  };
  const opencode: RolesOptions = {
    provider: "opencode",
    capability: "untiered",
    models: [{ id: "big-pickle", label: "Big Pickle", thinkingOptions: [], defaultThinkingOptionId: null, cost: null }],
    modes: [
      { id: "build", label: "build", colorTier: null },
      { id: "plan", label: "plan", colorTier: null },
    ],
    autoAccept: true,
  };
  const pi: RolesOptions = { provider: "pi", capability: "none", models: [haiku], modes: [], autoAccept: false };

  const settings: RolesSettings = {
    revision: "rev-1",
    roles: [
      setting({ role: "manager", thinkingOptionId: "high", modeId: "bypassPermissions" }),
      setting({ role: "worker", thinkingOptionId: "high" }),
      setting({ role: "reviewer", baseProvider: "codex", model: "gpt-5.6-sol", modeId: "auto" }),
    ],
    fallback: null,
    warnings: ["Manager and Worker share the claude plan: if the Worker hits its limit, the Manager stops too."],
    providers: ["claude", "codex", "opencode", "pi"],
  };
  const byProvider = (provider: string) => [claude, codex, opencode, pi].find((entry) => entry.provider === provider);

  describe("rows", () => {
    it("come from roles.settings, one per role, in its order, labelled from roles.options", () => {
      const rows = roleRows(settings, byProvider);
      expect(rows.map((row) => [row.role, row.label, row.mark])).toEqual([
        ["manager", "Manager", "request"],
        ["worker", "Worker", "worker"],
        ["reviewer", "Reviewer", "reviewer"],
      ]);
      expect(rows.map((row) => row.text)).toEqual([
        "Claude · Opus 5 · thinking high · mode Bypass",
        "Claude · Opus 5 · thinking high",
        "Codex · GPT-5.6-Sol · thinking provider default · mode Auto",
      ]);
      // Whatever order the server sends is the order shown.
      const reversed = { ...settings, roles: [...settings.roles].reverse() };
      expect(roleRows(reversed, byProvider).map((row) => row.role)).toEqual(["reviewer", "worker", "manager"]);
    });

    it("show ids while the options are not loaded, or when they are for another provider", () => {
      const reviewer = settings.roles[2]!;
      expect(roleSettingText(reviewer)).toBe("Codex · gpt-5.6-sol · thinking provider default · mode auto");
      expect(roleSettingText(reviewer, claude)).toBe("Codex · gpt-5.6-sol · thinking provider default · mode auto");
      expect(roleRows(settings, () => undefined)[0]!.text).toBe("Claude · claude-opus-5 · thinking high · mode bypassPermissions");
    });

    it("say what the configuration does not set, and name an unknown provider by its id", () => {
      expect(roleSettingText(setting({ role: "worker", baseProvider: null, model: null, capability: "unknown" }))).toBe(
        "provider not set · model not set · thinking provider default",
      );
      expect(roleSettingText(setting({ role: "worker", baseProvider: "my-acp", model: "m1" }))).toBe("my-acp · m1 · thinking provider default");
      expect(providerLabel("opencode")).toBe("OpenCode");
      expect(providerLabel("pi")).toBe("Pi");
      expect(providerLabel("toString")).toBe("toString");
    });

    it("look up the options of each distinct base provider once, never of a bm-* alias", () => {
      const odd = { ...settings, roles: [...settings.roles, setting({ role: "worker", baseProvider: "bm-worker" }), setting({ role: "worker", baseProvider: null })] };
      expect(rowOptionProviders(odd)).toEqual(["claude", "codex"]);
    });

    it("always carry the notice that running agents keep their model", () => {
      expect(ROLES_APPLY_NOTICE).toBe("Changes apply to agents created after you save. Running agents keep their model and thinking.");
    });
  });

  describe("Edit form", () => {
    const form = (role: RoleSetting["role"], draft: Partial<ReturnType<typeof roleDraftOf>> = {}, options: RolesOptions | undefined = claude) => {
      const saved = settings.roles.find((entry) => entry.role === role)!;
      return roleFormView({ role, setting: saved, available: settings.providers, draft: { ...roleDraftOf(saved), ...draft }, options });
    };

    it("offers the available base providers, plus the current one when it is missing, never a bm-* alias", () => {
      expect(providerChoices(["claude", "codex"], "claude")).toEqual(["claude", "codex"]);
      expect(providerChoices(["codex", "bm-worker"], "claude")).toEqual(["claude", "codex"]);
      // Paseo could not say: only the role's current provider.
      expect(providerChoices([], "claude")).toEqual(["claude"]);
      expect(providerChoices([], null)).toEqual([]);
      expect(providerChoices([], "bm-worker")).toEqual([]);
      expect(form("worker").providers).toEqual(["claude", "codex", "opencode", "pi"]);
    });

    it("hides Thinking when the model has no levels; empty means the provider default", () => {
      expect(thinkingChoices(haiku)).toEqual([]);
      expect(thinkingChoices(null)).toEqual([]);
      expect(thinkingChoices(opus)).toEqual([
        { id: null, label: "Provider default (Medium)" },
        { id: "medium", label: "Medium" },
        { id: "high", label: "High" },
      ]);
      expect(thinkingChoices(codex.models[0])[0]).toEqual({ id: null, label: "Provider default" });
      const view = form("worker", { model: "claude-haiku" });
      expect(view.thinking).toEqual([]);
      // The level the old model had is dropped, so it is saved as "not set".
      expect(view.draft.thinkingOptionId).toBeNull();
      expect(saveSettingsInput("rev-1", "worker", view.draft)).toMatchObject({ model: "claude-haiku", thinkingOptionId: null });
    });

    it("never offers the Reviewer a dangerous or planning mode on a tiered provider", () => {
      const ids = (choices: ReturnType<typeof modeChoices>) => choices.map((choice) => choice.id);
      expect(ids(modeChoices("reviewer", claude))).toEqual([null, "default", "acceptEdits"]);
      expect(ids(modeChoices("reviewer", codex))).toEqual([null, "auto"]);
      expect(ids(modeChoices("worker", claude))).toEqual([null, "plan", "default", "acceptEdits", "bypassPermissions"]);
      expect(ids(modeChoices("manager", codex))).toEqual([null, "auto", "full-access"]);
      // Untiered (OpenCode agents): everything, for every role.
      expect(ids(modeChoices("reviewer", opencode))).toEqual([null, "build", "plan"]);
      // A dangerous mode set elsewhere is not kept for the Reviewer.
      const reviewer = form("reviewer", { baseProvider: "claude", model: "claude-opus-5", modeId: "bypassPermissions" }, claude);
      expect(reviewer.modes.map((choice) => choice.id)).not.toContain("bypassPermissions");
      expect(reviewer.draft.modeId).toBeNull();
    });

    it("hides Mode for a provider without modes (capability none)", () => {
      expect(modeChoices("worker", pi)).toEqual([]);
      const view = form("worker", { baseProvider: "pi", model: "claude-haiku", modeId: "default" }, pi);
      expect(view.modes).toEqual([]);
      expect(view.draft.modeId).toBeNull();
      expect(view.modeNote).toBeNull();
    });

    it("says when Paseo could not list the modes and saving clears the one set", () => {
      const unknown: RolesOptions = { ...claude, capability: "unknown", modes: [] };
      const view = form("manager", {}, unknown);
      expect(view.modes).toEqual([]);
      expect(view.draft.modeId).toBeNull();
      expect(view.modeNote).toBe("Paseo could not list the modes of Claude; saving clears the mode `bypassPermissions`.");
    });

    it("shows the price when the model has a cost", () => {
      expect(modelPriceText(opus)).toBe("~$5 / $25 per 1M tokens");
      expect(modelPriceText({ ...opus, cost: { inputUsdPerMTok: 0.25, cacheReadUsdPerMTok: 0.03, outputUsdPerMTok: 1.25 } })).toBe(
        "~$0.25 / $1.25 per 1M tokens",
      );
      expect(modelPriceText(haiku)).toBeNull();
      expect(form("worker").price).toBe("~$5 / $25 per 1M tokens");
    });

    it("asks for a model after a provider change, and cannot save while the options load", () => {
      const loading = form("worker", { baseProvider: "codex" }, undefined);
      expect(loading.blocker).toBe("Loading the models of Codex…");
      expect(loading.models).toEqual([]);
      // Options of the previous provider do not count for the new one.
      expect(form("worker", { baseProvider: "codex" }, claude).blocker).toBe("Loading the models of Codex…");
      const picked = form("worker", { baseProvider: "codex" }, codex);
      expect(picked.draft).toEqual({ baseProvider: "codex", model: null, thinkingOptionId: null, modeId: null });
      expect(picked.blocker).toBe("Pick a model.");
      expect(saveSettingsInput("rev-1", "worker", picked.draft)).toBeNull();
      const none = form("worker", { baseProvider: "codex" }, { ...codex, models: [] });
      expect(none.blocker).toBe("Paseo lists no model for Codex; pick another provider.");
      const chosen = form("worker", { baseProvider: "codex", model: "gpt-5.6-sol", thinkingOptionId: "high", modeId: "auto" }, codex);
      expect(chosen.blocker).toBeNull();
      expect(chosen.changed).toBe(true);
    });

    it("sends the revision roles.settings gave, and nothing when nothing changed", () => {
      const same = form("worker");
      expect(same.changed).toBe(false);
      const view = form("worker", { thinkingOptionId: "medium", modeId: "acceptEdits" });
      expect(view.changed).toBe(true);
      expect(saveSettingsInput(settings.revision, "worker", view.draft)).toEqual({
        revision: "rev-1",
        role: "worker",
        baseProvider: "claude",
        model: "claude-opus-5",
        thinkingOptionId: "medium",
        modeId: "acceptEdits",
      });
    });
  });

  describe("save", () => {
    const saved = setting({ role: "worker", baseProvider: "codex", model: "gpt-5.6-sol", thinkingOptionId: "high" });

    it("shows every warning the server returned", () => {
      const warnings = [
        "Manager and Worker share the codex plan: if the Worker hits its limit, the Manager stops too.",
        "Pi needs pi-mcp-adapter to give this role Paseo tools.",
      ];
      expect(savedNotes({ warnings })).toEqual([
        { text: "Saved.", tone: "success" },
        { text: warnings[0], tone: "warning" },
        { text: warnings[1], tone: "warning" },
      ]);
      expect(savedNotes({ warnings: [] })).toEqual([{ text: "Saved.", tone: "success" }]);
    });

    it("says exactly that the configuration changed elsewhere on a conflict", () => {
      const conflict = new Error("E_ROLE_SETTINGS_CONFLICT: the configuration changed elsewhere; reopen Roles & models");
      expect(saveErrorText(conflict)).toBe("The configuration changed elsewhere; reopen Roles & models.");
      expect(ROLES_CONFLICT_MESSAGE).toBe("The configuration changed elsewhere; reopen Roles & models.");
      expect(isSettingsConflict(conflict)).toBe(true);
      expect(isSettingsConflict(new Error("Request failed: E_ROLE_SETTINGS_CONFLICT: x"))).toBe(true);
      const invalid = new Error('E_ROLE_SETTINGS_INVALID: model "x" is not listed for codex');
      expect(isSettingsConflict(invalid)).toBe(false);
      expect(saveErrorText(invalid)).toBe('E_ROLE_SETTINGS_INVALID: model "x" is not listed for codex');
      expect(saveErrorText(new Error("E_ROLE_SETTINGS_WRITE_FAILED: Paseo did not keep the saved values"))).toContain("E_ROLE_SETTINGS_WRITE_FAILED");
    });

    it("puts the saved role and the new revision in place until roles.settings is refetched", () => {
      const next = applySavedRole(settings, { revision: "rev-2", role: saved });
      expect(next.revision).toBe("rev-2");
      expect(next.roles.map((entry) => entry.role)).toEqual(["manager", "worker", "reviewer"]);
      expect(next.roles[1]).toBe(saved);
      expect(next.roles[0]).toBe(settings.roles[0]);
      expect(next.providers).toBe(settings.providers);
    });
  });

  describe("fallback chains (delta 20260921 §4.3.1, §4.4.3)", () => {
    const CODEX = { baseProvider: "codex", model: "gpt-5.6-sol", thinkingOptionId: "high", modeId: "full-access" };
    const PI = { baseProvider: "pi", model: "claude-haiku", thinkingOptionId: null, modeId: null };
    const OPENCODE = { baseProvider: "opencode", model: "big-pickle", thinkingOptionId: null, modeId: "build" };
    const chain = (entries: Array<typeof CODEX | typeof PI>, policy: FallbackSettings["policy"] = "ask"): FallbackSettings => ({
      role: "worker",
      policy,
      entries: entries.map((entry, index) => ({
        ...entry,
        position: index + 1,
        alias: `bm-worker-fallback-${index + 1}`,
        capability: "tiered",
        cost: index === 0 ? { inputUsdPerMTok: 1.25, cacheReadUsdPerMTok: 0.125, outputUsdPerMTok: 10 } : null,
      })),
      patternsFromFile: false,
    });

    it("shows a block only for the roles roles.settings carries a chain for, in role order", () => {
      expect(fallbackBlocks(settings)).toEqual([]);
      const worker = chain([CODEX]);
      const reviewer = { ...chain([]), role: "reviewer" as const };
      expect(fallbackBlocks({ ...settings, fallback: { reviewer, worker } }).map((block) => block.role)).toEqual(["worker", "reviewer"]);
      expect(fallbackBlocks({ ...settings, fallback: { worker } })).toEqual([worker]);
      // The entries' providers are looked up too, so their rows get labels.
      expect(rowOptionProviders({ ...settings, fallback: { worker: chain([CODEX, PI]) } })).toEqual(["claude", "codex", "pi"]);
    });

    it("offers Ask me, Auto switch and Off, and reads a saved chain into a draft", () => {
      // Phase 2a-18 (§4.6) adds Auto switch; Ask me stays first, the default.
      expect(FALLBACK_POLICY_CHOICES.map((choice) => choice.label)).toEqual(["Ask me", "Auto switch", "Off"]);
      expect(fallbackDraftOf(chain([CODEX, PI], "off"))).toEqual({ policy: "off", entries: [CODEX, PI] });
      expect(fallbackDraftOf(chain([], "auto")).policy).toBe("auto");
    });

    it("warns about cost under Auto switch, and for the Manager that the chat may be replaced", () => {
      expect(fallbackPolicyWarning("worker", "auto")).toBe(
        "Auto switch replaces a stopped Worker without asking you; a fallback on a provider that bills by the token can cost money.",
      );
      expect(fallbackPolicyWarning("manager", "auto")).toMatch(/can cost money\. The chat you use may be replaced\.$/);
      expect(fallbackPolicyWarning("reviewer", "ask")).toBeNull();
      expect(fallbackPolicyWarning("manager", "off")).toBeNull();
      expect(saveFallbackInput("rev-1", "reviewer", { policy: "auto", entries: [] })).toMatchObject({ policy: "auto" });
    });

    it("labels an entry row from roles.options and prices a saved entry", () => {
      expect(fallbackEntryText(CODEX, codex)).toBe("Codex · GPT-5.6-Sol · thinking high · mode Full access");
      expect(fallbackEntryText(PI)).toBe("Pi · claude-haiku · thinking provider default");
      const saved = chain([CODEX, PI]);
      expect(fallbackPriceText(saved.entries[0]!)).toBe("~$1.25 / $10 per 1M tokens");
      expect(fallbackPriceText(saved.entries[1]!)).toBeNull();
    });

    it("add, remove and reorder produce the right roles.save-fallback payload", () => {
      let draft = fallbackDraftOf(chain([]));
      draft = addFallback(draft, CODEX);
      draft = addFallback(draft, PI);
      expect(saveFallbackInput("rev-1", "worker", draft)).toEqual({ revision: "rev-1", role: "worker", policy: "ask", entries: [CODEX, PI] });
      draft = moveFallback(draft, 1, -1);
      expect(draft.entries).toEqual([PI, CODEX]);
      // Moving past either end changes nothing.
      expect(moveFallback(draft, 0, -1)).toBe(draft);
      expect(moveFallback(draft, 1, 1)).toBe(draft);
      draft = removeFallback(draft, 0);
      expect(saveFallbackInput("rev-2", "worker", { ...draft, policy: "off" })).toEqual({
        revision: "rev-2",
        role: "worker",
        policy: "off",
        entries: [CODEX],
      });
      draft = replaceFallback(draft, 0, OPENCODE);
      expect(draft.entries).toEqual([OPENCODE]);
    });

    it("stops at three entries", () => {
      let draft = fallbackDraftOf(chain([CODEX, PI]));
      expect(canAddFallback(draft)).toBe(true);
      draft = addFallback(draft, OPENCODE);
      expect(canAddFallback(draft)).toBe(false);
      expect(addFallback(draft, CODEX)).toBe(draft);
    });

    it("knows when the draft differs from what is saved", () => {
      const saved = chain([CODEX, PI]);
      expect(fallbackDraftChanged(saved, fallbackDraftOf(saved))).toBe(false);
      expect(fallbackDraftChanged(saved, moveFallback(fallbackDraftOf(saved), 0, 1))).toBe(true);
      expect(fallbackDraftChanged(saved, { ...fallbackDraftOf(saved), policy: "off" })).toBe(true);
    });

    it("edits an entry with the role's own form, Reviewer rules included", () => {
      const view = roleFormView({
        role: "reviewer",
        setting: entryAsSetting("reviewer", null),
        available: settings.providers,
        draft: { baseProvider: "codex", model: "gpt-5.6-sol", thinkingOptionId: null, modeId: null },
        options: codex,
      });
      expect(view.modes.map((mode) => mode.id)).toEqual([null, "auto"]);
      expect(entryOfDraft(view.draft)).toEqual({ baseProvider: "codex", model: "gpt-5.6-sol", thinkingOptionId: null, modeId: null });
      expect(entryOfDraft({ baseProvider: "", model: null, thinkingOptionId: null, modeId: null })).toBeNull();
      expect(entryAsSetting("worker", CODEX)).toMatchObject({ role: "worker", providerId: "bm-worker", baseProvider: "codex", model: "gpt-5.6-sol", modeId: "full-access" });
    });

    it("shows the server's warnings after a save, and the conflict sentence on a stale revision", () => {
      const warnings = ["Fallback 1 runs on claude like the Worker itself: it only helps when the limit is per model."];
      expect(savedNotes({ warnings })).toEqual([
        { text: "Saved.", tone: "success" },
        { text: warnings[0], tone: "warning" },
      ]);
      expect(saveErrorText(new Error("E_ROLE_SETTINGS_CONFLICT: the configuration changed elsewhere; reopen Roles & models"))).toBe(
        "The configuration changed elsewhere; reopen Roles & models.",
      );
    });
  });
});

describe("the three tabs of the Setup screen (delta 20260925 §3.3)", () => {
  const source = readFileSync(fileURLToPath(new URL("../plugin/client/setup-screen.tsx", import.meta.url)), "utf8");

  it("names the three configurations the owner asked for, in that order, and opens on the first", () => {
    expect(SETUP_TABS.map((tab) => [tab.key, tab.label])).toEqual([
      ["tools", "Beads tools"],
      ["skills", "Agent skills"],
      ["agents", "Agents"],
    ]);
    // Every tab says what it holds, for the screen reader label.
    expect(SETUP_TABS.every((tab) => tab.hint.length > 0)).toBe(true);
    expect(DEFAULT_SETUP_TAB).toBe("tools");
    expect(SETUP_TABS.some((tab) => tab.key === DEFAULT_SETUP_TAB)).toBe(true);
  });

  it("draws one section at a time, through the same tab row the Beads board uses", () => {
    expect(source).toMatch(/<StatusTabs tabs=\{SETUP_TABS\} selected=\{tab\}/);
    for (const key of ["tools", "skills", "agents"]) {
      expect(source).toContain(`{tab !== "${key}" ? null : (`);
    }
    // The two role sections share the Agents tab: Roles & models and the
    // additional instructions are one configuration.
    const agents = source.slice(source.indexOf('{tab !== "agents" ? null : ('));
    expect(agents).toMatch(/<RolesSection/);
    expect(agents).toMatch(/Additional instructions/);
    expect(agents).toMatch(/<RoleCard/);
  });

  it("keeps the headline and the tool warnings above the tabs, so no tab can hide a problem", () => {
    const tabs = source.indexOf("<StatusTabs tabs={SETUP_TABS}");
    expect(tabs).toBeGreaterThan(0);
    const above = source.slice(0, tabs);
    expect(above).toMatch(/setupHeadline\(data\)/);
    expect(above).toMatch(/paseoToolsWarnings\(data\)/);
    expect(above).toMatch(/\{statusStrip\}/);
    // The version line and "This install" stay at the end of the screen,
    // outside the tabs, so they are readable whichever tab is open.
    const below = source.slice(source.lastIndexOf("<StatusTabs tabs={SETUP_TABS}"));
    const footer = below.slice(below.lastIndexOf("paseo-bm ${PLUGIN_VERSION}"));
    expect(footer).toMatch(/paseo-bm \$\{PLUGIN_VERSION\}/);
    expect(footer).toMatch(/dataHomeLine\(data\)/);
    expect(footer).toMatch(/PLUGIN_DIAGNOSTICS_LINE/);
  });
});

// ── "Set up paseo-bm" (0.4.0, design §7.13 / Dashboard §11.3) ──────────────

const skillRow = (name: string, ok: boolean) => ({
  name,
  required: true,
  claude: ok ? ("ok" as const) : ("missing" as const),
  codex: ok ? ("ok" as const) : ("missing" as const),
  pi: "missing" as const,
  opencode: "missing" as const,
  problem: null,
});

/** A machine where everything is already done, which every case below varies. */
function readyStatus(overrides: Partial<SetupStatus> = {}): SetupStatus {
  return {
    tools: [
      { id: "br", name: "br", purpose: "", required: true, path: "/usr/bin/br", version: "0.6.0", latestKnown: "0.6.0", installCommand: null, updateCommand: null, homepage: "" },
      { id: "bv", name: "bv", purpose: "", required: true, path: "/usr/bin/bv", version: "v0.25.0", latestKnown: "v0.25.0", installCommand: null, updateCommand: null, homepage: "" },
    ],
    latestCheckedOn: "2026-09-16",
    skills: {
      checkedAt: "2026-09-25T00:00:00.000Z",
      dirs: { shared: "/h/.agents/skills", claude: "/h/.claude/skills", codex: "/h/.codex/skills", pi: "/h/.pi/agent/skills", opencode: "/h/.config/opencode/skill" },
      skills: ["feature-workflow", "reviewing-plan", "converting-plan-to-beads", "polishing-beads", "implementing-beads"].map((name) => skillRow(name, true)),
      missingRequired: { claude: 0, codex: 0, pi: 5, opencode: 5 },
      installCommand: "npx -y skills add cuongntr/agent-skills …",
    },
    extras: { manager: 0, worker: 0, reviewer: 0 },
    setup: {
      roles: { present: ["manager", "worker", "reviewer"], missing: [], created: null, cleanedUpAt: null },
      agentTools: { injectIntoAgents: true, setBy: null },
      logins: [{ provider: "claude", roles: ["manager", "worker", "reviewer"], state: "logged-in", loginCommand: "claude auth login", guidance: null }],
      skillsRun: null,
      dataHome: { path: "/h/.paseo-bm", source: "default", reason: null },
      install: { kind: "other", pluginPath: null },
    },
    ...overrides,
  } as SetupStatus;
}

/** `readyStatus` with the machine-setup part changed. */
const withSetup = (setup: Partial<NonNullable<SetupStatus["setup"]>>, rest: Partial<SetupStatus> = {}): SetupStatus => {
  const base = readyStatus(rest);
  return { ...base, setup: { ...base.setup!, ...setup } } as SetupStatus;
};

describe("setupChecklist", () => {
  it("shows no card at all when nothing is missing", () => {
    expect(setupChecklist(readyStatus())).toEqual([]);
  });

  it("shows nothing for an older server that does not send the setup field", () => {
    const old = { ...readyStatus(), setup: undefined };
    expect(setupChecklist(old as SetupStatus)).toEqual([]);
  });

  it("names the missing roles, and carries the server's reason when there is one", () => {
    const status = withSetup({ roles: { present: ["manager"], missing: ["worker", "reviewer"], created: null, cleanedUpAt: null } });

    expect(setupChecklist(status)[0]).toEqual({
      key: "roles",
      title: "Roles",
      status: "Not created: Worker, Reviewer.",
      button: "Try again",
      action: { kind: "ensure-roles" },
      command: null,
    });
    expect(setupChecklist(status, "E_SETUP_ROLES_FAILED: Paseo reports no available provider")[0]?.status).toBe(
      "Not created: Worker, Reviewer. E_SETUP_ROLES_FAILED: Paseo reports no available provider",
    );
  });

  it("asks for the agent-tools switch only when Paseo says it is off", () => {
    expect(setupChecklist(withSetup({ agentTools: { injectIntoAgents: false, setBy: null } }))).toEqual([
      {
        key: "agent-tools",
        title: "Agent tools",
        status: "Off — the Manager may not be able to create a Worker.",
        button: "Allow agent tools…",
        action: { kind: "grant-agent-tools" },
        command: null,
      },
    ]);
    // Unknown is not off: a configuration that could not be read says nothing.
    expect(setupChecklist(withSetup({ agentTools: { injectIntoAgents: null, setBy: null } }))).toEqual([]);
  });

  it("counts the skills of the Worker's own provider, and of no other", () => {
    const claudeWorker = readyStatus();
    claudeWorker.skills.missingRequired = { claude: 2, codex: 0, pi: 5, opencode: 5 };

    expect(setupChecklist(claudeWorker)[0]).toMatchObject({
      key: "skills",
      status: "Required skills for the Worker (Claude Code): 3/5. The Worker works with lower quality without them.",
      button: "Install skills…",
      action: { kind: "install-skills" },
    });

    // A Claude Worker with all five is fine even when Codex is missing them.
    const codexMissing = readyStatus();
    codexMissing.skills.missingRequired = { claude: 0, codex: 5, pi: 5, opencode: 5 };
    expect(setupChecklist(codexMissing)).toEqual([]);
  });

  it("follows a Worker that runs on Codex", () => {
    const status = withSetup({
      logins: [
        { provider: "claude", roles: ["manager"], state: "logged-in", loginCommand: "claude auth login", guidance: null },
        { provider: "codex", roles: ["worker", "reviewer"], state: "logged-in", loginCommand: "codex login", guidance: null },
      ],
    });
    status.skills.missingRequired = { claude: 5, codex: 1, pi: 5, opencode: 5 };

    expect(setupChecklist(status)[0]?.status).toBe(
      "Required skills for the Worker (Codex): 4/5. The Worker works with lower quality without them.",
    );
  });

  it("shows no skills row for a Worker on a provider with no column", () => {
    const status = withSetup({
      logins: [{ provider: "something-else", roles: ["manager", "worker", "reviewer"], state: "logged-in", loginCommand: null, guidance: null }],
    });
    status.skills.missingRequired = { claude: 5, codex: 5, pi: 5, opencode: 5 };

    expect(setupChecklist(status)).toEqual([]);
  });

  it("shows no skills row when there is no Worker role yet", () => {
    const status = withSetup({
      roles: { present: ["manager"], missing: ["worker", "reviewer"], created: null, cleanedUpAt: null },
      logins: [{ provider: "claude", roles: ["manager"], state: "logged-in", loginCommand: "claude auth login", guidance: null }],
    });
    status.skills.missingRequired = { claude: 5, codex: 5, pi: 5, opencode: 5 };

    expect(setupChecklist(status).map((row) => row.key)).toEqual(["roles"]);
  });

  it("sends the user to the Beads tools tab for a missing br or bv", () => {
    const status = readyStatus();
    status.tools[0]!.path = null;

    expect(setupChecklist(status)[0]).toMatchObject({
      key: "tools",
      status: "Missing br — the Worker cannot manage beads without it",
      button: "Open Beads tools",
      action: { kind: "open-tab", tab: "tools" },
    });

    status.tools[1]!.path = null;
    expect(setupChecklist(status)[0]?.status).toBe("Missing br and bv — the Worker cannot manage beads without it");
  });

  it("reports a signed-out provider with its command, and says nothing about an unknown one", () => {
    const out = withSetup({
      logins: [{ provider: "codex", roles: ["manager", "worker"], state: "logged-out", loginCommand: "codex login", guidance: null }],
    });

    expect(setupChecklist(out).at(-1)).toEqual({
      key: "sign-in",
      title: "Sign-in",
      status: "`codex` (used by Manager, Worker) is not signed in. Sign in with: `codex login`",
      button: null,
      action: { kind: "none" },
      command: "codex login",
    });

    const unknown = withSetup({
      logins: [{ provider: "codex", roles: ["manager"], state: "unknown", loginCommand: "codex login", guidance: null }],
    });
    expect(setupChecklist(unknown)).toEqual([]);
  });

  it("shows Pi's guidance instead of a command", () => {
    const status = withSetup({
      logins: [
        {
          provider: "pi",
          roles: ["reviewer"],
          state: "logged-out",
          loginCommand: null,
          guidance: "Pi has no login command paseo-bm knows; sign in the way Pi's own documentation describes, then open Setup again.",
        },
      ],
    });

    expect(setupChecklist(status)[0]).toMatchObject({
      status:
        "`pi` (used by Reviewer) is not signed in. Pi has no login command paseo-bm knows; sign in the way Pi's own documentation describes, then open Setup again.",
      command: null,
    });
  });

  it("keeps the rows in the order a user has to work through them", () => {
    const status = withSetup({
      roles: { present: [], missing: ["manager", "worker", "reviewer"], created: null, cleanedUpAt: null },
      agentTools: { injectIntoAgents: false, setBy: null },
      logins: [{ provider: "claude", roles: ["worker"], state: "logged-out", loginCommand: "claude auth login", guidance: null }],
    });
    status.skills.missingRequired = { claude: 5, codex: 5, pi: 5, opencode: 5 };
    status.tools[0]!.path = null;

    expect(setupChecklist(status).map((row) => row.key)).toEqual(["roles", "agent-tools", "skills", "tools", "sign-in"]);
  });
});

describe("the migration banner", () => {
  it("appears only for a 0.3.x directory install, with its command", () => {
    expect(migrationBanner(withSetup({ install: { kind: "installer-directory", pluginPath: "/h/.paseo-bm/plugin/0.3.1" } }))).toEqual({
      text: MIGRATION_BANNER_TEXT,
      command: "npx paseo-bm@0.4.0",
    });
    expect(migrationBanner(readyStatus())).toBeNull();
    expect(migrationBanner({ ...readyStatus(), setup: undefined } as SetupStatus)).toBeNull();
  });

  it("promises that nothing is lost", () => {
    expect(MIGRATION_BANNER_TEXT).toBe(
      "This copy of paseo-bm was installed by the old npx installer. Switch it to the paseo.cafe install once: `npx paseo-bm@0.4.0`. Your roles, settings and history stay.",
    );
  });
});

describe("what Setup says after ensure-roles", () => {
  it("celebrates roles it just created, dismissably", () => {
    expect(ensureRolesLine({ created: ["manager", "worker", "reviewer"], baseProvider: "claude", model: "claude-opus-5", skipped: null })).toEqual({
      tone: "success",
      text: "paseo-bm created its roles with defaults (claude · claude-opus-5). Change them in Agents.",
      dismissable: true,
      button: null,
    });
  });

  it("says nothing when there was nothing to do", () => {
    expect(ensureRolesLine({ created: [], baseProvider: null, model: null, skipped: null })).toBeNull();
    expect(ensureRolesLine(null)).toBeNull();
  });

  it("offers to set up again after a cleanup, and shows no card", () => {
    const line = ensureRolesLine({ created: [], baseProvider: null, model: null, skipped: "cleaned-up" });

    expect(line).toEqual({
      tone: "warning",
      text: "paseo-bm's settings were removed. Remove the plugin with `paseo plugin remove paseo-bm`, or set it up again.",
      dismissable: false,
      button: "Set up again",
    });
  });

  it("shows a failure with its code and a way to retry", () => {
    const line = ensureRolesLine(null, new Error("E_SETUP_ROLES_FAILED: Paseo reports no available provider"));

    expect(line).toMatchObject({ tone: "danger", button: "Try again" });
    expect(line?.text).toContain("E_SETUP_ROLES_FAILED");
  });
});

describe("the two confirmations", () => {
  it("warns that the agent-tools switch is machine-wide, and defaults to cancel", () => {
    expect(AGENT_TOOLS_DIALOG.title).toBe("Allow Paseo's agent tools for every agent?");
    expect(AGENT_TOOLS_DIALOG.body).toContain("every agent on this machine");
    expect(AGENT_TOOLS_DIALOG.body).toContain("daemon.mcp.injectIntoAgents");
    expect(AGENT_TOOLS_DIALOG.confirmLabel).toBe("Allow for every agent");
    expect(AGENT_TOOLS_DIALOG.defaultAction).toBe("cancel");
  });

  it("shows the exact skills command and says whose tool it is", () => {
    const dialog = skillsDialog("npx -y skills add cuongntr/agent-skills -g -a claude-code codex -y");

    expect(dialog.title).toBe("Run the third-party skills CLI?");
    expect(dialog.body).toContain("npx -y skills add cuongntr/agent-skills -g -a claude-code codex -y");
    expect(dialog.body).toContain("another author");
    expect(dialog.body).toContain("paseo-bm never writes to your skills folders itself");
    expect(dialog.body).toContain("up to 5 minutes");
    expect(dialog.confirmLabel).toBe("Run it");
    expect(dialog.defaultAction).toBe("cancel");
  });
});

// ── the state of each item, shown where it is managed (0.4.0) ──────────────

describe("the Agents tab's own blocks", () => {
  it("says when paseo-bm created the roles, and with what", () => {
    const status = withSetup({
      roles: {
        present: ["manager", "worker", "reviewer"],
        missing: [],
        created: { at: "2026-09-25T09:00:00.000Z", roles: ["manager"], baseProvider: "claude", model: "claude-opus-5" },
        cleanedUpAt: null,
      },
    });

    const line = rolesCreatedLine(status);
    expect(line).toContain("Created by paseo-bm on ");
    expect(line).toContain("with defaults (claude · claude-opus-5). Change them here.");
    expect(rolesCreatedLine(readyStatus())).toBeNull();
  });

  it("describes the agent-tools switch in each of its states", () => {
    expect(agentToolsBlock(withSetup({ agentTools: { injectIntoAgents: true, setBy: "plugin" } }))).toEqual({
      text: "On for every agent, turned on by paseo-bm",
      tone: "muted",
      button: null,
    });
    expect(agentToolsBlock(withSetup({ agentTools: { injectIntoAgents: true, setBy: null } }))).toEqual({
      text: "On for every agent",
      tone: "muted",
      button: null,
    });
    expect(agentToolsBlock(withSetup({ agentTools: { injectIntoAgents: false, setBy: null } }))).toEqual({
      text: "Off — the Manager may not be able to create a Worker",
      tone: "warning",
      button: "Allow agent tools…",
    });
    expect(agentToolsBlock(withSetup({ agentTools: { injectIntoAgents: null, setBy: null } }))).toMatchObject({
      tone: "warning",
      button: null,
    });
    expect(agentToolsBlock({ ...readyStatus(), setup: undefined } as SetupStatus)).toBeNull();
  });

  it("shows one sign-in row per provider, and never a button that logs in", () => {
    const rows = signInRows(
      withSetup({
        logins: [
          { provider: "claude", roles: ["manager", "worker"], state: "logged-in", loginCommand: "claude auth login", guidance: null },
          { provider: "codex", roles: ["reviewer"], state: "logged-out", loginCommand: "codex login", guidance: null },
          { provider: "pi", roles: ["reviewer"], state: "logged-out", loginCommand: null, guidance: "Sign in the way Pi documents." },
          { provider: "opencode", roles: ["manager"], state: "unknown", loginCommand: "opencode providers login", guidance: null },
        ],
      }),
    );

    expect(rows).toEqual([
      { provider: "claude", usedBy: "used by Manager, Worker", text: "Signed in", tone: "muted", command: null },
      {
        provider: "codex",
        usedBy: "used by Reviewer",
        text: "Not signed in — sign in with `codex login`",
        tone: "warning",
        command: "codex login",
      },
      { provider: "pi", usedBy: "used by Reviewer", text: "Sign in the way Pi documents.", tone: "warning", command: null },
      { provider: "opencode", usedBy: "used by Manager", text: "Unknown", tone: "muted", command: null },
    ]);
  });
});

describe("the Agent skills tab", () => {
  it("says when the CLI last ran", () => {
    const status = withSetup({
      skillsRun: { at: "2026-09-25T09:30:00.000Z", command: "npx -y skills add x", code: 0, outcome: "ok" },
    });

    expect(skillsRunLine(status)).toContain("· exit 0");
    expect(skillsRunLine(readyStatus())).toBeNull();
  });

  it("offers the Install button only while some agent is missing a skill", () => {
    expect(anySkillMissing(readyStatus())).toBe(true); // Pi and OpenCode have none.
    const everywhere = readyStatus();
    everywhere.skills.missingRequired = { claude: 0, codex: 0, pi: 0, opencode: 0 };
    expect(anySkillMissing(everywhere)).toBe(false);
  });

  it("no longer sends anyone to the retired installer", () => {
    expect(SKILLS_COMMAND_LABEL).toBe(
      "Install the required skills for Claude Code and Codex: press Install skills, or run it yourself",
    );
    expect(SKILLS_COMMAND_LABEL).not.toContain("npx paseo-bm");
  });
});

describe("the \"This install\" block", () => {
  it("names the data folder and how it was found", () => {
    expect(dataHomeLine(readyStatus())).toEqual({ text: "Data folder: `/h/.paseo-bm` (default)", tone: "muted" });
    expect(dataHomeLine(withSetup({ dataHome: { path: "/opt/bm", source: "env", reason: null } }))?.text).toBe(
      "Data folder: `/opt/bm` (set by PASEO_BM_HOME)",
    );
    expect(dataHomeLine(withSetup({ dataHome: { path: "/opt/bm", source: "pointer", reason: null } }))?.text).toBe(
      "Data folder: `/opt/bm` (from ~/.paseo-bm/home.json)",
    );
  });

  it("reports a folder it cannot use, with the reason", () => {
    const line = dataHomeLine(withSetup({ dataHome: { path: null, source: null, reason: "PASEO_BM_HOME must be an absolute path" } }));

    expect(line).toEqual({
      text: "paseo-bm cannot use its data folder: PASEO_BM_HOME must be an absolute path",
      tone: "danger",
    });
  });

  it("points at Paseo's own commands for a plugin that will not load", () => {
    expect(PLUGIN_DIAGNOSTICS_LINE).toBe(
      "If paseo-bm does not load at all, check `paseo plugin ls` and `paseo plugin logs paseo-bm`.",
    );
  });
});

// ── "Remove paseo-bm's settings" (0.4.0, design §7.13.7) ───────────────────

describe("the two questions before a cleanup", () => {
  it("says what goes, and warns about running agents", () => {
    const warning = cleanupWarning(readyStatus());

    expect(warning).toBe(
      "This removes every bm-* provider and agent profile from Paseo (the three roles and their fallbacks). " +
        "Agents already running on these roles will fail on their next turn: archive them first. Skills, br and bv stay.",
    );
  });

  it("adds the switch clause only when paseo-bm turned it on and it is still on", () => {
    expect(cleanupWarning(withSetup({ agentTools: { injectIntoAgents: true, setBy: "plugin" } }))).toContain(
      ", and turns Paseo's agent tools back off (paseo-bm turned them on).",
    );
    // On, but somebody else turned it on: it is not ours to take away.
    expect(cleanupWarning(withSetup({ agentTools: { injectIntoAgents: true, setBy: null } }))).not.toContain("agent tools back off");
    expect(cleanupWarning(withSetup({ agentTools: { injectIntoAgents: false, setBy: "plugin" } }))).not.toContain("agent tools back off");
  });

  it("asks about the data separately, naming the folder, and defaults to keeping it", () => {
    expect(cleanupDataQuestion(readyStatus())).toBe(
      "Also delete paseo-bm's data in `/h/.paseo-bm`: history (traces), extra instructions, fallback settings and incidents? " +
        "One small file stays so the roles are not re-created before you remove the plugin, and files left by the old installer stay.",
    );
    expect(CLEANUP_DATA_DIALOG.defaultAction).toBe("keep");
    expect(CLEANUP_DATA_DIALOG.keepLabel).toBe("Keep my data");
    expect(CLEANUP_WARNING_DIALOG.defaultAction).toBe("cancel");
  });

  it("sends the answer it was given, and nothing else", () => {
    expect(cleanupInput(false)).toEqual({ confirmed: true, deleteData: false });
    expect(cleanupInput(true)).toEqual({ confirmed: true, deleteData: true });
  });
});

describe("what the screen says after a cleanup", () => {
  const base = {
    removedProviders: ["bm-manager", "bm-worker", "bm-reviewer"],
    removedProfiles: ["bm-manager", "bm-worker", "bm-reviewer"],
  };

  it("counts what went, and names the next command", () => {
    const report = cleanupReport({ ...base, agentTools: "restored", data: null });

    expect(report.lines[0]).toBe("Removed 3 providers and 3 agent profiles.");
    expect(report.lines).toContain("Paseo's agent tools are back to what they were before paseo-bm.");
    expect(report.lines).toContain("Your data was kept.");
    expect(report.nextCommand).toBe("paseo plugin remove paseo-bm");
    expect(CLEANUP_NEXT_LINE).toBe("Now remove the plugin: `paseo plugin remove paseo-bm`");
  });

  it("explains a switch it did not turn off", () => {
    expect(cleanupReport({ ...base, agentTools: "left-on", data: null }).lines).toContain(
      "Paseo's agent tools are left on — they were not turned on by paseo-bm.",
    );
    expect(cleanupReport({ ...base, agentTools: "off", data: null }).lines).toContain("Paseo's agent tools were already off.");
  });

  it("lists what it deleted and what it kept", () => {
    const report = cleanupReport({
      ...base,
      agentTools: "off",
      data: { deleted: ["traces", "role-extras.json"], kept: ["ui/setup-state.json (it records that you removed paseo-bm's settings)"] },
    });

    expect(report.lines).toContain("Deleted: traces, role-extras.json");
    expect(report.lines.join("\n")).toContain("Kept: ui/setup-state.json");
  });

  it("says so when there was nothing to delete", () => {
    expect(cleanupReport({ ...base, agentTools: "off", data: { deleted: [], kept: [] } }).lines).toContain(
      "No data files were deleted.",
    );
  });

  it("gets the singular right", () => {
    expect(cleanupReport({ removedProviders: ["bm-manager"], removedProfiles: ["bm-manager"], agentTools: "off", data: null }).lines[0]).toBe(
      "Removed 1 provider and 1 agent profile.",
    );
  });
});
