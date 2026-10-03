import type { BindingInput, BindingStore, ToolCaller } from "../../plugin/server/agent-bindings";

/**
 * Bindings and tool callers for the agent-tools tests (design §16.5): the one
 * copy of the issue → attach → settle sequence a plugin creation runs, and the
 * callers the tool tests act as.
 */

/** Binds `agentId` as a plugin creation does: issued, attached by the hook, settled at `agent.created`. Returns the token. */
export function bindAgent(store: BindingStore, agentId: string, input: BindingInput): string {
  const { token, tokenSha256 } = store.issue(input);
  store.attach(token, input.role);
  store.settle(tokenSha256, agentId);
  return token;
}

/** The workspace, request and agents the tool callers below belong to. */
export const TOOL_WS = "wks_1";
export const TOOL_REQ = "req-20261003T100000Z";
export const TOOL_MANAGER = "agent-manager";
export const TOOL_WORKER = "agent-worker";
export const TOOL_REVIEWER = "agent-reviewer";

export const MANAGER_CALLER: ToolCaller = { agentId: TOOL_MANAGER, role: "manager", workspaceId: TOOL_WS, requestId: null, parentId: null, batchId: null };
export const WORKER_CALLER: ToolCaller = { agentId: TOOL_WORKER, role: "worker", workspaceId: TOOL_WS, requestId: TOOL_REQ, parentId: TOOL_MANAGER, batchId: null };
export const REVIEWER_CALLER: ToolCaller = { agentId: TOOL_REVIEWER, role: "reviewer", workspaceId: TOOL_WS, requestId: TOOL_REQ, parentId: TOOL_WORKER, batchId: "b1" };
