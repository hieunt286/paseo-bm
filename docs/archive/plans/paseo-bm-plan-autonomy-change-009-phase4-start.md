# Change Request — Phase 4 start: the spike's verdict, and what the code as built and the field change

| Field | Value |
|---|---|
| Change ID | `autonomy-change-009` |
| Short name | Phase 4 start re-check |
| Original plans | [Phase 4](../../plans/paseo-bm-plan-autonomy-phase4.md) (Active); the combined field period of [change-006](paseo-bm-plan-autonomy-change-006-build-then-field.md) (bead `bm-autonomy-phase6-i8fc.6`) |
| Status | Applied — approved by Claude under the owner's delegation; plan, design and the bead edits of §4 (made through `br`, 2026-10-01) |
| Owner | hieu.nt10 |
| Created | 2026-10-01, bead `bm-autonomy-phase4-loga.2` |
| Accepted | 2026-10-01 — Claude under the owner's delegation. No PRD target or owner decision changes; the path follows ADR-019's decision record |
| Applied | 2026-10-01 |

## 1. Change summary

The Phase 4 start re-checked design Part D, its §D.4 decisions (change-003) and the Phase 4 beads against:
- **the spike** (bead `loga.1`, [run note](../operations/paseo-bm-action-boundary-spike-20260930.md)) and [ADR-019](../../adr/ADR-019-action-boundary-permission-events.md)'s decision record: **Accepted for Claude and Codex, OpenCode keeps detection**;
- **the code as built** after Phases 1–3 and the consolidation (module names, the mode rule, the decision kinds, A-6's grants, the fake SDK);
- **the field data available now** (read-only replay of 2026-09-30T16:55Z, numbers only; the data folder's paths, sizes and times were the same before and after).

**The path taken is the pass path** (WP-402, WP-403; beads `loga.3`, `loga.4`). The plan's branch rule closes the fail path's bead (`loga.5`, WP-404) as not applicable, citing the spike report. What REQ-142 asks for the providers that stay on detection moves into WP-403 (C1).

The re-check found five gaps that would stop the boundary from working as Part D means it:
- **The mode rule picks by tier and keeps a caller's Worker mode** (C2). The spike's modes depend on the base provider, and Codex also needs creation options.
- **Nothing shows a role that runs without the boundary** (C3).
- **The scratch directory the Worker's rule 1 allows sits outside the workspace** (C5). Without an exemption most of the field's outside-workspace commands would be held.
- **An owner's allow in Paseo's own prompt would be lost** (C6), so field A-6 could not reach 0.
- **An allowed action would still raise a `danger` alert** (C7): two Inbox items for one action.

It also brings the beads up to the code as built (C10). Every other decision is confirmed (§3.2).

## 2. Compelling reason

**The spike** (Paseo 0.9.2, isolated daemon, 24 agents):
- Claude `default` and `acceptEdits`, and Codex `auto` with `approval_policy: untrusted`, pass all three §D.1 criteria. Added latency p90: 201 ms (Claude), 163 ms (Codex).
- Claude `auto`, Codex `auto` and `auto-review` as they are, and OpenCode fail criterion 1.
- A plugin answers with `context.paseo.agents.ref(id).respondToPermission`; a plain allow is allow-once.
- Requests wait with no timeout, with or without the plugin. Nothing is replayed to a restarted plugin.
- Codex needs its options at creation, and a file change carries its path only on the pending timeline item.
- Not measured: a Codex MCP call under `untrusted`; a deploy command.

**The code as built:**
- `chooseModeId` (`server/role-mode.ts`) gives the Worker the first `dangerous` mode and **keeps any mode its creator passed**. A Manager created before this phase passes `bypassPermissions` from its Runtime facts, so the hook would never correct it. The Reviewer and the Orchestrator share one rule, which picks Claude `auto`, a mode that fails criterion 1.
- The hook's lookups share a 5 s budget. When it runs out, the agent starts with its instructions only: no mode correction and no provider options (`registerRoleHook`).
- `decisionKindOf` (`shared/decisions.ts`) reads every id that is not `q:`, `o:` or `r:` as a fallback incident, so a new `h:` prefix needs a kind of its own.
- A-6's grants (`grantsOf`, `shared/eval-metrics/scope.ts`) count only owner-answered `q:` decisions and commands on an `o:` grant.
- An agent created while the plugin is down gets no instructions, hence no `bm.instructions` label, and is already flagged `outdated-agent` after 5 minutes (`outdated-agents.ts`).
- `respond_to_permission`, `list_pending_permissions` and `set_agent_mode` are in the Manager's and the Worker's `disabledTools` (`setup-roles.ts`). The Reviewer and the Orchestrator have no Paseo tools. The Worker keeps `create_agent`.
- `test/helpers/fake-paseo.ts` already fakes `respondToPermission` and logs every answer.
- `worker.md` is at 250 of 250 lines.

**The field** (whole store: 62 requests, 59 finished, 2026-09-16 → 2026-09-30):
- **Turns by provider:** Claude 1,900, Codex 155 (Reviewers), OpenCode 1. The boundary's two providers cover almost every field turn.
- **A-6:** 204 effectful actions, 76 not shown to be authorised:
  - `git push` 84 (8 not shown);
  - `npm publish` 35 (1);
  - `DROP TABLE` 2 (0);
  - `TRUNCATE` 8 (1);
  - `rm -rf` outside the workspace 75 (66).
- **`rm -rf` targets not judged: 317.** A variable, such as `rm -rf "$d"`, cannot be judged from the text.
- Baseline §3 already names the `mktemp -d` scratch directory that worker.md allows as the inflation of the `rm -rf` figure.
- **The Phase 1 build:** 1 request, with 1 `rm -rf` outside the workspace. **The fixed build:** unused. **The Phase 3 build:** not installed; its exit is judged in the combined field period (change-006, `i8fc.6`).

## 3. What changes — Before / After

### 3.1 Changes

| # | Item | Before | After |
|---|---|---|---|
| C1 | The path and the fallback's scope (plan §1, WP-404, REQ-142) | One path for all providers: WP-402/403 if the spike passes, WP-404 if it fails | **Pass path for Claude and Codex; detection for the rest.** <br>• `loga.5` (WP-404) is closed as not applicable, citing the spike report and ADR-019's decision record. <br>• **What REQ-142 still asks moves to WP-403 (`loga.4`)** for every role the boundary does not cover: OpenCode, Pi, Copilot and other ACP providers, a hand-set mode, and a role created without the boundary (C3). The docs say detection for them, and Settings → Agents says the boundary is off. |
| C2 | Modes per role (§D.2; `role-mode.ts`, `role-hook.ts`, `role-instructions.ts`) | "The least permissive mode that still lets the plugin allow ordinary work", read from mode tiers. A caller's Worker mode is kept. The Reviewer and the Orchestrator get `auto` first | **A table keyed by the alias's base provider** (`aliasBases`, already read in the hook's `prepare`): <br>• **Worker:** Claude `default`; Codex `auto` + `providerOptions { approval_policy: "untrusted", sandbox_mode: "danger-full-access", web_search: "disabled" }`. <br>• **Reviewer:** Claude `default`; Codex `auto` + `{ approval_policy: "untrusted", sandbox_mode: "workspace-write", web_search: "disabled" }`. <br>**The creator's mode:** a Worker or Reviewer created in any other mode is moved to its boundary mode. Only a mode hand-set on its profile wins (§D.4). <br>**Out of the table:** the Manager and the Orchestrator keep their rules; the Orchestrator keeps `auto` and gets its own rule apart from the Reviewer's. Other base providers keep today's rules (`runPostureOf`, the tier rule). <br>**Runtime facts:** the Manager is told the Worker mode and the Worker the Reviewer mode, as today. <br>**Gate before Codex switches:** a Paseo and a paseo-bm MCP call on Codex `untrusted` are measured on the isolated daemon (`loga.3`). A call that arrives as a request is allowed by name. A call that fails without a request keeps Codex roles on their current modes and on detection, and Part D says so |
| C3 | Whether an agent runs under the boundary | Not shown. §D.4: Settings → Agents says the boundary is off for a hand-set mode | **Each Worker's and Reviewer's Runtime facts carry one line**, `Action boundary: on` or `off — <why>`, written by the hook from what it applied. A missing line counts as off: the hook ran out of its 5 s budget (the agent then has no mode correction and no Codex options), or the plugin was down. <br>**The label:** `agent.created` labels `bm.boundary=on\|off` from that line, beside `bm.instructions` (`agent-labels.ts`), through `paseo-cli.ts`. <br>**Settings → Agents** shows per role whether the boundary applies (provider, hand-set mode). <br>**A `boundary-off` Inbox alert** is raised for a live Worker or Reviewer on Claude or Codex whose `bm.instructions` is current and whose `bm.boundary` is not `on`, unless its profile mode was hand-set. An agent with no instructions at all is already an `outdated-agent` alert. The alert clears when the agent is archived, replaced or gone |
| C4 | What a request is read as (§D.2) | "The classification finds …" from `detail`/`input` | **The table of spike §4.** <br>• **Claude** (the cwd is the agent's cwd; the request carries none): `Bash` → `detail.command`; `Edit` / `Write` / `NotebookEdit` → `detail.filePath`; `WebFetch` / `WebSearch` → network. `mcp__*`: Paseo's agent tools and paseo-bm's own are allowed by name, but `create_agent` whose `provider` is not a `bm-reviewer*` alias is held (effect `security`: an agent outside the boundary). Any other MCP server is held as unreadable. <br>• **Codex:** `CodexBash` → `detail.command` + `detail.cwd`. `CodexFileChange` → the path of the pending timeline `tool_call` whose `callId` is `metadata.itemId` (`timeline.refetch` tail); not found → unreadable. <br>• **Other tool names and kinds:** any other tool name is unreadable until `loga.3`'s live check lists the names an ordinary request raises (for example Claude's `Skill`, `TodoWrite`, `Task`), which are then allowed by name. A `kind` other than `tool` is left to Paseo's UI, where it keeps the `permission-waiting` alert. <br>• **Unreadable:** held; its Allow option declares `security`, so neither a grant nor the policy covers it and the owner confirms it (X-4) |
| C5 | The classes and the scratch area (§D.2; `shared/effectful-actions.ts`, `shared/shell.ts`) | release, real-data/migration, dependency-install, network, outside-workspace; "reuses `classifyCommand` / `dangerOfCommand`". No dependency or network patterns | **The command is read per segment** (`&&`, `;`, `\|`, and `sh -c`/`bash -c` bodies). <br>• **release:** `EFFECTFUL_PATTERNS`' push, publish and deploy lines, plus `gh release create`. `npm\|pnpm\|yarn run <script>` (and `npm test` and similar) is classified by its body in the cwd's `package.json`; a script that cannot be read is unreadable. <br>• **data:** the SQL patterns, a database CLI given a write statement, and migration runners. <br>• **dependency:** `npm\|pnpm\|yarn add\|install\|i <package>`, `pip install <package>`, `brew install`, `cargo add\|install`, `go get`, `gem install`. A bare `npm install` / `npm ci` from the lockfile is not held. <br>• **network:** `curl`, `wget`, `ssh`, `scp`, `rsync` to a host, `nc`, and the provider's fetch tools. `git fetch`/`pull`/`clone` are not held. <br>• **outside-workspace:** a write path (file tool, `rm`, `mv`, `cp`, `>`, `>>`, `tee`, `mkdir`, `touch`, `ln`) that resolves outside the workspace folder, **except the scratch area**: the system temp roots (`/tmp`, `/private/tmp`, `/var/folders/*/*/T`, the daemon's `TMPDIR`) and a variable the same command assigned from `mktemp`. worker.md's rule 1 already allows one `mktemp -d` scratch directory. <br>**A-6's `rm -rf outside the workspace` uses the same scratch rule** (one home, `effectful-actions.ts`). The replay reports scratch deletions apart, so the Phase 0 figure stays readable. <br>**`commit` is not held** (§D.4). <br>**The limit:** only the literal command is classified. A script's own effects are seen only by detection |
| C6 | The held decision (§D.4, §A.3; `shared/decisions.ts`, `eval-metrics/scope.ts`) | `h:<agentId>:<requestId>`; grant covers and is spent; `delegate` allows with `policy:<class>`; unreadable held; no recommended option. A request resolved elsewhere withdraws its decision. A card in the Inbox and the chat | **Confirmed:** the id, the grant rule, the policy rule, unreadable held, no recommendation. <br>**Added:** <br>• **Kind:** `h:` is a kind of its own in `decisionKindOf` / `deliveryKindOf` (`held`, delivered as `permission`). <br>• **Record:** asked by `plugin` for the agent. Subject `held-<class>`. The question names the masked command or path. Options `allow` (the held effects; `permission { allow: true }`) and `deny` (`none`). <br>• **At open:** never answered by a precedent or by the policy's predictor, and it raises no `decision.opened`, so there is no prediction and no `bm_decide`. The plugin applied grants and the policy before holding. <br>• **A policy-covered request** is stored as an `h:` decision answered at open `by: policy` (class, the cell's predictor), so Inbox → Decided for you shows it. Nothing is delivered, because the request is already allowed. <br>• **An owner's Allow in Paseo's own prompt** (`agent.permission_resolved` with `behavior: "allow"`) records the decision answered `by: owner`, `via: paseo` (a new `ANSWER_VIA` value, additive), its grant spent at once. A deny or an interrupted turn withdraws it. The Worker's chat shows Paseo's own prompt: there is no chat card of ours, only the Inbox item and Work's timeline. <br>• **Ending:** a finished report never expires it. A Worker labelled `bm.replacedBy` has its open `h:` decisions withdrawn and its pending requests denied ("You were replaced"). <br>**A-6:** `grantsOf` counts an owner-answered `h:` Allow as a grant of its request |
| C7 | One Inbox item per action (`worker-watch.ts`) | No `permission-waiting` alert for a held request | **Kept, and `danger` too:** the live watch raises `danger` only for an effectful action that no grant of its request covered before it ran, an allowed `h:` included. So an Allowed push does not come back as an alert |
| C8 | Restart, and the plugin down (§D.2) | Not described | **Restart:** events are not replayed. At the first Paseo handle after the plugin starts (a hook, an RPC or the watch pass), the plugin scans `paseo.agents.list()` for the `pendingPermissions` of Workers and Reviewers, and classifies each as if just raised. Opening is idempotent by id. <br>**Plugin down:** requests wait in Paseo's UI (measured), and an agent created meanwhile is flagged by `outdated-agent` (C3) |
| C9 | The field estimate before the modes switch (`loga.3` → `loga.4`) | None: the latency on the isolated daemon was the only check | **The replay runs the classifier over the field's shell evidence** (read-only, numbers only). Per finished request it reports how many calls would be held by class and as unreadable, after the request's grants and the scratch rule, beside `held` figures once there are `h:` decisions (held, allowed, denied, withdrawn, owner wait). <br>If the estimate holds **more than 0.2 unreadable requests per finished request**, the classifier is improved, or a delta raised, before `loga.4` switches the modes. <br>Release holds are the owner's by design (hard-owner, X-4) and have no such bound |
| C10 | Bead text against the code as built | Module names of before the consolidation | `chat-cards.ts` → `client/chat-card-decision.ts` / `chat-card-frame.ts`; A-6 in `shared/eval-metrics/actions.ts` and `scope.ts`; the patterns in `shared/effectful-actions.ts` and `shared/shell.ts`; the Runtime facts in `server/role-instructions.ts` (`role-extras.ts` is gone); the Paseo tool lists in `server/setup-roles.ts`, written by `config-writer.ts`; the answering path is `respondToPermission` on the SDK handle (spike §2); test fakes in `test/helpers/fake-paseo.ts`; `worker.md` 250 of 250 lines; `eval-metrics.test.ts` runs in the `default` project and the replay tests in `eval` |

### 3.2 Confirmed without change

| Decision | Verdict and figure |
|---|---|
| §D.1 pass criteria | **Met for Claude and Codex, as measured.** ADR-019's record stands |
| §D.4 held-request id `h:<agentId>:<requestId>` | **Confirmed.** `DECISION_ID_PATTERN` holds `q:`, `o:`, `f:` and `r:`; `h:` is free. C6 adds its kind |
| §D.4 a live grant covers and is spent | **Confirmed.** A grant is `{ effects, expiresAt, usedAt }` with a 60-minute TTL (`GRANT_TTL_MS`), spent with `useGrant`. The owner's answered `q:` (the Worker's question) or `o:` of the same request covers it. A second request, or one after the TTL, is held again. The Worker keeps asking what REQ-026 (d) says: a grant from its answered question covers the hold, so there is no second ask |
| §D.4 a `delegate` cell allows with `policy:<class>` | **Confirmed.** Only dependency and environment can be `delegate` (`HARD_OWNER_CLASSES`). C6 records it as an answered `h:` |
| §D.4 unreadable → held; `commit` not held; no recommended option | **Confirmed.** C4 says what is unreadable. Commit stays under rule 1 and detection |
| §D.4 a hand-set profile mode wins; Settings → Agents says the boundary is off | **Confirmed,** within C3 |
| §D.2 `respond_to_permission` denied to every role | **Confirmed as built.** It is in the Manager's and the Worker's `disabledTools`, beside `list_pending_permissions` and `set_agent_mode`; the Reviewer and the Orchestrator have no Paseo tools |
| One Inbox item per held request | **Confirmed.** C7 extends it to `danger` |
| X-4: Allow on release or data needs `confirmed: true` | **Confirmed.** `decisions.answer` already refuses without it (`E_DECISION_NOT_CONFIRMED`) |
| Latency budget | **Confirmed.** The classification is synchronous but for the Codex file-change lookup (0–3 ms measured); `loga.3` measures it again with the product (p90 < 1 s) |
| Phase 3 as built | **No conflict.** A held request keeps its Worker's turn running, so compaction, the handoff note and `BM-REPLACED` wait for the idle moment as they do for any running turn. The stall pass does not count a running Worker as stalled, and the held decision is the owner's one signal |
| The Phase 3 exit | **Unchanged:** judged in the combined field period (change-006, `i8fc.6`). This start reads the build as built and the field available now |

### 3.3 Considered and not changed

- **Claude `acceptEdits` for the Worker.** It passes too and saves the requests for in-workspace edits. It was not chosen: in `default` the plugin also sees every edit, and the owner's decision is the least permissive mode. The latency (201 ms p90) does not argue against it.
- **The Orchestrator under the boundary** (spike §9 named it). Not chosen: REQ-141 and §D.2 name Workers and Reviewers. The Orchestrator's effects go through typed commands with an authority, and it has no Paseo tools. It keeps its mode rule, split from the Reviewer's (C2).
- **The owner's words in chat covering a held release.** Rejected: release is hard-owner and needs a decision (§A.7, X-4), and principle 3 forbids prose patterns as the authority.
- **Predictions on held decisions.** None in Phase 4: the ledger learns those classes from Worker questions, and a prediction per held request would wake the Orchestrator on the Worker's critical path.
- **Holding `git fetch` and bare lockfile installs.** Not held: they only read from a configured remote or install what the lockfile already names. They can be revisited with C9's figures.

## 4. Impact

### Affected beads (edits made through `br` on 2026-10-01)

| Bead | Action |
|---|---|
| `bm-autonomy-phase4-loga` (epic) | Path taken recorded (pass for Claude and Codex, detection for the rest) |
| `bm-autonomy-phase4-loga.3` | C4–C10: the request table, the classes and the scratch area, the held-decision additions, `danger`, the restart scan, the field estimate, module names, the answering path, the Codex MCP measurement; no chat card of ours |
| `bm-autonomy-phase4-loga.4` | C1 (the detection docs for the roles the boundary does not cover), C2 (the modes table, the creator's mode, the Orchestrator's own rule, the Codex gate), C3 (the facts line, the label, the Settings line, `boundary-off`), C10 (module names; worker.md at 250 of 250) |
| `bm-autonomy-phase4-loga.5` | Closed as not applicable: the spike report's verdict (ADR-019 Accepted for Claude and Codex); its REQ-142 part moves to `loga.4` (C1) |
| `bm-autonomy-phase4-loga.6` | The live check adds an Allow given in Paseo's own prompt, no `danger` after an Allow, and the scratch rule; the field figures add the held per finished request and the providers on detection |

No bead is added or split.

### Other affected artifacts

- [x] Design Part D rewritten from the spike and this delta, marked Active; header's ADR line; Revision History.
- [x] Plan Phase 4: ADR row, §3, Revision History (path taken).
- [x] docs/README.md: this delta listed.
- [ ] PRD: unchanged here. `loga.4` edits REQ-026 (c), the NFR Permissions and REQ-141/142's status when it changes the modes.
- [ ] Evaluation design §4: the scratch rule of A-6 lands with `loga.3`.
- [ ] ADR: none. ADR-019's decision record already scopes it per provider.

### Risk delta

- **C2 changes the modes of every new Claude and Codex Worker and Reviewer.** Ordinary work then waits for the plugin (about 0.2 s per call), and a stopped plugin leaves requests waiting in Paseo's UI.
- **C5's scratch area** lets a write under the temp roots run without a hold. That is the room worker.md's rule 1 already gives.
- **C6's `via: paseo`** trusts that an allow given in Paseo's UI or CLI is the owner's: no paseo-bm role has `respond_to_permission`.
- **Without these changes:**
  - new Workers would keep running without prompts under an old Manager's facts;
  - the owner would not see a Worker running without the boundary;
  - the scratch deletions would flood the Inbox;
  - A-6 could not reach 0 in the field.

## 5. Out of scope for this delta

PRD targets; ADR-019's decision; the programme's one release; any code.

## 6. Approval

- [x] Approved-by: Claude under the owner's delegation (hieu.nt10), 2026-10-01.

## 7. Revision History

| Date | Author | Change |
|---|---|---|
| 2026-10-01 | Claude (owner's delegation) | Created at the Phase 4 start (bead `bm-autonomy-phase4-loga.2`); applied to the plan, the design and the beads of §4 |
