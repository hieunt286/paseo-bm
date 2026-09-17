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
import { chooseModeId, modesFor, profileModeOf } from "./role-mode";
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
 * 20260917c §4.6, owner decision Q22). Today there is one: the mode the Manager
 * must pass when it creates a Worker, because Paseo refuses that creation
 * without one before any hook runs (K10).
 */
export interface RuntimeFacts {
  workerModeId?: string | null;
}

/** Agent-facing, so English. `roles/manager.md` points at this heading. */
export const RUNTIME_FACTS_HEADING = "## Runtime facts";

/** The Runtime facts section for a role, or "" when there is nothing to state. */
export function runtimeFactsText(role: Role, facts: RuntimeFacts = {}): string {
  const workerMode = typeof facts.workerModeId === "string" ? facts.workerModeId.trim() : "";
  if (role !== "manager" || workerMode === "") return "";
  return `${RUNTIME_FACTS_HEADING}\n\nWorker mode: \`${workerMode}\` — pass it as \`settings.modeId\` when you create a Worker.`;
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
 * the hook's own rule picks from `listModes("bm-worker")`, so what the Manager
 * passes and what the hook would choose are the same value. `{}` when it cannot
 * be read — the failure is logged, and the Manager's creation attempt then
 * fails loudly with Paseo's list of modes rather than silently.
 */
export async function runtimeFactsOf(role: Role, paseo: unknown, cwd?: string): Promise<RuntimeFacts> {
  if (role !== "manager") return {};
  try {
    const profileModeId = await profileModeOf(paseo, "bm-worker");
    const modes = await modesFor(paseo, "bm-worker", undefined, cwd);
    if (modes === null) {
      // A mode the owner set by hand on the profile is still worth passing:
      // Paseo validates it and reports its own error if it is wrong.
      return profileModeId === null ? {} : { workerModeId: profileModeId };
    }
    const workerModeId = chooseModeId("worker", modes, undefined, profileModeId);
    return workerModeId === undefined ? {} : { workerModeId };
  } catch {
    return {};
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
