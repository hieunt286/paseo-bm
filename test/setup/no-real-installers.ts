import { vi } from "vitest";
import type * as BeadsTools from "../../src/beads-tools.js";
import type * as AgentTools from "../../plugin/server/agent-tools";

/**
 * No test may download and run a real installer. `install` installs missing
 * `br` / `bv` on a terminal (delta 20260916-setup-screen); the default step is
 * replaced here by one that does nothing. Tests of the step build their own
 * with `createBeadsToolsStep` and a fake runner.
 */
vi.mock("../../src/beads-tools.js", async (importOriginal) => {
  const actual = await importOriginal<typeof BeadsTools>();
  return {
    ...actual,
    installBeadsTools: async () => ({ warnings: [], notes: [], resolvedWarnings: [] }),
  };
});

/**
 * No test may touch the real install home either: the plugin entry starts the
 * agent tools endpoint (ADR-010), whose port file lives in `~/.paseo-bm`.
 * Every start without an explicit path gets a per-process temporary one.
 */
vi.mock("../../plugin/server/agent-tools", async (importOriginal) => {
  const actual = await importOriginal<typeof AgentTools>();
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  return {
    ...actual,
    startAgentTools: (options: Parameters<typeof actual.startAgentTools>[0] = {}) =>
      actual.startAgentTools({ statePath: join(tmpdir(), `bm-agent-tools-test-${process.pid}`, ".paseo-bm", "ui", "agent-tools.json"), log: () => {}, ...options }),
  };
});
