# paseo-bm 0.5.4

**Inbox attention and update checks are visible without opening each screen.** This release adds a live Inbox badge beside Beads Manager and a bounded, cached update check in Settings. Update with:

```bash
paseo plugin update paseo-bm
```

## What changed

- **Live Inbox badge.** The Beads Manager sidebar item shows the number of unsettled decisions plus open alerts. It refreshes every five seconds and disappears as those items are handled.
- **Visible update availability.** When a newer `paseo-bm-plugin` version is available on npm, a download icon appears beside Beads Manager and on the Settings tab.
- **Check Update in Settings.** Settings shows the installed version, latest known version, check time and any bounded error. The manual action always performs a fresh check.
- **One automatic check per local day.** Opening Beads Manager checks npm metadata at most once per local day. A validated success is cached under the plugin data home; failed or timed-out checks preserve the previous successful result.
- **Narrow network boundary.** The new request is fixed to the public npm metadata endpoint for `paseo-bm-plugin`, carries no credentials, times out after five seconds and never downloads or installs an update.

No agent-role behaviour changed in this release.

## What to know when upgrading

- The automatic update check is the Dashboard's only network request. All other Dashboard flows remain local-only.
- The update cache is disposable metadata. Existing settings, traces, decisions and alerts are unchanged; no migration is required.
- Current Paseo clients use the custom sidebar footer item for the live badge. Older clients keep the existing static Beads Manager item as a compatibility fallback.

## Rollback

`paseo plugin update paseo-bm --version 0.5.3`. The small update-check cache may remain in the paseo-bm data folder and is ignored by 0.5.3.

## Evidence

- The update provider tests cover SemVer precedence, same-day caching, forced and next-day checks, atomic `0600` cache writes, invalid responses and a real abort at the five-second bound while preserving the previous cache.
- Sidebar tests cover positive and zero Inbox counts, five-second query refresh, badge removal after cleared RPC data, update icon states, accessibility labels and navigation.
- The prospective release tree passed `npm run verify` and `npm run smoke:packed`; the release workflow independently repeats verification on Linux and macOS before trusted publishing.
- The generated directory build was reloaded on Paseo 0.10.2 and reported enabled and running without an error.

## Sources

[REQ-173](https://github.com/hieunt286/paseo-bm/blob/v0.5.4/docs/product/paseo-bm-autonomy-prd.md) · [Dashboard design](https://github.com/hieunt286/paseo-bm/blob/v0.5.4/docs/design/paseo-bm-dashboard.md) §11.4 and §17 · [Delivery plan](https://github.com/hieunt286/paseo-bm/blob/v0.5.4/docs/plans/paseo-bm-attention-and-updates.md) · [0.5.3 notes](https://github.com/hieunt286/paseo-bm/releases/tag/v0.5.3)
