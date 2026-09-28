# ADR-004 — Integrate with Paseo through its CLI; turn on `pluginsEnabled` with a minimal edit of `config.json`, then reload

| Field | Value |
|---|---|
| Status | Accepted |
| Date | 2026-09-14 |
| Owner | hieu.nt10 |
| Related | [PRD REQ-005, REQ-006, REQ-010d](../product/paseo-bm-prd.md#6-functional-requirements), [ADR-001](ADR-001-plugin-distribution.md), [ADR-002](ADR-002-install-ownership-model.md), [Technical Design](../design/paseo-bm.md) |
| Amended by | [ADR-008](ADR-008-role-settings-written-by-plugin.md), decision 1 (Accepted 2026-09-22) · [ADR-012](ADR-012-plugin-is-the-product.md) (2026-09-25): the plugin edits the config through `config.patch`, not through the file. Decisions 4, 6, 7, 8 (turning on `pluginsEnabled`, recording who turned it on, the minimal file edit, detecting concurrent writes) no longer apply from 0.4.0; decision 2 changes the minimum to Paseo 0.9.0; decisions 1, 3, 5 now apply only to the 0.4.0 migration CLI |

## Context

paseo-bm needs three things on the Paseo side: read the daemon's state, register/remove the plugin, and turn on the `pluginsEnabled` switch when the user consents.

Survey on the machine (Paseo 0.8.0, 2026-09-14):

- `paseo daemon status --json` returns `home`, `cliVersion`, `daemonVersion`, `listen`, `localDaemon`, `connectedDaemon` — enough for the whole environment check.
  - *Errata 2026-09-25 (bm-qh4c):* Paseo 0.9.2 dropped `cliVersion` from `daemon status --json`. The adapter then takes the CLI version from `paseo --version`; the decision in item 2 does not change.
- `paseo plugin install|ls|logs|enable|disable|remove` all have `--json` and `--host`.
- **There is no CLI command to set an arbitrary configuration field.** `paseo daemon` has only `start`, `pair`, `reload`, `status`, `stop`, `restart`, `set-password`.
- `paseo daemon reload --json` (alias `paseo reload`) reloads `config.json` without restarting the daemon.
- `~/.paseo/config.json` currently has the keys `version`, `daemon`, `app`, `agents`, `features`; it has **no** `pluginsEnabled` and no `plugins` — missing means off.
- The `@getpaseo/client` SDK (npm `0.8.0`) has `config.patch`, which is what paseo-room uses. But paseo-room pins the SDK at exactly `0.8.0-beta.1`, and its write reads and then overwrites **the whole** `agentProfiles` **array**, so it can swallow a concurrent change from the app.
- The official plugin documentation gives exactly this sequence: keep the rest of `config.json` intact, set `pluginsEnabled` at the root level, run `paseo reload --json`, then check that `pluginsEnabled` is in `appliedPaths`.
- The same documentation warns: **do not restart the daemon** to load changes, because that can kill a running agent.

## Decision

1. **Integrate through the `paseo` CLI by default**, without depending on the SDK. Every call uses `--json` and is wrapped in a single adapter.
2. **Check the environment** with `paseo daemon status --json`: the daemon must be running, `cliVersion` must match `daemonVersion`, the version must be `>=0.8.0`, and `home` is the source of truth for the Paseo path (`PASEO_HOME` and the flag are only overrides for detection).
3. **Register and remove the plugin** with `paseo plugin install|remove|ls|logs`, without hand-editing the `plugins` key in `config.json`.
4. **Turn on `pluginsEnabled`**, only after explicit consent, in exactly this sequence:
   1. Read `config.json`, back it up into paseo-bm's install home.
   2. Read–modify–write immediately before writing, setting only **one root-level field**, keeping every other key and the key order intact. Write atomically per ADR-002.
   3. `paseo daemon reload --json`, requiring `pluginsEnabled` in `appliedPaths`; if `appliedPaths` is empty, read the file again and check the actual state.
   4. Confirm with `paseo plugin ls --json` until `paseo-bm` reaches `running`, with a time limit on the wait.
   5. Reload fails or the daemon rejects the configuration → restore the backup, reload again, report the error.
5. **Never** run `paseo daemon restart` or `stop`.
6. **Record who turned it on**: if paseo-bm itself turned the switch on, record that in the install record. Only then, and when no other plugin is left in `paseo plugin ls`, does the uninstall command offer to turn it off again.
7. ~~**Do not touch** `agents.providers`, `daemon.agentProfiles` or any other key — quite unlike paseo-room's scope.~~
   **Corrected 2026-09-15 — [ADR-006](ADR-006-role-registration.md) replaces this clause.** When the product expanded into orchestration, paseo-bm had to register agent roles, so it also writes into `agents.providers` and `daemon.agentProfiles`, and possibly `daemon.mcp.injectIntoAgents`. The principles of this ADR stay unchanged and apply to the new scope: write only the parts prefixed `bm-`, keep every other entry intact, back up before writing, never replace a whole array, and verify again after the reload.
8. Detect a concurrent-write conflict by comparing the file's content immediately before writing with the content just read; if it differs, read again and retry once; if it still differs, stop and ask the user to close the Settings screen.

## Verified on a real daemon (2026-09-14, Paseo 0.8.0)

Installed and then removed an empty plugin in `/tmp`, comparing `config.json` before and after:

- `paseo plugin install <dir>` **succeeds when `pluginsEnabled` is not set**, exit code 0, returning `{"id","path","enabled":true,"status":"disabled"}`. So the order "register first, ask for consent to turn it on later" is valid.
- `enabled` is the plugin's own switch; only `status` reflects the real state (`disabled` when the global switch is off). Every "is the plugin running yet" check must read `status`.
- Paseo itself writes the key `plugins: { "<id>": { "source": "directory", "path": "…", "enabled": true } }` into `config.json`. This reaffirms decision 3: paseo-bm does not write this key itself.
- `paseo plugin remove` deletes the plugin's entry but **leaves the `plugins: {}` key behind** and **does not delete the source directory**. So paseo-bm deletes its own payload and does not touch the `plugins` key.

## Consequences

**Positive**
- No version-pinned SDK dependency — exactly the breaking point seen in paseo-room.
- The scope of writing into someone else's configuration comes down to exactly **one boolean field**, so both the risk and the test surface are small.
- It uses exactly the sequence Paseo's documentation recommends, so it is less likely to drift when Paseo upgrades.
- No risk of killing a running agent.

**Negative / to be accepted**
- Depends on the CLI's JSON format. Mitigation: defensive parsing, reading only the fields needed, a clear error message when the shape changes, and tests against a fake CLI.
- Calling a child process is slower than the SDK. Negligible at a scale of a few commands per run.
- A very narrow concurrent-write gap remains between the read and the `rename`. Mitigated by checking again before writing and retrying once.
- Editing the file directly means its format must be preserved: use read–modify–write on the JSON structure, accepting that whitespace may be normalised. A backup is always made first.

## Alternatives considered

| Option | Reason rejected |
|---|---|
| Use `@getpaseo/client` `config.patch` | Adds another dependency that must track Paseo's version; paseo-room has shown that pinning the SDK is a breaking point; not worth it just to set one boolean field. Kept as a fallback option if the CLI lacks something needed |
| Ask the user to turn it on in Settings themselves | Adds a manual step exactly where it is most often forgotten — the very problem the PRD wants to remove. Still kept as instructions when the user declines to let paseo-bm edit |
| Restart the daemon to be safe | The documentation explicitly forbids it; it can kill a running agent |
| Write the `plugins` key straight into `config.json` instead of calling `paseo plugin install` | Skips Paseo's validation step; the plugin source format is an internal detail that may change |
