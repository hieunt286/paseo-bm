import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DashboardError } from "../plugin/shared/contracts";
import {
  SETUP_STATE_SCHEMA_VERSION,
  emptySetupState,
  readSetupState,
  setupStatePath,
  updateSetupState,
  writeSetupState,
  type RolesCreatedMark,
  type SetupStateDeps,
} from "../plugin/server/setup-state";

/**
 * WP-401: the `ui/setup-state.json` store (design §5.3, §5.4).
 *
 * A real temporary HOME again: 0600, 0700 and the symlink refusal are
 * filesystem properties, and the "never overwrite a newer file" rule is only
 * worth anything if the bytes on disk are compared.
 */

let home: string;
let dataHome: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "bm-setup-state-"));
  dataHome = join(home, ".paseo-bm");
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

const deps = (): SetupStateDeps => ({ env: {}, homedir: () => home });

const statePath = () => setupStatePath(dataHome);

function writeRaw(contents: string): void {
  mkdirSync(join(dataHome, "ui"), { recursive: true });
  writeFileSync(statePath(), contents);
}

const agentTools = { setBy: "plugin", previous: false, at: "2026-09-25T10:00:00.000Z" } as const;
const rolesCreated: RolesCreatedMark = {
  at: "2026-09-25T10:01:00.000Z",
  roles: ["manager", "worker", "reviewer"],
  baseProvider: "claude",
  model: "claude-opus-5",
};
const skillsRun = {
  at: "2026-09-25T10:02:00.000Z",
  command: "npx -y skills install …",
  code: 0,
  outcome: "ok",
} as const;

describe("readSetupState", () => {
  it("reads the empty default when neither the folder nor the file exists", () => {
    expect(readSetupState(deps())).toEqual(emptySetupState());
    expect(() => statSync(dataHome)).toThrow();
  });

  it("creates nothing", () => {
    readSetupState(deps());

    expect(() => statSync(dataHome)).toThrow();
  });

  it("reads a file that is not JSON as empty and leaves it alone", () => {
    writeRaw("{ not json");

    expect(readSetupState(deps())).toEqual(emptySetupState());
    expect(readFileSync(statePath(), "utf8")).toBe("{ not json");
  });

  it("reads a file of the wrong shape as empty", () => {
    writeRaw(JSON.stringify({ schemaVersion: 1, agentTools: { setBy: "someone-else" } }));

    expect(readSetupState(deps())).toEqual(emptySetupState());
  });
});

describe("writeSetupState / updateSetupState", () => {
  it("round-trips every field", () => {
    const state = {
      agentTools,
      rolesCreated,
      skillsRun,
      cleanedUpAt: "2026-09-25T11:00:00.000Z",
    };

    writeSetupState(state, deps());

    expect(readSetupState(deps())).toEqual(state);
  });

  it("keeps the other fields when one is updated", () => {
    updateSetupState({ agentTools }, deps());
    updateSetupState({ rolesCreated }, deps());
    updateSetupState({ cleanedUpAt: "2026-09-25T11:00:00.000Z" }, deps());

    expect(readSetupState(deps())).toEqual({
      agentTools,
      rolesCreated,
      skillsRun: null,
      cleanedUpAt: "2026-09-25T11:00:00.000Z",
    });
  });

  it("can clear a field back to null", () => {
    updateSetupState({ agentTools }, deps());
    updateSetupState({ agentTools: null }, deps());

    expect(readSetupState(deps()).agentTools).toBeNull();
  });

  it("writes the file 0600 inside a 0700 folder, creating the data home", () => {
    updateSetupState({ skillsRun }, deps());

    expect(statSync(statePath()).mode & 0o777).toBe(0o600);
    expect(statSync(join(dataHome, "ui")).mode & 0o777).toBe(0o700);
    expect(statSync(dataHome).mode & 0o777).toBe(0o700);
  });

  it("stamps the schema version", () => {
    updateSetupState({ skillsRun }, deps());

    expect(JSON.parse(readFileSync(statePath(), "utf8")).schemaVersion).toBe(SETUP_STATE_SCHEMA_VERSION);
  });

  it("leaves no temporary file behind", () => {
    updateSetupState({ skillsRun }, deps());

    expect(readdirSync(join(dataHome, "ui")).filter((name) => name.includes(".tmp-"))).toEqual([]);
  });
});

describe("a file from a newer paseo-bm", () => {
  const newer = `${JSON.stringify({ schemaVersion: 2, somethingNew: true }, null, 2)}\n`;

  it("reads as empty", () => {
    writeRaw(newer);

    expect(readSetupState(deps())).toEqual(emptySetupState());
  });

  it("is never overwritten, and the refusal is coded", () => {
    writeRaw(newer);

    try {
      updateSetupState({ agentTools }, deps());
      expect.unreachable("updateSetupState must refuse a newer file");
    } catch (error) {
      expect(error).toBeInstanceOf(DashboardError);
      expect((error as DashboardError).code).toBe("E_DATA_HOME_UNAVAILABLE");
    }
    expect(readFileSync(statePath(), "utf8")).toBe(newer);
  });
});

describe("E_DATA_HOME_UNAVAILABLE", () => {
  const codeOf = (run: () => unknown): string => {
    try {
      run();
    } catch (error) {
      expect(error).toBeInstanceOf(DashboardError);
      return (error as DashboardError).code;
    }
    return expect.unreachable("expected a DashboardError") as never;
  };

  it("is thrown when the data folder cannot be resolved, with the reason", () => {
    const broken: SetupStateDeps = { env: { PASEO_BM_HOME: "relative/bm" }, homedir: () => home };

    try {
      readSetupState(broken);
      expect.unreachable("readSetupState must refuse an unresolvable data folder");
    } catch (error) {
      expect((error as DashboardError).code).toBe("E_DATA_HOME_UNAVAILABLE");
      expect((error as DashboardError).message).toMatch(/^E_DATA_HOME_UNAVAILABLE: /);
      expect((error as DashboardError).message).toContain("absolute path");
    }
  });

  it("is thrown when a regular file stands where ui/ should be", () => {
    mkdirSync(dataHome, { recursive: true, mode: 0o700 });
    writeFileSync(join(dataHome, "ui"), "not a directory");

    expect(codeOf(() => updateSetupState({ agentTools }, deps()))).toBe("E_DATA_HOME_UNAVAILABLE");
  });

  it("is thrown when ui/ is a symlink", () => {
    const elsewhere = join(home, "elsewhere");
    mkdirSync(elsewhere, { recursive: true });
    mkdirSync(dataHome, { recursive: true, mode: 0o700 });
    symlinkSync(elsewhere, join(dataHome, "ui"));

    expect(codeOf(() => readSetupState(deps()))).toBe("E_DATA_HOME_UNAVAILABLE");
    expect(codeOf(() => updateSetupState({ agentTools }, deps()))).toBe("E_DATA_HOME_UNAVAILABLE");
  });

  it("is thrown when the state file itself is a symlink", () => {
    const target = join(home, "stolen.json");
    writeFileSync(target, "{}");
    mkdirSync(join(dataHome, "ui"), { recursive: true });
    symlinkSync(target, statePath());

    expect(codeOf(() => readSetupState(deps()))).toBe("E_DATA_HOME_UNAVAILABLE");
    expect(codeOf(() => updateSetupState({ agentTools }, deps()))).toBe("E_DATA_HOME_UNAVAILABLE");
    expect(readFileSync(target, "utf8")).toBe("{}");
  });
});

describe("the data folder the pointer names", () => {
  it("is where the file is written", () => {
    const custom = join(home, "custom-bm");
    mkdirSync(dataHome, { recursive: true });
    writeFileSync(
      join(dataHome, "home.json"),
      JSON.stringify({ schemaVersion: 1, home: custom, writtenBy: "paseo-bm@0.4.0", at: "2026-09-25T00:00:00.000Z" }),
    );

    updateSetupState({ agentTools }, deps());

    expect(statSync(setupStatePath(custom)).isFile()).toBe(true);
    expect(() => statSync(statePath())).toThrow();
  });
});
