# ADR-008 — The plugin writes role settings into the Paseo config through `config.patch`; fallback aliases for every role

| Field | Value |
|---|---|
| Status | **Accepted** (2026-09-22). The owner chose direction R1 on 2026-09-21 (Q3 a of `req-20260921T111242Z`) and approved [PRD delta 20260921](../archive/product/paseo-bm-prd-delta-20260921-worker-fallback-and-role-settings.md) §9 on 2026-09-22 (Q10 a) — the condition this ADR set for becoming Accepted. In effect from phase 2a-15, when the plugin starts writing role settings (`plugin/server/config-writer.ts`) |
| Date | 2026-09-21 |
| Owner | hieu.nt10 |
| Amends | [ADR-004](ADR-004-paseo-config-mutation.md) decision 1; [ADR-006](ADR-006-role-registration.md) decisions 1 and 5 |
| Amended by | [ADR-012](ADR-012-plugin-is-the-product.md) (2026-09-25), decision 2: the plugin may **create** the aliases and profiles of the three main roles when they are missing, and delete them when the user removes paseo-bm's settings; an existing entry is still not edited on creation (decision 5); the write scope is still only `bm-` ids, plus `mcp.injectIntoAgents` when the user clicks |
| Related | [PRD delta 20260921](../archive/product/paseo-bm-prd-delta-20260921-worker-fallback-and-role-settings.md) REQ-064, REQ-065, REQ-066 · [Design delta 20260921](../archive/design/paseo-bm-delta-20260921-worker-fallback-and-role-settings.md) §4.3, §4.4 · [Proposal 20260921](../archive/design/paseo-bm-proposal-20260921-worker-fallback-and-role-settings.md) §4.2, §4.7 |

## Context

The owner wants to reconfigure the provider, model, thinking and mode of each role **right inside Beads Manager**, after installing with `npx paseo-bm`. The owner also wants a fallback chain for when a usage limit is reached, for all three roles (REQ-064 → REQ-066; Q8 c). Today there are only two paths, and neither can do this:
- `npx paseo-bm install --reconfigure`: requires the terminal, running the installer;
- Paseo's Settings → Agent profiles: can edit a profile, but knows nothing about the fallback chain.

Facts (proposal §1, checked on Paseo 0.8):
- The plugin SDK's `paseo.config.patch()` deep-merges the `agents.providers` section, so one alias can be edited without touching the others. The provider registry updates at once, with no reload.
- The same call **replaces the whole** `daemon.agentProfiles` **array**, and has **no** version or condition for a compare-and-write.
- The daemon writes to the file first; on error it restores the old file.
- The plugin runs **inside** the daemon. Having the plugin edit the `config.json` file and then run `paseo daemon reload` from inside the daemon itself is an unchecked path: it may reload the plugin itself while an RPC is running (option R4 of the proposal).
- The `before("agent.create")` hook recognises the role **only by the provider name** (M5), so each fallback agent needs an alias the hook maps to the right role.
- ADR-004 decision 1 chose "integrate through the CLI, no SDK dependency"; ADR-004 §Context rejected `config.patch` because it replaces the whole array.
- ADR-006 decision 1 registers **three** roles; decision 5 says "never replace the whole array".

## Decision

1. **The plugin is the second writer of `config.json`**, beside the installer. The plugin writes only when the user clicks Save on the Roles & models screen, and only through the SDK's `paseo.config.patch()`. The plugin does not edit the file directly and does not call `paseo daemon reload`.
2. **The plugin's write scope** is exactly the entries whose id starts with `bm-`:
   - `agents.providers.bm-manager` / `bm-worker` / `bm-reviewer`: only `extends`;
   - `agents.providers.bm-<role>-fallback-<n>`, n = 1…3, for `manager`, `worker`, `reviewer`: `{ extends, label }`, plus `paseoTools.enabled: true` for Manager and Worker. A Reviewer fallback alias **never** has `paseoTools` (ADR-006 decision 3). The plugin creates and deletes these aliases;
   - in `daemon.agentProfiles`, only the entries `bm-manager` / `bm-worker` / `bm-reviewer`: `model`, `thinkingOptionId`, `modeId`.

   The plugin **never creates** the aliases or profiles of the three main roles; that is still the installer's job (ADR-006).
3. **A checked exception to ADR-006 decision 5.** Because `config.patch` replaces the whole `agentProfiles` array, every write by the plugin follows exactly five steps:
   1. Read the configuration. Compute a `revision` (sha256 of every `bm-*` alias and the whole profile array). Different from the `revision` when the user opened the screen → **do not write**.
   2. Build the array from **exactly the copy just read**, replacing only the `bm-*` entries in place.
   3. Write with **one** `patch`.
   4. Read again, and check that the very `bm-*` entries just written have the right values; if they do not match, report a write error. Do not rewrite on its own, because rewriting also replaces the whole array. *(Corrected 2026-09-22, owner Q15 a: the previous version promised "report that another profile was overwritten" at this step; that cannot be done, because the write returns the changed profile to exactly the copy that was read.)*
   5. Every write by the plugin goes through an in-process mutex.

   Remaining risk, accepted by the owner on 2026-09-21 (Q3 a) and confirmed again on 2026-09-22 (Q15 a): a change in the app that lands exactly between step 1 and step 3 is still overwritten, and **cannot be reported**. The plugin only narrows that window (checking `revision`, reading immediately before writing).
4. **Fallback aliases have no profile.** The model, thinking and mode of each fallback entry live in `<install home>/role-fallback.json`. That is user data, of the same kind as `role-extras.json`. The fallback chain is paseo-bm's own concept; Paseo has no place for it.
5. **The source of truth for role settings is the Paseo config.** `install.json` `roles[]` keeps its old shape, but is now only a record of "what the installer last wrote". The installer **merges** instead of replacing a whole `bm-*` entry (REQ-062 c), so changes made in the app, on the Roles & models screen or in Paseo's Settings, survive every reinstall intact.
6. **Unchanged:**
   - the installer still integrates through the CLI and edits the file minimally with a backup (ADR-004 decisions 2–8);
   - no `command`, no `env` on an alias, no credentials touched (ADR-006 decision 2);
   - the `bm-` prefix rule for uninstalling (ADR-006 decision 7), so fallback aliases are removed too;
   - Reviewer has no `paseoTools` (ADR-006 decisions 3, 9).

## Consequences

**Positive**
- One source of truth: the Roles & models screen and Paseo's Settings → Agent profiles always say the same thing.
- App users need no terminal to change a role (REQ-028).
- No "edit the file and reload from inside the daemon" path.
- The provider registry updates at once, so a Worker created after saving uses the new settings.

**Negative / to be accepted**
- **A concurrent overwrite can still happen** in `agentProfiles`: step 1 only narrows the window, it can neither prevent nor report it. A real guarantee needs Paseo to have an RPC that edits **one** profile by `id` (request U3, proposal §5.2).
- The plugin depends on the `config.get` / `config.patch` contract of SDK 0.8. If Paseo changes how it merges, this write path may break. Mitigation: tests with a fake daemon, a check after writing.
- `config.json` gains up to nine `bm-<role>-fallback-*` aliases (three per role) with no profile. They appear in Paseo's provider picker.
- The two writers (installer and plugin) may run at the same time. The installer already has a concurrent-write check on the file (ADR-004 decision 8), and the plugin has `revision`. Neither side can lock the other.

## Alternatives considered

| Option | Reason rejected |
|---|---|
| R2 — a separate paseo-bm file, applied in the hook | Two sources of truth: Paseo's Settings say one model, Worker runs another. Changing the base provider would still require writing `extends` into the config |
| R3 — the screen only generates the command `npx paseo-bm install --reconfigure --role …` | Not "inside Beads Manager"; `npx` needs the network; the CLI has no flags for thinking or the fallback chain |
| R4 — the plugin runs the CLI's read-modify-write file core, then `paseo daemon reload` | The plugin writes a file that the daemon itself also writes; a reload called from inside the daemon is unchecked and may reload the plugin itself midway |
| Wait for Paseo to have an RPC that edits one profile (U3) | Does not exist yet, and it is unknown when it will. When it does, steps 2–4 of decision 3 are replaced by that call, with nothing else changed |
