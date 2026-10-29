# Implementation Plan — Parallel lanes and a held queue (ADR-038)

| Field | Value |
|---|---|
| Status | **Completed** — 2026-10-25: Phase 11 built and verified; the isolated-daemon drill (§3) is the owner's, after install |
| Plan-ready | PASS — 2026-10-25 — Claude, under the owner's delegation |
| Owner | hieu.nt10 |
| Routing decision | [ADR-038 § Routing Decision](../../adr/ADR-038-parallel-lanes-and-a-held-queue.md#routing-decision) |
| Requirements | [Missions PRD](../../product/paseo-bm-missions-prd.md) Phase 11: REQ-217, M-44 |
| Technical Design | [paseo-bm-delivery-line.md](../../design/paseo-bm-delivery-line.md) §19 |
| Mockup | [mission-lanes.html](../../design/mockups/mission-lanes.html) artboards Q, R — approved 2026-10-25 |
| Evidence | [Queue review 2026-10-25](../operations/paseo-bm-mission-queue-review-20261025.md); steer spike, design §19.9 |
| Branch | The working tree on `main` after `b88d576`; the owner picks the branch when they ask for a commit |
| Target release | None. It stops at acceptance: the owner tests, picks the version and releases |

## 1. MVP-Lock

- **In:** the delivery line design §19.1–§19.8 and its tests (§19.10).
- **Out:**
  - a merge request per lane;
  - lanes across missions;
  - a strict steer-only mode (it is upstream's to add);
  - automatic re-splitting of overlapping work (that is the Main's);
  - any release.
- **Exit:**
  - every work package's exit is met;
  - `npm run build` then `npm run verify` pass at the end;
  - the bundle stays under 2,000,000 bytes;
  - the screen matches mockup Q, R;
  - the owner's drill is listed (§3).

## 2. Work packages (Phase 11)

| WP | Outcome | REQ | Design | Needs | Exit |
|---|---|---|---|---|---|
| WP-11.1 | Lanes on the placement: `lane`, `mergedAt`, `freeSince`; `laneFor` with `MAX_LANES`; `ensurePlacement` for lane n (branch, slug, request key, dependency clone from lane 1's base); the resolver maps a lane to its repo | REQ-217 a | §19.1 | — | Placement tests: lane 2 made from the mission branch head, reused when free, refused past 7; `repoKeyOf` of a lane |
| WP-11.2 | `bm_create_worker` `lane: "new"`; staffing per lane; the brief's `lane:` line and branch; `bm_tell_worker` answers `turnMinutes` for a queued delivery | REQ-217 a, c | §19.1, §19.4 | WP-11.1 | Tool tests: a second request in a repo goes to lane 2; the refusal at 7 names the lanes' work; `turnMinutes` |
| WP-11.3 | Merging a lane: the report's `integration.lane`; `lane-merge.ts` fast-forward in lane 1; pending retries and the Main's notice; the free lane's reset before reuse | REQ-217 a | §19.2 | WP-11.1 | Git tests in scratch repositories: fast-forward, a refusal kept pending and retried, a clean reset, a dirty lane not reused |
| WP-11.4 | Overlap: changed files per live lane at turn ends; `BM-SIGNAL overlap` once per file set; a refused fast-forward signals; the governor's figure | REQ-217 b | §19.3 | WP-11.1 | Line-watch tests with two lanes in a scratch repository; signal once, again only when the set grows |
| WP-11.5 | The held queue: roster `held` and `after`; `bm_create_worker` `after`; the start at the last finished, the Main told on a stopped one; `bm_hold_cancel`; `bm_mission` lists held requests | REQ-217 e | §19.6 | WP-11.2 | Roster and tool tests: start, stop, cancel, a reload keeps the held request |
| WP-11.6 | Steered owner words: the owner-word classes; the notice queue's steer path with the guards; turn ids before and after; outbox `steeredAt` and `replaced`; the Main and Inbox notice on a replacement | REQ-217 d | §19.5, §19.9 | — | Notice-queue tests with a fake handle: steer sent only with the guards met, queued otherwise; a changed turn id recorded and reported |
| WP-11.7 | Role files: `manager.md` triage and overlap; `worker.md` lane merge and file ownership; within their line caps | REQ-217 b, c | §19.7 | WP-11.2, WP-11.3, WP-11.5 | Role-content tests; `npm run build` |
| WP-11.8 | The screen: `mission.get`'s lanes, overlap and waiting data; Repositories and In flight as mockup Q, R on desktop and phone | REQ-217 f | §19.8 | WP-11.1 → WP-11.6 | Model and render tests; the preview harness compared with the mockup |
| WP-11.9 | Close: docs as built (§19 "As built", missions design, base design pointers), M-44 in the replay, full verify | — | §19.10 | all | `npm run build` then `npm run verify`; replay prints M-44 |

## 3. The owner's drill (after install)

On an isolated daemon with a scratch repository that has an `origin`:
1. Give a mission two independent asks for one repository. Two lanes run at once.
2. Let both finish. Each merges into the mission branch, and the mission branch moves forward by fast-forward.
3. Make both change one file. The Main gets the overlap signal.
4. Send words to a busy Worker. They are steered and recorded.
5. Hold a request after another. It starts by itself when that one finishes.

## 4. Revision History

| Date | Author | Change |
|---|---|---|
| 2026-10-25 | Claude (owner's delegation) | Plan written after the owner approved mockup Q, R and chose "steer with guards" |
| 2026-10-25 | Claude (as built) | Completed: WP-11.1 → WP-11.9 closed with evidence; `npm run build` then `npm run verify` green (227 files, 6,334 tests, bench 11, eval 137; bundle 1,924,841 of 2,000,000). Departures in the delivery line design §19.11 |
