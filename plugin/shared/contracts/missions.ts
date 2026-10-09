import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { MISSION_CLASSES } from "../autonomy";
import { agentIdSchema, workspaceIdSchema } from "./persisted";

/**
 * Missions and their Mains (missions design §3.3, §3.4; ADR-029):
 * `missions.create` and `mission.ensure`.
 * Import from `shared/contracts.ts`, which re-exports this module.
 */

/**
 * `missions.create` — with a `name` and a `code`, writes an open mission
 * (`createdBy: owner`) and creates its Main in the Missions home; without
 * either (the Command Center's "New mission"), creates an unassigned Main,
 * whose brief asks the owner for them (§3.3). `missionId` is null then.
 * Refused input → `E_MISSION_INVALID`; the Main cannot be created →
 * `E_PROVIDER_UNAVAILABLE`.
 */
export const missionsCreateRpc = defineRpc({
  name: "missions.create",
  input: z.object({
    name: z.string().max(80).optional(),
    code: z.string().max(8).optional(),
    repos: z.array(workspaceIdSchema).max(50).optional(),
    goal: z.string().max(4_000).optional(),
  }),
  output: z.object({
    missionId: z.string().nullable(),
    agentId: agentIdSchema,
    created: z.boolean(),
    toolsNotice: z.string().nullable().optional(),
    setupNotice: z.string().nullable().optional(),
  }),
});

export type MissionsCreateInput = z.infer<typeof missionsCreateRpc.input>;
export type MissionsCreateOutput = z.infer<typeof missionsCreateRpc.output>;

/**
 * `mission.ensure` — the live Main of an open mission (`findMain`), created in
 * the Missions home when there is none. `replace: "owner"` creates a successor
 * whatever the current Main is; `"outdated"` only when it runs older
 * instructions (§3.4). The old Main is marked `bm.replacedBy`, never archived;
 * `replacedMainId` names it. An unknown or closed mission → `E_MISSION_INVALID`.
 */
export const missionEnsureRpc = defineRpc({
  name: "mission.ensure",
  input: z.object({
    missionId: z.string().min(1),
    replace: z.enum(["outdated", "owner"]).optional(),
  }),
  output: z.object({
    agentId: agentIdSchema,
    created: z.boolean(),
    replacedMainId: agentIdSchema.nullable(),
    toolsNotice: z.string().nullable().optional(),
  }),
});

export type MissionEnsureInput = z.infer<typeof missionEnsureRpc.input>;
export type MissionEnsureOutput = z.infer<typeof missionEnsureRpc.output>;

// ---------------------------------------------------------------------------
// The Missions screen (missions design §10.4): read RPCs and the owner's change.
// ---------------------------------------------------------------------------

/** The governor's families (`GOVERNOR_FAMILIES`, `server/governor-figures.ts`), as the screen shows them. */
export const missionFamilySchema = z.enum(["mess", "overengineering", "drift", "stuck", "budget"]);
/** What a Main is doing now, from its Paseo status (§10.2). */
export const mainStateSchema = z.enum(["idle", "working", "stopped", "none"]);
/** A mission class (`shared/autonomy.ts`). */
const missionClassNameSchema = z.enum(MISSION_CLASSES);

/** One figure the governor computed (`GovernorFigure`), as read now. */
export const missionFigureSchema = z.object({
  id: z.string(),
  value: z.number(),
  threshold: z.number(),
  op: z.enum([">=", ">"]),
  crossed: z.boolean(),
  detail: z.string().nullable(),
});

/** One family of the governor's ladder for a mission (§9.3): its step, its crossed figures, its last action. */
export const missionSignalSchema = z.object({
  family: missionFamilySchema,
  step: z.number().int().min(0).max(4),
  crossed: z.array(missionFigureSchema),
  lastAction: z.object({ kind: z.string(), at: z.string() }).nullable(),
  /** When a re-plan comes due (step 2: the nudge's time plus `governor.windowMinutes`); else null. */
  replanDueAt: z.string().nullable(),
});

/** A repository of a mission, by its project name. */
export const missionRepoSchema = z.object({ workspaceId: workspaceIdSchema, name: z.string() });

/** A mission as the list shows it (§10.2, artboards A and C). */
export const missionSummarySchema = z.object({
  missionId: z.string(),
  code: z.string(),
  name: z.string(),
  state: z.enum(["open", "closed"]),
  createdAt: z.string(),
  closedAt: z.string().nullable(),
  main: z.object({ agentId: agentIdSchema.nullable(), state: mainStateSchema }),
  level: z.number().int().min(0).max(4),
  /** The classes delegated to the Main, in `MISSION_CLASSES` order. */
  delegated: z.array(missionClassNameSchema),
  repos: z.array(missionRepoSchema),
  liveWorkers: z.number().int().min(0),
  requests: z.number().int().min(0),
  /** Met criteria of those not dropped. */
  criteria: z.object({ met: z.number().int().min(0), total: z.number().int().min(0) }),
  /** Open decisions the owner answers for the mission: `q:` of its requests in the owner's Inbox and its `m:` cards. */
  questions: z.number().int().min(0),
  /** The families at step 1 or more, in `GOVERNOR_FAMILIES` order. */
  signals: z.array(missionSignalSchema),
});

/**
 * `missions.list` — every mission (missions design §10.4): open first, newest
 * first, then closed, newest closed first. Reads only.
 */
export const missionsListRpc = defineRpc({
  name: "missions.list",
  input: z.object({}),
  output: z.object({ missions: z.array(missionSummarySchema) }),
});

/** One row of "Workers by repository" (§10.2, artboard B): a roster request. */
export const missionRowSchema = z.object({
  repo: missionRepoSchema,
  requestId: z.string(),
  /** The request's title (its first report's, else the owner's words cut to one line); null when none is known. */
  topic: z.string().nullable(),
  /** Its newest live Worker, else its newest Worker; null when none. */
  workerId: agentIdSchema.nullable(),
  phase: z.enum(["working", "finished", "stopped", "blocked"]),
  /** The ids (`Qn`) of its open questions for the owner. */
  ownerQuestions: z.array(z.string()),
  /** Its live peer links, by partner repository, with their message counts. */
  links: z.array(z.object({ repo: missionRepoSchema, messages: z.number().int().min(0) })),
});

/** `mission.get` — one mission's page (§10.2, artboards B and D). Unknown → `E_MISSION_INVALID`. Reads only. */
export const missionGetRpc = defineRpc({
  name: "mission.get",
  input: z.object({ missionId: z.string().min(1) }),
  output: z.object({
    summary: missionSummarySchema,
    charter: z.object({
      goal: z.string(),
      nonGoals: z.array(z.string()),
      confirmedAt: z.string().nullable(),
      criteria: z.array(z.object({ id: z.string(), text: z.string(), status: z.enum(["open", "met", "dropped"]), at: z.string().nullable() })),
      budget: z.object({ requests: z.number().nullable(), workers: z.number().nullable(), reviewCalls: z.number().nullable(), days: z.number().nullable() }).nullable(),
    }),
    /** Every family, at any step (the page's "within the charter" line needs the quiet ones too). */
    governor: z.array(missionSignalSchema),
    rows: z.array(missionRowSchema),
    contracts: z.array(
      z.object({ id: z.string(), title: z.string(), provider: missionRepoSchema, consumers: z.array(missionRepoSchema), version: z.number().int(), updatedAt: z.string() }),
    ),
    /** The newest journal lines, newest first (at most 50). */
    journal: z.array(z.object({ at: z.string(), kind: z.string(), by: z.string(), text: z.string() })),
    plan: z.object({ text: z.string(), updatedAt: z.string().nullable() }),
  }),
});

/**
 * `mission.change` — the owner's own change from the screen (§10.4), applied
 * at once on the `m:` card's path: name, code, repositories to add, close.
 * Refused (a taken code, an unlisted repo, closing while a Worker runs, a
 * closed or unknown mission, no change) → `E_MISSION_INVALID` with the reasons.
 */
export const missionChangeRpc = defineRpc({
  name: "mission.change",
  input: z.object({
    missionId: z.string().min(1),
    name: z.string().min(1).max(80).optional(),
    code: z.string().min(1).max(8).optional(),
    addRepos: z.array(workspaceIdSchema).min(1).max(20).optional(),
    close: z.literal(true).optional(),
  }),
  output: z.object({ summary: missionSummarySchema }),
});

/** `memory.list` — one repository's project memory, active entries newest first (§10.2, artboard F). Reads only. */
export const memoryListRpc = defineRpc({
  name: "memory.list",
  input: z.object({ workspaceId: workspaceIdSchema }),
  output: z.object({
    workspaceId: workspaceIdSchema,
    name: z.string(),
    total: z.number().int().min(0),
    entries: z.array(
      z.object({
        id: z.string(),
        kind: z.enum(["decision", "precedent", "fact", "convention", "contract"]),
        text: z.string(),
        source: z.string(),
        by: z.object({ role: z.enum(["owner", "main", "worker", "plugin"]), agentId: z.string().nullable() }),
        at: z.string(),
      }),
    ),
  }),
});

export type MissionSummary = z.infer<typeof missionSummarySchema>;
export type MissionSignal = z.infer<typeof missionSignalSchema>;
export type MissionFigure = z.infer<typeof missionFigureSchema>;
export type MissionRow = z.infer<typeof missionRowSchema>;
export type MissionsListOutput = z.infer<typeof missionsListRpc.output>;
export type MissionGetOutput = z.infer<typeof missionGetRpc.output>;
export type MissionChangeInput = z.infer<typeof missionChangeRpc.input>;
export type MissionChangeOutput = z.infer<typeof missionChangeRpc.output>;
export type MemoryListOutput = z.infer<typeof memoryListRpc.output>;
