/**
 * Install evidence — interruption matrix (bead bm-wp-105-6ec.5; REQ-010(c),
 * M-3, Design §9 "Ctrl+C", §11 "gián đoạn và idempotent").
 * Primary Proof: `npm test -- integration/install`.
 *
 * The run is killed at **every** filesystem write it makes, one kill point per
 * iteration, and then the same command is run again. A kill is simulated at
 * the filesystem seam the command already takes (`InstallOptions.fs`):
 *
 * - the Nth write is refused before it reaches the disk, and from that moment
 *   every further write *and* every further Paseo call is refused as well — so
 *   no cleanup code gets to run, which is what SIGKILL means (a temp file that
 *   was already written stays behind);
 * - a lock that was held at the kill is left on disk naming a dead pid, as a
 *   killed process would leave it, and the re-run has to reclaim it.
 *
 * After every kill:  the install record is absent or valid, `config.json` is
 * valid JSON, no payload file holds anything but its full bytes, and (upgrade)
 * the previous version's payload is intact.
 * After every re-run: exit 0, and the state equals that of an uninterrupted
 * run — record (timestamps aside), `config.json`, the version directories and
 * every payload file, the plugin Paseo has registered — with no lock.
 *
 * Abandoned atomic temp files are compared out and listed in the printed
 * summary instead. A kill between a temp file's `open` and its `rename` leaves
 * `.<name>.<pid>.<hex>.tmp` beside the target, and Design §9 limits cleanup to
 * partial payload directories ("file dở ở dạng tạm nên bị bỏ"), so nothing
 * sweeps them. They never hold a target's name, and on an upgrade the partial
 * version directory — temp files included — is removed whole, which is asserted.
 *
 * One documented exception, from ADR-002 and test/install-command.test.ts: a
 * *first* install killed after payload files were written but before
 * `install.json` existed cannot prove the directory is its own, so the re-run
 * stops with exit 5 and tells the user to delete that directory. The matrix
 * follows that instruction and requires the run after it to converge.
 *
 * The write guard is in `block` mode for the whole process on every run.
 */

import { describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { EXIT_CODES } from "../../src/exit-codes.js";
import type { NodeFsApi } from "../../src/fs-guard.js";
import { isWriteFlags } from "../../src/fs-guard.js";
import type { PaseoAdapter } from "../../src/paseo/adapter.js";
import { parseRecord } from "../../src/record.js";
import type { Fixture, RunResult } from "../helpers/install-harness.js";
import {
  createFixture,
  removeFixture,
  runInstall,
  seedCompleteSkills,
  snapshotTree,
  tempFilesUnder,
  writePaseoConfig,
  writePayload,
} from "../helpers/install-harness.js";

vi.setConfig({ testTimeout: 900_000 });

const OLD = "0.1.0";
const VERSION = "0.2.0";
/** Both switches off, plus a profile that is not ours: the run writes config.json twice. */
const USER_CONFIG = { daemon: { agentProfiles: [{ id: "room-lead", name: "Room lead", provider: "claude" }] } };
const ARGV = ["install", "--apply", "--enable-plugins"];

class Killed extends Error {
  constructor() {
    super("killed (simulated SIGKILL)");
    this.name = "Killed";
  }
}

interface KillSwitch {
  /** Writes counted so far. */
  readonly count: number;
  /** `<call> <path>` of the write the process died on, or null. */
  readonly killedAt: string | null;
  /** Whether the install lock existed at the moment of the kill. */
  readonly lockHeld: boolean;
  wrapFs(fs: NodeFsApi): NodeFsApi;
  wrapAdapter(adapter: PaseoAdapter): PaseoAdapter;
}

/** Kills the run at its `at`-th write (1-based); `Infinity` only counts. */
function killSwitch(at: number, lockFile: string): KillSwitch {
  let count = 0;
  let killedAt: string | null = null;
  let lockHeld = false;
  const hit = (call: string, path: string): void => {
    if (killedAt !== null) throw new Killed();
    count += 1;
    if (count === at) {
      killedAt = `${call} ${path}`;
      lockHeld = existsSync(lockFile);
      throw new Killed();
    }
  };
  return {
    get count() {
      return count;
    },
    get killedAt() {
      return killedAt;
    },
    get lockHeld() {
      return lockHeld;
    },
    wrapFs: (fs) => ({
      ...fs,
      chmod: async (path, mode) => {
        hit("chmod", path);
        await fs.chmod(path, mode);
      },
      mkdir: async (path, options) => {
        hit("mkdir", path);
        return fs.mkdir(path, options);
      },
      open: async (path, flags, mode) => {
        if (isWriteFlags(flags)) hit("open", path);
        return fs.open(path, flags, mode);
      },
      rename: async (from, to) => {
        hit("rename", to);
        await fs.rename(from, to);
      },
      rm: async (path, options) => {
        hit("rm", path);
        await fs.rm(path, options);
      },
      symlink: async (target, path) => {
        hit("symlink", path);
        await fs.symlink(target, path);
      },
      unlink: async (path) => {
        hit("unlink", path);
        await fs.unlink(path);
      },
      writeFile: async (path, data, options) => {
        hit("writeFile", path);
        await fs.writeFile(path, data, options);
      },
      copyFile: async (source, destination) => {
        hit("copyFile", destination);
        await fs.copyFile(source, destination);
      },
    }),
    wrapAdapter: (adapter) => {
      const wrapped: Record<string, unknown> = { ...adapter };
      for (const [key, value] of Object.entries(adapter)) {
        if (typeof value !== "function") continue;
        const fn = value as (...args: unknown[]) => unknown;
        wrapped[key] = (...args: unknown[]) => {
          if (killedAt !== null) throw new Killed();
          return fn(...args);
        };
      }
      return wrapped as unknown as PaseoAdapter;
    },
  };
}

/** A pid that certainly belongs to no running process. */
function deadPid(): number {
  const child = spawnSync(process.execPath, ["-e", ""]);
  return child.pid;
}

/** The name `src/fsops.ts` gives the temporary file of an atomic write. */
function isAtomicTemp(path: string): boolean {
  return /(^|\/)\.[^/]+\.\d+\.[0-9a-f]+\.tmp$/.test(path);
}

interface State {
  readonly record: unknown;
  readonly config: unknown;
  /** Version directories under `plugin/`: a leftover directory is payload litter. */
  readonly pluginDirs: readonly string[];
  /** Every payload file except abandoned atomic temp files (reported separately). */
  readonly plugin: readonly (readonly [string, string, number])[];
  readonly daemonPluginDir: string | null;
  readonly lock: boolean;
}

function normalisedRecord(fixture: Fixture): unknown {
  const text = readFileSync(join(fixture.installHome, "install.json"), "utf8");
  const record = JSON.parse(JSON.stringify(parseRecord(text)).replaceAll(fixture.home, "<HOME>")) as Record<string, unknown>;
  // Timestamps and the backup list depend on when and how often the run happened.
  delete record["installedAt"];
  delete record["updatedAt"];
  delete record["backups"];
  record["versions"] = (record["versions"] as Record<string, unknown>[]).map((entry) =>
    Object.fromEntries(Object.entries(entry).filter(([key]) => key !== "installedAt")),
  );
  return record;
}

function captureState(fixture: Fixture): State {
  return {
    record: normalisedRecord(fixture),
    config: JSON.parse(readFileSync(join(fixture.paseoHome, "config.json"), "utf8")) as unknown,
    pluginDirs: readdirSync(join(fixture.installHome, "plugin")).sort(),
    plugin: [...snapshotTree(join(fixture.installHome, "plugin"))]
      .filter(([path]) => !isAtomicTemp(path))
      .map(([path, entry]) => [path, entry.sha256, entry.mode] as const)
      .sort((left, right) => left[0].localeCompare(right[0])),
    daemonPluginDir: fixture.daemon.pluginDir?.replaceAll(fixture.home, "<HOME>") ?? null,
    lock: existsSync(join(fixture.installHome, ".lock")),
  };
}

interface Scenario {
  readonly name: string;
  /** Installs OLD first when true. */
  readonly upgrade: boolean;
}

interface Summary {
  scenario: string;
  killPoints: number;
  convergedFirstRerun: number;
  neededManualDelete: number;
  staleLocksReclaimed: number;
  /** Temp files a kill left outside `plugin/` (relative to the fake HOME). */
  strayTemps: string[];
}

async function runMatrix(scenario: Scenario): Promise<Summary> {
  const fixture = createFixture(`install-kill-${scenario.upgrade ? "upgrade" : "first"}`);
  const template = join(fixture.outside, "template");
  const lockFile = join(fixture.installHome, ".lock");
  const recordFile = join(fixture.installHome, "install.json");
  const summary: Summary = {
    scenario: scenario.name,
    killPoints: 0,
    convergedFirstRerun: 0,
    neededManualDelete: 0,
    staleLocksReclaimed: 0,
    strayTemps: [],
  };

  try {
    /* -- the starting state, kept as a template ------------------------------ */
    writePaseoConfig(fixture, USER_CONFIG);
    seedCompleteSkills(fixture);
    if (scenario.upgrade) {
      writePayload(fixture, OLD);
      const old = await runInstall(fixture, ARGV, { version: OLD, guard: "off" });
      expect(old.code).toBe(EXIT_CODES.ok);
    }
    const daemonAtStart = fixture.daemon.pluginDir;
    cpSync(fixture.home, template, { recursive: true, preserveTimestamps: true });
    const oldPayload = snapshotTree(join(fixture.installHome, "plugin", OLD));
    writePayload(fixture, VERSION);
    const expectedBytes = new Map([...snapshotTree(fixture.payloadRoot)].map(([path, entry]) => [path, entry.sha256]));

    const reset = (): void => {
      rmSync(fixture.home, { recursive: true, force: true });
      cpSync(template, fixture.home, { recursive: true, preserveTimestamps: true });
      fixture.daemon.pluginDir = daemonAtStart;
      rmSync(fixture.argvLog, { force: true });
    };

    /* -- the reference: one uninterrupted run, counting its writes ------------ */
    reset();
    const counter = killSwitch(Number.POSITIVE_INFINITY, lockFile);
    const clean = await runInstall(fixture, ARGV, {
      version: VERSION,
      wrapFs: counter.wrapFs,
      wrapAdapter: counter.wrapAdapter,
    });
    expect(clean.thrown).toBeUndefined();
    expect(clean.violations).toEqual([]);
    expect(clean.code).toBe(EXIT_CODES.ok);
    const reference = captureState(fixture);
    const total = counter.count;
    expect(total).toBeGreaterThan(10);
    summary.killPoints = total;

    /* -- one kill per write ---------------------------------------------------- */
    for (let at = 1; at <= total; at += 1) {
      reset();
      const kill = killSwitch(at, lockFile);
      const killed = await runInstall(fixture, ARGV, {
        version: VERSION,
        wrapFs: kill.wrapFs,
        wrapAdapter: kill.wrapAdapter,
      });
      const label = `${scenario.name}, kill #${at}/${total} at ${kill.killedAt ?? "(never reached)"}`;
      expect.soft(kill.killedAt, label).not.toBeNull();
      expect.soft(killed.violations, label).toEqual([]);

      // What a killed process leaves: its lock, naming a pid that is gone.
      if (kill.lockHeld && !existsSync(lockFile)) {
        mkdirSync(fixture.installHome, { recursive: true });
        writeFileSync(
          lockFile,
          JSON.stringify({ pid: deadPid(), acquiredAt: new Date().toISOString(), hostname: hostname(), command: "install" }),
        );
        summary.staleLocksReclaimed += 1;
      }

      // Right after the kill: nothing half-written, the record is valid or absent.
      if (existsSync(recordFile)) {
        expect.soft(() => parseRecord(readFileSync(recordFile, "utf8")), label).not.toThrow();
      }
      expect.soft(() => JSON.parse(readFileSync(join(fixture.paseoHome, "config.json"), "utf8")) as unknown, label).not.toThrow();
      for (const [path, entry] of snapshotTree(join(fixture.installHome, "plugin", VERSION))) {
        if (isAtomicTemp(path)) continue;
        expect.soft(entry.sha256, `${label}: plugin/${VERSION}/${path}`).toBe(expectedBytes.get(path));
      }
      if (scenario.upgrade) {
        // REQ-010(c): the previous version stays usable until the new one is applied.
        const now = snapshotTree(join(fixture.installHome, "plugin", OLD));
        expect.soft([...now].map(([path, entry]) => [path, entry.sha256]), label).toEqual(
          [...oldPayload].map(([path, entry]) => [path, entry.sha256]),
        );
      }
      // The same command again.
      let rerun: RunResult = await runInstall(fixture, ARGV, { version: VERSION });
      if (rerun.code === EXIT_CODES.conflict && !scenario.upgrade && !existsSync(recordFile)) {
        // ADR-002: no record, so the directory cannot be proved ours. Follow the printed instruction.
        expect.soft(rerun.err, label).toContain("delete that directory yourself");
        rmSync(join(fixture.installHome, "plugin", VERSION), { recursive: true, force: true });
        summary.neededManualDelete += 1;
        rerun = await runInstall(fixture, ARGV, { version: VERSION });
      } else {
        summary.convergedFirstRerun += 1;
      }

      expect.soft(rerun.thrown, label).toBeUndefined();
      expect.soft(rerun.violations, label).toEqual([]);
      expect.soft(rerun.code, `${label}\n${rerun.err}`).toBe(EXIT_CODES.ok);
      if (rerun.code === EXIT_CODES.ok) {
        expect.soft(captureState(fixture), label).toEqual(reference);
        if (scenario.upgrade) {
          // The interrupted version directory was a partial payload and was removed whole.
          expect.soft(tempFilesUnder(join(fixture.installHome, "plugin")), label).toEqual([]);
        }
        const leftovers = [
          ...tempFilesUnder(fixture.installHome).map((path) => `.paseo-bm/${path}`),
          ...tempFilesUnder(fixture.paseoHome).map((path) => `.paseo/${path}`),
        ];
        summary.strayTemps.push(...leftovers.map((path) => `#${at}: ${path.replace(/\.\d+\.[0-9a-f]+\.tmp$/, ".<pid>.<hex>.tmp")}`));
      }
    }
  } finally {
    removeFixture(fixture);
  }
  return summary;
}

describe("install — killed at every write, then run again", () => {
  it("first install: every kill point converges to the uninterrupted state", async () => {
    const summary = await runMatrix({ name: "first install", upgrade: false });
    console.info(JSON.stringify(summary, null, 2));
    expect(summary.killPoints).toBe(summary.convergedFirstRerun + summary.neededManualDelete);
  });

  it("upgrade 0.1.0 -> 0.2.0: every kill point converges on the first re-run, the old payload intact", async () => {
    const summary = await runMatrix({ name: "upgrade", upgrade: true });
    console.info(JSON.stringify(summary, null, 2));
    expect(summary.neededManualDelete).toBe(0);
    expect(summary.convergedFirstRerun).toBe(summary.killPoints);
  });
});
