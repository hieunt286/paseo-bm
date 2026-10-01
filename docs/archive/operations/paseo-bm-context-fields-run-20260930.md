# Run note — which providers report context, and what a compaction looks like, 2026-09-30

| Field | Value |
|---|---|
| Bead | `bm-autonomy-phase2-t9lm.21` (WP-209), with change-007 C6 |
| Requirement / design | PRD REQ-126, autonomy design §G.2 |
| Paseo | CLI and daemon 0.9.2 |
| Daemon | isolated, `scripts/manual-test/start-daemon.sh` on port **6911** (6899 was held by another session's test daemon, left alone), home and data folder under the session scratchpad. The owner's `~/.paseo`, `~/.paseo-bm` and port 6767 were not touched: the SHA-256 of `~/.paseo/config.json` was the same before and after |
| Plugin | this branch's `plugin/`, installed from the folder, then reloaded once with the final collector (`paseo plugin reload`) |
| Agents | created directly with `create-agent.mjs`, three shell calls each (`ls`, `cat package.json`, `git log --oneline`), then a `/compact` message sent like the app: `bm-worker` on Claude (`claude-haiku-4-5`), `bm-reviewer` on Codex (`gpt-5.6-luna`), `bm-manager` on OpenCode (`opencode/big-pickle`). OpenCode with `anthropic/claude-haiku-4-5` failed before any model call (`Model not found: anthropic/claude-haiku-4-5. Did you mean: claude-haiku-4-5 …`), for a plain `opencode` agent as well, so it is an OpenCode model-id matter on this machine, not the plugin's |
| Read with | the records the plugin's collector wrote (`<data>/traces/<ws>/events-202609.jsonl`), and each agent's `timeline.refetch` payload (entries and the `agent` snapshot's `lastUsage`) |

## 1. Which providers report the context fields

**All three, at every turn end** (`lastUsage` of the snapshot right after the turn):

| Provider | Turn | `inputTokens` / `cachedInputTokens` / `outputTokens` | `contextWindowUsedTokens` | `contextWindowMaxTokens` | Record `usage` |
|---|---|---|---|---|---|
| Claude | 3 shell calls | 34 / 88,287 / 423 | 29,826 | 200,000 | `contextUsed` 29,826, `contextMax` 200,000 |
| Claude | `/compact` | 0 / 0 / 0 | 2,381 | 200,000 | `contextUsed` 2,381 |
| Codex | 3 shell calls | 21,573 / 21,248 / 5 | 21,578 | 258,400 | `contextUsed` 21,578, `contextMax` 258,400 |
| Codex | `/compact` | 0 / 0 / 0 | 4,775 | 258,400 | `contextUsed` 4,775 |
| OpenCode | 3 shell calls | 35 / 21,853 / 3 | 21,891 | 200,000 | `contextUsed` 21,891, `contextMax` 200,000 |
| OpenCode | `/compact` | 35 / 21,853 / 3 (unchanged) | 21,891 (unchanged) | 200,000 | the same as the turn before |

The daemon source agrees: Claude (`ClaudeContextUsageState`), Codex (`toAgentUsage`: `last.total_tokens`, `model_context_window`) and OpenCode (`mergeOpenCodeStepFinishUsage`) all set both fields. The agent manager replaces `lastUsage` on each `usage_updated` event and merges the turn's final usage into it. Pi and Oh My Pi have usage pollers that set them too; they were not run.

The field observation of the same day, a Claude Manager whose snapshot showed only tokens and cost, did not reproduce here. The first field records written by this build will show whether it holds on the owner's machine.

## 2. What a compaction looks like

Every provider shows **two** timeline items per compaction: a `loading` item, then a `completed` item. The timeline keeps both; nothing merges them (compaction items have no identity in the projection).

| Provider | Items of the turn | Turn id |
|---|---|---|
| Claude | `user_message "/compact"`, `{ type: "compaction", status: "loading" }`, `{ type: "compaction", status: "completed", trigger: "manual", preTokens: 29827 }` | `foreground-turn-2` |
| Codex | `{ …, status: "loading", trigger: "manual" }`, `{ …, status: "completed", trigger: "manual" }` | `autonomous-…`: a turn of its own; the `/compact` user message carries no turn id |
| OpenCode | `user_message "/compact"`, `{ …, status: "loading", trigger: "manual" }`, `{ …, status: "completed" }` | `opencode-turn-1` |

Recorded evidence, one per compaction: Claude `{ kind: "compaction", detail: "manual", trigger: "manual", preTokens: 29827 }`; Codex and OpenCode `{ …, trigger: "manual", preTokens: null }`. OpenCode's trigger comes from its loading item. `preTokens` 29,827 matches Claude's context before (29,826), and its context after was 2,381. An automatic compaction was not provoked (it needs a context near the window).

## 3. Tool calls

Each three-call turn was recorded with `toolCalls: 3` (Claude `Bash`, Codex `shell`, OpenCode `bash`), and each `/compact` turn with `toolCalls: 0`. The Claude turn read 88,321 tokens over its 4 model calls. That is about 22,000 per call against a reported context of 29,826, so the §G.2 estimate lands in the right range when no context is reported.

## 4. Finding: what the token counts cover is not the same across providers

- **Claude**: `lastUsage` tokens are the **sum over the turn's model calls** (88,287 cached over 4 calls, each with about 22,000 of context).
- **Codex**: the **last model call only**. 21,573 input for a 4-call turn whose context is 21,578, and `contextWindowUsedTokens` = input + output of that call; the daemon maps Codex's `tokenUsage.last`. Its `cachedInputTokens` (21,248) is **part of** `inputTokens` (21,573), as in OpenAI's usage.
- **OpenCode**: the **last model call only** (`mergeOpenCodeStepFinishUsage` assigns each step's counts). Cached is separate from input (35 + 21,853 + 3 = 21,891 = the context).
- A turn with **no model call** keeps the previous `lastUsage` on OpenCode: its `/compact` turn record repeats the turn before's tokens. Claude and Codex report 0 for their compaction turns; the compaction's own model call is not in the turn's usage.

So "tokens read per turn = input + cached" (§G.2 Derived) holds for Claude only. For Codex it counts the cached tokens twice and one call; for OpenCode it covers one call; and the Codex and OpenCode per-request totals the collector has recorded so far undercount multi-call turns. `contextUsed` means the same thing on all three: the context of the turn's last call. How the figures treat this is left to bead `t9lm.26`.

## 5. The Orchestrator's tokens (change-007 C6)

Not run live: it needs an Autopilot wake from a real event. The path it uses was checked here. A `timeline.refetch({ direction: "tail", limit: 1 })` on the Claude agent returned one entry and the full snapshot with `lastUsage`. The event bus reads it at the turn end that closes a wake. The unit tests cover the rest (`test/event-bus.test.ts`, `test/orchestrator-store.test.ts`).

## 6. Clean-up and cost

The test daemon was stopped with `scripts/manual-test/stop-daemon.sh`; no process of its home remained. The agents, the demo repository and the daemon home stay in the session scratchpad only. Provider tokens spent: about 90,000 cached-read and 1,000 other tokens on Claude Haiku, about 22,000 on Codex, and about 45,000 on OpenCode's free model.
