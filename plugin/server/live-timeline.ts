/**
 * Skills and user messages read live from an agent's timeline, when a trace
 * is opened.
 *
 * The collector records both from the turn it was installed on. Everything an
 * agent did before that is still in Paseo's own timeline for as long as the
 * agent exists, so opening a trace fills the gap from there instead of making
 * the user wait for new turns.
 *
 * Only Workers and Reviewers are read: each belongs to one request, so its
 * whole timeline is that request's. A Manager serves every request of the
 * workspace, and nothing in its timeline says which request a message was
 * about.
 *
 * Verified on Paseo 0.8: `timeline.refetch({ direction: "tail" })` returns the
 * newest page and `startCursor`; `direction: "before"` with that cursor pages
 * back. Real agents needed 2–5 pages of 200 and under 200 ms.
 */
import { redactText, skillsFromItem } from "./collector";
import { isPluginNotice } from "./notices";
import { MAX_MESSAGE_CHARS, TRUNCATION_MARKER } from "./trace-store";
import type { TraceMessage } from "../shared/contracts";
import { byAt, uniqueBy } from "../shared/order";

/** A long-lived agent is read at most this far back. */
export const LIVE_PAGE_LIMIT = 200;
export const LIVE_MAX_PAGES = 25;

export interface LiveTimelinePaseo {
  agents: {
    ref?(agentId: string): {
      timeline: { refetch(options: Record<string, unknown>): Promise<unknown> };
    };
  };
}

export interface LiveExtras {
  skills: Array<{ agentId: string; skill: string; at: string | null }>;
  userMessages: TraceMessage[];
}

interface Page {
  entries?: Array<{ item?: unknown; timestamp?: unknown }>;
  hasOlder?: unknown;
  startCursor?: unknown;
}

function capped(text: string): { text: string; truncated: boolean } {
  if (text.length <= MAX_MESSAGE_CHARS) return { text, truncated: false };
  return { text: `${text.slice(0, MAX_MESSAGE_CHARS - TRUNCATION_MARKER.length)}${TRUNCATION_MARKER}`, truncated: true };
}

/**
 * Reads an agent's timeline newest page first, back at most `pages` pages,
 * handing each page's entries (oldest first, as Paseo returns them) to
 * `visit`. Returns how many entries were read. Never throws: an agent that
 * cannot be read simply yields nothing.
 */
export async function readTimelinePages(
  paseo: LiveTimelinePaseo,
  agentId: string,
  options: { pages: number; limit: number },
  visit: (entries: NonNullable<Page["entries"]>) => void,
): Promise<number> {
  const ref = paseo.agents.ref?.(agentId);
  if (ref === undefined) return 0;
  let cursor: unknown;
  let read = 0;
  for (let page = 0; page < options.pages; page += 1) {
    let payload: Page;
    try {
      payload = (await ref.timeline.refetch(
        cursor === undefined
          ? { direction: "tail", limit: options.limit }
          : { direction: "before", cursor, limit: options.limit },
      )) as Page;
    } catch {
      return read;
    }
    const entries = payload.entries ?? [];
    read += entries.length;
    visit(entries);
    if (payload.hasOlder !== true || payload.startCursor === undefined || payload.startCursor === null) return read;
    cursor = payload.startCursor;
  }
  return read;
}

/** Skills and typed user messages of one agent's timeline, back to the start (bounded). */
async function readAgent(paseo: LiveTimelinePaseo, agentId: string, out: LiveExtras, env: NodeJS.ProcessEnv): Promise<void> {
  await readTimelinePages(paseo, agentId, { pages: LIVE_MAX_PAGES, limit: LIVE_PAGE_LIMIT }, (entries) => {
    for (const entry of entries) {
      const item = entry.item as { type?: unknown; text?: unknown; clientMessageId?: unknown } | undefined;
      if (item === undefined || item === null) continue;
      const at = typeof entry.timestamp === "string" ? entry.timestamp : null;
      for (const skill of skillsFromItem(item as never)) out.skills.push({ agentId, skill, at });
      if (
        item.type === "user_message" &&
        typeof item.clientMessageId === "string" &&
        typeof item.text === "string" &&
        !isPluginNotice(item.text)
      ) {
        const { text, truncated } = capped(redactText(item.text, env));
        out.userMessages.push({ agentId, at: at ?? "", text, truncated, origin: "user" });
      }
    }
  });
}

export async function readLiveExtras(
  paseo: LiveTimelinePaseo,
  agentIds: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<LiveExtras> {
  const out: LiveExtras = { skills: [], userMessages: [] };
  await Promise.all(agentIds.map((agentId) => readAgent(paseo, agentId, out, env)));
  return out;
}

/** Recorded and live entries together, once each, oldest first. */
export function mergeExtras(recorded: LiveExtras, live: LiveExtras): LiveExtras {
  return {
    skills: uniqueBy([...recorded.skills, ...live.skills].sort(byAt), (entry) => `${entry.agentId}|${entry.skill}`),
    userMessages: uniqueBy(
      [...recorded.userMessages, ...live.userMessages].sort(byAt),
      (message) => `${message.agentId}|${message.text}`,
    ),
  };
}
