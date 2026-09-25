/**
 * The Beads screen (design delta 20260916-beads-screen): five overview
 * sections, a filterable bead list, and a bead detail with three hand-off
 * actions. Every action is confirmed first and goes to the workspace's Beads
 * Manager; this screen never writes the bead store.
 *
 * Client rules: React Native primitives only, colours from `theme.colors`, no
 * Node import, no `server/` import.
 */
import { type PluginSurfaceProps, useRpc } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState, useSyncExternalStore } from "react";
import { ActivityIndicator, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { beadsActionRpc, beadsGetRpc, beadsListRpc, type BeadAction, type BeadRow } from "../shared/contracts";
import { MarkdownView } from "./markdown-view";
import {
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
  beadResultKey,
  beadsOverview,
  closedBeadsVisibility,
  doneText,
  kanbanColumns,
  kanbanLayout,
  facetsOf,
  filterBeads,
  priorityLabel,
  statusBadge,
  toggle,
  visibleKanbanBucket,
  workSummary,
  type BeadFilter,
  type StatusBucket,
} from "./beads-model";
import { dashboardStyles, toneColor, type Badge } from "./dashboard-model";
import { errorMessageOf } from "./launch-manager";
import {
  BarChart,
  BeadRowCard,
  Chip,
  KanbanBoard,
  RoleMark,
  StatCards,
  StatusTabs,
  WorkspaceScreenHeader,
  type Styles,
  type Theme,
  type WorkspaceScreenProps,
} from "./ui";

const facetText = (value: string) => value.replace("in_progress", "in progress");

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

/** A bead's detail and actions; also opened from a chat card or the chat panel. */
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
  const getBead = useRpc(beadsGetRpc);
  const runAction = useRpc(beadsActionRpc);
  const [pending, setPending] = useState<BeadAction | null>(null);
  const [busy, setBusy] = useState(false);
  // What the last action reported lives outside this panel: the board draws each
  // status as its own column, so a bead that changes status gets a new row and
  // this panel is built again — and the line telling the user the request was
  // sent must not vanish with it (delta 20260925 §3.1, keeping F9 of 20260918f).
  const resultKey = beadResultKey(workspaceId, bead.id);
  const result = useSyncExternalStore(beadActionResults.subscribe, () => beadActionResults.get(resultKey) ?? null);
  const setResult = (next: { text: string; managerId: string | null; tone: Badge["tone"] } | null) => {
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

  const full = detail.data?.bead;
  const work = workSummary(bead, new Date());
  const spec = pending === null ? null : actionSpec(pending, bead);
  return (
    <View style={{ gap: 6, paddingTop: 6 }}>
      {detail.isPending ? <ActivityIndicator color={styles.spinner.color} /> : null}
      {detail.isError ? (
        <Text style={[styles.body, { color: toneColor(theme, "danger") }]}>{errorMessageOf(detail.error)}</Text>
      ) : null}
      {full === undefined ? null : (
        <>
          <View style={styles.chipRow}>
            {full.labels.map((label) => (
              <Chip key={label} badge={{ text: label, tone: "info" }} styles={styles} theme={theme} />
            ))}
          </View>
          <Text style={styles.body}>
            {[
              full.createdAt === null ? null : `created ${full.createdAt.slice(0, 16).replace("T", " ")}`,
              full.updatedAt === null ? null : `updated ${full.updatedAt.slice(0, 16).replace("T", " ")}`,
              full.closedAt === null ? null : `closed ${full.closedAt.slice(0, 16).replace("T", " ")}`,
              full.parentId === null ? null : `parent ${full.parentId}`,
              full.blockedBy.length === 0 ? null : `blocked by ${full.blockedBy.join(", ")}`,
              full.children.length === 0 ? null : `${full.children.length} child bead(s)`,
            ]
              .filter((part) => part !== null)
              .join(" · ")}
          </Text>
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
                <Pressable
                  accessibilityRole="button"
                  onPress={() => navigation.openAgent({ agentId: work.agentId! })}
                  style={[styles.secondaryButton, { alignSelf: "flex-start" }]}
                >
                  <Text style={styles.secondaryButtonText}>Open the Worker</Text>
                </Pressable>
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

      {result === null ? null : (
        <View style={{ gap: 4 }}>
          <Text style={[styles.body, { color: toneColor(theme, result.tone) }]}>{result.text}</Text>
          {result.managerId !== null && navigation?.openAgent !== undefined ? (
            <Pressable
              accessibilityRole="button"
              onPress={() => navigation.openAgent({ agentId: result.managerId! })}
              style={[styles.secondaryButton, { alignSelf: "flex-start" }]}
            >
              <Text style={styles.secondaryButtonText}>Open the Beads Manager</Text>
            </Pressable>
          ) : null}
        </View>
      )}

      {spec === null ? (
        <View style={styles.chipRow}>
          {actionsFor(bead).map((action) => {
            const label = actionSpec(action, bead);
            return (
              <Pressable
                key={action}
                accessibilityRole="button"
                disabled={busy}
                onPress={() => {
                  setResult(null);
                  setPending(action);
                }}
                style={label.danger ? styles.dangerButton : styles.button}
              >
                <Text style={label.danger ? styles.dangerButtonText : styles.buttonText}>{label.label}</Text>
              </Pressable>
            );
          })}
        </View>
      ) : (
        <View style={styles.card}>
          <Text style={styles.sectionTitle}>{spec.title}</Text>
          <Text style={styles.body}>{spec.body}</Text>
          <View style={styles.chipRow}>
            {/* Cancel first: the safe choice is the one under the thumb. */}
            <Pressable accessibilityRole="button" onPress={() => setPending(null)} style={styles.secondaryButton}>
              <Text style={styles.secondaryButtonText}>No, cancel</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              disabled={busy}
              onPress={() => {
                void confirm(pending!);
              }}
              style={spec.danger ? styles.dangerButton : styles.button}
            >
              <Text style={spec.danger ? styles.dangerButtonText : styles.buttonText}>
                {busy ? "Sending…" : spec.confirmLabel}
              </Text>
            </Pressable>
          </View>
        </View>
      )}
    </View>
  );
}

export function BeadsScreen({ theme, layout, navigation, workspaceId, workspaceLabel, onBack, backLabel, status }: WorkspaceScreenProps) {
  const styles = useMemo(() => dashboardStyles(theme, layout.compact), [theme, layout.compact]);
  const listBeads = useRpc(beadsListRpc);
  const [filter, setFilter] = useState<BeadFilter>(EMPTY_FILTER);
  const [openId, setOpenId] = useState<string | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>("updated");
  const [descending, setDescending] = useState(true);
  const [showLabels, setShowLabels] = useState(false);
  const [expandedGroups, setExpandedGroups] = useState<ReadonlySet<string>>(new Set());
  // The board's own two pieces of state: how wide the list area measured, and
  // which column a narrow screen is showing.
  const [boardWidth, setBoardWidth] = useState<number | null>(null);
  const [openBucket, setOpenBucket] = useState<StatusBucket | null>(null);
  const beads = useQuery({
    queryKey: ["paseo-bm", "beads-list", workspaceId],
    queryFn: () => listBeads({ workspaceId }),
  });

  const rows = beads.data?.beads ?? [];
  const facets = useMemo(() => facetsOf(rows, filter), [rows, filter]);
  const shown = useMemo(() => sortBeads(filterBeads(rows, filter), sortKey, descending), [rows, filter, sortKey, descending]);
  // Closed beads are hidden until asked for, for the rest of the app session (Q9).
  const showClosed = useSyncExternalStore(closedBeadsVisibility.subscribe, closedBeadsVisibility.get, closedBeadsVisibility.get);
  const board = useMemo(() => kanbanColumns(shown, { showClosed }), [shown, showClosed]);
  const active = activeFilters(filter);
  const overview = beads.data === undefined ? null : beadsOverview(rows, beads.data.stats, new Date());
  const shape = kanbanLayout(boardWidth, layout.compact, board.columns.length);
  const bucket = visibleKanbanBucket(board.columns, openBucket);
  const shownColumns = shape.mode === "tabs" ? board.columns.filter((column) => column.bucket === bucket) : board.columns;
  // Done / total at a glance, counted like the Progress card (Q11).
  const done = overview === null ? null : doneText(overview.progress);
  const now = new Date();

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <WorkspaceScreenHeader
        title={workspaceLabel === undefined ? null : `Beads · ${workspaceLabel}`}
        onBack={onBack}
        backLabel={backLabel ?? "Back"}
        status={status}
        styles={styles}
        right={
          <>
            {done === null ? null : (
              <Text style={styles.body} accessibilityLabel={done.label}>
                {done.text}
              </Text>
            )}
            <Pressable accessibilityRole="button" onPress={() => void beads.refetch()} style={styles.secondaryButton}>
              <Text style={styles.secondaryButtonText}>Refresh</Text>
            </Pressable>
          </>
        }
      />

      {beads.data === undefined ? null : (
        <Text style={styles.body} selectable>{`Read from ${beads.data.stats.source}`}</Text>
      )}
      {beads.isPending ? <ActivityIndicator color={styles.spinner.color} /> : null}
      {beads.isError ? (
        <Text style={[styles.body, { color: toneColor(theme, "danger") }]}>{errorMessageOf(beads.error)}</Text>
      ) : null}

      {overview === null ? null : (
        <>
          {/* 1. Status */}
          <StatCards cards={overview.status} styles={styles} />

          {/* 2. Progress */}
          <View style={styles.card}>
            <Text style={styles.sectionTitle}>Progress</Text>
            <View style={styles.barTrack}>
              <View style={[styles.barFill, { width: `${Math.round(overview.progress.share * 100)}%` }]} />
            </View>
            <Text style={styles.body}>{overview.progress.label}</Text>
          </View>

          <View style={styles.cards}>
            <BarChart title="By type" bars={overview.byType} styles={styles} labelWidth={70} />
            <BarChart title="By priority" bars={overview.byPriority} styles={styles} labelWidth={70} />
          </View>

          {/* 5. Time */}
          <StatCards cards={overview.timing} styles={styles} />
        </>
      )}

      {/* Filters */}
      <View style={[styles.card, { gap: 8 }]}>
        <TextInput
          value={filter.text}
          onChangeText={(text) => setFilter({ ...filter, text })}
          placeholder="Search id or title"
          placeholderTextColor={theme.colors.foregroundMuted}
          style={[styles.body, { borderWidth: 1, borderColor: theme.colors.border, borderRadius: 8, padding: 8 }]}
        />
        {active.length > 0 ? (
          <View style={styles.chipRow}>
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
            <Pressable accessibilityRole="button" onPress={() => setFilter(EMPTY_FILTER)}>
              {/* Removing filters loses nothing, so it is not painted like a danger. */}
              <Text style={[styles.badge, { color: toneColor(theme, "plain"), paddingVertical: 2 }]}>Clear all</Text>
            </Pressable>
          </View>
        ) : null}
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
        {facets.labelGroups.length === 0 ? null : (
          <Pressable accessibilityRole="button" accessibilityState={{ expanded: showLabels }} onPress={() => setShowLabels(!showLabels)}>
            <Text style={styles.body}>
              {`${showLabels ? "▾" : "▸"} Labels · ${facets.labelGroups.map((group) => `${group.category}${group.selected > 0 ? ` (${group.selected})` : ""}`).join(", ")}`}
            </Text>
          </Pressable>
        )}
        {showLabels
          ? facets.labelGroups.map((group) => (
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
      </View>

      {/* Sort */}
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

      {/* Board: one column per status, closed beads behind the eye
          (delta 20260925 §3.1; delta 20260918e §4.4 for the eye) */}
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Text style={[styles.sectionTitle, { flex: 1 }]}>{`${board.visible} of ${rows.length} beads`}</Text>
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ selected: showClosed }}
          accessibilityLabel={`${showClosed ? "Hide" : "Show"} closed beads (${board.closed})`}
          onPress={() => closedBeadsVisibility.set(!showClosed)}
          style={[styles.secondaryButton, { flexDirection: "row", alignItems: "center", gap: 6 }]}
        >
          <Icon name={showClosed ? "Eye" : "EyeOff"} size={16} color={theme.colors.foreground} />
          <Text style={styles.secondaryButtonText}>{`Closed ${board.closed}`}</Text>
        </Pressable>
      </View>
      {beads.data !== undefined && rows.length === 0 ? (
        <Text style={styles.body}>This workspace has no beads yet.</Text>
      ) : null}
      {board.visible === 0 && board.closed > 0 ? (
        <Text style={styles.body}>{`All ${board.closed} matching beads are closed. Show them with the eye button.`}</Text>
      ) : null}
      {/* The width decides the shape: columns side by side when there is room,
          one column behind a row of status tabs when there is not. */}
      <View onLayout={(event) => setBoardWidth(event.nativeEvent.layout.width)} style={{ gap: layout.compact ? 6 : 8 }}>
        {shape.mode === "tabs" ? (
          <StatusTabs
            tabs={board.columns.map((column) => ({ key: column.bucket, label: column.label, count: column.total }))}
            selected={bucket}
            onSelect={(key) => setOpenBucket(key as StatusBucket)}
            styles={styles}
          />
        ) : null}
        <KanbanBoard
          columns={shownColumns}
          perRow={shape.perRow}
          gap={layout.compact ? 6 : 8}
          renderBead={renderRow}
          styles={styles}
        />
      </View>
    </ScrollView>
  );

  function renderRow(bead: BeadRow) {
    const open = openId === bead.id;
    const work = workSummary(bead, now);
    return (
      <BeadRowCard
        key={bead.id}
        bead={bead}
        open={open}
        onToggle={() => setOpenId(open ? null : bead.id)}
        styles={styles}
        theme={theme}
        meta={
          <>
            <View style={{ flexDirection: "row", gap: 8, alignItems: "center", flexWrap: "wrap", marginTop: 2 }}>
              <Text style={[styles.body, { fontSize: 12 }]} selectable numberOfLines={1}>
                {bead.id}
              </Text>
              <View style={{ flex: 1 }} />
              <Chip badge={{ text: `${priorityLabel(bead.priority)} · ${bead.issueType}`, tone: "muted" }} styles={styles} theme={theme} />
              <Chip badge={statusBadge(bead)} styles={styles} theme={theme} />
            </View>
            {work === null ? null : (
              <View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginTop: 4 }}>
                <RoleMark kind="worker" theme={theme} size={16} />
                <Text style={[styles.body, { flex: 1, color: toneColor(theme, work.tone) }]} numberOfLines={1}>
                  {work.headline}
                </Text>
              </View>
            )}
          </>
        }
        detail={<BeadDetailPanel workspaceId={workspaceId} bead={bead} styles={styles} theme={theme} navigation={navigation} />}
      />
    );
  }
}
