# paseo-bm 0.3.0-alpha.4

A **combined** prerelease of the whole delta 20260921 ([PRD delta](../archive/product/paseo-bm-prd-delta-20260921-worker-fallback-and-role-settings.md), REQ-062 → REQ-067), plus one fix for the mobile app. Use it as `--notes-file` as the [release runbook](../operations/paseo-bm-release-runbook.md) describes.

> **The first release since `0.2.0-alpha.1`.** Each of the six phases 2a-13 → 2a-18 had its own notes written, but **none of those versions reached npm**: `0.2.0-alpha.2` and `0.3.0-alpha.0` → `0.3.0-alpha.3` never existed on the registry. All of it is in this release. The per-phase notes are kept as history, linked below.

**Installing this version:** `npx paseo-bm@next`, or pin it with `npx paseo-bm@0.3.0-alpha.4`. A bare `npx paseo-bm` follows the `latest` dist-tag, which does **not** point at this version yet; `npm view paseo-bm dist-tags` says where `latest` is.

## Changes

### Roles and models

- **Your profile is respected** ([2a-13](./paseo-bm-release-notes-0.2.0-alpha.2.md)). The thinking level and the features you set on the `bm-worker` / `bm-reviewer` profile apply to every agent created afterwards. `npx paseo-bm install` now **merges** into the `bm-*` entries instead of replacing them: the thinking, mode, features, icon and `paseoTools.disabledTools` you set all stay.
- **Every provider for every role** ([2a-14](./paseo-bm-release-notes-0.3.0-alpha.0.md)). Manager, Worker and Reviewer run on every Paseo provider that is `available`, including OpenCode and Pi. With it: a `BM-TOOLS` warning when a newly created agent has no Paseo tools, Pi and OpenCode skill columns on the Setup screen, and pricing from `metadata.cost` for a model that is not in the built-in price table.
- **The "Roles & models" screen** ([2a-15](./paseo-bm-release-notes-0.3.0-alpha.1.md)) in Beads Manager → Setup: one row per role, provider · model · thinking · mode, written straight into the Paseo configuration through `config.patch`. A change applies to agents created after the save; a running agent keeps its old values.

### Fallback when a provider fails

- **"Ask me" for the Worker** ([2a-16](./paseo-bm-release-notes-0.3.0-alpha.2.md)). A Worker stopped by the provider's plan (usage limit, billing, login, provider down) → the plugin recognises it as the turn closes and shows a card. The fallback chain, up to three entries, is set on the Roles & models screen. The kind of failure is recognised by text patterns, editable in `role-fallback.json`; a temporary rate limit does **not** trigger a fallback.
- **Reviewer and Manager** ([2a-17](./paseo-bm-release-notes-0.3.0-alpha.3.md)). The same three buttons. **Wait** sends `BM-RESUME` to the old agent itself when the limit resets; **I'll handle it** leaves it to you.
- **"Auto switch" mode** (2a-18, REQ-067). A third choice per role, beside **Ask me** (the default) and **Off**. With Auto switch, when an agent stops because of the provider's plan:
  - the reset time is known and no more than 30 minutes away → the plugin **waits** (as if you had pressed **Wait**);
  - otherwise, if there is a candidate → the plugin **switches** along the role's own path (Worker: a replacement Worker is created; Reviewer: the parent Worker is given the instructions; Manager: a replacement Manager is created);
  - no candidate → the incident waits for you, as with Ask me.

  An automatic decision goes through exactly the path of a button press: the same lock, the same checks. The chat gets **one** card, already in the state that was chosen — there is no "pending" card before it. Choosing Auto switch shows a cost warning; for the Manager it also says the chat you are using may be replaced. Additive contract: `roles.save-fallback` accepts `policy: "auto"`.

### Fixes

- **The Beads button on mobile opens its own workspace.** Every Beads button on the header used to open the last workspace in the list Paseo returned, because Hermes lets closures created in one loop all see the final value. The desktop build was not affected.

## Known risks

- **Auto switch has been checked only in part.** Release condition REQ-067 (c) is met: one real incident, a refusal from Anthropic, was classified correctly by the pattern set (`L4`, [checklist 18.1](../operations/paseo-bm-worker-fallback-checklist.md)). The remaining acceptance items for Auto switch (18.2 → 18.6: the automatic switch, the automatic wait, the no-candidate case) have **not been measured on a real daemon**. Auto switch is **off** by default; turn it on per role.
- **No usage check before an agent is created** (REQ-067 d): the candidate may be out of quota as well, and the replacement agent's own incident then walks the chain again.
- One misclassified failure creates one agent too many — that costs money, and it puts two agents in the same code at once.

## Compatibility

- Every new RPC field is additive. The default policy is still "Ask me"; `install.json` keeps its shape.
- `roles[]` in `install.json` now means "what the installer wrote last"; the configuration in force is the Paseo configuration.
- **A reinstall no longer returns the `bm-*` entries to their defaults.** If you used a reinstall to "reset" a role, use `--role` or `--reconfigure` instead.
- **`policy: "auto"` is safe with every `0.3.0-alpha.*` version.** The schema of `role-fallback.json` has accepted `"auto"` since phase 2a-16, and the code before 2a-18 reads any policy that is not `"off"` as "Ask me" (the comment saying so is in `plugin/client/setup-model.ts` **in the 2a-17 build**; 2a-18 replaced that line with real `auto` support, so you will not find it in the current code). The fallback chain is kept, nothing is lost. The earlier phases' notes said an older build "treats the whole file as unusable" — that is **not true**. There is no other `0.3.0-alpha.*` on npm to go down to anyway.

## Rollback

The lightest way is **not to downgrade**: set the policy to "Ask me" or "Off" per role on the Roles & models screen. Where an agent was created automatically, archive whichever agent you no longer use.

To go back a version properly, the only one on npm is **`0.2.0-alpha.1`** — `0.2.0-alpha.2` and `0.3.0-alpha.0` → `.3` were never published. That is an **expensive** step back: `0.2.0-alpha.1` holds not one line of fallback or Roles & models code, so `npx paseo-bm@0.2.0-alpha.1` drops **all** of REQ-062 → REQ-067 — respecting your profile, every provider for every role, the Roles & models screen, and the fallback for all three roles. `role-fallback.json` then just sits there, read by nobody.

If you downgrade anyway: set the policy back to "Ask me" or "Off" **first**, because `0.2.0-alpha.1` has no screen to set it from.
