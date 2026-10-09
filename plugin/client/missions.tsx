/**
 * The Missions section (missions design §10; the approved mockup
 * `docs/design/mockups/missions-screen.html`, artboards A–F): one screen,
 * four views — the list (A, C), a mission's page (B, D), New mission (E) and
 * a project's memory (F). What each shows is `missions-model.ts`; this file
 * reads `missions.list`, `mission.get` and `memory.list` every
 * `WORK_POLL_MS` while the view shows, and sends the owner's changes:
 * `mission.change` (Rename, Close mission, "+ Add"), `autonomy.set-mission-level`
 * (the level cells; 3 and 4 confirmed in place), `mission.ensure` (Open Main)
 * and `missions.create` (New mission).
 *
 * A phone (`layout.compact`) shows the artboards' phone layout: the page's
 * chips (Contracts, Journal, Plan, Project memory) open each part in place,
 * and "⋯" holds Rename and Close mission.
 *
 * Client rules: React Native primitives only, colours from the theme, no
 * modal (confirmations are `ConfirmBlock`s in place), accessibility roles and
 * labels on every pressable.
 */
import { type PluginSurfaceProps, useRpc } from "@getpaseo/plugin/client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState, type ReactNode } from "react";
import { Pressable, ScrollView, Text, TextInput, View, type TextStyle, type ViewStyle } from "react-native";
import {
  autonomySetMissionLevelRpc,
  memoryListRpc,
  missionChangeRpc,
  missionEnsureRpc,
  missionGetRpc,
  missionsCreateRpc,
  missionsListRpc,
  type MissionChangeInput,
} from "../shared/contracts";
import type { MissionLevel } from "../shared/autonomy";
import { errorMessageOf } from "./errors";
import {
  CRITERIA_SHOWN,
  EMPTY_MISSION_DRAFT,
  JOURNAL_DESKTOP,
  JOURNAL_PHONE,
  MISSION_LEVELS_SHOWN,
  addableReposOf,
  closeMissionDialog,
  codeAsTyped,
  createInputOf,
  levelConfirmDialog,
  levelNeedsConfirmation,
  levelSentenceOf,
  memoryViewOf,
  missionDraftErrors,
  missionListOf,
  missionPageOf,
  nameAndCodeErrors,
  renameInputOf,
  toggleRepo,
  type MemoryView,
  type MissionCardView,
  type MissionDraft,
  type MissionPageView,
  type NameOf,
} from "./missions-model";
import { RADIUS, dashboardStyles } from "./styles";
import { MONO } from "./text-tabs";
import { toneColor, type Badge, type Tone } from "./tone";
import { Button, ConfirmBlock, KindBar, RoleMark, ToneText, type Styles, type Theme } from "./ui";
import { WORK_POLL_MS } from "./work-model";

/** A listed project, by its own name (plugin homes left out by the launcher). */
export interface MissionProject {
  id: string;
  name: string;
}

export const MISSIONS_QUERY_KEYS = {
  list: ["paseo-bm", "missions", "list"] as const,
  page: (missionId: string) => ["paseo-bm", "missions", "get", missionId] as const,
  memory: (workspaceId: string) => ["paseo-bm", "memory", workspaceId] as const,
};

function pollWhile(visible: boolean) {
  return { enabled: visible, refetchInterval: visible ? WORK_POLL_MS : (false as const) };
}

// ---------------------------------------------------------------------------
// Small pieces, as the artboards' CSS draws them.
// ---------------------------------------------------------------------------

/** The artboards' chip: 12px text on surface2, a 1px border, an optional 7px square in a tone. */
export function MissionChip({ text, mark, muted = false, onPress, a11y, theme }: { text: string; mark?: Tone | null; muted?: boolean; onPress?: () => void; a11y?: string; theme: Theme }) {
  const { colors } = theme;
  const body = (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 6, paddingVertical: 2, paddingHorizontal: 8, borderWidth: 1, borderColor: colors.border, borderRadius: RADIUS, backgroundColor: colors.surface2 }}>
      {mark === undefined || mark === null ? null : <View style={{ width: 7, height: 7, backgroundColor: toneColor(theme, mark) }} />}
      <Text style={{ fontSize: 12, color: muted ? colors.foregroundMuted : colors.foreground }}>{text}</Text>
    </View>
  );
  return onPress === undefined ? body : <Pressable accessibilityRole="button" accessibilityLabel={a11y ?? text} onPress={onPress}>{body}</Pressable>;
}

function Label({ children, theme, style }: { children: ReactNode; theme: Theme; style?: TextStyle }) {
  return <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12, fontWeight: "500", textTransform: "uppercase", letterSpacing: 0.6, ...style }}>{children}</Text>;
}

function Small({ children, tone = "plain", theme, style, mono = false }: { children: ReactNode; tone?: Tone; theme: Theme; style?: TextStyle; mono?: boolean }) {
  return <Text style={{ fontSize: 12, color: toneColor(theme, tone), ...(mono ? { fontFamily: MONO } : {}), ...style }}>{children}</Text>;
}

/** The artboards' card: surface1, 1px border, radius 2; the accent bar at its left when `bar`. It grows to its cell's height in a `Grid`. */
function Card({ children, bar = false, compact, theme, style }: { children: ReactNode; bar?: boolean; compact: boolean; theme: Theme; style?: ViewStyle }) {
  const { colors } = theme;
  return (
    <View style={{ position: "relative", flexGrow: 1, backgroundColor: colors.surface1, borderWidth: 1, borderColor: colors.border, borderRadius: RADIUS, padding: compact ? 10 : 14, gap: compact ? 6 : 8, ...style }}>
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
export function LevelCells({ level, onSelect, disabled = false, theme }: { level: MissionLevel; onSelect: (level: MissionLevel) => void; disabled?: boolean; theme: Theme }) {
  const { colors } = theme;
  return (
    <View accessibilityRole="radiogroup" style={{ flexDirection: "row", alignSelf: "flex-start", borderWidth: 1, borderColor: colors.border, borderRadius: RADIUS, overflow: "hidden" }}>
      {MISSION_LEVELS_SHOWN.map((value, index) => {
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

// ---------------------------------------------------------------------------
// The list (artboards A, C). Hook-free.
// ---------------------------------------------------------------------------

/** One mission on the list; the whole card opens its page. */
export function MissionCard({ card, compact, onOpen, theme }: { card: MissionCardView; compact: boolean; onOpen: (missionId: string) => void; theme: Theme }) {
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
        <View style={{ flexDirection: "row", alignItems: "center", gap: 10, flexShrink: 1 }}>
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
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 10, flexShrink: 1 }}>
            {code}
            {name("600")}
            <MissionChip text={card.main.text} mark={card.main.tone} theme={theme} />
          </View>
          <Small tone="muted" theme={theme}>{card.level}</Small>
        </View>
        <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 10 }}>
          {card.repos.map((repo) => (
            <MissionChip key={repo} text={repo} theme={theme} />
          ))}
          <Small tone="muted" theme={theme}>{card.counts}</Small>
        </View>
        <View style={{ flexDirection: "row", alignItems: "center" }}>
          <Progress share={card.progress} theme={theme} />
          <Small theme={theme} style={{ marginLeft: 12 }}>{card.criteria}</Small>
        </View>
        <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 10 }}>
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
      <Card bar={card.open} compact={compact} theme={theme}>
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
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
        <Text accessibilityRole="header" style={{ fontSize: compact ? 18 : 24, fontWeight: "600", color: colors.foreground }}>
          Missions
        </Text>
        <Button label={compact ? "New" : "New mission"} kind="primary" accessibilityLabel="New mission" onPress={onNew} styles={styles} style={compact ? { paddingVertical: 7, paddingHorizontal: 10 } : undefined} textStyle={{ fontSize: 13 }} />
      </View>
      {compact ? null : <Text style={{ fontSize: 14, color: colors.foregroundMuted }}>One Main per goal. A mission spans the repositories it needs; you name it, you close it.</Text>}
      {status}
      {error === null ? null : <ToneText tone="danger" styles={styles} theme={theme}>{`Could not read the missions: ${error}`}</ToneText>}
      {list === null ? (
        error === null ? <Text style={{ fontSize: 14, color: colors.foregroundMuted }}>Loading…</Text> : null
      ) : (
        <>
          {compact ? null : <Label theme={theme}>{`Open · ${list.open.length}`}</Label>}
          {list.open.length === 0 ? <Text style={{ fontSize: 14, color: colors.foregroundMuted }}>No open mission. New mission names one and opens its Main.</Text> : null}
          {list.open.map((card) => (
            <MissionCard key={card.missionId} card={card} compact={compact} onOpen={onOpen} theme={theme} />
          ))}
          {closed.length === 0 ? null : compact ? (
            <Pressable accessibilityRole="button" accessibilityLabel={closedShown ? "Hide the closed missions" : "Show the closed missions"} accessibilityState={{ expanded: closedShown }} onPress={onToggleClosed}>
              <Small tone="muted" theme={theme}>{`Closed · ${closed.length}`}</Small>
            </Pressable>
          ) : (
            <Label theme={theme}>{`Closed · ${closed.length}`}</Label>
          )}
          {compact && !closedShown ? null : closed.map((card) => <MissionCard key={card.missionId} card={card} compact={compact} onOpen={onOpen} theme={theme} />)}
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
  confirm: { kind: "close" } | { kind: "level"; level: MissionLevel } | null;
  /** What runs now ("Opening…", "Saving…"); null when nothing. */
  busy: string | null;
  error: string | null;
  notice: string | null;
}

export const PAGE_UI_IDLE: PageUi = { allCriteria: false, menu: false, part: null, rename: null, adding: false, confirm: null, busy: null, error: null, notice: null };

export interface MissionPageActions {
  back: () => void;
  openMain: () => void;
  ui: (change: Partial<PageUi>) => void;
  saveRename: () => void;
  close: () => void;
  addRepo: (workspaceId: string) => void;
  level: (level: MissionLevel) => void;
  confirmLevel: () => void;
  memory: (workspaceId: string) => void;
  openAgent?: (agentId: string) => void;
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
  const openMain = <Button label={ui.busy === "Opening…" ? "Opening…" : "Open Main"} kind="primary" accessibilityLabel={`Open the Main of ${page.code}`} accessibilityState={{ disabled: busy, busy }} disabled={busy} onPress={on.openMain} styles={styles} textStyle={{ fontSize: 13 }} style={compact ? { flex: 1 } : undefined} />;
  const rename = <Button label="Rename" kind="secondary" accessibilityLabel={`Rename ${page.code}`} disabled={busy} onPress={() => on.ui({ rename: { name: page.name, code: page.code }, menu: false, confirm: null })} styles={styles} textStyle={{ fontSize: 13 }} />;
  const close = <Button label="Close mission" kind="danger" accessibilityLabel={`Close mission ${page.code}`} disabled={busy} onPress={() => on.ui({ confirm: { kind: "close" }, menu: false, rename: null })} styles={styles} textStyle={{ fontSize: 13 }} />;
  const title = (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 10, flexShrink: 1 }}>
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
            <Button label="⋯" kind="secondary" accessibilityLabel={ui.menu ? "Hide the mission's actions" : "More actions: Rename, Close mission"} accessibilityState={{ expanded: ui.menu }} onPress={() => on.ui({ menu: !ui.menu })} styles={styles} textStyle={{ fontSize: 13 }} />
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
      <View style={{ flexDirection: "row", alignItems: "center", gap: 10, flexShrink: 1 }}>
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
          <View style={{ flexDirection: "row", gap: 12 }}>
            <Field label="Name" value={ui.rename.name} onChange={(name) => on.ui({ rename: { ...ui.rename!, name } })} a11y="Mission name" theme={theme} style={{ flex: 3 }} />
            <Field label="Short code" value={ui.rename.code} onChange={(code) => on.ui({ rename: { ...ui.rename!, code: codeAsTyped(code) } })} a11y="Short code" mono theme={theme} style={{ flex: 1 }} />
          </View>
          {errors.map((line) => (
            <ToneText key={line} tone="danger" styles={styles} theme={theme}>{line}</ToneText>
          ))}
          <View style={{ flexDirection: "row", gap: 10, justifyContent: "flex-end" }}>
            <Button label="Cancel" kind="secondary" onPress={() => on.ui({ rename: null })} styles={styles} textStyle={{ fontSize: 13 }} />
            <Button label={ui.busy === "Saving…" ? "Saving…" : "Save"} kind="primary" accessibilityLabel="Save the name and code" disabled={errors.length > 0 || ui.busy !== null} onPress={on.saveRename} styles={styles} textStyle={{ fontSize: 13 }} />
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
        <Button label="+ Add" kind="secondary" accessibilityLabel="Add a repository to the mission" accessibilityState={{ expanded: ui.adding }} onPress={() => on.ui({ adding: !ui.adding })} styles={styles} style={{ paddingVertical: 3, paddingHorizontal: 8 }} textStyle={{ fontSize: 13 }} />
      )}
    </View>
  );
  if (compact) {
    return (
      <Card compact theme={theme}>
        <Label theme={theme}>Charter</Label>
        <Small theme={theme}>{charter.goal === "" ? "No goal yet." : charter.goal}</Small>
        {repos}
      </Card>
    );
  }
  return (
    <Card compact={false} theme={theme}>
      <Label theme={theme}>{charter.label}</Label>
      <View>
        <Small tone="muted" theme={theme}>Goal</Small>
        <Text style={{ fontSize: 14, color: theme.colors.foreground }}>{charter.goal === "" ? "No goal yet." : charter.goal}</Text>
      </View>
      <View>
        <Small tone="muted" theme={theme}>Repositories</Small>
        {repos}
        {!ui.adding ? null : (
          <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 6, marginTop: 6 }}>
            {addable.length === 0 ? <Small tone="muted" theme={theme}>Every listed project is in this mission already.</Small> : null}
            {addable.map((project) => (
              <MissionChip key={project.id} text={`+ ${project.name}`} muted onPress={() => on.addRepo(project.id)} a11y={`Add ${project.name} to the mission`} theme={theme} />
            ))}
          </View>
        )}
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
      <Card compact theme={theme}>
        <Label theme={theme}>Mission level</Label>
        {cells}
        <Small tone="muted" theme={theme}>{page.level.sentence}</Small>
        {confirm}
      </Card>
    );
  }
  const line = (label: string, tone: Tone, text: string, key: string) => (
    <Text key={key} style={{ fontSize: 12, color: theme.colors.foreground }}>
      <Text style={{ color: toneColor(theme, tone) }}>{label}</Text>
      {` ${text}`}
    </Text>
  );
  return (
    <Card compact={false} theme={theme}>
      <Label theme={theme}>Mission level</Label>
      {cells}
      {confirm}
      {line("The Main decides:", "success", page.level.decides, "decides")}
      {line("Yours:", "muted", page.level.yours, "yours")}
      <Label theme={theme} style={{ marginTop: 6 }}>Governor</Label>
      {page.governor.lines.map((entry) => line(entry.label, entry.tone, entry.text, entry.label))}
      {page.governor.quiet === null ? null : line(page.governor.quiet.label, page.governor.quiet.tone, page.governor.quiet.text, "quiet")}
    </Card>
  );
}

const WORKER_COLUMNS = [1.3, 2.2, 1, 1.4, 1.6] as const;

function WorkerCell({ worker, workerId, openAgent, theme }: { worker: string | null; workerId: string | null; openAgent?: (agentId: string) => void; theme: Theme }) {
  if (worker === null || workerId === null) return <Text style={{ fontSize: 13, color: theme.colors.foregroundMuted }}>—</Text>;
  const body = (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
      <RoleMark kind="worker" theme={theme} size={16} />
      <Text style={{ fontSize: 12, fontFamily: MONO, color: theme.colors.foreground }}>{worker}</Text>
    </View>
  );
  return openAgent === undefined ? body : <Pressable accessibilityRole="button" accessibilityLabel={`Open Worker ${worker}`} onPress={() => openAgent(workerId)}>{body}</Pressable>;
}

/** "Workers by repository": one row per roster request (wide), the active ones and "+ N finished" (phone). */
function WorkersCard({ page, compact, on, theme }: Pick<MissionPageBodyProps, "page" | "compact" | "on" | "theme">) {
  const { colors } = theme;
  if (compact) {
    const active = page.rows.filter((row) => row.active);
    return (
      <Card compact theme={theme}>
        <Label theme={theme}>Workers</Label>
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
    <Card compact={false} theme={theme}>
      <Label theme={theme}>Workers by repository</Label>
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

const CONTRACT_COLUMNS = [1.7, 1.7, 1] as const;

function ContractsCard({ page, compact, theme }: Pick<MissionPageBodyProps, "page" | "compact" | "theme">) {
  return (
    <Card compact={compact} theme={theme}>
      <Label theme={theme}>Contracts between repositories</Label>
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

function JournalCard({ page, compact, theme }: Pick<MissionPageBodyProps, "page" | "compact" | "theme">) {
  const { colors } = theme;
  const lines = page.journal.slice(0, compact ? JOURNAL_PHONE : JOURNAL_DESKTOP);
  return (
    <Card compact={compact} theme={theme}>
      <Label theme={theme}>Journal</Label>
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

function PlanCard({ page, compact, theme }: Pick<MissionPageBodyProps, "page" | "compact" | "theme">) {
  return (
    <Card compact={compact} theme={theme}>
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 10 }}>
        <Label theme={theme}>Plan</Label>
        <Small tone="muted" theme={theme}>{page.plan.meta}</Small>
      </View>
      <Small theme={theme}>{page.plan.text}</Small>
    </Card>
  );
}

/** A mission's page: the artboard B on a wide screen, D on a phone (a chip's part shown in place). */
export function MissionPageBody(props: MissionPageBodyProps) {
  const { page, ui, compact, on, theme, status } = props;
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
        <Grid gap={10}>{stats}</Grid>
        <CharterCard {...props} />
        <Card compact theme={theme}>
          <Label theme={theme}>Governor</Label>
          {page.phoneGovernor.map((entry) => (
            <Text key={entry.label} style={{ fontSize: 12, color: theme.colors.foreground }}>
              <Text style={{ color: toneColor(theme, entry.tone) }}>{entry.label}</Text>
              {` ${entry.text}`}
            </Text>
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
      <Grid gap={10}>{stats}</Grid>
      <Grid gap={12}>
        {[<CharterCard key="charter" {...props} />, <LevelCard key="level" {...props} />]}
      </Grid>
      <WorkersCard {...props} />
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
  /** Level 3 or 4 chosen and waiting for its confirmation. */
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

export function NewMissionForm({ draft, errors, projects, confirming, busy, error, onDraft, onLevel, onConfirmLevel, onCancelLevel, onCancel, onCreate, compact, styles, theme }: NewMissionFormProps) {
  const { colors } = theme;
  return (
    <View style={{ gap: compact ? 8 : 12 }}>
      <Text accessibilityRole="header" style={{ fontSize: compact ? 18 : 20, fontWeight: "600", color: colors.foreground }}>
        New mission
      </Text>
      <View style={{ flexDirection: "row", gap: 12 }}>
        <Field label="Name" value={draft.name} onChange={(name) => onDraft({ ...draft, name })} a11y="Mission name" editable={!busy} theme={theme} style={{ flex: 3 }} />
        <Field label="Short code" value={draft.code} onChange={(code) => onDraft({ ...draft, code: codeAsTyped(code) })} a11y="Short code" mono editable={!busy} theme={theme} style={{ flex: 1 }} />
      </View>
      <Field label="Goal (the Main can draft the rest of the charter with you)" value={draft.goal} onChange={(goal) => onDraft({ ...draft, goal })} a11y="Goal" multiline editable={!busy} theme={theme} />
      <View>
        <Small tone="muted" theme={theme}>Repositories</Small>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 4 }}>
          {projects.length === 0 ? <Small tone="muted" theme={theme}>No project is listed yet.</Small> : null}
          {projects.map((project) => {
            const on = draft.repos.includes(project.id);
            return (
              <Pressable key={project.id} accessibilityRole="checkbox" accessibilityLabel={project.name} accessibilityState={{ checked: on }} disabled={busy} onPress={() => onDraft(toggleRepo(draft, project.id))}>
                <MissionChip text={project.name} mark={on ? "info" : null} muted={!on} theme={theme} />
              </Pressable>
            );
          })}
        </View>
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
      <View style={{ flexDirection: "row", justifyContent: "flex-end", gap: 10 }}>
        <Button label="Cancel" kind="secondary" disabled={busy} onPress={onCancel} styles={styles} textStyle={{ fontSize: 13 }} />
        <Button label={busy ? "Creating…" : "Create and open Main"} kind="primary" accessibilityState={{ disabled: busy, busy }} disabled={busy} onPress={onCreate} styles={styles} textStyle={{ fontSize: 13 }} />
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
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
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

export interface MissionsScreenProps extends PluginSurfaceProps {
  /** The listed projects (plugin homes left out), for New mission and "+ Add". */
  projects: readonly MissionProject[];
  /** The surface's status strip. */
  status?: ReactNode;
}

/** The Missions section: the list, a mission's page, New mission, a project's memory. */
export function MissionsScreen({ theme, layout, navigation, projects, status }: MissionsScreenProps) {
  const compact = layout.compact;
  const styles = useMemo(() => dashboardStyles(theme, compact), [theme, compact]);
  const queryClient = useQueryClient();
  const listMissions = useRpc(missionsListRpc);
  const getMission = useRpc(missionGetRpc);
  const changeMission = useRpc(missionChangeRpc);
  const ensureMission = useRpc(missionEnsureRpc);
  const createMission = useRpc(missionsCreateRpc);
  const setMissionLevel = useRpc(autonomySetMissionLevelRpc);
  const openAgent = navigation?.openAgent;

  const [place, setPlace] = useState<Place>({ view: "list" });
  const [closedShown, setClosedShown] = useState(false);
  const [ui, setUi] = useState<PageUi>(PAGE_UI_IDLE);
  const [draft, setDraft] = useState<MissionDraft>(EMPTY_MISSION_DRAFT);
  const [tried, setTried] = useState(false);
  const [confirming, setConfirming] = useState<MissionLevel | null>(null);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const list = useQuery({ queryKey: MISSIONS_QUERY_KEYS.list, queryFn: () => listMissions({}), ...pollWhile(place.view === "list") });
  const missionId = place.view === "page" ? place.missionId : "";
  const page = useQuery({ queryKey: MISSIONS_QUERY_KEYS.page(missionId), queryFn: () => getMission({ missionId }), ...pollWhile(place.view === "page") });

  const nameOf: NameOf = (id) => projects.find((project) => project.id === id)?.name ?? null;
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
  /** One call of the page: busy while it runs, its failure as one line. */
  const run = (busy: string, failed: string, call: () => Promise<unknown>, done: Partial<PageUi> = {}) => {
    patch({ busy, error: null, notice: null });
    call().then(
      () => {
        patch({ busy: null, ...done });
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
    const errors = missionDraftErrors(draft);
    const create = () => {
      setTried(true);
      if (errors.length > 0) return;
      setCreating(true);
      setCreateError(null);
      void (async () => {
        try {
          const created = await createMission(createInputOf(draft));
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
          setCreating(false);
          setDraft(EMPTY_MISSION_DRAFT);
          setTried(false);
          openPage(id, { error, notice: [notice, ...notices].filter((line) => line !== null).join(" ") || null });
        } catch (failure) {
          setCreating(false);
          setCreateError(`Could not create the mission: ${errorMessageOf(failure)}`);
        }
      })();
    };
    body = (
      <NewMissionForm
        draft={draft}
        errors={tried ? errors : []}
        projects={projects}
        confirming={confirming}
        busy={creating}
        error={createError}
        onDraft={setDraft}
        onLevel={(level) => {
          if (levelNeedsConfirmation(level) && level !== draft.level) setConfirming(level);
          else {
            setConfirming(null);
            setDraft({ ...draft, level });
          }
        }}
        onConfirmLevel={() => {
          if (confirming !== null) setDraft({ ...draft, level: confirming });
          setConfirming(null);
        }}
        onCancelLevel={() => setConfirming(null)}
        onCancel={() => {
          setDraft(EMPTY_MISSION_DRAFT);
          setTried(false);
          setConfirming(null);
          setCreateError(null);
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
          addable={addableReposOf(projects, view.charter.repos)}
          compact={compact}
          status={status}
          styles={styles}
          theme={theme}
          on={{
            back: () => setPlace({ view: "list" }),
            ui: patch,
            openMain: () => {
              patch({ busy: "Opening…", error: null, notice: null });
              ensureMission({ missionId: view.missionId }).then(
                (result) => {
                  patch({ busy: null, notice: opened(result.agentId, view.code) ?? result.toolsNotice ?? null });
                  refresh(view.missionId);
                },
                (error: unknown) => patch({ busy: null, error: `Could not open the Main: ${errorMessageOf(error)}` }),
              );
            },
            saveRename: () => {
              const input = ui.rename === null ? null : renameInputOf(view.missionId, current, ui.rename.name, ui.rename.code);
              if (input === null) patch({ rename: null });
              else run("Saving…", "Could not rename the mission", change(input), { rename: null });
            },
            close: () => run("Closing…", "Could not close the mission", change({ missionId: view.missionId, close: true }), { confirm: null }),
            addRepo: (workspaceId) => run("Adding…", "Could not add the repository", change({ missionId: view.missionId, addRepos: [workspaceId] }), { adding: false }),
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
            ...(openAgent === undefined ? {} : { openAgent: (agentId: string) => openAgent({ agentId }) }),
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
        onNew={() => setPlace({ view: "new" })}
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
