# paseo-bm — Beads Management for Paseo

`paseo-bm` adds a small agent team to [Paseo](https://paseo.sh). You describe a change in chat, and the team turns it into documents (only when the change needs them), beads (small, dependency-aware work items tracked with `br`) and working code. The process follows the risk: a small change is made and proved directly, larger work gets beads and a separate agent's review.

![How paseo-bm carries a request: the Beads Manager answers what it can read and hands every change to a Beads Worker. The Worker sizes the change: a Small change is made and proved by a check, with no bead and no review; a Medium change gets beads and one review of the implementation; a Large change gets documents where a decision or contract changes, a review before building, beads and a review of the implementation.](assets/paseo-bm-flow.svg)

- **Beads Manager** — your single point of contact in a workspace. It answers what it can read itself (status, beads, code, git history), hands every change to a Worker right away, and tells you the result.
- **Beads Worker** — carries one request from start to finish with the feature-workflow skills from [cuongntr/agent-skills](https://github.com/cuongntr/agent-skills) (another author's repository). Anything beyond your request becomes a suggestion, not work.
- **Reviewer** — checks medium and large work (and small work when you ask) and returns a verdict. It never edits anything.
- **Beads Orchestrator** — one agent for the whole machine, in a workspace of its own, that you start from the **Inbox** when you want it. It reads the work of every paseo-bm project, and you talk to it in its chat. When something needs your decision it asks you in the Inbox, each option with what it would allow and, often, the command ready on it: picking the option sends that command once. It sends a command to a project's Manager by itself only right after you tell it to in its chat ("send it"), or where the project's autonomy level (**Settings → Autonomy**: Hands-on, Co-pilot, Cruise, Turbo, Full auto) lets it decide every kind of decision the command touches; a new install is Hands-on. It leaves every Worker's question to you, except the kinds the level lets it decide; from Co-pilot up it proposes an answer on the others, for you to approve. paseo-bm watches the running Workers of every project — stuck, waiting on a permission, running a dangerous command, failing the same command again and again, piling process onto a small request, or writing outside the project. In a project at Co-pilot or above, those signals, finished steps with work left and stalls wake the Orchestrator, and within that authority it can move the work on or correct a Worker directly, always with a copy to its Manager. Every command declares what it allows; a push, publish, deploy, real-data, migration or cost change needs a decision you answered unless the project is at Turbo, a security change unless it is at Full auto (both levels ask you to confirm), and a command whose text shows an effect it did not declare is refused. It can check a report with read-only git in the project, keeps short notes per project, and scores a project's workflow when you ask.
- **Screens in Paseo** — the **Beads Manager** surface: **Inbox** (what needs your decision — with the Orchestrator's proposal and **Ask back** — and alerts), **Projects** (each project's Overview, Requests with their stage and timeline, Beads board, Metrics and Agents), **Settings** (one autonomy level per project, coordination, and under More the roles and models, precedents and data) and **Tools & skills** (skills and their use, agent tools, `br` and `bv`). The **Beads** tab of a workspace shows that project's page.

> **Status:** `0.4.0` makes the plugin the whole product. It is installed from [paseo.cafe](https://paseo.cafe) and needs **Paseo 0.9.0 or newer**. The `paseo-bm` command-line tool is retired; its last version does one thing, described under [Coming from `npx paseo-bm`](#coming-from-npx-paseo-bm).

## Install

1. Open the Paseo app so its daemon is running. You need **Paseo 0.9.0 or newer**, and macOS or Linux.
2. Install the plugin, either way:
   - from **[paseo.cafe](https://paseo.cafe)**, the plugin listing in the Paseo app, or
   - in a terminal:

     ```bash
     paseo plugin add npm:paseo-bm-plugin
     ```

3. Open **Beads Manager** in Paseo's sidebar. paseo-bm creates its four agent roles the first time you open it, with the first provider and model Paseo reports as available; you can change them in **Settings → More → Agents**.
4. Three things need a press, because each one grants something:
   - **Allow agent tools** (Settings → More → Agents) — Paseo's `daemon.mcp.injectIntoAgents` switch, so the Manager can create and message a Worker. It applies to **every agent on this machine**.
   - **Install skills** (Tools & skills) — runs the third-party `skills` CLI once, to put the Worker's skills in place.
   - **Install `br` / `bv`** (Tools & skills) — the beads tools, if they are not on the daemon's PATH.
5. Open **Projects**, open your workspace, press **Chat ▸**, and describe the change you want.

Update it with `paseo plugin update paseo-bm`.

## Removing it

Open **Settings → More → Data**, press **Remove paseo-bm's settings…** and confirm, **then** remove the plugin:

```bash
paseo plugin remove paseo-bm
```

The button is what takes paseo-bm's roles out of Paseo's configuration and puts the agent-tools switch back; Paseo has no hook that could do it when the plugin is removed. Removing the plugin without pressing it leaves the `bm-*` entries behind. Your history and settings are kept unless you confirm a second time that you want them deleted.

## Coming from `npx paseo-bm`

If you installed paseo-bm before 0.4.0, you have a **directory install**. It never updates by itself, and installing from paseo.cafe on top of it is refused by Paseo with exactly:

```
Plugin ID "paseo-bm" is already configured; choose another ID with --id
```

Do **not** take that advice: two copies of paseo-bm would both create roles and both inject instructions. Run this once instead, and it switches your install to the npm one, keeping your roles, settings and history:

```bash
npx paseo-bm@0.4.0
```

That is the last thing the `paseo-bm` command does; every other command it used to have is gone. See [GUIDE.md](GUIDE.md#coming-from-the-npx-install) for what it writes and what each exit code means. Its source is kept at the [`v0.4.0`](https://github.com/hieunt286/paseo-bm/tree/v0.4.0) tag; this repository now builds only the plugin.

## Limitations and warnings

- **Paseo plugins run without a sandbox.** The plugin has the same access to your machine as the Paseo daemon: files, processes, credentials and network.
- **One consent grants Paseo's agent tools to every agent on this machine**, not only to paseo-bm's roles. Any agent can then create, prompt and stop other agents, and spend money on your model providers.
- **The Worker runs without permission prompts.** Its limits (no commit, push or publish without your yes, no destructive commands, no secret files) are role instructions only, so review `git diff` before you commit.
- **The Orchestrator reads every project, costs tokens, and sends only what you allowed.** Nothing of it exists until you press **Start the Orchestrator** in the Inbox; from then on its conversations and wake-ups use tokens, and the masked content of every paseo-bm project goes to the Beads Orchestrator's provider. A command reaches a Manager when you pick an option that carries it on one of its decisions, when you tell the Orchestrator in its chat to send it, or on its own where the project's autonomy level lets it decide every kind of decision the command touches; the Manager reads it as your own word. In those last two cases it may also write to a Worker directly — its Manager always gets a copy, and a running Worker is stopped mid-turn only while it is doing something dangerous; never to a Reviewer. A Worker's question wakes it only in a project at Co-pilot or above (to propose an answer, or to decide it where the level lets it), and there so does a finished step with work left, a stall or a Worker signal: each costs an Orchestrator turn, and what it sends rests on its judgement. Each command declares what it allows and carries limits telling the agent not to commit, push, deploy or touch real data unless that was approved; a push, publish, deploy, real-data, migration or cost change needs a decision you answered unless the project is at Turbo, a security change unless it is at Full auto. A new install is Hands-on. Stalled work and Worker signals show as alerts in your Inbox. paseo-bm never archives the Orchestrator or removes its workspace; you do, when you no longer want it.
- **Installing skills runs someone else's tool.** The **Install skills** button runs the third-party `skills` CLI, which downloads from [cuongntr/agent-skills](https://github.com/cuongntr/agent-skills) (another author's repository) and has its own data collection. paseo-bm never writes to your skills folders itself.

The full warnings, including what paseo-bm records on your machine, are in [GUIDE.md](GUIDE.md#before-you-install-read-these-warnings).

## Documentation

- **Guided tour:** [paseo-bm.erai.pro](https://paseo-bm.erai.pro)
- **Full reference:** [GUIDE.md](GUIDE.md) — requirements, install, working with the agents, the Inbox, Projects, Settings and Tools & skills, the Orchestrator, everything paseo-bm writes, agent skills, updating, removal, migration and troubleshooting.

## License

MIT, as declared in `package.json`.
