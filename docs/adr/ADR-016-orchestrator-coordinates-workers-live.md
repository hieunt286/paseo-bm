# ADR-016 — Orchestrator: live watch of running Workers, direct Worker commands with a Manager copy, a rule gate on big decisions, structured commands

| Field | Value |
|---|---|
| Status | **Accepted** (2026-09-29) — owner decisions of the same day |
| Date | 2026-09-29 |
| Owner | hieu.nt10 |
| Amends | [ADR-015](ADR-015-orchestrator-autopilot-per-project.md) decision 4 ("commands go to Managers only") and [ADR-011](ADR-011-manager-coordinates-workers.md) (the Manager is the Worker's only coordinator) for Autopilot projects; ADR-015's other decisions stand |
| Related | [Orchestrator PRD](../product/paseo-bm-orchestrator-prd.md) · [Orchestrator Design](../design/paseo-bm-orchestrator.md) §6B, §9 · [ADR-013](ADR-013-orchestrator-assess-and-nudge.md) (why the plugin itself never interrupts) |
| The owner's decisions | 2026-09-29, after reviewing the Orchestrator's role: (1) watch running Workers, (2) let the Orchestrator correct a Worker directly, (3) a rule gate on big decisions, (4) read-only repo access and per-project notes, (5) a coordinator's dashboard, (6) structured, readable command cards in the chats |

## Context

The Orchestrator only saw work at turn ends: a Worker stuck inside a long turn, waiting on a permission, looping on the same failure, or starting something dangerous stayed "running" and invisible until too late. Every correction went Worker → Manager → Orchestrator → Manager → Worker. The Orchestrator judged "big decisions" by itself, could not check a repository, and its commands arrived in the Managers' chats as long plain text with a limit sentence glued on.

## Decision

1. **Live watch of running Workers (Autopilot projects).** Every 2 minutes the plugin reads the tail of each running Worker's timeline (at most 5 Workers, 300 entries each, no model call) and raises deterministic **Worker signals**: `stuck` (no new timeline entry for 10 minutes), `permission` (a permission waiting 3 minutes), `danger` (a push, publish, deploy, destructive SQL or `rm -rf` outside the workspace), `failing` (the same command failing 3 times in the turn), `heavy` (a Small request creating beads or plan/ADR documents), `outside` (a file written outside the workspace). Each signal wakes the Orchestrator once per Worker turn, with its evidence. The plugin itself still never interrupts anyone.
2. **Direct Worker commands, with a Manager copy.** In an Autopilot project the Orchestrator may command a Worker directly (a correction, or the answer to the Worker's question). The plugin delivers it to the Worker when its turn ends and sends the Worker's Manager a copy at the same time, so there is still one line of command the Manager can see. It may **interrupt** a running Worker only while a `danger` signal of that Worker is open (10 minutes). Never a Reviewer.
3. **A rule gate on big decisions.** Before any Orchestrator command leaves, the plugin matches its text against fixed categories — security/permissions, release (push, deploy, publish, production), data (destructive SQL, migrations, real data), cost, dependencies — ignoring negated mentions ("do not push"). A match turns the command into a **Needs you** decision unless the owner has allowed that category for that project.
4. **Seeing for itself.** A read-only repository tool (`git status`, `diff --stat`, `log`, `show` of one file, inside the workspace only) and per-project notes the Orchestrator keeps; notes survive a replaced Orchestrator, which also lets the plugin start a fresh Orchestrator after a day (when it is idle and the owner has not written to it for 2 hours) so its context stays small.
5. **Structured commands.** Every command the plugin delivers — from the Orchestrator or the owner's tab — is a `BM-COMMAND` block (from, via, to, request, subject, limits, body, why), answers to questions use the existing `BM-ANSWERS` block, and the plugin's chat cards render both; the Manager's and Worker's instructions say a `BM-COMMAND` carries the owner's authority (a Manager's copy is information). Plugin events in the Orchestrator's chat render as compact cards; the Orchestrator answers the owner as Situation / Done / Needs you.
6. **A coordinator's dashboard** on the Orchestrator tab: a summary line, a decision queue with one button per option, one health card per project (status colour, stage, Manager/Worker/Reviewer state, last progress), and the intervention log with **Override** and **Pause Autopilot** on each entry.

## Consequences

- Stuck, looping and dangerous Workers are caught during the turn, at no model cost until a signal fires.
- A Worker can receive commands from two places; the copy to its Manager and the `BM-COMMAND` card keep the Manager's context and the owner's view consistent.
- The gate trades some false positives (a harmless mention of "security") for a hard stop on the owner's reserved decisions; false positives land on the owner, never go out.
- The repository tool runs `git` read-only inside workspaces; nothing writes, fetches or pushes.
- Role files change (Manager, Worker, Orchestrator): product behaviour for every user, covered by this ADR.

## Alternatives considered

- **The plugin interrupts on danger by itself** — rejected (ADR-013 showed automatic interruption on rules costs more than it saves); the Orchestrator decides, the plugin only allows it while the danger is open.
- **Direct Worker commands without a Manager copy** — rejected: the Manager would lose track of its own request.
- **Let the Orchestrator classify big decisions** — rejected by the owner: the gate is a rule.
- **Give the Orchestrator a shell in the workspaces** — rejected: a fixed read-only tool is enough to verify claims and cannot change anything.
