import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AUTONOMY_DIR_NAME, AUTONOMY_POLICY_FILE, createAutonomyStore } from "../plugin/server/autonomy-store";
import { PRECEDENTS_FILE, PRECEDENT_INACTIVE_LIMIT, createPrecedentStore } from "../plugin/server/precedent-store";
import { CLEANUP_DELETES } from "../plugin/server/setup-machine";
import { DashboardError } from "../plugin/shared/contracts";
import { answerDecision, confirmDecision, markNeedsConfirmation, type Decision } from "../plugin/shared/decisions";
import {
  DEFAULT_PRECEDENT_DAYS,
  MAX_PRECEDENT_TEXT_CHARS,
  PRECEDENTS_FILE_VERSION,
  PRECEDENT_SCOPE_ALL,
  activeFor,
  activePrecedents,
  checkPrecedentSaveInput,
  isActive,
  precedentDraftOf,
  precedentTextOf,
  whyNotPrecedent,
  type Precedent,
  type PrecedentDraft,
} from "../plugin/shared/precedents";
import { DECISION_WS, makeDecision, storedOrchestratorAnswer } from "./helpers/decisions";

/**
 * The owner's precedents (autonomy design §B.6, §B.9; PRD REQ-124 a, c):
 * `<data>/autonomy/precedents.json` with the policy store's file rules, and
 * the pure rules of `shared/precedents.ts`. A temporary data folder only;
 * never the real HOME.
 */

const NOW = new Date("2026-09-30T10:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
const later = (days: number) => new Date(NOW.getTime() + days * DAY);

let root: string;
let home: string;
let ids: number;

const store = () => createPrecedentStore(home, { newId: () => `id-${++ids}` });
const file = () => join(home, AUTONOMY_DIR_NAME, PRECEDENTS_FILE);
const fileBytes = () => (existsSync(file()) ? readFileSync(file(), "utf8") : null);
const permissions = (path: string) => statSync(path).mode & 0o777;
const draft = (overrides: Partial<PrecedentDraft> = {}): PrecedentDraft => ({
  scope: "wks_1",
  subject: "test-layout",
  text: "One test file per module.",
  sourceDecisionId: null,
  expiresInDays: DEFAULT_PRECEDENT_DAYS,
  ...overrides,
});

function writeFile(body: unknown): string {
  mkdirSync(join(home, AUTONOMY_DIR_NAME), { recursive: true });
  const text = typeof body === "string" ? body : JSON.stringify(body);
  writeFileSync(file(), text);
  return text;
}

function codeOf(run: () => unknown): string | null {
  try {
    run();
    return null;
  } catch (error) {
    return error instanceof DashboardError ? error.code : `not a DashboardError: ${String(error)}`;
  }
}

function ok(result: ReturnType<typeof answerDecision>): Decision {
  if (!result.ok) throw new Error(result.message);
  return result.decision;
}

const answered = (overrides: Partial<Decision> = {}, answer: { optionKey?: string; words?: string } = { optionKey: "c" }) =>
  ok(answerDecision(makeDecision(overrides), { via: "inbox", optionKey: answer.optionKey ?? null, words: answer.words ?? null, at: NOW.toISOString() }));

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "bm-precedents-"));
  home = join(root, "data");
  ids = 0;
});

afterEach(() => {
  chmodSync(root, 0o700);
  if (existsSync(join(home, AUTONOMY_DIR_NAME))) chmodSync(join(home, AUTONOMY_DIR_NAME), 0o700);
  rmSync(root, { recursive: true, force: true });
});

describe("the rules (shared/precedents.ts)", () => {
  const precedent = (overrides: Partial<Precedent>): Precedent => ({
    id: "p:1",
    scope: "wks_1",
    subject: "test-layout",
    text: "One test file per module.",
    sourceDecisionId: null,
    createdAt: NOW.toISOString(),
    expiresAt: later(30).toISOString(),
    supersededBy: null,
    ...overrides,
  });

  it("is active until it expires and while nothing superseded it", () => {
    const p = precedent({});
    expect(isActive(p, NOW)).toBe(true);
    expect(isActive(p, later(29.99))).toBe(true);
    expect(isActive(p, later(30))).toBe(false);
    expect(isActive({ ...p, supersededBy: "p:2" }, NOW)).toBe(false);
  });

  it("gives a workspace its own and the global precedents, newest first, and every active one without a workspace", () => {
    const list = [
      precedent({ id: "p:old", createdAt: "2026-09-01T00:00:00.000Z" }),
      precedent({ id: "p:global", scope: PRECEDENT_SCOPE_ALL, createdAt: "2026-09-20T00:00:00.000Z" }),
      precedent({ id: "p:other", scope: "wks_2", createdAt: "2026-09-25T00:00:00.000Z" }),
      precedent({ id: "p:new", subject: "push-backends", createdAt: "2026-09-29T00:00:00.000Z" }),
      precedent({ id: "p:ended", expiresAt: NOW.toISOString() }),
      precedent({ id: "p:replaced", supersededBy: "p:new" }),
    ];
    expect(activeFor(list, "wks_1", NOW).map((p) => p.id)).toEqual(["p:new", "p:global", "p:old"]);
    expect(activeFor(list, "wks_3", NOW).map((p) => p.id)).toEqual(["p:global"]);
    expect(activePrecedents(list, NOW).map((p) => p.id)).toEqual(["p:new", "p:other", "p:global", "p:old"]);
  });

  it("takes a decision's text from its answer: the option's label, else the owner's words, else none", () => {
    expect(precedentTextOf(answered({}, { optionKey: "a" }))).toBe("Push contract only");
    expect(precedentTextOf(answered({}, { words: "Push nothing before Friday." }))).toBe("Push nothing before Friday.");
    const inChat = ok(confirmDecision(ok(markNeedsConfirmation(makeDecision(), { via: "chat-worker", at: NOW.toISOString() })), { answered: true, at: NOW.toISOString() }));
    expect(precedentTextOf(inChat)).toBeNull();
    expect(precedentTextOf(makeDecision())).toBeNull();
  });

  it("makes a precedent only of the owner's answered decision with a subject", () => {
    expect(whyNotPrecedent(answered())).toBeNull();
    expect(whyNotPrecedent(makeDecision())).toMatch(/is open; only an answered decision/);
    expect(whyNotPrecedent(answered({ subject: null }))).toMatch(/has no subject/);
    const byOrchestrator = ok(storedOrchestratorAnswer(makeDecision(), { optionKey: "c", reason: "No effect.", at: NOW.toISOString() }));
    expect(whyNotPrecedent(byOrchestrator)).toMatch(/not answered by you/);
  });

  it("checks a save's input before anything is read, and drafts it from the decision", () => {
    const refusal = (input: unknown) => {
      const checked = checkPrecedentSaveInput(input);
      return "refusal" in checked ? checked.refusal : null;
    };
    for (const input of [
      null,
      { scope: "", subject: "x", text: "y" },
      { scope: "wks_1", subject: "Test Layout", text: "y" },
      { scope: "wks_1", subject: "x", text: "   " },
      { scope: "wks_1", subject: "x", text: "y".repeat(MAX_PRECEDENT_TEXT_CHARS + 1) },
      { scope: "wks_1", subject: "x", text: "y", expiresInDays: 0 },
      { scope: "wks_1", subject: "x", text: "y", expiresInDays: 1.5 },
      { scope: "wks_1", text: "y" },
      { scope: "wks_1", subject: "x" },
    ]) {
      expect(refusal(input)?.code, JSON.stringify(input)).toBe("E_PRECEDENT_INVALID");
    }
    expect(refusal({ scope: "wks_1", subject: "Test Layout", text: "y" })?.detail).toMatch(/subject "Test Layout" is not a subject of lowercase letters/);
    expect(refusal({ scope: "all", subject: "x", text: "y" })).toBeNull();
    expect(refusal({ decisionId: "q:r:Q1", scope: "all" })).toBeNull();

    const decision = answered({}, { optionKey: "a" });
    const from = (input: Record<string, unknown>, source: Decision | null = decision) => {
      const checked = checkPrecedentSaveInput(input);
      if ("refusal" in checked) throw new Error(checked.refusal.detail);
      return precedentDraftOf(checked.input, source);
    };
    expect(from({ decisionId: decision.id, scope: DECISION_WS })).toEqual({
      draft: { scope: DECISION_WS, subject: "push-backends", text: "Push contract only", sourceDecisionId: decision.id, expiresInDays: 30 },
    });
    expect(from({ decisionId: decision.id, scope: "all", text: "  Push the contract only, never both.  ", expiresInDays: 7 })).toMatchObject({
      draft: { scope: "all", text: "Push the contract only, never both.", expiresInDays: 7 },
    });
    // Another project's scope, another subject, an open decision, a chat answer without text: refused.
    expect(from({ decisionId: decision.id, scope: "wks_2" })).toMatchObject({ refusal: { code: "E_PRECEDENT_INVALID" } });
    expect(from({ decisionId: decision.id, scope: "all", subject: "other" })).toMatchObject({ refusal: { code: "E_PRECEDENT_INVALID" } });
    expect(from({ decisionId: decision.id, scope: "all" }, makeDecision())).toMatchObject({ refusal: { code: "E_PRECEDENT_INVALID" } });
    const inChat = ok(confirmDecision(ok(markNeedsConfirmation(makeDecision(), { via: "chat-worker", at: NOW.toISOString() })), { answered: true, at: NOW.toISOString() }));
    const noText = from({ decisionId: inChat.id, scope: "all" }, inChat);
    expect("refusal" in noText && noText.refusal.detail).toMatch(/confirmed in a chat and has no text; write the precedent's text/);
    expect(from({ decisionId: inChat.id, scope: "all", text: "Hold" }, inChat)).toMatchObject({ draft: { text: "Hold", sourceDecisionId: inChat.id } });
  });
});

describe("the store", () => {
  it("reads none and creates nothing, then a 0700 folder and a 0600 file on the first save; cleanup deletes the folder", () => {
    expect(store().read()).toEqual([]);
    expect(store().active(NOW)).toEqual([]);
    expect(existsSync(home)).toBe(false);
    const { precedent, superseded } = store().save(draft(), NOW);
    expect(superseded).toEqual([]);
    expect(precedent).toEqual({
      id: "p:id-1",
      scope: "wks_1",
      subject: "test-layout",
      text: "One test file per module.",
      sourceDecisionId: null,
      createdAt: NOW.toISOString(),
      expiresAt: later(30).toISOString(),
      supersededBy: null,
    });
    expect(permissions(join(home, AUTONOMY_DIR_NAME))).toBe(0o700);
    expect(permissions(file())).toBe(0o600);
    expect(JSON.parse(readFileSync(file(), "utf8"))).toEqual({ version: PRECEDENTS_FILE_VERSION, entries: [precedent] });
    expect(store().get("p:id-1")).toEqual(precedent);
    expect(CLEANUP_DELETES).toContain(AUTONOMY_DIR_NAME);
  });

  it("lives beside the policy without touching it", () => {
    createAutonomyStore(home).set({ workspaceId: "wks_1", class: "scope", mode: "shadow" }, NOW.toISOString());
    const policy = readFileSync(join(home, AUTONOMY_DIR_NAME, AUTONOMY_POLICY_FILE), "utf8");
    store().save(draft(), NOW);
    expect(readdirSync(join(home, AUTONOMY_DIR_NAME)).sort()).toEqual([AUTONOMY_POLICY_FILE, PRECEDENTS_FILE].sort());
    expect(readFileSync(join(home, AUTONOMY_DIR_NAME, AUTONOMY_POLICY_FILE), "utf8")).toBe(policy);
  });

  it("expires 30 days after it was saved by default, or after the days asked", () => {
    const standard = store().save(draft(), NOW).precedent;
    expect(Date.parse(standard.expiresAt) - NOW.getTime()).toBe(30 * DAY);
    const week = store().save(draft({ subject: "release-notes", expiresInDays: 7 }), NOW).precedent;
    expect(week.expiresAt).toBe(later(7).toISOString());
    expect(store().active(later(29)).map((p) => p.id)).toEqual([standard.id]);
    expect(store().active(later(30))).toEqual([]);
    expect(store().read()).toHaveLength(2);
  });

  it("lists the active precedents: a workspace's own and the global ones, newest first", () => {
    const own = store().save(draft(), NOW).precedent;
    const global = store().save(draft({ scope: PRECEDENT_SCOPE_ALL, subject: "commit-style" }), later(1)).precedent;
    const other = store().save(draft({ scope: "wks_2" }), later(2)).precedent;
    expect(store().active(later(3), "wks_1").map((p) => p.id)).toEqual([global.id, own.id]);
    expect(store().active(later(3), "wks_2").map((p) => p.id)).toEqual([other.id, global.id]);
    expect(store().active(later(3)).map((p) => p.id)).toEqual([other.id, global.id, own.id]);
  });

  it("supersedes the active precedent of the same scope and subject, and only that one (REQ-124 c)", () => {
    const first = store().save(draft(), NOW).precedent;
    const global = store().save(draft({ scope: PRECEDENT_SCOPE_ALL }), NOW).precedent;
    const otherSubject = store().save(draft({ subject: "commit-style" }), NOW).precedent;
    const second = store().save(draft({ text: "Tests beside the code." }), later(1));
    expect(second.superseded).toEqual([first.id]);
    expect(store().get(first.id)?.supersededBy).toBe(second.precedent.id);
    expect(store().get(global.id)?.supersededBy).toBeNull();
    expect(store().get(otherSubject.id)?.supersededBy).toBeNull();
    // Newest first; saved at the same time, the later one in the file first.
    expect(store().active(later(1), "wks_1").map((p) => p.id)).toEqual([second.precedent.id, otherSubject.id, global.id]);
    // An expired precedent of the same subject is not superseded: it already stopped holding.
    const expired = store().save(draft({ subject: "old-rule", expiresInDays: 1 }), NOW).precedent;
    expect(store().save(draft({ subject: "old-rule" }), later(2)).superseded).toEqual([]);
    expect(store().get(expired.id)?.supersededBy).toBeNull();
  });

  it("ends a precedent: it expires now and is no longer listed; ending it again writes nothing; an unknown id is null", () => {
    const precedent = store().save(draft(), NOW).precedent;
    const ended = store().end(precedent.id, later(2));
    expect(ended).toEqual({ ...precedent, expiresAt: later(2).toISOString() });
    expect(store().active(later(2))).toEqual([]);
    const bytes = fileBytes();
    expect(store().end(precedent.id, later(3))).toEqual(ended);
    expect(fileBytes()).toBe(bytes);
    expect(store().end("p:none", NOW)).toBeNull();
    expect(fileBytes()).toBe(bytes);
  });

  it("refuses a draft that is not a precedent, writing nothing", () => {
    store().save(draft(), NOW);
    const bytes = fileBytes();
    for (const bad of [draft({ subject: "Not A Slug" }), draft({ text: "" }), draft({ scope: "" }), draft({ expiresInDays: 0 })]) {
      expect(codeOf(() => store().save(bad, NOW))).toBe("E_PRECEDENT_INVALID");
    }
    expect(fileBytes()).toBe(bytes);
  });

  it("skips a malformed entry alone and drops it with the next write", () => {
    const good = {
      id: "p:good",
      scope: "wks_1",
      subject: "test-layout",
      text: "One test file per module.",
      sourceDecisionId: "q:req-20260929T073348Z:Q1",
      createdAt: NOW.toISOString(),
      expiresAt: later(30).toISOString(),
      supersededBy: null,
    };
    writeFile({
      version: 1,
      entries: [
        good,
        { ...good, id: "p:bad-subject", subject: "Test Layout" },
        { ...good, id: "p:bad-time", expiresAt: "soon" },
        { ...good, id: "not-a-precedent-id" },
        { ...good, id: "p:no-text", text: "" },
        { ...good, text: "A second entry under the same id." },
        "a string",
        null,
      ],
      extra: { ignored: true },
    });
    expect(store().read()).toEqual([good]);
    store().save(draft({ subject: "commit-style" }), NOW);
    expect(JSON.parse(readFileSync(file(), "utf8")).entries.map((entry: Precedent) => entry.id)).toEqual(["p:good", "p:id-1"]);
  });

  it("reads a corrupt file, one without a version and one of an older version as none", () => {
    for (const body of ["{not json", "[]", "null", JSON.stringify({ entries: [] }), JSON.stringify({ version: 0, entries: [] }), JSON.stringify({ version: 1 })]) {
      writeFile(body);
      expect(store().read()).toEqual([]);
    }
  });

  it("reads a file from a newer paseo-bm as none and never writes it, not even to end", () => {
    const newer = writeFile({ version: 2, entries: [{ id: "p:x" }] });
    expect(store().read()).toEqual([]);
    expect(store().active(NOW)).toEqual([]);
    expect(codeOf(() => store().save(draft(), NOW))).toBe("E_PRECEDENT_WRITE_FAILED");
    expect(() => store().save(draft(), NOW)).toThrow(/newer paseo-bm/);
    expect(codeOf(() => store().end("p:x", NOW))).toBe("E_PRECEDENT_WRITE_FAILED");
    expect(fileBytes()).toBe(newer);
  });

  it(`keeps every active precedent and the ${PRECEDENT_INACTIVE_LIMIT} newest inactive ones`, () => {
    const entries = Array.from({ length: PRECEDENT_INACTIVE_LIMIT + 5 }, (_, index) => ({
      id: `p:old-${index}`,
      scope: "wks_1",
      subject: `rule-${index}`,
      text: "Old rule.",
      sourceDecisionId: null,
      createdAt: new Date(NOW.getTime() - (PRECEDENT_INACTIVE_LIMIT + 5 - index) * 60_000).toISOString(),
      expiresAt: NOW.toISOString(),
      supersededBy: null,
    }));
    writeFile({ version: 1, entries });
    const kept = store().save(draft(), NOW).precedent;
    const written = (JSON.parse(readFileSync(file(), "utf8")) as { entries: Precedent[] }).entries;
    expect(written).toHaveLength(PRECEDENT_INACTIVE_LIMIT + 1);
    expect(written.map((entry) => entry.id)).not.toContain("p:old-0");
    expect(written.map((entry) => entry.id)).toContain("p:old-5");
    expect(written.at(-1)).toEqual(kept);
  });

  it("writes atomically: none left behind, and a failed write leaves the file as it was", () => {
    store().save(draft(), NOW);
    const before = fileBytes();
    chmodSync(join(home, AUTONOMY_DIR_NAME), 0o500);
    expect(() => store().save(draft({ subject: "commit-style" }), NOW)).toThrow();
    chmodSync(join(home, AUTONOMY_DIR_NAME), 0o700);
    expect(fileBytes()).toBe(before);
    expect(readdirSync(join(home, AUTONOMY_DIR_NAME))).toEqual([PRECEDENTS_FILE]);
  });

  it("refuses a symlinked autonomy folder and writes nothing through it", () => {
    const elsewhere = join(root, "elsewhere");
    mkdirSync(elsewhere);
    mkdirSync(home);
    symlinkSync(elsewhere, join(home, AUTONOMY_DIR_NAME));
    expect(() => store().read()).toThrow();
    expect(() => store().save(draft(), NOW)).toThrow();
    expect(() => store().end("p:x", NOW)).toThrow();
    expect(readdirSync(elsewhere)).toEqual([]);
  });
});
