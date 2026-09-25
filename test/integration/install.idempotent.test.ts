/**
 * Install evidence — idempotence (bead bm-wp-105-6ec.5; REQ-009, M-3, Design §9).
 * Primary Proof: `npm test -- integration/install`.
 *
 * A first `install --apply` on a fake `$HOME`, then the same install again.
 * The second run must show zero changes, ask for no confirmation, not offer the
 * skills CLI, exit 0, and leave the modification time of every file where it
 * was. The write guard is in `block` mode for the whole process on every run.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import type { PlanReport } from "../../src/action.js";
import { isWritingAction } from "../../src/action.js";
import { EXIT_CODES } from "../../src/exit-codes.js";
import type { Fixture } from "../helpers/install-harness.js";
import {
  TTY,
  createFixture,
  removeFixture,
  runInstall,
  seedCompleteSkills,
  snapshotTree,
  subcommands,
  writePaseoConfig,
  writePayload,
} from "../helpers/install-harness.js";

vi.setConfig({ testTimeout: 60_000 });

const VERSION = "0.2.0";
let fixture: Fixture;

beforeEach(async () => {
  fixture = createFixture("install-idem");
  writePayload(fixture, VERSION);
  // Both switches off: the first run writes them, and the bm-* roles, into config.json.
  writePaseoConfig(fixture, { daemon: { agentProfiles: [{ id: "room-lead", provider: "claude" }] } });
  seedCompleteSkills(fixture);

  const first = await runInstall(fixture, ["install", "--apply", "--enable-plugins"], { version: VERSION });
  expect(first.thrown).toBeUndefined();
  expect(first.violations).toEqual([]);
  expect(first.code).toBe(EXIT_CODES.ok);
});

afterEach(() => {
  removeFixture(fixture);
});

/** Everything paseo-bm could have touched, plus the skills directory it must never touch. */
function snapshotAll(): Map<string, unknown> {
  const all = new Map<string, unknown>();
  for (const [label, root] of [
    ["installHome", fixture.installHome],
    ["paseoHome", fixture.paseoHome],
    ["claude", join(fixture.home, ".claude")],
  ] as const) {
    for (const [path, entry] of snapshotTree(root)) all.set(`${label}/${path}`, entry);
  }
  return all;
}

/** The lock is process coordination, not an install target; it is created and removed on every apply. */
function nonLockWrites(writes: readonly { path: string; kind: string }[]): { path: string; kind: string }[] {
  const lockFile = join(fixture.installHome, ".lock");
  return writes.filter((write) => write.path !== lockFile && !(write.kind === "make-dir" && write.path === fixture.installHome));
}

describe("install run twice with the same version", () => {
  it("on a terminal: 0 changes, no question at all, exit 0, no file changes its mtime", async () => {
    const before = snapshotAll();

    // No answers are scripted: any question would throw ScriptExhaustedError.
    const second = await runInstall(fixture, ["install"], { version: VERSION, tty: TTY });

    expect(second.thrown).toBeUndefined();
    expect(second.code).toBe(EXIT_CODES.ok);
    expect(second.prompter.counts.total).toBe(0);
    // The report shows zero changes: every action is a skip.
    expect(second.out).toMatch(/^(\d+) actions: \1 skip$/m);
    expect(second.violations).toEqual([]);
    expect(nonLockWrites(second.writes)).toEqual([]);
    expect(snapshotAll()).toEqual(before);
  });

  it("with --apply --json: every action is non-writing, Paseo is not touched, skills are not offered", async () => {
    const before = snapshotAll();
    const callsBefore = subcommands(fixture).length;

    const second = await runInstall(fixture, ["install", "--apply", "--json"], { version: VERSION });

    expect(second.thrown).toBeUndefined();
    expect(second.code).toBe(EXIT_CODES.ok);
    const report = JSON.parse(second.out) as PlanReport;
    expect(report.actions.filter((action) => isWritingAction(action))).toEqual([]);
    expect(report.result.exitCode).toBe(EXIT_CODES.ok);
    expect("error" in report.result).toBe(false);
    expect(report.skills?.suggestedCommand ?? null).toBeNull();
    expect(report.warnings.map((warning) => warning.code)).not.toContain("W_SKILLS_MISSING");

    // No registration, no reload: only reads went to Paseo.
    const calls = subcommands(fixture).slice(callsBefore);
    expect(calls).not.toContain("plugin install");
    expect(calls).not.toContain("daemon reload");

    expect(second.violations).toEqual([]);
    expect(nonLockWrites(second.writes)).toEqual([]);
    expect(snapshotAll()).toEqual(before);
  });
});
