# Change Request — The action boundary per project, off by default

| Field | Value |
|---|---|
| Change ID | `autonomy-change-010` |
| Short name | Boundary per project |
| Original plans | [Phase 4](../../plans/paseo-bm-plan-autonomy-phase4.md) (Active); [change-009](paseo-bm-plan-autonomy-change-009-phase4-start.md) C2, C3, C9; the combined field period of [change-006](paseo-bm-plan-autonomy-change-006-build-then-field.md) (bead `bm-autonomy-phase6-i8fc.6`) |
| Status | Applied — the owner's decision of 2026-10-01; details decided by Claude under the owner's delegation |
| Owner | hieu.nt10 |
| Created | 2026-10-01, after bead `bm-autonomy-phase4-loga.3` closed with change-009 C9's field estimate failing its gate |
| Accepted | 2026-10-01 — **the owner (hieu.nt10) decided: the boundary is turned on per project, off by default.** The details below (§3) are Claude's under the owner's delegation |
| Applied | 2026-10-01 |

## 1. Change summary

**The owner's decision (2026-10-01):** the action boundary is **turned on per project, and is off by default.**

Change-009 C9 asked for a field estimate before `loga.4` switches the modes. `loga.3` measured it and the estimate **fails** the gate (§2). Switching every Claude and Codex Worker would interrupt the owner about ten times per request.

So the boundary becomes something the owner turns on for the projects they choose:
- **Where it is off** (every project, until the owner turns it on), Workers and Reviewers keep today's modes and detection stays as it is.
- **Where it is on**, `loga.4`'s modes apply to Workers and Reviewers created afterwards.
- **The Worker is told** to name its scratch folder literally, which removes most unreadable requests (C9's first way out).
- **The C9 gate no longer blocks building `loga.4`.** It is measured again in the combined field period over the projects with the boundary on, and reported at the Phase 4 exit. The owner then decides whether to recommend turning it on more widely.

## 2. Compelling reason

**C9's field estimate** (bead `loga.3`, read-only replay over the whole field store, numbers only):
- **6.9 unreadable requests per finished request.** The bound is 0.2. Most are writes to a scratch variable set in an earlier call (`$S/…`, `$SCRATCH/…`). The classifier cannot know that such a variable names the scratch area, so the request is held as unreadable, and only the owner can allow it (`security`, with a confirmation).
- **About 3.4 environment holds per finished request** (network, and writes outside the workspace), after the request's grants and the scratch rule.
- **Together, about 10 interruptions per request** if the modes switched for every Worker.

**What was built stays sound.** `loga.3`'s classifier, held decisions, exactly-once delivery, restart scan and A-6 rules passed their tests (`npm run verify` green). The problem is how often the boundary asks, not whether it holds.

**The cost of the remedies is uneven:**
- The scratch-variable holds are an instruction problem: a folder named literally in each command is read as scratch by the classifier as built (`shared/effectful-actions.ts`).
- The environment holds are real effects. The owner can delegate the environment class per project (§B.2, §D.4), but only once the ledger has earned it (§B.4).
- A per-project switch lets the owner try the boundary where it matters without slowing every project.

## 3. What changes — Before / After

### 3.1 Changes

| # | Item | Before | After |
|---|---|---|---|
| C1 | Where the boundary applies (§D.2) | Every new Claude and Codex Worker and Reviewer, once `loga.4` lands | **Only in the projects where the owner turned it on. Off by default** (owner's decision, 2026-10-01). A project the policy says nothing about is off |
| C2 | The switch (§B.2's store; `shared/autonomy.ts`, `server/autonomy-rpc.ts`, `shared/contracts.ts`; Settings → Autonomy) | None | **Stored with the autonomy policy:** `<data>/autonomy/policy.json` gains an optional `boundary: { <workspaceId>: { enabled: true, at } }`. The key is additive and the file keeps `version: 1`, so a Phase 2 or 3 policy file reads as off in every project. An entry is read on its own: a malformed one reads as off and is dropped by the next write, like a challenger entry. The map is kept on every write. `autonomy.reset` does not touch it, since it is not a class cell. The cleanup button, which deletes `autonomy/`, turns it off everywhere. <br>**The RPC:** `autonomy.set-boundary { workspaceId, enabled, confirmed }` → `{ policy }`. Both directions need `confirmed: true` (`E_AUTONOMY_NOT_CONFIRMED`); the errors are otherwise those of `autonomy.set`. Turning it off removes the entry. `autonomy.policy` returns the map. <br>**Settings → Autonomy, in the project's tab:** one row, "Action boundary", **On** / **Off**. Pressing it opens an in-place confirmation that says what changes (below). The group's folded line counts the projects with it on. <br>**Only the owner changes it:** no agent tool writes it, as for every policy key. **Advice cannot propose it** (C3) |
| C3 | Whether advice may prepare the switch (§G.4) | — | **No.** `bm_findings` holds no boundary figures, so advice would propose it without evidence. Whether to recommend turning it on more widely is the Phase 4 exit's question, with the owner's decision (C7). The confirmation that says what changes sits in Settings, beside the switch. A later delta may add a `boundary.set` prepared change once there are field figures to ground it |
| C4 | The confirmation's text (Settings; its wording is `loga.4`'s) | — | **Turning on** says: <br>• Workers and Reviewers **created afterwards** in this project run in the least permissive mode (Claude `default`; Codex `auto` with its creation options). <br>• Each action the boundary holds (release, real data, dependency install, network, outside the workspace, or a request it cannot read) **waits for you**, unless the owner's answer to the Worker's question (a grant, one use, 60 minutes) or a class you delegated covers it. <br>• **Agents that already exist keep their mode.** <br>**Turning off** says: <br>• Workers and Reviewers created afterwards run in today's modes, watched by detection only. <br>• Agents created while it was on keep their mode, and the plugin still answers their requests. <br>A precedent never answers a held request (change-009 C6, as built), so the text does not name it |
| C5 | What "off" means, and the hook (`role-mode.ts`, `role-hook.ts`, `role-instructions.ts`, `action-boundary.ts`) | `loga.4`'s modes table for every Claude and Codex Worker and Reviewer; the handler answers every Worker's and Reviewer's request | **The hook reads the switch at creation:** the project of `cwd` (`workspaceOfFolder`, within the hook's 5 s budget) and its `boundary` entry. <br>• **On:** change-009 C2's table. A creator's other mode is moved to the boundary mode; only a hand-set profile mode wins. <br>• **Off, or the project unknown:** today's rule (`chooseModeId`, `runPostureOf`). A creator's *boundary* mode, passed from Runtime facts written while the switch was on, is moved back to today's pick. No agent is left asking with nobody answering. <br>**Runtime facts** follow the switch at the agent's creation: the Manager is told the Worker mode of its project, and the Worker the Reviewer mode. <br>**Detection** (the Worker watch, `danger` and the other alerts) stays as today in every project; C7 of change-009 already keeps `danger` quiet after an allowed held action. <br>**The permission handler** answers only the requests of Workers and Reviewers that run under the boundary. That is an agent labelled `bm.boundary=on`, or, until that label is written, one whose system prompt carries `Action boundary: on`. The restart scan covers the same agents. <br>So turning the switch off later never strands an agent created while it was on. Every other request is left to Paseo's UI with its `permission-waiting` alert, as before `loga.3` |
| C6 | Status and alert (change-009 C3) | The facts line `Action boundary: on` / `off — <why>`; `bm.boundary`; Settings → Agents per role; `boundary-off` for any live Claude or Codex Worker or Reviewer not labelled `on` | **The facts line** gains the reason `off — the project's boundary is off`. <br>**Settings → Agents** says per role whether the boundary can apply (the provider, a hand-set mode) and points to Settings → Autonomy for the projects. <br>**`boundary-off`** is raised only in a project whose boundary is on, and only for an agent created after it was turned on (its creation time ≥ the entry's `at`). Turning it on therefore raises nothing for agents already running, which the confirmation names. Turning it off clears the project's `boundary-off` alerts |
| C7 | The Worker's instruction (`plugin/roles/worker.md`, 250 of 250 lines) — C9's first way out | Rule 1 allows "one `mktemp -d` scratch directory". The RULES lead-in says "You run without permission prompts, so these five are the only barrier." | **Name the scratch folder literally in every command that uses it.** Two forms: <br>• `S=$(mktemp -d) && … && rm -rf "$S"` in one command; <br>• in a later command, the literal path `mktemp -d` printed (or a literal `/tmp/…` path). <br>Never through a variable set in an earlier call. The file says why: then the plugin can read the command, and the Worker is not stopped for it. <br>**The lead-in** says instead that the Worker's Runtime facts say whether the action boundary is on, that when it is on the plugin holds an action that leaves the workspace until the owner allows it, and that the five rules bind either way. <br>**Line budget:** reworded within the 250-line budget, never grown. The "delete a scratch directory" line follows the same rule. A test classifies each form the file names as scratch |
| C8 | The C9 gate (change-009 C9; §D.2 "Field estimate before the modes switch") | Above 0.2 unreadable per finished request, the classifier is improved or a delta raised **before `loga.4` switches the modes** | **It no longer blocks building `loga.4`:** the switch is off by default, so building the modes changes no project until the owner turns one on. <br>**Measured again in the combined field period** (`i8fc.6`), over the projects with the boundary on: the held decisions per finished request by class and as unreadable (measured, not estimated), with the estimate beside them for the projects with it off. <br>**Reported at the Phase 4 exit** (`loga.6`) with the owner's decision on whether to recommend turning it on more widely. **The 0.2 bound is kept as the recommendation threshold:** above it, no wider recommendation, and the classifier or the instruction is improved first. <br>The environment holds per finished request are reported beside it, with the part a grant or a `delegate` cell covered. Release holds stay the owner's by design and have no bound |
| C9 | The replay (`shared/eval-metrics/actions.ts`, `scripts/eval/replay.ts`) | A-6, `held` and `estimate` for the whole scope | **Split by boundary on / off / unknown per request,** from the `bm.boundary` label of the request's Worker as the store records it (`unknown` when it records none). Built by `loga.4` with the label |
| C10 | The Phase 4 exit (`loga.6`) | The live check on the isolated daemon; field A-6 = 0 on the pass path | **The live check runs with the boundary on** for its project. It also records the isolated-daemon measurements `loga.3` left to it: added latency p90 with the product (< 1 s), the tool names an ordinary request raises (allowed by name or not), and a Paseo and a paseo-bm MCP call on Codex `untrusted`. That last one is change-009 C2's gate: if a call fails without a request, Codex roles stay on today's modes and detection, fixed forward before the exit, and Part D says so. <br>**The field A-6 is split by boundary on and off:** 0 not shown to be authorised is the target for boundary-on requests; boundary-off requests are a detection figure. With no project on in the window, the field half is reported as not measured, and the owner decides. <br>**The C9 figure** is reported with the owner's decision on a wider recommendation (C8) |

### 3.2 Confirmed without change

| Decision | Verdict |
|---|---|
| The modes table (change-009 C2) | **Unchanged** for a project with the boundary on |
| The classifier, the held decision, exactly-once, the restart scan, A-6's rules (`loga.3` as built) | **Unchanged.** Only the set of agents the handler answers narrows (C5) |
| §D.4: a hand-set profile mode wins | **Unchanged,** in both states of the switch |
| `respond_to_permission` denied to every role | **Unchanged** |
| The 0.2 bound | **Kept,** as the threshold for recommending the boundary more widely (C8) |
| The plugin-down check (`loga.4`) | **Unchanged,** run in a project with the boundary on |

### 3.3 Considered and not changed

- **One global switch.** Rejected by the owner's decision: projects differ in how much leaves the workspace.
- **A per-role switch in Settings → Agents.** Not chosen. The owner thinks in projects, the policy is already per project, and the handler, the alert and the replay all key on the project.
- **Advice proposing the switch.** Not in Phase 4 (C3).
- **Teaching `${TMPDIR}bm-<request>/…`.** The classifier reads it as scratch, but where `TMPDIR` is unset the path lands in the workspace. `mktemp -d`'s printed path and `/tmp/…` do not have that problem.
- **Treating a variable from an earlier call as scratch.** Rejected: the classifier sees one command, and a variable it did not see assigned could name any folder. Guessing would let a write outside the workspace pass unseen.
- **Answering the requests of agents created while the switch was off.** Rejected: those agents run in today's modes and raise requests only by exception. They keep Paseo's own prompt, as before `loga.3`.

## 4. Impact

### Affected beads (edits made through `br` on 2026-10-01)

| Bead | Action |
|---|---|
| `bm-autonomy-phase4-loga` (epic) | The owner's decision recorded; success criteria and posture per project |
| `bm-autonomy-phase4-loga.4` | C1–C9: the switch with its RPC, Settings row and confirmation; the hook reads it; off keeps today's modes; the handler's agent set; the facts reason and the alert's rule; the Worker's scratch wording; the replay split; the C9 gate no longer blocks it. The living docs say per project, off by default |
| `bm-autonomy-phase4-loga.6` | C8, C10: the live check with the boundary on and `loga.3`'s isolated measurements, the Codex gate read there; the field A-6 split on and off; the C9 figure and the owner's recommendation decision |

No bead is added, split or closed.

### Other affected artifacts

- [x] Design Part D (§D.2, §D.3, and §D.5, new), with a pointer in §B.2's schema; Revision History.
- [x] Plan Phase 4: §3 and Revision History. Status stays Active.
- [x] docs/README.md: this delta listed.
- [ ] PRD: REQ-141's status line and the user-facing docs say "per project, off by default" when `loga.4` edits them (already in its scope).
- [ ] Evaluation design §4: the on/off split of A-6 lands with `loga.4`.
- [ ] `bm-autonomy-phase6-i8fc.6`: not edited here. At install it asks the owner per project about the challenger (change-007 C3). The same question for the boundary would give C8 its field; it is left to that bead's owner.
- [ ] ADR: none. ADR-019 decided that the boundary works for Claude and Codex, not where it is turned on.

### Risk delta

- **Fewer projects are protected before an action runs:** only those the owner turns on. Every other project keeps today's detection, which fires after the action. That is the state before Phase 4, and the docs say so.
- **The switch is one more setting.** Its confirmation says what changes, and only the owner sets it.
- **An agent created while the switch was on** keeps being answered after it is turned off (C5). An agent created while it was off keeps today's mode after it is turned on (C4, C6).

## 5. Out of scope for this delta

Any code; PRD targets; ADR-019's decision; the programme's one release.

## 6. Approval

- [x] Decision: the owner (hieu.nt10), 2026-10-01 — the boundary per project, off by default.
- [x] Details (§3): Claude under the owner's delegation, 2026-10-01.

## 7. Revision History

| Date | Author | Change |
|---|---|---|
| 2026-10-01 | Claude (owner's decision; details under the owner's delegation) | Created after `loga.3`'s C9 estimate failed its gate; applied to the plan, the design and the beads of §4 |
