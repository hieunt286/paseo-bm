# Report — How role instructions reach each model, and whether they need optimising per model

| Field | Value |
|---|---|
| ID | `research-20260918-instructions-by-model` |
| Request | `req-20260918T011706Z` (part 3 of the request) |
| Bead | `bm-wp-248-uxpe` |
| Design | [design-delta-20260918](paseo-bm-delta-20260918-manager-mode-model-metrics.md) §4.5 (questions R1–R6, source rule) |
| Scope | Claude Code / `claude-opus-5` (Manager, Worker); Codex / `gpt-5.6-sol` (Reviewer); one paragraph on OpenCode (Q35) |
| Nature | **Investigation only.** No change to `plugin/roles/*.md` (Q33). Every suggestion in §7 is for the owner to decide, as a new request |
| Date | 2026-09-18 — author: Beads Worker (`claude-opus-5`) |

Source notation: **[B]** the installed Paseo 0.8 bundle (`/Applications/Paseo.app/Contents/Resources/app.asar`, package `@getpaseo/server/dist/server/server/agent/…`), with line numbers; **[T]** the trace store `~/.paseo-bm/traces`; **[S]** agent snapshots read with `get_agent_status`; **[D]** the vendors' public documentation, read on 2026-09-18 (list in §8); **[Q]** direct observation of the context of the very Worker writing this report. Whatever is **inferred** is marked as such.

## 0. Short conclusion

1. **The three providers load role instructions by three different paths** (§2): Claude appends them to the **end** of Claude Code's built-in system prompt; Codex passes them as **developer instructions**; OpenCode puts them in the `system` field. On both Claude and Codex, the role instructions sit in a position of **higher authority** than the repository's instruction file (`CLAUDE.md`/`AGENTS.md` enters the conversation as the user's words).
2. **There is no need to split the instruction text per model at this point.** Across 504 recorded turns, both models honour the format contract almost perfectly: 61/61 Reviewer turns (`gpt-5.6-sol`) end with a `BM-REVIEW` block with all 7 fields; 131 `BM-REPORT`s from the Worker (`claude-opus-5`) miss no field (§5). Every anomaly found comes from **instruction layers conflicting with each other** or from an old prompt version, not from the model.
3. **What needs optimising is where the instruction layers overlap, and that differs per provider** (§6). Two conflicts have real evidence: (a) Claude Code's preset teaches the agent to **write memory to `~/.claude/projects/…/memory`**, against the limit "do not write outside the workspace" — 3 real writes; (b) the Worker's assignment message allows the Reviewer to run `npm run build`, while `reviewer.md` only allows running tests and lint/typecheck that write no files — the Reviewer followed the message, 8 build commands in 7 turns.
4. **Six ordered suggestions in §7**: two wording fixes shared by every model, one configuration tweak specific to the Reviewer (thinking level), and three jobs that should only be done after measuring.

**Limits of the data:** each role ran only **one** model (Manager and Worker always `claude-opus-5`, Reviewer always `gpt-5.6-sol`), so the numbers **cannot separate** the effect of the model from the effect of the role. Separating them would need a run with swapped models on the same fixture — out of scope for this request (Q33 did not choose (c)).

## 1. Questions and method

| # | Question (design §4.5) | Main source |
|---|---|---|
| R1 | Where the role instructions sit in the context | [B], [S], [D], [Q] |
| R2 | How much they take up, what comes after them | character count on the files; [S] |
| R3 | What each model family's official guidance says | [D] |
| R4 | On the existing traces, how far each model actually follows them | [T], run records in `docs/operations/` |
| R5 | Which traits of the three role files act differently per model | cross-check of R1–R4 |
| R6 | Is per-model optimisation needed; suggestions | synthesis |

Measurement on the traces: read every `events-*.jsonl`, deduplicate by `(agentId, turnId, turn content)`, classify shell commands with exactly the plugin's rule (`shell.ts`: split on `&& || ; |`, strip the quoted parts before comparing command names). The script lived in a `mktemp -d` folder and was deleted when done.

## 2. R1 — By which path the role instructions reach each provider

| | Claude Code (`claude-opus-5`) | Codex (`gpt-5.6-sol`) | OpenCode |
|---|---|---|---|
| Paseo sends the role instructions into | `systemPrompt: { type: "preset", preset: "claude_code", append: <role + the daemon's appended part> }` — [B] `providers/claude/agent.js` 2588–2590, 2633–2638 | `developerInstructions` when opening a thread, when resuming a thread and on every turn — [B] `codex-app-server-agent.js` 2879–2881, 3013–3015, 3947–3958; with a collaboration mode, `developer_instructions = <the mode's instructions> + <role> + <daemon part>` — 2716–2718 | the `system` field — [B] `opencode-agent.js` 2511–2522, 2788–2803 |
| Message role | **system**, placed **after** the whole Claude Code preset | **developer**, after the model's base instructions (Codex keeps them itself, the plugin cannot see them) and after the collaboration mode's instructions (the Reviewer of batch b1 ran mode `Default` — [S]) | system |
| What comes after | the daemon's `appendSystemPrompt` — empty unless the user sets it in the daemon config ([B] `bootstrap.js`, `agent-manager.js` 377, 3606–3615) | as the left column, the same string | as the left column |
| The repository's instruction file | `CLAUDE.md` (a symlink to `AGENTS.md` in this repository) is **injected into the conversation as project context, not into the system prompt**; Paseo enables all three sources `user`, `project`, `local` ([B] 38–42; [D] Anthropic "Modifying system prompts") | each `AGENTS.md` found becomes **one user-role message** starting with `# AGENTS.md instructions for <folder>` ([D] OpenAI "Codex Prompting Guide") | not checked |
| What the preset brings along | tools, safety, environment, **and Claude Code's own instructions**: the "# Memory" section telling the agent to write memory itself to `~/.claude/projects/<repo>/memory/`, the `AskUserQuestion` question tool, commit and PR rules — [Q]: all of it is in this very Worker's system prompt, **before** the role instructions | Codex's base instructions and the collaboration mode's (not readable from the plugin) | not checked |
| Changing instructions mid-session | Claude Code **records the system prompt at the first request** and reuses it until the session is compacted ([D] Anthropic) — editing a role file only reaches **new** agents | Paseo resends `developerInstructions` every turn, but the value is the `config.systemPrompt` fixed when the agent was created — in practice it also only reaches new agents | — |

**Consequence for authority.** Anthropic states it plainly: "Instructions in the user message carry marginally less weight than the same text in the system prompt" [D]. Codex places `AGENTS.md` in the user role, below developer. So when the role file and the repository's file contradict each other, **on both providers the role file wins by position**. But winning by position does not mean the model is spared the effort of reconciling them: with GPT-5, "poorly-constructed prompts containing contradictory or vague instructions can be more damaging to GPT-5 than to other models, as it expends reasoning tokens searching for a way to reconcile the contradictions" [D].

**The only real difference in the loading path:** on Claude, the role instructions must **live alongside a large preset written for a different scenario** — a person sitting and watching, approving each step. Anthropic itself says the preset assumes "a human is in the loop with access to a full toolset", and that for "an agent [that] runs autonomously without a human approving each step" a custom prompt should be considered [D]. paseo-bm **cannot choose** that: Paseo fixes preset + `append` [B 2633–2638]. Codex has no equivalent layer that the plugin can see.

## 3. R2 — Size and position

| | Characters | Estimated tokens (characters ÷ 4) | UPPER-CASE phrases | `NEVER` | Tables (rows) | Example blocks |
|---|---|---|---|---|---|---|
| `manager.md` | 9,104 | ~2,300 | 7 | 3 | 0 | 0 |
| `worker.md` | 21,220 | ~5,300 | 8 | 4 | 15 | 3 |
| `reviewer.md` | 7,494 | ~1,900 | 11 | 1 | 0 | 3 |
| This repository's `AGENTS.md` (as an example repository file) | 15,427 | ~3,900 | 0 | 0 | 9 | 3 |

The ÷ 4 estimate is rough and lower than reality for Vietnamese text; use it only for relative comparison.

- **The context windows differ fourfold:** the Worker on Claude has 1,000,000 tokens ([S] `contextWindowMaxTokens`); the Reviewer on Codex has 258,400. The batch b1 Reviewer of this request used **110,940 tokens on its very first turn (43%)** [S] — inferred: mostly the project files and skills it read, since `reviewer.md` is only ~1,900 tokens.
- **The size of Claude Code's preset cannot be measured from the plugin** (inferred: larger than all three role files combined, since it carries all the tool and environment guidance). The role instructions are therefore the **tail** of a long system prompt — a position Anthropic says Opus 5 still handles well: "its instruction following, tool calling, and reasoning stay consistent throughout the window" [D].

## 4. R3 — What the official guidance says

| Topic | Anthropic — Claude Opus 5 | OpenAI — GPT-5.x / Codex |
|---|---|---|
| Emphasis, absolute wording | New models are "more responsive to the system prompt… may now overtrigger. The fix is to dial back any aggressive language. Where you might have said 'CRITICAL: You MUST use this tool when…', you can use more normal prompting" | GPT-5: "Be THOROUGH" was once needed for older models but is "counterproductive with GPT-5, which is already naturally introspective and proactive" (the Cursor example) |
| Explaining the reason | "Providing context or motivation behind your instructions… 'NEVER use ellipses' [worse than a sentence with a reason]… Claude is smart enough to generalize from the explanation" | (no equivalent sentence in the pages read for GPT-5.x) |
| Contradictions between instructions | no dedicated section | "contradictory or vague instructions can be more damaging to GPT-5… expends reasoning tokens searching for a way to reconcile" |
| Say what to do rather than what is forbidden | "Tell Claude what to do instead of what not to do"; "Positive examples… more effective than instructions about what not to do" | GPT-5.2 uses both forms; prefers concrete constraints ("Implement EXACTLY and ONLY what the user requests") |
| Examples | "one of the most reliable ways to steer… Include 3–5 examples", wrapped in `<example>` | fixed format: "Always follow this schema exactly (no extra fields)" |
| Scope | Opus 5 "can also expand the scope of a task… constrain scope explicitly" | GPT-5.2: "No extra features… If any instruction is ambiguous, choose the simplest valid interpretation" |
| Self-checking | Opus 5 checks itself; "If your prompt contains explicit verification instructions… remove them: instructions like these cause over-verification" | (the article for GPT-6 Astra — a model **not** used here — says the new model runs tests by itself; does not apply to 5.6) |
| Sub-agents | Opus 5 "delegates to subagents more readily"; the `claude_code` preset adds a delegation instruction by itself on Opus 5 | GPT-5.6 "multi-agent behavior is very steerable" (search result summary; the original page returns 403, lower confidence) |
| Thinking/effort level | default `high`; lower to `low`/`medium` when quality holds | Codex: "'medium'… good all-around… `high` or `xhigh` for your hardest tasks"; GPT-5.6 Sol at `low` "outperforming GPT-5.5 at high" (search summary, as above) |
| Structure | XML tags help separate instructions / context / examples | no warning at all about Markdown in instructions |

None of the OpenAI pages read is a dedicated "prompting guide for GPT-5.6"; the "Model guidance" page is currently written for GPT-6 Astra and mentions 5.6 Sol only for comparison. The conclusions about GPT in this report therefore rest on the GPT-5 / 5.2 / Codex guidance — **inferred** to still hold for 5.6.

## 5. R4 — On the traces, how far each model actually follows them

Data [T]: **504** turns after deduplication, 7 workspaces, 2026-09-16 → 2026-09-18. Manager `claude-opus-5` 244 turns / 9 agents; Worker `claude-opus-5` 199 turns / 24 agents; Reviewer `gpt-5.6-sol` 61 turns / 37 agents. The set of role files changed once in this period (rewritten on 2026-09-17, delta 20260917c).

| Measure | Reviewer — `gpt-5.6-sol` | Worker / Manager — `claude-opus-5` |
|---|---|---|
| Fixed result block | **61/61** completed turns end with its own `BM-REVIEW`, **0** blocks missing one of the 7 fields; verdict exactly `pass`/`changes-required` in 59/61 — 2 blocks merged two batches into one answer, both on 09-16 | **131** `BM-REPORT`s, **0** missing fields; 3 reports added unknown fields on their own (`beadsDeferred`, `beadsBlocked`) |
| Limit "read-only" (Reviewer) / "do not write outside the workspace" | **0** files written; but **8** `npm run build`/`verify` commands in 7 turns (3 workspaces, 09-17 → 09-18) — a build writes files to the build folder. In 6/7 turns, **the Worker's assignment message allowed it outright** ("You may run `npm run build`…"); the two demo repositories have no `AGENTS.md` at all | **3** files written to `~/.claude/projects/<repo>/memory/` (Manager 2, Worker 1, same workspace, 09-16); the other 35 writes outside the workspace are all inside permitted `mktemp` folders |
| Commands that need asking first (git writes, installing dependencies, network) | 0 | Worker: 14 git write commands, 23 dependency install commands, 34 network commands. **The trace does not say which commands the user had allowed** (for example the README release beads where the owner asked for a commit), so this is a number to check by hand, **not** a count of violations. The most recent acceptance run checked by hand (run record 20260917c §4) found only one deviation: a write to `/tmp` outside the `mktemp` folder |
| Output tokens per turn | 655 | Worker 14,174; Manager 996 |

**Two numbers that look like model errors but actually are not:**

- **8 odd verdicts** such as `approved | changes-required` that the reader recorded for the Reviewer on 09-16 **were not written by the Reviewer**: the reader picked them up from **the Worker's review request message**, back when the Worker still pasted its own `BM-REVIEW` template (with `verdict: approved | changes-required`). The Reviewer's own block in the same turn says `verdict: pass`. The 09-17 rewrite added the sentence "Do not paste the `BM-REVIEW` format" to `worker.md`; since then there has been no such case. → An error of **the Worker with the old prompt**, plus a weakness of the reader (it reads outgoing messages too).
- **27/67 reviews have no `blockingCount`**: records written before the reader knew how to count `severity: blocking` lines (comment in `plugin/server/bm-report.ts` 390–399). A limit of the collector, not of the model.

## 6. R5 — Which traits of the three role files act differently per model

| # | Trait | Claude (preset + append) | Codex (developer) | Evidence |
|---|---|---|---|---|
| 1 | **The limit "do not write outside the workspace" meets the preset's memory instruction** | The preset tells the agent to write memory to `~/.claude/projects/…`; `worker.md` rule 1 and `manager.md` do not mention that folder. Both instructions are in the system prompt, the preset comes first | No corresponding feature | 3 real writes in §5; [Q] the "# Memory" section is in this very Worker's system prompt |
| 2 | **The Reviewer's "what it may run" meets the Worker's assignment message** | The author of the message is the Worker on Claude: it grants extra permissions itself that `worker.md` does not say it may grant | `reviewer.md` (developer) only allows running tests and lint/typecheck that write no files; the Worker's message (user) allows running `npm run build`. The two layers say different things — exactly the kind of contradiction OpenAI warns about — and the Reviewer follows the more specific layer | 6/7 build turns in §5 have an allowing sentence in the message. `reviewer.md` already handles conflicts with a **skill** ("when a skill says to edit something, report it as a finding"), but does not yet say whether an assignment message may **loosen** the command list |
| 3 | **UPPER-CASE phrases in the RULES section** (7 / 8 / 11 phrases) | Anthropic advises toning down because new models "overtrigger" | GPT-5 follows with "surgical precision"; upper case has no separately recorded effect | Overtriggering could not be measured: 48/131 reports are `blocked`, but the Large tier **requires** two rounds of questions — no conclusion that the questions were unnecessary |
| 4 | **Dense self-verification guidance** (evidence for each bead, negative controls) | Opus 5: "check again" instructions cause over-verification. But the requirement here is **evidence** for others to read, not "check yourself again" | — | Run record 20260917c: the Worker built its own copy and ran end-to-end, judged "real verification", not waste |
| 5 | **Sub-agents** | `worker.md` only forbids parallel sub-agents during implementation; the preset adds a delegation instruction by itself on Opus 5 | The Reviewer may not create agents | The Worker called the provider's sub-agents 24 times [T]; no separate cost figure to conclude from |
| 6 | **Fixed block templates with an `a \| b` choice** | The Worker keeps exactly to the `BM-REPORT` template | The Reviewer keeps exactly to the template, does not copy `pass \| changes-required` verbatim | §5 |
| 7 | **Examples** (a sample bead, a sample question, a blocking/non-blocking calibration pair) | In line with Anthropic's direction | In line with OpenAI's direction | — |

## 7. R6 — Conclusion and ordered suggestions

**Answer to the owner's question:** the algorithm that loads the instructions **does** differ per provider (§2), but that difference has **not yet** made any model break the contract (§5). What needs optimising is **not a separate writing style for each model**, but **the places where another instruction layer — the tool's preset, or another agent's assignment message — argues with the role file**. Those places differ per provider, but they can be fixed with **one shared text** for every model.

| # | Suggestion | Kind | Impact | Cost | Risk | Measured by |
|---|---|---|---|---|---|---|
| 1 | In the limit "do not write outside the workspace" of `worker.md` and the limits section of `manager.md`, name **the tool's memory folder**: when a tool invites writing memory, that is still writing outside the workspace. One sentence, merged into the existing limit — no new limit (in the style the owner chose in delta 20260917c) | One text for every model | Medium: blocks a real deviation on Claude; harmless on Codex | Very low | Low | Number of file writes outside the workspace, not `mktemp`, per role → 0 in the next run |
| 2 | Make `worker.md` and `reviewer.md` **say the same sentence** about the repository's build/verify command: either `reviewer.md` allows it explicitly ("the repository's own build or verify command"), or both say an assignment message cannot loosen the Reviewer's command list. **The owner decides** whether to allow it: a build only writes to a build folder that git ignores, but it is still a write | One text for every model | Medium: removes a contradiction between two layers that makes GPT spend reasoning tokens, and a deviation from the read-only rule | Very low | Low | Number of times the Reviewer runs a build; tokens per review turn |
| 3 | Set the **thinking level** for the `bm-reviewer` profile instead of letting Codex choose — currently `xhigh` although paseo-bm does not set it [S]. Try `high` then `medium` on the same fixture | Provider-specific configuration | Possibly large for the Reviewer's time and money | Low (the Setup screen already has a thinking field) | Medium: may catch fewer errors | Number of blocking items found, tokens, time on the same fixture |
| 4 | **Tone down** the UPPER-CASE phrases in the RULES section into normal sentences with a reason. **Only as a measured trial**, not blindly: the 20260917c measurement run with the current version is the only run without a blocking error | One text for every model | Unknown | Low | Medium: may loosen a guardrail that is working well | Compare one run on the 20260917c fixture |
| 5 | Add one sentence to `worker.md` about **when to use sub-agents** (large, independent, parallel work), as Anthropic suggests for Opus 5 | One text; the effect is mainly on Claude | Unknown | Very low | Low | Number of the provider's sub-agents and Worker cost per request |
| 6 | Record in the operations documentation: **editing a role file only takes effect for agents created after that** (Claude records the system prompt at the first request; Codex uses the value fixed at creation) | No wording change | Avoids measuring the wrong thing after an edit | None | None | — |

**Not suggested:** splitting `plugin/roles/*.md` into per-provider variants. Reasons: (1) there is no evidence that any model fails because of writing style; (2) each role runs only one model, so there is no data yet to optimise separately; (3) two versions means twice the files to keep in sync, twice the content tests, and the `before("agent.create")` hook would have to pick the version by base provider. If the owner still wants to go this way, the right first step is **a run with swapped models** — the Reviewer on Claude and the Worker on GPT on the same fixture — to get numbers that separate the model from the role.

**OpenCode.** Paseo puts the role instructions in OpenCode's `system` field [B 2511–2522]. The project has not run any role on OpenCode yet, so there are no traces and no conclusions. Suggestions 1 and 2 are written for every model, so they still apply if OpenCode is used later.

## 8. Sources

Public documentation, read on 2026-09-18:

- Anthropic — [Prompting Claude Opus 5](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-opus-5)
- Anthropic — [Prompting best practices](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices) (sections *Add context to improve performance*, *Control the format of responses*, *Tool usage*, *Subagent orchestration*, *Migration considerations*)
- Anthropic — [Modifying system prompts (Agent SDK)](https://code.claude.com/docs/en/agent-sdk/modifying-system-prompts)
- OpenAI — [GPT-5 prompting guide](https://developers.openai.com/cookbook/examples/gpt-5/gpt-5_prompting_guide)
- OpenAI — [GPT-5.2 Prompting Guide](https://developers.openai.com/cookbook/examples/gpt-5/gpt-5-2_prompting_guide)
- OpenAI — [Codex Prompting Guide](https://developers.openai.com/cookbook/examples/gpt-5/codex_prompting_guide)
- OpenAI — [Model guidance](https://developers.openai.com/api/docs/guides/latest-model) (written for GPT-6 Astra; mentions GPT-5.6 Sol)
- OpenAI — [Rethinking skills and prompts for GPT-6 Astra](https://developers.openai.com/blog/rethinking-skills-and-prompts-for-gpt-6-astra) (a model not used here; for comparison only)
- OpenAI — [The builder's guide to GPT-5.6](https://openai.com/index/builders-guide-to-gpt-5-6/): the page returns **403**; the two points quoted in §4 come from the search result summary, lower confidence

Local sources:

- Paseo 0.8 bundle — `server/agent/providers/claude/agent.js` 38–42, 2588–2590, 2633–2638; `server/agent/providers/codex-app-server-agent.js` 2716–2718, 2879–2881, 3013–3015, 3947–3958; `server/agent/providers/opencode-agent.js` 2511–2522, 2788–2803; `server/agent/agent-manager.js` 377, 3606–3615; `server/bootstrap.js` (`appendSystemPrompt`)
- Snapshots: Worker `29e658b5` (`claude-opus-5`, window 1,000,000); Reviewer `2998dc82` (`gpt-5.6-sol`, effective thinking `xhigh`, mode `auto`, collaboration mode `Default`, window 258,400, 110,940 tokens on the first turn)
- Trace store `~/.paseo-bm/traces/*/events-202609.jsonl` (504 turns, 7 workspaces)
- `plugin/roles/{manager,worker,reviewer}.md` current version; `git show 1f7f034:plugin/roles/worker.md` (the 09-15 version, which allowed adding the phases `documents-done` and `bead-implemented`); `plugin/server/bm-report.ts` 390–399
- `docs/archive/operations/paseo-bm-context-engineering-run-20260917c.md` §2, §4, §5
