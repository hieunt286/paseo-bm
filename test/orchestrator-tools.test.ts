import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { REDACTED } from "../plugin/server/collector";
import {
  AGENT_MESSAGE_MAX_CHARS,
  COMMAND_LIMIT_MESSAGE,
  COMMAND_LIMIT_PER_REQUEST,
  SEND_REFUSED_MESSAGE,
  SET_AUTOPILOT_REFUSED_MESSAGE,
  createOrchestratorTools,
  firstLine,
  DECISION_ONLY_EFFECTS,
  DIRECT_REFUSED_MESSAGE,
  GIT_READ_ONLY_PREFIX,
  needsDecisionMessageOf,
  INTERRUPT_REFUSED_MESSAGE,
  REPO_OUTPUT_MAX_CHARS,
  PROJECTS_BOUNDED_NOTE,
  REQUEST_BOUNDED_NOTE,
  OWNER_ONLY_ANSWER_EFFECTS,
  agentMessagesBoundedNote,
  decideRefusalOf,
  storedAnswerRefusalOf,
  type GitRunner,
  type OrchestratorToolsDeps,
  type ServerToolResult,
} from "../plugin/server/orchestrator-tools";
import { ORCHESTRATOR_FIRST_PROMPT, ORCHESTRATOR_FIRST_PROMPT_START, isOwnerWord } from "../plugin/server/orchestrator-agent";
import { createOrchestratorStore } from "../plugin/server/orchestrator-store";
import { createAlertStore } from "../plugin/server/alert-store";
import { clearDecisionStoreCache, createDecisionStore } from "../plugin/server/decision-store";
import { handleDecisionsAnswer, settledByKind } from "../plugin/server/decision-rpc";
import { createOrchestratorDecisionDelivery } from "../plugin/server/orchestrator-decisions";
import { createQuestionDecisionDelivery } from "../plugin/server/decision-delivery";
import { isPluginNotice } from "../plugin/shared/notices";
import {
  CONFIRM_EFFECTS,
  GRANT_TTL_MS,
  answerDecision,
  expireDecision,
  markNeedsConfirmation,
  supersedeDecision,
  withdrawDecision,
  type Decision,
} from "../plugin/shared/decisions";
import { makeDecision } from "./helpers/decisions";
import { appendRecord, clearTraceStoreCache } from "../plugin/server/trace-store";
import type { AgentFacts } from "../plugin/server/traces";
import type { TraceRecord } from "../plugin/shared/contracts";
import { MAX_DECISION_QUESTION_CHARS, MAX_PROPOSAL_COMMAND_CHARS, WORKFLOW_ASSESSMENT_TRACE_ID } from "../plugin/shared/orchestrator";
import { commandBlockOf, parseCommandBlock, type CommandInput } from "../plugin/shared/orchestrator-command";
import { ASSESSMENT_CRITERIA } from "../plugin/shared/bm-assessment";
import { AGENT_MESSAGES_SUMMARY, REQUEST_SUMMARY_MAX_CHARS } from "../plugin/shared/bm-tools";
import { ASSESSMENT_MAX_CHARS, TRUNCATED_MARKER } from "../plugin/server/assessment";
import { MANAGER, REVIEWER, WORKER, WORKSPACE_DIRECTORY, WORKSPACE_ID, at, clean, msg, smallWithBead, turn } from "./fixtures/orchestrator-traces";

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
function snapshotOf(facts: AgentFacts, overrides: Record<string, unknown> = {}): Record<string, unknown> {
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
 * A fake SDK. `timelines` holds each agent's pages, oldest page first; the
 * fake pages back from the tail as Paseo does. Nothing that sends, creates or
 * archives is expected to be called: they are spies the tests check.
 */
function fakePaseo(agents: ReadonlyArray<Record<string, unknown>>, timelines: Record<string, Entry[][]> = {}) {
  const send = vi.fn();
  const create = vi.fn();
  const archive = vi.fn();
  const refetched: string[] = [];
  const paseo = {
    agents: {
      list: vi.fn(async () => ({ entries: agents.map((agent) => ({ agent })) })),
      ref: vi.fn((agentId: string) => ({
        send,
        archive,
        timeline: {
          refetch: vi.fn(async (options: { direction: string; cursor?: number }) => {
            refetched.push(agentId);
            const pages = timelines[agentId] ?? [];
            const index = options.direction === "tail" ? pages.length - 1 : Number(options.cursor) - 1;
            if (index < 0) return { entries: [] };
            return { entries: pages[index], hasOlder: index > 0, startCursor: index };
          }),
        },
      })),
      create,
    },
    workspaces: {
      list: vi.fn(async () => ({ entries: [{ id: WORKSPACE_ID, directory: WORKSPACE_DIRECTORY }] })),
      ref: vi.fn(() => ({ agents: { create } })),
    },
    config: { get: vi.fn(async () => ({ config: {} })) },
  };
  return { paseo, send, create, archive, refetched };
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
  it("lists each project with activity in the period: its Managers, its recent requests, their signals and open stalls", async () => {
    const fixture = smallWithBead();
    await store(fixture.records.map((record) => ({ ...record, sent: record.sent.map((sent) => (sent.origin === "user" ? { ...sent, text: `Use --token ${SECRET} to fix the dates.\nSecond line.` } : sent)) })));
    await store([
      turn({ workspaceId: OTHER_WORKSPACE, agentId: "agent-old", requestId: "req-20260921T100000Z", at: "2026-09-21T10:00:00.000Z", endedAt: "2026-09-21T10:00:00.000Z", sent: [msg("agent-old", "2026-09-21T10:00:00.000Z", "An old request", "user")] }),
    ]);
    // Stalled requests are Inbox alerts (autonomy design §A.8).
    const alerts = createAlertStore(home, { now: () => NOW });
    alerts.raise({ workspaceId: WORKSPACE_ID, kind: "request-stalled", subject: fixture.requestId, detail: "idle-unfinished" });
    alerts.raise({ workspaceId: WORKSPACE_ID, kind: "request-stalled", subject: "req-20260926T090000Z", detail: "idle-unfinished" });
    const { paseo, send, create } = fakePaseo(fixture.agents.map((facts) => snapshotOf(facts)));

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
          // The English request under the Manager's Vietnamese replies raises the language signal too.
          signals: ["process.small-heavy", "manager.language-mismatch"],
          stalls: [{ situation: "idle-unfinished", since: NOW.toISOString() }],
        },
      ],
    });
    expect(result.text).not.toContain(SECRET);

    // A week back, the other project's old request is in too.
    const week = jsonOf(await toolsWith(paseo).call("bm_projects", { sinceHours: 168, detail: "full" })) as { projects: Array<{ workspaceId: string; label: string }> };
    expect(week.projects.map((project) => project.workspaceId)).toEqual([WORKSPACE_ID, OTHER_WORKSPACE]);
    expect(week.projects[1]!.label).toBe(OTHER_WORKSPACE);
    expect(send).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
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
    const { paseo } = fakePaseo([snapshotOf(clean().agents[0]!), snapshotOf(clean().agents[1]!, { labels: { "bm.role": "worker", "bm.requestId": "req-20260926T100011Z" } })]);

    const answer = jsonOf(await toolsWith(paseo).call("bm_projects", { sinceHours: 24, detail: "full" })) as { projects: Array<{ requests: Array<{ requestId: string; waitingSince: string | null }> }> };

    const requests = answer.projects[0]!.requests;
    expect(requests).toHaveLength(10);
    expect(requests[0]).toMatchObject({ requestId: "req-20260926T100011Z", waitingSince: at(30) });
    expect(requests.map((request) => request.requestId)).not.toContain("req-20260926T100000Z");
  });

  it("refuses a period outside 1-168 hours, and answers nothing without a Paseo handle", async () => {
    const { paseo } = fakePaseo([]);
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
  it("returns the request's assessment content, redacted, with the raised signals", async () => {
    const fixture = smallWithBead();
    await store(fixture.records.map((record) => ({ ...record, received: record.received.map((reply) => ({ ...reply, text: `${reply.text} --password ${SECRET}` })) })));
    const { paseo, send } = fakePaseo(fixture.agents.map((facts) => snapshotOf(facts)));
    const tools = toolsWith(paseo);

    const result = await tools.call("bm_request", { workspaceId: WORKSPACE_ID, requestId: fixture.requestId });

    expect(result.ok).toBe(true);
    expect(result.text).toMatch(/^# The request to assess\n/);
    expect(result.text).toContain(`requestId: ${fixture.requestId}`);
    expect(result.text).toContain("process.small-heavy · warning · raised");
    expect(result.text).toContain(`--password ${REDACTED}`);
    expect(result.text).not.toContain(SECRET);
    // Found by its trace id as well.
    const byTrace = await tools.call("bm_request", { workspaceId: WORKSPACE_ID, requestId: fixture.input.traceId });
    expect(byTrace.text).toBe(result.text);
    expect(send).not.toHaveBeenCalled();
  });

  it("refuses an unknown request, and a workspace id the store would refuse", async () => {
    await store(smallWithBead().records);
    const { paseo } = fakePaseo([]);
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
    const { paseo, refetched, send } = fakePaseo(fixture.agents.map((facts) => snapshotOf(facts)), { [MANAGER]: timeline });

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
    expect(new Set(refetched)).toEqual(new Set([MANAGER]));
    expect(send).not.toHaveBeenCalled();

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
    const { paseo, refetched } = fakePaseo([...fixture.agents.map((facts) => snapshotOf(facts)), ...others], {
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
    expect(refetched).toEqual([]);
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
    const { paseo, send } = fakePaseo(fixture.agents.map((facts) => snapshotOf(facts)));
    const tools = toolsWith(paseo);

    const summary = await tools.call("bm_request", { workspaceId: WORKSPACE_ID, requestId: fixture.requestId });
    expect(summary.ok).toBe(true);
    expect(REQUEST_SUMMARY_MAX_CHARS).toBe(4_000);
    expect(chars(summary.text)).toBeLessThanOrEqual(REQUEST_SUMMARY_MAX_CHARS);
    expect(summary.text.split("\n")[0]).toBe(REQUEST_BOUNDED_NOTE);
    expect(summary.text.split("\n")[1]).toBe("# The request to assess");
    expect(summary.text).toContain(TRUNCATED_MARKER);
    expect(summary.text).toContain(`requestId: ${fixture.requestId}`);
    expect(summary.text).toContain("process.small-heavy · warning · raised");
    expect(summary.text).not.toContain(SECRET);
    expect(summary.text).not.toContain(SECRET.slice(0, 8));

    const full = await tools.call("bm_request", { workspaceId: WORKSPACE_ID, requestId: fixture.requestId, detail: "full" });
    expect(full.ok).toBe(true);
    expect(full.text).toMatch(/^# The request to assess\n/);
    expect(full.text).not.toContain(REQUEST_BOUNDED_NOTE);
    expect(chars(full.text)).toBeGreaterThan(REQUEST_SUMMARY_MAX_CHARS);
    expect(chars(full.text)).toBeLessThanOrEqual(ASSESSMENT_MAX_CHARS);
    expect(full.text).toContain(`--password ${REDACTED} and continues.`);
    expect(full.text).not.toContain(SECRET);
    expect(send).not.toHaveBeenCalled();
  });

  it("bm_request: no note when nothing was cut; the same text as full", async () => {
    const fixture = smallWithBead();
    await store(fixture.records);
    const { paseo } = fakePaseo(fixture.agents.map((facts) => snapshotOf(facts)));
    const tools = toolsWith(paseo);
    const summary = await tools.call("bm_request", { workspaceId: WORKSPACE_ID, requestId: fixture.requestId });
    expect(summary.text).toMatch(/^# The request to assess\n/);
    expect(summary.text).not.toContain(REQUEST_BOUNDED_NOTE);
    expect(summary.text).toBe((await tools.call("bm_request", { workspaceId: WORKSPACE_ID, requestId: fixture.requestId, detail: "full" })).text);
  });

  it("bm_agent_messages: at most 5 messages of 1,500 characters, the note first only when the summary cut something", async () => {
    const short = (index: number): Entry => ({ item: { type: "user_message", text: `Message ${index}`, clientMessageId: `c-${index}` }, timestamp: at(index) });
    const long = `Q1: ${"which export format? ".repeat(200)}--token ${SECRET} the end`;
    const fixture = clean();
    const agents = fixture.agents.map((facts) => snapshotOf(facts));
    const { paseo } = fakePaseo(agents, {
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
    const { paseo, send } = fakePaseo(fixture.agents.map((facts) => snapshotOf(facts)));
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
      counts: { requests: 1, byState: { completed: 1 }, waitingOnOwner: 0, withSignals: 1, openStalls: 1, notes: 1, openDecisions: 1 },
      openDecisions: [
        { decisionId, requestId: fixture.requestId, askedBy: "orchestrator", status: "open", question: `Publish with ${REDACTED}?`, options: ["Yes", "No"], at: NOW.toISOString() },
      ],
    });
    expect(result.text).not.toContain(SECRET);

    const full = await tools.call("bm_projects", { detail: "full" });
    expect(full.text.startsWith("{")).toBe(true);
    const fullProject = (jsonOf(full) as { projects: Array<Record<string, unknown>> }).projects[0]!;
    expect(Object.keys(fullProject)).toEqual(["workspaceId", "label", "directory", "lastActivityAt", "managers", "notes", "requests"]);
    expect(send).not.toHaveBeenCalled();
  });

  it("bm_projects: no note when there is nothing to leave out, and an unknown detail is refused", async () => {
    const { paseo } = fakePaseo([]);
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

describe("bm_assessment (design §5.5)", () => {
  const assessment = {
    rubric: ASSESSMENT_CRITERIA.map((criterion, index) => ({ criterion, score: index === 5 ? null : 4, note: `Note on ${criterion}.` })),
    findings: [{ severity: "warning", text: "Beads for a Small request.", evidence: "br create after tier: Small" }],
    suggestions: [{ role: "worker", text: "A Small request gets no bead.", why: "The beads finding." }],
  };
  const pendingLine = (assessmentId: string, when: string) => ({
    v: 1 as const,
    assessmentId,
    requestId: null,
    traceId: WORKFLOW_ASSESSMENT_TRACE_ID,
    agentId: "agent-orchestrator",
    at: when,
    status: "pending" as const,
    provider: "bm-orchestrator",
    model: "claude-opus-5",
    scope: { requestIds: ["req-20260926T100024Z"] },
  });

  it("records the result as a done line of the newest pending workflow assessment", async () => {
    const orchestratorStore = createOrchestratorStore(home);
    orchestratorStore.appendAssessment(WORKSPACE_ID, pendingLine("older", "2026-09-26T11:00:00.000Z"));
    orchestratorStore.appendAssessment(WORKSPACE_ID, pendingLine("newer", "2026-09-26T11:30:00.000Z"));
    const { paseo, send } = fakePaseo([]);

    const result = await toolsWith(paseo).call("bm_assessment", { workspaceId: WORKSPACE_ID, ...assessment });

    expect(result.ok).toBe(true);
    expect(result.text.split("\n")[0]).toBe("Recorded. Tell the owner the result in one line.");
    expect(jsonOf(result)).toEqual({ assessmentId: "newer", attached: true });
    const lines = createOrchestratorStore(home).readAssessments(WORKSPACE_ID);
    expect(lines[0]).toEqual({ ...pendingLine("newer", NOW.toISOString()), status: "done", result: assessment });
    expect(lines.find((line) => line.assessmentId === "older")?.status).toBe("pending");
    expect(send).not.toHaveBeenCalled();
  });

  it("records a new workflow line, scoped to the project's recent requests, when none is pending", async () => {
    const fixture = smallWithBead();
    await store(fixture.records);
    const orchestratorStore = createOrchestratorStore(home);
    orchestratorStore.appendAssessment(WORKSPACE_ID, { ...pendingLine("done-before", "2026-09-26T09:00:00.000Z"), status: "done", result: assessment });
    const { paseo } = fakePaseo([]);

    const result = await toolsWith(paseo).call("bm_assessment", { workspaceId: WORKSPACE_ID, rubric: assessment.rubric });

    expect(jsonOf(result)).toEqual({ assessmentId: "assessment-1", attached: false });
    expect(createOrchestratorStore(home).readAssessments(WORKSPACE_ID)[0]).toEqual({
      v: 1,
      assessmentId: "assessment-1",
      requestId: null,
      traceId: WORKFLOW_ASSESSMENT_TRACE_ID,
      agentId: null,
      at: NOW.toISOString(),
      status: "done",
      provider: "bm-orchestrator",
      model: null,
      result: { rubric: assessment.rubric, findings: [], suggestions: [] },
      scope: { requestIds: [fixture.requestId] },
    });
  });

  it("refuses an invalid assessment and a project paseo-bm does not know, writing nothing", async () => {
    const { paseo } = fakePaseo([]);
    const tools = toolsWith(paseo);
    const invalid = await tools.call("bm_assessment", { workspaceId: WORKSPACE_ID, rubric: assessment.rubric.slice(0, 5) });
    expect(invalid.text).toBe("The call was refused. Fix these and call bm_assessment again:\n- input.rubric: needs at least 6 item(s)");
    expect((await tools.call("bm_assessment", assessment)).text).toContain("- input.workspaceId: is required");
    expect(await tools.call("bm_assessment", { workspaceId: "wks_unknown", ...assessment })).toEqual({
      ok: false,
      text: "Refused: no paseo-bm project wks_unknown; use the workspaceId bm_projects gave.",
    });
    expect(filesUnder(home)).toEqual([]);
  });
});

describe("the tool set", () => {
  it("lists the twelve tools in order, and answers an unknown name without running anything", async () => {
    const { paseo } = fakePaseo([]);
    const tools = toolsWith(paseo);
    expect(tools.faces.map((face) => face.name)).toEqual([
      "bm_projects",
      "bm_request",
      "bm_agent_messages",
      "bm_send_command",
      "bm_decisions",
      "bm_ask_owner",
      "bm_decide",
      "bm_set_autopilot",
      "bm_direct_worker",
      "bm_repo",
      "bm_note",
      "bm_assessment",
    ]);
    expect(tools.has("bm_report")).toBe(false);
    expect(await tools.call("bm_report", {})).toEqual({ ok: false, text: "Unknown tool: bm_report" });
    expect(paseo.agents.list).not.toHaveBeenCalled();
  });

  it("keeps only a handle that looks like Paseo's", async () => {
    const tools = createOrchestratorTools(deps);
    tools.usePaseo(undefined);
    tools.usePaseo({ agents: {} });
    expect((await tools.call("bm_projects", {})).text).toMatch(/no connection to Paseo/);
  });

  it("turns a failing SDK into a tool error, never a throw", async () => {
    const { paseo } = fakePaseo([]);
    paseo.agents.list.mockRejectedValue(new Error("daemon went away"));
    const result = await toolsWith(paseo).call("bm_note", { workspaceId: WORKSPACE_ID, text: "A note." });
    expect(result).toEqual({ ok: false, text: "The tool failed: daemon went away. Try again later, or tell the user." });
  });
});

// ---------------------------------------------------------------------------
// Design §6A (ADR-015): bm_send_command, bm_ask_owner, bm_set_autopilot.
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

const STALL_NOTICE = `BM-EVENTS\nFrom the paseo-bm plugin, not the owner: 1 event of projects with Autopilot on, oldest first.\n- request.stalled idle-unfinished — project ${WORKSPACE_ID}, request req-20260926T100020Z, since ${at(0)}. Look with bm_request.`;
const EVENT_NOTICE = `BM-EVENTS\nFrom the paseo-bm plugin, not the owner: 1 event of projects with Autopilot on, oldest first.\n- decision.opened — project ${WORKSPACE_ID}, request req-20260926T100020Z, decision q:req-20260926T100020Z:Q1. Read it with bm_decisions.`;

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
  /** The BM-COMMAND block the Manager gets for `command` (design §6B.1; v2, autonomy design §A.7): authority autopilot via autopilot, owner via chat. */
  const blockOf = (overrides: Partial<CommandInput> = {}) =>
    commandBlockOf({
      from: "orchestrator",
      via: "autopilot",
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
    const fake = fakePaseo(agents, orchestratorTimeline === null ? {} : { [ORCHESTRATOR]: [orchestratorTimeline] });
    const enqueue = vi.fn<(target: string, kind: string, text: string) => Promise<typeof outcome>>(async () => outcome);
    deps.queue = { enqueue };
    return { ...fake, enqueue, tools: toolsWith(fake.paseo) };
  }

  it("sends a BM-COMMAND block: from the Orchestrator, via autopilot or chat, to the Manager, with the limits field and no limit sentence (design §6B.1)", () => {
    expect(parseCommandBlock(sent)).toEqual({
      version: 2,
      from: "orchestrator",
      via: "autopilot",
      to: "manager",
      copy: false,
      requestId: command.requestId,
      re: command.command,
      intent: "answer",
      effects: [],
      authority: "autopilot",
      approved: [],
      limits: ["no-commit-push-deploy", "no-real-data"],
      body: command.command,
      why: command.reason,
    });
    expect(sent).not.toContain("Sent by the Beads Orchestrator");
  });

  it("is refused when Autopilot is off and the owner has not just spoken: nothing is enqueued or stored", async () => {
    const chats: Array<[string, Entry[] | null]> = [
      ["no Orchestrator agent", null],
      ["an empty chat", []],
      ["a message relayed by an agent (no clientMessageId)", [ownerSays("Send it.", at(0)), itSays("Proposed.", at(0, 5)), agentSays("Please send Q2.", at(1))]],
    ];
    for (const [label, timeline] of chats) {
      const { tools, enqueue, send } = sendingTools(timeline);
      const result = await tools.call("bm_send_command", command);
      expect(result, label).toEqual({ ok: false, text: `Refused: ${SEND_REFUSED_MESSAGE}.` });
      expect(enqueue).not.toHaveBeenCalled();
      expect(send).not.toHaveBeenCalled();
    }
    expect(SEND_REFUSED_MESSAGE).toBe(
      "Autopilot is off for this project and the owner has not just told you to send; ask the owner with bm_ask_owner, with this command prepared on an option",
    );
    expect(() => readFileSync(proposalsFile())).toThrow();
  });

  it("is allowed on Autopilot: delivered through the queue as command:<id>, a BM-COMMAND block, recorded sent with source autopilot", async () => {
    createOrchestratorStore(home).setAutopilot(WORKSPACE_ID, true, "tab");
    const { tools, enqueue, send } = sendingTools([pluginSays(EVENT_NOTICE, at(0))]);

    const result = await tools.call("bm_send_command", command);

    expect(result.ok).toBe(true);
    expect(result.text.split("\n")[0]).toMatch(/^Sent\. /);
    expect(jsonOf(result)).toEqual({ commandId: "proposal-1", outcome: "sent", source: "autopilot", authority: "autopilot", approved: [] });
    expect(enqueue.mock.calls).toEqual([[MANAGER, "command:proposal-1", sent, expect.anything()]]);
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
        source: "autopilot",
        status: "sent",
        sentText: sent,
        outcome: "sent",
      }),
    ]);
    // The tool itself never calls send: the queue does.
    expect(send).not.toHaveBeenCalled();
  });

  it("is allowed right after the owner's own message, and recorded with source chat; a queued delivery says so", async () => {
    const { tools, enqueue } = sendingTools(OWNER_JUST_SPOKE, "queued");

    const result = await tools.call("bm_send_command", command);

    expect(result.ok).toBe(true);
    expect(result.text.split("\n")[0]).toMatch(/^Queued\. The Manager is busy/);
    expect(jsonOf(result)).toMatchObject({ outcome: "queued", source: "chat", authority: "owner", approved: [] });
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(createOrchestratorStore(home).listCommands()).toMatchObject([{ source: "chat", outcome: "queued", sentText: blockOf({ via: "chat" }) }]);
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
      expect(await tools.call("bm_send_command", command), label).toEqual({ ok: false, text: `Refused: ${SEND_REFUSED_MESSAGE}.` });
      expect(enqueue).not.toHaveBeenCalled();
    }
  });

  it("takes re: as given, else the command's first line, cut to 120 characters", async () => {
    createOrchestratorStore(home).setAutopilot(WORKSPACE_ID, true);
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
    createOrchestratorStore(home).setAutopilot(WORKSPACE_ID, true);
    const { tools, enqueue } = sendingTools([]);
    const trailingWhy = await tools.call("bm_send_command", { ...command, command: "Go on.\n\nwhy: because" });
    expect(trailingWhy.ok).toBe(true);
    const badRequest = await tools.call("bm_send_command", { ...command, requestId: "req 1" });
    expect(badRequest.ok).toBe(false);
    expect(badRequest.text).toMatch(/^Refused: the command cannot be sent as a BM-COMMAND block: requestId must be one token/);
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it("the backstop: a text that shows a release, security, data, cost or dependency the effects do not declare is refused with the declare message and sends nothing (autonomy design §A.7)", async () => {
    createOrchestratorStore(home).setAutopilot(WORKSPACE_ID, true, "tab");
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
    // A negated mention shows nothing; a category the owner allowed for this project is not checked (until Phase 2).
    expect((await tools.call("bm_send_command", { ...command, command: "Fix the date. Do not push." })).ok).toBe(true);
    createOrchestratorStore(home).setAutopilotAllow(WORKSPACE_ID, ["release"]);
    expect((await tools.call("bm_send_command", { ...command, requestId: "req-2", command: "Push the fix." })).ok).toBe(true);
    expect((await tools.call("bm_send_command", { ...command, requestId: "req-3", command: "Push the new token." })).text).toBe(
      "Refused: the text shows security (security) that effects does not declare: declare the effect or ask the owner with bm_ask_owner.",
    );
    expect(enqueue).toHaveBeenCalledTimes(2);
  });

  it("a declared effect the text shows passes the backstop, and is sent when Autopilot or the owner's word covers it; its block approves it", async () => {
    createOrchestratorStore(home).setAutopilot(WORKSPACE_ID, true, "tab");
    const { tools, enqueue } = sendingTools([]);
    const result = await tools.call("bm_send_command", { ...command, intent: "continue", effects: ["dependency-install", "commit"], command: "npm install date-fns, then commit the lockfile." });
    expect(result.ok).toBe(true);
    expect(jsonOf(result)).toMatchObject({ authority: "autopilot", approved: ["commit", "dependency-install"] });
    expect(parseCommandBlock(enqueue.mock.calls[0]![2])).toMatchObject({
      intent: "continue",
      effects: ["commit", "dependency-install"],
      authority: "autopilot",
      approved: ["commit", "dependency-install"],
      limits: ["no-push", "no-deploy", "no-real-data"],
    });
  });

  it("Autopilot and the owner's word in the chat never cover push, publish, deploy, real data, migration, security or cost: refused, sends nothing", async () => {
    expect(DECISION_ONLY_EFFECTS).toEqual(["push", "publish", "deploy", "real-data", "migration", "security", "cost"]);
    for (const timeline of [OWNER_JUST_SPOKE, null]) {
      if (timeline === null) createOrchestratorStore(home).setAutopilot(WORKSPACE_ID, true, "tab");
      // Even with the category allowed for the project: the allowance is not extended to cover an effect.
      createOrchestratorStore(home).setAutopilotAllow(WORKSPACE_ID, ["release", "data", "security", "cost"]);
      const { tools, enqueue } = sendingTools(timeline ?? []);
      for (const effect of DECISION_ONLY_EFFECTS) {
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

  it("the backstop holds on the owner's word in chat too: a project without Autopilot allows no category", async () => {
    const { tools, enqueue } = sendingTools(OWNER_JUST_SPOKE);
    expect((await tools.call("bm_send_command", { ...command, command: "Publish the package." })).text).toBe(
      "Refused: the text shows release (push, publish or deploy) that effects does not declare: declare the effect or ask the owner with bm_ask_owner.",
    );
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("records each command it sends as an entry of its own, with its source", async () => {
    const { tools, enqueue } = sendingTools(OWNER_JUST_SPOKE);

    const result = await tools.call("bm_send_command", { ...command, re: "answer to Q2", command: "Q2: PDF." });

    expect(jsonOf(result)).toEqual({ commandId: "proposal-1", outcome: "sent", source: "chat", authority: "owner", approved: [] });
    expect(enqueue.mock.calls[0]!.slice(0, 2)).toEqual([MANAGER, "command:proposal-1"]);
    expect(createOrchestratorStore(home).listCommands()).toEqual([
      expect.objectContaining({ id: "proposal-1", status: "sent", source: "chat", sentText: blockOf({ via: "chat", re: "answer to Q2", body: "Q2: PDF." }), outcome: "sent" }),
    ]);
  });

  it("goes to a paseo-bm Manager of that project only — never a Worker, a Reviewer, the Orchestrator or an archived Manager — even on Autopilot", async () => {
    createOrchestratorStore(home).setAutopilot(WORKSPACE_ID, true);
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
    createOrchestratorStore(home).setAutopilot(WORKSPACE_ID, true);
    const { tools } = sendingTools([]);
    const long = "x".repeat(MAX_PROPOSAL_COMMAND_CHARS);
    expect((await tools.call("bm_send_command", { ...command, re: "long", command: long })).ok).toBe(true);
    expect(createOrchestratorStore(home).listCommands()[0]!.sentText).toBe(blockOf({ re: "long", body: long }));
  });

  /** A command the Orchestrator already sent `hoursAgo` before NOW. */
  function alreadySent(hoursAgo: number, overrides: { requestId?: string | null; source?: "autopilot" | "chat"; workspaceId?: string } = {}) {
    const when = new Date(NOW.getTime() - hoursAgo * 3_600_000);
    createOrchestratorStore(home, { now: () => when }).appendCommand({
      workspaceId: overrides.workspaceId ?? WORKSPACE_ID,
      managerId: MANAGER,
      requestId: overrides.requestId === undefined ? command.requestId : overrides.requestId,
      situation: "",
      command: "Continue.",
      reason: "",
      source: overrides.source ?? "autopilot",
      sentText: "Continue.",
      outcome: "sent",
    });
  }

  it("the loop guard: a 13th command for one request within 24 hours is refused before anything is sent (design §6A)", async () => {
    createOrchestratorStore(home).setAutopilot(WORKSPACE_ID, true, "tab");
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
    expect(COMMAND_LIMIT_MESSAGE).toBe("Autopilot limit reached for this request; ask the owner with bm_ask_owner");
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(createOrchestratorStore(home).listCommands()).toHaveLength(before);
    // Another request of the same project still goes out.
    expect((await tools.call("bm_send_command", { ...command, requestId: "req-other" })).ok).toBe(true);
    expect(enqueue).toHaveBeenCalledTimes(2);
  });

  it("the loop guard counts commands without a request per project, apart from those with one", async () => {
    createOrchestratorStore(home).setAutopilot(WORKSPACE_ID, true, "tab");
    for (let index = 0; index < COMMAND_LIMIT_PER_REQUEST; index += 1) alreadySent(2, { requestId: null });
    const { tools, enqueue } = sendingTools([]);
    const withoutRequest: Partial<typeof command> = { ...command };
    delete withoutRequest.requestId;
    expect(await tools.call("bm_send_command", withoutRequest)).toEqual({ ok: false, text: `Refused: ${COMMAND_LIMIT_MESSAGE}.` });
    expect(enqueue).not.toHaveBeenCalled();
    expect((await tools.call("bm_send_command", command)).ok).toBe(true);
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
    const fake = fakePaseo(agents(), { [ORCHESTRATOR]: [timeline] });
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
    const { tools, enqueue, send } = grantTools();

    const result = await tools.call("bm_send_command", push);

    expect(result.ok).toBe(true);
    expect(jsonOf(result)).toMatchObject({ outcome: "sent", source: "chat", authority: `decision:${DECISION}`, approved: ["push"] });
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
    expect(send).not.toHaveBeenCalled();
  });

  it("the same command without the grant is refused, on Autopilot and on the owner's word alike: push needs the decision", async () => {
    createOrchestratorStore(home).setAutopilot(WORKSPACE_ID, true, "tab");
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
    const { paseo, send } = fakePaseo(agents());
    deps.queue = { enqueue: vi.fn(async () => "sent" as const) };
    const tools = toolsWith(paseo);

    const result = await tools.call("bm_ask_owner", { ...ask, subject: "invoices-table", options: [migrate, { label: " Keep  it ", effects: ["none"] }] });

    expect(result.ok).toBe(true);
    expect(result.text.split("\n")[0]).toMatch(/^Asked\. The owner answers it in paseo-bm, with one button per option; nothing was sent to any agent\./);
    expect(result.text.split("\n")[0]).toContain("the plugin delivers that command itself, with the owner's authority");
    expect(jsonOf(result)).toEqual({ decisionId: "o:assessment-1", replaced: null });
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
      },
    ]);
    // The Orchestrator's command log is not where a decision lives.
    expect(createOrchestratorStore(home).listCommands()).toEqual([]);
    expect(send).not.toHaveBeenCalled();
    expect(deps.queue.enqueue).not.toHaveBeenCalled();
  });

  it("a second question on the same request replaces the open one and names it; separate: true keeps both; another request, or the whole project, is its own", async () => {
    const { paseo } = fakePaseo(agents());
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
    const { paseo, send } = fakePaseo(agents());
    const tools = toolsWith(paseo);
    const issues = async (input: Record<string, unknown>) => (await tools.call("bm_ask_owner", { ...ask, ...input })).text;
    const commandTo = (to: string, agentId: string, body = "Carry on with the migration plan.") => ({ options: [{ label: "Go", effects: ["none"], command: { to, agentId, intent: "continue", body } }] });

    expect(await issues({ managerId: WORKER })).toBe(`Refused: ${WORKER} is not a paseo-bm Manager; use a managerId bm_projects gave.`);
    expect(await issues({ workspaceId: "wks_unknown" })).toBe("Refused: no paseo-bm project wks_unknown; use the workspaceId bm_projects gave.");
    expect(await issues({ question: "x".repeat(MAX_DECISION_QUESTION_CHARS + 1) })).toContain(`- input.question: must be at most ${MAX_DECISION_QUESTION_CHARS} characters`);
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
    expect(send).not.toHaveBeenCalled();
  });
});

describe("the owner's answer to an Orchestrator decision (autonomy design §A.6)", () => {
  const REQUEST = "req-20260929T073348Z";
  const PUSH_BODY = "Push the contract backend to origin/dev; leave the manifest as it is.";
  let agents: Array<Record<string, unknown>>;
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
    const fake = fakePaseo(agents);
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
    const { tools, answer, paseo, send, onSettled } = setUp();
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
    expect(send).not.toHaveBeenCalled();
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
    const { tools, answer } = setUp();
    const id = await askPush(tools);
    agents.splice(0, 1);

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
// change-004: the Orchestrator answers a Worker's question through the store.
// ---------------------------------------------------------------------------

describe("bm_decide (change-004; autonomy design §A.6, §B.5)", () => {
  const REQUEST = "req-20260930T031055Z";
  const QID = (n: number) => `q:${REQUEST}:Q${n}`;
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
  const stored = (id: string) => createDecisionStore(home).get(id, WORKSPACE_ID)!;
  const bytes = () => readFileSync(join(home, "decisions", `${WORKSPACE_ID}.json`), "utf8");
  let onSettled: ReturnType<typeof vi.fn<(decisions: Decision[], context: { paseo: unknown }) => Promise<void>>>;
  beforeEach(() => {
    onSettled = vi.fn(async () => undefined);
    deps.onSettled = onSettled;
    createOrchestratorStore(home).setAutopilot(WORKSPACE_ID, true, "tab");
  });
  afterEach(() => clearDecisionStoreCache());

  function decideTools() {
    const fake = fakePaseo([snapshotOf(clean().agents[0]!), worker(), orchestratorAgent]);
    return { ...fake, tools: toolsWith(fake.paseo) };
  }

  it("answers an open q: decision on an Autopilot project as the Orchestrator, with the option's grant, and hands it to the owner answers' delivery", async () => {
    createDecisionStore(home).open(question(1));
    const { tools, paseo, send } = decideTools();

    const result = await tools.call("bm_decide", { decisionId: QID(1), optionKey: "b", reason: "A one-line fix the review already covers." });

    expect(result.ok).toBe(true);
    expect(result.text.split("\n")[0]).toBe(
      `Answered Q1 of ${REQUEST} with option b, as yours; the owner sees your answer and your reason on the decision. The plugin delivers it to the Worker at its next idle moment, as it delivers the owner's answers. Send nothing more for it. Tell the owner in one line what you chose and why.`,
    );
    expect(stored(QID(1))).toMatchObject({
      status: "answered",
      settledAt: NOW.toISOString(),
      answer: { by: "orchestrator", via: "autopilot", optionKey: "b", words: null, at: NOW.toISOString(), reason: "A one-line fix the review already covers." },
      grant: { effects: ["commit"], usedAt: null },
      delivery: null,
    });
    expect(jsonOf(result)).toMatchObject({ decisionId: QID(1), optionKey: "b", grant: { effects: ["commit"] }, delivery: null });
    // The same hook the owner's answers take, once, with the Paseo handle; nothing sent by the tool itself.
    expect(onSettled).toHaveBeenCalledTimes(1);
    expect(onSettled.mock.calls[0]![0]).toMatchObject([{ id: QID(1), answer: { by: "orchestrator" } }]);
    expect(onSettled.mock.calls[0]![1]).toEqual({ paseo });
    expect(send).not.toHaveBeenCalled();
    expect(createOrchestratorStore(home).listCommands()).toEqual([]);
  });

  it("through the real question delivery: the Worker gets BM-DELIVERY answers once, and the decision records it", async () => {
    createDecisionStore(home).open(question(1));
    const enqueue = vi.fn(async () => "sent" as const);
    const delivery = createQuestionDecisionDelivery({ home: () => home, now: () => NOW, queue: { enqueue, pending: () => [] }, workerOf: async () => WORKER });
    deps.onSettled = settledByKind({ question: delivery.onSettled });
    const { tools } = decideTools();

    const result = await tools.call("bm_decide", { decisionId: QID(1), optionKey: "a", reason: "Keep it: the owner asked for no change." });

    expect(result.text.split("\n")[0]).toContain("The Worker has it now, as the plugin's BM-DELIVERY.");
    expect(enqueue.mock.calls).toEqual([[WORKER, `answers:${REQUEST}`, `BM-DELIVERY answers\nContinue ${REQUEST}.\n\nBM-ANSWERS\nrequestId: ${REQUEST}\nQ1: a — Keep it as it is`, expect.anything()]]);
    expect(stored(QID(1)).delivery).toEqual({ to: WORKER, kind: `answers:${REQUEST}`, at: NOW.toISOString(), outcome: "sent" });
    expect(jsonOf(result)).toMatchObject({ delivery: { outcome: "sent" } });
  });

  it("a delivery that throws costs a log line; the answer stands", async () => {
    createDecisionStore(home).open(question(1));
    const logs: string[] = [];
    deps.onSettled = vi.fn(async () => {
      throw new Error("queue gone");
    });
    deps.log = (line) => logs.push(line);
    const { tools } = decideTools();
    expect((await tools.call("bm_decide", { decisionId: QID(1), optionKey: "a", reason: "Keep it." })).ok).toBe(true);
    expect(stored(QID(1)).status).toBe("answered");
    expect(logs).toEqual([`[paseo-bm] decision ${QID(1)} is answered by the Orchestrator, but its delivery failed: queue gone`]);
  });

  it("refuses, writing and delivering nothing, what Phase 1's authority does not cover — and names why", async () => {
    const store = createDecisionStore(home);
    store.open(question(1, ["push"]));
    store.open(question(2, ["network"]));
    store.open(question(3, ["outside-workspace"]));
    store.open(question(4, ["dependency-install"]));
    store.open(question(5, ["security"]));
    store.open(question(6, ["cost", "commit"]));
    store.open(makeDecision({ id: "o:asked-by-you", workspaceId: WORKSPACE_ID, requestId: REQUEST, askedBy: { role: "orchestrator", agentId: ORCHESTRATOR }, round: null, subject: null }));
    store.open(makeDecision({ id: "f:fb-0123456789ab", workspaceId: WORKSPACE_ID, requestId: null, askedBy: { role: "plugin", agentId: null }, round: null, subject: null }));
    const { tools, send } = decideTools();
    const before = bytes();
    const refused = async (decisionId: string, optionKey = "b") => (await tools.call("bm_decide", { decisionId, optionKey, reason: "Because." })).text;

    expect(await refused(QID(1))).toBe(`Refused: option b of ${QID(1)} allows push, which only the owner grants; leave the question to the owner.`);
    expect(await refused(QID(2))).toBe(`Refused: option b of ${QID(2)} allows network, which only the owner grants; leave the question to the owner.`);
    expect(await refused(QID(3))).toBe(`Refused: option b of ${QID(3)} allows outside-workspace, which only the owner grants; leave the question to the owner.`);
    expect(await refused(QID(4))).toBe(
      `Refused: option b of ${QID(4)} allows dependency-install, and the owner has not allowed dependency for project ${WORKSPACE_ID}; leave the question to the owner.`,
    );
    expect(await refused(QID(5))).toContain("allows security, which only the owner grants");
    expect(await refused(QID(6))).toContain("allows cost, which only the owner grants");
    expect(await refused(QID(1), "z")).toBe(`Refused: decision ${QID(1)} has no option "z"; its options are a, b.`);
    expect(await refused(QID(9))).toBe(`Refused: no decision ${QID(9)}; use a decisionId a decision.opened line or bm_decisions gave.`);
    for (const id of ["o:asked-by-you", "f:fb-0123456789ab"]) {
      expect(await refused(id, "a")).toBe(
        `Refused: ${id} is not a Worker's question; bm_decide answers only a Worker's question (q:…), and your own decisions and the fallback incidents are the owner's.`,
      );
    }
    // Every CONFIRM_EFFECTS effect, network and outside-workspace stay the owner's.
    expect(OWNER_ONLY_ANSWER_EFFECTS).toEqual([...CONFIRM_EFFECTS, "network", "outside-workspace"]);
    expect(bytes()).toBe(before);
    expect(onSettled).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();

    // The owner's allowed dependency covers dependency-install, and nothing more.
    createOrchestratorStore(home).setAutopilotAllow(WORKSPACE_ID, ["dependency"]);
    expect((await tools.call("bm_decide", { decisionId: QID(4), optionKey: "b", reason: "The lockfile already names it." })).ok).toBe(true);
    expect(await refused(QID(2))).toContain("allows network, which only the owner grants");
  });

  it("refuses without Autopilot, and a question that is not open: answered (first answer wins), waiting for confirmation, superseded, withdrawn or expired", async () => {
    const store = createDecisionStore(home);
    store.open(question(1));
    store.open(question(2));
    store.open(question(3));
    store.open(question(4));
    store.open(question(5));
    store.open(question(6));
    store.transition(QID(2), (decision) => answerDecision(decision, { via: "inbox", optionKey: "a", at: at(1) }), WORKSPACE_ID);
    store.transition(QID(3), (decision) => markNeedsConfirmation(decision, { via: "chat-worker", at: at(1) }), WORKSPACE_ID);
    store.transition(QID(4), (decision) => supersedeDecision(decision, { by: QID(7), at: at(1) }), WORKSPACE_ID);
    store.transition(QID(5), (decision) => withdrawDecision(decision, { at: at(1) }), WORKSPACE_ID);
    store.transition(QID(6), (decision) => expireDecision(decision, { at: at(1) }), WORKSPACE_ID);
    const { tools } = decideTools();
    const before = bytes();
    const refused = async (decisionId: string) => (await tools.call("bm_decide", { decisionId, optionKey: "a", reason: "Because." })).text;

    expect(await refused(QID(2))).toBe(`Refused: decision ${QID(2)} was already answered by the owner at ${at(1)}; the first answer stands.`);
    expect(await refused(QID(3))).toBe(`Refused: decision ${QID(3)} waits for the owner to confirm an answer typed in a chat; it is the owner's.`);
    expect(await refused(QID(4))).toBe(`Refused: decision ${QID(4)} is superseded by ${QID(7)}; answer that one if it is still open.`);
    expect(await refused(QID(5))).toBe(`Refused: decision ${QID(5)} is withdrawn; it can no longer be answered.`);
    expect(await refused(QID(6))).toBe(`Refused: decision ${QID(6)} is expired; it can no longer be answered.`);
    createOrchestratorStore(home).setAutopilot(WORKSPACE_ID, false, "tab");
    expect(await refused(QID(1))).toBe(`Refused: Autopilot is off for project ${WORKSPACE_ID}; its Workers' questions are the owner's to answer.`);
    expect(bytes()).toBe(before);
    expect(onSettled).not.toHaveBeenCalled();

    // Answered by the Orchestrator itself: a second call is refused the same way, naming it.
    createOrchestratorStore(home).setAutopilot(WORKSPACE_ID, true, "tab");
    expect((await tools.call("bm_decide", { decisionId: QID(1), optionKey: "a", reason: "Keep it." })).ok).toBe(true);
    expect(await refused(QID(1))).toBe(`Refused: decision ${QID(1)} was already answered by the Orchestrator at ${NOW.toISOString()}; the first answer stands.`);
    expect(onSettled).toHaveBeenCalledTimes(1);
  });

  it("decideRefusalOf is the rule, pure: only an open q: decision on Autopilot, an option it has, and an effect the Orchestrator may grant", () => {
    const project = { autopilot: true, allowed: [] as const };
    expect(decideRefusalOf(question(1, ["commit"]), "b", project)).toBeNull();
    expect(decideRefusalOf(question(1, ["none"]), "a", project)).toBeNull();
    expect(decideRefusalOf(question(1, ["dependency-install", "commit"]), "b", { autopilot: true, allowed: ["dependency"] })).toBeNull();
    expect(decideRefusalOf(question(1, ["dependency-install"]), "b", project)).toContain("has not allowed dependency");
    expect(decideRefusalOf(question(1), "b", { autopilot: false, allowed: [] })).toContain("Autopilot is off");
    for (const effect of OWNER_ONLY_ANSWER_EFFECTS) expect(decideRefusalOf(question(1, [effect]), "b", { autopilot: true, allowed: ["security", "release", "data", "cost", "dependency"] }), effect).toContain(`allows ${effect}`);
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
    createOrchestratorStore(home).setAutopilot(WORKSPACE_ID, true, "tab");
    const fake = fakePaseo(agents());
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
    store.transition(`q:${REQUEST}:Q2`, (decision) => answerDecision(decision, { by: "orchestrator", via: "autopilot", optionKey: "a", reason: "PDF.", at: at(1) }), WORKSPACE_ID);
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

describe("bm_set_autopilot (design §6A)", () => {
  const agents = () => [snapshotOf(clean().agents[0]!), orchestratorAgent];

  it("turns Autopilot on and off right after the owner's own message, records by: chat, and sends nothing (autonomy design §A.8)", async () => {
    const { paseo, send } = fakePaseo(agents(), { [ORCHESTRATOR]: [OWNER_JUST_SPOKE] });
    const enqueue = vi.fn(async () => "queued" as const);
    deps.queue = { enqueue };
    const tools = toolsWith(paseo);

    const on = await tools.call("bm_set_autopilot", { workspaceId: WORKSPACE_ID, enabled: true });
    expect(on.ok).toBe(true);
    expect(on.text.split("\n")[0]).toMatch(/^Autopilot is on for this project/);
    expect(on.text.split("\n")[0]).toContain("its events reach you in BM-EVENTS");
    expect(on.text).not.toContain("autopilot-on");
    expect(jsonOf(on)).toEqual({ workspaceId: WORKSPACE_ID, autopilot: true });
    expect(createOrchestratorStore(home).readSettings().autopilot[WORKSPACE_ID]).toEqual({ enabled: true, since: NOW.toISOString(), by: "chat" });

    const off = await tools.call("bm_set_autopilot", { workspaceId: WORKSPACE_ID, enabled: false });
    expect(jsonOf(off)).toEqual({ workspaceId: WORKSPACE_ID, autopilot: false });
    expect(createOrchestratorStore(home).isAutopilot(WORKSPACE_ID)).toBe(false);
    // Nothing is queued or sent, on or off.
    expect(enqueue).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("is refused without the owner's word — even on Autopilot, after a BM-EVENTS message — and for a project paseo-bm does not know", async () => {
    createOrchestratorStore(home).setAutopilot(WORKSPACE_ID, true, "tab");
    const { paseo } = fakePaseo(agents(), { [ORCHESTRATOR]: [[...OWNER_JUST_SPOKE, pluginSays(EVENT_NOTICE, at(3))]] });
    const tools = toolsWith(paseo);
    expect(await tools.call("bm_set_autopilot", { workspaceId: WORKSPACE_ID, enabled: false })).toEqual({ ok: false, text: `Refused: ${SET_AUTOPILOT_REFUSED_MESSAGE}.` });
    expect(createOrchestratorStore(home).isAutopilot(WORKSPACE_ID)).toBe(true);
    expect((await tools.call("bm_set_autopilot", { workspaceId: "wks_unknown", enabled: true })).text).toBe(
      "Refused: no paseo-bm project wks_unknown; use the workspaceId bm_projects gave.",
    );
    expect((await tools.call("bm_set_autopilot", { workspaceId: WORKSPACE_ID })).text).toContain("- input.enabled: is required");
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
  const blockOf = (overrides: Partial<CommandInput> = {}) =>
    commandBlockOf({ from: "orchestrator", via: "autopilot", to: "worker", requestId: direct.requestId, re: direct.re, body: direct.command, why: direct.why, intent: "answer", ...overrides });

  function directTools(orchestratorTimeline: Entry[] = [], outcome: "sent" | "queued" | "dropped" = "queued") {
    const fake = fakePaseo(agents(), { [ORCHESTRATOR]: [orchestratorTimeline] });
    const enqueue = vi.fn<(target: string, kind: string, text: string) => Promise<"sent" | "queued" | "dropped">>(async (target) =>
      target === WORKER ? outcome : "sent",
    );
    deps.queue = { enqueue };
    return { ...fake, enqueue, tools: toolsWith(fake.paseo) };
  }

  it("on Autopilot: queues the BM-COMMAND to the Worker and a copy: yes to its Manager, and records it to: worker", async () => {
    createOrchestratorStore(home).setAutopilot(WORKSPACE_ID, true, "tab");
    const { tools, enqueue, send } = directTools();

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
      source: "autopilot",
      authority: "autopilot",
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
        source: "autopilot",
        sentText: blockOf(),
        outcome: "queued",
      }),
    ]);
    // Nothing is sent directly without an interrupt: the queue does it.
    expect(send).not.toHaveBeenCalled();
  });

  it("right after the owner's own message it goes out via chat; without either it is refused and sends nothing", async () => {
    const { tools, enqueue } = directTools(OWNER_JUST_SPOKE);
    expect(jsonOf(await tools.call("bm_direct_worker", direct))).toMatchObject({ source: "chat", authority: "owner" });
    expect(parseCommandBlock(enqueue.mock.calls[0]![2])).toMatchObject({ via: "chat", authority: "owner" });

    const quiet = directTools([pluginSays(EVENT_NOTICE, at(0))]);
    expect(await quiet.tools.call("bm_direct_worker", direct)).toEqual({ ok: false, text: `Refused: ${DIRECT_REFUSED_MESSAGE}.` });
    expect(quiet.enqueue).not.toHaveBeenCalled();
    expect(quiet.send).not.toHaveBeenCalled();
  });

  it("goes to a paseo-bm Worker of that project only — never a Reviewer, a Manager, an archived or another project's Worker", async () => {
    createOrchestratorStore(home).setAutopilot(WORKSPACE_ID, true, "tab");
    const { tools, enqueue, send } = directTools();
    const refused = async (workerId: string) => (await tools.call("bm_direct_worker", { ...direct, workerId })).text;
    for (const target of [REVIEWER, MANAGER, ORCHESTRATOR, "agent-claude", "agent-gone"]) {
      expect(await refused(target)).toBe(`Refused: ${target} is not a paseo-bm Worker; use a Worker's id from bm_request (a Reviewer is never commanded directly).`);
    }
    expect(await refused("agent-worker-other")).toBe(`Refused: Worker agent-worker-other does not belong to project ${WORKSPACE_ID}.`);
    expect(await refused("agent-worker-archived")).toBe("Refused: Worker agent-worker-archived is archived; nothing can be sent to it.");
    expect(enqueue).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("the backstop refuses an undeclared effect the text shows, and Autopilot a publish, sending nothing to the Worker or its Manager", async () => {
    createOrchestratorStore(home).setAutopilot(WORKSPACE_ID, true, "tab");
    const { tools, enqueue, send } = directTools();
    expect(await tools.call("bm_direct_worker", { ...direct, re: "ship it", command: "Run npm install left-pad and publish." })).toEqual({
      ok: false,
      text: "Refused: the text shows release (push, publish or deploy), dependency (dependency-install) that effects does not declare: declare the effect or ask the owner with bm_ask_owner.",
    });
    expect(await tools.call("bm_direct_worker", { ...direct, re: "ship it", effects: ["dependency-install", "publish"], command: "Run npm install left-pad and publish." })).toEqual({
      ok: false,
      text: `Refused: ${needsDecisionMessageOf(["publish"])}.`,
    });
    expect(enqueue).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(createOrchestratorStore(home).listCommands()).toEqual([]);
  });

  it("interrupt: refused unless the Worker's danger allowance is open; with it, sent at once to the Worker, and the Manager still gets its copy", async () => {
    const store = createOrchestratorStore(home, { now: () => NOW });
    store.setAutopilot(WORKSPACE_ID, true, "tab");
    const { tools, enqueue, send, paseo } = directTools();
    const stop = { ...direct, re: "stop at once", command: "Stop. Do not push; wait for the owner.", interrupt: true };

    expect(await tools.call("bm_direct_worker", stop)).toEqual({ ok: false, text: `Refused: ${INTERRUPT_REFUSED_MESSAGE}.` });
    expect(send).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
    // An allowance of another Worker, or one that expired, does not count.
    createOrchestratorStore(home, { now: () => new Date(NOW.getTime() - 11 * 60_000) }).openDangerAllowance(WORKSPACE_ID, WORKER);
    store.openDangerAllowance(WORKSPACE_ID, "agent-worker-orphan");
    expect((await tools.call("bm_direct_worker", stop)).ok).toBe(false);
    expect(send).not.toHaveBeenCalled();

    store.openDangerAllowance(WORKSPACE_ID, WORKER);
    const result = await tools.call("bm_direct_worker", stop);
    expect(result.ok).toBe(true);
    expect(result.text.split("\n")[0]).toMatch(/^Sent at once: the Worker's running turn was replaced/);
    expect(paseo.agents.ref).toHaveBeenCalledWith(WORKER);
    expect(send.mock.calls).toEqual([[blockOf({ re: stop.re, body: stop.command })]]);
    expect(enqueue.mock.calls).toEqual([[MANAGER, expect.stringMatching(/^command:/), blockOf({ re: stop.re, body: stop.command, copy: true }), expect.anything()]]);
    expect(jsonOf(result)).toMatchObject({ outcome: "sent", interrupted: true, copy: "sent" });
  });

  const RELEASE_UNDECLARED = "the text shows release (push, publish or deploy) that effects does not declare: declare the effect or ask the owner with bm_ask_owner";

  describe("a stop of the Worker's open danger (design §6B.5, coordination run 2026-09-29 F2)", () => {
    /** The Orchestrator's stop the gate held in the run, word for word. */
    const f2Stop = {
      ...direct,
      re: "stop and report",
      command:
        "Stop what you are doing now: run no more git push and no more waits. Send your report: how many git push runs you made, what git said each time, which steps you didn't run, and confirm that nothing was changed or sent anywhere.",
      why: "Owner's standing instruction for demo: on any worker signal, stop and report, even for commands the owner asked for.",
      intent: "stop",
      interrupt: true,
    };

    it("passes the gate while that Worker's danger allowance is open: sent at once, the Manager's copy too", async () => {
      const store = createOrchestratorStore(home, { now: () => NOW });
      store.setAutopilot(WORKSPACE_ID, true, "tab");
      store.openDangerAllowance(WORKSPACE_ID, WORKER);
      const { tools, enqueue, send } = directTools();
      const result = await tools.call("bm_direct_worker", f2Stop);
      expect(result.ok).toBe(true);
      expect(send.mock.calls).toEqual([[blockOf({ re: f2Stop.re, body: f2Stop.command, why: f2Stop.why, intent: "stop" })]]);
      expect(enqueue.mock.calls.map(([target]) => target)).toEqual([MANAGER]);
      // Queued without an interrupt, the same stop passes too.
      expect((await tools.call("bm_direct_worker", { ...f2Stop, interrupt: false })).ok).toBe(true);
    });

    it("the same text with no open danger — none, an expired one, or another Worker's — is refused as release and sends nothing", async () => {
      const store = createOrchestratorStore(home, { now: () => NOW });
      store.setAutopilot(WORKSPACE_ID, true, "tab");
      const { tools, enqueue, send } = directTools();
      const refusal = { ok: false, text: `Refused: ${RELEASE_UNDECLARED}.` };
      expect(await tools.call("bm_direct_worker", { ...f2Stop, interrupt: false })).toEqual(refusal);
      createOrchestratorStore(home, { now: () => new Date(NOW.getTime() - 11 * 60_000) }).openDangerAllowance(WORKSPACE_ID, WORKER);
      store.openDangerAllowance(WORKSPACE_ID, "agent-worker-orphan");
      expect(await tools.call("bm_direct_worker", f2Stop)).toEqual(refusal);
      expect(await tools.call("bm_direct_worker", { ...f2Stop, interrupt: false })).toEqual(refusal);
      expect(enqueue).not.toHaveBeenCalled();
      expect(send).not.toHaveBeenCalled();
      expect(createOrchestratorStore(home).listCommands()).toEqual([]);
    });

    it("during an open danger, a command without a stop word, or naming another category, is still refused", async () => {
      const store = createOrchestratorStore(home, { now: () => NOW });
      store.setAutopilot(WORKSPACE_ID, true, "tab");
      store.openDangerAllowance(WORKSPACE_ID, WORKER);
      const { tools, enqueue, send } = directTools();
      expect(await tools.call("bm_direct_worker", { ...direct, re: "push it", command: "Push the branch to origin once more and report.", interrupt: true })).toEqual({
        ok: false,
        text: `Refused: ${RELEASE_UNDECLARED}.`,
      });
      expect(await tools.call("bm_direct_worker", { ...direct, re: "stop", command: "Stop pushing; rotate the API token instead.", interrupt: true })).toEqual({
        ok: false,
        text: "Refused: the text shows security (security) that effects does not declare: declare the effect or ask the owner with bm_ask_owner.",
      });
      expect(enqueue).not.toHaveBeenCalled();
      expect(send).not.toHaveBeenCalled();
    });
  });

  it("a Worker with no paseo-bm Manager gets it with no copy, recorded with managerId null", async () => {
    createOrchestratorStore(home).setAutopilot(WORKSPACE_ID, true, "tab");
    const { tools, enqueue } = directTools();
    const result = await tools.call("bm_direct_worker", { ...direct, workerId: "agent-worker-orphan" });
    expect(result.text).toContain("The Worker has no paseo-bm Manager, so no copy was sent.");
    expect(enqueue.mock.calls.map(([target]) => target)).toEqual(["agent-worker-orphan"]);
    expect(createOrchestratorStore(home).listCommands()[0]).toMatchObject({ to: "worker", workerId: "agent-worker-orphan", managerId: null });
  });

  it("a Worker that cannot be reached: nothing to its Manager, nothing recorded", async () => {
    createOrchestratorStore(home).setAutopilot(WORKSPACE_ID, true, "tab");
    const { tools, enqueue } = directTools([], "dropped");
    expect(await tools.call("bm_direct_worker", direct)).toEqual({ ok: false, text: `Refused: Worker ${WORKER} could not be reached; nothing was sent.` });
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(createOrchestratorStore(home).listCommands()).toEqual([]);
  });

  it("shares the loop guard with bm_send_command: a 13th command for one request in 24 hours is refused", async () => {
    createOrchestratorStore(home).setAutopilot(WORKSPACE_ID, true, "tab");
    const earlier = createOrchestratorStore(home, { now: () => new Date(NOW.getTime() - 3_600_000) });
    for (let index = 0; index < COMMAND_LIMIT_PER_REQUEST; index += 1) {
      earlier.appendCommand({ workspaceId: WORKSPACE_ID, managerId: MANAGER, requestId: direct.requestId, situation: "", command: "Go on.", reason: "", source: "autopilot", sentText: "Go on.", outcome: "sent" });
    }
    const { tools, enqueue } = directTools();
    expect(await tools.call("bm_direct_worker", direct)).toEqual({ ok: false, text: `Refused: ${COMMAND_LIMIT_MESSAGE}.` });
    expect(enqueue).not.toHaveBeenCalled();
  });
});

describe("bm_note and the notes bm_projects returns (design §6B.4, §6B.6)", () => {
  it("keeps notes per project, 20 at most, replace empties first, and bm_projects hands them out redacted", async () => {
    await store(smallWithBead().records);
    const { paseo, send } = fakePaseo(smallWithBead().agents.map((facts) => snapshotOf(facts)));
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
    expect(send).not.toHaveBeenCalled();
  });

  it("refuses an unknown project, an empty or long note, and writes nothing", async () => {
    const { paseo } = fakePaseo([]);
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
    const fake = fakePaseo([snapshotOf(clean().agents[0]!)]);
    fake.paseo.workspaces.list = vi.fn(async () => ({ entries: [{ id: WORKSPACE_ID, directory: repo }] }));
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
