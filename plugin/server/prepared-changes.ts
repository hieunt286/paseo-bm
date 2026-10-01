/**
 * Applying a prepared change of the owner's settings (autonomy design §G.4;
 * PRD REQ-128; ADR-021 decision 5) when the owner picks the option that
 * carries it. The kinds and their pure checks are `shared/prepared-changes.ts`.
 *
 * - **Only the owner's own answer applies one.** `applyPreparedChange` reads
 *   the stored answer: `by: owner`, an option, and that option's change.
 *   Nothing else can reach it either: `answerDecision` refuses any other
 *   answerer on such a decision, `resolveAtOpen` leaves it open, and
 *   `bm_decide` and `bm_predict` refuse it (`decideRefusalOf`,
 *   `predictionRefusalOf`). No agent tool writes a setting.
 * - **Through the owner's own code.** A precedent goes through
 *   `precedents.save`'s handler, an autonomy cell through `autonomy.set`'s
 *   (with the owner's confirmation, which the tap on the option is: the
 *   question says exactly what it sets), a coordination setting through
 *   `coordination.set`'s — each with its checks, its refusals and its side
 *   effects (an `autonomy.set` ends the cell's `autonomy-demoted` alert).
 * - **Checked again first** (`preparedChangeCheckOf`): what the owner could
 *   not set in Settings now is refused, writing nothing; a change that would
 *   change nothing writes nothing and counts as applied.
 *
 * Never throws: a failure is the result's reason, which the caller reports.
 */
import { isPreparedChange, type Decision, type PreparedChange } from "../shared/decisions";
import { preparedChangeCheckOf, preparedChangeTextOf, type PreparedChangeFacts } from "../shared/prepared-changes";
import { currentPolicy } from "./autonomy-store";
import { handleAutonomySet, handlePrecedentsSave } from "./autonomy-rpc";
import { handleCoordinationSet, readCoordinationSettings } from "./coordination-rpc";
import { createPrecedentStore } from "./precedent-store";
import { errorText } from "./rpc-kit";

const defaultLog = (message: string): void => console.warn(message);

export interface PreparedChangeDeps {
  /** The data folder. */
  home: string;
  now: Date;
  log?: (message: string) => void;
}

/**
 * What a prepared change's checks read, for one project, now: the policy
 * (every class `owner` when it cannot be read), the coordination settings
 * (the defaults when unreadable) and the active precedents (none when
 * unreadable). Never throws.
 */
export function preparedChangeFactsOf(workspaceId: string, deps: PreparedChangeDeps): PreparedChangeFacts {
  const log = deps.log ?? defaultLog;
  const policy = currentPolicy(deps.home, (reason) => log(`[paseo-bm] could not read the autonomy policy for a prepared change: ${reason}`));
  let precedents: PreparedChangeFacts["precedents"] = [];
  try {
    precedents = createPrecedentStore(deps.home).active(deps.now, workspaceId);
  } catch (error) {
    log(`[paseo-bm] could not read the precedents for a prepared change: ${errorText(error)}`);
  }
  return { workspaceId, policy, settings: readCoordinationSettings({ home: deps.home, log }), precedents };
}

export type PreparedChangeResult =
  /** Applied (`wrote: false`: it was so already, and nothing was written); `text` says what it set. */
  | { applied: true; wrote: boolean; text: string }
  /** Not applied, and nothing was written: why. */
  | { applied: false; text: string; reason: string };

/** The prepared change of the option an answer chose, or null when it chose none (words, a confirmed chat answer, an option without one). */
export function chosenPreparedChange(decision: Decision): PreparedChange | null {
  const optionKey = decision.answer?.optionKey ?? null;
  if (decision.status !== "answered" || optionKey === null) return null;
  const action = decision.options.find((option) => option.key === optionKey)?.action;
  return isPreparedChange(action) ? action : null;
}

/** Writes one checked change through the Settings RPC that owns it. */
function write(change: PreparedChange, workspaceId: string, deps: PreparedChangeDeps): void {
  const rpc = { home: deps.home, now: () => deps.now, ...(deps.log === undefined ? {} : { log: deps.log }) };
  switch (change.kind) {
    case "precedent.save":
      handlePrecedentsSave(
        {
          scope: change.scope === "all" ? "all" : workspaceId,
          subject: change.subject,
          text: change.text,
          ...(change.expiresInDays === undefined ? {} : { expiresInDays: change.expiresInDays }),
        },
        rpc,
      );
      return;
    case "autonomy.set":
      handleAutonomySet(
        {
          workspaceId,
          class: change.class,
          mode: change.mode,
          // The owner's tap on an option that says what it sets: the confirmation a delegation asks for.
          confirmed: true,
          ...(change.predictor === undefined ? {} : { predictor: change.predictor }),
        },
        rpc,
      );
      return;
    case "coordination.set":
      handleCoordinationSet(change.change, rpc);
      return;
  }
}

/**
 * Applies the prepared change of the option the owner chose on `decision`
 * (see the module comment), or returns null when the answer chose none. An
 * answer that is not the owner's applies nothing. Never throws.
 */
export function applyPreparedChange(decision: Decision, deps: PreparedChangeDeps): PreparedChangeResult | null {
  const change = chosenPreparedChange(decision);
  if (change === null) return null;
  const text = preparedChangeTextOf(change);
  if (decision.answer?.by !== "owner") return { applied: false, text, reason: "only the owner's own answer applies a change of the owner's settings" };
  try {
    const check = preparedChangeCheckOf(change, preparedChangeFactsOf(decision.workspaceId, deps));
    if ("refusal" in check) return { applied: false, text, reason: check.refusal };
    if ("unchanged" in check) return { applied: true, wrote: false, text };
    write(change, decision.workspaceId, deps);
    return { applied: true, wrote: true, text };
  } catch (error) {
    return { applied: false, text, reason: errorText(error) };
  }
}
