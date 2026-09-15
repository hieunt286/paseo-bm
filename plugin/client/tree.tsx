/**
 * "Beads agents" workspace panel (WP-113): the Manager -> Worker -> Reviewer
 * tree with per-agent status, polled through `agents.list`, and the role
 * configuration in effect from `roles.describe`.
 *
 * `AgentTreePanel` owns the data (RPC + query); `AgentTreeView` only renders
 * from props and uses no hooks, so it can be rendered in tests without a
 * renderer. Tree building, texts and styles live in `agent-tree.ts`.
 *
 * Read-only: pressing a row opens that agent. There is no stop, archive or
 * delete action; agent lifecycle belongs to the user (ADR-005).
 *
 * Client rules: React Native primitives only, every color from theme.colors,
 * no Node builtin imports.
 */
import { type PluginTheme } from "@getpaseo/plugin";
import { type PluginWorkspacePanelProps, useRpc } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import { ActivityIndicator, Pressable, ScrollView, Text, View } from "react-native";
import { agentsListRpc, rolesDescribeRpc, type AgentNode, type RoleDescriptor } from "../shared/contracts";
import {
  AGENT_TREE_POLL_MS,
  EMPTY_AGENTS_TEXT,
  NO_ROLES_TEXT,
  agentSections,
  buildAgentTree,
  indentFor,
  loadErrorText,
  roleConfigRows,
  treeStyles,
  treeToneColor,
  type TreeStyles,
} from "./agent-tree";

/** Loading state of one RPC, as the view needs it. */
export type Loadable<T> =
  | { status: "pending" }
  | { status: "error"; error: unknown }
  | { status: "success"; data: T };

export interface AgentTreeViewProps {
  theme: PluginTheme;
  compact: boolean;
  agents: Loadable<readonly AgentNode[]>;
  roles: Loadable<readonly RoleDescriptor[]>;
  /** Undefined on hosts without `navigation.openAgent`: rows are then not pressable. */
  openAgent?: (input: { agentId: string }) => void;
  onRetryAgents?: () => void;
  onRetryRoles?: () => void;
}

export function AgentTreePanel({ theme, layout, navigation, workspaceId }: PluginWorkspacePanelProps) {
  const listAgents = useRpc(agentsListRpc);
  const describeRoles = useRpc(rolesDescribeRpc);

  const agents = useQuery({
    queryKey: ["paseo-bm", "agent-tree", "agents", workspaceId],
    queryFn: async () => (await listAgents({ workspaceId })).agents,
    refetchInterval: AGENT_TREE_POLL_MS,
  });
  const roles = useQuery({
    queryKey: ["paseo-bm", "agent-tree", "roles"],
    queryFn: async () => (await describeRoles({})).roles,
  });

  return (
    <AgentTreeView
      theme={theme}
      compact={layout.compact}
      agents={toLoadable(agents)}
      roles={toLoadable(roles)}
      openAgent={navigation?.openAgent}
      onRetryAgents={() => void agents.refetch()}
      onRetryRoles={() => void roles.refetch()}
    />
  );
}

function toLoadable<T>(query: { status: "pending" | "error" | "success"; data: T | undefined; error: unknown }): Loadable<T> {
  // Keep showing the last good data while a background poll fails.
  if (query.data !== undefined) return { status: "success", data: query.data };
  if (query.status === "error") return { status: "error", error: query.error };
  return { status: "pending" };
}

export function AgentTreeView(props: AgentTreeViewProps) {
  const { theme, compact } = props;
  const styles = treeStyles(theme, compact);

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <Text style={styles.heading}>Beads agents</Text>
      {!props.openAgent ? (
        <Text style={[styles.notice, { color: treeToneColor(theme, "warning") }]}>
          This Paseo version cannot open agents from plugins. Update Paseo to open them from here.
        </Text>
      ) : null}
      <AgentsBlock {...props} styles={styles} />

      <Text style={styles.heading}>Role configuration</Text>
      <RolesBlock {...props} styles={styles} />
    </ScrollView>
  );
}

function RetryButton({ label, onPress, styles }: { label: string; onPress?: () => void; styles: TreeStyles }) {
  if (!onPress) return null;
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress} style={styles.button}>
      <Text style={styles.buttonText}>Retry</Text>
    </Pressable>
  );
}

function AgentsBlock({ theme, compact, agents, openAgent, onRetryAgents, styles }: AgentTreeViewProps & { styles: TreeStyles }) {
  if (agents.status === "pending") return <ActivityIndicator color={styles.spinner.color} />;
  if (agents.status === "error") {
    return (
      <View style={{ gap: 6 }}>
        <Text accessibilityLiveRegion="polite" style={[styles.notice, { color: treeToneColor(theme, "danger") }]}>
          {loadErrorText("agents", agents.error)}
        </Text>
        <RetryButton label="Retry loading agents" onPress={onRetryAgents} styles={styles} />
      </View>
    );
  }

  const sections = agentSections(buildAgentTree(agents.data));
  if (sections.length === 0) return <Text style={styles.body}>{EMPTY_AGENTS_TEXT}</Text>;

  return (
    <View style={{ gap: compact ? 8 : 12 }}>
      {sections.map((section) => (
        <View key={section.key} style={{ gap: 6 }}>
          <Text style={styles.sectionTitle}>{section.title}</Text>
          {section.rows.map((row) => {
            const content = (
              <>
                <View style={{ flexShrink: 1 }}>
                  <Text style={styles.rowTitle}>{row.label}</Text>
                  <Text style={styles.rowRole}>{row.roleLabel}</Text>
                </View>
                <Text style={[styles.rowStatus, { color: treeToneColor(theme, row.statusTone) }]}>{row.status}</Text>
              </>
            );
            const indent = { marginLeft: indentFor(row.depth, compact) };
            return openAgent ? (
              <Pressable
                key={row.agentId}
                accessibilityRole="button"
                accessibilityLabel={row.accessibilityLabel}
                onPress={() => openAgent({ agentId: row.agentId })}
                style={({ pressed }) => [styles.row, indent, pressed ? styles.rowPressed : null]}
              >
                {content}
              </Pressable>
            ) : (
              <View key={row.agentId} style={[styles.row, indent]}>
                {content}
              </View>
            );
          })}
        </View>
      ))}
    </View>
  );
}

function RolesBlock({ theme, roles, onRetryRoles, styles }: AgentTreeViewProps & { styles: TreeStyles }) {
  if (roles.status === "pending") return <ActivityIndicator color={styles.spinner.color} />;
  if (roles.status === "error") {
    return (
      <View style={{ gap: 6 }}>
        <Text accessibilityLiveRegion="polite" style={[styles.notice, { color: treeToneColor(theme, "danger") }]}>
          {loadErrorText("role configuration", roles.error)}
        </Text>
        <RetryButton label="Retry loading role configuration" onPress={onRetryRoles} styles={styles} />
      </View>
    );
  }

  const rows = roleConfigRows(roles.data);
  if (rows.length === 0) {
    return <Text style={[styles.notice, { color: treeToneColor(theme, "warning") }]}>{NO_ROLES_TEXT}</Text>;
  }

  return (
    <View style={{ gap: 8 }}>
      {rows.map((row) => (
        <View key={row.role} style={styles.card}>
          <Text style={styles.rowTitle}>{row.role}</Text>
          {row.fields.map((field) => (
            <View key={field.label} style={styles.field}>
              <Text style={styles.fieldLabel}>{field.label}</Text>
              <Text selectable style={styles.fieldValue}>
                {field.value}
              </Text>
            </View>
          ))}
        </View>
      ))}
    </View>
  );
}
