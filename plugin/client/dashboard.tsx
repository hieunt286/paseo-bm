/**
 * The Beads Dashboard (WP-211.2.1; REQ-040 → REQ-046, REQ-048d, REQ-055).
 *
 * Layout, top to bottom:
 * 1. overview cards — requests, beads, agents, messages, tokens, cost;
 * 2. three small bar charts — requests per day, the five heaviest Workers
 *    (press one to open it), tokens by model × role;
 * 3. requests as graphs — Manager → Workers → Reviewers, each marked with a
 *    small role icon; tap a request to open its graph, tap a node to expand
 *    what it sent, got back and cost;
 * 4. storage and the privacy note.
 *
 * The destructive flows live in `dashboard-actions.tsx`. All wording and
 * numbers come from `dashboard-model.ts`, tested without a renderer.
 *
 * Client rules: React Native primitives only, colours from `theme.colors`, no
 * Node import, no `server/` import.
 */
import { type PluginSurfaceProps, useRpc, useSettings } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, Text, View } from "react-native";
import { beadsStatsRpc, tracesGetRpc, tracesListRpc, type TraceSummary } from "../shared/contracts";
import { DEFAULT_WARN_ABOVE_BYTES, dashboardSettings } from "../shared/settings";
import { TraceActions } from "./dashboard-actions";
import {
  PRIVACY_NOTICE,
  dashboardStyles,
  groupTraces,
  heaviestWorkers,
  overviewCards,
  tokensByModelRole,
  requestGraph,
  requestsPerDay,
  storageView,
  toneColor,
  type Badge,
  type ChipGroup,
  type GraphNode,
} from "./dashboard-model";
import { errorMessageOf } from "./launch-manager";
import { BarChart, Chip, RoleLegend, RoleMark, StatCards, type Styles, type Theme } from "./ui";

export interface DashboardProps extends PluginSurfaceProps {
  workspaceId: string;
  /** Omitted inside the workspace's own "Beads" tab: the tab already says where it is. */
  workspaceLabel?: string;
  /** Omitted inside the "Beads" tab, which has no screen to go back to. */
  onBack?: () => void;
}


function BadgeText({ badge, styles, theme }: { badge: Badge; styles: Styles; theme: Theme }) {
  return <Text style={[styles.badge, { color: toneColor(theme, badge.tone) }]}>{badge.text}</Text>;
}

function Chips({ group, styles, theme }: { group: ChipGroup; styles: Styles; theme: Theme }) {
  return (
    <View style={{ gap: 4 }}>
      <Text style={styles.body}>{group.label}</Text>
      <View style={styles.chipRow}>
        {group.chips.map((chip) => (
          <Chip key={chip.text} badge={chip} styles={styles} theme={theme} />
        ))}
      </View>
      {group.note === undefined ? null : <Text style={[styles.body, { fontSize: 11 }]}>{group.note}</Text>}
    </View>
  );
}

interface NodeViewProps {
  node: GraphNode;
  open: boolean;
  onToggle: (id: string) => void;
  styles: Styles;
  theme: Theme;
  navigation: PluginSurfaceProps["navigation"];
}

function NodeView({ node, open, onToggle, styles, theme, navigation }: NodeViewProps) {
  const label = node.kind === "request" ? "Manager · request details" : `${node.title} · ${node.subtitle}`;
  return (
    <View style={styles.node}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityState={{ expanded: open }}
        onPress={() => onToggle(node.id)}
      >
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <Text style={styles.body}>{open ? "▾" : "▸"}</Text>
          <RoleMark kind={node.kind} theme={theme} />
          <Text style={[styles.body, { flex: 1 }]}>{label}</Text>
          {node.kind === "request" ? null : <BadgeText badge={node.badge} styles={styles} theme={theme} />}
        </View>
      </Pressable>
      {open ? (
        <View style={{ gap: 2 }}>
          {node.details.length === 0 && node.chipGroups.length === 0 ? <Text style={styles.body}>Loading…</Text> : null}
          {node.chipGroups.map((group) => (
            <Chips key={group.label} group={group} styles={styles} theme={theme} />
          ))}
          {node.details.map((line, index) => (
            <Text key={`${node.id}-${index}`} style={styles.body} selectable>
              {line}
            </Text>
          ))}
          {node.agentId !== null && navigation?.openAgent !== undefined ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Open ${node.title}`}
              onPress={() => navigation.openAgent({ agentId: node.agentId! })}
              style={[styles.secondaryButton, { alignSelf: "flex-start" }]}
            >
              <Text style={styles.secondaryButtonText}>Open agent</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

interface RequestCardProps {
  trace: TraceSummary;
  workspaceId: string;
  styles: Styles;
  theme: Theme;
  layout: PluginSurfaceProps["layout"];
  navigation: PluginSurfaceProps["navigation"];
  onChanged: () => void;
}

function RequestCard({ trace, workspaceId, styles, theme, layout, navigation, onChanged }: RequestCardProps) {
  const getTrace = useRpc(tracesGetRpc);
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());

  // The detail is fetched only once the request is opened.
  const detail = useQuery({
    queryKey: ["paseo-bm", "trace", workspaceId, trace.traceId],
    queryFn: () => getTrace({ workspaceId, traceId: trace.traceId }),
    enabled: open,
  });

  const [root, ...children] = requestGraph(trace, detail.data?.trace ?? null, new Date());
  const toggle = (id: string) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <View style={styles.card}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Request: ${root!.title}`}
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen(!open)}
      >
        <View style={{ flexDirection: "row", justifyContent: "space-between", gap: 8 }}>
          <View style={{ flex: 1, gap: 2 }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              <RoleMark kind="request" theme={theme} />
              <Text style={[styles.mono, { flex: 1 }]} numberOfLines={open ? undefined : 1}>
                {`${open ? "▾" : "▸"} ${root!.title}`}
              </Text>
            </View>
            <Text style={styles.body}>{root!.subtitle}</Text>
          </View>
          <BadgeText badge={root!.badge} styles={styles} theme={theme} />
        </View>
      </Pressable>

      {open ? (
        <View style={{ gap: 2 }}>
          {detail.isPending ? <ActivityIndicator color={styles.spinner.color} /> : null}
          {detail.isError ? (
            <Text style={[styles.body, { color: toneColor(theme, "danger") }]}>{errorMessageOf(detail.error)}</Text>
          ) : null}
          <NodeView node={root!} open={expanded.has(root!.id)} onToggle={toggle} styles={styles} theme={theme} navigation={navigation} />
          {children.map((node) => (
            <View key={node.id} style={{ marginLeft: node.depth * (layout.compact ? 12 : 20) }}>
              <NodeView node={node} open={expanded.has(node.id)} onToggle={toggle} styles={styles} theme={theme} navigation={navigation} />
            </View>
          ))}
          {expanded.has(root!.id) ? (
            <TraceActions
              theme={theme}
              layout={layout}
              styles={styles}
              workspaceId={workspaceId}
              scope="trace"
              traceId={trace.traceId}
              onDone={onChanged}
            />
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

export function DashboardPanel({ theme, layout, navigation, workspaceId, workspaceLabel, onBack }: DashboardProps) {
  const styles = useMemo(() => dashboardStyles(theme, layout.compact), [theme, layout.compact]);
  const listTraces = useRpc(tracesListRpc);
  const beadStats = useRpc(beadsStatsRpc);
  const settings = useSettings(dashboardSettings);
  const [showStorage, setShowStorage] = useState(false);

  const traces = useQuery({
    queryKey: ["paseo-bm", "traces", workspaceId],
    queryFn: () => listTraces({ workspaceId }),
  });
  const beads = useQuery({
    queryKey: ["paseo-bm", "beads", workspaceId],
    queryFn: () => beadStats({ workspaceId }),
  });

  const rows = traces.data?.traces ?? [];
  const warnAboveBytes =
    settings.status === "ready" ? settings.values.warnAboveBytes : DEFAULT_WARN_ABOVE_BYTES;
  const storage = traces.data === undefined ? null : storageView(traces.data.store, warnAboveBytes);
  const refresh = () => {
    void traces.refetch();
    void beads.refetch();
  };

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
        {onBack === undefined ? null : (
          <Pressable accessibilityRole="button" accessibilityLabel="Back to Beads Manager" onPress={onBack} style={styles.secondaryButton}>
            <Text style={styles.secondaryButtonText}>←</Text>
          </Pressable>
        )}
        {workspaceLabel === undefined ? (
          <View style={{ flex: 1 }} />
        ) : (
          <Text style={[styles.title, { flex: 1 }]} numberOfLines={1}>{`Metric · ${workspaceLabel}`}</Text>
        )}
        <Pressable accessibilityRole="button" accessibilityLabel="Refresh" onPress={refresh} style={styles.secondaryButton}>
          <Text style={styles.secondaryButtonText}>Refresh</Text>
        </Pressable>
      </View>

      {/* 1. Overview */}
      <StatCards cards={overviewCards(rows, beads.data?.stats ?? null)} styles={styles} />
      {storage?.warning != null ? (
        <Text style={[styles.body, { color: toneColor(theme, storage.warning.tone) }]}>{storage.warning.text}</Text>
      ) : null}

      {/* 2. Charts */}
      {rows.length > 0 ? (
        <View style={styles.cards}>
          {/* The list has one row per question; this chart counts requests (Q27). */}
          <BarChart
            title="Requests, last 7 days — each request counted once"
            bars={requestsPerDay(rows, new Date())}
            styles={styles}
          />
          <BarChart
            title="Top 5 heaviest Workers (tokens)"
            bars={heaviestWorkers(rows)}
            styles={styles}
            onOpen={navigation?.openAgent === undefined ? undefined : (agentId) => navigation.openAgent({ agentId })}
          />
          {/* Which model each role actually ran on (delta 20260918, REQ-058e). */}
          <BarChart title="Tokens by model × role" bars={tokensByModelRole(rows)} styles={styles} labelWidth={180} />
        </View>
      ) : null}

      {/* 3. Requests as graphs */}
      {rows.length > 0 ? <RoleLegend styles={styles} theme={theme} /> : null}
      {traces.isPending ? <ActivityIndicator color={styles.spinner.color} /> : null}
      {traces.isError ? (
        <Text style={[styles.body, { color: toneColor(theme, "danger") }]}>{errorMessageOf(traces.error)}</Text>
      ) : null}
      {traces.data !== undefined && rows.length === 0 ? (
        <Text style={styles.body}>No requests recorded yet. They appear once you ask the Beads Manager for something.</Text>
      ) : null}
      {traces.data?.notices.map((notice) => (
        <Text key={notice} style={[styles.body, { color: toneColor(theme, "warning") }]}>
          {notice}
        </Text>
      ))}
      {groupTraces(rows).map((group) => (
        <View key={group.key} style={{ gap: layout.compact ? 6 : 8 }}>
          <Text style={styles.sectionTitle}>{group.title}</Text>
          {group.hint === null ? null : <Text style={styles.body}>{group.hint}</Text>}
          {group.traces.map((trace) => (
            <RequestCard
              key={`${trace.traceId}#${trace.turn?.index ?? 1}`}
              trace={trace}
              workspaceId={workspaceId}
              styles={styles}
              theme={theme}
              layout={layout}
              navigation={navigation}
              onChanged={refresh}
            />
          ))}
        </View>
      ))}
      {traces.data?.truncated === true ? <Text style={styles.body}>Older requests are not shown.</Text> : null}

      {/* 4. Storage, folded away */}
      <Pressable accessibilityRole="button" accessibilityState={{ expanded: showStorage }} onPress={() => setShowStorage(!showStorage)}>
        <Text style={styles.body}>{`${showStorage ? "▾" : "▸"} Storage${storage === null ? "" : ` · ${storage.summary}`}`}</Text>
      </Pressable>
      {showStorage ? (
        <View style={styles.card}>
          <TraceActions
            theme={theme}
            layout={layout}
            styles={styles}
            workspaceId={workspaceId}
            scope="workspace"
            workspaceState={rows[0]?.workspaceState}
            onDone={refresh}
          />
        </View>
      ) : null}
      <Text style={[styles.body, { color: toneColor(theme, "muted") }]}>{PRIVACY_NOTICE}</Text>
    </ScrollView>
  );
}
