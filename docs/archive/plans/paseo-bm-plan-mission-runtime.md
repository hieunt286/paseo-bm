# Implementation Plan — The mission runtime (ADR-033)

| Field | Value |
|---|---|
| Status | Completed — 2026-10-10: every work package built and verified; the drill (§7) is the owner's |
| Plan-ready | PASS — 2026-10-10 — Claude under the owner's delegation (the owner approved the five changes; `plan-ready-for-beads` self-evaluated: locked scope, per-WP exits, dependencies, compatibility, rollback) |
| Owner | hieu.nt10 |
| Routing decision | [ADR-033 § Routing Decision](../../adr/ADR-033-the-mission-is-the-system-of-record.md#routing-decision) |
| Requirements | [Missions PRD](../../product/paseo-bm-missions-prd.md) Phase 5: REQ-202 → REQ-208, M-31 → M-35 |
| Technical Design | [paseo-bm-mission-runtime.md](../../design/paseo-bm-mission-runtime.md) |
| Starts after | ADR-032's build (uncommitted on `feat/missions`), which this plan folds in |
| Target release | none in this plan: it stops at acceptance; the owner tests, picks the version and releases |

## 1. MVP-Lock

- **In:** design §2–§9 and §10's measures; the replay's A-14.
- **Out:** Worker handoff and Worker compaction rules (unchanged); unbound per-workspace Managers outside missions (unchanged); event-sourcing the stores; a release.
- **Exit:** every WP's exit; `npm run verify` green after `npm run build`; the mission page matches an approved mockup (WP-6.1); the isolated-daemon drill is listed for the owner.
- **No new mechanisms meanwhile:** nothing outside this plan is added to the mission runtime until its exit.

## 2. Work packages

| WP | Outcome | REQ | Design | Needs | Exit |
|---|---|---|---|---|---|
| WP-1.1 | `missionStateOf` and `renderMissionState`, every source of §2.1, the request-state rules, the 6,000-character rendering | REQ-202 | §2.1, §2.2 | — | unit tests: each source, each state, the bound, masking |
| WP-1.2 | The writes of §2.3: follow-up (roster `followUpAt`, active), report-phase journal lines, link lines (ask, take, reply, close) | REQ-202 | §2.3 | — | unit tests per writer; no change to the outbox or the delivery texts |
| WP-1.3 | Consumers: the Main's first prompt (`mainBriefOf`), its `BM-STATE` (`managerBrief` for a Main), the governor's wake brief; `mission.get` gains `inFlight` and `mainHistory` | REQ-202 | §2.2, §7 (RPC only) | WP-1.1, WP-1.2 | the M-31 property test: replace the Main after each event of a scripted mission; the brief holds every in-flight item |
| WP-2.1 | `compact.main` settings, `mainContextOf`, the Main's crossing and hard figure; no token sum for a Main | REQ-203 | §3.1, §3.2 | — | unit tests: Claude with and without `contextMax`, Codex, the XAI turn (110,000 used, 427,000 read) does not cross at defaults |
| WP-2.2 | In-place compaction of a Main: trigger, no cap, no intervention entry, `BM-STATE` from the mission state; handoff only in §3.5's cases | REQ-203 | §3.3, §3.5 | WP-1.3, WP-2.1 | unit tests: compaction instead of handoff; each handoff case; the guard ignores Main compactions |
| WP-2.3 | One replacement path: `replaceMain` single flight, compare-and-set, idempotent; `createMain` creates only; `mission.ensure` joins an in-flight creation; no Worker notice; replaced Main tools refuse | REQ-203 | §3.4, §3.6 | — | unit tests: the XAI race (an ensure during a handoff) gives one journal line and one re-pointing; no `BM-SETTINGS` sent; a replaced Main's write tool refused |
| WP-3.1 | `deciderOf` with the rules of §4.1 and the caps of §4.3; the materialiser, `bm_answer_worker`, `bm_decide` and the mission state call it; the ten-minute window and the grant rule retired | REQ-204 | §4.1–§4.3, §4.5 | WP-1.1 | unit tests: every rule; a review budget at Full auto answered by code, then by the Main, then the owner; `untilClean` bounded |
| WP-3.2 | The Main told of its questions (§4.4) | REQ-204 | §4.4 | WP-3.1 | unit test: a question for the Main delivers one item; one for the owner none |
| WP-3.3 | `bm_owner_question` and `m:` questions; `bm_answers` accepts `m:` ids; answers reach the Main; journal lines; the role file | REQ-205 | §4.6, §8 | WP-1.1 | unit tests: open, answer on the card, answer in chat with and without an owner-typed message; role-content tests |
| WP-4.1 | The notice queue's per-item callbacks; the Main's channel (`BM-UPDATES`) for the outbox, commands and `BM-SIGNAL`; `BM-UPDATES` a plugin notice | REQ-207 | §6.2 | WP-3.2 | unit tests: three items pending → one message; per-item delivered, dropped, retargeted; `first` |
| WP-4.2 | The chat splits `BM-UPDATES` into cards; the role file's line | REQ-207 | §6.2, §8 | WP-4.1 | client parse tests |
| WP-4.3 | Removals: `BM-SETTINGS` on replacement (done in WP-2.3), `BM-BUDGET` to the Main; the governor's `stalled` exclusions | REQ-207 | §6.1, §6.3 | — | unit tests: no budget notice; a request waiting on an active request, and a stopped one, not stalled |
| WP-4.4 | A-14 in the replay (Main turns by trigger) | REQ-207 | §10 | — | eval test |
| WP-5.1 | `transferRequests`; the split uses it | REQ-206 | §5.1 | — | unit tests; the split tests unchanged in outcome |
| WP-5.2 | The merge card (`mission-merge`) and the transfer card (`mission-transfer`), opening points and apply | REQ-206 | §5.2, §5.3 | WP-5.1 | unit tests: XAI over AIAS/XSPA offers two cards; apply closes the legacy mission and moves its requests |
| WP-5.3 | The close rule (running only; active → stopped); `manager.ensure { requestId? }`; `missionOfWorkspace` ordering; Work passes its request | REQ-206 | §5.4, §5.5 | — | unit tests: an idle Worker does not block; ordering |
| WP-6.1 | Mockup of the mission page's In flight and Main history, for the owner's approval | REQ-208 | §7 | WP-1.3 | the owner approves the mockup |
| WP-6.2 | The mission page parts as approved, checked in the preview harness | REQ-208 | §7 | WP-6.1 | client tests; visual check against the mockup |
| WP-6.3 | Docs as built, closure, the drill listed for the owner | all | §11 | all | `npm run verify` green after `npm run build`; bundle under 2,000,000 bytes |

**Order:** P1 (WP-1.x) → P2 (WP-2.x) → P3 (WP-3.x) → P4 (WP-4.x) → P5 (WP-5.x) → P6. WP-2.3, WP-4.3, WP-4.4, WP-5.1 and WP-5.3 have no prerequisite and may run beside their phase.

## 3. Backward compatibility

- **Stored formats:** all additive (design §9). An older build ignores the new fields; it skips an `m:` decision carrying a prepared action it cannot parse.
- **Deliveries:** a `BM-UPDATES` message holds the exact blocks a Main already reads; a Main created before the role-file change is outdated once and replaced by the usual path.
- **RPCs:** `mission.get` and `manager.ensure` gain optional fields only.
- **Settings:** `compact.main` defaults apply to an existing settings file.

## 4. Rollback and containment

- Each phase is its own commit set on the branch; reverting a phase leaves the earlier ones working. P4's channel and P2's replacement path are the riskiest; both keep the old delivery texts, so a revert restores the old shapes with no stored-format change.
- `compact.main.enabled: false` and `handoff.enabled: false` remain the owner's switches.

## 5. Test strategy

Targeted tests per WP while building (no piecemeal full runs); one `npm run verify` after `npm run build` at the end of each phase; the M-31 property test in P1; role-content tests whenever a role file changes.

## 6. Risks

- **The Main's role file at 100 lines:** the new instructions replace older ones (prose asks, the ten-minute rule) rather than add.
- **Compaction on a provider that reports no context:** the estimate of §3.1 applies; without any figure nothing crosses, and the owner's settings stay the switch.
- **Batching changes the chat's look:** each block keeps its card; WP-4.2 tests the split.

## 7. Closure

Every work package is built and its bead closed with evidence (beads `bm-mission-runtime-4xn1.*`). The design records each phase as built (its Revision History); the main departures from this plan:

- Settings are the coordination group `main.*` (`main.compact`, `main.contextShare`, `main.contextTokens`, `main.hardShare`), not `compact.main`.
- The owner's chat answer to the Main's own question is recorded with `bm_owner_question`'s `answered`, not `bm_answers`.
- One item alone on the Main's channel goes as its block, without a `BM-UPDATES` wrapper.
- `busyRequestsOf` (a Worker running a turn) holds a close and a merge; `runningRequestsOf` stays for staffing.
- No client entry point opens a Manager for one request (Work's "Open Manager" is per project): `manager.ensure` takes `requestId`, and the owner's mission comes before a legacy one by workspace.
- The visual check of WP-6.2 rendered the real components with react-native-web and headless Chrome (no new dependency), not the earlier Vite harness.

**The owner's drill** (on an isolated daemon, a packed build, never `~/.paseo`):

1. **Merge.** Two repos each with a legacy one-repo mission; create an owner mission over both. Two merge cards open on it. Apply one: the legacy mission closes (`mergedInto`), its requests and Workers report to the new Main, its old Main is titled "· merged into <code>" and not archived. Keep the other: it is not asked again.
2. **A Main replaced mid-work.** With a Worker working and a question open, clear the Main's conversation (or let its context pass the hard figure after a compaction). The successor's first reply says it took over and what is in flight; the mission page's Main card shows both Mains; the Worker's next report reaches the successor; nothing in flight is lost (M-31).
3. **A long-lived Main.** A long session compacts the Main in place below `main.hardShare` without a new Main (M-32).
4. **A review budget at Full auto.** A Worker needing more review calls is granted by code within the code cap, by the Main within its share, and asks the owner only beyond both (M-34).
5. **The Main's channel.** Several reports while the Main is busy arrive as one `BM-UPDATES` turn, drawn as one card each; a `danger` goes first. The replay's A-14 shows the owner's share of the Main's turns (M-33 ≥ 50 %).
6. **Closing.** Close a mission whose Workers sit idle: it closes and its active requests read `stopped`.
7. **The mission page.** In flight lists each request's state and whom it waits on, the open questions by who decides, the Main's asks and live links; "Answer" opens the Inbox; "Open" opens a previous Main.

Releasing stays out of this plan: the owner tests, picks the version and releases.
