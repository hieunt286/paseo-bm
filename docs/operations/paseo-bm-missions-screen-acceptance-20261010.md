# Acceptance record — Missions, Phase 3 (the Missions screen), 2026-10-10

| Field | Value |
|---|---|
| Feature | [missions PRD](../product/paseo-bm-missions-prd.md) REQ-196; [missions design](../design/paseo-bm-missions.md) §10, §18; the approved mockup [`missions-screen.html`](../design/mockups/missions-screen.html) (the owner's approval, 2026-10-10: "Tôi duyệt theo mockup") |
| Beads | `bm-missions-9qc3.26.1` (RPCs), `.26.2` (client), `.26.3` (visual check), `.26.4` (this record) |
| Build | branch `feat/missions` working tree after the fixes below (`npm run verify` green: 194 files / 5,634 tests, bench 3, eval 134; entries 1,699,456 of 2,000,000 bytes) |
| Harness | a preview outside the repository (`/tmp/bmtrace/preview`, not kept). It used Vite and react-native-web with the plugin's real client entry and its real server entry, loaded with a fake host that registered all 71 RPCs. The data was a fixture folder written through the plugin's own stores, with a fake Paseo and a fake `paseo` CLI. Screenshots came from headless Chrome. The owner's daemon, `~/.paseo` and `~/.paseo-bm` were not touched |
| Run by | Claude, under the owner's delegation |

## The fixture

It mirrors the artboards:
- **AIX "AI Assistant ↔ xOne":** two repos and level 2. 11 done criteria: 5 met, 1 dropped. A plan, contracts C1 and C2, journal lines, and three requests (working, finished, and blocked with Q1). Two questions for the owner and a mess signal at step 2, nudged 12 minutes earlier.
- **ORA "Oracle V0.0.4 fixes":** one repo, 2 of 3 criteria met, one working Worker.
- **PRD1:** closed on 2026-10-08.
- **ai-assistant's memory:** 42 entries.

## Artboard by artboard

| Artboard | Width | Result |
|---|---|---|
| A · Desktop list | 1040 | Matches: title, "New mission", the sentence, "Open · 2". Each card has its accent bar, code, name, Main chip, level and classes, repository chips, counts, progress and "Done criteria m of n", the question and governor chips, or "No questions · no signals". "Closed · 1" is dimmed with its date and repos. |
| B · Desktop page | 1040 | Matches: "Missions ›", the code and name, the three buttons, and the three stats ("budget 4"). The charter shows "confirmed", the goal, the repository chips with "+ Add", the non-goals, 4 criteria with their boxes and "+ 7 more". The level card shows cells 0–4, "The Main decides:", "Yours:", and the Governor lines with "re-plan due in n min". Also shown: Workers by repository, contracts, journal, and the read-only plan. |
| C · Phone list | 390 | Matches: "New", compact cards with "n repositories · n live Workers · Main …", progress, "Done m of n · questions · signal", and "Closed · 1". |
| D · Phone page | 390 | Matches: "Missions ›", the code and name, a full-width "Open Main" and "⋯", the three stats, Charter, Governor, Workers ("+ 1 finished"), the mission level and its sentence, and the chips Contracts · 2, Journal, Plan, Project memory. "⋯" opens Rename and Close mission; Journal opens its part in place. |
| E · New mission | 640 | Matches: Name and Short code, the Goal and its hint, repositories as toggle chips, mission level 0–4 with its sentence, then "Cancel" and "Create and open Main". |
| F · Project memory | 640 | Matches: "Memory · ai-assistant", "42 entries", and rows of kind chip, entry and source ("owner, Q2 · date", "Worker 733918b", "owner · all projects"). It opens from a mission's repository chip, the phone's "Project memory" chip, and the project page's "Memory" action. |

In-place states were checked as well:
- Rename shows the name and code fields with Cancel and Save.
- "Close AIX?" shows a danger confirm.
- "+ Add" with every listed project already in the mission explains that in one line.
- Level 3 shows "Set AIX to level 3?" with its consequence.

## Found and fixed during the check

1. **Unequal heights.** Cards and stats side by side had different heights; the artboards' grids stretch them. Fixed: cards grow to their row's height.
2. **Contracts table.** Its columns wrapped a contract title mid-word. Fixed: the widths were rebalanced.
3. **Precedents missing from memory.** Project memory left out the owner's precedents, which artboard F shows ("owner · all projects"). Fixed: `memory.list` adds the active precedents of the repo and of all projects.
4. **Source text said things twice.** A source that already named the owner or carried a date showed them twice. Fixed in `memorySourceOf`.
5. **Close button style.** "Close mission"'s confirm used the primary style. Fixed: `ConfirmDialog.confirmKind: "danger"`.
6. **A Phase 1 Inbox defect, found by the harness.** A mission's `m:` card was grouped under "a closed project" and asked by "paseo-bm plugin". Fixed: the Inbox names the group "Mission AIX · AI Assistant ↔ xOne" and the asker "Main".

## Departures kept on purpose

- The phone keeps "Tools" as a fifth equal tab (design §10.1).
- The quiet-families line lists `stuck` too.
- The memory view has a back link.
- A closed mission's page hides its actions.

Design §18 lists these departures.

## Not covered

- The screen inside the Paseo app itself. Icons come from the app; the harness drew a placeholder for the Worker mark.
- Confirming "Close mission" from the screen against a running Worker. The harness presses the first button with a label, which is the header's. The refusal is covered by `test/missions-rpc.test.ts`.
- Typing in the form fields (the harness cannot type). The form's validation and the inputs it sends are covered by `test/plugin-missions-model.test.ts`.
