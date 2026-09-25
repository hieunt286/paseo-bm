import { z } from "zod";

/**
 * Model price table bundled with the release (WP-201, REQ-052c).
 *
 * Source of truth: docs/design/paseo-bm-dashboard.md §9.
 *
 * Two rules make this table safe to ship:
 *
 * 1. **Never fetched at run time.** Runtime code reads this constant and
 *    nothing else; the Dashboard makes no network call (REQ-052e).
 * 2. **A model that is not listed gets no price.** The cost then reports
 *    `costBasis: "unavailable"` and the UI shows tokens only (REQ-052d).
 *    Guessing a rate would be worse than showing nothing.
 *
 * The figures are *Anthropic first-party API* rates, checked on the date in
 * `PRICES_UPDATED_AT`. They are not an invoice: a provider-reported cost always
 * wins over this table, and the same model on Amazon Bedrock or Google Vertex
 * is billed at that partner's own rates, which are deliberately absent here.
 *
 * Cache reads are priced separately and are an order of magnitude cheaper than
 * fresh input. Charging `cachedInputTokens` at the input rate is the one
 * mistake that would make every estimate wildly too high, which is why the
 * table carries an explicit `cacheReadUsdPerMTok` per row instead of a ratio
 * applied in code.
 *
 * Models deliberately NOT in this table, so they resolve to "unavailable":
 * - Codex / OpenAI models (for example `gpt-5.6-sol`, which the `bm-reviewer`
 *   profile uses on this machine). No sourced figure was available when this
 *   table was written, and Dashboard Design §9 says other providers' rates come from
 *   that provider's own published page. Adding a guessed number is forbidden.
 * - Claude Fable / Mythos tiers. Their cache-read rate differs by version, and
 *   an unverified rate belongs nowhere near a cost display.
 *
 * This module is `shared/`, so it stays free of Node and React Native imports.
 */

/** The day the rates below were checked against the provider's published prices. */
export const PRICES_UPDATED_AT = "2026-06-24";

/** Rates for one model, in US dollars per one million tokens. */
export const modelPriceSchema = z.object({
  inputUsdPerMTok: z.number().nonnegative(),
  cacheReadUsdPerMTok: z.number().nonnegative(),
  outputUsdPerMTok: z.number().nonnegative(),
});

export type ModelPrice = z.infer<typeof modelPriceSchema>;

/**
 * Keyed by the bare model id Paseo reports in an agent's `runtimeInfo`/profile
 * (never `provider/model`): resolving the key is WP-209's job.
 */
export const MODEL_PRICES: Readonly<Record<string, ModelPrice>> = {
  "claude-opus-5": { inputUsdPerMTok: 5, cacheReadUsdPerMTok: 0.5, outputUsdPerMTok: 25 },
  "claude-opus-4-8": { inputUsdPerMTok: 5, cacheReadUsdPerMTok: 0.5, outputUsdPerMTok: 25 },
  "claude-opus-4-7": { inputUsdPerMTok: 5, cacheReadUsdPerMTok: 0.5, outputUsdPerMTok: 25 },
  "claude-opus-4-6": { inputUsdPerMTok: 5, cacheReadUsdPerMTok: 0.5, outputUsdPerMTok: 25 },
  "claude-sonnet-5": { inputUsdPerMTok: 2, cacheReadUsdPerMTok: 0.2, outputUsdPerMTok: 10 },
  "claude-sonnet-4-6": { inputUsdPerMTok: 3, cacheReadUsdPerMTok: 0.3, outputUsdPerMTok: 15 },
  "claude-haiku-4-5": { inputUsdPerMTok: 1, cacheReadUsdPerMTok: 0.1, outputUsdPerMTok: 5 },
};

/** Every id that has a bundled rate. */
export const PRICED_MODEL_IDS = Object.keys(MODEL_PRICES) as readonly string[];
