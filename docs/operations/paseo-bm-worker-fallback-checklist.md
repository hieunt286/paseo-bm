# Acceptance checklist — role settings and provider fallback

| Field | Value |
|---|---|
| Status | Active — checks on a real daemon the role-settings and fallback features present in `0.3.0`. **Its installer steps are out of date:** the `node dist/index.js install` / `doctor` / `--role` commands belong to the 0.3.x installer, which 0.4.0 replaced by the plugin's Settings (roles and fallback chains) and whose source is gone from the tree since [ADR-022](../adr/ADR-022-retirements-after-code-review.md). Until this checklist is rewritten, run those steps through Settings → Agents instead; the fallback Auto switch is retired too (ADR-022 decision 4) |
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
| 14.4 | A Pi Worker without `pi-mcp-adapter` produces `BM-TOOLS` | On a machine without the adapter: `--role worker=pi/<model>`; give a request | The Manager chat receives `BM-TOOLS …` before the Worker's first turn ends; Settings → Agents has a Worker warning line | Not measured |
| 14.5 | The `supportsMcpServers` signal | As 14.4, then `get_agent_status` of the Pi Worker | `capabilities.supportsMcpServers` is `false`. **If it is `true` or missing**, record it verbatim and report: the signal of design §4.2.4 is wrong | Not measured |
| 14.6 | The skill-load signal on OpenCode and Pi | After 14.1 and 14.3, open **Work → the workspace → Requests** → the request → **Timeline** | Whether the skills the OpenCode Worker / Pi Reviewer used show in its reports or are "not recorded" (known limitation, design §4.2.8) | Not measured |
| 14.7 | Pi and OpenCode skill columns | Open Beads Manager → Settings → Tools & skills | There is a Pi column (`~/.pi/agent/skills`) and an OpenCode column (`~/.config/opencode/skill`) | Not measured |
| 14.8 | Cost from `metadata.cost` | After 14.1, **Work → Requests** → the request's cost and **Details** (tokens per model) | The OpenCode Worker's turn has a cost (not only tokens) | Not measured |


## Editing roles in Settings → Agents (REQ-064, ADR-008, since `0.3.0-alpha.1`)

Before checking, snapshot the `daemon.agentProfiles` array and the `agents.providers.bm-*` entries of `~/.paseo/config.json` (step 2 of the preparation); 15.2 compares against that snapshot. This is where the plugin writes `config.json` itself (ADR-008, `plugin/server/config-writer.ts`).

| # | Check | How | Expected result | Result |
|---|---|---|---|---|
| 15.1 | Save on the screen → Settings shows the same values | Beads Manager → Settings → Agents → Roles & models → **Edit** on Worker → change the model (and thinking if the model has it) → **Save** | The Worker row shows the new model and the text "Saved."; Settings → Agent profiles → profile **Worker** (`bm-worker`) shows exactly that model and thinking | Not measured |
| 15.2 | 0 other profiles changed | After 15.1, compare `~/.paseo/config.json` with the before snapshot | Only `model` / `thinkingOptionId` / `modeId` of `bm-worker` and `extends` of `agents.providers.bm-worker` differ; **every** profile that is not `bm-*` is byte-identical, the array order is kept | Not measured |
| 15.3 | The next Worker runs the new model | After 15.1, give Manager a Small request | **Work → Requests** → the request → **Details**: the Worker's line shows exactly the saved model (`runtimeInfo.model`) | Not measured |
| 15.4 | Provider change → the live Manager is told | A Manager is open. Edit Worker → change to another provider (for example Codex) → Save; then give Manager a request | The Manager chat receives `BM-SETTINGS …` with the new `Worker mode` line (right away if Manager is idle, at the end of the turn if it is running); the next Worker is created **without** a mode error | Not measured |
| 15.5 | Revision mismatch → no write | Open Edit on Worker; in Paseo's Settings edit any profile and save; come back and click Save | The form reports exactly `The configuration changed elsewhere; reopen Roles & models.`; `config.json` does not change further | Not measured |
| 15.6 | Reviewer has no dangerous mode | Edit Reviewer on Claude or Codex | The Mode list does **not** have `bypassPermissions` / `full-access` / `plan` | Not measured |
| 15.7 | The warning does not block | Edit Worker → Pi (if available) → Save | It saves, and under the Worker row shows `Pi needs pi-mcp-adapter to give this role Paseo tools.` | Not measured |

Known risk (accepted by the owner, Q3 a, Q15 a): a change in Paseo's Settings that lands exactly while the plugin is writing (between the read and the write of one Save) can be overwritten without notice. There is no check step for this risk.

## Worker fallback (REQ-065, since `0.3.0-alpha.2`)

Needs a fallback chain for the Worker: Beads Manager → Settings → Agents → Roles & models → under the Worker row → **+ Add fallback** (for example Codex) → **Save fallbacks**. A real incident is best; without one, stage a failed turn with a fake provider (for example a Worker on a Pi provider that is not signed in, for L4).

| # | Check | How | Expected result | Result |
|---|---|---|---|---|
| 16.1 | Saving the chain writes the alias and the file | After saving, read `~/.paseo/config.json` and `~/.paseo-bm/role-fallback.json` | There is `agents.providers.bm-worker-fallback-1` with that entry's `extends`; the file has `roles.worker.entries` in the right order; 0 other profiles changed | Not measured |
| 16.2 | The decision shows as soon as a Worker turn fails | A Worker stops because of a usage limit / billing / sign-in | The Inbox has an `f:` decision "Worker stopped by its provider plan" with the error verbatim and the options Switch / Wait / handle it yourself; no `BM-FALLBACK` is sent to the Manager; `~/.paseo-bm/role-fallback-state.json` has a `pending` incident | Not measured |
| 16.3 | The decision still shows when Manager is on the same base provider | Manager and Worker on the same base provider; the Worker runs out of its plan limit | Manager's turn fails too (harmless), but the decision still shows in the Inbox (read from the incidents file, not from Manager's turn) | Not measured |
| 16.4 | Switch creates a replacement Worker | Choose **Switch to …** on the decision in the Inbox | Within **≤ 60 seconds** there is a Worker "Beads Worker (fallback)" on `bm-worker-fallback-1/<model>`, label `bm.replaces` = the old Worker; the old Worker carries `bm.replacedBy`; the new Worker sends `received` and **does not reopen** closed beads | Not measured |
| 16.5 | One Worker per request | After 16.4, answer a question of that request on its decision card | The answer reaches the new Worker, not the old one; the agent tree shows `· replaced by <id>` next to the old Worker | Not measured |
| 16.6 | `listUsage` returns windows | On an L1 incident of Claude or Codex | The incident has `resetsAt` (the latest reset time among the exhausted windows); the decision has a **Wait until <time>** option | Not measured |
| 16.7 | Wait | Choose **Wait until …** | The incident is `waiting`; at the reset time + 60 seconds, the old Worker receives `BM-RESUME …` and continues; the settled decision in the Inbox says it resumed | Not measured |
| 16.8 | I'll handle it | Click **I'll handle it** on another incident | The incident is `dismissed`; no agent is created or stopped | Not measured |

Known risk: the default recognition patterns have not been checked on a real incident (proposal §1.5). If 16.2 has no decision, record the failed turn's error verbatim in the Result column: that is the data to fix the patterns.

## Reviewer and Manager fallback (REQ-066, since `0.3.0-alpha.3`)

Needs a fallback chain for the Reviewer and for the Manager (Beads Manager → Settings → Agents → Roles & models, the block under the Reviewer row and the Manager row). As in the Worker fallback part: a real incident is best, otherwise stage a failed turn with a fake provider; never try to push a provider to its usage limit.

| # | Check | How | Expected result | Result |
|---|---|---|---|---|
| 17.1 | Switch a Reviewer | A Reviewer stops because of a usage limit / billing / sign-in; choose **Switch to …** on its decision in the Inbox | The parent Worker receives `BM-FALLBACK` with a `create_agent` instruction; the Worker creates a Reviewer on `bm-reviewer-fallback-1/<model>` labelled `bm.replaces` = the old Reviewer, and sends it the old review message verbatim; the old Reviewer carries `bm.replacedBy` | Not measured |
| 17.2 | The review count does not grow | After 17.1, `traces.get` of the request (`reviewCalls`) | The request's review count **does not grow** because of the resent message; there is no `BM-BUDGET` because of it | Not measured |
| 17.3 | Resend to Worker | **Not reproduced on a real daemon**: the message is only queued while the Worker is running, so the plugin would have to be reloaded mid Worker turn — against the warning in the preparation. Checked only by automated test (`test/fallback-reviewer.test.ts`) | The card shows the **Resend to Worker** button when a Reviewer incident is `switched` but there is no replacement Reviewer yet; clicking it makes the Worker receive the same instruction again | Not measured (automated test only) |
| 17.4 | Switch a Manager | A Manager stops because of its provider plan; choose **Switch to …** on its decision in the Inbox | There is a new Manager on `bm-manager-fallback-1/<model>` with a `BM-HANDOVER` role manager handover (Worker, pending questions, your three most recent messages with secrets masked); the settled decision says "A new Beads Manager is running on …" (with **Open**) | Not measured |
| 17.5 | Beads Manager opens the replacement Manager | After 17.4, open Beads Manager from the sidebar or the Command Center | It opens the new Manager, not the old one; the old Manager stays until you archive it | Not measured |
| 17.6 | The Worker reports to the new Manager | After 17.4, a running Worker sends its next report | The Worker has received `BM-SETTINGS` with the line `Manager agent id: …`; the next report reaches the new Manager | Not measured |


## Environment delegated (REQ-067, replaces the Auto switch since ADR-022)

The Auto switch was retired ([ADR-022](../adr/ADR-022-retirements-after-code-review.md) decision 4): a role's policy is **Ask me** or **Off**, and an incident is answered without the owner only where the owner delegates the **Environment** class for the project (Settings → Autonomy) or a precedent answers it. Item 18.1 still comes first: the patterns must classify at least one real incident correctly.

| # | Check | How | Expected result | Result |
|---|---|---|---|---|
| 18.1 | The patterns classify a real incident correctly (REQ-067) | Read `~/.paseo-bm/role-fallback-state.json` (read only) | At least one incident has a `signal` and `message` produced by a real provider, and a `class` that is correct for that error | Passed on the owner's machine (before ADR-022) |
| 18.2 | An old Auto setting | A role whose `role-fallback.json` still says `policy: "auto"` | Settings → Agents shows Ask me for it, with the one-time notice and **Got it**; after Got it the file says `ask` | Not measured |
| 18.3 | Delegated Environment switches | Environment delegated to the recommended option for the project; a Worker stops on its provider plan, no known reset time (or more than 30 minutes away) | No click needed: a replacement Worker as in 16.4; the decision is answered `by: policy`, listed in the Inbox's Decided for you digest | Not measured |
| 18.4 | Delegated Environment waits | As 18.3, an L1 incident of Claude or Codex with a reset time ≤ 30 minutes away | The incident is `waiting` right away, no agent is created; at the reset time the old agent receives `BM-RESUME` as in 16.7 | Not measured |
| 18.5 | No candidate | As 18.3 with an empty chain (or every candidate already used) | The decision stays open for the owner, as with Ask me | Not measured |
| 18.6 | Not delegated | Environment left to the owner | As 16.2: a `pending` incident with its decision in the Inbox, nothing runs by itself | Not measured |

Known risk: delegating Environment while 18.1 has not passed means one misclassification creates a surplus agent. If 18.3 creates an agent for a turn that is not a plan error, record that turn verbatim in the Result column and take the delegation back (a reversal also demotes the class).

---

*Revision 2026-09-25: kept as the current checklist for role settings and fallback; part titles changed from phase numbers to features, "Dashboard" renamed to the Metric screen, sentences about the entry/exit conditions of closed phases removed; checks that need a Reviewer use a Medium request because a Small request no longer creates a Reviewer. The measured result (18.1) is kept as is.*

*Revision 2026-09-29: where to look and press follows the screens after the autonomy programme's Phase 1 (retirement sweep, bead `bm-autonomy-phase1b-dbdv.6`): roles and fallback chains in Settings → Agents, skills in Settings → Tools & skills, a request's model and cost in Work → Requests → Details, review counts from `traces.get`, a fallback incident as an `f:` decision in the Inbox (no fallback card, no pill, no `BM-FALLBACK` to the Manager). Checks and results unchanged.*
