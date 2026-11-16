# ADR-047 — A repo's alias reaches later missions, and a peer answer takes no slot

| Field | Value |
|---|---|
| Status | Accepted |
| Date | 2026-11-11 |
| Owner | hieu.nt10 |
| Amends | [ADR-043](ADR-043-a-repository-outlives-its-root-workspace.md), for a mission that names the live workspace; [ADR-045](ADR-045-a-mission-runs-as-a-supervised-line-of-approved-steps.md) decision 1, for a peer ask of the running request |
| Sources | Owner's 2026-11-11 report from mission AIX ("plugin lại ko tạo đc worker be") and the request to fix it at the root |
| Tracking | None: a Direct field fix, proved by the tests below |

## Context

Mission AIX's Main could not create a backend Worker. The closed mission AIX Enhance had proved that
the live workspace `wks_12c8…` is the repo whose key is the archived `wks_93a0…`, and stored the
alias. The alias is machine-wide by design, so `repoKeyOf` read the live id as the old key. AIX's
charter named only the live id, so every request for the repo was refused as outside the mission.

The mission line would have stopped the same Worker a second way. The frontend request held the one
sequential slot while it waited for the backend's answers. A Worker created for that open ask was
refused, or held until the frontend finished, which it could not do without the answers.

## Decision

1. **A charter repo is read by its key.** A workspace is in a mission's charter when its repo key is
   the key of a charter repo, and the charter counts its repos by key, so a live id and its key are
   one repo. With the mission worktrees on, when `bm_create_worker` finds a live charter workspace
   that is an alias of another key, it adds that key to the charter, so every reader of the charter
   sees the repo as the earlier mission did. The live workspace then answers under the key, and the
   placement, the policy and the memory stay keyed as ADR-043 says. Removing the repo removes every
   id the charter names it by.
2. **A peer answer runs beside the step that asked.** A Worker created for an open peer link of the
   mission, asked by a running request's continuation chain, takes no slot. It is created at once,
   without the owner's word, marked parallel on the roster and, with the mission worktrees on, given a
   lane of its own, as a parallel lane is, so lane 1 stays the line's. It neither holds the slot nor
   waits for it. Any other new work is still held or refused as ADR-045 decision 1 says.

## Consequences and proof

- The charter grows by the old key once; the mission page and the governor list the repo under both
  ids, as AIX Enhance did.
- The answering request does not block the line: once the asking step passes its gate, the next step
  may start while the answer is still being written.
- Tests prove that a later mission on the live workspace is staffed under the key, with or without
  `project`, and its charter gains it; that a removal names both ids; and that the running request's
  own ask gets its Worker at once, in lane 2, while an ask of another request still gets the slot
  refusal. Each fails without its change.
