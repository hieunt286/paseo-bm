# Acceptance checklist for the 0.4.0 install on a real daemon — paseo-bm

| Field | Value |
|---|---|
| Status | Active — acceptance of the only install path of 0.4.0: npm plugin, set-up in Settings, migration, removal |
| Applies to | `paseo-bm-plugin` and `paseo-bm` `0.4.0`; Paseo CLI/daemon **0.9.2** (0.9.2 no longer has `cliVersion` in `daemon status --json`; the adapter falls back to `paseo --version` on its own) |
| Related | [PRD](../product/paseo-bm-prd.md) · [Design §7.13, §11, §13](../design/paseo-bm.md) · [Design §4.3–§4.6](../design/paseo-bm.md) · [ADR-012](../adr/ADR-012-plugin-is-the-product.md) · [Plan 0.4.0](../archive/plans/paseo-bm-plan-040-single-source.md) |
| Origin | Rewritten from the 0.3.x installer checklist (`bm-wp-407-prerelease-8t7x.2`); the old installer no longer exists in 0.4.0 |

This document describes **how to run and how to score**; it contains no measurements. Each run copies section 10 into its own run record at `docs/archive/operations/paseo-bm-install-run-<YYYYMMDD>.md`. Thresholds are taken verbatim from the PRD and the design; the checklist sets no new threshold. Run it when a release changes the install path, changes Settings' set-up blocks, changes the migration command, or when moving to a new Paseo version.

## 1. Scope and principles

- The run sequence: **fresh install from npm → Settings through every step that needs a click → migrate a 0.3.1 directory install to npm → update → remove → return the machine to its initial state**, on a **real Paseo daemon**.
- Put paseo-bm and the run's skills folder in a temporary `HOME` in the steps where that is possible, while `PASEO_HOME` still points at the real `~/.paseo` so the real daemon is used. That way the skills installed by the `skills` CLI do not land in your real skills folder.
- **The run modifies the real `~/.paseo/config.json`**: Paseo writes the `plugins` entry, and the plugin creates the three `bm-*` roles and the `daemon.mcp.injectIntoAgents` switch when you click. Section 3 backs up first; section 9 returns to the initial state.
- **Do not run `paseo daemon restart` or `stop`** at any step: it can kill a running agent.
- Never use a different `--id` for `paseo-bm` (design §4.3): two copies of paseo-bm on the same machine would both create roles and both inject instructions.
- If you hit a case the checklist did not foresee: **stop and write it down**, do not improvise.

## 2. Variables used in the checklist

```bash
export RUN=~/bm-acceptance/$(date -u +%Y%m%d)/install-040
export EVID=$RUN/evidence
export REAL_PASEO_HOME="$HOME/.paseo"
export CLEAN_HOME=$RUN/home                 # temporary HOME for paseo-bm data and skills
export REPO=/Users/Shared/work/self/paseo-plugins/paseo-bm
export TAG=next                             # 0.4.0-alpha.0 is on dist-tag `next`
mkdir -p "$EVID" "$CLEAN_HOME"
# Simulate a machine that already has Claude Code and Codex: without these two folders Settings treats
# the two agents as NOT INSTALLED and their skills columns cannot be measured.
mkdir -p "$CLEAN_HOME/.claude" "$CLEAN_HOME/.codex"
```

> **Trap already hit (0.3.x, still true):** an interactive command run through `| tee` no longer has a terminal as stdout, so the CLI assumes **no TTY** and asks nothing. A command that needs to answer a question must run through `script -q <log> …`, which keeps the TTY and still writes the log.

> The plugin reads its data folder from `PASEO_BM_HOME` → the pointer `~/.paseo-bm/home.json` → `~/.paseo-bm`, and **the plugin runs in the daemon process**, so the terminal's `HOME` cannot change it. To make the plugin write into the temporary `HOME`, `PASEO_BM_HOME` must be set in the **daemon's** environment before opening the app; if that cannot be done, accept that the plugin uses the real `~/.paseo-bm` and state it clearly in the run record.

## 3. Preparation and backup

1. Record the versions: `paseo --version`, `paseo daemon status --json | tee "$EVID/daemon-status-before.json"`. **0.9.0 or later** is required; if lower, stop (0.4.0 does not support it).
2. Back up the real config and the plugin list:
   ```bash
   cp "$REAL_PASEO_HOME/config.json" "$EVID/config.before.json"
   paseo plugin ls --json | tee "$EVID/plugin-ls-before.json"
   ```
3. Record the state of the switch before the run, so that section 9 can compare against it:
   ```bash
   python3 -c 'import json,sys;d=json.load(open(sys.argv[1]));print("injectIntoAgents:",d.get("daemon",{}).get("mcp",{}).get("injectIntoAgents"))' "$EVID/config.before.json" | tee "$EVID/switch-before.txt"
   ```
4. Record whether the config already has any `bm-*` entry (there must be none if the machine has never used paseo-bm):
   ```bash
   grep -o '"bm-[a-z0-9-]*"' "$EVID/config.before.json" | sort -u | tee "$EVID/bm-entries-before.txt"
   ```

## 4. Item (1) — fresh install on a machine that has never had paseo-bm

Precondition: `plugin-ls-before.json` has no `paseo-bm` entry, `bm-entries-before.txt` is empty.

```bash
paseo plugin add "npm:paseo-bm-plugin@$TAG" --json | tee "$EVID/01-plugin-add.json"
paseo plugin ls --json | tee "$EVID/01-plugin-ls.json"
```

Passes when:

- `plugin add` exits 0 and `plugin ls` reports `paseo-bm` with `status` `running` (or `disabled` if Paseo's plugin switch is off — turn it on and check again).
- In `plugin ls --json`, the `paseo-bm` entry has `installation.identity.kind = "npm"` and `packageName = "paseo-bm-plugin"`. **This is the remaining part of Q-047**: copy `installation` verbatim into the run record.

Then open the app and follow **exactly the set-up steps of design §7.13** (each in its Settings group), recording a screenshot or log for each step:

| Step | What to do | Passes when |
|---|---|---|
| a. Roles | Open **Beads Manager** in the sidebar | The plugin creates `bm-manager`, `bm-worker`, `bm-reviewer` on its own; Settings → Agents shows the line "paseo-bm created its roles with defaults (<provider> · <model>). Change them in Settings → Agents." |
| b. Agent tools | **Settings → Agents → Allow agent tools…**, read the warning, then click **Allow for every agent** | `daemon.mcp.injectIntoAgents` becomes `true`; `ui/setup-state.json` has `agentTools.setBy = "plugin"` and `previous` equal to the value in `switch-before.txt` |
| c. Skills | **Settings → Tools & skills → Install skills…**, read the command, then click **Run it** | The command finishes, the skills column of Claude Code and Codex shows 5/5; Tools & skills shows the line `Last run: … · exit 0` |
| d. `br` / `bv` | **Settings → Tools & skills**, **Install** whichever is missing | `br` and `bv` have a path on the daemon's PATH |
| e. Sign-in | **Settings → Agents → Sign-in** | The Worker's provider reports **Signed in**; if not, run the command Settings shows and reopen |

Then run one real request; this is **exit condition 1 of MVP-Lock**:

- Manager can create a Worker.
- Worker can create a Reviewer.
- **Work → the workspace → Requests** has that request (its stage bar, timeline and cost).

Record `paseo plugin logs paseo-bm --json | tail -50 > "$EVID/01-plugin-logs.json"` for the run record.

**Measure Q-045 here** (must pass): the npm plugin loads `zod` and `@getpaseo/plugin` even though `plugin/package.json` declares no `dependencies`. The evidence is that step a itself works — Settings and Manager both use both. If `plugin logs` has a module error, **stop**: `dependencies` must be added before release.

**Measure Q-047 (the remaining part)**: run `paseo plugin add` again in a shell **with no TTY** (for example `paseo plugin add … --json < /dev/null > out.json 2>err.txt`) on a temporary `--id`, remove it right away, and record: whether it asks for trust, whether it turns on `pluginsEnabled` by itself, and what shape of JSON it prints.

## 5. Item (2) — migrate a 0.3.1 directory install to npm

Do it twice: once with the default install home, once with `--home`.

```bash
# Rebuild a 0.3.x install: remove the npm install first, then install 0.3.1 as before.
paseo plugin remove paseo-bm --json
HOME="$CLEAN_HOME" PASEO_HOME="$REAL_PASEO_HOME" npx --yes paseo-bm@0.3.1 install --apply --enable-plugins
paseo plugin ls --json | tee "$EVID/02-before.json"
# Migrate:
HOME="$CLEAN_HOME" PASEO_HOME="$REAL_PASEO_HOME" script -q "$EVID/02-migrate.log" npx --yes "paseo-bm@$TAG"
```

Passes when:

- The command prints a preview then asks one question, default **No**; answering Yes exits **0**.
- `paseo plugin ls --json` reports `paseo-bm` with `identity.kind = "npm"`, `packageName = "paseo-bm-plugin"`, `status` `running` (or `disabled`).
- `$CLEAN_HOME/.paseo-bm/install.json` has `schemaVersion: 2` and `migratedTo: { source: "npm", package: "paseo-bm-plugin", version: "0.4.0-…", at: … }`.
- **Data is kept intact**: `traces/`, `role-extras.json`, `role-fallback*.json`, `ui/` are all still there; `plugin/0.3.1/` and `backups/` are still there (0.4.0 does not delete them).
- The `bm-*` roles in the config are **unchanged**, the `injectIntoAgents` switch is **unchanged**.
- Reopen Beads Manager: Work → the workspace → Requests still shows the old requests. This is **exit condition 2 of MVP-Lock**.

The second time, with an install home other than the default:

```bash
HOME="$CLEAN_HOME" npx --yes paseo-bm@0.3.1 install --apply --enable-plugins --home "$RUN/custom-bm"
HOME="$CLEAN_HOME" script -q "$EVID/02b-migrate.log" npx --yes "paseo-bm@$TAG" --home "$RUN/custom-bm"
```

Additional conditions: `$CLEAN_HOME/.paseo-bm/home.json` is created, with content `{ "schemaVersion": 1, "home": "<RUN>/custom-bm", "writtenBy": "paseo-bm@0.4.0-…", "at": … }`, permissions `0600`, and `$RUN/custom-bm/install.json` is the one that has `schemaVersion: 2`.

Run the migration command once more (**case B**): exits **0**, does not call Paseo at all, `install.json` is unchanged.

## 6. Item (3) — the old 0.3.1 cannot reinstall over the npm install

Right after section 5, with `install.json` still at `schemaVersion: 2`:

```bash
HOME="$CLEAN_HOME" npx --yes paseo-bm@0.3.1 install --apply 2>&1 | tee "$EVID/03-old-install.log"; echo "exit=$?"
```

Passes when: it exits **3** with `E_RECORD_SCHEMA_TOO_NEW`, and **nothing changes** — `plugin ls` is still the npm install, the config is unchanged. This is the only mechanism that stops a migrated machine from being reinstalled as a directory install.

## 7. Item (4) — update

```bash
paseo plugin update paseo-bm --json | tee "$EVID/04-update.json"
paseo plugin ls --json | tee "$EVID/04-plugin-ls.json"
```

Passes when: it exits 0, `status` returns to `running`, and the data in the data folder is **unchanged** (compare `ls -la` before/after).

**Measure Q-046**: compare the `path` of the `paseo-bm` entry in `04-plugin-ls.json` with `02-before.json`. Record whether `plugin update` changes the registered path or not — if it does, the package folder managed by Paseo changes on every update, just as design §5.1 assumes.

## 8. Items (5) and (6) — removing paseo-bm's settings, and id conflict

**(5) Removal.** Do it twice, rebuilding the install of section 4 first each time:

1. First time, **keep data**: Settings → Data → **Remove paseo-bm's settings…** → **Remove settings** → **Keep my data**.
2. Second time, **delete data**: same path, but choose **Delete data**.

Then each time:

```bash
paseo plugin remove paseo-bm --json | tee "$EVID/05-remove.json"
cp "$REAL_PASEO_HOME/config.json" "$EVID/05-config-after.json"
grep -o '"bm-[a-z0-9-]*"' "$EVID/05-config-after.json" | sort -u | tee "$EVID/05-bm-entries-after.txt"
```

Passes when (**exit condition 3 of MVP-Lock**):

- `05-bm-entries-after.txt` is empty: no `bm-*` provider or profile is left, fallback aliases included.
- `injectIntoAgents` returns to exactly the value in `switch-before.txt` — only when paseo-bm itself turned it on; if you had already turned it on, the screen must report **left on** and the value is **unchanged**.
- First time: the data folder is intact. Second time: `traces/`, `decisions/`, `inbox/`, `orchestrator/`, `role-extras.json`, `role-fallback*.json` and everything in `ui/` **except** `ui/setup-state.json` are gone; `install.json`, `plugin/`, `backups/`, `home.json` remain.
- Both times: skills, `br`, `bv` are **not touched**.
- Reinstall the plugin **without** clicking "Set up again": Settings → Agents reports that the settings were removed and **does not recreate the roles on its own** (REQ-012 e). Clicking **Set up again** recreates them.

**(6) Id conflict.** Build a 0.3.1 directory install (as in section 5), then:

```bash
paseo plugin add "npm:paseo-bm-plugin@$TAG" --json 2>&1 | tee "$EVID/06-conflict.log"
```

Passes when: it is refused with **exactly the text**

```
Plugin ID "paseo-bm" is already configured; choose another ID with --id
```

and following the README section "coming from `npx paseo-bm`" — that is, running `npx paseo-bm@$TAG` once — resolves it. **Do not** try a different `--id` at any step.

## 9. Return the machine to its initial state

1. Settings → Data → **Remove paseo-bm's settings…** (if still there), then `paseo plugin remove paseo-bm`.
2. Compare `~/.paseo/config.json` with `$EVID/config.before.json`; wherever they differ, fix it by hand back to the backup, except the empty `plugins` key Paseo leaves behind (that key belongs to Paseo).
3. Delete `$RUN` if it does not need keeping, and delete `~/.paseo-bm` **only if** it was created by this run.
4. Do not run `paseo daemon restart`/`stop`.

## 10. Run record form

Copy this section into `docs/archive/operations/paseo-bm-install-run-<YYYYMMDD>.md`.

### Run of 0.4.0 — <date>

| Field | Value |
|---|---|
| Date, run by | |
| `paseo --version` / `daemonVersion` | |
| Versions tested | `paseo-bm-plugin@…`, `paseo-bm@…` |
| Machine | |

| Item | Result | Evidence | Notes |
|---|---|---|---|
| (1) Fresh install from npm + every set-up step in Settings | pass / fail | | |
| (1) Manager → Worker → Reviewer, Work has the request | pass / fail | | Exit condition 1 |
| (2) Migrate the directory install, default install home | pass / fail | | Exit condition 2 |
| (2) Migrate the directory install, `--home` + `home.json` pointer | pass / fail | | |
| (2) Rerun the migration command (case B) | pass / fail | | |
| (3) `paseo-bm@0.3.1 install` blocked, exits 3 | pass / fail | | |
| (4) `paseo plugin update paseo-bm` | pass / fail | | |
| (5) Removal, keep data | pass / fail | | Exit condition 3 |
| (5) Removal, delete data | pass / fail | | |
| (5) No roles recreated before "Set up again" | pass / fail | | REQ-012 e |
| (6) Id conflict, exact notice text | pass / fail | | |

| Question | What was measured | Conclusion |
|---|---|---|
| Q-045 — does the npm plugin load `zod` and `@getpaseo/plugin`? | | **must pass** |
| Q-046 — does `plugin update` change the registered `path`? | | |
| Q-047 (remaining) — `plugin add npm:… --json` with no TTY: asks for trust? turns on `pluginsEnabled` by itself? what shape of JSON? | | |

Q-044 **is closed** (design §13, measured 2026-09-25): a provider's `paseoTools.enabled` on its own does **not** give an agent Paseo tools, so the agent-tools button in step 4b is required — do not measure it again. The `plugin ls --json` part of Q-047 was answered on `paseo-cafe`; section 4 confirms it again for `paseo-bm-plugin`.

REQ-070 (e): record whether the migration kept the data, the roles and the switch intact, with evidence.

## 11. Known limitations

- The checklist runs on **one machine, one daemon**; it does not measure several daemons or a multi-user machine.
- `PASEO_BM_HOME` can only change the plugin's data folder if it can be set in the daemon's environment; if not, the run uses the real `~/.paseo-bm` and the run record must say so clearly.
- The "remove then reinstall" sequence goes through real `paseo plugin remove`/`add`, so the `plugins` pointer in the real config changes several times in one run; section 9 is the only step that brings it back.

*Revision 2026-09-29: the steps name the screens that exist after the autonomy programme's Phase 1 (retirement sweep, bead `bm-autonomy-phase1b-dbdv.6`): set-up in Settings (Agents, Tools & skills, Data) instead of Setup, a request's trace in Work → Requests instead of the Metric screen. Thresholds and exit conditions unchanged.*
