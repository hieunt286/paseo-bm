/**
 * The role pairing (PRD REQ-116 b, autonomy design §A.10): only a Beads
 * Manager creates Beads Workers, and only a Worker creates Reviewers.
 *
 * Enforced AFTER creation, as an alert, not as a refusal: Paseo 0.9.2 hands
 * `before("agent.create")` only `{ config, env }` — no creator id — so the
 * hook cannot tell who is asking (verified on an isolated daemon 2026-09-29,
 * AGENTS.md "Verified facts about Paseo", run note
 * `docs/archive/operations/paseo-bm-role-pairing-run-20260929.md`). The
 * `agent.created` event does carry `parentAgentId` (Paseo's
 * `paseo.parent-agent-id` label), so the check runs there.
 *
 * The creator's role is read from its PROVIDER, never its `bm.role` label: a
 * label can be changed after creation (`update_agent`), the provider cannot.
 *
 * An agent without a creator agent — started by the user from the app, or by
 * the plugin itself (the Manager from `manager.ensure`, the Orchestrator and
 * its assessment agent) — is not subject to the rule. A fallback alias runs the
 * role in its name (`roleOfProvider`), so a Manager's fallback Worker and a
 * Worker's replacement Reviewer pair correctly.
 *
 * Nothing here throws.
 */
import { roleOfProvider, type BmRole } from "./agent-role";
import type { AlertInput } from "./alert-store";

/** The role that must have created an agent of each checked role. */
export const REQUIRED_CREATOR: Readonly<Partial<Record<BmRole, BmRole>>> = {
  worker: "manager",
  reviewer: "worker",
};

/** How the rule names each role in a message. */
const ROLE_NAME: Readonly<Record<BmRole, string>> = {
  manager: "Beads Manager",
  worker: "Beads Worker",
  reviewer: "Reviewer",
  orchestrator: "Orchestrator",
};

/** The fields of the `agent.created` event's agent this check reads. */
export interface PairingAgent {
  id: string;
  provider: string;
  workspaceId?: string | null;
  parentAgentId?: string | null;
}

/** A Worker or Reviewer created by an agent of the wrong role. */
export interface RolePairingMismatch {
  agentId: string;
  workspaceId: string | null;
  role: BmRole;
  provider: string;
  creatorId: string;
  /** The creator's provider id as Paseo reports it; `null` when the snapshot had none. */
  creatorProvider: string | null;
  /** `null` when the creator is not a paseo-bm agent at all. */
  creatorRole: BmRole | null;
  requiredRole: BmRole;
}

/** The rule that applies to `agent`, or `null`: not a Worker or Reviewer, or no creator agent. Never throws. */
function pairingRuleFor(agent: PairingAgent): { role: BmRole; requiredRole: BmRole; creatorId: string } | null {
  try {
    const role = roleOfProvider(agent.provider);
    const requiredRole = role === null ? undefined : REQUIRED_CREATOR[role];
    const creatorId = typeof agent.parentAgentId === "string" && agent.parentAgentId.trim() !== "" ? agent.parentAgentId : null;
    return role === null || requiredRole === undefined || creatorId === null ? null : { role, requiredRole, creatorId };
  } catch {
    return null;
  }
}

/**
 * The mismatch, or `null` when the pair is allowed or the rule does not apply
 * (not a Worker or Reviewer, or no creator agent). Pure; never throws.
 */
export function rolePairingMismatch(agent: PairingAgent, creatorProvider: string | null): RolePairingMismatch | null {
  try {
    const rule = pairingRuleFor(agent);
    if (rule === null) return null;
    const { role, requiredRole, creatorId } = rule;
    const creatorRole = roleOfProvider(creatorProvider);
    if (creatorRole === requiredRole) return null;
    return {
      agentId: agent.id,
      workspaceId: typeof agent.workspaceId === "string" ? agent.workspaceId : null,
      role,
      provider: agent.provider,
      creatorId,
      creatorProvider,
      creatorRole,
      requiredRole,
    };
  } catch {
    return null;
  }
}

/** One line naming the rule, the agent and its creator. */
export function describeRolePairingMismatch(mismatch: RolePairingMismatch): string {
  const creator =
    mismatch.creatorRole === null
      ? `agent ${mismatch.creatorId}, which is not a paseo-bm agent (provider ${mismatch.creatorProvider ?? "unknown"})`
      : `${ROLE_NAME[mismatch.creatorRole]} ${mismatch.creatorId}`;
  return (
    `${ROLE_NAME[mismatch.role]} ${mismatch.agentId} was created by ${creator}; ` +
    `only a ${ROLE_NAME[mismatch.requiredRole]} creates a ${ROLE_NAME[mismatch.role]}.`
  );
}

/**
 * The Inbox alert of a mismatch (autonomy design §A.8): kind
 * `pairing-mismatch`, about the agent created by the wrong role, once per
 * agent. It stays open: the pairing of an agent never changes.
 */
export function rolePairingAlertOf(mismatch: RolePairingMismatch): AlertInput {
  return { workspaceId: mismatch.workspaceId, kind: "pairing-mismatch", subject: mismatch.agentId, detail: describeRolePairingMismatch(mismatch) };
}

export interface RolePairingDeps {
  /**
   * Records the mismatch as an Inbox alert (design §A.8): the plugin passes
   * `raiseInboxAlert(rolePairingAlertOf(mismatch))`. Without it, or when it
   * fails, the mismatch is logged.
   */
  raiseAlert?: (mismatch: RolePairingMismatch) => void | Promise<void>;
  /** Where the fallback line and lookup failures go. Defaults to `console.warn`. */
  log?: (message: string) => void;
}

/**
 * Reports a mismatch: through `deps.raiseAlert` when an alerts store is wired,
 * otherwise as one log line. Never throws.
 */
export async function raiseRolePairingAlert(mismatch: RolePairingMismatch, deps: RolePairingDeps = {}): Promise<void> {
  const log = deps.log ?? ((message: string) => console.warn(message));
  if (typeof deps.raiseAlert === "function") {
    try {
      await deps.raiseAlert(mismatch);
      return;
    } catch (error) {
      log(`[paseo-bm] could not record the role pairing alert: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  log(`[paseo-bm] role pairing: ${describeRolePairingMismatch(mismatch)}`);
}

/** Minimal SDK view: re-read the creator. `PaseoApi` is structurally assignable. */
export interface PairingPaseo {
  agents: {
    ref(agentId: string): { refresh(): Promise<{ agent: { provider?: string | null } } | null> };
  };
}

export type RolePairingOutcome = "not-checked" | "paired" | "mismatch" | "unreadable";

/**
 * Checks a newly created agent against the pairing rule and raises the alert
 * on a mismatch. A creator Paseo cannot return costs one log line, never an
 * alert: an unknown creator is not evidence of a broken rule. Never throws.
 */
export async function checkRolePairing(
  agent: PairingAgent,
  paseo: PairingPaseo | null | undefined,
  deps: RolePairingDeps = {},
): Promise<RolePairingOutcome> {
  const log = deps.log ?? ((message: string) => console.warn(message));
  const rule = pairingRuleFor(agent);
  if (rule === null) return "not-checked";
  const { creatorId } = rule;
  let creatorProvider: string | null;
  try {
    if (!paseo) throw new Error("no Paseo handle");
    const snapshot = (await paseo.agents.ref(creatorId).refresh())?.agent ?? null;
    if (snapshot === null) throw new Error("Paseo returned no snapshot for it");
    creatorProvider = typeof snapshot.provider === "string" && snapshot.provider.trim() !== "" ? snapshot.provider : null;
  } catch (error) {
    log(
      `[paseo-bm] could not check who created ${agent.id}: reading its creator ${creatorId} failed (${error instanceof Error ? error.message : String(error)}).`,
    );
    return "unreadable";
  }
  const mismatch = rolePairingMismatch(agent, creatorProvider);
  if (mismatch === null) return "paired";
  await raiseRolePairingAlert(mismatch, { ...deps, log });
  return "mismatch";
}
