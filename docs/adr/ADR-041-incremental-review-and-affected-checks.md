# ADR-041 — Review completed work once and validate the affected changes

| Field | Value |
|---|---|
| Status | Accepted |
| Date | 2026-11-05 |
| Owner | hieu.nt10 |
| Amends | [ADR-036](ADR-036-no-agent-waits-on-machines.md) decision 2: review baselines and the full-suite finish requirement |
| Sources | Owner's 2026-11-05 request; [base PRD](../product/paseo-bm-prd.md) REQ-037; [delivery line design](../design/paseo-bm-delivery-line.md) §5, §17.2 |
| Tracking | `bm-eb46` holds the Routing Decision and acceptance proof |

## Context

Fix reviews already receive a snapshot diff, but a new milestone can repeat the original request's
scope. Workers are also instructed to run the full suite before finishing. Both repeat work that
the owner asked to avoid.

## Decision

1. The first implementation review covers the request's implemented scope. Subsequent implementation
   batches cover changes since the last implementation review with a verdict, including its open
   blocking findings. Plan/document review does not count as implementation coverage.
2. A fix review starts at the snapshot of the last call with a verdict, not an intervening attempt
   without one. A failed or missing review never establishes coverage. If no review has a verdict,
   retry the original review. Without usable snapshots, review only the changed paths/hunks named
   by the Worker and the findings; report gaps instead of falling back to the whole request diff.
3. Workers and Reviewers run the smallest checks covering the edited behaviour and its affected
   consumers. Reuse passing evidence while the relevant code, dependencies and configuration are
   unchanged. A Reviewer independently reruns a check only for missing, stale, failed or suspect
   evidence, or to investigate a concrete finding. Finishing, re-reviewing or merging alone never
   triggers a full suite. A broader check needs an explicit owner request or a concrete affected
   behaviour that narrower checks cannot prove; record that reason.
4. Keep fresh Reviewers, verdict rules, review caps, convergence, permissions and result formats.
   Keep existing tool inputs. Add optional `calls[].brief` for a re-review’s exact brief, so a provider
   replacement cannot restart its initial scope. Old calls use the batch brief, older readers ignore
   the optional field, and no migration is needed. Evidence detection keeps its conservative labels;
   older reused checks may remain self-reported, never a reason to rerun a suite merely for the label.

## Consequences and proof

`bm_create_reviewer` selects the previous completed implementation review, snapshots the current
tree and delivers its delta. `bm_rereview` uses the same completed-call rule within its batch.
Tree snapshots still write objects only and leave HEAD, the real index, refs and files untouched.
Real temporary-Git tests prove delta selection, retained findings, plan separation, no-verdict
coverage and unchanged owner state. Non-Git tests prove that legacy `since` cannot reopen the
whole request. Role/contract tests cover targeted checks and evidence reuse. No live daemon or
agent is changed by implementing this decision; reverting source and generated bundle rolls back it.
