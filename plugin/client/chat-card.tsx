/**
 * One chat card: a message between the Manager, a Worker and a Reviewer
 * (delta 20260916-chat-cards). Header with the sender's role icon and
 * session name, the time under it, the recipient, the request and its status;
 * the full message as Markdown on demand; and a reply that goes straight to
 * the other agent.
 *
 * A received report that carries a `BM-QUESTIONS` block also shows its
 * questions with option buttons (delta 20260918c-question-cards §4.4). A pick
 * writes the answers into the Reply box, whose one Send goes to the asking
 * Worker; every Reply re-reads its recipient's status first (delta
 * 20260918d-card-replies §4.1–§4.3).
 *
 * The plugin's `BM-FALLBACK` notice is a card of its own (delta 20260921
 * §4.4.6): its status and buttons come from `fallback.incidents`, never from
 * the notice's text, and each button is one `fallback.act` call.
 *
 * All wording and decisions live in `chat-cards.ts`, tested without a
 * renderer. Client rules: React Native primitives only, colours from the theme.
 */
import { type PluginTimelineItemProps, usePaseo, useRpc } from "@getpaseo/plugin/client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import {
  answersMarkRpc,
  answersMarksRpc,
  chatPeersRpc,
  chatWaitingRpc,
  fallbackActRpc,
  fallbackIncidentsRpc,
  rolesOptionsRpc,
  type FallbackIncident,
} from "../shared/contracts";
import { errorMessageOf } from "./launch-manager";
import { answeredRecord, answersVersion, repliedAt, setAnswered, setReplied, subscribeAnswers } from "./answer-state";
import { WAITING_POLL_MS } from "./waiting-pills-model";
import type { Question } from "../shared/bm-questions";
import {
  answeredHow,
  answeredKey,
  answerRowText,
  answersDraft,
  candidateCost,
  choosable,
  drawAsCard,
  fallbackCardView,
  fallbackMarkdown,
  listedCostProvider,
  lookupOf,
  markOf,
  markdownOf,
  ownerWarning,
  outlineTone,
  partiesOf,
  partyName,
  quickReplies,
  recommendedPicks,
  replyControls,
  replyTarget,
  roleName,
  senderName,
  runFallbackAction,
  sendReply,
  sentSummary,
  showsQuestions,
  startsOpen,
  stillWaiting,
  answeredInLedger,
  movedOnLine,
  statusChip,
  summaryOf,
  questionHeading,
  withAnswersBlock,
  type ChatCard,
  type FallbackAction,
  type FallbackLookup,
  type Picks,
} from "./chat-cards";
import { dashboardStyles, toneColor } from "./dashboard-model";
import { MarkdownView } from "./markdown-view";
import { Chip, RoleMark } from "./ui";
import { BeadChips } from "./bead-chips";
import { beadIdCandidates } from "../shared/bead-ids";

/** Peers change rarely; one lookup per chat is plenty. */
const PEERS_STALE_MS = 30_000;

/** Shared by every card, so a mark shows on all copies at once. */
const ANSWER_MARKS_QUERY = ["paseo-bm", "answer-marks"] as const;

function clock(date: Date): string {
  const two = (value: number) => String(value).padStart(2, "0");
  return Number.isNaN(date.getTime()) ? "" : `${two(date.getHours())}:${two(date.getMinutes())}`;
}

/** A listed price changes rarely; the Switch button reads it once in a while. */
const COST_STALE_MS = 5 * 60_000;

/** One incident's state, shared by every copy of its card (the chat's, a pill's popover). */
const fallbackIncidentKey = (incidentId: string) => ["paseo-bm", "fallback-incident", incidentId] as const;

export function ChatCardView(props: PluginTimelineItemProps<ChatCard>) {
  return props.item.data.type === "fallback" ? <FallbackCardView {...props} /> : <MessageCardView {...props} />;
}

function MessageCardView({ theme, layout, agentId, item, timestamp }: PluginTimelineItemProps<ChatCard>) {
  const card = item.data;
  const styles = useMemo(() => dashboardStyles(theme, layout.compact), [theme, layout.compact]);
  const paseo = usePaseo();
  const listPeers = useRpc(chatPeersRpc);
  const peers = useQuery({
    queryKey: ["paseo-bm", "chat-peers", agentId],
    queryFn: () => listPeers({ agentId }),
    staleTime: PEERS_STALE_MS,
  });
  const [open, setOpen] = useState(() => startsOpen(card));
  const [replying, setReplying] = useState(false);
  const [answer, setAnswer] = useState("");
  const [sending, setSending] = useState(false);
  const [outcome, setOutcome] = useState<{ text: string; tone: "success" | "danger" } | null>(null);
  const [picks, setPicks] = useState<Picks>({});
  const [beadsOpen, setBeadsOpen] = useState(false);
  const [marking, setMarking] = useState(false);
  // Every copy of this card (the chat's, a waiting pill's popover) reads the
  // same session state and redraws when any copy writes (delta 20260918d §4.9).
  useSyncExternalStore(subscribeAnswers, answersVersion, answersVersion);
  const key = answeredKey(agentId, card);
  const done = answeredRecord(key);
  const replyAt = repliedAt(key);
  // A question card also learns it was answered elsewhere: `chat.waiting` no
  // longer lists its report (owner decision Q17). Every card shares one query.
  const asksHere = peers.isSuccess && showsQuestions(card, peers.data.owner);
  const listWaiting = useRpc(chatWaitingRpc);
  const waiting = useQuery({
    queryKey: ["paseo-bm", "chat-waiting"],
    queryFn: () => listWaiting({}),
    refetchInterval: WAITING_POLL_MS,
    enabled: asksHere,
  });
  const waitingNow = waiting.isSuccess ? waiting.data.waiting : null;
  // "Mark as answered" is saved in the install home, so it survives a reload
  // (owner decision Q16 a); every card shares one query of the marks.
  const listMarks = useRpc(answersMarksRpc);
  const saveMark = useRpc(answersMarkRpc);
  const queryClient = useQueryClient();
  const marks = useQuery({ queryKey: ANSWER_MARKS_QUERY, queryFn: () => listMarks({}), enabled: asksHere });
  const marked = marks.data?.keys.includes(key) ?? false;
  // Questions the ledger already holds an answer to: shown answered, never sent again.
  const inLedger = useMemo(() => (asksHere ? answeredInLedger(card, agentId, waitingNow) : new Set<string>()), [asksHere, card, agentId, waitingNow]);
  // A question the ledger closed after the user picked it (the Manager relayed
  // it meanwhile) must leave the Reply box too, or Send would answer it again.
  const inLedgerKey = [...inLedger].sort().join(",");
  useEffect(() => {
    if (!Object.keys(picks).some((id) => inLedger.has(id))) return;
    const kept = Object.fromEntries(Object.entries(picks).filter(([id]) => !inLedger.has(id)));
    setPicks(kept);
    setAnswer((text) => withAnswersBlock(text, answersDraft(card, kept, inLedger)));
    // `inLedgerKey` stands for `inLedger`, which is a new Set on every poll.
  }, [inLedgerKey, card, picks]);
  const how = asksHere
    ? answeredHow({
        sent: done !== null,
        marked,
        waiting: waitingNow,
        stillWaitingNow: waitingNow !== null && stillWaiting(card, agentId, waitingNow),
      })
    : null;

  const { from, to } = partiesOf(card, peers.data?.owner ?? null, peers.data?.peers ?? []);
  const counterpart = card.direction === "received" ? from : to;
  const fromMark = markOf(from.role);
  const chip = statusChip(card);
  const warning = peers.isSuccess ? ownerWarning(peers.data.owner) : null;
  const outline = outlineTone(card);
  const canReply = counterpart.id !== null && counterpart.id !== agentId;
  const controls = replyControls(canReply, replyAt !== null || how !== null);
  const beadIds = useMemo(() => beadIdCandidates(card.text), [card.text]);
  const workspaceId = peers.data?.workspaceId ?? null;

  // Not a paseo-bm chat, or a block this agent only quoted: plain text, no card.
  if (peers.isSuccess && !drawAsCard(card, peers.data.owner)) {
    return (
      <View style={{ marginVertical: 4 }}>
        <MarkdownView source={fallbackMarkdown(card)} theme={theme} compact={layout.compact} />
      </View>
    );
  }

  const refreshPeers = async () => {
    const fresh = await peers.refetch({ throwOnError: true });
    return { owner: fresh.data?.owner ?? null, peers: fresh.data?.peers ?? [] };
  };

  // A pick rewrites the answers block at the top of the Reply box and opens it;
  // the user's own words stay (delta 20260918d §4.1).
  const changePicks = (next: Picks) => {
    setPicks(next);
    setAnswer((current) => withAnswersBlock(current, answersDraft(card, next, inLedger)));
    setReplying(true);
    setOutcome(null);
  };

  const markAnswered = async () => {
    setMarking(true);
    setOutcome(null);
    try {
      queryClient.setQueryData(ANSWER_MARKS_QUERY, await saveMark({ key, marked: true }));
    } catch (failure) {
      setOutcome({ text: errorMessageOf(failure), tone: "danger" });
    } finally {
      setMarking(false);
    }
  };

  // Every Reply re-reads the recipient's status first (delta 20260918d §4.2).
  const send = async () => {
    if (answer.trim() === "") return;
    setSending(true);
    setOutcome(null);
    const result = await sendReply({
      card,
      text: answer,
      refreshPeers,
      send: (id, text) => paseo.agents.ref(id).send(text).then(() => undefined),
    });
    setSending(false);
    if (!result.ok) {
      setOutcome({ text: result.reason, tone: "danger" });
      return;
    }
    const to = partyName({ role: counterpart.role, id: result.to.id, title: result.to.title });
    setOutcome({ text: `Sent to ${to}.`, tone: "success" });
    const at = new Date();
    setReplied(key, at);
    const summary = sentSummary(card, picks, answer);
    if (summary !== null) setAnswered(key, { at, summary, to });
    setAnswer("");
    setReplying(false);
  };

  // Without a single recipient the options cannot be sent anywhere, so they are
  // off, and the card says why. A running recipient is not a reason: the user
  // may prepare answers while it works; Send refuses at send time.
  const target = peers.isSuccess ? replyTarget(card, peers.data.owner, peers.data.peers) : null;
  // The question form draws only once peers are known, and with no one to reply
  // to `replyTarget` always gives its reason, so there is no other case to word.
  const unreachable = canReply || target === null || !("reason" in target) ? null : target.reason;

  return (
    <View style={[styles.card, { gap: 6, marginVertical: 4 }, outline === null ? null : { borderColor: toneColor(theme, outline) }]}>
      {/* No coloured border and a plain-colour name: only the role icon keeps its
          colour; the time sits under the sender (delta 20260918d §4.7, Q11).
          A finished report is the one exception: its whole outline takes the
          success colour, at the usual width (§4.10). */}
      <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 8 }}>
        <View style={{ flex: 1, gap: 2 }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            {fromMark === null ? null : <RoleMark kind={fromMark} theme={theme} />}
            <Text style={[styles.sectionTitle, { color: theme.colors.foreground }]} numberOfLines={1}>
              {senderName(card, from)}
            </Text>
            <Text style={styles.body} numberOfLines={1}>
              {`→ ${partyName(to)}`}
            </Text>
          </View>
          <Text style={styles.body}>{clock(timestamp)}</Text>
        </View>
        <View style={{ alignItems: "flex-end", gap: 4 }}>
          {chip === null ? null : <Chip badge={chip} styles={styles} theme={theme} />}
          {warning === null ? null : <Chip badge={warning.chip} styles={styles} theme={theme} />}
          {card.formatIssues.length === 0 ? null : <Chip badge={{ text: "template error", tone: "danger" }} styles={styles} theme={theme} />}
          {controls.answeredChip ? (
            <Chip badge={{ text: "Answered", tone: "success" }} onPress={() => setReplying(true)} styles={styles} theme={theme} />
          ) : null}
        </View>
      </View>

      <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        {card.requestId === null ? null : <Chip badge={{ text: card.requestId, tone: "muted" }} styles={styles} theme={theme} />}
        {/* Two lines at most, also while the message is open: the full text is right below (Q50). */}
        <Text style={[styles.body, { flex: 1 }]} numberOfLines={2}>
          {summaryOf(card)}
        </Text>
      </View>

      {/* The answers a message carries, one row each, instead of the raw block. */}
      {card.answers.length === 0 ? null : (
        <View style={[styles.card, { gap: 2, backgroundColor: theme.colors.surface0 }]}>
          {card.answers.map((row) => (
            <Text key={row.id} style={styles.body}>
              {answerRowText(row)}
            </Text>
          ))}
        </View>
      )}

      {workspaceId === null || beadIds.length === 0 ? null : (
        <BeadChips
          workspaceId={workspaceId}
          ids={beadIds}
          expanded={beadsOpen}
          onExpand={() => setBeadsOpen(true)}
          styles={styles}
          theme={theme}
        />
      )}

      {peers.isSuccess && showsQuestions(card, peers.data.owner) ? (
        <QuestionForm
          card={card}
          styles={styles}
          theme={theme}
          recipient={partyName(from)}
          picks={picks}
          answered={inLedger}
          onChange={changePicks}
          answeredLine={
            how === "sent" && done !== null
              ? `Answered at ${clock(done.at)} → ${done.to}: ${done.summary}`
              : how === "marked"
                ? "Marked as answered."
                : how === "moved-on"
                  ? movedOnLine(partyName(from))
                  : null
          }
          unreachable={unreachable}
          marking={marking}
          onMarkAnswered={() => void markAnswered()}
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
        {controls.replyButton ? (
          <Pressable accessibilityRole="button" onPress={() => setReplying(!replying)} style={styles.button}>
            <Text style={styles.buttonText}>{`Reply to ${roleName(counterpart.role)}`}</Text>
          </Pressable>
        ) : null}
      </View>

      {open ? (
        <View style={[styles.card, { backgroundColor: theme.colors.surface0 }]}>
          {warning === null ? null : <Text style={styles.body}>{warning.line}</Text>}
          {card.formatIssues.length === 0 ? null : (
            <View style={{ gap: 2 }}>
              <Text style={[styles.body, { color: toneColor(theme, "danger") }]}>This message breaks the template:</Text>
              {card.formatIssues.map((line, index) => (
                <Text key={`${index}:${line}`} style={styles.body}>{`• ${line}`}</Text>
              ))}
            </View>
          )}
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
 * The card of a `BM-FALLBACK` notice (delta 20260921 §4.4.6). The notice only
 * names the incident: whether there is anything to decide, and what, is read
 * from `fallback.incidents` — while the incident is still open, again every
 * `WAITING_POLL_MS` — so an old notice never shows a button that no longer
 * applies. A button press is one `fallback.act`; the incident it returns is the
 * card's new state, and a failure is shown with its code.
 */
function FallbackCardView({ theme, layout, item, timestamp }: PluginTimelineItemProps<ChatCard>) {
  const card = item.data;
  const incidentId = card.fallback?.incident ?? "";
  const styles = useMemo(() => dashboardStyles(theme, layout.compact), [theme, layout.compact]);
  const queryClient = useQueryClient();
  const listIncidents = useRpc(fallbackIncidentsRpc);
  const act = useRpc(fallbackActRpc);
  const getOptions = useRpc(rolesOptionsRpc);
  const incidents = useQuery({
    queryKey: fallbackIncidentKey(incidentId),
    queryFn: async (): Promise<FallbackIncident[]> => (await listIncidents({ ids: [incidentId] })).incidents,
    enabled: incidentId !== "",
    // Only an open incident can still change without a press here (the reset
    // timer, a copy of this card in a pill's popover).
    refetchInterval: (query) => {
      const status = query.state.data?.find((candidate) => candidate.id === incidentId)?.status;
      return status === "pending" || status === "waiting" ? WAITING_POLL_MS : false;
    },
  });
  const lookup: FallbackLookup = incidents.isSuccess
    ? lookupOf(incidentId, incidents.data)
    : incidents.isError
      ? { state: "failed", error: incidents.error }
      : { state: "loading" };
  // The Switch button's price: the bundled table, else what Paseo lists.
  const costProvider = listedCostProvider(lookup);
  const listed = useQuery({
    queryKey: ["paseo-bm", "fallback-candidate-options", costProvider ?? ""],
    queryFn: () => getOptions({ provider: costProvider! }),
    enabled: costProvider !== null,
    staleTime: COST_STALE_MS,
    retry: false,
  });
  const [acting, setActing] = useState<FallbackAction | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const cost = lookup.state === "found" ? candidateCost(lookup.incident.candidate, listed.data?.models) : null;
  const view = fallbackCardView(card, lookup, new Date(), cost);
  const mark = markOf(view.role);

  const press = async (action: FallbackAction) => {
    setActing(action);
    setFailure(null);
    const result = await runFallbackAction({ incidentId, action, act });
    setActing(null);
    if (result.ok) {
      queryClient.setQueryData<FallbackIncident[]>(fallbackIncidentKey(incidentId), [result.incident]);
      return;
    }
    setFailure(result.reason);
    // Refused because the incident moved on (another copy, the timer): show where it is now.
    void queryClient.invalidateQueries({ queryKey: fallbackIncidentKey(incidentId) });
  };

  return (
    <View style={[styles.card, { gap: 6, marginVertical: 4 }]}>
      <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 8 }}>
        <View style={{ flex: 1, gap: 2 }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            {mark === null ? null : <RoleMark kind={mark} theme={theme} />}
            <Text style={[styles.sectionTitle, { color: theme.colors.foreground }]} numberOfLines={1}>
              {view.title}
            </Text>
          </View>
          <Text style={styles.body}>{clock(timestamp)}</Text>
        </View>
        {view.chip === null ? null : <Chip badge={view.chip} styles={styles} theme={theme} />}
      </View>

      <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        {view.requestId === null ? null : <Chip badge={{ text: view.requestId, tone: "muted" }} styles={styles} theme={theme} />}
        {view.summary === "" ? null : (
          <Text style={[styles.body, { flex: 1 }]} numberOfLines={2}>
            {view.summary}
          </Text>
        )}
      </View>
      {view.message === null ? null : (
        <Text style={[styles.mono, { color: theme.colors.foregroundMuted }]} numberOfLines={3}>
          {view.message}
        </Text>
      )}

      {view.buttons.length === 0 ? null : (
        <View style={styles.chipRow}>
          {view.buttons.map((button) => (
            <Pressable
              key={button.action}
              accessibilityRole="button"
              accessibilityState={{ disabled: acting !== null }}
              disabled={acting !== null}
              onPress={() => void press(button.action)}
              style={[button.action === "dismiss" ? styles.secondaryButton : styles.button, { opacity: acting !== null && acting !== button.action ? 0.5 : 1 }]}
            >
              <Text style={button.action === "dismiss" ? styles.secondaryButtonText : styles.buttonText}>
                {acting === button.action ? "Working…" : button.label}
              </Text>
            </Pressable>
          ))}
        </View>
      )}
      {view.statusLine === null ? null : <Text style={[styles.body, { color: toneColor(theme, view.statusLine.tone) }]}>{view.statusLine.text}</Text>}
      {failure === null ? null : <Text style={[styles.body, { color: toneColor(theme, "danger") }]}>{failure}</Text>}
    </View>
  );
}

/** One option of a question: a full-width row, outlined, filled when chosen (delta 20260918d §4.4). */
function optionRow(theme: Theme, selected: boolean) {
  return {
    alignSelf: "stretch" as const,
    flexDirection: "row" as const,
    alignItems: "flex-start" as const,
    gap: 8,
    paddingVertical: 8,
    paddingHorizontal: 10,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: selected ? toneColor(theme, "info") : theme.colors.border,
    backgroundColor: selected ? theme.colors.surface2 : "transparent",
  };
}

/**
 * The questions of a Worker's `blocked` report, answered with one tap per
 * question. Draw-only: the picks live in the card, which writes them into the
 * Reply box. Nothing is pre-selected; "Use recommendations" fills the Worker's
 * recommendations in and sends nothing.
 */
function QuestionForm({
  card,
  styles,
  theme,
  recipient,
  picks,
  answered,
  onChange,
  answeredLine,
  unreachable,
  marking,
  onMarkAnswered,
}: {
  card: ChatCard;
  styles: Styles;
  theme: Theme;
  recipient: string;
  picks: Picks;
  /** Questions the question–answer ledger already holds an answer to: shown as answered, not choosable. */
  answered: ReadonlySet<string>;
  onChange: (next: Picks) => void;
  /** What replaces the options once the card counts as answered, or null. */
  answeredLine: string | null;
  /** Why the options are off, or null when they can be sent. */
  unreachable: string | null;
  /** True while "Mark as answered" is being saved. */
  marking: boolean;
  onMarkAnswered: () => void;
}) {
  if (answeredLine !== null) {
    return <Text style={[styles.body, { color: toneColor(theme, "success") }]}>{answeredLine}</Text>;
  }

  const off = unreachable !== null;
  const pick = (question: Question, next: Picks[string]) => onChange({ ...picks, [question.id]: next });

  return (
    <View style={{ gap: 8 }}>
      {card.questions.map((question, index) => {
        const { heading, body } = questionHeading(question);
        const current = picks[question.id];
        const other = current !== undefined && "other" in current ? current : null;
        return (
          <View
            key={question.id}
            style={[
              { gap: 6, paddingVertical: 8 },
              // A divider between questions (delta 20260918d §4.4, owner decision Q5).
              index === 0 ? null : { borderTopWidth: 1, borderTopColor: theme.colors.border },
            ]}
          >
            <Text style={[styles.body, { color: theme.colors.foreground, fontWeight: "600" }]}>{heading}</Text>
            <Text style={[styles.body, { color: theme.colors.foreground }]}>{body}</Text>
            {answered.has(question.id) ? (
              <Text style={[styles.body, { color: toneColor(theme, "success") }]}>Answered.</Text>
            ) : (
              <View style={{ gap: 8 }}>
                {choosable(question)
                  ? question.options.map((option) => {
                      const selected = current !== undefined && "key" in current && current.key === option.key;
                      return (
                        <Pressable
                          key={option.key}
                          accessibilityRole="button"
                          accessibilityState={{ selected, disabled: off }}
                          disabled={off}
                          onPress={() => pick(question, { key: option.key })}
                          style={optionRow(theme, selected)}
                        >
                          <Text style={[styles.body, { width: 14, color: theme.colors.foreground }]}>{selected ? "●" : "○"}</Text>
                          <Text style={[styles.body, { width: 16, color: theme.colors.foreground, fontWeight: "600" }]}>{option.key}</Text>
                          <Text style={[styles.body, { flex: 1, color: theme.colors.foreground }]}>{option.text}</Text>
                          {option.recommended ? <Chip badge={{ text: "recommended", tone: "success" }} styles={styles} theme={theme} /> : null}
                        </Pressable>
                      );
                    })
                  : null}
                <Pressable
                  accessibilityRole="button"
                  accessibilityState={{ selected: other !== null, disabled: off }}
                  disabled={off}
                  onPress={() => pick(question, { other: other?.other ?? "" })}
                  style={optionRow(theme, other !== null)}
                >
                  <Text style={[styles.body, { width: 14, color: theme.colors.foreground }]}>{other !== null ? "●" : "○"}</Text>
                  <Text style={[styles.body, { flex: 1, color: theme.colors.foreground }]}>Other…</Text>
                </Pressable>
                {other === null ? null : (
                  <TextInput
                    value={other.other}
                    onChangeText={(text) => pick(question, { other: text })}
                    editable={!off}
                    multiline
                    placeholder={`Your answer to ${question.id}`}
                    placeholderTextColor={theme.colors.foregroundMuted}
                    style={[styles.mono, { minHeight: 48, borderWidth: 1, borderColor: theme.colors.border, borderRadius: 8, padding: 8 }]}
                  />
                )}
              </View>
            )}
          </View>
        );
      })}
      <Text style={styles.body}>{`Answers go to ${recipient}${card.requestId === null ? "" : ` · ${card.requestId}`}`}</Text>
      {unreachable === null ? null : <Text style={[styles.body, { color: toneColor(theme, "danger") }]}>{unreachable}</Text>}
      <View style={styles.chipRow}>
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ disabled: off }}
          disabled={off}
          onPress={() => onChange(recommendedPicks(card.questions, picks, answered))}
          style={styles.secondaryButton}
        >
          <Text style={styles.secondaryButtonText}>Use recommendations</Text>
        </Pressable>
        <Pressable accessibilityRole="button" accessibilityState={{ disabled: off }} disabled={off} onPress={() => onChange({})} style={styles.secondaryButton}>
          <Text style={styles.secondaryButtonText}>Clear</Text>
        </Pressable>
        {/* Saved in the data folder: the card stays answered after a reload (Q16 a). */}
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ disabled: marking }}
          disabled={marking}
          onPress={onMarkAnswered}
          style={[styles.secondaryButton, { opacity: marking ? 0.5 : 1 }]}
        >
          <Text style={styles.secondaryButtonText}>{marking ? "Marking…" : "Mark as answered"}</Text>
        </Pressable>
      </View>
    </View>
  );
}
