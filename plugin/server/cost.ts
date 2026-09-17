/**
 * Tokens and cost (WP-209, Dashboard Design §9, REQ-052).
 *
 * Three rules, in order:
 *
 * 1. **A cost the provider reported wins.** It is the only figure that is not
 *    an estimate, so it is used verbatim and labelled `provider`.
 * 2. **Otherwise estimate from the bundled, dated table**, and label the result
 *    `estimated` together with the date of the table. Cache reads are priced
 *    with their own rate: charging `cachedInputTokens` at the input rate is the
 *    single mistake that would make every estimate several times too high.
 * 3. **A model that is not in the table gets no number.** `costBasis` becomes
 *    `unavailable` and the UI shows tokens only (REQ-052d). A guessed rate
 *    would be worse than an empty cell.
 *
 * There is no network call here and no way to add one: the table is a constant
 * in `shared/prices.ts` (REQ-052e).
 */
import { MODEL_PRICES, PRICES_UPDATED_AT, type ModelPrice } from "../shared/prices";
import type { Usage } from "../shared/contracts";

const PER_MILLION = 1_000_000;

/**
 * Price row for a model id.
 *
 * Accepts `provider/model` as well as a bare id, because Paseo reports the
 * provider-qualified form in some places (`bm-worker/claude-opus-5`) and the
 * bare model id in others.
 */
export function priceFor(model: string | null): ModelPrice | null {
  if (model === null || model === "") return null;
  const direct = MODEL_PRICES[model];
  if (direct !== undefined) return direct;
  const slash = model.lastIndexOf("/");
  if (slash === -1) return null;
  return MODEL_PRICES[model.slice(slash + 1)] ?? null;
}

/** Rounds to cents-with-headroom so a displayed estimate is not fake-precise. */
function roundUsd(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

/**
 * Applies rule 1 to 3 to a token sum.
 *
 * A usage that already carries `costBasis: "provider"` is returned untouched:
 * re-estimating over a real figure would replace a fact with an approximation.
 */
export function priceUsage(usage: Usage): Usage {
  if (usage.costBasis === "provider" && usage.costUsd !== null) return usage;

  const price = priceFor(usage.model);
  if (price === null) {
    return { ...usage, costUsd: null, costBasis: "unavailable", pricesUpdatedAt: null };
  }

  const costUsd = roundUsd(
    (usage.inputTokens * price.inputUsdPerMTok +
      usage.cachedInputTokens * price.cacheReadUsdPerMTok +
      usage.outputTokens * price.outputUsdPerMTok) /
      PER_MILLION,
  );
  return { ...usage, costUsd, costBasis: "estimated", pricesUpdatedAt: PRICES_UPDATED_AT };
}
