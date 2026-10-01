/**
 * Settings, the fourth section of the management surface (experience concept
 * §4.4, autonomy design §A.12): five groups on one scrolling screen, each
 * folded to one line with its state.
 *
 * - **Agents** — the roles (provider, model, thinking, mode) with their
 *   fallback chains, sign-in, and Paseo's agent tools.
 * - **Autonomy** — the owner's policy, one matrix per project (autonomy
 *   design §B.2; `settings-autonomy.tsx`).
 * - **Coordination** — how often the Orchestrator advises, compaction
 *   and handoff, each switched on its own with its thresholds, and the review
 *   budget per tier (autonomy design §G.7; `settings-coordination.tsx`).
 * - **Tools & skills** — `br`, `bv` and the agent skills, with install or
 *   copy-command actions.
 * - **Data** — the data folder, the trace storage with its cleanup per
 *   workspace, and removing paseo-bm's settings.
 *
 * Built from the Setup screen's pieces (`settings-blocks.tsx`) and wording
 * (`settings-machine-model.ts`, `settings-roles-model.ts`); the rest of the old
 * Setup screen is retired (autonomy design §A.14). Every confirmation puts
 * Cancel first.
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
import {
  autonomyPolicyRpc,
  coordinationSetRpc,
  coordinationSettingsRpc,
  setupEnsureRolesRpc,
  setupStatusRpc,
  tracesWorkspacesRpc,
  type AutonomyPolicyOutput,
  type CoordinationSettingsOutput,
  type SetupStatus,
} from "../shared/contracts";
import { COORDINATION_MECHANISMS, type CoordinationMechanism } from "../shared/coordination";
import { DEFAULT_WARN_ABOVE_BYTES, dashboardSettings } from "../shared/settings";
import { PLUGIN_VERSION } from "../shared/version";
import { TraceActions } from "./dashboard-actions";
import { PRIVACY_NOTICE } from "./history-model";
import { dashboardStyles } from "./styles";
import { errorMessageOf } from "./errors";
import type { InsightsProject } from "./insights-model";
import { AutonomyGroup } from "./settings-autonomy";
import { AUTONOMY_POLICY_KEY, autonomyGroupState } from "./settings-autonomy-model";
import { MechanismCard, ReviewBudgetCard } from "./settings-coordination";
import {
  changedReviewBudget,
  changedThresholds,
  defaultsDraft,
  mechanismCardView,
  reviewBudgetCardView,
  reviewBudgetDefaultsDraft,
  reviewBudgetValueOf,
  stepReviewBudget,
  stepThreshold,
  thresholdValueOf,
  turnOnDialog,
  type ReviewBudgetDraft,
  type ThresholdDraft,
  type ThresholdKey,
} from "./settings-coordination-model";
import {
  DEFAULT_OPEN_GROUPS,
  SETTINGS_GROUPS,
  THRESHOLD_NOTE,
  adviceCadenceView,
  agentsGroupState,
  coordinationGroupState,
  dataGroupState,
  groupHeaderView,
  stepAdviceCadence,
  storageSummary,
  toggleGroup,
  toolsGroupState,
  type AdviceCadenceView,
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
  paseoToolsWarnings,
  rolesCreatedLine,
  signInRows,
  skillChips,
  skillDirsText,
  skillsRunLine,
  type EnsureRolesLine,
} from "./settings-machine-model";
import { AgentToolsBlockView, CleanupBlock, CommandLine, RolesSection, SkillsInstallBlock, ToolCard, useBusyAction } from "./settings-blocks";
import { Button, Chip, ToneText, type Styles, type Theme } from "./ui";
import { localTimeText } from "./format";

/** The query Settings reads: the roles ensured, then the status. */
const SETUP_STATUS_KEY = ["paseo-bm", "setup", "status"] as const;
const STORED_WORKSPACES_KEY = ["paseo-bm", "settings", "stored-workspaces"] as const;
const COORDINATION_KEY = ["paseo-bm", "settings", "coordination"] as const;

export interface SettingsScreenProps extends PluginSurfaceProps {
  /** The surface's status strip (slash-command notice, launch state), drawn under the title. */
  status?: ReactNode;
  /** Projects the surface knows by name, as Insights names them: the Autonomy matrix's tabs. */
  projects?: readonly InsightsProject[];
}

/**
 * The folded line of one group: marker, title and state, the whole line one
 * button. A group that does not open is plain text.
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
      <ToneText tone={view.state.tone} numberOfLines={2} styles={styles} theme={theme}>
        {view.state.text}
      </ToneText>
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
      <ToneText tone={line.tone} selectable styles={styles} theme={theme}>
        {line.text}
      </ToneText>
      <View style={styles.chipRow}>
        {line.button === null ? null : (
          <Button
            label={line.button}
            kind="primary"
            accessibilityLabel={line.button === "Set up again" ? "Set up paseo-bm's roles again" : "Try to create the roles again"}
            accessibilityState={{ disabled: busy, busy }}
            disabled={busy}
            onPress={onAct}
            style={{ alignSelf: "flex-start" }}
            styles={styles}
          />
        )}
        {line.dismissable ? (
          <Button label="Dismiss" kind="secondary" accessibilityLabel="Dismiss this line" onPress={onDismiss} styles={styles} />
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
        <Button
          label={open ? "Close" : "Clean up…"}
          kind="secondary"
          accessibilityLabel={open ? `Close the traces of ${row.label}` : `Delete or move the traces of ${row.label}`}
          accessibilityState={{ expanded: open }}
          onPress={onToggle}
          styles={styles}
        />
      </View>
      {open ? children : null}
    </View>
  );
}

/** One button of the advice cadence row, labelled and disabled as its view says. */
function CadenceButtonView({ button, primary, onPress, styles }: {
  button: AdviceCadenceView["save"];
  primary: boolean;
  onPress: () => void;
  styles: Styles;
}) {
  return (
    <Button
      label={button.label}
      kind={primary ? "primary" : "secondary"}
      accessibilityLabel={button.accessibilityLabel}
      accessibilityState={{ disabled: !button.enabled }}
      disabled={!button.enabled}
      onPress={onPress}
      styles={styles}
    />
  );
}

/**
 * The advice cadence (autonomy design §G.7): its meaning in one line, the
 * value with − and +, Save, and the default. A failed save says why under it.
 */
export function AdviceCadenceRow({ view, error, onStep, onSave, onReset, styles, theme }: {
  view: AdviceCadenceView;
  error: string | null;
  onStep: (step: -1 | 1) => void;
  onSave: () => void;
  onReset: () => void;
  styles: Styles;
  theme: Theme;
}) {
  return (
    <View style={[styles.card, { gap: 6 }]}>
      <Text style={styles.sectionTitle}>{view.title}</Text>
      <Text style={[styles.body, { fontSize: 11 }]}>{view.meaning}</Text>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <CadenceButtonView button={view.decrease} primary={false} onPress={() => onStep(-1)} styles={styles} />
        <Text style={styles.body}>{view.valueText}</Text>
        <CadenceButtonView button={view.increase} primary={false} onPress={() => onStep(1)} styles={styles} />
      </View>
      <View style={styles.chipRow}>
        <CadenceButtonView button={view.save} primary onPress={onSave} styles={styles} />
        {view.reset === null ? null : <CadenceButtonView button={view.reset} primary={false} onPress={onReset} styles={styles} />}
      </View>
      {error === null ? null : (
        <ToneText tone="danger" selectable styles={styles} theme={theme}>
          {error}
        </ToneText>
      )}
    </View>
  );
}

/**
 * One of compaction and handoff (autonomy design §G.7): its switch saves at
 * once (turning on after a confirmation), its thresholds stay local until
 * Save, which sends one `coordination.set` per changed setting.
 */
function MechanismGroup({ mechanism, data, onSaved, styles, theme }: {
  mechanism: CoordinationMechanism;
  data: CoordinationSettingsOutput;
  onSaved: (settings: CoordinationSettingsOutput["settings"]) => void;
  styles: Styles;
  theme: Theme;
}) {
  const save = useRpc(coordinationSetRpc);
  const [draft, setDraft] = useState<ThresholdDraft>({});
  const [asking, setAsking] = useState(false);
  const { busy, run } = useBusyAction();
  const [error, setError] = useState<string | null>(null);
  const settings = data.settings;
  const view = mechanismCardView({ mechanism, settings, defaults: data.defaults, draft, saving: busy, now: new Date() });
  const setSwitch = (value: boolean) =>
    run(
      async () => {
        setError(null);
        const output = await save(mechanism === "compact" ? { key: "compact.enabled", value } : { key: "handoff.enabled", value });
        onSaved(output.settings);
        setAsking(false);
      },
      (failure) => setError(errorMessageOf(failure)),
    );
  return (
    <MechanismCard
      view={view}
      dialog={asking ? turnOnDialog(mechanism, settings) : null}
      busy={busy}
      error={error}
      onToggle={() => {
        setError(null);
        if (view.toggle.turnsOn) setAsking(true);
        else setSwitch(false);
      }}
      onConfirm={() => setSwitch(true)}
      onCancel={() => setAsking(false)}
      onStep={(key, step) => {
        setError(null);
        setDraft((current) => ({ ...current, [key]: stepThreshold(key, thresholdValueOf(settings, current, key), step) }));
      }}
      onSave={() =>
        run(
          async () => {
            setError(null);
            for (const change of changedThresholds(mechanism, settings, draft)) {
              const output = await save(change);
              onSaved(output.settings);
              setDraft((current) => Object.fromEntries(Object.entries(current).filter(([key]) => key !== change.key)) as Partial<Record<ThresholdKey, number>>);
            }
          },
          (failure) => setError(errorMessageOf(failure)),
        )
      }
      onReset={() => {
        setError(null);
        setDraft(defaultsDraft(mechanism, data.defaults));
      }}
      styles={styles}
      theme={theme}
    />
  );
}

/**
 * The review budget per tier (autonomy design §C.4, §G.7; bead `7gxw.12`):
 * each tier's review calls stay a local draft until Save, which sends one
 * `coordination.set` per changed tier. Only a Worker created afterwards gets
 * the new budget.
 */
function ReviewBudgetGroup({ data, onSaved, styles, theme }: {
  data: CoordinationSettingsOutput;
  onSaved: (settings: CoordinationSettingsOutput["settings"]) => void;
  styles: Styles;
  theme: Theme;
}) {
  const save = useRpc(coordinationSetRpc);
  const [draft, setDraft] = useState<ReviewBudgetDraft>({});
  const { busy, run } = useBusyAction();
  const [error, setError] = useState<string | null>(null);
  const settings = data.settings;
  return (
    <ReviewBudgetCard
      view={reviewBudgetCardView({ settings, defaults: data.defaults, draft, saving: busy })}
      error={error}
      onStep={(key, step) => {
        setError(null);
        setDraft((current) => ({ ...current, [key]: stepReviewBudget(key, reviewBudgetValueOf(settings, current, key), step) }));
      }}
      onSave={() =>
        run(
          async () => {
            setError(null);
            for (const change of changedReviewBudget(settings, draft)) {
              const output = await save(change);
              onSaved(output.settings);
              setDraft((current) => Object.fromEntries(Object.entries(current).filter(([key]) => key !== change.key)) as ReviewBudgetDraft);
            }
          },
          (failure) => setError(errorMessageOf(failure)),
        )
      }
      onReset={() => {
        setError(null);
        setDraft(reviewBudgetDefaultsDraft(data.defaults));
      }}
      styles={styles}
      theme={theme}
    />
  );
}

/**
 * Settings → Coordination (autonomy design §G.7): the owner's settings of how
 * the Orchestrator coordinates — the advice cadence, then compaction and
 * handoff, each a card of its own, then the review budget. An edit stays
 * local until Save.
 */
function CoordinationGroup({ data, onSaved, styles, theme }: {
  data: CoordinationSettingsOutput;
  onSaved: (settings: CoordinationSettingsOutput["settings"]) => void;
  styles: Styles;
  theme: Theme;
}) {
  const save = useRpc(coordinationSetRpc);
  const [draft, setDraft] = useState<number | null>(null);
  const { busy: saving, run } = useBusyAction();
  const [error, setError] = useState<string | null>(null);
  const stored = data.settings.advice.everyFinished;
  const value = draft ?? stored;
  const view = adviceCadenceView({ stored, draft: value, defaultValue: data.defaults.advice.everyFinished, saving });
  const edit = (next: number) => {
    setError(null);
    setDraft(next);
  };
  return (
    <View style={{ gap: 10 }}>
      <AdviceCadenceRow
        view={view}
        error={error}
        onStep={(step) => edit(stepAdviceCadence(value, step))}
        onReset={() => edit(data.defaults.advice.everyFinished)}
        onSave={() =>
          run(
            async () => {
              setError(null);
              const output = await save({ key: "advice.everyFinished", value });
              onSaved(output.settings);
              setDraft(null);
            },
            (failure) => setError(errorMessageOf(failure)),
          )
        }
        styles={styles}
        theme={theme}
      />
      {COORDINATION_MECHANISMS.map((mechanism) => (
        <MechanismGroup key={mechanism} mechanism={mechanism} data={data} onSaved={onSaved} styles={styles} theme={theme} />
      ))}
      <ReviewBudgetGroup data={data} onSaved={onSaved} styles={styles} theme={theme} />
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
  const now = new Date();
  const runLine = skillsRunLine(status, now);
  return (
    <>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Text style={[styles.sectionTitle, { flex: 1 }]}>Agent skills</Text>
        <Button
          label={testing ? "Testing…" : "Test"}
          kind="secondary"
          accessibilityLabel="Test the agent skills again"
          accessibilityState={{ disabled: testing, busy: testing }}
          disabled={testing}
          onPress={onTest}
          styles={styles}
        />
      </View>
      {anySkillMissing(status) ? (
        <SkillsInstallBlock command={status.skills.installCommand} onDone={onDone} styles={styles} theme={theme} />
      ) : null}
      {runLine === null ? null : <Text style={[styles.body, { fontSize: 11 }]}>{runLine}</Text>}
      <View style={[styles.card, { gap: 6 }]}>
        <Text style={styles.body}>{`Checked ${localTimeText(new Date(status.skills.checkedAt), now)} · ${skillDirsText(status.skills.dirs)}`}</Text>
        {status.skills.skills.map((skill) => (
          <View key={skill.name} style={{ gap: 2 }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
              <Text style={[styles.mono, { flex: 1 }]}>{`${skill.name}${skill.required ? "" : " (optional)"}`}</Text>
              {skillChips(skill).map((badge) => (
                <Chip key={badge.text} badge={badge} styles={styles} theme={theme} />
              ))}
            </View>
            {skill.problem === null ? null : <ToneText tone="danger" styles={styles} theme={theme}>{skill.problem}</ToneText>}
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

export function SettingsScreen({ theme, layout, status: statusStrip, projects = [] }: SettingsScreenProps) {
  const styles = useMemo(() => dashboardStyles(theme, layout.compact), [theme, layout.compact]);
  const ensure = useRpc(setupEnsureRolesRpc);
  const listStored = useRpc(tracesWorkspacesRpc);
  const queryClient = useQueryClient();
  const status = useSetupStatus();
  const stored = useQuery({ queryKey: STORED_WORKSPACES_KEY, queryFn: () => listStored({}) });
  const readCoordination = useRpc(coordinationSettingsRpc);
  const coordination = useQuery({ queryKey: COORDINATION_KEY, queryFn: () => readCoordination({}) });
  const readAutonomy = useRpc(autonomyPolicyRpc);
  const autonomy = useQuery({ queryKey: AUTONOMY_POLICY_KEY, queryFn: () => readAutonomy({}) });
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
    autonomy: autonomyGroupState(autonomy.data?.policy, autonomy.isError),
    coordination: coordinationGroupState(coordination.data?.settings, coordination.isError),
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
            <ToneText key={warning} tone="warning" styles={styles} theme={theme}>
              {warning}
            </ToneText>
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
              <ToneText tone={row.tone} selectable styles={styles} theme={theme}>
                {row.text}
              </ToneText>
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
  const dataGroup = (
    <View style={{ gap: 10 }}>
      {home === null ? null : (
        <ToneText tone={home.tone} selectable styles={styles} theme={theme}>
          {home.text}
        </ToneText>
      )}
      <Text style={styles.sectionTitle}>Trace storage</Text>
      {stored.isPending ? <ActivityIndicator color={styles.spinner.color} /> : null}
      {stored.isError ? (
        <ToneText tone="danger" styles={styles} theme={theme}>{errorMessageOf(stored.error)}</ToneText>
      ) : null}
      {storage === null ? null : (
        <>
          <Text style={styles.body}>{storage.summary}</Text>
          {storage.warning === null ? null : (
            <ToneText tone={storage.warning.tone} styles={styles} theme={theme}>{storage.warning.text}</ToneText>
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

  const coordinationGroup = coordination.isError ? (
    <ToneText tone="danger" styles={styles} theme={theme}>{errorMessageOf(coordination.error)}</ToneText>
  ) : coordination.data === undefined ? (
    <ActivityIndicator color={styles.spinner.color} />
  ) : (
    <CoordinationGroup
      data={coordination.data}
      onSaved={(settings) =>
        queryClient.setQueryData<CoordinationSettingsOutput>(COORDINATION_KEY, (current) => (current === undefined ? current : { ...current, settings }))
      }
      styles={styles}
      theme={theme}
    />
  );

  const autonomyGroup = autonomy.isError ? (
    <ToneText tone="danger" styles={styles} theme={theme}>{errorMessageOf(autonomy.error)}</ToneText>
  ) : autonomy.data === undefined ? (
    <ActivityIndicator color={styles.spinner.color} />
  ) : (
    <AutonomyGroup
      policy={autonomy.data.policy}
      projects={projects}
      onSaved={(policy) => queryClient.setQueryData<AutonomyPolicyOutput>(AUTONOMY_POLICY_KEY, { policy })}
      styles={styles}
      theme={theme}
    />
  );

  const bodies: Record<SettingsGroupKey, ReactNode> = {
    agents,
    autonomy: autonomyGroup,
    coordination: coordinationGroup,
    tools,
    data: dataGroup,
  };

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <Text style={styles.title}>Settings</Text>
      {statusStrip}
      {status.isPending ? <ActivityIndicator color={styles.spinner.color} /> : null}
      {status.isError ? (
        <ToneText tone="danger" styles={styles} theme={theme}>{errorMessageOf(status.error)}</ToneText>
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
