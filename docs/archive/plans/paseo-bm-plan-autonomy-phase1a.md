# Implementation Plan — Calibrated autonomy, Phase 1 MVP (part a): decisions and typed handoffs

| Field | Value |
|---|---|
| Status | **Completed** 2026-09-29 — amended by [change-001](paseo-bm-plan-autonomy-change-001-suite-at-end.md) and [change-002](paseo-bm-plan-autonomy-change-002-phase1-as-built.md) (as built) |
| Plan-ready | PASS — 2026-09-29 — hieu.nt10 (design Active, ADR-017 Accepted, DQ-1 → DQ-4 answered) |
| Owner | hieu.nt10 |
| Routing decision | [PRD §0](../../product/paseo-bm-autonomy-prd.md#0-routing-decision) |
| Requirements | [Calibrated autonomy PRD](../../product/paseo-bm-autonomy-prd.md) Phase 1 MVP: REQ-110 → REQ-117, REQ-170 |
| Technical Design | [paseo-bm-autonomy.md](../../design/paseo-bm-autonomy.md) Part A (§A.1 → §A.11, §A.16, §A.17) |
| ADR | [ADR-017](../../adr/ADR-017-decisions-are-stored-objects.md) |
| Starts after | Phase 0 exit — met 2026-09-29 ([Phase 0 plan](./paseo-bm-plan-autonomy-phase0.md), Completed; the suite moved to Phase 6 WP-604) |
| Target release | None — one release for the whole programme (PRD Q-101) |

## 1. MVP-Lock

- **In:** design §A.3 → §A.11; REQ-110 → REQ-117 and REQ-170.
- **Out of this part:** the management surface, the card system v2, the retirement sweep, the suite run (part b); classes, policy and delegation (Phase 2).
- **Exit:** every AC of REQ-110 → REQ-117 met with tests; the negative tests of §A.16 green; the target capability configuration and the pairing check verified on an isolated daemon with a run note; `npm run verify` green.
- **Checkpoint posture:** working tree only, nothing released; no rollback between phases — a clean reinstall and a fix forward (DQ-1). The capability patch (WP-101) writes the user's Paseo configuration: it goes through `config-writer.ts` with its revision check and is undone by the cleanup button, as every `bm-*` entry.

## 2. Work packages

| WP | Outcome | REQ | Design | Needs | Exit |
|---|---|---|---|---|---|
| WP-101 | Capability limits per role: the Reviewer and Orchestrator aliases get `paseoTools.enabled: false`, the Manager and Worker their `disabledTools`; the role-pairing check at creation (refuse or alert) | REQ-116, REQ-170 | §A.10 | — | Live check on an isolated daemon proves the **target** configuration: a new Reviewer and a new Orchestrator get no Paseo tools, a new Manager and Worker lack exactly the disabled ones; whether the hook sees the creator and whether a hook throw surfaces to `create_agent` is recorded and the pairing check built on it (refuse or alert). No investigation of the shipped release ([change-001](paseo-bm-plan-autonomy-change-001-suite-at-end.md)). Config-writer tests for every alias incl. fallback aliases; a negative test per role; cleanup removes the keys |
| WP-102 | The decision model (`shared/decisions.ts`) and store (`server/decision-store.ts`) with the RPCs `decisions.list/get/answer/confirm` | REQ-110, REQ-111 (a, b), REQ-112 (a) | §A.3, §A.4, §A.6 (RPCs) | — | Schema and transition tests (every status, supersession, grant arithmetic); store tests (atomic write, caps, malformed entry, 0600/0700, no symlink); RPC tests incl. answering a settled/superseded/foreign decision refused |
| WP-103 | Materialisation and delivery: decisions opened from `BM-QUESTIONS` at the Manager's turn end, settled from the Manager's `BM-ANSWERS` after the owner's typed message and from answers in a Worker's chat (`needs-confirmation` otherwise), answers delivered by the plugin to the Worker; `bm_report` question fields `effects`, `subject`, `supersedes` | REQ-110, REQ-111 (c, d), REQ-113 | §A.5 a–c, §A.6 | WP-102 (store and RPCs) | Fake-SDK tests: each turn kind, reused turn ids idempotent, delivery never into a running turn, each answer delivered at the Worker's next idle moment without waiting for the rest of the round (DQ-2), the Manager's block without an owner message settles nothing |
| WP-104 | Orchestrator decisions with prepared actions and grants; `BM-COMMAND` v2 (`intent`, `effects`, `authority`, `approved`, derived `limits`); authority from declared effects; the regex gate as backstop; `bm_ask_owner` supersedes per request unless `separate`; `bm_decisions` read tool for the Orchestrator and a read-only `bm_decisions` face for the Manager; bounded defaults of `bm_request`/`bm_agent_messages`/`bm_projects`. Three separable outcomes for the converter: (i) `BM-COMMAND` v2 with authority and grants, (ii) the Orchestrator's decision tools and the Manager's read face, (iii) bounded read defaults | REQ-112, REQ-114, REQ-115 (a) | §A.3 (actions), §A.6, §A.7, §A.9 | WP-102 (store) | Builder/parser tests (v1 still read); authority tests: grant used twice/expired/undeclared effect refused, a mismatch between text and effects refused with the "declare" message, a prepared action sent with `approved` and without a contradicting limit; the 2026-09-29 push scenario replayed as a test ends with one answer and one delivered command |
| WP-105 | Fallback incidents as decisions (`f:` ids, prepared fallback actions); `BM-FALLBACK` to the Manager removed | REQ-110, REQ-111 | §A.5 d | WP-102 (store) | Tests: an incident opens one decision; each option runs `fallback.act`; an incident resolved elsewhere withdraws it; the auto policy still acts without a decision |
| WP-106 | Event bus: typed events (`decision.opened`, `request.finished`, `request.stalled`, `worker.signal`), one batched `BM-EVENTS` message per Orchestrator idle moment, Inbox alerts; `BM-STALL`, `BM-EVENT`, `manager-turn`, `autopilot-on` and the Watch switch removed | REQ-115 (b) | §A.8 | WP-103 (decision events), WP-104 (Orchestrator side) | Tests: batching (N events → one message), an event dropped when its subject settled, alerts for stalled/permission/danger/stuck, no message to the owner; A-7 measured on a synthetic day ≤ 20 % idle wakes |
| WP-107 | The four role files rewritten within their budgets (§A.11), incl. the Manager's context and alignment duties; agents created with older instructions detected (instruction-hash label on every role, as the Orchestrator has) and offered replacement from an Inbox alert, `manager.ensure` replacing an outdated Manager on the owner's tap (PRD §11 rule 3) | REQ-117, PRD §11, NFR compatibility | §A.11 | WP-103, WP-104, WP-106 (the mechanisms the text must no longer describe) | `test/roles-content.test.ts` rewritten: budgets, required duties, no mention of retired mechanisms; generated instruction modules rebuilt; outdated-agent detection and replacement tested (fake SDK); a live smoke on the isolated daemon (one Small request) |

WP-101, WP-102 can start together; WP-103, WP-104, WP-105 follow WP-102 and can run in parallel; WP-106 then WP-107.

## 3. Open decisions

| ID | Decision | Owner | Status | Blocks |
|---|---|---|---|---|
| DQ-1 | Rollback between phases | hieu.nt10 | **answered 2026-09-29** — none; clean reinstall, fix forward | — |
| DQ-2 | When answers reach a Worker | hieu.nt10 | **answered 2026-09-29** — at once, proactively | — |

## 4. Test strategy

Vitest, as the repository: pure modules by unit tests; server modules with the fake SDK; negative tests for every authority path (§A.16) in the boundary suite; the **(verify)** items on the isolated daemon kit (`scripts/manual-test/`), never the owner's daemon.

## 5. Risks

- **The capability patch removes tools an agent relies on:** the lists are checked against every tool the role files use; a live smoke per role in WP-101.
- **Materialising at turn end delays a decision** until the Manager's turn ends: the Manager receives the report as a new turn, which ends quickly; measured in the field replay.
- **Older agents** keep old instructions and tools: detected by instruction hash and offered replacement (PRD §11).

## 6. Revision History

| Date | Who | Change |
|---|---|---|
| 2026-09-29 | Claude (owner's delegation) | **Completed**: epic `bm-autonomy-phase1a-odkl` closed on evidence (13 leaves; the §A.16 negative tests; run notes of the role tools and the role pairing); as-built differences recorded in [change-002](paseo-bm-plan-autonomy-change-002-phase1-as-built.md) (pairing by alert, Replace Manager, only a judgement wakes the Orchestrator); moved to the archive |
| 2026-09-29 | Claude (owner's delegation) | Converted to beads: epic `bm-autonomy-phase1a-odkl` with 13 leaves (WP-101 → 2, WP-103 → 3, WP-104 → 3, WP-107 → 2); labels `feature:autonomy`, `phase:a1-mvp`, `wp:wp-1NN`; no cycle, lint clean |
| 2026-09-29 | Claude (owner's delegation) | [change-001](paseo-bm-plan-autonomy-change-001-suite-at-end.md) applied: WP-101 verifies the target configuration only; WP-104 adds the Manager's `bm_decisions` face and split guidance; WP-107 adds outdated-agent detection and replacement; risk measured in the field |
| 2026-09-29 | hieu.nt10 | **Active**, `plan-ready-for-beads` PASS; DQ-1 (no rollback between phases) and DQ-2 (answers delivered at once) applied |
| 2026-09-29 | hieu.nt10 (drafted by Claude) | Plan for Phase 1 MVP part a |
