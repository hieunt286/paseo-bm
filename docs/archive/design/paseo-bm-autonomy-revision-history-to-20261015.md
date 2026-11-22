# paseo-bm — Calibrated autonomy (Technical Design, Phases 1–6) — Revision History from 2026-10-02 to 2026-10-15

Moved verbatim out of [paseo-bm-autonomy.md](../../design/paseo-bm-autonomy.md) on 2026-11-16, during the documentation review; links were only re-pointed. Earlier rows are in [paseo-bm-autonomy-revision-history-to-20261002.md](paseo-bm-autonomy-revision-history-to-20261002.md). A historical record: never edited. Git holds the full audit trail.

| Date | Author | Change |
|---|---|---|
| 2026-10-05 | hieu.nt10 (owner request; written by Codex) | §B.2: Settings → Autonomy now selects its project from one dropdown-style picker on every layout. |
| 2026-10-02 | Claude (owner request) | Documentation restructure: earlier rows moved to the archive; stale, retired and duplicated content condensed to the current state (section numbers and REQ ids kept) |
| 2026-10-02 | hieu.nt10 (owner decision; written by Claude) | §B.8: `roles.instructions` returns as a read-only view (base PRD REQ-032 d); `roles.save-extra` and the editor stay retired |
| 2026-10-03 | hieu.nt10 (owner decision; written by Claude) | Pointer lines in §A.5, §A.6, §A.11 and §G.6 to base design §16, the design of ADR-027 |
| 2026-10-03 | Claude (owner's delegation) | ADR-027 built (ship point C): the pointer lines in §A.5, §A.6, §A.11 and §G.6 now state what is built and point at base design §7.7, §7.15, §7.16 and §10 |
| 2026-10-03 | Claude (owner's delegation) | §D.2 *Answering*: Claude's `AskUserQuestion` is denied for every Manager, Worker and Reviewer, boundary on or off, with the role's channel — the one request answered outside the boundary's scope (ADR-027, amended 2026-10-03) |
| 2026-10-05 | hieu.nt10 (owner decisions; written by Codex) | §A.12 and DQ-3: live Inbox count on the sidebar; daily cached and manually refreshable npm version checks; update indicators on Settings and the sidebar; the version endpoint is the narrow network exception. |
| 2026-10-09 | Claude (owner's delegation) | ADR-028 as built: pointer lines in §A.3, §A.8, §B.5, §G.4 and §G.6 to base design §7.17.8 |
| 2026-10-09 | Claude (owner's delegation) | §F.1: files written by a shell command (redirection, `tee`) count as written, found in the missions governor acceptance run (missions design §17) |
| 2026-10-10 | Claude (owner's delegation) | Pointers: the retired wakes' helpers (`decisionsOpened`, the unverified-finish helpers) removed in the missions review (missions design §19) |
| 2026-10-10 | Claude (owner's decision) | `bm_predict` retired (missions design §19): a note where this document first names it |
| 2026-10-10 | Claude (owner's delegation) | §G.4/§G.7: the advice cadence retired (no wake since ADR-029; `mission.review` replaces it); the Coordination copy names paseo-bm and the Main (missions design §19) |
| 2026-10-10 | Claude (owner's request) | §A.8: a mission Worker's `danger` goes to its Main first and reaches the governor at any level; one `BM-EVENTS` message per mission (ADR-032, missions design §20) |
