/**
 * Settings, a section of the management surface (experience concept §4.4,
 * autonomy design §A.12; change-014 outcome 5), on one scrolling screen:
 *
 * - **Autonomy**, open — one level per project, Hands-on to Full auto, and
 *   the project's action boundary under it (ADR-025;
 *   `settings-autonomy.tsx`).
 * - **Coordination**, open — compaction and handoff, each switched on its
 *   own with its thresholds as number fields, the review budget per tier and
 *   how often the Orchestrator advises (autonomy design §G.7;
 *   `settings-coordination.tsx`), then one reset to the defaults. A field
 *   saves with its card's Save, which shows once something changed.
 * - **More**, three joined rows, each "Title · what it holds" with its state
 *   and ›, opening its body under it: **Agents** (the roles
 *   with their fallback chains, sign-in, Paseo's agent tools), **Precedents**
 *   (`settings-precedents.tsx`) and **Data** (the data folder, the trace
 *   storage with its cleanup per workspace, removing paseo-bm's settings).
 *
 * Tools & skills is a section of its own (`tools-screen.tsx`), which reads
 * the same `setup.status` through `useSetupStatus`.
 *
 * Laid out as the approved mockup (`Settings.dc.html`): one column at most
 * 980 wide, the page's title being the section nav's.
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
  precedentsListRpc,
  setupEnsureRolesRpc,
  setupStatusRpc,
  tracesWorkspacesRpc,
  type AutonomyPolicyOutput,
  type CoordinationSettingsOutput,
} from "../shared/contracts";
import { levelsOf } from "../shared/autonomy";
import { COORDINATION_MECHANISMS, REVIEW_BUDGET_KEYS, type CoordinationMechanism } from "../shared/coordination";
import { DEFAULT_WARN_ABOVE_BYTES, dashboardSettings } from "../shared/settings";
import { PLUGIN_VERSION } from "../shared/version";
import { TraceActions } from "./dashboard-actions";
import { PRIVACY_NOTICE } from "./history-model";
import { dashboardStyles } from "./styles";
import { errorMessageOf } from "./errors";
import type { InsightsProject } from "./insights-model";
import { AutonomyGroup } from "./settings-autonomy";
import { AUTONOMY_MEANING, AUTONOMY_POLICY_KEY, PRECEDENTS_QUERY_KEY, autonomyProjects } from "./settings-autonomy-model";
import { CardFooter, MechanismCard, NumberField, ReviewBudgetCard, coordinationCardStyle } from "./settings-coordination";
import {
  COORDINATION_MEANING,
  MECHANISM_THRESHOLDS,
  changedReviewBudget,
  coordinationDefaultsDraft,
  coordinationResetView,
  changedThresholds,
  inputErrorsOf,
  mechanismCardView,
  parseCoordinationInput,
  reviewBudgetCardView,
  turnOnDialog,
  type CoordinationInputs,
  type CoordinationNumberKey,
  type ReviewBudgetDraft,
  type ThresholdDraft,
} from "./settings-coordination-model";
import {
  ADVICE_FIELD,
  DEFAULT_OPEN_GROUPS,
  SETTINGS_GROUPS,
  THRESHOLD_NOTE,
  adviceCadenceView,
  agentsGroupState,
  dataGroupState,
  groupHeaderView,
  precedentsGroupState,
  storageSummary,
  toggleGroup,
  type AdviceCadenceView,
  type GroupHeaderView,
  type GroupState,
  type SettingsGroupKey,
  type StorageRow,
} from "./settings-model";
import {
  PLUGIN_DIAGNOSTICS_LINE,
  dataHomeLine,
  ensureRolesLine,
  paseoToolsWarnings,
  rolesCreatedLine,
  signInRows,
  type EnsureRolesLine,
} from "./settings-machine-model";
import { AgentToolsBlockView, CleanupBlock, CommandLine, RolesSection, useBusyAction } from "./settings-blocks";
import { PrecedentsBlock } from "./settings-precedents";
import { Button, ToneText, type Styles, type Theme } from "./ui";
import { toneColor } from "./tone";

/** The query Settings and Tools & skills read: the roles ensured, then the status. */
export const SETUP_STATUS_KEY = ["paseo-bm", "setup", "status"] as const;
const STORED_WORKSPACES_KEY = ["paseo-bm", "settings", "stored-workspaces"] as const;
const COORDINATION_KEY = ["paseo-bm", "settings", "coordination"] as const;

export interface SettingsScreenProps extends PluginSurfaceProps {
  /** The surface's status strip (slash-command notice, launch state), drawn under the title. */
  status?: ReactNode;
  /** Projects the surface knows by name, as Insights names them: the Autonomy group's tabs and the precedents' projects. */
  projects?: readonly InsightsProject[];
}

/**
 * One of More's rows (the approved mockup): "Title · what it holds" at the
 * left, its state and › at the right, joined to the rows around it in one
 * bordered list; the whole row one button. A state with a problem keeps its
 * tone's colour. A group that does not open is plain text.
 */
export function SettingsGroupHeader({ view, first = true, onToggle, theme }: {
  view: GroupHeaderView;
  /** The first row draws its top border; the others share the one above. */
  first?: boolean;
  onToggle: () => void;
  styles?: Styles;
  theme: Theme;
}) {
  const { colors } = theme;
  const stateColor = view.state.tone === "danger" || view.state.tone === "warning" ? toneColor(theme, view.state.tone) : colors.foregroundMuted;
  const line = (
    <>
      <Text style={{ flex: 1, color: colors.foreground, fontSize: 14 }}>
        {view.title}
        <Text style={{ color: colors.foregroundMuted }}>{` · ${view.hint}`}</Text>
      </Text>
      <Text style={{ color: stateColor, fontSize: 14, flexShrink: 1, textAlign: "right" }} numberOfLines={2}>
        {view.marker === null ? view.state.text : `${view.state.text} ${view.marker === "▾" ? "⌄" : "›"}`}
      </Text>
    </>
  );
  const rowStyle = {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: 12,
    paddingVertical: 14,
    paddingHorizontal: 20,
    borderWidth: 1,
    borderColor: colors.border,
    ...(first ? {} : { borderTopWidth: 0 }),
  };
  if (view.marker === null) {
    return (
      <View style={rowStyle} accessibilityLabel={view.accessibilityLabel}>
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
      style={rowStyle}
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

/**
 * Orchestrator advice (the approved mockup; autonomy design §G.7): "Review
 * the workflow every [n] finished requests", what 0 does, and Save at the foot
 * while the value changed. A refused value or a failed save says why there.
 * Hook-free.
 */
export function AdviceCadenceRow({ view, input, busy, error, onInput, onSave, styles, theme }: {
  view: AdviceCadenceView;
  /** The field's text while it is being typed in; null shows the value. */
  input: string | null;
  busy: boolean;
  error: string | null;
  onInput: (text: string) => void;
  onSave: () => void;
  styles: Styles;
  theme: Theme;
}) {
  const { colors } = theme;
  const refusals = inputErrorsOf(["advice.everyFinished"], input === null ? {} : { "advice.everyFinished": input });
  return (
    <View style={[coordinationCardStyle(theme), { flex: 1, gap: 12, paddingVertical: 16, paddingHorizontal: 20 }]}>
      <Text style={{ color: colors.foreground, fontSize: 14, fontWeight: "600" }}>{view.title}</Text>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
        <Text style={{ flex: 1, color: colors.foreground, fontSize: 14 }}>{ADVICE_FIELD.before}</Text>
        <NumberField
          value={input ?? view.inputText}
          invalid={refusals.length > 0}
          accessibilityLabel={view.accessibilityLabel}
          editable={!busy}
          width={56}
          onChange={onInput}
          theme={theme}
        />
        <Text style={{ color: colors.foregroundMuted, fontSize: 14 }}>{ADVICE_FIELD.after}</Text>
      </View>
      <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>{view.meaning}</Text>
      <CardFooter save={view.save} refusals={refusals} error={error} onSave={onSave} styles={styles} theme={theme} />
    </View>
  );
}

/**
 * One of compaction and handoff/**
 * One of compaction and handoff (autonomy design §G.7): its switch saves at
 * once (turning on after a confirmation), its thresholds stay a draft (held
 * by the group, so its reset can fill them) until Save, which sends one
 * `coordination.set` per changed setting.
 */
function MechanismGroup({ mechanism, data, draft, inputs, onInput, clearInputs, narrow, setDraft, onSaved, styles, theme }: {
  mechanism: CoordinationMechanism;
  data: CoordinationSettingsOutput;
  draft: ThresholdDraft;
  inputs: CoordinationInputs;
  onInput: (key: CoordinationNumberKey, text: string) => void;
  clearInputs: (keys: readonly CoordinationNumberKey[]) => void;
  narrow: boolean;
  setDraft: (change: (current: ThresholdDraft) => ThresholdDraft) => void;
  onSaved: (settings: CoordinationSettingsOutput["settings"]) => void;
  styles: Styles;
  theme: Theme;
}) {
  const save = useRpc(coordinationSetRpc);
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
      inputs={inputs}
      dialog={asking ? turnOnDialog(mechanism, settings) : null}
      busy={busy}
      error={error}
      narrow={narrow}
      onToggle={() => {
        setError(null);
        if (view.toggle.turnsOn) setAsking(true);
        else setSwitch(false);
      }}
      onConfirm={() => setSwitch(true)}
      onCancel={() => setAsking(false)}
      onInput={(key, text) => {
        setError(null);
        onInput(key, text);
      }}
      onSave={() =>
        run(
          async () => {
            setError(null);
            for (const change of changedThresholds(mechanism, settings, draft)) {
              const output = await save(change);
              onSaved(output.settings);
              setDraft((current) => Object.fromEntries(Object.entries(current).filter(([key]) => key !== change.key)) as ThresholdDraft);
            }
            clearInputs(MECHANISM_THRESHOLDS[mechanism]);
          },
          (failure) => setError(errorMessageOf(failure)),
        )
      }
      styles={styles}
      theme={theme}
    />
  );
}

/**
 * The review budget per tier (autonomy design §C.4, §G.7; bead `7gxw.12`):
 * each tier's review calls stay a draft (held by the group) until Save, which
 * sends one `coordination.set` per changed tier. Only a Worker created
 * afterwards gets the new budget.
 */
function ReviewBudgetGroup({ data, draft, inputs, onInput, clearInputs, setDraft, onSaved, styles, theme }: {
  data: CoordinationSettingsOutput;
  draft: ReviewBudgetDraft;
  inputs: CoordinationInputs;
  onInput: (key: CoordinationNumberKey, text: string) => void;
  clearInputs: (keys: readonly CoordinationNumberKey[]) => void;
  setDraft: (change: (current: ReviewBudgetDraft) => ReviewBudgetDraft) => void;
  onSaved: (settings: CoordinationSettingsOutput["settings"]) => void;
  styles: Styles;
  theme: Theme;
}) {
  const save = useRpc(coordinationSetRpc);
  const { busy, run } = useBusyAction();
  const [error, setError] = useState<string | null>(null);
  const settings = data.settings;
  return (
    <ReviewBudgetCard
      view={reviewBudgetCardView({ settings, defaults: data.defaults, draft, saving: busy })}
      inputs={inputs}
      busy={busy}
      error={error}
      onInput={(key, text) => {
        setError(null);
        onInput(key, text);
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
            clearInputs(Object.values(REVIEW_BUDGET_KEYS));
          },
          (failure) => setError(errorMessageOf(failure)),
        )
      }
      styles={styles}
      theme={theme}
    />
  );
}

/**
 * Settings → Coordination (autonomy design §G.7; change-014 outcome 5),
 * open on the screen: compaction and handoff, each a card of its own, the
 * review budget, the Orchestrator's advice cadence, then **Reset coordination
 * to defaults**, which fills every card's draft with the defaults. An edit
 * stays a draft until its card's Save.
 */
function CoordinationGroup({ data, narrow, onSaved, styles, theme }: {
  data: CoordinationSettingsOutput;
  narrow: boolean;
  onSaved: (settings: CoordinationSettingsOutput["settings"]) => void;
  styles: Styles;
  theme: Theme;
}) {
  const save = useRpc(coordinationSetRpc);
  const [adviceDraft, setAdviceDraft] = useState<number | null>(null);
  const [thresholds, setThresholds] = useState<ThresholdDraft>({});
  const [review, setReview] = useState<ReviewBudgetDraft>({});
  // The text of the fields being typed in; a valid one is also in its draft.
  const [inputs, setInputs] = useState<CoordinationInputs>({});
  const { busy: saving, run } = useBusyAction();
  const [error, setError] = useState<string | null>(null);
  const stored = data.settings.advice.everyFinished;
  const value = adviceDraft ?? stored;
  const view = adviceCadenceView({ stored, draft: value, defaultValue: data.defaults.advice.everyFinished, saving });
  const reset = coordinationResetView(saving);
  const onInput = (key: CoordinationNumberKey, text: string) => {
    setInputs((current) => ({ ...current, [key]: text }));
    const parsed = parseCoordinationInput(key, text);
    if (parsed.error !== null) return;
    if (key === "advice.everyFinished") setAdviceDraft(parsed.value);
    else if (key.startsWith("review.")) setReview((current) => ({ ...current, [key]: parsed.value }));
    else setThresholds((current) => ({ ...current, [key]: parsed.value }));
  };
  const clearInputs = (keys: readonly CoordinationNumberKey[]) =>
    setInputs((current) => Object.fromEntries(Object.entries(current).filter(([key]) => !keys.includes(key as CoordinationNumberKey))));
  return (
    <View style={{ gap: 14 }}>
      {COORDINATION_MECHANISMS.map((mechanism) => (
        <MechanismGroup
          key={mechanism}
          mechanism={mechanism}
          data={data}
          draft={thresholds}
          inputs={inputs}
          onInput={onInput}
          clearInputs={clearInputs}
          narrow={narrow}
          setDraft={setThresholds}
          onSaved={onSaved}
          styles={styles}
          theme={theme}
        />
      ))}
      <View style={{ flexDirection: narrow ? "column" : "row", gap: 14, alignItems: "stretch" }}>
        <ReviewBudgetGroup
          data={data}
          draft={review}
          inputs={inputs}
          onInput={onInput}
          clearInputs={clearInputs}
          setDraft={setReview}
          onSaved={onSaved}
          styles={styles}
          theme={theme}
        />
        <AdviceCadenceRow
          view={view}
          input={inputs["advice.everyFinished"] ?? null}
          busy={saving}
          error={error}
          onInput={(text) => {
            setError(null);
            onInput("advice.everyFinished", text);
          }}
          onSave={() =>
            run(
              async () => {
                setError(null);
                const output = await save({ key: "advice.everyFinished", value });
                onSaved(output.settings);
                setAdviceDraft(null);
                clearInputs(["advice.everyFinished"]);
              },
              (failure) => setError(errorMessageOf(failure)),
            )
          }
          styles={styles}
          theme={theme}
        />
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={reset.accessibilityLabel}
        accessibilityState={{ disabled: !reset.enabled }}
        disabled={!reset.enabled}
        onPress={() => {
          const defaults = coordinationDefaultsDraft(data.defaults);
          setError(null);
          setAdviceDraft(defaults.advice);
          setThresholds(defaults.thresholds);
          setReview(defaults.review);
          setInputs({});
        }}
        style={{ alignSelf: "flex-start" }}
      >
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 13, textDecorationLine: "underline" }}>{reset.label}</Text>
      </Pressable>
    </View>
  );
}

/**
 * `setup.status` after `setup.ensure-roles`, in one chain and under one key:
 * opening Settings or Tools & skills is a first-use trigger like opening the
 * Manager (design §7.13.2), and never shows a machine half set up.
 */
export function useSetupStatus() {
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

/** The heading sizes of the mockup: the page's first section (22), a section (18), a group of rows (15). */
const HEADING_SIZES = { page: 22, section: 18, group: 15 } as const;

/** A section of the screen: its title, what it is in one line, and its one-line state when it has one. */
export function SettingsSectionHeading({ title, meaning, state, size = "section", styles, theme }: {
  title: string;
  meaning: string | null;
  state: GroupState | null;
  size?: keyof typeof HEADING_SIZES;
  styles: Styles;
  theme: Theme;
}) {
  return (
    <View style={{ gap: 4 }}>
      <Text accessibilityRole="header" style={{ color: theme.colors.foreground, fontSize: HEADING_SIZES[size], fontWeight: "600" }}>
        {title}
      </Text>
      {meaning === null ? null : <Text style={{ color: theme.colors.foregroundMuted, fontSize: 14 }}>{meaning}</Text>}
      {state === null ? null : (
        <ToneText tone={state.tone} style={{ fontSize: 13 }} styles={styles} theme={theme}>
          {state.text}
        </ToneText>
      )}
    </View>
  );
}

/** The content column of Settings and Tools & skills (the approved mockup): centred, at most `maxWidth` wide, 32/32/64 padding. */
export function sectionContentStyle(maxWidth: number, compact: boolean) {
  return {
    width: "100%" as const,
    maxWidth,
    alignSelf: "center" as const,
    paddingTop: compact ? 16 : 32,
    paddingHorizontal: compact ? 16 : 32,
    paddingBottom: 64,
    gap: 36,
  };
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
  // The same query the precedents block reads: its count is the Precedents line.
  const listPrecedents = useRpc(precedentsListRpc);
  const precedents = useQuery({ queryKey: PRECEDENTS_QUERY_KEY, queryFn: () => listPrecedents({}) });
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

  const states: Record<SettingsGroupKey, GroupState> = {
    agents: agentsGroupState(data, { error: rolesError, cleanedUp }),
    precedents: precedentsGroupState(precedents.data?.precedents, precedents.isError),
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
      narrow={layout.compact}
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
      onSaved={(policy) => queryClient.setQueryData<AutonomyPolicyOutput>(AUTONOMY_POLICY_KEY, { policy, levels: levelsOf(policy) })}
      styles={styles}
      theme={theme}
    />
  );

  const precedentsGroup = (
    <PrecedentsBlock projects={autonomyProjects(projects, autonomy.data?.policy)} defaultScope={null} styles={styles} theme={theme} />
  );

  const bodies: Record<SettingsGroupKey, ReactNode> = {
    agents,
    precedents: precedentsGroup,
    data: dataGroup,
  };

  return (
    <ScrollView style={styles.screen} contentContainerStyle={sectionContentStyle(980, layout.compact)}>
      {statusStrip}
      {status.isError ? (
        <ToneText tone="danger" styles={styles} theme={theme}>{errorMessageOf(status.error)}</ToneText>
      ) : null}
      <View style={{ gap: 18 }}>
        <SettingsSectionHeading title="Autonomy" meaning={AUTONOMY_MEANING} state={null} size="page" styles={styles} theme={theme} />
        {autonomyGroup}
      </View>
      <View style={{ gap: 14 }}>
        <SettingsSectionHeading title="Coordination" meaning={COORDINATION_MEANING} state={null} styles={styles} theme={theme} />
        {coordinationGroup}
      </View>
      <View>
        <View style={{ marginBottom: 10 }}>
          <SettingsSectionHeading title="More" meaning={null} state={null} size="group" styles={styles} theme={theme} />
        </View>
        {SETTINGS_GROUPS.map((group, index) => {
          const expanded = open.has(group.key);
          return (
            <View key={group.key}>
              <SettingsGroupHeader
                view={groupHeaderView(group.key, states[group.key], expanded)}
                first={index === 0}
                onToggle={() => setOpen((current) => toggleGroup(current, group.key))}
                styles={styles}
                theme={theme}
              />
              {expanded ? (
                <View style={{ gap: 10, padding: 20, borderWidth: 1, borderTopWidth: 0, borderColor: theme.colors.border }}>{bodies[group.key]}</View>
              ) : null}
            </View>
          );
        })}
      </View>
    </ScrollView>
  );
}
