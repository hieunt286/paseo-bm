import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { workerHandover } from "../plugin/server/fallback-handover";
import { handleDecisionsList } from "../plugin/server/decision-rpc";
import { handleInboxAlerts } from "../plugin/server/inbox-rpc";
import { handleOrchestratorState, type OrchestratorStatePaseo } from "../plugin/server/orchestrator-state";
import { createOrchestratorStore, dangerOpenKey } from "../plugin/server/orchestrator-store";
import { cleanupPaseoBm } from "../plugin/server/setup-machine";
import { markCleanedUpThisRun } from "../plugin/server/setup-roles";
import { clearTraceStoreCache } from "../plugin/server/trace-store";
import type { FallbackIncident } from "../plugin/shared/contracts";
import { fakePaseo } from "./helpers/fake-paseo";

/**
 * The data files Phase 1 retired (autonomy design §A.14, PRD §11 rule 2): the
 * question–answer ledger (`ui/qa-ledger.json`), the answer marks
 * (`ui/answer-marks.json`), the proposal era's entries of
 * `orchestrator/proposals.json`, the stall, event and signal keys of
 * `orchestrator/stalls.json` and the Watch field of `orchestrator/settings.json`;
 * and the files Phase 2 retired: with Autopilot and Allow… (§B.8) the whole
 * `orchestrator/settings.json`; with the additional instructions (§B.8,
 * §B.9) `role-extras.json` and the workflow assessments of
 * `orchestrator/assessments/`. A data folder an earlier build left with all
 * of them in it must start and read as if they were not there, and the
 * cleanup button must remove each one.
 * A temporary data folder, never the real HOME.
 */

const WS = "wks_1";
const REQ = "req-20260928T100000Z";
const T = "2026-09-28T10:00:00.000Z";

let root: string;
let home: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "bm-retired-data-"));
  home = join(root, ".paseo-bm");
  markCleanedUpThisRun(false);
  clearTraceStoreCache();
});

afterEach(() => {
  markCleanedUpThisRun(false);
  rmSync(root, { recursive: true, force: true });
});

const deps = () => ({ env: { PASEO_BM_HOME: home }, homedir: () => root, now: () => new Date("2026-09-29T12:00:00.000Z"), log: () => undefined });

const write = (relative: string, value: unknown): void => {
  const path = join(home, relative);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value));
};

/** A command entry of `proposals.json` in the shape its builds wrote. */
const entry = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  at: T,
  kind: "command",
  workspaceId: WS,
  managerId: "agent-manager",
  requestId: REQ,
  situation: "waiting for the answer to Q1",
  command: "Q1: use dd/mm/yyyy.",
  reason: "The Worker asked which format.",
  source: "autopilot",
  status: "sent",
  settledAt: T,
  sentText: "Q1: use dd/mm/yyyy.",
  outcome: "sent",
  error: null,
  ...overrides,
});

/** Every retired file, with what an earlier build wrote into it, beside one live entry of each file that stays. */
function earlierBuildsDataFolder(): void {
  write(join("ui", "qa-ledger.json"), {
    version: 1,
    requests: [
      {
        requestId: REQ,
        workspaceId: WS,
        updatedAt: T,
        questions: [{ id: "Q1", text: "Which date format?", at: T }],
        answers: [{ id: "Q1", text: "a — dd/mm/yyyy", via: "user", workerId: "agent-worker", at: T }],
      },
    ],
  });
  write(join("ui", "answer-marks.json"), { version: 1, keys: [`agent-manager|${REQ}|Q1`] });
  write(join("orchestrator", "proposals.json"), {
    version: 1,
    entries: [
      // The proposal era: waiting for the tab's Send, dismissed, failed, approved or typed there, and an old decision.
      entry("pending", { source: "orchestrator", status: "pending", settledAt: null, sentText: null, outcome: null }),
      entry("dismissed", { source: "orchestrator", status: "dismissed", sentText: null, outcome: null, error: "replaced" }),
      entry("failed", { source: "orchestrator", status: "failed", sentText: null, outcome: null, error: "The Manager was archived or is gone." }),
      entry("approved", { source: "orchestrator" }),
      entry("typed", { source: "user", requestId: null }),
      entry("decision", { kind: "decision", managerId: null, command: "Drop the legacy table?", status: "pending", settledAt: null, sentText: null, outcome: null }),
      // What stays: a command the Orchestrator sent itself.
      entry("kept"),
    ],
  });
  const stall = { raisedAt: T, lastSeenAt: T, clearedAt: null, woke: true };
  write(join("orchestrator", "stalls.json"), {
    version: 1,
    entries: {
      [`${WS}::req:${REQ}::idle-unfinished`]: stall,
      [`${WS}::req:${REQ}::question@${T}`]: stall,
      [`${WS}::autopilot::autopilot-on@${T}`]: stall,
      [`${WS}::agent-worker::stuck@${T}`]: stall,
      [dangerOpenKey(WS, "agent-worker", T)]: stall,
    },
  });
  write(join("orchestrator", "settings.json"), { version: 3, watch: { enabled: true }, autopilot: { [WS]: { enabled: true, since: T, by: "tab", allow: ["release"] } } });
  write("role-extras.json", { version: 1, roles: { manager: "", worker: "RETIRED-EXTRA: always create beads.", reviewer: "", orchestrator: "" } });
  write(
    join("orchestrator", "assessments", `${WS}.jsonl`),
    `${JSON.stringify({ v: 1, assessmentId: "as-1", requestId: null, traceId: "workspace", agentId: null, at: T, status: "done", provider: "bm-orchestrator", model: null, result: { rubric: [], findings: [], suggestions: [{ role: "worker", text: "RETIRED-SUGGESTION", why: "x" }] }, scope: { requestIds: [REQ] } })}\n`,
  );
}

/** The shared fake SDK with no agent and no workspace: the reads the start-up paths make. */
const emptyPaseo = () => fakePaseo().paseo;

describe("a data folder that still holds the retired files", () => {
  it("starts and reads as if they were not there", async () => {
    earlierBuildsDataFolder();
    const store = createOrchestratorStore(home);

    // settings.json: nothing reads it (the store has no Autopilot or Allow… left, retired-names.test.ts).
    // proposals.json: only the command the Orchestrator sent itself.
    expect(store.listCommands().map((command) => command.id)).toEqual(["kept"]);
    // stalls.json: only the interrupt allowance.
    expect(store.listDangerAllowances().map((allowance) => allowance.key)).toEqual([dangerOpenKey(WS, "agent-worker", T)]);

    // The RPCs the surface calls first answer without a trace of them.
    await expect(handleOrchestratorState(emptyPaseo() as unknown as OrchestratorStatePaseo, deps())).resolves.toEqual({
      agent: null,
      previousCount: 0,
      toolsStale: false,
      outdated: false,
      projects: [],
    });
    expect(handleDecisionsList({ scope: "inbox" }, deps())).toEqual({ decisions: [], truncated: false });
    expect(handleInboxAlerts({}, deps())).toEqual({ alerts: [], truncated: false });

    // A replacement Worker's questions come from the decision store: the ledger is not read.
    const incident = { id: "fb-00000000000a", role: "worker", workspaceId: WS, requestId: REQ, agentId: "agent-worker", managerId: "agent-manager" } as FallbackIncident;
    const handover = await workerHandover({ ...incident, class: "L1", message: "limit" } as FallbackIncident, {
      paseo: emptyPaseo(),
      location: { tracesDir: join(home, "traces") },
      incidents: [],
    });
    expect(handover).toContain("\nquestions: none\n");
    expect(handover).not.toContain("dd/mm/yyyy");

    // role-extras.json and the assessments: nothing reads them (the store has no assessment left, retired-names.test.ts).

    // Nothing was repaired or deleted by reading.
    for (const file of [
      join("ui", "qa-ledger.json"),
      join("ui", "answer-marks.json"),
      join("orchestrator", "settings.json"),
      "role-extras.json",
      join("orchestrator", "assessments", `${WS}.jsonl`),
    ]) {
      expect(existsSync(join(home, file)), file).toBe(true);
    }
  });

  it("drops what it ignores at the next write of each Orchestrator file", () => {
    earlierBuildsDataFolder();
    const store = createOrchestratorStore(home);
    const settings = readFileSync(join(home, "orchestrator", "settings.json"), "utf8");
    store.openDangerAllowance(WS, "agent-worker-2");
    store.appendCommand({
      workspaceId: WS,
      managerId: "agent-manager",
      requestId: REQ,
      situation: "go on",
      command: "Go on.",
      reason: "",
      sentText: "Go on.",
      outcome: "sent",
    });
    const read = (name: string) => JSON.parse(readFileSync(join(home, "orchestrator", name), "utf8")) as Record<string, unknown>;
    // settings.json is never written again: left as the earlier build wrote it, until the cleanup deletes it.
    expect(readFileSync(join(home, "orchestrator", "settings.json"), "utf8")).toBe(settings);
    expect((read("proposals.json")["entries"] as Array<{ id: string }>).map((kept) => kept.id)).toEqual(["kept", expect.any(String)]);
    expect(Object.keys(read("stalls.json")["entries"] as object).every((key) => key.includes("::danger-open@"))).toBe(true);
  });
});

describe("the cleanup button", () => {
  it("removes each retired file with the rest of paseo-bm's data", async () => {
    earlierBuildsDataFolder();
    const { paseo } = fakePaseo({ config: { providers: {}, agentProfiles: [], mcp: { injectIntoAgents: false } } });

    const result = await cleanupPaseoBm(paseo, { deleteData: true }, { env: { PASEO_BM_HOME: home }, homedir: () => root });

    for (const retired of [
      join("ui", "qa-ledger.json"),
      join("ui", "answer-marks.json"),
      join("orchestrator", "proposals.json"),
      join("orchestrator", "stalls.json"),
      join("orchestrator", "settings.json"),
      "role-extras.json",
      join("orchestrator", "assessments", `${WS}.jsonl`),
    ]) {
      expect(existsSync(join(home, retired)), retired).toBe(false);
    }
    expect(result.data?.deleted).toEqual(
      expect.arrayContaining(["orchestrator", "role-extras.json", join("ui", "qa-ledger.json"), join("ui", "answer-marks.json")]),
    );
    expect(result.data?.kept.join("\n")).not.toMatch(/qa-ledger|answer-marks|orchestrator|role-extras/);
  });
});
