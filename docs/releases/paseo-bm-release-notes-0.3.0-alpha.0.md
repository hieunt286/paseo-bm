# paseo-bm 0.3.0-alpha.0

Phase 2a-14 of delta 20260921 ([PRD delta](../archive/product/paseo-bm-prd-delta-20260921-worker-fallback-and-role-settings.md), REQ-063). Use it as `--notes-file` as the [release runbook](../operations/paseo-bm-release-runbook.md) describes.

## Changes

- **Every provider for every role.** Manager, Worker and Reviewer run on every Paseo provider that is `available`, including OpenCode and Pi. The plugin picks how to run them from what the provider can do:
  - Claude, Codex: as before.
  - OpenCode: an OpenCode agent (mode) is always passed — the one you choose on the profile, or the first one Paseo lists when you choose none. Manager and Worker enable `auto_accept`; **the Reviewer never auto-approves**.
  - Pi: no mode is passed. `## Runtime facts` says "none", so Manager and Worker pass no mode either.
- **A warning when the Paseo tools are missing.** A Worker created without the Paseo tools (Pi without `pi-mcp-adapter`) → the Manager receives `BM-TOOLS` and tells you. A Manager created without them → the Beads Manager screen shows a warning. The Setup screen shows the latest state.
- **Pi and OpenCode skill columns** on the Setup screen (`~/.pi/agent/skills`, `~/.config/opencode/skill`), read-only.
- **Pi login:** the installer prints the instructions instead of running the command.
- **Pricing from `metadata.cost`:** a model that is not in the built-in price table but for which Paseo provides a price (an OpenCode model, for instance) is priced on the Dashboard. A turn record gains an optional `runtime.provider` field.

## Known risks (accepted by the owner, Q7 a)

- A Reviewer on Pi has no permission layer at all; a Reviewer on OpenCode runs with the permissions of the chosen OpenCode agent. In both cases the Reviewer's read-only rule lives in its instructions alone.

## Compatibility

- Every new RPC field is additive. The trace store does not migrate.

## Rollback

Install the previous version: `npx paseo-bm@0.2.0-alpha.2`. If an alias has had its `extends` moved to OpenCode or Pi, move it back with `--role`.
