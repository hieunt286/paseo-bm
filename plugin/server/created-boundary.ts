/**
 * The action boundary the creation hook applied, kept until `agent.created`
 * labels the agent (autonomy design §D.2, change-009 C3; Phase 4 live check
 * 2026-10-01 F1).
 *
 * `agent.created` labels a new Worker or Reviewer `bm.boundary=on|off`. It
 * read the `Action boundary` line of the agent's system prompt, but at
 * `agent.created` the snapshot carries no prompt yet (`persistence` is null
 * until the session starts), so 0 of 11 agents were labelled on a real
 * daemon. The hook knows the answer when it sets the mode and the facts, and
 * `before("agent.create")` sees no agent id, so it leaves one entry keyed by
 * what `agent.created` can match: the provider alias (`bm-worker`, without the
 * model) and the resolved `cwd`. `agent.created` takes the oldest entry of that
 * key within `CREATED_BOUNDARY_MS`.
 *
 * In memory only: an entry lost on a reload costs the label, never the agent,
 * and the permission handler still reads the prompt's facts line. A creation
 * Paseo refused leaves an entry that expires; two creations of one alias in
 * one folder get the same project switch, so taking the oldest is safe.
 */
import { resolve } from "node:path";
import { providerId } from "./provider-id";

/** How long an entry waits for its `agent.created` (the hook runs moments before it). */
export const CREATED_BOUNDARY_MS = 120_000;

interface Entry {
  key: string;
  value: "on" | "off";
  at: number;
}

const entries: Entry[] = [];

/** The key both sides compute, or null when the provider or the folder is not a string. */
function keyOf(provider: unknown, cwd: unknown): string | null {
  const alias = providerId(provider);
  if (alias === null || typeof cwd !== "string" || cwd.trim() === "") return null;
  return `${alias}\u0000${resolve(cwd)}`;
}

function expire(now: number): void {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    if (now - entries[index]!.at > CREATED_BOUNDARY_MS) entries.splice(index, 1);
  }
}

/** Records the hook's decision for the agent it is creating. Never throws. */
export function rememberCreatedBoundary(provider: unknown, cwd: unknown, value: "on" | "off", now: number = Date.now()): void {
  const key = keyOf(provider, cwd);
  if (key === null) return;
  expire(now);
  entries.push({ key, value, at: now });
}

/** The oldest live decision for this alias and folder, removed; null when there is none. Never throws. */
export function takeCreatedBoundary(provider: unknown, cwd: unknown, now: number = Date.now()): "on" | "off" | null {
  const key = keyOf(provider, cwd);
  if (key === null) return null;
  expire(now);
  const index = entries.findIndex((entry) => entry.key === key);
  if (index === -1) return null;
  return entries.splice(index, 1)[0]!.value;
}

/** Forgets every entry; for tests. */
export function forgetCreatedBoundaries(): void {
  entries.length = 0;
}
