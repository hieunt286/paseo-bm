/**
 * Project memory's tools and the Main's `bm_repo` (missions design §2.5, §4,
 * §5; ADR-029; REQ-190).
 *
 * | Tool | Caller | Does |
 * |---|---|---|
 * | `bm_memory` | a Main | `read` (`query?`), `add` (`kind`, `text`, `source`) or `remove` (`id`, `why`) in a repo of its charter; a removal's `why` goes to the mission's journal |
 * | `bm_memory` | a bound Worker | `read`, and `add` of a `fact`, `convention` or `contract`, in its own repo only |
 * | `bm_repo` | a Main | `repo-tool.ts`'s read-only git and file reads, plus `read` (a window of a file's lines), in a repo of its charter only |
 *
 * `read` lists the repo's active entries, oldest first, then the owner's
 * precedents that hold there (`precedent-store.ts`) as `precedent` entries —
 * read through, never copied. The owner's answers to a request's questions
 * are added by the decision store (`decision-store.ts`, `ownerAnswerEntryOf`).
 *
 * Common rules (§7.15): a refusal is one line per reason and changes nothing;
 * a pending binding is refused by the shared guard; the caller's mission and
 * repo come from its binding, never from the input. Text is masked by the
 * memory store; `bm_repo` redacts what it reads. Nothing here throws into the
 * endpoint.
 */
import { join } from "node:path";
import type { ToolCaller } from "./agent-bindings";
import { MEMORY_TOOL_FACES, schemaIssues, type MainRepoAction, type ToolFace } from "../shared/bm-tools";
import { TRACES_DIR_NAME } from "./data-home";
import type { ServerToolAnswer, ServerTools } from "./decision-tools";
import { MAX_ACTIVE_MEMORY, createMemoryStore, type MemoryEntry, type MemoryKind } from "./memory-store";
import { createMissionStore, journalQuietly, type Mission } from "./mission-store";
import { NOT_A_MAIN_MESSAGE, missionOfMain } from "./mission-tools";
import { Refusal } from "./orchestrator-tool-context";
import { directoryIn, listedWorkspaces, type DashboardPaseo } from "./paseo-directory";
import { createPrecedentStore } from "./precedent-store";
import { repoIn, type GitRunner } from "./repo-tool";
import { readWorkspaceMeta } from "./trace-store";
import { actingTools, answered, boundAs, fixThese, refused, withoutNulls, type BoundCaller } from "./tool-kit";

const NOTHING = "Nothing was read or changed.";
/** A caller that is neither a Main nor a bound Worker. */
export const MEMORY_NOT_BOUND_MESSAGE = `bm_memory and bm_repo are only for a Main or a Worker paseo-bm created with its own tools. ${NOTHING}`;

export interface MemoryToolDeps {
  /** The last Paseo handle a hook or RPC brought; null before any did. */
  paseo: () => unknown;
  /** The data folder (the endpoint's). */
  home: () => string;
  now?: () => Date;
  /** How `bm_repo` runs git; `runGit` by default. */
  git?: GitRunner;
  /** Secrets to mask; the process's own by default. */
  env?: NodeJS.ProcessEnv;
  /** Where a failure that does not fail the call goes; `console.warn` by default. */
  log?: (message: string) => void;
}

/** The memory tools a bound Manager (a Main) and a bound Worker list. */
export interface MemoryTools {
  manager: ServerTools;
  worker: ServerTools;
}

interface MemoryInput {
  project?: string;
  op: "read" | "add" | "remove";
  query?: string;
  kind?: MemoryKind;
  text?: string;
  source?: string;
  id?: string;
  why?: string;
}

interface MainRepoInput {
  workspaceId: string;
  action: MainRepoAction;
  path?: string;
  file?: string;
  from?: number;
  lines?: number;
}

/** One entry as `read` shows it. */
interface ShownEntry {
  id: string;
  kind: string;
  text: string;
  source: string;
  by: string;
  at: string;
}

const faceOf = (name: string, role: "manager" | "worker"): ToolFace => MEMORY_TOOL_FACES.find((face) => face.name === name && face.role === role)!;

/** The fields `op` needs and lacks, one line each. Pure. */
function opIssues(input: MemoryInput): string[] {
  const needs: ReadonlyArray<"kind" | "text" | "source" | "id" | "why"> = input.op === "add" ? ["kind", "text", "source"] : input.op === "remove" ? ["id", "why"] : [];
  return needs.filter((field) => input[field] === undefined).map((field) => `input.${field}: ${input.op} needs it`);
}

/** True when every word of `query` is in the entry's text or source, case aside. Pure. */
function matches(entry: ShownEntry, query: string | undefined): boolean {
  if (query === undefined) return true;
  const haystack = `${entry.text} ${entry.source}`.toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter((word) => word !== "")
    .every((word) => haystack.includes(word));
}

const shown = (entry: MemoryEntry): ShownEntry => ({ id: entry.id, kind: entry.kind, text: entry.text, source: entry.source, by: entry.by.role, at: entry.at });

/** `bm_memory` and the Main's `bm_repo`, as server-run tools the endpoint composes with its others. Never throws. */
export function createMemoryTools(deps: MemoryToolDeps): MemoryTools {
  const now = deps.now ?? (() => new Date());
  const env = deps.env ?? process.env;
  const log = deps.log ?? ((message: string) => console.warn(message));

  /** The caller as a Main with its mission, or its refusal. */
  const mainOf = (caller: ToolCaller | null): { main: BoundCaller; mission: Mission } | ServerToolAnswer => {
    const main = boundAs(caller, "manager");
    if (main === null) return refused(MEMORY_NOT_BOUND_MESSAGE);
    const mission = missionOfMain(deps.home(), main);
    return mission === null ? refused(NOT_A_MAIN_MESSAGE) : { main, mission };
  };

  /** Why `project` is not a repo of `mission`'s charter, or null. */
  const outsideCharter = (mission: Mission, project: string): ServerToolAnswer | null =>
    mission.charter.repos.includes(project)
      ? null
      : refused(`project ${project} is not a repo of mission ${mission.code} (${mission.charter.repos.join(", ") || "none yet"}); add it with bm_mission_update repos first. ${NOTHING}`);

  /** One `bm_memory` call in `project`, by `by`, checked already. */
  const memory = (input: MemoryInput, project: string, by: MemoryEntry["by"]): ServerToolAnswer => {
    const home = deps.home();
    const store = createMemoryStore(home, { now, env });
    if (input.op === "read") {
      const active = store.active(project);
      const precedents = createPrecedentStore(home)
        .active(now(), project)
        .map((precedent): ShownEntry => ({
          id: precedent.id,
          kind: "precedent",
          text: `${precedent.subject}: ${precedent.text}`,
          source: precedent.sourceDecisionId ?? "the owner's Settings",
          by: "owner",
          at: precedent.createdAt,
        }));
      const entries = [...active.map(shown), ...precedents].filter((entry) => matches(entry, input.query));
      return answered({ project, active: active.length, limit: MAX_ACTIVE_MEMORY, entries });
    }
    if (input.op === "add") {
      const result = store.add(project, { kind: input.kind!, text: input.text!, source: input.source!, by });
      if (!result.ok) return refused([...result.reasons, "Nothing was stored."].join("\n"));
      return answered({ added: shown(result.entry), active: store.active(project).length, limit: MAX_ACTIVE_MEMORY });
    }
    const result = store.remove(project, input.id!);
    if (!result.ok) return refused([...result.reasons, "Nothing was changed."].join("\n"));
    if (by.missionId !== null) {
      journalQuietly(createMissionStore(home, { now }), by.missionId, { kind: "note", by: "main", text: `The Main removed memory entry ${input.id} of ${project}: ${input.why}`, ref: input.id! }, log);
    }
    return answered({ removed: input.id });
  };

  const mainMemory = async (raw: unknown, caller: ToolCaller | null): Promise<ServerToolAnswer> => {
    const found = mainOf(caller);
    if ("ok" in found) return found;
    const input = withoutNulls(raw ?? {}) as MemoryInput;
    const issues = [...schemaIssues(faceOf("bm_memory", "manager").inputSchema, input)];
    if (issues.length === 0) issues.push(...opIssues(input));
    if (issues.length > 0) return fixThese("bm_memory", issues);
    const { main, mission } = found;
    const project = input.project!;
    return outsideCharter(mission, project) ?? memory(input, project, { role: "main", agentId: main.agentId, missionId: mission.missionId });
  };

  const workerMemory = async (raw: unknown, caller: ToolCaller | null): Promise<ServerToolAnswer> => {
    const worker = boundAs(caller, "worker");
    if (worker === null) return refused(MEMORY_NOT_BOUND_MESSAGE);
    const input = withoutNulls(raw ?? {}) as MemoryInput;
    const issues = [...schemaIssues(faceOf("bm_memory", "worker").inputSchema, input)];
    if (issues.length === 0) issues.push(...opIssues(input));
    if (issues.length > 0) return fixThese("bm_memory", issues);
    const project = input.project ?? worker.workspaceId;
    if (project !== worker.workspaceId) {
      return refused(`bm_memory reads and adds to your own repo's memory only (${worker.workspaceId}); ask another repo with bm_ask_project. ${NOTHING}`);
    }
    return memory(input, project, { role: "worker", agentId: worker.agentId, missionId: worker.missionId ?? null });
  };

  const mainRepo = async (raw: unknown, caller: ToolCaller | null): Promise<ServerToolAnswer> => {
    const found = mainOf(caller);
    if ("ok" in found) return found;
    const input = withoutNulls(raw ?? {}) as MainRepoInput;
    const issues = schemaIssues(faceOf("bm_repo", "manager").inputSchema, input);
    if (issues.length > 0) return fixThese("bm_repo", issues);
    const outside = outsideCharter(found.mission, input.workspaceId);
    if (outside !== null) return outside;
    // The folder Paseo lists for the repo, else the one the trace store last saw — never one the agent typed.
    const home = deps.home();
    const paseo = deps.paseo();
    const listed = paseo === null || paseo === undefined ? null : await listedWorkspaces(paseo as DashboardPaseo);
    const directory = directoryIn(listed, input.workspaceId) ?? readWorkspaceMeta({ tracesDir: join(home, TRACES_DIR_NAME) }, input.workspaceId)?.lastKnownDirectory ?? null;
    try {
      return await repoIn(input, directory, env, deps.git === undefined ? {} : { git: deps.git });
    } catch (error) {
      if (error instanceof Refusal) return refused(`${error.message}. Nothing was read.`);
      throw error;
    }
  };

  return {
    manager: actingTools(
      MEMORY_TOOL_FACES.filter((face) => face.role === "manager"),
      { bm_memory: mainMemory, bm_repo: mainRepo },
      NOTHING,
    ),
    worker: actingTools(
      MEMORY_TOOL_FACES.filter((face) => face.role === "worker"),
      { bm_memory: workerMemory },
      NOTHING,
    ),
  };
}
