# Implementation Plan — the Orchestrator agent (ADR-014)

| Field | Value |
|---|---|
| Status | Completed (2026-09-28) |
| Plan-ready | PASS — 2026-09-28 — hieu.nt10 (owner approved the PRD, ADR-014 and the design and asked to proceed; self-evaluation §8) |
| Owner | hieu.nt10 |
| Phase | **Phase O1 MVP** (Orchestrator PRD §9, rewritten 2026-09-28) |
| Decision | [ADR-014](../../adr/ADR-014-orchestrator-agent-proposes-owner-approves.md) (Accepted 2026-09-28), superseding ADR-013 |
| Requirements | [Orchestrator PRD](../product/paseo-bm-orchestrator-prd.md) REQ-071 → REQ-080 (Accepted 2026-09-28) |
| Technical Design | [paseo-bm-orchestrator.md](../../design/paseo-bm-orchestrator.md) §1 → §13 (Active 2026-09-28) |
| Starting point | The first design's code, implemented and uncommitted on `main` ([its plan](paseo-bm-plan-orchestrator.md)); design §11 says what is kept and removed |
| Target release | **None in this plan.** The owner tests the finished work and then decides the version |

## 0. Routing Decision

Canonical owner: [Orchestrator PRD §0](../product/paseo-bm-orchestrator-prd.md#0-routing-decision). Execution path: plan → converter. This plan adds nothing to it.

## 1. MVP-Lock

**In phase:** REQ-071 → REQ-080 as rewritten on 2026-09-28; the REQ-047 amendment of the Dashboard PRD; removing the first design's parts listed in design §11.

**Out of phase:** REQ-081; sending anything without the owner's click; commands to Workers or Reviewers; agent errors and usage limits (the fallback feature); releasing (version, release notes, publish).

**Phase exit conditions:**
1. Every P2 acceptance criterion of REQ-071 → REQ-080 met, with the evidence of design §12.
2. O-1 → O-4 proved by tests (negative suite included); O-5 accepted by the owner on the tab.
3. The first design's removed parts are gone (no `BM-NUDGE`, no nudge watcher, no Metric additions, no removed RPC), and `npm run verify` and `smoke:packed` are green.
4. Dashboard PRD REQ-047 amended; base and dashboard designs updated where they describe what changed.
5. An acceptance run on an isolated daemon with a run record in `docs/archive/operations/`.

**Checkpoint posture:** every work package changes only code and documents in this repository and is undone with git; nothing reaches a user's machine until the owner installs it; both switches and the Orchestrator agent are off/absent by default. No point of no return in this plan.

## 2. Work packages

### WP-601 — The Orchestrator agent and its home
- **Outcome:** `orchestrator.open-preview` and `orchestrator.open` create the one Orchestrator agent in a workspace of its own (or reopen it), with rewritten instructions.
- **Requirements:** REQ-075, REQ-077 (instructions).
- **Design:** §3.2, §3.3, §8 (`open-preview`, `open`, `E_ORCHESTRATOR_UNAVAILABLE`); first verify Q-077 (`workspaces.open` from the plugin server) on an isolated daemon, else implement the §3.3 fallback.
- **Prerequisites:** WP-604 (settings/store shape).
- **Exit:** tests: creates once, reopens the same agent, labels `bm.role`/`bm.orchestrator`, mode by the Reviewer rule, `E_ORCHESTRATOR_UNAVAILABLE`; `roles-content` checks the new `orchestrator.md`; the Q-077 finding recorded in design §3.3.

### WP-602 — Remove the first design's parts
- **Outcome:** design §11's "Removed" rows are gone; kept parts still pass their tests.
- **Requirements:** REQ-071 f, REQ-079 (no automatic send).
- **Design:** §11.
- **Prerequisites:** none.
- **Exit:** no `BM-NUDGE`, `nudge.ts`, watcher, nudge settings, removed RPCs or the assessment turn-end reader; Metric has no Orchestrator element; Manager/Worker role files back to their text and caps without the nudge sentences; `npm run verify` green.

### WP-603 — The Orchestrator's tools
- **Outcome:** the endpoint `/mcp/orchestrator/<secret>` serves `bm_projects`, `bm_request`, `bm_agent_messages`, `bm_propose_command` and the workflow `bm_assessment`, given to the Orchestrator by the hook.
- **Requirements:** REQ-074, REQ-075 d-e, REQ-076 a, REQ-078 b, REQ-080 a.
- **Design:** §5.1 → §5.5.
- **Prerequisites:** WP-604 (proposals, assessments store), WP-602 (the removed reader and old tool wiring).
- **Exit:** tests: secret required (404 without), each read tool's output, `bm_agent_messages` refuses a non-`bm-*` agent, `bm_propose_command` validates the Manager and dedups pending, `bm_assessment` attaches to the pending workflow line; the hook gives the tools only to the Orchestrator on `TOOL_PROVIDERS`.

### WP-604 — Store: settings v2, proposals, stalls
- **Outcome:** `orchestrator-store.ts` holds settings `{ version: 2, watch }`, `proposals.json`, `stalls.json`, and workflow assessment lines.
- **Requirements:** REQ-073 a, REQ-076 f, REQ-080 b-c.
- **Design:** §5.4.
- **Prerequisites:** none.
- **Exit:** tests for each file's rules (caps, dedup, settle transitions, old `version: 1` settings read as default), modes `0700`/`0600`, atomic writes; cleanup and `traces.delete` still clean them.

### WP-605 — Approvals, commands, questions, assessment requests, state
- **Outcome:** RPCs `state`, `save-settings` (watch), `approve`, `dismiss`, `command`, `ask`, `assess-workflow` (and `apply-suggestion` kept) work as design §7–§8.
- **Requirements:** REQ-071 (data), REQ-073 a, REQ-076, REQ-078 a, REQ-079 a-c.
- **Design:** §7, §8.
- **Prerequisites:** WP-601, WP-604.
- **Exit:** tests: one delivery through the queue per approval (kind per proposal), running Manager gets it at turn end, `E_PROPOSAL_SETTLED`, `E_MANAGER_GONE`, `E_WATCH_NOT_CONFIRMED`, `E_ORCHESTRATOR_NOT_OPEN`; `state` output from fixtures; base design §7.12 lists the RPCs and codes.

### WP-606 — Stall watcher
- **Outcome:** with the switch on, stalls are detected every 60 s and wake the Orchestrator once per situation.
- **Requirements:** REQ-072, REQ-073.
- **Design:** §6.
- **Prerequisites:** WP-604, WP-605 (switch RPC), WP-601 (finding the Orchestrator agent).
- **Exit:** tests with fake timers: each situation raised on its fixture, none on a healthy running request, cleared and raised again, once per situation, wake-up only when the agent exists, switch off → no timer.

### WP-607 — The Orchestrator tab
- **Outcome:** Setup → Orchestrator is the one-screen tab of design §9.
- **Requirements:** REQ-071, REQ-076 c/e, REQ-078 a/c/d.
- **Design:** §9; dashboard design §11.3.
- **Prerequisites:** WP-605, WP-602.
- **Exit:** pure-model tests (approvals, stalls, projects, interventions, empty state, dialogs' default Cancel); render tests of the blocks; dashboard design §11.3 updated.

### WP-608 — Boundary proof, documents, acceptance
- **Outcome:** the negative suite covers REQ-079 e and O-2 → O-4; user and design documents describe the Orchestrator agent; an acceptance run on an isolated daemon passes.
- **Requirements:** REQ-079 d-e, all (acceptance).
- **Design:** §10, §12; `scripts/manual-test/README.md` (section 5 rewritten).
- **Prerequisites:** WP-601 → WP-607.
- **Exit:** boundary suite green; Dashboard PRD REQ-047 amended; GUIDE.md, README.md, `plugin/README.md` updated without a version number; run record in `docs/archive/operations/`; plan `Completed` and archived.

## 3. Dependencies

| WP | Needs |
|---|---|
| WP-601 | WP-604 |
| WP-603 | WP-604, WP-602 |
| WP-605 | WP-601, WP-604 |
| WP-606 | WP-604, WP-605, WP-601 |
| WP-607 | WP-605, WP-602 |
| WP-608 | WP-601 → WP-607 |

WP-602 and WP-604 start in parallel. No cycles.

## 4. Risks

| Risk | Mitigation |
|---|---|
| The plugin server cannot open a workspace (Q-077) | Verified first; fallback in design §3.3 (the Open dialog chooses a workspace) |
| The endpoint secret changes at plugin restart and an old Orchestrator loses its tools | `orchestrator.open` reports it (`toolsStale`) and offers a new agent |
| Removing the first design breaks kept parts | WP-602 runs the full suite; kept modules keep their tests |
| An approved command is lost when the plugin reloads while queued | Accepted limit, shown as "queued" on the tab (design §7) |
| The Orchestrator proposes poor commands | The owner approves each one; the text is editable |
| Stall detection floods with old requests | Only requests active in the last 24 h; once per situation |

## 5. Open questions

None blocking: Q-077 and Q-078 answered 2026-09-28; Q-075 deferred.

## 6. Test strategy

Unit and fake-SDK tests per WP (design §12); pure client models without a `react-native` value import; the boundary suite (WP-608); `smoke:packed`; one acceptance run on an isolated daemon (`scripts/manual-test/`).

## 7. Revision History

| Date | Who | Change |
|---|---|---|
| 2026-09-28 | hieu.nt10 (drafted by Claude) | **Completed.** All 9 beads under `bm-orchestrator-v2-ohek` closed on evidence; `npm run verify` (124 files, 3,322 tests) and `smoke:packed` green; acceptance on an isolated daemon passed 5.1–5.6 with the real 60 s pass and 15-minute threshold ([run record](../operations/paseo-bm-orchestrator-agent-run-20260928.md)); findings F1–F4 fixed the same day. Archived |
| 2026-09-28 | hieu.nt10 (drafted by Claude) | Plan for the rewritten Orchestrator (ADR-014): eight work packages, starting from the first design's uncommitted code |

## 8. Gate `plan-ready-for-beads` — self-evaluation (2026-09-28)

Header, MVP-Lock with exit conditions and posture, 8 WPs with outcome/requirements/design/prerequisites/exit, 11 dependency edges without cycles, risks, test strategy — ✓. Every blocking design choice (tool shapes, store shapes, thresholds, RPCs, codes, tab layout) is in the design; Q-077 is verified as the first step with a defined fallback. **PASS.**
