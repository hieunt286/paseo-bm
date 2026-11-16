# ADR-043 — A repository outlives its root workspace

| Field | Value |
|---|---|
| Status | Accepted |
| Date | 2026-11-06 |
| Owner | hieu.nt10 |
| Amends | [ADR-035](ADR-035-a-delivery-line.md) decision 2: a repo key is still a root workspace's id, and a live root may now answer for it |
| Sources | Owner's 2026-11-06 request; [delivery line design](../design/paseo-bm-delivery-line.md) §3.1, §3.3 |
| Tracking | The bead labelled `feature:repo-identity` holds the Routing Decision and acceptance proof |

## Context

The repo key is the repo's root workspace id. When that workspace is archived, the id stays in the
charter, the placements, the owner's policy and the project memory, but Paseo no longer lists it.
Opening the same folder again makes a workspace with a new id, which the plugin takes for another
repository.

Mission AIX met this on 2026-10-29: `bm_create_worker` was refused at least 17 times for the backend.
By the new id, the mission's own branch read as someone else's; by the old id or a live lane, the
project read as archived. The owner made a Worker by hand, which has no request, lane, review or peer
link, and the Main carried 40 messages between the agents itself. The refusal told the owner to rename
or delete branches that hold the mission's work.

## Decision

1. **The repo key stays.** Everything keyed by it (policy, memory, precedents, decisions, placements,
   the charter) is left as stored. Moving it would lose or rewrite the owner's grants and memory.
2. **An alias says which live workspaces are that repo.** `Mission.repoAliases` maps a workspace id
   to the repo key, and the index keeps those in their own `repoAliases` map. `repoKeyOf`, and so
   policy, memory, the charter and peer links, reads through it. Stored links keep the key; Paseo is
   addressed at the repo's live root (`liveRootOf`), and `bm_peers` lists one project per repo by it.
   An alias reads exactly as its repo in the effective policy, and what its id held of its own is not
   applied, so a reopened workspace is never allowed more than its repo. A root is no placement,
   which is why aliases stay out of the `placements` map.
3. **An alias needs proof.** It is stored only for a charter repo whose root is archived or unlisted,
   for a live root workspace that is no worktree or directory workspace, and only when:
   - its folder and Paseo project are exactly those a placement of the repo recorded at creation
     (`Placement.requestBody`); and
   - one of the mission's own branches of the repo exists in that folder's git.

   A branch name alone proves nothing, and a placement with no record proves nothing. Workspaces of
   one folder are aliased together; two recorded folders with the proof are ambiguous, so none is.
4. **`bm_create_worker` adopts it.** Before it reads the mission's repo, it stores what it can prove
   and reads the live root in place of the archived key, so the new id, the old id and a lane all
   reach the mission's branch.
5. **A refusal says what can be done.** A repo with no provable root says to open the repo's folder in
   Paseo. A branch the mission owns is never reported as another's, and no refusal suggests deleting
   a mission branch.
6. **The Main does not route around a refusal.** A refused `bm_create_worker` goes to the owner in one
   line. An agent outside the tools has no lane, link or review, so it is the owner's call.

## Consequences and proof

A mission survives the loss of its root workspace without a migration. The alias is additive: an
older reader ignores the separate map and the field, and the mission goes back to refusing.

The limits, each one a refusal or the old behaviour, never a wrong repository:

- A request that ran in the archived root itself is not continued in place: its continuation says to
  give the work a new Worker. Its successor stays where it was (`successorPlacementOf`).
- A folder that moved cannot be proved; the owner is told so.
- Readers of the root's folder outside `bm_create_worker`, such as the line watch, still find nothing
  for an archived key, and the charter keeps both ids until the owner removes one.

Tests on a real temporary Git repository prove the adoption, each refusal of the proof (an unrelated
repository with the same branch name among them), and that stored placements, charter, policy and
memory stay as they were. Peer tests prove the listing and the addressing, and an index test proves
that an alias never reaches the `placements` map. Staffing a real repository is proved
on the daemon after install, which is the owner's step.
