# ADR-007 — Store the Dashboard's traces in the install home, deletable by the user

| Field | Value |
|---|---|
| Status | **Accepted** (2026-09-16) — approved by the owner together with the feature PRD |
| Date | 2026-09-16 |
| Owner | hieu.nt10 |
| Related | [Dashboard PRD REQ-053 → REQ-057](../product/paseo-bm-dashboard-prd.md#6-functional-requirements) · [Dashboard Technical Design §3](../design/paseo-bm-dashboard.md) · [ADR-002](ADR-002-install-ownership-model.md) (ownership inside the install home) · [ADR-005](ADR-005-manager-as-agent.md) (the agent lifecycle belongs to the user) · [Base PRD REQ-030](../product/paseo-bm-prd.md#6-functional-requirements) |

## Context

The Dashboard needs to answer "what did this request break down into, how long did it take, which beads did it create, which steps did it skip". All the raw data lives in Paseo's agent timelines.

Four facts shape the decision:

1. **The agent lifecycle belongs to the user (ADR-005).** The user archives and deletes agents at any time, and the product encourages it — Manager spawns a Worker for every request, so agents accumulate very quickly. If the Dashboard only derived from the timeline at read time, **cleaning up agents would mean deleting the work history**.
2. **Paseo does not promise to keep timelines forever.** A timeline has `epoch`, `reset`, `gap` and `compaction`: old content can be replaced or compressed and lose its text. Derive-at-read is therefore not a stable source.
3. **Rereading the timeline on every open is expensive.** A long-lived Manager has a very long timeline; rebuilding every trace each time the Dashboard opens would miss the 3-second threshold when the history is large.
4. **The plugin already has a legitimate collection path.** The `on("agent.turn_ended")` hook is already used for propagating the stop command (bm-wq6). It is an event hook, not a cron job or a watcher, so the "no background tasks" constraint of the base Technical Design §8 is not violated.

The cost to weigh: storing traces means paseo-bm **starts writing agent conversation content to disk** — before, the product only wrote the plugin payload and an install record containing no secrets. That is a new privacy boundary, and data that will grow over time.

## Decision

1. **Keep a durable trace.** The collector hooks `agent.turn_started` / `agent.turn_ended` of the `bm-*` agents and records each turn as soon as it ends. Traces therefore survive a plugin reload, a daemon restart, and the user archiving or deleting agents.
2. **The store lives in paseo-bm's install home**, at `<install home>/traces/`, split by `workspaceId` and then by month. The install home is derived from `paseo.config.get().config.plugins["paseo-bm"].path` (`<install home>/plugin/<version>`), so it is correct even when the user changes the location with `--home`; the server bundle has no cwd, so there is no other way.
3. **Never write into the user's workspace.** This history is the tool's data, not the repository's; putting it in the repository would dirty git and could leak conversation content through a commit.
4. **Redact secrets before writing, not before rendering.** Once data is on disk it cannot be changed back. Permissions `0700` for directories, `0600` for files, like `install.json`.
5. **Append, never edit; deletion is the only edit.** One turn is one JSON line; written with `O_APPEND` + `fsync`. Deletion rewrites the file following the temp → `fsync` → `rename` rule of the base Technical Design §8.
6. **The user can delete, and only the user deletes.** Three scopes: one trace, every trace older than a point in time, every trace of one workspace. There is always a preview step (the number of traces and the size) with a confirmation that defaults to "No". **No automatic deletion, no automatic compression, no rotation by age or size** — the product only **warns** when the store exceeds a threshold. Reason: this is the user's work history, and an automatic deletion mechanism would delete exactly what people need at the moment they need it most.
7. **A trace failure never kills an agent.** A full disk, missing permissions, a store with a newer schema — all are swallowed in the hook, logged in one line, and the Dashboard shows "traces may be missing".
8. **The store has a `schemaVersion`.** A higher version than understood is read in a limited way and **not written**, so that an old version does not damage a newer version's data.
9. **Ownership: created by paseo-bm, belonging to the user.** The store has no hash in `install.json` and is not backed up. This is a new kind compared with the five kinds in the base Technical Design §3.3, so it comes with a delta-change to the base PRD REQ-010/REQ-012 and the base design §3.1/§3.3.
10. **A version update never deletes the store** (decided by the owner 2026-09-16). Not when the payload moves to a new version directory, not with `--prune`, and not when the store's schema needs a migration — a migration writes the new version before dropping the old one. Only **the uninstall command** may delete it, and only after asking; non-interactive mode needs a separate flag (the flag name is still to be decided).
11. **The traces of a workspace that no longer exists are neither silently deleted nor guessed at.** They go into a "workspace no longer exists" group, carrying the last name and path paseo-bm knew (one `meta.json` per workspace), so that the user recognises which repository it was. When the user opens that repository again, **the user** reassigns the traces to the new workspace; the product does not match by name or path on its own, because a wrong guess would mix the histories of two different repositories. The `workspaceId` field in each record keeps its historical value; the new directory location is what decides which workspace a trace belongs to.

## Consequences

**Gained**

- REQ-030 (work session history) becomes true, independent of whether the user keeps the agents.
- The Dashboard opens quickly even when the history is large: it reads a prebuilt store instead of rebuilding from timelines.
- The data is stable against Paseo's `compaction` and `reset`.
- There is a single, versioned place to add metrics later without changing how data is read.

**Lost, and to live with**

- **Agent conversation content is on disk.** Mitigated by: redacting secrets before writing, `0600` permissions, truncating length, and a sentence on the interface that says so plainly. It cannot be removed entirely: if an agent quotes a piece of source code, that piece is stored.
- **The store grows over time.** Mitigated by the three-scope deletion path plus a size warning, with a threshold the user can change in the plugin's settings (machine-wide scope — Paseo offers no per-workspace scope); it is accepted that the user must clean up themselves.
- **The plugin becomes a party that writes to disk**, so the negative-test surface grows: it must be proved that it writes only inside `traces/`.
- **Frozen documents must be amended by a delta-change** before implementation; this is real work, not a formality.
- The collector depends on the hook running. If the Paseo host has no hook, or the plugin is disabled while an agent runs, that turn has no trace and the Dashboard must say "may be missing".

## Alternatives considered

| Option | Why not chosen |
|---|---|
| **Derive at read time, store nothing** (the original proposal) | Adds no data store and no new privacy risk, but the history dies with the agent — contrary to the very reason REQ-030 exists — and misses the time threshold when the history is large. The owner decided to drop this option (Q-030, 2026-09-16) |
| **Store inside the workspace (e.g. `.beads/traces/`)** | Dirties the user's repository, may be committed, and violates the boundary "write nothing into the repository besides the beads and documents Worker creates" |
| **Store through Paseo's `registerSettings`** | That mechanism is for small configuration managed by Paseo, not for appended data of thousands of records; and it does not allow deletion by scope |
| **SQLite in the install home** | Better queries than JSONL, but adds a binary dependency to the plugin payload, against the "minimal runtime dependencies" principle; and one corrupt file loses the whole store, whereas a corrupt JSONL line loses only one line |
| **Automatic rotation by age or size** | Simple for the operator but deletes the user's data without asking. The owner decided: warn only, the user deletes |
| **Delete the traces when the workspace is deleted from Paseo** | Tidier, but users often delete a workspace and open the same repository again later — and by then the history is gone. The owner decided: keep them in the "workspace no longer exists" group and allow reassignment |
| **Automatically match an old workspace to a new one by repository path** | Convenient, but two workspaces pointing at the same path are not necessarily the same line of work, and a wrong match mixes the histories of two repositories. So reassignment is always done by the user's click |
