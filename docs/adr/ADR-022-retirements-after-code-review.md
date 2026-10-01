# ADR-022 — Retire the installer source, the 0.3.x migration banner, the 0.4.1 downgrade promise and the fallback chain's automatic switch

| Field | Value |
|---|---|
| Status | **Accepted** (2026-09-30) — decided by the owner |
| Date | 2026-09-30 |
| Owner | hieu.nt10 |
| Supersedes | [ADR-012](ADR-012-plugin-is-the-product.md): its fix path for the `paseo-bm` migration command (republish from `src/` per release runbook §7) and the migration banner; the orchestrator design's promise that a machine can go back from the new build to `paseo-bm-plugin@0.4.1` with its data intact; the fallback chain's **Auto switch** mode ([dashboard design](../design/paseo-bm-dashboard.md) fallback block, base PRD worker-fallback requirements) |
| Related | [Code review of 2026-09-30](../archive/operations/paseo-bm-code-review-20260930.md) · [ADR-018](ADR-018-calibrated-autonomy-per-class.md) · autonomy PRD REQ-171 (no rollback path between phases) |
| The owner's decisions | 2026-09-30, after the code review: (1) delete the installer source; (2) delete the migration banner; (3) drop the downgrade promise; (4) fold the fallback automatic switch into delegating the `environment` class |

## Context

The code review of 2026-09-30 measured four pieces of weight left from earlier releases.

- **`src/`**, the `paseo-bm` installer and migration command: 6,728 lines, plus 6,793 lines of its tests. Its last release was 0.4.0 and the package is deprecated. Every `npm run build` and `prepack` still bundles it, and the packed smoke mostly exercises it.
- **The 0.3.x migration banner** (`install-home.ts`, `setup-machine.ts`, the contract field `install.kind`). The base design says it can essentially never show.
- **The frozen `test/fixtures/v0.4.1` bundle and `plugin-orchestrator-compat.test.ts`.** They keep a downgrade to 0.4.1 working. That promise predates REQ-171, which makes a clean reinstall the remedy between phases.
- **The fallback chain's Auto switch.** When a role hits a usage limit, it picks a fallback option by itself, skipping the agreement ledger, the Inbox digest and demotion. Delegating the `environment` class (ADR-018, every fallback incident is `environment`) now does the same job under the owner's policy.

## Decision

1. **The installer source is deleted.** That means `src/`, its tests and harnesses, `tsup.config.ts`, and the root package's `bin`, `files` and `prepack`.
   - The root `package.json` stays private. `npm run build` only regenerates the plugin's version and instruction modules.
   - The packed smoke keeps only the payload package.
   - Should the 0.4.0 migration command ever need a fix, it is made on a branch from the `v0.4.0` tag, following release runbook §7 there.
   - Before deletion, the credential guard test, the one mechanical proof that nothing reads credentials, is ported to the plugin server.
2. **The migration banner is deleted:** its server detection, its client lines, and the contract field `install.kind`, which is removed from the setup contract.
3. **The downgrade promise is dropped.** The frozen 0.4.1 bundle and its compatibility test are deleted. Going back to 0.4.1 is a clean reinstall; the data folder is kept as it is, with no promise that 0.4.1 reads what later builds wrote.
4. **The fallback chain's Auto switch is removed.** A role's fallback setting is **Ask me** or **Off**.
   - A fallback incident is an `f:` decision of class `environment`.
   - It is answered by itself only when the owner has delegated `environment` for that project (the recommended predictor answers at open, or the Orchestrator decides with `bm_decide`) or a precedent answers it.
   - It is then recorded in the ledger, listed in the digest, and demoted on a reversal like any delegated decision.
   - A machine that had Auto switch on reads it as **Ask me** (REQ-171: no compatibility layer); the Settings screen says so once.

## Consequences

- About 13,500 lines less code and tests; faster builds and a shorter smoke.
- The single-package rule gets simpler: the repository builds and ships only `paseo-bm-plugin`.
- The migration command is still fixable, from its tag.
- There is one way for the plugin to answer an incident by itself, and it is measured.
- A fallback that used to switch by itself now asks the owner until `environment` is delegated. That is a behaviour change for anyone who had Auto switch on, and Settings tells them.

## Alternatives considered

- **Keep `src/` frozen in place.** Rejected: it costs every build, the smoke and 10 % of the tests, and protects nothing the tag does not.
- **Keep Auto switch beside the policy.** Rejected: two self-answering paths, and one of them unmeasured.
