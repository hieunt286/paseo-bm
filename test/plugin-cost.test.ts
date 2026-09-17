import { describe, expect, it } from "vitest";
import { priceFor, priceUsage } from "../plugin/server/cost";
import { MODEL_PRICES, PRICES_UPDATED_AT } from "../plugin/shared/prices";
import type { Usage } from "../plugin/shared/contracts";

/**
 * WP-209: tokens and cost.
 *
 * The number that matters most here is the cache-read one: a million cached
 * tokens on opus-5 cost $0.50, not $5.00, and getting that wrong would inflate
 * every estimate tenfold on the cheapest part of a real conversation.
 */

const tokens = (overrides: Partial<Usage> = {}): Usage => ({
  inputTokens: 1_000_000,
  cachedInputTokens: 0,
  outputTokens: 0,
  costUsd: null,
  costBasis: "unavailable",
  model: "claude-opus-5",
  pricesUpdatedAt: null,
  ...overrides,
});

describe("price lookup", () => {
  it("finds a bare model id", () => {
    expect(priceFor("claude-opus-5")).toEqual(MODEL_PRICES["claude-opus-5"]);
  });

  it("finds a provider-qualified id", () => {
    expect(priceFor("bm-worker/claude-opus-5")).toEqual(MODEL_PRICES["claude-opus-5"]);
  });

  it("returns null for an unknown or empty model", () => {
    expect(priceFor("gpt-5.6-sol")).toBeNull();
    expect(priceFor("bm-reviewer/gpt-5.6-sol")).toBeNull();
    expect(priceFor(null)).toBeNull();
    expect(priceFor("")).toBeNull();
  });
});

describe("estimating a cost", () => {
  it("prices a million input tokens at the table rate", () => {
    const priced = priceUsage(tokens());
    expect(priced.costUsd).toBe(5);
    expect(priced.costBasis).toBe("estimated");
    expect(priced.pricesUpdatedAt).toBe(PRICES_UPDATED_AT);
  });

  it("prices cache reads with the cache rate, not the input rate", () => {
    const cached = priceUsage(tokens({ inputTokens: 0, cachedInputTokens: 1_000_000 }));
    expect(cached.costUsd).toBe(0.5);
    // Ten times cheaper than fresh input: the whole point of the separate column.
    expect(cached.costUsd).toBeCloseTo(priceUsage(tokens()).costUsd! / 10, 10);
  });

  it("prices output at the output rate and adds the three parts", () => {
    const mixed = priceUsage(
      tokens({ inputTokens: 100_000, cachedInputTokens: 900_000, outputTokens: 50_000 }),
    );
    // 0.1*5 + 0.9*0.5 + 0.05*25 = 0.5 + 0.45 + 1.25
    expect(mixed.costUsd).toBe(2.2);
  });

  it("prices a cheaper model with its own rates", () => {
    const haiku = priceUsage(tokens({ model: "claude-haiku-4-5" }));
    expect(haiku.costUsd).toBe(1);
  });

  it("reports no cost for a model that is not in the table", () => {
    const unknown = priceUsage(tokens({ model: "gpt-5.6-sol" }));
    expect(unknown).toMatchObject({ costUsd: null, costBasis: "unavailable", pricesUpdatedAt: null });
    expect(unknown.inputTokens).toBe(1_000_000);
  });

  it("leaves a provider-reported cost untouched", () => {
    const reported = tokens({ costUsd: 3.21, costBasis: "provider" });
    expect(priceUsage(reported)).toBe(reported);
  });

  it("does not invent precision", () => {
    const tiny = priceUsage(tokens({ inputTokens: 1, cachedInputTokens: 0, outputTokens: 0 }));
    expect(tiny.costUsd).toBe(0);
  });
});

describe("no network", () => {
  it("has no fetch or http call in the module", () => {
    const source = [priceUsage.toString(), priceFor.toString()].join("\n");
    expect(source).not.toMatch(/fetch|http|https|request/i);
  });
});
