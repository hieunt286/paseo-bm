import { describe, expect, it } from "vitest";
import {
  SETUP_ROLES,
  compareVersions,
  extraCounter,
  installWarning,
  setupHeadline,
  skillBadge,
  skillChips,
  skillDirsText,
  toolBadge,
} from "../plugin/client/setup-model";
import type { SetupStatus } from "../plugin/shared/contracts";

type Tool = SetupStatus["tools"][number];
const tool = (overrides: Partial<Tool>): Tool => ({
  id: "br",
  name: "br — beads_rust",
  purpose: "",
  required: true,
  path: "/opt/homebrew/bin/br",
  version: "0.6.0",
  latestKnown: "0.6.0",
  installCommand: "brew install dicklesworthstone/tap/br",
  updateCommand: "brew upgrade dicklesworthstone/tap/br",
  homepage: "",
  ...overrides,
});

const status = (tools: Tool[], missing: SetupStatus["skills"]["missingRequired"] = { claude: 0, codex: 0 }): SetupStatus => ({
  tools,
  latestCheckedOn: "2026-09-16",
  skills: {
    checkedAt: "",
    dirs: { shared: "", claude: "", codex: "" },
    skills: [1, 2, 3, 4, 5].map((n) => ({ name: `s${n}`, required: true, claude: "ok", codex: "ok", problem: null })),
    missingRequired: missing,
    installCommand: "",
  },
  extras: { manager: 0, worker: 0, reviewer: 0 },
});

describe("setup wording", () => {
  it("compares versions numerically, with or without a leading v", () => {
    expect(compareVersions("0.2.10", "0.6.0")).toBeLessThan(0);
    expect(compareVersions("v0.25.0", "v0.25.0")).toBe(0);
    expect(compareVersions("0.10.0", "0.9.9")).toBeGreaterThan(0);
    expect(compareVersions("dev", "0.1.0")).toBeNull();
  });

  it("marks a missing required tool red, an old one amber, a current one green", () => {
    expect(toolBadge(tool({ path: null, version: null }))).toEqual({ text: "Missing", tone: "danger" });
    expect(toolBadge(tool({ id: "bd", required: false, path: null }))).toEqual({ text: "Not installed", tone: "muted" });
    expect(toolBadge(tool({ version: "0.2.10" }))).toEqual({ text: "0.2.10 · 0.6.0 available", tone: "warning" });
    expect(toolBadge(tool({}))).toEqual({ text: "0.6.0", tone: "success" });
  });

  it("says in one line whether the machine is ready", () => {
    const bv = tool({ id: "bv", path: null, version: null });
    expect(setupHeadline(status([tool({}), bv]))).toMatchObject({ tone: "danger" });
    expect(setupHeadline(status([tool({}), bv])).text).toContain("Missing bv");
    expect(setupHeadline(status([tool({}), tool({ id: "bv" })], { claude: 2, codex: 0 }))).toEqual({
      text: "br and bv ready · skills: Claude 3/5, Codex 5/5",
      tone: "success",
    });
    expect(setupHeadline(status([tool({})], { claude: 1, codex: 1 })).tone).toBe("warning");
  });

  it("labels skills, counts characters, and names what Install will run", () => {
    expect(skillBadge("Claude", "ok")).toEqual({ text: "Claude ✓", tone: "success" });
    expect(skillBadge("Codex", "broken").tone).toBe("danger");
    expect(skillBadge("Codex", "missing").tone).toBe("warning");
    expect(extraCounter(1234, 8000)).toBe("1,234 / 8,000 characters");
    expect(installWarning(tool({}))).toContain("Homebrew");
    expect(installWarning(tool({ installCommand: "curl -fsSL x | bash" }))).toContain("install script from GitHub");
    expect(SETUP_ROLES.map((entry) => entry.mark)).toEqual(["request", "worker", "reviewer"]);
  });

  describe("Pi and OpenCode columns (delta 20260921 §4.2.6)", () => {
    type Row = SetupStatus["skills"]["skills"][number];
    const row = (overrides: Partial<Row>): Row => ({ name: "s1", required: true, claude: "ok", codex: "missing", problem: null, ...overrides });

    it("show a chip per reported column, in order, and none for a column an older server did not send", () => {
      expect(skillChips(row({ pi: "broken", opencode: "missing" }))).toEqual([
        { text: "Claude ✓", tone: "success" },
        { text: "Codex missing", tone: "warning" },
        { text: "Pi broken", tone: "danger" },
        { text: "OpenCode missing", tone: "warning" },
      ]);
      expect(skillChips(row({})).map((badge) => badge.text)).toEqual(["Claude ✓", "Codex missing"]);
      expect(skillBadge("Pi", "ok")).toEqual({ text: "Pi ✓", tone: "success" });
      expect(skillBadge("OpenCode", "ok")).toEqual({ text: "OpenCode ✓", tone: "success" });
    });

    it("name where each agent's skills were looked for", () => {
      const dirs = { shared: "/h/.agents/skills", claude: "/h/.claude/skills", codex: "/h/.codex/skills" };
      expect(skillDirsText(dirs)).toBe("Claude: /h/.claude/skills · Codex: /h/.agents/skills or /h/.codex/skills");
      expect(skillDirsText({ ...dirs, pi: "/h/.pi/agent/skills", opencode: "/h/.config/opencode/skill" })).toBe(
        "Claude: /h/.claude/skills · Codex: /h/.agents/skills or /h/.codex/skills · Pi: /h/.pi/agent/skills · OpenCode: /h/.config/opencode/skill",
      );
    });

    it("count in the headline, and one ready agent is enough", () => {
      const both = [tool({}), tool({ id: "bv" })];
      expect(setupHeadline(status(both, { claude: 5, codex: 5, pi: 0, opencode: 2 }))).toEqual({
        text: "br and bv ready · skills: Claude 0/5, Codex 0/5, Pi 5/5, OpenCode 3/5",
        tone: "success",
      });
      expect(setupHeadline(status(both, { claude: 5, codex: 5, pi: 1, opencode: 2 })).tone).toBe("warning");
    });
  });
});
