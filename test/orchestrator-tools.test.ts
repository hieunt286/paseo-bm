import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { REDACTED } from "../plugin/server/collector";
import { createOrchestratorTools, type OrchestratorToolsDeps } from "../plugin/server/orchestrator-tools";
import { AGENT_MESSAGE_MAX_CHARS, PROJECTS_BOUNDED_NOTE, REQUEST_BOUNDED_NOTE, agentMessagesBoundedNote } from "../plugin/server/orchestrator-read-tools";
import {
  SEND_REFUSED_MESSAGE,
  DIRECT_REFUSED_MESSAGE,
  needsDecisionMessageOf,
  commandClassesOf,
  notDelegatedRefusalOf,
  policyCoverOf,
  storedAnswerRefusalOf,
} from "../plugin/server/command-authority";
import { GIT_READ_ONLY_PREFIX, REPO_OUTPUT_MAX_CHARS, type GitRunner } from "../plugin/server/repo-tool";
import type { ServerToolResult } from "../plugin/server/orchestrator-tool-context";
import { ASK_OWNER_OPTION_KEYS } from "../plugin/server/orchestrator-decide-tools";
import { firstLine } from "../plugin/server/request-trace";
import { COMMAND_LIMIT_MESSAGE, COMMAND_LIMIT_PER_REQUEST, INTERRUPT_REFUSED_MESSAGE } from "../plugin/server/command-send";
import { ORCHESTRATOR_FIRST_PROMPT, ORCHESTRATOR_FIRST_PROMPT_START, isOwnerWord } from "../plugin/server/orchestrator-agent";
import { createOrchestratorStore } from "../plugin/server/orchestrator-store";
import { createAlertStore } from "../plugin/server/alert-store";
import { createAutonomyStore } from "../plugin/server/autonomy-store";
import { EMPTY_AUTONOMY_POLICY, LEVELS, decideRefusalOf, predictionRefusalOf, type AutonomyPolicy } from "../plugin/shared/autonomy";

/** Cruise's classes (level 2, ADR-025), riskiest first: every class but release, data, security and cost. */
const CRUISE = DECISION_CLASSES.filter((decisionClass) => LEVELS[2]!.delegated.includes(decisionClass));
import { clearDecisionStoreCache, createDecisionStore } from "../plugin/server/decision-store";
import { handleDecisionsAnswer, handleDecisionsGet, handleDecisionsList, settledByKind } from "../plugin/server/decision-rpc";
import { DECISION_UI_IDLE, decisionCardView } from "../plugin/client/chat-card-decision";
import { inboxView } from "../plugin/client/inbox-model";
import { createOrchestratorDecisionDelivery } from "../plugin/server/orchestrator-decisions";
import { createPrecedentStore } from "../plugin/server/precedent-store";
import { isPluginNotice } from "../plugin/shared/notices";
import {
  CONFIRM_EFFECTS,
  DECISION_CLASSES,
  GRANT_TTL_MS,
  MAX_DECISION_TEXT_CHARS,
  answerDecision,
  expireDecision,
  markNeedsConfirmation,
  supersedeDecision,
  withdrawDecision,
  type Decision,
  type DecisionClass,
  type Effect,
} from "../plugin/shared/decisions";
import { makeDecision, storedOrchestratorAnswer } from "./helpers/decisions";
import { appendRecord, clearTraceStoreCache } from "../plugin/server/trace-store";
import type { AgentFacts } from "../plugin/server/traces";
import type { TraceRecord } from "../plugin/shared/contracts";
import { MAX_PROPOSAL_COMMAND_CHARS, RULE_IDS } from "../plugin/shared/orchestrator";
import { commandBlockOf, parseCommandBlock, type CommandInput } from "../plugin/shared/orchestrator-command";
import { AGENT_MESSAGES_SUMMARY, ORCHESTRATOR_SERVER_TOOLS, REQUEST_SUMMARY_MAX_CHARS } from "../plugin/shared/bm-tools";
import { REQUEST_MAX_CHARS, TRUNCATED_MARKER } from "../plugin/server/request-render";
import { MANAGER, REVIEWER, WORKER, WORKSPACE_DIRECTORY, WORKSPACE_ID, at, clean, msg, smallWithBead, turn } from "./fixtures/orchestrator-traces";
import { fakePaseo } from "./helpers/fake-paseo";

/**
 * The Orchestrator's tools (Orchestrator design §5.2–§5.5, WP-603), run on a
 * temporary data folder named by `PASEO_BM_HOME` with a fake Paseo SDK —
 * never the real HOME or a daemon. The endpoint's secret path and the hook's
 * part are in plugin-agent-tools.test.ts and plugin-role-hook.test.ts.
 */

const NOW = new Date("2026-09-26T12:00:00.000Z");
const SECRET = "tok-very-secret-123";
const OTHER_WORKSPACE = "wks_other";

let root: string;
let home: string;
let deps: OrchestratorToolsDeps;
let ids: number;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "bm-orchestrator-tools-"));
  home = join(root, "data");
  ids = 0;
  deps = {
    env: { PASEO_BM_HOME: home },
    homedir: () => root,
    now: () => NOW,
    redactEnv: {},
    newId: () => `assessment-${++ids}`,
    store: { now: () => NOW, newId: () => `proposal-${++ids}` },
  };
  clearTraceStoreCache();
});

afterEach(() => {
  clearTraceStoreCache();
  rmSync(root, { recursive: true, force: true });
});

const location = () => ({ tracesDir: join(home, "traces") });

async function store(records: readonly TraceRecord[]): Promise<void> {
  for (const record of records) await appendRecord(location(), record);
}

/** A live agent as `agents.list` returns it. */
function snapshotOf(facts: AgentFacts, overrides: Record<string, unknown> = {}): Record<string, unknown> & { id: string } {
  const labels: Record<string, string> = { "bm.role": facts.role };
  if (facts.parentAgentId !== null) labels["paseo.parent-agent-id"] = facts.parentAgentId;
  if (facts.requestIdLabel !== null) labels["bm.requestId"] = facts.requestIdLabel;
  return {
    id: facts.id,
    provider: `bm-${facts.role}`,
    status: facts.status,
    workspaceId: WORKSPACE_ID,
    labels,
    title: `Beads ${facts.role}`,
    ...(facts.createdAt === null ? {} : { createdAt: facts.createdAt }),
    ...overrides,
  };
}

type Entry = { item: Record<string, unknown>; timestamp: string };

/**
 * The shared fake SDK with these agents and the one workspace. `timelines`
 * holds each agent's pages, oldest page first; the fake pages back from the
 * tail as Paseo does. Nothing that sends, creates or archives is expected to be
 * called: the tests check the fake's records of them.
 */
function daemonWith(
  agents: ReadonlyArray<Record<string, unknown> & { id: string }>,
  timelines: Record<string, Entry[][]> = {},
  workspaces: Array<Record<string, unknown>> = [{ id: WORKSPACE_ID, directory: WORKSPACE_DIRECTORY }],
) {
  return fakePaseo({ agents, workspaces, timelines: Object.fromEntries(Object.entries(timelines).map(([id, pages]) => [id, { pages }])) });
}

function toolsWith(paseo: unknown) {
  const tools = createOrchestratorTools(deps);
  tools.usePaseo(paseo);
  return tools;
}

/** The JSON after a tool's first line, or the whole text when it starts with JSON. */
function jsonOf(result: ServerToolResult): Record<string, unknown> {
  const start = result.text.indexOf("{");
  return JSON.parse(result.text.slice(start)) as Record<string, unknown>;
}

/**
 * The owner's policy with every class that may be delegated delegated for the
 * project (autonomy design §B.9): what authorises a command of the
 * Orchestrator's own now that Autopilot is retired (§B.8). A command declaring
 * none authorises as `policy:reversible-technical`.
 */
function delegateAll(workspaceId = WORKSPACE_ID): void {
  const autonomy = createAutonomyStore(home);
  for (const decisionClass of CRUISE) autonomy.set({ workspaceId, class: decisionClass, mode: "delegate", confirmed: true }, NOW.toISOString());
}

/** A `settings.json` as an earlier build left it: Autopilot on for the project, Allow… every category. Nothing reads it any more (autonomy design §B.8). */
function earlierAutopilotSettings(workspaceId = WORKSPACE_ID): void {
  mkdirSync(join(home, "orchestrator"), { recursive: true });
  writeFileSync(
    join(home, "orchestrator", "settings.json"),
    JSON.stringify({ version: 3, autopilot: { [workspaceId]: { enabled: true, since: NOW.toISOString(), by: "tab", allow: ["security", "release", "data", "cost", "dependency"] } } }),
  );
}

function filesUnder(dir: string): string[] {
  try {
    return readdirSync(dir, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => join(entry.parentPath, entry.name));
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------

describe("bm_projects (design §5.2)", () => {
  it("lists each project with activity in the period: its Managers, its recent requests and their open stalls", async () => {
    const fixture = smallWithBead();
    await store(fixture.records.map((record) => ({ ...record, sent: record.sent.map((sent) => (sent.origin === "user" ? { ...sent, text: `Use --token ${SECRET} to fix the dates.\nSecond line.` } : sent)) })));
    await store([
      turn({ workspaceId: OTHER_WORKSPACE, agentId: "agent-old", requestId: "req-20260921T100000Z", at: "2026-09-21T10:00:00.000Z", endedAt: "2026-09-21T10:00:00.000Z", sent: [msg("agent-old", "2026-09-21T10:00:00.000Z", "An old request", "user")] }),
    ]);
    // Stalled requests are Inbox alerts (autonomy design §A.8).
    const alerts = createAlertStore(home, { now: () => NOW });
    alerts.raise({ workspaceId: WORKSPACE_ID, kind: "request-stalled", subject: fixture.requestId, detail: "idle-unfinished" });
    alerts.raise({ workspaceId: WORKSPACE_ID, kind: "request-stalled", subject: "req-20260926T090000Z", detail: "idle-unfinished" });
    const { paseo, sends, creates } = daemonWith(fixture.agents.map((facts) => snapshotOf(facts)));

    const result = await toolsWith(paseo).call("bm_projects", { detail: "full" });

    expect(result.ok).toBe(true);
    const answer = jsonOf(result) as { sinceHours: number; projects: Array<Record<string, unknown>> };
    expect(answer.sinceHours).toBe(24);
    expect(answer.projects).toHaveLength(1);
    expect(answer.projects[0]).toMatchObject({
      workspaceId: WORKSPACE_ID,
      label: "invoice-app",
      directory: WORKSPACE_DIRECTORY,
      lastActivityAt: at(3, 20),
      managers: [{ id: MANAGER, title: "Beads manager", status: "idle" }],
      requests: [
        {
          requestId: fixture.requestId,
          request: `Use --token ${REDACTED} to fix the dates.`,
          managerId: MANAGER,
          tier: "Small",
          state: "completed",
          lastActivityAt: at(3, 20),
          waitingSince: null,
          stalls: [{ situation: "idle-unfinished", since: NOW.toISOString() }],
        },
      ],
    });
    expect(result.text).not.toContain(SECRET);

    // A week back, the other project's old request is in too.
    const week = jsonOf(await toolsWith(paseo).call("bm_projects", { sinceHours: 168, detail: "full" })) as { projects: Array<{ workspaceId: string; label: string }> };
    expect(week.projects.map((project) => project.workspaceId)).toEqual([WORKSPACE_ID, OTHER_WORKSPACE]);
    expect(week.projects[1]!.label).toBe(OTHER_WORKSPACE);
    expect(sends).toEqual([]);
    expect(creates).toEqual([]);
  });

  it("says when a request waits for the user, and keeps at most 10 requests per project, newest first", async () => {
    const records: TraceRecord[] = Array.from({ length: 12 }, (_, index) =>
      turn({
        requestId: `req-20260926T1000${String(index).padStart(2, "0")}Z`,
        turnId: `m-${index}`,
        at: at(index),
        endedAt: at(index),
        sent: [msg(MANAGER, at(index), `Request ${index}`, "user")],
      }),
    );
    records.push(
      turn({
        agentId: WORKER,
        role: "worker",
        parentAgentId: MANAGER,
        requestId: "req-20260926T100011Z",
        turnId: "w-11",
        at: at(30),
        endedAt: at(30),
        reports: [{ ...smallWithBead().records[2]!.reports[0]!, requestId: "req-20260926T100011Z", phase: "blocked", at: at(30) }],
      }),
    );
    await store(records);
    const { paseo } = daemonWith([snapshotOf(clean().agents[0]!), snapshotOf(clean().agents[1]!, { labels: { "bm.role": "worker", "bm.requestId": "req-20260926T100011Z" } })]);

    const answer = jsonOf(await toolsWith(paseo).call("bm_projects", { sinceHours: 24, detail: "full" })) as { projects: Array<{ requests: Array<{ requestId: string; waitingSince: string | null }> }> };

    const requests = answer.projects[0]!.requests;
    expect(requests).toHaveLength(10);
    expect(requests[0]).toMatchObject({ requestId: "req-20260926T100011Z", waitingSince: at(30) });
    expect(requests.map((request) => request.requestId)).not.toContain("req-20260926T100000Z");
  });

  it("refuses a period outside 1-168 hours, and answers nothing without a Paseo handle", async () => {
    const { paseo } = daemonWith([]);
    const tools = toolsWith(paseo);
    for (const sinceHours of [0, 169, 1.5, "24"]) {
      const result = await tools.call("bm_projects", { sinceHours });
      expect(result.ok).toBe(false);
      expect(result.text).toMatch(/^The call was refused\. Fix these and call bm_projects again:\n- input\.sinceHours: /);
    }
    expect((await tools.call("bm_projects", { since: 3 })).text).toContain("- input.since: is not a field of this tool");
    const without = await createOrchestratorTools(deps).call("bm_projects", {});
    expect(without).toEqual({ ok: false, text: "Refused: paseo-bm has no connection to Paseo yet; try again in a moment." });
  });
});

describe("bm_request (design §5.2)", () => {
  it("returns the request's content, redacted", async () => {
    const fixture = smallWithBead();
    await store(fixture.records.map((record) => ({ ...record, received: record.received.map((reply) => ({ ...reply, text: `${reply.text} --password ${SECRET}` })) })));
    const { paseo, sends } = daemonWith(fixture.agents.map((facts) => snapshotOf(facts)));
    const tools = toolsWith(paseo);

    const result = await tools.call("bm_request", { workspaceId: WORKSPACE_ID, requestId: fixture.requestId });

    expect(result.ok).toBe(true);
    expect(result.text).toMatch(/^# The request\n/);
    expect(result.text).toContain(`requestId: ${fixture.requestId}`);
    expect(result.text).toContain(`--password ${REDACTED}`);
    expect(result.text).not.toContain(SECRET);
    // Found by its trace id as well.
    const byTrace = await tools.call("bm_request", { workspaceId: WORKSPACE_ID, requestId: fixture.input.traceId });
    expect(byTrace.text).toBe(result.text);
    expect(sends).toEqual([]);
  });

  it("refuses an unknown request, and a workspace id the store would refuse", async () => {
    await store(smallWithBead().records);
    const { paseo } = daemonWith([]);
    const tools = toolsWith(paseo);
    expect(await tools.call("bm_request", { workspaceId: WORKSPACE_ID, requestId: "req-20260101T000000Z" })).toEqual({
      ok: false,
      text: `Refused: no request req-20260101T000000Z in project ${WORKSPACE_ID}; use the requestId (or traceId) bm_projects gave.`,
    });
    const escape = await tools.call("bm_request", { workspaceId: "../x", requestId: "req-1" });
    expect(escape.ok).toBe(false);
    expect(escape.text).toContain("- input.workspaceId: must match");
  });
});

describe("bm_agent_messages (design §5.2)", () => {
  const long = `Q2: ${"which export format? ".repeat(700)}the end`;
  const timeline: Entry[][] = [
    [
      { item: { type: "user_message", text: "Add a PDF export.", clientMessageId: "c-1" }, timestamp: at(0, 20) },
      { item: { type: "assistant_message", text: "Handing it ", messageId: "a-1" }, timestamp: at(0, 30) },
    ],
    [
      { item: { type: "assistant_message", text: "to the Worker.", messageId: "a-1" }, timestamp: at(0, 31) },
      { item: { type: "tool_call", name: "send_agent_prompt" }, timestamp: at(0, 32) },
      { item: { type: "user_message", text: `BM-REPORT\nphase: blocked\n${long}` }, timestamp: at(1) },
      { item: { type: "user_message", text: "BM-FALLBACK the Worker stopped", clientMessageId: "c-2" }, timestamp: at(2) },
      { item: { type: "user_message", text: `My token is --token ${SECRET}`, clientMessageId: "c-3" }, timestamp: at(3) },
    ],
  ];

  it("returns the agent's recent messages oldest first, redacted, each at most 12,000 characters, reading only that agent", async () => {
    const fixture = clean();
    const { paseo, refetches, sends } = daemonWith(fixture.agents.map((facts) => snapshotOf(facts)), { [MANAGER]: timeline });

    const result = await toolsWith(paseo).call("bm_agent_messages", { agentId: MANAGER, detail: "full" });

    expect(result.ok).toBe(true);
    // Full detail: today's content, and no bounded note.
    expect(result.text.startsWith("{")).toBe(true);
    const answer = jsonOf(result) as { agent: Record<string, unknown>; messages: Array<{ at: string; from: string; text: string; truncated: boolean }> };
    expect(answer.agent).toMatchObject({ id: MANAGER, role: "manager", workspaceId: WORKSPACE_ID });
    expect(answer.messages.map((message) => [message.from, message.at])).toEqual([
      ["user", at(0, 20)],
      ["self", at(0, 30)],
      ["agent", at(1)],
      ["plugin", at(2)],
      ["user", at(3)],
    ]);
    expect(answer.messages[1]!.text).toBe("Handing it to the Worker.");
    expect(answer.messages[2]!.truncated).toBe(true);
    expect(AGENT_MESSAGE_MAX_CHARS).toBe(12_000);
    expect(Array.from(answer.messages[2]!.text).length).toBeLessThanOrEqual(AGENT_MESSAGE_MAX_CHARS);
    // A question of several thousand characters comes back whole (design §6A: was cut at 2,000).
    expect(Array.from(answer.messages[2]!.text).length).toBeGreaterThan(10_000);
    expect(answer.messages[2]!.text).toMatch(/^BM-REPORT\nphase: blocked\nQ2: /);
    expect(answer.messages[2]!.text).toMatch(/the end$/);
    expect(answer.messages[4]!.text).toBe(`My token is --token ${REDACTED}`);
    expect(result.text).not.toContain(SECRET);
    expect(new Set(refetches.map(({ id }) => id))).toEqual(new Set([MANAGER]));
    expect(sends).toEqual([]);

    const two = jsonOf(await toolsWith(paseo).call("bm_agent_messages", { agentId: MANAGER, limit: 2, detail: "full" })) as { messages: Array<{ at: string }> };
    expect(two.messages.map((message) => message.at)).toEqual([at(2), at(3)]);
  });

  it("refuses an agent that is not a paseo-bm Manager, Worker or Reviewer by its provider, and reads nothing of it", async () => {
    const fixture = clean();
    const others = [
      { id: "agent-claude", provider: "claude", status: "idle", workspaceId: WORKSPACE_ID, labels: {} },
      { id: "agent-labelled", provider: "claude/opus", status: "idle", workspaceId: WORKSPACE_ID, labels: { "bm.role": "worker" } },
      { id: "agent-orchestrator", provider: "bm-orchestrator", status: "idle", workspaceId: "wks_home", labels: { "bm.role": "orchestrator" } },
    ];
    const { paseo, refetches } = daemonWith([...fixture.agents.map((facts) => snapshotOf(facts)), ...others], {
      "agent-claude": timeline,
      "agent-labelled": timeline,
      "agent-orchestrator": timeline,
    });
    const tools = toolsWith(paseo);
    for (const agentId of ["agent-claude", "agent-labelled", "agent-orchestrator", "agent-gone"]) {
      const result = await tools.call("bm_agent_messages", { agentId });
      expect(result.ok).toBe(false);
      expect(result.text).toBe(`Refused: ${agentId} is not a paseo-bm agent; only a Manager, Worker or Reviewer of paseo-bm can be read.`);
    }
    expect(refetches).toEqual([]);
    // The Worker and the Reviewer are readable.
    for (const agentId of [WORKER, REVIEWER]) expect((await tools.call("bm_agent_messages", { agentId })).ok).toBe(true);
    expect((await tools.call("bm_agent_messages", { agentId: MANAGER, limit: 51 })).text).toContain("- input.limit: must be at most 50");
  });
});

describe("bounded reads by default (autonomy design §A.9)", () => {
  const chars = (text: string) => Array.from(text).length;

  it("bm_request: at most 4,000 characters with the note first when a message was cut, redacted before the cut; full keeps today's content", async () => {
    const fixture = smallWithBead();
    const long = `${"The Manager explains the plan. ".repeat(20)}--password ${SECRET} ${"and continues. ".repeat(300)}the end.`;
    await store(fixture.records.map((record) => ({ ...record, received: record.received.map((reply) => ({ ...reply, text: long })) })));
    const { paseo, sends } = daemonWith(fixture.agents.map((facts) => snapshotOf(facts)));
    const tools = toolsWith(paseo);

    const summary = await tools.call("bm_request", { workspaceId: WORKSPACE_ID, requestId: fixture.requestId });
    expect(summary.ok).toBe(true);
    expect(REQUEST_SUMMARY_MAX_CHARS).toBe(4_000);
    expect(chars(summary.text)).toBeLessThanOrEqual(REQUEST_SUMMARY_MAX_CHARS);
    expect(summary.text.split("\n")[0]).toBe(REQUEST_BOUNDED_NOTE);
    expect(summary.text.split("\n")[1]).toBe("# The request");
    expect(summary.text).toContain(TRUNCATED_MARKER);
    expect(summary.text).toContain(`requestId: ${fixture.requestId}`);
    expect(summary.text).not.toContain(SECRET);
    expect(summary.text).not.toContain(SECRET.slice(0, 8));

    const full = await tools.call("bm_request", { workspaceId: WORKSPACE_ID, requestId: fixture.requestId, detail: "full" });
    expect(full.ok).toBe(true);
    expect(full.text).toMatch(/^# The request\n/);
    expect(full.text).not.toContain(REQUEST_BOUNDED_NOTE);
    expect(chars(full.text)).toBeGreaterThan(REQUEST_SUMMARY_MAX_CHARS);
    expect(REQUEST_MAX_CHARS).toBe(60_000);
    expect(chars(full.text)).toBeLessThanOrEqual(REQUEST_MAX_CHARS);
    expect(full.text).toContain(`--password ${REDACTED} and continues.`);
    expect(full.text).not.toContain(SECRET);
    expect(sends).toEqual([]);
  });

  it("bm_request: no note when nothing was cut; the same text as full", async () => {
    const fixture = smallWithBead();
    await store(fixture.records);
    const { paseo } = daemonWith(fixture.agents.map((facts) => snapshotOf(facts)));
    const tools = toolsWith(paseo);
    const summary = await tools.call("bm_request", { workspaceId: WORKSPACE_ID, requestId: fixture.requestId });
    expect(summary.text).toMatch(/^# The request\n/);
    expect(summary.text).not.toContain(REQUEST_BOUNDED_NOTE);
    expect(summary.text).toBe((await tools.call("bm_request", { workspaceId: WORKSPACE_ID, requestId: fixture.requestId, detail: "full" })).text);
  });

  it("bm_agent_messages: at most 5 messages of 1,500 characters, the note first only when the summary cut something", async () => {
    const short = (index: number): Entry => ({ item: { type: "user_message", text: `Message ${index}`, clientMessageId: `c-${index}` }, timestamp: at(index) });
    const long = `Q1: ${"which export format? ".repeat(200)}--token ${SECRET} the end`;
    const fixture = clean();
    const agents = fixture.agents.map((facts) => snapshotOf(facts));
    const { paseo } = daemonWith(agents, {
      [MANAGER]: [Array.from({ length: 8 }, (_, index) => short(index))],
      [WORKER]: [[short(0), { item: { type: "user_message", text: long }, timestamp: at(1) }, short(2)]],
    });
    const tools = toolsWith(paseo);
    type Answer = { messages: Array<{ at: string; text: string; truncated: boolean }> };

    // More messages than the summary returns: the newest 5, and the note says so.
    const eight = await tools.call("bm_agent_messages", { agentId: MANAGER });
    expect(AGENT_MESSAGES_SUMMARY).toEqual({ count: 5, maxChars: 1_500 });
    expect(eight.text.split("\n")[0]).toBe(agentMessagesBoundedNote(5, 8));
    expect((jsonOf(eight) as Answer).messages.map((message) => message.at)).toEqual([at(3), at(4), at(5), at(6), at(7)]);
    // A limit above 5 is held to 5 by default …
    const ten = await tools.call("bm_agent_messages", { agentId: MANAGER, limit: 10 });
    expect((jsonOf(ten) as Answer).messages).toHaveLength(5);
    expect(ten.text.split("\n")[0]).toBe(agentMessagesBoundedNote(5, 8));
    // … a limit within it cuts nothing: no note.
    const three = await tools.call("bm_agent_messages", { agentId: MANAGER, limit: 3 });
    expect(three.text.startsWith("{")).toBe(true);
    expect((jsonOf(three) as Answer).messages).toHaveLength(3);
    // Full: today's default of 20, and no note.
    const full = await tools.call("bm_agent_messages", { agentId: MANAGER, detail: "full" });
    expect(full.text.startsWith("{")).toBe(true);
    expect((jsonOf(full) as Answer).messages).toHaveLength(8);

    // A long message is cut to 1,500 characters, redacted first; full keeps it whole.
    const worker = await tools.call("bm_agent_messages", { agentId: WORKER });
    expect(worker.text.split("\n")[0]).toBe(agentMessagesBoundedNote(3, 3));
    const cut = (jsonOf(worker) as Answer).messages[1]!;
    expect(cut.truncated).toBe(true);
    expect(chars(cut.text)).toBeLessThanOrEqual(AGENT_MESSAGES_SUMMARY.maxChars);
    expect(cut.text).toMatch(/^Q1: /);
    expect(cut.text).toMatch(/the end$/);
    expect(worker.text).not.toContain(SECRET);
    const whole = (jsonOf(await tools.call("bm_agent_messages", { agentId: WORKER, detail: "full" })) as Answer).messages[1]!;
    expect(whole.truncated).toBe(false);
    expect(whole.text).toContain(`--token ${REDACTED} the end`);
  });

  it("bm_projects: counts and open decisions only, the note first when requests or notes were left out; full keeps today's shape", async () => {
    const fixture = smallWithBead();
    await store(fixture.records);
    createAlertStore(home, { now: () => NOW }).raise({ workspaceId: WORKSPACE_ID, kind: "request-stalled", subject: fixture.requestId, detail: "idle-unfinished" });
    deps.redactEnv = { PASEO_PASSWORD: SECRET };
    const { paseo, sends } = daemonWith(fixture.agents.map((facts) => snapshotOf(facts)));
    const tools = toolsWith(paseo);
    await tools.call("bm_note", { workspaceId: WORKSPACE_ID, text: "The owner wants PDF only." });
    const asked = await tools.call("bm_ask_owner", {
      workspaceId: WORKSPACE_ID,
      requestId: fixture.requestId,
      question: `Publish with ${SECRET}?\nSecond line.`,
      recommendation: "No.",
      options: [
        { label: "Yes", effects: ["publish"] },
        { label: "No", effects: ["none"] },
      ],
    });
    const decisionId = (jsonOf(asked) as { decisionId: string }).decisionId;

    const result = await tools.call("bm_projects", {});
    expect(result.ok).toBe(true);
    expect(result.text.split("\n")[0]).toBe(PROJECTS_BOUNDED_NOTE);
    const project = (jsonOf(result) as { projects: Array<Record<string, unknown>> }).projects[0]!;
    expect(project).toEqual({
      workspaceId: WORKSPACE_ID,
      label: "invoice-app",
      lastActivityAt: at(3, 20),
      managers: [{ id: MANAGER, title: "Beads manager", status: "idle" }],
      counts: { requests: 1, byState: { completed: 1 }, waitingOnOwner: 0, openStalls: 1, notes: 1, openDecisions: 1 },
      openDecisions: [
        { decisionId, requestId: fixture.requestId, askedBy: "orchestrator", status: "open", question: `Publish with ${REDACTED}?`, options: ["Yes", "No"], at: NOW.toISOString() },
      ],
    });
    expect(result.text).not.toContain(SECRET);

    const full = await tools.call("bm_projects", { detail: "full" });
    expect(full.text.startsWith("{")).toBe(true);
    const fullProject = (jsonOf(full) as { projects: Array<Record<string, unknown>> }).projects[0]!;
    expect(Object.keys(fullProject)).toEqual(["workspaceId", "label", "directory", "lastActivityAt", "managers", "notes", "requests"]);
    expect(sends).toEqual([]);
  });

  it("bm_projects: no note when there is nothing to leave out, and an unknown detail is refused", async () => {
    const { paseo } = daemonWith([]);
    const tools = toolsWith(paseo);
    const empty = await tools.call("bm_projects", {});
    expect(empty.text.startsWith("{")).toBe(true);
    expect((jsonOf(empty) as { projects: unknown[] }).projects).toEqual([]);
    for (const name of ["bm_projects", "bm_request", "bm_agent_messages"]) {
      const input = name === "bm_projects" ? {} : name === "bm_request" ? { workspaceId: WORKSPACE_ID, requestId: "req-1" } : { agentId: MANAGER };
      const refused = await tools.call(name, { ...input, detail: "brief" });
      expect(refused.ok).toBe(false);
      expect(refused.text).toContain("- input.detail: must be one of");
    }
  });
});

describe("the tool set", () => {
  it("lists the sixteen tools in order (bm_reply last, change-014), and answers an unknown name without running anything", async () => {
    const { paseo } = daemonWith([]);
    const tools = toolsWith(paseo);
    expect(tools.faces.map((face) => face.name)).toEqual([
      "bm_projects",
      "bm_request",
      "bm_agent_messages",
      "bm_send_command",
      "bm_decisions",
      "bm_ask_owner",
      "bm_decide",
      "bm_predict",
      "bm_direct_worker",
      "bm_repo",
      "bm_note",
      "bm_findings",
      "bm_compact",
      "bm_handoff",
      "bm_why",
      "bm_reply",
    ]);
    expect(tools.has("bm_report")).toBe(false);
    expect(await tools.call("bm_report", {})).toEqual({ ok: false, text: "Unknown tool: bm_report" });
    // Nothing is recorded.
    expect(filesUnder(home)).toEqual([]);
    // Only the stall pass's rule is left; the Orchestrator reads no rule flag.
    expect(RULE_IDS).toEqual(["review.over-budget"]);
    expect(paseo.agents.list).not.toHaveBeenCalled();
  });

  it("keeps only a handle that looks like Paseo's", async () => {
    const tools = createOrchestratorTools(deps);
    tools.usePaseo(undefined);
    tools.usePaseo({ agents: {} });
    expect((await tools.call("bm_projects", {})).text).toMatch(/no connection to Paseo/);
  });

  it("turns a failing SDK into a tool error, never a throw", async () => {
    const { paseo } = daemonWith([]);
    paseo.agents.list.mockRejectedValue(new Error("daemon went away"));
    const result = await toolsWith(paseo).call("bm_note", { workspaceId: WORKSPACE_ID, text: "A note." });
    expect(result).toEqual({ ok: false, text: "The tool failed: daemon went away. Try again later, or tell the user." });
  });
});

// ---------------------------------------------------------------------------
// Design §6A (ADR-015): bm_send_command, bm_ask_owner.
// ---------------------------------------------------------------------------

const ORCHESTRATOR = "agent-orchestrator";
const orchestratorAgent = {
  id: ORCHESTRATOR,
  provider: "bm-orchestrator/claude-opus-5-5",
  status: "running",
  workspaceId: "wks_home",
  labels: { "bm.role": "orchestrator", "bm.orchestrator": "main" },
  createdAt: "2026-09-26T08:00:00.000Z",
};

/** The Orchestrator's own chat, as its timeline holds it. */
const ownerSays = (text: string, when: string): Entry => ({ item: { type: "user_message", text, clientMessageId: `c-${when}` }, timestamp: when });
const pluginSays = (text: string, when: string): Entry => ({ item: { type: "user_message", text, clientMessageId: `n-${when}` }, timestamp: when });
const agentSays = (text: string, when: string): Entry => ({ item: { type: "user_message", text }, timestamp: when });
const itSays = (text: string, when: string): Entry => ({ item: { type: "assistant_message", text }, timestamp: when });
const toolCall = (when: string): Entry => ({ item: { type: "tool_call", name: "mcp__paseo-bm__bm_agent_messages" }, timestamp: when });

const STALL_NOTICE = `BM-EVENTS\nFrom the paseo-bm plugin, not the owner: 1 event, oldest first. Look before you act; when nothing needs doing, do nothing.\n- request.stalled idle-unfinished — project ${WORKSPACE_ID}, request req-20260926T100020Z, since ${at(0)}. Look with bm_request.`;
const EVENT_NOTICE = `BM-EVENTS\nFrom the paseo-bm plugin, not the owner: 1 event, oldest first. Look before you act; when nothing needs doing, do nothing.\n- decision.opened — project ${WORKSPACE_ID}, request req-20260926T100020Z, decision q:req-20260926T100020Z:Q1. Read it with bm_decisions.`;

/** The owner said "send it" in the Orchestrator's chat; the Orchestrator is mid-turn, reading. */
const OWNER_JUST_SPOKE: Entry[] = [
  pluginSays(STALL_NOTICE, at(0)),
  itSays("Q2 waits for you: PDF or CSV?", at(0, 10)),
  ownerSays("PDF. Send it.", at(1)),
  toolCall(at(1, 5)),
  itSays("Sending the answer to the Manager", at(1, 10)),
];

describe("bm_send_command (design §6A, ADR-015)", () => {
  const managers = () => [
    snapshotOf(clean().agents[0]!),
    snapshotOf(clean().agents[1]!),
    { id: REVIEWER, provider: "bm-reviewer", status: "idle", workspaceId: WORKSPACE_ID, labels: { "bm.role": "reviewer" } },
    { id: "agent-manager-other", provider: "bm-manager", status: "idle", workspaceId: OTHER_WORKSPACE, labels: { "bm.role": "manager" } },
    { id: "agent-manager-archived", provider: "bm-manager", status: "closed", workspaceId: WORKSPACE_ID, labels: { "bm.role": "manager" }, archivedAt: "2026-09-26T11:00:00.000Z" },
    orchestratorAgent,
  ];
  const command = {
    workspaceId: WORKSPACE_ID,
    managerId: MANAGER,
    requestId: "req-20260926T100020Z",
    intent: "answer",
    effects: ["none"],
    command: "Q2: PDF, A4, keep the date format.",
    reason: "The owner said PDF.",
  };
  /** `command` without the intent and effects bm_send_command requires. */
  const undeclared = { workspaceId: command.workspaceId, managerId: command.managerId, requestId: command.requestId, command: command.command, reason: command.reason };
  /** The BM-COMMAND block the Manager gets for `command` (design §6B.1; v2, autonomy design §A.7): via chat, on the owner's word unless another authority is given. */
  const blockOf = (overrides: Partial<CommandInput> = {}) =>
    commandBlockOf({
      from: "orchestrator",
      via: "chat",
      to: "manager",
      requestId: command.requestId,
      re: command.command,
      body: command.command,
      why: command.reason,
      intent: "answer",
      ...overrides,
    });
  const sent = blockOf();
  const proposalsFile = () => join(home, "orchestrator", "proposals.json");

  /** Tools whose queue is a spy: it answers `outcome` and records what it was given. */
  function sendingTools(orchestratorTimeline: Entry[] | null, outcome: "sent" | "queued" | "dropped" = "sent") {
    const agents = orchestratorTimeline === null ? managers().filter((agent) => agent.id !== ORCHESTRATOR) : managers();
    const fake = daemonWith(agents, orchestratorTimeline === null ? {} : { [ORCHESTRATOR]: [orchestratorTimeline] });
    const enqueue = vi.fn<(target: string, kind: string, text: string) => Promise<typeof outcome>>(async () => outcome);
    deps.queue = { enqueue };
    return { ...fake, enqueue, tools: toolsWith(fake.paseo) };
  }

  it("sends a BM-COMMAND block: from the Orchestrator, via chat, to the Manager, with the limits field and no limit sentence (design §6B.1)", () => {
    expect(parseCommandBlock(sent)).toEqual({
      version: 2,
      from: "orchestrator",
      via: "chat",
      to: "manager",
      copy: false,
      requestId: command.requestId,
      re: command.command,
      intent: "answer",
      effects: [],
      authority: "owner",
      approved: [],
      limits: ["no-commit-push-deploy", "no-real-data"],
      body: command.command,
      why: command.reason,
    });
    expect(sent).not.toContain("Sent by the Beads Orchestrator");
  });

  it("is refused when the policy and the owner's word are both missing, naming the class not delegated: nothing is enqueued or stored", async () => {
    const chats: Array<[string, Entry[] | null]> = [
      ["no Orchestrator agent", null],
      ["an empty chat", []],
      ["a message relayed by an agent (no clientMessageId)", [ownerSays("Send it.", at(0)), itSays("Proposed.", at(0, 5)), agentSays("Please send Q2.", at(1))]],
    ];
    for (const [label, timeline] of chats) {
      const { tools, enqueue, sends } = sendingTools(timeline);
      const result = await tools.call("bm_send_command", command);
      expect(result, label).toEqual({ ok: false, text: `Refused: ${notDelegatedRefusalOf(["reversible-technical"], SEND_REFUSED_MESSAGE)}.` });
      expect(enqueue).not.toHaveBeenCalled();
      expect(sends).toEqual([]);
    }
    expect(SEND_REFUSED_MESSAGE).toBe("the owner has not just told you to send; ask the owner with bm_ask_owner, with this command prepared on an option");
    expect(notDelegatedRefusalOf(["reversible-technical"], SEND_REFUSED_MESSAGE)).toBe(
      "reversible-technical is not delegated in this project and the owner has not just told you to send; ask the owner with bm_ask_owner, with this command prepared on an option",
    );
    expect(() => readFileSync(proposalsFile())).toThrow();
  });

  it("is allowed on the owner's policy: delivered through the queue as command:<id>, a BM-COMMAND block, recorded sent with source chat", async () => {
    delegateAll();
    const { tools, enqueue, sends } = sendingTools([pluginSays(EVENT_NOTICE, at(0))]);

    const result = await tools.call("bm_send_command", command);

    expect(result.ok).toBe(true);
    expect(result.text.split("\n")[0]).toMatch(/^Sent\. /);
    expect(jsonOf(result)).toEqual({ commandId: "proposal-1", outcome: "sent", authority: "policy:reversible-technical", approved: [] });
    const onPolicy = blockOf({ authority: "policy:reversible-technical" });
    expect(enqueue.mock.calls).toEqual([[MANAGER, "command:proposal-1", onPolicy, expect.anything()]]);
    expect(createOrchestratorStore(home).listCommands()).toEqual([
      expect.objectContaining({
        id: "proposal-1",
        kind: "command",
        workspaceId: WORKSPACE_ID,
        managerId: MANAGER,
        requestId: command.requestId,
        situation: command.command,
        command: command.command,
        reason: command.reason,
        source: "chat",
        status: "sent",
        sentText: onPolicy,
        outcome: "sent",
      }),
    ]);
    // The tool itself never calls send: the queue does.
    expect(sends).toEqual([]);
  });

  it("is allowed right after the owner's own message, and recorded with source chat; a queued delivery says so", async () => {
    const { tools, enqueue } = sendingTools(OWNER_JUST_SPOKE, "queued");

    const result = await tools.call("bm_send_command", command);

    expect(result.ok).toBe(true);
    expect(result.text.split("\n")[0]).toMatch(/^Queued\. The Manager is busy/);
    expect(jsonOf(result)).toEqual({ commandId: "proposal-1", outcome: "queued", authority: "owner", approved: [] });
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(createOrchestratorStore(home).listCommands()).toMatchObject([{ source: "chat", outcome: "queued", sentText: blockOf() }]);
  });

  it("is refused right after a plugin notice, the plugin's first prompt, or anything but the owner's own message", async () => {
    const afterOwner = OWNER_JUST_SPOKE;
    const chats: Array<[string, Entry[]]> = [
      ["a BM-EVENTS decision event after the owner's message", [...afterOwner, itSays("Done.", at(2)), pluginSays(EVENT_NOTICE, at(3))]],
      ["a BM-EVENTS stall event after the owner's message", [...afterOwner, itSays("Done.", at(2)), pluginSays(STALL_NOTICE, at(3)), itSays("Looking.", at(3, 5))]],
      ["the first prompt", [pluginSays(ORCHESTRATOR_FIRST_PROMPT, at(0)), itSays("Ready.", at(0, 5))]],
      [
        "the first prompt of an older version, with another tool list",
        [pluginSays(`${ORCHESTRATOR_FIRST_PROMPT_START}the Orchestrator tab of paseo-bm.\nYour tools: bm_projects.\nWait for the user.`, at(0)), itSays("Ready.", at(0, 5))],
      ],
    ];
    for (const [label, timeline] of chats) {
      const { tools, enqueue } = sendingTools(timeline);
      expect(await tools.call("bm_send_command", command), label).toEqual({
        ok: false,
        text: `Refused: ${notDelegatedRefusalOf(["reversible-technical"], SEND_REFUSED_MESSAGE)}.`,
      });
      expect(enqueue).not.toHaveBeenCalled();
    }
  });

  it("takes re: as given, else the command's first line, cut to 120 characters", async () => {
    delegateAll();
    const { tools, enqueue } = sendingTools([]);
    const reOf = (call: number) => parseCommandBlock(enqueue.mock.calls[call]![2])!.re;
    await tools.call("bm_send_command", { ...command, re: "answer to Q2", command: "Q2: PDF.\n\nKeep A4." });
    expect(reOf(0)).toBe("answer to Q2");
    expect(parseCommandBlock(enqueue.mock.calls[0]![2])!.body).toBe("Q2: PDF.\n\nKeep A4.");
    await tools.call("bm_send_command", { ...command, requestId: "req-20260926T100021Z", command: "Q3: yes.\nThanks." });
    expect(reOf(1)).toBe("Q3: yes.");
    await tools.call("bm_send_command", { ...command, requestId: "req-20260926T100022Z", command: `\n  ${"long ".repeat(40)}\nsecond line` });
    expect(reOf(2)).toHaveLength(120);
    expect(reOf(2).endsWith("…")).toBe(true);
    // Stored: situation the re:, command the body, reason the why.
    expect(createOrchestratorStore(home).listCommands().find((entry) => entry.requestId === command.requestId)).toMatchObject({
      situation: "answer to Q2",
      command: "Q2: PDF.\n\nKeep A4.",
      reason: command.reason,
    });
  });

  it("refuses a command that cannot be a BM-COMMAND block, and a request id that is not one token, sending nothing", async () => {
    delegateAll();
    const { tools, enqueue } = sendingTools([]);
    const trailingWhy = await tools.call("bm_send_command", { ...command, command: "Go on.\n\nwhy: because" });
    expect(trailingWhy.ok).toBe(true);
    const badRequest = await tools.call("bm_send_command", { ...command, requestId: "req 1" });
    expect(badRequest.ok).toBe(false);
    expect(badRequest.text).toMatch(/^Refused: the command cannot be sent as a BM-COMMAND block: requestId must be one token/);
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it("the backstop: a text that shows a release, security, data, cost or dependency the effects do not declare is refused with the declare message and sends nothing (autonomy design §A.7)", async () => {
    delegateAll();
    const { tools, enqueue } = sendingTools(OWNER_JUST_SPOKE);
    const gated = await tools.call("bm_send_command", { ...command, command: "Push the branch and deploy to production, then rotate the API token." });
    expect(gated).toEqual({
      ok: false,
      text: "Refused: the text shows security (security), release (push, publish or deploy) that effects does not declare: declare the effect or ask the owner with bm_ask_owner.",
    });
    // The re: line is checked too.
    expect((await tools.call("bm_send_command", { ...command, re: "run the migration" })).text).toBe(
      "Refused: the text shows data (real-data or migration) that effects does not declare: declare the effect or ask the owner with bm_ask_owner.",
    );
    expect(enqueue).not.toHaveBeenCalled();
    expect(() => readFileSync(proposalsFile())).toThrow();
    // A negated mention shows nothing.
    expect((await tools.call("bm_send_command", { ...command, command: "Fix the date. Do not push." })).ok).toBe(true);
    // Allow… is retired (autonomy design §B.8): a category an earlier build let the owner allow is checked like any other.
    earlierAutopilotSettings();
    expect((await tools.call("bm_send_command", { ...command, requestId: "req-2", command: "Push the fix." })).text).toBe(
      "Refused: the text shows release (push, publish or deploy) that effects does not declare: declare the effect or ask the owner with bm_ask_owner.",
    );
    expect((await tools.call("bm_send_command", { ...command, requestId: "req-3", command: "Push the new token." })).text).toBe(
      "Refused: the text shows security (security), release (push, publish or deploy) that effects does not declare: declare the effect or ask the owner with bm_ask_owner.",
    );
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it("a declared effect the text shows passes the backstop, and is sent when the policy or the owner's word covers it; its block approves it", async () => {
    delegateAll();
    const { tools, enqueue } = sendingTools([]);
    const result = await tools.call("bm_send_command", { ...command, intent: "continue", effects: ["dependency-install", "commit"], command: "npm install date-fns, then commit the lockfile." });
    expect(result.ok).toBe(true);
    expect(jsonOf(result)).toMatchObject({ authority: "policy:dependency", approved: ["commit", "dependency-install"] });
    expect(parseCommandBlock(enqueue.mock.calls[0]![2])).toMatchObject({
      intent: "continue",
      effects: ["commit", "dependency-install"],
      authority: "policy:dependency",
      approved: ["commit", "dependency-install"],
      limits: ["no-push", "no-deploy", "no-real-data"],
    });
  });

  it("at Cruise the policy and the owner's word in the chat never cover push, publish, deploy, real data, migration, security or cost: refused, sends nothing", async () => {
    expect(CONFIRM_EFFECTS).toEqual(["push", "publish", "deploy", "real-data", "migration", "security", "cost"]);
    for (const timeline of [OWNER_JUST_SPOKE, null]) {
      if (timeline === null) delegateAll();
      // Nor does an earlier build's Autopilot with every category allowed.
      earlierAutopilotSettings();
      const { tools, enqueue } = sendingTools(timeline ?? []);
      for (const effect of CONFIRM_EFFECTS) {
        expect(await tools.call("bm_send_command", { ...command, intent: "release", effects: [effect], command: "Go on." }), effect).toEqual({
          ok: false,
          text: `Refused: ${needsDecisionMessageOf([effect])}.`,
        });
      }
      expect(await tools.call("bm_send_command", { ...command, effects: ["commit", "push", "cost"], command: "Publish the package." })).toEqual({
        ok: false,
        text: "Refused: push, cost needs the owner's decision: ask with bm_ask_owner, and once the owner has answered, send with its decisionId.",
      });
      expect(enqueue).not.toHaveBeenCalled();
    }
    expect(() => readFileSync(proposalsFile())).toThrow();
  });

  it("the backstop holds on the owner's word in chat too: no project allows a category any more", async () => {
    const { tools, enqueue } = sendingTools(OWNER_JUST_SPOKE);
    expect((await tools.call("bm_send_command", { ...command, command: "Publish the package." })).text).toBe(
      "Refused: the text shows release (push, publish or deploy) that effects does not declare: declare the effect or ask the owner with bm_ask_owner.",
    );
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("records each command it sends as an entry of its own, with its source", async () => {
    const { tools, enqueue } = sendingTools(OWNER_JUST_SPOKE);

    const result = await tools.call("bm_send_command", { ...command, re: "answer to Q2", command: "Q2: PDF." });

    expect(jsonOf(result)).toEqual({ commandId: "proposal-1", outcome: "sent", authority: "owner", approved: [] });
    expect(enqueue.mock.calls[0]!.slice(0, 2)).toEqual([MANAGER, "command:proposal-1"]);
    expect(createOrchestratorStore(home).listCommands()).toEqual([
      expect.objectContaining({ id: "proposal-1", status: "sent", source: "chat", sentText: blockOf({ re: "answer to Q2", body: "Q2: PDF." }), outcome: "sent" }),
    ]);
  });

  it("goes to a paseo-bm Manager of that project only — never a Worker, a Reviewer, the Orchestrator or an archived Manager — even on the policy", async () => {
    delegateAll();
    const { tools, enqueue } = sendingTools(OWNER_JUST_SPOKE);
    const refused = async (managerId: string) => (await tools.call("bm_send_command", { ...command, managerId })).text;
    for (const target of [WORKER, REVIEWER, ORCHESTRATOR, "agent-gone"]) {
      expect(await refused(target)).toBe(`Refused: ${target} is not a paseo-bm Manager; use a managerId bm_projects gave.`);
    }
    expect(await refused("agent-manager-other")).toBe(`Refused: Manager agent-manager-other does not belong to project ${WORKSPACE_ID}.`);
    expect(await refused("agent-manager-archived")).toBe("Refused: Manager agent-manager-archived is archived; nothing can be sent to it.");
    expect(enqueue).not.toHaveBeenCalled();
    expect(() => readFileSync(proposalsFile())).toThrow();
  });

  it("records nothing when the Manager cannot be reached", async () => {
    const { tools } = sendingTools(OWNER_JUST_SPOKE, "dropped");
    expect(await tools.call("bm_send_command", command)).toEqual({ ok: false, text: `Refused: Manager ${MANAGER} could not be reached; nothing was sent.` });
    expect(createOrchestratorStore(home).listCommands()).toEqual([]);
  });

  it("validates its fields before anything is read", async () => {
    const { tools, paseo } = sendingTools(OWNER_JUST_SPOKE);
    const issues = async (input: Record<string, unknown>) => (await tools.call("bm_send_command", input)).text;
    expect(await issues({ ...command, command: "x".repeat(MAX_PROPOSAL_COMMAND_CHARS + 1) })).toContain(`- input.command: must be at most ${MAX_PROPOSAL_COMMAND_CHARS} characters`);
    expect(await issues({ ...command, reason: "x".repeat(301) })).toContain("- input.reason: must be at most 300 characters");
    expect(await issues({ ...command, agentId: WORKER })).toContain("- input.agentId: is not a field of this tool");
    expect(await issues(undeclared)).toContain("- input.intent: is required\n- input.effects: is required");
    expect(await issues({ ...command, effects: [] })).toContain("- input.effects: needs at least 1 item(s)");
    expect(paseo.agents.list).not.toHaveBeenCalled();
  });

  it("a 4,000-character command is sent and recorded as its whole block", async () => {
    delegateAll();
    const { tools } = sendingTools([]);
    const long = "x".repeat(MAX_PROPOSAL_COMMAND_CHARS);
    expect((await tools.call("bm_send_command", { ...command, re: "long", command: long })).ok).toBe(true);
    expect(createOrchestratorStore(home).listCommands()[0]!.sentText).toBe(blockOf({ re: "long", body: long, authority: "policy:reversible-technical" }));
  });

  /**
   * A command the Orchestrator already sent `hoursAgo` before NOW; `source:
   * "autopilot"` makes it one Phase 1 sent on a project's Autopilot, as its
   * history holds it (autonomy design §B.8).
   */
  function alreadySent(hoursAgo: number, overrides: { requestId?: string | null; source?: "autopilot" | "chat"; workspaceId?: string } = {}) {
    const when = new Date(NOW.getTime() - hoursAgo * 3_600_000);
    const entry = createOrchestratorStore(home, { now: () => when }).appendCommand({
      workspaceId: overrides.workspaceId ?? WORKSPACE_ID,
      managerId: MANAGER,
      requestId: overrides.requestId === undefined ? command.requestId : overrides.requestId,
      situation: "",
      command: "Continue.",
      reason: "",
      sentText: "Continue.",
      outcome: "sent",
    });
    if (overrides.source !== "autopilot") return;
    const file = JSON.parse(readFileSync(proposalsFile(), "utf8")) as { version: number; entries: Array<{ id: string }> };
    writeFileSync(proposalsFile(), JSON.stringify({ ...file, entries: file.entries.map((stored) => (stored.id === entry.id ? { ...stored, source: "autopilot" } : stored)) }));
  }

  it("the loop guard: a 13th command for one request within 24 hours is refused before anything is sent — Phase 1's commands on Autopilot counted (design §6A)", async () => {
    delegateAll();
    for (let index = 0; index < COMMAND_LIMIT_PER_REQUEST - 1; index += 1) alreadySent(1 + index, { source: index % 2 === 0 ? "autopilot" : "chat" });
    // Not counted: older than 24 hours, another request, another project.
    alreadySent(25);
    alreadySent(1, { requestId: "req-other" });
    alreadySent(1, { workspaceId: OTHER_WORKSPACE });
    const { tools, enqueue } = sendingTools([]);

    // The 12th goes out …
    expect((await tools.call("bm_send_command", command)).ok).toBe(true);
    expect(enqueue).toHaveBeenCalledTimes(1);
    // … the 13th does not: nothing enqueued, nothing recorded.
    const before = createOrchestratorStore(home).listCommands().length;
    expect(await tools.call("bm_send_command", command)).toEqual({ ok: false, text: `Refused: ${COMMAND_LIMIT_MESSAGE}.` });
    expect(COMMAND_LIMIT_MESSAGE).toBe("you sent 12 commands for this request in 24 hours; ask the owner with bm_ask_owner");
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(createOrchestratorStore(home).listCommands()).toHaveLength(before);
    // Another request of the same project still goes out.
    expect((await tools.call("bm_send_command", { ...command, requestId: "req-other" })).ok).toBe(true);
    expect(enqueue).toHaveBeenCalledTimes(2);
  });

  it("the loop guard counts commands without a request per project, apart from those with one", async () => {
    delegateAll();
    for (let index = 0; index < COMMAND_LIMIT_PER_REQUEST; index += 1) alreadySent(2, { requestId: null });
    const { tools, enqueue } = sendingTools([]);
    const withoutRequest: Partial<typeof command> = { ...command };
    delete withoutRequest.requestId;
    expect(await tools.call("bm_send_command", withoutRequest)).toEqual({ ok: false, text: `Refused: ${COMMAND_LIMIT_MESSAGE}.` });
    expect(enqueue).not.toHaveBeenCalled();
    expect((await tools.call("bm_send_command", command)).ok).toBe(true);
  });

  describe("on the owner's autonomy policy, a command that answers no decision (autonomy design §B.9)", () => {
    /** One cell of the project's policy, set as the owner's `autonomy.set` sets it. */
    const setCell = (decisionClass: DecisionClass, mode: "owner" | "shadow" | "delegate", workspaceId = WORKSPACE_ID) =>
      createAutonomyStore(home).set({ workspaceId, class: decisionClass, mode, confirmed: true }, NOW.toISOString());
    const DELEGABLE = CRUISE;
    const sentBlocks = (enqueue: ReturnType<typeof sendingTools>["enqueue"]) => enqueue.mock.calls.map((call) => parseCommandBlock(call[2])!);

    it("maps the declared effects to their classes, none and commit counting as reversible-technical, riskiest first", () => {
      expect(DELEGABLE).toEqual(["dependency", "environment", "scope", "preference", "reversible-technical"]);
      expect(commandClassesOf(["none"])).toEqual(["reversible-technical"]);
      expect(commandClassesOf([])).toEqual(["reversible-technical"]);
      expect(commandClassesOf(["commit"])).toEqual(["reversible-technical"]);
      expect(commandClassesOf(["dependency-install"])).toEqual(["dependency"]);
      expect(commandClassesOf(["commit", "network", "dependency-install", "none"])).toEqual(["dependency", "environment", "reversible-technical"]);
      expect(commandClassesOf(["outside-workspace", "push", "cost"])).toEqual(["release", "cost", "environment"]);
      expect(policyCoverOf({ projects: {}, challenger: {} }, WORKSPACE_ID, ["commit", "dependency-install"])).toEqual({
        riskiest: "dependency",
        notDelegated: ["dependency", "reversible-technical"],
      });
    });

    it("a none or commit command where reversible-technical is delegate goes out with policy:reversible-technical, without the owner's word", async () => {
      setCell("reversible-technical", "delegate");
      // No Orchestrator in the chat at all: nothing the owner said authorises these.
      const { tools, enqueue, refetches } = sendingTools(null);
      const none = await tools.call("bm_send_command", command);
      expect(none.ok).toBe(true);
      expect(jsonOf(none)).toEqual({ commandId: "proposal-1", outcome: "sent", authority: "policy:reversible-technical", approved: [] });
      expect(enqueue.mock.calls[0]).toEqual([MANAGER, "command:proposal-1", blockOf({ authority: "policy:reversible-technical" }), expect.anything()]);
      const commit = await tools.call("bm_send_command", { ...command, requestId: "req-20260926T100021Z", intent: "continue", effects: ["commit"], command: "Commit the fix." });
      expect(jsonOf(commit)).toMatchObject({ authority: "policy:reversible-technical", approved: ["commit"] });
      expect(sentBlocks(enqueue)[1]).toMatchObject({ via: "chat", effects: ["commit"], authority: "policy:reversible-technical", approved: ["commit"], limits: ["no-push", "no-deploy", "no-real-data"] });
      expect(createOrchestratorStore(home).listCommands()).toMatchObject([{ source: "chat", status: "sent" }, { source: "chat", status: "sent" }]);
      // The policy is read, not the Orchestrator's chat.
      expect(refetches).toEqual([]);
    });

    it("a dependency-install needs the dependency cell delegated; with commit, both classes, the authority naming dependency", async () => {
      setCell("dependency", "delegate");
      const { tools, enqueue } = sendingTools(null);
      const install = { ...command, intent: "continue", effects: ["dependency-install"], command: "npm install date-fns, then run the tests." };
      expect(jsonOf(await tools.call("bm_send_command", install))).toMatchObject({ authority: "policy:dependency", approved: ["dependency-install"] });
      // commit counts as reversible-technical, which is still the owner's.
      const installAndCommit = { ...install, requestId: "req-20260926T100021Z", effects: ["commit", "dependency-install"] };
      expect(await tools.call("bm_send_command", installAndCommit)).toEqual({
        ok: false,
        text: `Refused: ${notDelegatedRefusalOf(["reversible-technical"], SEND_REFUSED_MESSAGE)}.`,
      });
      setCell("reversible-technical", "delegate");
      expect(jsonOf(await tools.call("bm_send_command", installAndCommit))).toMatchObject({ authority: "policy:dependency", approved: ["commit", "dependency-install"] });
      // Only reversible-technical delegated: the install is refused, naming dependency.
      setCell("dependency", "shadow");
      expect(await tools.call("bm_send_command", { ...install, requestId: "req-20260926T100022Z" })).toEqual({
        ok: false,
        text: `Refused: ${notDelegatedRefusalOf(["dependency"], SEND_REFUSED_MESSAGE)}.`,
      });
      expect(sentBlocks(enqueue).map((block) => block.authority)).toEqual(["policy:dependency", "policy:dependency"]);
    });

    it("a release, data, security or cost effect goes on the policy where its class is delegated (Full auto, ADR-025); the owner's word alone never covers one", async () => {
      // Cruise: the owner's word in the chat does not cover a confirmation effect.
      for (const decisionClass of DELEGABLE) setCell(decisionClass, "delegate");
      const spoken = sendingTools(OWNER_JUST_SPOKE);
      for (const effect of CONFIRM_EFFECTS) {
        expect(await spoken.tools.call("bm_send_command", { ...command, intent: "release", effects: [effect], command: "Go on." }), effect).toEqual({
          ok: false,
          text: `Refused: ${needsDecisionMessageOf([effect])}.`,
        });
      }
      expect(spoken.enqueue).not.toHaveBeenCalled();
      // Full auto: every class delegated, each effect goes on the policy of its class.
      for (const decisionClass of DECISION_CLASSES) setCell(decisionClass, "delegate");
      const { tools, enqueue } = sendingTools(null);
      const classOf = { push: "release", publish: "release", deploy: "release", "real-data": "data", migration: "data", security: "security", cost: "cost" } as const;
      for (const [index, effect] of CONFIRM_EFFECTS.entries()) {
        const sent = await tools.call("bm_send_command", { ...command, requestId: `req-20260926T1001${String(index).padStart(2, "0")}Z`, intent: "release", effects: [effect], command: "Go on." });
        expect(sent.ok, `${effect}: ${sent.text}`).toBe(true);
        expect(jsonOf(sent), effect).toMatchObject({ authority: `policy:${classOf[effect as keyof typeof classOf]}`, approved: [effect] });
      }
      expect(sentBlocks(enqueue).map((block) => block.authority)).toEqual(CONFIRM_EFFECTS.map((effect) => `policy:${classOf[effect as keyof typeof classOf]}`));
    });

    it("in a project with no delegated class a command is refused without the owner's word or a grant — another project's delegation does not count", async () => {
      for (const decisionClass of DELEGABLE) setCell(decisionClass, "delegate", OTHER_WORKSPACE);
      setCell("reversible-technical", "shadow");
      const quiet = sendingTools([pluginSays(EVENT_NOTICE, at(0))]);
      expect(await quiet.tools.call("bm_send_command", command)).toEqual({ ok: false, text: `Refused: ${notDelegatedRefusalOf(["reversible-technical"], SEND_REFUSED_MESSAGE)}.` });
      expect(await quiet.tools.call("bm_send_command", { ...command, effects: ["commit", "network", "dependency-install"], command: "npm install undici, then commit." })).toEqual({
        ok: false,
        text: `Refused: ${notDelegatedRefusalOf(["dependency", "environment", "reversible-technical"], SEND_REFUSED_MESSAGE)}.`,
      });
      expect(notDelegatedRefusalOf(["dependency", "environment", "reversible-technical"], SEND_REFUSED_MESSAGE)).toMatch(
        /^dependency, environment and reversible-technical are not delegated in this project and the owner has not just told you to send/,
      );
      expect(quiet.enqueue).not.toHaveBeenCalled();
      expect(() => readFileSync(proposalsFile())).toThrow();
      // The owner's own word still authorises it, as the owner's.
      const spoken = sendingTools(OWNER_JUST_SPOKE);
      expect(jsonOf(await spoken.tools.call("bm_send_command", command))).toMatchObject({ authority: "owner" });
    });

    it("is read at send time: a cell set back to shadow or owner, or the project reset, refuses the next command", async () => {
      setCell("reversible-technical", "delegate");
      const { tools, enqueue } = sendingTools([]);
      const refused = { ok: false, text: `Refused: ${notDelegatedRefusalOf(["reversible-technical"], SEND_REFUSED_MESSAGE)}.` };
      expect((await tools.call("bm_send_command", command)).ok).toBe(true);
      setCell("reversible-technical", "shadow");
      expect(await tools.call("bm_send_command", command)).toEqual(refused);
      setCell("reversible-technical", "delegate");
      expect((await tools.call("bm_send_command", command)).ok).toBe(true);
      createAutonomyStore(home).reset(WORKSPACE_ID);
      expect(await tools.call("bm_send_command", command)).toEqual(refused);
      expect(enqueue).toHaveBeenCalledTimes(2);
    });

    it("the backstop holds whatever the policy: a command declaring none or commit whose text shows git push is refused and sends nothing", async () => {
      for (const decisionClass of DELEGABLE) setCell(decisionClass, "delegate");
      const { tools, enqueue } = sendingTools(null);
      const release = "Refused: the text shows release (push, publish or deploy) that effects does not declare: declare the effect or ask the owner with bm_ask_owner.";
      expect(await tools.call("bm_send_command", { ...command, command: "Run git push origin main." })).toEqual({ ok: false, text: release });
      expect(await tools.call("bm_send_command", { ...command, effects: ["commit"], command: "Commit, then git push." })).toEqual({ ok: false, text: release });
      expect(await tools.call("bm_send_command", { ...command, re: "git push the fix" })).toEqual({ ok: false, text: release });
      expect(enqueue).not.toHaveBeenCalled();
      expect(() => readFileSync(proposalsFile())).toThrow();
    });

    it("Autopilot is retired (autonomy design §B.8): an earlier build's Autopilot authorises nothing — no decision, no fresh owner word and a class not delegated is refused", async () => {
      earlierAutopilotSettings();
      setCell("reversible-technical", "delegate");
      const { tools, enqueue } = sendingTools([pluginSays(EVENT_NOTICE, at(0))]);
      expect(jsonOf(await tools.call("bm_send_command", command))).toEqual({ commandId: "proposal-1", outcome: "sent", authority: "policy:reversible-technical", approved: [] });
      const install = { ...command, requestId: "req-20260926T100021Z", intent: "continue", effects: ["dependency-install"], command: "npm install date-fns" };
      expect(await tools.call("bm_send_command", install)).toEqual({ ok: false, text: `Refused: ${notDelegatedRefusalOf(["dependency"], SEND_REFUSED_MESSAGE)}.` });
      // Nothing is ever sent via autopilot or on its authority any more.
      expect(sentBlocks(enqueue).map((block) => [block.via, block.authority])).toEqual([["chat", "policy:reversible-technical"]]);
      expect(createOrchestratorStore(home).listCommands().map((entry) => entry.source)).toEqual(["chat"]);
    });

    it("the two tools say when a command goes out without a decision: where the owner delegated every class of its effects", () => {
      for (const name of ["bm_send_command", "bm_direct_worker"]) {
        expect(ORCHESTRATOR_SERVER_TOOLS.find((face) => face.name === name)!.description, name).toMatch(/the owner's policy delegating every class of its effects|the owner delegated every class of its effects/);
      }
      expect(ORCHESTRATOR_SERVER_TOOLS.find((face) => face.name === "bm_send_command")!.description).toContain("naming the class not delegated");
    });
  });
});

// ---------------------------------------------------------------------------
// Autonomy design §A.7 (ADR-017 decisions 4–5): authority from declared effects and grants.
// ---------------------------------------------------------------------------

describe("a command on the grant of a decision the owner answered (autonomy design §A.7)", () => {
  const REQUEST = "req-20260929T073348Z";
  const DECISION = "o:push-contract-backend";
  const agents = () => [snapshotOf(clean().agents[0]!), snapshotOf(clean().agents[1]!, { status: "running" }), orchestratorAgent];
  /** The Orchestrator's chat once the plugin delivered the owner's answer: a plugin notice, not the owner's word. */
  const ANSWER_DELIVERED: Entry[] = [
    itSays("Push the contract backend to origin/dev? I asked the owner.", at(0)),
    pluginSays(`BM-ANSWER\ndecisionId: ${DECISION}\nThis notice is from the paseo-bm plugin.`, at(5)),
  ];
  const push = {
    workspaceId: WORKSPACE_ID,
    managerId: MANAGER,
    requestId: REQUEST,
    decisionId: DECISION,
    intent: "release",
    effects: ["push"],
    re: "push the contract backend",
    command: "Push the contract backend to origin/dev now; leave the manifest as it is.",
    reason: "The owner answered the push decision.",
  };

  /** An open Orchestrator decision of the project: push the contract backend, or hold. */
  function openDecision(overrides: Partial<Decision> = {}): Decision {
    const decision: Decision = {
      id: DECISION,
      workspaceId: WORKSPACE_ID,
      requestId: REQUEST,
      askedBy: { role: "orchestrator", agentId: ORCHESTRATOR },
      askedAt: "2026-09-26T11:00:00.000Z",
      round: null,
      question: "Push the contract backend to origin/dev?",
      subject: "push-contract-backend",
      options: [
        { key: "a", label: "Push the contract backend", recommended: true, effects: ["push"] },
        { key: "b", label: "Hold", recommended: false, effects: ["none"] },
      ],
      status: "open",
      settledAt: null,
      needsConfirmation: null,
      answer: null,
      grant: null,
      delivery: null,
      supersedes: null,
      supersededBy: null,
      ...overrides,
    };
    createDecisionStore(home).open(decision);
    return decision;
  }

  /** The owner answers it, `minutesAgo` before NOW. */
  function answer(input: { optionKey?: string; words?: string }, minutesAgo = 10, id = DECISION): Decision {
    const result = createDecisionStore(home).transition(id, (decision) =>
      answerDecision(decision, { via: "inbox", ...input, at: new Date(NOW.getTime() - minutesAgo * 60_000).toISOString() }),
    );
    if (result.status !== "updated") throw new Error(`the answer was not stored: ${result.status}`);
    return result.decision;
  }

  const stored = (id = DECISION) => createDecisionStore(home).get(id, WORKSPACE_ID)!;

  function grantTools(timeline: Entry[] = ANSWER_DELIVERED, outcome: "sent" | "queued" | "dropped" = "sent") {
    const fake = daemonWith(agents(), { [ORCHESTRATOR]: [timeline] });
    const enqueue = vi.fn<(target: string, kind: string, text: string) => Promise<"sent" | "queued" | "dropped">>(async (target) => (target === MANAGER ? outcome : "sent"));
    deps.queue = { enqueue };
    return { ...fake, enqueue, tools: toolsWith(fake.paseo) };
  }

  afterEach(() => clearDecisionStoreCache());

  it("replays 2026-09-29: the owner answers the push decision in words, and one command with approved: push goes out — no second question", async () => {
    openDecision();
    // The owner answers in their own words: the answer grants every effect the decision declares (push), for one command within the hour.
    expect(answer({ words: "Yes, push the contract backend to origin/dev. Leave the manifest." }).grant).toEqual({
      effects: ["push"],
      expiresAt: new Date(NOW.getTime() - 10 * 60_000 + GRANT_TTL_MS).toISOString(),
      usedAt: null,
    });
    const { tools, enqueue, sends } = grantTools();

    const result = await tools.call("bm_send_command", push);

    expect(result.ok).toBe(true);
    expect(jsonOf(result)).toMatchObject({ outcome: "sent", authority: `decision:${DECISION}`, approved: ["push"] });
    expect(enqueue).toHaveBeenCalledTimes(1);
    const block = parseCommandBlock(enqueue.mock.calls[0]![2])!;
    expect(block).toMatchObject({
      version: 2,
      from: "orchestrator",
      to: "manager",
      requestId: REQUEST,
      intent: "release",
      effects: ["push"],
      authority: `decision:${DECISION}`,
      approved: ["push"],
      body: push.command,
    });
    // The limits no longer contradict the approval: the push is allowed, the rest stays withheld.
    expect(block.limits).toEqual(["no-commit", "no-deploy", "no-real-data"]);
    // The grant is spent, and nothing asked the owner a second time.
    expect(stored().grant!.usedAt).toBe(NOW.toISOString());
    expect(createDecisionStore(home).list({ workspaceId: WORKSPACE_ID })).toHaveLength(1);
    expect(createOrchestratorStore(home).listCommands()).toMatchObject([{ requestId: REQUEST, source: "chat", sentText: enqueue.mock.calls[0]![2] }]);
    expect(sends).toEqual([]);
  });

  it("the same command without the grant is refused, on the policy and on the owner's word alike: push needs the decision", async () => {
    delegateAll();
    const withoutGrant = Object.fromEntries(Object.entries(push).filter(([key]) => key !== "decisionId"));
    const { tools, enqueue } = grantTools(OWNER_JUST_SPOKE);
    expect(await tools.call("bm_send_command", withoutGrant)).toEqual({ ok: false, text: `Refused: ${needsDecisionMessageOf(["push"])}.` });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("a grant is used once: the second command on it is refused and sends nothing", async () => {
    openDecision();
    answer({ optionKey: "a" });
    const { tools, enqueue } = grantTools();
    expect((await tools.call("bm_send_command", push)).ok).toBe(true);
    const again = await tools.call("bm_send_command", { ...push, command: "Push it once more." });
    expect(again).toEqual({
      ok: false,
      text: `Refused: the grant of decision ${DECISION} was used at ${NOW.toISOString()}; ask the owner again with bm_ask_owner.`,
    });
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it("an expired grant, or one that does not cover every declared effect, is refused and left unused", async () => {
    openDecision();
    answer({ optionKey: "a" }, 61);
    const late = grantTools();
    expect((await late.tools.call("bm_send_command", push)).text).toMatch(new RegExp(`^Refused: the grant of decision ${DECISION} expired at `));
    expect(late.enqueue).not.toHaveBeenCalled();

    clearDecisionStoreCache();
    rmSync(join(home, "decisions"), { recursive: true, force: true });
    openDecision();
    answer({ optionKey: "a" });
    const { tools, enqueue } = grantTools();
    expect(await tools.call("bm_send_command", { ...push, effects: ["push", "deploy"], command: "Push the contract backend and deploy it." })).toEqual({
      ok: false,
      text: `Refused: decision ${DECISION} did not grant deploy; ask the owner again with bm_ask_owner.`,
    });
    expect(enqueue).not.toHaveBeenCalled();
    expect(stored().grant!.usedAt).toBeNull();
  });

  it("a text that shows an effect the command does not declare is refused with the declare message, even on a grant", async () => {
    openDecision();
    answer({ optionKey: "a" });
    const { tools, enqueue } = grantTools();
    expect(await tools.call("bm_send_command", { ...push, command: "Push the contract backend, then rotate the API token." })).toEqual({
      ok: false,
      text: "Refused: the text shows security (security) that effects does not declare: declare the effect or ask the owner with bm_ask_owner.",
    });
    expect(enqueue).not.toHaveBeenCalled();
    expect(stored().grant!.usedAt).toBeNull();
  });

  it("only an answered decision the Orchestrator asked in this project, about the command's request, authorises it", async () => {
    const { tools, enqueue } = grantTools();
    expect((await tools.call("bm_send_command", push)).text).toBe(`Refused: no decision ${DECISION} in project ${WORKSPACE_ID}.`);
    openDecision();
    expect((await tools.call("bm_send_command", push)).text).toBe(`Refused: decision ${DECISION} is open; only a decision the owner answered authorises a command.`);
    answer({ optionKey: "a" });
    expect((await tools.call("bm_send_command", { ...push, requestId: "req-20260929T090000Z" })).text).toBe(
      `Refused: decision ${DECISION} is about request ${REQUEST}; a command on its authority names that request.`,
    );
    const workerQuestion = `q:${REQUEST}:Q4`;
    expect((await tools.call("bm_send_command", { ...push, decisionId: workerQuestion })).text).toBe(
      `Refused: ${workerQuestion} is not a decision you asked; decisionId takes the id (o:…) of your own decision the owner answered.`,
    );
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("an answer that granted nothing authorises a command that declares no effect, and spends nothing", async () => {
    openDecision();
    expect(answer({ optionKey: "b" }).grant).toBeNull();
    const { tools, enqueue } = grantTools();
    const hold = { ...push, intent: "answer", effects: ["none"], re: "hold: do not push yet", command: "Hold: do not push the contract backend yet." };
    const result = await tools.call("bm_send_command", hold);
    expect(result.ok).toBe(true);
    expect(parseCommandBlock(enqueue.mock.calls[0]![2])).toMatchObject({ authority: `decision:${DECISION}`, approved: [], limits: ["no-commit-push-deploy", "no-real-data"] });
    // Declaring the push on that answer is refused: it granted nothing.
    expect((await tools.call("bm_send_command", push)).text).toBe(`Refused: decision ${DECISION} granted nothing; ask the owner again with bm_ask_owner.`);
  });

  it("a command that could not be delivered spends nothing: the grant still serves the next attempt", async () => {
    openDecision();
    answer({ optionKey: "a" });
    const unreachable = grantTools(ANSWER_DELIVERED, "dropped");
    expect(await unreachable.tools.call("bm_send_command", push)).toEqual({ ok: false, text: `Refused: Manager ${MANAGER} could not be reached; nothing was sent.` });
    expect(stored().grant!.usedAt).toBeNull();
    const { tools } = grantTools();
    expect((await tools.call("bm_send_command", push)).ok).toBe(true);
    expect(stored().grant!.usedAt).toBe(NOW.toISOString());
  });

  it("two calls on one grant at the same time: one goes out, the other is refused", async () => {
    openDecision();
    answer({ optionKey: "a" });
    const { tools, enqueue } = grantTools();
    const results = await Promise.all([tools.call("bm_send_command", push), tools.call("bm_send_command", { ...push, command: "Push it now." })]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.find((result) => !result.ok)!.text).toMatch(new RegExp(`^Refused: the grant of decision ${DECISION} (is being used by another command|was used at )`));
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it("bm_direct_worker spends the grant once for the Worker's command and its Manager's copy", async () => {
    openDecision();
    answer({ optionKey: "a" });
    const { tools, enqueue } = grantTools();
    const direct = {
      workspaceId: WORKSPACE_ID,
      workerId: WORKER,
      requestId: REQUEST,
      decisionId: DECISION,
      intent: "release",
      effects: ["push"],
      re: "push the contract backend",
      command: "Push the contract backend to origin/dev now.",
    };
    const result = await tools.call("bm_direct_worker", direct);
    expect(result.ok).toBe(true);
    expect(jsonOf(result)).toMatchObject({ authority: `decision:${DECISION}`, approved: ["push"] });
    expect(enqueue.mock.calls.map(([target, , text]) => [target, parseCommandBlock(text)!.approved, parseCommandBlock(text)!.copy])).toEqual([
      [WORKER, ["push"], false],
      [MANAGER, ["push"], true],
    ]);
    expect(stored().grant!.usedAt).toBe(NOW.toISOString());
    expect((await tools.call("bm_direct_worker", direct)).text).toMatch(/^Refused: the grant of decision .* was used at /);
  });
});

describe("bm_ask_owner (autonomy design §A.3, §A.6)", () => {
  const REQUEST = "req-20260926T100020Z";
  const agents = () => [
    snapshotOf(clean().agents[0]!),
    snapshotOf(clean().agents[1]!),
    { id: REVIEWER, provider: "bm-reviewer", status: "idle", workspaceId: WORKSPACE_ID, labels: { "bm.role": "reviewer" } },
    { id: "agent-manager-other", provider: "bm-manager", status: "idle", workspaceId: OTHER_WORKSPACE, labels: { "bm.role": "manager" } },
    { id: "agent-manager-archived", provider: "bm-manager", status: "closed", workspaceId: WORKSPACE_ID, labels: { "bm.role": "manager" }, archivedAt: "2026-09-26T11:00:00.000Z" },
    orchestratorAgent,
  ];

  it("letters its options a to e: one key per option it takes, derived from the cap (the literal it replaces)", () => {
    expect(ASK_OWNER_OPTION_KEYS).toEqual(["a", "b", "c", "d", "e"]);
  });

  const ask = {
    workspaceId: WORKSPACE_ID,
    requestId: REQUEST,
    question: "Drop the old invoices table? Q3 asks to migrate or delete it.",
    recommendation: "Migrate: deleting cannot be undone.",
  };
  const migrate = {
    label: "Migrate the table",
    effects: ["migration"],
    recommended: true,
    command: { to: "manager", agentId: MANAGER, intent: "continue", body: "Migrate the old invoices table into the new one, then keep the old one read-only." },
  };
  const decisions = () => createDecisionStore(home).list({ workspaceId: WORKSPACE_ID });
  const replacedOf = (result: ServerToolResult) => (jsonOf(result) as { replaced: string | null }).replaced;
  afterEach(() => clearDecisionStoreCache());

  it("stores an open o: decision with its options, effects and prepared command, and sends nothing", async () => {
    const { paseo, sends } = daemonWith(agents());
    deps.queue = { enqueue: vi.fn(async () => "sent" as const) };
    const tools = toolsWith(paseo);

    const result = await tools.call("bm_ask_owner", { ...ask, subject: "invoices-table", options: [migrate, { label: " Keep  it ", effects: ["none"] }] });

    expect(result.ok).toBe(true);
    expect(result.text.split("\n")[0]).toMatch(/^Asked\. The owner answers it in paseo-bm, with one button per option; nothing was sent to any agent\./);
    expect(result.text.split("\n")[0]).toContain("the plugin delivers that command itself, with the owner's authority");
    // No class proposed: the migration option makes it data (autonomy design §B.1).
    expect(jsonOf(result)).toEqual({ decisionId: "o:assessment-1", replaced: null, class: "data" });
    expect(decisions()).toEqual([
      {
        id: "o:assessment-1",
        workspaceId: WORKSPACE_ID,
        requestId: REQUEST,
        askedBy: { role: "orchestrator", agentId: ORCHESTRATOR },
        askedAt: NOW.toISOString(),
        round: null,
        question: `${ask.question}\n\nRecommendation: ${ask.recommendation}`,
        subject: "invoices-table",
        class: "data",
        options: [
          {
            key: "a",
            label: "Migrate the table",
            recommended: true,
            effects: ["migration"],
            action: { kind: "command", to: "manager", agentId: MANAGER, intent: "continue", body: migrate.command.body, effects: ["migration"] },
          },
          { key: "b", label: "Keep it", recommended: false, effects: ["none"] },
        ],
        status: "open",
        settledAt: null,
        needsConfirmation: null,
        answer: null,
        grant: null,
        delivery: null,
        supersedes: null,
        supersededBy: null,
        // The option it recommends is the recommended predictor's prediction (autonomy design §B.3).
        prediction: { recommended: { optionKey: "a" }, orchestrator: null },
      },
    ]);
    // The Orchestrator's command log is not where a decision lives.
    expect(createOrchestratorStore(home).listCommands()).toEqual([]);
    expect(sends).toEqual([]);
    expect(deps.queue.enqueue).not.toHaveBeenCalled();
  });

  it("stores the checked class: the proposal when riskier, raised to the options' effects when not (autonomy design §B.1)", async () => {
    const { paseo } = daemonWith(agents());
    const tools = toolsWith(paseo);
    const push = { label: "Push the contract backend", effects: ["push"], recommended: true };
    const hold = { label: "Hold", effects: ["none"] };
    const classOf = async (input: Record<string, unknown>) => {
      const result = await tools.call("bm_ask_owner", { ...ask, separate: true, ...input });
      expect(result.ok).toBe(true);
      const { decisionId, class: told } = jsonOf(result) as { decisionId: string; class: string };
      expect(createDecisionStore(home).get(decisionId)?.class).toBe(told);
      return told;
    };

    expect(await classOf({ class: "security", options: [push, hold] })).toBe("security");
    // Negative: reversible-technical on an option that pushes is a release.
    expect(await classOf({ class: "reversible-technical", options: [push, hold] })).toBe("release");
    expect(await classOf({ class: "scope", options: [hold] })).toBe("scope");
    expect(await classOf({ options: [{ label: "Allow the network", effects: ["network"] }, hold] })).toBe("environment");
    expect(await classOf({})).toBe("reversible-technical");
    expect((await tools.call("bm_ask_owner", { ...ask, class: "urgent" })).text).toContain(`- input.class: must be one of ${DECISION_CLASSES.join(", ")}`);

    // bm_decisions shows it, and reads a decision stored before classes by its effects (autonomy design §B.9).
    createDecisionStore(home).open(makeDecision({ id: "o:older", workspaceId: WORKSPACE_ID, requestId: REQUEST, askedBy: { role: "orchestrator", agentId: null }, round: null }));
    const listed = JSON.parse((await tools.call("bm_decisions", { workspaceId: WORKSPACE_ID })).text) as { decisions: Array<{ id: string; class: string }> };
    expect(Object.fromEntries(listed.decisions.map((decision) => [decision.id, decision.class]))).toEqual({
      "o:assessment-1": "security",
      "o:assessment-2": "release",
      "o:assessment-3": "scope",
      "o:assessment-4": "environment",
      "o:assessment-5": "reversible-technical",
      "o:older": "release",
    });
  });

  it("a second question on the same request replaces the open one and names it; separate: true keeps both; another request, or the whole project, is its own", async () => {
    const { paseo } = daemonWith(agents());
    const tools = toolsWith(paseo);

    expect(replacedOf(await tools.call("bm_ask_owner", { ...ask, subject: "drop-table" }))).toBeNull();
    const second = await tools.call("bm_ask_owner", ask);
    expect(replacedOf(second)).toBe("o:assessment-1");
    expect(second.text.split("\n")[0]).toContain("It replaced your open question o:assessment-1 of this request, which can no longer be answered.");
    expect(createDecisionStore(home).get("o:assessment-1")).toMatchObject({ status: "superseded", supersededBy: "o:assessment-2", settledAt: NOW.toISOString() });
    expect(createDecisionStore(home).get("o:assessment-2")).toMatchObject({ status: "open", supersedes: "o:assessment-1" });

    // separate: both stay open.
    const third = await tools.call("bm_ask_owner", { ...ask, question: "Push the backends?", subject: "push-backends", separate: true });
    expect(replacedOf(third)).toBeNull();
    expect(third.text.split("\n")[0]).not.toContain("replaced");
    // With a subject, the open question of that subject is the one replaced — not the newest.
    await tools.call("bm_ask_owner", { ...ask, question: "Push only the contract backend?", subject: "push-backends" });
    expect(createDecisionStore(home).get("o:assessment-3")).toMatchObject({ status: "superseded", supersededBy: "o:assessment-4" });
    expect(createDecisionStore(home).get("o:assessment-2")).toMatchObject({ status: "open" });

    // Another request, and the whole project, replace nothing of this request's.
    expect(replacedOf(await tools.call("bm_ask_owner", { ...ask, requestId: "req-20260926T110000Z" }))).toBeNull();
    const project = { workspaceId: ask.workspaceId, question: ask.question, recommendation: ask.recommendation };
    expect(replacedOf(await tools.call("bm_ask_owner", project))).toBeNull();
    expect(createDecisionStore(home).get("o:assessment-6")).toMatchObject({ requestId: null, status: "open" });
    // …and a second one about the whole project replaces the first.
    const again = await tools.call("bm_ask_owner", project);
    expect(replacedOf(again)).toBe("o:assessment-6");
    expect(again.text).toContain("of this project");
    expect(decisions().filter((decision) => decision.status === "open").map((decision) => decision.id)).toEqual([
      "o:assessment-2",
      "o:assessment-4",
      "o:assessment-5",
      "o:assessment-7",
    ]);
  });

  it("refuses what cannot be asked or sent, and stores nothing", async () => {
    const { paseo, sends } = daemonWith(agents());
    const tools = toolsWith(paseo);
    const issues = async (input: Record<string, unknown>) => (await tools.call("bm_ask_owner", { ...ask, ...input })).text;
    const commandTo = (to: string, agentId: string, body = "Carry on with the migration plan.") => ({ options: [{ label: "Go", effects: ["none"], command: { to, agentId, intent: "continue", body } }] });

    expect(await issues({ managerId: WORKER })).toBe(`Refused: ${WORKER} is not a paseo-bm Manager; use a managerId bm_projects gave.`);
    expect(await issues({ workspaceId: "wks_unknown" })).toBe("Refused: no paseo-bm project wks_unknown; use the workspaceId bm_projects gave.");
    expect(await issues({ question: "x".repeat(MAX_DECISION_TEXT_CHARS + 1) })).toContain(`- input.question: must be at most ${MAX_DECISION_TEXT_CHARS} characters`);
    expect(await issues({ recommendation: "x".repeat(501) })).toContain("- input.recommendation: must be at most 500 characters");
    expect(await issues({ question: "x".repeat(950), recommendation: "x".repeat(100) })).toContain("- input.question: with the recommendation it must be at most 982 characters in all");
    expect(await issues({ options: [{ label: "A", effects: ["none"], recommended: true }, { label: "B", effects: ["none"], recommended: true }] })).toContain(
      "- input.options: at most one option is recommended",
    );
    expect(await issues({ options: Array.from({ length: 6 }, () => ({ label: "A", effects: ["none"] })) })).toContain("- input.options: takes at most 5 items");
    expect(await issues({ options: [{ label: "x".repeat(81), effects: ["none"] }] })).toContain("- input.options[0].label: must be at most 80 characters");
    // A prepared command goes only to a live Manager or Worker of this project — never a Reviewer.
    expect(await issues(commandTo("worker", REVIEWER))).toContain(`- input.options[0].command.agentId: ${REVIEWER} is not a paseo-bm Worker; use an id bm_projects or bm_request gave`);
    expect(await issues(commandTo("reviewer", REVIEWER))).toContain("- input.options[0].command.to: must be one of manager, worker");
    expect(await issues(commandTo("worker", MANAGER))).toContain(`${MANAGER} is not a paseo-bm Worker`);
    expect(await issues(commandTo("manager", "agent-manager-other"))).toContain(`Manager agent-manager-other does not belong to project ${WORKSPACE_ID}`);
    expect(await issues(commandTo("manager", "agent-manager-archived"))).toContain("Manager agent-manager-archived is archived; nothing can be sent to it");
    // Its text is checked against the option's effects as a command's is.
    expect(await issues(commandTo("manager", MANAGER, "Push the contract backend to origin/dev."))).toContain(
      "- input.options[0].command: the text shows release that the option's effects do not declare; declare the effect on the option",
    );

    expect(decisions()).toEqual([]);
    expect(filesUnder(join(home, "decisions"))).toEqual([]);
    expect(sends).toEqual([]);
  });
});

describe("the owner's answer to an Orchestrator decision (autonomy design §A.6)", () => {
  const REQUEST = "req-20260929T073348Z";
  const PUSH_BODY = "Push the contract backend to origin/dev; leave the manifest as it is.";
  let agents: Array<Record<string, unknown> & { id: string }>;
  let enqueue: ReturnType<typeof vi.fn<(target: string, kind: string, text: string, paseo?: unknown) => Promise<"sent" | "queued" | "dropped">>>;
  let logs: string[];
  beforeEach(() => {
    agents = [snapshotOf(clean().agents[0]!), snapshotOf(clean().agents[1]!, { status: "running" }), orchestratorAgent];
    enqueue = vi.fn(async (target: string) => (target === WORKER ? ("queued" as const) : ("sent" as const)));
    logs = [];
    deps.queue = { enqueue };
  });
  afterEach(() => clearDecisionStoreCache());

  function setUp() {
    const fake = daemonWith(agents);
    const tools = toolsWith(fake.paseo);
    const onSettled = settledByKind({ orchestrator: createOrchestratorDecisionDelivery({ home: () => home, now: () => NOW, queue: deps.queue, log: (line) => logs.push(line) }) });
    const rpcDeps = { env: { PASEO_BM_HOME: home }, homedir: () => root, now: () => NOW, onSettled };
    const answer = (input: Parameters<typeof handleDecisionsAnswer>[0]) => handleDecisionsAnswer(input, fake.paseo, rpcDeps);
    return { ...fake, tools, answer, onSettled };
  }

  /** The push question of 2026-09-29, with a prepared command on its first option. */
  async function askPush(tools: ReturnType<typeof toolsWith>, to: "manager" | "worker" = "manager"): Promise<string> {
    const result = await tools.call("bm_ask_owner", {
      workspaceId: WORKSPACE_ID,
      requestId: REQUEST,
      question: "Push the contract backend to origin/dev?",
      recommendation: "Push the contract backend only; the manifest needs a hand edit first.",
      subject: "push-backends",
      options: [
        { label: "Push the contract backend", effects: ["push"], recommended: true, command: { to, agentId: to === "manager" ? MANAGER : WORKER, intent: "release", body: PUSH_BODY } },
        { label: "Hold", effects: ["none"] },
      ],
    });
    expect(result.ok).toBe(true);
    return (jsonOf(result) as { decisionId: string }).decisionId;
  }

  const stored = (id: string) => createDecisionStore(home).get(id, WORKSPACE_ID)!;

  it("an option with a prepared command: exactly one v2 command to its Manager, approved = its effects and no limit against them; the grant is spent and the delivery recorded", async () => {
    const { tools, answer, paseo, sends, onSettled } = setUp();
    const id = await askPush(tools);

    const answered = await answer({ id, optionKey: "a", confirmed: true, via: "inbox" });

    expect(enqueue).toHaveBeenCalledTimes(1);
    const [target, kind, text, via] = enqueue.mock.calls[0]!;
    expect([target, kind, via]).toEqual([MANAGER, `command:${id}`, paseo]);
    expect(parseCommandBlock(text)).toEqual({
      version: 2,
      from: "orchestrator",
      via: "tab",
      to: "manager",
      copy: false,
      requestId: REQUEST,
      re: "Push the contract backend",
      intent: "release",
      effects: ["push"],
      authority: `decision:${id}`,
      approved: ["push"],
      limits: ["no-commit", "no-deploy", "no-real-data"],
      body: PUSH_BODY,
      why: `The owner chose "Push the contract backend" on decision ${id}.`,
    });
    expect(answered.decision).toMatchObject({
      status: "answered",
      answer: { via: "inbox", optionKey: "a", words: null },
      grant: { effects: ["push"], usedAt: NOW.toISOString() },
      delivery: { to: MANAGER, kind: `command:${id}`, at: NOW.toISOString(), outcome: "sent" },
    });
    // Delivered once: handing the decision over again sends nothing, and its grant cannot be spent again.
    await onSettled([stored(id)], { paseo });
    expect(enqueue).toHaveBeenCalledTimes(1);
    const again = await tools.call("bm_send_command", { workspaceId: WORKSPACE_ID, managerId: MANAGER, requestId: REQUEST, decisionId: id, intent: "release", effects: ["push"], command: PUSH_BODY, reason: "Again." });
    expect(again.text).toBe(`Refused: the grant of decision ${id} was used at ${NOW.toISOString()}; ask the owner again with bm_ask_owner.`);
    expect(sends).toEqual([]);
  });

  it("a prepared command to a Worker goes to that Worker, and its Manager gets the copy", async () => {
    const { tools, answer } = setUp();
    const id = await askPush(tools, "worker");
    await answer({ id, optionKey: "a", confirmed: true });
    expect(enqueue.mock.calls.map(([target, kind, text]) => [target, kind, parseCommandBlock(text)!.copy, parseCommandBlock(text)!.approved])).toEqual([
      [WORKER, `command:${id}`, false, ["push"]],
      [MANAGER, `command:${id}`, true, ["push"]],
    ]);
    expect(stored(id)).toMatchObject({ grant: { usedAt: NOW.toISOString() }, delivery: { to: WORKER, outcome: "queued" } });
  });

  it("replays 2026-09-29: answered in words, the Orchestrator gets BM-ANSWER with the grant, and its one command on it goes out — one answer, one command", async () => {
    const { tools, answer } = setUp();
    const id = await askPush(tools);
    const words = "Yes, push the contract backend only.\nLeave the manifest to me.";

    await answer({ id, words, confirmed: true, via: "chat-card" });

    expect(enqueue).toHaveBeenCalledTimes(1);
    const [target, kind, notice] = enqueue.mock.calls[0]!;
    expect([target, kind]).toEqual([ORCHESTRATOR, `answer:${id}`]);
    const expires = new Date(NOW.getTime() + GRANT_TTL_MS).toISOString();
    expect(notice).toBe(
      [
        "BM-ANSWER",
        `decisionId: ${id}`,
        `workspaceId: ${WORKSPACE_ID}`,
        `requestId: ${REQUEST}`,
        "question: Push the contract backend to origin/dev?",
        "answer: in the owner's own words, below",
        `grant: push, for one command with decisionId ${id}, until ${expires}`,
        "This is the owner's answer, delivered by the paseo-bm plugin. Act on it now; tell the owner in one line what you did.",
        "",
        words,
      ].join("\n"),
    );
    // A plugin notice: never the owner's own word in the Orchestrator's chat.
    expect(isPluginNotice(notice)).toBe(true);
    expect(isOwnerWord({ type: "user_message", text: notice, clientMessageId: "n-1" })).toBe(false);
    expect(stored(id)).toMatchObject({ grant: { effects: ["push"], usedAt: null }, delivery: { to: ORCHESTRATOR, kind: `answer:${id}`, outcome: "sent" } });

    // The Orchestrator carries it out: one command, on the grant.
    const sent = await tools.call("bm_send_command", {
      workspaceId: WORKSPACE_ID,
      managerId: MANAGER,
      requestId: REQUEST,
      decisionId: id,
      intent: "release",
      effects: ["push"],
      re: "push the contract backend",
      command: PUSH_BODY,
      reason: "The owner answered the push decision.",
    });
    expect(sent.ok).toBe(true);
    expect(enqueue).toHaveBeenCalledTimes(2);
    expect(parseCommandBlock(enqueue.mock.calls[1]![2])).toMatchObject({ to: "manager", authority: `decision:${id}`, approved: ["push"], limits: ["no-commit", "no-deploy", "no-real-data"] });
    expect(stored(id).grant!.usedAt).toBe(NOW.toISOString());
    expect(createDecisionStore(home).list({ workspaceId: WORKSPACE_ID })).toHaveLength(1);
  });

  it("an option without a command: BM-ANSWER names the option and grants nothing; nothing else is sent", async () => {
    const { tools, answer } = setUp();
    const id = await askPush(tools);
    await answer({ id, optionKey: "b" });
    expect(enqueue.mock.calls.map(([target, kind]) => [target, kind])).toEqual([[ORCHESTRATOR, `answer:${id}`]]);
    expect(enqueue.mock.calls[0]![2]).toContain("\nanswer: option b: Hold\ngrant: none\n");
    expect(stored(id)).toMatchObject({ grant: null, delivery: { to: ORCHESTRATOR, outcome: "sent" } });
  });

  it("a prepared command whose Manager is gone: nothing goes to it, the grant stays unused, and the Orchestrator is told why", async () => {
    const { tools, answer, agents: live } = setUp();
    const id = await askPush(tools);
    live.splice(0, 1);

    await answer({ id, optionKey: "a", confirmed: true });

    expect(enqueue.mock.calls.map(([target]) => target)).toEqual([ORCHESTRATOR]);
    expect(enqueue.mock.calls[0]![2]).toContain(
      `delivery: the prepared command was not delivered (${MANAGER} is no longer a live paseo-bm manager of project ${WORKSPACE_ID}); nothing was sent, and the grant is unused`,
    );
    expect(stored(id)).toMatchObject({ grant: { usedAt: null }, delivery: { to: MANAGER, kind: `command:${id}`, outcome: "failed" } });
    expect(logs.join("\n")).toContain("its command was not delivered");
  });

  it("an answer in words with no Orchestrator open: nothing is sent, the delivery is recorded failed, and the answer stands", async () => {
    agents = agents.filter((agent) => agent["id"] !== ORCHESTRATOR);
    const { tools, answer } = setUp();
    const id = await askPush(tools);
    const answered = await answer({ id, words: "Hold for now.", confirmed: true });
    expect(enqueue).not.toHaveBeenCalled();
    expect(answered.decision).toMatchObject({ status: "answered", delivery: { kind: `answer:${id}`, outcome: "failed" } });
    expect(logs.join("\n")).toContain("no Beads Orchestrator is open");
  });

  it("a queue that cannot reach the Manager spends nothing and records the failure", async () => {
    enqueue.mockImplementation(async (target: string) => (target === MANAGER ? "dropped" : "sent"));
    const { tools, answer } = setUp();
    const id = await askPush(tools);
    await answer({ id, optionKey: "a", confirmed: true });
    expect(stored(id)).toMatchObject({ grant: { usedAt: null }, delivery: { to: MANAGER, outcome: "failed" } });
    expect(enqueue.mock.calls.map(([target]) => target)).toEqual([MANAGER, ORCHESTRATOR]);
  });
});

// ---------------------------------------------------------------------------
// One send pipeline (code review 2026-09-30 §2.1, §3.3; bead 81y2.2).
// ---------------------------------------------------------------------------

describe("the loop guard counts every delivered command, whichever way it went (one send pipeline, command-send.ts)", () => {
  const REQUEST = "req-20260930T120000Z";
  const COMMIT_BODY = "Commit the date fix on the feature branch.";
  const SUBJECT = "commit-the-date-fix";
  let enqueue: ReturnType<typeof vi.fn<(target: string, kind: string, text: string, paseo?: unknown) => Promise<"sent" | "queued" | "dropped">>>;
  let logs: string[];

  beforeEach(() => {
    enqueue = vi.fn(async () => "sent" as const);
    logs = [];
    deps.queue = { enqueue };
    // Reversible-technical is delegated to the recommended option: the policy answers a question that recommends one.
    createAutonomyStore(home).set({ workspaceId: WORKSPACE_ID, class: "reversible-technical", mode: "delegate", confirmed: true }, NOW.toISOString());
    // The owner's standing answer on SUBJECT: a question about it is answered by the precedent.
    createPrecedentStore(home, { newId: () => "prec-1" }).save({ scope: WORKSPACE_ID, subject: SUBJECT, text: "Commit the date fix", sourceDecisionId: null, expiresInDays: 30 }, NOW);
  });
  afterEach(() => clearDecisionStoreCache());

  function setUp() {
    const fake = daemonWith([snapshotOf(clean().agents[0]!), snapshotOf(clean().agents[1]!), orchestratorAgent]);
    const onSettled = settledByKind({
      orchestrator: createOrchestratorDecisionDelivery({ home: () => home, now: () => NOW, queue: deps.queue, log: (line) => logs.push(line), store: deps.store }),
    });
    deps.onSettled = onSettled;
    const tools = toolsWith(fake.paseo);
    const rpcDeps = { env: { PASEO_BM_HOME: home }, homedir: () => root, now: () => NOW, onSettled };
    const answer = (input: Parameters<typeof handleDecisionsAnswer>[0]) => handleDecisionsAnswer(input, fake.paseo, rpcDeps);
    return { ...fake, tools, answer, onSettled };
  }

  /** A question on the request whose first option carries the commit command: recommended (the policy answers it), about SUBJECT (the precedent does), or neither (the owner does). */
  async function ask(tools: ReturnType<typeof toolsWith>, by: "owner" | "policy" | "precedent") {
    const result = await tools.call("bm_ask_owner", {
      workspaceId: WORKSPACE_ID,
      requestId: REQUEST,
      separate: true,
      question: "Commit the date fix now?",
      recommendation: "Yes: the review passed.",
      ...(by === "precedent" ? { subject: SUBJECT } : {}),
      options: [
        { label: "Commit the date fix", effects: ["commit"], ...(by === "policy" ? { recommended: true } : {}), command: { to: "manager", agentId: MANAGER, intent: "continue", body: COMMIT_BODY } },
        { label: "Hold", effects: ["none"] },
      ],
    });
    expect(result.ok, result.text).toBe(true);
    return { text: result.text, id: (jsonOf(result) as { decisionId: string }).decisionId };
  }

  const commandsOfRequest = () => createOrchestratorStore(home).listCommands().filter((entry) => entry.requestId === REQUEST);
  const stored = (id: string) => createDecisionStore(home).get(id, WORKSPACE_ID)!;

  /** Twelve commands delivered for the request: six each by the owner's choice and the precedent (the policy answers no o: decision, ADR-025). */
  async function twelveDelivered(setup: ReturnType<typeof setUp>) {
    const paths = ["owner", "precedent"] as const;
    for (let index = 0; index < COMMAND_LIMIT_PER_REQUEST; index += 1) {
      const by = paths[index % 2]!;
      const { id } = await ask(setup.tools, by);
      if (by === "owner") {
        expect(stored(id)).toMatchObject({ status: "open" });
        await setup.answer({ id, optionKey: "a" });
      }
      expect(stored(id)).toMatchObject({ answer: { by }, grant: { usedAt: NOW.toISOString() }, delivery: { to: MANAGER, outcome: "sent" } });
      expect(enqueue).toHaveBeenCalledTimes(index + 1);
    }
  }

  it("each delivered command is in the commands store once, under its own id: the owner's choice and the precedent's", async () => {
    const setup = setUp();
    await twelveDelivered(setup);
    const commands = commandsOfRequest();
    expect(commands).toHaveLength(COMMAND_LIMIT_PER_REQUEST);
    expect(new Set(commands.map((entry) => entry.id)).size).toBe(COMMAND_LIMIT_PER_REQUEST);
    expect(commands.every((entry) => entry.source === "chat" && entry.status === "sent" && entry.managerId === MANAGER && entry.command === COMMIT_BODY)).toBe(true);
    // The block each recorded is the one the Manager got.
    expect(commands.map((entry) => entry.sentText).sort()).toEqual(enqueue.mock.calls.map(([, , text]) => text).sort());
    // Handed over again, a delivered decision sends and records nothing more.
    const first = createDecisionStore(home).list({ workspaceId: WORKSPACE_ID }).find((decision) => decision.answer?.by === "owner")!;
    await setup.onSettled([first], { paseo: setup.paseo });
    expect(enqueue).toHaveBeenCalledTimes(COMMAND_LIMIT_PER_REQUEST);
    expect(commandsOfRequest()).toHaveLength(COMMAND_LIMIT_PER_REQUEST);
  });

  it("negative: after 12 delivered by owner choice and precedent, a 13th for the request is refused on every path the Orchestrator has, and nothing is sent", async () => {
    const setup = setUp();
    await twelveDelivered(setup);
    const refusal = `Refused: ${COMMAND_LIMIT_MESSAGE}.`;

    // bm_send_command and bm_direct_worker, on the policy: refused at the loop guard.
    const send = { workspaceId: WORKSPACE_ID, managerId: MANAGER, requestId: REQUEST, intent: "continue", effects: ["commit"], command: COMMIT_BODY, reason: "Once more." };
    expect(await setup.tools.call("bm_send_command", send)).toEqual({ ok: false, text: refusal });
    const direct = { workspaceId: WORKSPACE_ID, workerId: WORKER, requestId: REQUEST, re: "commit", intent: "continue", effects: ["commit"], command: COMMIT_BODY };
    expect(await setup.tools.call("bm_direct_worker", direct)).toEqual({ ok: false, text: refusal });

    // A question the policy or a precedent would answer is left to the owner: nothing is answered at once, nothing sent.
    const byPolicy = await ask(setup.tools, "policy");
    const byPrecedent = await ask(setup.tools, "precedent");
    for (const asked of [byPolicy, byPrecedent]) {
      expect(asked.text).toMatch(/^Asked\. /);
      expect(asked.text).toContain("12 commands went to this request in 24 hours: the owner answers this one, not a precedent.");
      expect(stored(asked.id)).toMatchObject({ status: "open", answer: null, grant: null });
    }

    // Answered by the policy or a precedent all the same (a race with the guard): the command is not sent, the grant stays unused, and the Orchestrator is told why.
    const at = NOW.toISOString();
    const decisions = createDecisionStore(home);
    decisions.transition(byPolicy.id, (decision) => answerDecision(decision, { by: "policy", via: "inbox", optionKey: "a", class: "reversible-technical", at }), WORKSPACE_ID);
    decisions.transition(byPrecedent.id, (decision) => answerDecision(decision, { by: "precedent", via: "inbox", optionKey: "a", precedentId: "p:prec-1", class: "reversible-technical", at }), WORKSPACE_ID);
    await setup.onSettled([stored(byPolicy.id), stored(byPrecedent.id)], { paseo: setup.paseo });
    for (const id of [byPolicy.id, byPrecedent.id]) {
      expect(stored(id)).toMatchObject({ grant: { usedAt: null }, delivery: { to: MANAGER, kind: `command:${id}`, outcome: "failed" } });
    }
    const notices = enqueue.mock.calls.slice(COMMAND_LIMIT_PER_REQUEST);
    expect(notices.map(([target, kind]) => [target, kind])).toEqual([
      [ORCHESTRATOR, `answer:${byPolicy.id}`],
      [ORCHESTRATOR, `answer:${byPrecedent.id}`],
    ]);
    for (const [, , text] of notices) expect(text).toContain(`delivery: the prepared command was not delivered (${COMMAND_LIMIT_MESSAGE}); nothing was sent, and the grant is unused`);
    expect(commandsOfRequest()).toHaveLength(COMMAND_LIMIT_PER_REQUEST);
    // Another request of the project still has room.
    expect((await setup.tools.call("bm_send_command", { ...send, requestId: "req-20260930T130000Z" })).ok).toBe(true);
  });

  it("the owner's own choice is counted but never refused: the guard sends the Orchestrator to the owner", async () => {
    const setup = setUp();
    await twelveDelivered(setup);
    const { id } = await ask(setup.tools, "owner");
    await setup.answer({ id, optionKey: "a" });
    expect(stored(id)).toMatchObject({ answer: { by: "owner" }, grant: { usedAt: NOW.toISOString() }, delivery: { to: MANAGER, outcome: "sent" } });
    expect(enqueue).toHaveBeenCalledTimes(COMMAND_LIMIT_PER_REQUEST + 1);
    expect(commandsOfRequest()).toHaveLength(COMMAND_LIMIT_PER_REQUEST + 1);
  });
});

// ---------------------------------------------------------------------------
// change-004: the Orchestrator answers a Worker's question through the store.
// ---------------------------------------------------------------------------

describe("bm_decide (autonomy design §B.5, §B.9; bead t9lm.11): the Orchestrator decides a delegated decision for the owner", () => {
  const REQUEST = "req-20260930T031055Z";
  const QID = (n: number) => `q:${REQUEST}:Q${n}`;
  const FID = "f:fb-0123456789ab";
  const REASON = "The owner kept the current layout the last two times.";
  const worker = () => snapshotOf(clean().agents[1]!, { status: "idle", labels: { "bm.role": "worker", "paseo.parent-agent-id": MANAGER, "bm.requestId": REQUEST } });
  /** A Worker's open question: `a` recommended, no effect; `b` the effects under test. */
  const question = (n: number, effects: Decision["options"][number]["effects"] = ["commit"], overrides: Partial<Decision> = {}) =>
    makeDecision({
      id: QID(n),
      workspaceId: WORKSPACE_ID,
      requestId: REQUEST,
      askedBy: { role: "worker", agentId: WORKER },
      askedAt: at(0),
      question: `Question ${n}?`,
      subject: null,
      options: [
        { key: "a", label: "Keep it as it is", recommended: true, effects: ["none"] },
        { key: "b", label: "Change it", recommended: false, effects },
      ],
      ...overrides,
    });
  /** A fallback incident's decision (environment): Wait recommended, or I'll handle it. */
  const incident = () =>
    makeDecision({
      id: FID,
      workspaceId: WORKSPACE_ID,
      requestId: null,
      askedBy: { role: "plugin", agentId: null },
      round: null,
      subject: "fallback-worker",
      options: [
        { key: "a", label: "Wait for the reset", recommended: true, effects: ["none"], action: { kind: "fallback", target: "fb-0123456789ab", action: "wait" } },
        { key: "b", label: "I'll handle it", recommended: false, effects: ["none"], action: { kind: "fallback", target: "fb-0123456789ab", action: "dismiss" } },
      ],
    });
  const bytes = () => readFileSync(join(home, "decisions", `${WORKSPACE_ID}.json`), "utf8");
  const stored = (id: string) => createDecisionStore(home).get(id, WORKSPACE_ID)!;
  const cell = (decisionClass: DecisionClass, mode: "owner" | "shadow" | "delegate") =>
    createAutonomyStore(home).set({ workspaceId: WORKSPACE_ID, class: decisionClass, mode, confirmed: true }, NOW.toISOString());
  let onSettled: ReturnType<typeof vi.fn<(decisions: Decision[], context: { paseo: unknown }) => Promise<void>>>;
  beforeEach(() => {
    onSettled = vi.fn(async () => undefined);
    deps.onSettled = onSettled;
  });
  afterEach(() => clearDecisionStoreCache());

  function decideTools() {
    const fake = daemonWith([snapshotOf(clean().agents[0]!), worker(), orchestratorAgent]);
    return { ...fake, tools: toolsWith(fake.paseo) };
  }
  const decide = (tools: ReturnType<typeof toolsWith>, decisionId: string, optionKey = "b", reason = REASON) => tools.call("bm_decide", { decisionId, optionKey, reason });

  it("answers an open Worker question whose class the owner delegated to it: by policy, its reason, the owner's grant, handed to the owners' delivery", async () => {
    cell("reversible-technical", "delegate");
    createDecisionStore(home).open(question(1));
    const { tools, sends } = decideTools();

    const result = await decide(tools, QID(1), "b", "  Kept short,\n  as the owner asked before.  ");

    expect(result.ok).toBe(true);
    expect(result.text.split("\n")[0]).toBe(
      `Decided Q1 of ${REQUEST} for the owner with option b (Change it), on the owner's policy: reversible-technical is delegated to you in this project. The owner sees your choice and your reason on the decision. The plugin delivers it to the Worker at its next idle moment, as it delivers the owner's answers. Send nothing more for it. Tell the owner in one line what you chose and why.`,
    );
    const expiresAt = new Date(NOW.getTime() + GRANT_TTL_MS).toISOString();
    expect(jsonOf(result)).toEqual({
      decisionId: QID(1),
      optionKey: "b",
      class: "reversible-technical",
      answeredBy: "policy",
      grant: { effects: ["commit"], expiresAt, usedAt: null },
      delivery: null,
    });
    const answered = stored(QID(1));
    expect(answered).toMatchObject({
      status: "answered",
      settledAt: NOW.toISOString(),
      answer: { by: "policy", via: "inbox", optionKey: "b", words: null, at: NOW.toISOString(), class: "reversible-technical", reason: "Kept short, as the owner asked before." },
      grant: { effects: ["commit"], expiresAt, usedAt: null },
    });
    // The delivery the owner's answers take, once; the tool itself sends nothing and records no command.
    expect(onSettled).toHaveBeenCalledTimes(1);
    expect(onSettled.mock.calls[0]![0]).toEqual([answered]);
    expect(sends).toEqual([]);
    expect(createOrchestratorStore(home).listCommands()).toEqual([]);
    // The first answer stands: a second call, or the owner's own answer, is refused.
    expect(await decide(tools, QID(1), "a")).toEqual({ ok: false, text: `Refused: decision ${QID(1)} was already answered by the policy at ${NOW.toISOString()}; the first answer stands.` });
  });

  it("decides a fallback incident when environment is delegated to it: the incident's option goes to the same delivery", async () => {
    cell("environment", "delegate");
    createDecisionStore(home).open(incident());
    const { tools } = decideTools();

    const result = await decide(tools, FID, "a", "The reset is in twenty minutes.");

    expect(result.ok).toBe(true);
    expect(result.text.split("\n")[0]).toBe(
      `Decided fallback incident ${FID} for the owner with option a (Wait for the reset), on the owner's policy: environment is delegated to you in this project. The owner sees your choice and your reason on the decision. The plugin runs the option's action as it runs the owner's choice. Send nothing more for it. Tell the owner in one line what you chose and why.`,
    );
    expect(stored(FID)).toMatchObject({ status: "answered", answer: { by: "policy", optionKey: "a", class: "environment" }, grant: null });
    expect(stored(FID).answer).not.toHaveProperty("predictor");
    expect(onSettled).toHaveBeenCalledTimes(1);
  });

  it("is refused for an owner or shadow cell, writing, delivering and logging nothing; a stored recommended cell reads as the Orchestrator's", async () => {
    createDecisionStore(home).open(question(1));
    const { tools, sends } = decideTools();
    const setups: Array<[string, () => void, string]> = [
      ["owner (no cell)", () => {}, `reversible-technical is not delegated to you in project ${WORKSPACE_ID}; the owner decides it, so leave it to the owner`],
      ["owner (set)", () => cell("reversible-technical", "owner"), `reversible-technical is not delegated to you in project ${WORKSPACE_ID}; the owner decides it, so leave it to the owner`],
      ["shadow", () => cell("reversible-technical", "shadow"), `reversible-technical is not delegated to you in project ${WORKSPACE_ID}; the owner decides it, so leave it to the owner`],
      ["another project only", () => createAutonomyStore(home).set({ workspaceId: OTHER_WORKSPACE, class: "reversible-technical", mode: "delegate", confirmed: true }, NOW.toISOString()), `reversible-technical is not delegated to you in project ${WORKSPACE_ID}; the owner decides it, so leave it to the owner`],
    ];
    const before = bytes();
    for (const [name, setUp, message] of setups) {
      createAutonomyStore(home).reset(WORKSPACE_ID);
      setUp();
      expect(await decide(tools, QID(1)), name).toEqual({ ok: false, text: `Refused: ${message}.` });
    }
    expect(bytes()).toBe(before);
    expect(stored(QID(1))).toMatchObject({ status: "open", answer: null, grant: null, delivery: null });
    expect(onSettled).not.toHaveBeenCalled();
    expect(sends).toEqual([]);
    expect(existsSync(join(home, "orchestrator", "interventions.json"))).toBe(false);
    // A cell an older build stored with the recommended predictor is the Orchestrator's to decide now (ADR-025).
    writeFileSync(
      join(home, "autonomy", "policy.json"),
      JSON.stringify({ version: 1, projects: { [WORKSPACE_ID]: { "reversible-technical": { mode: "delegate", predictor: "recommended", at: NOW.toISOString() } } }, challenger: {} }),
    );
    expect((await decide(tools, QID(1))).ok).toBe(true);
  });

  it("decides release, data, security and cost — by an option's effect or the proposed class — where they are delegated (Full auto, ADR-025), granting the option's effects", async () => {
    for (const decisionClass of DECISION_CLASSES) cell(decisionClass, "delegate");
    const store = createDecisionStore(home);
    const cases: Array<[number, Effect[], Partial<Decision>, string]> = [
      [1, ["push"], {}, "release"],
      [2, ["real-data"], {}, "data"],
      [3, ["security"], {}, "security"],
      [4, ["cost"], {}, "cost"],
      [5, ["migration"], { class: "reversible-technical" }, "data"],
      [6, ["none"], { class: "security" }, "security"],
    ];
    for (const [n, effects, overrides] of cases) store.open(question(n, effects, overrides));
    const { tools } = decideTools();
    for (const [n, effects, , decisionClass] of cases) {
      const result = await decide(tools, QID(n), "b");
      expect(result.ok, `Q${n}: ${result.text}`).toBe(true);
      const granted = effects.filter((effect) => effect !== "none");
      expect(stored(QID(n)), `Q${n}`).toMatchObject({ status: "answered", answer: { by: "policy", optionKey: "b", class: decisionClass }, grant: granted.length === 0 ? null : { effects: granted } });
    }
    expect(onSettled).toHaveBeenCalledTimes(cases.length);
    // At Cruise the same release question is not the Orchestrator's.
    createAutonomyStore(home).setLevel({ workspaceId: WORKSPACE_ID, level: 2 }, NOW.toISOString());
    store.open(question(7, ["push"]));
    expect(await decide(tools, QID(7), "b")).toEqual({ ok: false, text: `Refused: release is not delegated to you in project ${WORKSPACE_ID}; the owner decides it, so leave it to the owner.` });
  });

  it("says why for its own decision, one it does not know, one no longer open, an option it does not have, and a blank reason", async () => {
    cell("reversible-technical", "delegate");
    const store = createDecisionStore(home);
    for (const n of [1, 2, 3, 4, 5, 6]) store.open(question(n));
    store.open(makeDecision({ id: "o:asked-by-you", workspaceId: WORKSPACE_ID, requestId: REQUEST, askedBy: { role: "orchestrator", agentId: ORCHESTRATOR }, round: null, subject: null, options: question(1).options }));
    store.transition(QID(2), (decision) => answerDecision(decision, { via: "inbox", optionKey: "a", at: at(1) }), WORKSPACE_ID);
    store.transition(QID(3), (decision) => markNeedsConfirmation(decision, { via: "chat-worker", at: at(1) }), WORKSPACE_ID);
    store.transition(QID(4), (decision) => supersedeDecision(decision, { by: QID(7), at: at(1) }), WORKSPACE_ID);
    store.transition(QID(5), (decision) => withdrawDecision(decision, { at: at(1) }), WORKSPACE_ID);
    store.transition(QID(6), (decision) => expireDecision(decision, { at: at(1) }), WORKSPACE_ID);
    const { tools } = decideTools();
    const before = bytes();
    const refused = async (decisionId: string, optionKey = "a", reason = "Because.") => (await decide(tools, decisionId, optionKey, reason)).text;

    expect(await refused(QID(2))).toBe(`Refused: decision ${QID(2)} was already answered by the owner at ${at(1)}; the first answer stands.`);
    expect(await refused(QID(3))).toBe(`Refused: decision ${QID(3)} waits for the owner to confirm an answer typed in a chat; it is the owner's.`);
    expect(await refused(QID(4))).toBe(`Refused: decision ${QID(4)} is superseded by ${QID(7)}; answer that one if it is still open.`);
    expect(await refused(QID(5))).toBe(`Refused: decision ${QID(5)} is withdrawn; it can no longer be answered.`);
    expect(await refused(QID(6))).toBe(`Refused: decision ${QID(6)} is expired; it can no longer be answered.`);
    expect(await refused(QID(9))).toBe(`Refused: no decision ${QID(9)}; use a decisionId a decision.opened line or bm_decisions gave.`);
    expect(await refused("o:asked-by-you")).toBe(
      "Refused: o:asked-by-you is your own decision, and only the owner answers it; bm_decide decides a Worker's question (q:…) or a fallback incident (f:…).",
    );
    expect(await refused(QID(1), "c")).toBe(`Refused: decision ${QID(1)} has no option "c"; its options are a, b.`);
    expect(await refused(QID(1), "a", "   ")).toBe("The call was refused. Fix these and call bm_decide again:\n- input.reason: must not be empty");
    expect(bytes()).toBe(before);
    expect(onSettled).not.toHaveBeenCalled();
  });

  it("decideRefusalOf is the rule, pure: the policy and the stored decision only", () => {
    const delegated: AutonomyPolicy = { projects: { [WORKSPACE_ID]: { "reversible-technical": { mode: "delegate", at: "T" } } }, challenger: {} };
    expect(decideRefusalOf(delegated, question(1))).toBeNull();
    expect(decideRefusalOf(EMPTY_AUTONOMY_POLICY, question(1))).toContain("is not delegated to you");
    expect(decideRefusalOf(delegated, question(1, ["commit"], { status: "expired", settledAt: at(1) }))).toContain("is expired");
    expect(decideRefusalOf(delegated, question(1, ["deploy"]))).toContain("release is not delegated to you");
    // A decision the challenger may predict is never one it may decide, and the other way round.
    for (const policy of [delegated, { ...EMPTY_AUTONOMY_POLICY, challenger: { [WORKSPACE_ID]: true } }]) {
      const predictable = question(1, ["commit"], { prediction: { recommended: { optionKey: "a" }, orchestrator: null } });
      expect([decideRefusalOf(policy, predictable), predictionRefusalOf(policy, predictable)].filter((refusal) => refusal === null)).toHaveLength(1);
    }
  });
});

// ---------------------------------------------------------------------------
// The challenger in shadow (autonomy design §B.3, §B.9; change-007 C1).
// ---------------------------------------------------------------------------

describe("bm_predict (autonomy design §B.3, §B.9): the Orchestrator challenger in shadow", () => {
  const REQUEST = "req-20260930T031055Z";
  const QID = (n: number) => `q:${REQUEST}:Q${n}`;
  const FID = "f:fb-0123456789ab";
  const REASON = "The owner kept the current layout the last two times.";
  const optionsOf = (effects: Effect[]): Decision["options"] => [
    { key: "a", label: "Keep it as it is", recommended: true, effects: ["none"] },
    { key: "b", label: "Change it", recommended: false, effects },
  ];
  /** A Worker's open question, opened with its predictions: the recommended `a`, none of the Orchestrator's yet. */
  const question = (n: number, effects: Effect[] = ["commit"], overrides: Partial<Decision> = {}) =>
    makeDecision({
      id: QID(n),
      workspaceId: WORKSPACE_ID,
      requestId: REQUEST,
      askedBy: { role: "worker", agentId: WORKER },
      askedAt: at(0),
      question: `Question ${n}?`,
      subject: null,
      options: optionsOf(effects),
      prediction: { recommended: { optionKey: "a" }, orchestrator: null },
      ...overrides,
    });
  const incident = () =>
    makeDecision({
      id: FID,
      workspaceId: WORKSPACE_ID,
      requestId: null,
      askedBy: { role: "plugin", agentId: null },
      round: null,
      subject: null,
      options: optionsOf(["none"]),
      prediction: { recommended: { optionKey: "a" }, orchestrator: null },
    });
  const stored = (id: string) => createDecisionStore(home).get(id, WORKSPACE_ID)!;
  const bytes = () => readFileSync(join(home, "decisions", `${WORKSPACE_ID}.json`), "utf8");
  const challenger = (enabled: boolean) => createAutonomyStore(home).setChallenger({ workspaceId: WORKSPACE_ID, enabled });
  const cell = (decisionClass: DecisionClass, mode: "owner" | "shadow" | "delegate") =>
    createAutonomyStore(home).set({ workspaceId: WORKSPACE_ID, class: decisionClass, mode, confirmed: true }, NOW.toISOString());
  let onSettled: ReturnType<typeof vi.fn<(decisions: Decision[], context: { paseo: unknown }) => Promise<void>>>;
  beforeEach(() => {
    onSettled = vi.fn(async () => undefined);
    deps.onSettled = onSettled;
    // The prediction's own event is the running wake's: still no intervention is logged for it.
    deps.wakeEventsOf = () => [{ type: "decision.opened", workspaceId: WORKSPACE_ID, requestId: REQUEST, decisionId: QID(1), askedBy: WORKER, asks: "prediction" }];
    challenger(true);
  });
  afterEach(() => clearDecisionStoreCache());

  function predictTools() {
    const fake = daemonWith([snapshotOf(clean().agents[0]!), orchestratorAgent]);
    return { ...fake, tools: toolsWith(fake.paseo) };
  }
  const predict = (tools: ReturnType<typeof toolsWith>, decisionId: string, optionKey = "b", reason = REASON) =>
    tools.call("bm_predict", { decisionId, optionKey, reason });

  it("records the prediction once, on a project whose cells are all owner with the challenger on; it answers, delivers and logs nothing", async () => {
    createDecisionStore(home).open(question(1));
    const { tools, sends } = predictTools();

    const result = await predict(tools, QID(1));

    expect(result.ok).toBe(true);
    expect(result.text.split("\n")[0]).toBe(
      `Recorded your prediction for ${QID(1)}: option b. It answers nothing and went to no agent: the owner decides, and sees it on the decision as your proposal, with your reason. Send nothing for it.`,
    );
    expect(jsonOf(result)).toEqual({ decisionId: QID(1), optionKey: "b", class: "reversible-technical" });
    expect(stored(QID(1))).toMatchObject({
      status: "open",
      settledAt: null,
      answer: null,
      grant: null,
      delivery: null,
      prediction: { recommended: { optionKey: "a" }, orchestrator: { optionKey: "b", reason: REASON, at: NOW.toISOString() } },
    });
    // Nothing answered, delivered, sent or logged: a prediction is not an intervention (design §G.3).
    expect(onSettled).not.toHaveBeenCalled();
    expect(sends).toEqual([]);
    expect(createOrchestratorStore(home).listCommands()).toEqual([]);
    expect(existsSync(join(home, "orchestrator", "interventions.json"))).toBe(false);

    // One prediction per decision: a second is refused and writes nothing.
    const before = bytes();
    expect((await predict(tools, QID(1), "a")).text).toBe(`Refused: you predicted decision ${QID(1)} already, at ${NOW.toISOString()}; one prediction per decision.`);
    expect(bytes()).toBe(before);
  });

  it("predicts in a shadow cell and on a fallback incident too, and masks a secret in the reason", async () => {
    cell("scope", "shadow");
    createDecisionStore(home).open(question(2, ["none"], { class: "scope" }));
    createDecisionStore(home).open(incident());
    const { tools } = predictTools();

    expect(jsonOf(await predict(tools, QID(2), "a"))).toEqual({ decisionId: QID(2), optionKey: "a", class: "scope" });
    expect((await predict(tools, FID, "b", "Waiting is cheaper; --token tok-abc-123 was only a test value.")).ok).toBe(true);
    expect(stored(FID).prediction?.orchestrator).toEqual({ optionKey: "b", reason: `Waiting is cheaper; --token ${REDACTED} was only a test value.`, at: NOW.toISOString() });
    expect(stored(FID).status).toBe("open");
  });

  it("keeps its reason on one line, as bm_decide does (the one write of both, code review 2026-09-30 §3.4)", async () => {
    createDecisionStore(home).open(question(1));
    const { tools } = predictTools();

    expect((await predict(tools, QID(1), "b", "  The owner kept it\n\ttwice   before.  ")).ok).toBe(true);
    expect(stored(QID(1)).prediction?.orchestrator).toEqual({ optionKey: "b", reason: "The owner kept it twice before.", at: NOW.toISOString() });
  });

  it("refuses, writing, answering and sending nothing: a settled decision, a delegate cell, the challenger off, its own decision, and what it cannot name; any class is predicted (ADR-025)", async () => {
    const store = createDecisionStore(home);
    store.open(question(1));
    for (const n of [3, 4, 5, 10]) store.open(question(n));
    store.transition(QID(3), (decision) => answerDecision(decision, { via: "inbox", optionKey: "a", at: at(1) }), WORKSPACE_ID);
    store.transition(QID(4), (decision) => markNeedsConfirmation(decision, { via: "chat-worker", at: at(1) }), WORKSPACE_ID);
    store.transition(QID(5), (decision) => withdrawDecision(decision, { at: at(1) }), WORKSPACE_ID);
    // Expired while open (bead 81y2.26): settled like any other.
    store.transition(QID(10), (decision) => expireDecision(decision, { at: at(1) }), WORKSPACE_ID);
    // Release by its effect, security by its proposed class: predicted like any class (ADR-025), checked last below.
    store.open(question(6, ["push"]));
    store.open(question(7, ["none"], { class: "security" }));
    // A delegated cell is decided, not predicted.
    cell("preference", "delegate");
    store.open(question(8, ["none"], { class: "preference" }));
    // Opened before predictions were recorded: in no cell.
    store.open(question(9, ["commit"], { prediction: undefined }));
    store.open(makeDecision({ id: "o:asked-by-you", workspaceId: WORKSPACE_ID, requestId: REQUEST, askedBy: { role: "orchestrator", agentId: ORCHESTRATOR }, round: null, subject: null }));
    const { tools, sends } = predictTools();
    const before = bytes();
    const refused = async (decisionId: string, optionKey = "b") => (await predict(tools, decisionId, optionKey)).text;

    expect(await refused(QID(3))).toBe(`Refused: decision ${QID(3)} is answered; only an open decision is predicted.`);
    expect(await refused(QID(4))).toBe(`Refused: decision ${QID(4)} waits for the owner to confirm an answer typed in a chat; it is not predicted.`);
    expect(await refused(QID(5))).toBe(`Refused: decision ${QID(5)} is withdrawn; only an open decision is predicted.`);
    expect(await refused(QID(10))).toBe(`Refused: decision ${QID(10)} is expired; only an open decision is predicted.`);
    expect(await refused(QID(8))).toBe(`Refused: preference is delegated in project ${WORKSPACE_ID}; a delegated decision is not predicted.`);
    expect(await refused(QID(9))).toBe(`Refused: decision ${QID(9)} was opened before predictions were recorded; it is not predicted.`);
    expect(await refused("o:asked-by-you", "a")).toBe(
      "Refused: o:asked-by-you is your own decision; a prediction is for a Worker's question (q:…) or a fallback incident (f:…).",
    );
    expect(await refused(QID(1), "z")).toBe(`Refused: decision ${QID(1)} has no option "z"; its options are a, b.`);
    expect(await refused(QID(99))).toBe(`Refused: no decision ${QID(99)}; use a decisionId a decision.opened line gave.`);
    expect(await predict(tools, QID(1), "a", "   ")).toEqual({ ok: false, text: "The call was refused. Fix these and call bm_predict again:\n- input.reason: must not be empty" });
    expect(bytes()).toBe(before);
    // The challenger off (the default, DQ-4): an open question of a delegable owner cell is refused as well.
    challenger(false);
    expect(await refused(QID(1))).toBe(`Refused: the owner has not turned your predictions on for project ${WORKSPACE_ID}.`);
    expect(bytes()).toBe(before);
    expect(onSettled).not.toHaveBeenCalled();
    expect(sends).toEqual([]);
    for (const n of [1, 3, 4, 5, 6, 7, 8, 9, 10]) expect(stored(QID(n)).prediction?.orchestrator ?? null, QID(n)).toBeNull();
    // With the challenger on, the release and security questions are predicted.
    challenger(true);
    expect((await predict(tools, QID(6))).ok).toBe(true);
    expect((await predict(tools, QID(7))).ok).toBe(true);
  });

  it("predictionRefusalOf is the rule, pure: whatever else the project's policy holds, only its challenger and the decision's own cell count", () => {
    const on: AutonomyPolicy = { projects: {}, challenger: { [WORKSPACE_ID]: true } };
    // Every cell owner (nothing stored) with the challenger on: asked (change-007 C1).
    expect(predictionRefusalOf(on, question(1))).toBeNull();
    expect(predictionRefusalOf(on, incident())).toBeNull();
    expect(predictionRefusalOf(EMPTY_AUTONOMY_POLICY, question(1))).toContain("has not turned your predictions on");
    // Another project's challenger is not this one's.
    expect(predictionRefusalOf({ projects: {}, challenger: { [OTHER_WORKSPACE]: true } }, question(1))).toContain("has not turned your predictions on");
    expect(predictionRefusalOf({ projects: {}, challenger: { [WORKSPACE_ID]: false } }, question(1))).toContain("has not turned your predictions on");
    // Another class delegated does not matter; this class delegated does.
    const delegated = (decisionClass: DecisionClass): AutonomyPolicy => ({
      ...on,
      projects: { [WORKSPACE_ID]: { [decisionClass]: { mode: "delegate", at: "T" } } },
    });
    expect(predictionRefusalOf(delegated("scope"), question(1))).toBeNull();
    expect(predictionRefusalOf(delegated("reversible-technical"), question(1))).toContain("is delegated");
    for (const decisionClass of ["release", "data", "security", "cost"] as const) {
      expect(predictionRefusalOf(on, question(1, ["none"], { class: decisionClass })), decisionClass).toBeNull();
    }
  });

  it("the owner sees the prediction as the Orchestrator's proposal while the project's level is 1 or more, and not at level 0; once answered it is there to compare", async () => {
    createDecisionStore(home).open(question(1));
    const { tools, paseo } = predictTools();
    expect((await predict(tools, QID(1))).ok).toBe(true);
    const rpcDeps = { env: deps.env, homedir: deps.homedir, now: () => NOW };
    const hidden = { recommended: { optionKey: "a" }, orchestrator: null };
    const proposal = { recommended: { optionKey: "a" }, orchestrator: { optionKey: "b", reason: REASON, at: NOW.toISOString() } };
    // The prediction switch on (Co-pilot and up): decisions.get and decisions.list carry the proposal, with its reason.
    expect(handleDecisionsGet({ id: QID(1) }, rpcDeps).decision.prediction).toEqual(proposal);
    expect(handleDecisionsList({ scope: "inbox" }, rpcDeps).decisions.map((decision) => decision.prediction)).toEqual([proposal]);
    // Hands-on (the switch off): left out.
    challenger(false);

    const got = handleDecisionsGet({ id: QID(1) }, rpcDeps).decision;
    expect(got.prediction).toEqual(hidden);
    const listed = handleDecisionsList({ scope: "inbox" }, rpcDeps).decisions;
    expect(listed.map((decision) => decision.prediction)).toEqual([hidden]);
    const inbox = inboxView({
      decisions: listed,
      settledHere: [],
      alerts: [],
      incidents: [],
      projectOf: () => "paseo-bm",
      runningWorkers: null,
      can: { openAgent: true, openWorkspace: true },
      now: NOW,
    });
    const item = inbox.needsYou.groups[0]!.items[0]!;
    const cardOf = (decision: Decision) =>
      decisionCardView({ card: item.card, lookup: { state: "found", decision }, agents: [], ui: DECISION_UI_IDLE, cardAt: new Date(decision.askedAt), now: NOW });
    for (const shown of [inbox, cardOf(got)]) expect(JSON.stringify(shown)).not.toContain(REASON);
    // The level is the server's gate: the stored record keeps the prediction, and a card given it shows it as the proposal (change-014).
    expect(stored(QID(1)).prediction?.orchestrator?.reason).toBe(REASON);
    expect(cardOf(stored(QID(1))).proposal).toBe(`Orchestrator: ${REASON}`);

    // Once the owner has answered, the prediction is shown to be compared with the answer.
    await handleDecisionsAnswer({ id: QID(1), optionKey: "a" }, paseo, rpcDeps);
    expect(handleDecisionsGet({ id: QID(1) }, rpcDeps).decision.prediction?.orchestrator).toEqual({ optionKey: "b", reason: REASON, at: NOW.toISOString() });
  });
});

describe("a command never carries the answer to a stored question (change-004)", () => {
  const REQUEST = "req-20260926T100020Z";
  const agents = () => [snapshotOf(clean().agents[0]!), snapshotOf(clean().agents[1]!, { status: "running" }), orchestratorAgent];
  const direct = {
    workspaceId: WORKSPACE_ID,
    workerId: WORKER,
    requestId: REQUEST,
    re: "answer to Q2",
    intent: "answer",
    effects: ["none"],
    command: `BM-ANSWERS\nrequestId: ${REQUEST}\nQ2: a — PDF, A4.`,
    why: "The owner said PDF.",
  };
  const send = { workspaceId: WORKSPACE_ID, managerId: MANAGER, requestId: REQUEST, intent: "answer", effects: ["none"], command: direct.command, reason: "The owner said PDF." };
  const question = (n: number) =>
    makeDecision({ id: `q:${REQUEST}:Q${n}`, workspaceId: WORKSPACE_ID, requestId: REQUEST, askedBy: { role: "worker", agentId: WORKER }, askedAt: at(0), subject: null });
  afterEach(() => clearDecisionStoreCache());

  function commandTools() {
    delegateAll();
    const fake = daemonWith(agents());
    const enqueue = vi.fn(async () => "queued" as const);
    deps.queue = { enqueue };
    return { ...fake, enqueue, tools: toolsWith(fake.paseo) };
  }

  it("refuses a BM-ANSWERS naming an open stored question — answer it with bm_decide — on both tools, sending and recording nothing", async () => {
    createDecisionStore(home).open(question(2));
    const { tools, enqueue } = commandTools();
    const open = `Refused: Q2 of ${REQUEST} is the stored decision q:${REQUEST}:Q2: answer it with bm_decide, not in a BM-ANSWERS block.`;
    expect(await tools.call("bm_direct_worker", direct)).toEqual({ ok: false, text: open });
    expect(await tools.call("bm_send_command", send)).toEqual({ ok: false, text: open });
    // Without its own requestId line, the block is the command's request, or the Worker's.
    const bare = { ...direct, command: "BM-ANSWERS\nQ2: a — PDF, A4." };
    expect((await tools.call("bm_direct_worker", bare)).text).toBe(open);
    const unscoped = { workspaceId: bare.workspaceId, workerId: bare.workerId, re: bare.re, intent: bare.intent, effects: bare.effects, command: bare.command, why: bare.why };
    expect((await tools.call("bm_direct_worker", unscoped)).text).toBe(open);
    expect(enqueue).not.toHaveBeenCalled();
    expect(createOrchestratorStore(home).listCommands()).toEqual([]);
  });

  it("refuses one for a settled question as already answered, naming who; one for a question with no stored decision is sent as before", async () => {
    const store = createDecisionStore(home);
    store.open(question(2));
    store.open(question(3));
    store.transition(`q:${REQUEST}:Q2`, (decision) => storedOrchestratorAnswer(decision, { optionKey: "a", reason: "PDF.", at: at(1) }), WORKSPACE_ID);
    store.transition(`q:${REQUEST}:Q3`, (decision) => answerDecision(decision, { via: "inbox", optionKey: "c", at: at(1) }), WORKSPACE_ID);
    const { tools, enqueue } = commandTools();

    expect((await tools.call("bm_direct_worker", direct)).text).toBe(
      `Refused: Q2 of ${REQUEST} is the stored decision q:${REQUEST}:Q2, already answered by the Orchestrator: the plugin delivers that answer itself, so send nothing for it.`,
    );
    // Every stored question the block names is listed.
    expect((await tools.call("bm_send_command", { ...send, command: `${direct.command}\nQ3: c — Hold.` })).text).toBe(
      `Refused: Q2 of ${REQUEST} is the stored decision q:${REQUEST}:Q2, already answered by the Orchestrator: the plugin delivers that answer itself, so send nothing for it; Q3 of ${REQUEST} is the stored decision q:${REQUEST}:Q3, already answered by the owner: the plugin delivers that answer itself, so send nothing for it.`,
    );
    expect(enqueue).not.toHaveBeenCalled();

    // Q5 has no stored decision: unchanged.
    expect((await tools.call("bm_direct_worker", { ...direct, re: "answer to Q5", command: `BM-ANSWERS\nrequestId: ${REQUEST}\nQ5: PDF, A4.` })).ok).toBe(true);
    expect(enqueue).toHaveBeenCalled();
  });

  it("storedAnswerRefusalOf says what became of a question the owner or the plugin closed", () => {
    expect(storedAnswerRefusalOf("Q2", { ...question(2), status: "needs-confirmation", needsConfirmation: { via: "chat-worker", at: at(1) } })).toBe(
      `Q2 of ${REQUEST} is the stored decision q:${REQUEST}:Q2, waiting for the owner to confirm an answer typed in a chat: it is the owner's`,
    );
    expect(storedAnswerRefusalOf("Q2", { ...question(2), status: "superseded", settledAt: at(1), supersededBy: `q:${REQUEST}:Q4` })).toBe(
      `Q2 of ${REQUEST} is the stored decision q:${REQUEST}:Q2, superseded by q:${REQUEST}:Q4: it can no longer be answered`,
    );
  });
});

describe("firstLine", () => {
  it("keeps a long request on one line, cut with an ellipsis", () => {
    const line = firstLine(`${"x".repeat(500)}\nsecond line`, {});
    expect(line).not.toBeNull();
    expect(line!.includes("\n")).toBe(false);
    expect(line!.endsWith("…")).toBe(true);
    expect(firstLine("\n  short request  \nmore", {})).toBe("short request");
  });
});

// ---------------------------------------------------------------------------
// Design §6B.4 (ADR-016): bm_direct_worker, bm_repo, bm_note, bm_ask_owner options.
// ---------------------------------------------------------------------------

describe("bm_direct_worker (design §6B.4, ADR-016)", () => {
  const agents = () => [
    snapshotOf(clean().agents[0]!),
    snapshotOf(clean().agents[1]!, { status: "running" }),
    snapshotOf(clean().agents[2]!),
    { id: "agent-worker-orphan", provider: "bm-worker", status: "idle", workspaceId: WORKSPACE_ID, labels: { "bm.role": "worker" } },
    { id: "agent-worker-other", provider: "bm-worker", status: "idle", workspaceId: OTHER_WORKSPACE, labels: { "bm.role": "worker" } },
    { id: "agent-worker-archived", provider: "bm-worker", status: "closed", workspaceId: WORKSPACE_ID, labels: { "bm.role": "worker" }, archivedAt: "2026-09-26T11:00:00.000Z" },
    { id: "agent-claude", provider: "claude", status: "idle", workspaceId: WORKSPACE_ID, labels: { "bm.role": "worker" } },
    orchestratorAgent,
  ];
  const direct = {
    workspaceId: WORKSPACE_ID,
    workerId: WORKER,
    requestId: "req-20260926T100020Z",
    re: "answer to Q2",
    intent: "answer",
    effects: ["none"],
    command: "BM-ANSWERS\nrequestId: req-20260926T100020Z\nQ2: PDF, A4.",
    why: "The owner said PDF.",
  };
  /** The block a Worker gets for `direct` on the owner's policy (every delegable class delegated, `delegateAll`). */
  const blockOf = (overrides: Partial<CommandInput> = {}) =>
    commandBlockOf({
      from: "orchestrator",
      via: "chat",
      to: "worker",
      requestId: direct.requestId,
      re: direct.re,
      body: direct.command,
      why: direct.why,
      intent: "answer",
      authority: "policy:reversible-technical",
      ...overrides,
    });

  function directTools(orchestratorTimeline: Entry[] = [], outcome: "sent" | "queued" | "dropped" = "queued") {
    const fake = daemonWith(agents(), { [ORCHESTRATOR]: [orchestratorTimeline] });
    const enqueue = vi.fn<(target: string, kind: string, text: string) => Promise<"sent" | "queued" | "dropped">>(async (target) =>
      target === WORKER ? outcome : "sent",
    );
    deps.queue = { enqueue };
    return { ...fake, enqueue, tools: toolsWith(fake.paseo) };
  }

  it("on the owner's policy: queues the BM-COMMAND to the Worker and a copy: yes to its Manager, and records it to: worker", async () => {
    delegateAll();
    const { tools, enqueue, sends } = directTools();

    const result = await tools.call("bm_direct_worker", direct);

    expect(result.ok).toBe(true);
    expect(result.text.split("\n")[0]).toMatch(/^Queued\. The Worker is busy .* Its Manager agent-manager gets a copy\./);
    expect(enqueue.mock.calls).toEqual([
      [WORKER, "command:proposal-1", blockOf(), expect.anything()],
      [MANAGER, "command:proposal-1", blockOf({ copy: true }), expect.anything()],
    ]);
    expect(parseCommandBlock(enqueue.mock.calls[1]![2])).toMatchObject({ to: "worker", copy: true, limits: ["no-commit-push-deploy", "no-real-data"] });
    expect(jsonOf(result)).toEqual({
      commandId: "proposal-1",
      outcome: "queued",
      interrupted: false,
      managerId: MANAGER,
      copy: "sent",
      authority: "policy:reversible-technical",
      approved: [],
    });
    expect(createOrchestratorStore(home).listCommands()).toEqual([
      expect.objectContaining({
        id: "proposal-1",
        kind: "command",
        to: "worker",
        workerId: WORKER,
        managerId: MANAGER,
        requestId: direct.requestId,
        situation: direct.re,
        command: direct.command,
        reason: direct.why,
        source: "chat",
        sentText: blockOf(),
        outcome: "queued",
      }),
    ]);
    // Nothing is sent directly without an interrupt: the queue does it.
    expect(sends).toEqual([]);
  });

  it("right after the owner's own message it goes out via chat; without either it is refused and sends nothing", async () => {
    const { tools, enqueue } = directTools(OWNER_JUST_SPOKE);
    expect(jsonOf(await tools.call("bm_direct_worker", direct))).toMatchObject({ authority: "owner" });
    expect(parseCommandBlock(enqueue.mock.calls[0]![2])).toMatchObject({ via: "chat", authority: "owner" });

    const quiet = directTools([pluginSays(EVENT_NOTICE, at(0))]);
    expect(await quiet.tools.call("bm_direct_worker", direct)).toEqual({
      ok: false,
      text: `Refused: ${notDelegatedRefusalOf(["reversible-technical"], DIRECT_REFUSED_MESSAGE)}.`,
    });
    expect(quiet.enqueue).not.toHaveBeenCalled();
    expect(quiet.sends).toEqual([]);
  });

  it("on the owner's policy: a Worker command whose classes the owner delegated goes out with policy:<class>, its Manager gets the copy (autonomy design §B.9)", async () => {
    createAutonomyStore(home).set({ workspaceId: WORKSPACE_ID, class: "reversible-technical", mode: "delegate", confirmed: true }, NOW.toISOString());
    const { tools, enqueue, refetches } = directTools([pluginSays(EVENT_NOTICE, at(0))]);
    const result = await tools.call("bm_direct_worker", direct);
    expect(jsonOf(result)).toMatchObject({ authority: "policy:reversible-technical", approved: [] });
    expect(enqueue.mock.calls.map(([target, , text]) => [target, parseCommandBlock(text)])).toEqual([
      [WORKER, expect.objectContaining({ to: "worker", copy: false, via: "chat", authority: "policy:reversible-technical" })],
      [MANAGER, expect.objectContaining({ to: "worker", copy: true, via: "chat", authority: "policy:reversible-technical" })],
    ]);
    // The policy is the authority: the Orchestrator's chat is not read for the owner's word.
    expect(refetches.map(({ id }) => id)).not.toContain(ORCHESTRATOR);
    // A dependency install needs its own class delegated.
    const install = { ...direct, requestId: "req-20260926T100021Z", intent: "continue", effects: ["dependency-install"], command: "npm install date-fns" };
    expect(await tools.call("bm_direct_worker", install)).toEqual({
      ok: false,
      text: `Refused: ${notDelegatedRefusalOf(["dependency"], DIRECT_REFUSED_MESSAGE)}.`,
    });
    expect(enqueue).toHaveBeenCalledTimes(2);
  });

  it("goes to a paseo-bm Worker of that project only — never a Reviewer, a Manager, an archived or another project's Worker", async () => {
    delegateAll();
    const { tools, enqueue, sends } = directTools();
    const refused = async (workerId: string) => (await tools.call("bm_direct_worker", { ...direct, workerId })).text;
    for (const target of [REVIEWER, MANAGER, ORCHESTRATOR, "agent-claude", "agent-gone"]) {
      expect(await refused(target)).toBe(`Refused: ${target} is not a paseo-bm Worker; use a Worker's id from bm_request (a Reviewer is never commanded directly).`);
    }
    expect(await refused("agent-worker-other")).toBe(`Refused: Worker agent-worker-other does not belong to project ${WORKSPACE_ID}.`);
    expect(await refused("agent-worker-archived")).toBe("Refused: Worker agent-worker-archived is archived; nothing can be sent to it.");
    expect(enqueue).not.toHaveBeenCalled();
    expect(sends).toEqual([]);
  });

  it("the backstop refuses an undeclared effect the text shows, and the policy a publish, sending nothing to the Worker or its Manager", async () => {
    delegateAll();
    const { tools, enqueue, sends } = directTools();
    expect(await tools.call("bm_direct_worker", { ...direct, re: "ship it", command: "Run npm install left-pad and publish." })).toEqual({
      ok: false,
      text: "Refused: the text shows release (push, publish or deploy), dependency (dependency-install) that effects does not declare: declare the effect or ask the owner with bm_ask_owner.",
    });
    expect(await tools.call("bm_direct_worker", { ...direct, re: "ship it", effects: ["dependency-install", "publish"], command: "Run npm install left-pad and publish." })).toEqual({
      ok: false,
      text: `Refused: ${needsDecisionMessageOf(["publish"])}.`,
    });
    expect(enqueue).not.toHaveBeenCalled();
    expect(sends).toEqual([]);
    expect(createOrchestratorStore(home).listCommands()).toEqual([]);
  });

  it("interrupt: refused unless the Worker's danger allowance is open; with it, sent at once to the Worker, and the Manager still gets its copy", async () => {
    const store = createOrchestratorStore(home, { now: () => NOW });
    delegateAll();
    const { tools, enqueue, sends, paseo } = directTools();
    const stop = { ...direct, re: "stop at once", command: "Stop. Do not push; wait for the owner.", interrupt: true };

    expect(await tools.call("bm_direct_worker", stop)).toEqual({ ok: false, text: `Refused: ${INTERRUPT_REFUSED_MESSAGE}.` });
    expect(sends).toEqual([]);
    expect(enqueue).not.toHaveBeenCalled();
    // An allowance of another Worker, or one that expired, does not count.
    createOrchestratorStore(home, { now: () => new Date(NOW.getTime() - 11 * 60_000) }).openDangerAllowance(WORKSPACE_ID, WORKER);
    store.openDangerAllowance(WORKSPACE_ID, "agent-worker-orphan");
    expect((await tools.call("bm_direct_worker", stop)).ok).toBe(false);
    expect(sends).toEqual([]);

    store.openDangerAllowance(WORKSPACE_ID, WORKER);
    const result = await tools.call("bm_direct_worker", stop);
    expect(result.ok).toBe(true);
    expect(result.text.split("\n")[0]).toMatch(/^Sent at once: the Worker's running turn was replaced/);
    expect(paseo.agents.ref).toHaveBeenCalledWith(WORKER);
    expect(sends).toEqual([{ id: WORKER, text: blockOf({ re: stop.re, body: stop.command }) }]);
    expect(enqueue.mock.calls).toEqual([[MANAGER, expect.stringMatching(/^command:/), blockOf({ re: stop.re, body: stop.command, copy: true }), expect.anything()]]);
    expect(jsonOf(result)).toMatchObject({ outcome: "sent", interrupted: true, copy: "sent" });
  });

  const RELEASE_UNDECLARED = "the text shows release (push, publish or deploy) that effects does not declare: declare the effect or ask the owner with bm_ask_owner";

  describe("a stop of the Worker's open danger has no exemption any more (autonomy design §B.8)", () => {
    /** The Orchestrator's stop the gate held in the coordination run of 2026-09-29 (F2), word for word. */
    const f2Stop = {
      ...direct,
      re: "stop and report",
      command:
        "Stop what you are doing now: run no more git push and no more waits. Send your report: how many git push runs you made, what git said each time, which steps you didn't run, and confirm that nothing was changed or sent anywhere.",
      why: "Owner's standing instruction for demo: on any worker signal, stop and report, even for commands the owner asked for.",
      intent: "stop",
      interrupt: true,
    };

    it("the run's stop names the push un-negated: refused as release even while that Worker's danger allowance is open, sending nothing", async () => {
      const store = createOrchestratorStore(home, { now: () => NOW });
      delegateAll();
      earlierAutopilotSettings();
      store.openDangerAllowance(WORKSPACE_ID, WORKER);
      const { tools, enqueue, sends } = directTools();
      const refusal = { ok: false, text: `Refused: ${RELEASE_UNDECLARED}.` };
      expect(await tools.call("bm_direct_worker", f2Stop)).toEqual(refusal);
      expect(await tools.call("bm_direct_worker", { ...f2Stop, interrupt: false })).toEqual(refusal);
      expect(enqueue).not.toHaveBeenCalled();
      expect(sends).toEqual([]);
      expect(createOrchestratorStore(home).listCommands()).toEqual([]);
    });

    it("a stop whose stop word negates what it stops passes, at once while the allowance is open", async () => {
      const store = createOrchestratorStore(home, { now: () => NOW });
      delegateAll();
      store.openDangerAllowance(WORKSPACE_ID, WORKER);
      const { tools, enqueue, sends } = directTools();
      const negated = { ...f2Stop, command: "Stop the git push runs and the waits now. Send your report: what git said each time, and which steps you did not run." };
      const result = await tools.call("bm_direct_worker", negated);
      expect(result.ok).toBe(true);
      expect(sends).toEqual([{ id: WORKER, text: blockOf({ re: negated.re, body: negated.command, why: negated.why, intent: "stop" }) }]);
      expect(enqueue.mock.calls.map(([target]) => target)).toEqual([MANAGER]);
      // Any other category is checked as ever.
      expect(await tools.call("bm_direct_worker", { ...direct, re: "stop", command: "Stop pushing; rotate the API token instead.", interrupt: true })).toEqual({
        ok: false,
        text: "Refused: the text shows security (security) that effects does not declare: declare the effect or ask the owner with bm_ask_owner.",
      });
    });
  });

  it("a Worker with no paseo-bm Manager gets it with no copy, recorded with managerId null", async () => {
    delegateAll();
    const { tools, enqueue } = directTools();
    const result = await tools.call("bm_direct_worker", { ...direct, workerId: "agent-worker-orphan" });
    expect(result.text).toContain("The Worker has no paseo-bm Manager, so no copy was sent.");
    expect(enqueue.mock.calls.map(([target]) => target)).toEqual(["agent-worker-orphan"]);
    expect(createOrchestratorStore(home).listCommands()[0]).toMatchObject({ to: "worker", workerId: "agent-worker-orphan", managerId: null });
  });

  it("a Worker that cannot be reached: nothing to its Manager, nothing recorded", async () => {
    delegateAll();
    const { tools, enqueue } = directTools([], "dropped");
    expect(await tools.call("bm_direct_worker", direct)).toEqual({ ok: false, text: `Refused: Worker ${WORKER} could not be reached; nothing was sent.` });
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(createOrchestratorStore(home).listCommands()).toEqual([]);
  });

  it("shares the loop guard with bm_send_command: a 13th command for one request in 24 hours is refused", async () => {
    delegateAll();
    const earlier = createOrchestratorStore(home, { now: () => new Date(NOW.getTime() - 3_600_000) });
    for (let index = 0; index < COMMAND_LIMIT_PER_REQUEST; index += 1) {
      earlier.appendCommand({ workspaceId: WORKSPACE_ID, managerId: MANAGER, requestId: direct.requestId, situation: "", command: "Go on.", reason: "", sentText: "Go on.", outcome: "sent" });
    }
    const { tools, enqueue } = directTools();
    expect(await tools.call("bm_direct_worker", direct)).toEqual({ ok: false, text: `Refused: ${COMMAND_LIMIT_MESSAGE}.` });
    expect(enqueue).not.toHaveBeenCalled();
  });
});

describe("bm_note and the notes bm_projects returns (design §6B.4, §6B.6)", () => {
  it("keeps notes per project, 20 at most, replace empties first, and bm_projects hands them out redacted", async () => {
    await store(smallWithBead().records);
    const { paseo, sends } = daemonWith(smallWithBead().agents.map((facts) => snapshotOf(facts)));
    deps.redactEnv = { PASEO_PASSWORD: SECRET };
    const tools = toolsWith(paseo);

    const first = await tools.call("bm_note", { workspaceId: WORKSPACE_ID, text: `The owner wants PDF only; token ${SECRET} is not ours.` });
    expect(first.ok).toBe(true);
    expect(first.text.split("\n")[0]).toMatch(/^Noted\./);
    for (let index = 0; index < 21; index += 1) await tools.call("bm_note", { workspaceId: WORKSPACE_ID, text: `Note ${index}` });
    expect(createOrchestratorStore(home).readNotes(WORKSPACE_ID)).toHaveLength(20);
    expect(createOrchestratorStore(home).readNotes(WORKSPACE_ID)[0]!.text).toBe("Note 1");

    await tools.call("bm_note", { workspaceId: WORKSPACE_ID, text: `Keep dates dd/mm/yyyy; ${SECRET}.`, replace: true });
    const projects = jsonOf(await tools.call("bm_projects", { detail: "full" })) as { projects: Array<{ workspaceId: string; notes: Array<{ at: string; text: string }> }> };
    expect(projects.projects[0]!.notes).toEqual([{ at: NOW.toISOString(), text: `Keep dates dd/mm/yyyy; ${REDACTED}.` }]);
    expect(JSON.stringify(projects)).not.toContain(SECRET);
    expect(sends).toEqual([]);
  });

  it("refuses an unknown project, an empty or long note, and writes nothing", async () => {
    const { paseo } = daemonWith([]);
    const tools = toolsWith(paseo);
    expect(await tools.call("bm_note", { workspaceId: "wks_unknown", text: "x" })).toEqual({ ok: false, text: "Refused: no paseo-bm project wks_unknown; use the workspaceId bm_projects gave." });
    expect((await tools.call("bm_note", { workspaceId: WORKSPACE_ID, text: "  " })).text).toContain("- input.text: must not be empty");
    expect((await tools.call("bm_note", { workspaceId: WORKSPACE_ID, text: "x".repeat(501) })).text).toContain("- input.text: must be at most 500 characters");
    expect(filesUnder(home)).toEqual([]);
  });
});

describe("bm_repo (design §6B.4): read-only git inside the project's folder", () => {
  const hasGit = (() => {
    try {
      execFileSync("git", ["--version"], { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  })();
  let repo: string;
  const gitIn = (...args: string[]) =>
    execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", ...args], {
      cwd: repo,
      env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
      stdio: "pipe",
    });

  beforeEach(() => {
    repo = join(root, "invoice-app");
    mkdirSync(join(repo, "src"), { recursive: true });
  });

  /** Tools whose Paseo lists the workspace at `repo`, with an injected git when given. */
  function repoTools(git?: GitRunner) {
    const fake = daemonWith([snapshotOf(clean().agents[0]!)], {}, [{ id: WORKSPACE_ID, directory: repo }]);
    if (git !== undefined) deps.git = git;
    return { ...fake, tools: toolsWith(fake.paseo) };
  }

  /** Every file under `dir` with its bytes and modification time. */
  function fingerprint(dir: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const path = join(entry.parentPath, entry.name);
      out[path] = `${statSync(path).mtimeMs}:${readFileSync(path).toString("base64")}`;
    }
    return out;
  }

  it.skipIf(!hasGit)("status, diff-stat, log and show on a real repository, and nothing in it changes", async () => {
    writeFileSync(join(repo, "src", "dates.ts"), "export const FORMAT = 'dd/mm/yyyy';\n");
    writeFileSync(join(repo, ".gitignore"), "local.json\n");
    gitIn("init", "-q", "-b", "main");
    gitIn("add", ".");
    gitIn("commit", "-q", "-m", "Add the date format");
    writeFileSync(join(repo, "src", "dates.ts"), "export const FORMAT = 'yyyy-mm-dd';\n");
    writeFileSync(join(repo, "local.json"), "{}\n");
    const before = fingerprint(repo);
    const { tools } = repoTools();
    deps.redactEnv = {};

    const status = await tools.call("bm_repo", { workspaceId: WORKSPACE_ID, action: "status" });
    expect(status.ok).toBe(true);
    expect(status.text).toMatch(/^git status --short --branch — in \. of project wks_invoice\n\n## main\n M src\/dates\.ts/);
    const diff = await tools.call("bm_repo", { workspaceId: WORKSPACE_ID, action: "diff-stat" });
    expect(diff.text).toContain("Not staged:\n src/dates.ts | 2 +-");
    expect(diff.text).toContain("Staged:\n(nothing)");
    expect((await tools.call("bm_repo", { workspaceId: WORKSPACE_ID, action: "log" })).text).toMatch(/[0-9a-f]{7,} Add the date format/);
    expect((await tools.call("bm_repo", { workspaceId: WORKSPACE_ID, action: "show", file: "HEAD:src/dates.ts" })).text).toContain("'dd/mm/yyyy'");
    expect((await tools.call("bm_repo", { workspaceId: WORKSPACE_ID, action: "show", file: "src/dates.ts" })).text).toContain("'yyyy-mm-dd'");
    // Relative to a sub-folder.
    expect((await tools.call("bm_repo", { workspaceId: WORKSPACE_ID, action: "show", path: "src", file: "HEAD:dates.ts" })).text).toContain("'dd/mm/yyyy'");
    // An ignored file is not read.
    expect((await tools.call("bm_repo", { workspaceId: WORKSPACE_ID, action: "show", file: "local.json" })).text).toBe(
      "Refused: local.json is ignored by git; bm_repo reads only files git tracks or would track.",
    );

    expect(fingerprint(repo)).toEqual(before);
  });

  it("refuses a path or file that leaves the folder, a symlink out of it, .git, a secret file, a large file, and show without a file", async () => {
    const outside = join(root, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "notes.txt"), "outside\n");
    symlinkSync(outside, join(repo, "link-out"));
    writeFileSync(join(repo, ".env"), "TOKEN=abc\n");
    writeFileSync(join(repo, "big.txt"), "x".repeat(200 * 1024 + 1));
    mkdirSync(join(repo, ".git"));
    writeFileSync(join(repo, ".git", "config"), "[remote]\n");
    const git = vi.fn<GitRunner>(async () => ({ stdout: "" }));
    const { tools } = repoTools(git);
    const text = async (input: Record<string, unknown>) => (await tools.call("bm_repo", { workspaceId: WORKSPACE_ID, ...input })).text;

    expect(await text({ action: "status", path: ".." })).toBe("Refused: .. is outside the project's folder.");
    expect(await text({ action: "status", path: "link-out" })).toBe("Refused: link-out is outside the project's folder.");
    expect(await text({ action: "status", path: "missing" })).toBe("Refused: missing (in the project's folder) does not exist.");
    expect(await text({ action: "status", path: ".git" })).toBe("Refused: the .git folder is not readable with bm_repo.");
    expect(await text({ action: "show", file: "../outside/notes.txt" })).toBe("Refused: ../outside/notes.txt is outside the project's folder.");
    expect(await text({ action: "show", file: "HEAD:../outside/notes.txt" })).toBe("Refused: HEAD:../outside/notes.txt is outside the project's folder.");
    expect(await text({ action: "show", file: "link-out/notes.txt" })).toBe("Refused: link-out/notes.txt leads outside the project's folder.");
    expect(await text({ action: "show", file: join(outside, "notes.txt") })).toBe("Refused: file must be a path relative to the folder.");
    expect(await text({ action: "show", file: ".git/config" })).toBe("Refused: the .git folder is not readable with bm_repo.");
    expect(await text({ action: "show", file: ".env" })).toBe("Refused: .env may hold secrets; bm_repo does not read it.");
    expect(await text({ action: "show", file: "HEAD:.env" })).toBe("Refused: HEAD:.env may hold secrets; bm_repo does not read it.");
    expect(await text({ action: "show", file: "big.txt" })).toBe("Refused: big.txt is larger than 200 KB.");
    expect(await text({ action: "show" })).toBe("Refused: show needs file: a path relative to the folder, or HEAD:<path> for its committed version.");
    expect(await text({ action: "push" })).toContain("- input.action: must be one of status, diff-stat, log, show");
    expect(await text({ action: "status", workspaceId: "wks_unknown" })).toBe("Refused: no paseo-bm project wks_unknown; use the workspaceId bm_projects gave.");
    expect(git).not.toHaveBeenCalled();
  });

  it("runs only fixed read-only git commands, each with the read-only prefix; redacts and caps the output; says when git fails or times out", async () => {
    writeFileSync(join(repo, "src", "a.ts"), "export {};\n");
    const calls: Array<readonly string[]> = [];
    const git = vi.fn<GitRunner>(async (args) => {
      calls.push(args);
      if (args.includes("check-ignore")) throw Object.assign(new Error("exit 1"), { code: 1 });
      return { stdout: args.includes("log") ? `abc123 Use ${SECRET}\n${"y".repeat(30_000)}` : "## main\n" };
    });
    const { tools } = repoTools(git);
    deps.redactEnv = { PASEO_PASSWORD: SECRET };
    for (const action of ["status", "diff-stat", "log"]) expect((await tools.call("bm_repo", { workspaceId: WORKSPACE_ID, action })).ok).toBe(true);
    await tools.call("bm_repo", { workspaceId: WORKSPACE_ID, action: "show", file: "HEAD:src/a.ts" });
    expect((await tools.call("bm_repo", { workspaceId: WORKSPACE_ID, action: "show", file: "src/a.ts" })).text).toContain("export {};");
    const log = await tools.call("bm_repo", { workspaceId: WORKSPACE_ID, action: "log" });
    expect(log.text).not.toContain(SECRET);
    expect(log.text).toContain(REDACTED);
    expect(Array.from(log.text.split("\n\n").slice(1).join("\n\n")).length).toBeLessThanOrEqual(REPO_OUTPUT_MAX_CHARS);

    const allowed = new Set(["status", "diff", "log", "show", "check-ignore"]);
    for (const args of calls) {
      expect(args.slice(0, GIT_READ_ONLY_PREFIX.length)).toEqual(GIT_READ_ONLY_PREFIX);
      expect(allowed.has(args[GIT_READ_ONLY_PREFIX.length]!)).toBe(true);
      expect(args.some((arg) => /^(push|fetch|pull|commit|reset|checkout|add|rm|clean|config|remote|gc|merge|rebase|tag|branch)$/.test(arg))).toBe(false);
    }
    expect(calls.map((args) => args.slice(GIT_READ_ONLY_PREFIX.length))).toEqual([
      ["status", "--short", "--branch"],
      ["diff", "--stat", "--no-ext-diff", "--no-textconv"],
      ["diff", "--cached", "--stat", "--no-ext-diff", "--no-textconv"],
      ["log", "--oneline", "-20", "--no-decorate"],
      ["show", "--no-textconv", "HEAD:./src/a.ts"],
      ["check-ignore", "-q", "--", join("src", "a.ts")],
      ["log", "--oneline", "-20", "--no-decorate"],
    ]);

    git.mockRejectedValueOnce(Object.assign(new Error("killed"), { killed: true, signal: "SIGTERM" }));
    expect((await tools.call("bm_repo", { workspaceId: WORKSPACE_ID, action: "status" })).text).toBe("Refused: git status took longer than 10 seconds.");
    git.mockRejectedValueOnce(Object.assign(new Error("exit 128"), { code: 128, stderr: "fatal: not a git repository (or any of the parent directories): .git\n" }));
    expect((await tools.call("bm_repo", { workspaceId: WORKSPACE_ID, action: "log" })).text).toBe(
      "Refused: git log failed: fatal: not a git repository (or any of the parent directories): .git.",
    );
  });
});

describe("the intervention log (autonomy design §G.3)", () => {
  const REQUEST = "req-20260926T100020Z";
  const logFile = () => join(home, "orchestrator", "interventions.json");
  const logged = (): Array<Record<string, unknown>> => {
    try {
      return (JSON.parse(readFileSync(logFile(), "utf8")) as { entries: Array<Record<string, unknown>> }).entries;
    } catch {
      return [];
    }
  };
  const stalled = {
    type: "request.stalled" as const,
    workspaceId: WORKSPACE_ID,
    requestKey: REQUEST,
    managerId: MANAGER,
    reason: "idle-unfinished" as const,
    alertKey: `request-stalled:${WORKSPACE_ID}:${REQUEST}`,
    since: at(0),
  };
  const signal = {
    type: "worker.signal" as const,
    workspaceId: WORKSPACE_ID,
    workerId: WORKER,
    requestKey: REQUEST,
    signal: "danger" as const,
    turnStart: at(0),
    alertKey: `danger:${WORKSPACE_ID}:${WORKER}`,
    since: at(1),
  };
  const send = { workspaceId: WORKSPACE_ID, managerId: MANAGER, requestId: REQUEST, intent: "answer", effects: ["none"], command: "Carry on with the export.", reason: "It stalled." };
  const direct = { workspaceId: WORKSPACE_ID, workerId: WORKER, requestId: REQUEST, re: "carry on", intent: "answer", effects: ["none"], command: "Carry on with the export.", why: "It stalled." };
  /** The events of the Orchestrator's running wake, as the event bus gives them. */
  let wake: unknown[];

  beforeEach(() => {
    wake = [];
    deps.wakeEventsOf = (orchestratorId) => (orchestratorId === ORCHESTRATOR ? (wake as never) : []);
  });

  function loggingTools(timeline: Entry[] = OWNER_JUST_SPOKE) {
    const worker = snapshotOf(clean().agents[1]!, { status: "running" });
    const fake = daemonWith([snapshotOf(clean().agents[0]!), worker, orchestratorAgent], { [ORCHESTRATOR]: [timeline] });
    deps.queue = { enqueue: vi.fn(async () => "queued" as const) };
    return { ...fake, tools: toolsWith(fake.paseo) };
  }

  it("a command answering its wake's request.stalled is an unblock of that stall: pending, at the command's time, with the command's id", async () => {
    wake = [stalled];
    const result = await loggingTools().tools.call("bm_send_command", send);
    expect(result.ok).toBe(true);
    // The id the commands store records it under, and the tool hands out (bead 81y2.2).
    expect(jsonOf(result)).toMatchObject({ commandId: "proposal-1" });
    expect(createOrchestratorStore(home).listCommands().map((entry) => entry.id)).toEqual(["proposal-1"]);
    expect(logged()).toEqual([
      {
        id: expect.any(String),
        kind: "unblock",
        workspaceId: WORKSPACE_ID,
        requestId: REQUEST,
        targetAgentId: MANAGER,
        trigger: "request.stalled",
        expected: "stall-clears",
        windowMs: 15 * 60_000,
        at: NOW.toISOString(),
        outcome: "pending",
        checkedAt: null,
        alertKey: stalled.alertKey,
        commandId: "proposal-1",
      },
    ]);
  });

  it("walks agents.list once per call: the target, the owner's word and the wake's Orchestrator read the same list (code review 2026-09-30 §4)", async () => {
    wake = [stalled];
    const { tools, paseo } = loggingTools();
    expect((await tools.call("bm_send_command", send)).ok).toBe(true);
    expect(paseo.agents.list).toHaveBeenCalledTimes(1);
    expect((await tools.call("bm_direct_worker", direct)).ok).toBe(true);
    expect(paseo.agents.list).toHaveBeenCalledTimes(2);
    expect(logged()).toHaveLength(2);
  });

  it("a command on the owner's word that answers no event is a correction by the owner; one on neither is not logged", async () => {
    expect((await loggingTools().tools.call("bm_send_command", send)).ok).toBe(true);
    expect(logged()).toEqual([expect.objectContaining({ kind: "correct", trigger: "owner", targetAgentId: MANAGER, requestId: REQUEST })]);

    delegateAll();
    wake = [{ ...stalled, requestKey: "req-20260926T110000Z" }];
    const quiet = loggingTools([pluginSays(EVENT_NOTICE, at(0))]);
    expect((await quiet.tools.call("bm_send_command", send)).ok).toBe(true);
    expect(logged()).toHaveLength(1);
  });

  it("bm_direct_worker on its Worker's signal is a correction; with interrupt, a stop", async () => {
    wake = [signal];
    expect((await loggingTools().tools.call("bm_direct_worker", direct)).ok).toBe(true);
    createOrchestratorStore(home, { now: () => NOW }).openDangerAllowance(WORKSPACE_ID, WORKER);
    const stop = { ...direct, re: "stop now", command: "Stop now and wait for the owner.", interrupt: true };
    expect((await loggingTools().tools.call("bm_direct_worker", stop)).ok).toBe(true);
    expect(logged()).toEqual([
      expect.objectContaining({ kind: "correct", trigger: "worker.signal", signal: "danger", alertKey: signal.alertKey, targetAgentId: WORKER, expected: "signal-clears-or-checks-pass" }),
      expect.objectContaining({ kind: "stop", trigger: "worker.signal", signal: "danger", targetAgentId: WORKER, expected: "turn-ends", windowMs: 2 * 60_000 }),
    ]);
    // Each carries the id of the command it is, as the commands store records it (bead 81y2.2).
    const commandIds = createOrchestratorStore(home).listCommands().map((entry) => entry.id).reverse();
    expect(commandIds).toHaveLength(2);
    expect(logged().map((entry) => entry["commandId"])).toEqual(commandIds);
  });

  it("bm_decide logs its answer as an answer intervention, triggered by its wake's decision.opened; a refusal logs nothing (autonomy design §G.3)", async () => {
    const id = `q:${REQUEST}:Q1`;
    const open = (n: number) =>
      createDecisionStore(home).open(
        makeDecision({
          id: `q:${REQUEST}:Q${n}`,
          workspaceId: WORKSPACE_ID,
          requestId: REQUEST,
          askedBy: { role: "worker", agentId: WORKER },
          askedAt: at(0),
          subject: null,
          options: [
            { key: "a", label: "Keep it", recommended: true, effects: ["none"] },
            { key: "b", label: "Change it", recommended: false, effects: ["commit"] },
          ],
        }),
      );
    open(1);
    open(2);
    // Not delegated yet: refused, nothing logged.
    wake = [{ type: "decision.opened", workspaceId: WORKSPACE_ID, requestId: REQUEST, decisionId: id, askedBy: WORKER, asks: "decision" }];
    expect((await loggingTools([]).tools.call("bm_decide", { decisionId: id, optionKey: "a", reason: "Nothing to change." })).ok).toBe(false);
    expect(logged()).toEqual([]);

    createAutonomyStore(home).set({ workspaceId: WORKSPACE_ID, class: "reversible-technical", mode: "delegate", confirmed: true }, NOW.toISOString());
    expect((await loggingTools([]).tools.call("bm_decide", { decisionId: id, optionKey: "a", reason: "Nothing to change." })).ok).toBe(true);
    // Q2 decided on its own look, outside a wake that carried it.
    expect((await loggingTools([]).tools.call("bm_decide", { decisionId: `q:${REQUEST}:Q2`, optionKey: "a", reason: "Same as Q1." })).ok).toBe(true);
    expect(logged()).toEqual([
      {
        id: expect.any(String),
        kind: "answer",
        workspaceId: WORKSPACE_ID,
        requestId: REQUEST,
        targetAgentId: WORKER,
        trigger: "decision.opened",
        expected: expect.any(String),
        windowMs: 10 * 60_000,
        at: NOW.toISOString(),
        outcome: "pending",
        checkedAt: null,
        decisionId: id,
      },
      expect.objectContaining({ kind: "answer", trigger: "orchestrator", decisionId: `q:${REQUEST}:Q2` }),
    ]);
  });

  it("a log that cannot be written costs one log line: the command still goes out and says so", async () => {
    mkdirSync(join(home, "orchestrator"), { recursive: true });
    const newer = JSON.stringify({ version: 2, entries: [] });
    writeFileSync(logFile(), newer);
    const log = vi.fn();
    deps.log = log;
    wake = [stalled];
    const result = await loggingTools().tools.call("bm_send_command", send);
    expect(result.ok).toBe(true);
    expect(jsonOf(result)).toMatchObject({ outcome: "queued" });
    expect(readFileSync(logFile(), "utf8")).toBe(newer);
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/^\[paseo-bm\] could not record the unblock intervention: /));
  });
});
