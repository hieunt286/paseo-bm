/**
 * Settings, the fourth section of the management surface (experience concept
 * §4.4, autonomy design §A.12): four groups on one scrolling screen, each
 * folded to one line with its state.
 *
 * - **Agents** — the roles (provider, model, thinking, mode) with their
 *   fallback chains, sign-in, and Paseo's agent tools.
 * - **Autonomy** — one line until Phase 2 brings the policy matrix.
 * - **Tools & skills** — `br`, `bv` and the agent skills, with install or
 *   copy-command actions.
 * - **Data** — the data folder, the trace storage with its cleanup per
 *   workspace, and removing paseo-bm's settings.
 *
 * Built from the Setup screen's pieces (`settings-blocks.tsx`) and wording
 * (`setup-model.ts`); the rest of the old Setup screen is retired (autonomy
 * design §A.14). Every confirmation puts Cancel first.
 * The one-line states come from `settings-model.ts`, tested without a
 * renderer; the hook-free pieces below are tested with the element-tree helper.
 *
 * Client rules: React Native primitives only, colours from the theme, no Node
 * import, no `server/` import.
 */
import { type PluginSurfaceProps, useRpc, useSettings } from "@getpaseo/plugin/client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState, type ReactNode } from "react";
import { ActivityIndicator, Pressable, ScrollView, Text, View } from "react-native";
import { setupEnsureRolesRpc, setupStatusRpc, tracesWorkspacesRpc, type SetupStatus } from "../shared/contracts";
import { DEFAULT_WARN_ABOVE_BYTES, dashboardSettings } from "../shared/settings";
import { PLUGIN_VERSION } from "../shared/version";
import { TraceActions } from "./dashboard-actions";
import { PRIVACY_NOTICE, dashboardStyles, toneColor } from "./dashboard-model";
import { errorMessageOf } from "./launch-manager";
import {
  AUTONOMY_COMING,
  DEFAULT_OPEN_GROUPS,
  SETTINGS_GROUPS,
  THRESHOLD_NOTE,
  agentsGroupState,
  dataGroupState,
  groupHeaderView,
  storageSummary,
  toggleGroup,
  toolsGroupState,
  type GroupHeaderView,
  type SettingsGroupKey,
  type StorageRow,
} from "./settings-model";
import {
  PLUGIN_DIAGNOSTICS_LINE,
  SKILLS_COMMAND_LABEL,
  anySkillMissing,
  dataHomeLine,
  ensureRolesLine,
  migrationBanner,
  paseoToolsWarnings,
  rolesCreatedLine,
  signInRows,
  skillChips,
  skillDirsText,
  skillsRunLine,
  type EnsureRolesLine,
} from "./setup-model";
import { AgentToolsBlockView, CleanupBlock, CommandLine, RolesSection, SkillsInstallBlock, ToolCard } from "./settings-blocks";
import { Chip, type Styles, type Theme } from "./ui";

/** The query Settings reads: the roles ensured, then the status. */
const SETUP_STATUS_KEY = ["paseo-bm", "setup", "status"] as const;
const STORED_WORKSPACES_KEY = ["paseo-bm", "settings", "stored-workspaces"] as const;

export interface SettingsScreenProps extends PluginSurfaceProps {
  /** The surface's status strip (slash-command notice, launch state), drawn under the title. */
  status?: ReactNode;
}

/**
 * The folded line of one group: marker, title and state, the whole line one
 * button. A group that does not open (Autonomy, before Phase 2) is plain text.
 */
export function SettingsGroupHeader({ view, onToggle, styles, theme }: {
  view: GroupHeaderView;
  onToggle: () => void;
  styles: Styles;
  theme: Theme;
}) {
  const line = (
    <View style={{ gap: 2 }}>
      <Text style={styles.sectionTitle}>{view.marker === null ? view.title : `${view.marker} ${view.title}`}</Text>
      <Text style={[styles.body, { color: toneColor(theme, view.state.tone) }]} numberOfLines={2}>
        {view.state.text}
      </Text>
    </View>
  );
  if (view.marker === null) {
    return (
      <View style={styles.card} accessibilityLabel={view.accessibilityLabel}>
        {line}
      </View>
    );
  }
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={view.accessibilityLabel}
      accessibilityState={{ expanded: view.marker === "▾" }}
      onPress={onToggle}
      style={styles.card}
    >
      {line}
    </Pressable>
  );
}

/** What `setup.ensure-roles` said, with its button (Try again / Set up again) and Dismiss. */
export function RolesLineView({ line, busy, onAct, onDismiss, styles, theme }: {
  line: EnsureRolesLine;
  busy: boolean;
  onAct: () => void;
  onDismiss: () => void;
  styles: Styles;
  theme: Theme;
}) {
  return (
    <View style={{ gap: 6 }}>
      <Text style={[styles.body, { color: toneColor(theme, line.tone) }]} selectable>
        {line.text}
      </Text>
      <View style={styles.chipRow}>
        {line.button === null ? null : (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={line.button === "Set up again" ? "Set up paseo-bm's roles again" : "Try to create the roles again"}
            accessibilityState={{ disabled: busy, busy }}
            disabled={busy}
            onPress={onAct}
            style={[styles.button, { alignSelf: "flex-start" }]}
          >
            <Text style={styles.buttonText}>{line.button}</Text>
          </Pressable>
        )}
        {line.dismissable ? (
          <Pressable accessibilityRole="button" accessibilityLabel="Dismiss this line" onPress={onDismiss} style={styles.secondaryButton}>
            <Text style={styles.secondaryButtonText}>Dismiss</Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

/** One workspace of the Data group's storage: name, size and state; the cleanup opens under it. */
export function StorageRowView({ row, open, onToggle, styles, children }: {
  row: StorageRow;
  open: boolean;
  onToggle: () => void;
  styles: Styles;
  children?: ReactNode;
}) {
  return (
    <View style={{ gap: 6 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <View style={{ flex: 1, minWidth: 160, gap: 2 }}>
          <Text style={styles.body} numberOfLines={1}>
            {row.label}
          </Text>
          <Text style={[styles.body, { fontSize: 11 }]}>{row.detail}</Text>
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={open ? `Close the traces of ${row.label}` : `Delete or move the traces of ${row.label}`}
          accessibilityState={{ expanded: open }}
          onPress={onToggle}
          style={styles.secondaryButton}
        >
          <Text style={styles.secondaryButtonText}>{open ? "Close" : "Clean up…"}</Text>
        </Pressable>
      </View>
      {open ? children : null}
    </View>
  );
}

/** The skills block of Tools & skills: Test, Install skills…, each skill's chips and the command to copy. */
function SkillsBlock({ status, testing, onTest, onDone, styles, theme }: {
  status: SetupStatus;
  testing: boolean;
  onTest: () => void;
  onDone: () => void;
  styles: Styles;
  theme: Theme;
}) {
  const runLine = skillsRunLine(status);
  return (
    <>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Text style={[styles.sectionTitle, { flex: 1 }]}>Agent skills</Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Test the agent skills again"
          accessibilityState={{ disabled: testing, busy: testing }}
          disabled={testing}
          onPress={onTest}
          style={styles.secondaryButton}
        >
          <Text style={styles.secondaryButtonText}>{testing ? "Testing…" : "Test"}</Text>
        </Pressable>
      </View>
      {anySkillMissing(status) ? (
        <SkillsInstallBlock command={status.skills.installCommand} onDone={onDone} styles={styles} theme={theme} />
      ) : null}
      {runLine === null ? null : <Text style={[styles.body, { fontSize: 11 }]}>{runLine}</Text>}
      <View style={[styles.card, { gap: 6 }]}>
        <Text style={styles.body}>{`Checked ${new Date(status.skills.checkedAt).toLocaleTimeString()} · ${skillDirsText(status.skills.dirs)}`}</Text>
        {status.skills.skills.map((skill) => (
          <View key={skill.name} style={{ gap: 2 }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
              <Text style={[styles.mono, { flex: 1 }]}>{`${skill.name}${skill.required ? "" : " (optional)"}`}</Text>
              {skillChips(skill).map((badge) => (
                <Chip key={badge.text} badge={badge} styles={styles} theme={theme} />
              ))}
            </View>
            {skill.problem === null ? null : <Text style={[styles.body, { color: toneColor(theme, "danger") }]}>{skill.problem}</Text>}
          </View>
        ))}
        <CommandLine label={SKILLS_COMMAND_LABEL} command={status.skills.installCommand} styles={styles} theme={theme} />
      </View>
    </>
  );
}

/**
 * `setup.status` after `setup.ensure-roles`, in one chain and under the Setup
 * screen's key: opening Settings is a first-use trigger like opening the
 * Manager (design §7.13.2), and never shows a machine half set up.
 */
function useSetupStatus() {
  const getStatus = useRpc(setupStatusRpc);
  const ensure = useRpc(setupEnsureRolesRpc);
  return useQuery({
    queryKey: SETUP_STATUS_KEY,
    queryFn: async () => {
      let ensured: Awaited<ReturnType<typeof ensure>> | null = null;
      let rolesError: unknown = null;
      try {
        ensured = await ensure({});
      } catch (error) {
        rolesError = error;
      }
      return { ...(await getStatus({})), ensured, rolesError };
    },
  });
}

export function SettingsScreen({ theme, layout, status: statusStrip }: SettingsScreenProps) {
  const styles = useMemo(() => dashboardStyles(theme, layout.compact), [theme, layout.compact]);
  const ensure = useRpc(setupEnsureRolesRpc);
  const listStored = useRpc(tracesWorkspacesRpc);
  const queryClient = useQueryClient();
  const status = useSetupStatus();
  const stored = useQuery({ queryKey: STORED_WORKSPACES_KEY, queryFn: () => listStored({}) });
  const threshold = useSettings(dashboardSettings);
  const warnAboveBytes = threshold.status === "ready" ? threshold.values.warnAboveBytes : DEFAULT_WARN_ABOVE_BYTES;

  const [open, setOpen] = useState<ReadonlySet<SettingsGroupKey>>(DEFAULT_OPEN_GROUPS);
  const [openStorage, setOpenStorage] = useState<string | null>(null);
  const [dismissedRoles, setDismissedRoles] = useState(false);
  const [rolesBusy, setRolesBusy] = useState(false);

  const data = status.data;
  const cleanedUp = data?.ensured?.skipped === "cleaned-up";
  const rolesError = data === undefined || data.rolesError === null ? null : errorMessageOf(data.rolesError);
  const rolesLine = data === undefined ? null : ensureRolesLine(data.ensured, data.rolesError);
  const storage = stored.data === undefined ? null : storageSummary(stored.data.workspaces, warnAboveBytes);
  const refetch = () => void status.refetch();
  const refreshStorage = () => {
    void stored.refetch();
    // Work's list and a project's Requests read the same history.
    void queryClient.invalidateQueries({ queryKey: ["paseo-bm", "launcher", "stored-workspaces"] });
    void queryClient.invalidateQueries({ queryKey: ["paseo-bm", "traces"] });
  };

  const states: Record<SettingsGroupKey, ReturnType<typeof agentsGroupState>> = {
    agents: agentsGroupState(data, { error: rolesError, cleanedUp }),
    autonomy: { text: AUTONOMY_COMING, tone: "muted" },
    tools: toolsGroupState(data),
    data: dataGroupState(data, storage, cleanedUp),
  };

  const agents = (
    <View style={{ gap: 10 }}>
      {rolesLine === null || (rolesLine.dismissable && dismissedRoles) ? null : (
        <RolesLineView
          line={rolesLine}
          busy={rolesBusy}
          onAct={() =>
            void (async () => {
              setRolesBusy(true);
              try {
                // "Set up again" is the only call that clears the cleanup mark.
                if (rolesLine.button === "Set up again") await ensure({ resume: true });
                await status.refetch();
              } finally {
                setRolesBusy(false);
              }
            })()
          }
          onDismiss={() => setDismissedRoles(true)}
          styles={styles}
          theme={theme}
        />
      )}
      {data === undefined || rolesCreatedLine(data) === null ? null : (
        <Text style={[styles.body, { fontSize: 11 }]}>{rolesCreatedLine(data)}</Text>
      )}
      {data === undefined
        ? null
        : paseoToolsWarnings(data).map((warning) => (
            <Text key={warning} style={[styles.body, { color: toneColor(theme, "warning") }]}>
              {warning}
            </Text>
          ))}
      <RolesSection styles={styles} theme={theme} />
      {data === undefined ? null : <AgentToolsBlockView status={data} onDone={refetch} styles={styles} theme={theme} />}
      {data === undefined || signInRows(data).length === 0 ? null : (
        <View style={[styles.card, { gap: 6 }]}>
          <Text style={styles.sectionTitle}>Sign-in</Text>
          <Text style={[styles.body, { fontSize: 11 }]}>paseo-bm never runs a login command and never sees your credentials.</Text>
          {signInRows(data).map((row) => (
            <View key={row.provider} style={{ gap: 2 }}>
              <Text style={styles.body}>{`${row.provider} · ${row.usedBy}`}</Text>
              <Text style={[styles.body, { color: toneColor(theme, row.tone) }]} selectable>
                {row.text}
              </Text>
              {row.command === null ? null : <CommandLine label="Run it yourself" command={row.command} styles={styles} theme={theme} />}
            </View>
          ))}
        </View>
      )}
    </View>
  );

  const tools =
    data === undefined ? null : (
      <View style={{ gap: 10 }}>
        <Text style={styles.sectionTitle}>Beads tools</Text>
        {data.tools.map((tool) => (
          <ToolCard key={tool.id} tool={tool} styles={styles} theme={theme} onInstalled={refetch} />
        ))}
        <Text style={[styles.body, { fontSize: 11 }]}>{`Newest versions as of ${data.latestCheckedOn}; paseo-bm does not look them up online.`}</Text>
        <SkillsBlock status={data} testing={status.isFetching} onTest={refetch} onDone={refetch} styles={styles} theme={theme} />
      </View>
    );

  const home = data === undefined ? null : dataHomeLine(data);
  const banner = data === undefined ? null : migrationBanner(data);
  const dataGroup = (
    <View style={{ gap: 10 }}>
      {home === null ? null : (
        <Text style={[styles.body, { color: toneColor(theme, home.tone) }]} selectable>
          {home.text}
        </Text>
      )}
      {/* This install came from the retired `npx` installer (design §7.13.6). */}
      {banner === null ? null : (
        <View style={[styles.card, { gap: 6 }]}>
          <Text style={[styles.body, { color: toneColor(theme, "warning") }]} selectable>
            {banner.text}
          </Text>
          <CommandLine label="Run it once" command={banner.command} styles={styles} theme={theme} />
        </View>
      )}
      <Text style={styles.sectionTitle}>Trace storage</Text>
      {stored.isPending ? <ActivityIndicator color={styles.spinner.color} /> : null}
      {stored.isError ? (
        <Text style={[styles.body, { color: toneColor(theme, "danger") }]}>{errorMessageOf(stored.error)}</Text>
      ) : null}
      {storage === null ? null : (
        <>
          <Text style={styles.body}>{storage.summary}</Text>
          {storage.warning === null ? null : (
            <Text style={[styles.body, { color: toneColor(theme, storage.warning.tone) }]}>{storage.warning.text}</Text>
          )}
          <Text style={[styles.body, { fontSize: 11 }]}>{THRESHOLD_NOTE}</Text>
          <Text style={[styles.body, { fontSize: 11 }]}>{PRIVACY_NOTICE}</Text>
          {storage.rows.map((row) => (
            <StorageRowView
              key={row.workspaceId}
              row={row}
              open={openStorage === row.workspaceId}
              onToggle={() => setOpenStorage(openStorage === row.workspaceId ? null : row.workspaceId)}
              styles={styles}
            >
              <View style={styles.card}>
                <TraceActions
                  theme={theme}
                  compact={layout.compact}
                  styles={styles}
                  workspaceId={row.workspaceId}
                  scope="workspace"
                  workspaceState={row.state}
                  onDone={refreshStorage}
                />
              </View>
            </StorageRowView>
          ))}
        </>
      )}
      <Text style={styles.sectionTitle}>This install</Text>
      <Text style={[styles.body, { fontSize: 11 }]}>{`paseo-bm ${PLUGIN_VERSION}`}</Text>
      <Text style={[styles.body, { fontSize: 11 }]} selectable>
        {PLUGIN_DIAGNOSTICS_LINE}
      </Text>
      {data === undefined ? null : <CleanupBlock status={data} onCleaned={refetch} styles={styles} theme={theme} />}
    </View>
  );

  const bodies: Record<SettingsGroupKey, ReactNode> = { agents, autonomy: null, tools, data: dataGroup };

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <Text style={styles.title}>Settings</Text>
      {statusStrip}
      {status.isPending ? <ActivityIndicator color={styles.spinner.color} /> : null}
      {status.isError ? (
        <Text style={[styles.body, { color: toneColor(theme, "danger") }]}>{errorMessageOf(status.error)}</Text>
      ) : null}
      {SETTINGS_GROUPS.map((group) => {
        const expanded = open.has(group.key);
        return (
          <View key={group.key} style={{ gap: 8 }}>
            <SettingsGroupHeader
              view={groupHeaderView(group.key, states[group.key], expanded)}
              onToggle={() => setOpen((current) => toggleGroup(current, group.key))}
              styles={styles}
              theme={theme}
            />
            {expanded ? bodies[group.key] : null}
          </View>
        );
      })}
    </ScrollView>
  );
}
