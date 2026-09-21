/**
 * Which start mode each paseo-bm role gets, and how it is chosen.
 *
 * Shared by the `agent.create` hook (which sets `config.modeId`) and by the
 * role instructions (which tell the Manager the Worker mode to pass), so both
 * name the same value. Kept apart from both so neither has to import the other.
 *
 * The rule is owner decision bm-msy (2026-09-15), which the role files used to
 * teach in prose. Paseo resolves a new agent's mode BEFORE the hook runs and
 * refuses a cross-provider child whose creator is not unattended and passes no
 * mode (delta 20260917c K10), so the hook can correct a mode but cannot rescue
 * a creation the daemon already refused: that is why the Manager still passes
 * one, taken from its Runtime facts.
 *
 * Every lookup here is on the path of a real agent creation, and the plugin
 * host rejects a `before` hook after 30 s and then FAILS the creation (read in
 * the installed Paseo.app bundle), while the SDK's own `listModes` timeout is
 * 90 s and the daemon waits for provider warm-up. So each lookup is raced
 * against `LOOKUP_TIMEOUT_MS` and a slow answer costs the mode, never the
 * agent.
 */
import type { Role } from "./role-extras";

/** A mode as `providers.listModes` returns it (`AgentMode` in @getpaseo/protocol). */
export type ProviderMode = { id: string; label?: string; description?: string; colorTier?: string };

/**
 * Roles whose start mode the hook chooses (delta 20260917c §4.6). The Manager
 * is left out on purpose: `manager.ensure` already sets its mode, and two
 * places deciding one value is worse than one.
 */
export const ROLE_GETS_MODE: Readonly<Record<Role, boolean>> = { manager: false, worker: true, reviewer: true };

/**
 * How long the hook waits for one lookup. Well under the host's 30 s hook
 * budget, and generous for a local daemon RPC.
 */
export const LOOKUP_TIMEOUT_MS = 5000;

/** Returned instead of the work's value when it took longer than `ms`. A
 * sentinel, not `null`: a lookup may legitimately answer `null`. */
export const TIMED_OUT = Symbol("paseo-bm lookup timed out");

/** The work's result, or `TIMED_OUT`. */
export async function withTimeout<T>(work: Promise<T>, ms: number = LOOKUP_TIMEOUT_MS): Promise<T | typeof TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<typeof TIMED_OUT>((resolve) => {
        timer = setTimeout(() => resolve(TIMED_OUT), ms);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

const tierOf = (mode: ProviderMode): string => (typeof mode.colorTier === "string" ? mode.colorTier.toLowerCase() : "");
const firstWithTier = (modes: readonly ProviderMode[], tier: string): string | undefined =>
  modes.find((mode) => tierOf(mode) === tier)?.id;

/**
 * The mode a paseo-bm role should start in, or `undefined` to leave the request
 * alone.
 *
 * - Worker: the first `dangerous` mode, i.e. the one that runs without approval
 *   prompts (`bypassPermissions` on Claude, `full-access` on Codex); else the
 *   first `moderate`; else the first `safe`. Never `planning`. A mode the caller
 *   (or the profile) already chose is kept.
 * Before either chain: a `modeId` set by hand on the role's own profile wins
 * (bm-msy, "the profile's mode if it has one"), except that a dangerous or
 * planning profile mode is not used for the Reviewer.
 *
 * - Reviewer: `auto` when present; else the first `moderate` whose id, label and
 *   description mention neither "full" nor "network"; else the first `safe`. Never
 *   `dangerous` or `planning`: a caller-chosen mode of either tier is
 *   downgraded, any other caller choice is kept, and a mode id the provider does
 *   not list is kept rather than guessed about.
 */
export function chooseModeId(
  role: Role,
  modes: readonly ProviderMode[],
  current: string | undefined,
  profileModeId?: string | null,
): string | undefined {
  if (!ROLE_GETS_MODE[role]) return undefined;
  const usable = modes.filter((mode) => typeof mode?.id === "string" && mode.id !== "");
  if (usable.length === 0) return undefined;
  // "The profile's mode if it has one" is part of the bm-msy rule: a mode the
  // owner set on the bm-worker / bm-reviewer profile by hand wins over the
  // plugin's own pick. For the Reviewer it still may not be dangerous.
  const fromProfile = usable.find((mode) => mode.id === profileModeId);
  const profileSafe = fromProfile !== undefined && tierOf(fromProfile) !== "dangerous" && tierOf(fromProfile) !== "planning";

  if (role === "worker") {
    if (current !== undefined) return undefined;
    if (fromProfile !== undefined) return fromProfile.id;
    return firstWithTier(usable, "dangerous") ?? firstWithTier(usable, "moderate") ?? firstWithTier(usable, "safe");
  }

  const reviewerMode = profileSafe
    ? fromProfile!.id
    : usable.find((mode) => mode.id === "auto")?.id ??
      usable.find((mode) => tierOf(mode) === "moderate" && !/full|network/i.test(`${mode.id} ${mode.label ?? ""} ${mode.description ?? ""}`))?.id ??
      firstWithTier(usable, "safe");
  if (current === undefined) return reviewerMode;
  const chosen = usable.find((mode) => mode.id === current);
  if (chosen === undefined) return undefined;
  return tierOf(chosen) === "dangerous" || tierOf(chosen) === "planning" ? reviewerMode : undefined;
}

/**
 * The mode `manager.ensure` gives a Manager, or `undefined` to leave the
 * provider's default (delta 20260918 §4.1, owner decisions Q31 and Q36).
 *
 * 1. A mode set by hand on the `bm-manager` profile, when the provider lists
 *    it, always wins — even a `planning` one: the owner's rule is that the
 *    profile's own mode still wins.
 * 2. Otherwise the first `dangerous` mode, the one that runs without permission
 *    prompts (`bypassPermissions` on Claude, `full-access` on Codex).
 * 3. Otherwise nothing. There is deliberately no fallback to `moderate`: the
 *    request is "no prompts", and a provider's automatic mode is not that.
 */
export function managerModeFor(modes: readonly ProviderMode[], profileModeId: string | null): string | undefined {
  const usable = modes.filter((mode) => typeof mode?.id === "string" && mode.id !== "");
  const fromProfile = usable.find((mode) => mode.id === profileModeId);
  if (fromProfile !== undefined) return fromProfile.id;
  return firstWithTier(usable, "dangerous");
}

/**
 * What a paseo-bm profile sets by hand (delta 20260921 §4.1.1). `null` fields
 * are fields the profile does not set; `featureValues` is `null` when the
 * profile sets no feature.
 */
export interface RoleProfile {
  model: string | null;
  modeId: string | null;
  thinkingOptionId: string | null;
  featureValues: Record<string, unknown> | null;
}

const nonEmpty = (value: unknown): string | null => (typeof value === "string" && value.trim() !== "" ? value : null);

/**
 * The settings of one paseo-bm profile, from ONE `config.get()` under the
 * lookup budget, or `null` when it cannot be read or does not exist. The
 * plugin SDK's view is flat: `config.agentProfiles` is `daemon.agentProfiles`.
 * Never throws.
 */
export async function profileOf(
  paseo: unknown,
  profileId: string,
  log: (message: string) => void = (message) => console.warn(message),
): Promise<RoleProfile | null> {
  const get = (paseo as { config?: { get?: unknown } } | null | undefined)?.config?.get;
  if (typeof get !== "function") return null;
  try {
    const result = await withTimeout(
      (get.call((paseo as { config: unknown }).config) as Promise<{
        config?: { agentProfiles?: Array<Record<string, unknown> | null | undefined> };
      }>),
    );
    if (result === TIMED_OUT) {
      log(`[paseo-bm] reading the ${profileId} profile took longer than ${LOOKUP_TIMEOUT_MS} ms; its own settings are ignored.`);
      return null;
    }
    const profile = result?.config?.agentProfiles?.find((entry) => entry?.id === profileId);
    if (profile === null || profile === undefined || typeof profile !== "object") return null;
    const features = profile.featureValues;
    return {
      model: nonEmpty(profile.model),
      modeId: nonEmpty(profile.modeId),
      thinkingOptionId: nonEmpty(profile.thinkingOptionId),
      featureValues:
        features !== null && typeof features === "object" && !Array.isArray(features) && Object.keys(features).length > 0
          ? { ...(features as Record<string, unknown>) }
          : null,
    };
  } catch {
    return null;
  }
}

/**
 * The `modeId` set by hand on a paseo-bm profile, or `null`. Read the same way
 * `manager.ensure` reads the Manager's profile. Never throws.
 */
export async function profileModeOf(
  paseo: unknown,
  profileId: string,
  log: (message: string) => void = (message) => console.warn(message),
): Promise<string | null> {
  return (await profileOf(paseo, profileId, log))?.modeId ?? null;
}

/**
 * The last mode list read successfully per provider in this plugin run, and
 * when (delta 20260918g §4.9): the Worker's Runtime facts fall back on it when
 * a lookup fails.
 */
const lastModes = new Map<string, { modes: ProviderMode[]; at: string }>();

/** The last list `modesFor` read for `provider` in this run, or null. */
export function lastModesOf(provider: string): { modes: ProviderMode[]; at: string } | null {
  return lastModes.get(provider) ?? null;
}

/** Forgets every remembered list; for tests. */
export function forgetModes(): void {
  lastModes.clear();
}

/**
 * The provider's modes, or `null` when they cannot be read. Every `null` is
 * logged: a silent miss would leave a Reviewer in the full-access mode it
 * inherits from a no-prompt Worker, or a Manager without the Worker mode it
 * must pass. A list that was read is remembered (`lastModesOf`).
 */
export async function modesFor(
  paseo: unknown,
  provider: string,
  log: (message: string) => void = (message) => console.warn(message),
  cwd?: string,
): Promise<ProviderMode[] | null> {
  const providers = (paseo as { providers?: { listModes?: unknown } } | null | undefined)?.providers;
  const listModes = providers?.listModes;
  if (typeof listModes !== "function") {
    log(`[paseo-bm] this Paseo host cannot list provider modes; the mode of ${provider} is left to its creator.`);
    return null;
  }
  try {
    // `cwd` lets the daemon answer from the snapshot it already warmed for this
    // directory instead of waiting for a cold provider discovery.
    const call = cwd === undefined ? listModes.call(providers, provider) : listModes.call(providers, provider, { cwd });
    const result = await withTimeout(call as Promise<{ modes?: unknown; error?: unknown } | null | undefined>);
    if (result === TIMED_OUT) {
      log(`[paseo-bm] reading the modes of ${provider} took longer than ${LOOKUP_TIMEOUT_MS} ms; its mode is left to its creator.`);
      return null;
    }
    const modes = Array.isArray(result?.modes) ? (result.modes as ProviderMode[]) : [];
    const failure = typeof result?.error === "string" && result.error !== "" ? result.error : null;
    if (failure !== null || !Array.isArray(result?.modes)) {
      log(`[paseo-bm] could not read the modes of ${provider} (${failure ?? "no modes listed"}); its mode is left to its creator.`);
      return null;
    }
    // An empty list WITHOUT an error is an answer, not a failure: the provider
    // has no modes at all (Pi, delta 20260921 §4.2.1 / F3). Nothing to log,
    // and nothing worth remembering for the Runtime-facts fallback.
    if (modes.length === 0) return [];
    lastModes.set(provider, { modes, at: new Date().toISOString() });
    return modes;
  } catch (error) {
    log(`[paseo-bm] could not read the modes of ${provider} (${error instanceof Error ? error.message : String(error)}); its mode is left to its creator.`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Run posture by provider capability (delta 20260921 §4.2.1–§4.2.2, REQ-063).
// ---------------------------------------------------------------------------

/**
 * How a provider lets paseo-bm choose a role's start mode:
 * - `tiered`: its modes carry a `colorTier` (Claude, Codex) — the bm-msy rules apply;
 * - `untiered`: modes without any `colorTier` (OpenCode's modes are the user's
 *   own OpenCode agents) — a listed mode is always passed, plus auto-approve;
 * - `none`: an empty list without an error (Pi) — no mode is ever passed;
 * - `unknown`: the list could not be read — today's behaviour, unchanged.
 */
export type ProviderCapability = "tiered" | "untiered" | "none" | "unknown";

/** The capability class of a provider from what `modesFor` returned. */
export function capabilityOf(modes: readonly ProviderMode[] | null): ProviderCapability {
  if (modes === null) return "unknown";
  const usable = modes.filter((mode) => typeof mode?.id === "string" && mode.id !== "");
  if (usable.length === 0) return "none";
  return usable.some((mode) => tierOf(mode) !== "") ? "tiered" : "untiered";
}

/** The toggle that auto-approves a provider's tool-permission prompts (OpenCode, design F1). */
export const AUTO_APPROVE_FEATURE = "auto_accept";

/** A feature as `providers.listFeatures` returns it (toggle or select). */
export type ProviderFeature = { type?: string; id?: string; value?: unknown };

/**
 * The features a provider offers for a draft config, or `null` when they
 * cannot be read. `provider` is the selection the agent is created with
 * (`bm-worker` or `bm-worker/<model>`); `cwd` is required by the daemon.
 * Raced against the lookup budget; every `null` is logged. Never throws.
 */
export async function featuresFor(
  paseo: unknown,
  provider: string,
  cwd: string | undefined,
  log: (message: string) => void = (message) => console.warn(message),
): Promise<ProviderFeature[] | null> {
  const providers = (paseo as { providers?: { listFeatures?: unknown } } | null | undefined)?.providers;
  const listFeatures = providers?.listFeatures;
  if (typeof listFeatures !== "function" || cwd === undefined) {
    log(`[paseo-bm] cannot read the features of ${provider}; its auto-approve is left as it is.`);
    return null;
  }
  try {
    const result = await withTimeout(
      listFeatures.call(providers, { provider, cwd }) as Promise<{ features?: unknown; error?: unknown } | null | undefined>,
    );
    if (result === TIMED_OUT) {
      log(`[paseo-bm] reading the features of ${provider} took longer than ${LOOKUP_TIMEOUT_MS} ms; its auto-approve is left as it is.`);
      return null;
    }
    if (typeof result?.error === "string" && result.error !== "") {
      log(`[paseo-bm] could not read the features of ${provider} (${result.error}); its auto-approve is left as it is.`);
      return null;
    }
    return Array.isArray(result?.features) ? (result.features as ProviderFeature[]) : [];
  } catch (error) {
    log(`[paseo-bm] could not read the features of ${provider} (${error instanceof Error ? error.message : String(error)}); its auto-approve is left as it is.`);
    return null;
  }
}

/** True when the provider offers the auto-approve toggle. */
export function offersAutoApprove(features: readonly ProviderFeature[] | null): boolean {
  return Array.isArray(features) && features.some((feature) => feature?.type === "toggle" && feature.id === AUTO_APPROVE_FEATURE);
}

/**
 * What `runPostureOf` asks to change: a start mode and/or the complete feature
 * values. `null` means REMOVE the key (a provider without modes gets neither).
 */
export interface RunPosture {
  modeId?: string | null;
  featureValues?: Record<string, unknown> | null;
}

/**
 * The start mode and auto-approve a role should get on a provider of this
 * capability (delta 20260921 §4.2.2), or `undefined` for `tiered` and
 * `unknown`, whose rules stay where they were (`chooseModeId` in the hook,
 * `managerModeFor` in `manager.ensure`). `current` is what the request already
 * carries: the creator's mode and the feature values merged so far (the
 * profile's under the creator's).
 *
 * - `untiered`: a listed mode is always passed — the creator's, else the
 *   profile's, else the FIRST listed one: the daemon refuses a cross-provider
 *   child without a mode (design F11). The Manager and the Worker get
 *   `auto_accept: true` when the provider offers it and nobody set it; the
 *   Reviewer ALWAYS gets `auto_accept: false`, over the profile and over a
 *   value the daemon may have set by itself (owner decision Q7 a).
 * - `none`: no mode and no feature (Pi has neither; its lack of a permission
 *   layer was accepted by the owner, Q7 a): both are REMOVED from the request,
 *   whether the creator or the profile set them (review b4).
 * The Reviewer's `auto_accept: false` is written even when the features could
 * not be read or do not list the toggle, so no provider default can turn
 * auto-approve on for it (review b4).
 */
export function runPostureOf(
  role: Role,
  capability: ProviderCapability,
  modes: readonly ProviderMode[],
  features: readonly ProviderFeature[] | null,
  profileModeId: string | null,
  current: { modeId?: string; featureValues?: Record<string, unknown> } = {},
): RunPosture | undefined {
  if (capability === "none") {
    const posture: RunPosture = {};
    if (current.modeId !== undefined) posture.modeId = null;
    if (current.featureValues !== undefined) posture.featureValues = null;
    return posture;
  }
  if (capability !== "untiered") return undefined;
  const listed = modes.filter((mode) => typeof mode?.id === "string" && mode.id !== "").map((mode) => mode.id);
  const posture: RunPosture = {};
  const keep = current.modeId !== undefined && listed.includes(current.modeId);
  if (!keep) {
    const modeId = profileModeId !== null && listed.includes(profileModeId) ? profileModeId : listed[0];
    if (modeId !== undefined) posture.modeId = modeId;
  }
  if (offersAutoApprove(features) || role === "reviewer") {
    const values = { ...(current.featureValues ?? {}) };
    const set = Object.prototype.hasOwnProperty.call(values, AUTO_APPROVE_FEATURE);
    if (role === "reviewer") {
      if (values[AUTO_APPROVE_FEATURE] !== false) {
        values[AUTO_APPROVE_FEATURE] = false;
        posture.featureValues = values;
      }
    } else if (!set) {
      values[AUTO_APPROVE_FEATURE] = true;
      posture.featureValues = values;
    }
  }
  return posture;
}
