import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  REQUIRED_SKILLS,
  SKILLS_INSTALL_TIMEOUT_MS,
  installSkills,
  type InstallSkillsDeps,
} from "../plugin/server/setup-skills";
import { readSetupState } from "../plugin/server/setup-state";
import { setupInstallSkillsRpc } from "../plugin/shared/contracts";

/**
 * WP-403: the Setup button that runs the third-party `skills` CLI (design
 * §7.13.4).
 *
 * Nothing here runs a real installer — the runner is a fake that records its
 * argv. That is also the point of the first test: the command must be the
 * constant the screen showed, byte for byte, with nothing from the request
 * anywhere near the shell.
 */

const COMMAND = `npx -y skills add cuongntr/agent-skills -g -a claude-code codex -s ${REQUIRED_SKILLS.join(" ")} -y`;

let home: string;
let runs: Array<{ file: string; args: string[]; timeoutMs: number }>;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "bm-skills-install-"));
  runs = [];
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

/** Writes a usable copy of `name` into `dir`. */
function skill(dir: string, name: string): void {
  mkdirSync(join(dir, name), { recursive: true });
  writeFileSync(join(dir, name, "SKILL.md"), `---\nname: ${name}\ndescription: x\n---\nbody`);
}

function installAll(): void {
  for (const name of REQUIRED_SKILLS) {
    skill(join(home, ".claude", "skills"), name);
    skill(join(home, ".agents", "skills"), name);
  }
}

function deps(
  result: { code?: number; output?: string; timedOut?: boolean } = {},
  extra: Partial<InstallSkillsDeps> = {},
): InstallSkillsDeps {
  return {
    env: { SHELL: "/bin/zsh" } as NodeJS.ProcessEnv,
    homedir: () => home,
    log: () => {},
    run: vi.fn(async (file: string, args: string[], timeoutMs: number) => {
      runs.push({ file, args, timeoutMs });
      // A real run would put the skills in place; the fake does it too, so
      // `missingAfter` is read from disk rather than assumed.
      if ((result.code ?? 0) === 0 && result.timedOut !== true) installAll();
      return { code: result.code ?? 0, output: result.output ?? "added 5 skills\n", timedOut: result.timedOut === true };
    }),
    ...extra,
  };
}

describe("installSkills", () => {
  it("runs exactly the command the Setup screen showed, in a login shell", async () => {
    const result = await installSkills(deps());

    expect(runs).toEqual([{ file: "/bin/zsh", args: ["-lc", COMMAND], timeoutMs: SKILLS_INSTALL_TIMEOUT_MS }]);
    expect(result.command).toBe(COMMAND);
    expect(SKILLS_INSTALL_TIMEOUT_MS).toBe(300_000);
  });

  it("uses bash when the user's shell is not zsh", async () => {
    await installSkills(deps({}, { env: { SHELL: "/bin/bash" } as NodeJS.ProcessEnv }));

    expect(runs[0]?.file).toBe("/bin/bash");
  });

  it("reports what was missing before and after, and records the run", async () => {
    const result = await installSkills(deps());

    expect(result.missingBefore).toMatchObject({ claude: 5, codex: 5 });
    expect(result.missingAfter).toMatchObject({ claude: 0, codex: 0 });
    expect(result.code).toBe(0);
    expect(readSetupState({ env: {}, homedir: () => home }).skillsRun).toMatchObject({
      command: COMMAND,
      code: 0,
      outcome: "ok",
    });
  });

  it("runs nothing when Claude and Codex already have every required skill", async () => {
    installAll();

    await expect(installSkills(deps())).rejects.toMatchObject({ code: "E_SKILLS_PRESENT" });

    expect(runs).toEqual([]);
  });

  it("still runs when only one of the two is missing them", async () => {
    for (const name of REQUIRED_SKILLS) skill(join(home, ".claude", "skills"), name);

    await installSkills(deps());

    expect(runs).toHaveLength(1);
  });

  it("reports a non-zero exit with the command and the last three lines", async () => {
    const output = "one\ntwo\nthree\nfour\nnpm ERR! not found\n";

    const error = await installSkills(deps({ code: 1, output })).catch((e: unknown) => e);

    expect(error).toMatchObject({ code: "E_SKILLS_INSTALL_FAILED" });
    expect((error as Error).message).toBe(`E_SKILLS_INSTALL_FAILED: \`${COMMAND}\` exited with 1: three | four | npm ERR! not found`);
    expect(readSetupState({ env: {}, homedir: () => home }).skillsRun).toMatchObject({ code: 1, outcome: "failed" });
  });

  it("calls a run that was killed a timeout, not a failure", async () => {
    const error = await installSkills(deps({ code: 1, output: "hung\n", timedOut: true })).catch((e: unknown) => e);

    expect(error).toMatchObject({ code: "E_SKILLS_INSTALL_FAILED" });
    expect((error as Error).message).toContain("did not finish within 300 seconds");
    expect(readSetupState({ env: {}, homedir: () => home }).skillsRun).toMatchObject({ outcome: "timeout" });
  });

  it("masks a secret that the CLI echoed", async () => {
    const env = { SHELL: "/bin/zsh", PASEO_PASSWORD: "hunter2" } as NodeJS.ProcessEnv;

    const result = await installSkills(deps({ output: "logging in with hunter2\nnpm --token abc123\n" }, { env }));

    const tail = result.tail.join("\n");
    expect(tail).not.toContain("hunter2");
    expect(tail).not.toContain("abc123");
    expect(tail).toContain("[redacted]");
  });

  it("keeps at most the last forty lines", async () => {
    const output = Array.from({ length: 60 }, (_, index) => `line ${index}`).join("\n");

    const result = await installSkills(deps({ output }));

    expect(result.tail).toHaveLength(40);
    expect(result.tail[0]).toBe("line 20");
  });

  it("still succeeds when the run cannot be recorded", async () => {
    mkdirSync(join(home, ".paseo-bm"), { recursive: true, mode: 0o700 });
    writeFileSync(join(home, ".paseo-bm", "ui"), "a file where the folder should be");
    const logged: string[] = [];

    const result = await installSkills(deps({}, { log: (line) => logged.push(line) }));

    expect(result.code).toBe(0);
    expect(logged.join("\n")).toContain("could not record the skills run");
  });
});

describe("the contract of setup.install-skills", () => {
  it("takes only an explicit confirmation", () => {
    expect(setupInstallSkillsRpc.input.parse({ confirmed: true })).toEqual({ confirmed: true });
    for (const input of [{}, { confirmed: false }, { confirmed: "true" }]) {
      expect(() => setupInstallSkillsRpc.input.parse(input)).toThrow();
    }
  });
});
