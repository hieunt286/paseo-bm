import type * as NodeFs from "node:fs";
import { describe, vi } from "vitest";
import { scenarioSuite } from "./fixtures/mission-scenario";

/**
 * The long run of the delivery line's seeded scenario (design §13; WP-7.9):
 * 2 seeds of 800 scripted Worker turns each, with the invariants of
 * `mission-scenario-bounded.test.ts`. About a minute, so it lives in the
 * bench project, which runs alone.
 */

// Every store write fsyncs; durability is not what this test measures.
vi.mock("node:fs", async (importOriginal) => ({ ...(await importOriginal<typeof NodeFs>()), fsyncSync: () => {} }));

describe("a seeded mission of 800 scripted Worker turns a seed (delivery line design §13)", () => {
  scenarioSuite({ seeds: [101, 202], workerTurns: 800, timeoutMs: 600_000 });
});
