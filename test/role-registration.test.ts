/**
 * Role registration (bm-wp-107-2r5.3, ADR-006 decisions 1, 2, 3, 5, 9).
 *
 * Runs against the same fixture as `paseo-config.test.ts`: a `config.json`
 * that already carries six `room-*` providers and six `room-*` profiles plus
 * the user's own. The central assertions are
 *
 * 1. every entry that is not `bm-*` comes out of the write byte-identical and
 *    the profiles array keeps its order;
 * 2. a re-run with the same roles writes nothing and does not reload;
 * 3. `paseoTools` is on for manager and worker and absent for reviewer.
 *
 * Nothing touches a real `~/.paseo`: a `mkdtemp` fake home, and a `paseo`
 * stand-in that only offers `daemonReload`.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { DaemonReload } from "../src/paseo/adapter.js";
import type { PaseoConfig } from "../src/paseo/config.js";
import { AGENT_PROFILES_PATH, PROVIDERS_PATH, agentProfileIds, bmProviderIds } from "../src/paseo/config.js";
import type { RoleSelection } from "../src/roles/config.js";
import {
  ROLE_PROFILE_NOTES,
  RoleRegistrationError,
  registerRoles,
  roleProviderEntry,
  roleRegistrationEdit,
} from "../src/roles/register.js";

const FIXTURE = fileURLToPath(new URL("./fixtures/paseo-config.room.json", import.meta.url));
const FIXTURE_TEXT = readFileSync(FIXTURE, "utf8");

const ROOM_IDS = ["room-architect", "room-builder", "room-tester", "room-scribe", "room-scout", "room-sentinel"] as const;
const USER_PROVIDERS = ["anthropic", "openai"] as const;
const FIXTURE_PROFILE_ORDER = ["my-default", ...ROOM_IDS];

const SELECTIONS: readonly RoleSelection[] = [
  { role: "manager", displayName: "Beads Manager", provider: "anthropic", model: "claude-opus-5", paseoTools: true, source: "flag" },
  { role: "worker", displayName: "Beads Worker", provider: "openai", model: "gpt-5.6-sol", paseoTools: true, source: "flag" },
  { role: "reviewer", displayName: "Beads Reviewer", provider: "anthropic", model: "claude-sonnet-5", paseoTools: false, source: "flag" },
];

let scratch: string;
let paseoHome: string;
let installHome: string;
let configPath: string;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "paseo-bm-roles-"));
  paseoHome = join(scratch, "home", ".paseo");
  installHome = join(scratch, "home", ".paseo-bm");
  configPath = join(paseoHome, "config.json");
  mkdirSync(paseoHome, { recursive: true });
  writeFileSync(configPath, FIXTURE_TEXT, { mode: 0o644 });
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

/* ------------------------------------------------------------- utilities */

function readText(): string {
  return readFileSync(configPath, "utf8");
}

function readConfig(): PaseoConfig {
  return JSON.parse(readText()) as PaseoConfig;
}

function providersOf(config: PaseoConfig): Record<string, Record<string, unknown>> {
  return (config["agents"] as Record<string, unknown>)["providers"] as Record<string, Record<string, unknown>>;
}

function profilesOf(config: PaseoConfig): Record<string, unknown>[] {
  return (config["daemon"] as Record<string, unknown>)["agentProfiles"] as Record<string, unknown>[];
}

/** The balanced JSON value starting at `open`, as raw text. */
function balanced(text: string, open: number): string {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = open; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{" || char === "[") depth += 1;
    else if (char === "}" || char === "]") {
      depth -= 1;
      if (depth === 0) return text.slice(open, index + 1);
    }
  }
  throw new Error("Unbalanced JSON text");
}

function memberSlice(text: string, key: string): string {
  const needle = `${JSON.stringify(key)}: `;
  const at = text.indexOf(needle);
  if (at === -1) throw new Error(`No member named ${key}`);
  return balanced(text, at + needle.length);
}

function entrySlice(text: string, id: string): string {
  const at = text.indexOf(`"id": ${JSON.stringify(id)}`);
  if (at === -1) throw new Error(`No array entry with id ${id}`);
  return balanced(text, text.lastIndexOf("{", at));
}

function fakeAdapter(): { daemonReload(): Promise<DaemonReload>; readonly calls: number[] } {
  const calls: number[] = [];
  return {
    calls,
    async daemonReload(): Promise<DaemonReload> {
      calls.push(calls.length + 1);
      return { appliedPaths: ["daemon", "agents"], raw: {} };
    },
  };
}

function register(adapter = fakeAdapter(), selections: readonly RoleSelection[] = SELECTIONS) {
  return registerRoles({ paseoHome, installHome, selections, adapter });
}

/* ------------------------------------------------------------------ tests */

describe("registerRoles next to paseo-room", () => {
  it("leaves every room-* and user entry byte-identical and keeps the profile order", async () => {
    const before = readText();
    const result = await register();
    const after = readText();

    expect(result.changed).toBe(true);
    for (const id of [...ROOM_IDS, ...USER_PROVIDERS]) {
      expect(memberSlice(after, id), `provider ${id} changed`).toBe(memberSlice(before, id));
    }
    for (const id of FIXTURE_PROFILE_ORDER) {
      expect(entrySlice(after, id), `profile ${id} changed`).toBe(entrySlice(before, id));
    }

    const config = readConfig();
    expect(agentProfileIds(config)).toEqual([...FIXTURE_PROFILE_ORDER, "bm-manager", "bm-worker", "bm-reviewer"]);
    expect(Object.keys(providersOf(config))).toEqual([...USER_PROVIDERS, ...ROOM_IDS, "bm-manager", "bm-worker", "bm-reviewer"]);
    expect(result.providerIds).toEqual(["bm-manager", "bm-worker", "bm-reviewer"]);
    expect(result.profileIds).toEqual(["bm-manager", "bm-worker", "bm-reviewer"]);
    expect(result.config.changedPaths).toEqual([
      `${PROVIDERS_PATH}.bm-manager`,
      `${PROVIDERS_PATH}.bm-worker`,
      `${PROVIDERS_PATH}.bm-reviewer`,
      `${AGENT_PROFILES_PATH}[bm-manager]`,
      `${AGENT_PROFILES_PATH}[bm-worker]`,
      `${AGENT_PROFILES_PATH}[bm-reviewer]`,
    ]);
  });

  it("writes derived providers with only extends, label and paseoTools — no command, no env", async () => {
    await register();
    const providers = providersOf(readConfig());

    for (const selection of SELECTIONS) {
      const entry = providers[`bm-${selection.role}`]!;
      expect(entry).not.toHaveProperty("command");
      expect(entry).not.toHaveProperty("env");
      for (const key of Object.keys(entry)) {
        expect(["extends", "label", "paseoTools"]).toContain(key);
      }
      expect(entry["extends"]).toBe(selection.provider);
      expect(entry["label"]).toBe(selection.displayName);
    }
  });

  it("writes one profile per role, pointing at the derived provider and carrying notes", async () => {
    await register();
    const profiles = profilesOf(readConfig()).filter((profile) => String(profile["id"]).startsWith("bm-"));

    expect(profiles).toEqual(
      SELECTIONS.map((selection) => ({
        id: `bm-${selection.role}`,
        name: selection.displayName,
        provider: `bm-${selection.role}`,
        model: selection.model,
        notes: ROLE_PROFILE_NOTES[selection.role],
      })),
    );
    for (const profile of profiles) {
      expect(String(profile["notes"]).length).toBeGreaterThan(0);
    }
  });

  it("gives every bm-* profile the `provider` key Paseo's schema requires, never `providerId`", async () => {
    await register();
    const profiles = profilesOf(readConfig()).filter((profile) => String(profile["id"]).startsWith("bm-"));

    expect(profiles).toHaveLength(3);
    for (const profile of profiles) {
      expect(typeof profile["provider"]).toBe("string");
      expect(String(profile["provider"]).length).toBeGreaterThan(0);
      expect(profile).not.toHaveProperty("providerId");
    }
  });

  it("does not rewrite or reload when every entry is already correct", async () => {
    await register();
    const before = readText();
    const mtime = statSync(configPath, { bigint: true }).mtimeNs;
    const adapter = fakeAdapter();

    const result = await register(adapter);

    expect(result.changed).toBe(false);
    expect(result.config.written).toBe(false);
    expect(result.config.changedPaths).toEqual([]);
    expect(result.config.verification).toBe("not-needed");
    expect(adapter.calls).toEqual([]);
    expect(readText()).toBe(before);
    expect(statSync(configPath, { bigint: true }).mtimeNs).toBe(mtime);
  });

  it("rewrites only the bm-* entry that drifted, in place", async () => {
    await register();
    const before = readText();

    const changedWorker = SELECTIONS.map((selection) =>
      selection.role === "worker" ? { ...selection, model: "gpt-5.6-mini" } : selection,
    );
    const result = await register(fakeAdapter(), changedWorker);
    const after = readText();

    expect(result.config.changedPaths).toEqual([`${AGENT_PROFILES_PATH}[bm-worker]`]);
    for (const id of [...FIXTURE_PROFILE_ORDER, "bm-manager", "bm-reviewer"]) {
      expect(entrySlice(after, id)).toBe(entrySlice(before, id));
    }
    expect(agentProfileIds(readConfig())).toEqual([...FIXTURE_PROFILE_ORDER, "bm-manager", "bm-worker", "bm-reviewer"]);
  });
});

describe("paseoTools per role", () => {
  it("is enabled for manager and worker and absent for reviewer in the written file", async () => {
    await register();
    const providers = providersOf(readConfig());

    expect(providers["bm-manager"]!["paseoTools"]).toEqual({ enabled: true });
    expect(providers["bm-worker"]!["paseoTools"]).toEqual({ enabled: true });
    expect(providers["bm-reviewer"]).not.toHaveProperty("paseoTools");
    expect(bmProviderIds(readConfig())).toEqual(["bm-manager", "bm-worker", "bm-reviewer"]);
  });

  it("never grants the reviewer tools, even if a caller's selection says otherwise", () => {
    const reviewer = { ...SELECTIONS[2]!, paseoTools: true };
    expect(roleProviderEntry(reviewer)).toEqual({ extends: "anthropic", label: "Beads Reviewer" });

    const manager = { ...SELECTIONS[0]!, paseoTools: false };
    expect(roleProviderEntry(manager)).toEqual({ extends: "anthropic", label: "Beads Manager", paseoTools: { enabled: true } });
  });
});

describe("roleRegistrationEdit", () => {
  it("only names bm-* ids and touches neither pluginsEnabled nor the MCP switch", () => {
    const edit = roleRegistrationEdit(SELECTIONS);
    // The two merge-rule maps came with delta 20260921 §4.1.2 (merge, not replace).
    expect(Object.keys(edit)).toEqual(["providers", "profiles", "providerMerge", "profileMerge"]);
    expect(edit).not.toHaveProperty("pluginsEnabled");
    expect(edit).not.toHaveProperty("mcpInject");
    expect(Object.keys(edit.providers ?? {})).toEqual(["bm-manager", "bm-worker", "bm-reviewer"]);
    expect((edit.profiles ?? []).map((profile) => profile.id)).toEqual(["bm-manager", "bm-worker", "bm-reviewer"]);
    expect(Object.keys(edit.providerMerge ?? {})).toEqual(["bm-manager", "bm-worker", "bm-reviewer"]);
    expect(Object.keys(edit.profileMerge ?? {})).toEqual(["bm-manager", "bm-worker", "bm-reviewer"]);
  });

  it("is deterministic, so a re-run produces the same edit", () => {
    expect(roleRegistrationEdit(SELECTIONS)).toEqual(roleRegistrationEdit(SELECTIONS));
  });

  it("refuses the same role twice", () => {
    expect(() => roleRegistrationEdit([SELECTIONS[0]!, SELECTIONS[0]!])).toThrow(RoleRegistrationError);
  });

  it("returns install-record roles matching what was written", async () => {
    const result = await register();
    expect(result.roles.map((role) => [role.providerId, role.profileId, role.baseProvider, role.paseoTools])).toEqual([
      ["bm-manager", "bm-manager", "anthropic", true],
      ["bm-worker", "bm-worker", "openai", true],
      ["bm-reviewer", "bm-reviewer", "anthropic", false],
    ]);
  });
});

/* ---------------------------------------- merge, not replace (delta 20260921) */

/**
 * Delta 20260921 §4.1.2, ADR-008 D5: Paseo's config is the source of truth for
 * a role's settings. A re-install merges into the `bm-*` entries; only a role
 * chosen anew (`--role`, `--reconfigure`) gets its base provider, model and
 * name rewritten.
 */
describe("re-install merges into the bm-* entries instead of replacing them", () => {
  /** The same three roles, taken over from `install.json` `roles[]` as a plain re-run does. */
  const RECORDED: readonly RoleSelection[] = SELECTIONS.map((selection) => ({ ...selection, source: "record" }));

  function writeConfig(config: PaseoConfig): void {
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  }

  /** What the user does in Paseo's Settings between two installs. */
  function editInPaseo(mutate: (config: PaseoConfig) => void): void {
    const config = readConfig();
    mutate(config);
    writeConfig(config);
  }

  function profileById(config: PaseoConfig, id: string): Record<string, unknown> {
    const profile = profilesOf(config).find((entry) => entry["id"] === id);
    if (profile === undefined) throw new Error(`No profile ${id}`);
    return profile;
  }

  /** Thinking, mode, features, icon, colour and disabled tools, set in Paseo. */
  function addUserSettings(): void {
    editInPaseo((config) => {
      const providers = providersOf(config);
      providers["bm-manager"]!["paseoTools"] = { enabled: true, disabledTools: ["archive_agent"] };
      providers["bm-worker"]!["paseoTools"] = { enabled: true, disabledTools: ["kill_agent", "archive_agent"] };
      Object.assign(profileById(config, "bm-worker"), {
        thinkingOptionId: "high",
        modeId: "acceptEdits",
        featureValues: { fastMode: true },
        icon: "hammer",
        color: "#b45309",
      });
      Object.assign(profileById(config, "bm-reviewer"), { thinkingOptionId: "xhigh", modeId: "auto" });
    });
  }

  it("keeps user keys: a re-run of recorded roles keeps every key set in Paseo and writes nothing (REQ-009)", async () => {
    await register();
    addUserSettings();
    const before = readText();
    const adapter = fakeAdapter();

    const result = await register(adapter, RECORDED);

    expect(result.config.changedPaths).toEqual([]);
    expect(result.changed).toBe(false);
    expect(adapter.calls).toEqual([]);
    expect(readText()).toBe(before);
    const config = readConfig();
    expect(profileById(config, "bm-worker")).toMatchObject({
      thinkingOptionId: "high",
      modeId: "acceptEdits",
      featureValues: { fastMode: true },
      icon: "hammer",
      color: "#b45309",
    });
    expect(profileById(config, "bm-reviewer")).toMatchObject({ thinkingOptionId: "xhigh", modeId: "auto" });
    expect(providersOf(config)["bm-manager"]!["paseoTools"]).toEqual({ enabled: true, disabledTools: ["archive_agent"] });
    expect(providersOf(config)["bm-worker"]!["paseoTools"]).toEqual({ enabled: true, disabledTools: ["kill_agent", "archive_agent"] });
  });

  it("keeps user keys when --role names a role with the values it already has, so a thinking level on the same model stays", async () => {
    await register();
    addUserSettings();
    const before = readText();

    const result = await register(fakeAdapter(), SELECTIONS);

    expect(result.config.changedPaths).toEqual([]);
    expect(readText()).toBe(before);
  });

  it("keeps a base provider, model and name changed in Paseo when the role is not named", async () => {
    await register();
    editInPaseo((config) => {
      providersOf(config)["bm-worker"]!["extends"] = "anthropic";
      Object.assign(profileById(config, "bm-worker"), { model: "claude-opus-5", name: "Cuong" });
    });
    const before = readText();

    const result = await register(fakeAdapter(), RECORDED);

    expect(result.config.changedPaths).toEqual([]);
    expect(readText()).toBe(before);
    // roles[] keeps its shape and says what the installer wrote last.
    expect(result.roles.find((role) => role.role === "worker")).toMatchObject({
      baseProvider: "openai",
      model: "gpt-5.6-sol",
      modeId: null,
      thinkingOptionId: null,
    });
  });

  it("--role with a new model: extends, label, name and model are written, thinkingOptionId goes, everything else stays", async () => {
    await register();
    addUserSettings();
    const before = readText();
    const named: readonly RoleSelection[] = RECORDED.map((selection) =>
      selection.role === "worker"
        ? { ...selection, displayName: "Cuong", provider: "anthropic", model: "claude-opus-5", source: "flag" }
        : selection,
    );

    const result = await register(fakeAdapter(), named);
    const after = readText();

    expect(result.config.changedPaths).toEqual([`${PROVIDERS_PATH}.bm-worker`, `${AGENT_PROFILES_PATH}[bm-worker]`]);
    const config = readConfig();
    expect(providersOf(config)["bm-worker"]).toEqual({
      extends: "anthropic",
      label: "Cuong",
      paseoTools: { enabled: true, disabledTools: ["kill_agent", "archive_agent"] },
    });
    const worker = profileById(config, "bm-worker");
    expect(worker).toEqual({
      id: "bm-worker",
      name: "Cuong",
      provider: "bm-worker",
      model: "claude-opus-5",
      notes: ROLE_PROFILE_NOTES.worker,
      modeId: "acceptEdits",
      featureValues: { fastMode: true },
      icon: "hammer",
      color: "#b45309",
    });
    expect(worker).not.toHaveProperty("thinkingOptionId");
    // The roles not named are byte-identical, and so is every foreign entry.
    for (const id of [...FIXTURE_PROFILE_ORDER, "bm-manager", "bm-reviewer"]) {
      expect(entrySlice(after, id)).toBe(entrySlice(before, id));
    }
    for (const id of [...ROOM_IDS, ...USER_PROVIDERS, "bm-manager", "bm-reviewer"]) {
      expect(memberSlice(after, id)).toBe(memberSlice(before, id));
    }
    expect(agentProfileIds(config)).toEqual([...FIXTURE_PROFILE_ORDER, "bm-manager", "bm-worker", "bm-reviewer"]);

    // The merge is idempotent: the same run again changes nothing.
    const again = await register(fakeAdapter(), named);
    expect(again.config.changedPaths).toEqual([]);
    expect(readText()).toBe(after);
  });

  it("turns paseoTools back on for the Manager and the Worker, keeps disabledTools, and never adds it to the Reviewer", async () => {
    await register();
    editInPaseo((config) => {
      const providers = providersOf(config);
      providers["bm-manager"]!["paseoTools"] = { enabled: false, disabledTools: ["archive_agent"] };
      delete providers["bm-worker"]!["paseoTools"];
    });

    const result = await register(fakeAdapter(), RECORDED);

    expect(result.config.changedPaths).toEqual([`${PROVIDERS_PATH}.bm-manager`, `${PROVIDERS_PATH}.bm-worker`]);
    const providers = providersOf(readConfig());
    expect(providers["bm-manager"]!["paseoTools"]).toEqual({ enabled: true, disabledTools: ["archive_agent"] });
    expect(providers["bm-worker"]!["paseoTools"]).toEqual({ enabled: true });
    expect(providers["bm-reviewer"]).not.toHaveProperty("paseoTools");

    // Named or not, the Reviewer alias does not gain the key.
    await register(fakeAdapter(), SELECTIONS.map((selection) => ({ ...selection, model: "claude-haiku-5" })));
    expect(providersOf(readConfig())["bm-reviewer"]).toEqual({ extends: "anthropic", label: "Beads Reviewer" });
  });

  it("fills a missing extends, name or model from roles[] and points the profile back at bm-<role>, without putting notes or label back", async () => {
    await register();
    editInPaseo((config) => {
      const alias = providersOf(config)["bm-worker"]!;
      delete alias["extends"];
      delete alias["label"];
      const profile = profileById(config, "bm-worker");
      delete profile["model"];
      delete profile["name"];
      delete profile["notes"];
      profile["provider"] = "openai";
      profile["thinkingOptionId"] = "high";
    });

    const result = await register(fakeAdapter(), RECORDED);

    expect(result.config.changedPaths).toEqual([`${PROVIDERS_PATH}.bm-worker`, `${AGENT_PROFILES_PATH}[bm-worker]`]);
    const config = readConfig();
    expect(providersOf(config)["bm-worker"]).toEqual({ paseoTools: { enabled: true }, extends: "openai" });
    expect(profileById(config, "bm-worker")).toEqual({
      id: "bm-worker",
      provider: "bm-worker",
      thinkingOptionId: "high",
      name: "Beads Worker",
      model: "gpt-5.6-sol",
    });
  });

  it("recreates a missing entry from roles[] exactly as the first install wrote it", async () => {
    await register();
    const first = readConfig();
    editInPaseo((config) => {
      delete providersOf(config)["bm-reviewer"];
      (config["daemon"] as Record<string, unknown>)["agentProfiles"] = profilesOf(config).filter(
        (profile) => profile["id"] !== "bm-reviewer",
      );
    });

    const result = await register(fakeAdapter(), RECORDED);

    expect(result.config.changedPaths).toEqual([`${PROVIDERS_PATH}.bm-reviewer`, `${AGENT_PROFILES_PATH}[bm-reviewer]`]);
    expect(readConfig()).toEqual(first);
  });

  it("never touches another bm-* id, such as a fallback alias", async () => {
    await register();
    editInPaseo((config) => {
      providersOf(config)["bm-worker-fallback-1"] = { extends: "anthropic", label: "Worker fallback", paseoTools: { enabled: false } };
    });
    const before = readText();

    await register(fakeAdapter(), RECORDED);
    await register(fakeAdapter(), SELECTIONS.map((selection) => ({ ...selection, model: "claude-haiku-5" })));

    expect(memberSlice(readText(), "bm-worker-fallback-1")).toBe(memberSlice(before, "bm-worker-fallback-1"));
    expect(bmProviderIds(readConfig())).toEqual(["bm-manager", "bm-worker", "bm-reviewer", "bm-worker-fallback-1"]);
  });
});
