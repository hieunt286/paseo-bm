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
import { KIND_BAR_WIDTH, RADIUS, type dashboardStyles } from "./styles";
import { ROLE_MARK, toneColor, type Badge, type RoleMarkKind, type Tone } from "./tone";
import { MONO } from "./text-tabs";
import type { ConfirmDialog } from "./ui-types";
import { MAX_BODY_LINES } from "./chat-card-parse";
import { NOTICE_DOT, kindBarOf, type CardFrameView } from "./chat-card-frame";

export type Styles = ReturnType<typeof dashboardStyles>;
export type Theme = PluginSurfaceProps["theme"];

/**
 * The looks of a button: filled (the one to take), outlined, outlined in the
 * danger colour, and a text button — no border, muted (the mockup's
 * "Details", "Why?").
 */
export type ButtonKind = "primary" | "secondary" | "danger" | "text";

const BUTTON_STYLES = {
  primary: { box: "button", text: "buttonText" },
  secondary: { box: "secondaryButton", text: "secondaryButtonText" },
  danger: { box: "dangerButton", text: "dangerButtonText" },
  text: { box: "secondaryButton", text: "body" },
} as const satisfies Record<ButtonKind, { box: keyof Styles; text: keyof Styles }>;

/** The mockup's small button (8×12 padding, 13px, square), for the cards' and the Inbox's rows. */
const SMALL_BOX: ViewStyle = { paddingVertical: 8, paddingHorizontal: 12, borderRadius: 0 };
const SMALL_TEXT: TextStyle = { fontSize: 13 };
/** A text button has no border and little side padding. */
const TEXT_BOX: ViewStyle = { borderWidth: 0, paddingHorizontal: 4 };

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
  size,
  style,
  textStyle,
  styles,
  ...press
}: {
  label: string;
  kind: ButtonKind;
  /** `small`: the mockup's row buttons (Ask back, Own words…, Override, an alert's action). */
  size?: "small";
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
  const box = size === "small" || kind === "text" ? { ...styles[look.box], ...(size === "small" ? SMALL_BOX : {}), ...(kind === "text" ? TEXT_BOX : {}) } : styles[look.box];
  const text = size === "small" || kind === "text" ? { ...styles[look.text], ...SMALL_TEXT } : styles[look.text];
  return (
    <Pressable accessibilityRole="button" {...press} style={withBase<ViewStyle>(box, style)}>
      <Text style={withBase<TextStyle>(text, textStyle)}>{label}</Text>
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

/**
 * A chip: a small square in the tone's colour, then the label in small muted
 * capitals — a label, not a pill (change-014 outcome 6). Pressable and
 * selectable when `onPress` is given, and then outlined; a selected one is
 * filled and its label reads in the text colour.
 */
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
  const pressable = onPress !== undefined;
  const body = (
    <View
      style={[
        styles.chip,
        { borderColor: pressable ? theme.colors.border : "transparent", backgroundColor: selected ? theme.colors.surface2 : "transparent" },
      ]}
    >
      <View style={[styles.chipMark, { backgroundColor: colour }]} />
      <Text style={[styles.chipText, { color: selected ? theme.colors.foreground : theme.colors.foregroundMuted }]}>
        {`${selected ? "● " : ""}${badge.text}`}
      </Text>
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

/** A small role icon on a soft, square tint of the role's colour. */
export function RoleMark({ kind, theme, size = 22 }: { kind: RoleMarkKind; theme: Theme; size?: number }) {
  const mark = ROLE_MARK[kind];
  const colour = toneColor(theme, mark.tone);
  return (
    <View
      accessibilityLabel={mark.role}
      style={{ width: size, height: size, borderRadius: RADIUS, alignItems: "center", justifyContent: "center" }}
    >
      <View
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          borderRadius: RADIUS,
          backgroundColor: colour,
          opacity: 0.12,
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

/** Where a card sits among others: alone (a chat), the first of a joined stack, or one after it (no top border). */
export type CardJoin = "alone" | "first" | "next";

/**
 * The box of a card as the approved mockup draws it (change-014): surface1,
 * one 1px border and square corners, 20×24 padding (16×24 for a one-line
 * card such as an alert), no left border when a kind bar stands there, and in
 * a joined stack (an Inbox project group) no gap and no top border after the
 * first. Pure, so the Inbox's alert and outcome rows use it too.
 */
export function cardBoxStyle(
  theme: Theme,
  options: { compact: boolean; join?: CardJoin; bar: boolean; row?: boolean },
): ViewStyle {
  const join = options.join ?? "alone";
  const vertical = options.row ? (options.compact ? 12 : 16) : options.compact ? 14 : 20;
  return {
    position: "relative",
    gap: options.row ? 12 : options.compact ? 10 : 14,
    paddingVertical: vertical,
    paddingHorizontal: options.compact ? 16 : 24,
    borderRadius: 0,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderLeftWidth: options.bar ? 0 : 1,
    borderTopWidth: join === "next" ? 0 : 1,
    backgroundColor: theme.colors.surface1,
    ...(join === "alone" ? { marginVertical: 4 } : {}),
  };
}

/** The 3px bar at a card's left that marks its kind: the only colour on the frame. */
export function KindBar({ tone, theme }: { tone: Tone; theme: Theme }) {
  return (
    <View
      style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: KIND_BAR_WIDTH, backgroundColor: toneColor(theme, tone) }}
    />
  );
}

/**
 * A card's title, 17/600: text in backticks is drawn as inline code (the
 * mockup's "Run `git push origin main`?"), in mono on the page colour with a
 * 1px border.
 */
export function CardTitle({ text, open, compact, theme }: { text: string; open: boolean; compact: boolean; theme: Theme }) {
  const parts = text.split("`");
  // An odd count of backticks leaves the last one as it was written.
  const coded = parts.length % 2 === 1;
  return (
    <Text
      accessibilityRole="header"
      style={{ color: theme.colors.foreground, fontSize: compact ? 15 : 17, fontWeight: "600", lineHeight: compact ? 21 : 24 }}
      numberOfLines={open ? undefined : 3}
    >
      {coded && parts.length > 1
        ? parts.map((part, index) =>
            index % 2 === 0 ? (
              part
            ) : (
              <Text
                key={`${index}:${part}`}
                style={{
                  fontFamily: MONO,
                  fontWeight: "400",
                  backgroundColor: theme.colors.surface0,
                  borderWidth: 1,
                  borderColor: theme.colors.border,
                  paddingHorizontal: 6,
                  paddingVertical: 2,
                }}
              >
                {part}
              </Text>
            ),
          )
        : text}
    </Text>
  );
}

/** A small kind label in mono capitals: a card's kind and class, a status, a tag. */
function MetaLabel({ text, colour }: { text: string; colour: string }) {
  return (
    <Text style={{ fontFamily: MONO, fontSize: 12, color: colour, textTransform: "uppercase" }} numberOfLines={1}>
      {text}
    </Text>
  );
}

/**
 * The one frame of every card (experience concept §5.1, autonomy design
 * §A.12), in the chats and in the Inbox, as the approved mockup draws it
 * (change-014):
 *
 * ```
 * ▌ <icon> <Actor> → <Recipient> · <authority> · <time>    <STATUS> <KIND · CLASS> <tag>
 * ▌ <title, 17/600>
 * ▌ <body: at most 3 lines>
 * ▌ <actions>
 * ▌ <footer buttons>                                                        Details
 * ```
 *
 * Hook-free: the view comes from the card models (`cardFrameOf`,
 * `decisionCardView`), the actions, the footer and Details are passed in. Ids
 * belong in Details only. The only colour on the frame is the 3 px bar at its
 * left that marks the card's kind (`kindBarOf`; change-014 outcome 6) and the
 * kind label in the same colour; a settled card has no bar. `join` stacks the
 * card in an Inbox group.
 */
export function CardFrame({
  view,
  actions,
  footer,
  details,
  detailsOpen,
  onToggleDetails,
  join,
  compact = false,
  styles,
  theme,
}: {
  view: CardFrameView;
  actions?: ReactNode;
  /** Buttons on the Details row, at its left (Ask back, Own words…). */
  footer?: ReactNode;
  details: ReactNode;
  detailsOpen: boolean;
  onToggleDetails: () => void;
  join?: CardJoin;
  compact?: boolean;
  styles: Styles;
  theme: Theme;
}) {
  const { colors } = theme;
  const barTone = kindBarOf(view);
  const icon = view.icon ?? (view.actor.mark === null ? null : ROLE_MARK[view.actor.mark].icon);
  const rest = `${view.recipient === null ? "" : ` → ${view.recipient}`}${[view.authority, view.time]
    .filter((part) => part !== null && part !== "")
    .map((part) => ` · ${part}`)
    .join("")}`;
  return (
    <View style={cardBoxStyle(theme, { compact, join: join ?? "alone", bar: barTone !== null })}>
      {barTone === null ? null : <KindBar tone={barTone} theme={theme} />}
      <View style={{ flexDirection: "row", alignItems: "center", gap: 10, flexWrap: compact ? "wrap" : "nowrap" }}>
        {icon === null ? null : <Icon name={icon} size={16} color={colors.foregroundMuted} />}
        <Text style={{ flex: 1, flexShrink: 1, minWidth: 120, fontSize: 13, color: colors.foregroundMuted }} numberOfLines={detailsOpen ? undefined : 1}>
          <Text style={{ color: colors.foreground }}>{view.actor.name}</Text>
          {rest}
        </Text>
        {view.chip === null ? null : <MetaLabel text={view.chip.text} colour={toneColor(theme, view.chip.tone)} />}
        {view.label == null ? null : <MetaLabel text={view.label.text} colour={toneColor(theme, view.label.tone)} />}
        {/* Neutral: a tag is read, never told apart by colour alone. */}
        {view.tag === null ? null : <MetaLabel text={view.tag} colour={colors.foregroundMuted} />}
      </View>

      <CardTitle text={view.title} open={detailsOpen} compact={compact} theme={theme} />

      {view.body.slice(0, MAX_BODY_LINES).map((line, index) => (
        <Text key={`${index}:${line}`} style={styles.body} numberOfLines={detailsOpen ? undefined : 2}>
          {line}
        </Text>
      ))}

      {actions === undefined || actions === null ? null : <View style={{ gap: 10 }}>{actions}</View>}

      <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        {footer}
        <Button
          label="Details"
          kind="text"
          accessibilityLabel={detailsOpen ? "Hide details" : "Show details"}
          accessibilityState={{ expanded: detailsOpen }}
          onPress={onToggleDetails}
          style={{ marginLeft: "auto" }}
          styles={styles}
        />
      </View>
      {view.status === null ? null : <ToneText tone={view.status.tone} styles={styles} theme={theme}>{view.status.text}</ToneText>}
      {detailsOpen ? (
        <View style={{ gap: 4, padding: 12, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface0 }}>{details}</View>
      ) : null}
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
