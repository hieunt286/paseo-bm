# paseo-bm 0.2.0-alpha.2

Phase 2a-13 of delta 20260921 ([PRD delta](../archive/product/paseo-bm-prd-delta-20260921-worker-fallback-and-role-settings.md), REQ-062). Use it as `--notes-file` as the [release runbook](../operations/paseo-bm-release-runbook.md) describes.

## Changes

- **Profile thinking and features reach the Worker and the Reviewer.** The thinking level and the features you set on the **Worker** (`bm-worker`) or **Reviewer** (`bm-reviewer`) profile in Paseo's Settings → Agent profiles now apply to every Worker and Reviewer created afterwards. Thinking is applied only when the agent runs the profile's own model, because each model has its own set of thinking levels. A value passed in by the creator still wins.
- **Reinstalling no longer wipes the configuration you set.** `npx paseo-bm install` now merges into the `bm-*` entries of the Paseo configuration instead of replacing them: the thinking, mode, features, icon and `paseoTools.disabledTools` you set all stay. `--role` and `--reconfigure` change only the base provider, the model and the name of the role they name; changing the model drops the old thinking level.
- **`doctor` reports a role changed in the app.** A new check `roles.changed-in-app` (level `ok`, exit code unchanged) says when a role's base provider or model differs from what the installer wrote last.

## Compatibility

- `install.json` keeps its shape. `roles[]` now means "what the installer wrote last"; the configuration in force is the Paseo configuration.
- If you used a reinstall to bring a role back to its default: use `--role` or `--reconfigure`.

## Rollback

Install the previous version: `npx paseo-bm@0.2.0-alpha.1`. There is no data to clean up.
