# paseo-bm — Beads Management for Paseo

paseo-bm adds a focused agent team and a dashboard to [Paseo](https://paseo.sh), organised by **mission**: one goal you name, across every repository it needs. Each mission has a **Main** — a Beads Manager that briefs Workers in each repository, links them when they must agree, keeps what is in flight and asks you only what is yours to decide. A Worker implements and proves each change, a Reviewer checks larger work, and the optional Orchestrator governs the missions' process at the autonomy level you choose.

Visit the [paseo-bm website](https://paseo-bm.erai.pro/) for a guided overview of the plugin.

![The Inbox: decisions, held actions and alerts by project](plugin/images/01-inbox.jpg)

## What you get

- **Missions** — every mission with its Main, level, repositories, Workers, done criteria and governor signals; a mission's page shows what is in flight and whom it waits on, the Main's history, contracts, journal, plan and each repository's memory.
- **A Mission-List project in Paseo** — one workspace per mission, where its Main works; tabs appear there only when you open one or the plugin opens a successor for that mission.
- **Inbox** — decisions and alerts that need you, grouped by project: Workers' questions, the Main's own questions, merges and transfers between missions.
- **Projects** — request timelines, Beads, metrics and running agents per repository.
- **Settings** — repository and mission autonomy, coordination, roles, update status and release notes.
- **Tools & skills** — the skills and command-line tools the team uses.
- **Four roles** — the Main (Beads Manager), Worker, Reviewer and an optional machine-wide Orchestrator that governs the missions.

Small changes stay lightweight; work that changes contracts, data or safety boundaries gets documentation, Beads and independent review. Every question has one decider — paseo-bm, the Main, the Orchestrator or you — named when it opens, within the levels you set.

## Install and start

Requires **Paseo 0.9.0 or newer** on macOS or Linux.

```bash
paseo plugin add npm:paseo-bm-plugin
```

Then:

1. Open **Beads Manager** in Paseo.
2. In **Settings → More → Agents**, choose **Allow agent tools**.
3. In **Tools & skills**, install the workflow skills and `br` / `bv` if they are missing.
4. In **Missions**, choose **New mission** (or **New mission** in the Command Center): give it a name, a short code, a goal, its repositories and a mission level. Its Main opens in the mission's own workspace.
5. Tell the Main the outcome you want. It answers what reading the code answers, and gives every change to a Worker in the right repository.

The first open creates the four `bm-*` role profiles with an available provider/model. You can change them in Settings. Repositories you already used with an earlier version keep their Manager as a one-repository mission; the Inbox offers to merge it into a mission of yours that covers the same repository.

## Updates and release notes

Settings checks `paseo-bm-plugin` on npm once per local day. When a newer release exists, choose **Update now**, review the confirmation, and update without leaving Paseo. You can still use:

```bash
paseo plugin update paseo-bm
```

The changelog is authored once in [`docs/releases/`](docs/releases/) and used for GitHub Releases, tagged source links and the release-note view inside the plugin.

## Important safety notes

- Paseo plugins run without a sandbox; paseo-bm has the daemon's machine access.
- **Allow agent tools** is a machine-wide Paseo switch, not limited to paseo-bm agents.
- Workers run without interactive permission prompts. Their instructions prohibit pushes, publishes, destructive actions, secret reads and work outside the request without your approval; review the diff before committing.
- **Install skills** runs the third-party [`skills` CLI](https://github.com/cuongntr/agent-skills), which downloads another author's project.
- Starting the Orchestrator sends masked project context to its model provider and uses provider tokens.

Read [GUIDE.md](GUIDE.md#before-you-install-read-these-warnings) for the full data, permission, autonomy and troubleshooting reference.

## Remove

First open **Settings → More → Data** and choose **Remove paseo-bm's settings…**. Then run:

```bash
paseo plugin remove paseo-bm
```

The Settings action removes the `bm-*` configuration and restores the agent-tools switch where applicable; Paseo has no uninstall hook that can do this automatically.

## Older directory installs

If you originally installed paseo-bm with the retired `npx` installer, follow the short [migration guide](GUIDE.md#coming-from-the-npx-install). The one-time command is `npx paseo-bm@0.4.0`; the historical source remains at the [`v0.4.0` tag](https://github.com/hieunt286/paseo-bm/tree/v0.4.0).

## Learn more

- [Plugin website and guided tour](https://paseo-bm.erai.pro/)
- [Full guide](GUIDE.md)
- [Release notes](docs/releases/)
- [Product and technical documentation](docs/README.md)

MIT licensed.
