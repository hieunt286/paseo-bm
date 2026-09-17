import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { EXIT_CODES } from "../../src/exit-codes.js";
import type { Fixture } from "../helpers/install-harness.js";
import {
  createFixture,
  removeFixture,
  runInstall,
  seedCompleteSkills,
  snapshotTree,
  writePaseoConfig,
  writePayload,
} from "../helpers/install-harness.js";

/**
 * Q-039 / ADR-007: updating paseo-bm never touches the Dashboard's trace store.
 *
 * The WP-214 acceptance run could not do a live version update with a store in
 * place without reloading the plugin under the owner's running agents, so the
 * byte-for-byte proof lives here: a store written under 0.1.0 survives the
 * upgrade to 0.2.0 unchanged, including its permissions.
 */
let fixture: Fixture;

beforeEach(() => {
  fixture = createFixture("install-trace-store");
  writePaseoConfig(fixture, {});
  seedCompleteSkills(fixture);
});

afterEach(() => {
  removeFixture(fixture);
});

describe("install upgrade and the trace store", () => {
  it("leaves every trace file byte-identical across 0.1.0 → 0.2.0 and a re-apply", async () => {
    const argv = ["install", "--apply", "--enable-plugins"];
    writePayload(fixture, "0.1.0");
    expect((await runInstall(fixture, argv, { version: "0.1.0", guard: "off" })).code).toBe(EXIT_CODES.ok);

    const traces = join(fixture.installHome, "traces");
    const workspace = join(traces, "wks_owner");
    mkdirSync(workspace, { recursive: true, mode: 0o700 });
    writeFileSync(join(traces, "meta.json"), '{"schemaVersion":1}\n', { mode: 0o600 });
    writeFileSync(join(workspace, "meta.json"), '{"lastKnownName":"repo"}\n', { mode: 0o600 });
    writeFileSync(join(workspace, "events-202609.jsonl"), '{"v":1,"kind":"turn"}\n', { mode: 0o600 });
    const before = snapshotTree(traces);

    writePayload(fixture, "0.2.0");
    expect((await runInstall(fixture, argv, { version: "0.2.0", guard: "off" })).code).toBe(EXIT_CODES.ok);
    expect(snapshotTree(traces)).toEqual(before);

    // A second apply of the same version (the WP-214 run did ten) changes nothing either.
    expect((await runInstall(fixture, argv, { version: "0.2.0", guard: "off" })).code).toBe(EXIT_CODES.ok);
    expect(snapshotTree(traces)).toEqual(before);
  });
});
