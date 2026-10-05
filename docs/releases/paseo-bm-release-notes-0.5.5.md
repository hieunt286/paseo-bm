# paseo-bm 0.5.5

**Update paseo-bm from Settings, browse release notes from the same source used on GitHub, and navigate busy project screens with less scrolling.** This release includes the update visibility introduced in 0.5.4 and adds a confirmed in-product update action, a unified changelog view, a compact Autonomy project picker, and mobile Bead details beside the selected task.

Update with:

```bash
paseo plugin update paseo-bm
```

## What changed

- **Update now in Settings.** When a newer npm release is available, Settings offers a confirmation before running the supported `paseo plugin update paseo-bm` flow. Progress and the verified result stay inline; interrupted or unconfirmed outcomes show recovery guidance instead of claiming success.
- **One release-note source.** Settings can browse the release files from `docs/releases/`, generated into the published plugin at build time. Each version links to its tagged Git source, while the same authored file remains the GitHub Release body.
- **Simpler onboarding docs.** The repository and npm READMEs now focus on installation, current use, updates, safety boundaries, and support instead of carrying historical release narratives.
- **Compact Autonomy project selection.** Settings uses one dropdown-style project picker on phone and wide layouts, so projects no longer consume a growing row of tabs.
- **Mobile Bead detail stays nearby.** On compact screens, the selected Bead's detail appears directly under that Bead instead of below the final item in a long column.
- **Existing 0.5.4 attention cues remain.** The sidebar Inbox badge and bounded daily npm update check continue to surface work and available releases without opening each screen.

No agent-role behaviour or stored-data format changed in this release.

## What to know when upgrading

- **Update now** is available only when the installed plugin is the npm package `paseo-bm-plugin`. Directory installs remain manual and are never overwritten by the action.
- The confirmation authorizes a network/package write and the plugin may reload during the command. If Settings cannot prove the resulting version, it reports an unknown outcome and points to `paseo plugin ls` plus the manual update command.
- Release notes are bundled at build time. Reading them in Settings makes no GitHub request; only opening the source link leaves Paseo.
- Existing settings, policies, Beads data, traces, decisions, alerts, and update-cache data need no migration.

## Rollback

Run `paseo plugin update paseo-bm --version 0.5.4`. Version 0.5.4 can read the existing plugin data; it ignores the generated release-note catalog and does not expose the 0.5.5 update action or layout fixes.

## Evidence

- Focused tests cover fixed update command arguments, npm-install eligibility, confirmation, busy state, success/failure/unknown outcomes, timeout and recovery text.
- Release-note generator and client tests cover deterministic SemVer ordering, invalid or duplicate versions, readable bundled content, version selection and tagged Git links.
- View-source tests cover the shared Autonomy picker and inline compact Bead detail while preserving the wide-screen detail pane.
- The release tree is verified with the full repository suite, packed-package smoke test, isolated-daemon fresh install and update rehearsal, then the GitHub release workflow on Linux and macOS before trusted publishing.

## Sources

[REQ-174](https://github.com/hieunt286/paseo-bm/blob/v0.5.5/docs/product/paseo-bm-autonomy-prd.md) · [Dashboard design](https://github.com/hieunt286/paseo-bm/blob/v0.5.5/docs/design/paseo-bm-dashboard.md) §§11.4, 13.4 and 19 · [Autonomy design](https://github.com/hieunt286/paseo-bm/blob/v0.5.5/docs/design/paseo-bm-autonomy.md) §B.2 · [Update and release-notes plan](https://github.com/hieunt286/paseo-bm/blob/v0.5.5/docs/plans/paseo-bm-update-and-release-notes.md) · [0.5.4 notes](https://github.com/hieunt286/paseo-bm/releases/tag/v0.5.4)
