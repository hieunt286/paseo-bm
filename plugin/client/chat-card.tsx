/**
 * One chat card: a message between the Manager, a Worker and a Reviewer
 * (delta 20260916-chat-cards). Header with the sender's role icon, colour and
 * session name, the recipient, the request and its status; the full message as
 * Markdown on demand; and a reply that goes straight to the other agent.
 *
 * A received report that carries a `BM-QUESTIONS` block also shows its
 * questions with option buttons, and sends the chosen answers to the asking
 * Worker (delta 20260918c-question-cards §4.4).
 *
 * All wording and decisions live in `chat-cards.ts`, tested without a
 * renderer. Client rules: React Native primitives only, colours from the theme.
 */
import { type PluginTimelineItemProps, usePaseo, useRpc } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import { chatPeersRpc, type ChatPeer } from "../shared/contracts";
import type { Question } from "../shared/bm-questions";
import {
  answerSummary,
  answeredKey,
  choosable,
  drawAsCard,
  formComplete,
  markOf,
  markdownOf,
  partiesOf,
  partyName,
  quickReplies,
  recommendedPicks,
  replyText,
  roleName,
  sendAnswers,
  showsQuestions,
  statusChip,
  summaryOf,
  topicOf,
  type ChatCard,
  type Picks,
} from "./chat-cards";
import { ROLE_MARK, dashboardStyles, toneColor } from "./dashboard-model";
import { errorMessageOf } from "./launch-manager";
import { MarkdownView } from "./markdown-view";
import { Chip, RoleMark } from "./ui";
import { BeadChips } from "./bead-chips";
import { beadIdCandidates } from "../shared/bead-ids";

/** Peers change rarely; one lookup per chat is plenty. */
const PEERS_STALE_MS = 30_000;

/**
 * Questions answered from a card in this app session, by `answeredKey`. The
 * chat list may unmount a card while scrolling, so this cannot live in the
 * card's own state; it is not kept across a reload (REQ-059d).
 */
const answered = new Map<string, { at: Date; summary: string; to: string }>();

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
        {/* Two lines at most, also while the message is open: the full text is right below (Q50). */}
        <Text style={[styles.body, { flex: 1 }]} numberOfLines={2}>
          {summaryOf(card)}
        </Text>
      </View>

      {workspaceId === null || beadIds.length === 0 ? null : (
        <BeadChips workspaceId={workspaceId} ids={beadIds} styles={styles} theme={theme} />
      )}

      {peers.isSuccess && showsQuestions(card, peers.data.owner) ? (
        <QuestionForm
          card={card}
          agentId={agentId}
          styles={styles}
          theme={theme}
          recipient={partyName(from)}
          refreshPeers={async () => {
            const fresh = await peers.refetch({ throwOnError: true });
            return { owner: fresh.data?.owner ?? null, peers: fresh.data?.peers ?? [] };
          }}
          send={(id, text) => paseo.agents.ref(id).send(text).then(() => undefined)}
        />
      ) : null}

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

type Styles = ReturnType<typeof dashboardStyles>;
type Theme = PluginTimelineItemProps<ChatCard>["theme"];

/**
 * The questions of a Worker's `blocked` report, answered with one tap per
 * question. Nothing is pre-selected; "Use recommendations" fills the Worker's
 * recommendations in and sends nothing.
 */
function QuestionForm({
  card,
  agentId,
  styles,
  theme,
  recipient,
  refreshPeers,
  send,
}: {
  card: ChatCard;
  agentId: string;
  styles: Styles;
  theme: Theme;
  recipient: string;
  refreshPeers: () => Promise<{ owner: ChatPeer | null; peers: ChatPeer[] }>;
  send: (agentId: string, text: string) => Promise<void>;
}) {
  const key = answeredKey(agentId, card);
  const [picks, setPicks] = useState<Picks>({});
  const [sending, setSending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [done, setDone] = useState(() => answered.get(key) ?? null);

  if (done !== null) {
    return (
      <Text style={[styles.body, { color: toneColor(theme, "success") }]}>
        {`Answered at ${clock(done.at)} → ${done.to}: ${done.summary}`}
      </Text>
    );
  }

  const pick = (question: Question, next: Picks[string]) => {
    setProblem(null);
    setPicks({ ...picks, [question.id]: next });
  };
  const complete = formComplete(card.questions, picks);

  const submit = async () => {
    setSending(true);
    setProblem(null);
    const result = await sendAnswers({ card, picks, refreshPeers, send });
    setSending(false);
    if (!result.ok) {
      setProblem(result.reason);
      return;
    }
    const record = {
      at: new Date(),
      summary: answerSummary(card.questions, picks),
      to: partyName({ role: "worker", id: result.to.id, title: result.to.title }),
    };
    answered.set(key, record);
    setDone(record);
  };

  return (
    <View style={{ gap: 8 }}>
      {card.questions.map((question) => {
        const { topic, rest } = topicOf(question);
        const current = picks[question.id];
        const other = current !== undefined && "other" in current ? current : null;
        return (
          <View key={question.id} style={{ gap: 4 }}>
            <Text style={styles.mono}>
              <Text style={{ fontWeight: "600" }}>{`${question.id} `}</Text>
              {topic === null ? null : <Text style={{ fontWeight: "600" }}>{`${topic} — `}</Text>}
              {rest}
            </Text>
            {choosable(question)
              ? question.options.map((option) => {
                  const selected = current !== undefined && "key" in current && current.key === option.key;
                  return (
                    <Pressable
                      key={option.key}
                      accessibilityRole="button"
                      accessibilityState={{ selected }}
                      onPress={() => pick(question, { key: option.key })}
                      style={{
                        flexDirection: "row",
                        alignItems: "center",
                        flexWrap: "wrap",
                        gap: 6,
                        paddingVertical: 4,
                        paddingHorizontal: 8,
                        borderRadius: 6,
                        borderWidth: 1,
                        borderColor: selected ? toneColor(theme, "info") : theme.colors.border,
                        backgroundColor: selected ? theme.colors.surface2 : "transparent",
                      }}
                    >
                      <Text style={[styles.body, { flexShrink: 1 }]}>{`${selected ? "●" : "○"} ${option.key} — ${option.text}`}</Text>
                      {option.recommended ? <Chip badge={{ text: "recommended", tone: "success" }} styles={styles} theme={theme} /> : null}
                    </Pressable>
                  );
                })
              : null}
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ selected: other !== null }}
              onPress={() => pick(question, { other: other?.other ?? "" })}
              style={styles.secondaryButton}
            >
              <Text style={styles.secondaryButtonText}>{`${other !== null ? "●" : "○"} Other…`}</Text>
            </Pressable>
            {other === null ? null : (
              <TextInput
                value={other.other}
                onChangeText={(text) => pick(question, { other: text })}
                multiline
                placeholder={`Your answer to ${question.id}`}
                placeholderTextColor={theme.colors.foregroundMuted}
                style={[styles.mono, { minHeight: 48, borderWidth: 1, borderColor: theme.colors.border, borderRadius: 8, padding: 8 }]}
              />
            )}
          </View>
        );
      })}
      <Text style={styles.body}>{`Answers go to ${recipient}${card.requestId === null ? "" : ` · ${card.requestId}`}`}</Text>
      <View style={styles.chipRow}>
        <Pressable accessibilityRole="button" onPress={() => setPicks(recommendedPicks(card.questions, picks))} style={styles.secondaryButton}>
          <Text style={styles.secondaryButtonText}>Use recommendations</Text>
        </Pressable>
        <Pressable accessibilityRole="button" onPress={() => setPicks({})} style={styles.secondaryButton}>
          <Text style={styles.secondaryButtonText}>Clear</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ disabled: sending || !complete }}
          disabled={sending || !complete}
          onPress={() => void submit()}
          style={[styles.button, { opacity: sending || !complete ? 0.5 : 1 }]}
        >
          <Text style={styles.buttonText}>{sending ? "Sending…" : `Send answers to ${recipient}`}</Text>
        </Pressable>
      </View>
      {problem === null ? null : <Text style={[styles.body, { color: toneColor(theme, "danger") }]}>{problem}</Text>}
    </View>
  );
}
