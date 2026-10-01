/**
 * A project's Metrics tab (change-014 outcome 5; the Insights section until
 * then — experience concept §4.3, autonomy design §A.12): how the project's
 * requests flow, what they cost and how the Orchestrator's interventions
 * turned out (A-12, §G.3), from `insights.summary` for the workspace (the
 * metric module over the plugin's own data folder); its Beads figures; its
 * autonomy by class — the agreement ledger (`autonomy.ledger`) with each
 * class's mode (`autonomy.policy`, §B.3), read only (ADR-025: autonomy is the
 * project's level, set in Settings) —; and review lift per size of request
 * (§C.4). Cost ends with the tokens read per request and the heaviest
 * requests (§G.2). What it shows is `insights-model.ts`; this file reads the
 * data and draws it.
 *
 * Read once when shown and on Refresh — never polled: the figures move by the
 * day, not by the second.
 *
 * Client rules: React Native primitives only, colours from the theme
 * (`toneColor`), accessibility roles and labels on every pressable, project
 * names only (no ids).
 */
import { useRpc } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { ActivityIndicator, ScrollView, Text, View } from "react-native";
import { autonomyLedgerRpc, autonomyPolicyRpc, beadsListRpc, insightsSummaryRpc, type InsightsWindow } from "../shared/contracts";
import { dashboardStyles } from "./styles";
import { toneColor } from "./tone";
import {
  AUTONOMY_NOTE,
  AUTONOMY_TITLE,
  COORDINATION_EMPTY,
  HEAVIEST_TITLE,
  COORDINATION_NOTE,
  INSIGHTS_DEFAULT_WINDOW,
  REVIEW_LIFT_NOTE,
  REVIEW_LIFT_TITLE,
  WINDOW_TABS,
  autonomyFiguresView,
  beadsFiguresView,
  insightsView,
  scopeLine,
  type AgreementFiguresView,
  type AutonomyClassRowView,
  type AutonomyFiguresView,
  type BeadsFiguresView,
  type HeavyRequestView,
  type InsightsView,
  type RequestTokensView,
  type ReviewLiftView,
  type ReviewTierRowView,
} from "./insights-model";
import { errorMessageOf } from "./errors";
import { AUTONOMY_POLICY_KEY } from "./settings-autonomy-model";
import { BarChart, Button, StatCards, StatusTabs, ToneText, type Styles, type Theme } from "./ui";

/** Figures change slowly; a read stays good for a minute. */
export const INSIGHTS_STALE_MS = 60_000;

export const insightsQueryKey = (window: InsightsWindow, projectId: string) => ["paseo-bm", "insights", window, projectId] as const;

/** One project's agreement ledger; the window is not part of it (§B.4 judges every answer). */
export const autonomyLedgerQueryKey = (projectId: string) => ["paseo-bm", "autonomy", "ledger", projectId] as const;

/** One of the heaviest requests: two lines on a phone, one row on a wide screen. Hook-free. */
export function HeavyRequestRow({ row, compact, styles }: { row: HeavyRequestView; compact: boolean; styles: Styles }) {
  const project = (
    <Text style={[styles.body, { fontWeight: "600", flexShrink: 1, flex: compact ? undefined : 1 }]} numberOfLines={1}>
      {row.project}
    </Text>
  );
  const tokens = <Text style={[styles.body, { fontWeight: "600" }]}>{row.tokens}</Text>;
  if (compact) {
    return (
      <View style={{ gap: 1 }} accessibilityLabel={row.accessibilityLabel}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          {project}
          <View style={{ flex: 1 }} />
          {tokens}
        </View>
        <Text style={styles.body}>{row.detail}</Text>
      </View>
    );
  }
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }} accessibilityLabel={row.accessibilityLabel}>
      {project}
      <Text style={styles.body}>{row.detail}</Text>
      <View style={{ minWidth: 90, alignItems: "flex-end" }}>{tokens}</View>
    </View>
  );
}

/** Tokens read per request (its spread) and the heaviest requests, under Cost. Hook-free. */
export function RequestTokens({ view, compact, styles }: { view: RequestTokensView; compact: boolean; styles: Styles }) {
  if (view.empty !== null) return <Text style={styles.body}>{view.empty}</Text>;
  return (
    <>
      <BarChart title={view.distributionTitle} bars={view.distribution} styles={styles} labelWidth={70} />
      {view.heaviest.length === 0 ? null : (
        <View style={[styles.card, { gap: 8 }]}>
          <Text style={styles.sectionTitle}>{HEAVIEST_TITLE}</Text>
          {view.heaviest.map((row) => (
            <HeavyRequestRow key={row.key} row={row} compact={compact} styles={styles} />
          ))}
        </View>
      )}
      {view.notes.map((note) => (
        <Text key={note} style={[styles.body, { fontSize: 11 }]}>
          {note}
        </Text>
      ))}
    </>
  );
}

/** The flow, cost and coordination part: cards, the per-day and per-role charts, and what was not counted. Hook-free. */
export function InsightsFigures({ view, compact = false, styles }: { view: InsightsView; compact?: boolean; styles: Styles }) {
  if (view.empty !== null) return <Text style={styles.body}>{view.empty}</Text>;
  return (
    <>
      <Text style={styles.sectionTitle}>Flow</Text>
      <StatCards cards={view.flow} styles={styles} />
      <BarChart title={view.perDayTitle} bars={view.requestsPerDay} styles={styles} labelWidth={50} />

      <Text style={styles.sectionTitle}>Cost</Text>
      <StatCards cards={view.cost} styles={styles} />
      <BarChart title="Tokens per request by role" bars={view.tokensByRole} styles={styles} labelWidth={100} />
      {view.requestTokens === null ? null : <RequestTokens view={view.requestTokens} compact={compact} styles={styles} />}

      <Text style={styles.sectionTitle}>Coordination</Text>
      <Text style={styles.body}>{COORDINATION_NOTE}</Text>
      {view.coordination.length === 0 ? <Text style={styles.body}>{COORDINATION_EMPTY}</Text> : <StatCards cards={view.coordination} styles={styles} />}

      {view.unknowns === null ? null : <Text style={styles.body}>{view.unknowns}</Text>}
    </>
  );
}

/**
 * The Beads part: one project's overview — status, progress (epics left out),
 * by type, by priority, time — as the Beads screen used to open with it. The
 * one component that draws it (code review 2026-09-30 §5). Hook-free.
 */
export function BeadsFigures({ view, styles, theme }: { view: BeadsFiguresView; styles: Styles; theme: Theme }) {
  if (view.kind === "choose") return <Text style={styles.body}>{view.text}</Text>;
  if (view.kind === "loading") return <ActivityIndicator color={styles.spinner.color} />;
  if (view.kind === "error") return <ToneText tone="danger" styles={styles} theme={theme}>{view.text}</ToneText>;
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

/**
 * One predictor's figures in a class row: two or three short lines on a phone,
 * a column of its own on a wide screen. Hook-free.
 */
function AgreementFigures({ figures, compact, styles, theme }: { figures: AgreementFiguresView; compact: boolean; styles: Styles; theme: Theme }) {
  const strong = [styles.body, { color: toneColor(theme, "plain"), fontWeight: "600" as const }];
  const reversals =
    figures.reversals === null ? null : <ToneText tone={figures.reversalTone} styles={styles} theme={theme}>{figures.reversals}</ToneText>;
  const unread = figures.unread === null ? null : <Text style={[styles.body, { fontSize: 11 }]}>{figures.unread}</Text>;
  if (compact) {
    return (
      <View style={{ gap: 1 }}>
        <Text style={strong}>{`${figures.label} · ${figures.agreement}`}</Text>
        <Text style={styles.body}>{figures.span === null ? figures.count : `${figures.count} · ${figures.span}`}</Text>
        {reversals}
        {unread}
      </View>
    );
  }
  return (
    <View style={{ flex: 1, minWidth: 160, gap: 1 }}>
      <Text style={[styles.body, { fontSize: 11 }]}>{figures.label}</Text>
      <Text style={strong}>{figures.agreement}</Text>
      <Text style={styles.body}>{figures.count}</Text>
      {figures.span === null ? null : <Text style={styles.body}>{figures.span}</Text>}
      {reversals}
      {unread}
    </View>
  );
}

/** One class: its name and mode, then each predictor's figures — stacked on a phone, side by side on a wide screen. Hook-free. */
export function AutonomyClassRow({ row, compact, styles, theme }: { row: AutonomyClassRowView; compact: boolean; styles: Styles; theme: Theme }) {
  return (
    <View style={styles.card} accessibilityLabel={row.accessibilityLabel}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <Text style={[styles.sectionTitle, { flex: 1, minWidth: 120 }]}>{row.label}</Text>
        <ToneText tone={row.modeTone} base={styles.badge} styles={styles} theme={theme}>{row.modeText}</ToneText>
      </View>
      <View style={compact ? { flexDirection: "column", gap: 6 } : { flexDirection: "row", flexWrap: "wrap", gap: 16 }}>
        {row.figures.map((figures) => (
          <AgreementFigures key={figures.predictor} figures={figures} compact={compact} styles={styles} theme={theme} />
        ))}
      </View>
    </View>
  );
}

/** The Autonomy part: a row per class of the project, or why there is none. Hook-free. */
export function AutonomyFigures({ view, compact, styles, theme }: { view: AutonomyFiguresView; compact: boolean; styles: Styles; theme: Theme }) {
  if (view.kind === "choose" || view.kind === "empty") return <Text style={styles.body}>{view.text}</Text>;
  if (view.kind === "loading") return <ActivityIndicator color={styles.spinner.color} />;
  if (view.kind === "error") return <ToneText tone="danger" styles={styles} theme={theme}>{view.text}</ToneText>;
  return (
    <>
      {view.rows.map((row) => (
        <AutonomyClassRow key={row.decisionClass} row={row} compact={compact} styles={styles} theme={theme} />
      ))}
      {view.quiet === null ? null : <Text style={[styles.body, { fontSize: 11 }]}>{view.quiet}</Text>}
    </>
  );
}

/**
 * One tier of review lift: its name and how many requests were reviewed, then
 * its four figures — stacked on a phone, side by side on a wide screen. Hook-free.
 */
export function ReviewTierRow({ row, compact, styles, theme }: { row: ReviewTierRowView; compact: boolean; styles: Styles; theme: Theme }) {
  const strong = [styles.body, { color: toneColor(theme, "plain"), fontWeight: "600" as const }];
  return (
    <View style={styles.card} accessibilityLabel={row.accessibilityLabel}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <Text style={[styles.sectionTitle, { flex: 1, minWidth: 120 }]}>{row.label}</Text>
        <ToneText tone="muted" base={styles.badge} styles={styles} theme={theme}>{row.count}</ToneText>
      </View>
      <View style={compact ? { flexDirection: "column", gap: 6 } : { flexDirection: "row", flexWrap: "wrap", gap: 16 }}>
        {row.figures.map((figure) =>
          compact ? (
            <View key={figure.label} style={{ gap: 1 }}>
              <Text style={strong}>{`${figure.label} · ${figure.value}`}</Text>
              <Text style={styles.body}>{figure.detail}</Text>
            </View>
          ) : (
            <View key={figure.label} style={{ flex: 1, minWidth: 140, gap: 1 }}>
              <Text style={[styles.body, { fontSize: 11 }]}>{figure.label}</Text>
              <Text style={strong}>{figure.value}</Text>
              <Text style={styles.body}>{figure.detail}</Text>
            </View>
          ),
        )}
      </View>
    </View>
  );
}

/** Review lift of the chosen window and project: a row per tier, or why there is none. Hook-free. */
export function ReviewLiftFigures({ view, compact, styles, theme }: { view: ReviewLiftView; compact: boolean; styles: Styles; theme: Theme }) {
  if (view.kind === "empty") return <Text style={styles.body}>{view.text}</Text>;
  return (
    <>
      {view.rows.map((row) => (
        <ReviewTierRow key={row.tier} row={row} compact={compact} styles={styles} theme={theme} />
      ))}
      {view.unknowns === null ? null : <Text style={[styles.body, { fontSize: 11 }]}>{view.unknowns}</Text>}
    </>
  );
}

export interface MetricsBodyProps {
  window: InsightsWindow;
  /** The project's name, for the scope line. */
  projectLabel: string | null;
  /** Null until the summary has been read once. */
  view: InsightsView | null;
  loading: boolean;
  error: string | null;
  beads: BeadsFiguresView;
  autonomy: AutonomyFiguresView;
  /** Phone width: the autonomy figures, the heaviest requests and the review figures stack. */
  compact?: boolean;
  onWindow: (window: InsightsWindow) => void;
  onRefresh: () => void;
  styles: Styles;
  theme: Theme;
}

/** The Metrics tab but its data: the window, then Flow, Cost, Coordination, Beads, Autonomy and Review lift. Hook-free. */
export function MetricsBody(props: MetricsBodyProps) {
  const { window, projectLabel, view, loading, error, beads, autonomy, styles, theme } = props;
  return (
    <>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <View style={{ flex: 1 }}>
          <StatusTabs tabs={WINDOW_TABS} selected={window} onSelect={(key) => props.onWindow(key as InsightsWindow)} styles={styles} />
        </View>
        <Button label="Refresh" kind="secondary" accessibilityLabel="Refresh the figures" onPress={props.onRefresh} styles={styles} />
      </View>
      <Text style={styles.body}>{scopeLine(window, projectLabel)}</Text>

      {loading && view === null ? <ActivityIndicator color={styles.spinner.color} /> : null}
      {error === null ? null : <ToneText tone="danger" styles={styles} theme={theme}>{`Could not read the figures. ${error}`}</ToneText>}
      {view === null ? null : <InsightsFigures view={view} compact={props.compact ?? false} styles={styles} />}

      <Text style={styles.sectionTitle}>Beads</Text>
      <BeadsFigures view={beads} styles={styles} theme={theme} />

      <Text style={styles.sectionTitle}>{AUTONOMY_TITLE}</Text>
      <Text style={styles.body}>{AUTONOMY_NOTE}</Text>
      <AutonomyFigures view={autonomy} compact={props.compact ?? false} styles={styles} theme={theme} />

      {view === null || view.reviewLift === null ? null : (
        <>
          <Text style={styles.sectionTitle}>{REVIEW_LIFT_TITLE}</Text>
          <Text style={styles.body}>{REVIEW_LIFT_NOTE}</Text>
          <ReviewLiftFigures view={view.reviewLift} compact={props.compact ?? false} styles={styles} theme={theme} />
        </>
      )}
    </>
  );
}

export interface ProjectMetricsProps {
  workspaceId: string;
  /** The project's name; null in the workspace's own Beads tab. */
  label: string | null;
  compact: boolean;
  theme: Theme;
}

/** A project's Metrics tab: mounted only while it shows, so its figures are read only then. */
export function ProjectMetrics({ workspaceId, label, compact, theme }: ProjectMetricsProps) {
  const styles = useMemo(() => dashboardStyles(theme, compact), [theme, compact]);
  const [window, setWindow] = useState<InsightsWindow>(INSIGHTS_DEFAULT_WINDOW);
  const readSummary = useRpc(insightsSummaryRpc);
  const listBeads = useRpc(beadsListRpc);
  const readLedger = useRpc(autonomyLedgerRpc);
  const readPolicy = useRpc(autonomyPolicyRpc);
  const summary = useQuery({
    queryKey: insightsQueryKey(window, workspaceId),
    queryFn: () => readSummary({ window, workspaceId }),
    staleTime: INSIGHTS_STALE_MS,
  });
  // The Beads screen's own query: a project's beads read here are its beads there.
  const beads = useQuery({
    queryKey: ["paseo-bm", "beads-list", workspaceId],
    queryFn: () => listBeads({ workspaceId }),
  });
  const ledger = useQuery({
    queryKey: autonomyLedgerQueryKey(workspaceId),
    queryFn: () => readLedger({ workspaceId }),
    staleTime: INSIGHTS_STALE_MS,
  });
  // Settings reads and writes this same query, so a level set there shows here.
  const policy = useQuery({ queryKey: AUTONOMY_POLICY_KEY, queryFn: () => readPolicy({}) });
  const now = new Date();
  const view = summary.data === undefined ? null : insightsView(summary.data, now, label === null ? [] : [{ id: workspaceId, label }]);
  const beadsView = beadsFiguresView(workspaceId, beads.data, beads.isError ? errorMessageOf(beads.error) : null, now);
  const autonomyView = autonomyFiguresView({
    projectId: workspaceId,
    ledger: ledger.data,
    policy: policy.data?.policy,
    error: ledger.isError ? errorMessageOf(ledger.error) : policy.isError ? errorMessageOf(policy.error) : null,
  });
  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <MetricsBody
        window={window}
        projectLabel={label ?? "this project"}
        view={view}
        loading={summary.isPending}
        error={summary.isError ? errorMessageOf(summary.error) : null}
        beads={beadsView}
        autonomy={autonomyView}
        compact={compact}
        onWindow={setWindow}
        onRefresh={() => {
          void summary.refetch();
          void beads.refetch();
          void ledger.refetch();
          void policy.refetch();
        }}
        styles={styles}
        theme={theme}
      />
    </ScrollView>
  );
}
