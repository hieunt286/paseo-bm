# paseo-bm 0.3.0-alpha.7

A **feature** release: Manager, Worker and Reviewer build their `BM-*` blocks with **schema-checked tools** served by the plugin, instead of writing the block themselves and leaving the plugin to guess it back with regular expressions. Alongside that, the Worker decides more and asks less, and a question already answered is not asked again. Use it as `--notes-file` as the [release runbook](../operations/paseo-bm-release-runbook.md) describes.

**Installing this version:** `npx paseo-bm@next`, or pin it with `npx paseo-bm@0.3.0-alpha.7`. The way you install does not change. As in every release, the two packages `paseo-bm` and `paseo-bm-plugin` carry the same version.

## Block-building tools (ADR-010)

- Every `bm-*` agent created **after the install** has exactly one tool of its own role: the Manager `bm_answers`, the Worker `bm_report`, the Reviewer `bm_review`. The tool checks its input, returns per-field errors inside the same turn, and gives back the block for the agent to send verbatim — the `BM-FORMAT` round trip is gone.
- **The block text is unchanged**: the chat cards, the Metric screen, the traces and the question ledger read exactly as before.
- The plugin serves the tools on `127.0.0.1` from its own process; the port is kept in `~/.paseo-bm/ui/agent-tools.json`, so a live agent keeps its tool across plugin reloads. The tool only builds text: it reads nothing, writes nothing and sends nothing.
- The tool is attached only to an agent running **Claude, Codex or OpenCode** — the providers where Paseo can pre-approve a tool. On any other provider (Pi, Copilot and so on) Paseo refuses to create an agent that carries a tool, so there the agent writes the block itself, as before.
- The hand-written path stays for good as the fallback, and is still checked by `BM-FORMAT`.

## The Worker decides more, and asks in the right places

- The Worker decides everything reversible inside the request's scope and records it in the `decided` field for the user to overturn; it asks only about scope, about what cannot be undone, about what only the user has, or when it is stuck.
- The Small/Medium/Large tier measures the risk of the change the Worker designs, not what the user already spelled out; a request that needs no design gets no bead and no Reviewer.
- Suggestions that were not acted on have a field of their own, `suggestions`.

## A question already answered is not asked again

- An answer — from a card or through the Manager — is recorded as real state (the question ledger); the Manager receives `BM-ANSWERED` when the user answers the Worker directly and does not relay it.
- The plugin's notices (`BM-FORMAT`, `BM-ANSWERED` and the rest) and an answer sent from a card appear as small cards in the chat instead of raw text.

## Fixes

- The format checker joins the streamed pieces before checking: 13 of the 17 `BM-FORMAT` notices sent to a Reviewer were false alarms caused by reading one piece at a time.
- A `tier` line with a note after the bracket is no longer treated as a template error.
- The traces no longer read a plugin notice as a review or a report; `parseReviews` counts only the findings of the block it belongs to.

## Evidence

Two independent review rounds; 1100 seeded inputs read back correctly by every parser in the plugin; 7000 requests to the endpoint at 200 concurrent, 0 errors; four Managers in parallel over four projects, two rounds, 0 `BM-FORMAT`; a situation matrix (Codex through Paseo, Pi, OpenCode, a reload, an answer on a card, a Large request, a free-text answer). Record: [the scale run](../archive/operations/paseo-bm-agent-tools-scale-run-20260924.md).

## What to know when upgrading

- **A Manager opened before this version has no tool** (Paseo does not let a plugin change an agent that already exists); it keeps working, through the hand-written path. To give the Manager a tool, archive the old Manager and open a new one. Workers and Reviewers are created fresh for each request, so they have their tools.
- The `latest` dist-tag of both packages is moved by hand by the owner; `release.yml` only sets `next`.

## Sources

[ADR-010](../adr/ADR-010-plugin-hosted-agent-tools.md); [the agent-tools design delta](../archive/design/paseo-bm-delta-20260924b-agent-tools.md), [qa-ledger](../archive/design/paseo-bm-delta-20260924-qa-ledger.md), [worker-autonomy](../archive/design/paseo-bm-delta-20260924-worker-autonomy.md), [instruction-quality](../archive/design/paseo-bm-delta-20260924-instruction-quality.md); [PRD delta REQ-068](../archive/product/paseo-bm-prd-delta-20260924b-agent-tools.md).
