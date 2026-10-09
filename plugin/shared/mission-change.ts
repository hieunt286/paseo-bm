import { z } from "zod";

/**
 * A mission change on the owner's card (missions design §4, §4.1; ADR-029):
 * what `bm_mission_update` asks and the owner applies with one tap. It rides
 * an `m:` decision's "apply" option as the prepared action
 * `{ kind: "mission-change", missionId, change }` (`decisions.ts`), and the
 * plugin applies it only on the owner's own answer
 * (`server/mission-tools.ts` `answerMissionDecision`), never any agent.
 *
 * Its own module, not `prepared-changes.ts`: the prepared action union
 * (`decisions.ts`) needs the schema while it loads, and
 * `prepared-changes.ts` imports `decisions.ts`.
 *
 * `shared/`: Zod and plain values only.
 */

/** The owner's short code (`server/mission-store.ts` `MISSION_CODE_PATTERN`). */
export const MISSION_CHANGE_CODE_PATTERN = /^[A-Z][A-Z0-9]{1,7}$/;
const missionIdSchema = z.string().regex(/^mis-[0-9a-f]{10}$/);

const budgetValue = z.number().int().min(0).nullable();

/** Every part is optional; an `m:` card carries at least one. */
export const missionChangeSchema = z.object({
  name: z.string().min(1).max(80).optional(),
  code: z.string().regex(MISSION_CHANGE_CODE_PATTERN).optional(),
  goal: z.string().min(1).max(4_000).optional(),
  /** The whole list as it should be. */
  nonGoals: z.array(z.string().min(1).max(300)).max(20).optional(),
  /** `null`: no budget. */
  budget: z.object({ requests: budgetValue, workers: budgetValue, reviewCalls: budgetValue, days: budgetValue }).nullable().optional(),
  confirmCharter: z.literal(true).optional(),
  close: z.literal(true).optional(),
  /** Workspace ids. */
  addRepos: z.array(z.string().min(1)).max(20).optional(),
  removeRepos: z.array(z.string().min(1)).max(20).optional(),
  /** A criterion's new text, or its status `dropped` (or `open` again, from `dropped`). */
  criteria: z
    .array(z.object({ id: z.string().regex(/^D\d{1,4}$/), text: z.string().min(1).max(500).optional(), status: z.enum(["open", "dropped"]).optional() }))
    .max(20)
    .optional(),
});
export type MissionChange = z.infer<typeof missionChangeSchema>;

/** The prepared action an `m:` card's "apply" option carries. */
export const missionChangeActionSchema = z.object({ kind: z.literal("mission-change"), missionId: missionIdSchema, change: missionChangeSchema });
export type MissionChangeAction = z.infer<typeof missionChangeActionSchema>;

/** True when `change` changes nothing. Pure. */
export function isEmptyMissionChange(change: MissionChange): boolean {
  return Object.values(change).every((value) => value === undefined || (Array.isArray(value) && value.length === 0));
}

const quote = (text: string, limit: number): string => {
  const flat = text.replace(/\s+/g, " ").trim();
  return JSON.stringify(flat.length <= limit ? flat : `${flat.slice(0, limit - 1)}…`);
};

/** What applying `change` does, one line per part, for the owner's card. Pure. */
export function missionChangeLinesOf(change: MissionChange): string[] {
  const lines: string[] = [];
  if (change.name !== undefined) lines.push(`rename it ${quote(change.name, 80)}`);
  if (change.code !== undefined) lines.push(`set its code to ${change.code}`);
  if (change.goal !== undefined) lines.push(`set its goal to ${quote(change.goal, 300)}`);
  if (change.nonGoals !== undefined) lines.push(change.nonGoals.length === 0 ? "clear its non-goals" : `set its non-goals to ${change.nonGoals.map((goal) => quote(goal, 80)).join(", ")}`);
  if (change.budget !== undefined) {
    const budget = change.budget;
    const parts = budget === null ? [] : Object.entries(budget).flatMap(([key, value]) => (value === null ? [] : [`${key} ${value}`]));
    lines.push(parts.length === 0 ? "remove its budget" : `set its budget to ${parts.join(", ")}`);
  }
  if ((change.addRepos ?? []).length > 0) lines.push(`add the repos ${change.addRepos!.join(", ")}`);
  if ((change.removeRepos ?? []).length > 0) lines.push(`remove the repos ${change.removeRepos!.join(", ")}`);
  for (const criterion of change.criteria ?? []) {
    if (criterion.text !== undefined) lines.push(`reword ${criterion.id} to ${quote(criterion.text, 200)}`);
    if (criterion.status === "dropped") lines.push(`drop ${criterion.id}`);
    if (criterion.status === "open") lines.push(`restore ${criterion.id}`);
  }
  if (change.confirmCharter === true) lines.push("confirm the charter");
  if (change.close === true) lines.push("close the mission");
  return lines;
}
