# ADR-028 — Projects ask each other through the plugin: peer links

| Field | Value |
|---|---|
| Status | **Accepted** (2026-10-09) — approved by Claude under the owner's delegation, on the owner's request of 2026-10-09 ("soạn prd, design và sau đó hoàn thiện tất cả công việc theo đề xuất") |
| Date | 2026-10-09 |
| Owner | hieu.nt10 |
| Amends | [ADR-011](ADR-011-manager-coordinates-workers.md) (the Manager coordinates Workers of **its** workspace: it now also takes requests from another project's agents, and asks other projects for its own requests); [ADR-024](ADR-024-structure-tells-stops-and-waits.md) decision 3 ("a Worker that waits on another agent … therefore stalls": a wait on a peer link is now a structural wait); [ADR-027](ADR-027-agents-write-content-code-carries-it.md) decision 1 extended to traffic between projects |
| Related | **PRD: [base PRD](../product/paseo-bm-prd.md) REQ-175 → REQ-183, M-19 → M-21** · **Design: [base design](../design/paseo-bm.md) §7.17** (with §7.5, §7.7, §7.8, §7.15, §7.16) · [Orchestrator design](../design/paseo-bm-orchestrator.md) §3 · [ADR-020](ADR-020-paseo-tools-policy-per-role.md) · [ADR-025](ADR-025-autonomy-levels.md) · `plugin/server/peer-links.ts`, `plugin/server/peer-tools.ts`, `plugin/shared/bm-tools.ts`, `plugin/roles/*.md` |
| Lane | Designed: a new stored format (`peers/links.json`), new agent tools and a new delivery kind, role behaviour across workspaces |

## Routing Decision

This ADR is the feature's first artifact and owns its routing decision.

- Variant preset: brownfield
- Triggered risks:
  - a contract others consume: new `bm_*` tools, a new `BM-DELIVERY` kind, a
    new store in the data folder;
  - agent behaviour: what the Manager, Worker and Orchestrator role files tell
    agents to do with another project;
  - safety: work in one workspace can now start a request in another one.
- Required artifacts and gates: this ADR; the base PRD's new rows (`prd-ready`);
  base design §7.17 and the touched sections (`design-ready`); a plan with beads,
  because the work has ordered outcomes (store → tools → wait/wake → prompts →
  views) and is built by parallel agents (`plan-ready-for-beads`);
  `feature-done` at the end.
- Execution path: plan → converter → implement. Releasing stays out of the plan
  (the owner tests, then picks the version).
- Exceptions: none.
- Decided: 2026-10-09 — Claude under the owner's delegation.
- Supersedes: none.

## Context

A field trace of 2026-10-07 → 2026-10-09 covers two projects of one owner: a
frontend (`xspace-ai-assistant`) whose UI needs APIs from a backend
(`ai-assistant`). Each project had its own Beads Manager.

- **The owner carried the work between projects.** Of 36 messages the owner
  typed to the two Managers, at least 6 only moved information or permission
  from one project to the other ("gửi các nhu cầu từ N1-N4 sang backend",
  "Nếu cần nhắn frontend điều gì hãy chủ động tương tác…"). The Orchestrator
  sent four more "coordinate with the other project" commands.
- **Answers came back hours late, or not at all.** The backend's answers
  reached the frontend 3 h 20 min (N5), about 6 h (D7, M5) and 13 h 45 min
  (N1–N4) after they were ready. A frontend Worker sat idle by design ("Kết quả
  sẽ quay về qua Orchestrator") while the backend Manager held the answers:
  "Tôi chưa gửi thẳng … chỉ thị thường trực của Orchestrator là chuyển qua
  Orchestrator". The frontend Manager wrote "Gửi Orchestrator: …" 14 times into
  its chat with the owner, where nobody reads it.
- **Contracts drifted silently.** Backend code set reminders `DONE` while its
  document said `OPEN`; `excel_list_sheets` missed fields the UI needed; a
  backend document chose an architecture option the frontend owner had not
  chosen. Only the frontend found these, by reading the backend repository.

The mechanism explains it (review of 2026-10-09):

- every store, tool and prompt is per workspace: the request registry, the
  outbox, the decisions, `bm_tell_worker` (refuses another Manager's request),
  `bm_create_worker` (the Manager's own folder), the Manager's role file (no
  word about another project);
- the only route between projects is Paseo's raw `send_agent_prompt`: no record,
  no reply route (the caller gets the receiver's end-of-turn text, written for
  the receiver's owner), no wake-up, and it can cut a running turn (ADR-024);
- `bm_report.waitingFor` is free text: the stall pass flags the wait after five
  minutes and nothing wakes the Worker when the other side is done;
- the Orchestrator sees every project but has no tool that links two requests,
  so its only lever is a command telling both sides to "coordinate directly".

Once both owners' grants allowed direct coordination (2026-10-08 ~16:50Z), the
agents exchanged four answers in minutes. The agents can coordinate; the
mechanism does not carry it.

## Decision

1. **A peer link is a stored object.** When an agent of project A asks project
   B, the plugin records a **peer link** in `<data folder>/peers/links.json`
   (one machine-wide store, since a link spans two workspaces): who asked (A's
   workspace, request and agent), whom (B's workspace and Manager), the text,
   B's request once one takes it, the state and the thread of messages. The
   link, not prose, is what every later step reads.

2. **Asking goes through a tool, never a raw send.** A bound Manager or Worker
   asks another project with **`bm_ask_project`**. The plugin resolves the
   project (a workspace id or a folder), finds or opens its Beads Manager,
   stores the link and delivers `BM-DELIVERY peer <recordId>` to that Manager
   through the outbox and the notice queue: stored first, resent after a
   reload, never into a running turn, dropped deliveries alerted. The role files
   send every cross-project ask through it.

3. **The receiving Manager treats a peer ask as a request from that project,
   not as the owner's word.** It delegates it with `bm_create_worker`
   (`peerLink`), attaches it to the request that already does that work with
   `bm_tell_worker` (`peerLink`), or answers what reading answers with
   `bm_peer_reply`. A peer delivery is a plugin notice: it never answers a
   decision, never approves an effectful action and never counts as the owner's
   message (ADR-027 decision 5; `message-origin.ts`).
   The new Worker's brief carries the ask in its own `peerAsk` block, never as
   the owner's request, and says that it is no yes for anything the Worker's
   Rule 1 guards. Only a bound Manager can take an ask, and only for a bound
   Worker: an unbound one could not answer the link.

4. **The reply is carried by code.** When a Worker of a linked request reports
   `finished`, `blocked` or `stopped`, the plugin delivers
   `BM-DELIVERY peer-reply <recordId>` to the asker (its live successor, else
   the asking request's Manager) without any agent relaying it. A `finished`
   report of a linked request must carry **`forPeer`**: what the asking project
   needs to know — the contract as built, how to call it, what changed. Every
   later `finished` of that request delivers again, so a contract that changes
   after the first answer is announced too.

5. **Both sides talk on the link.** `bm_peer_reply` sends one message on a link
   to the other side: the asker's message goes to the Worker of B's linked
   request (else B's Manager), and B's message goes to the asker. This replaces
   every raw `send_agent_prompt` between projects.

6. **A wait on a link is a structural wait.** `bm_report` with `phase: blocked`
   takes `waitingOnPeers` (link ids its request opened). While one of them is
   open the stall pass does not flag the request as stalled; the peer reply is
   the wake-up. The wait is recorded on the link (`waitingSince`), since a
   stored report keeps only its `blockers` line, and it has a ceiling: a
   taken link with no live answering agent, or 2 hours without a message,
   stops counting and alerts. A link nobody took within 10 minutes raises the Inbox alert
   `peer-unanswered` on the asking request, so a silent receiver reaches the
   owner without the owner checking.

7. **Bounds.** At most 10 open links per request; a link from a request that is
   itself a peer request may not target the link chain's first workspace (the
   reply goes on the existing link instead) and a chain is at most 3 links
   deep. The links store keeps at most 2,000 links, never dropping an open one.

8. **Everyone reads the links, nobody relays.** `bm_peers` (Manager, Worker)
   lists the other projects and the caller's workspace's links with their
   states, so a Manager answers "where does the backend stand" by reading. The
   Orchestrator's `bm_projects` shows each project's open links; its role file
   says it never relays between projects and that its commands do not stand
   between two projects' agents.

9. **The noise that cost owner turns is removed in the same feature** (base
   design §7.7, §7.8, §7.17.8): at a delegating autonomy level a review-budget
   question is decided by the policy, not carded; a repeated delivery does not
   start a Manager turn; `bm_answers` refuses a question already answered; an
   Orchestrator question that repeats an open Worker question of the same
   request and subject is refused; the danger signal reads commands, not file
   content; the handoff brief is built from the newest report and activity and
   is never cut mid-word.

10. **Every Beads Manager is bound, however it was opened.** The creation hook
    issues a tool binding for a `bm-manager` creation that carries none — the
    owner's own creation from Paseo's composer — and `agent.created` settles it
    to the new Manager (a hook-origin binding, never the plugin's own
    `createManager` binding; one pending per workspace; a recovery sweep and
    an `outdated-agent` alert when it cannot settle — base design §7.17.7). The trace's two Managers were opened from the composer, had no
    binding, and so created every Worker with raw `create_agent`: none of
    ADR-027's delivering tools, refusals or wake rules applied, and none of the
    tools above would have reached them.

## Consequences

- The owner hands a cross-project feature to one side and the other side's work
  starts, answers and announces contract changes without the owner carrying a
  message. M-19 (owner relay messages per cross-project request) and M-20 (time
  from a peer request's `finished` to the asker getting the reply) measure it.
- A Worker of A can start work in B. B's Worker still works only in B, under B's
  autonomy level and action boundary; B's Manager still raises a misaligned ask
  with the owner. The plugin bounds the fan-out (decision 7).
- The role files grow by a few lines; their line budgets in
  `test/roles-content.test.ts` are raised by the same amount, recorded in the
  base design §10.
- Agents created before this version keep raw `send_agent_prompt`; the
  outdated-agents notice already asks the owner to replace them.
- A new store means `setup.cleanup` deletes `peers/` with the rest of the data.

## Alternatives considered

- **The Orchestrator relays between projects.** This is what the trace shows
  failing: one more LLM hop, a standing order that blocked direct answers, and a
  relay that only happens when the Orchestrator is woken. Rejected.
- **Allow raw `send_agent_prompt` and only teach the prompts.** Fixes nothing
  structural: no reply route, no wake, cuts running turns. Kept only as the
  fallback for agents on older instructions.
- **Bind only the plugin's own creations, as before.** The owner opens
  Managers from Paseo's composer as often as from the sidebar; leaving those
  unbound leaves the whole bound path out of the most common case. Rejected.
- **One shared registry across workspaces.** Request ids are unique per
  workspace only, and every per-workspace store, cap and cleanup would change.
  A link store that names `{workspaceId, requestId}` pairs leaves them as they
  are.
- **A cross-project "feature" object with its own plan.** Bigger than the
  evidence needs; the links already group the requests of a feature. Left for
  later evidence.
