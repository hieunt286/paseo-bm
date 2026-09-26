# paseo-bm — Beads Management for Paseo

`paseo-bm` adds a small agent team to [Paseo](https://paseo.sh). You describe a change in chat, and the team turns it into documents (only when the change needs them), beads (small, dependency-aware work items tracked with `br`) and working code. The process follows the risk: a small change is made and proved directly, larger work gets beads and a separate agent's review.

![How paseo-bm carries a request: the Beads Manager answers what it can read and hands every change to a Beads Worker. The Worker sizes the change: a Small change is made and proved by a check, with no bead and no review; a Medium change gets beads and one review of the implementation; a Large change gets documents where a decision or contract changes, a review before building, beads and a review of the implementation.](assets/paseo-bm-flow.svg)

- **Beads Manager** — your single point of contact in a workspace. It answers what it can read itself (status, beads, code, git history), hands every change to a Worker right away, and tells you the result.
- **Beads Worker** — carries one request from start to finish with the feature-workflow skills from [cuongntr/agent-skills](https://github.com/cuongntr/agent-skills) (another author's repository). Anything beyond your request becomes a suggestion, not work.
- **Reviewer** — checks medium and large work (and small work when you ask) and returns a verdict. It never edits anything.
- **Screens in Paseo** — **Metric** (what each request did and cost), **Beads** (the workspace's beads) and **Setup** (roles, tools, skills and your own role instructions).

> **Status:** `0.4.0` makes the plugin the whole product. It is installed from [paseo.cafe](https://paseo.cafe) and needs **Paseo 0.9.0 or newer**. The `paseo-bm` command-line tool is retired; its last version does one thing, described under [Coming from `npx paseo-bm`](#coming-from-npx-paseo-bm).

## Install

1. Open the Paseo app so its daemon is running. You need **Paseo 0.9.0 or newer**, and macOS or Linux.
2. Install the plugin, either way:
   - from **[paseo.cafe](https://paseo.cafe)**, the plugin listing in the Paseo app, or
   - in a terminal:

     ```bash
     paseo plugin add npm:paseo-bm-plugin
     ```

3. Open **Beads Manager** in Paseo's sidebar. paseo-bm creates its three agent roles the first time you open it, with the first provider and model Paseo reports as available; you can change them in **Setup → Agents**.
4. Open **Setup** and work through **Set up paseo-bm**. Three steps need a press, because each one grants something:
   - **Allow agent tools** — Paseo's `daemon.mcp.injectIntoAgents` switch, so the Manager can create and message a Worker. It applies to **every agent on this machine**.
   - **Install skills** — runs the third-party `skills` CLI once, to put the Worker's skills in place.
   - **Install `br` / `bv`** — the beads tools, if they are not on the daemon's PATH.
5. Press **Go to** next to your workspace, and describe the change you want.

Update it with `paseo plugin update paseo-bm`.

## Removing it

Open **Setup**, press **Remove paseo-bm's settings…** and confirm, **then** remove the plugin:

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

That is the last thing the `paseo-bm` command does; every other command it used to have is gone. See [GUIDE.md](GUIDE.md#coming-from-the-npx-install) for what it writes and what each exit code means.

## Limitations and warnings

- **Paseo plugins run without a sandbox.** The plugin has the same access to your machine as the Paseo daemon: files, processes, credentials and network.
- **One consent grants Paseo's agent tools to every agent on this machine**, not only to paseo-bm's roles. Any agent can then create, prompt and stop other agents, and spend money on your model providers.
- **The Worker runs without permission prompts.** Its limits (no commit, push or publish without your yes, no destructive commands, no secret files) are role instructions only, so review `git diff` before you commit.
- **Installing skills runs someone else's tool.** The **Install skills** button runs the third-party `skills` CLI, which downloads from [cuongntr/agent-skills](https://github.com/cuongntr/agent-skills) (another author's repository) and has its own data collection. paseo-bm never writes to your skills folders itself.

The full warnings, including what paseo-bm records on your machine, are in [GUIDE.md](GUIDE.md#before-you-install-read-these-warnings).

## Documentation

- **Guided tour:** [paseo-bm.erai.pro](https://paseo-bm.erai.pro)
- **Full reference:** [GUIDE.md](GUIDE.md) — requirements, install, working with the agents, the screens, everything paseo-bm writes, agent skills, updating, removal, migration and troubleshooting.

## License

MIT, as declared in `package.json`.
