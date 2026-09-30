/**
 * Work (experience concept §4.2, autonomy design §A.12): the projects, and a
 * project's page with its Requests, Beads and Agents. What is shown and in
 * which order is `work-model.ts`; this file reads the data and draws it.
 *
 * - `WorkScreen`: one row per workspace (most recent activity first) with the
 *   running dot, the current request, its stage, the agents and when it last
 *   moved. `orchestrator.state` is read every `WORK_POLL_MS` only while the
 *   rows show (the screen is mounted only then).
 * - `ProjectPage`: Requests (a stage bar, evidence lines and a timeline per
 *   request, from `traces.list`, `traces.get` and `decisions.list`), Beads (the
 *   board, `beads-screen.tsx`) and Agents (the tree, `tree.tsx`). A request's
 *   Details offer to delete its history; the Requests tab of a closed
 *   workspace (archived, or removed from Paseo) offers to delete its history
 *   or, once removed, to move it onto a workspace that exists
 *   (`dashboard-actions.tsx`, each behind its own confirmation).
 *
 * Layout: `layout.compact` (a phone) puts a row on two lines, draws the stage
 * bar as five segments with its stage written under them, stacks the evidence
 * lines, and puts a timeline event's time and tag above its text. A wide screen
 * keeps a row on one line, writes the five stages with the current one bold,
 * puts the evidence lines side by side and the timeline in columns, all in a
 * column of readable width.
 *
 * Client rules: React Native primitives only, colours from the theme
 * (`toneColor`), accessibility roles and labels on every pressable, ids only
 * under Details.
 */
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState, type ReactNode } from "react";
import { ActivityIndicator, Pressable, ScrollView, Text, View } from "react-native";
import {
  DECISION_LIST_MAX,
  agentsListRpc,
  decisionsListRpc,
  orchestratorStateRpc,
  tracesGetRpc,
  tracesListRpc,
  type WorkspaceOverview,
} from "../shared/contracts";
import type { Decision } from "../shared/decisions";
import { AGENT_TREE_POLL_MS } from "./agent-tree";
import { BeadsScreen } from "./beads-screen";
import { TraceActions } from "./dashboard-actions";
import { dashboardStyles, toneColor } from "./dashboard-model";
import { errorMessageOf } from "./launch-manager";
import type { ClosedWorkspace, StoredWorkspace } from "./surface-view";
import { AgentTreeView, toLoadable } from "./tree";
import { StatusTabs, WorkspaceScreenHeader, type Styles, type Theme } from "./ui";
import {
  NO_REQUESTS_TEXT,
  PROJECT_TABS,
  WORK_POLL_MS,
  requestCardView,
  requestSummaries,
  timelineEvents,
  workRows,
  type EvidenceLine,
  type ProjectTab,
  type RequestCardView,
  type RequestSummary,
  type StageBarView,
  type TimelineEvent,
  type WorkRowView,
  type WorkspaceEntry,
} from "./work-model";

/** Widest a Work column grows on a large screen, so a line stays readable. */
const WIDE_COLUMN = 1100;

export const workQueryKeys = {
  projects: ["paseo-bm", "work", "projects"] as const,
  traces: (workspaceId: string) => ["paseo-bm", "work", "traces", workspaceId] as const,
  trace: (workspaceId: string, traceId: string) => ["paseo-bm", "work", "trace", workspaceId, traceId] as const,
  decisions: (workspaceId: string) => ["paseo-bm", "work", "decisions", workspaceId] as const,
};

function column(compact: boolean, gap: number) {
  return { gap, width: "100%" as const, maxWidth: compact ? undefined : WIDE_COLUMN, alignSelf: "center" as const };
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
        <Text key={agent.letter} style={[styles.badge, { color: toneColor(theme, agent.tone) }]}>
          {agent.letter}
        </Text>
      ))}
    </View>
  );
}

/** One project: two lines on a phone, one line on a wide screen. The whole row opens the project. */
export function WorkRowItem({
  row,
  dot,
  onOpen,
  compact,
  styles,
  theme,
}: {
  row: WorkRowView;
  dot: ReactNode;
  onOpen: () => void;
  compact: boolean;
  styles: Styles;
  theme: Theme;
}) {
  const name = (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flexShrink: 1, width: compact ? undefined : "26%" }}>
      <Text style={[styles.sectionTitle, { flexShrink: 1 }]} numberOfLines={1}>
        {row.label}
      </Text>
      {dot}
    </View>
  );
  const status = (
    <Text style={[styles.body, { color: toneColor(theme, row.status.tone) }]} numberOfLines={1}>
      {row.status.text}
    </Text>
  );
  const request =
    row.request === null ? null : (
      <Text style={[styles.body, { color: theme.colors.foreground, flexShrink: 1 }]} numberOfLines={1}>
        {row.request}
      </Text>
    );
  const beads = row.beads === null ? null : <Text style={styles.body}>{row.beads}</Text>;
  const time = row.time === null ? null : <Text style={styles.body}>{row.time}</Text>;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={row.accessibilityLabel}
      onPress={onOpen}
      style={[styles.card, { gap: 4 }]}
    >
      {compact ? (
        <>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            {name}
            <View style={{ flex: 1 }} />
            {time}
          </View>
          <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
            {request}
            {status}
            <AgentMarks agents={row.agents} styles={styles} theme={theme} />
            {beads}
          </View>
        </>
      ) : (
        <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
          {name}
          <View style={{ flex: 1 }}>{request ?? <Text style={styles.body} numberOfLines={1}>{row.detail}</Text>}</View>
          {status}
          {beads}
          <AgentMarks agents={row.agents} styles={styles} theme={theme} />
          <View style={{ minWidth: 72, alignItems: "flex-end" }}>{time}</View>
        </View>
      )}
    </Pressable>
  );
}

/** The Work list: the projects, then the history of workspaces Paseo no longer lists. */
export function WorkList({
  rows,
  closed,
  loading,
  error,
  status,
  footer,
  renderDot,
  onOpen,
  compact,
  styles,
  theme,
}: {
  rows: readonly WorkRowView[];
  closed: readonly ClosedWorkspace[];
  loading: boolean;
  error: string | null;
  status?: ReactNode;
  footer?: string;
  renderDot: (workspaceId: string) => ReactNode;
  onOpen: (workspaceId: string, label: string) => void;
  compact: boolean;
  styles: Styles;
  theme: Theme;
}) {
  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <View style={column(compact, styles.content.gap)}>
        {status}
        {loading ? <ActivityIndicator color={styles.spinner.color} accessibilityLabel="Reading the projects" /> : null}
        {error === null ? null : (
          <Text style={[styles.body, { color: toneColor(theme, "danger") }]}>{`Could not load the workspaces. ${error}`}</Text>
        )}
        {!loading && error === null && rows.length === 0 ? <Text style={styles.body}>No workspaces on this host yet.</Text> : null}
        {rows.map((row) => (
          <WorkRowItem
            key={row.workspaceId}
            row={row}
            dot={renderDot(row.workspaceId)}
            onOpen={() => onOpen(row.workspaceId, row.label)}
            compact={compact}
            styles={styles}
            theme={theme}
          />
        ))}
        {closed.length === 0 ? null : (
          <Text accessibilityRole="header" style={[styles.sectionTitle, { marginTop: 8 }]}>
            Closed workspaces with history
          </Text>
        )}
        {closed.map((entry) => (
          <Pressable
            key={entry.workspaceId}
            accessibilityRole="button"
            accessibilityLabel={`Open the requests of the closed workspace ${entry.label}`}
            onPress={() => onOpen(entry.workspaceId, entry.label)}
            style={[styles.card, { gap: 2 }]}
          >
            <Text style={styles.sectionTitle} numberOfLines={1}>
              {entry.label}
            </Text>
            <Text style={styles.body} numberOfLines={compact ? 2 : 1}>
              {entry.detail}
            </Text>
          </Pressable>
        ))}
        {footer === undefined ? null : <Text style={[styles.body, { fontSize: 11, marginTop: 8 }]}>{footer}</Text>}
      </View>
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
                borderRadius: 2,
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
        <Text key={line.key} style={[styles.body, { color: toneColor(theme, line.tone) }]}>
          {`${line.mark} ${line.text}`}
        </Text>
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
            <Text style={[styles.body, { color: toneColor(theme, event.tone) }]}>{event.text}</Text>
          </View>
        ) : (
          <View key={event.key} style={{ flexDirection: "row", alignItems: "flex-start", gap: 10 }}>
            <Text style={[styles.body, { width: 92 }]}>{event.time}</Text>
            <Text style={[styles.body, { flex: 1, color: toneColor(theme, event.tone) }]}>{event.text}</Text>
            {event.tag === null ? null : <Text style={[styles.badge, { color: toneColor(theme, "muted") }]}>{event.tag}</Text>}
          </View>
        ),
      )}
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
      <Text style={[styles.body, { color: toneColor(theme, "info") }]}>{label}</Text>
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
  detailsExtra,
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
  /** Drawn under the ids while Details is open: the request's history actions. */
  detailsExtra?: ReactNode;
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
        <Text style={[styles.body, { color: toneColor(theme, "danger") }]}>{error}</Text>
      ) : timeline === null ? (
        loading ? <ActivityIndicator color={styles.spinner.color} accessibilityLabel="Reading the timeline" /> : null
      ) : (
        <TimelineList events={timeline} compact={compact} styles={styles} theme={theme} />
      )}
      {detailsOpen ? (
        <View style={[styles.card, { backgroundColor: theme.colors.surface0, gap: 2 }]}>
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

/** The project page's first rows: ←, the project, Chat, and the three tabs. */
export function ProjectHeader({
  label,
  tab,
  onTab,
  onBack,
  backLabel,
  status,
  onChat,
  chatBusy,
  styles,
}: {
  /** Null in a workspace's own Beads tab, which already lives in its workspace. */
  label: string | null;
  tab: ProjectTab;
  onTab: (tab: ProjectTab) => void;
  onBack?: () => void;
  backLabel?: string;
  status?: ReactNode;
  onChat?: () => void;
  chatBusy: boolean;
  styles: Styles;
}) {
  return (
    <>
      <WorkspaceScreenHeader
        title={label}
        onBack={onBack}
        backLabel={backLabel ?? "Back"}
        status={status}
        styles={styles}
        right={
          onChat === undefined ? null : (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={label === null ? "Chat with the Beads Manager of this project" : `Chat with the Beads Manager of ${label}`}
              accessibilityState={{ disabled: chatBusy, busy: chatBusy }}
              disabled={chatBusy}
              onPress={onChat}
              style={[styles.secondaryButton, { opacity: chatBusy ? 0.5 : 1 }]}
            >
              <Text style={styles.secondaryButtonText}>{chatBusy ? "Opening…" : "Chat ▸"}</Text>
            </Pressable>
          )
        }
      />
      <StatusTabs tabs={PROJECT_TABS} selected={tab} onSelect={(key) => onTab(key as ProjectTab)} styles={styles} />
    </>
  );
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
  renderDot: (workspaceId: string) => ReactNode;
  onOpen: (workspaceId: string, label: string) => void;
}

/** Work's own screen: the project rows. Mounted only while it shows, so the projects are read only then. */
export function WorkScreen(props: WorkScreenProps) {
  const { theme, compact } = props;
  const styles = useMemo(() => dashboardStyles(theme, compact), [theme, compact]);
  const getState = useRpc(orchestratorStateRpc);
  const projects = useQuery({ queryKey: workQueryKeys.projects, queryFn: () => getState({}), refetchInterval: WORK_POLL_MS });
  const rows = workRows({
    workspaces: props.workspaces ?? [],
    projects: projects.data?.projects ?? null,
    overview: props.overview,
    now: new Date(),
  });
  return (
    <WorkList
      rows={rows}
      closed={props.closed}
      loading={props.workspaces === undefined && props.workspacesError === null}
      error={props.workspacesError}
      status={props.status}
      footer={props.footer}
      renderDot={props.renderDot}
      onOpen={props.onOpen}
      compact={compact}
      styles={styles}
      theme={theme}
    />
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
  compact: boolean;
  styles: Styles;
  theme: Theme;
}) {
  const getTrace = useRpc(tracesGetRpc);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const live = summary.state === "running" || summary.state === "waiting_user";
  const detail = useQuery({
    queryKey: workQueryKeys.trace(workspaceId, traceId),
    queryFn: async () => (await getTrace({ workspaceId, traceId })).trace,
    // Details name what each agent ran on, so opening them reads the detail too.
    enabled: expanded || detailsOpen,
    refetchInterval: expanded && live ? WORK_POLL_MS : false,
  });
  const view = requestCardView(summary, detail.data ?? null, decisions, new Date());
  return (
    <RequestCard
      view={view}
      expanded={expanded}
      timeline={detail.data === undefined ? null : timelineEvents(detail.data, decisions)}
      loading={detail.isPending}
      error={detail.isError && detail.data === undefined ? `Could not read the timeline. ${errorMessageOf(detail.error)}` : null}
      detailsOpen={detailsOpen}
      onToggle={onToggle}
      onToggleDetails={() => setDetailsOpen(!detailsOpen)}
      onOpenAgent={openAgent}
      detailsExtra={
        <TraceActions theme={theme} compact={compact} styles={styles} workspaceId={workspaceId} scope="trace" traceId={traceId} onDone={onChanged} />
      }
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
      compact={compact}
      styles={styles}
      theme={theme}
    />
  );

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <View style={column(compact, styles.content.gap)}>
        {traces.isError ? (
          <Text style={[styles.body, { color: toneColor(theme, "danger") }]}>{`Could not read the requests. ${errorMessageOf(traces.error)}`}</Text>
        ) : null}
        {decisions.isError ? (
          <Text style={[styles.body, { color: toneColor(theme, "danger") }]}>{`Could not read the decisions. ${errorMessageOf(decisions.error)}`}</Text>
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

function AgentsTab({ workspaceId, openAgent, compact, theme }: { workspaceId: string; openAgent?: (input: { agentId: string }) => void; compact: boolean; theme: Theme }) {
  const listAgents = useRpc(agentsListRpc);
  // The same query the workspace's agent panel reads, so both show one answer.
  const agents = useQuery({
    queryKey: ["paseo-bm", "agent-tree", "agents", workspaceId],
    queryFn: async () => (await listAgents({ workspaceId })).agents,
    refetchInterval: AGENT_TREE_POLL_MS,
  });
  return <AgentTreeView theme={theme} compact={compact} agents={toLoadable(agents)} openAgent={openAgent} onRetryAgents={() => void agents.refetch()} />;
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
}

/** A project: Requests · Beads · Agents under one header. */
export function ProjectPage(props: ProjectPageProps) {
  const { workspaceId, label, initialTab, closed, onBack, backLabel, status, onChat, chatBusy, ...surface } = props;
  const { theme, layout, navigation } = surface;
  const styles = useMemo(() => dashboardStyles(theme, layout.compact), [theme, layout.compact]);
  const [tab, setTab] = useState<ProjectTab>(initialTab);
  const openAgent = navigation?.openAgent;
  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.surface0 }}>
      <View style={{ paddingHorizontal: styles.content.padding, paddingTop: styles.content.padding, gap: styles.content.gap }}>
        <ProjectHeader
          label={label}
          tab={tab}
          onTab={setTab}
          onBack={onBack}
          backLabel={backLabel}
          status={status}
          onChat={onChat}
          chatBusy={chatBusy === true}
          styles={styles}
        />
      </View>
      <View style={{ flex: 1 }}>
        {tab === "requests" ? (
          <RequestsTab
            workspaceId={workspaceId}
            closed={closed}
            openAgent={openAgent === undefined ? undefined : (agentId) => openAgent({ agentId })}
            compact={layout.compact}
            styles={styles}
            theme={theme}
          />
        ) : tab === "beads" ? (
          <BeadsScreen {...surface} workspaceId={workspaceId} />
        ) : (
          <AgentsTab workspaceId={workspaceId} openAgent={openAgent} compact={layout.compact} theme={theme} />
        )}
      </View>
    </View>
  );
}
