// GENERATED FILE — do not edit.
// Source: docs/releases/*.md via scripts/generate-release-notes.mjs.

export type ReleaseNoteBlock = { kind: "heading" | "paragraph" | "bullet" | "code"; text: string };
export interface ReleaseNote { version: string; title: string; summary: string; blocks: readonly ReleaseNoteBlock[]; gitUrl: string }

export const RELEASE_NOTES: readonly ReleaseNote[] = [
  {
    "version": "0.5.5",
    "title": "paseo-bm 0.5.5",
    "summary": "Update paseo-bm from Settings, browse release notes from the same source used on GitHub, and navigate busy project screens with less scrolling. This release includes the update visibility introduced in 0.5.4 and adds a confirmed in-product update action, a unified changelog view, a compact Autonomy project picker, and mobile Bead details beside the selected task.",
    "blocks": [
      {
        "kind": "paragraph",
        "text": "Update paseo-bm from Settings, browse release notes from the same source used on GitHub, and navigate busy project screens with less scrolling. This release includes the update visibility introduced in 0.5.4 and adds a confirmed in-product update action, a unified changelog view, a compact Autonomy project picker, and mobile Bead details beside the selected task."
      },
      {
        "kind": "paragraph",
        "text": "Update with:"
      },
      {
        "kind": "code",
        "text": "paseo plugin update paseo-bm"
      },
      {
        "kind": "heading",
        "text": "What changed"
      },
      {
        "kind": "bullet",
        "text": "Update now in Settings. When a newer npm release is available, Settings offers a confirmation before running the supported paseo plugin update paseo-bm flow. Progress and the verified result stay inline; interrupted or unconfirmed outcomes show recovery guidance instead of claiming success."
      },
      {
        "kind": "bullet",
        "text": "One release-note source. Settings can browse the release files from docs/releases/, generated into the published plugin at build time. Each version links to its tagged Git source, while the same authored file remains the GitHub Release body."
      },
      {
        "kind": "bullet",
        "text": "Simpler onboarding docs. The repository and npm READMEs now focus on installation, current use, updates, safety boundaries, and support instead of carrying historical release narratives."
      },
      {
        "kind": "bullet",
        "text": "Compact Autonomy project selection. Settings uses one dropdown-style project picker on phone and wide layouts, so projects no longer consume a growing row of tabs."
      },
      {
        "kind": "bullet",
        "text": "Mobile Bead detail stays nearby. On compact screens, the selected Bead's detail appears directly under that Bead instead of below the final item in a long column."
      },
      {
        "kind": "bullet",
        "text": "Existing 0.5.4 attention cues remain. The sidebar Inbox badge and bounded daily npm update check continue to surface work and available releases without opening each screen."
      },
      {
        "kind": "paragraph",
        "text": "No agent-role behaviour or stored-data format changed in this release."
      },
      {
        "kind": "heading",
        "text": "What to know when upgrading"
      },
      {
        "kind": "bullet",
        "text": "Update now is available only when the installed plugin is the npm package paseo-bm-plugin. Directory installs remain manual and are never overwritten by the action."
      },
      {
        "kind": "bullet",
        "text": "The confirmation authorizes a network/package write and the plugin may reload during the command. If Settings cannot prove the resulting version, it reports an unknown outcome and points to paseo plugin ls plus the manual update command."
      },
      {
        "kind": "bullet",
        "text": "Release notes are bundled at build time. Reading them in Settings makes no GitHub request; only opening the source link leaves Paseo."
      },
      {
        "kind": "bullet",
        "text": "Existing settings, policies, Beads data, traces, decisions, alerts, and update-cache data need no migration."
      },
      {
        "kind": "heading",
        "text": "Rollback"
      },
      {
        "kind": "paragraph",
        "text": "Run paseo plugin update paseo-bm --version 0.5.4. Version 0.5.4 can read the existing plugin data; it ignores the generated release-note catalog and does not expose the 0.5.5 update action or layout fixes."
      },
      {
        "kind": "heading",
        "text": "Evidence"
      },
      {
        "kind": "bullet",
        "text": "Focused tests cover fixed update command arguments, npm-install eligibility, confirmation, busy state, success/failure/unknown outcomes, timeout and recovery text."
      },
      {
        "kind": "bullet",
        "text": "Release-note generator and client tests cover deterministic SemVer ordering, invalid or duplicate versions, readable bundled content, version selection and tagged Git links."
      },
      {
        "kind": "bullet",
        "text": "View-source tests cover the shared Autonomy picker and inline compact Bead detail while preserving the wide-screen detail pane."
      },
      {
        "kind": "bullet",
        "text": "The release tree is verified with the full repository suite, packed-package smoke test, isolated-daemon fresh install and update rehearsal, then the GitHub release workflow on Linux and macOS before trusted publishing."
      },
      {
        "kind": "heading",
        "text": "Sources"
      },
      {
        "kind": "paragraph",
        "text": "REQ-174 · Dashboard design §§11.4, 13.4 and 19 · Autonomy design §B.2 · Update and release-notes plan · 0.5.4 notes"
      }
    ],
    "gitUrl": "https://github.com/hieunt286/paseo-bm/blob/v0.5.5/docs/releases/paseo-bm-release-notes-0.5.5.md"
  },
  {
    "version": "0.5.3",
    "title": "paseo-bm 0.5.3",
    "summary": "Agents decide the content; the plugin now carries it reliably. This release moves Worker and Reviewer creation, delivery, question handling, review budgets and request identity onto caller-bound plugin tools, while preserving the hand-written path for providers that cannot pre-approve MCP tools. Update with:",
    "blocks": [
      {
        "kind": "paragraph",
        "text": "Agents decide the content; the plugin now carries it reliably. This release moves Worker and Reviewer creation, delivery, question handling, review budgets and request identity onto caller-bound plugin tools, while preserving the hand-written path for providers that cannot pre-approve MCP tools. Update with:"
      },
      {
        "kind": "code",
        "text": "paseo plugin update paseo-bm"
      },
      {
        "kind": "heading",
        "text": "What changed"
      },
      {
        "kind": "bullet",
        "text": "Reliable agent orchestration. Managers create Workers through bmcreateworker; Workers create and re-run Reviewers through budget-aware tools; reports, questions, answers, findings and handoffs are stored before the plugin delivers them to the right agent at a safe turn boundary. A plugin reload re-enqueues pending delivery instead of losing it."
      },
      {
        "kind": "bullet",
        "text": "One request identity and message-origin rule. The plugin assigns request ids, binds created agents to their role and parent, and consistently distinguishes owner messages, plugin notices, plugin prompts and agent relays. Quoted BM- text remains data, not authority."
      },
      {
        "kind": "bullet",
        "text": "Review budgets are enforced. Review calls share one counter across tool-created and off-tool Reviewers. Calls past the configured ceiling are refused unless the owner explicitly grants more; cancelled or failed Reviewer creation does not make finished work look blocked."
      },
      {
        "kind": "bullet",
        "text": "Provider compatibility stays intact. Claude, Codex and OpenCode agents use caller-bound tools. Providers that cannot pre-approve exact MCP tools stay on the compatible hand path; the plugin relays their valid blocks at turn end and reports malformed ones."
      },
      {
        "kind": "bullet",
        "text": "Safer role behaviour. The Worker distinguishes stopped from finished, preserves the owner's request verbatim in handoffs, reads owner precedents before asking again and treats requested scope as authoritative. AskUserQuestion is denied for paseo-bm roles so owner decisions stay in the plugin's recorded decision flow."
      },
      {
        "kind": "bullet",
        "text": "More useful Worker tabs. Plugin-created Workers and handoff successors use a concise, secret-redacted title derived from the owner's request while retaining the Worker marker and colour."
      },
      {
        "kind": "bullet",
        "text": "Readable request cards. A plugin-created agent's BM-BRIEF first prompt renders as a Request card instead of raw protocol text."
      },
      {
        "kind": "bullet",
        "text": "Honest missing-tool handling. The Orchestrator must try a named tool in the current turn before reporting it unavailable; validation and policy errors are handled as real tool results rather than mistaken for missing tooling."
      },
      {
        "kind": "bullet",
        "text": "Smaller, clearer agent instructions. Role prompts now describe judgement and safety rules while their schema-backed tools own formatting, recipients, timing and state. The plugin rejects invalid tool input without manufacturing a successful-looking result."
      },
      {
        "kind": "heading",
        "text": "What to know when upgrading"
      },
      {
        "kind": "bullet",
        "text": "Existing Managers, Workers and Reviewers continue to work on the hand path. Newly created role agents receive caller-bound tools when their provider supports exact MCP pre-approval."
      },
      {
        "kind": "bullet",
        "text": "Existing plugin data and settings remain in place. This release adds internal request, binding, outbox and review records under the existing data home; no user migration is required."
      },
      {
        "kind": "bullet",
        "text": "If a role agent was created before 0.5.3, replace it through the normal paseo-bm fallback or handoff flow to receive the new bound tool path and current instructions."
      },
      {
        "kind": "heading",
        "text": "Rollback"
      },
      {
        "kind": "paragraph",
        "text": "paseo plugin update paseo-bm --version 0.5.2. Data added by 0.5.3 remains in the paseo-bm data folder and is ignored by 0.5.2; do not delete it if you plan to return to 0.5.3."
      },
      {
        "kind": "heading",
        "text": "Evidence"
      },
      {
        "kind": "bullet",
        "text": "The ADR-027 acceptance run exercised bound delivery, questions and answers, review-budget refusal and grant, off-tool Reviewer accounting, quoted-command safety, unknown-token fallback, cancellation and handoff on an isolated Paseo 0.10.2 daemon."
      },
      {
        "kind": "bullet",
        "text": "The semantic Worker-title change was verified on a live plugin-created Worker: 🔵 W · Runtime test: verify meaningful Worker title."
      },
      {
        "kind": "bullet",
        "text": "The Orchestrator missing-tool correction was verified with a fresh agent that called the named tool and handled its actual result."
      },
      {
        "kind": "bullet",
        "text": "The prospective release tree passed npm run verify (5,161 default tests, 3 benchmark tests and 134 evaluation tests) and npm run smoke:packed; the packed plugin contains exactly six files and stays under paseo.cafe's 2,000,000-byte entry limit."
      },
      {
        "kind": "bullet",
        "text": "The release workflow independently verifies the tagged tree on Linux and macOS, smoke-tests the packed package, and checks the published payload before the release completes."
      },
      {
        "kind": "heading",
        "text": "Sources"
      },
      {
        "kind": "paragraph",
        "text": "ADR-027 · Technical Design §7.4, §7.14–§7.16 · ADR-027 acceptance run · 0.5.2 notes"
      }
    ],
    "gitUrl": "https://github.com/hieunt286/paseo-bm/blob/v0.5.3/docs/releases/paseo-bm-release-notes-0.5.3.md"
  },
  {
    "version": "0.5.2",
    "title": "paseo-bm 0.5.2",
    "summary": "Packaged so paseo.cafe can list 0.5. Nothing changes in how the agents work or in the screens: the code that runs is the same as 0.5.1, packaged differently. Update with:",
    "blocks": [
      {
        "kind": "paragraph",
        "text": "Packaged so paseo.cafe can list 0.5. Nothing changes in how the agents work or in the screens: the code that runs is the same as 0.5.1, packaged differently. Update with:"
      },
      {
        "kind": "code",
        "text": "paseo plugin update paseo-bm"
      },
      {
        "kind": "heading",
        "text": "What changed"
      },
      {
        "kind": "bullet",
        "text": "The published package is bundled. paseo.cafe's security scan reads a plugin's code from its two entries and refuses more than 200 files or 2,000,000 bytes. 0.5.1 shipped its 250 TypeScript source files (about 3.5 MB), so the scan refused it and the paseo.cafe listing stayed on 0.4.1. From 0.5.2 the package holds the two entries, each bundled into one file (1.63 MB together), with the manifest, README.md and LICENSE (ADR-026). Paseo compiles them as it compiled the sources."
      },
      {
        "kind": "bullet",
        "text": "The bundles keep their names. Whitespace is minified, but function and variable names are kept, so an error in Paseo's plugin log still names the function. Each file's header points at its readable source at this release's tag, plugin/."
      },
      {
        "kind": "bullet",
        "text": "The source, the tests and the way the plugin behaves are unchanged."
      },
      {
        "kind": "heading",
        "text": "What to know when upgrading"
      },
      {
        "kind": "paragraph",
        "text": "Nothing beyond 0.5.0. Paseo replaces the installed files on update; your data folder and settings are untouched."
      },
      {
        "kind": "heading",
        "text": "Rollback"
      },
      {
        "kind": "paragraph",
        "text": "paseo plugin update paseo-bm --version 0.5.1. It is the same code, unbundled."
      },
      {
        "kind": "heading",
        "text": "Evidence"
      },
      {
        "kind": "bullet",
        "text": "npm run verify and npm run smoke:packed exited 0 on the tagged tree. The smoke now checks that the published package is current with the source, holds exactly its six files, and fits the scan budget."
      },
      {
        "kind": "bullet",
        "text": "paseo.cafe's own scanner (scanStaticFiles, paseo-cafe 4608732), run locally on the package: 3 files, 1,626,670 bytes, no finding. On 0.5.1 it reported scanner/incomplete."
      },
      {
        "kind": "bullet",
        "text": "The published server entry loads the way Paseo loads a plugin (re-bundled as CommonJS, eager interop) and registers every RPC and hook, as the source does (test/plugin-bundle-cjs.test.ts)."
      },
      {
        "kind": "bullet",
        "text": "The packed tarball, served through a registry mirror to isolated Paseo 0.9.2 daemons:"
      },
      {
        "kind": "bullet",
        "text": "Update from the real 0.5.1: running, with clean logs. The 0.5.1 data and settings were read, and the 19 read RPCs behind the screens gave the same answers as on 0.5.1. The plugin now loads in 0.6 s instead of 6.5 s."
      },
      {
        "kind": "bullet",
        "text": "Fresh install: the Manager was created with its role instructions, tools and title marker, and removal left nothing behind."
      },
      {
        "kind": "bullet",
        "text": "The client: the client bundle the daemon compiled for 0.5.2 was evaluated the way the app evaluates it, beside 0.5.1's. Both registered the same 18 contributions, transformed 56 sample messages identically, and rendered 17 screens and cards to identical HTML."
      },
      {
        "kind": "bullet",
        "text": "In the real app: the owner ran this exact package on their own daemon and went through the Inbox, Projects, Settings, Tools & skills and the chat cards. Everything ran normally."
      },
      {
        "kind": "heading",
        "text": "Sources"
      },
      {
        "kind": "paragraph",
        "text": "ADR-026 · Technical Design §3.1 · paseo.cafe listing record · 0.5.1 notes"
      }
    ],
    "gitUrl": "https://github.com/hieunt286/paseo-bm/blob/v0.5.2/docs/releases/paseo-bm-release-notes-0.5.2.md"
  },
  {
    "version": "0.5.1",
    "title": "paseo-bm 0.5.1",
    "summary": "The pictures now show 0.5. Nothing changes in how the agents work or in the screens. Update with:",
    "blocks": [
      {
        "kind": "paragraph",
        "text": "The pictures now show 0.5. Nothing changes in how the agents work or in the screens. Update with:"
      },
      {
        "kind": "code",
        "text": "paseo plugin update paseo-bm"
      },
      {
        "kind": "heading",
        "text": "What changed"
      },
      {
        "kind": "bullet",
        "text": "The README on npm and the listing on paseo.cafe show the 0.5 screens. The three screenshots of 0.3 (the old Beads screen, the Metric screen and the installer) are replaced by the five design artboards of the 0.5 screens that paseo-bm.erai.pro shows: the Inbox, Projects, a project's Beads board, Settings → Autonomy, and a Manager chat from the request to a verified finish."
      },
      {
        "kind": "bullet",
        "text": "The release check waits longer for npm. After publishing, the release workflow now waits up to 10 minutes, instead of 5, for npm to serve the new version. 0.5.0 was published correctly, but npm took about 6 minutes to serve it, so its release run was marked failed."
      },
      {
        "kind": "heading",
        "text": "What to know when upgrading"
      },
      {
        "kind": "paragraph",
        "text": "Nothing beyond 0.5.0: the plugin's code is the same."
      },
      {
        "kind": "heading",
        "text": "Rollback"
      },
      {
        "kind": "paragraph",
        "text": "paseo plugin update paseo-bm --version 0.5.0."
      },
      {
        "kind": "heading",
        "text": "Evidence"
      },
      {
        "kind": "paragraph",
        "text": "npm run verify and npm run smoke:packed exited 0 on the tagged tree. The images are copied unchanged from the site's sources. As before, they are in no tarball: smoke:packed checks that."
      },
      {
        "kind": "heading",
        "text": "Sources"
      },
      {
        "kind": "paragraph",
        "text": "0.5.0 notes · paseo.cafe listing record (§5, §6) · Release runbook (§2)"
      }
    ],
    "gitUrl": "https://github.com/hieunt286/paseo-bm/blob/v0.5.1/docs/releases/paseo-bm-release-notes-0.5.1.md"
  },
  {
    "version": "0.5.0",
    "title": "paseo-bm 0.5.0",
    "summary": "Calibrated autonomy: one coordinator for every project, questions you answer once, and one control per project for how much is decided without you. This is the largest release since the plugin became the product. It adds a fourth agent, the Beads Orchestrator. Every question put to you is now one stored decision, the same card wherever it appears, answered once. Each project gets an autonomy level, from Hands-on to Full auto. The screens are rebuilt around an Inbox. A new or updated install decides nothing for you until you raise a project's level. Update with:",
    "blocks": [
      {
        "kind": "paragraph",
        "text": "Calibrated autonomy: one coordinator for every project, questions you answer once, and one control per project for how much is decided without you. This is the largest release since the plugin became the product. It adds a fourth agent, the Beads Orchestrator. Every question put to you is now one stored decision, the same card wherever it appears, answered once. Each project gets an autonomy level, from Hands-on to Full auto. The screens are rebuilt around an Inbox. A new or updated install decides nothing for you until you raise a project's level. Update with:"
      },
      {
        "kind": "code",
        "text": "paseo plugin update paseo-bm"
      },
      {
        "kind": "paragraph",
        "text": "Then read What to know when upgrading. Agents created on 0.4.x keep their old instructions, and two 0.4.x settings are retired."
      },
      {
        "kind": "heading",
        "text": "What changed"
      },
      {
        "kind": "heading",
        "text": "The Beads Orchestrator: one coordinator for every project"
      },
      {
        "kind": "bullet",
        "text": "One agent for the whole machine, started only by you. Nothing of it exists until you press Start… in the Inbox header and confirm. It runs on a new role, bm-orchestrator (provider and model in Settings → More → Agents), in a workspace of its own: the folder /.paseo-bm/orchestrator/home, which Paseo lists as a project named home. It uses tokens on that provider, and the masked content of every paseo-bm project goes to it."
      },
      {
        "kind": "bullet",
        "text": "It reads, through the plugin's own tools. It sees where each request stands, the Workers' reports, the decisions, and the recent messages of paseo-bm's own agents, never another agent's. Secrets are masked as in the traces. It can check a claim with read-only git inside a project (status, what changed, the last commits, one file; never a secrets file). It keeps short notes per project, which carry over to a new Orchestrator. It has no Paseo agent tools: everything it sends goes through the plugin, which checks the authority at every send and records it."
      },
      {
        "kind": "bullet",
        "text": "It moves the work on, within your authority. It tells a project's Manager what to do next. It may correct a Worker directly, and that Worker's Manager always gets a copy. It never writes to a Reviewer. A command goes out on one of three things:"
      },
      {
        "kind": "bullet",
        "text": "a decision you answered;"
      },
      {
        "kind": "bullet",
        "text": "your own latest message in its chat (\"send it\");"
      },
      {
        "kind": "bullet",
        "text": "the project's autonomy level, when that level lets it decide every kind of decision the command touches."
      },
      {
        "kind": "paragraph",
        "text": "Each command is a BM-COMMAND block that declares its intent and effects, shown as an action card. A word in its chat never covers a push, publish, deploy, real data, a migration, a security change or a cost. A word check backs the declared effects up. A loop guard stops it at 12 commands per request in 24 hours."
      },
      {
        "kind": "bullet",
        "text": "It wakes on events, not on a timer. In a project at Co-pilot or above, four things wake it: a request that finished with work left, a stalled request, a Worker signal, and a question the level asks it to decide or to propose an answer to. In every project, the coordination events below wake it too."
      },
      {
        "kind": "bullet",
        "text": "Coordination (Settings → Coordination). The Orchestrator can step in three ways:"
      },
      {
        "kind": "bullet",
        "text": "Advice. After every 5 finished requests of a project (0 turns it off), it reviews the project's figures. It brings you each change worth making as an Inbox decision, with the change ready on one option. The change applies only when you pick that option."
      },
      {
        "kind": "bullet",
        "text": "Compaction. It may have a Manager or a Worker compact its conversation when that conversation crosses a threshold. paseo-bm sends /compact at a safe moment, then restores what matters from its own records."
      },
      {
        "kind": "bullet",
        "text": "Handoff. It may have a Manager hand a request that grew too heavy to a fresh Worker. The new Worker re-proves every check before it reports anything done, and the old one stays in your list, marked replaced."
      },
      {
        "kind": "paragraph",
        "text": "Every intervention is logged with whether it worked. A compaction or handoff kind that misses too often switches itself off, and the Inbox says so; only you switch it back on."
      },
      {
        "kind": "bullet",
        "text": "It is yours. paseo-bm never archives, stops or deletes it. An Orchestrator on older instructions, or one that lost its tools, is replaced by a fresh one at its next wake-up. After a day, when it is idle and you have not written to it for 2 hours, the next wake-up also starts a fresh one. The old one stays in your agent list."
      },
      {
        "kind": "heading",
        "text": "Autonomy: one level per project"
      },
      {
        "kind": "paragraph",
        "text": "Settings → Autonomy sets how much the Orchestrator may decide for you, as one level per project (ADR-025):"
      },
      {
        "kind": "paragraph",
        "text": "| Level | The Orchestrator decides | Everything else | |---|---|---| | Hands-on (the default) | nothing | yours, as asked | | Co-pilot | nothing | it proposes an answer on each card; you approve it | | Cruise | technical, preference, scope, environment and dependency questions | proposed, for your approval | | Turbo | as Cruise, plus cost, release and data | proposed, for your approval | | Full auto | every question, security included | — |"
      },
      {
        "kind": "bullet",
        "text": "Turbo and Full auto ask you to confirm every time you choose them, with Cancel first. At those levels a push, publish, deploy, migration, real-data change or cost can be decided without you, and at Full auto a security trade-off too."
      },
      {
        "kind": "bullet",
        "text": "Everything decided for you is visible. It shows in the Inbox under Decided for you, with who decided and why. Override takes an answer back, and your answer goes to the same agent. An override is recorded and never changes the level; you lower the level yourself."
      },
      {
        "kind": "bullet",
        "text": "From Co-pilot up, a decision card's main button is the Orchestrator's proposal, with its reason. The asker's recommendation stays marked beside it."
      },
      {
        "kind": "bullet",
        "text": "A project's Metrics show, per kind of decision, how often the asker's recommendation and the Orchestrator's proposal matched your answers. These figures are for your information: no threshold stands between you and a level."
      },
      {
        "kind": "heading",
        "text": "A question is asked once, and answered once"
      },
      {
        "kind": "bullet",
        "text": "One decision, everywhere. Every question to you is one stored record: a Worker's question, a decision the Orchestrator asks you, and an agent stopped by its provider plan. The Inbox, the Worker's chat and the Manager's chat show the same card. Answer it on any copy and all of them show it answered. The plugin delivers the answer to the asker at its next idle moment, and no agent relays it."
      },
      {
        "kind": "bullet",
        "text": "Options say what they allow. Each option declares its effects (push, migration, …). An option may carry a prepared action, which runs once when you pick it, within an hour of your answer. An answer that allows a push, publish, deploy, real data, a migration, a security change or a cost asks you to confirm on the card, Cancel first."
      },
      {
        "kind": "bullet",
        "text": "Answer however is at hand. Tap an option, write Own words…, answer the Manager in words, or answer in the Worker's chat. When the plugin cannot tell which question a chat message answered, the card says Needs confirmation: pick an option, Close as answered or Keep open."
      },
      {
        "kind": "bullet",
        "text": "Ask back. On a Worker's open question or the Orchestrator's open decision, you can ask the asker something first. Its reply shows on the card, and the question stays open."
      },
      {
        "kind": "bullet",
        "text": "Precedents. An answered question can be saved as a standing answer for that subject, in one project or in all of them, for 30 days by default. Manage precedents in Settings → More → Precedents. Agents created afterwards get the active precedents and follow them instead of asking."
      },
      {
        "kind": "bullet",
        "text": "A question re-asked supersedes the old card. A question you never answered expires when its request finishes."
      },
      {
        "kind": "heading",
        "text": "Hold risky actions for approval (per project, off by default)"
      },
      {
        "kind": "paragraph",
        "text": "This is a new switch under Settings → Autonomy. You confirm when you turn it on and when you turn it off. It applies to the Claude and Codex Workers and Reviewers a project creates after you turn it on. They start in a mode that asks, and paseo-bm answers every request itself at once. Some actions are held: a push, publish, deploy, real-data change, dependency install, network call, write outside the project, or a command paseo-bm cannot read. A held action waits for you as one Inbox item with the command, Allow once or Deny, unless an answer you gave for that request or the project's level covers it. Ordinary work runs without asking."
      },
      {
        "kind": "bullet",
        "text": "Agents that already exist keep their mode."
      },
      {
        "kind": "bullet",
        "text": "OpenCode and other providers are not held. They keep detection only, as in projects with the switch off."
      },
      {
        "kind": "bullet",
        "text": "The Inbox says when an agent of a held project runs without the hold."
      },
      {
        "kind": "paragraph",
        "text": "See ADR-019."
      },
      {
        "kind": "heading",
        "text": "Seeing the work, and noticing when it breaks"
      },
      {
        "kind": "bullet",
        "text": "Inbox alerts, in every project, with or without the Orchestrator:"
      },
      {
        "kind": "bullet",
        "text": "A request stalled. It is not finished, none of your questions is open for it, and none of its agents has run for 5 minutes. A request with more review calls than its size's budget also counts."
      },
      {
        "kind": "bullet",
        "text": "A Worker is in trouble. It is stuck for 10 minutes, waiting on a permission for 3 minutes, or running a dangerous command."
      },
      {
        "kind": "bullet",
        "text": "Two agents edited the same file at the same time."
      },
      {
        "kind": "bullet",
        "text": "A Worker or Reviewer was created by the wrong role."
      },
      {
        "kind": "bullet",
        "text": "An agent runs on older instructions."
      },
      {
        "kind": "bullet",
        "text": "A fallback failed."
      },
      {
        "kind": "bullet",
        "text": "A cut turn is no longer taken for your stop. When Paseo cuts an agent's turn short to deliver a message, Claude Code tells the agent that the user rejected its call. paseo-bm now recognises such a cut from what Paseo records, never from the words. A Manager or Worker left idle after one gets a BM-INTERRUPTED notice and carries on. Your own Stop, a new message from you, or a permission you deny is never taken for a cut (ADR-024)."
      },
      {
        "kind": "bullet",
        "text": "Evidence labels. A Worker's claims are labelled detected (paseo-bm saw the check pass after the last edit, the file edited, the bead closed), self-reported or unverified. A request that changed code and finished without its checks seen to pass reads Done — unverified. While it stands so, the Orchestrator never commits or releases it on the project's level."
      },
      {
        "kind": "bullet",
        "text": "Why? ▸ on a request shows the chain behind it: its decisions, beads, changes, checks, reviews and each agent's turns. You can also ask the Orchestrator why a bead, a file or a decision exists."
      },
      {
        "kind": "heading",
        "text": "New screens"
      },
      {
        "kind": "bullet",
        "text": "Beads Manager opens on the Inbox, with Inbox · Projects · Settings · Tools & skills. These replace the Setup landing, the Workspaces list and the Metric screen. The Orchestrator's status is at the right of the header on every screen."
      },
      {
        "kind": "bullet",
        "text": "Projects. One row per workspace shows the current request, its stage, its agents as M W R and the project's level. A project's page has five tabs:"
      },
      {
        "kind": "bullet",
        "text": "Overview."
      },
      {
        "kind": "bullet",
        "text": "Requests: a stage bar, evidence lines, a timeline, cost and Why? per request."
      },
      {
        "kind": "bullet",
        "text": "Beads: the board."
      },
      {
        "kind": "bullet",
        "text": "Metrics: flow, cost, coordination, beads, autonomy by class and review lift."
      },
      {
        "kind": "bullet",
        "text": "Agents."
      },
      {
        "kind": "paragraph",
        "text": "Closed workspaces keep their history, as before."
      },
      {
        "kind": "bullet",
        "text": "Settings has three parts:"
      },
      {
        "kind": "bullet",
        "text": "Autonomy: the level, and the hold switch."
      },
      {
        "kind": "bullet",
        "text": "Coordination: the advice cadence, compaction, handoff, and the review budget per request size (2–8 calls; 2, 2 and 4 by default; only Workers created afterwards get new numbers)."
      },
      {
        "kind": "bullet",
        "text": "More: Agents, Precedents and Data. Removal lives in Data."
      },
      {
        "kind": "bullet",
        "text": "Tools & skills. Skills, with how many Worker reports named each one in the last 30 days. The agent tools of each role. br and bv."
      },
      {
        "kind": "bullet",
        "text": "Cards. The cards are flat, all in one frame: who wrote to whom, on whose authority, one status, one main button, and Details ▸. A bar at a card's left says what kind it is: amber when it waits for you, red when something is held or failing."
      },
      {
        "kind": "bullet",
        "text": "Phone layout. The whole management surface works at phone width without sideways scrolling, except a project's tabs and long filters."
      },
      {
        "kind": "bullet",
        "text": "Role markers. Every paseo-bm agent's title now starts with its role: 🟣 M Manager, 🔵 W Worker, 🟠 R Reviewer, 🟢 O Orchestrator. This applies to agents created from now on. paseo-bm's own screens show titles without the marker."
      },
      {
        "kind": "bullet",
        "text": "Opening it. The Command Center has Open Beads Manager, Open Beads project (replacing Open Beads Metric) and Open Beads Inbox. A workspace's Beads tab is now that project's page, opened on its Beads board."
      },
      {
        "kind": "bullet",
        "text": "A Reviewer on another model family. When roles are created on a fresh install and a provider of another model family is signed in, the new Reviewer goes to that provider. Settings → More → Agents says when the Reviewer and the Worker share a family."
      },
      {
        "kind": "heading",
        "text": "How the agents behave"
      },
      {
        "kind": "paragraph",
        "text": "Each role's instructions were rewritten (plugin/roles/), and each role's Paseo tools are now limited by configuration (ADR-020)."
      },
      {
        "kind": "paragraph",
        "text": "Beads Manager"
      },
      {
        "kind": "bullet",
        "text": "It keeps the project's context. A Worker's first message now carries a Context section, each item with its source: your goals for the project, your earlier decisions and precedents that bear on the request, and the other requests it may touch."
      },
      {
        "kind": "bullet",
        "text": "It keeps the work aligned. When a Worker reports received, beads-done and finished, the Manager compares the work with your goals. When it goes against one (wider or narrower than asked, against a standing decision, in conflict with another request), it asks you one question with options. It never approves or rejects a technical choice."
      },
      {
        "kind": "bullet",
        "text": "It relays nothing. The lettered list of waiting questions (A6 a) is gone. When you answer in words, the Manager writes a BM-ANSWERS block in its own reply and the plugin delivers it. It no longer answers a Worker's question in your place, not even a fact: it gives the fact to you, with its source."
      },
      {
        "kind": "bullet",
        "text": "New instructions it follows. It acts on a BM-COMMAND as your word, within what the block approves and its limits. When the Orchestrator asks for a handoff, it creates the successor Worker. It is no longer allowed to kill or archive agents, answer permissions or change modes, by configuration as well as by instruction."
      },
      {
        "kind": "paragraph",
        "text": "Beads Worker"
      },
      {
        "kind": "bullet",
        "text": "It looks before it asks. It reads your precedents first and follows one that answers the question, citing it."
      },
      {
        "kind": "bullet",
        "text": "Each question carries more. It has a subject and a kind (scope, release, data, …), and each option says what it allows. A question asked again under a new number supersedes the old one. A question you have not answered stays open on its card. The Worker carries on with what the question does not touch and no longer asks it again at its next report."
      },
      {
        "kind": "bullet",
        "text": "A yes can come from a choice. Besides a request that names the effect, a yes is now an option you chose that declares it, or a BM-COMMAND that approves it. Its five rules are unchanged. They are no longer described as the only barrier, because with the hold on, the plugin also stops actions."
      },
      {
        "kind": "bullet",
        "text": "It names its scratch folder literally in each command and deletes it before its next report."
      },
      {
        "kind": "bullet",
        "text": "It writes each check exactly as it ran it, so paseo-bm can detect it."
      },
      {
        "kind": "bullet",
        "text": "Its review budget comes from Settings."
      },
      {
        "kind": "bullet",
        "text": "It takes part in a handoff. It writes a handoff note when asked. As the successor, it re-proves every check."
      },
      {
        "kind": "bullet",
        "text": "Not every notice is a stop. It treats BM-INTERRUPTED and a Reviewer's finish notice as no stop."
      },
      {
        "kind": "paragraph",
        "text": "Beads Reviewer. The review rules are unchanged, in shorter instructions. It now has no Paseo agent tools at all: it cannot create, message or stop agents."
      },
      {
        "kind": "paragraph",
        "text": "Beads Orchestrator (new). Three rules:"
      },
      {
        "kind": "bullet",
        "text": "It changes nothing itself."
      },
      {
        "kind": "bullet",
        "text": "It acts only as far as your authority goes."
      },
      {
        "kind": "bullet",
        "text": "It states only what its tools show."
      },
      {
        "kind": "paragraph",
        "text": "It answers you as Situation / Done / Needs you, in your language."
      },
      {
        "kind": "heading",
        "text": "Retired"
      },
      {
        "kind": "bullet",
        "text": "The Metric screen, Setup as the landing screen, the Workspaces list and Open Beads Metric. Their content is now in the Inbox, Projects and Settings."
      },
      {
        "kind": "bullet",
        "text": "Per-role additional instructions. What you saved in 0.4.x (role-extras.json) is no longer read. Precedents take their place."
      },
      {
        "kind": "bullet",
        "text": "The question tools on cards. Gone are Reply to , Use recommendations, Mark as answered and the waiting pills above the Manager's chat. Decision cards replace them."
      },
      {
        "kind": "bullet",
        "text": "The fallback chain's Auto switch (ADR-022). A role's fallback is now Ask me or Off. To let a stopped agent be switched or wait without you, set the project to Cruise or above: environment questions are then the Orchestrator's."
      },
      {
        "kind": "heading",
        "text": "What to know when upgrading"
      },
      {
        "kind": "bullet",
        "text": "Paseo 0.9.0 or newer, as before (requirements.paseo: \">=0.9.0\"). This release was built and checked on Paseo 0.9.2, which we recommend: the hold, role-pairing alerts and context figures rest on behaviour measured there."
      },
      {
        "kind": "bullet",
        "text": "What the first open after the update writes to Paseo's configuration:"
      },
      {
        "kind": "bullet",
        "text": "It adds the missing bm-orchestrator role, the alias and the profile, with the same defaults as the others. No Orchestrator agent is created until you start one."
      },
      {
        "kind": "bullet",
        "text": "It writes an explicit Paseo-tools policy on each existing bm- alias. Only that key changes: your providers, models and modes are kept. The Reviewer and the Orchestrator get no Paseo tools. The Manager and the Worker lose the tools no role should have: archive, kill, answering permissions, changing modes or labels, schedules and heartbeats. A Worker also cannot create or rename workspaces. Paseo applies the policy when an agent's session next opens, so existing agents get it too."
      },
      {
        "kind": "bullet",
        "text": "Agents created on 0.4.x keep their old instructions. Paseo fixes an agent's instructions when it is created, and paseo-bm does not support older agents beyond replacing them:"
      },
      {
        "kind": "bullet",
        "text": "The Inbox lists each live one as on older instructions."
      },
      {
        "kind": "bullet",
        "text": "For a Manager it offers Replace Manager, which starts a current Manager and opens it. The old one stays in your list."
      },
      {
        "kind": "bullet",
        "text": "Workers and Reviewers end with their request."
      },
      {
        "kind": "paragraph",
        "text": "It is best to update between requests, then replace each workspace's Manager."
      },
      {
        "kind": "bullet",
        "text": "Defaults after the update:"
      },
      {
        "kind": "bullet",
        "text": "Every project is Hands-on, and the hold is off everywhere."
      },
      {
        "kind": "bullet",
        "text": "The Orchestrator does not exist until you start it."
      },
      {
        "kind": "bullet",
        "text": "Once it runs, Coordination starts at advice every 5 finished requests, compaction and handoff on, and a review budget of 2, 2 and 4. Compaction and handoff act at any level without asking you. Turn either off in Settings → Coordination with one tap."
      },
      {
        "kind": "bullet",
        "text": "New Inbox alerts appear in every project even if you never start the Orchestrator: stalled requests, Worker signals, older agents. Nothing is sent to any agent because of them."
      },
      {
        "kind": "bullet",
        "text": "Additional instructions are no longer used. Their text stays in /.paseo-bm/role-extras.json until you delete your data. Move a standing rule you still need into a precedent."
      },
      {
        "kind": "bullet",
        "text": "A fallback chain set to Auto now reads as Ask me. Settings → More → Agents says so once."
      },
      {
        "kind": "bullet",
        "text": "Data folder. Nothing is migrated, and traces from 0.4.x are read as they are. New folders appear as they are first needed: decisions/, inbox/, autonomy/, coordination/, orchestrator/ and handoffs/. Remove paseo-bm's settings… (now under Settings → More → Data) deletes them with your data when you ask it to. It also removes the bm-orchestrator role. The Orchestrator agent and its home workspace stay in Paseo until you archive and remove them yourself."
      },
      {
        "kind": "bullet",
        "text": "Coming from a 0.3.x directory install: run the legacy directory installer, then paseo plugin update paseo-bm."
      },
      {
        "kind": "heading",
        "text": "Rollback"
      },
      {
        "kind": "paragraph",
        "text": "paseo plugin update paseo-bm --version 0.4.1 installs 0.4.1 again. However, 0.5.0 does not promise a way back: ADR-022 retired the guarantee that 0.4.1 reads what later builds write, and the downgrade was not tested for this release. The remedy for a fault in 0.5.0 is a patch release. If you go back anyway:"
      },
      {
        "kind": "bullet",
        "text": "Your data folder is left as it is. 0.4.1 knows nothing of the new folders (decisions, Inbox alerts, autonomy levels, precedents, coordination, the Orchestrator's files and handoffs). They stay on disk, unread. Traces and role-extras.json are where 0.4.1 expects them."
      },
      {
        "kind": "bullet",
        "text": "Agents created on 0.5.0 keep 0.5.0 instructions. Those instructions rely on tools and notices 0.4.1 does not have. Start new Managers. An Orchestrator agent, if you started one, stays in Paseo without its tools: archive it."
      },
      {
        "kind": "bullet",
        "text": "The bm-orchestrator entries and the Paseo-tools policies stay in Paseo's configuration. 0.4.1's Remove paseo-bm's settings… removes every bm- entry, these included."
      },
      {
        "kind": "heading",
        "text": "Evidence"
      },
      {
        "kind": "bullet",
        "text": "npm run verify (typecheck, plugin typecheck, lint, 4,823 product tests, the bench and eval test runs, build) and npm run smoke:packed exited 0 on the tagged tree."
      },
      {
        "kind": "bullet",
        "text": "The packed payload (paseo-bm-plugin-0.5.0.tgz, 259 files) was served through a registry mirror to isolated Paseo 0.9.2 daemons:"
      },
      {
        "kind": "bullet",
        "text": "Update from the real 0.4.1: paseo plugin update paseo-bm reported 0.5.0, running, with clean logs. The roles, the Reviewer's chosen mode, the agent-tools grant and the role profiles from 0.4.1 carried over. The next open added the bm-orchestrator role and the Paseo-tools policies and left the other roles as they were. Nineteen read RPCs behind the screens (setup, roles, projects, traces, beads, Inbox, decisions, insights, autonomy, coordination, precedents, Orchestrator) answered without error."
      },
      {
        "kind": "bullet",
        "text": "Fresh install: the same checks passed, and a Manager it created was titled 🟣 M · Beads Manager. Remove paseo-bm's settings… followed by paseo plugin remove paseo-bm left no bm- entry in Paseo's configuration."
      },
      {
        "kind": "bullet",
        "text": "What is already recorded:"
      },
      {
        "kind": "bullet",
        "text": "Field use. This build has run on the owner's own daemon since 2026-10-01 00:28 UTC. It was installed from a frozen copy checked first on an isolated daemon, and reinstalled with each later change up to the role markers. The owner's projects ran through it."
      },
      {
        "kind": "bullet",
        "text": "Pre-install check. The frozen release candidate was checked on an isolated Paseo 0.9.2 daemon, Claude and Codex, with one project held and one not: docs/archive/operations/paseo-bm-final-rc-check-20261001.md."
      },
      {
        "kind": "bullet",
        "text": "Live checks, one per phase, on isolated Paseo 0.9.2 daemons, recorded in docs/archive/operations/:"
      },
      {
        "kind": "bullet",
        "text": "decisions and Orchestrator wakes (paseo-bm-phase1-live-check-20260929.md and -2-20260929.md);"
      },
      {
        "kind": "bullet",
        "text": "a decided class, a release class and a precedent (paseo-bm-phase2-live-check-20260930.md);"
      },
      {
        "kind": "bullet",
        "text": "handoff and compaction (paseo-bm-phase3-live-check-20260930.md);"
      },
      {
        "kind": "bullet",
        "text": "the hold (paseo-bm-phase4-live-check-20261001.md)."
      },
      {
        "kind": "bullet",
        "text": "Spikes and runs that settled what Paseo does, in the same folder: permission events per provider, compaction per provider, context figures, role tools, role pairing."
      },
      {
        "kind": "bullet",
        "text": "Released before the programme's own gate closed, by the owner's decision. The autonomy PRD (§10) plans a combined field period of at least 14 days and an evaluation of 0.4.1 against this build before release. The field period opened on 2026-10-01 and is still running, and the evaluation has not been run. Their results will be reported, and fixed in patch releases where needed."
      },
      {
        "kind": "heading",
        "text": "Sources"
      },
      {
        "kind": "paragraph",
        "text": "Autonomy PRD · Autonomy design · Orchestrator design · Dashboard design (§11) · Technical Design (§5, §7) · ADRs in force: ADR-017, ADR-018 (in part), ADR-019, ADR-020, ADR-021, ADR-022, ADR-023 (in part), ADR-024, ADR-025 · Role instructions · GUIDE.md · 0.4.1 notes"
      }
    ],
    "gitUrl": "https://github.com/hieunt286/paseo-bm/blob/v0.5.0/docs/releases/paseo-bm-release-notes-0.5.0.md"
  },
  {
    "version": "0.4.1",
    "title": "paseo-bm 0.4.1",
    "summary": "A patch for 0.4.0: a cleaner first run, and two edge cases made safe. Nothing changes in how the three agents work. Update with:",
    "blocks": [
      {
        "kind": "paragraph",
        "text": "A patch for 0.4.0: a cleaner first run, and two edge cases made safe. Nothing changes in how the three agents work. Update with:"
      },
      {
        "kind": "code",
        "text": "paseo plugin update paseo-bm"
      },
      {
        "kind": "paragraph",
        "text": "Only paseo-bm-plugin is published from this release on. The paseo-bm command stays at 0.4.0, its last version, and is marked deprecated on npm; it still does its one job, the legacy directory installer, for anyone coming from a 0.3.x install."
      },
      {
        "kind": "heading",
        "text": "What changed"
      },
      {
        "kind": "bullet",
        "text": "The first time you open Beads Manager reads cleanly. On a fresh install Paseo's agent tools are off, so Beads Manager does not start a Manager yet and says why. In 0.4.0 that line carried Paseo's own wrapping (Request failed: … requestType=plugin.rpc.invoke.request code=handlererror) and did not show the error code; now it reads Could not open Beads Manager (EPROVIDERUNAVAILABLE). … followed by the plugin's message. The same applies to every error line of the launcher and the agent tree."
      },
      {
        "kind": "bullet",
        "text": "That first message still says the roles were created. The call that creates the three roles is the same call that is refused while the tools are off, so the \"paseo-bm created its roles with defaults (…)\" sentence was lost; it now comes first in the message."
      },
      {
        "kind": "bullet",
        "text": "Setup describes the switch as it is. With the agent tools off, the Setup row now says \"Off — no new Beads Manager starts until you allow them\" instead of \"the Manager may not be able to create a Worker\"."
      },
      {
        "kind": "bullet",
        "text": "A fallback Switch no longer creates an agent that cannot work. When a Manager or Worker hits its plan limit and you choose Switch (or the Auto policy does) while Paseo's agent tools are off, paseo-bm used to create the replacement anyway, without Paseo's tools: a replacement Manager would then become the one Beads Manager opens, unable to create a Worker. Now nothing is created, the card stays pending, and it says to allow the tools and switch again."
      },
      {
        "kind": "bullet",
        "text": "A Worker or Reviewer moved to its profile's model drops a thinking level chosen for another model. 0.4.0 already starts them on the model set in Setup → Agents; a thinking level passed for the old model is now replaced by the profile's own. An OpenCode Worker's features are read for the model it will run on."
      },
      {
        "kind": "heading",
        "text": "What to know when upgrading"
      },
      {
        "kind": "bullet",
        "text": "Requires Paseo 0.9.0 or newer, as 0.4.0 did."
      },
      {
        "kind": "bullet",
        "text": "Agents created before the update keep working as they are; the changes apply to what is created afterwards and to the screens."
      },
      {
        "kind": "bullet",
        "text": "Coming from a 0.3.x directory install: run the legacy directory installer (it installs the plugin from npm), then paseo plugin update paseo-bm."
      },
      {
        "kind": "heading",
        "text": "Rollback"
      },
      {
        "kind": "paragraph",
        "text": "paseo plugin update paseo-bm --version 0.4.0. Your data folder and settings are the same in both versions."
      },
      {
        "kind": "heading",
        "text": "Evidence"
      },
      {
        "kind": "paragraph",
        "text": "npm run verify and npm run smoke:packed exited 0 on the tagged tree. Before publishing, the exact payload was packed as 0.4.1-rc.0 and installed through a registry mirror on isolated Paseo 0.9.2 daemons: updated from the real 0.4.0 (the Manager, history, roles and switch carried over, and a Manager created on 0.4.0 had its Worker and Reviewer started on Codex after the user moved them there), and installed fresh (the refusal wording on first and second open, no agent created while the tools were off, a stale Claude model with a Claude thinking level started on Codex, removal leaving nothing behind). paseo.cafe's security scanner reports no finding on the payload. Two independent review passes covered the code changes."
      },
      {
        "kind": "heading",
        "text": "Sources"
      },
      {
        "kind": "paragraph",
        "text": "Technical Design (§7.2, §7.3, §7.10, §7.13.2) · Dashboard design (§11.2, §11.3) · 0.4.0 notes"
      }
    ],
    "gitUrl": "https://github.com/hieunt286/paseo-bm/blob/v0.4.1/docs/releases/paseo-bm-release-notes-0.4.1.md"
  },
  {
    "version": "0.4.0",
    "title": "paseo-bm 0.4.0",
    "summary": "The plugin is now the whole product. You install paseo-bm from paseo.cafe — or with paseo plugin add npm:paseo-bm-plugin — and it sets itself up from its own Setup screen. The the legacy directory installer is retired; its last version does exactly one thing, described under Coming from the legacy directory installer.",
    "blocks": [
      {
        "kind": "paragraph",
        "text": "The plugin is now the whole product. You install paseo-bm from paseo.cafe — or with paseo plugin add npm:paseo-bm-plugin — and it sets itself up from its own Setup screen. The the legacy directory installer is retired; its last version does exactly one thing, described under Coming from the legacy directory installer."
      },
      {
        "kind": "paragraph",
        "text": "This is the stable release, on latest. It is 0.4.0-alpha.0 plus one clarification of the Manager's instructions (below), after the prerelease passed its acceptance on real Paseo 0.9.2 daemons. As in every release, paseo-bm and paseo-bm-plugin carry the same version."
      },
      {
        "kind": "paragraph",
        "text": "It needs Paseo 0.9.0 or newer. 0.9 is where Paseo learned to install a plugin from npm, which is the only install path this version has. On Paseo 0.8, keep paseo-bm@0.3.1."
      },
      {
        "kind": "heading",
        "text": "One install path, and a plugin that sets itself up"
      },
      {
        "kind": "bullet",
        "text": "Install from the listing, or one command. paseo plugin add npm:paseo-bm-plugin, updated with paseo plugin update paseo-bm. Before this release, installing from paseo.cafe gave you the screens but no agent roles, so the Manager could not create a Worker; that gap is what this version closes."
      },
      {
        "kind": "bullet",
        "text": "The three roles are created for you. The first time you open Beads Manager or Setup, paseo-bm creates whichever of bm-manager, bm-worker and bm-reviewer is missing, on the first provider Paseo reports as available and that provider's first model — the same defaults the old installer used. An entry that already exists is never changed, so a model or provider you set yourself is kept. Setup and the launcher both tell you it happened, and Setup → Agents is where you change it."
      },
      {
        "kind": "bullet",
        "text": "Nothing else happens without a press. Three steps grant something, so each is a button with a warning:"
      },
      {
        "kind": "bullet",
        "text": "Allow agent tools… turns on Paseo's daemon.mcp.injectIntoAgents. It applies to every agent on this machine, not only paseo-bm's, and paseo-bm writes down what the switch was before so removal can put it back. Until you press it, Beads Manager does not start: an agent only gets Paseo's tools when it is created, so a Manager started earlier could never create a Worker. Opening it says so and points at the button."
      },
      {
        "kind": "bullet",
        "text": "Install skills… runs the third-party skills CLI once, with the exact command shown first. It downloads from cuongntr/agent-skills (another author's repository) and has its own data collection; paseo-bm never writes to your skills folders itself."
      },
      {
        "kind": "bullet",
        "text": "Install br / bv runs the beads tools' own documented install command."
      },
      {
        "kind": "bullet",
        "text": "Setup shows the whole machine. Which roles exist and how they were created, whether Paseo's agent tools are on and who turned them on, each provider's sign-in with the command to run yourself, the required skills per agent and when the CLI last ran, br and bv, and which data folder this install uses."
      },
      {
        "kind": "heading",
        "text": "Removing it is a button, then one command"
      },
      {
        "kind": "paragraph",
        "text": "Paseo has no hook that runs when a plugin is removed, so Setup → Remove paseo-bm's settings… is the uninstall. It takes every bm- provider and agent profile out of Paseo (the three roles and their fallback aliases) and puts the agent-tools switch back — but only if paseo-bm turned it on. A second, separate question asks whether to delete the plugin's data; the default keeps it. Then:"
      },
      {
        "kind": "code",
        "text": "paseo plugin remove paseo-bm"
      },
      {
        "kind": "paragraph",
        "text": "Skipping the button leaves the bm- entries in your configuration. One file always survives even when you ask for the data to go — ui/setup-state.json — because it records that you removed the settings; without it, one plugin reload before you run paseo plugin remove would create the three roles again."
      },
      {
        "kind": "heading",
        "text": "The plugin owns its data folder"
      },
      {
        "kind": "paragraph",
        "text": "Before this release the plugin only trusted a folder that held an install.json written by the installer, so a paseo.cafe install had no history, no role instructions and no fallback settings. Now the plugin finds and creates its own folder: PASEOBMHOME if set, then the pointer /.paseo-bm/home.json, then /.paseo-bm, created at mode 0700 on the first write. A candidate that is your home directory, or overlaps Paseo's or an agent's directory, is refused — and paseo-bm then stops rather than quietly using the default, because splitting your data across two folders is worse than saying so. Setup → This install shows the folder and how it was found."
      },
      {
        "kind": "paragraph",
        "text": "Existing users keep everything in place: traces, ui/, role-extras.json and role-fallback.json are read where they already are, with no migration."
      },
      {
        "kind": "heading",
        "text": "Coming from the legacy directory installer"
      },
      {
        "kind": "paragraph",
        "text": "If you installed paseo-bm before this release, the plugin on your machine is a directory install. It never updates by itself, and installing the npm package on top of it is refused by Paseo with exactly:"
      },
      {
        "kind": "code",
        "text": "Plugin ID \"paseo-bm\" is already configured; choose another ID with --id"
      },
      {
        "kind": "paragraph",
        "text": "Do not choose another id: two copies of paseo-bm would both create roles and both inject instructions into your agents. Run this once instead:"
      },
      {
        "kind": "code",
        "text": "the legacy directory installer"
      },
      {
        "kind": "paragraph",
        "text": "It removes the directory plugin, installs npm:paseo-bm-plugin at the same version, and — if that fails — puts your directory install back exactly as it was. Your data folder, your roles and Paseo's switches are left alone. Afterwards /.paseo-bm/plugin/ and /.paseo-bm/backups/ are read by nothing and you can delete them by hand."
      },
      {
        "kind": "paragraph",
        "text": "That is all the paseo-bm command does now. install, doctor, uninstall and thirteen flags are retired: each one answers with the sentence that says where its job went, and exits 2 with ECOMMANDRETIRED. Its exit codes are 0 (migrated, or nothing to migrate, or a preview), 2 (retired command or flag), 3 (Paseo older than 0.9.0, no daemon, no CLI, or another paseo-bm holding the directory installation), 5 (the registered plugin is not one paseo-bm installed), 6 (no terminal and no --apply) and 7 (the npm plugin would not start; your directory install was put back)."
      },
      {
        "kind": "heading",
        "text": "What changed in agent behaviour"
      },
      {
        "kind": "bullet",
        "text": "The Manager answers in the language you write in. A Worker's BM-REPORT arrives in the Manager's chat as a message and is always English; in the acceptance run the Manager switched to English after one. Its instructions now say the user's language is the language of what the user typed, which a report or a notice never changes."
      },
      {
        "kind": "bullet",
        "text": "The Manager's Runtime facts now point a missing Worker skill at Beads Manager → Setup → Agent skills instead of at the retired the legacy directory installer."
      },
      {
        "kind": "bullet",
        "text": "manager.ensure reports what the machine still needs. Opening Beads Manager creates the roles if they are missing and shows one line under the Manager when it created them with defaults, or when Paseo's agent tools are off. With the agent tools off it creates no new Manager (an existing one still opens)."
      },
      {
        "kind": "bullet",
        "text": "A Worker or Reviewer always starts on the model its profile names. When you change a role's provider or model in Setup → Agents, a Manager or Worker that was already running used to keep asking for the old model, and a Worker moved from Claude to Codex then failed at its first turn. The plugin now starts it on the model you set, and logs one line when it had to correct one."
      },
      {
        "kind": "bullet",
        "text": "The Worker's profile note in Paseo's Agents tab now describes how it works since 0.3.1: a small change is made and checked directly, larger work gets beads, documents and a Reviewer, and it commits or pushes only when you ask. Only roles created from now on carry the new note."
      },
      {
        "kind": "bullet",
        "text": "Nothing else about how the three agents work changed in this release: the review budget, the sizing rules, the BM- block formats and the trace store are all as they were in 0.3.1."
      },
      {
        "kind": "heading",
        "text": "What to know when upgrading"
      },
      {
        "kind": "bullet",
        "text": "Paseo 0.9.0 or newer only. plugin/paseo-plugin.json declares requirements.paseo: \">=0.9.0\", so an older daemon refuses the plugin rather than loading a build that cannot reach its own install path."
      },
      {
        "kind": "bullet",
        "text": "A directory install never updates by itself. Run the legacy directory installer, as above."
      },
      {
        "kind": "bullet",
        "text": "On 0.4.0-alpha.0 from next, paseo plugin update paseo-bm now brings you to 0.4.0."
      },
      {
        "kind": "bullet",
        "text": "An old the legacy directory installer the migration stops with ERECORDSCHEMATOONEW (exit 3) and changes nothing; the the legacy directory installer suggests is this version."
      },
      {
        "kind": "bullet",
        "text": "Only agents created after the upgrade get the new instructions. Paseo does not let a plugin change an agent that already exists, so a Manager or Worker opened earlier keeps working as it did."
      },
      {
        "kind": "bullet",
        "text": "Your own additional role instructions (Setup → Agents) are kept and still come after the built-in ones."
      },
      {
        "kind": "bullet",
        "text": "The paseo-bm npm package still publishes at this version, for the migration. It is the last version that will; the package will then be marked deprecated with a pointer to paseo-bm-plugin."
      },
      {
        "kind": "heading",
        "text": "Rollback"
      },
      {
        "kind": "paragraph",
        "text": "A patch at 0.4.0 or later. Downgrading to 0.3.x is not a way back: a 0.3.x plugin does not trust a data folder whose install.json is missing or marked as migrated, so it would find no history. A user whose migration fell back is still running 0.3.1 exactly as before, with an unchanged install.json."
      },
      {
        "kind": "heading",
        "text": "Evidence"
      },
      {
        "kind": "paragraph",
        "text": "npm run verify (typecheck, plugin typecheck, lint, tests, build) exited 0 on the tagged tree, and npm run smoke:packed passed every check including that the paseo-bm tarball now carries only dist/ and that the payload tarball's manifest requires Paseo >=0.9.0. The new tests cover the data folder and its refusals, the ui/setup-state.json store, role creation and the cleaned-up gate, the agent-tools and skills buttons with their confirmations, the cleanup button's deletions and what it keeps, the Setup checklist model, and the migration end to end against a fake daemon: all five cases, both failure paths with the fallback, the write order, and that a run with nothing to do writes nothing at all."
      },
      {
        "kind": "paragraph",
        "text": "Before 0.4.0-alpha.0 was published, the exact tarballs were installed the way users install them, on isolated Paseo 0.9.2 daemons served by a test registry that mirrored npm with that version on next. The run covered a fresh install through Setup, a Medium request going Manager → Worker → beads → Reviewer on Claude and then on Codex, and the migration from a real paseo-bm@0.3.1 install, both default and --home. Three defects found there were fixed before publishing. After publishing, the same checks ran again against the real registry: paseo plugin add npm:paseo-bm-plugin@next resolved from registry.npmjs.org with the published integrity. A fresh install refused to start a Manager until the agent tools were allowed, then ran a Medium request with beads and a Reviewer. A Manager created before the user moved the Worker to Codex still asked for the Claude model, and the plugin started the Worker on Codex as set. Paseo refused paseo plugin add on top of a 0.3.1 directory install with the exact sentence quoted above, the legacy directory installer migrated it, and 0.3.1 then stopped at exit 3. paseo.cafe's security scanner reports no finding on the published tarball. The run record is docs/archive/operations/paseo-bm-install-run-20260926.md."
      },
      {
        "kind": "heading",
        "text": "Sources"
      },
      {
        "kind": "paragraph",
        "text": "ADR-012 · PRD (REQ-001 → REQ-015, REQ-027, REQ-031, REQ-070) · Technical Design (§3, §4, §5, §6, §7.2, §7.3, §7.13) · GUIDE.md · Run record · 0.4.0-alpha.0 notes"
      }
    ],
    "gitUrl": "https://github.com/hieunt286/paseo-bm/blob/v0.4.0/docs/releases/paseo-bm-release-notes-0.4.0.md"
  },
  {
    "version": "0.4.0-alpha.0",
    "title": "paseo-bm 0.4.0-alpha.0",
    "summary": "The plugin is now the whole product. You install paseo-bm from paseo.cafe — or with paseo plugin add npm:paseo-bm-plugin — and it sets itself up from its own Setup screen. The the legacy directory installer is retired; its last version does exactly one thing, described under Coming from the legacy directory installer.",
    "blocks": [
      {
        "kind": "paragraph",
        "text": "The plugin is now the whole product. You install paseo-bm from paseo.cafe — or with paseo plugin add npm:paseo-bm-plugin — and it sets itself up from its own Setup screen. The the legacy directory installer is retired; its last version does exactly one thing, described under Coming from the legacy directory installer."
      },
      {
        "kind": "paragraph",
        "text": "This is a prerelease on the next dist-tag. Install it with paseo plugin add npm:paseo-bm-plugin@next, and update it with paseo plugin update paseo-bm --version next. Do not run a plain paseo plugin update paseo-bm on this prerelease: Paseo updates to latest, which is still 0.3.1, so it would offer to downgrade you to a version that cannot read the new data folder. As in every release, paseo-bm and paseo-bm-plugin carry the same version."
      },
      {
        "kind": "paragraph",
        "text": "It needs Paseo 0.9.0 or newer. 0.9 is where Paseo learned to install a plugin from npm, which is the only install path this version has. On Paseo 0.8, keep paseo-bm@0.3.1."
      },
      {
        "kind": "heading",
        "text": "One install path, and a plugin that sets itself up"
      },
      {
        "kind": "bullet",
        "text": "Install from the listing, or one command. paseo plugin add npm:paseo-bm-plugin, updated with paseo plugin update paseo-bm (with --version next while you are on this prerelease). Before this release, installing from paseo.cafe gave you the screens but no agent roles, so the Manager could not create a Worker; that gap is what this version closes."
      },
      {
        "kind": "bullet",
        "text": "The three roles are created for you. The first time you open Beads Manager or Setup, paseo-bm creates whichever of bm-manager, bm-worker and bm-reviewer is missing, on the first provider Paseo reports as available and that provider's first model — the same defaults the old installer used. An entry that already exists is never changed, so a model or provider you set yourself is kept. Setup and the launcher both tell you it happened, and Setup → Agents is where you change it."
      },
      {
        "kind": "bullet",
        "text": "Nothing else happens without a press. Three steps grant something, so each is a button with a warning:"
      },
      {
        "kind": "bullet",
        "text": "Allow agent tools… turns on Paseo's daemon.mcp.injectIntoAgents. It applies to every agent on this machine, not only paseo-bm's, and paseo-bm writes down what the switch was before so removal can put it back. Until you press it, Beads Manager does not start: an agent only gets Paseo's tools when it is created, so a Manager started earlier could never create a Worker. Opening it says so and points at the button."
      },
      {
        "kind": "bullet",
        "text": "Install skills… runs the third-party skills CLI once, with the exact command shown first. It downloads from cuongntr/agent-skills (another author's repository) and has its own data collection; paseo-bm never writes to your skills folders itself."
      },
      {
        "kind": "bullet",
        "text": "Install br / bv runs the beads tools' own documented install command."
      },
      {
        "kind": "bullet",
        "text": "Setup shows the whole machine. Which roles exist and how they were created, whether Paseo's agent tools are on and who turned them on, each provider's sign-in with the command to run yourself, the required skills per agent and when the CLI last ran, br and bv, and which data folder this install uses."
      },
      {
        "kind": "heading",
        "text": "Removing it is a button, then one command"
      },
      {
        "kind": "paragraph",
        "text": "Paseo has no hook that runs when a plugin is removed, so Setup → Remove paseo-bm's settings… is the uninstall. It takes every bm- provider and agent profile out of Paseo (the three roles and their fallback aliases) and puts the agent-tools switch back — but only if paseo-bm turned it on. A second, separate question asks whether to delete the plugin's data; the default keeps it. Then:"
      },
      {
        "kind": "code",
        "text": "paseo plugin remove paseo-bm"
      },
      {
        "kind": "paragraph",
        "text": "Skipping the button leaves the bm- entries in your configuration. One file always survives even when you ask for the data to go — ui/setup-state.json — because it records that you removed the settings; without it, one plugin reload before you run paseo plugin remove would create the three roles again."
      },
      {
        "kind": "heading",
        "text": "The plugin owns its data folder"
      },
      {
        "kind": "paragraph",
        "text": "Before this release the plugin only trusted a folder that held an install.json written by the installer, so a paseo.cafe install had no history, no role instructions and no fallback settings. Now the plugin finds and creates its own folder: PASEOBMHOME if set, then the pointer /.paseo-bm/home.json, then /.paseo-bm, created at mode 0700 on the first write. A candidate that is your home directory, or overlaps Paseo's or an agent's directory, is refused — and paseo-bm then stops rather than quietly using the default, because splitting your data across two folders is worse than saying so. Setup → This install shows the folder and how it was found."
      },
      {
        "kind": "paragraph",
        "text": "Existing users keep everything in place: traces, ui/, role-extras.json and role-fallback.json are read where they already are, with no migration."
      },
      {
        "kind": "heading",
        "text": "Coming from the legacy directory installer"
      },
      {
        "kind": "paragraph",
        "text": "If you installed paseo-bm before this release, the plugin on your machine is a directory install. It never updates by itself, and installing the npm package on top of it is refused by Paseo with exactly:"
      },
      {
        "kind": "code",
        "text": "Plugin ID \"paseo-bm\" is already configured; choose another ID with --id"
      },
      {
        "kind": "paragraph",
        "text": "Do not choose another id: two copies of paseo-bm would both create roles and both inject instructions into your agents. Run this once instead:"
      },
      {
        "kind": "code",
        "text": "the legacy directory installer"
      },
      {
        "kind": "paragraph",
        "text": "It removes the directory plugin, installs npm:paseo-bm-plugin at the same version, and — if that fails — puts your directory install back exactly as it was. Your data folder, your roles and Paseo's switches are left alone. Afterwards /.paseo-bm/plugin/ and /.paseo-bm/backups/ are read by nothing and you can delete them by hand."
      },
      {
        "kind": "paragraph",
        "text": "That is all the paseo-bm command does now. install, doctor, uninstall and thirteen flags are retired: each one answers with the sentence that says where its job went, and exits 2 with ECOMMANDRETIRED. Its exit codes are 0 (migrated, or nothing to migrate, or a preview), 2 (retired command or flag), 3 (Paseo older than 0.9.0, no daemon, no CLI, or another paseo-bm holding the directory installation), 5 (the registered plugin is not one paseo-bm installed), 6 (no terminal and no --apply) and 7 (the npm plugin would not start; your directory install was put back)."
      },
      {
        "kind": "heading",
        "text": "What changed in agent behaviour"
      },
      {
        "kind": "bullet",
        "text": "The Manager's Runtime facts now point a missing Worker skill at Beads Manager → Setup → Agent skills instead of at the retired the legacy directory installer."
      },
      {
        "kind": "bullet",
        "text": "manager.ensure reports what the machine still needs. Opening Beads Manager creates the roles if they are missing and shows one line under the Manager when it created them with defaults, or when Paseo's agent tools are off. With the agent tools off it creates no new Manager (an existing one still opens)."
      },
      {
        "kind": "bullet",
        "text": "A Worker or Reviewer always starts on the model its profile names. When you change a role's provider or model in Setup → Agents, a Manager or Worker that was already running used to keep asking for the old model, and a Worker moved from Claude to Codex then failed at its first turn. The plugin now starts it on the model you set, and logs one line when it had to correct one."
      },
      {
        "kind": "bullet",
        "text": "The Worker's profile note in Paseo's Agents tab now describes how it works since 0.3.1: a small change is made and checked directly, larger work gets beads, documents and a Reviewer, and it commits or pushes only when you ask. Only roles created from now on carry the new note."
      },
      {
        "kind": "bullet",
        "text": "Nothing else about how the three agents work changed in this release: the review budget, the sizing rules, the BM- block formats and the trace store are all as they were in 0.3.1."
      },
      {
        "kind": "heading",
        "text": "What to know when upgrading"
      },
      {
        "kind": "bullet",
        "text": "Paseo 0.9.0 or newer only. plugin/paseo-plugin.json declares requirements.paseo: \">=0.9.0\", so an older daemon refuses the plugin rather than loading a build that cannot reach its own install path."
      },
      {
        "kind": "bullet",
        "text": "A directory install never updates by itself. Run the legacy directory installer, as above."
      },
      {
        "kind": "bullet",
        "text": "During the prerelease, the legacy directory installer ERECORDSCHEMATOONEW after a migration and suggests the legacy directory installer 0.4.0 is on latest, that is still 0.3.1: use @next."
      },
      {
        "kind": "bullet",
        "text": "On this prerelease, update with --version next. A plain paseo plugin update paseo-bm follows latest (0.3.1) and would downgrade you."
      },
      {
        "kind": "bullet",
        "text": "Only agents created after the upgrade get the new instructions. Paseo does not let a plugin change an agent that already exists, so a Manager or Worker opened earlier keeps working as it did."
      },
      {
        "kind": "bullet",
        "text": "Your own additional role instructions (Setup → Agents) are kept and still come after the built-in ones."
      },
      {
        "kind": "bullet",
        "text": "The paseo-bm npm package still publishes at this version, for the migration. It is the last version that will."
      },
      {
        "kind": "heading",
        "text": "Rollback"
      },
      {
        "kind": "paragraph",
        "text": "A patch at 0.4.0 or later. Downgrading to 0.3.x is not a way back: a 0.3.x plugin does not trust a data folder whose install.json is missing or marked as migrated, so it would find no history. A user whose migration fell back is still running 0.3.1 exactly as before, with an unchanged install.json."
      },
      {
        "kind": "heading",
        "text": "Evidence"
      },
      {
        "kind": "paragraph",
        "text": "npm run verify (typecheck, plugin typecheck, lint, tests, build) exited 0 on the tagged tree, and npm run smoke:packed passed every check including that the paseo-bm tarball now carries only dist/ and that the payload tarball's manifest requires Paseo >=0.9.0. The new tests cover the data folder and its refusals, the ui/setup-state.json store, role creation and the cleaned-up gate, the agent-tools and skills buttons with their confirmations, the cleanup button's deletions and what it keeps, the Setup checklist model, and the migration end to end against a fake daemon: all five cases, both failure paths with the fallback, the write order, and that a run with nothing to do writes nothing at all."
      },
      {
        "kind": "paragraph",
        "text": "Before publishing, the exact tarballs were installed the way users will install them: paseo plugin add npm:paseo-bm-plugin@next on isolated Paseo 0.9.2 daemons, served by a test registry that mirrors npm with this version on next. On those daemons: a fresh install ran through Setup, and a Medium request went Manager → Worker → beads → Reviewer on Claude, then again with the Worker and Reviewer on Codex. A real paseo-bm@0.3.1 install migrated with the legacy directory installer, both default and --home; the rerun did nothing, and 0.3.1 then refused to touch it. The skills button, paseo plugin update, and removal with and without the data were covered too. paseo.cafe's own security scanner reports no finding on the payload tarball. Three defects found by that run are fixed in this release: the Manager started before the agent tools were on, the stale Worker model after a provider change, and the Worker's profile note. The run record is docs/archive/operations/paseo-bm-install-run-20260926.md."
      },
      {
        "kind": "heading",
        "text": "Sources"
      },
      {
        "kind": "paragraph",
        "text": "ADR-012 · PRD (REQ-001 → REQ-015, REQ-027, REQ-031, REQ-070) · Technical Design (§3, §4, §5, §6, §7.13) · GUIDE.md · Plan"
      }
    ],
    "gitUrl": "https://github.com/hieunt286/paseo-bm/blob/v0.4.0-alpha.0/docs/releases/paseo-bm-release-notes-0.4.0-alpha.0.md"
  },
  {
    "version": "0.3.1",
    "title": "paseo-bm 0.3.1",
    "summary": "Less process for small work, and a Manager that does more of what it can already see. This release changes only how the three agents behave (their role instructions) and one rule of the Metric screen; the installer, the configuration, the data on disk and the BM- block formats are unchanged.",
    "blocks": [
      {
        "kind": "paragraph",
        "text": "Less process for small work, and a Manager that does more of what it can already see. This release changes only how the three agents behave (their role instructions) and one rule of the Metric screen; the installer, the configuration, the data on disk and the BM- block formats are unchanged."
      },
      {
        "kind": "paragraph",
        "text": "Installing this version: the legacy directory installer, or pin it with the legacy directory installer in every release, paseo-bm and paseo-bm-plugin carry the same version."
      },
      {
        "kind": "heading",
        "text": "The Worker: process follows the risk of the change"
      },
      {
        "kind": "bullet",
        "text": "A Small change has no bead and no Reviewer unless you ask for one. The Worker makes the change, runs the check that proves it, and reports the command and its result. Medium work gets beads written by hand and one review of the implementation; Large work also gets a review of its documents and beads before it builds. The review budget per request is unchanged (2 / 2 / 4) and is a ceiling, not a target: a Small request spends it only on a review you ask for."
      },
      {
        "kind": "bullet",
        "text": "The sizes are defined by consequence. Large means hard to undo, or changing what others consume — an interface, a format or stored data that other code or people use, or a recorded decision. How something looks, reads or works inside is not one of these, so a screen or wording change is no longer sized Large."
      },
      {
        "kind": "bullet",
        "text": "Documents follow the change. The Worker writes a document only where the change overturns something recorded (a decision, a contract, a schema). A document that only describes what it changes is corrected in place as part of the change, without asking you. Deviating from an approved decision, or editing a document your repository freezes, still waits for your answer."
      },
      {
        "kind": "bullet",
        "text": "A BM-ANSWERS entry may now be a fact the Manager verified, with its source. Anything in it that reads as a decision rather than a fact is asked again under a new question number, so a Manager's mistake cannot close one of your decisions."
      },
      {
        "kind": "heading",
        "text": "The Manager: answers what it can read, and keeps the Workers moving"
      },
      {
        "kind": "bullet",
        "text": "Rule 1 is now \"you change nothing\". The Manager never writes a file, touches a bead, or runs a build or test, but it may read. A question it can answer by reading — where a request or a Worker stands, what the beads say, what a file or function does, what git shows — it answers itself, naming what it read, without starting a Worker. Every change still goes to a Worker."
      },
      {
        "kind": "bullet",
        "text": "It coordinates the Workers inside what you already decided (ADR-011):"
      },
      {
        "kind": "bullet",
        "text": "it wakes a waiting Worker as soon as it sees what that Worker waits for (another Worker's report, an agent's status, git, br), sending the fact and where it read it;"
      },
      {
        "kind": "bullet",
        "text": "it answers a Worker's purely factual question (\"has A committed?\") in the BM-ANSWERS block; scope, approach, trade-offs and anything you must do stay yours;"
      },
      {
        "kind": "bullet",
        "text": "when two Workers would write the same files, beads or history, it holds one — never by delaying its creation — and wakes it when the first is done;"
      },
      {
        "kind": "bullet",
        "text": "it tells you before that it will wake a Worker and on what, and after, in one line, what it saw and sent, so you can overturn it; when unsure, it asks you."
      },
      {
        "kind": "heading",
        "text": "Metric: the workflow-step table"
      },
      {
        "kind": "paragraph",
        "text": "A Small request's bead, review and close steps now show as grey \"not needed\" (– step) instead of amber \"unknown\" (? step). If a Small request did have a bead or a review, the step still shows as done."
      },
      {
        "kind": "heading",
        "text": "What to know when upgrading"
      },
      {
        "kind": "bullet",
        "text": "Only agents created after the upgrade get the new instructions. Paseo does not let a plugin change an agent that already exists, so a Manager or Worker opened earlier keeps working as it did. To get the new Manager in a workspace, archive its old Manager in Paseo and open Beads Manager again."
      },
      {
        "kind": "bullet",
        "text": "No configuration, data or protocol change. /.paseo-bm/, install.json, the trace store, the bm- roles and their tools keep their shape; the BM-REPORT, BM-QUESTIONS, BM-ANSWERS and BM-REVIEW formats are unchanged; no error code or exit code changed."
      },
      {
        "kind": "bullet",
        "text": "Your own additional role instructions (Setup → Agents) are kept and still come after the built-in ones."
      },
      {
        "kind": "heading",
        "text": "Rollback"
      },
      {
        "kind": "paragraph",
        "text": "the legacy directory installer the previous version; it runs on the same Paseo versions (0.8 and 0.9.2). Agents created after the rollback get the 0.3.0 instructions back."
      },
      {
        "kind": "heading",
        "text": "Evidence"
      },
      {
        "kind": "paragraph",
        "text": "npm run verify (typecheck, plugin typecheck, lint, tests, build) exited 0 on the tagged tree: 124 test files passing, build successful. The role-content tests pin the new rules (Small without bead or review, documents corrected in place, the Manager answering reads and coordinating), and the workflow-step tests pin the Small skips."
      },
      {
        "kind": "heading",
        "text": "Sources"
      },
      {
        "kind": "paragraph",
        "text": "ADR-011 · PRD (REQ-020, REQ-022, REQ-024, REQ-025, REQ-026, REQ-036, REQ-037) · Worker instructions · Manager instructions · Dashboard PRD (REQ-045)"
      }
    ],
    "gitUrl": "https://github.com/hieunt286/paseo-bm/blob/v0.3.1/docs/releases/paseo-bm-release-notes-0.3.1.md"
  },
  {
    "version": "0.3.0",
    "title": "paseo-bm 0.3.0",
    "summary": "The first stable release, and the first one that works with Paseo 0.9.2.",
    "blocks": [
      {
        "kind": "paragraph",
        "text": "The first stable release, and the first one that works with Paseo 0.9.2."
      },
      {
        "kind": "paragraph",
        "text": "From this version on, the latest dist-tag is set by release.yml itself over OIDC. Until now every version was a prerelease going to next, and latest was moved by hand by the owner with npm dist-tag add — a step that needs a one-time password, and it has just gone away. Before this version latest pointed at 0.3.0-alpha.7 (measured with npm view paseo-bm dist-tags right before the release)."
      },
      {
        "kind": "paragraph",
        "text": "Installing this version: the legacy directory installer, or pin it with the legacy directory installer way you install does not change. As in every release, the two packages paseo-bm and paseo-bm-plugin carry the same version."
      },
      {
        "kind": "heading",
        "text": "The installer works with Paseo 0.9.2"
      },
      {
        "kind": "paragraph",
        "text": "Paseo 0.9.2 dropped the cliVersion field from paseo daemon status --json, and with 0.3.0-alpha.7 and every version before it the version check therefore fails. Each command suffers differently: install stops right there with exit 3 (EPASEOOUTPUTUNEXPECTED) and writes nothing; doctor reports the daemon check as an error, carries on, and ends with exit 1; uninstall carries on without a single answer from Paseo, so with --apply it still removes what the install record names and leaves behind only the plugin registration and that record (without --apply, uninstall only prints a preview and writes nothing). In short: on Paseo 0.9.2 you cannot install, and the other two commands run blind."
      },
      {
        "kind": "bullet",
        "text": "Where cliVersion is missing, the installer reads paseo --version and takes the first line as the CLI version; the rule of ADR-004 is unchanged (the CLI must match the daemon, >= 0.8.0)."
      },
      {
        "kind": "bullet",
        "text": "Where cliVersion is present — that is, on Paseo 0.8 — the behaviour is unchanged and paseo --version is never called."
      },
      {
        "kind": "bullet",
        "text": "If paseo --version is empty, it still stops with EPASEOOUTPUTUNEXPECTED (naming cliVersion); if paseo --version fails (a non-zero exit code), the CLI's own error surfaces under EDAEMONUNREACHABLE. For install, both paths are exit 3 and write nothing; doctor and uninstall react as described above."
      },
      {
        "kind": "paragraph",
        "text": "If you are running Paseo 0.9.x, this is the reason to move up to this version."
      },
      {
        "kind": "heading",
        "text": "The interface: a kanban by status, quiet text, Setup in tabs, an error count"
      },
      {
        "kind": "bullet",
        "text": "The Beads screen is four kanban columns — In progress → Blocked → Ready → Closed, each column headed by its name and count, and an empty column still shows, so the layout does not jump when you filter. A wide window puts the columns side by side; a phone and a narrow window show one column at a time, chosen from a row of status tabs that a screen reader can read. No feature is lost in the narrow layout."
      },
      {
        "kind": "bullet",
        "text": "Closed beads are shown by default. Closed is a column like any other; the eye button still hides and shows it with its count, remembers that for the app session, and returns to the default (shown) after a reload."
      },
      {
        "kind": "bullet",
        "text": "Status speaks in words, not in colour. Everywhere a bead is shown — the Beads screen, the \"Beads\" tab, the \"Beads in this chat\" panel, the bead chips in chat cards, the numbers on the workspace row — status uses text and contrast alone: unfinished in the normal text colour, closed in a dimmed one. No orange, no red, no green; the chip still spells out Ready / In progress / Blocked / Closed, so status is never carried by colour alone."
      },
      {
        "kind": "bullet",
        "text": "Outside the places that show beads, colour is untouched: the red error lines and yellow warnings on Metric, on Setup, in the chat cards and in the fallback cards are unchanged — a real failure must still hit you in the eye."
      },
      {
        "kind": "bullet",
        "text": "Setup is split into three tabs: Beads tools (br, bv), Agent skills, Agents (Roles & models + Additional instructions). The overall status line and the warnings about the tools sit above the tab row, so no tab can hide a problem."
      },
      {
        "kind": "bullet",
        "text": "The \"Errors\" tile on the Metric screen counts how many times a request failed, whatever the reason: a turn that ended failed, an agent that ended in the error state, and every provider fallback incident. Each death is counted once, even when several sources record it."
      },
      {
        "kind": "bullet",
        "text": "The result line of the three bead actions (Assign a Worker / Close / Delete) survives the bead moving to another column on the next refresh; only an open confirmation card closes."
      },
      {
        "kind": "heading",
        "text": "One change on the release path"
      },
      {
        "kind": "bullet",
        "text": "release.yml accepts a version that is not a prerelease and sets the dist-tag from the kind of version: prerelease → next, stable → latest. Before this version the workflow refused every stable version outright and only ever set next."
      },
      {
        "kind": "bullet",
        "text": "Because npm publish --tag latest runs over OIDC in the same run, a stable version no longer needs the npm dist-tag add step that asks for a one-time password."
      },
      {
        "kind": "bullet",
        "text": "The GitHub Release's prerelease flag must agree with the shape of the version; flag it wrongly and the workflow goes red before anything is published. Everything else is unchanged: two packages at one version, provenance, the release.yml file name, the whole check matrix."
      },
      {
        "kind": "heading",
        "text": "What to know when upgrading"
      },
      {
        "kind": "bullet",
        "text": "next still points at 0.3.0-alpha.7, which is older than latest. That is ordinary npm semantics: next is where a prerelease goes. If you use the legacy directory installer want the stable version, use the legacy directory installer pin @0.3.0."
      },
      {
        "kind": "bullet",
        "text": "No configuration, data or protocol change. /.paseo-bm/, install.json, the bm- roles and their tools keep their shape; no error code and no exit code changed."
      },
      {
        "kind": "bullet",
        "text": "A Manager opened earlier keeps working as it did. As the 0.3.0-alpha.7 notes said, Paseo does not let a plugin change an agent that already exists; that is unchanged here."
      },
      {
        "kind": "bullet",
        "text": "After installing, remember to reload the plugin (or let the installer do it) for the new screens to take effect."
      },
      {
        "kind": "heading",
        "text": "Rollback"
      },
      {
        "kind": "paragraph",
        "text": "The project's way back is to release a 0.3.1 patch, not npm unpublish."
      },
      {
        "kind": "paragraph",
        "text": "Going back locally with the legacy directory installer works if you are on Paseo 0.8: on Paseo 0.9.2 that version cannot install — install stops with exit 3, as the first section says. Apart from that installer fix, 0.3.0-alpha.7 is missing only the interface work above and none of the core features (the BM- block-building tools, the question ledger and the provider fallback are all there)."
      },
      {
        "kind": "heading",
        "text": "Evidence"
      },
      {
        "kind": "paragraph",
        "text": "npm run verify exited 0 on exactly the tagged tree, run in a clean git worktree of that commit: 124 test files, 3052 tests passing, build successful. On GitHub this version also went through the macOS + Linux × Node 24 matrix with smoke:packed twice — once as a rehearsal and once for the release event itself — and was then published over OIDC with provenance."
      },
      {
        "kind": "heading",
        "text": "Sources"
      },
      {
        "kind": "paragraph",
        "text": "PRD delta REQ-069 · design delta kanban-quiet-colours · design delta stable-release · the 0.3.0 release plan delta · ADR-009"
      }
    ],
    "gitUrl": "https://github.com/hieunt286/paseo-bm/blob/v0.3.0/docs/releases/paseo-bm-release-notes-0.3.0.md"
  },
  {
    "version": "0.3.0-alpha.7",
    "title": "paseo-bm 0.3.0-alpha.7",
    "summary": "A feature release: Manager, Worker and Reviewer build their BM- blocks with schema-checked tools served by the plugin, instead of writing the block themselves and leaving the plugin to guess it back with regular expressions. Alongside that, the Worker decides more and asks less, and a question already answered is not asked again. Use it as --notes-file as the release runbook describes.",
    "blocks": [
      {
        "kind": "paragraph",
        "text": "A feature release: Manager, Worker and Reviewer build their BM- blocks with schema-checked tools served by the plugin, instead of writing the block themselves and leaving the plugin to guess it back with regular expressions. Alongside that, the Worker decides more and asks less, and a question already answered is not asked again. Use it as --notes-file as the release runbook describes."
      },
      {
        "kind": "paragraph",
        "text": "Installing this version: the legacy directory installer, or pin it with the legacy directory installer way you install does not change. As in every release, the two packages paseo-bm and paseo-bm-plugin carry the same version."
      },
      {
        "kind": "heading",
        "text": "Block-building tools (ADR-010)"
      },
      {
        "kind": "bullet",
        "text": "Every bm- agent created after the install has exactly one tool of its own role: the Manager bmanswers, the Worker bmreport, the Reviewer bmreview. The tool checks its input, returns per-field errors inside the same turn, and gives back the block for the agent to send verbatim — the BM-FORMAT round trip is gone."
      },
      {
        "kind": "bullet",
        "text": "The block text is unchanged: the chat cards, the Metric screen, the traces and the question ledger read exactly as before."
      },
      {
        "kind": "bullet",
        "text": "The plugin serves the tools on 127.0.0.1 from its own process; the port is kept in /.paseo-bm/ui/agent-tools.json, so a live agent keeps its tool across plugin reloads. The tool only builds text: it reads nothing, writes nothing and sends nothing."
      },
      {
        "kind": "bullet",
        "text": "The tool is attached only to an agent running Claude, Codex or OpenCode — the providers where Paseo can pre-approve a tool. On any other provider (Pi, Copilot and so on) Paseo refuses to create an agent that carries a tool, so there the agent writes the block itself, as before."
      },
      {
        "kind": "bullet",
        "text": "The hand-written path stays for good as the fallback, and is still checked by BM-FORMAT."
      },
      {
        "kind": "heading",
        "text": "The Worker decides more, and asks in the right places"
      },
      {
        "kind": "bullet",
        "text": "The Worker decides everything reversible inside the request's scope and records it in the decided field for the user to overturn; it asks only about scope, about what cannot be undone, about what only the user has, or when it is stuck."
      },
      {
        "kind": "bullet",
        "text": "The Small/Medium/Large tier measures the risk of the change the Worker designs, not what the user already spelled out; a request that needs no design gets no bead and no Reviewer."
      },
      {
        "kind": "bullet",
        "text": "Suggestions that were not acted on have a field of their own, suggestions."
      },
      {
        "kind": "heading",
        "text": "A question already answered is not asked again"
      },
      {
        "kind": "bullet",
        "text": "An answer — from a card or through the Manager — is recorded as real state (the question ledger); the Manager receives BM-ANSWERED when the user answers the Worker directly and does not relay it."
      },
      {
        "kind": "bullet",
        "text": "The plugin's notices (BM-FORMAT, BM-ANSWERED and the rest) and an answer sent from a card appear as small cards in the chat instead of raw text."
      },
      {
        "kind": "heading",
        "text": "Fixes"
      },
      {
        "kind": "bullet",
        "text": "The format checker joins the streamed pieces before checking: 13 of the 17 BM-FORMAT notices sent to a Reviewer were false alarms caused by reading one piece at a time."
      },
      {
        "kind": "bullet",
        "text": "A tier line with a note after the bracket is no longer treated as a template error."
      },
      {
        "kind": "bullet",
        "text": "The traces no longer read a plugin notice as a review or a report; parseReviews counts only the findings of the block it belongs to."
      },
      {
        "kind": "heading",
        "text": "Evidence"
      },
      {
        "kind": "paragraph",
        "text": "Two independent review rounds; 1100 seeded inputs read back correctly by every parser in the plugin; 7000 requests to the endpoint at 200 concurrent, 0 errors; four Managers in parallel over four projects, two rounds, 0 BM-FORMAT; a situation matrix (Codex through Paseo, Pi, OpenCode, a reload, an answer on a card, a Large request, a free-text answer). Record: the scale run."
      },
      {
        "kind": "heading",
        "text": "What to know when upgrading"
      },
      {
        "kind": "bullet",
        "text": "A Manager opened before this version has no tool (Paseo does not let a plugin change an agent that already exists); it keeps working, through the hand-written path. To give the Manager a tool, archive the old Manager and open a new one. Workers and Reviewers are created fresh for each request, so they have their tools."
      },
      {
        "kind": "bullet",
        "text": "The latest dist-tag of both packages is moved by hand by the owner; release.yml only sets next."
      },
      {
        "kind": "heading",
        "text": "Sources"
      },
      {
        "kind": "paragraph",
        "text": "ADR-010; the agent-tools design delta, qa-ledger, worker-autonomy, instruction-quality; PRD delta REQ-068."
      }
    ],
    "gitUrl": "https://github.com/hieunt286/paseo-bm/blob/v0.3.0-alpha.7/docs/releases/paseo-bm-release-notes-0.3.0-alpha.7.md"
  },
  {
    "version": "0.3.0-alpha.6",
    "title": "paseo-bm 0.3.0-alpha.6",
    "summary": "A packaging release: no new feature, and no change to the behaviour of the agents or of the installer. From this version on, every release produces two npm packages at the same version: paseo-bm (the installer, as before) and paseo-bm-plugin (the payload, whose package root is a loadable plugin). Use it as --notes-file as the release runbook describes.",
    "blocks": [
      {
        "kind": "paragraph",
        "text": "A packaging release: no new feature, and no change to the behaviour of the agents or of the installer. From this version on, every release produces two npm packages at the same version: paseo-bm (the installer, as before) and paseo-bm-plugin (the payload, whose package root is a loadable plugin). Use it as --notes-file as the release runbook describes."
      },
      {
        "kind": "paragraph",
        "text": "Installing this version: the legacy directory installer, or pin it with the legacy directory installer about the way you install changes."
      },
      {
        "kind": "heading",
        "text": "Why there is a second package"
      },
      {
        "kind": "paragraph",
        "text": "paseo.cafe can only list a plugin whose npm package root is the loadable payload itself: their security scan demands index.client.ts(x) or index.server.ts(x) at the plugin root, and for npm it always scans the tarball root. The paseo-bm package is an installer, so it can never pass that gate — the four gates in detail are in the listing record §4 and §10, the decision in ADR-009."
      },
      {
        "kind": "heading",
        "text": "Changes"
      },
      {
        "kind": "bullet",
        "text": "paseo-bm-plugin is a new package, its root holding paseo-plugin.json, index.client.tsx, index.server.ts, client/, server/, shared/, roles/, plus a README.md and a LICENSE of its own. Its version always equals the version of paseo-bm, it is published in the same release.yml run, with the same provenance."
      },
      {
        "kind": "bullet",
        "text": "Three version sources that cannot drift apart: package.json at the root, plugin/package.json, and PLUGINVERSION. The generator writes the last two from the first, and a test goes red when they differ."
      },
      {
        "kind": "bullet",
        "text": "The screenshots move to plugin/images/ for the listing page, and they are in no tarball: the payload package does not list them, the installer package excludes them with a negative pattern, and smoke:packed checks that on the real tarball."
      },
      {
        "kind": "bullet",
        "text": "plugin/LICENSE appears because MIT requires the licence to travel with every copy, and the payload package is a distribution of its own."
      },
      {
        "kind": "heading",
        "text": "Warning: installing the payload package alone leaves the roles missing"
      },
      {
        "kind": "paragraph",
        "text": "paseo-bm-plugin loads, but it is only the payload: the three roles bm-manager, bm-worker and bm-reviewer are registered by the installer, not by the payload. Install it alone and the screens come up, but Beads Manager cannot create a Worker — the product does not work end to end."
      },
      {
        "kind": "paragraph",
        "text": "The command differs by Paseo version; only 0.9 and later has an npm source:"
      },
      {
        "kind": "code",
        "text": "# Paseo 0.9+\npaseo plugin add npm:paseo-bm-plugin@0.3.0-alpha.6\n# Paseo 0.8\npaseo plugin add hieunt286/paseo-bm --ref  --path plugin"
      },
      {
        "kind": "paragraph",
        "text": "The supported way to install is still the legacy directory installer."
      },
      {
        "kind": "heading",
        "text": "Unchanged"
      },
      {
        "kind": "bullet",
        "text": "The installer code, the plugin code, the role instructions, the --json contract, the commands and the exit codes: all as they were."
      },
      {
        "kind": "bullet",
        "text": "The latest dist-tag of paseo-bm is moved by hand by the owner; release.yml only sets next."
      },
      {
        "kind": "heading",
        "text": "Sources"
      },
      {
        "kind": "bullet",
        "text": "Request req-20260923T063441Z; ADR-009; the design delta; the plan delta phase 2a-20."
      }
    ],
    "gitUrl": "https://github.com/hieunt286/paseo-bm/blob/v0.3.0-alpha.6/docs/releases/paseo-bm-release-notes-0.3.0-alpha.6.md"
  },
  {
    "version": "0.3.0-alpha.5",
    "title": "paseo-bm 0.3.0-alpha.5",
    "summary": "A packaging release: no new feature, and no change to the behaviour of the agents or of the installer. Its only purpose is to put paseo-plugin.json at the root of the npm tarball, the condition for paseo-bm to be listed on paseo.cafe. Use it as --notes-file as the release runbook describes.",
    "blocks": [
      {
        "kind": "paragraph",
        "text": "A packaging release: no new feature, and no change to the behaviour of the agents or of the installer. Its only purpose is to put paseo-plugin.json at the root of the npm tarball, the condition for paseo-bm to be listed on paseo.cafe. Use it as --notes-file as the release runbook describes."
      },
      {
        "kind": "paragraph",
        "text": "Installing this version: the legacy directory installer, or pin it with the legacy directory installer view paseo-bm dist-tags says where latest is."
      },
      {
        "kind": "heading",
        "text": "Changes"
      },
      {
        "kind": "heading",
        "text": "The npm package"
      },
      {
        "kind": "bullet",
        "text": "paseo-plugin.json now sits at the root of the tarball beside package.json, README.md and LICENSE; dist/ and plugin/ are unchanged, and plugin/paseo-plugin.json stays exactly where it was. The paseo.cafe CI downloads the published package and reads the manifest at the tarball root, ignoring the path field, so without this file the entry cannot pass. The installer is unaffected: findPayloadRoot looks for /plugin/paseo-plugin.json, not for the file at the root."
      },
      {
        "kind": "heading",
        "text": "The repository (not in the npm package)"
      },
      {
        "kind": "bullet",
        "text": "paseo-plugin.json at the repository root, a byte-for-byte copy of plugin/paseo-plugin.json, with a test that goes red the moment the two files differ. This is the file the paseo.cafe scanner reads on GitHub."
      },
      {
        "kind": "bullet",
        "text": "The README renames two sections to Install and Limitations and warnings, the names the scanner looks for. Not a word of the content changed."
      },
      {
        "kind": "bullet",
        "text": "images/ holds three screenshots: the Beads screen, one request on the Metric screen, and the installer asking about the three roles."
      },
      {
        "kind": "bullet",
        "text": "docs/operations/paseo-bm-cafe-listing-20260923.md records the whole submission: the content of the registry file, their three CI gates, the risks accepted and the steps that remain."
      },
      {
        "kind": "heading",
        "text": "Warning: do not install with paseo plugin add npm:"
      },
      {
        "kind": "paragraph",
        "text": "Now that the tarball root carries a manifest, paseo plugin add npm:paseo-bm@0.3.0-alpha.5 will find a plugin and fail to load it: the package root has no index.client.tsx and no index.server.ts — the real payload is inside plugin/, and the payload cannot register the three bm- roles by itself either. Paseo keeps the broken entry in the configuration; remove it with paseo plugin remove paseo-bm."
      },
      {
        "kind": "paragraph",
        "text": "The only supported way to install is still the legacy directory installer, because it copies the payload, registers the plugin, registers the three roles and asks for consent. The paseo.cafe entry says exactly this in its first two caveats."
      },
      {
        "kind": "heading",
        "text": "Unchanged"
      },
      {
        "kind": "bullet",
        "text": "No change to the installer code, the plugin code, the role instructions or the --json contract."
      },
      {
        "kind": "bullet",
        "text": "The latest dist-tag is moved by hand by the owner; release.yml only sets next. Checked on 2026-09-23 with npm view paseo-bm dist-tags: latest and next were both at 0.3.0-alpha.4, so once the owner moves latest to this version, users of a bare the legacy directory installer from 0.3.0-alpha.4 to 0.3.0-alpha.5 — one packaging step, no behaviour change. (The dist-tag table in the 20260923 run record was taken right after the workflow, while latest was still at 0.2.0-alpha.1; the owner moved it afterwards.)"
      },
      {
        "kind": "heading",
        "text": "Sources"
      },
      {
        "kind": "bullet",
        "text": "Request req-20260923T063441Z — submitting the plugin to paseo.cafe."
      },
      {
        "kind": "bullet",
        "text": "The paseo.cafe listing record, in particular §4 (why a new entry must declare an npm package) and §9 (the release steps)."
      },
      {
        "kind": "bullet",
        "text": "PR paseo-cafe/paseo-cafe#215."
      }
    ],
    "gitUrl": "https://github.com/hieunt286/paseo-bm/blob/v0.3.0-alpha.5/docs/releases/paseo-bm-release-notes-0.3.0-alpha.5.md"
  },
  {
    "version": "0.3.0-alpha.4",
    "title": "paseo-bm 0.3.0-alpha.4",
    "summary": "A combined prerelease of the whole delta 20260921 (PRD delta, REQ-062 → REQ-067), plus one fix for the mobile app. Use it as --notes-file as the release runbook describes.",
    "blocks": [
      {
        "kind": "paragraph",
        "text": "A combined prerelease of the whole delta 20260921 (PRD delta, REQ-062 → REQ-067), plus one fix for the mobile app. Use it as --notes-file as the release runbook describes."
      },
      {
        "kind": "paragraph",
        "text": "> The first release since 0.2.0-alpha.1. Each of the six phases 2a-13 → 2a-18 had its own notes written, but none of those versions reached npm: 0.2.0-alpha.2 and 0.3.0-alpha.0 → 0.3.0-alpha.3 never existed on the registry. All of it is in this release. The per-phase notes are kept as history, linked below."
      },
      {
        "kind": "paragraph",
        "text": "Installing this version: the legacy directory installer, or pin it with the legacy directory installer bare the legacy directory installer the latest dist-tag, which does not point at this version yet; npm view paseo-bm dist-tags says where latest is."
      },
      {
        "kind": "heading",
        "text": "Changes"
      },
      {
        "kind": "heading",
        "text": "Roles and models"
      },
      {
        "kind": "bullet",
        "text": "Your profile is respected (2a-13). The thinking level and the features you set on the bm-worker / bm-reviewer profile apply to every agent created afterwards. the legacy directory installer now merges into the bm- entries instead of replacing them: the thinking, mode, features, icon and paseoTools.disabledTools you set all stay."
      },
      {
        "kind": "bullet",
        "text": "Every provider for every role (2a-14). Manager, Worker and Reviewer run on every Paseo provider that is available, including OpenCode and Pi. With it: a BM-TOOLS warning when a newly created agent has no Paseo tools, Pi and OpenCode skill columns on the Setup screen, and pricing from metadata.cost for a model that is not in the built-in price table."
      },
      {
        "kind": "bullet",
        "text": "The \"Roles & models\" screen (2a-15) in Beads Manager → Setup: one row per role, provider · model · thinking · mode, written straight into the Paseo configuration through config.patch. A change applies to agents created after the save; a running agent keeps its old values."
      },
      {
        "kind": "heading",
        "text": "Fallback when a provider fails"
      },
      {
        "kind": "bullet",
        "text": "\"Ask me\" for the Worker (2a-16). A Worker stopped by the provider's plan (usage limit, billing, login, provider down) → the plugin recognises it as the turn closes and shows a card. The fallback chain, up to three entries, is set on the Roles & models screen. The kind of failure is recognised by text patterns, editable in role-fallback.json; a temporary rate limit does not trigger a fallback."
      },
      {
        "kind": "bullet",
        "text": "Reviewer and Manager (2a-17). The same three buttons. Wait sends BM-RESUME to the old agent itself when the limit resets; I'll handle it leaves it to you."
      },
      {
        "kind": "bullet",
        "text": "\"Auto switch\" mode (2a-18, REQ-067). A third choice per role, beside Ask me (the default) and Off. With Auto switch, when an agent stops because of the provider's plan:"
      },
      {
        "kind": "bullet",
        "text": "the reset time is known and no more than 30 minutes away → the plugin waits (as if you had pressed Wait);"
      },
      {
        "kind": "bullet",
        "text": "otherwise, if there is a candidate → the plugin switches along the role's own path (Worker: a replacement Worker is created; Reviewer: the parent Worker is given the instructions; Manager: a replacement Manager is created);"
      },
      {
        "kind": "bullet",
        "text": "no candidate → the incident waits for you, as with Ask me."
      },
      {
        "kind": "paragraph",
        "text": "An automatic decision goes through exactly the path of a button press: the same lock, the same checks. The chat gets one card, already in the state that was chosen — there is no \"pending\" card before it. Choosing Auto switch shows a cost warning; for the Manager it also says the chat you are using may be replaced. Additive contract: roles.save-fallback accepts policy: \"auto\"."
      },
      {
        "kind": "heading",
        "text": "Fixes"
      },
      {
        "kind": "bullet",
        "text": "The Beads button on mobile opens its own workspace. Every Beads button on the header used to open the last workspace in the list Paseo returned, because Hermes lets closures created in one loop all see the final value. The desktop build was not affected."
      },
      {
        "kind": "heading",
        "text": "Known risks"
      },
      {
        "kind": "bullet",
        "text": "Auto switch has been checked only in part. Release condition REQ-067 (c) is met: one real incident, a refusal from Anthropic, was classified correctly by the pattern set (L4, checklist 18.1). The remaining acceptance items for Auto switch (18.2 → 18.6: the automatic switch, the automatic wait, the no-candidate case) have not been measured on a real daemon. Auto switch is off by default; turn it on per role."
      },
      {
        "kind": "bullet",
        "text": "No usage check before an agent is created (REQ-067 d): the candidate may be out of quota as well, and the replacement agent's own incident then walks the chain again."
      },
      {
        "kind": "bullet",
        "text": "One misclassified failure creates one agent too many — that costs money, and it puts two agents in the same code at once."
      },
      {
        "kind": "heading",
        "text": "Compatibility"
      },
      {
        "kind": "bullet",
        "text": "Every new RPC field is additive. The default policy is still \"Ask me\"; install.json keeps its shape."
      },
      {
        "kind": "bullet",
        "text": "roles[] in install.json now means \"what the installer wrote last\"; the configuration in force is the Paseo configuration."
      },
      {
        "kind": "bullet",
        "text": "A reinstall no longer returns the bm- entries to their defaults. If you used a reinstall to \"reset\" a role, use --role or --reconfigure instead."
      },
      {
        "kind": "bullet",
        "text": "policy: \"auto\" is safe with every 0.3.0-alpha. version. The schema of role-fallback.json has accepted \"auto\" since phase 2a-16, and the code before 2a-18 reads any policy that is not \"off\" as \"Ask me\" (the comment saying so is in plugin/client/setup-model.ts in the 2a-17 build; 2a-18 replaced that line with real auto support, so you will not find it in the current code). The fallback chain is kept, nothing is lost. The earlier phases' notes said an older build \"treats the whole file as unusable\" — that is not true. There is no other 0.3.0-alpha. on npm to go down to anyway."
      },
      {
        "kind": "heading",
        "text": "Rollback"
      },
      {
        "kind": "paragraph",
        "text": "The lightest way is not to downgrade: set the policy to \"Ask me\" or \"Off\" per role on the Roles & models screen. Where an agent was created automatically, archive whichever agent you no longer use."
      },
      {
        "kind": "paragraph",
        "text": "To go back a version properly, the only one on npm is 0.2.0-alpha.1 — 0.2.0-alpha.2 and 0.3.0-alpha.0 → .3 were never published. That is an expensive step back: 0.2.0-alpha.1 holds not one line of fallback or Roles & models code, so the legacy directory installer all of REQ-062 → REQ-067 — respecting your profile, every provider for every role, the Roles & models screen, and the fallback for all three roles. role-fallback.json then just sits there, read by nobody."
      },
      {
        "kind": "paragraph",
        "text": "If you downgrade anyway: set the policy back to \"Ask me\" or \"Off\" first, because 0.2.0-alpha.1 has no screen to set it from."
      }
    ],
    "gitUrl": "https://github.com/hieunt286/paseo-bm/blob/v0.3.0-alpha.4/docs/releases/paseo-bm-release-notes-0.3.0-alpha.4.md"
  },
  {
    "version": "0.3.0-alpha.3",
    "title": "paseo-bm 0.3.0-alpha.3",
    "summary": "Phase 2a-17 of delta 20260921 (PRD delta, REQ-066). Use it as --notes-file as the release runbook describes.",
    "blocks": [
      {
        "kind": "paragraph",
        "text": "Phase 2a-17 of delta 20260921 (PRD delta, REQ-066). Use it as --notes-file as the release runbook describes."
      },
      {
        "kind": "heading",
        "text": "Changes"
      },
      {
        "kind": "bullet",
        "text": "Fallback for the Reviewer. A Reviewer stopped by the provider's plan → a card in the Manager chat, with the same three buttons as for the Worker. Switch does not let the plugin create the agent: the parent Worker receives exact instructions to create the replacement Reviewer itself on bm-reviewer-fallback- (which has no Paseo tools) and to send it the old review message verbatim. That resend does not count as a new review call. If the notice is lost when the plugin reloads, the card has a Resend to Worker button."
      },
      {
        "kind": "bullet",
        "text": "Fallback for the Manager. A Manager stopped by the provider's plan → a card in its own chat. Switch creates a replacement Manager in the same workspace, with a handover built by code (the live Workers and their last reports, the pending questions, the open incidents, the last three messages you typed — with secrets redacted). Beads Manager opens the replacement; every live Worker is told the new Manager id through BM-SETTINGS. The old Manager stays until you archive it."
      },
      {
        "kind": "bullet",
        "text": "Roles & models shows the fallback chain for all three roles."
      },
      {
        "kind": "bullet",
        "text": "Wait and I'll handle it apply to every role (Wait sends BM-RESUME to the old agent itself when the limit resets)."
      },
      {
        "kind": "bullet",
        "text": "Additive contract: fallback.act gains the action resend."
      },
      {
        "kind": "heading",
        "text": "Not here yet"
      },
      {
        "kind": "bullet",
        "text": "Automatic mode (phase 2a-18) is not open: the phase may only start once at least one real incident has been recognised with the right kind, and there had been none when this phase closed."
      },
      {
        "kind": "heading",
        "text": "Known risks"
      },
      {
        "kind": "bullet",
        "text": "A replacement Reviewer is counted correctly only when the Worker sets the bm.replaces label; without it the resend is counted and may produce BM-BUDGET (failing safe: the Manager asks you)."
      },
      {
        "kind": "bullet",
        "text": "After a Manager has been replaced, the workspace's still-open incidents keep showing in the old Manager's chat."
      },
      {
        "kind": "heading",
        "text": "Compatibility"
      },
      {
        "kind": "bullet",
        "text": "Every new RPC field is additive."
      },
      {
        "kind": "heading",
        "text": "Rollback"
      },
      {
        "kind": "paragraph",
        "text": "Set the policy to \"Off\" for the Manager and the Reviewer on the Roles & models screen, or install the previous version: the legacy directory installer a Manager has been replaced: archive whichever Manager you no longer use."
      }
    ],
    "gitUrl": "https://github.com/hieunt286/paseo-bm/blob/v0.3.0-alpha.3/docs/releases/paseo-bm-release-notes-0.3.0-alpha.3.md"
  },
  {
    "version": "0.3.0-alpha.2",
    "title": "paseo-bm 0.3.0-alpha.2",
    "summary": "Phase 2a-16 of delta 20260921 (PRD delta, REQ-065). Use it as --notes-file as the release runbook describes.",
    "blocks": [
      {
        "kind": "paragraph",
        "text": "Phase 2a-16 of delta 20260921 (PRD delta, REQ-065). Use it as --notes-file as the release runbook describes."
      },
      {
        "kind": "heading",
        "text": "Changes"
      },
      {
        "kind": "bullet",
        "text": "A fallback Worker — \"Ask me\". When a Worker stops because of the provider's plan (usage limit, billing, login, provider down), the plugin recognises it as that turn ends and asks you with a card in the Manager chat, carrying a \"Fallback · N decision(s)\" pill:"
      },
      {
        "kind": "bullet",
        "text": "Switch to : the plugin creates a replacement Worker on the next entry of the fallback chain, in the same directory, with a handover built by code (the last report, the beads, the number of review calls, the original request). The replacement does not redo work already done and does not undo changes already made. The old Worker is marked \"replaced\"; its running Reviewer is told to stop."
      },
      {
        "kind": "bullet",
        "text": "Wait until : where the reset time is known (Claude, Codex), the plugin messages the old Worker itself to carry on after that time."
      },
      {
        "kind": "bullet",
        "text": "I'll handle it: no agent is touched."
      },
      {
        "kind": "bullet",
        "text": "The fallback chain on the Roles & models screen: under the Worker row, \"On a usage limit: Ask me / Off\" and up to three fallback entries (provider, model, thinking, mode), which you can add, remove and reorder."
      },
      {
        "kind": "bullet",
        "text": "Kind of failure: recognised by text patterns over the turn's error (editable in role-fallback.json, key patterns). A temporary rate limit and other errors do not trigger a fallback. A pattern with nested quantifiers ((a+)+, for instance) is dropped, because it can hang the plugin."
      },
      {
        "kind": "bullet",
        "text": "New files in the install directory, and they are your data: role-fallback.json, role-fallback-state.json. New aliases in the Paseo configuration: bm-worker-fallback-."
      },
      {
        "kind": "bullet",
        "text": "New RPCs roles.save-fallback, fallback.incidents, fallback.act; new error codes EFALLBACKNOTFOUND, EFALLBACKNOTPENDING, EFALLBACKNOCANDIDATE, EFALLBACKNORESET, EFALLBACKCREATEFAILED. New plugin notices: BM-FALLBACK, BM-HANDOVER, BM-RESUME."
      },
      {
        "kind": "heading",
        "text": "Known risks"
      },
      {
        "kind": "bullet",
        "text": "The default patterns have not been checked against a real incident; a broken turn that matches no pattern gets no card, as before."
      },
      {
        "kind": "bullet",
        "text": "The usage limit (listUsage) is read only after an L1 of Claude or Codex has been recognised, once per incident (accepted by the owner, Q2 a)."
      },
      {
        "kind": "bullet",
        "text": "Switching to a provider billed by token can cost money; the card shows the price where it is known."
      },
      {
        "kind": "heading",
        "text": "Compatibility"
      },
      {
        "kind": "bullet",
        "text": "Every new RPC field is additive. An older version that meets a bm-worker-fallback- alias does not recognise the role; uninstalling still removes those aliases."
      },
      {
        "kind": "heading",
        "text": "Rollback"
      },
      {
        "kind": "paragraph",
        "text": "Set the policy to \"Off\" on the Roles & models screen, or install the previous version: the legacy directory installer two new files stay behind harmlessly."
      }
    ],
    "gitUrl": "https://github.com/hieunt286/paseo-bm/blob/v0.3.0-alpha.2/docs/releases/paseo-bm-release-notes-0.3.0-alpha.2.md"
  },
  {
    "version": "0.3.0-alpha.1",
    "title": "paseo-bm 0.3.0-alpha.1",
    "summary": "Phase 2a-15 of delta 20260921 (PRD delta, REQ-064; ADR-008). Use it as --notes-file as the release runbook describes.",
    "blocks": [
      {
        "kind": "paragraph",
        "text": "Phase 2a-15 of delta 20260921 (PRD delta, REQ-064; ADR-008). Use it as --notes-file as the release runbook describes."
      },
      {
        "kind": "heading",
        "text": "Changes"
      },
      {
        "kind": "bullet",
        "text": "A \"Roles & models\" screen in Beads Manager → Setup. Each role (Manager, Worker, Reviewer) has one row: provider · model · thinking · mode, and an Edit button. You can change them without a terminal and without reinstalling."
      },
      {
        "kind": "bullet",
        "text": "Only values Paseo lists can be chosen: a provider that is available, a model of that provider, a thinking level of that model, a mode of that provider. Where a price is known, the form shows $in / $out per 1M tokens."
      },
      {
        "kind": "bullet",
        "text": "The Reviewer can never be given a dangerous or a planning mode."
      },
      {
        "kind": "bullet",
        "text": "Warnings, not blocks: Manager and Worker on the same base provider; Pi needing pi-mcp-adapter; a Reviewer on Pi or OpenCode."
      },
      {
        "kind": "bullet",
        "text": "Written straight into the Paseo configuration. The plugin writes the bm- profiles and aliases through config.patch, so Paseo's Settings → Agent profiles always shows exactly those values. Entries that are not bm- stay byte for byte as they were. If the configuration changed elsewhere since the form was opened, nothing is written and the form asks you to reopen it."
      },
      {
        "kind": "bullet",
        "text": "Live agents are told. A change applies to agents created after the save; a running agent keeps its old model and thinking. When a child agent's mode changes, the live Manager (for the Worker) and the live Worker (for the Reviewer) receive BM-SETTINGS with the new mode line, so their next creation is not refused by Paseo."
      },
      {
        "kind": "bullet",
        "text": "New RPCs: roles.settings, roles.options, roles.save-settings; new error codes EROLESETTINGSINVALID, EROLESETTINGSCONFLICT, EROLESETTINGSWRITEFAILED."
      },
      {
        "kind": "heading",
        "text": "Known risks (accepted by the owner, Q3 a, Q15 a)"
      },
      {
        "kind": "bullet",
        "text": "Paseo replaces the whole daemon.agentProfiles array on every write and has no conditional write. A change made in Paseo's own Settings that lands exactly while the plugin is writing can be overwritten with no warning. The plugin only narrows that window (it compares revision immediately before writing, writes once, holds a mutex)."
      },
      {
        "kind": "bullet",
        "text": "A pending BM-SETTINGS notice waits in memory: reloading the plugin loses it, and that agent falls back to the old behaviour (Paseo refuses the creation, the agent sends blocked)."
      },
      {
        "kind": "heading",
        "text": "Compatibility"
      },
      {
        "kind": "bullet",
        "text": "Every new RPC field is additive. roles.describe is unchanged. No data migration."
      },
      {
        "kind": "heading",
        "text": "Rollback"
      },
      {
        "kind": "paragraph",
        "text": "Install the previous version: the legacy directory installer already saved live in the Paseo configuration and keep working; to change them back, use Paseo's Settings or --role."
      }
    ],
    "gitUrl": "https://github.com/hieunt286/paseo-bm/blob/v0.3.0-alpha.1/docs/releases/paseo-bm-release-notes-0.3.0-alpha.1.md"
  },
  {
    "version": "0.3.0-alpha.0",
    "title": "paseo-bm 0.3.0-alpha.0",
    "summary": "Phase 2a-14 of delta 20260921 (PRD delta, REQ-063). Use it as --notes-file as the release runbook describes.",
    "blocks": [
      {
        "kind": "paragraph",
        "text": "Phase 2a-14 of delta 20260921 (PRD delta, REQ-063). Use it as --notes-file as the release runbook describes."
      },
      {
        "kind": "heading",
        "text": "Changes"
      },
      {
        "kind": "bullet",
        "text": "Every provider for every role. Manager, Worker and Reviewer run on every Paseo provider that is available, including OpenCode and Pi. The plugin picks how to run them from what the provider can do:"
      },
      {
        "kind": "bullet",
        "text": "Claude, Codex: as before."
      },
      {
        "kind": "bullet",
        "text": "OpenCode: an OpenCode agent (mode) is always passed — the one you choose on the profile, or the first one Paseo lists when you choose none. Manager and Worker enable autoaccept; the Reviewer never auto-approves."
      },
      {
        "kind": "bullet",
        "text": "Pi: no mode is passed. ## Runtime facts says \"none\", so Manager and Worker pass no mode either."
      },
      {
        "kind": "bullet",
        "text": "A warning when the Paseo tools are missing. A Worker created without the Paseo tools (Pi without pi-mcp-adapter) → the Manager receives BM-TOOLS and tells you. A Manager created without them → the Beads Manager screen shows a warning. The Setup screen shows the latest state."
      },
      {
        "kind": "bullet",
        "text": "Pi and OpenCode skill columns on the Setup screen (/.pi/agent/skills, /.config/opencode/skill), read-only."
      },
      {
        "kind": "bullet",
        "text": "Pi login: the installer prints the instructions instead of running the command."
      },
      {
        "kind": "bullet",
        "text": "Pricing from metadata.cost: a model that is not in the built-in price table but for which Paseo provides a price (an OpenCode model, for instance) is priced on the Dashboard. A turn record gains an optional runtime.provider field."
      },
      {
        "kind": "heading",
        "text": "Known risks (accepted by the owner, Q7 a)"
      },
      {
        "kind": "bullet",
        "text": "A Reviewer on Pi has no permission layer at all; a Reviewer on OpenCode runs with the permissions of the chosen OpenCode agent. In both cases the Reviewer's read-only rule lives in its instructions alone."
      },
      {
        "kind": "heading",
        "text": "Compatibility"
      },
      {
        "kind": "bullet",
        "text": "Every new RPC field is additive. The trace store does not migrate."
      },
      {
        "kind": "heading",
        "text": "Rollback"
      },
      {
        "kind": "paragraph",
        "text": "Install the previous version: the legacy directory installer an alias has had its extends moved to OpenCode or Pi, move it back with --role."
      }
    ],
    "gitUrl": "https://github.com/hieunt286/paseo-bm/blob/v0.3.0-alpha.0/docs/releases/paseo-bm-release-notes-0.3.0-alpha.0.md"
  },
  {
    "version": "0.2.0-alpha.2",
    "title": "paseo-bm 0.2.0-alpha.2",
    "summary": "Phase 2a-13 of delta 20260921 (PRD delta, REQ-062). Use it as --notes-file as the release runbook describes.",
    "blocks": [
      {
        "kind": "paragraph",
        "text": "Phase 2a-13 of delta 20260921 (PRD delta, REQ-062). Use it as --notes-file as the release runbook describes."
      },
      {
        "kind": "heading",
        "text": "Changes"
      },
      {
        "kind": "bullet",
        "text": "Profile thinking and features reach the Worker and the Reviewer. The thinking level and the features you set on the Worker (bm-worker) or Reviewer (bm-reviewer) profile in Paseo's Settings → Agent profiles now apply to every Worker and Reviewer created afterwards. Thinking is applied only when the agent runs the profile's own model, because each model has its own set of thinking levels. A value passed in by the creator still wins."
      },
      {
        "kind": "bullet",
        "text": "Reinstalling no longer wipes the configuration you set. the legacy directory installer now merges into the bm- entries of the Paseo configuration instead of replacing them: the thinking, mode, features, icon and paseoTools.disabledTools you set all stay. --role and --reconfigure change only the base provider, the model and the name of the role they name; changing the model drops the old thinking level."
      },
      {
        "kind": "bullet",
        "text": "doctor reports a role changed in the app. A new check roles.changed-in-app (level ok, exit code unchanged) says when a role's base provider or model differs from what the installer wrote last."
      },
      {
        "kind": "heading",
        "text": "Compatibility"
      },
      {
        "kind": "bullet",
        "text": "install.json keeps its shape. roles[] now means \"what the installer wrote last\"; the configuration in force is the Paseo configuration."
      },
      {
        "kind": "bullet",
        "text": "If you used a reinstall to bring a role back to its default: use --role or --reconfigure."
      },
      {
        "kind": "heading",
        "text": "Rollback"
      },
      {
        "kind": "paragraph",
        "text": "Install the previous version: the legacy directory installer is no data to clean up."
      }
    ],
    "gitUrl": "https://github.com/hieunt286/paseo-bm/blob/v0.2.0-alpha.2/docs/releases/paseo-bm-release-notes-0.2.0-alpha.2.md"
  }
];
