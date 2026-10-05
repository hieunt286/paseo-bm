# Implementation Plan — Update now and unified release notes, Phase 1 MVP

| Field | Value |
|---|---|
| Status | Completed |
| Plan-ready | PASS — 2026-10-05 — Codex after amended PRD acceptance under owner request `req-20261005T035730Z` |
| Owner | hieu.nt10 |
| Routing decision | Brownfield / Designed: consumed RPCs, an external update process and the published-package content change require PRD + design + plan → Beads |
| Requirements | [Autonomy PRD REQ-174](../product/paseo-bm-autonomy-prd.md) |
| Technical Design | [Dashboard design §11.4](../design/paseo-bm-dashboard.md) |
| ADRs | [ADR-001](../adr/ADR-001-plugin-distribution.md), [ADR-012](../adr/ADR-012-plugin-is-the-product.md), [ADR-026](../adr/ADR-026-published-plugin-is-bundled.md) |

## 1. MVP-Lock

- **In:** a confirmed **Update now** action for npm installs; inline progress/success/failure; a release-note browser in Settings; `docs/releases/` as the single authored source; generated catalog and package output; shorter root and npm READMEs focused on onboarding/current use; contract, server, client, generator, documentation and package tests.
- **Out:** publishing a release, commit/push, daemon restart, updating directory installs, editing historical release-note files, fetching changelog content at runtime, a new dependency, rich general-purpose Markdown rendering, or changing the release notes' use as GitHub Release text.
- **Exit:** REQ-174 acceptance is covered by focused tests; catalog generation is deterministic and fails on invalid/duplicate versions; both READMEs lead with install/use/current capabilities and move version history to release notes; `npm run verify` passes after the final build and generated `plugin-package/` matches source.
- **Checkpoint posture:** all source/catalog/UI changes are removable. The update RPC is additive; a failed or interrupted CLI result is reported as failed/unknown without asserting which package version is active, and gives `paseo plugin ls` plus the fixed manual recovery command. No migration or user-data rewrite exists.

## 2. Work packages

| WP | Outcome | Coverage | Design | Needs | Exit |
|---|---|---|---|---|---|
| WP-001 | Release notes have one validated authored source and a deterministic generated catalog usable by the plugin and package build | REQ-174 b–d | Dashboard §11.4 release-note catalog | none | Generator tests cover ordering, validation and output; the current releases generate without editing historical notes |
| WP-002 | A user who sees a newer npm version can confirm and run the supported plugin update, with bounded execution and clear recovery | REQ-174 a, e | Dashboard §11.4 update sequence | existing REQ-173 status; WP-001 only for adjacent release context | Contract/server/client tests cover confirmation, fixed argv, busy state, success and failure; no test invokes live Paseo |
| WP-003 | Settings presents current and historical release notes from the generated catalog and links each release to its tagged Git source | REQ-174 b–d | Dashboard §11.4 release-note view | WP-001 catalog | View/model tests cover default selection, readable content, missing-note fallback and versioned links |
| WP-004 | Repository and npm READMEs are concise, current onboarding pages while history lives in the unified release notes; generated package is synchronized | Owner request items 3, 4 and 5 (quoted in §9) | ADR-026; release runbook | WP-001, WP-002, WP-003 finalized behavior | README assertions and package/build tests pass; no 0.3/0.4 narrative remains in either README except the one-line migration path/link |

## 3. Dependencies

- WP-002 uses the existing REQ-173 status contract and can proceed alongside WP-001; it does not need changelog generation to implement the safe update action.
- WP-003 depends on WP-001's generated catalog contract.
- WP-004 depends on the three product outcomes so its onboarding and update/release-note wording describes the final behavior and the generated package contains all source changes.

## 4. Contract, compatibility and safety

- `updates.install {}` is additive. Existing `updates.check` consumers and cache data remain unchanged.
- Eligibility requires a fixed `paseo plugin ls --json` result proving npm package `paseo-bm-plugin`; other sources are refused. The only mutation command is constant argv `plugin update paseo-bm --json`; `execFile` receives no shell or user input. The UI confirmation is the user's authorization for the network/package write.
- The runner has a 120-second timeout, 1 MB output cap and redacted result. Timeout, reload interruption or an unconfirmed resulting version is `unknown`, not success; recovery is `paseo plugin ls` then the fixed manual update command. Tests inject both runners and executable lookup.
- Release notes are build-time input. Runtime reads no repository path and makes no GitHub request; offline installs see the bundled catalog.
- Historical files under `docs/releases/` are read-only inputs. New releases add one file there, and the existing release workflow uses that same file.

## 5. Test strategy

- Vitest unit tests for release filename/version validation, SemVer ordering, deterministic generated catalog and concise extraction.
- RPC tests with fake executable lookup/runner for exact argv, timeout, non-zero exit and sanitized message.
- Client tree/model tests for confirmation, busy/error/success states, release selection and Git links.
- README/package structure tests for focused onboarding and generated release catalog inclusion.
- Final `npm run verify`; no live daemon or real plugin update in this request.

## 6. Risks and mitigations

- **Updating can reload the code serving the RPC:** report success only after exit 0 and a confirming version inspection; otherwise report `unknown`, never assert preservation, and provide `paseo plugin ls` plus the same manual update command.
- **Large release prose can grow the client bundle:** generate concise display content and keep the existing bundle budget as a hard build check; Git links retain full source access.
- **Two changelog copies drift:** authored text exists only in `docs/releases/`; generated output carries a header and is overwritten by the build.
- **Old release files vary in structure:** validate only the stable filename/version contract and extract defensively; do not rewrite historical evidence.

## 7. Open decisions

None. The owner selected in-product update, Git-per-release views, one release-note source and README simplification. Existing ADRs settle npm as the product/update path and generated bundles as the published payload.

## 8. Revision History

| Date | Who | Change |
|---|---|---|
| 2026-10-05 | Codex for hieu.nt10 | Created from request `req-20261005T035730Z`; `prd-ready`, `design-ready` and `plan-ready-for-beads` self-checks PASS; Phase 1 MVP activated and frozen for conversion. |
| 2026-10-05 | Codex, review batch b1 | Restored amended-PRD gate provenance; fixed source eligibility, 120-second timeout and unknown-result containment; specified the generated catalog schema/parser/check contract; preserved the complete owner request below. |
| 2026-10-05 | Codex | Completed WP-001–WP-004; full verification passed with the generated package synchronized. |

## 9. Provenance

- Request: `req-20261005T035730Z`
- Owner request, verbatim:
  1. “Có thể có nút update now và thực hiện update”
  2. “Cũng không xem được Change Log sản phẩm”
  3. “Tôi muốn quy hoạch thư mục change log  và có view để xem change log trên git ứng với từng bản release.”
  4. “Plugin cũng có thể đọc và xem change log nhanh từ cùng thư mục trên git, tôi cần sự đồng bộ một nguồn để tránh phải sửa đổi thay thế nhiều”
  5. “phần README để xem từ npmjs tôi cũng muốn cải thiện lại để người dùng đọc dễ hiểu, dễ tiếp cận thay vì chi chit chữ và cũng có nhiều thông tin mô tả lịch sử như bản cũ 0.4, 0.3 v.v... nó không nên nằm ở README, cả README chung của Repo cũng vậy”
