# AGENTS.md — paseo-bm

This file is the working guide for agents in this repository. Keep it concise and durable. Product
requirements, implementation details, research findings, and historical evidence belong in the
canonical documents linked below, not in this file.

## Mission and sources of truth

`paseo-bm` is a Paseo plugin that installs and coordinates the Beads Manager, Worker, Reviewer, and
Orchestrator roles. The shipped npm package is `paseo-bm-plugin`; the old `paseo-bm` installer ended
at version 0.4.0 and remains deprecated on npm, while its source lives only in Git history at the
`v0.4.0` tag.

Before changing an area, read only the relevant source of truth:

- [`docs/README.md`](docs/README.md) — documentation map and current document statuses.
- `docs/product/` — user outcomes and requirements.
- `docs/design/` — current technical behavior and contracts.
- `docs/adr/` — durable decisions; never rewrite an ADR, supersede it with a new one.
- `docs/operations/` — release, listing, evaluation, and manual-operation procedures.
- `docs/archive/` — immutable historical evidence; never edit it.
- `plugin/roles/` — exact behavior of each agent role.

Search first, then open the smallest relevant section. Do not copy detailed facts from these sources
into this guide.

## Language and documentation

Everything in this repository is written in English: code-facing text, role prompts, living docs,
release notes, and commit messages. `docs/archive/` preserves its original language and content.

Living documentation describes the product as it works now. Update an existing PRD or design in
place, preserve cited section numbers and requirement IDs, and add a Revision History entry for a
real change. Do not create delta documents for ordinary work. A plan exists only for one piece of
Designed work and is archived when complete.

## Repository map

- `plugin/` — source of the Paseo plugin.
- `plugin-package/` — generated published bundle; never hand-edit it.
- `test/` — Vitest product, benchmark, and evaluation tests.
- `scripts/` — generators, packed smoke checks, evaluation tooling, and manual-test helpers.
- `.beads/` — issue graph; change it only through `br`.
- `docs/` — living product, design, ADR, plan, operation, release, and archived records.

The stack is TypeScript ESM on Node 22+, with Vitest, ESLint, TypeScript, tsup, and esbuild. The
client uses React Native primitives; server/client contracts live under `plugin/shared/`.

## Choose the lightest safe lane

State the lane before starting and raise it when new risk appears.

- **Direct** — one local, reversible change with no consumed contract or durable decision change.
  Implement it, update describing docs, and verify it. No bead, plan, or review is required.
- **Tracked** — several ordered outcomes, work spanning sessions, or a handoff. Create short manual
  beads and close each with evidence.
- **Designed** — changes to consumed contracts or stored formats; credentials, permissions, agent
  modes, or safety boundaries; writes outside the install home; publishing/package architecture;
  dependencies; irreversible work; or agent-role behavior. Use `feature-workflow`, update the
  applicable PRD/design, add an ADR only for a durable new decision, and create a plan only when the
  work has a real dependency graph.

Treat rewording as Direct only when behavior and obligations remain unchanged.

## Working method

1. Read the user request, `git status --short`, and the relevant source-of-truth sections.
2. Preserve every pre-existing worktree change. Never revert, overwrite, stage, or reformat work
   you do not own.
3. Confirm scope and identify the proof before editing. Ask only when the repository cannot answer
   a decision that changes scope, safety, data, compatibility, or an irreversible action.
4. Make the smallest coherent change. Avoid opportunistic cleanup.
5. Run the narrowest meaningful check after the last edit, then the broader required checks for the
   affected area.
6. Report what changed, the exact checks and results, and any remaining risk or follow-up.

Use repository skills when their trigger applies. Do not create process artifacts merely to record
work already completed.

## Beads

Use Beads only for Tracked and Designed work.

```bash
br ready
br show <id>
br update <id> --status in_progress
br close <id> --reason "<evidence>"
br dep tree <id>
br lint -s all
br dep cycles
```

- Start from `br ready`; never force a blocked bead.
- One leaf is one reversible, observable outcome with its tests or evidence included.
- Every bead carries `feature:<slug>`. Tasks use `## Acceptance Criteria`; epics use
  `## Success Criteria`.
- Close only after reading the named proof pass. “Done” is not evidence.
- Never delete beads or hand-edit `.beads/issues.jsonl`; split or merge through `br` and preserve
  provenance.
- A bead may be clarified but may not acquire new scope.

`bv` and `bva` are read-only views over the same graph.

## Non-negotiable constraints

- Do not commit, push, publish, install or upgrade dependencies, modify real user data/configuration,
  or operate a live daemon unless the owner explicitly asks.
- Never read, store, or print credentials, tokens, private keys, `.env` files, or agent records.
- Do not weaken tests or acceptance criteria to make a check pass.
- Do not run `paseo daemon stop` or `paseo daemon restart` during development.
- Do not add install-time scripts. Downloading the npm package must not mutate the user's machine.
- Keep `package.json`, generated plugin versions, and `PLUGIN_VERSION` aligned through the build.
- Keep `.github/workflows/release.yml` named exactly as-is; trusted publishing depends on it.
- There is no root `paseo-plugin.json`. The only manifests belong in `plugin/` and generated
  `plugin-package/`.
- The published package is generated: after changing `plugin/`, run `npm run build` and commit the
  resulting `plugin-package/` changes with the source change.

## Verification

Choose checks proportionate to the change and run each after the final edit.

```bash
npm run typecheck
npm run lint
npm test
npm run build
npm run test:bench          # when benchmarked paths change
npm run test:eval           # when evaluation tooling changes
npm run smoke:packed        # when packaging changes
br lint -s all              # when beads change
br dep cycles               # when bead dependencies change
```

`npm run verify` runs type checks, lint, all test projects, and the build. For focused work, use
`npm test -- test/<name>.test.ts`, `npm run test:bench -- test/<name>-benchmark.test.ts`, or
`npm run test:eval -- test/eval-<name>.test.ts`.

Never claim a check you did not watch pass. If a check fails, fix the cause or report the failure.
