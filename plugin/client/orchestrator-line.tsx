/**
 * The Orchestrator line at the top of the Inbox (autonomy design §A.12, as
 * built): the owner decides in the Inbox and talks to the Orchestrator in its
 * chat, and this line is the way into that chat.
 *
 * - No Orchestrator yet: **Start the Orchestrator…** shows what it runs on and
 *   what it costs (`orchestrator.open-preview`), Cancel first, and only the
 *   confirm creates it (`orchestrator.open`, REQ-075 a).
 * - One that lost its tools or runs on older instructions: **Start a new
 *   Orchestrator…**, the same way, with `recreate: true`; the old one stays in
 *   the owner's list (design §3.3, §5.1).
 * - Otherwise: **Orchestrator chat ▸** opens it.
 *
 * `orchestrator.state` is read once when the Inbox shows (Work's rows read the
 * same query), never polled here. What it says is `orchestratorLineView`
 * (`orchestrator-model.ts`); `OrchestratorLineRow` draws it without hooks.
 *
 * Client rules: React Native primitives only, colours from the theme,
 * accessibility roles and labels on every pressable.
 */
import { type PluginSurfaceProps, useRpc } from "@getpaseo/plugin/client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Text, View } from "react-native";
import { orchestratorOpenPreviewRpc, orchestratorOpenRpc, orchestratorStateRpc, type OrchestratorOpenPreviewOutput, type OrchestratorStateOutput } from "../shared/contracts";
import { errorMessageOf } from "./errors";
import { OPEN_IN_APP_TEXT, openDialog, orchestratorLineView, recreateDialog, type OrchestratorLineView } from "./orchestrator-model";
import type { ConfirmDialog } from "./ui-types";
import { Button, ConfirmBlock, ToneText, type Styles, type Theme } from "./ui";
import { workQueryKeys } from "./work";

/** The line itself: the state, the one button, and what it has to say. Hook-free. */
export function OrchestratorLineRow({
  view,
  onPress,
  busy,
  note,
  error,
  dialog,
  onConfirm,
  onCancel,
  styles,
  theme,
}: {
  view: OrchestratorLineView;
  onPress: () => void;
  busy: boolean;
  /** Said after the chat could not be opened from here (`OPEN_IN_APP_TEXT`). */
  note: string | null;
  error: string | null;
  /** The Open or recreate dialog while it is shown; null otherwise. */
  dialog: ConfirmDialog | null;
  onConfirm: () => void;
  onCancel: () => void;
  styles: Styles;
  theme: Theme;
}) {
  return (
    <View style={[styles.card, { gap: 6 }]}>
      <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
        <Text style={[styles.sectionTitle, { flex: 1 }]} numberOfLines={1}>
          {view.title}
        </Text>
        {dialog !== null ? null : (
          <Button
            label={busy ? "Opening…" : view.label}
            kind={view.action === "open" ? "secondary" : "primary"}
            accessibilityLabel={view.label.replace(/[…▸]/g, "").trim()}
            accessibilityState={{ disabled: busy, busy }}
            disabled={busy}
            onPress={onPress}
            style={{ opacity: busy ? 0.5 : 1 }}
            styles={styles}
          />
        )}
      </View>
      {view.warning === null ? null : <ToneText tone="warning" styles={styles} theme={theme}>{view.warning}</ToneText>}
      {view.replaced === null ? null : <Text style={styles.body}>{view.replaced}</Text>}
      {dialog === null ? null : <ConfirmBlock dialog={dialog} busy={busy} busyLabel="Opening…" onConfirm={onConfirm} onCancel={onCancel} styles={styles} theme={theme} />}
      {note === null ? null : <Text style={styles.body}>{note}</Text>}
      {error === null ? null : <ToneText tone="danger" styles={styles} theme={theme}>{error}</ToneText>}
    </View>
  );
}

/** What `useOrchestratorActions` hands a view: the state, the button's press, the dialog and what it has to say. */
export interface OrchestratorActions {
  /** `orchestrator.state`, undefined until it answered. */
  state: OrchestratorStateOutput | undefined;
  /** Runs `action`: opens the chat, or shows the Open or recreate dialog. */
  press: (action: OrchestratorLineView["action"], agentId: string | null) => void;
  busy: boolean;
  note: string | null;
  error: string | null;
  dialog: ConfirmDialog | null;
  confirm: () => void;
  cancel: () => void;
}

/**
 * The Orchestrator's state and today's start flow, shared by the Inbox line
 * and the shell header: `refetchInterval` only for a view that stays on screen.
 */
export function useOrchestratorActions(
  navigation: PluginSurfaceProps["navigation"],
  refetchInterval?: number,
): OrchestratorActions {
  const queryClient = useQueryClient();
  const getState = useRpc(orchestratorStateRpc);
  const preview = useRpc(orchestratorOpenPreviewRpc);
  const open = useRpc(orchestratorOpenRpc);
  const state = useQuery({
    queryKey: workQueryKeys.projects,
    queryFn: () => getState({}),
    ...(refetchInterval === undefined ? {} : { refetchInterval }),
  });
  const [shown, setShown] = useState<{ preview: OrchestratorOpenPreviewOutput; recreate: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const openAgent = navigation?.openAgent;

  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      await work();
    } catch (failure) {
      setError(errorMessageOf(failure));
    } finally {
      setBusy(false);
    }
  };
  const openChat = (agentId: string) => {
    if (openAgent === undefined) setNote(OPEN_IN_APP_TEXT);
    else openAgent({ agentId });
  };
  const press = (action: OrchestratorLineView["action"], agentId: string | null) =>
    void run(async () => {
      if (action === "open" && agentId !== null) {
        openChat(agentId);
        return;
      }
      setShown({ preview: await preview({}), recreate: action === "restart" });
    });
  const confirm = () =>
    void run(async () => {
      if (shown === null) return;
      const opened = await open({ confirmed: true, ...(shown.recreate ? { recreate: true as const } : {}) });
      setShown(null);
      void queryClient.invalidateQueries({ queryKey: workQueryKeys.projects });
      openChat(opened.agentId);
    });

  return {
    state: state.data,
    press,
    busy,
    note,
    error,
    dialog: shown === null ? null : shown.recreate ? recreateDialog(shown.preview) : openDialog(shown.preview),
    confirm,
    cancel: () => setShown(null),
  };
}

/** The Orchestrator line: reads the state once, opens the chat or starts the Orchestrator behind its dialog. */
export function OrchestratorLine({
  navigation,
  styles,
  theme,
}: {
  navigation: PluginSurfaceProps["navigation"];
  styles: Styles;
  theme: Theme;
}) {
  const actions = useOrchestratorActions(navigation);
  if (actions.state === undefined) {
    // The Inbox itself says what failed to load; this line waits quietly.
    return null;
  }
  const view = orchestratorLineView(actions.state, new Date());
  return (
    <OrchestratorLineRow
      view={view}
      onPress={() => actions.press(view.action, view.agentId)}
      busy={actions.busy}
      note={actions.note}
      error={actions.error}
      dialog={actions.dialog}
      onConfirm={actions.confirm}
      onCancel={actions.cancel}
      styles={styles}
      theme={theme}
    />
  );
}
