# Run note — the four role files rewritten from zero, 2026-09-29

| Field | Value |
|---|---|
| Bead | `bm-autonomy-phase1a-odkl.12` (WP-107) |
| Requirement / design | PRD REQ-117 (a)–(e); autonomy design §A.11, with the "as built" notes of §A.3–§A.9; ADR-017, ADR-020 |
| Files | `plugin/roles/{manager,worker,reviewer,orchestrator}.md`, the generated `plugin/server/*-instructions.ts`, the tool list in `ORCHESTRATOR_FIRST_PROMPT` (`plugin/server/orchestrator-agent.ts`), `test/roles-content.test.ts` (rewritten) |
| Style rule kept | a few limits about CLASSES of action in `## RULES`; everything else a positive instruction at the step that needs it; no ban per incident (owner, 2026-09-17) |

## 1. Budgets

| File | Before | Budget | After | `## RULES` limits |
|---|---|---|---|---|
| `manager.md` | 201 | ≤ 120 | 120 | 5 |
| `worker.md` | 400 | ≤ 250 | 249 | 5 |
| `reviewer.md` | 167 | ≤ 120 | 120 | 4 |
| `orchestrator.md` | 181 | ≤ 100 | 100 | 3 |

`test/roles-content.test.ts` pins the budgets, the number of limits and the length of each `## RULES` block, the duties below, the fallback blocks something parses, and the absence of every retired mechanism (`BM-ANSWERED`, `BM-STALL`, `BM-EVENT`, proposals, answer letters, relays, the gate, `autopilot-on`, `manager-turn`).

## 2. Where every old rule went

"Kept" means the rule is still in the file, reworded or condensed. "Mechanism" means the plugin now enforces it and the file no longer says it. "Retired" means the mechanism it described is gone or going (design §A.14).

### Manager

| Old rule | Now |
|---|---|
| Rule 1 — you change nothing; reading is yours | Kept: RULES 1 |
| Rule 2 — a relay, not a decider: the request and the owner's answers reach the Worker verbatim, answers as the `BM-ANSWERS` of `blocked` | Retired as a relay (ADR-017): the plugin delivers answers (`decision-delivery.ts`, §A.6). "No requirement of your own; never approve, adjust or reject a plan" kept as RULES 2, which adds "never answer a Worker's question in the owner's place" |
| Rule 2 — a fact you read may be sent with its source | Changed: a Manager's `BM-ANSWERS` settles decisions only in a turn with the owner's typed message (§A.5 b, §A.16), so the Manager gives the owner the fact and its source instead ("Questions and answers") |
| Rule 3 — never say more than you can see; read status and activity | Kept: RULES 3 and step 1 |
| Rule 4 — never archive or delete an agent, never approve a permission | Mechanism: the tool policy removes `archive_agent`, `kill_agent`, `respond_to_permission`, `set_agent_mode`, `update_agent` and the schedules (ADR-020, `config-writer.ts`). The owner-facing sentence "archiving or deleting is the owner's own action" kept in "Following a request" |
| Rule 4 — cancel a run only when stuck/off course, asked, or a broken creation | Kept: RULES 4 |
| Rule 5 — no secrets; own id from `$PASEO_AGENT_ID` | Kept: RULES 5 |
| Step 1 — restate the request in one sentence | Dropped: the `received` card states the request's tier and summary; the Manager adds only what the card lacks |
| Step 1 — one short question when truly ambiguous | Kept: step 2 |
| Step 2 — answer what reading answers, create no Worker | Kept: step 1 (now with `bm_decisions`) |
| Step 3 — delegate now, before any lookup; do not call `list_agents` first | Changed: delegation stays immediate, but the brief now needs the related requests, so `list_agents` is part of the context (REQ-117 c) |
| Step 3 — `BM-NEW-REQUEST` is always new work | Kept: step 2 |
| Step 3 — never send to a `running` Worker; hold the words | Kept: step 3 |
| Steps 4–5 — creation failure; confirmation with id, requestId, missing skills | Kept: step 4 |
| Creating the Worker — `requestId`, `list_profiles` once, provider, labels, mode from Runtime facts (`none` → no mode) | Kept verbatim where parsed ("Context and the Worker's brief") |
| "If it names no Worker mode, the creation fails with Paseo's list" | Covered by step 4 (quote Paseo's cause and fix) |
| First prompt — request verbatim, requestId, repo, size only if stated, "Do only what the request asks", own id, the collision line | Kept, plus a **Context** part: the owner's goals and earlier decisions, the related requests (REQ-117 c) |
| Coordinating — wake a waiting Worker on what you have seen | Kept: "Keeping the work aligned", second paragraph |
| Coordinating — answer a fact in `BM-ANSWERS` as `other — <fact>` | Retired (see rule 2 above) |
| Coordinating — hold one Worker when two collide, never by delaying creation | Kept: the collision line of the brief |
| Coordinating — say it before, say it after | Dropped for the budget; what the Manager sends shows in the Worker's chat |
| Coordinating — unsure is a question | Covered by RULES 3 and "ask which one" for answers |
| Talking — reports are cards; never repeat the card; silence is normal; read activity, never ask for progress | Kept: "Following a request" |
| Talking — the notice list (`BM-FORMAT`, `BM-BUDGET`, `BM-TOOLS`, `BM-SETTINGS`, `BM-FALLBACK`, `BM-RESUME`, `BM-ANSWERED`, `BM-HANDOVER`) | Short list with "…": each notice says what to do (pinned on the notices themselves in `roles-content.test.ts`). `BM-ANSWERED` retired (qa-ledger, sweep `bm-autonomy-phase1b-dbdv.6`); `BM-FALLBACK` no longer reaches the Manager (`f:` decisions, `fallback-rpc.ts`) |
| `BM-COMMAND` is the owner's word; `limits:` are no yes to commit, push, deploy, real data | Kept, now "within its `approved:` and `limits:`" — v2 derives `limits:` from what the authority approved (§A.7) |
| `copy: yes` — keep in mind, do not relay, one line at most | Kept |
| `received` / `beads-done` one line | Kept, plus the alignment check (REQ-117 d) |
| `blocked` — letters A, B; `A6 a`; show a no-block report's questions in full; send each Worker its own `BM-ANSWERS` once not running; `BM-ANSWERED` closes questions; do not relay an answer twice | Retired (ADR-017): one decision card per question everywhere, the plugin delivers. What stays: one line at `blocked`; when the owner answers in the Manager's chat, `bm_answers` in the reply; an answer fitting no single question → ask which one |
| `finished` — count `decided` and suggestions; ask which suggestion becomes work; wake a Worker that finished waiting | Kept, plus the alignment check |
| A turn end without a report; stuck; stop; archive | Kept: "Following a request" |
| How you talk — few lines, the owner's language, only the request; unrelated tool, connector and system notices never reach the owner | Kept. The notice clause was first cut and came back after the live smoke (§3): a Manager told the owner about an unrelated connector notice |
| (new) | The project's context (goals, related requests, earlier decisions), the brief's Context part, the alignment check raised as a question with options, `bm_decisions` by requestId, `bm_answers` in the reply (REQ-117 c–e) |

### Worker

| Old rule | Now |
|---|---|
| Intro — the change is the job, beads the instrument, this file decides on safety, budget, reporting, asking and scope | Kept (one paragraph) |
| Rule 1 — nothing leaves the workspace without a yes; a request naming it is that yes | Kept, and the yes now also comes from an option the owner chose that declares the effect, or a `BM-COMMAND`'s `approved:` line (§A.3, §A.7) |
| Rule 2 — never destroy or undo what you did not create | Kept |
| Rule 2 — never archive, kill or delete an agent, including yourself | Mechanism: the Worker's tool policy has no `kill_agent` or `archive_agent` (ADR-020); `cancel_agent` on its own Reviewers stays in Stop |
| Rules 3, 4, 5 | Kept |
| The loop (steps 1–6); process follows what you design; skill cadence; keep your context small | Kept, condensed into the loop |
| How big is this — risk not diff; Large/Small/Medium; raise the tier; the table with 2 / 2 / 4 calls; Small writes no new document; documents in the repo's docs and language | Kept |
| Splitting — one outcome per leaf; leaf checklist; Primary Proof and Reversibility; `feature:<slug>` and duplicates; SPLIT into siblings; never delete; lint headings; Provenance; `br lint -s all` | Kept, condensed |
| "A separate field never replaces a lint heading; an existing heading never goes away" | Dropped: `br lint -s all` reports it |
| Proving — cheapest evidence; no test command is no excuse; `git status` first; per-bead cycle; one `in_progress`; `implementing-beads`; read-only helpers; close only on a result read | Kept, condensed ("output with failures is not evidence" folds into "after reading the check's own result" and RULES 4) |
| Reopen a closed bead on a blocking finding; scratch directory deleted before the next report | Kept |
| "Changes after `finished` are a new batch `b<n>`" | Covered by "a batch keeps its `batchId` (`b1`, `b2`, …)" |
| Deciding — look before you ask; decide what you can undo; `decided` line; the four kinds | Kept |
| How to ask — one round, early; at most 5; `Q<n>` across the request; one recommended; `blocked` through `bm_report`; `AskUserQuestion` returns nothing; silence is no answer; an action option written as done | Kept |
| "Write the questions in your chat too; every point to confirm is a question, never a remark" | Condensed: questions go only through `blocked` |
| The `BM-QUESTIONS` example (two questions) | Kept as one question, now with the `[subject: …]` and `[effects: …]` tags the materialiser reads (§A.5); the test parses it |
| Answers — `BM-ANSWERS` block; `other` = own words or a fact the Manager verified | Changed: answers arrive from the plugin as `BM-DELIVERY answers`, `Continue <requestId>.`, `BM-ANSWERS` (`decision-delivery.ts`); the Manager's verified fact is retired (ADR-017) |
| An answer to a question that is not open: say so | Mechanism: the plugin delivers only answered, undelivered questions of the request, and a settled decision cannot be answered again (`E_DECISION_SETTLED`) |
| An unanswered question: ask it again at the next `blocked` | Changed: it stays open on its card and is not asked again (§A.6: open questions stay open, the Worker carries on) |
| An answer that does not settle its question: ask under a new number | Kept, now with `supersedes: <old Qn>` and the same `subject` (§A.3) |
| An answer that reads as scope sent as a fact: re-ask | Retired with the Manager's facts |
| (new) | `subject` per question, `effects` per option — "the owner's choice is their yes for exactly those" (§A.3, §A.5) |
| Reviewing — batch id kept; one review, one re-review; only Large or asked; a review is a message to a Reviewer you created | Kept |
| Create the Reviewer — provider, labels, mode from Runtime facts | Kept verbatim |
| The brief — requestId, batchId, scope, stage, checks; the Reviewer knows the criteria, do not paste them | Kept |
| `changes-required`, non-blocking to suggestions, blocked after the re-review, budget question and what a yes covers | Kept |
| A Reviewer's provider error → wait for `BM-FALLBACK` | Kept |
| Reporting — `send_agent_prompt` with `notifyOnFinish: false` to the Manager id, else the chat; only at the four phases; `bm_report` verbatim; chat summary in the owner's language | Kept |
| Reporting — what `blockers`, `decided`, `suggestions` hold | Mechanism: `bm_report`'s schema descriptions (`plugin/shared/bm-tools.ts`) |
| The hand-written fallback — `Suggestion (not done)` placement, `blockers` of a `blocked` report | Mechanism: `BM-FORMAT` names what to fix (`format-check.ts`); the `BM-REPORT` template stays as the degraded mode (REQ-113 c) |
| Notices — `BM-FORMAT`, `BM-SETTINGS`, `BM-HANDOVER`, `BM-RESUME`, `BM-FALLBACK` say what to do; `BM-ANSWERS` is the owner's answer | Kept, with `BM-DELIVERY` added to the list |
| `BM-COMMAND` — the owner's word through the Orchestrator; its `limits:` are no yes; check an interrupted step first | Kept; the yes now reads from `approved:` (RULES 1) |
| Stop — what a stop is, `BM-STOP`, what is not a stop, the three steps | Kept |

### Reviewer

| Old rule | Now |
|---|---|
| "A Beads Worker created you … it may send you one re-review" | Trimmed (other agents): the re-review stays in "What you review" and "Stop" |
| Rule 1 — never create, message, stop, archive or delete an agent | Mechanism: the Reviewer has no Paseo tools (`paseoTools: { enabled: false }`, ADR-020) |
| Rule 1 — a tool is not permission; skip a check the limits hold back | Kept |
| Rules 2, 3, 4 | Kept |
| What you may run; `git status --porcelain` before and after | Kept |
| Missing requestId/batchId/stage/scope → `changes-required`; effort in proportion to risk; stage bullets; re-review checks only the old blocking findings | Kept, condensed |
| Criteria table; skill locations; sensitive batches' abuse cases | Kept |
| Blocking list; non-blocking; never upgrade a suggestion; at most three | Kept ("an empty list is fine" dropped) |
| The contrast pair as a YAML findings block | Kept as a prose pair, same two findings (owner decision Q20) |
| `bm_review` first; the `BM-REVIEW` template; `BM-FORMAT`; the stop line | Kept |

### Orchestrator

| Old rule | Now |
|---|---|
| "You act only through your tools; the owner decides; you propose or send" | RULES 1 and 2; proposals retired (§A.14): `bm_ask_owner` with prepared commands replaces them |
| Rule 1 — you change nothing yourself; provider tools not for this job | Kept |
| Rule 2 — send only on Autopilot or the owner's word, else propose; never say a proposal was sent; never ask for commit/push/deploy/real data; big decisions to the owner | Changed to authority from declared effects (§A.7): every command declares its intent and effects; Autopilot or the owner's word covers all but push, publish, deploy, real-data, migration, security, cost (`CONFIRM_EFFECTS`), which need an answered decision's grant. The tools refuse anything else |
| Rule 3 — only what your tools show | Kept |
| Tool list with `bm_propose_command` | `bm_propose_command` dropped (retired), `bm_decisions` added, `detail: "full"` on demand (§A.9). Also in `ORCHESTRATOR_FIRST_PROMPT` |
| A signal is a hint; verify a claim with `bm_repo`; no tools → one line and stop; notes | Kept |
| Commands — pass workspaceId, agent id, request | Mechanism: the tool schemas require them |
| Commands — the Manager's language; one per situation; a new proposal replaces the pending one; the plugin writes the block | Kept except the proposal clause (retired) |
| Direct to a Worker — only a correction or its own questions' answers; `BM-ANSWERS`; the Manager's copy; `interrupt: true` only on an open danger | Kept; the interrupt allowance is named on the event line (`event-bus.ts`) and enforced by the tool |
| The gate — refusal → `bm_ask_owner` with 2–5 options; allowing a category is the owner's Allow…; never reword | Changed: a refusal means nothing was sent — declare the real effect or ask; never reword. "Allow…" dropped (the tab's categories cover no effect, §A.7; the tab goes, §A.12) |
| `BM-EVENT question` / `finished` / `autopilot-on` / `manager-turn` / `worker-signal` catalogue, with a line per signal | Replaced by the `BM-EVENTS` lines built (§A.8): `decision.opened`, `request.finished`, `request.stalled`, `worker.signal` with the six signals; `autopilot-on` and `manager-turn` retired |
| `BM-STALL` | Retired: `request.stalled` |
| Nothing to do → do nothing; a big decision → `bm_ask_owner` and one line | Kept |
| In other projects propose; on the owner's word send; `bm_set_autopilot` on request | Authority rule (RULES 2); `bm_set_autopilot` kept |
| Ignore unrelated connector or tool notices | Kept in "Talking to the owner" |
| Assessment — once, fix and retry, rubric table, scale, English | Kept |
| Assessment — at most 12 findings, 5 suggestions, 600 characters | Mechanism: `bm_assessment`'s schema (`MAX_FINDINGS`, `MAX_SUGGESTIONS`, `MAX_SUGGESTION_CHARS`) |
| "Each suggestion can be added from the Orchestrator tab" | Dropped (the tab goes, §A.12); "never say you added or applied one" kept |
| Situation / Done / Needs you; the owner's word wins | Kept |
| (new) | `BM-ANSWER` with its grant, carried out with `decisionId`; prepared commands (`to`, `agentId`, `intent`, `body`); one open decision per request unless `separate: true`; claim a replacement only when the tool names the replaced id |

## 3. Live smoke on an isolated daemon

| Field | Value |
|---|---|
| Paseo | CLI and daemon 0.9.2 |
| Daemon | `scripts/manual-test/start-daemon.sh` on port 6903, work dir `live-roles` in the session scratchpad; the owner's `~/.paseo`, `~/.paseo-bm` and port 6767 untouched; stopped with `stop-daemon.sh` |
| Plugin | the working tree's `plugin/` (`paseo plugin add` → `status: running`; `paseo plugin reload` after the one text change) |
| Roles | `setup.ensure-roles` → manager, worker, reviewer, orchestrator on `claude` / `claude-opus-5-5`; `setup.grant-agent-tools {"confirmed":true}` on the test daemon only |

**Run 1** (workspace `demo`, `br init`): `manager.ensure` created a Manager; the owner's message "Add a one-line comment above add() in math.js that says it returns the sum of a and b. This is a Small change." went through `send.mjs`.

- The Manager created one Worker (`bm.role=worker`, `bm.requestId=req-20260929T132105Z`, mode from Runtime facts). The Worker's first prompt carried the request verbatim, the requestId, the repository and `.beads/`, "Size: Small (stated by the owner)", the "Do only what the request asks" line, the Manager's id, and a **Context** part ("Owner's goals/earlier decisions: none recorded beyond this request. Related requests: none").
- The Worker sent `received` (Small) and `finished` through `bm_report`: no bead, no Reviewer; `filesChanged: math.js`; proof `add(2,3)` printed 5 and the file read back.
- The Manager checked alignment at `received` ("That matches what you asked for") and verified the result itself with `git diff` at `finished`; it reported no `decided` choices and no suggestions. `git diff` in `demo`: one added line `// Returns the sum of a and b.` above `add()`. Idle within 40 seconds.
- **Finding:** in its first confirmation the Manager told the owner about an unrelated claude.ai connector needing authorization. The rewrite had cut the "unrelated tool, connector and system notices never reach the owner" clause; it was put back in `manager.md` and pinned in `roles-content.test.ts`.

**Run 2** (workspace `demo2`, a fresh Manager with the corrected text, same request without the size): the Worker sized it Small itself, the same one-line diff, `received` and `finished` as above; the Manager's confirmation named the Worker, the requestId and that it is the only Worker, and said nothing about connectors. Both requests finished.

Not exercised live: a `blocked` round (decision cards, `BM-DELIVERY answers`), a Medium or Large request with a Reviewer, the Orchestrator's events. Those paths are covered by the unit and fake-SDK tests of their beads (`decision-delivery`, `decision-materialiser`, `event-bus`, `orchestrator-tools`).
