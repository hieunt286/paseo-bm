/**
 * The Inbox (experience concept §4.1, autonomy design §A.12): where Beads
 * Manager opens. What it shows and in which order is `inbox-model.ts`; this
 * file reads the data and draws it.
 *
 * - `useInbox` reads `decisions.list {scope: inbox}`, `inbox.alerts`,
 *   `fallback.incidents` and Decided for you (`inbox.seen`, then
 *   `inbox.digest` from the time it answers) every `INBOX_POLL_MS` **only
 *   while the Inbox is shown** (REQ-111 b), and keeps the last read otherwise, so the Inbox tab's
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
 * - Decided for you (autonomy design §B.7): one line per decision answered
 *   for the owner, with **Override** — one press, `decisions.override` — after
 *   which the decision is back in Needs you as the owner's; merged with them
 *   by time, one line per intervention of the Orchestrator's (§G.3, bead
 *   `t9lm.23`) with its outcome, and no Override.
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
  decisionsOverrideRpc,
  fallbackActRpc,
  fallbackIncidentsRpc,
  inboxAlertsRpc,
  inboxDigestRpc,
  inboxSeenRpc,
  managerEnsureRpc,
  workspacesOverviewRpc,
  type ChatPeer,
} from "../shared/contracts";
import type { Decision } from "../shared/decisions";
import { DecisionCard, decisionQueryKey } from "./chat-card";
import { dashboardStyles } from "./styles";
import { OVERVIEW_POLL_MS } from "./surface-view";
import {
  DECIDED_FOR_YOU_TRUNCATED,
  INBOX_POLL_MS,
  INTERVENTIONS_TRUNCATED,
  inboxView,
  sectionHeading,
  type DigestRow,
  type FallbackOutcome,
  type InboxAction,
  type InboxAlertRow,
  type InboxGroup,
  type InboxInput,
  type InboxView,
} from "./inbox-model";
import { errorMessageOf } from "./errors";
import { OrchestratorLine } from "./orchestrator-line";
import { Button, ToneText, type Styles, type Theme } from "./ui";

/** Peers change rarely; one lookup per project group is plenty. */
const PEERS_STALE_MS = 30_000;

export const inboxQueryKeys = {
  decisions: ["paseo-bm", "inbox", "decisions"] as const,
  alerts: ["paseo-bm", "inbox", "alerts"] as const,
  incidents: ["paseo-bm", "inbox", "incidents"] as const,
  digest: ["paseo-bm", "inbox", "digest"] as const,
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
  /** Overrides a decision answered for the owner (autonomy design §B.7): it comes back to Needs you. */
  override: (decisionId: string) => void;
  overriding: ResendState;
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
  const markSeen = useRpc(inboxSeenRpc);
  const readDigest = useRpc(inboxDigestRpc);
  const overrideDecision = useRpc(decisionsOverrideRpc);
  const [settledHere, setSettledHere] = useState<Decision[]>([]);
  const [resending, setResending] = useState<ResendState>({});
  const [replacing, setReplacing] = useState<ResendState>({});
  const [overriding, setOverriding] = useState<ResendState>({});

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
  // Autonomy design §B.7: each read while shown records the showing (`inbox.seen`), which answers where this
  // visit's digest starts; without it, the digest reads everything decided for the owner (at most its cap).
  const digest = useQuery({
    queryKey: inboxQueryKeys.digest,
    queryFn: async () => {
      let since: string | null = null;
      let seenError: string | null = null;
      try {
        since = (await markSeen({})).since;
      } catch (error) {
        seenError = errorMessageOf(error);
      }
      const read = await readDigest(since === null ? {} : { since });
      return { ...read, since, seenError };
    },
    ...pollWhile(visible, INBOX_POLL_MS),
  });

  const base = {
    decisions: decisions.data?.decisions ?? [],
    settledHere,
    alerts: alerts.data?.alerts ?? [],
    alertsTruncated: alerts.data?.truncated ?? false,
    incidents: incidents.data?.incidents ?? [],
    digest: digest.data?.decisions ?? [],
    digestTruncated: digest.data?.truncated ?? false,
    interventions: digest.data?.interventions ?? [],
    interventionsTruncated: digest.data?.interventionsTruncated ?? false,
    digestSince: digest.data?.since ?? null,
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
    digest.isError ? `Could not read what was decided for you: ${errorMessageOf(digest.error)}` : null,
    digest.data?.seenError == null ? null : `Could not record that you looked: ${digest.data.seenError}`,
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

  const override = (decisionId: string) => {
    setOverriding((current) => ({ ...current, [decisionId]: { busy: true, error: null } }));
    overrideDecision({ id: decisionId }).then(
      () => {
        setOverriding((current) => Object.fromEntries(Object.entries(current).filter(([id]) => id !== decisionId)));
        void queryClient.invalidateQueries({ queryKey: inboxQueryKeys.decisions });
        void queryClient.invalidateQueries({ queryKey: inboxQueryKeys.digest });
      },
      (error: unknown) => {
        setOverriding((current) => ({ ...current, [decisionId]: { busy: false, error: `Could not override: ${errorMessageOf(error)}` } }));
        void queryClient.invalidateQueries({ queryKey: inboxQueryKeys.digest });
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
    override,
    overriding,
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
    <Button
      label={busy ? "Sending…" : action.label}
      kind="secondary"
      accessibilityLabel={action.accessibilityLabel}
      accessibilityState={{ disabled: busy, busy }}
      disabled={busy}
      onPress={() => onRun(action)}
      style={{ opacity: busy ? 0.5 : 1 }}
      styles={styles}
    />
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
      <ToneText tone={outcome.tone} accessibilityLiveRegion="polite" styles={styles} theme={theme}>
        {outcome.text}
      </ToneText>
      {outcome.action === null ? null : (
        <View style={styles.chipRow}>
          <InboxActionButton action={outcome.action} busy={resend?.busy === true} onRun={onRun} styles={styles} />
        </View>
      )}
      {resend?.error == null ? null : <ToneText tone="danger" styles={styles} theme={theme}>{resend.error}</ToneText>}
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
          <ToneText tone={row.tone} styles={styles} theme={theme}>●</ToneText>
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
      {resend?.error == null ? null : <ToneText tone="danger" styles={styles} theme={theme}>{resend.error}</ToneText>}
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

/**
 * One line of Decided for you (autonomy design §B.7): what was decided · the
 * project · who decided, its time, the reason under it, and **Override** at
 * the end of the line (under it on a phone) — or, once overridden, what
 * became of it. The ids and times on a tap. `busy` greys the button while
 * its call runs; `error` is said under the line.
 *
 * An intervention of the Orchestrator's (§G.3) is drawn the same way with
 * its own mark, what it did and for whom, the project, why, and its outcome
 * in the outcome's colour — and nothing to press but the line: it has no
 * Override. A decision the Orchestrator answered carries its outcome too.
 */
export function DigestRowView({
  row,
  expanded,
  onToggle,
  onOverride,
  state,
  compact,
  styles,
  theme,
}: {
  row: DigestRow;
  expanded: boolean;
  onToggle: () => void;
  onOverride: (decisionId: string) => void;
  state: { busy: boolean; error: string | null } | undefined;
  compact: boolean;
  styles: Styles;
  theme: Theme;
}) {
  const busy = state?.busy === true;
  const override = row.kind === "decision" ? row.override : null;
  return (
    <View style={[styles.card, { gap: 6 }]}>
      <View style={{ flexDirection: compact ? "column" : "row", alignItems: compact ? "stretch" : "center", gap: 8 }}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${row.accessibilityLabel}. ${expanded ? "Hide" : "Show"} the details`}
          accessibilityState={{ expanded }}
          onPress={onToggle}
          style={{ flex: compact ? undefined : 1, gap: 2 }}
        >
          <View style={{ flexDirection: "row", gap: 6 }}>
            <ToneText tone="info" styles={styles} theme={theme}>{row.kind === "decision" ? "✓" : "↪"}</ToneText>
            <Text style={[styles.body, { flex: 1, color: theme.colors.foreground }]} numberOfLines={expanded ? undefined : 2}>
              {row.what}
            </Text>
            <Text style={styles.body}>{`${row.time} ${expanded ? "▾" : "▸"}`}</Text>
          </View>
          <Text style={styles.body} numberOfLines={expanded ? undefined : 1}>
            {row.where}
          </Text>
          {row.reason === null ? null : (
            <Text style={styles.body} numberOfLines={expanded ? undefined : 2}>
              {row.reason}
            </Text>
          )}
          {row.outcome === null ? null : (
            <ToneText tone={row.outcome.tone} styles={styles} theme={theme}>
              {row.outcome.text}
            </ToneText>
          )}
        </Pressable>
        {row.kind === "intervention" || override === null ? null : override.state === "offered" ? (
          <View style={styles.chipRow}>
            <Button
              label={busy ? "Overriding…" : override.label}
              kind="secondary"
              accessibilityLabel={override.accessibilityLabel}
              accessibilityState={{ disabled: busy, busy }}
              disabled={busy}
              onPress={() => onOverride(row.decisionId)}
              style={{ opacity: busy ? 0.5 : 1 }}
              styles={styles}
            />
          </View>
        ) : (
          <ToneText tone={override.tone} accessibilityLiveRegion="polite" styles={styles} theme={theme}>
            {override.text}
          </ToneText>
        )}
      </View>
      {state?.error == null ? null : <ToneText tone="danger" styles={styles} theme={theme}>{state.error}</ToneText>}
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
        <Button label="Open Work" kind="secondary" accessibilityLabel="Open Work: the projects and their requests" onPress={onOpenWork} styles={styles} />
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
          <ToneText key={line} tone="danger" styles={styles} theme={theme}>
            {line}
          </ToneText>
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

            <InboxHeading text={sectionHeading("Decided for you", view.decidedForYou.count)} styles={styles} />
            {view.decidedForYou.empty === null ? null : <Text style={styles.body}>{view.decidedForYou.empty}</Text>}
            {view.decidedForYou.rows.map((row) => (
              <DigestRowView
                key={row.key}
                row={row}
                expanded={expanded.has(row.key)}
                onToggle={() => toggle(row.key)}
                onOverride={data.override}
                state={row.kind === "decision" ? data.overriding[row.decisionId] : undefined}
                compact={layout.compact}
                styles={styles}
                theme={theme}
              />
            ))}
            {view.decidedForYou.truncated ? <Text style={styles.body}>{DECIDED_FOR_YOU_TRUNCATED}</Text> : null}
            {view.decidedForYou.interventionsTruncated ? <Text style={styles.body}>{INTERVENTIONS_TRUNCATED}</Text> : null}

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
