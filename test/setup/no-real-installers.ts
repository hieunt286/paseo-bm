import { vi } from "vitest";
import type * as BeadsTools from "../../src/beads-tools.js";

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
