/**
 * Model rates from Paseo's own model list (delta 20260921 §4.2.7, F2, REQ-063 g).
 *
 * The bundled table in `shared/prices.ts` only knows Claude models. Paseo lists
 * every model of a provider with `providers.listModels(provider)`, and a model
 * there may carry `metadata.cost = { input, output, cache: { read, write },
 * tiers?, experimentalOver200K? }` in US dollars per million tokens (every
 * OpenCode model does). `costOf` turns that into a `ModelPrice`:
 *
 * - `input` → `inputUsdPerMTok`, `output` → `outputUsdPerMTok`;
 * - `cache.read` → `cacheReadUsdPerMTok`, or the input rate when the model
 *   lists no cache-read rate (never a guessed discount);
 * - `cache.write`, `tiers` and `experimentalOver200K` are ignored: the
 *   Dashboard's usage has no cache-write count, and a tier is a surcharge above
 *   a context size the usage does not record.
 *
 * Model ids are matched whole: an OpenCode id contains `/`
 * (`anthropic/claude-sonnet-4-6`), so the part after a slash is never enough.
 *
 * Each provider's list is asked for ONCE per plugin run and remembered,
 * whatever the answer, so a failure costs one `console.warn` line and not one
 * per Dashboard refresh. Every wait is raced against `LOOKUP_TIMEOUT_MS`; a
 * slow call keeps running, and a later lookup uses its answer once it lands.
 * Nothing here throws.
 *
 * The Dashboard prices synchronously (`priceUsage`), so its handlers resolve
 * the listed rates of the models their records name first
 * (`listedPricesFor`) and hand the result in as a plain map.
 */
import { priceFor, type ListedPrices } from "./cost";
import { providerId } from "./provider-id";
import { LOOKUP_TIMEOUT_MS, TIMED_OUT, withTimeout } from "./role-mode";
import { effectiveModel } from "./traces";
import { modelPriceSchema, type ModelPrice } from "../shared/prices";
import type { TraceRecord } from "../shared/contracts";

/** What one provider's model list gave: rates by model id, or why there are none. */
type ModelList = { prices: Map<string, ModelPrice>; readAt: string } | { failure: string };

interface ListEntry {
  answer: Promise<ModelList>;
  warned: boolean;
}

/** One entry per provider id for the life of the plugin. */
const lists = new Map<string, ListEntry>();

/** Forgets every remembered list; for tests. */
export function forgetModelCosts(): void {
  lists.clear();
}

const isRate = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;

/**
 * A `ModelPrice` from one model's `metadata.cost`, or null when the input or
 * output rate is missing or not a usable number.
 */
export function priceOfCost(cost: unknown): ModelPrice | null {
  if (cost === null || typeof cost !== "object") return null;
  const { input, output, cache } = cost as { input?: unknown; output?: unknown; cache?: unknown };
  if (!isRate(input) || !isRate(output)) return null;
  const read = cache !== null && typeof cache === "object" ? (cache as { read?: unknown }).read : undefined;
  const parsed = modelPriceSchema.safeParse({
    inputUsdPerMTok: input,
    cacheReadUsdPerMTok: isRate(read) ? read : input,
    outputUsdPerMTok: output,
  });
  return parsed.success ? parsed.data : null;
}

/** Rates by model id (and alias, when no id claims it) from a `listModels` answer. */
function parseModelList(answer: unknown): ModelList {
  const result = answer as { models?: unknown; error?: unknown; fetchedAt?: unknown } | null | undefined;
  if (typeof result?.error === "string" && result.error !== "") return { failure: result.error };
  if (!Array.isArray(result?.models)) return { failure: "no models listed" };
  const prices = new Map<string, ModelPrice>();
  const aliases: Array<[string, ModelPrice]> = [];
  for (const model of result.models as unknown[]) {
    if (model === null || typeof model !== "object") continue;
    const { id, aliases: names, metadata } = model as { id?: unknown; aliases?: unknown; metadata?: unknown };
    if (typeof id !== "string" || id === "") continue;
    const price = priceOfCost(metadata !== null && typeof metadata === "object" ? (metadata as { cost?: unknown }).cost : undefined);
    if (price === null) continue;
    if (!prices.has(id)) prices.set(id, price);
    if (Array.isArray(names)) {
      for (const name of names) if (typeof name === "string" && name !== "") aliases.push([name, price]);
    }
  }
  for (const [name, price] of aliases) if (!prices.has(name)) prices.set(name, price);
  const fetchedAt = typeof result?.fetchedAt === "string" && result.fetchedAt !== "" ? result.fetchedAt : null;
  return { prices, readAt: fetchedAt ?? new Date().toISOString() };
}

/** Asks for one provider's list. Never rejects: a failure is a value. */
async function readModelList(paseo: unknown, provider: string, cwd: string | undefined): Promise<ModelList> {
  const providers = (paseo as { providers?: { listModels?: unknown } } | null | undefined)?.providers;
  const listModels = providers?.listModels;
  if (typeof listModels !== "function") return { failure: "this Paseo host cannot list models" };
  try {
    return parseModelList(
      await (cwd === undefined ? listModels.call(providers, provider) : listModels.call(providers, provider, { cwd })),
    );
  } catch (error) {
    return { failure: error instanceof Error ? error.message : String(error) };
  }
}

function warnOnce(entry: ListEntry, log: (message: string) => void, message: string): void {
  if (entry.warned) return;
  entry.warned = true;
  log(message);
}

/**
 * The listed rate of `model` on `provider` and when the list was read, or
 * null. `provider` may be a bare id (`bm-worker`) or a selection
 * (`bm-worker/<model>`); a bm-* alias is passed as is, since Paseo resolves it
 * the way it does for `listModes`.
 */
async function listedCostOf(
  paseo: unknown,
  provider: string,
  model: string,
  log: (message: string) => void,
  cwd: string | undefined,
): Promise<{ price: ModelPrice; readAt: string } | null> {
  try {
    const id = providerId(provider);
    if (id === null || id === "" || model === "") return null;
    let entry = lists.get(id);
    if (entry === undefined) {
      entry = { answer: readModelList(paseo, id, cwd), warned: false };
      lists.set(id, entry);
    }
    const list = await withTimeout(entry.answer);
    if (list === TIMED_OUT) {
      warnOnce(
        entry,
        log,
        `[paseo-bm] reading the models of ${id} took longer than ${LOOKUP_TIMEOUT_MS} ms; models missing from the bundled price table show tokens only.`,
      );
      return null;
    }
    if ("failure" in list) {
      warnOnce(
        entry,
        log,
        `[paseo-bm] could not read the models of ${id} (${list.failure}); models missing from the bundled price table show tokens only.`,
      );
      return null;
    }
    const price =
      list.prices.get(model) ?? (model.startsWith(`${id}/`) ? list.prices.get(model.slice(id.length + 1)) : undefined);
    return price === undefined ? null : { price, readAt: list.readAt };
  } catch {
    return null;
  }
}

/**
 * The rate Paseo lists for `model` on `provider`, or null when it lists none
 * or the list cannot be read in time. Does not consult the bundled table: the
 * order "table first" is the caller's (`priceUsage`, `listedPricesFor`).
 */
export async function costOf(
  paseo: unknown,
  provider: string,
  model: string,
  log: (message: string) => void = (message) => console.warn(message),
  cwd?: string,
): Promise<ModelPrice | null> {
  return (await listedCostOf(paseo, provider, model, log, cwd))?.price ?? null;
}

const lastSegment = (model: string): string => model.slice(model.lastIndexOf("/") + 1);

const samePrice = (a: ModelPrice, b: ModelPrice): boolean =>
  a.inputUsdPerMTok === b.inputUsdPerMTok &&
  a.cacheReadUsdPerMTok === b.cacheReadUsdPerMTok &&
  a.outputUsdPerMTok === b.outputUsdPerMTok;

/**
 * Listed rates for the models `records` ran on, ready for `priceUsage`.
 *
 * Only records that name `runtime.provider` and a model the bundled table
 * lacks are looked up; a record written before `runtime.provider` existed is
 * priced from the table alone. Lookups for distinct providers run together.
 *
 * Keys: the model id as recorded and its last `/` segment, because the trace
 * roll-up groups models by that segment and hands either form to the pricer.
 * When two recorded ids share a segment but their listed rates differ, none of
 * them gets a listed rate: a group mixing both could only be priced wrongly.
 * Never throws; a failure leaves the map without that model.
 */
export async function listedPricesFor(
  paseo: unknown,
  records: readonly TraceRecord[],
  log: (message: string) => void = (message) => console.warn(message),
  cwd?: string,
): Promise<ListedPrices> {
  const out = new Map<string, { price: ModelPrice; updatedAt: string }>();
  try {
    const wanted = new Map<string, { provider: string; model: string }>();
    for (const record of records) {
      const provider = record.runtime?.provider;
      const model = effectiveModel(record);
      if (typeof provider !== "string" || provider === "" || model === null || model === "") continue;
      if (priceFor(model) !== null) continue;
      wanted.set(JSON.stringify([provider, model]), { provider, model });
    }
    if (wanted.size === 0) return out;

    const found = await Promise.all(
      [...wanted.values()].map(async ({ provider, model }) => ({
        model,
        listed: await listedCostOf(paseo, provider, model, log, cwd),
      })),
    );
    const bySegment = new Map<string, Array<{ model: string; price: ModelPrice; updatedAt: string }>>();
    for (const { model, listed } of found) {
      if (listed === null) continue;
      const segment = lastSegment(model);
      const group = bySegment.get(segment) ?? [];
      group.push({ model, price: listed.price, updatedAt: listed.readAt.slice(0, 10) });
      bySegment.set(segment, group);
    }
    for (const [segment, group] of bySegment) {
      const [first] = group;
      if (first === undefined || !group.every((entry) => samePrice(entry.price, first.price))) continue;
      out.set(segment, { price: first.price, updatedAt: first.updatedAt });
      for (const entry of group) out.set(entry.model, { price: entry.price, updatedAt: entry.updatedAt });
    }
  } catch {
    // A pricing extra: without it the Dashboard shows tokens only, as before.
  }
  return out;
}
