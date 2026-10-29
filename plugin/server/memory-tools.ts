/**
 * Project memory's tools and the Main's `bm_repo` (missions design §2.5, §4,
 * §5; ADR-029; REQ-190).
 *
 * | Tool | Caller | Does |
 * |---|---|---|
 * | `bm_memory` | a Main | `read` (`query?`, `id?`, `retired?`), `add` (`kind`, `text`, `source`, `scope?`, `subject?`, `supersedes?`) or `remove` (`id`, `why`) in a repo of its charter; a removal's `why` goes to the mission's journal |
 * | `bm_memory` | a bound Worker | `read`, and `add` of a `fact`, `convention` or `contract` (`scope?`, `subject?`), in its own repo only |
 * | `bm_repo` | a Main | `repo-tool.ts`'s read-only git and file reads, plus `read` (a window of a file's lines), in a repo of its charter only |
 *
 * `read` (delivery line design §18.3) gives, with no `query` and no `id`, an
 * index of the repo's live entries, newest first (`MEMORY_INDEX_ENTRIES`,
 * text cut at `MEMORY_INDEX_TEXT`); a `query` gives the matching entries in
 * full (`MEMORY_QUERY_ENTRIES`), an `id` one entry; `retired: true` adds the
 * retired ones with why. The owner's precedents that hold there
 * (`precedent-store.ts`) follow as `precedent` entries — read through, never
 * copied. The owner's answers to a request's questions
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
import { MAX_ACTIVE_MEMORY, createMemoryStore, scopeOf, type MemoryEntry, type MemoryKind, type MemoryRetirement, type MemoryScope } from "./memory-store";
import { createMissionStore, journalQuietly, type Mission } from "./mission-store";
import { NOT_A_MAIN_MESSAGE, missionOfMain } from "./mission-tools";
import { Refusal } from "./orchestrator-tool-context";
import { directoryIn, listedWorkspaces, type DashboardPaseo } from "./paseo-directory";
import { inCharter, placementOf, repoKeyOf } from "./placements";
import { createPrecedentStore } from "./precedent-store";
import { repoIn, type GitRunner } from "./repo-tool";
import { readWorkspaceMeta } from "./trace-store";
import { actingTools, answered, boundAs, fixThese, refused, withoutNulls, type BoundCaller } from "./tool-kit";

const NOTHING = "Nothing was read or changed.";
/** The live entries an index read shows, newest first (§18.3). */
export const MEMORY_INDEX_ENTRIES = 80;
/** How much of an entry's text an index line shows. */
export const MEMORY_INDEX_TEXT = 160;
/** The entries a query read shows in full, newest first. */
export const MEMORY_QUERY_ENTRIES = 20;
/** The owner's precedents an index read shows, newest first; a query finds the others. */
export const MEMORY_INDEX_PRECEDENTS = 20;
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
  retired?: boolean;
  kind?: MemoryKind;
  text?: string;
  source?: string;
  scope?: MemoryScope;
  subject?: string;
  supersedes?: string;
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
  scope?: MemoryScope;
  subject?: string;
  text: string;
  source: string;
  by: string;
  at: string;
  /** Why paseo-bm retired it (§18.1); only with `retired: true` or an `id`. */
  retired?: MemoryRetirement["reason"];
}

const faceOf = (name: string, role: "manager" | "worker"): ToolFace => MEMORY_TOOL_FACES.find((face) => face.name === name && face.role === role)!;

/** The fields `op` needs and lacks, one line each. Pure. */
function opIssues(input: MemoryInput): string[] {
  const needs: ReadonlyArray<"kind" | "text" | "source" | "id" | "why"> = input.op === "add" ? ["kind", "text", "source"] : input.op === "remove" ? ["id", "why"] : [];
  return needs.filter((field) => input[field] === undefined).map((field) => `input.${field}: ${input.op} needs it`);
}

/** True when every word of `query` is in the entry's text, subject or source, case aside. Pure. */
function matches(entry: ShownEntry, query: string | undefined): boolean {
  if (query === undefined) return true;
  const haystack = `${entry.text} ${entry.subject ?? ""} ${entry.source}`.toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter((word) => word !== "")
    .every((word) => haystack.includes(word));
}

const shown = (entry: MemoryEntry, retirement?: MemoryRetirement): ShownEntry => ({
  id: entry.id,
  kind: entry.kind,
  scope: scopeOf(entry),
  ...(entry.subject === undefined ? {} : { subject: entry.subject }),
  text: entry.text,
  source: entry.source,
  by: entry.by.role,
  at: entry.at,
  ...(retirement === undefined ? {} : { retired: retirement.reason }),
});

/** An index line (§18.3): the entry with its text cut. Pure. */
const indexed = (entry: ShownEntry): Omit<ShownEntry, "source"> => ({
  id: entry.id,
  kind: entry.kind,
  ...(entry.scope === undefined ? {} : { scope: entry.scope }),
  ...(entry.subject === undefined ? {} : { subject: entry.subject }),
  text: entry.text.length <= MEMORY_INDEX_TEXT ? entry.text : `${entry.text.slice(0, MEMORY_INDEX_TEXT - 1)}…`,
  by: entry.by,
  at: entry.at,
  ...(entry.retired === undefined ? {} : { retired: entry.retired }),
});

/** Newest first, the store's order breaking ties. Pure. */
const newestFirst = (entries: readonly ShownEntry[]): ShownEntry[] => [...entries].reverse().sort((a, b) => Date.parse(b.at) - Date.parse(a.at) || 0);

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

  /** Why `project` is not a repo of `mission`'s charter, or null; a placement counts as its repo (delivery line design §3.1). */
  const outsideCharter = (mission: Mission, project: string): ServerToolAnswer | null =>
    inCharter(deps.home(), mission, project)
      ? null
      : refused(`project ${project} is not a repo of mission ${mission.code} (${mission.charter.repos.join(", ") || "none yet"}); add it with bm_mission_update repos first. ${NOTHING}`);

  /** One `bm_memory` call in `project`, by `by`, checked already. */
  const memory = (input: MemoryInput, project: string, by: MemoryEntry["by"]): ServerToolAnswer => {
    const home = deps.home();
    const store = createMemoryStore(home, { now, env });
    if (input.op === "read") {
      const live = store.live(project);
      const retired = store.retired(project);
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
      const counts = { project, live: live.length, retired: retired.length, limit: MAX_ACTIVE_MEMORY };
      if (input.id !== undefined) {
        const found = live.find((entry) => entry.id === input.id);
        const old = retired.find(({ entry }) => entry.id === input.id);
        if (found === undefined && old === undefined) return refused(`memory entry ${input.id} is not an active entry of ${project}; read without an id for the index. ${NOTHING}`);
        return answered({ ...counts, entry: found === undefined ? shown(old!.entry, old!.retirement) : shown(found) });
      }
      const pool = newestFirst([...live.map((entry) => shown(entry)), ...(input.retired === true ? retired.map(({ entry, retirement }) => shown(entry, retirement)) : [])]);
      if (input.query !== undefined) {
        const hits = [...pool, ...precedents].filter((entry) => matches(entry, input.query));
        const entries = hits.slice(0, MEMORY_QUERY_ENTRIES);
        return answered({ ...counts, entries, ...(hits.length > entries.length ? { more: hits.length - entries.length } : {}) });
      }
      const index = pool.slice(0, MEMORY_INDEX_ENTRIES).map(indexed);
      const shownPrecedents = newestFirst(precedents).slice(0, MEMORY_INDEX_PRECEDENTS);
      return answered({
        ...counts,
        index,
        ...(pool.length > index.length ? { more: `${pool.length - index.length} older entries: read with a query or an id` } : {}),
        precedents: shownPrecedents,
        ...(precedents.length > shownPrecedents.length ? { precedentsMore: `${precedents.length - shownPrecedents.length} older precedents: read with a query` } : {}),
      });
    }
    if (input.op === "add") {
      const result = store.add(project, {
        kind: input.kind!,
        text: input.text!,
        source: input.source!,
        by,
        ...(input.scope === undefined ? {} : { scope: input.scope }),
        ...(input.subject === undefined ? {} : { subject: input.subject }),
        ...(input.supersedes === undefined ? {} : { supersedes: input.supersedes }),
      });
      if (!result.ok) return refused([...result.reasons, "Nothing was stored."].join("\n"));
      // §18.3: the entries its subject retires, by id.
      const replaced = store
        .retired(project)
        .filter(({ entry, retirement }) => retirement.reason === "superseded" && retirement.since === result.entry.at && entry.id !== result.entry.id)
        .map(({ entry }) => entry.id);
      // §18.1: a mission's entry never retires a repo entry on the same subject; say so, so the adder can replace it as repo.
      const subject = result.entry.subject?.trim().toLowerCase();
      const kept =
        subject === undefined || scopeOf(result.entry) === "repo"
          ? []
          : store
              .live(project)
              .filter((entry) => entry.id !== result.entry.id && scopeOf(entry) === "repo" && entry.subject?.trim().toLowerCase() === subject)
              .map((entry) => entry.id);
      return answered({
        added: shown(result.entry),
        live: store.live(project).length,
        limit: MAX_ACTIVE_MEMORY,
        ...(replaced.length === 0 ? {} : { retires: replaced }),
        ...(kept.length === 0 ? {} : { stillLive: kept, note: `${kept.join(", ")} (repo) keep${kept.length === 1 ? "s" : ""} holding for later missions; add with scope repo to replace ${kept.length === 1 ? "it" : "them"}.` }),
      });
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
    const project = repoKeyOf(deps.home(), input.project!);
    return outsideCharter(mission, project) ?? memory(input, project, { role: "main", agentId: main.agentId, missionId: mission.missionId });
  };

  const workerMemory = async (raw: unknown, caller: ToolCaller | null): Promise<ServerToolAnswer> => {
    const worker = boundAs(caller, "worker");
    if (worker === null) return refused(MEMORY_NOT_BOUND_MESSAGE);
    const input = withoutNulls(raw ?? {}) as MemoryInput;
    const issues = [...schemaIssues(faceOf("bm_memory", "worker").inputSchema, input)];
    if (issues.length === 0) issues.push(...opIssues(input));
    if (issues.length > 0) return fixThese("bm_memory", issues);
    // Delivery line design §3.1: a Worker in a placement reads and adds to its repo's memory.
    const home = deps.home();
    const own = repoKeyOf(home, worker.workspaceId);
    const project = repoKeyOf(home, input.project ?? worker.workspaceId);
    if (project !== own) {
      return refused(`bm_memory reads and adds to your own repo's memory only (${own}); ask another repo with bm_ask_project. ${NOTHING}`);
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
    // Delivery line design §3.1: the mission's placement of the repo (its own branch) when it has one, else the repo's root.
    const home = deps.home();
    const repo = repoKeyOf(home, input.workspaceId);
    const placement = placementOf(home, found.mission.missionId, repo);
    const own = placement?.workspaceId != null && (placement.state === "ready" || placement.state === "retired") ? placement : null;
    const place = own?.workspaceId ?? repo;
    // The folder Paseo lists for it, else the one recorded or the trace store last saw — never one the agent typed.
    const paseo = deps.paseo();
    const listed = paseo === null || paseo === undefined ? null : await listedWorkspaces(paseo as DashboardPaseo);
    const directory = directoryIn(listed, place) ?? own?.directory ?? readWorkspaceMeta({ tracesDir: join(home, TRACES_DIR_NAME) }, place)?.lastKnownDirectory ?? null;
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
