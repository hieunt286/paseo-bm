# paseo-bm — field review of the delivery flow, 2026-10-20

A read-only review of how the agent flow ran on the owner's machine from 2026-10-02 to 2026-10-20, asked by the owner as a check against a "software factory" standard. It is the evidence of [ADR-035](../../adr/ADR-035-a-delivery-line.md). Nothing was changed while measuring.

**What was read:**

- All 4,397 trace records (12 workspaces, 2026-10-02 → 20), every decision store (359 decisions since 10-02, 141 since 10-15), the requests registry, the outbox (1,885 records), the peer links (55), the handoffs (28), the 10 missions with their journals (1,649 lines) and every `orchestrator/*.json`.
- The replay (`npm run eval:replay`), bundled and run outside the repository for both windows.
- The activity of the Orchestrator, the Mains of OPT and INO, a frontend Worker and a Reviewer.
- Read-only `git log` and `git status` of the two target repositories:
  - backend `ai-assistant` (BE);
  - frontend `xspace-ai-assistant` (FE).

The build on the machine since 2026-10-15 is the ADR-034 Mission-List build. The missions:

- XAI, closed on 10-19;
- OPT and INO, opened on 10-19, with the same two repositories.

## 1. Requests have no end

Since 10-15, **four requests read 89 % of all tokens** (4.08 of 4.59 billion):

- OPT `req-…073520Z` and `…073536Z`;
- INO `…105259Z` and `…132118Z`.

Each one has:

- 232–643 turns;
- 6–310 files, 53–99 beads and 6–20 review batches;
- 23–28 hours of activity.

The median request reads 8.4 million tokens, takes 10 turns and lasts 0.4 hours.

The Main opens one request per repository per mission and keeps sending it new waves. `manager.md` says a follow-up on an area a Worker holds goes to that Worker, and the Worker sizes it. A handoff continues the same request.

Every limit counted per request was set for a request a hundred times smaller:

- the review budget;
- the handoff threshold and its two-per-request maximum;
- the loop guard;
- the governor's `beadsPerRequest` of 15, which is only a figure.

## 2. One working tree for three missions

- XAI, OPT and INO resolve to the same two workspace ids, so their Workers write one checkout and one branch (`hieunt/xai-ai-assistant-dev`) in each repository.
- Nothing in the plugin isolates or serialises writes. `writers-observed`, `mission.conflict` and `bm_arbitrate` detect or advise.
- The Mains invented hunk-by-hunk "writer" grants over their link.

What this produced since 10-15:

- **Shared files:** 58 FE and 28 BE files touched by more than one mission.
- **Arbitrations:** 16, 15 of them on 10-19/20.
- **Main↔Main messages:** 404 in two days.
- **Outbox records:** of 1,593, 30 % mention "hunk", 273 "writer" and 201 "nhường" (yield).
- **Contracts:** OPT holds 51, with 83 versions.
- **Blocked time:** 37.9 of 73.8 blocked hours (51 %) were spent waiting on the other mission or a peer.
- **Commits:** mixed, for example `Checkpoint(XAI+OPT+INO): 7 tệp lẫn nguồn` ("7 files of mixed source").

## 3. No integration stage

- **Verification:** 48 of 62 finished requests (77 %) since 10-02, and 19 of 21 (90 %) since 10-15, finished unverified. The checks were self-reported 21 times and detected 2 times.
- **Uncommitted on 10-20:**
  - BE: 233 entries (165 files, +5,744 / −9,750 lines);
  - FE: 319 entries.
- **Unpushed:** 38 BE and 41 FE local commits since the last push, on 10-15.
- **CI:** both repositories' GitLab pipelines run only on a merge request or a tag. The BE pipeline is a Gradle build plus a SonarQube quality gate; the FE pipeline is `yarn verify`. Neither ran on five days of work.
- **Workarounds:** BE Workers built by copying the tree into a temporary folder.
- **Reports and figures:** a Worker's report has no git field, and the governor has no figure for uncommitted or unpushed work.

## 4. Every delivery wakes a Worker

- **Blocked rounds:** 285 since 10-15, in only 9 requests. A blocked Worker was woken again after a median of about 0 minutes and reported `blocked` again.
- **Tokens in blocked turns:** turns ending blocked read 1.98 of 4.21 billion Worker tokens (47 %).
- **Turn cost:** a median Worker turn made 2 tool calls and read 1.06 million tokens.
- **Compaction and handoff dropped:** they need a safe point with nothing queued. 15 of 19 Worker compactions and 18 of 28 handoffs were dropped as `no-safe-point`.
- **A handoff that kept failing:** one BE handoff was retried 11 times while its request grew from 153 million to 1.27 billion tokens.

## 5. Limits that nobody who is asked can lift

Review budget:

- **Verdict rates:** a first review passed in 20 % of cases (33 of 162), a re-review in 68 %.
- **Decisions on `review-budget`:** 67, answered 35 times by the policy, 26 times by the owner and 5 times by the Main. The owner chose the recommendation 25 times out of 26.
- **Delegated answers re-asked:** 26 of 40 policy or Main answers were asked again within 4 hours.

The causes in the code:

- A delegated `untilClean` is converted into `{ calls: n }` (`review-tools.ts` `applyReviewBudgetGrants`). It therefore never lifts the one-re-review rule.
- The resolver names the Main as decider whenever any option fits its share, and "no more reviews" always fits (`authority.ts` rule 4; `test/authority.test.ts` pins `mainLeft: 0` → Main). The Main's grant is then refused with "grants more review calls than your share leaves".
- A precedent on `review-budget` is accepted by the Settings, by prepared changes and by `bm_ask_owner`. The card promises "Later questions … get this answer without asking you", but `precedent-resolve.ts` never applies it. On 10-20 the owner saved one, and the Orchestrator told them review budgets would now be answered automatically.
- The Settings cap a tier's budget at 8 calls; Large requests reached 28.
- Batches do not follow the size of the change: the rank correlation of files to batches is 0.39, and one request had 9 batches for 6 files. `worker.md` closes beads one at a time, the `implementing-beads` skill reviews before each close, and `reviewer.md` reviews the whole change in every batch.

Owner cards since 10-15: about 37 of 76 owner answers (49 %) were not product decisions.

| Kind | Count |
|---|---|
| Review budget | 10 |
| The same question asked twice, as a Worker `q:` and a Main `m:` | 8 |
| Orchestrator process or relay cards, 2 of them because its quota was spent | about 12 |
| Provider fallbacks | 2 |
| Mechanical apply cards | 4 |

The owner waited a median of 20.8 minutes for a card, with p90 at 92.5 minutes.

Governor:

- **Loop guard:** one guard of 12 commands per mission per 24 hours takes code nudges, re-plans and arbitrations alike. Repeat arbitrations of an area already decided count again. On 10-19 both OPT and INO spent it by 15:00, and every later command became an owner card.
- **Drift:** `mainTurnsSinceCriterion` reached 339 (threshold 40) because 96 % of INO's Main turns were started by plugin notices.
- **Stalled:** `stalled` crossed and cleared 22 times as blocked Workers were re-woken.
- **Outcomes:** of 42 `govern` interventions, 7 met, 17 missed and 18 are unknown.

## 6. Communication through the Main, in free text

**Who starts Main turns.** Of the Mains' turns since 10-15, 7 % were started by the owner.

| Started by | Turns | Share |
|---|---|---|
| The owner | 74 | 7 % |
| Peer messages | 385 | 38 % |
| Reports | 345 | 34 % |

**The Mains relay.** A Worker's report ends "relay to OPT", and the Main sends it on with `bm_peer_reply`. ADR-028 decision 8 says nobody relays.

**Messages are free text.** There is no act, reference or acknowledgement field, so threads close with invented markers ("Không cần ack", "no ack needed").

**Main messages became hard to read.**

| Messages | Average word length |
|---|---|
| Main→Main and Main→Worker | 11.3 characters |
| Workers | 5–6.6 characters |
| OPT contract texts | 24 characters |

No tool limit forced it. The likely causes are relay volume, about ten "one line" instructions in `manager.md`, and character-cut views of links and the journal.

**Stale agreements.** The state brief after a compaction carries no contracts, and each link only as its first ask. A Worker once removed code after reading a stale Main message (contract C47), and restored it later (C48).

**Duplicate governors.** Five idle Orchestrator agents keep the `bm.orchestrator=main` label; only "newest wins" tells them apart.

## 7. Outside the plugin

Mission XAI was closed with two integration criteria open (D3, D11). Per the owner, that is a case of that mission, not a class of the plugin, so it is not carried into ADR-035.
