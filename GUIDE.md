# paseo-bm guide

The complete reference for `paseo-bm`. For a short overview and the quick start, see the [README](README.md). For a guided tour, see [paseo-bm.erai.pro](https://paseo-bm.erai.pro).

## Contents

- [Before you install: read these warnings](#before-you-install-read-these-warnings)
- [Requirements](#requirements)
- [Install](#install)
- [Working with the agents](#working-with-the-agents)
- [The Beads Manager screen](#the-beads-manager-screen)
- [Metric: what each request did](#metric-what-each-request-did)
- [Beads: the workspace's beads](#beads-the-workspaces-beads)
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
> Nothing turns it on for you. **Setup → Allow agent tools…** asks first, with that warning, and records what the switch was before so **Remove paseo-bm's settings** can put it back. Until you press it, Beads Manager does not start: an agent only gets Paseo's tools when it is created, so a Manager started before the switch was on could never create a Worker.

> [!WARNING]
> **3. Installing skills runs someone else's tool.**
> **Setup → Install skills…** runs the third-party `skills` CLI, which downloads from [cuongntr/agent-skills](https://github.com/cuongntr/agent-skills) (another author's repository) and has its own data collection. The exact command is shown before it runs, and paseo-bm never writes to your skills folders itself.

> [!CAUTION]
> **4. Agent permission modes, and rules that only instructions enforce.**
> - **The Worker** is created in its provider's **no-prompt mode**: Claude `bypassPermissions`, Codex `full-access`, or the equivalent for other providers. Paseo does not ask you to approve its commands.
> - **The Reviewer** is created in **auto mode** (Claude `auto`, Codex `auto`), which does not grant full or network access. The plugin sets this itself when the Reviewer is created, and moves a Reviewer out of a full-access or planning mode even if the Worker asked for one.
> - **The Manager** runs in the mode of its `bm-manager` profile. Its instructions forbid doing the work itself, archiving or deleting agents, reading other agents' conversations and approving permission requests. They do **not** forbid git operations, publishing, destructive commands or reading credential files, so choose the `bm-manager` profile's mode with that in mind.
>
> The Worker's boundaries (no git commit or push, no destructive commands, no secret files, ask before dependencies, network or migrations) are enforced **only by its role instructions**. No Paseo permission prompt backs them up. Use paseo-bm in repositories where you are comfortable with that, and review `git diff` before you commit.

> [!NOTE]
> **5. Agent conversation is recorded on this machine.** From the first turn after the plugin loads, it writes one record per agent turn into `~/.paseo-bm/traces/`, so the Metric screen can still show a request after its agents are deleted. Records contain the text your agents sent and received, including anything quoted from your repository. Nothing is uploaded. See [Trace storage](#trace-storage).

Your requests and source code go to the model providers you choose for each role. paseo-bm has no telemetry.

## Requirements

| Requirement | Detail |
|---|---|
| Operating system | macOS or Linux. Native Windows is refused. WSL reports itself as Linux but is not covered by testing. |
| Paseo | Paseo desktop at **0.9.0 or newer**, with its daemon running (which usually means the Paseo app is open). 0.9 is where Paseo learned to install a plugin from npm, which is the only supported install path. `plugin/paseo-plugin.json` declares `requirements.paseo: ">=0.9.0"`, so an older daemon refuses the plugin rather than loading a build that cannot reach its own install path. |
| Paseo 0.8 | Not supported by 0.4.0. Keep `paseo-bm@0.3.1` — the last version with the `npx` installer — or upgrade Paseo. |
| Beads tools `br` ([beads_rust](https://github.com/Dicklesworthstone/beads_rust)) and `bv` ([beads_viewer](https://github.com/Dicklesworthstone/beads_viewer)) | **Required for the agents**: the Worker manages beads with `br`, and agents use `bv`'s `--robot-*` views. You do not need them beforehand — **Setup → Beads tools** installs a missing one after you confirm the command. |
| A logged-in agent provider | At least one provider Paseo offers (for example Claude or Codex), logged in with that tool's own login. paseo-bm never handles credentials and never runs a login command; **Setup → Agents** shows the command for you to run. |
| Network | Needed for Paseo to fetch the package, and for the **Install skills** and **Install `br` / `bv`** buttons. Nothing else reaches the network. |

No `sudo` is needed, and nothing is written to your machine until you open the plugin.

## Install

Needs Paseo 0.9.0 or newer. Either install from **[paseo.cafe](https://paseo.cafe)**, the plugin
listing inside the Paseo app, or run:

```bash
paseo plugin add npm:paseo-bm-plugin
```

Nothing on your machine changes until you open the plugin: Paseo has no hook that runs at install
time, so paseo-bm does its setup lazily, the first time you open **Beads Manager** or **Setup**.

### What happens the first time you open it

1. **The three roles are created**, if they are missing: the provider aliases `bm-manager`,
   `bm-worker`, `bm-reviewer` and their agent profiles. The defaults are the first provider Paseo
   reports as available and that provider's first model — the same rule the retired installer used.
   Existing entries are never changed, so anything you set yourself is kept. Setup and the launcher
   both say so, and **Setup → Agents** is where you change them. What you set there is what a new
   Worker or Reviewer runs on, even when a Manager or Worker created earlier asks for the old model
   (and even for one you start by hand on `bm-worker` or `bm-reviewer` with another model).
2. **Setup shows "Set up paseo-bm"** with whatever is still missing. Three rows are buttons, because
   each grants something and nothing runs before you press it:

   | Step | What pressing it does | Why it needs a press |
   |---|---|---|
   | **Allow agent tools…** | Turns on Paseo's `daemon.mcp.injectIntoAgents` | The switch applies to **every agent on this machine**, not only paseo-bm's roles: any agent can then create, message and stop other agents. paseo-bm records what the switch was before, so removal can put it back. Without it the Manager cannot create a Worker at all. |
   | **Install skills…** | Runs the third-party `skills` CLI once, with the exact command shown | It downloads from [cuongntr/agent-skills](https://github.com/cuongntr/agent-skills) (another author's repository) and that tool has its own data collection. paseo-bm never writes to your skills folders itself. It can take up to 5 minutes. |
   | **Install `br` / `bv`** | Runs the beads tools' own documented install command | It downloads and runs someone else's install script. The exact command is shown first. |

   The card disappears when nothing is left. Rows that are merely *unknown* — a provider whose
   sign-in Paseo could not report — never appear.
3. **Sign-in.** **Setup → Agents** lists each provider your roles run on and whether it is signed in.
   paseo-bm never runs a login command and never sees a credential: it shows the command that
   provider's own tool documents, and you run it.

## Working with the agents

### 1. Ask the Manager

Open the Manager with **Go to** on the [Beads Manager screen](#the-beads-manager-screen), or with **Open Beads Manager** in a workspace's Command Center. Each workspace reuses one Manager.

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

The Worker sends a structured `BM-REPORT` to the Manager only at the moments listed in the table, plus `blocked` when it needs you. Each report lists the skills the Worker used (`skillsUsed`). The Manager relays: it passes your answers to the Worker word for word, shows you every question of a `blocked` report, and never approves or changes the Worker's plan itself. The only thing it adds of its own is a fact it has read — another Worker finished, a commit exists, a bead is closed — which it sends with its source and then tells you about. The plugin counts every request's review calls from the conversation — the same number the Metric screen shows. Before any review beyond its budget, the Worker asks you in its `blocked` card, and a yes covers what you said it covers ("one more", "until it is clean"). When a request goes over its budget, the plugin tells the Manager once, and the Manager tells you the numbers in one line without asking again; it never cancels on that notice alone. The Manager still cancels a Worker that is stuck or off course, and tells you why. When a Worker finishes, the Manager tells you how many decisions it made on its own (its `decided` line), any of which you can overturn. When you ask how the work is going, the Manager reads the Worker's and its Reviewers' status and recent activity instead of asking the Worker.

**The blocks are built by tools.** Every Manager, Worker and Reviewer created after you install gets one tool from the plugin — `bm_answers`, `bm_report` or `bm_review` — that builds its block from a schema and refuses a field that breaks it, so the agent fixes it in the same turn instead of receiving a `BM-FORMAT` notice later. The text of the block is unchanged, so cards, Metric and older records read it as before. The plugin serves these tools on `127.0.0.1` only, to paseo-bm's own agents, and they only build text: they read, write and send nothing. The tools are given only to agents on Claude, Codex or OpenCode, the providers Paseo can pre-approve a tool for; on any other provider Paseo would refuse to create the agent at all, so there the agent writes the block itself, as do agents created before the update.

When a Worker finishes, it stays idle for you to inspect — unless it finished waiting for something, and the Manager can see that thing has happened: then the Manager starts it again and tells you. **Only you archive or delete agents.** The Manager may cancel a Worker's run, but no agent archives or deletes another.

### Message cards in the chat

In the chats of paseo-bm's agents, messages between the agents are shown as compact cards:

- a Worker's `BM-REPORT` in the Manager's chat;
- the Manager's instructions in a Worker's chat;
- a Worker's review request in a Reviewer's chat;
- a Reviewer's `BM-REVIEW` verdict.

Each card carries:

- the sender's role icon (in the role's colour), the sender's name with the time under it, and the recipient;
- the request id, and a status chip (report phase or review verdict);
- a short summary.

Press **Show message** to read the full message as Markdown. Press **Reply to <role>** to answer the other agent straight from the card: the reply names the request it answers. Before sending, the card checks the recipient again and sends nothing if it is working, starting or gone, and says why. Once a reply went out, the Reply button gives way to an **Answered** chip; press it to reply again (the card remembers this until you reload the app).

**Questions in a card.** When a Worker's `blocked` report carries a `BM-QUESTIONS` block, its card shows each question with its options as full-width rows, the Worker's recommendation marked, and **Other…** for your own words. Each pick writes a `BM-ANSWERS` block at the top of the Reply box, next to anything you typed; **Use recommendations** fills the recommended options in, **Clear** empties the picks, and one **Send** sends it all. A question you leave unanswered stays open. **Mark as answered** tells the card you answered elsewhere; that mark is kept in `~/.paseo-bm/ui/`.

**Questions waiting.** Above the Manager's chat, each Worker waiting for your answer has a pill next to Paseo's own. Press it to answer in a popover showing that report's card. The pill goes away once the Worker runs again or reports something else (it is checked every 15 seconds).

**Beads named in a message** appear on the card as chips (`title · id`) — only ids that really exist in the workspace's bead store. A card shows two chips and a **…** chip for the rest. Press a chip to read that bead right there, with the same detail and actions as the Beads screen.

Only paseo-bm's own messages become cards: messages you type, ordinary replies, tool calls and other agents' chats look as before, and the conversation itself never changes. A Worker's ordinary questions therefore stay plain text; for their beads, open the **Beads in this chat** panel next to the agent. It lists the beads the chat named recently (in messages and `br` commands), newest mention first, and opens each one the same way.

### Talking to the Worker, and stopping it

- **You can chat with a Worker directly** to clarify or redirect. Those messages appear on the Metric screen as `💬 You → <agent>`.
- **Stopping a Worker also stops its Reviewers.** When you press Stop on a Worker, it cancels the Reviewers it created, and the plugin also sends each running Reviewer a fixed stop notice. This is **not a hard cancel**: Paseo 0.8 gives plugins no way to cancel an agent. A stopped Reviewer takes one short turn to acknowledge. The Worker then reports where it stopped and waits for you.
- **The review budget is a behavioural guardrail.** The plugin counts the reviews, the Worker asks you before going over, and the Manager tells you when a request did. Nothing in code blocks a Worker that ignores its instructions, and one extra review can happen before you are asked.

## The Beads Manager screen

Open **Beads Manager** in Paseo's sidebar. It opens on **Setup** (below); the **Workspaces** button at the top lists the workspaces on this host, most recent activity first, and ← goes back to Setup. Each workspace in that list has three buttons:

| Button | Opens |
|---|---|
| **Go to** | The workspace's Beads Manager chat. A Manager is created the first time. |
| **Metric** | [What each request did](#metric-what-each-request-did). |
| **Beads** | [The workspace's beads](#beads-the-workspaces-beads). |

Under each workspace name, four small figures show the beads in total, in progress and blocked, and how many Workers are running right now — in progress, blocked and running Workers read in plain text above zero and grey at zero, the total stays grey, and no colour has to be learnt (they refresh every few seconds while the list is open). A dot next to the name pulses while one of its paseo-bm agents is working. The three buttons stay on one line, on a phone too. From Metric or Beads, ← goes back to the list.

**Setup** is where the screen opens. It has three tabs — **Beads tools**, **Agent skills** and **Agents** — and shows one of them at a time; what the screen has to tell you (a missing tool, a failed check) stays above the tabs, so no tab can hide it.

- **Beads tools.** Whether `br` and `bv` are on the PATH the Paseo daemon uses, their versions, and whether a newer one is known. A missing tool has an **Install** button that runs the same command as [install](#what-the-interactive-install-asks) after you confirm it. Updating is never run for you: the screen shows the command to copy.
- **Agent skills.** Each required and optional skill, for Claude Code and for Codex: installed, missing, or broken (unreadable `SKILL.md` or a wrong `name:`). **Test** checks again. The equivalent `skills add` command is shown to copy; the plugin never installs skills.
- **Agents.** Each role's provider, model, thinking and mode, with an Edit form, and its fallback chain where one is offered. Below them, **additional instructions**: a text box per role (Manager, Worker, Reviewer). What you save is added **after** the built-in instructions, under a heading that says it cannot override the rules. **Preview** shows the full instructions an agent will get. It applies to agents created after you save; running agents keep what they started with. The text is stored in `~/.paseo-bm/role-extras.json`.

**Closed workspaces with history** (at the end of the Workspaces list) lists workspaces that were archived or removed from Paseo but still have recorded traces, with their last name, path, last activity and history size. Press **Metric** to read that history.

**The Beads tab.** Every workspace can also show its beads in a tab of its own: open the **+** menu of the workspace's tab bar (on a phone, the New tab screen) and choose **Beads**. The tab has two sub-tabs, **Beads** and **Metric**, with the same screens as below, without the ← and the title.

The workspace Command Center also has **Open Beads Manager** and **Open Beads Metric**. Two panels complete it: **Beads agents** (per workspace) shows the Manager → Worker → Reviewer tree with each agent's status, and **Beads in this chat** (per agent) lists the beads a chat named — see [Message cards](#message-cards-in-the-chat).

## Metric: what each request did

The Metric screen answers what chat cannot: what a request turned into, how long it took, what it cost, whether it created beads, and which steps of the process actually ran. Apart from the delete and reassign buttons, it only reads.

**Top of the screen**

- **Overview cards:** requests (running, waiting, done), **errors**, beads, agents (Workers and Reviewers), messages sent and received, tokens (input, cached, output), and estimated cost.
- **Errors** counts how many times a request went wrong, for any reason: a turn that ended failed, an agent left in Paseo's error state, and every provider-plan incident (usage limit, login, provider down). It says how many requests are affected and breaks the number down. Each failure counts once — a request you asked three follow-ups on is still one request, and a usage limit that killed a turn is one error, not three. With nothing to report it says "no error recorded".
- **Requests, last 7 days** as a bar chart.
- **Top 5 heaviest Workers** by tokens. Press one to open that Worker.

**Each request as a graph**

Each request is a small graph: **Manager → Workers → Reviewers**. Each node carries a small role icon on a soft tint, explained in a legend above the list: a chat bot for the Manager, a hammer for a Worker, an eye for a Reviewer. Press the request to open it, then press a node to expand it.

| Node | Expands into |
|---|---|
| Manager (request) | What you asked, the Manager's last answer, duration, tokens and cost, the beads created and closed with their current status, your messages to the Manager, and notes. |
| Worker | Its last report, the files it changed, the checks it ran, open points and suggestions, timing, tokens and cost, and the messages you typed to it. |
| Reviewer | What it was asked to review, its verdict and number of blocking findings, timing and tokens. |

Two kinds of chips appear on the graph:

- **Workflow steps** (on the request): twelve steps, from "Size classified" through "Plan reviewed" and "Beads polished" to "Closed with evidence". Green = done, blue = done (inferred), grey = not needed for this size (or reported as not done), amber = unknown.
- **Skills** (on the request and on each agent): the agent skills each agent actually loaded.

**Numbers say how sure they are.** A value from a Worker's own report is shown plainly. A value worked out from the timeline is marked *(inferred)*. Anything that cannot be established is marked *(unknown)* rather than guessed. For example, the screen says "No beads were created" only when a Worker reported exactly that. Durations are wall-clock and include time spent waiting for you.

**Costs are estimates, not an invoice.** Cost is estimated from the tokens of each turn with a price table shipped in this version, and the table's date is shown beside the number. Cached input tokens are priced at the cache rate. A model that is not in the table shows tokens only, never a guessed price; a request that mixes priced and unpriced models shows the priced part and says how many tokens were left out. The session totals some providers report are not used, because they cannot be split per request.

## Beads: the workspace's beads

The Beads screen reads `.beads/issues.jsonl` in the workspace directly. It **never writes the bead store**.

**Overview**

1. **Status cards:** total, ready, in progress, blocked, closed. These match `br stats` and `br ready`.
2. **Progress:** closed out of total. The same figure sits at the top of the screen as `✓ <closed> / <total> done`.
3. **By type.**
4. **By priority.**
5. **Time:** median time to close, the bead longest in progress, and stale beads (open with no update for 7 days or more).

**The board**

- Search by id or title.
- Filter by status, type, priority and labels. Labels are grouped by category (the part before `:`, such as `feature:` or `area:`). Each group shows its most common values first, and the rest are one tap away. Active filters appear as chips you can remove.
- Sort by updated, created or closed time, or by priority.
- Beads are laid out as a **board**, one column per status, in this order: **In progress**, **Blocked**, **Ready**, **Closed**, each with its size. Filters apply first, and the sort you chose applies inside each column. A column with nothing in it stays where it is and says so, so the board does not jump about while you filter. Each column shows its first 100 beads and says how many it left out.
- **The board follows the width.** Wide enough for two columns or more (a desktop window) and they sit side by side, as many per row as fit. Narrower than that — a phone, or a slim window — and you get one column at a time, picked from a row of status tabs that carry the counts.
- **Closed beads are shown**, as a column like the others. The eye button hides them again (it shows how many there are), and that choice lasts until you reload the app.
- Each row shows the bead's **title first**, in plain text while there is still work in it and dimmed once it is closed — the words on the status chip say which status it is, so nothing depends on colour. The id, type, priority and status are on the line below.
- **Beads in progress say who is on them:** the Worker, since when, how long it has been, and whether that Worker is running, idle or gone. This comes from the recorded Worker commands (`br update <id> --status in_progress` or `--claim`) and reports. When no such command was recorded, the screen says the start is not recorded and shows the Worker's last activity instead of guessing.

**Detail**

Press a bead to see who is working on it (with a button to open that Worker), its description rendered as Markdown, its labels, its dependencies and children, and its close reason. Three actions are available, each confirmed first. What an action reported stays on the bead even when the next refresh moves it to another column; a confirmation you had open but not answered closes when the bead moves.

| Action | What happens |
|---|---|
| **Assign a Worker** | The Manager gets the request and a Worker implements the bead until it is closed with evidence. |
| **Delete** | A Worker checks whether the bead is still needed. It deletes it with `br` only if it is not, and reports why either way. |
| **Close** | A Worker checks the acceptance criteria and what the bead depends on. It closes the bead with evidence only if both are satisfied, and otherwise reports what is missing. |

Each action is sent to the workspace's Manager as a normal request (a Manager is created if the workspace has none). It follows the usual size rules, reports and review budget, and appears on the Metric screen like any other request.

## Trace storage

Records live in `~/.paseo-bm/traces/`: one directory per workspace, one file per month. Directories are `0700` and files are `0600`. Secrets are masked before anything is written.

- **paseo-bm never deletes traces on its own.** There is no retention period, no rotation and no automatic clean-up. When the store grows past a threshold, the Metric screen warns you and points at the delete buttons.
- **On the Metric screen you can delete** one request, every trace older than 30 days, or every trace of the workspace.
- **Every deletion shows first** how many traces and how many bytes will go, and how many of those requests are still running. It then asks you to confirm, and the safe answer is the default.
- **Deletion is irreversible.** There is no undo and no bin.
- Deleting traces removes only paseo-bm's own recording. Your beads, documents, agents and Paseo conversations are untouched.
- Updating paseo-bm never deletes the store.

**Closed or removed workspaces keep their history.** It appears under **Closed workspaces with history** on the Beads Manager screen. If you remove a workspace from Paseo and later open the same project again, Paseo gives it a new workspace id. The old history's Metric screen offers to **reassign** it onto a workspace that exists, or you can delete it. paseo-bm never makes that link on its own, because two workspaces on the same path are not necessarily the same line of work.

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
stops rather than quietly using the default, which would split your data across two places. **Setup →
This install** shows the folder it is using and how it was found.

| Path | What it is |
|---|---|
| `~/.paseo-bm/traces/` | The Metric screen's records: `meta.json`, plus one directory per workspace with `meta.json` and `events-<YYYYMM>.jsonl`. **Your data**: an update never touches it. Delete it from the Metric screen. |
| `~/.paseo-bm/role-extras.json` | Your additional role instructions from the Setup screen. Your data. |
| `~/.paseo-bm/role-fallback.json` | Your fallback chains from Roles & models: each role's policy and fallback entries (provider, model, thinking, mode), plus optional detection `patterns` you edit by hand. Your data. |
| `~/.paseo-bm/role-fallback-state.json` | The fallback incidents: each agent that stopped on its provider plan, what was chosen on its card, and the replacement. At most 200 are kept. Your data. |
| `~/.paseo-bm/ui/` | Small files of the plugin's own: `answer-marks.json` ("Mark as answered"), `qa-ledger.json` (the questions-and-answers ledger), `budget-told.json` (which review-budget overruns were announced), `agent-tools.json` (the port of the agents' tool endpoint), and `setup-state.json` (what Setup has done: which roles were created, whether paseo-bm turned Paseo's agent tools on and what they were before, the last skills run, and whether you removed paseo-bm's settings). |
| `~/.paseo-bm/home.json` | A pointer to a data folder somewhere else, written **only** by `npx paseo-bm@0.4.0` when it migrates an install that used `--home`. Delete the file to drop the pointer. |

Files a 0.3.x install left behind — `install.json`, `plugin/<version>/` and `backups/` — are read by
nothing in 0.4.0 and are never deleted by it. After migrating you can delete `plugin/` and `backups/`
by hand.

Every write goes to a temporary file first, is `fsync`ed and then renamed into place, with mode
`0600` and a check that no component of the path is a symlink. A run killed mid-write can leave a
`*.tmp-*` file beside its target; it is safe to delete.

### Paseo config: `~/.paseo/config.json`

paseo-bm **never** edits this file itself. Everything below goes through Paseo's own API
(`config.patch`), and every write is read back afterwards.

| Key | What paseo-bm writes | When |
|---|---|---|
| `agents.providers.bm-manager`, `agents.providers.bm-worker`, `agents.providers.bm-reviewer` | A derived provider `{ extends, label, paseoTools }` (the Reviewer gets no `paseoTools`) that reuses your existing provider login, with no command and no environment | Created when missing, the first time you open Beads Manager or Setup. An entry that already exists is never changed. |
| `daemon.agentProfiles[]` entries whose `id` starts with `bm-` | The role's provider, model and name, appended at the end. Other profiles and their order are left untouched. | Same as above; afterwards, only when you save in Roles & models. |
| `agents.providers.bm-<role>-fallback-<n>` (n = 1…3) | A derived provider for each entry of a role's fallback chain | When you save a fallback chain in Setup → Roles & models |
| `daemon.mcp.injectIntoAgents` | `true`; the previous value is recorded in `ui/setup-state.json` first | **Only** when you press **Allow agent tools…** and confirm. Set back to the recorded value by **Remove paseo-bm's settings**. |

`pluginsEnabled` and `plugins` belong to Paseo: paseo-bm never writes either. The migration command
`npx paseo-bm@0.4.0` writes only `<install home>/install.json`, `<install home>/ui/setup-state.json`
and `~/.paseo-bm/home.json`, and calls `paseo plugin remove|add` — it does not touch `config.json`.

### What paseo-bm never writes

- **Agent skills.** paseo-bm only reads skills directories. Skills are put there by the third-party `skills` CLI, and only when you press **Install skills** and confirm.
- **Beads tools.** paseo-bm does not write `br` or `bv` itself: it runs Homebrew or the projects' own install scripts, after showing you the command.
- Credentials and provider logins: never read, stored or printed. paseo-bm does not run login commands.
- Plugins, providers or profiles created by you or by other tools. Only `bm-*` entries belong to paseo-bm.
- Your repository, from the plugin: the Beads screen and the Metric screen only **read** `.beads/issues.jsonl`. Changes to your repository come from the agents you ask for work.
- Existing agents in Paseo. They are yours, and removal leaves them in place.

## Agent skills

The Worker follows the **feature-workflow** process, which comes from a set of agent skills. paseo-bm runs without them, but **the Worker's results are noticeably worse without them**, so paseo-bm checks for them. Role instructions take precedence over any skill.

- **Source:** https://github.com/cuongntr/agent-skills. This is **another author's repository** (`cuongntr`). paseo-bm does not bundle, maintain, fork or patch these skills.
- **Required skills** (checked and warned about): `feature-workflow`, `reviewing-plan`, `converting-plan-to-beads`, `polishing-beads`, `implementing-beads`.
- **Optional skills** (suggested only): `architecture-premise-audit`, `authoring-workspace-protocol`.
- **Where paseo-bm looks** (read-only): `~/.agents/skills`; Claude Code's `~/.claude/skills` (follows `--claude-home` or `CLAUDE_CONFIG_DIR`); Codex's `~/.codex/skills` (follows `--codex-home` or `CODEX_HOME`). Symlinked skills count as present. Only names are compared, not versions.

When required skills are missing, **Setup → Agent skills** shows the exact command and an **Install
skills…** button. Pressing it asks once more, then runs that command — and only that command, which
is a constant: nothing you type reaches the shell. The run has a 300-second limit, its output is
shown with secrets masked, and Setup records when it last ran and with what exit code. The command:

```bash
npx -y skills add cuongntr/agent-skills -g -a claude-code codex -s feature-workflow reviewing-plan converting-plan-to-beads polishing-beads implementing-beads -y
```

You can also run this command yourself; Setup has a Copy button for it.

- **Skills are installed as symlinks**, so all your agents share **one copy** of each skill.
- **The `skills` CLI is a third-party tool with its own data collection.** paseo-bm's no-telemetry promise does not cover it.
- A failure, a timeout (300 seconds) or a missing network is reported on Setup and changes nothing else. The agents keep working, with lower quality.
- paseo-bm never removes skills, and removing paseo-bm does not touch them. Remove them with the `skills` CLI (`npx skills --help`).

The plugin checks the Worker's required skills for the provider the Worker runs on, and the Manager tells you once, with the command to add them, if the Worker will run without them. It still hands over the work.

## Checking health

Everything the retired `doctor` command reported is on the **Setup** screen while the plugin is
running: the three roles and their models, Paseo's agent-tools switch and who turned it on, each
provider's sign-in, the required skills per agent, `br` and `bv`, the data folder and how it was
found, and which kind of install this is.

If the plugin does **not** load at all, Setup cannot tell you anything. Ask Paseo instead:

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
any model or mode you changed yourself.

Downgrading is supported only **within 0.4.0 and later**. Going back to 0.3.x is not a rollback: a
0.3.x plugin does not trust a data folder whose `install.json` is missing or marked as migrated, so
it would find no history. If a 0.4.x release breaks something for you, the way back is a later
0.4.x.

## Removing paseo-bm

Two steps, in this order.

1. **Setup → Remove paseo-bm's settings…**, then confirm. This removes every `bm-*` provider and
   agent profile from Paseo (the three roles and their fallback aliases) and, if paseo-bm turned
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

What the button never touches: agents you already created (archive them yourself — they will fail on
their next turn without their role), your skills, `br` and `bv`, and anything in the data folder that
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

Start at **Setup**: it shows the state of every setup item and the reason for whatever is wrong. If
the plugin does not load at all, Setup cannot help — ask Paseo with `paseo plugin ls` and
`paseo plugin logs paseo-bm`.

**Beads Manager does not appear in Paseo**

- `paseo plugin ls` — check a plugin's `status` (`running` or `disabled`), not its `enabled` field.
- `paseo plugin logs paseo-bm` shows Paseo's reason.
- Paseo's own **plugins** switch is Paseo's, not paseo-bm's: with plugins off, no plugin code runs at
  all. Turn it on in Paseo's settings.
- On Paseo 0.8 the plugin is refused on purpose (it declares `>=0.9.0`). Upgrade Paseo, or keep
  `paseo-bm@0.3.1`.

**Beads Manager will not open, or the Manager cannot create a Worker**

Almost always Paseo's agent-tools switch. While it is off, opening Beads Manager stops with `Paseo's agent tools are off…` instead of starting a Manager that could never create a Worker. Setup says `Off — no new Beads Manager starts until you allow them` and offers **Allow agent tools…**. A provider's own `paseoTools` setting is not enough: the
machine-wide switch is what grants the tools.

Otherwise, check the Worker's provider is signed in (**Setup → Agents → Sign-in** shows the command)
and that its model still exists in Paseo. The Manager reports the exact cause when creation fails.

**`E_SETUP_ROLES_FAILED`**

paseo-bm could not create its three roles. The message says why: `Paseo reports no available
provider` means no provider is usable yet — sign in to one, then press **Try again**. `Paseo lists no
model for <provider>` means that provider is available but has no models. A refused patch is Paseo
declining the write; `paseo plugin logs paseo-bm` has the detail.

**`E_DATA_HOME_UNAVAILABLE`**

paseo-bm cannot use its data folder, so history and settings are off. **Setup → This install** shows
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

**Setup → Beads tools** shows whether `br` and `bv` are on the `PATH` the Paseo daemon uses (which can
differ from your terminal's) and installs a missing one after you confirm. A script install puts the
tool in `~/.local/bin`; add that directory to the daemon's PATH if the warning says so.

**Metric shows *(unknown)* for a request, or a request has no request text**

Recording starts at the first turn after the plugin loads, so a request that began earlier is only
partly recorded. A request whose agents were deleted still shows what was recorded, with a note.

**The Beads screen is empty**

The workspace has no `.beads/issues.jsonl`, or the workspace is no longer listed by Paseo (see
[Known limits](#known-limits)).

**Migration problems**

See [Coming from the `npx` install](#coming-from-the-npx-install) for the exit codes. Exit `7` means
the npm plugin would not load and your directory install was put back — nothing was lost; read
`paseo plugin logs paseo-bm` before trying again.

## Known limits

- **Rules for the agents are instructions, not code.** The review budget, "only do what was asked" and the Worker's safety boundaries depend on the model following its role instructions.
- **Stopping is not a hard cancel** (Paseo 0.8 has no plugin cancel).
- **Beads of a closed workspace are not shown.** Its Metric history is still readable from **Closed workspaces with history**.
- **Costs are estimates** from a bundled price table.
- **Only paseo-bm's own messages become chat cards**; a Worker's ordinary chat text stays plain (use the **Beads in this chat** panel for its beads).
- **Additional role instructions apply to agents created after you save them**, and they are machine-wide: they apply to every workspace.
- **Paseo has no uninstall hook**, so removing paseo-bm's configuration is a button you press before removing the plugin.
- Not available yet: suggested extra agent profiles, a limit on parallel Workers, report export, views across several workspaces, remote daemons, Windows support, and a code-enforced review budget.
