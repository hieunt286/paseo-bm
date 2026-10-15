# ADR-034 — Each mission has its own workspace in the Mission-List project

| Field | Value |
|---|---|
| Status | **Accepted** (2026-10-12) — the owner's request after using the mission runtime build ("tên của repo sẽ là Mission-List, và với mỗi một Mission thì sẽ là 1 workspace mới trong thư mục"); technical choices by Claude under the owner's delegation |
| Date | 2026-10-12 |
| Owner | hieu.nt10 |
| Supersedes | [ADR-029](ADR-029-missions-mains-and-a-process-governor.md) decision 2 ("all Mains live in one shared home") — the home becomes a project with one workspace per mission |
| Keeps | ADR-029's missions and Mains, the home's "not a project" rule for project views; [ADR-033](ADR-033-the-mission-is-the-system-of-record.md) (one replacement path, a long-lived Main); ADR-005 (the plugin never archives or stops an agent) |
| Related | [missions design](../design/paseo-bm-missions.md) §3.1–§3.3 · [mission runtime design](../design/paseo-bm-mission-runtime.md) §3.4 |
| Lane | Designed: where the plugin creates agents and workspaces in Paseo, a stored field (`workspaceId` on a mission) |

## Routing Decision

- Variant preset: brownfield (a running layout changed on the owner's request).
- Triggered risks: writes in Paseo (a workspace per mission), where agents are created, a stored field (additive), the creation hook's claims.
- Required artifacts and gates: this ADR; the missions design §3.1–§3.3 updated in place (`design-ready`); beads for the work; `feature-done`. No new UI: the Missions screen's approved New mission form (artboard E) is reused.
- Execution path: brief → beads → implement; one verify at the end.
- Exceptions: none.
- Decided: 2026-10-12 — hieu.nt10 (the layout), Claude under the owner's delegation (technical choices).
- Supersedes: none.

## Context

ADR-029 put every Main in one folder, `<data>/missions/home`, opened as one workspace. In Paseo's sidebar that reads as a project called "home" with one workspace whose tabs are every mission's Main, its replaced predecessors and any unassigned Main: opening mission XAI's Main from the Missions screen opens a tab inside "home". The owner wants the project named **Mission-List**, **one workspace per mission**, and tabs inside a mission's workspace only when the owner opens one on purpose or the plugin opens one for that mission (a successor).

Paseo's workspace API supports this: `workspaces.create({ source: { kind: "directory", path, projectId }, title })` adds a directory workspace to an existing project, and a workspace's title is settable. Checked on an isolated daemon (2026-10-12): the root folder `Mission-List` opens as a `non_git` project named after its folder; two mission folders created with its `projectId` are two workspaces of that one project, titled as asked; opening a mission folder again returns its workspace.

## Decision

1. **The project.** The Missions home is `<data>/missions/Mission-List`, opened as a workspace (the project's root). Its workspace is the lobby: an unassigned Main (one the owner opens there by hand) lives there.
2. **A workspace per mission.** Each mission has the folder `<root>/<missionId>` (a `README.md` naming the mission) and a directory workspace in the root's project, titled `<CODE> · <name>`, kept in sync on a rename. Its id is cached on the mission (`workspaceId`, additive); a stale id is found again by the folder.
3. **Mains are created in their mission's workspace**: the first Main, a successor (handoff, replace, fallback) and an `Open Main` that finds none. A replaced Main stays where it was, as a tab, never archived (ADR-005).
4. **"New mission" names the mission first.** The Command Center's "New mission" opens the Missions screen's New mission form (artboard E), so the mission exists before its Main and the Main starts in the mission's own workspace. An unassigned Main remains only for a `bm-manager` the owner opens in the lobby; when its mission starts, the mission's workspace is created; the Main keeps its conversation in the lobby until it is replaced, and its successor starts in the mission's workspace.
5. **A `bm-manager` the owner opens in a mission's workspace** is that mission's: the successor of a cleared conversation (the existing claim window), or its Main when the mission has no live Main. When a live Main exists, it is an extra chat the owner opened on purpose and is left alone.
6. **Earlier layout.** The old `home` folder and workspace stay recognised as a Missions place (their Mains keep working) until the owner archives them; nothing is moved or archived. At start, every open mission of the owner or the orchestrator gets its workspace; a legacy one-repo mission gets one when the plugin first creates a Main for it.
7. **Readers of a Main's place** (the governor's turn count, the mission state, A-14, the creation hook, "a plugin home, not a repo") read every Missions place: the root, the old home, each mission's workspace, and a legacy mission's repo.

## Consequences

- The sidebar shows one project, Mission-List, with one row per mission; a mission's Main opens in its own workspace.
- An existing Main in `home` (XAI's) stays there until it is replaced; the replacement (the Inbox's outdated-agent action, a handoff) starts in XAI's workspace. The owner may then archive `home`.
- Paseo builds without `workspaces.create` fall back to the root: the Main is created in the lobby and one log line says why.
- The Missions screen's New mission form becomes the one way to start a named mission from the Command Center.

## Alternatives considered

- **One project per mission** (a separate folder opened by `cwd`). Every mission becomes its own top-level project; the sidebar fills with projects. Rejected: the owner asked for one project.
- **Git worktrees of a Mission-List repository.** Same sidebar shape, but needs `git init` in the data folder and branch bookkeeping for no benefit. Rejected.
- **Move a running Main to its mission's workspace.** An agent's directory cannot change; a forced handover would cost the owner's conversation. Rejected: the move happens at the next replacement.
