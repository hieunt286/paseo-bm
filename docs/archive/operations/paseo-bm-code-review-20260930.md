# Code quality review after the autonomy build-out (2026-09-30)

Read-only review of the working tree on branch `autonomy-phase1`, done at the owner's request: Phase 1, change-004 and 18 Phase 2 beads built, uncommitted Phase 2 work included. Method:
- measured by scripts: size by area, duplicated 6-line windows, exports used nowhere or only by tests, remnants of retired mechanisms, test durations;
- three read-only reviews: the server data/RPC layer, the coordination subsystem, and client/eval/`src`/tests.

The findings marked *verified* were re-checked by the coordinator.

## 1. Figures

| Area | Files | Code lines (no comments/blank) |
|---|---|---|
| plugin/server | 91 | 18,500 |
| plugin/client | 34 | 11,761 |
| plugin/shared | 32 | 7,370 |
| src (retired installer CLI) | 20 | 4,540 |
| scripts | 20 | 3,628 |
| test | 161 | 58,603 |

- **Largest files (code lines):**
  - over 1,000: `eval-metrics.ts` 1,434, `orchestrator-tools.ts` 1,356 (1,903 raw), `contracts.ts` 1,293 (2,322 raw), `chat-cards.ts` 1,137;
  - under 1,000: `traces.ts` 998, `settings-blocks.tsx` 931.
- **Literal copy-paste is low.** The exception is `settings-blocks.tsx`, with 33 duplicated windows inside itself.
- **Dead code is modest:** 25 exports are used nowhere (mostly proposal- and assessment-era types), and 31 are used only by tests.
- **Retired names still in plugin code:**
  - "assessment": 305 hits in 18 files;
  - "proposal": 188 hits in 17 files;
  - `role-extras`: 44 hits in 21 files;
  - "autopilot": 42 hits in 6 files.
- **Test run:** the full `npm test` takes 44 s alone and the whole verify about 60 s. Slowest files: `eval-score` 26 s, `integration/migrate` 25 s, `orchestrator-boundary` 24 s, `orchestrator-tools` 20 s, `event-bus` 15 s (the synthetic-day test 12 s).

## 2. Correctness and safety findings

1. **The loop guard can be bypassed** (*verified*). `commandsSentFor` (`orchestrator-tools.ts:220`, used at :895) counts only `proposals.json` commands. A prepared command delivered because a precedent or the policy answered an `o:` decision (`orchestrator-decisions.ts` `deliverCommand`) is never appended. Repeated `bm_ask_owner` → auto-answer → delivery escapes the 12-per-24-h guard.
   - **Also:** one sent command is recorded in three places with no shared id (`proposals.json`, `interventions.json`, `decision.delivery`).
2. **A hidden input to every new agent** (*verified*). `role-hook.ts:385` still appends `role-extras.json` (the additional instructions) to every new agent's system prompt. Phase 1 removed the only screen that shows or clears it.
3. **`orchestrator-store` overwrites a file from a newer version.** Every other store refuses to (`orchestrator-store.ts`, whose schemas accept only v1). This can lose data after a downgrade.
4. **`fallback-state.ts:171` and `fallback-settings.ts:133` write without creating the folder.** `writeStoreFileAtomically` does not `mkdir`. They also read without the symlink check other stores apply (`fallback-state.ts:90`, `role-extras.ts:369`). This is an edge case: the data home usually exists by then.
5. **The suite never sees A-12.** `scripts/eval/score.ts:250-322` `loadRunData` re-implements `eval-store` and does not read `interventions.json`, so the suite's A-12 is always unknown. Two definitions of `recordStart` also disagree (`score.ts:383` vs `eval-metrics.ts:667`).
6. **A test checks nothing.** `plugin-settings-section.test.ts:452` slices up to `"function SetupChecklistCard("`, which no longer exists (`indexOf` returns -1), so the assertion runs over the rest of the file.
7. **Designed, never reached:** the `expired` decision status. `expireDecision` is used only by tests; nothing expires a decision in the product. Grant expiry does work.

## 3. Structural duplication (behaviour-preserving consolidation)

1. **JSON stores.** The read → version → per-entry validate → create folder → atomic write → cap steps are copied into 11 modules:
   - `alert`, `autonomy`, `coordination`, `precedent`, `intervention`, `decision` and `orchestrator` stores;
   - `setup-state`, `budget-told`, `fallback-state`, `role-extras`.

   Related copies:
   - 15 places fake `{ tracesDir }` to call the trace store's helpers;
   - 7 copies of the newer-version check;
   - 5 cap functions;
   - 4 symlink walks (`data-home:277`, `trace-store:95`, `setup-machine:339`, `beads-store:91`).

   **Proposal:** `data-files.ts`, keyed on the data folder, with the error code as a parameter, plus
   `createJsonFileStore<T>({ home, dir, file, version, parse, empty, cap?, codes }) → { path, read, readForWrite, write, update }`, `entriesOf(schema, raw)` and `capBy(...)`. About 300 lines go.
2. **RPC helpers.**
   - `homeOf` ×10, which wraps a function that never throws.
   - The code-on-failure wrapper ×5.
   - The read-or-default-and-log reader ×4.
   - `describeError` in 20 files plus 73 inline copies.
   - Three paseo-tap wrappers.
   - Four ways of injecting the data home in tests.

   **Proposal:** `rpc-kit.ts` (`dataHome`, `requireDataHome`, `coded`, `readOr`, `errorText`, `withPaseoTap`). About 200 lines go.
3. **The command send pipeline is written three times:** `bmSendCommand` (tools:992), `bmDirectWorker` (tools:1082) and `deliverCommand` (orchestrator-decisions:116). Each does target check → build → claim grant → enqueue → release → spend → copy to the Manager.
   - **One pipeline.** One `command-send.ts` fixes finding 2.1.
4. **The answer-at-open sequence is written three times** (precedent, then policy): materialiser:506, fallback-decisions:293, tools:1385.
   - The "`onSettled` or log" step appears ×5.
   - `bmDecide` and `bmPredict` are near-copies.

   **Proposal:** `resolveAtOpen()` and `transitionUnderPolicy()`.
5. **Rules and constants:**
   - Check-result patterns: `event-bus:270,273` copies `interventions.ts:133,135`.
   - Danger patterns: `worker-watch:205` copied to `eval-metrics:431`. Move them to `shared/effectful-actions.ts`.
   - `PREDICTORS` = `AUTONOMY_PREDICTORS`.
   - `GATE_CATEGORY_EFFECTS` is the inverse of `CLASS_OF_EFFECT`.
   - `CONFIRM_EFFECTS` and `HARD_OWNER_CLASSES` can be derived from each other.
   - The hard-owner filter is written 5 times; its defence-in-depth layers are listed in §6.
   - There are three sets of option caps (`orchestrator.ts:55`, `decisions.ts:166`, tools:1220).
   - The status→refusal message ladder ×4, the policy read with fallback ×3, the recent-workspaces scan ×3.
6. **Shared helpers:**
   - `timeOf` is defined 19 times with three behaviours (0 / null / NaN): make `shared/time.ts`.
   - `plural` ×5; `shorten` vs `shortened`; `median` ×2; four disagreeing duration formats: make `client/format.ts`.
   - `errorMessageOf` lives in `launch-manager.ts` but has 16 importers.
   - 31 inline danger-text blocks and more than 70 inline Pressable + Text buttons: add `<ToneText>` and `<Button>` to `ui.tsx`.
7. **Client:**
   - In `settings-blocks.tsx`, the role fields are duplicated in `RoleEditForm`/`FallbackEntryForm`. Two hand-made confirms should use `ConfirmBlock`, and there are 5 busy/try/finally copies.
   - `beads-screen` `BeadsOverviewSection` and `insights` `BeadsFigures` are duplicates.
   - The same 7-line optional-spread block into `computeEvalMetrics` appears 3 times.

## 4. Oversized files and seams

- **`orchestrator-tools.ts`** (1,903 lines, 59 functions): split into `command-authority.ts`, `command-send.ts`, `orchestrator-read-tools.ts`, `repo-tool.ts`, `orchestrator-decide-tools.ts`, with the registry left in place (~150 lines).
  - `firstLine`, `requestKeyOf` and `waitingSinceOf` move to `request-trace.ts`.
  - `orchestrator-actions.ts` becomes `orchestrator-state.ts`, which also breaks the import cycle.
- **`contracts.ts`**: `shared/contracts/{errors,persisted,dashboard,setup,roles,fallback,chat-beads,orchestrator,decisions,insights,autonomy}.ts`, with a re-export barrel so no import changes. Rename `DashboardError` to `RpcError`, with an alias.
- **`chat-cards.ts`**: split at its section breaks (parsing, parties, frame/time, decision card, precedent offer, markdown).
- **`eval-metrics.ts`**: `computeEvalMetrics` is a single 753-line function; split it into one function per metric.
- **`traces.ts`**: split into rebuild, timing/bead actions, usage/cost and views.
- **`dashboard-rpc.ts`**: its agent/workspace directory helpers go to `paseo-directory.ts`, and its fallback counts to `fallback-state`.
- **`setup-model.ts`**: this is the Settings model under an old name. Split it into a roles/fallback form model and a machine-setup model.
- **`dashboard-model.ts`**: it is the shared view kit; split it into format, tone and styles files.
- **`event-bus.ts`**: `createEventBus` is a 164-line closure with 5 maps.

## 5. Retired or unfit code

- **Dead now (S):**
  - `bead-chips.tsx` (*verified* no importer) and its helpers `chat-cards.ts:1514-1530`;
  - `dashboard-model.ts` `requestsPerDay`;
  - the assessment agent code (`assessment.ts:341-454`);
  - optional `asks?` fallthroughs on in-memory events;
  - `answerDecision` still accepting `by: orchestrator` writes;
  - test-only exports `isGateCategory`, `grantCovers`, `ORCHESTRATOR_LIMIT_LINE`, `MAX_SENT_TEXT_CHARS`, `parseBeadIds`, `classifyText`, `commandTargetOf`;
  - `E_TIMELINE_UNAVAILABLE`, which nothing throws;
  - `DashboardPaseo.config`, which nothing calls;
  - orphaned test files: `test/fakes/login`, `test/fakes/skills-cli/npx`, `test/fixtures/paseo-config.room.json`, `test/fixtures/qa-ledger/*`.
- **Scheduled by `t9lm.16`, whose scope must widen:**
  - `role-extras`, `roles.save-extra`, `orchestrator.apply-suggestion`, `bm_assessment`, and the rule flags other than `review.over-budget`;
  - *plus* the live dependencies on `assessment.ts`: `orchestrator-agent.ts:46-52` (`assessmentTargetOf` and related), `bm_request` rendering through `buildAssessmentContent`/`capParts` (tools:558), and `decision-tools` `cutText`;
  - *plus* moving `instructions-label.ts`'s use of `role-extra-hash.ts`;
  - *plus* the `ORCHESTRATOR_FIRST_PROMPT` mention.
- **After the Phase 2 field replay (a new bead):**
  - the Autopilot parsing (`orchestrator-command.ts:84-108,206-209,505`; `decisions.ts:151,258`; `orchestrator.ts:92,199`; `chat-cards.ts:761-766,997`), the proposal-era schema (`orchestrator.ts:92-190`) and `ANSWER_BY` `orchestrator`. Move the history readers into `eval-metrics`, their only reader, and slim the runtime schemas;
  - `stalls.json`: its only remaining content is the interrupt allowance, which can be derived from the danger alert's `since` + 10 min.
- **Owner decisions:**
  1. `src/`, the retired installer: 6,728 raw lines plus 6,793 test lines. Every build bundles it, and the packed smoke mostly exercises it. Removing it means branching the §7 fix path from the `v0.4.0` tag. First port `credentials-guard.test.ts` to the plugin, since it is the only mechanical proof of "never reads credentials".
  2. The 0.3.x migration banner (`install-home.ts`, `setup-machine.ts:191-216`, `install.kind`), which the design says can essentially never show.
  3. The frozen `test/fixtures/v0.4.1` downgrade bundle plus `plugin-orchestrator-compat.test.ts`. The orchestrator design promises the downgrade; autonomy §A.15 and REQ-171 make a clean reinstall the remedy.
  4. The fallback chain's `auto` setting overlaps delegating the `environment` class. It picks the same option but skips the ledger, digest and demotion.
- **Role files:**
  - The Orchestrator can drop about 30 lines: its tool list, which has already drifted (`bm_predict` missing, `bm_assessment` present), and restatements of what the tools and notices already say. The 18 assessment lines go with `t9lm.16`.
  - The Manager's notice-name list adds nothing.
  - The Worker's class enumeration is already in the `bm_report` schema.

## 6. Keep as is (deliberate)

- **Defence-in-depth hard-owner checks:** `answerDecision` (decisions:591), `cellOf` ignoring a hand-edited `delegate` (autonomy:152), `authorityOf` (tools:831), the command builder/parser (orchestrator-command:363/503), the text backstop at send and at ask, re-checks inside `transition`, precedents never answering owner-fixed classes, and the confirmation tap.
- **Unreachable duplicates to cut:** tools:791-792 and orchestrator-decisions:128-130; also the redundant `canDelegate` at autonomy:294.
- **History and compatibility:**
  - `BM-ANSWERED` recognition (0.4.x shipped it);
  - `eval-store` as a separate read-only reader (share its line parser, though);
  - `legacy-contracts.ts` and the 0.4.1 evaluation channel, until the programme evaluation;
  - optional older-server fields in contracts (client and server can differ until a reload);
  - the newer-version refusal (make it uniform, and fix `orchestrator-store`).
- **Test infrastructure:** `plugin-bundle-cjs`, `roles-content`, `element-tree`, `test/fixtures/orchestrator-traces.ts`, the manual-test kit, and `no-real-installers.ts` (only its name is stale).

## 7. Test-suite debt

- `fakePaseo` has 22 copies (~750 lines) and `fakeDaemon` 11 (~320 lines). Their `config.patch` has already drifted. Make one `test/helpers/fake-paseo.ts`.
- The `react-native` `vi.mock` is repeated in 12 files; replace it with a `resolve.alias`.
- About 27 source-grep tests: turn the layout ones into render tests, and gather the retired-name absence checks into one test to delete after the release.
- 99 long exact-string pins, 18 of them in `orchestrator-tools.test.ts`.
- **Out of the default run:** the two wall-clock benchmarks (collector p50 < 50 ms / p95 < 150 ms, traces 300 ms), which fail under load, and the eval-tooling tests (`eval-score`, `eval-scenarios`, `eval-suite`, `eval-owner`, `eval-replay`, ~2,200 lines) go into separate Vitest projects (Vitest 2.1.9, so `vitest.workspace.ts`). `verify` runs them after the main run. `eval-metrics.test.ts` stays in the default run because Insights uses that module.
- `plugin/tsconfig.json` should extend the root settings (`noUncheckedIndexedAccess`, `verbatimModuleSyntax`, `noImplicitOverride`).
