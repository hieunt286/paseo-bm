/**
 * The agent panel "Beads in this chat" (owner request 2026-09-16: "click a
 * bead id ... and see its content"): every bead the chat named recently,
 * newest mention first, each opening in place — for messages Paseo shows as
 * plain text. The bead chips a card once carried had no caller left and are
 * gone (code review 2026-09-30 §5). Client rules: React Native primitives
 * only, colours from the theme.
 */
import { type PluginAgentPanelProps, useRpc } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { ActivityIndicator, ScrollView, Text, View } from "react-native";
import { chatBeadsRpc } from "../shared/contracts";
import { BeadDetailPanel } from "./beads-screen";
import { statusBadge } from "./beads-model";
import { errorMessageOf } from "./errors";
import { dashboardStyles } from "./styles";
import { BeadRowCard, Button, Chip, ToneText } from "./ui";
import { localTimeText } from "./format";

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
  const now = new Date();
  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Text style={[styles.sectionTitle, { flex: 1 }]}>Beads in this chat</Text>
        <Button label="Refresh" kind="secondary" onPress={() => void beads.refetch()} styles={styles} />
      </View>
      {beads.isPending ? <ActivityIndicator color={styles.spinner.color} /> : null}
      {beads.isError ? <ToneText tone="danger" styles={styles} theme={theme}>{errorMessageOf(beads.error)}</ToneText> : null}
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
                  {`${mentions}× in chat${lastMentionedAt === null ? "" : ` · last ${localTimeText(new Date(lastMentionedAt), now)}`}`}
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
