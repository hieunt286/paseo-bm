/**
 * Fallback aliases (delta 20260921 §4.4.1, REQ-065 f, REQ-031 a).
 *
 * Entry `n` (1…3) of a role's fallback chain runs on its own provider alias
 * `bm-<role>-fallback-<n>`, which extends the entry's base provider. The alias
 * has no agent profile: the entry's model, thinking and mode live in
 * `role-fallback.json`, because the chain is paseo-bm's own concept (ADR-008).
 *
 * Shared by server and client: no Node, no React.
 */

/** A role that can have a fallback chain. */
export type FallbackRole = "manager" | "worker" | "reviewer";

/** Roles whose chain is offered in this release (phase 2a-16: the Worker only; 2a-17 adds the other two). */
export const FALLBACK_ROLES: readonly FallbackRole[] = ["worker"];

/** Longest chain per role. */
export const MAX_FALLBACK_ENTRIES = 3;

/** A fallback alias id, the role it runs in group 1 and its position in group 2. */
export const FALLBACK_ALIAS_PATTERN = /^bm-(manager|worker|reviewer)-fallback-([1-3])$/;

/** `bm-<role>-fallback-<n>`; throws on a position outside 1…3 (a programming error). */
export function fallbackAlias(role: FallbackRole, n: number): string {
  if (!Number.isInteger(n) || n < 1 || n > MAX_FALLBACK_ENTRIES) {
    throw new RangeError(`fallback position must be 1…${MAX_FALLBACK_ENTRIES}, got ${n}`);
  }
  return `bm-${role}-fallback-${n}`;
}

/** The role and position of a fallback alias id (no `/<model>`), or null. */
export function fallbackAliasOf(alias: unknown): { role: FallbackRole; position: number } | null {
  if (typeof alias !== "string") return null;
  const match = FALLBACK_ALIAS_PATTERN.exec(alias);
  return match === null ? null : { role: match[1] as FallbackRole, position: Number(match[2]) };
}

/**
 * Where an alias id stands in its role's chain: 0 for the role's main alias
 * (`bm-worker`), 1…3 for a fallback alias, null for anything else.
 */
export function positionOfAlias(alias: unknown): number | null {
  if (alias === "bm-manager" || alias === "bm-worker" || alias === "bm-reviewer") return 0;
  return fallbackAliasOf(alias)?.position ?? null;
}
