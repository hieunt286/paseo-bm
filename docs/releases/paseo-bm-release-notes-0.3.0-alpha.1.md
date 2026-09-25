# paseo-bm 0.3.0-alpha.1

Phase 2a-15 of delta 20260921 ([PRD delta](../archive/product/paseo-bm-prd-delta-20260921-worker-fallback-and-role-settings.md), REQ-064; [ADR-008](../adr/ADR-008-role-settings-written-by-plugin.md)). Use it as `--notes-file` as the [release runbook](../operations/paseo-bm-release-runbook.md) describes.

## Changes

- **A "Roles & models" screen** in Beads Manager → Setup. Each role (Manager, Worker, Reviewer) has one row: provider · model · thinking · mode, and an **Edit** button. You can change them without a terminal and without reinstalling.
  - Only values Paseo lists can be chosen: a provider that is `available`, a model of that provider, a thinking level of that model, a mode of that provider. Where a price is known, the form shows `~$in / $out per 1M tokens`.
  - The Reviewer can never be given a `dangerous` or a `planning` mode.
  - Warnings, not blocks: Manager and Worker on the same base provider; Pi needing `pi-mcp-adapter`; a Reviewer on Pi or OpenCode.
- **Written straight into the Paseo configuration.** The plugin writes the `bm-*` profiles and aliases through `config.patch`, so Paseo's Settings → Agent profiles always shows exactly those values. Entries that are not `bm-*` stay byte for byte as they were. If the configuration changed elsewhere since the form was opened, nothing is written and the form asks you to reopen it.
- **Live agents are told.** A change applies to agents created after the save; a running agent keeps its old model and thinking. When a child agent's mode changes, the live Manager (for the Worker) and the live Worker (for the Reviewer) receive `BM-SETTINGS` with the new mode line, so their next creation is not refused by Paseo.
- New RPCs: `roles.settings`, `roles.options`, `roles.save-settings`; new error codes `E_ROLE_SETTINGS_INVALID`, `E_ROLE_SETTINGS_CONFLICT`, `E_ROLE_SETTINGS_WRITE_FAILED`.

## Known risks (accepted by the owner, Q3 a, Q15 a)

- Paseo replaces the whole `daemon.agentProfiles` array on every write and has no conditional write. A change made in Paseo's own Settings that lands exactly while the plugin is writing can be overwritten with no warning. The plugin only narrows that window (it compares `revision` immediately before writing, writes once, holds a mutex).
- A pending `BM-SETTINGS` notice waits in memory: reloading the plugin loses it, and that agent falls back to the old behaviour (Paseo refuses the creation, the agent sends `blocked`).

## Compatibility

- Every new RPC field is additive. `roles.describe` is unchanged. No data migration.

## Rollback

Install the previous version: `npx paseo-bm@0.3.0-alpha.0`. Settings already saved live in the Paseo configuration and keep working; to change them back, use Paseo's Settings or `--role`.
