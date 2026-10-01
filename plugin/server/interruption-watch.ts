/**
 * Interruptions that were not the owner's (ADR-024): `BM-INTERRUPTED`.
 *
 * Paseo delivers a message to a running agent by REPLACING its turn (the
 * notice queue's K10): an agent it created finishing (`notifyOnFinish`), or
 * another agent's `send_agent_prompt`. Claude Code reports the call it cut as
 * "The user doesn't want to proceed with this tool use … STOP what you are doing
 * and wait for the user", so the agent believes the owner stopped it. In the
 * field store (2026-10-01) 123 turns were cut this way; in at least 10 the
 * agent then stopped and waited, and one Worker told the Orchestrator the
 * owner had "declined" an e2e run nobody declined.
 *
 * The plugin decides from structure, never from words — any agent can write
 * the words, and their wording is the provider's to change:
 *
 * | Signal | Paseo's cut | The owner's stop |
 * |---|---|---|
 * | the turn's `outcome` | `canceled` | `canceled` |
 * | the next turn | starts within `INTERRUPT_GAP_MS` of the cut | none starts by itself |
 * | an owner-typed message (`clientMessageId`, `origin: user`) in it | none | the owner's new message, when the owner typed one |
 * | `agent.permission_resolved` with `deny` for the agent | none | the owner's deny |
 *
 * (`isPaseoInterruption`, pure.) When all four say Paseo, the watch waits
 * `INTERRUPT_SETTLE_MS` and sends `BM-INTERRUPTED` through the notice queue —
 * only if by then the agent is idle, started no newer turn, and no agent it
 * created is running (an agent that went on with its work has one running, or
 * is running itself). At most one notice per agent per `INTERRUPT_COOLDOWN_MS`,
 * so a notice's own turn cannot feed a loop.
 *
 * - **Roles:** a Manager or a Worker, the agents that create agents. A
 *   Reviewer creates none, and the collector records no Orchestrator turn.
 * - **Providers:** the agent's alias must extend `claude` or `codex`. OpenCode
 *   never reports `agent.permission_resolved`, so an owner's deny cannot be told
 *   apart there: no notice; that agent behaves as before.
 * - **In memory.** The previous turn of each agent and the denies are kept for
 *   the plugin run; after a reload the first cut is missed, and the stall pass
 *   (`stall-watcher.ts`) still raises the request if it stops moving.
 *
 * Never throws: a failure is one log line.
 */
import { agentsOf, type OrchestratorStatePaseo } from "./orchestrator-state";
import { baseProviderOf } from "./role-instructions";
import { enqueue as enqueueNotice, type NoticeOutcome, type NoticePaseo } from "./notice-queue";
import { errorText } from "./rpc-kit";
import type { TraceRecord } from "../shared/contracts";
import { INTERRUPTED_NOTICE_MARKER } from "../shared/notices";

/** The next turn starts this close to the cut, either side (field: −0.8 s … +2.0 s). */
export const INTERRUPT_GAP_MS = 3_000;
/** How long the watch waits before deciding the agent stopped. */
export const INTERRUPT_SETTLE_MS = 20_000;
/** At most one notice per agent in this window. */
export const INTERRUPT_COOLDOWN_MS = 10 * 60_000;
/** The notice's marker. */
export const INTERRUPTED_KIND = INTERRUPTED_NOTICE_MARKER;

const ROLES = new Set(["manager", "worker"]);
const PROVIDERS = new Set(["claude", "codex"]);

/** What the watch keeps of an agent's previous turn. */
export interface PreviousTurn {
  outcome: TraceRecord["outcome"];
  startedAt: string | null;
  endedAt: string;
}

const time = (iso: string | null | undefined): number | null => {
  if (typeof iso !== "string") return null;
  const parsed = Date.parse(iso);
  return Number.isNaN(parsed) ? null : parsed;
};

/**
 * Whether `current` is the turn Paseo started by cutting `previous` short:
 * `previous` was canceled, `current` started within `INTERRUPT_GAP_MS` of
 * that, holds no owner-typed message, and the owner denied nothing to the
 * agent from `previous`'s start to `current`'s end. Pure.
 */
export function isPaseoInterruption(
  previous: PreviousTurn | undefined,
  current: Pick<TraceRecord, "startedAt" | "endedAt" | "sent">,
  deniedAt: readonly number[],
): boolean {
  if (previous === undefined || previous.outcome !== "canceled") return false;
  const cut = time(previous.endedAt);
  const started = time(current.startedAt);
  if (cut === null || started === null || Math.abs(started - cut) > INTERRUPT_GAP_MS) return false;
  if (current.sent.some((message) => message.origin === "user")) return false;
  const from = time(previous.startedAt) ?? cut - INTERRUPT_COOLDOWN_MS;
  const to = Math.max(started + INTERRUPT_GAP_MS, time(current.endedAt) ?? started);
  return !deniedAt.some((at) => at >= from && at <= to);
}

/** The notice. The words are fixed; nothing of the conversation goes in it. */
export function interruptedNoticeText(cutAt: string): string {
  return [
    INTERRUPTED_KIND,
    `cutAt: ${cutAt}`,
    "From the paseo-bm plugin, not the owner. Your turn that ended at cutAt was cut short by Paseo delivering a message to you while a tool call ran (an agent you created finishing, or another agent's message). The owner did not stop you and declined nothing: a tool result that said \"The user doesn't want to proceed with this tool use\" or \"[Request interrupted by user for tool use]\" in that turn came from the cut.",
    "Check whether the call that was cut took effect by reading the state it changes, do it again if it did not, and carry on with your work. If you already carried on, reply `noted` in one line and end this turn. A message the owner sends after this one always wins.",
  ].join("\n");
}

export interface InterruptionWatchDeps {
  now?: () => number;
  settleMs?: number;
  log?: (line: string) => void;
  /** The notice queue's `enqueue`; tests pass their own. */
  enqueue?: (targetId: string, kind: string, text: string, paseo?: NoticePaseo) => Promise<NoticeOutcome>;
  /** The base provider of an alias; `baseProviderOf` by default. */
  baseProvider?: (paseo: unknown, alias: string) => Promise<string | null>;
  /** Timers; tests use fake ones. */
  setTimer?: (run: () => void, ms: number) => unknown;
}

export interface InterruptionWatch {
  /** A turn recorded by the collector (with the hook's handle). */
  turnRecorded(record: TraceRecord, paseo: unknown): void;
  /** Any agent's turn start: a pending check for it is dropped. */
  turnStarted(agentId: string): void;
  /** `agent.permission_resolved`: a deny is the owner's. */
  permissionResolved(event: unknown): void;
  /** The pending checks, for tests: resolves when every check scheduled so far has run. */
  settled(): Promise<void>;
}

export function createInterruptionWatch(deps: InterruptionWatchDeps = {}): InterruptionWatch {
  const now = deps.now ?? (() => Date.now());
  const log = deps.log ?? ((line: string) => console.warn(line));
  const enqueue = deps.enqueue ?? enqueueNotice;
  const baseProvider = deps.baseProvider ?? baseProviderOf;
  const setTimer =
    deps.setTimer ??
    ((run: () => void, ms: number) => {
      const timer = setTimeout(run, ms);
      timer.unref?.();
      return timer;
    });
  const settleMs = deps.settleMs ?? INTERRUPT_SETTLE_MS;
  const previous = new Map<string, PreviousTurn>();
  const denies = new Map<string, number[]>();
  /** Bumped by every turn start or record of an agent; a check runs only if it did not move. */
  const generation = new Map<string, number>();
  const lastNotice = new Map<string, number>();
  const pending = new Set<Promise<void>>();

  const bump = (agentId: string): number => {
    const next = (generation.get(agentId) ?? 0) + 1;
    generation.set(agentId, next);
    return next;
  };

  async function check(agentId: string, alias: string, cutAt: string, paseo: unknown, seen: number): Promise<void> {
    if (generation.get(agentId) !== seen) return;
    const last = lastNotice.get(agentId);
    if (last !== undefined && now() - last < INTERRUPT_COOLDOWN_MS) return;
    const base = await baseProvider(paseo, alias);
    if (base === null || !PROVIDERS.has(base)) return;
    const snapshot = await agentsOf(paseo as Pick<OrchestratorStatePaseo, "agents">);
    if (generation.get(agentId) !== seen) return;
    const self = snapshot.bm.find((entry) => entry.facts.id === agentId)?.facts.status ?? null;
    if (self === null || self === "running" || self === "initializing") return;
    // An agent that went on with its work has an agent it created running.
    if (snapshot.bm.some((entry) => entry.facts.parentAgentId === agentId && !entry.facts.archived && entry.facts.status === "running")) return;
    lastNotice.set(agentId, now());
    const outcome = await enqueue(agentId, INTERRUPTED_KIND, interruptedNoticeText(cutAt), paseo as NoticePaseo);
    log(`[paseo-bm] ${INTERRUPTED_KIND} to ${agentId} (cut at ${cutAt}): ${outcome}`);
  }

  return {
    turnRecorded(record, paseo) {
      try {
        const before = previous.get(record.agentId);
        previous.set(record.agentId, { outcome: record.outcome, startedAt: record.startedAt, endedAt: record.endedAt });
        const seen = bump(record.agentId);
        if (paseo === undefined || paseo === null || !ROLES.has(record.role)) return;
        const alias = record.runtime?.provider;
        if (typeof alias !== "string" || alias === "") return;
        if (!isPaseoInterruption(before, record, denies.get(record.agentId) ?? [])) return;
        const cutAt = before!.endedAt;
        const run = new Promise<void>((resolve) => {
          setTimer(() => {
            check(record.agentId, alias.split("/")[0]!, cutAt, paseo, seen)
              .catch((error: unknown) => log(`[paseo-bm] could not check an interruption of ${record.agentId}: ${errorText(error)}`))
              .finally(resolve);
          }, settleMs);
        });
        pending.add(run);
        void run.finally(() => pending.delete(run));
      } catch (error) {
        log(`[paseo-bm] could not look at an interruption of ${record.agentId}: ${errorText(error)}`);
      }
    },
    turnStarted(agentId) {
      bump(agentId);
    },
    permissionResolved(event) {
      const { agent, resolution } = (event ?? {}) as { agent?: { id?: unknown }; resolution?: { behavior?: unknown } };
      if (typeof agent?.id !== "string" || resolution?.behavior !== "deny") return;
      const kept = (denies.get(agent.id) ?? []).filter((at) => now() - at < INTERRUPT_COOLDOWN_MS * 3);
      kept.push(now());
      denies.set(agent.id, kept);
    },
    async settled() {
      await Promise.all([...pending]);
    },
  };
}
