# paseo-bm 0.5.6

**Work by mission instead of by repository.** A mission is one goal you name — "Ship card payments" — with its own Main: a Beads Manager that works across every repository the goal needs, creates and links the Workers in each, keeps what is in flight, and asks you only what is yours to decide. Missions live in a **Mission-List** project in Paseo, one workspace per mission, and a new **Missions** screen shows each one. The Orchestrator becomes the governor of the missions' process. Projects can also ask each other through the plugin.

Update with:

```bash
paseo plugin update paseo-bm
```

## What changed

### Missions and their Mains

- **A mission per goal.** Create one from **Missions → New mission** (or the Command Center's **New mission**, which opens the same form): a name, a short code (`XAI`), a goal, its repositories and a mission level. The mission's Main starts at once, in the mission's own workspace.
- **The Mission-List project.** Paseo's sidebar shows one project, **Mission-List**, with one workspace per mission, titled `<CODE> · <name>`. A mission's workspace holds its Main; another tab appears there only when you open one or the plugin opens a successor for that mission. Opening a Beads Manager yourself in a mission's workspace makes it that mission's Main when the mission has none running.
- **One Main, many repositories.** The Main creates Workers in any repository of the mission, several when the work splits, links Workers that must agree so they talk directly, records the contracts they settle, and keeps each repository's **project memory** (decisions, conventions and facts with their source) for the Workers it briefs.
- **Mission levels 0–4** decide what the Main does on its own: going on to the next step, creating Workers, deciding Workers' technical questions, adding a repository, deciding questions with effects, and letting the governor split the mission. A repository's own autonomy level still governs the work inside it.
- **The mission is the record.** Every event that changes what is in flight — a follow-up, a report, a question and its answer, a link, a transfer, a Main replaced — is written to the mission. The Main's brief, its state after a compaction, the governor and the Missions screen all read the same mission state, so a successor loses nothing.
- **A long-lived Main.** A Main's context is compacted in place when its real context crosses a threshold (60 % of its window by default); a new Main is created only when compaction cannot help, and it says in its first reply that it took over and what is in flight. One replacement path serves every case, so opening the Main during a handover joins it instead of starting a second one.
- **One decider per question.** When a Worker's question opens, the plugin names who decides it: paseo-bm itself (a review budget within its cap), the Main (within the mission's delegation), the Orchestrator, or you. The Main is told at once of the questions that are its own; what is yours stays a card in the Inbox. The Main asks you its own questions as stored cards too (`bm_owner_question`), answered on the card or in its chat.
- **Fewer interruptions for the Main.** Everything waiting for an idle Main arrives as one message, drawn as one card per item, with a danger signal first. The review-budget notice and the "your Manager was replaced" notice are gone.
- **One owner per request.** Requests move between missions only through one transfer, on your card: a split, a legacy mission merged into yours, or a Main's request to hand work to another mission. Closing a mission waits only for a Worker running a turn; its open requests read `stopped`.

### The Missions screen

- **Missions** sits between Inbox and Projects: each mission with its Main's state, level, repositories, live Workers, done criteria, questions for you and governor signals.
- A mission's page: its charter and done criteria, mission level, governor, **Workers by repository**, **In flight** (each request's state and whom it waits on, the open questions by who decides, the Main's own questions to you, live links), the **Main** history (each Main, when and why it changed, and Open on a previous one), contracts, journal, plan and project memory. Rename, add a repository and close a mission from the page.

### The Orchestrator as governor

- It checks each mission's process against its charter through figures the plugin computes — **mess**, **overengineering**, **drift**, **stuck** and **budget** — and acts on a ladder: record, nudge the Main with the numbers, ask the Main to re-plan, then you. It wakes for one mission at a time with that mission's brief.
- It arbitrates between missions and may split a mission (on your card, or on the source mission's level). It no longer briefs or answers Workers, and an answer it gives grants no effect.
- A Worker's **danger** signal goes to that Worker's Main first; the governor is the backup a few minutes later.

### Projects ask each other

- A Worker that needs another repository's work asks through its Main (`bm_ask_project`), and Mains of two missions talk on a link (`bm_ask_mission`); replies come back as cards and reach the right agent even after it was replaced.

### Agent roles

- **Manager (`manager.md`)** is now a mission's Main: it works across the mission's repositories, keeps the mission and the repositories' memory, answers the Worker questions the plugin names as its own, asks you with stored cards, acts on each item of a `BM-UPDATES` message, and carries on from `BM-STATE` after a compaction.
- **Orchestrator (`orchestrator.md`)** governs the missions' process as described above.
- Running Managers and Orchestrators show as outdated in the Inbox; **Replace** gives each the new instructions, with the mission's state.

## What to know when upgrading

- **Your existing Managers become one-repo missions.** Each repository's Manager is kept, in its repository, as the Main of a mission named after the repository. Where one of your own missions covers that repository, a card in the Inbox offers to **merge** the one-repo mission into yours; keep it if you prefer.
- **The Mission-List project appears** in Paseo's sidebar (`~/.paseo-bm/missions/Mission-List`). A shared `home` workspace from a pre-release build of missions is still recognised; archive it yourself once its Main is replaced. paseo-bm never archives an agent or a workspace.
- **Opening the Beads Manager from a repository** opens the Main of the mission that holds it — your own mission before a one-repo one.
- New Coordination settings for the Main (`main.compact`, `main.contextShare`, `main.contextTokens`, `main.hardShare`) start at their defaults; they have no Settings card yet, and the Orchestrator can propose a change you apply on its card. New data under `~/.paseo-bm/`: `missions/`, `memory/`, the mission decisions and links. Every stored format is additive; nothing else needs a migration.
- A Paseo build that cannot add a workspace to a project keeps every Main in the Mission-List root workspace and says so once in the plugin's log.

## Rollback

Run `paseo plugin update paseo-bm --version 0.5.5`. Version 0.5.5 ignores the missions: it opens a per-repository Manager again, and the Mains stay in your agent list. The missions, project memory and links stay on disk, so a later return to 0.5.6 finds them as they were.

## Evidence

- The full repository suite passes on the release tree: 5,731 unit tests, the benchmark and the 134 evaluation tests, the generated bundle at 1,646,885 of paseo.cafe's 2,000,000 bytes.
- Property and unit tests cover the mission state across every replacement, the single replacement path, each authority rule and review cap, the Main's channel, transfers and merges, the close rule, the Mission-List layout and the Missions screen against its approved mockups.
- The build was installed on isolated Paseo daemons (the Mission-List project, a workspace per mission, no duplicate after a reload) and used on the owner's daemon before the release; the GitHub release workflow verifies it on Linux and macOS before trusted publishing.
- The replay reports the governor's scale (A-13) and the Mains' turns by what started them (A-14).

## Sources

[ADR-028](https://github.com/hieunt286/paseo-bm/blob/v0.5.6/docs/adr/ADR-028-projects-ask-each-other-through-the-plugin.md) · [ADR-029](https://github.com/hieunt286/paseo-bm/blob/v0.5.6/docs/adr/ADR-029-missions-mains-and-a-process-governor.md) · [ADR-031](https://github.com/hieunt286/paseo-bm/blob/v0.5.6/docs/adr/ADR-031-orchestrator-decisions-grant-no-effects.md) · [ADR-032](https://github.com/hieunt286/paseo-bm/blob/v0.5.6/docs/adr/ADR-032-one-governor-a-mission-per-wake.md) · [ADR-033](https://github.com/hieunt286/paseo-bm/blob/v0.5.6/docs/adr/ADR-033-the-mission-is-the-system-of-record.md) · [ADR-034](https://github.com/hieunt286/paseo-bm/blob/v0.5.6/docs/adr/ADR-034-each-mission-has-its-own-workspace.md) · [Missions PRD](https://github.com/hieunt286/paseo-bm/blob/v0.5.6/docs/product/paseo-bm-missions-prd.md) · [Missions design](https://github.com/hieunt286/paseo-bm/blob/v0.5.6/docs/design/paseo-bm-missions.md) · [Mission runtime design](https://github.com/hieunt286/paseo-bm/blob/v0.5.6/docs/design/paseo-bm-mission-runtime.md)
