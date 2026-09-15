import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { backupStamp, createFsOps } from "../src/fsops.js";
import { installPaths, paseoConfigFile, resolveLayout } from "../src/layout.js";
import { withLock } from "../src/lock.js";
import { createPaseoAdapter } from "../src/paseo/adapter.js";
import { readVersion } from "../src/version.js";

/**
 * The negative evidence PRD §0 requires: paseo-bm never touches a credential.
 *
 * "We do not read credentials" is a claim that cannot be proved by reading the
 * code once — the next work package adds a `readFile` and the claim is silently
 * false. So this suite proves it mechanically, at the lowest level there is:
 * every function of `node:fs` and `node:fs/promises` is wrapped for the
 * duration of a representative install, and the paths that went through them
 * are collected. Whatever module made the call — fsops, the lock, the Paseo
 * adapter, or something added later — it is recorded.
 *
 * Two assertions carry the whole bead:
 *
 * 1. inside the Paseo home, the set of files *read* is exactly `{config.json}`
 *    (Design §7), and
 * 2. no file whose name marks it as a credential is touched anywhere — not in
 *    `~/.paseo`, not in an agent's configuration directory.
 *
 * The suite also proves it can fail: the last test performs a credential read
 * on purpose and asserts that both detectors fire. Without that, a guard like
 * this one is indistinguishable from a guard that checks nothing.
 *
 * Everything happens under a temporary HOME. The real `~/.paseo` is never read,
 * and the `paseo` CLI here is the fake in `test/fakes/`.
 */

const recorder = vi.hoisted(() => {
  interface Touch {
    readonly fn: string;
    readonly path: string;
  }

  const touches: Touch[] = [];

  /** Functions that can move a file's *contents* into this process. */
  const READING_FUNCTIONS: ReadonlySet<string> = new Set([
    "readFile",
    "readFileSync",
    "open",
    "openSync",
    "createReadStream",
    "copyFile",
    "copyFileSync",
    "cp",
    "cpSync",
    "readv",
    "readvSync",
  ]);

  const toPath = (value: unknown): string | undefined => {
    if (typeof value === "string") return value;
    if (value instanceof URL) return decodeURIComponent(value.pathname);
    if (value instanceof Uint8Array) return Buffer.from(value).toString("utf8");
    return undefined;
  };

  /** A class, which must not be replaced by a plain wrapper function. */
  const isClass = (value: { prototype?: object }): boolean =>
    value.prototype !== undefined && Object.getOwnPropertyNames(value.prototype).length > 1;

  const wrapModule = (actual: Record<string, unknown>): Record<string, unknown> => {
    const wrapped: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(actual)) {
      if (name === "default" || name === "promises") continue;
      if (typeof value !== "function" || isClass(value as { prototype?: object })) {
        wrapped[name] = value;
        continue;
      }
      const original = value as (...args: unknown[]) => unknown;
      const wrapper = (...args: unknown[]): unknown => {
        const path = toPath(args[0]);
        if (path !== undefined) touches.push({ fn: name, path });
        return original(...args);
      };
      // `realpathSync.native` and friends hang off the function itself.
      wrapped[name] = Object.assign(wrapper, original);
    }
    return wrapped;
  };

  return { touches, wrapModule, READING_FUNCTIONS };
});

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  const wrapped = recorder.wrapModule(actual);
  wrapped.default = wrapped;
  return wrapped;
});

vi.mock("node:fs", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  const wrapped = recorder.wrapModule(actual);
  wrapped.promises = recorder.wrapModule(actual.promises as Record<string, unknown>);
  wrapped.default = wrapped;
  return wrapped;
});

const FAKE_PASEO = fileURLToPath(new URL("./fakes/paseo", import.meta.url));

/**
 * File names that mean "a credential lives here". Paseo's own `auth.json`, the
 * two agent CLIs paseo-bm knows about, and the shapes their login flows write.
 */
const CREDENTIAL_FILE_NAMES: readonly string[] = [
  "auth.json",
  ".credentials.json",
  "credentials.json",
  ".claude.json",
  "sessions.json",
  "token.json",
  ".netrc",
];

let home: string;
let paseoHome: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "paseo-bm-credentials-"));
  paseoHome = join(home, ".paseo");

  // Paseo's home holds the one file we may read, plus decoys a careless
  // implementation would happily slurp: a directory listing, a glob, a
  // "read everything in ~/.paseo" helper would all trip over these.
  mkdirSync(join(paseoHome, "agents"), { recursive: true });
  writeFileSync(join(paseoHome, "config.json"), `${JSON.stringify({ pluginsEnabled: false }, null, 2)}\n`);
  writeFileSync(join(paseoHome, "auth.json"), '{"token":"paseo-daemon-token-should-never-be-read"}\n');
  writeFileSync(join(paseoHome, ".credentials.json"), '{"refresh":"never-read-me"}\n');
  writeFileSync(join(paseoHome, "agents", "credentials.json"), '{"apiKey":"never-read-me"}\n');

  // The agent homes paseo-bm knows the location of but has no business reading.
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(join(home, ".claude.json"), '{"oauthAccount":"never-read-me"}\n');
  writeFileSync(join(home, ".claude", ".credentials.json"), '{"accessToken":"never-read-me"}\n');
  mkdirSync(join(home, ".codex"), { recursive: true });
  writeFileSync(join(home, ".codex", "auth.json"), '{"OPENAI_API_KEY":"never-read-me"}\n');
  writeFileSync(join(home, ".netrc"), "machine api.anthropic.com password never-read-me\n");

  recorder.touches.length = 0;
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

/**
 * The reads and writes an install performs, driven through the real modules.
 *
 * This is not a mock of the installer: `resolveLayout`, `installPaths`,
 * `createFsOps`, `withLock`, `readVersion` and the Paseo adapter are the
 * shipping implementations, so any file either of them decides to open shows up
 * in the recording. The one line standing in for work that does not exist yet
 * is the `config.json` read itself — WP-107 owns parsing that file; this bead
 * owns the fact that it is the only thing read in there. The end-to-end version
 * of this evidence belongs to the install integration bead (WP-105).
 */
async function runRepresentativeInstall(): Promise<void> {
  const layout = resolveLayout({ homeDir: home, env: {}, cwd: home });
  const paths = installPaths(layout.installHome.path);

  readVersion();

  await withLock(
    paths.lockFile,
    async () => {
      const fsops = createFsOps({ root: paths.root });
      const versionDir = await fsops.ensureDir(paths.pluginVersionDir("0.1.0"));

      // Copy the payload in, then re-run the same write to exercise the
      // "hash the file on disk first" path (that read has to stay inside the
      // install home).
      await fsops.writeFileAtomic(join(versionDir, "paseo-plugin.json"), '{"id":"paseo-bm"}\n');
      await fsops.writeFileAtomic(join(versionDir, "paseo-plugin.json"), '{"id":"paseo-bm"}\n');
      await fsops.writeFileAtomic(join(versionDir, "roles", "worker.md"), "# Beads Worker\n");
      await fsops.hashFile(join(versionDir, "roles", "worker.md"));

      const configFile = paseoConfigFile(layout.paseoHome.path);
      const config = JSON.parse(await readFile(configFile, "utf8")) as { pluginsEnabled?: unknown };

      await fsops.backupFile(configFile, {
        backupDir: paths.backupDir(backupStamp()),
        as: "paseo-config.json",
      });
      await fsops.writeFileAtomic(
        paths.record,
        `${JSON.stringify({ version: "0.1.0", pluginsEnabled: config.pluginsEnabled === true }, null, 2)}\n`,
      );

      const adapter = createPaseoAdapter({
        executable: FAKE_PASEO,
        timeoutMs: 5_000,
        env: {
          PATH: process.env.PATH,
          PASEO_HOME: paseoHome,
          BM_FAKE_STDOUT: JSON.stringify({ home: paseoHome, cliVersion: "0.8.0", daemonVersion: "0.8.0" }),
        },
      });
      await adapter.daemonStatus();
    },
    { handleSignals: false },
  );
}

/** Basenames of the files read inside the Paseo home during the recording. */
function filesReadInPaseoHome(): string[] {
  const prefix = `${paseoHome}${sep}`;
  const names = recorder.touches
    .filter((touch) => recorder.READING_FUNCTIONS.has(touch.fn) && touch.path.startsWith(prefix))
    .map((touch) => touch.path.slice(prefix.length));
  return [...new Set(names)].sort();
}

/**
 * Every recorded path that names a credential file, by *any* fs function —
 * reading one is the violation, and opening or stat-ing one is already further
 * than paseo-bm has any reason to go.
 */
function credentialTouches(): string[] {
  const names = new Set(CREDENTIAL_FILE_NAMES);
  return [
    ...new Set(
      recorder.touches
        .filter((touch) => touch.path.split(sep).some((segment) => names.has(segment)))
        .map((touch) => `${touch.fn} ${touch.path}`),
    ),
  ].sort();
}

/** Paths touched anywhere under `dir`, whatever the function. */
function touchesUnder(dir: string): string[] {
  const prefix = `${dir}${sep}`;
  return [...new Set(recorder.touches.filter((touch) => touch.path.startsWith(prefix)).map((touch) => touch.path))];
}

describe("the recording itself", () => {
  it("sees reads that other modules make, not only the ones this test makes", async () => {
    await runRepresentativeInstall();

    // If the wrapper were not installed, or were installed on a different copy
    // of `node:fs`, this list would be empty and every assertion below would
    // pass vacuously.
    expect(recorder.touches.length).toBeGreaterThan(0);
    expect(touchesUnder(join(home, ".paseo-bm")).length).toBeGreaterThan(0);

    // Calls this test file never makes itself: `openSync` on the lock file
    // comes from `src/lock.ts`, `lstat` from `src/fsops.ts`. Seeing them proves
    // the wrapper sits under the product modules, not only under the test.
    const lockFile = join(home, ".paseo-bm", ".lock");
    expect(recorder.touches).toContainEqual({ fn: "openSync", path: lockFile });
    expect(recorder.touches.map((touch) => touch.fn)).toContain("lstat");
  });
});

describe("what an install reads", () => {
  it("reads exactly one file inside ~/.paseo, and it is config.json", async () => {
    await runRepresentativeInstall();
    expect(filesReadInPaseoHome()).toEqual(["config.json"]);
  });

  it("touches no credential file anywhere", async () => {
    await runRepresentativeInstall();
    expect(credentialTouches()).toEqual([]);
  });

  it("never goes into an agent's configuration directory", async () => {
    await runRepresentativeInstall();
    expect(touchesUnder(join(home, ".claude"))).toEqual([]);
    expect(touchesUnder(join(home, ".codex"))).toEqual([]);
    expect(recorder.touches.map((touch) => touch.path)).not.toContain(join(home, ".claude.json"));
    expect(recorder.touches.map((touch) => touch.path)).not.toContain(join(home, ".netrc"));
  });
});

describe("the guard fails when it should", () => {
  /**
   * A credential read is performed on purpose here. Both detectors must fire —
   * this is what makes the three tests above evidence rather than decoration.
   */
  it("catches a credential read added to the flow", async () => {
    await runRepresentativeInstall();
    await readFile(join(paseoHome, "auth.json"), "utf8");

    expect(filesReadInPaseoHome()).toEqual(["auth.json", "config.json"]);
    expect(credentialTouches()).toEqual([`readFile ${join(paseoHome, "auth.json")}`]);
  });

  it("catches a read of an agent credential file outside ~/.paseo", async () => {
    await runRepresentativeInstall();
    await readFile(join(home, ".claude", ".credentials.json"), "utf8");

    expect(filesReadInPaseoHome()).toEqual(["config.json"]);
    expect(touchesUnder(join(home, ".claude"))).not.toEqual([]);
    expect(credentialTouches()).toEqual([`readFile ${join(home, ".claude", ".credentials.json")}`]);
  });
});
