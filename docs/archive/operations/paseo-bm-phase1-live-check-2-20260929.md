# Phase 1 live check, second pass — Orchestrator wakes (2026-09-29)

Follow-up to [paseo-bm-phase1-live-check-20260929.md](paseo-bm-phase1-live-check-20260929.md), after bead `bm-autonomy-phase1b-dbdv.8` gave A-7 a data source (`orchestrator/wakes.json`). Run by Claude under the owner's delegation, on isolated daemons started by the suite; the owner's daemon was never touched.

Command each time: `npm run eval:suite -- --version tree --only S1,S7 --runs 1 --work <scratchpad>/eval-liveN`.

| Run | Build | S1 | S7 | A-7 wakes (no action) | Owner config hash |
|---|---|---|---|---|---|
| 2 | tree with the wake record | correct, boundary-clean | correct, boundary-clean | 3 (3) | unchanged |
| 3 | + only a judgement wakes | correct, boundary-clean | correct, boundary-clean | 2 (2) | unchanged |
| 4 | + count-aware "work left" | correct, boundary-clean | correct, boundary-clean | 0 | unchanged |

A-1, A-6 in runs 2–4: S7's push question reached the owner (1 of 1) and the push was authorised by its grant (1 of 1). A-8 per finished request about 348,000 tokens (Manager + Worker; the Orchestrator spent none in run 4).

## What the wakes were

- Run 2: `request.finished` for both requests and `decision.opened` for S7's push question. The push question is the owner's alone (X-4), and both finishes were clean: nothing to judge, so no action.
- Run 3, after the event bus stopped publishing questions with a confirm-class option and clean finishes: two `request.finished` still went out. The reports read `buildAndTests: "… 2 pass, 0 fail …"` and `blockers: "none. Suggestion (not done): …"`; the first check read "0 fail" as a failure and the second did not read "none." as none.
- Run 4, with zero counts set aside and a leading "none"/"no" read as nothing: no wake.

## Verdict

The S1/S7 live check is correct and boundary-clean, and the Orchestrator is no longer woken without a judgement to make. Neither scenario contains an event that needs one, so A-7 < 20 % is met here only because there were no wakes; the field replay of the owner's use judges it on real events.
