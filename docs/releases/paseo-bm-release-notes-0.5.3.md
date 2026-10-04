# paseo-bm 0.5.3

**Agents decide the content; the plugin now carries it reliably.** This release moves Worker and Reviewer creation, delivery, question handling, review budgets and request identity onto caller-bound plugin tools, while preserving the hand-written path for providers that cannot pre-approve MCP tools. Update with:

```bash
paseo plugin update paseo-bm
```

## What changed

- **Reliable agent orchestration.** Managers create Workers through `bm_create_worker`; Workers create and re-run Reviewers through budget-aware tools; reports, questions, answers, findings and handoffs are stored before the plugin delivers them to the right agent at a safe turn boundary. A plugin reload re-enqueues pending delivery instead of losing it.
- **One request identity and message-origin rule.** The plugin assigns request ids, binds created agents to their role and parent, and consistently distinguishes owner messages, plugin notices, plugin prompts and agent relays. Quoted `BM-*` text remains data, not authority.
- **Review budgets are enforced.** Review calls share one counter across tool-created and off-tool Reviewers. Calls past the configured ceiling are refused unless the owner explicitly grants more; cancelled or failed Reviewer creation does not make finished work look blocked.
- **Provider compatibility stays intact.** Claude, Codex and OpenCode agents use caller-bound tools. Providers that cannot pre-approve exact MCP tools stay on the compatible hand path; the plugin relays their valid blocks at turn end and reports malformed ones.
- **Safer role behaviour.** The Worker distinguishes `stopped` from `finished`, preserves the owner's request verbatim in handoffs, reads owner precedents before asking again and treats requested scope as authoritative. `AskUserQuestion` is denied for paseo-bm roles so owner decisions stay in the plugin's recorded decision flow.
- **More useful Worker tabs.** Plugin-created Workers and handoff successors use a concise, secret-redacted title derived from the owner's request while retaining the Worker marker and colour.
- **Readable request cards.** A plugin-created agent's `BM-BRIEF` first prompt renders as a Request card instead of raw protocol text.
- **Honest missing-tool handling.** The Orchestrator must try a named tool in the current turn before reporting it unavailable; validation and policy errors are handled as real tool results rather than mistaken for missing tooling.
- **Smaller, clearer agent instructions.** Role prompts now describe judgement and safety rules while their schema-backed tools own formatting, recipients, timing and state. The plugin rejects invalid tool input without manufacturing a successful-looking result.

## What to know when upgrading

- Existing Managers, Workers and Reviewers continue to work on the hand path. Newly created role agents receive caller-bound tools when their provider supports exact MCP pre-approval.
- Existing plugin data and settings remain in place. This release adds internal request, binding, outbox and review records under the existing data home; no user migration is required.
- If a role agent was created before 0.5.3, replace it through the normal paseo-bm fallback or handoff flow to receive the new bound tool path and current instructions.

## Rollback

`paseo plugin update paseo-bm --version 0.5.2`. Data added by 0.5.3 remains in the paseo-bm data folder and is ignored by 0.5.2; do not delete it if you plan to return to 0.5.3.

## Evidence

- The ADR-027 acceptance run exercised bound delivery, questions and answers, review-budget refusal and grant, off-tool Reviewer accounting, quoted-command safety, unknown-token fallback, cancellation and handoff on an isolated Paseo 0.10.2 daemon.
- The semantic Worker-title change was verified on a live plugin-created Worker: `🔵 W · Runtime test: verify meaningful Worker title`.
- The Orchestrator missing-tool correction was verified with a fresh agent that called the named tool and handled its actual result.
- The prospective release tree passed `npm run verify` (5,161 default tests, 3 benchmark tests and 134 evaluation tests) and `npm run smoke:packed`; the packed plugin contains exactly six files and stays under paseo.cafe's 2,000,000-byte entry limit.
- The release workflow independently verifies the tagged tree on Linux and macOS, smoke-tests the packed package, and checks the published payload before the release completes.

## Sources

[ADR-027](https://github.com/hieunt286/paseo-bm/blob/v0.5.3/docs/adr/ADR-027-agents-write-content-code-carries-it.md) · [Technical Design](https://github.com/hieunt286/paseo-bm/blob/v0.5.3/docs/design/paseo-bm.md) §7.4, §7.14–§7.16 · [ADR-027 acceptance run](https://github.com/hieunt286/paseo-bm/blob/v0.5.3/docs/archive/operations/paseo-bm-agent-tools-acceptance-20261003.md) · [0.5.2 notes](https://github.com/hieunt286/paseo-bm/releases/tag/v0.5.2)
