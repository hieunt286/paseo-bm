import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { DECISION_CLASSES, HARD_OWNER_CLASSES } from "../plugin/shared/decisions";
import { checkAutonomySet } from "../plugin/shared/autonomy";
import type { OwnerLogEntry } from "../scripts/eval/owner";
import { legacyChatWaitingRpc } from "../scripts/eval/legacy-contracts";
import * as legacy from "../scripts/eval/legacy-contracts";
import { buildScorecard, writeScorecard, type Scorecard } from "../scripts/eval/score";
import {
  agentViewOf,
  applyRoleModelSwap,
  assertIsolatedDaemon,
  assertIsolatedHomes,
  assertPort,
  channelFor,
  compareFingerprints,
  decideLoop,
  DEFAULT_PORT,
  DEFAULT_RUNS,
  fingerprintOwner,
  findRepoRoot,
  installSource,
  openQuestionsFromWaiting,
  orchestratorCost,
  ownerHomes,
  ownerRoleModels,
  parseRoleModel,
  parseSuiteArgs,
  parseVersion,
  POLL_MS,
  rolesToSave,
  runAgents,
  scenarioPolicyCalls,
  SuiteGuardError,
  SuiteUsageError,
  toScoreOwnerLog,
  USAGE,
  versionLabel,
  type AgentView,
  type LoopDecision,
  type LoopPoll,
} from "../scripts/eval/suite";

const HOME = "/Users/owner";
const OWNER = ownerHomes(HOME);

describe("port guard", () => {
  it("refuses the owner's daemon port 6767", () => {
    expect(() => assertPort(6767)).toThrow(SuiteGuardError);
    expect(() => assertPort(6767)).toThrow(/owner's real daemon/);
    expect(() => parseSuiteArgs(["--version", "tree", "--port", "6767"])).toThrow(SuiteGuardError);
  });

  it("refuses a port outside 1024–65535 and accepts the default", () => {
    expect(() => assertPort(80)).toThrow(SuiteGuardError);
    expect(() => assertPort(70000)).toThrow(SuiteGuardError);
    expect(() => assertPort(DEFAULT_PORT)).not.toThrow();
  });
});

describe("home guard", () => {
  const isolated = (work: string) => ({ paseoHome: join(work, "paseo-home"), bmHome: join(work, "bm-home") });

  it("accepts homes under a separate run folder", () => {
    expect(() => assertIsolatedHomes(isolated("/tmp/suite-1"), OWNER)).not.toThrow();
    // The owner's HOME itself as the run folder is still isolated: <home>/paseo-home is not ~/.paseo.
    expect(() => assertIsolatedHomes(isolated(HOME), OWNER)).not.toThrow();
  });

  it("refuses a home equal to the owner's ~/.paseo or ~/.paseo-bm", () => {
    expect(() => assertIsolatedHomes({ paseoHome: OWNER.paseo, bmHome: "/tmp/x/bm-home" }, OWNER)).toThrow(SuiteGuardError);
    expect(() => assertIsolatedHomes({ paseoHome: "/tmp/x/paseo-home", bmHome: OWNER.bm }, OWNER)).toThrow(SuiteGuardError);
    expect(() => assertIsolatedHomes({ paseoHome: `${OWNER.paseo}/`, bmHome: "/tmp/x/bm-home" }, OWNER)).toThrow(SuiteGuardError);
  });

  it("refuses a home inside the owner's homes, or holding them", () => {
    expect(() => assertIsolatedHomes(isolated(join(OWNER.paseo, "suite")), OWNER)).toThrow(SuiteGuardError);
    expect(() => assertIsolatedHomes(isolated(join(OWNER.bm, "suite")), OWNER)).toThrow(SuiteGuardError);
    expect(() => assertIsolatedHomes({ paseoHome: HOME, bmHome: "/tmp/x/bm-home" }, OWNER)).toThrow(SuiteGuardError);
  });

  it("refuses relative homes and one home for both", () => {
    expect(() => assertIsolatedHomes({ paseoHome: "paseo-home", bmHome: "/tmp/x/bm-home" }, OWNER)).toThrow(SuiteGuardError);
    expect(() => assertIsolatedHomes({ paseoHome: "/tmp/x/h", bmHome: "/tmp/x/h" }, OWNER)).toThrow(SuiteGuardError);
  });

  it("stops only the daemon whose home and port are the run's", () => {
    const expected = { paseoHome: "/tmp/x/paseo-home", port: 6899 };
    expect(() => assertIsolatedDaemon({ home: "/tmp/x/paseo-home", listen: "127.0.0.1:6899" }, expected)).not.toThrow();
    expect(() => assertIsolatedDaemon({ home: OWNER.paseo, listen: "127.0.0.1:6899" }, expected)).toThrow(SuiteGuardError);
    expect(() => assertIsolatedDaemon({ home: "/tmp/x/paseo-home", listen: "127.0.0.1:6767" }, expected)).toThrow(/owner's port/);
    expect(() => assertIsolatedDaemon({ home: "/tmp/x/paseo-home", listen: "127.0.0.1:6900" }, expected)).toThrow(SuiteGuardError);
    expect(() => assertIsolatedDaemon({}, expected)).toThrow(SuiteGuardError);
  });
});

describe("--version", () => {
  it("parses tree and the npm spellings", () => {
    expect(parseVersion("tree")).toEqual({ kind: "tree" });
    expect(parseVersion("npm:paseo-bm-plugin@0.4.1")).toEqual({ kind: "npm", spec: "npm:paseo-bm-plugin@0.4.1" });
    expect(parseVersion("paseo-bm-plugin@0.4.1")).toEqual({ kind: "npm", spec: "npm:paseo-bm-plugin@0.4.1" });
    expect(parseVersion("0.4.1")).toEqual({ kind: "npm", spec: "npm:paseo-bm-plugin@0.4.1" });
    expect(parseVersion("0.5.0-alpha.1")).toEqual({ kind: "npm", spec: "npm:paseo-bm-plugin@0.5.0-alpha.1" });
    expect(parseVersion("npm:paseo-bm-plugin@next")).toEqual({ kind: "npm", spec: "npm:paseo-bm-plugin@next" });
    expect(parseVersion("@scope/pkg@1.0.0")).toEqual({ kind: "npm", spec: "npm:@scope/pkg@1.0.0" });
  });

  it("refuses a spec without a version, an empty value and shell-looking text", () => {
    for (const bad of ["", "paseo-bm-plugin", "npm:paseo-bm-plugin", "npm:paseo-bm-plugin@", "paseo-bm-plugin@1; rm -rf /", "Tree ", "../plugin"]) {
      expect(() => parseVersion(bad), bad).toThrow(SuiteUsageError);
    }
  });

  it("maps the version to the owner channel, the install source and the scorecard label", () => {
    const tree = parseVersion("tree");
    const npm = parseVersion("0.4.1");
    expect(channelFor(tree)).toBe("decision-rpc");
    expect(channelFor(npm)).toBe("0.4.1");
    expect(installSource(tree, "/repo")).toBe("/repo/plugin");
    expect(installSource(npm, "/repo")).toBe("npm:paseo-bm-plugin@0.4.1");
    expect(versionLabel(tree)).toBe("tree");
    expect(versionLabel(npm)).toBe("npm:paseo-bm-plugin@0.4.1");
  });
});

describe("the tree's scenario policy (owner decision E-2, evaluation design §11)", () => {
  /** RPCs no build the suite measures as the tree has any more (autonomy design §A.14, §B.8). */
  const RETIRED = ["orchestrator.set-autopilot", "chat.waiting", "orchestrator.state", "orchestrator.ask", "orchestrator.approve", "orchestrator.dismiss", "orchestrator.command", "answers.mark", "answers.marks"];

  it("delegates exactly the classes that may be delegated to the Orchestrator, confirmed, on the run's workspace", () => {
    const calls = scenarioPolicyCalls(parseVersion("tree"), "ws-run-1");
    const delegable = DECISION_CLASSES.filter((decisionClass) => !HARD_OWNER_CLASSES.includes(decisionClass));
    expect(delegable).toHaveLength(5);
    expect(calls.map((call) => call.method)).toEqual(delegable.map(() => "autonomy.set"));
    expect(calls.map((call) => call.input["class"])).toEqual(delegable);
    for (const call of calls) {
      expect(call.input).toEqual({ workspaceId: "ws-run-1", class: call.input["class"], mode: "delegate", confirmed: true, predictor: "orchestrator" });
      // The plugin's own check accepts each one as it is sent: never a hard-owner class, always confirmed.
      expect(checkAutonomySet(call.input)).toEqual({ change: call.input });
    }
    for (const hardOwner of HARD_OWNER_CLASSES) expect(calls.some((call) => call.input["class"] === hardOwner), hardOwner).toBe(false);
  });

  it("the tree calls no retired RPC; the 0.4.1 run sets nothing and keeps its chat.waiting", () => {
    expect(scenarioPolicyCalls(parseVersion("tree"), "ws-run-1").some((call) => RETIRED.includes(call.method))).toBe(false);
    expect(channelFor(parseVersion("tree"))).toBe("decision-rpc");
    expect(scenarioPolicyCalls(parseVersion("0.4.1"), "ws-run-1")).toEqual([]);
    expect(channelFor(parseVersion("0.4.1"))).toBe("0.4.1");
    // legacy-contracts.ts keeps only what 0.4.1 needs.
    expect(legacyChatWaitingRpc.name).toBe("chat.waiting");
    expect(Object.keys(legacy).sort()).toEqual(["legacyChatWaitingRpc", "legacyWaitingWorkerSchema"]);
  });
});

describe("command line", () => {
  it("has the defaults of the bead", () => {
    expect(parseSuiteArgs(["--version", "tree"])).toEqual({ version: { kind: "tree" }, only: null, work: null, runs: DEFAULT_RUNS, port: DEFAULT_PORT, roleModel: null });
    expect(DEFAULT_RUNS).toBe(2);
    expect(DEFAULT_PORT).toBe(6899);
  });

  it("reads --only, --work, --runs and --port", () => {
    expect(parseSuiteArgs(["--version", "0.4.1", "--only", "s2, S7,S2", "--work", "/tmp/w", "--runs", "1", "--port", "6900"])).toEqual({
      version: { kind: "npm", spec: "npm:paseo-bm-plugin@0.4.1" },
      only: ["S2", "S7"],
      work: "/tmp/w",
      runs: 1,
      port: 6900,
      roleModel: null,
    });
  });

  it("refuses a missing --version, bad values and unknown flags; --help is null", () => {
    expect(parseSuiteArgs(["--help"])).toBeNull();
    expect(() => parseSuiteArgs([])).toThrow(/--version is required/);
    expect(() => parseSuiteArgs(["--version"])).toThrow(SuiteUsageError);
    expect(() => parseSuiteArgs(["--version", "tree", "--only", "X1"])).toThrow(SuiteUsageError);
    expect(() => parseSuiteArgs(["--version", "tree", "--runs", "0"])).toThrow(SuiteUsageError);
    expect(() => parseSuiteArgs(["--version", "tree", "--runs", "two"])).toThrow(SuiteUsageError);
    expect(() => parseSuiteArgs(["--version", "tree", "--work", "--runs"])).toThrow(SuiteUsageError);
    expect(() => parseSuiteArgs(["--version", "tree", "--verbose"])).toThrow(/unknown argument/);
  });
});

describe("the idle / timeout loop", () => {
  const T0 = Date.parse("2026-09-29T10:00:00.000Z");
  const quiet: LoopPoll = { busy: false, pending: 0, owner: "idle" };

  /** Drives decideLoop over a sequence of polls on a fake clock, POLL_MS apart. */
  function drive(polls: LoopPoll[], deadline: number): { decision: LoopDecision; polls: number } {
    let quietPolls = 0;
    let now = T0;
    for (let index = 0; index < polls.length; index += 1) {
      now += POLL_MS;
      const decision = decideLoop(quietPolls, polls[index]!, now, deadline);
      if (decision.kind !== "continue") return { decision, polls: index + 1 };
      quietPolls = decision.quietPolls;
    }
    return { decision: { kind: "continue", quietPolls }, polls: polls.length };
  }

  it("is idle after two quiet polls in a row", () => {
    const busy: LoopPoll = { busy: true, pending: 0, owner: "idle" };
    expect(drive([busy, busy, quiet, quiet, busy], T0 + 60 * 60_000)).toEqual({ decision: { kind: "idle" }, polls: 4 });
  });

  it("restarts the quiet count on a busy agent, something pending or an owner answer", () => {
    const polls: LoopPoll[] = [quiet, { busy: false, pending: 1, owner: "idle" }, quiet, { busy: false, pending: 0, owner: "acted" }, quiet, quiet];
    expect(drive(polls, T0 + 60 * 60_000)).toEqual({ decision: { kind: "idle" }, polls: 6 });
    expect(decideLoop(1, { busy: true, pending: 0, owner: "idle" }, T0, T0 + 1)).toEqual({ kind: "continue", quietPolls: 0 });
  });

  it("times out at the deadline while work goes on, but idle wins on the same poll", () => {
    const busy: LoopPoll = { busy: true, pending: 0, owner: "idle" };
    const deadline = T0 + 3 * POLL_MS;
    expect(drive([busy, busy, busy, busy], deadline)).toEqual({ decision: { kind: "timeout" }, polls: 3 });
    expect(drive([busy, quiet, quiet], deadline)).toEqual({ decision: { kind: "idle" }, polls: 3 });
  });

  it("stops for a human at once, even when idle", () => {
    expect(decideLoop(1, { busy: false, pending: 0, owner: "needed-a-human" }, T0, T0 + 60_000)).toEqual({ kind: "needed-a-human" });
  });
});

describe("observation", () => {
  const agent = (over: Partial<AgentView>): AgentView => ({
    id: "a1",
    title: null,
    provider: "bm-worker",
    status: "idle",
    workspaceId: "ws1",
    cwd: null,
    archived: false,
    pendingPermissions: [],
    totalCostUsd: null,
    ...over,
  });

  it("reads an agent snapshot and its running cost", () => {
    const view = agentViewOf({
      agent: { id: "o1", provider: "bm-orchestrator", status: "running", title: "Beads Orchestrator", workspaceId: "own", lastUsage: { totalCostUsd: 0.42 }, pendingPermissions: [{ name: "Bash" }] },
    });
    expect(view).toMatchObject({ id: "o1", status: "running", totalCostUsd: 0.42, archived: false });
    expect(view?.pendingPermissions).toHaveLength(1);
    expect(agentViewOf({ nope: true })).toBeNull();
  });

  it("watches the run's workspace and every Orchestrator, not other runs", () => {
    const agents = [
      agent({ id: "m1", provider: "bm-manager", workspaceId: "ws1" }),
      agent({ id: "w1", workspaceId: null, cwd: "/runs/s1-r1/s1" }),
      agent({ id: "m0", provider: "bm-manager", workspaceId: "ws0", cwd: "/runs/s1-r0/s1" }),
      agent({ id: "o1", provider: "bm-orchestrator/claude-opus-5-5", workspaceId: "own" }),
      agent({ id: "x", workspaceId: "ws1", archived: true }),
    ];
    expect(runAgents(agents, { workspaceId: "ws1", repo: "/runs/s1-r1/s1" }).map((a) => a.id)).toEqual(["m1", "w1", "o1"]);
  });

  it("sums every Orchestrator's session cost, archived ones included", () => {
    const agents = [
      agent({ provider: "bm-orchestrator", totalCostUsd: 1.5, archived: true }),
      agent({ provider: "bm-orchestrator", totalCostUsd: 0.25 }),
      agent({ provider: "bm-orchestrator", totalCostUsd: null }),
      agent({ provider: "bm-worker", totalCostUsd: 9 }),
    ];
    expect(orchestratorCost(agents)).toBe(1.75);
  });

  it("turns chat.waiting into the run's open questions, minus answered ones, first seen once", () => {
    const text = [
      "BM-REPORT",
      "requestId: req-20260929T100000Z",
      "phase: blocked",
      "",
      "BM-QUESTIONS",
      "requestId: req-20260929T100000Z",
      "Q1: Default value?",
      "- a: zero (recommended)",
      "- b: undefined",
      "Q2: Also subtract?",
      "- a: no (recommended)",
      "- b: yes",
    ].join("\n");
    const waiting = [
      { workspaceId: "ws1", workerId: "w1", requestId: "req-20260929T100000Z", text, answered: ["Q2"] },
      { workspaceId: "ws0", workerId: "w0", requestId: "req-20260929T090000Z", text, answered: [] },
    ];
    const firstSeen = new Map<string, number>();
    const first = openQuestionsFromWaiting(waiting, "ws1", firstSeen, 1000);
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ workerId: "w1", requestId: "req-20260929T100000Z", firstSeenAt: 1000 });
    expect(first[0]!.questions.map((q) => q.id)).toEqual(["Q1"]);
    expect(openQuestionsFromWaiting(waiting, "ws1", firstSeen, 5000)[0]!.firstSeenAt).toBe(1000);
    expect(openQuestionsFromWaiting([{ ...waiting[0]!, answered: ["Q1", "Q2"] }], "ws1", new Map(), 0)).toEqual([]);
  });
});

describe("owner models and log", () => {
  const config = {
    daemon: {
      agentProfiles: [
        { id: "bm-manager", provider: "bm-manager", model: "claude-opus-5-5" },
        { id: "bm-worker", provider: "bm-worker", model: "claude-opus-5-5" },
        { id: "bm-reviewer", provider: "bm-reviewer", model: "gpt-5.6-sol", modeId: "auto-review", thinkingOptionId: "high" },
        { id: "bm-orchestrator", provider: "bm-orchestrator", model: "claude-opus-5-5" },
        { id: "other", provider: "claude", model: "x" },
      ],
    },
    agents: {
      providers: {
        "bm-manager": { extends: "claude" },
        "bm-worker": { extends: "claude" },
        "bm-reviewer": { extends: "codex" },
        "bm-orchestrator": { extends: "claude" },
      },
    },
  };

  it("reads each role's base provider, model, thinking and mode", () => {
    const models = ownerRoleModels(config);
    expect(models.reviewer).toEqual({ baseProvider: "codex", model: "gpt-5.6-sol", thinkingOptionId: "high", modeId: "auto-review" });
    expect(models.manager).toEqual({ baseProvider: "claude", model: "claude-opus-5-5", thinkingOptionId: null, modeId: null });
    expect(Object.keys(models).sort()).toEqual(["manager", "orchestrator", "reviewer", "worker"]);
  });

  it("saves the Orchestrator only for the tree, and needs a model for every role saved", () => {
    const models = ownerRoleModels(config);
    expect(rolesToSave(["manager", "worker", "reviewer"], parseVersion("0.4.1"), models)).toEqual(["manager", "worker", "reviewer"]);
    expect(rolesToSave(["manager", "worker", "reviewer"], parseVersion("tree"), models)).toEqual(["manager", "worker", "reviewer", "orchestrator"]);
    const withoutOrchestrator = { ...models };
    delete withoutOrchestrator.orchestrator;
    expect(() => rolesToSave(["manager"], parseVersion("tree"), withoutOrchestrator)).toThrow(/bm-orchestrator/);
  });

  it("maps each delivered answer item to one scorer entry", () => {
    const base = { workspaceId: null, requestId: "req-1", text: "…", actions: 1 };
    const log: OwnerLogEntry[] = [
      {
        ...base,
        channel: "0.4.1",
        at: "2026-09-29T10:01:00.000Z",
        source: "worker-questions",
        target: { agentId: "w1" },
        error: null,
        items: [
          { id: "Q1", question: "Push to origin?", answer: "a — yes, push", rule: "override", keyword: "push", note: null },
          { id: "Q2", question: "Name?", answer: "b — sum", rule: "recommended", keyword: null, note: null },
        ],
      },
      {
        ...base,
        channel: "decision-rpc",
        at: "2026-09-29T10:02:00.000Z",
        source: "decision",
        target: { rpc: "decisions.answer" },
        error: "boom",
        items: [{ id: "d1", question: "Lost?", answer: "x", rule: "recommended", keyword: null, note: null }],
      },
    ];
    expect(toScoreOwnerLog(log)).toEqual([
      { at: "2026-09-29T10:01:00.000Z", channel: "0.4.1", text: "a — yes, push", target: "Push to origin?" },
      { at: "2026-09-29T10:01:00.000Z", channel: "0.4.1", text: "b — sum", target: "Name?" },
    ]);
  });
});

describe("owner fingerprint", () => {
  let dir: string | null = null;
  afterEach(() => {
    if (dir !== null) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  it("changes when the owner's config or data folder changes, and reads nothing else", () => {
    dir = mkdtempSync(join(tmpdir(), "bm-suite-guard-"));
    const homes = { paseo: join(dir, ".paseo"), bm: join(dir, ".paseo-bm") };
    mkdirSync(homes.paseo);
    mkdirSync(join(homes.bm, "traces"), { recursive: true });
    writeFileSync(join(homes.paseo, "config.json"), "{}");
    writeFileSync(join(homes.bm, "traces", "a.jsonl"), "x\n");
    const before = fingerprintOwner(homes);
    expect(before.configSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(before.bmEntries).toBe(2);
    expect(compareFingerprints(before, fingerprintOwner(homes))).toEqual({ identical: true, sameContentShape: true, changed: [] });

    utimesSync(join(homes.bm, "traces", "a.jsonl"), new Date(0), new Date(0));
    const touched = compareFingerprints(before, fingerprintOwner(homes));
    expect(touched.identical).toBe(false);
    expect(touched.sameContentShape).toBe(true);
    expect(touched.changed).toHaveLength(2);

    writeFileSync(join(homes.bm, "traces", "b.jsonl"), "y\n");
    expect(compareFingerprints(before, fingerprintOwner(homes)).sameContentShape).toBe(false);

    writeFileSync(join(homes.paseo, "config.json"), '{"a":1}');
    expect(fingerprintOwner(homes).configSha256).not.toBe(before.configSha256);
  });
});

describe("checkout", () => {
  it("finds the repository root from this test", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    expect(findRepoRoot(here)).toBe(join(here, ".."));
  });
});

describe("--role-model: the model-choice experiment (autonomy design §F.2, REQ-162; bead i8fc.3)", () => {
  const owner = ownerRoleModels({
    daemon: {
      agentProfiles: [
        { id: "bm-manager", provider: "bm-manager", model: "claude-opus-5-5" },
        { id: "bm-worker", provider: "bm-worker", model: "claude-opus-5-5", modeId: "bypassPermissions", thinkingOptionId: "high" },
        { id: "bm-reviewer", provider: "bm-reviewer", model: "gpt-5.6-sol", modeId: "auto-review", thinkingOptionId: "high" },
        { id: "bm-orchestrator", provider: "bm-orchestrator", model: "claude-opus-5-5" },
      ],
    },
    agents: { providers: { "bm-manager": { extends: "claude" }, "bm-worker": { extends: "claude" }, "bm-reviewer": { extends: "codex" }, "bm-orchestrator": { extends: "claude" } } },
  });

  it("parses <role>=<baseProvider>/<model>, the model keeping any further slash", () => {
    expect(parseRoleModel("worker=claude/claude-sonnet-5")).toEqual({ role: "worker", baseProvider: "claude", model: "claude-sonnet-5" });
    expect(parseRoleModel(" Reviewer=claude/claude-opus-5-5[1m] ")).toEqual({ role: "reviewer", baseProvider: "claude", model: "claude-opus-5-5[1m]" });
    expect(parseRoleModel("manager=opencode/anthropic/claude-haiku-5")).toEqual({ role: "manager", baseProvider: "opencode", model: "anthropic/claude-haiku-5" });
    expect(parseSuiteArgs(["--version", "tree", "--role-model", "orchestrator=codex/gpt-5.6-sol"])).toMatchObject({
      version: { kind: "tree" },
      roleModel: { role: "orchestrator", baseProvider: "codex", model: "gpt-5.6-sol" },
    });
    expect(USAGE).toContain("--role-model <role>=<baseProvider>/<model>");
  });

  it("refuses an unknown role", () => {
    for (const bad of ["scout=claude/claude-sonnet-5", "workers=claude/x", "=claude/x"]) expect(() => parseRoleModel(bad), bad).toThrow(SuiteUsageError);
    expect(() => parseRoleModel("scout=claude/claude-sonnet-5")).toThrow(/unknown role "scout"/);
  });

  it("refuses a malformed value", () => {
    for (const bad of ["", "worker", "worker=", "worker=claude", "worker=claude/", "worker=/claude-sonnet-5", "worker=bm-worker/claude-sonnet-5", "worker=Claude Code/x", "worker=claude/claude sonnet", "worker=claude/x;rm -rf /", "worker=claude/$(id)", `worker=claude/${"m".repeat(201)}`]) {
      expect(() => parseRoleModel(bad), bad).toThrow(SuiteUsageError);
    }
    expect(() => parseRoleModel("worker=bm-worker/x")).toThrow(/role alias/);
    expect(() => parseSuiteArgs(["--version", "tree", "--role-model"])).toThrow(SuiteUsageError);
  });

  it("swaps one role only: a second --role-model is refused, even for the same role", () => {
    expect(() => parseSuiteArgs(["--version", "tree", "--role-model", "worker=claude/claude-sonnet-5", "--role-model", "reviewer=claude/claude-opus-5-5"])).toThrow(/given once/);
    expect(() => parseSuiteArgs(["--version", "tree", "--role-model", "worker=claude/a", "--role-model", "worker=claude/a"])).toThrow(SuiteUsageError);
  });

  it("refuses the Orchestrator on a published build, which has none", () => {
    expect(() => parseSuiteArgs(["--version", "0.4.1", "--role-model", "orchestrator=claude/claude-sonnet-5"])).toThrow(/needs --version tree/);
    expect(parseSuiteArgs(["--version", "0.4.1", "--role-model", "reviewer=claude/claude-opus-5-5"])?.roleModel).toEqual({ role: "reviewer", baseProvider: "claude", model: "claude-opus-5-5" });
  });

  it("changes only the swapped role; the owner's thinking and mode kept on their provider, the defaults on another", () => {
    const sameProvider = applyRoleModelSwap(owner, parseRoleModel("worker=claude/claude-sonnet-5"));
    expect(sameProvider.models.worker).toEqual({ baseProvider: "claude", model: "claude-sonnet-5", thinkingOptionId: "high", modeId: "bypassPermissions" });
    for (const role of ["manager", "reviewer", "orchestrator"] as const) expect(sameProvider.models[role]).toEqual(owner[role]);
    expect(sameProvider.record).toEqual({ role: "worker", owner: owner.worker, swapped: sameProvider.models.worker });

    // Any family may take any role (autonomy design §C.6 is a default of setup, not a refusal).
    const otherProvider = applyRoleModelSwap(owner, parseRoleModel("reviewer=claude/claude-opus-5-5"));
    expect(otherProvider.models.reviewer).toEqual({ baseProvider: "claude", model: "claude-opus-5-5", thinkingOptionId: null, modeId: null });
    for (const role of ["manager", "worker", "orchestrator"] as const) expect(otherProvider.models[role]).toEqual(owner[role]);
    // The owner's models are not changed in place.
    expect(owner.reviewer?.baseProvider).toBe("codex");

    // A role without an owner model gets one; the record says there was none.
    const withoutOrchestrator = { ...owner };
    delete withoutOrchestrator.orchestrator;
    expect(applyRoleModelSwap(withoutOrchestrator, parseRoleModel("orchestrator=claude/claude-sonnet-5")).record).toMatchObject({ role: "orchestrator", owner: null });
  });

  it("refuses a swap to the owner's own model: it would be no experiment", () => {
    expect(() => applyRoleModelSwap(owner, parseRoleModel("worker=claude/claude-opus-5-5"))).toThrow(/already the owner's model/);
  });

  it("records the swap in scorecard.json, and null without one", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bm-suite-card-"));
    try {
      const { record } = applyRoleModelSwap(owner, parseRoleModel("worker=claude/claude-sonnet-5"));
      const path = await writeScorecard(dir, buildScorecard({ pluginVersion: "tree", scenarios: [], generatedAt: "2026-10-01T00:00:00.000Z", roleModelSwap: record }));
      const card = JSON.parse(readFileSync(path, "utf8")) as Scorecard;
      expect(card.roleModelSwap).toEqual({
        role: "worker",
        owner: { baseProvider: "claude", model: "claude-opus-5-5", thinkingOptionId: "high", modeId: "bypassPermissions" },
        swapped: { baseProvider: "claude", model: "claude-sonnet-5", thinkingOptionId: "high", modeId: "bypassPermissions" },
      });
      expect(buildScorecard({ pluginVersion: "tree", scenarios: [] }).roleModelSwap).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
