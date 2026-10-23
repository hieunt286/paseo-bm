# Implementation Plan — The delivery line (ADR-035)

| Field | Value |
|---|---|
| Status | **Completed** — 2026-10-21: Phases 6–9 built and verified; the isolated-daemon drill and the shared-tree migration are the owner's (§7) |
| Plan-ready | PASS — 2026-10-20 — Claude, under the owner's delegation. Each phase is converted to beads when it starts. Phase 8 is checked again after its spikes (WP-8.0) |
| Owner | hieu.nt10 |
| Routing decision | [ADR-035 § Routing Decision](../../adr/ADR-035-a-delivery-line.md#routing-decision) |
| Requirements | [Missions PRD](../../product/paseo-bm-missions-prd.md) Phases 6–9: REQ-209 → REQ-215, M-36 → M-42; [base PRD](../../product/paseo-bm-prd.md) REQ-037, M-17 |
| Technical Design | [paseo-bm-delivery-line.md](../../design/paseo-bm-delivery-line.md) |
| Evidence | [Field review 2026-10-20](../operations/paseo-bm-field-review-20261020.md) |
| Branch | Built in the working tree from `main` at `7f6abd3`; the owner picks the branch when they ask for a commit |
| Target release | None in this plan. It stops at acceptance: the owner tests, picks the version and releases |

## 1. MVP-Lock

- **In:** delivery line design §2–§9, the role files (§10), the stored formats (§11), the screens of §12 (each behind an approved mockup), the measures and tests (§13), and the spikes (§14).
- **Out:**
  - letting Workers of two missions talk directly;
  - letting the Main's answer cover effects;
  - reusing a Worker across a continuation;
  - a worktree per request;
  - merging a merge request;
  - any release.
- **Exit:**
  - every work package's exit is met;
  - `npm run verify` passes after `npm run build` at the end of each phase;
  - the bundle stays under 2,000,000 bytes;
  - the PRD §9 automated acceptance of each phase passes;
  - the owner's drills and the shared-tree migration are listed for the owner.
- **No new mechanisms meanwhile.** Nothing outside this plan is added to the flow until its exit.

## 2. Work packages

### Phase 6 — Limits that hold (decisions 4, 6, 7)

| WP | Outcome | REQ | Design | Needs | Exit |
|---|---|---|---|---|---|
| WP-6.1 | Milestone batches and convergence: `batches[].milestone` and `results`; `bm_create_reviewer` `milestone`/`since`; `bm_rereview` rules 1–4; the stop texts | REQ-037 a, b | §5.1, §5.2 | — | Unit tests: a pass refuses; 3 → 2 allowed; 3 → 3, unknown and K refused; results appended by `bm_review` and no-verdict; an old batch read from the trace |
| WP-6.2 | The cap: `reviewCapOf` used by the tools, rules, stall reason, `overrunOf` and the governor; the owner-only `review-cap` decision once per request; `applyReviewCapAnswer` | REQ-037 d, e, g | §5.3, §5.4 | WP-6.1 | Unit tests: cap per tier × milestones, pooled; one question per request; a second hit refused; only the owner's answer grants |
| WP-6.3 | Retirements and the sweep: the review rules in `authority.ts`, `authority-facts.ts`, `answerBudgetByPolicy`, `applyReviewBudgetGrants`, `untilClean`, "share leaves"; the upgrade sweep withdraws open `review-budget` questions | REQ-037 g, REQ-204 b | §5.6 | WP-6.2 | Every pinning test rewritten or removed; sweep test (idempotent, one withdrawal delivery) |
| WP-6.4 | Settings: `review.maxRereviews`, `review.callsPerBatch`; old keys ignored, refused by `coordination.set`; prepared changes; the Settings steppers and computed caps; the Runtime facts line; the governor figures `reviewCapReached`, `unconvergedBatches`; the Orchestrator's advice | REQ-037 d | §5.6 | WP-6.2 | Settings store and model tests; runtime-facts test; advice test |
| WP-6.5 | Precedent-eligible subjects: `shared/question-subjects.ts`; every saving and applying caller; `inert` in the list and Settings | REQ-213 c | §7.4 | — | Unit tests: the card, Settings, the prepared change and the resolver agree; `review-budget` and `review-cap` refused |
| WP-6.6 | Effects stated by what was done: `server/effects.ts` and the call sites of §7.3; the guard test | REQ-213 d | §7.3 | WP-6.3 | The guard test; each converted site's test shows the applied effect |
| WP-6.7 | A decider who can decide; one card per question: `deciderOf` resolvability; `bm_owner_question` `about`, the duplicate refusal, the attached `prediction.main` | REQ-213 a, b | §7.1, §7.2 | WP-6.3 | Unit tests: the Main on mission-only `answer-effects` → owner; an `f:` with every option refused → owner; a duplicate `m:` refused, its recommendation on the `q:` |
| WP-6.8 | Governor pools and degradation: `governorStep`/`by`, four pools, a free repeat arbitration and re-plan, held families, the daily digest, the step-4 gate on `bm_ask_owner` | REQ-214 a, b, c | §8.1–§8.3 | — | Unit tests per pool; repeat spends nothing; digest once a day; gate refusal text |
| WP-6.9 | Drift and stalled: the trace `trigger`; drift by trigger; `metAt`; stalled hysteresis | REQ-214 d, e | §8.4 | — | Collector test for each trigger; drift figure tests; a re-woken blocked request no longer flips |
| WP-6.10 | Older governors relabelled `retired` and retitled | REQ-214 f | §8.5 | — | Unit test: idempotent at creation and at start; nothing archived |
| WP-6.11 | Role files for Phase 6: `worker.md` "Reviewing" and milestones, `reviewer.md` scopes, `orchestrator.md` review and step-4 lines, `manager.md` recommend-on-the-card line; generated instructions | REQ-037, REQ-213, REQ-214 | §10 | WP-6.1 → WP-6.8 | Role-content tests; `npm run build` |
| WP-6.12 | Phase 6 close: docs as built (base design §7.7, §7.17.8, §16.8; mission runtime §4; orchestrator §6A; missions §9.2–§9.4), the replay's M-39 and M-41 | — | §13 | all of Phase 6 | `npm run verify` after `npm run build`; replay on recorded field data shows the figures |

### Phase 7 — Bounded requests and waits (decisions 1, 5)

| WP | Outcome | REQ | Design | Needs | Exit |
|---|---|---|---|---|---|
| WP-7.1 | A finished bound request is final: chain fields; `noteReport`/roster never reopen; a late report refused with its continuation | REQ-209 a | §2.2, §2.3 | — | Registry and roster tests; the unbound path unchanged |
| WP-7.2 | Continuations: `openContinuation`; `bm_tell_worker` on a finished request; the brief block; `chainHeadOf` and the audit of every `soleWorkerOfRequest` caller | REQ-209 b, e | §2.4, §2.5, §2.7 | WP-7.1 | Continuation tests (links on both sides, staffing, refused creation); delivery to the chain head |
| WP-7.3 | Size rollover: settings, `BM-ROLLOVER soft`/`now`, `remaining`, what carries over at the hard figure | REQ-209 c, d | §2.6 | WP-7.2 | Rollover tests: one soft notice, hard at 2×, a `size` continuation, an answer reaching the head |
| WP-7.4 | Structured waits: report fields, the registry's `waiting`, the settle hooks for questions, links, batches and requests | REQ-212 a | §6.2, §6.3 | — | Unit tests per item kind; promotion of a `req-…` id from text |
| WP-7.5 | The wake gate: outbox `held`, the gate at the four delivery points, the Worker's `BM-UPDATES` release, `now: true`, the always-at-once list | REQ-212 b, c | §6.4 | WP-7.4 | Wake-gate tests; a held record survives a reload |
| WP-7.6 | Structural waits in the stall watcher and the governor (`structuralWaitOf`); a dead item wakes once | REQ-212 d | §6.5 | WP-7.4 | Stall-watcher and governor tests |
| WP-7.7 | The maintenance ceiling for compaction, handoff and rollover; a `no-safe-point` drop counts | REQ-212 e | §6.6 | WP-7.3 | Compaction and handoff tests at the ceiling |
| WP-7.8 | Role files for Phase 7 (`manager.md`, `worker.md`) and the signal-budget rows | REQ-209, REQ-212 | §6.7, §10 | WP-7.2 → WP-7.7 | Role-content tests; `npm run build` |
| WP-7.9 | The seeded scenario test (M-36, M-40, M-42) | — | §13 | WP-7.1 → WP-7.7 | The four invariants hold over 2,000 scripted turns |
| WP-7.10 | Mockup of the request chain (mission page In flight, Projects › Requests) for the owner's approval | REQ-209 e | §12 | WP-7.2 | The owner approves the mockup |
| WP-7.11 | The chain on the screens, as approved, checked in the preview harness | REQ-209 e | §12 | WP-7.10 | Client tests; visual check against the mockup |
| WP-7.12 | Phase 7 close: docs as built (mission runtime §2, §6; base design §16.x), replay figures | — | §13 | all of Phase 7 | `npm run verify` after `npm run build` |

### Phase 8 — A branch per mission and integration (decisions 2, 3)

| WP | Outcome | REQ | Design | Needs | Exit |
|---|---|---|---|---|---|
| WP-8.0 | Spikes S1–S4 on an isolated `--home` daemon and scratch clones; the plan re-checked with their results (a change-delta if a WP moves) | — | §14 | — | A run record in `docs/archive/operations/`; each spike passes or names its fallback |
| WP-8.1 | Placements and the resolver: the mission record, the index map, `repoKeyOf`, `placementOf`, `inCharter`, `effectivePolicy`; every reader of §3.1 | REQ-210 c | §3.1, §3.2 | WP-8.0 | Placement tests: policy, memory, precedents and charter through a placement; Settings never lists a placement |
| WP-8.2 | Creation and lifecycle: lazy creation, the integration branch, idempotence and adoption, the dependency clone and its fallback, retire, the archive card, reload reconciliation, the `workspace.archived` hook | REQ-210 a, b, d | §3.3–§3.7 | WP-8.1 | Creation tests over a fake Paseo; clone gate tests; archive card warns on a dirty tree |
| WP-8.3 | The boundary and the grant: `BoundaryContext.mission`, the git and `glab`/`gh` rows, `EFFECTFUL_ACTIONS`; the owner-only integration card, `integration.grant`, `integrationCoverOf`, revoke; the Worker watch | REQ-211 b | §4.2, §4.3 | WP-8.1 | Effectful-action table tests; boundary order; `danger` on a push elsewhere while granted; revoke sends `BM-SETTINGS` |
| WP-8.4 | The report and the line's state: `integration` fields, the finished-without-commit refusal, `listedWorkspaces` git fields, read-only git fallback, committed and verified | REQ-211 a, d | §4.4–§4.6 | WP-8.2 | Report round trip with old shapes; committed and verified rules over a temporary repository |
| WP-8.5 | Mission state, governor and conflicts: `placements[]` in the state and brief, the five figures, the diff-overlap conflict source; cross-mission writer collisions retired | REQ-211 e | §4.7, §4.9 | WP-8.4 | Mission-state and governor tests from fake runtimes |
| WP-8.6 | Migration: cut-over mode, the checkpoint card (temporary index), placements from the checkpoint, `registry.move`, the follow-up checkpoint | REQ-211 f | §4.8 | WP-8.2 | The checkpoint leaves HEAD, the index and the tree unchanged; a moved request keeps its records |
| WP-8.7 | Beads at integration, per S2's result | REQ-211 c | §14 S2 | WP-8.0, WP-8.4 | A test or run record showing two mission branches' beads merge |
| WP-8.8 | Role files for Phase 8: Worker rule 1, the update-the-branch step, commit and report; `manager.md` placement line | REQ-210, REQ-211 | §4.1, §4.7, §10 | WP-8.3, WP-8.4 | Role-content tests; `npm run build` |
| WP-8.9 | Mockup of the placement row on the mission page, for the owner's approval | REQ-211 e | §12 | WP-8.5 | The owner approves the mockup |
| WP-8.10 | The placement row as approved, with Revoke | REQ-211 b, e | §12 | WP-8.9 | Client tests; visual check |
| WP-8.11 | Phase 8 close: docs as built (missions §2.1, §9.6; mission runtime §5.4; autonomy §D.2, §D.4, §F.1; base design §7.17), the drill and migration steps for the owner | — | §13 | all of Phase 8 | `npm run verify` after `npm run build` |

### Phase 9 — Typed messages (decision 8)

| WP | Outcome | REQ | Design | Needs | Exit |
|---|---|---|---|---|---|
| WP-9.1 | `act` and `refs` on peer and mission messages; `ack`/`close` start no turn | REQ-215 a, b | §9.1 | — | Peer and mission tool tests; no turn for `ack` |
| WP-9.2 | Contracts' `status` and `agreedBy`; the `agree` flow | REQ-215 c | §9.2 | WP-9.1 | Mission tool tests: both sides agree → `agreed`; a stale version refused |
| WP-9.3 | `BM-STATE` contracts and each link's latest message | REQ-215 d | §9.3 | WP-9.2 | Mission-state rendering tests within the 6,000-character fit |
| WP-9.4 | Role lines (§9.4), docs as built, programme close | REQ-215 e | §9.4, §10 | WP-9.1 → WP-9.3 | `npm run verify` after `npm run build`; `feature-done` |

**Order.** P6 → P7 → P8 → P9. Within a phase, packages with no prerequisite run beside each other. Two or three agents run at a time, on disjoint files. These packages stay in separate waves because they share files:
- WP-6.8, WP-6.9 and WP-7.6 (`governor-*`);
- WP-7.4 and WP-7.5 (outbox, registry);
- WP-8.3 and WP-8.4 (`effectful-actions`, report schema).

WP-8.0 may run during Phase 7.

## 3. Backward compatibility

- **Stored formats** are all additive (design §11). An older build ignores the new fields, and an older build reading new Coordination settings falls back to its review budgets.
- **Consumed contracts** gain optional fields only: `bm_report`, `bm_create_reviewer`, `bm_rereview`, `bm_tell_worker`, `bm_peer_reply`, `bm_ask_mission`, `bm_owner_question`, `bm_mission_update`. The old shapes still parse.
- **Retired paths** answer with a clear refusal and never fail silently. The examples:
  - `coordination.set` on an old key;
  - a `review-budget` precedent marked `inert`;
  - an open `review-budget` question withdrawn by the sweep.
- **Running agents** become outdated when the role files change and are replaced once, by the usual path.

## 4. Rollback and containment

- **Each phase is its own commit set** on the branch. Reverting a phase leaves the earlier ones working.
- **Owner switches:**
  - `rollover.enabled: false` turns off Phase 7's rollover;
  - the wake gate holds nothing for reports without structured items.
- **Phase 8's switch** is the cut-over file. Without `missions/placement-mode.json`, missions keep the root, and placements are created only after the cut-over.
- **What the owner can always do:** revoke an integration grant from the mission page. Archiving a worktree is always the owner's.

## 5. Test strategy

- **While building:** targeted tests per work package. An agent runs only the tests of the files it touched, plus typecheck and lint once at the end of its stream.
- **The coordinator** runs `npm run build` and `npm run verify` once per wave, then closes the wave's beads.
- **Role-file changes** always run the role-content tests.
- **Always:** the scenario test of WP-7.9, and the eval tests when `eval-metrics` changes.

## 6. Risks

| Risk | Containment |
|---|---|
| `manager.md` is at its 100-line cap | Every new line replaces one; the role-content test pins the cap |
| A continuation brief misses something the old conversation held | The brief is built from the stores, with the handoff brief's helper; the scenario test checks beads and questions follow the chain |
| A held delivery hides owner words | Owner chat is never gated; a Main's tell of owner words uses `now: true`; a held tell answers "held" |
| Worktree creation or the dependency clone misbehaves on the owner's machine | S1 and S3 first; lazy creation; the clone is gated on the lockfile; fallback to asking |
| Beads conflict at every merge | S2 decides the rule before WP-8.4 |
| The checkpoint carries every mission's in-flight edits | The card's advice: merge the checkpoint first; the owner decides |
| Push classification from command text | Anything unparsed stays held or `danger`, never covered |
| The bundle grows past the 2,000,000-byte limit | Checked at each phase close |

## 7. Closure

Every work package is built, and its bead is closed with evidence:
- epic `bm-delivery-line-p6-1eda`, 12 beads;
- epic `bm-delivery-line-p7-0iur`, 12 beads;
- epic `bm-delivery-line-p8-1u4q`, 12 beads;
- epic `bm-delivery-line-p9-fnoe`, 4 beads.

**Final checks, 2026-10-21:** `npm run build` then `npm run verify` passed, with 218 test files and 6,168 tests, bench 11 and eval 137. The published entries are 1,852,755 of 2,000,000 bytes. `br lint` and `br dep cycles` are clean.

**What the replay measures before the change** (field data since 2026-10-15, evaluation design M-36 → M-42):
- largest request: 2.31 billion tokens, and 4 of 27 requests over 100 million;
- 44.9 % of Worker tokens read in turns that end blocked;
- 18 of 32 compactions and 16 of 23 handoffs dropped;
- 76 files written by two missions in one checkout;
- 20 of 20 finishes with changed files uncommitted, and 10 % verified;
- 9 review-budget cards;
- 24.4 % of owner cards not product decisions, counted by exact text (the field review's 49 % was counted by reading).

The same rows after the install are the programme's evidence.

**Departures from the plan, each recorded in the design's "As built" subsections** (§2.8, §3.8, §4.10, §5.7, §6.8, §7.5, §8.6, §9.5):
- The scenario test found three bugs in Phase 7's own build, and all three were fixed:
  - the gate decided only at enqueue;
  - a verdict went to a replaced Worker;
  - maintenance at the ceiling was dropped as stale.
- WP-8.7's proof made the beads rule per line, with `br sync --rebuild`.
- Phase 8 added `mission.integration.ask`, "Ask me again", so the owner can reopen the integration card.
- Placements are left out of the project lists rather than drawn nested.
- Projects › Requests is a list of cards, so the chain sits on the card; artboard K drew a table.
- In Phase 9 the Main tells each Worker to agree; it does not agree on their link.

**Not built, and open for the owner:**
- setting the integration branch and the dependency clone list on the mission page (the default is the root checkout's upstream);
- GitLab merge-request mergeability, until a real merge request settles spike S4.

The owner's steps for Phase 8 follow.

### 7.1 The owner's steps after installing a build with Phase 8

**The cut-over is automatic, and the checkpoint is yours.**
1. **At the first start,** the build writes `missions/placement-mode.json`. From then on a mission's new Worker in a repository gets the mission's own worktree, on `m/<CODE>/<repo>`, branched off the repository's upstream. Workers already running in the shared checkout finish there.
2. **The checkpoint card.** For each repository the open missions share, one checkpoint card (`worktree-checkpoint`) appears once no mission Worker runs in the shared checkout. "Checkpoint now" makes the branch `bm/checkpoint-<date>`. It holds the shared checkout's current state, uncommitted files included, and leaves your HEAD, index and files untouched. The missions then branch from it.
3. **Yours, as the card advises:**
   - push `bm/checkpoint-<date>` and merge its own merge request first, so each mission's merge request shows only its own changes;
   - tidy the shared checkout when you choose.
4. **Integration.** At a mission's first committed finish in a repository, one card asks to push its branch and open its merge request. "Yes" covers later pushes of that branch. Revoke and "Ask me again" are on the mission page. Merging stays on GitLab.

**`issue_prefix` in the repositories.** Both target repositories leave `issue_prefix` commented out in `.beads/config.yaml`. In a fresh worktree `br` then guesses the prefix from the first id; with the frontend's slugged ids (`esm-esm-independence-…`) it may guess `esm-esm-independence`. Uncommenting `issue_prefix` in each repository settles it. That is your repository's change, not the plugin's.

### 7.2 The isolated-daemon drill (yours)

Use the kit in `scripts/manual-test/`, on a port other than 6767. It needs a scratch repository with an `origin` and an integration branch.

| Step | What to do | What must happen |
|---|---|---|
| 1 | Create two missions on that repository and give each a request | Two worktrees on `m/A/…` and `m/B/…`; the root checkout is unchanged |
| 2 | Let each Worker finish with a change | Each commits on its branch; the Main's line reads "finished, committed on …"; one integration card per mission |
| 3 | Answer "Yes" on one card | That Worker's push and `glab mr create` pass the boundary as `allowed-integration` (with the boundary on), or raise no `danger` (with it off). A push of another branch raises `danger` |
| 4 | Make both missions change the same file | The governor raises "expect a merge conflict" from the diff overlap. After one merge request merges, the other Worker updates its branch with `git merge`, and beads are merged per line |
| 5 | Close one mission | Its worktrees are retired and the archive card warns about uncommitted work |

The drill and the migration are the owner's steps (PRD §9). Nothing here is installed on your daemon by the plugin's authors.
