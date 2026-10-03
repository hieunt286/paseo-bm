/**
 * The owner's precedents at work on decisions (autonomy design §B.6, §B.9;
 * PRD REQ-124 b, c). The rules are pure (`shared/precedents.ts`); this module
 * reads the precedent store and writes the decision store.
 *
 * - **At open** (`resolveByPrecedent`), before any policy delegation: a
 *   decision whose `subject` equals an active precedent's — the workspace's
 *   before a global one — is answered by it, `by: precedent` with its
 *   `precedentId` and a one-line reason, whatever its class (ADR-025). The
 *   answer is the option whose label is the precedent's text, else the text as
 *   the owner's own words, with the grant an owner answer of that form gives.
 *   `via` is `inbox`: nothing was typed in a
 *   chat, so the answer is delivered like one the owner gave in the Inbox. The
 *   caller hands the answered decision to `onSettled`; a precedent's answer is
 *   not an intervention of the Orchestrator's and is not logged as one.
 *   Called where decisions open: the materialiser (`q:`), `bm_ask_owner`
 *   (`o:`) and the fallback incidents (`f:`, when their delivery can run).
 *   The subject `review-budget` is never answered by a precedent (design
 *   §16.8): one grant covers exactly the scope it states.
 * - **Suggested only** (a fallback incident's decision whose options the
 *   precedent names none of): the decision stays open and nothing is written;
 *   its card shows the precedent as a suggestion (`client/chat-card-precedent.ts`).
 * - **On the owner's answer** (`supersedePrecedentsBy`): an answer on the same
 *   subject, where the precedent holds, whose text differs from it supersedes
 *   it (`supersededBy` = the decision's id), so the next decision meets the
 *   owner's latest word.
 *
 * Never throws: a failure is one log line, and a decision it could not
 * resolve simply stays open for the owner.
 */
import { REVIEW_BUDGET_SUBJECT, answerDecision, decisionClassOf, type Decision } from "../shared/decisions";
import { precedentReasonOf, precedentResolutionOf, precedentsContradictedBy, type Precedent } from "../shared/precedents";
import { createDecisionStore, type DecisionStore } from "./decision-store";
import { createPrecedentStore } from "./precedent-store";
import { errorText } from "./rpc-kit";

export interface PrecedentResolveDeps {
  /** The data folder holding both stores. */
  home: string;
  now: Date;
  log?: (message: string) => void;
  /** The decision store to write through; one over `home` by default. */
  store?: DecisionStore;
}

export interface PrecedentResolveResult {
  /** The decision as stored now: answered `by: precedent` when this call resolved it, else as it came. */
  decision: Decision;
  /** True when this call answered it. */
  resolved: boolean;
  /** The precedent that bears on it — the one that answered it, or the one its card suggests; null when none does. */
  precedent: Precedent | null;
}

const defaultLog = (message: string): void => console.warn(message);

/** The active precedents of a workspace (and the global ones); none when the store cannot be read. */
function activePrecedentsOf(workspaceId: string, deps: PrecedentResolveDeps): Precedent[] {
  try {
    return createPrecedentStore(deps.home).active(deps.now, workspaceId);
  } catch (error) {
    (deps.log ?? defaultLog)(`[paseo-bm] could not read the precedents of ${workspaceId}: ${errorText(error)}`);
    return [];
  }
}

/**
 * Resolves a decision that has just opened by the active precedent on its
 * subject, when one bears on it (see the module comment). A decision it only
 * suggests, a decision with no subject or no match, or one no longer `open`,
 * is returned as it came.
 */
export function resolveByPrecedent(decision: Decision, deps: PrecedentResolveDeps): PrecedentResolveResult {
  const log = deps.log ?? defaultLog;
  const unchanged = (precedent: Precedent | null): PrecedentResolveResult => ({ decision, resolved: false, precedent });
  if (decision.status !== "open" || decision.subject === null) return unchanged(null);
  // Design §16.8: one answer to a review budget covers exactly the scope it states, so no precedent answers it.
  if (decision.subject === REVIEW_BUDGET_SUBJECT) return unchanged(null);
  const resolution = precedentResolutionOf(decision, activePrecedentsOf(decision.workspaceId, deps), deps.now);
  if (resolution === null) return unchanged(null);
  if (resolution.kind === "suggest") return unchanged(resolution.precedent);
  const { precedent, answer } = resolution;
  try {
    const store = deps.store ?? createDecisionStore(deps.home, { log });
    const mutation = store.transition(
      decision.id,
      (current) =>
        answerDecision(current, {
          by: "precedent",
          via: "inbox",
          ...answer,
          precedentId: precedent.id,
          reason: precedentReasonOf(precedent),
          class: decisionClassOf(current),
          at: deps.now.toISOString(),
        }),
      decision.workspaceId,
    );
    if (mutation.status === "updated") return { decision: mutation.decision, resolved: true, precedent };
    if (mutation.status === "refused") {
      log(`[paseo-bm] precedent ${precedent.id} did not answer decision ${decision.id}: ${mutation.message}`);
      return { decision: mutation.decision, resolved: false, precedent };
    }
    return unchanged(precedent);
  } catch (error) {
    log(`[paseo-bm] precedent ${precedent.id} could not answer decision ${decision.id}: ${errorText(error)}`);
    return unchanged(precedent);
  }
}

/**
 * After the owner answered `decision`: supersedes the active precedents on
 * its subject, where they hold, that the answer contradicts (REQ-124 c,
 * `precedentsContradictedBy`). Returns their ids; none for an answer that is
 * not the owner's, that repeats the precedent, or that has no text (a chat
 * answer the owner confirmed).
 */
export function supersedePrecedentsBy(decision: Decision, deps: PrecedentResolveDeps): string[] {
  if (decision.answer?.by !== "owner" || decision.subject === null) return [];
  const log = deps.log ?? defaultLog;
  try {
    const store = createPrecedentStore(deps.home);
    const contradicted = precedentsContradictedBy(decision, store.active(deps.now, decision.workspaceId), deps.now);
    if (contradicted.length === 0) return [];
    return store.supersede(
      contradicted.map((precedent) => precedent.id),
      decision.id,
      deps.now,
    ).map((precedent) => precedent.id);
  } catch (error) {
    log(`[paseo-bm] decision ${decision.id} is answered, but the precedents on "${decision.subject}" could not be superseded: ${errorText(error)}`);
    return [];
  }
}
