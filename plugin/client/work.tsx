/**
 * Projects (change-014 outcome 5; Work until then — experience concept §4.2,
 * autonomy design §A.12): the projects, and a project's page with its
 * Overview, Requests, Beads, Metrics and Agents. What is shown and in which
 * order is `work-model.ts`; this file reads the data and draws it.
 *
 * - `WorkScreen` (the approved Projects artboard, change-014 fidelity pass):
 *   a 260px list of the projects (most recent activity first), each a name
 *   and a muted line — `2 active · 1 stalled · Cruise` from
 *   `workspaces.overview`, `orchestrator.state` and `autonomy.policy` —, and
 *   beside it the chosen project's page, the most recent one until another is
 *   chosen. A phone shows the list, then the page with a ←. Open Manager runs
 *   the surface's one Manager launcher (`launch-manager.ts`).
 *   `orchestrator.state` is read every `WORK_POLL_MS` only while it shows.
 * - `ProjectPage`: a header — the name, its directory, Open Manager and
 *   Autonomy: <Level> (which opens Settings) — and five underline tabs.
 *   Overview (four figures and the tokens read by role from `insights.summary`
 *   for the workspace, the requests as a table from the Requests tab's own
 *   reads, and how the work ran), Metrics
 *   (`insights.tsx`: what the Insights section showed, for this project),
 *   Requests (a stage bar, evidence lines and a timeline per
 *   request, from `traces.list`, `traces.get` and `decisions.list`), Beads (the
 *   board, `beads-screen.tsx`) and Agents (the tree, `tree.tsx`). A request's
 *   Details offer to delete its history; the Requests tab of a closed
 *   workspace (archived, or removed from Paseo) offers to delete its history
 *   or, once removed, to move it onto a workspace that exists
 *   (`dashboard-actions.tsx`, each behind its own confirmation). A request's
 *   **Why?** shows the chain behind it in place of the list (`why.tsx`, autonomy
 *   design §E.2), read when it opens and on Refresh, never on the poll.
 * - Tokens and context (autonomy design §G.2), from `traces.agents`: a
 *   request's Details open with its tokens read by role and each agent's
 *   context trend; the Agents tab gives each listed agent's over its life,
 *   under the tree. Both are read only while they show.
 *
 * Layout: `layout.compact` (a phone) shows the list or the page, draws the stage
 * bar as five segments with its stage written under them, stacks the evidence
 * lines, and puts a timeline event's time and tag above its text. A wide screen
 * writes the five stages with the current one bold,
 * puts the evidence lines side by side and the timeline in columns, all in a
 * column of readable width.
 *
 * Client rules: React Native primitives only, colours from the theme
 * (`toneColor`), accessibility roles and labels on every pressable, ids only
 * under Details — but the Overview's Requests table, whose Worker column the
 * artboard writes as a short id.
 */
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { usePaseo, useRpc } from "@getpaseo/plugin/client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import { ActivityIndicator, Platform, Pressable, ScrollView, Text, View } from "react-native";
import {
  DECISION_LIST_MAX,
  agentsListRpc,
  autonomyPolicyRpc,
  decisionsListRpc,
  insightsSummaryRpc,
  managerEnsureRpc,
  orchestratorStateRpc,
  tracesAgentsRpc,
  tracesGetRpc,
  tracesListRpc,
  type InsightsWindow,
  type WorkspaceOverview,
} from "../shared/contracts";
import type { Decision } from "../shared/decisions";
import { AGENT_TREE_POLL_MS } from "./agent-tree";
import { BeadsScreen } from "./beads-screen";
import { FigureStrip, INSIGHTS_STALE_MS, ProjectMetrics, RoleTokenBars, SectionHeading, insightsQueryKey } from "./insights";
import { INSIGHTS_DEFAULT_WINDOW, WINDOW_SEGMENTS } from "./insights-model";
import { managerLauncher } from "./launch-manager";
import { AUTONOMY_POLICY_KEY } from "./settings-autonomy-model";
import { TraceActions } from "./dashboard-actions";
import { dashboardStyles } from "./styles";
import { toneColor } from "./tone";
import { errorMessageOf } from "./errors";
import type { ClosedWorkspace, StoredWorkspace } from "./surface-view";
import { MONO, Segmented, SectionLabel, TextTabs } from "./text-tabs";
import { AgentTreeView, toLoadable } from "./tree";
import { WhyScreen } from "./why";
import { ToneText, type Styles, type Theme } from "./ui";
import {
  ALL_REQUESTS_LABEL,
  NO_REQUESTS_TEXT,
  OVERVIEW_NO_OPEN,
  OVERVIEW_OPEN_TITLE,
  OVERVIEW_PROCESS_TITLE,
  OVERVIEW_REQUEST_COLUMNS,
  OVERVIEW_TOKENS_TITLE,
  PROJECT_TABS,
  TOKEN_FIGURES_TITLE,
  WORK_POLL_MS,
  agentTokenFigures,
  levelNameOf,
  projectOverviewView,
  requestCardView,
  requestSummaries,
  requestTokenFigures,
  timelineEvents,
  workRows,
  type AgentTokensView,
  type ContextTrendView,
  type EvidenceLine,
  type OverviewRequestRow,
  type ProjectOverviewView,
  type ProjectTab,
  type RequestCardView,
  type RequestSummary,
  type StageBarView,
  type TimelineEvent,
  type TokenFiguresState,
  type WorkRowView,
  type WorkspaceEntry,
} from "./work-model";

/** The width of the Projects list beside a project's page (the Projects artboard's aside). */
export const PROJECTS_ASIDE_WIDTH = 260;

/** Widest the Requests column grows on a large screen (the main pane's width in the artboard). */
const WIDE_COLUMN = 1000;

export const workQueryKeys = {
  projects: ["paseo-bm", "work", "projects"] as const,
  traces: (workspaceId: string) => ["paseo-bm", "work", "traces", workspaceId] as const,
  trace: (workspaceId: string, traceId: string) => ["paseo-bm", "work", "trace", workspaceId, traceId] as const,
  decisions: (workspaceId: string) => ["paseo-bm", "work", "decisions", workspaceId] as const,
  /** `traces.agents`: of one request, or (no trace) of the Agents tab. */
  tokens: (workspaceId: string, traceId?: string) => ["paseo-bm", "work", "tokens", workspaceId, traceId ?? "agents"] as const,
  /** Each workspace's directory (`workspaces.list`), named under a project's title. */
  directories: ["paseo-bm", "work", "directories"] as const,
};

function column(compact: boolean, gap: number) {
  return { gap, width: "100%" as const, maxWidth: compact ? undefined : WIDE_COLUMN, alignSelf: "flex-start" as const };
}

// ---------------------------------------------------------------------------
// Hook-free pieces (tested with test/helpers/element-tree.ts).
// ---------------------------------------------------------------------------

/** The M W R letters of the agents a project has now: bright while one of them runs. */
export function AgentMarks({ agents, styles, theme }: { agents: WorkRowView["agents"]; styles: Styles; theme: Theme }) {
  if (agents.length === 0) return null;
  return (
    <View style={{ flexDirection: "row", gap: 4 }} accessibilityLabel={agents.map((agent) => agent.label).join(", ")}>
      {agents.map((agent) => (
        <ToneText key={agent.letter} tone={agent.tone} base={styles.badge} styles={styles} theme={theme}>
          {agent.letter}
        </ToneText>
      ))}
    </View>
  );
}

/**
 * One project in the Projects list (the artboard's aside): a full-width row,
 * the name in weight 500 and a muted line `2 active · 1 stalled · Cruise`; the
 * selected one on surface2 with a 3px accent bar at its left. The whole row
 * opens the project.
 */
export function WorkRowItem({
  row,
  selected,
  onOpen,
  theme,
}: {
  row: WorkRowView;
  selected: boolean;
  onOpen: () => void;
  theme: Theme;
}) {
  const { colors } = theme;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={row.accessibilityLabel}
      accessibilityState={{ selected }}
      onPress={onOpen}
      style={{ gap: 4, paddingVertical: 12, paddingHorizontal: 20, backgroundColor: selected ? colors.surface2 : "transparent" }}
    >
      <View style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: 3, backgroundColor: selected ? colors.accent : "transparent" }} />
      <Text style={{ fontSize: 14, fontWeight: "500", color: colors.foreground }} numberOfLines={1}>
        {row.label}
      </Text>
      <Text style={{ fontSize: 12, color: colors.foregroundMuted }} numberOfLines={1}>
        {row.line}
      </Text>
    </Pressable>
  );
}

/**
 * The Projects list: the projects, then the history of workspaces Paseo no
 * longer lists, then the plugin's version. The artboard's 260px aside on a wide
 * screen; the whole screen on a phone, until a project is chosen.
 */
export function WorkList({
  rows,
  closed,
  loading,
  error,
  footer,
  selectedId,
  onOpen,
  compact,
  theme,
}: {
  rows: readonly WorkRowView[];
  closed: readonly ClosedWorkspace[];
  loading: boolean;
  error: string | null;
  footer?: string;
  /** The project whose page shows beside the list; null on a phone's list. */
  selectedId: string | null;
  onOpen: (workspaceId: string, label: string) => void;
  compact: boolean;
  theme: Theme;
}) {
  const { colors } = theme;
  const muted = { fontSize: 13, color: colors.foregroundMuted, paddingHorizontal: 20 };
  return (
    <ScrollView
      accessibilityLabel="Projects"
      style={compact ? { flex: 1 } : { width: PROJECTS_ASIDE_WIDTH, flexGrow: 0, borderRightWidth: 1, borderRightColor: colors.border }}
      contentContainerStyle={{ paddingVertical: 20 }}
    >
      {loading ? <ActivityIndicator color={colors.foregroundMuted} accessibilityLabel="Reading the projects" /> : null}
      {error === null ? null : <Text style={[muted, { color: colors.statusDanger }]}>{`Could not load the workspaces. ${error}`}</Text>}
      {!loading && error === null && rows.length === 0 ? <Text style={muted}>No workspaces on this host yet.</Text> : null}
      {rows.map((row) => (
        <WorkRowItem key={row.workspaceId} row={row} selected={row.workspaceId === selectedId} onOpen={() => onOpen(row.workspaceId, row.label)} theme={theme} />
      ))}
      {closed.length === 0 ? null : (
        <View style={{ paddingHorizontal: 20, paddingTop: 20, paddingBottom: 8 }}>
          <SectionLabel theme={theme}>Closed workspaces with history</SectionLabel>
        </View>
      )}
      {closed.map((entry) => {
        const on = entry.workspaceId === selectedId;
        return (
          <Pressable
            key={entry.workspaceId}
            accessibilityRole="button"
            accessibilityLabel={`Open the requests of the closed workspace ${entry.label}`}
            accessibilityState={{ selected: on }}
            onPress={() => onOpen(entry.workspaceId, entry.label)}
            style={{ gap: 4, paddingVertical: 12, paddingHorizontal: 20, backgroundColor: on ? colors.surface2 : "transparent" }}
          >
            <View style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: 3, backgroundColor: on ? colors.accent : "transparent" }} />
            <Text style={{ fontSize: 14, fontWeight: "500", color: colors.foreground }} numberOfLines={1}>
              {entry.label}
            </Text>
            <Text style={{ fontSize: 12, color: colors.foregroundMuted }} numberOfLines={compact ? 2 : 1}>
              {entry.detail}
            </Text>
          </Pressable>
        );
      })}
      {footer === undefined ? null : <Text style={{ fontSize: 11, color: colors.foregroundMuted, paddingHorizontal: 20, paddingTop: 20 }}>{footer}</Text>}
    </ScrollView>
  );
}

/**
 * The stage bar. A phone draws five segments, filled up to the current stage,
 * and writes the stage under them; a wide screen writes the five stages with
 * connectors, the current one bold.
 */
export function StageBarRow({ bar, compact, styles, theme }: { bar: StageBarView; compact: boolean; styles: Styles; theme: Theme }) {
  const position = bar.steps.findIndex((step) => step.state === "current") + 1;
  const current = toneColor(theme, bar.tone);
  const colourOf = (state: StageBarView["steps"][number]["state"]) =>
    state === "current" ? current : state === "done" ? theme.colors.foreground : theme.colors.foregroundMuted;
  const a11y = {
    accessibilityRole: "progressbar" as const,
    accessibilityLabel: bar.accessibilityLabel,
    accessibilityValue: { min: 1, max: bar.steps.length, now: position },
  };
  if (compact) {
    return (
      <View {...a11y} style={{ gap: 4 }}>
        <View style={{ flexDirection: "row", gap: 3 }}>
          {bar.steps.map((step) => (
            <View
              key={step.key}
              style={{
                flex: 1,
                height: 4,
                borderRadius: 0,
                backgroundColor: step.state === "next" ? theme.colors.surface2 : step.state === "current" ? current : theme.colors.foregroundMuted,
              }}
            />
          ))}
        </View>
        <Text style={[styles.body, { color: current }]}>{bar.note === null ? bar.text : `${bar.text} · ${bar.note}`}</Text>
      </View>
    );
  }
  return (
    <View {...a11y} style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 6 }}>
      {bar.steps.map((step, index) => (
        <View key={step.key} style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          {index === 0 ? null : (
            <View style={{ width: 20, height: step.state === "next" ? 1 : 2, backgroundColor: colourOf(step.state === "next" ? "next" : "done") }} />
          )}
          <Text style={[styles.body, { color: colourOf(step.state), fontWeight: step.state === "current" ? "700" : "400" }]}>{step.label}</Text>
        </View>
      ))}
      {bar.note === null ? null : <Text style={[styles.badge, { color: current, marginLeft: 6 }]}>{bar.note}</Text>}
    </View>
  );
}

/** The evidence lines of a request: stacked on a phone, side by side on a wide screen. */
export function EvidenceList({ lines, compact, styles, theme }: { lines: readonly EvidenceLine[]; compact: boolean; styles: Styles; theme: Theme }) {
  if (lines.length === 0) return null;
  return (
    <View style={{ flexDirection: compact ? "column" : "row", flexWrap: "wrap", gap: compact ? 2 : 16 }}>
      {lines.map((line) => (
        <ToneText key={line.key} tone={line.tone} styles={styles} theme={theme}>
          {`${line.mark} ${line.text}`}
        </ToneText>
      ))}
    </View>
  );
}

/** A request's timeline, newest first: time, what happened, and its tag. */
export function TimelineList({ events, compact, styles, theme }: { events: readonly TimelineEvent[]; compact: boolean; styles: Styles; theme: Theme }) {
  if (events.length === 0) return <Text style={styles.body}>Nothing on record for this request yet.</Text>;
  return (
    <View style={{ gap: compact ? 8 : 6 }}>
      {events.map((event) =>
        compact ? (
          <View key={event.key} style={{ gap: 2 }}>
            <Text style={[styles.body, { fontSize: 11 }]}>{event.tag === null ? event.time : `${event.time} · ${event.tag}`}</Text>
            <ToneText tone={event.tone} styles={styles} theme={theme}>{event.text}</ToneText>
          </View>
        ) : (
          <View key={event.key} style={{ flexDirection: "row", alignItems: "flex-start", gap: 10 }}>
            <Text style={[styles.body, { width: 92 }]}>{event.time}</Text>
            <ToneText tone={event.tone} style={{ flex: 1 }} styles={styles} theme={theme}>{event.text}</ToneText>
            {event.tag === null ? null : <ToneText tone="muted" base={styles.badge} styles={styles} theme={theme}>{event.tag}</ToneText>}
          </View>
        ),
      )}
    </View>
  );
}

/** Tallest bar of a context trend, in points. */
const TREND_HEIGHT = 18;

/** An agent's context over its turns: one bar per turn, oldest first, as tall as its share of the context window or of the largest point. */
export function ContextBars({ trend, compact, theme }: { trend: ContextTrendView; compact: boolean; theme: Theme }) {
  return (
    <View
      accessibilityRole="image"
      accessibilityLabel={trend.accessibilityLabel}
      style={{ flexDirection: "row", alignItems: "flex-end", gap: 1, height: TREND_HEIGHT }}
    >
      {trend.bars.map((height, index) => (
        <View
          key={index}
          style={{ width: compact ? 3 : 4, height: Math.max(1, Math.round(height * TREND_HEIGHT)), borderRadius: 0, backgroundColor: toneColor(theme, "info") }}
        />
      ))}
    </View>
  );
}

/** One agent's tokens and context trend: stacked on a phone, one row on a wide screen. */
export function AgentTokensRow({ row, compact, styles, theme }: { row: AgentTokensView; compact: boolean; styles: Styles; theme: Theme }) {
  const name = (
    <Text style={[styles.body, { color: theme.colors.foreground, fontWeight: "600", width: compact ? undefined : 180 }]} numberOfLines={1}>
      {row.name}
    </Text>
  );
  const tokens = <Text style={styles.body}>{row.note === null ? row.tokens : `${row.tokens} · ${row.note}`}</Text>;
  const label = row.trend === null ? null : row.trend.estimate;
  const estimate = label === null ? null : <ToneText tone="muted" base={styles.badge} styles={styles} theme={theme}>{label}</ToneText>;
  const context =
    row.trend === null ? (
      <Text style={styles.body}>context not known</Text>
    ) : (
      <>
        <ContextBars trend={row.trend} compact={compact} theme={theme} />
        <Text style={[styles.body, { flexShrink: 1 }]}>{row.trend.text}</Text>
        {estimate}
      </>
    );
  if (compact) {
    return (
      <View style={{ gap: 2 }} accessibilityLabel={row.accessibilityLabel}>
        {name}
        <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 8 }}>{context}</View>
        {tokens}
      </View>
    );
  }
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }} accessibilityLabel={row.accessibilityLabel}>
      {name}
      <View style={{ flex: 1, flexDirection: "row", alignItems: "center", gap: 8 }}>{context}</View>
      {tokens}
    </View>
  );
}

/** Tokens and context: the tokens read by role, each agent's row, then what the figures cannot say. */
export function TokenFigures({ state, compact, styles, theme }: { state: TokenFiguresState; compact: boolean; styles: Styles; theme: Theme }) {
  const body =
    state.kind === "loading" ? (
      <ActivityIndicator color={styles.spinner.color} accessibilityLabel="Reading the tokens and context" />
    ) : state.kind === "error" ? (
      <ToneText tone="danger" styles={styles} theme={theme}>{state.text}</ToneText>
    ) : state.kind === "empty" ? (
      <Text style={styles.body}>{state.text}</Text>
    ) : (
      <>
        {state.view.byRole === null ? null : <Text style={[styles.body, { color: theme.colors.foreground }]}>{state.view.byRole}</Text>}
        {state.view.agents.map((row) => (
          <AgentTokensRow key={row.key} row={row} compact={compact} styles={styles} theme={theme} />
        ))}
        {state.view.notes.map((note) => (
          <Text key={note} style={[styles.body, { fontSize: 11 }]}>
            {note}
          </Text>
        ))}
      </>
    );
  return (
    <View style={{ gap: 6 }}>
      <Text accessibilityRole="header" style={styles.sectionTitle}>
        {TOKEN_FIGURES_TITLE}
      </Text>
      {body}
    </View>
  );
}

/** A small text button of a request card. */
function CardLink({ label, a11y, expanded, onPress, styles, theme }: { label: string; a11y: string; expanded?: boolean; onPress: () => void; styles: Styles; theme: Theme }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={a11y}
      accessibilityState={expanded === undefined ? undefined : { expanded }}
      onPress={onPress}
      style={{ paddingVertical: 4 }}
    >
      <ToneText tone="info" styles={styles} theme={theme}>{label}</ToneText>
    </Pressable>
  );
}

/** One request: its title and meta, the stage bar, the evidence lines, then Timeline, cost, Open Worker and Details. */
export function RequestCard({
  view,
  expanded,
  timeline,
  loading,
  error,
  detailsOpen,
  onToggle,
  onToggleDetails,
  onOpenAgent,
  onWhy,
  detailsExtra,
  tokens,
  compact,
  styles,
  theme,
}: {
  view: RequestCardView;
  expanded: boolean;
  /** Null until the request's detail has been read. */
  timeline: readonly TimelineEvent[] | null;
  loading: boolean;
  error: string | null;
  detailsOpen: boolean;
  onToggle: () => void;
  onToggleDetails: () => void;
  /** Undefined on a host that cannot open agents. */
  onOpenAgent?: (agentId: string) => void;
  /** Opens the chain behind the request (autonomy design §E.2); undefined for a request with no id. */
  onWhy?: () => void;
  /** Drawn under the ids while Details is open: the request's history actions. */
  detailsExtra?: ReactNode;
  /** Drawn first while Details is open: the request's tokens and context (autonomy design §G.2). */
  tokens?: TokenFiguresState;
  compact: boolean;
  styles: Styles;
  theme: Theme;
}) {
  return (
    <View style={[styles.card, { gap: 8 }]} accessibilityLabel={view.accessibilityLabel}>
      <View style={{ flexDirection: compact ? "column" : "row", gap: compact ? 2 : 12, alignItems: compact ? "stretch" : "flex-start" }}>
        <Text style={[styles.sectionTitle, { flex: compact ? undefined : 1, fontWeight: "600" }]} numberOfLines={expanded ? undefined : 2}>
          {view.title}
        </Text>
        <Text style={styles.body}>{view.meta}</Text>
      </View>
      {view.stage === null ? null : <StageBarRow bar={view.stage} compact={compact} styles={styles} theme={theme} />}
      <EvidenceList lines={view.evidence} compact={compact} styles={styles} theme={theme} />
      <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", columnGap: 14, rowGap: 2 }}>
        <CardLink
          label={`Timeline ${expanded ? "▾" : "▸"}`}
          a11y={`${expanded ? "Hide" : "Show"} the timeline of this request`}
          expanded={expanded}
          onPress={onToggle}
          styles={styles}
          theme={theme}
        />
        <Text style={styles.body}>{view.cost}</Text>
        {onOpenAgent === undefined || view.workerId === null ? null : (
          <CardLink label="Open Worker ▸" a11y="Open the Worker of this request" onPress={() => onOpenAgent(view.workerId!)} styles={styles} theme={theme} />
        )}
        {onWhy === undefined ? null : (
          <CardLink label="Why? ▸" a11y="Show why: the decisions, beads, changes, checks and reviews behind this request" onPress={onWhy} styles={styles} theme={theme} />
        )}
        <CardLink
          label={`Details ${detailsOpen ? "▾" : "▸"}`}
          a11y={`${detailsOpen ? "Hide" : "Show"} the ids of this request`}
          expanded={detailsOpen}
          onPress={onToggleDetails}
          styles={styles}
          theme={theme}
        />
      </View>
      {!expanded ? null : error !== null ? (
        <ToneText tone="danger" styles={styles} theme={theme}>{error}</ToneText>
      ) : timeline === null ? (
        loading ? <ActivityIndicator color={styles.spinner.color} accessibilityLabel="Reading the timeline" /> : null
      ) : (
        <TimelineList events={timeline} compact={compact} styles={styles} theme={theme} />
      )}
      {detailsOpen ? (
        <View style={[styles.card, { backgroundColor: theme.colors.surface0, gap: 2 }]}>
          {tokens === undefined ? null : (
            <View style={{ marginBottom: 6 }}>
              <TokenFigures state={tokens} compact={compact} styles={styles} theme={theme} />
            </View>
          )}
          {view.details.map((line) => (
            <Text key={line} style={styles.mono} selectable>
              {line}
            </Text>
          ))}
          {detailsExtra}
        </View>
      ) : null}
    </View>
  );
}

/** A secondary button of the page header: 1px border, transparent, square. */
function HeaderButton({ label, a11y, onPress, disabled, theme }: { label: string; a11y: string; onPress: () => void; disabled?: boolean; theme: Theme }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={a11y}
      accessibilityState={disabled === undefined ? undefined : { disabled, busy: disabled }}
      disabled={disabled}
      onPress={onPress}
      style={{ borderWidth: 1, borderColor: theme.colors.border, paddingVertical: 8, paddingHorizontal: 14, opacity: disabled === true ? 0.5 : 1 }}
    >
      <Text style={{ fontSize: 14, color: theme.colors.foreground }}>{label}</Text>
    </Pressable>
  );
}

/**
 * The project page's header (the Projects artboard): the name 22/600 with its
 * directory in mono under it; at the right Open Manager and Autonomy: <Level>
 * (which opens Settings), the Metrics period before them while Metrics shows;
 * then the five tabs as underline text tabs. A phone puts a ← first. In the
 * workspace's own Beads tab (no name) only the tabs are drawn.
 */
export function ProjectHeader({
  label,
  directory,
  tab,
  onTab,
  onBack,
  backLabel,
  status,
  onChat,
  chatBusy,
  level,
  onOpenSettings,
  extra,
  theme,
}: {
  /** Null in a workspace's own Beads tab, which already lives in its workspace. */
  label: string | null;
  /** The workspace's directory; null when not known. */
  directory?: string | null;
  tab: ProjectTab;
  onTab: (tab: ProjectTab) => void;
  onBack?: () => void;
  backLabel?: string;
  status?: ReactNode;
  onChat?: () => void;
  chatBusy: boolean;
  /** The project's level by name; null until `autonomy.policy` answered. */
  level?: string | null;
  onOpenSettings?: () => void;
  /** Drawn first on the right: the Metrics period. */
  extra?: ReactNode;
  theme: Theme;
}) {
  const { colors } = theme;
  const autonomy = level === undefined || level === null ? null : `Autonomy: ${level}`;
  return (
    <View style={{ gap: 16 }}>
      {label === null ? null : (
        <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 16 }}>
          {onBack === undefined ? null : (
            <Pressable accessibilityRole="button" accessibilityLabel={backLabel ?? "Back"} onPress={onBack} style={{ paddingVertical: 4, paddingRight: 4 }}>
              <Text style={{ fontSize: 18, color: colors.foregroundMuted }}>←</Text>
            </Pressable>
          )}
          <View style={{ gap: 4, flexShrink: 1, minWidth: 0 }}>
            <Text accessibilityRole="header" style={{ fontSize: 22, fontWeight: "600", color: colors.foreground }} numberOfLines={1}>
              {label}
            </Text>
            <Text style={{ fontFamily: MONO, fontSize: 12, color: colors.foregroundMuted }} numberOfLines={1} selectable>
              {directory ?? "—"}
            </Text>
          </View>
          <View style={{ flex: 1 }} />
          <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
            {extra}
            {onChat === undefined ? null : (
              <HeaderButton
                label={chatBusy ? "Opening…" : "Open Manager"}
                a11y={`Chat with the Beads Manager of ${label}`}
                onPress={onChat}
                disabled={chatBusy}
                theme={theme}
              />
            )}
            {autonomy === null ? null : onOpenSettings === undefined ? (
              <Text style={{ fontSize: 14, color: colors.foregroundMuted }}>{autonomy}</Text>
            ) : (
              <HeaderButton label={autonomy} a11y={`${autonomy}. Open Settings to change it`} onPress={onOpenSettings} theme={theme} />
            )}
          </View>
        </View>
      )}
      {status}
      <TextTabs
        tabs={PROJECT_TABS.map((entry) => ({ key: entry.key, label: entry.label }))}
        selected={tab}
        onSelect={(key) => onTab(key as ProjectTab)}
        theme={theme}
        divider
      />
    </View>
  );
}

/** The project directories, by workspace id (`workspaces.list`); shared by every project page. */
function useDirectories(): ReadonlyMap<string, string> {
  const paseo = usePaseo();
  const listed = useQuery({
    queryKey: workQueryKeys.directories,
    queryFn: async () => {
      const result = await paseo.workspaces.list({});
      return result.entries.map((entry) => [entry.id, entry.workspaceDirectory] as const);
    },
    staleTime: 60_000,
  });
  return useMemo(() => new Map(listed.data ?? []), [listed.data]);
}

// ---------------------------------------------------------------------------
// The screens.
// ---------------------------------------------------------------------------

export interface WorkScreenProps {
  theme: Theme;
  compact: boolean;
  /** `workspaces.list`, most recent activity first; undefined until it answered. */
  workspaces: readonly WorkspaceEntry[] | undefined;
  workspacesError: string | null;
  overview: ReadonlyMap<string, WorkspaceOverview>;
  closed: readonly ClosedWorkspace[];
  status?: ReactNode;
  footer?: string;
  /** No longer drawn: a row says `2 active` in words (the artboard has no dot). Kept so an older caller still type-checks. */
  renderDot?: (workspaceId: string) => ReactNode;
  /** No longer called: a chosen project's page shows beside the list, on this screen. Kept so an older caller still type-checks. */
  onOpen?: (workspaceId: string, label: string) => void;
  /** The surface's props, for the project page (its Beads tab and its agents); a minimal set when absent. */
  surface?: PluginSurfaceProps;
  /** Opens Settings, where the autonomy level is set; without it the level is named, not pressable. */
  onOpenSettings?: () => void;
  /** A project to show (the Inbox or the Command Center asked for it), and its tab; a new `nonce` asks again. */
  request?: { workspaceId: string; tab: ProjectTab; nonce: number } | null;
}

/**
 * Projects (the Projects artboard): the list of projects as a 260px aside, and
 * the chosen project's page beside it — the most recent one until another is
 * chosen. A phone shows the list first and the page once one is chosen, with
 * a ← back to the list. Mounted only while it shows, so the projects are read
 * only then.
 */
export function WorkScreen(props: WorkScreenProps) {
  const { theme, compact } = props;
  const getState = useRpc(orchestratorStateRpc);
  const readPolicy = useRpc(autonomyPolicyRpc);
  const ensure = useRpc(managerEnsureRpc);
  const projects = useQuery({ queryKey: workQueryKeys.projects, queryFn: () => getState({}), refetchInterval: WORK_POLL_MS });
  // Each project's level; Settings reads and writes this same query, so a level set there shows here.
  const policy = useQuery({ queryKey: AUTONOMY_POLICY_KEY, queryFn: () => readPolicy({}) });
  const launcher = useSyncExternalStore(managerLauncher.subscribe, managerLauncher.getState, managerLauncher.getState);
  const rows = workRows({
    workspaces: props.workspaces ?? [],
    projects: projects.data?.projects ?? null,
    overview: props.overview,
    ...(policy.data === undefined ? {} : { levels: policy.data.levels }),
    now: new Date(),
  });
  // The project the owner chose (or that was asked for), and its tab.
  const [chosen, setChosen] = useState<{ workspaceId: string; tab: ProjectTab } | null>(null);
  const [seen, setSeen] = useState<number | null>(null);
  if (props.request != null && props.request.nonce !== seen) {
    setSeen(props.request.nonce);
    setChosen({ workspaceId: props.request.workspaceId, tab: props.request.tab });
  }
  // With none chosen, a wide screen shows the most recent project; a phone shows the list.
  const known = (workspaceId: string) => rows.some((row) => row.workspaceId === workspaceId) || props.closed.some((entry) => entry.workspaceId === workspaceId);
  const current = chosen !== null && (known(chosen.workspaceId) || props.workspaces === undefined) ? chosen : compact ? null : rows[0] === undefined ? null : { workspaceId: rows[0].workspaceId, tab: "overview" as ProjectTab };
  const surface: PluginSurfaceProps = props.surface ?? {
    theme,
    host: { id: "paseo-bm", label: "Beads Manager" },
    layout: { compact, platform: Platform.OS === "ios" || Platform.OS === "android" ? Platform.OS : "web" },
  };
  const openAgent = surface.navigation?.openAgent;
  // The page shows beside the list, so choosing a project stays on this screen (`onOpen` is not called).
  const open = (workspaceId: string) => {
    const closed = props.closed.find((entry) => entry.workspaceId === workspaceId);
    // A closed workspace opens on Requests, where its history's actions are.
    setChosen({ workspaceId, tab: closed === undefined ? "overview" : "requests" });
  };
  const list = (
    <WorkList
      rows={rows}
      closed={props.closed}
      loading={props.workspaces === undefined && props.workspacesError === null}
      error={props.workspacesError}
      footer={props.footer}
      selectedId={current?.workspaceId ?? null}
      onOpen={open}
      compact={compact}
      theme={theme}
    />
  );
  const row = current === null ? undefined : rows.find((entry) => entry.workspaceId === current.workspaceId);
  const closedEntry = current === null ? undefined : props.closed.find((entry) => entry.workspaceId === current.workspaceId);
  const page =
    current === null ? null : (
      <ProjectPage
        key={`${current.workspaceId}:${current.tab}`}
        {...surface}
        workspaceId={current.workspaceId}
        label={row?.label ?? closedEntry?.label ?? current.workspaceId}
        initialTab={current.tab}
        {...(closedEntry === undefined ? {} : { closed: closedEntry.state })}
        {...(compact ? { onBack: () => setChosen(null), backLabel: "Back to Projects" } : {})}
        status={props.status}
        // A closed workspace has history only: no Manager to chat with.
        onChat={openAgent === undefined || closedEntry !== undefined ? undefined : () => void managerLauncher.launch(current.workspaceId, { ensure, openAgent })}
        chatBusy={launcher.status === "pending" && launcher.workspaceId === current.workspaceId}
        onOpenSettings={props.onOpenSettings}
      />
    );
  if (compact) return <View style={{ flex: 1, backgroundColor: theme.colors.surface0 }}>{page ?? <>{props.status}{list}</>}</View>;
  return (
    <View style={{ flex: 1, flexDirection: "row", backgroundColor: theme.colors.surface0 }}>
      {list}
      <View style={{ flex: 1, minWidth: 0 }}>
        {page ?? (
          <View style={{ paddingVertical: 28, paddingHorizontal: 36, gap: 16 }}>
            {props.status}
            <Text style={{ fontSize: 14, color: theme.colors.foregroundMuted }}>Choose a project to see its page.</Text>
          </View>
        )}
      </View>
    </View>
  );
}

/** One request with its detail, read when its timeline opens (and while it moves). */
function RequestCardContainer({
  workspaceId,
  traceId,
  summary,
  decisions,
  expanded,
  onToggle,
  onChanged,
  openAgent,
  onWhy,
  compact,
  styles,
  theme,
}: {
  workspaceId: string;
  traceId: string;
  summary: RequestSummary;
  decisions: readonly Decision[];
  expanded: boolean;
  onToggle: () => void;
  /** After the request's history was deleted: the list is read again. */
  onChanged: () => void;
  openAgent?: (agentId: string) => void;
  onWhy?: () => void;
  compact: boolean;
  styles: Styles;
  theme: Theme;
}) {
  const getTrace = useRpc(tracesGetRpc);
  const readAgents = useRpc(tracesAgentsRpc);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const live = summary.state === "running" || summary.state === "waiting_user";
  const detail = useQuery({
    queryKey: workQueryKeys.trace(workspaceId, traceId),
    queryFn: async () => (await getTrace({ workspaceId, traceId })).trace,
    // Details name what each agent ran on, so opening them reads the detail too.
    enabled: expanded || detailsOpen,
    refetchInterval: expanded && live ? WORK_POLL_MS : false,
  });
  const figures = useQuery({
    queryKey: workQueryKeys.tokens(workspaceId, traceId),
    queryFn: async () => (await readAgents({ workspaceId, traceId })).agents,
    enabled: detailsOpen,
    refetchInterval: detailsOpen && live ? WORK_POLL_MS : false,
  });
  const now = new Date();
  const view = requestCardView(summary, detail.data ?? null, decisions, now);
  return (
    <RequestCard
      view={view}
      expanded={expanded}
      timeline={detail.data === undefined ? null : timelineEvents(detail.data, decisions, now)}
      loading={detail.isPending}
      error={detail.isError && detail.data === undefined ? `Could not read the timeline. ${errorMessageOf(detail.error)}` : null}
      detailsOpen={detailsOpen}
      onToggle={onToggle}
      onToggleDetails={() => setDetailsOpen(!detailsOpen)}
      onOpenAgent={openAgent}
      onWhy={onWhy}
      detailsExtra={
        <TraceActions theme={theme} compact={compact} styles={styles} workspaceId={workspaceId} scope="trace" traceId={traceId} onDone={onChanged} />
      }
      tokens={requestTokenFigures(summary, figures.data, figures.isError && figures.data === undefined ? errorMessageOf(figures.error) : null)}
      compact={compact}
      styles={styles}
      theme={theme}
    />
  );
}

/**
 * The history of a closed workspace, above its requests: what can be done with
 * it — delete it, or move it onto a workspace that exists when Paseo no longer
 * has this one (`orphaned`) — each behind its own confirmation.
 */
function ClosedHistory({
  workspaceId,
  state,
  onChanged,
  compact,
  styles,
  theme,
}: {
  workspaceId: string;
  state: StoredWorkspace["state"];
  onChanged: () => void;
  compact: boolean;
  styles: Styles;
  theme: Theme;
}) {
  return (
    <View style={[styles.card, { gap: 6 }]}>
      <Text style={styles.sectionTitle}>History of a closed workspace</Text>
      <Text style={styles.body}>
        {state === "archived"
          ? "This workspace is archived in Paseo. Its requests stay here until you delete them."
          : "Paseo no longer has this workspace. Its requests stay here until you delete them or move them onto a workspace that exists."}
      </Text>
      <TraceActions theme={theme} compact={compact} styles={styles} workspaceId={workspaceId} scope="workspace" workspaceState={state} onDone={onChanged} />
    </View>
  );
}

function RequestsTab({
  workspaceId,
  closed,
  openAgent,
  compact,
  styles,
  theme,
}: {
  workspaceId: string;
  /** Set for a workspace Paseo no longer lists. */
  closed?: StoredWorkspace["state"];
  openAgent?: (agentId: string) => void;
  compact: boolean;
  styles: Styles;
  theme: Theme;
}) {
  const listTraces = useRpc(tracesListRpc);
  const listDecisions = useRpc(decisionsListRpc);
  const queryClient = useQueryClient();
  const traces = useQuery({
    queryKey: workQueryKeys.traces(workspaceId),
    queryFn: () => listTraces({ workspaceId }),
    refetchInterval: WORK_POLL_MS,
  });
  const decisions = useQuery({
    queryKey: workQueryKeys.decisions(workspaceId),
    queryFn: () => listDecisions({ scope: "workspace", workspaceId, limit: DECISION_LIST_MAX }),
    refetchInterval: WORK_POLL_MS,
  });
  const summaries = useMemo(() => requestSummaries(traces.data?.traces ?? []), [traces.data]);
  // Null until the owner opens or closes one: the newest starts open.
  const [chosen, setChosen] = useState<ReadonlySet<string> | null>(null);
  // Why? (autonomy design §E.2): the request whose chain shows in place of the list; ← returns to it.
  const [why, setWhy] = useState<string | null>(null);
  // A request with no id has no chain to show.
  const whyOf = (requestId: string | null) => (requestId === null ? undefined : () => setWhy(requestId));
  const opening = summaries[0]?.traceId;
  const open = chosen ?? new Set(opening === undefined ? [] : [opening]);
  const toggle = (traceId: string) => {
    const next = new Set(open);
    if (next.has(traceId)) next.delete(traceId);
    else next.add(traceId);
    setChosen(next);
  };
  const decided = decisions.data?.decisions ?? [];
  // A deletion or a move changes the list and every request read from it.
  const changed = () => {
    void queryClient.invalidateQueries({ queryKey: workQueryKeys.traces(workspaceId) });
    void queryClient.invalidateQueries({ queryKey: ["paseo-bm", "work", "trace", workspaceId] });
    void queryClient.invalidateQueries({ queryKey: ["paseo-bm", "work", "tokens", workspaceId] });
  };
  const card = (summary: RequestSummary) => (
    <RequestCardContainer
      key={summary.traceId}
      workspaceId={workspaceId}
      traceId={summary.traceId}
      summary={summary}
      decisions={decided}
      expanded={open.has(summary.traceId)}
      onToggle={() => toggle(summary.traceId)}
      onChanged={changed}
      openAgent={openAgent}
      onWhy={whyOf(summary.requestId)}
      compact={compact}
      styles={styles}
      theme={theme}
    />
  );

  if (why !== null) return <WhyScreen workspaceId={workspaceId} requestId={why} onBack={() => setWhy(null)} compact={compact} theme={theme} />;

  return (
    <ScrollView style={styles.screen} contentContainerStyle={{ paddingTop: compact ? 16 : 24, paddingHorizontal: compact ? 16 : 36, paddingBottom: 64 }}>
      <View style={column(compact, styles.content.gap)}>
        {traces.isError ? (
          <ToneText tone="danger" styles={styles} theme={theme}>{`Could not read the requests. ${errorMessageOf(traces.error)}`}</ToneText>
        ) : null}
        {decisions.isError ? (
          <ToneText tone="danger" styles={styles} theme={theme}>{`Could not read the decisions. ${errorMessageOf(decisions.error)}`}</ToneText>
        ) : null}
        {closed === undefined ? null : (
          <ClosedHistory workspaceId={workspaceId} state={closed} onChanged={changed} compact={compact} styles={styles} theme={theme} />
        )}
        {traces.isPending ? <ActivityIndicator color={styles.spinner.color} accessibilityLabel="Reading the requests" /> : null}
        {traces.data !== undefined && summaries.length === 0 ? <Text style={styles.body}>{NO_REQUESTS_TEXT}</Text> : null}
        {summaries.map(card)}
        {traces.data?.nextCursor == null ? null : (
          <Text style={styles.body}>{`Showing the ${summaries.length} newest requests.`}</Text>
        )}
      </View>
    </ScrollView>
  );
}

/** The Requests table's column widths on a wide screen: Size, State, Worker, Tokens (the request takes the rest). */
const REQUEST_COLUMN_WIDTHS = [90, 120, 110, 90] as const;

/** The Overview's Requests table: a header row, then a row per request divided by 1px rules. Hook-free. */
export function OverviewRequestsTable({ rows, onOpen, compact, theme }: { rows: readonly OverviewRequestRow[]; onOpen: () => void; compact: boolean; theme: Theme }) {
  const { colors } = theme;
  const head = { fontSize: 12, fontWeight: "500" as const, textTransform: "uppercase" as const, letterSpacing: 0.72, color: colors.foregroundMuted };
  if (compact) {
    return (
      <View style={{ borderTopWidth: 1, borderTopColor: colors.border }}>
        {rows.map((row) => (
          <Pressable
            key={row.key}
            accessibilityRole="button"
            accessibilityLabel={`${row.accessibilityLabel}. Open in Requests`}
            onPress={onOpen}
            style={{ gap: 4, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: colors.border }}
          >
            <Text style={{ fontSize: 14, color: colors.foreground }} numberOfLines={2}>
              {row.title}
            </Text>
            <Text style={{ fontSize: 12, color: colors.foregroundMuted }}>
              <Text style={{ color: toneColor(theme, row.state.tone) }}>{row.state.text}</Text>
              {` · ${row.size} · `}
              <Text style={{ fontFamily: MONO }}>{row.worker}</Text>
              {` · ${row.tokens}`}
            </Text>
          </Pressable>
        ))}
      </View>
    );
  }
  const [size, state, worker, tokens] = REQUEST_COLUMN_WIDTHS;
  return (
    <View>
      <View style={{ flexDirection: "row", paddingBottom: 8, borderBottomWidth: 1, borderBottomColor: colors.border }}>
        <Text style={[head, { flex: 1 }]}>{OVERVIEW_REQUEST_COLUMNS[0]}</Text>
        <Text style={[head, { width: size }]}>{OVERVIEW_REQUEST_COLUMNS[1]}</Text>
        <Text style={[head, { width: state }]}>{OVERVIEW_REQUEST_COLUMNS[2]}</Text>
        <Text style={[head, { width: worker }]}>{OVERVIEW_REQUEST_COLUMNS[3]}</Text>
        <Text style={[head, { width: tokens, textAlign: "right" }]}>{OVERVIEW_REQUEST_COLUMNS[4]}</Text>
      </View>
      {rows.map((row) => (
        <Pressable
          key={row.key}
          accessibilityRole="button"
          accessibilityLabel={`${row.accessibilityLabel}. Open in Requests`}
          onPress={onOpen}
          style={{ flexDirection: "row", alignItems: "center", paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: colors.border }}
        >
          <Text style={{ flex: 1, minWidth: 0, fontSize: 14, color: colors.foreground, paddingRight: 12 }} numberOfLines={1}>
            {row.title}
          </Text>
          <Text style={{ width: size, fontSize: 14, color: colors.foreground }}>{row.size}</Text>
          <Text style={{ width: state, fontSize: 14, color: toneColor(theme, row.state.tone) }} numberOfLines={1}>
            {row.state.text}
          </Text>
          <Text style={{ width: worker, fontFamily: MONO, fontSize: 12, color: colors.foreground }}>{row.worker}</Text>
          <Text style={{ width: tokens, textAlign: "right", fontFamily: MONO, fontSize: 14, color: colors.foreground }}>{row.tokens}</Text>
        </Pressable>
      ))}
    </View>
  );
}

/** The Overview's How the work ran: three cells in one bordered box. Hook-free. */
function ProcessCells({ cells, compact, theme }: { cells: ProjectOverviewView["process"]; compact: boolean; theme: Theme }) {
  const { colors } = theme;
  return (
    <View style={{ flexDirection: compact ? "column" : "row", borderWidth: 1, borderColor: colors.border }}>
      {cells.map((cell, index) => (
        <View
          key={cell.label}
          accessibilityLabel={`${cell.label}: ${cell.value}`}
          style={{
            flex: compact ? undefined : 1,
            gap: 4,
            paddingVertical: 14,
            paddingHorizontal: 18,
            ...(index === 0 ? {} : compact ? { borderTopWidth: 1, borderTopColor: colors.border } : { borderLeftWidth: 1, borderLeftColor: colors.border }),
          }}
        >
          <Text style={{ fontSize: 13, color: colors.foregroundMuted }}>{cell.label}</Text>
          <Text style={{ fontSize: 18, fontWeight: "600", color: colors.foreground }}>{cell.value}</Text>
        </View>
      ))}
    </View>
  );
}

/**
 * The Overview tab but its data (the Projects artboard): the four figures in
 * one strip, Tokens by role, the Requests table with the older finished ones
 * counted, and How the work ran. The autonomy level is the page header's.
 * Hook-free.
 */
export function ProjectOverviewBody({
  view,
  error,
  onRequests,
  compact,
  styles,
  theme,
}: {
  view: ProjectOverviewView;
  /** Why the figures could not be read; null when they could (or are still being read). */
  error: string | null;
  onRequests: () => void;
  compact: boolean;
  styles: Styles;
  theme: Theme;
}) {
  const { colors } = theme;
  const muted = { fontSize: 13, color: colors.foregroundMuted };
  const textButton = (label: string, a11y: string) => (
    <Pressable accessibilityRole="button" accessibilityLabel={a11y} onPress={onRequests} style={{ alignSelf: "flex-start", paddingVertical: 4 }}>
      <Text style={{ fontSize: 14, color: colors.foregroundMuted }}>{label}</Text>
    </Pressable>
  );
  return (
    <View style={{ gap: 28 }}>
      {error === null ? null : <ToneText tone="danger" styles={styles} theme={theme}>{`Could not read the figures. ${error}`}</ToneText>}
      <FigureStrip
        cells={view.figures.map((figure) => ({
          label: figure.label,
          value: figure.value,
          ...(figure.label === "Waiting on you" && figure.value !== "—" ? { valueColor: colors.statusWarning } : {}),
        }))}
        compact={compact}
        theme={theme}
      />
      <View style={{ gap: 12 }}>
        <SectionHeading title={OVERVIEW_TOKENS_TITLE} tail={view.tokensScope} theme={theme} />
        {view.tokensEmpty !== null ? <Text style={muted}>{view.tokensEmpty}</Text> : <RoleTokenBars rows={view.tokensByRole} theme={theme} />}
      </View>
      <View>
        <View style={{ marginBottom: 12 }}>
          <SectionHeading title={OVERVIEW_OPEN_TITLE} theme={theme} />
        </View>
        {view.requests === null ? <ActivityIndicator color={styles.spinner.color} accessibilityLabel="Reading the requests" /> : null}
        {view.requests !== null && view.requests.length === 0 ? <Text style={muted}>{OVERVIEW_NO_OPEN}</Text> : null}
        {view.requests === null || view.requests.length === 0 ? null : <OverviewRequestsTable rows={view.requests} onOpen={onRequests} compact={compact} theme={theme} />}
        <View style={{ flexDirection: "row", flexWrap: "wrap", columnGap: 20, marginTop: 12 }}>
          {view.more === null ? null : textButton(view.more, "Open the other open requests in Requests")}
          {view.older === null ? null : textButton(view.older, "Open the older finished requests in Requests")}
          {view.older === null && view.more === null ? textButton(ALL_REQUESTS_LABEL, "Open every request of this project") : null}
        </View>
      </View>
      <View style={{ gap: 10 }}>
        <SectionHeading title={OVERVIEW_PROCESS_TITLE} theme={theme} />
        <ProcessCells cells={view.process} compact={compact} theme={theme} />
      </View>
    </View>
  );
}

/** The Overview tab: the Requests tab's reads (shared by key), the coordinator's facts and the project's summary over the default period. */
function OverviewTab({
  workspaceId,
  onRequests,
  compact,
  styles,
  theme,
}: {
  workspaceId: string;
  onRequests: () => void;
  compact: boolean;
  styles: Styles;
  theme: Theme;
}) {
  const listTraces = useRpc(tracesListRpc);
  const listDecisions = useRpc(decisionsListRpc);
  const readSummary = useRpc(insightsSummaryRpc);
  const getState = useRpc(orchestratorStateRpc);
  const traces = useQuery({
    queryKey: workQueryKeys.traces(workspaceId),
    queryFn: () => listTraces({ workspaceId }),
    refetchInterval: WORK_POLL_MS,
  });
  const decisions = useQuery({
    queryKey: workQueryKeys.decisions(workspaceId),
    queryFn: () => listDecisions({ scope: "workspace", workspaceId, limit: DECISION_LIST_MAX }),
    refetchInterval: WORK_POLL_MS,
  });
  // The Metrics tab's own query for its opening window: one read for both.
  const summary = useQuery({
    queryKey: insightsQueryKey(INSIGHTS_DEFAULT_WINDOW, workspaceId),
    queryFn: () => readSummary({ window: INSIGHTS_DEFAULT_WINDOW, workspaceId }),
    staleTime: INSIGHTS_STALE_MS,
  });
  // The project rows' own query: a stalled project names the request that stalled.
  const projects = useQuery({ queryKey: workQueryKeys.projects, queryFn: () => getState({}), refetchInterval: WORK_POLL_MS });
  const project = projects.data?.projects.find((entry) => entry.workspaceId === workspaceId);
  const requests = useMemo(() => (traces.data === undefined ? undefined : requestSummaries(traces.data.traces)), [traces.data]);
  const view = projectOverviewView({
    summary: summary.data,
    window: INSIGHTS_DEFAULT_WINDOW,
    requests,
    decisions: decisions.data?.decisions,
    stalledRequestId: project?.state === "stalled" ? (project.currentRequest?.requestId ?? null) : null,
    now: new Date(),
  });
  const error = summary.isError ? errorMessageOf(summary.error) : traces.isError ? errorMessageOf(traces.error) : null;
  return <ProjectOverviewBody view={view} error={error} onRequests={onRequests} compact={compact} styles={styles} theme={theme} />;
}

function AgentsTab({
  workspaceId,
  openAgent,
  compact,
  styles,
  theme,
}: {
  workspaceId: string;
  openAgent?: (input: { agentId: string }) => void;
  compact: boolean;
  styles: Styles;
  theme: Theme;
}) {
  const listAgents = useRpc(agentsListRpc);
  const readAgents = useRpc(tracesAgentsRpc);
  // The same query the workspace's agent panel reads, so both show one answer.
  const agents = useQuery({
    queryKey: ["paseo-bm", "agent-tree", "agents", workspaceId],
    queryFn: async () => (await listAgents({ workspaceId })).agents,
    refetchInterval: AGENT_TREE_POLL_MS,
  });
  // Each agent's tokens and context over its life (autonomy design §G.2), read while the tab shows.
  const figures = useQuery({
    queryKey: workQueryKeys.tokens(workspaceId),
    queryFn: async () => (await readAgents({ workspaceId })).agents,
    refetchInterval: WORK_POLL_MS,
  });
  const tokens = agentTokenFigures(figures.data, agents.data, figures.isError && figures.data === undefined ? errorMessageOf(figures.error) : null);
  return (
    <AgentTreeView theme={theme} compact={compact} agents={toLoadable(agents)} openAgent={openAgent} onRetryAgents={() => void agents.refetch()}>
      {agents.isError && agents.data === undefined ? null : (
        <View style={{ paddingTop: 8 }}>
          <TokenFigures state={tokens} compact={compact} styles={styles} theme={theme} />
        </View>
      )}
    </AgentTreeView>
  );
}

export interface ProjectPageProps extends PluginSurfaceProps {
  workspaceId: string;
  /** The project's title: the workspace and its project; null in the workspace's own Beads tab. */
  label: string | null;
  initialTab: ProjectTab;
  /** Set for a workspace Paseo no longer lists: its Requests tab offers what can be done with its history. */
  closed?: StoredWorkspace["state"];
  onBack?: () => void;
  backLabel?: string;
  /** The Beads Manager surface's status strip. */
  status?: ReactNode;
  /** Opens the project's Beads Manager chat; undefined on a host that cannot open agents. */
  onChat?: () => void;
  chatBusy?: boolean;
  /** Opens Settings, where the autonomy level is set; undefined where the page cannot (the workspace's own Beads tab). */
  onOpenSettings?: () => void;
}

/** The main pane's padding and width (the Projects artboard: 28 / 36 / 64, at most 1000 wide); Beads uses the full width. */
const PANE = { top: 28, side: 36, bottom: 64, width: 1000 } as const;

/** A project: Overview · Requests · Beads · Metrics · Agents under one header. */
export function ProjectPage(props: ProjectPageProps) {
  const { workspaceId, label, initialTab, closed, onBack, backLabel, status, onChat, chatBusy, onOpenSettings, ...surface } = props;
  const { theme, layout, navigation } = surface;
  const compact = layout.compact;
  const styles = useMemo(() => dashboardStyles(theme, compact), [theme, compact]);
  const [tab, setTab] = useState<ProjectTab>(initialTab);
  // The Metrics period, chosen in the header (the ProjectMetrics artboard).
  const [window, setWindow] = useState<InsightsWindow>(INSIGHTS_DEFAULT_WINDOW);
  const readPolicy = useRpc(autonomyPolicyRpc);
  // Settings reads and writes this same query, so a level set there shows here.
  const policy = useQuery({ queryKey: AUTONOMY_POLICY_KEY, queryFn: () => readPolicy({}) });
  const directories = useDirectories();
  const openAgent = navigation?.openAgent;
  const side = compact ? 16 : PANE.side;
  const width = tab === "beads" ? undefined : PANE.width + 2 * side;
  const scrolled = (body: ReactNode) => (
    <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingTop: compact ? 16 : PANE.top, paddingHorizontal: side, paddingBottom: PANE.bottom }}>
      <View style={{ width: "100%", maxWidth: PANE.width }}>{body}</View>
    </ScrollView>
  );
  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.surface0 }}>
      <View style={{ paddingHorizontal: side, paddingTop: compact ? 16 : PANE.top, width: "100%", maxWidth: width }}>
        <ProjectHeader
          label={label}
          directory={directories.get(workspaceId) ?? null}
          tab={tab}
          onTab={setTab}
          onBack={onBack}
          backLabel={backLabel}
          status={status}
          onChat={onChat}
          chatBusy={chatBusy === true}
          level={levelNameOf(policy.data?.levels, workspaceId)}
          onOpenSettings={onOpenSettings}
          extra={
            tab === "metrics" ? (
              <Segmented segments={WINDOW_SEGMENTS} selected={window} onSelect={(key) => setWindow(key as InsightsWindow)} theme={theme} />
            ) : null
          }
          theme={theme}
        />
      </View>
      <View style={{ flex: 1 }}>
        {tab === "overview" ? (
          scrolled(<OverviewTab workspaceId={workspaceId} onRequests={() => setTab("requests")} compact={compact} styles={styles} theme={theme} />)
        ) : tab === "requests" ? (
          <RequestsTab
            workspaceId={workspaceId}
            closed={closed}
            openAgent={openAgent === undefined ? undefined : (agentId) => openAgent({ agentId })}
            compact={compact}
            styles={styles}
            theme={theme}
          />
        ) : tab === "beads" ? (
          <BeadsScreen {...surface} workspaceId={workspaceId} />
        ) : tab === "metrics" ? (
          scrolled(<ProjectMetrics workspaceId={workspaceId} label={label} window={window} compact={compact} theme={theme} />)
        ) : (
          <AgentsTab workspaceId={workspaceId} openAgent={openAgent} compact={compact} styles={styles} theme={theme} />
        )}
      </View>
    </View>
  );
}
