/** REQ-173: one bounded npm metadata check, cached once per local day. */
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { join } from "node:path";
import { updatesCheckRpc, type UpdatesCheckInput, type UpdatesCheckOutput } from "../shared/contracts";
import { PLUGIN_VERSION } from "../shared/version";
import { createJsonFileStore, ensureDataDir, writeFileAtomically } from "./data-files";
import { dataHome, type RpcHomeDeps } from "./rpc-kit";

export const UPDATE_PACKAGE_NAME = "paseo-bm-plugin";
export const UPDATE_METADATA_URL = `https://registry.npmjs.org/${UPDATE_PACKAGE_NAME}`;
export const UPDATE_CHECK_TIMEOUT_MS = 5_000;
export const UPDATES_DIR_NAME = "updates";
export const UPDATE_CACHE_FILE = "check.json";
const UPDATE_CACHE_VERSION = 1;

interface UpdateCache {
  checkedLocalDate: string | null;
  checkedAt: string | null;
  latestVersion: string | null;
}

interface FetchResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

export interface UpdateCheckDeps extends RpcHomeDeps {
  now?: () => Date;
  fetch?: (url: string, init: { headers: Readonly<Record<string, string>>; signal: AbortSignal }) => Promise<FetchResponse>;
  timeoutSignal?: (milliseconds: number) => AbortSignal;
}

function defaultTimeoutSignal(milliseconds: number): AbortSignal {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), milliseconds);
  timer.unref();
  return controller.signal;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function parseCache(body: Record<string, unknown>): UpdateCache {
  const checkedLocalDate = body.checkedLocalDate;
  const checkedAt = body.checkedAt;
  const latestVersion = body.latestVersion;
  if (typeof checkedLocalDate !== "string" || typeof checkedAt !== "string" || typeof latestVersion !== "string") {
    throw new Error("the update cache is incomplete");
  }
  if (parseSemver(latestVersion) === null || Number.isNaN(Date.parse(checkedAt))) throw new Error("the update cache is invalid");
  return { checkedLocalDate, checkedAt, latestVersion };
}

function emptyCache(): UpdateCache {
  return { checkedLocalDate: null, checkedAt: null, latestVersion: null };
}

export function localDateOf(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

type Identifier = number | string;
interface Semver {
  major: number;
  minor: number;
  patch: number;
  prerelease: Identifier[];
}

/** The SemVer forms produced by package metadata and PLUGIN_VERSION. */
export function parseSemver(value: string): Semver | null {
  const matched = /^(?:v)?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(value);
  if (matched === null) return null;
  const prerelease = matched[4]?.split(".").map((part): Identifier => (/^(0|[1-9]\d*)$/.test(part) ? Number(part) : part)) ?? [];
  if (matched[4]?.split(".").some((part) => /^\d+$/.test(part) && !/^(0|[1-9]\d*)$/.test(part))) return null;
  return { major: Number(matched[1]), minor: Number(matched[2]), patch: Number(matched[3]), prerelease };
}

export function compareSemver(left: string, right: string): number | null {
  const a = parseSemver(left);
  const b = parseSemver(right);
  if (a === null || b === null) return null;
  for (const key of ["major", "minor", "patch"] as const) {
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1;
  }
  if (a.prerelease.length === 0 || b.prerelease.length === 0) {
    return a.prerelease.length === b.prerelease.length ? 0 : a.prerelease.length === 0 ? 1 : -1;
  }
  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const av = a.prerelease[index];
    const bv = b.prerelease[index];
    if (av === undefined || bv === undefined) return av === bv ? 0 : av === undefined ? -1 : 1;
    if (av === bv) continue;
    if (typeof av === "number" && typeof bv === "string") return -1;
    if (typeof av === "string" && typeof bv === "number") return 1;
    return av < bv ? -1 : 1;
  }
  return 0;
}

function outputFrom(cache: UpdateCache, source: UpdatesCheckOutput["source"], error: UpdatesCheckOutput["error"] = null): UpdatesCheckOutput {
  const compared = cache.latestVersion === null ? null : compareSemver(PLUGIN_VERSION, cache.latestVersion);
  return {
    installedVersion: PLUGIN_VERSION,
    latestVersion: cache.latestVersion,
    updateAvailable: compared === null ? null : compared < 0,
    checkedAt: cache.checkedAt,
    source,
    error,
  };
}

function errorOf(error: unknown): UpdatesCheckOutput["error"] {
  if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
    return { code: "E_UPDATE_TIMEOUT", message: "The update check timed out." };
  }
  return { code: "E_UPDATE_CHECK_FAILED", message: error instanceof Error ? error.message : String(error) };
}

export async function handleUpdatesCheck(input: UpdatesCheckInput, deps: UpdateCheckDeps = {}): Promise<UpdatesCheckOutput> {
  const home = dataHome(deps);
  if (home === null) return outputFrom(emptyCache(), "none", { code: "E_DATA_HOME_UNAVAILABLE", message: "paseo-bm's data folder is unavailable." });
  const store = createJsonFileStore<UpdateCache>({
    home,
    dir: UPDATES_DIR_NAME,
    file: UPDATE_CACHE_FILE,
    version: UPDATE_CACHE_VERSION,
    versionKey: "schemaVersion",
    parse: parseCache,
    empty: emptyCache,
    codes: { unwritable: "E_SETUP_WRITE_FAILED" },
  });
  const inspected = store.inspect();
  const previous = inspected.value;
  const now = (deps.now ?? (() => new Date()))();
  if (input.force !== true && previous.checkedLocalDate === localDateOf(now)) return outputFrom(previous, "cache");

  try {
    const request = deps.fetch ?? ((url, init) => fetch(url, init));
    const signal = (deps.timeoutSignal ?? defaultTimeoutSignal)(UPDATE_CHECK_TIMEOUT_MS);
    const response = await request(UPDATE_METADATA_URL, { headers: { accept: "application/json" }, signal });
    if (!response.ok) throw new Error(`npm registry returned HTTP ${response.status}`);
    const metadata = record(await response.json());
    const tags = record(metadata?.["dist-tags"]);
    const latestVersion = tags?.latest;
    if (typeof latestVersion !== "string" || parseSemver(latestVersion) === null) throw new Error("npm registry returned no valid dist-tags.latest version");
    const next = { checkedLocalDate: localDateOf(now), checkedAt: now.toISOString(), latestVersion };
    if (inspected.state === "too-new") {
      // This cache is disposable metadata, not user history: only a fully
      // validated fresh result may replace a future cache schema.
      ensureDataDir(home, join(home, UPDATES_DIR_NAME), "E_SETUP_WRITE_FAILED");
      writeFileAtomically(
        home,
        store.path,
        `${JSON.stringify({ schemaVersion: UPDATE_CACHE_VERSION, ...next }, null, 2)}\n`,
        "E_SETUP_WRITE_FAILED",
      );
    } else {
      store.write(next);
    }
    return outputFrom(next, "network");
  } catch (error) {
    return outputFrom(previous, previous.latestVersion === null ? "none" : "cache", errorOf(error));
  }
}

export function registerUpdateRpcs(server: PluginServerContext, deps: UpdateCheckDeps = {}): void {
  server.handle(updatesCheckRpc, (input) => handleUpdatesCheck(input, deps));
}

/** Design path, exported for tests and cleanup accounting. */
export function updateCachePath(home: string): string {
  return join(home, UPDATES_DIR_NAME, UPDATE_CACHE_FILE);
}
