/**
 * The install planner (bead bm-wp-105-6ec.1).
 *
 * Every scenario runs against a fake `$HOME` under the OS temp directory and
 * with the write-scope guard patched over `node:fs` for the whole planner call.
 * The assertion is not merely "no write escaped the install home" but "the
 * guard saw no write at all": the planner reads, and nothing else.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ConfigAction } from "../src/action.js";
import { FILE_MODE, createFsOps, sha256 } from "../src/fsops.js";
import { createDiskReader } from "../src/ownership.js";
import { createRecord, serializeRecord } from "../src/record.js";
import type { FileRecord, InstallRecord } from "../src/record.js";
import type { InstallPlan, PayloadFile, PlanInstallInput } from "../src/commands/install/planner.js";
import {
  CONSENT_REQUIRED_REASON,
  classifySituation,
  payloadDestination,
  planInstall,
} from "../src/commands/install/planner.js";
import { startWriteScope } from "./helpers/write-scope.js";

const PAYLOAD_V1: Record<string, string> = {
  "paseo-plugin.json": '{ "id": "paseo-bm" }\n',
  "index.server.ts": "export const server = 1;\n",
  "roles/worker.md": "# Worker v1\n",
};
const PAYLOAD_V2: Record<string, string> = {
  "paseo-plugin.json": '{ "id": "paseo-bm" }\n',
  "index.server.ts": "export const server = 2;\n",
  "roles/worker.md": "# Worker v2\n",
};

let fakeHome: string;
let installHome: string;
let paseoHome: string;

beforeEach(() => {
  fakeHome = mkdtempSync(join(tmpdir(), "paseo-bm-planner-"));
  installHome = join(fakeHome, ".paseo-bm");
  paseoHome = join(fakeHome, ".paseo");
  mkdirSync(paseoHome, { recursive: true });
});

afterEach(() => {
  rmSync(fakeHome, { recursive: true, force: true });
});

function manifest(contents: Record<string, string>): PayloadFile[] {
  return Object.entries(contents).map(([path, text]) => ({ path, sha256: sha256(text) }));
}

/** Puts a payload on disk the way the applier would and returns its `files[]` entries. */
function installOnDisk(version: string, contents: Record<string, string>): FileRecord[] {
  return Object.entries(contents).map(([path, text]) => {
    const relative = payloadDestination(version, path);
    writeAt(relative, text);
    return { path: relative, sha256: sha256(text), mode: FILE_MODE };
  });
}

function writeAt(relative: string, text: string): void {
  const absolute = join(installHome, relative);
  mkdirSync(dirname(absolute), { recursive: true, mode: 0o700 });
  writeFileSync(absolute, text, { mode: FILE_MODE });
  chmodSync(absolute, FILE_MODE);
}

function recordFor(version: string, files: readonly FileRecord[]): InstallRecord {
  const base = createRecord({
    version,
    installHome,
    paseo: { home: paseoHome, pluginId: "paseo-bm", pluginDir: join(installHome, "plugin", version) },
    at: "2026-09-15T10:15:00.000Z",
  });
  return {
    ...base,
    files,
    versions: [{ version, dir: `plugin/${version}`, installedAt: "2026-09-15T10:15:00.000Z", active: true }],
  };
}

function writeRecord(record: InstallRecord): void {
  writeAt("install.json", serializeRecord(record));
}

/** Runs the planner with the guard patched over `node:fs` and proves it wrote nothing. */
async function plan(input: Omit<PlanInstallInput, "installHome" | "reader">): Promise<InstallPlan> {
  const scope = startWriteScope({ installHome, paseoHome, watch: [fakeHome] });
  try {
    const reader = createDiskReader({ fsops: createFsOps({ root: fakeHome, fs: scope.fs }), fs: scope.fs });
    const result = await planInstall({ ...input, installHome, reader });
    expect(scope.writes).toEqual([]);
    scope.assertNoViolations();
    return result;
  } finally {
    scope.restore();
  }
}

function byTarget(result: InstallPlan): Record<string, { kind: string; reason: string }> {
  return Object.fromEntries(result.actions.map((action) => [action.target, { kind: action.kind, reason: action.reason }]));
}

describe("planInstall — the four situations on a fake HOME", () => {
  it("fresh install: everything is created and both switches are planned, not performed", async () => {
    const result = await plan({
      version: "0.1.0",
      payload: manifest(PAYLOAD_V1),
      switches: { pluginsEnabled: null, injectIntoAgents: false },
      registration: { dir: null },
    });

    expect(result.situation).toBe("fresh");
    expect(result.installedVersion).toBeNull();
    expect(result.requiresConfirmation).toBe(false);
    expect(byTarget(result)).toEqual({
      "installHome/plugin/0.1.0/paseo-plugin.json": { kind: "create", reason: "missing" },
      "installHome/plugin/0.1.0/index.server.ts": { kind: "create", reason: "missing" },
      "installHome/plugin/0.1.0/roles/worker.md": { kind: "create", reason: "missing" },
      "installHome/install.json": { kind: "create", reason: "missing" },
      "paseoHome/config.json#pluginsEnabled": { kind: "config", reason: CONSENT_REQUIRED_REASON },
      "paseoHome/config.json#daemon.mcp.injectIntoAgents": { kind: "config", reason: CONSENT_REQUIRED_REASON },
      "paseoDaemon/plugins[paseo-bm]": { kind: "create", reason: "missing" },
    });
    const configs = result.actions.filter((action): action is ConfigAction => action.kind === "config");
    expect(configs.map((action) => [action.from, action.to])).toEqual([
      [null, true],
      [false, true],
    ]);
    expect(configs.every((action) => action.consent === undefined)).toBe(true);
    expect(result.conflicts).toEqual([]);
    // Nothing was created by planning: the install home still does not exist.
    expect(result.ownership.every((entry) => !entry.disk.present)).toBe(true);
  });

  it("upgrade: every payload destination is missing in the new version directory, no conflict possible", async () => {
    const record = recordFor("0.1.0", installOnDisk("0.1.0", PAYLOAD_V1));
    writeRecord(record);

    const result = await plan({
      version: "0.2.0",
      payload: manifest(PAYLOAD_V2),
      record,
      switches: { pluginsEnabled: true, injectIntoAgents: true },
      registration: { dir: join(installHome, "plugin", "0.1.0") },
    });

    expect(result.situation).toBe("upgrade");
    expect(result.installedVersion).toBe("0.1.0");
    expect(result.requiresConfirmation).toBe(false);
    expect(result.versionDir).toBe("plugin/0.2.0");
    expect(result.ownership.map((entry) => entry.status)).toEqual(["missing", "missing", "missing"]);
    expect(result.recordOwnership.status).toBe("unchanged");
    expect(byTarget(result)).toMatchObject({
      "installHome/install.json": { kind: "update", reason: "outdated" },
      "paseoHome/config.json#pluginsEnabled": { kind: "skip", reason: "unchanged" },
      "paseoDaemon/plugins[paseo-bm]": { kind: "update", reason: "outdated" },
    });
    expect(result.summary.byKind.conflict).toBe(0);
  });

  it("reinstall of the same version with nothing drifted plans zero writes", async () => {
    const record = recordFor("0.2.0", installOnDisk("0.2.0", PAYLOAD_V2));
    writeRecord(record);

    const result = await plan({
      version: "0.2.0",
      payload: manifest(PAYLOAD_V2),
      record,
      switches: { pluginsEnabled: true, injectIntoAgents: true },
      registration: { dir: join(installHome, "plugin", "0.2.0") },
    });

    expect(result.situation).toBe("reinstall");
    expect(result.summary.writes).toBe(false);
    expect(result.actions.every((action) => action.kind === "skip")).toBe(true);
    expect(result.recordOwnership.status).toBe("unchanged");
  });

  it("reinstall as repair: missing, user-modified and unrecorded files are told apart", async () => {
    const files = installOnDisk("0.2.0", PAYLOAD_V2);
    const record = recordFor("0.2.0", files);
    writeRecord(record);
    rmSync(join(installHome, "plugin/0.2.0/index.server.ts"));
    writeAt("plugin/0.2.0/roles/worker.md", "# the user rewrote this\n");
    writeAt("plugin/0.2.0/roles/reviewer.md", "# not ours\n");

    const payload = [...manifest(PAYLOAD_V2), { path: "roles/reviewer.md", sha256: sha256("# Reviewer\n") }];
    const input = { version: "0.2.0", payload, record };

    const result = await plan(input);
    expect(result.situation).toBe("reinstall");
    expect(byTarget(result)).toEqual({
      "installHome/plugin/0.2.0/paseo-plugin.json": { kind: "skip", reason: "unchanged" },
      "installHome/plugin/0.2.0/index.server.ts": { kind: "create", reason: "missing" },
      "installHome/plugin/0.2.0/roles/worker.md": { kind: "conflict", reason: "user-modified" },
      "installHome/plugin/0.2.0/roles/reviewer.md": { kind: "conflict", reason: "conflict" },
      "installHome/install.json": { kind: "update", reason: "outdated" },
    });
    expect(result.conflicts).toHaveLength(2);
    expect(result.summary.conflicts).toBe(true);

    const forced = await plan({ ...input, force: true });
    expect(byTarget(forced)["installHome/plugin/0.2.0/roles/worker.md"]).toEqual({ kind: "update", reason: "user-modified" });
    // --force never touches something that is not ours.
    expect(byTarget(forced)["installHome/plugin/0.2.0/roles/reviewer.md"]).toEqual({ kind: "conflict", reason: "conflict" });
  });

  it("downgrade: flagged for explicit confirmation; files of the older version still owned are skipped", async () => {
    const v1 = installOnDisk("0.1.0", PAYLOAD_V1);
    const v2 = installOnDisk("0.2.0", PAYLOAD_V2);
    const record = recordFor("0.2.0", [...v1, ...v2]);
    writeRecord(record);

    const result = await plan({
      version: "0.1.0",
      payload: manifest(PAYLOAD_V1),
      record,
      switches: { pluginsEnabled: true, injectIntoAgents: true },
      registration: { dir: join(installHome, "plugin", "0.2.0") },
    });

    expect(result.situation).toBe("downgrade");
    expect(result.installedVersion).toBe("0.2.0");
    expect(result.requiresConfirmation).toBe(true);
    expect(result.confirmationReason).toBe("downgrade");
    expect(result.ownership.map((entry) => entry.status)).toEqual(["unchanged", "unchanged", "unchanged"]);
    expect(byTarget(result)).toMatchObject({
      "installHome/install.json": { kind: "update", reason: "outdated" },
      "paseoDaemon/plugins[paseo-bm]": { kind: "update", reason: "outdated" },
    });
  });
});

describe("install.json baseline", () => {
  it("a record paseo-bm wrote is ours, not a conflict, on every run", async () => {
    const record = recordFor("0.2.0", installOnDisk("0.2.0", PAYLOAD_V2));
    writeRecord(record);
    const result = await plan({ version: "0.2.0", payload: manifest(PAYLOAD_V2), record });
    expect(result.recordOwnership.status).toBe("unchanged");
    expect(byTarget(result)["installHome/install.json"]).toEqual({ kind: "skip", reason: "unchanged" });
  });

  it("a hand-edited record is user-modified and needs a decision", async () => {
    const record = recordFor("0.2.0", installOnDisk("0.2.0", PAYLOAD_V2));
    writeAt("install.json", serializeRecord(record).replace("{", '{\n  "note": "edited",'));
    const result = await plan({ version: "0.2.0", payload: manifest(PAYLOAD_V2), record });
    expect(result.recordOwnership.status).toBe("user-modified");
    expect(byTarget(result)["installHome/install.json"]).toEqual({ kind: "conflict", reason: "user-modified" });
  });

  it("an install.json present without a loaded record is a conflict", async () => {
    writeAt("install.json", "{}\n");
    const result = await plan({ version: "0.1.0", payload: manifest(PAYLOAD_V1) });
    expect(result.situation).toBe("fresh");
    expect(byTarget(result)["installHome/install.json"]).toEqual({ kind: "conflict", reason: "conflict" });
  });

  it("recordChanged forces the record update when nothing else writes", async () => {
    const record = recordFor("0.2.0", installOnDisk("0.2.0", PAYLOAD_V2));
    writeRecord(record);
    const result = await plan({ version: "0.2.0", payload: manifest(PAYLOAD_V2), record, recordChanged: true });
    expect(byTarget(result)["installHome/install.json"]).toEqual({ kind: "update", reason: "outdated" });
  });
});

describe("classifySituation and payloadDestination", () => {
  it("orders versions by semver and refuses to guess an unknown order", () => {
    expect(classifySituation(undefined, "0.1.0").situation).toBe("fresh");
    expect(classifySituation("0.1.0", "0.1.0").situation).toBe("reinstall");
    expect(classifySituation("0.1.0", "0.10.0").situation).toBe("upgrade");
    expect(classifySituation("0.2.0", "0.1.0")).toMatchObject({ situation: "downgrade", requiresConfirmation: true });
    expect(classifySituation("0.1.0", "0.1.0-next.1")).toMatchObject({ situation: "downgrade", requiresConfirmation: true });
    expect(classifySituation("weird", "0.1.0")).toMatchObject({
      situation: "upgrade",
      requiresConfirmation: true,
      confirmationReason: "unknown-version-order",
    });
  });

  it("keeps payload paths inside the version directory", () => {
    expect(payloadDestination("0.1.0", "./roles\\worker.md")).toBe("plugin/0.1.0/roles/worker.md");
    expect(() => payloadDestination("0.1.0", "../install.json")).toThrow();
    expect(() => payloadDestination("0.1.0", "/etc/passwd")).toThrow();
  });
});

describe("the no-write assertion has teeth", () => {
  it("the same guard records a write made while it is active", async () => {
    const scope = startWriteScope({ installHome, paseoHome, watch: [fakeHome] });
    try {
      mkdirSync(installHome, { recursive: true });
      expect(scope.writes.length).toBeGreaterThan(0);
    } finally {
      scope.restore();
    }
  });
});
