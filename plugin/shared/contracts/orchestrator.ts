import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { coordinationChangeSchema, coordinationSettingsSchema } from "../coordination";
import { orchestratorNoteSchema, proposalSourceSchema, workerSignalSchema } from "../orchestrator";
import { reportPhaseSchema } from "./persisted";

/**
 * The Orchestrator's RPCs (Orchestrator design §8), and Settings →
 * Coordination, the owner's surface for how it coordinates (autonomy design
 * §G.7, ADR-021).
 * Import from `shared/contracts.ts`, which re-exports this module.
 */

// ---------------------------------------------------------------------------
// Orchestrator RPCs (Orchestrator design §8). Additions only; every
// `orchestrator.*` contract lives in this block.
// ---------------------------------------------------------------------------

/**
 * `orchestrator.open-preview` — what the Open Orchestrator dialog shows before
 * the user confirms (Orchestrator design §3.3, §8). Reads only; creates nothing.
 *
 * - `exists`: the one Orchestrator agent (labels `bm.role=orchestrator`,
 *   `bm.orchestrator=main`, not archived) is already there, so `open` only
 *   reopens it.
 * - `provider` / `model`: the provider the `bm-orchestrator` alias extends and
 *   its profile's model (`null` = the provider's default). Without a usable
 *   profile and no agent to reopen → `E_ORCHESTRATOR_UNAVAILABLE`.
 * - `workspace`: `"own"` — the agent is created in a workspace of its own
 *   (`<data folder>/orchestrator/home`); `"choose"` — the user picks one of
 *   their workspaces and `open` takes its `workspaceId` (design §3.3 fallback).
 */
export const orchestratorOpenPreviewRpc = defineRpc({
  name: "orchestrator.open-preview",
  input: z.object({}),
  output: z.object({
    exists: z.boolean(),
    provider: z.string(),
    model: z.string().nullable(),
    workspace: z.enum(["own", "choose"]),
  }),
});

export type OrchestratorOpenPreviewOutput = z.infer<typeof orchestratorOpenPreviewRpc.output>;

/**
 * `orchestrator.open` — returns the one Orchestrator agent, creating it first
 * when there is none (Orchestrator design §3.3, REQ-075 a). `created` says
 * which. `confirmed` is `z.literal(true)`: creating an agent spends the user's
 * tokens, so a call that skipped the dialog fails input validation.
 * `workspaceId` is used only when `open-preview` says `workspace: "choose"`.
 * `recreate: true` creates a new Orchestrator when the existing one has lost
 * its tools or is outdated (`orchestrator.state` says `toolsStale` or
 * `outdated`, design §3.3, §5.1); the old one is left to the user, never
 * archived, and the newest is the Orchestrator from then on. A current
 * Orchestrator is returned as it is.
 * Without a usable `bm-orchestrator` profile or provider →
 * `E_ORCHESTRATOR_UNAVAILABLE`, nothing created.
 */
export const orchestratorOpenRpc = defineRpc({
  name: "orchestrator.open",
  input: z.object({
    confirmed: z.literal(true),
    workspaceId: z.string().min(1).optional(),
    recreate: z.literal(true).optional(),
  }),
  output: z.object({
    agentId: z.string(),
    created: z.boolean(),
  }),
});

export type OrchestratorOpenInput = z.infer<typeof orchestratorOpenRpc.input>;
export type OrchestratorOpenOutput = z.infer<typeof orchestratorOpenRpc.output>;

// ── orchestrator.state (Orchestrator design §8; server/orchestrator-state.ts)

/** A project's health (design §6B.7). */
export const projectHealthSchema = z.enum(["ok", "waiting", "risk", "idle"]);
export type ProjectHealth = z.infer<typeof projectHealthSchema>;

/** Where a project's current request stands (design §6B.7): Work's stage on a project row. */
export const projectStageSchema = z.enum(["idle", "received", "implementing", "reviewing", "waiting-user", "finished"]);
export type ProjectStage = z.infer<typeof projectStageSchema>;

/** One paseo-bm agent of a project, as Work's M W R letters show it (design §6B.7). */
const projectAgentSchema = z.object({ id: z.string(), title: z.string().nullable(), status: z.string() });

/**
 * `orchestrator.state` — the Orchestrator agent and the projects, in one call
 * (Orchestrator design §8): Work's project rows read it. Reads only: one
 * `agents.list` walk, one `workspaces.list`, each workspace's trace store once
 * and the Orchestrator's store.
 *
 * - `agent`: the one Orchestrator agent, or null before it is opened;
 *   `createdAt` is when it was created (null when Paseo did not say).
 *   `previousCount`: how many older non-archived Orchestrators it replaced
 *   (design §3.3) are still in the owner's agent list, 0 without an agent.
 *   `outdated`: it was created with other role instructions than this
 *   plugin's (its `bm.instructions` label, design §3.3); the next wake-up
 *   replaces it.
 *   `toolsStale`: it was created before the plugin's endpoint secret last
 *   changed, so it has lost its tools (design §5.1).
 * - `projects`: workspaces with activity in the last 7 days, at most 30,
 *   newest activity first. `state`: `running` when a paseo-bm agent of the
 *   workspace runs, else `stalled` with an open `request-stalled` Inbox alert
 *   (autonomy design §A.8), else `waiting-user` when its newest request's
 *   last report is `blocked`, else `idle`. `requests` counts the requests
 *   with activity in those 7 days. `lastAction`: the newest command the
 *   Orchestrator sent there — when, its first line and its `source` — or null.
 *   Optional for an older server: `health` (`risk` with an open stall or
 *   Worker signal, else `waiting` when its request waits on the owner, else
 *   `ok` while work goes on, else `idle`); `stage` of the newest request
 *   (from its last report and the running Workers and Reviewers); `agents` —
 *   its Manager, and the Workers and Reviewers of the newest request, running
 *   or with an open signal, each with its status; `lastProgressAt` (the
 *   newest turn end or report of that request); `currentRequest` (its id and
 *   the redacted first line of its text, null when not recorded);
 *   `openSignals` (the open `stuck`, `permission-waiting` and `danger` Inbox
 *   alerts of its Workers, design §6B.3, §A.8); `notes` (the Orchestrator's
 *   notes of the project, §6B.4).
 */
export const orchestratorStateRpc = defineRpc({
  name: "orchestrator.state",
  input: z.object({}),
  output: z.object({
    agent: z
      .object({ id: z.string(), status: z.string(), workspaceId: z.string().nullable(), createdAt: z.string().nullable().optional() })
      .nullable(),
    previousCount: z.number().int().nonnegative().optional(),
    toolsStale: z.boolean(),
    outdated: z.boolean(),
    projects: z.array(
      z.object({
        workspaceId: z.string(),
        workspaceLabel: z.string(),
        managerId: z.string().nullable(),
        managerTitle: z.string().nullable(),
        managerStatus: z.string().nullable(),
        state: z.enum(["running", "waiting-user", "stalled", "idle"]),
        lastActivityAt: z.string().nullable(),
        requests: z.number().int().nonnegative(),
        // Design §6B.7: all optional, absent from an older server.
        health: projectHealthSchema.optional(),
        stage: projectStageSchema.optional(),
        /**
         * The phase of the newest request's last Worker report that names a
         * stage (`blocked` skipped), or null: lets Work's row tell Plan from
         * Build (autonomy design §A.12). Optional, absent from an older server.
         */
        workPhase: reportPhaseSchema.nullable().optional(),
        agents: z
          .object({ manager: projectAgentSchema.nullable(), workers: z.array(projectAgentSchema), reviewers: z.array(projectAgentSchema) })
          .optional(),
        lastProgressAt: z.string().nullable().optional(),
        currentRequest: z.object({ requestId: z.string(), title: z.string().nullable() }).nullable().optional(),
        openSignals: z.array(z.object({ signal: workerSignalSchema, workerId: z.string(), since: z.string() })).optional(),
        notes: z.array(orchestratorNoteSchema).optional(),
        lastAction: z.object({ at: z.string(), text: z.string(), source: proposalSourceSchema }).nullable(),
      }),
    ),
  }),
});

export type OrchestratorStateOutput = z.infer<typeof orchestratorStateRpc.output>;
export type OrchestratorProjectRow = OrchestratorStateOutput["projects"][number];

// ---------------------------------------------------------------------------
// Settings → Coordination (autonomy design §G.7, ADR-021): the owner's
// surface for how the Orchestrator coordinates (`shared/coordination.ts`).
// These two RPCs are the only way to read and set it: no agent tool does, and
// the Orchestrator can only propose a change as a decision (§G.4).
// ---------------------------------------------------------------------------

/**
 * `coordination.settings` — reads only. The stored settings, each missing or
 * out-of-bounds one at its default, and the defaults: the advice cadence, the
 * compaction and handoff switches and thresholds (Phase 3), and `guard`, what
 * the plugin keeps beside those two switches — since when A-12 counts, and
 * whether the A-12 guard switched one off (§G.3). No usable data folder, or a
 * store that cannot be read, reads as the defaults.
 */
export const coordinationSettingsRpc = defineRpc({
  name: "coordination.settings",
  input: z.object({}),
  output: z.object({ settings: coordinationSettingsSchema, defaults: coordinationSettingsSchema }),
});

/**
 * `coordination.set` — the owner sets one setting `{ key, value }` and gets
 * every setting back. An unknown key or a value out of its bounds →
 * `E_COORDINATION_INVALID`; no usable data folder → `E_DATA_HOME_UNAVAILABLE`;
 * a store written by a newer paseo-bm, or one that cannot be written →
 * `E_COORDINATION_WRITE_FAILED`. Nothing is written on any refusal. Sends
 * nothing to any agent. `guard` is not a key: turning `compact.enabled` or
 * `handoff.enabled` on from off makes A-12 count afresh and ends the
 * mechanism's `coordination-off` alert.
 */
export const coordinationSetRpc = defineRpc({
  name: "coordination.set",
  input: coordinationChangeSchema,
  output: z.object({ settings: coordinationSettingsSchema }),
});

export type CoordinationSettingsOutput = z.infer<typeof coordinationSettingsRpc.output>;
export type CoordinationSetOutput = z.infer<typeof coordinationSetRpc.output>;
