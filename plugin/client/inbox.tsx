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
 * - The Orchestrator's state and the way into its chat are in the surface's
 *   header (change-014), not in the Inbox.
 * - Needs you is one group per project (`inboxProjects`): its decisions, held
 *   actions and alerts as one joined stack of cards, under a filter
 *   (All · Decisions · Actions · Alerts, client state).
 * - Decided for you (autonomy design §B.7): one line per decision answered
 *   for the owner, with **Override** — one press, `decisions.override` — after
 *   which the decision is back in Needs you as the owner's; merged with them
 *   by time, one line per intervention of the Orchestrator's (§G.3, bead
 *   `t9lm.23`) with its outcome, and no Override.
 *
 * Layout: `layout.compact` (a phone, the MobileInbox artboard) gives the
 * tighter paddings and type of `dashboardStyles`, the filter on its own row
 * across the width, and puts an alert's action and Decided for you's Override
 * or Why? under their line, left aligned; a wide screen keeps the column at a
 * readable width and the action at the line's end.
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
  INBOX_FILTERS,
  INBOX_POLL_MS,
  INTERVENTIONS_TRUNCATED,
  decidedHeading,
  inboxProjects,
  inboxView,
  needsYouSummary,
  projectHeading,
  type DigestRow,
  type FallbackOutcome,
  type InboxAction,
  type InboxAlertRow,
  type InboxFilter,
  type InboxInput,
  type InboxProject,
  type InboxView,
} from "./inbox-model";
import { errorMessageOf } from "./errors";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { Segmented, SectionLabel } from "./text-tabs";
import { toneColor } from "./tone";
import { Button, KindBar, ToneText, cardBoxStyle, type CardJoin, type Styles, type Theme } from "./ui";

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
      size="small"
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
    <View style={{ gap: 6 }}>
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

/** The ids and detail of an Inbox row, once opened: mono on the page colour, one border. */
function DetailBox({ lines, styles, theme }: { lines: readonly string[]; styles: Styles; theme: Theme }) {
  return (
    <View style={{ gap: 4, padding: 12, borderWidth: 1, borderColor: theme.colors.border, backgroundColor: theme.colors.surface0 }}>
      {lines.map((line, index) => (
        <Text key={`${index}:${line}`} style={styles.mono} selectable>
          {line}
        </Text>
      ))}
    </View>
  );
}

/** An alert's 16px icon: a warning sign for a danger, a clock otherwise; in the alert's tone. */
function alertIcon(tone: InboxAlertRow["tone"]): string {
  return tone === "danger" ? "TriangleAlert" : "Clock";
}

/**
 * One alert, inside its project's group, as the mockup draws it: a one-row
 * card — the calm (muted) kind bar, a 16px icon, `<what happened>` in 500 and
 * its time muted, the action at the right (under the line on a phone); the
 * detail and ids on a tap. `join` stacks it in the group.
 */
export function AlertRow({
  row,
  expanded,
  onToggle,
  onRun,
  resend,
  compact,
  join = "alone",
  styles,
  theme,
}: {
  row: InboxAlertRow;
  expanded: boolean;
  onToggle: () => void;
  onRun: (action: InboxAction) => void;
  resend: { busy: boolean; error: string | null } | undefined;
  compact: boolean;
  join?: CardJoin;
  styles: Styles;
  theme: Theme;
}) {
  const { colors } = theme;
  return (
    <View style={[cardBoxStyle(theme, { compact, join, bar: true, row: true }), { gap: compact ? 10 : 8 }]}>
      <View style={{ flexDirection: compact ? "column" : "row", alignItems: compact ? "flex-start" : "center", gap: compact ? 10 : 12 }}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${row.accessibilityLabel}. ${expanded ? "Hide" : "Show"} the details`}
          accessibilityState={{ expanded }}
          onPress={onToggle}
          style={{ flex: compact ? undefined : 1, alignSelf: compact ? "stretch" : "auto", flexDirection: "row", alignItems: "center", gap: 12 }}
        >
          <Icon name={alertIcon(row.tone)} size={16} color={toneColor(theme, row.tone)} />
          <Text style={{ flex: 1, fontSize: 14, color: colors.foreground }} numberOfLines={expanded ? undefined : 2}>
            <Text style={{ fontWeight: "500" }}>{row.what}</Text>
            <Text style={{ color: colors.foregroundMuted }}>{` · ${row.time}`}</Text>
          </Text>
        </Pressable>
        {row.action === null ? null : (
          <View style={styles.chipRow}>
            <InboxActionButton action={row.action} busy={resend?.busy === true} onRun={onRun} styles={styles} />
          </View>
        )}
      </View>
      {resend?.error == null ? null : <ToneText tone="danger" styles={styles} theme={theme}>{resend.error}</ToneText>}
      {expanded ? <DetailBox lines={row.details} styles={styles} theme={theme} /> : null}
      {/* Absolute at the left edge, so last in the tree: the calm bar of an alert (change-014). */}
      <KindBar tone="muted" theme={theme} />
    </View>
  );
}

/**
 * One line of Decided for you (autonomy design §B.7), as the mockup draws it:
 * between 1px rules, an accent check, `<project> · <what> → <answer>` and,
 * muted, `, by <who>`; **Override** at the end of the line (under it on a
 * phone) — or, once overridden, what became of it. The time, the reason, the
 * outcome and the ids on a tap. `busy` greys the button while its call runs;
 * `error` is said under the line.
 *
 * An intervention of the Orchestrator's (§G.3) reads `<project> · <what it
 * did>` and, muted, `· Orchestrator`, with **Why?** — a text button that
 * opens the same detail — and no Override.
 */
export function DigestRowView({
  row,
  expanded,
  onToggle,
  onOverride,
  state,
  compact,
  last = false,
  styles,
  theme,
}: {
  row: DigestRow;
  expanded: boolean;
  onToggle: () => void;
  onOverride: (decisionId: string) => void;
  state: { busy: boolean; error: string | null } | undefined;
  compact: boolean;
  /** The last line also has the rule under it. */
  last?: boolean;
  styles: Styles;
  theme: Theme;
}) {
  const { colors } = theme;
  const busy = state?.busy === true;
  const override = row.kind === "decision" ? row.override : null;
  const by = row.kind === "decision" ? `, by ${row.by}` : " · Orchestrator";
  return (
    <View
      style={{
        gap: 8,
        paddingVertical: 12,
        borderTopWidth: 1,
        borderTopColor: colors.border,
        ...(last ? { borderBottomWidth: 1, borderBottomColor: colors.border } : {}),
      }}
    >
      <View style={{ flexDirection: compact ? "column" : "row", alignItems: compact ? "flex-start" : "center", gap: compact ? 8 : 12 }}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${row.accessibilityLabel}. ${expanded ? "Hide" : "Show"} the details`}
          accessibilityState={{ expanded }}
          onPress={onToggle}
          style={{ flex: compact ? undefined : 1, alignSelf: compact ? "stretch" : "auto", flexDirection: "row", alignItems: "center", gap: 12 }}
        >
          <Icon name="Check" size={16} color={colors.accent} />
          <Text style={{ flex: 1, fontSize: 14, color: colors.foreground }} numberOfLines={expanded ? undefined : 2}>
            {`${row.project} · ${row.what}`}
            <Text style={{ color: colors.foregroundMuted }}>{by}</Text>
          </Text>
        </Pressable>
        {row.kind === "intervention" ? (
          <Button
            label="Why?"
            kind="text"
            accessibilityLabel={`Why the Orchestrator did it: ${expanded ? "hide" : "show"} the reason and the outcome`}
            accessibilityState={{ expanded }}
            onPress={onToggle}
            styles={styles}
          />
        ) : override === null ? null : override.state === "offered" ? (
          <View style={styles.chipRow}>
            <Button
              label={busy ? "Overriding…" : override.label}
              kind="secondary"
              size="small"
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
        <View style={{ gap: 6, paddingLeft: 28 }}>
          <Text style={styles.body}>{`${row.time} · ${row.by}`}</Text>
          {row.reason === null ? null : <Text style={styles.body}>{row.reason}</Text>}
          {row.outcome === null ? null : (
            <ToneText tone={row.outcome.tone} styles={styles} theme={theme}>
              {row.outcome.text}
            </ToneText>
          )}
          <DetailBox lines={row.details} styles={styles} theme={theme} />
        </View>
      ) : null}
    </View>
  );
}

/** The empty Inbox under its title: one muted sentence, and the way to Projects. */
export function EmptyInbox({ sentence, onOpenWork, styles }: { sentence: string; onOpenWork: () => void; styles: Styles }) {
  return (
    <View style={{ gap: 14, alignItems: "flex-start" }}>
      <Text accessibilityLiveRegion="polite" style={styles.body}>
        {sentence}
      </Text>
      <Button label="Open Projects" kind="secondary" size="small" accessibilityLabel="Open Projects: the projects and their requests" onPress={onOpenWork} styles={styles} />
    </View>
  );
}

/**
 * The title row: "Needs you", its count muted, and the filter at the right
 * (none on the empty Inbox). On a phone the filter is its own row, its four
 * cells sharing the width.
 */
export function InboxTitleRow({
  summary,
  filter,
  onFilter,
  compact,
  theme,
}: {
  summary: string | null;
  filter: InboxFilter | null;
  onFilter: (filter: InboxFilter) => void;
  compact: boolean;
  theme: Theme;
}) {
  if (compact) {
    return (
      <View style={{ gap: 16 }}>
        <View style={{ flexDirection: "row", alignItems: "baseline", flexWrap: "wrap", gap: 10 }}>
          <Text accessibilityRole="header" style={{ color: theme.colors.foreground, fontSize: 20, fontWeight: "600" }}>
            Needs you
          </Text>
          {summary === null ? null : <Text style={{ color: theme.colors.foregroundMuted, fontSize: 13 }}>{summary}</Text>}
        </View>
        {filter === null ? null : (
          <Segmented segments={INBOX_FILTERS} selected={filter} onSelect={(key) => onFilter(key as InboxFilter)} theme={theme} fill />
        )}
      </View>
    );
  }
  return (
    <View style={{ flexDirection: "row", alignItems: "baseline", flexWrap: "wrap", gap: 16 }}>
      <Text accessibilityRole="header" style={{ color: theme.colors.foreground, fontSize: 22, fontWeight: "600" }}>
        Needs you
      </Text>
      {summary === null ? null : <Text style={{ color: theme.colors.foregroundMuted, fontSize: 14 }}>{summary}</Text>}
      {filter === null ? null : (
        <View style={{ marginLeft: "auto" }}>
          <Segmented segments={INBOX_FILTERS} selected={filter} onSelect={(key) => onFilter(key as InboxFilter)} theme={theme} />
        </View>
      )}
    </View>
  );
}

// ---------------------------------------------------------------------------
// The screen.
// ---------------------------------------------------------------------------

/** One project's group: its label, then its decisions, held actions and alerts as one joined stack; its peers name the askers. */
function InboxProjectView({
  project,
  data,
  expanded,
  onToggle,
  onRun,
  styles,
  theme,
  compact,
}: {
  project: InboxProject;
  data: InboxData;
  expanded: ReadonlySet<string>;
  onToggle: (key: string) => void;
  onRun: (action: InboxAction) => void;
  styles: Styles;
  theme: Theme;
  compact: boolean;
}) {
  const listPeers = useRpc(chatPeersRpc);
  const peers = useQuery({
    queryKey: ["paseo-bm", "chat-peers", project.peersOf ?? ""],
    queryFn: () => listPeers({ agentId: project.peersOf! }),
    enabled: project.peersOf !== null,
    staleTime: PEERS_STALE_MS,
    retry: false,
  });
  const agents: ChatPeer[] = peers.data === undefined ? [] : [...(peers.data.owner === null ? [] : [peers.data.owner]), ...peers.data.peers];
  let position = 0;
  const joinNext = (): CardJoin => (position++ === 0 ? "first" : "next");
  return (
    <View accessibilityRole="list">
      <View style={{ marginBottom: compact ? 8 : 10 }}>
        <SectionLabel theme={theme}>{projectHeading(project)}</SectionLabel>
      </View>
      {project.items.map((item) => (
        <View key={item.decision.id}>
          <DecisionCard
            card={item.card}
            via="inbox"
            agents={agents}
            at={new Date(item.decision.askedAt)}
            initial={item.decision}
            poll={false}
            onSettled={data.onSettled}
            join={joinNext()}
            theme={theme}
            compact={compact}
          />
          {item.outcome === null ? null : (
            <View style={cardBoxStyle(theme, { compact, join: joinNext(), bar: false, row: true })}>
              <OutcomeLine
                outcome={item.outcome}
                resend={item.outcome.action?.kind === "resend" ? data.resending[item.outcome.action.incidentId] : undefined}
                onRun={onRun}
                styles={styles}
                theme={theme}
              />
            </View>
          )}
        </View>
      ))}
      {project.alerts.map((row) => (
        <AlertRow
          key={row.key}
          row={row}
          expanded={expanded.has(row.key)}
          onToggle={() => onToggle(row.key)}
          onRun={onRun}
          resend={
            row.action?.kind === "resend"
              ? data.resending[row.action.incidentId]
              : row.action?.kind === "replace-manager"
                ? data.replacing[row.action.workspaceId]
                : undefined
          }
          compact={compact}
          join={joinNext()}
          styles={styles}
          theme={theme}
        />
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

/**
 * The Inbox, as the approved mockup's `<main>` draws it: a 1040px column
 * (32/32/64 padding, 28 between blocks) — the title row with the filter, one
 * group per project, then Decided for you. The Orchestrator's state is in the
 * surface's header, not here.
 */
export function InboxScreen({ theme, layout, navigation, data, status, onOpenWork }: InboxScreenProps) {
  const styles = useMemo(() => dashboardStyles(theme, layout.compact), [theme, layout.compact]);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [filter, setFilter] = useState<InboxFilter>("all");
  const view = data.view;
  const compact = layout.compact;
  const everything = view === null ? [] : inboxProjects(view, "all");
  const projects = view === null ? [] : filter === "all" ? everything : inboxProjects(view, filter);

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
    <ScrollView style={{ flex: 1, backgroundColor: theme.colors.surface0 }} contentContainerStyle={{ paddingTop: compact ? 16 : 32, paddingHorizontal: compact ? 16 : 32, paddingBottom: compact ? 40 : 64 }}>
      <View style={{ gap: compact ? 16 : 28, width: "100%", maxWidth: 1040, alignSelf: "center" }}>
        {status}
        {data.errors.map((line) => (
          <ToneText key={line} tone="danger" styles={styles} theme={theme}>
            {line}
          </ToneText>
        ))}
        {view === null ? (
          <>
            <InboxTitleRow summary={null} filter={null} onFilter={setFilter} compact={compact} theme={theme} />
            {data.errors.length === 0 ? <ActivityIndicator color={styles.spinner.color} accessibilityLabel="Reading the Inbox" /> : null}
          </>
        ) : view.empty !== null ? (
          <>
            <InboxTitleRow summary={null} filter={null} onFilter={setFilter} compact={compact} theme={theme} />
            <EmptyInbox sentence={view.empty} onOpenWork={onOpenWork} styles={styles} />
          </>
        ) : (
          <>
            <InboxTitleRow summary={needsYouSummary(everything)} filter={filter} onFilter={setFilter} compact={compact} theme={theme} />
            {everything.length === 0 ? <Text style={styles.body}>No question is waiting for you.</Text> : null}
            {everything.length > 0 && projects.length === 0 ? <Text style={styles.body}>Nothing of this kind needs you.</Text> : null}
            {projects.map((project) => (
              <InboxProjectView
                key={project.key}
                project={project}
                data={data}
                expanded={expanded}
                onToggle={toggle}
                onRun={run}
                styles={styles}
                theme={theme}
                compact={compact}
              />
            ))}
            {view.alerts.truncated && (filter === "all" || filter === "alerts") ? <Text style={styles.body}>More alerts are open than the Inbox shows.</Text> : null}

            <View accessibilityRole="list">
              <View style={{ marginBottom: compact ? 8 : 10 }}>
                <SectionLabel theme={theme}>{decidedHeading(view.decidedForYou.count)}</SectionLabel>
              </View>
              {view.decidedForYou.empty === null ? null : <Text style={styles.body}>{view.decidedForYou.empty}</Text>}
              {view.decidedForYou.rows.map((row, index) => (
                <DigestRowView
                  key={row.key}
                  row={row}
                  expanded={expanded.has(row.key)}
                  onToggle={() => toggle(row.key)}
                  onOverride={data.override}
                  state={row.kind === "decision" ? data.overriding[row.decisionId] : undefined}
                  compact={compact}
                  last={index === view.decidedForYou.rows.length - 1}
                  styles={styles}
                  theme={theme}
                />
              ))}
              {view.decidedForYou.truncated ? <Text style={[styles.body, { marginTop: 10 }]}>{DECIDED_FOR_YOU_TRUNCATED}</Text> : null}
              {view.decidedForYou.interventionsTruncated ? <Text style={[styles.body, { marginTop: 10 }]}>{INTERVENTIONS_TRUNCATED}</Text> : null}
            </View>
          </>
        )}
      </View>
    </ScrollView>
  );
}
