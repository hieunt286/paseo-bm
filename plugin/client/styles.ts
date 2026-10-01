/**
 * The styles the screens of the Beads Manager surface share (WP-211.1;
 * Dashboard Design §2.1). Split from `dashboard-model.ts` (code review
 * 2026-09-30 §4). Every colour comes from the theme; no literal colours.
 *
 * No React, no React Native, no JSX, no `server/` import.
 */
import type { PluginTheme } from "@getpaseo/plugin";

export function dashboardStyles(theme: PluginTheme, compact: boolean) {
  return {
    screen: { flex: 1, backgroundColor: theme.colors.surface0 },
    content: { padding: compact ? 12 : 24, gap: compact ? 8 : 12 },
    title: { color: theme.colors.foreground, fontSize: compact ? 18 : 24, fontWeight: "600" as const },
    sectionTitle: { color: theme.colors.foreground, fontSize: compact ? 14 : 16, fontWeight: "600" as const },
    body: { color: theme.colors.foregroundMuted, fontSize: compact ? 12 : 14 },
    mono: { color: theme.colors.foreground, fontSize: compact ? 11 : 13 },
    card: {
      gap: compact ? 6 : 8,
      padding: compact ? 10 : 14,
      borderRadius: 10,
      borderWidth: 1,
      borderColor: theme.colors.border,
      backgroundColor: theme.colors.surface1,
    },
    badge: { fontSize: compact ? 11 : 12, fontWeight: "600" as const },
    button: {
      paddingVertical: 10,
      paddingHorizontal: 14,
      borderRadius: 8,
      alignItems: "center" as const,
      backgroundColor: theme.colors.accent,
    },
    buttonText: { color: theme.colors.accentForeground, fontSize: compact ? 13 : 14 },
    dangerButton: {
      paddingVertical: 10,
      paddingHorizontal: 14,
      borderRadius: 8,
      alignItems: "center" as const,
      borderWidth: 1,
      borderColor: theme.colors.statusDanger,
      backgroundColor: theme.colors.surface2,
    },
    dangerButtonText: { color: theme.colors.statusDanger, fontSize: compact ? 13 : 14 },
    secondaryButton: {
      paddingVertical: 10,
      paddingHorizontal: 14,
      borderRadius: 8,
      alignItems: "center" as const,
      borderWidth: 1,
      borderColor: theme.colors.border,
      backgroundColor: theme.colors.surface2,
    },
    secondaryButtonText: { color: theme.colors.foreground, fontSize: compact ? 13 : 14 },
    spinner: { color: theme.colors.foregroundMuted },
    cards: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: compact ? 6 : 10 },
    statCard: {
      minWidth: compact ? 140 : 160,
      flexGrow: 1,
      gap: 2,
      padding: compact ? 10 : 12,
      borderRadius: 10,
      borderWidth: 1,
      borderColor: theme.colors.border,
      backgroundColor: theme.colors.surface1,
    },
    statValue: { color: theme.colors.foreground, fontSize: compact ? 20 : 26, fontWeight: "700" as const },
    barTrack: { flex: 1, height: 10, borderRadius: 5, backgroundColor: theme.colors.surface2 },
    barFill: { height: 10, borderRadius: 5, backgroundColor: theme.colors.accent },
    chipRow: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: 6 },
    chip: {
      paddingVertical: 2,
      paddingHorizontal: 8,
      borderRadius: 999,
      borderWidth: 1,
    },
    node: {
      gap: 4,
      paddingVertical: compact ? 6 : 8,
      paddingHorizontal: compact ? 8 : 10,
      borderLeftWidth: 2,
      borderLeftColor: theme.colors.border,
    },
  };
}
