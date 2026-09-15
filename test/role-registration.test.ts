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
    expect(Object.keys(edit)).toEqual(["providers", "profiles"]);
    expect(Object.keys(edit.providers ?? {})).toEqual(["bm-manager", "bm-worker", "bm-reviewer"]);
    expect((edit.profiles ?? []).map((profile) => profile.id)).toEqual(["bm-manager", "bm-worker", "bm-reviewer"]);
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
