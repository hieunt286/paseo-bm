# Implementation Plan — Inbox attention and update status, Phase 1 MVP

| Field | Value |
|---|---|
| Status | Active |
| Plan-ready | PASS — 2026-10-05 — Codex under owner hieu.nt10's approved Q1–Q2 decisions |
| Owner | hieu.nt10 |
| Routing decision | [Autonomy PRD §0](../product/paseo-bm-autonomy-prd.md#0-routing-decision), extended by the owner's request `req-20261005T013533Z` |
| Requirements | [Autonomy PRD REQ-173](../product/paseo-bm-autonomy-prd.md) and [Dashboard PRD D-7](../product/paseo-bm-dashboard-prd.md) |
| Technical Design | [Autonomy design §A.12](../design/paseo-bm-autonomy.md) and [Dashboard design §11.3–11.4, §19](../design/paseo-bm-dashboard.md) |
| ADRs | [ADR-001](../adr/ADR-001-plugin-distribution.md) — the npm package remains bundled and registered as a directory; the update check therefore reads npm metadata directly rather than relying on Paseo's directory-plugin updater |

## 1. MVP-Lock

- **In:** REQ-173 in full: a sidebar Inbox count that stays current while the plugin client is mounted; Settings and sidebar update indicators; an `updates.check` RPC that compares the installed package version with npm's latest `paseo-bm-plugin` version; a successful same-local-day cache for automatic checks; a force refresh button; focused tests; generated `plugin-package/` output.
- **Out:** installing an update, changing Paseo's plugin source, checking Git/directory sources, background work while Paseo is closed, push notifications, unread/read semantics for Inbox items, and any network use by Dashboard data, metrics or prices.
- **Exit:** every REQ-173 criterion is covered by an automated test; the cache and fixed npm target have negative tests; `npm run verify` passes after the final build and `plugin-package/` matches `plugin/`.
- **Checkpoint posture:** all changes are additive and removable. If the npm request fails, keep the last successful cache, show an inline error, and omit the update indicators when no usable result exists. No migration or irreversible state exists; removing the cache file is optional cleanup, not required for rollback.

## 2. Work packages

| WP | Outcome | Coverage | Design | Needs | Exit |
|---|---|---|---|---|---|
| WP-001 | A bounded update-status provider returns installed/latest versions and availability, caches successful automatic checks once per local calendar day, and lets a forced check bypass the cache without installing anything | REQ-173 b–e; D-7 | Autonomy §A.12 Update status; Dashboard §11.4 | none | Contract, cache, semantic-version, timeout/error, fixed-target and no-install tests pass; failed checks preserve the last success |
| WP-002 | The sidebar item continuously reflects the established Inbox count and decreases after decisions or alerts settle, without requiring the Inbox view to be open | REQ-173 a | Autonomy §A.12 Sidebar attention; Dashboard §11.3 | none | Model/view tests cover count, zero state and refresh after settlement; existing Inbox count semantics remain unchanged |
| WP-003 | Opening Beads Manager performs the cached daily check; Settings displays status and manual refresh; Settings tab and sidebar show an update icon; source and generated package ship together | REQ-173 b–e | Autonomy §A.12; Dashboard §11.3–11.4, §19 | WP-001 provides the update contract; WP-002 provides the custom sidebar/count path | Client/model/source tests cover cached open, forced refresh, status/error states and both icons; `npm run verify` passes and build output is current |

## 3. Dependencies

- WP-003 depends on WP-001's RPC/cache result so the client does not invent update state or perform network calls.
- WP-003 depends on WP-002's custom sidebar path so the update icon and numeric Inbox badge have one sidebar implementation.
- WP-001 and WP-002 are independent and may be implemented in either order; only one bead is in progress at a time.

## 4. Contract, compatibility and safety

- Provider: `updates.check { force?: boolean }`, where omission means `false`; consumers: Settings, surface-open orchestration, the Settings tab, and the custom sidebar item. The exact schema is additive and registered with the existing RPC contract list.
- Existing installs without a cache behave as never checked. Invalid or future cache schemas are ignored; no old store is rewritten until a successful check.
- The only network target is npm metadata for the fixed package name `paseo-bm-plugin`; no user input becomes a URL or command. The request sends no credentials, has a short timeout, and never executes an installer.
- Existing Inbox meaning remains unsettled decisions plus open alerts. This feature changes where the count is refreshed and rendered, not what it counts.

## 5. Test strategy

- Vitest pure/unit tests for semantic version comparison, local-day cache decisions, cache validation, errors and view models.
- RPC tests with a stubbed fetch/HTTP dependency: same-day cache avoids a request; next day and `force: true` request once; timeout/non-2xx/invalid JSON return an error; failed refresh preserves prior success; only the fixed npm URL is used.
- Client/view tests using the repository's element-tree/source conventions for sidebar count, Settings content, automatic open and manual refresh, and update icons.
- Contract/bundle tests for the RPC registration and generated package, then `npm run verify` after the final edit.

## 6. Risks and mitigations

- **npm outage or malformed response:** bounded timeout, inline error, stale successful data preserved, no indicator from an unknown result.
- **Request amplification:** automatic checks share the server's same-day cache; repeated surface opens and multiple consumers do not repeat the request. Manual refresh is intentionally uncached.
- **Badge polling cost:** reuse one shared query and the existing 5-second Inbox cadence; do not create per-component pollers.
- **Version comparison mistakes:** use a focused local SemVer comparator with release and prerelease precedence tests; do not import the transitive `semver` package or add a runtime dependency to the published plugin.

## 7. Open decisions

None. The owner approved the narrow network exception (Q1) and npm package metadata as the source (Q2) on 2026-10-05.

## 8. Revision History

| Date | Who | Change |
|---|---|---|
| 2026-10-05 | Codex for hieu.nt10 | Drafted from request `req-20261005T013533Z`; owner decisions Q1–Q2 applied. |
| 2026-10-05 | Codex under hieu.nt10's decisions | `prd-ready`, `design-ready` and `plan-ready-for-beads` PASS; Phase 1 MVP scope activated and frozen for conversion. |
| 2026-10-05 | Codex, review batch b1 | Reassessed the three gates after aligning Phase 1 through REQ-173, naming `updates/check.json` and the fixed npm network exception in the security boundary, and fixing the RPC input to optional `force` with default `false`; PASS remains. |
