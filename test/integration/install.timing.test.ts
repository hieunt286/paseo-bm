/**
 * Install evidence — time (bead bm-wp-105-6ec.5; part of M-2, Design §8).
 * Primary Proof: `npm test -- integration/install`.
 *
 * `install --apply` of the repository's real plugin payload, against the fake
 * `paseo` daemon, must complete in under 20 seconds. The real M-2 figure
 * (≤ 60 s on a real daemon) is measured in WP-120, not here. The skills step
 * detects only (no `--install-skills`), as M-2 excludes installing skills.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EXIT_CODES } from "../../src/exit-codes.js";
import type { Fixture } from "../helpers/install-harness.js";
import { REPO_PAYLOAD, createFixture, removeFixture, runInstall, writePaseoConfig } from "../helpers/install-harness.js";

/** The bead's threshold for CI. */
const LIMIT_MS = 20_000;

vi.setConfig({ testTimeout: 60_000 });

let fixture: Fixture;

beforeEach(() => {
  fixture = createFixture("install-timing");
  writePaseoConfig(fixture, {});
});

afterEach(() => {
  removeFixture(fixture);
});

describe("install — time", () => {
  it(`install --apply with the fake daemon completes in under ${LIMIT_MS / 1000} seconds`, async () => {
    const run = await runInstall(fixture, ["install", "--apply", "--enable-plugins"], {
      version: "0.2.0",
      payloadRoot: REPO_PAYLOAD,
    });

    console.info(`install --apply (real payload, fake daemon, guard on): ${run.elapsedMs.toFixed(0)} ms`);
    expect(run.thrown).toBeUndefined();
    expect(run.code).toBe(EXIT_CODES.ok);
    expect(run.violations).toEqual([]);
    expect(run.elapsedMs).toBeLessThan(LIMIT_MS);
  });
});
