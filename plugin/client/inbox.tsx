/**
 * The Inbox (experience concept §4.1, autonomy design §A.12): where Beads
 * Manager opens. What it shows and in which order is `inbox-model.ts`; this
 * file reads the data and draws it.
 *
 * - `useInbox` reads `decisions.list {scope: inbox}`, `inbox.alerts` and
 *   `fallback.incidents` every `INBOX_POLL_MS` **only while the Inbox is
 *   shown** (REQ-111 b), and keeps the last read otherwise, so the Inbox tab's
 *   count stays on the other sections. The surface calls it, because the tab
 *   bar is the surface's. Each read of the list is written into every
 *   decision's own query (`decisionQueryKey`), so the Inbox's cards read
 *   nothing themselves: one list poll, not one poll per card.
 * - A decision card is the chats' `DecisionCard` with `via: "inbox"`: the same
 *   options, the confirmation only for release, data, security and cost
 *   effects (Cancel first), and Close / Keep open for one that needs
 *   confirmation.
 * - Above them, the Orchestrator line (`orchestrator-line.tsx`): the way into
 *   the Orchestrator's chat, or to start it.
 *
 * Layout: `layout.compact` (a phone) gives the tighter paddings and type of
 * `dashboardStyles`, and puts an alert's action under its line; a wide screen
 * keeps the column at a readable width and the action at the line's end.
 *
 * Client rules: React Native primitives only, colours from the theme
 * (`toneColor`), accessibility roles and labels on every pressable.
 */
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { ActivityIndicator, Pressable, ScrollView, Text, View } from "react-native";
import {
  chatPeersRpc,
  decisionsListRpc,
  fallbackActRpc,
  fallbackIncidentsRpc,
  inboxAlertsRpc,
  managerEnsureRpc,
  workspacesOverviewRpc,
  type ChatPeer,
} from "../shared/contracts";
import type { Decision } from "../shared/decisions";
import { DecisionCard, decisionQueryKey } from "./chat-card";
import { dashboardStyles, toneColor } from "./dashboard-model";
import { OVERVIEW_POLL_MS } from "./surface-view";
import {
  INBOX_POLL_MS,
  inboxView,
  sectionHeading,
  type FallbackOutcome,
  type InboxAction,
  type InboxAlertRow,
  type InboxGroup,
  type InboxInput,
  type InboxView,
} from "./inbox-model";
import { errorMessageOf } from "./launch-manager";
import { OrchestratorLine } from "./orchestrator-line";
import type { Styles, Theme } from "./ui";

/** Peers change rarely; one lookup per project group is plenty. */
const PEERS_STALE_MS = 30_000;

export const inboxQueryKeys = {
  decisions: ["paseo-bm", "inbox", "decisions"] as const,
  alerts: ["paseo-bm", "inbox", "alerts"] as const,
  incidents: ["paseo-bm", "inbox", "incidents"] as const,
};

/** A Resend (per incident) or Replace Manager (per workspace) press in flight, or its error. */
export type ResendState = Readonly<Record<string, { busy: boolean; error: string | null }>>;

export interface InboxData {
  /** Null until the decisions have been read once. */
  view: InboxView | null;
  /** What could not be read, one line each. */
  errors: string[];
  /** A decision the owner settled on an Inbox card: it stays in place until the Inbox is left. */
  onSettled: (decision: Decision) => void;
  resend: (incidentId: string) => void;
  resending: ResendState;
  /** Replaces the workspace's outdated Manager, then hands the new Manager's id to `onReplaced`. */
  replaceManager: (workspaceId: string, onReplaced: (agentId: string) => void) => void;
  replacing: ResendState;
}

function pollWhile(visible: boolean, every: number) {
  return { enabled: visible, refetchInterval: visible ? every : (false as const) };
}

/**
 * The Inbox's data, read while `visible` and kept otherwise. `projectOf`
 * names a workspace; `can` says what the surface can open.
 */
export function useInbox({
  visible,
  projectOf,
  can,
}: {
  visible: boolean;
  projectOf: InboxInput["projectOf"];
  can: InboxInput["can"];
}): InboxData {
  const queryClient = useQueryClient();
  const listDecisions = useRpc(decisionsListRpc);
  const listAlerts = useRpc(inboxAlertsRpc);
  const listIncidents = useRpc(fallbackIncidentsRpc);
  const listOverview = useRpc(workspacesOverviewRpc);
  const act = useRpc(fallbackActRpc);
  const ensureManager = useRpc(managerEnsureRpc);
  const [settledHere, setSettledHere] = useState<Decision[]>([]);
  const [resending, setResending] = useState<ResendState>({});
  const [replacing, setReplacing] = useState<ResendState>({});

  // Leaving the Inbox lets the cards settled in it go.
  useEffect(() => {
    if (!visible) setSettledHere([]);
  }, [visible]);

  const decisions = useQuery({
    queryKey: inboxQueryKeys.decisions,
    queryFn: async () => {
      const result = await listDecisions({ scope: "inbox" });
      // Every card of the Inbox reads its decision from here: see `DecisionCard` `poll`.
      for (const decision of result.decisions) queryClient.setQueryData(decisionQueryKey(decision.id), { decision });
      return result;
    },
    ...pollWhile(visible, INBOX_POLL_MS),
  });
  const alerts = useQuery({ queryKey: inboxQueryKeys.alerts, queryFn: () => listAlerts({}), ...pollWhile(visible, INBOX_POLL_MS) });
  const incidents = useQuery({ queryKey: inboxQueryKeys.incidents, queryFn: () => listIncidents({}), ...pollWhile(visible, INBOX_POLL_MS) });

  const base = {
    decisions: decisions.data?.decisions ?? [],
    settledHere,
    alerts: alerts.data?.alerts ?? [],
    alertsTruncated: alerts.data?.truncated ?? false,
    incidents: incidents.data?.incidents ?? [],
    projectOf,
    can,
    now: new Date(),
  };
  const quiet = decisions.data !== undefined && inboxView({ ...base, runningWorkers: null }).empty !== null;
  // The empty Inbox says how many Workers run; read only then (the same query the workspace list reads).
  const overview = useQuery({
    queryKey: ["paseo-bm", "launcher", "overview"],
    queryFn: () => listOverview({}),
    ...pollWhile(visible && quiet, OVERVIEW_POLL_MS),
  });
  const runningWorkers =
    overview.data === undefined ? null : overview.data.workspaces.reduce((sum, workspace) => sum + workspace.runningWorkers, 0);

  const errors = [
    decisions.isError ? `Could not read the decisions: ${errorMessageOf(decisions.error)}` : null,
    alerts.isError ? `Could not read the alerts: ${errorMessageOf(alerts.error)}` : null,
    incidents.isError ? `Could not read the fallback incidents: ${errorMessageOf(incidents.error)}` : null,
  ].filter((line) => line !== null);

  const resend = (incidentId: string) => {
    setResending((current) => ({ ...current, [incidentId]: { busy: true, error: null } }));
    act({ incidentId, action: "resend" }).then(
      () => {
        setResending((current) => Object.fromEntries(Object.entries(current).filter(([id]) => id !== incidentId)));
        void queryClient.invalidateQueries({ queryKey: inboxQueryKeys.incidents });
      },
      (error: unknown) => {
        setResending((current) => ({ ...current, [incidentId]: { busy: false, error: `Could not resend: ${errorMessageOf(error)}` } }));
        void queryClient.invalidateQueries({ queryKey: inboxQueryKeys.incidents });
      },
    );
  };

  const replaceManager = (workspaceId: string, onReplaced: (agentId: string) => void) => {
    setReplacing((current) => ({ ...current, [workspaceId]: { busy: true, error: null } }));
    ensureManager({ workspaceId, replaceOutdated: true }).then(
      (result) => {
        setReplacing((current) => Object.fromEntries(Object.entries(current).filter(([id]) => id !== workspaceId)));
        void queryClient.invalidateQueries({ queryKey: inboxQueryKeys.alerts });
        onReplaced(result.agentId);
      },
      (error: unknown) => {
        setReplacing((current) => ({
          ...current,
          [workspaceId]: { busy: false, error: `Could not replace the Manager: ${errorMessageOf(error)}` },
        }));
      },
    );
  };

  return {
    view: decisions.data === undefined ? null : inboxView({ ...base, runningWorkers }),
    errors,
    onSettled: (decision) => setSettledHere((current) => [...current.filter((entry) => entry.id !== decision.id), decision]),
    resend,
    resending,
    replaceManager,
    replacing,
  };
}

// ---------------------------------------------------------------------------
// Hook-free pieces (tested with test/helpers/element-tree.ts).
// ---------------------------------------------------------------------------

/** A section heading. */
export function InboxHeading({ text, styles }: { text: string; styles: Styles }) {
  return (
    <Text accessibilityRole="header" style={[styles.sectionTitle, { marginTop: 8 }]}>
      {text}
    </Text>
  );
}

/** One button of a follow-up or an alert; `busy` greys it out while its call runs. */
export function InboxActionButton({
  action,
  busy,
  onRun,
  styles,
}: {
  action: InboxAction;
  busy: boolean;
  onRun: (action: InboxAction) => void;
  styles: Styles;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={action.accessibilityLabel}
      accessibilityState={{ disabled: busy, busy }}
      disabled={busy}
      onPress={() => onRun(action)}
      style={[styles.secondaryButton, { opacity: busy ? 0.5 : 1 }]}
    >
      <Text style={styles.secondaryButtonText}>{busy ? "Sending…" : action.label}</Text>
    </Pressable>
  );
}

/** What became of a fallback incident, under its settled card, with what can be done about it. */
export function OutcomeLine({
  outcome,
  resend,
  onRun,
  styles,
  theme,
}: {
  outcome: FallbackOutcome;
  resend: { busy: boolean; error: string | null } | undefined;
  onRun: (action: InboxAction) => void;
  styles: Styles;
  theme: Theme;
}) {
  return (
    <View style={{ gap: 6, marginBottom: 4 }}>
      <Text accessibilityLiveRegion="polite" style={[styles.body, { color: toneColor(theme, outcome.tone) }]}>
        {outcome.text}
      </Text>
      {outcome.action === null ? null : (
        <View style={styles.chipRow}>
          <InboxActionButton action={outcome.action} busy={resend?.busy === true} onRun={onRun} styles={styles} />
        </View>
      )}
      {resend?.error == null ? null : <Text style={[styles.body, { color: toneColor(theme, "danger") }]}>{resend.error}</Text>}
    </View>
  );
}

/**
 * One alert: `● <what happened> · <project>` and its time, the action at the
 * end of the line (under it on a phone), the detail and ids on a tap.
 */
export function AlertRow({
  row,
  expanded,
  onToggle,
  onRun,
  resend,
  compact,
  styles,
  theme,
}: {
  row: InboxAlertRow;
  expanded: boolean;
  onToggle: () => void;
  onRun: (action: InboxAction) => void;
  resend: { busy: boolean; error: string | null } | undefined;
  compact: boolean;
  styles: Styles;
  theme: Theme;
}) {
  return (
    <View style={[styles.card, { gap: 6 }]}>
      <View style={{ flexDirection: compact ? "column" : "row", alignItems: compact ? "stretch" : "center", gap: 8 }}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${row.accessibilityLabel}. ${expanded ? "Hide" : "Show"} the details`}
          accessibilityState={{ expanded }}
          onPress={onToggle}
          style={{ flex: compact ? undefined : 1, flexDirection: "row", gap: 6 }}
        >
          <Text style={[styles.body, { color: toneColor(theme, row.tone) }]}>●</Text>
          <Text style={[styles.body, { flex: 1, color: theme.colors.foreground }]} numberOfLines={expanded ? undefined : 2}>
            {row.text}
          </Text>
          <Text style={styles.body}>{`${row.time} ${expanded ? "▾" : "▸"}`}</Text>
        </Pressable>
        {row.action === null ? null : (
          <View style={styles.chipRow}>
            <InboxActionButton action={row.action} busy={resend?.busy === true} onRun={onRun} styles={styles} />
          </View>
        )}
      </View>
      {resend?.error == null ? null : <Text style={[styles.body, { color: toneColor(theme, "danger") }]}>{resend.error}</Text>}
      {expanded ? (
        <View style={[styles.card, { backgroundColor: theme.colors.surface0, gap: 4 }]}>
          {row.details.map((line, index) => (
            <Text key={`${index}:${line}`} style={styles.mono} selectable>
              {line}
            </Text>
          ))}
        </View>
      ) : null}
    </View>
  );
}

/** The empty Inbox: one sentence, and the way to Work. */
export function EmptyInbox({ sentence, onOpenWork, styles }: { sentence: string; onOpenWork: () => void; styles: Styles }) {
  return (
    <View style={[styles.card, { gap: 10 }]}>
      <Text accessibilityLiveRegion="polite" style={[styles.sectionTitle, { fontWeight: "400" }]}>
        {sentence}
      </Text>
      <View style={styles.chipRow}>
        <Pressable accessibilityRole="button" accessibilityLabel="Open Work: the projects and their requests" onPress={onOpenWork} style={styles.secondaryButton}>
          <Text style={styles.secondaryButtonText}>Open Work</Text>
        </Pressable>
      </View>
    </View>
  );
}

// ---------------------------------------------------------------------------
// The screen.
// ---------------------------------------------------------------------------

/** One project's decisions: its peers name the askers on the cards. */
function InboxGroupView({
  group,
  data,
  onRun,
  styles,
  theme,
  compact,
}: {
  group: InboxGroup;
  data: InboxData;
  onRun: (action: InboxAction) => void;
  styles: Styles;
  theme: Theme;
  compact: boolean;
}) {
  const listPeers = useRpc(chatPeersRpc);
  const peers = useQuery({
    queryKey: ["paseo-bm", "chat-peers", group.peersOf ?? ""],
    queryFn: () => listPeers({ agentId: group.peersOf! }),
    enabled: group.peersOf !== null,
    staleTime: PEERS_STALE_MS,
    retry: false,
  });
  const agents: ChatPeer[] = peers.data === undefined ? [] : [...(peers.data.owner === null ? [] : [peers.data.owner]), ...peers.data.peers];
  const open = group.items.filter((item) => !item.settledHere).length;
  return (
    <View style={{ gap: 4 }}>
      <Text style={[styles.body, { color: theme.colors.foreground, fontWeight: "600" }]} numberOfLines={1}>
        {open === 0 ? group.label : `${group.label} · ${open}`}
      </Text>
      {group.items.map((item) => (
        <View key={item.decision.id}>
          <DecisionCard
            card={item.card}
            via="inbox"
            agents={agents}
            at={new Date(item.decision.askedAt)}
            initial={item.decision}
            poll={false}
            onSettled={data.onSettled}
            theme={theme}
            compact={compact}
          />
          {item.outcome === null ? null : (
            <OutcomeLine
              outcome={item.outcome}
              resend={item.outcome.action?.kind === "resend" ? data.resending[item.outcome.action.incidentId] : undefined}
              onRun={onRun}
              styles={styles}
              theme={theme}
            />
          )}
        </View>
      ))}
    </View>
  );
}

export interface InboxScreenProps extends PluginSurfaceProps {
  data: InboxData;
  /** The surface's status strip (a slash command's notice, the launch state). */
  status?: ReactNode;
  onOpenWork: () => void;
}

export function InboxScreen({ theme, layout, navigation, data, status, onOpenWork }: InboxScreenProps) {
  const styles = useMemo(() => dashboardStyles(theme, layout.compact), [theme, layout.compact]);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const view = data.view;

  const run = (action: InboxAction) => {
    if (action.kind === "open-agent") navigation?.openAgent({ agentId: action.agentId });
    else if (action.kind === "open-project") navigation?.openWorkspace({ workspaceId: action.workspaceId });
    else if (action.kind === "replace-manager") data.replaceManager(action.workspaceId, (agentId) => navigation?.openAgent({ agentId }));
    else data.resend(action.incidentId);
  };
  const toggle = (key: string) => {
    const next = new Set(expanded);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setExpanded(next);
  };

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      {/* A readable column on a wide screen; the whole width on a phone. */}
      <View style={{ gap: styles.content.gap, width: "100%", maxWidth: layout.compact ? undefined : 960, alignSelf: "center" }}>
        {status}
        <OrchestratorLine navigation={navigation} styles={styles} theme={theme} />
        {data.errors.map((line) => (
          <Text key={line} style={[styles.body, { color: toneColor(theme, "danger") }]}>
            {line}
          </Text>
        ))}
        {view === null ? (
          data.errors.length === 0 ? <ActivityIndicator color={styles.spinner.color} accessibilityLabel="Reading the Inbox" /> : null
        ) : view.empty !== null ? (
          <EmptyInbox sentence={view.empty} onOpenWork={onOpenWork} styles={styles} />
        ) : (
          <>
            <InboxHeading text={sectionHeading("Needs you", view.needsYou.count)} styles={styles} />
            {view.needsYou.groups.length === 0 ? <Text style={styles.body}>No question is waiting for you.</Text> : null}
            {view.needsYou.groups.map((group) => (
              <InboxGroupView
                key={group.workspaceId}
                group={group}
                data={data}
                onRun={run}
                styles={styles}
                theme={theme}
                compact={layout.compact}
              />
            ))}

            <InboxHeading text="Decided for you" styles={styles} />
            <Text style={styles.body}>{view.decidedForYou.empty}</Text>

            <InboxHeading text={sectionHeading("Alerts", view.alerts.count)} styles={styles} />
            {view.alerts.rows.length === 0 ? <Text style={styles.body}>No alerts.</Text> : null}
            {view.alerts.rows.map((row) => (
              <AlertRow
                key={row.key}
                row={row}
                expanded={expanded.has(row.key)}
                onToggle={() => toggle(row.key)}
                onRun={run}
                resend={
                  row.action?.kind === "resend"
                    ? data.resending[row.action.incidentId]
                    : row.action?.kind === "replace-manager"
                      ? data.replacing[row.action.workspaceId]
                      : undefined
                }
                compact={layout.compact}
                styles={styles}
                theme={theme}
              />
            ))}
            {view.alerts.truncated ? <Text style={styles.body}>More alerts are open than the Inbox shows.</Text> : null}
          </>
        )}
      </View>
    </ScrollView>
  );
}
