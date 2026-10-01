import { resolve } from "node:path";
import type { PluginBeforeRequests, PluginServerContext } from "@getpaseo/plugin/server";
import { roleOfProvider } from "./agent-role";
import { TOOL_PROVIDERS, withAgentTools, type AgentToolsEndpoint } from "./agent-tools";
import { aliasBases } from "./alias-bases";
import { providerId } from "./provider-id";
import {
  LOOKUP_TIMEOUT_MS,
  ROLE_GETS_MODE,
  TIMED_OUT,
  boundaryPostureOf,
  capabilityOf,
  chooseModeId,
  creatorModeOffBoundary,
  featuresFor,
  modesFor,
  profileOf,
  runPostureOf,
  withTimeout,
  type BoundaryPosture,
  type ProviderCapability,
  type ProviderFeature,
  type ProviderMode,
  type RoleProfile,
} from "./role-mode";
import {
  BASE_INSTRUCTIONS,
  OWNER_PRECEDENTS_HEADING,
  RUNTIME_FACTS_HEADING,
  creationProjectOf,
  fullInstructions,
  runtimeFactsOf,
  type RuntimeFacts,
  type Role,
} from "./role-instructions";
import { listedWorkspaces, type DashboardPaseo } from "./paseo-directory";
import { rememberCreatedBoundary } from "./created-boundary";
import { applyRoleTitle } from "./role-title";

/**
 * Role instructions injected into every paseo-bm agent at creation (bm-hld).
 *
 * Paseo's `create_agent` tool has no system-prompt parameter, so a Worker the
 * Manager creates, or a Reviewer the Worker creates, would otherwise start
 * without its role contract. The daemon runs `before("agent.create")` hooks for
 * every agent creation, whoever asks for it, so the plugin sets the prompt
 * there, keyed by the provider id.
 *
 * The same hook sets the start mode of Workers and Reviewers (delta 20260917c
 * §4.6): what the role files used to teach in a paragraph each is one lookup
 * here, and it cannot be got wrong by an agent. The Orchestrator
 * gets its instructions, its profile and a mode under the Reviewer's
 * rule the same way, and no Paseo tools (orchestrator design §3.1). A new
 * Manager or Worker also gets the owner's precedents of its workspace, found
 * from its `cwd`, and the global ones (autonomy design §B.6).
 *
 * In a project whose action boundary the owner turned on (autonomy design
 * §D.2, change-010; off by default), a Worker or Reviewer on Claude or Codex
 * starts in the least permissive workable mode instead (`BOUNDARY_MODES`),
 * whatever mode its creator passed; only a mode hand-set on its profile wins.
 * Elsewhere today's rule applies, and a creator's boundary mode is moved back
 * to today's pick. Its Runtime facts say which, as `Action boundary: on` or
 * `off — <why>`.
 *
 * Provider ids map to roles through `roleOfProvider` (agent-role.ts), the
 * same rule every lookup uses to tell paseo-bm agents apart (delta 20260918g):
 * the three main aliases and the fallback aliases `bm-<role>-fallback-<n>`
 * (delta 20260921 §4.4.1). Lookups use the agent's real alias.
 *
 * The hook does NOT enforce the role pairing (only a Manager creates Workers,
 * only a Worker creates Reviewers; autonomy design §A.10): Paseo hands it
 * `{ config, env }` only, with no creator id, although a throw here would reach
 * the `create_agent` caller cleanly (both verified 2026-09-29, AGENTS.md). The
 * pairing is checked on `agent.created` instead (`role-pairing.ts`).
 */

export { chooseModeId, type ProviderMode } from "./role-mode";

/** Separates the role instructions from a system prompt that was already set. */
export const ROLE_PROMPT_SEPARATOR = "\n\n---\n\n";

/** The `agent.create` before-request the daemon hands to the hook. */
export type AgentCreateRequest = PluginBeforeRequests["agent.create"];

/**
 * Returns the request with the role instructions in `config.systemPrompt`, or
 * `undefined` when nothing changes (not a paseo-bm provider, or the prompt
 * already contains the instructions). Never throws.
 *
 * An existing, different system prompt is kept after the instructions,
 * separated by `ROLE_PROMPT_SEPARATOR`.
 */
export function applyRoleInstructions(request: AgentCreateRequest, facts: RuntimeFacts = {}): AgentCreateRequest | undefined {
  try {
    // Typed as required, but never trusted: a malformed request must not throw.
    const config = (request as Partial<AgentCreateRequest> | null | undefined)?.config;
    if (config === null || typeof config !== "object") return undefined;
    const role = roleOfProvider(config.provider);
    if (role === null) return undefined;
    const base = BASE_INSTRUCTIONS[role];
    // The base, then the Runtime facts and precedents: manager.ensure and this hook write the same text.
    const instructions = fullInstructions(role, facts);

    const existing = typeof config.systemPrompt === "string" ? config.systemPrompt : "";
    if (existing.includes(instructions)) return undefined;
    // Built by the plugin's own creator (`manager.ensure`) from the same parts,
    // read a moment earlier: keep it rather than add a second copy of them.
    const built = base.trimEnd();
    if ([RUNTIME_FACTS_HEADING, OWNER_PRECEDENTS_HEADING].some((next) => existing.includes(`${built}\n\n${next}`))) {
      return undefined;
    }
    let systemPrompt: string;
    if (existing.includes(base)) {
      // Set by an older call with the base only: upgrade it in place.
      systemPrompt = existing.replace(base, instructions);
    } else {
      systemPrompt = existing.trim() === "" ? instructions : `${instructions}${ROLE_PROMPT_SEPARATOR}${existing}`;
    }
    return { ...request, config: { ...config, systemPrompt } };
  } catch {
    return undefined;
  }
}

/**
 * Returns the request with `config.modeId` set by `chooseModeId`, or
 * `undefined` when nothing changes. `modes` is `null` when the provider's list
 * could not be read. Never throws.
 */
export function applyRoleMode(
  request: AgentCreateRequest,
  modes: readonly ProviderMode[] | null,
  profileModeId: string | null = null,
): AgentCreateRequest | undefined {
  try {
    if (modes === null) return undefined;
    const config = (request as Partial<AgentCreateRequest> | null | undefined)?.config;
    if (config === null || typeof config !== "object") return undefined;
    const id = providerId(config.provider);
    const role = roleOfProvider(id);
    if (id === null || role === null) return undefined;
    const current = typeof config.modeId === "string" && config.modeId.trim() !== "" ? config.modeId : undefined;
    const modeId = chooseModeId(role, modes, current, profileModeId);
    if (modeId === undefined || modeId === current) return undefined;
    if (current !== undefined) {
      console.warn(`[paseo-bm] ${id} was created in mode "${current}", which that role must not use; starting it in "${modeId}" instead.`);
    }
    return { ...request, config: { ...config, modeId } };
  } catch {
    return undefined;
  }
}

/**
 * The model a creation request names, or `null`: the daemon's resolved
 * `config.model` when set, else everything after the FIRST `/` of
 * `config.provider` (OpenCode model ids contain `/` themselves, so
 * `bm-worker/anthropic/claude-sonnet-4-6` names `anthropic/claude-sonnet-4-6`).
 */
function requestModelOf(config: { provider?: unknown; model?: unknown }): string | null {
  if (typeof config.model === "string" && config.model.trim() !== "") return config.model;
  if (typeof config.provider !== "string") return null;
  const slash = config.provider.indexOf("/");
  return slash === -1 || slash === config.provider.length - 1 ? null : config.provider.slice(slash + 1);
}

/**
 * The roles whose own profile the hook applies: the model, the thinking level
 * and the features. The Manager is left alone: `manager.ensure` already passes
 * its profile. The Orchestrator is created by the plugin
 * with its profile's model, but the user may have changed the profile since
 * (orchestrator design §3.1).
 */
const PROFILE_ROLES: ReadonlySet<Role | null> = new Set<Role>(["worker", "reviewer", "orchestrator"]);

/**
 * Returns the request with the model of a Worker's, Reviewer's or
 * Orchestrator's own profile when the creator named another one, or `undefined` when nothing changes.
 * Never throws. The correction is one `[paseo-bm]` log line and nothing else:
 * its log file (`model-corrections.json`) went with its only reader, the
 * `agent.model-corrected` rule (autonomy design §B.9).
 *
 * The role files tell the creator to pass `bm-<role>/<model of the profile>`,
 * but a Manager reads the profile once and keeps it: after the user moved the
 * Worker from Claude to Codex in Settings, a Manager created earlier still asked
 * for `bm-worker/claude-opus-5-5`, and Codex refused the model at the Worker's
 * first turn (clean-install run 2026-09-26). The profile is what the user set,
 * so it wins, the way `applyRoleMode` makes the role's mode win. Only the main
 * aliases have a profile; a fallback alias keeps the model it was given.
 */
export function applyRoleModel(request: AgentCreateRequest, profile: RoleProfile | null): AgentCreateRequest | undefined {
  try {
    if (profile === null || profile.model === null) return undefined;
    const config = (request as Partial<AgentCreateRequest> | null | undefined)?.config;
    if (config === null || typeof config !== "object") return undefined;
    const id = providerId(config.provider);
    const role = roleOfProvider(id);
    if (id === null || !PROFILE_ROLES.has(role)) return undefined;
    const requested = requestModelOf(config);
    if (requested === null || requested === profile.model) return undefined;
    const next: Record<string, unknown> = { ...config };
    if (typeof config.provider === "string" && config.provider.includes("/")) next.provider = `${id}/${profile.model}`;
    if (typeof config.model === "string" && config.model.trim() !== "") next.model = profile.model;
    // A thinking level belongs to the model it was chosen for and may not exist
    // on the profile's; `applyRoleProfile` then sets the profile's own, if any.
    delete next.thinkingOptionId;
    console.warn(`[paseo-bm] ${id} was asked for model "${requested}", but its profile names "${profile.model}"; starting it on "${profile.model}".`);
    return { ...request, config: next as unknown as AgentCreateRequest["config"] };
  } catch {
    return undefined;
  }
}

/**
 * Returns the request with the thinking level and feature values of the
 * Worker's, Reviewer's or Orchestrator's own profile (delta 20260921 §4.1.1,
 * REQ-062 a; orchestrator design §3.1), or
 * `undefined` when nothing changes. Never throws.
 *
 * - `thinkingOptionId`: the profile's, only when the creator passed none and
 *   the request's model is the profile's model (or names no model): a
 *   thinking level belongs to a model and may not exist on another one.
 * - `featureValues`: the profile's, merged under the creator's, whose keys win.
 *
 * The Manager is left alone: `manager.ensure` already passes its profile.
 */
export function applyRoleProfile(request: AgentCreateRequest, profile: RoleProfile | null): AgentCreateRequest | undefined {
  try {
    if (profile === null) return undefined;
    const config = (request as Partial<AgentCreateRequest> | null | undefined)?.config;
    if (config === null || typeof config !== "object") return undefined;
    const role = roleOfProvider(config.provider);
    if (role === null || !PROFILE_ROLES.has(role)) return undefined;

    const next: Record<string, unknown> = { ...config };
    let changed = false;
    const current = typeof config.thinkingOptionId === "string" && config.thinkingOptionId.trim() !== "";
    const model = requestModelOf(config);
    if (!current && profile.thinkingOptionId !== null && (model === null || model === profile.model)) {
      next.thinkingOptionId = profile.thinkingOptionId;
      changed = true;
    }
    if (profile.featureValues !== null) {
      const own = config.featureValues;
      const creator = own !== null && typeof own === "object" && !Array.isArray(own) ? own : {};
      const merged = { ...profile.featureValues, ...creator };
      if (JSON.stringify(merged) !== JSON.stringify(own ?? null)) {
        next.featureValues = merged;
        changed = true;
      }
    }
    return changed ? { ...request, config: next as unknown as AgentCreateRequest["config"] } : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Returns the request with the start mode and auto-approve of a Worker,
 * Reviewer or Orchestrator on an `untiered` or `none` provider (delta 20260921 §4.2.2), or
 * `undefined` when nothing changes. `tiered` and `unknown` providers keep
 * `applyRoleMode`. Never throws.
 */
export function applyRunPosture(
  request: AgentCreateRequest,
  capability: ProviderCapability,
  modes: readonly ProviderMode[] | null,
  features: readonly ProviderFeature[] | null,
  profileModeId: string | null = null,
): AgentCreateRequest | undefined {
  try {
    const config = (request as Partial<AgentCreateRequest> | null | undefined)?.config;
    if (config === null || typeof config !== "object") return undefined;
    const role = roleOfProvider(config.provider);
    if (role === null) return undefined;
    if (!ROLE_GETS_MODE[role]) return undefined;
    const own = config.featureValues;
    const current = {
      ...(typeof config.modeId === "string" && config.modeId.trim() !== "" ? { modeId: config.modeId } : {}),
      ...(own !== null && typeof own === "object" && !Array.isArray(own) ? { featureValues: own } : {}),
    };
    const posture = runPostureOf(role, capability, modes ?? [], features, profileModeId, current);
    if (posture === undefined || (posture.modeId === undefined && posture.featureValues === undefined)) return undefined;
    const next: Record<string, unknown> = { ...config };
    // `null` removes the key: a provider without modes gets neither (review b4).
    if (posture.modeId === null) delete next.modeId;
    else if (posture.modeId !== undefined) next.modeId = posture.modeId;
    if (posture.featureValues === null) delete next.featureValues;
    else if (posture.featureValues !== undefined) next.featureValues = posture.featureValues;
    return { ...request, config: next as unknown as AgentCreateRequest["config"] };
  } catch {
    return undefined;
  }
}

/**
 * Returns the request in its boundary mode (autonomy design §D.2): the
 * posture's `modeId`, and its provider options over the creator's. Any other
 * mode the creator passed is moved; `undefined` when nothing changes. Never throws.
 */
export function applyBoundaryMode(request: AgentCreateRequest, posture: BoundaryPosture): AgentCreateRequest | undefined {
  try {
    if (!posture.on) return undefined;
    const config = (request as Partial<AgentCreateRequest> | null | undefined)?.config;
    if (config === null || typeof config !== "object") return undefined;
    const next: Record<string, unknown> = { ...config };
    let changed = false;
    const current = typeof config.modeId === "string" && config.modeId.trim() !== "" ? config.modeId : undefined;
    if (current !== posture.modeId) {
      if (current !== undefined) {
        console.warn(`[paseo-bm] ${providerId(config.provider)} was created in mode "${current}"; the action boundary starts it in "${posture.modeId}".`);
      }
      next.modeId = posture.modeId;
      changed = true;
    }
    if (posture.providerOptions !== undefined) {
      const own = (config as { providerOptions?: unknown }).providerOptions;
      const creator = own !== null && typeof own === "object" && !Array.isArray(own) ? (own as Record<string, unknown>) : {};
      const merged = { ...creator, ...posture.providerOptions };
      if (JSON.stringify(merged) !== JSON.stringify(own ?? null)) {
        next.providerOptions = merged;
        changed = true;
      }
    }
    return changed ? { ...request, config: next as unknown as AgentCreateRequest["config"] } : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The request without its creator's mode when that is the role's boundary
 * mode and the boundary is not applied (change-010 C5), so today's rule picks
 * again; `undefined` otherwise. Only on a provider whose tiered list was read,
 * where today's rule always picks a mode. Never throws.
 */
function withoutCreatorBoundaryMode(request: AgentCreateRequest, base: string | null, modes: readonly ProviderMode[] | null): AgentCreateRequest | undefined {
  try {
    if (modes === null || capabilityOf(modes) !== "tiered") return undefined;
    const config = request.config;
    const current = typeof config.modeId === "string" && config.modeId.trim() !== "" ? config.modeId : undefined;
    if (current === undefined || creatorModeOffBoundary(roleOfProvider(config.provider), base, current) !== undefined) return undefined;
    const next: Record<string, unknown> = { ...config };
    delete next.modeId;
    return { ...request, config: next as unknown as AgentCreateRequest["config"] };
  } catch {
    return undefined;
  }
}

/** The action boundary as the hook read it for this creation (§D.2): what it applies, and the alias's base provider. */
export interface BoundaryInput {
  posture: BoundaryPosture | null;
  base: string | null;
}

/** Instructions, profile settings and start posture together; `undefined` when none changes. */
export function applyRoleConfig(
  request: AgentCreateRequest,
  modes: readonly ProviderMode[] | null = null,
  facts: RuntimeFacts = {},
  profileModeId: string | null = null,
  profile: RoleProfile | null = null,
  features: readonly ProviderFeature[] | null = null,
  boundary: BoundaryInput | null = null,
): AgentCreateRequest | undefined {
  const withInstructions = applyRoleInstructions(request, facts);
  // The model first: the profile's thinking level only applies on the profile's model.
  const withModel = applyRoleModel(withInstructions ?? request, profile) ?? withInstructions;
  const withProfile = applyRoleProfile(withModel ?? request, profile) ?? withModel;
  // Under the boundary (§D.2): its mode, whatever the creator passed.
  if (boundary?.posture?.on === true) return applyBoundaryMode(withProfile ?? request, boundary.posture) ?? withProfile;
  // Otherwise today's rule; a creator's boundary mode counts as no mode, so today's pick replaces it.
  const start = (boundary === null ? undefined : withoutCreatorBoundaryMode(withProfile ?? request, boundary.base, modes)) ?? withProfile ?? request;
  const capability = capabilityOf(modes);
  const posture =
    capability === "untiered" || capability === "none"
      ? applyRunPosture(start, capability, modes, features, profileModeId)
      : applyRoleMode(start, modes, profileModeId);
  return posture ?? withProfile;
}

/**
 * The provider id whose modes are worth a lookup, or `null`. A Reviewer needs
 * the list to recognise a mode it must not run in; a Worker needs it even
 * when its creator already chose a mode, because the capability class decides
 * its auto-approve (delta 20260921 §4.2.1: on OpenCode the Worker's chosen
 * mode is kept but `auto_accept` must still be turned on).
 */
function modeLookupFor(request: AgentCreateRequest): string | null {
  try {
    const config = (request as Partial<AgentCreateRequest> | null | undefined)?.config;
    const id = providerId(config?.provider);
    const role = roleOfProvider(id);
    if (id === null || role === null) return null;
    return ROLE_GETS_MODE[role] ? id : null;
  } catch {
    return null;
  }
}

/**
 * The workspace whose folder is `folder` — the reverse of the Dashboard's
 * `workspaceDirectory`, over the same `workspaces.list` — or `null` when
 * Paseo lists none, more than one, or cannot be read: the hook's request
 * carries the agent's `cwd`, not its workspace (design §B.9). An archived
 * workspace does not count. Never throws.
 */
export async function workspaceOfFolder(paseo: unknown, folder: string): Promise<string | null> {
  try {
    const listed = await listedWorkspaces(paseo as DashboardPaseo);
    if (listed === null) return null;
    const wanted = resolve(folder);
    const matches = listed.filter((entry) => !entry.archived && entry.id !== "" && entry.directory !== null && resolve(entry.directory) === wanted);
    return matches.length === 1 ? matches[0]!.id : null;
  } catch {
    return null;
  }
}

/** Everything the hook needs from the daemon, gathered under one time budget. */
async function prepare(
  request: AgentCreateRequest,
  paseo: unknown,
): Promise<{
  modes: ProviderMode[] | null;
  facts: RuntimeFacts;
  profileModeId: string | null;
  profile: RoleProfile | null;
  features: ProviderFeature[] | null;
  /** The provider the alias extends (`claude`, `codex`, …), or null when unreadable. */
  base: string | null;
  /** The action boundary for a Worker or Reviewer (§D.2); null for another role. */
  boundary: BoundaryPosture | null;
}> {
  const cwd = typeof request?.config?.cwd === "string" ? request.config.cwd : undefined;
  const id = providerId(request?.config?.provider);
  const role = roleOfProvider(id) ?? undefined;
  // The project of `cwd` and its action boundary switch (§D.2, change-010 C5), read beside the other lookups.
  const projectLookup =
    role === "manager" || role === "worker" || role === "reviewer"
      ? creationProjectOf(cwd, { workspaceOf: (folder) => workspaceOfFolder(paseo, folder) })
      : Promise.resolve({ workspaceId: null, boundary: "unknown" as const });
  // The Worker's, Reviewer's or Orchestrator's own profile: its mode (bm-msy), and its
  // thinking and features (delta 20260921 §4.1.1). One read, whether or not
  // the mode needs a lookup: a Worker created WITH a mode still gets the
  // thinking set on its profile.
  const profile = role !== undefined && PROFILE_ROLES.has(role) ? await profileOf(paseo, id!) : null;
  const lookup = modeLookupFor(request);
  const profileModeId = lookup === null ? null : (profile?.modeId ?? null);
  const modes = lookup === null ? null : await modesFor(paseo, lookup, undefined, cwd);
  // Only an untiered provider (OpenCode) costs the features round trip: its
  // auto-approve toggle is the one feature the posture rule sets (§4.2.2).
  // The model the agent will run on: the profile's when `applyRoleModel` will
  // switch to it, so the features are those of that model.
  const requested = typeof request?.config?.provider === "string" ? request.config.provider : (id ?? "");
  const wanted = profile?.model ?? null;
  const asked = request?.config ? requestModelOf(request.config) : null;
  const selection = id !== null && wanted !== null && asked !== null && asked !== wanted ? `${id}/${wanted}` : requested;
  const features = capabilityOf(modes) === "untiered" ? await featuresFor(paseo, selection, cwd) : null;
  // Read once for the facts and the mode.
  const project = await projectLookup;
  // The owner's precedents go to a new Manager or Worker: of the workspace whose folder is `cwd`, and the global ones (design §B.6).
  const facts =
    role === undefined
      ? {}
      : await runtimeFactsOf(role, paseo, cwd, undefined, undefined, {
          ...(project.workspaceId === null ? {} : { workspaceId: project.workspaceId }),
          boundary: project.boundary,
        });
  const base = id === null ? null : ((await aliasBases(paseo))[id] ?? null);
  const boundary = boundaryPostureOf({ role, base, project: project.boundary, modes, profileModeId });
  return { modes, facts: boundary === null ? facts : { ...facts, actionBoundary: boundary }, profileModeId, profile, features, base, boundary };
}

/**
 * Keeps the boundary this hook applies to a Worker or Reviewer for its
 * `agent.created`, whose snapshot has no prompt to read yet (`created-boundary.ts`,
 * live check 2026-10-01 F1). No posture — the lookups timed out — is off: the
 * agent starts without the facts line and outside the boundary. Never throws.
 */
function rememberBoundaryOf(request: AgentCreateRequest, posture: BoundaryPosture | null): void {
  try {
    const role = roleOfProvider(request.config.provider);
    if (role !== "worker" && role !== "reviewer") return;
    rememberCreatedBoundary(request.config.provider, request.config.cwd, posture?.on === true ? "on" : "off");
  } catch {
    // The label is best effort; the permission handler still reads the prompt.
  }
}

/** The request with its role marker in the title (`role-title.ts`), or `undefined` when nothing changed at all. */
function marked(changed: AgentCreateRequest | undefined, request: AgentCreateRequest): AgentCreateRequest | undefined {
  return applyRoleTitle(changed ?? request) ?? changed;
}

function isBmRequest(request: AgentCreateRequest): boolean {
  try {
    return roleOfProvider((request as Partial<AgentCreateRequest> | null | undefined)?.config?.provider) !== null;
  } catch {
    return false;
  }
}

/** The part of the server context this hook needs; `before` is absent on older hosts. */
export type RoleHookHost = Partial<Pick<PluginServerContext, "before">>;

/**
 * The request with the role's tool server added (design delta
 * 20260924b-agent-tools, ADR-010), or `undefined` when there is nothing to
 * add: not a paseo-bm agent, no endpoint listening, or a base provider that
 * is unknown or cannot take pre-approved tools (`TOOL_PROVIDERS`) — Paseo
 * would refuse to create that agent at all. Never throws.
 */
export function applyAgentTools(
  request: AgentCreateRequest,
  tools: Pick<AgentToolsEndpoint, "urlFor"> | null,
  base: string | null,
): AgentCreateRequest | undefined {
  try {
    if (tools === null || base === null || !TOOL_PROVIDERS.includes(base)) return undefined;
    const role = roleOfProvider(request.config.provider);
    // Every role has its own path. The Orchestrator's carries the endpoint's secret and serves its
    // read tools and its decision and command tools — and it never gets Paseo's tools (orchestrator design §3.1, §5.1).
    const config = role === null ? undefined : withAgentTools(request.config, role, tools.urlFor(role));
    return config === undefined ? undefined : { ...request, config };
  } catch {
    return undefined;
  }
}

/** The part of the endpoint the hook uses; `usePaseo` hands the Orchestrator's tools the hook's Paseo handle. */
export type RoleHookTools = Pick<AgentToolsEndpoint, "urlFor"> & Partial<Pick<AgentToolsEndpoint, "usePaseo">>;

/**
 * Registers the `before("agent.create")` hook and returns its remover. On a
 * host without `before` it logs one line and returns a no-op.
 *
 * Each paseo-bm creation also hands the endpoint the context's Paseo handle:
 * the Orchestrator's tools have no context of their own, and an Orchestrator
 * only gets their URL from this hook (orchestrator design §5.1).
 */
export function registerRoleHook(host: RoleHookHost, tools: RoleHookTools | null = null): () => void {
  if (typeof host.before !== "function") {
    console.warn(
      "[paseo-bm] this Paseo host has no before(\"agent.create\") hook; Worker and Reviewer agents will start without role instructions.",
    );
    return () => {};
  }
  const remove = host.before("agent.create", (input, context) => {
    const request = (input as { request?: AgentCreateRequest } | undefined)?.request as AgentCreateRequest;
    // Every agent creation passes here: only paseo-bm's own pay for a lookup.
    if (!isBmRequest(request)) return undefined;
    const paseo = (context as { paseo?: unknown } | undefined)?.paseo;
    try {
      tools?.usePaseo?.(paseo);
    } catch {
      // The tools' handle never costs an agent its creation.
    }
    return (async () => {
      // The host fails the whole creation if this hook takes longer than 30 s,
      // so everything it looks up is raced as ONE budget: a slow daemon costs
      // the mode and the facts, never the agent.
      const prepared = await withTimeout(prepare(request, paseo), LOOKUP_TIMEOUT_MS);
      if (prepared === TIMED_OUT) {
        console.warn(
          `[paseo-bm] preparing the role config took longer than ${LOOKUP_TIMEOUT_MS} ms; the agent starts with its role instructions only.`,
        );
        // The base provider is unknown here, so no tools: an agent Paseo refuses would cost more than a hand-written block.
        rememberBoundaryOf(request, null);
        return marked(applyRoleInstructions(request), request);
      }
      const configured = applyRoleConfig(
        request,
        prepared.modes,
        prepared.facts,
        prepared.profileModeId,
        prepared.profile,
        prepared.features,
        { posture: prepared.boundary, base: prepared.base },
      );
      rememberBoundaryOf(request, prepared.boundary);
      return marked(applyAgentTools(configured ?? request, tools, prepared.base) ?? configured, request);
    })();
  });
  return typeof remove === "function" ? remove : () => {};
}
