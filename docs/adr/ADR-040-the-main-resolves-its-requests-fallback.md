# ADR-040 — The Main resolves its requests' delegated provider fallback

| Field | Value |
|---|---|
| Status | **Accepted** (2026-10-26) — owner: “Tôi muốn Main tự nhận ra và thực hiện đồng ý fallback thay vì phải đợi confirm” |
| Date | 2026-10-26 |
| Owner | hieu.nt10 |
| Amends | [ADR-033](ADR-033-the-mission-is-the-system-of-record.md) decision 3: delegated request-scoped fallback belongs to the mission's Main |
| Keeps | One authority resolver; owner overrides; configured fallback chains; existing switch/wait checks, workspace placement and first-answer semantics |
| Related | Missions PRD REQ-204; mission runtime design §4.1, §4.4, §4.5; base design §7.9; bead `bm-fuud` (canonical Routing Decision) |

## Context

AIX's two requests created at 14:42 UTC received their complete briefs in the correct workspaces,
but Claude immediately returned its weekly limit. Detection recorded pending incidents with Codex
candidates. Both repositories and the mission delegated the relevant authority. The resolver named
the Orchestrator, while the fallback-open callback published no wake and decision-opened events were
retired as wakes. Neither request progressed; the mission page still called both working.

The Main owns the requests and has their goal's context. It should resolve their configured provider
recovery instead of asking the owner to repeat an existing delegation.

## Decision

1. An `f:` incident of a mission request belongs to its current Main when the repo delegates its
   class, or the mission delegates `answer-effects` and a recovery option settles without effects.
   The authority resolver preserves owner-only, prepared-change and unverified-finish guards.
   A Main's own incident has no request and keeps its existing Orchestrator/owner authority.
2. `bm_answer_fallback { decisionId, option, why }` is a bound Main's tool. It accepts only an open
   fallback of that Main's mission, named for the Main by the resolver, and an offered recovery
   option. It records `by: main`, `via: main`, with no grant, then runs the existing fallback
   settlement. A stale Main, another mission, a settled decision or invalid option writes nothing.
3. New incidents reach the Main through its durable outbox/channel with their full decision id,
   offered options and the instruction to act without another confirmation. Pending incidents are
   reconciled once a plugin run has a Paseo handle. An existing non-dropped notification is reused;
   the outbox resends pending deliveries after reload. First-answer and fallback locks prevent
   duplicate replacements even if a notice is delivered twice.
4. An unresolved fallback makes its mission row blocked. The owner retains the decision card and
   may answer first. Replacement creation and its brief resolve the current Main again, even when the incident predates
   a handoff. The Main uses the configured candidate, keeps following the replacement, and
   reports an unavailable or failed recovery instead of creating another Worker itself.

## Compatibility, proof and containment

The new tool and Main fallback answers extend existing contracts; no store migration or dependency
is needed. Existing question tools and non-mission fallback keep their contracts. The Orchestrator
refuses an incident now assigned to a Main. Rollback restores the previous bundle; stored Main
answers already use the existing answer schema and delivery path.

Proof covers authority and negative cases, durable notification/reload reconciliation, Main answer
through real fallback settlement, exactly one replacement with the request/workspace retained, and
mission blocked state. Run type checks, lint, product tests and build. Local rollout backs up the
installed bundle and reloads only the plugin; no daemon restart, profile change or publication.
