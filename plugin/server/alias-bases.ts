import { asRecord, nonEmpty } from "./role-choices";
import { TIMED_OUT, withTimeout } from "./role-mode";

/**
 * The `extends` of every provider alias (`bm-worker` → `claude`), from one
 * `config.get()` under the lookup budget; `{}` when unreadable. Never throws.
 *
 * One copy for every caller: the fallback notices, the fallback detection and
 * the creation hook (which gives agent tools only to a provider that can take
 * them, ADR-010) all read it the same way.
 */
export async function aliasBases(paseo: unknown): Promise<Record<string, string>> {
  const config = (paseo as { config?: { get?: unknown } } | null | undefined)?.config;
  if (typeof config?.get !== "function") return {};
  try {
    const result = await withTimeout(config.get.call(config) as Promise<{ config?: unknown } | null | undefined>);
    if (result === TIMED_OUT) return {};
    const out: Record<string, string> = {};
    for (const [id, entry] of Object.entries(asRecord(asRecord(result?.config)?.["providers"]) ?? {})) {
      const base = nonEmpty(asRecord(entry)?.["extends"]);
      if (base !== null) out[id] = base;
    }
    return out;
  } catch {
    return {};
  }
}
