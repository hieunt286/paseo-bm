import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  appendSuggestion,
  handleOrchestratorApplySuggestion,
  registerOrchestratorRpcs,
  type OrchestratorRpcDeps,
} from "../plugin/server/orchestrator-rpc";
import { extraHashOf } from "../plugin/server/role-extra-hash";
import { MAX_EXTRA_CHARS, ROLE_EXTRAS_FILE, fullInstructions, readRoleExtras, saveRoleExtra } from "../plugin/server/role-extras";
import { handleRolesInstructions } from "../plugin/server/setup-rpc";
import {
  DASHBOARD_ERROR_CODES,
  DashboardError,
  orchestratorApplySuggestionRpc,
  rolesInstructionsRpc,
  type OrchestratorApplySuggestionInput,
} from "../plugin/shared/contracts";

/**
 * WP-504: `orchestrator.apply-suggestion` (Orchestrator design §7, REQ-076).
 * Runs against a temporary data folder named by `PASEO_BM_HOME`; never the
 * real HOME.
 */

let root: string;
let home: string;
let deps: OrchestratorRpcDeps;

const extrasPath = () => join(home, ROLE_EXTRAS_FILE);
const fileBytes = () => (existsSync(extrasPath()) ? readFileSync(extrasPath(), "utf8") : null);
const hashOf = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "bm-apply-suggestion-"));
  home = join(root, "data");
  deps = { env: { PASEO_BM_HOME: home }, homedir: () => root };
  // `roles.instructions` resolves the data folder from the process environment.
  vi.stubEnv("PASEO_BM_HOME", home);
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

function codeOf(run: () => unknown): string | null {
  try {
    run();
    return null;
  } catch (error) {
    return error instanceof DashboardError ? error.code : `not a DashboardError: ${String(error)}`;
  }
}

function apply(role: OrchestratorApplySuggestionInput["role"], text: string, expectedHash: string) {
  return handleOrchestratorApplySuggestion({ role, text, expectedHash, confirmed: true }, deps);
}

describe("orchestrator.apply-suggestion — appending", () => {
  it("appends after one blank line and keeps the existing text as it was", () => {
    saveRoleExtra(home, "worker", "Use pnpm.\nRun the linter.");
    const out = apply("worker", "Keep Small requests to one commit.", hashOf("Use pnpm.\nRun the linter."));
    expect(out.extra).toBe("Use pnpm.\nRun the linter.\n\nKeep Small requests to one commit.");
    expect(out.extra.startsWith("Use pnpm.\nRun the linter.")).toBe(true);
    expect(readRoleExtras(home).worker).toBe(out.extra);
    expect(orchestratorApplySuggestionRpc.output.parse(out)).toEqual({
      extra: out.extra,
      full: fullInstructions("worker", out.extra),
      chars: out.extra.length,
      maxChars: MAX_EXTRA_CHARS,
      hash: hashOf(out.extra),
    });
  });

  it("with no text yet, the suggestion is the whole text (no leading blank line), and the file is created", () => {
    expect(fileBytes()).toBeNull();
    const out = apply("manager", "Answer in the user's language.", hashOf(""));
    expect(out.extra).toBe("Answer in the user's language.");
    expect(readRoleExtras(home).manager).toBe("Answer in the user's language.");
  });

  it("the separator adapts to trailing newlines, so there is still exactly one blank line", () => {
    expect(appendSuggestion("a\n", "b")).toBe("a\n\nb");
    expect(appendSuggestion("a\n\n", "b")).toBe("a\n\nb");
    expect(appendSuggestion("a", "b")).toBe("a\n\nb");
    expect(appendSuggestion("", "b")).toBe("b");
  });

  it("trims the suggestion and leaves the other roles untouched", () => {
    saveRoleExtra(home, "manager", "Manager text.");
    saveRoleExtra(home, "orchestrator", "Orchestrator text.");
    apply("reviewer", "  Check the tests first.\n", hashOf(""));
    expect(readRoleExtras(home)).toEqual({
      manager: "Manager text.",
      worker: "",
      reviewer: "Check the tests first.",
      orchestrator: "Orchestrator text.",
    });
  });

  it("the hash comes from roles.instructions, and each answer's hash chains to the next call", async () => {
    saveRoleExtra(home, "worker", "Use pnpm.");
    const shown = await handleRolesInstructions({ role: "worker" }, {});
    expect(rolesInstructionsRpc.output.parse(shown).hash).toBe(hashOf("Use pnpm."));
    expect(shown.hash).toBe(extraHashOf(shown.extra));

    const first = apply("worker", "First.", shown.hash);
    const second = apply("worker", "Second.", first.hash);
    expect(second.extra).toBe("Use pnpm.\n\nFirst.\n\nSecond.");
    expect((await handleRolesInstructions({ role: "worker" }, {})).hash).toBe(second.hash);
  });

  it("an addition that lands exactly on the limit is accepted", () => {
    const current = "x".repeat(MAX_EXTRA_CHARS - 4);
    saveRoleExtra(home, "worker", current);
    const out = apply("worker", "yy", hashOf(current));
    expect(out.chars).toBe(MAX_EXTRA_CHARS);
  });
});

describe("orchestrator.apply-suggestion — refusals write nothing", () => {
  it("over 8,000 characters fails E_SUGGESTION_TOO_LONG, not E_ROLE_EXTRA_INVALID, and the file is unchanged", () => {
    const current = "x".repeat(MAX_EXTRA_CHARS - 4);
    saveRoleExtra(home, "worker", current);
    const before = fileBytes();
    expect(codeOf(() => apply("worker", "yyy", hashOf(current)))).toBe("E_SUGGESTION_TOO_LONG");
    expect(fileBytes()).toBe(before);
  });

  it("a suggestion alone above the limit fails E_SUGGESTION_TOO_LONG and creates no file", () => {
    expect(codeOf(() => apply("manager", "z".repeat(MAX_EXTRA_CHARS + 1), hashOf("")))).toBe("E_SUGGESTION_TOO_LONG");
    expect(existsSync(home)).toBe(false);
  });

  it("a stale expectedHash fails E_ROLE_EXTRA_CHANGED and the file is unchanged", () => {
    saveRoleExtra(home, "worker", "Shown text.");
    const shownHash = hashOf("Shown text.");
    // The user saves on Setup after the client showed the preview.
    saveRoleExtra(home, "worker", "Edited on Setup.");
    const before = fileBytes();
    expect(codeOf(() => apply("worker", "A suggestion.", shownHash))).toBe("E_ROLE_EXTRA_CHANGED");
    expect(fileBytes()).toBe(before);
    expect(readRoleExtras(home).worker).toBe("Edited on Setup.");
  });

  it("the hash is checked before the length: a stale hash wins over a too-long result", () => {
    saveRoleExtra(home, "worker", "Now.");
    expect(codeOf(() => apply("worker", "z".repeat(MAX_EXTRA_CHARS), hashOf("Before.")))).toBe("E_ROLE_EXTRA_CHANGED");
  });

  it("with no usable data folder fails E_DATA_HOME_UNAVAILABLE", () => {
    const bad: OrchestratorRpcDeps = { env: { PASEO_BM_HOME: "relative/bm" }, homedir: () => root };
    expect(
      codeOf(() => handleOrchestratorApplySuggestion({ role: "worker", text: "x", expectedHash: hashOf(""), confirmed: true }, bad)),
    ).toBe("E_DATA_HOME_UNAVAILABLE");
  });

  it("registers both codes", () => {
    expect(DASHBOARD_ERROR_CODES).toContain("E_SUGGESTION_TOO_LONG");
    expect(DASHBOARD_ERROR_CODES).toContain("E_ROLE_EXTRA_CHANGED");
  });
});

describe("orchestrator.apply-suggestion — input validation", () => {
  const valid = { role: "worker", text: "A suggestion.", expectedHash: hashOf(""), confirmed: true };

  /** What the SDK's client does: parse the input with the contract, then call the registered handler. */
  async function callLikeTheClient(input: unknown): Promise<unknown> {
    const handle = vi.fn();
    registerOrchestratorRpcs({ handle } as unknown as Parameters<typeof registerOrchestratorRpcs>[0], deps);
    const registered = handle.mock.calls.find(([contract]) => contract === orchestratorApplySuggestionRpc);
    expect(registered).toBeDefined();
    const parsed = await orchestratorApplySuggestionRpc.input.parseAsync(input);
    return registered![1](parsed, { paseo: {} });
  }

  it("missing confirmed is a validation error and nothing is written", async () => {
    mkdirSync(home, { recursive: true });
    writeFileSync(extrasPath(), `${JSON.stringify({ version: 1, roles: { worker: "" } })}\n`);
    const before = fileBytes();
    const withoutConfirmed: Record<string, unknown> = { ...valid };
    delete withoutConfirmed["confirmed"];
    await expect(callLikeTheClient(withoutConfirmed)).rejects.toThrow();
    await expect(callLikeTheClient({ ...valid, confirmed: false })).rejects.toThrow();
    expect(fileBytes()).toBe(before);
  });

  it("the registered handler appends once the input is valid", async () => {
    const out = (await callLikeTheClient(valid)) as { extra: string };
    expect(out.extra).toBe("A suggestion.");
    expect(readRoleExtras(home).worker).toBe("A suggestion.");
  });

  it("refuses the orchestrator role, an empty text and a hash that is not sha256 hex", () => {
    const input = orchestratorApplySuggestionRpc.input;
    expect(input.safeParse(valid).success).toBe(true);
    expect(input.safeParse({ ...valid, role: "orchestrator" }).success).toBe(false);
    expect(input.safeParse({ ...valid, text: "   " }).success).toBe(false);
    expect(input.safeParse({ ...valid, expectedHash: "abc" }).success).toBe(false);
    expect(input.safeParse({ ...valid, expectedHash: hashOf("").toUpperCase() }).success).toBe(false);
  });
});
