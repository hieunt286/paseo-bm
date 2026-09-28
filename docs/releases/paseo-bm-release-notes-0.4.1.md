# paseo-bm 0.4.1

**A patch for 0.4.0: a cleaner first run, and two edge cases made safe.** Nothing changes in how the three agents work. Update with:

```bash
paseo plugin update paseo-bm
```

**Only `paseo-bm-plugin` is published from this release on.** The `paseo-bm` command stays at `0.4.0`, its last version, and is marked deprecated on npm; it still does its one job, `npx paseo-bm@0.4.0`, for anyone coming from a 0.3.x install.

## What changed

- **The first time you open Beads Manager reads cleanly.** On a fresh install Paseo's agent tools are off, so Beads Manager does not start a Manager yet and says why. In 0.4.0 that line carried Paseo's own wrapping (`Request failed: … requestType=plugin.rpc.invoke.request code=handler_error`) and did not show the error code; now it reads `Could not open Beads Manager (E_PROVIDER_UNAVAILABLE). …` followed by the plugin's message. The same applies to every error line of the launcher and the agent tree.
- **That first message still says the roles were created.** The call that creates the three roles is the same call that is refused while the tools are off, so the "paseo-bm created its roles with defaults (…)" sentence was lost; it now comes first in the message.
- **Setup describes the switch as it is.** With the agent tools off, the Setup row now says "Off — no new Beads Manager starts until you allow them" instead of "the Manager may not be able to create a Worker".
- **A fallback Switch no longer creates an agent that cannot work.** When a Manager or Worker hits its plan limit and you choose Switch (or the Auto policy does) while Paseo's agent tools are off, paseo-bm used to create the replacement anyway, without Paseo's tools: a replacement Manager would then become the one Beads Manager opens, unable to create a Worker. Now nothing is created, the card stays pending, and it says to allow the tools and switch again.
- **A Worker or Reviewer moved to its profile's model drops a thinking level chosen for another model.** 0.4.0 already starts them on the model set in Setup → Agents; a thinking level passed for the old model is now replaced by the profile's own. An OpenCode Worker's features are read for the model it will run on.

## What to know when upgrading

- Requires Paseo 0.9.0 or newer, as 0.4.0 did.
- Agents created before the update keep working as they are; the changes apply to what is created afterwards and to the screens.
- Coming from a 0.3.x directory install: run `npx paseo-bm@0.4.0` once (it installs the plugin from npm), then `paseo plugin update paseo-bm`.

## Rollback

`paseo plugin update paseo-bm --version 0.4.0`. Your data folder and settings are the same in both versions.

## Evidence

`npm run verify` and `npm run smoke:packed` exited 0 on the tagged tree. Before publishing, the exact payload was packed as `0.4.1-rc.0` and installed through a registry mirror on isolated Paseo 0.9.2 daemons: updated from the real `0.4.0` (the Manager, history, roles and switch carried over, and a Manager created on 0.4.0 had its Worker and Reviewer started on Codex after the user moved them there), and installed fresh (the refusal wording on first and second open, no agent created while the tools were off, a stale Claude model with a Claude thinking level started on Codex, removal leaving nothing behind). paseo.cafe's security scanner reports no finding on the payload. Two independent review passes covered the code changes.

## Sources

[Technical Design](https://github.com/hieunt286/paseo-bm/blob/v0.4.1/docs/design/paseo-bm.md) (§7.2, §7.3, §7.10, §7.13.2) · [Dashboard design](https://github.com/hieunt286/paseo-bm/blob/v0.4.1/docs/design/paseo-bm-dashboard.md) (§11.2, §11.3) · [0.4.0 notes](https://github.com/hieunt286/paseo-bm/releases/tag/v0.4.0)
