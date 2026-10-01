/**
 * The two selection controls of the flat surface (change-014, the approved
 * mockup): text tabs with a 2px underline — the section nav, a project's tabs,
 * Settings' project tabs — and a segmented control of joined, square cells —
 * the Inbox filter, the Metrics period, the Beads feature filter. Hook-free;
 * colours from the theme only.
 *
 * Client rules: React Native primitives only, no Node import, no `server/`
 * import.
 */
import type { ReactNode } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import type { Theme } from "./ui";

export interface TextTab {
  key: string;
  label: string;
  /** A small count after the label (the Inbox's), drawn as a filled badge. */
  badge?: number | null;
  /** Something drawn after the label (a level name in muted mono, for example). */
  suffix?: string | null;
  accessibilityLabel?: string;
}

/**
 * A row of text tabs: the selected one in full contrast, weight 500, with a
 * 2px accent underline; the others muted with a transparent underline.
 * `height` stretches the tabs to a bar's height (the section nav); without it
 * they size to their text with 10px vertical padding. `divider` draws the
 * 1px border under the row.
 */
export function TextTabs({
  tabs,
  selected,
  onSelect,
  theme,
  height,
  divider = false,
  wrap = false,
  fill = false,
  scroll = false,
}: {
  tabs: readonly TextTab[];
  selected: string | null;
  onSelect: (key: string) => void;
  theme: Theme;
  height?: number;
  divider?: boolean;
  wrap?: boolean;
  /** Each tab takes an equal share of the row (the phone's section nav). */
  fill?: boolean;
  /** The row scrolls sideways instead of overflowing (a project's tabs on a phone). */
  scroll?: boolean;
}) {
  const { colors } = theme;
  const row = (
    <View
      accessibilityRole="tablist"
      style={{
        flexDirection: "row",
        flexWrap: wrap ? "wrap" : "nowrap",
        alignItems: "stretch",
        ...(height === undefined ? {} : { height }),
        ...(divider ? { borderBottomWidth: 1, borderBottomColor: colors.border } : {}),
      }}
    >
      {tabs.map((tab) => {
        const on = tab.key === selected;
        return (
          <Pressable
            key={tab.key}
            accessibilityRole="tab"
            accessibilityState={{ selected: on }}
            accessibilityLabel={tab.accessibilityLabel ?? tab.label}
            onPress={() => onSelect(tab.key)}
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: 8,
              paddingHorizontal: fill ? 4 : height === undefined ? 14 : 16,
              ...(fill ? { flex: 1, justifyContent: "center" as const } : {}),
              ...(height === undefined ? { paddingVertical: 10 } : {}),
              borderBottomWidth: 2,
              borderBottomColor: on ? colors.accent : "transparent",
              marginBottom: divider ? -1 : 0,
            }}
          >
            <Text style={{ color: on ? colors.foreground : colors.foregroundMuted, fontSize: 14, fontWeight: on ? "500" : "400" }}>{tab.label}</Text>
            {tab.suffix ? <Text style={{ color: colors.foregroundMuted, fontSize: 12, fontFamily: MONO }}>{tab.suffix}</Text> : null}
            {tab.badge !== undefined && tab.badge !== null && tab.badge > 0 ? (
              <Text
                style={{
                  color: colors.surface0,
                  backgroundColor: colors.statusWarning,
                  fontSize: 12,
                  fontFamily: MONO,
                  paddingHorizontal: 6,
                  paddingVertical: 1,
                }}
              >
                {String(tab.badge)}
              </Text>
            ) : null}
          </Pressable>
        );
      })}
    </View>
  );
  if (!scroll) return row;
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} style={divider ? { borderBottomWidth: 1, borderBottomColor: colors.border } : undefined}>
      {row}
    </ScrollView>
  );
}

export interface Segment {
  key: string;
  label: string;
  /** A small muted count after the label (the Beads feature filter's). */
  count?: number | null;
  accessibilityLabel?: string;
}

/** Joined square cells in one 1px border; the selected cell on surface2 in full contrast, the others transparent and muted. */
export function Segmented({
  segments,
  selected,
  onSelect,
  theme,
  fill = false,
  scroll = false,
}: {
  segments: readonly Segment[];
  selected: string | null;
  onSelect: (key: string) => void;
  theme: Theme;
  /** The cells share the row's width equally (a phone's filter). */
  fill?: boolean;
  /** The row scrolls sideways instead of overflowing (many cells on a phone). */
  scroll?: boolean;
}) {
  const { colors } = theme;
  const group = (
    <View
      accessibilityRole="radiogroup"
      style={{ flexDirection: "row", borderWidth: 1, borderColor: colors.border, alignSelf: fill ? "stretch" : "flex-start" }}
    >
      {segments.map((segment, index) => {
        const on = segment.key === selected;
        return (
          <Pressable
            key={segment.key}
            accessibilityRole="radio"
            accessibilityState={{ checked: on }}
            accessibilityLabel={segment.accessibilityLabel ?? segment.label}
            onPress={() => onSelect(segment.key)}
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: 6,
              paddingVertical: fill ? 8 : 6,
              paddingHorizontal: fill ? 4 : 12,
              ...(fill ? { flex: 1, justifyContent: "center" as const } : {}),
              backgroundColor: on ? colors.surface2 : "transparent",
              ...(index === 0 ? {} : { borderLeftWidth: 1, borderLeftColor: colors.border }),
            }}
          >
            <Text style={{ color: on ? colors.foreground : colors.foregroundMuted, fontSize: 13 }}>{segment.label}</Text>
            {segment.count === undefined || segment.count === null ? null : (
              <Text style={{ color: colors.foregroundMuted, fontSize: 11, fontFamily: MONO }}>{String(segment.count)}</Text>
            )}
          </Pressable>
        );
      })}
    </View>
  );
  if (!scroll) return group;
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false}>
      {group}
    </ScrollView>
  );
}

/** A small uppercase muted section label (the mockup's group headings: "PASEO-BM SITE · 3", "CONVERSATION"). */
export function SectionLabel({ children, theme }: { children: ReactNode; theme: Theme }) {
  return (
    <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12, fontWeight: "500", textTransform: "uppercase", letterSpacing: 0.72 }}>{children}</Text>
  );
}

/** The monospace family of the mockup's IBM Plex Mono, as the platform has it. */
export const MONO = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
