/**
 * Install evidence — the write guard (bead bm-wp-105-6ec.5; REQ-008(e), M-4,
 * Design §9 "Phạm vi ghi của trình cài", §11 "bất biến an toàn").
 * Primary Proof: `npm test -- integration/install`.
 *
 * The guard runs in `block` mode for the whole process — `node:fs` itself is
 * patched, so writes that bypass the injected seam (the lock) are judged too.
 * paseo-bm may write `<install home>/**` and `<paseo home>/config.json` (with
 * the temporary file its atomic write goes through), and nothing else: in
 * particular nothing under any agent's skills directory.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { EXIT_CODES } from "../../src/exit-codes.js";
import { isAtomicTempOf } from "../../src/fs-guard.js";
import { REQUIRED_SKILLS } from "../../src/skills/detect.js";
import type { Fixture } from "../helpers/install-harness.js";
import { createFixture, removeFixture, runInstall, snapshotTree, writePaseoConfig, writePayload } from "../helpers/install-harness.js";

vi.setConfig({ testTimeout: 60_000 });

const VERSION = "0.2.0";
let fixture: Fixture;

beforeEach(() => {
  fixture = createFixture("install-guard");
  writePayload(fixture, VERSION);
  // Both switches off: config.json is written for the trust boundary and for the roles.
  writePaseoConfig(fixture, { daemon: { agentProfiles: [{ id: "room-lead", provider: "claude" }] } });
  // Three skills homes exist, all without the required skills.
  for (const dir of [".claude", ".codex", ".agents"]) mkdirSync(join(fixture.home, dir, "skills"), { recursive: true });
});

afterEach(() => {
  removeFixture(fixture);
});

const SKILL_HOMES = [".claude", ".codex", ".agents"];

function skillsSnapshot(): unknown {
  return SKILL_HOMES.map((dir) => [dir, [...snapshotTree(join(fixture.home, dir))]]);
}

function writtenPaths(writes: readonly { path: string }[]): string[] {
  return [...new Set(writes.map((write) => write.path))];
}

function outsideInstallHome(paths: readonly string[]): string[] {
  return paths.filter((path) => path !== fixture.installHome && !path.startsWith(`${fixture.installHome}/`));
}

function underSkillHomes(paths: readonly string[]): string[] {
  return paths.filter((path) => SKILL_HOMES.some((dir) => path.startsWith(`${join(fixture.home, dir)}/`) || path === join(fixture.home, dir)));
}

describe("install — write guard in block mode for the whole process", () => {
  it("a full first install writes only inside the install home and config.json", async () => {
    const before = skillsSnapshot();

    const run = await runInstall(fixture, ["install", "--apply", "--enable-plugins"], { version: VERSION });

    expect(run.thrown).toBeUndefined();
    expect(run.code).toBe(EXIT_CODES.ok);
    expect(run.violations).toEqual([]);

    const paths = writtenPaths(run.writes);
    const configFile = join(fixture.paseoHome, "config.json");
    // The guard saw the run: payload, record, lock, and config.json.
    expect(paths).toContain(join(fixture.installHome, "install.json"));
    expect(paths).toContain(join(fixture.installHome, ".lock"));
    expect(paths).toContain(configFile);
    // Outside the install home: config.json and its atomic-write temp file, nothing else.
    expect(outsideInstallHome(paths).filter((path) => path !== configFile && !isAtomicTempOf(configFile, path))).toEqual([]);
    expect(underSkillHomes(paths)).toEqual([]);
    expect(skillsSnapshot()).toEqual(before);

    // config.json really was changed — the scope was exercised, not avoided.
    const config = JSON.parse(readFileSync(configFile, "utf8")) as { pluginsEnabled?: boolean; daemon: { agentProfiles: { id: string }[] } };
    expect(config.pluginsEnabled).toBe(true);
    expect(config.daemon.agentProfiles.map((profile) => profile.id)).toEqual(["room-lead", "bm-manager", "bm-worker", "bm-reviewer"]);
  });

  it("with --install-skills the skills CLI child writes the skills; paseo-bm itself writes none there", async () => {
    const npxLog = join(fixture.outside, "npx-argv.log");
    const run = await runInstall(fixture, ["install", "--apply", "--enable-plugins", "--install-skills"], {
      version: VERSION,
      env: {
        BM_FAKE_NPX_MODE: "ok",
        BM_FAKE_NPX_ARGV_LOG: npxLog,
        BM_FAKE_NPX_INSTALL: join(fixture.home, ".agents", "skills"),
      },
    });

    expect(run.thrown).toBeUndefined();
    expect(run.code).toBe(EXIT_CODES.ok);
    expect(run.violations).toEqual([]);
    // The fake skills CLI ran and installed the skills, from its own process...
    expect(readFileSync(npxLog, "utf8")).toContain('"skills","add"');
    for (const skill of REQUIRED_SKILLS) {
      expect(existsSync(join(fixture.home, ".agents", "skills", skill, "SKILL.md"))).toBe(true);
    }
    // ...and paseo-bm's process made zero writes under any skills home.
    expect(underSkillHomes(writtenPaths(run.writes))).toEqual([]);
  });

  it("is live: a write outside the scope during the run is refused before it reaches the disk", async () => {
    const planted = join(fixture.home, ".claude", "skills", "planted", "SKILL.md");
    const run = await runInstall(fixture, ["install", "--apply", "--enable-plugins"], {
      version: VERSION,
      wrapAdapter: (adapter) => ({
        ...adapter,
        daemonStatus: async () => {
          // A stray write through plain node:fs, not through the injected seam.
          try {
            writeFileSync(planted, "# planted\n");
          } catch {
            // Refused: that is the point.
          }
          return adapter.daemonStatus();
        },
      }),
    });

    expect(existsSync(planted)).toBe(false);
    expect(run.violations).toEqual([expect.objectContaining({ path: planted, blocked: true, kind: "write-file" })]);
  });
});
