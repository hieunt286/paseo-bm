/**
 * Which role instructions an agent was created with (autonomy PRD §11 rule 3,
 * REQ-117; design §A.11, §A.14): `bm.instructions=<first 12 hex digits of the
 * SHA-256 of the role text>`, the role text being `roles/<role>.md` as this
 * build embeds it — never the Runtime facts or the owner's precedents, so a
 * change to those does not make an agent outdated.
 *
 * Paseo fixes an agent's system prompt when it is created, so an agent whose
 * label is missing or holds another hash runs older instructions. There is no
 * compatibility layer for it: it is detected (`outdated-agents.ts`) and the
 * owner is offered to replace it (`manager.ensure { replaceOutdated }`).
 *
 * The Orchestrator has carried this label since its design §3.3
 * (`orchestrator-agent.ts`); this module is the one place the hash is made.
 */
import { createHash } from "node:crypto";
import type { BmRole } from "./agent-role";
import { MANAGER_INSTRUCTIONS } from "./manager-instructions";
import { ORCHESTRATOR_INSTRUCTIONS } from "./orchestrator-instructions";
import { REVIEWER_INSTRUCTIONS } from "./reviewer-instructions";
import { WORKER_INSTRUCTIONS } from "./worker-instructions";

/** The label key. */
export const INSTRUCTIONS_LABEL = "bm.instructions";

/** Hex digits the label keeps, so it stays small. */
export const INSTRUCTIONS_HASH_LENGTH = 12;

/** The label value for a role text: lowercase hex SHA-256 of its UTF-8 bytes, cut to `INSTRUCTIONS_HASH_LENGTH`. */
export function instructionsHashOf(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex").slice(0, INSTRUCTIONS_HASH_LENGTH);
}

/** The text each role is created with in this build (the same texts `BASE_INSTRUCTIONS` holds). */
const ROLE_TEXT: Readonly<Record<BmRole, string>> = {
  manager: MANAGER_INSTRUCTIONS,
  worker: WORKER_INSTRUCTIONS,
  reviewer: REVIEWER_INSTRUCTIONS,
  orchestrator: ORCHESTRATOR_INSTRUCTIONS,
};

const CURRENT_HASH: Readonly<Record<BmRole, string>> = {
  manager: instructionsHashOf(MANAGER_INSTRUCTIONS),
  worker: instructionsHashOf(WORKER_INSTRUCTIONS),
  reviewer: instructionsHashOf(REVIEWER_INSTRUCTIONS),
  orchestrator: instructionsHashOf(ORCHESTRATOR_INSTRUCTIONS),
};

/** This build's label value for `role`. */
export function currentInstructionsHash(role: BmRole): string {
  return CURRENT_HASH[role];
}

/** This build's role text for `role`. */
export function roleTextOf(role: BmRole): string {
  return ROLE_TEXT[role];
}

/** True when the agent's label is missing or holds another hash than this build's for `role`. */
export function hasOutdatedInstructions(labels: Readonly<Record<string, string>> | null | undefined, role: BmRole): boolean {
  return labels?.[INSTRUCTIONS_LABEL] !== CURRENT_HASH[role];
}
