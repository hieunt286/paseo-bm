/**
 * "Beads Manager" surface (WP-113): the screen behind the sidebar item and the
 * Command Center items. It only renders; the launch logic, texts and styles live
 * in `launch-manager.ts`, which is tested without a renderer.
 *
 * It is the section router of the management surface (autonomy design §A.12,
 * change-014 outcome 5): it opens on the Inbox, and the shell header
 * (`shell-header.tsx`, the approved mockup's bar) switches Inbox · Projects ·
 * Settings · Tools & skills, the Inbox tab carrying the count of what needs
 * the owner (DQ-3), and shows the Orchestrator's status. Projects is `work.tsx` (the projects,
 * and a project's Overview · Requests · Beads · Metrics · Agents, Metrics
 * being `insights.tsx`); Settings is `settings-section.tsx`, built from the
 * Setup screen's pieces — so nothing that existed is out of reach; Tools &
 * skills is `tools-screen.tsx`.
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
import { ToolsScreen } from "./tools-screen";
import { InboxScreen, useInbox } from "./inbox";
import { insightsProjects } from "./insights-model";
import { inboxTab } from "./inbox-model";
import { WorkScreen } from "./work";
import {
  SURFACE_HOME_VIEW,
  SURFACE_SECTIONS,
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
import { ShellHeader } from "./shell-header";
import type { TextTab } from "./text-tabs";
import { toneColor, type Tone } from "./tone";
import { managerEnsureRpc, tracesWorkspacesRpc, workspacesOverviewRpc } from "../shared/contracts";
import { PLUGIN_VERSION } from "../shared/version";
import {
  launcherStatusLines,
  launcherStyles,
  launchRequests,
  managerLauncher,
  runPendingRequest,
  type StatusLine,
} from "./launch-manager";
import { errorMessageOf } from "./errors";

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
  // Bead counts and running agents; read and refreshed only while the Projects
  // list shows them (delta 20260918f F5).
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

  // Settings and Tools name a project by its own name, as the mockup does (change-014).
  const projectNames = useMemo(() => (workspaces.data ?? []).map((workspace) => ({ id: workspace.id, screenTitle: workspace.label })), [workspaces.data]);
  // A project page opened from elsewhere (the Inbox, the Command Center) shows beside the Projects list:
  // each opening is one request to the list, numbered so the same project can be asked for again.
  const requestCount = useRef(0);
  const projectTabNow = projectTabOf(view);
  const projectRequest = useMemo(
    () => (projectTabNow !== null && project !== null ? { workspaceId: project.id, tab: projectTabNow, nonce: (requestCount.current += 1) } : null),
    [view, project?.id],
  );
  // A project's name for the Inbox: open workspaces first, then the history of closed ones.
  const projectOf = useMemo(() => {
    const names = new Map<string, string>();
    for (const closed of stored.data?.workspaces ?? []) {
      if (closed.lastKnownName !== null) names.set(closed.workspaceId, closed.lastKnownName);
    }
    // The project's own name, as the mockup's group headings show it (change-014).
    for (const workspace of workspaces.data ?? []) names.set(workspace.id, workspace.label);
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
      setView("project-overview");
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


  // The section tabs, above every view: Inbox (with its count) · Projects · Settings · Tools & skills.
  const tabs: TextTab[] = SURFACE_SECTIONS.map((section) => {
    if (section.key !== "inbox") return { key: section.key, label: section.label };
    const tab = inboxTab(inbox.view?.count ?? null);
    return {
      key: tab.key,
      label: tab.label,
      badge: tab.count ?? null,
      accessibilityLabel: tab.hint === undefined ? tab.label : `${tab.label}: ${tab.hint}`,
    };
  });
  // The shell (the mockup's header): the brand, the section nav and the
  // Orchestrator's status in one bar, the section's own screen below it.
  const framed = (screen: ReactNode) => (
    <View style={{ flex: 1, backgroundColor: theme.colors.surface0 }}>
      <ShellHeader
        tabs={tabs}
        selected={sectionOf(view)}
        onSelect={(key) => setView(sectionHomeOf(key as SurfaceSection))}
        theme={theme}
        compact={layout.compact}
        navigation={navigation}
      />
      <View style={{ flex: 1 }}>{screen}</View>
    </View>
  );

  // Built ONCE and placed on every view of the surface (the Inbox, the
  // Projects list, a project's page, Settings, Tools & skills), so a slash command's notice
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
    return framed(<InboxScreen {...props} data={inbox} status={status} onOpenWork={() => setView("projects")} />);
  }

  if (view === "settings") {
    // Settings (experience concept §4.4, change-014 outcome 5): projects named as the Projects list names them.
    return framed(
      <SettingsScreen {...props} projects={insightsProjects(projectNames, stored.data?.workspaces ?? [])} status={status} />,
    );
  }

  if (view === "tools") {
    // Tools & skills (change-014 outcome 5): the props Settings gets.
    return framed(
      <ToolsScreen {...props} projects={insightsProjects(projectNames, stored.data?.workspaces ?? [])} status={status} />,
    );
  }

  // The Projects list (experience concept §4.2): the projects, most recent
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
      // The list and the chosen project's page side by side (change-014, the mockup's Projects).
      surface={props}
      onOpenSettings={() => setView("settings")}
      request={projectRequest}
    />,
  );
}
