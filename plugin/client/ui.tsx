/**
 * The pieces the surface's screens share: a button, text in a tone's colour,
 * stat cards, a bar chart, a chip, the agent role mark, the style of a bead
 * title, the in-place confirmation Settings and the Inbox use, and the frame
 * every card is drawn in — the chats' and the Inbox's (`CardFrame`,
 * `CompactLine`). Styling comes from `dashboardStyles`, colours from the theme.
 *
 * Client rules: React Native primitives only, no Node import, no `server/`
 * import.
 */
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import type { ReactNode } from "react";
import type { BeadRow } from "../shared/contracts";
import { beadEmphasis, emphasisTone, type BeadEmphasis, type KanbanColumn } from "./beads-model";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { Pressable, Text, View, type AccessibilityRole, type AccessibilityState, type StyleProp, type TextStyle, type ViewStyle } from "react-native";
import { barShare, type Bar } from "./format";
import type { dashboardStyles } from "./styles";
import { ROLE_MARK, toneColor, type Badge, type RoleMarkKind, type Tone } from "./tone";
import type { ConfirmDialog } from "./ui-types";
import { MAX_BODY_LINES } from "./chat-card-parse";
import { NOTICE_DOT, type CardFrameView } from "./chat-card-frame";

export type Styles = ReturnType<typeof dashboardStyles>;
export type Theme = PluginSurfaceProps["theme"];

/** The three looks of a button: filled (the one to take), outlined, and outlined in the danger colour. */
export type ButtonKind = "primary" | "secondary" | "danger";

const BUTTON_STYLES = {
  primary: { box: "button", text: "buttonText" },
  secondary: { box: "secondaryButton", text: "secondaryButtonText" },
  danger: { box: "dangerButton", text: "dangerButtonText" },
} as const satisfies Record<ButtonKind, { box: keyof Styles; text: keyof Styles }>;

/** `base`, then `extra` flattened after it; `base` itself when there is no extra. */
function withBase<T>(base: T, extra: StyleProp<T> | undefined): StyleProp<T> {
  if (extra === undefined) return base;
  return Array.isArray(extra) ? [base, ...(extra as ReadonlyArray<StyleProp<T>>)] : [base, extra];
}

/**
 * A button: its label in one of the three looks (code review 2026-09-30 §3.6).
 * `style` and `textStyle` add to the look (`alignSelf`, an opacity); the
 * accessibility props reach the Pressable exactly as given, and the role is
 * `button` unless another is. Hook-free.
 */
export function Button({
  label,
  kind,
  style,
  textStyle,
  styles,
  ...press
}: {
  label: string;
  kind: ButtonKind;
  style?: StyleProp<ViewStyle>;
  textStyle?: StyleProp<TextStyle>;
  styles: Styles;
  onPress: () => void;
  accessibilityRole?: AccessibilityRole;
  accessibilityLabel?: string;
  accessibilityState?: AccessibilityState;
  disabled?: boolean;
}) {
  const look = BUTTON_STYLES[kind];
  return (
    <Pressable accessibilityRole="button" {...press} style={withBase<ViewStyle>(styles[look.box], style)}>
      <Text style={withBase<TextStyle>(styles[look.text], textStyle)}>{label}</Text>
    </Pressable>
  );
}

/**
 * Text in a tone's colour: an error, a warning, an outcome (code review
 * 2026-09-30 §3.6). Drawn as `[base, { ...style, color }]`, `base` being
 * `styles.body` unless given. Hook-free.
 */
export function ToneText({
  tone,
  base,
  style,
  styles,
  theme,
  children,
  ...text
}: {
  tone: Tone;
  base?: TextStyle;
  /** More of the text's own style, beside the colour (`fontSize`, `flex`). */
  style?: TextStyle;
  styles: Styles;
  theme: Theme;
  children: ReactNode;
  numberOfLines?: number;
  selectable?: boolean;
  accessibilityLiveRegion?: "none" | "polite" | "assertive";
}) {
  return (
    <Text {...text} style={[base ?? styles.body, { ...style, color: toneColor(theme, tone) }]}>
      {children}
    </Text>
  );
}

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
 * The first row of a project's page and of the Beads board: an optional ←, the
 * title (or a spacer when the page sits in its own workspace tab), then the screen's
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
          <Button label="←" kind="secondary" accessibilityLabel={backLabel} onPress={onBack} styles={styles} />
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
 * A bead title in a list: the section size, never bold (REQ-060 (i): bold titles
 * were tiring), and only as loud as its status — full contrast while the bead is
 * open, dim once it is closed (delta 20260925 §3.2). `null` keeps the plain text
 * colour, for a bead shown outside a list.
 */
export function beadTitleStyle(styles: Styles, theme: Theme, emphasis: BeadEmphasis | null) {
  return [
    styles.sectionTitle,
    { fontWeight: "400" as const, color: emphasis === null ? theme.colors.foreground : toneColor(theme, emphasisTone(emphasis)) },
  ];
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
        <Text style={beadTitleStyle(styles, theme, beadEmphasis(bead))} numberOfLines={open ? undefined : 2}>
          {`${open ? "▾" : "▸"} ${bead.title ?? "(untitled)"}`}
        </Text>
        {meta}
      </Pressable>
      {open ? detail : null}
    </View>
  );
}

/**
 * A row of tabs: one label per view, the chosen one filled in
 * (delta 20260925 §3.1, §3.3). Used for the Beads board's status columns on a
 * narrow screen, for the surface's four sections and a project's three tabs,
 * so all read the same. Hook-free.
 */
export function StatusTabs({
  tabs,
  selected,
  onSelect,
  styles,
}: {
  tabs: ReadonlyArray<{ key: string; label: string; count?: number; hint?: string }>;
  selected: string;
  onSelect: (key: string) => void;
  styles: Styles;
}) {
  return (
    <View accessibilityRole="tablist" style={styles.chipRow}>
      {tabs.map((tab) => {
        const on = tab.key === selected;
        return (
          <Button
            key={tab.key}
            label={tab.count === undefined ? tab.label : `${tab.label} ${tab.count}`}
            kind={on ? "primary" : "secondary"}
            accessibilityRole="tab"
            accessibilityState={{ selected: on }}
            accessibilityLabel={tab.hint === undefined ? tab.label : `${tab.label}: ${tab.hint}`}
            onPress={() => onSelect(tab.key)}
            styles={styles}
          />
        );
      })}
    </View>
  );
}

/**
 * The Beads board: one column per status, `perRow` of them on a row
 * (delta 20260925 §3.1). Each column sits in a cell of exactly `100 / perRow`
 * percent with its own padding, so the cells of a row add up to 100% and none
 * of them wraps early — `gap` on the row would push the last cell out.
 *
 * An empty column is still drawn and says so, so the board does not jump when a
 * filter changes. Hook-free: the rows come in through `renderBead`.
 */
export function KanbanBoard({
  columns,
  perRow,
  gap,
  renderBead,
  styles,
}: {
  columns: readonly KanbanColumn[];
  perRow: number;
  gap: number;
  renderBead: (bead: BeadRow) => ReactNode;
  styles: Styles;
}) {
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", marginHorizontal: -gap / 2 }}>
      {columns.map((column) => (
        <View key={column.bucket} style={{ flexBasis: `${100 / Math.max(1, perRow)}%`, padding: gap / 2 }}>
          <View style={{ gap }}>
            <Text style={styles.sectionTitle}>{`${column.label} · ${column.total}`}</Text>
            {column.beads.length === 0 ? <Text style={styles.body}>{column.empty}</Text> : null}
            {column.beads.map((bead) => renderBead(bead))}
            {column.hidden > 0 ? (
              <Text style={styles.body}>{`+${column.hidden} more · narrow the filters to see them`}</Text>
            ) : null}
          </View>
        </View>
      ))}
    </View>
  );
}

/** A small role icon on a soft, round tint of the role's colour. */
export function RoleMark({ kind, theme, size = 22 }: { kind: RoleMarkKind; theme: Theme; size?: number }) {
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

/**
 * A confirmation shown in place, with Cancel as the default. Shared by the
 * Settings blocks (a tool's Install, agent tools, skills, the cleanup warning),
 * the Orchestrator line of the Inbox, a chat's decision card and Insights.
 *
 * The confirm button is deliberately not the first control and never
 * pre-focused: every dialog that uses this grants something that is awkward to
 * take back, so an accidental Return must do nothing (design §7.13.3, §7.13.4).
 * While `busy`, Cancel is gone and the confirm button says `busyLabel`.
 */
export function ConfirmBlock({ dialog, busy, busyLabel, onConfirm, onCancel, styles, theme }: {
  dialog: ConfirmDialog;
  busy: boolean;
  busyLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
  styles: Styles;
  theme: Theme;
}) {
  return (
    <View style={{ gap: 6 }}>
      {dialog.title === null ? null : (
        <ToneText tone="warning" base={styles.sectionTitle} styles={styles} theme={theme}>{dialog.title}</ToneText>
      )}
      <Text style={dialog.bodyTone === undefined ? styles.body : [styles.body, { color: toneColor(theme, dialog.bodyTone) }]} selectable>
        {dialog.body}
      </Text>
      <View style={styles.chipRow}>
        {busy ? null : (
          <Button
            label={dialog.cancelLabel}
            kind="secondary"
            accessibilityLabel={dialog.cancelAccessibilityLabel ?? dialog.cancelLabel}
            onPress={onCancel}
            styles={styles}
          />
        )}
        <Button
          label={busy ? busyLabel : dialog.confirmLabel}
          kind="primary"
          accessibilityLabel={dialog.confirmAccessibilityLabel ?? dialog.confirmLabel}
          accessibilityState={{ disabled: busy, busy }}
          disabled={busy}
          onPress={onConfirm}
          styles={styles}
        />
      </View>
    </View>
  );
}

/**
 * The one frame of every card (experience concept §5.1, autonomy design
 * §A.12), in the chats and in the Inbox:
 *
 * ```
 * ┌ <mark> <Actor> → <Recipient> · <authority>                 <time> ┐
 * │ <STATUS CHIP>  <title>                                     <tag> │
 * │ <body: at most 3 lines>                                          │
 * │ <actions: one primary>                                Details ▸  │
 * └──────────────────────────────────────────────────────────────────┘
 * ```
 *
 * Hook-free: the view comes from the card models (`cardFrameOf`,
 * `decisionCardView`), the actions and Details are passed in. Ids belong in
 * Details only; the only coloured border is `view.outline`.
 */
export function CardFrame({
  view,
  actions,
  details,
  detailsOpen,
  onToggleDetails,
  styles,
  theme,
}: {
  view: CardFrameView;
  actions?: ReactNode;
  details: ReactNode;
  detailsOpen: boolean;
  onToggleDetails: () => void;
  styles: Styles;
  theme: Theme;
}) {
  const outline = view.outline === null ? null : { borderColor: toneColor(theme, view.outline) };
  return (
    <View style={[styles.card, { gap: 6, marginVertical: 4 }, outline]}>
      <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 8 }}>
        <View style={{ flex: 1, flexDirection: "row", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
          {view.actor.mark === null ? null : <RoleMark kind={view.actor.mark} theme={theme} size={20} />}
          <Text style={[styles.body, { color: theme.colors.foreground, fontWeight: "600" }]} numberOfLines={1}>
            {view.actor.name}
          </Text>
          {view.recipient === null ? null : (
            <Text style={styles.body} numberOfLines={1}>
              {`→ ${view.recipient}`}
            </Text>
          )}
          {view.authority === null ? null : (
            <Text style={styles.body} numberOfLines={1}>
              {`· ${view.authority}`}
            </Text>
          )}
        </View>
        <Text style={styles.body}>{view.time}</Text>
      </View>

      <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        {view.chip === null ? null : <Chip badge={view.chip} styles={styles} theme={theme} />}
        <Text style={[styles.sectionTitle, { flex: 1, minWidth: 160 }]} numberOfLines={detailsOpen ? undefined : 2}>
          {view.title}
        </Text>
        {/* Neutral: a tag is read, never told apart by colour alone. */}
        {view.tag === null ? null : <Text style={[styles.badge, { color: theme.colors.foregroundMuted }]}>{view.tag}</Text>}
      </View>

      {view.body.slice(0, MAX_BODY_LINES).map((line, index) => (
        <Text key={`${index}:${line}`} style={styles.body} numberOfLines={detailsOpen ? undefined : 2}>
          {line}
        </Text>
      ))}

      {actions === undefined || actions === null ? null : <View style={{ gap: 6 }}>{actions}</View>}

      <View style={{ flexDirection: "row", justifyContent: "flex-end" }}>
        <Button
          label={detailsOpen ? "Details ▾" : "Details ▸"}
          kind="secondary"
          accessibilityLabel={detailsOpen ? "Hide details" : "Show details"}
          accessibilityState={{ expanded: detailsOpen }}
          onPress={onToggleDetails}
          styles={styles}
        />
      </View>
      {view.status === null ? null : <ToneText tone={view.status.tone} styles={styles} theme={theme}>{view.status.text}</ToneText>}
      {detailsOpen ? <View style={[styles.card, { backgroundColor: theme.colors.surface0, gap: 4 }]}>{details}</View> : null}
    </View>
  );
}

/**
 * A notice as one compact line — `● <what happened> · <time ago>` — with the
 * whole notice on a tap (the `notice` card). Hook-free.
 */
export function CompactLine({
  tone,
  text,
  expanded,
  onToggle,
  details,
  styles,
  theme,
}: {
  tone: Tone;
  text: string;
  expanded: boolean;
  onToggle: () => void;
  details: ReactNode;
  styles: Styles;
  theme: Theme;
}) {
  return (
    <View style={{ marginVertical: 2, gap: 4 }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${text}. ${expanded ? "Hide" : "Show"} the whole notice`}
        accessibilityState={{ expanded }}
        onPress={onToggle}
        style={{ flexDirection: "row", gap: 6 }}
      >
        <ToneText tone={tone} styles={styles} theme={theme}>{NOTICE_DOT}</ToneText>
        <Text style={[styles.body, { flex: 1 }]} numberOfLines={expanded ? undefined : 1}>
          {text}
        </Text>
        <Text style={styles.body}>{expanded ? "▾" : "▸"}</Text>
      </Pressable>
      {expanded ? <View style={[styles.card, { backgroundColor: theme.colors.surface0 }]}>{details}</View> : null}
    </View>
  );
}
