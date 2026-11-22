# paseo-bm guide

The complete reference for `paseo-bm`. For a short overview and the quick start, see the [README](README.md). For a guided tour, see [paseo-bm.erai.pro](https://paseo-bm.erai.pro).

## Contents

- [Before you install: read these warnings](#before-you-install-read-these-warnings)
- [Requirements](#requirements)
- [Install](#install)
- [Missions: one Main per goal](#missions-one-main-per-goal)
- [Working with the agents](#working-with-the-agents)
- [The Beads Manager screen](#the-beads-manager-screen)
- [Inbox: what needs you](#inbox-what-needs-you)
- [Projects: what each project and request is doing](#projects-what-each-project-and-request-is-doing)
- [Beads: the workspace's beads](#beads-the-workspaces-beads)
- [Settings](#settings)
- [Tools & skills](#tools--skills)
- [The Orchestrator: one coordinator for every project](#the-orchestrator-one-coordinator-for-every-project)
- [Trace storage](#trace-storage)
- [Everything paseo-bm writes](#everything-paseo-bm-writes)
- [Agent skills](#agent-skills)
- [Checking health](#checking-health)
- [Updating](#updating)
- [Removing paseo-bm](#removing-paseo-bm)
- [Coming from the `npx` install](#coming-from-the-npx-install)
- [Troubleshooting](#troubleshooting)
- [Known limits](#known-limits)

## Before you install: read these warnings

> [!WARNING]
> **1. Plugin trust.**
> Paseo plugins run **without a sandbox**. The paseo-bm plugin runs inside the Paseo daemon with the same access to your machine as the daemon itself: files, processes, credentials and network. Install it only if you trust this package. Paseo's own plugins switch is what allows any plugin to run at all; paseo-bm never writes it.

> [!WARNING]
> **2. Agent-creation permission: `daemon.mcp.injectIntoAgents`.**
> The Manager and the Worker need Paseo's tools to create, message and stop other agents. Paseo grants those tools to **every agent on this machine**, not only to paseo-bm's roles. Once the switch is on, any agent can create, prompt and stop other agents, which means it can start work and spend money on your model providers.
>
> Nothing turns it on for you. **Settings → More → Agents → Allow agent tools…** asks first, with that warning, and records what the switch was before so **Remove paseo-bm's settings** can put it back. Until you press it, Beads Manager does not start: an agent only gets Paseo's tools when it is created, so a Manager started before the switch was on could never create a Worker.

> [!WARNING]
> **3. Installing skills runs someone else's tool.**
> **Tools & skills → Install skills…** runs the third-party `skills` CLI, which downloads from [cuongntr/agent-skills](https://github.com/cuongntr/agent-skills) (another author's repository) and has its own data collection. The exact command is shown before it runs, and paseo-bm never writes to your skills folders itself.

> [!CAUTION]
> **4. Agent permission modes, and rules that only instructions enforce.**
> - **The Worker** is created in its provider's **no-prompt mode**: Claude `bypassPermissions`, Codex `full-access`, or the equivalent for other providers. Paseo does not ask you to approve its commands.
> - **The Reviewer** is created in **auto mode** (Claude `auto`, Codex `auto`), which does not grant full or network access. The plugin sets this itself when the Reviewer is created, and moves a Reviewer out of a full-access or planning mode even if the Worker asked for one.
> - **The Manager** runs in the mode of its `bm-manager` profile. Its instructions forbid changing anything itself (files, beads, code, configuration, builds, tests) and reading secrets. Paseo's tools to kill or archive agents and to answer permission requests are switched off for it. Nothing else holds it to its instructions, so choose the `bm-manager` profile's mode with that in mind.
>
> The Worker's limits — nothing leaves the workspace without your yes (no push, network, dependency install or real-data migration), nothing it did not create is destroyed, no secrets are read, no check is made to look green — come from its role instructions. In a mission, a Worker works in the mission's own worktree and commits there on the mission branch; it pushes that branch only after your one yes per mission and repository. **Hold risky actions for approval** (**Settings → Autonomy**, off by default) adds a check in code for a project's Claude and Codex Workers and Reviewers: a push, publish, deploy, real-data change, dependency install, network call, write outside the workspace or a command paseo-bm cannot read waits for you in the Inbox. With it off, such actions are only watched and reported after they ran. Review `git diff` before you merge.

> [!NOTE]
> **5. Agent conversation is recorded on this machine.** From the first turn after the plugin loads, it writes one record per agent turn into `~/.paseo-bm/traces/`, so **Projects** can still show a request after its agents are deleted. Records contain the text your agents sent and received, including anything quoted from your repository. Nothing is uploaded. See [Trace storage](#trace-storage).

> [!NOTE]
> **6. The Orchestrator governs; it grants nothing.** Nothing of it exists until you press **Start the Orchestrator…** in the Inbox and confirm. Then one agent for the whole machine reads the work of every paseo-bm project, secrets masked, on the provider of the Beads Orchestrator role, and uses tokens there. It governs how the missions run and speaks to each mission's Main. It never briefs, corrects or answers a Worker, never decides a Worker's question and never writes to a Reviewer. The one thing it may send a Worker is a stop: while a dangerous-command signal of that Worker is open, or when a mission's governor ladder reaches its last step. Its commands carry no effect, and no answer you give it grants one: a Worker's push, publish, deploy, real data, migration, security or cost comes only from your own answers and the project's level. Each wake-up uses tokens. See [The Orchestrator](#the-orchestrator-one-coordinator-for-every-project).

Your requests and source code go to the model providers you choose for each role. paseo-bm has no telemetry.

## Requirements

| Requirement | Detail |
|---|---|
| Operating system | macOS or Linux. Native Windows is refused. WSL reports itself as Linux but is not covered by testing. |
| Paseo | Paseo desktop at **0.9.0 or newer**, with its daemon running (which usually means the Paseo app is open). 0.9 is where Paseo learned to install a plugin from npm, which is the only supported install path. `plugin/paseo-plugin.json` declares `requirements.paseo: ">=0.9.0"`, so an older daemon refuses the plugin. |
| Beads tools `br` ([beads_rust](https://github.com/Dicklesworthstone/beads_rust)) and `bv` ([beads_viewer](https://github.com/Dicklesworthstone/beads_viewer)) | **Required for the agents**: the Worker manages beads with `br`, and agents use `bv`'s `--robot-*` views. You do not need them beforehand — **Tools & skills** installs a missing one after you confirm the command. |
| A logged-in agent provider | At least one provider Paseo offers (for example Claude or Codex), logged in with that tool's own login. paseo-bm never handles credentials and never runs a login command; **Settings → More → Agents** shows the command for you to run. |
| Network | Needed for Paseo to fetch the package, for the **Install skills** and **Install `br` / `bv`** buttons, and for the update check of `paseo-bm-plugin` on npm (once per local day). A Worker pushes a mission branch only after your yes. Nothing else reaches the network. |

No `sudo` is needed, and nothing is written to your machine until you open the plugin.

## Install

Needs Paseo 0.9.0 or newer. Paseo installs the plugin from npm:

```bash
paseo plugin add npm:paseo-bm-plugin
```

Nothing on your machine changes until you open the plugin: Paseo has no hook that runs at install
time, so paseo-bm does its setup lazily, the first time you open **Beads Manager** or its **Settings**.

### What happens the first time you open it

1. **The four roles are created**, if they are missing: the provider aliases `bm-manager`,
   `bm-worker`, `bm-reviewer`, `bm-orchestrator` and their agent profiles. No Beads Orchestrator
   agent exists until you start it from the Inbox (see
   [The Orchestrator](#the-orchestrator-one-coordinator-for-every-project)). The defaults are the first provider
   Paseo reports as available and that provider's first model. One exception: when a provider of another model family (the model's vendor: Claude is
   Anthropic, Codex is OpenAI) is also signed in, a new Beads Reviewer goes to the first such
   provider, so its review does not share the Worker's blind spots. When the Reviewer and the Worker
   share a family, **Settings → More → Agents** says so under the Reviewer.
   Existing entries keep your provider, model and mode; paseo-bm only keeps each role's Paseo-tools
   setting (`paseoTools`) as the role needs it. **Settings → More → Agents**
   is where you change them. What you set there is what a new Worker or Reviewer runs on, even
   when a Manager or Worker created earlier asks for the old model (and even for one you start by hand
   on `bm-worker` or `bm-reviewer` with another model).
2. **Settings and Tools & skills say what is still missing.** Each group under Settings → More,
   and the top of Tools & skills, says its state in one line, naming the problem — "Agent tools off", "Missing bv", "Worker skills (Claude) 3/5", a
   provider not signed in. Three steps are buttons, because each grants something and nothing runs
   before you press it:

   | Step | Where | What pressing it does | Why it needs a press |
   |---|---|---|---|
   | **Allow agent tools…** | Settings → More → Agents | Turns on Paseo's `daemon.mcp.injectIntoAgents` | The switch applies to **every agent on this machine**, not only paseo-bm's roles: any agent can then create, message and stop other agents. paseo-bm records what the switch was before, so removal can put it back. Without it the Manager cannot create a Worker at all. |
   | **Install skills…** | Tools & skills | Runs the third-party `skills` CLI once, with the exact command shown | It downloads from [cuongntr/agent-skills](https://github.com/cuongntr/agent-skills) (another author's repository) and that tool has its own data collection. paseo-bm never writes to your skills folders itself. It can take up to 5 minutes. |
   | **Install `br` / `bv`** | Tools & skills | Runs the beads tools' own documented install command | It downloads and runs someone else's install script. The exact command is shown first. |

   Anything merely *unknown* — a provider whose sign-in Paseo could not report — is not shown as a
   problem.
3. **Sign-in.** **Settings → More → Agents** lists each provider your roles run on and whether it is signed
   in. paseo-bm never runs a login command and never sees a credential: it shows the command that
   provider's own tool documents, and you run it.

## Missions: one Main per goal

A **mission** is one goal you name — "Ship card payments", "Upgrade the AI assistant" — with the repositories it needs. Each mission has a **Main**: a Beads Manager labelled with the mission, which works across all of those repositories. Many missions run at once, one per goal.

- **Creating one.** In **Missions**, choose **New mission** (the Command Center's **New mission** opens the same form): a name, a short code of 2 to 8 capitals or digits, starting with a capital (`XAI`), a goal, the repositories and a **mission level**. paseo-bm writes the mission and starts its Main. The Main drafts the rest of the charter with you — non-goals, done criteria, a rough budget — and you confirm it on a card.
- **Where it lives.** Paseo's sidebar shows one project, **Mission-List** (the folder `~/.paseo-bm/missions/Mission-List`), with one workspace per mission titled `<CODE> · <name>`. The mission's Main works in that workspace; another tab appears there only when you open one yourself or paseo-bm opens a successor for that mission. A Beads Manager you open yourself in a mission's workspace becomes its Main when the mission has none running; otherwise it is an extra chat paseo-bm leaves alone. The root workspace, **Mission-List**, holds a Main you open there before its mission has a name: it asks you the name, code, goal and repositories and records them.
- **Work in each repository.** A request lives in the repository of its Worker: its request id, decisions, autonomy level, action boundary and memory are that repository's. The Worker itself writes in the mission's own Paseo worktree of that repository, on the mission's branch (`m/<CODE>/<repo>`), so two missions never write one checkout. The Main creates Workers in any repository of its mission, several when the work splits; links two Workers that must agree so they talk directly; and records what they settle as a contract between repositories. A Worker that needs another repository asks its own Main, which links it to the Worker on that work or creates one. Mains of two missions talk on a link of their own.
- **One request at a time: the supervised line.** A mission runs one request at a time, across its repositories. A larger ask becomes an ordered list of steps, each with its acceptance criteria, which you approve once on one card. Each step starts by itself when the one before passed its finish gate: finished, reviewed where its size needs it, its checks seen to pass, its commit made. While a step runs, new work you ask for is held and runs next. Work runs side by side only on your explicit word ("in parallel"), which the Main quotes; a Worker answering another project's question for a running step also runs beside it. A failed gate, a stalled step or a stop halts the line, and the Main tells you what can be done. **Settings → Coordination → Supervised line** (on by default) turns this off for every mission: held work then starts when the request before it finishes.
- **Commits, pushes and merges.** A Worker commits its request's changes on the mission branch when it finishes. Pushing that branch and opening or updating its merge request waits for your one yes per mission and repository, asked on a card; the mission page shows it and lets you revoke it. A second yes per mission and repository lets a request that passed its gate move your local integration branch forward to its commit, by fast-forward only. Merging on the forge, tagging and any other push stay yours.
- **Two autonomy layers.** A repository's level (Settings → Autonomy) governs the work inside it, including which Workers' questions the request's Main decides for you. The **mission level**, 0 to 4, governs what the Main does on its own: going on to the next step (level 1), creating Workers (2), deciding Workers' technical questions (3), and adding repositories, deciding questions with effects and letting the governor split the mission (4). Above its level the Main asks you; a change of goal, name, budget or repositories is a card paseo-bm applies when you choose it.
- **One decider per question.** When a question opens, paseo-bm names who decides it — the Main (within the repository's level and the mission's delegation), the Orchestrator (only a provider-limit incident outside a mission, where the project's level delegates it), or you — and tells that decider at once. The Main's own answer never allows an effect such as a push or a migration: only your answer or the repository's level does. A fact only you know (a login, an id, a port) is always yours. The Main asks you its own questions as cards too, answered on the card or in its chat.
- **The mission is the record.** Every event that changes what is in flight — a follow-up, a report, a question and its answer, a link, a transfer, a Main replaced — is written to the mission: its roster, journal and decisions. A Main's context is compacted in place when it reaches 150,000 tokens or 60 % of its window, whichever comes first (the defaults), and it carries on from the mission's state; a new Main is created only when compaction cannot help, and its first reply says it took over and what is in flight. Nothing the mission holds is lost.
- **Project memory.** Each repository keeps a memory — your decisions and precedents, conventions and facts Workers settled, each with its source. The Main reads it into every Worker's brief and curates it; Missions shows it per repository.
- **Moving work between missions.** A request moves only on your card: a split, a merge of a one-repository mission into yours, or a Main asking to hand requests to another mission. Closing a mission waits only for a Worker running a turn; its open requests then read `stopped`. Only you close a mission.
- **Repositories from earlier versions.** A repository's existing Manager becomes the Main of a one-repository mission named after the repository, and keeps running where it is. When one of your own missions covers that repository, the Inbox offers to merge it. **Open Beads Manager** in a repository opens the Main of the mission that holds it — yours before a one-repository one.
- **Resting agents.** When Paseo closes a Main or a Worker but keeps its session, the agent rests. paseo-bm wakes it only for something it waits on — a report, an answer, your words — never just to inform it. A delivery that fails raises **A report or message could not be delivered** in the Inbox, the request reads `undelivered`, and the Main is told so it can send it again.
- **A repository outlives its workspace.** If a repository's workspace is archived in Paseo and you open its folder again, the new workspace counts as the same repository for its missions — same level, memory and branches — once paseo-bm can prove it: the folder is the one the mission recorded, and one of the mission's branches exists in its git. Later missions reach it the same way. When it cannot prove it, creating a Worker there is refused with what to do: open the repository's folder in Paseo.

## Working with the agents

### 1. Ask the Main

Open a mission's Main with **Open Main** on its page in **Missions**, from its workspace in the Mission-List project, or with **Open Beads Manager** in a repository's Command Center (the Main of the mission that holds that repository).

Describe the change in normal chat. The Main:

- **answers a question itself when it can read the answer** — where a request or a Worker stands, what the beads say, what a file or function does, what git shows — naming what it read and starting no Worker. It changes nothing itself: no file, bead, build or test;
- for a change, **creates one Beads Worker** in the repository the change belongs to, through paseo-bm. Your words about a running request go to that request's Worker; more work on a finished one becomes a new request, a continuation, with a new Worker. While a request runs, new work is held and runs next ([the supervised line](#missions-one-main-per-goal)), unless you say it should run in parallel;
- turns a larger ask into ordered steps with acceptance criteria, which you approve once on a card;
- passes your request on **verbatim** and adds no requirements of its own;
- **keeps the work aligned with your goals.** For a Medium or Large request outside an approved step, it compares the Worker's restated goal and acceptance with your words once, at `received`. When a request goes against your goals, it asks you on a card with options and a recommendation;
- **links Workers that must agree**, so they talk directly, and records what they agree as a contract. paseo-bm wakes a waiting Worker once what it waits on is settled;
- **answers a Worker's question itself only where your levels let it** (see [Settings](#settings)); the rest come to you;
- tells you the Worker and the request id (`req-<UTC time>`), and — once — any skills the Worker's tool is missing (the plugin checks them);
- replies in your language, in a few lines.

### 2. The Worker sizes the request

The Worker sizes the risk of what it designs itself — not the size of the diff, and not what you told it to carry out, which is your decision:

- **Large:** hard to undo, or it changes what others rely on — an interface, a format or stored data that other code or people consume, or a recorded decision. How something looks, reads or works inside is not one of these.
- **Small:** one clear, local change that is easy to undo and that a check can prove.
- **Medium:** everything else — several outcomes, an order between them, or work someone else may have to pick up.

The Worker tells you the size and the reason. You can override it; the Worker follows your choice. Documents do not follow the size: at any size the Worker writes a document only where the change overturns something recorded (a decision, a contract, a schema). A document that only describes what it changes is corrected in place as part of the change, without a question, and a Small request writes no new document.

| | Small | Medium | Large |
|---|---|---|---|
| Beads | none | written by hand | from a plan, or by hand |
| Review batches | none, unless you ask | the implementation | the documents and beads, then the implementation |
| Re-reviews per batch | while the blocking findings fall, at most 3 | same | same |
| Review calls per request (a cap) | 3, only for a review you ask for | 6 | 12 |
| Reports to the Main | `received`, `finished` | `received`, `finished` | `received`, `beads-done`, `finished` |

The figures are the defaults of **Settings → Coordination → Review**: 3 re-reviews per batch, and 3 review calls for each milestone batch a request may have (one for Small, two for Medium, four for Large).

**A request ends at `finished`.** More work on it opens a continuation: a new request linked to it, with a new Worker briefed from paseo-bm's records. A request that grows past the **Rollover** figures in Settings → Coordination finishes the bead in progress, reports `finished` with what remains, and goes on in a continuation.

Nothing waits for a confirmation before implementing; what cannot be undone still waits for your yes (below).

### 3. The Worker does only what you asked

- **Process follows what the Worker designs.** Beads, documents and reviews track and check a change the Worker designs. A request that needs none — an answer, or exactly what you already spelled out — gets none of them: the Worker does it and shows the result with its evidence. What you spelled out is also your yes, so it does not ask again. Any part that does need its design is handled like any change.
- **Anything beyond the request is a suggestion, not work.** Extra tests, refactors, docs, clean-ups and related bugs are listed as `Suggestion (not done): …`. The Main asks you whether any of them should become new work.
- A Small change has no bead: the Worker makes it, runs the check that proves it, and puts the command and its result in its report.
- Before creating a bead, the Worker looks for open beads with the same `feature:<slug>` label. It updates the closest match instead of creating a duplicate, and says which one it picked on its `decided` line.
- Every bead it creates carries a `feature:<slug>` label and a short `## Provenance` naming the request. The beads of a plan follow the `converting-plan-to-beads` contract (objective, scope in and out, components, validation, primary proof, reversibility, …); every bead holds **one outcome** that can be reviewed and reverted on its own; beads are never sized by file, line or bead counts.
- When it writes a plan it runs `reviewing-plan` on it and `polishing-beads` on the beads converted from it. These are its own quality passes: they never replace a Reviewer and are not review calls.
- It works on one bead at a time (with `implementing-beads` when there is more than one), runs the check that proves the bead, and **closes the bead with that evidence right away**. When all beads are closed, the implementation is reviewed once; a bead with a blocking finding is reopened, fixed and closed again with new evidence.
- **It decides what can be undone, and asks only four things.** Inside your request, choices it could reverse later — the approach, names, layout, test shape, the order of beads, whether a document needs updating — are its own; it lists them on its report's `decided` line so you can overturn any of them. It asks you only about the scope (widening, narrowing, adding a requirement), about what cannot be undone or an approved decision (editing a document the repository freezes, deviating from an approved decision, contract, requirement or plan scope — correcting what a document says about the thing it changes is not one of these, changing an existing bead's acceptance criteria, deleting or merging beads, changing an approved design because a Reviewer asked), about what only you have (something you must type or do, the environment, a security trade-off, behaviour existing users rely on), and when it is stuck. Questions it can already see come in one round right after sizing, as one numbered list (at most five) with options and a recommendation. For those it waits for your answer and never assumes one.
- It **asks you first** before installing or upgrading dependencies, using the network, running migrations on real data, deploying or publishing, editing frozen documents, widening the scope, or deleting or merging beads.
- Outside the repository it writes only into a temporary directory it has just created and deletes before reporting.
- **Five limits hold whatever the request:** nothing leaves the workspace without your explicit yes (push, pull request, deploy, publish, network, dependency install, real-data migration, elevated privileges; a commit too, except its own commit on a mission branch); nothing the Worker did not create is destroyed or touched, including the changes that were already in the tree and your agents; secrets are never read or copied; **no check is ever made to look green** — a test, an assertion or an acceptance criterion is never weakened so something passes, and a bead is never closed on a check the Worker did not watch pass; and nothing only you can decide is decided for you. You review `git diff` and decide.

### 4. A Reviewer checks each batch

Reviews are grouped in batches, one per milestone (see the table); documents are reviewed before implementing only for a Large request or when you ask, and a Small change is reviewed only when you ask. For each batch the Worker creates a Reviewer through paseo-bm, fixes the **blocking** findings and asks for a re-review, which a fresh Reviewer makes from the earlier findings and the diff of the fixes. Re-reviews go on while the blocking findings fall, up to the limit; then the Worker moves on and reports what is still open. It fixes a small non-blocking slip of its own; other non-blocking findings become suggestions. paseo-bm counts the review calls of each request and refuses one past the request's cap: it then asks you itself, on one card, whether to allow more.

The Reviewer checks each stage against criteria from the workflow skills: the PRD and design gates for documents, `reviewing-plan` (review-only) and the plan-ready gate for a plan, the leaf and readiness checklists for beads, and the split triggers and risk table of `implementing-beads` for the implementation. It may run the repository's tests and throwaway probe scripts, but it changes nothing, uses no network and installs nothing. For authentication, permissions, data or a public contract it lists the abuse and edge cases it tried. Hardening beyond your request is a suggestion, not a blocker, unless it is a real defect in what was built.

### 5. Reports, and when things finish

The Worker sends a structured `BM-REPORT` to the Main only at the moments listed in the table, plus `blocked` when it needs you and `stopped` when you stop it. Each report lists the skills the Worker used (`skillsUsed`). A `blocked` report's questions become **decisions**: one card per question in the [Inbox](#inbox-what-needs-you), in the Worker's chat and in the Main's, and your answer on any of them is delivered to the Worker by the plugin at its next idle moment (see [Questions and answers](#questions-and-answers)). The Main never approves or changes the Worker's plan itself. A Medium or Large `finished` that changed code carries what was run for real and what it showed, or why it could not run. The Main cancels a Worker that is stuck or off course, and tells you why. When a Worker finishes, the Main tells you how many decisions it made on its own (its `decided` line), any of which you can overturn. When you ask how the work is going, the Main reads the Worker's and its Reviewers' status and recent activity instead of asking the Worker.

**The agents work through paseo-bm's tools.** Each Main, Worker and Reviewer gets paseo-bm's own `bm_` tools: the Main creates and briefs Workers (`bm_create_worker`, `bm_tell_worker`), the Worker reports and asks (`bm_report`, `bm_questions`) and creates its Reviewers (`bm_create_reviewer`, `bm_rereview`), and the Reviewer gives its verdict (`bm_review`). Each tool checks its input against a schema and refuses what breaks it, so the agent fixes it in the same turn; paseo-bm then stores and delivers the result. The plugin serves these tools on `127.0.0.1` only, to paseo-bm's own agents on Claude, Codex or OpenCode, the providers Paseo can pre-approve a tool for.

When a Worker finishes, it stays idle for you to inspect. **paseo-bm archives finished Workers and Reviewers** that nobody touched for 3 days, at most once an hour: only when their request and its continuations are finished and nothing waits for them (no delivery, open question or link). **Settings → Coordination → Archive finished agents** turns this off or sets the window (1 to 30 days). Nothing is deleted: open an archived agent and send it a message to bring it back. Mains and the Orchestrator are never archived, and no agent archives or deletes another; the Main may only cancel a Worker's run.

### Message cards in the chat

In the chats of paseo-bm's agents, paseo-bm's own messages are shown as cards, all in one frame: who
sent it to whom and on whose authority, the time, one status chip, at most three lines, one main
button, and **Details** for the ids and the full message.

- **A decision** — one card per question a Worker asked you (`BM-QUESTIONS`), per question or
  mission change the Main asked you, per decision the Orchestrator asked you, per agent a provider
  stopped, and per action held for your approval (**Held action**, with **Allow once** or **Deny**).
  Its options are buttons, the recommended one marked **Recommended**, plus **Own words…**. In a
  project at **Co-pilot** or above, the request's Main proposes an answer: its option is marked
  **Main suggests**, with its reason on one line under it; you still decide. The card reads the decision from where paseo-bm
  stores it, so the same question shows the same state in the Inbox, the Worker's chat and the
  Main's: answer it once, on any copy. An answer that allows a push, publish or deploy, real data,
  a migration, a security change or a cost asks you to confirm right there, Cancel first. Chips say
  **Needs decision**, **Needs confirmation**, **Decided**, **Superseded**, **Withdrawn** or
  **Expired** — a Worker's question you had not answered expires when the Worker finishes its
  request ("The request finished."): it leaves the Inbox and can no longer be answered, so message
  the Worker if it still matters. A question the Main decided for you (the project's level
  lets it) reads "decided for you by the Main", with its reason under **Details**, and has
  no buttons: the first answer counts; take it back with **Override** in the Inbox.
  **Ask back** — on a Worker's question or the Orchestrator's decision that is still open, ask the
  asker something before you decide (**Ask the Worker** / **Ask the Orchestrator**, Cancel first).
  Its reply appears on the card under **Conversation**; the question stays open. A question that
  could not reach its asker says so and is kept.
  A question you answered that carries a subject offers **Save as precedent…**: your answer (you
  can edit it) becomes a standing answer for later questions on that subject, in this project or in
  all projects, for 30 days — you choose, Cancel first.
- **Progress, finished and verdict** — a Worker's reports to the Main (**Received**, **Working**,
  **Blocked**, **Finished**, **Stopped**) and a Reviewer's verdict (**Passed**, **Changes required**).
- **Brief** — the Main's instructions in a Worker's chat, and a Worker's review request in a
  Reviewer's chat.
- **Action** — a command paseo-bm delivered (below).
- **Notice** — every other notice of the plugin, as one compact line.

**Reading a card at a glance.** Cards are flat: square corners, thin borders, colour only in small
marks. A bar at a card's left says what kind it is — amber when it waits for you, red when something
is held or failing, grey for news; a settled card has none. A chip is a small coloured square and a
short word.

**Commands.** Every command paseo-bm delivers arrives as a `BM-COMMAND` block and shows as an action
card: who sent it to whom (the Orchestrator to a mission's Main, or a stop to a Worker; a handoff
reads **Coordination · handoff**), on whose authority, what it is for and its effects — **no
effects** for every command of the Orchestrator's. Its limits are under **Details**. In a Main's
chat, a copy of a stop the Orchestrator sent its Worker is a notice line. The card has no reply
box: the block is your word.

**The Orchestrator's events.** In the Orchestrator's own chat, the plugin's `BM-EVENTS` message is one
compact line; **Details** lists each event with its ids.

Only paseo-bm's own messages become cards: messages you type, ordinary replies, tool calls and other
agents' chats look as before, and the conversation itself never changes. For the beads of a chat,
open the **Beads in this chat** panel next to the agent. It lists the beads the chat named recently
(in messages and `br` commands), newest mention first, and opens each one in place.

### Questions and answers

A Worker asks only when it cannot decide (see above), all at once, each question with its options,
what each one allows (for example "push" or "migration") and one recommendation. You answer in
whichever place is at hand:

- **A decision card** — in the Inbox, the Worker's chat or the Main's chat. The plugin delivers the
  answers to the Worker at its next idle moment, all the answers of a request together, never into a
  running turn.
- **In words, to the Main.** The Main matches each answer to an open question and writes the
  answers in its reply; the plugin delivers them. An answer that fits no single question gets one
  short question back.
- **In the Worker's chat.** When the plugin cannot tell which question you answered, the card says
  **Needs confirmation**: pick an option as usual, or **Close as answered** if your chat message already answered it, or **Keep open**.

Not sure yet? **Ask back** on the card asks the Worker (or the Orchestrator, for its own decision)
your question; the reply shows on the card, and you answer when you are ready.

A question you have not answered stays open on its card; the Worker carries on with what it does not
touch and never picks a default for it. When the work changes a question, the Worker asks it again
under a new number and the old card says **Superseded**.

### Talking to the Worker, and stopping it

- **You can chat with a Worker directly** to clarify or redirect. Those messages appear in the request's timeline in Projects.
- **Stopping a Worker also stops its Reviewers.** When you press Stop on a Worker, the plugin cancels each of its running Reviewers with `paseo agent stop`. Only when that fails does it send the Reviewer a fixed stop notice instead, which takes one short turn to acknowledge. The Worker then reports `stopped`, saying where it stopped, and waits for you.
- **The review cap is enforced in code.** paseo-bm's review tools refuse a review call past the request's cap and ask you, on one card, whether to allow more. A Reviewer a Worker creates outside those tools raises an alert.

## The Beads Manager screen

Open **Beads Manager** in Paseo's sidebar. It opens on the **Inbox**, and a row of tabs switches
**Inbox · Missions · Projects · Settings · Tools & skills**. **Missions** lists every mission — its Main's state, level, repositories, live Workers, done criteria, questions for you and governor signals — and a mission's page shows its charter, level, governor, Workers by repository, **In flight** (each request's state and whom it waits on, the open questions by who decides, the Main's own questions to you, live links), the **Main** history (each Main, when and why it changed, and Open on a previous one), contracts, journal, plan and each repository's memory. The Inbox tab carries the number of things that need you
(as a count beside its name), and so does the **Beads Manager** sidebar item, which also shows an icon when an update is available. A slash command's notice and the state of the
last Manager launch show under the tabs, wherever you are.

Four Command Center items open it for you: **Open Beads Manager** (in a repository: the Main of the
mission that holds it, a one-repository mission created the first time), **Open Beads project** (in a
workspace: that workspace's page in Projects, on its Overview), **Open Beads Inbox** (anywhere) and
**New mission** (anywhere: the Missions screen's New mission form).

**The Beads tab.** Every workspace can also show its own page in a tab: open the **+** menu of the
workspace's tab bar (or press the **Beads** button on the workspace header; on a phone, the **Beads** pill above a paseo-bm agent's composer) and choose **Beads**. It is
the same project page as in Projects — **Overview · Requests · Beads · Metrics · Agents** — opened
on Beads, without a title or ←.

Two panels complete it: **Beads agents** (per workspace) shows the Manager → Worker → Reviewer tree
with each agent's status, and **Beads in this chat** (per agent) lists the beads a chat named — see
[Message cards](#message-cards-in-the-chat).

## Inbox: what needs you

The Inbox is read every 5 seconds while you look at it.

- **On a phone**, the header has two rows (the Orchestrator's status, then five equal tabs: Inbox, Missions, Projects, Settings, Tools), Settings picks the project from a list, and wide tables turn into rows; nothing needs a sideways scroll except a project's tabs and long filters.
- **The Orchestrator's status** is at the right of the header on every screen ("Orchestrator idle ·
  N projects watched"); press it to open the Orchestrator's chat. The Inbox lists what needs you per
  project, and the filter at the top shows All, Decisions, Actions (held actions) or Alerts. Before
  there is an Orchestrator the header shows **Start…**, which asks
  first, Cancel first — the provider · model, and "Reads the work of every paseo-bm project on this
  machine; uses tokens." — and creates it only when you confirm.
  When the Orchestrator lost its tools (it was started before paseo-bm restarted) or runs on older
  instructions, the header says why and offers **Start a new Orchestrator…**; the old one stays in your
  agent list. For a day after a new one replaced an older one, it says "New Orchestrator since 2 h
  ago — the old chat is no longer used." See [The Orchestrator](#the-orchestrator-one-coordinator-for-every-project).
- **Needs you** — every open decision, grouped by project, the oldest question first: a Worker's
  questions, the Main's questions and mission cards, the Orchestrator's decisions, held actions,
  and an agent stopped by its provider plan (switch to the fallback, wait for the reset, or handle
  it yourself). Each is the same decision card as in the chats
  ([Message cards](#message-cards-in-the-chat)). A card you answer stays in place, answered, until
  you leave the Inbox.
- **Decided for you** — when a project's or mission's level lets the Main decide, or you save a
  precedent, some decisions are answered without asking you. The Inbox lists the ones answered
  since you last looked: what was decided, then the project and by whom (the Main, the
  Orchestrator for a provider-limit incident, your precedent, or your policy for an action it let
  through) and why; tap a line for its details. **Override** takes one back: it returns to
  Needs you as your question, and your answer goes to the same agent and replaces the first one
  (work already done is not undone; the Worker is asked what changes). An override is recorded; it
  never changes the project's level — lower the level yourself if you want fewer decisions taken
  for you. Lines you have seen leave the list when you come back after a few minutes away; each
  project's Requests tab keeps every decision.
  Decided for you also lists what was done for coordination since you last looked — a compaction,
  a handoff, the Orchestrator telling a Main to fix the mission's process, a stop — with why, and
  whether it worked: Pending, Met, Missed or Unknown.
  These lines have no Override; tap a line for its ids.
- **Alerts** — one line each (what · project · time), details on a tap: a request that stalled, a
  Worker stuck, waiting on a permission or running a dangerous command, a Worker or Reviewer created
  by the wrong role, a Reviewer created outside paseo-bm's tools, an agent on older instructions
  (for a Main, **Replace Main** starts a current one; the old one stays yours), a fallback that
  failed (**Resend to Worker** when a switched Reviewer never appeared), two agents that edited one
  file at the same time (the file and the agents under Details; it clears when both requests
  finish), a report or message that could not be delivered, another project that has not answered
  an ask, compaction or handoff switched off below its target, an agent running without the action
  boundary, and your words restarting a Worker's turn instead of joining it. **Open Worker** /
  **Open project** where Paseo allows it.

With nothing open, the Inbox says so and offers **Open Projects**.

## Projects: what each project and request is doing

**The projects.** One row per workspace, most recent activity first: its name and one line with its
active and stalled requests and its autonomy level (`2 active · 1 stalled · Cruise`, `idle ·
Hands-on`; **Hands-on** when nothing is set). Rows are read every 10 seconds while the list shows. Below
them, **Closed workspaces with history** lists workspaces archived or removed from Paseo that still
have recorded requests, with their last name, path, last activity and history size.

**A project's page** has **Open Manager**, **Memory** (the project's memory), **Autonomy: <level>**
(which opens Settings) and five tabs, opening on Overview.

**Overview** — requests in the last 30 days, turns by role, tokens read, how many decisions wait on
you, tokens by role, the open requests (three, then "N more open requests in Requests"), **All
requests ▸**, and the project's autonomy level, which opens Settings.

**Requests** — the newest request opens first; each request shows:

- a **stage bar**: Received ▸ Plan ▸ Build ▸ Review ▸ Done, the current stage bold, marked
  *waiting* while it is blocked on you. A stage that cannot be told is not drawn;
- **evidence lines** taken from the Worker's reports: the plan, the checks, files and beads it
  claims — each labelled *detected ✓* (paseo-bm saw it: a check passing after the last edit, the
  file edited, the bead closed), *reused* (a check the request's records show passing earlier, which
  counts as verified), *self-reported* (only the report says so) or *unverified* (the
  report says nothing ran) — the last review verdict and the decisions still open. When a request
  that changed code finishes without every check it names seen to pass or reused, the stage bar reads
  **Done — unverified** and its finished card in the chat **Finished — unverified**, both in amber;
  while it stands so, a commit or release on it is yours to decide: no level, Main or Orchestrator
  decides it for you. A new finish whose checks are all seen ends it;
- **Timeline ▸** — what happened, newest first: what you asked, the hand-over to the Worker, its
  reports, reviews asked and their verdicts, your messages and the Main's replies, decisions asked,
  answered and closed (a Worker's question you had not answered reads "The question expired when the
  request finished."). Only events that can be read are drawn;
- the request's cost, **Open Worker ▸**, **Why? ▸** — the chain behind the request, in order: its
  decisions, beads, changes (with commits), checks, reviews and each agent's turns; each link is
  found, none (with why) or missing (with why), anything replaced says "replaced by", and it reads
  once when opened and again on Refresh — and **Details ▸** with the ids and **Delete this request's
  history**.

**Beads** — the board ([below](#beads-the-workspaces-beads)).

**Metrics** — how the project's work goes, read once when you open it (and on **Refresh**), for 7,
30 or 90 days or all time:

- **A strip of figures:** beads closed, lead time (median), requests, tokens per request and turns.
- **Bead status**, **Closed per day**, **By feature** and **Tokens by role**.
- **How the work ran:** this project's figures beside those of all projects.
- **Orchestrator interventions:** how the coordination steps turned out, per kind.
- **Tokens per request** and the heaviest requests.
- **Autonomy by class:** how often the recommended option, the Orchestrator's and the mission
  Main's proposals matched your answer, per class of decision — the agreement, how many answers, from which day to which, and
  how many were reversed — with who decides each class now. It counts every answer recorded,
  whatever the window. The figures are for your information; the level is set in **Settings →
  Autonomy**.
- **Review lift:** per size of request — reviews per request, blocking findings per batch, how many
  of the findings a first review found were fixed by the next one, and tokens per review.

What could not be counted is said in one line.

**Agents** — the Main → Worker → Reviewer tree.

**A closed workspace's page** starts with **History of a closed workspace**: delete its history (older
than 30 days, or all) and, when Paseo no longer has the workspace, move the history onto one that
exists. Each action first shows what would go and asks, Cancel first. A closed workspace has no chat.

**Numbers say how sure they are.** A value from a Worker's own report is shown plainly; one worked out
from the timeline is marked *(inferred)*; anything that cannot be established is left out rather than
guessed. Durations are wall-clock and include time spent waiting for you. Every screen writes them the
same way (`12 s`, `3 min 5 s`, `1 h 20 min`, `2 d 3 h`) and times as `15:40` today, `yesterday 15:40`,
or `Thu 24 Sep 15:40`, in your device's time zone.

**Costs are estimates, not an invoice.** Cost is estimated from the tokens of each turn with a price
table shipped in this version. Cached input tokens are priced at the cache rate. A model that is not
in the table shows tokens only, never a guessed price. The session totals some providers report are
not used, because they cannot be split per request.

## Beads: the workspace's beads

The Beads board reads `.beads/issues.jsonl` in the workspace directly. It **never writes the bead
store**. Bead status, beads closed per day and beads by feature are in the project's **Metrics**.
At the top, `✓ <closed> / <total> done`.

**The board**

- The board comes first: **In progress**, **Ready**, **Open epics** and **Deferred**, then
  **Blocked** when a bead is blocked and **Closed** when you show it, each column with its count.
  Closed beads are hidden by default; tick **Show closed (N)** to show them. That choice lasts until
  you reload the app.
- **Feature** — a row of the project's `feature:` labels above the board, one press to filter by one.
- **Filter · Sort** unfolds search by id or title; filters by status, type, priority and labels (grouped by
  category, the part before `:` such as `feature:`, most common values first); and the sort (updated,
  created or closed time, or priority). Active filters stay in sight as chips you can remove.
- Filters apply first, and the sort applies inside each column. An empty column says **Nothing
  here**. Each column shows its first 100 beads and says how many more it did not show.
- **The board follows the width.** Wide enough for two columns or more and they sit side by side;
  narrower — a phone, or a slim window — and you get one column at a time, picked from a row of
  status tabs that carry the counts.
- Each row shows the bead's id, then its title. The line below gives its priority, type and first
  label that is not a feature; for a bead in progress, who works on it; for a closed one, when it
  closed; for an epic, how many of its children are closed.
- **Beads in progress say who is on them:** the Worker, since when, and whether that Worker is
  running, idle or gone. This comes from the recorded Worker commands (`br update <id> --status
  in_progress` or `--claim`) and reports. When no such command was recorded, the board says so and
  shows the Worker's last activity instead of guessing.

**Detail**

Press a bead to see who is working on it (with a button to open that Worker), its description rendered as Markdown, its labels, its dependencies and children, and its close reason. Three actions are available, each confirmed first. What an action reported stays on the bead even when the next refresh moves it to another column; a confirmation you had open but not answered closes when the bead moves.

| Action | What happens |
|---|---|
| **Ask Manager to implement** | The Main gets the request and a Worker implements the bead until it is closed with evidence. |
| **Delete…** | A Worker checks whether the bead is still needed. It deletes it with `br` only if it is not, and reports why either way. |
| **Close…** | A Worker checks the acceptance criteria and what the bead depends on. It closes the bead with evidence only if both are satisfied, and otherwise reports what is missing. |

A closed bead offers only **Delete…**. Each action is sent to the workspace's Manager as a normal request (a Manager is created if the workspace has none). It follows the usual size rules, reports and review cap, and appears in Projects like any other request.

## Settings

At the top, **Updates** (the installed and latest version, **Check for updates** and **Update now**;
see [Updating](#updating)) and **Release notes** (the notes of each version, with a link to the
release on GitHub). Then three parts:

- **Autonomy** — how much a request's Main may decide for you, as one **level** per project (a tab
  per project, with its level). A mission's own level can let its Main answer more. You can change it
  at any time; a new install is Hands-on everywhere.

  | Level | The Main decides | Everything else |
  |---|---|---|
  | **Hands-on** | nothing | yours, as asked |
  | **Co-pilot** | nothing | it proposes an answer on each card; you approve in the Inbox |
  | **Cruise** | technical, preference, scope, environment and dependency questions | proposed, for your approval |
  | **Turbo** | as Cruise, plus cost, release and data | proposed (security), for your approval |
  | **Full auto** | every question, security included | — |

  Under the levels, the nine kinds of decision show who decides each at that level: **Main**
  (it decides, you can override), **You approve** (it proposes, you approve) or **You**. **Turbo**
  and **Full auto** ask you to confirm every time you choose them — they let the Main decide
  releases, pushes, deploys, migrations on real data and spending (and, at Full auto, security)
  without you — with **Cancel** first. Every answer taken for you shows under **Decided for you** in
  the Inbox, where you can override it; an override is recorded and never changes the level. A
  project whose kinds were set one by one reads **Custom** and shows them as they are until you
  choose a level. The Orchestrator decides only a provider-limit incident outside a mission, where
  the project's level delegates environment questions.

  **Hold risky actions for approval** (under the level; off by default; you confirm either way)
  holds a project's Claude and Codex Workers and Reviewers before an action leaves the workspace:
  those created after you turn it on run in the least permissive mode, and a push, publish, deploy,
  real-data change, dependency install, network call, write outside the project — or a command
  paseo-bm cannot read — waits for you as one Inbox item with the command, **Allow once** (release,
  data and security ask you to confirm) or **Deny**, unless an answer you gave for that request or
  the project's level covers it. You can also answer in Paseo's own prompt. Ordinary work runs
  without asking; agents that already exist keep their mode, and turning it off does not strand the
  ones created while it was on. The Inbox says when an agent of such a project runs without it.
- **Coordination** (open) — how paseo-bm runs the work, for every project, one card each:
  - **Compaction** and **Handoff** (both on by default): whether paseo-bm may, on its own, compact a
    Main's or a Worker's conversation, or hand a heavy request to a fresh Worker, and at which
    thresholds (a Claude turn is judged by its tokens read, a Codex or OpenCode turn by how full its
    context is). A Main is compacted at **Compact a Main at** even with compaction off. Turning one
    off is one tap; turning it on asks you first. If one misses its goal too often — fewer than 8 of
    its last 10 — paseo-bm switches it off and the Inbox says so; only you turn it back on.
  - **Rollover** (on by default): the figures past which a request finishes and goes on in a
    continuation — closed beads, Worker turns, tokens read, context — and the factor at which it
    finishes at once.
  - **CI** (off by default): whether a merge request's pipeline counts as evidence. Off, verified
    means a check paseo-bm saw pass, and no agent waits on a pipeline.
  - **Supervised line** (on by default): one request at a time per mission, and held work starts
    on a passed finish gate ([Missions](#missions-one-main-per-goal)). Off: held work starts when
    the request before it finishes.
  - **Archive finished agents** (on, 3 days by default): see
    [Reports, and when things finish](#5-reports-and-when-things-finish).
  - **Review**: the re-reviews per batch (3 by default) and the review calls each milestone batch
    adds to a request's cap (3 by default), with the cap per request they make.

  **Reset coordination to defaults** fills every card with its default; each card's **Save**
  applies it, and the switches stay as they are.
- **More**, each folded to one line that says its state:
  - **Agents** — each role's provider, model, thinking and mode, with an Edit form, and its fallback
    chain where one is offered (the Orchestrator has none, and like the Reviewer it is never offered
    a full-access or planning mode); sign-in per provider with the command to run yourself; Paseo's
    agent tools and **Allow agent tools…**. What you set applies to agents created afterwards. A
    fallback chain's policy is **Ask me** or **Off**; to have a stopped agent switched or kept
    waiting without asking you, set the project to **Cruise** or above: a mission request's Main
    then resolves it (the Orchestrator, for a request outside a mission).
  - **Precedents** — your standing answers: the subject, the project (or all projects), the answer,
    and until when it holds (30 days by default). A later question on that subject, of any kind,
    gets the answer without asking you. **End** stops one (you confirm, Cancel first). **Add
    precedent…** writes one yourself: a project or all, the subject a question carries (shown under
    a decision's **Details**), and the answer. A new precedent on the same subject and project
    replaces the old one.
  - **Data** — the data folder and how it was found; **Trace storage** per workspace with its size,
    where you can delete history and, for a workspace Paseo no longer has, move it onto one that
    exists; the version; and **Remove paseo-bm's settings…**.

## Tools & skills

What your agents can use, on one screen:

- **Skills** — each required and optional agent skill, whether each agent has it, any problem, and
  **Used**: how many Worker reports named it in the last 30 days, in every project ("—" for none). A
  skill the reports name but paseo-bm does not check is listed after, "not checked by paseo-bm".
  **Test** checks again; **Install skills…** and the command to copy ([Agent skills](#agent-skills)).
- **Agent tools by role** — what Paseo's agent tools let the Manager and the Worker do and whether
  the last one had them, and paseo-bm's own tools per role (the Orchestrator's as "<n> tools · read,
  command, decide, compact, handoff").
- **Command-line tools** — whether `br` and `bv` are on the PATH the Paseo daemon uses, their
  versions, **Install** for a missing one (after you confirm its command; updates are a command to
  copy).

## The Orchestrator: one coordinator for every project

The **Beads Orchestrator** is one agent for the whole machine that you chat with. It is the missions' **governor**: it checks how each mission runs against its charter and speaks to the mission's Main, never around it. The work itself is the Main's to run.

**The figures.** paseo-bm computes each mission's figures from its stores, against the thresholds in its settings, in five families: **mess** (several Workers on one area, two writers on a file, repeated questions, dropped deliveries), **overengineering** (documents and beads growing past the charter's need, tier inflation, requests at their review cap), **drift** (Main turns or finished requests that move no done criterion, work outside the charter), **stuck** work (stalls, unanswered links, old cards; a request waiting on another request of its mission is waiting, not stuck) and **budget**. The mission page shows them.

**The ladder.** A family whose figures cross is recorded in the mission's journal. If it is still crossed, paseo-bm itself nudges the Main with the numbers. If it is still crossed after a window (30 minutes and 5 Main turns by default), the Orchestrator is woken to ask the Main to re-plan; after that it asks you, or stops a Worker. Mess and drift are only recorded and shown; they are never nudged.

- **One per machine, in a workspace of its own.** paseo-bm creates it only when you press **Start the Orchestrator…** in the Inbox and confirm; after that, **Orchestrator chat ▸** opens the same agent. It does not live in one of your projects: its workspace is the folder `~/.paseo-bm/orchestrator/home`, which Paseo lists as a project named `home`. The folder holds no code, only a short `README.md` saying what it is.
- **What it reads.** Only paseo-bm's own data, through tools the plugin gives it: each mission with its charter, roster, figures and ladder, where each project stands, one request in full, the decisions and their answers, and the recent messages of one paseo-bm Manager, Worker or Reviewer — long enough to read a question with all its options — never another agent's conversation. Everything goes through the same secret masking as the traces. The tools reach it when its provider is Claude, Codex or OpenCode.
- **It checks for itself.** When a report says "tests pass" or "it's committed", the Orchestrator can look: a read-only tool shows a project's `git status`, the summary of what changed, the last 20 commits, or one file — only inside that project's folder, never a file that holds secrets (`.env`, keys, credentials). The tool cannot change, fetch or push anything.
- **It keeps notes.** It keeps one short note per decision, preference or standing instruction of yours: per mission, or in a project's memory. They survive a new Orchestrator.
- **What it cannot do.** It has no Paseo agent tools: everything it sends goes through the plugin, which checks the target and the authority at every send, runs the word check ([below](#big-decisions)), sends the command as a `BM-COMMAND` block with its limits, and records it. Its commands carry no effect, and no answer you give it grants one. It never briefs, corrects or answers a Worker, never decides a Worker's question, and never writes to a Reviewer. It runs in the mode the Reviewer would get (never a full-access or planning mode) and, like the Reviewer, keeps its provider's own shell and file tools; that it changes no file, bead or setting rests on its instructions.
- **It costs tokens.** Every conversation and wake-up uses tokens on the provider of the **Beads Orchestrator** role (`bm-orchestrator`, set in Settings → More → Agents), and the masked content of every paseo-bm project goes to that provider. Only the events listed [below](#what-it-does-on-its-own) wake it; the figures, the ladder's first steps and the watch call no model. Nothing is created and nothing is spent until you start it.
- **It is yours.** paseo-bm never archives, stops or deletes it. An Orchestrator started with older instructions, or one that lost its tools, is replaced by a new one the next time paseo-bm wakes it; the Inbox's Orchestrator line says so and offers **Start a new Orchestrator…** at once. When it is idle and you have not written to it for 2 hours, a wake-up also starts a fresh one once it is a day old, has had 10 wakes or has touched 4 missions, so its conversation stays short; its notes carry over. The old one is renamed "Beads Orchestrator (retired)" and stays in your agent list for you to archive.

### Talking to it

Open **Orchestrator chat ▸** and write as you would to a colleague: "How does the payments mission stand?", "What is the Checkout request waiting for?" It answers in its chat and does what you say, within its limits. Ask it for advice at any time: it reads its findings and asks you about each change worth making, with the change ready on an option.

- **Its questions to you.** When something is yours, it asks with a decision in the Inbox: the question, its recommendation, and two to five options, sometimes with a command to a Main ready on one. Picking that option sends the command at once; it grants nothing. A change of settings on an option is applied only when you pick it yourself. Your own words go to the Orchestrator, which acts on them. **Ask back** on its card asks it something first; it replies on the card.
- **Stopping a Worker.** It may stop a Worker only while that Worker's dangerous-command signal is open or a family of its mission is at the ladder's last step, and only on an authority: your latest message in its chat (one **you** typed in the app, never a plugin notice or its own message), a decision of its that you answered, or the project's level at **Cruise** or above. The Worker's Main gets a copy.

**A command goes to the Main.** paseo-bm delivers it as a `BM-COMMAND` block that the Main's instructions read as your word, and that its chat shows as an [action card](#message-cards-in-the-chat). An idle Main gets it at once; a working one when its turn ends. A governor's command looks like this; paseo-bm appends the figures it names, with their thresholds:

```
BM-COMMAND
from: orchestrator
via: chat
to: manager
requestId: none
re: Governor: replan, mission PAY
intent: other
effects: none
authority: governor:replan
approved: none
limits: no-commit-push-deploy, no-real-data

Three Workers changed the payments module this week. Re-plan the remaining work as one step.
```

It says what the command is for (`intent`), what it lets the agent do (`effects`, always none for the Orchestrator's), on whose authority, and which of those effects the authority covers (`approved`). The `limits:` line keeps the fixed limits: no commit, push or deploy, and no touching real data.


### What it does on its own

- **It wakes for a mission's events only.** A re-plan come due on the ladder, a conflict between two missions over one area, work outside a mission's charter, a mission's periodic review (every 10 finished requests, or a budget at 50 % or 100 %), a split a Main suggested on your yes, and a mission Worker's dangerous command. It wakes for one mission at a time, with that mission's brief, at most once per mission every 15 minutes (a dangerous command excepted), as one `BM-EVENTS` message at its next idle moment; an event whose subject was settled meanwhile is dropped.
- **What it does with them.** It asks the Main to re-plan, with the figures and the charter line; gives a disputed area one owner, with a reason both Mains read (a call that changes a mission's goal becomes your card); notes work outside the charter, and asks you on a change of goal; and for a split, creates the new mission's Main when the mission's level delegates it, else opens your card.
- **paseo-bm watches the Workers while they work.** Every 2 minutes it reads the recent activity of the running Workers of every project (at most 5 per pass, no model call) and, once per Worker turn, raises one of six signals with the evidence:

  | Signal | Raised when |
  |---|---|
  | Stuck | the Worker has shown nothing new for 10 minutes |
  | Waiting on a permission | a permission prompt has waited 3 minutes |
  | Dangerous command | a push, publish or deploy, destructive SQL, or `rm -rf` of `/`, `~` or a folder outside the project |
  | Same command failing | the same command failed 3 times in the turn |
  | Heavy process on a Small request | a Small request creates beads, or writes a plan or an ADR |
  | Writing outside the workspace | a file edited outside the project's folder |

  Stuck, waiting on a permission and dangerous command are **alerts** in your Inbox, in every project, until they clear. A push the mission's integration yes covers raises no dangerous-command signal. A mission Worker's dangerous command goes to its Main first, as a `BM-SIGNAL`; the Orchestrator hears of it 3 minutes later if the alert still holds. The other signals no longer wake it. paseo-bm itself never stops anyone.
- **Stopping a Worker.** A **Dangerous command** signal opens a 10-minute window in which the Orchestrator may stop that Worker in the middle of its turn, on the authority described in [Talking to it](#talking-to-it). Outside that window, or the ladder's last step, it cannot interrupt a Worker.
- **The limits hold whatever it decides.** Every command it sends carries no effect and the `limits:` line.
- **Loop guards.** The governor's commands to Mains — paseo-bm's nudges and the Orchestrator's own — are counted per mission in 24 hours, each kind in its own pool: 6 nudges, 3 re-plans, 4 arbitrations and 4 others by default. Its other commands, such as a stop, count against at most 12 for one request in 24 hours; past that it has to ask you.

**Why something exists.** Ask the Orchestrator why a bead, a changed file or a decision exists: it reads the chain behind it — the request, its decisions, beads, changes, checks and reviews — without changing anything.

**Compaction.** When a Main's or Worker's conversation crosses the thresholds in **Settings → Coordination**, paseo-bm itself compacts it; no model asks for it and the Orchestrator is not woken. paseo-bm sends `/compact` at a safe moment (after a Worker's report, or when a Manager is idle), then a `BM-STATE` note restoring what matters from paseo-bm's records — the request, your words, the decisions, the report's facts. The agent's chat shows both (the note as "State restored after compaction"); they are paseo-bm's, not yours — Projects does not show them as your words — and a `/compact` you type yourself stays yours. Inbox → Decided for you lists it with whether it worked. Turning compaction off in Settings stops it at once.

**Handoff.** With handoff on in **Settings → Coordination**, paseo-bm itself hands a request that has grown too heavy to a fresh Worker: the old Worker writes a short note, paseo-bm builds a brief from its records and creates the successor under the request's Main, which is told — the request keeps its id. The old Worker stays in your list, marked replaced, and paseo-bm tells it in its chat ("Handed over to another Worker") to stop; it is not archived then. The request's timeline shows "Handed over to Worker 2 from Worker 1" and the command card reads "Coordination · handoff". A successor's finish is verified only by checks it ran itself. Turning handoff off stops a pending one at its next step.

**Advice.** Each mission's periodic review (every 10 finished requests, or a budget at 50 % or 100 %) wakes the Orchestrator to read the mission against its charter; you can also ask it for advice in its chat at any time. A change it suggests — a precedent, a level, a coordination setting such as the review figures — is an option on a decision in the Inbox, and paseo-bm applies it only when you pick that option yourself: your policy, a precedent or the Orchestrator never answers it.

### Big decisions

Push, publish or deploy, real data, a migration, a security change and a cost are **big decisions**. The Orchestrator's commands never carry one, and no answer you give it grants one: a Worker gets such an effect only from your own answer to its question, or from the project's level at **Turbo** (release, data, cost) and **Full auto** (security too) — levels you confirmed — and each such answer shows under Decided for you.

As a backstop, before a command of the Orchestrator leaves, paseo-bm also reads its subject and instructions for words of five kinds:

| Kind | Words such as |
|---|---|
| Security and permissions | security, permission, authorization, impersonate, token, secret, password, credential |
| Release: push, deploy, publish | push, deploy, publish, release, production, merge into main |
| Data: migrations, real data | drop table, truncate, delete from, migration, real data, production data |
| Cost | billing, cost, pricing, paid, subscription |
| New dependencies | npm install, pnpm add, yarn add, a new dependency, license |

(Vietnamese words for the same things count too.) A word with a "not", "no", "never", "don't", "without", "avoid" or "stop" up to four words before it in the same sentence — "do not push", "without deploying", "stop the push" — does not count. Since its commands declare no effect, a match stops the command: nothing is sent, and the Orchestrator is told to ask you instead. The check is a word rule, so a harmless mention ("the security page") also comes to you; it never lets a matching command through. Nothing switches the word check off.

A wrong command costs a Main turn, not your data: you can always overrule it by writing to the Main yourself.

### Stalled work

paseo-bm looks once a minute at the recorded traces and the agent list — no conversation is read and no model is called — at every request with activity in the last 24 hours. A request stalls when it is not finished, has no question of yours open, and none of its Workers and Reviewers has run for **5 minutes**, or when it has more review calls than its cap. Waiting for you means a question in the Inbox: a Worker that says it is blocked after you answered everything stalls like any other. A request that waits by structure on something still live — a running Reviewer, another request with a live Worker, a link to another project that is still within its time — does not stall. It becomes a **Request stalled** alert in your Inbox, once, and clears on progress: a report, a review result, a bead closed. A request waiting for your answer is not stalled: its question is already in the Inbox.

When Paseo cuts an agent's turn short to deliver a message (an agent it created finishing, for example), Claude Code tells the agent that the user rejected its call, and the agent may stop to wait for you. paseo-bm recognises such a cut from what Paseo records, never from the words: a Manager or Worker left idle after one gets **BM-INTERRUPTED**, saying the cut came from Paseo, not from you, and carries on. Your own Stop, your new message, or a permission you deny is never mistaken for one. A stall no longer wakes the Orchestrator; it counts in the mission's **stuck** figures.

### What the Orchestrator reads

It reads your projects through its tools — the missions and their figures, the requests, their reports and questions, the agents' recent messages, the repository read-only — not through flags. One rule stays: a request with **more review calls than its cap** (3, 6 and 12 for Small, Medium and Large at the defaults) is a stall (above). Other process figures — a Small request with heavy process, a Medium or Large request without a review, an agent that failed its first turn, a malformed report, a reply in another language — are measured across requests by the replay (`npm run eval:replay`, *Process* figures).

### Its data, and cleaning up

- **On disk:** `~/.paseo-bm/orchestrator/` — the commands it sent, the open 10-minute allowances to stop a Worker, the governor's ladders, its notes and its `home` folder; its decisions are in `~/.paseo-bm/decisions/` with the Workers' questions ([the full list](#the-data-folder-paseo-bm)).
- **In Paseo:** the **Beads Orchestrator** agent and its `home` workspace, created only by your confirmation of **Start the Orchestrator…**. paseo-bm never archives or deletes them; archive the agent and remove the workspace in Paseo when you no longer want them.
- **Remove paseo-bm's settings…** removes the `bm-orchestrator` role with the other three, and — if you also choose to delete the data — the whole `~/.paseo-bm/orchestrator/` folder. The agent and its workspace in Paseo stay until you remove them.

## Trace storage

Records live in `~/.paseo-bm/traces/`: one directory per workspace, one file per month. Directories are `0700` and files are `0600`. Secrets are masked before anything is written.

- **paseo-bm never deletes traces on its own.** There is no retention period, no rotation and no automatic clean-up. When the store grows past a threshold, **Settings → More → Data** warns you.
- **You can delete** one request (its **Details** in Projects), and every trace older than 30 days or every trace of a workspace (**Settings → More → Data → Trace storage**, or a closed workspace's page in Projects). Settings → More → Data also reminds you that this history holds your agents' conversation.
- **Every deletion shows first** how many traces and how many bytes will go, and how many of those requests are still running. It then asks you to confirm, and the safe answer is the default.
- **Deletion is irreversible.** There is no undo and no bin.
- Deleting traces removes only paseo-bm's own recording. Your beads, documents, agents and Paseo conversations are untouched.
- Updating paseo-bm never deletes the store.

**Closed or removed workspaces keep their history.** It appears under **Closed workspaces with history** in Projects. If you remove a workspace from Paseo and later open the same project again, Paseo gives it a new workspace id. The old history's page offers to **move** it onto a workspace that exists, or you can delete it. paseo-bm never makes that link on its own, because two workspaces on the same path are not necessarily the same line of work.

### The storage warning threshold

Set it in Paseo settings → **Beads Dashboard**. The default is 200 MB. Paseo stores plugin settings per machine, so **this threshold applies to every workspace on this machine**. A value that is not a positive number is refused, and the previous threshold stays in force.

## Everything paseo-bm writes

This is the complete list: the data folder, Paseo's configuration, and — for missions — Paseo
workspaces and git in your repositories (end of [Paseo config](#paseo-config-paseoconfigjson)).
paseo-bm writes nowhere else.

### The data folder: `~/.paseo-bm/**`

The plugin owns this folder and creates it when it first needs it, with mode `0700`. It is found in
three steps, stopping at the first that yields a path: the environment variable `PASEO_BM_HOME` (must
be absolute), the pointer `~/.paseo-bm/home.json` (written only by the migration command, when your
old install home was somewhere else), then `~/.paseo-bm`. A candidate that is, or contains, your home
directory, Paseo's directory or an agent configuration directory is refused — and paseo-bm then
stops rather than quietly using the default, which would split your data across two places. **Settings →
Data** shows the folder it is using and how it was found.

| Path | What it is |
|---|---|
| `~/.paseo-bm/traces/` | The recorded requests Projects shows: `meta.json`, plus one directory per workspace with `meta.json` and `events-<YYYYMM>.jsonl`. **Your data**: an update never touches it. Delete it from Projects or Settings → More → Data. |
| `~/.paseo-bm/decisions/` | One file per workspace with every decision put to you — a Worker's questions, the Orchestrator's decisions, a stopped agent's incident — with its options, your answer, what it allowed and what was delivered. Open ones are always kept; of the settled ones, the 500 newest. `decisions/threads/` holds the **Ask back** conversations, secrets masked: the newest 20 lines per decision, 500 decisions per workspace. Your data. |
| `~/.paseo-bm/inbox/alerts.json`, `inbox/seen.json` | The Inbox's alerts — open ones, and the 500 newest cleared ones — and when you last looked at the Inbox. |
| `~/.paseo-bm/autonomy/policy.json` | Your autonomy levels from Settings → Autonomy, kept as who decides each kind of decision per project and when you set it, whether answers are proposed there, and whether risky actions are held. No file means Hands-on everywhere. Your data. |
| `~/.paseo-bm/autonomy/precedents.json` | Your precedents, saved from a decision card or in Settings → More → Precedents: for each, the subject, the project (or all), your answer, the decision it came from, when it was saved, until when it holds and what replaced it. Every active one is kept, and the 500 newest ended, expired or replaced ones. Your data. |
| `~/.paseo-bm/coordination/settings.json` | Your choices in Settings → Coordination: compaction, handoff, rollover, CI, the supervised line, archiving finished agents, the review figures and the governor's thresholds, and which of compaction or handoff switched itself off. A missing file reads as the defaults. |
| `~/.paseo-bm/missions/` | The missions: `index.json` (with the repository aliases), and per mission `<id>.json` (charter, plan, contracts, its Mains, its workspace, its worktrees and lanes per repository, and your push and local-merge yeses), `<id>.roster.json` (its requests and their Workers), `<id>.journal.jsonl` (what happened, the newest 5,000 lines), `<id>.decisions.json` (its cards: the Main's questions, mission changes, merges, transfers), `<id>.held.json` (the work held to run next); `autonomy.json` (each mission's level); `checkpoints.json` and `placement-mode.json` (the move of older missions into worktrees); `Mission-List/` (the Mission-List project: a `README.md` and one folder per mission, the workspaces of the Mains). Your data. |
| `~/.paseo-bm/memory/` | Each repository's project memory, one file per repository: decisions, precedents, conventions and facts with their source. Your data. |
| `~/.paseo-bm/requests/`, `outbox/`, `peers/` | The request registry per repository (request ids, their Main and mission, review calls), the deliveries between agents stored before they are sent (`outbox/`, so a reload loses none), and the links between Workers and between missions (`peers/links.json`). |
| `~/.paseo-bm/handoffs/` | One file per handoff: the request, the outgoing Worker and its Manager, the reason, the outgoing Worker's note and the brief (secrets masked), and how far it got. |
| `~/.paseo-bm/updates/check.json` | The latest `paseo-bm-plugin` version on npm and when it was checked (once per local day). |
| `~/.paseo-bm/role-extras.json` | Additional role instructions saved with an earlier version. Never read now; deleted with the data by **Remove paseo-bm's settings…**. Your data. |
| `~/.paseo-bm/role-fallback.json` | Your fallback chains from Settings → More → Agents: each role's policy and fallback entries (provider, model, thinking, mode), plus optional detection `patterns` you edit by hand. Your data. |
| `~/.paseo-bm/role-fallback-state.json` | The fallback incidents: each agent that stopped on its provider plan, what was chosen on its card, and the replacement. At most 200 are kept. Your data. |
| `~/.paseo-bm/orchestrator/` | The Orchestrator's files: `proposals.json` (every command the Orchestrator sent, with its authority — your policy, a decision you answered or your word in chat — and whether it was delivered; the 200 newest), `stalls.json` (each open 10-minute allowance to stop a Worker; at most 500), `notes/missions/<mission id>.json` (its notes on a mission; older `notes/<workspace id>.json` notes on a project are still read, the 20 newest), `governor.json` (each mission's ladder), `wakes.json`, `dangers.json`, `interventions.json`, `compactions.json` and `arbitrations.json` (its wakes, the dangerous-command signals, the coordination steps and their outcomes, the compactions and the conflicts between missions, each with its newest entries), and `home/` (the Orchestrator's own workspace, with a `README.md`). Files an earlier version wrote there are ignored, and deleted with the folder. Your data. |
| `~/.paseo-bm/ui/` | Small files of the plugin's own: `budget-told.json` (which review-cap overruns were announced), `agent-tools.json` and `orchestrator-endpoint.json` (the port and the secret of the agents' tool endpoint), `agent-bindings.json` (which agent each tool token belongs to), `missions-home.json` (the Mission-List workspace), and `setup-state.json` (what setup has done: which roles were created, whether paseo-bm turned Paseo's agent tools on and what they were before, the last skills run, and whether you removed paseo-bm's settings). |
| `~/.paseo-bm/home.json` | A pointer to a data folder somewhere else, written **only** by `npx paseo-bm@0.4.0` when it migrates an install that used `--home`. Delete the file to drop the pointer. |

Files a 0.3.x install left behind — `install.json`, `plugin/<version>/` and `backups/` — are read by
nothing and never deleted by paseo-bm. You can delete `plugin/` and `backups/` by hand. Other files
earlier versions wrote and this one no longer reads are ignored and deleted with your data by
**Remove paseo-bm's settings…**.

Every write goes to a temporary file first, is `fsync`ed and then renamed into place, with mode
`0600` and a check that no component of the path is a symlink. A run killed mid-write can leave a
`*.tmp-*` file beside its target; it is safe to delete.

### Paseo config: `~/.paseo/config.json`

paseo-bm **never** edits this file itself. Everything below goes through Paseo's own API
(`config.patch`), and every write is read back afterwards.

| Key | What paseo-bm writes | When |
|---|---|---|
| `agents.providers.bm-manager`, `agents.providers.bm-worker`, `agents.providers.bm-reviewer`, `agents.providers.bm-orchestrator` | A derived provider `{ extends, label, paseoTools }` that reuses your existing provider login, with no command and no environment. `paseoTools` is off for the Reviewer and the Orchestrator, and on for the Manager and the Worker with the tools to kill or archive agents and answer permissions switched off | Created when missing, the first time you open Beads Manager or its Settings. An entry that already exists keeps your provider, model and mode; only its `paseoTools` is set back to the role's, on every `bm-*` entry, fallbacks included. |
| `daemon.agentProfiles[]` entries whose `id` starts with `bm-` | The role's provider, model, name and notes, appended at the end. Other profiles and their order are left untouched. | Same as above; afterwards, only when you save in Settings → More → Agents. |
| `agents.providers.bm-<role>-fallback-<n>` (n = 1…3) | A derived provider for each entry of a role's fallback chain | When you save a fallback chain in Settings → More → Agents |
| `daemon.mcp.injectIntoAgents` | `true`; the previous value is recorded in `ui/setup-state.json` first | **Only** when you press **Allow agent tools…** and confirm. Set back to the recorded value by **Remove paseo-bm's settings**. |

**Only on your click, in Paseo:** **Start the Orchestrator…** (in the Inbox, once you confirm) registers `~/.paseo-bm/orchestrator/home` as a Paseo workspace and creates one agent there, the Beads Orchestrator. Both are yours afterwards.

**For missions, in Paseo and in your repositories:**

- **The Mission-List project** and one workspace per mission, where its Main works.
- **A worktree per mission and repository**, created through Paseo at the mission's first Worker there, on the branch `m/<CODE>/<repo>` off the repository's integration branch (lanes get `m/<CODE>/<repo>-<n>`). When every lockfile matches, paseo-bm clones the root's `node_modules` and `.nx/cache` into it copy-on-write, unless the repository's own `worktree.setup` prepares them. When a repository leaves the mission or the mission closes, you get a card to archive its worktrees; archiving stays yours.
- **Git writes of the plugin itself:** a finished lane fast-forwarded into the mission branch in the mission's worktrees; your local integration branch fast-forwarded to a passed request's commit, only with your local-merge yes; and, only on your tap on its card, a checkpoint commit on a `bm/checkpoint-<date>` branch that saves an older mission's uncommitted work (your HEAD, index and working tree are not touched). A review snapshot is git objects only, with no commit or branch. Nothing is ever pushed by the plugin.
- **Archiving finished Workers and Reviewers** after the window in Settings → Coordination ([Reports, and when things finish](#5-reports-and-when-things-finish)).

`pluginsEnabled` and `plugins` belong to Paseo: paseo-bm never writes either. The migration command
`npx paseo-bm@0.4.0` writes only `<install home>/install.json`, `<install home>/ui/setup-state.json`
and `~/.paseo-bm/home.json`, and calls `paseo plugin remove|add` — it does not touch `config.json`.

### What paseo-bm never writes

- **Agent skills.** paseo-bm only reads skills directories. Skills are put there by the third-party `skills` CLI, and only when you press **Install skills** and confirm.
- **Beads tools.** paseo-bm does not write `br` or `bv` itself: it runs Homebrew or the projects' own install scripts, after showing you the command.
- Credentials and provider logins: never read, stored or printed. paseo-bm does not run login commands.
- Plugins, providers or profiles created by you or by other tools. Only `bm-*` entries belong to paseo-bm.
- Your repository's files, from the plugin: the Beads board and Metrics only **read** `.beads/issues.jsonl`, and the plugin's own git writes are the ones listed above. Changes to your files come from the agents you ask for work.
- Other agents in Paseo. paseo-bm archives only its own finished Workers and Reviewers (above), never deletes an agent, and removal leaves them all in place.

## Agent skills

The Worker follows the **feature-workflow** process, which comes from a set of agent skills. paseo-bm runs without them, but **the Worker's results are noticeably worse without them**, so paseo-bm checks for them. Role instructions take precedence over any skill.

- **Source:** https://github.com/cuongntr/agent-skills. This is **another author's repository** (`cuongntr`). paseo-bm does not bundle, maintain, fork or patch these skills.
- **Required skills** (checked and warned about): `feature-workflow`, `reviewing-plan`, `converting-plan-to-beads`, `polishing-beads`, `implementing-beads`.
- **Optional skills** (suggested only): `architecture-premise-audit`, `authoring-workspace-protocol`.
- **Where paseo-bm looks** (read-only): `~/.agents/skills`; Claude Code's `~/.claude/skills` (follows `CLAUDE_CONFIG_DIR`); Codex's `~/.codex/skills` (follows `CODEX_HOME`); Pi's `~/.pi/agent/skills`; OpenCode's `~/.config/opencode/skill`. Symlinked skills count as present. Only names are compared, not versions.

When required skills are missing, **Tools & skills** shows the exact command and an **Install
skills…** button. Pressing it asks once more, then runs that command — and only that command, which
is a constant: nothing you type reaches the shell. The run has a 300-second limit, its output is
shown with secrets masked, and the screen records when it last ran and with what exit code. The command:

```bash
npx -y skills add cuongntr/agent-skills -g -a claude-code codex -s feature-workflow reviewing-plan converting-plan-to-beads polishing-beads implementing-beads -y
```

You can also run this command yourself; Tools & skills has a Copy button for it.

- **Skills are installed as symlinks**, so all your agents share **one copy** of each skill.
- **The `skills` CLI is a third-party tool with its own data collection.** paseo-bm's no-telemetry promise does not cover it.
- A failure, a timeout (300 seconds) or a missing network is reported in Tools & skills and changes nothing else. The agents keep working, with lower quality.
- paseo-bm never removes skills, and removing paseo-bm does not touch them. Remove them with the `skills` CLI (`npx skills --help`).

The plugin checks the Worker's required skills for the provider the Worker runs on, and the Main tells you once, with the command to add them, if the Worker will run without them. It still hands over the work.

## Checking health

**Settings** shows the plugin's health while it is
running: the four roles and their models, Paseo's agent-tools switch and who turned it on, each
provider's sign-in, the required skills per agent, `br` and `bv`, the data folder and how it was
found, and which kind of install this is.

If the plugin does **not** load at all, Settings cannot tell you anything. Ask Paseo instead:

```bash
paseo plugin ls
paseo plugin logs paseo-bm
```

## Updating

**Settings → Updates** checks `paseo-bm-plugin` on npm once per local day, or when you press
**Check for updates**. When a newer version exists, **Update now** asks you to confirm, then runs
`paseo plugin update paseo-bm` and the plugin reloads. Nothing is installed without that
confirmation. You can also run it yourself:

```bash
paseo plugin update paseo-bm
```

Your data folder is never touched by an update: traces, fallback settings and the setup state all
stay. Your `bm-*` entries in Paseo's configuration keep any provider, model or mode you changed
yourself. A missing role is created the next time you open Beads Manager or its Settings, and no
Orchestrator agent exists until you start it. Agents created by an earlier version run on older
instructions: the Inbox lists them as alerts (**Replace Main** for a Main); Workers and Reviewers
simply end with their request.

Downgrading is not promised ([ADR-022](docs/adr/ADR-022-retirements-after-code-review.md)): an
earlier version may not read what a later one wrote, and agents created on a later version keep
instructions that rely on its tools. If a release breaks something for you, the way back is the
next patch release.

## Removing paseo-bm

Two steps, in this order.

1. **Settings → More → Data → Remove paseo-bm's settings…**, then confirm. This removes every `bm-*` provider and
   agent profile from Paseo (the four roles and their fallback aliases) and, if paseo-bm turned
   Paseo's agent tools on, puts that switch back to what it was. A second, separate question asks
   whether to delete the plugin's data as well; the default keeps it.
2. **Remove the plugin:**

   ```bash
   paseo plugin remove paseo-bm
   ```

Why two steps: Paseo has no hook that runs when a plugin is removed, so nothing of paseo-bm's can
run at that moment. If you skip step 1, the `bm-*` providers and profiles stay in your configuration
and the agent-tools switch stays as it is; you can put the plugin back and press the button, or
delete those entries in Paseo's own settings.

What the button never touches: agents you already created, the Mains and the Beads Orchestrator
included, and the workspaces in Paseo — the Orchestrator's `home`, the Mission-List project and the
mission worktrees (archive or remove them yourself — an agent fails on its next turn without its
role); the mission branches in your repositories; your skills, `br` and `bv`; and anything in the
data folder that paseo-bm did not create (`install.json`, `plugin/`, `backups/`, `home.json`, and
anything you put there). One file always survives, even when you ask for the data to be deleted:
`ui/setup-state.json`, because it records that you removed the settings — without it, one plugin
reload before step 2 would create the four roles again.

Skills are removed with the `skills` CLI, not by paseo-bm.

## Coming from the `npx` install

If you installed paseo-bm before 0.4.0, the plugin on your machine is a **directory install**: Paseo
points at `~/.paseo-bm/plugin/<version>/`. It has two problems. It never updates by itself, and
installing the npm package on top of it is refused by Paseo with exactly:

```
Plugin ID "paseo-bm" is already configured; choose another ID with --id
```

**Do not choose another id.** Two copies of paseo-bm would both create roles and both inject
instructions into your agents. The one supported fix is to run this once:

```bash
npx paseo-bm@0.4.0
```

That is all the `paseo-bm` command does in 0.4.0, and 0.4.0 is its last release. It removes the
directory plugin, installs `npm:paseo-bm-plugin` at the same version, and — if that fails — puts the
directory install back exactly as it was. Your data folder, your roles and Paseo's switches are left
alone; it marks `install.json` as migrated and, when your data folder is not `~/.paseo-bm`, writes
the pointer `~/.paseo-bm/home.json` so the plugin can still find it.

Afterwards, `~/.paseo-bm/plugin/` and `~/.paseo-bm/backups/` are read by nothing and you can delete
them by hand. Deleting `~/.paseo-bm/home.json` drops the pointer.

### Exit codes

| Code | Meaning |
|---|---|
| `0` | Migrated, or there was nothing to migrate (already on npm, or no directory install), or a preview without `--apply` in a terminal |
| `2` | The command, subcommand or flag does not exist in 0.4.0 (`E_COMMAND_RETIRED`) — `install`, `doctor`, `uninstall` and the 0.3.x flags are gone |
| `3` | A precondition failed: Paseo older than 0.9.0, no daemon, no `paseo` CLI |
| `5` | `E_CONFLICT`: the registered `paseo-bm` plugin is not one paseo-bm installed |
| `6` | No terminal and no `--apply` |
| `7` | `E_PLUGIN_LOAD_FAILED`: the npm plugin would not start, and the directory install was put back |

## Troubleshooting

Start at **Settings**: each group's line shows what is wrong, and the group the reason. If the
plugin does not load at all, Settings cannot help — ask Paseo with `paseo plugin ls` and
`paseo plugin logs paseo-bm`.

**Beads Manager does not appear in Paseo**

- `paseo plugin ls` — check a plugin's `status` (`running` or `disabled`), not its `enabled` field.
- `paseo plugin logs paseo-bm` shows Paseo's reason.
- Paseo's own **plugins** switch is Paseo's, not paseo-bm's: with plugins off, no plugin code runs at
  all. Turn it on in Paseo's settings.
- On a Paseo older than 0.9.0 the plugin is refused on purpose (it declares `>=0.9.0`). Upgrade
  Paseo.

**Beads Manager will not open, or the Manager cannot create a Worker**

Almost always Paseo's agent-tools switch. While it is off, opening Beads Manager stops with `Paseo's agent tools are off…` instead of starting a Manager that could never create a Worker. **Settings → More → Agents** says `Off — no new Beads Manager starts until you allow them` and offers **Allow agent tools…**. A provider's own `paseoTools` setting is not enough: the
machine-wide switch is what grants the tools.

Otherwise, check the Worker's provider is signed in (**Settings → More → Agents → Sign-in** shows the command)
and that its model still exists in Paseo. The Main reports the exact cause when creation fails.

**`E_SETUP_ROLES_FAILED`**

paseo-bm could not create its four roles. The message says why: `Paseo reports no available
provider` means no provider is usable yet — sign in to one, then press **Try again**. `Paseo lists no
model for <provider>` means that provider is available but has no models. A refused patch is Paseo
declining the write; `paseo plugin logs paseo-bm` has the detail.

**`E_DATA_HOME_UNAVAILABLE`**

paseo-bm cannot use its data folder, so history and settings are off. **Settings → More → Data** shows
the reason. Usually `PASEO_BM_HOME` is relative or points somewhere paseo-bm refuses (your home
directory, or inside Paseo's or an agent's directory), or `~/.paseo-bm/home.json` is not valid JSON.
paseo-bm deliberately does not fall back to the default here: that would split your data in two.

**`E_SETUP_WRITE_FAILED`**

Paseo refused a configuration write, or did not keep it. paseo-bm reads every write back and does
not write again on its own. Retry; if it persists, check `paseo plugin logs paseo-bm`.

**`E_SKILLS_INSTALL_FAILED` or `E_SKILLS_PRESENT`**

`E_SKILLS_PRESENT` means Claude Code and Codex already have every required skill. `…_FAILED` shows
the command's exit code and its last lines — run the command yourself to see the whole output. A run
that passes 300 seconds is reported as a timeout.

**`E_TRACE_STORE_UNWRITABLE`**

The trace store could not be written. Most often a symlink somewhere on the path of the data folder,
which paseo-bm refuses to write through, or a regular file where a directory should be.

**The Worker cannot create or update beads**

**Tools & skills** shows whether `br` and `bv` are on the `PATH` the Paseo daemon uses (which can
differ from your terminal's) and installs a missing one after you confirm. A script install puts the
tool in `~/.local/bin`; add that directory to the daemon's PATH if the warning says so.

**A request in Projects shows little, or has no request text**

Recording starts at the first turn after the plugin loads, so a request that began earlier is only
partly recorded. A request whose agents were deleted still shows what was recorded, with a note.

**The Beads board is empty**

The workspace has no `.beads/issues.jsonl`, or the workspace is no longer listed by Paseo (see
[Known limits](#known-limits)).

**Migration problems**

See [Coming from the `npx` install](#coming-from-the-npx-install) for the exit codes. Exit `7` means
the npm plugin would not load and your directory install was put back — nothing was lost; read
`paseo plugin logs paseo-bm` before trying again.

## Known limits

- **Many rules for the agents are instructions, not code.** "Only do what was asked", the Worker's five limits (unless **Hold risky actions for approval** is on) and the Main's limits depend on the model following its role instructions. Code enforces the review cap, one request at a time per mission, who decides each question, where the Orchestrator's commands may go and, with the action boundary on, the risky actions of Claude and Codex Workers and Reviewers.
- **Stopping a Reviewer falls back to a notice** when `paseo agent stop` fails; the Reviewer then takes one short turn to stop.
- **Beads of a closed workspace are not shown.** Its request history is still readable from **Closed workspaces with history** in Projects.
- **Costs are estimates** from a bundled price table.
- **Only paseo-bm's own messages become chat cards**; a Worker's ordinary chat text stays plain (use the **Beads in this chat** panel for its beads).
- **The Orchestrator is one model's view.** It reads your projects through bounded tools; the replay's process figures are worked out again from the recorded traces every time, so they can change when agents are deleted; its language check tells only Vietnamese from English. That it changes nothing rests on its instructions, as the Reviewer's behaviour does; the plugin enforces where a command may go, when it may be sent, that it carries no effect, its limits, when a Worker may be stopped mid-turn, and the word gate — a word rule, which stops a harmless mention and cannot catch a risk put in other words. The live watch looks every 2 minutes at 5 Workers at most, so a short dangerous command can finish before anyone looks. A Claude Worker's timeline does not carry a command's exit code, so **Same command failing** is not raised for Workers on Claude. The word gate also reads the Orchestrator's own stop commands: "Stop the push" passes, but a stop whose text also names the risky command with no negation before it ("how many git push runs did you make?") is refused. A stall reaches you as the Inbox alert and counts in the mission's figures; it does not wake the Orchestrator. A command queued for a working Main is lost if the plugin reloads before that turn ends.
- **At Turbo and Full auto** a Main can decide a release or a security trade-off without you: each one shows under Decided for you, and you can lower the level at any moment.
- **Paseo has no uninstall hook**, so removing paseo-bm's configuration is a button you press before removing the plugin.
- Not available yet: suggested extra agent profiles, report export, remote daemons and Windows support.
