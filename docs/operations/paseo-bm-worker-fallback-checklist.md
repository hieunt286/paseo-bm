# Acceptance checklist — role settings and provider fallback

| Field | Value |
|---|---|
| Status | Active — checks on a real daemon the role-settings and fallback features present in `0.3.0` |
| Source | [PRD delta §5](../archive/product/paseo-bm-prd-delta-20260921-worker-fallback-and-role-settings.md#5-bằng-chứng-thành-công), [design delta §8](../archive/design/paseo-bm-delta-20260921-worker-fallback-and-role-settings.md#8-testing-strategy), [plan delta §1.3](../archive/plans/paseo-bm-implementation-plan-delta-20260921-worker-fallback-and-role-settings.md#13-điều-kiện-ra) |
| Run by | the owner (hieu.nt10), on a real daemon |
| Scoring rule | An item not measured yet is recorded as **Not measured**, never as Pass. An item that fails is recorded as **Fail** with the measurement |

Each part is one feature, and records the first version that has it. A new feature about roles or fallback adds a new part here.

## Common preparation, and the way back

> **Warning:** **do not** install a new version or run `paseo plugin reload` while a `bm-*` agent is still running — doing so cuts the agent's turn (lesson from the 2026-09-16 run).

| # | Step | Record |
|---|---|---|
| 1 | Read `~/.paseo-bm/install.json` (`version`, `roles[]`) | the old version, to restore |
| 2 | Snapshot `~/.paseo/config.json` (the `agents.providers.bm-*` entries and `daemon.agentProfiles`) | the before snapshot |
| 3 | `npm run build` in the repo, on the commit to check | the build used for the check |
| 4 | `node dist/index.js install --home ~/.paseo-bm` | output, exit code |

**Way back:** `npx paseo-bm@<old version>` reinstalls the previous version. The values you set on the `bm-*` entries are not deleted by the new version; the old version will replace the whole entry on its next write.

## Thinking and model per profile (REQ-062, since `0.2.0-alpha.2`)

| # | Check | How | Expected result | Result |
|---|---|---|---|---|
| 13.1 | The profile's thinking reaches the Worker | Settings → Agent profiles → profile **Worker** (`bm-worker`) → Thinking = `max` → save. Give Manager a Small request | A new Worker runs with thinking `max`: **Metric** screen → request → the Worker node shows `thinking: max` (`runtimeInfo.thinkingOptionId`) for **100%** of Workers created afterwards | Not measured |
| 13.2 | The profile's thinking reaches the Reviewer | As 13.1 with profile **Reviewer** (`bm-reviewer`), for example `high`, and a Medium request (a Small request creates no Reviewer) | A new Reviewer runs at `high` | Not measured |
| 13.3 | Reinstalling does not delete | After 13.1, run `node dist/index.js install --home ~/.paseo-bm` again | The preview reports 0 configuration changes; `thinkingOptionId: "max"` is still on the `bm-worker` profile in `~/.paseo/config.json` | Not measured |
| 13.4 | `--role` changes only that role | `node dist/index.js install --home ~/.paseo-bm --role worker=<provider>/<another model>` | The `bm-worker` profile changes `model`, **loses** `thinkingOptionId`, keeps `modeId` if any; the `bm-manager` and `bm-reviewer` profiles do not change by a single byte | Not measured |
| 13.5 | `doctor` reports a change made in the app | In Settings, change the Worker's model; run `node dist/index.js doctor` | There is the line `bm-worker: base provider or model differs from what the installer wrote (changed in the app).`; the exit code is the same as before the change | Not measured |

## Worker and Reviewer on OpenCode, Pi (REQ-063, since `0.3.0-alpha.0`)

Needs an OpenCode provider and a Pi provider `available` on the daemon. Change a role's base provider with `node dist/index.js install --home ~/.paseo-bm --role <role>=<provider>/<model>`, and put it back as it was after each check.

| # | Check | How | Expected result | Result |
|---|---|---|---|---|
| 14.1 | A Worker on OpenCode finishes a Small request | `--role worker=opencode/<model>`; open Beads Manager, give a Small request on the acceptance fixture | The Worker is created with an OpenCode agent (mode) and `auto_accept` on; Manager receives both `received` and `finished` | Not measured |
| 14.2 | A Reviewer on OpenCode is created | `--role reviewer=opencode/<model>`; a Medium request (a Small request has no Reviewer, unless the user asks for a review) | The Reviewer is created **without error**, `auto_accept` **off**; if the OpenCode agent asks for permission, the approval request shows in Paseo | Not measured |
| 14.3 | A Reviewer on Pi is created | `--role reviewer=pi/<model>`; a Medium request | The Reviewer is created without error, with no mode; the Worker's `## Runtime facts` says `Reviewer mode: none` | Not measured |
| 14.4 | A Pi Worker without `pi-mcp-adapter` produces `BM-TOOLS` | On a machine without the adapter: `--role worker=pi/<model>`; give a request | The Manager chat receives `BM-TOOLS …` before the Worker's first turn ends; the Setup screen has a Worker warning line | Not measured |
| 14.5 | The `supportsMcpServers` signal | As 14.4, then `get_agent_status` of the Pi Worker | `capabilities.supportsMcpServers` is `false`. **If it is `true` or missing**, record it verbatim and report: the signal of design §4.2.4 is wrong | Not measured |
| 14.6 | The skill-load signal on OpenCode and Pi | After 14.1 and 14.3, open the **Metric** screen → request | The skill column of the OpenCode Worker / Pi Reviewer: record whether it shows or says "not recorded" (known limitation, design §4.2.8) | Not measured |
| 14.7 | Pi and OpenCode skill columns | Open Beads Manager → Setup | There is a Pi column (`~/.pi/agent/skills`) and an OpenCode column (`~/.config/opencode/skill`) | Not measured |
| 14.8 | Cost from `metadata.cost` | After 14.1, **Metric** screen → request | The OpenCode Worker's turn has a cost (not only tokens) | Not measured |


## Editing roles on the Setup screen (REQ-064, ADR-008, since `0.3.0-alpha.1`)

Before checking, snapshot the `daemon.agentProfiles` array and the `agents.providers.bm-*` entries of `~/.paseo/config.json` (step 2 of the preparation); 15.2 compares against that snapshot. This is where the plugin writes `config.json` itself (ADR-008, `plugin/server/config-writer.ts`).

| # | Check | How | Expected result | Result |
|---|---|---|---|---|
| 15.1 | Save on the screen → Settings shows the same values | Beads Manager → Setup → Roles & models → **Edit** on Worker → change the model (and thinking if the model has it) → **Save** | The Worker row shows the new model and the text "Saved."; Settings → Agent profiles → profile **Worker** (`bm-worker`) shows exactly that model and thinking | Not measured |
| 15.2 | 0 other profiles changed | After 15.1, compare `~/.paseo/config.json` with the before snapshot | Only `model` / `thinkingOptionId` / `modeId` of `bm-worker` and `extends` of `agents.providers.bm-worker` differ; **every** profile that is not `bm-*` is byte-identical, the array order is kept | Not measured |
| 15.3 | The next Worker runs the new model | After 15.1, give Manager a Small request | **Metric** screen → request → the Worker node shows exactly the saved model (`runtimeInfo.model`) | Not measured |
| 15.4 | Provider change → the live Manager is told | A Manager is open. Edit Worker → change to another provider (for example Codex) → Save; then give Manager a request | The Manager chat receives `BM-SETTINGS …` with the new `Worker mode` line (right away if Manager is idle, at the end of the turn if it is running); the next Worker is created **without** a mode error | Not measured |
| 15.5 | Revision mismatch → no write | Open Edit on Worker; in Paseo's Settings edit any profile and save; come back and click Save | The form reports exactly `The configuration changed elsewhere; reopen Roles & models.`; `config.json` does not change further | Not measured |
| 15.6 | Reviewer has no dangerous mode | Edit Reviewer on Claude or Codex | The Mode list does **not** have `bypassPermissions` / `full-access` / `plan` | Not measured |
| 15.7 | The warning does not block | Edit Worker → Pi (if available) → Save | It saves, and under the Worker row shows `Pi needs pi-mcp-adapter to give this role Paseo tools.` | Not measured |

Known risk (accepted by the owner, Q3 a, Q15 a): a change in Paseo's Settings that lands exactly while the plugin is writing (between the read and the write of one Save) can be overwritten without notice. There is no check step for this risk.

## Worker fallback (REQ-065, since `0.3.0-alpha.2`)

Needs a fallback chain for the Worker: Beads Manager → Setup → Roles & models → under the Worker row → **+ Add fallback** (for example Codex) → **Save fallbacks**. A real incident is best; without one, stage a failed turn with a fake provider (for example a Worker on a Pi provider that is not signed in, for L4).

| # | Check | How | Expected result | Result |
|---|---|---|---|---|
| 16.1 | Saving the chain writes the alias and the file | After saving, read `~/.paseo/config.json` and `~/.paseo-bm/role-fallback.json` | There is `agents.providers.bm-worker-fallback-1` with that entry's `extends`; the file has `roles.worker.entries` in the right order; 0 other profiles changed | Not measured |
| 16.2 | The card shows as soon as a Worker turn fails | A Worker stops because of a usage limit / billing / sign-in | The Manager chat has the card "Worker stopped by its provider plan" with the error verbatim; the pill "Fallback · 1 decision" on that Manager; `~/.paseo-bm/role-fallback-state.json` has a `pending` incident | Not measured |
| 16.3 | The card still shows when Manager is on the same base provider | Manager and Worker on the same base provider; the Worker runs out of its plan limit | Manager's turn fails too (harmless), but the card and the pill still show (read from the file, not from Manager's turn) | Not measured |
| 16.4 | Switch creates a replacement Worker | Click **Switch to …** on the card | Within **≤ 60 seconds** there is a Worker "Beads Worker (fallback)" on `bm-worker-fallback-1/<model>`, label `bm.replaces` = the old Worker; the old Worker carries `bm.replacedBy`; the new Worker sends `received` and **does not reopen** closed beads | Not measured |
| 16.5 | One Worker per request | After 16.4, answer a question of that request on the card | The answer reaches the new Worker, not the old one; the agent tree shows `· replaced by <id>` next to the old Worker | Not measured |
| 16.6 | `listUsage` returns windows | On an L1 incident of Claude or Codex | The incident has `resetsAt` (the latest reset time among the exhausted windows); the card has a **Wait until <time>** button | Not measured |
| 16.7 | Wait | Click **Wait until …** | The incident is `waiting`; at the reset time + 60 seconds, the old Worker receives `BM-RESUME …` and continues; the card records that it resumed | Not measured |
| 16.8 | I'll handle it | Click **I'll handle it** on another incident | The incident is `dismissed`; no agent is created or stopped | Not measured |

Known risk: the default recognition patterns have not been checked on a real incident (proposal §1.5). If 16.2 has no card, record the failed turn's error verbatim in the Result column: that is the data to fix the patterns.

## Reviewer and Manager fallback (REQ-066, since `0.3.0-alpha.3`)

Needs a fallback chain for the Reviewer and for the Manager (Beads Manager → Setup → Roles & models, the block under the Reviewer row and the Manager row). As in the Worker fallback part: a real incident is best, otherwise stage a failed turn with a fake provider; never try to push a provider to its usage limit.

| # | Check | How | Expected result | Result |
|---|---|---|---|---|
| 17.1 | Switch a Reviewer | A Reviewer stops because of a usage limit / billing / sign-in; click **Switch to …** on the card in the Manager chat | The parent Worker receives `BM-FALLBACK` with a `create_agent` instruction; the Worker creates a Reviewer on `bm-reviewer-fallback-1/<model>` labelled `bm.replaces` = the old Reviewer, and sends it the old review message verbatim; the old Reviewer carries `bm.replacedBy` | Not measured |
| 17.2 | The review count does not grow | After 17.1, **Metric** screen → request | The request's review count **does not grow** because of the resent message; there is no `BM-BUDGET` because of it | Not measured |
| 17.3 | Resend to Worker | **Not reproduced on a real daemon**: the message is only queued while the Worker is running, so the plugin would have to be reloaded mid Worker turn — against the warning in the preparation. Checked only by automated test (`test/fallback-reviewer.test.ts`) | The card shows the **Resend to Worker** button when a Reviewer incident is `switched` but there is no replacement Reviewer yet; clicking it makes the Worker receive the same instruction again | Not measured (automated test only) |
| 17.4 | Switch a Manager | A Manager stops because of its provider plan; click **Switch to …** on the card in that same Manager chat | There is a new Manager on `bm-manager-fallback-1/<model>` with a `BM-HANDOVER` role manager handover (Worker, pending questions, your three most recent messages with secrets masked); the card says "A new Beads Manager is running on …" | Not measured |
| 17.5 | Beads Manager opens the replacement Manager | After 17.4, open Beads Manager from the sidebar or the Command Center | It opens the new Manager, not the old one; the old Manager stays until you archive it | Not measured |
| 17.6 | The Worker reports to the new Manager | After 17.4, a running Worker sends its next report | The Worker has received `BM-SETTINGS` with the line `Manager agent id: …`; the next report reaches the new Manager | Not measured |


## Auto switch and auto wait (REQ-067, since `0.3.0-alpha.4`)

Item 18.1 is the prerequisite before turning on **Auto switch**: the patterns must classify at least one real incident correctly (it was a release condition of `0.3.0-alpha.4`, decided by the owner in Q17 b; already Passed on the owner's machine). The other items need a fallback chain, and the **Auto switch** policy set separately for the role being checked (Beads Manager → Setup → Roles & models). As in the Worker fallback part: a real incident is best, otherwise stage a failed turn with a fake provider; never try to push a provider to its usage limit.

| # | Check | How | Expected result | Result |
|---|---|---|---|---|
| 18.1 | The patterns classify a real incident correctly (REQ-067 c) | Read `~/.paseo-bm/role-fallback-state.json` (read only) | At least one incident has a `signal` and `message` produced by a real provider, and a `class` that is correct for that error according to the patterns (default or from the file) | **Pass** — read 2026-09-23 (`req-20260923T040415Z`). The file has 1 incident: `fb-d3c9430912b2`, `role` `worker`, `signal` `completed`, `message` `"Failed to authenticate. API Error: 401 API key is invalid."` — produced by the real Anthropic refusing a Claude Code turn, `class` `L4`, `status` `switched`. There is no `~/.paseo-bm/role-fallback.json`, so the patterns in force are `DEFAULT_PATTERNS`. Running the actual `classifyText` of `plugin/shared/fallback-patterns.ts` on that `message`: returns `L4`, matching pattern `/\b401\b/i`, `isFallbackClass` true — **the same** as the `class` recorded in the file. |
| 18.2 | Choice and warning | Choose **Auto switch** for Worker, then for Manager; **Save fallbacks** | Under the policy row there is a cost warning; Manager's also has "The chat you use may be replaced."; `role-fallback.json` has `policy: "auto"` for exactly that role, other roles unchanged | Not measured |
| 18.3 | Auto switch | A Worker with Auto switch stops because of its provider plan, with no known reset time (or a reset time more than 30 minutes away) | No click needed: there is a replacement Worker as in 16.4; the Manager chat receives **one** card, in the switched state — no "pending" card before it | Not measured |
| 18.4 | Auto wait | An L1 incident of Claude or Codex with a reset time ≤ 30 minutes away | The incident is `waiting` right away, no agent is created; at the reset time the old agent receives `BM-RESUME` as in 16.7 | Not measured |
| 18.5 | No candidate | A role with Auto switch but an empty chain (or every candidate already used) | The incident stays `pending`, the card as with Ask me | Not measured |
| 18.6 | Ask me unchanged | A role left on "Ask me" | As 16.2: a `pending` card, nothing runs by itself | Not measured |

Known risk: turning on Auto switch while 18.1 has not passed means one misclassification creates a surplus agent. If 18.3 creates an agent for a turn that is not a plan error, record that turn verbatim in the Result column and set "Ask me" back.

---

*Revision 2026-09-25: kept as the current checklist for role settings and fallback; part titles changed from phase numbers to features, "Dashboard" renamed to the Metric screen, sentences about the entry/exit conditions of closed phases removed; checks that need a Reviewer use a Medium request because a Small request no longer creates a Reviewer. The measured result (18.1) is kept as is.*
