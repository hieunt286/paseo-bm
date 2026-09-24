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
- [Checking health: `doctor`](#checking-health-doctor)
- [Updating](#updating)
- [Uninstalling](#uninstalling)
- [Command reference](#command-reference)
- [Exit codes and JSON output](#exit-codes-and-json-output)
- [Troubleshooting](#troubleshooting)
- [Known limits](#known-limits)

## Before you install: read these warnings

Installing paseo-bm asks for **one consent** that turns on **two switches** in `~/.paseo/config.json`. Both reach beyond paseo-bm.

> [!WARNING]
> **1. Plugin trust: `pluginsEnabled`.**
> Paseo plugins run **without a sandbox**. The paseo-bm plugin runs inside the Paseo daemon with the same access to your machine as the daemon itself: files, processes, credentials and network. Only enable it if you trust this package.

> [!WARNING]
> **2. Agent-creation permission: `daemon.mcp.injectIntoAgents`.**
> The Manager and the Worker need Paseo's tools to create, message and stop other agents. Paseo grants those tools to **every agent on this machine**, not only to paseo-bm's roles. Once the switch is on, any agent can create, prompt and stop other agents, which means it can start work and spend money on your model providers.

In a terminal, both switches are covered by one question, `Enable Paseo plugins and grant Paseo tools to agents?`. It defaults to **No** and is shown with the warning text above. Without a terminal, the only way to give this consent is `--enable-plugins`. **`--yes` is never consent**: it only skips the "apply" confirmation.

If you decline, the rest of the install still completes, but the plugin does not run and the Manager cannot create a Worker. The command exits with code `4`. To enable later:

```bash
npx paseo-bm install --apply --enable-plugins
```

> [!CAUTION]
> **3. Agent permission modes, and rules that only instructions enforce.**
> - **The Worker** is created in its provider's **no-prompt mode**: Claude `bypassPermissions`, Codex `full-access`, or the equivalent for other providers. Paseo does not ask you to approve its commands.
> - **The Reviewer** is created in **auto mode** (Claude `auto`, Codex `auto`), which does not grant full or network access. The plugin sets this itself when the Reviewer is created, and moves a Reviewer out of a full-access or planning mode even if the Worker asked for one.
> - **The Manager** runs in the mode of its `bm-manager` profile. Its instructions forbid doing the work itself, archiving or deleting agents, reading other agents' conversations and approving permission requests. They do **not** forbid git operations, publishing, destructive commands or reading credential files, so choose the `bm-manager` profile's mode with that in mind.
>
> The Worker's boundaries (no git commit or push, no destructive commands, no secret files, ask before dependencies, network or migrations) are enforced **only by its role instructions**. No Paseo permission prompt backs them up. Use paseo-bm in repositories where you are comfortable with that, and review `git diff` before you commit.

> [!NOTE]
> **4. Agent conversation is recorded on this machine.** From the first turn after you install, the plugin writes one record per agent turn into `~/.paseo-bm/traces/`, so the Metric screen can still show a request after its agents are deleted. Records contain the text your agents sent and received, including anything quoted from your repository. Nothing is uploaded. See [Trace storage](#trace-storage).

Your requests and source code go to the model providers you choose for each role. paseo-bm has no telemetry.

## Requirements

| Requirement | Detail |
|---|---|
| Operating system | macOS or Linux. Native Windows is refused. WSL reports itself as Linux but is not covered by testing. |
| Node.js | 22 or newer |
| Paseo | Paseo desktop with its CLI and daemon at **0.8.0 or newer**, both reporting the **same** version. The daemon must be running, which usually means the Paseo app is open. |
| `paseo` CLI | On your `PATH`: `paseo --version` must work in the shell you install from. |
| Beads tools `br` ([beads_rust](https://github.com/Dicklesworthstone/beads_rust)) and `bv` ([beads_viewer](https://github.com/Dicklesworthstone/beads_viewer)) | **Required for the agents**: the Worker manages beads with `br`, and agents use `bv`'s `--robot-*` views. You do not need them beforehand: [install](#what-the-interactive-install-asks) installs a missing one, and so can the Setup screen. |
| A logged-in agent provider | At least one provider Paseo offers (for example Claude or Codex), logged in with that tool's own login. paseo-bm never handles credentials. |
| Network | Needed for `npx` to download the package, and to install missing skills or beads tools. The plugin install itself runs locally. |

No `sudo` is needed. The npm package has no install scripts, so downloading it changes nothing on your machine until you run a command and confirm.

## Install

```bash
npx paseo-bm
```

`npx` downloads the package, runs it once and leaves nothing in your project. Every build is published under the dist-tag `next`, so **`npx paseo-bm@next` always fetches the newest prerelease**. Plain `npx paseo-bm` follows the `latest` tag, which can lag behind `next` — it is moved by hand, and while a prerelease is the newest build it may still point at an older one. `npm view paseo-bm dist-tags` shows where each tag is today.

### What the interactive install asks

Run the command in a real terminal. If you pipe its output (for example `| tee`) or pass `--json`, paseo-bm sees no terminal and asks nothing: see [non-interactive install](#non-interactive-install).

1. **Environment check.** paseo-bm checks the operating system, Node, the `paseo` CLI, the daemon, the Paseo version and whether the install home can be created. If a check fails, it stops **before writing anything**, prints a fix and exits `3`. A missing `br` or `bv` is only a warning (see step 9).
2. **Role configuration** (first install, or with `--reconfigure`). For the Manager, the Worker and the Reviewer it asks for:
   - a name (defaults: `Beads Manager`, `Beads Worker`, `Beads Reviewer`);
   - a provider, from the providers Paseo offers;
   - a model for that provider.

   Giving the Reviewer a different provider from the Worker gives the review an independent point of view. The Reviewer is the only role without Paseo tools.
3. **Preview.** Every file, Paseo registration and config key that would change is listed.
4. **`Apply these changes?`** (default No). No writes nothing. If nothing needs to change, this question is skipped and every action is reported as skipped.
5. **Plugin registration.** The payload is copied to `~/.paseo-bm/plugin/<version>/` and registered with Paseo as plugin `paseo-bm`.
6. **`Enable Paseo plugins and grant Paseo tools to agents?`** (default No). The single trust consent [above](#before-you-install-read-these-warnings). Not asked when both switches are already on.
7. **Provider login.** For a chosen provider that is not logged in, paseo-bm prints that provider's own login command and asks `Run <command> now?`. If you decline, it prints manual steps. The role stays registered either way.
8. **Agent skills.** If recommended skills are missing, paseo-bm shows the exact `skills` command and asks before running it. See [Agent skills](#agent-skills). A No is remembered; `--ask-skills-again` asks again.
9. **Beads tools.** If `br` or `bv` is missing, the preview lists the exact install commands before `Apply these changes?`, and applying installs them — no extra question. The commands:
   - with Homebrew on your PATH: `brew install dicklesworthstone/tap/br` and `brew install dicklesworthstone/tap/bv`;
   - otherwise the projects' own install scripts: `br`'s with `--skip-skills` (so nothing is written into your skills directories), and `bv`'s pinned to the commit its README names.

   A failure is only a warning (`W_BEADS_TOOLS_INSTALL_FAILED`) with the command to run yourself.
10. **Summary.** Plugin state, roles, login state, skills state, and where everything was written.

Two more questions appear only when they apply: overwriting files you edited by hand (a backup is taken first), and installing an **older** paseo-bm over a newer one.

### Non-interactive install

Without a terminal, `install` needs `--apply` to write anything. Without `--apply` it prints the preview and exits `6`. Each trust boundary needs its own flag:

```bash
npx paseo-bm install --apply --yes --enable-plugins --install-skills --install-beads-tools \
  --role manager=claude/<model> --role worker=claude/<model> --role reviewer=codex/<model> \
  --json
```

- `--enable-plugins` consents to both `pluginsEnabled` and `daemon.mcp.injectIntoAgents`. Without it the install completes and exits `4`.
- `--install-skills` allows paseo-bm to run the third-party `skills` CLI. Without it, missing skills are only a warning.
- `--install-beads-tools` allows paseo-bm to install a missing `br` or `bv` (see step 9 above). Without it, a run without a terminal only prints the commands.
- `--role <role>=<provider>/<model>` picks the tool for `manager`, `worker` or `reviewer`. A role with no `--role` and no earlier configuration gets Paseo's default provider and model, with a warning. The pair must exist in Paseo, otherwise the run stops with `E_PROVIDER_UNAVAILABLE` before writing anything.
- Installing an older version over a newer one is refused without a terminal (exit `5`).

## Working with the agents

### 1. Ask the Manager

Open the Manager with **Go to** on the [Beads Manager screen](#the-beads-manager-screen), or with **Open Beads Manager** in a workspace's Command Center. Each workspace reuses one Manager.

Describe the change in normal chat. The Manager:

- restates the request in one sentence (the Worker decides its size);
- **immediately creates one Beads Worker** in the same workspace. A follow-up to a request already in progress goes to that request's Worker instead;
- passes your request on **verbatim** and adds no requirements of its own;
- tells you the Worker and the request id (`req-<UTC time>`), and — once — any skills the Worker's tool is missing (the plugin checks them);
- replies in your language, in a few lines.

### 2. The Worker sizes the request

The Worker sizes the risk of what it designs itself — not the size of the diff, and not what you told it to carry out, which is your decision:

- **Large:** hard to undo, or it changes what others rely on.
- **Small:** one clear change that needs no document.
- **Medium:** everything else.

The Worker tells you the size and the reason. You can override it; the Worker follows your choice. Documents do not follow the size: at any size the Worker writes or updates a document only where the change touches something others rely on (a recorded decision, a contract, a schema, shipped behaviour), and a Small request writes none.

| | Small | Medium | Large |
|---|---|---|---|
| Review stages | the implementation | the implementation | the documents and beads, then the implementation |
| Reviews per stage | one, plus one re-review only if blocking findings remain | same | same |
| Review budget per request | 2 | 2 | 4 |
| Reports to the Manager | `received`, `finished` | `received`, `finished` | `received`, `beads-done`, `finished` |

Nothing waits for a confirmation before implementing; what cannot be undone still waits for your yes (below).

### 3. The Worker does only what you asked

- **Process follows what the Worker designs.** Beads, documents and reviews track and check a change the Worker designs. A request that needs none — an answer, or exactly what you already spelled out — gets none of them: the Worker does it and shows the result with its evidence. What you spelled out is also your yes, so it does not ask again. Any part that does need its design is handled like any change.
- **Anything beyond the request is a suggestion, not work.** Extra tests, refactors, docs, clean-ups and related bugs are listed as `Suggestion (not done): …`. The Manager asks you whether any of them should become new work.
- Before creating a bead, the Worker looks for open beads with the same `feature:<slug>` label. It updates a single match instead of creating a duplicate, and **asks you** when several match.
- Every bead it creates carries a `feature:<slug>` label and a short `## Provenance` naming the request. The beads of a plan follow the `converting-plan-to-beads` contract (objective, scope in and out, components, validation, primary proof, reversibility, …); every bead holds **one outcome** that can be reviewed and reverted on its own; beads are never sized by file, line or bead counts.
- When it writes a plan it runs `reviewing-plan` on it and `polishing-beads` on the beads converted from it. These are its own quality passes: they never replace a Reviewer and do not count against the review budget.
- It works on one bead at a time (with `implementing-beads` when there is more than one), runs the check that proves the bead, and **closes the bead with that evidence right away**. When all beads are closed, the implementation is reviewed once; a bead with a blocking finding is reopened, fixed and closed again with new evidence.
- **It decides what can be undone, and asks only four things.** Inside your request, choices it could reverse later — the approach, names, layout, test shape, the order of beads, whether a document needs updating — are its own; it lists them on its report's `decided` line so you can overturn any of them. It asks you only about the scope (widening, narrowing, adding a requirement), about what cannot be undone or an approved decision (editing a frozen document, deviating from an approved one, changing an existing bead's acceptance criteria, deleting or merging beads, changing an approved design because a Reviewer asked), about what only you have (something you must type or do, the environment, a security trade-off, behaviour existing users rely on), and when it is stuck. Questions it can already see come in one round right after sizing, as one numbered list (at most five) with options and a recommendation. For those it waits for your answer and never assumes one.
- It **asks you first** before installing or upgrading dependencies, using the network, running migrations on real data, deploying or publishing, editing frozen documents, widening the scope, or deleting or merging beads.
- Outside the repository it writes only into a temporary directory it has just created and deletes before reporting.
- **Five limits hold whatever the request:** nothing leaves the workspace without your explicit yes (commit, push, pull request, deploy, publish, network, dependency install, real-data migration, elevated privileges); nothing the Worker did not create is destroyed or touched, including the changes that were already in the tree and your agents; secrets are never read or copied; **no check is ever made to look green** — a test, an assertion or an acceptance criterion is never weakened so something passes, and a bead is never closed on a check the Worker did not watch pass; and nothing only you can decide is decided for you. You review `git diff` and decide.

### 4. A Reviewer checks each batch

Reviews are grouped by stage (see the table); documents are reviewed before implementing only for a Large request or when you ask. For each stage the Worker creates one Reviewer, fixes **blocking** findings, and sends that same Reviewer one re-review. It does not fix non-blocking findings; they become suggestions. If blocking findings remain after the re-review, the Worker **stops and asks you**. The plugin, not the Worker, counts the review calls of each request (see the next section).

The Reviewer checks each stage against criteria from the workflow skills: the PRD and design gates for documents, `reviewing-plan` (review-only) and the plan-ready gate for a plan, the leaf and readiness checklists for beads, and the split triggers and risk table of `implementing-beads` for the implementation. It may run the repository's tests and throwaway probe scripts, but it changes nothing, uses no network and installs nothing. For authentication, permissions, data or a public contract it lists the abuse and edge cases it tried. Hardening beyond your request is a suggestion, not a blocker, unless it is a real defect in what was built.

### 5. Reports, and when things finish

The Worker sends a structured `BM-REPORT` to the Manager only at the moments listed in the table, plus `blocked` when it needs you. Each report lists the skills the Worker used (`skillsUsed`). The Manager relays: it passes your answers to the Worker word for word, shows you every question of a `blocked` report, and never approves or changes the Worker's plan itself. The plugin counts every request's review calls from the conversation — the same number the Metric screen shows. Before any review beyond its budget, the Worker asks you in its `blocked` card, and a yes covers what you said it covers ("one more", "until it is clean"). When a request goes over its budget, the plugin tells the Manager once, and the Manager tells you the numbers in one line without asking again; it never cancels on that notice alone. The Manager still cancels a Worker that is stuck or off course, and tells you why. When a Worker finishes, the Manager tells you how many decisions it made on its own (its `decided` line), any of which you can overturn. When you ask how the work is going, the Manager reads the Worker's and its Reviewers' status and recent activity instead of asking the Worker.

**The blocks are built by tools.** Every Manager, Worker and Reviewer created after you install gets one tool from the plugin — `bm_answers`, `bm_report` or `bm_review` — that builds its block from a schema and refuses a field that breaks it, so the agent fixes it in the same turn instead of receiving a `BM-FORMAT` notice later. The text of the block is unchanged, so cards, Metric and older records read it as before. The plugin serves these tools on `127.0.0.1` only, to paseo-bm's own agents, and they only build text: they read, write and send nothing. The tools are given only to agents on Claude, Codex or OpenCode, the providers Paseo can pre-approve a tool for; on any other provider Paseo would refuse to create the agent at all, so there the agent writes the block itself, as do agents created before the update.

When a Worker finishes, it stays idle for you to inspect. **Only you archive or delete agents.** The Manager may cancel a Worker's run, but no agent archives or deletes another.

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

Under each workspace name, four small figures show the beads in total, in progress (yellow) and blocked (red), and how many Workers are running right now (they refresh every few seconds while the list is open). A dot next to the name pulses while one of its paseo-bm agents is working. The three buttons stay on one line, on a phone too. From Metric or Beads, ← goes back to the list.

**Setup** is where the screen opens:

- **Beads tools.** Whether `br` and `bv` are on the PATH the Paseo daemon uses, their versions, and whether a newer one is known. A missing tool has an **Install** button that runs the same command as [install](#what-the-interactive-install-asks) after you confirm it. Updating is never run for you: the screen shows the command to copy.
- **Agent skills.** Each required and optional skill, for Claude Code and for Codex: installed, missing, or broken (unreadable `SKILL.md` or a wrong `name:`). **Test** checks again. The equivalent `skills add` command is shown to copy; the plugin never installs skills.
- **Additional instructions.** A text box per role (Manager, Worker, Reviewer). What you save is added **after** the built-in instructions, under a heading that says it cannot override the rules. **Preview** shows the full instructions an agent will get. It applies to agents created after you save; running agents keep what they started with. The text is stored in `~/.paseo-bm/role-extras.json`.

**Closed workspaces with history** (at the end of the Workspaces list) lists workspaces that were archived or removed from Paseo but still have recorded traces, with their last name, path, last activity and history size. Press **Metric** to read that history.

**The Beads tab.** Every workspace can also show its beads in a tab of its own: open the **+** menu of the workspace's tab bar (on a phone, the New tab screen) and choose **Beads**. The tab has two sub-tabs, **Beads** and **Metric**, with the same screens as below, without the ← and the title.

The workspace Command Center also has **Open Beads Manager** and **Open Beads Metric**. Two panels complete it: **Beads agents** (per workspace) shows the Manager → Worker → Reviewer tree with each agent's status, and **Beads in this chat** (per agent) lists the beads a chat named — see [Message cards](#message-cards-in-the-chat).

## Metric: what each request did

The Metric screen answers what chat cannot: what a request turned into, how long it took, what it cost, whether it created beads, and which steps of the process actually ran. Apart from the delete and reassign buttons, it only reads.

**Top of the screen**

- **Overview cards:** requests (running, waiting, done), beads, agents (Workers and Reviewers), messages sent and received, tokens (input, cached, output), and estimated cost.
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

**List**

- Search by id or title.
- Filter by status, type, priority and labels. Labels are grouped by category (the part before `:`, such as `feature:` or `area:`). Each group shows its most common values first, and the rest are one tap away. Active filters appear as chips you can remove.
- Sort by updated, created or closed time, or by priority.
- The list is split into four groups, in this order: **In progress**, **Blocked**, **Ready**, **Closed**, each with its size. Filters apply first, and the sort you chose applies inside each group.
- **Closed beads are hidden** until you press the eye button (it shows how many there are). The choice lasts until you reload the app.
- Each row shows the bead's **title first**, coloured by status (accent = ready, yellow = in progress, red = blocked, green = closed), with its id, type, priority and status on the line below.
- **Beads in progress say who is on them:** the Worker, since when, how long it has been, and whether that Worker is running, idle or gone. This comes from the recorded Worker commands (`br update <id> --status in_progress` or `--claim`) and reports. When no such command was recorded, the screen says the start is not recorded and shows the Worker's last activity instead of guessing.

**Detail**

Press a bead to see who is working on it (with a button to open that Worker), its description rendered as Markdown, its labels, its dependencies and children, and its close reason. Three actions are available, each confirmed first:

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
- Updating paseo-bm never deletes the store, including `install --prune`.

**Closed or removed workspaces keep their history.** It appears under **Closed workspaces with history** on the Beads Manager screen. If you remove a workspace from Paseo and later open the same project again, Paseo gives it a new workspace id. The old history's Metric screen offers to **reassign** it onto a workspace that exists, or you can delete it. paseo-bm never makes that link on its own, because two workspaces on the same path are not necessarily the same line of work.

### The storage warning threshold

Set it in Paseo settings → **Beads Dashboard**. The default is 200 MB. Paseo stores plugin settings per machine, so **this threshold applies to every workspace on this machine**. A value that is not a positive number is refused, and the previous threshold stays in force.

## Everything paseo-bm writes

This is the complete list. paseo-bm writes nowhere else.

### Install home: `~/.paseo-bm/**`

Change the location with `--home <dir>` or `PASEO_BM_HOME`. paseo-bm refuses an install home that is, or contains, your home directory, Paseo's directory or an agent configuration directory.

| Path | What it is |
|---|---|
| `~/.paseo-bm/plugin/<version>/` | The plugin payload for each installed version, including `roles/manager.md`, `roles/worker.md` and `roles/reviewer.md`. Older versions are kept until you run `install --prune`. |
| `~/.paseo-bm/install.json` | The install record and the source of truth for what paseo-bm owns: version, a hash of every file, Paseo config changes and their previous values, roles, and skills-step state. Do not edit or delete it by hand. |
| `~/.paseo-bm/backups/<timestamp>/` | A copy of `config.json` taken before paseo-bm edits it (`paseo-config.json`), and copies of files paseo-bm deliberately overwrote. Kept until you prune them or remove them at uninstall. |
| `~/.paseo-bm/traces/` | The Metric screen's records: `meta.json`, plus one directory per workspace with `meta.json` and `events-<YYYYMM>.jsonl`. This is **your data**, not part of the payload: it has no hash in `install.json`, it is never backed up, and installing or updating never touches it. Delete it from the Metric screen. |
| `~/.paseo-bm/role-extras.json` | Your additional role instructions from the Setup screen. Like `traces/`, this is **your data**: no hash in `install.json`, never touched by an update or `--prune`. |
| `~/.paseo-bm/role-fallback.json` | Your fallback chains from Roles & models: each role's policy and fallback entries (provider, model, thinking, mode), plus optional detection `patterns` you edit by hand. Your data, like `role-extras.json`. |
| `~/.paseo-bm/role-fallback-state.json` | The fallback incidents: each agent that stopped on its provider plan, what was chosen on its card, and the replacement. At most 200 are kept. Your data, like `role-extras.json`. |
| `~/.paseo-bm/ui/` | Small files of the plugin's own: the "Mark as answered" marks, the questions-and-answers ledger, and `agent-tools.json`, the port of the agents' tool endpoint (see [Reports](#5-reports-and-when-things-finish)). |
| `~/.paseo-bm/.lock` | Process lock held while `install` or `uninstall` runs. `doctor` never takes it. |

### Paseo config: `~/.paseo/config.json`

The location follows `--paseo-home <dir>`, `PASEO_HOME`, or the directory the Paseo daemon reports. A backup is taken first, and only these keys are touched:

| Key | What paseo-bm writes | When |
|---|---|---|
| `pluginsEnabled` | `true` | Only with the trust consent |
| `daemon.mcp.injectIntoAgents` | `true`; the previous state is recorded so uninstall can restore it | Only with the trust consent (the same single consent) |
| `agents.providers.bm-manager`, `agents.providers.bm-worker`, `agents.providers.bm-reviewer` | A derived provider `{ extends, label, paseoTools }` that reuses your existing provider login, with no command and no environment | Role registration |
| `daemon.agentProfiles[]` entries whose `id` starts with `bm-` | The role's provider, model and name. Other profiles and their order are left untouched. | Role registration |
| `agents.providers.bm-worker-fallback-<n>` (n = 1…3) | A derived provider `{ extends, label, paseoTools }` for each entry of the Worker's fallback chain, written by the plugin through Paseo's API. Removed with every other `bm-*` entry at uninstall. | When you save a fallback chain in Beads Manager → Setup → Roles & models |

The `plugins` key is written **by Paseo** when paseo-bm runs `paseo plugin install`. After uninstall, Paseo leaves an empty `plugins: {}` behind; that key belongs to Paseo.

### Temporary files

Every write goes to a temporary file first and is then renamed into place. If a run is killed mid-write, a leftover file such as `~/.paseo/.config.json.<pid>.<hex>.tmp` (or the same pattern beside a file in the install home) may remain. It is safe to delete once no paseo-bm command is running.

### What paseo-bm never writes

- **Beads tools.** paseo-bm does not write `br` or `bv` itself: it runs Homebrew or the projects' own install scripts, as described in [Install](#install).
- **Agent skills.** paseo-bm only reads skills directories. Skills are installed and removed only by the third-party `skills` CLI, and only when you consent.
- Credentials and provider logins: the installer and the plugin never read, store or print them.
- Plugins, providers or profiles created by you or by other tools. Only `bm-*` entries belong to paseo-bm.
- Your repository, from the plugin: the Beads screen and the Metric screen only **read** `.beads/issues.jsonl`. Changes to your repository come from the agents you ask for work.
- Existing agents in Paseo. They are yours, and uninstall leaves them in place.

## Agent skills

The Worker follows the **feature-workflow** process, which comes from a set of agent skills. paseo-bm runs without them, but **the Worker's results are noticeably worse without them**, so paseo-bm checks for them. Role instructions take precedence over any skill.

- **Source:** https://github.com/cuongntr/agent-skills. This is **another author's repository** (`cuongntr`). paseo-bm does not bundle, maintain, fork or patch these skills.
- **Required skills** (checked and warned about): `feature-workflow`, `reviewing-plan`, `converting-plan-to-beads`, `polishing-beads`, `implementing-beads`.
- **Optional skills** (suggested only): `architecture-premise-audit`, `authoring-workspace-protocol`.
- **Where paseo-bm looks** (read-only): `~/.agents/skills`; Claude Code's `~/.claude/skills` (follows `--claude-home` or `CLAUDE_CONFIG_DIR`); Codex's `~/.codex/skills` (follows `--codex-home` or `CODEX_HOME`). Symlinked skills count as present. Only names are compared, not versions.

When required skills are missing, paseo-bm shows the exact command and asks before running it. Without a terminal, it runs the command only with `--install-skills`. Target agents come from `--skills-agents` (default `claude,codex`; `claude` is passed as `claude-code`). With the defaults, the command is:

```bash
npx -y skills add cuongntr/agent-skills -g -a claude-code codex -s feature-workflow reviewing-plan converting-plan-to-beads polishing-beads implementing-beads -y
```

You can also run this command yourself.

- **Skills are installed as symlinks**, so all your agents share **one copy** of each skill.
- **The `skills` CLI is a third-party tool with its own data collection.** paseo-bm's no-telemetry promise does not cover it.
- A skills failure, a timeout (300 seconds) or a missing network never blocks the install and never changes the exit code.
- paseo-bm never removes skills, and `uninstall` does not touch them. Use the `skills` CLI (`npx skills --help`).

The Manager also checks skills after it delegates each request, and tells you if the Worker will run without them.

## Checking health: `doctor`

```bash
npx paseo-bm doctor
```

`doctor` is **read-only**. It writes nothing, takes no lock, uses no network, never runs the `skills` CLI, and calls only `paseo daemon status` and `paseo plugin ls`. It reports each check with a fix:

| Area | Check ids |
|---|---|
| Paseo | `paseo-daemon`, `paseo-version` |
| Install record | `install-record`, `install-version` |
| Payload files | `files-missing`, `files-modified` |
| Plugin | `plugin-registered`, `plugin-status`, `plugin-path` |
| Consent switches | `plugins-enabled`, `agent-tools` |
| Roles | `role-bm-manager`, `role-bm-worker`, `role-bm-reviewer` |
| Housekeeping | `payload-versions`, `backups` |
| Warnings only | `beads-cli`, `beads-viewer`, the per-agent skills checks, provider login state |

Exit codes: `0` healthy, `1` drift in what paseo-bm owns, `2` misuse. Warnings never change the exit code. After an uninstall, `doctor` reports that paseo-bm is not installed.

## Updating

Run the installer again: `npx paseo-bm@next` takes the newest prerelease, and `npx paseo-bm` whatever the `latest` tag points at — which may be older than `next`. Check with `npm view paseo-bm dist-tags`.

- **New version.** The payload is copied into a new `~/.paseo-bm/plugin/<new version>/`. Paseo 0.8 cannot re-point a directory plugin, so paseo-bm runs `paseo plugin remove paseo-bm` and then `paseo plugin install <new dir>`; the plugin is absent for a few seconds. If the new version fails to register or load, paseo-bm reinstalls the previous directory, keeps the record on the old version, and exits `7` with Paseo's error message.
- **Same version.** Nothing to change: nothing is asked and the exit code is `0`. Files repaired or changed in the active plugin directory: paseo-bm **reloads the plugin** and waits for `running`.
- **Files you edited by hand** are never overwritten silently. On a terminal you are asked, and a backup is taken first. Without a terminal they are kept unless you pass `--force`.
- **Downgrade** (older over newer) needs an explicit answer on a terminal.
- **Role changes:** `npx paseo-bm install --reconfigure` asks the role questions again.
- **Clean up:** `npx paseo-bm install --apply --prune` removes old payload versions and backups. It never removes the version in use or files you edited, and it always keeps the newest Paseo config backup.

paseo-bm never restarts or stops the Paseo daemon. Updating replaces or reloads the plugin, and turns that end during those seconds are not recorded, so update while no Beads agent is working.

## Uninstalling

```bash
npx paseo-bm uninstall          # preview only
npx paseo-bm uninstall --apply  # remove, after confirmation
```

Uninstall removes **only what `install.json` says paseo-bm owns**. It unregisters the `paseo-bm` plugin, deletes the `bm-*` providers and profiles (and any config container it created that is now empty), puts `daemon.mcp.injectIntoAgents` back to its recorded previous state, and deletes the payload.

It asks, each defaulting to No:

1. `Uninstall paseo-bm as shown above?` (skipped with `--yes`)
2. `paseo-bm turned Paseo plugins on and no other plugin is installed. Turn plugins off again?` (only when that is true)
3. `Also remove paseo-bm's backups? This cannot be undone.`

**Questions 2 and 3 are interactive-only.** Without a terminal, plugins stay enabled and backups are kept.

What stays, on purpose:

- **Files you edited by hand** are kept and listed. `--force` deletes them too, after backing them up.
- **Backups**, unless you chose to remove them.
- **`install.json`, when the Paseo daemon is not running.** Run `uninstall --apply` again once Paseo is running.
- **Your additional role instructions** (`~/.paseo-bm/role-extras.json`), **your fallback chains** (`~/.paseo-bm/role-fallback.json`) and **the fallback incidents** (`~/.paseo-bm/role-fallback-state.json`).
- **Agent skills**, the **beads tools** `br` and `bv`, and **Beads Manager, Worker and Reviewer agents** already in Paseo. Archive or delete the agents yourself.
- The empty `plugins: {}` key Paseo leaves in `config.json`.

`--restore-backups` copies backed-up **payload files** back before removing. It **never restores the whole `config.json`**, because that would discard every change made since the install. Only the keys paseo-bm owns are undone. Older copies of the config stay under `~/.paseo-bm/backups/` for manual recovery.

## Command reference

```text
npx paseo-bm [command] [options]
```

| Command | Meaning |
|---|---|
| *(none)* | The install wizard on a terminal. Without a terminal, prints a preview and writes nothing. |
| `install` | Install or update. Without a terminal and without `--apply`, only previews. |
| `doctor` | Read-only health check |
| `uninstall` | Remove what paseo-bm owns. Only previews without `--apply`. |

| Option | Applies to | Meaning |
|---|---|---|
| `--apply` | install, uninstall | Actually write; without it the command only previews |
| `--yes` | install, uninstall | Skip the apply confirmation; never implies consent to any trust boundary |
| `--enable-plugins` | install | Consent to both halves of one trust boundary: enable `pluginsEnabled` and grant Paseo tools to agents |
| `--install-skills` | install | Consent to running the third-party skills CLI |
| `--install-beads-tools` | install | Consent to installing a missing `br` / `bv` without a terminal (a terminal install does it anyway) |
| `--skills-agents <list>` | install, doctor | Target agents for the skills CLI (default `claude,codex`) |
| `--role <role>=<provider>/<model>` | install | Pick the tool for a role; repeatable |
| `--reconfigure` | install | Ask the full role configuration again even when it already exists |
| `--skip-skills-check` | install, doctor | Skip the skills step entirely |
| `--force` | install, uninstall | Install: overwrite user-modified files. Uninstall: delete them too |
| `--ask-skills-again` | install | Clear the remembered "do not ask again" answer for the skills step |
| `--restore-backups` | uninstall | Restore backups before removing (payload files only) |
| `--prune` | install | Clean up old payloads and backups; only on request |
| `--home <dir>` | all | paseo-bm install home (env `PASEO_BM_HOME`) |
| `--paseo-home <dir>` | all | Paseo home directory (env `PASEO_HOME`) |
| `--claude-home <dir>` | all | Claude Code config directory used when detecting skills (env `CLAUDE_CONFIG_DIR`) |
| `--codex-home <dir>` | all | Codex config directory used when detecting skills (env `CODEX_HOME`) |
| `--json` | all | Emit exactly one JSON document on stdout |
| `--verbose` | all | Print more detail about each step |
| `-h`, `--help` | | Show help |
| `-v`, `--version` | | Print the version and exit |

Precedence: flag, then environment variable, then default. `npx paseo-bm <command> --help` shows the options for one command.

## Exit codes and JSON output

| Code | Meaning |
|---|---|
| `0` | success, an intentional preview, or a healthy doctor |
| `1` | doctor found drift in what paseo-bm owns |
| `2` | misuse of a command or flag |
| `3` | environment precondition failed; nothing was written |
| `4` | installed, but a trust boundary was not consented to |
| `5` | stopped on a conflict that needs a human decision |
| `6` | no terminal and no `--apply`; preview printed, nothing written |
| `7` | files installed, but Paseo could not install or load the plugin |

`0` and `6` differ on purpose: `6` means a script forgot `--apply`, so nothing happened. Warnings (missing skills, a missing or failed `br` / `bv`, a provider that is not logged in) never change the exit code.

With `--json`, stdout carries exactly one JSON document and child-process output goes to stderr. The document has `schemaVersion`, `command`, `mode` (`preview` or `applied`), the versions, the `actions` (`checks` for `doctor`), `roles`, `skills`, `warnings` and a `result`. A failed run with a registered error code adds `result.error`:

```json
{
  "result": {
    "exitCode": 3,
    "pluginState": null,
    "error": { "code": "E_TARGET_NOT_WRITABLE", "message": "…" }
  }
}
```

`result.error` is present **only** when the command failed. Error codes (`E_…`) and warning codes (`W_…`) are stable: within a major version codes are only added, never renamed or given a new meaning.

## Troubleshooting

Start with `npx paseo-bm doctor` (add `--verbose` for detail). Every error prints a fix.

**The plugin is not running, or Beads Manager does not appear in Paseo**

- `paseo plugin logs paseo-bm` shows Paseo's reason.
- In `doctor`: `plugins-enabled` or `agent-tools` not ok means the trust consent was not given; run `npx paseo-bm install --apply --enable-plugins`. `plugin-path` or `install-version` in error means Paseo loads a different version than the recorded one; run `npx paseo-bm install --apply`.
- Check a plugin's `status` (`running` or `disabled`) in `paseo plugin ls`, not its `enabled` field.

**`E_PLUGIN_LOAD_FAILED` (exit 7)**

The files were copied, but Paseo could not install or load the plugin. The files are kept. Read `paseo plugin logs paseo-bm`, fix the cause, and run `npx paseo-bm install --apply` again. During an update, the message also says whether the previous version was restored.

**The daemon is not reachable: `E_DAEMON_UNREACHABLE`, `E_PASEO_CLI_MISSING` or `E_VERSION_MISMATCH` (exit 3)**

Open the Paseo app, make sure `paseo --version` works in the same shell, and make sure the CLI and the daemon are both 0.8.0 or newer with the same version. Nothing has been written at this point. Do not restart or stop the daemon while agents are running: that can kill them.

**Missing skills: `W_SKILLS_MISSING` or `W_SKILLS_ASSIST_FAILED`**

Run the printed `skills add` command yourself, or `npx paseo-bm install --apply --install-skills` (add `--ask-skills-again` if you declined before). Then run `doctor`.

**Conflicts: `E_CONFLICT` (exit 5)**

Something paseo-bm does not own is in the way, or a file you edited would be overwritten. Move a foreign file aside yourself, or re-run with `--force` to overwrite files recorded as user-modified (a backup is taken first). Exit `5` also covers a downgrade without a terminal.

**Other errors that exit 3 before writing**

| Code | What to do |
|---|---|
| `E_LOCKED` | Another install or uninstall holds `~/.paseo-bm/.lock`. Wait; delete `.lock` only if you are sure no run is active. |
| `E_CONFIG_CONCURRENT_WRITE` | Something else changed `config.json` during the write (Paseo's settings screen, another run). Close it and retry. |
| `E_TARGET_NOT_WRITABLE`, `E_UNSAFE_INSTALL_HOME`, `E_SYMLINK_IN_PATH`, `E_PATH_ESCAPE` | Point `--home` at a dedicated directory you own, such as `~/.paseo-bm`, with no symlinks in the path. |
| `E_PROVIDER_UNAVAILABLE` | The provider or model for a role does not exist in Paseo. Pick an existing pair with `--role`. |
| `E_RECORD_SCHEMA_TOO_NEW` | `install.json` was written by a newer paseo-bm. Run `npx paseo-bm` again. Do not edit the record. |

**The Manager cannot create a Worker, or a provider is not logged in (`W_PROVIDER_NOT_LOGGED_IN`)**

Check that `agent-tools` is ok in `doctor` and that the Worker's provider is logged in with its own login command. Change a role's provider or model with `npx paseo-bm install --reconfigure`. The Manager tells you the exact cause when creation fails.

**The Worker cannot create or update beads: `W_BEADS_CLI_MISSING`, `W_BEADS_VIEWER_MISSING`, `W_BEADS_TOOLS_INSTALL_FAILED`**

Open Beads Manager (it opens on Setup): it shows whether `br` and `bv` are on the `PATH` the Paseo daemon uses (which can differ from your terminal's), and can install a missing one after you confirm. Or run the command the warning printed. A script install puts the tool in `~/.local/bin`; add that directory to your PATH if the warning says so.

**Metric shows *(unknown)* for a request, or a request has no request text**

Recording starts at the first turn after install, so a request that began earlier is only partly recorded. A request whose agents were deleted still shows what was recorded, with a note.

**The Beads screen is empty**

The workspace has no `.beads/issues.jsonl`, or the workspace is no longer listed by Paseo (see [Known limits](#known-limits)).

**A script installed without asking**

Piping output (`| tee`) or passing `--json` removes the terminal, so nothing is asked. Without a terminal, consent only comes from `--enable-plugins`, `--install-skills` and `--install-beads-tools`.

## Known limits

- **Rules for the agents are instructions, not code.** The review budget, "only do what was asked" and the Worker's safety boundaries depend on the model following its role instructions.
- **Stopping is not a hard cancel** (Paseo 0.8 has no plugin cancel).
- **Beads of a closed workspace are not shown.** Its Metric history is still readable from **Closed workspaces with history**.
- **Costs are estimates** from a bundled price table.
- **Only paseo-bm's own messages become chat cards**; a Worker's ordinary chat text stays plain (use the **Beads in this chat** panel for its beads).
- **Additional role instructions apply to agents created after you save them**, and they are machine-wide: they apply to every workspace.
- Not available yet: a separate `configure` command (use `install --reconfigure`), installing skills from inside Paseo, suggested extra agent profiles, a limit on parallel Workers, report export, views across several workspaces, remote daemons, Windows support, and a code-enforced review budget.
