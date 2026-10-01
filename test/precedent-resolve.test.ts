import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleDecisionsAnswer } from "../plugin/server/decision-rpc";
import { DECISIONS_DIR_NAME, clearDecisionStoreCache, createDecisionStore } from "../plugin/server/decision-store";
import { syncFallbackDecisions } from "../plugin/server/fallback-decisions";
import { ROLE_FALLBACK_STATE_FILE } from "../plugin/server/fallback-state";
import { createOrchestratorTools, type OrchestratorToolsDeps } from "../plugin/server/orchestrator-tools";
import { answerNoticeOf } from "../plugin/server/orchestrator-decisions";
import { createPrecedentStore } from "../plugin/server/precedent-store";
import { resolveByPrecedent, supersedePrecedentsBy } from "../plugin/server/precedent-resolve";
import { appendRecord, clearTraceStoreCache } from "../plugin/server/trace-store";
import type { FallbackIncident } from "../plugin/shared/contracts";
import {
  GRANT_TTL_MS,
  answerDecision,
  confirmDecision,
  markNeedsConfirmation,
  type Decision,
  type DecisionClass,
  type DecisionOption,
} from "../plugin/shared/decisions";
import {
  PRECEDENT_SCOPE_ALL,
  precedentAnswerOf,
  precedentFor,
  precedentReasonOf,
  precedentResolutionOf,
  precedentSchema,
  precedentsContradictedBy,
  type Precedent,
  type PrecedentDraft,
} from "../plugin/shared/precedents";
import { DECISION_WS, makeDecision } from "./helpers/decisions";
import { turn } from "./fixtures/orchestrator-traces";

/**
 * A decision whose subject matches an active owner precedent is resolved by
 * it unless its class is owner-fixed (autonomy design §B.6, §B.9; PRD REQ-124
 * b, c): the pure rules, the resolution at open for every asker kind, the
 * hard-owner classes kept as a suggestion, and the owner's differing answer
 * superseding the precedent. A temporary data folder only; never the real HOME.
 */

const NOW = new Date("2026-09-30T10:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (days: number) => new Date(NOW.getTime() - days * DAY);
const SUBJECT = "test-db";
const OTHER_WS = "wks_other";

let root: string;
let home: string;
let logs: string[];
let ids: number;

const log = (message: string) => void logs.push(message);
const precedents = () => createPrecedentStore(home, { newId: () => `id-${++ids}` });
const decisions = () => createDecisionStore(home);
const decisionsFile = (workspaceId = DECISION_WS) => {
  const path = join(home, DECISIONS_DIR_NAME, `${workspaceId}.json`);
  return existsSync(path) ? readFileSync(path, "utf8") : null;
};

/** Saves a precedent (on `test-db` in the decision's project, "SQLite", 30 days) as the owner would. */
function save(overrides: Partial<PrecedentDraft> = {}, at: Date = NOW): Precedent {
  return precedents().save({ scope: DECISION_WS, subject: SUBJECT, text: "SQLite", sourceDecisionId: null, expiresInDays: 30, ...overrides }, at).precedent;
}

const OPTIONS: DecisionOption[] = [
  { key: "a", label: "SQLite", recommended: true, effects: ["none"] },
  { key: "b", label: "Postgres in a container", recommended: false, effects: ["dependency-install"] },
];

/** An open Worker question on `test-db`: a dependency question, which may be delegated. */
const question = (overrides: Partial<Decision> = {}): Decision =>
  makeDecision({ subject: SUBJECT, question: "Which database for the tests?", class: "dependency", options: OPTIONS, ...overrides });

/** Opens `decision` in the store, then resolves it as the plugin does at open. */
function openAndResolve(decision: Decision) {
  const opened = decisions().open(decision).decision;
  return resolveByPrecedent(opened, { home, now: NOW, log });
}

function ok(result: ReturnType<typeof answerDecision>): Decision {
  if (!result.ok) throw new Error(result.message);
  return result.decision;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "bm-precedent-resolve-"));
  home = join(root, "data");
  logs = [];
  ids = 0;
  clearDecisionStoreCache();
  clearTraceStoreCache();
});

afterEach(() => {
  clearTraceStoreCache();
  rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// The pure rules (shared/precedents.ts).
// ---------------------------------------------------------------------------

describe("which precedent bears on a decision", () => {
  const precedent = (overrides: Partial<Precedent>): Precedent => ({
    id: "p:1",
    scope: DECISION_WS,
    subject: SUBJECT,
    text: "SQLite",
    sourceDecisionId: null,
    createdAt: daysAgo(1).toISOString(),
    expiresAt: new Date(NOW.getTime() + 29 * DAY).toISOString(),
    supersededBy: null,
    ...overrides,
  });

  it("takes the workspace's own before a newer global one, and a global one when the workspace has none", () => {
    const own = precedent({ id: "p:own", createdAt: daysAgo(5).toISOString() });
    const global = precedent({ id: "p:global", scope: PRECEDENT_SCOPE_ALL, text: "Postgres in a container", createdAt: daysAgo(1).toISOString() });
    expect(precedentFor(question(), [global, own], NOW)?.id).toBe("p:own");
    expect(precedentFor(question(), [global], NOW)?.id).toBe("p:global");
    // The newest of the workspace's own.
    expect(precedentFor(question(), [own, precedent({ id: "p:newer", createdAt: daysAgo(2).toISOString() })], NOW)?.id).toBe("p:newer");
  });

  it("matches nothing without a subject, on another subject, in another project, or once expired or superseded", () => {
    const standing = precedent({});
    expect(precedentFor(question({ subject: null }), [standing], NOW)).toBeNull();
    expect(precedentFor(question({ subject: "test-layout" }), [standing], NOW)).toBeNull();
    expect(precedentFor(question(), [precedent({ scope: OTHER_WS })], NOW)).toBeNull();
    expect(precedentFor(question(), [precedent({ expiresAt: NOW.toISOString() })], NOW)).toBeNull();
    expect(precedentFor(question(), [precedent({ supersededBy: "p:2" })], NOW)).toBeNull();
    expect(precedentFor(question(), [precedent({ supersededBy: "q:req-20260929T073348Z:Q4" })], NOW)).toBeNull();
  });

  it("answers with the option whose label is its text, spacing aside, else with its text as the owner's words", () => {
    expect(precedentAnswerOf(question(), { text: "  Postgres   in a container " })).toEqual({ optionKey: "b" });
    expect(precedentAnswerOf(question(), { text: "sqlite" })).toEqual({ words: "sqlite" });
    expect(precedentAnswerOf(question(), { text: "Whatever the CI image has" })).toEqual({ words: "Whatever the CI image has" });
  });

  it("resolves a delegable class, and only suggests for release, data, security and cost", () => {
    const standing = precedent({});
    expect(precedentResolutionOf(question(), [standing], NOW)).toEqual({ kind: "resolve", precedent: standing, answer: { optionKey: "a" } });
    // An owner cell does not stop it (§B.9): nothing here reads the policy.
    for (const decisionClass of ["reversible-technical", "preference", "scope", "environment", "dependency"] as DecisionClass[]) {
      expect(precedentResolutionOf(question({ class: decisionClass }), [standing], NOW)?.kind).toBe("resolve");
    }
    for (const decisionClass of ["release", "data", "security", "cost"] as DecisionClass[]) {
      expect(precedentResolutionOf(question({ class: decisionClass }), [standing], NOW)).toEqual({ kind: "suggest", precedent: standing, why: "owner-fixed" });
    }
    // A class its effects raise to one of the four is owner-fixed too, whatever was proposed.
    const pushing = question({ class: "preference", options: [{ key: "a", label: "SQLite", recommended: true, effects: ["push"] }] });
    expect(precedentResolutionOf(pushing, [standing], NOW)?.kind).toBe("suggest");
  });

  it("resolves a fallback incident only with one of its options, and nothing that is not open", () => {
    const fallback = question({ id: "f:fb-000000000d01", requestId: null, round: null, class: "environment", subject: "fallback-worker", options: [
      { key: "switch", label: "Switch to bm-worker-fallback-1 · codex · gpt-5.6-sol", recommended: true, effects: ["none"], action: { kind: "fallback", action: "switch", target: "fb-000000000d01" } },
      { key: "dismiss", label: "I'll handle it", recommended: false, effects: ["none"], action: { kind: "fallback", action: "dismiss", target: "fb-000000000d01" } },
    ] });
    const handle = precedent({ subject: "fallback-worker", text: "I'll handle it" });
    expect(precedentResolutionOf(fallback, [handle], NOW)).toMatchObject({ kind: "resolve", answer: { optionKey: "dismiss" } });
    expect(precedentResolutionOf(fallback, [{ ...handle, text: "Always wait" }], NOW)).toMatchObject({ kind: "suggest", why: "no-option" });
    const marked = ok(markNeedsConfirmation(question(), { via: "chat-worker", at: NOW.toISOString() }));
    expect(precedentResolutionOf(marked, [precedent({})], NOW)).toBeNull();
  });

  it("names its subject, scope and day in the reason", () => {
    expect(precedentReasonOf(precedent({}))).toBe(`The owner's precedent on "${SUBJECT}", saved ${daysAgo(1).toISOString().slice(0, 10)}`);
    expect(precedentReasonOf(precedent({ scope: PRECEDENT_SCOPE_ALL }))).toContain("for all projects");
  });

  it("finds the precedents an owner's answer contradicts, in the order they apply, up to one it repeats", () => {
    const own = precedent({ id: "p:own", text: "SQLite" });
    const global = precedent({ id: "p:global", scope: PRECEDENT_SCOPE_ALL, text: "Postgres in a container" });
    const answered = (input: { optionKey?: string; words?: string }) =>
      ok(answerDecision(question(), { via: "inbox", optionKey: input.optionKey ?? null, words: input.words ?? null, at: NOW.toISOString() }));
    // Differs from both: the next decision would meet the global one, which it contradicts too.
    expect(precedentsContradictedBy(answered({ words: "DuckDB" }), [own, global], NOW).map((p) => p.id)).toEqual(["p:own", "p:global"]);
    // Repeats the workspace's: nothing, and the global one (which does not apply here) is left alone.
    expect(precedentsContradictedBy(answered({ optionKey: "a" }), [own, global], NOW)).toEqual([]);
    // Differs from the workspace's, repeats the global one: only the workspace's.
    expect(precedentsContradictedBy(answered({ optionKey: "b" }), [own, global], NOW).map((p) => p.id)).toEqual(["p:own"]);
    // Only the owner's answer, with a text, on a subject.
    const byPrecedent = ok(answerDecision(question(), { by: "precedent", precedentId: "p:own", via: "inbox", words: "DuckDB", at: NOW.toISOString() }));
    expect(precedentsContradictedBy(byPrecedent, [own], NOW)).toEqual([]);
    const confirmed = ok(confirmDecision(ok(markNeedsConfirmation(question(), { via: "chat-worker", at: NOW.toISOString() })), { answered: true, at: NOW.toISOString() }));
    expect(precedentsContradictedBy(confirmed, [own], NOW)).toEqual([]);
    expect(precedentsContradictedBy(answered({ words: "DuckDB" }), [{ ...own, subject: "test-layout" }], NOW)).toEqual([]);
  });

  it("stores a decision id as what superseded a precedent", () => {
    expect(precedentSchema.safeParse(precedent({ supersededBy: "q:req-20260929T073348Z:Q4" })).success).toBe(true);
    expect(precedentSchema.safeParse(precedent({ supersededBy: "o:0b6f" })).success).toBe(true);
    expect(precedentSchema.safeParse(precedent({ supersededBy: "not an id" })).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// At open (server/precedent-resolve.ts).
// ---------------------------------------------------------------------------

describe("resolving a decision at open", () => {
  it("answers a delegable-class decision with the matching option, by precedent, citing it, with an owner answer's grant", () => {
    const standing = save();
    const result = openAndResolve(question());
    expect(result.resolved).toBe(true);
    expect(result.precedent?.id).toBe(standing.id);
    expect(result.decision).toMatchObject({
      status: "answered",
      settledAt: NOW.toISOString(),
      answer: {
        by: "precedent",
        via: "inbox",
        optionKey: "a",
        words: null,
        at: NOW.toISOString(),
        precedentId: standing.id,
        reason: `The owner's precedent on "${SUBJECT}", saved 2026-09-30`,
        class: "dependency",
      },
      grant: null,
    });
    expect(decisions().get(result.decision.id, DECISION_WS)).toEqual(result.decision);
    expect(logs).toEqual([]);
  });

  it("answers in the owner's standing words when no option is its text, granting what own words grant", () => {
    save({ text: "Whatever the CI image ships" });
    const result = openAndResolve(question());
    expect(result.decision.answer).toMatchObject({ by: "precedent", optionKey: null, words: "Whatever the CI image ships" });
    // Own words grant every effect the decision declares, never a hard-owner one: those make the class owner-fixed.
    expect(result.decision.grant).toEqual({ effects: ["dependency-install"], expiresAt: new Date(NOW.getTime() + GRANT_TTL_MS).toISOString(), usedAt: null });
  });

  it("does not answer with an expired, ended or superseded precedent", () => {
    save({}, daysAgo(31));
    const ended = save({ scope: PRECEDENT_SCOPE_ALL });
    precedents().end(ended.id, NOW);
    expect(openAndResolve(question())).toMatchObject({ resolved: false, precedent: null, decision: { status: "open" } });

    const superseded = save({ subject: "test-layout" });
    precedents().supersede([superseded.id], "q:req-20260929T073348Z:Q9", NOW);
    expect(openAndResolve(question({ id: "q:req-20260929T073348Z:Q2", subject: "test-layout" })).resolved).toBe(false);
  });

  it("prefers the workspace's precedent to a newer global one", () => {
    const own = save({ text: "SQLite" }, daysAgo(3));
    save({ scope: PRECEDENT_SCOPE_ALL, text: "Postgres in a container" }, daysAgo(1));
    const result = openAndResolve(question());
    expect(result.decision.answer).toMatchObject({ optionKey: "a", precedentId: own.id });
    // Another project meets only the global one.
    const elsewhere = openAndResolve(question({ workspaceId: OTHER_WS }));
    expect(elsewhere.decision.answer).toMatchObject({ optionKey: "b" });
    expect(elsewhere.decision.answer?.reason).toContain("for all projects");
  });

  it("matches nothing without a subject", () => {
    save();
    expect(openAndResolve(question({ subject: null }))).toMatchObject({ resolved: false, precedent: null, decision: { status: "open" } });
  });

  it("keeps a release, data, security or cost decision open with the precedent as a suggestion, writing nothing", () => {
    const standing = save();
    const cases: Array<[string, Partial<Decision>]> = [
      ["release", { options: [{ key: "a", label: "SQLite", recommended: true, effects: ["push"] }] }],
      ["data", { options: [{ key: "a", label: "SQLite", recommended: true, effects: ["migration"] }] }],
      ["security", { class: "security" }],
      ["cost", { class: "cost" }],
    ];
    cases.forEach(([expected, overrides], index) => {
      const opened = decisions().open(question({ id: `q:req-20260929T073348Z:Q${index + 1}`, ...overrides })).decision;
      const before = decisionsFile();
      const result = resolveByPrecedent(opened, { home, now: NOW, log });
      expect(result, expected).toMatchObject({ resolved: false, precedent: { id: standing.id }, decision: { status: "open", answer: null } });
      expect(decisionsFile(), expected).toBe(before);
    });
  });

  it("leaves the decision open, with one log line, when the precedents cannot be read", () => {
    save();
    const path = join(home, "autonomy", "precedents.json");
    rmSync(path);
    // A symlink where the file was is refused by the store's read.
    writeFileSync(join(root, "elsewhere.json"), "{}");
    symlinkSync(join(root, "elsewhere.json"), path);
    const result = openAndResolve(question());
    expect(result).toMatchObject({ resolved: false, decision: { status: "open" } });
    expect(logs.join("\n")).toContain("could not read the precedents");
  });
});

// ---------------------------------------------------------------------------
// The owner's differing answer supersedes (REQ-124 c).
// ---------------------------------------------------------------------------

describe("an owner's answer on the same subject", () => {
  const rpcDeps = () => ({ env: { PASEO_BM_HOME: home }, homedir: () => root, now: () => NOW, log });

  it("supersedes the precedent when it differs, through decisions.answer, and the next decision is the owner's", async () => {
    const standing = save({ text: "Postgres in a container" }, daysAgo(2));
    // Still open (opened before the precedent, say): the owner answers it now, differently.
    const opened = decisions().open(question()).decision;
    const { decision } = await handleDecisionsAnswer({ id: opened.id, optionKey: "a", via: "inbox" }, null, rpcDeps());
    expect(decision.answer).toMatchObject({ by: "owner", optionKey: "a" });
    expect(precedents().get(standing.id)?.supersededBy).toBe(opened.id);
    expect(precedents().active(NOW, DECISION_WS)).toEqual([]);
    // A later decision on the subject is no longer answered by it.
    expect(openAndResolve(question({ id: "q:req-20260929T073348Z:Q2" })).resolved).toBe(false);
  });

  it("leaves it standing when the answer repeats it, and when the chat answer has no text", async () => {
    const standing = save({ text: "SQLite" }, daysAgo(2));
    const first = decisions().open(question()).decision;
    await handleDecisionsAnswer({ id: first.id, words: "  SQLite " }, null, rpcDeps());
    expect(precedents().get(standing.id)?.supersededBy).toBeNull();
    const confirmed = ok(confirmDecision(ok(markNeedsConfirmation(question({ id: "q:req-20260929T073348Z:Q2" }), { via: "chat-worker", at: NOW.toISOString() })), { answered: true, at: NOW.toISOString() }));
    expect(supersedePrecedentsBy(confirmed, { home, now: NOW, log })).toEqual([]);
    expect(precedents().get(standing.id)?.supersededBy).toBeNull();
  });

  it("never supersedes on an answer that is not the owner's, and never in another project", () => {
    const standing = save();
    const byPrecedent = ok(answerDecision(question(), { by: "precedent", precedentId: "p:x", via: "inbox", words: "DuckDB", at: NOW.toISOString() }));
    expect(supersedePrecedentsBy(byPrecedent, { home, now: NOW, log })).toEqual([]);
    const elsewhere = ok(answerDecision(question({ workspaceId: OTHER_WS }), { via: "inbox", words: "DuckDB", at: NOW.toISOString() }));
    expect(supersedePrecedentsBy(elsewhere, { home, now: NOW, log })).toEqual([]);
    expect(precedents().get(standing.id)?.supersededBy).toBeNull();
  });

  it("refuses to store a superseder that is neither a precedent nor a decision id, writing nothing", () => {
    const standing = save();
    const before = readFileSync(join(home, "autonomy", "precedents.json"), "utf8");
    expect(() => precedents().supersede([standing.id], "anything", NOW)).toThrow(/neither a precedent nor a decision id/);
    expect(precedents().supersede([], "q:req-20260929T073348Z:Q1", NOW)).toEqual([]);
    expect(precedents().supersede(["p:unknown"], "q:req-20260929T073348Z:Q1", NOW)).toEqual([]);
    expect(readFileSync(join(home, "autonomy", "precedents.json"), "utf8")).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// The Orchestrator's decision (bm_ask_owner) and a fallback incident's.
// ---------------------------------------------------------------------------

describe("bm_ask_owner", () => {
  async function tools(onSettled: OrchestratorToolsDeps["onSettled"]) {
    await appendRecord({ tracesDir: join(home, "traces") }, turn({ workspaceId: DECISION_WS }));
    const created = createOrchestratorTools({
      env: { PASEO_BM_HOME: home },
      homedir: () => root,
      now: () => NOW,
      redactEnv: {},
      newId: () => `0b6f-${++ids}`,
      log,
      ...(onSettled === undefined ? {} : { onSettled }),
    });
    created.usePaseo({ agents: { list: async () => ({ entries: [] }), ref: () => ({}) }, workspaces: { list: async () => ({ entries: [] }) } });
    return created;
  }

  const ask = (subject: string, effects: string[] = ["none"]) => ({
    workspaceId: DECISION_WS,
    question: "Keep the tests on SQLite?",
    recommendation: "Yes: it needs nothing installed.",
    subject,
    options: [
      { label: "SQLite", effects, recommended: true },
      { label: "Postgres in a container", effects: ["dependency-install"] },
    ],
  });

  it("answers the Orchestrator's question at once by the owner's precedent, delivers it, and cites it", async () => {
    const standing = save();
    const onSettled = vi.fn();
    const result = await (await tools(onSettled)).call("bm_ask_owner", ask(SUBJECT));
    expect(result.ok, result.text).toBe(true);
    expect(result.text).toContain(`Answered at once by the owner's precedent ${standing.id} on "${SUBJECT}" (option a: SQLite); the owner is not asked.`);
    const facts = JSON.parse(result.text.slice(result.text.indexOf("{"))) as { decisionId: string; answeredBy: string; precedentId: string };
    expect(facts).toMatchObject({ answeredBy: "precedent", precedentId: standing.id });
    const stored = decisions().get(facts.decisionId, DECISION_WS)!;
    expect(stored.answer).toMatchObject({ by: "precedent", optionKey: "a", precedentId: standing.id });
    expect(onSettled).toHaveBeenCalledTimes(1);
    expect(onSettled.mock.calls[0]![0]).toEqual([stored]);
    // The BM-ANSWER the Orchestrator gets cites the precedent.
    expect(answerNoticeOf(stored)).toContain(`precedent: ${standing.id}, the owner's standing answer on "${SUBJECT}"`);
  });

  it("keeps a release question open for the owner, says the precedent is only a suggestion, and delivers nothing", async () => {
    save();
    const onSettled = vi.fn();
    const result = await (await tools(onSettled)).call("bm_ask_owner", ask(SUBJECT, ["push"]));
    expect(result.ok, result.text).toBe(true);
    expect(result.text).toContain(`The owner's precedent on "${SUBJECT}" is shown to them as a suggestion only: a release question stays theirs.`);
    const { decisionId } = JSON.parse(result.text.slice(result.text.indexOf("{"))) as { decisionId: string };
    expect(decisions().get(decisionId, DECISION_WS)).toMatchObject({ status: "open", answer: null });
    expect(onSettled).not.toHaveBeenCalled();
  });
});

describe("a fallback incident's decision", () => {
  const INCIDENT: FallbackIncident = {
    id: "fb-000000000d01",
    role: "worker",
    workspaceId: DECISION_WS,
    requestId: "req-20260929T073348Z",
    agentId: "wrk-1",
    agentProvider: "bm-worker/claude-opus-5",
    agentModel: "claude-opus-5",
    parentId: "mgr-1",
    managerId: "mgr-1",
    class: "L1",
    signal: "failed",
    message: "You've hit your usage limit.",
    perModelWindow: false,
    resetsAt: null,
    candidate: null,
    status: "pending",
    detectedAt: "2026-09-30T09:55:00.000Z",
    decidedAt: null,
    waitUntil: null,
    replacementId: null,
    error: null,
  };

  it("is answered by a precedent naming one of its options only when the pass can deliver it", async () => {
    save({ subject: "fallback-worker", text: "I'll handle it" });
    writeFileSync(join(home, ROLE_FALLBACK_STATE_FILE), JSON.stringify({ version: 1, incidents: [INCIDENT] }));
    // The start-up pass has no delivery: the decision stays open for the owner.
    syncFallbackDecisions(home, { now: () => NOW, log });
    expect(decisions().get("f:fb-000000000d01", DECISION_WS)).toMatchObject({ status: "open" });

    rmSync(join(home, DECISIONS_DIR_NAME), { recursive: true });
    clearDecisionStoreCache();
    const onSettled = vi.fn();
    syncFallbackDecisions(home, { now: () => NOW, log, settle: { onSettled, paseo: "handle" } });
    const stored = decisions().get("f:fb-000000000d01", DECISION_WS)!;
    expect(stored.answer).toMatchObject({ by: "precedent", optionKey: "dismiss" });
    await vi.waitFor(() => expect(onSettled).toHaveBeenCalledWith([stored], { paseo: "handle" }));
  });

  it("stays open when the precedent names none of its options", () => {
    save({ subject: "fallback-worker", text: "Always wait for the reset" });
    writeFileSync(join(home, ROLE_FALLBACK_STATE_FILE), JSON.stringify({ version: 1, incidents: [INCIDENT] }));
    const onSettled = vi.fn();
    syncFallbackDecisions(home, { now: () => NOW, log, settle: { onSettled, paseo: "handle" } });
    expect(decisions().get("f:fb-000000000d01", DECISION_WS)).toMatchObject({ status: "open" });
    expect(onSettled).not.toHaveBeenCalled();
  });
});
