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
 */
import { listAllAgents, roleOfAgent, type BmRole } from "./agent-role";
import { SETTINGS_NOTICE_MARKER } from "./notices";
import { enqueue as defaultEnqueue, type NoticeOutcome, type NoticePaseo } from "./notice-queue";
import { RUNTIME_FACTS_HEADING, runtimeFactsOf, runtimeFactsText } from "./role-extras";

/** Which role's Runtime facts carry the child mode of each saved role. */
const CREATOR_OF: Readonly<Partial<Record<BmRole, "manager" | "worker">>> = { worker: "manager", reviewer: "worker" };

/**
 * The child line the creator of `savedRole` is told now (for example
 * ``Worker mode: `bypassPermissions` — …``), `""` when there is none, or
 * `null` when `savedRole` is not a child role (the Manager). Never throws.
 */
export async function childFactLine(savedRole: BmRole, paseo: unknown, cwd?: string): Promise<string | null> {
  const creator = CREATOR_OF[savedRole];
  if (creator === undefined) return null;
  try {
    const text = runtimeFactsText(creator, await runtimeFactsOf(creator, paseo, cwd, () => {}));
    const prefix = `${RUNTIME_FACTS_HEADING}\n\n`;
    return text.startsWith(prefix) ? text.slice(prefix.length) : "";
  } catch {
    return "";
  }
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
      entries: Array<{ agent: { id: string; provider?: string; labels?: Record<string, string> | null; archivedAt?: string | null } }>;
      pageInfo?: { nextCursor: string | null; hasMore: boolean };
    }>;
  };
}

export interface SettingsNoticeDeps {
  enqueue?: (targetId: string, kind: string, text: string, paseo?: NoticePaseo) => Promise<NoticeOutcome>;
  log?: (message: string) => void;
}

/**
 * Sends `line` to every live agent that creates `savedRole`'s agents, when it
 * differs from `before` and is not empty. Returns how many were sent or queued.
 * Never throws.
 */
export async function notifyChildFactChange(
  savedRole: BmRole,
  before: string | null,
  after: string | null,
  paseo: SettingsPaseo,
  deps: SettingsNoticeDeps = {},
): Promise<number> {
  const creator = CREATOR_OF[savedRole];
  if (creator === undefined || after === null || after === "" || after === before) return 0;
  const log = deps.log ?? ((message: string) => console.warn(message));
  try {
    const agents = await listAllAgents((options) => paseo.agents.list(options), { includeArchived: false });
    const targets = agents.filter((agent) => !agent.archivedAt && roleOfAgent(agent)?.role === creator);
    const send = deps.enqueue ?? defaultEnqueue;
    const outcomes = await Promise.all(targets.map((agent) => send(agent.id, SETTINGS_NOTICE_MARKER, settingsNotice(after), paseo)));
    return outcomes.filter((outcome) => outcome === "sent" || outcome === "queued").length;
  } catch (error) {
    log(`[paseo-bm] telling live agents about the new ${savedRole} mode failed: ${error instanceof Error ? error.message : String(error)}`);
    return 0;
  }
}
