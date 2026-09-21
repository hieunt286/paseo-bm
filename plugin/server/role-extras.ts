/**
 * Additional instructions the user writes for each role (delta
 * 20260916-setup-screen §3.2).
 *
 * Paseo's plugin settings cannot be read on the server, and the instructions
 * are applied on the server (agent.create hook, manager.ensure), so they live
 * in the install home as the user's own file, next to `traces/`: no hash in
 * `install.json`, never touched by an update or `--prune`.
 *
 * They are only ever appended after the base instructions, under a heading
 * that says they cannot override a RULES item.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { resolveInstallHome, TRACES_DIR_NAME, type InstallHomePaseo } from "./install-home";
import { MANAGER_INSTRUCTIONS } from "./manager-instructions";
import { REVIEWER_INSTRUCTIONS } from "./reviewer-instructions";
import { WORKER_INSTRUCTIONS } from "./worker-instructions";
import { writeStoreFileAtomically } from "./trace-store";
import { TIMED_OUT, capabilityOf, chooseModeId, lastModesOf, modesFor, profileModeOf, runPostureOf, withTimeout, type ProviderMode } from "./role-mode";
import { DashboardError } from "../shared/contracts";

export type Role = "manager" | "worker" | "reviewer";

export const ROLE_EXTRAS_FILE = "role-extras.json";
export const MAX_EXTRA_CHARS = 8000;

export const BASE_INSTRUCTIONS: Readonly<Record<Role, string>> = {
  manager: MANAGER_INSTRUCTIONS,
  worker: WORKER_INSTRUCTIONS,
  reviewer: REVIEWER_INSTRUCTIONS,
};

/** Placed between the base and the user's text. Agent-facing, so English. */
export const EXTRA_HEADING = [
  "## Additional instructions from the user",
  "",
  "These add to the rules above and never override a RULES item.",
].join("\n");

const extrasSchema = z.object({
  version: z.literal(1),
  roles: z.object({
    manager: z.string().max(MAX_EXTRA_CHARS).default(""),
    worker: z.string().max(MAX_EXTRA_CHARS).default(""),
    reviewer: z.string().max(MAX_EXTRA_CHARS).default(""),
  }),
});

export type RoleExtras = Record<Role, string>;

const EMPTY: RoleExtras = { manager: "", worker: "", reviewer: "" };

/**
 * Facts the plugin resolves when it builds a role's instructions (delta
 * 20260917c §4.6, owner decision Q22, errata 2026-09-18). Each is the mode an
 * agent must pass when it creates its child, because Paseo refuses that
 * creation without one before any hook runs (K10): the Manager passes the
 * Worker mode, and the Worker — refused as `bypassPermissions` too — passes
 * the Reviewer mode.
 */
export interface RuntimeFacts {
  workerModeId?: string | null;
  reviewerModeId?: string | null;
  /** The Worker's provider has no modes at all (Pi): the Manager must pass none (delta 20260921 §4.2.3). */
  workerModeNone?: boolean;
  /** The Reviewer's provider has no modes at all (Pi): the Worker must pass none. */
  reviewerModeNone?: boolean;
}

/**
 * Reviewer mode the Worker is told when no mode list could ever be read (owner
 * decision Q9 a). Only for a `bm-reviewer` whose base provider is one of
 * `REVIEWER_FALLBACK_PROVIDERS`, or cannot be read at all: another provider
 * does not list `auto`, and Paseo would refuse the creation on it (delta
 * 20260921 §4.2.2, F4).
 */
export const REVIEWER_FALLBACK_MODE = "auto";

/** Base providers known to list `auto` (proposal §1.1). */
export const REVIEWER_FALLBACK_PROVIDERS: readonly string[] = ["claude", "codex"];

/** Agent-facing, so English. `roles/manager.md` and `roles/worker.md` point at this heading. */
export const RUNTIME_FACTS_HEADING = "## Runtime facts";

/** The Runtime facts section for a role, or "" when there is nothing to state. */
export function runtimeFactsText(role: Role, facts: RuntimeFacts = {}): string {
  const trimmed = (value: string | null | undefined) => (typeof value === "string" ? value.trim() : "");
  const child = role === "manager" ? "Worker" : role === "worker" ? "Reviewer" : null;
  if (child === null) return "";
  const none = role === "manager" ? facts.workerModeNone === true : facts.reviewerModeNone === true;
  if (none) {
    return `${RUNTIME_FACTS_HEADING}\n\n${child} mode: none — do not pass \`settings.modeId\` when you create a ${child}; Paseo sets it.`;
  }
  const mode = role === "manager" ? trimmed(facts.workerModeId) : trimmed(facts.reviewerModeId);
  if (mode === "") return "";
  return `${RUNTIME_FACTS_HEADING}\n\n${child} mode: \`${mode}\` — pass it as \`settings.modeId\` when you create a ${child}.`;
}

/**
 * Base instructions, then the Runtime facts, then the user's text. With
 * neither facts nor text this is the base, byte for byte.
 */
export function fullInstructions(role: Role, extra: string, facts: RuntimeFacts = {}): string {
  const text = extra.trim();
  const base = BASE_INSTRUCTIONS[role];
  const factsText = runtimeFactsText(role, facts);
  if (text === "" && factsText === "") return base;
  let out = base.trimEnd();
  if (factsText !== "") out += `\n\n${factsText}`;
  if (text !== "") out += `\n\n---\n\n${EXTRA_HEADING}\n\n${text}`;
  return `${out}\n`;
}

/**
 * The Runtime facts that apply to a role now. For the Manager: the Worker mode
 * the hook's own rule picks from `listModes("bm-worker")`; for the Worker: the
 * Reviewer mode it picks from `listModes("bm-reviewer")`. So what the creator
 * passes and what the hook would choose are the same value. `{}` when it cannot
 * be read — the failure is logged, and the creation attempt then fails loudly
 * with Paseo's list of modes rather than silently.
 */
export async function runtimeFactsOf(
  role: Role,
  paseo: unknown,
  cwd?: string,
  log: (message: string) => void = (message) => console.warn(message),
): Promise<RuntimeFacts> {
  if (role === "reviewer") return {};
  try {
    if (role === "worker") {
      const profileModeId = await profileModeOf(paseo, "bm-reviewer");
      const modes = await modesFor(paseo, "bm-reviewer", undefined, cwd);
      // Delta 20260921 §4.2.2–§4.2.3: the value the hook's posture rule gives
      // the Reviewer on an untiered provider, or "none" for one without modes.
      const byCapability = childModeByCapability("reviewer", modes, profileModeId);
      if (byCapability !== undefined) {
        return byCapability === null ? { reviewerModeNone: true } : { reviewerModeId: byCapability };
      }
      if (modes === null) {
        const base = await baseProviderOf(paseo, "bm-reviewer");
        if (base !== null && !REVIEWER_FALLBACK_PROVIDERS.includes(base)) {
          // `auto` is Claude's and Codex's; told to a Worker whose Reviewer runs
          // elsewhere, it would only make Paseo refuse the creation (F4).
          const last = lastModesOf("bm-reviewer");
          const fromLast = last === null ? undefined : childModeByCapability("reviewer", last.modes, profileModeId);
          if (typeof fromLast === "string") {
            log(`[paseo-bm] could not read the modes of bm-reviewer; the Worker is told to pass the Reviewer mode "${fromLast}" (last list read at ${last!.at}).`);
            return { reviewerModeId: fromLast };
          }
          log(`[paseo-bm] could not read the modes of bm-reviewer (base provider ${base}); the Worker is told no Reviewer mode.`);
          return {};
        }
        // Unlike the Manager's case, the profile's own mode is NOT passed blind:
        // its tier is unknown, and a Reviewer must never run in a dangerous one.
        // The fallback is the last list read in this run, through the same
        // rule, else `auto` — the rule's first choice, listed by Claude and
        // Codex; a provider without it makes Paseo refuse the creation loudly
        // (delta 20260918g §4.9, owner decisions Q4 a and Q9 a).
        const last = lastModesOf("bm-reviewer");
        const fromLast = last === null ? undefined : chooseModeId("reviewer", last.modes, undefined, profileModeId);
        const reviewerModeId = fromLast ?? REVIEWER_FALLBACK_MODE;
        const source = fromLast === undefined ? "static fallback" : `last list read at ${last!.at}`;
        log(`[paseo-bm] could not read the modes of bm-reviewer; the Worker is told to pass the fallback Reviewer mode "${reviewerModeId}" (${source}).`);
        return { reviewerModeId };
      }
      const reviewerModeId = chooseModeId("reviewer", modes, undefined, profileModeId);
      return reviewerModeId === undefined ? {} : { reviewerModeId };
    }
    const profileModeId = await profileModeOf(paseo, "bm-worker");
    const modes = await modesFor(paseo, "bm-worker", undefined, cwd);
    const byCapability = childModeByCapability("worker", modes, profileModeId);
    if (byCapability !== undefined) {
      return byCapability === null ? { workerModeNone: true } : { workerModeId: byCapability };
    }
    if (modes === null) {
      // A mode the owner set by hand on the profile is still worth passing:
      // Paseo validates it and reports its own error if it is wrong.
      return profileModeId === null ? {} : { workerModeId: profileModeId };
    }
    const workerModeId = chooseModeId("worker", modes, undefined, profileModeId);
    return workerModeId === undefined ? {} : { workerModeId };
  } catch (error) {
    log(`[paseo-bm] reading the Runtime facts of ${role} failed: ${error instanceof Error ? error.message : String(error)}`);
    return {};
  }
}

/**
 * The child mode on an `untiered` provider (the posture rule's mode: the
 * profile's if listed, else the first listed), `null` for a provider with no
 * modes, and `undefined` for `tiered` / `unknown`, whose rules stay as they were.
 */
function childModeByCapability(
  role: "worker" | "reviewer",
  modes: readonly ProviderMode[] | null,
  profileModeId: string | null,
): string | null | undefined {
  const capability = capabilityOf(modes);
  if (capability === "none") return null;
  if (capability !== "untiered") return undefined;
  return runPostureOf(role, "untiered", modes ?? [], null, profileModeId)?.modeId;
}

/** The `extends` of a paseo-bm provider alias, or `null` when it cannot be read. Never throws. */
async function baseProviderOf(paseo: unknown, alias: string): Promise<string | null> {
  const get = (paseo as { config?: { get?: unknown } } | null | undefined)?.config?.get;
  if (typeof get !== "function") return null;
  try {
    const result = await withTimeout(
      get.call((paseo as { config: unknown }).config) as Promise<{ config?: { providers?: Record<string, { extends?: unknown } | undefined> } }>,
    );
    if (result === TIMED_OUT) return null;
    const base = result?.config?.providers?.[alias]?.extends;
    return typeof base === "string" && base.trim() !== "" ? base : null;
  } catch {
    return null;
  }
}

/** The extras in `home`; empty when the file is missing or unreadable. Never throws. */
export function readRoleExtras(home: string): RoleExtras {
  try {
    const parsed = extrasSchema.safeParse(JSON.parse(readFileSync(join(home, ROLE_EXTRAS_FILE), "utf8")));
    return parsed.success ? parsed.data.roles : { ...EMPTY };
  } catch {
    return { ...EMPTY };
  }
}

/** Replaces one role's text. Atomic, 0600, and refuses symlinks inside the home. */
export function saveRoleExtra(home: string, role: Role, text: string): RoleExtras {
  if (text.length > MAX_EXTRA_CHARS) {
    throw new DashboardError("E_ROLE_EXTRA_INVALID", `at most ${MAX_EXTRA_CHARS} characters, got ${text.length}`);
  }
  const roles = { ...readRoleExtras(home), [role]: text };
  writeStoreFileAtomically(
    { tracesDir: join(home, TRACES_DIR_NAME) },
    join(home, ROLE_EXTRAS_FILE),
    `${JSON.stringify({ version: 1, roles }, null, 2)}\n`,
  );
  return roles;
}

/** The install home, or null when paseo-bm's home cannot be confirmed. */
export async function installHomeOf(paseo: unknown, deps: { homedir?: () => string } = {}): Promise<string | null> {
  try {
    const resolution = await resolveInstallHome({
      paseo: paseo as InstallHomePaseo,
      fs: { readFileSync: (path, encoding) => readFileSync(path, encoding) },
      homedir: deps.homedir ?? homedir,
    });
    return resolution.home;
  } catch {
    return null;
  }
}

/** Full instructions for a role as they apply now, falling back to the base. */
export async function currentInstructions(
  role: Role,
  paseo: unknown,
  deps: { homedir?: () => string; cwd?: string } = {},
): Promise<string> {
  const home = await installHomeOf(paseo, deps);
  const facts = await runtimeFactsOf(role, paseo, deps.cwd);
  return fullInstructions(role, home === null ? "" : readRoleExtras(home)[role], facts);
}
