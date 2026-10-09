# Acceptance record — Missions, Phase 1 MVP, 2026-10-09

| Field | Value |
|---|---|
| Feature | [ADR-029](../adr/ADR-029-missions-mains-and-a-process-governor.md), [missions PRD](../product/paseo-bm-missions-prd.md) REQ-184 → REQ-192, M-22 → M-25, M-27; [missions design](../design/paseo-bm-missions.md) §12 |
| Bead | `bm-missions-9qc3.17` |
| Build | branch `feat/missions` working tree after wave 6 (`npm run verify` green: 186 files / 5,567 tests, bench 3, eval 134; entries 1,596,602 of 2,000,000 bytes) |
| Daemon | isolated, `scripts/manual-test/start-daemon.sh ~/bm-missions-acceptance 6914`; the owner's daemon and `~/.paseo-bm` untouched |
| Run by | Claude, under the owner's delegation |

## Set-up

- Plugin from the folder; roles created; agent tools granted on the isolated config only; Manager and Worker on `claude-sonnet-5-5`, Reviewer on Codex.
- Two scratch repositories as workspaces: `be-api` (`wks_6e5eac08f1939470`, a Node handler with `GET /health`) and `fe-ui` (`wks_7f9565d4a2030929`, a UI module calling it); both at repo level 4.
- The mission started the Command Center way: `missions.create {}` → an unassigned Main `d8d7f865` titled `🟣 M · New mission`, in the Missions home.

## The scenario and what happened (times UTC)

| Time | Event |
|---|---|
| 11:56:05 | Owner, in the Main's chat: "Mission name: AI Assistant greeting. Short code: AIX. Goal: the UI greets the user through the backend; the UI never builds the greeting itself. Repositories: …/fe-ui and …/be-api." → `bm_mission_start` settled on the owner's message: mission `mis-263b11590e`, code `AIX`, both repos, goal; the Main retitled `🟣 M · AIX AI Assistant greeting` |
| 11:57:08 | Owner: the goal (backend `GET /api/greeting?name=` with a test and API.md, then the UI's `renderGreeting` calling it; small, no review) |
| 11:57:18 | The Main created the backend Worker `f51570c1` **in `be-api`'s workspace** (request `req-20261009T115718Z`, roster and journal written, plan recorded) |
| 11:57:36 | Backend `finished` (tests 3/3) → delivered to the Main |
| 11:57:42 | Without being told, the Main created the frontend Worker `7c2217d7` **in `fe-ui`'s workspace** (`req-20261009T115742Z`) |
| 11:58:01 | Frontend `finished` (tests 2/2) |
| 11:58:02 | **Replacement drill:** `mission.ensure { replace: "owner" }` → successor Main `67ccd1a8`; `mainHistory` records both; both Workers' bindings re-parented to `67ccd1a8`; old Main labelled `bm.replacedBy` |
| 11:58:46 | Owner, to the **new** Main: handle the backend's 400 in `renderGreeting` |
| 11:58:48 | The new Main sent it to the frontend Worker (`bm_tell_worker`, record in `fe-ui`'s outbox) |
| 11:58:54 | Frontend `finished` (tests 3/3), report delivered **to the new Main** |

No decision was opened, no Inbox alert was raised, no outbox record was dropped.

## The figures

| Metric | Field baseline | This run |
|---|---|---|
| M-22 owner messages that only carry information or permission between repos | 6 / day | **0** (the owner sent 3 messages: the mission, the goal, a follow-up) |
| M-23 Workers per repo per workstream | 4 (one feature) | **1** in each repo |
| M-24 `ownerOnly` answers by anyone but the owner | — | **0** (no question was asked) |
| M-25 owner messages that only say "take the next step" | 1+ / day | **0** (the Main created the frontend Worker after the backend finished, by itself, at level 2) |
| M-27 work lost when the Main is replaced | commands and a decision lost in the field | **0** (bindings re-pointed; the follow-up went through the new Main and its report reached it; no dropped record) |

## Findings fixed after the run

1. **The successor's brief showed a finished request as `received`.** Two reports of one turn share a `createdAt`; the brief took the later file entry. Fixed: newest report by time, ties broken by phase rank, one helper for the brief, `bm_mission` and the compaction brief.
2. **The roster's request state stayed `active`.** Fixed: `finished` / `stopped` reports set it, a later report reopens it.
3. **The old and the new Main had the same title.** Fixed: the replaced Main is retitled `… · replaced`, and title sync never restores a replaced Main's title.

## Not covered live

`ownerOnly` routing and `bm_answer_worker` (no question arose), `bm_link_workers` and `ask-main` (the Main sequenced the two Workers instead of linking them), a cleared conversation in the app, legacy migration of a live Manager, Main ↔ Main asks. Each is covered by unit tests.

## Clean-up

The isolated daemon was stopped with `scripts/manual-test/stop-daemon.sh` and `~/bm-missions-acceptance` deleted.
