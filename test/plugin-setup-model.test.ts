import { describe, expect, it } from "vitest";
import {
  FALLBACK_POLICY_CHOICES,
  ROLES_APPLY_NOTICE,
  ROLES_CONFLICT_MESSAGE,
  SETUP_ROLES,
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

    it("offers Ask me and Off, and reads a saved chain into a draft", () => {
      expect(FALLBACK_POLICY_CHOICES.map((choice) => choice.label)).toEqual(["Ask me", "Off"]);
      expect(fallbackDraftOf(chain([CODEX, PI], "off"))).toEqual({ policy: "off", entries: [CODEX, PI] });
      // A hand-written auto reads as Ask me until Auto switch exists (phase 2a-18).
      expect(fallbackDraftOf(chain([], "auto")).policy).toBe("ask");
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
