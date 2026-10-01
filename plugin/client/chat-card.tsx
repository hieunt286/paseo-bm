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
 * All wording and decisions live in the `chat-card-*` modules, tested
 * without a renderer; `DecisionCardBody` is hook-free, so tests expand it
 * too. Client rules: React Native primitives only, colours from the theme.
 *
 * An answered decision with a subject also offers **Save as precedent…**
 * (autonomy design §B.6): the answer, editable, kept for this project or all
 * of them through `precedents.save`, Cancel first. An open one whose subject
 * has an active precedent that did not answer it (a release, data, security or
 * cost question) shows "Precedent: <text> (saved <date>)" and **Use this
 * answer**, which taps its option or fills the own-words box with its text.
 *
 * A decision answered for the owner on their policy (autonomy design §B.5,
 * ADR-025) reads **Decided**, "decided for you by the Orchestrator", with no
 * answer buttons and no Save as precedent (it was not the owner's answer).
 *
 * Change-014: an open decision the Orchestrator predicted shows its proposal
 * as the primary option, its reason under the options; a Worker's question
 * or an Orchestrator's decision offers **Ask back** (`decisions.ask`) and
 * shows the conversation (`decisions.thread`, one query per decision,
 * `decisionThreadQueryKey`), read again while the owner's question waits.
 *
 * A finished card reads its request's finish from `traces.list` (one query
 * per workspace, shared by the chat's finished cards; autonomy design §C.3,
 * §C.6): a finished-unverified request reads **Finished — unverified**.
 */
import { type PluginTimelineItemProps, useRpc } from "@getpaseo/plugin/client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState, type ReactNode } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import { Icon } from "@getpaseo/plugin/client/react-native";
import {
  chatPeersRpc,
  decisionsAnswerRpc,
  decisionsAskRpc,
  decisionsConfirmRpc,
  decisionsGetRpc,
  decisionsThreadRpc,
  precedentsListRpc,
  precedentsSaveRpc,
  tracesListRpc,
  type ChatPeer,
} from "../shared/contracts";
import type { Decision } from "../shared/decisions";
import type { ChatCard } from "./chat-card-parse";
import { drawAsCard } from "./chat-card-parties";
import { cardFrameOf, detailLinesOf, noticeLine, verificationOfRequest } from "./chat-card-frame";
import {
  ASK_UI_IDLE,
  DECISION_UI_IDLE,
  OWN_WORDS,
  choiceNeedsConfirmation,
  decisionCardView,
  decisionLookupOf,
  decisionPollMs,
  runDecisionAnswer,
  runDecisionAsk,
  runDecisionConfirm,
  threadPollMs,
  type AskBackView,
  type AskUi,
  type DecisionButton,
  type DecisionCardView,
  type DecisionChoice,
  type DecisionUi,
} from "./chat-card-decision";
import { askableKindOf } from "../shared/decision-threads";
import {
  PRECEDENT_UI_IDLE,
  precedentFormOf,
  precedentOfferView,
  precedentSuggestionView,
  runPrecedentSave,
  type PrecedentOfferView,
  type PrecedentScopeChoice,
  type PrecedentSuggestionView,
  type PrecedentUi,
} from "./chat-card-precedent";
import { fallbackMarkdown, markdownOf } from "./chat-card-markdown";
import { dashboardStyles } from "./styles";
import { MONO, SectionLabel } from "./text-tabs";
import { MarkdownView } from "./markdown-view";
import { PRECEDENTS_QUERY_KEY } from "./settings-autonomy-model";
import { Button, CardFrame, CompactLine, ConfirmBlock, ToneText, type CardJoin, type Styles, type Theme } from "./ui";

/** Peers change rarely; one lookup per chat is plenty. */
const PEERS_STALE_MS = 30_000;
/** A project's precedents, for the suggestion on its open decisions; a save or an end reads them again at once. */
const PRECEDENTS_STALE_MS = 30_000;
/** A workspace's request rows, for its finished cards' verification (autonomy design §C.3). */
const FINISHES_STALE_MS = 30_000;

/** The request rows the finished cards of one workspace read their finish from (`traces.list`). */
export const finishesQueryKey = (workspaceId: string) => ["paseo-bm", "chat-card", "finishes", workspaceId] as const;

/** One decision's state, shared by every card that shows it (the chats and the Inbox). */
export const decisionQueryKey = (id: string) => ["paseo-bm", "decision", id] as const;

/** One decision's Ask back thread, shared the same way (under the decision's key, so invalidating the decision reads it again too). */
export const decisionThreadQueryKey = (id: string) => ["paseo-bm", "decision", id, "thread"] as const;

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
  // Autonomy design §C.3, §C.6: a finished card reads its request's finish by its request.
  const listTraces = useRpc(tracesListRpc);
  const workspaceId = peers.data?.workspaceId ?? null;
  const readsFinish = card.type === "finished" && card.requestId !== null && workspaceId !== null;
  const finishes = useQuery({
    queryKey: finishesQueryKey(workspaceId ?? ""),
    queryFn: () => listTraces({ workspaceId: workspaceId ?? "" }),
    enabled: readsFinish,
    retry: false,
    staleTime: FINISHES_STALE_MS,
  });
  const verification = readsFinish ? verificationOfRequest(finishes.data?.traces, card.requestId) : null;

  // Not a paseo-bm chat, or a block this agent only quoted: plain text, no card.
  if (peers.isSuccess && !drawAsCard(card, owner)) {
    return (
      <View style={{ marginVertical: 4 }}>
        <MarkdownView source={fallbackMarkdown(card)} theme={theme} compact={layout.compact} />
      </View>
    );
  }
  const view = cardFrameOf(card, { owner, peers: peers.data?.peers ?? [], at: timestamp, now: new Date(), verification });
  return (
    <CardFrame
      view={view}
      detailsOpen={details}
      onToggleDetails={() => setDetails(!details)}
      details={<DetailsBody lines={detailLinesOf(card, owner, verification)} text={card.text} styles={styles} theme={theme} compact={layout.compact} />}
      compact={layout.compact}
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
  join,
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
  /** Where the card sits in an Inbox group's joined stack; alone in a chat. */
  join?: CardJoin;
  theme: Theme;
  compact: boolean;
}) {
  const id = card.decision?.id ?? "";
  const styles = useMemo(() => dashboardStyles(theme, compact), [theme, compact]);
  const queryClient = useQueryClient();
  const getDecision = useRpc(decisionsGetRpc);
  const answer = useRpc(decisionsAnswerRpc);
  const confirmChat = useRpc(decisionsConfirmRpc);
  const savePrecedent = useRpc(precedentsSaveRpc);
  const listPrecedents = useRpc(precedentsListRpc);
  const askBack = useRpc(decisionsAskRpc);
  const readThread = useRpc(decisionsThreadRpc);
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
  const [precedentUi, setPrecedentUi] = useState<PrecedentUi>(PRECEDENT_UI_IDLE);
  const [details, setDetails] = useState(false);
  const [askUi, setAskUi] = useState<AskUi>(ASK_UI_IDLE);
  const lookup = decisionLookupOf({ data: query.data, error: query.error });
  const decision = lookup.state === "found" ? lookup.decision : null;
  // Change-014 outcome 3: only a Worker's question or an Orchestrator's decision has a thread; read again while the owner's question waits.
  const thread = useQuery({
    queryKey: decisionThreadQueryKey(id),
    queryFn: () => readThread({ id }),
    enabled: decision !== null && askableKindOf(id) !== null,
    retry: false,
    staleTime: Number.POSITIVE_INFINITY,
    refetchInterval: (current: { state: { data?: { thread: Parameters<typeof threadPollMs>[1] } } }) => threadPollMs(decision, current.state.data?.thread),
  });
  const view = decisionCardView({ card, lookup, agents, ui, cardAt: at, now: new Date(), thread: thread.data?.thread ?? null, ask: askUi });
  const precedent = precedentOfferView(decision, precedentUi);
  // Autonomy design §B.6: an open decision's card suggests the owner's precedent on its subject, read per project.
  const workspaceId = decision?.workspaceId ?? "";
  const precedents = useQuery({
    queryKey: [...PRECEDENTS_QUERY_KEY, workspaceId],
    queryFn: () => listPrecedents({ workspaceId }),
    enabled: decision !== null && decision.status === "open" && decision.subject !== null,
    retry: false,
    staleTime: PRECEDENTS_STALE_MS,
  });
  const suggestion = precedentSuggestionView(decision, precedents.data?.precedents, ui, new Date());

  const keepAsPrecedent = async () => {
    const form = precedentUi.form;
    if (decision === null || form === null) return;
    setPrecedentUi({ ...precedentUi, busy: true, error: null });
    const result = await runPrecedentSave({ decision, form, save: savePrecedent });
    if (!result.ok) {
      setPrecedentUi({ ...precedentUi, busy: false, error: result.reason });
      return;
    }
    setPrecedentUi({ ...PRECEDENT_UI_IDLE, saved: { scope: form.scope, expiresAt: result.precedent.expiresAt } });
    // Settings → Autonomy lists the precedents: show this one there on its next read.
    void queryClient.invalidateQueries({ queryKey: PRECEDENTS_QUERY_KEY });
  };

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

  // The suggested precedent picked: its option as a tap on it; its words into the own-words box, sent by the owner.
  const pickSuggestion = (choice: DecisionChoice) => {
    if ("optionKey" in choice) choose(choice);
    else setUi({ ...ui, words: choice.words, error: null });
  };

  const sendAsk = async () => {
    const text = askUi.text ?? "";
    setAskUi({ ...askUi, busy: true, error: null });
    const result = await runDecisionAsk({ id, text, ask: askBack });
    if (!result.ok) {
      setAskUi({ ...askUi, busy: false, error: result.reason });
      // Refused because it settled meanwhile: show where it is now.
      void queryClient.invalidateQueries({ queryKey: decisionQueryKey(id) });
      return;
    }
    queryClient.setQueryData(decisionThreadQueryKey(id), { thread: result.thread });
    setAskUi({ ...ASK_UI_IDLE, delivery: result.delivery });
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
      askText={askUi.text ?? ""}
      onAsk={{
        open: () => setAskUi({ ...askUi, text: "", error: null }),
        text: (text) => setAskUi({ ...askUi, text }),
        cancel: () => setAskUi({ ...ASK_UI_IDLE, delivery: askUi.delivery }),
        send: () => void sendAsk(),
      }}
      suggestion={suggestion}
      onUseSuggestion={pickSuggestion}
      precedent={precedent}
      onPrecedent={{
        open: () => {
          if (decision !== null) setPrecedentUi({ ...PRECEDENT_UI_IDLE, form: precedentFormOf(decision) });
        },
        text: (text) => {
          if (precedentUi.form !== null) setPrecedentUi({ ...precedentUi, form: { ...precedentUi.form, text } });
        },
        scope: (scope) => {
          if (precedentUi.form !== null) setPrecedentUi({ ...precedentUi, form: { ...precedentUi.form, scope } });
        },
        cancel: () => setPrecedentUi({ ...PRECEDENT_UI_IDLE, saved: precedentUi.saved }),
        save: () => void keepAsPrecedent(),
      }}
      text={card.text}
      join={join}
      styles={styles}
      theme={theme}
      compact={compact}
    />
  );
}

/** What the owner does with Ask back: open the box, write, cancel, send. */
export interface AskHandlers {
  open: () => void;
  text: (text: string) => void;
  cancel: () => void;
  send: () => void;
}

/** A text box on a card: square, one border, colours from the theme. */
function boxStyle(styles: Styles, theme: Theme) {
  return [styles.mono, { minHeight: 56, borderWidth: 1, borderColor: theme.colors.border, borderRadius: 0, padding: 8 }];
}

/** The mockup's one-line input: the page colour, one border, 10×12 padding. */
function inputStyle(theme: Theme) {
  return {
    flex: 1,
    minWidth: 0,
    color: theme.colors.foreground,
    backgroundColor: theme.colors.surface0,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: 0,
    paddingVertical: 10,
    paddingHorizontal: 12,
    fontSize: 14,
  };
}

/**
 * The conversation of an asked-back decision (oldest first, "You" and the
 * asker, a 76px name column under a divider), the one-line ask box with Send
 * and Cancel, and the line under them: not delivered, waiting for the asker,
 * or what the last Send could not do. Hook-free. The Ask back button itself
 * sits beside Own words… on the card's last row.
 */
export function AskBackBlock({ view, text, on, styles, theme }: { view: AskBackView; text: string; on: AskHandlers; styles: Styles; theme: Theme }) {
  const box = view.box;
  if (view.conversation.length === 0 && box === null && view.status === null) return null;
  const { colors } = theme;
  return (
    <View style={{ gap: 10, borderTopWidth: 1, borderTopColor: colors.border, paddingTop: 12 }}>
      {view.conversation.length === 0 ? null : <SectionLabel theme={theme}>Conversation</SectionLabel>}
      {view.conversation.map((entry) => (
        <View key={entry.key} style={{ flexDirection: "row", gap: 12 }}>
          <Text style={{ width: 76, color: colors.foregroundMuted, fontSize: 13 }}>{entry.who}</Text>
          <Text style={{ flex: 1, color: colors.foreground, fontSize: 14 }} selectable>
            {entry.text}
          </Text>
        </View>
      ))}
      {box === null ? null : (
        <View style={{ flexDirection: "row", gap: 8, alignItems: "stretch" }}>
          <TextInput
            value={text}
            onChangeText={on.text}
            editable={!box.busy}
            accessibilityLabel={box.label}
            placeholder={box.placeholder}
            placeholderTextColor={colors.foregroundMuted}
            onSubmitEditing={box.sendEnabled ? on.send : undefined}
            style={inputStyle(theme)}
          />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Send your question to ${box.label.replace(/^Ask /, "")}`}
            accessibilityState={{ disabled: !box.sendEnabled }}
            disabled={!box.sendEnabled}
            onPress={on.send}
            style={{ justifyContent: "center", paddingHorizontal: 16, backgroundColor: colors.foreground, opacity: box.sendEnabled ? 1 : 0.5 }}
          >
            <Text style={{ color: colors.surface0, fontSize: 14, fontWeight: "500" }}>{box.busy ? "Sending…" : "Send"}</Text>
          </Pressable>
          {box.busy ? null : (
            <Button
              label="Cancel"
              kind="secondary"
              accessibilityLabel="Cancel the question"
              onPress={on.cancel}
              style={{ justifyContent: "center", paddingHorizontal: 14, borderRadius: 0 }}
              textStyle={{ color: colors.foregroundMuted }}
              styles={styles}
            />
          )}
        </View>
      )}
      {view.status === null ? null : (
        <ToneText tone={view.status.tone} accessibilityLiveRegion="polite" styles={styles} theme={theme}>
          {view.status.text}
        </ToneText>
      )}
    </View>
  );
}

/** Ask back with its small chat icon: a secondary button of the card's last row. */
function AskBackButton({ label, onPress, styles, theme }: { label: string; onPress: () => void; styles: Styles; theme: Theme }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={[styles.secondaryButton, { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, paddingVertical: 8, paddingHorizontal: 12, borderRadius: 0 }]}
    >
      <Icon name="MessageSquare" size={14} color={theme.colors.foreground} />
      <Text style={[styles.secondaryButtonText, { fontSize: 13 }]}>Ask back</Text>
    </Pressable>
  );
}

/** What the owner does with the Save as precedent form. */
export interface PrecedentHandlers {
  open: () => void;
  text: (text: string) => void;
  scope: (scope: PrecedentScopeChoice) => void;
  cancel: () => void;
  save: () => void;
}

/**
 * Save as precedent on an answered decision: the one button, then the form —
 * what saving does, the answer to keep (editable), this project or all, and
 * Cancel first — then the line saying it was saved or why not. Hook-free.
 */
export function PrecedentOffer({ view, on, styles, theme }: { view: PrecedentOfferView; on: PrecedentHandlers; styles: Styles; theme: Theme }) {
  const form = view.form;
  return (
    <View style={{ gap: 6 }}>
      {view.offer === null ? null : (
        <View style={styles.chipRow}>
          <Button label={view.offer.label} kind="secondary" size="small" accessibilityLabel={view.offer.accessibilityLabel} onPress={on.open} styles={styles} />
        </View>
      )}
      {form === null ? null : (
        <View style={{ gap: 6 }}>
          <Text style={styles.sectionTitle}>{form.title}</Text>
          <Text style={[styles.body, { fontSize: 11 }]}>{form.body}</Text>
          <TextInput
            value={form.text}
            onChangeText={on.text}
            editable={!form.busy}
            multiline
            accessibilityLabel={form.textLabel}
            placeholder="The answer to keep"
            placeholderTextColor={theme.colors.foregroundMuted}
            style={boxStyle(styles, theme)}
          />
          {form.textHint === null ? null : <ToneText tone="muted" style={{ fontSize: 11 }} styles={styles} theme={theme}>{form.textHint}</ToneText>}
          <View accessibilityRole="radiogroup" style={styles.chipRow}>
            {form.scopes.map((choice) => (
              <Button
                key={choice.scope}
                label={choice.label}
                kind={choice.selected ? "primary" : "secondary"}
                size="small"
                accessibilityRole="radio"
                accessibilityLabel={choice.accessibilityLabel}
                accessibilityState={{ selected: choice.selected, disabled: form.busy }}
                disabled={form.busy}
                onPress={() => on.scope(choice.scope)}
                styles={styles}
              />
            ))}
          </View>
          <View style={styles.chipRow}>
            {form.busy ? null : (
              <Button label={form.cancelLabel} kind="secondary" size="small" accessibilityLabel={form.cancelLabel} onPress={on.cancel} styles={styles} />
            )}
            <Button
              label={form.saveLabel}
              kind="primary"
              size="small"
              accessibilityLabel={form.saveAccessibilityLabel}
              accessibilityState={{ disabled: !form.saveEnabled }}
              disabled={!form.saveEnabled}
              onPress={on.save}
              styles={styles}
            />
          </View>
        </View>
      )}
      {view.status === null ? null : <ToneText tone={view.status.tone} styles={styles} theme={theme}>{view.status.text}</ToneText>}
    </View>
  );
}

/**
 * One option as the mockup draws it: a full-width row — the key letter in
 * mono, the label (wrapping), and at the right its mark ("Recommended",
 * "Orchestrator suggests") in small capitals. The primary option is filled
 * with the accent; the others are outlined. Hook-free.
 *
 * On a phone (`compact`, the MobileInbox artboard) the label gets the whole
 * width: a top line with the key letter at the left and the mark at the
 * right, both 11px, then the label under it.
 */
export function OptionRow({
  option,
  off,
  onChoose,
  theme,
  compact = false,
}: {
  option: DecisionButton;
  off: boolean;
  onChoose: (key: string) => void;
  theme: Theme;
  compact?: boolean;
}) {
  const { colors } = theme;
  const on = option.primary;
  const ink = on ? colors.accentForeground : colors.foreground;
  if (compact) {
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={option.accessibilityLabel}
        accessibilityState={{ disabled: off }}
        disabled={off}
        onPress={() => onChoose(option.key)}
        style={{
          alignSelf: "stretch",
          gap: 4,
          padding: 12,
          borderWidth: 1,
          borderColor: on ? colors.accent : colors.border,
          backgroundColor: on ? colors.accent : "transparent",
          opacity: off ? 0.5 : 1,
        }}
      >
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8, opacity: on ? 0.9 : 1 }}>
          <Text style={{ fontFamily: MONO, fontSize: 11, color: on ? ink : colors.foregroundMuted }}>{option.key}</Text>
          {option.mark === null ? null : (
            <Text style={{ marginLeft: "auto", fontSize: 11, textTransform: "uppercase", color: on ? ink : colors.foregroundMuted }} numberOfLines={1}>
              {option.mark}
            </Text>
          )}
        </View>
        <Text style={{ fontSize: 14, lineHeight: 20, color: ink, textAlign: "left" }}>{option.label}</Text>
      </Pressable>
    );
  }
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={option.accessibilityLabel}
      accessibilityState={{ disabled: off }}
      disabled={off}
      onPress={() => onChoose(option.key)}
      style={{
        alignSelf: "stretch",
        flexDirection: "row",
        alignItems: "flex-start",
        gap: 12,
        paddingVertical: 12,
        paddingHorizontal: 14,
        borderWidth: 1,
        borderColor: on ? colors.accent : colors.border,
        backgroundColor: on ? colors.accent : "transparent",
        opacity: off ? 0.5 : 1,
      }}
    >
      <Text style={{ fontFamily: MONO, fontSize: 14, lineHeight: 20, fontWeight: on ? "500" : "400", color: on ? ink : colors.foregroundMuted }}>{option.key}</Text>
      <Text style={{ flex: 1, flexShrink: 1, fontSize: 14, lineHeight: 20, color: ink, textAlign: "left" }}>{option.label}</Text>
      {option.mark === null ? null : (
        <Text style={{ fontSize: 12, lineHeight: 20, textTransform: "uppercase", color: on ? ink : colors.foregroundMuted, opacity: on ? 0.9 : 1 }}>{option.mark}</Text>
      )}
    </Pressable>
  );
}

/** The held action's two buttons, as the mockup has them: Deny outlined, then Allow once filled. */
const HELD_BUTTON = { paddingVertical: 8, paddingHorizontal: 16, borderRadius: 0 };

/**
 * What a decision card draws, from its view, in the mockup's order: the
 * frame's meta line, title and body; the precedent suggestion; the in-place
 * confirmation with Cancel first, or the options as full-width rows (a held
 * action's Deny / Allow once as two buttons) and the Orchestrator's reason
 * under them; the own-words box; the conversation and the ask box; then one
 * row — Ask back, Own words…, Keep open / Close as answered for a decision
 * that needs confirmation — with Details at its right; on an answered one,
 * Save as precedent when `precedent` offers it. Hook-free.
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
  onAsk,
  askText = "",
  suggestion = null,
  onUseSuggestion,
  precedent = null,
  onPrecedent,
  text,
  join,
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
  /** Ask back's handlers; without them the card draws no Ask back. */
  onAsk?: AskHandlers;
  /** The text in the Ask back box. */
  askText?: string;
  /** The owner's precedent on an open decision's subject (`precedentSuggestionView`); null or absent when none. */
  suggestion?: PrecedentSuggestionView | null;
  onUseSuggestion?: (choice: DecisionChoice) => void;
  /** Save as precedent (`precedentOfferView`); null or absent when the card offers none. */
  precedent?: PrecedentOfferView | null;
  onPrecedent?: PrecedentHandlers;
  text: string;
  /** Where the card sits in an Inbox group's joined stack; alone in a chat. */
  join?: CardJoin;
  styles: Styles;
  theme: Theme;
  compact: boolean;
}) {
  const off = ui.busy;
  const actions: ReactNode[] = [];
  const footer: ReactNode[] = [];
  if (suggestion !== null) {
    const use = suggestion.use;
    actions.push(
      <View key="suggestion" style={{ gap: 6 }}>
        <ToneText tone="info" style={{ fontSize: 13 }} styles={styles} theme={theme}>{suggestion.line}</ToneText>
        {use === null || onUseSuggestion === undefined ? null : (
          <View style={styles.chipRow}>
            <Button
              label={use.label}
              kind="secondary"
              size="small"
              accessibilityLabel={use.accessibilityLabel}
              accessibilityState={{ disabled: off }}
              disabled={off}
              onPress={() => onUseSuggestion(use.choice)}
              styles={styles}
            />
          </View>
        )}
      </View>,
    );
  }
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
  if (view.options.length > 0 && view.held) {
    // Deny first, outlined; Allow once filled — the order the mockup draws.
    const ordered = [...view.options].sort((a, b) => Number(a.primary) - Number(b.primary));
    actions.push(
      // On a phone a 2-column grid of equal buttons (the MobileInbox artboard).
      <View key="options" style={{ flexDirection: "row", flexWrap: compact ? "nowrap" : "wrap", gap: 8 }}>
        {ordered.map((option) => (
          <Button
            key={option.key}
            label={option.label}
            kind={option.primary ? "primary" : "secondary"}
            accessibilityLabel={option.accessibilityLabel}
            accessibilityState={{ disabled: off }}
            disabled={off}
            onPress={() => onChoose(option.key)}
            style={[HELD_BUTTON, { opacity: off ? 0.5 : 1 }, ...(compact ? [{ flex: 1, minWidth: 0, paddingVertical: 10, paddingHorizontal: 12 }] : [])]}
            styles={styles}
          />
        ))}
      </View>,
    );
  } else if (view.options.length > 0) {
    actions.push(
      <View key="options" style={{ gap: 6 }}>
        {view.options.map((option) => (
          <OptionRow key={option.key} option={option} off={off} onChoose={onChoose} theme={theme} compact={compact} />
        ))}
      </View>,
    );
  }
  if (view.proposal !== null) {
    actions.push(
      <ToneText key="proposal" tone="muted" style={{ fontSize: 13 }} numberOfLines={1} styles={styles} theme={theme}>
        {view.proposal}
      </ToneText>,
    );
  }
  if (view.ownWords && view.confirm === null && ui.words !== null) {
    actions.push(
      <View key="words" style={{ gap: 6 }}>
        <TextInput
          value={ui.words}
          onChangeText={onWords}
          editable={!off}
          multiline
          accessibilityLabel="Your answer in your own words"
          placeholder="Your answer"
          placeholderTextColor={theme.colors.foregroundMuted}
          style={boxStyle(styles, theme)}
        />
        <View style={styles.chipRow}>
          <Button label="Cancel" kind="secondary" size="small" accessibilityLabel="Cancel" onPress={onCancel} styles={styles} />
          <Button
            label={off ? "Sending…" : "Send"}
            kind="primary"
            size="small"
            accessibilityLabel="Send your answer"
            accessibilityState={{ disabled: off || ui.words.trim() === "" }}
            disabled={off || ui.words.trim() === ""}
            onPress={onSendWords}
            styles={styles}
          />
        </View>
      </View>,
    );
  }
  const ask = onAsk === undefined ? null : view.askBack;
  if (ask !== null && onAsk !== undefined) {
    actions.push(<AskBackBlock key="ask" view={ask} text={askText} on={onAsk} styles={styles} theme={theme} />);
    if (ask.offered) footer.push(<AskBackButton key="ask-back" label={ask.accessibilityLabel} onPress={onAsk.open} styles={styles} theme={theme} />);
  }
  if (view.ownWords && view.confirm === null && ui.words === null) {
    footer.push(
      <Button
        key="own-words"
        label="Own words…"
        kind="secondary"
        size="small"
        accessibilityLabel="Answer in your own words"
        accessibilityState={{ disabled: off }}
        disabled={off}
        onPress={onOpenWords}
        styles={styles}
      />,
    );
  }
  if (view.confirmChat) {
    footer.push(
      <Button
        key="keep-open"
        label="Keep open"
        kind="secondary"
        size="small"
        accessibilityLabel="Keep the decision open"
        accessibilityState={{ disabled: off }}
        disabled={off}
        onPress={() => onCloseInChat(false)}
        styles={styles}
      />,
      <Button
        key="close-answered"
        label="Close as answered"
        kind="secondary"
        size="small"
        accessibilityLabel="Close the decision as answered"
        accessibilityState={{ disabled: off }}
        disabled={off}
        onPress={() => onCloseInChat(true)}
        styles={styles}
      />,
    );
  }
  if (precedent !== null && onPrecedent !== undefined) {
    actions.push(<PrecedentOffer key="precedent" view={precedent} on={onPrecedent} styles={styles} theme={theme} />);
  }
  return (
    <CardFrame
      view={view.frame}
      actions={actions.length === 0 ? null : actions}
      footer={footer.length === 0 ? null : footer}
      detailsOpen={detailsOpen}
      onToggleDetails={onToggleDetails}
      details={<DetailsBody lines={view.details} text={text} styles={styles} theme={theme} compact={compact} />}
      join={join}
      compact={compact}
      styles={styles}
      theme={theme}
    />
  );
}
