/**
 * The shared kit of the plugin's acting tools (design §16.6, common rules):
 * the bound agents' creating tools (`create-worker.ts`, `review-tools.ts`) and
 * delivering tools (`deliver-tools.ts`) answer, refuse, guard and deliver
 * through the same few helpers, so a rule written here holds for every one.
 *
 * - **The guard** (`actingTools`): a caller whose binding is still pending is
 *   refused before any tool runs (`pendingCallerRefusal`); an unknown name and
 *   a tool that throws are one refusal line each. Nothing throws into the
 *   endpoint.
 * - **The caller** (`boundAs`): a bound agent of the tool's role, its identity
 *   from its binding, never from the input.
 * - **The input** (`withoutNulls`): a model often sends `null` for a field it
 *   leaves out, so `null` fields read as absent.
 */
import { pendingCallerRefusal, type BoundRole, type ToolCaller } from "./agent-bindings";
import type { ServerToolAnswer, ServerTools } from "./decision-tools";
import type { NoticeOutcome, NoticePaseo, NoticeQueue } from "./notice-queue";
import type { OutboxDeliveryDeps, OutboxDeps } from "./outbox";
import { reasonOf } from "./role-choices";
import type { ToolFace } from "../shared/bm-tools";

export { withoutNulls } from "../shared/bm-tools";

/** A refusal: `{ ok: false }` (the endpoint's `isError`) with the reason. */
export const refused = (text: string): { ok: false; text: string } => ({ ok: false, text });

/** A tool's answer: `value` as JSON. */
export const answered = (value: unknown): ServerToolAnswer => ({ ok: true, text: JSON.stringify(value) });

/** The refusal of an input with problems: one line per problem, and the tool to call again. */
export function fixThese(tool: string, issues: readonly string[]): { ok: false; text: string } {
  return refused(`The call was refused. Fix these and call ${tool} again:\n${issues.map((issue) => `- ${issue}`).join("\n")}`);
}

/** A bound caller: its binding names its agent. */
export type BoundCaller = ToolCaller & { agentId: string };

/** `caller` when it is a bound agent of `role` (design §16.5), else null: unbound, pending or another role's. */
export function boundAs(caller: ToolCaller | null, role: BoundRole): BoundCaller | null {
  return caller !== null && caller.role === role && caller.agentId !== null ? (caller as BoundCaller) : null;
}

/** The delivery state a tool reports for a stored record. */
export type DeliveryState = "sent" | "queued" | "dropped";

/** The delivery state of a notice outcome (`replaced`: a newer copy of the same record waits). */
export function deliveryOf(outcome: NoticeOutcome): DeliveryState {
  return outcome === "sent" ? "sent" : outcome === "dropped" ? "dropped" : "queued";
}

/** What a tool's deps give the outbox. */
export interface ToolOutboxSource {
  now: () => Date;
  log: (message: string) => void;
  /** The notice queue deliveries go through; the plugin's shared one by default. */
  queue?: Pick<NoticeQueue, "enqueue">;
  /** The outbox's record ids and masking; tests pin them. */
  outbox?: Pick<OutboxDeps, "newId" | "env">;
}

/** The outbox options of one tool call: the data folder, the clock, the queue and the call's Paseo handle. */
export function outboxDepsOf(home: string, source: ToolOutboxSource, paseo: unknown): OutboxDeliveryDeps {
  return { home, now: source.now, log: source.log, ...source.outbox, ...(source.queue === undefined ? {} : { queue: source.queue }), paseo: paseo as NoticePaseo };
}

/** One acting tool: the input as given, and who calls (null on the role path). */
export type ToolRun = (input: unknown, caller: ToolCaller | null) => Promise<ServerToolAnswer>;

/**
 * Acting tools as the endpoint serves them (design §16.6): `runs` by name,
 * behind the shared guard. A throw is the refusal "The tool failed: <why>.
 * <nothingDone>; try again later, or tell the owner." Never throws.
 */
export function actingTools(faces: readonly ToolFace[], runs: Readonly<Record<string, ToolRun>>, nothingDone: string): ServerTools {
  return {
    faces,
    has: (name) => Object.hasOwn(runs, name),
    async call(name, input, caller) {
      const run = Object.hasOwn(runs, name) ? runs[name] : undefined;
      if (run === undefined) return refused(`Unknown tool: ${name}`);
      const pending = pendingCallerRefusal(caller ?? null);
      if (pending !== null) return refused(pending);
      try {
        return await run(input, caller ?? null);
      } catch (error) {
        return refused(`The tool failed: ${reasonOf(error)}. ${nothingDone}; try again later, or tell the owner.`);
      }
    },
  };
}
