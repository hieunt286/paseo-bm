import { describe, expect, it } from "vitest";
import { renderJsonReport, toJsonDocument, writeJsonReport } from "../src/report/json.js";
import { EXIT_CODES } from "../src/exit-codes.js";
import type { Action, MigrateReport } from "../src/action.js";

/**
 * The machine channel — Technical Design §4.4.
 *
 * 0.4.0 has one command, so one report shape. The install and uninstall plans
 * and the doctor findings this file also covered went with the commands that
 * produced them (WP-406); what is still worth pinning is the frame: the key
 * order, which actions carry `from`/`to`, where a warning's wording comes from,
 * that `result.error` is present exactly on a failure, and that stdout receives
 * one parseable document and nothing else.
 *
 * Fixtures use symbolic roots (`installHome/…`) exactly as Design §4.4 writes
 * them, so nothing here contains a real `$HOME`.
 */
const PASEO = {
  cliVersion: "0.9.2",
  daemonVersion: "0.9.2",
  home: "/fake/home/.paseo",
  pluginsEnabled: false,
} as const;

const OLD_DIR = "/fake/home/.paseo-bm/plugin/0.3.1";
const NPM_SOURCE = "npm:paseo-bm-plugin@0.4.0";

const ACTIONS: readonly Action[] = [
  {
    kind: "create",
    target: "installHome/home.json",
    reason: "custom-install-home",
  },
  {
    kind: "create",
    target: "installHome/ui/setup-state.json#agentTools",
    reason: "carry-over",
  },
  {
    kind: "plugin",
    target: "paseo-bm",
    reason: "switch-to-npm",
    from: OLD_DIR,
    to: NPM_SOURCE,
  },
  {
    kind: "update",
    target: "installHome/install.json",
    reason: "migrated",
    detail: "schemaVersion 2, so a 0.3.x build refuses to re-install over the npm plugin",
  },
];

function migrateReport(overrides: Partial<MigrateReport> = {}): MigrateReport {
  return {
    schemaVersion: 1,
    command: "migrate",
    mode: "applied",
    paseoBmVersion: "0.4.0",
    paseo: PASEO,
    actions: ACTIONS,
    migration: { outcome: "migrated", from: OLD_DIR, to: NPM_SOURCE, fallback: null },
    roles: [],
    skills: null,
    warnings: [{ code: "W_PLUGINS_DISABLED", detail: "Paseo reports the plugin as disabled" }],
    result: { exitCode: EXIT_CODES.ok, pluginState: "disabled" },
    ...overrides,
  };
}

/** A stdout sink that records every chunk, the way the CLI passes one in. */
function sink(): { chunks: string[]; write: (chunk: string) => void } {
  const chunks: string[] = [];
  return { chunks, write: (chunk: string) => void chunks.push(chunk) };
}

describe("renderJsonReport — migrate", () => {
  it("renders the shape of Design §4.4", () => {
    expect(toJsonDocument(migrateReport())).toMatchSnapshot();
  });

  it("orders the top-level keys the way Design §4.4 lists them", () => {
    expect(Object.keys(toJsonDocument(migrateReport()))).toEqual([
      "schemaVersion",
      "command",
      "mode",
      "paseoBmVersion",
      "paseo",
      "actions",
      "migration",
      "roles",
      "skills",
      "warnings",
      "result",
    ]);
  });

  it("renders from/to only for the plugin action", () => {
    const document = toJsonDocument(migrateReport()) as { actions: Record<string, unknown>[] };

    for (const action of document.actions) {
      const hasEndpoints = "from" in action && "to" in action;
      expect(hasEndpoints, String(action.kind)).toBe(action.kind === "plugin");
    }
    expect(document.actions.find((action) => action.kind === "plugin")).toMatchObject({ from: OLD_DIR, to: NPM_SOURCE });
  });

  it("gives every action the three fields that are always there", () => {
    const document = toJsonDocument(migrateReport()) as { actions: Record<string, unknown>[] };

    for (const action of document.actions) {
      expect(Object.keys(action)).toContain("kind");
      expect(Object.keys(action)).toContain("target");
      expect(Object.keys(action)).toContain("reason");
    }
  });

  it("takes warning wording from the registry, not from the caller", () => {
    const document = toJsonDocument(migrateReport()) as { warnings: Record<string, unknown>[] };

    expect(document.warnings[0]).toMatchObject({ code: "W_PLUGINS_DISABLED" });
    expect(String(document.warnings[0]?.message)).toContain("plugins switch is off");
  });

  it("renders a preview through the very same code path", () => {
    const preview = toJsonDocument(migrateReport({ mode: "preview" })) as { mode: string; actions: unknown[] };

    expect(preview.mode).toBe("preview");
    expect(preview.actions).toHaveLength(ACTIONS.length);
  });

  it("renders skills as null when there is nothing to say about them", () => {
    expect((toJsonDocument(migrateReport()) as { skills: unknown }).skills).toBeNull();
  });
});

describe("the migration block", () => {
  it("names the outcome and both ends of the move", () => {
    const document = toJsonDocument(migrateReport()) as { migration: Record<string, unknown> };

    expect(document.migration).toEqual({ outcome: "migrated", from: OLD_DIR, to: NPM_SOURCE, fallback: null });
  });

  it("describes a fallback when the switch failed", () => {
    const document = toJsonDocument(
      migrateReport({
        migration: { outcome: "fell-back", from: OLD_DIR, to: NPM_SOURCE, fallback: { outcome: "fell-back", detail: `restored ${OLD_DIR}` } },
      }),
    ) as { migration: Record<string, unknown> };

    expect(document.migration).toMatchObject({ outcome: "fell-back", fallback: { outcome: "fell-back" } });
  });

  it("carries an outcome that wrote nothing at all", () => {
    const document = toJsonDocument(
      migrateReport({ actions: [], migration: { outcome: "no-directory-install", from: null, to: NPM_SOURCE, fallback: null } }),
    ) as { migration: Record<string, unknown>; actions: unknown[] };

    expect(document.migration).toMatchObject({ outcome: "no-directory-install", from: null });
    expect(document.actions).toEqual([]);
  });
});

describe("writeJsonReport — stdout holds exactly one document", () => {
  it("writes one chunk that parses as a single JSON document", () => {
    const out = sink();

    writeJsonReport(migrateReport(), out.write);

    expect(out.chunks).toHaveLength(1);
    expect(out.chunks[0]?.endsWith("\n")).toBe(true);
    const parsed = JSON.parse(out.chunks[0]!) as { command: string };
    expect(parsed.command).toBe("migrate");
    // One document: nothing before the first `{` and nothing after the last `}`.
    expect(out.chunks[0]?.trimStart().startsWith("{")).toBe(true);
    expect(out.chunks[0]?.trimEnd().endsWith("}")).toBe(true);
  });

  it("can render compactly on one line", () => {
    const compact = renderJsonReport(migrateReport(), { indent: 0 });

    expect(compact.trimEnd().includes("\n")).toBe(false);
    expect(JSON.parse(compact)).toMatchObject({ schemaVersion: 1 });
  });

  it("passes the finished text through the redaction seam", () => {
    const seen: string[] = [];

    renderJsonReport(migrateReport(), {
      redact: (text) => {
        seen.push(text);
        return text;
      },
    });

    expect(seen).toHaveLength(1);
    expect(JSON.parse(seen[0]!)).toMatchObject({ command: "migrate" });
  });
});

describe("result.error (Design §4.4 errata 2026-09-15)", () => {
  it("carries the registry code and message on a failed run", () => {
    const document = toJsonDocument(
      migrateReport({
        migration: { outcome: "remove-failed", from: OLD_DIR, to: NPM_SOURCE, fallback: null },
        result: {
          exitCode: EXIT_CODES.pluginLoadFailed,
          pluginState: null,
          error: { code: "E_PLUGIN_LOAD_FAILED", message: "Paseo could not remove the plugin: the daemon is busy." },
        },
      }),
    ) as { result: Record<string, unknown> };

    expect(document.result).toEqual({
      exitCode: EXIT_CODES.pluginLoadFailed,
      pluginState: null,
      error: { code: "E_PLUGIN_LOAD_FAILED", message: "Paseo could not remove the plugin: the daemon is busy." },
    });
  });

  it("omits the key entirely on success", () => {
    const document = toJsonDocument(migrateReport()) as { result: Record<string, unknown> };

    expect("error" in document.result).toBe(false);
  });
});
