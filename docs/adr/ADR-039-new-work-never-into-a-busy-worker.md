# ADR-039 — New work never goes into a busy Worker; outdated Mains are handed over when idle

| Field | Value |
|---|---|
| Status | **Accepted** (2026-10-25) — the owner's three answers after a field case: "enforce it in the tool", "steer only to correct or stop the current work", "replace the old Main when it is idle" |
| Date | 2026-10-25 |
| Owner | hieu.nt10 |
| Supersedes | ADR-038 decision 3's triage as a role rule only (now enforced by `bm_tell_worker`); ADR-038 decision 4's "a tell that carries the owner's words is steered" (now only words about the Worker's own work); for Mains, the autonomy design's "an outdated agent is offered its replacement" (a Main is now handed over by itself when idle) |
| Keeps | ADR-038's lanes, held queue and steer guards; ADR-005 (nothing archived); Workers and Reviewers on older instructions end with their requests |
| Related | **Design:** [delivery line design](../design/paseo-bm-delivery-line.md) §19.12 · **PRD:** [missions PRD](../product/paseo-bm-missions-prd.md) REQ-217 (c), (d), (g) |
| Lane | Designed: an agent tool's contract (`bm_tell_worker`), role behaviour (Main), agent replacement |

## Context

At 06:19 on 2026-10-25, ten minutes after ADR-038 was installed, the owner reported a new bug to mission AIX's Main ("CLIENT_CONTRACT at /admin/ops/catalog"). The Main sent it with `bm_tell_worker` and `now: true` to both of its running Workers:
- **Frontend.** The Worker was mid-turn, so the bug was steered in. It dropped the authoring design it was writing to chase the bug.
- **Backend.** The Worker was idle at that moment, so the bug was sent to it at once.

No new Worker was created. The owner: "I need the AI to split the work so it goes fast."

Three causes:
1. **The Main ran the older `manager.md`.** It had been created on 10-24, and Paseo fixes an agent's instructions at creation. Compaction kept the old text, so the Main never saw the triage rule or `lane: "new"`.
2. **The new rule was too loose.** "The owner's words with `now: true` reach it inside its turn" invited steering any owner message, a new bug included.
3. **Triage lived only in the role.** `bm_tell_worker` delivered anything to a busy Worker.

## Decision

1. **`bm_tell_worker` requires `about`** while the request is at work:
   - **`"current"`**: these words correct, stop or answer this request's own work;
   - **`"new"`**: anything else (a new ask, a bug elsewhere, another feature). It is refused toward its own Worker: `bm_create_worker` with `lane: "new"`, or `after` the request.

   A missing `about` is refused with one line saying how to choose. A finished request still goes on as its continuation.
2. **Steer only with `about: "current"` and `now: true`**: the owner's own words that correct or stop this work. Every other tell waits for the turn's end, as before.
3. **An outdated Main is handed over when idle.**
   - **The check.** Each minute, every open mission's Main that is live and idle, not replaced, and carries another `bm.instructions` hash than this build's is checked.
   - **The handover.** Such a Main is handed over through the code handoff path (`handOverMain`: the mission state brief, then `replaceMain`), with a notice. The successor says in one line that it took over after an update.
   - **Workers are not touched.**

## Consequences

- A Main cannot pull a busy Worker off its work with new work, whatever its instructions: an outdated Main learns the rule from the refusal.
- Owner corrections still reach a running Worker within its turn.
- **After every update that changes `manager.md`,** each mission gets a new Main at its first idle minute. The old Main's tab stays (renamed as replaced); its chat keeps the conversation.
- **The tool's contract changes:** `about` becomes required for a live request. Older role files never set it, so they meet one refusal before they comply.

## Alternatives considered

- **Classify in role text only.** Cheaper, but it failed in the field: an outdated Main does not read it, and a current one may still misjudge.
- **Turn steering off.** No mid-turn interruption at all, but an owner's correction would again wait for a long turn's end.
- **Keep the owner's Replace button for Mains.** Nothing changes behind the owner's back, but the field case shows a Main on old rules keeps working against the owner's new decisions until someone notices.
