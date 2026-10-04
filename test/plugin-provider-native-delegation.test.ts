import { describe, expect, it } from "vitest";
import {
  applyNativeDelegationPrototype,
  applyRoleConfig,
  type AgentCreateRequest,
} from "../plugin/server/role-hook";
import { suppressCodexNativeDelegation } from "../plugin/server/provider-native-delegation";

const request = (provider: string, extra: Record<string, unknown> = {}): AgentCreateRequest =>
  ({ config: { provider, cwd: "/repo", ...extra }, env: { KEEP: "yes" } }) as AgentCreateRequest;

describe("Codex native-delegation suppression prototype", () => {
  for (const provider of [
    "bm-manager",
    "bm-worker/openai/gpt-5.6-sol",
    "bm-reviewer",
    "bm-orchestrator",
    "bm-worker-fallback-2/openai/gpt-5.6-sol",
  ]) {
    it(`disables multi_agent for ${provider}`, () => {
      const input = request(provider, { featureValues: { keep: "creator", multi_agent: true } });
      const result = suppressCodexNativeDelegation(input, "codex");

      expect(result).not.toBe(input);
      expect(result?.config.featureValues).toEqual({ keep: "creator", multi_agent: false });
      expect(result?.env).toBe(input.env);
    });
  }

  it("leaves a standalone Codex request byte-for-byte unchanged", () => {
    const input = request("codex/openai/gpt-5.6-sol", { featureValues: { multi_agent: true } });
    expect(suppressCodexNativeDelegation(input, "codex")).toBeUndefined();
    expect(input).toEqual(request("codex/openai/gpt-5.6-sol", { featureValues: { multi_agent: true } }));
  });

  it("leaves a paseo-bm request on an unsupported base byte-for-byte unchanged", () => {
    const input = request("bm-worker", { featureValues: { native_delegation: true } });
    expect(suppressCodexNativeDelegation(input, "claude")).toBeUndefined();
    expect(input).toEqual(request("bm-worker", { featureValues: { native_delegation: true } }));
  });

  it("composes after role configuration without changing its prompt, mode, or tools", () => {
    const input = request("bm-worker", {
      modeId: "auto",
      featureValues: { keep: 1 },
      mcpServers: { paseo: { type: "http", url: "http://127.0.0.1:1" } },
    });
    const roleConfigured = applyRoleConfig(input, [{ id: "auto", colorTier: "moderate" }]);
    const beforePrototype = roleConfigured ?? input;
    const result = applyNativeDelegationPrototype(beforePrototype, "codex");

    expect(result?.config.featureValues).toEqual({ keep: 1, multi_agent: false });
    expect(result?.config.modeId).toBe(beforePrototype.config.modeId);
    expect(result?.config.systemPrompt).toBe(beforePrototype.config.systemPrompt);
    expect(result?.config.mcpServers).toBe(beforePrototype.config.mcpServers);
  });
});
