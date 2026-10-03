import { describe, expect, it } from "vitest";
import { CLI_TIMEOUT_MS, cancelAgent, isFullAgentId, isSafeAgentId, setAgentLabel, setAgentMode, type PaseoCliDeps } from "../plugin/server/paseo-cli";
import { managerEnsureRpc } from "../plugin/shared/contracts";

/**
 * The two `paseo` CLI commands of delta 20260918 §4.1, against a fake runner.
 * Nothing here starts the real `paseo` binary or reaches a daemon.
 */
function fake(outcome = { code: 0, output: "{}", timedOut: false }) {
  const runs: Array<{ file: string; args: string[]; timeoutMs: number }> = [];
  const deps: PaseoCliDeps = {
    find: () => "/opt/fake/paseo",
    run: async (file, args, timeoutMs) => {
      runs.push({ file, args, timeoutMs });
      return outcome;
    },
  };
  return { deps, runs };
}

describe("paseo CLI commands", () => {
  it("builds exactly the documented commands, with the 5 s budget", async () => {
    const { deps, runs } = fake();

    expect(await setAgentMode("0a1b-2c", "bypassPermissions", deps)).toEqual({ ok: true });
    expect(await setAgentLabel("0a1b-2c", "bm.modeSet", "bypassPermissions", deps)).toEqual({ ok: true });

    expect(runs).toEqual([
      { file: "/opt/fake/paseo", args: ["agent", "mode", "0a1b-2c", "bypassPermissions", "--json"], timeoutMs: CLI_TIMEOUT_MS },
      {
        file: "/opt/fake/paseo",
        args: ["agent", "update", "0a1b-2c", "--label", "bm.modeSet=bypassPermissions", "--json"],
        timeoutMs: CLI_TIMEOUT_MS,
      },
    ]);
  });

  it.each([
    ["an id that is a flag", () => setAgentMode("--help", "auto", fake().deps)],
    ["an id with a space", () => setAgentMode("a b", "auto", fake().deps)],
    ["a mode that is a flag", () => setAgentMode("abc", "--dangerously", fake().deps)],
    ["a mode with a shell character", () => setAgentMode("abc", "auto;rm", fake().deps)],
    ["a label value with `=`", () => setAgentLabel("abc", "bm.modeSet", "a=b", fake().deps)],
    ["a label key that is a flag", () => setAgentLabel("abc", "--label", "x", fake().deps)],
  ])("refuses %s before anything runs", async (_label, call) => {
    const result = await call();

    expect(result.ok).toBe(false);
  });

  it("refused arguments never reach the runner", async () => {
    const { deps, runs } = fake();

    await setAgentMode("-x", "auto", deps);
    await setAgentLabel("abc", "k", "-v", deps);

    expect(runs).toEqual([]);
  });

  it("a runner that throws becomes a reason, not an exception", async () => {
    const deps: PaseoCliDeps = {
      find: () => "/opt/fake/paseo",
      run: async () => {
        throw new Error("spawn EACCES");
      },
    };

    expect(await setAgentMode("abc", "auto", deps)).toEqual({ ok: false, reason: "spawn EACCES" });
  });

  it("agent ids as Paseo mints them are accepted", () => {
    expect(isSafeAgentId("29e658b5-55eb-42b3-b0b4-aeed22eca3b7")).toBe(true);
    expect(isSafeAgentId("-29e658b5")).toBe(false);
    expect(isSafeAgentId("")).toBe(false);
  });
});

/**
 * The plugin's cancel (spike S5, bead bm-agent-tools-1upv.16): `paseo agent
 * stop <id> --json`. The command also takes an id prefix, `--all` and `--cwd`,
 * so only a whole agent id may reach it.
 */
describe("cancelAgent", () => {
  const ID = "5ea413fa-1b2c-4d5e-8f90-a1b2c3d4e5f6";

  it("runs exactly `paseo agent stop <id> --json`, with the 5 s budget, and reads whether it stopped a turn", async () => {
    const { deps, runs } = fake({ code: 0, output: `{"stoppedCount":1,"agentIds":["${ID}"]}`, timedOut: false });

    expect(await cancelAgent(ID, deps)).toEqual({ ok: true, stopped: true });
    expect(runs).toEqual([{ file: "/opt/fake/paseo", args: ["agent", "stop", ID, "--json"], timeoutMs: CLI_TIMEOUT_MS }]);
  });

  it("an idle agent is a no-op: ok, nothing stopped; unreadable output reads the same", async () => {
    expect(await cancelAgent(ID, fake({ code: 0, output: '{"stoppedCount":0,"agentIds":[]}', timedOut: false }).deps)).toEqual({ ok: true, stopped: false });
    expect(await cancelAgent(ID, fake({ code: 0, output: "done", timedOut: false }).deps)).toEqual({ ok: true, stopped: false });
  });

  it.each([
    ["a prefix of an id", "5ea413fa"],
    ["a short id", "rev-a"],
    ["a flag", "--all"],
    ["a cwd flag", "--cwd"],
    ["an id with a trailing flag", `${ID} --all`],
    ["an empty id", ""],
  ])("refuses %s before anything runs", async (_label, id) => {
    const { deps, runs } = fake();

    const result = await cancelAgent(id, deps);

    expect(result.ok).toBe(false);
    expect(runs).toEqual([]);
  });

  it("a command that reports stopping another agent is a failure naming it", async () => {
    const other = "0a1b2c3d-1b2c-4d5e-8f90-a1b2c3d4e5f6";
    const { deps } = fake({ code: 0, output: `{"stoppedCount":2,"agentIds":["${ID}","${other}"]}`, timedOut: false });

    expect(await cancelAgent(ID, deps)).toEqual({ ok: false, reason: `\`paseo agent stop\` also stopped ${other}` });
  });

  it("a failing, missing or slow command is a reason, never an exception", async () => {
    expect(await cancelAgent(ID, fake({ code: 3, output: "no such agent\n", timedOut: false }).deps)).toEqual({ ok: false, reason: "`paseo agent stop` exited with 3: no such agent" });
    expect(await cancelAgent(ID, { find: () => null, run: async () => ({ code: 0, output: "", timedOut: false }) })).toEqual({ ok: false, reason: "the `paseo` command was not found" });
    expect(await cancelAgent(ID, fake({ code: 1, output: "", timedOut: true }).deps)).toEqual({ ok: false, reason: `\`paseo agent stop\` took longer than ${CLI_TIMEOUT_MS} ms` });
  });

  it("isFullAgentId accepts a UUID only", () => {
    expect(isFullAgentId(ID)).toBe(true);
    expect(isFullAgentId(ID.toUpperCase())).toBe(true);
    expect(isFullAgentId(ID.slice(0, -1))).toBe(false);
    expect(isFullAgentId("agent-worker")).toBe(false);
  });
});

describe("manager.ensure output — modeNotice is an added field", () => {
  it("a client that does not know the field still reads the rest", () => {
    const older = managerEnsureRpc.output.omit({ modeNotice: true });
    const output = { agentId: "a", created: false, otherManagerIds: [], modeNotice: "busy" };

    expect(older.parse(output)).toEqual({ agentId: "a", created: false, otherManagerIds: [] });
    expect(managerEnsureRpc.output.parse(output)).toEqual(output);
  });
});
