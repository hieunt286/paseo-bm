import { describe, expect, it, vi } from "vitest";
import type { MemoryListOutput, MissionGetOutput, MissionSignal, MissionSummary } from "../plugin/shared/contracts";
import { MISSION_LEVELS, MISSION_LEVEL_CLASSES, levelNeedsConfirmation } from "../plugin/shared/autonomy";
import { GOVERNOR_FIGURES } from "../plugin/server/governor-figures";
import {
  EMPTY_MISSION_DRAFT,
  FIGURE_WORDS,
  MAIN_STATE_CHIPS,
  MISSION_CLASS_SHORT,
  MISSION_CLASS_WORDS,
  MISSION_LEVEL_SENTENCES,
  addableReposOf,
  classWordsOf,
  closeMissionDialog,
  codeAsTyped,
  createInputOf,
  figureSentenceOf,
  governorLinesOf,
  levelConfirmDialog,
  levelLineOf,
  levelSentenceOf,
  memorySourceOf,
  memoryViewOf,
  missionCardOf,
  missionDraftErrors,
  missionListOf,
  missionPageOf,
  mrNumberOf,
  renameInputOf,
  repositoriesOf,
  revokeIntegrationDialog,
  toggleRepo,
  type MissionDraft,
} from "../plugin/client/missions-model";
import { allNodes, pressables, renderTree, textOf, texts, type RNode } from "./helpers/element-tree";

/**
 * The Missions screen (missions design §10; the approved mockup, artboards
 * A–F): every element of §10.2 and every word of §10.3 from fixture outputs
 * typed by the RPC contracts, the New mission form's validation, and the
 * hook-free pieces (`MissionCard`, `MissionList`, `MissionPageBody`,
 * `NewMissionForm`, `MemoryTable`) expanded with the element-tree helper.
 * The fixtures are the artboards' own data.
 */

// The root tsconfig has no `jsx`, so the .tsx modules load through non-literal specifiers.
const missionsPath = "../plugin/client/missions.tsx";
const workPath = "../plugin/client/work.tsx";
type Component = (props: Record<string, unknown>) => unknown;
const { MissionCard, MissionList, MissionPageBody, NewMissionForm, MemoryTable, PAGE_UI_IDLE } = (await import(missionsPath)) as {
  MissionCard: Component;
  MissionList: Component;
  MissionPageBody: Component;
  NewMissionForm: Component;
  MemoryTable: Component;
  PAGE_UI_IDLE: Record<string, unknown>;
};
const { ProjectHeader } = (await import(workPath)) as { ProjectHeader: Component };

const styles = new Proxy({}, { get: (_target, key) => ({ name: String(key) }) });
const theme = { colors: new Proxy({}, { get: (_target, key) => `#${String(key)}` }) };
const noop = () => undefined;
const flat = (style: unknown) => [style].flat(Infinity).reduce<Record<string, unknown>>((all, part) => ({ ...all, ...(part as object) }), {});

// Local times, so the "HH:MM" of the journal and the contracts read the same in every time zone.
const NOW = new Date(2026, 9, 10, 9, 45);
const at = (hours: number, minutes: number) => new Date(2026, 9, 10, hours, minutes).toISOString();
const minutesFromNow = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000).toISOString();

const UI = { workspaceId: "ws-ui", name: "xspace-ai-assistant" };
const BE = { workspaceId: "ws-be", name: "ai-assistant" };

const MESS: MissionSignal = {
  family: "mess",
  step: 2,
  crossed: [{ id: "writersOnOneFile", value: 4, threshold: 2, op: ">=", crossed: true, detail: "ws-ui: docs/01-prd.md" }],
  lastAction: { kind: "nudge", at: minutesFromNow(-12) },
  replanDueAt: minutesFromNow(18),
};
const quiet = (family: MissionSignal["family"]): MissionSignal => ({ family, step: 0, crossed: [], lastAction: null, replanDueAt: null });

const AIX: MissionSummary = {
  missionId: "mis-0123456789",
  code: "AIX",
  name: "AI Assistant ↔ xOne",
  state: "open",
  createdAt: "2026-10-09T06:00:00.000Z",
  closedAt: null,
  main: { agentId: "main-aix-0001", state: "idle" },
  level: 2,
  delegated: ["proceed", "staffing"],
  repos: [UI, BE],
  liveWorkers: 3,
  requests: 7,
  criteria: { met: 5, total: 11 },
  questions: 2,
  signals: [MESS],
};
const ORA: MissionSummary = {
  ...AIX,
  missionId: "mis-1123456789",
  code: "ORA",
  name: "Oracle V0.0.4 fixes",
  main: { agentId: "main-ora-0001", state: "working" },
  repos: [BE],
  liveWorkers: 1,
  requests: 1,
  criteria: { met: 2, total: 3 },
  questions: 0,
  signals: [],
};
const PRD1: MissionSummary = {
  ...AIX,
  missionId: "mis-2123456789",
  code: "PRD1",
  name: "PRD for AI Assistant UI",
  state: "closed",
  closedAt: "2026-10-08T15:00:00.000Z",
  main: { agentId: null, state: "none" },
  repos: [UI],
  liveWorkers: 0,
  questions: 0,
  signals: [],
};

const criterion = (id: string, text: string, status: "open" | "met" | "dropped" = "open") => ({ id, text, status, at: status === "open" ? null : at(8, 0) });
const PAGE: MissionGetOutput = {
  summary: AIX,
  charter: {
    goal: "The AI Assistant UI chats with the backend, which answers through xOne; the UI never calls xOne directly.",
    nonGoals: ["Shell registration (xspace-shell)", "mobile layout"],
    confirmedAt: "2026-10-09T07:00:00.000Z",
    criteria: [
      criterion("D1", "Chat UI talks to backend endpoint /api/chat", "met"),
      criterion("D2", "N1–N4 business cards rendered", "met"),
      criterion("D6", "N10–N25 platform screens"),
      criterion("D9", "Direct xOne preview", "dropped"),
      ...["D3", "D4", "D5", "D7", "D8", "D10", "D11"].map((id) => criterion(id, `criterion ${id}`)),
    ],
    budget: { requests: null, workers: 4, reviewCalls: null, days: null },
  },
  governor: [MESS, quiet("overengineering"), quiet("drift"), quiet("stuck"), quiet("budget")],
  rows: [
    { repo: UI, requestId: "req-20261009T042844Z", topic: "N10–N25 platform UI", workerId: "0545c7a1234", phase: "working", ownerQuestions: [], links: [{ repo: BE, messages: 3 }] },
    { repo: UI, requestId: "req-20261009T061148Z", topic: "13 English keys", workerId: "0989dc4abcd", phase: "finished", ownerQuestions: [], links: [] },
    { repo: BE, requestId: "req-20261009T064157Z", topic: "Backend for N10–N25", workerId: "733918bffff", phase: "blocked", ownerQuestions: ["Q1"], links: [{ repo: UI, messages: 3 }] },
  ],
  contracts: [
    { id: "C1", title: "GET /api/greeting", provider: BE, consumers: [UI], version: 2, updatedAt: at(9, 41) },
    { id: "C2", title: "403 CAPABILITY_DISABLED", provider: BE, consumers: [UI], version: 1, updatedAt: at(6, 10) },
  ],
  journal: [
    { at: at(9, 41), kind: "contract", by: "main", text: "contract C1 v2 — 400 for a missing name" },
    { at: at(9, 30), kind: "link", by: "main", text: "linked 0545c7a ↔ 733918b about N10–N25 endpoints" },
    { at: at(9, 12), kind: "criterion", by: "main", text: "criterion D2 met — cards render with backend data" },
    { at: at(8, 55), kind: "governor", by: "orchestrator", text: "governor nudge — 4 Workers on docs/01-prd.md" },
    { at: at(8, 40), kind: "plan", by: "main", text: "plan updated — Phase 3 design before code" },
    { at: at(8, 30), kind: "note", by: "main", text: "an older line" },
  ],
  plan: { text: "1. PRD extended (done) · 2. Backend PRD §6.1 (done)", updatedAt: at(8, 40) },
};

const MEMORY: MemoryListOutput = {
  workspaceId: "ws-be",
  name: "ai-assistant",
  total: 42,
  entries: [
    { id: "mem-0000000001", kind: "decision", text: "appCode is fixed to ai-assistant for now", source: "the owner's answer to q:req-20261009T064157Z:Q2", by: { role: "plugin", agentId: null }, at: "2026-10-09T10:00:00.000Z" },
    { id: "mem-0000000002", kind: "contract", text: "403 CAPABILITY_DISABLED when a feature is off (contract 11 §2.1)", source: "contract 11 §2.1", by: { role: "worker", agentId: "733918bffff" }, at: "2026-10-09T10:00:00.000Z" },
    { id: "mem-0000000003", kind: "convention", text: "Local runs send principal JSON, never a raw Bearer", source: "README", by: { role: "worker", agentId: "7d4e9bf0000" }, at: "2026-10-09T10:00:00.000Z" },
    { id: "prec-1", kind: "precedent", text: "The UI never calls xOne directly", source: "all projects", by: { role: "owner", agentId: null }, at: "2026-10-01T10:00:00.000Z" },
  ],
};

const pressByLabel = (nodes: Array<RNode | string>, label: string) => {
  const node = pressables(nodes).find((entry) => (entry.props["accessibilityLabel"] ?? textOf(entry)) === label);
  expect(node, label).toBeDefined();
  (node!.props["onPress"] as () => void)();
};

describe("the words of the Missions screen (missions design §10.3)", () => {
  it("names each mission class in full and in the list card's short words", () => {
    expect(MISSION_CLASS_WORDS).toEqual({
      proceed: "going on to the next step",
      staffing: "creating Workers",
      "scope-repo": "adding a repository",
      "answer-technical": "Workers' technical questions your repos keep for you",
      "answer-effects": "Workers' questions with effects your repos keep for you",
      split: "splitting the mission",
    });
    expect(MISSION_CLASS_SHORT).toEqual({ proceed: "proceed", staffing: "staffing", "scope-repo": "scope", "answer-technical": "answers", "answer-effects": "effects", split: "split" });
    // Both answer classes on one side read as one phrase (the artboard's "Yours:").
    expect(classWordsOf(["scope-repo", "answer-technical", "answer-effects", "split"])).toBe("adding a repository · Workers' questions your repos keep for you · splitting the mission");
    expect(classWordsOf(["answer-technical"])).toBe("Workers' technical questions your repos keep for you");
  });

  it("has one sentence per level, the form's with its number", () => {
    expect(MISSION_LEVEL_SENTENCES[0]).toBe("The Main asks you before each step.");
    expect(MISSION_LEVEL_SENTENCES[1]).toBe("The Main goes on to next steps by itself.");
    expect(MISSION_LEVEL_SENTENCES[2]).toBe("The Main goes on to next steps and creates Workers by itself.");
    expect(MISSION_LEVEL_SENTENCES[3]).toMatch(/decides Workers' technical questions/);
    expect(MISSION_LEVEL_SENTENCES[4]).toMatch(/adds repositories, decides questions with effects and lets the governor split the mission\.$/);
    expect(levelSentenceOf(2)).toBe("Level 2: the Main goes on to next steps and creates Workers by itself.");
    expect(levelLineOf({ level: 2, delegated: [...MISSION_LEVEL_CLASSES[2]] })).toBe("level 2 · proceed, staffing");
    expect(levelLineOf({ level: 4, delegated: [...MISSION_LEVEL_CLASSES[4]] })).toBe("level 4 · proceed, staffing, scope, answers, effects, split");
    expect(levelLineOf({ level: 0, delegated: [] })).toBe("level 0 · nothing delegated");
  });

  it("says the Main's state as a chip: idle success, working accent, stopped danger, none muted", () => {
    expect(MAIN_STATE_CHIPS).toEqual({
      idle: { text: "Main idle", tone: "success" },
      working: { text: "Main working", tone: "info" },
      stopped: { text: "Main stopped", tone: "danger" },
      none: { text: "No Main", tone: "muted" },
    });
  });

  it("has a sentence for every governor figure, built from its value, threshold and detail", () => {
    expect(Object.keys(FIGURE_WORDS)).toEqual(Object.keys(GOVERNOR_FIGURES));
    const nameOf = (id: string) => (id === "ws-be" ? "ai-assistant" : null);
    for (const id of Object.keys(GOVERNOR_FIGURES)) {
      const sentence = figureSentenceOf({ id, value: 7, threshold: 5, op: ">", crossed: true, detail: null }, nameOf);
      expect(sentence, id).toMatch(/7/);
      expect(sentence, id).toMatch(/\(threshold 5\)$/);
      // Words, not the id the fallback shows.
      expect(sentence, id).not.toBe(`${id} 7 (threshold 5)`);
    }
    expect(figureSentenceOf(MESS.crossed[0]!, nameOf)).toBe("4 Workers wrote docs/01-prd.md today (threshold 2)");
    expect(figureSentenceOf({ id: "workersInOneRepo", value: 4, threshold: 3, op: ">", crossed: true, detail: "ws-be" }, nameOf)).toBe("4 Workers at work in ai-assistant (threshold 3)");
    expect(figureSentenceOf({ id: "outsideCharter", value: 1, threshold: 1, op: ">=", crossed: true, detail: "ws-be" }, nameOf)).toBe("1 request or link outside the charter: ai-assistant (threshold 1)");
    expect(figureSentenceOf({ id: "workersBudget", value: 100, threshold: 100, op: ">=", crossed: true, detail: "4 of 4" }, nameOf)).toBe("100% of the Workers budget used (4 of 4) (threshold 100)");
    // A figure of a newer server still reads.
    expect(figureSentenceOf({ id: "somethingNew", value: 2, threshold: 1, op: ">=", crossed: true, detail: null }, nameOf)).toBe("somethingNew 2 (threshold 1)");
  });

  it("writes the governor's lines: each family at step 1 or more with its action, the quiet ones as one line", () => {
    const { lines, quiet: rest } = governorLinesOf(PAGE.governor, NOW, () => null);
    expect(lines).toEqual([{ label: "Mess:", text: "4 Workers wrote docs/01-prd.md today (threshold 2) — Main nudged 12 min ago, re-plan due in 18 min", tone: "warning" }]);
    expect(rest).toEqual({ label: "Overengineering, drift, stuck, budget:", text: "within the charter", tone: "success" });
    const calm = governorLinesOf([quiet("mess")], NOW, () => null);
    expect(calm.lines).toEqual([]);
    expect(calm.quiet?.label).toBe("Mess, overengineering, drift, stuck, budget:");
    const stopping = governorLinesOf([{ ...MESS, step: 4, lastAction: { kind: "replan", at: minutesFromNow(-3) }, replanDueAt: null }], NOW, () => null);
    expect(stopping.lines[0]).toEqual({ label: "Mess:", text: "4 Workers wrote docs/01-prd.md today (threshold 2) — Main asked to re-plan 3 min ago", tone: "danger" });
  });
});

describe("the list card (artboards A and C; §10.2)", () => {
  it("shows the code, name, Main, level, repositories, Workers, progress, questions and governor of an open mission", () => {
    const card = missionCardOf(AIX, NOW);
    expect(card).toMatchObject({
      code: "AIX",
      name: "AI Assistant ↔ xOne",
      open: true,
      main: { text: "Main idle", tone: "success" },
      level: "level 2 · proceed, staffing",
      repos: ["xspace-ai-assistant", "ai-assistant"],
      counts: "3 live Workers · 7 requests",
      criteria: "Done criteria 5 of 11",
      quiet: null,
      closedLine: null,
      phoneLine: "2 repositories · 3 live Workers · Main idle",
    });
    expect(card.progress).toBeCloseTo(5 / 11);
    expect(card.attention).toEqual([
      { text: "2 questions for you", tone: "warning" },
      { text: "Governor: 4 Workers on one area — nudged 12 min ago", tone: "warning" },
    ]);
    expect(card.phoneParts).toEqual([
      { text: "Done 5 of 11", tone: "plain" },
      { text: "2 questions", tone: "warning" },
      { text: "1 signal", tone: "warning" },
    ]);
  });

  it("says No questions · no signals when there is neither, in the singular where it is one", () => {
    const card = missionCardOf(ORA, NOW);
    expect(card).toMatchObject({ main: { text: "Main working", tone: "info" }, counts: "1 live Worker · 1 request", quiet: "No questions · no signals", attention: [], phoneLine: "1 repository · 1 live Worker · Main working" });
    expect(card.phoneParts).toEqual([{ text: "Done 2 of 3", tone: "plain" }]);
  });

  it("shows a closed mission as closed <date> · <repos>, and lists the open missions first", () => {
    expect(missionCardOf(PRD1, NOW)).toMatchObject({ open: false, closedLine: "closed 2026-10-08 · xspace-ai-assistant", main: { text: "No Main" } });
    const list = missionListOf([AIX, ORA, PRD1], NOW);
    expect(list.open.map((card) => card.code)).toEqual(["AIX", "ORA"]);
    expect(list.closed.map((card) => card.code)).toEqual(["PRD1"]);
    expect(missionCardOf({ ...ORA, criteria: { met: 0, total: 0 } }, NOW).progress).toBe(0);
  });
});

describe("a mission's page (artboards B and D; §10.2)", () => {
  const page = missionPageOf(PAGE, NOW);

  it("shows the stats: done criteria, live Workers with the budget, questions in the warning tone", () => {
    expect(page.stats).toEqual([
      { label: "Done criteria", short: "Done", value: "5 / 11", shortValue: "5/11", hint: null, tone: "plain" },
      { label: "Live Workers", short: "Workers", value: "3", shortValue: "3", hint: "budget 4", tone: "plain" },
      { label: "Questions for you", short: "For you", value: "2", shortValue: "2", hint: null, tone: "warning" },
    ]);
    expect(missionPageOf({ ...PAGE, summary: { ...AIX, questions: 0 }, charter: { ...PAGE.charter, budget: null } }, NOW).stats.map((stat) => [stat.hint, stat.tone])).toEqual([
      [null, "plain"],
      [null, "plain"],
      [null, "plain"],
    ]);
  });

  it("shows the charter: confirmed date, goal, repositories, non-goals and its criteria", () => {
    expect(page.charter.label).toBe("Charter · confirmed 2026-10-09");
    expect(missionPageOf({ ...PAGE, charter: { ...PAGE.charter, confirmedAt: null } }, NOW).charter.label).toBe("Charter · not confirmed");
    expect(page.charter.goal).toMatch(/^The AI Assistant UI chats/);
    expect(page.charter.repos.map((repo) => repo.name)).toEqual(["xspace-ai-assistant", "ai-assistant"]);
    expect(page.charter.nonGoals).toBe("Shell registration (xspace-shell) · mobile layout");
    expect(page.charter.criteria.slice(0, 4)).toEqual([
      { id: "D1", line: "D1 Chat UI talks to backend endpoint /api/chat", status: "met" },
      { id: "D2", line: "D2 N1–N4 business cards rendered", status: "met" },
      { id: "D6", line: "D6 N10–N25 platform screens", status: "open" },
      { id: "D9", line: "D9 Direct xOne preview — dropped", status: "dropped" },
    ]);
  });

  it("shows who decides what at the mission's level, and the governor", () => {
    expect(page.level).toEqual({
      level: 2,
      decides: "going on to the next step · creating Workers",
      yours: "adding a repository · Workers' questions your repos keep for you · splitting the mission",
      sentence: "The Main goes on to next steps and creates Workers by itself.",
    });
    expect(page.governor.lines.map((line) => `${line.label} ${line.text}`)).toEqual(["Mess: 4 Workers wrote docs/01-prd.md today (threshold 2) — Main nudged 12 min ago, re-plan due in 18 min"]);
    expect(page.phoneGovernor.map((line) => `${line.label} ${line.text}`)).toEqual(["Mess: 4 Workers wrote docs/01-prd.md today — Main nudged"]);
    const all = missionPageOf({ ...PAGE, summary: { ...AIX, level: 4, delegated: [...MISSION_LEVEL_CLASSES[4]] } }, NOW).level;
    expect(all.yours).toBe("nothing — every class is the Main's");
    expect(missionPageOf({ ...PAGE, summary: { ...AIX, level: 0, delegated: [] } }, NOW).level.decides).toBe("nothing on its own");
  });

  it("lists the Workers by repository: request, topic, Worker, phase with the owner's questions, links", () => {
    expect(page.rows.map((row) => [row.repo, row.request, row.topic, row.worker, row.phase.text, row.phase.tone, row.links])).toEqual([
      ["xspace-ai-assistant", "req-…042844Z", "N10–N25 platform UI", "0545c7a", "working", "info", "↔ ai-assistant · 3"],
      ["xspace-ai-assistant", "req-…061148Z", "13 English keys", "0989dc4", "finished", "success", "—"],
      ["ai-assistant", "req-…064157Z", "Backend for N10–N25", "733918b", "blocked · Q1 for you", "warning", "↔ xspace-ai-assistant · 3"],
    ]);
    expect(page.restLine).toBe("+ 1 finished");
    const stopped = missionPageOf({ ...PAGE, rows: [{ ...PAGE.rows[0]!, phase: "stopped" }] }, NOW);
    expect(stopped.rows[0]!.phase).toEqual({ text: "stopped", tone: "muted" });
    expect(stopped.restLine).toBe("+ 1 stopped");
  });

  it("shows the contracts, the journal as HH:MM text and the plan, read-only", () => {
    expect(page.contracts).toEqual([
      { id: "C1", title: "C1 GET /api/greeting", parties: "ai-assistant → xspace-ai-assistant", version: "v2 · 09:41" },
      { id: "C2", title: "C2 403 CAPABILITY_DISABLED", parties: "ai-assistant → xspace-ai-assistant", version: "v1 · 06:10" },
    ]);
    expect(page.journal[0]).toEqual({ time: "09:41", text: "contract C1 v2 — 400 for a missing name" });
    expect(page.plan).toEqual({ text: "1. PRD extended (done) · 2. Backend PRD §6.1 (done)", meta: "updated 08:40 by the Main · read-only" });
    expect(missionPageOf({ ...PAGE, plan: { text: "", updatedAt: null } }, NOW).plan).toEqual({ text: "No plan yet.", meta: "not written yet · read-only" });
  });

  it("offers to add the listed projects not in the charter yet", () => {
    expect(addableReposOf([{ id: "ws-ui", name: "xspace-ai-assistant" }, { id: "ws-site", name: "paseo-bm site" }], page.charter.repos)).toEqual([{ id: "ws-site", name: "paseo-bm site" }]);
    // By project too: a repo chosen through another workspace of its project is in the mission (mission-projects.html, artboard N).
    const projects = [
      { id: "ws-ui-root", projectId: "p-ui", name: "xspace-ai-assistant" },
      { id: "project:p-site", projectId: "p-site", name: "paseo-bm-site" },
    ];
    const projectOf = (id: string) => ({ "ws-ui": "p-ui", "ws-be": "p-be" })[id] ?? null;
    expect(addableReposOf(projects, page.charter.repos, projectOf).map((project) => project.id)).toEqual(["project:p-site"]);
  });
});

describe("New mission and Rename (artboard E; §10.2)", () => {
  const valid: MissionDraft = { name: "AI Assistant ↔ xOne", code: "AIX", goal: "", repos: ["ws-ui"], level: 2 };

  it("opens empty at level 2 and refuses a missing name, a bad code and no repository", () => {
    expect(EMPTY_MISSION_DRAFT).toEqual({ name: "", code: "", goal: "", repos: [], level: 2 });
    expect(missionDraftErrors(EMPTY_MISSION_DRAFT)).toEqual([
      "Name: 1 to 80 characters.",
      "Short code: a capital letter, then 1 to 7 capitals or digits (AIX, ORA2).",
      "Projects: choose at least one.",
    ]);
    expect(missionDraftErrors(valid)).toEqual([]);
    expect(missionDraftErrors({ ...valid, name: "x".repeat(81) })).toEqual(["Name: 1 to 80 characters."]);
    expect(missionDraftErrors({ ...valid, name: "   " })).toEqual(["Name: 1 to 80 characters."]);
    for (const code of ["A", "1AB", "AB-C", "ABCDEFGHI"]) expect(missionDraftErrors({ ...valid, code }), code).toHaveLength(1);
    for (const code of ["AI", "ORA2", "ABCDEFGH"]) expect(missionDraftErrors({ ...valid, code }), code).toEqual([]);
    expect(missionDraftErrors({ ...valid, goal: "g".repeat(4_001) })).toEqual(["Goal: at most 4,000 characters."]);
  });

  it("upper-cases the code as typed and sends the trimmed name, the code, the repositories and a goal only when there is one", () => {
    expect(codeAsTyped("aix 2")).toBe("AIX2");
    expect(codeAsTyped("abcdefghij")).toBe("ABCDEFGH");
    expect(createInputOf({ ...valid, name: "  AIX mission  " })).toEqual({ name: "AIX mission", code: "AIX", repos: ["ws-ui"] });
    expect(createInputOf({ ...valid, goal: " Chat through the backend. " })).toEqual({ name: "AI Assistant ↔ xOne", code: "AIX", repos: ["ws-ui"], goal: "Chat through the backend." });
    expect(toggleRepo(valid, "ws-be").repos).toEqual(["ws-ui", "ws-be"]);
    expect(toggleRepo(valid, "ws-ui").repos).toEqual([]);
  });

  it("confirms levels 3 and 4 in place, Cancel first, and Close mission likewise", () => {
    expect(MISSION_LEVELS.map((level) => levelNeedsConfirmation(level))).toEqual([false, false, false, true, true]);
    const dialog = levelConfirmDialog(3, "AIX");
    expect(dialog).toMatchObject({ title: "Set AIX to level 3?", confirmLabel: "Set level 3", cancelLabel: "Cancel", defaultAction: "cancel" });
    expect(levelConfirmDialog(4, null).title).toBe("Use level 4?");
    expect(levelConfirmDialog(4, null).body).toMatch(/with effects/);
    expect(closeMissionDialog("AIX")).toMatchObject({ title: "Close AIX?", confirmLabel: "Close mission", confirmKind: "danger", defaultAction: "cancel" });
  });

  it("renames with only what changed", () => {
    const current = { name: "AI Assistant ↔ xOne", code: "AIX" };
    expect(renameInputOf("mis-0123456789", current, " AI Assistant ↔ xOne ", "AIX")).toBeNull();
    expect(renameInputOf("mis-0123456789", current, "AI Assistant", "AIX")).toEqual({ missionId: "mis-0123456789", name: "AI Assistant" });
    expect(renameInputOf("mis-0123456789", current, "AI Assistant ↔ xOne", "AIX2")).toEqual({ missionId: "mis-0123456789", code: "AIX2" });
  });
});

describe("a project's memory (artboard F; §10.2)", () => {
  it("names each entry's source: the owner's answer, a Worker, a precedent of all projects", () => {
    expect(memoryViewOf(MEMORY)).toEqual({
      title: "Memory · ai-assistant",
      count: "42 entries",
      rows: [
        { id: "mem-0000000001", kind: "decision", text: "appCode is fixed to ai-assistant for now", source: "owner, Q2 · 2026-10-09" },
        { id: "mem-0000000002", kind: "contract", text: "403 CAPABILITY_DISABLED when a feature is off (contract 11 §2.1)", source: "Worker 733918b" },
        { id: "mem-0000000003", kind: "convention", text: "Local runs send principal JSON, never a raw Bearer", source: "Worker 7d4e9bf" },
        { id: "prec-1", kind: "precedent", text: "The UI never calls xOne directly", source: "owner · all projects" },
      ],
    });
    expect(memoryViewOf({ ...MEMORY, total: 1, entries: [] }).count).toBe("1 entry");
    const base = { kind: "fact" as const, at: "2026-10-09T10:00:00.000Z" };
    expect(memorySourceOf({ ...base, source: "Q3", by: { role: "owner", agentId: null } })).toBe("owner, Q3 · 2026-10-09");
    expect(memorySourceOf({ ...base, source: "", by: { role: "main", agentId: "main-aix-0001" } })).toBe("Main main-ai");
    expect(memorySourceOf({ ...base, kind: "precedent", source: "q:req-1:Q4", by: { role: "owner", agentId: null } })).toBe("owner, Q4 · 2026-10-09");
    // A source written by hand that already names the owner or carries the date says neither twice.
    expect(memorySourceOf({ ...base, source: "owner · 2026-10-09", by: { role: "owner", agentId: null } })).toBe("owner · 2026-10-09");
    expect(memorySourceOf({ ...base, source: "Q2 · 2026-10-09", by: { role: "owner", agentId: null } })).toBe("owner, Q2 · 2026-10-09");
    expect(memorySourceOf({ ...base, source: "owner, Q5", by: { role: "owner", agentId: null } })).toBe("owner, Q5 · 2026-10-09");
  });
});

describe("the hook-free pieces of the Missions screen (renderTree)", () => {
  it("draws an open list card with the accent bar, its chips and its progress, and opens the mission when pressed", () => {
    const onOpen = vi.fn();
    const nodes = renderTree(MissionCard({ card: missionCardOf(AIX, NOW), compact: false, onOpen, styles, theme }));
    const shown = texts(nodes);
    for (const text of ["AIX", "AI Assistant ↔ xOne", "Main idle", "level 2 · proceed, staffing", "xspace-ai-assistant", "ai-assistant", "3 live Workers · 7 requests", "Done criteria 5 of 11", "2 questions for you", "Governor: 4 Workers on one area — nudged 12 min ago"]) {
      expect(shown, text).toContain(text);
    }
    const all = allNodes(nodes);
    expect(all.some((node) => flat(node.props["style"])["width"] === 3 && flat(node.props["style"])["backgroundColor"] === "#accent")).toBe(true);
    expect(all.some((node) => flat(node.props["style"])["height"] === 4 && flat(node.props["style"])["width"] === "45%")).toBe(true);
    // The Main idle chip's square is the success colour.
    expect(all.some((node) => flat(node.props["style"])["width"] === 7 && flat(node.props["style"])["backgroundColor"] === "#statusSuccess")).toBe(true);
    pressByLabel(nodes, "AIX AI Assistant ↔ xOne. Open the mission");
    expect(onOpen).toHaveBeenCalledWith("mis-0123456789");
  });

  it("dims a closed card without the bar, and draws the phone card's lines", () => {
    const closed = renderTree(MissionCard({ card: missionCardOf(PRD1, NOW), compact: false, onOpen: noop, styles, theme }));
    expect(flat((closed[0] as RNode).props["style"])).toMatchObject({ opacity: 0.7 });
    expect(allNodes(closed).some((node) => flat(node.props["style"])["width"] === 3)).toBe(false);
    expect(texts(closed)).toContain("closed 2026-10-08 · xspace-ai-assistant");
    const phone = texts(renderTree(MissionCard({ card: missionCardOf(AIX, NOW), compact: true, onOpen: noop, styles, theme })));
    expect(phone).toContain("2 repositories · 3 live Workers · Main idle");
    expect(phone).toContain("Done 5 of 11 · 2 questions · 1 signal");
  });

  it("draws the list: the title, New mission, the intro, Open · n and Closed · n; the phone folds the closed ones", () => {
    const list = missionListOf([AIX, ORA, PRD1], NOW);
    const onNew = vi.fn();
    const wide = renderTree(MissionList({ list, error: null, compact: false, closedShown: false, onToggleClosed: noop, onOpen: noop, onNew, styles, theme }));
    const shown = texts(wide);
    for (const text of ["Missions", "New mission", "One Main per goal. A mission spans the repositories it needs; you name it, you close it.", "Open · 2", "Closed · 1", "PRD1"]) expect(shown, text).toContain(text);
    pressByLabel(wide, "New mission");
    expect(onNew).toHaveBeenCalled();
    const onToggleClosed = vi.fn();
    const phone = renderTree(MissionList({ list, error: null, compact: true, closedShown: false, onToggleClosed, onOpen: noop, onNew: noop, styles, theme }));
    expect(texts(phone)).toContain("New");
    expect(texts(phone)).not.toContain("Open · 2");
    expect(texts(phone)).not.toContain("PRD1");
    pressByLabel(phone, "Show the closed missions");
    expect(onToggleClosed).toHaveBeenCalled();
    expect(texts(renderTree(MissionList({ list: null, error: "E_X: down", compact: false, closedShown: false, onToggleClosed: noop, onOpen: noop, onNew: noop, styles, theme })))).toContain("Could not read the missions: E_X: down");
  });

  const actions = () => ({ back: vi.fn(), openMain: vi.fn(), ui: vi.fn(), saveRename: vi.fn(), close: vi.fn(), addRepos: vi.fn(), level: vi.fn(), confirmLevel: vi.fn(), memory: vi.fn() });
  const SITE = { id: "ws-site", projectId: "p-site", name: "paseo-bm-site", path: "~/…/self/paseo-plugins/paseo-bm-site", rootPath: "/Users/me/work/self/paseo-plugins/paseo-bm-site", workspaceId: "ws-site" };
  const SHELL = { id: "project:p-shell", projectId: "p-shell", name: "xspace-shell", path: "~/…/dx/frontend/xspace/xspace-shell", rootPath: "/Users/me/work/dx/frontend/xspace/xspace-shell", workspaceId: null };
  const body = (ui: Record<string, unknown>, compact: boolean, on = actions(), view = missionPageOf(PAGE, NOW)) =>
    renderTree(MissionPageBody({ page: view, ui: { ...PAGE_UI_IDLE, ...ui }, addable: [SHELL, SITE], compact, on, styles, theme }));

  it("draws the wide page as artboard B", () => {
    const on = actions();
    const nodes = body({}, false, on);
    const shown = texts(nodes);
    for (const text of [
      "Missions ›", "AIX", "AI Assistant ↔ xOne", "Open Main", "Rename", "Close mission",
      "Done criteria", "5 / 11", "Live Workers", "budget 4", "Questions for you",
      "Charter · confirmed 2026-10-09", "Goal", "Repositories", "+ Add", "Not in this mission", "Shell registration (xspace-shell) · mobile layout",
      "D1 Chat UI talks to backend endpoint /api/chat", "D9 Direct xOne preview — dropped", "+ 7 more",
      "Mission level", "The Main decides: going on to the next step · creating Workers", "Governor",
      "Mess: 4 Workers wrote docs/01-prd.md today (threshold 2) — Main nudged 12 min ago, re-plan due in 18 min",
      "Overengineering, drift, stuck, budget: within the charter",
      "Workers by repository", "Repository", "Request · topic", "Worker", "Phase", "Links", "req-…042844Z", "0545c7a", "blocked · Q1 for you", "↔ ai-assistant · 3",
      "Contracts between repositories", "C1 GET /api/greeting", "v2 · 09:41", "Journal", "09:41", "Plan", "updated 08:40 by the Main · read-only",
    ]) {
      expect(shown, text).toContain(text);
    }
    expect(shown).not.toContain("D3 criterion D3");
    // Five journal lines on a wide page.
    expect(shown).not.toContain("08:30");
    // The level cells: five, level 2 filled in the accent.
    const cells = pressables(nodes).filter((node) => node.props["accessibilityRole"] === "radio");
    expect(cells.map((cell) => textOf(cell))).toEqual(["0", "1", "2", "3", "4"]);
    expect(cells.map((cell) => (cell.props["accessibilityState"] as { checked: boolean }).checked)).toEqual([false, false, true, false, false]);
    expect(flat(cells[2]!.props["style"])).toMatchObject({ backgroundColor: "#accent" });
    (cells[3]!.props["onPress"] as () => void)();
    expect(on.level).toHaveBeenCalledWith(3);
    pressByLabel(nodes, "Show 7 more done criteria");
    expect(on.ui).toHaveBeenCalledWith({ allCriteria: true });
    pressByLabel(nodes, "Open the Main of AIX");
    expect(on.openMain).toHaveBeenCalled();
    pressByLabel(nodes, "ai-assistant. Open its project memory");
    expect(on.memory).toHaveBeenCalledWith("ws-be");
    pressByLabel(nodes, "Back to Missions");
    expect(on.back).toHaveBeenCalled();
  });

  it("shows every criterion, the add picker, the rename fields and the confirmations in place", () => {
    expect(texts(body({ allCriteria: true }, false))).toEqual(expect.arrayContaining(["D11 criterion D11", "Show fewer"]));
    const on = actions();
    // Artboard N: "+ Add" opens the same list — only projects not in the mission —, with Cancel and Add.
    const plusAdd = allNodes(body({}, false, on)).find((node) => node.type === "Text" && textOf(node) === "+ Add")!;
    expect(flat(plusAdd.props["style"])).toMatchObject({ fontSize: 12, color: "#accent" });
    pressByLabel(body({}, false, on), "Add a repository to the mission");
    expect(on.ui).toHaveBeenCalledWith({ adding: true, addChosen: [], addFilter: "" });
    const adding = body({ adding: true }, false, on);
    const shownAdding = texts(adding);
    for (const text of ["xspace-shell", "~/…/dx/frontend/xspace/xspace-shell", "paseo-bm-site", "~/…/self/paseo-plugins/paseo-bm-site", "Cancel", "Add"]) expect(shownAdding, text).toContain(text);
    // Two projects: no "Find a project…" (it shows above six), no header or footnote in the panel.
    expect(allNodes(adding).filter((node) => node.type === "TextInput" && node.props["placeholder"] === "Find a project…")).toHaveLength(0);
    expect(shownAdding.some((text) => text.startsWith("Named as in Paseo's sidebar"))).toBe(false);
    const addButton = (nodes: Array<RNode | string>) => pressables(nodes).find((node) => node.props["accessibilityLabel"] === "Add the chosen projects to the mission")!;
    expect(addButton(adding).props["disabled"]).toBe(true);
    pressByLabel(adding, "paseo-bm-site, ~/…/self/paseo-plugins/paseo-bm-site");
    expect(on.ui).toHaveBeenCalledWith({ addChosen: ["ws-site"] });
    const ticked = body({ adding: true, addChosen: ["ws-site", "project:p-shell"] }, false, on);
    expect(addButton(ticked).props["disabled"]).toBe(false);
    (addButton(ticked).props["onPress"] as () => void)();
    expect(on.addRepos).toHaveBeenCalledWith(["ws-site", "project:p-shell"]);
    pressByLabel(ticked, "Cancel");
    expect(on.ui).toHaveBeenCalledWith({ adding: false, addChosen: [], addFilter: "" });
    expect(texts(renderTree(MissionPageBody({ page: missionPageOf(PAGE, NOW), ui: { ...PAGE_UI_IDLE, adding: true }, addable: [], compact: false, on, styles, theme })))).toContain("Every listed project is in this mission already.");
    const renaming = body({ rename: { name: "AI Assistant", code: "A" } }, false, on);
    const inputs = allNodes(renaming).filter((node) => node.type === "TextInput");
    expect(inputs.map((input) => input.props["value"])).toEqual(["AI Assistant", "A"]);
    expect(texts(renaming)).toContain("Short code: a capital letter, then 1 to 7 capitals or digits (AIX, ORA2).");
    expect(texts(body({ confirm: { kind: "close" } }, false))).toEqual(expect.arrayContaining(["Close AIX?", "Cancel"]));
    expect(texts(body({ confirm: { kind: "level", level: 3 } }, false))).toContain("Set AIX to level 3?");
    expect(texts(body({ error: "Could not close the mission: E_MISSION_INVALID: a Worker runs" }, false))).toContain("Could not close the mission: E_MISSION_INVALID: a Worker runs");
  });

  it("draws the phone page as artboard D: Open Main and ⋯, short stats, the chips that open each part in place", () => {
    const on = actions();
    const nodes = body({}, true, on);
    const shown = texts(nodes);
    for (const text of ["Missions ›", "Open Main", "⋯", "Done", "5/11", "Workers", "For you", "Charter", "Governor", "Mess: 4 Workers wrote docs/01-prd.md today — Main nudged", "Mission level", "The Main goes on to next steps and creates Workers by itself.", "Contracts · 2", "Journal", "Plan", "Project memory", "+ 1 finished"]) {
      expect(shown, text).toContain(text);
    }
    expect(shown).not.toContain("Rename");
    expect(shown).not.toContain("+ Add");
    pressByLabel(nodes, "More actions: Rename, Close mission");
    expect(on.ui).toHaveBeenCalledWith({ menu: true });
    expect(texts(body({ menu: true }, true))).toEqual(expect.arrayContaining(["Rename", "Close mission"]));
    pressByLabel(nodes, "Journal");
    expect(on.ui).toHaveBeenCalledWith({ part: "journal" });
    pressByLabel(nodes, "Project memory");
    expect(on.memory).toHaveBeenCalledWith("ws-ui");
    const journal = texts(body({ part: "journal" }, true));
    expect(journal).toEqual(expect.arrayContaining(["‹ AIX", "Journal", "08:30"]));
    expect(journal).not.toContain("Charter");
  });

  it("shows a closed mission's page without its actions", () => {
    const closed = texts(body({}, false, actions(), missionPageOf({ ...PAGE, summary: PRD1 }, NOW)));
    expect(closed).toContain("closed 2026-10-08");
    for (const gone of ["Open Main", "Rename", "Close mission", "+ Add"]) expect(closed).not.toContain(gone);
  });

  // The projects of artboards L and M (mission-projects.html): the mockup's own rows.
  const project = (name: string, folder: string, id = `ws-${name}`) => ({ id, projectId: `p-${name}`, name, path: folder, rootPath: folder.replace("~", "/Users/me"), workspaceId: id.startsWith("project:") ? null : id });
  const PROJECTS = [
    project("xspace-ai-assistant", "~/…/dx/frontend/xspace/xspace-ai-assistant", "ws-ui"),
    project("ai-assistant", "~/…/dx/backends/ai-assistant", "ws-be"),
    project("xspace-shell", "~/…/dx/frontend/xspace/xspace-shell"),
    project("paseo-bm", "~/…/self/paseo-plugins/paseo-bm", "ws-bm"),
    project("paseo-bm-site", "~/…/self/paseo-plugins/paseo-bm-site", "project:p-paseo-bm-site"),
  ];
  const FOOTNOTE = "Named as in Paseo's sidebar; rename a project in Paseo to change its name here. The mission works in each project's own branch and worktree.";
  const filterOf = (nodes: Array<RNode | string>) => allNodes(nodes).filter((node) => node.type === "TextInput" && node.props["placeholder"] === "Find a project…");

  it("draws New mission as artboards E and L: one row per project, a checkbox, the bold name, the folder in mono", () => {
    const onDraft = vi.fn();
    const onCreate = vi.fn();
    const onFilter = vi.fn();
    const props = {
      draft: { name: "AI Assistant ↔ xOne", code: "AIX", goal: "", repos: ["ws-ui", "ws-be"], level: 2 },
      errors: [],
      projects: PROJECTS,
      filter: "",
      onFilter,
      confirming: null,
      busy: false,
      error: null,
      onDraft,
      onLevel: noop,
      onConfirmLevel: noop,
      onCancelLevel: noop,
      onCancel: noop,
      onCreate,
      compact: false,
      styles,
      theme,
    };
    const nodes = renderTree(NewMissionForm(props));
    const shown = texts(nodes);
    for (const text of [
      "New mission", "Name", "Short code", "Goal (the Main can draft the rest of the charter with you)",
      "Projects · the repositories this mission works in", "2 chosen",
      "xspace-ai-assistant", "~/…/dx/frontend/xspace/xspace-ai-assistant", "ai-assistant", "xspace-shell", "paseo-bm", "paseo-bm-site", "~/…/self/paseo-plugins/paseo-bm-site",
      FOOTNOTE, "Mission level", "Level 2: the Main goes on to next steps and creates Workers by itself.", "Cancel", "Create and open Main",
    ]) {
      expect(shown, text).toContain(text);
    }
    // The mockup's order: the header, the rows, the footnote, then Mission level.
    expect(shown.indexOf("Projects · the repositories this mission works in")).toBeLessThan(shown.indexOf("xspace-ai-assistant"));
    expect(shown.indexOf("paseo-bm-site")).toBeLessThan(shown.indexOf(FOOTNOTE));
    expect(shown.indexOf(FOOTNOTE)).toBeLessThan(shown.indexOf("Mission level"));
    expect(shown).not.toContain("Repositories");
    // "2 chosen" in the accent; the name bold, the folder mono and muted.
    const chosen = allNodes(nodes).find((node) => node.type === "Text" && textOf(node) === "2 chosen")!;
    expect(flat(chosen.props["style"])).toMatchObject({ color: "#accent", fontSize: 12 });
    const name = allNodes(nodes).find((node) => node.type === "Text" && textOf(node) === "paseo-bm")!;
    expect(flat(name.props["style"])).toMatchObject({ fontSize: 13, fontWeight: "600", color: "#foreground" });
    const folder = allNodes(nodes).find((node) => node.type === "Text" && textOf(node) === "~/…/self/paseo-plugins/paseo-bm")!;
    expect(flat(folder.props["style"])).toMatchObject({ fontSize: 11, color: "#foregroundMuted" });
    expect(flat(folder.props["style"])["fontFamily"]).toBeDefined();
    // Five projects: every row, no "Find a project…" (it shows above six).
    expect(filterOf(nodes)).toHaveLength(0);
    const rows = pressables(nodes).filter((node) => node.props["accessibilityRole"] === "checkbox");
    expect(rows.map((node) => node.props["accessibilityLabel"])).toEqual(PROJECTS.map((entry) => `${entry.name}, ${entry.path}`));
    expect(rows.map((node) => (node.props["accessibilityState"] as { checked: boolean }).checked)).toEqual([true, true, false, false, false]);
    // A ticked box: the accent fill and its tick in the accent's foreground.
    expect(allNodes([rows[0]!]).some((node) => flat(node.props["style"])["backgroundColor"] === "#accent" && flat(node.props["style"])["width"] === 16)).toBe(true);
    expect(texts([rows[0]!])).toContain("✓");
    expect(texts([rows[2]!])).not.toContain("✓");
    (rows[4]!.props["onPress"] as () => void)();
    expect(onDraft).toHaveBeenCalledWith(expect.objectContaining({ repos: ["ws-ui", "ws-be", "project:p-paseo-bm-site"] }));
    (rows[0]!.props["onPress"] as () => void)();
    expect(onDraft).toHaveBeenCalledWith(expect.objectContaining({ repos: ["ws-be"] }));
    const code = allNodes(nodes).filter((node) => node.type === "TextInput")[1]!;
    (code.props["onChangeText"] as (text: string) => void)("ora2");
    expect(onDraft).toHaveBeenCalledWith(expect.objectContaining({ code: "ORA2" }));
    pressByLabel(nodes, "Create and open Main");
    expect(onCreate).toHaveBeenCalled();
    const confirming = texts(renderTree(NewMissionForm({ ...props, confirming: 3, errors: ["Projects: choose at least one."] })));
    expect(confirming).toEqual(expect.arrayContaining(["Use level 3?", "Set level 3", "Projects: choose at least one."]));
    // Review U1: Create waits while a level 3 or 4 waits for its confirmation.
    const create = (form: Record<string, unknown>) => pressables(renderTree(NewMissionForm({ ...props, ...form }))).find((node) => textOf(node) === "Create and open Main")!;
    expect(create({ confirming: 3 }).props["disabled"]).toBe(true);
    expect(create({ confirming: 3 }).props["accessibilityState"]).toMatchObject({ disabled: true });
    expect(create({}).props["disabled"]).toBe(false);
    expect(texts(renderTree(NewMissionForm({ ...props, busy: true })))).toContain("Creating…");
    expect(texts(renderTree(NewMissionForm({ ...props, projects: [] })))).toContain("No project is listed yet.");

    // More than six projects: "Find a project…", filtering by name and folder as typed.
    const many = [...PROJECTS, project("oracle", "~/…/dx/backends/oracle"), project("xone", "~/…/dx/backends/xone")];
    const filtered = renderTree(NewMissionForm({ ...props, projects: many, filter: "backends" }));
    const input = filterOf(filtered);
    expect(input).toHaveLength(1);
    expect(input[0]!.props["value"]).toBe("backends");
    (input[0]!.props["onChangeText"] as (text: string) => void)("xsp");
    expect(onFilter).toHaveBeenCalledWith("xsp");
    expect(pressables(filtered).filter((node) => node.props["accessibilityRole"] === "checkbox").map((node) => node.props["accessibilityLabel"])).toEqual(["ai-assistant, ~/…/dx/backends/ai-assistant", "oracle, ~/…/dx/backends/oracle", "xone, ~/…/dx/backends/xone"]);
    expect(texts(renderTree(NewMissionForm({ ...props, projects: many, filter: "nothing-like-it" })))).toContain("No project matches.");
  });

  it("draws New mission on a phone as artboard M: Projects, N chosen, the first four rows, then + N more", () => {
    const nodes = renderTree(
      NewMissionForm({ draft: { ...EMPTY_MISSION_DRAFT, repos: ["ws-ui", "ws-be"] }, errors: [], projects: PROJECTS, filter: "", onFilter: noop, confirming: null, busy: false, error: null, onDraft: noop, onLevel: noop, onConfirmLevel: noop, onCancelLevel: noop, onCancel: noop, onCreate: noop, compact: true, styles, theme }),
    );
    const shown = texts(nodes);
    for (const text of ["Projects", "2 chosen", "xspace-ai-assistant", "ai-assistant", "xspace-shell", "paseo-bm", "+ 1 more · type to find it", FOOTNOTE]) expect(shown, text).toContain(text);
    expect(shown).not.toContain("Projects · the repositories this mission works in");
    expect(shown).not.toContain("paseo-bm-site");
    // The phone cuts the list, so it shows the filter its "type to find it" needs.
    expect(filterOf(nodes)).toHaveLength(1);
    expect(pressables(nodes).filter((node) => node.props["accessibilityRole"] === "checkbox")).toHaveLength(4);
  });

  it("draws a project's memory as artboard F", () => {
    const shown = texts(renderTree(MemoryTable({ view: memoryViewOf(MEMORY), compact: false, theme })));
    for (const text of ["Memory · ai-assistant", "42 entries", "Kind", "Entry", "Source", "decision", "appCode is fixed to ai-assistant for now", "owner, Q2 · 2026-10-09", "Worker 733918b", "precedent", "owner · all projects"]) {
      expect(shown, text).toContain(text);
    }
    expect(texts(renderTree(MemoryTable({ view: memoryViewOf({ ...MEMORY, total: 0, entries: [] }), compact: false, theme })))).toContain("Nothing in this project's memory yet.");
  });

  it("gives a project's page a Memory action only when it can show the memory (§10.1)", () => {
    const onMemory = vi.fn();
    for (const compact of [false, true]) {
      const nodes = renderTree(ProjectHeader({ label: "xspace", tab: "overview", onTab: noop, chatBusy: false, onMemory, compact, theme }));
      pressByLabel(nodes, "The project memory of xspace");
      expect(texts(renderTree(ProjectHeader({ label: "xspace", tab: "overview", onTab: noop, chatBusy: false, compact, theme })))).not.toContain("Memory");
    }
    expect(onMemory).toHaveBeenCalledTimes(2);
  });
});

describe("the mission page's Main card and In flight card (mission runtime design §7; mockup mission-runtime.html, artboards G and H)", () => {
  const R = (n: number) => `req-20261010T0${n}0000Z`;
  const STATE: NonNullable<MissionGetOutput["inFlight"]> = {
    at: at(10, 14),
    mission: { missionId: "mis-0000000001", code: "AIX", name: "AI Assistant ↔ xOne", state: "open", goal: "g", charterConfirmed: true, repos: [], mainId: "c41e2a0aa", mainHistory: [] },
    criteria: { met: 4, total: 9, open: [] },
    requests: [
      { requestId: R(1), workspaceId: "ws-ui", repo: "xspace-ai-assistant", topic: "G14 platform screens", workerId: "0545c7a11", state: "working", lastReport: { phase: "implementing", at: at(10, 5), line: "" }, followUpAt: null, waitingOn: null },
      { requestId: R(2), workspaceId: "ws-be", repo: "ai-assistant", topic: "Backend catalogue API", workerId: "733918b22", state: "waiting-owner", lastReport: { phase: "blocked", at: at(9, 58), line: "" }, followUpAt: null, waitingOn: null },
      { requestId: R(3), workspaceId: "ws-ui", repo: "xspace-ai-assistant", topic: "Open the MR", workerId: "9c01d7e33", state: "waiting-main", lastReport: { phase: "blocked", at: at(10, 9), line: "" }, followUpAt: null, waitingOn: null },
      { requestId: R(4), workspaceId: "ws-be", repo: "ai-assistant", topic: "Env template", workerId: "1a77f3044", state: "waiting-other", lastReport: { phase: "blocked", at: at(10, 1), line: "" }, followUpAt: null, waitingOn: R(1) },
      { requestId: R(5), workspaceId: "ws-ui", repo: "xspace-ai-assistant", topic: "13 English keys", workerId: "0989dc455", state: "finished", lastReport: { phase: "finished", at: at(9, 40), line: "" }, followUpAt: null, waitingOn: null },
    ],
    questions: [
      { id: `q:${R(2)}:Q1`, requestId: R(2), qn: "Q1", class: "scope", subject: null, decider: "owner", recommend: false, askedAt: at(9, 58), question: "Which tool list does the assistant use?", recommended: "a — Backend catalogue" },
      { id: `q:${R(3)}:Q2`, requestId: R(3), qn: "Q2", class: "release", subject: null, decider: "main", recommend: false, askedAt: at(10, 9), question: "Squash the commits before the MR?", recommended: "a — Squash" },
    ],
    asks: [
      { id: "m:mis-0000000001:3", askedAt: at(10, 10), question: "Commit .env.serve.local?", options: ["Commit", "Leave it untracked"], recommended: "b — Leave it untracked", byMain: true },
      { id: "m:mis-0000000001:4", askedAt: at(10, 11), question: "Merge mission AIAS (ai-assistant) into AIX", options: ["Merge it", "Keep as is"], recommended: "a — Merge it", byMain: false },
    ],
    links: [{ linkId: "link-1", route: "mission", kind: "worker", direction: "out", partner: "0545c7a ↔ 733918b", state: "waiting", waitingSince: at(9, 31), gist: "the catalogue endpoint's shape" }],
    owner: [],
    governor: [],
    journal: [],
    unknown: [],
  };
  const HISTORY = [
    { agentId: "2b8d0e4aa", from: at(8, 12), to: at(9, 12), reason: "created" },
    { agentId: "7f3a9b1aa", from: at(9, 12), to: at(10, 2), reason: "replaced" },
    { agentId: "c41e2a0aa", from: at(10, 2), to: null, reason: "handoff" },
  ];
  const RUNTIME: MissionGetOutput = { ...PAGE, inFlight: STATE, mainHistory: HISTORY };
  const later = new Date(2026, 9, 10, 9, 45);
  const view = missionPageOf(RUNTIME, new Date(2026, 9, 10, 10, 15));

  it("reads the Mains newest first, with when and why each changed; an older server shows neither card", () => {
    expect(view.mains).toEqual({
      count: "3 Mains since 2026-10-10 08:12",
      shortCount: "3 Mains",
      rows: [
        { agentId: "c41e2a0aa", short: "c41e2a0", from: "10:02", until: "now", why: "handoff — its context was full; this Main carries on", shortWhy: "handoff", current: true },
        { agentId: "7f3a9b1aa", short: "7f3a9b1", from: "09:12", until: "10:02", why: "replaced", shortWhy: "replaced", current: false },
        { agentId: "2b8d0e4aa", short: "2b8d0e4", from: "08:12", until: "09:12", why: "created with the mission", shortWhy: "created", current: false },
      ],
    });
    expect(missionPageOf(PAGE, later)).toMatchObject({ mains: null, inFlight: null });
  });

  it("reads each request's state and whom it waits on, the open questions by who decides, the Main's own asks and the live links", () => {
    const flight = view.inFlight!;
    expect(flight.meta).toBe("what the Main knows · read 10:14");
    expect(flight.requests.map((request) => [request.request, request.state.text, request.state.tone, request.lastReport])).toEqual([
      ["req-…010000Z", "working", "info", "implementing · 10:05"],
      ["req-…020000Z", "waiting for you · Q1", "warning", "blocked · 09:58"],
      ["req-…030000Z", "waiting for the Main · Q2", "warning", "blocked · 10:09"],
      ["req-…040000Z", "waiting for req-…010000Z", "plain", "blocked · 10:01"],
      ["req-…050000Z", "finished", "success", "finished · 09:40"],
    ]);
    expect(flight.requests[3]!.phoneState).toBe("waiting for G14 platform screens");
    expect(flight.restLine).toBe("+ 1 finished");
    expect(flight.questions.map((question) => [question.who.text, question.label, question.text, question.meta, question.yours])).toEqual([
      ["you decide", "Q1", "scope — Which tool list does the assistant use?", "recommended: a — Backend catalogue", true],
      ["the Main decides", "Q2", "release — Squash the commits before the MR?", "asked 10:09 · recommended: a — Squash", false],
    ]);
    // paseo-bm's own cards (a merge) are not the Main's asks.
    expect(flight.asks).toEqual([{ id: "m:mis-0000000001:3", text: "Commit .env.serve.local?", meta: "recommended: b — Leave it untracked · m:…:3" }]);
    expect(flight.links).toEqual([{ id: "link-1", who: "waiting 44 min", text: "0545c7a ↔ 733918b · the catalogue endpoint's shape" }]);
  });

  const actions = () => ({ back: vi.fn(), openMain: vi.fn(), ui: vi.fn(), saveRename: vi.fn(), close: vi.fn(), addRepos: vi.fn(), level: vi.fn(), confirmLevel: vi.fn(), memory: vi.fn(), openAgent: vi.fn(), openInbox: vi.fn() });
  const body = (compact: boolean, on = actions()) => renderTree(MissionPageBody({ page: view, ui: PAGE_UI_IDLE, addable: [], compact, on, styles, theme }));

  // Delivery line design §2.7 (mockup delivery-line.html, artboards I and J): a request chain in In flight.
  const CHAINED: NonNullable<MissionGetOutput["inFlight"]> = {
    ...STATE,
    requests: [
      { ...STATE.requests[0]!, requestId: R(6), topic: "Widget flows W13", continuationOf: R(5), continuedBy: null, chainPosition: 3 },
      { ...STATE.requests[1]!, continuationOf: "req-20261009T132118Z", continuedBy: null, chainPosition: 2 },
      { ...STATE.requests[4]!, topic: "Review and propose the feature", continuationOf: "req-20261009T090000Z", continuedBy: R(6), chainPosition: 2 },
    ],
  };
  const chained = missionPageOf({ ...RUNTIME, inFlight: CHAINED }, new Date(2026, 9, 10, 10, 15));

  it("reads a chain: continues <id> · nth of its chain on its newest request, finished → <id> on the one it continues (delivery line design §2.7)", () => {
    const flight = chained.inFlight!;
    expect(flight.requests.map((request) => [request.request, request.state.text, request.chain, request.phoneChain, request.next])).toEqual([
      ["req-…060000Z", "working", { request: "req-…050000Z", position: "3rd of its chain" }, "continues Review and propose the feature · 3rd", null],
      ["req-…020000Z", "waiting for you · Q1", { request: "req-…132118Z", position: null }, "continues req-…132118Z", null],
      ["req-…050000Z", "finished", null, null, "→ req-…060000Z"],
    ]);
    expect(flight.restLine).toBe("+ 1 finished");
    // An older server sends no chain fields.
    expect(view.inFlight!.requests.every((request) => request.chain === null && request.phoneChain === null && request.next === null)).toBe(true);
  });

  it("draws the chain as artboards I and J", () => {
    const wide = texts(renderTree(MissionPageBody({ page: chained, ui: PAGE_UI_IDLE, addable: [], compact: false, on: actions(), styles, theme })));
    for (const text of ["req-…060000Z Widget flows W13", "continues req-…050000Z · 3rd of its chain", "continues req-…132118Z", "finished → req-…060000Z"]) {
      expect(wide, text).toContain(text);
    }
    const phone = texts(renderTree(MissionPageBody({ page: chained, ui: PAGE_UI_IDLE, addable: [], compact: true, on: actions(), styles, theme })));
    for (const text of ["Widget flows W13 · working", "continues Review and propose the feature · 3rd", "continues req-…132118Z", "+ 1 finished"]) {
      expect(phone, text).toContain(text);
    }
    expect(phone.some((entry) => entry.includes("→ req-"))).toBe(false);
  });

  it("draws artboard G: the Main card under the title, In flight between the Workers and the contracts", () => {
    const on = actions();
    const nodes = body(false, on);
    const shown = texts(nodes);
    for (const text of [
      "Main", "3 Mains since", "Why it changed", "c41e2a0", "idle", "now", "handoff — its context was full; this Main carries on", "7f3a9b1", "replaced",
      "A previous Main is kept, never archived; its chat is read-only for mission work — its tools that write are refused.",
      "In flight", "what the Main knows · read 10:14", "Request · topic", "State", "Last report", "G14 platform screens", "waiting for you · Q1", "waiting for req-…010000Z", "implementing · 10:05",
      "Questions", "you decide", "the Main decides", "The Main asked you", "open", "Commit .env.serve.local?", "Links", "waiting 44 min", "0545c7a ↔ 733918b · the catalogue endpoint's shape",
    ]) {
      expect(shown.some((entry) => entry.includes(text)), text).toBe(true);
    }
    // Order: title, Main, stats, …, Workers, In flight, Contracts.
    const order = ["Open Main", "Why it changed", "Done criteria", "Workers by repository", "In flight", "Contracts between repositories"].map((text) => shown.findIndex((entry) => entry === text));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    pressByLabel(nodes, "Open the previous Main 7f3a9b1");
    expect(on.openAgent).toHaveBeenCalledWith("7f3a9b1aa");
    pressByLabel(nodes, "Answer Q1 in the Inbox");
    pressByLabel(nodes, "Answer m:mis-0000000001:3 in the Inbox");
    expect(on.openInbox).toHaveBeenCalledTimes(2);
    expect(pressables(nodes).some((node) => node.props["accessibilityLabel"] === "Answer Q2 in the Inbox")).toBe(false);
  });

  it("draws artboard H: the Main's lines and In flight's lines on a phone", () => {
    const shown = texts(body(true));
    for (const text of ["Main", "3 Mains", "c41e2a0 · since 10:02 · handoff", "7f3a9b1 · 09:12–10:02 · replaced", "+ 1 earlier", "In flight", "G14 platform screens", "waiting for G14 platform screens", "+ 1 finished", "You decide:", "The Main asked you:", "1 link waiting 44 min"]) {
      expect(shown.some((entry) => entry.includes(text)), text).toBe(true);
    }
    const order = ["Open Main", "Main", "Done", "In flight", "Charter"].map((text) => shown.findIndex((entry) => entry === text));
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });
});

describe("the mission page's Repositories card (delivery line design §4.9; mockup delivery-line.html, artboards I and J)", () => {
  const T = (h: number, m: number) => new Date(2026, 9, 20, h, m).toISOString();
  const LATER = new Date(2026, 9, 20, 12, 45);
  type Placement = NonNullable<MissionSummary["repos"][number]["placement"]>;
  const line = (over: Partial<Placement>): Placement => ({
    branch: "m/INO/xspace-ai-assistant",
    target: "develop",
    state: "ready",
    dirty: false,
    ahead: 0,
    behind: 0,
    lastCommitAt: null,
    pushed: null,
    mr: null,
    ci: null,
    readAt: T(12, 40),
    integration: { state: "none", at: null, decisionId: null },
    ...over,
  });
  const INO: MissionSummary = {
    ...AIX,
    code: "INO",
    repos: [
      { ...UI, placement: line({ dirty: true, ahead: 4, lastCommitAt: T(11, 52), pushed: true, mr: { url: "https://gitlab.example/x/-/merge_requests/42", state: "opened", mergeable: true }, ci: "success", integration: { state: "allowed", at: T(10, 42), decisionId: "m:mis-0123456789:1" } }) },
      { ...BE, placement: line({ branch: "m/INO/ai-assistant", ahead: 2, behind: 7, lastCommitAt: T(12, 5), readAt: T(12, 38), integration: { state: "waiting", at: null, decisionId: "m:mis-0123456789:2" } }) },
      { workspaceId: "ws-docs", name: "docs" },
    ],
  };
  const PLACED: MissionGetOutput = {
    ...PAGE,
    summary: INO,
    inFlight: {
      at: T(12, 40),
      mission: { missionId: INO.missionId, code: "INO", name: INO.name, state: "open", goal: "g", charterConfirmed: true, repos: [], mainId: null, mainHistory: [] },
      criteria: { met: 0, total: 0, open: [] },
      requests: [
        { requestId: "req-20261020T105259Z", workspaceId: "ws-ui", repo: "xspace-ai-assistant", topic: "Review and propose the feature", workerId: "6689326aa", state: "finished", lastReport: { phase: "finished", at: T(11, 58), line: "" }, followUpAt: null, waitingOn: null, committed: true, verified: "verified", commit: "a1b2c3d4e5f6" },
        { requestId: "req-20261020T110000Z", workspaceId: "ws-be", repo: "ai-assistant", topic: "Env template", workerId: "112e496aa", state: "finished", lastReport: { phase: "finished", at: T(12, 0), line: "" }, followUpAt: null, waitingOn: null, committed: false, verified: null, commit: null },
      ],
      questions: [],
      asks: [],
      links: [],
      owner: [],
      governor: [],
      journal: [],
      unknown: [],
    },
  };
  const view = missionPageOf(PLACED, LATER);

  it("reads each repo's line in the mockup's words; a repo with no worktree has no row, a mission with none no card", () => {
    expect(view.repositories!.meta).toBe("each mission writes on its own branch · read 12:40");
    expect(view.repositories!.rows.map((row) => [row.name, row.branch, row.target, row.shortBranch, row.counts, row.dirty, row.lastCommit, row.mr, row.ci, row.push])).toEqual([
      [
        "xspace-ai-assistant",
        "m/INO/xspace-ai-assistant",
        "develop",
        "m/INO/…",
        "↑4 ↓0",
        { text: "● uncommitted", tone: "warning" },
        "last commit 11:52",
        { text: "!42 open", short: "!42", tone: "info", url: "https://gitlab.example/x/-/merge_requests/42" },
        { text: "CI passed", tone: "success" },
        { text: "allowed since 10:42", tone: "plain", phone: "Push & MR allowed", action: "revoke", decisionId: "m:mis-0123456789:1" },
      ],
      [
        "ai-assistant",
        "m/INO/ai-assistant",
        "develop",
        "m/INO/…",
        "↑2 ↓7",
        { text: "clean", tone: "plain" },
        "last commit 12:05",
        null,
        null,
        { text: "waiting for you", tone: "warning", phone: "Push & MR: waiting for you", action: "answer", decisionId: "m:mis-0123456789:2" },
      ],
    ]);
    expect(missionPageOf(PAGE, LATER).repositories).toBeNull();
    expect(repositoriesOf({ code: "INO", repos: [{ ...UI, placement: line({ readAt: null, dirty: null, ahead: null, behind: null }) }] }, LATER)).toEqual({
      meta: "each mission writes on its own branch",
      mrHeader: "Merge request · CI",
      rows: [expect.objectContaining({ counts: "not read yet", dirty: null, lastCommit: null })],
    });
  });

  it("names the merge request, its state and CI, and push and merge request, in the mockup's words", () => {
    expect([mrNumberOf("https://gitlab.example/x/-/merge_requests/42"), mrNumberOf("https://github.com/o/r/pull/7"), mrNumberOf("https://forge.example/x")]).toEqual(["!42", "#7", "MR"]);
    const rowOf = (over: Partial<Placement>) => repositoriesOf({ code: "INO", repos: [{ ...UI, placement: line(over) }] }, LATER)!.rows[0]!;
    const mr = (state: string | null, mergeable: boolean | null) => rowOf({ mr: { url: "https://gitlab.example/x/-/merge_requests/9", state, mergeable } }).mr!.text;
    expect([mr("opened", null), mr("merged", null), mr("opened", false), mr(null, false)]).toEqual(["!9 open", "!9 merged", "!9 conflicting", "!9 conflicting"]);
    expect(["success", "failure", "pending", "not-run", "none"].map((ci) => rowOf({ ci }).ci?.text ?? null)).toEqual(["CI passed", "CI failed", "CI running", "CI not run", null]);
    expect(rowOf({ integration: { state: "not-now", at: null, decisionId: "m:x:1" } }).push).toMatchObject({ text: "not now", phone: "Push & MR: not now", action: "ask" });
    expect(rowOf({ integration: { state: "revoked", at: T(12, 10), decisionId: "m:x:1" } }).push).toMatchObject({ text: "revoked 12:10", phone: "Push & MR: revoked", action: "ask" });
    expect(rowOf({ integration: { state: "none", at: null, decisionId: null } }).push).toMatchObject({ text: "—", phone: null, action: null });
    expect(rowOf({ branch: "feature/x" }).shortBranch).toBe("feature/x");
  });

  it("with integration.ci off (ADR-036 §17.1), the merge request without CI; on, or from an older server, with it", () => {
    const repos = [{ ...UI, placement: line({ ci: "failure", mr: { url: "https://gitlab.example/x/-/merge_requests/9", state: "opened", mergeable: null } }) }];
    const off = repositoriesOf({ code: "INO", repos, ci: "off" }, LATER)!;
    expect(off.mrHeader).toBe("Merge request");
    expect(off.rows[0]!.ci).toBeNull();
    expect(off.rows[0]!.mr?.text).toBe("!9 open");
    for (const ci of ["on", undefined] as const) {
      const shown = repositoriesOf({ code: "INO", repos, ...(ci === undefined ? {} : { ci }) }, LATER)!;
      expect(shown.mrHeader).toBe("Merge request · CI");
      expect(shown.rows[0]!.ci).toEqual({ text: "CI failed", tone: "danger" });
    }
  });

  it("reads a committed finish's commit in In flight's Last report (artboard I)", () => {
    expect(view.inFlight!.requests.map((request) => [request.lastReport, request.commit])).toEqual([
      ["finished · committed a1b2c3d · 11:58", "a1b2c3d"],
      ["finished · 12:00", null],
    ]);
    expect(texts(draw(false))).toContain("finished · committed a1b2c3d · 11:58");
  });

  const actions = () => ({ back: vi.fn(), openMain: vi.fn(), ui: vi.fn(), saveRename: vi.fn(), close: vi.fn(), addRepos: vi.fn(), level: vi.fn(), confirmLevel: vi.fn(), memory: vi.fn(), openAgent: vi.fn(), openInbox: vi.fn(), revoke: vi.fn(), askAgain: vi.fn() });
  const draw = (compact: boolean, on = actions(), ui: Record<string, unknown> = {}) => renderTree(MissionPageBody({ page: view, ui: { ...PAGE_UI_IDLE, ...ui }, addable: [], compact, on, styles, theme }));
  const byLabel = (nodes: Array<RNode | string>, label: string) => allNodes(nodes).find((node) => node.props["accessibilityLabel"] === label);

  it("draws artboard I: the table between the Workers and In flight; Revoke asks first, Answer opens the Inbox", () => {
    const on = actions();
    const nodes = draw(false, on);
    const shown = texts(nodes);
    for (const text of [
      "Repositories", "each mission writes on its own branch · read 12:40", "Repository", "Branch → integration", "State", "Merge request · CI", "Push & merge request",
      "m/INO/xspace-ai-assistant → develop", "↑4 ↓0 · ● uncommitted", "last commit 11:52", "!42 open · CI passed", "allowed since 10:42", "Revoke",
      "↑2 ↓7 · clean", "no merge request yet", "waiting for you", "Answer",
      "↑ commits on the mission branch not yet in the integration branch · ↓ commits of the integration branch not yet merged into it. Merging stays on GitLab. A worktree is removed only by you, when the mission closes.",
    ]) {
      expect(shown, text).toContain(text);
    }
    // The charter's own "Repositories" label comes first: the card is found by its meta.
    const order = ["Workers by repository", "each mission writes on its own branch · read 12:40", "In flight"].map((text) => shown.indexOf(text));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    pressByLabel(nodes, "Revoke push and merge request for xspace-ai-assistant");
    expect(on.ui).toHaveBeenCalledWith({ confirm: { kind: "revoke", repo: "ws-ui" }, menu: false, rename: null });
    expect(on.revoke).not.toHaveBeenCalled();
    pressByLabel(nodes, "Answer push and merge request for ai-assistant in the Inbox");
    expect(on.openInbox).toHaveBeenCalledTimes(1);

    const confirming = draw(false, on, { confirm: { kind: "revoke", repo: "ws-ui" } });
    expect(texts(confirming)).toContain("Revoke push and merge request for xspace-ai-assistant?");
    pressByLabel(confirming, "Revoke");
    expect(on.revoke).toHaveBeenCalledWith("ws-ui");
    pressByLabel(confirming, "Cancel");
    expect(on.ui).toHaveBeenLastCalledWith({ confirm: null });
  });

  it("draws artboard J: each repo's lines on a phone, Revoke and Answer as words", () => {
    const on = actions();
    const nodes = draw(true, on);
    const shown = texts(nodes);
    for (const text of ["Repositories", "xspace-ai-assistant · ↑4 ↓0 · ● uncommitted", "m/INO/… → develop · !42 · CI passed", "Push & MR allowed · Revoke", "ai-assistant · ↑2 ↓7 · clean", "Push & MR: waiting for you · Answer"]) {
      expect(shown, text).toContain(text);
    }
    // The second repo has no merge request and no CI: no branch line (artboard J).
    expect(shown.filter((entry) => entry.startsWith("m/INO/… → "))).toHaveLength(1);
    const order = ["Done", "Repositories", "In flight"].map((text) => shown.indexOf(text));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    (byLabel(nodes, "Revoke push and merge request for xspace-ai-assistant")!.props["onPress"] as () => void)();
    expect(on.ui).toHaveBeenCalledWith({ confirm: { kind: "revoke", repo: "ws-ui" }, menu: false, rename: null });
    (byLabel(nodes, "Answer push and merge request for ai-assistant in the Inbox")!.props["onPress"] as () => void)();
    expect(on.openInbox).toHaveBeenCalledTimes(1);
    expect(texts(draw(true, on, { confirm: { kind: "revoke", repo: "ws-ui" } }))).toContain("Revoke push and merge request for xspace-ai-assistant?");
  });

  it("draws no CI with integration.ci off (ADR-036 §17.1): the column reads Merge request, the phone's branch line the merge request alone", () => {
    const page = missionPageOf({ ...PLACED, summary: { ...INO, ci: "off" } }, LATER);
    const wide = texts(renderTree(MissionPageBody({ page, ui: PAGE_UI_IDLE, addable: [], compact: false, on: actions(), styles, theme })));
    expect(wide).toContain("Merge request");
    expect(wide).toContain("!42 open");
    expect(wide).not.toContain("Merge request · CI");
    expect(wide.filter((text) => /\bCI\b/.test(text))).toEqual([]);
    const phone = texts(renderTree(MissionPageBody({ page, ui: PAGE_UI_IDLE, addable: [], compact: true, on: actions(), styles, theme })));
    expect(phone).toContain("m/INO/… → develop · !42");
    expect(phone.filter((text) => /\bCI\b/.test(text))).toEqual([]);
  });

  it("offers Ask me again after not now or a revoke (§4.3), on a wide screen and a phone; none on a closed mission", () => {
    const repos = (state: "not-now" | "revoked") => [{ ...UI, placement: line({ integration: { state, at: state === "revoked" ? T(12, 10) : null, decisionId: "m:mis-0123456789:1" } }) }];
    for (const state of ["not-now", "revoked"] as const) {
      const page = missionPageOf({ ...PLACED, summary: { ...INO, repos: repos(state) } }, LATER);
      for (const compact of [false, true]) {
        const on = actions();
        const nodes = renderTree(MissionPageBody({ page, ui: PAGE_UI_IDLE, addable: [], compact, on, styles, theme }));
        const shown = texts(nodes);
        expect(shown, `${state} ${compact}`).toContain(compact ? `Push & MR: ${state === "not-now" ? "not now" : "revoked"} · Ask me again` : state === "not-now" ? "not now" : "revoked 12:10");
        (byLabel(nodes, "Ask me again about push and merge request for xspace-ai-assistant")!.props["onPress"] as () => void)();
        expect(on.askAgain).toHaveBeenCalledWith("ws-ui");
      }
      const closed = missionPageOf({ ...PLACED, summary: { ...INO, state: "closed", closedAt: T(12, 0), repos: repos(state) } }, LATER);
      expect(byLabel(renderTree(MissionPageBody({ page: closed, ui: PAGE_UI_IDLE, addable: [], compact: false, on: actions(), styles, theme })), "Ask me again about push and merge request for xspace-ai-assistant")).toBeUndefined();
    }
  });

  it("asks before a revoke, in place", () => {
    expect(revokeIntegrationDialog("INO", { name: "xspace-ai-assistant", branch: "m/INO/xspace-ai-assistant", target: "develop" })).toEqual({
      title: "Revoke push and merge request for xspace-ai-assistant?",
      body: "INO's Workers stop pushing m/INO/xspace-ai-assistant and updating its merge request into develop; they go on committing on the branch. The merge request stays as it is.",
      bodyTone: "plain",
      confirmLabel: "Revoke",
      confirmKind: "danger",
      cancelLabel: "Cancel",
      defaultAction: "cancel",
    });
  });
});
