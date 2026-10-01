/**
 * The instructions a paseo-bm agent is created with: its role file
 * (`BASE_INSTRUCTIONS`, embedded by the build from `roles/*.md`), then the
 * Runtime facts — a Worker's review budget among them — and the owner's
 * precedents the plugin resolves when the agent is created (`runtimeFactsOf`). Both the `agent.create` hook and
 * `manager.ensure` build them here, so they write the same text. It also
 * hands out the data folder as `dataHomeOf`, which most server modules import
 * from here: rpc-kit's `dataHome` (code review 2026-09-30 §3.2).
 *
 * Nothing the owner writes is appended any more: the per-role additional
 * instructions are retired and their file is never read (autonomy design
 * §B.8); precedents per project replace them. The cleanup button still
 * deletes a file an earlier build left (`setup-machine.ts`).
 */
import { MANAGER_INSTRUCTIONS } from "./manager-instructions";
import { ORCHESTRATOR_INSTRUCTIONS } from "./orchestrator-instructions";
import { REVIEWER_INSTRUCTIONS } from "./reviewer-instructions";
import { WORKER_INSTRUCTIONS } from "./worker-instructions";
import {
  TIMED_OUT,
  boundaryPostureOf,
  capabilityOf,
  chooseModeId,
  lastModesOf,
  modesFor,
  profileModeOf,
  runPostureOf,
  withTimeout,
  type BoundaryPosture,
  type BoundarySwitch,
  type ProviderMode,
} from "./role-mode";
import { PRECEDENT_SCOPE_ALL, type Precedent } from "../shared/precedents";
import { boundaryOf } from "../shared/autonomy";
import { readActivePrecedents, readAutonomyPolicy } from "./autonomy-rpc";
import { readReviewBudget } from "./coordination-rpc";
import { DEFAULT_COORDINATION_SETTINGS, reviewBudgetOf, type ReviewBudget } from "../shared/coordination";
import { skillsStatus, type SkillsStatus } from "./setup-skills";

export type Role = "manager" | "worker" | "reviewer" | "orchestrator";

export const BASE_INSTRUCTIONS: Readonly<Record<Role, string>> = {
  manager: MANAGER_INSTRUCTIONS,
  worker: WORKER_INSTRUCTIONS,
  reviewer: REVIEWER_INSTRUCTIONS,
  orchestrator: ORCHESTRATOR_INSTRUCTIONS,
};

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
  /**
   * Required skills the Worker's own agent cannot load, checked by the plugin
   * (PRD delta 20260924-worker-autonomy REQ-035a): `[]` all present,
   * absent when it could not be checked (no line at all).
   */
  workerSkillsMissing?: string[];
  /**
   * The owner's active precedents that hold where the agent is created — its
   * workspace's and the global ones — newest first (autonomy design §B.6).
   * Absent or empty: no `## Owner precedents` part.
   */
  precedents?: readonly PrecedentFact[];
  /**
   * The owner's review budget per tier a new Worker is given (autonomy design
   * §C.4, §G.7; change-008 C6), read when it is created: a Worker keeps the
   * budget it started with. Absent: no line.
   */
  reviewBudget?: ReviewBudget;
  /**
   * Whether this Worker or Reviewer runs under the action boundary, as the
   * creation hook applied it (autonomy design §D.2): the `Action boundary`
   * line. Absent: no line, which reads as off (the hook ran out of its
   * budget, or the plugin was down).
   */
  actionBoundary?: BoundaryPosture;
}

/** The `Action boundary` facts line's key; `agent-labels.ts` and the permission handler read it back. */
export const ACTION_BOUNDARY_KEY = "Action boundary:";

/** The facts line: `Action boundary: on`, or `Action boundary: off — <why>`. */
export function actionBoundaryLine(posture: BoundaryPosture): string {
  return posture.on ? `${ACTION_BOUNDARY_KEY} on` : `${ACTION_BOUNDARY_KEY} off — ${posture.reason}`;
}

/**
 * The `Action boundary` state a system prompt carries in its `## Runtime
 * facts` (only there: nothing else in a prompt can claim it), or null when it
 * carries no such line — which reads as off.
 */
export function actionBoundaryOfPrompt(prompt: unknown): "on" | "off" | null {
  if (typeof prompt !== "string") return null;
  const at = prompt.indexOf(`\n${RUNTIME_FACTS_HEADING}\n`);
  if (at === -1) return null;
  const section = prompt.slice(at + RUNTIME_FACTS_HEADING.length + 2);
  const end = section.search(/\n## |\n---\n/);
  const match = /^Action boundary: (on|off)\b/m.exec(end === -1 ? section : section.slice(0, end));
  return match === null ? null : (match[1] as "on" | "off");
}

/** What an `## Owner precedents` line shows of a precedent. */
export type PrecedentFact = Pick<Precedent, "subject" | "text" | "scope" | "expiresAt">;

/** Agent-facing, so English. `roles/manager.md` and `roles/worker.md` point at this heading. */
export const OWNER_PRECEDENTS_HEADING = "## Owner precedents";

/** The most precedents an agent is given, the newest (design §B.6): the prompt's bound is the count. */
export const MAX_INJECTED_PRECEDENTS = 20;

/**
 * One precedent as one line: its subject, its text as the owner wrote it (on
 * one line), where it holds and until when — for example
 * ``- `user-list-storage` — the existing users table (this project, until 2026-10-30)``.
 */
export function precedentLine(precedent: PrecedentFact): string {
  const where = precedent.scope === PRECEDENT_SCOPE_ALL ? "all projects" : "this project";
  const at = Date.parse(precedent.expiresAt);
  const until = Number.isNaN(at) ? precedent.expiresAt : new Date(at).toISOString().slice(0, 10);
  return `- \`${precedent.subject}\` — ${precedent.text.replace(/\s+/g, " ").trim()} (${where}, until ${until})`;
}

/** The Worker's review budget line (§G.7): `Review calls per request: Small 2, Medium 2, Large 4.` */
export function reviewBudgetLine(budget: ReviewBudget): string {
  return `Review calls per request: Small ${budget.Small}, Medium ${budget.Medium}, Large ${budget.Large}.`;
}

/** The Manager's `Worker skills` line (design delta 20260924-instruction-quality §3). */
export function workerSkillsLine(missing: readonly string[]): string {
  return missing.length === 0
    ? "Worker skills: all present."
    : `Worker skills: missing ${missing.map((name) => `\`${name}\``).join(", ")} — tell the user once, when you confirm the Worker, that it works with lower quality, and point to Beads Manager → Settings → Tools & skills.`;
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

/**
 * The Runtime facts section for a role, then its `## Owner precedents` part
 * (the Manager and the Worker only, at most `MAX_INJECTED_PRECEDENTS`), or ""
 * when there is nothing to state.
 */
export function runtimeFactsText(role: Role, facts: RuntimeFacts = {}): string {
  const trimmed = (value: string | null | undefined) => (typeof value === "string" ? value.trim() : "");
  const child = role === "manager" ? "Worker" : role === "worker" ? "Reviewer" : null;
  if (child === null && role !== "reviewer") return "";
  const lines: string[] = [];
  const none = role === "manager" ? facts.workerModeNone === true : facts.reviewerModeNone === true;
  const mode = role === "manager" ? trimmed(facts.workerModeId) : trimmed(facts.reviewerModeId);
  if (child !== null && none) lines.push(`${child} mode: none — do not pass \`settings.modeId\` when you create a ${child}; Paseo sets it.`);
  else if (child !== null && mode !== "") lines.push(`${child} mode: \`${mode}\` — pass it as \`settings.modeId\` when you create a ${child}.`);
  if (role === "manager" && facts.workerSkillsMissing !== undefined) lines.push(workerSkillsLine(facts.workerSkillsMissing));
  if (role === "worker" && facts.reviewBudget !== undefined) lines.push(reviewBudgetLine(facts.reviewBudget));
  // Autonomy design §D.2: whether this Worker or Reviewer runs under the action boundary.
  if ((role === "worker" || role === "reviewer") && facts.actionBoundary !== undefined) lines.push(actionBoundaryLine(facts.actionBoundary));
  const parts = lines.length === 0 ? [] : [`${RUNTIME_FACTS_HEADING}\n\n${lines.join("\n")}`];
  // The owner's precedents are the Manager's and the Worker's only (§B.6).
  const precedents = child === null ? [] : (facts.precedents ?? []).slice(0, MAX_INJECTED_PRECEDENTS);
  if (precedents.length > 0) parts.push(`${OWNER_PRECEDENTS_HEADING}\n\n${precedents.map(precedentLine).join("\n")}`);
  return parts.join("\n\n");
}

/**
 * Base instructions, then the Runtime facts and the owner's precedents. With
 * no facts this is the base, byte for byte.
 */
export function fullInstructions(role: Role, facts: RuntimeFacts = {}): string {
  const base = BASE_INSTRUCTIONS[role];
  const factsText = runtimeFactsText(role, facts);
  if (factsText === "") return base;
  return `${base.trimEnd()}\n\n${factsText}\n`;
}

/**
 * Where `runtimeFactsOf` reads the owner's precedents (autonomy design §B.6,
 * §B.9). Only an agent's creation passes one — the `agent.create` hook and
 * `manager.ensure` — so nothing else pays for the read.
 */
export interface PrecedentLookup {
  /** The agent's workspace when the caller knows it (`manager.ensure`); otherwise it is resolved from `cwd`. */
  workspaceId?: string;
  /** The workspace whose folder is `cwd`, or null when none can be told; without it, or unresolved, only global precedents are read. */
  workspaceOf?: (cwd: string) => Promise<string | null>;
  /** The active precedents, newest first, of a workspace and the global ones (all when `undefined`); `readActivePrecedents` by default. */
  read?: (workspaceId: string | undefined) => readonly Precedent[];
}

/**
 * What only an agent's creation reads (the `agent.create` hook,
 * `manager.ensure`): the owner's precedents, and for a new Worker the owner's
 * review budget (§G.7; `readReviewBudget` by default, 2 / 2 / 4 when unreadable).
 */
export interface CreationLookup extends PrecedentLookup {
  reviewBudget?: () => ReviewBudget;
  /**
   * The project's action boundary switch at this creation (§D.2), when the
   * caller already read it (the creation hook); otherwise it is read from the
   * policy for the workspace (`boundaryOn`), `unknown` when none can be told.
   */
  boundary?: BoundarySwitch;
  /** Whether a project's boundary is on; the owner's policy by default (`autonomy/policy.json`). */
  boundaryOn?: (workspaceId: string) => boolean;
}

/**
 * The project of a creation and its action boundary switch (§D.2,
 * change-010 C5): the caller's workspace, else the one whose folder is
 * `cwd` (within the lookup budget); `unknown` when none can be told, read as
 * off. Never throws.
 */
export async function creationProjectOf(
  cwd: string | undefined,
  lookup: CreationLookup,
  log: (message: string) => void = (message) => console.warn(message),
): Promise<{ workspaceId: string | null; boundary: BoundarySwitch }> {
  try {
    let workspaceId = lookup.workspaceId ?? null;
    if (workspaceId === null && cwd !== undefined && lookup.workspaceOf !== undefined) {
      const workspaceOf = lookup.workspaceOf;
      const found = await withTimeout(Promise.resolve().then(() => workspaceOf(cwd))).catch(() => null);
      workspaceId = found === TIMED_OUT ? null : found;
    }
    if (lookup.boundary !== undefined) return { workspaceId, boundary: lookup.boundary };
    if (workspaceId === null) return { workspaceId, boundary: "unknown" };
    const on = (lookup.boundaryOn ?? ((id: string) => boundaryOf(readAutonomyPolicy({ log }), id) !== null))(workspaceId);
    return { workspaceId, boundary: on ? "on" : "off" };
  } catch (error) {
    log(`[paseo-bm] reading the project of a new agent failed: ${error instanceof Error ? error.message : String(error)}`);
    return { workspaceId: null, boundary: "unknown" };
  }
}

/**
 * The Runtime facts that apply to a role now. For the Manager: the Worker mode
 * the hook's own rule picks from `listModes("bm-worker")`; for the Worker: the
 * Reviewer mode it picks from `listModes("bm-reviewer")`. So what the creator
 * passes and what the hook would choose are the same value. `{}` when it cannot
 * be read — the failure is logged, and the creation attempt then fails loudly
 * with Paseo's list of modes rather than silently. With `precedents` — the
 * creation's lookup — the Manager and the Worker also get the owner's
 * precedents (`precedentFactsOf`), and the Worker the owner's review budget.
 */
export async function runtimeFactsOf(
  role: Role,
  paseo: unknown,
  cwd?: string,
  log: (message: string) => void = (message) => console.warn(message),
  skills: () => SkillsStatus = () => skillsStatus(),
  precedents?: CreationLookup,
): Promise<RuntimeFacts> {
  // The project and its action boundary switch, once: the child mode and the precedents both follow it (§D.2, §B.6).
  const project =
    precedents === undefined || (role !== "manager" && role !== "worker")
      ? { workspaceId: null, boundary: "unknown" as const }
      : await creationProjectOf(cwd, precedents, log);
  const lookup: CreationLookup | undefined =
    precedents === undefined ? undefined : project.workspaceId === null ? precedents : { ...precedents, workspaceId: project.workspaceId };
  // In parallel: each lookup has its own timeout, and a slow one must not add to the other.
  const [modes, skillFacts, precedentFacts] = await Promise.all([
    modeFactsOf(role, paseo, cwd, log, project.boundary),
    role === "manager" ? workerSkillFacts(paseo, skills, log) : Promise.resolve({}),
    lookup === undefined ? Promise.resolve({}) : precedentFactsOf(role, cwd, lookup, log),
  ]);
  const budgetFacts = role === "worker" && precedents !== undefined ? reviewBudgetFactsOf(precedents, log) : {};
  return { ...modes, ...skillFacts, ...precedentFacts, ...budgetFacts };
}

/** A new Worker's review budget (§G.7): the owner's, else the defaults; never throws. */
function reviewBudgetFactsOf(lookup: CreationLookup, log: (message: string) => void): RuntimeFacts {
  try {
    return { reviewBudget: (lookup.reviewBudget ?? (() => readReviewBudget({ log })))() };
  } catch (error) {
    log(`[paseo-bm] reading the review budget for a new Worker failed: ${error instanceof Error ? error.message : String(error)}`);
    return { reviewBudget: reviewBudgetOf(DEFAULT_COORDINATION_SETTINGS) };
  }
}

/**
 * The owner's precedents a new Manager or Worker is given (design §B.6,
 * §B.9): the active ones of its workspace and the global ones, newest first,
 * at most `MAX_INJECTED_PRECEDENTS`. The workspace is the caller's, else the
 * one whose folder is `cwd`; when it cannot be told, only the global ones —
 * never another project's. `{}` — no part — when there are none or they
 * cannot be read: a failure is logged and never costs the agent its creation.
 */
export async function precedentFactsOf(
  role: Role,
  cwd: string | undefined,
  lookup: PrecedentLookup,
  log: (message: string) => void = (message) => console.warn(message),
): Promise<RuntimeFacts> {
  if (role !== "manager" && role !== "worker") return {};
  try {
    let workspaceId = lookup.workspaceId ?? null;
    if (workspaceId === null && cwd !== undefined && lookup.workspaceOf !== undefined) {
      const workspaceOf = lookup.workspaceOf;
      const found = await withTimeout(Promise.resolve().then(() => workspaceOf(cwd))).catch(() => null);
      workspaceId = found === TIMED_OUT ? null : found;
    }
    const read = lookup.read ?? ((id: string | undefined) => readActivePrecedents({ log }, id));
    const precedents = read(workspaceId ?? undefined)
      .filter((precedent) => precedent.scope === PRECEDENT_SCOPE_ALL || precedent.scope === workspaceId)
      .slice(0, MAX_INJECTED_PRECEDENTS)
      .map(({ subject, text, scope, expiresAt }) => ({ subject, text, scope, expiresAt }));
    return precedents.length === 0 ? {} : { precedents };
  } catch (error) {
    log(`[paseo-bm] reading the owner's precedents for a new ${role} failed: ${error instanceof Error ? error.message : String(error)}`);
    return {};
  }
}

/**
 * Which required skills the Worker's own agent lacks, from the provider the
 * `bm-worker` alias extends (PRD delta 20260924-worker-autonomy REQ-035a: the
 * plugin checks, the Manager only tells the user). `{}` — no line — when the
 * provider or the skill directories cannot be read. Never throws.
 */
async function workerSkillFacts(paseo: unknown, skills: () => SkillsStatus, log: (message: string) => void): Promise<RuntimeFacts> {
  try {
    const base = await baseProviderOf(paseo, "bm-worker");
    if (base !== "claude" && base !== "codex" && base !== "pi" && base !== "opencode") return {};
    const missing = skills().skills.filter((row) => row.required && row[base] !== "ok").map((row) => row.name);
    return { workerSkillsMissing: missing };
  } catch (error) {
    log(`[paseo-bm] checking the Worker's skills failed: ${error instanceof Error ? error.message : String(error)}`);
    return {};
  }
}

/**
 * The mode facts of `runtimeFactsOf`, and of a `BM-SETTINGS` line for a
 * project whose boundary is `project` (`settings-notices.ts`). The Reviewer
 * and the Orchestrator create no agent, so they are told no child mode
 * (orchestrator design §3.2).
 */
export async function modeFactsOf(
  role: Role,
  paseo: unknown,
  cwd: string | undefined,
  log: (message: string) => void,
  project: BoundarySwitch = "unknown",
): Promise<RuntimeFacts> {
  if (role === "reviewer" || role === "orchestrator") return {};
  try {
    if (role === "worker") {
      const profileModeId = await profileModeOf(paseo, "bm-reviewer");
      const modes = await modesFor(paseo, "bm-reviewer", undefined, cwd);
      // A project whose action boundary is on (§D.2): the Reviewer's boundary mode, when the boundary covers it.
      const bounded = project === "on" ? await boundaryChildMode("reviewer", paseo, modes, profileModeId) : null;
      if (bounded !== null) return { reviewerModeId: bounded };
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
    const bounded = project === "on" ? await boundaryChildMode("worker", paseo, modes, profileModeId) : null;
    if (bounded !== null) return { workerModeId: bounded };
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
 * The boundary mode the creator of a child is told in a project whose
 * boundary is on (§D.2), or null when the boundary does not cover the child:
 * its base provider has no column, its profile sets a mode by hand, or its
 * provider lists the modes without that one. The hook applies the same rule
 * (`boundaryPostureOf`), so the creator passes what the hook keeps.
 */
async function boundaryChildMode(
  role: "worker" | "reviewer",
  paseo: unknown,
  modes: readonly ProviderMode[] | null,
  profileModeId: string | null,
): Promise<string | null> {
  const base = await baseProviderOf(paseo, role === "worker" ? "bm-worker" : "bm-reviewer");
  const posture = boundaryPostureOf({ role, base, project: "on", modes, profileModeId });
  return posture?.on === true ? posture.modeId : null;
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
export async function baseProviderOf(paseo: unknown, alias: string): Promise<string | null> {
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

/**
 * The data folder, or null when it cannot be used: rpc-kit's `dataHome`, the
 * one lookup (code review 2026-09-30 §3.2), under the name the server modules
 * import. `home` in its argument stands in for the folder, so a caller's
 * `deps.home !== undefined ? deps.home : dataHomeOf()` can be `dataHomeOf(deps)`.
 *
 * Synchronous, and it asks Paseo nothing: from 0.4.0 the folder is found from
 * the environment, a pointer file and a default (`resolveDataHome`, design
 * §5.1), so there is no round trip to race against and no `install.json` to
 * confirm. Before that it read the path Paseo had registered, which is why
 * every caller used to wrap it in `withTimeout`.
 */
export { dataHome as dataHomeOf } from "./rpc-kit";

/**
 * Full instructions for a role as they apply now, falling back to the base:
 * what a Manager is created with (`manager.ensure`, a fallback Manager), so it
 * carries the owner's precedents of `workspaceId` and the global ones, and the
 * Worker mode its project's action boundary switch gives (§D.2).
 */
export async function currentInstructions(
  role: Role,
  paseo: unknown,
  deps: { homedir?: () => string; cwd?: string; workspaceId?: string } = {},
): Promise<string> {
  const home = deps.homedir === undefined ? {} : { homedir: deps.homedir };
  const read = (workspaceId: string | undefined) => readActivePrecedents(home, workspaceId);
  const facts = await runtimeFactsOf(role, paseo, deps.cwd, undefined, undefined, {
    ...(deps.workspaceId !== undefined ? { workspaceId: deps.workspaceId } : {}),
    read,
    reviewBudget: () => readReviewBudget(home),
    // The project's action boundary switch (§D.2): the Manager is told the Worker mode of its project.
    boundaryOn: (workspaceId) => boundaryOf(readAutonomyPolicy(home), workspaceId) !== null,
  });
  return fullInstructions(role, facts);
}
