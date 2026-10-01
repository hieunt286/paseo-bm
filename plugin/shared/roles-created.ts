/**
 * The sentence that says which roles paseo-bm just created with defaults,
 * shared by `manager.ensure` (the launcher's line) and the roles line of
 * Settings, so both name the same roles the same way.
 *
 * A machine updated from 0.4.x already has three roles and gets only the
 * fourth (orchestrator design §3.1): "created its roles" would then claim
 * something that did not happen, so a partial creation names each role.
 *
 * Pure: no import at all.
 */

/** Every role `ensureRoles` creates, in the order Setup lists them. */
const ALL_ROLES = ["manager", "worker", "reviewer", "orchestrator"] as const;

/** The name each role carries in Paseo (`label` of its alias, `name` of its profile). */
const DISPLAY_NAMES: Readonly<Record<string, string>> = {
  manager: "Beads Manager",
  worker: "Beads Worker",
  reviewer: "Beads Reviewer",
  orchestrator: "Beads Orchestrator",
};

/** `a`, `a and b`, `a, b and c`. */
function listOf(names: readonly string[]): string {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/**
 * The Reviewer's own provider and model, present only when `ensureRoles`
 * created it on another model family's provider than the default (autonomy
 * design §C.5).
 */
export interface ReviewerApart {
  baseProvider: string;
  model: string;
}

/**
 * `<provider> · <model>`, the defaults the roles got, then — only when the
 * Reviewer went elsewhere — `; the Reviewer on <provider> · <model>, another
 * model family`. Shared by both sentences so they name it the same way.
 */
export function rolesDefaultsText(baseProvider: string, model: string, reviewer?: ReviewerApart | null): string {
  const defaults = `${baseProvider} · ${model}`;
  if (reviewer === undefined || reviewer === null) return defaults;
  return `${defaults}; the Reviewer on ${reviewer.baseProvider} · ${reviewer.model}, another model family`;
}

/**
 * `paseo-bm created its roles with defaults (<provider> · <model>). Change them in <where>.`
 * when every role was created; otherwise the same sentence naming the roles
 * created (`its Beads Orchestrator role … Change it …`). A Reviewer created on
 * another model family is named inside the parentheses (`rolesDefaultsText`).
 * `null` when nothing was created or the defaults are unknown.
 */
export function rolesCreatedSentence(
  result: { created: readonly string[]; baseProvider: string | null; model: string | null; reviewer?: ReviewerApart | null },
  where: string,
): string | null {
  const { created, baseProvider, model } = result;
  if (created.length === 0 || baseProvider === null || model === null) return null;
  const every = ALL_ROLES.every((role) => created.includes(role));
  const ordered = [...ALL_ROLES.filter((role) => created.includes(role)), ...created.filter((role) => !(ALL_ROLES as readonly string[]).includes(role))];
  const subject = every
    ? "its roles"
    : `its ${listOf(ordered.map((role) => DISPLAY_NAMES[role] ?? role))} role${ordered.length === 1 ? "" : "s"}`;
  const pronoun = !every && ordered.length === 1 ? "it" : "them";
  return `paseo-bm created ${subject} with defaults (${rolesDefaultsText(baseProvider, model, result.reviewer)}). Change ${pronoun} in ${where}.`;
}
