/**
 * The `BM-COMMAND` block: every command the plugin delivers to a Manager or a
 * Worker — the Orchestrator's own, and the command it prepared on an option
 * the owner chose (Orchestrator design §6B.1, ADR-016 decision 5; autonomy
 * design §A.6) — in its version 2 (autonomy
 * design §A.7, ADR-017 decisions 4–5): the command says what it is for
 * (`intent`), what it lets the agent do (`effects`), on whose authority, and
 * which of those effects that authority covers (`approved`).
 *
 * ```
 * BM-COMMAND
 * from: orchestrator | owner
 * via: autopilot | chat | tab
 * to: manager | worker
 * copy: yes                       (only on the Manager's copy of a Worker command)
 * requestId: req-… | none
 * re: <subject, one line, ≤ 120>
 * intent: answer | continue | redirect | stop | release | other
 * effects: <effects, comma-separated, in EFFECTS order> | none
 * authority: owner | autopilot | decision:<decision id>
 * approved: <the effects the authority covers> | none
 * limits: <derived>               (only when from: orchestrator)
 *
 * <body: the instructions, markdown allowed, ≤ 4,000; an answer embeds a BM-ANSWERS block>
 *
 * why: <one line, ≤ 300>          (optional)
 * ```
 *
 * `limits:` is never given: it is the fixed limits (`COMMAND_LIMITS`: no
 * commit, push or deploy; no real data) less what `approved` covers
 * (`limitsOf`), so a delivered command never carries a limit that contradicts
 * its approval. A fixed limit part of whose effects is approved is written as
 * the rest of its effects, one `no-<effect>` each (`approved: push` →
 * `limits: no-commit, no-deploy, no-real-data`). A command from the owner
 * (`from: owner`, which builds before Phase 1 sent) carries no limits: it is
 * the owner's word.
 *
 * `commandBlockOf` writes it and `parseCommandBlock` reads it back; for any
 * input the builder accepts, `parseCommandBlock(commandBlockOf(input))` equals
 * `commandOf(input)`. The plugin writes every block itself, so the reader is
 * strict: a text that is not exactly this shape is not a command block (the
 * chat card then shows it as text). A version 1 block — the same without
 * `intent`, `effects`, `authority` and `approved` — still reads, with
 * `version: 1`, its limits as written, and no intent or authority.
 *
 * The body is kept as given — markdown, and an embedded `BM-ANSWERS` block,
 * which `parseAnswers` (`bm-questions.ts`) still finds in the whole text: the
 * block ends at the blank line before `why:`.
 *
 * `BM-COMMAND` is a plugin notice (`shared/notices.ts` `PREFIXES`): never
 * counted as a new user request by the collector.
 *
 * Pure and environment-neutral: its one import is the decision vocabulary
 * (`decisions.ts`, Zod and plain values), so the chat cards can use it.
 */
import { DECISION_ID_PATTERN, EFFECTS, realEffects, type Effect } from "./decisions";

/** The block's first line, alone on it. */
export const COMMAND_MARKER = "BM-COMMAND";

/** Who decided the command: the Orchestrator (on the owner's authority), or the owner (older builds). */
export const COMMAND_FROM = ["orchestrator", "owner"] as const;
export type CommandFrom = (typeof COMMAND_FROM)[number];

/** How it left: the Orchestrator on Autopilot, on the owner's word in its chat, or on the owner's tap on a decision's option. */
export const COMMAND_VIA = ["autopilot", "chat", "tab"] as const;
export type CommandVia = (typeof COMMAND_VIA)[number];

/** Whose command it is. A Manager's copy of a Worker command says `to: worker` with `copy: yes`. */
export const COMMAND_TO = ["manager", "worker"] as const;
export type CommandTo = (typeof COMMAND_TO)[number];

/** What the command is for (autonomy design §A.7); the same list as a prepared command's `intent` (`decisions.ts`). */
export const COMMAND_INTENTS = ["answer", "continue", "redirect", "stop", "release", "other"] as const;
export type CommandIntent = (typeof COMMAND_INTENTS)[number];

/**
 * On whose authority the command goes (autonomy design §A.7): the owner's own
 * word (the owner's latest message in the Orchestrator's chat),
 * the project's Autopilot, or the grant of a decision the owner answered.
 */
export type CommandAuthority = "owner" | "autopilot" | `decision:${string}`;

/** What `authority:` writes before a decision id. */
export const DECISION_AUTHORITY_PREFIX = "decision:";

/**
 * The fixed limits a command from the Orchestrator starts from, in this
 * order; `limitsOf` takes away what the approval covers.
 */
export const COMMAND_LIMITS = ["no-commit-push-deploy", "no-real-data"] as const;
export type CommandLimit = (typeof COMMAND_LIMITS)[number];

/** The effects each fixed limit withholds. */
export const LIMIT_EFFECTS: Readonly<Record<CommandLimit, readonly Effect[]>> = {
  "no-commit-push-deploy": ["commit", "push", "deploy"],
  "no-real-data": ["real-data"],
};

/** Longest `re:` line, body and `why:` line (design §6B.1). */
export const MAX_COMMAND_RE_CHARS = 120;
export const MAX_COMMAND_BODY_CHARS = 4_000;
export const MAX_COMMAND_WHY_CHARS = 300;
/** Longest request id written on the `requestId:` line. */
export const MAX_COMMAND_REQUEST_ID_CHARS = 128;
/** Longest decision id written on the `authority:` line. */
export const MAX_COMMAND_DECISION_ID_CHARS = 200;

/** What the `requestId:` line says when the command is about no particular request. */
export const COMMAND_NO_REQUEST = "none";
/** What `effects:` and `approved:` say for no effect. */
export const COMMAND_NO_EFFECT = "none";

/**
 * A request id the block can carry: one token, no whitespace — a request id
 * (`req-…`) or a trace-based request key. `none` is reserved.
 */
const REQUEST_ID_PATTERN = new RegExp(`^[A-Za-z0-9._:-]{1,${MAX_COMMAND_REQUEST_ID_CHARS}}$`);

/** Every real effect (`none` aside), in `EFFECTS` order. */
const REAL_EFFECTS: readonly Effect[] = EFFECTS.filter((effect) => effect !== "none");

/**
 * The limits a command from the Orchestrator carries for this approval: each
 * fixed limit none of whose effects is approved, as it is; one whose effects
 * are partly approved, as `no-<effect>` for each effect it still withholds;
 * one whose effects are all approved, not at all.
 */
export function limitsOf(approved: readonly Effect[]): string[] {
  const limits: string[] = [];
  for (const limit of COMMAND_LIMITS) {
    const withheld = LIMIT_EFFECTS[limit].filter((effect) => !approved.includes(effect));
    if (withheld.length === LIMIT_EFFECTS[limit].length) limits.push(limit);
    else limits.push(...withheld.map((effect) => `no-${effect}`));
  }
  return limits;
}

/** The effects a `limits:` value withholds: a fixed limit's, `no-<effect>`'s one, none for a limit this build does not know. */
export function effectsWithheldBy(limit: string): Effect[] {
  if (Object.hasOwn(LIMIT_EFFECTS, limit)) return [...LIMIT_EFFECTS[limit as CommandLimit]];
  const effect = limit.startsWith("no-") ? limit.slice("no-".length) : "";
  return (REAL_EFFECTS as readonly string[]).includes(effect) ? [effect as Effect] : [];
}

/** `decision:<id>`. */
export function decisionAuthorityOf(decisionId: string): CommandAuthority {
  return `${DECISION_AUTHORITY_PREFIX}${decisionId}`;
}

/** The decision id of a `decision:<id>` authority, or null for any other authority. */
export function decisionIdOfAuthority(authority: string | null): string | null {
  if (authority === null || !authority.startsWith(DECISION_AUTHORITY_PREFIX)) return null;
  return authority.slice(DECISION_AUTHORITY_PREFIX.length);
}

/** True when `value` is an authority the block can carry. */
export function isCommandAuthority(value: unknown): value is CommandAuthority {
  if (value === "owner" || value === "autopilot") return true;
  if (typeof value !== "string") return false;
  const id = decisionIdOfAuthority(value);
  return id !== null && id.length <= MAX_COMMAND_DECISION_ID_CHARS && DECISION_ID_PATTERN.test(id);
}

/**
 * The longest block `commandBlockOf` can write: every header line at its
 * longest, the longest body and the longest `why:` line. What a store keeps as
 * the text sent must allow this much.
 */
export const MAX_COMMAND_BLOCK_CHARS = [
  COMMAND_MARKER,
  `from: ${longest(COMMAND_FROM)}`,
  `via: ${longest(COMMAND_VIA)}`,
  `to: ${longest(COMMAND_TO)}`,
  "copy: yes",
  `requestId: ${"x".repeat(MAX_COMMAND_REQUEST_ID_CHARS)}`,
  `re: ${"x".repeat(MAX_COMMAND_RE_CHARS)}`,
  `intent: ${longest(COMMAND_INTENTS)}`,
  `effects: ${REAL_EFFECTS.join(", ")}`,
  `authority: ${DECISION_AUTHORITY_PREFIX}${"x".repeat(MAX_COMMAND_DECISION_ID_CHARS)}`,
  `approved: ${REAL_EFFECTS.join(", ")}`,
  `limits: ${[longest([COMMAND_LIMITS.join(", "), limitsOf(["commit"]).join(", "), limitsOf(["push"]).join(", ")])]}`,
  "",
  "x".repeat(MAX_COMMAND_BODY_CHARS),
  "",
  `why: ${"x".repeat(MAX_COMMAND_WHY_CHARS)}`,
].join("\n").length;

function longest(values: readonly string[]): string {
  return values.reduce((a, b) => (b.length > a.length ? b : a), "");
}

/** What a caller gives `commandBlockOf`. */
export interface CommandInput {
  from: CommandFrom;
  via: CommandVia;
  to: CommandTo;
  /** True only on the Manager's copy of a Worker command (`to: "worker"`). */
  copy?: boolean;
  /** The request the command is about; null or absent writes `none`. */
  requestId?: string | null;
  /** The subject: one line once whitespace is collapsed, 1–120 characters. */
  re: string;
  /** The instructions: markdown, 1–4,000 characters once blank lines around it are removed. */
  body: string;
  /** Why, one line once whitespace is collapsed, at most 300 characters; empty or absent writes no `why:` line. */
  why?: string | null;
  /** What the command is for; `other` when absent. */
  intent?: CommandIntent;
  /** What the command lets the agent do; `none` is dropped; none when absent. */
  effects?: readonly Effect[];
  /**
   * On whose authority it goes. When absent: `owner` for the owner's own
   * command, `autopilot` for one via Autopilot, else `owner`.
   */
  authority?: CommandAuthority;
  /** The declared effects the authority covers; none when absent. */
  approved?: readonly Effect[];
}

/** A command block, as `parseCommandBlock` reads it and `commandOf` normalises an input. */
export interface CommandBlock {
  /** 2 for every block this build writes; 1 for a block without `intent` (read only). */
  version: 1 | 2;
  from: CommandFrom;
  via: CommandVia;
  to: CommandTo;
  copy: boolean;
  requestId: string | null;
  re: string;
  /** Null on a version 1 block. */
  intent: CommandIntent | null;
  /** Real effects in `EFFECTS` order; empty for `none` and on a version 1 block. */
  effects: Effect[];
  /** Null on a version 1 block. */
  authority: CommandAuthority | null;
  /** The effects the authority covers, a subset of `effects`; empty on a version 1 block. */
  approved: Effect[];
  /**
   * The `limits:` values in order: `limitsOf(approved)` for a command from the
   * Orchestrator, empty for the owner's; a version 1 block's as written.
   */
  limits: string[];
  body: string;
  why: string | null;
}

/** One line: every run of whitespace, line breaks included, becomes one space. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** The body with `\r\n` as `\n`, without the blank lines before it or the whitespace after it. */
function bodyOf(text: string): string {
  return text.replace(/\r\n?/g, "\n").replace(/^(?:[ \t]*\n)+/, "").trimEnd();
}

const WHY_LINE = /^why:(?:\s(.*))?$/i;

/**
 * True when the body's last paragraph is a single `why:` line: the reader
 * would take it for the block's own `why:`.
 */
function endsWithWhyParagraph(body: string): boolean {
  const lines = body.split("\n");
  return lines.length >= 3 && WHY_LINE.test(lines[lines.length - 1]!) && lines[lines.length - 2]!.trim() === "";
}

/** The authority an input without one gets (see `CommandInput.authority`). */
function defaultAuthorityOf(input: Pick<CommandInput, "from" | "via">): CommandAuthority {
  return input.from === "orchestrator" && input.via === "autopilot" ? "autopilot" : "owner";
}

function isEffect(value: unknown): value is Effect {
  return typeof value === "string" && (EFFECTS as readonly string[]).includes(value);
}

/**
 * Everything wrong with an input, in English, one line each; empty when
 * `commandBlockOf` accepts it. A tool can return these to the agent instead of
 * throwing.
 */
export function commandInputProblems(input: CommandInput): string[] {
  const problems: string[] = [];
  if (!(COMMAND_FROM as readonly string[]).includes(input.from)) problems.push(`from must be one of ${COMMAND_FROM.join(", ")}`);
  if (!(COMMAND_VIA as readonly string[]).includes(input.via)) problems.push(`via must be one of ${COMMAND_VIA.join(", ")}`);
  if (!(COMMAND_TO as readonly string[]).includes(input.to)) problems.push(`to must be one of ${COMMAND_TO.join(", ")}`);
  if (input.copy === true && input.to !== "worker") problems.push("copy is only for the Manager's copy of a Worker command (to: worker)");
  const requestId = input.requestId ?? null;
  if (requestId !== null && (requestId === COMMAND_NO_REQUEST || !REQUEST_ID_PATTERN.test(requestId))) {
    problems.push(`requestId must be one token of 1-${MAX_COMMAND_REQUEST_ID_CHARS} letters, digits, ".", "_", ":" or "-" (not "${COMMAND_NO_REQUEST}")`);
  }
  const re = oneLine(input.re);
  if (re === "") problems.push("re is empty");
  if (re.length > MAX_COMMAND_RE_CHARS) problems.push(`re is longer than ${MAX_COMMAND_RE_CHARS} characters`);
  const body = bodyOf(input.body);
  if (body === "") problems.push("body is empty");
  if (body.length > MAX_COMMAND_BODY_CHARS) problems.push(`body is longer than ${MAX_COMMAND_BODY_CHARS} characters`);
  const why = oneLine(input.why ?? "");
  if (why.length > MAX_COMMAND_WHY_CHARS) problems.push(`why is longer than ${MAX_COMMAND_WHY_CHARS} characters`);
  if (why === "" && endsWithWhyParagraph(body)) problems.push('the body\'s last paragraph is a "why:" line; pass it as why instead');

  if (input.intent !== undefined && !(COMMAND_INTENTS as readonly string[]).includes(input.intent)) {
    problems.push(`intent must be one of ${COMMAND_INTENTS.join(", ")}`);
  }
  const effects = input.effects ?? [];
  const approved = input.approved ?? [];
  const unknown = [...effects, ...approved].filter((effect) => !isEffect(effect));
  if (unknown.length > 0) problems.push(`effects must be among ${EFFECTS.join(", ")} (not ${unknown.map(String).join(", ")})`);
  const declared = realEffects(effects.filter(isEffect));
  const undeclared = realEffects(approved.filter(isEffect)).filter((effect) => !declared.includes(effect));
  if (undeclared.length > 0) problems.push(`approved names ${undeclared.join(", ")}, which effects does not declare`);
  const authority = input.authority ?? defaultAuthorityOf(input);
  if (!isCommandAuthority(authority)) {
    problems.push(`authority must be owner, autopilot or ${DECISION_AUTHORITY_PREFIX}<decision id of at most ${MAX_COMMAND_DECISION_ID_CHARS} characters>`);
  } else if (input.from === "owner" && authority !== "owner") {
    problems.push("the owner's own command has authority owner");
  } else if (authority === "autopilot" && input.via !== "autopilot") {
    problems.push("authority autopilot is only for a command via autopilot");
  }
  return problems;
}

/** The command as the block will carry it: one-line fields collapsed, the body trimmed, the v2 fields and limits filled in. Throws on a problem. */
export function commandOf(input: CommandInput): CommandBlock {
  const problems = commandInputProblems(input);
  if (problems.length > 0) throw new Error(`Not a valid BM-COMMAND: ${problems.join("; ")}.`);
  const why = oneLine(input.why ?? "");
  const approved = realEffects(input.approved ?? []);
  return {
    version: 2,
    from: input.from,
    via: input.via,
    to: input.to,
    copy: input.copy === true,
    requestId: input.requestId ?? null,
    re: oneLine(input.re),
    intent: input.intent ?? "other",
    effects: realEffects(input.effects ?? []),
    authority: input.authority ?? defaultAuthorityOf(input),
    approved,
    limits: input.from === "orchestrator" ? limitsOf(approved) : [],
    body: bodyOf(input.body),
    why: why === "" ? null : why,
  };
}

function effectsLine(effects: readonly Effect[]): string {
  return effects.length === 0 ? COMMAND_NO_EFFECT : effects.join(", ");
}

/** The `BM-COMMAND` block for `input` (autonomy design §A.7). Throws when `commandInputProblems` finds anything. */
export function commandBlockOf(input: CommandInput): string {
  const command = commandOf(input);
  const lines = [COMMAND_MARKER, `from: ${command.from}`, `via: ${command.via}`, `to: ${command.to}`];
  if (command.copy) lines.push("copy: yes");
  lines.push(
    `requestId: ${command.requestId ?? COMMAND_NO_REQUEST}`,
    `re: ${command.re}`,
    `intent: ${command.intent}`,
    `effects: ${effectsLine(command.effects)}`,
    `authority: ${command.authority}`,
    `approved: ${effectsLine(command.approved)}`,
  );
  if (command.limits.length > 0) lines.push(`limits: ${command.limits.join(", ")}`);
  lines.push("", command.body);
  if (command.why !== null) lines.push("", `why: ${command.why}`);
  return lines.join("\n");
}

const HEADER_LINE = /^([A-Za-z]+):(?:[ \t]+(.*))?$/;
const HEADER_KEYS = ["from", "via", "to", "copy", "requestid", "re", "intent", "effects", "authority", "approved", "limits"] as const;
/** The header keys only a version 2 block has. */
const V2_KEYS = ["intent", "effects", "authority", "approved"] as const;

function oneOf<T extends string>(values: readonly T[], value: string | undefined): T | null {
  return values.find((candidate) => candidate === value) ?? null;
}

/** An `effects:` or `approved:` value: `none`, or real effects without repeats; null when it is neither. */
function parseEffects(text: string | undefined): Effect[] | null {
  if (text === undefined || text === "") return null;
  if (text === COMMAND_NO_EFFECT) return [];
  const names = text.split(",").map((name) => name.trim());
  if (names.some((name) => name === COMMAND_NO_EFFECT || !isEffect(name)) || new Set(names).size !== names.length) return null;
  return realEffects(names as Effect[]);
}

/**
 * The command in a `BM-COMMAND` block, or null when `text` is not one: it must
 * start with the marker line, then the header (`from`, `via`, `to`,
 * `requestId`, `re` required; `copy`, `limits` optional; a version 2 block
 * adds `intent`, `effects`, `authority` and `approved`, all four; an unknown
 * key is ignored, a repeated one refused), one blank line, and a body. The
 * last paragraph is the `why:` when it is a single `why:` line. Every limit of
 * `commandInputProblems` applies, and a version 2 block whose `limits:`
 * withholds an approved effect is refused.
 */
export function parseCommandBlock(text: unknown): CommandBlock | null {
  if (typeof text !== "string") return null;
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  if (lines[0]?.trimEnd() !== COMMAND_MARKER) return null;

  const header = new Map<string, string>();
  let index = 1;
  for (; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (line.trim() === "") break;
    const match = HEADER_LINE.exec(line.trimEnd());
    if (match === null) return null;
    const key = match[1]!.toLowerCase();
    if (!(HEADER_KEYS as readonly string[]).includes(key)) continue;
    if (header.has(key)) return null;
    header.set(key, (match[2] ?? "").trim());
  }
  if (index >= lines.length) return null;

  const from = oneOf(COMMAND_FROM, header.get("from"));
  const via = oneOf(COMMAND_VIA, header.get("via"));
  const to = oneOf(COMMAND_TO, header.get("to"));
  const copyText = header.get("copy");
  const requestText = header.get("requestid");
  const re = header.get("re");
  if (from === null || via === null || to === null || requestText === undefined || re === undefined) return null;
  if (copyText !== undefined && copyText !== "yes") return null;
  const copy = copyText === "yes";
  if (copy && to !== "worker") return null;
  if (requestText !== COMMAND_NO_REQUEST && !REQUEST_ID_PATTERN.test(requestText)) return null;
  if (re === "" || re.length > MAX_COMMAND_RE_CHARS || oneLine(re) !== re) return null;
  const limits = (header.get("limits") ?? "")
    .split(",")
    .map((limit) => limit.trim())
    .filter((limit) => limit !== "");

  // Version 2: all four fields, consistent; version 1: none of them.
  const present = V2_KEYS.filter((key) => header.has(key));
  let v2: Pick<CommandBlock, "intent" | "effects" | "authority" | "approved"> | null = null;
  if (present.length === V2_KEYS.length) {
    const intent = oneOf(COMMAND_INTENTS, header.get("intent"));
    const effects = parseEffects(header.get("effects"));
    const approved = parseEffects(header.get("approved"));
    const authority = header.get("authority");
    if (intent === null || effects === null || approved === null || !isCommandAuthority(authority)) return null;
    if (approved.some((effect) => !effects.includes(effect))) return null;
    if (from === "owner" && authority !== "owner") return null;
    if (authority === "autopilot" && via !== "autopilot") return null;
    if (limits.some((limit) => effectsWithheldBy(limit).some((effect) => approved.includes(effect)))) return null;
    v2 = { intent, effects, authority, approved };
  } else if (present.length > 0) {
    return null;
  }

  const rest = bodyOf(lines.slice(index + 1).join("\n"));
  let body = rest;
  let why: string | null = null;
  if (endsWithWhyParagraph(rest)) {
    const restLines = rest.split("\n");
    const whyText = (WHY_LINE.exec(restLines[restLines.length - 1]!)?.[1] ?? "").trim();
    if (whyText === "" || whyText.length > MAX_COMMAND_WHY_CHARS) return null;
    why = whyText;
    body = bodyOf(restLines.slice(0, -2).join("\n"));
  }
  if (body === "" || body.length > MAX_COMMAND_BODY_CHARS) return null;

  return {
    version: v2 === null ? 1 : 2,
    from,
    via,
    to,
    copy,
    requestId: requestText === COMMAND_NO_REQUEST ? null : requestText,
    re,
    intent: v2?.intent ?? null,
    effects: v2?.effects ?? [],
    authority: v2?.authority ?? null,
    approved: v2?.approved ?? [],
    limits,
    body,
    why,
  };
}
