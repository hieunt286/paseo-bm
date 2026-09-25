/**
 * Install evidence — what the whole install reads (bead bm-wp-105-6ec.5;
 * REQ-008(d), Design §9 "trong ~/.paseo chỉ đọc config.json").
 * Primary Proof: `npm test -- integration/install`.
 *
 * test/credentials-guard.test.ts proves this on a representative sequence of
 * core modules and leaves the end-to-end version to WP-105; this is it. Every
 * function of `node:fs` and `node:fs/promises` is wrapped, the real install
 * handler runs twice (install, then the idempotent re-run) on a fake `$HOME`
 * seeded with credential decoys, and two facts are asserted:
 *
 * 1. inside the Paseo home the set of files read is exactly `{config.json}`;
 * 2. no credential file is touched anywhere, by any fs function.
 *
 * An `open` with write flags is not a read: the atomic write of config.json
 * opens its temporary file with `wx`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, sep } from "node:path";
import { EXIT_CODES } from "../../src/exit-codes.js";
import { isWriteFlags } from "../../src/fs-guard.js";
import type { Fixture } from "../helpers/install-harness.js";
import { createFixture, removeFixture, runInstall, seedCompleteSkills, writePaseoConfig, writePayload } from "../helpers/install-harness.js";

vi.setConfig({ testTimeout: 60_000 });

const recorder = vi.hoisted(() => {
  interface Touch {
    readonly fn: string;
    readonly path: string;
    readonly flags: string | number | undefined;
  }
  const touches: Touch[] = [];

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
  ]);

  const toPath = (value: unknown): string | undefined => {
    if (typeof value === "string") return value;
    if (value instanceof URL) return decodeURIComponent(value.pathname);
    if (value instanceof Uint8Array) return Buffer.from(value).toString("utf8");
    return undefined;
  };

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
        const flags = typeof args[1] === "string" || typeof args[1] === "number" ? args[1] : undefined;
        if (path !== undefined) touches.push({ fn: name, path, flags });
        return original(...args);
      };
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

const CREDENTIAL_FILE_NAMES: readonly string[] = [
  "auth.json",
  ".credentials.json",
  "credentials.json",
  ".claude.json",
  "sessions.json",
  "token.json",
  ".netrc",
];

const VERSION = "0.2.0";
let fixture: Fixture;

beforeEach(() => {
  fixture = createFixture("install-reads");
  writePayload(fixture, VERSION);
  writePaseoConfig(fixture, { daemon: { agentProfiles: [{ id: "room-lead", provider: "claude" }] } });
  seedCompleteSkills(fixture);

  // Decoys a careless implementation would read.
  const { home, paseoHome } = fixture;
  mkdirSync(join(paseoHome, "agents"), { recursive: true });
  writeFileSync(join(paseoHome, "auth.json"), '{"token":"never-read-me"}\n');
  writeFileSync(join(paseoHome, ".credentials.json"), '{"refresh":"never-read-me"}\n');
  writeFileSync(join(paseoHome, "agents", "credentials.json"), '{"apiKey":"never-read-me"}\n');
  writeFileSync(join(home, ".claude.json"), '{"oauthAccount":"never-read-me"}\n');
  writeFileSync(join(home, ".claude", ".credentials.json"), '{"accessToken":"never-read-me"}\n');
  mkdirSync(join(home, ".codex"), { recursive: true });
  writeFileSync(join(home, ".codex", "auth.json"), '{"OPENAI_API_KEY":"never-read-me"}\n');
  writeFileSync(join(home, ".netrc"), "machine api.anthropic.com password never-read-me\n");

  recorder.touches.length = 0;
});

afterEach(() => {
  removeFixture(fixture);
});

function isRead(touch: { fn: string; flags: string | number | undefined }): boolean {
  if (!recorder.READING_FUNCTIONS.has(touch.fn)) return false;
  return touch.fn === "open" || touch.fn === "openSync" ? !isWriteFlags(touch.flags) : true;
}

function filesReadInPaseoHome(): string[] {
  const prefix = `${fixture.paseoHome}${sep}`;
  return [
    ...new Set(recorder.touches.filter((touch) => isRead(touch) && touch.path.startsWith(prefix)).map((touch) => touch.path.slice(prefix.length))),
  ].sort();
}

function credentialTouches(): string[] {
  const names = new Set(CREDENTIAL_FILE_NAMES);
  return [
    ...new Set(
      recorder.touches.filter((touch) => touch.path.split(sep).some((segment) => names.has(segment))).map((touch) => `${touch.fn} ${touch.path}`),
    ),
  ].sort();
}

describe("install — what a whole install reads", () => {
  it("install and its re-run read exactly {config.json} in ~/.paseo and touch no credential file", async () => {
    const argv = ["install", "--apply", "--enable-plugins"];
    const first = await runInstall(fixture, argv, { version: VERSION });
    expect(first.thrown).toBeUndefined();
    expect(first.code).toBe(EXIT_CODES.ok);
    const second = await runInstall(fixture, argv, { version: VERSION });
    expect(second.thrown).toBeUndefined();
    expect(second.code).toBe(EXIT_CODES.ok);

    // The recording sits under the product modules: it saw the lock and config.json being read.
    expect(recorder.touches.map((touch) => touch.path)).toContain(join(fixture.installHome, ".lock"));
    expect(recorder.touches.some((touch) => isRead(touch) && touch.path === join(fixture.paseoHome, "config.json"))).toBe(true);

    expect(filesReadInPaseoHome()).toEqual(["config.json"]);
    expect(credentialTouches()).toEqual([]);
  });
});
