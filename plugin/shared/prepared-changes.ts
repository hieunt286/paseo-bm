import { canDelegate, cellOf, type AutonomyPolicy } from "./autonomy";
import {
  COORDINATION_KEYS,
  coordinationChangeSchema,
  coordinationRuleOf,
  coordinationValueOf,
  type CoordinationChange,
  type CoordinationSettings,
} from "./coordination";
import {
  PREPARED_CHANGE_KINDS,
  isPreparedChange,
  preparedActionSchema,
  type DecisionClass,
  type Predictor,
  type PreparedChange,
  type PreparedChangeKind,
} from "./decisions";
import { DEFAULT_PRECEDENT_DAYS, PRECEDENT_SCOPE_ALL, checkPrecedentSaveInput, sameAnswerText, type Precedent } from "./precedents";

/**
 * Prepared changes of the owner's settings (autonomy design §G.4; PRD
 * REQ-128; ADR-021 decision 5): what an option of an Orchestrator decision
 * (`bm_ask_owner`) may carry instead of a command, so that advice ends in the
 * owner's one tap — never in text appended to an agent's instructions.
 *
 * - `precedent.save { scope: project | all, subject, text, expiresInDays? }`:
 *   an owner precedent, as Settings → Autonomy writes one (§B.6).
 * - `autonomy.set { class, mode, predictor? }`: one cell of the decision's
 *   project, as the owner could set it: `owner` or `shadow` of a class that
 *   may be delegated (the matrix), `delegate` only where that predictor's
 *   cell has earned it (Insights' Delegate?, §B.4). Never a release, data,
 *   security or cost class, in any mode.
 * - `coordination.set { key, value }`: one Settings → Coordination setting
 *   (§G.7), in its bounds: the advice cadence, and since Phase 3 the
 *   compaction and handoff switches and thresholds and the review budget per
 *   tier (§G.4's `review.budget`, change-008 C6).
 *
 * The plugin applies one only on the owner's own answer
 * (`decisions.ts` `carriesPreparedChange`), through the same code the
 * Settings RPCs run (`server/prepared-changes.ts`), and checks it twice: when
 * it is asked (`bm_ask_owner`, which also refuses a change that would change
 * nothing) and again when it is applied.
 *
 * This module is `shared/`: no Node and no React Native imports.
 */

/** The fields each kind takes besides `kind`: the required ones, then the optional ones. */
export const PREPARED_CHANGE_FIELDS: Readonly<Record<PreparedChangeKind, { required: readonly string[]; optional: readonly string[] }>> = {
  "precedent.save": { required: ["scope", "subject", "text"], optional: ["expiresInDays"] },
  "autonomy.set": { required: ["class", "mode"], optional: ["predictor"] },
  "coordination.set": { required: ["key", "value"], optional: [] },
};

/** `bm_ask_owner`'s flat `change` of an option: `kind`, and that kind's fields. */
export type PreparedChangeInput = { kind: string } & Record<string, unknown>;

/**
 * The prepared change a tool's input names, or its problems, one line each by
 * field: an unknown kind, a missing field, a field of another kind, a value
 * the change does not take. Pure.
 */
export function preparedChangeOfInput(input: PreparedChangeInput): { change: PreparedChange } | { problems: string[] } {
  if (!(PREPARED_CHANGE_KINDS as readonly string[]).includes(input.kind)) return { problems: [`kind: must be one of ${PREPARED_CHANGE_KINDS.join(", ")}`] };
  const kind = input.kind as PreparedChangeKind;
  const fields = PREPARED_CHANGE_FIELDS[kind];
  const problems: string[] = [];
  for (const field of fields.required) if (input[field] === undefined) problems.push(`${field}: is required for ${kind}`);
  for (const field of Object.keys(input)) {
    if (field !== "kind" && !fields.required.includes(field) && !fields.optional.includes(field)) problems.push(`${field}: is not a field of ${kind}`);
  }
  if (problems.length > 0) return { problems };
  const candidate = kind === "coordination.set" ? { kind, change: { key: input["key"], value: input["value"] } } : input;
  const parsed = preparedActionSchema.safeParse(candidate);
  if (parsed.success && isPreparedChange(parsed.data)) return { change: parsed.data };
  if (kind === "coordination.set") {
    const rule = coordinationRuleOf(input["key"]);
    return { problems: [rule === null ? `key: must be one of ${COORDINATION_KEYS.join(", ")}` : `value: ${rule}`] };
  }
  return { problems: (parsed.error?.issues ?? []).map((issue) => `${String(issue.path.at(-1) ?? "change")}: ${issue.message}`) };
}

/** A class in the owner's words: `Reversible technical`. */
function classWords(decisionClass: DecisionClass): string {
  const words = decisionClass.replace(/-/g, " ");
  return `${words.charAt(0).toUpperCase()}${words.slice(1)}`;
}

const PREDICTOR_WORDS: Readonly<Record<Predictor, string>> = { recommended: "the recommended option", orchestrator: "the Orchestrator" };

/** A whole number with its thousands grouped: 5,700,000. The same on every machine (no locale). */
function grouped(value: number): string {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** What a coordination setting's change sets, in the owner's words, then its key and value. */
function coordinationChangeText(change: CoordinationChange): string {
  const exact = `(${change.key} ${String(change.value)})`;
  switch (change.key) {
    case "advice.everyFinished":
      return change.value === 0 ? `turns Advice off ${exact}` : `sets Advice to after every ${change.value} finished requests ${exact}`;
    case "compact.enabled":
      return `turns Compaction ${change.value ? "on" : "off"} ${exact}`;
    case "handoff.enabled":
      return `turns Handoff ${change.value ? "on" : "off"} ${exact}`;
    case "compact.managerTokensPerTurn":
      return `sets a Manager's compaction threshold to ${grouped(change.value)} tokens read per turn ${exact}`;
    case "compact.workerTokensPerTurn":
      return `sets a Worker's compaction threshold to ${grouped(change.value)} tokens read per turn ${exact}`;
    case "compact.contextShare":
      return `sets compaction at ${Math.round(change.value * 100)}% of the context window ${exact}`;
    case "compact.maxPerAgent":
      return `sets at most ${change.value} compaction${change.value === 1 ? "" : "s"} per agent ${exact}`;
    case "handoff.requestTokens":
      return `sets the handoff threshold to ${grouped(change.value)} tokens read per request ${exact}`;
    case "handoff.maxPerRequest":
      return `sets at most ${change.value} handoff${change.value === 1 ? "" : "s"} per request ${exact}`;
    case "review.smallBudget":
      return `sets the review budget of a Small request to ${change.value} review calls ${exact}`;
    case "review.mediumBudget":
      return `sets the review budget of a Medium request to ${change.value} review calls ${exact}`;
    case "review.largeBudget":
      return `sets the review budget of a Large request to ${change.value} review calls ${exact}`;
  }
}

/** What applying the change does, as a sentence's predicate the owner reads on the decision: "sets …", "saves …". Pure. */
export function preparedChangeTextOf(change: PreparedChange): string {
  switch (change.kind) {
    case "precedent.save": {
      const where = change.scope === "all" ? "for all projects" : "for this project";
      return `saves your precedent on "${change.subject}" ${where}, for ${change.expiresInDays ?? DEFAULT_PRECEDENT_DAYS} days: "${change.text}"`;
    }
    case "autonomy.set": {
      const mode = change.mode === "owner" ? "Owner" : change.mode === "shadow" ? "Shadow" : `Delegated to ${PREDICTOR_WORDS[change.predictor ?? "recommended"]}`;
      return `sets ${classWords(change.class)} decisions in this project to ${mode}`;
    }
    case "coordination.set":
      return coordinationChangeText(change.change);
  }
}

/**
 * The lines the stored question gets for its options' prepared changes, one
 * per option that carries one, so the owner reads exactly what a tap applies:
 * `Choosing a saves your precedent on …`. Empty when none carries one. Pure.
 */
export function preparedChangeLinesOf(options: ReadonlyArray<{ key: string; action?: Parameters<typeof isPreparedChange>[0] }>): string[] {
  return options.flatMap((option) => (isPreparedChange(option.action) ? [`Choosing ${option.key} ${preparedChangeTextOf(option.action)}.`] : []));
}

/** What the checks of a prepared change read of the owner's settings, for the decision's project. */
export interface PreparedChangeFacts {
  workspaceId: string;
  /** The owner's autonomy policy now. */
  policy: AutonomyPolicy;
  /** Whether that predictor's agreement cell of that class has earned Delegate? in this project now (§B.4): what Insights offers. */
  eligible: (decisionClass: DecisionClass, predictor: Predictor) => boolean;
  /** The coordination settings now. */
  settings: CoordinationSettings;
  /** The active precedents that hold in the project: its own and the global ones. */
  precedents: readonly Precedent[];
}

/** A check's verdict: the owner could not make this change in Settings; it would change nothing; or it may be applied. */
export type PreparedChangeCheck = { refusal: string } | { unchanged: string } | { ok: true };

/**
 * Whether the owner could make this change in Settings now, and whether it
 * would change anything (see the module comment). The same check runs when
 * the change is asked and when it is applied. Pure.
 */
export function preparedChangeCheckOf(change: PreparedChange, facts: PreparedChangeFacts): PreparedChangeCheck {
  switch (change.kind) {
    case "precedent.save": {
      const scope = change.scope === "all" ? PRECEDENT_SCOPE_ALL : facts.workspaceId;
      const checked = checkPrecedentSaveInput({
        scope,
        subject: change.subject,
        text: change.text,
        ...(change.expiresInDays === undefined ? {} : { expiresInDays: change.expiresInDays }),
      });
      if ("refusal" in checked) return { refusal: checked.refusal.detail };
      const same = facts.precedents.find(
        (precedent) => precedent.scope === scope && precedent.subject === change.subject && sameAnswerText(precedent.text, change.text),
      );
      return same === undefined ? { ok: true } : { unchanged: `the owner's precedent on "${change.subject}" already says this` };
    }
    case "autonomy.set": {
      if (!canDelegate(change.class)) return { refusal: `${change.class} decisions are always the owner's; their cell is fixed in Settings and never changed` };
      const cell = cellOf(facts.policy, facts.workspaceId, change.class);
      const current = cell?.mode ?? "owner";
      if (change.mode !== "delegate") return current === change.mode ? { unchanged: `${change.class} is ${change.mode} in this project already` } : { ok: true };
      const predictor = change.predictor ?? "recommended";
      if (cell?.mode === "delegate" && cell.predictor === predictor) return { unchanged: `${change.class} is delegated to ${PREDICTOR_WORDS[predictor]} in this project already` };
      if (!facts.eligible(change.class, predictor)) {
        return {
          refusal: `${change.class} has not earned delegation to ${PREDICTOR_WORDS[predictor]} in this project: Settings offers Delegate? only on a cell that has (Insights)`,
        };
      }
      return { ok: true };
    }
    case "coordination.set": {
      const valid = coordinationChangeSchema.safeParse(change.change);
      if (!valid.success) {
        const key: unknown = (change.change as { key?: unknown }).key;
        return { refusal: coordinationRuleOf(key) ?? `${JSON.stringify(key ?? null)} is not a coordination setting` };
      }
      const { key, value } = valid.data;
      return coordinationValueOf(facts.settings, key) === value ? { unchanged: `${key} is ${String(value)} already` } : { ok: true };
    }
  }
}
