import type * as NodeFs from "node:fs";
import { describe, vi } from "vitest";
import { scenarioSuite } from "./fixtures/mission-scenario";

/**
 * The seeded scenario of the delivery line (design §13; WP-7.9; M-36, M-40,
 * M-42): scripted Worker turns — bead closes, follow-ups, reviews and
 * re-reviews, questions and the owner's answers, waits on other requests,
 * peer asks and replies, compactions, handoffs and size rollovers — through
 * the plugin's real tools and hooks over the one fake Paseo and a temporary
 * data folder (`fixtures/mission-scenario.ts`), and its four invariants:
 *
 * 1. no request works past the hard rollover figures (`ceilingFactor` × its
 *    beads, turns or tokens), allowing one turn of slack;
 * 2. the chains' closed beads equal the beads the Workers closed;
 * 3. a Worker with an unsettled wait gets no send until an item settles, then
 *    exactly one;
 * 4. no compaction or handoff waits past its ceiling plus one turn end.
 *
 * This is the short run, kept under 20 seconds: 3 seeds of 250 Worker turns.
 * The long run, 2 seeds of 800, is the bench project's
 * (`mission-scenario-bounded-benchmark.test.ts`).
 */

// Every store write fsyncs; on a laptop disk that is milliseconds a write, thousands
// of writes a seed. Durability is not what this test measures.
vi.mock("node:fs", async (importOriginal) => ({ ...(await importOriginal<typeof NodeFs>()), fsyncSync: () => {} }));

describe("a seeded mission of scripted Worker turns (delivery line design §13)", () => {
  scenarioSuite({ seeds: [3, 4, 8], workerTurns: 250, timeoutMs: 120_000 });
});
