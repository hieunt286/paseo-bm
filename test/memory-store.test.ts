import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  MAX_ACTIVE_MEMORY,
  MAX_MEMORY_SOURCE,
  MAX_MEMORY_TEXT,
  MAX_REMOVED_MEMORY,
  MEMORY_DIR_NAME,
  MEMORY_FULL_REASON,
  MEMORY_FACT_DAYS,
  MEMORY_ID_PATTERN,
  MEMORY_RETIRED_DAYS,
  capMemory,
  createMemoryStore,
  liveMemoryOf,
  newMemoryId,
  prunedMemory,
  resolvedMemory,
  retirementsOf,
  scopeOf,
  type MemoryEntry,
  type MissionLife,
  type NewMemoryEntry,
} from "../plugin/server/memory-store";
import { clearJsonFileCache } from "../plugin/server/data-files";
import { CLEANUP_DELETES } from "../plugin/server/setup-machine";
import { dataFolder, removeDataFolders } from "./helpers/data-folder";
import { fillMemory } from "./helpers/memory";

/** Project memory (missions design §2.5). Temporary data folders only. */

const WS = "wks_a";
const T0 = new Date("2026-10-09T10:00:00.000Z");
const SECRET = "memory-secret-42";

afterEach(() => {
  clearJsonFileCache();
  removeDataFolders();
});

function ids(): () => string {
  let n = 0;
  return () => `mem-${(++n).toString(16).padStart(10, "0")}`;
}

/** Every mission open unless a test says otherwise (§18.1 retires a closed or unknown mission's entries). */
const OPEN: MissionLife = { state: "open", closedAt: null };

function store(home: string, missionOf: (missionId: string) => MissionLife = () => OPEN, now: () => Date = () => T0) {
  return createMemoryStore(home, { now, newId: ids(), env: { PASEO_PASSWORD: SECRET }, missionOf });
}

const main: MemoryEntry["by"] = { role: "main", agentId: "main-1", missionId: "mis-0000000001" };
const plugin: MemoryEntry["by"] = { role: "plugin", agentId: null, missionId: null };

function entry(overrides: Partial<NewMemoryEntry> = {}): NewMemoryEntry {
  return { kind: "fact", text: "The API listens on 8080.", source: "README.md", by: main, ...overrides };
}

function added(result: ReturnType<ReturnType<typeof store>["add"]>): MemoryEntry {
  if (!result.ok) throw new Error(result.reasons.join("\n"));
  return result.entry;
}

describe("project memory (§2.5)", () => {
  it("creates nothing on a read and writes { schemaVersion: 1, entries } 0600 per repo", () => {
    const home = dataFolder();
    const memory = store(home);
    expect(memory.list(WS)).toEqual([]);
    expect(existsSync(join(home, MEMORY_DIR_NAME))).toBe(false);
    const made = added(memory.add(WS, entry()));
    expect(made).toEqual({ id: "mem-0000000001", kind: "fact", text: "The API listens on 8080.", source: "README.md", by: main, at: T0.toISOString(), supersedes: null, state: "active" });
    expect(newMemoryId()).toMatch(MEMORY_ID_PATTERN);
    const path = join(home, MEMORY_DIR_NAME, `${WS}.json`);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(join(home, MEMORY_DIR_NAME)).mode & 0o777).toBe(0o700);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ schemaVersion: 1, entries: [made] });
    expect(memory.list("wks_b")).toEqual([]);
  });

  it("masks and bounds text and source", () => {
    const home = dataFolder();
    const made = added(store(home).add(WS, entry({ text: `${SECRET} ${"t".repeat(2000)}`, source: `${SECRET} ${"s".repeat(500)}` })));
    expect(made.text).not.toContain(SECRET);
    expect(made.text).toHaveLength(MAX_MEMORY_TEXT);
    expect(made.source).toHaveLength(MAX_MEMORY_SOURCE);
  });

  it("removes an entry and supersedes one in the same write", () => {
    const home = dataFolder();
    const memory = store(home);
    const first = added(memory.add(WS, entry()));
    const second = added(memory.add(WS, entry({ text: "The API listens on 9090.", supersedes: first.id })));
    expect(memory.active(WS).map((found) => found.id)).toEqual([second.id]);
    expect(memory.list(WS)[0]?.state).toBe("removed");
    expect(memory.add(WS, entry({ supersedes: first.id })).ok).toBe(false);
    expect(memory.remove(WS, second.id).ok).toBe(true);
    expect(memory.remove(WS, second.id)).toEqual({ ok: false, reasons: [`memory entry ${second.id} is not an active entry of this project`] });
    expect(memory.active(WS)).toEqual([]);
  });

  it("refuses an agent's add past the bound, and lets an automatic decision replace the oldest automatic one", () => {
    const home = dataFolder();
    const memory = store(home);
    const firstAuto = added(memory.add(WS, entry({ kind: "decision", by: plugin, text: "auto 0" })));
    added(memory.add(WS, entry({ kind: "decision", by: plugin, text: "auto 1" })));
    fillMemory(home, WS, MAX_ACTIVE_MEMORY - 2, (n) => ({ ...entry({ text: `fact ${n + 2}` }), at: T0.toISOString() }));
    expect(memory.active(WS)).toHaveLength(MAX_ACTIVE_MEMORY);
    expect(memory.add(WS, entry({ text: "one more" }))).toEqual({ ok: false, reasons: [MEMORY_FULL_REASON] });
    expect(MEMORY_FULL_REASON).toContain("curate the memory first (bm_memory remove)");

    added(memory.add(WS, entry({ kind: "decision", by: plugin, text: "auto new" })));
    const active = memory.active(WS);
    expect(active).toHaveLength(MAX_ACTIVE_MEMORY);
    expect(active.some((found) => found.id === firstAuto.id)).toBe(false);
    expect(active.at(-1)?.text).toBe("auto new");
  });

  it("keeps the newest removed entries only", () => {
    const at = (n: number) => new Date(T0.getTime() + n * 1000).toISOString();
    const removed = Array.from({ length: MAX_REMOVED_MEMORY + 5 }, (_, n): MemoryEntry => ({
      id: `mem-${n.toString(16).padStart(10, "0")}`,
      kind: "fact",
      text: `t${n}`,
      source: "s",
      by: main,
      at: at(n),
      supersedes: null,
      state: "removed",
    }));
    const kept = capMemory([...removed, { ...removed[0]!, id: "mem-ffffffffff", state: "active" }]);
    expect(kept).toHaveLength(MAX_REMOVED_MEMORY + 1);
    expect(kept[0]?.text).toBe("t5");
  });

  it("refuses a workspace id that is not a file name", () => {
    const home = dataFolder();
    expect(() => store(home).add("..", entry())).toThrow();
    expect(store(home).list("..")).toEqual([]);
  });

  it("is deleted by the cleanup", () => {
    expect(CLEANUP_DELETES).toContain(MEMORY_DIR_NAME);
  });
});

/** Delivery line design §18.1 (ADR-037): scope and a computed life. */
describe("project memory: scope and life (§18.1)", () => {
  const DAY = 86_400_000;
  const at = (days: number) => new Date(T0.getTime() + days * DAY).toISOString();
  let serial = 0;
  const stored = (overrides: Partial<MemoryEntry> = {}): MemoryEntry => ({
    id: `mem-${(++serial).toString(16).padStart(10, "0")}`,
    kind: "fact",
    text: `entry ${serial}`,
    source: "test",
    by: main,
    at: T0.toISOString(),
    supersedes: null,
    state: "active",
    ...overrides,
  });
  const closedAt = (when: string) => (): MissionLife => ({ state: "closed", closedAt: when });

  it("reads an entry's scope: its own, else mission for a mission's fact or decision, else repo", () => {
    expect(scopeOf(stored())).toBe("mission");
    expect(scopeOf(stored({ kind: "decision" }))).toBe("mission");
    expect(scopeOf(stored({ kind: "convention" }))).toBe("repo");
    expect(scopeOf(stored({ kind: "contract" }))).toBe("repo");
    expect(scopeOf(stored({ by: plugin, kind: "decision" }))).toBe("repo");
    expect(scopeOf(stored({ scope: "repo" }))).toBe("repo");
    expect(scopeOf(stored({ kind: "convention", scope: "mission" }))).toBe("mission");
  });

  it("retires a closed or unknown mission's mission entries, never its repo entries", () => {
    const fact = stored();
    const convention = stored({ kind: "convention" });
    const lasting = stored({ scope: "repo" });
    const closed = retirementsOf([fact, convention, lasting], closedAt(at(1)), T0);
    expect([...closed.entries()]).toEqual([[fact.id, { reason: "mission-closed", since: at(1) }]]);
    const unknown = retirementsOf([fact, convention], () => null, T0);
    expect(unknown.get(fact.id)).toEqual({ reason: "mission-closed", since: fact.at });
    expect(liveMemoryOf([fact, convention, lasting], closedAt(at(1)), T0).map((entry) => entry.id)).toEqual([convention.id, lasting.id]);
  });

  it("retires an entry whose subject a newer live entry names, case aside; a retired newer entry does not", () => {
    const old = stored({ kind: "contract", subject: "Login API", at: at(0) });
    const replacement = stored({ kind: "contract", subject: " login api ", at: at(1) });
    const retired = retirementsOf([old, replacement], () => OPEN, new Date(at(2)));
    expect(retired.get(old.id)).toEqual({ reason: "superseded", since: replacement.at });
    expect(retired.has(replacement.id)).toBe(false);
    // The newer entry is a closed mission's: it retires nothing, the older repo entry stays live.
    const lasting = stored({ kind: "contract", subject: "Billing", at: at(0) });
    const missionOnly = stored({ kind: "fact", subject: "billing", at: at(1) });
    const life = (id: string): MissionLife => (id === main.missionId ? { state: "closed", closedAt: at(1) } : OPEN);
    expect(liveMemoryOf([lasting, missionOnly], life, new Date(at(2))).map((entry) => entry.id)).toEqual([lasting.id]);
  });

  it("retires a mission's fact after MEMORY_FACT_DAYS, not its decision nor a repo fact", () => {
    const fact = stored({ at: at(0) });
    const decision = stored({ kind: "decision", at: at(0) });
    const repoFact = stored({ scope: "repo", at: at(0) });
    const before = retirementsOf([fact, decision, repoFact], () => OPEN, new Date(at(MEMORY_FACT_DAYS - 1)));
    expect(before.size).toBe(0);
    const after = retirementsOf([fact, decision, repoFact], () => OPEN, new Date(at(MEMORY_FACT_DAYS)));
    expect([...after.entries()]).toEqual([[fact.id, { reason: "stale", since: at(MEMORY_FACT_DAYS) }]]);
  });

  it("names the first reason that holds: closed, then superseded, then stale", () => {
    const old = stored({ subject: "x", at: at(0) });
    const newer = stored({ scope: "repo", subject: "x", at: at(1) });
    const both = retirementsOf([old, newer], () => OPEN, new Date(at(MEMORY_FACT_DAYS + 5)));
    expect(both.get(old.id)?.reason).toBe("superseded");
    expect(retirementsOf([old, newer], closedAt(at(2)), new Date(at(3))).get(old.id)?.reason).toBe("mission-closed");
  });

  it("removes an entry retired for MEMORY_RETIRED_DAYS at a write, and keeps a younger retirement reversible", () => {
    const home = dataFolder();
    const oldFact = stored({ text: "closed long ago" });
    const recent = stored({ text: "closed lately", by: { ...main, missionId: "mis-0000000002" } });
    fillMemory(home, WS, 0);
    const life = (id: string): MissionLife => ({ state: "closed", closedAt: id === main.missionId ? at(0) : at(MEMORY_RETIRED_DAYS) });
    expect(prunedMemory([oldFact, recent], life, new Date(at(MEMORY_RETIRED_DAYS))).map((entry) => entry.state)).toEqual(["removed", "active"]);
    fillMemory(home, WS, 2, (n) => (n === 0 ? oldFact : recent));
    const memory = store(home, life, () => new Date(at(MEMORY_RETIRED_DAYS)));
    expect(memory.live(WS)).toHaveLength(0);
    expect(memory.retired(WS).map(({ entry }) => entry.text)).toEqual(["closed long ago", "closed lately"]);
    added(memory.add(WS, entry({ kind: "convention", text: "Use yarn." })));
    const after = memory.list(WS);
    expect(after.find((found) => found.text === "closed long ago")?.state).toBe("removed");
    expect(after.find((found) => found.text === "closed lately")?.state).toBe("active");
    // Reversible: re-added as a repo entry superseding it, it is live again.
    const back = memory.retired(WS).find(({ entry: found }) => found.text === "closed lately")!.entry;
    added(memory.add(WS, entry({ text: back.text, scope: "repo", supersedes: back.id })));
    expect(memory.live(WS).map((found) => found.text)).toEqual(["Use yarn.", "closed lately"]);
  });

  it("stores scope and a trimmed, masked subject, and counts only live entries against the bound", () => {
    const home = dataFolder();
    const memory = store(home);
    const kept = added(memory.add(WS, entry({ kind: "contract", scope: "repo", subject: `  Auth ${SECRET} `, text: "Tokens expire in 1 h." })));
    expect(kept.scope).toBe("repo");
    expect(kept.subject).toBe("Auth [redacted]");
    expect(added(memory.add(WS, entry())).scope).toBeUndefined();
    fillMemory(home, WS, MAX_ACTIVE_MEMORY, () => ({ at: T0.toISOString(), by: { ...main, missionId: "mis-closed00000" } }));
    const closedOne = store(home, (id) => (id === "mis-closed00000" ? { state: "closed", closedAt: T0.toISOString() } : OPEN));
    expect(closedOne.active(WS).length).toBeGreaterThan(MAX_ACTIVE_MEMORY);
    expect(closedOne.add(WS, entry({ text: "still fits" })).ok).toBe(true);
  });

  it("ties an owner's answer stored with no mission to its request's mission, and retires it with that mission", () => {
    const answer = stored({ kind: "decision", by: plugin, source: "the owner's answer to q:req-20261020T010203Z:Q1", text: "Q1 — the owner: a" });
    const elsewhere = stored({ kind: "decision", by: plugin, source: "the owner's answer to q:req-20261020T999999Z:Q2" });
    const settings = stored({ kind: "decision", by: plugin, source: "the owner's Settings" });
    const resolved = resolvedMemory([answer, elsewhere, settings], (requestId) => (requestId === "req-20261020T010203Z" ? "mis-pen0000001" : null));
    expect(resolved.map((entry) => entry.by.missionId)).toEqual(["mis-pen0000001", null, null]);
    expect(scopeOf(resolved[0]!)).toBe("mission");
    const live = liveMemoryOf(resolved, (id) => (id === "mis-pen0000001" ? { state: "closed", closedAt: at(1) } : OPEN), new Date(at(2)));
    expect(live.map((entry) => entry.id)).toEqual([elsewhere.id, settings.id]);
  });

  it("never lets a mission's entry retire a repo entry on the same subject, so the rule neither vanishes nor returns (review of ADR-037)", () => {
    const rule = stored({ kind: "convention", subject: "date-format", text: "Dates are ISO-8601.", at: at(0) });
    const missionDecision = stored({ kind: "decision", subject: "date-format", text: "This mission shows dd/mm.", at: at(1) });
    const open = retirementsOf([rule, missionDecision], () => OPEN, new Date(at(40)));
    expect(open.has(rule.id)).toBe(false);
    // Nothing is pruned for it, and when the mission closes the rule is still live.
    expect(prunedMemory([rule, missionDecision], () => OPEN, new Date(at(40)))[0]!.state).toBe("active");
    expect(liveMemoryOf([rule, missionDecision], closedAt(at(2)), new Date(at(3))).map((entry) => entry.id)).toEqual([rule.id]);
    // A repo entry replaces it, and a mission entry replaces its own mission's.
    const newRule = stored({ kind: "convention", subject: "Date-Format", text: "Dates are ISO-8601 with a zone.", at: at(2) });
    expect(retirementsOf([rule, newRule], () => OPEN, new Date(at(3))).get(rule.id)).toEqual({ reason: "superseded", since: newRule.at });
    const later = stored({ kind: "decision", subject: "date-format", text: "This mission now shows ISO.", at: at(3) });
    expect(retirementsOf([missionDecision, later], () => OPEN, new Date(at(4))).get(missionDecision.id)?.reason).toBe("superseded");
    const otherMission = stored({ kind: "decision", subject: "date-format", by: { ...main, missionId: "mis-0000000009" }, at: at(4) });
    expect(retirementsOf([missionDecision, otherMission], () => OPEN, new Date(at(5))).has(missionDecision.id)).toBe(false);
  });

  it("reads a mission whose file exists but cannot be read as open, and a missing one as unknown", () => {
    const home = dataFolder();
    mkdirSync(join(home, "missions"), { recursive: true });
    writeFileSync(join(home, "missions", "mis-0000000001.json"), JSON.stringify({ schemaVersion: 99 }));
    fillMemory(home, WS, 1, () => ({ kind: "decision", text: "kept", by: main, at: T0.toISOString() }));
    fillMemory(home, WS, 1, () => ({ kind: "decision", text: "gone", by: { ...main, missionId: "mis-0000000077" }, at: T0.toISOString() }));
    const memory = createMemoryStore(home, { now: () => new Date(at(60)) });
    expect(memory.live(WS).map((entry) => entry.text)).toEqual(["kept"]);
    expect(memory.retired(WS).map(({ entry, retirement }) => [entry.text, retirement.reason])).toEqual([["gone", "mission-closed"]]);
  });
});

