#!/usr/bin/env node
/**
 * Before/after numbers for the agents' way of working, read from a workspace's
 * trace store (design delta 20260924-worker-autonomy §2, PRD delta N5).
 *
 * Read-only: it opens the monthly `events-*.jsonl` files and prints numbers.
 *
 *   node scripts/measure-requests.mjs <workspace dir under ~/.paseo-bm/traces> [--since ISO] [--until ISO] [--json]
 *
 * Trace fields used: `sent` are the messages that reached the record's agent
 * (`origin: "user"` means it carried `clientMessageId`, i.e. came from the app),
 * `usage` is that turn's tokens, and `reports` are the parsed `BM-REPORT`s.
 * `inputTokens + cachedInputTokens` stands for the context the turn read.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REQUEST_ID = /requestId: (req-\d{8}T\d{6}Z)/;
const QUESTION_LINE = /^Q\d+:/;

const ctxOf = (record) => (record.usage?.inputTokens ?? 0) + (record.usage?.cachedInputTokens ?? 0);
const minutes = (from, to) => Math.max(0, (Date.parse(to) - Date.parse(from)) / 60000);
const round = (value, digits = 1) => Math.round(value * 10 ** digits) / 10 ** digits;

/** Every measured number for the records given (already filtered by time). Pure. */
export function measure(records) {
  const byRole = {};
  let contextTotal = 0;
  let workerWakeContext = 0;
  let workerBusyMinutes = 0;
  const requests = new Map();
  const asked = new Map(); // requestId|Qn -> recommended key or null
  const firstQuestionAt = new Map(); // requestId -> time an unanswered round opened
  let questionRounds = 0;
  let userWaitMinutes = 0;
  let answered = 0;
  let tookRecommendation = 0;

  const sorted = [...records].sort((a, b) => (a.at < b.at ? -1 : 1));
  for (const record of sorted) {
    const role = record.role ?? "unknown";
    const ctx = ctxOf(record);
    const bucket = (byRole[role] ??= { turns: 0, context: 0, output: 0 });
    bucket.turns += 1;
    bucket.context += ctx;
    bucket.output += record.usage?.outputTokens ?? 0;
    contextTotal += ctx;
    if (role === "worker") {
      if ((record.sent ?? []).length === 0) workerWakeContext += ctx;
      const busy = minutes(record.startedAt ?? record.at, record.endedAt ?? record.at);
      if (busy < 600) workerBusyMinutes += busy;
    }
    if (record.requestId) {
      const request = requests.get(record.requestId) ?? { tier: null, workerTurns: 0, reviewerTurns: 0, questions: new Set(), context: 0 };
      request.context += ctx;
      if (role === "worker") request.workerTurns += 1;
      if (role === "reviewer") request.reviewerTurns += 1;
      for (const report of record.reports ?? []) if (report.tier) request.tier = report.tier;
      requests.set(record.requestId, request);
    }
    for (const message of record.sent ?? []) {
      const requestId = REQUEST_ID.exec(message.text)?.[1];
      if (requestId === undefined) continue;
      const lines = message.text.split("\n");
      if (role === "manager" && message.origin === "agent" && /^BM-QUESTIONS/m.test(message.text)) {
        let current = null;
        for (const line of lines) {
          if (QUESTION_LINE.test(line)) {
            current = `${requestId}|${line.split(":")[0]}`;
            if (!asked.has(current)) asked.set(current, null);
            requests.get(requestId)?.questions.add(line.split(":")[0]);
            continue;
          }
          const option = /^- ([a-z]):.*\(recommended\)/i.exec(line);
          if (option && current !== null) asked.set(current, option[1]);
        }
        if (!firstQuestionAt.has(requestId)) firstQuestionAt.set(requestId, message.at);
      }
      if (role === "worker" && /^BM-ANSWERS/m.test(message.text)) {
        if (firstQuestionAt.has(requestId)) {
          questionRounds += 1;
          userWaitMinutes += minutes(firstQuestionAt.get(requestId), message.at);
          firstQuestionAt.delete(requestId);
        }
        for (const line of lines) {
          const answer = /^(Q\d+):\s*([a-z]|other)\b/.exec(line);
          if (answer === null) continue;
          const key = `${requestId}|${answer[1]}`;
          if (!asked.has(key)) continue;
          answered += 1;
          if (asked.get(key) === answer[2]) tookRecommendation += 1;
          asked.delete(key);
        }
      }
    }
  }

  const tiers = {};
  for (const request of requests.values()) {
    if (request.workerTurns === 0) continue;
    const tier = request.tier ?? "unknown";
    const entry = (tiers[tier] ??= { requests: 0, questions: 0, workerTurns: 0, reviewerTurns: 0, context: 0 });
    entry.requests += 1;
    entry.questions += request.questions.size;
    entry.workerTurns += request.workerTurns;
    entry.reviewerTurns += request.reviewerTurns;
    entry.context += request.context;
  }
  const perRequest = Object.fromEntries(
    Object.entries(tiers).map(([tier, entry]) => [
      tier,
      {
        requests: entry.requests,
        questions: round(entry.questions / entry.requests),
        workerTurns: round(entry.workerTurns / entry.requests),
        reviewerTurns: round(entry.reviewerTurns / entry.requests),
        contextMillions: round(entry.context / entry.requests / 1e6),
      },
    ]),
  );
  const share = (value) => (contextTotal === 0 ? 0 : round((100 * value) / contextTotal, 0));
  return {
    contextShareByRole: Object.fromEntries(Object.entries(byRole).map(([role, bucket]) => [role, share(bucket.context)])),
    workerWakeShareOfWorker: byRole.worker?.context ? round((100 * workerWakeContext) / byRole.worker.context, 0) : 0,
    questionRounds,
    userWaitHours: round(userWaitMinutes / 60),
    workerBusyHours: round(workerBusyMinutes / 60),
    answeredQuestions: answered,
    tookRecommendationPercent: answered === 0 ? 0 : round((100 * tookRecommendation) / answered, 0),
    perRequestByTier: perRequest,
  };
}

/** Every trace record of one workspace directory, inside [since, until]. */
export function readWorkspace(dir, since = "", until = "9999") {
  const out = [];
  for (const name of readdirSync(dir)) {
    if (!/^events-\d{6}\.jsonl$/.test(name)) continue;
    for (const line of readFileSync(join(dir, name), "utf8").split("\n")) {
      if (line.trim() === "") continue;
      const record = JSON.parse(line);
      if (record.at >= since && record.at <= until) out.push(record);
    }
  }
  return out;
}

function main(argv) {
  const dir = argv.find((arg) => !arg.startsWith("--") && !/^\d{4}-/.test(arg));
  const option = (name) => {
    const index = argv.indexOf(name);
    return index === -1 ? undefined : argv[index + 1];
  };
  if (dir === undefined) {
    console.error("usage: node scripts/measure-requests.mjs <trace workspace dir> [--since ISO] [--until ISO] [--json]");
    process.exit(2);
  }
  const result = measure(readWorkspace(dir, option("--since") ?? "", option("--until") ?? "9999"));
  if (argv.includes("--json")) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(`context share by role (%): ${JSON.stringify(result.contextShareByRole)}`);
  console.log(`worker turns woken without a message: ${result.workerWakeShareOfWorker}% of the worker's context`);
  console.log(`question rounds: ${result.questionRounds}; user wait ${result.userWaitHours} h vs worker busy ${result.workerBusyHours} h`);
  console.log(`answered questions: ${result.answeredQuestions}; took the recommendation: ${result.tookRecommendationPercent}%`);
  for (const [tier, entry] of Object.entries(result.perRequestByTier)) {
    console.log(`${tier.padEnd(8)} requests=${entry.requests} questions=${entry.questions} workerTurns=${entry.workerTurns} reviewerTurns=${entry.reviewerTurns} context=${entry.contextMillions}M`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
