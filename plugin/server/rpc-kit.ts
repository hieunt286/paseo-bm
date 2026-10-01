/**
 * The RPC handlers' kit (code review 2026-09-30 §3.2): the data folder, the
 * coding of a failure, the read that falls back, the text of an error and the
 * Paseo tap, each written once instead of in every `*-rpc.ts`.
 *
 * The codes an RPC answers when the data folder or a store fails (the registry
 * is `DASHBOARD_ERROR_CODES` in `shared/contracts.ts`):
 *
 * - **No usable data folder → `E_DATA_HOME_UNAVAILABLE`**, whether it does not
 *   resolve (`requireDataHome`) or cannot be created by the first write
 *   (`ensureDataHome`'s `DataHomeError`, which a store wraps in its own code;
 *   `coded` finds it in the cause).
 * - **A store that cannot be written → the store's own `*_WRITE_FAILED`**
 *   (`coded` with that code). The stores keep throwing the code they have
 *   always had — most borrow the trace store's `E_TRACE_STORE_UNWRITABLE` —
 *   and the RPC answers with the one its design names.
 * - **A store that cannot be read → `READ_FAILED`**, never a `*_WRITE_FAILED`:
 *   nothing was being written.
 * - Every other coded failure (a refusal, an unknown id) passes as it is.
 */
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { DashboardError, type DashboardErrorCode } from "../shared/contracts";
import { DataHomeError, resolveDataHome, unusableDataHomeMessage, type DataHomeDeps } from "./data-home";

/** How a handler finds the data folder: `home` stands in for it (a caller that has it already, a test); otherwise it is resolved. */
export type RpcHomeDeps = DataHomeDeps & { home?: string | null };

/** What a read that falls back reports to; `console.warn` by default. */
export interface RpcLogDeps {
  log?: (message: string) => void;
}

/** The message of anything thrown. */
export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** `deps.log`, or `console.warn`. */
export function logOf(deps: RpcLogDeps = {}): (message: string) => void {
  return deps.log ?? ((message: string) => console.warn(message));
}

/** The data folder, or null when none can be used. Never throws; creates nothing. */
export function dataHome(deps: RpcHomeDeps = {}): string | null {
  if (deps.home !== undefined) return deps.home;
  try {
    return resolveDataHome(deps).home;
  } catch {
    return null;
  }
}

/** The data folder, or `E_DATA_HOME_UNAVAILABLE` naming what could not be done and why: `cannot <what>: paseo-bm cannot use its data folder (<reason>)`. */
export function requireDataHome(deps: RpcHomeDeps, what: string): string {
  const home = dataHome(deps);
  if (home === null) throw new DashboardError("E_DATA_HOME_UNAVAILABLE", `cannot ${what}: ${unusableDataHomeMessage(deps)}`);
  return home;
}

/**
 * The code of a store read an RPC cannot do (a symlink, or a path it cannot
 * read, inside the data folder): the data folder is not usable for it.
 */
export const READ_FAILED: DashboardErrorCode = "E_DATA_HOME_UNAVAILABLE";

/** A store's failure: the code most stores borrow, and every `*_WRITE_FAILED`. */
const STORE_FAILURE = /^E_TRACE_STORE_UNWRITABLE$|_WRITE_FAILED$/;

/** Whether the data folder itself failed: a `DataHomeError` in the error or its causes. */
function causedByDataHome(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current instanceof Error; depth += 1) {
    if (current instanceof DataHomeError) return true;
    current = current.cause;
  }
  return false;
}

/** The message of a coded error without its `<code>: ` prefix. */
function detailOf(error: unknown): string {
  if (!(error instanceof DashboardError)) return errorText(error);
  const prefix = `${error.code}: `;
  return error.message.startsWith(prefix) ? error.message.slice(prefix.length) : error.message;
}

/**
 * Runs one store operation of a handler, and codes its failure (the rules
 * above): the data folder → `E_DATA_HOME_UNAVAILABLE`; a store's failure and
 * anything not coded → `code`, as `cannot <what>: <detail>`; any other coded
 * failure as it is.
 */
export function coded<T>(code: DashboardErrorCode, what: string, operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    if (causedByDataHome(error)) {
      throw new DashboardError("E_DATA_HOME_UNAVAILABLE", `cannot ${what}: ${detailOf(error)}`, { cause: error });
    }
    if (error instanceof DashboardError && (error.code === code || !STORE_FAILURE.test(error.code))) throw error;
    throw new DashboardError(code, `cannot ${what}: ${detailOf(error)}`, { cause: error });
  }
}

/**
 * A read for a screen or for the plugin's own readers: `fallback` without a
 * usable data folder, and `fallback` with one log line
 * (`[paseo-bm] could not read <what>: …`) when the read throws. Never throws.
 */
export function readOr<T>(deps: RpcHomeDeps & RpcLogDeps, what: string, fallback: T, read: (home: string) => T): T {
  const home = dataHome(deps);
  if (home === null) return fallback;
  try {
    return read(home);
  } catch (error) {
    logOf(deps)(`[paseo-bm] could not read ${what}: ${errorText(error)}`);
    return fallback;
  }
}

/** Hands `paseo` to `onPaseo` without ever failing or waiting: a throw or a rejection is dropped. */
export function tapPaseo(onPaseo: ((paseo: unknown) => unknown) | undefined, paseo: unknown): void {
  try {
    const result = onPaseo?.(paseo);
    if (result instanceof Promise) result.catch(() => undefined);
  } catch {
    // A watcher that wants the handle never costs the user a call.
  }
}

/** `server`, with every handler's Paseo handle handed to `onPaseo` first (`tapPaseo`); `server` itself without one. */
export function withPaseoTap(server: PluginServerContext, onPaseo: ((paseo: unknown) => unknown) | undefined): PluginServerContext {
  if (onPaseo === undefined) return server;
  const handle: PluginServerContext["handle"] = (contract, handler) =>
    server.handle(contract, (input, context) => {
      tapPaseo(onPaseo, context?.paseo);
      return handler(input, context);
    });
  return Object.assign(Object.create(server) as PluginServerContext, { handle });
}
