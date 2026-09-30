# Orchestrator acceptance run — isolated daemon, 2026-09-28

| Field | Value |
|---|---|
| Date | 2026-09-28, 08:23–08:32 UTC |
| Run by | Claude (sub-agent), bead `bm-orchestrator-o1-8ws1.8.3` |
| Paseo | CLI and daemon 0.9.2 |
| Under test | the working tree of `main` (uncommitted Orchestrator work on top of `d7e68f1`), installed from the folder `plugin/` after `npm run build`; package version still `0.4.1` (no bump in this phase) |
| Starting point | `paseo-bm-plugin@0.4.1` from the real npm registry |
| Providers / models | every role on `claude · claude-opus-5-5` (the defaults the plugin created); Manager and Workers in `bypassPermissions`, Orchestrator in `auto` |
| Kit | `scripts/manual-test/README.md` §0–1 and §5 (5.1–5.5), first execution |
| Verdict | **PASS** on all five scenarios. One kit expectation was wrong and is fixed (§3). Two product findings for new work, the rest are observations (§4) |

## 1. Setup

The owner's machine was not touched: the real daemon (PID 1274, `127.0.0.1:6767`, `~/.paseo`) ran throughout; `~/.paseo/config.json` kept its mtime (10:43:01 local) and `~/.paseo-bm` got no new file.

- **Isolated daemon:** `scripts/manual-test/start-daemon.sh "$HOME/bm-manual-orch"` → `127.0.0.1:6899`, `PASEO_HOME=$WORK/paseo-home`, `PASEO_BM_HOME=$WORK/bm-home` (checked with `env` and `paseo daemon status --json` before the first agent ran: `home` = the work dir, `listen` = 6899).
- Every shell step ran as `bash -c 'source "$WORK/env.sh"; …'`.
- Provider sign-in came from the real `HOME` (Claude Code), read-only.
- Section 0: `npm run build` ran once (green). `git fetch` / `git switch` were skipped on purpose: the run tests the uncommitted working tree of `main`.
- Messages were sent like the app does (`send.mjs`, with `messageId`). No agent asked the user a question, so no answer had to be given; no permission prompt appeared.

## 2. Results by scenario

| # | Scenario | Result |
|---|---|---|
| 5.1 | 0.4.1 set up, then the branch's plugin: the fourth role appears, the three stay as they were | **PASS** |
| 5.2 | A Small request that creates a bead raises `process.small-heavy` (switch off) | **PASS** |
| 5.3 | Switch on: the running Worker gets exactly one `BM-NUDGE` | **PASS** (kit expectation `fromApp: false` corrected to `true`, §3) |
| 5.4 | Assess a request; add a suggestion to a role's instructions | **PASS** (the assessment had no suggestion, so the kit's example text was applied) |
| 5.5 | Remove the settings and the data | **PASS** |

### 5.1 The fourth role after replacing 0.4.1

```
paseo plugin add npm:paseo-bm-plugin@0.4.1 --json
  → "status": "running", installation.identity { kind: "npm", packageName: "paseo-bm-plugin" }, currentRevision "0.4.1"
rpc setup.ensure-roles        → created ["manager","worker","reviewer"], claude · claude-opus-5-5, skipped null
rpc roles.settings | json roles   → three roles
bm-config.mjs > config-0.4.1.json

paseo plugin remove paseo-bm --json   → status "disabled"
paseo plugin add "$PWD/plugin" --json → status "running", identity.kind "directory"
paseo plugin logs paseo-bm            → Loading plugin → Plugin ready
rpc setup.ensure-roles        → created ["orchestrator"], skipped null
rpc setup.ensure-roles        → created [], skipped null
rpc roles.settings | json roles   → manager, worker, reviewer, orchestrator; the fourth: providerId "bm-orchestrator", label "Beads Orchestrator", claude · claude-opus-5-5
diff config-0.4.1.json config-branch.json
```

The `diff` printed only `>` lines: one `bm-orchestrator` profile (`id`, `model`, `name`, `notes`: "paseo-bm Orchestrator — read-only assessment of one request, started only when you press Assess. …", `provider`) and one `bm-orchestrator` provider (`extends: "claude"`, `label: "Beads Orchestrator"`). No line of `bm-manager`, `bm-worker`, `bm-reviewer` or `injectIntoAgents` changed. `ui/setup-state.json` kept `rolesCreated.roles` = the three and gained `orchestratorCreatedAt`. Plugin log: `[paseo-bm] created roles bm-orchestrator on claude · claude-opus-5-5`.

Then `setup.grant-agent-tools {"confirmed":true}` → `injectIntoAgents: true, changed: true`; `new-workspace.sh demo` → `wks_cf2671d2a8c0f13f`; `br init --prefix demo`; `manager.ensure` → `created: true`, no notice.

### 5.2 `process.small-heavy` with the switch off

`orchestrator.settings` → `nudge.enabled: false`, rules `process.small-heavy`, `manager.language-mismatch`. After the request ("…This is a Small request, but create one bead for it with br create anyway…"):

- The Manager created one Worker (`bm-worker/claude-opus-5-5`, mode `bypassPermissions`, `req-20260928T082420Z`). Worker reports: `received` then `finished`, `tier: Small (changed: no)`, `beadsCreated: demo-px5`, `beadsClosed: demo-px5`; `br list --all` → `✓ demo-px5 … Add one-line comment above add() in math.js`. `math.js` got `// Returns the sum of a and b.`
- `orchestrator.flags` → one flag: `rule "process.small-heavy"`, `severity "warning"`, `state "raised"`, `observed "The Worker sized this request Small but created beads."`, evidence `kind "report"`, excerpt `BM-REPORT phase: finished; beadsCreated: demo-px5`, `nudge { target: "worker" }`; `linking "exact"`; **`nudges: []`**.
- `orchestrator.flag-counts` → `{ traceId: "req:req-20260928T082420Z", warnings: 1, infos: 0 }`.
- `orchestrator.overview {"sinceDays":14}` → the request with `tier "Small"`, `state "completed"`, `warnings 1`, `nudges 0`; `topFlags [{ rule: "process.small-heavy", count: 1 }]`; `byTier` Small: 1 request, `avgDurationMs 47284`, `avgCostUsd null`.
- `prompts.mjs "$MGR" BM-NUDGE` → `0 message(s)`.

### 5.3 One `BM-NUDGE` to the running Worker

```
rpc orchestrator.save-settings '{"nudge":{"enabled":true,…}}'
  → ERROR E_NUDGE_NOT_CONFIRMED: turning on nudges lets paseo-bm send messages into agents' chats; confirm it before saving
rpc orchestrator.settings         → enabled: false (unchanged)
rpc orchestrator.save-settings '{…,"confirmed":true}' → enabled: true, both rules
rpc orchestrator.settings         → enabled: true, both rules
```

Request sent at 08:25:46Z ("…Send your received report first; then create one bead for it with br create, then run sleep 120 before you edit the file…"). A new Worker `a9e98630…` (`req-20260928T082549Z`) sent `received`, ran `br create` (bead `demo-plz`) and `br update demo-plz --status in_progress && sleep 120`. Timeline:

| Time (UTC) | Event |
|---|---|
| 08:26:12 | `br create …` recorded as evidence (the flag's evidence) |
| 08:26:37.822 | `BM-NUDGE process.small-heavy` lands in the Worker's chat during the `sleep 120`; the store records the nudge at 08:26:37.845, `outcome "interrupted"` |
| 08:26:38 | the Worker's first turn ends (replaced) |
| 08:26:37–08:26:45 | new turn: the Worker checks state (`br show demo-plz`, `head -1 math.js`: "The bead is claimed and the file is unchanged. The user asked for this bead, so I'm keeping it."), restarts `sleep 120` in the background and ends its turn |
| 08:28:44–08:29:03 | autonomous turn when the background sleep ends: adds `// Demo file.`, closes `demo-plz`, sends `finished` |

- `prompts.mjs "$WORKER" BM-NUDGE` → `1 message(s)`, text exactly:
  ```
  BM-NUDGE process.small-heavy
  Observed: The Worker sized this request Small but created beads.
  Suggested: Keep this Small request free of beads, plans and ADRs; if it really needs them, raise the tier in your next report and say why.
  Your previous step was interrupted by this notice: check the state of what you were doing (a command may have been cut short), then continue the request.
  This is a hint from the paseo-bm plugin, not a user message. The user's instructions win over it. Do not reply to this message; apply it from your next step.
  ```
  with `fromApp: true` (see §3). Run again after the Worker finished: still `1 message(s)`.
- `prompts.mjs "$MGR" BM-NUDGE` → `0 message(s)`.
- The Worker did not reply to the nudge. It kept the bead because the user asked for it, and said so in `decided`: "Kept bead demo-plz despite the Small tier (plugin nudge said no beads) — The user explicitly asked for one bead, user instructions win over the nudge". The Manager relayed that choice to the user.
- `orchestrator.flags` → `process.small-heavy` raised (evidence `kind "evidence"`, the `br create …` command), `linking "exact"`, `nudges: [{ rule: "process.small-heavy", at: "2026-09-28T08:26:37.845Z", target: "worker", outcome: "interrupted" }]`.
- Switch turned off again → `enabled: false`.

### 5.4 Assessment and one applied suggestion

```
rpc orchestrator.assess-preview → { provider: "claude", model: "claude-opus-5-5", chars: 6904, approxTokens: 1726, truncated: false }
rpc orchestrator.assess (no confirmed) → input validation error: path ["confirmed"], "Invalid input: expected true"
agents.mjs → no bm-orchestrator agent
rpc orchestrator.assess {…,"confirmed":true} → { assessmentId: "a639680d-…", agentId: "272dbf27-…" }
```

`approxTokens` = ceil(6904 / 4) = 1726. `agents.mjs` then showed exactly one new agent, "Beads Orchestrator — assessment", `bm-orchestrator`, `claude-opus-5-5`, mode `auto`, labels `bm.role: orchestrator`, `bm.requestId`, `bm.assessmentId`, `bm.version`. It made a single tool call (`mcp__paseo-bm__bm_assessment`), nothing else, and stayed idle afterwards; the demo repo's `git status` was unchanged by it.

`orchestrator.assessments` → one entry, `status "done"`, `provider "claude"`, `model "claude-opus-5-5"` (same as the preview), `linkedByTurn: false`, usage 4 input / 28,866 cached / 2,208 output tokens. Rubric (six entries): sizing 5, process-weight 5, coordination 5, user-communication 4, report-quality 5, review-quality `null` ("No review was held, and a Small request without a user ask needs none"). Findings (all `info`):

1. "The process.small-heavy flag is a false positive here. The user asked for exactly one bead…"
2. "The trace includes a Manager reply from before this request that belongs to the previous request (bead demo-px5, a different comment). That points to a gap in how the plugin links replies to requests…" — the same defect as finding P1 below.
3. "The implement workflow step is recorded as unknown, even though the finished report shows the edit was made and checked."

`suggestions: []`, so the kit's example text was applied (`ROLE=worker`, `TEXT='Keep a Small request free of beads unless the user asks for one.'`):

```
rpc roles.instructions {"role":"worker"} → hash e3b0c442…b855 (the SHA-256 of an empty extra)
rpc orchestrator.apply-suggestion (no confirmed) → input validation error, path ["confirmed"]
rpc orchestrator.apply-suggestion {…,"confirmed":true}
  → extra "Keep a Small request free of beads unless the user asks for one.", chars 64, maxChars 8000, hash b5b9f739…a513,
    full = the worker role text + "## Additional instructions from the user" + the line
rpc orchestrator.apply-suggestion (old hash again) → E_ROLE_EXTRA_CHANGED: the worker's Additional instructions changed since they were shown; reload them and try again
rpc roles.instructions | json extra → the line, once
```

### 5.5 Remove the settings and the data

```
rpc setup.cleanup {"confirmed":true,"deleteData":true}
  → removedProviders / removedProfiles: bm-manager, bm-worker, bm-reviewer, bm-orchestrator
    agentTools "restored"
    data.deleted ["traces","role-extras.json","orchestrator","ui/agent-tools.json"]
    data.kept ["ui/setup-state.json (it records that you removed paseo-bm's settings)"]
bm-config.mjs → { injectIntoAgents: false, profiles: [], providers: {} }
ls -A $PASEO_BM_HOME → ui   (ui/ holds setup-state.json only; before: orchestrator, role-extras.json, traces, ui)
paseo plugin reload paseo-bm --json → status "running"
rpc setup.ensure-roles → created [], skipped "cleaned-up"
paseo plugin remove paseo-bm --json → status "disabled"
```

The four agents (Manager, two Workers, Orchestrator) stayed, idle; paseo-bm archived none. The daemon was then stopped with `stop-daemon.sh` (its listener on 6899 was gone on the next check) and the work dir deleted.

## 3. Kit fixes made in this run

- **`fromApp` of a `BM-NUDGE` is `true`, not `false`.** The plugin sends a nudge with `agents.ref(id).send(text)` (design §6.2), the same path the app uses, so the timeline item carries `clientMessageId` — a verified Paseo fact in AGENTS.md. paseo-bm tells it from the user's words by its `BM-` prefix (`isPluginNotice`); `traces.list` for the nudged request still counts `userMessageCount: 1`. Fixed: the 5.3 expected result in `scripts/manual-test/README.md` and the header comment of `scripts/manual-test/prompts.mjs` (which said a plugin notice has `fromApp: false`). No script logic changed.

No other kit command was wrong: every command of §5 ran as written.

## 4. Findings

### Product (new work in its own lane; not fixed here)

- **P1 — A Manager turn that belongs to the previous request is folded into the next one.** `plugin/server/traces.ts` `openBuckets`, pass 2: "a Manager turn that names no request belongs to the request the SAME Manager names NEXT." Here the Manager's turn `foreground-turn-4` (08:25:01.782–08:25:05.548Z, `requestId: null`) started the moment Worker 1 ended its turn and wrote the user-facing summary of `req-20260928T082420Z` ("bead `demo-px5` is closed…"). It was attached to `req-20260928T082549Z`, which the user typed only at 08:25:46.243Z. Evidence: `traces.list` returns that request as two rows — `turn {index:1,total:2}` with `requestedAt 2026-09-28T08:25:05.548Z`, `excerpt null`, `messageCount 1`, `userMessageCount 0`, Manager usage 2 / 31,051 / 238 tokens — then `turn {index:2,total:2}` with the real request. Effects: the Dashboard shows a phantom follow-up row that predates the request, its tokens are charged to the wrong request, the assessment prompt quotes the previous request's reply (the Orchestrator itself reported this as its finding 2), and `traces.list … limit:1` → `traces.0` is that phantom segment (the kit still works, because `traceId` and `workerIds` belong to the request). A turn with no inbound user message that follows a `finished` report more likely closes the previous request than opens the next. **Fixed after the run (same day):** `openBuckets` pass 2 now folds a Manager turn with no inbound message into the request that Manager named before it (falling forward only when there is none); test `plugin-traces-reconstruct` "keeps a turn with no inbound message (woken by its Worker) on the request already open, not the next" (fails without the fix); dashboard design §6.1 step 3.
- **P2 — `process.small-heavy` raises and nudges when the user explicitly asked for the bead.** Both 5.2 and 5.3 asked for "one bead … with br create", yet the rule (`plugin/shared/orchestrator-rules.ts`) raised a warning and, in 5.3, sent the Worker "Keep this Small request free of beads…", which contradicts the user's instruction. The Worker handled it correctly (the hint line says the user wins), and the Orchestrator rated it a false positive. Whether the rule should look at an explicit request for beads (or the Worker's `decided` line) is a design decision; the kit relies on this trigger today, so a change to the rule needs a new trigger for 5.2/5.3. **Open for the owner** (not changed).

### Observations

- **O1 — Workflow step `implement: unknown` for a Small request.** The assessment input listed "Feature-workflow steps: 'implement: unknown (unknown)'" although the `finished` report carries `filesChanged: math.js` and passing checks (Orchestrator finding 3). Minor; the step detection does not use a Small request's `finished` report as evidence of implementation.
- **O2 — The Manager mentioned the claude.ai Canva connector to the user** in its first reply of 5.2 ("The claude.ai Canva connector needs authorizing…"), although its instructions say tool, connector and system notices never reach the user. Already seen in the 0.4.0 run (`paseo-bm-install-run-20260926.md` §5); comes from the real `HOME`'s Claude Code connectors.
- **O3 — No cost figure.** Every usage has `costBasis "unavailable"` (`avgCostUsd null`): `claude-opus-5-5` is not in the bundled price table (`plugin/shared/prices.ts`), by design. Tokens only, below.
- **O4 — Background `sleep`.** After the nudge the Worker restarted the full `sleep 120` in the background and ended its turn; the collector recorded the wake-up as `autonomous-turn-3`, and the one-nudge-per-rule-and-request claim held across it.
- **O5 — Upstream log noise.** The daemon log again has `Bad Request: Unsupported protocol version: 2026-07-28` from Paseo's own MCP endpoint (not paseo-bm's); agents used their tools normally.

## 5. Tokens

Input / cached input / output, `claude-opus-5-5`, from `traces.list` and `orchestrator.assessments`:

| Scope | Input | Cached | Output |
|---|---|---|---|
| 5.2 request (Manager + Worker) | 30 | 440,835 | 3,849 |
| 5.3 request, turn 2 (Manager + Worker) | 32 | 529,825 | 3,233 |
| 5.3 phantom turn 1 (P1; belongs to 5.2) | 2 | 31,051 | 238 |
| 5.4 assessment (Orchestrator) | 4 | 28,866 | 2,208 |
