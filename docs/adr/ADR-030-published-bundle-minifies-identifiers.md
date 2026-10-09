# ADR-030 — The published bundle minifies identifiers and keeps names

| Field | Value |
|---|---|
| Status | **Accepted** (2026-10-09) — Claude under the owner's delegation (a packaging choice ADR-026 decision 6 left open); reversible by one build option |
| Date | 2026-10-09 |
| Owner | hieu.nt10 |
| Amends | [ADR-026](ADR-026-published-plugin-is-bundled.md) decision 2 ("identifiers kept") and decision 6 (the budget's open choice) |
| Related | [ADR-029](ADR-029-missions-mains-and-a-process-governor.md) (the work that needs the room) · `scripts/generate-plugin-package.mjs` · `scripts/smoke-packed.mjs` · `test/plugin-package.test.ts` |
| Lane | Designed: the published package's form |

## Context

paseo.cafe scans the reachable graph of a plugin and refuses more than 2,000,000 bytes (`SCAN_MAX_BYTES`). ADR-026 bundles each entry with whitespace and syntax minified and identifiers kept, and records that before code growth uses the room "the choices are to ask paseo.cafe for a larger budget or to minify identifiers; either is a new decision".

On 2026-10-09 the two entries are 1,927,077 bytes: 73 KB left. ADR-028 alone added 63 KB; the missions work (ADR-029) is estimated at 115–185 KB over its three phases. Measured with the repository's esbuild:

| Option | Server | Client | Total |
|---|---|---|---|
| today (whitespace + syntax) | 1,232,332 | 694,196 | 1,926,528 |
| + `minifyIdentifiers` | 863,180 | 548,502 | 1,411,682 |
| + `minifyIdentifiers` + `keepNames` | 911,913 | 568,015 | **1,479,928** |

## Decision

1. The published entries are built with `minifyIdentifiers: true` and `keepNames: true`: local names shrink, while every function and class keeps its `name`, so a stack trace still names the function — the property ADR-026 kept identifiers for.
2. The 2,000,000-byte check stays; the build still refuses an entry set over it.
3. Readers keep reading the source: each entry's header already points at `plugin/` at the version's tag.
4. Asking paseo.cafe for a larger budget is not needed now; it stays the next option if growth reaches the new ceiling.

## Consequences

- About 520 KB of room; ADR-029's phases fit with margin.
- The published code is harder to read by hand (it already was one line per entry).
- Tests that read the generated bundle (`plugin-package`, `plugin-bundle-cjs`) must not depend on local identifier names.

## Alternatives considered

- **Ask paseo.cafe for a larger budget.** Depends on a third party's schedule; leaves the bundle growing. Kept as the next option.
- **Minify identifiers without `keepNames`.** 68 KB smaller still, but stack traces lose function names. Rejected.
- **Cut features to fit.** The release-note catalogue (≈118 KB in the client) is a shipped feature; cutting it trades a product feature for packaging. Rejected.
