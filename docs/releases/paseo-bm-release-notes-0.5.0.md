# paseo-bm 0.5.0

**Calibrated autonomy: one coordinator for every project, questions you answer once, and one control per project for how much is decided without you.** This is the largest release since the plugin became the product. It adds a fourth agent, the **Beads Orchestrator**. Every question put to you is now one stored decision, the same card wherever it appears, answered once. Each project gets an **autonomy level**, from Hands-on to Full auto. The screens are rebuilt around an **Inbox**. A new or updated install decides nothing for you until you raise a project's level. Update with:

```bash
paseo plugin update paseo-bm
```

Then read [What to know when upgrading](#what-to-know-when-upgrading). Agents created on 0.4.x keep their old instructions, and two 0.4.x settings are retired.

## What changed

### The Beads Orchestrator: one coordinator for every project

- **One agent for the whole machine, started only by you.** Nothing of it exists until you press **Start…** in the Inbox header and confirm. It runs on a new role, `bm-orchestrator` (provider and model in **Settings → More → Agents**), in a workspace of its own: the folder `~/.paseo-bm/orchestrator/home`, which Paseo lists as a project named `home`. It uses tokens on that provider, and the masked content of every paseo-bm project goes to it.
- **It reads, through the plugin's own tools.** It sees where each request stands, the Workers' reports, the decisions, and the recent messages of paseo-bm's own agents, never another agent's. Secrets are masked as in the traces. It can check a claim with read-only `git` inside a project (status, what changed, the last commits, one file; never a secrets file). It keeps short notes per project, which carry over to a new Orchestrator. It has **no Paseo agent tools**: everything it sends goes through the plugin, which checks the authority at every send and records it.
- **It moves the work on, within your authority.** It tells a project's Manager what to do next. It may correct a Worker directly, and that Worker's Manager always gets a copy. It never writes to a Reviewer. A command goes out on one of three things:
  - a decision you answered;
  - your own latest message in its chat ("send it");
  - the project's autonomy level, when that level lets it decide every kind of decision the command touches.

  Each command is a `BM-COMMAND` block that declares its intent and effects, shown as an action card. A word in its chat never covers a push, publish, deploy, real data, a migration, a security change or a cost. A word check backs the declared effects up. A loop guard stops it at 12 commands per request in 24 hours.
- **It wakes on events, not on a timer.** In a project at **Co-pilot** or above, four things wake it: a request that finished with work left, a stalled request, a Worker signal, and a question the level asks it to decide or to propose an answer to. In every project, the coordination events below wake it too.
- **Coordination** (**Settings → Coordination**). The Orchestrator can step in three ways:
  - **Advice.** After every 5 finished requests of a project (0 turns it off), it reviews the project's figures. It brings you each change worth making as an Inbox decision, with the change ready on one option. The change applies only when you pick that option.
  - **Compaction.** It may have a Manager or a Worker **compact** its conversation when that conversation crosses a threshold. paseo-bm sends `/compact` at a safe moment, then restores what matters from its own records.
  - **Handoff.** It may have a Manager hand a request that grew too heavy to a **fresh Worker**. The new Worker re-proves every check before it reports anything done, and the old one stays in your list, marked replaced.

  Every intervention is logged with whether it worked. A compaction or handoff kind that misses too often switches itself off, and the Inbox says so; only you switch it back on.
- **It is yours.** paseo-bm never archives, stops or deletes it. An Orchestrator on older instructions, or one that lost its tools, is replaced by a fresh one at its next wake-up. After a day, when it is idle and you have not written to it for 2 hours, the next wake-up also starts a fresh one. The old one stays in your agent list.

### Autonomy: one level per project

**Settings → Autonomy** sets how much the Orchestrator may decide for you, as one level per project ([ADR-025](https://github.com/hieunt286/paseo-bm/blob/v0.5.0/docs/adr/ADR-025-autonomy-levels.md)):

| Level | The Orchestrator decides | Everything else |
|---|---|---|
| **Hands-on** (the default) | nothing | yours, as asked |
| **Co-pilot** | nothing | it proposes an answer on each card; you approve it |
| **Cruise** | technical, preference, scope, environment and dependency questions | proposed, for your approval |
| **Turbo** | as Cruise, plus cost, release and data | proposed, for your approval |
| **Full auto** | every question, security included | — |

- **Turbo and Full auto ask you to confirm every time you choose them**, with Cancel first. At those levels a push, publish, deploy, migration, real-data change or cost can be decided without you, and at Full auto a security trade-off too.
- **Everything decided for you is visible.** It shows in the Inbox under **Decided for you**, with who decided and why. **Override** takes an answer back, and your answer goes to the same agent. An override is recorded and never changes the level; you lower the level yourself.
- **From Co-pilot up**, a decision card's main button is the Orchestrator's proposal, with its reason. The asker's recommendation stays marked beside it.
- **A project's Metrics** show, per kind of decision, how often the asker's recommendation and the Orchestrator's proposal matched your answers. These figures are for your information: no threshold stands between you and a level.

### A question is asked once, and answered once

- **One decision, everywhere.** Every question to you is one stored record: a Worker's question, a decision the Orchestrator asks you, and an agent stopped by its provider plan. The Inbox, the Worker's chat and the Manager's chat show the same card. Answer it on any copy and all of them show it answered. The plugin delivers the answer to the asker at its next idle moment, and no agent relays it.
- **Options say what they allow.** Each option declares its effects (`push`, `migration`, …). An option may carry a prepared action, which runs once when you pick it, within an hour of your answer. An answer that allows a push, publish, deploy, real data, a migration, a security change or a cost asks you to confirm on the card, Cancel first.
- **Answer however is at hand.** Tap an option, write **Own words…**, answer the Manager in words, or answer in the Worker's chat. When the plugin cannot tell which question a chat message answered, the card says **Needs confirmation**: pick an option, **Close as answered** or **Keep open**.
- **Ask back.** On a Worker's open question or the Orchestrator's open decision, you can ask the asker something first. Its reply shows on the card, and the question stays open.
- **Precedents.** An answered question can be saved as a standing answer for that subject, in one project or in all of them, for 30 days by default. Manage precedents in **Settings → More → Precedents**. Agents created afterwards get the active precedents and follow them instead of asking.
- **A question re-asked supersedes the old card.** A question you never answered **expires** when its request finishes.

### Hold risky actions for approval (per project, off by default)

This is a new switch under **Settings → Autonomy**. You confirm when you turn it on and when you turn it off. It applies to the Claude and Codex Workers and Reviewers a project creates after you turn it on. They start in a mode that asks, and paseo-bm answers every request itself at once. Some actions are held: a push, publish, deploy, real-data change, dependency install, network call, write outside the project, or a command paseo-bm cannot read. A held action waits for you as one Inbox item with the command, **Allow once** or **Deny**, unless an answer you gave for that request or the project's level covers it. Ordinary work runs without asking.

- Agents that already exist keep their mode.
- OpenCode and other providers are not held. They keep detection only, as in projects with the switch off.
- The Inbox says when an agent of a held project runs without the hold.

See [ADR-019](https://github.com/hieunt286/paseo-bm/blob/v0.5.0/docs/adr/ADR-019-action-boundary-permission-events.md).

### Seeing the work, and noticing when it breaks

- **Inbox alerts, in every project, with or without the Orchestrator:**
  - **A request stalled.** It is not finished, none of your questions is open for it, and none of its agents has run for 5 minutes. A request with more review calls than its size's budget also counts.
  - **A Worker is in trouble.** It is stuck for 10 minutes, waiting on a permission for 3 minutes, or running a dangerous command.
  - **Two agents edited the same file** at the same time.
  - **A Worker or Reviewer was created by the wrong role.**
  - **An agent runs on older instructions.**
  - **A fallback failed.**
- **A cut turn is no longer taken for your stop.** When Paseo cuts an agent's turn short to deliver a message, Claude Code tells the agent that the user rejected its call. paseo-bm now recognises such a cut from what Paseo records, never from the words. A Manager or Worker left idle after one gets a `BM-INTERRUPTED` notice and carries on. Your own Stop, a new message from you, or a permission you deny is never taken for a cut ([ADR-024](https://github.com/hieunt286/paseo-bm/blob/v0.5.0/docs/adr/ADR-024-structure-tells-stops-and-waits.md)).
- **Evidence labels.** A Worker's claims are labelled *detected* (paseo-bm saw the check pass after the last edit, the file edited, the bead closed), *self-reported* or *unverified*. A request that changed code and finished without its checks seen to pass reads **Done — unverified**. While it stands so, the Orchestrator never commits or releases it on the project's level.
- **Why? ▸** on a request shows the chain behind it: its decisions, beads, changes, checks, reviews and each agent's turns. You can also ask the Orchestrator why a bead, a file or a decision exists.

### New screens

- **Beads Manager opens on the Inbox**, with **Inbox · Projects · Settings · Tools & skills**. These replace the Setup landing, the Workspaces list and the Metric screen. The Orchestrator's status is at the right of the header on every screen.
- **Projects.** One row per workspace shows the current request, its stage, its agents as **M W R** and the project's level. A project's page has five tabs:
  - **Overview.**
  - **Requests**: a stage bar, evidence lines, a timeline, cost and **Why?** per request.
  - **Beads**: the board.
  - **Metrics**: flow, cost, coordination, beads, autonomy by class and review lift.
  - **Agents.**

  Closed workspaces keep their history, as before.
- **Settings** has three parts:
  - **Autonomy**: the level, and the hold switch.
  - **Coordination**: the advice cadence, compaction, handoff, and the **review budget** per request size (2–8 calls; 2, 2 and 4 by default; only Workers created afterwards get new numbers).
  - **More**: Agents, Precedents and Data. Removal lives in Data.
- **Tools & skills.** Skills, with how many Worker reports named each one in the last 30 days. The agent tools of each role. `br` and `bv`.
- **Cards.** The cards are flat, all in one frame: who wrote to whom, on whose authority, one status, one main button, and **Details ▸**. A bar at a card's left says what kind it is: amber when it waits for you, red when something is held or failing.
- **Phone layout.** The whole management surface works at phone width without sideways scrolling, except a project's tabs and long filters.
- **Role markers.** Every paseo-bm agent's title now starts with its role: 🟣 M Manager, 🔵 W Worker, 🟠 R Reviewer, 🟢 O Orchestrator. This applies to agents created from now on. paseo-bm's own screens show titles without the marker.
- **Opening it.** The Command Center has **Open Beads Manager**, **Open Beads project** (replacing **Open Beads Metric**) and **Open Beads Inbox**. A workspace's **Beads** tab is now that project's page, opened on its Beads board.
- **A Reviewer on another model family.** When roles are created on a fresh install and a provider of another model family is signed in, the new Reviewer goes to that provider. **Settings → More → Agents** says when the Reviewer and the Worker share a family.

### How the agents behave

Each role's instructions were rewritten ([`plugin/roles/`](https://github.com/hieunt286/paseo-bm/tree/v0.5.0/plugin/roles)), and each role's Paseo tools are now limited by configuration ([ADR-020](https://github.com/hieunt286/paseo-bm/blob/v0.5.0/docs/adr/ADR-020-paseo-tools-policy-per-role.md)).

**Beads Manager**

- **It keeps the project's context.** A Worker's first message now carries a **Context** section, each item with its source: your goals for the project, your earlier decisions and precedents that bear on the request, and the other requests it may touch.
- **It keeps the work aligned.** When a Worker reports `received`, `beads-done` and `finished`, the Manager compares the work with your goals. When it goes against one (wider or narrower than asked, against a standing decision, in conflict with another request), it asks you one question with options. It never approves or rejects a technical choice.
- **It relays nothing.** The lettered list of waiting questions (`A6 a`) is gone. When you answer in words, the Manager writes a `BM-ANSWERS` block in its own reply and the plugin delivers it. It no longer answers a Worker's question in your place, not even a fact: it gives the fact to you, with its source.
- **New instructions it follows.** It acts on a `BM-COMMAND` as your word, within what the block approves and its limits. When the Orchestrator asks for a handoff, it creates the successor Worker. It is no longer allowed to kill or archive agents, answer permissions or change modes, by configuration as well as by instruction.

**Beads Worker**

- **It looks before it asks.** It reads your precedents first and follows one that answers the question, citing it.
- **Each question carries more.** It has a subject and a kind (scope, release, data, …), and each option says what it allows. A question asked again under a new number supersedes the old one. A question you have not answered stays open on its card. The Worker carries on with what the question does not touch and no longer asks it again at its next report.
- **A yes can come from a choice.** Besides a request that names the effect, a yes is now an option you chose that declares it, or a `BM-COMMAND` that approves it. Its five rules are unchanged. They are no longer described as the only barrier, because with the hold on, the plugin also stops actions.
- **It names its scratch folder literally** in each command and deletes it before its next report.
- **It writes each check exactly as it ran it**, so paseo-bm can detect it.
- **Its review budget comes from Settings.**
- **It takes part in a handoff.** It writes a handoff note when asked. As the successor, it re-proves every check.
- **Not every notice is a stop.** It treats `BM-INTERRUPTED` and a Reviewer's finish notice as no stop.

**Beads Reviewer.** The review rules are unchanged, in shorter instructions. It now has **no Paseo agent tools at all**: it cannot create, message or stop agents.

**Beads Orchestrator** (new). Three rules:

1. It changes nothing itself.
2. It acts only as far as your authority goes.
3. It states only what its tools show.

It answers you as **Situation / Done / Needs you**, in your language.

### Retired

- **The Metric screen**, **Setup** as the landing screen, the **Workspaces** list and **Open Beads Metric**. Their content is now in the Inbox, Projects and Settings.
- **Per-role additional instructions.** What you saved in 0.4.x (`role-extras.json`) is no longer read. Precedents take their place.
- **The question tools on cards.** Gone are **Reply to <role>**, **Use recommendations**, **Mark as answered** and the waiting pills above the Manager's chat. Decision cards replace them.
- **The fallback chain's Auto switch** ([ADR-022](https://github.com/hieunt286/paseo-bm/blob/v0.5.0/docs/adr/ADR-022-retirements-after-code-review.md)). A role's fallback is now **Ask me** or **Off**. To let a stopped agent be switched or wait without you, set the project to **Cruise** or above: environment questions are then the Orchestrator's.

## What to know when upgrading

- **Paseo 0.9.0 or newer**, as before (`requirements.paseo: ">=0.9.0"`). This release was built and checked on Paseo **0.9.2**, which we recommend: the hold, role-pairing alerts and context figures rest on behaviour measured there.
- **What the first open after the update writes to Paseo's configuration:**
  - It adds the missing `bm-orchestrator` role, the alias and the profile, with the same defaults as the others. No Orchestrator agent is created until you start one.
  - It writes an explicit Paseo-tools policy on each existing `bm-*` alias. Only that key changes: your providers, models and modes are kept. The Reviewer and the Orchestrator get no Paseo tools. The Manager and the Worker lose the tools no role should have: archive, kill, answering permissions, changing modes or labels, schedules and heartbeats. A Worker also cannot create or rename workspaces. Paseo applies the policy when an agent's session next opens, so existing agents get it too.
- **Agents created on 0.4.x keep their old instructions.** Paseo fixes an agent's instructions when it is created, and paseo-bm does not support older agents beyond replacing them:
  - The Inbox lists each live one as **on older instructions**.
  - For a Manager it offers **Replace Manager**, which starts a current Manager and opens it. The old one stays in your list.
  - Workers and Reviewers end with their request.

  It is best to update between requests, then replace each workspace's Manager.
- **Defaults after the update:**
  - Every project is **Hands-on**, and the hold is **off** everywhere.
  - The Orchestrator does not exist until you start it.
  - Once it runs, Coordination starts at advice every 5 finished requests, **compaction and handoff on**, and a review budget of 2, 2 and 4. Compaction and handoff act at any level without asking you. Turn either off in **Settings → Coordination** with one tap.
- **New Inbox alerts appear in every project even if you never start the Orchestrator**: stalled requests, Worker signals, older agents. Nothing is sent to any agent because of them.
- **Additional instructions are no longer used.** Their text stays in `~/.paseo-bm/role-extras.json` until you delete your data. Move a standing rule you still need into a precedent.
- **A fallback chain set to Auto now reads as Ask me.** **Settings → More → Agents** says so once.
- **Data folder.** Nothing is migrated, and traces from 0.4.x are read as they are. New folders appear as they are first needed: `decisions/`, `inbox/`, `autonomy/`, `coordination/`, `orchestrator/` and `handoffs/`. **Remove paseo-bm's settings…** (now under **Settings → More → Data**) deletes them with your data when you ask it to. It also removes the `bm-orchestrator` role. The Orchestrator agent and its `home` workspace stay in Paseo until you archive and remove them yourself.
- **Coming from a 0.3.x directory install:** run `npx paseo-bm@0.4.0` once, then `paseo plugin update paseo-bm`.

## Rollback

`paseo plugin update paseo-bm --version 0.4.1` installs 0.4.1 again. However, **0.5.0 does not promise a way back**: [ADR-022](https://github.com/hieunt286/paseo-bm/blob/v0.5.0/docs/adr/ADR-022-retirements-after-code-review.md) retired the guarantee that 0.4.1 reads what later builds write, and the downgrade was not tested for this release. The remedy for a fault in 0.5.0 is a patch release. If you go back anyway:

- **Your data folder is left as it is.** 0.4.1 knows nothing of the new folders (decisions, Inbox alerts, autonomy levels, precedents, coordination, the Orchestrator's files and handoffs). They stay on disk, unread. Traces and `role-extras.json` are where 0.4.1 expects them.
- **Agents created on 0.5.0 keep 0.5.0 instructions.** Those instructions rely on tools and notices 0.4.1 does not have. Start new Managers. An Orchestrator agent, if you started one, stays in Paseo without its tools: archive it.
- **The `bm-orchestrator` entries and the Paseo-tools policies stay in Paseo's configuration.** 0.4.1's **Remove paseo-bm's settings…** removes every `bm-*` entry, these included.

## Evidence

- `npm run verify` (typecheck, plugin typecheck, lint, 4,823 product tests, the bench and eval test runs, build) and `npm run smoke:packed` exited 0 on the tagged tree.
- The packed payload (`paseo-bm-plugin-0.5.0.tgz`, 259 files) was served through a registry mirror to isolated Paseo 0.9.2 daemons:
  - **Update from the real `0.4.1`:** `paseo plugin update paseo-bm` reported `0.5.0`, `running`, with clean logs. The roles, the Reviewer's chosen mode, the agent-tools grant and the role profiles from 0.4.1 carried over. The next open added the `bm-orchestrator` role and the Paseo-tools policies and left the other roles as they were. Nineteen read RPCs behind the screens (setup, roles, projects, traces, beads, Inbox, decisions, insights, autonomy, coordination, precedents, Orchestrator) answered without error.
  - **Fresh install:** the same checks passed, and a Manager it created was titled `🟣 M · Beads Manager`. **Remove paseo-bm's settings…** followed by `paseo plugin remove paseo-bm` left no `bm-*` entry in Paseo's configuration.
- **What is already recorded:**
  - **Field use.** This build has run on the owner's own daemon since 2026-10-01 00:28 UTC. It was installed from a frozen copy checked first on an isolated daemon, and reinstalled with each later change up to the role markers. The owner's projects ran through it.
  - **Pre-install check.** The frozen release candidate was checked on an isolated Paseo 0.9.2 daemon, Claude and Codex, with one project held and one not: `docs/archive/operations/paseo-bm-final-rc-check-20261001.md`.
  - **Live checks, one per phase,** on isolated Paseo 0.9.2 daemons, recorded in `docs/archive/operations/`:
    - decisions and Orchestrator wakes (`paseo-bm-phase1-live-check-20260929.md` and `-2-20260929.md`);
    - a decided class, a release class and a precedent (`paseo-bm-phase2-live-check-20260930.md`);
    - handoff and compaction (`paseo-bm-phase3-live-check-20260930.md`);
    - the hold (`paseo-bm-phase4-live-check-20261001.md`).
  - **Spikes and runs** that settled what Paseo does, in the same folder: permission events per provider, compaction per provider, context figures, role tools, role pairing.
- **Released before the programme's own gate closed, by the owner's decision.** The autonomy PRD (§10) plans a combined field period of at least 14 days and an evaluation of 0.4.1 against this build before release. The field period opened on 2026-10-01 and is still running, and the evaluation has not been run. Their results will be reported, and fixed in patch releases where needed.

## Sources

[Autonomy PRD](https://github.com/hieunt286/paseo-bm/blob/v0.5.0/docs/product/paseo-bm-autonomy-prd.md) · [Autonomy design](https://github.com/hieunt286/paseo-bm/blob/v0.5.0/docs/design/paseo-bm-autonomy.md) · [Orchestrator design](https://github.com/hieunt286/paseo-bm/blob/v0.5.0/docs/design/paseo-bm-orchestrator.md) · [Dashboard design](https://github.com/hieunt286/paseo-bm/blob/v0.5.0/docs/design/paseo-bm-dashboard.md) (§11) · [Technical Design](https://github.com/hieunt286/paseo-bm/blob/v0.5.0/docs/design/paseo-bm.md) (§5, §7) · ADRs in force: [ADR-017](https://github.com/hieunt286/paseo-bm/blob/v0.5.0/docs/adr/ADR-017-decisions-are-stored-objects.md), [ADR-018](https://github.com/hieunt286/paseo-bm/blob/v0.5.0/docs/adr/ADR-018-calibrated-autonomy-per-class.md) (in part), [ADR-019](https://github.com/hieunt286/paseo-bm/blob/v0.5.0/docs/adr/ADR-019-action-boundary-permission-events.md), [ADR-020](https://github.com/hieunt286/paseo-bm/blob/v0.5.0/docs/adr/ADR-020-paseo-tools-policy-per-role.md), [ADR-021](https://github.com/hieunt286/paseo-bm/blob/v0.5.0/docs/adr/ADR-021-orchestrator-measured-coordination-controller.md), [ADR-022](https://github.com/hieunt286/paseo-bm/blob/v0.5.0/docs/adr/ADR-022-retirements-after-code-review.md), [ADR-023](https://github.com/hieunt286/paseo-bm/blob/v0.5.0/docs/adr/ADR-023-delegation-without-eligibility.md) (in part), [ADR-024](https://github.com/hieunt286/paseo-bm/blob/v0.5.0/docs/adr/ADR-024-structure-tells-stops-and-waits.md), [ADR-025](https://github.com/hieunt286/paseo-bm/blob/v0.5.0/docs/adr/ADR-025-autonomy-levels.md) · [Role instructions](https://github.com/hieunt286/paseo-bm/tree/v0.5.0/plugin/roles) · [GUIDE.md](https://github.com/hieunt286/paseo-bm/blob/v0.5.0/GUIDE.md) · [0.4.1 notes](https://github.com/hieunt286/paseo-bm/releases/tag/v0.4.1)
