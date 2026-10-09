# Implementation Plan — Missions, Mains and the process governor (Phases 0–3)

| Field | Value |
|---|---|
| Status | Completed (2026-10-10): Phases 0–3 built and accepted; archived |
| Plan-ready | PASS — 2026-10-09 — Claude under the owner's delegation (the owner confirmed the needs on 2026-10-09: "Tôi đã xác nhận về nhu cầu của chúng ta") |
| Owner | hieu.nt10 |
| Routing decision | [ADR-029 § Routing Decision](../../adr/ADR-029-missions-mains-and-a-process-governor.md#routing-decision) |
| Requirements | [Missions PRD](../../product/paseo-bm-missions-prd.md) REQ-184 → REQ-196, M-22 → M-27 |
| Technical Design | [Missions design](../../design/paseo-bm-missions.md) (cited as §n below) |
| ADRs | ADR-029, ADR-030 |
| Branch | `feat/missions` (from `feat/peer-links` a30db32) |

## 1. MVP-Lock

- **In:** Phase 0 (ADR-030), Phase 1 (§2–§8, §11 Main and Worker files, §6 rows including the Orchestrator's targeting), Phase 2 (§9, §11 governor file), Phase 3 (§10, after the mockup is approved).
- **Out:** releasing, pushing, installing on the owner's daemon (each only on the owner's word); missions across daemons; a plan editor.
- **Exit per phase:** PRD §9's exit criteria; `npm run build` and `npm run verify` green after the last edit of the phase; the phase's acceptance on an isolated daemon recorded under `docs/operations/`.
- **Checkpoint posture:** additive stores and fields; legacy one-repo migration keeps existing Managers working; each phase is a commit on the branch.

## 2. Work packages

| WP | Outcome | Design | Needs |
|---|---|---|---|
| **Phase 0** | | | |
| WP-001 | The published entries minify identifiers and keep names; budget check unchanged | ADR-030 | — |
| **Phase 1** | | | |
| WP-101 | Live check on an isolated daemon: a child created with another workspace's `cwd` under a parent in a directory home is placed in that workspace; labels and MCP entry across a cleared conversation; a Main's reads outside its cwd (Claude, Codex) | §3.3, §3.6, §4 `bm_repo` | — |
| WP-102 | Mission, index, journal, roster, mission-level and `m:` decision stores; project memory store; the request index; machine-wide request ids | §2, §4.1 | — |
| WP-103 | The Missions home, `isPluginHome`, Main creation and naming (labels, title, sync, clear-conversation claim), `missions.create` / `mission.ensure` RPCs, the Command Center's "New mission", the unassigned Main | §3.1–§3.3, §3.5 | WP-102 |
| WP-104 | Plugin homes are left out of every project view and the event scope | §3.1 | WP-103 |
| WP-105 | `bm_mission`, `bm_mission_start` (proposed, settled on the owner's message), `bm_mission_update` with `m:` cards and the `mission-change` prepared change applied on the owner's tap | §4, §4.1 | WP-102, WP-103 |
| WP-106 | `bm_create_worker` across repos (cwd, binding, registry `missionId`, roster, creation project, brief with memory and contracts), `bm_tell_worker` through the index | §4, §7 | WP-102, WP-103 |
| WP-107 | Links: a Worker's `bm_ask_project` → `ask-main` to its own Main; `bm_link_workers`; `bm_ask_mission`; link kinds; `bm_peers` lists missions | §2.6, §4, §5 | WP-106 |
| WP-108 | `bm_memory` (Main and Worker), automatic memory entries, the Main's read-only `bm_repo` | §2.5, §4, §7 | WP-102, WP-106 |
| WP-109 | Replacement without loss: resolve-at-delivery for Main-addressed records, notice-queue retarget, `registry.reassignManager`, `bindings.reparent`, label re-point, `missionId` on prepared commands, commands, handoffs, links and fallback incidents, `mission.ensure replace`, the cleared-conversation successor | §3.3, §3.4 | WP-103, WP-106 |
| WP-110 | Main-side lookups, decisions and delivery: materialiser (blocks, expiry, reversal) by request index, proposed answers keyed by workspace, `bm_tell_worker` message in the repo outbox | §6 | WP-106 |
| WP-111 | Main-side lookups, traces and watchers: collector, `managerAgentId` from the registry, stall watcher, event-bus finish key, review budget, request trace, compaction brief, unbound relay, no-verdict, fallback state, action-boundary request, agent tree and chat-card parties, outdated remedy | §6 | WP-106 |
| WP-112 | The Orchestrator keeps working in Phase 1: `requireManager`, `projectManagerOf`, `copyRecipientOf` through missions | §6 last row | WP-106 |
| WP-113 | Two autonomy layers and `ownerOnly`: mission level store and RPC; §8 routing for requests of a mission (repo-delegated → the Main); `bm_answer_worker`; `ANSWER_BY`/`ANSWER_VIA`/`PREDICTORS` `main`; `ownerOnly` on questions, stored, guarded (EN + VI) and refused on every path | §2.4, §4, §5, §8 | WP-110 |
| WP-114 | Legacy one-repo missions and the entry points (`manager.ensure` wrapper, start-up migration, composer-in-repo cases, `openManager` never for mission requests) | §3.6 | WP-103, WP-109 |
| WP-115 | Role files: `manager.md` as the Main's file, `worker.md`; budgets in `roles-content` | §11 | WP-105 → WP-108, WP-113 |
| WP-116 | Phase 1 docs as built and acceptance on an isolated daemon (M-22, M-23, M-24, M-25, M-27) | §12 | WP-101 → WP-115 |
| **Phase 2** | | | |
| WP-201 | Governor figures in code and the ladder store, thresholds in the Coordination settings | §9.2, §9.3 | WP-116 |
| WP-202 | Events and wakes: `mission.signal`, `mission.conflict`, `mission.scope`, `mission.review`, `worker.signal danger`; retired wakes; debounce; wake outcome per event type | §9.7 | WP-201 |
| WP-203 | Orchestrator tools: `bm_missions`, `bm_govern` (authority `governor:*`, loop guard per mission), `bm_direct_worker` narrowed to stop, `bm_decide`/`bm_predict` retired on `q:`, `bm_send_command` replaced | §9.1, §9.4 | WP-201 |
| WP-204 | Arbitration and splits: conflict detection, `bm_arbitrate`, `bm_create_main`, `mission-split` and `arbitration` prepared changes | §9.6, §4.1 | WP-202, WP-203 |
| WP-205 | Compaction and handoff in code for Workers and Mains | §9.5 | WP-201 |
| WP-206 | `orchestrator.md` as the governor's file | §11 | WP-203, WP-204 |
| WP-207 | Phase 2 docs as built and acceptance (M-26) | §12 | WP-201 → WP-206 |
| **Phase 3** | | | |
| WP-301 | A mockup of the Missions screen, approved by the owner | §10 | WP-116 |
| WP-302 | The Missions screen as the approved mockup, checked visually at phone and desktop widths: the RPCs (`missions.list`, `mission.get`, `mission.change`, `memory.list`), the client section, the visual check in a preview harness, then docs and acceptance | §10 | WP-301 |

## 3. Waves (files disjoint per wave; one build + verify per wave)

1. WP-001, WP-101 (coordinator), WP-102
2. WP-103, then WP-104 / WP-105 / WP-106 in parallel
3. WP-107, WP-108, WP-110
4. WP-109, WP-111, WP-112
5. WP-113, WP-114
6. WP-115, then WP-116 (coordinator)
7. WP-201, WP-205; then WP-202, WP-203; then WP-204, WP-206; WP-207
8. WP-301 (owner approval), WP-302

## 4. Safety and compatibility

- A Worker works only in its repo under its repo level and action boundary; a Main changes nothing; the governor only stops.
- `ownerOnly` questions are answered only by the owner (M-24).
- Mission changes the owner must approve are `m:` cards applied by the plugin (§4.1).
- Additive formats; an older build drops new fields on write, the roster stays the source (§13).

## 5. Test strategy

Targeted tests per WP by the implementing agents; `npm run build` and `npm run verify` per wave by the coordinator; `npm run test:eval` after the role files; acceptance on an isolated daemon per phase.

## 6. Risks

- The replacement drill touches many stores (§3.4): its test covers an unbound Worker, a pending handoff, a prepared command, a queued notice, a pending report and a cleared conversation.
- The live check (WP-101) may show Paseo placing or titling agents differently than the types suggest; the design is adjusted before WP-103 lands.
- The bundle: ADR-030 gives about 520 KB; each wave's build reports the size.

## 7. Revision History

| Date | Who | Change |
|---|---|---|
| 2026-10-09 | Claude for hieu.nt10 | Created after the independent design review; `plan-ready-for-beads` PASS |
| 2026-10-09 | Claude for hieu.nt10 | Phase 2 built and accepted (record `operations/paseo-bm-missions-governor-acceptance-20261009.md`, M-26 0 of 4); from the run: `bm_split_mission` added to WP-204's scope (the owner's decision that a Main's split goes to the governor), ADR-031. Phase 3 waits for the mockup's approval |
| 2026-10-10 | Claude for hieu.nt10 | The owner approved the mockup ("Tôi duyệt theo mockup"); §10 written in detail; WP-302 split into beads 9qc3.26.1 (RPCs) and .26.2 (client) in parallel, then .26.3 (visual check) and .26.4 (docs, acceptance) |
| 2026-10-10 | Claude for hieu.nt10 | Phase 3 built and checked against the artboards (record `operations/paseo-bm-missions-screen-acceptance-20261010.md`); every phase done; plan archived. Releasing stays the owner's |
