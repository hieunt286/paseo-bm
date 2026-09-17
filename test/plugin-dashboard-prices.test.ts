import { describe, expect, it } from "vitest";
import {
  MODEL_PRICES,
  PRICED_MODEL_IDS,
  PRICES_UPDATED_AT,
  modelPriceSchema,
} from "../plugin/shared/prices";

/**
 * WP-201: the bundled price table (REQ-052c, REQ-052d, REQ-052e).
 *
 * The tests guard the three properties that keep a displayed estimate honest:
 * every row is complete, cache reads are cheaper than fresh input, and the date
 * is a real checked date rather than a placeholder someone forgot to fill in.
 */

describe("bundled price table", () => {
  it("carries a real ISO date, not a placeholder", () => {
    expect(PRICES_UPDATED_AT).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const parsed = new Date(`${PRICES_UPDATED_AT}T00:00:00.000Z`);
    expect(Number.isNaN(parsed.getTime())).toBe(false);
    expect(PRICES_UPDATED_AT).not.toMatch(/0000|TODO|XXXX|1970-01-01/);
  });

  it("is not empty", () => {
    expect(PRICED_MODEL_IDS.length).toBeGreaterThan(0);
    expect(Object.keys(MODEL_PRICES)).toEqual([...PRICED_MODEL_IDS]);
  });

  it.each(Object.entries(MODEL_PRICES))("%s has all three rates in the designed units", (_id, price) => {
    expect(modelPriceSchema.parse(price)).toEqual(price);
    expect(price.inputUsdPerMTok).toBeGreaterThan(0);
    expect(price.outputUsdPerMTok).toBeGreaterThan(0);
    expect(price.cacheReadUsdPerMTok).toBeGreaterThan(0);
  });

  it.each(Object.entries(MODEL_PRICES))(
    "%s prices a cache read below fresh input, and output above input",
    (_id, price) => {
      expect(price.cacheReadUsdPerMTok).toBeLessThan(price.inputUsdPerMTok);
      expect(price.outputUsdPerMTok).toBeGreaterThan(price.inputUsdPerMTok);
    },
  );

  it("leaves an unsourced model out so it can only resolve to unavailable", () => {
    expect(MODEL_PRICES["gpt-5.6-sol"]).toBeUndefined();
    expect(MODEL_PRICES["claude-fable-5-1"]).toBeUndefined();
    expect(MODEL_PRICES["made-up-model"]).toBeUndefined();
  });

  it("rejects an incomplete row shape", () => {
    expect(modelPriceSchema.safeParse({ inputUsdPerMTok: 5, outputUsdPerMTok: 25 }).success).toBe(false);
    expect(
      modelPriceSchema.safeParse({ inputUsdPerMTok: -5, cacheReadUsdPerMTok: 0.5, outputUsdPerMTok: 25 })
        .success,
    ).toBe(false);
  });
});
