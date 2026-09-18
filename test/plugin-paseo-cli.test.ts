import { describe, expect, it } from "vitest";
import { CLI_TIMEOUT_MS, isSafeAgentId, setAgentLabel, setAgentMode, type PaseoCliDeps } from "../plugin/server/paseo-cli";
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

describe("manager.ensure output — modeNotice is an added field", () => {
  it("a client that does not know the field still reads the rest", () => {
    const older = managerEnsureRpc.output.omit({ modeNotice: true });
    const output = { agentId: "a", created: false, otherManagerIds: [], modeNotice: "busy" };

    expect(older.parse(output)).toEqual({ agentId: "a", created: false, otherManagerIds: [] });
    expect(managerEnsureRpc.output.parse(output)).toEqual(output);
  });
});
