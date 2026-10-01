/**
 * The Inbox's server side (autonomy design §A.8, §A.12, §B.7): `inbox.alerts`,
 * the open alerts of the alerts store (`alert-store.ts`) as the Inbox lists
 * them; `inbox.seen`, the Inbox is shown (`inbox-seen-store.ts`); and
 * `inbox.digest`, Decided for you — the decisions the owner's policy and
 * precedents answered since then. The Inbox's own decisions come from
 * `decisions.list` (`decision-rpc.ts`), and Override is `decisions.override`
 * (`decision-override.ts`).
 *
 * `inbox.alerts` and `inbox.digest` read only: an alert is raised and cleared
 * by its producers (the stall pass, the Worker watch, the role pairing check,
 * the fallback decisions), never by the Inbox. `inbox.seen` writes the one
 * file it owns. The handlers take an injectable `InboxRpcDeps`, like the
 * `decisions.*` handlers, and read through the RPC kit (`rpc-kit.ts`).
 *
 * The digest also lists the Orchestrator's interventions since then (§G.3
 * "Where it shows", bead `t9lm.23`), read from the intervention log
 * (`intervention-store.ts`) with whom each was for and the Orchestrator's own
 * words about it, from the stores that keep them (`interventionTargetRoleOf`,
 * `interventionReasonOf`): the decisions, the commands, and for a `compact`
 * its compaction (`compaction-store.ts`).
 */
import type { PluginServerContext } from "@getpaseo/plugin/server";
import {
  DIGEST_INTERVENTION_REASON_MAX,
  INBOX_ALERTS_MAX,
  INBOX_DIGEST_MAX,
  inboxAlertsRpc,
  inboxDigestRpc,
  inboxSeenRpc,
  type DigestIntervention,
  type DigestTargetRole,
  type InboxAlertsInput,
  type InboxAlertsOutput,
  type InboxDigestInput,
  type InboxDigestOutput,
  type InboxSeenOutput,
} from "../shared/contracts";
import { ALERT_KINDS, type Alert } from "../shared/alerts";
import { isDecidedForOwner } from "../shared/decision-override";
import { decisionKindOf, type Decision } from "../shared/decisions";
import type { InterventionEntry } from "../shared/interventions";
import type { Proposal } from "../shared/orchestrator";
import { shorten } from "../shared/text";
import { createAlertStore } from "./alert-store";
import { redactText } from "./collector";
import { createCompactionStore, type CompactionEntry } from "./compaction-store";
import { createDecisionStore, type DecisionStore } from "./decision-store";
import { createInboxSeenStore } from "./inbox-seen-store";
import { createInterventionStore } from "./intervention-store";
import { createOrchestratorStore } from "./orchestrator-store";
import { READ_FAILED, coded, dataHome, readOr, requireDataHome, withPaseoTap, type RpcHomeDeps, type RpcLogDeps } from "./rpc-kit";
import { timeOrZero } from "../shared/time";

/** `log`: where an unreadable store is reported; `console.warn` by default. */
export type InboxRpcDeps = RpcHomeDeps &
  RpcLogDeps & {
    /**
     * Called with the RPC's Paseo handle at each read of the alerts, before
     * the store is read and not waited for: the throttled outdated-agents pass
     * (`outdated-agents.ts`), whose alerts show from the next read on.
     */
    onRead?: (paseo: unknown) => unknown;
    /** The clock `inbox.seen` records; `new Date()` by default. */
    now?: () => Date;
    /** Secrets masked in an intervention's reason; the process's own by default. */
    redactEnv?: NodeJS.ProcessEnv;
  };

/** `ALERT_KINDS` order, then oldest first; the key breaks a tie so the order is stable. */
export function inboxAlertOrder(a: Alert, b: Alert): number {
  return (
    ALERT_KINDS.indexOf(a.kind) - ALERT_KINDS.indexOf(b.kind) ||
    timeOrZero(a.since) - timeOrZero(b.since) ||
    (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)
  );
}

/**
 * `inbox.alerts`. No usable data folder, or a store that cannot be read (a
 * symlink below the data folder), reads as no alerts: the Inbox must still
 * show its decisions. The unreadable store costs one log line.
 */
export function handleInboxAlerts(input: InboxAlertsInput, deps: InboxRpcDeps = {}): InboxAlertsOutput {
  const open = readOr(deps, "the Inbox alerts", [] as Alert[], (home) =>
    createAlertStore(home).list({ open: true, ...(input.workspaceId === undefined ? {} : { workspaceId: input.workspaceId }) }),
  );
  const ordered = [...open].sort(inboxAlertOrder);
  return { alerts: ordered.slice(0, INBOX_ALERTS_MAX), truncated: ordered.length > INBOX_ALERTS_MAX };
}

/**
 * `inbox.seen` (§B.7, §B.9): the Inbox is shown now. Records it and answers
 * where Decided for you starts for this visit (`inbox-seen-store.ts`). No
 * usable data folder, or a file below it that cannot be read safely →
 * `E_DATA_HOME_UNAVAILABLE`; a newer or unwritable file → `E_INBOX_WRITE_FAILED`.
 */
export function handleInboxSeen(deps: InboxRpcDeps = {}): InboxSeenOutput {
  const home = requireDataHome(deps, "record that the Inbox was shown");
  const store = createInboxSeenStore(home);
  // A symlink is a data folder that cannot be used here, as for every read (rpc-kit).
  coded(READ_FAILED, "read when the Inbox was last shown", () => store.inspect());
  const now = deps.now?.() ?? new Date();
  const seen = coded("E_INBOX_WRITE_FAILED", "record that the Inbox was shown", () => store.shown(now));
  return { since: seen.since, seenAt: seen.seenAt ?? now.toISOString() };
}

/** The latest answer first; the id breaks a tie so the order is stable. */
function latestAnswerFirst(a: Decision, b: Decision): number {
  return timeOrZero(b.answer?.at ?? null) - timeOrZero(a.answer?.at ?? null) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/** The latest intervention first; the id breaks a tie so the order is stable. */
function latestInterventionFirst(a: InterventionEntry, b: InterventionEntry): number {
  return timeOrZero(b.at) - timeOrZero(a.at) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/**
 * Whom an intervention was for (§G.3), which the log does not keep: advice is
 * the owner's; an answer is the Worker's whose question it answered (a
 * fallback incident's answer names no role); a compaction's target is the
 * Manager or Worker its compaction records (§G.5); a command's target is the
 * one the commands store recorded (`to`, a Manager when absent); without it,
 * an entry naming a Worker signal was for that Worker. Null when the stores
 * cannot tell. Pure.
 */
export function interventionTargetRoleOf(
  entry: InterventionEntry,
  command: Pick<Proposal, "to"> | undefined,
  compaction: Pick<CompactionEntry, "role"> | null = null,
): DigestTargetRole | null {
  if (entry.kind === "advice") return "owner";
  if (entry.kind === "answer") return entry.decisionId !== undefined && decisionKindOf(entry.decisionId) === "question" ? "worker" : null;
  if (entry.kind === "compact") return compaction?.role ?? null;
  if (command !== undefined) return command.to ?? "manager";
  return entry.signal !== undefined ? "worker" : null;
}

/**
 * The Orchestrator's own words about an intervention, which the log does not
 * keep: an answer's reason (`bm_decide`), the advice's question (its first
 * line), a compaction's reason (`bm_compact`, masked when stored), a
 * command's `why:` — redacted, on one line, at most
 * `DIGEST_INTERVENTION_REASON_MAX` characters. Null when the store keeps none
 * or the record is gone. Pure.
 */
export function interventionReasonOf(
  entry: InterventionEntry,
  found: {
    decision: Pick<Decision, "question" | "answer"> | null;
    command: Pick<Proposal, "reason"> | undefined;
    compaction?: Pick<CompactionEntry, "reason"> | null;
  },
  env: NodeJS.ProcessEnv,
): string | null {
  const text =
    entry.kind === "answer"
      ? (found.decision?.answer?.reason ?? null)
      : entry.kind === "advice"
        ? (found.decision?.question.split("\n")[0] ?? null)
        : entry.kind === "compact"
          ? (found.compaction?.reason ?? null)
          : (found.command?.reason ?? null);
  if (text === null) return null;
  const line = shorten(redactText(text, env), DIGEST_INTERVENTION_REASON_MAX);
  return line === "" ? null : line;
}

/**
 * The digest's interventions (§G.3, bead `t9lm.23`): logged after `after`, of
 * `workspaceId` when given, the latest first, at most `INBOX_DIGEST_MAX`, each
 * with its target role and reason. Never throws: a log, commands store,
 * compactions store or decision that cannot be read reads as none, one log
 * line each.
 */
function interventionsAfter(
  home: string,
  workspaceId: string | undefined,
  after: number | null,
  decisions: DecisionStore,
  deps: InboxRpcDeps,
): { interventions: DigestIntervention[]; truncated: boolean } {
  const quiet = { home, ...(deps.log === undefined ? {} : { log: deps.log }) };
  const matched = readOr(quiet, "the Orchestrator's interventions", [] as InterventionEntry[], (at) =>
    createInterventionStore(at)
      .list()
      .filter((entry) => (workspaceId === undefined || entry.workspaceId === workspaceId) && (after === null || timeOrZero(entry.at) > after)),
  ).sort(latestInterventionFirst);
  const shown = matched.slice(0, INBOX_DIGEST_MAX);
  // The commands store is read once, and only when a shown entry names a command.
  const commands = new Map(
    (shown.some((entry) => entry.commandId !== undefined)
      ? readOr(quiet, "the Orchestrator's commands", [] as Proposal[], (at) => createOrchestratorStore(at).listCommands())
      : []
    ).map((command) => [command.id, command]),
  );
  // The compactions store likewise, only when a shown entry is a compaction; keyed by the intervention each is logged as.
  const compactions = new Map(
    (shown.some((entry) => entry.kind === "compact")
      ? readOr(quiet, "the Orchestrator's compactions", [] as CompactionEntry[], (at) => createCompactionStore(at).list())
      : []
    ).flatMap((compaction) => (compaction.interventionId === null ? [] : [[compaction.interventionId, compaction] as const])),
  );
  const env = deps.redactEnv ?? process.env;
  const interventions = shown.map((entry): DigestIntervention => {
    const command = entry.commandId === undefined ? undefined : commands.get(entry.commandId);
    const compaction = entry.kind === "compact" ? (compactions.get(entry.id) ?? null) : null;
    const decisionId = entry.decisionId;
    const decision = decisionId === undefined ? null : readOr(quiet, `decision ${decisionId}`, null, () => decisions.get(decisionId, entry.workspaceId));
    return {
      ...entry,
      targetRole: interventionTargetRoleOf(entry, command, compaction),
      reason: interventionReasonOf(entry, { decision, command, compaction }, env),
    };
  });
  return { interventions, truncated: matched.length > INBOX_DIGEST_MAX };
}

/**
 * `inbox.digest` (§B.7; PRD REQ-125 a): the decisions answered for the owner
 * — by the policy or an owner precedent (`isDecidedForOwner`) — after `since`,
 * the latest first, at most `INBOX_DIGEST_MAX`. Reads only. No usable data
 * folder reads as none; a store that cannot be read safely →
 * `E_DATA_HOME_UNAVAILABLE`. Each comes back as stored: its answer, reason,
 * class and precedent, and its reversals — an `overridden` one names the
 * owner's override. Beside them, the Orchestrator's interventions after
 * `since` (§G.3, `interventionsAfter`), which never fail the digest.
 */
export function handleInboxDigest(input: InboxDigestInput, deps: InboxRpcDeps = {}): InboxDigestOutput {
  const home = dataHome(deps);
  if (home === null) return { decisions: [], truncated: false, interventions: [], interventionsTruncated: false };
  const store = createDecisionStore(home, deps.log === undefined ? {} : { log: deps.log });
  const after = input.since === undefined ? null : Date.parse(input.since);
  const answered = coded(READ_FAILED, "read the decisions decided for you", () =>
    store.list({ ...(input.workspaceId === undefined ? {} : { workspaceId: input.workspaceId }), statuses: ["answered"] }),
  );
  const matched = answered.filter((decision) => isDecidedForOwner(decision) && (after === null || timeOrZero(decision.answer!.at) > after)).sort(latestAnswerFirst);
  const { interventions, truncated } = interventionsAfter(home, input.workspaceId, after, store, deps);
  return { decisions: matched.slice(0, INBOX_DIGEST_MAX), truncated: matched.length > INBOX_DIGEST_MAX, interventions, interventionsTruncated: truncated };
}

/**
 * `inbox.alerts` hears each read's Paseo handle first (`onRead`, through
 * `withPaseoTap`): a producer's failure never costs the Inbox its alerts.
 * `inbox.seen` and `inbox.digest`, polled beside it, do not start it again.
 */
export function registerInboxRpcs(server: PluginServerContext, deps: InboxRpcDeps = {}): void {
  withPaseoTap(server, deps.onRead).handle(inboxAlertsRpc, (input) => handleInboxAlerts(input, deps));
  server.handle(inboxSeenRpc, () => handleInboxSeen(deps));
  server.handle(inboxDigestRpc, (input) => handleInboxDigest(input, deps));
}
