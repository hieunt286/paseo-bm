import { afterEach, describe, expect, it, vi } from "vitest";
import {
  REDACTED,
  SECRET_ARGV_FLAGS,
  SECRET_ENV_VARS,
  collectSecrets,
  createJsonRedactor,
  createRedactingWriter,
  createRedactor,
  redactArgv,
  redactText,
} from "../src/redact.js";
import { renderHumanReport } from "../src/report/human.js";
import { renderJsonReport } from "../src/report/json.js";
import type { PlanReport, Report } from "../src/action.js";

/**
 * The value used as a stand-in for a real credential. Long and distinctive so a
 * leak anywhere in an output is unmistakable, and so a passing assertion cannot
 * be an accident of short-string collision.
 */
const SECRET = "hunter2-Sup3r-Secret-Value";

afterEach(() => {
  vi.unstubAllEnvs();
});

function planReport(overrides: Partial<PlanReport> = {}): Report {
  const base: PlanReport = {
    schemaVersion: 1,
    command: "install",
    mode: "preview",
    paseoBmVersion: "0.1.0",
    paseo: {
      cliVersion: "0.8.0",
      daemonVersion: "0.8.0",
      home: "/fake/home/.paseo",
      pluginsEnabled: false,
    },
    actions: [
      {
        kind: "create",
        target: "installHome/plugin/0.1.0/roles/worker.md",
        location: "install-home",
        reason: "missing",
      },
    ],
    roles: [],
    skills: null,
    warnings: [],
    result: { exitCode: 0, pluginState: null },
  };
  return { ...base, ...overrides } as Report;
}

/** A report that carries the secret in every text-bearing field a plan can have. */
function reportCarrying(secret: string): Report {
  return planReport({
    actions: [
      {
        kind: "create",
        target: `installHome/plugin/0.1.0/${secret}.md`,
        location: "install-home",
        reason: "missing",
        detail: `ran: npx -y skills add repo --token ${secret}`,
      },
    ],
    skills: {
      source: "cuongntr/agent-skills",
      required: ["feature-workflow"],
      byAgent: { codex: { present: [], missing: ["feature-workflow"] } },
      suggestedCommand: `npx -y skills add cuongntr/agent-skills --secret=${secret} --agent codex`,
      assisted: false,
      outcome: null,
    },
  });
}

describe("what counts as a secret", () => {
  it("is the constant list from Design §7", () => {
    expect(SECRET_ENV_VARS).toEqual(["PASEO_PASSWORD", "PASEO_DAEMON_PASSWORD"]);
    expect(SECRET_ARGV_FLAGS).toEqual(["--password", "--token", "--secret"]);
  });

  it("collects the value of each secret environment variable", () => {
    const secrets = collectSecrets({ env: { PASEO_PASSWORD: "one", PASEO_DAEMON_PASSWORD: "two", PATH: "/usr/bin" } });
    expect(new Set(secrets)).toEqual(new Set(["one", "two"]));
  });

  it("collects the value a password-shaped flag was given, in both spellings", () => {
    const secrets = collectSecrets({
      env: {},
      argv: ["install", "--token", "from-space", "--password=from-equals", "--secret", "from-space-2"],
    });
    expect(new Set(secrets)).toEqual(new Set(["from-space", "from-equals", "from-space-2"]));
  });

  it("ignores blank values, which would otherwise mask the entire output", () => {
    expect(collectSecrets({ env: { PASEO_PASSWORD: "", PASEO_DAEMON_PASSWORD: "   " } })).toEqual([]);
    const redact = createRedactor({ env: { PASEO_PASSWORD: "" } });
    expect(redact("nothing to hide here\n")).toBe("nothing to hide here\n");
  });

  it("does not mistake the next flag for a missing value", () => {
    expect(collectSecrets({ env: {}, argv: ["--token", "--json"] })).toEqual([]);
  });

  it("masks the longest secret first when one contains another", () => {
    const redact = createRedactor({ env: { PASEO_PASSWORD: "abc", PASEO_DAEMON_PASSWORD: "abcdef" } });
    expect(redact("abcdef")).toBe(REDACTED);
  });
});

describe("masking text", () => {
  it("masks an environment secret wherever it appears, not only next to a flag", () => {
    const redact = createRedactor({ env: { PASEO_PASSWORD: SECRET } });
    const masked = redact(`daemon said: connected as ${SECRET} (attempt 1)\n`);
    expect(masked).not.toContain(SECRET);
    expect(masked).toBe(`daemon said: connected as ${REDACTED} (attempt 1)\n`);
  });

  it("masks a password-shaped argv token whose value never passed through our environment", () => {
    const redact = createRedactor({ env: {} });
    expect(redact("$ npx -y skills add repo --token ghp_abcdef123456\n")).toBe(
      `$ npx -y skills add repo --token ${REDACTED}\n`,
    );
    expect(redact("$ paseo login --password=pa55word\n")).toBe(`$ paseo login --password=${REDACTED}\n`);
    expect(redact("$ tool --secret 'two words' --json\n")).toBe(`$ tool --secret ${REDACTED} --json\n`);
  });

  it("keeps the flag visible so a printed command is still readable", () => {
    expect(redactText("run: cmd --password s3cret --verbose\n", { env: {} })).toContain("--password");
  });

  it("masks a secret that JSON would have escaped", () => {
    const awkward = 'he said "no"\\then left';
    const redact = createRedactor({ env: { PASEO_PASSWORD: awkward } });
    const jsonEscaped = JSON.stringify(awkward).slice(1, -1);
    expect(redact(`value: ${jsonEscaped}`)).toBe(`value: ${REDACTED}`);
    expect(redact(`value: ${awkward}`)).toBe(`value: ${REDACTED}`);
  });
});

describe("masking an argv before it is printed", () => {
  it("replaces the value and keeps the shape", () => {
    expect(redactArgv(["skills", "add", "repo", "--token", "ghp_secret", "--agent", "codex"], { env: {} })).toEqual([
      "skills",
      "add",
      "repo",
      "--token",
      REDACTED,
      "--agent",
      "codex",
    ]);
    expect(redactArgv(["login", "--password=pa55word"], { env: {} })).toEqual(["login", `--password=${REDACTED}`]);
  });

  it("masks an environment secret that was embedded in an unrelated argument", () => {
    expect(redactArgv(["--home", `/tmp/${SECRET}/install`], { env: { PASEO_PASSWORD: SECRET } })).toEqual([
      "--home",
      `/tmp/${REDACTED}/install`,
    ]);
  });
});

describe("the --json channel", () => {
  it("still emits exactly one parseable document when a secret is masked", () => {
    vi.stubEnv("PASEO_PASSWORD", SECRET);
    const text = renderJsonReport(reportCarrying(SECRET));
    expect(text).not.toContain(SECRET);
    const document = JSON.parse(text) as Record<string, unknown>;
    expect(document.schemaVersion).toBe(1);
  });

  it("replaces the secret inside a value instead of truncating the document", () => {
    vi.stubEnv("PASEO_PASSWORD", SECRET);
    const document = JSON.parse(renderJsonReport(reportCarrying(SECRET))) as {
      skills: { suggestedCommand: string };
      actions: readonly { target: string; detail: string }[];
    };
    expect(document.skills.suggestedCommand).toBe(
      `npx -y skills add cuongntr/agent-skills --secret=${REDACTED} --agent codex`,
    );
    expect(document.actions[0]?.target).toBe(`installHome/plugin/0.1.0/${REDACTED}.md`);
    expect(document.actions[0]?.detail).toBe(`ran: npx -y skills add repo --token ${REDACTED}`);
  });

  it("survives a secret made entirely of JSON punctuation", () => {
    // A newline-bearing secret is in this list on purpose: inside the document
    // it appears escaped, so only the escaped form can match it. A secret that
    // is *only* whitespace is not in the list — blank values are ignored by
    // design, see "ignores blank values" above.
    for (const nasty of ['"', '","', "\\", "}", "a\nb", '{"a":1}']) {
      const redact = createJsonRedactor({ env: { PASEO_PASSWORD: nasty }, indent: 2 });
      const text = redact(`${JSON.stringify({ note: `x${nasty}y`, list: ["a", "b"], code: 0 }, null, 2)}\n`);
      const parsed = JSON.parse(text) as { note: string; list: readonly string[] };
      expect(parsed.list).toEqual(["a", "b"]);
      expect(parsed.note).toBe(`x${REDACTED}y`);
    }
  });

  it("returns the document byte-for-byte when there is nothing to mask", () => {
    const redact = createJsonRedactor({ env: {} });
    const text = `${JSON.stringify({ b: 1, a: [1, 2], nested: { z: null } }, null, 2)}\n`;
    expect(redact(text)).toBe(text);
  });

  it("keeps the indentation it was rendered with", () => {
    vi.stubEnv("PASEO_PASSWORD", SECRET);
    const compact = renderJsonReport(reportCarrying(SECRET), { indent: 0 });
    expect(compact.split("\n").filter((line) => line.length > 0)).toHaveLength(1);
    expect(compact).not.toContain(SECRET);
    expect(renderJsonReport(reportCarrying(SECRET), { indent: 4 })).toContain('\n    "schemaVersion"');
  });

  it("masks a number whose decimal form is the secret rather than leaking it", () => {
    const redact = createJsonRedactor({ env: { PASEO_PASSWORD: "1234" }, indent: 2 });
    const parsed = JSON.parse(redact(`${JSON.stringify({ port: 1234, other: 7 }, null, 2)}\n`)) as {
      port: unknown;
      other: unknown;
    };
    expect(parsed.port).toBe(REDACTED);
    expect(parsed.other).toBe(7);
  });

  it("falls back to text masking when handed something that is not a document", () => {
    const redact = createJsonRedactor({ env: { PASEO_PASSWORD: SECRET } });
    expect(redact(`not json: ${SECRET}`)).toBe(`not json: ${REDACTED}`);
  });
});

describe("the --verbose channel", () => {
  it("masks whole lines written through the wrapped writer", () => {
    const chunks: string[] = [];
    const writer = createRedactingWriter((chunk) => chunks.push(chunk), createRedactor({ env: { PASEO_PASSWORD: SECRET } }));
    writer(`+ paseo daemon status (as ${SECRET})\n`);
    writer.flush();
    expect(chunks.join("")).toBe(`+ paseo daemon status (as ${REDACTED})\n`);
  });

  it("masks a secret split across two writes, which is how a chunk filter leaks", () => {
    const chunks: string[] = [];
    const writer = createRedactingWriter((chunk) => chunks.push(chunk), createRedactor({ env: { PASEO_PASSWORD: SECRET } }));
    writer(`connected as ${SECRET.slice(0, 8)}`);
    writer(`${SECRET.slice(8)} ok\n`);
    writer.flush();
    const written = chunks.join("");
    expect(written).not.toContain(SECRET);
    expect(written).toBe(`connected as ${REDACTED} ok\n`);
  });

  it("holds back a line with no newline until flush, and emits it masked", () => {
    const chunks: string[] = [];
    const writer = createRedactingWriter((chunk) => chunks.push(chunk), createRedactor({ env: { PASEO_PASSWORD: SECRET } }));
    writer(`tail without newline: ${SECRET}`);
    expect(chunks).toEqual([]);
    writer.flush();
    expect(chunks.join("")).toBe(`tail without newline: ${REDACTED}`);
    writer.flush();
    expect(chunks).toHaveLength(1);
  });
});

describe("all three channels, from one environment", () => {
  /**
   * The bead's first acceptance criterion: set `PASEO_PASSWORD`, run all three
   * channels, and the value appears nowhere. Neither renderer is handed a
   * redactor here — masking has to be what happens by default, because an
   * opt-in seam is one forgotten argument away from a leak.
   */
  it.each(SECRET_ENV_VARS)("masks %s in the human table, the JSON document and the verbose stream", (variable) => {
    vi.stubEnv(variable, SECRET);
    const report = reportCarrying(SECRET);

    const human = renderHumanReport(report);
    const json = renderJsonReport(report);
    const verboseChunks: string[] = [];
    const verbose = createRedactingWriter((chunk) => verboseChunks.push(chunk));
    verbose(`+ paseo plugin install /tmp/x --token ${SECRET}\n`);
    verbose.flush();

    for (const channel of [human, json, verboseChunks.join("")]) {
      expect(channel).not.toContain(SECRET);
      expect(channel).toContain(REDACTED);
    }
    expect(JSON.parse(json)).toMatchObject({ schemaVersion: 1 });
  });

  it("leaves output untouched when no secret is set", () => {
    vi.stubEnv("PASEO_PASSWORD", "");
    vi.stubEnv("PASEO_DAEMON_PASSWORD", "");
    const report = planReport();
    expect(renderHumanReport(report)).toBe(renderHumanReport(report, { redact: (text) => text }));
    expect(renderJsonReport(report)).toBe(renderJsonReport(report, { redact: (text) => text }));
  });
});
