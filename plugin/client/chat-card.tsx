/**
 * Chat cards v2 (autonomy design §A.12, experience concept §5): every
 * paseo-bm message in a chat is drawn in one frame (`CardFrame`, `ui.tsx`) —
 * `decision`, `progress`, `finished`, `verdict`, `brief`, `action` — or as one
 * compact line (`notice`).
 *
 * A decision card is live: it reads its decision from the store by id
 * (`decisions.get`) every `DECISION_POLL_MS` while it can still be answered,
 * and answers through `decisions.answer` with `via: chat-card`. Every copy of
 * one decision (the Worker's chat, the Manager's, the Orchestrator's, the
 * Inbox) shares one query, so answering anywhere shows answered everywhere.
 * There is no reply box and no other question UI.
 *
 * All wording and decisions live in `chat-cards.ts`, tested without a
 * renderer; `DecisionCardBody` is hook-free, so tests expand it too. Client
 * rules: React Native primitives only, colours from the theme.
 */
import { type PluginTimelineItemProps, useRpc } from "@getpaseo/plugin/client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState, type ReactNode } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import { chatPeersRpc, decisionsAnswerRpc, decisionsConfirmRpc, decisionsGetRpc, type ChatPeer } from "../shared/contracts";
import type { Decision } from "../shared/decisions";
import {
  DECISION_UI_IDLE,
  OWN_WORDS,
  cardFrameOf,
  choiceNeedsConfirmation,
  decisionCardView,
  decisionLookupOf,
  decisionPollMs,
  detailLinesOf,
  drawAsCard,
  fallbackMarkdown,
  markdownOf,
  noticeLine,
  runDecisionAnswer,
  runDecisionConfirm,
  type ChatCard,
  type DecisionCardView,
  type DecisionChoice,
  type DecisionUi,
} from "./chat-cards";
import { dashboardStyles } from "./dashboard-model";
import { MarkdownView } from "./markdown-view";
import { CardFrame, CompactLine, ConfirmBlock, type Styles, type Theme } from "./ui";

/** Peers change rarely; one lookup per chat is plenty. */
const PEERS_STALE_MS = 30_000;

/** One decision's state, shared by every card that shows it (the chats and the Inbox). */
export const decisionQueryKey = (id: string) => ["paseo-bm", "decision", id] as const;

export function ChatCardView(props: PluginTimelineItemProps<ChatCard>) {
  switch (props.item.data.type) {
    case "notice":
      return <NoticeLineView {...props} />;
    case "decision":
      return <DecisionChatCard {...props} />;
    default:
      return <MessageCardView {...props} />;
  }
}

/** Who the chat is: its owner and its peers, read once per chat. */
function useChatPeers(agentId: string) {
  const listPeers = useRpc(chatPeersRpc);
  return useQuery({
    queryKey: ["paseo-bm", "chat-peers", agentId],
    queryFn: () => listPeers({ agentId }),
    staleTime: PEERS_STALE_MS,
  });
}

/** Details: the machine facts, then the whole message as Markdown. */
function DetailsBody({ lines, text, styles, theme, compact }: { lines: string[]; text: string; styles: Styles; theme: Theme; compact: boolean }) {
  return (
    <>
      {lines.map((line, index) => (
        <Text key={`${index}:${line}`} style={styles.mono} selectable>
          {line}
        </Text>
      ))}
      {text.trim() === "" ? null : <MarkdownView source={markdownOf(text)} theme={theme} compact={compact} />}
    </>
  );
}

/** A `progress`, `finished`, `verdict`, `brief` or `action` card. */
function MessageCardView({ theme, layout, agentId, item, timestamp }: PluginTimelineItemProps<ChatCard>) {
  const card = item.data;
  const styles = useMemo(() => dashboardStyles(theme, layout.compact), [theme, layout.compact]);
  const peers = useChatPeers(agentId);
  const [details, setDetails] = useState(false);
  const owner = peers.data?.owner ?? null;

  // Not a paseo-bm chat, or a block this agent only quoted: plain text, no card.
  if (peers.isSuccess && !drawAsCard(card, owner)) {
    return (
      <View style={{ marginVertical: 4 }}>
        <MarkdownView source={fallbackMarkdown(card)} theme={theme} compact={layout.compact} />
      </View>
    );
  }
  const view = cardFrameOf(card, { owner, peers: peers.data?.peers ?? [], at: timestamp, now: new Date() });
  return (
    <CardFrame
      view={view}
      detailsOpen={details}
      onToggleDetails={() => setDetails(!details)}
      details={<DetailsBody lines={detailLinesOf(card, owner)} text={card.text} styles={styles} theme={theme} compact={layout.compact} />}
      styles={styles}
      theme={theme}
    />
  );
}

/** A plugin notice: one compact line, the whole notice on a tap. */
function NoticeLineView({ theme, layout, item, timestamp }: PluginTimelineItemProps<ChatCard>) {
  const card = item.data;
  const styles = useMemo(() => dashboardStyles(theme, layout.compact), [theme, layout.compact]);
  const [expanded, setExpanded] = useState(false);
  return (
    <CompactLine
      tone={card.notice?.tone ?? "muted"}
      text={noticeLine(card, timestamp, new Date())}
      expanded={expanded}
      onToggle={() => setExpanded(!expanded)}
      details={
        <Text style={styles.mono} selectable>
          {card.text}
        </Text>
      }
      styles={styles}
      theme={theme}
    />
  );
}

/** A decision in a chat: the chat's peers name the asker; the card itself is `DecisionCard`. */
function DecisionChatCard({ theme, layout, agentId, item, timestamp }: PluginTimelineItemProps<ChatCard>) {
  const card = item.data;
  const peers = useChatPeers(agentId);
  const owner = peers.data?.owner ?? null;
  if (peers.isSuccess && !drawAsCard(card, owner)) {
    return (
      <View style={{ marginVertical: 4 }}>
        <MarkdownView source={fallbackMarkdown(card)} theme={theme} compact={layout.compact} />
      </View>
    );
  }
  const agents = owner === null ? (peers.data?.peers ?? []) : [owner, ...(peers.data?.peers ?? [])];
  return <DecisionCard card={card} via="chat-card" agents={agents} at={timestamp} theme={theme} compact={layout.compact} />;
}

/**
 * One decision, live from the store: the chats' decision card, and the card
 * the Inbox draws (`via: "inbox"`, with `initial` from `decisions.list`).
 * Hooks here; everything drawn comes from `decisionCardView`.
 */
export function DecisionCard({
  card,
  via,
  agents,
  at,
  initial,
  poll = true,
  onSettled,
  theme,
  compact,
}: {
  /** A `decision` card (`decisionCardOf` builds one from a seed alone). */
  card: ChatCard;
  via: "inbox" | "chat-card";
  /** The agents the card may name: a chat's owner and peers. */
  agents: readonly ChatPeer[];
  /** When the card's message arrived: bounds the lookup of a decision not recorded yet. */
  at: Date;
  /** The decision as a list already read it. */
  initial?: Decision;
  /**
   * False when a list keeps this decision's query current (the Inbox writes
   * each read of `decisions.list` into it): the card then reads nothing itself.
   */
  poll?: boolean;
  /** Told the decision as the owner's tap on this card left it. */
  onSettled?: (decision: Decision) => void;
  theme: Theme;
  compact: boolean;
}) {
  const id = card.decision?.id ?? "";
  const styles = useMemo(() => dashboardStyles(theme, compact), [theme, compact]);
  const queryClient = useQueryClient();
  const getDecision = useRpc(decisionsGetRpc);
  const answer = useRpc(decisionsAnswerRpc);
  const confirmChat = useRpc(decisionsConfirmRpc);
  const query = useQuery({
    queryKey: decisionQueryKey(id),
    queryFn: () => getDecision({ id }),
    enabled: id !== "",
    retry: false,
    ...(initial === undefined ? {} : { initialData: { decision: initial } }),
    ...(poll
      ? {
          // Five seconds while it can still be answered; never once it is settled.
          refetchInterval: (current: { state: { data?: { decision: Decision }; error?: unknown } }) =>
            decisionPollMs(decisionLookupOf({ data: current.state.data, error: current.state.error }), at, new Date()),
        }
      : { staleTime: Number.POSITIVE_INFINITY }),
  });
  const [ui, setUi] = useState<DecisionUi>(DECISION_UI_IDLE);
  const [details, setDetails] = useState(false);
  const lookup = decisionLookupOf({ data: query.data, error: query.error });
  const view = decisionCardView({ card, lookup, agents, ui, cardAt: at, now: new Date() });
  const decision = lookup.state === "found" ? lookup.decision : null;

  const settle = (next: Decision) => {
    queryClient.setQueryData(decisionQueryKey(id), { decision: next });
    onSettled?.(next);
  };

  const send = async (choice: DecisionChoice, confirmed: boolean) => {
    setUi({ ...ui, confirming: null, busy: true, error: null });
    const result = await runDecisionAnswer({ id, choice, confirmed, via, answer });
    if (result.ok) {
      settle(result.decision);
      setUi(DECISION_UI_IDLE);
      return;
    }
    setUi({ ...ui, confirming: null, busy: false, error: result.reason });
    // Refused because it moved on (answered elsewhere, superseded): show where it is now.
    void queryClient.invalidateQueries({ queryKey: decisionQueryKey(id) });
  };

  // A tap on an option: straight to `decisions.answer`, or first the confirmation (X-4).
  const choose = (choice: DecisionChoice) => {
    if (decision === null) return;
    if (choiceNeedsConfirmation(decision, choice)) {
      setUi({ ...ui, confirming: "optionKey" in choice ? choice.optionKey : OWN_WORDS, error: null });
      return;
    }
    void send(choice, false);
  };

  const confirmed = () => {
    if (ui.confirming === null) return;
    void send(ui.confirming === OWN_WORDS ? { words: ui.words ?? "" } : { optionKey: ui.confirming }, true);
  };

  const closeInChat = async (answered: boolean) => {
    setUi({ ...ui, busy: true, error: null });
    const result = await runDecisionConfirm({ id, answered, confirm: confirmChat });
    if (result.ok) {
      settle(result.decision);
      setUi(DECISION_UI_IDLE);
      return;
    }
    setUi({ ...ui, busy: false, error: result.reason });
    void queryClient.invalidateQueries({ queryKey: decisionQueryKey(id) });
  };

  return (
    <DecisionCardBody
      view={view}
      ui={ui}
      detailsOpen={details}
      onToggleDetails={() => setDetails(!details)}
      onChoose={(key) => choose({ optionKey: key })}
      onOpenWords={() => setUi({ ...ui, words: "", error: null })}
      onWords={(words) => setUi({ ...ui, words })}
      onSendWords={() => choose({ words: ui.words ?? "" })}
      onCancel={() => setUi({ ...DECISION_UI_IDLE })}
      onConfirm={confirmed}
      onCloseInChat={(answered) => void closeInChat(answered)}
      text={card.text}
      styles={styles}
      theme={theme}
      compact={compact}
    />
  );
}

/**
 * What a decision card draws, from its view: the frame, then the options (the
 * recommended one the primary action), "Own words…", the in-place
 * confirmation with Cancel first, or the two buttons of a decision that needs
 * confirmation. Hook-free.
 */
export function DecisionCardBody({
  view,
  ui,
  detailsOpen,
  onToggleDetails,
  onChoose,
  onOpenWords,
  onWords,
  onSendWords,
  onCancel,
  onConfirm,
  onCloseInChat,
  text,
  styles,
  theme,
  compact,
}: {
  view: DecisionCardView;
  ui: DecisionUi;
  detailsOpen: boolean;
  onToggleDetails: () => void;
  onChoose: (key: string) => void;
  onOpenWords: () => void;
  onWords: (words: string) => void;
  onSendWords: () => void;
  onCancel: () => void;
  onConfirm: () => void;
  onCloseInChat: (answered: boolean) => void;
  text: string;
  styles: Styles;
  theme: Theme;
  compact: boolean;
}) {
  const off = ui.busy;
  const actions: ReactNode[] = [];
  if (view.confirm !== null) {
    actions.push(
      <ConfirmBlock
        key="confirm"
        dialog={view.confirm}
        busy={ui.busy}
        busyLabel="Sending…"
        onConfirm={onConfirm}
        onCancel={onCancel}
        styles={styles}
        theme={theme}
      />,
    );
  }
  if (view.options.length > 0) {
    actions.push(
      <View key="options" style={styles.chipRow}>
        {view.options.map((option) => (
          <Pressable
            key={option.key}
            accessibilityRole="button"
            accessibilityLabel={option.accessibilityLabel}
            accessibilityState={{ disabled: off }}
            disabled={off}
            onPress={() => onChoose(option.key)}
            style={[option.primary ? styles.button : styles.secondaryButton, { opacity: off ? 0.5 : 1 }]}
          >
            <Text style={option.primary ? styles.buttonText : styles.secondaryButtonText}>{option.label}</Text>
          </Pressable>
        ))}
      </View>,
    );
  }
  if (view.ownWords && view.confirm === null) {
    actions.push(
      ui.words === null ? (
        <View key="words" style={styles.chipRow}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Answer in your own words"
            accessibilityState={{ disabled: off }}
            disabled={off}
            onPress={onOpenWords}
            style={styles.secondaryButton}
          >
            <Text style={styles.secondaryButtonText}>Own words…</Text>
          </Pressable>
        </View>
      ) : (
        <View key="words" style={{ gap: 6 }}>
          <TextInput
            value={ui.words}
            onChangeText={onWords}
            editable={!off}
            multiline
            accessibilityLabel="Your answer in your own words"
            placeholder="Your answer"
            placeholderTextColor={theme.colors.foregroundMuted}
            style={[styles.mono, { minHeight: 56, borderWidth: 1, borderColor: theme.colors.border, borderRadius: 8, padding: 8 }]}
          />
          <View style={styles.chipRow}>
            <Pressable accessibilityRole="button" accessibilityLabel="Cancel" onPress={onCancel} style={styles.secondaryButton}>
              <Text style={styles.secondaryButtonText}>Cancel</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Send your answer"
              accessibilityState={{ disabled: off || ui.words.trim() === "" }}
              disabled={off || ui.words.trim() === ""}
              onPress={onSendWords}
              style={styles.button}
            >
              <Text style={styles.buttonText}>{off ? "Sending…" : "Send"}</Text>
            </Pressable>
          </View>
        </View>
      ),
    );
  }
  if (view.confirmChat) {
    actions.push(
      <View key="chat" style={styles.chipRow}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Keep the decision open"
          accessibilityState={{ disabled: off }}
          disabled={off}
          onPress={() => onCloseInChat(false)}
          style={styles.secondaryButton}
        >
          <Text style={styles.secondaryButtonText}>Keep open</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Close the decision as answered"
          accessibilityState={{ disabled: off }}
          disabled={off}
          onPress={() => onCloseInChat(true)}
          style={styles.button}
        >
          <Text style={styles.buttonText}>Close as answered</Text>
        </Pressable>
      </View>,
    );
  }
  return (
    <CardFrame
      view={view.frame}
      actions={actions.length === 0 ? null : actions}
      detailsOpen={detailsOpen}
      onToggleDetails={onToggleDetails}
      details={<DetailsBody lines={view.details} text={text} styles={styles} theme={theme} compact={compact} />}
      styles={styles}
      theme={theme}
    />
  );
}
