# paseo-bm 0.3.0-alpha.3

Phase 2a-17 of delta 20260921 ([PRD delta](../archive/product/paseo-bm-prd-delta-20260921-worker-fallback-and-role-settings.md), REQ-066). Use it as `--notes-file` as the [release runbook](../operations/paseo-bm-release-runbook.md) describes.

## Changes

- **Fallback for the Reviewer.** A Reviewer stopped by the provider's plan → a card in the Manager chat, with the same three buttons as for the Worker. **Switch** does not let the plugin create the agent: the parent Worker receives exact instructions to create the replacement Reviewer itself on `bm-reviewer-fallback-<n>` (which has no Paseo tools) and to send it the old review message verbatim. That resend does **not** count as a new review call. If the notice is lost when the plugin reloads, the card has a **Resend to Worker** button.
- **Fallback for the Manager.** A Manager stopped by the provider's plan → a card in its own chat. **Switch** creates a replacement Manager in the same workspace, with a handover built by code (the live Workers and their last reports, the pending questions, the open incidents, the last three messages you typed — with secrets redacted). Beads Manager opens the replacement; every live Worker is told the new Manager id through `BM-SETTINGS`. The old Manager stays until you archive it.
- **Roles & models** shows the fallback chain for all three roles.
- **Wait** and **I'll handle it** apply to every role (Wait sends `BM-RESUME` to the old agent itself when the limit resets).
- Additive contract: `fallback.act` gains the action `resend`.

## Not here yet

- **Automatic mode** (phase 2a-18) is not open: the phase may only start once at least one real incident has been recognised with the right kind, and there had been none when this phase closed.

## Known risks

- A replacement Reviewer is counted correctly only when the Worker sets the `bm.replaces` label; without it the resend is counted and may produce `BM-BUDGET` (failing safe: the Manager asks you).
- After a Manager has been replaced, the workspace's still-open incidents keep showing in the old Manager's chat.

## Compatibility

- Every new RPC field is additive.

## Rollback

Set the policy to "Off" for the Manager and the Reviewer on the Roles & models screen, or install the previous version: `npx paseo-bm@0.3.0-alpha.2`. If a Manager has been replaced: archive whichever Manager you no longer use.
