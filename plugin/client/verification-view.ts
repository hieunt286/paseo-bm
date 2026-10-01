/**
 * How a request's finish reads to the owner (autonomy design §C.2, §C.3, §C.6;
 * REQ-130): Work's stage bar and evidence lines (`work-model.ts`) and the
 * finished card (`chat-card-frame.ts`) share these words.
 *
 * - A request whose latest report is `finished`, whose code changed and whose
 *   named checks are not all detected is **finished-unverified**: "Done —
 *   unverified" on the stage bar, "Finished — unverified" on the card, both
 *   in the warning tone.
 * - Each check the report names carries its label — detected ✓,
 *   self-reported, or unverified when the report says nothing ran — and the
 *   files changed and beads closed carry theirs (detected, self-reported).
 * - A request that is **not checked** (recorded before shell entries carried
 *   a status) is shown as before: `isShownVerification` is false for it.
 *
 * Pure: no React, no React Native. File paths and bead ids appear only in
 * `verificationDetailLines`, which the Details of a card list.
 */
import type { TraceVerification } from "../shared/contracts";
import { shorten } from "../shared/text";

/** The Done step of a finished-unverified request (design §C.3). */
export const DONE_UNVERIFIED_LABEL = "Done — unverified";

/** The finished card's chip for a finished-unverified request (design §C.3). */
export const FINISHED_UNVERIFIED_CHIP = "Finished — unverified";

/** Checks named on an evidence line before `+N more`. */
export const EVIDENCE_CHECKS_SHOWN = 3;

/** Longest check on an evidence line; the whole check is in Details. */
export const EVIDENCE_CHECK_CHARS = 40;

/** Whether a finish is shown with its labels: a request that is not checked is shown as before. */
export function isShownVerification(verification: TraceVerification | null | undefined): verification is TraceVerification {
  return verification !== null && verification !== undefined && verification.checks !== "not-checked";
}

type Claim = TraceVerification["named"][number];

/** One check's label as the owner reads it: `detected ✓`, `self-reported`, or `unverified` when the report says nothing ran. */
export function checkLabelText(verification: Pick<TraceVerification, "checks">, claim: Pick<Claim, "label">): string {
  if (verification.checks === "unverified") return "unverified";
  return claim.label === "detected" ? "detected ✓" : "self-reported";
}

/** The checks on one line: `npm test — detected ✓ · npm run lint — self-reported`, or the verdict when none is named. */
export function checksText(verification: TraceVerification): string {
  const named = verification.named;
  if (named.length === 0) return verification.checks === "unverified" ? "unverified, none shown to run" : verification.checks;
  const shown = named
    .slice(0, EVIDENCE_CHECKS_SHOWN)
    .map((claim) => `${shorten(claim.check, EVIDENCE_CHECK_CHARS)} — ${checkLabelText(verification, claim)}`);
  const more = named.length - shown.length;
  return more > 0 ? `${shown.join(" · ")} · +${more} more` : shown.join(" · ");
}

/** How a list of claims stands: `detected`, `self-reported`, or `2 detected, 1 self-reported`. */
export function claimCountsText(claims: ReadonlyArray<{ label: Claim["label"] }>): string {
  const detected = claims.filter((claim) => claim.label === "detected").length;
  const self = claims.length - detected;
  if (self === 0) return "detected";
  if (detected === 0) return "self-reported";
  return `${detected} detected, ${self} self-reported`;
}

/** Details: the verdict, then each check, file and bead with its label. Paths and ids live here only. */
export function verificationDetailLines(verification: TraceVerification): string[] {
  return [
    verification.unverified
      ? `${FINISHED_UNVERIFIED_CHIP}: code changed, and not every check the report names was seen to pass after the last edit.`
      : `Checks: ${verification.checks}`,
    ...verification.named.map((claim) => `Check: ${claim.check} — ${checkLabelText(verification, claim)}`),
    ...verification.files.map((claim) => `File: ${claim.path} — ${claim.label}`),
    ...verification.beads.map((claim) => `Bead: ${claim.id} — ${claim.label}`),
  ];
}
