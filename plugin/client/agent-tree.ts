/**
 * Logic behind the "Beads agents" workspace panel (WP-113, design §2.2, §5, §8,
 * REQ-025a, REQ-032d). Pure: no React, no React Native, no JSX, so it is
 * testable without a renderer. `tree.tsx` renders from it.
 *
 * Paseo 0.8 facts this is built on (checked against @getpaseo/plugin 0.8.0
 * `dist/client/contracts.d.ts`, not guessed):
 * - `addWorkspacePanel({ id, title, icon, context: "workspace", Component })`;
 *   the component receives `workspaceId` directly (unlike a surface), plus
 *   `theme`, `layout` and the optional `navigation.openAgent`.
 *
 * Read-only by design (ADR-005): the panel lists and opens agents. It offers no
 * way to stop, archive or delete one.
 */
import type { PluginTheme } from "@getpaseo/plugin";
import type { AgentNode, RoleDescriptor } from "../shared/contracts";
import { errorCodeOf, errorMessageOf, type NoticeTone } from "./launch-manager";

/** Workspace panel id. */
export const AGENT_TREE_PANEL_ID = "beads-agents";

/** Lucide icon name (lucide.dev/icons/list-tree). */
export const AGENT_TREE_ICON = "ListTree";

/**
 * How often the panel re-reads `agents.list`. The design says the tree is
 * polled (§2.4) but fixes no interval; this value is a placeholder pending an
 * owner decision (see the WP-113 panel report).
 */
export const AGENT_TREE_POLL_MS = 5000;

// ---------------------------------------------------------------------------
// Tree building.
// ---------------------------------------------------------------------------

export interface AgentTreeNode {
  agent: AgentNode;
  children: AgentTreeNode[];
}

export interface AgentTree {
  /** Roots whose role is `manager`, each with its descendants. */
  managers: AgentTreeNode[];
  /**
   * Every other root: an orphaned Worker or Reviewer (its Manager deleted or
   * archived) or an unlabeled root agent. Shown in a separate branch, never hidden.
   */
  withoutManager: AgentTreeNode[];
}

/**
 * Builds the tree from the flat `agents.list` output, keeping its order.
 *
 * Defensive beyond the contract: a `parentId` that names no listed agent, or
 * that would close a cycle, makes the agent a root instead of dropping it, and
 * a duplicated id is shown once.
 */
export function buildAgentTree(agents: readonly AgentNode[]): AgentTree {
  const byId = new Map<string, AgentNode>();
  for (const agent of agents) if (!byId.has(agent.id)) byId.set(agent.id, agent);

  // An agent is a root when its parent chain does not reach a listed agent
  // without looping back to itself.
  const parentOf = (agent: AgentNode): string | null => {
    const parentId = agent.parentId;
    if (parentId === null || parentId === agent.id || !byId.has(parentId)) return null;
    const seen = new Set<string>([agent.id]);
    for (let cursor: string | null = parentId; cursor !== null; ) {
      if (seen.has(cursor)) return null;
      seen.add(cursor);
      const next: AgentNode | undefined = byId.get(cursor);
      cursor = next && next.parentId !== null && byId.has(next.parentId) ? next.parentId : null;
    }
    return parentId;
  };

  const childrenOf = new Map<string, AgentNode[]>();
  const roots: AgentNode[] = [];
  for (const agent of byId.values()) {
    const parentId = parentOf(agent);
    if (parentId === null) roots.push(agent);
    else childrenOf.set(parentId, [...(childrenOf.get(parentId) ?? []), agent]);
  }

  const toNode = (agent: AgentNode): AgentTreeNode => ({
    agent,
    children: (childrenOf.get(agent.id) ?? []).map(toNode),
  });

  return {
    managers: roots.filter((agent) => agent.role === "manager").map(toNode),
    withoutManager: roots.filter((agent) => agent.role !== "manager").map(toNode),
  };
}

// ---------------------------------------------------------------------------
// Rows the panel renders.
// ---------------------------------------------------------------------------

export interface AgentRow {
  agentId: string;
  depth: number;
  roleLabel: string;
  /** Title, or a placeholder when the agent has none. */
  label: string;
  status: string;
  statusTone: StatusTone;
  /** Screen-reader text for the row's open action. */
  accessibilityLabel: string;
}

export interface AgentSection {
  key: "managers" | "without-manager";
  title: string;
  rows: AgentRow[];
}

export type StatusTone = "success" | "accent" | "muted" | "warning" | "danger";

const ROLE_LABELS: Record<AgentNode["role"], string> = {
  manager: "Manager",
  worker: "Worker",
  reviewer: "Reviewer",
  unknown: "Unknown role",
};

export function roleLabel(role: string): string {
  return role in ROLE_LABELS ? ROLE_LABELS[role as AgentNode["role"]] : ROLE_LABELS.unknown;
}

/** Tone for a Paseo agent status (`initializing | idle | running | error | closed`). */
export function statusTone(status: string): StatusTone {
  switch (status) {
    case "running":
      return "accent";
    case "idle":
      return "success";
    case "initializing":
      return "warning";
    case "error":
      return "danger";
    default:
      return "muted";
  }
}

function agentLabel(agent: AgentNode): string {
  const title = agent.title?.trim();
  return title ? title : `Untitled agent (${agent.id})`;
}

/**
 * The role text of a row: `Manager`, or `Manager · no label` for a paseo-bm
 * agent with no valid `bm.role` label — started outside Beads Manager and
 * recognised by its provider (delta 20260918g §4.4). An `Unknown role` row
 * already says as much, so it gets no mark. An agent a fallback agent took
 * over from reads `· replaced by <id>`, whatever its role (delta 20260921 §4.4.8).
 */
export function rowRoleLabel(agent: Pick<AgentNode, "role" | "labelled"> & { replacedBy?: string | null }): string {
  const role = roleLabel(agent.role);
  const label = agent.labelled === false && agent.role !== "unknown" ? `${role} · no label` : role;
  return agent.replacedBy ? `${label} · replaced by ${agent.replacedBy}` : label;
}

function flatten(nodes: readonly AgentTreeNode[], depth: number, out: AgentRow[]): AgentRow[] {
  for (const { agent, children } of nodes) {
    const label = agentLabel(agent);
    const role = rowRoleLabel(agent);
    out.push({
      agentId: agent.id,
      depth,
      roleLabel: role,
      label,
      status: agent.status,
      statusTone: statusTone(agent.status),
      accessibilityLabel: `Open ${role} ${label}, status ${agent.status}`,
    });
    flatten(children, depth + 1, out);
  }
  return out;
}

/** Sections in display order; a section with no rows is omitted. */
export function agentSections(tree: AgentTree): AgentSection[] {
  const sections: AgentSection[] = [
    { key: "managers", title: "Managers", rows: flatten(tree.managers, 0, []) },
    { key: "without-manager", title: "Without a Manager", rows: flatten(tree.withoutManager, 0, []) },
  ];
  return sections.filter((section) => section.rows.length > 0);
}

export const EMPTY_AGENTS_TEXT =
  "No Beads agents in this workspace yet. Open Beads Manager to start one.";

// ---------------------------------------------------------------------------
// Role configuration (roles.describe).
// ---------------------------------------------------------------------------

export interface RoleConfigRow {
  role: string;
  fields: Array<{ label: string; value: string }>;
}

const ROLE_ORDER: Record<string, number> = { manager: 0, worker: 1, reviewer: 2 };

export function roleConfigRows(roles: readonly RoleDescriptor[]): RoleConfigRow[] {
  return [...roles]
    .sort((a, b) => (ROLE_ORDER[a.role] ?? 9) - (ROLE_ORDER[b.role] ?? 9))
    .map((descriptor) => ({
      role: roleLabel(descriptor.role),
      fields: [
        { label: "Provider", value: descriptor.provider || "(not set)" },
        { label: "Model", value: descriptor.model || "(provider default)" },
        { label: "Paseo tools", value: descriptor.paseoTools ? "Granted" : "Not granted" },
        { label: "Instructions", value: descriptor.instructionsPath },
      ],
    }));
}

export const NO_ROLES_TEXT =
  "No role configuration found: paseo-bm is not installed on this host, or its roles are not registered with Paseo. Run `npx paseo-bm doctor`.";

// ---------------------------------------------------------------------------
// Errors.
// ---------------------------------------------------------------------------

/** Error line for a failed RPC, with its registry code when the server sent one. */
export function loadErrorText(what: string, error: unknown): string {
  const code = errorCodeOf(error);
  const message = errorMessageOf(error);
  return code ? `Could not load ${what} (${code}). ${message}` : `Could not load ${what}. ${message}`;
}

// ---------------------------------------------------------------------------
// Presentation: styles from theme.colors only.
// ---------------------------------------------------------------------------

export function treeToneColor(theme: PluginTheme, tone: StatusTone | NoticeTone): string {
  switch (tone) {
    case "success":
      return theme.colors.statusSuccess;
    case "accent":
      return theme.colors.accent;
    case "muted":
      return theme.colors.foregroundMuted;
    case "warning":
      return theme.colors.statusWarning;
    case "danger":
      return theme.colors.statusDanger;
  }
}

/** Horizontal indent of a tree row per depth level. */
export function indentFor(depth: number, compact: boolean): number {
  return depth * (compact ? 12 : 20);
}

export function treeStyles(theme: PluginTheme, compact: boolean) {
  return {
    screen: { flex: 1, backgroundColor: theme.colors.surface0 },
    content: { padding: compact ? 12 : 20, gap: compact ? 8 : 12 },
    heading: { color: theme.colors.foreground, fontSize: compact ? 16 : 18, fontWeight: "600" as const },
    sectionTitle: { color: theme.colors.foregroundMuted, fontSize: 12, fontWeight: "600" as const },
    body: { color: theme.colors.foregroundMuted, fontSize: 13 },
    notice: { fontSize: 13 },
    row: {
      flexDirection: compact ? ("column" as const) : ("row" as const),
      alignItems: compact ? ("flex-start" as const) : ("center" as const),
      justifyContent: "space-between" as const,
      gap: compact ? 2 : 12,
      paddingVertical: compact ? 8 : 10,
      paddingHorizontal: compact ? 10 : 12,
      borderRadius: 8,
      borderWidth: 1,
      borderColor: theme.colors.border,
      backgroundColor: theme.colors.surface1,
    },
    rowPressed: { backgroundColor: theme.colors.surface2 },
    rowTitle: { color: theme.colors.foreground, fontSize: 14 },
    rowRole: { color: theme.colors.foregroundMuted, fontSize: 12 },
    rowStatus: { fontSize: 12 },
    card: {
      gap: 4,
      padding: compact ? 10 : 12,
      borderRadius: 8,
      borderWidth: 1,
      borderColor: theme.colors.border,
      backgroundColor: theme.colors.surface1,
    },
    field: {
      flexDirection: compact ? ("column" as const) : ("row" as const),
      gap: compact ? 0 : 8,
    },
    fieldLabel: { color: theme.colors.foregroundMuted, fontSize: 12, minWidth: compact ? 0 : 96 },
    fieldValue: { color: theme.colors.foreground, fontSize: 12, flexShrink: 1 },
    button: {
      alignSelf: "flex-start" as const,
      paddingVertical: 6,
      paddingHorizontal: 12,
      borderRadius: 6,
      backgroundColor: theme.colors.accent,
    },
    buttonText: { color: theme.colors.accentForeground, fontSize: 13 },
    spinner: { color: theme.colors.foregroundMuted },
  };
}

export type TreeStyles = ReturnType<typeof treeStyles>;
