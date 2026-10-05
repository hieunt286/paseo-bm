import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  UPDATE_CACHE_FILE,
  UPDATE_CHECK_TIMEOUT_MS,
  UPDATE_METADATA_URL,
  UPDATES_DIR_NAME,
  compareSemver,
  handleUpdatesCheck,
  localDateOf,
} from "../plugin/server/update-check";
import { PLUGIN_VERSION } from "../plugin/shared/version";
import { updatesCheckRpc } from "../plugin/shared/contracts";

const homes: string[] = [];
function tempDir(): string {
  const home = mkdtempSync(join(tmpdir(), "bm-update-check-"));
  homes.push(home);
  return home;
}

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function response(latest: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => ({ "dist-tags": { latest } }) };
}

describe("updates.check", () => {
  it("compares releases and prereleases with SemVer precedence", () => {
    expect(compareSemver("1.2.3", "1.2.4")).toBe(-1);
    expect(compareSemver("1.2.3", "1.2.3")).toBe(0);
    expect(compareSemver("1.2.3", "1.2.3-beta.1")).toBe(1);
    expect(compareSemver("1.2.3-beta.1", "1.2.3-beta.2")).toBe(-1);
    expect(compareSemver("1.2.3-1", "1.2.3-alpha")).toBe(-1);
    expect(compareSemver("1.2", "1.2.3")).toBeNull();
  });

  it("uses one fixed metadata request, writes a 0600 cache, and validates the contract", async () => {
    const home = tempDir();
    const fetch = vi.fn(async () => response("99.0.0"));
    const timeoutSignal = vi.fn(() => new AbortController().signal);
    const now = new Date(2026, 9, 5, 9, 30);
    const result = await handleUpdatesCheck({}, { home, fetch, timeoutSignal, now: () => now });
    expect(updatesCheckRpc.output.parse(result)).toEqual({
      installedVersion: PLUGIN_VERSION,
      latestVersion: "99.0.0",
      updateAvailable: true,
      checkedAt: now.toISOString(),
      source: "network",
      error: null,
    });
    expect(fetch).toHaveBeenCalledWith(UPDATE_METADATA_URL, expect.objectContaining({ headers: { accept: "application/json" } }));
    expect(timeoutSignal).toHaveBeenCalledWith(UPDATE_CHECK_TIMEOUT_MS);
    const path = join(home, UPDATES_DIR_NAME, UPDATE_CACHE_FILE);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ schemaVersion: 1, checkedLocalDate: localDateOf(now), checkedAt: now.toISOString(), latestVersion: "99.0.0" });
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("reuses a same-local-day success, while force and the next day request again", async () => {
    const home = tempDir();
    const fetch = vi.fn(async () => response("9.0.0"));
    const base = { home, fetch, timeoutSignal: () => new AbortController().signal };
    await handleUpdatesCheck({}, { ...base, now: () => new Date(2026, 9, 5, 8) });
    expect((await handleUpdatesCheck({}, { ...base, now: () => new Date(2026, 9, 5, 20) })).source).toBe("cache");
    await handleUpdatesCheck({ force: true }, { ...base, now: () => new Date(2026, 9, 5, 21) });
    await handleUpdatesCheck({}, { ...base, now: () => new Date(2026, 9, 6, 8) });
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("preserves the previous success on network, status, JSON and version failures", async () => {
    const home = tempDir();
    const base = { home, timeoutSignal: () => new AbortController().signal, now: () => new Date(2026, 9, 5, 8) };
    await handleUpdatesCheck({}, { ...base, fetch: async () => response("9.0.0") });
    for (const fetch of [
      async () => response("9.0.0", false, 503),
      async () => ({ ok: true, status: 200, json: async () => { throw new Error("bad JSON"); } }),
      async () => response("not-a-version"),
    ]) {
      const result = await handleUpdatesCheck({ force: true }, { ...base, fetch });
      expect(result).toMatchObject({ latestVersion: "9.0.0", source: "cache", error: { code: "E_UPDATE_CHECK_FAILED" } });
    }
    expect(JSON.parse(readFileSync(join(home, UPDATES_DIR_NAME, UPDATE_CACHE_FILE), "utf8")).latestVersion).toBe("9.0.0");
  });

  it("bounds an aborted request and preserves the previous successful cache", async () => {
    vi.useFakeTimers();
    try {
      const home = tempDir();
      const now = () => new Date(2026, 9, 5, 8);
      await handleUpdatesCheck({}, {
        home,
        now,
        fetch: async () => response("9.0.0"),
        timeoutSignal: () => new AbortController().signal,
      });
      const path = join(home, UPDATES_DIR_NAME, UPDATE_CACHE_FILE);
      const cached = readFileSync(path, "utf8");
      const controller = new AbortController();
      const pending = handleUpdatesCheck({ force: true }, {
        home,
        now,
        timeoutSignal: (milliseconds) => {
          setTimeout(() => controller.abort(), milliseconds);
          return controller.signal;
        },
        fetch: async (_url, init) => new Promise((_resolve, reject) => {
          init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
        }),
      });

      await vi.advanceTimersByTimeAsync(UPDATE_CHECK_TIMEOUT_MS);

      await expect(pending).resolves.toMatchObject({
        latestVersion: "9.0.0",
        source: "cache",
        error: { code: "E_UPDATE_TIMEOUT", message: "The update check timed out." },
      });
      expect(readFileSync(path, "utf8")).toBe(cached);
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores invalid and future cache files, and writes nothing when the data folder is unavailable", async () => {
    const home = tempDir();
    mkdirSync(join(home, UPDATES_DIR_NAME), { recursive: true });
    writeFileSync(join(home, UPDATES_DIR_NAME, UPDATE_CACHE_FILE), JSON.stringify({ schemaVersion: 99, checkedLocalDate: "2026-10-05", checkedAt: new Date().toISOString(), latestVersion: "9.0.0" }));
    const fresh = await handleUpdatesCheck({}, {
      home,
      fetch: async () => response("8.0.0"),
      timeoutSignal: () => new AbortController().signal,
      now: () => new Date(2026, 9, 5),
    });
    expect(fresh).toMatchObject({ latestVersion: "8.0.0", source: "network" });
    const unavailable = await handleUpdatesCheck({}, { home: null });
    expect(unavailable).toMatchObject({ latestVersion: null, source: "none", error: { code: "E_DATA_HOME_UNAVAILABLE" } });
  });
});
