import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DataHomeError } from "../plugin/server/data-home";
import {
  READ_FAILED,
  coded,
  dataHome,
  errorText,
  logOf,
  readOr,
  requireDataHome,
  tapPaseo,
  withPaseoTap,
} from "../plugin/server/rpc-kit";
import { DashboardError } from "../plugin/shared/contracts";

/**
 * The RPC handlers' kit (code review 2026-09-30 §3.2): one data-home lookup,
 * one coding of a failure, one read that falls back, one error text and one
 * Paseo tap. A temporary data folder named by `PASEO_BM_HOME` only; never the
 * real HOME.
 */

let root: string;
const unusable = () => ({ env: { PASEO_BM_HOME: "relative/path" }, homedir: () => root });

function thrown(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error("expected a failure");
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "bm-rpc-kit-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("errorText and logOf", () => {
  it("is an error's message, or the thrown value as text", () => {
    expect(errorText(new Error("boom"))).toBe("boom");
    expect(errorText("plain")).toBe("plain");
    expect(errorText(42)).toBe("42");
  });

  it("logs to deps.log, else console.warn", () => {
    const lines: string[] = [];
    logOf({ log: (line) => lines.push(line) })("one");
    expect(lines).toEqual(["one"]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    logOf()("two");
    expect(warn).toHaveBeenCalledWith("two");
    warn.mockRestore();
  });
});

describe("dataHome and requireDataHome", () => {
  it("resolves the data folder, creating nothing", () => {
    const home = join(root, "data");
    expect(dataHome({ env: { PASEO_BM_HOME: home }, homedir: () => root })).toBe(home);
  });

  it("takes `home` as it is, null included", () => {
    expect(dataHome({ home: "/given", env: { PASEO_BM_HOME: join(root, "data") } })).toBe("/given");
    expect(dataHome({ home: null, env: { PASEO_BM_HOME: join(root, "data") } })).toBeNull();
  });

  it("is null for a folder that cannot be used, never a throw", () => {
    expect(dataHome(unusable())).toBeNull();
    expect(dataHome({ homedir: () => { throw new Error("no home"); } })).toBeNull();
  });

  it("requireDataHome fails E_DATA_HOME_UNAVAILABLE, naming what and why", () => {
    expect(requireDataHome({ env: { PASEO_BM_HOME: join(root, "data") }, homedir: () => root }, "save")).toBe(join(root, "data"));
    const error = thrown(() => requireDataHome(unusable(), "save the thing"));
    expect(error).toBeInstanceOf(DashboardError);
    expect((error as DashboardError).code).toBe("E_DATA_HOME_UNAVAILABLE");
    expect((error as Error).message).toMatch(/^E_DATA_HOME_UNAVAILABLE: cannot save the thing: paseo-bm cannot use its data folder \(.*must be an absolute path/);
  });
});

describe("coded", () => {
  it("returns what the operation returns", () => {
    expect(coded("E_DECISION_WRITE_FAILED", "save", () => 7)).toBe(7);
  });

  it("answers a data folder that cannot be created with E_DATA_HOME_UNAVAILABLE, whatever code the store wrapped it in", () => {
    const cause = new DataHomeError("cannot create the data folder /x");
    const wrapped = new DashboardError("E_TRACE_STORE_UNWRITABLE", cause.message, { cause });
    for (const failure of [wrapped, cause, new DashboardError("E_ORCHESTRATOR_WRITE_FAILED", "x", { cause: wrapped })]) {
      const error = thrown(() => coded("E_AUTONOMY_WRITE_FAILED", "save the policy", () => {
        throw failure;
      })) as DashboardError;
      expect(error.code).toBe("E_DATA_HOME_UNAVAILABLE");
      expect(error.cause).toBe(failure);
    }
    const error = thrown(() => coded("E_AUTONOMY_WRITE_FAILED", "save the policy", () => {
      throw wrapped;
    })) as DashboardError;
    expect(error.message).toBe("E_DATA_HOME_UNAVAILABLE: cannot save the policy: cannot create the data folder /x");
  });

  it("answers a store's failure with the handler's code, the borrowed code dropped from the message", () => {
    const store = new DashboardError("E_TRACE_STORE_UNWRITABLE", "refusing to use a symlinked path inside the data folder: /d/x");
    const error = thrown(() => coded("E_COORDINATION_WRITE_FAILED", "save the settings", () => {
      throw store;
    })) as DashboardError;
    expect(error.code).toBe("E_COORDINATION_WRITE_FAILED");
    expect(error.message).toBe("E_COORDINATION_WRITE_FAILED: cannot save the settings: refusing to use a symlinked path inside the data folder: /d/x");
    expect(error.cause).toBe(store);
  });

  it("never answers a read with a write code", () => {
    for (const code of ["E_TRACE_STORE_UNWRITABLE", "E_ORCHESTRATOR_WRITE_FAILED", "E_DECISION_WRITE_FAILED"] as const) {
      const error = thrown(() => coded(READ_FAILED, "read the decisions", () => {
        throw new DashboardError(code, "x");
      })) as DashboardError;
      expect(error.code).toBe("E_DATA_HOME_UNAVAILABLE");
    }
    expect(READ_FAILED).toBe("E_DATA_HOME_UNAVAILABLE");
  });

  it("passes its own code and every other coded failure as they are", () => {
    for (const failure of [
      new DashboardError("E_COORDINATION_WRITE_FAILED", "newer file"),
      new DashboardError("E_DECISION_NOT_FOUND", "no decision q:1"),
      new DashboardError("E_AUTONOMY_INVALID", "unknown class"),
      new DashboardError("E_DATA_HOME_UNAVAILABLE", "no folder"),
    ]) {
      expect(thrown(() => coded("E_COORDINATION_WRITE_FAILED", "save", () => {
        throw failure;
      }))).toBe(failure);
    }
  });

  it("codes anything uncoded with the handler's code", () => {
    const error = thrown(() => coded("E_PRECEDENT_WRITE_FAILED", "save the precedents", () => {
      throw new Error("disk full");
    })) as DashboardError;
    expect(error.message).toBe("E_PRECEDENT_WRITE_FAILED: cannot save the precedents: disk full");
    expect(thrown(() => coded("E_PRECEDENT_WRITE_FAILED", "save", () => {
      throw "odd";
    }))).toMatchObject({ code: "E_PRECEDENT_WRITE_FAILED", message: "E_PRECEDENT_WRITE_FAILED: cannot save: odd" });
  });
});

describe("readOr", () => {
  it("reads through the data folder", () => {
    const home = join(root, "data");
    expect(readOr({ env: { PASEO_BM_HOME: home }, homedir: () => root }, "the thing", "fallback", (found) => found)).toBe(home);
  });

  it("falls back without a usable data folder, silently, and on a failed read with one log line", () => {
    const lines: string[] = [];
    const read = vi.fn(() => "read");
    expect(readOr({ ...unusable(), log: (line) => lines.push(line) }, "the thing", "fallback", read)).toBe("fallback");
    expect(read).not.toHaveBeenCalled();
    expect(lines).toEqual([]);
    const failing = () => {
      throw new Error("symlink");
    };
    expect(readOr({ home: root, log: (line) => lines.push(line) }, "the thing", "fallback", failing)).toBe("fallback");
    expect(lines).toEqual(["[paseo-bm] could not read the thing: symlink"]);
  });
});

describe("tapPaseo and withPaseoTap", () => {
  it("hands the handle over, and never fails or waits on a throw or a rejection", async () => {
    const seen: unknown[] = [];
    tapPaseo((paseo) => seen.push(paseo), "handle");
    tapPaseo(() => {
      throw new Error("boom");
    }, "handle");
    tapPaseo(() => Promise.reject(new Error("later")), "handle");
    tapPaseo(undefined, "handle");
    await Promise.resolve();
    expect(seen).toEqual(["handle"]);
  });

  it("taps every handler of the server it wraps, and is the server itself without a tap", async () => {
    const handle = vi.fn();
    const server = { handle } as unknown as Parameters<typeof withPaseoTap>[0];
    expect(withPaseoTap(server, undefined)).toBe(server);

    const onPaseo = vi.fn(() => {
      throw new Error("boom");
    });
    const tapped = withPaseoTap(server, onPaseo);
    const contract = { name: "x.y" } as unknown as Parameters<typeof tapped.handle>[0];
    tapped.handle(contract, (input: unknown) => ({ echoed: input }));
    expect(handle).toHaveBeenCalledTimes(1);
    const registered = handle.mock.calls[0]![1] as (input: unknown, context: unknown) => unknown;
    expect(registered("in", { paseo: "handle" })).toEqual({ echoed: "in" });
    expect(onPaseo).toHaveBeenCalledWith("handle");
  });
});
