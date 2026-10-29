# ADR-037 — Agents are given a bounded context: scoped memory, budgeted briefs, summary reads, a Main compacted by tokens

| Field | Value |
|---|---|
| Status | **Accepted** (2026-10-25) — the owner's four answers to the context review: "by scope", "the code cleans up", "150k tokens", "retire automatically, reversibly". Technical choices by Claude under the owner's delegation |
| Date | 2026-10-25 |
| Owner | hieu.nt10 |
| Supersedes | The missions design's §2.5 bound ("curate the memory first") as the only limit, and §7's "the newest 30 active entries plus every `contract` entry" and "the Main reads the full memory"; the mission runtime design's §3.1 rule that `main.contextTokens` counts only when no window is known |
| Keeps | ADR-029 (project memory per repository, kept by the Mains); ADR-033 (the mission is the record); ADR-035 and ADR-036 |
| Related | **Design:** [delivery line design](../design/paseo-bm-delivery-line.md) §18; [missions design](../design/paseo-bm-missions.md) §2.5, §7; [mission runtime design](../design/paseo-bm-mission-runtime.md) §3.1 · **PRD:** [missions PRD](../product/paseo-bm-missions-prd.md) REQ-216, M-43 · **Evidence:** [context review](../archive/operations/paseo-bm-context-review-20261025.md) |
| Lane | Designed: a stored format (memory entries), agent-tool outputs (`bm_memory`, `bm_mission`), agent-role behaviour (Main, Worker), the Main's compaction rule |

## Routing Decision

- **Variant preset:** brownfield.
- **Triggered risks:**
  - a stored format, additively (memory `scope`, `subject`);
  - the outputs of two agent tools;
  - role behaviour;
  - a Coordination rule.
- **Required artifacts and gates:**
  - this ADR;
  - the delivery line design with §18 added, and the missions and mission runtime designs amended in place (`design-ready`);
  - the missions PRD amended;
  - manual beads under one epic (independent outcomes, no plan needed);
  - `feature-done`.
- **Execution path:** manual beads, implemented in two waves, one verify per wave.
- **Exceptions:** none.
- **Decided:** 2026-10-25. hieu.nt10 decided the four answers; Claude made the technical choices.
- **Supersedes:** none.

## Context

The [context review](../archive/operations/paseo-bm-context-review-20261025.md) measured what agents are given:
- **The memory is a log.** Each of the two product repositories holds about 210 active entries, about 100,000 characters. 73 % come from closed missions, and one entry per repository was ever removed. The Main adds after every report, and removing has no trigger.
- **The brief carries it wholesale.** A Worker's first message was 36,672 characters, 94 % of it memory: the newest 30 entries plus every contract, from five missions.
- **The Main reads everything.** 48 % of a Main's timeline is the output of `bm_memory` and `bm_mission`; one `bm_memory` read returned 122,000 characters.
- **The Main is compacted late.** It is compacted at 60 % of its window, which is 285,000 tokens on Codex. A Main grew to 260,000 tokens over 137 turns, most of them a single delivery.
- **Deliveries repeat.** One update held the same status four times.

Each limit relied on an agent remembering to curate, or applied only when a figure was unknown.

## Decision

1. **Memory has a scope and a life, kept by code.**
   - **Scope.** An entry is `repo` (a convention, a contract, a lasting fact: for every later mission) or `mission` (what one mission settled). By default a `fact` or `decision` added by a mission's agent is `mission`, everything else `repo`; the adder may say `scope: "repo"`. An entry stored before has no scope and reads by the same default.
   - **Live and retired.** An active entry is **live** unless it is retired, computed at every read, never stored:
     - a `mission` entry of a closed mission;
     - an entry whose `subject` a newer live entry of the repo also names;
     - a `mission` `fact` older than 14 days.
   - **Reversible.** A retired entry stays in the file and in `bm_memory read` with `retired: true`. Re-adding it as `repo` makes it live again. Only an entry retired for 30 days becomes `removed` at the next write, and the newest 300 removed entries are kept.
   - **The bound** of 300 counts live entries only.
2. **A brief has a budget.**
   - A Worker's brief gives at most 6,000 characters of memory: the live entries of its own mission first, then `repo` entries, each ranked by the words it shares with the request and the plan step, then by recency; each entry cut at 400 characters.
   - The rest is one line: "N more entries: `bm_memory read` with a query".
   - The same holds for a continuation's brief.
3. **Reads return a summary first.**
   - `bm_memory read` without a query or an id returns an index of the live entries: id, kind, scope, date, the first 160 characters; newest first, at most 80. A query returns the matching entries in full, at most 20; an id returns that entry.
   - `bm_mission` returns open requests in full and settled ones as one line each (the newest 20), and the newest 20 journal lines. `requestId` returns one request in full, `journal` up to 50 lines.
4. **A Main is compacted by its tokens.** A Main crosses at `main.contextShare` of its window **or** `main.contextTokens` (150,000), whichever comes first; its hard figure likewise. Settings → Coordination shows the token figure.
5. **An update says each thing once.** In one `BM-UPDATES`, an item whose content repeats an earlier item's, apart from its record and link ids, is dropped; of a peer request's status replies, only the newest is kept.
6. **The roles say what memory is for.** The Main adds to memory only what a later Worker in that repository must know beyond this mission; what the mission settled is its journal and plan. A Worker adds a lasting fact, convention or contract, with a `subject` when it replaces one.

## Consequences

- A Worker's first message carries a few thousand characters of memory, chosen for its request, instead of 35,000 of other missions' history.
- A Main reads a summary, asks for detail by id, and is compacted at 150,000 tokens. Every delivery it takes reads at most that much again.
- Nothing is deleted on install: the closed missions' entries leave the briefs and reads at once and stay in the file, retrievable.
- **Stored data is additive.** Memory entries gain `scope` and `subject`; an older build ignores both and reads every active entry as before.
- **Tool outputs change shape** for `bm_memory read` and `bm_mission` (new optional inputs, a summary by default). Role files change, so running agents are outdated and replaced once.
- **Retired:** "every `contract` entry" in a brief; the Main's "remove what no longer holds" as the only cleanup; `main.contextTokens` applying only without a window.

## Alternatives considered

- **Memory shared by every mission, limited only by the budget.** Simpler, but closed missions' history keeps competing for the budget. Not chosen by the owner.
- **The Main curates on a schedule.** It costs tokens and depends on the model. Not chosen: the code retires by rule, reversibly.
- **Keep 60 % of the window.** It leaves Codex Mains at up to 285,000 tokens. Not chosen.
- **Ask the owner before retiring the old entries.** Retirement is computed and reversible, so a card would ask about something that loses nothing. Not chosen.
