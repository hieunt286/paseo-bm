import { vi, type Mock } from "vitest";

/**
 * The one fake of the Paseo handle a plugin gets (`context.paseo`), for every
 * test that needs one (bead 81y2.16, code review 2026-09-30 §7: 22 `fakePaseo`
 * and 11 `fakeDaemon` copies had drifted apart, `config.patch` among them).
 *
 * It keeps a small daemon in memory — agents, their timelines, workspaces, the
 * daemon configuration and the providers — and answers in the shapes of the
 * SDK (`@getpaseo/client` `PaseoApi`), not in the shape one caller happens to
 * read:
 *
 * - `agents.list` honours `filter.labels`, leaves archived agents out unless
 *   `filter.includeArchived`, and pages with `page.limit` / `page.cursor`
 *   (capped by `pageSize`, as the daemon caps a page);
 * - `agents.ref(id)` returns one handle per id: `refresh()` answers `null` for
 *   an agent the daemon does not know and `{ agent, project }` otherwise;
 *   `send()` records the message and starts a turn (`status: "running"`);
 *   `archive()` stamps `archivedAt`; `respondToPermission()` records the
 *   answer and takes the request out of the agent's `pendingPermissions`;
 *   `timeline.refetch()` pages the agent's
 *   timeline (`direction: "tail" | "before"`, `cursor`, `limit`);
 * - `workspaces.ref(id).agents.create` and `agents.create` add an agent (with
 *   `paseo.parent-agent-id` when a parent is given);
 * - `config.patch` applies a patch as the daemon does (`applyConfigPatch`) and
 *   answers `{ requestId, config }`.
 *
 * Every method is a `vi.fn`, so a test can assert on it or swap its
 * implementation (`fake.handle(id).send.mockRejectedValue(...)`); `omit` drops
 * the members a narrower host does not have.
 *
 * A test passes the narrow handle type its code takes as `T`
 * (`fakePaseo<ManagerPaseo>(...)`); `fake.paseo` is typed as that and
 * `fake.api` is the same object with its mocks visible.
 */

export interface FakeAgent {
  id: string;
  workspaceId?: string | null;
  status?: string;
  provider?: string;
  labels?: Record<string, string>;
  createdAt?: string;
  archivedAt?: string | null;
  [key: string]: unknown;
}

/**
 * An agent's timeline, oldest entry first. A flat list pages by `limit`; `{ pages }`
 * fixes the page boundaries (oldest page first): `tail` answers the last page and
 * `before` with a page's `startCursor` the one before it.
 */
export type FakeTimeline = readonly unknown[] | { pages: ReadonlyArray<readonly unknown[]> };

export interface FakeListOptions {
  filter?: { labels?: Record<string, string>; includeArchived?: boolean };
  page?: { limit?: number; cursor?: string };
}

export interface FakeTimelineOptions {
  direction?: string;
  cursor?: unknown;
  limit?: number;
  [key: string]: unknown;
}

export interface FakeTimelinePage {
  agent: FakeAgent | null;
  entries: unknown[];
  hasOlder: boolean;
  startCursor: number | null;
}

export interface FakeCreateRequest {
  config: { provider: string; [key: string]: unknown };
  cwd?: string;
  parent?: string | { id: string };
  title?: string;
  labels?: Record<string, string>;
  prompt?: string;
  [key: string]: unknown;
}

export interface FakeAgentHandle {
  readonly id: string;
  current: Mock<() => FakeAgent | null>;
  refresh: Mock<() => Promise<{ agent: FakeAgent; project: null } | null>>;
  send: Mock<(text: string) => Promise<void>>;
  archive: Mock<() => Promise<{ archivedAt: string }>>;
  respondToPermission: Mock<(options: { requestId: string; response: unknown }) => Promise<void>>;
  timeline: { refetch: Mock<(options?: FakeTimelineOptions) => Promise<FakeTimelinePage>> };
}

export interface FakeWorkspaceHandle {
  readonly id: string;
  agents: { create: Mock<(request: FakeCreateRequest) => Promise<FakeAgentHandle>> };
}

type Answer = Promise<Record<string, unknown>>;

export interface FakeApi {
  agents: {
    list: Mock<(options?: FakeListOptions) => Promise<{ requestId: string; entries: Array<{ agent: FakeAgent }>; pageInfo: { nextCursor: string | null; hasMore: boolean } }>>;
    ref: Mock<(agentId: string) => FakeAgentHandle>;
    create: Mock<(request: FakeCreateRequest) => Promise<FakeAgentHandle>>;
  };
  workspaces: {
    list: Mock<(options?: unknown) => Promise<{ requestId: string; entries: Array<Record<string, unknown>>; pageInfo: { nextCursor: string | null; hasMore: boolean } }>>;
    open: Mock<(input: string | { cwd: string }) => Promise<{ id: string; directory: string }>>;
    ref: Mock<(workspaceId: string) => FakeWorkspaceHandle>;
  };
  providers: {
    listAvailable: Mock<() => Answer>;
    listModes: Mock<(provider: string) => Answer>;
    listModels: Mock<(provider: string) => Answer>;
    listFeatures: Mock<(draft: { provider: string; [key: string]: unknown }) => Answer>;
    listUsage: Mock<() => Answer>;
  };
  config: {
    get: Mock<() => Promise<{ requestId: string; config: Record<string, unknown> }>>;
    patch: Mock<(patch: Record<string, unknown>) => Promise<{ requestId: string; config: Record<string, unknown> }>>;
  };
}

/** Per provider (a table, or a function of the provider id): a list, a whole answer, or an Error to reject with. */
export type FakeProviderAnswers = Record<string, unknown> | ((provider: string) => unknown);

export interface FakeProviders {
  /** `listAvailable`: provider ids (each available), whole entries, or an Error to reject with. Default: claude and codex. */
  available?: ReadonlyArray<string | { provider: string; available: boolean; [key: string]: unknown }> | Error;
  /** `listModes`: a provider's modes. A provider the table does not name has none. */
  modes?: FakeProviderAnswers;
  /** `listModels`, the same way. */
  models?: FakeProviderAnswers;
  /** `listFeatures`, keyed by `draft.provider`, the same way. */
  features?: FakeProviderAnswers;
  /** What `listUsage` answers, or an Error to reject with. */
  usage?: Record<string, unknown> | Error;
}

export interface FakePaseoOptions {
  /**
   * The daemon's agents. The fake keeps its own copies and changes them (a send
   * starts a turn, an archive stamps `archivedAt`). Any snapshot type with an
   * `id` will do, so a test can pass the type its code reads.
   */
  agents?: ReadonlyArray<FakeAgent | { id: string }>;
  /** Each agent's timeline; an agent without one has an empty timeline. */
  timelines?: Record<string, FakeTimeline>;
  /** Statuses an agent reports on successive `refresh()` calls; the last one repeats. */
  statuses?: Record<string, readonly string[]>;
  /** What `workspaces.list` answers. */
  workspaces?: ReadonlyArray<Record<string, unknown>>;
  /** The daemon configuration `config.get` answers and `config.patch` changes, or an Error `config.get` rejects with. Default `{}`. */
  config?: Record<string, unknown> | Error;
  /** `config.patch` rejects with this Error; or `"ignore"`: it answers as if applied and changes nothing. */
  patch?: Error | "ignore";
  providers?: FakeProviders;
  /** The most agents one `agents.list` page returns, whatever the caller asks. */
  pageSize?: number;
  /**
   * A daemon that lists every agent whatever the filter asks (labels, archived),
   * so a test can prove the code's own checks rather than the daemon's.
   */
  ignoresListFilter?: boolean;
  /** Sees each message before the daemon takes it; throwing (or rejecting) refuses it, and nothing is recorded. */
  onSend?: (message: { id: string; text: string }) => void | Promise<void>;
  /**
   * Shapes an agent the fake creates: return fields that replace the defaults
   * (`id: created-<n>`, `status: "idle"`, a createdAt from `n`). It may await,
   * and it may throw to refuse the creation (nothing is added then).
   */
  created?: (request: FakeCreateRequest, context: { n: number; workspaceId: string | null }) => Partial<FakeAgent> | Promise<Partial<FakeAgent>>;
  /** Members the host does not have, as dotted paths: `"agents.ref"`, `"config"`, `"providers.listModes"`. */
  omit?: readonly string[];
}

export interface FakePaseo<T> {
  /** The handle, typed as the caller's narrow host type. */
  paseo: T;
  /** The same object, with every member a mock. */
  api: FakeApi;
  /** The agents the daemon holds now (live: creations add to it, sends and archives change it). */
  agents: FakeAgent[];
  byId(id: string): FakeAgent | undefined;
  /** Replaces the daemon's agents, as changes made elsewhere would. */
  setAgents(next: ReadonlyArray<FakeAgent | { id: string }>): void;
  /** Replaces one agent's timeline, as its next turn would. */
  setTimeline(id: string, timeline: FakeTimeline): void;
  /** The one handle `agents.ref(id)` returns for `id`, without counting as a `ref` call. */
  handle(id: string): FakeAgentHandle;
  /** The daemon configuration now (live), typed as the caller reads it. */
  config<C = Record<string, unknown>>(): C;
  /** Replaces the daemon configuration, as a change made elsewhere would. */
  setConfig(next: Record<string, unknown>): void;
  sends: Array<{ id: string; text: string }>;
  refreshes: string[];
  /** Every timeline read: whose, with which options, and how many entries it returned. */
  refetches: Array<{ id: string; options: FakeTimelineOptions; entries: number }>;
  creates: Array<{ workspaceId: string | null; options: FakeCreateRequest }>;
  archives: string[];
  patches: Array<Record<string, unknown>>;
  permissions: Array<{ id: string; requestId: string; response: unknown }>;
  /** The options of every `agents.list` call. */
  lists: FakeListOptions[];
  /** Every call to the host, in order: `agents.list`, `config.patch`, `providers.listModes:<provider>`, `agent.send:<id>` … */
  calls: string[];
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;

const merged = (base: unknown, change: Record<string, unknown>): Record<string, unknown> => ({ ...(isPlainObject(base) ? base : {}), ...change });

/**
 * What the daemon does with a `config.patch` (design §6; Paseo 0.9.2
 * `applyMutableProviderConfigToOverrides`): each `providers` entry is merged
 * into the alias it names, and its `paseoTools` one level further;
 * `removeProviders` deletes aliases; `agentProfiles` replaces the whole array;
 * any other object (`mcp`, …) is merged, anything else replaced.
 */
export function applyConfigPatch(config: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const next: Record<string, unknown> = structuredClone(config);
  const change: Record<string, unknown> = structuredClone(patch);
  for (const [key, value] of Object.entries(change)) {
    if (key === "removeProviders") continue;
    if (key === "providers" && isPlainObject(value)) {
      const providers: Record<string, unknown> = isPlainObject(next.providers) ? next.providers : {};
      for (const [id, entry] of Object.entries(value)) {
        if (!isPlainObject(entry)) continue;
        const previous = isPlainObject(providers[id]) ? providers[id] : {};
        providers[id] = { ...merged(previous, entry), ...(isPlainObject(entry.paseoTools) ? { paseoTools: merged(previous.paseoTools, entry.paseoTools) } : {}) };
      }
      next.providers = providers;
    } else {
      next[key] = key !== "agentProfiles" && isPlainObject(value) ? merged(next[key], value) : value;
    }
  }
  const removed = change.removeProviders;
  if (Array.isArray(removed) && isPlainObject(next.providers)) {
    for (const id of removed) delete next.providers[String(id)];
  }
  return next;
}

function answerFor(answers: FakeProviderAnswers | undefined, key: string, wrap: (list: unknown[]) => Record<string, unknown>): Record<string, unknown> {
  const value = typeof answers === "function" ? answers(key) : answers?.[key];
  if (value instanceof Error) throw value;
  if (value === undefined) return wrap([]);
  if (Array.isArray(value)) return wrap(value);
  return value as Record<string, unknown>;
}

function omitPath(target: Record<string, unknown>, path: string) {
  const parts = path.split(".");
  let node: unknown = target;
  for (const part of parts.slice(0, -1)) node = isPlainObject(node) ? node[part] : undefined;
  if (isPlainObject(node)) delete node[parts[parts.length - 1]!];
}

const matchesLabels = (agent: FakeAgent, labels: Record<string, string> | undefined) =>
  Object.entries(labels ?? {}).every(([key, value]) => agent.labels?.[key] === value);

export function fakePaseo<T = FakeApi>(options: FakePaseoOptions = {}): FakePaseo<T> {
  const agents: FakeAgent[] = (options.agents ?? []).map((agent) => ({ ...agent }) as FakeAgent);
  const byId = (id: string) => agents.find((agent) => agent.id === id);
  const timelines: Record<string, FakeTimeline> = { ...options.timelines };
  const scripts = new Map(Object.entries(options.statuses ?? {}).map(([id, list]) => [id, [...list]]));
  const config: Record<string, unknown> = options.config instanceof Error ? {} : structuredClone(options.config ?? {});
  const record = {
    sends: [] as FakePaseo<T>["sends"],
    refreshes: [] as string[],
    refetches: [] as FakePaseo<T>["refetches"],
    creates: [] as FakePaseo<T>["creates"],
    archives: [] as string[],
    patches: [] as Array<Record<string, unknown>>,
    permissions: [] as FakePaseo<T>["permissions"],
    lists: [] as FakeListOptions[],
    calls: [] as string[],
  };
  let requests = 0;
  const requestId = () => `fake-${++requests}`;
  /** What the daemon hands out: a copy, so a caller cannot change the fake's agent. */
  const copyOf = (agent: FakeAgent): FakeAgent => (agent.labels ? { ...agent, labels: { ...agent.labels } } : { ...agent });
  /** Replaces the configuration's contents, so `fake.config()` stays the live object. */
  const replaceConfig = (next: Record<string, unknown>) => {
    for (const key of Object.keys(config)) delete config[key];
    Object.assign(config, next);
  };

  const readTimeline = (id: string, request: FakeTimelineOptions = {}): FakeTimelinePage => {
    const agent = byId(id);
    const answer = (entries: readonly unknown[], hasOlder: boolean, startCursor: number | null): FakeTimelinePage => ({
      agent: agent === undefined ? null : copyOf(agent),
      entries: [...entries],
      hasOlder,
      startCursor,
    });
    const timeline = timelines[id] ?? [];
    if (!Array.isArray(timeline)) {
      const { pages } = timeline as { pages: ReadonlyArray<readonly unknown[]> };
      const index = request.direction === "before" ? Number(request.cursor) - 1 : pages.length - 1;
      const page = pages[index];
      return page === undefined ? answer([], false, null) : answer(page, pages.slice(0, index).some((older) => older.length > 0), index);
    }
    const all = timeline as readonly unknown[];
    const end = request.direction === "before" && request.cursor !== undefined ? Number(request.cursor) : all.length;
    const start = request.limit === undefined || request.limit === 0 ? 0 : Math.max(0, end - request.limit);
    return answer(all.slice(start, end), start > 0, all.length === 0 ? null : start);
  };

  const handles = new Map<string, FakeAgentHandle>();
  const handle = (id: string): FakeAgentHandle => {
    const existing = handles.get(id);
    if (existing !== undefined) return existing;
    const created: FakeAgentHandle = {
      id,
      current: vi.fn(() => {
        const agent = byId(id);
        return agent === undefined ? null : copyOf(agent);
      }),
      refresh: vi.fn(async () => {
        record.refreshes.push(id);
        record.calls.push(`agent.refresh:${id}`);
        const agent = byId(id);
        if (agent === undefined) return null;
        const script = scripts.get(id);
        const status = script === undefined || script.length === 0 ? agent.status : script.length > 1 ? script.shift() : script[0];
        return { agent: { ...copyOf(agent), ...(status === undefined ? {} : { status }) }, project: null };
      }),
      send: vi.fn(async (text: string) => {
        await options.onSend?.({ id, text });
        record.sends.push({ id, text });
        record.calls.push(`agent.send:${id}`);
        const agent = byId(id);
        // A message starts a turn, as on the daemon.
        if (agent !== undefined) agent.status = "running";
      }),
      archive: vi.fn(async () => {
        record.archives.push(id);
        record.calls.push(`agent.archive:${id}`);
        const archivedAt = new Date().toISOString();
        const agent = byId(id);
        if (agent !== undefined) agent.archivedAt = archivedAt;
        return { archivedAt };
      }),
      respondToPermission: vi.fn(async (answer: { requestId: string; response: unknown }) => {
        record.permissions.push({ id, requestId: answer.requestId, response: answer.response });
        record.calls.push(`agent.respondToPermission:${id}`);
        // An answered request is no longer pending, as on the daemon.
        const agent = byId(id);
        if (agent !== undefined && Array.isArray(agent.pendingPermissions)) {
          agent.pendingPermissions = (agent.pendingPermissions as Array<{ id?: unknown }>).filter((request) => request.id !== answer.requestId);
        }
      }),
      timeline: {
        refetch: vi.fn(async (request: FakeTimelineOptions = {}) => {
          const page = readTimeline(id, request);
          record.refetches.push({ id, options: request, entries: page.entries.length });
          record.calls.push(`agent.timeline:${id}`);
          return page;
        }),
      },
    };
    handles.set(id, created);
    return created;
  };

  let creations = 0;
  const create = async (workspaceId: string | null, request: FakeCreateRequest, call: string): Promise<FakeAgentHandle> => {
    record.creates.push({ workspaceId, options: request });
    record.calls.push(call);
    const n = ++creations;
    const parent = typeof request.parent === "string" ? request.parent : request.parent?.id;
    const shaped = (await options.created?.(request, { n, workspaceId })) ?? {};
    const agent: FakeAgent = {
      id: `created-${n}`,
      workspaceId,
      status: "idle",
      provider: request.config.provider,
      labels: { ...(request.labels ?? {}), ...(parent === undefined ? {} : { "paseo.parent-agent-id": parent }) },
      createdAt: new Date(Date.UTC(2026, 8, 15, 12, n)).toISOString(),
      archivedAt: null,
      ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
      ...(request.title === undefined ? {} : { title: request.title }),
      ...shaped,
    };
    agents.push(agent);
    return handle(agent.id);
  };

  const workspaceHandles = new Map<string, FakeWorkspaceHandle>();
  const workspaces = (options.workspaces ?? []).map((workspace) => ({ ...workspace }));
  const providers = options.providers ?? {};

  const api: FakeApi = {
    agents: {
      list: vi.fn(async (request: FakeListOptions = {}) => {
        record.lists.push(request);
        record.calls.push("agents.list");
        const matching = options.ignoresListFilter
          ? agents
          : agents.filter((agent) => matchesLabels(agent, request.filter?.labels) && (request.filter?.includeArchived === true || !agent.archivedAt));
        const start = request.page?.cursor === undefined ? 0 : Number(request.page.cursor);
        const size = Math.min(request.page?.limit ?? Number.POSITIVE_INFINITY, options.pageSize ?? Number.POSITIVE_INFINITY);
        const page = matching.slice(start, start + size);
        const next = start + page.length;
        const hasMore = next < matching.length;
        return {
          requestId: requestId(),
          entries: page.map((agent) => ({ agent: copyOf(agent) })),
          pageInfo: { nextCursor: hasMore ? String(next) : null, hasMore },
        };
      }),
      ref: vi.fn((agentId: string) => handle(agentId)),
      create: vi.fn(async (request: FakeCreateRequest) => {
        const workspace = workspaces.find((entry) => request.cwd !== undefined && entry.directory === request.cwd);
        return create(typeof workspace?.id === "string" ? workspace.id : null, request, "agents.create");
      }),
    },
    workspaces: {
      list: vi.fn(async () => {
        record.calls.push("workspaces.list");
        return { requestId: requestId(), entries: workspaces.map((workspace) => ({ ...workspace })), pageInfo: { nextCursor: null, hasMore: false } };
      }),
      open: vi.fn(async (input: string | { cwd: string }) => {
        record.calls.push("workspaces.open");
        const cwd = typeof input === "string" ? input : input.cwd;
        const known = workspaces.find((workspace) => workspace.directory === cwd);
        return { id: typeof known?.id === "string" ? known.id : "wks-own", directory: cwd };
      }),
      ref: vi.fn((workspaceId: string) => {
        const existing = workspaceHandles.get(workspaceId);
        if (existing !== undefined) return existing;
        const created: FakeWorkspaceHandle = {
          id: workspaceId,
          agents: { create: vi.fn((request: FakeCreateRequest) => create(workspaceId, request, "workspaces.agents.create")) },
        };
        workspaceHandles.set(workspaceId, created);
        return created;
      }),
    },
    providers: {
      listAvailable: vi.fn(async () => {
        record.calls.push("providers.listAvailable");
        const available = providers.available ?? ["claude", "codex"];
        if (available instanceof Error) throw available;
        return { providers: available.map((entry) => (typeof entry === "string" ? { provider: entry, available: true } : { ...entry })) };
      }),
      listModes: vi.fn(async (provider: string) => {
        record.calls.push(`providers.listModes:${provider}`);
        return answerFor(providers.modes, provider, (modes) => ({ provider, modes, error: null }));
      }),
      listModels: vi.fn(async (provider: string) => {
        record.calls.push(`providers.listModels:${provider}`);
        return answerFor(providers.models, provider, (models) => ({ provider, models, error: null }));
      }),
      listFeatures: vi.fn(async (draft: { provider: string }) => {
        record.calls.push(`providers.listFeatures:${draft.provider}`);
        return answerFor(providers.features, draft.provider, (features) => ({ provider: draft.provider, features, error: null }));
      }),
      listUsage: vi.fn(async () => {
        record.calls.push("providers.listUsage");
        if (providers.usage instanceof Error) throw providers.usage;
        return providers.usage ?? { providers: [] };
      }),
    },
    config: {
      get: vi.fn(async () => {
        record.calls.push("config.get");
        if (options.config instanceof Error) throw options.config;
        return { requestId: requestId(), config: structuredClone(config) };
      }),
      patch: vi.fn(async (patch: Record<string, unknown>) => {
        record.calls.push("config.patch");
        if (options.patch instanceof Error) throw options.patch;
        record.patches.push(structuredClone(patch));
        if (options.patch !== "ignore") replaceConfig(applyConfigPatch(config, patch));
        return { requestId: requestId(), config: structuredClone(config) };
      }),
    },
  };

  for (const path of options.omit ?? []) omitPath(api as unknown as Record<string, unknown>, path);

  return {
    paseo: api as unknown as T,
    api,
    agents,
    byId,
    setAgents: (next) => void agents.splice(0, agents.length, ...next.map((agent) => ({ ...agent }) as FakeAgent)),
    setTimeline: (id, timeline) => void (timelines[id] = timeline),
    handle,
    config: <C,>() => config as C,
    setConfig: (next) => replaceConfig(structuredClone(next)),
    ...record,
  };
}
