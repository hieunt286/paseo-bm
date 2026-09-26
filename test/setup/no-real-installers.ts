import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi } from "vitest";
import type * as AgentTools from "../../plugin/server/agent-tools";

/**
 * Every test worker gets a HOME of its own.
 *
 * From 0.4.0 the plugin's data folder is `~/.paseo-bm` with nothing gating it
 * — no `install.json` to confirm, no Paseo handle to ask (design §5.1) — so a
 * module that resolves it with the real `os.homedir()` would read, and a
 * handler like `traces.delete` would write, the data of whoever is running the
 * suite. `os.homedir()` reads `$HOME` on POSIX and `%USERPROFILE%` on Windows,
 * so redirecting both covers every default. A test that wants a particular
 * folder still injects `homedir` or sets `PASEO_BM_HOME`, and both still win.
 *
 * `PASEO_BM_HOME` is cleared for the same reason, and it matters more: it is
 * checked BEFORE `homedir()`, so a developer who exports the documented
 * override would send every test that injects nothing into their real data
 * folder — and `ensureRoles` swallows the write failure, so it would be silent.
 */
const testHome = mkdtempSync(join(tmpdir(), `bm-test-home-${process.pid}-`));
process.env["HOME"] = testHome;
process.env["USERPROFILE"] = testHome;
delete process.env["PASEO_BM_HOME"];
process.on("exit", () => {
  rmSync(testHome, { recursive: true, force: true });
});

/**
 * The plugin entry starts the agent tools endpoint (ADR-010), which writes its
 * port into the data folder. The temporary HOME above is what keeps that off
 * the real `~/.paseo-bm` — this mock only keeps its log line out of the test
 * output, so a suite that never asked about the endpoint stays readable.
 */
vi.mock("../../plugin/server/agent-tools", async (importOriginal) => {
  const actual = await importOriginal<typeof AgentTools>();
  return {
    ...actual,
    startAgentTools: (options: Parameters<typeof actual.startAgentTools>[0] = {}) =>
      actual.startAgentTools({ log: () => {}, ...options }),
  };
});
