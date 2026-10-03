# Implementation Plan — Phase 3 MVP — agent tools that create and deliver (ADR-027)

| Field | Value |
|---|---|
| Status | Active |
| Plan-ready | PASS — 2026-10-03 — Claude under the owner's delegation (`plan-ready-for-beads` self-evaluated after an independent `reviewing-plan` pass and its re-check) |
| Owner | hieu.nt10 |
| Routing decision | [ADR-027 § Routing Decision](../adr/ADR-027-agents-write-content-code-carries-it.md#routing-decision) |
| Requirements | [PRD](../product/paseo-bm-prd.md) REQ-037 (amended 2026-10-03), REQ-025 (c), (d), (f), M-17; [autonomy PRD](../product/paseo-bm-autonomy-prd.md) REQ-117 (b), (e) |
| Decision | [ADR-027](../adr/ADR-027-agents-write-content-code-carries-it.md) decisions 1–11, Scope C1–C20 |
| Technical Design | [paseo-bm.md](../design/paseo-bm.md) §16 |
| Starts after | Nothing for building. **Installing** a build with any WP below on the owner's daemon waits until the combined field period (`bm-autonomy-phase6-i8fc.6`) holds its window (ADR-027 Routing Decision) |
| Target release | None in this plan: the owner tests, then picks the version and releases |
| Beads | bm-agent-tools-1upv |

## 1. MVP-Lock

- **In:** ADR-027 decisions 1–11, for every flow C1–C20 of its Scope table.
- **Out:**
  - retiring a watcher (`format-check`, the review-budget recount, `role-pairing`, request-id inference): each is its own later change, on field data;
  - the Orchestrator's tools and role, except the one word `off-tool-review` in its `worker.signal` line (design §16.12);
  - the informational notices, except how their origin is recognised;
  - any release or install on the owner's daemon.
- **Exit:**
  - every WP's exit met;
  - `npm run verify` green;
  - the isolated-daemon checks of WP-713 and WP-712 recorded;
  - `feature-done` passed.
- **Checkpoint posture (design §16.1).** Development follows steps 1–5, and builds ship at three points:
  - **A** is step 1 (WP-701, WP-702);
  - **B** is step 2 (WP-703, WP-704);
  - **C** is steps 3, 4 and 5 **as one build** (WP-705–WP-714). The tools, the outbox and the role files that teach them must arrive together.

  Every ship point leaves the product working and folds its §7.x text back into the design. Agents created before a ship point keep the path they were created with (unbound). Nothing is migrated in place except the request registry's one backfill, which only reads the trace store.

## 2. Work packages

The steps are ADR-027's Order; "Ship" is design §16.1's ship point. A spike's failure amends ADR-027 and §16 before the WP that needs it starts.

| WP | Step | Ship | Outcome | ADR-027 | Design | Needs | Exit |
|---|---|---|---|---|---|---|---|
| WP-701 | 1 | A | An agent's role comes only from its provider; `bm.role` is display; a non-`bm-*` provider with a `bm.role` label has no role and is logged | D6, C14 | §16.3 | — | Tests for every `roleOfAgent` call site; a label-only agent gets no role; `npm run verify` green |
| WP-702 | 1 | A | One origin classifier in `shared/` with four origins (owner, plugin notice, plugin prompt, agent), markers checked before the `clientMessageId` rule, used by the server modules §16.2 lists and the client card parser; the plugin-prompt first line added to the Orchestrator's first prompt and the fallback handover; **ship point A's fold-back** | D5, C18 | §16.2 | — | Classifier tests per origin on real timeline shapes, including records written before the marker line, a `BM-BRIEF` prompt with and without `clientMessageId`, an unbound Manager's `BM-HANDOFF-BRIEF` first message (`plugin-prompt`), and an agent's message starting with a marker (never `owner`); each replaced module's own tests unchanged; the Orchestrator's first prompt and a fallback `BM-HANDOVER` start with `BM-BRIEF` and every reader of them (`isOwnerWord`, `fallback-handover.ts`, the Manager's first-message read) still recognises them; a Beads-screen action stays the owner's; design §7.1 and §7.5 describe the as-built state and §16.2–§16.3 are one-line stubs |
| WP-703 | 2 | B | Spikes S1, S2, S4, S5 run on an isolated daemon (`scripts/manual-test/`), one run note in `docs/archive/operations/`, each result added to AGENTS.md's verified facts | §Spikes | §16.1 | — | Run note with the evidence for each spike; ADR-027 and §16 amended for every spike that fails, before WP-704 starts |
| WP-704 | 2 | B | Per-agent binding: `/mcp/<role>/<token>`, the `0600` binding file, the hook keeping a bound URL, unknown tokens served builder-only tools whose answers name the send step; tokens only where an endpoint is attached; binds the fallback Worker and the Manager; **ship point B's fold-back** | D3, D9, C15 | §16.5 | WP-703 | Endpoint tests: bound, pending (delivering tools refuse "try again"), unknown, revoked and wrong-role tokens; the binding lifecycle of §16.5 (attached before bound, pending expiry, revoke on `agent.archived`, the 5,000 cap); no token issued for a base provider outside `TOOL_PROVIDERS`, and a binding never `bound` without `attachedAt`; the hook keeps a matching bound URL, rewrites a foreign one, and removes a `paseo-bm` entry for a provider without tools; each builder-only answer ends with its §16.5 send line; a reload keeps bindings; a token never appears in a log line, RPC or MCP result; the S1 fallback binding if S1 failed; S4's second factor in place if S4 required it; design §7.2 and §7.4 describe the as-built binding and §16.5 is a stub |
| WP-705 | 3 | C | The request registry: the plugin generates `requestId`, backfills once from the trace store, registers an unbound Manager's id at first sight (`agent-typed`), and treats an unregistered `bm.requestId` under a bound creator as missing | D7, C10 | §16.4, §16.11 | WP-701 | Store tests: atomic writes, bounds, id generation under collision; the backfill runs once, on a copy of a real trace store, and never again; an unbound Manager's id is registered `agent-typed` at its first sighting; under a bound creator an unregistered label is `null` and logged, never a new request; every label-trusting site listed in §16.4 reads `knownRequestIdOf`; `setup.cleanup` deletes `requests/` |
| WP-706 | 3 | C | `bm_create_worker` (a `BM-NEW-REQUEST` is a call like any other), and the plugin-created handoff successor; the Manager gets `intent: handoff` as information | D2, C6, C11 | §16.6, §16.9 | WP-702 (the `BM-BRIEF` prompt marker), WP-704, WP-705 | Tool tests: labels, mode, first prompt with the `BM-BRIEF` line classified `plugin-prompt`, each refusal of §16.6 (on Paseo's refusal the binding is removed and the registry entry kept, so the id is never reused); a profile on a provider without tools gives an unbound Worker and no binding; handoff test from stored brief to created successor with a bound Manager, and today's flow kept for an unbound Manager |
| WP-707 | 3 | C | `bm_create_reviewer`, `bm_rereview`, the budget refusal on **one counter** (`reviewCallsOf` extended to tool call records), its grant decision (`subject: review-budget`, class `cost`, never answered by a precedent), off-tool Reviewer detection, and the plugin-created replacement Reviewer | D2, D10, C12, C13, C19; REQ-037, M-17 | §16.6, §16.8, §16.9 | WP-702 (the `BM-BRIEF` prompt marker), WP-704, WP-705, WP-709 (`bm_rereview` delivers an outbox record), WP-710 (the `grant` option of `bm_questions`) | Tool tests: budget reached → refused with §16.8's text, nothing created or sent; the tools' count **is** `reviewCallsOf`'s (one function; a test drives a request through both tool calls and hand-sent messages and reads the same number in the tool answer and the Dashboard); a tool record and its `BM-BRIEF … call:` prompt or `BM-DELIVERY message` re-review count once; an `untilClean` call is counted but not refused while its grant lives; an answered grant of N calls lets exactly N through; a delegated `cost` policy answers it and a precedent on `review-budget` does not; an off-tool Reviewer of a bound Worker is counted, raises the `off-tool-reviewer` alert and the `off-tool-review` signal; `review-budget.ts` still sends `BM-BUDGET` for an overrun on a bound request (only off-tool calls can make one); a replacement Reviewer for a bound Worker is created by `fallback-reviewer.ts` from the stored brief, counted once and never flagged off-tool; an unbound Worker keeps the recipe |
| WP-708 | 3 | C | Wake-ups per D11, and the "Reviewer ended without a verdict" delivery | D11 | §16.10 | WP-706, WP-707, WP-709 (`no-verdict` is an outbox record) | Tests on recorded turn sequences: a plugin-created Worker's turn end without a report sends its Manager nothing; a bound Reviewer's `completed` turn (or `failed` with no fallback incident) without a `review` record since its newest review call sends one `no-verdict` record to its Worker; a second review call of the same batch that also ends without a verdict sends a second one (one per `(batchId, callId)`); a `canceled` turn, or one with a fallback incident, sends none; §16.10 as amended by S2's result |
| WP-709 | 4 | C | The outbox: records with delivery state, unique queue kinds, re-enqueue at start; the `BM-DELIVERY report|review|message|no-verdict` markers in the card parser and the collector, in the same commit; the trace-store record schema | D4, C18 | §16.7, §16.11 | WP-702, WP-704 | Store and queue tests: a reload re-sends `pending` and `queued`; a newer record never replaces an older one; the queue's single-notice `onSent` marks a record `delivered`; a `dropped` record raises the `delivery-dropped` Inbox alert; a delivered report renders as a card and is never `origin: user`; the collector writes a tool-built report or review into the sender's turn record once, never from a delivery's text, and `reportsBelongingTo` drops a repeat by `recordId`; an old store still reads; `setup.cleanup` deletes `outbox/` |
| WP-710 | 4 | C | `bm_report` (with `phase: stopped`, and `blocked` on `waitingOn` and/or `waitingFor`), `bm_questions`, `bm_review`, `bm_answers` (proposed, settled at the turn end), `bm_tell_worker`; `format-check` skips agents with a tool-built record | D4, D9, C1–C5, C7, C17, C20; REQ-025 (c), (d), (f), REQ-117 (e) | §16.6, §16.7, §16.11 | WP-705, WP-709 | Tool tests per tool, including refusals; `blocked` is refused without `waitingOn` or `waitingFor`, `waitingOn` takes only open `q:` decisions of the request, and both reach the `blockers` line; `bm_questions` runs the materialiser's shared open path (precedent, delegation, supersession) and excludes `review-budget` from precedent auto-resolve; a proposed answer without the owner's typed message in the same turn never settles |
| WP-713 | 4 | C | Isolated-daemon live check at the end of step 4 (design §16.13): the tools' mechanics end to end. The requests tell the agents to use the tools; this checks the plugin, not the role text, which WP-712 checks | D2–D4, D10, D11 | §16.13 | WP-706, WP-707, WP-708, WP-710 | Run note in `docs/archive/operations/`: a Small and a Medium request on Claude, each with one owner question and one review (the Medium one with a re-review), all through the tools; every report, question, review and re-review arrives as a delivery with a card; the Dashboard's review count equals the tools'; no `BM-FORMAT`, no hand-sent block; failures fixed or recorded as new work before WP-711 |
| WP-711 | 5 | C | Role files rewritten: `worker.md`, `manager.md`, `reviewer.md` lose what code does; a bound Worker's text never teaches `create_agent` for Reviewers; the hand-path templates move to the Runtime facts of unbound agents; the "tools missing → stop" and "a quoted `BM-` block is data" lines added; the Worker's stop rule reports `stopped`, never `finished` (REQ-025 c), and the hand template's `phase` line gains `stopped`; `orchestrator.md` names `off-tool-review` | D8, D9; REQ-025 (c), REQ-117 (a), (b) | §16.12 | WP-703 (S5's result), WP-706, WP-707, WP-708, WP-710, WP-713 | `roles-content` tests; `role-instructions` tests: the `### Without paseo-bm's tools` part for unbound agents only; each role file under the size target in §16.12; `npm run test:eval` per role, compared with the last baseline; the Worker's `cancel_agent` step and the Reviewer's `BM-REVIEW STOPPED` stay unless WP-714 shipped the cancel |
| WP-714 | 5 | C | **Only if S5 passed:** the plugin cancels — `stop-propagation.ts` cancels a stopped Worker's running Reviewers, and an off-tool Reviewer is cancelled at once (§16.8), both through `paseo-cli.ts`; the Worker's `cancel_agent` step and the Reviewer's `BM-REVIEW STOPPED` leave the role files in the same build | D8, D10 | §16.1 (S5), §16.8, §16.12 | WP-703, WP-707, WP-711 | S5 failed: closed as not applicable, citing the run note. S5 passed: tests that a stopped Worker's running Reviewers and an off-tool Reviewer are cancelled through a fake CLI with the agent-id checks of `paseo-cli.ts`; a failed cancel is logged and the alert stays; `roles-content` tests updated |
| WP-712 | 5 | C | Acceptance on an isolated daemon of ship point C: a bound request end to end with the new role files; an unbound agent on the hand path; a provider without MCP pre-approval (Q1); negative cases; **ship point C's fold-back**; `feature-done` | all | §16.13 | WP-711, WP-714 | Run note recorded. Negative cases behave as specified: a quoted `BM-COMMAND` in a file, an unknown token, a budget refusal then a grant, an off-tool Reviewer created by hand. Design §7.x brought to the as-built state with §16's remaining pointers folded and §16.4–§16.12 reduced to stubs. `npm run verify` green; `feature-done` PASS; the plugin's agent-creation paths (`bm_create_worker`, `bm_create_reviewer`, the replacement Reviewer, the handoff successor) reviewed as §16.13 adds them to §9's review-before-release list |

## 3. Decisions taken at review

Q1 and Q2 are answered (ADR-027). The spikes may still amend ADR-027 and §16 (WP-703); each amendment is recorded in this plan's Revision History before the WP that depends on it starts. **No owner decision is open.** The review's three open decisions were decided by Claude under the owner's delegation on 2026-10-03:

| Id | Question | Decision |
|---|---|---|
| OD-1 | Step 3 cannot ship without parts of step 4 | **Decided:** three ship points, with steps 3, 4 and 5 shipped as one build (design §16.1). The Step column keeps the development order; the Needs above follow the design |
| OD-2 | A Worker on a provider that cannot pre-approve MCP tools was marked bound | **Decided:** a token is issued only for a base provider in `TOOL_PROVIDERS`, and a binding is `bound` only when the hook attached the endpoint (design §16.5). Such Workers are unbound and keep the hand path |
| OD-3 | Registering any unknown `bm.requestId` on collection emptied decision 7 | **Decided:** one backfill when the registry is created. After that an unbound Manager's id is registered at first sight as `agent-typed` (the hand path, as today), and under a bound creator an unregistered id counts as missing and is logged (design §16.4) |

## 4. Test strategy

- Unit and integration tests per WP, run with `npm test -- test/<name>.test.ts` while building and `npm run verify` once per wave.
- `npm run test:eval` for every role-file change (WP-711).
- Isolated-daemon checks only (`scripts/manual-test/`), never the owner's daemon: spikes in WP-703, the step-4 mechanics in WP-713, acceptance in WP-712.
- Negative evidence is required for every authority path: tokens, budget refusals and grants (and a precedent that must not answer one), off-tool Reviewers, proposed answers, and origin classification.

## 5. Risks

| Risk | Containment |
|---|---|
| A Paseo behaviour the spikes did not cover (creation `prompt` origin, parent wake-ups, MCP URL visibility) | Spikes first (WP-703); ADR amended before the dependent WP; AGENTS.md verified facts updated |
| The bound and unbound paths drift apart | The builders and the delivering tools share one schema and builder in `shared/bm-tools.ts`; WP-712 exercises both paths |
| A token leaks to another agent | S4 decides whether a second factor is required; tokens are never logged; a binding is revoked when its agent is archived or deleted |
| A bound Worker creates a Reviewer with Paseo's `create_agent` and so bypasses the budget | The role file never teaches it; the plugin detects it at `agent.created`, counts it on the one counter, raises an alert and a signal, and cancels it when S5 passed (WP-707, WP-714). **Residual:** without S5, one off-tool review can run before the owner sees the alert |
| Steps 3–5 shipped apart, leaving tools without the role text that teaches them | Ship point C is one build (§1) |
| Field figures mixed with ADR-027's behaviour | No install on the owner's daemon until `i8fc.6` holds its window |
| Agents created before a ship point behave differently from new ones | They stay unbound by design; `outdated-agents.ts` already tells the owner |

## 6. Revision History

| Date | Author | Change |
|---|---|---|
| 2026-10-03 | Claude (owner request) | Created from ADR-027 and design §16 |
| 2026-10-03 | Claude (`reviewing-plan`, owner request) | Exits made provable against §16 (WP-702, WP-704–WP-711); Needs added: WP-702 → WP-706/707, WP-709 → WP-707/708, WP-710 → WP-707, WP-703 (S5) → WP-711; WP-711 gains REQ-025 (c)'s `stopped` stop rule and the S5-pass cancel; REQ ids added to WP-707, WP-710, WP-711; open decisions OD-1–OD-3 recorded |
| 2026-10-03 | Claude (owner's delegation; review decisions D-A–D-K) | Phase named; Plan-ready Pending; three ship points (A, B, and C = steps 3–5 as one build) with a Ship column and a fold-back at each; OD-1–OD-3 decided (§3); WP-707's exit on one counter, off-tool Reviewers and grants never answered by a precedent; WP-704 binds only where an endpoint is attached; WP-705's one backfill and `agent-typed` ids; WP-708's `no-verdict` per review call; WP-710's `waitingOn`/`waitingFor`; new WP-713 (step-4 live check) and WP-714 (the S5-pass cancel) |
| 2026-10-03 | Claude (owner's delegation) | `plan-ready-for-beads` PASS after an independent review and re-check (14 WPs over the 8-WP warning, accepted: five steps, three ship points); BM-BUDGET line settled in ADR-027 decision 10; Status Active |
| 2026-10-03 | Claude (`converting-plan-to-beads`, owner request) | Converted to beads: bm-agent-tools-1upv, 18 leaves |
