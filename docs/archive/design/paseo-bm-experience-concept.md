# paseo-bm — Experience concept: management screens and role cards (fresh eye)

| Field | Value |
|---|---|
| Status | **Draft** (2026-09-29) — a concept for the owner's review, not a design to implement from. On approval its decisions move into the Phase 1 Technical Design, and this file is archived |
| Owner | hieu.nt10 (GitHub: hieunt286) |
| Requirements source | [Calibrated autonomy PRD](../../product/paseo-bm-autonomy-prd.md) (Review): REQ-111, REQ-112, REQ-118, REQ-125, REQ-130, REQ-151 |
| Replaces, on approval | The screen and card sections of the [Dashboard design](../../design/paseo-bm-dashboard.md) §11 and the tab of the [Orchestrator design](../../design/paseo-bm-orchestrator.md) §9 |
| Method | Looked at the product as a first-time owner would, from the shipped screenshots (`plugin/images/`), GUIDE.md, and the owner's session of 2026-09-29; no code read for this pass |

## 1. What a fresh eye sees today

| # | Observation | Where | Consequence |
|---|---|---|---|
| 1 | **The product opens on configuration.** Beads Manager lands on Setup; the daily work (Orchestrator, what waits for me) is the fourth tab of Setup; workspaces are behind a button | Setup screen | The most frequent question — "does anything need me?" — is three taps deep |
| 2 | **One question can be answered in four places**: the report card in the Manager's chat, the waiting pill above the chat, the Manager's `A6 a` letters, and the Orchestrator's Needs you card | Chat cards, pills, Orchestrator tab | Duplicates and repeated questions (2026-09-29); the owner cannot tell which answer counts |
| 3 | **Too many card kinds, each with its own buttons**: report, review, request, command, copy, event line, notice, answers, question rows, bead chips, fallback card; Reply boxes, Answered chips, Mark as answered, Use recommendations | Chat cards | Each surface must be learnt; little is shared |
| 4 | **Data before decisions.** The Beads screen shows five stat tiles, two bar charts and three time cards before the first bead; the Metric request expands into a text dump ("0 ms", "Request text not recorded", tokens by model, two Manager lines, twelve workflow chips mostly amber "?") | Beads, Metric | The owner scrolls past numbers to find what matters; unknowns look like problems |
| 5 | **Switches overlap**: Watch for stalled work, Autopilot per project, Allow… per category, per-role modes, additional instructions per role | Setup, Orchestrator tab | Nobody can say from the screen what the agents may do on their own |
| 6 | **Identifiers everywhere**: `req-20260928T033255Z`, agent ids, `BM-*` markers, "Worker dc05ba8d" | Everywhere | Machine language on a human screen |
| 7 | **No trace from a result to its reasons**: a Metric node shows what an agent did, not which decision allowed it or which check proved it | Metric | "Why did this change?" has no answer on screen |

## 2. Principles

1. **Decision first.** The first screen answers "what needs me"; then "what is happening"; then "how well is it working"; configuration last.
2. **One object, one card.** A decision, a report or a verdict has one card, drawn the same wherever it appears, and its state is the same everywhere.
3. **Every card says who acts, on whose authority, and with what effect** — the three facts that make delegation trustworthy.
4. **One primary action per card.** Everything else is behind Details.
5. **Human words, machine ids hidden.** Projects by name, agents by role and title, requests by their first line; ids only in Details.
6. **Unknown is quiet.** What cannot be known is shown once, muted, never as a warning.
7. **Evidence is visible.** Detected evidence is marked differently from what an agent says about itself.
8. **Phone and desktop.** Every screen works at a phone width with one column.

## 3. Information architecture

Beads Manager (the sidebar item; no badge — the SDK has none, X-1 revised) opens on the Inbox and has four sections, always in the same order:

| Section | Answers | Replaces today |
|---|---|---|
| **Inbox** | What needs me; what was decided for me; what went wrong | Orchestrator tab's Needs you, the waiting pills, the report cards' question rows, the Manager's answer letters |
| **Work** | What each project and request is doing now; its beads | The Workspaces list, the Beads screen, the Metric graph, the Orchestrator health cards, the "Beads agents" panel |
| **Insights** | How well the agents work; how often each class's predictions matched the owner; what it costs | Metric overview cards, assessments, token and cost tables |
| **Settings** | Agents and models; autonomy policy; tools and skills; data | Setup's four tabs, the Watch/Autopilot/Allow… switches, additional instructions |

The Beads tab in a workspace and the Command Center items open **Work** on that project. The Orchestrator's chat stays the place to *talk*; the Inbox is the place to *decide*.

## 4. Screens

### 4.1 Inbox

```
Beads Manager                               Inbox 2 · Work · Insights · Settings
────────────────────────────────────────────────────────────────────────────────
NEEDS YOU · 2
┌─ xspace-master-data · "Migrate fee list…" ───────────────────── RELEASE ─┐
│ Push both backends to origin/dev?                                         │
│ master is 5 commits ahead, contract 1 (narrows who sees fee rows).        │
│                                                                           │
│  [ Push contract only ★ ]  [ Push both, manifest by hand ]  [ Hold ]      │
│  ★ recommended by Worker A · asked 12 min ago · Own words…   Details ▸    │
└───────────────────────────────────────────────────────────────────────────┘
┌─ shop · "Checkout coupon" ─────────────────────────────────────── SCOPE ─┐
│ Also fix the rounding bug found in cart totals?                           │
│  [ Yes, in this request ]  [ Separate request ★ ]  [ No ]                 │
└───────────────────────────────────────────────────────────────────────────┘

DECIDED FOR YOU · today 7 · 0 overridden                          Review all ▸
  ✓ shop · test file layout → per-module (precedent: shop, 12 Sep)   Override
  ✓ site · image format → webp (preference · delegated, 96 % agree)  Override
  …

ALERTS · 1
  ● paseo-bm-site · Worker B tried `npm publish` — held          [ Decide ]
```

- **Needs you**: decisions in the `owner` classes and anything held at the action boundary, oldest first, grouped by project. A class chip (SCOPE, RELEASE, …) on each card; the recommended option marked ★; the prepared action runs on tap (with a confirmation only for RELEASE/DATA/SECURITY/COST).
- **Decided for you**: the digest of REQ-125 — one line each, with the reason (precedent or delegated class and its agreement) and **Override**. The digest lives only here; nothing is pushed to the Orchestrator's chat (X-3).
- **Alerts**: safety events and stuck work that needs a human (a permission waiting, a Worker with no activity); never routine progress.
- Empty Inbox: one sentence — "Nothing needs you. 3 requests are running." with a link to Work.

### 4.2 Work

Projects, most recent first; each row is one line on a phone:

```
WORK
● xspace-master-data   Migrate fee list…          ▸ Build  3/5 beads   A · 2 m
● shop                 Checkout coupon            ▸ Review             A R · now
○ paseo-bm-site        idle · last finished 2 h ago
```

A project page:

```
xspace-master-data                                   [ New request ]  [ Chat ▸ ]
Requests · Beads · Agents
────────────────────────────────────────────────────────────────────────────────
Migrate fee list to the new repos                         Worker A · started 3 h
Received ─── Plan ─── Build ━━━ Review ─── Done                 Medium
  ✓ plan: 5 beads          ✓ 3 closed with detected checks     ◐ 1 decision open
  Timeline ▾
   14:02  You chose "Push contract only" → Worker A          (grant: release, 1×)
   13:50  Worker A asked: push both backends?                        RELEASE
   13:31  Reviewer: changes required · 1 blocking → fixed           ✓ re-review
   …
  Why? ▸   Cost 1.8 M tokens · $2.10 (estimated)   Open Worker ▸
```

- **Requests** replaces the Metric graph: a **stage bar** (five stages, the current one bold), three evidence lines, and a **timeline** of typed events instead of a text dump. Unknown steps are simply not drawn.
- **Beads** is the board, first: columns In progress · Ready · Blocked · Closed (hidden by default); the counts sit in the column headers; the charts move to Insights.
- **Agents** is the Manager → Workers → Reviewers tree, with status and "open" links.
- **Why?** (Phase 5) opens the chain for the request: decisions → beads → changes → checks → verdicts.

### 4.3 Insights

```
INSIGHTS                                        last 30 days · all projects ▾
Autonomy by class
  class            mode        agreement   reversals   decisions
  reversible-tech  delegate     97 %  ▰▰▰▰  0            118
  preference       shadow       91 %  ▰▰▰▱  0             34   [ Delegate? ]
  scope            owner        62 %  ▰▰▱▱  2             41
  release          owner (fixed)                            12
Quality     evaluation suite 0.6.0: 7/7 correct · 7/7 boundary-clean (0.5.0: 6/7)
Flow        questions/request 1.3 (was 5.1) · median time 1 h 20 m
Cost        tokens/request 1.6 M (−18 %) · Worker 91 % · Reviewer 5 %
Review      blocking findings/batch 0.6 · acted on 100 %
```

Each figure opens its breakdown. The `[ Delegate? ]` button is a shortcut on any class that may be delegated and is not yet: there is no threshold, and the figures are information ([ADR-023](../../adr/ADR-023-delegation-without-eligibility.md)).

### 4.4 Settings

Five groups on one scrolling screen, each collapsed to one line with its state:

- **Agents** — per role: provider, model, thinking, mode; fallback chain; "the Reviewer uses another model family" note (REQ-133).
- **Autonomy** — the policy matrix (projects × classes: owner / shadow / delegate), where the owner delegates a class at any time after one confirmation, with a **Reset to owner** per project.
- **Coordination** — how often the Orchestrator advises (Phase 2), then compaction and handoff (Phase 3); autonomy design §G.7.
- **Tools & skills** — `br`, `bv`, skills: healthy / missing, with install or copy-command actions.
- **Data** — trace size, cleanup, removing paseo-bm's settings.

Gone: the Watch switch, Autopilot and Allow… (policy replaces them), per-role "additional instructions" (precedents and the rewritten roles replace them; X-2).

## 5. The card system

### 5.1 Anatomy — one grammar for every card

```
┌ ⚙ <Actor> → <Recipient>        <authority>                     <time> ┐
│ <STATUS CHIP>  <one-line title>                          <class/tier> │
│ <body: at most 3 lines, the thing that matters>                       │
│ [ Primary action ]                                       Details ▸    │
└───────────────────────────────────────────────────────────────────────┘
```

- **Actor → Recipient**: role icon in the role colour, role and title ("Worker A · Cart fix"), never an id.
- **Authority**: *your answer 14:02* · *delegated: preference* · *precedent: shop, 12 Sep* · *policy* · *grant: release 1×*. Empty for plain reports.
- **Status chip**: one of a small fixed set (Received, Working, Needs decision, Finished, Unverified, Changes required, Passed, Held).
- **Details**: the full record (raw block, ids, tokens) — the only place ids appear.
- **Live**: the card re-renders when its record changes (answered elsewhere → "Answered by you in the Inbox · 14:02").

### 5.2 The Decision card (shared by every role and the Inbox)

```
┌ 🔨 Worker A → you                                   asked 12 min ago ┐
│ NEEDS DECISION  Push both backends to origin/dev?           RELEASE │
│ master +5 commits, contract +1 (narrows who sees fee rows).          │
│ [ Push contract only ★ ] [ Push both, manifest by hand ] [ Hold ]    │
│ Own words…                                               Details ▸   │
└──────────────────────────────────────────────────────────────────────┘
      after the tap, everywhere:
┌ 🔨 Worker A → you                          answered by you · 14:02 ┐
│ ✓ DECIDED  Push contract only                   grant: release 1× │
│ Sent to Worker A. Precedent saved for xspace-master-data?  [ Save ]│
└────────────────────────────────────────────────────────────────────┘
```

The same card appears in the Worker's chat, the Manager's chat, the Orchestrator's chat and the Inbox. There is no other question UI.

### 5.3 Cards per role

| Role | Cards it produces | Shape |
|---|---|---|
| **Manager** (the project's context and alignment, facing the owner) | **Request received** — "Handed to Worker A · sizing…", with the context it gave the Worker one tap away (goals, precedents, related requests); **Alignment** — when a plan or result drifts from the owner's goals, a Decision (§5.2) in the `scope` class; **Request summary** at finish — outcome in one line, evidence line, "Decided for you: 3", suggestions as `[ Make a request ]` buttons | Conversational replies stay plain text; only these are cards |
| **Worker** (delivery) | **Progress** — the stage bar, beads n/m, evidence chips; **Decision** (§5.2); **Finished** — what changed (files, beads), checks with *detected* ✓ or *self-reported* ◐ marks, decisions it made (each with Override), suggestions | At most one Progress card per stage change; no card for routine turns |
| **Reviewer** (evaluation) | **Verdict** — PASSED ✓ or CHANGES REQUIRED · 2 blocking; each blocking finding as `file:line — reason` with its evidence; on re-review "2/2 fixed ✓" | Non-blocking findings folded under Details |
| **Orchestrator** (owner's delegate) | **Decided for you** — the option taken, the class and agreement or the precedent, `[ Override ]`; **Action** — intent → target, effects, authority (e.g. "Continue → Worker A · no effects · delegated: reversible-tech"); **Held action** (Phase 4) — the command held, `[ Decide ]` | Never a copy of another card: it links to the Decision instead |

Incoming messages to an agent (the request brief to a Worker, a review request to a Reviewer) render as a compact **Brief** card: the request quoted verbatim, the scope, what to hand back — the immutable task statement, readable at a glance.

### 5.4 What disappears from the chats

Reply boxes on report cards, Answered chips, Mark as answered, Use recommendations, the waiting pills, `A6 a` answer letters, command copies, the `BM-EVENT`/`BM-STALL` lines, and the fallback-specific card variants (a fallback question becomes a Decision in the `environment` class).

## 6. Retirement map (UI)

| Today | Fate |
|---|---|
| Setup as landing; Setup → Orchestrator tab | Inbox landing; Orchestrator content split into Inbox, Work, Insights, Settings |
| Workspaces list + Go to / Metric / Beads buttons | Work |
| Metric overview tiles, 7-day bars, top-5 Workers | Insights |
| Metric request graph and its text dump; twelve workflow chips | Work → request: stage bar, evidence lines, timeline |
| Beads overview (tiles, charts, time cards) above the board | Board first; figures to Insights |
| Report card question rows, waiting pills, Mark as answered, answer letters, Needs you cards | Decision card |
| Command card, copy card, event lines, stall lines | Action / Decided-for-you cards; events go to the timeline |
| Watch, Autopilot, Allow…, additional instructions | Autonomy policy; precedents |
| Header "Beads" button, "Beads agents" and "Beads in this chat" panels | Kept only if the Phase 1 design shows use; otherwise Work covers them |

## 7. Visual language

- Role colours stay as today (theme tokens), used only for the role icon and the Actor line.
- State colours: one per status chip, from theme tokens; class chips are neutral with text, never colour-only.
- Density: a card is at most ~5 lines closed; lists page at 20.
- Language: interface text in English; content (questions, options, summaries) in the owner's language, written by the agents.

## 8. Open questions

| ID | Question | Status |
|---|---|---|
| X-1 | Should the Inbox also live as a header button in every workspace (a count badge), or only in Beads Manager? | **answered (2026-09-29)** — a count badge on the Beads Manager sidebar item only; **revised the same day (autonomy design DQ-3)**: no badge at all — the SDK cannot put one on a sidebar item; the Inbox handles it |
| X-2 | Keep per-role "additional instructions" as an expert setting, or remove them once precedents exist? | **answered (2026-09-29)** — remove; precedents per project and the rewritten roles replace them (PRD Appendix B) |
| X-3 | Does the owner want a daily digest pushed to the Orchestrator chat, or only shown in the Inbox? | **answered (2026-09-29)** — only in the Inbox |
| X-4 | Confirmation on the tap: only for RELEASE / DATA / SECURITY / COST, or for every decision? | **answered (2026-09-29)** — only for RELEASE / DATA / SECURITY / COST |

## 9. Revision History

| Date | Author | Change |
|---|---|---|
| 2026-10-01 | hieu.nt10 (owner decision; written by Claude) | §4.1, §4.3, §4.4: no eligibility gate (ADR-023) — Delegate? is a shortcut on any delegable class, and Settings → Autonomy delegates at any time after one confirmation |
| 2026-09-30 | Claude (owner's delegation) | §4.4: Settings gains Coordination, a fifth group after Autonomy (autonomy design §G.7, ADR-021) |
| 2026-09-29 | hieu.nt10 (drafted by Claude) | Owner answered X-1 → X-4: badge on the sidebar item only, additional instructions removed, digest only in the Inbox, confirmation only for release/data/security/cost. The concept is ready to feed the Phase 1 design |
| 2026-09-29 | hieu.nt10 (drafted by Claude) | Created as a Draft concept for the owner's review, with the calibrated autonomy PRD |
