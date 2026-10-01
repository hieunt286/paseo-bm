# paseo-bm 0.5.1

**The pictures now show 0.5.** Nothing changes in how the agents work or in the screens. Update with:

```bash
paseo plugin update paseo-bm
```

## What changed

- **The README on npm and the listing on paseo.cafe show the 0.5 screens.** The three screenshots of 0.3 (the old Beads screen, the Metric screen and the installer) are replaced by the five design artboards of the 0.5 screens that [paseo-bm.erai.pro](https://paseo-bm.erai.pro/) shows: the Inbox, Projects, a project's Beads board, Settings → Autonomy, and a Manager chat from the request to a verified finish.
- **The release check waits longer for npm.** After publishing, the release workflow now waits up to 10 minutes, instead of 5, for npm to serve the new version. 0.5.0 was published correctly, but npm took about 6 minutes to serve it, so its release run was marked failed.

## What to know when upgrading

Nothing beyond [0.5.0](https://github.com/hieunt286/paseo-bm/releases/tag/v0.5.0): the plugin's code is the same.

## Rollback

`paseo plugin update paseo-bm --version 0.5.0`.

## Evidence

`npm run verify` and `npm run smoke:packed` exited 0 on the tagged tree. The images are copied unchanged from the site's sources. As before, they are in no tarball: `smoke:packed` checks that.

## Sources

[0.5.0 notes](https://github.com/hieunt286/paseo-bm/releases/tag/v0.5.0) · [paseo.cafe listing record](https://github.com/hieunt286/paseo-bm/blob/v0.5.1/docs/operations/paseo-bm-cafe-listing-20260923.md) (§5, §6) · [Release runbook](https://github.com/hieunt286/paseo-bm/blob/v0.5.1/docs/operations/paseo-bm-release-runbook.md) (§2)
