/**
 * Beads named in a chat, as chips that open the bead in place
 * (owner request 2026-09-16: "click vào mã beads ... xem đc nội dung").
 *
 * `BeadChips` sits inside a chat card; `ChatBeadsPanel` is the agent panel
 * that lists every bead the chat named recently, for messages Paseo shows as
 * plain text. Client rules: React Native primitives only, colours from the
 * theme.
 */
import { type PluginAgentPanelProps, useRpc } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, Text, View } from "react-native";
import { beadsLookupRpc, chatBeadsRpc, type BeadRow } from "../shared/contracts";
import { BeadDetailPanel } from "./beads-screen";
import { beadChipText, formatClock, statusBadge } from "./beads-model";
import { beadChipsView } from "./chat-cards";
import { dashboardStyles, toneColor } from "./dashboard-model";
import { errorMessageOf } from "./launch-manager";
import { BeadRowCard, Chip, beadTitleStyle, type Styles, type Theme } from "./ui";

/**
 * Chips for the ids a message names; only ids the bead store has are shown.
 * All candidates are looked up first; then two chips, and a "…" chip for the
 * rest found (delta 20260918f F10).
 */
export function BeadChips({
  workspaceId,
  ids,
  expanded,
  onExpand,
  styles,
  theme,
}: {
  workspaceId: string;
  ids: readonly string[];
  expanded: boolean;
  onExpand: () => void;
  styles: Styles;
  theme: Theme;
}) {
  const lookup = useRpc(beadsLookupRpc);
  const found = useQuery({
    queryKey: ["paseo-bm", "bead-lookup", workspaceId, ids.join(" ")],
    queryFn: () => lookup({ workspaceId, ids: ids.slice(0, 100) }),
    enabled: ids.length > 0,
    staleTime: 30_000,
  });
  const [openId, setOpenId] = useState<string | null>(null);
  const beads = found.data?.beads ?? [];
  const view = beadChipsView(beads, expanded);
  if (view.shown.length === 0) return null;
  const open = beads.find((bead) => bead.id === openId);
  return (
    <View style={{ gap: 6 }}>
      <View style={styles.chipRow}>
        {view.shown.map((bead) => (
          <Chip
            key={bead.id}
            badge={{ text: beadChipText(bead), tone: statusBadge(bead).tone }}
            selected={bead.id === openId}
            onPress={() => setOpenId(bead.id === openId ? null : bead.id)}
            styles={styles}
            theme={theme}
          />
        ))}
      </View>
      {open === undefined ? null : <BeadInline workspaceId={workspaceId} bead={open} styles={styles} theme={theme} />}
      {/* Two chips, then "…" on the next line for the rest (delta 20260918d §4.7). */}
      {view.hidden === 0 ? null : (
        <View style={styles.chipRow}>
          <Pressable accessibilityRole="button" accessibilityLabel={`Show all ${beads.length} beads`} onPress={onExpand}>
            <Chip badge={{ text: "…", tone: "muted" }} styles={styles} theme={theme} />
          </Pressable>
        </View>
      )}
    </View>
  );
}

function BeadInline({ workspaceId, bead, styles, theme }: { workspaceId: string; bead: BeadRow; styles: Styles; theme: Theme }) {
  return (
    <View style={[styles.card, { backgroundColor: theme.colors.surface0, gap: 2 }]}>
      <Text style={beadTitleStyle(styles, theme, null)}>{bead.title ?? "(untitled)"}</Text>
      <Text style={[styles.body, { fontSize: 12 }]} selectable>
        {`${bead.id} · ${statusBadge(bead).text}`}
      </Text>
      <BeadDetailPanel workspaceId={workspaceId} bead={bead} styles={styles} theme={theme} />
    </View>
  );
}

/** Agent panel: the beads this chat named recently, newest mention first. */
export function ChatBeadsPanel({ theme, layout, workspaceId, agentId }: PluginAgentPanelProps) {
  const styles = useMemo(() => dashboardStyles(theme, layout.compact), [theme, layout.compact]);
  const list = useRpc(chatBeadsRpc);
  const beads = useQuery({
    queryKey: ["paseo-bm", "chat-beads", workspaceId, agentId],
    queryFn: () => list({ workspaceId, agentId }),
    refetchInterval: 15_000,
  });
  const [openId, setOpenId] = useState<string | null>(null);
  const rows = beads.data?.beads ?? [];
  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Text style={[styles.sectionTitle, { flex: 1 }]}>Beads in this chat</Text>
        <Pressable accessibilityRole="button" onPress={() => void beads.refetch()} style={styles.secondaryButton}>
          <Text style={styles.secondaryButtonText}>Refresh</Text>
        </Pressable>
      </View>
      {beads.isPending ? <ActivityIndicator color={styles.spinner.color} /> : null}
      {beads.isError ? <Text style={[styles.body, { color: toneColor(theme, "danger") }]}>{errorMessageOf(beads.error)}</Text> : null}
      {beads.data !== undefined && rows.length === 0 ? (
        <Text style={styles.body}>No bead of this workspace is named in the recent messages of this chat.</Text>
      ) : null}
      {rows.map(({ bead, mentions, lastMentionedAt }) => {
        const open = bead.id === openId;
        return (
          <BeadRowCard
            key={bead.id}
            bead={bead}
            open={open}
            onToggle={() => setOpenId(open ? null : bead.id)}
            styles={styles}
            theme={theme}
            meta={
              <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap", marginTop: 2 }}>
                <Text style={[styles.body, { fontSize: 12 }]} selectable>
                  {bead.id}
                </Text>
                <Text style={[styles.body, { fontSize: 12, flex: 1 }]}>
                  {`${mentions}× in chat${lastMentionedAt === null ? "" : ` · last ${formatClock(lastMentionedAt)}`}`}
                </Text>
                <Chip badge={statusBadge(bead)} styles={styles} theme={theme} />
              </View>
            }
            detail={<BeadDetailPanel workspaceId={workspaceId} bead={bead} styles={styles} theme={theme} />}
          />
        );
      })}
      {beads.data === undefined ? null : (
        <Text style={[styles.body, { fontSize: 11 }]}>{`Read from the last ${beads.data.scannedItems} items of this chat.`}</Text>
      )}
    </ScrollView>
  );
}
