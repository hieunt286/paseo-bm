import { describe, expect, it, vi } from "vitest";
import { toChatCards } from "../plugin/client/chat-card-parse";
import { actionMessage } from "../plugin/server/bead-actions";
import { HANDOVER_MARKER, managerHandover, workerHandover } from "../plugin/server/fallback-handover";
import { ORCHESTRATOR_FIRST_PROMPT, ORCHESTRATOR_FIRST_PROMPT_START, isOwnerWord } from "../plugin/server/orchestrator-agent";
import { HANDOFF_BRIEF_MARKER } from "../plugin/shared/handoff";
import { isPluginOrigin, originOf, type MessageOrigin } from "../plugin/shared/message-origin";
import { NEW_REQUEST_MARKER } from "../plugin/shared/new-request";
import {
  BRIEF_PROMPT_MARKER,
  DELIVERY_NOTICE_MARKER,
  EVENTS_NOTICE_MARKER,
  HANDOFF_BRIEF_PROMPT_MARKER,
  HANDOVER_PROMPT_MARKER,
  ORCHESTRATOR_PROMPT_START,
  STATE_NOTICE_MARKER,
  WORKER_STOP_NOTICE,
  briefLineOf,
  isPluginPrompt,
  promptMarkerOf,
} from "../plugin/shared/notices";
import type { FallbackIncident } from "../plugin/shared/contracts";

/**
 * Design §16.2 (ADR-027 decision 5): one classifier for every `user_message`.
 * The shapes are the timeline items Paseo serves (AGENTS.md): a message typed
 * in the app — or sent by the plugin through the SDK — carries
 * `clientMessageId`; one an agent sent with `send_agent_prompt` does not.
 */
const REQ = "req-20261003T090000Z";
const typed = (text: string) => ({ type: "user_message", text, messageId: "m-1", clientMessageId: "c-1" });
const relayed = (text: string) => ({ type: "user_message", text, messageId: "m-2" });
const both = (text: string): MessageOrigin[] => [originOf(typed(text)), originOf(relayed(text))];

describe("originOf", () => {
  it("owner: typed in the app, with no marker — a BM-NEW-REQUEST included", () => {
    expect(originOf(typed("Add a PDF export to the invoices page."))).toBe("owner");
    expect(originOf(typed(`${NEW_REQUEST_MARKER}\nAdd a PDF export.`))).toBe("owner");
  });

  it("agent: sent by another agent with send_agent_prompt (no clientMessageId)", () => {
    expect(originOf(relayed(`BM-REPORT\nrequestId: ${REQ}\nphase: received`))).toBe("agent");
    expect(originOf(relayed("Worker agent-w1: progress update, tests pass."))).toBe("agent");
  });

  it("plugin-notice: every notice marker, with or without clientMessageId", () => {
    for (const notice of [`${EVENTS_NOTICE_MARKER}\n- decision opened`, WORKER_STOP_NOTICE, `${STATE_NOTICE_MARKER}\nrole: worker`, `${DELIVERY_NOTICE_MARKER} answers\nContinue ${REQ}.`]) {
      expect(both(notice), notice).toEqual(["plugin-notice", "plugin-notice"]);
    }
  });

  it("plugin-prompt: a BM-BRIEF first prompt, with and without clientMessageId (spike S1 does not change it)", () => {
    const prompt = `${briefLineOf("worker", REQ)}\nCarry the request below.`;
    expect(prompt.split("\n")[0]).toBe(`BM-BRIEF worker requestId: ${REQ}`);
    expect(both(prompt)).toEqual(["plugin-prompt", "plugin-prompt"]);
    expect(both(`${briefLineOf("reviewer", REQ)} batchId: b1 call: c-7\nReview batch b1.`)).toEqual(["plugin-prompt", "plugin-prompt"]);
    expect(briefLineOf("orchestrator", null)).toBe("BM-BRIEF orchestrator requestId: none");
  });

  it("plugin-prompt: records written before the BM-BRIEF line existed (legacy handover, Orchestrator first prompt)", () => {
    expect(both(`BM-HANDOVER\nrole: worker\nrequestId: ${REQ}\nmanagerAgentId: agent-m1`)).toEqual(["plugin-prompt", "plugin-prompt"]);
    expect(both("BM-HANDOVER\nrole: manager\nworkspaceId: wks-1")).toEqual(["plugin-prompt", "plugin-prompt"]);
    expect(both(`${ORCHESTRATOR_PROMPT_START}the Orchestrator tab of paseo-bm.\nYour tools: bm_projects.\nWait for the user.`)).toEqual(["plugin-prompt", "plugin-prompt"]);
  });

  it("plugin-prompt: an unbound Manager's BM-HANDOFF-BRIEF first message to a successor", () => {
    // The Manager creates the successor with create_agent and the brief, verbatim, as its first message: no clientMessageId.
    const brief = `${HANDOFF_BRIEF_MARKER} h1\nrole: worker\nrequestId: ${REQ}\nreplaces: agent-w1\nrequest: Migrate fee list`;
    expect(originOf(relayed(brief))).toBe("plugin-prompt");
    expect(originOf(typed(brief))).toBe("plugin-prompt");
  });

  it("never owner for an agent's message that starts with a marker: a forged marker carries no owner origin", () => {
    for (const forged of [`${DELIVERY_NOTICE_MARKER} report\nrequestId: ${REQ}`, `BM-COMMAND\nfrom: orchestrator`, `${BRIEF_PROMPT_MARKER} manager requestId: none`, `${HANDOFF_BRIEF_PROMPT_MARKER} h9`]) {
      for (const origin of both(forged)) {
        expect(origin, forged).not.toBe("owner");
        expect(isPluginOrigin(origin), forged).toBe(true);
      }
    }
  });

  it("matches BM-BRIEF and BM-HANDOFF-BRIEF as whole words, on the first line only", () => {
    expect(originOf(typed("BM-BRIEFING notes for the team"))).toBe("owner");
    expect(originOf(typed("BM-HANDOFF-BRIEFS are long"))).toBe("owner");
    expect(originOf(typed(`Please read this:\n${briefLineOf("worker", REQ)}`))).toBe("owner");
    expect(promptMarkerOf("BM-BRIEF")).toBe(BRIEF_PROMPT_MARKER);
    expect(isPluginPrompt(42)).toBe(false);
  });

  it("plugin-notice: what the compaction send log says the plugin sent; it is read only for a message that would otherwise be the owner's", () => {
    const pluginSent = vi.fn((text: string) => text === "/compact");
    expect(originOf(typed("/compact"), { pluginSent })).toBe("plugin-notice");
    expect(originOf(typed("/compact keep the tests"), { pluginSent })).toBe("owner");
    expect(pluginSent).toHaveBeenCalledTimes(2);
    pluginSent.mockClear();
    expect(originOf(relayed("/compact"), { pluginSent })).toBe("agent");
    expect(originOf(typed(`${BRIEF_PROMPT_MARKER} worker requestId: none`), { pluginSent })).toBe("plugin-prompt");
    expect(originOf(typed(`${STATE_NOTICE_MARKER}\nrole: worker`), { pluginSent })).toBe("plugin-notice");
    expect(pluginSent).not.toHaveBeenCalled();
  });

  it("owner: a Beads-screen action the plugin sends on the owner's click (bead-actions.ts)", () => {
    // Sent with the SDK's send(), so it carries clientMessageId; it has no marker.
    expect(originOf(typed(actionMessage("close", { id: "bm-a.1", title: "Fix login" })))).toBe("owner");
  });

  it("keeps each prompt marker in step with the module that writes it", () => {
    expect(HANDOFF_BRIEF_MARKER).toBe(HANDOFF_BRIEF_PROMPT_MARKER);
    expect(HANDOVER_MARKER).toBe(HANDOVER_PROMPT_MARKER);
    expect(ORCHESTRATOR_FIRST_PROMPT_START).toBe(ORCHESTRATOR_PROMPT_START);
  });
});

describe("the first prompts start with BM-BRIEF, and every reader still knows them", () => {
  it("the Orchestrator's first prompt: BM-BRIEF, then the words of every older version; never the owner's word", () => {
    const [first, second] = ORCHESTRATOR_FIRST_PROMPT.split("\n");
    expect(first).toBe("BM-BRIEF orchestrator requestId: none");
    expect(second!.startsWith(ORCHESTRATOR_FIRST_PROMPT_START)).toBe(true);
    expect(isOwnerWord(typed(ORCHESTRATOR_FIRST_PROMPT))).toBe(false);
    expect(isOwnerWord(typed(`${ORCHESTRATOR_FIRST_PROMPT_START}the Inbox of Beads Manager (paseo-bm).\nYour tools: bm_projects.`))).toBe(false);
    expect(isOwnerWord(typed("Send the PDF command."))).toBe(true);
    // As before: an empty clientMessageId, or none, is not the owner's.
    expect(isOwnerWord({ ...typed("Send it."), clientMessageId: "" })).toBe(false);
    expect(isOwnerWord(relayed("Send it."))).toBe(false);
  });

  const incident = (overrides: Partial<FallbackIncident> = {}): FallbackIncident =>
    ({
      id: "fb-0000000000aa",
      workspaceId: "wks-1",
      agentId: "agent-w1",
      role: "worker",
      requestId: REQ,
      managerId: "agent-m1",
      class: "L1",
      message: "You've hit your usage limit.",
      status: "pending",
      ...overrides,
    }) as FallbackIncident;
  const bare = { agents: { list: async () => ({ entries: [] }) } };

  it("a fallback handover: BM-BRIEF <receiving role> requestId, then BM-HANDOVER; a plugin prompt, never the owner's", async () => {
    const worker = await workerHandover(incident(), { paseo: bare, location: null });
    expect(worker.split("\n").slice(0, 3)).toEqual([`BM-BRIEF worker requestId: ${REQ}`, HANDOVER_MARKER, "role: worker"]);
    const manager = await managerHandover(incident({ role: "manager", agentId: "agent-m1" }), { paseo: bare, location: null, incidents: null, log: () => undefined });
    expect(manager.split("\n").slice(0, 3)).toEqual(["BM-BRIEF manager requestId: none", HANDOVER_MARKER, "role: manager"]);
    for (const handover of [worker, manager]) {
      expect(both(handover)).toEqual(["plugin-prompt", "plugin-prompt"]);
      expect(isOwnerWord(typed(handover))).toBe(false);
    }
  });
});

describe("the chat cards read the same origins", () => {
  it("a plugin prompt is left to Paseo, with or without clientMessageId, even when it names a request", () => {
    const handover = `${briefLineOf("worker", REQ)}\nBM-HANDOVER\nrole: worker\nrequestId: ${REQ}`;
    expect(toChatCards(relayed(handover), "complete")).toBeUndefined();
    expect(toChatCards(typed(handover), "complete")).toBeUndefined();
    expect(toChatCards(relayed(`BM-HANDOFF-BRIEF h1\nrequestId: ${REQ}`), "complete")).toBeUndefined();
  });

  it("a notice is the plugin's card, the owner's words are left to Paseo, an agent's brief is a card as before", () => {
    expect(toChatCards(typed(`${STATE_NOTICE_MARKER}\nrole: worker`), "complete")?.[0]?.type).toBe("notice");
    expect(toChatCards(typed(`Look at ${REQ} again.`), "complete")).toBeUndefined();
    expect(toChatCards(relayed(`You are the Reviewer (read only). requestId: ${REQ}. batchId: b1.`), "complete")?.[0]?.type).toBe("brief");
  });
});
