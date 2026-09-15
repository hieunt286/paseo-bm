import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FsOps } from "../src/fsops.js";
import { createFsOps } from "../src/fsops.js";
import { PathGuardError } from "../src/paths-guard.js";
import type { InstallRecord } from "../src/record.js";
import {
  RECORD_SCHEMA_VERSION,
  ROLE_NAMES,
  RecordError,
  createRecord,
  isInstallRecord,
  isRecordError,
  parseRecord,
  readRecord,
  recordPath,
  resolveRecordedPath,
  roleId,
  serializeRecord,
  touchRecord,
  validateRecord,
  withCreatedConfigContainers,
  writeRecord,
} from "../src/record.js";

let scratch: string;
let root: string;
let fsops: FsOps;

beforeEach(() => {
  // Not realpath'ed on purpose: `os.tmpdir()` is behind /var -> /private/var on
  // macOS and the record must survive that, like every other write path does.
  scratch = mkdtempSync(join(tmpdir(), "paseo-bm-record-"));
  root = join(scratch, ".paseo-bm");
  fsops = createFsOps({ root });
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

/**
 * A record with every field of Design §3.2 populated with a distinguishable
 * value, so a round trip that drops or confuses one is visible.
 */
function fullRecord(overrides: Partial<InstallRecord> = {}): InstallRecord {
  return {
    schemaVersion: RECORD_SCHEMA_VERSION,
    version: "0.1.0-alpha.0",
    installedAt: "2026-09-15T10:15:00.000Z",
    updatedAt: "2026-09-15T11:30:00.500Z",
    installHome: "/home/user/.paseo-bm",
    paseo: {
      home: "/home/user/.paseo",
      pluginId: "paseo-bm",
      pluginDir: "/home/user/.paseo-bm/plugin/0.1.0",
      pluginsEnabledSetByUs: true,
      mcpInject: { setByUs: true, previous: { present: true, value: false } },
    },
    roles: [
      {
        role: "manager",
        providerId: "bm-manager",
        profileId: "bm-manager",
        baseProvider: "claude",
        model: "claude-opus-5",
        modeId: "default",
        thinkingOptionId: "high",
        paseoTools: true,
      },
      {
        role: "worker",
        providerId: "bm-worker",
        profileId: "bm-worker",
        baseProvider: "codex",
        model: "gpt-5.6-sol",
        modeId: null,
        thinkingOptionId: null,
        paseoTools: true,
      },
      {
        role: "reviewer",
        providerId: "bm-reviewer",
        profileId: "bm-reviewer",
        baseProvider: "claude",
        model: "claude-sonnet-5",
        modeId: "plan",
        thinkingOptionId: null,
        paseoTools: false,
      },
    ],
    files: [
      {
        path: "plugin/0.1.0/index.server.js",
        sha256: "a".repeat(64),
        mode: 0o600,
      },
      {
        path: "plugin/0.1.0/roles/worker.md",
        sha256: "0123456789abcdef".repeat(4),
        mode: 0o600,
      },
    ],
    versions: [
      { version: "0.0.9", dir: "plugin/0.0.9", installedAt: "2026-09-01T00:00:00.000Z", active: false },
      { version: "0.1.0", dir: "plugin/0.1.0", installedAt: "2026-09-15T10:15:00.000Z", active: true },
    ],
    backups: [
      { at: "2026-09-15T10:14:59.000Z", dir: "backups/20260915T101459Z", reason: "paseo config.json before role registration" },
    ],
    skills: {
      agents: ["claude", "codex"],
      lastStatus: [
        { agent: "claude", skill: "feature-workflow", present: true },
        { agent: "codex", skill: "implementing-beads", present: false },
      ],
      assistDeclinedAt: "2026-09-15T11:00:00.000Z",
      lastCommand: "npx -y skills add cuongntr/agent-skills --agent claude",
      assistOutcome: "failed",
    },
    ...overrides,
  };
}

/** Every key path present in a JSON value, e.g. `paseo.mcpInject.previous.value`. */
function keyPaths(value: unknown, prefix = ""): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((entry) => keyPaths(entry, `${prefix}[]`));
  }
  if (typeof value !== "object" || value === null) {
    return [];
  }
  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) => {
    const path = prefix === "" ? key : `${prefix}.${key}`;
    return [path, ...keyPaths(child, path)];
  });
}

describe("role identity", () => {
  it("names the three roles and derives their bm- ids", () => {
    expect(ROLE_NAMES).toEqual(["manager", "worker", "reviewer"]);
    expect(ROLE_NAMES.map(roleId)).toEqual(["bm-manager", "bm-worker", "bm-reviewer"]);
  });
});

describe("write then read", () => {
  it("round-trips every field, including roles[] and mcpInject.previous", async () => {
    const record = fullRecord();
    const write = await writeRecord(fsops, record);
    expect(write.outcome).toBe("created");

    const read = await readRecord(fsops);
    expect(read).toEqual(record);
    expect(read?.roles).toHaveLength(3);
    expect(read?.roles.map((role) => role.role)).toEqual(["manager", "worker", "reviewer"]);
    expect(read?.roles[2]).toEqual(record.roles[2]);
    expect(read?.paseo.mcpInject.previous).toEqual({ present: true, value: false });
  });

  it("keeps 'the key was absent' distinct from 'the key was false'", async () => {
    const absent = fullRecord({
      paseo: { ...fullRecord().paseo, mcpInject: { setByUs: true, previous: { present: false, value: null } } },
    });
    await writeRecord(fsops, absent);
    const readAbsent = await readRecord(fsops);
    expect(readAbsent?.paseo.mcpInject.previous).toEqual({ present: false, value: null });

    const wasFalse = fullRecord();
    await writeRecord(fsops, wasFalse);
    const readFalse = await readRecord(fsops);
    expect(readFalse?.paseo.mcpInject.previous).toEqual({ present: true, value: false });

    // The two states must not serialize to the same bytes, or an uninstall
    // cannot tell which one it has to restore (ADR-006 decision 8).
    expect(serializeRecord(absent)).not.toBe(serializeRecord(wasFalse));
  });

  it("writes into the install home at mode 0600 and adds a trailing newline", async () => {
    const write = await writeRecord(fsops, fullRecord());
    expect(write.path).toBe(recordPath(fsops.root));
    expect(statSync(write.path).mode & 0o777).toBe(0o600);
    expect(readFileSync(write.path, "utf8").endsWith("}\n")).toBe(true);
  });

  it("does not rewrite the file when the record is unchanged", async () => {
    const record = fullRecord();
    await writeRecord(fsops, record);
    const again = await writeRecord(fsops, record);
    expect(again.outcome).toBe("unchanged");
    expect(again.rewritten).toBe(false);
  });

  it("reports no record rather than an empty one when the file is absent", async () => {
    expect(await readRecord(fsops)).toBeUndefined();
  });

  it("serializes deterministically in the field order of Design §3.2", () => {
    const text = serializeRecord(fullRecord());
    expect(text).toBe(serializeRecord(parseRecord(text)));
    expect(Object.keys(JSON.parse(text) as object)).toEqual([
      "schemaVersion",
      "version",
      "installedAt",
      "updatedAt",
      "installHome",
      "paseo",
      "roles",
      "files",
      "versions",
      "backups",
      "skills",
    ]);
  });
});

describe("the record carries no secret", () => {
  /** Exactly the field paths Design §3.2 defines. Nothing else may be written. */
  const ALLOWED_PATHS = new Set([
    "schemaVersion",
    "version",
    "installedAt",
    "updatedAt",
    "installHome",
    "paseo",
    "paseo.home",
    "paseo.pluginId",
    "paseo.pluginDir",
    "paseo.pluginsEnabledSetByUs",
    "paseo.mcpInject",
    "paseo.mcpInject.setByUs",
    "paseo.mcpInject.previous",
    "paseo.mcpInject.previous.present",
    "paseo.mcpInject.previous.value",
    "roles",
    "roles[].role",
    "roles[].providerId",
    "roles[].profileId",
    "roles[].baseProvider",
    "roles[].model",
    "roles[].modeId",
    "roles[].thinkingOptionId",
    "roles[].paseoTools",
    "files",
    "files[].path",
    "files[].sha256",
    "files[].mode",
    "versions",
    "versions[].version",
    "versions[].dir",
    "versions[].installedAt",
    "versions[].active",
    "backups",
    "backups[].at",
    "backups[].dir",
    "backups[].reason",
    "skills",
    "skills.agents",
    "skills.lastStatus",
    "skills.lastStatus[].agent",
    "skills.lastStatus[].skill",
    "skills.lastStatus[].present",
    "skills.assistDeclinedAt",
    "skills.lastCommand",
    "skills.assistOutcome",
  ]);

  it("writes only the fields of the schema, so nothing else can leak in", () => {
    const written = JSON.parse(serializeRecord(fullRecord())) as unknown;
    expect(new Set(keyPaths(written))).toEqual(ALLOWED_PATHS);
  });

  it("drops credential-shaped keys attached to a record in memory", async () => {
    const poisoned = {
      ...fullRecord(),
      token: "ghp_SUPERSECRET",
      env: { ANTHROPIC_API_KEY: "sk-ant-SUPERSECRET" },
      paseo: {
        ...fullRecord().paseo,
        password: "hunter2",
        apiKey: "sk-SUPERSECRET",
      },
      roles: fullRecord().roles.map((role) => ({ ...role, authToken: "sk-SUPERSECRET" })),
    } as unknown as InstallRecord;

    await writeRecord(fsops, poisoned);
    const text = readFileSync(recordPath(fsops.root), "utf8");

    expect(text).not.toContain("SUPERSECRET");
    expect(text).not.toContain("hunter2");
    for (const key of ["token", "password", "apiKey", "authToken", "env", "ANTHROPIC_API_KEY"]) {
      expect(text).not.toContain(key);
    }
    expect(new Set(keyPaths(JSON.parse(text)))).toEqual(ALLOWED_PATHS);
  });
});

describe("a schema newer than this build", () => {
  it("refuses schemaVersion 2 with the upgrade diagnostic", async () => {
    const future = { ...fullRecord(), schemaVersion: 2, newField: "who knows" };
    mkdirSync(root, { recursive: true, mode: 0o700 });
    writeFileSync(recordPath(fsops.root), `${JSON.stringify(future, null, 2)}\n`, { mode: 0o600 });

    const error = await readRecord(fsops).then(
      () => undefined,
      (caught: unknown) => caught,
    );

    expect(isRecordError(error)).toBe(true);
    const recordError = error as RecordError;
    expect(recordError.reason).toBe("schema-too-new");
    expect(recordError.code).toBe("E_RECORD_SCHEMA_TOO_NEW");
    expect(recordError.foundSchemaVersion).toBe(2);
    expect(recordError.field).toBe("schemaVersion");
    expect(recordError.path).toBe(recordPath(fsops.root));
    expect(recordError.message).toContain("schemaVersion 2");
    expect(recordError.message).toContain("npx paseo-bm@latest");
    expect(recordError.remediation).toContain("Upgrade paseo-bm");
  });

  it("leaves the newer record on disk exactly as it was", async () => {
    const future = `${JSON.stringify({ ...fullRecord(), schemaVersion: 7 }, null, 2)}\n`;
    mkdirSync(root, { recursive: true, mode: 0o700 });
    writeFileSync(recordPath(fsops.root), future, { mode: 0o600 });

    await expect(readRecord(fsops)).rejects.toThrow(RecordError);
    expect(readFileSync(recordPath(fsops.root), "utf8")).toBe(future);
  });

  it("still accepts the version this build writes", () => {
    expect(validateRecord({ ...fullRecord(), schemaVersion: 1 }).schemaVersion).toBe(1);
  });
});

describe("a damaged record", () => {
  it("reports unparseable JSON without overwriting it", async () => {
    const garbage = '{"schemaVersion": 1, "version": "0.1.0", oops';
    mkdirSync(root, { recursive: true, mode: 0o700 });
    writeFileSync(recordPath(fsops.root), garbage, { mode: 0o600 });

    const error = await readRecord(fsops).then(
      () => undefined,
      (caught: unknown) => caught,
    );

    expect(isRecordError(error)).toBe(true);
    expect((error as RecordError).reason).toBe("not-json");
    expect((error as RecordError).path).toBe(recordPath(fsops.root));
    expect((error as RecordError).message).toContain("is not valid JSON");
    // The whole point: a broken record is evidence, not garbage to replace.
    expect(readFileSync(recordPath(fsops.root), "utf8")).toBe(garbage);
  });

  it("names the field that is wrong instead of guessing a value", () => {
    const missingModel = fullRecord();
    const broken = {
      ...missingModel,
      roles: [{ ...missingModel.roles[0], model: 42 }],
    };
    const error = (() => {
      try {
        validateRecord(broken, { path: "/tmp/install.json" });
        return undefined;
      } catch (caught) {
        return caught as RecordError;
      }
    })();

    expect(error?.reason).toBe("invalid");
    expect(error?.field).toBe("roles[0].model");
    expect(error?.code).toBeUndefined();
    expect(error?.message).toContain("/tmp/install.json");
    expect(error?.message).toContain("roles[0].model must be a non-empty string");
  });

  it("refuses a top-level value that is not an object", () => {
    expect(() => parseRecord("[]")).toThrow(/must be an object/);
    expect(() => parseRecord("null")).toThrow(/must be an object/);
  });

  it("never replaces a good record with an invalid one", async () => {
    const good = fullRecord();
    await writeRecord(fsops, good);
    const before = readFileSync(recordPath(fsops.root), "utf8");

    const bad = { ...good, installHome: "relative/path" } as InstallRecord;
    await expect(writeRecord(fsops, bad)).rejects.toThrow(/installHome must be an absolute path/);
    expect(readFileSync(recordPath(fsops.root), "utf8")).toBe(before);
  });

  it.each([
    [
      "an mcpInject state that claims absent and holds a value",
      { paseo: { ...fullRecord().paseo, mcpInject: { setByUs: true, previous: { present: false, value: false } } } },
      /an absent key must record `value: null`/,
    ],
    [
      "an mcpInject state that claims present with no value",
      { paseo: { ...fullRecord().paseo, mcpInject: { setByUs: false, previous: { present: true, value: null } } } },
      /says the key was present but records no value/,
    ],
    [
      "a role that is not one of the three",
      { roles: [{ ...fullRecord().roles[0], role: "architect" }] },
      /roles\[0\]\.role must be one of manager, worker, reviewer/,
    ],
    [
      "the same role twice",
      { roles: [fullRecord().roles[0], { ...fullRecord().roles[0], providerId: "bm-manager-2" }] },
      /repeats manager/,
    ],
    [
      "two active versions",
      {
        versions: [
          { version: "0.0.9", dir: "plugin/0.0.9", installedAt: "2026-09-01T00:00:00.000Z", active: true },
          { version: "0.1.0", dir: "plugin/0.1.0", installedAt: "2026-09-15T10:15:00.000Z", active: true },
        ],
      },
      /marks 2 versions active/,
    ],
    [
      "a recorded file outside the install home",
      { files: [{ path: "/etc/passwd", sha256: "a".repeat(64), mode: 0o600 }] },
      /must be relative to the install home/,
    ],
    [
      "a recorded file escaping through ..",
      { files: [{ path: "plugin/../../.ssh/id_rsa", sha256: "a".repeat(64), mode: 0o600 }] },
      /must stay inside the install home/,
    ],
    [
      "a hash that is not a sha256",
      { files: [{ path: "plugin/0.1.0/x.js", sha256: "A".repeat(64), mode: 0o600 }] },
      /must be 64 lowercase hex characters/,
    ],
    [
      "permission bits that are not permission bits",
      { files: [{ path: "plugin/0.1.0/x.js", sha256: "a".repeat(64), mode: 99999 }] },
      /must be permission bits between 0 and 4095/,
    ],
    ["a timestamp that is not ISO 8601 UTC", { updatedAt: "15/09/2026" }, /must be an ISO 8601 UTC timestamp/],
    ["a local-time timestamp", { installedAt: "2026-09-15T10:15:00+07:00" }, /must be an ISO 8601 UTC timestamp/],
    [
      "an unknown skills assist outcome",
      { skills: { ...fullRecord().skills, assistOutcome: "cancelled" } },
      /must be null or one of ok, failed, interrupted/,
    ],
    ["a missing paseo section", { paseo: undefined }, /paseo must be an object/],
    ["roles that are not a list", { roles: {} }, /roles must be an array/],
  ])("refuses %s", (_label, override, expected) => {
    expect(() => validateRecord({ ...fullRecord(), ...(override as object) })).toThrow(expected);
  });

  it("answers isInstallRecord without raising", () => {
    expect(isInstallRecord(fullRecord())).toBe(true);
    expect(isInstallRecord({ schemaVersion: 1 })).toBe(false);
    expect(isInstallRecord("install.json")).toBe(false);
  });
});

describe("tolerated shapes", () => {
  it("ignores unknown keys inside a schema-1 record and drops them on the next write", () => {
    const text = JSON.stringify({ ...fullRecord(), futureKey: "ignored" });
    const parsed = parseRecord(text);
    expect(parsed).toEqual(fullRecord());
    expect(serializeRecord(parsed)).not.toContain("futureKey");
  });

  it("reads a missing optional as null", () => {
    const record = fullRecord();
    const sparse = {
      ...record,
      paseo: { ...record.paseo, pluginId: null, pluginDir: null },
      roles: [{ ...record.roles[0], modeId: null, thinkingOptionId: null }],
      skills: { ...record.skills, assistDeclinedAt: null, lastCommand: null, assistOutcome: null },
    };
    const parsed = parseRecord(JSON.stringify(sparse));
    expect(parsed.paseo.pluginId).toBeNull();
    expect(parsed.roles[0]?.modeId).toBeNull();
    expect(parsed.skills.assistOutcome).toBeNull();
  });
});

describe("createRecord and touchRecord", () => {
  it("starts out owning nothing and never claiming it set the MCP switch", () => {
    const record = createRecord({
      version: "0.1.0",
      installHome: root,
      paseo: { home: "/home/user/.paseo" },
      at: "2026-09-15T12:00:00.000Z",
    });

    expect(record.schemaVersion).toBe(RECORD_SCHEMA_VERSION);
    expect(record.installedAt).toBe("2026-09-15T12:00:00.000Z");
    expect(record.updatedAt).toBe(record.installedAt);
    expect(record.files).toEqual([]);
    expect(record.versions).toEqual([]);
    expect(record.backups).toEqual([]);
    expect(record.roles).toEqual([]);
    expect(record.paseo.pluginsEnabledSetByUs).toBe(false);
    expect(record.paseo.mcpInject).toEqual({ setByUs: false, previous: { present: false, value: null } });
    expect(record.skills).toEqual({
      agents: [],
      lastStatus: [],
      assistDeclinedAt: null,
      lastCommand: null,
      assistOutcome: null,
    });
  });

  it("survives a round trip through the file", async () => {
    const record = createRecord({ version: "0.1.0", installHome: root, paseo: { home: "/home/user/.paseo" } });
    await writeRecord(fsops, record);
    expect(await readRecord(fsops)).toEqual(record);
  });

  it("moves updatedAt only", () => {
    const record = fullRecord();
    const touched = touchRecord(record, "2026-09-16T00:00:00.000Z");
    expect(touched.updatedAt).toBe("2026-09-16T00:00:00.000Z");
    expect(touched.installedAt).toBe(record.installedAt);
    expect(touched.files).toEqual(record.files);
  });
});

describe("pluginsEnabledPrevious and createdConfigContainers (bm-tm2)", () => {
  const withNewFields = (): InstallRecord =>
    fullRecord({
      paseo: {
        ...fullRecord().paseo,
        pluginsEnabledPrevious: { present: false, value: null },
        createdConfigContainers: ["agents", "agents.providers", "daemon.mcp"],
      },
    });

  it("round-trips both optional fields and writes them in place", async () => {
    const record = withNewFields();
    await writeRecord(fsops, record);
    const read = await readRecord(fsops);

    expect(read).toEqual(record);
    expect(read?.paseo.pluginsEnabledPrevious).toEqual({ present: false, value: null });
    expect(read?.paseo.createdConfigContainers).toEqual(["agents", "agents.providers", "daemon.mcp"]);
    const paseo = (JSON.parse(serializeRecord(record)) as { paseo: object }).paseo;
    expect(Object.keys(paseo)).toEqual([
      "home",
      "pluginId",
      "pluginDir",
      "pluginsEnabledSetByUs",
      "pluginsEnabledPrevious",
      "mcpInject",
      "createdConfigContainers",
    ]);
  });

  it("keeps 'pluginsEnabled was absent' distinct from 'it was false'", () => {
    const absent = serializeRecord(withNewFields());
    const wasFalse = serializeRecord(
      fullRecord({ paseo: { ...withNewFields().paseo, pluginsEnabledPrevious: { present: true, value: false } } }),
    );
    expect(absent).not.toBe(wasFalse);
    expect(parseRecord(wasFalse).paseo.pluginsEnabledPrevious).toEqual({ present: true, value: false });
  });

  it("reads a record written before bm-tm2 and serializes it byte for byte as before", () => {
    const old = serializeRecord(fullRecord());
    const parsed = parseRecord(old);

    expect(parsed.paseo.pluginsEnabledPrevious).toBeUndefined();
    expect(parsed.paseo.createdConfigContainers).toBeUndefined();
    expect(serializeRecord(parsed)).toBe(old);
    expect(old).not.toContain("pluginsEnabledPrevious");
    expect(old).not.toContain("createdConfigContainers");
  });

  it("refuses a container outside the closed set, naming the field", () => {
    const text = serializeRecord(withNewFields()).replace('"daemon.mcp"', '"plugins"');
    const error = (() => {
      try {
        parseRecord(text);
        return undefined;
      } catch (caught) {
        return caught as RecordError;
      }
    })();
    expect(isRecordError(error)).toBe(true);
    expect(error?.field).toBe("paseo.createdConfigContainers[2]");
  });

  it("refuses a pluginsEnabledPrevious that is absent and valued at once", () => {
    const value = JSON.parse(serializeRecord(withNewFields())) as { paseo: Record<string, unknown> };
    value.paseo["pluginsEnabledPrevious"] = { present: false, value: false };
    expect(() => validateRecord(value)).toThrow(/paseo\.pluginsEnabledPrevious says the key was absent/);
  });

  it("merges created containers without ever dropping one, in canonical order", () => {
    const base = fullRecord();
    const first = withCreatedConfigContainers(base, ["daemon.mcp", "daemon"], "2026-09-16T00:00:00.000Z");
    expect(first.paseo.createdConfigContainers).toEqual(["daemon", "daemon.mcp"]);
    expect(first.updatedAt).toBe("2026-09-16T00:00:00.000Z");

    const second = withCreatedConfigContainers(first, ["agents"], "2026-09-17T00:00:00.000Z");
    expect(second.paseo.createdConfigContainers).toEqual(["agents", "daemon", "daemon.mcp"]);

    // Nothing new (including an empty list): the very same object comes back.
    expect(withCreatedConfigContainers(second, ["daemon"])).toBe(second);
    expect(withCreatedConfigContainers(base, [])).toBe(base);
  });
});

describe("resolveRecordedPath", () => {
  it("rebuilds an absolute path under the install home", () => {
    expect(resolveRecordedPath("/home/user/.paseo-bm", "plugin/0.1.0/roles/worker.md")).toBe(
      "/home/user/.paseo-bm/plugin/0.1.0/roles/worker.md",
    );
  });

  it("refuses to leave the install home", () => {
    expect(() => resolveRecordedPath("/home/user/.paseo-bm", "../.ssh/id_rsa")).toThrow(PathGuardError);
  });
});
