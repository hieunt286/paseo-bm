import { describe, expect, it } from "vitest";
import {
  FALLBACK_AUTO_RETIRED_ACK,
  FALLBACK_AUTO_RETIRED_NOTICE,
  FALLBACK_POLICY_CHOICES,
  ROLES_APPLY_NOTICE,
  ROLES_CONFLICT_MESSAGE,
  SAME_FAMILY_NOTICE,
  SETUP_ROLES,
  addFallback,
  applySavedRole,
  canAddFallback,
  entryAsSetting,
  entryOfDraft,
  fallbackAutoRetiredNotice,
  fallbackBlocks,
  fallbackDraftChanged,
  fallbackDraftOf,
  fallbackEntryText,
  fallbackPriceText,
  isSettingsConflict,
  modeChoices,
  modelPriceText,
  moveFallback,
  providerChoices,
  providerLabel,
  removeFallback,
  replaceFallback,
  reviewerFamilyNote,
  roleBoundaryNote,
  roleDraftOf,
  roleFormView,
  roleRows,
  roleSettingText,
  rowOptionProviders,
  saveErrorText,
  saveFallbackInput,
  saveSettingsInput,
  savedNotes,
  thinkingChoices,
} from "../plugin/client/settings-roles-model";
import { rolesSaveSettingsRpc } from "../plugin/shared/contracts";
import type { FallbackSettings, RoleModelOption, RoleSetting, RolesOptions, RolesSettings } from "../plugin/shared/contracts";

/**
 * What Settings → Agents shows and saves about the roles and their fallback
 * chains (`settings-roles-model.ts`), without a renderer.
 */

describe("the roles Settings shows", () => {
  it("are the four, each with its mark", () => {
    expect(SETUP_ROLES.map((entry) => entry.mark)).toEqual(["request", "worker", "reviewer", "orchestrator"]);
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
      setting({ role: "orchestrator", modeId: "default" }),
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
        ["orchestrator", "Orchestrator", "orchestrator"],
      ]);
      expect(rows.map((row) => row.text)).toEqual([
        "Claude · Opus 5 · thinking high · mode Bypass",
        "Claude · Opus 5 · thinking high",
        "Codex · GPT-5.6-Sol · thinking provider default · mode Auto",
        "Claude · Opus 5 · thinking provider default · mode Default",
      ]);
      // Whatever order the server sends is the order shown.
      const reversed = { ...settings, roles: [...settings.roles].reverse() };
      expect(roleRows(reversed, byProvider).map((row) => row.role)).toEqual(["orchestrator", "reviewer", "worker", "manager"]);
    });

    it("give the Orchestrator a fourth card with its own model, thinking and mode, and no fallback (orchestrator design §3.1)", () => {
      const worker: FallbackSettings = { role: "worker", policy: "ask", entries: [], patternsFromFile: false };
      const withChains: RolesSettings = { ...settings, fallback: { manager: { ...worker, role: "manager" }, worker, reviewer: { ...worker, role: "reviewer" } } };
      const rows = roleRows(withChains, byProvider);
      expect(rows).toHaveLength(4);
      // The three older roles keep their chains; the Orchestrator's row has none, so no "Add fallback" button.
      expect(rows.map((row) => [row.role, row.fallback?.role ?? null])).toEqual([
        ["manager", "manager"],
        ["worker", "worker"],
        ["reviewer", "reviewer"],
        ["orchestrator", null],
      ]);
      expect(fallbackBlocks(withChains).map((block) => block.role)).toEqual(["manager", "worker", "reviewer"]);
      // Its card is listed with the others.
      expect(SETUP_ROLES.map((entry) => [entry.role, entry.label])).toEqual([
        ["manager", "Manager"],
        ["worker", "Worker"],
        ["reviewer", "Reviewer"],
        ["orchestrator", "Orchestrator"],
      ]);
    });

    it("saves every card's settings through the existing RPC; the additional instructions are retired (autonomy design §B.8)", () => {
      for (const { role } of SETUP_ROLES) {
        const draft = { baseProvider: "claude", model: "claude-opus-5", thinkingOptionId: null, modeId: null };
        expect(rolesSaveSettingsRpc.input.safeParse(saveSettingsInput("rev-1", role, draft)).success).toBe(true);
      }
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

  /** Independent review by default (autonomy design §C.5, §C.6; REQ-133). */
  describe("the Reviewer's model family", () => {
    const withRoles = (worker: Partial<RoleSetting>, reviewer: Partial<RoleSetting>): RolesSettings => ({
      ...settings,
      roles: settings.roles.map((entry) =>
        entry.role === "worker" ? { ...entry, ...worker } : entry.role === "reviewer" ? { ...entry, ...reviewer } : entry,
      ),
    });

    it("says in one line when the Reviewer runs on the Worker's family", () => {
      expect(SAME_FAMILY_NOTICE).toBe("The Reviewer runs on the same model family as the Worker, so its review is less independent.");
      expect(SAME_FAMILY_NOTICE.split("\n")).toHaveLength(1);
      const same = { text: SAME_FAMILY_NOTICE, tone: "warning" };
      expect(reviewerFamilyNote(withRoles({}, { baseProvider: "claude", model: "claude-sonnet-5" }))).toEqual(same);
      // The family is the vendor, not the provider: OpenCode on openai/… is the Codex Worker's.
      expect(reviewerFamilyNote(withRoles({ baseProvider: "codex", model: "gpt-5.6-sol" }, { baseProvider: "opencode", model: "openai/gpt-5.6" }))).toEqual(same);
    });

    it("says nothing when the families differ", () => {
      // The owner's own set-up: the Reviewer on Codex, the others on Claude.
      expect(reviewerFamilyNote(settings)).toBeNull();
      expect(reviewerFamilyNote(withRoles({}, { baseProvider: "opencode", model: "google/gemini-3-pro" }))).toBeNull();
      expect(reviewerFamilyNote(withRoles({ baseProvider: "opencode", model: "big-pickle" }, { baseProvider: "pi", model: "big-pickle" }))).toBeNull();
    });

    it("says nothing when either family is unknown", () => {
      expect(reviewerFamilyNote(withRoles({ baseProvider: null, model: null }, { baseProvider: null, model: null }))).toBeNull();
      expect(reviewerFamilyNote(withRoles({ baseProvider: "opencode", model: null }, { baseProvider: "opencode", model: null }))).toBeNull();
      expect(reviewerFamilyNote(withRoles({ baseProvider: "bm-worker" }, { baseProvider: "bm-worker" }))).toBeNull();
      expect(reviewerFamilyNote({ ...settings, roles: settings.roles.filter((entry) => entry.role !== "reviewer") })).toBeNull();
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

    it("puts the Orchestrator under the Reviewer's mode rule, and edits its model and thinking like any role", () => {
      const ids = (choices: ReturnType<typeof modeChoices>) => choices.map((choice) => choice.id);
      expect(ids(modeChoices("orchestrator", claude))).toEqual([null, "default", "acceptEdits"]);
      expect(ids(modeChoices("orchestrator", codex))).toEqual([null, "auto"]);
      expect(ids(modeChoices("orchestrator", opencode))).toEqual([null, "build", "plan"]);
      expect(modeChoices("orchestrator", pi)).toEqual([]);
      const view = form("orchestrator", { modeId: "bypassPermissions" });
      expect(view.models.map((model) => model.id)).toEqual(["claude-opus-5", "claude-haiku"]);
      expect(view.thinking.map((choice) => choice.id)).toEqual([null, "medium", "high"]);
      expect(view.modes.map((choice) => choice.id)).toEqual([null, "default", "acceptEdits"]);
      expect(view.draft.modeId).toBeNull();
      // Saved through roles.save-settings, like the other three.
      const edited = form("orchestrator", { thinkingOptionId: "high", modeId: "acceptEdits" });
      expect(edited.changed).toBe(true);
      expect(saveSettingsInput(settings.revision, "orchestrator", edited.draft)).toEqual({
        revision: "rev-1",
        role: "orchestrator",
        baseProvider: "claude",
        model: "claude-opus-5",
        thinkingOptionId: "high",
        modeId: "acceptEdits",
      });
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
      expect(next.roles.map((entry) => entry.role)).toEqual(["manager", "worker", "reviewer", "orchestrator"]);
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

    it("offers Ask me and Off only, and reads a saved chain into a draft", () => {
      // ADR-022 decision 4: the Auto switch is retired; Ask me stays first, the default.
      expect(FALLBACK_POLICY_CHOICES.map((choice) => [choice.id, choice.label])).toEqual([
        ["ask", "Ask me"],
        ["off", "Off"],
      ]);
      expect(fallbackDraftOf(chain([CODEX, PI], "off"))).toEqual({ policy: "off", entries: [CODEX, PI] });
    });

    it("says once that a chain saved with the retired Auto switch now asks, until that chain is saved again (ADR-022 decision 4)", () => {
      const retired: FallbackSettings = { ...chain([CODEX]), migratedFromAuto: true };
      expect(FALLBACK_AUTO_RETIRED_NOTICE).toBe(
        "Auto switch was retired: this role now asks you. Set the project to Cruise or above in Settings → Autonomy to let the Orchestrator answer it.",
      );
      expect(fallbackAutoRetiredNotice(retired)).toBe(FALLBACK_AUTO_RETIRED_NOTICE);
      expect(fallbackAutoRetiredNotice(chain([CODEX]))).toBeNull();
      expect(fallbackAutoRetiredNotice({ ...chain([CODEX]), migratedFromAuto: false })).toBeNull();
      expect(FALLBACK_AUTO_RETIRED_ACK).toBe("Got it");
      // The block reads as Ask me; saving it as shown writes Ask me, which ends the notice.
      expect(fallbackDraftOf(retired)).toEqual({ policy: "ask", entries: [CODEX] });
      expect(fallbackDraftChanged(retired, fallbackDraftOf(retired))).toBe(true);
      expect(saveFallbackInput("rev-1", "worker", fallbackDraftOf(retired))).toEqual({ revision: "rev-1", role: "worker", policy: "ask", entries: [CODEX] });
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

/**
 * Settings → Agents says per role whether the action boundary can apply
 * (autonomy design §D.2, §D.4, change-010 C6): off for a mode hand-set on the
 * profile and for a provider left on detection; a Claude or Codex Worker or
 * Reviewer in its boundary mode shows no off line, only where it is turned on.
 */
describe("the action boundary per role (§D.2, §D.4)", () => {
  const role = (overrides: Partial<RoleSetting> & Pick<RoleSetting, "role">): RoleSetting => ({
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

  it("a hand-set profile mode and a provider on detection show the off line, pointing to Settings → Autonomy", () => {
    const handSet = roleBoundaryNote(role({ role: "worker", modeId: "acceptEdits" }))!;
    expect(handSet.tone).toBe("warning");
    expect(handSet.text).toMatch(/^Action boundary: off for this role — its mode is set by hand/);
    expect(handSet.text).toContain("Settings → Autonomy");
    for (const baseProvider of ["opencode", "pi", null]) {
      const note = roleBoundaryNote(role({ role: "reviewer", baseProvider, capability: baseProvider === "pi" ? "none" : "untiered" }))!;
      expect(note.tone, String(baseProvider)).toBe("warning");
      expect(note.text, String(baseProvider)).toMatch(/^Action boundary: off for this role — (OpenCode|Pi|this provider) is only watched/);
    }
  });

  it("a Claude or Codex Worker or Reviewer in its boundary mode shows no off line; the Manager and the Orchestrator none at all", () => {
    for (const baseProvider of ["claude", "codex"]) {
      for (const which of ["worker", "reviewer"] as const) {
        const note = roleBoundaryNote(role({ role: which, baseProvider }))!;
        expect(note.tone).toBe("muted");
        expect(note.text).not.toMatch(/off for this role/);
        expect(note.text).toContain("Settings → Autonomy");
      }
    }
    expect(roleBoundaryNote(role({ role: "manager" }))).toBeNull();
    expect(roleBoundaryNote(role({ role: "orchestrator" }))).toBeNull();
  });
});
