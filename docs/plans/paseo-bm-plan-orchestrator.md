# Implementation Plan — the Orchestrator

| Field | Value |
|---|---|
| Status | Draft |
| Plan-ready | Pending — self-evaluated 2026-09-28 (§8), awaiting the owner |
| Owner | hieu.nt10 |
| Phase | **Phase O1 MVP** (Orchestrator PRD §9) |
| Decision | [ADR-013](../adr/ADR-013-orchestrator-assess-and-nudge.md) (Accepted 2026-09-28) |
| Requirements | [Orchestrator PRD](../product/paseo-bm-orchestrator-prd.md) REQ-071 → REQ-080 (Accepted 2026-09-28) |
| Technical Design | [paseo-bm-orchestrator.md](../design/paseo-bm-orchestrator.md) §1 → §12 (Active 2026-09-28) · [paseo-bm.md](../design/paseo-bm.md) §6.2, §7.2, §7.12, §7.13 · [paseo-bm-dashboard.md](../design/paseo-bm-dashboard.md) §6, §11.3, §12 |
| Target release | **None in this plan.** The owner tests the finished work and only then decides the version and the release (owner, 2026-09-28) |

## 0. Routing Decision

Canonical owner: [Orchestrator PRD §0](../product/paseo-bm-orchestrator-prd.md#0-routing-decision) (brownfield; new product outcomes, new consumed contracts — RPCs and a `BM-*` notice — a write to the user's Paseo configuration, a new trust boundary, several independent outcomes). Execution path: plan → converter. This plan adds nothing to it.

## 1. MVP-Lock

**In phase:** REQ-071, REQ-072, REQ-073, REQ-074, REQ-075, REQ-076, REQ-077, REQ-078, REQ-079, REQ-080 of the Orchestrator PRD, as designed in the Orchestrator design; the amendment of REQ-047 of the [Dashboard PRD](../product/paseo-bm-dashboard-prd.md) that REQ-079 (c) requires.

**Out of phase:**
- REQ-081 — more rules and flag trends over time (Phase O2 MVP).
- The rule "the Manager relayed an unrelated notice to the user" (design §4.2: not deterministic).
- Snapshots of flags at request end (design Q-075, deferred).
- A fallback chain for `bm-orchestrator` (design §3.1).
- Observing agents that are not paseo-bm's (PRD §3).
- Any action on agents beyond ADR-013: stopping, archiving, answering for the user, applying suggestions without a click.
- Translating `docs/archive/` or the bead history.
- Releasing: the version number, release notes, the minor-version pin of `test/plugin-role-labels.test.ts`, any publish to npm. The owner decides them after testing the finished work, and the [release runbook](../operations/paseo-bm-release-runbook.md) covers them then.

**Phase exit conditions:**
1. Every P2 acceptance criterion of REQ-071 → REQ-080 is met, with the test evidence of design §11.
2. O-1 → O-5 met: the rule fixtures of the 2026-09-26 run raise their flags and a clean trace raises none; the negative tests of O-3 and O-5 are green.
3. REQ-047 of the Dashboard PRD amended; the role and notice tables of the base design updated.
4. `npm run verify` green; `smoke:packed` green.
5. An acceptance run on an isolated daemon (`scripts/manual-test/`, the plugin installed from this branch's `plugin/` folder) with a run record in `docs/archive/operations/`: a machine set up by 0.4.1 (installed from npm, then replaced by the branch's plugin) gains the fourth role; a Small request that creates a bead raises `process.small-heavy`; with the nudge switch on the running Worker receives exactly one `BM-NUDGE`; Assess returns a `done` assessment and one suggestion is applied; removing paseo-bm's settings leaves no `bm-*` entry.

**Default checkpoint posture:** every work package changes only code and documents in this repository and is undone with git; nothing reaches a user's machine until the owner releases it, and the nudge switch is off by default. The plan has no point of no return: publishing is outside it (MVP-Lock). When the owner releases, design §10 says what a downgrade to 0.4.1 leaves behind (the `bm-orchestrator` entries and the `orchestrator/` folder) and what the release notes must say.

## 2. Work packages

### WP-501 — The Orchestrator's data store

- **Outcome:** the plugin has an `orchestrator/` folder in its data folder with the four stores the feature needs — settings, the nudge record, the model-correction log, the assessments of each workspace — each with its own read/write rules; the settings are readable and writable over RPC; removing paseo-bm's settings and deleting traces clean it up.
- **Requirements:** REQ-078 (a), (b) (settings, server side), REQ-080 (b), (c).
- **Design:** orchestrator design §2 (`orchestrator-store.ts`), §4.3 (correction log store: 500 entries; its append never throws — the hook's call to it belongs to WP-503), §5.3 (assessments file, key by `requestId`, `raw` ≤ 8 KB), §6.1 (settings), §6.2 step 4 (the `nudges.json` record: `claimed`/`delivered`, outcomes, 500 entries, stale claims after 10 minutes), §7 (`orchestrator.settings`, `orchestrator.save-settings`, `E_NUDGE_NOT_CONFIRMED`, `E_ORCHESTRATOR_WRITE_FAILED`), §3.2 row `CLEANUP_DELETES`, §9 (permissions `0700`/`0600`, atomic writes), §10 (downgrade).
- **Prerequisites:** none.
- **Exit:** tests: every file created at the right mode on first write; atomic writes survive an interrupted write; the nudge record's claim/deliver/release and its 500-entry and 10-minute rules; the correction log's 500-entry cap and a failing write that does not throw; the settings round-trip over RPC and turning the switch on without `confirmed: true` returns `E_NUDGE_NOT_CONFIRMED`; `setup.cleanup` with `deleteData: true` removes `orchestrator/` and with `false` keeps it; `traces.delete` removes the assessments of the deleted traces and nothing else; updating does not touch the folder. Base design §7.12 lists `orchestrator.settings`, `orchestrator.save-settings`, `E_NUDGE_NOT_CONFIRMED` and `E_ORCHESTRATOR_WRITE_FAILED`.
- **Boundary:** a new persistent-state seam inside the data folder only; nothing outside it is written.

### WP-502 — The fourth role `bm-orchestrator`

- **Outcome:** `bm-orchestrator` is created, configured and removed exactly like the three roles: created when missing (including on a machine already on 0.4.x), shown with a card and an additional-instructions box on Setup → Agents, run by the hook with its own instructions, the Reviewer's mode rule and model correction, no Paseo tools, excluded from the trace collector, the review budget, the format check and the fallback chains.
- **Requirements:** REQ-077, REQ-079 (a) (the role exists only to be created on confirmation).
- **Design:** orchestrator design §3.1, §3.2 (every place listed, with its decision, **except** the `CLEANUP_DELETES` row, which is WP-501's), §10 (compatibility table); base design §6.2 (`ROLE_PROFILE_IDS`), §7.2 (hook), §7.13 (roles on Setup); `roles/orchestrator.md` content per design §6.4 and §5.3 (read-only, one `bm_assessment` call, rubric meaning, English).
- **Prerequisites:** none.
- **Exit:** tests: `ensureRoles` on a config with the three roles creates only `bm-orchestrator` and leaves the others byte-identical; `setup-state.json` keeps `rolesCreated.roles` to the three roles and records `orchestratorCreatedAt`, and the 0.4.1 schema (from tag `v0.4.1`) still parses it; the 0.4.1 `roles.save-settings` code still saves another role on a config that contains `bm-orchestrator`; `bmRoleSchema` still has three values and `role-fallback-state.json` written by 0.4.1 still parses; the hook injects `orchestrator-instructions`, a mode under the Reviewer rule (a `dangerous` or `planning` mode is replaced, `auto_accept` stays off), the profile model, and no `paseoTools` (its tool endpoint is WP-504's); `roles-content` checks that `orchestrator.md` has the read-only rules, the one-call rule and the 1–5 scale, and the generated `orchestrator-instructions.ts` matches the Markdown byte for byte; the collector records no turn of the new role; cleanup removes `bm-orchestrator`; the tests that pinned three roles are updated. The base design's role table lists four roles.
- **Boundary:** writes to the user's Paseo configuration (new entries only, through the existing `config.patch` path) and a compatibility seam with 0.4.1 stored data — the exit tests above are that seam's proof.

### WP-503 — Rules and flags

- **Outcome:** each request of a paseo-bm trace has a set of deterministic flags with evidence, served over RPC for one request and as counts for a page of requests; the hook records its model corrections so the `agent.model-corrected` rule has data; the `BM-NUDGE` marker exists as a plugin notice, and a notice can no longer show as a Worker's initial prompt on the Metric screen.
- **Requirements:** REQ-072, REQ-073 (a), (b) (server side), REQ-074.
- **Design:** orchestrator design §4.1 (`RuleInput`, `ruleInputOf`, the reconstruction helper shared with `review-budget.ts`), §4.2 (the seven rules and their data), §4.3 (correction log written by the hook), `language-guess.ts` (§4.2), §6.3 (the `BM-NUDGE` constant in `PREFIXES` of `shared/notices.ts`, and the accompanying fix: `workerInitialPrompts` filters plugin notices), §7 (`orchestrator.flags` — its `nudges` field returns `[]` until WP-505 fills it — and `orchestrator.flag-counts`); dashboard design §6.
- **Prerequisites:** WP-501 (correction log store), WP-502 (the hook change touches the same `role-hook.ts` code and must know the new role).
- **Exit:** tests: each rule raises on its fixture, stays silent on a clean trace and returns `unknown` when its data is missing; the fixtures of the 2026-09-26 run (Small with a bead, Manager switching to English after a `BM-REPORT`, a corrected model, a Worker failing its first turn) each raise their flag (O-1); `language-guess` on Vietnamese with and without diacritics, English, code-only, mixed and a third language; `review-budget` still passes its existing tests on the shared helper; `orchestrator.flags` and `orchestrator.flag-counts` read only paseo-bm traces (negative test, REQ-074), and `flag-counts` refuses more than 50 ids; the hook's call to the correction log never makes a creation fail; `isPluginNotice` recognises `BM-NUDGE`, and `workerInitialPrompts` excludes a `BM-NUDGE` that opens a Worker turn. Base design §7.12 lists `orchestrator.flags` and `orchestrator.flag-counts`.
- **Boundary:** refactoring the reconstruction that `review-budget` uses is a behaviour-preservation seam: its existing tests must stay green unchanged.

### WP-504 — Assessment on demand

- **Outcome:** a request can be assessed: a preview says what will run and be sent; on confirmation exactly one `bm-orchestrator` agent runs one turn; its structured result is read from its timeline and stored; a suggestion can be added to a role's additional instructions on confirmation, without overwriting a concurrent Setup edit.
- **Requirements:** REQ-075, REQ-076, REQ-079 (a), (b), (d) for the create action, REQ-079 (c) (the REQ-047 amendment), REQ-080 (a).
- **Design:** orchestrator design §5.1 (flow, explicit `modeId`), §5.2 (content, redaction, 60,000-character cap, truncation), §3.1 (the hook's `mcpServers`/`toolPolicy` injection for `bm-orchestrator`, only when the base provider is in `TOOL_PROVIDERS`), §5.3 (`bm_assessment` tool on `/mcp/orchestrator` — the path regex of `agent-tools.ts` gains the role — schema, tool-name match by suffix, hand-written `BM-ASSESSMENT` fallback, storage key), §5.4 (errors), §7 (`orchestrator.assess-preview`, `orchestrator.assess`, `orchestrator.assessments`, `orchestrator.apply-suggestion` with `expectedHash`, `E_ASSESS_UNAVAILABLE`, `E_SUGGESTION_TOO_LONG`, `E_ROLE_EXTRA_CHANGED`); ADR-010 (tool without side effects, unchanged).
- **Prerequisites:** WP-501 (assessments store), WP-502 (the role and its instructions), WP-503 (flags are part of the content sent).
- **Exit:** tests: the hook gives a `bm-orchestrator` agent the `paseo-bm` server at `/mcp/orchestrator` with only `bm_assessment` pre-approved on Claude/Codex/OpenCode, and nothing on another provider; `tools/list` on that path lists only `bm_assessment`; without `confirmed: true` nothing is created; with it exactly one agent is created with the right provider, mode and labels; the reader stores `done` from a Claude-style and a Codex-style tool call, and from a hand-written block, and `failed` with `raw` otherwise; a second turn of the same agent does not change a `done` result; the content is redacted and capped; `apply-suggestion` appends, refuses over 8,000 characters with `E_SUGGESTION_TOO_LONG` without writing, and refuses a stale `expectedHash` with `E_ROLE_EXTRA_CHANGED`; the Dashboard PRD's REQ-047 is amended in the same change; base design §7.12 lists the four assessment RPCs and `E_ASSESS_UNAVAILABLE`, `E_SUGGESTION_TOO_LONG`, `E_ROLE_EXTRA_CHANGED`.
- **Boundary:** a trust boundary (the plugin creates an agent and sends conversation content to a provider): the negative tests above and REQ-079 (d) are required; no other `agents.create` path is added.

### WP-505 — Nudges

- **Outcome:** with the nudge switch on and a rule selected, the Manager receives a `BM-NUDGE` at the end of its turn for its rule, and a running Worker of a Small request is watched and receives a `BM-NUDGE` — interrupting its running turn — as soon as its rule is seen; never a Worker waiting for the user or finished; at most once per rule and request; switching off stops everything; Manager and Worker instructions know what a `BM-NUDGE` is.
- **Requirements:** REQ-078 (c) → (e), (f) (recording; the count on the tab is WP-506's), (g), REQ-079 (a), (b), (d).
- **Design:** orchestrator design §6.2 (turn-end decision, steps 1–7), §6.3 (format, the interrupted-step line), §6.4 (role instruction changes, line caps of `test/roles-content.test.ts`), §6.5 (live watcher: start/stop conditions, 5 Workers, 30-second non-overlapping passes, 200-entry reads, 30-minute cap), §9 (only two actions); ADR-013 decision 3; base design (notice queue: new `drop(kind)` only).
- **Prerequisites:** WP-501 (settings and nudge record), WP-503 (`RuleInput`, the rules).
- **Exit:** tests: switch off → no timer and 0 sends (O-3, O-5); the watcher starts only for a running Worker of a Small request, stops at turn end, after a nudge, after 30 minutes and when the switch goes off, never watches more than 5 and never overlaps passes; a `br create` or a write under `docs/…` in a fake live timeline raises the flag and sends once; a latest report `blocked` or `finished` (recorded, or live through `bm_report` input or a `send_agent_prompt` message) blocks the send; the key is released when `send` fails; the Manager's language rule is sent through the queue at its turn end; `drop("BM-NUDGE")` on switch-off; `orchestrator.flags` returns the delivered nudges of a request with their outcome; the three existing notice kinds behave as before; the full negative set of REQ-079 (b), (d) — across every Orchestrator path, no `archive`, `cancel`, config write outside role creation, instruction write outside `apply-suggestion`, or `send` of anything but a `BM-NUDGE`; `roles-content` tests updated for `BM-NUDGE` in both notice sentences within the line caps (or one documented raise). The base design's notice table lists `BM-NUDGE`.
- **Boundary:** the second trust-boundary action (sending into agents' chats, and interrupting a running Worker): its negative tests are required. The role-file change is product behaviour for every user (AGENTS.md: Designed) and is covered by ADR-013.

### WP-506 — The Orchestrator tab on Setup

- **Outcome:** Setup has a fourth tab showing the recent requests of every workspace with their flag counts, the most frequent flags and the averages by size, over 7/14/30 days (14 by default); the nudge switch with its warning dialog and rule choices; clicking a request opens its trace on the Metric screen of the right workspace.
- **Requirements:** REQ-071, REQ-078 (a), (b) (screen), REQ-078 (f) (the count on the tab).
- **Design:** orchestrator design §7 (`orchestrator.overview`: caps of 50 requests per workspace and 300 in total, `truncated`, one `agents.list` for all workspaces, nudge counts from `nudges.json`), §8.1 (tab, `SETUP_TABS`, `ConfirmBlock` text, `onOpenTrace` callback and `initialTraceId` on `DashboardPanel`); dashboard design §11.3 (Setup tabs).
- **Prerequisites:** WP-503 (flags), WP-501 (settings RPC), WP-505 (the nudge record it counts, and the switch's behaviour the dialog describes).
- **Exit:** tests (pure models, no `react-native` value import in `test/`): overview aggregation, caps and `truncated`, nudge counts per request and for the period, empty state; `orchestrator.overview` makes no `agents.create`, no `send` and no timeline read (REQ-071 e); the tab's text and the switch's confirmation; `onOpenTrace` sets the workspace and view and the card of that trace opens. The dashboard design §11.3 lists four tabs; base design §7.12 lists `orchestrator.overview`.

### WP-507 — Flags, nudges and assessments on the Metric screen

- **Outcome:** a request on the Metric screen shows its flags with their evidence, the nudges it received, an Assess button with the preview confirmation, its assessments with scores, findings and suggestions, and the "Add to <role>'s instructions" action.
- **Requirements:** REQ-073 (a) → (c), REQ-075 (a), (b), (e), (f) (screen), REQ-076 (a), (b).
- **Design:** orchestrator design §8.2 (the `⚑ N` counts from one `orchestrator.flag-counts` call per page), §4.1 (the "based on the agents that still exist" note), §5.3 (the "linked by turn" label); dashboard design §12 (request card, `requestGraph` chip groups, subtitle).
- **Prerequisites:** WP-503 (flags), WP-504 (assessment RPCs), WP-505 (nudges in `orchestrator.flags`).
- **Exit:** tests (pure models): the `⚑ N` subtitle from one `flag-counts` call per page, the Flags chip group and evidence lines, the "based on the agents that still exist" note when `linking` is not `exact`, the "linked by turn" label, the Open agent and Refresh buttons of a `pending` assessment, the "Orchestrator nudge" lines, the preview dialog text from `assess-preview`, assessment rendering for `pending`/`done`/`failed`, the suggestion dialog showing the text after appending and `chars / 8,000`. The dashboard design §12 describes these elements.

### WP-508 — User documents and acceptance

- **Outcome:** users can read about the Orchestrator; the finished work passes the acceptance run on an isolated daemon, so the owner can test it and decide on a release.
- **Requirements:** every REQ of the MVP-Lock (observed evidence); PRD Phase O1 exit criteria.
- **Design:** orchestrator design §11 (acceptance row); `scripts/manual-test/README.md` (the acceptance kit, extended with the Orchestrator scenarios).
- **Prerequisites:** WP-501 → WP-507.
- **Exit:** GUIDE.md, README.md and `plugin/README.md` describe the tab, flags, Assess (what is sent and that it costs tokens) and the nudge switch (including that it interrupts a running Worker), without naming a version; `scripts/manual-test/README.md` gains the Orchestrator scenarios of phase exit 5 (update from 0.4.1, the Small request with a bead, the nudge switch, Assess and apply); the acceptance run record (phase exit 5) in `docs/archive/operations/`; the plan closed (`Status: Completed`).
- **Boundary:** no version bump and no publish (MVP-Lock). Acceptance never touches the owner's real daemon or `~/.paseo-bm`.

## 3. Dependencies

| WP | Needs | For which product |
|---|---|---|
| WP-503 | WP-501, WP-502 | the correction log store; the hook code that knows the fourth role |
| WP-504 | WP-501, WP-502, WP-503 | the assessments store; the role, its instructions and tool endpoint; the flags sent as content |
| WP-505 | WP-501, WP-503 | the settings and nudge record; `RuleInput` and the rules |
| WP-506 | WP-501, WP-503, WP-505 | the settings RPC; the flags for the overview; the nudge record it counts |
| WP-507 | WP-503, WP-504, WP-505 | flags; assessment RPCs; nudges returned by `orchestrator.flags` |
| WP-508 | WP-501 → WP-507 | the finished feature |

WP-501 and WP-502 have no prerequisite and can run in parallel. No cycles.

## 4. Risks

| Risk | Mitigation |
|---|---|
| A nudge interrupts a Worker mid-command and leaves a half-done state | ADR-013 consequence accepted by the owner; the nudge tells the Worker to check its state first; only Small requests, once per rule and request, only with the switch on; acceptance observes one interruption end to end |
| The watcher costs too much or misbehaves on a busy machine | Hard caps (5 Workers, 30 s, 200 entries, 30 min), no overlap, no timer when the switch is off; tests pin each cap |
| Adding a fourth role corrupts data stored by 0.4.1 (enum widening) | Design §3.2/§10 decisions; WP-502 exit tests run the 0.4.1 schemas against the new data |
| `language-guess` raises false flags | Conservative thresholds, `unknown` for anything that is not clearly Vietnamese or English; the flag is a warning, never an action unless the owner selects it for nudging |
| An assessment agent returns malformed output or costs more than expected | `failed` with the raw reply; the preview shows the model and the size before anything runs; one agent, one turn |
| A concurrent Setup edit is overwritten by "Add to instructions" | `expectedHash` → `E_ROLE_EXTRA_CHANGED` |
| Agents created by an older release do not know `BM-NUDGE` | Switch off by default; the notice explains itself |
| Paseo changes how `send` behaves on a running agent | The existing stop propagation relies on the same behaviour; the acceptance run checks it on Paseo 0.9.2 |
| Role files exceed their line caps | Write compactly; at most one documented raise per file (design §6.4) |
| Downgrading to 0.4.1 leaves `bm-orchestrator` and `orchestrator/` behind | Accepted by the owner; design §10 records what the release notes must say when the owner releases |

## 5. Open questions

| ID | Question | Owner | Status | Blocks |
|---|---|---|---|---|
| Q-075 | Snapshot flags at request end so that they do not change when an agent is deleted | hieu.nt10 | deferred (design §12) | nothing in this phase |
| Q-076 | Release number, and moving the minor-version pin of `test/plugin-role-labels.test.ts` | hieu.nt10 | **answered (2026-09-28)** — not in this plan: the owner decides after testing the finished work | nothing in this phase |

## 6. Test strategy

- **Unit (Vitest):** every new server module (`orchestrator-store`, `orchestrator-rules`, `language-guess`, `assessment`, `nudge` and its watcher, `orchestrator-rpc`) with a fake SDK, fake timers for the watcher and a temporary data folder; the client's pure models (`orchestrator-model`, the Metric additions) — no `react-native` value import in `test/` (AGENTS.md). Design §11 is the detailed test table.
- **Fixtures:** trace fixtures rebuilt from the 2026-09-26 run for O-1, plus a clean trace.
- **Compatibility:** the 0.4.1 schemas and save code (from tag `v0.4.1`) run against data written by the new code (WP-502).
- **Negative (trust boundary):** no `agents.create` without confirmation; no send with the switch off; never a send to a Worker whose latest report is `blocked`/`finished`; no `archive`/`cancel`; no read of a non-paseo-bm agent; no write outside the data folder and the `config.patch` scope.
- **Role files:** `roles-content.test.ts` for `BM-NUDGE` and `orchestrator.md`; generated instructions match.
- **Packaging:** `smoke:packed` for the plugin tarball.
- **Acceptance:** isolated daemon with `scripts/manual-test/`, the plugin installed from the branch's folder over a 0.4.1 setup (WP-508).
- **No new coverage threshold.** Existing tests stay green, apart from the ones that pinned three roles, updated in WP-502.

## 7. Revision History

| Date | Who | Change |
|---|---|---|
| 2026-09-28 | hieu.nt10 (drafted by Claude) | Owner: no version bump or release in this plan — the owner tests the finished work first. Release, version and minor-version pin moved out of phase (Q-076 answered); WP-508 is user documents and acceptance; acceptance installs the branch's plugin over a 0.4.1 setup; file renamed from `paseo-bm-plan-050-orchestrator.md` |
| 2026-09-28 | hieu.nt10 (drafted by Claude) | Second review (3 findings): WP-502's mode test follows REQ-077 (c) (no `planning` mode either, `auto_accept` off); WP-506 proves REQ-071 (e); WP-508 extends the manual-test kit that phase exit 5 relies on |
| 2026-09-28 | hieu.nt10 (drafted by Claude) | After an independent review (7 findings): design gained the `nudges.json` record, `orchestrator.flag-counts` and nudge counts; WP-501 owns the stores and `CLEANUP_DELETES`, WP-503 the `BM-NUDGE` marker and the hook's call to the correction log, WP-504 the tool endpoint injection, WP-505 the nudges in `orchestrator.flags` and the full REQ-079 negative set, WP-506 the nudge count (new edge WP-506 → WP-505); every RPC and error code has a WP that adds it to base design §7.12; WP-502 and WP-507 exits completed |
| 2026-09-28 | hieu.nt10 (drafted by Claude) | First version, Draft: eight work packages from the Active Orchestrator design and the Accepted PRD and ADR-013; self-evaluated against `plan-ready-for-beads` (§8) |

## 8. Gate `plan-ready-for-beads` — self-evaluation (2026-09-28)

- **Header:** Status Draft, Plan-ready Pending, owner, Routing Decision linked, PRD + design + ADR linked, phase named "Phase O1 MVP" — ✓
- **MVP-Lock:** REQ-071 → REQ-080 + the REQ-047 amendment; out of phase listed, releasing included; five exit conditions; checkpoint posture: no point of no return in the plan — ✓
- **Work packages:** 8 (WP-501 → WP-508), each with outcome, requirements, design references, prerequisites, exit — ✓
- **Dependencies:** 20 edges, acyclic, each naming the product the dependent WP needs — ✓
- **Risks and open questions:** 10 risks with mitigations; Q-075 deferred, Q-076 answered (out of plan) — ✓
- **Test strategy:** per layer, fixtures, compatibility, negative, acceptance — ✓
- **Applicable modules:** persistent state (WP-501, WP-502 boundaries), consumed contracts (RPCs additive, `BM-NUDGE` new, `bmRoleSchema` kept), trust boundary (WP-504, WP-505 negative tests); R3 not applicable (no publish in the plan) — ✓
- **Decomposition-readiness:** every blocking design choice (file shapes, RPC shapes, error codes, rule thresholds, watcher caps, tool name matching, storage keys) is in the design; boundaries are named on the WPs that cross seams; sequencing is explicit — ✓
- **Warnings:** 8 WPs in one phase is at the limit but each is a coherent slice; plan length about 5 pages.

**Verdict: PASS on self-evaluation.** Becomes `Status: Active` with `Plan-ready: PASS — <date> — hieu.nt10` when the owner approves; then `converting-plan-to-beads`.
