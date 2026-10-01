/**
 * Work → request → Why? (autonomy design §E.2; change-011 C7): the chain
 * behind one request, from `links.why`. What is shown and in which order is
 * `why-model.ts`; this file reads it and draws it.
 *
 * Read when the view opens and on Refresh, never on Work's poll
 * (`WHY_QUERY_OPTIONS`). Read-only: nothing here changes anything.
 *
 * Layout: `compact` (a phone) stacks each link's name over its lines; a wide
 * screen puts the name in a column of its own beside them, in a column of
 * readable width. Ids only under Details.
 *
 * Client rules: React Native primitives only, colours from the theme
 * (`toneColor`), accessibility roles and labels on every pressable.
 */
import { useRpc } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState, type ReactNode } from "react";
import { ActivityIndicator, Pressable, ScrollView, Text, View } from "react-native";
import { linksWhyRpc } from "../shared/contracts";
import { errorMessageOf } from "./errors";
import { dashboardStyles } from "./styles";
import { Button, ToneText, type Styles, type Theme } from "./ui";
import { WHY_NOTE, WHY_QUERY_OPTIONS, WHY_TITLE, whyQueryKey, whyState, type WhySection, type WhyState } from "./why-model";

/** Widest the view grows on a large screen, as Work's columns. */
const WIDE_COLUMN = 1100;

// ---------------------------------------------------------------------------
// Hook-free pieces (tested with test/helpers/element-tree.ts).
// ---------------------------------------------------------------------------

/** One link of the chain: its name and state, then its lines, or why it is absent or missing. */
export function WhySectionRow({ section, compact, styles, theme }: { section: WhySection; compact: boolean; styles: Styles; theme: Theme }) {
  const head = (
    <View style={{ gap: 2, width: compact ? undefined : 150 }}>
      <Text accessibilityRole="header" style={styles.sectionTitle}>
        {section.title}
      </Text>
      <ToneText tone={section.statusTone} base={styles.badge} styles={styles} theme={theme}>
        {section.statusText}
      </ToneText>
    </View>
  );
  const body = (
    <View style={{ gap: 2, flex: compact ? undefined : 1 }}>
      {section.reason === null ? null : (
        <ToneText tone={section.status === "missing" ? "warning" : "muted"} styles={styles} theme={theme}>
          {section.reason}
        </ToneText>
      )}
      {section.lines.map((line) => (
        <ToneText key={line.key} tone={line.tone} styles={styles} theme={theme}>
          {line.text}
        </ToneText>
      ))}
    </View>
  );
  return (
    <View
      accessibilityLabel={section.accessibilityLabel}
      style={[styles.card, { flexDirection: compact ? "column" : "row", gap: compact ? 4 : 16, alignItems: compact ? "stretch" : "flex-start" }]}
    >
      {head}
      {body}
    </View>
  );
}

export interface WhyBodyProps {
  state: WhyState;
  /** A read is in flight while the chain already shows (Refresh). */
  refreshing: boolean;
  detailsOpen: boolean;
  onBack: () => void;
  onRefresh: () => void;
  onToggleDetails: () => void;
  compact: boolean;
  styles: Styles;
  theme: Theme;
}

/** The whole view but its data: ←, Why?, Refresh, the request, then the chain in order and its Details. Hook-free. */
export function WhyBody({ state, refreshing, detailsOpen, onBack, onRefresh, onToggleDetails, compact, styles, theme }: WhyBodyProps) {
  const view = state.kind === "ready" ? state.view : null;
  let content: ReactNode;
  if (state.kind === "loading") content = <ActivityIndicator color={styles.spinner.color} accessibilityLabel="Reading the chain behind this request" />;
  else if (state.kind === "error") content = <ToneText tone="danger" styles={styles} theme={theme}>{state.text}</ToneText>;
  else if (state.kind === "empty") content = <Text style={styles.body}>{state.text}</Text>;
  else content = state.error === null ? null : <ToneText tone="danger" styles={styles} theme={theme}>{state.error}</ToneText>;
  return (
    <View style={{ gap: styles.content.gap }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
        <Button label="←" kind="secondary" accessibilityLabel="Back to the requests" onPress={onBack} styles={styles} />
        <Text style={[styles.title, { flex: 1 }]} numberOfLines={1}>
          {WHY_TITLE}
        </Text>
        <Button
          label={refreshing ? "Reading…" : "Refresh"}
          kind="secondary"
          accessibilityLabel="Read the chain behind this request again"
          accessibilityState={{ disabled: refreshing, busy: refreshing }}
          disabled={refreshing}
          onPress={onRefresh}
          styles={styles}
        />
      </View>
      <Text style={styles.body}>{WHY_NOTE}</Text>
      {content}
      {view === null ? null : (
        <>
          <View style={{ gap: 2 }} accessibilityLabel={view.accessibilityLabel}>
            <Text style={[styles.sectionTitle, { fontWeight: "600" }]}>{view.title}</Text>
            <Text style={styles.body}>{view.meta}</Text>
          </View>
          {view.notices.map((notice) => (
            <ToneText key={notice} tone="muted" styles={styles} theme={theme}>
              {notice}
            </ToneText>
          ))}
          {view.sections.map((section) => (
            <WhySectionRow key={section.key} section={section} compact={compact} styles={styles} theme={theme} />
          ))}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`${detailsOpen ? "Hide" : "Show"} the ids behind this chain`}
            accessibilityState={{ expanded: detailsOpen }}
            onPress={onToggleDetails}
            style={{ paddingVertical: 4, alignSelf: "flex-start" }}
          >
            <ToneText tone="info" styles={styles} theme={theme}>{`Details ${detailsOpen ? "▾" : "▸"}`}</ToneText>
          </Pressable>
          {detailsOpen ? (
            <View style={[styles.card, { backgroundColor: theme.colors.surface0, gap: 2 }]}>
              {view.details.map((line, index) => (
                <Text key={`${index}-${line}`} style={styles.mono} selectable>
                  {line}
                </Text>
              ))}
            </View>
          ) : null}
        </>
      )}
    </View>
  );
}

// ---------------------------------------------------------------------------
// The screen.
// ---------------------------------------------------------------------------

export interface WhyScreenProps {
  workspaceId: string;
  requestId: string;
  onBack: () => void;
  compact: boolean;
  theme: Theme;
}

/** Why? for one request: `links.why` read once when it opens, and again on Refresh only. */
export function WhyScreen({ workspaceId, requestId, onBack, compact, theme }: WhyScreenProps) {
  const styles = useMemo(() => dashboardStyles(theme, compact), [theme, compact]);
  const readWhy = useRpc(linksWhyRpc);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const why = useQuery({
    queryKey: whyQueryKey(workspaceId, requestId),
    queryFn: () => readWhy({ workspaceId, requestId }),
    ...WHY_QUERY_OPTIONS,
  });
  const state = whyState(why.data, why.isError ? errorMessageOf(why.error) : null, new Date());
  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <View style={{ width: "100%", maxWidth: compact ? undefined : WIDE_COLUMN, alignSelf: "center" }}>
        <WhyBody
          state={state}
          refreshing={why.isFetching && why.data !== undefined}
          detailsOpen={detailsOpen}
          onBack={onBack}
          onRefresh={() => void why.refetch()}
          onToggleDetails={() => setDetailsOpen(!detailsOpen)}
          compact={compact}
          styles={styles}
          theme={theme}
        />
      </View>
    </ScrollView>
  );
}
