# paseo-bm — what agents are given to read, field review 2026-10-25

A read-only review asked by the owner: "the context of a mission's messages grows horribly long; it seems nobody compacts it, and the AI gets confused." It is the evidence of [ADR-037](../../adr/ADR-037-agents-are-given-a-bounded-context.md). Nothing was changed while measuring.

**What was read:**
- the 503 trace turns from the 0.6.0-equivalent install (2026-10-23 03:24 UTC) to 2026-10-24 18:20: 237 Main turns, 219 Worker turns, 47 Reviewer turns;
- the project memory of the four repositories (`memory/*.json`), the requests registry, `orchestrator/compactions.json`, the Coordination settings;
- through the daemon's read-only timeline API: the whole timeline of the AIX Main `cf5db8be` (443 items) and of the Worker `a11d5f2e` (549 items), and the first message of the Worker `1e0a0839`.

## 1. The project memory is a log nobody curates

| Repository | Active entries | Characters | From closed missions | Older than 3 days | Removed, ever |
|---|---|---|---|---|---|
| backend `ai-assistant` | 211 | 103,825 | 161 (76 %) | 170 | 1 |
| frontend `xspace-ai-assistant` | 205 | 99,342 | 142 (69 %) | 161 | 1 |

- By kind, the backend holds 106 facts, 53 decisions, 32 contracts and 20 conventions; the frontend 74, 62, 36 and 33.
- Many entries are dead history: handover commit hashes, local merges, the state of a pipeline, another mission's arbitration of files.
- **Why it grows.** `manager.md` says "add what Workers settled, with its source; remove what no longer holds". The AIX Main added a `fact` after almost every Worker report (29 adds on 10-24) and removed nothing. Removing has no trigger; adding follows every report.

## 2. A Worker's brief carries the memory wholesale

The first message of AIX's frontend Worker (`req-20261024T021730Z`) is **36,672 characters**:
- 34,535 (94 %) are `Project memory (xspace-ai-assistant):` — the newest 30 entries plus every `contract` entry, which has no bound (`create-worker.ts` `missionBriefLines`);
- the request itself, the scope rule and the mission lines are 1,149; the Main's `Context:` is 989.

A Worker asked for a dynamic-form mechanism was given contracts and facts of PEN, INO, OPT and XAI: menus, OAuth, CI, merges into another mission's checkout.

## 3. The Main's read tools return everything, and it keeps it

The AIX Main's timeline holds 982,011 characters:

| Item | Characters | Share | Largest one |
|---|---|---|---|
| `bm_memory` output | 280k | 28.5 % | 122,038 |
| `bm_mission` output | 196k | 19.9 % | 73,837 |
| `BM-DELIVERY` messages (97) | 154k | 15.6 % | 7,498 |
| shell output | 83k | 8.5 % | 22,587 |
| `bm_decisions` output | 63k | 6.4 % | 11,064 |

- In its first turn the Main read the whole memory of both repositories: 112,000 and 117,000 characters.
- `bm_mission` grew from 9k to 71k characters in a day: every request with its newest report (43k), and the newest 50 journal lines (13k).

## 4. The Main is compacted late

- The Main's context grew from 41,231 to 259,943 tokens over 137 turns without a compaction. Most turns took one `BM-DELIVERY` of about 1,600 characters, and each re-read the whole context.
- **Why.** `mainContextCrossingOf` reads the share of the window when the window is known: 60 % of Codex's 475,000 tokens is 285,000. `main.contextTokens` (150,000) is read only when no window is known.
- The 237 Main turns read at least 32 million tokens of context (last step only; Codex turns have several steps).

## 5. Deliveries repeat themselves

A `BM-UPDATES` of 13,947 characters to the Worker `a11d5f2e` held 10 items. Two links joined the same pair of Workers, so each status reply of the backend request arrived twice (items 5 and 6, 9 and 10), and four of the ten items were the same "blocked: waiting on review" status.

## 6. Workers

- Workers reached 626,325 tokens of context. Their context is mostly their own work: shell output is 47 % of `a11d5f2e`'s timeline; the brief is 5.7 %, `BM-UPDATES` 4.4 %.
- Rollover worked: `req-20261024T021730Z` was asked to finish at 552k and continued in `req-20261024T031153Z`. It acts at a turn's end, and one turn grew a Worker from 135k to 477k.
