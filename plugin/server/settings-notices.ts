/**
 * Tells live agents that a child's start mode changed (delta 20260921 §4.3.5,
 * REQ-064 d).
 *
 * The daemon validates an explicit mode BEFORE the `agent.create` hook runs
 * (design F5): a Manager created before the user moved the Worker to another
 * provider would pass the old `## Runtime facts` mode and be refused. So after
 * a save that changes the Runtime-facts line of a child role, every live agent
 * that creates that child gets the new line as a `BM-SETTINGS` notice, through
 * the notice queue (it may be running, design F13):
 *
 * - the Worker line changed → every live Manager, on every workspace;
 * - the Reviewer line changed → every live Worker (fallback Workers too).
 *
 * The queue lives in memory; lost on a plugin reload, the agent falls back to
 * today's behaviour (Paseo refuses the creation, the agent sends `blocked`).
 *
 * The line follows the creator's project (autonomy design §D.2, change-010
 * C5; live check 2026-10-01 F4): in a project whose action boundary is on, a
 * Manager is told the Worker's boundary mode (and a Worker the Reviewer's),
 * as its Runtime facts were written; elsewhere today's mode.
 */
import { boundaryOf } from "../shared/autonomy";
import { listAllAgents, roleOfAgent, type BmRole } from "./agent-role";
import { readAutonomyPolicy } from "./autonomy-rpc";
import { SETTINGS_NOTICE_MARKER } from "./notices";
import { enqueue as defaultEnqueue, type NoticeOutcome, type NoticePaseo } from "./notice-queue";
import { RUNTIME_FACTS_HEADING, modeFactsOf, runtimeFactsText } from "./role-instructions";
import type { BoundarySwitch } from "./role-mode";

/** Which role's Runtime facts carry the child mode of each saved role. */
const CREATOR_OF: Readonly<Partial<Record<BmRole, "manager" | "worker">>> = { worker: "manager", reviewer: "worker" };

/**
 * The child line the creator of `savedRole` is told now (for example
 * ``Worker mode: `bypassPermissions` — …``), in a project whose action
 * boundary switch is `boundary` (`unknown` reads as off), `""` when there is
 * none, or `null` when `savedRole` is not a child role (the Manager). Never throws.
 */
export async function childFactLine(savedRole: BmRole, paseo: unknown, cwd?: string, boundary: BoundarySwitch = "unknown"): Promise<string | null> {
  const creator = CREATOR_OF[savedRole];
  if (creator === undefined) return null;
  try {
    const text = runtimeFactsText(creator, await modeFactsOf(creator, paseo, cwd, () => {}, boundary));
    const prefix = `${RUNTIME_FACTS_HEADING}\n\n`;
    if (!text.startsWith(prefix)) return "";
    // Only the child's mode line: other facts (the Manager's `Worker skills`) are not role settings.
    return text.slice(prefix.length).split("\n").find((line) => / mode: /.test(line)) ?? "";
  } catch {
    return "";
  }
}

/** The child line for a project whose boundary is on, and for the others (off or unknown read the same). */
export interface ChildFactLines {
  on: string | null;
  off: string | null;
}

/** Both child lines of `childFactLine` (live check 2026-10-01 F4); null for a role that is not a child. Never throws. */
export async function childFactLines(savedRole: BmRole, paseo: unknown, cwd?: string): Promise<ChildFactLines | null> {
  if (CREATOR_OF[savedRole] === undefined) return null;
  const [on, off] = await Promise.all([childFactLine(savedRole, paseo, cwd, "on"), childFactLine(savedRole, paseo, cwd, "off")]);
  return { on, off };
}

/** The notice, word for word (agent-facing, so English). */
export function settingsNotice(line: string): string {
  return [
    `${SETTINGS_NOTICE_MARKER} The user changed the paseo-bm role settings. This replaces the matching line under "${RUNTIME_FACTS_HEADING}":`,
    line,
    "Do not reply to this message; carry on with what you were doing.",
  ].join("\n");
}

/**
 * The line a Worker gets when its Manager was replaced after a plugin fallback
 * (delta 20260921 §4.5.2, step 5), word for word.
 */
export function managerIdLine(managerId: string): string {
  return `Manager agent id: \`${managerId}\` — send every BM-REPORT to this agent from now on.`;
}

/** The `BM-SETTINGS` notice that carries `managerIdLine` (agent-facing, so English). */
export function managerIdNotice(managerId: string): string {
  return [
    `${SETTINGS_NOTICE_MARKER} The Beads Manager you report to was replaced. This replaces the Manager agent id you were given:`,
    managerIdLine(managerId),
    "Do not reply to this message; carry on with what you were doing.",
  ].join("\n");
}

/** The SDK slice this module uses; `PaseoApi` is structurally assignable. */
export interface SettingsPaseo extends NoticePaseo {
  agents: NoticePaseo["agents"] & {
    list(options: {
      filter: { includeArchived: boolean };
      page: { limit: number; cursor?: string };
    }): Promise<{
      entries: Array<{ agent: { id: string; provider?: string; labels?: Record<string, string> | null; archivedAt?: string | null; workspaceId?: string | null } }>;
      pageInfo?: { nextCursor: string | null; hasMore: boolean };
    }>;
  };
}

export interface SettingsNoticeDeps {
  enqueue?: (targetId: string, kind: string, text: string, paseo?: NoticePaseo) => Promise<NoticeOutcome>;
  log?: (message: string) => void;
  /** Whether a project's action boundary is on; the owner's policy by default (`autonomy/policy.json`). */
  boundaryOn?: (workspaceId: string) => boolean;
}

/** The line a creator in a project whose boundary is on (or not) gets. */
function lineFor(lines: string | ChildFactLines | null, on: boolean): string | null {
  return lines === null || typeof lines === "string" ? lines : on ? lines.on : lines.off;
}

/**
 * Sends the new line to every live agent that creates `savedRole`'s agents,
 * when it differs from `before` and is not empty. With `ChildFactLines`, each
 * agent gets the line of its project's boundary switch (an agent without a
 * workspace: the off line), and the policy is read only when the two differ.
 * Returns how many were sent or queued. Never throws.
 */
export async function notifyChildFactChange(
  savedRole: BmRole,
  before: string | ChildFactLines | null,
  after: string | ChildFactLines | null,
  paseo: SettingsPaseo,
  deps: SettingsNoticeDeps = {},
): Promise<number> {
  const creator = CREATOR_OF[savedRole];
  const changed = (on: boolean): string | null => {
    const line = lineFor(after, on);
    return line === null || line === "" || line === lineFor(before, on) ? null : line;
  };
  if (creator === undefined || (changed(true) === null && changed(false) === null)) return 0;
  const log = deps.log ?? ((message: string) => console.warn(message));
  try {
    const agents = await listAllAgents((options) => paseo.agents.list(options), { includeArchived: false });
    const targets = agents.filter((agent) => !agent.archivedAt && roleOfAgent(agent)?.role === creator);
    // The project matters only when a project under the boundary is told something else.
    const perProject = lineFor(after, true) !== lineFor(after, false) || lineFor(before, true) !== lineFor(before, false);
    let policyOn: ((workspaceId: string) => boolean) | undefined = deps.boundaryOn;
    const isOn = (workspaceId: unknown): boolean => {
      if (!perProject || typeof workspaceId !== "string" || workspaceId === "") return false;
      if (policyOn === undefined) {
        const policy = readAutonomyPolicy({ log });
        policyOn = (id) => boundaryOf(policy, id) !== null;
      }
      return policyOn(workspaceId);
    };
    const send = deps.enqueue ?? defaultEnqueue;
    const outcomes = await Promise.all(
      targets.flatMap((agent) => {
        const line = changed(isOn((agent as { workspaceId?: unknown }).workspaceId));
        return line === null ? [] : [send(agent.id, SETTINGS_NOTICE_MARKER, settingsNotice(line), paseo)];
      }),
    );
    return outcomes.filter((outcome) => outcome === "sent" || outcome === "queued").length;
  } catch (error) {
    log(`[paseo-bm] telling live agents about the new ${savedRole} mode failed: ${error instanceof Error ? error.message : String(error)}`);
    return 0;
  }
}
