/**
 * One chat card: a message between the Manager, a Worker and a Reviewer
 * (delta 20260916-chat-cards). Header with the sender's role icon, colour and
 * session name, the recipient, the request and its status; the full message as
 * Markdown on demand; and a reply that goes straight to the other agent.
 *
 * All wording and decisions live in `chat-cards.ts`, tested without a
 * renderer. Client rules: React Native primitives only, colours from the theme.
 */
import { type PluginTimelineItemProps, usePaseo, useRpc } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import { chatPeersRpc } from "../shared/contracts";
import {
  drawAsCard,
  markOf,
  markdownOf,
  partiesOf,
  partyName,
  quickReplies,
  replyText,
  roleName,
  statusChip,
  summaryOf,
  type ChatCard,
} from "./chat-cards";
import { ROLE_MARK, dashboardStyles, toneColor } from "./dashboard-model";
import { errorMessageOf } from "./launch-manager";
import { MarkdownView } from "./markdown-view";
import { Chip, RoleMark } from "./ui";
import { BeadChips } from "./bead-chips";
import { beadIdCandidates } from "../shared/bead-ids";

/** Peers change rarely; one lookup per chat is plenty. */
const PEERS_STALE_MS = 30_000;

function clock(date: Date): string {
  const two = (value: number) => String(value).padStart(2, "0");
  return Number.isNaN(date.getTime()) ? "" : `${two(date.getHours())}:${two(date.getMinutes())}`;
}

export function ChatCardView({ theme, layout, agentId, item, timestamp }: PluginTimelineItemProps<ChatCard>) {
  const card = item.data;
  const styles = useMemo(() => dashboardStyles(theme, layout.compact), [theme, layout.compact]);
  const paseo = usePaseo();
  const listPeers = useRpc(chatPeersRpc);
  const peers = useQuery({
    queryKey: ["paseo-bm", "chat-peers", agentId],
    queryFn: () => listPeers({ agentId }),
    staleTime: PEERS_STALE_MS,
  });
  const [open, setOpen] = useState(false);
  const [replying, setReplying] = useState(false);
  const [answer, setAnswer] = useState("");
  const [sending, setSending] = useState(false);
  const [outcome, setOutcome] = useState<{ text: string; tone: "success" | "danger" } | null>(null);

  const { from, to } = partiesOf(card, peers.data?.owner ?? null, peers.data?.peers ?? []);
  const counterpart = card.direction === "received" ? from : to;
  const fromMark = markOf(from.role);
  const colour = fromMark === null ? theme.colors.border : toneColor(theme, ROLE_MARK[fromMark].tone);
  const chip = statusChip(card);
  const canReply = counterpart.id !== null && counterpart.id !== agentId;
  const beadIds = useMemo(() => beadIdCandidates(card.text), [card.text]);
  const workspaceId = peers.data?.workspaceId ?? null;

  // Not a paseo-bm chat, or a block this agent only quoted: plain text, no card.
  if (peers.isSuccess && !drawAsCard(card, peers.data.owner)) {
    return (
      <View style={{ marginVertical: 4 }}>
        <MarkdownView source={card.text} theme={theme} compact={layout.compact} />
      </View>
    );
  }

  const send = async () => {
    if (counterpart.id === null || answer.trim() === "") return;
    setSending(true);
    setOutcome(null);
    try {
      await paseo.agents.ref(counterpart.id).send(replyText(card, answer));
      setOutcome({ text: `Sent to ${partyName(counterpart)}.`, tone: "success" });
      setAnswer("");
      setReplying(false);
    } catch (failure) {
      setOutcome({ text: errorMessageOf(failure), tone: "danger" });
    } finally {
      setSending(false);
    }
  };

  return (
    <View style={[styles.card, { gap: 6, borderLeftWidth: 3, borderLeftColor: colour, marginVertical: 4 }]}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        {fromMark === null ? null : <RoleMark kind={fromMark} theme={theme} />}
        <Text style={[styles.sectionTitle, { color: colour }]} numberOfLines={1}>
          {partyName(from)}
        </Text>
        <Text style={styles.body} numberOfLines={1}>
          {`→ ${partyName(to)}`}
        </Text>
        <View style={{ flex: 1 }} />
        {chip === null ? null : <Chip badge={chip} styles={styles} theme={theme} />}
        <Text style={styles.body}>{clock(timestamp)}</Text>
      </View>

      <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        {card.requestId === null ? null : <Chip badge={{ text: card.requestId, tone: "muted" }} styles={styles} theme={theme} />}
        <Text style={[styles.body, { flex: 1 }]} numberOfLines={open ? undefined : 2}>
          {summaryOf(card)}
        </Text>
      </View>

      {workspaceId === null || beadIds.length === 0 ? null : (
        <BeadChips workspaceId={workspaceId} ids={beadIds} styles={styles} theme={theme} />
      )}

      <View style={styles.chipRow}>
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded: open }}
          onPress={() => setOpen(!open)}
          style={styles.secondaryButton}
        >
          <Text style={styles.secondaryButtonText}>{open ? "▾ Hide message" : "▸ Show message"}</Text>
        </Pressable>
        {canReply ? (
          <Pressable accessibilityRole="button" onPress={() => setReplying(!replying)} style={styles.button}>
            <Text style={styles.buttonText}>{`Reply to ${roleName(counterpart.role)}`}</Text>
          </Pressable>
        ) : null}
      </View>

      {open ? (
        <View style={[styles.card, { backgroundColor: theme.colors.surface0 }]}>
          <MarkdownView source={markdownOf(card.text)} theme={theme} compact={layout.compact} />
        </View>
      ) : null}

      {replying && canReply ? (
        <View style={{ gap: 6 }}>
          {quickReplies(card).length === 0 ? null : (
            <View style={styles.chipRow}>
              {quickReplies(card).map((text) => (
                <Chip key={text} badge={{ text, tone: "info" }} onPress={() => setAnswer(text)} styles={styles} theme={theme} />
              ))}
            </View>
          )}
          <TextInput
            value={answer}
            onChangeText={setAnswer}
            multiline
            placeholder={`Your answer to ${partyName(counterpart)}${card.requestId === null ? "" : ` about ${card.requestId}`}`}
            placeholderTextColor={theme.colors.foregroundMuted}
            style={[styles.mono, { minHeight: 64, borderWidth: 1, borderColor: theme.colors.border, borderRadius: 8, padding: 8 }]}
          />
          <View style={styles.chipRow}>
            <Pressable
              accessibilityRole="button"
              disabled={sending || answer.trim() === ""}
              onPress={() => void send()}
              style={styles.button}
            >
              <Text style={styles.buttonText}>{sending ? "Sending…" : "Send"}</Text>
            </Pressable>
            <Pressable accessibilityRole="button" onPress={() => setReplying(false)} style={styles.secondaryButton}>
              <Text style={styles.secondaryButtonText}>Cancel</Text>
            </Pressable>
          </View>
        </View>
      ) : null}
      {outcome === null ? null : <Text style={[styles.body, { color: toneColor(theme, outcome.tone) }]}>{outcome.text}</Text>}
    </View>
  );
}
