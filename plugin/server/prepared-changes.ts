/**
 * Applying a prepared change of the owner's settings (autonomy design §G.4;
 * PRD REQ-128; ADR-021 decision 5) when the owner picks the option that
 * carries it. The kinds and their pure checks are `shared/prepared-changes.ts`.
 *
 * - **Only the owner's own answer applies one.** `applyPreparedChange` reads
 *   the stored answer: `by: owner`, an option, and that option's change.
 *   Nothing else can reach it either: `answerDecision` refuses any other
 *   answerer on such a decision, `resolveAtOpen` leaves it open, and
 *   `bm_decide` refuses it (`decideRefusalOf`). No agent tool writes a
 *   setting.
 * - **Through the owner's own code.** A precedent goes through
 *   `precedents.save`'s handler, an autonomy cell through `autonomy.set`'s
 *   (with the owner's confirmation, which the tap on the option is: the
 *   question says exactly what it sets), a coordination setting through
 *   `coordination.set`'s — each with its checks, its refusals and its side
 *   effects.
 * - **Checked again first** (`preparedChangeCheckOf`): what the owner could
 *   not set in Settings now is refused, writing nothing; a change that would
 *   change nothing writes nothing and counts as applied. A change stored on a
 *   retired setting (`review.*Budget`, delivery line design §5.6) is refused
 *   so: "this setting no longer exists", and nothing is changed.
 * - **Stated by what was written** (delivery line design §7.3): the result
 *   reads the RPC's output — the precedent saved (with `inert` when no
 *   question can match it), the cell or the setting as stored — and
 *   `changeEffect` (`effects.ts`) words it.
 *
 * Never throws: a failure is the result's reason, which the caller reports.
 */
import { isPreparedChange, type Decision, type PreparedChange } from "../shared/decisions";
import { cellOf } from "../shared/autonomy";
import { coordinationValueOf, liveCoordinationChangeSchema } from "../shared/coordination";
import { listedPrecedentOf } from "../shared/precedents";
import { preparedChangeCheckOf, preparedChangeTextOf, type PreparedChangeFacts } from "../shared/prepared-changes";
import { currentPolicy } from "./autonomy-store";
import { repoKeyOf } from "./placements";
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
export function preparedChangeFactsOf(workspace: string, deps: PreparedChangeDeps): PreparedChangeFacts {
  const log = deps.log ?? defaultLog;
  // Delivery line design §3.1: the owner's settings are the repo's, never a placement's.
  const workspaceId = repoKeyOf(deps.home, workspace);
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
  /**
   * Applied (`wrote: false`: it was so already, and nothing was written); `text` says what it set.
   * `inert`: the precedent it wrote answers nothing, and why (delivery line design §7.4).
   */
  | { applied: true; wrote: boolean; text: string; inert?: string }
  /** Not applied, and nothing was written: why. */
  | { applied: false; text: string; reason: string };

/** The prepared change of the option an answer chose, or null when it chose none (words, a confirmed chat answer, an option without one). */
export function chosenPreparedChange(decision: Decision): PreparedChange | null {
  const optionKey = decision.answer?.optionKey ?? null;
  if (decision.status !== "answered" || optionKey === null) return null;
  const action = decision.options.find((option) => option.key === optionKey)?.action;
  return isPreparedChange(action) ? action : null;
}

/** What a write left in the owner's settings (delivery line design §7.3): it holds, with a precedent's `inert`; or it does not, and why. */
type Written = { holds: true; inert?: string } | { holds: false; reason: string };

/** Writes one checked change through the Settings RPC that owns it, and reads what it wrote from the RPC's output. */
function write(change: PreparedChange, workspaceId: string, deps: PreparedChangeDeps): Written {
  const rpc = { home: deps.home, now: () => deps.now, ...(deps.log === undefined ? {} : { log: deps.log }) };
  switch (change.kind) {
    case "precedent.save": {
      const { precedent } = handlePrecedentsSave(
        {
          scope: change.scope === "all" ? "all" : workspaceId,
          subject: change.subject,
          text: change.text,
          ...(change.expiresInDays === undefined ? {} : { expiresInDays: change.expiresInDays }),
        },
        rpc,
      );
      const inert = listedPrecedentOf(precedent).inert;
      return inert === undefined ? { holds: true } : { holds: true, inert };
    }
    case "autonomy.set": {
      const { policy } = handleAutonomySet(
        {
          workspaceId,
          class: change.class,
          mode: change.mode,
          // The owner's tap on an option that says what it sets: the confirmation a delegation asks for.
          confirmed: true,
        },
        rpc,
      );
      const mode = cellOf(policy, workspaceId, change.class)?.mode ?? "owner";
      return mode === change.mode ? { holds: true } : { holds: false, reason: `the policy holds ${change.class} as ${mode} after the write` };
    }
    case "coordination.set": {
      const { settings } = handleCoordinationSet(change.change, rpc);
      const live = liveCoordinationChangeSchema.safeParse(change.change);
      if (!live.success) return { holds: false, reason: "the setting it names is not a coordination setting" };
      const value = coordinationValueOf(settings, live.data.key);
      return value === live.data.value ? { holds: true } : { holds: false, reason: `${live.data.key} is ${String(value)} after the write` };
    }
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
    // Delivery line design §3.1: a placement's decision changes its repo's settings.
    const repo = repoKeyOf(deps.home, decision.workspaceId);
    const check = preparedChangeCheckOf(change, preparedChangeFactsOf(repo, deps));
    if ("refusal" in check) return { applied: false, text, reason: check.refusal };
    if ("unchanged" in check) return { applied: true, wrote: false, text };
    // Delivery line design §7.3: the result says what the write left, not what was meant.
    const written = write(change, repo, deps);
    if (!written.holds) return { applied: false, text, reason: written.reason };
    return written.inert === undefined ? { applied: true, wrote: true, text } : { applied: true, wrote: true, text, inert: written.inert };
  } catch (error) {
    return { applied: false, text, reason: errorText(error) };
  }
}
