import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { REDACTED } from "../plugin/server/collector";
import { createOrchestratorTools, type OrchestratorToolsDeps } from "../plugin/server/orchestrator-tools";
import { AGENT_MESSAGE_MAX_CHARS, PROJECTS_BOUNDED_NOTE, REQUEST_BOUNDED_NOTE, agentMessagesBoundedNote } from "../plugin/server/orchestrator-read-tools";
import {
  DIRECT_REFUSED_MESSAGE,
  GOVERNOR_STOP_STEP,
  STOP_NOT_OPEN_MESSAGE,
  STOP_ONLY_MESSAGE,
  governedLadderOf,
  notDelegatedRefusalOf,
  storedAnswerRefusalOf,
} from "../plugin/server/command-authority";
import { createGovernorStore, type FamilyState } from "../plugin/server/governor-store";
import { createInterventionStore } from "../plugin/server/intervention-store";
import { createMissionDecisionStore } from "../plugin/server/mission-decisions";
import { GIT_READ_ONLY_PREFIX, REPO_OUTPUT_MAX_CHARS, type GitRunner } from "../plugin/server/repo-tool";
import type { ServerToolResult } from "../plugin/server/orchestrator-tool-context";
import { ASK_OWNER_OPTION_KEYS, questionIsTheMainsText } from "../plugin/server/orchestrator-decide-tools";
import { firstLine } from "../plugin/server/request-trace";
import { COMMAND_LIMIT_MESSAGE, COMMAND_LIMIT_PER_REQUEST, MISSION_COMMAND_LIMIT_MESSAGE } from "../plugin/server/command-send";
import { isOwnerWord } from "../plugin/server/orchestrator-agent";
import { createOrchestratorStore } from "../plugin/server/orchestrator-store";
import { createAlertStore } from "../plugin/server/alert-store";
import { createAutonomyStore } from "../plugin/server/autonomy-store";
import { createPeerLinkStore } from "../plugin/server/peer-links";
import { createMissionStore } from "../plugin/server/mission-store";
import { clearRequestIndexCache, createMissionRoster } from "../plugin/server/mission-roster";
import { handleOrchestratorState } from "../plugin/server/orchestrator-state";
import { EMPTY_AUTONOMY_POLICY, LEVELS, decideRefusalOf, predictionRefusalOf, type AutonomyPolicy } from "../plugin/shared/autonomy";

/** Cruise's classes (level 2, ADR-025), riskiest first: every class but release, data, security and cost. */
const CRUISE = DECISION_CLASSES.filter((decisionClass) => LEVELS[2]!.delegated.includes(decisionClass));
import { clearDecisionStoreCache, createDecisionStore } from "../plugin/server/decision-store";
import { handleDecisionsAnswer, handleDecisionsGet, settledByKind } from "../plugin/server/decision-rpc";
import { createOrchestratorDecisionDelivery } from "../plugin/server/orchestrator-decisions";
import { createPrecedentStore } from "../plugin/server/precedent-store";
import { isPluginNotice } from "../plugin/shared/notices";
import {
  DECISION_CLASSES,
  MAX_DECISION_TEXT_CHARS,
  answerDecision,
  expireDecision,
  type Decision,
  type DecisionClass,
  type Effect,
} from "../plugin/shared/decisions";
import { makeDecision, storedOrchestratorAnswer } from "./helpers/decisions";
import { appendRecord, clearTraceStoreCache } from "../plugin/server/trace-store";
import type { AgentFacts } from "../plugin/server/traces";
import type { TraceRecord } from "../plugin/shared/contracts";
import { RULE_IDS } from "../plugin/shared/orchestrator";
import { commandBlockOf, parseCommandBlock, type CommandInput } from "../plugin/shared/orchestrator-command";
import { AGENT_MESSAGES_SUMMARY, REQUEST_SUMMARY_MAX_CHARS } from "../plugin/shared/bm-tools";
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

  it("reads the plugin's first prompts as plugin, with or without clientMessageId (design §16.2)", async () => {
    const fixture = clean();
    const prompts: Entry[][] = [
      [
        { item: { type: "user_message", text: "BM-BRIEF manager requestId: none\nBM-HANDOVER\nrole: manager", clientMessageId: "c-1" }, timestamp: at(0) },
        { item: { type: "user_message", text: "BM-HANDOVER\nrole: manager" }, timestamp: at(1) },
        { item: { type: "user_message", text: "Fix the build.", clientMessageId: "c-2" }, timestamp: at(2) },
      ],
    ];
    const { paseo } = daemonWith(fixture.agents.map((facts) => snapshotOf(facts)), { [MANAGER]: prompts });
    const answer = jsonOf(await toolsWith(paseo).call("bm_agent_messages", { agentId: MANAGER, detail: "full" })) as { messages: Array<{ from: string }> };
    expect(answer.messages.map((message) => message.from)).toEqual(["plugin", "plugin", "user"]);
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
      counts: { requests: 1, byState: { completed: 1 }, waitingOnOwner: 0, openStalls: 1, notes: 1, openDecisions: 1, openLinks: 0 },
      openDecisions: [
        { decisionId, requestId: fixture.requestId, askedBy: "orchestrator", status: "open", question: `Publish with ${REDACTED}?`, options: ["Yes", "No"], at: NOW.toISOString() },
      ],
    });
    expect(result.text).not.toContain(SECRET);

    const full = await tools.call("bm_projects", { detail: "full" });
    expect(full.text.startsWith("{")).toBe(true);
    const fullProject = (jsonOf(full) as { projects: Array<Record<string, unknown>> }).projects[0]!;
    expect(Object.keys(fullProject)).toEqual(["workspaceId", "label", "directory", "lastActivityAt", "managers", "notes", "links", "requests"]);
    expect(sends).toEqual([]);
  });

  it("bm_projects: counts each project's live peer links and lists them in full, as bm_peers does (design §7.17.5)", async () => {
    const fixture = smallWithBead();
    await store(fixture.records);
    const { paseo } = daemonWith(fixture.agents.map((facts) => snapshotOf(facts)));
    let n = 0;
    const links = createPeerLinkStore(home, { now: () => NOW, newId: () => `peer-${(++n).toString(16).padStart(12, "0")}`, env: {} });
    const ask = (from: string, to: string) => {
      const made = links.createLink({ kind: "work", from: { workspaceId: from, requestId: fixture.requestId, agentId: WORKER, role: "worker" }, to: { workspaceId: to, managerId: "mgr-x" }, text: "Add the export endpoint." });
      if (!made.ok) throw new Error(made.reasons.join("\n"));
      return made.link.linkId;
    };
    const asked = ask(WORKSPACE_ID, OTHER_WORKSPACE);
    const askedOfUs = ask(OTHER_WORKSPACE, WORKSPACE_ID);
    const closed = ask(WORKSPACE_ID, OTHER_WORKSPACE);
    links.closeLink(closed, "asker");
    ask(OTHER_WORKSPACE, "wks_third");
    const tools = toolsWith(paseo);

    const summary = (jsonOf(await tools.call("bm_projects", {})) as { projects: Array<{ counts: Record<string, unknown> }> }).projects[0]!;
    expect(summary.counts.openLinks).toBe(2);
    const full = (jsonOf(await tools.call("bm_projects", { detail: "full" })) as { projects: Array<{ links: Array<Record<string, unknown>> }> }).projects[0]!;
    expect(full.links.map((link) => [link.linkId, link.direction, link.project, link.state])).toEqual([
      [closed, "asked", OTHER_WORKSPACE, "closed"],
      [askedOfUs, "asked of us", OTHER_WORKSPACE, "open"],
      [asked, "asked", OTHER_WORKSPACE, "open"],
    ]);
    expect(full.links[1]).toEqual({
      linkId: askedOfUs,
      direction: "asked of us",
      project: OTHER_WORKSPACE,
      ourRequestId: null,
      theirRequestId: fixture.requestId,
      state: "open",
      createdAt: NOW.toISOString(),
      newest: null,
    });
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
  it("lists the seventeen tools in order (bm_reply last, change-014; missions design §9.1, §9.6), and answers an unknown name without running anything", async () => {
    const { paseo } = daemonWith([]);
    const tools = toolsWith(paseo);
    expect(tools.faces.map((face) => face.name)).toEqual([
      "bm_projects",
      "bm_missions",
      "bm_request",
      "bm_agent_messages",
      "bm_govern",
      "bm_arbitrate",
      "bm_create_main",
      "bm_decisions",
      "bm_ask_owner",
      "bm_decide",
      "bm_predict",
      "bm_direct_worker",
      "bm_repo",
      "bm_note",
      "bm_findings",
      "bm_why",
      "bm_reply",
    ]);
    expect(tools.has("bm_report")).toBe(false);
    expect(await tools.call("bm_report", {})).toEqual({ ok: false, text: "Unknown tool: bm_report" });
    // Missions design §9.1: replaced by bm_govern, or run by code.
    for (const retired of ["bm_send_command", "bm_compact", "bm_handoff"]) expect(await tools.call(retired, {})).toEqual({ ok: false, text: `Unknown tool: ${retired}` });
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
// Design §6A (ADR-015): bm_ask_owner.
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

  it("refuses to ask a request's review budget, or a subject the Worker's open question of that request already asks (design §7.17.8 a, b)", async () => {
    const { paseo } = daemonWith(agents());
    const tools = toolsWith(paseo);
    const budget = { ...ask, subject: "review-budget", class: "cost" };
    expect((await tools.call("bm_ask_owner", budget)).text).toBe("Refused: the Worker asks for review calls itself, with bm_questions subject review-budget; nothing was stored.");
    expect((await tools.call("bm_ask_owner", { ...budget, subject: "Review budget for the auth fix" })).ok).toBe(false);
    // Another class, or no request, is asked as before.
    expect((await tools.call("bm_ask_owner", { ...budget, class: "scope", separate: true })).ok).toBe(true);
    expect((await tools.call("bm_ask_owner", { workspaceId: ask.workspaceId, question: ask.question, recommendation: ask.recommendation, subject: "review-budget", class: "cost" })).ok).toBe(true);

    const workerQuestion = (status: Decision["status"]) =>
      makeDecision({ id: `q:${REQUEST}:Q4`, workspaceId: WORKSPACE_ID, requestId: REQUEST, askedBy: { role: "worker", agentId: WORKER }, subject: "invoices-table", status });
    createDecisionStore(home).open(workerQuestion("open"));
    expect((await tools.call("bm_ask_owner", { ...ask, subject: "invoices-table" })).text).toBe(
      `Refused: the Worker's question q:${REQUEST}:Q4 of this request asks "invoices-table" already: its Main or the owner answers it; nothing was stored.`,
    );
    // A different subject, or another request, is asked.
    expect((await tools.call("bm_ask_owner", { ...ask, subject: "push-backends", separate: true })).ok).toBe(true);
    expect((await tools.call("bm_ask_owner", { ...ask, requestId: "req-20260926T110000Z", subject: "invoices-table" })).ok).toBe(true);
    expect(decisions().filter((decision) => decision.subject === "invoices-table" && decision.requestId === REQUEST).map((decision) => decision.id)).toEqual([`q:${REQUEST}:Q4`]);
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
    // A prepared command goes only to a live Main or Manager of this project — never a Worker or a Reviewer (missions design §9.1).
    expect(await issues(commandTo("worker", WORKER))).toContain("- input.options[0].command.to: must be one of manager");
    expect(await issues(commandTo("reviewer", REVIEWER))).toContain("- input.options[0].command.to: must be one of manager");
    expect(await issues(commandTo("manager", REVIEWER))).toContain(`- input.options[0].command.agentId: ${REVIEWER} is not a paseo-bm Manager; use an id bm_projects or bm_request gave`);
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
  async function askPush(tools: ReturnType<typeof toolsWith>): Promise<string> {
    const result = await tools.call("bm_ask_owner", {
      workspaceId: WORKSPACE_ID,
      requestId: REQUEST,
      question: "Push the contract backend to origin/dev?",
      recommendation: "Push the contract backend only; the manifest needs a hand edit first.",
      subject: "push-backends",
      options: [
        { label: "Push the contract backend", effects: ["push"], recommended: true, command: { to: "manager", agentId: MANAGER, intent: "release", body: PUSH_BODY } },
        { label: "Hold", effects: ["none"] },
      ],
    });
    expect(result.ok).toBe(true);
    return (jsonOf(result) as { decisionId: string }).decisionId;
  }

  const stored = (id: string) => createDecisionStore(home).get(id, WORKSPACE_ID)!;

  it("an option with a prepared command: exactly one v2 command to its Manager, approving no effect (missions design §9.1: an o: answer grants nothing), every limit kept; the delivery recorded", async () => {
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
      approved: [],
      limits: ["no-commit-push-deploy", "no-real-data"],
      body: PUSH_BODY,
      why: `The owner chose "Push the contract backend" on decision ${id}.`,
    });
    expect(answered.decision).toMatchObject({
      status: "answered",
      answer: { via: "inbox", optionKey: "a", words: null },
      grant: null,
      delivery: { to: MANAGER, kind: `command:${id}`, at: NOW.toISOString(), outcome: "sent" },
    });
    // Delivered once: handing the decision over again sends nothing.
    await onSettled([stored(id)], { paseo });
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(sends).toEqual([]);
  });

  it("a prepared command to a Worker is refused when asked: the Main directs its Workers (missions design §9.1)", async () => {
    const { tools } = setUp();
    const result = await tools.call("bm_ask_owner", {
      workspaceId: WORKSPACE_ID,
      requestId: REQUEST,
      question: "Push the contract backend to origin/dev?",
      recommendation: "Push it.",
      options: [{ label: "Push it", effects: ["push"], command: { to: "worker", agentId: WORKER, intent: "release", body: PUSH_BODY } }],
    });
    expect(result.ok).toBe(false);
    expect(result.text).toContain("- input.options[0].command.to: must be one of manager");
    expect(createDecisionStore(home).list({ workspaceId: WORKSPACE_ID })).toEqual([]);
  });

  it("replays 2026-09-29: answered in words, the Orchestrator gets BM-ANSWER, which issues and announces no grant (missions design §9.1), and nothing else is sent", async () => {
    const { tools, answer } = setUp();
    const id = await askPush(tools);
    const words = "Yes, push the contract backend only.\nLeave the manifest to me.";

    await answer({ id, words, confirmed: true, via: "chat-card" });

    expect(enqueue).toHaveBeenCalledTimes(1);
    const [target, kind, notice] = enqueue.mock.calls[0]!;
    expect([target, kind]).toEqual([ORCHESTRATOR, `answer:${id}`]);
    expect(notice).toBe(
      [
        "BM-ANSWER",
        `decisionId: ${id}`,
        `workspaceId: ${WORKSPACE_ID}`,
        `requestId: ${REQUEST}`,
        "question: Push the contract backend to origin/dev?",
        "answer: in the owner's own words, below",
        "This is the owner's answer, delivered by the paseo-bm plugin. Act on it now; tell the owner in one line what you did.",
        "",
        words,
      ].join("\n"),
    );
    // A plugin notice: never the owner's own word in the Orchestrator's chat.
    expect(isPluginNotice(notice)).toBe(true);
    expect(isOwnerWord({ type: "user_message", text: notice, clientMessageId: "n-1" })).toBe(false);
    expect(stored(id)).toMatchObject({ grant: null, delivery: { to: ORCHESTRATOR, kind: `answer:${id}`, outcome: "sent" } });
    expect(notice).not.toContain("grant");
    expect(createDecisionStore(home).list({ workspaceId: WORKSPACE_ID })).toHaveLength(1);
  });

  it("an option without a command: BM-ANSWER names the option and grants nothing; nothing else is sent", async () => {
    const { tools, answer } = setUp();
    const id = await askPush(tools);
    await answer({ id, optionKey: "b" });
    expect(enqueue.mock.calls.map(([target, kind]) => [target, kind])).toEqual([[ORCHESTRATOR, `answer:${id}`]]);
    expect(enqueue.mock.calls[0]![2]).toContain("\nanswer: option b: Hold\nThis is the owner's answer");
    expect(stored(id)).toMatchObject({ grant: null, delivery: { to: ORCHESTRATOR, outcome: "sent" } });
  });

  it("a prepared command whose Manager is gone: nothing goes to it, and the Orchestrator is told why", async () => {
    const { tools, answer, agents: live } = setUp();
    const id = await askPush(tools);
    live.splice(0, 1);

    await answer({ id, optionKey: "a", confirmed: true });

    expect(enqueue.mock.calls.map(([target]) => target)).toEqual([ORCHESTRATOR]);
    expect(enqueue.mock.calls[0]![2]).toContain(
      `delivery: the prepared command was not delivered (${MANAGER} is no longer a live paseo-bm manager of project ${WORKSPACE_ID}); nothing was sent`,
    );
    expect(stored(id)).toMatchObject({ grant: null, delivery: { to: MANAGER, kind: `command:${id}`, outcome: "failed" } });
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

  it("a queue that cannot reach the Manager records the failure", async () => {
    enqueue.mockImplementation(async (target: string) => (target === MANAGER ? "dropped" : "sent"));
    const { tools, answer } = setUp();
    const id = await askPush(tools);
    await answer({ id, optionKey: "a", confirmed: true });
    expect(stored(id)).toMatchObject({ grant: null, delivery: { to: MANAGER, outcome: "failed" } });
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
      expect(stored(id)).toMatchObject({ answer: { by }, grant: null, delivery: { to: MANAGER, outcome: "sent" } });
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

    // A stop of the request's Worker, on the policy with its danger open: refused at the loop guard.
    createOrchestratorStore(home, { now: () => NOW }).openDangerAllowance(WORKSPACE_ID, WORKER);
    const stop = { workspaceId: WORKSPACE_ID, workerId: WORKER, requestId: REQUEST, re: "stop", intent: "stop", interrupt: true, command: "Stop now and wait for your Main." };
    expect(await setup.tools.call("bm_direct_worker", stop)).toEqual({ ok: false, text: refusal });

    // A question the policy or a precedent would answer is left to the owner: nothing is answered at once, nothing sent.
    const byPolicy = await ask(setup.tools, "policy");
    const byPrecedent = await ask(setup.tools, "precedent");
    for (const asked of [byPolicy, byPrecedent]) {
      expect(asked.text).toMatch(/^Asked\. /);
      expect(asked.text).toContain("12 commands went to this request in 24 hours: the owner answers this one, not a precedent.");
      expect(stored(asked.id)).toMatchObject({ status: "open", answer: null, grant: null });
    }

    // Answered by the policy or a precedent all the same (a race with the guard): the command is not sent, and the Orchestrator is told why.
    const at = NOW.toISOString();
    const decisions = createDecisionStore(home);
    decisions.transition(byPolicy.id, (decision) => answerDecision(decision, { by: "policy", via: "inbox", optionKey: "a", class: "reversible-technical", at }), WORKSPACE_ID);
    decisions.transition(byPrecedent.id, (decision) => answerDecision(decision, { by: "precedent", via: "inbox", optionKey: "a", precedentId: "p:prec-1", class: "reversible-technical", at }), WORKSPACE_ID);
    await setup.onSettled([stored(byPolicy.id), stored(byPrecedent.id)], { paseo: setup.paseo });
    for (const id of [byPolicy.id, byPrecedent.id]) {
      expect(stored(id)).toMatchObject({ grant: null, delivery: { to: MANAGER, kind: `command:${id}`, outcome: "failed" } });
    }
    const notices = enqueue.mock.calls.slice(COMMAND_LIMIT_PER_REQUEST);
    expect(notices.map(([target, kind]) => [target, kind])).toEqual([
      [ORCHESTRATOR, `answer:${byPolicy.id}`],
      [ORCHESTRATOR, `answer:${byPrecedent.id}`],
    ]);
    for (const [, , text] of notices) expect(text).toContain(`delivery: the prepared command was not delivered (${COMMAND_LIMIT_MESSAGE}); nothing was sent`);
    expect(commandsOfRequest()).toHaveLength(COMMAND_LIMIT_PER_REQUEST);
    // Another request of the project still has room.
    expect((await setup.tools.call("bm_direct_worker", { ...stop, requestId: "req-20260930T130000Z" })).ok).toBe(true);
  });

  it("the owner's own choice is counted but never refused: the guard sends the Orchestrator to the owner", async () => {
    const setup = setUp();
    await twelveDelivered(setup);
    const { id } = await ask(setup.tools, "owner");
    await setup.answer({ id, optionKey: "a" });
    expect(stored(id)).toMatchObject({ answer: { by: "owner" }, grant: null, delivery: { to: MANAGER, outcome: "sent" } });
    expect(enqueue).toHaveBeenCalledTimes(COMMAND_LIMIT_PER_REQUEST + 1);
    expect(commandsOfRequest()).toHaveLength(COMMAND_LIMIT_PER_REQUEST + 1);
  });
});

// ---------------------------------------------------------------------------
// change-004: the Orchestrator answers a Worker's question through the store.
// ---------------------------------------------------------------------------

describe("bm_decide (autonomy design §B.5, §B.9; missions design §9.1): the Orchestrator decides a delegated fallback incident for the owner", () => {
  const REQUEST = "req-20260930T031055Z";
  const QID = (n: number) => `q:${REQUEST}:Q${n}`;
  const FID = "f:fb-0123456789ab";
  const FIDN = (n: number) => `f:fb-00000000000${n}`;
  const REASON = "The reset is in twenty minutes.";
  const worker = () => snapshotOf(clean().agents[1]!, { status: "idle", labels: { "bm.role": "worker", "paseo.parent-agent-id": MANAGER, "bm.requestId": REQUEST } });
  /** A Worker's open question: never the Orchestrator's any more (missions design §9.1). */
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
  const incident = (id = FID) =>
    makeDecision({
      id,
      workspaceId: WORKSPACE_ID,
      requestId: null,
      askedBy: { role: "plugin", agentId: null },
      round: null,
      subject: "fallback-worker",
      options: [
        { key: "a", label: "Wait for the reset", recommended: true, effects: ["none"], action: { kind: "fallback", target: id.slice(2), action: "wait" } },
        { key: "b", label: "I'll handle it", recommended: false, effects: ["none"], action: { kind: "fallback", target: id.slice(2), action: "dismiss" } },
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
  const decide = (tools: ReturnType<typeof toolsWith>, decisionId: string, optionKey = "a", reason = REASON) => tools.call("bm_decide", { decisionId, optionKey, reason });

  it("never answers a Worker's question, mission or not, whatever the policy: its Main or the owner does, and nothing is written", async () => {
    for (const decisionClass of DECISION_CLASSES) cell(decisionClass, "delegate");
    createDecisionStore(home).open(question(1));
    const { tools, sends } = decideTools();
    const before = bytes();

    expect(await decide(tools, QID(1), "b")).toEqual({ ok: false, text: `Refused: ${questionIsTheMainsText(QID(1))}.` });
    expect(questionIsTheMainsText(QID(1))).toBe(`${QID(1)} is a Worker's question: its Main answers it (bm_answer_worker), or the owner does, never you; leave it`);
    expect(bytes()).toBe(before);
    expect(stored(QID(1))).toMatchObject({ status: "open", answer: null, grant: null });
    expect(onSettled).not.toHaveBeenCalled();
    expect(sends).toEqual([]);
    expect(existsSync(join(home, "orchestrator", "interventions.json"))).toBe(false);
  });

  it("decides a fallback incident when environment is delegated to it: the incident's option goes to the same delivery", async () => {
    cell("environment", "delegate");
    createDecisionStore(home).open(incident());
    const { tools } = decideTools();

    const result = await decide(tools, FID, "a", "  The reset is in\n  twenty minutes.  ");

    expect(result.ok).toBe(true);
    expect(result.text.split("\n")[0]).toBe(
      `Decided fallback incident ${FID} for the owner with option a (Wait for the reset), on the owner's policy: environment is delegated to you in this project. The owner sees your choice and your reason on the decision. The plugin runs the option's action as it runs the owner's choice. Send nothing more for it. Tell the owner in one line what you chose and why.`,
    );
    expect(jsonOf(result)).toEqual({ decisionId: FID, optionKey: "a", class: "environment", answeredBy: "policy", grant: null, delivery: null });
    expect(stored(FID)).toMatchObject({ status: "answered", answer: { by: "policy", via: "inbox", optionKey: "a", class: "environment", reason: REASON }, grant: null });
    expect(stored(FID).answer).not.toHaveProperty("predictor");
    expect(onSettled).toHaveBeenCalledTimes(1);
    expect(createOrchestratorStore(home).listCommands()).toEqual([]);
    // The first answer stands.
    expect(await decide(tools, FID, "b")).toEqual({ ok: false, text: `Refused: decision ${FID} was already answered by the policy at ${NOW.toISOString()}; the first answer stands.` });
  });

  it("is refused for an owner or shadow cell, writing, delivering and logging nothing; a stored recommended cell reads as the Orchestrator's", async () => {
    createDecisionStore(home).open(incident());
    const { tools, sends } = decideTools();
    const notDelegated = `environment is not delegated to you in project ${WORKSPACE_ID}; the owner decides it, so leave it to the owner`;
    const setups: Array<[string, () => void]> = [
      ["owner (no cell)", () => {}],
      ["owner (set)", () => cell("environment", "owner")],
      ["shadow", () => cell("environment", "shadow")],
      ["another project only", () => createAutonomyStore(home).set({ workspaceId: OTHER_WORKSPACE, class: "environment", mode: "delegate", confirmed: true }, NOW.toISOString())],
    ];
    const before = bytes();
    for (const [name, setUp] of setups) {
      createAutonomyStore(home).reset(WORKSPACE_ID);
      setUp();
      expect(await decide(tools, FID), name).toEqual({ ok: false, text: `Refused: ${notDelegated}.` });
    }
    expect(bytes()).toBe(before);
    expect(stored(FID)).toMatchObject({ status: "open", answer: null, grant: null, delivery: null });
    expect(onSettled).not.toHaveBeenCalled();
    expect(sends).toEqual([]);
    expect(existsSync(join(home, "orchestrator", "interventions.json"))).toBe(false);
    // A cell an older build stored with the recommended predictor is the Orchestrator's to decide now (ADR-025).
    writeFileSync(
      join(home, "autonomy", "policy.json"),
      JSON.stringify({ version: 1, projects: { [WORKSPACE_ID]: { environment: { mode: "delegate", predictor: "recommended", at: NOW.toISOString() } } }, challenger: {} }),
    );
    expect((await decide(tools, FID)).ok).toBe(true);
  });

  it("says why for its own decision, one it does not know, one no longer open, an option it does not have, and a blank reason", async () => {
    cell("environment", "delegate");
    const store = createDecisionStore(home);
    for (const n of [1, 2, 3]) store.open(incident(FIDN(n)));
    store.open(makeDecision({ id: "o:asked-by-you", workspaceId: WORKSPACE_ID, requestId: REQUEST, askedBy: { role: "orchestrator", agentId: ORCHESTRATOR }, round: null, subject: null, options: question(1).options }));
    store.transition(FIDN(2), (decision) => answerDecision(decision, { via: "inbox", optionKey: "a", at: at(1) }), WORKSPACE_ID);
    store.transition(FIDN(3), (decision) => expireDecision(decision, { at: at(1) }), WORKSPACE_ID);
    const { tools } = decideTools();
    const before = bytes();
    const refused = async (decisionId: string, optionKey = "a", reason = "Because.") => (await decide(tools, decisionId, optionKey, reason)).text;

    expect(await refused(FIDN(2))).toBe(`Refused: decision ${FIDN(2)} was already answered by the owner at ${at(1)}; the first answer stands.`);
    expect(await refused(FIDN(3))).toBe(`Refused: decision ${FIDN(3)} is expired; it can no longer be answered.`);
    expect(await refused(FIDN(9))).toBe(`Refused: no decision ${FIDN(9)}; use a decisionId bm_decisions gave.`);
    expect(await refused("o:asked-by-you")).toBe(
      "Refused: o:asked-by-you is your own decision, and only the owner answers it; bm_decide decides a Worker's question (q:…) or a fallback incident (f:…).",
    );
    expect(await refused(FIDN(1), "c")).toBe(`Refused: decision ${FIDN(1)} has no option "c"; its options are a, b.`);
    expect(await refused(FIDN(1), "a", "   ")).toBe("The call was refused. Fix these and call bm_decide again:\n- input.reason: must not be empty");
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

describe("bm_predict (autonomy design §B.3, §B.9; missions design §9.1): the Orchestrator challenger on a fallback incident", () => {
  const REQUEST = "req-20260930T031055Z";
  const QID = (n: number) => `q:${REQUEST}:Q${n}`;
  const FID = (n: number) => `f:fb-00000000000${n}`;
  const REASON = "Waiting is cheaper than a hand fix.";
  const optionsOf = (effects: Effect[]): Decision["options"] => [
    { key: "a", label: "Keep it as it is", recommended: true, effects: ["none"] },
    { key: "b", label: "Change it", recommended: false, effects },
  ];
  /** A Worker's open question, opened with its predictions: never the Orchestrator's to predict any more. */
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
  /** A fallback incident (environment), opened with its predictions. */
  const incident = (n: number, overrides: Partial<Decision> = {}) =>
    makeDecision({
      id: FID(n),
      workspaceId: WORKSPACE_ID,
      requestId: null,
      askedBy: { role: "plugin", agentId: null },
      round: null,
      subject: null,
      options: optionsOf(["none"]),
      prediction: { recommended: { optionKey: "a" }, orchestrator: null },
      ...overrides,
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
    createDecisionStore(home).open(incident(1));
    const { tools, sends } = predictTools();

    const result = await predict(tools, FID(1));

    expect(result.ok).toBe(true);
    expect(result.text.split("\n")[0]).toBe(
      `Recorded your prediction for ${FID(1)}: option b. It answers nothing and went to no agent: the owner decides, and sees it on the decision as your proposal, with your reason. Send nothing for it.`,
    );
    expect(jsonOf(result)).toEqual({ decisionId: FID(1), optionKey: "b", class: "environment" });
    expect(stored(FID(1))).toMatchObject({
      status: "open",
      answer: null,
      prediction: { recommended: { optionKey: "a" }, orchestrator: { optionKey: "b", reason: REASON, at: NOW.toISOString() } },
    });
    // Nothing answered, delivered, sent or logged: a prediction is not an intervention (design §G.3).
    expect(onSettled).not.toHaveBeenCalled();
    expect(sends).toEqual([]);
    expect(createOrchestratorStore(home).listCommands()).toEqual([]);
    expect(existsSync(join(home, "orchestrator", "interventions.json"))).toBe(false);

    // One prediction per decision: a second is refused and writes nothing.
    const before = bytes();
    expect((await predict(tools, FID(1), "a")).text).toBe(`Refused: you predicted decision ${FID(1)} already, at ${NOW.toISOString()}; one prediction per decision.`);
    expect(bytes()).toBe(before);
  });

  it("keeps its reason on one line, as bm_decide does, and masks a secret in it (the one write of both, code review 2026-09-30 §3.4)", async () => {
    cell("environment", "shadow");
    createDecisionStore(home).open(incident(1));
    const { tools } = predictTools();

    expect((await predict(tools, FID(1), "b", "  Waiting is cheaper;\n\t--token tok-abc-123 was only a test value.  ")).ok).toBe(true);
    expect(stored(FID(1)).prediction?.orchestrator).toEqual({ optionKey: "b", reason: `Waiting is cheaper; --token ${REDACTED} was only a test value.`, at: NOW.toISOString() });
  });

  it("refuses, writing, answering and sending nothing: a Worker's question, a settled incident, a delegate cell, the challenger off, its own decision, and what it cannot name", async () => {
    const store = createDecisionStore(home);
    store.open(question(1));
    for (const n of [1, 2, 3]) store.open(incident(n));
    store.open(incident(4, { prediction: undefined }));
    store.transition(FID(2), (decision) => answerDecision(decision, { via: "inbox", optionKey: "a", at: at(1) }), WORKSPACE_ID);
    store.transition(FID(3), (decision) => expireDecision(decision, { at: at(1) }), WORKSPACE_ID);
    store.open(makeDecision({ id: "o:asked-by-you", workspaceId: WORKSPACE_ID, requestId: REQUEST, askedBy: { role: "orchestrator", agentId: ORCHESTRATOR }, round: null, subject: null }));
    const { tools, sends } = predictTools();
    const before = bytes();
    const refused = async (decisionId: string, optionKey = "b") => (await predict(tools, decisionId, optionKey)).text;

    expect(await refused(QID(1))).toBe(`Refused: ${questionIsTheMainsText(QID(1))}.`);
    expect(await refused(FID(2))).toBe(`Refused: decision ${FID(2)} is answered; only an open decision is predicted.`);
    expect(await refused(FID(3))).toBe(`Refused: decision ${FID(3)} is expired; only an open decision is predicted.`);
    expect(await refused(FID(4))).toBe(`Refused: decision ${FID(4)} was opened before predictions were recorded; it is not predicted.`);
    expect(await refused("o:asked-by-you", "a")).toBe(
      "Refused: o:asked-by-you is your own decision; a prediction is for a Worker's question (q:…) or a fallback incident (f:…).",
    );
    expect(await refused(FID(1), "z")).toBe(`Refused: decision ${FID(1)} has no option "z"; its options are a, b.`);
    expect(await refused(FID(9))).toBe(`Refused: no decision ${FID(9)}; use a decisionId bm_decisions gave.`);
    expect(await predict(tools, FID(1), "a", "   ")).toEqual({ ok: false, text: "The call was refused. Fix these and call bm_predict again:\n- input.reason: must not be empty" });
    // A delegated cell is decided, not predicted.
    cell("environment", "delegate");
    expect(await refused(FID(1))).toBe(`Refused: environment is delegated in project ${WORKSPACE_ID}; a delegated decision is not predicted.`);
    createAutonomyStore(home).reset(WORKSPACE_ID);
    // The challenger off (the default, DQ-4).
    challenger(false);
    expect(await refused(FID(1))).toBe(`Refused: the owner has not turned your predictions on for project ${WORKSPACE_ID}.`);
    expect(bytes()).toBe(before);
    expect(onSettled).not.toHaveBeenCalled();
    expect(sends).toEqual([]);
  });

  it("predictionRefusalOf is the rule, pure: whatever else the project's policy holds, only its challenger and the decision's own cell count", () => {
    const on: AutonomyPolicy = { projects: {}, challenger: { [WORKSPACE_ID]: true } };
    // Every cell owner (nothing stored) with the challenger on: asked (change-007 C1).
    expect(predictionRefusalOf(on, question(1))).toBeNull();
    expect(predictionRefusalOf(on, incident(1))).toBeNull();
    expect(predictionRefusalOf(EMPTY_AUTONOMY_POLICY, incident(1))).toContain("has not turned your predictions on");
    // Another project's challenger is not this one's.
    expect(predictionRefusalOf({ projects: {}, challenger: { [OTHER_WORKSPACE]: true } }, incident(1))).toContain("has not turned your predictions on");
    expect(predictionRefusalOf({ projects: {}, challenger: { [WORKSPACE_ID]: false } }, incident(1))).toContain("has not turned your predictions on");
    // Another class delegated does not matter; this class delegated does.
    const delegated = (decisionClass: DecisionClass): AutonomyPolicy => ({
      ...on,
      projects: { [WORKSPACE_ID]: { [decisionClass]: { mode: "delegate", at: "T" } } },
    });
    expect(predictionRefusalOf(delegated("scope"), incident(1))).toBeNull();
    expect(predictionRefusalOf(delegated("environment"), incident(1))).toContain("is delegated");
    for (const decisionClass of ["release", "data", "security", "cost"] as const) {
      expect(predictionRefusalOf(on, question(1, ["none"], { class: decisionClass })), decisionClass).toBeNull();
    }
  });

  it("the owner sees the prediction as the Orchestrator's proposal while the project's level is 1 or more, and not at level 0; once answered it is there to compare", async () => {
    createDecisionStore(home).open(incident(1));
    const { tools, paseo } = predictTools();
    expect((await predict(tools, FID(1))).ok).toBe(true);
    const rpcDeps = { env: deps.env, homedir: deps.homedir, now: () => NOW };
    const hidden = { recommended: { optionKey: "a" }, orchestrator: null };
    const proposal = { recommended: { optionKey: "a" }, orchestrator: { optionKey: "b", reason: REASON, at: NOW.toISOString() } };
    // The prediction switch on (Co-pilot and up): decisions.get carries the proposal, with its reason.
    expect(handleDecisionsGet({ id: FID(1) }, rpcDeps).decision.prediction).toEqual(proposal);
    // Hands-on (the switch off): left out.
    challenger(false);
    expect(handleDecisionsGet({ id: FID(1) }, rpcDeps).decision.prediction).toEqual(hidden);
    // The level is the server's gate: the stored record keeps the prediction.
    expect(stored(FID(1)).prediction?.orchestrator?.reason).toBe(REASON);

    // Once the owner has answered, the prediction is shown to be compared with the answer.
    await handleDecisionsAnswer({ id: FID(1), optionKey: "a" }, paseo, rpcDeps);
    expect(handleDecisionsGet({ id: FID(1) }, rpcDeps).decision.prediction?.orchestrator).toEqual({ optionKey: "b", reason: REASON, at: NOW.toISOString() });
  });
});

describe("a stop never carries the answer to a stored question (change-004)", () => {
  const REQUEST = "req-20260926T100020Z";
  const agents = () => [snapshotOf(clean().agents[0]!), snapshotOf(clean().agents[1]!, { status: "running" }), orchestratorAgent];
  const direct = {
    workspaceId: WORKSPACE_ID,
    workerId: WORKER,
    requestId: REQUEST,
    re: "stop and take the answer",
    intent: "stop",
    interrupt: true,
    command: `BM-ANSWERS\nrequestId: ${REQUEST}\nQ2: a — PDF, A4.`,
    why: "The owner said PDF.",
  };
  const question = (n: number) =>
    makeDecision({ id: `q:${REQUEST}:Q${n}`, workspaceId: WORKSPACE_ID, requestId: REQUEST, askedBy: { role: "worker", agentId: WORKER }, askedAt: at(0), subject: null });
  afterEach(() => clearDecisionStoreCache());

  function commandTools() {
    delegateAll();
    createOrchestratorStore(home, { now: () => NOW }).openDangerAllowance(WORKSPACE_ID, WORKER);
    const fake = daemonWith(agents());
    const enqueue = vi.fn(async () => "queued" as const);
    deps.queue = { enqueue };
    return { ...fake, enqueue, tools: toolsWith(fake.paseo) };
  }

  it("refuses a BM-ANSWERS naming an open stored question — its Main or the owner answers it — sending and recording nothing", async () => {
    createDecisionStore(home).open(question(2));
    const { tools, enqueue, sends } = commandTools();
    const open = `Refused: Q2 of ${REQUEST} is the stored decision q:${REQUEST}:Q2: its Main or the owner answers it, never a BM-ANSWERS block of yours.`;
    expect(await tools.call("bm_direct_worker", direct)).toEqual({ ok: false, text: open });
    // Without its own requestId line, the block is the command's request, or the Worker's.
    const bare = { ...direct, command: "BM-ANSWERS\nQ2: a — PDF, A4." };
    expect((await tools.call("bm_direct_worker", bare)).text).toBe(open);
    const unscoped = { workspaceId: bare.workspaceId, workerId: bare.workerId, re: bare.re, intent: bare.intent, interrupt: true, command: bare.command, why: bare.why };
    expect((await tools.call("bm_direct_worker", unscoped)).text).toBe(open);
    expect(enqueue).not.toHaveBeenCalled();
    expect(sends).toEqual([]);
    expect(createOrchestratorStore(home).listCommands()).toEqual([]);
  });

  it("refuses one for a settled question as already answered, naming who; one for a question with no stored decision is sent as before", async () => {
    const store = createDecisionStore(home);
    store.open(question(2));
    store.open(question(3));
    store.transition(`q:${REQUEST}:Q2`, (decision) => storedOrchestratorAnswer(decision, { optionKey: "a", reason: "PDF.", at: at(1) }), WORKSPACE_ID);
    store.transition(`q:${REQUEST}:Q3`, (decision) => answerDecision(decision, { via: "inbox", optionKey: "c", at: at(1) }), WORKSPACE_ID);
    const { tools, sends } = commandTools();

    // Every stored question the block names is listed.
    expect((await tools.call("bm_direct_worker", { ...direct, command: `${direct.command}\nQ3: c — Hold.` })).text).toBe(
      `Refused: Q2 of ${REQUEST} is the stored decision q:${REQUEST}:Q2, already answered by the Orchestrator: the plugin delivers that answer itself, so send nothing for it; Q3 of ${REQUEST} is the stored decision q:${REQUEST}:Q3, already answered by the owner: the plugin delivers that answer itself, so send nothing for it.`,
    );
    expect(sends).toEqual([]);

    // Q5 has no stored decision: unchanged.
    expect((await tools.call("bm_direct_worker", { ...direct, command: `BM-ANSWERS\nrequestId: ${REQUEST}\nQ5: PDF, A4.` })).ok).toBe(true);
    expect(sends.map(({ id }) => id)).toEqual([WORKER]);
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

describe("bm_direct_worker (design §6B.4, ADR-016; missions design §9.1): only a stop at once", () => {
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
  const stop = {
    workspaceId: WORKSPACE_ID,
    workerId: WORKER,
    requestId: "req-20260926T100020Z",
    re: "stop at once",
    intent: "stop",
    interrupt: true,
    command: "Stop now and wait for your Main; change nothing more.",
    why: "Its danger signal is open.",
  };
  /** The block a Worker gets for `stop` on the owner's policy (`delegateAll`). */
  const blockOf = (overrides: Partial<CommandInput> = {}) =>
    commandBlockOf({
      from: "orchestrator",
      via: "chat",
      to: "worker",
      requestId: stop.requestId,
      re: stop.re,
      body: stop.command,
      why: stop.why,
      intent: "stop",
      authority: "policy:reversible-technical",
      ...overrides,
    });
  const danger = (workerId = WORKER, now = NOW) => createOrchestratorStore(home, { now: () => now }).openDangerAllowance(WORKSPACE_ID, workerId);

  function directTools(orchestratorTimeline: Entry[] = [], outcome: "sent" | "queued" | "dropped" = "sent") {
    const fake = daemonWith(agents(), { [ORCHESTRATOR]: [orchestratorTimeline] });
    const enqueue = vi.fn<(target: string, kind: string, text: string) => Promise<"sent" | "queued" | "dropped">>(async () => outcome);
    deps.queue = { enqueue };
    return { ...fake, enqueue, tools: toolsWith(fake.paseo) };
  }

  it("with the Worker's danger signal open, on the owner's policy: sent at once to the Worker, a copy: yes to its Manager, recorded to: worker", async () => {
    delegateAll();
    danger();
    const { tools, enqueue, sends, paseo } = directTools();

    const result = await tools.call("bm_direct_worker", stop);

    expect(result.ok, result.text).toBe(true);
    expect(result.text.split("\n")[0]).toBe(
      `Stopped: the Worker's running turn was replaced by your command. Its Main ${MANAGER} gets a copy. Tell the owner in one line what you stopped and why.`,
    );
    expect(paseo.agents.ref).toHaveBeenCalledWith(WORKER);
    expect(sends).toEqual([{ id: WORKER, text: blockOf() }]);
    expect(enqueue.mock.calls).toEqual([[MANAGER, "command:proposal-1", blockOf({ copy: true }), expect.anything()]]);
    expect(parseCommandBlock(blockOf())).toMatchObject({ intent: "stop", effects: [], approved: [], limits: ["no-commit-push-deploy", "no-real-data"] });
    expect(jsonOf(result)).toEqual({
      commandId: "proposal-1",
      outcome: "sent",
      interrupted: true,
      managerId: MANAGER,
      copy: "sent",
      authority: "policy:reversible-technical",
      approved: [],
    });
    expect(createOrchestratorStore(home).listCommands()).toEqual([
      expect.objectContaining({ id: "proposal-1", kind: "command", to: "worker", workerId: WORKER, managerId: MANAGER, requestId: stop.requestId, situation: stop.re, command: stop.command, sentText: blockOf(), outcome: "sent" }),
    ]);
  });

  it("refuses anything but a stop at once — another intent, an effect, or interrupt false — and a stop while no danger signal or stop step is open; sending nothing", async () => {
    delegateAll();
    const { tools, enqueue, sends } = directTools();
    expect(await tools.call("bm_direct_worker", { ...stop, interrupt: false })).toEqual({ ok: false, text: `Refused: ${STOP_ONLY_MESSAGE}.` });
    const redirect = await tools.call("bm_direct_worker", { ...stop, intent: "redirect", effects: ["none"] });
    expect(redirect.ok).toBe(false);
    expect(redirect.text).toContain("- input.intent: must be one of stop");
    expect(redirect.text).toContain("- input.effects: is not a field of this tool");
    // No allowance; an allowance of another Worker, or one that expired, does not count.
    expect(await tools.call("bm_direct_worker", stop)).toEqual({ ok: false, text: `Refused: ${STOP_NOT_OPEN_MESSAGE}.` });
    danger("agent-worker-orphan");
    danger(WORKER, new Date(NOW.getTime() - 11 * 60_000));
    expect(await tools.call("bm_direct_worker", stop)).toEqual({ ok: false, text: `Refused: ${STOP_NOT_OPEN_MESSAGE}.` });
    expect(enqueue).not.toHaveBeenCalled();
    expect(sends).toEqual([]);
    expect(createOrchestratorStore(home).listCommands()).toEqual([]);
  });

  it("right after the owner's own message it goes on the owner's word; without the policy or the word it is refused and sends nothing", async () => {
    danger();
    const { tools, sends } = directTools(OWNER_JUST_SPOKE);
    expect(jsonOf(await tools.call("bm_direct_worker", stop))).toMatchObject({ authority: "owner" });
    expect(parseCommandBlock(sends[0]!.text)).toMatchObject({ via: "chat", authority: "owner", intent: "stop" });

    const quiet = directTools([pluginSays(EVENT_NOTICE, at(0))]);
    expect(await quiet.tools.call("bm_direct_worker", stop)).toEqual({
      ok: false,
      text: `Refused: ${notDelegatedRefusalOf(["reversible-technical"], DIRECT_REFUSED_MESSAGE)}.`,
    });
    expect(DIRECT_REFUSED_MESSAGE).toBe("the owner has not just told you to stop it; ask the owner with bm_ask_owner, and once the owner has answered, stop it with that decisionId");
    expect(quiet.enqueue).not.toHaveBeenCalled();
    expect(quiet.sends).toEqual([]);
  });

  it("on the authority of an Orchestrator decision the owner answered (decisionId); an open one, or another's, is refused", async () => {
    danger();
    const asked = (id: string, overrides: Partial<Decision> = {}) =>
      createDecisionStore(home).open(
        makeDecision({ id, workspaceId: WORKSPACE_ID, requestId: stop.requestId, askedBy: { role: "orchestrator", agentId: ORCHESTRATOR }, round: null, subject: null, options: [{ key: "a", label: "Stop it", recommended: true, effects: ["none"] }], ...overrides }),
      );
    asked("o:stop-it");
    asked("o:still-open");
    createDecisionStore(home).transition("o:stop-it", (decision) => answerDecision(decision, { via: "inbox", optionKey: "a", at: at(1) }), WORKSPACE_ID);
    const { tools, sends } = directTools([pluginSays(EVENT_NOTICE, at(0))]);

    expect(jsonOf(await tools.call("bm_direct_worker", { ...stop, decisionId: "o:stop-it" }))).toMatchObject({ authority: "decision:o:stop-it", approved: [] });
    expect(await tools.call("bm_direct_worker", { ...stop, decisionId: "o:still-open" })).toEqual({
      ok: false,
      text: "Refused: decision o:still-open is open; only a decision the owner answered authorises a command.",
    });
    expect(await tools.call("bm_direct_worker", { ...stop, decisionId: `q:${stop.requestId}:Q1` })).toEqual({
      ok: false,
      text: `Refused: q:${stop.requestId}:Q1 is not a decision you asked; decisionId takes the id (o:…) of your own decision the owner answered.`,
    });
    expect(sends.map(({ id }) => id)).toEqual([WORKER]);
    clearDecisionStoreCache();
  });

  it("goes to a paseo-bm Worker of that project only — never a Reviewer, a Manager, an archived or another project's Worker", async () => {
    delegateAll();
    const { tools, enqueue, sends } = directTools();
    const refused = async (workerId: string) => (await tools.call("bm_direct_worker", { ...stop, workerId })).text;
    for (const target of [REVIEWER, MANAGER, ORCHESTRATOR, "agent-claude", "agent-gone"]) {
      expect(await refused(target)).toBe(`Refused: ${target} is not a paseo-bm Worker; use a Worker's id from bm_request (a Reviewer is never commanded directly).`);
    }
    expect(await refused("agent-worker-other")).toBe(`Refused: Worker agent-worker-other does not belong to project ${WORKSPACE_ID}.`);
    expect(await refused("agent-worker-archived")).toBe("Refused: Worker agent-worker-archived is archived; nothing can be sent to it.");
    expect(enqueue).not.toHaveBeenCalled();
    expect(sends).toEqual([]);
  });

  it("the backstop holds on a stop (autonomy design §B.8): one naming the push un-negated is refused even with the danger open; one whose stop word negates it passes", async () => {
    delegateAll();
    earlierAutopilotSettings();
    danger();
    const { tools, sends } = directTools();
    // The Orchestrator's stop the gate held in the coordination run of 2026-09-29 (F2), word for word.
    const f2 = {
      ...stop,
      re: "stop and report",
      command:
        "Stop what you are doing now: run no more git push and no more waits. Send your report: how many git push runs you made, what git said each time, which steps you didn't run, and confirm that nothing was changed or sent anywhere.",
    };
    expect(await tools.call("bm_direct_worker", f2)).toEqual({
      ok: false,
      text: "Refused: the text shows release (push, publish or deploy) that effects does not declare: declare the effect or ask the owner with bm_ask_owner.",
    });
    expect(await tools.call("bm_direct_worker", { ...stop, command: "Stop pushing; rotate the API token instead." })).toEqual({
      ok: false,
      text: "Refused: the text shows security (security) that effects does not declare: declare the effect or ask the owner with bm_ask_owner.",
    });
    expect(sends).toEqual([]);
    const negated = { ...f2, command: "Stop the git push runs and the waits now. Send your report: what git said each time, and which steps you did not run." };
    expect((await tools.call("bm_direct_worker", negated)).ok).toBe(true);
    expect(sends).toEqual([{ id: WORKER, text: blockOf({ re: negated.re, body: negated.command }) }]);
  });

  it("a Worker with no paseo-bm Manager gets it with no copy, recorded with managerId null", async () => {
    delegateAll();
    danger("agent-worker-orphan");
    const { tools, enqueue } = directTools();
    const result = await tools.call("bm_direct_worker", { ...stop, workerId: "agent-worker-orphan" });
    expect(result.text).toContain("The Worker has no paseo-bm Main or Manager, so no copy was sent.");
    expect(enqueue).not.toHaveBeenCalled();
    expect(createOrchestratorStore(home).listCommands()[0]).toMatchObject({ to: "worker", workerId: "agent-worker-orphan", managerId: null });
  });

  it("a Worker that cannot be reached: nothing to its Manager, nothing recorded", async () => {
    delegateAll();
    danger();
    const fake = directTools();
    fake.handle(WORKER).send.mockRejectedValue(new Error("gone"));
    expect(await fake.tools.call("bm_direct_worker", stop)).toEqual({ ok: false, text: `Refused: Worker ${WORKER} could not be reached (gone); nothing was sent.` });
    expect(fake.enqueue).not.toHaveBeenCalled();
    expect(createOrchestratorStore(home).listCommands()).toEqual([]);
  });

  it("shares the loop guard: a 13th command for one request in 24 hours is refused", async () => {
    delegateAll();
    danger();
    const earlier = createOrchestratorStore(home, { now: () => new Date(NOW.getTime() - 3_600_000) });
    for (let index = 0; index < COMMAND_LIMIT_PER_REQUEST; index += 1) {
      earlier.appendCommand({ workspaceId: WORKSPACE_ID, managerId: MANAGER, requestId: stop.requestId, situation: "", command: "Go on.", reason: "", sentText: "Go on.", outcome: "sent" });
    }
    const { tools, sends } = directTools();
    expect(await tools.call("bm_direct_worker", stop)).toEqual({ ok: false, text: `Refused: ${COMMAND_LIMIT_MESSAGE}.` });
    expect(sends).toEqual([]);
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
  const FID = "f:fb-0123456789ab";
  const logFile = () => join(home, "orchestrator", "interventions.json");
  const logged = (): Array<Record<string, unknown>> => {
    try {
      return (JSON.parse(readFileSync(logFile(), "utf8")) as { entries: Array<Record<string, unknown>> }).entries;
    } catch {
      return [];
    }
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
  const stop = { workspaceId: WORKSPACE_ID, workerId: WORKER, requestId: REQUEST, re: "stop now", intent: "stop", interrupt: true, command: "Stop now and wait for your Main.", why: "Its danger signal is open." };
  /** The events of the Orchestrator's running wake, as the event bus gives them. */
  let wake: unknown[];

  beforeEach(() => {
    wake = [];
    deps.wakeEventsOf = (orchestratorId) => (orchestratorId === ORCHESTRATOR ? (wake as never) : []);
    createOrchestratorStore(home, { now: () => NOW }).openDangerAllowance(WORKSPACE_ID, WORKER);
  });

  function loggingTools(timeline: Entry[] = OWNER_JUST_SPOKE) {
    const worker = snapshotOf(clean().agents[1]!, { status: "running" });
    const fake = daemonWith([snapshotOf(clean().agents[0]!), worker, orchestratorAgent], { [ORCHESTRATOR]: [timeline] });
    deps.queue = { enqueue: vi.fn(async () => "queued" as const) };
    return { ...fake, tools: toolsWith(fake.paseo) };
  }

  it("a stop on its Worker's danger signal is a stop of that signal, with the command's id; agents.list is walked once per call (code review 2026-09-30 §4)", async () => {
    wake = [signal];
    const { tools, paseo } = loggingTools();
    const result = await tools.call("bm_direct_worker", stop);
    expect(result.ok, result.text).toBe(true);
    expect(paseo.agents.list).toHaveBeenCalledTimes(1);
    expect(jsonOf(result)).toMatchObject({ commandId: "proposal-1" });
    expect(logged()).toEqual([
      expect.objectContaining({ kind: "stop", trigger: "worker.signal", signal: "danger", targetAgentId: WORKER, expected: "turn-ends", windowMs: 2 * 60_000, commandId: "proposal-1" }),
    ]);
  });

  it("a stop on the owner's word that answers no event is the owner's stop", async () => {
    expect((await loggingTools().tools.call("bm_direct_worker", stop)).ok).toBe(true);
    expect(logged()).toEqual([expect.objectContaining({ kind: "stop", trigger: "owner", targetAgentId: WORKER, requestId: REQUEST })]);
  });

  it("bm_decide logs its answer as an answer intervention, triggered by its wake's decision.opened; a refusal logs nothing (autonomy design §G.3)", async () => {
    const incident = (id: string) =>
      createDecisionStore(home).open(
        makeDecision({
          id,
          workspaceId: WORKSPACE_ID,
          requestId: null,
          askedBy: { role: "plugin", agentId: null },
          round: null,
          subject: "fallback-worker",
          options: [
            { key: "a", label: "Wait for the reset", recommended: true, effects: ["none"], action: { kind: "fallback", target: id.slice(2), action: "wait" } },
            { key: "b", label: "I'll handle it", recommended: false, effects: ["none"], action: { kind: "fallback", target: id.slice(2), action: "dismiss" } },
          ],
        }),
      );
    incident(FID);
    incident("f:fb-000000000002");
    // Not delegated yet: refused, nothing logged.
    wake = [{ type: "decision.opened", workspaceId: WORKSPACE_ID, requestId: null, decisionId: FID, askedBy: null, asks: "decision" }];
    expect((await loggingTools([]).tools.call("bm_decide", { decisionId: FID, optionKey: "a", reason: "The reset is soon." })).ok).toBe(false);
    expect(logged()).toEqual([]);

    createAutonomyStore(home).set({ workspaceId: WORKSPACE_ID, class: "environment", mode: "delegate", confirmed: true }, NOW.toISOString());
    expect((await loggingTools([]).tools.call("bm_decide", { decisionId: FID, optionKey: "a", reason: "The reset is soon." })).ok).toBe(true);
    // The second decided on its own look, outside a wake that carried it.
    expect((await loggingTools([]).tools.call("bm_decide", { decisionId: "f:fb-000000000002", optionKey: "a", reason: "Same reset." })).ok).toBe(true);
    expect(logged()).toEqual([
      expect.objectContaining({ kind: "answer", workspaceId: WORKSPACE_ID, trigger: "decision.opened", decisionId: FID, at: NOW.toISOString(), outcome: "pending" }),
      expect.objectContaining({ kind: "answer", trigger: "orchestrator", decisionId: "f:fb-000000000002" }),
    ]);
  });

  it("a log that cannot be written costs one log line: the command still goes out and says so", async () => {
    mkdirSync(join(home, "orchestrator"), { recursive: true });
    const newer = JSON.stringify({ version: 2, entries: [] });
    writeFileSync(logFile(), newer);
    const log = vi.fn();
    deps.log = log;
    wake = [signal];
    const result = await loggingTools().tools.call("bm_direct_worker", stop);
    expect(result.ok).toBe(true);
    expect(jsonOf(result)).toMatchObject({ outcome: "sent" });
    expect(readFileSync(logFile(), "utf8")).toBe(newer);
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/^\[paseo-bm\] could not record the stop intervention: /));
  });
});

// ---------------------------------------------------------------------------
// Missions design §6 last row (WP-112): Mains live in the Missions home, their requests in repos.
// ---------------------------------------------------------------------------

describe("mission requests: the Orchestrator reaches the request's current Main (missions design §6, WP-112; §9.1, §9.4)", () => {
  const MISSIONS_HOME = "wks_missions";
  const REQUEST = "req-20260926T100020Z";
  const OLD_MAIN = "agent-main-old";
  const MAIN = "agent-main";
  const STRAY_MAIN = "agent-main-stray";
  const MISSION_WORKER = "agent-mission-worker";
  const MISSION = "mis-0000000010";

  /** A mission (Main `OLD_MAIN`, then `MAIN`) whose roster holds `REQUEST` in the repo, and another with no request here (`STRAY_MAIN`). */
  function missions(): void {
    let next = 0;
    const store = createMissionStore(home, { now: () => NOW, newId: () => `mis-00000000${++next}0` });
    const made = store.create({ code: "EXP", name: "Export", goal: "Export invoices.", repos: [WORKSPACE_ID], createdBy: "owner", mainId: OLD_MAIN });
    if (!made.ok) throw new Error(made.reasons.join("; "));
    expect(made.mission.missionId).toBe(MISSION);
    expect(store.setMain(made.mission.missionId, MAIN, "replaced").ok).toBe(true);
    expect(createMissionRoster(home, { now: () => NOW }).add(made.mission.missionId, { requestId: REQUEST, workspaceId: WORKSPACE_ID, topic: "Export", workerId: MISSION_WORKER })).not.toBeNull();
    expect(store.create({ code: "OTHER", name: "Other", goal: "Other work.", repos: [OTHER_WORKSPACE], createdBy: "owner", mainId: STRAY_MAIN }).ok).toBe(true);
  }

  const agents = () => [
    { id: OLD_MAIN, provider: "bm-manager", status: "closed", workspaceId: MISSIONS_HOME, labels: { "bm.role": "manager" }, archivedAt: "2026-09-26T11:00:00.000Z", createdAt: at(0) },
    { id: MAIN, provider: "bm-manager", status: "idle", workspaceId: MISSIONS_HOME, labels: { "bm.role": "manager" }, createdAt: at(5) },
    { id: STRAY_MAIN, provider: "bm-manager", status: "idle", workspaceId: MISSIONS_HOME, labels: { "bm.role": "manager" }, createdAt: at(6) },
    {
      id: MISSION_WORKER,
      provider: "bm-worker",
      status: "running",
      workspaceId: WORKSPACE_ID,
      labels: { "bm.role": "worker", "paseo.parent-agent-id": OLD_MAIN, "bm.requestId": REQUEST },
      createdAt: at(1),
    },
    orchestratorAgent,
  ];
  /** A family's state on the ladder (missions design §9.3). */
  const family = (step: number, lastAction: FamilyState["lastAction"] = null): FamilyState => ({ step, since: at(0), figures: [], lastAction, mainTurnsAt: null });
  const stop = { workspaceId: WORKSPACE_ID, workerId: MISSION_WORKER, re: "stop at once", intent: "stop", interrupt: true, command: "Stop now and wait for your Main.", why: "The governor's re-plan did not hold." };

  let enqueue: ReturnType<typeof vi.fn<(target: string, kind: string, text: string, paseo?: unknown) => Promise<"sent" | "queued" | "dropped">>>;
  beforeEach(() => {
    clearRequestIndexCache();
    missions();
    delegateAll();
    enqueue = vi.fn(async () => "sent" as const);
    deps.queue = { enqueue };
  });
  afterEach(() => {
    clearRequestIndexCache();
    clearDecisionStoreCache();
  });

  const daemon = () => daemonWith(agents(), { [ORCHESTRATOR]: [[pluginSays(EVENT_NOTICE, at(0))]] });
  const tools = () => toolsWith(daemon().paseo);

  it("bm_govern sends the mission's current Main a governor command with no effect and the figures it names, and records it in the journal and on the ladder", async () => {
    createGovernorStore(home).put(MISSION, { mess: family(3), drift: family(1, { at: at(0), kind: "record", id: null }) });
    const text = "Two of your Workers write src/export.ts: say which one owns it, or re-plan.";

    const result = await tools().call("bm_govern", { missionId: MISSION, step: "nudge", text, figures: ["writersOnOneFile"] });

    expect(result.ok, result.text).toBe(true);
    expect(result.text.split("\n")[0]).toBe(`Sent to ${MAIN}, the Main of mission EXP, as a BM-COMMAND on governor:nudge.`);
    expect(enqueue.mock.calls.map(([target, kind]) => [target, kind])).toEqual([[MAIN, "command:proposal-1"]]);
    const block = parseCommandBlock(enqueue.mock.calls[0]![2])!;
    expect(block).toMatchObject({ from: "orchestrator", to: "manager", copy: false, requestId: null, re: "Governor: nudge, mission EXP", intent: "other", effects: [], authority: "governor:nudge", approved: [] });
    expect(block.body.startsWith(text)).toBe(true);
    expect(block.body).toContain("Figures:\n- writersOnOneFile 0 (threshold ≥ ");
    expect(jsonOf(result)).toMatchObject({ commandId: "proposal-1", outcome: "sent", missionId: MISSION, mainId: MAIN });
    expect(createOrchestratorStore(home).listCommands()).toEqual([expect.objectContaining({ id: "proposal-1", managerId: MAIN, requestId: null, missionId: MISSION })]);
    expect(createMissionStore(home).journal(MISSION).at(-1)).toMatchObject({ kind: "governor", by: "orchestrator", text: `nudge: ${text}`, ref: "proposal-1" });
    // Only the family of the named figure records it; a nudge leaves a family at step 3 where it is.
    const ladder = createGovernorStore(home).ladder(MISSION);
    expect(ladder.mess).toMatchObject({ step: 3, lastAction: { at: NOW.toISOString(), kind: "nudge", id: "proposal-1" } });
    expect(ladder.drift).toEqual(family(1, { at: at(0), kind: "record", id: null }));
    // Missions design §9.3: the step is in the intervention log (A-12), with the families it concerns.
    expect(createInterventionStore(home).list()).toMatchObject([
      { kind: "govern", step: "nudge", trigger: "governor", targetAgentId: MAIN, requestId: null, missionId: MISSION, families: ["mess"], commandId: "proposal-1", expected: "figures-clear", outcome: "pending" },
    ]);
  });

  it("a re-plan takes a family at step 3 to the stop step: only then is the mission's Worker stopped without a danger signal, its Main copied", async () => {
    createGovernorStore(home).put(MISSION, { overengineering: family(3) });
    expect(await tools().call("bm_direct_worker", stop)).toEqual({ ok: false, text: `Refused: ${STOP_NOT_OPEN_MESSAGE}.` });

    expect((await tools().call("bm_govern", { missionId: MISSION, step: "replan", text: "Your plan grew past its criteria: cut it back to D1 and D2." })).ok).toBe(true);
    expect(createGovernorStore(home).ladder(MISSION).overengineering).toMatchObject({ step: 4, lastAction: { kind: "replan", id: "proposal-1" } });

    const fake = daemon();
    const stopped = await toolsWith(fake.paseo).call("bm_direct_worker", stop);
    expect(stopped.ok, stopped.text).toBe(true);
    expect(fake.sends.map(({ id }) => id)).toEqual([MISSION_WORKER]);
    expect(enqueue.mock.calls.map(([target]) => target)).toEqual([MAIN, MAIN]);
    expect(jsonOf(stopped)).toMatchObject({ managerId: MAIN, copy: "sent", interrupted: true });
    // Missions design §9.3: the re-plan and the stop it opened, each in the intervention log with trigger governor.
    expect(createInterventionStore(home).list()).toMatchObject([
      { kind: "govern", step: "replan", trigger: "governor", targetAgentId: MAIN, missionId: MISSION, families: ["overengineering"], commandId: "proposal-1" },
      { kind: "stop", trigger: "governor", targetAgentId: MISSION_WORKER, requestId: REQUEST, missionId: MISSION, families: ["overengineering"], commandId: (jsonOf(stopped) as { commandId: string }).commandId, expected: "turn-ends" },
    ]);
  });

  it("bm_note with missionId keeps the note under the mission, which bm_missions returns; both ids, neither, or an unknown mission are refused (missions design §9.1)", async () => {
    const noted = await tools().call("bm_note", { missionId: MISSION, text: "The owner wants one Worker per repo." });
    expect(noted.ok, noted.text).toBe(true);
    expect(jsonOf(noted)).toEqual({ missionId: MISSION, notes: 1, replaced: false });
    expect(createOrchestratorStore(home).readNotes({ missionId: MISSION })).toMatchObject([{ text: "The owner wants one Worker per repo." }]);
    expect(createOrchestratorStore(home).readNotes(WORKSPACE_ID)).toEqual([]);
    const exp = (jsonOf(await tools().call("bm_missions", { missionId: MISSION })) as { missions: Array<Record<string, unknown>> }).missions[0]!;
    expect(exp["notes"]).toEqual([{ at: NOW.toISOString(), text: "The owner wants one Worker per repo." }]);

    expect(await tools().call("bm_note", { missionId: MISSION, workspaceId: WORKSPACE_ID, text: "x" })).toEqual({ ok: false, text: "Refused: give workspaceId or missionId, not both." });
    expect(await tools().call("bm_note", { text: "x" })).toEqual({ ok: false, text: "Refused: give workspaceId (a project's note) or missionId (a mission's)." });
    expect(await tools().call("bm_note", { missionId: "mis-0000000099", text: "x" })).toEqual({ ok: false, text: "Refused: no mission mis-0000000099; call bm_missions for their ids." });
    expect(createOrchestratorStore(home).readNotes({ missionId: MISSION })).toHaveLength(1);
  });

  it("bm_govern refuses an unknown mission, an unknown figure, a mission with no Main, a text that shows an effect, and a 13th command for the mission in 24 hours, sending nothing", async () => {
    expect(createMissionStore(home).create({ code: "NOMAIN", name: "No Main", goal: "Waits.", repos: [WORKSPACE_ID], createdBy: "owner" }).ok).toBe(true);
    const lonely = createMissionStore(home).list().find((entry) => entry.code === "NOMAIN")!.missionId;
    const govern = (input: Record<string, unknown>) => tools().call("bm_govern", { missionId: MISSION, step: "nudge", text: "Re-plan.", ...input });

    expect(await govern({ missionId: "mis-0000000099" })).toEqual({ ok: false, text: "Refused: no mission mis-0000000099; use a missionId bm_missions gave." });
    expect((await govern({ figures: ["writersOnOneFile", "vibes"] })).text).toContain("- input.figures: vibes is not a figure; the figures are writersOnOneFile, ");
    expect(await govern({ missionId: lonely })).toEqual({ ok: false, text: "Refused: mission NOMAIN has no Main." });
    expect(await govern({ text: "Push the export branch to origin now." })).toEqual({
      ok: false,
      text: "Refused: the text shows release (push, publish or deploy) that effects does not declare: declare the effect or ask the owner with bm_ask_owner.",
    });
    const earlier = createOrchestratorStore(home, { now: () => new Date(NOW.getTime() - 3_600_000) });
    for (let index = 0; index < COMMAND_LIMIT_PER_REQUEST; index += 1) {
      earlier.appendCommand({ workspaceId: MISSIONS_HOME, managerId: OLD_MAIN, requestId: null, situation: "", command: "Re-plan.", reason: "", sentText: "Re-plan.", outcome: "sent", missionId: MISSION });
    }
    expect(await govern({})).toEqual({ ok: false, text: `Refused: ${MISSION_COMMAND_LIMIT_MESSAGE}.` });
    expect(enqueue).not.toHaveBeenCalled();
    expect(createMissionStore(home).journal(MISSION).filter((entry) => entry.kind === "governor")).toEqual([]);
  });

  it("governedLadderOf: the named figures' families, else every family above step 0 (none for an arbitration); a nudge moves step 1 to 2, a re-plan step 3 to 4", () => {
    const ladder = { mess: family(1), drift: family(3), stuck: family(0) };
    const action = { at: NOW.toISOString(), id: "c-1", mainTurns: 7 };
    const nudged = governedLadderOf(ladder, "nudge", [], action);
    expect(nudged.mess).toEqual({ ...family(1), step: 2, lastAction: { at: action.at, kind: "nudge", id: "c-1" }, mainTurnsAt: 7 });
    expect(nudged.drift).toEqual({ ...family(3), lastAction: { at: action.at, kind: "nudge", id: "c-1" } });
    expect(nudged.stuck).toEqual(family(0));
    const replanned = governedLadderOf(ladder, "replan", ["finishedSinceCriterion"], action);
    expect(replanned.drift).toMatchObject({ step: GOVERNOR_STOP_STEP, lastAction: { kind: "replan" } });
    expect(replanned.mess).toEqual(family(1));
    expect(governedLadderOf(ladder, "arbitrate", [], action)).toEqual(ladder);
  });

  it("bm_missions reads each open mission: its charter, roster, figures against their thresholds, ladder and open m: cards", async () => {
    createGovernorStore(home).put(MISSION, { mess: family(2, { at: at(0), kind: "nudge", id: "c-0" }) });
    createMissionDecisionStore(home).open(
      makeDecision({
        id: `m:${MISSION}:1`,
        workspaceId: MISSIONS_HOME,
        requestId: null,
        askedBy: { role: "plugin", agentId: MAIN },
        round: null,
        question: "Change the goal to: export invoices and credit notes?",
        subject: null,
        options: [
          { key: "a", label: "Apply", recommended: true, effects: ["none"] },
          { key: "b", label: "Keep as is", recommended: false, effects: ["none"] },
        ],
      }),
    );

    const answer = jsonOf(await tools().call("bm_missions", {})) as { missions: Array<Record<string, unknown>> };

    expect(answer.missions.map((mission) => mission["code"]).sort()).toEqual(["EXP", "OTHER"]);
    const exp = answer.missions.find((mission) => mission["code"] === "EXP")!;
    expect(exp).toMatchObject({
      missionId: MISSION,
      name: "Export",
      state: "open",
      mainId: MAIN,
      charter: { goal: "Export invoices.", repos: [WORKSPACE_ID], doneCriteria: [] },
      roster: [{ requestId: REQUEST, workspaceId: WORKSPACE_ID, topic: "Export", state: "active", workerIds: [MISSION_WORKER] }],
      ladder: { mess: { step: 2, since: at(0), lastAction: { at: at(0), kind: "nudge", id: "c-0" } } },
      openCards: [{ decisionId: `m:${MISSION}:1`, question: "Change the goal to: export invoices and credit notes?", options: ["Apply", "Keep as is"] }],
    });
    const figures = exp["figures"] as { crossed: string[]; under: string[] };
    expect([...figures.crossed, ...figures.under].some((line) => line.startsWith("writersOnOneFile 0 (threshold ≥"))).toBe(true);
    // One mission by id; an unknown one is refused.
    expect((jsonOf(await tools().call("bm_missions", { missionId: MISSION })) as { missions: unknown[] }).missions).toHaveLength(1);
    expect(await tools().call("bm_missions", { missionId: "mis-0000000099" })).toEqual({
      ok: false,
      text: "Refused: no mission mis-0000000099; call bm_missions without missionId for their ids.",
    });
  });

  it("a prepared command of bm_ask_owner goes to a Main of the project only: a Main of a mission with no request here is refused", async () => {
    const asked = await tools().call("bm_ask_owner", {
      workspaceId: WORKSPACE_ID,
      requestId: REQUEST,
      question: "PDF or CSV?",
      recommendation: "PDF.",
      options: [{ label: "PDF", effects: ["none"], command: { to: "manager", agentId: STRAY_MAIN, intent: "answer", body: "Use PDF." } }],
    });
    expect(asked.text).toContain(`- input.options[0].command.agentId: Manager ${STRAY_MAIN} does not belong to project ${WORKSPACE_ID}`);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("bm_direct_worker copies a stop to the Worker's request's current Main, not its archived creator", async () => {
    createOrchestratorStore(home, { now: () => NOW }).openDangerAllowance(WORKSPACE_ID, MISSION_WORKER);
    const result = await tools().call("bm_direct_worker", stop);

    expect(result.ok, result.text).toBe(true);
    expect(enqueue.mock.calls.map((call) => call[0])).toEqual([MAIN]);
    expect(jsonOf(result)).toMatchObject({ managerId: MAIN, copy: "sent" });
  });

  it("a prepared command to an earlier Main reaches the current Main once the owner chooses it", async () => {
    const fake = daemon();
    const onSettled = settledByKind({ orchestrator: createOrchestratorDecisionDelivery({ home: () => home, now: () => NOW, queue: deps.queue, log: () => {} }) });
    const asked = await toolsWith(fake.paseo).call("bm_ask_owner", {
      workspaceId: WORKSPACE_ID,
      requestId: REQUEST,
      question: "PDF or CSV?",
      recommendation: "PDF.",
      subject: "export-format",
      options: [
        { label: "PDF", effects: ["none"], recommended: true, command: { to: "manager", agentId: OLD_MAIN, intent: "answer", body: "Use PDF." } },
        { label: "CSV", effects: ["none"] },
      ],
    });
    expect(asked.ok, asked.text).toBe(true);
    const id = (jsonOf(asked) as { decisionId: string }).decisionId;

    await handleDecisionsAnswer({ id, optionKey: "a", confirmed: true, via: "inbox" }, fake.paseo, { env: { PASEO_BM_HOME: home }, homedir: () => root, now: () => NOW, onSettled });

    expect(enqueue.mock.calls[0]![0]).toBe(MAIN);
    expect(createDecisionStore(home).get(id, WORKSPACE_ID)!.delivery).toMatchObject({ to: MAIN, outcome: "sent" });
  });

  it("with no request, a prepared command named to an earlier Main reaches the current Main", async () => {
    const fake = daemon();
    const onSettled = settledByKind({ orchestrator: createOrchestratorDecisionDelivery({ home: () => home, now: () => NOW, queue: deps.queue, log: () => {} }) });
    const asked = await toolsWith(fake.paseo).call("bm_ask_owner", {
      workspaceId: WORKSPACE_ID,
      question: "PDF or CSV for every export?",
      recommendation: "PDF.",
      subject: "export-format-all",
      options: [
        { label: "PDF", effects: ["none"], recommended: true, command: { to: "manager", agentId: OLD_MAIN, intent: "answer", body: "Use PDF." } },
        { label: "CSV", effects: ["none"] },
      ],
    });
    expect(asked.ok, asked.text).toBe(true);
    const id = (jsonOf(asked) as { decisionId: string }).decisionId;

    await handleDecisionsAnswer({ id, optionKey: "a", confirmed: true, via: "inbox" }, fake.paseo, { env: { PASEO_BM_HOME: home }, homedir: () => root, now: () => NOW, onSettled });

    expect(enqueue.mock.calls.map((call) => call[0])).toEqual([MAIN]);
    expect(createDecisionStore(home).get(id, WORKSPACE_ID)!.delivery).toMatchObject({ to: MAIN, outcome: "sent" });
  });

  it("bm_projects lists the repo's current Main among its Managers, not an earlier or another mission's Main", async () => {
    await store([turn({ agentId: MISSION_WORKER, role: "worker", requestId: REQUEST, parentAgentId: OLD_MAIN, sent: [msg(MISSION_WORKER, at(1), "Working on the export.")] })]);

    const answer = jsonOf(await tools().call("bm_projects", { detail: "full" })) as { projects: Array<{ workspaceId: string; managers: Array<{ id: string }> }> };

    expect(answer.projects.find((project) => project.workspaceId === WORKSPACE_ID)!.managers).toEqual([{ id: MAIN, title: null, status: "idle" }]);
  });

  it("orchestrator.state names the repo's Main as the project's Manager", async () => {
    await store([turn({ agentId: MISSION_WORKER, role: "worker", requestId: REQUEST, parentAgentId: OLD_MAIN, sent: [msg(MISSION_WORKER, at(1), "Working on the export.")] })]);
    const state = await handleOrchestratorState(daemonWith(agents()).paseo as never, { env: { PASEO_BM_HOME: home }, homedir: () => root, now: () => NOW, log: () => {} });

    expect(state.projects).toEqual([expect.objectContaining({ workspaceId: WORKSPACE_ID, managerId: MAIN })]);
  });
});
