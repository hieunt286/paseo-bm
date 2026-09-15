/**
 * Injectable question layer.
 *
 * Every consent in paseo-bm goes through a `Prompter`. Two implementations ship:
 * a real one backed by `node:readline/promises` (no third-party dependency), and
 * a scripted one for tests that answers from a pre-loaded script and **counts
 * every call**. The counter is the only evidence for metric M-1 ("a happy-path
 * interactive install asks for confirmation exactly three times"), so it counts
 * attempts, not successful answers.
 */

import type { Interface as ReadlineInterface } from "node:readline/promises";

/** Which standard streams are attached to a terminal. */
export interface TtyInfo {
  readonly stdin: boolean;
  readonly stdout: boolean;
  /** True only when both ends are a terminal, i.e. questions can be asked. */
  readonly interactive: boolean;
}

/** Minimal shape of `process` needed to probe TTY state; keeps detection injectable. */
export interface TtyProbe {
  readonly stdin?: { readonly isTTY?: boolean } | undefined;
  readonly stdout?: { readonly isTTY?: boolean } | undefined;
}

/**
 * Detect TTY state from an injected probe.
 *
 * Nothing else in the codebase may read `process.stdout.isTTY` directly: tests
 * must be able to simulate both modes, so the probe is always a parameter.
 */
export function detectTty(probe: TtyProbe = process): TtyInfo {
  const stdin = probe.stdin?.isTTY === true;
  const stdout = probe.stdout?.isTTY === true;
  return { stdin, stdout, interactive: stdin && stdout };
}

export interface ConfirmQuestion {
  readonly message: string;
  /** Default answer when the user just presses Enter. Defaults to `false`. */
  readonly defaultValue?: boolean;
  /** Extra lines printed before the question, e.g. the full trust warning. */
  readonly details?: readonly string[];
}

export interface InputQuestion {
  readonly message: string;
  readonly defaultValue?: string;
  readonly details?: readonly string[];
}

export interface SelectChoice<T> {
  readonly value: T;
  readonly label: string;
  readonly hint?: string;
}

export interface SelectQuestion<T> {
  readonly message: string;
  readonly choices: readonly SelectChoice<T>[];
  readonly defaultValue?: T;
  readonly details?: readonly string[];
}

export interface Prompter {
  /** False when questions cannot be asked; callers must fall back to flags. */
  readonly interactive: boolean;
  confirm(question: ConfirmQuestion): Promise<boolean>;
  input(question: InputQuestion): Promise<string>;
  select<T>(question: SelectQuestion<T>): Promise<T>;
  /** Release any terminal resources. Safe to call more than once. */
  close(): Promise<void>;
}

/** Thrown when a question is asked in a mode where it cannot be answered. */
export class PromptUnavailableError extends Error {
  readonly question: string;

  constructor(question: string) {
    super(
      `Cannot ask "${question}" because the session is not interactive. ` +
        "Re-run with the flag that grants this step, or run the command from a terminal.",
    );
    this.name = "PromptUnavailableError";
    this.question = question;
  }
}

/** Thrown when a scripted run asks more questions than the script answers. */
export class ScriptExhaustedError extends Error {
  readonly kind: PromptKind;
  readonly index: number;

  constructor(kind: PromptKind, index: number, question: string) {
    super(`ScriptedPrompter: no scripted ${kind} answer #${index} for "${question}"`);
    this.name = "ScriptExhaustedError";
    this.kind = kind;
    this.index = index;
  }
}

export type PromptKind = "confirm" | "input" | "select";

/** One recorded question, in ask order. */
export interface PromptRecord {
  readonly kind: PromptKind;
  readonly message: string;
  readonly details: readonly string[];
  readonly answer: unknown;
}

export interface PromptCounts {
  readonly confirm: number;
  readonly input: number;
  readonly select: number;
  readonly total: number;
}

export interface ScriptedAnswers {
  readonly confirm?: readonly boolean[];
  readonly input?: readonly string[];
  /**
   * Answers for `select`, matched against each question's choices by strict
   * value, then by label, then as a zero-based index.
   */
  readonly select?: readonly unknown[];
}

/**
 * Prompter that replays a script and counts every call.
 *
 * Counters increment before the answer is looked up, so a run that asks one
 * question too many is still visible in `counts` when the error is caught.
 */
export class ScriptedPrompter implements Prompter {
  readonly interactive: boolean;

  private readonly answers: ScriptedAnswers;
  private readonly records: PromptRecord[] = [];
  private confirmCalls = 0;
  private inputCalls = 0;
  private selectCalls = 0;
  private closed = false;

  constructor(answers: ScriptedAnswers = {}, options: { readonly interactive?: boolean } = {}) {
    this.answers = answers;
    this.interactive = options.interactive ?? true;
  }

  get counts(): PromptCounts {
    return {
      confirm: this.confirmCalls,
      input: this.inputCalls,
      select: this.selectCalls,
      total: this.confirmCalls + this.inputCalls + this.selectCalls,
    };
  }

  /** Every question asked so far, in order. */
  get asked(): readonly PromptRecord[] {
    return this.records;
  }

  /** Messages of the confirmations asked so far — handy for exact assertions. */
  get confirmMessages(): readonly string[] {
    return this.records.filter((record) => record.kind === "confirm").map((record) => record.message);
  }

  /** True once `close()` ran, so tests can assert the CLI released the prompter. */
  get isClosed(): boolean {
    return this.closed;
  }

  confirm(question: ConfirmQuestion): Promise<boolean> {
    const index = this.confirmCalls;
    this.confirmCalls += 1;
    const scripted = this.answers.confirm?.[index];
    if (scripted === undefined) {
      throw new ScriptExhaustedError("confirm", index, question.message);
    }
    this.record("confirm", question.message, question.details, scripted);
    return Promise.resolve(scripted);
  }

  input(question: InputQuestion): Promise<string> {
    const index = this.inputCalls;
    this.inputCalls += 1;
    const scripted = this.answers.input?.[index];
    const answer = scripted ?? question.defaultValue;
    if (answer === undefined) {
      throw new ScriptExhaustedError("input", index, question.message);
    }
    this.record("input", question.message, question.details, answer);
    return Promise.resolve(answer);
  }

  select<T>(question: SelectQuestion<T>): Promise<T> {
    const index = this.selectCalls;
    this.selectCalls += 1;
    const scripted = this.answers.select?.[index];
    const answer = scripted === undefined ? question.defaultValue : matchChoice(question.choices, scripted);
    if (answer === undefined) {
      throw new ScriptExhaustedError("select", index, question.message);
    }
    this.record("select", question.message, question.details, answer);
    return Promise.resolve(answer);
  }

  close(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }

  private record(kind: PromptKind, message: string, details: readonly string[] | undefined, answer: unknown): void {
    this.records.push({ kind, message, details: details ?? [], answer });
  }
}

function matchChoice<T>(choices: readonly SelectChoice<T>[], scripted: unknown): T | undefined {
  for (const choice of choices) {
    if (choice.value === scripted) {
      return choice.value;
    }
  }
  for (const choice of choices) {
    if (choice.label === scripted) {
      return choice.value;
    }
  }
  if (typeof scripted === "number" && Number.isInteger(scripted)) {
    return choices[scripted]?.value;
  }
  return undefined;
}

/** Prompter used when no terminal is attached: it never blocks, it refuses. */
export class NonInteractivePrompter implements Prompter {
  readonly interactive = false;

  confirm(question: ConfirmQuestion): Promise<boolean> {
    throw new PromptUnavailableError(question.message);
  }

  input(question: InputQuestion): Promise<string> {
    throw new PromptUnavailableError(question.message);
  }

  select<T>(question: SelectQuestion<T>): Promise<T> {
    throw new PromptUnavailableError(question.message);
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

/**
 * How many times a malformed answer is re-asked before giving up. A local UX
 * guard against an endless loop when stdin yields nothing usable; not a value
 * fixed by the Technical Design.
 */
const MAX_PROMPT_ATTEMPTS = 3;

export interface ReadlineStreams {
  readonly input: NodeJS.ReadableStream;
  readonly output: NodeJS.WritableStream;
}

/** Real prompter, built on `node:readline/promises` so no dependency is added. */
export class ReadlinePrompter implements Prompter {
  readonly interactive = true;

  private readonly streams: ReadlineStreams;
  private rl: ReadlineInterface | undefined;

  constructor(streams: ReadlineStreams = { input: process.stdin, output: process.stdout }) {
    this.streams = streams;
  }

  async confirm(question: ConfirmQuestion): Promise<boolean> {
    const defaultValue = question.defaultValue ?? false;
    const suffix = defaultValue ? "[Y/n]" : "[y/N]";
    this.writeDetails(question.details);
    for (let attempt = 0; attempt < MAX_PROMPT_ATTEMPTS; attempt += 1) {
      const raw = (await this.ask(`${question.message} ${suffix} `)).trim().toLowerCase();
      if (raw === "") {
        return defaultValue;
      }
      if (raw === "y" || raw === "yes") {
        return true;
      }
      if (raw === "n" || raw === "no") {
        return false;
      }
      this.write("Please answer y or n.\n");
    }
    return defaultValue;
  }

  async input(question: InputQuestion): Promise<string> {
    this.writeDetails(question.details);
    const suffix = question.defaultValue === undefined ? "" : ` (${question.defaultValue})`;
    for (let attempt = 0; attempt < MAX_PROMPT_ATTEMPTS; attempt += 1) {
      const raw = (await this.ask(`${question.message}${suffix}: `)).trim();
      if (raw !== "") {
        return raw;
      }
      if (question.defaultValue !== undefined) {
        return question.defaultValue;
      }
      this.write("A value is required.\n");
    }
    throw new PromptUnavailableError(question.message);
  }

  async select<T>(question: SelectQuestion<T>): Promise<T> {
    this.writeDetails(question.details);
    this.write(`${question.message}\n`);
    question.choices.forEach((choice, index) => {
      const hint = choice.hint === undefined ? "" : ` — ${choice.hint}`;
      this.write(`  ${index + 1}) ${choice.label}${hint}\n`);
    });
    const defaultIndex = question.choices.findIndex((choice) => choice.value === question.defaultValue);
    const suffix = defaultIndex >= 0 ? ` (${defaultIndex + 1})` : "";
    for (let attempt = 0; attempt < MAX_PROMPT_ATTEMPTS; attempt += 1) {
      const raw = (await this.ask(`Choose 1-${question.choices.length}${suffix}: `)).trim();
      if (raw === "" && defaultIndex >= 0) {
        const fallback = question.choices[defaultIndex];
        if (fallback !== undefined) {
          return fallback.value;
        }
      }
      const picked = Number.parseInt(raw, 10);
      const choice = Number.isNaN(picked) ? undefined : question.choices[picked - 1];
      if (choice !== undefined) {
        return choice.value;
      }
      this.write(`Please enter a number between 1 and ${question.choices.length}.\n`);
    }
    throw new PromptUnavailableError(question.message);
  }

  async close(): Promise<void> {
    this.rl?.close();
    this.rl = undefined;
    await Promise.resolve();
  }

  private async ask(prompt: string): Promise<string> {
    if (this.rl === undefined) {
      const { createInterface } = await import("node:readline/promises");
      this.rl = createInterface({ input: this.streams.input, output: this.streams.output });
    }
    return this.rl.question(prompt);
  }

  private writeDetails(details: readonly string[] | undefined): void {
    for (const line of details ?? []) {
      this.write(`${line}\n`);
    }
  }

  private write(text: string): void {
    this.streams.output.write(text);
  }
}

/** Pick the prompter that matches the current TTY state. */
export function createPrompter(tty: TtyInfo, streams?: ReadlineStreams): Prompter {
  return tty.interactive ? new ReadlinePrompter(streams) : new NonInteractivePrompter();
}
