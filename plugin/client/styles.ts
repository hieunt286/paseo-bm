/**
 * The styles the screens of the Beads Manager surface share (WP-211.1;
 * Dashboard Design §2.1). Split from `dashboard-model.ts` (code review
 * 2026-09-30 §4). Every colour comes from the theme; no literal colours.
 *
 * No React, no React Native, no JSX, no `server/` import.
 */
import type { PluginTheme } from "@getpaseo/plugin";

/** The one corner radius of the surface: cards, buttons, inputs, chips. */
export const RADIUS = 2;

/** The width of the bar at a card's left that marks its kind. */
export const KIND_BAR_WIDTH = 3;

/** The side of the coloured square in front of a chip's label. */
export const CHIP_MARK_SIZE = 7;

export function dashboardStyles(theme: PluginTheme, compact: boolean) {
  return {
    screen: { flex: 1, backgroundColor: theme.colors.surface0 },
    content: { padding: compact ? 12 : 24, gap: compact ? 8 : 12 },
    title: { color: theme.colors.foreground, fontSize: compact ? 18 : 24, fontWeight: "600" as const },
    sectionTitle: { color: theme.colors.foreground, fontSize: compact ? 14 : 16, fontWeight: "600" as const },
    /** A small uppercase label over a group: muted, never coloured. */
    sectionLabel: {
      color: theme.colors.foregroundMuted,
      fontSize: 12,
      fontWeight: "500" as const,
      textTransform: "uppercase" as const,
      letterSpacing: 0.6,
    },
    body: { color: theme.colors.foregroundMuted, fontSize: compact ? 12 : 14 },
    mono: { color: theme.colors.foreground, fontSize: compact ? 11 : 13 },
    card: {
      gap: compact ? 6 : 8,
      padding: compact ? 10 : 14,
      borderRadius: RADIUS,
      borderWidth: 1,
      borderColor: theme.colors.border,
      backgroundColor: theme.colors.surface1,
    },
    badge: { fontSize: compact ? 11 : 12, fontWeight: "600" as const },
    button: {
      paddingVertical: 10,
      paddingHorizontal: 14,
      borderRadius: RADIUS,
      alignItems: "center" as const,
      backgroundColor: theme.colors.accent,
    },
    buttonText: { color: theme.colors.accentForeground, fontSize: compact ? 13 : 14 },
    dangerButton: {
      paddingVertical: 10,
      paddingHorizontal: 14,
      borderRadius: RADIUS,
      alignItems: "center" as const,
      borderWidth: 1,
      borderColor: theme.colors.statusDanger,
      backgroundColor: "transparent",
    },
    dangerButtonText: { color: theme.colors.statusDanger, fontSize: compact ? 13 : 14 },
    secondaryButton: {
      paddingVertical: 10,
      paddingHorizontal: 14,
      borderRadius: RADIUS,
      alignItems: "center" as const,
      borderWidth: 1,
      borderColor: theme.colors.border,
      backgroundColor: "transparent",
    },
    secondaryButtonText: { color: theme.colors.foreground, fontSize: compact ? 13 : 14 },
    spinner: { color: theme.colors.foregroundMuted },
    cards: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: compact ? 6 : 10 },
    statCard: {
      minWidth: compact ? 140 : 160,
      flexGrow: 1,
      gap: 2,
      padding: compact ? 10 : 12,
      borderRadius: RADIUS,
      borderWidth: 1,
      borderColor: theme.colors.border,
      backgroundColor: theme.colors.surface1,
    },
    statValue: { color: theme.colors.foreground, fontSize: compact ? 20 : 26, fontWeight: "700" as const },
    barTrack: { flex: 1, height: 10, borderRadius: 0, backgroundColor: theme.colors.surface2 },
    barFill: { height: 10, borderRadius: 0, backgroundColor: theme.colors.accent },
    chipRow: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: 6 },
    /**
     * A chip is a label, not a pill: a small coloured square, then the text in
     * small muted capitals. Only a chip that can be pressed (a filter) has a
     * border; a selected one is filled with `surface2`.
     */
    chip: {
      flexDirection: "row" as const,
      alignItems: "center" as const,
      gap: 6,
      paddingVertical: 2,
      paddingHorizontal: 6,
      borderRadius: RADIUS,
      borderWidth: 1,
      borderColor: "transparent",
    },
    chipText: {
      color: theme.colors.foregroundMuted,
      fontSize: 11,
      fontWeight: "500" as const,
      textTransform: "uppercase" as const,
      letterSpacing: 0.6,
    },
    chipMark: { width: CHIP_MARK_SIZE, height: CHIP_MARK_SIZE, borderRadius: 0 },
    node: {
      gap: 4,
      paddingVertical: compact ? 6 : 8,
      paddingHorizontal: compact ? 8 : 10,
      borderLeftWidth: 2,
      borderLeftColor: theme.colors.border,
    },
  };
}
