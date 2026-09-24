import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isPluginNotice } from "../plugin/server/notices";
import { createNoticeQueue } from "../plugin/server/notice-queue";
import {
  QA_LEDGER_REQUEST_LIMIT,
  answeredNotice,
  answeredNoticeKind,
  QA_LEDGER_SCHEMA_VERSION,
  answeredIds,
  answersIn,
  openQuestionIds,
  qaLedgerPath,
  questionsIn,
  questionsWithAnswers,
  readQaLedger,
  recordEntries,
  recordTurn,
  type QaTurnEvent,
} from "../plugin/server/qa-ledger";
import type { TraceStoreLocation } from "../plugin/server/trace-store";

/**
 * The question–answer ledger (design delta 20260924-qa-ledger §3). The two
 * fixtures are real messages from the paseo-bm workspace's own trace: the
 * `blocked` report with Q14 that reached Manager e94f3988 at
 * 2026-09-23T09:10:36Z, and the card answer that reached Worker dced724 at
 * 09:43:59Z. At 09:51:45Z that Worker went idle waiting for Reviewer b6
 * without a new report, and at 09:53:16Z the user answered Q14 a second time.
 */
const fixture = (name: string): string => readFileSync(join(__dirname, "fixtures", "qa-ledger", name), "utf8");
const REPORT_Q14 = fixture("report-q14-blocked.txt");
const ANSWER_Q14 = fixture("answer-q14-card.txt");
const REQUEST = "req-20260923T063441Z";
const WORKSPACE = "wks_paseo_bm";
const MANAGER = "e94f3988-0d23-4ba2-9356-c5592286f5cc";
const WORKER = "dced7240-0000-4000-8000-000000000001";

/** A report asking four questions, the shape of the 2026-09-22 Q16–Q19 case. */
const REPORT_FOUR = [
  "BM-REPORT",
  "requestId: req-20260922T135101Z",
  "phase: blocked",
  "tier: Large (changed: no)",
  "filesChanged: none",
  "beadsCreated: none",
  "beadsUpdated: none",
  "beadsClosed: none",
  "beadsReady: none",
  "reviewFindingsOpen: none",
  "buildAndTests: not run",
  "skillsUsed: feature-workflow",
  "blockers: 4 questions: Q16, Q17, Q18, Q19 — see BM-QUESTIONS",
  "",
  "BM-QUESTIONS",
  "requestId: req-20260922T135101Z",
  "Q16: Phase order — which phase ships first.",
  "- a: foundations first. (recommended)",
  "- b: customer screens first.",
  "Q17: Routes — where the new screens live.",
  "- a: under the old menu. (recommended)",
  "- b: under a /turnover prefix.",
  "Q18: File uploads — keep them in scope?",
  "- a: keep. (recommended)",
  "- b: drop.",
  "Q19: Document status after review.",
  "- a: Accepted and Active when the review passes. (recommended)",
  "- b: stay Draft.",
].join("\n");

const cardAnswer = (lines: string[], requestId = "req-20260922T135101Z"): string =>
  [`Reply from the user about \`${requestId}\`:`, "", "BM-ANSWERS", `requestId: ${requestId}`, ...lines].join("\n");

const relayed = (lines: string[], requestId = "req-20260922T135101Z"): string =>
  [`Continue ${requestId}.`, "", "Do what you proposed.", "", "BM-ANSWERS", `requestId: ${requestId}`, ...lines].join("\n");

const fromAgent = (text: string) => ({ type: "user_message", text });
const fromApp = (text: string) => ({ type: "user_message", text, clientMessageId: "client-1" });

describe("qa ledger", () => {
  let home: string;
  let location: TraceStoreLocation;
  let clock: number;
  const now = () => new Date(Date.UTC(2026, 8, 24, 3, 0, clock++));

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "bm-qa-ledger-"));
    location = { tracesDir: join(home, "traces") } as TraceStoreLocation;
    clock = 0;
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  const managerTurn = (timeline: unknown[]): QaTurnEvent => ({
    agent: { id: MANAGER, workspaceId: WORKSPACE, parentAgentId: null, provider: "bm-manager" },
    turnId: "foreground-turn-1",
    timeline,
  });
  const workerTurn = (timeline: unknown[]): QaTurnEvent => ({
    agent: { id: WORKER, workspaceId: WORKSPACE, parentAgentId: MANAGER, provider: "bm-worker/claude-opus-5" },
    turnId: "foreground-turn-1",
    timeline,
  });
  const deps = (log: string[] = []) => ({ paseo: {}, resolveLocation: async () => location, log: (m: string) => log.push(m), now });

  describe("reading timelines", () => {
    it("takes the Manager's questions only from another agent's message", () => {
      expect(questionsIn([fromAgent(REPORT_Q14)])).toEqual([
        { requestId: REQUEST, id: "Q14", text: expect.stringContaining("Hai chỗ sửa cuối") },
      ]);
      // The user typing a block in the Manager's chat is not a Worker's question.
      expect(questionsIn([fromApp(REPORT_Q14)])).toEqual([]);
      // The plugin's own notices are never questions.
      expect(questionsIn([fromAgent(`BM-FORMAT requestId: ${REQUEST}\n${REPORT_Q14}`)])).toEqual([]);
    });

    it("reads a real card answer as the user's and a relayed one as an agent's", () => {
      expect(answersIn([fromApp(ANSWER_Q14)])).toEqual([
        { requestId: REQUEST, id: "Q14", text: expect.stringMatching(/^a — đi tiếp sang beads\./), via: "user" },
      ]);
      expect(answersIn([fromAgent(relayed(["Q18: other — drop everything about files"]))])).toEqual([
        { requestId: "req-20260922T135101Z", id: "Q18", text: "other — drop everything about files", via: "agent" },
      ]);
    });

    it("stops at the user's own words after the block", () => {
      const text = `${cardAnswer(["Q16: a — foundations first."])}\n\nQ99: this line is prose, not an answer`;
      expect(answersIn([fromApp(text)]).map((answer) => answer.id)).toEqual(["Q16"]);
    });
  });

  describe("recording a turn end", () => {
    it("records Q14 at the Manager, its card answer at the Worker, and Q14 is answered", async () => {
      await recordTurn(managerTurn([fromAgent(REPORT_Q14)]), deps());
      let ledger = readQaLedger(location);
      expect(openQuestionIds(ledger, REQUEST)).toEqual(["Q14"]);

      const outcome = await recordTurn(workerTurn([fromApp(ANSWER_Q14)]), deps());
      expect(outcome.result?.addedAnswers).toMatchObject([{ requestId: REQUEST, id: "Q14", via: "user", workerId: WORKER }]);
      ledger = readQaLedger(location);
      expect([...answeredIds(ledger, REQUEST)]).toEqual(["Q14"]);
      expect(openQuestionIds(ledger, REQUEST)).toEqual([]);
      const file = JSON.parse(readFileSync(qaLedgerPath(location), "utf8"));
      expect(file.schemaVersion).toBe(QA_LEDGER_SCHEMA_VERSION);
      expect(file.requests[0]).toMatchObject({ requestId: REQUEST, workspaceId: WORKSPACE });
    });

    it("A2: the same timeline recorded twice adds nothing the second time", async () => {
      const timeline = [fromApp(cardAnswer(["Q16: a — foundations first.", "Q17: a — under the old menu."]))];
      const first = await recordTurn(workerTurn(timeline), deps());
      const second = await recordTurn(workerTurn(timeline), deps());
      expect(first.result?.addedAnswers).toHaveLength(2);
      expect(second.result?.addedAnswers).toEqual([]);
      expect(second.result?.written).toBe(false);
      await recordTurn(managerTurn([fromAgent(REPORT_FOUR)]), deps());
      await recordTurn(managerTurn([fromAgent(REPORT_FOUR)]), deps());
      expect(readQaLedger(location).requests[0]!.questions.map((question) => question.id)).toEqual(["Q16", "Q17", "Q18", "Q19"]);
      expect(readQaLedger(location).requests[0]!.answers).toHaveLength(2);
    });

    it("A2: via is user for a message from the app and agent for a relay", async () => {
      await recordTurn(
        workerTurn([
          fromApp(cardAnswer(["Q16: a — foundations first."])),
          fromAgent(relayed(["Q18: other — drop everything about files"])),
        ]),
        deps(),
      );
      const answers = readQaLedger(location).requests[0]!.answers;
      expect(answers.map((answer) => [answer.id, answer.via])).toEqual([
        ["Q16", "user"],
        ["Q18", "agent"],
      ]);
    });

    it("keeps a second, different answer, and the latest is the one handed over", async () => {
      await recordTurn(managerTurn([fromAgent(REPORT_FOUR)]), deps());
      await recordTurn(workerTurn([fromApp(cardAnswer(["Q18: other — never"]))]), deps());
      await recordTurn(workerTurn([fromAgent(relayed(["Q18: other — drop everything about files"]))]), deps());
      const q18 = questionsWithAnswers(readQaLedger(location), "req-20260922T135101Z").find((entry) => entry.question.id === "Q18");
      expect(q18?.answer?.text).toBe("other — drop everything about files");
      expect(readQaLedger(location).requests[0]!.answers.filter((answer) => answer.id === "Q18")).toHaveLength(2);
    });

    it("partly answered: only the unanswered question stays open", async () => {
      await recordTurn(managerTurn([fromAgent(REPORT_FOUR)]), deps());
      await recordTurn(
        workerTurn([fromApp(cardAnswer(["Q16: a — foundations first.", "Q17: b — under a /turnover prefix.", "Q19: a — Accepted."]))]),
        deps(),
      );
      expect(openQuestionIds(readQaLedger(location), "req-20260922T135101Z")).toEqual(["Q18"]);
    });

    it("masks a secret before it is written", async () => {
      await recordTurn(workerTurn([fromApp(cardAnswer(["Q16: other — the password is hunter2-live"]))]), {
        ...deps(),
        env: { PASEO_PASSWORD: "hunter2-live" },
      } as never);
      const raw = readFileSync(qaLedgerPath(location), "utf8");
      expect(raw).not.toContain("hunter2-live");
    });

    it("ignores a Reviewer's turn and a turn with nothing to record, without touching the disk", async () => {
      const reviewer = { ...workerTurn([fromApp(ANSWER_Q14)]), agent: { ...workerTurn([]).agent, provider: "bm-reviewer" } };
      expect((await recordTurn(reviewer, deps())).role).toBeNull();
      expect((await recordTurn(workerTurn([fromApp("thanks")]), deps())).result).toBeNull();
      expect(() => readFileSync(qaLedgerPath(location))).toThrow();
    });
  });

  describe("A7: a bad file never breaks a turn and is never written over", () => {
    const writeRaw = (body: string) => {
      mkdirSync(join(home, "ui"), { recursive: true });
      writeFileSync(qaLedgerPath(location), body);
    };

    it("reads a corrupt file as empty and says so", () => {
      writeRaw("{ not json");
      expect(readQaLedger(location)).toMatchObject({ requests: [], tooNew: false, notices: [expect.stringContaining("not valid JSON")] });
      writeRaw(JSON.stringify({ schemaVersion: 1, requests: [{ requestId: 5 }] }));
      expect(readQaLedger(location).notices[0]).toContain("expected shape");
    });

    it("never writes over a newer version's file", async () => {
      const newer = JSON.stringify({ schemaVersion: 2, requests: [] });
      writeRaw(newer);
      const log: string[] = [];
      const outcome = await recordTurn(workerTurn([fromApp(ANSWER_Q14)]), deps(log));
      expect(outcome.result?.written).toBe(false);
      expect(readFileSync(qaLedgerPath(location), "utf8")).toBe(newer);
      expect(log.join("\n")).toContain("newer than this plugin understands");
    });

    it("refuses a symlinked file with one log line instead of throwing", async () => {
      mkdirSync(join(home, "ui"), { recursive: true });
      const elsewhere = join(home, "elsewhere.json");
      writeFileSync(elsewhere, "{}");
      symlinkSync(elsewhere, qaLedgerPath(location));
      const log: string[] = [];
      await expect(recordTurn(workerTurn([fromApp(ANSWER_Q14)]), deps(log))).resolves.toMatchObject({ result: null });
      expect(log).toHaveLength(1);
      expect(readFileSync(elsewhere, "utf8")).toBe("{}");
    });
  });

  it("takes a relayed block's requestId from its Continue line when the block has none (review finding 3)", () => {
    const text = ["Continue req-20260922T135101Z.", "", "Do what you proposed.", "", "BM-ANSWERS", "Q18: other — drop everything about files"].join("\n");
    expect(answersIn([fromAgent(text)])).toEqual([
      { requestId: "req-20260922T135101Z", id: "Q18", text: "other — drop everything about files", via: "agent" },
    ]);
  });

  it("does not rewrite the file when a re-worded question is seen again in a rescan (review finding 6)", async () => {
    const reworded = REPORT_FOUR.replace("Q18: File uploads — keep them in scope?", "Q18: File uploads — keep them, now that CRM is out?");
    const timeline = [fromAgent(REPORT_FOUR), fromAgent(reworded)];
    const first = await recordTurn(managerTurn(timeline), deps());
    const second = await recordTurn(managerTurn(timeline), deps());
    expect(first.result?.written).toBe(true);
    expect(second.result?.written).toBe(false);
    expect(readQaLedger(location).requests[0]!.questions.find((question) => question.id === "Q18")?.text).toContain("now that CRM is out");
  });

  it("keeps only the most recently updated requests", () => {
    for (let index = 0; index < QA_LEDGER_REQUEST_LIMIT + 2; index += 1) {
      const requestId = `req-20260901T${String(100000 + index).slice(-6)}Z`;
      recordEntries(location, { workspaceId: WORKSPACE, workerId: null, questions: [{ requestId, id: "Q1", text: "q" }], answers: [] }, { now });
    }
    const { requests } = readQaLedger(location);
    expect(requests).toHaveLength(QA_LEDGER_REQUEST_LIMIT);
    expect(requests[0]!.requestId).toBe("req-20260901T100002Z");
  });

  /**
   * BM-ANSWERED (design §5, A3): a card answer goes straight to the Worker, so
   * without this its Manager told the user "Q16, Q17 và Q19 vẫn chưa có câu trả
   * lời" (2026-09-22T17:11:02Z) and relayed Q28, Q29 and Q5 again at 05:58 the
   * next day.
   */
  describe("BM-ANSWERED to the Manager", () => {
    type Sent = { targetId: string; kind: string; text: string };
    const agent = (id: string, role: string, extra: Record<string, unknown> = {}) => ({
      agent: { id, provider: `bm-${role}`, labels: { "bm.role": role }, status: "idle", archivedAt: null, workspaceId: WORKSPACE, cwd: "/r", title: null, ...extra },
      project: { workspace: { id: WORKSPACE } },
    });
    const paseoWith = (entries: unknown[]) => ({
      agents: { list: async () => ({ entries }) },
      workspaces: { list: async () => ({ entries: [] }) },
      config: { get: async () => ({ config: {} }) },
    });
    const notifyingDeps = (entries: unknown[], sent: Sent[], log: string[] = []) => ({
      ...deps(log),
      paseo: paseoWith(entries),
      notify: async (targetId: string, kind: string, text: string) => {
        sent.push({ targetId, kind, text });
        return "sent" as const;
      },
    });
    const managers = [agent(MANAGER, "manager"), agent(WORKER, "worker", { parentAgentId: MANAGER })];

    it("A3: tells the Worker's Manager once, with what is still open, through the queue", async () => {
      const sent: Sent[] = [];
      await recordTurn(managerTurn([fromAgent(REPORT_FOUR)]), deps());
      const answer = fromApp(cardAnswer(["Q16: a — foundations first.", "Q17: a — under the old menu.", "Q19: a — Accepted."]));
      const turn = workerTurn([fromAgent("the first prompt"), answer]);
      const first = await recordTurn(turn, notifyingDeps(managers, sent));
      expect(first.notices).toEqual([{ managerId: MANAGER, requestId: "req-20260922T135101Z", outcome: "sent" }]);
      expect(sent).toEqual([
        {
          targetId: MANAGER,
          kind: "BM-ANSWERED:req-20260922T135101Z",
          text: [
            "BM-ANSWERED requestId: req-20260922T135101Z",
            "The user answered Q16, Q17, Q19 directly to the Worker (in its card or chat); the Worker has them. Those questions are closed: do not ask them again and do not relay answers to them. Tell the user in one line which Worker has its answers and what is still open.",
            "Still open: Q18.",
          ].join("\n"),
        },
      ]);
      // The same turn end seen again (a reload, the next turn end) sends nothing more.
      await recordTurn(turn, notifyingDeps(managers, sent));
      expect(sent).toHaveLength(1);
    });

    it("says Still open: unknown when the ledger has no question of the request yet (review finding 2)", async () => {
      const sent: Sent[] = [];
      await recordTurn(workerTurn([fromApp(cardAnswer(["Q16: a — foundations first."]))]), notifyingDeps(managers, sent));
      expect(sent[0]?.text.split("\n").at(-1)).toBe("Still open: unknown.");
    });

    it("A3: goes through the real notice queue — held while the Manager runs, sent at its turn end (review finding 7)", async () => {
      const queue = createNoticeQueue({ log: () => {} });
      const status: Record<string, string> = { [MANAGER]: "running" };
      const sends: Array<{ id: string; text: string }> = [];
      const paseo = {
        ...paseoWith(managers),
        agents: {
          list: async () => ({ entries: managers }),
          ref: (id: string) => ({
            refresh: async () => ({ agent: { status: status[id] ?? "idle", archivedAt: null } }),
            send: async (text: string) => void sends.push({ id, text }),
          }),
        },
      };
      await recordTurn(managerTurn([fromAgent(REPORT_FOUR)]), deps());
      const outcome = await recordTurn(workerTurn([fromApp(cardAnswer(["Q16: a — foundations first."]))]), {
        ...deps(),
        paseo,
        notify: (target: string, kind: string, text: string, handle?: unknown) => queue.enqueue(target, kind, text, handle as never),
      });
      expect(outcome.notices?.[0]?.outcome).toBe("queued");
      expect(sends).toEqual([]);
      status[MANAGER] = "idle";
      await queue.turnEnded({ agent: { id: MANAGER } }, paseo);
      expect(sends.map((entry) => entry.id)).toEqual([MANAGER]);
      expect(sends[0]!.text.startsWith("BM-ANSWERED requestId: req-20260922T135101Z")).toBe(true);
    });

    it("A3: says nothing for an answer the Manager relayed itself", async () => {
      const sent: Sent[] = [];
      await recordTurn(workerTurn([fromAgent(relayed(["Q18: other — drop everything about files"]))]), notifyingDeps(managers, sent));
      expect(sent).toEqual([]);
    });

    it("A3: says nothing for an old answer outside the last turn, first recorded after an upgrade", async () => {
      const sent: Sent[] = [];
      const old = fromApp(cardAnswer(["Q16: a — foundations first."]));
      await recordTurn(workerTurn([old, { type: "assistant_message", text: "working" }, fromAgent("Reviewer b1 finished.")]), notifyingDeps(managers, sent));
      expect(sent).toEqual([]);
      expect(openQuestionIds(readQaLedger(location), "req-20260922T135101Z")).toEqual([]);
    });

    it("finds the one live Manager of the workspace when the parent is not a live Manager, and nobody when there are two", async () => {
      const sent: Sent[] = [];
      const orphan = [agent("m-live", "manager"), agent(WORKER, "worker")];
      await recordTurn(workerTurn([fromApp(cardAnswer(["Q16: a"]))]), notifyingDeps(orphan, sent));
      expect(sent.map((entry) => entry.targetId)).toEqual(["m-live"]);

      const log: string[] = [];
      const two = [agent("m-a", "manager"), agent("m-b", "manager"), agent("m-old", "manager", { archivedAt: "2026-09-20T00:00:00Z" })];
      await recordTurn(workerTurn([fromApp(cardAnswer(["Q17: a"]))]), notifyingDeps(two, sent, log));
      expect(sent).toHaveLength(1);
      expect(log.join("\n")).toContain("no single live Manager");
    });

    it("is one of the plugin's own notices, with one queue kind per request", () => {
      expect(isPluginNotice(answeredNotice(REQUEST, ["Q14"], []))).toBe(true);
      expect(answeredNotice(REQUEST, ["Q14"], [])).toMatch(/\nStill open: none\.$/);
      expect(answeredNoticeKind(REQUEST)).not.toBe(answeredNoticeKind("req-20260922T135101Z"));
    });
  });
});
