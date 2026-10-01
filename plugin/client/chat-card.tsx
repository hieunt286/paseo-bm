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
 * A decision the owner's policy answered as it opened (autonomy design §B.5)
 * reads **Decided**, "decided for you by the policy · recommended option", with
 * no answer buttons and no Save as precedent (it was not the owner's answer).
 *
 * A finished card reads its request's finish from `traces.list` (one query
 * per workspace, shared by the chat's finished cards; autonomy design §C.3,
 * §C.6): a finished-unverified request reads **Finished — unverified**.
 */
import { type PluginTimelineItemProps, useRpc } from "@getpaseo/plugin/client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState, type ReactNode } from "react";
import { Text, TextInput, View } from "react-native";
import {
  chatPeersRpc,
  decisionsAnswerRpc,
  decisionsConfirmRpc,
  decisionsGetRpc,
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
  DECISION_UI_IDLE,
  OWN_WORDS,
  choiceNeedsConfirmation,
  decisionCardView,
  decisionLookupOf,
  decisionPollMs,
  runDecisionAnswer,
  runDecisionConfirm,
  type DecisionCardView,
  type DecisionChoice,
  type DecisionUi,
} from "./chat-card-decision";
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
import { MarkdownView } from "./markdown-view";
import { PRECEDENTS_QUERY_KEY } from "./settings-autonomy-model";
import { Button, CardFrame, CompactLine, ConfirmBlock, ToneText, type Styles, type Theme } from "./ui";

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
  const savePrecedent = useRpc(precedentsSaveRpc);
  const listPrecedents = useRpc(precedentsListRpc);
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
  const lookup = decisionLookupOf({ data: query.data, error: query.error });
  const view = decisionCardView({ card, lookup, agents, ui, cardAt: at, now: new Date() });
  const decision = lookup.state === "found" ? lookup.decision : null;
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
      styles={styles}
      theme={theme}
      compact={compact}
    />
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
          <Button label={view.offer.label} kind="secondary" accessibilityLabel={view.offer.accessibilityLabel} onPress={on.open} styles={styles} />
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
            style={[styles.mono, { minHeight: 56, borderWidth: 1, borderColor: theme.colors.border, borderRadius: 8, padding: 8 }]}
          />
          {form.textHint === null ? null : <ToneText tone="muted" style={{ fontSize: 11 }} styles={styles} theme={theme}>{form.textHint}</ToneText>}
          <View accessibilityRole="radiogroup" style={styles.chipRow}>
            {form.scopes.map((choice) => (
              <Button
                key={choice.scope}
                label={choice.label}
                kind={choice.selected ? "primary" : "secondary"}
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
              <Button label={form.cancelLabel} kind="secondary" accessibilityLabel={form.cancelLabel} onPress={on.cancel} styles={styles} />
            )}
            <Button
              label={form.saveLabel}
              kind="primary"
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

/** The longest option label that still sits in a row of chips; a longer one stacks the options. */
export const OPTION_ROW_MAX_CHARS = 32;

/**
 * Whether a decision's options stack: short answers ("Yes", "Hold") sit side
 * by side; once one is a sentence, each option takes the card's width and its
 * text wraps, so nothing runs past the card.
 */
export function optionsStacked(labels: readonly string[]): boolean {
  return labels.some((label) => label.length > OPTION_ROW_MAX_CHARS);
}

// A row item in React Native does not shrink by default: without these a long
// label widens its button past the card instead of wrapping.
const OPTION_STACK = { gap: 6 };
const STACKED_OPTION = { alignSelf: "stretch" as const, alignItems: "flex-start" as const };
const ROW_OPTION = { maxWidth: "100%" as const, flexShrink: 1 };
const OPTION_TEXT = { flexShrink: 1, textAlign: "left" as const };

/**
 * What a decision card draws, from its view: the frame, then the options (the
 * recommended one the primary action), "Own words…", the in-place
 * confirmation with Cancel first, or the two buttons of a decision that needs
 * confirmation; on an answered one, Save as precedent when `precedent` offers
 * it. Hook-free.
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
  suggestion = null,
  onUseSuggestion,
  precedent = null,
  onPrecedent,
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
  /** The owner's precedent on an open decision's subject (`precedentSuggestionView`); null or absent when none. */
  suggestion?: PrecedentSuggestionView | null;
  onUseSuggestion?: (choice: DecisionChoice) => void;
  /** Save as precedent (`precedentOfferView`); null or absent when the card offers none. */
  precedent?: PrecedentOfferView | null;
  onPrecedent?: PrecedentHandlers;
  text: string;
  styles: Styles;
  theme: Theme;
  compact: boolean;
}) {
  const off = ui.busy;
  const actions: ReactNode[] = [];
  if (suggestion !== null) {
    const use = suggestion.use;
    actions.push(
      <View key="suggestion" style={{ gap: 6 }}>
        <ToneText tone="info" style={{ fontSize: 12 }} styles={styles} theme={theme}>{suggestion.line}</ToneText>
        {use === null || onUseSuggestion === undefined ? null : (
          <View style={styles.chipRow}>
            <Button
              label={use.label}
              kind="secondary"
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
  if (view.options.length > 0) {
    const stacked = optionsStacked(view.options.map((option) => option.label));
    actions.push(
      <View key="options" style={stacked ? OPTION_STACK : styles.chipRow}>
        {view.options.map((option) => (
          <Button
            key={option.key}
            label={option.label}
            kind={option.primary ? "primary" : "secondary"}
            accessibilityLabel={option.accessibilityLabel}
            accessibilityState={{ disabled: off }}
            disabled={off}
            onPress={() => onChoose(option.key)}
            style={[stacked ? STACKED_OPTION : ROW_OPTION, { opacity: off ? 0.5 : 1 }]}
            textStyle={OPTION_TEXT}
            styles={styles}
          />
        ))}
      </View>,
    );
  }
  if (view.ownWords && view.confirm === null) {
    actions.push(
      ui.words === null ? (
        <View key="words" style={styles.chipRow}>
          <Button
            label="Own words…"
            kind="secondary"
            accessibilityLabel="Answer in your own words"
            accessibilityState={{ disabled: off }}
            disabled={off}
            onPress={onOpenWords}
            styles={styles}
          />
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
            <Button label="Cancel" kind="secondary" accessibilityLabel="Cancel" onPress={onCancel} styles={styles} />
            <Button
              label={off ? "Sending…" : "Send"}
              kind="primary"
              accessibilityLabel="Send your answer"
              accessibilityState={{ disabled: off || ui.words.trim() === "" }}
              disabled={off || ui.words.trim() === ""}
              onPress={onSendWords}
              styles={styles}
            />
          </View>
        </View>
      ),
    );
  }
  if (view.confirmChat) {
    actions.push(
      <View key="chat" style={styles.chipRow}>
        <Button
          label="Keep open"
          kind="secondary"
          accessibilityLabel="Keep the decision open"
          accessibilityState={{ disabled: off }}
          disabled={off}
          onPress={() => onCloseInChat(false)}
          styles={styles}
        />
        <Button
          label="Close as answered"
          kind="secondary"
          accessibilityLabel="Close the decision as answered"
          accessibilityState={{ disabled: off }}
          disabled={off}
          onPress={() => onCloseInChat(true)}
          styles={styles}
        />
      </View>,
    );
  }
  if (precedent !== null && onPrecedent !== undefined) {
    actions.push(<PrecedentOffer key="precedent" view={precedent} on={onPrecedent} styles={styles} theme={theme} />);
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
