// GENERATED FILE — do not edit.
// Source: docs/releases/*.md via scripts/generate-release-notes.mjs.

/** One version: its summary paragraph and section headings; the prereleases folded into it, oldest first. */
export interface ReleaseNote { version: string; summary: string; sections: readonly string[]; prereleases: readonly string[]; gitUrl: string }

export const RELEASE_NOTES: readonly ReleaseNote[] = [
  {
    "version": "0.6.0",
    "summary": "A delivery line for missions. Each mission now works on its own branch, in its own worktree of each repository, and its Workers commit there; pushing and opening the merge request takes your yes once per mission and repository. A request ends at its first finished, and more work continues in a fresh Worker. No agent waits on a CI pipeline any more, a re-review checks only the diff of the fixes, and a waiting Worker is woken only for what it waits on. You get fewer cards, and each says what was really done.",
    "sections": [
      "What changed",
      "A branch per mission",
      "Bounded requests",
      "No agent waits on machines",
      "Review by milestone",
      "Fewer, clearer cards",
      "The governor",
      "Typed messages",
      "Screens",
      "Agent roles",
      "What to know when upgrading",
      "Rollback",
      "Evidence",
      "Sources"
    ],
    "prereleases": [],
    "gitUrl": "https://github.com/hieunt286/paseo-bm/blob/v0.6.0/docs/releases/paseo-bm-release-notes-0.6.0.md"
  },
  {
    "version": "0.5.6",
    "summary": "Work by mission instead of by repository. A mission is one goal you name — \"Ship card payments\" — with its own Main: a Beads Manager that works across every repository the goal needs, creates and links the Workers in each, keeps what is in flight, and asks you only what is yours to decide. Missions live in a Mission-List project in Paseo, one workspace per mission, and a new Missions screen shows each one. The Orchestrator becomes the governor of the missions' process. Projects can also ask each other through the plugin.",
    "sections": [
      "What changed",
      "Missions and their Mains",
      "The Missions screen",
      "The Orchestrator as governor",
      "Projects ask each other",
      "Agent roles",
      "What to know when upgrading",
      "Rollback",
      "Evidence",
      "Sources"
    ],
    "prereleases": [],
    "gitUrl": "https://github.com/hieunt286/paseo-bm/blob/v0.5.6/docs/releases/paseo-bm-release-notes-0.5.6.md"
  },
  {
    "version": "0.5.5",
    "summary": "Update paseo-bm from Settings, browse release notes from the same source used on GitHub, and navigate busy project screens with less scrolling. This release includes the update visibility introduced in 0.5.4 and adds a confirmed in-product update action, a unified changelog view, a compact Autonomy project picker, and mobile Bead details beside the selected task.",
    "sections": [
      "What changed",
      "What to know when upgrading",
      "Rollback",
      "Evidence",
      "Sources"
    ],
    "prereleases": [],
    "gitUrl": "https://github.com/hieunt286/paseo-bm/blob/v0.5.5/docs/releases/paseo-bm-release-notes-0.5.5.md"
  },
  {
    "version": "0.5.3",
    "summary": "Agents decide the content; the plugin now carries it reliably. This release moves Worker and Reviewer creation, delivery, question handling, review budgets and request identity onto caller-bound plugin tools, while preserving the hand-written path for providers that cannot pre-approve MCP tools.",
    "sections": [
      "What changed",
      "What to know when upgrading",
      "Rollback",
      "Evidence",
      "Sources"
    ],
    "prereleases": [],
    "gitUrl": "https://github.com/hieunt286/paseo-bm/blob/v0.5.3/docs/releases/paseo-bm-release-notes-0.5.3.md"
  },
  {
    "version": "0.5.2",
    "summary": "Packaged so paseo.cafe can list 0.5. Nothing changes in how the agents work or in the screens: the code that runs is the same as 0.5.1, packaged differently.",
    "sections": [
      "What changed",
      "What to know when upgrading",
      "Rollback",
      "Evidence",
      "Sources"
    ],
    "prereleases": [],
    "gitUrl": "https://github.com/hieunt286/paseo-bm/blob/v0.5.2/docs/releases/paseo-bm-release-notes-0.5.2.md"
  },
  {
    "version": "0.5.1",
    "summary": "The pictures now show 0.5. Nothing changes in how the agents work or in the screens.",
    "sections": [
      "What changed",
      "What to know when upgrading",
      "Rollback",
      "Evidence",
      "Sources"
    ],
    "prereleases": [],
    "gitUrl": "https://github.com/hieunt286/paseo-bm/blob/v0.5.1/docs/releases/paseo-bm-release-notes-0.5.1.md"
  },
  {
    "version": "0.5.0",
    "summary": "Calibrated autonomy: one coordinator for every project, questions you answer once, and one control per project for how much is decided without you. This is the largest release since the plugin became the product. It adds a fourth agent, the Beads Orchestrator. Every question put to you is now one stored decision, the same card wherever it appears, answered once. Each project gets an autonomy level, from Hands-on to Full auto. The screens are rebuilt around an Inbox. A new or updated install decides nothing for you until you raise a project's level.",
    "sections": [
      "What changed",
      "The Beads Orchestrator: one coordinator for every project",
      "Autonomy: one level per project",
      "A question is asked once, and answered once",
      "Hold risky actions for approval (per project, off by default)",
      "Seeing the work, and noticing when it breaks",
      "New screens",
      "How the agents behave",
      "Retired",
      "What to know when upgrading",
      "Rollback",
      "Evidence",
      "Sources"
    ],
    "prereleases": [],
    "gitUrl": "https://github.com/hieunt286/paseo-bm/blob/v0.5.0/docs/releases/paseo-bm-release-notes-0.5.0.md"
  },
  {
    "version": "0.4.1",
    "summary": "A patch for 0.4.0: a cleaner first run, and two edge cases made safe. Nothing changes in how the three agents work.",
    "sections": [
      "What changed",
      "What to know when upgrading",
      "Rollback",
      "Evidence",
      "Sources"
    ],
    "prereleases": [],
    "gitUrl": "https://github.com/hieunt286/paseo-bm/blob/v0.4.1/docs/releases/paseo-bm-release-notes-0.4.1.md"
  },
  {
    "version": "0.4.0",
    "summary": "The plugin is now the whole product. You install paseo-bm from paseo.cafe — or with paseo plugin add npm:paseo-bm-plugin — and it sets itself up from its own Setup screen. The the legacy directory installer is retired; its last version does exactly one thing, described under Coming from the legacy directory installer.",
    "sections": [
      "One install path, and a plugin that sets itself up",
      "Removing it is a button, then one command",
      "The plugin owns its data folder",
      "Coming from the legacy directory installer",
      "What changed in agent behaviour",
      "What to know when upgrading",
      "Rollback",
      "Evidence",
      "Sources"
    ],
    "prereleases": [
      "0.4.0-alpha.0"
    ],
    "gitUrl": "https://github.com/hieunt286/paseo-bm/blob/v0.4.0/docs/releases/paseo-bm-release-notes-0.4.0.md"
  },
  {
    "version": "0.3.1",
    "summary": "Less process for small work, and a Manager that does more of what it can already see. This release changes only how the three agents behave (their role instructions) and one rule of the Metric screen; the installer, the configuration, the data on disk and the BM- block formats are unchanged.",
    "sections": [
      "The Worker: process follows the risk of the change",
      "The Manager: answers what it can read, and keeps the Workers moving",
      "Metric: the workflow-step table",
      "What to know when upgrading",
      "Rollback",
      "Evidence",
      "Sources"
    ],
    "prereleases": [],
    "gitUrl": "https://github.com/hieunt286/paseo-bm/blob/v0.3.1/docs/releases/paseo-bm-release-notes-0.3.1.md"
  },
  {
    "version": "0.3.0",
    "summary": "The first stable release, and the first one that works with Paseo 0.9.2.",
    "sections": [
      "The installer works with Paseo 0.9.2",
      "The interface: a kanban by status, quiet text, Setup in tabs, an error count",
      "One change on the release path",
      "What to know when upgrading",
      "Rollback",
      "Evidence",
      "Sources"
    ],
    "prereleases": [
      "0.3.0-alpha.0",
      "0.3.0-alpha.1",
      "0.3.0-alpha.2",
      "0.3.0-alpha.3",
      "0.3.0-alpha.4",
      "0.3.0-alpha.5",
      "0.3.0-alpha.6",
      "0.3.0-alpha.7"
    ],
    "gitUrl": "https://github.com/hieunt286/paseo-bm/blob/v0.3.0/docs/releases/paseo-bm-release-notes-0.3.0.md"
  },
  {
    "version": "0.2.0-alpha.2",
    "summary": "Phase 2a-13 of delta 20260921 (PRD delta, REQ-062). Use it as --notes-file as the release runbook describes.",
    "sections": [
      "Changes",
      "Compatibility",
      "Rollback"
    ],
    "prereleases": [],
    "gitUrl": "https://github.com/hieunt286/paseo-bm/blob/v0.2.0-alpha.2/docs/releases/paseo-bm-release-notes-0.2.0-alpha.2.md"
  }
];
