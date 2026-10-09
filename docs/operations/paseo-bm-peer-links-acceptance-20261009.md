# Acceptance record — projects ask each other (peer links), 2026-10-09

| Field | Value |
|---|---|
| Feature | [ADR-028](../adr/ADR-028-projects-ask-each-other-through-the-plugin.md); base PRD REQ-175 → REQ-183, M-19 → M-21; [base design §7.17](../design/paseo-bm.md) |
| Bead | `bm-peer-links-j8r3.13` |
| Build | the working tree's `plugin/` (uncommitted, after `npm run build` and a green `npm run verify`: 174 files / 5,363 tests, bench 3, eval 134; entries 1,927,077 of 2,000,000 bytes) |
| Daemon | isolated, `scripts/manual-test/start-daemon.sh ~/bm-peer-acceptance 6911` (own `PASEO_HOME`, own `PASEO_BM_HOME`, port 6911); the owner's daemon on 6767 and `~/.paseo-bm` untouched, checked after the run |
| Run by | Claude, under the owner's delegation |

## Set-up

- Plugin installed from the folder (`paseo plugin add <repo>/plugin`): `status: running`.
- `setup.ensure-roles`, `setup.grant-agent-tools {confirmed: true}` on the isolated config only. Manager and Worker on `claude-sonnet-5-5` (cheaper than the default for a mechanism check), Reviewer on Codex (default).
- Two scratch repositories as two workspaces: `be-api` (`wks_db2385a149d4f1d0`, a Node HTTP handler with `GET /health`) and `fe-ui` (`wks_d1fedd961abe636b`, a UI module calling the backend).
- Both projects at autonomy level 4 (every class delegated), as both projects of the 2026-10-07 → 09 field trace were.
- Both Managers created the way Paseo's composer creates them (`create-agent.mjs bm-manager …`, the owner's words as the first prompt), not through the plugin's `manager.ensure` — the case the field trace's Managers were in.

## The scenario

The owner's only message, to the frontend Manager (01:39:05Z):

> The UI must greet the user through the backend. The backend project be-api (folder …/be-api) needs a GET /api/greeting?name=<name> endpoint that returns JSON { "message": "Hello, <name>!" }, with a test and a line in its API.md. Ask the backend project for that endpoint. When it is ready, add renderGreeting(fetchImpl, baseUrl, name) to app.js that calls the backend endpoint and returns the message, with a node:test test. The UI never builds the greeting itself. This is a small change; no review is needed.

## What happened (outbox records and the link store)

| Time (Z) | Event |
|---|---|
| 01:38:34 | backend Manager `0dbdee3a` created from the composer → **bound by the creation hook** (`origin: hook`, `claimedBy` = itself; log "Manager 0dbdee3a… is bound to its own tool path; the creation hook bound it.") — REQ-175 |
| 01:39:12 | frontend Manager `f54290c8` (also hook-bound) creates Worker `974ba1e2` with `bm_create_worker` (`req-20261009T013912Z`) |
| 01:39:17 | `received` report → frontend Manager |
| 01:39:19.7 | Worker calls `bm_ask_project`: link `peer-8c47972b1c1a`, `peer` record delivered to the backend Manager at 01:39:19.745 |
| 01:39:21.7 | Worker reports `blocked`, `blockers: waiting on project: be-api (peer-8c47972b1c1a)`; `waitingSince` set on the link; the frontend Manager tells the owner the Worker waits on be-api |
| 01:39:23 | backend Manager gives the ask a Worker (`bm_create_worker`, `peerLink`): `1c7eefde`, `req-20261009T013923Z`; link `taken`; the Manager tells its owner in one line |
| 01:39:40.178 | backend Worker reports `finished` with `forPeer` (the contract as built: path, query parameter, 200 body, 400 `{ error: "name is required" }` for a missing or blank name, 404) |
| 01:39:40.285 | `peer-reply` delivered to the frontend Worker; link `answered` at 01:39:40.293 |
| 01:39:49 | frontend Worker reports `finished`: `renderGreeting` in `app.js` calling `/api/greeting`, a test; `npm test` passes |

Both repositories' tests pass after the run (`be-api`: 3, `fe-ui`: 2). No decision opened in either project, no Inbox alert was raised.

## The figures

| Metric | Field baseline (2026-10-07 → 09) | This run |
|---|---|---|
| M-19 — owner messages that only carry information or permission between the projects | 6 | **0** (one owner message in total, the request) |
| M-20 — linked request's `finished` → reply at the asker | 3 h 20 min → 13 h 45 min | **0.1 s** (01:39:40.178 → 01:39:40.285); the whole two-project feature took 44 s |
| M-21 — review-budget cards at a delegating level; Manager turns that answer a repeated delivery | about 15 cards; 12 turns | **0 cards; 0 such turns** (frontend Manager: 3 delivery turns, each with new content; backend Manager: 2) |

## Observations

- Both Managers treated the ask as the other project's, not the owner's: the backend Manager quoted it as "fe-ui asked for …" and gave it a Worker with `peerLink`; neither told its owner to carry anything.
- The backend Worker's `forPeer` named a choice the ask left open (the 400 for a missing name); the frontend Worker used the contract and suggested handling that 400 as a follow-up, which its Manager passed to the owner as a suggestion.
- The backend Manager's `finished` reply said it had not yet seen the reply reach fe-ui; `bm_peers` would have shown the link `answered`. Not a defect; a possible wording improvement of `manager.md`.
- Not covered live (unit-tested): a contract re-announced by a later `finished`, `peer-unanswered`, the wait ceiling, a reply re-resolved after a queue drop, two concurrent composer creations, the danger-signal and review-budget changes.

## Clean-up

The isolated daemon was stopped with `scripts/manual-test/stop-daemon.sh` and its work folder `~/bm-peer-acceptance` deleted after this record was written.
