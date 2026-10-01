/**
 * The action boundary (autonomy design §D.2, ADR-019; change-009 C4–C8): every
 * permission request of a paseo-bm Worker or Reviewer on Claude or Codex is
 * answered at once — allowed, or held as the owner's decision.
 *
 * - **Which requests.** `agent.permission_requested` for an agent on a
 *   `bm-worker*` or `bm-reviewer*` alias (fallback aliases included) whose
 *   base provider is Claude or Codex (or not known), `kind: tool`, **that
 *   runs under the boundary** (change-010 C5): labelled `bm.boundary=on`, or,
 *   until the label is written, whose Runtime facts say `Action boundary: on`.
 *   Such an agent is still answered after its project's switch is turned off.
 *   The Manager's, the Orchestrator's, a Worker or Reviewer created with the
 *   boundary off, other agents' and other kinds are left to Paseo's own
 *   prompt (the watch's `permission-waiting` alert keeps them).
 * - **Reading a request** (`readingOf`, §D.2's table): Claude `Bash` and Codex
 *   `CodexBash` by their command; the file tools by their path; Codex
 *   `CodexFileChange` by the path of the pending timeline `tool_call` whose
 *   `callId` is its `metadata.itemId`; `WebFetch` / `WebSearch` are network;
 *   Paseo's agent tools and paseo-bm's own are allowed by name, except a
 *   `create_agent` for a provider that is not a Reviewer's (`security`) —
 *   Codex asks for them as `CodexMcpElicitation`, read by its
 *   `metadata.serverName` and the tool its `description` names, with no
 *   arguments, so a Codex `create_agent` is always held (`codexMcpToolOf`); the
 *   tools of `ALLOWED_BY_NAME` are allowed; anything else is unreadable. The
 *   classes are `shared/effectful-actions.ts`'s.
 * - **Allow or hold.** No held effect: allowed at once. Each held effect
 *   covered by a live grant of the request — the owner's answered `q:` or
 *   `o:` — allowed, each grant spent (`useGrant`). The rest covered by a
 *   `delegate` cell of the class its effects imply (any class, security
 *   included at Full auto; ADR-025): allowed, and stored as an `h:` decision
 *   answered at open `by: policy`. Otherwise held: the decision
 *   `h:<agentId>:<requestId>` opens (`heldDecisionOf`), the request is left
 *   pending, no event goes to the Orchestrator. An unreadable request is never
 *   covered, and a grant never covers a `security` finding: only the owner's
 *   answer or the project's level allows them.
 * - **Answering.** Only ever a plain `{ behavior: "allow" }` (allow once) or
 *   `{ behavior: "deny", message }` — never Claude's `suggestions` or
 *   `updatedPermissions`, never OpenCode's `allow_always`. The owner's answer
 *   is delivered by `onSettled` (the `held` part of `settledByKind`) exactly
 *   once: the delivery is recorded before the answer is sent, so a second
 *   answer, a re-delivery after a reload or a request already resolved never
 *   answers again.
 * - **Answered elsewhere** (`agent.permission_resolved`): an allow in Paseo's
 *   prompt or `paseo permit` records the owner's answer `via: paseo`, its
 *   grant spent at once; a deny, or an interrupted turn, withdraws it.
 * - **Restart** (`usePaseo`, `scan`): events are not replayed. At the first
 *   Paseo handle of a run, and at every Worker pass of the watch, the pending
 *   requests of Workers and Reviewers under the boundary are read from `agents.list()` and
 *   classified as if just raised (opening is idempotent by id); a replaced
 *   agent's open `h:` decisions are withdrawn and its requests denied; an open
 *   `h:` decision whose request is no longer pending is withdrawn.
 *
 * Never throws into Paseo: a failure is one log line, and a request the
 * plugin could not answer waits in Paseo's own prompt for the owner.
 */
import { readFileSync as nodeReadFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { modeOf } from "../shared/autonomy";
import {
  CLASS_OF_EFFECT,
  MAX_DECISION_TEXT_CHARS,
  UNSETTLED_STATUSES,
  answerDecision,
  decisionKindOf,
  grantRefusal,
  heldDecisionId,
  useGrant,
  withdrawDecision,
  type Decision,
  type DecisionClass,
  type DecisionDelivery,
  type Effect,
  type TransitionResult,
} from "../shared/decisions";
import {
  boundaryVerdictOfCommand,
  boundaryVerdictOfWrite,
  declaredEffectsOf,
  heldClassOf,
  networkVerdict,
  securityVerdict,
  unreadableVerdict,
  type BoundaryContext,
  type BoundaryVerdict,
  type HeldFinding,
} from "../shared/effectful-actions";
import { listAllAgents, roleOfProvider } from "./agent-role";
import { actionBoundaryOfPrompt } from "./role-instructions";
import { BOUNDARY_LABEL, BOUNDARY_PROVIDERS } from "./role-mode";
import { aliasBases } from "./alias-bases";
import { currentPolicy } from "./autonomy-store";
import { redactText } from "./collector";
import { createDecisionStore, type DecisionStore } from "./decision-store";
import type { OnDecisionsSettled } from "./decision-rpc";
import { providerId } from "./provider-id";
import { dataHome, errorText } from "./rpc-kit";

/** The base providers the spike passed (ADR-019 decision record): their Workers and Reviewers run under the boundary. */
export const BOUNDARY_BASE_PROVIDERS: ReadonlySet<string> = new Set(BOUNDARY_PROVIDERS);

/**
 * Whether an agent runs under the boundary (change-010 C5): its `bm.boundary`
 * label, else — before the label is written — the `Action boundary` line of
 * its Runtime facts; null when the snapshot shows neither.
 */
export function boundaryStateOf(snapshot: BoundaryAgentSnapshot | null): "on" | "off" | null {
  const label = snapshot?.labels?.[BOUNDARY_LABEL];
  if (label === "on" || label === "off") return label;
  const metadata = record(record(snapshot?.persistence)["metadata"]);
  return actionBoundaryOfPrompt(metadata["systemPrompt"]);
}

/**
 * Claude tools allowed by name (§D.2, change-009 C4): they read, plan or
 * start a sub-agent whose own calls raise their own requests. Not measured
 * live yet (bead `loga.6` checks the names an ordinary Worker raises).
 */
export const ALLOWED_BY_NAME: ReadonlySet<string> = new Set([
  "Read",
  "Glob",
  "Grep",
  "LS",
  "NotebookRead",
  "TodoWrite",
  "TodoRead",
  "Task",
  "Agent",
  "Skill",
  "ToolSearch",
  "BashOutput",
  "TaskOutput",
  "KillShell",
  "KillBash",
]);

/** The MCP servers whose tools are allowed by name: Paseo's agent tools and paseo-bm's own (ADR-010). */
export const ALLOWED_MCP_SERVERS: ReadonlySet<string> = new Set(["paseo", "paseo-bm"]);

/** What a deny tells the agent. */
export const DENIED_MESSAGE = "The owner denied this request. Do not try it another way; ask the owner if it is still needed.";
export const REPLACED_MESSAGE = "You were replaced by another agent for this request. Stop: do not run anything else.";

/** The longest command or path quoted in a held decision's question. */
export const HELD_QUOTE_CHARS = 400;
/** How many timeline entries a Codex file change's lookup reads (spike §4: found 5 of 5 in the newest 30). */
export const CODEX_FILE_CHANGE_TAIL = 30;
/** How long the alias bases are kept before they are read again for an alias not among them. */
const BASES_TTL_MS = 60_000;
/** How many answered requests are remembered, so a scan and an event never answer the same one twice. */
const ANSWERED_MEMORY = 2000;

const PARENT_AGENT_LABEL = "paseo.parent-agent-id";
const REQUEST_ID_LABEL = "bm.requestId";
const REPLACED_BY_LABEL = "bm.replacedBy";

// ---------------------------------------------------------------------------
// The Paseo slice (`@getpaseo/client` `PaseoApi` is structurally assignable).
// ---------------------------------------------------------------------------

/** The permission request as Paseo sends it (`AgentPermissionRequest`), read defensively. */
export interface BoundaryRequest {
  id: string;
  name: string;
  kind: string;
  provider?: unknown;
  title?: unknown;
  description?: unknown;
  input?: unknown;
  detail?: unknown;
  metadata?: unknown;
}

/** The agent of a hook event (`PluginHookAgent`). */
export interface BoundaryAgent {
  id: string;
  workspaceId: string | null;
  parentAgentId?: string | null;
  provider: string;
  cwd: string;
}

/** What the boundary reads of an agent snapshot. */
export interface BoundaryAgentSnapshot {
  id: string;
  provider?: unknown;
  cwd?: unknown;
  workspaceId?: unknown;
  labels?: Record<string, string>;
  archivedAt?: unknown;
  pendingPermissions?: unknown;
  /** Where the snapshot carries the agent's system prompt (`persistence.metadata.systemPrompt`). */
  persistence?: unknown;
}

/** A plain answer: allow once, or deny. Nothing else is ever sent. */
export type PermissionAnswer = { behavior: "allow" } | { behavior: "deny"; message: string };

interface BoundaryHandle {
  refresh(): Promise<{ agent: BoundaryAgentSnapshot } | null>;
  respondToPermission(options: { requestId: string; response: PermissionAnswer }): Promise<void>;
  timeline?: { refetch(options: { direction: "tail"; limit: number }): Promise<{ entries?: unknown[] } | null> };
}

export interface BoundaryPaseo {
  agents: {
    list(options: { filter: { includeArchived: boolean }; page: { limit: number; cursor?: string } }): Promise<{
      entries: Array<{ agent: BoundaryAgentSnapshot }>;
      pageInfo?: { nextCursor: string | null; hasMore: boolean };
    }>;
    ref(agentId: string): BoundaryHandle;
  };
}

function isBoundaryPaseo(value: unknown): value is BoundaryPaseo {
  const candidate = value as { agents?: { list?: unknown; ref?: unknown } } | null | undefined;
  return typeof candidate?.agents?.list === "function" && typeof candidate?.agents?.ref === "function";
}

const text = (value: unknown): string | null => (typeof value === "string" && value.trim() !== "" ? value : null);
const record = (value: unknown): Record<string, unknown> => (value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {});

// ---------------------------------------------------------------------------
// Reading a request (pure but for the Codex timeline lookup).
// ---------------------------------------------------------------------------

/** How a request was read: its verdict, and what the owner's question quotes. */
export interface RequestReading {
  verdict: BoundaryVerdict;
  /** `run`, `write`, `fetch`, `use`: the verb of the question. */
  verb: string;
  /** The command, path, URL or tool name, as the request gave it (masked before it is shown). */
  quote: string;
}

/** The MCP server and tool of a tool name (`mcp__paseo__list_agents`, `paseo-bm.bm_review`), or null. */
export function mcpToolOf(name: string): { server: string; tool: string } | null {
  const claude = /^mcp__(.+?)__(.+)$/.exec(name);
  if (claude !== null) return { server: claude[1]!, tool: claude[2]! };
  const dotted = /^([\w-]+)\.([\w-]+)$/.exec(name);
  return dotted !== null && ALLOWED_MCP_SERVERS.has(dotted[1]!) ? { server: dotted[1]!, tool: dotted[2]! } : null;
}

/**
 * The command a Codex shell request runs, from its `input.command` — the
 * `/bin/zsh -lc '…'` it will run, as a string or an argument list — rather
 * than `detail.command`, Paseo's unwrapped copy, which keeps the `'"'"'`
 * quoting of the wrapper and so often does not read as shell (field replay,
 * change-009 C9). The shell's `-c` body is read by the classifier. Null when
 * there is none.
 */
export function codexCommandOf(command: unknown): string | null {
  if (typeof command === "string") return text(command);
  if (!Array.isArray(command) || !command.every((part) => typeof part === "string") || command.length === 0) return null;
  const parts = command as string[];
  const flag = parts.findIndex((part) => /^-[a-z]*c[a-z]*$/.test(part));
  if (flag >= 1 && flag === parts.length - 2 && /(?:^|\/)(?:ba|z|da|k)?sh$/.test(parts[0]!)) return text(parts[flag + 1]);
  // Any other argument list: each argument quoted as one word.
  return parts.map((part) => (/^[\w@%+=:,./-]+$/.test(part) ? part : `'${part.replace(/'/g, `'"'"'`)}'`)).join(" ");
}

/** The path of a Codex file change: the pending timeline `tool_call` whose `callId` is `itemId` (spike §4), or null. */
export async function codexFileChangePath(paseo: BoundaryPaseo, agentId: string, itemId: string | null): Promise<string | null> {
  if (itemId === null) return null;
  try {
    const page = await paseo.agents.ref(agentId).timeline?.refetch({ direction: "tail", limit: CODEX_FILE_CHANGE_TAIL });
    for (const entry of [...(page?.entries ?? [])].reverse()) {
      const item = record(record(entry)["item"]);
      if (item["type"] === "tool_call" && item["callId"] === itemId) return text(record(item["detail"])["filePath"]);
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * The MCP server and tool of a Codex `CodexMcpElicitation` (live check
 * 2026-10-01 §5, F2), or null: the server is `metadata.serverName`, the tool
 * the one quoted in `description` (`… run tool "<tool>"?`, Codex's own
 * approval text). The request carries no arguments. A description that names
 * no tool, or more than one, reads as none.
 */
export function codexMcpToolOf(request: Pick<BoundaryRequest, "description" | "metadata">): { server: string; tool: string } | null {
  const server = text(record(request.metadata)["serverName"]);
  const description = text(request.description);
  if (server === null || description === null) return null;
  const named = [...description.matchAll(/\brun tool "([\w.-]+)"/g)];
  return named.length === 1 ? { server, tool: named[0]![1]! } : null;
}

/**
 * What a request would do (§D.2's table), judged from `agent.cwd` as the
 * workspace folder. Never throws.
 */
export async function readingOf(request: BoundaryRequest, agent: Pick<BoundaryAgent, "id" | "cwd">, paseo: BoundaryPaseo, context: Omit<BoundaryContext, "cwd" | "workspaceDirectory">): Promise<RequestReading> {
  const detail = record(request.detail);
  const input = record(request.input);
  const workspaceDirectory = text(agent.cwd);
  const judged = (cwd: string | null): BoundaryContext => ({ ...context, cwd: cwd ?? workspaceDirectory, workspaceDirectory });
  const name = request.name;
  switch (name) {
    case "Bash":
    case "CodexBash": {
      const command = name === "CodexBash" ? (codexCommandOf(input["command"]) ?? text(detail["command"])) : (text(detail["command"]) ?? text(input["command"]));
      if (command === null) return { verdict: unreadableVerdict(`${name} without its command`), verb: "run", quote: name };
      const cwd = name === "CodexBash" ? text(detail["cwd"]) : null;
      // The owner reads Paseo's own copy of a Codex command (the one its prompt shows); the classifier reads Codex's.
      return { verdict: boundaryVerdictOfCommand(command, judged(cwd)), verb: "run", quote: name === "CodexBash" ? (text(detail["command"]) ?? command) : command };
    }
    case "Edit":
    case "Write":
    case "MultiEdit":
    case "NotebookEdit": {
      const path = text(detail["filePath"]) ?? text(input["file_path"]) ?? text(input["notebook_path"]);
      if (path === null) return { verdict: unreadableVerdict(`${name} without its path`), verb: "write", quote: name };
      return { verdict: boundaryVerdictOfWrite(path, judged(null)), verb: "write", quote: path };
    }
    case "CodexFileChange": {
      const path = await codexFileChangePath(paseo, agent.id, text(record(request.metadata)["itemId"]));
      if (path === null) return { verdict: unreadableVerdict("a Codex file change whose path is not in its timeline"), verb: "change", quote: "a file" };
      return { verdict: boundaryVerdictOfWrite(path, judged(null)), verb: "write", quote: path };
    }
    case "WebFetch": {
      const url = text(detail["url"]) ?? text(input["url"]) ?? "a web page";
      return { verdict: networkVerdict(`fetch ${url}`), verb: "fetch", quote: url };
    }
    case "WebSearch":
      return { verdict: networkVerdict("web search"), verb: "search the web for", quote: text(input["query"]) ?? "something" };
    case "CodexMcpElicitation": {
      // Paseo's and paseo-bm's tools, as Claude's `mcp__paseo__*` are; without the arguments a `create_agent` cannot be read.
      const called = codexMcpToolOf(request);
      if (called === null || !ALLOWED_MCP_SERVERS.has(called.server)) {
        const what = called === null ? "a Codex MCP request that names no single tool" : `the MCP tool ${called.tool} of another server (${called.server})`;
        return { verdict: unreadableVerdict(what), verb: "use", quote: called === null ? name : `${called.server}.${called.tool}` };
      }
      const quote = `${called.server}.${called.tool}`;
      if (called.server === "paseo" && called.tool === "create_agent") {
        return { verdict: securityVerdict("create_agent whose provider a Codex MCP request does not show (an agent outside the boundary)"), verb: "use", quote };
      }
      return { verdict: { findings: [], scratchWrites: 0 }, verb: "use", quote };
    }
    default:
      break;
  }
  if (ALLOWED_BY_NAME.has(name)) return { verdict: { findings: [], scratchWrites: 0 }, verb: "use", quote: name };
  const mcp = mcpToolOf(name);
  if (mcp !== null && ALLOWED_MCP_SERVERS.has(mcp.server)) {
    if (mcp.server === "paseo" && mcp.tool === "create_agent") {
      const provider = text(input["provider"]) ?? text(record(input["config"])["provider"]);
      if (roleOfProvider(provider) === "reviewer") return { verdict: { findings: [], scratchWrites: 0 }, verb: "use", quote: name };
      return { verdict: securityVerdict(`create_agent for ${provider ?? "an unnamed provider"} (an agent outside the boundary)`), verb: "create an agent on", quote: provider ?? "an unnamed provider" };
    }
    return { verdict: { findings: [], scratchWrites: 0 }, verb: "use", quote: name };
  }
  const what = mcp !== null ? `the MCP tool ${name} of another server` : `the tool ${name}, which paseo-bm does not read`;
  return { verdict: unreadableVerdict(what), verb: "use", quote: name };
}

// ---------------------------------------------------------------------------
// The held decision (pure).
// ---------------------------------------------------------------------------

const ROLE_WORDS = { worker: "The Worker", reviewer: "The Reviewer" } as const;

/** The question of a held request: who asks, what it would do (masked), and why it was held. */
export function heldQuestionOf(role: "worker" | "reviewer", reading: Pick<RequestReading, "verb" | "quote">, findings: readonly HeldFinding[], env: NodeJS.ProcessEnv): string {
  const quote = redactText(reading.quote, env).replace(/\s+/g, " ").trim();
  const shown = [...quote].length > HELD_QUOTE_CHARS ? `${[...quote].slice(0, HELD_QUOTE_CHARS - 1).join("")}…` : quote;
  const why = findings.map((finding) => (finding.unreadable ? `cannot be read: ${redactText(finding.what, env)}` : redactText(finding.what, env))).join("; ");
  const question = `${ROLE_WORDS[role]} asks to ${reading.verb} \`${shown}\`. Held: ${why}. Allow it once?`;
  return [...question].length > MAX_DECISION_TEXT_CHARS ? `${[...question].slice(0, MAX_DECISION_TEXT_CHARS - 1).join("")}…` : question;
}

/** The open decision of a held request (§D.2, change-009 C6): Allow (the held effects, once) or Deny; none recommended. */
export function heldDecisionOf(input: {
  agentId: string;
  permissionId: string;
  workspaceId: string;
  requestId: string | null;
  question: string;
  findings: readonly HeldFinding[];
  at: string;
}): Decision {
  const declared = declaredEffectsOf(input.findings);
  const decisionClass = heldClassOf(input.findings);
  return {
    id: heldDecisionId(input.agentId, input.permissionId),
    workspaceId: input.workspaceId,
    requestId: input.requestId,
    askedBy: { role: "plugin", agentId: input.agentId },
    askedAt: input.at,
    round: null,
    question: input.question,
    subject: `held-${decisionClass}`,
    class: decisionClass,
    options: [
      { key: "allow", label: "Allow once", recommended: false, effects: declared, action: { kind: "permission", agentId: input.agentId, requestId: input.permissionId, allow: true } },
      { key: "deny", label: "Deny", recommended: false, effects: ["none"], action: { kind: "permission", agentId: input.agentId, requestId: input.permissionId, allow: false } },
    ],
    status: "open",
    settledAt: null,
    needsConfirmation: null,
    answer: null,
    grant: null,
    delivery: null,
    supersedes: null,
    supersededBy: null,
    // No option is recommended (§D.4) and nothing predicts it (change-009 C6): the ledger leaves it out.
    prediction: { recommended: null, orchestrator: null },
  };
}

/**
 * The live grants of the request that cover each finding (§D.4): the owner's
 * answered `q:` or `o:` decisions whose grant is unused, within its hour and
 * holds one of the finding's effects. An unreadable or `security` finding is
 * never covered. Null when a finding has no such grant; else the grants to
 * spend and on which effects.
 */
export function grantCoverOf(findings: readonly HeldFinding[], decisions: readonly Decision[], at: string): Map<string, { decision: Decision; effects: Effect[] }> | null {
  const live = decisions.filter((decision) => {
    const kind = decisionKindOf(decision.id);
    return (kind === "question" || kind === "orchestrator") && decision.status === "answered" && decision.answer?.by === "owner" && grantRefusal(decision, [], at) === null;
  });
  const chosen = new Map<string, { decision: Decision; effects: Effect[] }>();
  for (const finding of findings) {
    if (finding.unreadable || finding.effects.includes("security")) return null;
    // A grant already chosen first, so one answer covers what it can.
    const candidates = [...[...chosen.values()].map((entry) => entry.decision), ...live];
    const grant = candidates.find((decision) => finding.effects.some((effect) => decision.grant!.effects.includes(effect)));
    if (grant === undefined) return null;
    const effect = finding.effects.find((entry) => grant.grant!.effects.includes(entry))!;
    const entry = chosen.get(grant.id) ?? { decision: grant, effects: [] };
    if (!entry.effects.includes(effect)) entry.effects.push(effect);
    chosen.set(grant.id, entry);
  }
  return chosen;
}

/**
 * The classes the owner's policy covers for these findings (§D.4): each is
 * of a class whose cell is `delegate` in the project — any class, release,
 * data, security and cost included (ADR-025). Null when one is not (an
 * unreadable request, an effect of no class, an `owner` or `shadow` cell).
 */
export function policyCoverOf(findings: readonly HeldFinding[], cellOf: (decisionClass: DecisionClass) => "owner" | "shadow" | "delegate"): DecisionClass[] | null {
  const classes = new Set<DecisionClass>();
  for (const finding of findings) {
    if (finding.unreadable) return null;
    const decisionClass = CLASS_OF_EFFECT[finding.effects[0]!];
    if (decisionClass === null || cellOf(decisionClass) !== "delegate") return null;
    classes.add(decisionClass);
  }
  return [...classes];
}

// ---------------------------------------------------------------------------
// Package scripts, read from the nearest `package.json`.
// ---------------------------------------------------------------------------

/**
 * The body of package script `name` from the `package.json` nearest `cwd`
 * (upwards, as npm finds it): the text; null when there is no such script or
 * no `package.json` at all (nothing of it runs); undefined when the file
 * cannot be read or parsed.
 */
export function packageScriptBody(name: string, cwd: string | null, readFile: (path: string) => string = (path) => nodeReadFileSync(path, "utf8")): string | null | undefined {
  if (cwd === null) return undefined;
  let directory = cwd;
  for (let hops = 0; hops < 32; hops += 1) {
    const file = join(directory, "package.json");
    let body: string | null = null;
    try {
      body = readFile(file);
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") return undefined;
    }
    if (body !== null) {
      try {
        const scripts = record(record(JSON.parse(body))["scripts"]);
        const script = scripts[name];
        return typeof script === "string" ? script : null;
      } catch {
        return undefined;
      }
    }
    const parent = dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// The boundary.
// ---------------------------------------------------------------------------

export type RequestOutcome =
  /** Not ours: another role or agent, another kind, a provider on detection, an agent not under the boundary, or a request being answered already. */
  | "ignored"
  /** No held effect: allowed at once. */
  | "allowed"
  /** Held effects covered by live grants of the request, now spent. */
  | "allowed-grant"
  /** Held effects covered by the owner's policy: an `h:` decision answered `by: policy`. */
  | "allowed-policy"
  /** Held: an open `h:` decision, the request left pending. */
  | "held"
  /** The agent was replaced: denied. */
  | "denied-replaced"
  /** Held effects, but no data folder or project to hold them in: left to Paseo's own prompt. */
  | "left";

export interface ActionBoundaryDeps {
  /** The data folder; looked up otherwise. */
  home?: () => string | null;
  now?: () => Date;
  log?: (message: string) => void;
  /** Masks secrets in a question; the process's own environment by default. Also gives `TMPDIR`. */
  env?: NodeJS.ProcessEnv;
  /** `~`; the process's home folder by default. */
  homeDirectory?: string | null;
  /** Reads a `package.json`; `fs.readFileSync` by default. */
  readFile?: (path: string) => string;
  /** The alias bases (`bm-worker` → `claude`); read with `config.get()` by default. */
  aliasBases?: (paseo: unknown) => Promise<Record<string, string>>;
}

export interface ScanResult {
  status: "done" | "no-paseo" | "no-data-folder" | "failed";
  /** Requests answered or held by this scan, as `<agentId>|<requestId>` with their outcome. */
  requests: Array<{ key: string; outcome: RequestOutcome }>;
  /** `h:` decisions withdrawn. */
  withdrawn: string[];
  /** Requests of a replaced agent denied. */
  denied: string[];
}

export interface ActionBoundary {
  /** Registers the two permission hooks; returns their removal. */
  register(server: { on?: (name: never, handler: never) => () => void }): () => void;
  /** One `agent.permission_requested`. Never rejects. */
  onRequested(event: { agent: BoundaryAgent; request: BoundaryRequest }, paseo: unknown): Promise<RequestOutcome>;
  /** One `agent.permission_resolved`: what became of its `h:` decision. Never rejects. */
  onResolved(event: { agent: BoundaryAgent; requestId: string; resolution: { behavior?: unknown } }, paseo: unknown): Promise<"answered" | "withdrawn" | "none">;
  /** The `held` part of `settledByKind`: the owner's answer to the request, once. */
  onSettled: OnDecisionsSettled;
  /** A Paseo handle a hook or RPC brought: the first one of the run starts the restart scan. */
  usePaseo(paseo: unknown): void;
  /** The scan (§D.2 Restart). Never rejects. */
  scan(paseo: unknown): Promise<ScanResult>;
}

type SettledStore = { store: DecisionStore };

export function createActionBoundary(deps: ActionBoundaryDeps = {}): ActionBoundary {
  const log = deps.log ?? ((message: string) => console.warn(message));
  const now = deps.now ?? (() => new Date());
  const env = deps.env ?? process.env;
  const homeOf = (): string | null => (deps.home === undefined ? dataHome() : deps.home());
  const readFile = deps.readFile ?? ((path: string) => nodeReadFileSync(path, "utf8"));
  const homeDirectory = deps.homeDirectory === undefined ? safeHomedir() : deps.homeDirectory;
  const scratchRoots = text(env["TMPDIR"]) === null ? [] : [env["TMPDIR"]!.replace(/\/+$/, "")];
  const context: Omit<BoundaryContext, "cwd" | "workspaceDirectory"> = {
    scratchRoots,
    homeDirectory,
    scriptBodyOf: (name, cwd) => packageScriptBody(name, cwd, readFile),
  };

  let bases: { at: number; value: Record<string, string> } | null = null;
  const baseOf = async (paseo: unknown, alias: string | null): Promise<string | null> => {
    if (alias === null) return null;
    const fresh = bases !== null && (alias in bases.value || now().getTime() - bases.at < BASES_TTL_MS);
    if (!fresh) bases = { at: now().getTime(), value: await (deps.aliasBases ?? aliasBases)(paseo) };
    return bases!.value[alias] ?? null;
  };

  /** Requests being answered now, and the ones answered this run: a scan and an event never answer one twice. */
  const inFlight = new Set<string>();
  const answered = new Set<string>();
  const remember = (key: string) => {
    answered.add(key);
    if (answered.size > ANSWERED_MEMORY) answered.delete(answered.values().next().value!);
  };

  const respond = async (paseo: BoundaryPaseo, agentId: string, requestId: string, response: PermissionAnswer): Promise<void> => {
    await paseo.agents.ref(agentId).respondToPermission({ requestId, response });
  };

  const snapshotOf = async (paseo: BoundaryPaseo, agentId: string): Promise<BoundaryAgentSnapshot | null> => {
    try {
      return (await paseo.agents.ref(agentId).refresh())?.agent ?? null;
    } catch {
      return null;
    }
  };

  /** The paseo-bm request an agent works for: its `bm.requestId`, else (a Reviewer) its creator's. */
  const requestOfAgent = async (paseo: BoundaryPaseo, agent: BoundaryAgent, snapshot: BoundaryAgentSnapshot | null): Promise<string | null> => {
    const own = text(snapshot?.labels?.[REQUEST_ID_LABEL]);
    if (own !== null) return own;
    const parentId = text(agent.parentAgentId ?? null) ?? text(snapshot?.labels?.[PARENT_AGENT_LABEL]);
    if (parentId === null) return null;
    return text((await snapshotOf(paseo, parentId))?.labels?.[REQUEST_ID_LABEL]);
  };

  async function decide(event: { agent: BoundaryAgent; request: BoundaryRequest }, paseo: BoundaryPaseo, known: BoundaryAgentSnapshot | null): Promise<RequestOutcome> {
    const { agent, request } = event;
    const key = `${agent.id}|${request.id}`;
    const reading = await readingOf(request, agent, paseo, context);
    const findings = reading.verdict.findings;
    if (findings.length === 0) {
      await respond(paseo, agent.id, request.id, { behavior: "allow" });
      remember(key);
      return "allowed";
    }
    const home = homeOf();
    const snapshot = known ?? (await snapshotOf(paseo, agent.id));
    if (snapshot?.labels?.[REPLACED_BY_LABEL] !== undefined) {
      await respond(paseo, agent.id, request.id, { behavior: "deny", message: REPLACED_MESSAGE });
      remember(key);
      return "denied-replaced";
    }
    const workspaceId = text(agent.workspaceId) ?? text(snapshot?.workspaceId);
    if (home === null || workspaceId === null) {
      log(`[paseo-bm] held a permission request of ${agent.id} (${findings.map((finding) => finding.what).join("; ")}), but there is ${home === null ? "no data folder" : "no project"} to hold it in: it waits in Paseo's own prompt.`);
      return "left";
    }
    const store = createDecisionStore(home, { log });
    const requestId = await requestOfAgent(paseo, agent, snapshot);
    const at = now().toISOString();
    const id = heldDecisionId(agent.id, request.id);
    const existing = store.get(id, workspaceId);
    if (existing !== null) return "held";

    // A live grant of the request (§D.4): allowed, each grant spent.
    const requestDecisions = requestId === null ? [] : store.list({ workspaceId, requestId, statuses: ["answered"] });
    const grants = grantCoverOf(findings, requestDecisions, at);
    if (grants !== null && spendGrants(store, grants, at)) {
      await respond(paseo, agent.id, request.id, { behavior: "allow" });
      remember(key);
      return "allowed-grant";
    }

    const role = roleOfProvider(agent.provider) === "reviewer" ? "reviewer" : "worker";
    const decision = heldDecisionOf({
      agentId: agent.id,
      permissionId: request.id,
      workspaceId,
      requestId,
      question: heldQuestionOf(role, reading, findings, env),
      findings,
      at,
    });

    // A `delegate` cell (§D.4): allowed, and the `h:` decision stored answered by the policy.
    const policy = currentPolicy(home, (reason) => log(`[paseo-bm] could not read the autonomy policy; held requests stay the owner's: ${reason}`));
    const covered = policyCoverOf(findings, (decisionClass) => modeOf(policy, workspaceId, decisionClass));
    if (covered !== null) {
      const decisionClass = decision.class!;
      store.open(decision);
      const mutation = store.transition(
        decision.id,
        (current): TransitionResult => {
          const result = answerDecision(current, {
            by: "policy",
            via: "inbox",
            optionKey: "allow",
            at,
            class: decisionClass,
            reason: `The request was allowed by your policy: ${covered.join(" and ")} ${covered.length === 1 ? "is" : "are"} delegated in this project`,
          });
          return result.ok && result.decision.grant !== null ? useGrant(result.decision, { effects: result.decision.grant.effects, at }) : result;
        },
        workspaceId,
      );
      if (mutation.status === "updated") {
        await respond(paseo, agent.id, request.id, { behavior: "allow" });
        remember(key);
        return "allowed-policy";
      }
      log(`[paseo-bm] the policy could not allow ${decision.id}: ${mutation.status === "refused" ? mutation.message : "not found"}; it is held for the owner.`);
      return "held";
    }

    store.open(decision);
    return "held";
  }

  function spendGrants(store: DecisionStore, grants: Map<string, { decision: Decision; effects: Effect[] }>, at: string): boolean {
    for (const { decision, effects } of grants.values()) {
      const mutation = store.transition(decision.id, (current) => useGrant(current, { effects, at }), decision.workspaceId);
      if (mutation.status !== "updated") {
        log(`[paseo-bm] the grant of ${decision.id} could not be spent: ${mutation.status === "refused" ? mutation.message : "not found"}; the request is held.`);
        return false;
      }
    }
    return true;
  }

  async function onRequested(event: { agent: BoundaryAgent; request: BoundaryRequest }, paseoValue: unknown, known: BoundaryAgentSnapshot | null = null): Promise<RequestOutcome> {
    const { agent, request } = event;
    try {
      const role = roleOfProvider(agent?.provider);
      if (role !== "worker" && role !== "reviewer") return "ignored";
      if (request?.kind !== "tool" || typeof request.id !== "string" || typeof request.name !== "string") return "ignored";
      if (!isBoundaryPaseo(paseoValue)) return "ignored";
      const base = await baseOf(paseoValue, providerId(agent.provider));
      if (base !== null && !BOUNDARY_BASE_PROVIDERS.has(base)) return "ignored";
      const key = `${agent.id}|${request.id}`;
      if (inFlight.has(key) || answered.has(key)) return "ignored";
      inFlight.add(key);
      try {
        // Only an agent under the boundary (change-010 C5); a listed snapshot without the label or the prompt is read again.
        const snapshot = boundaryStateOf(known) !== null ? known : ((await snapshotOf(paseoValue, agent.id)) ?? known);
        if (boundaryStateOf(snapshot) !== "on") return "ignored";
        return await decide(event, paseoValue, snapshot);
      } finally {
        inFlight.delete(key);
      }
    } catch (error) {
      log(`[paseo-bm] the action boundary could not answer request ${String(request?.id)} of ${String(agent?.id)}: ${errorText(error)}; it waits in Paseo's own prompt.`);
      return "left";
    }
  }

  async function onResolved(event: { agent: BoundaryAgent; requestId: string; resolution: { behavior?: unknown } }): Promise<"answered" | "withdrawn" | "none"> {
    try {
      const role = roleOfProvider(event.agent?.provider);
      if ((role !== "worker" && role !== "reviewer") || typeof event.requestId !== "string") return "none";
      const home = homeOf();
      if (home === null) return "none";
      const store = createDecisionStore(home, { log });
      const id = heldDecisionId(event.agent.id, event.requestId);
      const decision = store.get(id);
      if (decision === null || (decision.status !== "open" && decision.status !== "needs-confirmation")) return "none";
      const at = now().toISOString();
      if (event.resolution?.behavior === "allow") {
        // The owner allowed it in Paseo's prompt or with `paseo permit` (no paseo-bm role can): theirs, spent at once.
        const mutation = store.transition(
          id,
          (current) => {
            const result = answerDecision(current, { by: "owner", via: "paseo", optionKey: "allow", at });
            return result.ok && result.decision.grant !== null ? useGrant(result.decision, { effects: result.decision.grant.effects, at }) : result;
          },
          decision.workspaceId,
        );
        return mutation.status === "updated" ? "answered" : "none";
      }
      const mutation = store.transition(id, (current) => withdrawDecision(current, { at }), decision.workspaceId);
      return mutation.status === "updated" ? "withdrawn" : "none";
    } catch (error) {
      log(`[paseo-bm] could not record how request ${String(event?.requestId)} was resolved: ${errorText(error)}`);
      return "none";
    }
  }

  const delivering = new Set<string>();

  /** Records a delivery; with `onlyIfNone`, only on a decision that has none yet. False when it was not written. */
  const recordDelivery = (settled: SettledStore, decision: Decision, delivery: DecisionDelivery, onlyIfNone: boolean): boolean => {
    try {
      const mutation = settled.store.transition(
        decision.id,
        (current) =>
          onlyIfNone && current.delivery !== null
            ? { ok: false, refusal: "settled", message: `decision ${current.id} was delivered already` }
            : { ok: true, decision: { ...current, delivery } },
        decision.workspaceId,
      );
      return mutation.status === "updated";
    } catch (error) {
      log(`[paseo-bm] could not record the delivery of decision ${decision.id}: ${errorText(error)}`);
      return false;
    }
  };

  const onSettled: OnDecisionsSettled = async (decisions, { paseo }) => {
    for (const decision of decisions) {
      if (decisionKindOf(decision.id) !== "held" || decision.status !== "answered" || decision.answer === null) continue;
      // Already allowed as it opened (the policy), or answered in Paseo's own prompt: nothing to send.
      if (decision.answer.by !== "owner" || decision.answer.via === "paseo") continue;
      const action = decision.options.find((option) => option.key === decision.answer?.optionKey)?.action;
      if (action?.kind !== "permission" || heldDecisionId(action.agentId, action.requestId) !== decision.id) {
        log(`[paseo-bm] decision ${decision.id} was answered without one of its permission answers; nothing was sent.`);
        continue;
      }
      if (delivering.has(decision.id)) continue;
      delivering.add(decision.id);
      try {
        const home = homeOf();
        if (home === null) {
          log(`[paseo-bm] decision ${decision.id} was answered, but paseo-bm has no data folder to deliver it from.`);
          continue;
        }
        const settled: SettledStore = { store: createDecisionStore(home, { log }) };
        const kind = `permission:${action.allow ? "allow" : "deny"}`;
        const at = now().toISOString();
        // Exactly once (§D.2): the delivery is written before the answer goes; a decision with one is never answered again.
        if (!recordDelivery(settled, decision, { to: action.agentId, kind, at, outcome: "queued" }, true)) continue;
        if (!isBoundaryPaseo(paseo)) {
          recordDelivery(settled, decision, { to: action.agentId, kind, at, outcome: "failed" }, false);
          log(`[paseo-bm] decision ${decision.id} was answered, but there is no Paseo connection to answer the request: it waits in Paseo's own prompt.`);
          continue;
        }
        const snapshot = await snapshotOf(paseo, action.agentId);
        const pending = Array.isArray(snapshot?.pendingPermissions) ? (snapshot!.pendingPermissions as unknown[]) : [];
        if (!pending.some((entry) => record(entry)["id"] === action.requestId)) {
          recordDelivery(settled, decision, { to: action.agentId, kind, at: now().toISOString(), outcome: "failed" }, false);
          log(`[paseo-bm] request ${action.requestId} of ${action.agentId} is no longer pending; decision ${decision.id} answered nothing.`);
          continue;
        }
        let outcome: DecisionDelivery["outcome"] = "sent";
        try {
          await respond(paseo, action.agentId, action.requestId, action.allow ? { behavior: "allow" } : { behavior: "deny", message: DENIED_MESSAGE });
          remember(`${action.agentId}|${action.requestId}`);
        } catch (error) {
          outcome = "failed";
          log(`[paseo-bm] answering request ${action.requestId} of ${action.agentId} failed: ${errorText(error)}`);
        }
        const doneAt = now().toISOString();
        try {
          settled.store.transition(
            decision.id,
            (current) => {
              const next: Decision = { ...current, delivery: { to: action.agentId, kind, at: doneAt, outcome } };
              // The allow is the grant's one use.
              if (outcome === "sent" && next.grant !== null && next.grant.usedAt === null) return useGrant(next, { effects: next.grant.effects, at: doneAt });
              return { ok: true, decision: next };
            },
            decision.workspaceId,
          );
        } catch (error) {
          log(`[paseo-bm] could not record the delivery of decision ${decision.id}: ${errorText(error)}`);
        }
      } finally {
        delivering.delete(decision.id);
      }
    }
  };

  async function scan(paseoValue: unknown): Promise<ScanResult> {
    const result: ScanResult = { status: "done", requests: [], withdrawn: [], denied: [] };
    if (!isBoundaryPaseo(paseoValue)) return { ...result, status: "no-paseo" };
    const home = homeOf();
    if (home === null) return { ...result, status: "no-data-folder" };
    const paseo = paseoValue;
    try {
      const seenAt = now().getTime();
      const agents = await listAllAgents(paseo.agents.list.bind(paseo.agents), { includeArchived: false });
      const store = createDecisionStore(home, { log });
      const live = new Map<string, { agent: BoundaryAgentSnapshot; pending: Set<string> }>();
      for (const snapshot of agents) {
        const role = roleOfProvider(snapshot.provider);
        if ((role !== "worker" && role !== "reviewer") || text(snapshot.archivedAt) !== null) continue;
        const pending = Array.isArray(snapshot.pendingPermissions) ? (snapshot.pendingPermissions as unknown[]).map(record) : [];
        live.set(snapshot.id, { agent: snapshot, pending: new Set(pending.map((entry) => String(entry["id"]))) });
        const agent: BoundaryAgent = {
          id: snapshot.id,
          workspaceId: text(snapshot.workspaceId),
          parentAgentId: text(snapshot.labels?.[PARENT_AGENT_LABEL]),
          provider: String(snapshot.provider),
          cwd: text(snapshot.cwd) ?? "",
        };
        const replaced = snapshot.labels?.[REPLACED_BY_LABEL] !== undefined;
        // Only the agents under the boundary (change-010 C5): the others' requests stay in Paseo's own prompt.
        if (!pending.some((request) => request["kind"] === "tool")) continue;
        const state = boundaryStateOf(snapshot) ?? boundaryStateOf(await snapshotOf(paseo, snapshot.id));
        if (state !== "on") continue;
        for (const request of pending) {
          if (typeof request["id"] !== "string" || request["kind"] !== "tool") continue;
          const key = `${snapshot.id}|${request["id"]}`;
          if (replaced) {
            if (answered.has(key) || inFlight.has(key)) continue;
            try {
              await respond(paseo, snapshot.id, request["id"], { behavior: "deny", message: REPLACED_MESSAGE });
              remember(key);
              result.denied.push(key);
            } catch (error) {
              log(`[paseo-bm] could not deny request ${request["id"]} of the replaced agent ${snapshot.id}: ${errorText(error)}`);
            }
            continue;
          }
          if (store.get(heldDecisionId(snapshot.id, request["id"])) !== null) continue;
          const outcome = await onRequested({ agent, request: request as unknown as BoundaryRequest }, paseo, snapshot);
          if (outcome !== "ignored") result.requests.push({ key, outcome });
        }
      }
      // Open `h:` decisions whose agent was replaced or is gone, or whose request was resolved while nobody watched.
      const at = now().toISOString();
      for (const decision of store.list({ statuses: UNSETTLED_STATUSES })) {
        if (decisionKindOf(decision.id) !== "held" || Date.parse(decision.askedAt) >= seenAt) continue;
        const action = decision.options.find((option) => option.action?.kind === "permission")?.action;
        if (action?.kind !== "permission") continue;
        const entry = live.get(action.agentId);
        const replaced = entry?.agent.labels?.[REPLACED_BY_LABEL] !== undefined;
        if (entry !== undefined && !replaced && entry.pending.has(action.requestId)) continue;
        const moved = store.transition(decision.id, (current) => withdrawDecision(current, { at }), decision.workspaceId);
        if (moved.status === "updated") result.withdrawn.push(decision.id);
      }
      return result;
    } catch (error) {
      log(`[paseo-bm] the action boundary's scan of pending requests failed: ${errorText(error)}`);
      return { ...result, status: "failed" };
    }
  }

  let scanned = false;
  const usePaseo = (paseo: unknown): void => {
    if (scanned || !isBoundaryPaseo(paseo) || homeOf() === null) return;
    scanned = true;
    void scan(paseo);
  };

  return {
    register(server) {
      // A host without lifecycle events (stop propagation logs it once): requests wait in Paseo's own prompt.
      if (typeof (server as { on?: unknown } | null)?.on !== "function") return () => {};
      const on = (server.on as unknown as (name: string, handler: (event: never, context: { paseo?: unknown }) => Promise<void>) => () => void).bind(server);
      const offRequested = on("agent.permission_requested", async (event: { agent: BoundaryAgent; request: BoundaryRequest }, hook) => {
        await onRequested(event, hook?.paseo);
        usePaseo(hook?.paseo);
      });
      const offResolved = on("agent.permission_resolved", async (event: { agent: BoundaryAgent; requestId: string; resolution: { behavior?: unknown } }, hook) => {
        await onResolved(event);
        usePaseo(hook?.paseo);
      });
      return () => {
        offRequested();
        offResolved();
      };
    },
    onRequested: (event, paseo) => onRequested(event, paseo),
    onResolved: (event) => onResolved(event),
    onSettled,
    usePaseo,
    scan,
  };
}

function safeHomedir(): string | null {
  try {
    return homedir();
  } catch {
    return null;
  }
}

/** True when the agent has an open `h:` decision for this permission request (the watch leaves its `permission-waiting` to it). */
export function isHeldOpen(store: DecisionStore, agentId: string, requestId: string): boolean {
  const decision = store.get(heldDecisionId(agentId, requestId));
  return decision !== null && (decision.status === "open" || decision.status === "needs-confirmation");
}
