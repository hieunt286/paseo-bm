import { afterEach, describe, expect, it, vi } from "vitest";
import { checkWorkerTools, forgetTools, toolsNotice, type ToolsPaseo } from "../plugin/server/tools-check";
import { TOOLS_NOTICE_MARKER } from "../plugin/server/notices";
import { fakePaseo, type FakeAgent } from "./helpers/fake-paseo";

/**
 * The Worker tools check on `agent.created` (delta 20260921 §4.2.4): a Worker
 * without Paseo tools is reported to its parent only when that parent is a
 * Beads Manager, and the parent's role comes from its provider alone (design
 * §16.3). Fake agents only.
 */

const WORKER = { id: "w1", provider: "bm-worker/qwen", parentAgentId: "p1" };
const toolless: FakeAgent = { id: "w1", provider: "bm-worker/qwen", labels: {}, capabilities: { supportsMcpServers: false } };

function run(parent: FakeAgent) {
  const fake = fakePaseo<ToolsPaseo>({ agents: [toolless, parent] });
  const enqueue = vi.fn(async () => "sent" as const);
  const log = vi.fn();
  return { done: checkWorkerTools(WORKER, fake.paseo, { enqueue, log }), enqueue, log, paseo: fake.paseo };
}

afterEach(() => forgetTools());

describe("checkWorkerTools", () => {
  it("tells a parent on bm-manager, labelled or not", async () => {
    const parents: FakeAgent[] = [
      { id: "p1", provider: "bm-manager", labels: { "bm.role": "manager" } },
      { id: "p1", provider: "bm-manager/claude-opus-5", labels: {} },
    ];
    for (const parent of parents) {
      const { done, enqueue, paseo } = run(parent);
      expect(await done).toBe("missing");
      expect(enqueue).toHaveBeenCalledWith("p1", TOOLS_NOTICE_MARKER, toolsNotice("w1", "bm-worker/qwen"), paseo);
    }
  });

  it("tells nobody when the parent only carries bm.role=manager on another provider (design §16.3)", async () => {
    const { done, enqueue, log } = run({ id: "p1", provider: "claude", labels: { "bm.role": "manager" } });
    expect(await done).toBe("missing");
    expect(enqueue).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(
      "[paseo-bm] Worker w1 runs on bm-worker/qwen without Paseo tools; its parent p1 is not a Beads Manager, so nobody is told.",
    );
  });
});
