import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { priceFor, priceUsage, type ListedPrices } from "../plugin/server/cost";
import { costOf, forgetModelCosts, listedPricesFor, priceOfCost } from "../plugin/server/model-costs";
import { LOOKUP_TIMEOUT_MS } from "../plugin/server/role-mode";
import { handleTracesGet, handleTracesList, type DashboardPaseo } from "../plugin/server/dashboard-rpc";
import { appendRecord, clearTraceStoreCache } from "../plugin/server/trace-store";
import { clearBeadsCache } from "../plugin/server/beads-store";
import { MODEL_PRICES, PRICES_UPDATED_AT } from "../plugin/shared/prices";
import { TRACE_STORE_SCHEMA_VERSION, type TraceRecord, type Usage } from "../plugin/shared/contracts";

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

/**
 * Delta 20260921 §4.2.7 (F2, REQ-063 g): a model the bundled table lacks is
 * priced from the `metadata.cost` Paseo lists for it, read with a fake
 * `providers.listModels`. Order: bundled table → listed rate → tokens only.
 */

const FETCHED_AT = "2026-09-21T08:00:00.000Z";

/** `providers.listModels` answer, the shape read on the owner's daemon. */
function modelList(models: Array<Record<string, unknown>>) {
  return { provider: "opencode", models, error: null, fetchedAt: FETCHED_AT };
}

const KIMI = {
  id: "openrouter/moonshotai/kimi-k2",
  label: "Kimi K2",
  thinkingOptions: [],
  metadata: {
    cost: {
      input: 0.6,
      output: 2.5,
      cache: { read: 0.15, write: 0.6 },
      // Surcharges above a context size: ignored, the usage cannot tell.
      tiers: [{ threshold: 128_000, input: 99, output: 99 }],
      experimentalOver200K: { input: 99, output: 99, cache: { read: 99, write: 99 } },
    },
  },
};

/** No `cache.read`: cache reads are priced at the input rate. */
const QWEN = {
  id: "openrouter/qwen/qwen3-coder",
  label: "Qwen3 Coder",
  metadata: { cost: { input: 0.4, output: 1.6 } },
};

/** Lists a rate for a model that is also in the bundled table. */
const SONNET_LISTED = {
  id: "claude-sonnet-4-6",
  label: "Sonnet 4.6",
  metadata: { cost: { input: 50, output: 50, cache: { read: 50, write: 50 } } },
};

const GPT = { id: "gpt-5.6-sol", label: "GPT-5.6-Sol", metadata: { cost: { input: 1.25, output: 10, cache: { read: 0.125 } } } };

function fakeProviders(
  answers: Record<string, unknown> = {
    "bm-worker": modelList([KIMI, QWEN, SONNET_LISTED]),
    "bm-reviewer": modelList([GPT]),
  },
) {
  const listModels = vi.fn(async (provider: string) => {
    const answer = answers[provider];
    if (answer instanceof Error) throw answer;
    return answer ?? modelList([]);
  });
  return { paseo: { providers: { listModels } }, listModels };
}

const silent = () => undefined;

beforeEach(() => {
  forgetModelCosts();
});

describe("a rate from Paseo's model list (costOf)", () => {
  it("maps input, output and cache.read, and ignores tiers and experimentalOver200K", async () => {
    const { paseo } = fakeProviders();
    expect(await costOf(paseo, "bm-worker", "openrouter/moonshotai/kimi-k2", silent)).toEqual({
      inputUsdPerMTok: 0.6,
      cacheReadUsdPerMTok: 0.15,
      outputUsdPerMTok: 2.5,
    });
  });

  it("prices a cache read at the input rate when the model lists no cache.read", async () => {
    const { paseo } = fakeProviders();
    expect(await costOf(paseo, "bm-worker", "openrouter/qwen/qwen3-coder", silent)).toEqual({
      inputUsdPerMTok: 0.4,
      cacheReadUsdPerMTok: 0.4,
      outputUsdPerMTok: 1.6,
    });
    expect(priceOfCost({ input: 1, output: 2, cache: { write: 3 } })).toEqual({
      inputUsdPerMTok: 1,
      cacheReadUsdPerMTok: 1,
      outputUsdPerMTok: 2,
    });
  });

  it("matches a model id containing slashes whole, never by its last part", async () => {
    const { paseo } = fakeProviders();
    expect(await costOf(paseo, "bm-worker", "kimi-k2", silent)).toBeNull();
    expect(await costOf(paseo, "bm-worker", "moonshotai/kimi-k2", silent)).toBeNull();
  });

  it("returns null for a model the list does not name or names without a usable cost", async () => {
    const { paseo } = fakeProviders({
      "bm-worker": modelList([
        { id: "no-cost", label: "x" },
        { id: "half-cost", label: "x", metadata: { cost: { input: 1 } } },
        { id: "bad-cost", label: "x", metadata: { cost: { input: -1, output: 2 } } },
      ]),
    });
    for (const model of ["no-cost", "half-cost", "bad-cost", "missing"]) {
      expect(await costOf(paseo, "bm-worker", model, silent)).toBeNull();
    }
  });

  it("asks each provider once per plugin run, whatever the model", async () => {
    const { paseo, listModels } = fakeProviders();
    await costOf(paseo, "bm-worker", "openrouter/moonshotai/kimi-k2", silent);
    await costOf(paseo, "bm-worker", "openrouter/qwen/qwen3-coder", silent);
    await costOf(paseo, "bm-worker/openrouter/qwen/qwen3-coder", "openrouter/qwen/qwen3-coder", silent);
    await costOf(paseo, "bm-reviewer", "gpt-5.6-sol", silent);
    await costOf(paseo, "bm-reviewer", "gpt-5.6-sol", silent);
    expect(listModels.mock.calls.map((call) => call[0])).toEqual(["bm-worker", "bm-reviewer"]);
  });

  it("never throws: a failing, erroring or missing listModels gives null and one warn line", async () => {
    const failing = fakeProviders({ "bm-worker": new Error("daemon went away") });
    const log = vi.fn();
    expect(await costOf(failing.paseo, "bm-worker", "openrouter/qwen/qwen3-coder", log)).toBeNull();
    expect(await costOf(failing.paseo, "bm-worker", "openrouter/moonshotai/kimi-k2", log)).toBeNull();
    expect(failing.listModels).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]![0]).toMatch(/^\[paseo-bm\] could not read the models of bm-worker \(daemon went away\)/);

    forgetModelCosts();
    const erroring = fakeProviders({ "bm-worker": { provider: "bm-worker", models: [], error: "provider is loading", fetchedAt: FETCHED_AT } });
    const log2 = vi.fn();
    expect(await costOf(erroring.paseo, "bm-worker", "openrouter/qwen/qwen3-coder", log2)).toBeNull();
    expect(log2).toHaveBeenCalledTimes(1);
    expect(log2.mock.calls[0]![0]).toMatch(/^\[paseo-bm\] .*provider is loading/);

    forgetModelCosts();
    const log3 = vi.fn();
    expect(await costOf({}, "bm-worker", "openrouter/qwen/qwen3-coder", log3)).toBeNull();
    expect(await costOf(null, "bm-worker", "openrouter/qwen/qwen3-coder", log3)).toBeNull();
    expect(log3).toHaveBeenCalledTimes(1);
    expect(log3.mock.calls[0]![0]).toMatch(/^\[paseo-bm\] /);

    forgetModelCosts();
    const throwing = { providers: { listModels: () => { throw new Error("sync boom"); } } };
    expect(await costOf(throwing, "bm-worker", "x", silent)).toBeNull();
  });

  it("gives up after the lookup budget, and uses the answer once it lands", async () => {
    vi.useFakeTimers();
    try {
      let answer: (value: unknown) => void = () => undefined;
      const listModels = vi.fn(() => new Promise((resolve) => (answer = resolve)));
      const paseo = { providers: { listModels } };
      const log = vi.fn();
      const slow = costOf(paseo, "bm-worker", "openrouter/qwen/qwen3-coder", log);
      await vi.advanceTimersByTimeAsync(LOOKUP_TIMEOUT_MS);
      expect(await slow).toBeNull();
      expect(log).toHaveBeenCalledTimes(1);
      expect(log.mock.calls[0]![0]).toMatch(/^\[paseo-bm\] reading the models of bm-worker took longer than 5000 ms/);

      answer(modelList([QWEN]));
      expect(await costOf(paseo, "bm-worker", "openrouter/qwen/qwen3-coder", log)).toMatchObject({ inputUsdPerMTok: 0.4 });
      expect(listModels).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

function turn(overrides: Partial<TraceRecord> = {}): TraceRecord {
  return {
    v: TRACE_STORE_SCHEMA_VERSION,
    kind: "turn",
    at: "2026-09-21T10:00:00.000Z",
    workspaceId: "wks_1",
    agentId: "agent-manager",
    role: "manager",
    turnId: "turn-1",
    requestId: "req-A",
    parentAgentId: null,
    agentCreatedAt: null,
    startedAt: "2026-09-21T10:00:00.000Z",
    endedAt: "2026-09-21T10:00:20.000Z",
    outcome: "completed",
    sent: [],
    received: [],
    reports: [],
    reviews: [],
    evidence: [],
    usage: null,
    ...overrides,
  };
}

const MILLION_EACH = { inputTokens: 1_000_000, cachedInputTokens: 1_000_000, outputTokens: 1_000_000 };

function usageOn(model: string | null): Usage {
  return { ...MILLION_EACH, costUsd: null, costBasis: "unavailable", model, pricesUpdatedAt: null };
}

function ranOn(model: string, provider: string | undefined, extra: Partial<TraceRecord> = {}): TraceRecord {
  return turn({
    usage: usageOn(model),
    runtime: { model, thinkingOptionId: null, modeId: null, ...(provider === undefined ? {} : { provider }) },
    ...extra,
  });
}

describe("listed rates for the records a Dashboard answer prices (listedPricesFor)", () => {
  it("prices an unpriced model from the provider its record names", async () => {
    const { paseo } = fakeProviders();
    const listed = await listedPricesFor(paseo, [ranOn("openrouter/moonshotai/kimi-k2", "bm-worker")], silent);
    // Keyed as recorded and by the last segment the trace roll-up groups on.
    expect(listed.get("openrouter/moonshotai/kimi-k2")).toEqual({
      price: { inputUsdPerMTok: 0.6, cacheReadUsdPerMTok: 0.15, outputUsdPerMTok: 2.5 },
      updatedAt: "2026-09-21",
    });
    expect(listed.get("kimi-k2")).toEqual(listed.get("openrouter/moonshotai/kimi-k2"));
  });

  it("uses only the bundled table for a record without runtime.provider", async () => {
    const { paseo, listModels } = fakeProviders();
    const listed = await listedPricesFor(
      paseo,
      [ranOn("gpt-5.6-sol", undefined), ranOn("openrouter/qwen/qwen3-coder", undefined), turn({ usage: usageOn("gpt-5.6-sol") })],
      silent,
    );
    expect(listed.size).toBe(0);
    expect(listModels).not.toHaveBeenCalled();
  });

  it("never asks for a model the bundled table prices", async () => {
    const { paseo, listModels } = fakeProviders();
    const listed = await listedPricesFor(paseo, [ranOn("claude-sonnet-4-6", "bm-worker")], silent);
    expect(listed.size).toBe(0);
    expect(listModels).not.toHaveBeenCalled();
  });

  it("gives no listed rate to ids that share a last segment but not a rate", async () => {
    const { paseo } = fakeProviders({
      "bm-worker": modelList([
        { id: "a/same-model", label: "x", metadata: { cost: { input: 1, output: 2 } } },
        { id: "b/same-model", label: "x", metadata: { cost: { input: 3, output: 4 } } },
      ]),
    });
    const listed = await listedPricesFor(
      paseo,
      [ranOn("a/same-model", "bm-worker"), ranOn("b/same-model", "bm-worker")],
      silent,
    );
    expect(listed.size).toBe(0);
  });

  it("never throws, and a provider that cannot be read leaves its models unpriced", async () => {
    const { paseo } = fakeProviders({ "bm-worker": new Error("down"), "bm-reviewer": modelList([GPT]) });
    const listed = await listedPricesFor(
      paseo,
      [ranOn("openrouter/qwen/qwen3-coder", "bm-worker"), ranOn("gpt-5.6-sol", "bm-reviewer")],
      silent,
    );
    expect([...listed.keys()]).toEqual(["gpt-5.6-sol"]);
    await expect(listedPricesFor(null, [ranOn("x/y", "bm-worker")], silent)).resolves.toEqual(new Map());
  });
});

describe("pricing a usage: bundled table → listed rate → tokens only", () => {
  const listed: ListedPrices = new Map([
    ["openrouter/qwen/qwen3-coder", { price: { inputUsdPerMTok: 0.4, cacheReadUsdPerMTok: 0.4, outputUsdPerMTok: 1.6 }, updatedAt: "2026-09-21" }],
    ["claude-sonnet-4-6", { price: { inputUsdPerMTok: 50, cacheReadUsdPerMTok: 50, outputUsdPerMTok: 50 }, updatedAt: "2026-09-21" }],
  ]);

  it("prices an unpriced model at its listed rate, dated by the list", () => {
    const priced = priceUsage(usageOn("openrouter/qwen/qwen3-coder"), listed);
    // 1M input × 0.4 + 1M cache reads × 0.4 (no cache.read listed) + 1M output × 1.6
    expect(priced).toMatchObject({ costUsd: 2.4, costBasis: "estimated", pricesUpdatedAt: "2026-09-21" });
  });

  it("keeps the bundled rate when the list names the same model", () => {
    expect(priceUsage(usageOn("claude-sonnet-4-6"), listed)).toEqual(priceUsage(usageOn("claude-sonnet-4-6")));
    expect(priceUsage(usageOn("claude-sonnet-4-6"), listed)).toMatchObject({ costUsd: 18.3, pricesUpdatedAt: PRICES_UPDATED_AT });
  });

  it("shows tokens only when neither knows the model", () => {
    expect(priceUsage(usageOn("gpt-5.6-sol"), listed)).toMatchObject({ costUsd: null, costBasis: "unavailable", pricesUpdatedAt: null });
    expect(priceUsage(usageOn(null), listed)).toMatchObject({ costUsd: null, costBasis: "unavailable" });
  });
});

describe("the Dashboard read RPCs price from the listed rates", () => {
  const WS = "wks_1";
  let home: string;
  let workspace: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "bm-cost-"));
    workspace = join(home, "repo");
    mkdirSync(join(workspace, ".beads"), { recursive: true });
  // From 0.4.0 the store is found with `resolveDataHome` (design §5.1).
    process.env["PASEO_BM_HOME"] = home;
    clearTraceStoreCache();
    clearBeadsCache();
  });

  afterEach(() => {
    delete process.env["PASEO_BM_HOME"];
    rmSync(home, { recursive: true, force: true });
  });

  function dashboardPaseo(): { paseo: DashboardPaseo; listModels: ReturnType<typeof fakeProviders>["listModels"] } {
    const { paseo: providers, listModels } = fakeProviders();
    const agents = [
      { id: "w1", workspaceId: WS, status: "idle", createdAt: "2026-09-21T10:00:10.000Z", labels: { "bm.role": "worker", "bm.requestId": "req-A" } },
      { id: "r1", workspaceId: WS, status: "idle", createdAt: "2026-09-21T10:00:20.000Z", labels: { "bm.role": "reviewer", "bm.requestId": "req-A", "paseo.parent-agent-id": "w1" } },
    ];
    const paseo: DashboardPaseo & typeof providers = {
      ...providers,
      agents: { list: vi.fn(async () => ({ entries: agents.map((agent) => ({ agent })) })) },
      workspaces: { list: vi.fn(async () => ({ entries: [{ id: WS, directory: workspace }] })) },
      config: {
        get: vi.fn(async () => ({
          config: { plugins: { "paseo-bm": { source: "directory", path: join(home, "plugin", "0.2.0") } } },
        })),
      },
    };
    return { paseo, listModels };
  }

  async function seed(): Promise<void> {
    const location = { tracesDir: join(home, "traces") };
    const records = [
      // The Manager on a bundled Claude model, recorded before runtime.provider.
      turn({ sent: [{ agentId: "agent-manager", at: "2026-09-21T10:00:00.000Z", text: "build it", truncated: false }], usage: usageOn("claude-opus-5") }),
      // The Worker on an OpenCode model the table lacks, with its provider.
      ranOn("openrouter/qwen/qwen3-coder", "bm-worker", {
        agentId: "w1",
        role: "worker",
        turnId: "w-turn",
        parentAgentId: "agent-manager",
        at: "2026-09-21T10:05:00.000Z",
        startedAt: "2026-09-21T10:00:30.000Z",
        endedAt: "2026-09-21T10:05:00.000Z",
      }),
      // A Reviewer turn written without runtime.provider: table only, so unpriced
      // even though the fake lists a rate for its model.
      turn({
        agentId: "r1",
        role: "reviewer",
        turnId: "r-turn",
        parentAgentId: "w1",
        at: "2026-09-21T10:04:00.000Z",
        startedAt: "2026-09-21T10:03:00.000Z",
        endedAt: "2026-09-21T10:04:00.000Z",
        usage: usageOn("gpt-5.6-sol"),
        runtime: { model: "gpt-5.6-sol", thinkingOptionId: null, modeId: null },
      }),
    ];
    for (const entry of records) await appendRecord(location, entry);
    clearTraceStoreCache();
  }

  it("prices the listed model in traces.list and traces.get, leaves the provider-less record unpriced, and asks once", async () => {
    await seed();
    const { paseo, listModels } = dashboardPaseo();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const { traces } = await handleTracesList({ workspaceId: WS }, paseo);
      const row = traces[0]!;
      const byModel = new Map((row.usageByModelRole ?? []).map((entry) => [entry.model, entry.usage]));
      // claude-opus-5 from the table: 1M × 5 + 1M × 0.5 + 1M × 25.
      expect(byModel.get("claude-opus-5")).toMatchObject({ costUsd: 30.5, pricesUpdatedAt: PRICES_UPDATED_AT });
      // qwen3-coder from its listed rate, cache reads at the input rate.
      expect(byModel.get("qwen3-coder")).toMatchObject({ costUsd: 2.4, costBasis: "estimated", pricesUpdatedAt: "2026-09-21" });
      expect(byModel.get("gpt-5.6-sol")).toMatchObject({ costUsd: null, costBasis: "unavailable" });
      expect(row.usage.costUsd).toBe(32.9);
      expect(row.notices.join(" ")).toContain("gpt-5.6-sol");
      expect(row.workerUsage.find((entry) => entry.agentId === "w1")?.usage.costUsd).toBe(2.4);

      const { trace } = await handleTracesGet({ workspaceId: WS, traceId: row.traceId }, paseo);
      expect(trace.usage.costUsd).toBe(32.9);
      expect(trace.usageByModel?.find((entry) => entry.model === "qwen3-coder")?.usage.costUsd).toBe(2.4);

      expect(listModels.mock.calls.map((call) => call[0])).toEqual(["bm-worker"]);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});
