/**
 * The shell of the Beads Manager surface (change-014 fidelity pass, the
 * approved mockup's `<header>`): one 56px bar on `surface1` with a bottom
 * border, drawn above every section — the brand (a 2×2 square mark in the
 * accent and "Beads Manager"), the section nav as underline text tabs (Inbox
 * with its count as a badge, Projects, Settings, Tools & skills), and at the
 * right the Orchestrator's status: an 8px square and "Orchestrator idle · N
 * projects watched", or "Orchestrator not open" with a text button "Start…"
 * that runs the start flow of the Inbox line (`useOrchestratorActions`).
 * What that flow has to say — its confirm dialog, a warning, a note, an
 * error — is drawn in a strip under the bar, only while there is something.
 *
 * On a phone (`compact`, the MobileInbox artboard) the bar is two rows: a
 * 48px row with the brand and the short status ("Orchestrator idle", or "not
 * open" with "Start…"), then the section nav as four equal 44px tabs, Tools &
 * skills labelled "Tools" (its accessibility label unchanged).
 *
 * Client rules: React Native primitives only, colours from the theme,
 * accessibility roles and labels on every pressable.
 */
import { type PluginSurfaceProps, useRpc } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { Pressable, Text, View } from "react-native";
import { autonomyPolicyRpc } from "../shared/contracts";
import { useOrchestratorActions } from "./orchestrator-line";
import { orchestratorHeaderView, type OrchestratorHeaderView } from "./orchestrator-model";
import { AUTONOMY_POLICY_KEY } from "./settings-autonomy-model";
import { dashboardStyles } from "./styles";
import { TextTabs, type TextTab } from "./text-tabs";
import { ConfirmBlock, ToneText, type Theme } from "./ui";

/** The bar's height (the mockup's 56px) plus its 1px bottom border: RN boxes include the border. */
export const SHELL_HEADER_HEIGHT = 56;
/** The phone's first row (the MobileInbox artboard's 48px header). */
export const COMPACT_HEADER_HEIGHT = 48;
/** The phone's section nav: four equal tabs, 44px tall. */
export const COMPACT_NAV_HEIGHT = 44;
/** How often the header re-reads `orchestrator.state`: it stays on screen, so slower than Work's rows. */
export const HEADER_STATE_POLL_MS = 30_000;

/** The brand mark: four 6px squares outlined in the accent on an 18px grid (the mockup's SVG). */
function BrandMark({ theme }: { theme: Theme }) {
  const square = { width: 6, height: 6, borderWidth: 1.5, borderColor: theme.colors.accent };
  return (
    <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={{ width: 18, height: 18, padding: 2, gap: 2 }}>
      <View style={{ flexDirection: "row", gap: 2 }}>
        <View style={square} />
        <View style={square} />
      </View>
      <View style={{ flexDirection: "row", gap: 2 }}>
        <View style={square} />
        <View style={square} />
      </View>
    </View>
  );
}

/** The phone's status: only what the Orchestrator is, without the count of watched projects. */
export function compactStatusText(text: string): string {
  return text.split(" · ")[0] ?? text;
}

/** The section tabs as a phone shows them: the short "Tools", read out as "Tools & skills". */
export function compactTabs(tabs: readonly TextTab[]): TextTab[] {
  return tabs.map((tab) =>
    tab.key === "tools" ? { ...tab, label: "Tools", accessibilityLabel: tab.accessibilityLabel ?? tab.label } : tab,
  );
}

/** The right side of the bar, hook-free: the square, the status, and the text button when there is one. */
export function OrchestratorStatus({
  view,
  busy,
  onPress,
  theme,
  compact = false,
}: {
  view: OrchestratorHeaderView | null;
  busy: boolean;
  onPress: () => void;
  theme: Theme;
  compact?: boolean;
}) {
  const { colors } = theme;
  if (view === null) return null;
  const dot = <View style={{ width: 8, height: 8, backgroundColor: view.dot === "accent" ? colors.accent : colors.foregroundMuted }} />;
  const text = (
    <Text style={{ color: colors.foregroundMuted, fontSize: compact ? 12 : 13, flexShrink: 1 }} numberOfLines={1}>
      {compact ? compactStatusText(view.text) : view.text}
    </Text>
  );
  return (
    <View style={{ marginLeft: "auto", flexDirection: "row", alignItems: "center", gap: compact ? 6 : 8, flexShrink: 1, minWidth: 0 }}>
      {view.button === null && view.agentId !== null ? (
        // An Orchestrator that needs nothing: the status itself is the way into its chat.
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Orchestrator chat. ${view.text}`}
          accessibilityState={{ disabled: busy, busy }}
          disabled={busy}
          onPress={onPress}
          style={{ flexDirection: "row", alignItems: "center", gap: compact ? 6 : 8, flexShrink: 1 }}
        >
          {dot}
          {text}
        </Pressable>
      ) : (
        <>
          {dot}
          {text}
        </>
      )}
      {view.button === null ? null : (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={view.action === "start" ? "Start the Orchestrator" : view.button.replace(/…/g, "").trim()}
          accessibilityState={{ disabled: busy, busy }}
          disabled={busy}
          onPress={onPress}
          style={{ paddingVertical: 4, paddingHorizontal: 4, opacity: busy ? 0.5 : 1, flexShrink: compact ? 1 : 0 }}
        >
          <Text style={{ color: colors.foregroundMuted, fontSize: compact ? 12 : 13, textDecorationLine: "underline" }} numberOfLines={1}>
            {busy ? "Opening…" : view.button}
          </Text>
        </Pressable>
      )}
    </View>
  );
}

/**
 * The bar itself, hook-free: one 56px row on a wide screen; on a phone the
 * 48px brand-and-status row, then the four equal section tabs.
 */
export function ShellHeaderBar({
  tabs,
  selected,
  onSelect,
  view,
  busy,
  onPress,
  theme,
  compact,
}: {
  tabs: readonly TextTab[];
  selected: string;
  onSelect: (key: string) => void;
  view: OrchestratorHeaderView | null;
  busy: boolean;
  onPress: () => void;
  theme: Theme;
  compact: boolean;
}) {
  const { colors } = theme;
  if (compact) {
    return (
      <View style={{ backgroundColor: colors.surface1, borderBottomWidth: 1, borderBottomColor: colors.border }}>
        <View style={{ height: COMPACT_HEADER_HEIGHT, flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 16 }}>
          <BrandMark theme={theme} />
          <Text style={{ color: colors.foreground, fontSize: 15, fontWeight: "600" }} numberOfLines={1}>
            Beads Manager
          </Text>
          <OrchestratorStatus view={view} busy={busy} onPress={onPress} theme={theme} compact />
        </View>
        <TextTabs tabs={compactTabs(tabs)} selected={selected} onSelect={onSelect} theme={theme} height={COMPACT_NAV_HEIGHT} fill />
      </View>
    );
  }
  return (
    <View
      style={{
        height: SHELL_HEADER_HEIGHT + 1,
        flexDirection: "row",
        alignItems: "center",
        gap: 32,
        paddingHorizontal: 32,
        borderBottomWidth: 1,
        borderBottomColor: colors.border,
        backgroundColor: colors.surface1,
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
        <BrandMark theme={theme} />
        <Text style={{ color: colors.foreground, fontSize: 15, fontWeight: "600" }}>Beads Manager</Text>
      </View>
      <TextTabs tabs={tabs} selected={selected} onSelect={onSelect} theme={theme} height={SHELL_HEADER_HEIGHT} />
      <OrchestratorStatus view={view} busy={busy} onPress={onPress} theme={theme} />
    </View>
  );
}

/** The header bar and, under it, what the Orchestrator's start flow has to say. */
export function ShellHeader({
  tabs,
  selected,
  onSelect,
  theme,
  compact,
  navigation,
}: {
  tabs: readonly TextTab[];
  selected: string;
  onSelect: (key: string) => void;
  theme: Theme;
  compact: boolean;
  navigation: PluginSurfaceProps["navigation"];
}) {
  const { colors } = theme;
  const actions = useOrchestratorActions(navigation, HEADER_STATE_POLL_MS);
  const readPolicy = useRpc(autonomyPolicyRpc);
  // The same query Settings and Work read, so a level set there is counted here.
  const policy = useQuery({ queryKey: AUTONOMY_POLICY_KEY, queryFn: () => readPolicy({}) });
  const styles = useMemo(() => dashboardStyles(theme, compact), [theme, compact]);
  const view = actions.state === undefined ? null : orchestratorHeaderView(actions.state, policy.data?.levels, new Date());
  const strip =
    actions.dialog !== null || actions.note !== null || actions.error !== null || (view !== null && (view.warning !== null || view.replaced !== null));

  return (
    <View>
      <ShellHeaderBar
        tabs={tabs}
        selected={selected}
        onSelect={onSelect}
        view={view}
        busy={actions.busy}
        onPress={() => view !== null && actions.press(view.action, view.agentId)}
        theme={theme}
        compact={compact}
      />
      {!strip ? null : (
        <View
          style={{
            gap: 6,
            paddingVertical: 12,
            paddingHorizontal: compact ? 16 : 32,
            borderBottomWidth: 1,
            borderBottomColor: colors.border,
            backgroundColor: colors.surface1,
          }}
        >
          {view?.warning == null ? null : <ToneText tone="warning" styles={styles} theme={theme}>{view.warning}</ToneText>}
          {view?.replaced == null ? null : <Text style={styles.body}>{view.replaced}</Text>}
          {actions.dialog === null ? null : (
            <ConfirmBlock dialog={actions.dialog} busy={actions.busy} busyLabel="Opening…" onConfirm={actions.confirm} onCancel={actions.cancel} styles={styles} theme={theme} />
          )}
          {actions.note === null ? null : <Text style={styles.body}>{actions.note}</Text>}
          {actions.error === null ? null : <ToneText tone="danger" styles={styles} theme={theme}>{actions.error}</ToneText>}
        </View>
      )}
    </View>
  );
}
