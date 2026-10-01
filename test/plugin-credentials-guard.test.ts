import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import {
  REDACTED,
  SECRET_ENV_VARS,
  clearStartMarks,
  collectTurnEnded,
  type CollectorPaseo,
} from "../plugin/server/collector";
import { clearTraceStoreCache, readRecords } from "../plugin/server/trace-store";

/**
 * The plugin server's proof that paseo-bm never touches a credential
 * (AGENTS.md safety boundaries, design §9 "Secrets").
 *
 * The retired installer had its own proof, `credentials-guard.test.ts`, deleted
 * with its source (ADR-022 decision 1). It recorded every `node:fs` call of one
 * representative install. The server has no single flow to drive — it is a
 * hundred modules answering hooks, RPCs and agent tools — so this guard reads
 * their source instead. Every file the server bundle is built from
 * (`index.server.ts`, `server/`, `shared/`) is parsed with the TypeScript
 * compiler, so comments never count, and three things are looked for:
 *
 * 1. a string naming a credential file or a secret store: the installer
 *    guard's file names, plus key folders, keychains and `*token*` /
 *    `*secret*` files;
 * 2. an environment variable read by name that is not on a short allow list,
 *    or any name shaped like a secret (`*KEY*`, `*TOKEN*`, `*PASSWORD*`, …);
 * 3. a read of a variable chosen at run time, or of the whole environment,
 *    outside the three functions allowed to.
 *
 * A scan that cannot fail is decoration, so the same detectors run over a
 * planted source that reads Codex's `auth.json` and an API key, and must fire.
 * Last, the collector — the module that writes what agents say and run — is
 * fed planted secrets, and every file it wrote is searched for them.
 *
 * Only source text and a temporary folder are read: no real credential file is
 * opened, and the real environment is never handed to the collector.
 */

const PLUGIN_DIR = fileURLToPath(new URL("../plugin/", import.meta.url));

/** The file names the installer's guard watched, unchanged. */
const CREDENTIAL_FILE_NAMES: ReadonlySet<string> = new Set([
  "auth.json",
  ".credentials.json",
  "credentials.json",
  ".claude.json",
  "sessions.json",
  "token.json",
  ".netrc",
]);

/** Anything else that marks a credential or a secret store, matched against one word of a string. */
const CREDENTIAL_MARKERS: readonly RegExp[] = [
  // Keychains, and the commands that print a stored secret.
  /keychain/i,
  /^(find-generic-password|find-internet-password|secret-tool|keytar)$/,
  // Folders of keys and logins, and the files in them.
  /(^|\/)\.(aws|ssh|gnupg|password-store)(\/|$)/,
  /(^|\/)\.docker\/config\.json$/,
  /(^|\/)gh\/hosts\.yml$/,
  /(^|\/)github-copilot(\/|$)/,
  /(^|\/)(\.git-credentials|\.npmrc|\.pypirc|\.pgpass|\.env(\.[\w.-]+)?)$/,
  /(^|\/)id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/,
  /\.(pem|p12|pfx)$/i,
  // A `*token*` or `*secret*` file.
  /(^|\/)[^/]*(token|secret)[^/]*\.(json|txt|ya?ml|toml)$/i,
];

/** An environment variable name that holds a secret by its shape. */
const SECRET_NAME = /KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH|COOKIE|SESSION/;
const UPPER_NAME = /^[A-Z][A-Z0-9_]*$/;

/**
 * Every environment variable the server reads by name. None holds a secret:
 * `CLAUDE_CONFIG_DIR` and `CODEX_HOME` move an agent's skill folder
 * (setup-skills), `PATH` finds `br` and `bv`, and `SHELL` picks the login
 * shell an install command runs in (setup-tools, setup-skills). A new read
 * belongs here only after the same question: can its value be a secret?
 */
// TMPDIR: the daemon's temp folder, which the action boundary treats as the scratch area (autonomy design Part D, bead loga.3).
const ENV_NAMES_READ: readonly string[] = ["CLAUDE_CONFIG_DIR", "CODEX_HOME", "PATH", "SHELL", "TMPDIR"];

/**
 * The only functions that read a variable whose name is chosen at run time, or
 * the whole environment at once. Keyed by file and function, never by line.
 */
const RUNTIME_ENV_READS: Readonly<Record<string, string>> = {
  "server/collector.ts redactText": "reads the values of SECRET_ENV_VARS, only to mask them before anything is written (REQ-048b)",
  "server/data-home.ts pickEnv": "reads PASEO_BM_HOME and the variables that move ~/.paseo, ~/.claude and ~/.codex, to keep the data folder out of them",
  "server/repo-tool.ts gitEnv": "hands git the plugin's environment minus the GIT_* variables that would redirect it; reads no value",
};

/**
 * Generated copies of `plugin/roles/*.md`: text an agent reads, which tells it
 * never to open `.env` or credentials. It names them; it opens nothing. Kept
 * out of the word scan only, and only these four.
 */
const GENERATED_ROLE_TEXT = /^\/\/ GENERATED FILE[^\n]*\n\/\/ Regenerated from plugin\/roles\//;

interface Findings {
  readonly file: string;
  /** Every word of every string, for the self-checks. */
  readonly words: string[];
  /** Words that name a credential, as `file:line word`. */
  readonly credentialWords: string[];
  /** Environment variables read by name, as `name`. */
  readonly envNames: string[];
  /** Secret-shaped names in a string or a property access, as `file name`. */
  readonly secretNames: string[];
  /** Functions that read a run-time-chosen variable or the whole environment, as `file function`. */
  readonly runtimeEnvReads: string[];
  readonly generatedRoleText: boolean;
}

function wordsOf(text: string): string[] {
  return text
    .split(/[\s`'"(),;|<>{}[\]=]+/)
    .map((word) => word.replace(/\\/g, "/").replace(/[.,:!?]+$/, ""))
    .filter((word) => word !== "");
}

function isCredentialWord(word: string): boolean {
  const base = word.slice(word.lastIndexOf("/") + 1).toLowerCase();
  return CREDENTIAL_FILE_NAMES.has(base) || CREDENTIAL_MARKERS.some((marker) => marker.test(word));
}

/** `process.env`, `deps.env`, `deps.redactEnv`, a local `env`, and the same behind `??`, `as` or parentheses. */
function isEnvironment(node: ts.Node): boolean {
  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node) || ts.isSatisfiesExpression(node)) {
    return isEnvironment(node.expression);
  }
  if (ts.isBinaryExpression(node)) {
    const operator = node.operatorToken.kind;
    return (operator === ts.SyntaxKind.QuestionQuestionToken || operator === ts.SyntaxKind.BarBarToken) && (isEnvironment(node.left) || isEnvironment(node.right));
  }
  if (ts.isIdentifier(node)) return node.text === "env";
  if (ts.isPropertyAccessExpression(node)) return /^(env|\w*Env)$/.test(node.name.text);
  if (ts.isElementAccessExpression(node)) return ts.isStringLiteralLike(node.argumentExpression) && node.argumentExpression.text === "env";
  return false;
}

/** Calls that read every variable of what they are given. */
const WHOLE_ENV_CALLS = /^(Object\.(keys|values|entries|getOwnPropertyNames|assign)|JSON\.stringify|console\.\w+|(util\.)?inspect)$/;

function functionOf(node: ts.Node): string {
  for (let at = node.parent; at !== undefined; at = at.parent) {
    if ((ts.isFunctionDeclaration(at) || ts.isMethodDeclaration(at)) && at.name !== undefined) return at.name.getText();
    if ((ts.isArrowFunction(at) || ts.isFunctionExpression(at)) && (ts.isVariableDeclaration(at.parent) || ts.isPropertyAssignment(at.parent))) {
      return at.parent.name.getText();
    }
  }
  return "(module)";
}

function scan(file: string, text: string): Findings {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const generatedRoleText = GENERATED_ROLE_TEXT.test(text);
  const findings: Findings = { file, words: [], credentialWords: [], envNames: [], secretNames: [], runtimeEnvReads: [], generatedRoleText };
  const lineOf = (node: ts.Node): number => source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
  const secretShaped = (name: string): boolean => UPPER_NAME.test(name) && SECRET_NAME.test(name);

  const visit = (node: ts.Node): void => {
    // 1. Strings, template pieces included.
    if (ts.isStringLiteralLike(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
      if (ts.isStringLiteralLike(node) && secretShaped(node.text)) findings.secretNames.push(`${file} ${node.text}`);
      if (!generatedRoleText) {
        for (const word of wordsOf(node.text)) {
          findings.words.push(word);
          if (isCredentialWord(word)) findings.credentialWords.push(`${file}:${lineOf(node)} ${word}`);
        }
      }
    }

    // 2. Reads by name: `env.NAME`, `env["NAME"]`, `const { NAME } = env`.
    if (ts.isPropertyAccessExpression(node)) {
      if (secretShaped(node.name.text)) findings.secretNames.push(`${file} ${node.name.text}`);
      if (isEnvironment(node.expression)) findings.envNames.push(node.name.text);
    }
    if (ts.isElementAccessExpression(node) && isEnvironment(node.expression)) {
      if (ts.isStringLiteralLike(node.argumentExpression)) findings.envNames.push(node.argumentExpression.text);
      else findings.runtimeEnvReads.push(`${file} ${functionOf(node)}`);
    }
    if (ts.isVariableDeclaration(node) && ts.isObjectBindingPattern(node.name) && node.initializer !== undefined && isEnvironment(node.initializer)) {
      for (const element of node.name.elements) {
        if (element.dotDotDotToken !== undefined) findings.runtimeEnvReads.push(`${file} ${functionOf(node)}`);
        else findings.envNames.push((element.propertyName ?? element.name).getText(source));
      }
    }

    // 3. The whole environment: spread, enumerated, printed or walked.
    if ((ts.isSpreadElement(node) || ts.isSpreadAssignment(node)) && isEnvironment(node.expression)) {
      findings.runtimeEnvReads.push(`${file} ${functionOf(node)}`);
    }
    if (ts.isCallExpression(node) && WHOLE_ENV_CALLS.test(node.expression.getText(source)) && node.arguments.some(isEnvironment)) {
      findings.runtimeEnvReads.push(`${file} ${functionOf(node)}`);
    }
    if (ts.isForInStatement(node) && isEnvironment(node.expression)) findings.runtimeEnvReads.push(`${file} ${functionOf(node)}`);

    ts.forEachChild(node, visit);
  };
  visit(source);
  return findings;
}

/** Every `.ts` file the server bundle is built from, keyed relative to `plugin/`. */
function serverSources(): { file: string; text: string }[] {
  const paths = [join(PLUGIN_DIR, "index.server.ts")];
  for (const dir of ["server", "shared"]) {
    for (const name of readdirSync(join(PLUGIN_DIR, dir), { encoding: "utf8", recursive: true })) {
      if (name.endsWith(".ts")) paths.push(join(PLUGIN_DIR, dir, name));
    }
  }
  return paths.sort().map((path) => ({ file: relative(PLUGIN_DIR, path).split(sep).join("/"), text: readFileSync(path, "utf8") }));
}

const SCANNED: readonly Findings[] = serverSources().map(({ file, text }) => scan(file, text));

const all = <K extends Exclude<keyof Findings, "file" | "generatedRoleText">>(key: K): string[] => SCANNED.flatMap((findings) => findings[key]);
const unique = (values: readonly string[]): string[] => [...new Set(values)].sort();
const findingsOf = (file: string): Findings => {
  const found = SCANNED.find((findings) => findings.file === file);
  if (found === undefined) throw new Error(`${file} was not scanned`);
  return found;
};

describe("the scan itself", () => {
  it("parses every module the server bundle is built from", () => {
    const files = SCANNED.map((findings) => findings.file);
    expect(files.length).toBeGreaterThan(50);
    expect(files).toEqual(expect.arrayContaining(["index.server.ts", "server/collector.ts", "server/data-home.ts", "shared/contracts.ts"]));
  });

  it("sees the words product code builds paths from, not only the ones this file writes", () => {
    // `data-home.ts` keeps the data folder out of the agents' homes. If the
    // word scan were broken, this list would be empty and the credential test
    // below would pass vacuously.
    expect(findingsOf("server/data-home.ts").words).toEqual(expect.arrayContaining([".paseo", ".claude", ".codex"]));
  });

  it("keeps the generated role text, and only it, out of the word scan", () => {
    expect(SCANNED.filter((findings) => findings.generatedRoleText).map((findings) => findings.file)).toEqual([
      "server/manager-instructions.ts",
      "server/orchestrator-instructions.ts",
      "server/reviewer-instructions.ts",
      "server/worker-instructions.ts",
    ]);
  });
});

describe("what the server's source names", () => {
  it("names no credential file and no secret store", () => {
    expect(all("credentialWords")).toEqual([]);
  });
});

describe("what the server reads from the environment", () => {
  it("reads no variable shaped like a secret by name", () => {
    expect(unique(all("envNames")).filter((name) => SECRET_NAME.test(name))).toEqual([]);
  });

  it("reads only the variables on the allow list by name", () => {
    expect(unique(all("envNames"))).toEqual(ENV_NAMES_READ);
  });

  it("names a secret-shaped variable only in the redaction list", () => {
    // The two daemon passwords are read to be masked, never to be used.
    expect(SECRET_ENV_VARS).toEqual(["PASEO_PASSWORD", "PASEO_DAEMON_PASSWORD"]);
    expect(unique(all("secretNames"))).toEqual(unique(SECRET_ENV_VARS.map((name) => `server/collector.ts ${name}`)));
  });

  it("reads a run-time-chosen variable or the whole environment only where allowed", () => {
    expect(unique(all("runtimeEnvReads"))).toEqual(Object.keys(RUNTIME_ENV_READS).sort());
  });
});

describe("the guard fails when it should", () => {
  /**
   * What a careless change would add to a server module. Both detectors must
   * fire on it — this is what makes the tests above evidence.
   */
  const PLANTED = scan(
    "server/planted.ts",
    `
import { readFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

export function plantedCredentialReads(): string {
  const codex = readFileSync(join(homedir(), ".codex", "auth.json"), "utf8");
  const claude = readFileSync(\`\${homedir()}/.claude/.credentials.json\`, "utf8");
  execFile("security", ["find-generic-password", "-s", "Claude Code-credentials", "-w"], () => undefined);
  return codex + claude;
}

export function plantedEnvironmentReads(env: NodeJS.ProcessEnv): string[] {
  const NAME = "GITHUB_TOKEN";
  const { OPENAI_API_KEY } = process.env;
  return [process.env.ANTHROPIC_API_KEY ?? "", OPENAI_API_KEY ?? "", env[NAME] ?? "", JSON.stringify(Object.entries(env))];
}
`,
  );

  it("catches a read of an agent's credential file or keychain entry", () => {
    expect(PLANTED.credentialWords.map((found) => found.slice(found.indexOf(" ") + 1))).toEqual([
      "auth.json",
      "/.claude/.credentials.json",
      "find-generic-password",
    ]);
  });

  it("catches a secret environment value read by name, through a constant, or with the whole environment", () => {
    expect(unique(PLANTED.envNames)).toEqual(["ANTHROPIC_API_KEY", "OPENAI_API_KEY"]);
    expect(unique(PLANTED.secretNames)).toEqual(["server/planted.ts ANTHROPIC_API_KEY", "server/planted.ts GITHUB_TOKEN"]);
    expect(unique(PLANTED.runtimeEnvReads)).toEqual(["server/planted.ts plantedEnvironmentReads"]);
  });
});

describe("what the collector writes", () => {
  const WS = "wks_1";
  /** The plugin's own secrets, which redaction must mask wherever they appear. */
  const DAEMON_SECRETS = { PASEO_PASSWORD: "planted-paseo-password-4f9c", PASEO_DAEMON_PASSWORD: "planted-daemon-password-7b21" };
  /** Values after a password-shaped flag in a command an agent ran. */
  const FLAG_SECRETS = ["planted-flag-password-19e0", "planted-flag-token-c3d8", "planted-flag-secret-55aa"];
  /** A key from the agent's own world — its environment, a tool's output, its system prompt — which no trace field copies. */
  const AGENT_SECRET = "planted-agent-api-key-e6b0";

  let home: string;
  let location: { tracesDir: string };

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "bm-credentials-"));
    location = { tracesDir: join(home, "traces") };
    clearStartMarks();
    clearTraceStoreCache();
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  function plantedItems(turnId: string): unknown[] {
    const { PASEO_PASSWORD, PASEO_DAEMON_PASSWORD } = DAEMON_SECRETS;
    const [password, token, secret] = FLAG_SECRETS;
    const call = (callId: string, name: string, detail: Record<string, unknown>) => ({ type: "tool_call", callId, name, status: "completed", error: null, detail });
    return [
      { type: "user_message", text: `Log in with ${PASEO_PASSWORD}, then ${PASEO_DAEMON_PASSWORD}. visible-${turnId}`, clientMessageId: "m-1" },
      call("c1", "Bash", {
        type: "shell",
        command: `paseo daemon status --password ${password} --token=${token} --secret "${secret}" && echo ${PASEO_PASSWORD}`,
        cwd: `/Users/test/${PASEO_DAEMON_PASSWORD}/repo`,
        output: `ANTHROPIC_API_KEY=${AGENT_SECRET}`,
        exitCode: 0,
      }),
      call("c2", "Read", { type: "read", filePath: "notes.txt", content: `API_KEY=${AGENT_SECRET}` }),
      call("c4", "Write", { type: "write", filePath: `notes-${PASEO_PASSWORD}.txt`, content: AGENT_SECRET }),
      call("c3", "Task", { type: "sub_agent", subAgentType: "general", description: `check ${PASEO_DAEMON_PASSWORD}`, log: AGENT_SECRET }),
      { type: "assistant_message", text: `Done with ${PASEO_PASSWORD} and ${PASEO_DAEMON_PASSWORD}.` },
    ];
  }

  function plantedTurn(turnId: string) {
    const agent = { id: "agent-worker", workspaceId: WS, parentAgentId: "agent-manager", provider: "bm-worker/claude-opus-5", cwd: "/Users/test/repo", title: "Beads Worker" };
    // The hooks are typed against Paseo's event shape; the fake is structurally close enough.
    return { agent, turnId, outcome: { kind: "completed" }, timeline: plantedItems(turnId) } as never;
  }

  /** A daemon whose refetch returns the turn plus a snapshot carrying the agent's secret in fields no record has. */
  function refetching(turnId: string): CollectorPaseo {
    const refetch = async () => ({
      entries: plantedItems(turnId).map((item, index) => ({ turnId, timestamp: `2026-09-30T10:00:0${index}.000Z`, item })),
      agent: {
        model: "claude-opus-5",
        labels: { "bm.requestId": "req-planted", "bm.note": AGENT_SECRET },
        env: { ANTHROPIC_API_KEY: AGENT_SECRET },
        persistence: { metadata: { systemPrompt: `Use ${AGENT_SECRET}.` } },
        lastUsage: { inputTokens: 10, outputTokens: 5 },
      },
    });
    return { agents: { ref: () => ({ timeline: { refetch } }) } };
  }

  function filesWritten(): { path: string; text: string }[] {
    return readdirSync(home, { encoding: "utf8", recursive: true })
      .map((name) => join(home, name))
      .filter((path) => statSync(path).isFile())
      .map((path) => ({ path: relative(home, path).split(sep).join("/"), text: readFileSync(path, "utf8") }));
  }

  it("writes no planted secret, whether the turn came from the hook payload or a refetch", async () => {
    const env = { ...DAEMON_SECRETS } as NodeJS.ProcessEnv;
    const now = () => new Date("2026-09-30T10:00:00.000Z");
    expect(await collectTurnEnded(plantedTurn("turn-1"), { location, env, now })).toBe(true);
    expect(await collectTurnEnded(plantedTurn("turn-2"), { location, env, now, paseo: refetching("turn-2") })).toBe(true);

    // The search sees what the collector wrote: both records, their messages
    // and the masks that replaced each secret.
    expect(readRecords(location, WS).records).toHaveLength(2);
    const written = filesWritten();
    expect(written.map((file) => file.path).sort()).toEqual(["traces/meta.json", `traces/${WS}/events-202609.jsonl`, `traces/${WS}/meta.json`]);
    const everything = written.map((file) => file.text).join("\n");
    expect(everything).toContain("visible-turn-1");
    expect(everything).toContain("visible-turn-2");
    expect(everything).toContain(REDACTED);

    for (const secret of [...Object.values(DAEMON_SECRETS), ...FLAG_SECRETS, AGENT_SECRET]) {
      expect(written.filter((file) => file.text.includes(secret)).map((file) => `${file.path} holds ${secret}`)).toEqual([]);
    }
  });
});
