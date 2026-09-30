/**
 * Trace fixtures for the Orchestrator's rules (Orchestrator design §4.2, §11;
 * PRD O-1): the four slips of the 2026-09-26 run record
 * (`docs/archive/operations/paseo-bm-install-run-20260926.md`) and one clean
 * request.
 *
 * Each fixture is written as the trace store would hold it — turn records and
 * the live agent list — and goes through the real `reconstructTraces` and
 * `ruleInputOf`, so the rules are tested on what the server would hand them.
 *
 * | Fixture | Run record | Slip |
 * |---|---|---|
 * | `smallWithBead` | Worker sizing (§3, `notes` of the Worker profile) | a Small request that still creates a bead |
 * | `languageAfterReport` | §5 "Manager behaviour", P4 | the Manager answers a Vietnamese user in English once a `BM-REPORT` arrives |
 * | `correctedModel` | T2.2, R1.4 | the Manager asks `bm-worker/claude-opus-5-5` after the Worker moved to Codex; a Reviewer asks for model `default` |
 * | `failedFirstTurn` | L3 | the Worker, created with the old Claude model on a Codex profile, fails its first turn |
 * | `clean` | T1.5, R1.3 | a Medium request done by the book |
 *
 * The run record has no transcript; the messages are rebuilt from what it
 * says, in the language the user wrote in (Vietnamese).
 */
import { REVIEW_BUDGET } from "../../plugin/server/review-budget";
import { reconstructTraces, type AgentFacts } from "../../plugin/server/traces";
import { ruleInputOf } from "../../plugin/server/request-trace";
import { TRACE_STORE_SCHEMA_VERSION, type Evidence, type ParsedReport, type TraceRecord } from "../../plugin/shared/contracts";
import type { ModelCorrection } from "../../plugin/shared/orchestrator";
import type { RuleFacts } from "../../plugin/shared/orchestrator-rules";
import type { RuleInput } from "../../plugin/shared/rule-input";

export const WORKSPACE_ID = "wks_invoice";
export const WORKSPACE_DIRECTORY = "/work/invoice-app";
export const MANAGER = "agent-manager";
export const WORKER = "agent-worker";
export const REVIEWER = "agent-reviewer";

/** A time on the day of the run, 2026-09-26 at 10:mm:ss UTC. */
export const at = (minute: number, second = 0): string =>
  `2026-09-26T10:${String(minute).padStart(2, "0")}:${String(second).padStart(2, "0")}.000Z`;

export interface RuleFixture {
  requestId: string;
  input: RuleInput;
  facts: RuleFacts;
  /** What the trace store holds for the request, for tests that go through the store. */
  records: TraceRecord[];
  /** The live agents `agents.list` would report. */
  agents: AgentFacts[];
}

// ── Builders ────────────────────────────────────────────────────────────────

export function turn(overrides: Partial<TraceRecord>): TraceRecord {
  return {
    v: TRACE_STORE_SCHEMA_VERSION,
    kind: "turn",
    at: at(0),
    workspaceId: WORKSPACE_ID,
    agentId: MANAGER,
    role: "manager",
    turnId: "turn-1",
    requestId: null,
    parentAgentId: null,
    agentCreatedAt: null,
    startedAt: null,
    endedAt: at(0),
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

export function report(overrides: Partial<ParsedReport>): ParsedReport {
  return {
    agentId: WORKER,
    at: at(1),
    requestId: null,
    phase: "received",
    tier: "Medium",
    filesChanged: [],
    beadsCreated: [],
    beadsUpdated: [],
    beadsClosed: [],
    beadsReady: [],
    reviewFindingsOpen: null,
    buildAndTests: null,
    skillsUsed: [],
    blockers: null,
    guardrail: null,
    unparsedFields: [],
    incompleteFields: [],
    ...overrides,
  };
}

export const msg = (agentId: string, when: string, text: string, origin?: "user" | "agent") => ({
  agentId,
  at: when,
  text,
  truncated: false,
  ...(origin === undefined ? {} : { origin }),
});

export const shell = (command: string, when: string, agentId = WORKER): Evidence => ({
  kind: "shell",
  detail: command,
  agentId,
  at: when,
});

export const file = (path: string, when: string, agentId = WORKER): Evidence => ({
  kind: "file",
  detail: path,
  agentId,
  at: when,
});

export function agent(overrides: Partial<AgentFacts> & Pick<AgentFacts, "id" | "role">): AgentFacts {
  return {
    status: "idle",
    parentAgentId: null,
    createdAt: null,
    requestIdLabel: null,
    batchIdLabel: null,
    archived: false,
    ...overrides,
  };
}

export function factsWith(overrides: Partial<RuleFacts> = {}): RuleFacts {
  return { reviewBudget: REVIEW_BUDGET, corrections: [], workspaceDirectory: WORKSPACE_DIRECTORY, ...overrides };
}

/** The `RuleInput` of one request, rebuilt from records and agents as the server does. */
export function inputOf(requestId: string, records: TraceRecord[], agents: AgentFacts[]): RuleInput {
  const trace = reconstructTraces({ records, agents }).find((candidate) => candidate.requestId === requestId);
  if (trace === undefined) throw new Error(`fixture request ${requestId} was not reconstructed`);
  return ruleInputOf(trace, new Map(agents.map((entry) => [entry.id, entry])));
}

function reportText(requestId: string, phase: string, tier: string): string {
  return `BM-REPORT\nrequestId: ${requestId}\nphase: ${phase}\ntier: ${tier}`;
}

// ── A Medium request done by the book ──────────────────────────────────────

interface MediumOptions {
  requestId: string;
  userText: string;
  /** What the Manager wrote in each of its three turns; null = no text (tool calls only). */
  managerTexts: [string | null, string | null, string | null];
  workerCreatedAt?: string;
  reviewerCreatedAt?: string;
}

/**
 * The shape of T1.5 / R1.3: the Manager hands the request to a Worker, the
 * Worker sizes it Medium, creates and closes a bead, calls one Reviewer once,
 * and reports `finished`.
 */
function mediumRequest(options: MediumOptions): { records: TraceRecord[]; agents: AgentFacts[] } {
  const { requestId } = options;
  const replies = (index: number, when: string) => {
    const text = options.managerTexts[index];
    return text === null || text === undefined ? [] : [msg(MANAGER, when, text)];
  };
  const records: TraceRecord[] = [
    turn({
      at: at(0, 40),
      turnId: "m-1",
      requestId,
      startedAt: at(0, 20),
      endedAt: at(0, 40),
      sent: [msg(MANAGER, at(0, 20), options.userText, "user")],
      received: replies(0, at(0, 35)),
    }),
    turn({
      agentId: WORKER,
      role: "worker",
      at: at(6),
      turnId: "w-1",
      requestId,
      parentAgentId: MANAGER,
      startedAt: at(0, 45),
      endedAt: at(6),
      sent: [msg(WORKER, at(0, 45), `Request ${requestId}: ${options.userText}`, "agent")],
      evidence: [
        shell(`br create "Export an invoice to PDF" -l feature:hoa-don --json`, at(1, 30)),
        shell("br update bm-p1 --status in_progress", at(1, 40)),
        file("src/invoice/export-pdf.ts", at(2)),
        file("docs/design/invoice.md", at(2, 30)),
        shell("npm test", at(3)),
        shell(`br close bm-p1 --reason "npm test: 7 passed"`, at(3, 30)),
      ],
    }),
    turn({
      at: at(1, 20),
      turnId: "m-2",
      requestId,
      startedAt: at(1, 10),
      endedAt: at(1, 20),
      sent: [msg(MANAGER, at(1, 10), reportText(requestId, "received", "Medium"), "agent")],
      received: replies(1, at(1, 15)),
      reports: [report({ agentId: WORKER, at: at(1, 10), requestId, phase: "received", tier: "Medium" })],
    }),
    turn({
      agentId: REVIEWER,
      role: "reviewer",
      at: at(5),
      turnId: "r-1",
      requestId,
      parentAgentId: WORKER,
      startedAt: at(4),
      endedAt: at(5),
      sent: [msg(REVIEWER, at(4), `Review batch b1 of ${requestId}, stage implementation. npm test: 7 passed.`, "agent")],
      received: [msg(REVIEWER, at(5), `BM-REVIEW\nrequestId: ${requestId}\nbatchId: b1\nverdict: approved`)],
    }),
    turn({
      at: at(6, 30),
      turnId: "m-3",
      requestId,
      startedAt: at(6, 10),
      endedAt: at(6, 30),
      sent: [msg(MANAGER, at(6, 10), reportText(requestId, "finished", "Medium"), "agent")],
      received: replies(2, at(6, 25)),
      reports: [
        report({
          agentId: WORKER,
          at: at(6, 10),
          requestId,
          phase: "finished",
          tier: "Medium",
          filesChanged: ["src/invoice/export-pdf.ts", "docs/design/invoice.md"],
          beadsCreated: ["bm-p1"],
          beadsClosed: ["bm-p1"],
          buildAndTests: "npm test: 7 passed",
          blockers: "none",
        }),
      ],
    }),
  ];
  const agents = [
    agent({ id: MANAGER, role: "manager" }),
    agent({ id: WORKER, role: "worker", parentAgentId: MANAGER, createdAt: options.workerCreatedAt ?? at(0, 30), requestIdLabel: requestId }),
    agent({
      id: REVIEWER,
      role: "reviewer",
      parentAgentId: WORKER,
      createdAt: options.reviewerCreatedAt ?? at(3, 50),
      requestIdLabel: requestId,
      batchIdLabel: "b1",
    }),
  ];
  return { records, agents };
}

const VI_REQUEST = "Thêm nút xuất hoá đơn ra file PDF trên màn hình chi tiết hoá đơn, giữ đúng định dạng ngày.";
const VI_HANDOFF = "Mình đã giao việc này cho Beads Worker, có kết quả mình sẽ báo lại ngay.";
const VI_RECEIVED = "Worker đã nhận việc và xếp nó vào cỡ Medium, đang bắt đầu làm.";
const VI_FINISHED = "Đã xong: màn hình chi tiết hoá đơn có nút Xuất PDF, Reviewer duyệt, 7 test đều đạt.";

/** T1.5 / R1.3: a Medium request, one Reviewer call, Vietnamese all the way — no flag. */
export function clean(): RuleFixture {
  const requestId = "req-20260926T100020Z";
  const { records, agents } = mediumRequest({ requestId, userText: VI_REQUEST, managerTexts: [VI_HANDOFF, VI_RECEIVED, VI_FINISHED] });
  return {
    requestId,
    records,
    agents,
    input: inputOf(requestId, records, agents),
    facts: factsWith({
      // Corrections of other requests: another workspace folder, and this
      // folder but long before the Worker started.
      corrections: [
        { at: at(0, 29), alias: "bm-worker", requested: "claude-opus-5-5", profileModel: "gpt-5.6-sol", cwd: "/work/other-app" },
        { at: "2026-09-26T09:00:00.000Z", alias: "bm-worker", requested: "claude-opus-5-5", profileModel: "gpt-5.6-sol", cwd: WORKSPACE_DIRECTORY },
      ],
    }),
  };
}

/**
 * §5 "Manager behaviour": the user writes Vietnamese and the Manager hands the
 * request over in Vietnamese; once the Worker's English `BM-REPORT` arrives,
 * the Manager answers in English.
 */
export function languageAfterReport(): RuleFixture {
  const requestId = "req-20260926T100021Z";
  const { records, agents } = mediumRequest({
    requestId,
    userText: VI_REQUEST,
    managerTexts: [
      VI_HANDOFF,
      "The Worker has sized this as a Medium request and started on it.",
      "Done: the invoice detail screen now has an Export PDF button; the Reviewer approved it and 7 tests pass.",
    ],
  });
  return { requestId, records, agents, input: inputOf(requestId, records, agents), facts: factsWith() };
}

/**
 * T2.2 / R1.4: the Worker and Reviewer were moved to Codex; the Manager still
 * asks for `bm-worker/claude-opus-5-5`, the Worker asks for a Reviewer with
 * model `default`, and the hook starts both on the profile's model.
 */
export const MODEL_CORRECTIONS: readonly ModelCorrection[] = [
  { at: at(0, 28), alias: "bm-worker/claude-opus-5-5", requested: "claude-opus-5-5", profileModel: "gpt-5.6-sol", cwd: WORKSPACE_DIRECTORY },
  { at: at(3, 49), alias: "bm-reviewer/default", requested: "default", profileModel: "gpt-5.6-sol", cwd: WORKSPACE_DIRECTORY },
];

export function correctedModel(): RuleFixture {
  const requestId = "req-20260926T100022Z";
  const { records, agents } = mediumRequest({
    requestId,
    userText: VI_REQUEST,
    managerTexts: [VI_HANDOFF, VI_RECEIVED, VI_FINISHED],
    workerCreatedAt: at(0, 30),
    reviewerCreatedAt: at(3, 50),
  });
  return {
    requestId,
    records,
    agents,
    input: inputOf(requestId, records, agents),
    facts: factsWith({ corrections: MODEL_CORRECTIONS }),
  };
}

/**
 * L3: the Manager, remembering the old profile, created the Worker with
 * `bm-worker/claude-opus-5-5` on a Codex profile; Codex refused the model and
 * the Worker's first turn failed before it sent any report.
 */
export function failedFirstTurn(): RuleFixture {
  const requestId = "req-20260926T100023Z";
  const records: TraceRecord[] = [
    turn({
      at: at(0, 40),
      turnId: "m-1",
      requestId,
      startedAt: at(0, 20),
      endedAt: at(0, 40),
      sent: [msg(MANAGER, at(0, 20), VI_REQUEST, "user")],
      received: [msg(MANAGER, at(0, 35), VI_HANDOFF)],
    }),
    turn({
      agentId: WORKER,
      role: "worker",
      at: at(0, 50),
      turnId: "w-1",
      requestId,
      parentAgentId: MANAGER,
      startedAt: at(0, 45),
      endedAt: at(0, 50),
      outcome: "failed",
      sent: [msg(WORKER, at(0, 45), `Request ${requestId}: ${VI_REQUEST}`, "agent")],
    }),
  ];
  const agents = [
    agent({ id: MANAGER, role: "manager" }),
    agent({ id: WORKER, role: "worker", status: "error", parentAgentId: MANAGER, createdAt: at(0, 30), requestIdLabel: requestId }),
  ];
  return { requestId, records, agents, input: inputOf(requestId, records, agents), facts: factsWith() };
}

/**
 * A Small request that still creates a bead: the Worker profile's `notes`
 * (run record §3) say a Small request gets none, and `br create` names no id,
 * so only the command and the finished report show it.
 */
export function smallWithBead(): RuleFixture {
  const requestId = "req-20260926T100024Z";
  const userText = "Sửa định dạng ngày trên màn hình Hoá đơn thành dd/mm/yyyy.";
  const records: TraceRecord[] = [
    turn({
      at: at(0, 40),
      turnId: "m-1",
      requestId,
      startedAt: at(0, 20),
      endedAt: at(0, 40),
      sent: [msg(MANAGER, at(0, 20), userText, "user")],
      received: [msg(MANAGER, at(0, 35), VI_HANDOFF)],
    }),
    turn({
      agentId: WORKER,
      role: "worker",
      at: at(3),
      turnId: "w-1",
      requestId,
      parentAgentId: MANAGER,
      startedAt: at(0, 45),
      endedAt: at(3),
      sent: [msg(WORKER, at(0, 45), `Request ${requestId}: ${userText}`, "agent")],
      evidence: [
        shell(`br create "Fix the invoice date format" -l feature:hoa-don --json`, at(1, 30)),
        file("src/invoice/date.ts", at(2)),
        shell("npm test", at(2, 20)),
        shell(`br close bm-d1 --reason "npm test: 12 passed"`, at(2, 40)),
      ],
    }),
    turn({
      at: at(1, 20),
      turnId: "m-2",
      requestId,
      startedAt: at(1, 10),
      endedAt: at(1, 20),
      sent: [msg(MANAGER, at(1, 10), reportText(requestId, "received", "Small"), "agent")],
      received: [msg(MANAGER, at(1, 15), "Worker đã nhận việc, xếp vào cỡ Small.")],
      reports: [report({ agentId: WORKER, at: at(1, 10), requestId, phase: "received", tier: "Small" })],
    }),
    turn({
      at: at(3, 20),
      turnId: "m-3",
      requestId,
      startedAt: at(3, 5),
      endedAt: at(3, 20),
      sent: [msg(MANAGER, at(3, 5), reportText(requestId, "finished", "Small"), "agent")],
      received: [msg(MANAGER, at(3, 15), "Đã xong: ngày trên màn hình Hoá đơn hiện theo dd/mm/yyyy, 12 test đều đạt.")],
      reports: [
        report({
          agentId: WORKER,
          at: at(3, 5),
          requestId,
          phase: "finished",
          tier: "Small",
          filesChanged: ["src/invoice/date.ts"],
          beadsCreated: ["bm-d1"],
          beadsClosed: ["bm-d1"],
          buildAndTests: "npm test: 12 passed",
          blockers: "none",
        }),
      ],
    }),
  ];
  const agents = [
    agent({ id: MANAGER, role: "manager" }),
    agent({ id: WORKER, role: "worker", parentAgentId: MANAGER, createdAt: at(0, 30), requestIdLabel: requestId }),
  ];
  return { requestId, records, agents, input: inputOf(requestId, records, agents), facts: factsWith() };
}
