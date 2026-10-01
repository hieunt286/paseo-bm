/**
 * The Beads screen (design delta 20260916-beads-screen; a project's Beads tab
 * since the experience concept §4.2), drawn as the approved ProjectBeads
 * artboard (change-014 fidelity pass): a filter bar — the project's features
 * as a segmented control, Show closed, and Filter · Sort, which unfolds the
 * other filters and the sort —, then the board — In progress · Ready · Open
 * epics · Deferred, Blocked when a bead is blocked, Closed while shown — and
 * beside it the selected bead's detail with three hand-off actions. Every
 * action is confirmed first and goes to the workspace's Beads Manager; this
 * screen never writes the bead store.
 *
 * On a phone (the MobileBeads artboard) everything scrolls as one, under the
 * project page's header: the features scroll sideways, the columns are one at
 * a time behind a segmented control of equal cells with short names, and the
 * selected bead's detail sits in a bordered panel under the column, its
 * actions as a full-width Ask Manager to implement over a two-column grid.
 *
 * The overview figures (status, progress, by type, by priority, time) are the
 * project's Metrics tab: `BeadsFigures` (`insights.tsx`) draws them from `beadsOverview`,
 * the one component that does (code review 2026-09-30 §5).
 *
 * Client rules: React Native primitives only, colours from `theme.colors`, no
 * Node import, no `server/` import.
 */
import { type PluginSurfaceProps, useRpc } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import { ActivityIndicator, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { beadsActionRpc, beadsGetRpc, beadsListRpc, type BeadAction, type BeadRow } from "../shared/contracts";
import { MarkdownView } from "./markdown-view";
import {
  BEAD_ACTIONS_NOTE,
  BOARD_SHORT_TITLES,
  EMPTY_FILTER,
  LABEL_PREVIEW,
  SORT_OPTIONS,
  activeFilters,
  previewValues,
  sortBeads,
  type FacetValue,
  type SortKey,
  actionSpec,
  actionsFor,
  beadActionResults,
  beadFacts,
  beadHeadLine,
  beadResultKey,
  beadRowMeta,
  beadsOverview,
  boardColumns,
  closedBeadsVisibility,
  doneText,
  facetsOf,
  filterBeads,
  toggle,
  workSummary,
  type BeadFilter,
  type BoardBucket,
  type BoardColumn,
} from "./beads-model";
import { dashboardStyles } from "./styles";
import { toneColor, type Badge } from "./tone";
import { errorMessageOf } from "./errors";
import { Button, Chip, RoleMark, ToneText, WorkspaceScreenHeader, type Styles, type Theme, type WorkspaceScreenProps } from "./ui";
import { localTimeText } from "./format";
import { MONO, Segmented } from "./text-tabs";

const facetText = (value: string) => value.replace("in_progress", "in progress");

/** The width of the bead detail beside the board (the artboard's). */
export const BEAD_DETAIL_WIDTH = 380;

function FacetRow({
  title,
  values,
  selected,
  onToggle,
  styles,
  theme,
  expanded,
  onExpand,
}: {
  title: string;
  values: readonly FacetValue[];
  selected: ReadonlySet<string>;
  onToggle: (value: string) => void;
  styles: Styles;
  theme: Theme;
  /** Label groups preview a few values; the others show everything. */
  expanded?: boolean;
  onExpand?: () => void;
}) {
  if (values.length === 0) return null;
  const { shown, hidden } =
    expanded === undefined ? { shown: values, hidden: 0 } : previewValues(values, selected, expanded);
  return (
    <View style={{ gap: 4 }}>
      <Text style={styles.body}>{title}</Text>
      <View style={styles.chipRow}>
        {shown.map((entry) => (
          <Chip
            key={entry.value}
            badge={{ text: `${facetText(entry.value)} ${entry.count}`, tone: selected.has(entry.value) ? "info" : "muted" }}
            selected={selected.has(entry.value)}
            onPress={() => onToggle(entry.value)}
            styles={styles}
            theme={theme}
          />
        ))}
        {hidden > 0 || (expanded === true && values.length > LABEL_PREVIEW) ? (
          <Pressable accessibilityRole="button" onPress={onExpand}>
            <Text style={[styles.badge, { color: toneColor(theme, "info"), paddingVertical: 2 }]}>
              {hidden > 0 ? `+${hidden} more` : "show less"}
            </Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

type ActionResult = { text: string; managerId: string | null; tone: Badge["tone"] };

/**
 * A bead's detail read and its three actions, shared by the board's detail and
 * the chat's bead panel. What the last action reported lives outside the
 * component: a bead that changes status moves to another column and its
 * detail is built again — and the line telling the user the request was sent
 * must not vanish with it (delta 20260925 §3.1, keeping F9 of 20260918f).
 */
function useBeadAction(workspaceId: string, bead: BeadRow) {
  const getBead = useRpc(beadsGetRpc);
  const runAction = useRpc(beadsActionRpc);
  const [pending, setPending] = useState<BeadAction | null>(null);
  const [busy, setBusy] = useState(false);
  const resultKey = beadResultKey(workspaceId, bead.id);
  const result = useSyncExternalStore(beadActionResults.subscribe, () => beadActionResults.get(resultKey) ?? null);
  const setResult = (next: ActionResult | null) => {
    if (next === null) beadActionResults.clear(resultKey);
    else beadActionResults.set(resultKey, next);
  };
  const detail = useQuery({
    queryKey: ["paseo-bm", "bead", workspaceId, bead.id],
    queryFn: () => getBead({ workspaceId, id: bead.id }),
  });
  const confirm = async (action: BeadAction) => {
    setBusy(true);
    try {
      const sent = await runAction({ workspaceId, id: bead.id, action });
      setResult({
        text: `Sent to the Beads Manager${sent.created ? " (created for this workspace)" : ""}. It will hand the bead to a Worker.`,
        managerId: sent.managerId,
        tone: "success",
      });
    } catch (failure) {
      setResult({ text: errorMessageOf(failure), managerId: null, tone: "danger" });
    } finally {
      setBusy(false);
      setPending(null);
    }
  };
  const ask = (action: BeadAction) => {
    setResult(null);
    setPending(action);
  };
  return { detail, pending, setPending, busy, result, confirm, ask };
}

type BeadActionState = ReturnType<typeof useBeadAction>;

/** What the last action reported, with a way to its Manager. */
function ActionResultLine({ result, navigation, styles, theme }: { result: ActionResult | null; navigation?: PluginSurfaceProps["navigation"]; styles: Styles; theme: Theme }) {
  if (result === null) return null;
  return (
    <View style={{ gap: 4 }}>
      <ToneText tone={result.tone} styles={styles} theme={theme}>{result.text}</ToneText>
      {result.managerId !== null && navigation?.openAgent !== undefined ? (
        <Button
          label="Open the Beads Manager"
          kind="secondary"
          onPress={() => navigation.openAgent({ agentId: result.managerId! })}
          style={{ alignSelf: "flex-start", borderRadius: 0, paddingVertical: 8 }}
          styles={styles}
        />
      ) : null}
    </View>
  );
}

/** The confirmation an action asks first: what it does, then No, cancel and the confirm. */
function ActionConfirm({ bead, state, styles, theme }: { bead: BeadRow; state: BeadActionState; styles: Styles; theme: Theme }) {
  const spec = state.pending === null ? null : actionSpec(state.pending, bead);
  if (spec === null) return null;
  return (
    <View style={{ gap: 8, borderWidth: 1, borderColor: theme.colors.border, padding: 14 }}>
      <Text style={[styles.body, { color: theme.colors.foreground, fontWeight: "600" }]}>{spec.title}</Text>
      <Text style={styles.body}>{spec.body}</Text>
      <View style={styles.chipRow}>
        {/* Cancel first: the safe choice is the one under the thumb. */}
        <Button label="No, cancel" kind="secondary" onPress={() => state.setPending(null)} style={{ borderRadius: 0, paddingVertical: 8 }} styles={styles} />
        <Button
          label={state.busy ? "Sending…" : spec.confirmLabel}
          kind={spec.danger ? "danger" : "primary"}
          disabled={state.busy}
          onPress={() => {
            void state.confirm(state.pending!);
          }}
          style={{ borderRadius: 0, paddingVertical: 8 }}
          styles={styles}
        />
      </View>
    </View>
  );
}

/** A bead's detail and actions in the chat's bead panel (opened in place under its row). */
export function BeadDetailPanel({
  workspaceId,
  bead,
  styles,
  theme,
  navigation,
}: {
  workspaceId: string;
  bead: BeadRow;
  styles: Styles;
  theme: Theme;
  navigation?: PluginSurfaceProps["navigation"];
}) {
  const state = useBeadAction(workspaceId, bead);
  const { detail } = state;
  const full = detail.data?.bead;
  const now = new Date();
  const work = workSummary(bead, now);
  return (
    <View style={{ gap: 6, paddingTop: 6 }}>
      {detail.isPending ? <ActivityIndicator color={styles.spinner.color} /> : null}
      {detail.isError ? (
        <ToneText tone="danger" styles={styles} theme={theme}>{errorMessageOf(detail.error)}</ToneText>
      ) : null}
      {full === undefined ? null : (
        <>
          <View style={styles.chipRow}>
            {full.labels.map((label) => (
              <Chip key={label} badge={{ text: label, tone: "info" }} styles={styles} theme={theme} />
            ))}
          </View>
          <Text style={styles.body}>{timesLine(full, now)}</Text>
          {work === null ? null : (
            <View style={[styles.card, { gap: 4 }]}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                <RoleMark kind="worker" theme={theme} />
                <Text style={styles.sectionTitle}>Being worked on</Text>
              </View>
              {work.lines.map((line) => (
                <Text key={line} style={styles.body}>
                  {line}
                </Text>
              ))}
              {work.agentId !== null && navigation?.openAgent !== undefined ? (
                <Button label="Open the Worker" kind="secondary" onPress={() => navigation.openAgent({ agentId: work.agentId! })} style={{ alignSelf: "flex-start" }} styles={styles} />
              ) : null}
            </View>
          )}
          {full.closeReason === null ? null : <Text style={styles.body} selectable>{`Close reason: ${full.closeReason}`}</Text>}
          {full.description === null ? (
            <Text style={styles.body}>(no description)</Text>
          ) : (
            <View style={[styles.card, { backgroundColor: theme.colors.surface0 }]}>
              <MarkdownView source={full.description} theme={theme} compact={false} />
            </View>
          )}
        </>
      )}
      <ActionResultLine result={state.result} navigation={navigation} styles={styles} theme={theme} />
      {state.pending === null ? (
        <View style={styles.chipRow}>
          {actionsFor(bead).map((action) => {
            const label = actionSpec(action, bead);
            return (
              <Button key={action} label={label.label} kind={label.danger ? "danger" : "primary"} disabled={state.busy} onPress={() => state.ask(action)} styles={styles} />
            );
          })}
        </View>
      ) : (
        <ActionConfirm bead={bead} state={state} styles={styles} theme={theme} />
      )}
    </View>
  );
}

/** Created, updated, closed, blocked by, children: one muted line. */
function timesLine(full: BeadRow & { blockedBy: string[]; children: string[] }, now: Date): string {
  return [
    full.createdAt === null ? null : `created ${localTimeText(new Date(full.createdAt), now)}`,
    full.updatedAt === null ? null : `updated ${localTimeText(new Date(full.updatedAt), now)}`,
    full.closedAt === null ? null : `closed ${localTimeText(new Date(full.closedAt), now)}`,
    full.parentId === null ? null : `parent ${full.parentId}`,
    full.blockedBy.length === 0 ? null : `blocked by ${full.blockedBy.join(", ")}`,
    full.children.length === 0 ? null : `${full.children.length} child bead(s)`,
  ]
    .filter((part) => part !== null)
    .join(" · ");
}

/**
 * A phone's bead actions (the MobileBeads artboard): Ask Manager to implement
 * across the width, then the others two by two as equal cells, Delete… in the
 * danger colour. Each asks first, as on a wide screen.
 */
export function PhoneBeadActions({ bead, state, styles, theme }: { bead: BeadRow; state: BeadActionState; styles: Styles; theme: Theme }) {
  const { colors } = theme;
  const actions = actionsFor(bead);
  const primary = actions.filter((action) => action === "implement");
  const others = actions.filter((action) => action !== "implement");
  const pairs: BeadAction[][] = [];
  for (let index = 0; index < others.length; index += 2) pairs.push(others.slice(index, index + 2));
  const button = (action: BeadAction, cell: boolean) => {
    const spec = actionSpec(action, bead);
    return (
      <Button
        key={action}
        label={spec.label}
        kind={action === "implement" ? "primary" : "secondary"}
        disabled={state.busy}
        onPress={() => state.ask(action)}
        style={{ borderRadius: 0, paddingVertical: 10, paddingHorizontal: 12, ...(cell ? { flex: 1, minWidth: 0 } : {}) }}
        textStyle={{ fontSize: 13, ...(spec.danger ? { color: colors.statusDanger } : {}) }}
        styles={styles}
      />
    );
  };
  return (
    <View style={{ gap: 8 }}>
      {primary.map((action) => button(action, false))}
      {pairs.map((pair) => (
        <View key={pair.join(":")} style={{ flexDirection: "row", gap: 8 }}>
          {pair.map((action) => button(action, true))}
          {pair.length === 1 ? <View style={{ flex: 1 }} /> : null}
        </View>
      ))}
    </View>
  );
}

/**
 * The selected bead beside the board (the artboard's aside): id · type ·
 * priority, the title, Status / Feature / Parent / Worker, the description,
 * then Ask Manager to implement, Close… and Delete…, each confirmed first.
 */
export function BeadDetailAside({
  workspaceId,
  bead,
  all,
  styles,
  theme,
  navigation,
  compact = false,
}: {
  workspaceId: string;
  bead: BeadRow;
  /** Every bead of the project: an epic's children are counted from them. */
  all: readonly BeadRow[];
  styles: Styles;
  theme: Theme;
  navigation?: PluginSurfaceProps["navigation"];
  /** A phone (the MobileBeads artboard): title 16, a 76px fact column, the actions as a full-width primary over a two-column grid. */
  compact?: boolean;
}) {
  const state = useBeadAction(workspaceId, bead);
  const { colors } = theme;
  const full = state.detail.data?.bead;
  const now = new Date();
  const work = workSummary(bead, now);
  const facts = beadFacts(bead, all, now);
  if (full !== undefined && full.blockedBy.length > 0) facts.push({ key: "Blocked by", value: full.blockedBy.join(", "), mono: true });
  return (
    <View style={{ gap: compact ? 12 : 14 }}>
      <Text style={{ fontFamily: MONO, fontSize: compact ? 11 : 12, color: colors.foregroundMuted }} selectable>
        {beadHeadLine(bead)}
      </Text>
      <Text accessibilityRole="header" style={{ fontSize: compact ? 16 : 17, fontWeight: "600", lineHeight: compact ? 22 : 24, color: colors.foreground }}>
        {bead.title ?? "(untitled)"}
      </Text>
      <View style={{ gap: compact ? 6 : 8 }}>
        {facts.map((fact) => (
          <View key={fact.key} style={{ flexDirection: "row", gap: compact ? 10 : 12 }}>
            <Text style={{ width: compact ? 76 : 90, fontSize: 13, color: colors.foregroundMuted }}>{fact.key}</Text>
            <Text style={{ flex: 1, minWidth: 0, color: colors.foreground, ...(fact.mono ? { fontFamily: MONO, fontSize: 12 } : { fontSize: 13 }) }} selectable={fact.mono}>
              {fact.value}
            </Text>
          </View>
        ))}
      </View>
      {work !== null && work.agentId !== null && navigation?.openAgent !== undefined ? (
        <Pressable accessibilityRole="button" accessibilityLabel="Open the Worker of this bead" onPress={() => navigation.openAgent({ agentId: work.agentId! })} style={{ alignSelf: "flex-start" }}>
          <Text style={{ fontSize: 13, color: colors.foregroundMuted }}>Open the Worker ▸</Text>
        </Pressable>
      ) : null}
      <View style={{ borderTopWidth: 1, borderTopColor: colors.border, paddingTop: 12, gap: 8 }}>
        {state.detail.isPending ? <ActivityIndicator color={styles.spinner.color} /> : null}
        {state.detail.isError ? <ToneText tone="danger" styles={styles} theme={theme}>{errorMessageOf(state.detail.error)}</ToneText> : null}
        {full === undefined ? null : full.description === null ? (
          <Text style={{ fontSize: 13, color: colors.foregroundMuted }}>(no description)</Text>
        ) : (
          <MarkdownView source={full.description} theme={theme} compact />
        )}
        {full === undefined || full.closeReason === null ? null : (
          <Text style={{ fontSize: 13, color: colors.foreground }} selectable>{`Close reason: ${full.closeReason}`}</Text>
        )}
        {full === undefined ? null : <Text style={{ fontSize: 12, color: colors.foregroundMuted }}>{timesLine(full, now)}</Text>}
      </View>
      <ActionResultLine result={state.result} navigation={navigation} styles={styles} theme={theme} />
      {state.pending === null && compact ? (
        <PhoneBeadActions bead={bead} state={state} styles={styles} theme={theme} />
      ) : state.pending === null ? (
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 4 }}>
          {actionsFor(bead).map((action) => {
            const spec = actionSpec(action, bead);
            return (
              <Button
                key={action}
                label={spec.label}
                kind={action === "implement" ? "primary" : "secondary"}
                disabled={state.busy}
                onPress={() => state.ask(action)}
                style={{ borderRadius: 0, paddingVertical: 8, paddingHorizontal: action === "implement" ? 14 : 12 }}
                textStyle={{ fontSize: 13, ...(spec.danger ? { color: colors.statusDanger } : {}) }}
                styles={styles}
              />
            );
          })}
        </View>
      ) : (
        <ActionConfirm bead={bead} state={state} styles={styles} theme={theme} />
      )}
      <Text style={{ fontSize: 12, color: colors.foregroundMuted }}>{BEAD_ACTIONS_NOTE}</Text>
    </View>
  );
}

/** One bead on the board: id, title, meta; the selected one on surface2 with the 3px accent bar. Hook-free. */
export function BoardBeadRow({
  bead,
  meta,
  selected,
  onSelect,
  theme,
  compact = false,
}: {
  bead: BeadRow;
  meta: string;
  selected: boolean;
  onSelect: () => void;
  theme: Theme;
  /** A phone: padded 12/14, the title 14 (the MobileBeads artboard). */
  compact?: boolean;
}) {
  const { colors } = theme;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected }}
      accessibilityLabel={`${bead.id}: ${bead.title ?? "untitled"}. ${meta}`}
      onPress={onSelect}
      style={{
        gap: 4,
        paddingVertical: 12,
        paddingHorizontal: compact ? 14 : 16,
        borderBottomWidth: 1,
        borderBottomColor: colors.border,
        backgroundColor: selected ? colors.surface2 : "transparent",
      }}
    >
      {selected ? <View style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: 3, backgroundColor: colors.accent }} /> : null}
      <Text style={{ fontFamily: MONO, fontSize: 11, color: colors.foregroundMuted }} numberOfLines={1}>
        {bead.id}
      </Text>
      <Text style={{ fontSize: compact ? 14 : 13, lineHeight: compact ? 20 : 18, color: colors.foreground }}>{bead.title ?? "(untitled)"}</Text>
      <Text style={{ fontSize: 12, color: colors.foregroundMuted }} numberOfLines={1}>
        {meta}
      </Text>
    </Pressable>
  );
}

/** One column: its uppercase title and mono count, then its beads, or "Nothing here". Hook-free. */
export function BoardColumnView({ column, renderBead, last, theme }: { column: BoardColumn; renderBead: (bead: BeadRow) => ReactNode; last: boolean; theme: Theme }) {
  const { colors } = theme;
  return (
    <View style={{ flex: 1, minWidth: 0, borderRightWidth: last ? 0 : 1, borderRightColor: colors.border }}>
      <View accessibilityRole="header" style={{ flexDirection: "row", gap: 8, paddingVertical: 14, paddingHorizontal: 16, borderBottomWidth: 1, borderBottomColor: colors.border }}>
        <Text style={{ fontSize: 12, fontWeight: "500", textTransform: "uppercase", letterSpacing: 0.72, color: colors.foregroundMuted }}>{column.title}</Text>
        <Text style={{ fontFamily: MONO, fontSize: 12, color: colors.foreground }}>{String(column.total)}</Text>
      </View>
      {column.beads.map(renderBead)}
      {column.total === 0 ? <Text style={{ paddingVertical: 14, paddingHorizontal: 16, fontSize: 13, color: colors.foregroundMuted }}>Nothing here</Text> : null}
      {column.hidden > 0 ? (
        <Text style={{ paddingVertical: 10, paddingHorizontal: 16, fontSize: 12, color: colors.foregroundMuted }}>{`${column.hidden} more not shown`}</Text>
      ) : null}
    </View>
  );
}

/** Show closed (N): a square box, filled with the accent and ticked while closed beads show. Hook-free. */
export function ShowClosedToggle({ on, count, onToggle, theme, compact = false }: { on: boolean; count: number; onToggle: () => void; theme: Theme; compact?: boolean }) {
  const { colors } = theme;
  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityState={{ checked: on }}
      accessibilityLabel={`Show closed beads (${count})`}
      onPress={onToggle}
      style={{ flexDirection: "row", alignItems: "center", gap: 8 }}
    >
      <View
        style={{
          width: 14,
          height: 14,
          borderWidth: 1,
          borderColor: on ? colors.accent : colors.border,
          backgroundColor: on ? colors.accent : "transparent",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        {on ? <Text style={{ fontSize: 10, lineHeight: 12, color: colors.accentForeground }}>✓</Text> : null}
      </View>
      {/* A phone's row is short: the count stays in the label read aloud. */}
      <Text style={{ fontSize: 13, color: colors.foregroundMuted }}>{compact ? "Show closed" : `Show closed (${count})`}</Text>
    </Pressable>
  );
}

/** The feature filter's key for "every feature". Not a label: labels are never empty. */
const ALL_FEATURES = "";

export function BeadsScreen({
  theme,
  layout,
  navigation,
  workspaceId,
  workspaceLabel,
  onBack,
  backLabel,
  status,
  top,
}: WorkspaceScreenProps & {
  /** Drawn first on a phone, scrolling with the board: the project page's header (the MobileBeads artboard). */
  top?: ReactNode;
}) {
  const styles = useMemo(() => dashboardStyles(theme, layout.compact), [theme, layout.compact]);
  const { colors } = theme;
  const compact = layout.compact;
  const listBeads = useRpc(beadsListRpc);
  const [filter, setFilter] = useState<BeadFilter>(EMPTY_FILTER);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>("updated");
  const [descending, setDescending] = useState(true);
  const [showLabels, setShowLabels] = useState(false);
  // The other filters and the sort sit behind Filter · Sort, so the board comes first.
  const [showFilters, setShowFilters] = useState(false);
  const [expandedGroups, setExpandedGroups] = useState<ReadonlySet<string>>(new Set());
  // Which column a phone is showing.
  const [openBucket, setOpenBucket] = useState<BoardBucket | null>(null);
  const beads = useQuery({
    queryKey: ["paseo-bm", "beads-list", workspaceId],
    queryFn: () => listBeads({ workspaceId }),
  });

  const rows = beads.data?.beads ?? [];
  const facets = useMemo(() => facetsOf(rows, filter), [rows, filter]);
  // The features are the segmented control above the board; the other label groups fold.
  const features = facets.labelGroups.find((group) => group.category === "feature");
  const labelGroups = facets.labelGroups.filter((group) => group.category !== "feature");
  const featureLabels = new Set(features?.values.map((entry) => entry.value) ?? []);
  const feature = [...filter.labels].find((label) => label.startsWith("feature:")) ?? ALL_FEATURES;
  const pickFeature = (key: string) => {
    const others = [...filter.labels].filter((label) => !label.startsWith("feature:"));
    setFilter({ ...filter, labels: new Set(key === ALL_FEATURES ? others : [...others, key]) });
  };
  const shown = useMemo(() => sortBeads(filterBeads(rows, filter), sortKey, descending), [rows, filter, sortKey, descending]);
  // Closed beads are hidden by default; Show closed shows them for the rest of the app session (REQ-069c).
  const showClosed = useSyncExternalStore(closedBeadsVisibility.subscribe, closedBeadsVisibility.get, closedBeadsVisibility.get);
  const board = useMemo(() => boardColumns(shown, { showClosed }), [shown, showClosed]);
  const active = activeFilters(filter).filter((entry) => !(entry.facet === "labels" && featureLabels.has(entry.value)));
  // How many filters are on, the search included: said on Filter · Sort.
  const filtersOn = active.length + (filter.text.trim() === "" ? 0 : 1);
  const overview = beads.data === undefined ? null : beadsOverview(rows, beads.data.stats, new Date());
  const done = overview === null ? null : doneText(overview.progress);
  const now = new Date();
  // The detail shows the chosen bead while it is on the board, else the first bead of the first column that has one.
  const onBoard = board.columns.flatMap((column) => column.beads);
  const selected = onBoard.find((bead) => bead.id === selectedId) ?? onBoard[0] ?? null;
  const phoneBucket = openBucket !== null && board.columns.some((column) => column.bucket === openBucket)
    ? openBucket
    : (board.columns.find((column) => column.total > 0) ?? board.columns[0])?.bucket ?? "in_progress";
  const columns = compact ? board.columns.filter((column) => column.bucket === phoneBucket) : board.columns;
  const pad = compact ? 16 : 32;

  const renderBead = (bead: BeadRow) => (
    <BoardBeadRow
      key={bead.id}
      bead={bead}
      meta={beadRowMeta(bead, rows, now)}
      selected={selected?.id === bead.id}
      onSelect={() => setSelectedId(bead.id)}
      theme={theme}
      compact={compact}
    />
  );
  const detail =
    selected === null ? null : (
      <BeadDetailAside key={selected.id} workspaceId={workspaceId} bead={selected} all={rows} styles={styles} theme={theme} navigation={navigation} compact={compact} />
    );

  const screenHeader =
    workspaceLabel === undefined && onBack === undefined && status === undefined ? null : (
      <View style={{ paddingHorizontal: compact ? 0 : pad, paddingTop: compact ? 0 : 16, gap: 8 }}>
        <WorkspaceScreenHeader
          title={workspaceLabel === undefined ? null : `Beads · ${workspaceLabel}`}
          onBack={onBack}
          backLabel={backLabel ?? "Back"}
          status={status}
          styles={styles}
          right={null}
        />
      </View>
    );
  // The project's features: a segmented control, scrolling sideways on a phone.
  const featureControl =
    features === undefined ? null : (
      <Segmented
        segments={[
          { key: ALL_FEATURES, label: "All", count: rows.length, accessibilityLabel: `Every feature, ${rows.length} beads` },
          ...features.values.map((entry) => ({
            key: entry.value,
            label: entry.value.slice("feature:".length),
            count: entry.count,
            accessibilityLabel: `Feature ${entry.value.slice("feature:".length)}, ${entry.count} beads`,
          })),
        ]}
        selected={feature}
        onSelect={pickFeature}
        theme={theme}
        scroll={compact}
      />
    );
  const doneLine =
    done === null ? null : (
      <Text style={{ fontSize: 13, color: colors.foregroundMuted }} accessibilityLabel={done.label}>
        {done.text}
      </Text>
    );
  const closedToggle = <ShowClosedToggle on={showClosed} count={board.closed} onToggle={() => closedBeadsVisibility.set(!showClosed)} theme={theme} compact={compact} />;
  const filterButton = (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${showFilters ? "Hide" : "Show"} the filters and the sort${filtersOn > 0 ? `, ${filtersOn} on` : ""}`}
      accessibilityState={{ expanded: showFilters }}
      onPress={() => setShowFilters(!showFilters)}
      style={{ flexDirection: "row", alignItems: "center", gap: 6, borderWidth: 1, borderColor: colors.border, paddingVertical: 6, paddingHorizontal: compact ? 10 : 12, ...(compact ? { marginLeft: "auto" as const } : {}) }}
    >
      <Icon name="ListFilter" size={14} color={colors.foreground} />
      <Text style={{ fontSize: 13, color: colors.foreground }}>{`Filter · Sort${filtersOn > 0 ? ` (${filtersOn})` : ""}`}</Text>
    </Pressable>
  );

  // The filters in use stay in sight while the panel is folded.
  const activeChips = (
    <>
      {active.map((entry) => (
        <Chip
          key={`${entry.facet}:${entry.value}`}
          badge={{ text: `${facetText(entry.value)} ✕`, tone: "info" }}
          selected
          onPress={() => setFilter({ ...filter, [entry.facet]: toggle(filter[entry.facet], entry.value) })}
          styles={styles}
          theme={theme}
        />
      ))}
      <Pressable accessibilityRole="button" accessibilityLabel="Clear all filters" onPress={() => setFilter(EMPTY_FILTER)}>
        {/* Removing filters loses nothing, so it is not painted like a danger. */}
        <Text style={[styles.badge, { color: toneColor(theme, "plain"), paddingVertical: 2 }]}>Clear all</Text>
      </Pressable>
    </>
  );
  // Filters and sort, folded behind Filter · Sort
  const filtersBody = (
    <>
      <TextInput
        value={filter.text}
        onChangeText={(text) => setFilter({ ...filter, text })}
        placeholder="Search id or title"
        placeholderTextColor={colors.foregroundMuted}
        style={[styles.body, { color: colors.foreground, borderWidth: 1, borderColor: colors.border, borderRadius: 0, padding: 8 }]}
      />
      <FacetRow
        title="Status"
        values={facets.statuses}
        selected={filter.statuses}
        onToggle={(value) => setFilter({ ...filter, statuses: toggle(filter.statuses, value) })}
        styles={styles}
        theme={theme}
      />
      <FacetRow
        title="Type"
        values={facets.types}
        selected={filter.types}
        onToggle={(value) => setFilter({ ...filter, types: toggle(filter.types, value) })}
        styles={styles}
        theme={theme}
      />
      <FacetRow
        title="Priority"
        values={facets.priorities}
        selected={filter.priorities}
        onToggle={(value) => setFilter({ ...filter, priorities: toggle(filter.priorities, value) })}
        styles={styles}
        theme={theme}
      />
      {labelGroups.length === 0 ? null : (
        <Pressable accessibilityRole="button" accessibilityState={{ expanded: showLabels }} onPress={() => setShowLabels(!showLabels)}>
          <Text style={styles.body}>
            {`${showLabels ? "▾" : "▸"} Labels · ${labelGroups.map((group) => `${group.category}${group.selected > 0 ? ` (${group.selected})` : ""}`).join(", ")}`}
          </Text>
        </Pressable>
      )}
      {showLabels
        ? labelGroups.map((group) => (
            <FacetRow
              key={group.category}
              title={group.category}
              values={group.values}
              selected={filter.labels}
              onToggle={(value) => setFilter({ ...filter, labels: toggle(filter.labels, value) })}
              styles={styles}
              theme={theme}
              expanded={expandedGroups.has(group.category)}
              onExpand={() => setExpandedGroups(toggle(expandedGroups, group.category))}
            />
          ))
        : null}
      <View style={[styles.chipRow, { alignItems: "center" }]}>
        <Text style={styles.body}>Sort</Text>
        {SORT_OPTIONS.map((option) => {
          const on = option.key === sortKey;
          return (
            <Chip
              key={option.key}
              badge={{ text: on ? `${option.label} ${descending ? "↓" : "↑"}` : option.label, tone: on ? "info" : "muted" }}
              selected={on}
              onPress={() => {
                if (on) setDescending(!descending);
                else {
                  setSortKey(option.key);
                  setDescending(true);
                }
              }}
              styles={styles}
              theme={theme}
            />
          );
        })}
      </View>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
        <Pressable accessibilityRole="button" accessibilityLabel="Read the beads again" onPress={() => void beads.refetch()}>
          <Text style={{ fontSize: 13, color: colors.foregroundMuted }}>Refresh</Text>
        </Pressable>
        {beads.data === undefined ? null : (
          <Text style={{ fontSize: 11, color: colors.foregroundMuted }} selectable>{`Read from ${beads.data.stats.source}`}</Text>
        )}
      </View>
    </>
  );
  // Reading, failed, empty, or every match closed; `inset` pads them on a wide screen.
  const notices = (inset: number) => (
    <>
      {beads.isPending ? <ActivityIndicator color={styles.spinner.color} style={{ padding: 16 }} /> : null}
      {beads.isError ? (
        <View style={{ paddingHorizontal: inset, paddingTop: inset === 0 ? 0 : 12 }}>
          <ToneText tone="danger" styles={styles} theme={theme}>{errorMessageOf(beads.error)}</ToneText>
        </View>
      ) : null}
      {beads.data !== undefined && rows.length === 0 ? (
        <Text style={[styles.body, { paddingHorizontal: inset, paddingTop: inset === 0 ? 0 : 12 }]}>This workspace has no beads yet.</Text>
      ) : null}
      {board.visible === 0 && board.closed > 0 ? (
        <Text style={[styles.body, { paddingHorizontal: inset, paddingTop: inset === 0 ? 0 : 12 }]}>{`All ${board.closed} matching beads are closed. Show them with Show closed.`}</Text>
      ) : null}
    </>
  );

  // A phone (the MobileBeads artboard): one scroll — the page header, the features, a row of
  // done · Show closed · Filter · Sort, the column chooser, the column's beads, then the
  // selected bead's detail in a bordered panel under them.
  if (compact) {
    return (
      <ScrollView style={{ flex: 1, backgroundColor: colors.surface0 }} contentContainerStyle={{ paddingTop: 16, paddingHorizontal: pad, paddingBottom: 40, gap: 14 }}>
        {top}
        {screenHeader}
        {featureControl}
        <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 10 }}>
          {doneLine}
          {closedToggle}
          {filterButton}
        </View>
        {active.length > 0 ? <View style={styles.chipRow}>{activeChips}</View> : null}
        {!showFilters ? null : <View style={{ gap: 10, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface1, padding: 14 }}>{filtersBody}</View>}
        {notices(0)}
        {beads.data === undefined || rows.length === 0 ? null : (
          <Segmented
            segments={board.columns.map((column) => ({ key: column.bucket, label: BOARD_SHORT_TITLES[column.bucket], count: column.total, accessibilityLabel: `${column.title}, ${column.total} beads` }))}
            selected={phoneBucket}
            onSelect={(key) => setOpenBucket(key as BoardBucket)}
            theme={theme}
            fill
          />
        )}
        {beads.data === undefined || rows.length === 0
          ? null
          : columns.map((column) => (
              <View key={column.bucket} accessibilityLabel={`${column.title}: ${column.total}`}>
                {column.beads.map(renderBead)}
                {column.total === 0 ? <Text style={{ paddingVertical: 12, fontSize: 13, color: colors.foregroundMuted }}>Nothing here</Text> : null}
                {column.hidden > 0 ? <Text style={{ paddingVertical: 10, fontSize: 12, color: colors.foregroundMuted }}>{`${column.hidden} more not shown`}</Text> : null}
              </View>
            ))}
        {detail === null ? null : <View style={{ borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface1, padding: 16 }}>{detail}</View>}
      </ScrollView>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: colors.surface0 }}>
      {screenHeader}

      {/* The filter bar: features, Show closed, Filter · Sort (delta 20260925 §3.1; the artboard's bar). */}
      <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 12, paddingVertical: 14, paddingHorizontal: pad, borderBottomWidth: 1, borderBottomColor: colors.border }}>
        {featureControl}
        <View style={{ flex: 1 }} />
        {doneLine}
        {closedToggle}
        {filterButton}
      </View>

      {active.length > 0 ? <View style={[styles.chipRow, { paddingHorizontal: pad, paddingTop: 10 }]}>{activeChips}</View> : null}

      {!showFilters ? null : (
        <View style={{ gap: 10, paddingVertical: 14, paddingHorizontal: pad, borderBottomWidth: 1, borderBottomColor: colors.border, backgroundColor: colors.surface1 }}>
          {filtersBody}
        </View>
      )}

      {notices(pad)}

      <View style={{ flex: 1, flexDirection: "row", minHeight: 0 }}>
        <ScrollView style={{ flex: 1, borderRightWidth: 1, borderRightColor: colors.border }} contentContainerStyle={{ flexDirection: "row", minHeight: "100%" }}>
          {columns.map((column, index) => (
            <BoardColumnView key={column.bucket} column={column} renderBead={renderBead} last={index === columns.length - 1} theme={theme} />
          ))}
        </ScrollView>
        <ScrollView style={{ width: BEAD_DETAIL_WIDTH, flexGrow: 0, backgroundColor: colors.surface1 }} contentContainerStyle={{ paddingVertical: 20, paddingHorizontal: 24 }}>
          {detail ?? <Text style={{ fontSize: 13, color: colors.foregroundMuted }}>Choose a bead to see it here.</Text>}
        </ScrollView>
      </View>
    </View>
  );
}
