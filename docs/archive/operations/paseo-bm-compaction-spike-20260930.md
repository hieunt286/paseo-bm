# Run note: compaction on request, per provider, 2026-09-30

| Field | Value |
|---|---|
| Bead | `bm-autonomy-phase3-7gxw.8` (plan WP-306) |
| Requirement / design | PRD REQ-134; autonomy design §G.5, §G.7 `compact.enabled`; ADR-021 decision 2 |
| Builds on | [the context-fields run](paseo-bm-context-fields-run-20260930.md). That run showed that a bare `/compact` starts a manual compaction on all three providers, with a `loading` then a `completed` `compaction` item. Its other findings: `preTokens` on Claude only, Codex compacting in an `autonomous-…` turn, and OpenCode repeating the counts from before. This run does not repeat those checks. It tests the focus, the time, the cost and how the message looks to the collector |
| Paseo | CLI and daemon 0.9.2; Claude Code 2.1.285, codex-cli 0.147.0, OpenCode 1.18.33 |
| Daemon | Isolated, started with `scripts/manual-test/start-daemon.sh` on port **6931** (6917 was held by another session's test daemon and was left alone). Its home, `PASEO_BM_HOME` and demo repository were in the session scratchpad. Supervisor pid 30792, worker pid 30793. Ran 14:19:54 to 14:26 UTC |
| Plugin | **Not installed.** The run needed only the send path. The kit's `send.mjs` sends as `paseo.agents.ref(id).send` does, with a message id, so the item carries `clientMessageId` (AGENTS.md). §5 reads the collector's classification from its code |
| Providers | All three are signed in on this machine and were run. Workspace `wks_e67f14b53331dcf5`, one agent per provider, created with `create-agent.mjs`: |
| | Claude `be847963-7251-4c1b-8b0e-a7a5b519c73a`, `claude-haiku-4-5`, mode `bypassPermissions` |
| | Codex `51043912-60ec-4503-94d0-ef488ca3f6a2`, `gpt-5.6-luna` (thinking `high`), mode `full-access` |
| | OpenCode `25f15bcb-02c3-42b5-9977-4d1fea6f2d18`, `opencode/big-pickle`, default mode |
| Read with | Each agent's `timeline.refetch` (entries, turn ids, timestamps and the snapshot's `lastUsage`). For the summaries, each provider's own local session record, read-only, as counts of known values only: Claude Code's session file (the `compact_boundary` metadata and the compact summary), Codex's session rollout (token counts, the compaction's replacement history) and OpenCode's database (messages and parts of this session). Also the daemon's provider code in the 0.9.2 app bundle. No credentials file was opened |

## Method

Each agent got the same three turns. The message texts stay out of this note.

1. **Build a context** (initial prompt, 255 characters). Run two commands of a scratch program, `node facts.mjs alpha` and `node facts.mjs beta`, without reading any file, and reply with how many fact lines each printed. Each command prints 12 `key = value` fact lines on one topic, then 170 filler log lines (9,106 and 8,913 characters). Both topics use the same 12 keys with different values, and none of the values can be guessed.
2. **`/compact <focus>`** (181 characters), sent with `send.mjs` at an idle moment, at the same time to all three agents. The focus asks to keep every alpha fact verbatim and to keep nothing of beta.
3. **Probe** (294 characters). From memory only, with no tool and no file, list every key and value remembered from alpha, then from beta, writing "none" and not guessing.

The focus is judged from the probe's reply. Alpha and beta sit in the same turn as tool output of the same kind, so a compaction that ignores the focus has no reason to treat them differently. Keeping alpha while dropping beta therefore shows the focus at work. Keeping both, or neither, shows it was not applied. Each summary was then checked by counting how many of each topic's values it contains. The count uses 10 values per topic: the two short numbers, which could match by accident, are left out.

## 1. Results per provider

| | Claude | Codex | OpenCode |
|---|---|---|---|
| **Compaction started** | yes: `loading` → `completed`, `trigger: manual` | yes: `loading` → `completed`, both `trigger: manual` | yes: `loading` (`trigger: manual`) → `completed` (no trigger) |
| **Focus honoured** | **yes** | **no** | **no** |
| Probe reply | All 12 alpha pairs correct; beta "none" | "none" for both topics | "none" for both topics; says it kept only the line counts |
| Summary (provider's own record) | 3,887 characters: 10 of 10 alpha values, 0 of 10 beta | An encrypted server-side `compaction` item (2,434 characters) plus the first user message: 0 of 10 alpha, 0 of 10 beta. The focus text appears nowhere in Codex's session | 574 characters: 0 of 10 alpha, 0 of 10 beta. The compaction's user message has only a `compaction` part (`auto: false`), no text |
| Why | Claude Code gets the whole text; `/compact` is a root command passed as typed | Paseo's Codex provider handles `/compact` out of band: `thread/compact/start { threadId }`, with the text after `/compact` dropped | Paseo's OpenCode provider calls `session.summarize` with the session, directory and model only, with the text after `/compact` dropped |

Codex ran both commands in one shell call. Its session rollout shows the model received the whole output (18,504 characters, both fact blocks), so the "none" is not caused by truncation.

## 2. Tokens and context

| | Claude | Codex | OpenCode |
|---|---|---|---|
| Context before (turn 1 end) | 33,255 | 22,601 | 26,483 |
| `preTokens` | 33,269 | none | none |
| Context reported right after the compaction | 2,748 (Claude Code's `postTokens`; `cumulativeDroppedTokens` 30,521) | 4,817 | 26,483 (**stale**: the whole `lastUsage` repeats turn 1's) |
| The compaction turn's `lastUsage` tokens | 0 / 0 / 0 | 0 / 0 / 0 | 3,386 / 23,082 / 15 (turn 1's) |
| **Next turn** input / cached / output | 10 / 18,843 / 573 | 16,752 / 11,008 (inside input) / 55 | 19,677 / 128 / 52 |
| **Next turn context** | 23,970 | 16,807 | 19,857 |
| Context saved on the next turn | 9,285 (28 %) | 5,794 (26 %) | 6,626 (25 %) |
| The compaction's own model call | Not in any turn's usage | Not in any turn's usage, nor in Codex's own session total (`total_token_usage` stayed 38,430 across it) | Not in Paseo's usage. OpenCode's store has it: 2,826 tokens (input 2,336, cache read 251, output 158, reasoning 81) |

- **Right after a compaction, the context figure understates the real one.** Claude's 2,748 and Codex's 4,817 are well below the next turn's 23,970 and 16,807, and OpenCode's figure has not moved at all. The context the agent really carries appears only at the next turn's end.
- **Prompt cache.** Claude kept its cached prefix (18,843 cached on the next turn), and Codex kept the same 11,008 it had on its first call. OpenCode lost almost all of its cache: 128 cached of 19,805 read, against 23,082 cached before.
- **OpenCode's summariser read 2,587 tokens of a 26,483-token context.** The tool outputs had been pruned before it ran. The run does not separate whether OpenCode or the user's own OpenCode setup pruned them. That setup has a custom default agent and a context-pruning plugin, which tagged the probe reply with a `dcp-message-id` marker. Paseo does not isolate it, so OpenCode's results reflect that setup.

## 3. Time

| | Claude | Codex | OpenCode |
|---|---|---|---|
| Sent (client) | 14:22:28.920 | 14:22:29.293 | 14:22:29.624 |
| `user_message` on the timeline | 14:22:29.234 | 14:22:29.552 | 14:22:30.212 |
| `compaction` `loading` | 14:22:29.241 | 14:22:29.600 | 14:22:30.287 |
| `compaction` `completed` | 14:22:48.526 | 14:22:36.021 | 14:22:34.367 |
| **Compaction (loading → completed)** | **19.3 s** (Claude Code's own `durationMs`: 19,169) | **6.4 s** | **4.1 s** |
| Send → completed | 19.6 s | 6.7 s | 4.7 s |
| Agent idle again (snapshot `updatedAt`) | 14:22:48.529 | 14:22:36.025 | 14:22:34.369 |

For a context of about 22,000–33,000 tokens.

## 4. Cost (`totalCostUsd`, a session total)

| | Claude | Codex | OpenCode |
|---|---|---|---|
| After turn 1 | 0.0426096 | absent | absent |
| After the compaction | 0.06578435 | absent | absent |
| **The compaction** | **+$0.0232** | not reported | not reported (OpenCode records cost 0 for the free model) |
| After the probe | 0.07963165 (**+$0.0138** for that turn) | absent | absent |

Only Claude reports `totalCostUsd`. Codex and OpenCode have no such field in `lastUsage` at any turn, so the cost of a compaction can be read in dollars on Claude only. On Codex its tokens are counted nowhere. On OpenCode they are only in OpenCode's own store.

The run used Claude Haiku 4.5 to keep the spend small. The owner's Manager and Worker profiles run Opus, whose per-token price is higher, so the same compaction costs a multiple of $0.0232 there. The cost also grows with `preTokens`.

## 5. What the timeline shows for the message, and how the collector would read it

| | Claude | Codex | OpenCode |
|---|---|---|---|
| `user_message` with the whole text (181 characters) | yes | yes | yes |
| `clientMessageId` | yes | yes | yes |
| Turn id | `foreground-turn-2`, the compaction's turn | **null**. The compaction runs in `autonomous-b94b2632-0e6b-41b8-8462-04c3fab008c9` | `opencode-turn-1`, the compaction's turn |
| Assistant message in the compaction turn | none | none | none (Paseo hides the summary message) |

The plugin was not installed, so this is derived from the collector's code (`plugin/server/collector.ts`) and the fields above:

- **Claude and OpenCode.** `timestampsForTurn` selects the entries of the ended turn by its id, which includes the `/compact <focus>` message. The message carries `clientMessageId` and is not a plugin notice (`isPluginNotice`), so it would be recorded with `origin: "user"`, as the owner's own words. The Paseo app also draws it as a message the user typed.
- **Codex.** The message has no turn id, and the compaction turn's id is `autonomous-…`, so the turn filter leaves it out of every record. It would be misread only by a later turn with a null turn id, whose slice starts at the last `user_message`.
- **The classification §G.5 needs.** The plugin logs each `/compact` it sends (agent id, time, text), and the collector marks a matching `user_message` as the plugin's. A message that merely starts with `/compact` is not enough, because the owner can type `/compact` too.

## 6. Verdicts for §G.5 ("compaction on for providers the spike passed")

| Provider | Compacts on request | Focus | Verdict | Fallback |
|---|---|---|---|---|
| **Claude** | yes | honoured | **Pass: compaction on**, with the focus template as designed | none needed |
| **Codex** | yes | dropped by Paseo 0.9.2 before Codex | **Pass without focus: compaction on only as a generic compaction.** Step 4's `BM-STATE` brief is what carries the request, decisions, plan, bead state and findings. The plugin sends `/compact` bare, because a focus would only appear in the chat and change nothing. Its cost cannot be measured | none needed for the compaction; the focus's job goes to `BM-STATE` |
| **OpenCode** | yes | dropped by Paseo 0.9.2 before OpenCode | **Pass without focus, under the same conditions as Codex.** Also: read the context from the next turn, because the compaction turn's usage is stale; the next turn loses the prompt cache; and the result depends on the user's own OpenCode setup | none needed for the compaction; the focus's job goes to `BM-STATE` |

On all three, §G.5 step 3 (wait for the `compaction` item to complete) works as designed. The `completed` item marks the end, and the agent is idle within 4 ms of it. A threshold check made right after a compaction must not read the context figure then (§2). It waits for the next turn's end.

## 7. The owner's machine and clean-up

- SHA-256 of `~/.paseo/config.json`, hashed read-only with the contents never printed: before (14:19:53 UTC) `90fc8099c13e75fd1ba9612f0c0d9faceabe5b74cdcaf1dc3dd49cafd86f778d`, after (14:26:20 UTC) `90fc8099c13e75fd1ba9612f0c0d9faceabe5b74cdcaf1dc3dd49cafd86f778d`. **Unchanged.**
- The owner's daemon (port 6767) was not contacted, stopped or restarted, and it was still listening at the end. `PASEO_BM_HOME` pointed at the scratch run folder throughout.
- The isolated daemon was stopped by its supervisor pid (30792), after its status reported the run's home and `127.0.0.1:6931`. It was never stopped with `paseo daemon stop` or `restart`. Its worker (30793) exited with it, and nothing listened on 6931 afterwards. The three agents died with the daemon; none was archived or deleted.
- Nothing in the repository changed except this note and one AGENTS.md fact. The plugin was not installed, and no `npx`, `npm install` or publish was run.
- Provider spend: Claude Haiku $0.0796 in all (3 turns and the compaction); Codex about 55,000 tokens counted by Codex (plus the uncounted compaction); OpenCode's free model about 90,000 tokens, including the compaction's 2,826.
