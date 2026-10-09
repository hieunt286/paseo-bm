# Acceptance record — Missions, Phase 2 (the governor), 2026-10-09

| Field | Value |
|---|---|
| Feature | [ADR-029](../adr/ADR-029-missions-mains-and-a-process-governor.md) decisions 8–9, [ADR-031](../adr/ADR-031-orchestrator-decisions-grant-no-effects.md); [missions PRD](../product/paseo-bm-missions-prd.md) REQ-193 → REQ-195, M-26; [missions design](../design/paseo-bm-missions.md) §9, §12, §17 |
| Bead | `bm-missions-9qc3.24` |
| Build | branch `feat/missions` working tree after the Phase 2 beads and the fixes below (`npm run verify` green after the last edit: 192 files / 5,574 tests, bench 3, eval 134; entries 1,641,900 of 2,000,000 bytes) |
| Daemon | isolated, `scripts/manual-test/start-daemon.sh ~/bm-gov-acceptance 6915`; the owner's daemon (6767) and `~/.paseo-bm` untouched |
| Run by | Claude, under the owner's delegation, answering as the owner with the recommended options |

## Set-up

- Plugin from the folder; roles created; agent tools granted on the isolated config only. Main and Worker on `claude-sonnet-5-5` without prompts, Orchestrator on `claude-opus-5-5`, Reviewer on Codex.
- Two scratch repositories: `be-api` (`wks_6bd868e08d21be03`: a health route and `src/dates/format.js` `formatDate`, ISO) and `fe-ui` (`wks_c7a75c8d5012e862`: `renderHome`). Both at repo level 4.
- Governor thresholds lowered for the run: `workersPerRepo` 1, `mainTurnsSinceCriterion` 5, `windowMinutes` 5, `windowTurns` 1. The Orchestrator opened with `orchestrator.open`.
- Two missions from `missions.create`:
  - **GRT "Greeting"** (be-api + fe-ui): the home page greets with today's date in dd/mm/yyyy, with `formatDate` changed to dd/mm/yyyy. Its `staffing` and `split` cells are delegated.
  - **BIL "Billing"** (be-api): an invoice route whose date comes from `formatDate`, which must stay ISO.
  
  The two goals collide on purpose. "Billing" also checks that an owner's mission name does not trip the cost backstop.

## The scenario and what happened (times UTC)

| Time | Case | Event |
|---|---|---|
| 13:56–13:58 | — | BIL's Main started its Worker on its own. The owner told GRT's Main to use two Workers in be-api at once, then do fe-ui. |
| 13:57:59 | Sprawl | `workersInOneRepo` 2 > 1: ladder step 1 (journal). 13:58:11 step 2: the code-run `governor:nudge` reached GRT's Main, which rewrote its plan. |
| 14:03:46 | Sprawl | Still crossed after 5 minutes and 1 Main turn: step 3. The `mission.signal` wake ran `bm_missions` and `bm_agent_messages`, then `bm_govern replan` to GRT's Main ("re-plan be-api down to one active Worker"). Acted. |
| 14:04:15 | Drift | `mainTurnsSinceCriterion` 6 > 5: the code nudged the Main, which added its done criteria D1–D3 (14:04:49). |
| 14:19:00 | Drift | Re-plan due. The wake sent `bm_govern replan` ("no criterion met in 7 turns"). The Main checked and marked D1 met; at 14:19:23 drift was back under its thresholds. Acted. |
| 13:58–14:35 | Conflict | GRT's change to `formatDate` broke BIL's invoice test. The conflict was not raised: the Workers wrote their files with shell here-documents, which left no `file` evidence (finding 1). After the fix and a plugin reload, the 14:35:00 `mission.conflict` wake (src/routes and test of be-api) ran `bm_arbitrate` twice: both areas go to BIL, both Mains were told with `governor:arbitrate` commands, and the governor kept out of Q1. Acted. |
| 14:38 | Conflict | The owner answered the GRT Worker's Q1 with (a): keep invoices ISO through a new `formatIsoDate`. The Worker stayed out of BIL's area and reported itself blocked. GRT's Main asked BIL's Main (`bm_ask_mission`); BIL's Main asked its owner, who chose to switch `invoice.js`. BIL's Worker changed it, and `npm test` in be-api passed 3 of 3. GRT went on to fe-ui by itself. |
| 14:38 | — | The governor had escalated an `o:` card: a finished, idle Worker still counted toward sprawl (finding 2). The owner answered in words. |
| 14:42 | Split | The owner gave GRT's Main an unrelated goal (a dark-mode theme). The Main recommended a new mission but told the owner to create it in a new chat (finding 3). After the fix, the owner replaced the outdated Main (`mission.ensure replace: owner`) and asked the successor. |
| 15:00:48 | Split | The new Main called `bm_split_mission` (THM "Theme", be-api and fe-ui, no requests). The plugin created a new Orchestrator for the changed role file and retired the old one (designed). At 15:00:54 the `mission.split` wake ran `bm_create_main` on GRT's `split` cell: mission THM `mis-353be3ea2b`, `createdBy: orchestrator`, with its own Main `e0a18595`. Both Mains were told. Acted. |
| 15:01–15:16 | — | GRT's drift crossed again, though all its criteria were met (finding 4). The 15:16 wake ended at once: the provider answered "You've hit your session limit", with 0 tokens. |

The owner never carried a message between agents. The owner's messages were: the start of GRT, Q1, BIL's choice, the `o:` card, the theme request (twice: before and after the replacement) and the replacement itself.

## The figures

| Metric | Field baseline | This run |
|---|---|---|
| M-26 Orchestrator wakes that end with no action | 11 of 18 `request.finished` wakes | **0 of 4** completed wakes; **1 of 5 (20%)** counting the wake the provider's session limit ended, which a fixed false positive had caused |
| Wake cost | ~3.6 M input tokens over 33 wakes | 4 wakes, 697,034 input tokens (most of them cached), 6,557 output tokens |
| Owner relaying | — | 0 messages carried between agents; sprawl, drift, conflict and split each resolved through the governor |

## Findings fixed after the run

1. **Shell writes were invisible.** Workers wrote with `cat > file <<EOF`, which leaves only `shell` evidence, so neither the conflict watch nor `writersOnOneFile` nor the writers alert saw those files. Fixed: `shellWrittenPathsOf` counts output redirections and `tee` targets, resolved against the command's folder (missions design §17, autonomy design §F.1).
2. **A finished Worker counted as sprawl.** `workersInOneRepo` now counts only live Workers whose request is still open on the roster.
3. **A Main had no path to the governor for a split.** The Main told the owner to create the mission themselves, against the owner's decision of 2026-10-09 (the Main asks the owner; the Orchestrator evaluates and may create a Main). Fixed: the Main tool `bm_split_mission`, the `mission.split` event, `splitSuggestions` in `bm_missions`, and a line in each role file.
4. **Drift on a finished mission.** A Main answering the owner after every done criterion was met still counted as drift. Fixed: no turns count while every criterion is met or dropped and no request is open.
5. **Found in the boundary test before the run:** the governor's command to a Main was refused as "cost" because the mission was named "Billing". Fixed: the backstop reads the Orchestrator's own words, not the names or figures the plugin adds.

## Not covered live

- A danger stop (`bm_direct_worker`) and the step-4 escalation through `bm_ask_owner`.
- A split through the owner's `m:` card (the run used the delegated `split` cell).
- Code-run compaction and handoff at a real threshold crossing.

Each of these is covered by unit and boundary tests.

## Observations

- After `paseo plugin reload`, the governor's minute pass waits for a Paseo handle (an RPC call or a recorded turn). The app's own calls bring one. In this run, `orchestrator.state` was called once.
- An existing Main keeps the role file and tool list it was created with; a replacement picks up new ones.

## Clean-up

The isolated daemon was stopped with `scripts/manual-test/stop-daemon.sh`. `~/bm-gov-acceptance`, and the leftovers of the earlier spike and Phase 1 runs (`~/bm-spike-missions`, `~/bm-missions-acceptance`), were deleted.
