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
 * The `modeId` set by hand on a paseo-bm profile, or `null`. Read the same way
 * `manager.ensure` reads the Manager's profile. Never throws.
 */
export async function profileModeOf(
  paseo: unknown,
  profileId: string,
  log: (message: string) => void = (message) => console.warn(message),
): Promise<string | null> {
  const get = (paseo as { config?: { get?: unknown } } | null | undefined)?.config?.get;
  if (typeof get !== "function") return null;
  try {
    const result = await withTimeout(
      (get.call((paseo as { config: unknown }).config) as Promise<{
        config?: { agentProfiles?: Array<{ id?: unknown; modeId?: unknown }> };
      }>),
    );
    if (result === TIMED_OUT) {
      log(`[paseo-bm] reading the ${profileId} profile took longer than ${LOOKUP_TIMEOUT_MS} ms; its own mode is ignored.`);
      return null;
    }
    const profile = result?.config?.agentProfiles?.find((entry) => entry?.id === profileId);
    const modeId = profile?.modeId;
    return typeof modeId === "string" && modeId.trim() !== "" ? modeId : null;
  } catch {
    return null;
  }
}

/**
 * The provider's modes, or `null` when they cannot be read. Every `null` is
 * logged: a silent miss would leave a Reviewer in the full-access mode it
 * inherits from a no-prompt Worker, or a Manager without the Worker mode it
 * must pass.
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
    if (modes.length === 0) {
      const reason = typeof result?.error === "string" && result.error !== "" ? result.error : "no modes listed";
      log(`[paseo-bm] could not read the modes of ${provider} (${reason}); its mode is left to its creator.`);
      return null;
    }
    return modes;
  } catch (error) {
    log(`[paseo-bm] could not read the modes of ${provider} (${error instanceof Error ? error.message : String(error)}); its mode is left to its creator.`);
    return null;
  }
}
