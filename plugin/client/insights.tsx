/**
 * A project's Metrics tab (change-014 outcome 5; the Insights section until
 * then — experience concept §4.3, autonomy design §A.12): how the project's
 * requests flow, what they cost and how the Orchestrator's interventions
 * turned out (A-12, §G.3), from `insights.summary` for the workspace (the
 * metric module over the plugin's own data folder); its Beads figures; its
 * autonomy by class — the agreement ledger (`autonomy.ledger`) with each
 * class's mode (`autonomy.policy`, §B.3), read only (ADR-025: autonomy is the
 * project's level, set in Settings) —; and review lift per size of request
 * (§C.4). Cost ends with the tokens read per request and the heaviest
 * requests (§G.2). What it shows is `insights-model.ts`; this file reads the
 * data and draws it.
 *
 * Drawn as the approved ProjectMetrics artboard (change-014 fidelity pass):
 * five figures in one strip, Bead status and Closed per day (from
 * `beads.list`), By feature and Tokens by role, How the work ran beside all
 * projects (a second `insights.summary` without a workspace); the sections
 * the artboard has no place for follow. The period is the page header's
 * segmented control (`work.tsx`); the Beads figures that opened the old tab
 * (`BeadsFigures`) are no longer drawn — Bead status says the same in one bar.
 *
 * Read once when shown and on Refresh — never polled: the figures move by the
 * day, not by the second.
 *
 * Client rules: React Native primitives only, colours from the theme
 * (`toneColor`), accessibility roles and labels on every pressable, project
 * names only (no ids).
 */
import { useRpc } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import { useMemo, type ReactNode } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { autonomyLedgerRpc, autonomyPolicyRpc, beadsListRpc, insightsSummaryRpc, type InsightsWindow } from "../shared/contracts";
import { dashboardStyles } from "./styles";
import { toneColor } from "./tone";
import type { Bar } from "./format";
import {
  ALL_PROJECTS,
  AUTONOMY_NOTE,
  AUTONOMY_TITLE,
  COORDINATION_EMPTY,
  HEAVIEST_TITLE,
  COORDINATION_NOTE,
  REVIEW_LIFT_NOTE,
  REVIEW_LIFT_TITLE,
  TOKENS_BY_ROLE_NOTE,
  autonomyFiguresView,
  metricsView,
  type AgreementFiguresView,
  type AutonomyClassRowView,
  type AutonomyFiguresView,
  type BeadStatusBarView,
  type BeadsFiguresView,
  type DayBar,
  type HeavyRequestView,
  type InsightsView,
  type MetricsView,
  type ProcessRow,
  type RequestTokensView,
  type ReviewLiftView,
  type ReviewTierRowView,
  type RoleTokenRow,
} from "./insights-model";
import { errorMessageOf } from "./errors";
import { AUTONOMY_POLICY_KEY } from "./settings-autonomy-model";
import { MONO } from "./text-tabs";
import { BarChart, StatCards, ToneText, type Styles, type Theme } from "./ui";

/** Figures change slowly; a read stays good for a minute. */
export const INSIGHTS_STALE_MS = 60_000;

export const insightsQueryKey = (window: InsightsWindow, projectId: string) => ["paseo-bm", "insights", window, projectId] as const;

/** One project's agreement ledger; the window is not part of it (§B.4 judges every answer). */
export const autonomyLedgerQueryKey = (projectId: string) => ["paseo-bm", "autonomy", "ledger", projectId] as const;

/** One of the heaviest requests: two lines on a phone, one row on a wide screen. Hook-free. */
export function HeavyRequestRow({ row, compact, styles }: { row: HeavyRequestView; compact: boolean; styles: Styles }) {
  const project = (
    <Text style={[styles.body, { fontWeight: "600", flexShrink: 1, flex: compact ? undefined : 1 }]} numberOfLines={1}>
      {row.project}
    </Text>
  );
  const tokens = <Text style={[styles.body, { fontWeight: "600" }]}>{row.tokens}</Text>;
  if (compact) {
    return (
      <View style={{ gap: 1 }} accessibilityLabel={row.accessibilityLabel}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          {project}
          <View style={{ flex: 1 }} />
          {tokens}
        </View>
        <Text style={styles.body}>{row.detail}</Text>
      </View>
    );
  }
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }} accessibilityLabel={row.accessibilityLabel}>
      {project}
      <Text style={styles.body}>{row.detail}</Text>
      <View style={{ minWidth: 90, alignItems: "flex-end" }}>{tokens}</View>
    </View>
  );
}

/** Tokens read per request (its spread) and the heaviest requests, under Cost. Hook-free. */
export function RequestTokens({ view, compact, styles }: { view: RequestTokensView; compact: boolean; styles: Styles }) {
  if (view.empty !== null) return <Text style={styles.body}>{view.empty}</Text>;
  return (
    <>
      <BarChart title={view.distributionTitle} bars={view.distribution} styles={styles} labelWidth={70} />
      {view.heaviest.length === 0 ? null : (
        <View style={[styles.card, { gap: 8 }]}>
          <Text style={styles.sectionTitle}>{HEAVIEST_TITLE}</Text>
          {view.heaviest.map((row) => (
            <HeavyRequestRow key={row.key} row={row} compact={compact} styles={styles} />
          ))}
        </View>
      )}
      {view.notes.map((note) => (
        <Text key={note} style={[styles.body, { fontSize: 11 }]}>
          {note}
        </Text>
      ))}
    </>
  );
}

/** The flow, cost and coordination part: cards, the per-day and per-role charts, and what was not counted. Hook-free. */
export function InsightsFigures({ view, compact = false, styles }: { view: InsightsView; compact?: boolean; styles: Styles }) {
  if (view.empty !== null) return <Text style={styles.body}>{view.empty}</Text>;
  return (
    <>
      <Text style={styles.sectionTitle}>Flow</Text>
      <StatCards cards={view.flow} styles={styles} />
      <BarChart title={view.perDayTitle} bars={view.requestsPerDay} styles={styles} labelWidth={50} />

      <Text style={styles.sectionTitle}>Cost</Text>
      <StatCards cards={view.cost} styles={styles} />
      <BarChart title="Tokens per request by role" bars={view.tokensByRole} styles={styles} labelWidth={100} />
      {view.requestTokens === null ? null : <RequestTokens view={view.requestTokens} compact={compact} styles={styles} />}

      <Text style={styles.sectionTitle}>Coordination</Text>
      <Text style={styles.body}>{COORDINATION_NOTE}</Text>
      {view.coordination.length === 0 ? <Text style={styles.body}>{COORDINATION_EMPTY}</Text> : <StatCards cards={view.coordination} styles={styles} />}

      {view.unknowns === null ? null : <Text style={styles.body}>{view.unknowns}</Text>}
    </>
  );
}

/**
 * The Beads part: one project's overview — status, progress (epics left out),
 * by type, by priority, time — as the Beads screen used to open with it. The
 * one component that draws it (code review 2026-09-30 §5). Hook-free.
 */
export function BeadsFigures({ view, styles, theme }: { view: BeadsFiguresView; styles: Styles; theme: Theme }) {
  if (view.kind === "choose") return <Text style={styles.body}>{view.text}</Text>;
  if (view.kind === "loading") return <ActivityIndicator color={styles.spinner.color} />;
  if (view.kind === "error") return <ToneText tone="danger" styles={styles} theme={theme}>{view.text}</ToneText>;
  const { overview, done } = view;
  return (
    <>
      <StatCards cards={overview.status} styles={styles} />
      <View style={styles.card} accessibilityLabel={done.label}>
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
      <StatCards cards={overview.timing} styles={styles} />
    </>
  );
}

/**
 * One predictor's figures in a class row: two or three short lines on a phone,
 * a column of its own on a wide screen. Hook-free.
 */
function AgreementFigures({ figures, compact, styles, theme }: { figures: AgreementFiguresView; compact: boolean; styles: Styles; theme: Theme }) {
  const strong = [styles.body, { color: toneColor(theme, "plain"), fontWeight: "600" as const }];
  const reversals =
    figures.reversals === null ? null : <ToneText tone={figures.reversalTone} styles={styles} theme={theme}>{figures.reversals}</ToneText>;
  const unread = figures.unread === null ? null : <Text style={[styles.body, { fontSize: 11 }]}>{figures.unread}</Text>;
  if (compact) {
    return (
      <View style={{ gap: 1 }}>
        <Text style={strong}>{`${figures.label} · ${figures.agreement}`}</Text>
        <Text style={styles.body}>{figures.span === null ? figures.count : `${figures.count} · ${figures.span}`}</Text>
        {reversals}
        {unread}
      </View>
    );
  }
  return (
    <View style={{ flex: 1, minWidth: 160, gap: 1 }}>
      <Text style={[styles.body, { fontSize: 11 }]}>{figures.label}</Text>
      <Text style={strong}>{figures.agreement}</Text>
      <Text style={styles.body}>{figures.count}</Text>
      {figures.span === null ? null : <Text style={styles.body}>{figures.span}</Text>}
      {reversals}
      {unread}
    </View>
  );
}

/** One class: its name and mode, then each predictor's figures — stacked on a phone, side by side on a wide screen. Hook-free. */
export function AutonomyClassRow({ row, compact, styles, theme }: { row: AutonomyClassRowView; compact: boolean; styles: Styles; theme: Theme }) {
  return (
    <View style={styles.card} accessibilityLabel={row.accessibilityLabel}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <Text style={[styles.sectionTitle, { flex: 1, minWidth: 120 }]}>{row.label}</Text>
        <ToneText tone={row.modeTone} base={styles.badge} styles={styles} theme={theme}>{row.modeText}</ToneText>
      </View>
      <View style={compact ? { flexDirection: "column", gap: 6 } : { flexDirection: "row", flexWrap: "wrap", gap: 16 }}>
        {row.figures.map((figures) => (
          <AgreementFigures key={figures.predictor} figures={figures} compact={compact} styles={styles} theme={theme} />
        ))}
      </View>
    </View>
  );
}

/** The Autonomy part: a row per class of the project, or why there is none. Hook-free. */
export function AutonomyFigures({ view, compact, styles, theme }: { view: AutonomyFiguresView; compact: boolean; styles: Styles; theme: Theme }) {
  if (view.kind === "choose" || view.kind === "empty") return <Text style={styles.body}>{view.text}</Text>;
  if (view.kind === "loading") return <ActivityIndicator color={styles.spinner.color} />;
  if (view.kind === "error") return <ToneText tone="danger" styles={styles} theme={theme}>{view.text}</ToneText>;
  return (
    <>
      {view.rows.map((row) => (
        <AutonomyClassRow key={row.decisionClass} row={row} compact={compact} styles={styles} theme={theme} />
      ))}
      {view.quiet === null ? null : <Text style={[styles.body, { fontSize: 11 }]}>{view.quiet}</Text>}
    </>
  );
}

/**
 * One tier of review lift: its name and how many requests were reviewed, then
 * its four figures — stacked on a phone, side by side on a wide screen. Hook-free.
 */
export function ReviewTierRow({ row, compact, styles, theme }: { row: ReviewTierRowView; compact: boolean; styles: Styles; theme: Theme }) {
  const strong = [styles.body, { color: toneColor(theme, "plain"), fontWeight: "600" as const }];
  return (
    <View style={styles.card} accessibilityLabel={row.accessibilityLabel}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <Text style={[styles.sectionTitle, { flex: 1, minWidth: 120 }]}>{row.label}</Text>
        <ToneText tone="muted" base={styles.badge} styles={styles} theme={theme}>{row.count}</ToneText>
      </View>
      <View style={compact ? { flexDirection: "column", gap: 6 } : { flexDirection: "row", flexWrap: "wrap", gap: 16 }}>
        {row.figures.map((figure) =>
          compact ? (
            <View key={figure.label} style={{ gap: 1 }}>
              <Text style={strong}>{`${figure.label} · ${figure.value}`}</Text>
              <Text style={styles.body}>{figure.detail}</Text>
            </View>
          ) : (
            <View key={figure.label} style={{ flex: 1, minWidth: 140, gap: 1 }}>
              <Text style={[styles.body, { fontSize: 11 }]}>{figure.label}</Text>
              <Text style={strong}>{figure.value}</Text>
              <Text style={styles.body}>{figure.detail}</Text>
            </View>
          ),
        )}
      </View>
    </View>
  );
}

/** Review lift of the chosen window and project: a row per tier, or why there is none. Hook-free. */
export function ReviewLiftFigures({ view, compact, styles, theme }: { view: ReviewLiftView; compact: boolean; styles: Styles; theme: Theme }) {
  if (view.kind === "empty") return <Text style={styles.body}>{view.text}</Text>;
  return (
    <>
      {view.rows.map((row) => (
        <ReviewTierRow key={row.tier} row={row} compact={compact} styles={styles} theme={theme} />
      ))}
      {view.unknowns === null ? null : <Text style={[styles.body, { fontSize: 11 }]}>{view.unknowns}</Text>}
    </>
  );
}

// ---------------------------------------------------------------------------
// The flat pieces of the approved mockup (change-014 fidelity pass), shared
// with the Overview (`work.tsx`). Hook-free; colours from the theme only.
// ---------------------------------------------------------------------------

/** A section heading: 15/600, with an optional muted tail after it (`· last 30 days, context read per turn`). */
export function SectionHeading({ title, tail, theme }: { title: string; tail?: string | null; theme: Theme }) {
  return (
    <Text accessibilityRole="header" style={{ fontSize: 15, fontWeight: "600", color: theme.colors.foreground }}>
      {title}
      {tail === undefined || tail === null ? null : <Text style={{ fontSize: 13, fontWeight: "400", color: theme.colors.foregroundMuted }}>{` ${tail}`}</Text>}
    </Text>
  );
}

/** One cell of a figure strip, the value optionally in its own colour (Waiting on you). */
export interface StripCell {
  label: string;
  value: string;
  unit?: string | null;
  hint?: string | null;
  valueColor?: string;
}

/**
 * Figures in ONE bordered box, divided by 1px rules: an uppercase muted label,
 * the value 26/600, an optional muted unit after it and a muted line under it.
 * A phone (the Mobile* artboards) wraps the cells two by two — an odd last
 * cell takes the full width — with an 11px label, a 22px value and 12/14
 * padding.
 */
export function FigureStrip({ cells, compact, theme, valueSize = 26 }: { cells: readonly StripCell[]; compact: boolean; theme: Theme; valueSize?: number }) {
  const { colors } = theme;
  const value = compact ? Math.min(valueSize, 22) : valueSize;
  return (
    <View style={{ flexDirection: "row", flexWrap: compact ? "wrap" : "nowrap", borderWidth: 1, borderColor: colors.border }}>
      {cells.map((cell, index) => (
        <View
          key={cell.label}
          accessibilityLabel={`${cell.label}: ${cell.value}${cell.unit ? ` ${cell.unit}` : ""}${cell.hint ? `, ${cell.hint}` : ""}`}
          style={{
            flex: 1,
            minWidth: compact ? "50%" : 0,
            gap: compact ? 4 : 6,
            paddingVertical: compact ? 12 : 16,
            paddingHorizontal: compact ? 14 : 18,
            ...(index === 0 || compact ? {} : { borderLeftWidth: 1, borderLeftColor: colors.border }),
            ...(compact && index % 2 === 1 ? { borderLeftWidth: 1, borderLeftColor: colors.border } : {}),
            ...(compact && index >= 2 ? { borderTopWidth: 1, borderTopColor: colors.border } : {}),
          }}
        >
          <Text style={{ fontSize: compact ? 11 : 12, fontWeight: "500", textTransform: "uppercase", letterSpacing: compact ? 0.66 : 0.72, color: colors.foregroundMuted }}>{cell.label}</Text>
          <Text style={{ fontSize: value, fontWeight: "600", color: cell.valueColor ?? colors.foreground }}>
            {cell.value}
            {cell.unit ? <Text style={{ fontSize: compact ? 13 : 14, fontWeight: "400", color: colors.foregroundMuted }}>{` ${cell.unit}`}</Text> : null}
          </Text>
          {cell.hint ? <Text style={{ fontSize: compact ? 11 : 12, color: colors.foregroundMuted }}>{cell.hint}</Text> : null}
        </View>
      ))}
    </View>
  );
}

/** The bar colour of each role: Worker accent, Manager muted, Reviewer amber; the rest neutral. */
export function roleColor(theme: Theme, role: RoleTokenRow["key"]): string {
  const { colors } = theme;
  if (role === "worker") return colors.accent;
  if (role === "manager") return colors.foregroundMuted;
  if (role === "reviewer") return colors.statusWarning;
  return colors.border;
}

/** A horizontal bar: a 10px track on surface2 with a fill of `share`. */
function Track({ share, color, theme, height = 10 }: { share: number; color: string | null; theme: Theme; height?: number }) {
  return (
    <View style={{ flex: 1, minWidth: 0, height, backgroundColor: theme.colors.surface2 }}>
      {color === null ? null : <View style={{ height, width: `${Math.max(0, Math.min(1, share)) * 100}%`, backgroundColor: color }} />}
    </View>
  );
}

/**
 * Tokens by role: name, a track with the role's colour, the mono value
 * right-aligned; a role not recorded reads muted. A phone narrows the name to
 * 76 and the value to 64 (mono 12), with an 8px track.
 */
export function RoleTokenBars({
  rows,
  theme,
  valueWidth = 110,
  valueSize = 14,
  compact = false,
}: {
  rows: readonly RoleTokenRow[];
  theme: Theme;
  valueWidth?: number;
  valueSize?: number;
  compact?: boolean;
}) {
  const { colors } = theme;
  return (
    <View style={{ gap: compact ? 8 : 10 }}>
      {/* A phone keeps the roles it has figures for, as the phone artboard: "not recorded" does not fit there. */}
      {(compact ? rows.filter((row) => row.recorded) : rows).map((row) => (
        <View key={row.key} accessibilityLabel={`${row.label}: ${row.value}`} style={{ flexDirection: "row", alignItems: "center", gap: compact ? 10 : 16 }}>
          <Text style={{ width: compact ? 76 : 110, fontSize: compact ? 13 : 14, color: row.recorded ? colors.foreground : colors.foregroundMuted }} numberOfLines={1}>
            {row.label}
          </Text>
          <Track share={row.share} color={row.recorded ? roleColor(theme, row.key) : null} theme={theme} height={compact ? 8 : 10} />
          <Text
            style={{ width: compact ? 64 : valueWidth, textAlign: "right", fontFamily: MONO, fontSize: compact ? 12 : valueSize, color: row.recorded ? colors.foreground : colors.foregroundMuted }}
            numberOfLines={1}
          >
            {row.value}
          </Text>
        </View>
      ))}
    </View>
  );
}

/** Bead status: one 14px stacked bar — closed, deferred, open — and its legend of 8px squares (a phone: 12px, legend 12). */
export function BeadStatusBar({ view, theme, compact = false }: { view: BeadStatusBarView; theme: Theme; compact?: boolean }) {
  const { colors } = theme;
  const colour = { closed: colors.accent, deferred: colors.border, open: colors.statusWarning } as const;
  return (
    <View style={{ gap: compact ? 10 : 14 }} accessibilityLabel={view.accessibilityLabel}>
      <View style={{ flexDirection: "row", height: compact ? 12 : 14, backgroundColor: colors.surface2 }}>
        {view.segments.map((segment) => (segment.value === 0 ? null : <View key={segment.key} style={{ width: `${segment.share * 100}%`, backgroundColor: colour[segment.key] }} />))}
      </View>
      <View style={{ flexDirection: "row", flexWrap: "wrap", columnGap: compact ? 16 : 20, rowGap: 6 }}>
        {view.segments.map((segment) => (
          <View key={segment.key} style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
            <View style={{ width: 8, height: 8, backgroundColor: colour[segment.key] }} />
            <Text style={{ fontSize: compact ? 12 : 13, color: colors.foreground }}>{segment.label}</Text>
          </View>
        ))}
      </View>
    </View>
  );
}

/** The tallest bar of Closed per day, in px. */
const DAY_BAR_MAX = 90;

/**
 * Closed per day: vertical bars with their value above and their date below.
 * A phone (the MobileMetrics artboard) draws the bars alone, 96 tall with a gap
 * of 6, and writes the dates short (`1/10`) in 11.
 */
export function ClosedPerDayChart({ days, theme, compact = false }: { days: readonly DayBar[]; theme: Theme; compact?: boolean }) {
  const { colors } = theme;
  if (days.length === 0) return <Text style={{ fontSize: 13, color: colors.foregroundMuted }}>No bead was closed in this period.</Text>;
  const top = Math.max(1, ...days.map((day) => day.value));
  if (compact) {
    return (
      <View style={{ gap: 10 }}>
        <View style={{ flexDirection: "row", alignItems: "flex-end", gap: 6, height: 96, borderBottomWidth: 1, borderBottomColor: colors.border }}>
          {days.map((day) => (
            <View
              key={day.key}
              accessibilityLabel={`${day.label}: ${day.value} closed`}
              style={{ flex: 1, height: Math.max(1, Math.round((day.value / top) * DAY_BAR_MAX)), backgroundColor: colors.accent }}
            />
          ))}
        </View>
        <View style={{ flexDirection: "row", gap: 6 }}>
          {days.map((day) => (
            <Text key={day.key} style={{ flex: 1, textAlign: "center", fontSize: 11, color: colors.foregroundMuted }} numberOfLines={1}>
              {day.short}
            </Text>
          ))}
        </View>
      </View>
    );
  }
  return (
    <View style={{ gap: 14 }}>
      <View style={{ flexDirection: "row", alignItems: "flex-end", gap: 10, height: 120, borderBottomWidth: 1, borderBottomColor: colors.border }}>
        {days.map((day) => (
          <View key={day.key} accessibilityLabel={`${day.label}: ${day.value} closed`} style={{ flex: 1, alignItems: "center", justifyContent: "flex-end", gap: 6, height: "100%" }}>
            <Text style={{ fontFamily: MONO, fontSize: 12, color: colors.foreground }}>{String(day.value)}</Text>
            <View style={{ width: "100%", maxWidth: 56, height: Math.max(1, Math.round((day.value / top) * DAY_BAR_MAX)), backgroundColor: colors.accent }} />
          </View>
        ))}
      </View>
      <View style={{ flexDirection: "row", gap: 10 }}>
        {days.map((day) => (
          <Text key={day.key} style={{ flex: 1, textAlign: "center", fontSize: 12, color: colors.foregroundMuted }} numberOfLines={1}>
            {day.label}
          </Text>
        ))}
      </View>
    </View>
  );
}

/** By feature: the feature in mono, a track, the count. */
export function FeatureBars({ bars, theme }: { bars: readonly Bar[]; theme: Theme }) {
  const { colors } = theme;
  if (bars.length === 0) return <Text style={{ fontSize: 13, color: colors.foregroundMuted }}>No bead carries a feature label.</Text>;
  const top = Math.max(1, ...bars.map((bar) => bar.value));
  return (
    <View style={{ gap: 10 }}>
      {bars.map((bar) => (
        <View key={bar.label} accessibilityLabel={`${bar.label}: ${bar.display}`} style={{ flexDirection: "row", alignItems: "center", gap: 14 }}>
          <Text style={{ width: 130, fontFamily: MONO, fontSize: 12, color: colors.foreground }} numberOfLines={1}>
            {bar.label}
          </Text>
          <Track share={bar.value / top} color={colors.foregroundMuted} theme={theme} />
          <Text style={{ width: 40, textAlign: "right", fontFamily: MONO, fontSize: 12, color: colors.foreground }}>{bar.display}</Text>
        </View>
      ))}
    </View>
  );
}

/** What the muted line under a phone's How the work ran says: which figure is which. */
export const PROCESS_LEGEND = "This project · all projects";

/**
 * How the work ran: Measure · This project · All projects, rows divided by 1px
 * rules. A phone (the MobileMetrics artboard) writes each measure as a row —
 * the label, then `3 · 5.7` in mono, the all-projects figure muted — and a
 * muted legend under them.
 */
export function ProcessTable({ rows, compact, theme }: { rows: readonly ProcessRow[]; compact: boolean; theme: Theme }) {
  const { colors } = theme;
  if (compact) {
    return (
      <View>
        {rows.map((row, index) => (
          <View
            key={row.label}
            accessibilityLabel={`${row.label}: ${row.project} in this project, ${row.all} in all projects`}
            style={{
              flexDirection: "row",
              justifyContent: "space-between",
              alignItems: "flex-start",
              gap: 12,
              paddingVertical: 10,
              borderTopWidth: 1,
              borderTopColor: colors.border,
              ...(index === rows.length - 1 ? { borderBottomWidth: 1, borderBottomColor: colors.border } : {}),
            }}
          >
            <Text style={{ flex: 1, minWidth: 0, fontSize: 13, color: colors.foreground }}>{row.label}</Text>
            <Text style={{ fontFamily: MONO, fontSize: 13, color: colors.foreground }}>
              {row.project}
              <Text style={{ color: colors.foregroundMuted }}>{` · ${row.all}`}</Text>
            </Text>
          </View>
        ))}
        <Text style={{ fontSize: 11, color: colors.foregroundMuted, paddingTop: 6 }}>{PROCESS_LEGEND}</Text>
      </View>
    );
  }
  const width = 140;
  const head = { fontSize: 12, fontWeight: "500" as const, textTransform: "uppercase" as const, letterSpacing: 0.72, color: colors.foregroundMuted };
  return (
    <View>
      <View style={{ flexDirection: "row", paddingBottom: 8, borderBottomWidth: 1, borderBottomColor: colors.border }}>
        <Text style={[head, { flex: 1 }]}>Measure</Text>
        <Text style={[head, { width, textAlign: "right" }]}>This project</Text>
        <Text style={[head, { width, textAlign: "right" }]}>All projects</Text>
      </View>
      {rows.map((row) => (
        <View
          key={row.label}
          accessibilityLabel={`${row.label}: ${row.project} in this project, ${row.all} in all projects`}
          style={{ flexDirection: "row", alignItems: "center", paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: colors.border }}
        >
          <Text style={{ flex: 1, fontSize: 14, color: colors.foreground }}>{row.label}</Text>
          <Text style={{ width, textAlign: "right", fontFamily: MONO, fontSize: 14, color: colors.foreground }}>{row.project}</Text>
          <Text style={{ width, textAlign: "right", fontFamily: MONO, fontSize: 14, color: colors.foreground }}>{row.all}</Text>
        </View>
      ))}
    </View>
  );
}

/** Two sections side by side on a wide screen (gap 32), stacked on a phone (gap 16, the Mobile* artboards' rhythm). */
function Pair({ compact, children }: { compact: boolean; children: [ReactNode, ReactNode] }) {
  return (
    <View style={{ flexDirection: compact ? "column" : "row", gap: compact ? 16 : 32 }}>
      <View style={{ flex: compact ? undefined : 1, minWidth: 0, gap: compact ? 10 : 14 }}>{children[0]}</View>
      <View style={{ flex: compact ? undefined : 1, minWidth: 0, gap: compact ? 10 : 14 }}>{children[1]}</View>
    </View>
  );
}

export interface MetricsBodyProps {
  view: MetricsView;
  loading: boolean;
  error: string | null;
  /** Why the beads could not be read; null when they could (or are still being read). */
  beadsError: string | null;
  autonomy: AutonomyFiguresView;
  /** Phone width: the pairs, the autonomy figures, the heaviest requests and the review figures stack. */
  compact?: boolean;
  onRefresh: () => void;
  styles: Styles;
  theme: Theme;
}

/**
 * The Metrics tab but its data, as the ProjectMetrics artboard draws it: the
 * five figures, Bead status beside Closed per day, By feature beside Tokens by
 * role, How the work ran; then what the tab showed before the mockup and the
 * mockup has no place for — the Orchestrator's interventions, tokens read per
 * request, autonomy by class, review lift and what was not counted. The
 * period is the page header's segmented control (`work.tsx`). Hook-free.
 */
export function MetricsBody(props: MetricsBodyProps) {
  const { view, loading, error, beadsError, autonomy, styles, theme } = props;
  const compact = props.compact ?? false;
  const { colors } = theme;
  const insights = view.insights;
  const muted = { fontSize: 13, color: colors.foregroundMuted };
  return (
    <View style={{ gap: compact ? 16 : 32 }}>
      {loading && insights === null ? <ActivityIndicator color={styles.spinner.color} /> : null}
      {error === null ? null : <ToneText tone="danger" styles={styles} theme={theme}>{`Could not read the figures. ${error}`}</ToneText>}
      {beadsError === null ? null : <ToneText tone="danger" styles={styles} theme={theme}>{`Could not read the beads. ${beadsError}`}</ToneText>}
      {insights === null || insights.empty === null ? null : <Text style={muted}>{insights.empty}</Text>}
      <FigureStrip cells={view.strip} compact={compact} theme={theme} />

      <Pair compact={compact}>
        {[
          <>
            <SectionHeading title="Bead status" theme={theme} />
            {view.beadStatus === null ? <ActivityIndicator color={styles.spinner.color} /> : <BeadStatusBar view={view.beadStatus} theme={theme} compact={compact} />}
          </>,
          <>
            <SectionHeading title="Closed per day" theme={theme} />
            {view.closedPerDay === null ? <ActivityIndicator color={styles.spinner.color} /> : <ClosedPerDayChart days={view.closedPerDay} theme={theme} compact={compact} />}
          </>,
        ]}
      </Pair>

      <Pair compact={compact}>
        {[
          <>
            <SectionHeading title="By feature" theme={theme} />
            {view.features === null ? <ActivityIndicator color={styles.spinner.color} /> : <FeatureBars bars={view.features} theme={theme} />}
          </>,
          <>
            <SectionHeading title="Tokens by role" theme={theme} />
            {view.roleTokens.length === 0 ? <Text style={muted}>{OVERVIEW_NO_TOKENS_TEXT}</Text> : <RoleTokenBars rows={view.roleTokens} theme={theme} valueWidth={100} valueSize={12} compact={compact} />}
            <Text style={{ fontSize: 12, color: colors.foregroundMuted }}>{TOKENS_BY_ROLE_NOTE}</Text>
          </>,
        ]}
      </Pair>

      <View style={{ gap: compact ? 8 : 12 }}>
        <SectionHeading title="How the work ran" theme={theme} />
        <ProcessTable rows={view.process} compact={compact} theme={theme} />
      </View>

      {insights === null ? null : (
        <View style={{ gap: 12 }}>
          <SectionHeading title="Orchestrator interventions" theme={theme} />
          <Text style={muted}>{COORDINATION_NOTE}</Text>
          {insights.coordination.length === 0 ? (
            <Text style={muted}>{COORDINATION_EMPTY}</Text>
          ) : (
            <FigureStrip cells={insights.coordination.map((card) => ({ label: card.label, value: card.value, hint: card.hint }))} compact={compact} theme={theme} valueSize={18} />
          )}
        </View>
      )}

      {insights === null || insights.requestTokens === null ? null : (
        <View style={{ gap: 12 }}>
          <RequestTokens view={insights.requestTokens} compact={compact} styles={styles} />
        </View>
      )}

      <View style={{ gap: 12 }}>
        <SectionHeading title={AUTONOMY_TITLE} theme={theme} />
        <Text style={muted}>{AUTONOMY_NOTE}</Text>
        <AutonomyFigures view={autonomy} compact={compact} styles={styles} theme={theme} />
      </View>

      {insights === null || insights.reviewLift === null ? null : (
        <View style={{ gap: 12 }}>
          <SectionHeading title={REVIEW_LIFT_TITLE} theme={theme} />
          <Text style={muted}>{REVIEW_LIFT_NOTE}</Text>
          <ReviewLiftFigures view={insights.reviewLift} compact={compact} styles={styles} theme={theme} />
        </View>
      )}

      <View style={{ flexDirection: "row", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
        {insights === null || insights.unknowns === null ? null : <Text style={{ fontSize: 12, color: colors.foregroundMuted, flexShrink: 1 }}>{insights.unknowns}</Text>}
        <Pressable accessibilityRole="button" accessibilityLabel="Refresh the figures" onPress={props.onRefresh} style={{ paddingVertical: 4 }}>
          <Text style={muted}>Refresh</Text>
        </Pressable>
      </View>
    </View>
  );
}

/** Said in Tokens by role when the server sends no context figures. */
const OVERVIEW_NO_TOKENS_TEXT = "No turn read any tokens in this period.";

export interface ProjectMetricsProps {
  workspaceId: string;
  /** The project's name; null in the workspace's own Beads tab. */
  label: string | null;
  /** The period, chosen in the page header's segmented control. */
  window: InsightsWindow;
  compact: boolean;
  theme: Theme;
}

/** The query key of the summary over every project, for How the work ran's second column. */
export const allProjectsQueryKey = (window: InsightsWindow) => insightsQueryKey(window, ALL_PROJECTS);

/** A project's Metrics tab: mounted only while it shows, so its figures are read only then. */
export function ProjectMetrics({ workspaceId, label, window, compact, theme }: ProjectMetricsProps) {
  const styles = useMemo(() => dashboardStyles(theme, compact), [theme, compact]);
  const readSummary = useRpc(insightsSummaryRpc);
  const listBeads = useRpc(beadsListRpc);
  const readLedger = useRpc(autonomyLedgerRpc);
  const readPolicy = useRpc(autonomyPolicyRpc);
  const summary = useQuery({
    queryKey: insightsQueryKey(window, workspaceId),
    queryFn: () => readSummary({ window, workspaceId }),
    staleTime: INSIGHTS_STALE_MS,
  });
  // The same period over every project: How the work ran's All projects column.
  const all = useQuery({
    queryKey: allProjectsQueryKey(window),
    queryFn: () => readSummary({ window }),
    staleTime: INSIGHTS_STALE_MS,
  });
  // The Beads screen's own query: a project's beads read here are its beads there.
  const beads = useQuery({
    queryKey: ["paseo-bm", "beads-list", workspaceId],
    queryFn: () => listBeads({ workspaceId }),
  });
  const ledger = useQuery({
    queryKey: autonomyLedgerQueryKey(workspaceId),
    queryFn: () => readLedger({ workspaceId }),
    staleTime: INSIGHTS_STALE_MS,
  });
  // Settings reads and writes this same query, so a level set there shows here.
  const policy = useQuery({ queryKey: AUTONOMY_POLICY_KEY, queryFn: () => readPolicy({}) });
  const now = new Date();
  const view = metricsView({
    summary: summary.data,
    all: all.data,
    beads: beads.data?.beads,
    window,
    projects: label === null ? [] : [{ id: workspaceId, label }],
    now,
  });
  const autonomyView = autonomyFiguresView({
    projectId: workspaceId,
    ledger: ledger.data,
    policy: policy.data?.policy,
    error: ledger.isError ? errorMessageOf(ledger.error) : policy.isError ? errorMessageOf(policy.error) : null,
  });
  return (
    <MetricsBody
      view={view}
      loading={summary.isPending}
      error={summary.isError ? errorMessageOf(summary.error) : null}
      beadsError={beads.isError ? errorMessageOf(beads.error) : null}
      autonomy={autonomyView}
      compact={compact}
      onRefresh={() => {
        void summary.refetch();
        void all.refetch();
        void beads.refetch();
        void ledger.refetch();
        void policy.refetch();
      }}
      styles={styles}
      theme={theme}
    />
  );
}
