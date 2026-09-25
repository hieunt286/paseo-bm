# paseo-bm 0.3.0-alpha.2

Phase 2a-16 of delta 20260921 ([PRD delta](../archive/product/paseo-bm-prd-delta-20260921-worker-fallback-and-role-settings.md), REQ-065). Use it as `--notes-file` as the [release runbook](../operations/paseo-bm-release-runbook.md) describes.

## Changes

- **A fallback Worker — "Ask me".** When a Worker stops because of the provider's plan (usage limit, billing, login, provider down), the plugin recognises it as that turn ends and asks you with a card in the Manager chat, carrying a "Fallback · N decision(s)" pill:
  - **Switch to <candidate>**: the plugin creates a replacement Worker on the next entry of the fallback chain, in the same directory, with a handover built by code (the last report, the beads, the number of review calls, the original request). The replacement does not redo work already done and does not undo changes already made. The old Worker is marked "replaced"; its running Reviewer is told to stop.
  - **Wait until <reset time>**: where the reset time is known (Claude, Codex), the plugin messages the old Worker itself to carry on after that time.
  - **I'll handle it**: no agent is touched.
- **The fallback chain on the Roles & models screen**: under the Worker row, "On a usage limit: Ask me / Off" and up to three fallback entries (provider, model, thinking, mode), which you can add, remove and reorder.
- **Kind of failure**: recognised by text patterns over the turn's error (editable in `role-fallback.json`, key `patterns`). A temporary rate limit and other errors do not trigger a fallback. A pattern with nested quantifiers (`(a+)+`, for instance) is dropped, because it can hang the plugin.
- **New files** in the install directory, and they are your data: `role-fallback.json`, `role-fallback-state.json`. New aliases in the Paseo configuration: `bm-worker-fallback-<n>`.
- New RPCs `roles.save-fallback`, `fallback.incidents`, `fallback.act`; new error codes `E_FALLBACK_NOT_FOUND`, `E_FALLBACK_NOT_PENDING`, `E_FALLBACK_NO_CANDIDATE`, `E_FALLBACK_NO_RESET`, `E_FALLBACK_CREATE_FAILED`. New plugin notices: `BM-FALLBACK`, `BM-HANDOVER`, `BM-RESUME`.

## Known risks

- The default patterns have not been checked against a real incident; a broken turn that matches no pattern gets no card, as before.
- The usage limit (`listUsage`) is read **only after** an L1 of Claude or Codex has been recognised, once per incident (accepted by the owner, Q2 a).
- Switching to a provider billed by token can cost money; the card shows the price where it is known.

## Compatibility

- Every new RPC field is additive. An older version that meets a `bm-worker-fallback-*` alias does not recognise the role; uninstalling still removes those aliases.

## Rollback

Set the policy to "Off" on the Roles & models screen, or install the previous version: `npx paseo-bm@0.3.0-alpha.1`. The two new files stay behind harmlessly.
