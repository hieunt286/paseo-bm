# ADR-002 — An install record with checksums, atomic writes and backups; no full transaction journal

| Field | Value |
|---|---|
| Status | Accepted (amended 2026-09-16 — see the last section) |
| Date | 2026-09-14 |
| Owner | hieu.nt10 |
| Amended by | [ADR-012](ADR-012-plugin-is-the-product.md) (2026-09-25): the install record now exists only for existing users. Decisions 1–7 apply only to installers up to 0.3.1 (from 0.4.0 Paseo holds the package, and there is no payload left to hash, back up or keep side by side); decision 9 is used to stop old installers: CLI 0.4.0 marks `install.json` as migrated with `schemaVersion: 2` |
| Related | [PRD REQ-004, REQ-008, REQ-009, REQ-010, REQ-012](../product/paseo-bm-prd.md#6-functional-requirements), [ADR-001](ADR-001-plugin-distribution.md), [Technical Design](../design/paseo-bm.md) |

## Context

paseo-bm writes to the user's machine and must meet four PRD requirements at once: running again changes nothing (REQ-009), a file the user has edited is not overwritten (REQ-008), uninstalling removes exactly what it owns (REQ-012), and an interruption leaves no half-written file (REQ-010c).

Two models were surveyed:

- **paseo-room**: each entry is a `dir` / `file` / `link`, compared with the disk, then `rm` + rewritten when it differs. No backup, no atomicity, no file list in the `room.json` marker. Consequence: hand edits are silently overwritten; uninstalling is an `rm -rf` of the whole directory. That team **deliberately dropped** a v1 installer with a journal, rollback and a lock (~10k lines) because it was too heavy.
- **Paseo's own skills installer**: writes transactionally with a `.paseo-skills-transaction-*` directory, `transaction.json`, `backup/`, a `.paseo-skills-recovered-*` quarantine area, plus `.paseo-managed-files.json` holding the sha256 of every file.

An important difference in scope: paseo-bm writes only **one payload directory tree that it owns entirely** plus **one small change in Paseo's `config.json`** (ADR-004). It does not scatter files into anyone else's directory — which is why the full transaction machinery is not needed.

## Decision

1. **The install record** `<install home>/install.json`, with a `schemaVersion`, records: the version, the time, the Paseo home path used, the list of every payload file with its `sha256` and permissions, the changes made to Paseo, and the interaction state for skills. It is **the source of truth for ownership**: not in the record means not paseo-bm's.
2. **Atomic writes, file by file**: write to a temporary file in the same directory, `fsync`, then `rename`. Never `rm` and then rewrite.
3. **Write only when different**: compare the `sha256` first; if it is the same, the file is not touched (guarantees REQ-009).
4. **Classify the target before writing**: *ours and matching the hash* → may be updated; *ours but with a different hash* → the user has edited it, kept by default; *not in the record but already existing* → conflict, skipped.
5. **Back up before every intended overwrite**, into `<install home>/backups/<timestamp>/`, keeping the relative path, and print the path for the user.
6. **No journal, no global rollback.** Recovery rests on three properties: atomic per-file writes, idempotence, and the install record. If interrupted midway, running the install command again returns to a consistent state.
7. **Installing a new version does not overwrite the old version**: the new payload goes into `plugin/<new version>/`. This is how REQ-010c is met without a rollback. *(Corrected 2026-09-15: the first draft said "clean up old versions, keep at most N". The owner decided to **keep all of them**, cleaning up only when the user runs `--prune` — see Technical Design Q-016. There is no automatic cleanup mechanism.)*
   **Consequence for the scope of the states in decision 4:** because an upgrade always goes into a new directory, every target is `missing` → created, so `user-modified`, `outdated` and `conflict` **occur only in the active version's directory** (reinstalling the same version, or repairing a deleted/edited file) and on `install.json` itself. A file the user has edited in an **old** version's directory is left alone, listed in the summary, and `--prune` never deletes it.
8. **Permissions**: directories `0700`, files `0600`.
9. A `schemaVersion` higher than the CLI understands → stop and ask the user to upgrade, without guessing.

## Consequences

**Positive**
- The three hard requirements (idempotence, no silent overwrite, clean uninstall) all follow directly from the install record.
- No confusing half-way state: a file is either the old version intact or the new version intact.
- Much simpler than a journal, so less code and fewer ways to break.

**Negative / to be accepted**
- An interruption midway can leave **an unfinished payload directory for the new version**. Handling: a version not yet written into the record is treated as garbage and cleaned up by the next run.
- If the record is deleted by hand, the ownership trail is lost; paseo-bm then treats itself as not installed and reports every existing target as a conflict, instead of guessing.
- `sha256` only detects that content differs, not who changed it. Enough for the goal of "no silent overwrite".
- Backups accumulate over time; a cleanup policy and a listing command are needed.

## Alternatives considered

| Option | Reason rejected |
|---|---|
| paseo-room style: `rm` + rewrite, a marker with no file list | Directly violates REQ-008 and REQ-012; its own author acknowledges this as a weakness |
| A full transaction journal like Paseo's skills installer | Fits when writing into a directory shared with other tools. paseo-bm writes only inside its own directory, so the cost is out of proportion |
| Rely on `mtime`/size instead of a hash | Unreliable across copies and checkouts; easy both to miss changes and to report false ones |
| Overwrite directly, then fix on error | No recovery point; exactly what REQ-010c forbids |

## Addendum 2026-09-16 — the `user-data` kind stands outside the hash model

Under the delta [`design-delta-20260916-trace-store`](../archive/design/paseo-bm-delta-20260916-trace-store.md) approved by the owner, the `<install home>/traces/` directory (the Dashboard's trace store) is **data created by paseo-bm but belonging to the user**, and the record–hash model of this ADR does **not** apply to it:

- it is not in `files[]`, has no `sha256`, produces no `backups[]`;
- it has none of the four states `unchanged` / `outdated` / `user-modified` / `conflict` — it is not a versioned asset, so there is no "correct version" to compare against;
- install and update (including `--prune`) **never** touch it (PRD REQ-010f);
- only the uninstall command may delete it, and it must ask separately (PRD REQ-012i).

Why this decision does not weaken ADR-002: the hash model exists to answer "whose file is this and has it been edited by hand". For accumulating data that question is meaningless — every change is new, valid data. Applying a hash to it would always report `user-modified` and turn a correct feature into a false warning. Details in [ADR-007](ADR-007-dashboard-trace-store.md) and [Technical Design](../design/paseo-bm.md) §3.3.
