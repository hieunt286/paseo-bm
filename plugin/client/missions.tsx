/**
 * The Missions section (missions design §10; the approved mockup
 * `docs/design/mockups/missions-screen.html`, artboards A–F): one screen,
 * four views — the list (A, C), a mission's page (B, D; its Main card and
 * In flight card from `docs/design/mockups/mission-runtime.html`, artboards
 * G and H; its Repositories lanes and In flight's Waiting part from
 * `docs/design/mockups/mission-lanes.html`, artboards Q and R), New mission
 * (E) and a project's memory (F). What each shows is `missions-model.ts`; this file
 * reads `missions.list`, `mission.get` and `memory.list` every
 * `WORK_POLL_MS` while the view shows, and sends the owner's changes:
 * `mission.change` (Rename, Close mission, "+ Add"), `autonomy.set-mission-level`
 * (the level cells; 3 and 4 confirmed in place), `mission.ensure` (Open Main),
 * `mission.integration.revoke` (a repo's Revoke, confirmed in place; delivery
 * line design §4.9, `delivery-line.html` artboards I and J),
 * `mission.integration.ask` (a repo's "Ask me again", §4.3) and
 * `missions.create` (New mission).
 *
 * A phone (`layout.compact`) shows the artboards' phone layout: the page's
 * chips (Contracts, Journal, Plan, Project memory) open each part in place,
 * and "⋯" holds Rename and Close mission.
 *
 * Client rules: React Native primitives only, colours from the theme, no
 * modal (confirmations are `ConfirmBlock`s in place), accessibility roles and
 * labels on every pressable.
 */
import { type PluginSurfaceProps, usePaseo, useRpc } from "@getpaseo/plugin/client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Linking, Pressable, ScrollView, Text, TextInput, View, type TextStyle, type ViewStyle } from "react-native";
import {
  autonomySetMissionLevelRpc,
  memoryListRpc,
  missionChangeRpc,
  missionEnsureRpc,
  missionGetRpc,
  missionIntegrationAskRpc,
  missionIntegrationRevokeRpc,
  missionsCreateRpc,
  missionsListRpc,
  type MissionChangeInput,
} from "../shared/contracts";
import { MISSION_LEVELS, levelNeedsConfirmation, type MissionLevel } from "../shared/autonomy";
import { errorMessageOf } from "./errors";
import {
  CRITERIA_SHOWN,
  EMPTY_MISSION_DRAFT,
  JOURNAL_DESKTOP,
  JOURNAL_PHONE,
  addableReposOf,
  closeMissionDialog,
  codeAsTyped,
  createInputOf,
  levelConfirmDialog,
  levelSentenceOf,
  memoryViewOf,
  missionDraftErrors,
  missionListOf,
  missionPageOf,
  nameAndCodeErrors,
  renameInputOf,
  revokeIntegrationDialog,
  toggleRepo,
  type MemoryView,
  type MissionCardView,
  type MissionDraft,
  type LaneRowView,
  type MissionPageView,
  type NameOf,
  type OverlapView,
  type WaitingRowView,
} from "./missions-model";
import { RADIUS, dashboardStyles } from "./styles";
import { MONO } from "./text-tabs";
import { toneColor, type Badge, type Tone } from "./tone";
import { Button, ConfirmBlock, KindBar, RoleMark, ToneText, type Styles, type Theme } from "./ui";
import { WORK_POLL_MS } from "./work-model";
import { newMissionRequests } from "./surface-view";
import { PROJECTS_FOOTNOTE, projectPickerOf, toggled, workspaceIdsOf, type MissionProject, type ProjectIndex, type ProjectPickerView } from "./mission-projects";

export type { MissionProject } from "./mission-projects";

export const MISSIONS_QUERY_KEYS = {
  list: ["paseo-bm", "missions", "list"] as const,
  page: (missionId: string) => ["paseo-bm", "missions", "get", missionId] as const,
  memory: (workspaceId: string) => ["paseo-bm", "memory", workspaceId] as const,
};

function pollWhile(visible: boolean) {
  return { enabled: visible, refetchInterval: visible ? WORK_POLL_MS : (false as const) };
}

// The artboards' repeated layouts, made once.
const BUTTON_TEXT: TextStyle = { fontSize: 13 };
/** A code and a name side by side; it gives way first. */
const TITLE_ROW: ViewStyle = { flexDirection: "row", alignItems: "center", gap: 10, flexShrink: 1 };
/** A title at the left, its action or figure at the right. */
const SPREAD_ROW: ViewStyle = { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 10 };
const WRAP_ROW: ViewStyle = { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 10 };
/** Name beside Short code. */
const FIELD_ROW: ViewStyle = { flexDirection: "row", gap: 12 };
/** A form's Cancel and its primary action, at the right. */
const FORM_ACTIONS: ViewStyle = { flexDirection: "row", justifyContent: "flex-end", gap: 10 };
/** `styles.card`, placed for its accent bar and grown to its cell's height in a `Grid`. */
const CARD_FILL: ViewStyle = { position: "relative", flexGrow: 1 };

// ---------------------------------------------------------------------------
// Small pieces, as the artboards' CSS draws them.
// ---------------------------------------------------------------------------

/** The artboards' chip: 12px text on surface2, a 1px border, an optional 7px square in a tone; `tone` colours the text ("+ Add", artboard N). */
function MissionChip({ text, mark, muted = false, tone, expanded, onPress, a11y, theme }: { text: string; mark?: Tone | null; muted?: boolean; tone?: Tone; expanded?: boolean; onPress?: () => void; a11y?: string; theme: Theme }) {
  const { colors } = theme;
  const body = (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 6, paddingVertical: 2, paddingHorizontal: 8, borderWidth: 1, borderColor: colors.border, borderRadius: RADIUS, backgroundColor: colors.surface2 }}>
      {mark === undefined || mark === null ? null : <View style={{ width: 7, height: 7, backgroundColor: toneColor(theme, mark) }} />}
      <Text style={{ fontSize: 12, color: tone !== undefined ? toneColor(theme, tone) : muted ? colors.foregroundMuted : colors.foreground }}>{text}</Text>
    </View>
  );
  return onPress === undefined ? body : <Pressable accessibilityRole="button" accessibilityLabel={a11y ?? text} {...(expanded === undefined ? {} : { accessibilityState: { expanded } })} onPress={onPress}>{body}</Pressable>;
}

function Small({ children, tone = "plain", theme, style, mono = false }: { children: ReactNode; tone?: Tone; theme: Theme; style?: TextStyle; mono?: boolean }) {
  return <Text style={{ fontSize: 12, color: toneColor(theme, tone), ...(mono ? { fontFamily: MONO } : {}), ...style }}>{children}</Text>;
}

/** The artboards' card (`styles.card`); the accent bar at its left when `bar`. It grows to its cell's height in a `Grid`. */
function Card({ children, bar = false, styles, theme }: { children: ReactNode; bar?: boolean; styles: Styles; theme: Theme }) {
  return (
    <View style={[styles.card, CARD_FILL]}>
      {bar ? <KindBar tone="info" theme={theme} /> : null}
      {children}
    </View>
  );
}

/** The 4px progress bar of done criteria. */
function Progress({ share, theme }: { share: number; theme: Theme }) {
  return (
    <View style={{ height: 4, backgroundColor: theme.colors.surface2, borderRadius: RADIUS, overflow: "hidden", flex: 1 }}>
      <View style={{ height: 4, width: `${Math.round(share * 100)}%`, backgroundColor: theme.colors.accent }} />
    </View>
  );
}

/** Columns that share the row equally and stretch to its height, as the artboards' CSS grids do (`grid2`, `grid3`). */
function Grid({ children, gap }: { children: ReactNode[]; gap: number }) {
  return (
    <View style={{ flexDirection: "row", gap, alignItems: "stretch" }}>
      {children.map((child, index) => (
        <View key={index} style={{ flex: 1, flexBasis: 0, minWidth: 0 }}>
          {child}
        </View>
      ))}
    </View>
  );
}

/** The mission level's five joined cells: the chosen one filled in the accent (the artboards' `.seg`). */
function LevelCells({ level, onSelect, disabled = false, theme }: { level: MissionLevel; onSelect: (level: MissionLevel) => void; disabled?: boolean; theme: Theme }) {
  const { colors } = theme;
  return (
    <View accessibilityRole="radiogroup" style={{ flexDirection: "row", alignSelf: "flex-start", borderWidth: 1, borderColor: colors.border, borderRadius: RADIUS, overflow: "hidden" }}>
      {MISSION_LEVELS.map((value, index) => {
        const on = value === level;
        return (
          <Pressable
            key={value}
            accessibilityRole="radio"
            accessibilityLabel={`Mission level ${value}`}
            accessibilityState={{ checked: on, disabled }}
            disabled={disabled}
            onPress={() => onSelect(value)}
            style={{ paddingVertical: 6, paddingHorizontal: 10, backgroundColor: on ? colors.accent : colors.surface1, ...(index === 0 ? {} : { borderLeftWidth: 1, borderLeftColor: colors.border }) }}
          >
            <Text style={{ fontSize: 12, color: on ? colors.accentForeground : colors.foregroundMuted }}>{String(value)}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/** A labelled text field (the artboards' `.input`). */
function Field({ label, value, onChange, a11y, mono = false, multiline = false, editable = true, theme, style }: { label: string; value: string; onChange: (text: string) => void; a11y: string; mono?: boolean; multiline?: boolean; editable?: boolean; theme: Theme; style?: ViewStyle }) {
  const { colors } = theme;
  return (
    <View style={{ gap: 4, ...style }}>
      <Small tone="muted" theme={theme}>{label}</Small>
      <TextInput
        value={value}
        onChangeText={onChange}
        accessibilityLabel={a11y}
        editable={editable}
        multiline={multiline}
        style={{
          borderWidth: 1,
          borderColor: colors.border,
          backgroundColor: colors.surface0,
          borderRadius: RADIUS,
          paddingVertical: 8,
          paddingHorizontal: 10,
          color: colors.foreground,
          fontSize: 13,
          ...(mono ? { fontFamily: MONO } : {}),
          ...(multiline ? { height: 64, textAlignVertical: "top" as const } : {}),
        }}
      />
    </View>
  );
}

/** "Find a project…" (`mission-projects.html`, the artboards' `.input`): filters the list by name and folder. */
function ProjectFilter({ value, onChange, editable, theme, style }: { value: string; onChange: (text: string) => void; editable: boolean; theme: Theme; style: ViewStyle }) {
  const { colors } = theme;
  return (
    <TextInput
      value={value}
      onChangeText={onChange}
      placeholder="Find a project…"
      placeholderTextColor={colors.foregroundMuted}
      accessibilityLabel="Find a project"
      editable={editable}
      style={{ borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface0, borderRadius: RADIUS, paddingVertical: 8, paddingHorizontal: 10, color: colors.foreground, fontSize: 13, ...style }}
    />
  );
}

/** The project rows (`mission-projects.html`, `.plist`): a checkbox, the bold name, the folder in mono below it. */
function ProjectRows({ view, onToggle, disabled, theme }: { view: ProjectPickerView; onToggle: (id: string) => void; disabled: boolean; theme: Theme }) {
  const { colors } = theme;
  if (view.empty !== null) return <Small tone="muted" theme={theme}>{view.empty}</Small>;
  return (
    <View style={{ borderWidth: 1, borderColor: colors.border, borderRadius: RADIUS }}>
      {view.rows.map((row, index) => (
        <Pressable
          key={row.id}
          accessibilityRole="checkbox"
          accessibilityLabel={`${row.name}, ${row.path}`}
          accessibilityState={{ checked: row.checked, disabled }}
          disabled={disabled}
          onPress={() => onToggle(row.id)}
          style={{ flexDirection: "row", alignItems: "flex-start", gap: 10, paddingVertical: 9, paddingHorizontal: 12, ...(index === view.rows.length - 1 ? {} : { borderBottomWidth: 1, borderBottomColor: colors.border }) }}
        >
          <View style={{ width: 16, height: 16, marginTop: 2, borderWidth: 1, borderRadius: RADIUS, alignItems: "center", justifyContent: "center", borderColor: row.checked ? colors.accent : colors.border, backgroundColor: row.checked ? colors.accent : "transparent" }}>
            {row.checked ? <Text style={{ fontSize: 11, lineHeight: 14, color: colors.accentForeground }}>✓</Text> : null}
          </View>
          <View style={{ flexShrink: 1 }}>
            <Text style={{ fontSize: 13, fontWeight: "600", color: colors.foreground }}>{row.name}</Text>
            <Text style={{ fontSize: 11, color: colors.foregroundMuted, fontFamily: MONO }}>{row.path}</Text>
          </View>
        </Pressable>
      ))}
    </View>
  );
}

/** A back link: "Missions ›", "‹ AIX". */
function BackLink({ text, a11y, onPress, theme, size = 14 }: { text: string; a11y: string; onPress: () => void; theme: Theme; size?: number }) {
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={a11y} onPress={onPress} style={{ alignSelf: "flex-start" }}>
      <Text style={{ fontSize: size, color: theme.colors.foregroundMuted }}>{text}</Text>
    </Pressable>
  );
}

/** A table row: cells sharing the width by `flex`, a 1px bottom border (the artboards' `td`, `th`). */
function TableRow({ cells, flex, header = false, theme }: { cells: ReactNode[]; flex: readonly number[]; header?: boolean; theme: Theme }) {
  return (
    <View style={{ flexDirection: "row", borderBottomWidth: 1, borderBottomColor: theme.colors.border }}>
      {cells.map((cell, index) => (
        <View key={index} style={{ flex: flex[index] ?? 1, flexBasis: 0, minWidth: 0, paddingVertical: 7, paddingHorizontal: 8 }}>
          {typeof cell === "string" ? (
            <Text style={header ? { fontSize: 12, fontWeight: "500", color: theme.colors.foregroundMuted } : { fontSize: 13, color: theme.colors.foreground }}>{cell}</Text>
          ) : (
            cell
          )}
        </View>
      ))}
    </View>
  );
}

/** Text in pieces of their own tones on one line ("Done 5 of 11 · 2 questions · 1 signal"). */
function Parts({ parts, theme }: { parts: readonly Badge[]; theme: Theme }) {
  return (
    <Text style={{ fontSize: 12, color: theme.colors.foreground }}>
      {parts.map((part, index) => (
        <Text key={index} style={{ color: toneColor(theme, part.tone) }}>
          {`${index === 0 ? "" : " · "}${part.text}`}
        </Text>
      ))}
    </Text>
  );
}

/** A line led by a word in its tone: "The Main decides: …", "Mess: 4 Workers wrote …". */
function ToneLine({ label, tone, text, theme }: { label: string; tone: Tone; text: string; theme: Theme }) {
  return (
    <Text style={{ fontSize: 12, color: theme.colors.foreground }}>
      <Text style={{ color: toneColor(theme, tone) }}>{label}</Text>
      {` ${text}`}
    </Text>
  );
}

// ---------------------------------------------------------------------------
// The list (artboards A, C). Hook-free.
// ---------------------------------------------------------------------------

/** One mission on the list; the whole card opens its page. */
export function MissionCard({ card, compact, onOpen, styles, theme }: { card: MissionCardView; compact: boolean; onOpen: (missionId: string) => void; styles: Styles; theme: Theme }) {
  const { colors } = theme;
  const code = <Text style={{ fontSize: 14, fontWeight: "700", letterSpacing: 0.5, color: colors.foreground }}>{card.code}</Text>;
  const name = (weight: "600" | "400") => (
    <Text style={{ fontSize: 14, fontWeight: weight, color: colors.foreground, flexShrink: 1 }} numberOfLines={1}>
      {card.name}
    </Text>
  );
  let body: ReactNode;
  if (!card.open) {
    body = (
      <View style={{ flexDirection: compact ? "column" : "row", justifyContent: "space-between", alignItems: compact ? "flex-start" : "center", gap: compact ? 4 : 10 }}>
        <View style={TITLE_ROW}>
          {code}
          {name("400")}
        </View>
        <Small tone="muted" theme={theme}>{card.closedLine}</Small>
      </View>
    );
  } else if (compact) {
    body = (
      <>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
          {code}
          {name("600")}
        </View>
        <Small tone="muted" theme={theme}>{card.phoneLine}</Small>
        <View style={{ flexDirection: "row" }}>
          <Progress share={card.progress} theme={theme} />
        </View>
        <Parts parts={card.phoneParts} theme={theme} />
      </>
    );
  } else {
    body = (
      <>
        <View style={SPREAD_ROW}>
          <View style={TITLE_ROW}>
            {code}
            {name("600")}
            <MissionChip text={card.main.text} mark={card.main.tone} theme={theme} />
          </View>
          <Small tone="muted" theme={theme}>{card.level}</Small>
        </View>
        <View style={WRAP_ROW}>
          {card.repos.map((repo) => (
            <MissionChip key={repo} text={repo} theme={theme} />
          ))}
          <Small tone="muted" theme={theme}>{card.counts}</Small>
        </View>
        <View style={{ flexDirection: "row", alignItems: "center" }}>
          <Progress share={card.progress} theme={theme} />
          <Small theme={theme} style={{ marginLeft: 12 }}>{card.criteria}</Small>
        </View>
        <View style={WRAP_ROW}>
          {card.attention.map((badge) => (
            <MissionChip key={badge.text} text={badge.text} mark={badge.tone} theme={theme} />
          ))}
          {card.quiet === null ? null : <Small tone="muted" theme={theme}>{card.quiet}</Small>}
        </View>
      </>
    );
  }
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={`${card.code} ${card.name}. Open the mission`} onPress={() => onOpen(card.missionId)} style={{ opacity: card.open ? 1 : 0.7 }}>
      <Card bar={card.open} styles={styles} theme={theme}>
        {body}
      </Card>
    </Pressable>
  );
}

export interface MissionListProps {
  list: { open: MissionCardView[]; closed: MissionCardView[] } | null;
  error: string | null;
  compact: boolean;
  /** A phone folds the closed missions under "Closed · n". */
  closedShown: boolean;
  onToggleClosed: () => void;
  onOpen: (missionId: string) => void;
  onNew: () => void;
  status?: ReactNode;
  styles: Styles;
  theme: Theme;
}

/** The list: the title and New mission, the open missions, then the closed ones. */
export function MissionList({ list, error, compact, closedShown, onToggleClosed, onOpen, onNew, status, styles, theme }: MissionListProps) {
  const { colors } = theme;
  const closed = list?.closed ?? [];
  return (
    <View style={{ gap: compact ? 8 : 12 }}>
      <View style={SPREAD_ROW}>
        <Text accessibilityRole="header" style={{ fontSize: compact ? 18 : 24, fontWeight: "600", color: colors.foreground }}>
          Missions
        </Text>
        <Button label={compact ? "New" : "New mission"} kind="primary" accessibilityLabel="New mission" onPress={onNew} styles={styles} style={compact ? { paddingVertical: 7, paddingHorizontal: 10 } : undefined} textStyle={BUTTON_TEXT} />
      </View>
      {compact ? null : <Text style={{ fontSize: 14, color: colors.foregroundMuted }}>One Main per goal. A mission spans the repositories it needs; you name it, you close it.</Text>}
      {status}
      {error === null ? null : <ToneText tone="danger" styles={styles} theme={theme}>{`Could not read the missions: ${error}`}</ToneText>}
      {list === null ? (
        error === null ? <Text style={{ fontSize: 14, color: colors.foregroundMuted }}>Loading…</Text> : null
      ) : (
        <>
          {compact ? null : <Text style={styles.sectionLabel}>{`Open · ${list.open.length}`}</Text>}
          {list.open.length === 0 ? <Text style={{ fontSize: 14, color: colors.foregroundMuted }}>No open mission. New mission names one and opens its Main.</Text> : null}
          {list.open.map((card) => (
            <MissionCard key={card.missionId} card={card} compact={compact} onOpen={onOpen} styles={styles} theme={theme} />
          ))}
          {closed.length === 0 ? null : compact ? (
            <Pressable accessibilityRole="button" accessibilityLabel={closedShown ? "Hide the closed missions" : "Show the closed missions"} accessibilityState={{ expanded: closedShown }} onPress={onToggleClosed}>
              <Small tone="muted" theme={theme}>{`Closed · ${closed.length}`}</Small>
            </Pressable>
          ) : (
            <Text style={styles.sectionLabel}>{`Closed · ${closed.length}`}</Text>
          )}
          {compact && !closedShown ? null : closed.map((card) => <MissionCard key={card.missionId} card={card} compact={compact} onOpen={onOpen} styles={styles} theme={theme} />)}
        </>
      )}
    </View>
  );
}

// ---------------------------------------------------------------------------
// A mission's page (artboards B, D). Hook-free.
// ---------------------------------------------------------------------------

export type PagePart = "contracts" | "journal" | "plan";

/** What the page is doing besides showing: the owner's open forms and the call that runs. */
export interface PageUi {
  allCriteria: boolean;
  /** The phone's "⋯" list. */
  menu: boolean;
  /** The phone's part shown in place. */
  part: PagePart | null;
  rename: { name: string; code: string } | null;
  adding: boolean;
  /** "+ Add"'s panel (artboard N): what is ticked and "Find a project…". */
  addChosen: readonly string[];
  addFilter: string;
  confirm: { kind: "close" } | { kind: "level"; level: MissionLevel } | { kind: "revoke"; repo: string } | null;
  /** What runs now ("Opening…", "Saving…"); null when nothing. */
  busy: string | null;
  error: string | null;
  notice: string | null;
}

export const PAGE_UI_IDLE: PageUi = { allCriteria: false, menu: false, part: null, rename: null, adding: false, addChosen: [], addFilter: "", confirm: null, busy: null, error: null, notice: null };

export interface MissionPageActions {
  back: () => void;
  openMain: () => void;
  ui: (change: Partial<PageUi>) => void;
  saveRename: () => void;
  close: () => void;
  /** Adds the projects ticked in "+ Add"'s panel. */
  addRepos: (ids: readonly string[]) => void;
  level: (level: MissionLevel) => void;
  confirmLevel: () => void;
  memory: (workspaceId: string) => void;
  openAgent?: (agentId: string) => void;
  /** Opens the Inbox, where an open question's card is answered (mission runtime design §7). */
  openInbox?: () => void;
  /** Revokes push and merge request for a repo, once confirmed (delivery line design §4.3). */
  revoke?: (repo: string) => void;
  /** Opens a fresh integration card for a repo after not now or a revoke (delivery line design §4.3). */
  askAgain?: (repo: string) => void;
}

export interface MissionPageBodyProps {
  page: MissionPageView;
  ui: PageUi;
  addable: readonly MissionProject[];
  compact: boolean;
  status?: ReactNode;
  on: MissionPageActions;
  styles: Styles;
  theme: Theme;
}

function StatBox({ label, value, hint, tone, compact, theme }: { label: string; value: string; hint: string | null; tone: Tone; compact: boolean; theme: Theme }) {
  return (
    <View style={{ flexGrow: 1, backgroundColor: theme.colors.surface1, borderWidth: 1, borderColor: theme.colors.border, borderRadius: RADIUS, padding: 12 }}>
      <Small tone="muted" theme={theme}>{label}</Small>
      <Text style={{ fontSize: compact ? 16 : 20, fontWeight: "700", color: toneColor(theme, tone) }}>{value}</Text>
      {hint === null ? null : <Small tone="muted" theme={theme}>{hint}</Small>}
    </View>
  );
}

function Criterion({ line, status, theme }: { line: string; status: "open" | "met" | "dropped"; theme: Theme }) {
  const { colors } = theme;
  const box: ViewStyle =
    status === "met"
      ? { backgroundColor: colors.statusSuccess, borderColor: colors.statusSuccess }
      : status === "dropped"
        ? { backgroundColor: colors.surface2, borderColor: colors.border }
        : { borderColor: colors.border };
  return (
    <View style={{ flexDirection: "row", gap: 8, alignItems: "flex-start" }}>
      <View accessibilityLabel={status} style={{ width: 14, height: 14, borderWidth: 1, borderRadius: RADIUS, marginTop: 2, ...box }} />
      <Text style={{ fontSize: 13, color: status === "dropped" ? colors.foregroundMuted : colors.foreground, flexShrink: 1 }}>{line}</Text>
    </View>
  );
}

/** The page's title row and its actions (Open Main, Rename, Close mission; on a phone Open Main and "⋯"). */
function PageHeader({ page, ui, compact, on, styles, theme }: Pick<MissionPageBodyProps, "page" | "ui" | "compact" | "on" | "styles" | "theme">) {
  const { colors } = theme;
  const busy = ui.busy !== null;
  const openMain = <Button label={ui.busy === "Opening…" ? "Opening…" : "Open Main"} kind="primary" accessibilityLabel={`Open the Main of ${page.code}`} accessibilityState={{ disabled: busy, busy }} disabled={busy} onPress={on.openMain} styles={styles} textStyle={BUTTON_TEXT} style={compact ? { flex: 1 } : undefined} />;
  const rename = <Button label="Rename" kind="secondary" accessibilityLabel={`Rename ${page.code}`} disabled={busy} onPress={() => on.ui({ rename: { name: page.name, code: page.code }, menu: false, confirm: null })} styles={styles} textStyle={BUTTON_TEXT} />;
  const close = <Button label="Close mission" kind="danger" accessibilityLabel={`Close mission ${page.code}`} disabled={busy} onPress={() => on.ui({ confirm: { kind: "close" }, menu: false, rename: null })} styles={styles} textStyle={BUTTON_TEXT} />;
  const title = (
    <View style={TITLE_ROW}>
      <Text style={{ fontSize: compact ? 18 : 20, fontWeight: "700", letterSpacing: 0.5, color: colors.foreground }}>{page.code}</Text>
      <Text accessibilityRole="header" style={{ fontSize: compact ? 18 : 20, fontWeight: "600", color: colors.foreground, flexShrink: 1 }} numberOfLines={compact ? 2 : 1}>
        {page.name}
      </Text>
    </View>
  );
  if (compact) {
    return (
      <View style={{ gap: 8 }}>
        <BackLink text="Missions ›" a11y="Back to Missions" onPress={on.back} theme={theme} size={12} />
        {title}
        {page.open ? (
          <View style={{ flexDirection: "row", gap: 10 }}>
            {openMain}
            <Button label="⋯" kind="secondary" accessibilityLabel={ui.menu ? "Hide the mission's actions" : "More actions: Rename, Close mission"} accessibilityState={{ expanded: ui.menu }} onPress={() => on.ui({ menu: !ui.menu })} styles={styles} textStyle={BUTTON_TEXT} />
          </View>
        ) : (
          <Small tone="muted" theme={theme}>{page.closedLine}</Small>
        )}
        {ui.menu && page.open ? (
          <View style={{ gap: 6 }}>
            {rename}
            {close}
          </View>
        ) : null}
      </View>
    );
  }
  return (
    <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 10 }}>
      <View style={TITLE_ROW}>
        <BackLink text="Missions ›" a11y="Back to Missions" onPress={on.back} theme={theme} />
        {title}
      </View>
      {page.open ? (
        <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
          {openMain}
          {rename}
          {close}
        </View>
      ) : (
        <Small tone="muted" theme={theme}>{page.closedLine}</Small>
      )}
    </View>
  );
}

/** Rename in place, the close confirmation, and what the last call said. */
function PageForms({ page, ui, on, styles, theme }: Pick<MissionPageBodyProps, "page" | "ui" | "on" | "styles" | "theme">) {
  const errors = ui.rename === null ? [] : nameAndCodeErrors(ui.rename.name, ui.rename.code);
  return (
    <>
      {ui.rename === null ? null : (
        <View style={{ gap: 8 }}>
          <View style={FIELD_ROW}>
            <Field label="Name" value={ui.rename.name} onChange={(name) => on.ui({ rename: { ...ui.rename!, name } })} a11y="Mission name" theme={theme} style={{ flex: 3 }} />
            <Field label="Short code" value={ui.rename.code} onChange={(code) => on.ui({ rename: { ...ui.rename!, code: codeAsTyped(code) } })} a11y="Short code" mono theme={theme} style={{ flex: 1 }} />
          </View>
          {errors.map((line) => (
            <ToneText key={line} tone="danger" styles={styles} theme={theme}>{line}</ToneText>
          ))}
          <View style={FORM_ACTIONS}>
            <Button label="Cancel" kind="secondary" onPress={() => on.ui({ rename: null })} styles={styles} textStyle={BUTTON_TEXT} />
            <Button label={ui.busy === "Saving…" ? "Saving…" : "Save"} kind="primary" accessibilityLabel="Save the name and code" disabled={errors.length > 0 || ui.busy !== null} onPress={on.saveRename} styles={styles} textStyle={BUTTON_TEXT} />
          </View>
        </View>
      )}
      {ui.confirm?.kind !== "close" ? null : (
        <ConfirmBlock dialog={closeMissionDialog(page.code)} busy={ui.busy !== null} busyLabel="Closing…" onConfirm={on.close} onCancel={() => on.ui({ confirm: null })} styles={styles} theme={theme} />
      )}
      {ui.notice === null ? null : <Text style={styles.body}>{ui.notice}</Text>}
      {ui.error === null ? null : <ToneText tone="danger" styles={styles} theme={theme}>{ui.error}</ToneText>}
    </>
  );
}

/** "+ Add"'s panel (`mission-projects.html`, artboard N): the projects not in the mission, Cancel and Add. */
function AddPanel({ addable, ui, on, styles, theme }: Pick<MissionPageBodyProps, "addable" | "ui" | "on" | "styles" | "theme">) {
  const { colors } = theme;
  const view = projectPickerOf({ projects: addable, chosen: ui.addChosen, filter: ui.addFilter, compact: false, empty: "Every listed project is in this mission already." });
  const busy = ui.busy !== null;
  return (
    <View style={{ marginTop: 6, padding: 10, borderWidth: 1, borderColor: colors.border, borderRadius: RADIUS, backgroundColor: colors.surface2 }}>
      {view.filterShown ? <ProjectFilter value={ui.addFilter} onChange={(addFilter) => on.ui({ addFilter })} editable={!busy} theme={theme} style={{ marginBottom: 6 }} /> : null}
      <ProjectRows view={view} onToggle={(id) => on.ui({ addChosen: toggled(ui.addChosen, id) })} disabled={busy} theme={theme} />
      <View style={{ ...FORM_ACTIONS, marginTop: 8 }}>
        <Button label="Cancel" kind="secondary" disabled={busy} onPress={() => on.ui({ adding: false, addChosen: [], addFilter: "" })} styles={styles} textStyle={BUTTON_TEXT} />
        <Button label={ui.busy === "Adding…" ? "Adding…" : "Add"} kind="primary" accessibilityLabel="Add the chosen projects to the mission" accessibilityState={{ disabled: busy || ui.addChosen.length === 0, busy }} disabled={busy || ui.addChosen.length === 0} onPress={() => on.addRepos(ui.addChosen)} styles={styles} textStyle={BUTTON_TEXT} />
      </View>
    </View>
  );
}

/** The charter card; `full` is the wide page's (non-goals, criteria, "+ Add"). */
function CharterCard({ page, ui, addable, compact, on, styles, theme }: Pick<MissionPageBodyProps, "page" | "ui" | "addable" | "compact" | "on" | "styles" | "theme">) {
  const { charter } = page;
  const shown = ui.allCriteria ? charter.criteria : charter.criteria.slice(0, CRITERIA_SHOWN);
  const more = charter.criteria.length - CRITERIA_SHOWN;
  const repos = (
    <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 6, marginTop: compact ? 0 : 4 }}>
      {charter.repos.map((repo) => (
        <MissionChip key={repo.workspaceId} text={repo.name} onPress={() => on.memory(repo.workspaceId)} a11y={`${repo.name}. Open its project memory`} theme={theme} />
      ))}
      {compact || !page.open ? null : (
        <MissionChip text="+ Add" tone="info" expanded={ui.adding} onPress={() => on.ui({ adding: !ui.adding, addChosen: [], addFilter: "" })} a11y="Add a repository to the mission" theme={theme} />
      )}
    </View>
  );
  if (compact) {
    return (
      <Card styles={styles} theme={theme}>
        <Text style={styles.sectionLabel}>Charter</Text>
        <Small theme={theme}>{charter.goal === "" ? "No goal yet." : charter.goal}</Small>
        {repos}
      </Card>
    );
  }
  return (
    <Card styles={styles} theme={theme}>
      <Text style={styles.sectionLabel}>{charter.label}</Text>
      <View>
        <Small tone="muted" theme={theme}>Goal</Small>
        <Text style={{ fontSize: 14, color: theme.colors.foreground }}>{charter.goal === "" ? "No goal yet." : charter.goal}</Text>
      </View>
      <View>
        <Small tone="muted" theme={theme}>Repositories</Small>
        {repos}
        {!ui.adding ? null : <AddPanel addable={addable} ui={ui} on={on} styles={styles} theme={theme} />}
      </View>
      {charter.nonGoals === null ? null : (
        <View>
          <Small tone="muted" theme={theme}>Not in this mission</Small>
          <Small theme={theme}>{charter.nonGoals}</Small>
        </View>
      )}
      <View style={{ gap: 4 }}>
        <Small tone="muted" theme={theme}>Done criteria</Small>
        {charter.criteria.length === 0 ? <Small tone="muted" theme={theme}>None yet.</Small> : null}
        {shown.map((criterion) => (
          <Criterion key={criterion.id} line={criterion.line} status={criterion.status} theme={theme} />
        ))}
        {more <= 0 ? null : (
          <Pressable accessibilityRole="button" accessibilityLabel={ui.allCriteria ? "Show fewer done criteria" : `Show ${more} more done criteria`} onPress={() => on.ui({ allCriteria: !ui.allCriteria })} style={{ alignSelf: "flex-start" }}>
            <Small tone="info" theme={theme}>{ui.allCriteria ? "Show fewer" : `+ ${more} more`}</Small>
          </Pressable>
        )}
      </View>
    </Card>
  );
}

/** The mission level card: the cells, who decides what, the governor (wide) or the level's sentence (phone). */
function LevelCard({ page, ui, compact, on, styles, theme }: Pick<MissionPageBodyProps, "page" | "ui" | "compact" | "on" | "styles" | "theme">) {
  const pending = ui.confirm?.kind === "level" ? ui.confirm.level : null;
  const cells = <LevelCells level={page.level.level} onSelect={on.level} disabled={!page.open || ui.busy !== null} theme={theme} />;
  const confirm =
    pending === null ? null : (
      <ConfirmBlock dialog={levelConfirmDialog(pending, page.code)} busy={ui.busy !== null} busyLabel="Saving…" onConfirm={on.confirmLevel} onCancel={() => on.ui({ confirm: null })} styles={styles} theme={theme} />
    );
  if (compact) {
    return (
      <Card styles={styles} theme={theme}>
        <Text style={styles.sectionLabel}>Mission level</Text>
        {cells}
        <Small tone="muted" theme={theme}>{page.level.sentence}</Small>
        {confirm}
      </Card>
    );
  }
  return (
    <Card styles={styles} theme={theme}>
      <Text style={styles.sectionLabel}>Mission level</Text>
      {cells}
      {confirm}
      <ToneLine label="The Main decides:" tone="success" text={page.level.decides} theme={theme} />
      <ToneLine label="Yours:" tone="muted" text={page.level.yours} theme={theme} />
      <Text style={[styles.sectionLabel, { marginTop: 6 }]}>Governor</Text>
      {page.governor.lines.map((entry) => (
        <ToneLine key={entry.label} {...entry} theme={theme} />
      ))}
      {page.governor.quiet === null ? null : <ToneLine {...page.governor.quiet} theme={theme} />}
    </Card>
  );
}

const WORKER_COLUMNS = [1.3, 2.2, 1, 1.4, 1.6] as const;

/** A Worker's mark and id, which opens it; `more` other Workers of its lane as "+1" (delivery line design §19.8, mockup Q). */
function WorkerCell({ worker, workerId, more = 0, openAgent, theme }: { worker: string | null; workerId: string | null; more?: number; openAgent?: (agentId: string) => void; theme: Theme }) {
  if (worker === null || workerId === null) return <Text style={{ fontSize: 13, color: theme.colors.foregroundMuted }}>—</Text>;
  const body = (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
      <RoleMark kind="worker" theme={theme} size={16} />
      <Text style={{ fontSize: 12, fontFamily: MONO, color: theme.colors.foreground }}>{worker}</Text>
      {more > 0 ? <Text style={{ fontSize: 12, color: theme.colors.foreground }}>{`+${more}`}</Text> : null}
    </View>
  );
  return openAgent === undefined ? body : <Pressable accessibilityRole="button" accessibilityLabel={`Open Worker ${worker}`} onPress={() => openAgent(workerId)}>{body}</Pressable>;
}

/** "Workers by repository": one row per roster request (wide), the active ones and "+ N finished" (phone). */
function WorkersCard({ page, compact, on, styles, theme }: Pick<MissionPageBodyProps, "page" | "compact" | "on" | "styles" | "theme">) {
  const { colors } = theme;
  if (compact) {
    const active = page.rows.filter((row) => row.active);
    return (
      <Card styles={styles} theme={theme}>
        <Text style={styles.sectionLabel}>Workers</Text>
        {page.rows.length === 0 ? <Small tone="muted" theme={theme}>No Workers yet.</Small> : null}
        {active.map((row) => (
          <Text key={row.requestId} style={{ fontSize: 12, color: colors.foreground }}>
            <Text style={{ fontWeight: "700" }}>{row.repo}</Text>
            {` · ${row.topic ?? row.request} · `}
            <Text style={{ color: toneColor(theme, row.phase.tone) }}>{row.phase.text}</Text>
          </Text>
        ))}
        {page.restLine === null ? null : <Small tone="muted" theme={theme}>{page.restLine}</Small>}
      </Card>
    );
  }
  return (
    <Card styles={styles} theme={theme}>
      <Text style={styles.sectionLabel}>Workers by repository</Text>
      {page.rows.length === 0 ? (
        <Small tone="muted" theme={theme}>No Workers yet.</Small>
      ) : (
        <View>
          <TableRow header cells={["Repository", "Request · topic", "Worker", "Phase", "Links"]} flex={WORKER_COLUMNS} theme={theme} />
          {page.rows.map((row) => (
            <TableRow
              key={row.requestId}
              flex={WORKER_COLUMNS}
              theme={theme}
              cells={[
                row.repo,
                <Text key="request" style={{ fontSize: 13, color: colors.foreground }}>
                  <Text style={{ fontFamily: MONO, fontSize: 12 }}>{row.request}</Text>
                  {row.topic === null ? "" : ` ${row.topic}`}
                </Text>,
                <WorkerCell key="worker" worker={row.worker} workerId={row.workerId} openAgent={on.openAgent} theme={theme} />,
                <Text key="phase" style={{ fontSize: 13, color: toneColor(theme, row.phase.tone) }}>{row.phase.text}</Text>,
                row.links,
              ]}
            />
          ))}
        </View>
      )}
    </Card>
  );
}

const REPO_COLUMNS = [1.5, 2, 2.2, 1.7, 1.8] as const;
/** The small Revoke and Answer buttons of a table cell. */
const CELL_BUTTON: ViewStyle = { paddingVertical: 3, paddingHorizontal: 8 };
/** A lane row's first cell, indented under its repository (mockup Q: 22px with the cell's own 8). */
const LANE_INDENT: TextStyle = { paddingLeft: 14 };

/** A lane's Work cell (mockup Q): its topic, then "· 🔵 3729405 · 1 Worker" small and muted; "free" when it has none. */
function LaneWork({ lane, openAgent, theme }: { lane: LaneRowView; openAgent?: (agentId: string) => void; theme: Theme }) {
  const { colors } = theme;
  if (lane.work === null) return <Text style={{ fontSize: 13, color: colors.foregroundMuted }}>{lane.idle ?? "—"}</Text>;
  const { workers, count } = lane.work;
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 4 }}>
      <Text style={{ fontSize: 13, color: colors.foreground }}>{lane.work.topic}</Text>
      {workers.length === 0 && count === null ? null : <Small tone="muted" theme={theme}>·</Small>}
      {workers.map((worker, index) => {
        const mark = (
          <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
            <RoleMark kind="worker" theme={theme} size={14} />
            <Small tone="muted" theme={theme}>{`${worker.short}${index < workers.length - 1 ? "," : ""}`}</Small>
          </View>
        );
        return openAgent === undefined ? (
          <View key={worker.agentId}>{mark}</View>
        ) : (
          <Pressable key={worker.agentId} accessibilityRole="button" accessibilityLabel={`Open Worker ${worker.short}`} onPress={() => openAgent(worker.agentId)}>
            {mark}
          </Pressable>
        );
      })}
      {count === null ? null : <Small tone="muted" theme={theme}>{`· ${count}`}</Small>}
    </View>
  );
}

/** The overlap line under the table (mockup Q): a warning square, the lanes in bold, the files in mono, when the Main was told. */
function OverlapLine({ overlap, theme }: { overlap: OverlapView; theme: Theme }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
      <View style={{ width: 7, height: 7, backgroundColor: toneColor(theme, "warning") }} />
      <Text style={{ flexShrink: 1, fontSize: 12, color: theme.colors.foreground }}>
        <Text style={{ fontWeight: "700" }}>{overlap.lead}</Text>
        {" "}
        <Text style={{ fontFamily: MONO }}>{overlap.files}</Text>
        {` · ${overlap.told}`}
      </Text>
    </View>
  );
}

/**
 * The Repositories card (delivery line design §4.9, §19.8; mockup
 * `mission-lanes.html`, artboards Q and R): each repo's mission branch and
 * its state, "n of 7 lanes", its merge request (CI only while
 * `integration.ci` is on, ADR-036) and push and merge request with Revoke
 * (confirmed in place) or Answer (the Inbox); under it each lane with its
 * branch, work and Workers, state and age, a free lane's last merge; then
 * the overlap lines.
 */
function RepositoriesCard({ page, ui, compact, on, styles, theme }: Pick<MissionPageBodyProps, "page" | "ui" | "compact" | "on" | "styles" | "theme">) {
  const repositories = page.repositories;
  if (repositories === null) return null;
  const { colors } = theme;
  const pending = ui.confirm?.kind === "revoke" ? ui.confirm.repo : null;
  const ask = (repo: string) => on.ui({ confirm: { kind: "revoke", repo }, menu: false, rename: null });
  const confirmOf = (row: (typeof repositories.rows)[number]) =>
    pending !== row.workspaceId || on.revoke === undefined ? null : (
      <View key="confirm" style={{ paddingVertical: 8 }}>
        <ConfirmBlock dialog={revokeIntegrationDialog(page.code, row)} busy={ui.busy !== null} busyLabel="Revoking…" onConfirm={() => on.revoke!(row.workspaceId)} onCancel={() => on.ui({ confirm: null })} styles={styles} theme={theme} />
      </View>
    );
  const canRevoke = (row: (typeof repositories.rows)[number]) => row.push.action === "revoke" && on.revoke !== undefined && page.open;
  const canAnswer = (row: (typeof repositories.rows)[number]) => row.push.action === "answer" && on.openInbox !== undefined;
  const canAsk = (row: (typeof repositories.rows)[number]) => row.push.action === "ask" && on.askAgain !== undefined && page.open;
  const mrLink = (row: (typeof repositories.rows)[number], label: string) =>
    row.mr === null ? null : (
      <Text accessibilityRole="link" accessibilityLabel={`Open merge request ${row.mr.short} of ${row.name}`} onPress={() => void Linking.openURL(row.mr!.url)} style={{ color: toneColor(theme, row.mr.tone) }}>
        {label}
      </Text>
    );
  if (compact) {
    return (
      <Card styles={styles} theme={theme}>
        <Text style={styles.sectionLabel}>Repositories</Text>
        {repositories.rows.map((row, index) => (
          <View key={row.workspaceId} style={{ gap: 6, marginTop: index === 0 ? 0 : 6 }}>
            <Text style={{ fontSize: 12, color: colors.foreground }}>
              <Text style={{ fontWeight: "700" }}>{row.name}</Text>
              {row.lanesLine === null ? "" : ` · ${row.lanesLine}`}
              {` · ${row.counts}`}
              {row.dirty === null ? null : (
                <>
                  {" · "}
                  <Text style={{ color: toneColor(theme, row.dirty.tone) }}>{row.dirty.text}</Text>
                </>
              )}
            </Text>
            {/* Artboard J: the branch line carries the merge request and CI; a repo with neither leaves it out. */}
            {row.mr === null && row.ci === null ? null : (
              <Text style={{ fontSize: 12, color: colors.foregroundMuted }}>
                <Text style={{ fontFamily: MONO }}>{row.shortBranch}</Text>
                {` → ${row.target}`}
                {row.mr === null ? null : (
                  <>
                    {" · "}
                    {mrLink(row, row.mr.short)}
                  </>
                )}
                {row.ci === null ? null : (
                  <>
                    {" · "}
                    <Text style={{ color: toneColor(theme, row.ci.tone) }}>{row.ci.text}</Text>
                  </>
                )}
              </Text>
            )}
            {row.push.phone === null ? null : (
              <Text style={{ fontSize: 12, color: colors.foreground }}>
                <Text style={{ color: toneColor(theme, row.push.tone) }}>{row.push.phone}</Text>
                {canRevoke(row) ? (
                  <>
                    {" · "}
                    <Text accessibilityRole="button" accessibilityLabel={`Revoke push and merge request for ${row.name}`} onPress={() => ask(row.workspaceId)} style={{ color: toneColor(theme, "info") }}>
                      Revoke
                    </Text>
                  </>
                ) : canAnswer(row) ? (
                  <>
                    {" · "}
                    <Text accessibilityRole="button" accessibilityLabel={`Answer push and merge request for ${row.name} in the Inbox`} onPress={on.openInbox} style={{ color: toneColor(theme, "info") }}>
                      Answer
                    </Text>
                  </>
                ) : canAsk(row) ? (
                  <>
                    {" · "}
                    <Text accessibilityRole="button" accessibilityLabel={`Ask me again about push and merge request for ${row.name}`} onPress={ui.busy !== null ? undefined : () => on.askAgain!(row.workspaceId)} style={{ color: toneColor(theme, "info") }}>
                      Ask me again
                    </Text>
                  </>
                ) : null}
              </Text>
            )}
            {/* Artboard R: one muted line per lane, its state in its tone; then the overlap lines. */}
            {row.lanes.map((lane) => (
              <Text key={lane.lane} style={{ fontSize: 12, color: colors.foregroundMuted }}>
                {lane.phone}
                {lane.phoneState === null ? null : (
                  <>
                    {" · "}
                    <Text style={{ color: toneColor(theme, lane.phoneState.tone) }}>{lane.phoneState.text}</Text>
                  </>
                )}
              </Text>
            ))}
            {row.overlaps.map((overlap) => (
              <Text key={overlap.lead} style={{ fontSize: 12, color: colors.foreground }}>
                <Text style={{ color: toneColor(theme, "warning") }}>■</Text>
                {` ${overlap.phone}`}
              </Text>
            ))}
            {confirmOf(row)}
          </View>
        ))}
      </Card>
    );
  }
  const muted = (value: string) => <Small tone="muted" theme={theme}>{value}</Small>;
  return (
    <Card styles={styles} theme={theme}>
      <View style={SPREAD_ROW}>
        <Text style={styles.sectionLabel}>Repositories</Text>
        <Small tone="muted" theme={theme}>{repositories.meta}</Small>
      </View>
      <View>
        <TableRow header cells={["Repository · lane", "Branch", "Work", "State", repositories.mrHeader]} flex={REPO_COLUMNS} theme={theme} />
        {repositories.rows.map((row) => (
          <View key={row.workspaceId}>
            <TableRow
              flex={REPO_COLUMNS}
              theme={theme}
              cells={[
                <Text key="name" style={{ fontSize: 13, color: colors.foreground }}>
                  <Text style={{ fontWeight: "700" }}>{row.name}</Text>
                  {row.lanesLine === null ? null : <Text style={{ fontSize: 12, color: colors.foregroundMuted }}>{` · ${row.lanesLine}`}</Text>}
                </Text>,
                <Text key="branch" style={{ fontSize: 13, color: colors.foreground }}>
                  <Text style={{ fontFamily: MONO, fontSize: 12 }}>{row.branch}</Text>
                  {" → "}
                  <Text style={{ fontFamily: MONO, fontSize: 12 }}>{row.target}</Text>
                </Text>,
                muted(row.lanes.length === 0 ? "—" : "the mission branch: lanes merge here"),
                <Text key="state" style={{ fontSize: 13, color: colors.foreground }}>
                  {row.counts}
                  {row.dirty === null ? null : (
                    <>
                      {" · "}
                      <Text style={{ color: toneColor(theme, row.dirty.tone) }}>{row.dirty.text}</Text>
                    </>
                  )}
                </Text>,
                <View key="mr" style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 6 }}>
                  <Text style={{ fontSize: 13, color: colors.foregroundMuted }}>
                    {row.mr === null ? "no merge request yet" : mrLink(row, row.mr.text)}
                    {row.ci === null ? null : (
                      <>
                        {" · "}
                        <Text style={{ color: toneColor(theme, row.ci.tone) }}>{row.ci.text}</Text>
                      </>
                    )}
                    {row.push.short === "—" ? null : (
                      <>
                        {" · "}
                        <Text style={{ fontSize: 12, color: toneColor(theme, row.push.tone) }}>{row.push.short}</Text>
                      </>
                    )}
                  </Text>
                  {canRevoke(row) ? (
                    <Button label="Revoke" kind="secondary" accessibilityLabel={`Revoke push and merge request for ${row.name}`} disabled={ui.busy !== null} onPress={() => ask(row.workspaceId)} styles={styles} style={CELL_BUTTON} textStyle={BUTTON_TEXT} />
                  ) : canAnswer(row) ? (
                    <Button label="Answer" kind="secondary" accessibilityLabel={`Answer push and merge request for ${row.name} in the Inbox`} onPress={() => on.openInbox?.()} styles={styles} style={CELL_BUTTON} textStyle={BUTTON_TEXT} />
                  ) : canAsk(row) ? (
                    <Button label="Ask me again" kind="secondary" accessibilityLabel={`Ask me again about push and merge request for ${row.name}`} disabled={ui.busy !== null} onPress={() => on.askAgain!(row.workspaceId)} styles={styles} style={CELL_BUTTON} textStyle={BUTTON_TEXT} />
                  ) : null}
                </View>,
              ]}
            />
            {confirmOf(row)}
            {row.lanes.map((lane) => (
              <TableRow
                key={lane.lane}
                flex={REPO_COLUMNS}
                theme={theme}
                cells={[
                  <Text key="lane" style={{ fontSize: 13, color: colors.foreground, ...LANE_INDENT }}>{lane.label}</Text>,
                  <Text key="branch" style={{ fontSize: 12, fontFamily: MONO, color: colors.foreground }}>{lane.branch}</Text>,
                  <LaneWork key="work" lane={lane} openAgent={on.openAgent} theme={theme} />,
                  lane.state === null ? (
                    muted(lane.note ?? "—")
                  ) : (
                    <View key="state">
                      <Text style={{ fontSize: 13, color: toneColor(theme, lane.state.tone) }}>{lane.state.text}</Text>
                      {lane.note === null ? null : <Small tone="muted" theme={theme}>{lane.note}</Small>}
                    </View>
                  ),
                  muted("—"),
                ]}
              />
            ))}
          </View>
        ))}
      </View>
      {repositories.rows.flatMap((row) => row.overlaps.map((overlap) => <OverlapLine key={`${row.workspaceId}-${overlap.lead}`} overlap={overlap} theme={theme} />))}
      <Small tone="muted" theme={theme}>
        A lane is a worktree of its own on its own branch, made from the mission branch. When its request finishes, the Worker brings the mission branch into the lane and paseo-bm moves the mission branch forward; push and merge request stay one per repository. A free lane is kept for the next piece of work; you remove worktrees when the mission closes.
      </Small>
    </Card>
  );
}

const MAIN_COLUMNS = [1.6, 0.7, 0.7, 2.6, 0.6] as const;

function MainMark({ short, theme, muted = false }: { short: string; theme: Theme; muted?: boolean }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
      <RoleMark kind="request" theme={theme} size={16} />
      <Text style={{ fontSize: 12, fontFamily: MONO, color: muted ? theme.colors.foregroundMuted : theme.colors.foreground }}>{short}</Text>
    </View>
  );
}

/** The header's Main card (mission runtime design §7, artboards G and H): each Main, when and why it changed; "Open" on a previous one. */
function MainsCard({ page, compact, on, styles, theme }: Pick<MissionPageBodyProps, "page" | "compact" | "on" | "styles" | "theme">) {
  const mains = page.mains;
  if (mains === null) return null;
  const open = (agentId: string, short: string) =>
    on.openAgent === undefined ? null : (
      <Button label="Open" kind="secondary" accessibilityLabel={`Open the previous Main ${short}`} onPress={() => on.openAgent!(agentId)} styles={styles} style={{ paddingVertical: 3, paddingHorizontal: 8 }} textStyle={BUTTON_TEXT} />
    );
  if (compact) {
    const [current, previous, ...earlier] = mains.rows;
    return (
      <Card styles={styles} theme={theme}>
        <View style={SPREAD_ROW}>
          <Text style={styles.sectionLabel}>Main</Text>
          <Small tone="muted" theme={theme}>{mains.shortCount}</Small>
        </View>
        {current === undefined ? null : <Small theme={theme}>{`${current.short} · ${current.current ? `since ${current.from}` : `${current.from}–${current.until}`} · ${current.shortWhy}`}</Small>}
        {previous === undefined ? null : (
          <Text style={{ fontSize: 12, color: theme.colors.foregroundMuted }}>
            {`${previous.short} · ${previous.from}–${previous.until} · ${previous.shortWhy}`}
            {on.openAgent === undefined ? null : (
              <Text accessibilityRole="button" accessibilityLabel={`Open the previous Main ${previous.short}`} onPress={() => on.openAgent!(previous.agentId)} style={{ color: toneColor(theme, "info") }}>
                {" · Open"}
              </Text>
            )}
          </Text>
        )}
        {earlier.length === 0 ? null : <Small tone="muted" theme={theme}>{`+ ${earlier.length} earlier`}</Small>}
      </Card>
    );
  }
  return (
    <Card styles={styles} theme={theme}>
      <View style={SPREAD_ROW}>
        <Text style={styles.sectionLabel}>Main</Text>
        <Small tone="muted" theme={theme}>{mains.count}</Small>
      </View>
      <View>
        <TableRow header cells={["Main", "From", "Until", "Why it changed", ""]} flex={MAIN_COLUMNS} theme={theme} />
        {mains.rows.map((row) => (
          <TableRow
            key={`${row.agentId}-${row.from}`}
            flex={MAIN_COLUMNS}
            theme={theme}
            cells={[
              <View key="main" style={{ flexDirection: "row", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                <MainMark short={row.short} muted={!row.current} theme={theme} />
                {row.current ? <MissionChip text={page.main.text.replace(/^Main /, "")} mark={page.main.tone} theme={theme} /> : null}
              </View>,
              <Small key="from" tone={row.current ? "plain" : "muted"} theme={theme} style={{ fontSize: 13 }}>{row.from}</Small>,
              <Small key="until" tone="muted" theme={theme} style={{ fontSize: 13 }}>{row.until}</Small>,
              <Small key="why" tone={row.current ? "plain" : "muted"} theme={theme} style={{ fontSize: 13 }}>{row.why}</Small>,
              row.current ? "" : (open(row.agentId, row.short) ?? ""),
            ]}
          />
        ))}
      </View>
      <Small tone="muted" theme={theme}>A previous Main is kept, never archived; its chat is read-only for mission work — its tools that write are refused.</Small>
    </Card>
  );
}

const FLIGHT_COLUMNS = [2.2, 1.4, 1, 1.6, 1.2] as const;

/** One line of the In flight card's lists: who at the left, the text, an "Answer" at the right when it is the owner's. */
function FlightLine({ who, children, answer, on, styles, theme }: { who: { text: string; tone: Tone }; children: ReactNode; answer: string | null; on: MissionPageActions; styles: Styles; theme: Theme }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 8, paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: theme.colors.border, borderStyle: "dashed" }}>
      <Text style={{ fontSize: 11, color: toneColor(theme, who.tone), minWidth: 84 }}>{who.text}</Text>
      <View style={{ flex: 1, minWidth: 0 }}>{children}</View>
      {answer === null || on.openInbox === undefined ? null : (
        <Button label="Answer" kind="secondary" accessibilityLabel={`Answer ${answer} in the Inbox`} onPress={on.openInbox} styles={styles} style={{ paddingVertical: 3, paddingHorizontal: 8 }} textStyle={BUTTON_TEXT} />
      )}
    </View>
  );
}

const WAITING_COLUMNS = [2.4, 2, 1, 1.8] as const;

/**
 * In flight's Waiting part (delivery line design §19.8, artboard Q): held
 * requests with what they wait for, and tells to busy Workers — steered into
 * the turn or waiting for its end — with since when and what comes then.
 */
function WaitingPart({ rows, styles, theme }: { rows: readonly WaitingRowView[]; styles: Styles; theme: Theme }) {
  const { colors } = theme;
  return (
    <>
      <Text style={[styles.sectionLabel, { marginTop: 6 }]}>Waiting</Text>
      {rows.length === 0 ? (
        <Small tone="muted" theme={theme}>Nothing waiting.</Small>
      ) : (
        <View>
          <TableRow header cells={["What", "For", "Since", "Then"]} flex={WAITING_COLUMNS} theme={theme} />
          {rows.map((row) => (
            <TableRow
              key={row.id}
              flex={WAITING_COLUMNS}
              theme={theme}
              cells={[
                <View key="what">
                  <Text style={{ fontSize: 13, color: colors.foreground }}>{row.what}</Text>
                  <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 4 }}>
                    <Small tone="muted" theme={theme}>{row.note}</Small>
                    {row.worker === null ? null : (
                      <>
                        <RoleMark kind="worker" theme={theme} size={14} />
                        <Small tone="muted" theme={theme}>{row.worker}</Small>
                      </>
                    )}
                  </View>
                </View>,
                <View key="for">
                  {row.after === null ? null : (
                    <Text style={{ fontSize: 13, color: colors.foreground }}>
                      {"after "}
                      {row.after.map((entry, index) => (
                        <Text key={entry.request}>
                          {index === 0 ? "" : ", "}
                          <Text style={{ fontFamily: MONO, fontSize: 12 }}>{entry.request}</Text>
                          {entry.topic === null ? "" : ` (${entry.topic})`}
                        </Text>
                      ))}
                    </Text>
                  )}
                  {row.status === null ? null : <Text style={{ fontSize: row.after === null ? 13 : 12, color: toneColor(theme, row.status.tone) }}>{row.status.text}</Text>}
                </View>,
                <Small key="since" theme={theme}>{row.since}</Small>,
                <Small key="then" tone={row.then.tone} theme={theme}>{row.then.text}</Small>,
              ]}
            />
          ))}
        </View>
      )}
      <Small tone="muted" theme={theme}>
        Your own words reach a busy Worker at once, inside its turn. Other messages wait for its turn to end. Work that depends on another request waits here and starts by itself when that request finishes.
      </Small>
    </>
  );
}

/** The In flight card (mission runtime design §7, artboards G and H; its lanes and Waiting part, delivery line design §19.8, artboards Q and R): what the Main knows — requests and whom they wait on, open questions, the Main's asks, live links. */
function InFlightCard({ page, compact, on, styles, theme }: Pick<MissionPageBodyProps, "page" | "compact" | "on" | "styles" | "theme">) {
  const flight = page.inFlight;
  if (flight === null) return null;
  const { colors } = theme;
  const text = (value: string, muted = false) => <Text style={{ fontSize: 13, color: muted ? colors.foregroundMuted : colors.foreground }}>{value}</Text>;
  if (compact) {
    const active = flight.requests.filter((request) => request.active);
    const yours = flight.questions.filter((question) => question.yours);
    const answer = (what: string) =>
      on.openInbox === undefined ? null : (
        <Text accessibilityRole="button" accessibilityLabel={`Answer ${what} in the Inbox`} onPress={on.openInbox} style={{ color: toneColor(theme, "info") }}>
          {" Answer"}
        </Text>
      );
    const firstLink = flight.links[0];
    return (
      <Card styles={styles} theme={theme}>
        <Text style={styles.sectionLabel}>In flight</Text>
        {flight.requests.length === 0 ? <Small tone="muted" theme={theme}>Nothing in flight.</Small> : null}
        {active.map((request) => (
          <View key={request.requestId}>
            <Text style={{ fontSize: 12, color: colors.foreground }}>
              <Text style={{ fontWeight: "700" }}>{request.topic}</Text>
              {/* Delivery line design §19.8 (artboard R): its repository and lane. */}
              {request.phoneRepo === null ? " · " : ` · ${request.phoneRepo} · `}
              <Text style={{ color: toneColor(theme, request.state.tone) }}>{request.phoneState}</Text>
            </Text>
            {/* Delivery line design §2.7 (artboard J): the request it continues. */}
            {request.phoneChain === null ? null : <Small tone="muted" theme={theme}>{request.phoneChain}</Small>}
          </View>
        ))}
        {flight.restLine === null ? null : <Small tone="muted" theme={theme}>{flight.restLine}</Small>}
        {/* Delivery line design §19.8 (artboard R): what waits, one line each. */}
        {flight.waiting === null || flight.waiting.length === 0 ? null : (
          <>
            <Text style={[styles.sectionLabel, { marginTop: 4 }]}>Waiting</Text>
            {flight.waiting.map((row) => (
              <Text key={row.id} style={{ fontSize: 12, color: colors.foreground }}>
                {row.phone.bold ? <Text style={{ fontWeight: "700" }}>{row.phone.lead}</Text> : row.phone.lead}
                {row.phone.rest}
                {row.phone.status === null ? null : (
                  <>
                    {" · "}
                    <Text style={{ color: toneColor(theme, row.phone.status.tone) }}>{row.phone.status.text}</Text>
                  </>
                )}
                {row.phone.age === null ? null : ` · ${row.phone.age}`}
              </Text>
            ))}
          </>
        )}
        {yours.map((question) => (
          <Text key={question.id} style={{ fontSize: 12, color: colors.foreground, marginTop: 4 }}>
            <Text style={{ color: toneColor(theme, "warning") }}>You decide:</Text>
            {` ${question.label} · ${question.question}`}
            {answer(question.label)}
          </Text>
        ))}
        {flight.asks.map((ask) => (
          <Text key={ask.id} style={{ fontSize: 12, color: colors.foreground }}>
            <Text style={{ color: toneColor(theme, "warning") }}>The Main asked you:</Text>
            {` ${ask.text}`}
            {answer(ask.id)}
          </Text>
        ))}
        {firstLink === undefined ? null : <Small tone="muted" theme={theme}>{flight.links.length === 1 ? `1 link ${firstLink.who}` : `${flight.links.length} links`}</Small>}
      </Card>
    );
  }
  return (
    <Card styles={styles} theme={theme}>
      <View style={SPREAD_ROW}>
        <Text style={styles.sectionLabel}>In flight</Text>
        <Small tone="muted" theme={theme}>{flight.meta}</Small>
      </View>
      {flight.requests.length === 0 ? (
        <Small tone="muted" theme={theme}>Nothing in flight.</Small>
      ) : (
        <View>
          <TableRow header cells={["Request · topic", flight.repoHeader, "Worker", "State", "Last report"]} flex={FLIGHT_COLUMNS} theme={theme} />
          {flight.requests.map((request) => (
            <TableRow
              key={request.requestId}
              flex={FLIGHT_COLUMNS}
              theme={theme}
              cells={[
                <View key="request">
                  <Text style={{ fontSize: 13, color: request.active ? colors.foreground : colors.foregroundMuted }}>
                    <Text style={{ fontFamily: MONO, fontSize: 12 }}>{request.request}</Text>
                    {` ${request.topic}`}
                  </Text>
                  {/* Delivery line design §2.7 (artboard I): the request it continues, and its place in the chain. */}
                  {request.chain === null ? null : (
                    <Small tone="muted" theme={theme}>
                      {"continues "}
                      <Text style={{ fontFamily: MONO }}>{request.chain.request}</Text>
                      {request.chain.position === null ? null : ` · ${request.chain.position}`}
                    </Small>
                  )}
                </View>,
                text(request.repo, !request.active),
                <WorkerCell key="worker" worker={request.worker} workerId={request.workerId} more={request.moreWorkers} openAgent={on.openAgent} theme={theme} />,
                <Text key="state" style={{ fontSize: 13, color: toneColor(theme, request.state.tone) }}>
                  {request.state.text}
                  {request.next === null ? null : <Text style={{ color: colors.foregroundMuted }}>{` ${request.next}`}</Text>}
                </Text>,
                <Small key="report" tone="muted" theme={theme}>
                  {/* Delivery line design §4.6 (artboard I): the commit in mono. */}
                  {request.commit === null ? (
                    request.lastReport
                  ) : (
                    <>
                      {request.lastReport.slice(0, request.lastReport.indexOf(request.commit))}
                      <Text style={{ fontFamily: MONO }}>{request.commit}</Text>
                      {request.lastReport.slice(request.lastReport.indexOf(request.commit) + request.commit.length)}
                    </>
                  )}
                </Small>,
              ]}
            />
          ))}
        </View>
      )}
      {flight.waiting === null ? null : <WaitingPart rows={flight.waiting} styles={styles} theme={theme} />}
      <Grid gap={12}>
        {[
          <View key="questions">
            <Small tone="muted" theme={theme}>Questions</Small>
            {flight.questions.length === 0 ? <Small tone="muted" theme={theme}>No open question.</Small> : null}
            {flight.questions.map((question) => (
              <FlightLine key={question.id} who={question.who} answer={question.yours ? question.label : null} on={on} styles={styles} theme={theme}>
                <Text style={{ fontSize: 13, color: colors.foreground }}>
                  <Text style={{ fontWeight: "700" }}>{question.label}</Text>
                  {question.request === null ? null : (
                    <>
                      {" of "}
                      <Text style={{ fontFamily: MONO, fontSize: 12 }}>{question.request}</Text>
                    </>
                  )}
                  {` · ${question.text}`}
                  {question.meta === "" ? null : <Text style={{ color: colors.foregroundMuted }}>{` · ${question.meta}`}</Text>}
                </Text>
              </FlightLine>
            ))}
          </View>,
          <View key="asks">
            <Small tone="muted" theme={theme}>The Main asked you</Small>
            {flight.asks.length === 0 ? <Small tone="muted" theme={theme}>Nothing open.</Small> : null}
            {flight.asks.map((ask) => (
              <FlightLine key={ask.id} who={{ text: "open", tone: "warning" }} answer={ask.id} on={on} styles={styles} theme={theme}>
                <Text style={{ fontSize: 13, color: colors.foreground }}>
                  {ask.text}
                  <Text style={{ color: colors.foregroundMuted }}>{` · ${ask.meta}`}</Text>
                </Text>
              </FlightLine>
            ))}
            <Small tone="muted" theme={theme} style={{ marginTop: 8 }}>Links</Small>
            {flight.links.length === 0 ? <Small tone="muted" theme={theme}>No live link.</Small> : null}
            {flight.links.map((link) => (
              <FlightLine key={link.id} who={{ text: link.who, tone: "muted" }} answer={null} on={on} styles={styles} theme={theme}>
                {text(link.text)}
              </FlightLine>
            ))}
          </View>,
        ]}
      </Grid>
    </Card>
  );
}

const CONTRACT_COLUMNS = [1.7, 1.7, 1] as const;

function ContractsCard({ page, compact, styles, theme }: Pick<MissionPageBodyProps, "page" | "compact" | "styles" | "theme">) {
  return (
    <Card styles={styles} theme={theme}>
      <Text style={styles.sectionLabel}>Contracts between repositories</Text>
      {page.contracts.length === 0 ? (
        <Small tone="muted" theme={theme}>No contracts yet.</Small>
      ) : compact ? (
        page.contracts.map((contract) => (
          <View key={contract.id} style={{ gap: 2 }}>
            <Text style={{ fontSize: 13, color: theme.colors.foreground }}>{contract.title}</Text>
            <Small tone="muted" theme={theme}>{`${contract.parties} · ${contract.version}`}</Small>
          </View>
        ))
      ) : (
        <View>
          <TableRow header cells={["Contract", "Provider → consumers", "Version"]} flex={CONTRACT_COLUMNS} theme={theme} />
          {page.contracts.map((contract) => (
            <TableRow key={contract.id} cells={[contract.title, contract.parties, contract.version]} flex={CONTRACT_COLUMNS} theme={theme} />
          ))}
        </View>
      )}
    </Card>
  );
}

function JournalCard({ page, compact, styles, theme }: Pick<MissionPageBodyProps, "page" | "compact" | "styles" | "theme">) {
  const { colors } = theme;
  const lines = page.journal.slice(0, compact ? JOURNAL_PHONE : JOURNAL_DESKTOP);
  return (
    <Card styles={styles} theme={theme}>
      <Text style={styles.sectionLabel}>Journal</Text>
      {lines.length === 0 ? <Small tone="muted" theme={theme}>Nothing recorded yet.</Small> : null}
      <View>
        {lines.map((line, index) => (
          <Text key={index} style={{ fontSize: 12, color: colors.foregroundMuted, paddingVertical: 3, borderBottomWidth: 1, borderBottomColor: colors.border, borderStyle: "dashed" }}>
            <Text style={{ color: colors.foreground, fontWeight: "500" }}>{line.time}</Text>
            {` ${line.text}`}
          </Text>
        ))}
      </View>
    </Card>
  );
}

function PlanCard({ page, styles, theme }: Pick<MissionPageBodyProps, "page" | "styles" | "theme">) {
  return (
    <Card styles={styles} theme={theme}>
      <View style={{ ...SPREAD_ROW, flexWrap: "wrap" }}>
        <Text style={styles.sectionLabel}>Plan</Text>
        <Small tone="muted" theme={theme}>{page.plan.meta}</Small>
      </View>
      <Small theme={theme}>{page.plan.text}</Small>
    </Card>
  );
}

/** A mission's page: the artboard B on a wide screen, D on a phone (a chip's part shown in place). */
export function MissionPageBody(props: MissionPageBodyProps) {
  const { page, ui, compact, on, styles, theme, status } = props;
  const gap = compact ? 8 : 12;
  if (compact && ui.part !== null) {
    return (
      <View style={{ gap }}>
        <BackLink text={`‹ ${page.code}`} a11y={`Back to ${page.code}`} onPress={() => on.ui({ part: null })} theme={theme} size={12} />
        {ui.part === "contracts" ? <ContractsCard {...props} /> : ui.part === "journal" ? <JournalCard {...props} /> : <PlanCard {...props} />}
      </View>
    );
  }
  const stats = page.stats.map((stat) => (
    <StatBox key={stat.label} label={compact ? stat.short : stat.label} value={compact ? stat.shortValue : stat.value} hint={compact ? null : stat.hint} tone={stat.tone} compact={compact} theme={theme} />
  ));
  if (compact) {
    const firstRepo = page.charter.repos[0];
    return (
      <View style={{ gap }}>
        <PageHeader {...props} />
        {status}
        <PageForms {...props} />
        <MainsCard {...props} />
        <Grid gap={10}>{stats}</Grid>
        <RepositoriesCard {...props} />
        <InFlightCard {...props} />
        <CharterCard {...props} />
        <Card styles={styles} theme={theme}>
          <Text style={styles.sectionLabel}>Governor</Text>
          {page.phoneGovernor.map((entry) => (
            <ToneLine key={entry.label} {...entry} theme={theme} />
          ))}
        </Card>
        <WorkersCard {...props} />
        <LevelCard {...props} />
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
          <MissionChip text={`Contracts · ${page.contracts.length}`} onPress={() => on.ui({ part: "contracts" })} a11y="Contracts between repositories" theme={theme} />
          <MissionChip text="Journal" onPress={() => on.ui({ part: "journal" })} theme={theme} />
          <MissionChip text="Plan" onPress={() => on.ui({ part: "plan" })} theme={theme} />
          {firstRepo === undefined ? null : <MissionChip text="Project memory" onPress={() => on.memory(firstRepo.workspaceId)} theme={theme} />}
        </View>
      </View>
    );
  }
  return (
    <View style={{ gap }}>
      <PageHeader {...props} />
      {status}
      <PageForms {...props} />
      <MainsCard {...props} />
      <Grid gap={10}>{stats}</Grid>
      <Grid gap={12}>
        {[<CharterCard key="charter" {...props} />, <LevelCard key="level" {...props} />]}
      </Grid>
      <WorkersCard {...props} />
      <RepositoriesCard {...props} />
      <InFlightCard {...props} />
      <Grid gap={12}>
        {[<ContractsCard key="contracts" {...props} />, <JournalCard key="journal" {...props} />]}
      </Grid>
      <PlanCard {...props} />
    </View>
  );
}

// ---------------------------------------------------------------------------
// New mission (artboard E). Hook-free.
// ---------------------------------------------------------------------------

export interface NewMissionFormProps {
  draft: MissionDraft;
  /** Shown once the owner pressed Create. */
  errors: readonly string[];
  projects: readonly MissionProject[];
  /** "Find a project…" as typed. */
  filter: string;
  onFilter: (filter: string) => void;
  /** Level 3 or 4 chosen and waiting for its confirmation: Create waits for it too. */
  confirming: MissionLevel | null;
  busy: boolean;
  error: string | null;
  onDraft: (draft: MissionDraft) => void;
  onLevel: (level: MissionLevel) => void;
  onConfirmLevel: () => void;
  onCancelLevel: () => void;
  onCancel: () => void;
  onCreate: () => void;
  compact: boolean;
  styles: Styles;
  theme: Theme;
}

export function NewMissionForm({ draft, errors, projects, filter, onFilter, confirming, busy, error, onDraft, onLevel, onConfirmLevel, onCancelLevel, onCancel, onCreate, compact, styles, theme }: NewMissionFormProps) {
  const { colors } = theme;
  const picker = projectPickerOf({ projects, chosen: draft.repos, filter, compact, empty: "No project is listed yet." });
  return (
    <View style={{ gap: compact ? 8 : 12 }}>
      <Text accessibilityRole="header" style={{ fontSize: compact ? 18 : 20, fontWeight: "600", color: colors.foreground }}>
        New mission
      </Text>
      <View style={FIELD_ROW}>
        <Field label="Name" value={draft.name} onChange={(name) => onDraft({ ...draft, name })} a11y="Mission name" editable={!busy} theme={theme} style={{ flex: 3 }} />
        <Field label="Short code" value={draft.code} onChange={(code) => onDraft({ ...draft, code: codeAsTyped(code) })} a11y="Short code" mono editable={!busy} theme={theme} style={{ flex: 1 }} />
      </View>
      <Field label="Goal (the Main can draft the rest of the charter with you)" value={draft.goal} onChange={(goal) => onDraft({ ...draft, goal })} a11y="Goal" multiline editable={!busy} theme={theme} />
      {/* The projects (`mission-projects.html`, artboards L and M): one row per Paseo project, named as its sidebar names it. */}
      <View>
        <View style={SPREAD_ROW}>
          <Small tone="muted" theme={theme}>{picker.header}</Small>
          <Small tone="info" theme={theme}>{picker.chosen}</Small>
        </View>
        {picker.filterShown ? <ProjectFilter value={filter} onChange={onFilter} editable={!busy} theme={theme} style={{ marginVertical: 6 }} /> : <View style={{ height: 6 }} />}
        <ProjectRows view={picker} onToggle={(id) => onDraft(toggleRepo(draft, id))} disabled={busy} theme={theme} />
        {picker.more === null ? null : <Small tone="muted" theme={theme} style={{ marginTop: 4 }}>{picker.more}</Small>}
        <Small tone="muted" theme={theme} style={{ marginTop: compact ? 4 : 6 }}>{PROJECTS_FOOTNOTE}</Small>
      </View>
      <View style={{ gap: 4 }}>
        <Small tone="muted" theme={theme}>Mission level</Small>
        <LevelCells level={draft.level} onSelect={onLevel} disabled={busy} theme={theme} />
        <Small tone="muted" theme={theme}>{levelSentenceOf(draft.level)}</Small>
        {confirming === null ? null : <ConfirmBlock dialog={levelConfirmDialog(confirming, null)} busy={false} busyLabel="" onConfirm={onConfirmLevel} onCancel={onCancelLevel} styles={styles} theme={theme} />}
      </View>
      {errors.map((line) => (
        <ToneText key={line} tone="danger" styles={styles} theme={theme}>{line}</ToneText>
      ))}
      {error === null ? null : <ToneText tone="danger" styles={styles} theme={theme}>{error}</ToneText>}
      <View style={FORM_ACTIONS}>
        <Button label="Cancel" kind="secondary" disabled={busy} onPress={onCancel} styles={styles} textStyle={BUTTON_TEXT} />
        <Button label={busy ? "Creating…" : "Create and open Main"} kind="primary" accessibilityState={{ disabled: busy || confirming !== null, busy }} disabled={busy || confirming !== null} onPress={onCreate} styles={styles} textStyle={BUTTON_TEXT} />
      </View>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Project memory (artboard F).
// ---------------------------------------------------------------------------

const MEMORY_COLUMNS = [0.9, 3, 1.4] as const;

/** One project's memory, hook-free: the title, the count, a row per entry. */
export function MemoryTable({ view, compact, theme }: { view: MemoryView; compact: boolean; theme: Theme }) {
  const { colors } = theme;
  return (
    <View style={{ gap: compact ? 8 : 12 }}>
      <View style={SPREAD_ROW}>
        <Text accessibilityRole="header" style={{ fontSize: compact ? 18 : 20, fontWeight: "600", color: colors.foreground, flexShrink: 1 }}>
          {view.title}
        </Text>
        <Small tone="muted" theme={theme}>{view.count}</Small>
      </View>
      {view.rows.length === 0 ? (
        <Text style={{ fontSize: 14, color: colors.foregroundMuted }}>Nothing in this project's memory yet.</Text>
      ) : (
        <View>
          <TableRow header cells={["Kind", "Entry", "Source"]} flex={MEMORY_COLUMNS} theme={theme} />
          {view.rows.map((row) => (
            <TableRow
              key={row.id}
              flex={MEMORY_COLUMNS}
              theme={theme}
              cells={[
                <View key="kind" style={{ flexDirection: "row" }}>
                  <MissionChip text={row.kind} theme={theme} />
                </View>,
                row.text,
                <Small key="source" tone="muted" theme={theme}>{row.source}</Small>,
              ]}
            />
          ))}
        </View>
      )}
    </View>
  );
}

/**
 * A project's memory, read from `memory.list` (artboard F): from a mission's
 * page (its repositories as chips to switch between) or a project's page.
 */
export function ProjectMemory({ workspaceId, repos = [], onRepo, onBack, backLabel, compact, theme }: { workspaceId: string; repos?: ReadonlyArray<{ workspaceId: string; name: string }>; onRepo?: (workspaceId: string) => void; onBack: () => void; backLabel: string; compact: boolean; theme: Theme }) {
  const read = useRpc(memoryListRpc);
  const styles = useMemo(() => dashboardStyles(theme, compact), [theme, compact]);
  const memory = useQuery({ queryKey: MISSIONS_QUERY_KEYS.memory(workspaceId), queryFn: () => read({ workspaceId }), refetchInterval: WORK_POLL_MS });
  return (
    <View style={{ gap: compact ? 8 : 12 }}>
      <BackLink text={backLabel} a11y={`Back to ${backLabel.replace(/^‹\s*/, "")}`} onPress={onBack} theme={theme} size={compact ? 12 : 14} />
      {repos.length > 1 && onRepo !== undefined ? (
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
          {repos.map((repo) => (
            <MissionChip key={repo.workspaceId} text={repo.name} mark={repo.workspaceId === workspaceId ? "info" : null} muted={repo.workspaceId !== workspaceId} onPress={() => onRepo(repo.workspaceId)} a11y={`${repo.name}'s memory`} theme={theme} />
          ))}
        </View>
      ) : null}
      {memory.isError ? <ToneText tone="danger" styles={styles} theme={theme}>{`Could not read the memory: ${errorMessageOf(memory.error)}`}</ToneText> : null}
      {memory.data === undefined ? (
        memory.isError ? null : <Text style={{ fontSize: 14, color: theme.colors.foregroundMuted }}>Loading…</Text>
      ) : (
        <MemoryTable view={memoryViewOf(memory.data)} compact={compact} theme={theme} />
      )}
    </View>
  );
}

// ---------------------------------------------------------------------------
// The screen.
// ---------------------------------------------------------------------------

type Place =
  | { view: "list" }
  | { view: "page"; missionId: string }
  | { view: "new" }
  | { view: "memory"; workspaceId: string; repos: ReadonlyArray<{ workspaceId: string; name: string }>; back: { view: "page"; missionId: string; code: string } };

/** The New mission form: the draft, whether Create was pressed, a level 3 or 4 waiting for its confirmation, the call. */
interface NewForm {
  draft: MissionDraft;
  tried: boolean;
  confirming: MissionLevel | null;
  creating: boolean;
  error: string | null;
  /** "Find a project…" as typed. */
  filter: string;
}

/** How New mission opens, again after Cancel and after a mission is made. */
const NEW_FORM_IDLE: NewForm = { draft: EMPTY_MISSION_DRAFT, tried: false, confirming: null, creating: false, error: null, filter: "" };

export interface MissionsScreenProps extends PluginSurfaceProps {
  /** The listed projects (`missionProjectsOf`: one per Paseo project, plugin homes left out), for New mission and "+ Add". */
  projects: readonly MissionProject[];
  /** Every listed workspace's project and its name, which names a mission's repositories. */
  repoIndex?: ProjectIndex;
  /** The surface's status strip. */
  status?: ReactNode;
  /** Opens the Inbox, where the In flight card's "Answer" leads (mission runtime design §7). */
  onOpenInbox?: () => void;
}

/** The Missions section: the list, a mission's page, New mission, a project's memory. */
export function MissionsScreen({ theme, layout, navigation, projects, repoIndex, status, onOpenInbox }: MissionsScreenProps) {
  const compact = layout.compact;
  const styles = useMemo(() => dashboardStyles(theme, compact), [theme, compact]);
  const queryClient = useQueryClient();
  const listMissions = useRpc(missionsListRpc);
  const getMission = useRpc(missionGetRpc);
  const changeMission = useRpc(missionChangeRpc);
  const ensureMission = useRpc(missionEnsureRpc);
  const createMission = useRpc(missionsCreateRpc);
  const setMissionLevel = useRpc(autonomySetMissionLevelRpc);
  const revokeIntegration = useRpc(missionIntegrationRevokeRpc);
  const askIntegration = useRpc(missionIntegrationAskRpc);
  const openAgent = navigation?.openAgent;
  const paseo = usePaseo();

  const [place, setPlace] = useState<Place>({ view: "list" });
  const [closedShown, setClosedShown] = useState(false);
  const [ui, setUi] = useState<PageUi>(PAGE_UI_IDLE);
  const [form, setForm] = useState<NewForm>(NEW_FORM_IDLE);
  // ADR-034 decision 4: the Command Center's "New mission" opens the form, so the mission is named before its Main exists.
  useEffect(() => {
    const run = () => {
      if (newMissionRequests.take() === null) return;
      setForm(NEW_FORM_IDLE);
      setPlace({ view: "new" });
    };
    run();
    return newMissionRequests.subscribe(run);
  }, []);

  const list = useQuery({ queryKey: MISSIONS_QUERY_KEYS.list, queryFn: () => listMissions({}), ...pollWhile(place.view === "list") });
  const missionId = place.view === "page" ? place.missionId : "";
  const page = useQuery({ queryKey: MISSIONS_QUERY_KEYS.page(missionId), queryFn: () => getMission({ missionId }), ...pollWhile(place.view === "page") });

  // A repository by its project's name, as Paseo's sidebar names it (`mission-projects.html`).
  const nameOf: NameOf = (id) => repoIndex?.get(id)?.name ?? projects.find((project) => project.id === id)?.name ?? null;
  /** The chosen projects' workspace ids: a project with no workspace at its folder gets one opened there. */
  const workspacesOf = async (ids: readonly string[]): Promise<string[]> => {
    const opened = await workspaceIdsOf(ids, projects, (cwd) => paseo.workspaces.open({ cwd }));
    if (opened.some((id, index) => id !== ids[index])) void queryClient.invalidateQueries({ queryKey: ["paseo-bm", "launcher", "workspaces"] });
    return opened;
  };
  const now = new Date();
  const openPage = (id: string, start: Partial<PageUi> = {}) => {
    setUi({ ...PAGE_UI_IDLE, ...start });
    setPlace({ view: "page", missionId: id });
  };
  const refresh = (id: string) => {
    void queryClient.invalidateQueries({ queryKey: MISSIONS_QUERY_KEYS.list });
    void queryClient.invalidateQueries({ queryKey: MISSIONS_QUERY_KEYS.page(id) });
  };
  const patch = (change: Partial<PageUi>) => setUi((current) => ({ ...current, ...change }));
  /** One call of the page: busy while it runs, then `done` (from its result) and a refresh, or its failure as one line. */
  const run = <T,>(busy: string, failed: string, call: () => Promise<T>, done: Partial<PageUi> | ((result: T) => Partial<PageUi>) = {}) => {
    patch({ busy, error: null, notice: null });
    call().then(
      (result) => {
        patch({ busy: null, ...(typeof done === "function" ? done(result) : done) });
        refresh(missionId);
      },
      (error: unknown) => patch({ busy: null, error: `${failed}: ${errorMessageOf(error)}` }),
    );
  };
  const opened = (agentId: string, code: string): string | null => {
    if (openAgent !== undefined) {
      openAgent({ agentId });
      return null;
    }
    return `The Main of ${code} is ${agentId.slice(0, 7)}; this host cannot open it from here — open it from the agents list.`;
  };

  let body: ReactNode;
  if (place.view === "new") {
    const { draft } = form;
    const errors = missionDraftErrors(draft);
    const create = () => {
      if (errors.length > 0) {
        setForm({ ...form, tried: true });
        return;
      }
      setForm({ ...form, tried: true, creating: true, error: null });
      void (async () => {
        try {
          const created = await createMission({ ...createInputOf(draft), repos: await workspacesOf(draft.repos) });
          const id = created.missionId;
          if (id === null) throw new Error("the server made no mission of this name and code");
          const notices: string[] = [created.toolsNotice, created.setupNotice].filter((line): line is string => typeof line === "string" && line !== "");
          let error: string | null = null;
          if (draft.level !== EMPTY_MISSION_DRAFT.level) {
            try {
              await setMissionLevel({ missionId: id, level: draft.level, ...(levelNeedsConfirmation(draft.level) ? { confirmed: true } : {}) });
            } catch (failure) {
              error = `The mission was created, but its level could not be set: ${errorMessageOf(failure)}`;
            }
          }
          void queryClient.invalidateQueries({ queryKey: MISSIONS_QUERY_KEYS.list });
          const notice = opened(created.agentId, draft.code);
          setForm(NEW_FORM_IDLE);
          openPage(id, { error, notice: [notice, ...notices].filter((line) => line !== null).join(" ") || null });
        } catch (failure) {
          setForm((current) => ({ ...current, creating: false, error: `Could not create the mission: ${errorMessageOf(failure)}` }));
        }
      })();
    };
    body = (
      <NewMissionForm
        draft={draft}
        errors={form.tried ? errors : []}
        projects={projects}
        filter={form.filter}
        onFilter={(filter) => setForm({ ...form, filter })}
        confirming={form.confirming}
        busy={form.creating}
        error={form.error}
        onDraft={(next) => setForm({ ...form, draft: next })}
        onLevel={(level) =>
          setForm(levelNeedsConfirmation(level) && level !== draft.level ? { ...form, confirming: level } : { ...form, confirming: null, draft: { ...draft, level } })
        }
        onConfirmLevel={() => setForm({ ...form, confirming: null, draft: form.confirming === null ? draft : { ...draft, level: form.confirming } })}
        onCancelLevel={() => setForm({ ...form, confirming: null })}
        onCancel={() => {
          setForm(NEW_FORM_IDLE);
          setPlace({ view: "list" });
        }}
        onCreate={create}
        compact={compact}
        styles={styles}
        theme={theme}
      />
    );
  } else if (place.view === "memory") {
    const back = place.back;
    body = (
      <ProjectMemory
        workspaceId={place.workspaceId}
        repos={place.repos}
        onRepo={(workspaceId) => setPlace({ ...place, workspaceId })}
        onBack={() => setPlace({ view: "page", missionId: back.missionId })}
        backLabel={`‹ ${back.code}`}
        compact={compact}
        theme={theme}
      />
    );
  } else if (place.view === "page") {
    if (page.data === undefined) {
      body = (
        <View style={{ gap: 8 }}>
          <BackLink text="Missions ›" a11y="Back to Missions" onPress={() => setPlace({ view: "list" })} theme={theme} />
          {page.isError ? <ToneText tone="danger" styles={styles} theme={theme}>{`Could not read the mission: ${errorMessageOf(page.error)}`}</ToneText> : <Text style={styles.body}>Loading…</Text>}
        </View>
      );
    } else {
      const view = missionPageOf(page.data, now, nameOf);
      const current = { name: view.name, code: view.code };
      const change = (input: MissionChangeInput) => () => changeMission(input);
      body = (
        <MissionPageBody
          page={view}
          ui={ui}
          addable={addableReposOf(projects, view.charter.repos, (id) => repoIndex?.get(id)?.projectId ?? null)}
          compact={compact}
          status={status}
          styles={styles}
          theme={theme}
          on={{
            back: () => setPlace({ view: "list" }),
            ui: patch,
            openMain: () =>
              run("Opening…", "Could not open the Main", () => ensureMission({ missionId: view.missionId }), (result) => ({ notice: opened(result.agentId, view.code) ?? result.toolsNotice ?? null })),
            saveRename: () => {
              const input = ui.rename === null ? null : renameInputOf(view.missionId, current, ui.rename.name, ui.rename.code);
              if (input === null) patch({ rename: null });
              else run("Saving…", "Could not rename the mission", change(input), { rename: null });
            },
            close: () => run("Closing…", "Could not close the mission", change({ missionId: view.missionId, close: true }), { confirm: null }),
            addRepos: (ids) =>
              run("Adding…", "Could not add the repository", async () => changeMission({ missionId: view.missionId, addRepos: await workspacesOf(ids) }), { adding: false, addChosen: [], addFilter: "" }),
            level: (level) => {
              if (level === view.level.level) return;
              if (levelNeedsConfirmation(level)) patch({ confirm: { kind: "level", level }, rename: null });
              else run("Saving…", "Could not set the mission level", () => setMissionLevel({ missionId: view.missionId, level }), { confirm: null });
            },
            confirmLevel: () => {
              const pending = ui.confirm?.kind === "level" ? ui.confirm.level : null;
              if (pending !== null) run("Saving…", "Could not set the mission level", () => setMissionLevel({ missionId: view.missionId, level: pending, confirmed: true }), { confirm: null });
            },
            memory: (workspaceId) => setPlace({ view: "memory", workspaceId, repos: view.charter.repos, back: { view: "page", missionId: view.missionId, code: view.code } }),
            revoke: (repo) => run("Revoking…", "Could not revoke push and merge request", () => revokeIntegration({ missionId: view.missionId, repo }), { confirm: null }),
            askAgain: (repo) => run("Asking…", "Could not ask again", () => askIntegration({ missionId: view.missionId, repo })),
            ...(openAgent === undefined ? {} : { openAgent: (agentId: string) => openAgent({ agentId }) }),
            ...(onOpenInbox === undefined ? {} : { openInbox: onOpenInbox }),
          }}
        />
      );
    }
  } else {
    body = (
      <MissionList
        list={list.data === undefined ? null : missionListOf(list.data.missions, now, nameOf)}
        error={list.isError ? errorMessageOf(list.error) : null}
        compact={compact}
        closedShown={closedShown}
        onToggleClosed={() => setClosedShown(!closedShown)}
        onOpen={(id) => openPage(id)}
        onNew={() => {
          setForm(NEW_FORM_IDLE);
          setPlace({ view: "new" });
        }}
        status={status}
        styles={styles}
        theme={theme}
      />
    );
  }
  // The artboards' widths: 1040 for the list and a page, 640 for New mission and a project's memory.
  const width = place.view === "new" || place.view === "memory" ? 592 : 992;
  return (
    <ScrollView style={{ flex: 1, backgroundColor: theme.colors.surface0 }} contentContainerStyle={{ padding: compact ? 12 : 24 }}>
      <View style={{ width: "100%", maxWidth: width }}>{body}</View>
    </ScrollView>
  );
}
