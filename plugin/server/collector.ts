/**
 * Turn collector: the only writer of the trace store (WP-205, Dashboard Design
 * §2.2 decision 1, §3.3, §17).
 *
 * It hangs off Paseo's own lifecycle hooks — `agent.turn_started` for the start
 * mark and `agent.turn_ended` for the record — so there is no timer, no watcher
 * and no polling loop; the "no background work" rule of the base design §9
 * still holds. The plugin already uses `agent.turn_ended` for stop propagation
 * (bm-wq6), so this is a known-good seam.
 *
 * The hard rule here is that this code runs **inside a real agent's turn**:
 * nothing it does may throw into the host. Out of disk space, no permission, a
 * store written by a newer paseo-bm, a lock it could not get in five seconds —
 * all of them end the same way: the turn is dropped, one line is logged, and
 * the agent is untouched (REQ-053c).
 *
 * SDK facts this relies on (checked against @getpaseo/plugin 0.8.0
 * `server/lifecycle.d.ts` and @getpaseo/client 0.8.0, not guessed):
 * - `on("agent.turn_started" | "agent.turn_ended", (event, { paseo }) => …)`;
 *   the ended event carries `agent`, `turnId`, `outcome.kind` and `timeline`.
 * - **The hook `timeline` is the agent's WHOLE timeline with the timestamps
 *   stripped.** Verified against the shipped daemon (Paseo 0.8.0, WP-205.2):
 *   `publishAgentStream(..., this.timelineStore.getItems(agentId))` and
 *   `getItems(agentId) { return this.requireState(agentId).rows.map(row => row.item) }`
 *   — the store keeps `{ seq, timestamp, turnId, item }` rows but the hook only
 *   receives `row.item`, and it receives every row, not the ended turn's rows.
 *   That is assumptions A-1/A-2 of the PRD, and it decides the design here: the
 *   turn's own items come from one `timeline.refetch()` call, whose entries do
 *   carry `turnId` and `timestamp`, and the hook payload is only a fallback.
 *   Using the hook payload as the turn would put the entire conversation into
 *   every record and parse every old report again.
 * - the `refetch` payload also carries an `agent` snapshot whose `lastUsage`
 *   gives tokens and (sometimes) cost, which is where a record's `usage` comes
 *   from — and, on Paseo 0.9.2 for Claude, Codex and OpenCode alike, the
 *   context in use and the window (`contextWindowUsedTokens` /
 *   `contextWindowMaxTokens`; run note 2026-09-30, autonomy design §G.2).
 */
import { homedir } from "node:os";
import { basename, dirname } from "node:path";
import type { PluginLifecycleEvents, PluginServerContext } from "@getpaseo/plugin/server";
import { parseReports, parseReviews, requestIdFromText } from "./bm-report";
import { pluginSentMatcher } from "./compaction-store";
import { isPluginNotice } from "./notices";
import { stripNewRequestMarker } from "../shared/new-request";
import { resolveDataHome } from "./data-home";
import { roleOfProvider, type BmRole } from "./agent-role";
import { providerId } from "./provider-id";
import { BOUNDARY_LABEL } from "./role-mode";
import {
  TraceStoreLockTimeout,
  appendRecord,
  writeWorkspaceMeta,
  type TraceStoreLocation,
} from "./trace-store";
import {
  TRACE_STORE_SCHEMA_VERSION,
  type Evidence,
  type ParsedReport,
  type ParsedReview,
  type TraceMessage,
  type TraceRecord,
  type TraceRuntime,
  type Usage,
} from "../shared/contracts";
import { PLUGIN_VERSION } from "../shared/version";

/** Timeline entries read back per turn when timestamps have to be recovered. */
export const REFETCH_LIMIT = 200;

/**
 * Secret masking, applied **before** anything reaches the disk (REQ-048b).
 *
 * Same rule set as the retired installer's masking (Technical Design §9): the
 * *values* of these environment variables, and the value following a
 * password-shaped flag. They are a short closed list by design.
 */
export const SECRET_ENV_VARS: readonly string[] = ["PASEO_PASSWORD", "PASEO_DAEMON_PASSWORD"];
export const SECRET_ARGV_FLAGS: readonly string[] = ["--password", "--token", "--secret"];
export const REDACTED = "[redacted]";

/** Masks every known secret in a string. Never lengthens it beyond the mask. */
export function redactText(text: string, env: NodeJS.ProcessEnv = process.env): string {
  if (typeof text !== "string" || text === "") return "";
  let out = text;
  for (const name of SECRET_ENV_VARS) {
    const value = env[name];
    if (typeof value === "string" && value.trim() !== "") {
      out = out.split(value).join(REDACTED);
    }
  }
  for (const flag of SECRET_ARGV_FLAGS) {
    // `--password secret`, `--password=secret` and `--password "secret"`.
    const pattern = new RegExp(`(${flag})(\\s*=\\s*|\\s+)("[^"]*"|'[^']*'|\\S+)`, "gi");
    out = out.replace(pattern, `$1$2${REDACTED}`);
  }
  return out;
}

type TurnEndedEvent = PluginLifecycleEvents["agent.turn_ended"];
type TurnStartedEvent = PluginLifecycleEvents["agent.turn_started"];
type TimelineItem = TurnEndedEvent["timeline"][number];

/** One timeline entry with the timestamp the store needs. */
export interface TimedItem {
  item: TimelineItem;
  at: string;
}

/** The slice of the SDK the collector uses to recover timestamps and usage. */
export interface CollectorPaseo {
  agents: {
    ref(agentId: string): {
      timeline: {
        refetch(options: { direction?: string; limit?: number }): Promise<unknown>;
      };
    };
  };
}

export interface CollectorDeps {
  /** Resolved trace store, or null when tracing is disabled (WP-202). */
  location: TraceStoreLocation | null;
  paseo?: CollectorPaseo;
  now?: () => Date;
  env?: NodeJS.ProcessEnv;
  log?: (message: string) => void;
  /** How long to wait for the workspace lock before dropping the turn (design §3.8). */
  lockTimeoutMs?: number;
  /**
   * Whether the plugin itself sent this `user_message` to the agent around
   * `at` (autonomy design §G.5): the send log of the compactions the
   * Orchestrator asked for (`compaction-store.ts` `pluginSentMatcher`). By
   * default the log of the data folder the trace store lives in, read once per
   * turn and only for a message that would otherwise be the owner's.
   */
  pluginSent?: (agentId: string, text: string, at: string | null) => boolean;
}

/**
 * The send log beside the trace store `location` (the data folder is its
 * parent, `data-home.ts`); none without a store. Work's live view reads the
 * timelines with it too (`live-timeline.ts`).
 */
export function pluginSentBeside(location: TraceStoreLocation | null): (agentId: string, text: string, at: string | null) => boolean {
  return pluginSentMatcher(location === null ? null : dirname(location.tracesDir));
}

function textOf(item: TimelineItem): string | null {
  if (item.type === "user_message" || item.type === "assistant_message") {
    return typeof item.text === "string" ? item.text : null;
  }
  return null;
}

interface StreamedText {
  type: "assistant_message";
  text: string;
  messageId?: unknown;
}

function isAssistantText(item: unknown): item is StreamedText {
  if (item === null || typeof item !== "object") return false;
  const { type, text } = item as { type?: unknown; text?: unknown };
  return type === "assistant_message" && typeof text === "string";
}

/**
 * `items` with each run of consecutive `assistant_message` items joined into one.
 *
 * A provider streams its reply in chunks, and the hook's timeline keeps every
 * chunk as an `assistant_message` of its own (`agent_message_chunk` in Paseo's
 * ACP connection), so a block read item by item arrives cut — `BM-REVIEW` then
 * `requ` — and the format check told 13 Reviewers their valid review broke the
 * template (traces 2026-09-22..24). Chunks join as they are; two messages with
 * different `messageId`s are kept apart by a blank line.
 */
export function joinStreamedText<T>(items: readonly T[]): T[] {
  const out: T[] = [];
  for (const item of items) {
    const previous = out.at(-1);
    if (isAssistantText(previous) && isAssistantText(item)) {
      const apart = typeof previous.messageId === "string" && typeof item.messageId === "string" && previous.messageId !== item.messageId;
      out[out.length - 1] = { ...previous, text: `${previous.text}${apart ? "\n\n" : ""}${item.text}` } as T;
      continue;
    }
    out.push(item);
  }
  return out;
}

/**
 * The tail of a whole-conversation timeline that plausibly belongs to the turn
 * that just ended: from the last `user_message` to the end.
 *
 * Used when there is no turn boundary to filter on: the hook payload carries
 * none, and a refetch whose `turnId` is null has none either. A turn begins
 * with a user message, so the slice is at most one turn.
 */
export function sliceLastTurn<T>(items: readonly T[], itemOf: (entry: T) => unknown = (entry) => entry): T[] {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = itemOf(items[index]!) as { type?: unknown } | null | undefined;
    if (item?.type === "user_message") return items.slice(index);
  }
  return [...items];
}

/** `…/<name>/SKILL.md` → `<name>`. */
const SKILL_FILE = /([A-Za-z0-9._-]+)\/SKILL\.md\b/;
/** Commands that read a file's content; `ls`, `test -f` and `find` only look. */
const READS_FILE = /^(?:cat|sed|head|tail|less|more|bat|nl)\b/;

/**
 * Skills an item loaded.
 *
 * Verified on Paseo 0.8 with Claude Code: a load is a `tool_call` named `Skill`
 * whose `plain_text` detail carries the skill name as `label` ("Launching skill:
 * feature-workflow"). Other providers read the skill's `SKILL.md`; a read of
 * that file counts, a directory listing or an existence check does not (the
 * Manager checks skills that way without loading them).
 */
export function skillsFromItem(item: TimelineItem): string[] {
  if (item.type !== "tool_call") return [];
  const call = item as { name?: unknown; detail?: { type?: string; label?: unknown; filePath?: unknown; command?: unknown } };
  const detail = call.detail;
  if (call.name === "Skill") {
    const label = detail?.label;
    return typeof label === "string" && label.trim() !== "" ? [label.trim()] : [];
  }
  if (detail?.type === "read" && typeof detail.filePath === "string") {
    const found = SKILL_FILE.exec(detail.filePath);
    return found === null ? [] : [found[1]!];
  }
  if (detail?.type === "shell" && typeof detail.command === "string") {
    const out: string[] = [];
    for (const segment of detail.command.split(/&&|\|\||[;\n|]/)) {
      const trimmed = segment.trim();
      if (!READS_FILE.test(trimmed)) continue;
      const found = SKILL_FILE.exec(trimmed);
      if (found !== null) out.push(found[1]!);
    }
    return out;
  }
  return [];
}

type ShellFacts = Pick<Evidence, "status" | "exitCode" | "cwd" | "callId">;

/**
 * What a `shell` entry keeps besides its command (autonomy design §C.1): the
 * call's `status` and `callId`, its exit code, and the folder it ran in, masked
 * like the command. Never its `output`, which can hold anything and is bulk.
 *
 * Captured on an isolated Paseo 0.9.2 daemon (2026-09-30), one passing and one
 * failing command per provider:
 * - Claude `Bash`: no `cwd` and no exit code; a failing command is
 *   `status: "failed"` (its code only in the error text), a passing one
 *   `completed`.
 * - Codex `shell`: `cwd` and `exitCode` on the detail (0, or the code); a
 *   failing command is `failed` as well.
 * - OpenCode `bash`: no `cwd`, and a failing command is `completed` too — its
 *   code is only in `metadata.exit`, so that is read when the detail has none.
 *   Without it an OpenCode failure would read as a success.
 */
function shellFactsOf(item: TimelineItem, cwd: string, env: NodeJS.ProcessEnv): ShellFacts {
  const call = item as { callId?: unknown; status?: unknown; detail?: { exitCode?: unknown }; metadata?: { exit?: unknown } };
  const facts: ShellFacts = {};
  if (typeof call.status === "string" && call.status !== "") facts.status = call.status;
  const said = call.detail?.exitCode;
  const exit = call.metadata?.exit;
  if (Number.isInteger(said)) facts.exitCode = said as number;
  else if (Number.isInteger(exit)) facts.exitCode = exit as number;
  else if (said === null) facts.exitCode = null;
  if (cwd !== "") facts.cwd = redactText(cwd, env);
  if (typeof call.callId === "string" && call.callId !== "") facts.callId = call.callId;
  return facts;
}

/**
 * Evidence a turn leaves behind: skills loaded, commands run, files written,
 * sub-agents started.
 *
 * This is the raw material for "did this request create beads?" (REQ-044b) and
 * the workflow table (REQ-045), so it records what was *observed*, never a
 * conclusion drawn from it. Every `detail` — command, file path, skill name,
 * sub-agent label — and a command's folder are masked with `redactText` before
 * they are kept, as messages are (REQ-048b, autonomy design §C.1).
 */
export function evidenceFromItem(item: TimelineItem, agentId: string, at: string, env: NodeJS.ProcessEnv = process.env): Evidence[] {
  if (item.type !== "tool_call") return [];
  const out: Evidence[] = skillsFromItem(item).map((skill) => ({ kind: "skill", detail: redactText(skill, env), agentId, at }));
  const detail = (item as { detail?: Record<string, unknown> }).detail;
  const text = (key: string): string => {
    const value = detail?.[key];
    return typeof value === "string" ? value.trim() : "";
  };
  switch (detail?.["type"]) {
    case "shell":
      if (text("command") !== "") out.push({ kind: "shell", detail: redactText(text("command"), env), agentId, at, ...shellFactsOf(item, text("cwd"), env) });
      break;
    case "edit":
    case "write":
      if (text("filePath") !== "") out.push({ kind: "file", detail: redactText(text("filePath"), env), agentId, at });
      break;
    case "sub_agent": {
      const label = [text("subAgentType"), text("description")].filter((part) => part !== "").join(" — ");
      out.push({ kind: "agent", detail: label === "" ? "sub_agent" : redactText(label, env), agentId, at });
      break;
    }
  }
  return out;
}

/** A token count a provider reported: a finite number ≥ 0, rounded; anything else is not reported. */
function tokenCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value) : undefined;
}

type CompactionTrigger = "auto" | "manual";

/**
 * Tracks the `compaction` items of one turn and turns each compaction into one
 * piece of evidence (autonomy design §G.2), from its `completed` item.
 *
 * Measured on Paseo 0.9.2 (run note 2026-09-30): every provider shows a
 * `loading` item first and a `completed` item after, and the timeline keeps
 * both — nothing merges them — so counting both would count each compaction
 * twice, and one still loading when the turn ended did not happen yet. Claude
 * puts the trigger and `preTokens` on the completed item; Codex the trigger on
 * both; OpenCode the trigger on the loading item only, so a completed item
 * without one takes its loading item's. What no item says reads `null`.
 */
export function compactionTracker(agentId: string): (item: TimelineItem, at: string) => Evidence | null {
  let started: CompactionTrigger | null = null;
  return (item, at) => {
    if (item.type !== "compaction") return null;
    const { status, trigger: said, preTokens } = item as { status?: unknown; trigger?: unknown; preTokens?: unknown };
    const known: CompactionTrigger | null = said === "auto" || said === "manual" ? said : null;
    if (status !== "completed") {
      started = known ?? started;
      return null;
    }
    const trigger = known ?? started;
    started = null;
    return { kind: "compaction", detail: trigger ?? "unknown", agentId, at, trigger, preTokens: tokenCount(preTokens) ?? null };
  };
}

/**
 * The usage of the turn that just ended, from an agent snapshot's `lastUsage`
 * (the `agent` of a `timeline.refetch` payload); null when there is none.
 *
 * Its token counts are that turn's as the provider reports them — the sum
 * over the turn's model calls on Claude, the last model call only on Codex and
 * OpenCode, and Codex's cached tokens are part of its input (run note
 * 2026-09-30 §4). Its `totalCostUsd` is the agent's running SESSION total
 * (AGENTS.md): across the twelve Manager turns of the WP-214 acceptance run it
 * rose monotonically (0.3956 → 0.4492 → … → 2.2712) while the token counts
 * beside it went up and down per turn. Summing it over a request's turns would
 * multiply the bill, so a per-turn record never claims a provider cost and the
 * request cost is estimated from the per-turn tokens instead (defect 11).
 *
 * `contextUsed` / `contextMax` (autonomy design §G.2) are kept only when the
 * provider reported `contextWindowUsedTokens` / `contextWindowMaxTokens`, so an
 * absent field means "not reported", never zero.
 */
export function usageOfSnapshot(snapshot: unknown): Usage | null {
  if (snapshot === null || typeof snapshot !== "object") return null;
  const agent = snapshot as { lastUsage?: unknown; model?: unknown };
  const lastUsage = agent.lastUsage;
  if (lastUsage === undefined || lastUsage === null || typeof lastUsage !== "object") return null;
  const reported = lastUsage as Record<string, unknown>;
  const contextUsed = tokenCount(reported["contextWindowUsedTokens"]);
  const contextMax = tokenCount(reported["contextWindowMaxTokens"]);
  return {
    inputTokens: Number(reported["inputTokens"] ?? 0) || 0,
    cachedInputTokens: Number(reported["cachedInputTokens"] ?? 0) || 0,
    outputTokens: Number(reported["outputTokens"] ?? 0) || 0,
    costUsd: null,
    costBasis: "unavailable",
    model: typeof agent.model === "string" ? agent.model : null,
    pricesUpdatedAt: null,
    ...(contextUsed === undefined ? {} : { contextUsed }),
    ...(contextMax === undefined || contextMax === 0 ? {} : { contextMax }),
  };
}

interface RefetchEntry {
  item: unknown;
  turnId?: string;
  timestamp?: string;
}

const nonEmpty = (value: unknown): string | null => (typeof value === "string" && value.trim() !== "" ? value : null);

/** `{ boundary }` from an agent's `bm.boundary` label, or nothing when it carries none. */
function boundaryOfLabels(labels: unknown): { boundary?: "on" | "off" } {
  const value = labels !== null && typeof labels === "object" ? (labels as Record<string, unknown>)[BOUNDARY_LABEL] : undefined;
  return value === "on" || value === "off" ? { boundary: value } : {};
}

/**
 * What the agent ran on this turn, from the snapshot `timeline.refetch` returns
 * (delta 20260918 §4.2). The provider's running values (`runtimeInfo`) come
 * first and the snapshot's configuration only fills in what they leave empty —
 * a provider-reported `null` never hides a real fallback. `null` when there is
 * no snapshot. Never throws: a malformed snapshot costs the fields, not the turn.
 *
 * `provider` (delta 20260921 §4.2.7, F7) is the snapshot's own `provider`,
 * reduced to the provider id the way every other paseo-bm reader does
 * (`bm-worker/<model>` → `bm-worker`), so a later price lookup can hand it to
 * `providers.listModels` as is. `null` when the snapshot names none.
 * `boundary` is its `bm.boundary` label, when it has one (autonomy design
 * §D.2, change-010 C9).
 */
export function runtimeOf(snapshot: unknown): TraceRuntime | null {
  try {
    if (snapshot === null || typeof snapshot !== "object") return null;
    const agent = snapshot as Record<string, unknown>;
    const info = (agent["runtimeInfo"] !== null && typeof agent["runtimeInfo"] === "object" ? agent["runtimeInfo"] : {}) as Record<string, unknown>;
    return {
      model: nonEmpty(info["model"]) ?? nonEmpty(agent["model"]),
      thinkingOptionId:
        nonEmpty(info["thinkingOptionId"]) ?? nonEmpty(agent["effectiveThinkingOptionId"]) ?? nonEmpty(agent["thinkingOptionId"]),
      modeId: nonEmpty(info["modeId"]) ?? nonEmpty(agent["currentModeId"]),
      provider: nonEmpty(providerId(agent["provider"])),
      // Autonomy design §D.2 (change-010 C9): whether it ran under the action boundary, for the replay's split.
      ...boundaryOfLabels(agent["labels"]),
    };
  } catch {
    return null;
  }
}

/**
 * Reads `timestamp`s back for one turn with a single `refetch` call (assumption A-2).
 *
 * `cut` says the page may have lost the start of the turn: it is full and its
 * oldest entry already belongs to this turn.
 */
export async function timestampsForTurn(
  deps: CollectorDeps,
  agentId: string,
  turnId: string | null,
): Promise<{ entries: RefetchEntry[]; usage: Usage | null; requestIdLabel: string | null; runtime: TraceRuntime | null; cut: boolean }> {
  if (deps.paseo === undefined) return { entries: [], usage: null, requestIdLabel: null, runtime: null, cut: false };
  let payload: unknown;
  try {
    payload = await deps.paseo.agents.ref(agentId).timeline.refetch({
      direction: "tail",
      limit: REFETCH_LIMIT,
    });
  } catch {
    return { entries: [], usage: null, requestIdLabel: null, runtime: null, cut: false };
  }
  const asRecord = payload as { entries?: unknown; agent?: unknown } | null;
  const rawEntries = Array.isArray(asRecord?.entries) ? (asRecord?.entries as RefetchEntry[]) : [];
  // A turn id selects the turn exactly. Without one, the entries are cut down
  // the same way the hook payload is — everything from the last user message on.
  //
  // WP-214 acceptance, defect 10: returning `rawEntries` here recorded the
  // ENTIRE conversation in one record. On the acceptance workspace that record
  // held 13 inbound messages and 10 reports, and because its first message was
  // F-1's request it folded into F-1 and multiplied that request's tokens.
  const entries =
    turnId === null
      ? sliceLastTurn(rawEntries, (entry) => entry.item)
      : rawEntries.filter((entry) => entry.turnId === turnId);
  const snapshot = asRecord?.agent as { labels?: Record<string, unknown> } | null;
  // The agent's own `bm.requestId` label, set when it was created. A Worker's
  // later turns rarely repeat the id in their text, so without this its records
  // carry no request id and are lost from the trace once the agent is deleted
  // (WP-214, D-8's delete leg: 14 of 14 F-1 Worker records had none).
  const label = snapshot?.labels?.["bm.requestId"];
  const requestIdLabel = typeof label === "string" && label !== "" ? label : null;
  const cut = turnId !== null && rawEntries.length >= REFETCH_LIMIT && rawEntries[0]?.turnId === turnId;
  return { entries, usage: usageOfSnapshot(snapshot), requestIdLabel, runtime: runtimeOf(asRecord?.agent), cut };
}

const isToolCall = (item: unknown): boolean =>
  item !== null && typeof item === "object" && (item as { type?: unknown }).type === "tool_call";

/**
 * How many tool calls the turn made (autonomy design §G.2): every `tool_call`
 * item of its entries, whatever the tool. The timeline merges a call's updates
 * into one item by its call id, so each call counts once.
 *
 * A turn longer than one refetch page (`cut`) is counted from the hook
 * payload as well — the whole conversation, cut from the last user message —
 * and the larger count is kept: the page alone would count only its tail.
 */
export function toolCallsOf(timed: readonly TimedItem[], hookItems: readonly unknown[], cut: boolean): number {
  const counted = timed.filter((entry) => isToolCall(entry.item)).length;
  return cut ? Math.max(counted, sliceLastTurn(hookItems).filter(isToolCall).length) : counted;
}

/**
 * The role a turn of this provider is recorded under, or null when it is not
 * recorded: not a paseo-bm agent, or the Orchestrator's assessment agent. An
 * assessment is not part of the request it assesses, its result has a store of
 * its own, and a 0.4.1 plugin reading the trace store must never meet a role it
 * cannot parse (orchestrator design §3.2).
 */
export function recordedRoleOf(provider: unknown): Exclude<BmRole, "orchestrator"> | null {
  const role = roleOfProvider(provider);
  return role === null || role === "orchestrator" ? null : role;
}

/** In-memory start marks, keyed by agent and turn. Lost on reload, which is fine. */
const startMarks = new Map<string, string>();

function markKey(agentId: string, turnId: string | null): string {
  return `${agentId}::${turnId ?? ""}`;
}

/** Records a turn's start time. */
export function noteTurnStart(event: TurnStartedEvent, now: () => Date = () => new Date()): void {
  // Only paseo-bm's agents are collected, fallback aliases included (delta 20260921 §4.4.1).
  if (recordedRoleOf(event.agent.provider) === null) return;
  startMarks.set(markKey(event.agent.id, event.turnId), now().toISOString());
}

/** Test helper: forget every start mark. */
export function clearStartMarks(): void {
  startMarks.clear();
}

/**
 * `Continue req-…` at the very start of a relay prompt: the only form
 * `roles/manager.md` uses to resume a Worker (delta 20260917 §5.3). Anchored so
 * a prompt that merely mentions another request is never read as resuming it.
 * Markdown around the keyword or the id (`**Continue**`, a backticked id) is
 * tolerated: models add it, and the WP-214 run lost exact links to exactly that.
 */
const RELAY_REQUEST_ID = /^\s*[*_`]*Continue[*_`]*\s+[*_`]*(req-\d{8}T\d{6}Z)\b/;

/**
 * The request a `send_agent_prompt` tool call resumes, or null. The tool name
 * may carry an MCP prefix (`mcp__paseo__send_agent_prompt`), so only the part
 * after the last `__` is compared.
 */
export function relayRequestIdOf(item: TimelineItem): string | null {
  if (item.type !== "tool_call") return null;
  const call = item as { name?: unknown; detail?: { input?: unknown } };
  if (typeof call.name !== "string" || call.name.split("__").pop() !== "send_agent_prompt") return null;
  const input = call.detail?.input;
  const prompt = input !== null && typeof input === "object" ? (input as { prompt?: unknown }).prompt : undefined;
  return typeof prompt === "string" ? (RELAY_REQUEST_ID.exec(prompt)?.[1] ?? null) : null;
}

/**
 * Builds the record for one ended turn. Pure apart from the timestamp lookup,
 * so the assembly is testable without a store or a daemon.
 */
export async function buildRecord(
  event: TurnEndedEvent,
  deps: CollectorDeps,
): Promise<{ record: TraceRecord; workspaceName: string | null } | null> {
  const role = recordedRoleOf(event.agent.provider);
  if (role === null) return null;
  if (event.agent.workspaceId === null) return null;

  const now = deps.now ?? (() => new Date());
  const endedAt = now().toISOString();
  const env = deps.env ?? process.env;

  const items = Array.isArray(event.timeline) ? event.timeline : [];
  const { entries, usage, requestIdLabel, runtime, cut } = await timestampsForTurn(deps, event.agent.id, event.turnId);

  // Preferred source: the refetch entries for this turn, which carry both the
  // item and its timestamp. Fallback: the hook payload, which is the whole
  // conversation, so it is cut down to the last user message onwards — a turn
  // starts with one, and recording the entire history on every turn would
  // duplicate it in every record.
  const timed: TimedItem[] =
    entries.length > 0
      ? entries
          .filter((entry) => entry.item !== undefined && entry.item !== null)
          .map((entry) => ({
            item: entry.item as TimelineItem,
            at: typeof entry.timestamp === "string" ? entry.timestamp : endedAt,
          }))
      : joinStreamedText(sliceLastTurn(items)).map((item) => ({ item, at: endedAt }));

  const sent: TraceMessage[] = [];
  const received: TraceMessage[] = [];
  const reports: ParsedReport[] = [];
  const reviews: ParsedReview[] = [];
  const evidence: Evidence[] = [];
  let relayRequestId: string | null = null;
  const compaction = compactionTracker(event.agent.id);
  const pluginSent = deps.pluginSent ?? pluginSentBeside(deps.location);

  for (const { item, at } of timed) {
    evidence.push(...evidenceFromItem(item, event.agent.id, at, env));
    const compacted = compaction(item, at);
    if (compacted !== null) evidence.push(compacted);
    if (role === "manager" && relayRequestId === null) relayRequestId = relayRequestIdOf(item);
    const text = textOf(item);
    if (text === null) continue;
    // `/bm-worker-new` prefixes the user's request with a flag line so the
    // Manager knows not to fold it into whatever is already running. The flag is
    // the plugin's, the words after it are the user's, so the flag comes off
    // here and the message stays theirs (delta 20260917f §4.1).
    const safe = stripNewRequestMarker(redactText(text, env));
    const message: TraceMessage = { agentId: event.agent.id, at, text: safe, truncated: false };
    // The plugin's `/compact` (autonomy design §G.5): a `user_message` with a
    // `clientMessageId` and no marker, told apart only by the plugin's send log.
    let sentByPlugin = false;
    if (item.type === "user_message") {
      // Typed in Paseo's app → `clientMessageId`; sent by an agent → none.
      // Verified on the owner's Manager: 15/15 typed vs 43/43 agent reports.
      // The plugin's own notices carry a clientMessageId too (the SDK adds one),
      // so they are recognised by their text instead (review b2), and what the
      // plugin sent for a compaction by its send log.
      const typed = typeof (item as { clientMessageId?: unknown }).clientMessageId === "string" && !isPluginNotice(safe);
      sentByPlugin = typed && pluginSent(event.agent.id, text, at);
      message.origin = typed && !sentByPlugin ? "user" : "agent";
      sent.push(message);
    } else {
      received.push(message);
    }
    // A plugin notice quotes block names ("- BM-REVIEW checked: is missing"),
    // which parsed as a review with the verdict "checked: is missing".
    if (isPluginNotice(safe) || sentByPlugin) continue;
    reports.push(...parseReports(safe, { agentId: event.agent.id, at }));
    // A review is its Reviewer's own reply: a block quoted in its prompt or
    // relayed by a Worker or Manager is the same review again (bead 7gxw.12).
    if (role === "reviewer" && item.type === "assistant_message") reviews.push(...parseReviews(safe, { agentId: event.agent.id, at }));
  }

  const requestIdFromReports = reports.find((report) => report.requestId !== null)?.requestId ?? null;
  // The same tolerant pattern the reconstruction uses: real prompts write the
  // id as "- `requestId`: `req-…`" (WP-214 acceptance finding).
  const requestIdFromPrompt = requestIdFromText(sent.map((message) => message.text).join("\n"));

  const record: TraceRecord = {
    v: TRACE_STORE_SCHEMA_VERSION,
    kind: "turn",
    at: endedAt,
    workspaceId: event.agent.workspaceId,
    agentId: event.agent.id,
    role,
    turnId: event.turnId,
    // Last resort: the Manager's own `Continue <requestId>.` relay. A user's
    // answer otherwise shows as its own request row until the next report.
    requestId: requestIdLabel ?? requestIdFromReports ?? requestIdFromPrompt ?? relayRequestId,
    parentAgentId: event.agent.parentAgentId,
    agentCreatedAt: null,
    startedAt: startMarks.get(markKey(event.agent.id, event.turnId)) ?? null,
    endedAt,
    outcome: event.outcome.kind,
    sent,
    received,
    reports,
    reviews,
    evidence,
    usage,
    runtime,
    pluginVersion: PLUGIN_VERSION,
    toolCalls: toolCallsOf(timed, items, cut),
  };

  const cwd = typeof event.agent.cwd === "string" && event.agent.cwd !== "" ? event.agent.cwd : null;
  return { record, workspaceName: cwd === null ? null : basename(cwd) };
}

/**
 * Collects one ended turn: build, append, refresh the workspace label.
 *
 * Every failure is contained here. A lock timeout is expected under load and
 * only costs one trace; anything else is logged with its message so a support
 * question has something to go on.
 */
export async function collectTurnEnded(event: TurnEndedEvent, deps: CollectorDeps): Promise<boolean> {
  return (await collectTurn(event, deps)) !== null;
}

/** `collectTurnEnded` that returns the record it wrote, or null when it wrote none. */
export async function collectTurn(event: TurnEndedEvent, deps: CollectorDeps): Promise<TraceRecord | null> {
  const log = deps.log ?? ((message: string) => console.warn(message));
  try {
    if (deps.location === null) return null;
    const built = await buildRecord(event, deps);
    if (built === null) return null;

    await appendRecord(deps.location, built.record, { timeoutMs: deps.lockTimeoutMs });
    startMarks.delete(markKey(event.agent.id, event.turnId));

    try {
      writeWorkspaceMeta(deps.location, built.record.workspaceId, {
        lastKnownName: built.workspaceName,
        lastKnownDirectory: typeof event.agent.cwd === "string" ? event.agent.cwd : null,
        lastSeenAt: built.record.at,
      });
    } catch (error) {
      // Losing the label only costs recognisability of an orphaned workspace.
      log(`[paseo-bm] could not update trace workspace metadata: ${messageOf(error)}`);
    }
    return built.record;
  } catch (error) {
    if (error instanceof TraceStoreLockTimeout) {
      log(`[paseo-bm] dropped one trace record: ${error.message}`);
      return null;
    }
    log(`[paseo-bm] could not record a trace for agent ${event.agent.id}: ${messageOf(error)}`);
    return null;
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The part of the server context this needs; `on` is absent on older hosts. */
export type CollectorHost = Partial<Pick<PluginServerContext, "on" | "before">>;

export type LocationResolver = (paseo: unknown) => Promise<TraceStoreLocation | null>;

/**
 * Resolves the trace store once and remembers it.
 *
 * `contribute()` has no `paseo`, only the hook context does, so the location
 * cannot be resolved at registration time. A successful answer is cached
 * forever (the install home does not move while the daemon runs); a failure is
 * retried on the next turn, which costs one `config.get()`.
 */
export function createLocationResolver(
  resolve: (paseo: unknown) => Promise<TraceStoreLocation | null>,
): LocationResolver {
  let cached: TraceStoreLocation | null = null;
  return async (paseo: unknown) => {
    if (cached !== null) return cached;
    cached = await resolve(paseo);
    return cached;
  };
}

/**
 * Default resolver: the data folder of design §5.1, with the real `os`.
 *
 * It takes no `paseo` any more — resolution is synchronous and handle-free from
 * 0.4.0 — and stays async and assignable to `LocationResolver`, which is how
 * every caller passes it.
 */
export async function resolveLocationFromPaseo(): Promise<TraceStoreLocation | null> {
  const resolution = resolveDataHome({ homedir });
  return resolution.home === null ? null : { tracesDir: resolution.tracesDir };
}

export interface RegisterCollectorOptions {
  /** Overridden in tests; production uses the data-folder resolver. */
  resolveLocation?: LocationResolver;
  now?: () => Date;
  env?: NodeJS.ProcessEnv;
  log?: (message: string) => void;
  lockTimeoutMs?: number;
  /**
   * Runs after a turn's record has been written, so a reader sees that turn.
   * The review budget check hangs here rather than on its own
   * `on("agent.turn_ended")`: two handlers of one event give no ordering
   * guarantee, and a count read before the append is one call short.
   * Its failures are contained like the collector's own. `record` is the
   * record just written (texts already masked), so a step that reads the turn
   * need not read the store back.
   */
  onRecorded?: (event: TurnEndedEvent, input: { location: TraceStoreLocation; paseo: unknown; record: TraceRecord }) => unknown;
  /**
   * Gets the Paseo handle of every turn start, of any agent. After a plugin
   * reload nothing else may bring one before an agent calls a tool that needs
   * it: the Orchestrator's first turn would otherwise find its tools without a
   * connection. Its failures are contained.
   */
  onStarted?: (paseo: unknown) => void;
}

/**
 * Registers both hooks and returns their remover. On a host without `on` it
 * logs one line and returns a no-op, exactly like `registerRoleHook` does for a
 * missing `before`.
 */
export function registerCollector(
  host: CollectorHost,
  options: RegisterCollectorOptions = {},
): () => void {
  const log = options.log ?? ((message: string) => console.warn(message));
  if (typeof host.on !== "function") {
    // Same convention as `registerStopPropagation`: on a host with no
    // lifecycle hooks at all, the role hook's line is the informative one, so
    // this stays quiet instead of turning one problem into three log lines.
    if (typeof host.before === "function") {
      log(
        "[paseo-bm] this Paseo host has no on(\"agent.turn_ended\") hook; the Dashboard will have no trace history.",
      );
    }
    return () => {};
  }

  const resolveLocation =
    options.resolveLocation ?? createLocationResolver(resolveLocationFromPaseo);
  let warnedDisabled = false;

  const removeStarted = host.on("agent.turn_started", (event, context) => {
    try {
      noteTurnStart(event, options.now);
    } catch {
      // A missing start mark only costs one duration.
    }
    const paseo = (context as { paseo?: unknown } | undefined)?.paseo;
    if (paseo === undefined || options.onStarted === undefined) return;
    try {
      options.onStarted(paseo);
    } catch (error) {
      log(`[paseo-bm] turn-start step failed: ${messageOf(error)}`);
    }
  });

  const removeEnded = host.on("agent.turn_ended", async (event, context) => {
    try {
      const location = await resolveLocation((context as { paseo?: unknown } | undefined)?.paseo);
      if (location === null) {
        if (!warnedDisabled) {
          warnedDisabled = true;
          log("[paseo-bm] trace store unavailable; the Dashboard will have no trace history.");
        }
        return;
      }
      const paseo = (context as { paseo?: CollectorPaseo } | undefined)?.paseo;
      const record = await collectTurn(event, {
        location,
        paseo,
        now: options.now,
        env: options.env,
        log,
        lockTimeoutMs: options.lockTimeoutMs,
      });
      if (record !== null && options.onRecorded !== undefined) {
        try {
          await options.onRecorded(event, { location, paseo, record });
        } catch (error) {
          log(`[paseo-bm] after-record step failed: ${messageOf(error)}`);
        }
      }
    } catch (error) {
      // Last line of defence: this hook runs inside a real agent turn.
      log(`[paseo-bm] trace collection failed: ${messageOf(error)}`);
    }
  });

  return () => {
    if (typeof removeStarted === "function") removeStarted();
    if (typeof removeEnded === "function") removeEnded();
  };
}
