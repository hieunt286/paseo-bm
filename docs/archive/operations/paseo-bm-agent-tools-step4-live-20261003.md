# Run note — ADR-027 step-4 live check on an isolated daemon, 2026-10-03

| Field | Value |
|---|---|
| Bead | `bm-agent-tools-1upv.12` (WP-713) |
| Design | [base design](../../design/paseo-bm.md) §16.13 (step 4 live check), §16.6, §16.7, §16.8, §16.10; [ADR-027](../../adr/ADR-027-agents-write-content-code-carries-it.md) decisions 2–4, 10, 11 |
| Paseo | CLI and daemon **0.10.2** |
| Daemon | isolated, `scripts/manual-test/start-daemon.sh` on port **6913**, home and data folder under the session scratchpad; `setup.grant-agent-tools` turned `injectIntoAgents` on in that test config only. The owner's `~/.paseo`, `~/.paseo-bm` and port 6767 were untouched. At the end the port was checked (`127.0.0.1:6913`, the test home), the daemon stopped with `stop-daemon.sh`, and the home deleted |
| Plugin | the branch's `plugin/` (build current, `0.5.2` labels), installed with `paseo plugin add <repo>/plugin` → `status: running`, the only plugin on the daemon |
| Roles | `setup.ensure-roles` created four roles; Manager, Worker and Reviewer were then set to `claude/claude-haiku-4-5` with `roles.save-settings` (on the isolated home only; the Reviewer's default was Codex). The Orchestrator was never opened |
| Target repo | a throwaway git repo created by `new-workspace.sh demo`: `math.js`, `greeting.js` (`greet(name)` → `Hello, <name>!`), two `node:test` files, `br init --prefix demo`; no remote |
| Owner actions | the two requests sent with `send.mjs` (DaemonClient `sendAgentMessage` with a `messageId`, so `clientMessageId` set); each question answered with `decisions.answer { optionKey: "a", via: "inbox" }`; three permission requests, each a Reviewer's `Bash npm test` in `auto` mode, allowed once with `paseo permit allow <agent> <request> --home <test home>`. No `AskUserQuestion` was raised |
| Coordination settings | defaults: `review.smallBudget` 2, `mediumBudget` 2 |

## 1. Pre-check: the bound tool lists equal design §16.6

`npm test -- test/plugin-agent-tools.test.ts` → **33/33 passed**. It pins, against a live endpoint and `toolFacesFor`:

| Agent | Tools |
|---|---|
| Bound Manager | `bm_create_worker`, `bm_tell_worker`, `bm_answers`, `bm_decisions` |
| Bound Worker | `bm_report`, `bm_questions`, `bm_create_reviewer`, `bm_rereview`, `bm_reply` |
| Bound Reviewer | `bm_review` |

The run's Manager came from `manager.ensure` with a binding `{ role: "manager", state: "bound", creationTools: true }`.

## 2. The requests

Both request texts told the Manager to create the Worker with `bm_create_worker`, and the Worker to report with `bm_report`, ask one question with `bm_questions`, then report `blocked` with `waitingOn`, review with `bm_create_reviewer`, and finish with `bm_report`. The role files have not been rewritten yet (step 5), so the text named the tools.

| | Small `req-20261003T113319Z` | Medium `req-20261003T113706Z` |
|---|---|---|
| Asked | `greet` says "Hi" instead of "Hello"; update its test | add `farewell(name)` and `conversation(name)` = greet + farewell, each with a test; plus a re-review via `bm_rereview` |
| Owner message → `bm_create_worker` | 11:32:51 → 11:33:19 | 11:37:01 → 11:37:07 |
| Question (`bm_questions`) | Q1 `greeting-punctuation`, `preference`, opened 11:33:34; answered `a` 11:34:22 | Q1 `conversation-separator`, `preference`, opened 11:37:23; answered `a` 11:38:00 |
| Review calls | `bm_create_reviewer` b1 → `reviewCalls: "1 of 2"` | `bm_create_reviewer` b1 → `"1 of 2"`; `bm_rereview` b1 → `delivery: queued`, `"2 of 2"` |
| Verdicts | b1 `first` `pass` | b1 `first` `pass`; b1 `re-review` `pass` |
| Finished report delivered | 11:35:32 | 11:39:20 |
| Repo after | 2 files changed, `npm test` 2/2 pass, not committed | 2 files changed, `npm test` 4/4 pass, not committed, 0 beads |

Tool calls per agent (from the agents' timelines):

| Agent | Calls |
|---|---|
| Manager | 2 × `bm_create_worker`, 1 × `ToolSearch` (before its first call) |
| Small Worker | 4 × `bm_report` (one rejected by Claude Code's own JSON parse before reaching the plugin), 3 × `bm_questions` (2 refused), 1 × `bm_create_reviewer`, Read/Edit/Bash |
| Medium Worker | 4 × `bm_report` (1 refused: `decided[0]: must be an object`), 3 × `bm_questions` (2 refused), 1 × `bm_create_reviewer`, 1 × `bm_rereview`, Read/Edit/Bash |
| Small Reviewer | 1 × `bm_review`, Read/Bash |
| Medium Reviewer | 2 × `bm_review`, Read/Bash |

Not one `send_agent_prompt` or `create_agent` call by any agent.

## 3. Checks

| # | Check | Result |
|---|---|---|
| 1 | The bound tool lists equal §16.6's table | **Pass**: §1 |
| 2 | Every report, question, review and re-review arrived as a delivery with a card | **Pass**, see below |
| 3 | The Dashboard's review count equals the tools' count, for each request | **Pass**: `traces.list` `reviewCalls` **1** (Small) and **2** (Medium); the tools returned `1 of 2` and `2 of 2`; registry calls `create:out-eb366cc7173a` and `create:out-e91fc4914a60, rereview:out-07f7ceb87771` |
| 4 | No `BM-FORMAT` sent | **Pass**: 0 messages starting with `BM-FORMAT` in each of the 5 agents' timelines |
| 5 | No hand-sent block | **Pass**: every `user_message` is the owner's text (2), a plugin `BM-BRIEF` prompt (4), or a `BM-DELIVERY` plugin notice (14); none has origin `agent`. 0 `send_agent_prompt` / `create_agent` calls |

**Deliveries (check 2).** For this check, every `user_message` of every agent was run through the branch's own `toChatCards` (`plugin/client/chat-card-parse.ts`, bundled with esbuild into the scratchpad) and `originOf`:

| Delivery | Count | From → to | Outbox state | Card | Format issues |
|---|---|---|---|---|---|
| `BM-DELIVERY report` (received, blocked, finished) | 6 (3 per request) | Worker → Manager | 6 × `delivered` | `progress` received ×2, `progress` blocked ×2, `finished` ×2, all `direction: received` | 0 |
| `BM-DELIVERY review` | 3 (Small first; Medium first and re-review) | Reviewer → Worker | 3 × `delivered` | `verdict` pass ×3 | 0 |
| `BM-DELIVERY message` (the re-review) | 1 | Worker → Reviewer | `delivered` (returned `queued`: the Reviewer was still finishing its turn; delivered when it went idle, 11:38:48) | `notice` | 0 |
| `BM-DELIVERY answers` (the owner's answer) | 2 | plugin → Worker | (decision delivery) | `notice` | 0 |

- **Questions.** Each `bm_questions` call opened one `q:<requestId>:Q1` decision with `askedBy: worker`, two options, and exactly one recommended. Each decision was listed in `decisions.list { scope: "inbox" }`, which is the decision card's source, and the Manager's chat got the `blocked` report card (`blockers: waiting on the owner: Q1`). After the answer the decision read `answered` (`by: owner, via: inbox`), and the answer reached the Worker as `BM-DELIVERY answers` / `Continue <requestId>.` / `BM-ANSWERS`. At the end the Inbox held 0 open decisions.
- **Trace store.** Each of the 9 report and review record ids appears exactly once in `traces/<ws>/events-202610.jsonl`: the collector wrote tool-built reports into the sender's record once.
- **Wake-ups (§16.10).** Workers and Reviewers were created by the plugin with `parent`, so only deliveries woke them. Each Worker turn after the first began on a delivery: the answer, then the verdict. The Medium Reviewer's second turn began on the re-review message. No `no-verdict` record was sent, and none was due: each review call got a verdict.
- **Inbox alerts.** None: no `delivery-dropped` and no `off-tool-reviewer`.
- **Plugin log.** Only `bound to its own tool path`, `answered for` and `refused a call for` lines; no warning and no error.

## 4. Observations (not plugin failures)

- **Haiku's first `bm_questions` call used `AskUserQuestion`'s shape** in both requests (`question`, `header`, `multiSelect`, `label`, `description`). The tool refused it field by field. Its second call put "(Recommended)" in an option's text, refused with `leave out "(recommended)"; set recommended: true instead`, and the Medium one also had no `recommended` (`exactly one option is recommended (found 0)`). The third call passed. The refusals worked as §16.6 says, and nothing was opened before the valid call. The role files (step 5, WP-711) should show `bm_questions`' shape so a Worker gets it right the first time.
- **One `bm_report` was refused** for `decided[0]: must be an object` (the Worker passed a string); the next call passed.
- **The Manager ran `ToolSearch` once** before its first `bm_create_worker`. The Workers and Reviewers called their tools directly. Cost: one extra step for the Manager's first request.
- **Reviewers in `auto` asked to run `npm test`** (3 requests, all `Bash npm test`, allowed once). The Reviewer mode rules are unchanged by this work.
- The Medium Worker created no beads, although the request allowed one per change. That is the Worker's sizing judgement and is not checked here.

## 5. Evaluation suite

`npm run test:eval` on the tree: **6 files, 134 tests, all passed** (eval-owner 26, eval-suite 36, eval-replay 28, eval-links-audit 11, eval-scenarios 11, eval-score 22), about 10 s.

## 6. Result

Every check passed and no plugin bug was found, so no new bead was created. The observations in §4 are for the role-file rewrite (WP-711).

## 7. Clean-up

The isolated daemon was stopped with `scripts/manual-test/stop-daemon.sh` after its port and home were checked. Afterwards nothing listened on 6913 and no process referenced the test home. The work folder (Paseo home, data folder, demo repo) was deleted. The scratch inspection scripts lived in `scripts/manual-test/` only during the run and were deleted. Claude Code wrote its own transcripts of the test turns under the real `~/.claude/projects/`, as every run of this kit does.
