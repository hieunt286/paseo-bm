/**
 * "Beads Manager" surface (WP-113): the screen behind the sidebar item and the
 * Command Center items. It only renders; the launch logic, texts and styles live
 * in `launch-manager.ts`, which is tested without a renderer.
 *
 * It is the section router of the management surface (autonomy design §A.12):
 * it opens on the Inbox, and a row of tabs switches Inbox · Work · Insights ·
 * Settings, the Inbox tab carrying the count of what needs the owner (DQ-3).
 * Work is `work.tsx` (the projects, and a project's Requests · Beads · Agents);
 * Insights is `insights.tsx`;
 * Settings is `settings-section.tsx`, built from the Setup screen's pieces — so nothing that existed is out of reach.
 *
 * Client rules: React Native primitives only, every color from theme.colors,
 * no Node builtin imports.
 */
import type { PluginTheme } from "@getpaseo/plugin";
import { type PluginSurfaceProps, usePaseo, useRpc } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { AccessibilityInfo, Animated, Pressable, Text, View } from "react-native";
import { SettingsScreen } from "./settings-section";
import { InboxScreen, useInbox } from "./inbox";
import { InsightsScreen } from "./insights";
import { insightsProjects } from "./insights-model";
import { inboxTab } from "./inbox-model";
import { StatusTabs } from "./ui";
import { ProjectPage, WorkScreen } from "./work";
import {
  SURFACE_HOME_VIEW,
  SURFACE_SECTIONS,
  backLabelOf,
  backOf,
  overviewPolling,
  closedWorkspaces,
  launcherNotices,
  projectRequests,
  projectTabOf,
  screenTitleOf,
  sectionHomeOf,
  sectionOf,
  sectionRequests,
  type SurfaceSection,
  type SurfaceView,
  type SurfaceWorkspace,
} from "./surface-view";
import { dashboardStyles, toneColor, type Tone } from "./dashboard-model";
import { managerEnsureRpc, tracesWorkspacesRpc, workspacesOverviewRpc } from "../shared/contracts";
import { PLUGIN_VERSION } from "../shared/version";
import {
  errorMessageOf,
  launcherStatusLines,
  launcherStyles,
  launchRequests,
  managerLauncher,
  runPendingRequest,
  type StatusLine,
} from "./launch-manager";

interface WorkspaceRow {
  id: string;
  label: string;
  detail: string;
  /** Title of the project's page: the workspace and its project. */
  screenTitle: string;
}

/** One breath of the pulse: slow enough to read as "alive", not as an alarm. */
const PULSE_MS = 900;
/** The floor of the pulse, and the resting opacity of a dot with nothing to say. */
const DIM_OPACITY = 0.3;
/** Roles in the order they appear in the label, with the word the user reads. */
const DOT_ROLES = [
  ["manager", "Manager"],
  ["worker", "Worker"],
  ["reviewer", "Reviewer"],
  ["orchestrator", "Orchestrator"],
] as const;

/**
 * Running bm agents of one workspace, per role (`workspaces.overview`).
 * `orchestrator` is optional: an overview that does not count it counts none.
 */
export interface RunningAgentCounts {
  manager: number;
  worker: number;
  reviewer: number;
  orchestrator?: number;
}

/** Everything the dot beside a project name shows; see `runningDotState`. */
export interface RunningDotState {
  total: number;
  /** True only when the dot pulses: an idle row and reduced motion both say false. */
  animate: boolean;
  /** Resting opacity, and the value the pulse returns to. */
  opacity: number;
  /** "1 Worker, 1 Reviewer" — read aloud even when the text is not drawn. */
  label: string;
  tone: Tone;
}

/**
 * The dot that says a bm agent is working in this workspace right now
 * (delta 20260917e §4.2): it pulses while any of the roles runs, and
 * stands still and dim when none does.
 */
export function runningDotState(
  counts: RunningAgentCounts | undefined,
  reduceMotion: boolean,
): RunningDotState | null {
  // The overview has not answered for this row yet. Unknown is not idle, and a
  // dim dot would claim "nothing is running" before anything was counted.
  if (counts === undefined) return null;
  const count = (role: (typeof DOT_ROLES)[number][0]) => counts[role] ?? 0;
  const total = DOT_ROLES.reduce((sum, [role]) => sum + count(role), 0);
  if (total === 0) {
    return { total, animate: false, opacity: DIM_OPACITY, label: "No Beads agent running", tone: "muted" };
  }
  return {
    total,
    // Reduced motion keeps the signal and drops the motion: the dot goes solid
    // and no loop is started at all.
    animate: !reduceMotion,
    opacity: 1,
    label: DOT_ROLES.filter(([key]) => count(key) > 0)
      .map(([key, name]) => `${count(key)} ${name}${count(key) === 1 ? "" : "s"}`)
      .join(", "),
    tone: "success",
  };
}

/**
 * Puts a state on an `Animated.Value`: the resting opacity always, the pulse
 * only when the state asks for one. Returns the stop function, or `undefined`
 * when there is nothing running to stop — that is the whole reduced-motion
 * promise, so it is a function the test can call rather than a rendered effect.
 */
export function applyDotPulse(value: Animated.Value, state: RunningDotState): (() => void) | undefined {
  // Set on every change so a dot that stops pulsing lands on its resting
  // opacity instead of wherever the interrupted loop left it.
  value.setValue(state.opacity);
  if (!state.animate) return undefined;
  const loop = Animated.loop(
    Animated.sequence([
      // `useNativeDriver` must be false on react-native-web, which is what
      // Paseo's renderer is (delta 20260917e P3).
      Animated.timing(value, { toValue: DIM_OPACITY, duration: PULSE_MS, useNativeDriver: false }),
      Animated.timing(value, { toValue: 1, duration: PULSE_MS, useNativeDriver: false }),
    ]),
  );
  loop.start();
  return () => loop.stop();
}

/**
 * The operating system's "reduce motion" preference, false when the host cannot
 * answer. A host that fails the query has not asked for less motion; reading
 * that absence as a preference would quietly kill the pulse everywhere.
 */
export async function readReduceMotion(): Promise<boolean> {
  try {
    return await AccessibilityInfo.isReduceMotionEnabled();
  } catch {
    return false;
  }
}

function useReduceMotion(): boolean {
  const [reduceMotion, setReduceMotion] = useState(false);
  useEffect(() => {
    let live = true;
    void readReduceMotion().then((value) => {
      if (live) setReduceMotion(value);
    });
    return () => {
      live = false;
    };
  }, []);
  return reduceMotion;
}

function RunningDot(props: {
  counts: RunningAgentCounts | undefined;
  theme: PluginTheme;
  styles: ReturnType<typeof launcherStyles>;
  /** The dot alone (Work rows name the agents themselves); the words stay in its accessibility label. */
  bare?: boolean;
}) {
  const { counts, theme, styles, bare } = props;
  const reduceMotion = useReduceMotion();
  const state = runningDotState(counts, reduceMotion);
  const opacity = useRef(new Animated.Value(DIM_OPACITY)).current;
  // Restarting on `animate` and `opacity` alone keeps the loop through a poll
  // that only changed the counts, so the dot does not blink back to full.
  useEffect(() => (state === null ? undefined : applyDotPulse(opacity, state)), [
    opacity,
    state?.animate,
    state?.opacity,
  ]);
  if (state === null) return null;
  return (
    <View style={styles.stat} accessibilityLabel={state.label}>
      <Animated.View
        style={{ width: 8, height: 8, borderRadius: 4, opacity, backgroundColor: toneColor(theme, state.tone) }}
      />
      {/* An idle row says it with the dim dot alone; spelling out "nothing is
          running" on every quiet project is noise. The accessibility label
          above carries the words in both states. */}
      {state.total === 0 || bare === true ? null : (
        <Text style={[styles.statText, { color: toneColor(theme, state.tone) }]} numberOfLines={1}>
          {state.label}
        </Text>
      )}
    </View>
  );
}

/**
 * The surface's status strip: a slash command's notice (tap to dismiss), a host
 * too old to open agents, and the state of the last Manager launch. Built once
 * by the surface and drawn on every section (delta 20260918e §4.2); the lines
 * come from `launcherStatusLines`.
 */
function LauncherStatus({
  lines,
  onDismiss,
  theme,
  styles,
}: {
  lines: readonly StatusLine[];
  onDismiss: () => void;
  theme: PluginTheme;
  styles: ReturnType<typeof launcherStyles>;
}) {
  return (
    <>
      {lines.map((line) =>
        line.dismissable ? (
          <Pressable
            key={line.key}
            accessibilityRole="button"
            accessibilityLabel={`${line.text}. Dismiss.`}
            onPress={onDismiss}
            style={styles.row}
          >
            <Text style={styles.rowSubtitle}>{line.text}</Text>
          </Pressable>
        ) : (
          <Text
            key={line.key}
            accessibilityLiveRegion="polite"
            style={[styles.notice, { color: toneColor(theme, line.tone) }]}
          >
            {line.text}
          </Text>
        ),
      )}
    </>
  );
}

export function ManagerLauncherSurface(props: PluginSurfaceProps) {
  const { theme, layout, navigation } = props;
  const paseo = usePaseo();
  // Every section shares this surface (Q-036), so the view is state here and
  // each Command Center hand-off is a queue, exactly like the launch request
  // below. It opens on the Inbox (autonomy design §A.12).
  const [view, setView] = useState<SurfaceView>(SURFACE_HOME_VIEW);
  const [project, setProject] = useState<SurfaceWorkspace | null>(null);
  const ensure = useRpc(managerEnsureRpc);
  const listStored = useRpc(tracesWorkspacesRpc);
  const stored = useQuery({
    queryKey: ["paseo-bm", "launcher", "stored-workspaces"],
    queryFn: () => listStored({}),
  });
  const listOverview = useRpc(workspacesOverviewRpc);
  // Bead counts and running agents; read and refreshed only while Work's list
  // shows them (delta 20260918f F5).
  const overview = useQuery({
    queryKey: ["paseo-bm", "launcher", "overview"],
    queryFn: () => listOverview({}),
    ...overviewPolling(view),
  });
  const overviewById = useMemo(
    () => new Map((overview.data?.workspaces ?? []).map((entry) => [entry.workspaceId, entry])),
    [overview.data],
  );
  const openAgent = navigation?.openAgent;
  const state = useSyncExternalStore(
    managerLauncher.subscribe,
    managerLauncher.getState,
    managerLauncher.getState,
  );
  // What a slash command had to say. It has no channel of its own except an
  // error toast, which would paint a success red (surface-view.ts).
  const commandNotice = useSyncExternalStore(
    launcherNotices.subscribe,
    launcherNotices.peek,
    launcherNotices.peek,
  );
  const styles = useMemo(() => launcherStyles(theme, layout.compact), [theme, layout.compact]);
  const tabStyles = useMemo(() => dashboardStyles(theme, layout.compact), [theme, layout.compact]);

  const workspaces = useQuery({
    queryKey: ["paseo-bm", "launcher", "workspaces"],
    queryFn: async (): Promise<WorkspaceRow[]> => {
      const result = await paseo.workspaces.list({
        sort: [{ key: "activity_at", direction: "desc" }],
      });
      return result.entries
        .filter((workspace) => !workspace.archivingAt)
        .map((workspace) => ({
          id: workspace.id,
          label: workspace.title || workspace.name,
          detail: workspace.projectDisplayName,
          screenTitle: screenTitleOf(workspace.title || workspace.name, workspace.projectDisplayName),
        }));
    },
  });

  // A project's name for the Inbox: open workspaces first, then the history of closed ones.
  const projectOf = useMemo(() => {
    const names = new Map<string, string>();
    for (const closed of stored.data?.workspaces ?? []) {
      if (closed.lastKnownName !== null) names.set(closed.workspaceId, closed.lastKnownName);
    }
    for (const workspace of workspaces.data ?? []) names.set(workspace.id, workspace.screenTitle);
    return (workspaceId: string) => names.get(workspaceId) ?? null;
  }, [stored.data, workspaces.data]);
  // Read every INBOX_POLL_MS while the Inbox shows, kept otherwise for the tab's count.
  const inbox = useInbox({
    visible: view === "inbox",
    projectOf,
    can: { openAgent: openAgent !== undefined, openWorkspace: navigation?.openWorkspace !== undefined },
  });

  // Open a section when a Command Center item queued one.
  useEffect(() => {
    const run = () => {
      const section = sectionRequests.take();
      if (section !== null) setView(sectionHomeOf(section));
    };
    run();
    return sectionRequests.subscribe(run);
  }, []);

  // Open a project's page when the Command Center queued one.
  useEffect(() => {
    const run = () => {
      const workspaceId = projectRequests.take();
      if (workspaceId === null) return;
      const known = workspaces.data?.find((workspace) => workspace.id === workspaceId);
      setProject({ id: workspaceId, label: known?.screenTitle ?? workspaceId });
      setView("project-requests");
    };
    run();
    return projectRequests.subscribe(run);
  }, [workspaces.data]);

  // Run a launch queued by the Command Center item, now, whenever one arrives,
  // and when a pending launch ends (a request that came meanwhile waited).
  useEffect(() => {
    const run = () => {
      void runPendingRequest(launchRequests, managerLauncher, { ensure, openAgent });
    };
    run();
    const stopRequests = launchRequests.subscribe(run);
    const stopLauncher = managerLauncher.subscribe(run);
    return () => {
      stopRequests();
      stopLauncher();
    };
  }, [ensure, openAgent]);

  const pending = state.status === "pending";
  // Every ← goes where `backOf` says: a project's page to the Work list.
  // A section's own screen has no ←: the tabs reach it.
  const goBack = () => setView(backOf(view) ?? SURFACE_HOME_VIEW);

  // The section tabs, above every view: Inbox (with its count) · Work · Insights · Settings.
  const tabs = SURFACE_SECTIONS.map((section) =>
    section.key === "inbox" ? inboxTab(inbox.view?.count ?? null) : { key: section.key, label: section.label },
  );
  const framed = (screen: ReactNode) => (
    <View style={{ flex: 1, backgroundColor: theme.colors.surface0 }}>
      <View style={{ paddingHorizontal: tabStyles.content.padding, paddingTop: tabStyles.content.padding }}>
        <StatusTabs
          tabs={tabs}
          selected={sectionOf(view)}
          onSelect={(key) => setView(sectionHomeOf(key as SurfaceSection))}
          styles={tabStyles}
        />
      </View>
      <View style={{ flex: 1 }}>{screen}</View>
    </View>
  );

  // Built ONCE and placed on every view of the surface (the Inbox, the Work
  // list, a project's page, Insights, Settings), so a slash command's notice
  // and a launch error are seen wherever the surface is.
  const status = (
    <LauncherStatus
      lines={launcherStatusLines({ commandNotice, canOpenAgents: openAgent !== undefined, state })}
      onDismiss={() => launcherNotices.take()}
      theme={theme}
      styles={styles}
    />
  );

  if (view === "inbox") {
    return framed(<InboxScreen {...props} data={inbox} status={status} onOpenWork={() => setView("work")} />);
  }

  if (view === "insights") {
    // Insights (experience concept §4.3): flow, cost and Beads figures, narrowed to a project by name.
    return framed(
      <InsightsScreen
        {...props}
        projects={insightsProjects(workspaces.data ?? [], stored.data?.workspaces ?? [])}
        status={status}
      />,
    );
  }

  if (view === "settings") {
    // Settings (experience concept §4.4): Agents · Autonomy · Tools & skills · Data.
    return framed(<SettingsScreen {...props} status={status} />);
  }

  const projectTab = projectTabOf(view);
  if (projectTab !== null && project !== null) {
    // A project's page (experience concept §4.2), opened on Requests or Beads.
    return framed(
      <ProjectPage
        key={`${project.id}:${view}`}
        {...props}
        workspaceId={project.id}
        label={project.label}
        initialTab={projectTab}
        closed={project.closed}
        onBack={goBack}
        backLabel={backLabelOf(view) ?? undefined}
        status={status}
        // A closed workspace has history only: no Manager to chat with.
        onChat={openAgent === undefined || project.closed !== undefined ? undefined : () => void managerLauncher.launch(project.id, { ensure, openAgent })}
        chatBusy={pending && state.workspaceId === project.id}
      />,
    );
  }

  // Work's own screen (experience concept §4.2): the projects, most recent
  // activity first as `workspaces.list` returns them (no pinning, delta
  // 20260918f §4.5), one tab away (no ←). A row opens its project's page.
  return framed(
    <WorkScreen
      theme={theme}
      compact={layout.compact}
      workspaces={workspaces.data?.map((workspace) => ({
        id: workspace.id,
        label: workspace.label,
        detail: workspace.detail === workspace.label ? "" : workspace.detail,
      }))}
      workspacesError={workspaces.isError ? errorMessageOf(workspaces.error) : null}
      overview={overviewById}
      closed={closedWorkspaces(stored.data?.workspaces ?? [], workspaces.data?.map((workspace) => workspace.id) ?? [])}
      status={status}
      footer={`paseo-bm ${PLUGIN_VERSION}`}
      renderDot={(workspaceId) => (
        <RunningDot counts={overviewById.get(workspaceId)?.runningAgents} theme={theme} styles={styles} bare />
      )}
      onOpen={(workspaceId, label) => {
        const known = workspaces.data?.find((workspace) => workspace.id === workspaceId);
        // A workspace Paseo no longer lists: its page offers what can be done with its history.
        const closed = known === undefined ? stored.data?.workspaces.find((entry) => entry.workspaceId === workspaceId)?.state : undefined;
        setProject({ id: workspaceId, label: known?.screenTitle ?? label, ...(closed === undefined ? {} : { closed }) });
        setView("project-requests");
      }}
    />,
  );
}
