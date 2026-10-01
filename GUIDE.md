# paseo-bm guide

The complete reference for `paseo-bm`. For a short overview and the quick start, see the [README](README.md). For a guided tour, see [paseo-bm.erai.pro](https://paseo-bm.erai.pro).

## Contents

- [Before you install: read these warnings](#before-you-install-read-these-warnings)
- [Requirements](#requirements)
- [Install](#install)
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
> - **The Manager** runs in the mode of its `bm-manager` profile. Its instructions forbid doing the work itself, archiving or deleting agents, reading other agents' conversations and approving permission requests. They do **not** forbid git operations, publishing, destructive commands or reading credential files, so choose the `bm-manager` profile's mode with that in mind.
>
> The Worker's boundaries (no git commit or push, no destructive commands, no secret files, ask before dependencies, network or migrations) are enforced **only by its role instructions**. No Paseo permission prompt backs them up. Use paseo-bm in repositories where you are comfortable with that, and review `git diff` before you commit.

> [!NOTE]
> **5. Agent conversation is recorded on this machine.** From the first turn after the plugin loads, it writes one record per agent turn into `~/.paseo-bm/traces/`, so **Projects** can still show a request after its agents are deleted. Records contain the text your agents sent and received, including anything quoted from your repository. Nothing is uploaded. See [Trace storage](#trace-storage).

> [!NOTE]
> **6. The Orchestrator sends only what you allowed.** Nothing of it exists until you press **Start the Orchestrator…** in the Inbox and confirm. Then one agent for the whole machine reads the work of every paseo-bm project, secrets masked, on the provider of the Beads Orchestrator role, and uses tokens there. A command it writes reaches a project's Manager and speaks as you, in three cases only: you pick an option of one of its decisions in the Inbox, you tell it in its chat to send, or the project's autonomy level (**Settings → Autonomy**) lets it decide every kind of decision the command touches. In those last two cases it may also correct a **Worker** directly, and that Worker's Manager always gets a copy; it can stop a running Worker at once only while that Worker is doing something dangerous; it never writes to a Reviewer. It answers a Worker's question only where the project's level lets it decide that kind of question; the rest stay yours, in the Inbox. Every command it sends carries the limits — no commit, push or deploy, and no touching real data, unless you or the level allowed it. A big decision (push, publish, deploy, real data, migrations, security, cost) goes out on a decision you answered, or — only at **Turbo** (cost, release, data) and **Full auto** (security too), each of which you confirm — on the project's level; your word in its chat never covers one. A new install is **Hands-on**: it decides nothing. In a project at **Co-pilot** or above, what happens there wakes it, and each wake-up uses tokens. See [The Orchestrator](#the-orchestrator-one-coordinator-for-every-project).

Your requests and source code go to the model providers you choose for each role. paseo-bm has no telemetry.

## Requirements

| Requirement | Detail |
|---|---|
| Operating system | macOS or Linux. Native Windows is refused. WSL reports itself as Linux but is not covered by testing. |
| Paseo | Paseo desktop at **0.9.0 or newer**, with its daemon running (which usually means the Paseo app is open). 0.9 is where Paseo learned to install a plugin from npm, which is the only supported install path. `plugin/paseo-plugin.json` declares `requirements.paseo: ">=0.9.0"`, so an older daemon refuses the plugin rather than loading a build that cannot reach its own install path. |
| Paseo 0.8 | Not supported by 0.4.0. Keep `paseo-bm@0.3.1` — the last version with the `npx` installer — or upgrade Paseo. |
| Beads tools `br` ([beads_rust](https://github.com/Dicklesworthstone/beads_rust)) and `bv` ([beads_viewer](https://github.com/Dicklesworthstone/beads_viewer)) | **Required for the agents**: the Worker manages beads with `br`, and agents use `bv`'s `--robot-*` views. You do not need them beforehand — **Tools & skills** installs a missing one after you confirm the command. |
| A logged-in agent provider | At least one provider Paseo offers (for example Claude or Codex), logged in with that tool's own login. paseo-bm never handles credentials and never runs a login command; **Settings → More → Agents** shows the command for you to run. |
| Network | Needed for Paseo to fetch the package, and for the **Install skills** and **Install `br` / `bv`** buttons. Nothing else reaches the network. |

No `sudo` is needed, and nothing is written to your machine until you open the plugin.

## Install

Needs Paseo 0.9.0 or newer. Either install from **[paseo.cafe](https://paseo.cafe)**, the plugin
listing inside the Paseo app, or run:

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
   Paseo reports as available and that provider's first model — the same rule the retired installer
   used. One exception: when a provider of another model family (the model's vendor: Claude is
   Anthropic, Codex is OpenAI) is also signed in, a new Beads Reviewer goes to the first such
   provider, so its review does not share the Worker's blind spots. When the Reviewer and the Worker
   share a family, **Settings → More → Agents** says so under the Reviewer.
   Existing entries are never changed, so anything you set yourself is kept. **Settings → More → Agents** says
   so, and is where you change them. What you set there is what a new Worker or Reviewer runs on, even
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

## Working with the agents

### 1. Ask the Manager

Open the Manager with **Chat ▸** on a project's page in [Projects](#projects-what-each-project-and-request-is-doing), or with **Open Beads Manager** in a workspace's Command Center. Each workspace reuses one Manager.

Describe the change in normal chat. The Manager:

- restates the request in one sentence (the Worker decides its size);
- **answers a question itself when it can read the answer** — where a request or a Worker stands, what the beads say, what a file or function does, what git shows — naming what it read and starting no Worker. It changes nothing itself: no file, bead, build or test;
- for a change, **immediately creates one Beads Worker** in the same workspace. A follow-up to a request already in progress goes to that request's Worker instead;
- passes your request on **verbatim** and adds no requirements of its own;
- **coordinates the Workers for you.** When a Worker is waiting — on your own "wait until X" answer, on another Worker's work, on a commit — the Manager wakes it itself as soon as it can *see* that the thing happened: another Worker's report, an agent's status, `git`, `br`. When two Workers would write the same files, beads or history, it lets one run and tells the other — as it creates it, never by holding the request back — that it waits, then wakes it when the way is clear. It tells you beforehand that it will do this and on what, and afterwards what it saw and what it sent, so you can overturn it;
- **answers a Worker's question itself when the answer is only a fact** it can read — has that Worker committed, is that bead closed — sending the fact with its source. Anything about scope, approach, a trade-off, or anything only you can do still comes to you;
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
| Review stages | none, unless you ask | the implementation | the documents and beads, then the implementation |
| Reviews per stage | one, plus one re-review only if blocking findings remain | same | same |
| Review budget per request (a ceiling) | 2, only for a review you ask for | 2 | 4 |
| Reports to the Manager | `received`, `finished` | `received`, `finished` | `received`, `beads-done`, `finished` |

Nothing waits for a confirmation before implementing; what cannot be undone still waits for your yes (below).

### 3. The Worker does only what you asked

- **Process follows what the Worker designs.** Beads, documents and reviews track and check a change the Worker designs. A request that needs none — an answer, or exactly what you already spelled out — gets none of them: the Worker does it and shows the result with its evidence. What you spelled out is also your yes, so it does not ask again. Any part that does need its design is handled like any change.
- **Anything beyond the request is a suggestion, not work.** Extra tests, refactors, docs, clean-ups and related bugs are listed as `Suggestion (not done): …`. The Manager asks you whether any of them should become new work.
- A Small change has no bead: the Worker makes it, runs the check that proves it, and puts the command and its result in its report.
- Before creating a bead, the Worker looks for open beads with the same `feature:<slug>` label. It updates the closest match instead of creating a duplicate, and says which one it picked on its `decided` line.
- Every bead it creates carries a `feature:<slug>` label and a short `## Provenance` naming the request. The beads of a plan follow the `converting-plan-to-beads` contract (objective, scope in and out, components, validation, primary proof, reversibility, …); every bead holds **one outcome** that can be reviewed and reverted on its own; beads are never sized by file, line or bead counts.
- When it writes a plan it runs `reviewing-plan` on it and `polishing-beads` on the beads converted from it. These are its own quality passes: they never replace a Reviewer and do not count against the review budget.
- It works on one bead at a time (with `implementing-beads` when there is more than one), runs the check that proves the bead, and **closes the bead with that evidence right away**. When all beads are closed, the implementation is reviewed once; a bead with a blocking finding is reopened, fixed and closed again with new evidence.
- **It decides what can be undone, and asks only four things.** Inside your request, choices it could reverse later — the approach, names, layout, test shape, the order of beads, whether a document needs updating — are its own; it lists them on its report's `decided` line so you can overturn any of them. It asks you only about the scope (widening, narrowing, adding a requirement), about what cannot be undone or an approved decision (editing a document the repository freezes, deviating from an approved decision, contract, requirement or plan scope — correcting what a document says about the thing it changes is not one of these, changing an existing bead's acceptance criteria, deleting or merging beads, changing an approved design because a Reviewer asked), about what only you have (something you must type or do, the environment, a security trade-off, behaviour existing users rely on), and when it is stuck. Questions it can already see come in one round right after sizing, as one numbered list (at most five) with options and a recommendation. For those it waits for your answer and never assumes one.
- It **asks you first** before installing or upgrading dependencies, using the network, running migrations on real data, deploying or publishing, editing frozen documents, widening the scope, or deleting or merging beads.
- Outside the repository it writes only into a temporary directory it has just created and deletes before reporting.
- **Five limits hold whatever the request:** nothing leaves the workspace without your explicit yes (commit, push, pull request, deploy, publish, network, dependency install, real-data migration, elevated privileges); nothing the Worker did not create is destroyed or touched, including the changes that were already in the tree and your agents; secrets are never read or copied; **no check is ever made to look green** — a test, an assertion or an acceptance criterion is never weakened so something passes, and a bead is never closed on a check the Worker did not watch pass; and nothing only you can decide is decided for you. You review `git diff` and decide.

### 4. A Reviewer checks each batch

Reviews are grouped by stage (see the table); documents are reviewed before implementing only for a Large request or when you ask, and a Small change is reviewed only when you ask. For each stage the Worker creates one Reviewer, fixes **blocking** findings, and sends that same Reviewer one re-review. It does not fix non-blocking findings; they become suggestions. If blocking findings remain after the re-review, the Worker **stops and asks you**. The plugin, not the Worker, counts the review calls of each request (see the next section).

The Reviewer checks each stage against criteria from the workflow skills: the PRD and design gates for documents, `reviewing-plan` (review-only) and the plan-ready gate for a plan, the leaf and readiness checklists for beads, and the split triggers and risk table of `implementing-beads` for the implementation. It may run the repository's tests and throwaway probe scripts, but it changes nothing, uses no network and installs nothing. For authentication, permissions, data or a public contract it lists the abuse and edge cases it tried. Hardening beyond your request is a suggestion, not a blocker, unless it is a real defect in what was built.

### 5. Reports, and when things finish

The Worker sends a structured `BM-REPORT` to the Manager only at the moments listed in the table, plus `blocked` when it needs you. Each report lists the skills the Worker used (`skillsUsed`). A `blocked` report's questions become **decisions**: one card per question in the [Inbox](#inbox-what-needs-you), in the Worker's chat and in the Manager's, and your answer on any of them is delivered to the Worker by the plugin at its next idle moment (see [Questions and answers](#questions-and-answers)). The Manager never approves or changes the Worker's plan itself. The only thing it adds of its own is a fact it has read — another Worker finished, a commit exists, a bead is closed — which it sends with its source and then tells you about. The plugin counts every request's review calls from the conversation. Before any review beyond its budget, the Worker asks you in its `blocked` card, and a yes covers what you said it covers ("one more", "until it is clean"). When a request goes over its budget, the plugin tells the Manager once, and the Manager tells you the numbers in one line without asking again; it never cancels on that notice alone. The Manager still cancels a Worker that is stuck or off course, and tells you why. When a Worker finishes, the Manager tells you how many decisions it made on its own (its `decided` line), any of which you can overturn. When you ask how the work is going, the Manager reads the Worker's and its Reviewers' status and recent activity instead of asking the Worker.

**The blocks are built by tools.** Every Manager, Worker and Reviewer created after you install gets one tool from the plugin — `bm_answers`, `bm_report` or `bm_review` — that builds its block from a schema and refuses a field that breaks it, so the agent fixes it in the same turn instead of receiving a `BM-FORMAT` notice later. The text of the block is unchanged, so cards, Work and older records read it as before. The plugin serves these tools on `127.0.0.1` only, to paseo-bm's own agents, and they only build text: they read, write and send nothing. The tools are given only to agents on Claude, Codex or OpenCode, the providers Paseo can pre-approve a tool for; on any other provider Paseo would refuse to create the agent at all, so there the agent writes the block itself, as do agents created before the update.

When a Worker finishes, it stays idle for you to inspect — unless it finished waiting for something, and the Manager can see that thing has happened: then the Manager starts it again and tells you. **Only you archive or delete agents.** The Manager may cancel a Worker's run, but no agent archives or deletes another.

### Message cards in the chat

In the chats of paseo-bm's agents, paseo-bm's own messages are shown as cards, all in one frame: who
sent it to whom and on whose authority, the time, one status chip, at most three lines, one main
button, and **Details ▸** for the ids and the full message.

- **A decision** — one card per question a Worker asked you (`BM-QUESTIONS`), per decision the
  Orchestrator asked you, and per agent a provider stopped. Its options are buttons, the
  recommended one marked ★, plus **Own words…**. In a project at **Co-pilot** or above, the
  Orchestrator's proposal is the main button — **Orchestrator suggests · <option>** — with its
  reason on one line under it; you still decide. The card reads the decision from where paseo-bm
  stores it, so the same question shows the same state in the Inbox, the Worker's chat and the
  Manager's: answer it once, on any copy. An answer that allows a push, publish or deploy, real data,
  a migration, a security change or a cost asks you to confirm right there, Cancel first. Chips say
  **Needs decision**, **Needs confirmation**, **Decided**, **Superseded**, **Withdrawn** or
  **Expired** — a Worker's question you had not answered expires when the Worker finishes its
  request ("The request finished."): it leaves the Inbox and can no longer be answered, so message
  the Worker if it still matters. A question the Orchestrator decided for you (the project's level
  lets it) reads "decided for you by the Orchestrator", with its reason under **Details**, and has
  no buttons: the first answer counts; take it back with **Override** in the Inbox. One an earlier
  version's policy answered reads "decided for you by your earlier policy".
  **Ask back** — on a Worker's question or the Orchestrator's decision that is still open, ask the
  asker something before you decide (**Ask the Worker** / **Ask the Orchestrator**, Cancel first).
  Its reply appears on the card under **Conversation**; the question stays open. A question that
  could not reach its asker says so and is kept.
  A question you answered that carries a subject offers **Save as precedent…**: your answer (you
  can edit it) becomes a standing answer for later questions on that subject, in this project or in
  all projects, for 30 days — you choose, Cancel first.
- **Progress, finished and verdict** — a Worker's reports to the Manager (**Received**, **Working**,
  **Blocked**, **Finished**) and a Reviewer's verdict (**Passed**, **Changes required**).
- **Brief** — the Manager's instructions in a Worker's chat, and a Worker's review request in a
  Reviewer's chat.
- **Action** — a command paseo-bm delivered (below).
- **Notice** — every other notice of the plugin, as one compact line.

**Reading a card at a glance.** Cards are flat: square corners, thin borders, colour only in small
marks. A bar at a card's left says what kind it is — amber when it waits for you, red when something
is held or failing, grey for news; a settled card has none. A chip is a small coloured square and a
short word.

**Commands.** Every command paseo-bm delivers arrives as a `BM-COMMAND` block and shows as an action
card: the Orchestrator → the Manager or a Worker, on whose authority (your word in its chat, a
decision you answered, or **Policy · <kind>** — the project's autonomy level; a command an earlier version
sent on Autopilot says **Autopilot (retired)**), what it is for, the effects it allows, and the limits — **No
commit/push/deploy**, **No real data** — unless your answer or the level lifted them. In a Manager's chat, a copy
of what the Orchestrator told its Worker is a notice line. The card has no reply box: the block is
your word.

**The Orchestrator's events.** In the Orchestrator's own chat, the plugin's `BM-EVENTS` message is one
compact line; **Details ▸** lists each event with its ids.

**Beads named in a message** appear on the card as chips (`title · id`) — only ids that really exist
in the workspace's bead store. A card shows two chips and a **…** chip for the rest. Press a chip to
read that bead right there, with the same detail and actions as the Beads board.

Only paseo-bm's own messages become cards: messages you type, ordinary replies, tool calls and other
agents' chats look as before, and the conversation itself never changes. For the beads of a chat,
open the **Beads in this chat** panel next to the agent. It lists the beads the chat named recently
(in messages and `br` commands), newest mention first, and opens each one the same way.

### Questions and answers

A Worker asks only when it cannot decide (see above), all at once, each question with its options,
what each one allows (for example "push" or "migration") and one recommendation. You answer in
whichever place is at hand:

- **A decision card** — in the Inbox, the Worker's chat or the Manager's chat. The plugin delivers the
  answers to the Worker at its next idle moment, all the answers of a request together, never into a
  running turn.
- **In words, to the Manager.** The Manager matches each answer to an open question and writes the
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
- **Stopping a Worker also stops its Reviewers.** When you press Stop on a Worker, it cancels the Reviewers it created, and the plugin also sends each running Reviewer a fixed stop notice. This is **not a hard cancel**: Paseo 0.8 gives plugins no way to cancel an agent. A stopped Reviewer takes one short turn to acknowledge. The Worker then reports where it stopped and waits for you.
- **The review budget is a behavioural guardrail.** The plugin counts the reviews, the Worker asks you before going over, and the Manager tells you when a request did. Nothing in code blocks a Worker that ignores its instructions, and one extra review can happen before you are asked.

## The Beads Manager screen

Open **Beads Manager** in Paseo's sidebar. It opens on the **Inbox**, and a row of tabs switches
**Inbox · Projects · Settings · Tools & skills**. The Inbox tab carries the number of things that need you
(as a count beside its name); there is no badge on the sidebar item. A slash command's notice and the state of the
last Manager launch show under the tabs, wherever you are.

Three Command Center items open it for you: **Open Beads Manager** (in a workspace: that workspace's
Manager chat, created the first time), **Open Beads project** (in a workspace: that workspace's page
in Projects, on its Overview) and **Open Beads Inbox** (anywhere).

**The Beads tab.** Every workspace can also show its own page in a tab: open the **+** menu of the
workspace's tab bar (on a phone, the Beads button on the workspace header) and choose **Beads**. It is
the same project page as in Projects — **Overview · Requests · Beads · Metrics · Agents** — opened
on Beads, without a title or ←.

Two panels complete it: **Beads agents** (per workspace) shows the Manager → Worker → Reviewer tree
with each agent's status, and **Beads in this chat** (per agent) lists the beads a chat named — see
[Message cards](#message-cards-in-the-chat).

## Inbox: what needs you

The Inbox is read every 5 seconds while you look at it.

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
  questions, the Orchestrator's decisions, and an agent stopped by its provider plan (switch to the
  fallback, wait for the reset, or handle it yourself). Each is the same decision card as in the chats
  ([Message cards](#message-cards-in-the-chat)). A card you answer stays in place, answered, until
  you leave the Inbox.
- **Decided for you** — when a project's level lets the Orchestrator decide, or you save a
  precedent, some decisions are answered without asking you. The Inbox lists the ones answered
  since you last looked: what was decided, then the project and by whom (the Orchestrator, your
  precedent, your policy for an action it let through, or your earlier policy for an answer an older
  version gave) and why; tap a line for its details. **Override** takes one back: it returns to
  Needs you as your question, and your answer goes to the same agent and replaces the first one
  (work already done is not undone; the Worker is asked what changes). An override is recorded; it
  never changes the project's level — lower the level yourself if you want fewer decisions taken
  for you. Lines you have seen leave the list when you come back after a few minutes away; each
  project's Requests tab keeps every decision.
  Decided for you also lists what the Orchestrator did since you last looked — an answer, unblock,
  correction, stop or advice — with why, and whether it worked: Pending, Met, Missed or Unknown.
  These lines have no Override; tap a line for its ids.
- **Alerts** — one line each (what · project · time), details on a tap: a request that stalled, a
  Worker stuck, waiting on a permission or running a dangerous command, a Worker or Reviewer created
  by the wrong role, an agent on older instructions (for a Manager, **Replace Manager** starts a
  current one and opens it; the old one stays yours), a fallback that failed (**Resend to Worker**
  when a switched Reviewer never appeared), two agents that edited one file at the same time (the
  file and the agents under Details; it clears when both requests finish). **Open Worker** /
  **Open project** where Paseo allows it.

With nothing open, the Inbox says so and offers **Open Projects**.

## Projects: what each project and request is doing

**The projects.** One row per workspace, most recent activity first: a dot that pulses while one of
its paseo-bm agents works, the current request, its stage, its agents as **M W R** (bright while one
of them runs), when it last moved and its autonomy level (**Hands-on** when nothing is set). Rows are read every 10 seconds while the list shows. Below
them, **Closed workspaces with history** lists workspaces archived or removed from Paseo that still
have recorded requests, with their last name, path, last activity and history size.

**A project's page** has **Chat ▸** (the project's Manager) and five tabs, opening on Overview.

**Overview** — requests in the last 30 days, turns by role, tokens read, how many decisions wait on
you, tokens by role, the open requests (three, then "N more open requests in Requests"), **All
requests ▸**, and the project's autonomy level, which opens Settings.

**Requests** — the newest request opens first; each request shows:

- a **stage bar**: Received ▸ Plan ▸ Build ▸ Review ▸ Done, the current stage bold, marked
  *waiting* while it is blocked on you. A stage that cannot be told is not drawn;
- **evidence lines** taken from the Worker's reports: the plan, the checks, files and beads it
  claims — each labelled *detected ✓* (paseo-bm saw it: a check passing after the last edit, the
  file edited, the bead closed), *self-reported* (only the report says so) or *unverified* (the
  report says nothing ran) — the last review verdict and the decisions still open. When a request
  that changed code finishes without every check it names seen to pass, the stage bar reads
  **Done — unverified** and its finished card in the chat **Finished — unverified**, both in amber;
  while it stands so, the Orchestrator never commits or releases it on the project's level — such a
  decision waits for you, and the Orchestrator asks before a commit or release. A new finish whose checks are all seen
  ends it. Requests recorded before this build read Done as before;
- **Timeline ▸** — what happened, newest first: what you asked, the hand-over to the Worker, its
  reports, reviews asked and their verdicts, your messages and the Manager's replies, decisions asked,
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

- **Flow:** requests, questions per request, how long you took to answer, time to finished, errors,
  and requests per day.
- **Cost:** tokens per request (with its median), tokens per request by role, and the heaviest
  requests.
- **Coordination:** how the Orchestrator's interventions turned out, per kind.
- **Beads:** the board's figures — status, progress, by type, by priority, time.
- **Autonomy by class:** how often the recommended option and the Orchestrator's proposal matched
  your answer, per class of decision — the agreement, how many answers, from which day to which, and
  how many were reversed — with who decides each class now. It counts every answer recorded,
  whatever the window. The figures are for your information; the level is set in **Settings →
  Autonomy**.
- **Review lift:** per size of request — reviews per request, blocking findings per batch, how many
  of the findings a first review found were fixed by the next one, and tokens per review.

What could not be counted is said in one line.

**Agents** — the Manager → Worker → Reviewer tree.

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
store**. The same figures as `br stats` — status, progress, by type, by priority, time — are in the
project's **Metrics**. At the top, `✓ <closed> / <total> done`.

**The board**

- The board comes first: **In progress**, **Ready**, **Blocked**, and **Closed**, each column with
  its count. Closed beads are hidden by default; **Show closed (N)** shows them (**Hide closed (N)**
  hides them again), and that choice lasts until you reload the app.
- **Feature** — a row of the project's `feature:` labels above the board, one press to filter by one.
- **Filter ▸** unfolds search by id or title; filters by status, type, priority and labels (grouped by
  category, the part before `:` such as `feature:`, most common values first); and the sort (updated,
  created or closed time, or priority). Active filters stay in sight as chips you can remove.
- Filters apply first, and the sort applies inside each column. A column with nothing in it stays
  where it is and says so. Each column shows its first 100 beads and says how many it left out.
- **The board follows the width.** Wide enough for two columns or more and they sit side by side;
  narrower — a phone, or a slim window — and you get one column at a time, picked from a row of
  status tabs that carry the counts.
- Each row shows the bead's **title first**, in plain text while there is still work in it and dimmed
  once it is closed. The id, type, priority and status are on the line below.
- **Beads in progress say who is on them:** the Worker, since when, and whether that Worker is
  running, idle or gone. This comes from the recorded Worker commands (`br update <id> --status
  in_progress` or `--claim`) and reports. When no such command was recorded, the board says so and
  shows the Worker's last activity instead of guessing.

**Detail**

Press a bead to see who is working on it (with a button to open that Worker), its description rendered as Markdown, its labels, its dependencies and children, and its close reason. Three actions are available, each confirmed first. What an action reported stays on the bead even when the next refresh moves it to another column; a confirmation you had open but not answered closes when the bead moves.

| Action | What happens |
|---|---|
| **Assign a Worker** | The Manager gets the request and a Worker implements the bead until it is closed with evidence. |
| **Delete** | A Worker checks whether the bead is still needed. It deletes it with `br` only if it is not, and reports why either way. |
| **Close** | A Worker checks the acceptance criteria and what the bead depends on. It closes the bead with evidence only if both are satisfied, and otherwise reports what is missing. |

Each action is sent to the workspace's Manager as a normal request (a Manager is created if the workspace has none). It follows the usual size rules, reports and review budget, and appears in Projects like any other request.

## Settings

Three parts, top to bottom:

- **Autonomy** — how much the Orchestrator may decide for you, as one **level** per project (a tab
  per project, with its level). You can change it at any time; a new install is Hands-on everywhere.

  | Level | The Orchestrator decides | Everything else |
  |---|---|---|
  | **Hands-on** | nothing | yours, as asked |
  | **Co-pilot** | nothing | it proposes an answer on each card; you approve in the Inbox |
  | **Cruise** | technical, preference, scope, environment and dependency questions | proposed, for your approval |
  | **Turbo** | as Cruise, plus cost, release and data | proposed (security), for your approval |
  | **Full auto** | every question, security included | — |

  Under the levels, the nine kinds of decision show who decides each at that level: **Orchestrator**
  (it decides, you can override), **You approve** (it proposes, you approve) or **You**. **Turbo**
  and **Full auto** ask you to confirm every time you choose them — they let the Orchestrator decide
  releases, pushes, deploys, migrations on real data and spending (and, at Full auto, security)
  without you — with **Cancel** first. Every answer taken for you shows under **Decided for you** in
  the Inbox, where you can override it; an override is recorded and never changes the level. A
  project whose kinds were set one by one in an earlier version reads **Custom** and shows them as
  they are until you choose a level. Each decision the Orchestrator decides or proposes wakes it,
  which costs tokens.

  **Hold risky actions for approval** (under the level; off by default; you confirm either way)
  holds a project's Claude and Codex Workers and Reviewers before an action leaves the workspace:
  those created after you turn it on run in the least permissive mode, and a push, publish, deploy,
  real-data change, dependency install, network call, write outside the project — or a command
  paseo-bm cannot read — waits for you as one Inbox item with the command, **Allow once** (release,
  data and security ask you to confirm) or **Deny**, unless an answer you gave for that request or
  the project's level covers it. You can also answer in Paseo's own prompt. Ordinary work runs
  without asking; agents that already exist keep their mode, and turning it off does not strand the
  ones created while it was on. The Inbox says when an agent of such a project runs without it.
- **Coordination** (open) — how often the Orchestrator reviews a project and brings you its advice
  (**Orchestrator advice**): after every N finished requests (5 by default; 0 turns it off); advice
  arrives as decisions in the Inbox, each with the change ready on one option. Below it,
  **Compaction** and **Handoff**: whether the Orchestrator may, on its own, have a Manager or Worker
  compact its conversation, or have a Manager hand a heavy request to a fresh Worker, and at which
  thresholds (a Claude turn is judged by its tokens read, a Codex or OpenCode turn by how full its
  context is). Turning one off is one tap; turning it on asks you first. If one misses its goal too
  often — fewer than 8 of its last 10 — paseo-bm switches it off and the Inbox says so; only you turn
  it back on. Then **Review budget**: how many review calls a Worker may make per request of each
  size (2–8; 2, 2 and 4 by default); only Workers created afterwards get new numbers, and the
  Orchestrator's advice may offer a change, applied only when you pick it. **Reset coordination to
  defaults** fills every card with its default; each card's **Save** applies it, and the switches
  stay as they are.
- **More**, each folded to one line that says its state:
  - **Agents** — each role's provider, model, thinking and mode, with an Edit form, and its fallback
    chain where one is offered (the Orchestrator has none, and like the Reviewer it is never offered
    a full-access or planning mode); sign-in per provider with the command to run yourself; Paseo's
    agent tools and **Allow agent tools…**. What you set applies to agents created afterwards. A
    fallback chain's policy is **Ask me** or **Off**; to let the Orchestrator switch a stopped agent
    or wait without asking you, set the project to **Cruise** or above (environment questions are
    then its).
  - **Precedents** — your standing answers: the subject, the project (or all projects), the answer,
    and until when it holds (30 days by default). A later question on that subject, of any kind,
    gets the answer without asking you. **End** stops one (you confirm, Cancel first). **Add
    precedent…** writes one yourself: a project or all, the subject a question carries (shown under
    a decision's **Details**), and the answer. A new precedent on the same subject and project
    replaces the old one.
  - **Data** — the data folder and how it was found; **Trace storage** per workspace with its size,
    where you can delete history and, for a workspace Paseo no longer has, move it onto one that
    exists; the version; and **Remove paseo-bm's settings…**.

Earlier versions edited additional instructions per role on their setup screen. They are retired:
a `role-extras.json` saved then is never read, and **Remove paseo-bm's settings…** deletes it when
you also delete the data.

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

The **Beads Orchestrator** is one agent for the whole machine that you chat with. It reads the work of every paseo-bm project — where each request stands, the Workers' reports, the decisions waiting on you — and tells each project's Manager (and, where you allow it, its Worker) what to do next. How far it goes is up to you, per project:

- **At Hands-on** (every kind of decision yours, as a new install leaves it): before it sends anything, it asks you. Its question is a decision in the [Inbox](#inbox-what-needs-you), each option saying what it would allow, and often with the command ready on it: picking that option sends the command once, on your answer. You can also answer in its chat, or tell it there to send ("send it", "go ahead and send").
- **At a higher level** (Settings → Autonomy): at **Co-pilot** it proposes an answer on each question for you to approve; from **Cruise** up, in a project whose level lets it decide every kind of decision a command touches, it may send that command without asking you. A project at Co-pilot or above also wakes it when a request finishes with work left, stalls, or a Worker shows a signal — within fixed limits; big decisions still come to you below **Turbo** ([What it does on its own](#what-it-does-on-its-own)).

Commands normally go to a project's **Manager**, which directs its Worker. Where your policy covers the command, or right after you tell it to in its chat, the Orchestrator may also correct a **Worker** directly; the plugin then sends that Worker's Manager a copy, so the Manager always knows what its Worker was told. A Worker's question is never answered in a command: the Orchestrator decides one only where the project's level lets it decide that kind (it gives its reason, and the Worker gets the answer as yours), and the rest stay yours, in the Inbox. Nothing ever goes to a Reviewer.

- **One per machine, in a workspace of its own.** paseo-bm creates it only when you press **Start the Orchestrator…** in the Inbox and confirm; after that, **Orchestrator chat ▸** opens the same agent. It does not live in one of your projects: its workspace is the folder `~/.paseo-bm/orchestrator/home`, which Paseo lists as a project named `home`. The folder holds no code, only a short `README.md` saying what it is.
- **What it reads.** Only paseo-bm's own data, through tools the plugin gives it: where each project stands, one request in full, the decisions and their answers, and the recent messages of one paseo-bm Manager, Worker or Reviewer — long enough to read a question with all its options — never another agent's conversation. Everything goes through the same secret masking as the traces. The tools reach it when its provider is Claude, Codex or OpenCode.
- **It checks for itself.** When a report says "tests pass" or "it's committed", the Orchestrator can look: a read-only tool shows a project's `git status`, the summary of what changed, the last 20 commits, or one file — only inside that project's folder, never a file that holds secrets (`.env`, keys, credentials). The tool cannot change, fetch or push anything.
- **It keeps notes.** It writes short notes per project — a decision you made, a standing instruction — and reads them back with the projects. They survive a new Orchestrator.
- **What it cannot do.** It has no Paseo agent tools, so it cannot message, create or stop agents on its own: everything it sends goes through the plugin, which checks the authority at every send (a decision you answered, the project's autonomy level, or your own latest message in its chat), stops a big decision ([below](#big-decisions)), sends the command as a `BM-COMMAND` block with its limits, and records it. It runs in the mode the Reviewer would get (never a full-access or planning mode) and, like the Reviewer, keeps its provider's own shell and file tools; that it changes no file, bead or setting rests on its instructions.
- **It costs tokens.** Every conversation and wake-up uses tokens on the provider of the **Beads Orchestrator** role (`bm-orchestrator`, set in Settings → More → Agents), and the masked content of every paseo-bm project goes to that provider. Events wake it (batched, one turn at a time): a Worker's question it is asked to decide or propose an answer to, and the finished steps, stalls and Worker signals of a project at **Co-pilot** or above ([below](#what-it-does-on-its-own)); the watch itself calls no model. Nothing is created and nothing is spent until you start it.
- **It is yours.** paseo-bm never archives, stops or deletes it. An Orchestrator started with older instructions, or one that lost its tools, is replaced by a new one the next time paseo-bm wakes it; the Inbox's Orchestrator line says so and offers **Start a new Orchestrator…** at once. After a day, when it is idle and you have not written to it for 2 hours, the next wake-up also starts a fresh one, so its conversation stays short; its notes carry over. The old one stays in your agent list for you to archive.

Earlier versions had an Orchestrator screen with its own buttons (send, skip, ask, command, a stall switch, assessments); they are gone. Decisions are in the Inbox, projects and their figures in Projects, and everything else you tell the Orchestrator in its chat.

### Talking to it

Open **Orchestrator chat ▸** and write as you would to a colleague: "How does invoice-app stand?", "What is the Checkout request waiting for?" It answers in its chat. It sends nothing to your projects' agents unless the authority is there:

- **A decision you answered.** When it needs you, it asks with a decision in the Inbox: the question, its recommendation, and the options, each with what it would allow. Picking an option with a command ready on it sends that command once, within an hour of your answer; your own words go to the Orchestrator, which acts on them. **Ask back** on its card asks it something first; it replies on the card.
- **Your word in its chat.** paseo-bm lets it send only when the latest message in its chat is one **you** typed in the app ("send it", "go ahead", "decide it yourself and send it"). A notice from the plugin never counts, and neither does a message the Orchestrator wrote itself.
- **The project's level.** In a project whose level (Settings → Autonomy) lets it decide every kind of decision a command touches, it may send that command on its own; a command with no effect, or only a commit, counts as reversible-technical. The card says **Policy · <kind>**. Release, data and cost need **Turbo**, security **Full auto**, or else a decision you answered; lowering the level refuses its next command at once ([What it does on its own](#what-it-does-on-its-own)).

**A command speaks as you.** paseo-bm delivers it the way the app delivers what you type, as a `BM-COMMAND` block that the Manager's and the Worker's instructions read as your word, and that their chats show as an [action card](#message-cards-in-the-chat). It can answer a question, pick an option, redirect the work or stop part of it. An idle agent gets it at once; a working one when its turn ends. A block looks like this:

```
BM-COMMAND
from: orchestrator
via: chat
to: manager
requestId: req-20260929T081500Z
re: Continue with the two ready beads
intent: continue
effects: none
authority: policy:reversible-technical
approved: none
limits: no-commit-push-deploy, no-real-data

Have the Worker take the two ready beads next; the rest of the report is done.

why: The report shows work left, and none of it needs the owner's decision.
```

It says what the command is for (`intent`), what it lets the agent do (`effects`), on whose authority, and which of those effects the authority covers (`approved`). The `limits:` line keeps what was not approved: no commit, push or deploy, and no touching real data, unless you or the project's level allowed it.


### What it does on its own

How far it goes without asking follows the project's autonomy level (**Settings → Autonomy**), and paseo-bm checks it at every send. A command goes out on its own only when the level lets it decide every kind of decision the command touches; a command with no effect, or only a commit, counts as reversible-technical. Lowering the level refuses its next command at once. A new install is Hands-on, so until you raise a project's level it acts only on a decision you answered or on your word in its chat, and asks you in the Inbox for everything else, with the command ready on an option.

- **It wakes when something happens.** In a project at **Co-pilot** or above, a request that finished with work left (ready beads, open findings, failing checks), a request that stalled and a Worker signal (below) are events. A Worker's question, or an agent a provider stopped, is an event only when the Orchestrator is asked something of it: to decide it, where the project's level lets it decide that kind, or to propose an answer, which you see on the card, in a project at Co-pilot or above. A question it does not decide stays yours in the Inbox; nothing answers it for you at Hands-on or Co-pilot. paseo-bm hands the Orchestrator every event waiting at its next idle moment as one `BM-EVENTS` message, and drops an event whose subject was settled meanwhile — a question you already answered, for example.
- **paseo-bm watches the Workers while they work.** Every 2 minutes it reads the recent activity of the running Workers of every project (at most 5 per pass, no model call) and, once per Worker turn, raises one of six signals with the evidence:

  | Signal | Raised when |
  |---|---|
  | Stuck | the Worker has shown nothing new for 10 minutes |
  | Waiting on a permission | a permission prompt has waited 3 minutes |
  | Dangerous command | a push, publish or deploy, destructive SQL, or `rm -rf` of `/`, `~` or a folder outside the project |
  | Same command failing | the same command failed 3 times in the turn |
  | Heavy process on a Small request | a Small request creates beads, or writes a plan or an ADR |
  | Writing outside the workspace | a file edited outside the project's folder |

  Stuck, waiting on a permission and dangerous command are **alerts** in your Inbox, in every project, until they clear. A signal reaches the Orchestrator only in a project at Co-pilot or above. paseo-bm itself never stops anyone.
- **It decides only what the level gives it.** It decides a Worker's question only where the project's level lets it decide that kind; it proposes an answer to the others, which stay yours, in the Inbox.
- **It moves unfinished work on, within your policy.** After a finished step with work left, it checks that what you asked for is done and, where your policy covers the command, tells the Manager what to do next; otherwise it asks you. To correct a Worker — one looping on the same failure, or growing process on a small request — it can write to the **Worker** directly, on the same authority: the Worker gets the command when its turn ends, and its Manager gets a copy at the same time. In a project at Co-pilot or above, a **Dangerous command** signal opens a 10-minute window in which it may stop that Worker in the middle of its turn; the stop still needs the authority any command needs. Outside that window it cannot interrupt a Worker.
- **The limits hold whatever it decides.** Every command it sends carries the `limits:` line: no commit, push or deploy, and no touching real data, unless you or the project's level allowed it.
- **Big decisions come to you** below **Turbo** ([below](#big-decisions)).
- **A loop guard.** It sends at most 12 commands for one request (or one project, without a request) in 24 hours; after that it has to ask you.

**Why something exists.** Ask the Orchestrator why a bead, a changed file or a decision exists: it reads the chain behind it — the request, its decisions, beads, changes, checks and reviews — without changing anything.

**Compaction.** When a Manager's or Worker's conversation crosses the thresholds in **Settings → Coordination**, the Orchestrator may have it compact: paseo-bm sends `/compact` at a safe moment (after a Worker's report, or when a Manager is idle), then a `BM-STATE` note restoring what matters from paseo-bm's records — the request, your words, the decisions, the report's facts. The agent's chat shows both (the note as "State restored after compaction"); they are paseo-bm's, not yours — Projects does not show them as your words — and a `/compact` you type yourself stays yours. Inbox → Decided for you lists it with whether it worked. Turning compaction off in Settings stops it at once.

**Handoff.** With handoff on in **Settings → Coordination**, the Orchestrator may hand a request that has grown too heavy to a fresh Worker: the old Worker writes a short note, paseo-bm builds a brief from its records, and the request's Manager creates the successor from it — the request keeps its id. The old Worker stays in your list, marked replaced, and paseo-bm tells it in its chat ("Handed over to another Worker") to stop; nothing is archived. The request's timeline shows "Handed over to Worker 2 from Worker 1" and the command card reads "Coordination · handoff". A successor's finish is verified only by checks it ran itself. Turning handoff off stops a pending one at its next step.

**Advice.** After every N finished requests of a project (**Settings → Coordination**, 5 by default, 0 turns it off) the Orchestrator reviews the project's figures — repeated questions, blocked rounds, reviews, stalls, heavy requests — and may ask you in the Inbox about one change: save a precedent, let the Orchestrator decide (or stop deciding) one kind of decision — the project then reads Custom —, or change the advice cadence. The question says exactly what each option sets, and paseo-bm applies it only when you pick that option yourself: your policy, a precedent or the Orchestrator never answers it. You can also ask the Orchestrator for advice in its chat at any time.

### Big decisions

A command must declare what it allows. Push, publish or deploy, real data, a migration, a security change and a cost are **big decisions**: your word in its chat never covers them. A decision you answered does, for one command within an hour of your answer, and your answer asks you to confirm first. The project's level covers them only at **Turbo** (release, data, cost) and **Full auto** (security too) — levels you confirmed — and each answer then shows under Decided for you.

As a backstop, before a command of the Orchestrator leaves, paseo-bm also reads its subject and instructions for words of five kinds:

| Kind | Words such as |
|---|---|
| Security and permissions | security, permission, authorization, impersonate, token, secret, password, credential |
| Release: push, deploy, publish | push, deploy, publish, release, production, merge into main |
| Data: migrations, real data | drop table, truncate, delete from, migration, real data, production data |
| Cost | billing, cost, pricing, paid, subscription |
| New dependencies | npm install, pnpm add, yarn add, a new dependency, license |

(Vietnamese words for the same things count too.) A word with a "not", "no", "never", "without", "avoid" or "stop" up to four words before it in the same sentence — "do not push", "without deploying", "stop the push" — does not count. A match that the command did not declare stops it: nothing is sent, and the Orchestrator is told to declare the effect or ask you. The check is a word rule, so a harmless mention ("the security page") also comes to you; it never lets a matching command through. Nothing switches the word check off: kinds an earlier version let you allow per project no longer count.

A wrong command costs a Worker turn, not your data: you can always overrule it by writing to the Manager yourself.

### Stalled work

paseo-bm looks once a minute at the recorded traces and the agent list — no conversation is read and no model is called — at every request with activity in the last 24 hours. A request stalls when it is not finished, has no question of yours open, and none of its Workers and Reviewers has run for **5 minutes**, or when it has more review calls than its size's budget. Waiting for you means a question in the Inbox: a Worker that says it is blocked after you answered everything, or that waits for another agent, stalls like any other. It becomes a **Request stalled** alert in your Inbox, once, and clears when an agent runs again. A request waiting for your answer is not stalled: its question is already in the Inbox.

When Paseo cuts an agent's turn short to deliver a message (an agent it created finishing, for example), Claude Code tells the agent that the user rejected its call, and the agent may stop to wait for you. paseo-bm recognises such a cut from what Paseo records, never from the words: a Manager or Worker left idle after one gets **BM-INTERRUPTED**, saying the cut came from Paseo, not from you, and carries on. Your own Stop, your new message, or a permission you deny is never mistaken for one. In a project at **Co-pilot** or above, the stall is also an event for the Orchestrator; otherwise nothing is sent to anyone.

### What the Orchestrator reads

It reads your projects through its tools — the requests, their reports and questions, the agents' recent messages, the repository read-only — not through flags. One rule stays: a request with **more review calls than its size's budget** (Small 2, Medium 2, Large 4) is a stall (above). The other process figures earlier versions flagged per request — a Small request with heavy process, a Medium or Large request without a review, an agent that failed its first turn, a malformed report, a reply in another language — are now measured across requests by the replay (`npm run eval:replay`, *Process* figures).

### Its data, and cleaning up

- **On disk:** `~/.paseo-bm/orchestrator/` — the commands it sent, the open 10-minute allowances to stop a Worker, its notes and its `home` folder; its decisions are in `~/.paseo-bm/decisions/` with the Workers' questions ([the full list](#the-data-folder-paseo-bm)). Deleting a request's history also deletes the workflow assessments that covered it.
- **In Paseo:** the **Beads Orchestrator** agent and its `home` workspace, created only by your confirmation of **Start the Orchestrator…**. paseo-bm never archives or deletes them; archive the agent and remove the workspace in Paseo when you no longer want them.
- **Remove paseo-bm's settings…** removes the `bm-orchestrator` role with the other three, and — if you also choose to delete the data — the whole `~/.paseo-bm/orchestrator/` folder. The agent and its workspace in Paseo stay until you remove them.

## Trace storage

Records live in `~/.paseo-bm/traces/`: one directory per workspace, one file per month. Directories are `0700` and files are `0600`. Secrets are masked before anything is written.

- **paseo-bm never deletes traces on its own.** There is no retention period, no rotation and no automatic clean-up. When the store grows past a threshold, **Settings → More → Data** warns you.
- **You can delete** one request (its **Details** in Projects), and every trace older than 30 days or every trace of a workspace (**Settings → More → Data → Trace storage**, or a closed workspace's page in Projects). Settings → More → Data also reminds you that this history holds your agents' conversation.
- **Every deletion shows first** how many traces and how many bytes will go, and how many of those requests are still running. It then asks you to confirm, and the safe answer is the default.
- **Deletion is irreversible.** There is no undo and no bin.
- Deleting a project's traces also deletes a workflow-assessments file an earlier version kept for that project, since it may quote them.
- Deleting traces removes only paseo-bm's own recording. Your beads, documents, agents and Paseo conversations are untouched.
- Updating paseo-bm never deletes the store.

**Closed or removed workspaces keep their history.** It appears under **Closed workspaces with history** in Projects. If you remove a workspace from Paseo and later open the same project again, Paseo gives it a new workspace id. The old history's page offers to **move** it onto a workspace that exists, or you can delete it. paseo-bm never makes that link on its own, because two workspaces on the same path are not necessarily the same line of work.

### The storage warning threshold

Set it in Paseo settings → **Beads Dashboard**. The default is 200 MB. Paseo stores plugin settings per machine, so **this threshold applies to every workspace on this machine**. A value that is not a positive number is refused, and the previous threshold stays in force.

## Everything paseo-bm writes

This is the complete list. paseo-bm writes nowhere else.

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
| `~/.paseo-bm/inbox/alerts.json` | The Inbox's alerts: open ones, and the 500 newest cleared ones. |
| `~/.paseo-bm/autonomy/policy.json` | Your autonomy levels from Settings → Autonomy, kept as who decides each kind of decision per project and when you set it, whether the Orchestrator proposes answers there, and whether risky actions are held. No file means Hands-on everywhere. Your data. |
| `~/.paseo-bm/autonomy/precedents.json` | Your precedents, saved from a decision card or in Settings → More → Precedents: for each, the subject, the project (or all), your answer, the decision it came from, when it was saved, until when it holds and what replaced it. Every active one is kept, and the 500 newest ended, expired or replaced ones. Your data. |
| `~/.paseo-bm/role-extras.json` | Additional role instructions saved with an earlier version. Never read now; deleted with the data by **Remove paseo-bm's settings…**. Your data. |
| `~/.paseo-bm/role-fallback.json` | Your fallback chains from Roles & models: each role's policy and fallback entries (provider, model, thinking, mode), plus optional detection `patterns` you edit by hand. Your data. |
| `~/.paseo-bm/role-fallback-state.json` | The fallback incidents: each agent that stopped on its provider plan, what was chosen on its card, and the replacement. At most 200 are kept. Your data. |
| `~/.paseo-bm/orchestrator/` | The Orchestrator's files: `proposals.json` (every command the Orchestrator sent, with its authority — your policy, a decision you answered or your word in chat — and whether it was delivered; the 200 newest), `stalls.json` (each open 10-minute allowance to stop a Worker; at most 500), `notes/<workspace id>.json` (the Orchestrator's notes on a project, the 20 newest), and `home/` (the Orchestrator's own workspace, with a `README.md`). A `settings.json` (the projects an earlier version had on Autopilot), an `assessments/` folder or a `model-corrections.json` an earlier version wrote there is ignored, and deleted with the folder. Your data. |
| `~/.paseo-bm/ui/` | Small files of the plugin's own: `budget-told.json` (which review-budget overruns were announced), `agent-tools.json` (the port of the agents' tool endpoint), and `setup-state.json` (what setup has done: which roles were created, whether paseo-bm turned Paseo's agent tools on and what they were before, the last skills run, and whether you removed paseo-bm's settings). |
| `~/.paseo-bm/home.json` | A pointer to a data folder somewhere else, written **only** by `npx paseo-bm@0.4.0` when it migrates an install that used `--home`. Delete the file to drop the pointer. |

Files a 0.3.x install left behind — `install.json`, `plugin/<version>/` and `backups/` — are read by
nothing in 0.4.0 and are never deleted by it. After migrating you can delete `plugin/` and `backups/`
by hand.

Files earlier 0.4 versions wrote and this one no longer reads — `ui/qa-ledger.json`,
`ui/answer-marks.json`, the Orchestrator's `settings.json`, and older kinds of entry in its
`proposals.json` and `stalls.json` — do no harm: they are ignored, those older entries are dropped the
next time their file is written, and **Remove paseo-bm's settings…** deletes all of them with your data.

Every write goes to a temporary file first, is `fsync`ed and then renamed into place, with mode
`0600` and a check that no component of the path is a symlink. A run killed mid-write can leave a
`*.tmp-*` file beside its target; it is safe to delete.

### Paseo config: `~/.paseo/config.json`

paseo-bm **never** edits this file itself. Everything below goes through Paseo's own API
(`config.patch`), and every write is read back afterwards.

| Key | What paseo-bm writes | When |
|---|---|---|
| `agents.providers.bm-manager`, `agents.providers.bm-worker`, `agents.providers.bm-reviewer`, `agents.providers.bm-orchestrator` | A derived provider `{ extends, label, paseoTools }` (the Reviewer and the Orchestrator get no `paseoTools`) that reuses your existing provider login, with no command and no environment | Created when missing, the first time you open Beads Manager or its Settings. An entry that already exists is never changed. |
| `daemon.agentProfiles[]` entries whose `id` starts with `bm-` | The role's provider, model and name, appended at the end. Other profiles and their order are left untouched. | Same as above; afterwards, only when you save in Roles & models. |
| `agents.providers.bm-<role>-fallback-<n>` (n = 1…3) | A derived provider for each entry of a role's fallback chain | When you save a fallback chain in Settings → More → Agents |
| `daemon.mcp.injectIntoAgents` | `true`; the previous value is recorded in `ui/setup-state.json` first | **Only** when you press **Allow agent tools…** and confirm. Set back to the recorded value by **Remove paseo-bm's settings**. |

**Only on your click, in Paseo:** **Start the Orchestrator…** (in the Inbox, once you confirm) registers `~/.paseo-bm/orchestrator/home` as a Paseo workspace and creates one agent there, the Beads Orchestrator. Both are yours afterwards.

`pluginsEnabled` and `plugins` belong to Paseo: paseo-bm never writes either. The migration command
`npx paseo-bm@0.4.0` writes only `<install home>/install.json`, `<install home>/ui/setup-state.json`
and `~/.paseo-bm/home.json`, and calls `paseo plugin remove|add` — it does not touch `config.json`.

### What paseo-bm never writes

- **Agent skills.** paseo-bm only reads skills directories. Skills are put there by the third-party `skills` CLI, and only when you press **Install skills** and confirm.
- **Beads tools.** paseo-bm does not write `br` or `bv` itself: it runs Homebrew or the projects' own install scripts, after showing you the command.
- Credentials and provider logins: never read, stored or printed. paseo-bm does not run login commands.
- Plugins, providers or profiles created by you or by other tools. Only `bm-*` entries belong to paseo-bm.
- Your repository, from the plugin: the Beads board and Metrics only **read** `.beads/issues.jsonl`. Changes to your repository come from the agents you ask for work.
- Existing agents in Paseo. They are yours, and removal leaves them in place.

## Agent skills

The Worker follows the **feature-workflow** process, which comes from a set of agent skills. paseo-bm runs without them, but **the Worker's results are noticeably worse without them**, so paseo-bm checks for them. Role instructions take precedence over any skill.

- **Source:** https://github.com/cuongntr/agent-skills. This is **another author's repository** (`cuongntr`). paseo-bm does not bundle, maintain, fork or patch these skills.
- **Required skills** (checked and warned about): `feature-workflow`, `reviewing-plan`, `converting-plan-to-beads`, `polishing-beads`, `implementing-beads`.
- **Optional skills** (suggested only): `architecture-premise-audit`, `authoring-workspace-protocol`.
- **Where paseo-bm looks** (read-only): `~/.agents/skills`; Claude Code's `~/.claude/skills` (follows `--claude-home` or `CLAUDE_CONFIG_DIR`); Codex's `~/.codex/skills` (follows `--codex-home` or `CODEX_HOME`). Symlinked skills count as present. Only names are compared, not versions.

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

The plugin checks the Worker's required skills for the provider the Worker runs on, and the Manager tells you once, with the command to add them, if the Worker will run without them. It still hands over the work.

## Checking health

Everything the retired `doctor` command reported is in **Settings** while the plugin is
running: the four roles and their models, Paseo's agent-tools switch and who turned it on, each
provider's sign-in, the required skills per agent, `br` and `bv`, the data folder and how it was
found, and which kind of install this is.

If the plugin does **not** load at all, Settings cannot tell you anything. Ask Paseo instead:

```bash
paseo plugin ls
paseo plugin logs paseo-bm
```

## Updating

```bash
paseo plugin update paseo-bm
```

Your data folder is never touched by an update: traces, role instructions, fallback settings and the
setup state all stay. Your `bm-*` entries in Paseo's configuration are left as they are, including
any model or mode you changed yourself. A machine set up before the Orchestrator existed gets only
the missing `bm-orchestrator` role the next time you open Beads Manager or its Settings, and no
Orchestrator agent exists until you start it. Agents created by an earlier version run on older
instructions: the Inbox lists them as alerts (**Replace Manager** for a Manager); Workers and
Reviewers simply end with their request.

Downgrading is supported only **within 0.4.0 and later**. Going back to 0.3.x is not a rollback: a
0.3.x plugin does not trust a data folder whose `install.json` is missing or marked as migrated, so
it would find no history. If a 0.4.x release breaks something for you, the way back is a later
0.4.x.

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

What the button never touches: agents you already created, the Beads Orchestrator and its `home`
workspace included (archive or remove them yourself — an agent fails on its next turn without its role), your skills, `br` and `bv`, and anything in the data folder that
paseo-bm did not create (`install.json`, `plugin/`, `backups/`, `home.json`, and anything you put
there). One file always survives, even when you ask for the data to be deleted:
`ui/setup-state.json`, because it records that you removed the settings — without it, one plugin
reload before step 2 would create the three roles again.

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
| `0` | Migrated, or there was nothing to migrate (already on npm, or no directory install — it then prints the paseo.cafe instructions), or a preview without `--apply` in a terminal |
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
- On Paseo 0.8 the plugin is refused on purpose (it declares `>=0.9.0`). Upgrade Paseo, or keep
  `paseo-bm@0.3.1`.

**Beads Manager will not open, or the Manager cannot create a Worker**

Almost always Paseo's agent-tools switch. While it is off, opening Beads Manager stops with `Paseo's agent tools are off…` instead of starting a Manager that could never create a Worker. **Settings → More → Agents** says `Off — no new Beads Manager starts until you allow them` and offers **Allow agent tools…**. A provider's own `paseoTools` setting is not enough: the
machine-wide switch is what grants the tools.

Otherwise, check the Worker's provider is signed in (**Settings → More → Agents → Sign-in** shows the command)
and that its model still exists in Paseo. The Manager reports the exact cause when creation fails.

**`E_SETUP_ROLES_FAILED`**

paseo-bm could not create its three roles. The message says why: `Paseo reports no available
provider` means no provider is usable yet — sign in to one, then press **Try again**. `Paseo lists no
model for <provider>` means that provider is available but has no models. A refused patch is Paseo
declining the write; `paseo plugin logs paseo-bm` has the detail.

**`E_DATA_HOME_UNAVAILABLE`**

paseo-bm cannot use its data folder, so history and settings are off. **Settings → More → Data** shows
the reason. Usually `PASEO_BM_HOME` is relative or points somewhere paseo-bm refuses (your home
directory, or inside Paseo's or an agent's directory), or `~/.paseo-bm/home.json` is not valid JSON.
paseo-bm deliberately does not fall back to the default here: that would split your data in two.

**`E_SETUP_WRITE_FAILED`**

Paseo refused a configuration write, or did not keep it. Nothing is left half-written: the previous
value is restored first. Retry; if it persists, check `paseo plugin logs paseo-bm`.

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

- **Rules for the agents are instructions, not code.** The review budget, "only do what was asked" and the Worker's safety boundaries depend on the model following its role instructions.
- **Stopping is not a hard cancel** (Paseo 0.8 has no plugin cancel).
- **Beads of a closed workspace are not shown.** Its request history is still readable from **Closed workspaces with history** in Projects.
- **Costs are estimates** from a bundled price table.
- **Only paseo-bm's own messages become chat cards**; a Worker's ordinary chat text stays plain (use the **Beads in this chat** panel for its beads).
- **The Orchestrator is one model's view.** It reads your projects through bounded tools; the replay's process figures are worked out again from the recorded traces every time, so they can change when agents are deleted; its language check tells only Vietnamese from English. Its read-only behaviour, and where your policy lets it act, its judgement of a large change of scope or anything irreversible, rest on its instructions, as the Reviewer's behaviour does; the plugin enforces where a command may go, when it may be sent, its limits, when a Worker may be stopped mid-turn, and the big-decision gate — a word rule, which stops a harmless mention and cannot catch a risk put in other words. The live watch looks every 2 minutes at 5 Workers at most, so a short dangerous command can finish before anyone looks. A Claude Worker's timeline does not carry a command's exit code, so **Same command failing** is not raised for Workers on Claude. The backstop also reads the Orchestrator's own stop commands: "Stop the push" passes, but a stop whose text also names the risky command with no negation before it ("how many git push runs did you make?") is refused unless it declares that effect, which only a decision you answered covers — so that stop waits for your answer. In a project at Hands-on, a stall reaches only you — the Inbox alert — and is resolved when you act or tell the Orchestrator. A command queued for a working Manager is lost if the plugin reloads before that turn ends. At Turbo and Full auto a release or a security trade-off can happen without you: each one shows under Decided for you, and you can lower the level at any moment.
- **Paseo has no uninstall hook**, so removing paseo-bm's configuration is a button you press before removing the plugin.
- Not available yet: suggested extra agent profiles, a limit on parallel Workers, report export, remote daemons, Windows support, and a code-enforced review budget.
