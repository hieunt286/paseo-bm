# ADR-006 — Register roles with derived providers plus agent profiles; open tool permissions with a warning

| Field | Value |
|---|---|
| Status | Accepted |
| Date | 2026-09-15 |
| Owner | hieu.nt10 |
| Related | [PRD REQ-027, REQ-031, REQ-032](../product/paseo-bm-prd.md#6-functional-requirements) · [ADR-004](ADR-004-paseo-config-mutation.md) (scope expanded) · [ADR-005](ADR-005-manager-as-agent.md) · [Technical Design](../design/paseo-bm.md) |
| Amended by | [ADR-008](ADR-008-role-settings-written-by-plugin.md), decisions 1 and 5 (Accepted 2026-09-22) · [ADR-012](ADR-012-plugin-is-the-product.md) (2026-09-25), decisions 1, 4, 6, 7, 8: the plugin (not the installer) creates missing aliases and profiles with defaults, without asking; granting Paseo tools to agents is a separate button with a warning on Setup, not combined with enabling the plugin; the role instructions are embedded in the package, without hashes; removal is through the "Remove paseo-bm's settings" button; the previous state of `injectIntoAgents` is recorded in `ui/setup-state.json` as a boolean |

## Context

ADR-005 settled that Manager and Worker are agents. For them to create and follow other agents, two things are needed:

1. **A place for the user to choose the tool and model for each role** — Paseo calls it an agent profile.
2. **Permission to use Paseo's tool set** — by default an agent does **not** have it.

Facts surveyed on the machine (Paseo 0.8.0, 2026-09-15):

- `daemon.mcp.enabled` is on by default; `daemon.mcp.injectIntoAgents` is **off by default**, and when on, **every** agent gets Paseo's tools. On the owner's machine it is already on, but that must not be taken as other users' default.
- It can be limited per provider with the `paseoTools` key (`enabled`, `disabledTools`) in `agents.providers.<id>`.
- A **derived** provider is declared with `extends`, and does **not have to** declare `command` again. The minimal example needs only `extends` plus `label`.
- `daemon.agentProfiles` is an array, each entry having `id`, `name`, `icon`, `color`, `provider`, `modeId`, `thinkingOptionId`, `notes`.
- The owner's machine **already has** 6 derived providers and 6 profiles created by paseo-room (prefix `room-`). paseo-bm must coexist with them and must not overwrite them.
- ADR-004 previously stated that paseo-bm does **not** touch `agents.providers` and `daemon.agentProfiles`. This decision **expands that scope** because the product has changed.

## Decision

1. **Register three roles** under the `bm-` prefix, so as not to touch anything of the user's or of paseo-room's:
   - Derived providers: `bm-manager`, `bm-worker`, `bm-reviewer`, each consisting only of `extends` (pointing at the base provider the user chose), `label`, and `paseoTools`.
   - The corresponding agent profiles, with `notes` that clearly describe when to use which role.
2. **No `command`, no `env`.** The roles reuse exactly the binary and the existing login session of the base provider. This is how the promise "never touch credentials" is kept: paseo-bm creates no separate home directory per role, touches no token, and isolates no login session — quite unlike paseo-room.
3. **Open tool permissions — announce first, then turn on, with per-role narrowing** *(revised 2026-09-15 per the owner's decision)*:
   - The installer **announces clearly and then turns on `daemon.mcp.injectIntoAgents`**. The warning must say plainly: turning this switch on means **every agent on the machine** gets permission to create, nudge and stop other agents, not only paseo-bm's three roles. This step is **combined into one question with enabling the plugin**: interactively, one question states both consequences; non-interactively, the `--enable-plugins` flag covers both. *(Revised 2026-09-15 — the first draft split it into two consents; the owner decided to combine them because enabling the plugin without opening the permission leaves Manager unable to create a Worker.)*
   - `paseoTools.enabled = true` is still set for `bm-manager` and `bm-worker`, and **not** set for `bm-reviewer`. This is an additional narrowing layer: good if it works, harmless if it does not.
   - Record in the install record whether paseo-bm itself turned the switch on, so that the uninstall command returns exactly the previous state.
   - *The first draft of this ADR chose the opposite path — open only per provider and avoid the global switch. The owner decided to change it because the narrow path might not work, and a product that cannot create agents is useless. The price is a wider permission scope, so it is traded for an explicit warning instead of being done silently.*
4. **Consent must be explicit, but it is combined with the consent to enable the plugin.** Giving an agent the permission to create and stop other agents is a security boundary, so `--yes` **never** counts as consent. But it goes into the same question as enabling the plugin, because the two only make sense together.
5. **Write only our own part.** With `daemon.agentProfiles` being an array, paseo-bm reads it, only adds or edits entries prefixed `bm-`, keeps the order and content of every other entry intact, and writes it back. **Never replace the whole array** — this is exactly where paseo-room can swallow a concurrent change.
6. **The role instructions are a versioned asset**, living in the plugin payload and written into the install home like every other file: with a hash, ownership classification, and a backup on overwrite (ADR-002).
7. **Uninstall** deletes exactly the `bm-*` entries in `agents.providers` and `daemon.agentProfiles`, returns `daemon.mcp.injectIntoAgents` to its previous state if paseo-bm itself turned it on, and keeps everything else intact.
8. **Record the previous state per key, not as a boolean flag.** The record stores `{ present, value }` of `daemon.mcp.injectIntoAgents` as it was before paseo-bm touched it, because "the key did not exist before" is different from "it was `false` before". On uninstall, edit exactly that key according to the recorded state, with a concurrent-write check — **do not** restore the whole backup file, because that would erase every configuration change made after the install. If the current value differs from the value paseo-bm set, treat it as changed by someone else and do **not** touch it. *(Errata 2026-09-15, bm-tm2: the same rule applies to `pluginsEnabled` through the `paseo.pluginsEnabledPrevious` field, and the record also stores `paseo.createdConfigContainers` — the `config.json` containers created by paseo-bm itself — so that the uninstall command deletes them once they are empty again; a container that already existed or still has other content is kept. See Design §3.2.)*
9. **Reviewer: constrained at two layers.** Not setting `paseoTools` for `bm-reviewer` is the configuration layer, but when the global switch is on, this layer **may not** be able to disable the permission. So the constraint "Reviewer does not create agents" must be written directly in the role instructions, and the acceptance run must check whether Reviewer actually receives the agent-management tools. If it turns out that it still does, then the instruction layer is the only thing preventing recursive review, and that must be recorded as a known risk.

## Consequences

**Positive**
- The user chooses the tool for each role right inside Paseo, and sees the roles in the model picker like any other profile.
- No credentials touched: no separate home directory, no token, no isolated login session. The PRD's negative evidence keeps its value.
- The `bm-` prefix makes clean removal deterministic, and allows coexisting with paseo-room.
- Recording the previous state per key allows undoing exactly the right thing without overriding someone else's change.

**Negative / to be accepted**
- The scope of writes into `config.json` is **much wider** than in ADR-004: from exactly one boolean field up to three providers, three profiles, and possibly the MCP switch. Compensated by the write-only-our-own-part rule and by a backup before every write.
- Editing one element of the `agentProfiles` array is harder than editing a root field; it needs a careful read–modify–write and a check after the reload.
- **Wider permission than desired:** turning on the global switch means every agent on the machine — including agents that have nothing to do with paseo-bm — gets permission to create, nudge and stop other agents. The owner accepts this knowingly, in exchange for an explicit warning at install time and `doctor` showing this state.
- **The per-role narrowing layer may have no effect** when the global switch is on; then "Reviewer has no tools" is guaranteed only by the role instructions, not by configuration (decision 9).
- A derived provider inherits the base provider's usage limits and login state; if the base provider breaks, all three roles break with it.

## Alternatives considered

| Option | Reason rejected |
|---|---|
| Open the permission only per provider, avoiding the global switch | **This was the original choice of this ADR and was reversed by the owner on 2026-09-15.** Reason rejected: there is no evidence yet that the per-provider permission works when the global switch is off, and a product that cannot create agents is useless. The narrow path is still kept as an additional layer |
| Turn on the global switch **silently**, without telling the user | This is the option that truly deserves rejection: changing the security boundary of the whole machine without the user knowing |
| Turn on `paseoTools` directly on the base provider (`codex`, `claude`) | Still affects every agent using that provider, while the cost of creating a derived provider is almost zero |
| Copy the paseo-room model: separate providers with a separate home directory and login session for each role | Brings the responsibility of managing credentials that the PRD has declared it does not take on; also forces the user to log in again several times for the same tool |
| Register no profiles, and let Manager pass the provider and model directly when creating an agent | The user loses a place to view and edit the role configuration; and the configuration would be scattered through the instructions instead of in the place Paseo reserves for it |
| Overwrite the whole `agentProfiles` array for simplicity | This is exactly the bug seen in paseo-room: losing a concurrent change from the app |
