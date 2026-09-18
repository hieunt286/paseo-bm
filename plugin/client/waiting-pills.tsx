/**
 * "Questions waiting" pills above a Manager's chat (delta
 * 20260918d-card-replies §4.8, REQ-059 j; owner decision Q15 b).
 *
 * One composer pill per Worker whose latest report asks the user something,
 * next to Paseo's own pills. Pressing it opens a popover with that report's
 * card, so the questions are answered there, through the card's own Reply
 * path. Paseo 0.8 gives a plugin no way to scroll the chat to a card, which is
 * why a popover stands in for scrolling.
 *
 * The list comes from `chat.waiting`, read at registration and every
 * `WAITING_POLL_MS`. A failed read keeps the pills as they are.
 *
 * Each pill keeps ONE popover component for its whole life, and that component
 * reads the pill's newest report from a small store: redrawing a pill after a
 * refresh must not remount an open popover and lose a Reply being typed
 * (delta 20260918f F13).
 */
import type {
  PluginButton,
  PluginButtonContentProps,
  PluginButtonRegistration,
  PluginClientContext,
} from "@getpaseo/plugin/client";
import { useSyncExternalStore, type ComponentType } from "react";
import { chatWaitingRpc, type WaitingWorker } from "../shared/contracts";
import { ChatCardView } from "./chat-card";
import { CHAT_CARD_KIND, CHAT_CARD_VERSION, toChatCard } from "./chat-cards";
import { WAITING_PILL_ICON, WAITING_POLL_MS, planPills, type WaitingPill } from "./waiting-pills-model";

/** The newest report of each shown pill, by pill id; one per loaded client bundle. */
const entries = new Map<string, WaitingWorker>();
const listeners = new Set<() => void>();

function setEntry(pillId: string, entry: WaitingWorker | undefined): void {
  if (entry === undefined) entries.delete(pillId);
  else entries.set(pillId, entry);
  for (const listener of listeners) listener();
}

function subscribeEntries(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The report a pill's popover shows now, if the pill is shown. */
export function waitingEntryOf(pillId: string): WaitingWorker | undefined {
  return entries.get(pillId);
}

/** The popover of one pill: the card of its newest report. Made once per pill. */
function contentFor(pillId: string): ComponentType<PluginButtonContentProps> {
  return function WaitingCard({ theme, layout, host }: PluginButtonContentProps) {
    const read = () => waitingEntryOf(pillId);
    const entry = useSyncExternalStore(subscribeEntries, read, read);
    if (entry === undefined) return null;
    const card = toChatCard({ type: "user_message", text: entry.text }, "complete");
    if (card === undefined) return null;
    return (
      <ChatCardView
        theme={theme}
        layout={layout}
        host={host}
        agentId={entry.managerId}
        item={{ type: "plugin", kind: CHAT_CARD_KIND, version: CHAT_CARD_VERSION, data: card }}
        timestamp={entry.at === null ? new Date() : new Date(entry.at)}
      />
    );
  };
}

function buttonOf(pill: WaitingPill, Content: ComponentType<PluginButtonContentProps>): PluginButton {
  return {
    title: pill.title,
    label: pill.label,
    icon: WAITING_PILL_ICON,
    behavior: { kind: "popover", Content },
  };
}

/** Starts the pills; returns the cleanup that stops reading and removes them all. */
export function registerWaitingPills(client: PluginClientContext): () => void {
  const shown = new Map<
    string,
    {
      key: string;
      managerId: string;
      workspaceId: string;
      Content: ComponentType<PluginButtonContentProps>;
      registration: PluginButtonRegistration;
    }
  >();
  let pending = false;
  let stopped = false;

  const refresh = async () => {
    if (pending || stopped) return;
    pending = true;
    try {
      const { waiting } = await client.rpc(chatWaitingRpc, {});
      if (stopped) return;
      const plan = planPills(new Map([...shown].map(([id, pill]) => [id, pill.key])), waiting);
      for (const id of plan.remove) {
        shown.get(id)?.registration.remove();
        shown.delete(id);
        setEntry(id, undefined);
      }
      const added = [...plan.add];
      for (const pill of plan.update) {
        const current = shown.get(pill.id);
        if (current === undefined) continue;
        // A registration cannot move to another chat: re-add it there instead.
        if (current.managerId !== pill.entry.managerId || current.workspaceId !== pill.entry.workspaceId) {
          current.registration.remove();
          shown.delete(pill.id);
          added.push(pill);
          continue;
        }
        setEntry(pill.id, pill.entry);
        current.registration.update(buttonOf(pill, current.Content));
        current.key = pill.key;
      }
      for (const pill of added) {
        const Content = contentFor(pill.id);
        setEntry(pill.id, pill.entry);
        const registration = client.addComposerPill({
          id: pill.id,
          workspaceId: pill.entry.workspaceId,
          agentId: pill.entry.managerId,
          button: buttonOf(pill, Content),
        });
        shown.set(pill.id, { key: pill.key, managerId: pill.entry.managerId, workspaceId: pill.entry.workspaceId, Content, registration });
      }
    } catch {
      // A failed read keeps the pills as they are: better a pill one period
      // late than pills that flicker whenever the daemon is slow.
    } finally {
      pending = false;
    }
  };

  void refresh();
  const timer = setInterval(() => void refresh(), WAITING_POLL_MS);
  // Node (tests) would otherwise stay alive for the timer; hosts without unref ignore this.
  (timer as { unref?: () => void }).unref?.();
  return () => {
    stopped = true;
    clearInterval(timer);
    for (const [id, pill] of shown) {
      pill.registration.remove();
      setEntry(id, undefined);
    }
    shown.clear();
  };
}
