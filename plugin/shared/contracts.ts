/**
 * RPC contracts for the paseo-bm plugin.
 *
 * Source of truth: docs/design/paseo-bm.md §7.12 ("The plugin's RPC table").
 * The contracts live in `shared/contracts/`, one module per group; this file
 * re-exports every one of them, so importers keep importing from
 * `shared/contracts`. `shared/` must stay free of Node and React Native
 * runtime imports: Zod schemas and plain values only.
 *
 * `errors` and `persisted` import no other contract module; `chat-beads`
 * and `links` build on `dashboard`, `fallback` on `roles`, and every other module on
 * `persisted` alone. Keep it that way: an import cycle between them would
 * leave a schema undefined when the bundle evaluates it.
 *
 * WP-108 delivers the contracts. Handler behaviour lives in `server/` (WP-112)
 * and the surfaces that call them live in `client/` (WP-113).
 */

export * from "./contracts/errors";
export * from "./contracts/persisted";
export * from "./contracts/dashboard";
export * from "./contracts/setup";
export * from "./contracts/roles";
export * from "./contracts/fallback";
export * from "./contracts/chat-beads";
export * from "./contracts/orchestrator";
export * from "./contracts/decisions";
export * from "./contracts/insights";
export * from "./contracts/autonomy";
export * from "./contracts/links";
