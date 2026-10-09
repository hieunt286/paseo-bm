# paseo-bm — Missions, Mains and the process governor: Technical Design

| Field | Value |
|---|---|
| Status | Active — the contract the beads build to; edited in place as built |
| Owner | hieu.nt10 |
| Requirements | [Missions PRD](../product/paseo-bm-missions-prd.md) REQ-184 → REQ-196, M-22 → M-27 |
| Decision | [ADR-029](../adr/ADR-029-missions-mains-and-a-process-governor.md) |
| Builds on | [base design](./paseo-bm.md) §7.3 (Manager), §7.4 (bindings), §7.14–§7.17 (registry, tools, outbox, peer links); [Orchestrator design](./paseo-bm-orchestrator.md); [autonomy design](./paseo-bm-autonomy.md) Parts A, B, G |

Section numbers are cited by code; they are never renumbered.

## 1. Principles

1. **A request lives in the repo of its Worker.** Every per-workspace store — request registry, outbox, decisions and threads, traces, alerts, handoffs, autonomy (repo level), action boundary, worker-watch and stall state — keeps its format and is keyed by **the Worker's repo workspace**. The Main is the request's owner (`managerId`), not its location.
2. **A Main is found by its mission, never by a workspace.** Every lookup that today finds "the Manager of workspace W" finds "the Main of request R" through the mission roster (§2.3), or "the Main of mission M" through the mission store.
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
                          status: "open" | "met" | "dropped", at: string | null, evidence: string | null /* ≤ 500 */ }>,
    budget: { requests: number | null, workers: number | null, reviewCalls: number | null, days: number | null } | null,
    confirmedAt: string | null },  // the owner confirmed the charter
  plan: { text: string /* ≤ 20,000 */, updatedAt: string | null },
  contracts: Array<{ id: string /* C1… */, title: string, providerRepo: string, consumerRepos: string[],
                     text: string /* ≤ 4,000 */, version: number, updatedAt: string, source: string }> }
```

- Text fields are masked with `redactText`.
- **Index.** `missions/index.json` keeps `{ missionId, code, name, state, mainId, repos }` per mission, rewritten with each mission write, for lists and code lookups. A missing or stale index is rebuilt from the mission files.
- A closed mission keeps its files; its Main is not replaced.

### 2.2 Journal — `<data>/missions/<missionId>.journal.jsonl`

Append-only, one line per event: `{ at, kind, by, text ≤ 500, ref? }` — kinds `charter`, `plan`, `criterion`, `contract`, `worker`, `link`, `decision`, `main`, `governor`, `note`. At most the newest 5,000 lines are kept. The journal is what a successor Main and the governor read to see what happened; it is not the source of any state.

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

The default comes from Q-200 and the owner's answer of 2026-10-09 ("Main có thể tạo worker … tạo nhiều worker"): a new mission may go on to next steps and create Workers. Cells can be set one by one; the level is the highest whose cells all hold.

### 2.5 Project memory — `<data>/memory/<workspaceId>.json`

```ts
{ schemaVersion: 1,
  entries: Array<{ id: string /* mem-<10 hex> */, kind: "decision" | "precedent" | "fact" | "convention" | "contract",
                   text: string /* ≤ 1,000, masked */, source: string /* ≤ 300 */,
                   by: { role: "owner" | "main" | "worker" | "plugin", agentId: string | null, missionId: string | null },
                   at: string, supersedes: string | null, state: "active" | "removed" }> }
```

- **Automatic entries.** An owner's answered decision of a request in that repo adds a `decision` entry; a precedent of that repo (precedent store) is shown as a `precedent` entry, read through, not copied.
- **Bounds.** At most 300 active entries per repo. An `add` past 300 is refused with "curate the memory first (bm_memory remove)"; automatic entries past 300 replace the oldest automatic `decision` entry. The governor signals bloat at 250 (§9.2).

### 2.6 Peer links (ADR-028 store, extended)

A link gains `route: "project" | "ask-main" | "worker" | "mission"` (the existing `kind` field already means work or question; a stored link without `route` reads as `project`, and `project` links are written without it) and `missionId: string | null` (the mission whose Main answers; for a `mission` link, the target mission). `from.requestId` may be null only on a `mission` link:

| Kind | From → to | Opened by | Answered by |
|---|---|---|---|
| `ask-main` | a Worker → its own Main, about a target repo (`to.workspaceId`) | the Worker, `bm_ask_project` | the Main: `bm_link_workers` or `bm_create_worker` with `peerLink` (the link becomes taken by that request), or `bm_peer_reply` |
| `worker` | a Worker → a sibling Worker of the same Main (any repos, the same repo included) | the Main, `bm_link_workers` | the Workers, `bm_peer_reply` |
| `mission` | a Main → another mission's Main | the Main, `bm_ask_mission` | the other Main, `bm_peer_reply` |
| `project` | ADR-028 behaviour, kept for a Worker whose request has no mission | — | — |

The "a project cannot ask itself" rule applies to `project` and `ask-main` only. The chain rule applies to `project` only.

## 3. The home and the Main

### 3.1 The home

`ensureMissionsHome` creates `<data>/missions/home` (`0700`, a `README.md` saying what it is) and opens it with `paseo.workspaces.open({ cwd })`, as `orchestrator-agent.ts` does for the Orchestrator. Its workspace id is cached in `ui/missions-home.json`.

**Plugin homes are not projects.** `listedWorkspaces` stays raw (the creation hook's `workspaceOfFolder` needs the home to bind a Main created there). `isPluginHome(workspaceIdOrDirectory)` (the Missions home and the Orchestrator home) is applied **in each project-view caller**: `bm_projects` and the stored-workspace list it reads (`orchestrator-tool-context.ts`), `bm_peers`, project resolution of links, the Work, Inbox and Insights project lists, the overview counts and the event scope. A Main's own turns are traced under the home; those records are read by mission, never as a project.

### 3.2 Labels and title

- **Labels:** a Main carries `bm.role=manager`, `bm.missionId=<missionId>`, `bm.missionCode=<code>` and `bm.version`. The Orchestrator's `bm.orchestrator=main` is unrelated.
- **Title:** `"<code> <name>"`, prefixed by the role hook with `🟣 M · `; at most 200 characters, the name cut at a word end.
- **Keeping it.**
  - A rename of the mission sets the Main's title with `setAgentTitle` (`paseo-cli.ts`).
  - On a cleared conversation, `createTitleMarker` rebuilds the full title from `bm.missionId` → the mission, not only the marker.
- **Finding a Main.** `findMain(missionId)` lists live `bm-manager` agents labelled with that mission, the newest first, skipping `bm.replacedBy`.

### 3.3 Creating a mission and its Main

**From the Command Center** — "New mission" (Phase 1), and from the Missions screen (Phase 3). `missions.create { name?, code?, repos?, goal? }` behaves as follows:
- With a name and a code, it writes the mission (state `open`, `createdBy: owner`) and creates its Main.
- Without them (the Command Center path), it creates an **unassigned Main**: a Main in the home with no `bm.missionId`. Its brief asks the owner the name, code, goal and repositories, and records them with `bm_mission_start`.

**From Paseo's composer** — a `bm-manager` created by the owner:
- **In the home:** the hook binding (base design §7.17.7) binds it, and it is an unassigned Main as above.
- **In a repo workspace:** it becomes a one-repo mission (§3.6).

A charter repo must be a listed, unarchived repo workspace (not a plugin home).

**Placement (live check of 2026-10-09).** A child created with `parent` and a repo's `cwd` but no `workspaceId` is placed by Paseo **in the parent's workspace, with the parent's folder as its cwd**; with an explicit `workspaceId` it is placed in that repo with the repo's folder and keeps the `paseo.parent-agent-id` label. So a Main's Workers are always created through `paseo.workspaces.ref(<repo workspaceId>).agents.create({ config, parent: <Main>, … })`, never `paseo.agents.create({ cwd, parent })`.

**A Main's reads.** From the home, Claude in its `default` mode stops on a permission prompt to read another repo's file; Claude in `bypassPermissions` and Codex read it. The Main's `bm_repo` (§4) is therefore its supported way to read its repos.

**Creating the Main** (`createMain(missionId)`):
- It is created through `createFromProfile` (never `ensureRolesFor` from a tool call) in the home, with the labels of §3.2, a binding `{ role: "manager", workspaceId: <home>, missionId }` and the brief of §3.5. `mainHistory` gains the entry.
- An unassigned Main gets `missionId` on its binding and labels when `bm_mission_start` settles (labels through `paseo agent update --label`, values matching `^[A-Za-z0-9][A-Za-z0-9._-]*$`).
- **A cleared conversation is a replacement.** Clearing archives the agent and creates a new untitled one (`role-title.ts`), and archiving revokes the old binding. At `agent.archived` of a Main of an open mission the plugin notes the mission as **awaiting a successor** for 60 seconds; a `bm-manager` created in the home in that window, with no mission of its own, is claimed as the successor (§3.4) and titled from the mission. Whether Paseo carries labels and the MCP entry across a clear is checked live in the Phase 1 opening bead; the claim does not depend on it.

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

- **First prompt:** `BM-BRIEF manager requestId: none mission: <code>`, the mission's name, goal and charter state, the repos with their directories, the open requests (from the roster, each with its repo, Worker and newest report), the open done criteria, the newest 20 journal lines, and "Read the whole mission with bm_mission".
- **Runtime facts:** the mission level's cells and the repo levels of the repos in scope.
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

The Main's tools are bound Manager tools. Rows marked † are new.

| Tool | Input | Does | Refusals |
|---|---|---|---|
| † `bm_mission` | — | Reads the caller's mission: charter, plan, contracts, roster with each request's repo, Worker, phase and newest report, open questions of its Workers, the mission level, the newest 50 journal lines | not a Main of a mission |
| † `bm_mission_start` | `name`, `code`, `goal`, `repos` (workspace ids or folders) | An unassigned Main's first act: records a **proposed** mission (keyed by the Main and its turn's start mark); at the turn's end it settles only if the turn holds the owner's own message (as `bm_answers`). Creates the mission, labels and binds the Main | already in a mission; code taken; a repo unknown or a plugin home |
| † `bm_mission_update` | any of `name`, `code`, `goal`, `nonGoals`, `doneCriteria` (add, edit text, set status), `budget`, `plan`, `contracts` (add, new version), `repos` (add or remove), `confirmCharter`, `close` | **Free for the Main:** `plan`, `contracts`, criterion **status** with evidence, new criteria; adding a repo at mission level `scope-repo`. **On the owner's card:** everything else — `name`, `code`, `goal`, `nonGoals`, `budget`, `confirmCharter`, `close`, removing a repo, editing or dropping a criterion, adding a repo without `scope-repo` — opens an `m:` decision (§4.1) whose options are "apply" and "keep as is", the change attached as a prepared change; the plugin applies it on the owner's tap. Each applied change adds a journal line | code taken; a repo unknown, archived or a plugin home; `close` while a Worker of the mission runs |
| `bm_create_worker` | + `project` (required when the mission has more than one repo) | `project` must be in the charter's `repos`. The Worker's `cwd` is that repo's directory; its binding `{ role: "worker", workspaceId: <repo>, requestId, parentId: <Main>, missionId }`; the request is registered **in that repo** with `managerId` and `missionId`; the roster gains it; the creation project (child mode, action boundary, autonomy) is that repo's. The brief adds `mission: <code> <name>`, the request's place in the plan, the repo's memory (§7, the newest 30 active entries and every `contract` entry that names the repo), and the mission's contracts touching the repo. Without `staffing` delegated, refused when the mission already has a live Worker in that repo or `charter.budget.workers` live Workers in all | `project` outside the scope, archived or a plugin home; the `staffing` rule above; the other refusals of base design §7.15 |
| `bm_tell_worker` | as now | The request is found through the request index; the caller must be the request's `managerId` (the mission's current Main) | — |
| † `bm_link_workers` | `requestIds` (exactly 2, both of the caller's mission, live Workers), `topic` (≤ 2,000) | Opens a `worker` link, `taken` at once, from the first request's Worker to the second's; delivers to each a `peer-message` from the Main: "Your Main linked you with <other Worker> (<repo>, request <id>) about: <topic>. Talk on link <id> with bm_peer_reply." Adds a journal line | not two live requests of the caller's mission; a link between them already live (its id returned) |
| † `bm_ask_mission` | `mission` (a code), `text`, `kind?` | Opens a `mission` link to that mission's Main; delivers `BM-DELIVERY peer` with "from mission <code>"; the other Main answers with `bm_peer_reply` | unknown or closed mission; the caller's own |
| † `bm_answer_worker` | `requestId`, `answers` (1–5 `{ qn, option, why ≤ 300 }`) | Answers open `q:` decisions of its Workers within §8's rule, recorded `by: "main"`, `via: "main"` (new values of `ANSWER_BY` and `ANSWER_VIA`), delivered to the Worker as the Main's answer, never the owner's. An answer never carries a grant: an effect it allows still passes the repo's action boundary, whose grants come only from the owner | a question `ownerOnly`; not allowed by §8; a settled question (its answer named); a `h:`, `o:`, `m:`, held or override decision; an option with a `grant` or a prepared change; a free-text `other`; not a request of the caller's mission |
| † `bm_repo` (Main) | as the Orchestrator's read-only `bm_repo`, plus `read { path, from?, lines? }` for a file | Read-only git and file reads **limited to the charter's repos**, so a Main whose working folder is the home can read the PRDs and code it plans from under any provider sandbox | a repo outside the charter; a path outside the repo; a secret-shaped path (the plugin's credential guard) |
| † `bm_memory` | `project`, `op`: `read` (`query?`) / `add` (`kind`, `text`, `source`) / `remove` (`id`, `why`) | Reads or curates the repo's memory (§2.5) | `project` outside the charter's repos |
| `bm_answers`, `bm_decisions` | as now | `bm_decisions` lists the open questions of every request of the mission. `bm_answers` (the owner's answer given in the Main's chat) refuses an `ownerOnly` question: only the card, or the owner's own words in the Worker's chat, answer it | — |
| `bm_peers` | as now | Lists missions (code, name, Main, repos) instead of plugin homes, and the caller mission's links of every kind | — |
| `bm_ask_project`, `bm_peer_reply` | as now | A Main's `bm_ask_project` for a repo outside its scope is refused with "add the repo to the mission (bm_mission_update repos) or ask its mission (bm_ask_mission)". `bm_peer_reply` is unchanged | — |

### 4.1 Mission decisions (`m:`)

A mission change that needs the owner (`bm_mission_update`), a split (§9.6) and an arbitration that changes a goal are stored decisions with the id `m:<missionId>:<n>`, in `<data>/missions/<missionId>.decisions.json` (the decision schema reused; the per-workspace store is untouched). Their options carry a prepared change of the new kinds `mission-change` (built, `shared/mission-change.ts`, kept out of `PREPARED_CHANGE_KINDS` so the Orchestrator's `bm_ask_owner` cannot offer it), `mission-split` and `arbitration` (Phase 2), applied by the plugin on the owner's tap and never by any agent. They appear in the Inbox with the mission's code; `bm_decisions` lists them for the Main. No policy, Main or Orchestrator answers an `m:` decision.

## 5. The Worker's side

- **Asking another repo** (`bm_ask_project`) from a Worker whose request has a `missionId` opens an `ask-main` link to **its own Main** and delivers `BM-DELIVERY peer` to it:
  - `kind: ask-main`, the target repo, the ask quoted;
  - "Your Worker <id> (<repo>, request <id>) needs work or a fact in <target>. Link it with the Worker already on that work (bm_link_workers), or give it a Worker there (bm_create_worker project: <target>, peerLink: <link>), or answer it with bm_peer_reply."
  
  A target outside the charter needs `scope-repo` (the Main may then add it) or the owner. The asker's `waitingOnPeers`, the reply delivery, `forPeer` and the ceiling work as in base design §7.17.
- **`bm_create_worker` with an `ask-main` `peerLink`** takes the link for the new request (`to.requestId`, `to.workerId`). **`bm_link_workers` with a live `ask-main` link** of one of the two requests turns it into a `worker` link taken by the other request.
- **Talking on a link:** `bm_peer_reply` as now. The answerer of a `worker` or `ask-main` link is the live Worker of `to.requestId`.
- **Questions:** `bm_questions` gains `ownerOnly?: boolean` per question — a fact only the owner knows (a login, an account or user id, a port of the owner's machine, a personal choice). It is stored on the decision (`ownerOnly: true`, an additive field). The policy, `bm_answer_worker`, a Main's `bm_answers` proposal, a Main-written `BM-ANSWERS` and every Orchestrator path (`bm_decide`, `bm_predict`) refuse such a question; only the owner's card, or the owner's own words in the Worker's chat, answer it. **The guard:** the open path also marks a question `ownerOnly` when an option asserts something about the owner, in English or Vietnamese ("I have", "I've", "the owner has", "I am logged in", "tôi đã", "tôi có", "tôi đang", "đã điền", "đã đăng nhập", "của tôi"), logged when it fires.
- **Memory:** `bm_memory` `read` and `add` (kind `fact`, `convention` or `contract`) for the Worker's own repo.
- Reports, reviews, questions and handoffs are unchanged; their records live in the Worker's repo.

## 6. Main-side lookups that change

Each row is a place that found "the Manager of a workspace" and now goes through the request index or the mission.

| Where (today) | Change |
|---|---|
| `deliver-tools.ts` `managersRequest`, `bm_tell_worker`, `bm_answers` | Read the registry of `requestIndexOf(requestId).workspaceId`; the ownership rule `managerId === caller` stays |
| `decision-materialiser.ts` on a Main's turn (`context.workspaceId`), `workerOfRequest`, `proposed-answers.ts` | Each block's repo from the request index; proposed answers keyed by Main **and** workspace |
| `collector.ts` (a turn's outbox records under the agent's own workspace) | A Main's records are read from the outboxes of the workspaces its turn wrote to (the request index of each record's `requestId`) |
| `traces.ts` `managerAgentId` (from Manager records in the same trace file) | From the registry's `managerId` |
| `stall-watcher.ts` (skips traces without `managerAgentId`) | As above, so requests of a cross-repo Main are watched |
| `event-bus.ts` finish dedupe key (includes the record's workspace) | The **request's** workspace (the registry's), not the turn record's, so a Main's copy in the home and the Worker's in the repo collapse |
| `command-send.ts` `copyRecipientOf`, `orchestrator-tool-context.ts` `requireManager` | The Worker's parent from its binding; a Main target by `missionId` |
| `fallback-manager.ts` (tells the old Manager's workspace's Workers) | §3.4 |
| `handoff.ts` / `orchestrator-coordination-tools.ts` (the parent Manager in the same workspace) | The parent Main from the binding |
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
| `orchestrator-tool-context.ts` `requireManager`, `orchestrator-state.ts` `projectManagerOf`, `command-send.ts` `copyRecipientOf` (Phase 1, so the Orchestrator keeps working before Phase 2) | A repo's Mains are those of the missions whose roster has requests there; a command to "the Manager of a request" goes to its mission's current Main |

## 7. Project memory in briefs

- **Into a Worker's brief:** `bm_create_worker` adds `Project memory (<repo>):` — the newest 30 active entries plus every `contract` entry — each one line with its source. The handoff successor's brief carries the same.
- **For the Main:** it reads the full memory with `bm_memory`.

## 8. Autonomy: the two layers (REQ-189)

**The repo level** (ADR-025's per-project cells) is the level of the work in that repo; **the mission level** (§2.4) is what the Main may do on its own. A Worker's question of a request of a mission is settled this way:

1. **`ownerOnly`:** the owner's card, or the owner's words in the Worker's chat. Nothing else.
2. **Repo cell `delegate`** for the question's class: the request's **Main** decides it with `bm_answer_worker` — the Main holds the goal's context, which is why the decision moves from the Orchestrator to it. The answer counts as the policy's for calibration (the ledger records `by: main`, read as delegated). A Main that has not answered within 10 minutes leaves it to the owner's card, which stays open throughout.
3. **Repo cell `owner`** (or `shadow`): the Main decides it only when the mission cell of its group delegates — `answer-technical` for `scope`, `preference`, `reversible-technical`; `answer-effects` for the effect classes. Otherwise it is the owner's; the Main may add its recommendation in its reply to the owner, never answer it. A `shadow` cell records the Main's recommendation as a prediction (`PREDICTORS` gains `main`), as the Orchestrator's were.
4. **Effects:** what an answer lets a Worker do still passes the repo's action boundary; grants come only from the owner. So the effective authority over an effect is the lower of the two layers (ADR-029 decision 6).
5. **The Main is told** of its Workers' questions by the Worker's `blocked` report (it lists the open `Qn`) and reads them with `bm_decisions`; no new delivery kind.

Requests without a mission keep today's rule (the Orchestrator under the repo policy) until Phase 2 retires it.

**The Main's own decisions:** `proceed` (take the next planned step without the owner's word), `staffing` (create Workers; more than one live per repo), `scope-repo` (add a repo), `split` (the governor may split this mission, §9.6). Above its level the Main asks the owner in its chat, or through an `m:` card for mission changes (§4.1).

## 9. The governor (Phase 2)

### 9.1 What stays and what goes

| | Change |
|---|---|
| `bm_decide`, `bm_predict` on `q:` decisions | **Retired** from the Orchestrator (the Main decides, §8); `o:` decisions are the owner's |
| `bm_direct_worker` | **Narrowed** to `intent: stop` with `interrupt`, while a danger or a governor `stop` step is open |
| `bm_send_command` | **Replaced** by `bm_govern` to a Main (§9.4) |
| `bm_ask_owner` | Kept; prepared commands go to a Main only |
| `bm_compact`, `bm_handoff` | **Retired** from the model; code runs them (§9.5) |
| `bm_projects`, `bm_request`, `bm_agent_messages`, `bm_repo`, `bm_why`, `bm_decisions`, `bm_note`, `bm_reply` | Kept; `bm_note` keyed by mission |
| † `bm_missions` | Reads missions with charter, roster, figures and ladder state (§9.2, §9.3) |
| † `bm_govern`, `bm_arbitrate`, `bm_create_main` | §9.4, §9.6 |
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
| | review budget exhausted | 2 requests |
| | open owner approvals (documents in Review or Draft, open `q:`/`o:` cards) | > 8 |
| **drift** | the Main's turns since a done criterion last changed state | > 40 turns |
| | finished requests since a done criterion last changed state | > 6 |
| | requests or links in repos outside the charter | 1 |
| **stuck** | stalls, unanswered links (`peer-unanswered`), cards older than 24 h | each |
| **budget** | requests, Workers, review calls or days against `charter.budget` | ≥ 100% |

### 9.3 The ladder (`orchestrator/governor.json`)

`missions: { <missionId>: { <family>: { step: 0..4, since, figures, lastAction: { at, kind, id } | null } } }`

| Step | Who acts | What happens |
|---|---|---|
| 1 record | code | When a figure crosses its threshold: a journal line |
| 2 nudge | code, no model | A `BM-COMMAND` to the Main (`from: orchestrator`, `authority: governor:nudge`, `effects: none`, through `command-send.ts`): the family, the figures with their thresholds, the charter line they concern, and "Re-plan or explain in one line in your next reply; the governor checks again in <window>." No new delivery kind |
| 3 re-plan | the model, woken | The figure still holds after the window (default 30 minutes and 5 more Main turns). The governor reads the mission and sends `bm_govern { step: "replan" }` |
| 4 escalate or stop | the model | It escalates with `bm_ask_owner`, or stops a Worker (`bm_direct_worker` stop) on real risk |

- A figure back under its threshold resets the family to 0, with a journal line.
- The intervention log (A-12) records each step 2–4 with its outcome check.

### 9.4 Commands to a Main

`bm_govern { missionId, step: "nudge" | "replan" | "arbitrate", text ≤ 4,000, figures? }` builds a `BM-COMMAND` with `from: orchestrator`, `authority: governor:<step>`, `effects: none` and `to:` the mission's current Main, and sends it through `command-send.ts`.
- The authority is structural, like `coordination:handoff`.
- The loop guard counts per mission: 12 per 24 h.
- A command addressed by mission is delivered to whichever Main holds the mission when it is sent.

### 9.5 Compaction and handoff in code

The safe-point runners of `compaction.ts` and `handoff.ts` run by themselves when the Coordination thresholds are crossed, for Workers (successor under the same Main) and for Mains (§3.4). They tell the Main in one notice. The Orchestrator is not woken.

### 9.6 Arbitration and splits

- **Conflicts** are detected in code as `mission.conflict { missions, workspaceId, area, evidence }`. Their sources are:
  - two open charters with the same repo and overlapping file areas written in the last 7 days;
  - a writer collision between Workers of two missions;
  - a `project` or `mission` link from one mission into another's area.

  They wake the governor, which reads both missions and answers with `bm_arbitrate { missions, area, owner: missionId, reason }`. That writes `orchestrator/arbitrations.json`, adds a journal line to both missions and sends a `governor:arbitrate` command to both Mains. A call that changes a goal is an `m:` decision of the losing mission (§4.1), the `arbitration` prepared change applied on the owner's tap.
- **Splits:** `bm_create_main { fromMissionId, name, code, goal, repos, requestIds?, reason }`.
  - **Authority:** an `m:` decision of the source mission the owner answered with the `mission-split` prepared change (the plugin then creates the Main itself), or the source mission's `split` cell (the governor's own `bm_create_main`).
  - **What it does:** writes the new mission (`createdBy: orchestrator`, `parentMissionId`), moves the named requests' roster entries and registry `managerId` (§3.4 steps 3–5 for those requests only), creates the Main, and tells both Mains.
  - **Refused:** either Main running; an area overlapping another open mission; more than 2 splits of one mission per 24 h; a missing authority.

### 9.7 Wakes

| Event | Wakes the governor when |
|---|---|
| `mission.signal` | a family reaches step 3 |
| `mission.conflict` | always |
| `mission.scope` | a request or link targets a repo outside the charter and the Main cannot add it (`scope-repo` not delegated), and the Main has not asked the owner within the window |
| `mission.review` | every 10 finished requests of a mission, or at 50% and 100% of a budget |
| `worker.signal danger` | always |

Events are batched in `BM-EVENTS`, at most one wake per mission per 15 minutes except `danger`. A wake that ends with no action is recorded per event type (M-26).

## 10. The Missions screen (Phase 3)

Built only after the owner approves a mockup ([ui-must-match-mockup]). The content to mock:
- **The list:** each mission with name, code, Main state, repositories, done criteria progress, live Workers, open questions and governor signals.
- **A mission's page:** the charter, the plan, the contracts, the roster by repo, its links and the journal.
- **Actions:** create, rename, close and the mission level.
- **Project memory:** a read-only view per repo.

## 11. Role files

- **`manager.md` becomes the Main's file.** Its five limits stay: it changes nothing; the owner decides the work; never say more than you can see; agents belong to the owner; secrets. The steps cover:
  - keep the mission (charter, plan, criteria, contracts) with `bm_mission` and `bm_mission_update`, and answer "what is left" from it;
  - give work to Workers in the right repo (`bm_create_worker project`), re-using the Worker already on an area, and splitting into several when the work parallelises;
  - link Workers that must agree (`bm_link_workers`) and record the agreed contract;
  - route a Worker's `ask-main`;
  - answer Workers' questions within the mission level (`bm_answer_worker`), never an `ownerOnly` one;
  - go on to the next planned step when `proceed` is delegated;
  - talk to another mission only through `bm_ask_mission`;
  - treat a governor notice as process feedback, re-planning or explaining in one line.
  - The target is 100 lines.
- **`worker.md`:** asking another repo goes to its Main (`bm_ask_project` is unchanged for the Worker); `ownerOnly` on questions; `bm_memory` for facts it learns.
- **`orchestrator.md` is rewritten as the governor's file** (Phase 2): read the figures and the charter; act on the ladder; arbitrate; split; never brief, correct or answer a Worker; never decide a business question.

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
- Every list-pinning test is updated: delivery kinds, `ANSWER_BY`, `ANSWER_VIA`, `PREDICTORS`, prepared-change kinds, tool lists, alert kinds, `INTERVENTION_TRIGGERS`, `CLEANUP_DELETES`.
- **Acceptance (Phase 1)** on an isolated daemon: two scratch repos, one mission `AIX` created from the Command Center. The owner gives one goal needing a backend API. Measured:
  - M-22, M-23, M-24, M-25;
  - M-27 through a replacement drill (`mission.ensure replace: owner` while a Worker waits on a link).
- **Acceptance (Phase 2):** a scripted sprawl and drift (thresholds lowered for the run), a two-mission conflict and a split. Measured: M-26.

## 13. Compatibility

- **New stores** (`missions/`, `memory/`) are ignored by an older build.
- **New fields** on existing records — the registry's and the binding's `missionId`, the link's `kind` and `missionId`, the decision's `ownerOnly`, the answer values `main` — are **dropped** by an older build at its next write of that record (its schemas strip unknown keys). The roster and the mission files are the source of truth (§2.3); a decision whose `ownerOnly` was dropped is guarded again by the open-path guard only when re-opened. Moving back to an older build is supported for running work, not for missions' guarantees.
- **The request id format** is unchanged; uniqueness is machine-wide from this build on. The finish dedupe key stays `<workspaceId>:<requestId>` (historical ids may repeat across workspaces).
- **A Worker whose request has no mission** keeps the ADR-028 behaviour.
- **Agents on older instructions** are flagged outdated, as for every role-file change; the role-file change of Phase 1 is installed with the legacy migration, so every live Manager is flagged once.

## 15. Phases

| Phase | Contents |
|---|---|
| Phase 0 | ADR-030 (the bundle minifies identifiers, keeps names) |
| Phase 1 MVP | §2–§8 and §11's Main and Worker files; the §6 rows, including the Orchestrator's targeting so it keeps working; a live check of placement, clear-conversation labels and a Main's reads; acceptance of §12 |
| Phase 2 MVP | §9 and §11's governor file; retiring the Orchestrator's question decisions for every request |
| Phase 3 MVP | §10 after the mockup is approved |

## 16. As built — Phase 1 (2026-10-09)

Built by beads `bm-missions-9qc3.1`–`.17` and `.27`; acceptance: [operations record](../operations/paseo-bm-missions-acceptance-20261009.md). Where this section and an earlier one differ, this one describes the code.

- **§2 stores.**
  - `mission-store.ts` (`createMissionStore`: `get`, `list`, `byCode`, `create`, `update`, `setMain`, `appendJournal`, `journal`; `boundedMission` bounds every field, among them contract title 200, source 300 and `splitReason` 500).
  - `mission-decisions.ts` (`m:<missionId>:<n>`, n 1–999,999, `{ version: 1, entries }`; `m:` ids are accepted only there, asked by role `plugin` with the Main's id).
  - `mission-roster.ts` (`requestIndexOf` cached by file stats; `missionManagerOf` = the registry `managerId` in the indexed repo), `mission-autonomy-store.ts` (default level 2) and `memory-store.ts` (`mem-<10 hex>`; past 300 an agent's add is refused with `MEMORY_FULL_REASON`, a plugin add replaces the oldest automatic `decision` entry).
  - Request ids: `generate` treats an id as taken in any registry or the index. Error codes are `E_TRACE_STORE_UNWRITABLE` (the `m:` store's too-new: `E_DECISION_WRITE_FAILED`).
- **§3 the home and the Main.**
  - `missions-home.ts`: `ensureMissionsHome` (cache `ui/missions-home.json`), `isMissionsHome`; `plugin-homes.ts` `isPluginHome` / `isPluginHomeIn` (the Orchestrator home is recognised by its folder and the trace store's last known folder) applied in every project view and the event scope.
  - Titles: `mainTitleOf` (≤ 200), `UNASSIGNED_MAIN_TITLE` "🟣 M · New mission"; a replaced Main is retitled "… · replaced" and never re-synced.
  - RPCs: `missions.create { name?, code?, repos?, goal? }`, `mission.ensure { missionId, replace? }` (errors `E_MISSION_INVALID`, `E_MISSION_WRITE_FAILED`). The Command Center item `new-beads-mission` opens the surface with a notice, since a Command Center context cannot open an agent.
  - The brief's first line is `BM-BRIEF manager requestId: none mission: <code>`; Runtime facts open with `Mission:`, `Mission level:` and `Repo levels:` lines; a request's newest report is chosen by time, ties broken by phase rank.
- **§3.4 replacement.** `mission-replace.ts` `replaceMain(missionId, newMainId, reason, deps)` is the one path for `mission.ensure` replace, a cleared conversation (`SUCCESSOR_WINDOW_MS` 60 s) and the fallback switch.
  - A Main never replaces itself.
  - `outbox.ts` `mainTargetOf` re-resolves records addressed to any Main of the mission at each attempt; while an open mission has no Main the record stays `pending`.
  - `notice-queue.ts` `retarget`; `request-registry.ts` `reassignManager`; `agent-bindings.ts` `reparent`; `handoff-store.ts` `missionId`.
  - Prepared commands resolve through `commandManagerIdOf` (by the request's mission, else the mission whose `mainHistory` holds the id).
- **§3.6 legacy.** `mission-legacy.ts`:
  - `migrateWorkspace` (idempotent; the code is `legacyCodeOf`: the folder's first 4 letters or digits in upper case, made unique with a digit);
  - `createLegacyMigration` at the first Paseo handle;
  - `handleManagerEnsure`, behind `manager.ensure`;
  - `adoptComposerManager` at `agent.created`.
  
  Extra Managers raise `outdated-agent` with `EXTRA_MANAGER_DETAIL` and the mission's id; the Inbox offers "Replace Main" / "Open Main" through `mission.ensure` (alerts carry an optional `missionId`).
- **§4 tools.**
  - The bound Manager's list is `bm_create_worker`, `bm_tell_worker`, `bm_answers`, `bm_peers`, `bm_ask_project`, `bm_peer_reply`, `bm_mission`, `bm_mission_start`, `bm_mission_update`, `bm_answer_worker`, `bm_memory`, `bm_repo`, `bm_link_workers`, `bm_ask_mission`, `bm_decisions`; the Worker gains `bm_memory`.
  - `bm_create_worker` gains `project` and `planStep` (≤ 300); Workers of a Main are created through `workspaces.ref(<repo>).agents.create`, with the staffing rule (one live Worker per repo, at most `budget.workers`) unless `staffing` is delegated. The brief adds `mission:`, `plan:`, `Mission contracts touching <repo>:` and `Project memory (<repo>):` (`BRIEF_MEMORY_ENTRIES` 30 plus every contract).
  - `bm_mission_start` is settled at the turn's end (`proposed-mission-starts.ts`). `bm_mission_update` turns each sensitive change into one `m:` card (options `apply` / `keep`); applying or keeping it is told to the current Main by an outbox `message` whose `requestId` is the `m:` id.
  - `bm_answer_worker` (`MAIN_ANSWER_MINUTES` 10, all-or-nothing) records `by: main`, `via: main`, or `prediction.main` in a `shadow` cell.
  - `bm_memory` / `bm_repo`: `memory-tools.ts`, `repo-tool.ts` `repoIn` (actions status, diff-stat, log, show, read; `REPO_READ_LINES` 400, at most 2,000). Automatic memory entries come from `decision-store.ts` `rememberOwnerAnswer` for owner answers.
- **§5 / §2.6 links.**
  - `peer-tools.ts` `askMainText`, `bm_link_workers` (turns the newest open `ask-main` into a `worker` link, else creates a taken one; intros are `peer-message`s in each Worker's repo outbox), `bm_ask_mission` (`missionAskText`).
  - A Main's `bm_ask_project` for a repo of its own mission is refused with "give the work a Worker there (bm_create_worker project: …) or link the Workers on it (bm_link_workers)".
  - Cards: "From mission <CODE> <name>", "Your Main linked you with another Worker".
- **§6 lookups.**
  - The materialiser's `inRepoOf`; proposed answers carry their repo; `bm_answers` reads the repo's decisions; `bm_tell_worker` stores in the repo outbox.
  - Traces, request trace, stall watcher (skips plugin homes), event-bus `finishPlaceOf`, review budget, compaction `missionRequestLines`, collector `mainReposOf`, and the parent readers through the registry.
  - `listWorkspaceAgents` shows the Main as a Worker's parent; Orchestrator targeting through `repoMainsOf`, `belongsToProject`, `commandManagerIdOf`, `copyRecipientOf` (with `home`); `bm_projects` lists a repo's Mains.
- **§8 autonomy.**
  - `shared/autonomy.ts` `MISSION_CLASSES`, `mainAnswerRuleOf`, `missionQuestionRefusalOf`; `bm_decide` and `bm_predict` refuse mission requests; the event bus no longer opens `decision.opened` for them.
  - RPCs `autonomy.set-mission-level`, `autonomy.set-mission-cell`; `autonomy.policy` carries `missions`.
  - `ownerOnly` stored, guarded by `ownerFactOf` / `OWNER_FACT_PHRASES` (EN, VI, NFC, curly apostrophes), refused on every non-owner path.
- **ADR-030.** The entries are built with `minifyIdentifiers` and `keepNames`: 1,596,602 of 2,000,000 bytes at the end of Phase 1.
- **Tests and safety.**
  - `test/setup/no-real-installers.ts` points `PASEO_HOME` at a worker's temporary folder and drops the agent's `PASEO_*` variables, so no test reaches a real daemon. Before this, a suite run inside a Paseo agent could reach the owner's daemon through the `paseo` CLI with fake agent ids.
  - Not yet built: Main answers in the Inbox "Decided for you" digest.

## 17. As built — Phase 2 (2026-10-09)

Built by beads `bm-missions-9qc3.18`–`.24` and `.28`; acceptance: [operations record](../operations/paseo-bm-missions-governor-acceptance-20261009.md). Where this section and §9 differ, this one describes the code.

- **§9.2 figures.** `governor-figures.ts` `governorFiguresOf(snapshot, bounds)` returns `GOVERNOR_FIGURES` entries `{ family, id, value, threshold, op, crossed, detail }` (detail ≤ 200), read from the stores by `readGovernorSnapshot`; recent means the last 24 hours (`GOVERNOR_RECENT_MS`).
  - mess: `writersOnOneFile`, `workersInOneRepo`, `reAsks`, `dropped`;
  - overengineering: `processDocsPerCriterion`, `beadsPerFinishedRequest`, `tierRaised`, `reviewBudgetExhausted`, `openApprovals` (open `q:`, `o:` and `m:` cards; a document in Review is not counted);
  - drift: `mainTurnsSinceCriterion`, `finishedSinceCriterion`, `outsideCharter`;
  - stuck: `stalled`, `unansweredLinks`, `oldCards`;
  - budget: requests, Workers, review calls and days, as a percentage of the charter's budget.
  
  `mainTurnsSinceCriterion` counts no turns while every done criterion is met or dropped and no request is open: the Main only answers the owner. `workersInOneRepo` counts the live Workers whose request is still open on the roster: a finished Worker left idle for its Main to reuse is no sprawl. Written files are `file` evidence and the files a shell command writes (an output redirection or `tee`, `shellWrittenPathsOf` in `shared/writers-observed.ts`), which the conflicts and the writers alert read too. Both came from the acceptance run.

  The thresholds are `GOVERNOR_BOUNDS` in `shared/coordination.ts`, set as `governor.<name>` through `coordination.set`. Defaults: writersPerFile 2, workersPerRepo 3, reAsks 2, dropped 1, processDocsPerCriterion 3, beadsPerRequest 15, tierRaised 2, reviewExhausted 2, openApprovals 8, mainTurnsSinceCriterion 40, finishedSinceCriterion 6, outsideCharter 1, cardAgeHours 24, budgetPercent 100, windowMinutes 30, windowTurns 5. `dropped` counts nothing yet.
- **§9.3 the ladder.** `governor-store.ts` keeps `orchestrator/governor.json`, one ladder per mission and family; `ladderStepOf` moves a crossed family 0 → 1 (a `governor` journal line), 1 → 2 (a nudge at the next recomputation), and 2 → 3 (`replan-due`) once both `windowMinutes` and `windowTurns` have passed; a family back under its threshold resets to 0. Steps 1 and 2 run in code: `nudgeCommandOf` is a `BM-COMMAND` with authority `governor:nudge`, no effect, sent to the current Main through `sendCommand` (backstop off, loop guard on); a failed nudge is retried after 10 minutes (`NUDGE_RETRY_MS`). `createGovernor` recomputes at the stall watcher's pass and at each recorded turn.
  - Every step 2–4 writes an intervention entry: kind `govern` with its `step`, trigger `governor`, expected outcome `figures-clear` (every family the step concerns back at step 0 within 30 minutes). A stop that only the stop step allowed is `kind: stop`, `trigger: governor`. An escalation through `bm_ask_owner` is not a `govern` entry.
- **§9.4 commands.** `bm_govern { missionId, step: nudge | replan | arbitrate, text ≤ 4000, figures? ≤ 20 }` (`command-authority.ts`): `from: orchestrator`, `to: manager`, `requestId` null, `re: Governor: <step>, mission <code>`, no effect, authority `governor:<step>`, then a `Figures:` block of the named figures read now. It goes only to the current Main of an open mission (`governorTargetRefusalOf`); the loop guard counts per mission (12 in 24 hours, `MISSION_COMMAND_LIMIT_MESSAGE`). The backstop reads the Orchestrator's own words only (`CommandSend.backstopText`): a mission the owner named "Billing" does not read as cost. A replan at step 3 moves the families to `GOVERNOR_STOP_STEP` 4.
- **§9.1 tools.** The Orchestrator's list, in order: `bm_projects`, `bm_missions`, `bm_request`, `bm_agent_messages`, `bm_govern`, `bm_arbitrate`, `bm_create_main`, `bm_decisions`, `bm_ask_owner`, `bm_decide`, `bm_predict`, `bm_direct_worker`, `bm_repo`, `bm_note`, `bm_findings`, `bm_why`, `bm_reply` (17). `bm_send_command`, `bm_compact` and `bm_handoff` are gone (`orchestrator-coordination-tools.ts` deleted).
  - `bm_missions { missionId?, closed? }`: each mission's charter, roster, figures (`crossed`, `under`), ladder, open `m:` cards and notes.
  - `bm_direct_worker` only stops (`intent: stop`, `interrupt: true`, no effect), while a danger signal of the Worker is open or a family of its mission is at the stop step; its Main gets a copy.
  - `bm_decide` and `bm_predict` answer only `f:` fallback incidents; a `q:` question is the Main's or the owner's.
  - `bm_ask_owner` prepares a command to a Main only; its effects are information.
  - `bm_note { workspaceId | missionId, text, replace? }`, exactly one id; mission notes in `orchestrator/notes/missions/<missionId>.json`.
- **ADR-031.** An answer to an `o:` decision grants nothing (`answerDecision`, `shared/decisions.ts`): `BM-ANSWER` names no grant and a prepared command goes with `approved: none`.
- **§9.7 events and wakes.** The event bus publishes:
  - `mission.signal { missionId, family, figures, step: 3 }`, settled when the governor resets the family;
  - `mission.conflict { missions, workspaceId, area, evidence }`, settled when a mission closes;
  - `mission.scope { missionId, workspaceId, requestId | null, linkId | null }`, for work outside the charter while `scope-repo` is not delegated and no `m:` card asks it, after `windowMinutes`;
  - `mission.review { missionId, reason: finished-10 | budget-50 | budget-100 }`;
  - and keeps `worker.signal danger`.
  
  `decision.opened`, `request.finished`, `advice.due` and `threshold.crossed` no longer wake (their data, advice and alerts stay). A mission's events are debounced 15 minutes (`MISSION_WAKE_MS`); the held events and marks are kept in memory, so a reload starts from a fresh baseline. `wakes.json` records each wake's event types and whether a tool acted (`acted`).
- **§9.6 conflicts and splits.** `governor-conflicts.ts` `createConflictWatch` finds three kinds:
  - two charters writing one area (a folder, `areaOfFile`) of a shared repo within 7 days (at most 3 areas per pair);
  - writers of two open missions on one file;
  - a link into another mission's repo.
  
  An area an arbitration already settled is skipped. `orchestrator/arbitrations.json` keeps at most 500 entries `{ id arb-<10 hex>, at, missions, workspaceId, area, owner, reason, commandIds, decisionId }`.
  - `bm_arbitrate { missions[2], workspaceId, area, owner, reason ≤ 500, goal? ≤ 4000 }` records the entry, writes both journals and tells both Mains with `governor:arbitrate` commands. A `goal` becomes an `m:` card on the other mission (the `arbitration` prepared change); its goal stands until the owner applies it.
  - `bm_create_main { fromMissionId, name ≤ 80, code, goal ≤ 4000, repos 1–20, requestIds? ≤ 50, reason ≤ 500 }`:
    - when the source mission's `split` cell is delegated, it runs `executeSplit`: a new mission (`createdBy: orchestrator`, `parentMissionId`, `splitReason`), `roster.move`, both journals, its Main (rolled back on failure), the requests reassigned (registry, bindings, labels) and both Mains told;
    - otherwise it opens the owner's `m:` card (the `mission-split` prepared change), one per code.
    
    It refuses an unknown or closed source, a taken or invalid code, a repo outside the charter, a request not on the roster, a running source Main, more than 2 splits a day (`MAX_SPLITS_PER_DAY`), and an area another mission holds or an arbitration gave away. The owner's tap goes through `decisions.answer` → `governorAnswerRefusalsOf` → `applyGovernorDecision`.
- **A Main suggests a split** (`bm_split_mission`, `mission-split.ts`). When the owner's new work is another goal, the Main asks the owner. On the owner's yes it calls `bm_split_mission { name, code, goal, repos, requestIds?, reason }` with the bounds of `bm_create_main`; the same refusals apply, except that its own Main may be running, plus a second open suggestion of one code.
  - It writes a `split-suggested` journal line with the details (`split`), and publishes `mission.split { missionId, code, name, goal, repos, requestIds, reason, at }`. Its key is `mission.split:<missionId>:<code>`; it is dropped once a mission takes the code or the source closes, and it follows the 15-minute mission window.
  - `bm_missions` lists each mission's open `splitSuggestions`.
  - The governor decides: `bm_create_main` with the suggestion's fields (run on the `split` cell, else the owner's card), or `bm_govern` to the Main with why.
  - The open suggestions are read from the journal (`openSplitSuggestionsOf`), an exception to §2.2's "the journal is never a source of state". A suggestion the governor declines stays open until a mission takes the code or the source closes.
- **§9.5 compaction and handoff in code.** The compaction and handoff runners act at a recorded turn that crosses the owner's threshold (`contextCrossingOf`), within the Coordination settings, without waking the Orchestrator:
  - a Worker gets `/compact` and the `BM-STATE` brief; its handoff creates the successor in its repo under its Main and on the roster;
  - a Main that crosses with no compaction possible is handed over once per run (`handOverMain` → `createMain` reason `handoff` → `replaceMain`).
- **§11 the governor's file.** `plugin/roles/orchestrator.md` is the governor's file (100 lines, 3 limits): it governs the process and the Mains run the work; it reads `bm_missions` before acting; the plugin runs steps 1–2, the governor re-plans on `mission.signal`, escalates with `bm_ask_owner` when the drift persists at step 4, arbitrates on `mission.conflict`, splits with `bm_create_main`, and stops a Worker only on danger or the stop step. It never briefs, corrects or answers a Worker, decides only `f:` incidents, and keeps one `bm_note` per decision by mission or project. Rule 2 says its commands carry no effect and no answer grants one.

## 14. Revision History

| Date | Author | Change |
|---|---|---|
| 2026-10-09 | Claude (owner decisions of 2026-10-09; technical choices under the owner's delegation) | Created |
| 2026-10-09 | Claude (owner's delegation) | Independent review against the code (19 findings) applied: §8 rewritten (the Main decides repo-delegated questions; mission cells a further reach), §3.4 resolve-at-delivery and the store list, §3.3 a cleared conversation is a replacement, §3.6 legacy cases, §4.1 `m:` decisions with prepared changes, `ownerOnly` stored and guarded in English and Vietnamese, the Main's `bm_repo`, §6 rows added (Orchestrator targeting in Phase 1), §13 compatibility corrected, §15 phases with ADR-030 first. `design-ready`: PASS |
| 2026-10-09 | Claude (owner's delegation) | Phase 1 built (beads bm-missions-9qc3.1–.17, .27) and accepted on an isolated daemon (M-22 0, M-23 1, M-24 0, M-25 0, M-27 0): §16 as built; §2.6 `route`, §4.1 `mission-change` location corrected inline |
| 2026-10-09 | Claude (owner's delegation) | Phase 2 built (beads bm-missions-9qc3.18–.24, .28) and accepted on an isolated daemon (M-26: 0 of 4 wakes without action): §17 as built; ADR-031 (an `o:` answer grants nothing); the backstop reads the Orchestrator's own words; from the run: shell writes count as written, sprawl counts Workers at work, drift pauses when every criterion is settled, a Main suggests a split with `bm_split_mission` |
