import { describe, expect, it } from "vitest";
import { renderJsonReport, toJsonDocument, writeJsonReport } from "../src/report/json.js";
import { EXIT_CODES } from "../src/exit-codes.js";
import type { Action, Check, DoctorReport, PlanReport, Report } from "../src/action.js";

/**
 * Fixtures use symbolic roots (`installHome/…`, `paseoHome/…`) exactly as
 * Design §4.4 writes them, so snapshots never contain a real `$HOME`.
 */
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
  {
    kind: "update",
    target: "installHome/install.json",
    location: "install-home",
    reason: "outdated",
  },
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
  {
    kind: "create",
    target: "paseoDaemon/plugins[paseo-bm]",
    location: "paseo-daemon",
    reason: "missing",
  },
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

const UNINSTALL_ACTIONS: readonly Action[] = [
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
];

function uninstallReport(): PlanReport {
  return {
    schemaVersion: 1,
    command: "uninstall",
    mode: "preview",
    paseoBmVersion: "0.1.0",
    paseo: { ...PASEO, pluginsEnabled: true },
    actions: UNINSTALL_ACTIONS,
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

/** A stdout sink that records every chunk, the way the CLI passes one in. */
function sink(): { chunks: string[]; write: (chunk: string) => void } {
  const chunks: string[] = [];
  return { chunks, write: (chunk) => chunks.push(chunk) };
}

describe("renderJsonReport — install", () => {
  it("renders the shape of Design §4.4", () => {
    expect(renderJsonReport(installReport())).toMatchSnapshot();
  });

  it("orders the top-level keys the way Design §4.4 lists them", () => {
    expect(Object.keys(toJsonDocument(installReport()))).toEqual([
      "schemaVersion",
      "command",
      "mode",
      "paseoBmVersion",
      "paseo",
      "actions",
      "roles",
      "skills",
      "warnings",
      "result",
    ]);
  });

  it("renders from/to only for config actions", () => {
    const document = toJsonDocument(installReport()) as { actions: Record<string, unknown>[] };
    expect(Object.keys(document.actions[0] ?? {})).toEqual(["kind", "target", "reason"]);
    const config = document.actions.find((action) => action.kind === "config");
    expect(Object.keys(config ?? {})).toEqual(["kind", "target", "reason", "from", "to", "consent"]);
    expect(config?.from).toBe(false);
  });

  it("takes warning wording from the registry, not from the caller", () => {
    const document = toJsonDocument(installReport()) as { warnings: Record<string, unknown>[] };
    expect(document.warnings[0]).toEqual({
      code: "W_BEADS_CLI_MISSING",
      message: expect.stringContaining("beads CLI"),
      detail: "looked for br and bd on PATH",
    });
  });

  it("renders an applied run through the very same code path", () => {
    const preview = toJsonDocument(installReport());
    const applied = toJsonDocument(installReport({ mode: "applied" }));
    expect(applied.actions).toEqual(preview.actions);
    expect(applied.mode).toBe("applied");
  });

  it("renders skills as null when the step was skipped", () => {
    expect(toJsonDocument(installReport({ skills: null })).skills).toBeNull();
  });
});

describe("writeJsonReport — stdout holds exactly one document", () => {
  it("writes one chunk that parses as a single JSON document", () => {
    const stdout = sink();
    writeJsonReport(installReport(), stdout.write);
    const text = stdout.chunks.join("");

    expect(stdout.chunks).toHaveLength(1);
    expect(text.endsWith("\n")).toBe(true);
    expect(text.trimStart().startsWith("{")).toBe(true);

    // Two concatenated documents, or any log line mixed in, would make this throw.
    const parsed: unknown = JSON.parse(text);
    expect(parsed).toEqual(toJsonDocument(installReport()));

    // And nothing outside the document: the text is exactly what JSON.stringify produced.
    expect(text).toBe(`${JSON.stringify(parsed, null, 2)}\n`);
  });

  it("stays a single document for every command", () => {
    for (const report of [installReport(), uninstallReport(), doctorReport()] satisfies Report[]) {
      const stdout = sink();
      writeJsonReport(report, stdout.write);
      expect(() => JSON.parse(stdout.chunks.join("")) as unknown).not.toThrow();
      expect(stdout.chunks).toHaveLength(1);
    }
  });

  it("can render compactly on one line", () => {
    const text = renderJsonReport(uninstallReport(), { indent: 0 });
    expect(text.trimEnd().split("\n")).toHaveLength(1);
    expect(() => JSON.parse(text) as unknown).not.toThrow();
  });

  it("passes the finished text through the redaction seam", () => {
    const text = renderJsonReport(installReport(), { redact: (value) => value.replace(/0\.8\.0/g, "x.y.z") });
    expect(text).not.toContain("0.8.0");
    expect(() => JSON.parse(text) as unknown).not.toThrow();
  });
});

describe("renderJsonReport — doctor", () => {
  it("renders checks[] instead of actions[]", () => {
    expect(renderJsonReport(doctorReport())).toMatchSnapshot();
  });

  it("never carries an actions key", () => {
    const document = toJsonDocument(doctorReport());
    expect(document).not.toHaveProperty("actions");
    expect(Object.keys(document)).toContain("checks");
  });

  it("gives every check the four fields of Design §4.4", () => {
    const document = toJsonDocument(doctorReport()) as { checks: Record<string, unknown>[] };
    for (const check of document.checks) {
      expect(Object.keys(check)).toEqual(["id", "severity", "message", "remediation"]);
    }
  });
});

describe("renderJsonReport — uninstall", () => {
  it("renders delete, keep and config actions", () => {
    expect(renderJsonReport(uninstallReport())).toMatchSnapshot();
  });

  it("uses only the uninstall kinds of Design §4.4", () => {
    const document = toJsonDocument(uninstallReport()) as { actions: Record<string, unknown>[] };
    expect(document.actions.map((action) => action.kind)).toEqual(["delete", "keep", "config"]);
  });
});

describe("result.error (Design §4.4 errata 2026-09-15)", () => {
  it("carries the registry code and message on a failed run", () => {
    const failed = {
      ...installReport(),
      result: {
        exitCode: EXIT_CODES.preflight,
        pluginState: null,
        error: { code: "E_TARGET_NOT_WRITABLE" as const, message: "The install home is not writable." },
      },
    };
    const document = JSON.parse(renderJsonReport(failed)) as { result: Record<string, unknown> };
    expect(document.result).toEqual({
      exitCode: EXIT_CODES.preflight,
      pluginState: null,
      error: { code: "E_TARGET_NOT_WRITABLE", message: "The install home is not writable." },
    });
  });

  it("omits the key entirely on success", () => {
    const document = JSON.parse(renderJsonReport(installReport())) as { result: Record<string, unknown> };
    expect(Object.keys(document.result)).toEqual(["exitCode", "pluginState"]);
  });
});
