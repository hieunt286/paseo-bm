import { describe, expect, it } from "vitest";
import { renderHumanReport, writeHumanReport } from "../src/report/human.js";
import { EXIT_CODES } from "../src/exit-codes.js";
import type { Action, Check, DoctorReport, PlanReport } from "../src/action.js";

const PASEO = {
  cliVersion: "0.8.0",
  daemonVersion: "0.8.0",
  home: "/fake/home/.paseo",
  pluginsEnabled: false,
} as const;

const ROLES = [
  { role: "manager", provider: "claude", model: "opus-5", paseoTools: true, loggedIn: true },
  { role: "worker", provider: "codex", model: "gpt-5.6-sol", paseoTools: true, loggedIn: false },
  { role: "reviewer", provider: "codex", model: "gpt-5.6-sol", paseoTools: false, loggedIn: null },
] as const;

const SKILLS = {
  source: "cuongntr/agent-skills",
  required: ["feature-workflow", "implementing-beads"],
  byAgent: {
    codex: { present: ["feature-workflow"], missing: ["implementing-beads"] },
    claude: { present: ["feature-workflow", "implementing-beads"], missing: [] },
  },
  suggestedCommand: "npx -y skills add cuongntr/agent-skills --agent codex implementing-beads",
  assisted: false,
  outcome: null,
} as const;

const INSTALL_ACTIONS: readonly Action[] = [
  {
    kind: "create",
    target: "installHome/plugin/0.1.0/roles/worker.md",
    location: "install-home",
    reason: "missing",
  },
  { kind: "update", target: "installHome/install.json", location: "install-home", reason: "outdated" },
  {
    kind: "skip",
    target: "installHome/plugin/0.1.0/roles/manager.md",
    location: "install-home",
    reason: "unchanged",
  },
  {
    kind: "conflict",
    target: "installHome/plugin/0.1.0/roles/reviewer.md",
    location: "install-home",
    reason: "user-modified",
    detail: "re-run with --force to overwrite; a backup is taken first",
  },
  { kind: "create", target: "paseoDaemon/plugins[paseo-bm]", location: "paseo-daemon", reason: "missing" },
  {
    kind: "config",
    target: "paseoHome/config.json#pluginsEnabled",
    location: "paseo-config",
    reason: "not enabled yet",
    from: false,
    to: true,
    consent: "interactive",
  },
  {
    kind: "config",
    target: "paseoHome/config.json#daemon.agentProfiles[bm-worker]",
    location: "paseo-config",
    reason: "missing",
    from: null,
    to: { id: "bm-worker", label: "Beads Worker" },
    consent: "interactive",
  },
];

function installReport(overrides: Partial<PlanReport> = {}): PlanReport {
  return {
    schemaVersion: 1,
    command: "install",
    mode: "preview",
    paseoBmVersion: "0.1.0",
    paseo: PASEO,
    actions: INSTALL_ACTIONS,
    roles: [...ROLES],
    skills: SKILLS,
    warnings: [{ code: "W_BEADS_CLI_MISSING", detail: "looked for br and bd on PATH" }],
    result: { exitCode: EXIT_CODES.ok, pluginState: "disabled" },
    ...overrides,
  };
}

function uninstallReport(): PlanReport {
  return {
    schemaVersion: 1,
    command: "uninstall",
    mode: "preview",
    paseoBmVersion: "0.1.0",
    paseo: { ...PASEO, pluginsEnabled: true },
    actions: [
      { kind: "delete", target: "installHome/plugin/0.1.0", location: "install-home", reason: "owned payload" },
      {
        kind: "keep",
        target: "installHome/plugin/0.1.0/roles/reviewer.md",
        location: "install-home",
        reason: "user-modified",
      },
      {
        kind: "config",
        target: "paseoHome/config.json#daemon.mcp.injectIntoAgents",
        location: "paseo-config",
        reason: "restoring the value paseo-bm found",
        from: true,
        to: null,
        consent: "interactive",
      },
    ],
    roles: [],
    skills: null,
    warnings: [],
    result: { exitCode: EXIT_CODES.ok, pluginState: "running" },
  };
}

const CHECKS: readonly Check[] = [
  { id: "paseo-cli", severity: "ok", message: "Paseo CLI 0.8.0 and daemon 0.8.0 agree.", remediation: "" },
  {
    id: "plugin-status",
    severity: "error",
    message: "The paseo-bm plugin is registered but its status is disabled.",
    remediation: "Run `npx paseo-bm install --apply` and consent to enabling plugins.",
  },
  {
    id: "skills",
    severity: "warn",
    message: "codex is missing 1 of 2 required skills.",
    remediation: "Run the printed `skills add` command.",
  },
];

function doctorReport(): DoctorReport {
  return {
    schemaVersion: 1,
    command: "doctor",
    mode: "preview",
    paseoBmVersion: "0.1.0",
    paseo: { ...PASEO, pluginsEnabled: true },
    checks: CHECKS,
    roles: [...ROLES],
    skills: SKILLS,
    warnings: [{ code: "W_PROVIDER_NOT_LOGGED_IN", detail: "worker uses codex" }],
    result: { exitCode: EXIT_CODES.doctorDrift, pluginState: "disabled" },
  };
}

function sink(): { chunks: string[]; write: (chunk: string) => void } {
  const chunks: string[] = [];
  return { chunks, write: (chunk) => chunks.push(chunk) };
}

describe("renderHumanReport — install", () => {
  it("renders a preview grouped by destination", () => {
    expect(renderHumanReport(installReport())).toMatchSnapshot();
  });

  it("renders the applied run from the same plan, changing only the wording", () => {
    expect(renderHumanReport(installReport({ mode: "applied", result: { exitCode: EXIT_CODES.ok, pluginState: "running" } }))).toMatchSnapshot();
  });

  it("says plainly that a preview wrote nothing", () => {
    expect(renderHumanReport(installReport())).toContain("preview, nothing has been written");
  });

  it("puts each action under the heading of the place it lands", () => {
    const lines = renderHumanReport(installReport()).split("\n");
    const installIndex = lines.findIndex((line) => line.trim() === "Install home");
    const configIndex = lines.findIndex((line) => line.trim() === "Paseo config");
    const daemonIndex = lines.findIndex((line) => line.trim() === "Paseo daemon");
    expect(installIndex).toBeGreaterThan(-1);
    expect(installIndex).toBeLessThan(configIndex);
    expect(configIndex).toBeLessThan(daemonIndex);
  });

  it("shows the before and after value of a config action", () => {
    expect(renderHumanReport(installReport())).toContain("false -> true");
  });

  it("explains an empty plan instead of printing a blank table", () => {
    const text = renderHumanReport(installReport({ actions: [] }));
    expect(text).toContain("nothing to do");
  });

  it("prints the warning message and its remediation from the registry", () => {
    const text = renderHumanReport(installReport());
    expect(text).toContain("W_BEADS_CLI_MISSING");
    expect(text).toContain("looked for br and bd on PATH");
    expect(text).toContain("Fix: ");
  });

  it("ends with the exit code and its meaning", () => {
    const lines = renderHumanReport(installReport()).trimEnd().split("\n");
    expect(lines.at(-1)).toBe("Exit code 0 — success, an intentional preview, or a healthy doctor");
  });

  it("marks a preview that ran with no terminal and no --apply as exit code 6", () => {
    const text = renderHumanReport(
      installReport({ result: { exitCode: EXIT_CODES.noTtyNoApply, pluginState: "disabled" } }),
    );
    expect(text).toContain("Exit code 6 — no terminal and no --apply; preview printed, nothing written");
  });

  it("cuts an unreasonably long config value short", () => {
    const long = "x".repeat(200);
    const text = renderHumanReport(
      installReport({
        actions: [
          {
            kind: "config",
            target: "paseoHome/config.json#agents.providers[bm-worker]",
            location: "paseo-config",
            reason: "missing",
            from: null,
            to: long,
          },
        ],
      }),
      { maxValueLength: 20 },
    );
    expect(text).not.toContain(long);
    expect(text).toContain("…");
  });
});

describe("renderHumanReport — doctor and uninstall", () => {
  it("renders checks with a severity marker and a fix", () => {
    expect(renderHumanReport(doctorReport())).toMatchSnapshot();
  });

  it("says doctor writes nothing", () => {
    expect(renderHumanReport(doctorReport())).toContain("read-only, nothing is written");
  });

  it("does not print a remediation for a check that passed", () => {
    const lines = renderHumanReport(doctorReport()).split("\n");
    const okLine = lines.findIndex((line) => line.includes("[ok]"));
    expect(lines[okLine + 1]).not.toContain("Fix:");
  });

  it("renders the uninstall kinds delete, keep and config", () => {
    expect(renderHumanReport(uninstallReport())).toMatchSnapshot();
  });

  it("omits the roles and skills blocks when there is nothing to say", () => {
    const text = renderHumanReport(uninstallReport());
    expect(text).not.toContain("Agent roles");
    expect(text).not.toContain("Agent skills");
  });
});

describe("writeHumanReport", () => {
  it("writes to the sink it is given, never to console", () => {
    const stderr = sink();
    writeHumanReport(installReport(), stderr.write);
    expect(stderr.chunks).toHaveLength(1);
    expect(stderr.chunks[0]).toBe(renderHumanReport(installReport()));
    expect(stderr.chunks[0]?.endsWith("\n")).toBe(true);
  });

  it("passes the finished text through the redaction seam", () => {
    const text = renderHumanReport(installReport(), { redact: (value) => value.replace(/0\.8\.0/g, "x.y.z") });
    expect(text).not.toContain("0.8.0");
  });
});
