/**
 * Insights (experience concept §4.3, autonomy design §A.12): how requests flow
 * and what they cost, from `insights.summary` (the metric module over the
 * plugin's own data folder), the Beads figures of one project, and what
 * Phases 2 and 3 add. What it shows is `insights-model.ts`; this file reads the
 * data and draws it.
 *
 * Read once when shown and on Refresh — never polled: the figures move by the
 * day, not by the second.
 *
 * Client rules: React Native primitives only, colours from the theme
 * (`toneColor`), accessibility roles and labels on every pressable, project
 * names only (no ids).
 */
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState, type ReactNode } from "react";
import { ActivityIndicator, Pressable, ScrollView, Text, View } from "react-native";
import { beadsListRpc, insightsSummaryRpc, type InsightsWindow } from "../shared/contracts";
import { dashboardStyles, toneColor } from "./dashboard-model";
import {
  ALL_PROJECTS,
  INSIGHTS_DEFAULT_WINDOW,
  PHASE_PLACEHOLDERS,
  WINDOW_TABS,
  beadsFiguresView,
  insightsView,
  projectTabs,
  scopeLine,
  type BeadsFiguresView,
  type InsightsProject,
  type InsightsView,
} from "./insights-model";
import { errorMessageOf } from "./launch-manager";
import { BarChart, StatCards, StatusTabs, type Styles, type Theme } from "./ui";

/** Figures change slowly; a read stays good for a minute. */
const INSIGHTS_STALE_MS = 60_000;

export const insightsQueryKey = (window: InsightsWindow, projectId: string) => ["paseo-bm", "insights", window, projectId] as const;

/** The flow and cost part: cards, the per-day and per-role charts, and what was not counted. Hook-free. */
export function InsightsFigures({ view, styles }: { view: InsightsView; styles: Styles }) {
  if (view.empty !== null) return <Text style={styles.body}>{view.empty}</Text>;
  return (
    <>
      <Text style={styles.sectionTitle}>Flow</Text>
      <StatCards cards={view.flow} styles={styles} />
      <BarChart title={view.perDayTitle} bars={view.requestsPerDay} styles={styles} labelWidth={50} />

      <Text style={styles.sectionTitle}>Cost</Text>
      <StatCards cards={view.cost} styles={styles} />
      <BarChart title="Tokens per request by role" bars={view.tokensByRole} styles={styles} labelWidth={100} />

      {view.unknowns === null ? null : <Text style={styles.body}>{view.unknowns}</Text>}
    </>
  );
}

/** The Beads part: one project's overview, as the Beads screen used to open with it. Hook-free. */
export function BeadsFigures({ view, styles, theme }: { view: BeadsFiguresView; styles: Styles; theme: Theme }) {
  if (view.kind === "choose") return <Text style={styles.body}>{view.text}</Text>;
  if (view.kind === "loading") return <ActivityIndicator color={styles.spinner.color} />;
  if (view.kind === "error") return <Text style={[styles.body, { color: toneColor(theme, "danger") }]}>{view.text}</Text>;
  const { overview, done } = view;
  return (
    <>
      <StatCards cards={overview.status} styles={styles} />
      <View style={styles.card} accessibilityLabel={done.label}>
        <Text style={styles.sectionTitle}>Progress</Text>
        <View style={styles.barTrack}>
          <View style={[styles.barFill, { width: `${Math.round(overview.progress.share * 100)}%` }]} />
        </View>
        <Text style={styles.body}>{overview.progress.label}</Text>
      </View>
      <View style={styles.cards}>
        <BarChart title="By type" bars={overview.byType} styles={styles} labelWidth={70} />
        <BarChart title="By priority" bars={overview.byPriority} styles={styles} labelWidth={70} />
      </View>
      <StatCards cards={overview.timing} styles={styles} />
    </>
  );
}

/** Autonomy and review lift: what arrives, and with which phase. Hook-free. */
export function PhasePlaceholders({ styles }: { styles: Styles }) {
  return (
    <>
      {PHASE_PLACEHOLDERS.map((placeholder) => (
        <View key={placeholder.key} style={styles.card}>
          <Text style={styles.sectionTitle}>{placeholder.title}</Text>
          <Text style={styles.body}>{placeholder.text}</Text>
        </View>
      ))}
    </>
  );
}

export interface InsightsBodyProps {
  window: InsightsWindow;
  projectId: string;
  projects: readonly InsightsProject[];
  /** Null until the summary has been read once. */
  view: InsightsView | null;
  loading: boolean;
  error: string | null;
  beads: BeadsFiguresView;
  onWindow: (window: InsightsWindow) => void;
  onProject: (projectId: string) => void;
  onRefresh: () => void;
  status?: ReactNode;
  styles: Styles;
  theme: Theme;
}

/** The whole screen but its data: the choices, then Flow, Cost, Beads and what comes. Hook-free. */
export function InsightsBody(props: InsightsBodyProps) {
  const { window, projectId, projects, view, loading, error, beads, styles, theme } = props;
  const projectLabel = projects.find((project) => project.id === projectId)?.label ?? null;
  return (
    <>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
        <Text style={[styles.title, { flex: 1 }]} numberOfLines={1}>
          Insights
        </Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Refresh the figures"
          onPress={props.onRefresh}
          style={styles.secondaryButton}
        >
          <Text style={styles.secondaryButtonText}>Refresh</Text>
        </Pressable>
      </View>
      {props.status}
      <StatusTabs tabs={WINDOW_TABS} selected={window} onSelect={(key) => props.onWindow(key as InsightsWindow)} styles={styles} />
      <StatusTabs tabs={projectTabs(projects)} selected={projectId} onSelect={props.onProject} styles={styles} />
      <Text style={styles.body}>{scopeLine(window, projectLabel)}</Text>

      {loading && view === null ? <ActivityIndicator color={styles.spinner.color} /> : null}
      {error === null ? null : <Text style={[styles.body, { color: toneColor(theme, "danger") }]}>{`Could not read the figures. ${error}`}</Text>}
      {view === null ? null : <InsightsFigures view={view} styles={styles} />}

      <Text style={styles.sectionTitle}>Beads</Text>
      <BeadsFigures view={beads} styles={styles} theme={theme} />

      <PhasePlaceholders styles={styles} />
    </>
  );
}

export interface InsightsScreenProps extends PluginSurfaceProps {
  /** Projects the surface knows by name: open workspaces first, then closed ones with history. */
  projects: readonly InsightsProject[];
  status?: ReactNode;
}

export function InsightsScreen({ theme, layout, projects, status }: InsightsScreenProps) {
  const styles = useMemo(() => dashboardStyles(theme, layout.compact), [theme, layout.compact]);
  const [window, setWindow] = useState<InsightsWindow>(INSIGHTS_DEFAULT_WINDOW);
  const [projectId, setProjectId] = useState<string>(ALL_PROJECTS);
  const readSummary = useRpc(insightsSummaryRpc);
  const listBeads = useRpc(beadsListRpc);
  const summary = useQuery({
    queryKey: insightsQueryKey(window, projectId),
    queryFn: () => readSummary(projectId === ALL_PROJECTS ? { window } : { window, workspaceId: projectId }),
    staleTime: INSIGHTS_STALE_MS,
  });
  // The Beads screen's own query: a project's beads read here are its beads there.
  const beads = useQuery({
    queryKey: ["paseo-bm", "beads-list", projectId],
    queryFn: () => listBeads({ workspaceId: projectId }),
    enabled: projectId !== ALL_PROJECTS,
  });
  const now = new Date();
  const view = summary.data === undefined ? null : insightsView(summary.data, now);
  const beadsView = beadsFiguresView(projectId, beads.data, beads.isError ? errorMessageOf(beads.error) : null, now);

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <InsightsBody
        window={window}
        projectId={projectId}
        projects={projects}
        view={view}
        loading={summary.isPending}
        error={summary.isError ? errorMessageOf(summary.error) : null}
        beads={beadsView}
        onWindow={setWindow}
        onProject={setProjectId}
        onRefresh={() => {
          void summary.refetch();
          if (projectId !== ALL_PROJECTS) void beads.refetch();
        }}
        status={status}
        styles={styles}
        theme={theme}
      />
    </ScrollView>
  );
}
