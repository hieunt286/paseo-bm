/**
 * A fake `$HOME` and a fake `paseo` on PATH, for the migration's integration
 * tests.
 *
 * What is left of the 0.3.x install harness. The installer it drove is gone
 * (WP-406), and the migration needs only four things from it: a throwaway home
 * with the two directories paseo-bm knows, a `paseo` that answers `daemon
 * status` with a supported version, somewhere to record the argv every call
 * received, and the TTY shapes.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { TtyInfo } from "../../src/prompter.js";

/** Directory holding the fake `paseo`; put first on PATH. */
export const FAKE_DIR = fileURLToPath(new URL("../fakes/", import.meta.url));

export const TTY: TtyInfo = { stdin: true, stdout: true, interactive: true };
export const NO_TTY: TtyInfo = { stdin: false, stdout: false, interactive: false };

export interface Fixture {
  readonly home: string;
  /** A second temporary root, for logs and state the home must not contain. */
  readonly outside: string;
  readonly installHome: string;
  readonly paseoHome: string;
  readonly argvLog: string;
  readonly scriptFile: string;
}

export function createFixture(prefix: string): Fixture {
  // realpath: the write guard records canonical paths.
  const home = realpathSync(mkdtempSync(join(tmpdir(), `paseo-bm-${prefix}-`)));
  const outside = realpathSync(mkdtempSync(join(tmpdir(), `paseo-bm-${prefix}-log-`)));
  return {
    home,
    outside,
    installHome: join(home, ".paseo-bm"),
    paseoHome: join(home, ".paseo"),
    argvLog: join(outside, "argv.log"),
    scriptFile: join(outside, "script.json"),
  };
}

export function removeFixture(fixture: Fixture): void {
  rmSync(fixture.home, { recursive: true, force: true });
  rmSync(fixture.outside, { recursive: true, force: true });
}

export function writePaseoConfig(fixture: Fixture, config: Record<string, unknown>): void {
  mkdirSync(fixture.paseoHome, { recursive: true, mode: 0o700 });
  writeFileSync(join(fixture.paseoHome, "config.json"), `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}

/**
 * What the fake `paseo` answers per subcommand.
 *
 * `plugin ls`, `plugin add`, `plugin install` and `plugin remove` are answered
 * from `BM_FAKE_STATE` instead, which behaves like a real catalogue; this file
 * only has to make `daemon status` report a Paseo the CLI supports.
 */
export function writeScript(fixture: Fixture, version: string): void {
  const script = {
    "daemon status": {
      stdout: JSON.stringify({ home: fixture.paseoHome, cliVersion: "0.9.2", daemonVersion: "0.9.2" }),
    },
    "plugin ls": { stdout: "[]" },
    "plugin logs": { stdout: "[]" },
  };
  void version;
  writeFileSync(fixture.scriptFile, `${JSON.stringify(script, null, 2)}\n`);
}
