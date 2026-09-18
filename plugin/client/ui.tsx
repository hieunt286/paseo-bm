/**
 * The pieces the Metric and Beads screens share: stat cards, a bar chart, a
 * chip, the agent role mark, and the style of a bead title. Styling comes from
 * `dashboardStyles`, colours from the theme.
 *
 * Client rules: React Native primitives only, no Node import, no `server/`
 * import.
 */
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import type { ReactNode } from "react";
import type { BeadRow } from "../shared/contracts";
import { beadTitleTone } from "./beads-model";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { Pressable, Text, View } from "react-native";
import { ROLE_MARK, barShare, toneColor, type Badge, type Bar, type GraphNode, type Tone, type dashboardStyles } from "./dashboard-model";

export type Styles = ReturnType<typeof dashboardStyles>;
export type Theme = PluginSurfaceProps["theme"];

/** Props of the two per-workspace screens, Beads and Metric. */
export interface WorkspaceScreenProps extends PluginSurfaceProps {
  workspaceId: string;
  /** Omitted inside the workspace's own "Beads" tab: the tab already says where it is. */
  workspaceLabel?: string;
  /** Omitted inside the "Beads" tab, which has no screen to go back to. */
  onBack?: () => void;
  /** What the ← says to a screen reader; the surface names where it leads. */
  backLabel?: string;
  /** The Beads Manager surface's status strip; the "Beads" tab has none. */
  status?: ReactNode;
}

/**
 * The first row of the Beads and Metric screens: an optional ←, the title (or
 * a spacer when the screen sits in its own workspace tab), then the screen's
 * own buttons. The surface's status strip, when given, sits right under it, so
 * a slash command's notice is seen on these screens too. Hook-free, so tests
 * can expand it.
 */
export function WorkspaceScreenHeader({
  title,
  onBack,
  backLabel,
  right,
  status,
  styles,
}: {
  title: string | null;
  onBack?: () => void;
  backLabel: string;
  right: ReactNode;
  status?: ReactNode;
  styles: Styles;
}) {
  return (
    <>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
        {onBack === undefined ? null : (
          <Pressable accessibilityRole="button" accessibilityLabel={backLabel} onPress={onBack} style={styles.secondaryButton}>
            <Text style={styles.secondaryButtonText}>←</Text>
          </Pressable>
        )}
        {title === null ? (
          <View style={{ flex: 1 }} />
        ) : (
          <Text style={[styles.title, { flex: 1 }]} numberOfLines={1}>
            {title}
          </Text>
        )}
        {right}
      </View>
      {status}
    </>
  );
}

export function StatCards({
  cards,
  styles,
}: {
  cards: ReadonlyArray<{ label: string; value: string; hint: string }>;
  styles: Styles;
}) {
  return (
    <View style={styles.cards}>
      {cards.map((card) => (
        <View key={card.label} style={styles.statCard}>
          <Text style={styles.body}>{card.label}</Text>
          <Text style={styles.statValue}>{card.value}</Text>
          <Text style={styles.body} numberOfLines={1}>
            {card.hint}
          </Text>
        </View>
      ))}
    </View>
  );
}

/** Horizontal bars; a bar with an `agentId` opens that agent when `onOpen` is given. */
export function BarChart({
  title,
  bars,
  styles,
  labelWidth = 140,
  onOpen,
}: {
  title: string;
  bars: Bar[];
  styles: Styles;
  labelWidth?: number;
  onOpen?: (agentId: string) => void;
}) {
  return (
    <View style={[styles.card, { flexGrow: 1, minWidth: 220 }]}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {bars.length === 0 ? <Text style={styles.body}>Nothing yet.</Text> : null}
      {bars.map((bar) => {
        const row = (
          <View style={{ gap: 2 }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              <Text style={[styles.body, { width: labelWidth }]} numberOfLines={1}>
                {bar.label}
              </Text>
              <View style={styles.barTrack}>
                <View style={[styles.barFill, { width: `${Math.round(barShare(bar, bars) * 100)}%` }]} />
              </View>
              <Text style={[styles.body, { minWidth: 30, textAlign: "right" }]}>{bar.display}</Text>
            </View>
            {bar.hint === undefined ? null : (
              <Text style={styles.body} numberOfLines={1}>
                {bar.hint}
              </Text>
            )}
          </View>
        );
        const agentId = bar.agentId;
        return agentId !== undefined && onOpen !== undefined ? (
          <Pressable key={agentId} accessibilityRole="button" accessibilityLabel={`Open ${bar.label}`} onPress={() => onOpen(agentId)}>
            {row}
          </Pressable>
        ) : (
          <View key={agentId ?? bar.label}>{row}</View>
        );
      })}
    </View>
  );
}

/** A coloured chip; pressable and selectable when `onPress` is given. */
export function Chip({
  badge,
  selected,
  onPress,
  styles,
  theme,
}: {
  badge: Badge;
  selected?: boolean;
  onPress?: () => void;
  styles: Styles;
  theme: Theme;
}) {
  const colour = toneColor(theme, badge.tone);
  const body = (
    <View style={[styles.chip, { borderColor: colour, backgroundColor: selected ? theme.colors.surface2 : "transparent" }]}>
      <Text style={[styles.badge, { color: colour }]}>{`${selected ? "● " : ""}${badge.text}`}</Text>
    </View>
  );
  return onPress === undefined ? (
    body
  ) : (
    <Pressable accessibilityRole="button" accessibilityState={{ selected: selected === true }} onPress={onPress}>
      {body}
    </Pressable>
  );
}

/**
 * A bead title in a list: the section size, not bold, in its status colour
 * (owner decisions Q3 and Q8, delta 20260918e). `null` keeps the plain text
 * colour, for a bead shown outside a list.
 */
export function beadTitleStyle(styles: Styles, theme: Theme, tone: Tone | null) {
  return [styles.sectionTitle, { fontWeight: "400" as const, color: tone === null ? theme.colors.foreground : toneColor(theme, tone) }];
}

/**
 * One bead row, shared by the Beads screen and the "Beads in this chat" panel:
 * the title coloured by status (not bold) with ▸ / ▾, then what the list shows
 * about the bead (`meta`), and the detail once the row is open. The detail is
 * passed in, so this file never imports the Beads screen. Hook-free.
 */
export function BeadRowCard({
  bead,
  open,
  onToggle,
  meta,
  detail,
  styles,
  theme,
}: {
  bead: Pick<BeadRow, "title" | "status" | "ready">;
  open: boolean;
  onToggle: () => void;
  meta: ReactNode;
  detail: ReactNode;
  styles: Styles;
  theme: Theme;
}) {
  return (
    <View style={styles.card}>
      <Pressable accessibilityRole="button" accessibilityState={{ expanded: open }} onPress={onToggle}>
        {/* The title is what a reader scans for; the id comes second. */}
        <Text style={beadTitleStyle(styles, theme, beadTitleTone(bead))} numberOfLines={open ? undefined : 2}>
          {`${open ? "▾" : "▸"} ${bead.title ?? "(untitled)"}`}
        </Text>
        {meta}
      </Pressable>
      {open ? detail : null}
    </View>
  );
}

/** A small role icon on a soft, round tint of the role's colour. */
export function RoleMark({ kind, theme, size = 22 }: { kind: GraphNode["kind"]; theme: Theme; size?: number }) {
  const mark = ROLE_MARK[kind];
  const colour = toneColor(theme, mark.tone);
  return (
    <View
      accessibilityLabel={mark.role}
      style={{ width: size, height: size, borderRadius: size / 2, alignItems: "center", justifyContent: "center" }}
    >
      <View
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          borderRadius: size / 2,
          backgroundColor: colour,
          opacity: 0.16,
        }}
      />
      <Icon name={mark.icon} size={Math.round(size * 0.6)} color={colour} />
    </View>
  );
}

/** One line naming each role next to its mark, so the graph reads without guessing. */
export function RoleLegend({ styles, theme }: { styles: Styles; theme: Theme }) {
  return (
    <View style={[styles.chipRow, { gap: 12 }]}>
      {(Object.keys(ROLE_MARK) as Array<GraphNode["kind"]>).map((kind) => (
        <View key={kind} style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          <RoleMark kind={kind} theme={theme} size={18} />
          <Text style={styles.body}>{`${ROLE_MARK[kind].role} · ${ROLE_MARK[kind].does}`}</Text>
        </View>
      ))}
    </View>
  );
}
