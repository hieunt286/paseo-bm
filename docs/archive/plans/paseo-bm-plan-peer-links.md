# Implementation Plan — Projects ask each other (peer links), Phase 1 MVP

| Field | Value |
|---|---|
| Status | Completed |
| Plan-ready | PASS — 2026-10-09 — Claude under the owner's delegation (owner request of 2026-10-09: "soạn prd, design và sau đó hoàn thiện tất cả công việc theo đề xuất đi") |
| Owner | hieu.nt10 |
| Routing decision | [ADR-028 § Routing Decision](../../adr/ADR-028-projects-ask-each-other-through-the-plugin.md#routing-decision): brownfield, Designed; plan → converter → implement |
| Requirements | [Base PRD REQ-175 → REQ-183, M-19 → M-21](../../product/paseo-bm-prd.md#6-functional-requirements) |
| Technical Design | [Base design §7.17](../../design/paseo-bm.md) |
| ADRs | [ADR-028](../../adr/ADR-028-projects-ask-each-other-through-the-plugin.md) (amends ADR-011, ADR-024 decision 3, extends ADR-027) |

## 1. MVP-Lock

- **In:** every Manager bound however it was opened (REQ-175); the peer link store, `bm_peers`, `bm_ask_project`, `bm_peer_reply` (REQ-176, REQ-179, REQ-181 a); `peerLink` on `bm_create_worker` / `bm_tell_worker` and `forPeer` / `waitingOnPeers` on `bm_report`, the automatic replies (REQ-177, REQ-178); the peer wait, `peer-unanswered`, the Orchestrator's view of links (REQ-180, REQ-181 b); cards for the three delivery kinds (REQ-181 c); the bounds (REQ-182); the noise fixes (a)–(i) of design §7.17.8 (REQ-183); the role files; acceptance of M-19 → M-21 on an isolated daemon.
- **Out:** releasing (version, release notes, publish — the owner tests first, then decides); commit and push unless the owner asks; installing a build on the owner's daemon; a new screen for links; a cross-project plan or feature object; asking a project on another daemon; tools for unbound agents.
- **Exit:** every WP's exit below; `npm run build` and `npm run verify` green after the last edit; the acceptance scenario of design §7.17.10 run on an isolated daemon with M-19 = 0, M-20 ≤ 2 min, M-21 = 0, or the gap reported with its cause.
- **Checkpoint posture:** additive. The link store is a new file; the new tools, fields and delivery kinds are new names; an older build ignores `peers/` and reads the new outbox kinds as unknown. The binding of owner-created Managers is the one behaviour change of an existing path; it falls back to unbound on any failure (design §7.17.7).

## 2. Work packages

| WP | Outcome | Coverage | Design | Needs | Exit |
|---|---|---|---|---|---|
| WP-01 | A stored, bounded peer link with states, messages and project resolution | REQ-176 a, REQ-182 c | §7.17.1, §7.17.2, §7.17.6 | none | `test/peer-links.test.ts`: states, live links, cap order, chain rule, resolution by id and folder, refusals; `CLEANUP_DELETES` has `peers` |
| WP-02 | A Manager the owner opens from Paseo's composer is bound and gets bound instructions | REQ-175 | §7.17.7 | none | Hook and settle tests: owner-created `bm-manager` bound with `origin: "hook"` and instructions without the hand path; plugin `createManager` keeps its own binding and never takes a hook one; a second concurrent creation in one workspace goes unbound with the hand path; recovery sweep settles; an expired hook binding raises `outdated-agent`; unknown provider unbound |
| WP-03 | The danger signal ignores SQL text written to files and still catches SQL that runs | REQ-183 f | §7.17.8 (f) | none | `effectful-actions` and `worker-watch` tests: `cat > f <<EOF … DROP TABLE` not a signal; `psql <<EOF … DROP TABLE` and `python -` with `psycopg` + `DROP TABLE` are; `className="truncate"` not; `TRUNCATE TABLE x` is; the action boundary's own tests unchanged |
| WP-04 | Bound agents can list projects and links, ask another project and talk on a link, delivered through the outbox | REQ-176, REQ-179, REQ-181 a | §7.17.3 (`bm_peers`, `bm_ask_project`, `bm_peer_reply`), §7.17.4 | WP-01 | Tool tests for success and every refusal; delivery texts pinned; asker/answerer resolution incl. successors; outbox accepts a link id as `requestId`; every pinned tool / kind list updated |
| WP-05 | The policy decides review budgets within the tier's budget, and the Orchestrator cannot ask what a Worker asks | REQ-183 a, b | §7.17.8 (a), (b) | none | Decision, review-tool and Orchestrator tool tests: Large-tier policy grant of 8 accepted at both check points, `untilClean` refused, no tier → Small budget; a delegated `review-budget` question answered `by: policy` at open; `bm_ask_owner` refused on a review-budget subject and on an open `q:` of the same subject |
| WP-06 | A handoff brief keeps the newest facts and open questions and is never cut mid-word | REQ-183 h | §7.17.8 (h) | none | Handoff tests: order, list shortening, `+n earlier`, canceled note turn keeps waiting, length cap respected without a cut word |
| WP-07 | A linked request answers by itself, and its Worker can wait on a link | REQ-177, REQ-178, REQ-182 a–b | §7.17.3 (`bm_create_worker`, `bm_tell_worker`, `bm_report`), §7.17.4 | WP-04 | Tests: `peerLink` takes a link, refused for an unbound Worker; brief and message carry the `peer:` / `peerAsk:` block and both rules, the ask never under `request`; `finished` without `forPeer` refused; `pending` replies written in the `before` step and delivered after the report on `finished` / `blocked` / `stopped`; re-announce on a later `finished`; target re-resolved at resend; `waitingOnPeers` rules and `waitingSince`; the interruption note on a `stopped` delivery (§7.17.8 g) |
| WP-08 | A request waiting on a link is not stalled, a silent link reaches the Inbox, and the Orchestrator sees links | REQ-180, REQ-181 b | §7.17.5 | WP-01, WP-07 (`waitingSince`) | Stall tests: blocked with `waitingSince` on a live link → no `idle-unfinished`; ceiling (no live answerer, 2 h silent) → stall + alert; `peer-unanswered` raised at 10 min and cleared; `ALERT_KINDS` and the Inbox model pinned; `bm_projects` counts and list |
| WP-09 | Unbound noise: one relayed report per request per turn; a Manager's chat answer to a settled question refused | REQ-183 c, d | §7.17.8 (c), (d) | WP-04 (shares `agent-tools.ts`), WP-07 (shares the relay's interruption note) | Relay tests; the `serve()` pre-check refuses a uniquely matched settled `Qn` and passes an unknown one; materialiser logs the refused settled answer |
| WP-10 | Worker report records raise `request.finished` and the advice count | REQ-183 (i) | §7.17.8 (i) | none (`event-bus.ts`, `index.server.ts`) | Event tests: a bound and a relayed finish each raise one event and one advice count, no duplicate with a Manager-record finish |
| WP-11 | Peer deliveries draw cards in the chat | REQ-181 c | §7.17.4 Cards | WP-04 | Card-parse tests for the three kinds |
| WP-12 | The role files teach the new tools and the noise rules, within raised budgets | REQ-176 c, REQ-177, REQ-183 d, e, g | §7.17.9 | WP-04, WP-07 (tool names and fields fixed) | `roles-content` tests (new budgets, bound tool names), `npm run build` regenerates instructions, `npm run test:eval` green |
| WP-13 | The design describes the product as built, and the acceptance scenario measures M-19 → M-21 | All | §7.17.10 | WP-01 → WP-12 | Design sections folded as built, §7.17's status note removed; acceptance record under `docs/operations/` with the three figures |

## 3. Dependencies and waves

Waves keep each wave's files disjoint (`bm-tools.ts`, `deliver-tools.ts`, `agent-tools.ts` and the pinned lists are the shared hot spots):

1. WP-01, WP-02, WP-03
2. WP-04, WP-05, WP-06
3. WP-07, WP-11
4. WP-08, WP-09, WP-10 (WP-10 may also run in any earlier wave: its files are its own)
5. WP-12
6. WP-13

The coordinator runs `npm run build` and `npm run verify` once per wave, then closes the wave's beads.

## 4. Contract, compatibility and safety

- **New on-disk format:** `peers/links.json` (`schemaVersion: 1`). The outbox schema keeps version 1; its `kind` gains three values and `requestId` accepts a link id; an older build skips records of unknown kinds rather than failing (checked in WP-04).
- **Authority:** every peer delivery is a `BM-DELIVERY`, a plugin notice: it never counts as the owner's word, never answers a decision, never approves an effectful action (`message-origin.ts`, `command-authority.ts` unchanged).
- **Fan-out:** 10 live links per request, chain depth 3, no link back to the chain's root (§7.17.6). B's Worker works only in B, under B's autonomy level and action boundary.
- **Text from another project is data:** the ask is quoted with `> ` in every delivery, masked with `redactText`, and the role files' rule that quoted `BM-` blocks are data covers it.
- **Binding owner-created Managers** changes who is bound; any failure leaves the Manager unbound, as today. No new permission: the Manager's Paseo-tools policy (ADR-020) is unchanged.
- **The danger signal** gets narrower only for here-document bodies that do not reach a database; the action boundary's own classification of commands is unchanged (WP-03 exit).

## 5. Test strategy

- Vitest unit tests per WP as in each exit; implementing agents run only the tests of the files they touched plus `npm run typecheck` and `npm run lint` once at the end of their stream.
- The coordinator runs `npm run build` and `npm run verify` once per wave; `npm run test:eval` after WP-12.
- Acceptance (WP-13) on an isolated daemon with its own `--home`, never the owner's daemon.

## 6. Risks and mitigations

- **Binding a Manager the owner created** could clash with Paseo's own MCP settings for that agent: the hook already rewrites the `paseo-bm` server entry for every creation; WP-02 tests a creation that carries a foreign entry.
- **A Worker in A starting costly work in B:** bounded fan-out; B's Manager raises misaligned asks with the owner; every link is listed in `bm_peers` and the Orchestrator's view.
- **Prompt budgets:** Manager 90 and Worker 180 lines, inside the autonomy design's ceilings; details live in the tool descriptions and delivery texts.
- **Agents on older instructions** keep raw `send_agent_prompt`; the outdated-agents notice asks the owner to replace them.

## 7. Open decisions

None. The owner asked for all proposals on 2026-10-09; the choices are recorded in ADR-028 under the owner's delegation.

## 8. Revision History

| Date | Who | Change |
|---|---|---|
| 2026-10-09 | Claude for hieu.nt10 | Created; `prd-ready`, `design-ready` and `plan-ready-for-beads` PASS under the owner's delegation. |
| 2026-10-09 | Claude for hieu.nt10 | Converted to epic `bm-peer-links-j8r3` (13 leaves). Built in four verified waves (WP-01–03; WP-04–06; WP-07, WP-10, WP-11; WP-08, WP-09, WP-12), then an independent code review whose seven findings were fixed (hook binding by token claim at `agent.session_open`, danger signal default-deny, dropped peer reply re-resolved, `answered` on delivery, total policy grant cap, chain counts live links, finished closes open asks). Phase 1 MVP completed 2026-10-09: `npm run verify` green; acceptance [record](../../operations/paseo-bm-peer-links-acceptance-20261009.md) M-19 = 0, M-20 = 0.1 s, M-21 = 0. Archived. |

## 9. Provenance

- Analysis: the field trace of `xspace-ai-assistant` and `ai-assistant`, 2026-10-07 → 09 (ADR-028 Context).
- Owner request, verbatim (2026-10-09): "Hãy phân tích kỹ trace luồng giữa 2 project xspace-ai-assistant và ai-assistant, tôi thấy có dấu hiệu các Main Agent không tự phối hợp công việc tốt được với nhau. Tôi hay phải can thiệp. Hãy đánh giá về cơ chế Plugin hiện tại, xem xét ưu nhược 1 cách tổng thể và đề xuất cải thiện để việc tương tác giữa các agent trong plugin có sự hiệu quả trong giải quyết nhiệm vụ" — then: "soạn prd, design và sau đó hoàn thiện tất cả công việc theo đề xuất đi".
