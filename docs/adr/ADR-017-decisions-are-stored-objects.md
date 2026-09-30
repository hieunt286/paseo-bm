# ADR-017 — Decisions are stored objects, handoffs are typed records, and nobody relays

| Field | Value |
|---|---|
| Status | **Accepted** (2026-09-29) — approved by the owner with the autonomy design |
| Date | 2026-09-29 |
| Owner | hieu.nt10 |
| Supersedes | [ADR-014](ADR-014-orchestrator-agent-proposes-owner-approves.md) decision 3 (a proposal as the Orchestrator's one action) and 4 (approval by a click on a proposal); [ADR-015](ADR-015-orchestrator-autopilot-per-project.md) decision 3 (a "send it" in chat as approval of a pending proposal) and 4 (a fixed limit line); [ADR-016](ADR-016-orchestrator-coordinates-workers-live.md) decision 3 (the regex gate as the authority) and 5 (`limits:` fixed on every Orchestrator command) |
| Amends | [ADR-010](ADR-010-plugin-hosted-agent-tools.md) (the plugin acts on typed blocks after the turn that wrote them); [ADR-011](ADR-011-manager-coordinates-workers.md) (the Manager relays no question or answer) |
| Related | [Calibrated autonomy PRD](../product/paseo-bm-autonomy-prd.md) REQ-110 → REQ-119 · [Autonomy design](../design/paseo-bm-autonomy.md) Part A |
| The owner's decisions | 2026-09-29: one card per question, answered once everywhere; a prepared action per option; a one-use grant of 60 minutes; an answer typed in a chat closes the card |

## Context

A question to the owner is today a piece of text copied from the Worker's chat to the Manager's, to the Orchestrator's and to the tab. Every copy can drift: the owner answered the same push question twice on 2026-09-29, then the Orchestrator's own gate refused the command the answer authorised; earlier repeated-question diagnoses (2026-09-23, 2026-09-24) and a report cut in half (2026-09-28) have the same cause. The field replay counts 21 duplicated or re-asked questions in two weeks. Authority is inferred by regular expressions over prose, and every command carries a limit that can contradict it.

## Decision

1. **A decision is one stored record** — identity, request, asker, question, options with one recommendation and their declared effects, lifecycle (open, answered, superseded, expired, withdrawn), answer, grant — in the plugin's data folder. It survives reloads.
2. **Agents keep writing typed blocks; the plugin materialises state from them.** A Worker's `blocked` report (built by `bm_report`) opens decisions; a Manager's `BM-ANSWERS` written right after the owner's typed message answers them; the plugin reads these at the end of the turn that wrote them, idempotently by key. The Orchestrator's tools, whose endpoint knows its caller (the secret path), write decisions directly. This keeps ADR-010's side-effect-free tools for Managers, Workers and Reviewers.
3. **Nobody relays.** Every surface — the Inbox, the Worker's, the Manager's and the Orchestrator's chats — renders the same decision from the store; answering in any of them settles it everywhere, and the plugin itself delivers the answer to the asker.
4. **One action settles a decision.** An option may carry a prepared action; choosing it runs the action with the owner's authority. An answer in the owner's own words grants the effects the decision declared, for one use within 60 minutes.
5. **Commands declare intent and effects.** Authority comes from the declared effects and the owner's policy or grant; text patterns are a backstop whose mismatch becomes a decision, never a silent send or a silent refusal. A delivered command states what the owner approved and never carries a limit that contradicts it.
6. **One open Orchestrator decision per request** unless it says `separate`; a new one supersedes the open one. A Worker question re-asked under a new number supersedes the old one.

## Consequences

- Duplicates and re-asks disappear by construction instead of by patches; the question–answer ledger, `BM-ANSWERED`, the waiting pills, answer marks, proposals and the Manager's answer letters are removed (PRD Appendix B).
- The plugin now holds state that agents act on: the decision store must be bounded, atomic and covered by negative tests on every authority path.
- Delivery depends on turn ends (materialisation at turn end); an answer reaches a running Worker when its turn ends, as today.
- Agents created before this release keep the old instructions; they are detected and offered replacement (PRD §11).

## Alternatives considered

- **Keep text relays and add deduplication** — rejected: every relay is another place to drift; patches accumulate (F1–F7).
- **Give every agent a side-effecting tool that knows its caller** (per-agent secret paths) — possible later; materialising from recorded blocks needs no caller identity and keeps ADR-010 intact.
- **Let the plugin answer from the recommendation automatically** — that is calibrated autonomy, decided per class in [ADR-018](ADR-018-calibrated-autonomy-per-class.md), not a default.
