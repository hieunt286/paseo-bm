# Run note — ADR-027 review stream 4, short live check on an isolated daemon, 2026-10-03

| Field | Value |
|---|---|
| Bead | `bm-8vl3` (ADR-027 post-build review, stream 4: S4-a relay of unbound blocks, S4-b `AskUserQuestion` denied, S4-c no `size`) |
| Design | [base design](../../design/paseo-bm.md) §16.5–§16.12; [ADR-027](../../adr/ADR-027-agents-write-content-code-carries-it.md) Amended row (owner decisions of 2026-10-03) |
| Paseo | CLI and daemon **0.10.2** |
| Method | as [the agent-tools acceptance run](paseo-bm-agent-tools-acceptance-20261003.md) §9: `scripts/manual-test/start-daemon.sh` on port **6933**, home and data folder under the session scratchpad (`s4live/`); `setup.grant-agent-tools` turned `injectIntoAgents` on in that test config only. The owner's `~/.paseo`, `~/.paseo-bm` and port 6767 were untouched |
| Plugin | the branch's `plugin/` with stream 4 (build current), `paseo plugin add <repo>/plugin` → `status: running`; reloaded once (`paseo plugin reload`) after the `bm_create_worker` `request` description was sharpened (check 3) |
| Roles | `setup.ensure-roles`; Manager, Worker and Reviewer set to `claude/claude-haiku-4-5` with `roles.save-settings` |
| Target repos | `hand`, `hand2` (unbound), `demo`, `demo2` (bound), by `new-workspace.sh`, each with a `greeting.js` where needed and `br init` committed. No remote |
| Owner actions | unbound Managers created with `create-agent.mjs bm-manager claude-haiku-4-5 - bypassPermissions`; messages to bound Managers with `send.mjs` (as the app sends); one question answered with `decisions.answer { via: "inbox" }`. **No request named a tool.** No permission request came up (`paseo permit ls` empty at every look) |
| Window | 16:14–16:26 UTC |

## Results

| # | Check | Result |
|---|---|---|
| 1 | An unbound hand-made Manager → Worker: the Worker's report reaches the Manager by relay | **Pass** (third attempt; the first two Managers did the change themselves) |
| 2 | A bound Manager that tries `AskUserQuestion` gets the deny with the channel message | **Not exercised live** — 0 `AskUserQuestion` calls by any of the five Managers; covered by the unit tests |
| 3 | A bound request whose text says "This is Small." keeps it in the brief | **Fail, then pass** after the `request` field's description named "every sentence, a size included" |

## 1. Unbound Manager → Worker → relay

- **Attempts 1 and 2** (`hand`): "Add a farewell(name) function … with a node:test unit test. It is Small." and "Add a shout(text) function … It is Small." Both Haiku Managers wrote the files themselves (`Write`, `Edit`, `Bash node --test`) and created no Worker, against their rule 1. Their prompts held the role file and the `### Without paseo-bm's tools` part (99 lines). Recorded as role adherence, not a relay result.
- **Attempt 3** (`hand2`, the request of the acceptance run's H1 check): "Add a farewell(name) function in farewell.js that returns "Bye, <name>!", with a node:test unit test. Have a Reviewer check it before you report it finished."
  - Manager: `list_profiles`, `create_agent` (first refused for `provider` without a model, then `bm-worker/claude-haiku-4-5`), invented `requestId` `req-20261003T143000Z`, request quoted verbatim. **No Manager id** in the brief.
  - Worker: wrote and tested the change; did not create a Reviewer (it looked for `create_agent` with `ToolSearch`, then ran Claude Code's own `code-review` skill instead); called the `bm_report` builder at 16:20:06 and wrote the block in its reply at 16:20:09.162. **0** `send_agent_prompt`, **0** `SendMessage`.
  - Relay: outbox record `out-a8d07e5ac2d4`, `report`, Worker → Manager, created 16:20:09.188 (26 ms after the reply), **`delivered`** 16:20:13.095. The Manager's timeline holds `BM-DELIVERY report out-a8d07e5ac2d4` + the block (16:20:13.086), and it answered "Confirmed. Request `req-20261003T143000Z` complete". Paseo's own `notifyOnFinish` had woken it first (16:20:13.071), so it summarised once from the Worker's activity and once from the delivery.

## 2. `AskUserQuestion`

Two bound Managers got requests that had triggered the box in earlier runs ("ask me which of the two first"; "the Worker should ask me which one before it starts"). The first asked the owner in its reply; the second delegated, the Worker asked with `bm_questions` (Q1 opened), and the Manager read it with `bm_decisions`. No agent of the run called `AskUserQuestion`, so the deny was not seen live. The request shape was confirmed in Paseo 0.10.2's Claude provider (`resolvePermissionKind`: `name: "AskUserQuestion"`, `kind: "question"`), and `test/action-boundary.test.ts` covers the deny per role, boundary off, any base provider, and the restart scan.

## 3. "This is Small." in the brief

- `demo`, after the owner answered the Manager's own question ("The first one, with the comma."): `bm_create_worker.request` = "Change greet in greeting.js so it greets with "Hi, <name>!" — with the comma." — the answer replaced the words, and "This is Small." was gone (F5 recurs).
- `demo`, a second request "Add a wave(name) function in wave.js … in test/wave.test.js. This is Small.": `request` = the text **without** "This is Small." (no `size` field any more; the sentence was simply dropped).
- Fix in this stream: the `request` field's description now says "The owner's request, verbatim: every sentence of it, a size or a review they asked for included." After the plugin reload, a fresh bound Manager (`demo2`) got "Change greet … "Hi, <name>!" or "Hi <name>!"; the Worker should ask me which one before it starts. This is Small." and passed it **character for character**, "This is Small." included. The Worker asked Q1, the owner answered `a` in the Inbox, and `greeting.js` returned `Hi, ${name}!`.

## Other observations

- Two Workers reported `finished` with `filesChanged: none` after writing files (`demo`), and the Manager flagged it to the owner. Role adherence, outside this stream.
- Every bound report, question and answer went through the tools (`bm_create_worker` 3, `bm_report` 4, `bm_questions` 1, `bm_decisions` 1); plugin log: no warning or error.

## Clean-up

The daemon's status was read first (`pid 22757`, `127.0.0.1:6933`, the test home), then `stop-daemon.sh` stopped it; afterwards nothing listened on 6933 and no process referenced the test home, and the work folder was deleted. The owner's daemon on 6767 kept running, untouched.
