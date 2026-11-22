# paseo-bm — Missions, Mains and the process governor: Technical Design

| Field | Value |
|---|---|
| Status | Active — how missions, their Mains and the governor work in 0.8.0; edited in place |
| Owner | hieu.nt10 |
| Requirements | [Missions PRD](../product/paseo-bm-missions-prd.md) REQ-184 → REQ-201, M-22 → M-30 |
| Decision | [ADR-029](../adr/ADR-029-missions-mains-and-a-process-governor.md); §20: [ADR-032](../adr/ADR-032-one-governor-a-mission-per-wake.md); §3.1: [ADR-034](../adr/ADR-034-each-mission-has-its-own-workspace.md); §9: [ADR-045](../adr/ADR-045-a-mission-runs-as-a-supervised-line-of-approved-steps.md) decision 9 |
| Builds on | [base design](./paseo-bm.md) §7.3 (Manager), §7.4 (bindings), §7.14–§7.17 (registry, tools, outbox, peer links); [Orchestrator design](./paseo-bm-orchestrator.md); [autonomy design](./paseo-bm-autonomy.md) Parts A, B, G. Extended by the [mission runtime design](./paseo-bm-mission-runtime.md) (the mission state, one authority, the Main's channel) and the [delivery line design](./paseo-bm-delivery-line.md) (placements, lanes, the line of steps) |

Section numbers are cited by code; they are never renumbered.

## 1. Principles

1. **A request lives in the repo of its Worker.** Every per-workspace store — request registry, outbox, decisions and threads, traces, alerts, handoffs, autonomy (repo level), action boundary, worker-watch and stall state — keeps its format and is keyed by **the Worker's repo workspace**. The Main is the request's owner (`managerId`), not its location. A mission's Worker works in the mission's placement of the repo (its worktree): request-level stores follow the placement, owner-level settings the repo key (delivery line design §3.1).
2. **A Main is found by its mission, never by a workspace.** For a mission's request, no lookup finds "the Manager of workspace W"; each finds "the Main of request R" through the mission roster (§2.3), or "the Main of mission M" through the mission store.
3. **A mission is data.** Everything a Main successor needs is in the mission store; nothing that must survive lives only in a Main's context.
4. **Agents write content; code creates, routes and delivers** (ADR-027). Mission changes the owner must approve settle only on the owner's own message, as `bm_answers` does.

## 2. Stores

All stores follow `data-files.ts` (`createJsonFileStore`: `0700` folders, `0600` files, atomic writes, one synchronous read–modify–write per change, a newer `schemaVersion` read as empty and never written, readers never throw). `setup.cleanup` deletes `missions/` and `memory/` with the rest (`CLEANUP_DELETES`).

### 2.1 Missions — `<data>/missions/<missionId>.json`

```ts
{ schemaVersion: 1,
  missionId: string,               // ^mis-[0-9a-f]{10}$ — stable; never shown alone
  code: string,                    // ^[A-Z][A-Z0-9]{1,7}$ — the owner's short code, unique among open missions
  name: string,                    // the owner's name, ≤ 80
  state: "open" | "closed",
  createdAt: string, closedAt: string | null,
  createdBy: "owner" | "orchestrator" | "legacy",
  parentMissionId: string | null, splitReason: string | null,   // a split (§9.6)
  legacyWorkspaceId: string | null,                             // a one-repo mission made from a per-workspace Manager (§3.6)
  mainId: string | null,
  mainHistory: Array<{ agentId: string, from: string, to: string | null, reason: "created" | "replaced" | "fallback" | "handoff" | "owner" }>,
  charter: {
    goal: string,                  // ≤ 4,000
    repos: string[],               // workspace ids in scope, ≥ 1 once confirmed
    nonGoals: string[],            // each ≤ 300, ≤ 20
    doneCriteria: Array<{ id: string /* D1… */, text: string /* ≤ 500 */,
                          status: "open" | "met" | "dropped", at: string | null, evidence: string | null /* ≤ 500 */,
                          metAt?: string /* last met with evidence; the governor's drift counts from it */ }>,
    budget: { requests: number | null, workers: number | null, reviewCalls: number | null, days: number | null } | null,
    confirmedAt: string | null },  // the owner confirmed the charter
  plan: { text: string /* ≤ 20,000 */, updatedAt: string | null },
  workspaceId?: string | null,     // its own workspace in the Mission-List project (§3.1)
  mergedInto?: string | null,      // a legacy mission merged into another (mission runtime design §5.2)
  placements?: Placement[],        // its worktree per repo (delivery line design §3.2)
  repoAliases?: Record<string, string>,  // a live root workspace → its repo key (ADR-043)
  contracts: Array<{ id: string /* C1… */, title: string, providerRepo: string, consumerRepos: string[],
                     text: string /* ≤ 4,000 */, version: number, updatedAt: string, source: string,
                     status?: "proposed" | "agreed" | "superseded" | "withdrawn" /* absent = agreed */,
                     agreedBy?: Array<{ side, agentId, version, at }> }> }
```

Contracts ([delivery line design](paseo-bm-delivery-line.md) §9.2):
- A new contract, or a new version of one, is `proposed` unless the Main states `agreed`.
- An `agree` on a link at the current version is recorded in `agreedBy`. When both sides of the link have agreed, the contract becomes `agreed` and a journal `contract` line is written.
- A status-only change keeps the version.

- Text fields are masked with `redactText`.
- **Index.** `missions/index.json` keeps `{ missionId, code, name, state, mainId, repos, workspaceId }` per mission, and the `placements` and `repoAliases` maps (delivery line design §3.1), rewritten with each mission write, for lists, code and placement lookups. A missing or stale index is rebuilt from the mission files.
- A closed mission keeps its files; its Main is not replaced.

### 2.2 Journal — `<data>/missions/<missionId>.journal.jsonl`

Append-only, one line per event: `{ at, kind, by, text ≤ 500, ref? }` — kinds `charter`, `plan`, `criterion`, `contract`, `worker`, `link`, `decision`, `main`, `governor`, `note`, `split-suggested`. At most the newest 5,000 lines are kept. The journal is what a successor Main and the governor read to see what happened; it is the source of no state but one: a Main's open split suggestions (`openSplitSuggestionsOf`, §9.6).

### 2.3 Roster — `<data>/missions/<missionId>.roster.json`

```ts
{ schemaVersion: 1,
  requests: Array<{ requestId: string, workspaceId: string, createdAt: string,
                    workerIds: string[],          // newest last
                    topic: string,                // ≤ 120, the Main's one-line label
                    state: "active" | "finished" | "stopped" }> }
```

- Written by `bm_create_worker`, a handoff successor, a fallback Worker and `bm_tell_worker` with `peerLink`.
- **The request index.** `requestIndexOf(requestId)` → `{ missionId, workspaceId }` is built in memory from every roster (cached by mtime) and is how every Main-side lookup finds a request's repo.
- **Unique request ids.** `generate` (`request-registry.ts`) treats an id as taken when **any** workspace's registry or the request index holds it, so a Main creating Workers in two repos in one second gets two ids. The `req-YYYYMMDDTHHMMSSZ` format is unchanged.
- **The roster is the only source of mission membership.** The registry entry's `missionId` and the binding's `missionId` are caches written for speed: an older build drops unknown keys at its next write (base design §7.17.7), so every reader falls back to the request index when they are missing.

### 2.4 Mission level — `<data>/missions/autonomy.json`

```ts
{ schemaVersion: 1,
  missions: Record<missionId, { level: 0 | 1 | 2 | 3 | 4,
                                 cells: Record<MissionClass, { mode: "owner" | "delegate", at: string }> }> }
type MissionClass = "proceed" | "staffing" | "scope-repo" | "answer-technical" | "answer-effects" | "split";
```

| Level | Delegated |
|---|---|
| 0 | nothing |
| 1 | `proceed` |
| 2 (default) | `proceed`, `staffing` |
| 3 | + `answer-technical` |
| 4 | + `answer-effects`, `scope-repo`, `split` |

The default (`DEFAULT_MISSION_LEVEL`, Q-200) lets a new mission go on to next steps and create Workers. Cells can be set one by one; the level is the highest whose cells all hold. Levels 3 and 4 need the owner's confirmation (`autonomy.set-mission-level`, `autonomy.set-mission-cell`).

### 2.5 Project memory — `<data>/memory/<workspaceId>.json`

```ts
{ schemaVersion: 1,
  entries: Array<{ id: string /* mem-<10 hex> */, kind: "decision" | "precedent" | "fact" | "convention" | "contract",
                   text: string /* ≤ 1,000, masked */, source: string /* ≤ 300 */,
                   by: { role: "owner" | "main" | "worker" | "plugin", agentId: string | null, missionId: string | null },
                   at: string, supersedes: string | null, state: "active" | "removed" }> }
```

- **Automatic entries.** An owner's answered decision of a request in that repo adds a `decision` entry; a precedent of that repo (precedent store) is shown as a `precedent` entry, read through, not copied.
- **Bounds.** At most 300 live entries per repo (`MAX_ACTIVE_MEMORY`). An `add` past 300 is refused with "curate the memory first (bm_memory remove)" (`MEMORY_FULL_REASON`); automatic entries past 300 replace the oldest automatic `decision` entry. No governor figure watches the memory's size.
- **Scope and life** ([ADR-037](../adr/ADR-037-agents-are-given-a-bounded-context.md)): an entry also carries `scope?: "repo" | "mission"` and `subject?`. A `mission` entry of a closed mission, an entry whose subject a newer one names, and a mission fact older than 14 days are retired: computed at each read, never stored, reversible; an entry retired for 30 days becomes `removed` at the next write. The rules are the [delivery line design](paseo-bm-delivery-line.md) §18.1.

### 2.6 Peer links (ADR-028 store, extended)

A link gains `route: "project" | "ask-main" | "worker" | "mission"` (the existing `kind` field already means work or question; a stored link without `route` reads as `project`, and `project` links are written without it) and `missionId: string | null` (the mission whose Main answers; for a `mission` link, the target mission). `from.requestId` may be null only on a `mission` link:

| Kind | From → to | Opened by | Answered by |
|---|---|---|---|
| `ask-main` | a Worker → its own Main, about a target repo (`to.workspaceId`) | the Worker, `bm_ask_project` | the Main: `bm_link_workers` or `bm_create_worker` with `peerLink` (the link becomes taken by that request), or `bm_peer_reply` |
| `worker` | a Worker → a sibling Worker of the same Main (any repos, the same repo included) | the Main, `bm_link_workers` | the Workers, `bm_peer_reply` |
| `mission` | a Main → another mission's Main | the Main, `bm_ask_mission` | the other Main, `bm_peer_reply` |
| `project` | ADR-028 behaviour, kept for a Worker whose request has no mission | — | — |

The "a project cannot ask itself" rule applies to `project` and `ask-main` only. The chain rule applies to `project` only.

Link messages ([delivery line design](paseo-bm-delivery-line.md) §9.1):
- **Acts and references.** A link message carries an `act` (`ask`, `answer`, `agree`, `ack`, `close`, `supersede`) and `refs` to contract versions, records and decisions, each checked.
- **`ack` and `close` start no turn.** They are stored, shown in the receiver's state, and put at the head of its next delivery.
- **Waits.** An `ack` settles no wait. A `close` from the answering side settles one as a reply does.
- **State.** The Main's `BM-STATE` and a Worker's compaction brief show each link's latest message, not its first ask.

## 3. The home and the Main

### 3.1 The home: the Mission-List project, a workspace per mission ([ADR-034](../adr/ADR-034-each-mission-has-its-own-workspace.md))

- **The root.** `ensureMissionsHome` creates `<data>/missions/Mission-List` (`0700`, a `README.md` saying what it is) and opens it with `paseo.workspaces.open({ cwd })`; Paseo names the project after the folder. Its workspace id is cached in `ui/missions-home.json`. The root workspace is the lobby: an unassigned Main the owner opens there by hand lives there.
- **A workspace per mission.** `ensureMissionWorkspace` makes `<Mission-List>/<missionId>` (a `README.md` naming the mission) and finds the workspace Paseo lists for that folder, else creates one with `workspaces.create({ source: { kind: "directory", path, projectId: <root's project> }, title: "<CODE> · <name>" })`. Its id is cached on the mission (`workspaceId`, also in the index). A rename retitles it (`paseo workspace rename`) with the Main. A host without `workspaces.create`, or a root without a project id, keeps the Main in the root (one log line).
- **Where Mains are created.** Every Main the plugin creates for a mission — the first, a successor of a handoff, a replace or a fallback, an `Open Main` that finds none — is created in its mission's workspace; a replaced Main stays where it was, as a tab. At start, every open mission of the owner or the orchestrator gets its workspace; a legacy one-repo mission gets one when the plugin first creates a Main for it.
- **The earlier shared home.** A cached home in another folder (`<data>/missions/home`, before ADR-034) is kept as `legacyWorkspaceId` in `ui/missions-home.json`: its workspace and Mains stay a Missions place until the owner archives it; nothing is moved or archived.
- **Missions places** (`missionsPlaceOf`): the root, the earlier home, a mission's workspace (by id or folder). `isMissionsHome` is true for any of them — a paseo-bm home, never a repo. A Main's turns are read in every place it worked (`mainPlacesOf`: its mission's workspace, the root, the earlier home, a legacy mission's repo); A-14 counts the `manager` records of every Missions place.

**Plugin homes are not projects.** `listedWorkspaces` stays raw (the creation hook's `workspaceOfFolder` needs the home to bind a Main created there). `isPluginHome(workspaceIdOrDirectory)` (the Missions home and the Orchestrator home) is applied **in each project-view caller**: `bm_projects` and the stored-workspace list it reads (`orchestrator-tool-context.ts`), `bm_peers`, project resolution of links, the Work, Inbox and Insights project lists, the overview counts and the event scope. A Main's own turns are traced under the home; those records are read by mission, never as a project.

### 3.2 Labels and title

- **Labels:** a Main carries `bm.role=manager`, `bm.missionId=<missionId>`, `bm.missionCode=<code>` and `bm.version`. The Orchestrator's `bm.orchestrator=main` is unrelated.
- **Title:** `"<code> <name>"`, prefixed by the role hook with `🟣 M · `; at most 200 characters, the name cut at a word end.
- **Keeping it.**
  - A rename of the mission sets the Main's title with `setAgentTitle` (`paseo-cli.ts`).
  - On a cleared conversation, `createTitleMarker` rebuilds the full title from `bm.missionId` → the mission, not only the marker.
- **Finding a Main.** `findMain(missionId)` lists live `bm-manager` agents labelled with that mission, the newest first, skipping `bm.replacedBy`.

### 3.3 Creating a mission and its Main

**From the Command Center or the Missions screen.** The Command Center's "New mission" opens the Missions screen's New mission form (ADR-034 decision 4). `missions.create { name?, code?, repos?, goal? }` behaves as follows:
- With a name and a code, it writes the mission (state `open`, `createdBy: owner`) and creates its Main in the mission's own workspace.
- Without them, it creates an **unassigned Main** in the root: a Main with no `bm.missionId`. Its brief asks the owner the name, code, goal and repositories, and records them with `bm_mission_start`; the mission's workspace is made then, and the Main keeps its conversation in the root until it is replaced (its successor starts in the mission's workspace).

**From Paseo's composer** — a `bm-manager` created by the owner:
- **In the root (or the earlier home):** the hook binding (base design §7.17.7) binds it, and it is an unassigned Main as above.
- **In a mission's workspace:** it is that mission's — the successor of a cleared conversation (the claim window), or its Main when the mission has no live Main; when a live Main exists, it is an extra chat the owner opened on purpose, left alone.
- **In a repo workspace:** it becomes a one-repo mission (§3.6).

A charter repo must be a listed, unarchived repo workspace (not a plugin home).

**Placement (checked live on a daemon).** A child created with `parent` and a repo's `cwd` but no `workspaceId` is placed by Paseo **in the parent's workspace, with the parent's folder as its cwd**; with an explicit `workspaceId` it is placed in that repo with the repo's folder and keeps the `paseo.parent-agent-id` label. So a Main's Workers are always created through `paseo.workspaces.ref(<workspaceId>).agents.create({ config, parent: <Main>, … })`, never `paseo.agents.create({ cwd, parent })` — the workspace being the mission's placement of the repo, made at its first Worker (delivery line design §3.3), or the repo itself for a mission still waiting for its checkpoint.

**A Main's reads.** From the home, Claude in its `default` mode stops on a permission prompt to read another repo's file; Claude in `bypassPermissions` and Codex read it. The Main's `bm_repo` (§4) is therefore its supported way to read its repos.

**Creating the Main** (`createMain(missionId)`):
- It is created through `createFromProfile` (never `ensureRolesFor` from a tool call) in the home, with the labels of §3.2, a binding `{ role: "manager", workspaceId: <home>, missionId }` and the brief of §3.5. `mainHistory` gains the entry.
- An unassigned Main gets `missionId` on its binding and labels when `bm_mission_start` settles (labels through `paseo agent update --label`, values matching `^[A-Za-z0-9][A-Za-z0-9._-]*$`).
- **A cleared conversation is a replacement.** Clearing archives the agent and creates a new untitled one (`role-title.ts`), and archiving revokes the old binding. At `agent.archived` of a Main of an open mission the plugin notes the mission as **awaiting a successor** for 60 seconds; a `bm-manager` created in the home in that window, with no mission of its own, is claimed as the successor (§3.4) and titled from the mission; the claim does not depend on Paseo carrying labels across a clear.

### 3.4 Replacing a Main without losing work (REQ-188)

`mission.ensure { missionId, replace?: "outdated" | "owner" }`, the fallback switch, a cleared conversation (§3.3) and a code handoff (§9.5) replace a Main the same way.

**Resolve at delivery, not at write.** Everything addressed to "the Main" is resolved when it is delivered, from the mission (its `mainId`) or the registry's `managerId`, so nothing queued for an old Main is lost:

- `deliverRecord` resolves the target of every record **addressed to a Main** — `report`, `no-verdict` relayed upward, a Worker's `ask-main` — at each attempt and after a queue drop, as it already does for peer kinds (`usePeerTargets`); a record is "addressed to a Main" when its `to` is, or was, the `managerId` of its request.
- The notice queue's in-memory entries for the old Main are re-enqueued for the new one when the replacement completes (`noticeQueue.retarget(old, new)`).
- Stores that hold a Main's agent id gain the mission and resolve through it: prepared commands (`shared/decisions.ts` prepared action `agentId` → `missionId` when the target is a Main), the commands store (`orchestrator-store.ts` `managerId`), pending handoffs (`handoff-store.ts`, the successor's parent), peer links (`to.managerId` for `ask-main` and `mission` links), fallback incidents (`fallback-state.ts`) and proposed answers and proposed mission changes (in memory, keyed by Main; dropped with a log line when their Main is replaced — the owner's words stay in the chat).

**The steps,** in this order:

1. Create the successor in the home with the brief of §3.5 and `bm.replaces=<old>`; set the mission's `mainId` (from here every resolution above finds the successor).
2. Reassign the open requests of the roster: registry `managerId` = new (`registry.reassignManager(workspaceId, requestId, managerId)`).
3. Re-point bound Workers: binding `parentId` = new (`bindings.reparent(agentId, parentId)`), then the existing `BM-SETTINGS` "The Beads Manager you report to was replaced …" line to each live Worker of the mission.
4. Re-label the Workers' `paseo.parent-agent-id` (`paseo agent update --label`) when the label can be written; every `parentOf` reader of a Worker of a mission (`traces.ts`, `action-boundary.ts`, `request-registry.ts`, `no-verdict.ts`, `interruption-watch.ts`, `chat-peers.ts`, `unbound-relay.ts`) reads the registry's `managerId` first and the label only for a request without a mission.
5. Mark the old Main `bm.replacedBy=<new>`; `mainHistory` and the journal record the replacement.

`managersRequest` accepts the mission's current Main for every request of the mission's roster. The field failures — "no longer a live manager", "request belongs to another Manager" — cannot recur because nothing is addressed to a Main's id at delivery time.

### 3.5 The Main's brief and Runtime facts

- **First prompt** (`mainBriefOf`, `missions-home.ts`): `BM-BRIEF manager requestId: none mission: <code>`, the mission's name, id, goal and charter state, the repos with their folders, then the rendering of the mission state (`renderMissionState`, mission runtime design §2.2: what is in flight, what waits on whom, links, the owner's recent exchange, the governor, the journal); "Read the whole mission with bm_mission." only when the state cannot be read. An unassigned Main starts with `UNASSIGNED_MAIN_BRIEF` (`mission: none`).
- **Runtime facts:** a `Mission:` line, then `Mission level:` (its delegated and owner cells) and `Repo levels:` (the repos in scope; `role-instructions.ts`).
- **Owner precedents:** the global ones only. Repo precedents reach the Main through `bm_memory` and through the briefs it gives Workers.

### 3.6 Legacy one-repo missions (REQ-192)

At plugin start and at `manager.ensure { workspaceId }`, for a repo workspace with no open mission whose scope holds it:

- **The newest bound, live, non-replaced Manager** of that workspace becomes a mission's Main: `createdBy: legacy`, `legacyWorkspaceId` and `repos` = that workspace, `name` = the workspace folder's name, `code` = its first letters in upper case, made unique with a digit, `charter.goal` = "" (the Main asks the owner when it needs it). It is labelled with the mission and keeps its binding (`missionId` added); its open requests (registry `managerId` = it) join the roster. It stays in the repo workspace.
- **Every other live Manager** of that workspace (an unbound one, or older ones) is flagged `outdated-agent` with the remedy "open the mission's Main".
- **No Manager:** `manager.ensure` creates a one-repo mission and its Main **in the home**.

`manager.ensure { workspaceId }` — behind the sidebar's "Beads Manager", the Command Center's "Open Beads Manager", Work's "Open Manager" and the Inbox's replace action — opens the Main of the newest open mission whose scope holds that workspace, else creates the one-repo mission as above.

A `bm-manager` the owner opens from the composer **in a repo workspace**: when the workspace's mission has a live Main, it is an ordinary extra agent flagged outdated (the owner opened the wrong door); when it has none, it becomes that mission's Main (§3.4); when there is no mission, it becomes a one-repo mission as above.

Requests without a mission keep ADR-028's `project` links; `openManager` (creating a Manager in another project) is never used for a request of a mission.

## 4. The Main's tools

The Main's tools are bound Manager tools (`BM_TOOL_NAMES.manager`, nineteen). Rows marked † exist only for a Main of a mission.

| Tool | Input | Does | Refusals |
|---|---|---|---|
| † `bm_mission` | — | Reads the caller's mission: charter, plan (with `planNote` when a stored plan is not all numbered lines: it may be stale, ADR-045 decision 8), contracts, roster with each active request's repo, Worker, phase, newest report and open questions, each settled one as a line (the newest 20), the mission level, the newest 20 journal lines; `requestId` and `journal` ask for more (delivery line design §18.3) | not a Main of a mission |
| † `bm_mission_start` | `name`, `code`, `goal`, `repos` (workspace ids or folders) | An unassigned Main's first act: records a **proposed** mission (keyed by the Main and its turn's start mark); at the turn's end it settles only if the turn holds the owner's own message (as `bm_answers`). Creates the mission, labels and binds the Main | already in a mission; code taken; a repo unknown or a plugin home |
| † `bm_mission_update` | any of `name`, `code`, `goal`, `nonGoals`, `doneCriteria` (add, edit text, set status), `budget`, `plan` (1 to 30 one-line steps of at most 200 characters, stored as `1. …` lines; a fact goes to `bm_memory` or a contract, ADR-045 decision 8; refused while a line is live), `steps` (an ordered list the owner approves once on one card, ADR-045 decision 1, delivery line design §19.6), `contracts` (add, new version), `repos` (add or remove), `confirmCharter`, `close`, `transfer` (requests to another mission, its own card; mission runtime design §5) | **Free for the Main:** `plan`, `contracts`, criterion **status** with evidence, new criteria; adding a repo at mission level `scope-repo`. **On the owner's card:** everything else — `name`, `code`, `goal`, `nonGoals`, `budget`, `confirmCharter`, `close`, removing a repo, editing or dropping a criterion, adding a repo without `scope-repo` — opens an `m:` decision (§4.1) whose options are "apply" and "keep as is", the change attached as a prepared change; the plugin applies it on the owner's tap. Each applied change adds a journal line | code taken; a repo unknown, archived or a plugin home; `close` while a Worker of the mission runs |
| `bm_create_worker` | + `project` (required when the mission has more than one repo) | `project` must be in the charter's `repos`. The Worker's `cwd` is that repo's directory; its binding `{ role: "worker", workspaceId: <repo>, requestId, parentId: <Main>, missionId }`; the request is registered **in that repo** with `managerId` and `missionId`; the roster gains it; the creation project (child mode, action boundary, autonomy) is that repo's. The brief adds `mission: <code> <name>`, the request's place in the plan (`planStep`), the repo's memory (§7), and the mission's contracts touching the repo. From the cut-over the Worker works in the mission's placement of the repo (delivery line design §3.3). Without `staffing` delegated, refused when the mission already has a live Worker in that repo or `charter.budget.workers` live Workers in all | `project` outside the scope, archived or a plugin home; the `staffing` rule above; the other refusals of base design §7.15 |
| `bm_create_worker` (the line) | + `after` (`req-…` or `hold-…`), `next`, `parallel` | One sequential request at a time across the mission's repos (delivery line design §19.6): while one runs, `next` holds new work, `after` holds work that needs a result, `parallel` opens a lane on the owner's quoted word. `line.supervised` off refuses nothing for the slot | a word the owner did not type; none of the three beside a running request |
| † `bm_hold_cancel` | `holdId`, `why` | Cancels a held request (or a started step paseo-bm said has stopped): its Worker is not created, a started step's Worker is left alone; a journal line (delivery line design §19) | — |
| † `bm_hold_release` | `holdId`, `why` | On the owner's word: a `waiting-stopped` entry starts past its stop; the budget cap holds (delivery line design §19.6) | a started step; any other state |
| `bm_tell_worker` | base design §7.15 | The request is found through the request index; the caller must be the request's `managerId` (the mission's current Main) | — |
| † `bm_link_workers` | `requestIds` (exactly 2, both of the caller's mission, live Workers), `topic` (≤ 2,000) | Opens a `worker` link, `taken` at once, from the first request's Worker to the second's; delivers to each a `peer-message` from the Main: "Your Main linked you with <other Worker> (<repo>, request <id>) about: <topic>. Talk on link <id> with bm_peer_reply." Adds a journal line | not two live requests of the caller's mission; a link between them already live (its id returned) |
| † `bm_ask_mission` | `mission` (a code), `text`, `kind?` | Opens a `mission` link to that mission's Main; delivers `BM-DELIVERY peer` with "from mission <code>"; the other Main answers with `bm_peer_reply` | unknown or closed mission; the caller's own |
| † `bm_answer_worker` | `requestId`, `answers` (1–5 `{ qn, option, why ≤ 300 }`) | Answers open `q:` decisions of its Workers within §8's rule, recorded `by: "main"`, `via: "main"` (new values of `ANSWER_BY` and `ANSWER_VIA`), delivered to the Worker as the Main's answer, never the owner's. An answer never carries a grant: an effect it allows still passes the repo's action boundary, whose grants come only from the owner | a question `ownerOnly`; not allowed by §8; a settled question (its answer named); a `h:`, `o:`, `m:`, held or override decision; an option with a `grant` or a prepared change; a free-text `other`; not a request of the caller's mission |
| † `bm_repo` (Main) | as the Orchestrator's read-only `bm_repo`, plus `read { path, from?, lines? }` for a file (`REPO_READ_LINES` 400 by default, at most 2,000) | Read-only git and file reads **limited to the charter's repos**, each read in the mission's placement of the repo (its own branch, delivery line design §3.1), so a Main whose working folder is the home can read the PRDs and code it plans from under any provider sandbox | a repo outside the charter; a path outside the repo; a secret-shaped path (the plugin's credential guard) |
| † `bm_memory` | `project`, `op`: `read` (`query?`) / `add` (`kind`, `text`, `source`) / `remove` (`id`, `why`) | Reads or curates the repo's memory (§2.5) | `project` outside the charter's repos |
| `bm_answers`, `bm_decisions` | base design §7.15; autonomy design §A.9 | `bm_decisions` lists the open questions of every request of the mission. `bm_answers` (the owner's answer given in the Main's chat) refuses an `ownerOnly` question: only the card, or the owner's own words in the Worker's chat, answer it | — |
| `bm_peers` | base design §7.17 | Lists missions (code, name, Main, repos) instead of plugin homes, and the caller mission's links of every kind | — |
| `bm_peer_reply` | base design §7.17 | As for any agent. A Main has no `bm_ask_project` (the Worker's only; a Main calling it gets "Unknown tool"): it gives the work a Worker in a mission repo, adds the repo, or asks another mission | — |
| † `bm_answer_fallback` | `decisionId` (`f:`), `option`, `why` | Resolves an open provider fallback of its mission's request where the authority names the Main (ADR-040; mission runtime design §4.5.1); the plugin runs the switch or wait | another mission; no delegation; `ownerOnly`; settled; an unavailable option |
| † `bm_owner_question` | `question`, `options` (2–5, one recommended), `class`, `subject?`, `ownerOnly?`, `answered?`, `about?` | Asks the owner as an `m:` decision on the mission (§4.1); `answered` records the owner's answer typed in the Main's chat, settled at the turn's end (mission runtime design §4.6) | — |
| † `bm_split_mission` | `name`, `code`, `goal`, `repos`, `requestIds?`, `reason` | On the owner's yes, suggests to the governor that work belongs to a new mission (§9.6) | as `bm_create_main`; a code it already suggested |

### 4.1 Mission decisions (`m:`)

A mission change that needs the owner (`bm_mission_update`), a split (§9.6) and an arbitration that changes a goal are stored decisions with the id `m:<missionId>:<n>`, in `<data>/missions/<missionId>.decisions.json` (the decision schema reused; the per-workspace store is untouched). Their options carry a prepared change of the kinds `mission-change` (`shared/mission-change.ts`, kept out of `PREPARED_CHANGE_KINDS` so the Orchestrator's `bm_ask_owner` cannot offer it), `mission-split` and `arbitration`, applied by the plugin on the owner's tap and never by any agent. The Main's own questions to the owner (`bm_owner_question`) and a transfer of requests are `m:` decisions too. They appear in the Inbox with the mission's code; `bm_decisions` lists them for the Main. No policy, Main or Orchestrator answers an `m:` decision.

## 5. The Worker's side

- **Asking another repo** (`bm_ask_project`) from a Worker whose request has a `missionId` opens an `ask-main` link to **its own Main** and delivers `BM-DELIVERY peer` to it:
  - `kind: ask-main`, the target repo, the ask quoted;
  - "Your Worker <id> (<repo>, request <id>) needs work or a fact in <target>. Link it with the Worker already on that work (bm_link_workers), or give it a Worker there (bm_create_worker project: <target>, peerLink: <link>), or answer it with bm_peer_reply."
  
  A target outside the charter needs `scope-repo` (the Main may then add it) or the owner. The asker's `waitingOnPeers`, the reply delivery, `forPeer` and the ceiling work as in base design §7.17.
- **`bm_create_worker` with an `ask-main` `peerLink`** takes the link for the new request (`to.requestId`, `to.workerId`). **`bm_link_workers` with a live `ask-main` link** of one of the two requests turns it into a `worker` link taken by the other request.
- **Talking on a link:** `bm_peer_reply` (base design §7.17). The answerer of a `worker` or `ask-main` link is the live Worker of `to.requestId`.
- **Questions:** `bm_questions` gains `ownerOnly?: boolean` per question — a fact only the owner knows (a login, an account or user id, a port of the owner's machine, a personal choice). It is stored on the decision (`ownerOnly: true`, an additive field). The policy, `bm_answer_worker`, a Main's `bm_answers` proposal, a Main-written `BM-ANSWERS` and every Orchestrator path refuse such a question; only the owner's card, or the owner's own words in the Worker's chat, answer it. **The guard:** the open path also marks a question `ownerOnly` when an option asserts something about the owner, in English or Vietnamese ("I have", "I've", "the owner has", "I am logged in", "tôi đã", "tôi có", "tôi đang", "đã điền", "đã đăng nhập", "của tôi"), logged when it fires.
- **Memory:** `bm_memory` `read` and `add` (kind `fact`, `convention` or `contract`) for the Worker's own repo.
- Reports, reviews, questions and handoffs are unchanged; their records live in the Worker's repo.

## 6. Main-side lookups that change

Each row is a place that finds a request's Main or repo through the request index or the mission, never as "the Manager of a workspace".

| Where | How it finds the request's repo or Main |
|---|---|
| `deliver-tools.ts` `managersRequest`, `bm_tell_worker`, `bm_answers` | Read the registry of `requestIndexOf(requestId).workspaceId`; the ownership rule `managerId === caller` stays |
| `decision-materialiser.ts` on a Main's turn (`context.workspaceId`), `workerOfRequest`, `proposed-answers.ts` | Each block's repo from the request index; proposed answers keyed by Main **and** workspace |
| `collector.ts` (a turn's outbox records under the agent's own workspace) | A Main's records are read from the outboxes of the workspaces its turn wrote to (the request index of each record's `requestId`) |
| `traces.ts` `managerAgentId` (from Manager records in the same trace file) | From the registry's `managerId` |
| `stall-watcher.ts` (skips traces without `managerAgentId`) | As above, so requests of a cross-repo Main are watched |
| `event-bus.ts` finish dedupe key (includes the record's workspace) | The **request's** workspace (the registry's), not the turn record's, so a Main's copy in the home and the Worker's in the repo collapse |
| `command-send.ts` `copyRecipientOf`, `orchestrator-tool-context.ts` `requireManager` | The Worker's parent from its binding; a Main target by `missionId` |
| `fallback-manager.ts` (tells the old Manager's workspace's Workers) | §3.4 |
| `handoff.ts` (the parent Manager in the same workspace) | The parent Main from the binding |
| `compaction.ts` Manager brief | Reads the mission (§3.5) |
| `manager.ts` `listWorkspaceAgents`, `client/agent-tree.ts`, `client/chat-card-parties.ts` | A Worker's Main is shown as its parent although it lives in the home |
| `peer-tools.ts` `managerOf`, `newestManagerOf`, `openManager` | `project` links only; `ask-main` and `mission` route by mission |
| `outdated-agents.ts` remedy | `mission.ensure { missionId, replace: "outdated" }` |
| `action-boundary.ts` `requestOfAgent` | The request from the binding, not the parent's workspace |
| `role-instructions.ts` child mode from the creator's project | From the target repo at `bm_create_worker` |
| `decision-materialiser.ts` `settleBlock`, `expireFinished`, `reverseReopened` on a Main's turn | The block's repo from the request index |
| `deliver-tools.ts` `bm_tell_worker` (stores in the caller's outbox) | Stores the `message` record in **the request's repo** outbox, so the registry cap's `outboxKeeps` and the repo's views see it |
| `collector.ts` (outbox records only for Worker and Reviewer turns) | A Main's turn also gains its records, read from the repo outboxes of its turn's requests |
| `review-budget.ts`, `request-trace.ts`, `compaction.ts` (the request's Manager by workspace) | The registry's `managerId` and the request index |
| `create-worker.ts` `openLinkOf`, `folderOfAgent` | The link's mission and target repo; the folder of the target repo |
| `unbound-relay.ts`, `no-verdict.ts`, `fallback-state.ts` (parent and workspace) | The registry's `managerId`; the request's repo |
| `orchestrator-tool-context.ts` `requireManager`, `orchestrator-state.ts` `projectManagerOf`, `command-send.ts` `copyRecipientOf` | A repo's Mains are those of the missions whose roster has requests there; a command to "the Manager of a request" goes to its mission's current Main |

## 7. Project memory in briefs

- **Into a Worker's brief:** `bm_create_worker` adds `Project memory (<repo>):` — live entries within a 6,000-character budget, the mission's own first, ranked by the words they share with the request, each one line with its source, then one line for the rest (`BRIEF_MEMORY_CHARS`; [ADR-037](../adr/ADR-037-agents-are-given-a-bounded-context.md), delivery line design §18.2). The handoff successor's and a continuation's briefs carry the same.
- **For the Main:** `bm_memory read` gives an index of the live entries; a query or an id gives entries in full (delivery line design §18.3).

## 8. Autonomy: the two layers (REQ-189)

**The repo level** (ADR-025's per-project cells) is the level of the work in that repo; **the mission level** (§2.4) is what the Main may do on its own. Who decides a decision of a mission's request is one pure function, `deciderOf` (`shared/authority.ts`, mission runtime design §4.1), which `bm_answer_worker`, `bm_decide`, the mission state and the owner's views all ask. For a Worker's question (`q:`), the first rule that holds:

1. **`ownerOnly`**, or an option carrying a prepared change: the owner's card, or the owner's words in the Worker's chat. Nothing else.
2. **Repo cell `delegate`** for the question's class: the request's **Main** decides it with `bm_answer_worker` — the Main holds the goal's context. The answer counts as delegated for calibration (the ledger records `by: main`).
3. **Mission cell** of its group delegated — `answer-technical` for `scope`, `preference`, `reversible-technical`; `answer-effects` for the effect classes: the Main decides it only when an option settles it with no effect; otherwise the owner decides and the Main recommends (`mission-effects`).
4. **Repo cell `shadow`:** the owner decides; the Main's recommendation, given with `bm_answer_worker`, is recorded as a prediction (`PREDICTORS` gains `main`).
5. Anything else: the owner's.

- **The owner may answer first:** a decider other than the owner never hides the owner's card, and the owner overrides a Main's answer from "Decided for you" (§19).
- **Effects:** a Main's answer covers no effect (`grantCoverOf` counts the owner's answers only); what it lets a Worker do still passes the repo's action boundary, whose grants come only from the owner. So the effective authority over an effect is the lower of the two layers (ADR-029 decision 6).
- **Fallback incidents** (`f:`) of a mission's request go to its Main (`bm_answer_fallback`) when the repo cell delegates the class, or the mission delegates `answer-effects` and an option settles without effect (ADR-040); a repo-delegated incident of no mission goes to the Orchestrator (`bm_decide`).
- **The Main is told** at once of each question that is its own to answer or recommend on, by a plugin message (`tellMainOfQuestions`, mission runtime design §4.4), and reads them with `bm_decisions`.
- Requests without a mission keep the repo policy alone.

**The Main's own decisions:** `proceed` (take the next planned step without the owner's word), `staffing` (create Workers; more than one live per repo), `scope-repo` (add a repo), `split` (the governor may split this mission, §9.6). Above its level the Main asks the owner with `bm_owner_question`, or through an `m:` card for mission changes (§4.1).

## 9. The governor (Phase 2)

### 9.1 What stays and what goes

| | Change |
|---|---|
| `bm_decide` on `q:` decisions; `bm_predict` | **Retired** from the Orchestrator (the Main decides, §8; `bm_predict` altogether, §19); `bm_decide` keeps `f:` incidents outside a mission request; `o:` decisions are the owner's |
| `bm_direct_worker` | **Narrowed** to `intent: stop` with `interrupt`, while a danger or the governor's stop step (4) is open |
| `bm_send_command` | **Replaced** by `bm_govern` to a Main (§9.4) |
| `bm_ask_owner` | Kept; prepared commands go to a Main only |
| `bm_compact`, `bm_handoff` | **Retired** from the model; code runs them (§9.5) |
| `bm_projects`, `bm_request`, `bm_agent_messages`, `bm_repo`, `bm_why`, `bm_findings`, `bm_decisions`, `bm_note`, `bm_reply` | Kept; `bm_note` keyed by mission; a project's note goes to its project memory (§20) |
| `bm_missions` (new) | Reads missions with charter, roster, figures and ladder state (§9.2, §9.3) |
| `bm_govern`, `bm_arbitrate`, `bm_create_main` (new) | §9.4, §9.6 |
| Wakes `decision.opened`, `request.finished`, `advice.due`, `threshold.crossed`, `request.stalled`, `writers.observed`, `worker.signal` other than `danger` | **Retired as wakes**; they feed the figures |

### 9.2 Figures, computed in code (`governor-figures.ts`)

Recomputed on each recorded turn of a mission's agents and on the 60-second pass. Thresholds come from the Coordination settings `governor.*`, with these defaults:

| Family | Figure | Default threshold |
|---|---|---|
| **mess** | live Workers of one mission writing the same files (trace `file` evidence over the last 24 h) | 2 Workers on one file |
| | live Workers of one mission in one repo | > 3, or above `charter.budget.workers` |
| | repeated question subjects in a request | 2 re-asks |
| | dropped deliveries or commands of the mission | 1 |
| **overengineering** | process documents (`isProcessDocumentPath`) written by the mission, against the charter's done criteria count | > 3 per criterion |
| | beads created per finished request | > 15 |
| | tier raised after `received` | 2 requests |
| | review cap reached (`reviewCapReached`: even a new milestone batch would be refused); batches stopped by the convergence rule in 24 h (`unconvergedBatches`) | 2 requests; 2 batches (both `governor.reviewExhausted`) |
| | open owner approvals (open `q:`/`o:` cards of its requests and its `m:` cards; documents in Review or Draft are not counted, no store holds them) | > 8 |
| **drift** | the Main's turns started by the owner or a Worker report (trace `trigger`) since a done criterion was last **met with evidence** (`metAt`) | > 40 turns |
| | finished requests since a done criterion was last met with evidence | > 6 |
| | requests or links in repos outside the charter | 1 |
| **stuck** | stalls (a stopped, continued or structurally waiting request left out), unanswered links (`peer-unanswered`), cards older than 24 h | each |
| **budget** | requests, Workers, review calls or days against `charter.budget` | ≥ 100% |
| *the line* | `uncommittedHours` (mess), `behindIntegration` (drift), `unpushedNoMr`, `ciRed`, `mrConflicting` (stuck): delivery line design §4.9 | `governor.uncommittedHours`, `behindCommits`, `unpushedHours`, `ciRedMinutes` |

Every figure above is computed and shown; the `mess` and `drift` families are quiet on the ladder (§9.3; [ADR-045](../adr/ADR-045-a-mission-runs-as-a-supervised-line-of-approved-steps.md) decision 9). The figure ids are `GOVERNOR_FIGURES` (`shared/governor-figures.ts`) and the thresholds `GOVERNOR_BOUNDS` (`shared/coordination.ts`), both listed in §17.

### 9.3 The ladder (`orchestrator/governor.json`)

`{ version: 1, missions: { <missionId>: { <family>: { step: 0..4, since, figures, lastAction: { at, kind, id, figures? } | null, mainTurnsAt, held?, underSince? } } }, digests?: { <missionId>: <at> } }`

| Step | Who acts | What happens |
|---|---|---|
| 1 record | code | When a figure crosses its threshold: a journal line |
| 2 nudge | code, no model | A `BM-COMMAND` to the Main (`from: orchestrator`, `authority: governor:nudge`, `effects: none`, through `command-send.ts`): the family, the figures with their thresholds, the charter line they concern, and "Re-plan or explain in one line in your next reply; the governor checks again in <window>." No new delivery kind |
| 3 re-plan | the model, woken | The figure still holds after the window (default 30 minutes and 5 more Main turns). The governor reads the mission and sends `bm_govern { step: "replan" }` |
| 4 escalate or stop | the model | It escalates with `bm_ask_owner`, or stops a Worker (`bm_direct_worker` stop) on real risk |

- A figure back under its threshold resets the family to 0, with a journal line, only after it stays under for `governor.windowMinutes` (30 by default; `underSince`). Crossing again restarts the wait (delivery line design §8.4).
- **A quiet family** (`QUIET_FAMILIES`: `mess`, `drift`; ADR-045 decision 9) records at step 1 and goes no further: `ladderStepOf` never returns `nudge` or `replan-due` for it, one stored above step 1 stays there until its figures clear, and it is in no digest. `stuck`, `overengineering` and `budget` keep their ladders. `dropped` and `uncommittedHours` are `mess` figures: those are left to the alert, the page and the owner.
- **A spent code-nudge pool** holds the family at its step (`held: { pool, until }`, one journal line, no retry). The figures go into a daily digest to the Main: a `message` from `plugin`, at most once per 24 h, kept in `governor.json` `digests` (delivery line design §8.3).
- **Step 4's `bm_ask_owner`** about a mission's process is the only way the governor reaches the owner. Below step 4 it is refused, except in two cases:
  - the owner wrote to the Orchestrator in the last 2 hours;
  - the ask is about a goal change or a split.
- The intervention log (A-12) records each step 2–4 with its outcome check.

### 9.4 Commands to a Main

`bm_govern { missionId, step: "nudge" | "replan" | "arbitrate", text ≤ 4,000, figures? }` builds a `BM-COMMAND` with `from: orchestrator`, `authority: governor:<step>`, `effects: none` and `to:` the mission's current Main, and sends it through `command-send.ts`.
- The authority is structural, like `coordination:handoff`.
- The loop guard counts per mission in four pools per 24 h (delivery line design §8.1). One kind never spends another's pool:

  | Pool | Setting | Default |
  |---|---|---|
  | Code nudges | `governor.quotaCodeNudge` | 6 |
  | Re-plans | `governor.quotaReplan` | 3 |
  | Arbitrations | `governor.quotaArbitrate` | 4 |
  | Other | `governor.quotaOther` | 4 |

- A command entry carries `governorStep` and `by` (code or model).
- A repeat `bm_arbitrate` of an area already decided returns the standing arbitration, and a repeat re-plan with figures no worse returns the standing re-plan. Neither sends or spends anything.
- A command addressed by mission is delivered to whichever Main holds the mission when it is sent.
- A `nudge` whose named figures are all of quiet families (§9.3) is refused in one line and sends nothing. A `replan`, or a `nudge` naming another family or no figure, goes.

### 9.5 Compaction and handoff in code

The safe-point runners of `compaction.ts` and `handoff.ts` run by themselves when the Coordination thresholds are crossed, for Workers (successor under the same Main) and for Mains (§3.4). They tell the Main in one notice. The Orchestrator is not woken.

### 9.6 Arbitration and splits

- **Conflicts** are detected in code as `mission.conflict { missions, workspaceId, area, evidence }`. Their sources are:
  - two open missions whose placements of one repo change the same files against the integration branch (ADR-035). This is read-only `git diff --name-only origin/<target>...<branch>`, cached once a minute (`line-watch.ts`). It is an early "expect a merge conflict" signal, and it replaces the charters' written areas.
  - a `project` or `mission` link from one mission into another's area.

  Two missions' Workers never write one checkout: each mission writes its own branch in its own worktree (delivery line design §3, §4.7). `writers-observed` watches inside one placement.

  They wake the governor, which reads both missions and answers with `bm_arbitrate { missions, workspaceId, area, owner: missionId, reason, goal? }`. That writes `orchestrator/arbitrations.json`, adds a journal line to both missions and sends a `governor:arbitrate` command to both Mains. A call that changes a goal is an `m:` decision of the losing mission (§4.1), the `arbitration` prepared change applied on the owner's tap.
- **Splits:** `bm_create_main { fromMissionId, name, code, goal, repos, requestIds?, reason }`.
  - **Authority:** an `m:` decision of the source mission the owner answered with the `mission-split` prepared change (the plugin then creates the Main itself), or the source mission's `split` cell (the governor's own `bm_create_main`).
  - **What it does:** writes the new mission (`createdBy: orchestrator`, `parentMissionId`), moves the named requests' roster entries and registry `managerId` (§3.4 steps 3–5 for those requests only), creates the Main, and tells both Mains.
  - **Refused:** the source's Main running a turn; an area another open mission works in or an arbitration gave away; more than 2 splits of one mission per 24 h (`MAX_SPLITS_PER_DAY`); a missing authority.
- **A Main suggests a split** with `bm_split_mission` on the owner's yes; the governor decides it (§17).

### 9.7 Wakes

| Event | Wakes the governor when |
|---|---|
| `mission.signal` | a family reaches step 3 |
| `mission.conflict` | always |
| `mission.scope` | a request or link targets a repo outside the charter and the Main cannot add it (`scope-repo` not delegated), and the Main has not asked the owner within the window |
| `mission.review` | every 10 finished requests of a mission, or at 50% and 100% of a budget |
| `mission.split` | its Main, on the owner's yes, suggested that work belongs to a new mission (`bm_split_mission`, §17) |
| `worker.signal danger` | a mission's Worker: as its Main's backup, from `backupAt` (§20); another Worker: in the policy's scope |

On a wake, `mission.scope` is a `bm_note` unless the goal changes (then `bm_ask_owner`), and `mission.review` governs only stuck work, overengineering and budget (`roles/orchestrator.md`, ADR-045 decision 9).

Events are batched in `BM-EVENTS`, one mission per message with its brief (§20), at most one wake per mission per 15 minutes except `danger`. A wake that ends with no action is recorded per event type (M-26).

## 10. The Missions screen (Phase 3)

The owner approved the mockup on 2026-10-10 ([`mockups/missions-screen.html`](mockups/missions-screen.html), artboards A–F); it is the contract ([ui-must-match-mockup]). Colours are theme tokens (`surface0/1/2`, `border`, `foreground`, `foregroundMuted`, `accent`, `accentForeground`, `statusSuccess/Warning/Danger`), radius 2, the shared pieces of `plugin/client` (`TextTabs`, `Segmented`, `Button`, `Chip`, `CardFrame`, `KindBar`, `ConfirmBlock`, `StageBarRow`, `ToneText`).

### 10.1 Placement and navigation

- **A section** `missions` of the surface, between Inbox and Projects (`SURFACE_SECTIONS`): label "Missions", its own branch in the launcher's router.
- **One screen, four views:** the list (A, C), a mission's page (B, D), New mission (E) and Project memory (F). The page replaces the list; "Missions ›" goes back. On a phone the page's chips (Contracts, Journal, Plan, Project memory) open each part in place, and "⋯" holds Rename and Close mission.
- **The phone's tabs:** the mockup's phone artboards show four tabs; the built tab bar keeps "Tools" as a fifth equal tab, so no section is lost on a phone (a departure from the artboards; the others are in §18).
- **Project memory from Projects:** the project page gets a "Memory" action that shows the same view (F).
- **Polling:** the list and the page every 10 s while shown (`WORK_POLL_MS`).

### 10.2 What each element shows

| Element (artboard) | Source |
|---|---|
| Card bar, code, name (A, C) | the mission; open cards carry the accent bar, closed ones are dimmed (opacity 0.7) without it |
| Main state chip | the current Main's Paseo status: `idle` (success square) "Main idle", `running` (accent) "Main working", error (danger) "Main stopped", none (muted) "No Main" |
| "level 2 · proceed, staffing" | the mission level and its delegated classes, in the class words of §10.3 |
| Repository chips, "3 live Workers · 7 requests" | `charter.repos` by project name; the roster's live Workers (`liveWorkersOf`) and its requests |
| Progress and "Done criteria 5 of 11" | met criteria of those not dropped |
| "2 questions for you" | open decisions the owner answers for the mission: `q:` of its requests in the owner's Inbox and its `m:` cards |
| Governor chip "4 Workers on one area — nudged 12 min ago" | each family at step ≥ 1: its first crossed figure in words (§10.3) and its last action with its age |
| "No questions · no signals" | neither |
| Closed card | "closed <date> · <repos>" |
| Stats (B, D) | done criteria; live Workers with "budget N" when the charter has one; questions for you (warning tone above 0) |
| Charter card | "Charter · confirmed <date>" (or "not confirmed"); goal; repositories with "+ Add" (open missions); non-goals as "Not in this mission"; the first 4 done criteria with a box (met: success fill; dropped: muted, "— dropped"; open: empty) and "+ N more" that shows the rest |
| Mission level card | `Segmented` 0–4; "The Main decides:" its delegated classes; "Yours:" the rest; then "Governor": one line per family at step ≥ 1 ("Mess: … — Main nudged 12 min ago, re-plan due in 18 min"), one line for the families within bounds ("Overengineering, drift, budget: within the charter") |
| Workers by repository | one row per roster request: repository, `req-…<last 7>` and its topic (the request's title), Worker (role mark and the id's first 7), phase (`working` accent, `finished` success, `stopped` muted, `blocked` warning, with "· Qn for you" when an owner question of it is open), links (live peer links of the request by partner repository, "↔ <repo> · <messages>") |
| Contracts | id and title; "provider → consumers"; "v<version> · <time>" |
| Journal | the newest lines, "HH:MM <text>" (desktop 5, phone sub-view 20) |
| Plan | the plan text, "updated <time> by the Main · read-only" |
| The line (In flight, Waiting) | `mission.get.line { n, of, title, state, requestId, why }` (`mission-page-lanes.ts`; ADR-045 decision 5): one row "Step 2 of 4 · title · repo", what runs and where it is blocked; a started step that stopped still reads as started; a held step in Waiting shows `step` |
| New mission (E; its Projects part is [mission-projects.html](mockups/mission-projects.html) artboards L and M) | Name (≤ 80), Short code (`MISSION_CODE_PATTERN`), Goal; **Projects** — one row per Paseo project (not per workspace), named as Paseo's sidebar names it (`projectCustomName` or `projectDisplayName`), its folder shortened underneath, a checkbox, "N chosen", "Find a project…" past 6 projects (phone: 4 rows then "+ N more"). The value is the project's root workspace (its main checkout), opened by the form when none is open; paseo-bm's homes, mission placements and worktree-only projects are left out. Mission level `Segmented` with its sentence; "Cancel", "Create and open Main" |
| Project memory (F) | "Memory · <repo>", "<n> entries"; a row per entry: kind chip, text, source ("owner, Q2 · <date>", "Worker <id 7>", "owner · all projects") |

### 10.3 Words

- **Classes:** `proceed` "going on to the next step", `staffing` "creating Workers", `scope-repo` "adding a repository", `answer-technical` "Workers' technical questions your repos keep for you", `answer-effects` "Workers' questions with effects your repos keep for you", `split` "splitting the mission". The list card uses the short words `proceed`, `staffing`, `scope`, `answers`, `effects`, `split`.
- **Level sentences:** 0 "The Main asks you before each step.", 1 "The Main goes on to next steps by itself.", 2 "The Main goes on to next steps and creates Workers by itself.", 3 "… and decides Workers' technical questions.", 4 "… and adds repositories, decides questions with effects and lets the governor split the mission."
- **Figures:** each `GOVERNOR_FIGURES` id has one sentence built from its value, threshold and detail (`writersOnOneFile` "<n> Workers wrote <file> today (threshold <t>)", `workersInOneRepo` "<n> Workers at work in <repo> (threshold <t>)", …), in `missions-model.ts`.

### 10.4 RPCs (`shared/contracts/missions.ts`, `server/missions-rpc.ts`)

- `missions.list {}` → `{ missions: MissionSummary[] }`, open first (newest first), then closed (newest closed first).
- `mission.get { missionId }` → `{ summary, charter, governor, rows, contracts, journal, plan }` (the level and its delegated classes are in `summary`), plus, optional for an older server, `inFlight` and `mainHistory` (mission runtime design §2, §7), `waiting` (delivery line design §19.8) and `line` (ADR-045 decision 5); unknown → `E_MISSION_INVALID`.
- `mission.change { missionId, name?, code?, addRepos?, close? }` — the owner's own change from the screen, applied at once with the `m:` card's path: refusals as `missionChangeRefusalsOf` (a taken code, a repo that is no listed project, closing while a Worker of the mission runs, a closed mission), `applyMissionChange`, a `charter` journal line by `owner`, the Main told (`tellMain`), retitled and relabelled after a name or code change. Refusal → `E_MISSION_INVALID` with the reasons.
- `memory.list { workspaceId }` → `{ workspaceId, name, total, entries }`, newest first, at most 300.
- New mission uses `missions.create`, then `autonomy.set-mission-level` when the level is not 2 (3 and 4 after the in-place confirmation), then opens the Main (`navigation.openAgent`; without it, a notice).
- `mission.integration.revoke` and `mission.integration.ask` (`what: push | local-merge`) are the owner's integration grant actions of the page (delivery line design §4.3).
- Of the screen's handlers, every one only reads except `mission.change` and the integration actions; none creates or messages an agent but through `tellMain`.

### 10.5 Tests and the check

- `test/missions-rpc.test.ts`: each RPC's output from fixture stores, `mission.change` refusals and effects (journal, outbox message, no change on refusal).
- `test/plugin-missions-model.test.ts`: every element of §10.2 from fixture summaries, the words of §10.3, the form's validation; hook-free renders of the list card, the page parts, the form and the memory table (`renderTree`).
- **The visual check:** the screen in the preview harness (Vite and react-native-web with the real RPC handlers over a fixture data folder and a fake Paseo, outside the repository) at 1040 px and 390 px, each artboard compared element by element; the record is [the screen's acceptance](../operations/paseo-bm-missions-screen-acceptance-20261010.md).

## 11. Role files

- **`manager.md` is the Main's file** (at most 100 lines). Its five limits: it changes nothing; the owner decides the work; never say more than you can see; agents belong to the owner; secrets. The steps cover:
  - keep the mission (charter, plan of steps, criteria, contracts) with `bm_mission` and `bm_mission_update`, and answer "what is left" from the open done criteria;
  - give new work to a new Worker in the right repo (`bm_create_worker project`), holding it (`next`, `after`) while a request runs and opening a lane only on the owner's quoted word (`parallel`; delivery line design §19);
  - link Workers that must agree (`bm_link_workers`) and record the agreed contract;
  - route a Worker's `ask-main`;
  - answer Workers' questions within the mission level (`bm_answer_worker`), never an `ownerOnly` one, ask the owner with `bm_owner_question`, and resolve an assigned fallback with `bm_answer_fallback`;
  - go on to the next planned step when `proceed` is delegated;
  - talk to another mission only through `bm_ask_mission`; suggest a split with `bm_split_mission` on the owner's yes;
  - treat a governor command as process feedback, re-planning or explaining in one line.
- **`worker.md`:** asking another repo goes to its Main (`bm_ask_project`); `ownerOnly` on questions; `bm_memory` for facts it learns.
- **`orchestrator.md` is the governor's file** (Orchestrator design §3.2): read the figures and the charter; the plugin nudges, the governor acts from the re-plan on; arbitrate; split; never brief, correct or answer a Worker; never decide a business question.

## 12. Tests and acceptance

- **Unit tests per store and tool.** In particular:
  - the request index;
  - machine-wide request id uniqueness;
  - `bm_create_worker` across repos (binding, registry, creation project);
  - the replacement drill of §3.4 (requests, bindings, pending outbox, commands);
  - the owner-word settlement of mission changes;
  - `ownerOnly` refusals on every path;
  - legacy migration;
  - every row of §6;
  - the governor's figures and ladder.
- The replacement drill includes an unbound Worker, a pending handoff, a pending prepared command, a notice already queued, a pending outbox report and a cleared conversation.
- List-pinning tests cover delivery kinds, `ANSWER_BY`, `ANSWER_VIA`, `PREDICTORS`, prepared-change kinds, tool lists, alert kinds, `INTERVENTION_TRIGGERS`, `CLEANUP_DELETES`.
- **Acceptance** on an isolated daemon, recorded in `docs/operations/`: [the missions run](../operations/paseo-bm-missions-acceptance-20261009.md) (two scratch repos, one mission `AIX`, a goal needing a backend API; M-22 → M-25, and M-27 through a replacement drill — `mission.ensure replace: owner` while a Worker waits on a link) and [the governor run](../operations/paseo-bm-missions-governor-acceptance-20261009.md) (a scripted sprawl and drift with lowered thresholds, a two-mission conflict and a split; M-26). Both predate placements (delivery line design §3) and ADR-045's quiet families.

## 13. Compatibility

- **New stores** (`missions/`, `memory/`) are ignored by an older build.
- **New fields** on existing records — the registry's and the binding's `missionId`, the link's `kind` and `missionId`, the decision's `ownerOnly`, the answer values `main` — are **dropped** by an older build at its next write of that record (its schemas strip unknown keys). The roster and the mission files are the source of truth (§2.3); a decision whose `ownerOnly` was dropped is guarded again by the open-path guard only when re-opened. Moving back to an older build is supported for running work, not for missions' guarantees.
- **The request id format** is unchanged; uniqueness is machine-wide. The finish dedupe key stays `<workspaceId>:<requestId>` (historical ids may repeat across workspaces).
- **A Worker whose request has no mission** keeps the ADR-028 behaviour.
- **Agents on older instructions** are flagged outdated, as for every role-file change.

## 15. Phases

Delivered in four phases (ADR-030 first, then §2–§8, §9, §10 and §20); what each built is folded into the sections above and §16–§20, and the plan is in git.

## 16. As built — Phase 1 (2026-10-09)

The modules behind §2–§8 ([acceptance record](../operations/paseo-bm-missions-acceptance-20261009.md)):

- **Stores (§2).** `mission-store.ts` (`createMissionStore`: `get`, `list`, `byCode` — the mission closed last for a code no open mission holds —, `openByMain`, `codeTakenBy`, `create`, `update`, `setMain`, `appendJournal` and a tail-reading `journal(missionId, limit, kind?)`; `boundedMission` bounds every field, among them contract title 200, source 300 and `splitReason` 500; `journalQuietly` for a journal line that follows a state write: one log line when it cannot be written, and the caller still tells the Main). `mission-decisions.ts` (`m:<missionId>:<n>`, n 1–999,999, `{ version: 1, entries }`, asked by role `plugin` with the Main's id). `mission-roster.ts` (`requestIndexOf`, cached by file stats; `missionManagerOf`). `mission-autonomy-store.ts` (default level 2). `memory-store.ts` (`mem-<10 hex>`). The shared id and code patterns are in `shared/mission-change.ts`.
- **The home and the Main (§3).** `missions-home.ts` (`ensureMissionsHome`, `ensureMissionWorkspace`, `missionsPlaceOf`, `isMissionsHome`, `mainPlacesOf`, `mainBriefOf`, `SUCCESSOR_WINDOW_MS` 60 s); `plugin-homes.ts` (`isPluginHome`, `isPluginHomeIn`: the Orchestrator home is recognised by its folder and the trace store's last known folder). Titles in `role-title.ts`: `mainTitleOf` (≤ 200), `UNASSIGNED_MAIN_TITLE` "New mission", and a replaced Main's " · replaced" suffix, never re-synced. RPCs `missions.create { name?, code?, repos?, goal? }` (a bad or taken code is refused before roles or the home are touched) and `mission.ensure { missionId, replace? }`; errors `E_MISSION_INVALID`, `E_MISSION_WRITE_FAILED`. The Command Center's `new-beads-mission` opens the New mission form (§3.3).
- **Replacement (§3.4).** `mission-replace.ts` `replaceMain(missionId, newMainId, reason, deps)` is the one path for `mission.ensure` replace, a cleared conversation, a Main's handoff and the fallback switch; a Main never replaces itself. `outbox.ts` `mainTargetOf` re-resolves a record addressed to any Main of the mission — or whose `requestId` is an `m:` card or a mission id — at each attempt; while an open mission has no Main the record stays `pending`. `notice-queue.ts` `retarget`; `request-registry.ts` `reassignManager`; `agent-bindings.ts` `reparent`; `handoff-store.ts` `missionId`; prepared commands resolve through `commandManagerIdOf`. The successor claim (§3.3) keeps a successor labelled with the mission even when it appears before the old Main is archived, prefers it to an unlabelled one, and never claims the Main of another open mission. A Manager whose binding names a mission it no longer leads is refused by `bm_create_worker` (`REPLACED_MAIN_MESSAGE`).
- **Legacy (§3.6).** `mission-legacy.ts`: `migrateWorkspace` (idempotent; `legacyCodeOf`: the folder's first 4 letters or digits in upper case, made unique with a digit), `createLegacyMigration` at the first Paseo handle, `handleManagerEnsure` behind `manager.ensure`, `adoptComposerManager` at `agent.created`. Extra Managers raise `outdated-agent` with `EXTRA_MANAGER_DETAIL` and the mission's id; the Inbox offers "Replace Main" / "Open Main" through `mission.ensure` (alerts carry an optional `missionId`).
- **Tools (§4, §5).** `mission-tools.ts` (`bm_mission`, `bm_mission_start` — settled at the turn's end through `proposed-mission-starts.ts` —, `bm_mission_update`, `bm_answer_worker`, `tellMain`); an applied or kept `m:` card is told to the current Main by an outbox `message` whose `requestId` is the `m:` id. `create-worker.ts` (`staffingReasons`; the brief's `mission:`, `plan:`, `Mission contracts touching <repo>:` and `Project memory (<repo>):` lines). `memory-tools.ts`; `repo-tool.ts` `repoIn`. `peer-tools.ts`: `askMainText`; `bm_link_workers` turns the newest open `ask-main` into a `worker` link, else creates a taken one, its introductions `peer-message`s in each Worker's repo outbox; `bm_ask_mission` (`missionAskText`). Automatic memory entries come from `decision-store.ts` `rememberOwnerAnswer`.
- **Lookups (§6).** The materialiser's `inRepoOf`; proposed answers carry their repo; the collector's `mainReposOf`; `repoMainsOf`, `belongsToProject`, `commandManagerIdOf` and `copyRecipientOf` (with `home`) for the Orchestrator's targeting; `listWorkspaceAgents` shows the Main as a Worker's parent; `bm_projects` lists a repo's Mains; the stall watcher skips plugin homes.
- **Autonomy (§8).** `shared/autonomy.ts` `MISSION_CLASSES`, `MISSION_LEVEL_CLASSES`; `shared/authority.ts` `deciderOf`; RPCs `autonomy.set-mission-level`, `autonomy.set-mission-cell`; `autonomy.policy` carries `missions`. `ownerOnly` is guarded by `ownerFactOf` / `OWNER_FACT_PHRASES` (English and Vietnamese, NFC, curly apostrophes) and refused on every non-owner path.
- **Test safety.** `test/setup/no-real-installers.ts` points `PASEO_HOME` at a temporary folder and drops the agent's `PASEO_*` variables, so no test reaches a real daemon.

## 17. As built — Phase 2 (2026-10-09)

The modules behind §9 ([acceptance record](../operations/paseo-bm-missions-governor-acceptance-20261009.md)):

- **Figures (§9.2).** `server/governor-figures.ts` `governorFiguresOf(snapshot, bounds)` over `readGovernorSnapshot` returns `GOVERNOR_FIGURES` entries `{ family, id, value, threshold, op, crossed, detail }` (detail ≤ 200); recent means the last 24 hours (`GOVERNOR_RECENT_MS`). The ids (`shared/governor-figures.ts`):
  - mess: `writersOnOneFile`, `workersInOneRepo`, `reAsks`, `dropped`, `uncommittedHours`;
  - overengineering: `processDocsPerCriterion`, `beadsPerFinishedRequest`, `tierRaised`, `reviewCapReached` (stored by older builds as `reviewBudgetExhausted`), `unconvergedBatches`, `openApprovals` (open `q:`, `o:` and `m:` cards; a document in Review is not counted);
  - drift: `mainTurnsSinceCriterion`, `finishedSinceCriterion`, `outsideCharter`, `behindIntegration`;
  - stuck: `stalled`, `unansweredLinks`, `oldCards`, `unpushedNoMr`, `ciRed`, `mrConflicting`;
  - budget: `requestsBudget`, `workersBudget`, `reviewCallsBudget`, `daysBudget`, as a percentage of the charter's budget.

  `mainTurnsSinceCriterion` counts no turns while every done criterion is met or dropped and no request is open: the Main only answers the owner. `workersInOneRepo` counts the live Workers whose request is still open on the roster: a finished Worker left idle for its Main to reuse is no sprawl. Written files are `file` evidence and the files a shell command writes (an output redirection or `tee`, `shellWrittenPathsOf` in `shared/writers-observed.ts`), which the writers alert and a split's area check (`missionAreasOf`) read too. `dropped` counts the mission's dropped outbox records of the last 24 hours.

  The thresholds are `GOVERNOR_BOUNDS` in `shared/coordination.ts`, set as `governor.<name>` through `coordination.set`. Defaults: writersPerFile 2, workersPerRepo 3, reAsks 2, dropped 1, processDocsPerCriterion 3, beadsPerRequest 15, tierRaised 2, reviewExhausted 2, openApprovals 8, mainTurnsSinceCriterion 40, finishedSinceCriterion 6, outsideCharter 1, cardAgeHours 24, uncommittedHours 4, unpushedHours 24, ciRedMinutes 30, behindCommits 50, budgetPercent 100, windowMinutes 30, windowTurns 5; the pools quotaCodeNudge 6, quotaReplan 3, quotaArbitrate 4, quotaOther 4.
- **The ladder (§9.3).** `governor-store.ts` keeps `orchestrator/governor.json` (a ladder per mission and family, and the daily `digests`). `ladderStepOf` moves a crossed family 0 → 1 (a `governor` journal line), 1 → 2 (a nudge at the next recomputation; never for a quiet family) and 2 → 3 (`replan-due`) once both `windowMinutes` and `windowTurns` have passed. Steps 1 and 2 run in code: `nudgeCommandOf` goes to the current Main through `sendCommand` (backstop off, loop guard on, the code-nudge pool); a failed nudge is retried after 10 minutes (`NUDGE_RETRY_MS`). `createGovernor` recomputes at the stall watcher's pass and at each recorded turn, and writes through `GovernorStore.update`: the code climb replaces only families unchanged since it read them, so a `bm_govern` step written meanwhile stands.
  - Every step 2–4 writes an intervention entry: kind `govern` with its `step`, trigger `governor`, expected outcome `figures-clear` (every family the step concerns back at step 0 within 30 minutes). A stop only the stop step allowed is `kind: stop`, `trigger: governor`. An escalation through `bm_ask_owner` is not a `govern` entry.
- **Commands (§9.4).** `bm_govern { missionId, step: nudge | replan | arbitrate, text ≤ 4,000, figures? ≤ 20 }` (`command-authority.ts`): `from: orchestrator`, `to: manager`, `requestId` null, `re: Governor: <step>, mission <code>`, no effect, authority `governor:<step>`, then a `Figures:` block of the named figures read now (`governSend`, which reads the snapshot only for named figures or a nudge). It goes only to the current Main of an open mission (`governorTargetRefusalOf`), and the loop guard counts per mission in the pool of its step (§9.4). The backstop reads the Orchestrator's own words only (`CommandSend.backstopText`): a mission the owner named "Billing" does not read as cost. A nudge takes a family at step 1 to 2, a re-plan one at step 3 to `GOVERNOR_STOP_STEP` 4, and any other step on a family at step 1 or 2 restarts its window, minutes and Main turns (`governedLadderOf`).
- **Tools (§9.1).** The Orchestrator's sixteen, in order: `bm_projects`, `bm_missions`, `bm_request`, `bm_agent_messages`, `bm_govern`, `bm_arbitrate`, `bm_create_main`, `bm_decisions`, `bm_ask_owner`, `bm_decide`, `bm_direct_worker`, `bm_repo`, `bm_note`, `bm_findings`, `bm_why`, `bm_reply` (Orchestrator design §5, §6B.4).
  - `bm_missions { missionId?, closed? }`: each mission's charter, roster, figures (crossed first), ladder, open `m:` cards, open split suggestions and notes.
  - `bm_direct_worker` only stops (`intent: stop`, `interrupt: true`, no effect), while a danger signal of the Worker is open or a family of its mission is at the stop step; its Main gets a copy.
  - `bm_decide` answers only `f:` incidents outside a mission request whose class is delegated to it; a `q:` question is the Main's or the owner's.
  - `bm_ask_owner` prepares a command to a Main only; its effects are information.
  - `bm_note { workspaceId | missionId, text, replace? }`, exactly one id; mission notes in `orchestrator/notes/missions/<missionId>.json`, a project's in its project memory (§20.4).
- **ADR-031.** An answer to an `o:` decision grants nothing (`answerDecision`, `shared/decisions.ts`): `BM-ANSWER` names no grant and a prepared command goes with `approved: none`.
- **Events (§9.7).** The event bus publishes:
  - `mission.signal { missionId, family, figures, step: 3 }`, settled when the governor resets the family;
  - `mission.conflict { missions, workspaceId, area, evidence }`, settled when a mission closes;
  - `mission.scope { missionId, workspaceId, requestId | null, linkId | null }`, for work outside the charter while `scope-repo` is not delegated and no `m:` card asks it, after `windowMinutes`;
  - `mission.review { missionId, reason: finished-10 | budget-50 | budget-100 }`;
  - `mission.split` (below);
  - and keeps `worker.signal danger`.

  A mission's events are debounced 15 minutes (`MISSION_WAKE_MS`); the held events and marks are kept in memory, so a reload starts from a fresh baseline, and held events survive a publish that fails or finds no data folder or Paseo handle. `wakes.json` records each wake's event types and whether a tool acted (`acted`, M-26).
- **Conflicts and splits (§9.6).** `governor-conflicts.ts` `createConflictWatch` raises overlaps (`overlapConflictsOf`, read by `line-watch.ts`) and links (`linkConflictsOf`), at most 3 areas per pair and repo (`MAX_AREAS_PER_PAIR`); an area an arbitration of the same two missions settled is skipped. `orchestrator/arbitrations.json` keeps at most 500 entries `{ id arb-<10 hex>, at, missions, workspaceId, area, owner, reason, commandIds, decisionId }`.
  - `bm_arbitrate { missions[2], workspaceId, area ≤ 300, owner, reason ≤ 500, goal? ≤ 4,000 }` records the entry, writes both journals and tells both Mains with `governor:arbitrate` commands. A `goal` becomes an `m:` card on the other mission (the `arbitration` prepared change); its goal stands until the owner applies it.
  - `bm_create_main { fromMissionId, name ≤ 80, code, goal ≤ 4,000, repos 1–20, requestIds? ≤ 50, reason ≤ 500 }`: with the source mission's `split` cell delegated it runs `executeSplit` — a new mission (`createdBy: orchestrator`, `parentMissionId`, `splitReason`), `roster.move`, both journals, its Main, the requests reassigned (registry, bindings, labels) and both Mains told; a split that fails before its Main exists is undone (the requests go back, the new mission is closed, the source journal says so). Otherwise it opens the owner's `m:` card (the `mission-split` prepared change), one per code. `splitRefusalsOf` refuses an unknown or closed source, a taken or invalid code, a repo Paseo does not list or a plugin home, a request not on the roster, a source Main running a turn, more than 2 splits a day (`MAX_SPLITS_PER_DAY`), and requests that wrote an area another open mission works in (`missionAreasOf`, the last 7 days) or an arbitration gave away. The owner's tap goes through `decisions.answer` → `governorAnswerRefusalsOf` → `applyGovernorDecision`.
- **A Main suggests a split** (`bm_split_mission`, `mission-split.ts`). When the owner's new work is another goal, the Main asks the owner; on the owner's yes it calls `bm_split_mission { name, code, goal, repos, requestIds?, reason }` with the bounds of `bm_create_main`; the same refusals apply, except that its own Main may be running, plus a second open suggestion of one code.
  - It writes a `split-suggested` journal line with the details, and publishes `mission.split { missionId, code, name, goal, repos, requestIds, reason, at }`. Its key is `mission.split:<missionId>:<code>`; it is dropped once a mission takes the code or the source closes, and it follows the 15-minute mission window.
  - `bm_missions` lists each mission's open `splitSuggestions`, read from the journal (`openSplitSuggestionsOf`, §2.2). A suggestion the governor declines stays open until a mission takes the code or the source closes.
  - The governor decides: `bm_create_main` with the suggestion's fields (run on the `split` cell, else the owner's card), or `bm_govern` to the Main with why.
- **Compaction and handoff in code (§9.5).** The compaction and handoff runners act at a recorded turn that crosses the owner's threshold (`contextCrossingOf`; a Main's own figures, `mainCrossingOf`), within the Coordination settings, without waking the Orchestrator:
  - a Worker gets `/compact` and the `BM-STATE` brief; its handoff creates the successor in its repo under its Main and on the roster;
  - a Main is handed over through `createMain` with reason `handoff`, then `replaceMain` (§3.4).
- **The governor's file (§11).** `plugin/roles/orchestrator.md` (Orchestrator design §3.2).

## 18. As built — Phase 3 (2026-10-10)

The modules behind §10 ([visual check and acceptance](../operations/paseo-bm-missions-screen-acceptance-20261010.md)):

- **RPCs** (`server/missions-rpc.ts`, registered by `registerMissionsRpcs` after the Missions home):
  - `missions.list` and `mission.get` read only. A closed mission has no signals (the governor watches open missions only); its live Workers come from the roster.
  - The Main state is taken from one Paseo agent list: `idle` → idle, `running`/`initializing` → working, `error`/`closed` → stopped, missing, archived or none → none.
  - Questions are the unsettled `q:` decisions of the roster's requests in their repos plus the open `m:` cards. A row is `blocked` when an owner question of it is open or its Worker's newest report says so.
  - Links are live peer links in either direction by partner repository (plugin homes left out). The journal is the newest 50 lines (`MISSION_PAGE_JOURNAL`).
  - `mission.change` drops parts that change nothing (the same name, the same code, a repository already in the charter) and refuses an empty change ("nothing to change"). It checks `missionChangeRefusalsOf` (shared with the `m:` card path), applies `applyMissionChange`, writes a `charter` line by `owner` ("The owner changed the mission from the Missions screen: …"), tells the Main with the mission id as the reference, and retitles and relabels it (`syncMainAfterChange`, shared with `applyMissionDecision`).
  - `memory.list` lists the repo's active entries and the owner's active precedents of the repo and of all projects (source "all projects", else the deciding question, else "the owner's Settings"), newest first, at most 300 (`MEMORY_LIST_LIMIT`).
- **Client.**
  - `client/missions-model.ts` holds the pure views and the words of §10.3: `missionCardOf`, `missionListOf`, `missionPageOf`, `figureSentenceOf` (one sentence per `GOVERNOR_FIGURES` id), `governorLinesOf`, `levelSentenceOf`, `missionDraftErrors`, `memorySourceOf` (a source that already names the owner or carries the date says neither twice), `closeMissionDialog` (a `danger` confirm). Constants: `CRITERIA_SHOWN` 4, `JOURNAL_DESKTOP` 5, `JOURNAL_PHONE` 20.
  - `client/missions.tsx` `MissionsScreen` keeps one of four places: the list, a page, New mission, or memory (which remembers the page to go back to); `ProjectMemory` is shared with the project page's "Memory" action. Cards in a row grow to one height, as the artboards' grids do. The New mission form is one state, reset on New, Cancel and success, and Create waits for a level confirmation.
  - The Inbox names a mission's `m:` cards by their mission ("Mission AIX · AI Assistant ↔ xOne", from `missions.list`, read every 60 s, `MISSION_NAMES_STALE_MS`) and their asker as "Main".
  - `ConfirmDialog.confirmKind` (`danger` or `primary`) styles the confirm button.
- **Departures from the artboards, kept on purpose:**
  - The level cells and chips are local components: the shared `Segmented` fills the chosen cell with `surface2`, and the shared `Chip` is muted capitals; the artboards use the accent and normal case.
  - The quiet-families line lists `stuck` as well.
  - On a phone, "Closed · n" opens the closed missions.
  - The memory view has a back link and, from a mission, its repositories as chips.
  - A closed mission's page hides Open Main, Rename, Close mission and "+ Add".
  - New mission needs at least one repository.

## 19. As built — the review of 2026-10-10

What stands from the review of Phases 1–3 and the owner's answers of that day (the fixes themselves are folded into §16–§18):

- **Removed:** the builders and lines of the retired wakes (`decision.opened`, `request.finished`, `advice.due`, `threshold.crossed`) — their event types and keys stay for the watches, and a retired event's line names its type and project alone; the unverified-finish helpers of `request-trace.ts`; the bus's `decisionsOpened` and `workerTurnEnded` (`turnRecorded(record, paseo)` remains); the grant machinery of `command-send.ts` (no command spends a grant, ADR-031).
- **`f:` incidents:** delegated incidents of a mission request reach its current Main through the durable channel; it resolves them with `bm_answer_fallback` (ADR-040, mission runtime design §4.5.1). Other incidents keep their Orchestrator/owner authority.
- **`bm_predict` is retired:** the Orchestrator has 16 tools. A stored `prediction.orchestrator` is still read and shown, and the Main's `prediction.main` is the proposal at Co-pilot and up.
- **`bm_ask_project` is the Worker's only:** a Main calling it gets "Unknown tool", and peer tools run per role only what that role lists.
- **The re-plan window:** a `bm_govern` step on a family at step 1 or 2 restarts both its minutes and its Main-turn count (`governedLadderOf`).
- **The advice cadence is retired:** `advice.due` wakes no one since ADR-029, so the "Orchestrator advice" card, the event bus's counting and `advice-store.ts` are gone; `advice.everyFinished` is kept as a stored no-op. The Coordination copy says paseo-bm compacts and hands over, and names the Main.
- **The Main's answers in the owner's view:** `isDecidedForOwner` counts `by: main`, so a Main's answer is in "Decided for you" and the owner overrides it like a policy answer (the corrected answer reaches the Worker through `override:<id>`); every view names it "the Main", never "you" or "your policy"; `prediction.main` is hidden below Co-pilot as the Orchestrator's was. Settings → Autonomy and the decision card say "Main" where a Worker's question is decided or proposed ("Main suggests"; an older "Orchestrator suggests" still shows).

## 20. One governor, a mission per wake (ADR-032, 2026-10-10)

REQ-197 → REQ-201.

### 20.1 A mission per wake (REQ-197)

- **Groups.** The notice queue's batch items carry a `group` and may be `first` (`notice-queue.ts`). Items of one batch name and one group still pending at the target's idle moment go as one message, `compose(lines, group)`. Another group waits for the turn end that message starts. The oldest item of a `first` group goes before every other notice of the target.
- **The event bus's groups** (`wakeGroupOf`, `event-bus.ts`): `mission:<id>` for a mission's events and for a `danger` of a mission's Worker; `missions:<id>+<id>` for a conflict; `project:<workspaceId>` for a Worker of no mission. A `danger` item is `first`.
- **The brief** (`governor-brief.ts` `missionBriefOf`). Each message of a mission group opens with `## The mission now (read when this was sent; bm_missions has the rest)`, one brief per mission of the group, then `## Events` and the event lines. It is read from the stores at the idle moment, synchronously:
  - its code, name, id, state and Main;
  - the goal, repos, non-goals and budget;
  - the done criteria met and up to 5 open ones;
  - each ladder family above step 0 with its step, since when and its crossed figures;
  - the open `m:` cards, the governor's 3 newest notes on the mission, and the 4 newest `governor` journal lines (nudges, re-plans, arbitrations).

  Each text is cut at 300 characters (notes and journal lines at 200), the whole brief at 3,000. Text is masked with `redactText`. A mission it cannot find is one line saying so.
- **The 15-minute window** of §9.7 is unchanged and still counts per mission. A `danger` is not held by it.

### 20.2 A disposable conversation (REQ-198)

`wakeableOrchestrator` replaces a current, idle Orchestrator whose owner has not written in its chat for 2 hours when its load calls for it (`loadReasonOf`, `orchestrator-agent.ts`). The reasons are checked in this order:
1. its wakes in `wakes.json` name 4 distinct missions (`FRESH_ORCHESTRATOR_AFTER_MISSIONS`): "has governed N missions";
2. it carried 10 wakes (`FRESH_ORCHESTRATOR_AFTER_WAKES`): "has carried N wakes";
3. it was created more than 24 hours ago: "is more than a day old".

The chat is read only when a reason holds, and the 2-hour owner-silence rule holds for every reason. The old agent is left in the owner's list (ADR-005). The first prompt tells a new Orchestrator that each `BM-EVENTS` message is one mission's wake and opens with that mission's brief.

### 20.3 `danger` to the Main first (REQ-199)

For each newly raised `danger` alert, the Worker pass (`worker-watch.ts`) does the following:
- **Logs the danger.** It records an entry in the danger log (`openDanger`, §20.5).
- **Finds the Worker's mission.** It resolves the mission and Main of the Worker's request (`missionPlaceOf`): the rosters' request index, then the registry's `managerId`, else the mission's `mainId`.
- **Tells the Main.** For a mission's Worker it sends the Main `BM-SIGNAL` at once, ahead of what is queued, through the Main's channel (`enqueueNotice`, mission runtime design §6.2), kind `BM-SIGNAL:<workerId>`, at any repo level (`dangerSignalNoticeOf`, `shared/notices.ts`). The notice names the Worker, its request and repo, when it ran, and the redacted evidence. It tells the Main to stop that Worker now with `cancel_agent` and tell the owner why, unless the owner asked for it, and says the governor is told in 3 minutes if the Worker still runs. `BM-SIGNAL` is a plugin notice, matched as a whole word. When it goes out, the danger log gets `mainToldAt`.
- **Opens the allowance.** A mission's Worker is in the events' scope whatever the policy: the 10-minute interrupt allowance opens, and the `worker.signal` event carries `missionId` and, when the Main was told (`sent` or `queued`), `backupAt` = the alert's time + 3 minutes (`DANGER_BACKUP_MINUTES`).
- **Holds the governor's event.** The event bus holds such an event until `backupAt`; the governor's pass publishes held events each minute. It is dropped at delivery when its alert cleared first, because the Main stopped the Worker or its turn ended. When it goes out, the danger log gets `governorToldAt`.

A Worker of no mission keeps the old rule: events and the allowance only in the policy's scope, with no `BM-SIGNAL`. The owner's Inbox alert is unchanged everywhere. The notice says what to do, and the Main's rule 4 allows the cancel (`cancel_agent`, a Worker off course). The plugin itself stops nobody.

The governor's backup stop keeps `bm_direct_worker`'s authority (`stopAuthorityOf`): the project's default class (`reversible-technical`) delegated, the owner's own latest word in its chat, or an answered decision. At a repo where none holds, the refusal sends it to `bm_ask_owner`, and it stops with that `decisionId` once the owner answers. Who hears of a danger widens; who may stop a Worker does not.

### 20.4 No project-era residue (REQ-200)

- **`bm_note { workspaceId }`** writes that repo's project memory, not an Orchestrator note: a `decision` entry by `owner` (agent and mission null) with source `The owner, in the Orchestrator's chat, <date>` (`ORCHESTRATOR_MEMORY_SOURCE`). It is masked with the tool context's secrets. `replace: true` supersedes the newest active entry of that source. The memory's 300-entry bound refuses it like any owner entry. The memory format is unchanged.
- **Older project notes** (`orchestrator/notes/<workspaceId>.json`) stay readable through `bm_projects` and `orchestrator.state`, and are no longer written. Mission notes are unchanged.
- **The Orchestrator's home README** describes the governor of missions and its commands without effect (ADR-031). **The first prompt** names `bm_note`'s two targets and the wake shape.

### 20.5 Measured before splitting (REQ-201, A-13)

- **Wake records** (`wakes.json`) gain `missionIds`, sorted, at most 20, absent when the wake carried no mission. At the wake's end they gain `offMission`: how many successful acts of its turn aimed at a mission the wake did not carry (`actMissionsOf`). An act aims at its `missionId`, `fromMissionId` or `missions`, and `bm_direct_worker` at the mission of its `requestId`. An act that names no mission is never off-mission.
- **The danger log** `orchestrator/dangers.json` = `{ version: 1, entries }`, at most 500, the oldest raised dropped first. Each entry is `{ alertKey, workspaceId, workerId, requestId, missionId, raisedAt, mainId, mainToldAt, governorToldAt, endedAt }` (`dangerEntrySchema`): ids and times only, one entry per alert, and each time is set once. `endedAt` is set when the alert clears: the Worker stopped running, or its turn was recorded.
- **A-13** (evaluation design §4) reads both. It reports:
  - wakes per mission;
  - off-mission acts (M-28);
  - input + cached tokens per wake (M-30);
  - dangers raised and ended, the Main told within a minute, those that needed the backup, and the time to end (M-29);
  - `reopen`, which of ADR-032 decision 6's figures crossed.

  The replay prints it as a headline row.

### 20.6 Compatibility

Every stored change is additive. An older build ignores the wake fields and `dangers.json`; `cleanup` deletes the latter with `orchestrator/`. The role files change (`orchestrator.md`, `manager.md`), so running Orchestrators and Mains are outdated and replaced as for every role-file change.

## 14. Revision History

Rows before 2026-10-15 are archived in [paseo-bm-missions-revision-history-to-20261015.md](../archive/design/paseo-bm-missions-revision-history-to-20261015.md); git holds the full audit trail.

| Date | Author | Change |
|---|---|---|
| 2026-10-20 | Claude (as built, ADR-035 Phase 6) | §9.2 review-cap figures, drift by trigger and `metAt`; §9.3 reset after the quiet window, held families and the daily digest, the step-4 gate; §9.4 four command pools, free repeats (delivery line design §5, §8) |
| 2026-10-21 | Claude (as built, ADR-035 Phase 8) | §9.6 the conflict source is the overlap of mission branches' diffs; writer collisions between missions retired (delivery line design §3, §4.7, §4.9) |
| 2026-10-21 | Claude (as built, ADR-035 Phase 9) | §2.1 contracts' status and agreements; §2.6 typed link messages (delivery line design §9) |
| 2026-10-21 | hieu.nt10 (owner request and approval; written by Claude) | §10.2 New mission and the mission page's "+ Add" choose Paseo projects, not workspaces (workspace titles were chat titles and one repository showed once per workspace); repositories are named by their project's name everywhere on the mission page; mockup [mission-projects.html](mockups/mission-projects.html) artboards L, M, N approved as is |
| 2026-10-25 | hieu.nt10 (owner's answers; written by Claude) | §2.5 scope and life of memory entries, the bound counts live entries; §7 the brief's memory budget and the Main's index read ([ADR-037](../adr/ADR-037-agents-are-given-a-bounded-context.md)) |
| 2026-10-25 | hieu.nt10 (owner's answers; written by Claude) | Pointer to parallel lanes, `after` and `bm_hold_cancel` ([ADR-038](../adr/ADR-038-parallel-lanes-and-a-held-queue.md); delivery line design §19) |
| 2026-10-26 | Codex (owner request, ADR-040) | §19: route delegated request fallback to the Main instead of leaving recovery dependent on an unrelated governor wake |
| 2026-11-10 | Claude (as built, [ADR-045](../adr/ADR-045-a-mission-runs-as-a-supervised-line-of-approved-steps.md) Phase 2) | §4: `steps`, `bm_create_worker` in the line, `bm_hold_release`; §10.2: the line's row on the mission page |
| 2026-11-10 | Claude (as built, [ADR-045](../adr/ADR-045-a-mission-runs-as-a-supervised-line-of-approved-steps.md) Phase 1) | §4: `plan` holds only one-line steps, an older plan reads possibly stale; §9.2, §9.3, §9.4, §9.7: no `mess` or `drift` nudges, by code or by the Orchestrator |
| 2026-11-16 | Claude (owner request: documentation review) | Checked against the code and condensed: §16–§19 as-built logs cut to the current module map, §15 phases to a line, history removed; §2.1 schema's `workspaceId`, `placements`, `repoAliases`, `mergedInto`, `metAt`; §2.5 no memory-bloat figure; §3.5 the brief renders the mission state; §4 the Main's nineteen tools (`bm_answer_fallback`, `bm_owner_question`, `bm_hold_cancel`, `bm_split_mission`; no `bm_ask_project`); §8 the authority resolver (`deciderOf`), no 10-minute Main window; §9.2 the line's figures; §17 figure ids, bounds and pools, conflicts by overlap and links; §20.3 `BM-SIGNAL` through the Main's channel; rows before 2026-10-15 archived |
