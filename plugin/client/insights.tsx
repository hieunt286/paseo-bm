/**
 * Insights (experience concept §4.3, autonomy design §A.12): how requests flow,
 * what they cost and how the Orchestrator's interventions turned out (A-12,
 * §G.3), from `insights.summary` (the metric module over the plugin's own data
 * folder); the Beads figures of one project; its autonomy by class — the
 * agreement ledger (`autonomy.ledger`) with each class's mode
 * (`autonomy.policy`, §B.3), and a **Delegate?** shortcut on a class that may
 * be delegated (ADR-023), which delegates it only once confirmed (`autonomy.set { confirmed: true,
 * predictor }`, §B.4); and review lift per size of request (§C.4). Cost ends
 * with the tokens read per request and the heaviest requests, by project name
 * (§G.2). What it shows is `insights-model.ts`; this file reads the data and
 * draws it.
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
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState, type ReactNode } from "react";
import { ActivityIndicator, ScrollView, Text, View } from "react-native";
import type { AutonomySetInput } from "../shared/autonomy";
import {
  autonomyLedgerRpc,
  autonomyPolicyRpc,
  autonomySetRpc,
  beadsListRpc,
  insightsSummaryRpc,
  type AutonomyPolicyOutput,
  type InsightsWindow,
} from "../shared/contracts";
import type { DecisionClass, Predictor } from "../shared/decisions";
import { dashboardStyles } from "./styles";
import { toneColor } from "./tone";
import {
  ALL_PROJECTS,
  AUTONOMY_NOTE,
  AUTONOMY_TITLE,
  COORDINATION_EMPTY,
  DELEGATION_UI_IDLE,
  HEAVIEST_TITLE,
  COORDINATION_NOTE,
  INSIGHTS_DEFAULT_WINDOW,
  REVIEW_LIFT_NOTE,
  REVIEW_LIFT_TITLE,
  WINDOW_TABS,
  autonomyFiguresView,
  beadsFiguresView,
  insightsView,
  projectTabs,
  scopeLine,
  type AgreementFiguresView,
  type AutonomyClassRowView,
  type AutonomyFiguresView,
  type BeadsFiguresView,
  type DelegateOfferView,
  type DelegationUi,
  type HeavyRequestView,
  type InsightsProject,
  type InsightsView,
  type RequestTokensView,
  type ReviewLiftView,
  type ReviewTierRowView,
} from "./insights-model";
import { errorMessageOf } from "./errors";
import { AUTONOMY_POLICY_KEY } from "./settings-autonomy-model";
import { BarChart, Button, ConfirmBlock, StatCards, StatusTabs, ToneText, type Styles, type Theme } from "./ui";

/** Figures change slowly; a read stays good for a minute. */
const INSIGHTS_STALE_MS = 60_000;

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

/** What the Autonomy part's presses do: open Delegate?'s confirmation, cancel it, confirm it. */
export interface AutonomyActions {
  delegate: (offer: { decisionClass: DecisionClass; predictor: Predictor }) => void;
  cancel: () => void;
  confirm: (input: AutonomySetInput) => void;
}

const NO_AUTONOMY_ACTIONS: AutonomyActions = { delegate: () => undefined, cancel: () => undefined, confirm: () => undefined };

/** Delegate? on a predictor's figures: it opens the confirmation, never delegates by itself. Hook-free. */
function DelegateButton({ offer, on, styles }: { offer: DelegateOfferView; on: AutonomyActions; styles: Styles }) {
  return (
    <View style={styles.chipRow}>
      <Button
        label={offer.label}
        kind="secondary"
        accessibilityLabel={offer.accessibilityLabel}
        accessibilityState={{ disabled: !offer.enabled }}
        disabled={!offer.enabled}
        onPress={() => on.delegate({ decisionClass: offer.decisionClass, predictor: offer.predictor })}
        style={{ opacity: offer.enabled ? 1 : 0.5 }}
        styles={styles}
      />
    </View>
  );
}

/**
 * One predictor's figures in a class row: two or three short lines on a phone,
 * a column of its own on a wide screen; Delegate? under them when offered. Hook-free.
 */
function AgreementFigures({ figures, compact, on, styles, theme }: { figures: AgreementFiguresView; compact: boolean; on: AutonomyActions; styles: Styles; theme: Theme }) {
  const strong = [styles.body, { color: toneColor(theme, "plain"), fontWeight: "600" as const }];
  const reversals =
    figures.reversals === null ? null : <ToneText tone={figures.reversalTone} styles={styles} theme={theme}>{figures.reversals}</ToneText>;
  const unread = figures.unread === null ? null : <Text style={[styles.body, { fontSize: 11 }]}>{figures.unread}</Text>;
  const delegate = figures.delegate === null ? null : <DelegateButton offer={figures.delegate} on={on} styles={styles} />;
  if (compact) {
    return (
      <View style={{ gap: 1 }}>
        <Text style={strong}>{`${figures.label} · ${figures.agreement}`}</Text>
        <Text style={styles.body}>{figures.span === null ? figures.count : `${figures.count} · ${figures.span}`}</Text>
        {reversals}
        {unread}
        {delegate}
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
      {delegate}
    </View>
  );
}

/**
 * One class: its name and mode, then each predictor's figures — stacked on a
 * phone, side by side on a wide screen —, when it last went back to Shadow,
 * and Delegate?'s confirmation in place (Cancel first). Hook-free.
 */
export function AutonomyClassRow({ row, compact, on = NO_AUTONOMY_ACTIONS, styles, theme }: {
  row: AutonomyClassRowView;
  compact: boolean;
  on?: AutonomyActions;
  styles: Styles;
  theme: Theme;
}) {
  const confirm = row.confirm;
  return (
    <View style={styles.card} accessibilityLabel={row.accessibilityLabel}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <Text style={[styles.sectionTitle, { flex: 1, minWidth: 120 }]}>{row.label}</Text>
        <ToneText tone={row.modeTone} base={styles.badge} styles={styles} theme={theme}>{row.modeText}</ToneText>
      </View>
      <View style={compact ? { flexDirection: "column", gap: 6 } : { flexDirection: "row", flexWrap: "wrap", gap: 16 }}>
        {row.figures.map((figures) => (
          <AgreementFigures key={figures.predictor} figures={figures} compact={compact} on={on} styles={styles} theme={theme} />
        ))}
      </View>
      {row.demoted === null ? null : <Text style={[styles.body, { fontSize: 11 }]}>{row.demoted}</Text>}
      {confirm === null ? null : (
        <>
          <ConfirmBlock
            dialog={confirm.dialog}
            busy={confirm.busy}
            busyLabel={confirm.busyLabel}
            onConfirm={() => on.confirm(confirm.input)}
            onCancel={on.cancel}
            styles={styles}
            theme={theme}
          />
          {confirm.error === null ? null : (
            <ToneText tone="danger" accessibilityLiveRegion="polite" styles={styles} theme={theme}>
              {`Could not delegate: ${confirm.error}`}
            </ToneText>
          )}
        </>
      )}
    </View>
  );
}

/** The Autonomy part: a row per class of the chosen project, or why there is none. Hook-free. */
export function AutonomyFigures({ view, compact, on, styles, theme }: {
  view: AutonomyFiguresView;
  compact: boolean;
  on?: AutonomyActions;
  styles: Styles;
  theme: Theme;
}) {
  if (view.kind === "choose" || view.kind === "empty") return <Text style={styles.body}>{view.text}</Text>;
  if (view.kind === "loading") return <ActivityIndicator color={styles.spinner.color} />;
  if (view.kind === "error") return <ToneText tone="danger" styles={styles} theme={theme}>{view.text}</ToneText>;
  return (
    <>
      {view.rows.map((row) => (
        <AutonomyClassRow key={row.decisionClass} row={row} compact={compact} on={on ?? NO_AUTONOMY_ACTIONS} styles={styles} theme={theme} />
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

export interface InsightsBodyProps {
  window: InsightsWindow;
  projectId: string;
  projects: readonly InsightsProject[];
  /** Null until the summary has been read once. */
  view: InsightsView | null;
  loading: boolean;
  error: string | null;
  beads: BeadsFiguresView;
  autonomy: AutonomyFiguresView;
  /** Delegate? and its confirmation (§B.4). */
  onAutonomy?: AutonomyActions;
  /** Phone width: the autonomy figures, the heaviest requests and the review figures stack. */
  compact?: boolean;
  onWindow: (window: InsightsWindow) => void;
  onProject: (projectId: string) => void;
  onRefresh: () => void;
  status?: ReactNode;
  styles: Styles;
  theme: Theme;
}

/** The whole screen but its data: the choices, then Flow, Cost, Coordination, Beads, Autonomy and Review lift. Hook-free. */
export function InsightsBody(props: InsightsBodyProps) {
  const { window, projectId, projects, view, loading, error, beads, autonomy, styles, theme } = props;
  const projectLabel = projects.find((project) => project.id === projectId)?.label ?? null;
  return (
    <>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
        <Text style={[styles.title, { flex: 1 }]} numberOfLines={1}>
          Insights
        </Text>
        <Button
          label="Refresh"
          kind="secondary"
          accessibilityLabel="Refresh the figures"
          onPress={props.onRefresh}
          styles={styles}
        />
      </View>
      {props.status}
      <StatusTabs tabs={WINDOW_TABS} selected={window} onSelect={(key) => props.onWindow(key as InsightsWindow)} styles={styles} />
      <StatusTabs tabs={projectTabs(projects)} selected={projectId} onSelect={props.onProject} styles={styles} />
      <Text style={styles.body}>{scopeLine(window, projectLabel)}</Text>

      {loading && view === null ? <ActivityIndicator color={styles.spinner.color} /> : null}
      {error === null ? null : <ToneText tone="danger" styles={styles} theme={theme}>{`Could not read the figures. ${error}`}</ToneText>}
      {view === null ? null : <InsightsFigures view={view} compact={props.compact ?? false} styles={styles} />}

      <Text style={styles.sectionTitle}>Beads</Text>
      <BeadsFigures view={beads} styles={styles} theme={theme} />

      <Text style={styles.sectionTitle}>{AUTONOMY_TITLE}</Text>
      <Text style={styles.body}>{AUTONOMY_NOTE}</Text>
      <AutonomyFigures view={autonomy} compact={props.compact ?? false} on={props.onAutonomy} styles={styles} theme={theme} />

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

export interface InsightsScreenProps extends PluginSurfaceProps {
  /** Projects the surface knows by name: open workspaces first, then closed ones with history. */
  projects: readonly InsightsProject[];
  status?: ReactNode;
}

export function InsightsScreen({ theme, layout, projects, status }: InsightsScreenProps) {
  const styles = useMemo(() => dashboardStyles(theme, layout.compact), [theme, layout.compact]);
  const queryClient = useQueryClient();
  const [window, setWindow] = useState<InsightsWindow>(INSIGHTS_DEFAULT_WINDOW);
  const [projectId, setProjectId] = useState<string>(ALL_PROJECTS);
  const [delegation, setDelegation] = useState<DelegationUi>(DELEGATION_UI_IDLE);
  const readSummary = useRpc(insightsSummaryRpc);
  const listBeads = useRpc(beadsListRpc);
  const readLedger = useRpc(autonomyLedgerRpc);
  const readPolicy = useRpc(autonomyPolicyRpc);
  const setPolicy = useRpc(autonomySetRpc);
  const chosen = projectId !== ALL_PROJECTS;
  const summary = useQuery({
    queryKey: insightsQueryKey(window, projectId),
    queryFn: () => readSummary(projectId === ALL_PROJECTS ? { window } : { window, workspaceId: projectId }),
    staleTime: INSIGHTS_STALE_MS,
  });
  // The Beads screen's own query: a project's beads read here are its beads there.
  const beads = useQuery({
    queryKey: ["paseo-bm", "beads-list", projectId],
    queryFn: () => listBeads({ workspaceId: projectId }),
    enabled: chosen,
  });
  const ledger = useQuery({
    queryKey: autonomyLedgerQueryKey(projectId),
    queryFn: () => readLedger({ workspaceId: projectId }),
    enabled: chosen,
    staleTime: INSIGHTS_STALE_MS,
  });
  // Settings reads and writes this same query, so a mode set there shows here.
  const policy = useQuery({ queryKey: AUTONOMY_POLICY_KEY, queryFn: () => readPolicy({}), enabled: chosen });
  const now = new Date();
  const view = summary.data === undefined ? null : insightsView(summary.data, now, projects);
  const beadsView = beadsFiguresView(projectId, beads.data, beads.isError ? errorMessageOf(beads.error) : null, now);
  const autonomyView = autonomyFiguresView({
    projectId,
    projectLabel: projects.find((project) => project.id === projectId)?.label ?? null,
    ledger: ledger.data,
    policy: policy.data?.policy,
    error: ledger.isError ? errorMessageOf(ledger.error) : policy.isError ? errorMessageOf(policy.error) : null,
    ui: delegation,
  });
  // §B.4: a confirmed Delegate? sets `delegate`; the policy it returns is the one Settings reads too.
  const onAutonomy: AutonomyActions = {
    delegate: (offer) => setDelegation({ ...DELEGATION_UI_IDLE, confirming: offer }),
    cancel: () => setDelegation(DELEGATION_UI_IDLE),
    confirm: (input) =>
      void (async () => {
        setDelegation((current) => ({ ...current, busy: true, error: null }));
        try {
          const saved = await setPolicy(input);
          queryClient.setQueryData<AutonomyPolicyOutput>(AUTONOMY_POLICY_KEY, saved);
          setDelegation(DELEGATION_UI_IDLE);
        } catch (failure) {
          setDelegation((current) => ({ ...current, busy: false, error: errorMessageOf(failure) }));
        }
      })(),
  };

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
        autonomy={autonomyView}
        onAutonomy={onAutonomy}
        compact={layout.compact}
        onWindow={setWindow}
        onProject={(id) => {
          setDelegation(DELEGATION_UI_IDLE);
          setProjectId(id);
        }}
        onRefresh={() => {
          void summary.refetch();
          if (!chosen) return;
          void beads.refetch();
          void ledger.refetch();
          void policy.refetch();
        }}
        status={status}
        styles={styles}
        theme={theme}
      />
    </ScrollView>
  );
}
