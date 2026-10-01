import { describe, expect, it } from "vitest";
import {
  AGENT_TOOLS_DIALOG,
  CLEANUP_DATA_DIALOG,
  PLUGIN_DIAGNOSTICS_LINE,
  SKILLS_COMMAND_LABEL,
  agentToolsBlock,
  anySkillMissing,
  cleanupDataQuestion,
  cleanupInput,
  cleanupReport,
  cleanupWarning,
  cleanupWarningDialog,
  compareVersions,
  dataHomeLine,
  ensureRolesLine,
  installDialog,
  installWarning,
  rolesCreatedLine,
  signInRows,
  skillBadge,
  skillChips,
  skillDirsText,
  skillsDialog,
  skillsRunLine,
  toolBadge,
} from "../plugin/client/settings-machine-model";
import type { SetupStatus } from "../plugin/shared/contracts";
import { localTimeText } from "../plugin/client/format";

/**
 * What Settings says about the machine's set-up — tools, skills, agent tools,
 * sign-in, data folder, cleanup — and the confirmations in front of each step
 * (`settings-machine-model.ts`), without a renderer.
 */


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

  it("labels skills and names what Install will run", () => {
    expect(skillBadge("Claude", "ok")).toEqual({ text: "Claude ✓", tone: "success" });
    expect(skillBadge("Codex", "broken").tone).toBe("danger");
    expect(skillBadge("Codex", "missing").tone).toBe("warning");
    expect(installWarning(tool({}))).toContain("Homebrew");
    expect(installWarning(tool({ installCommand: "curl -fsSL x | bash" }))).toContain("install script from GitHub");
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

  });
});

// ── A machine set up, for the banner and the sign-in rows (design §7.13) ──────

const skillRow = (name: string, ok: boolean) => ({
  name,
  required: true,
  claude: ok ? ("ok" as const) : ("missing" as const),
  codex: ok ? ("ok" as const) : ("missing" as const),
  pi: "missing" as const,
  opencode: "missing" as const,
  problem: null,
});

/** A machine where everything is already done, which every case below varies. */
function readyStatus(overrides: Partial<SetupStatus> = {}): SetupStatus {
  return {
    tools: [
      { id: "br", name: "br", purpose: "", required: true, path: "/usr/bin/br", version: "0.6.0", latestKnown: "0.6.0", installCommand: null, updateCommand: null, homepage: "" },
      { id: "bv", name: "bv", purpose: "", required: true, path: "/usr/bin/bv", version: "v0.25.0", latestKnown: "v0.25.0", installCommand: null, updateCommand: null, homepage: "" },
    ],
    latestCheckedOn: "2026-09-16",
    skills: {
      checkedAt: "2026-09-25T00:00:00.000Z",
      dirs: { shared: "/h/.agents/skills", claude: "/h/.claude/skills", codex: "/h/.codex/skills", pi: "/h/.pi/agent/skills", opencode: "/h/.config/opencode/skill" },
      skills: ["feature-workflow", "reviewing-plan", "converting-plan-to-beads", "polishing-beads", "implementing-beads"].map((name) => skillRow(name, true)),
      missingRequired: { claude: 0, codex: 0, pi: 5, opencode: 5 },
      installCommand: "npx -y skills add cuongntr/agent-skills …",
    },
    setup: {
      roles: { present: ["manager", "worker", "reviewer"], missing: [], created: null, cleanedUpAt: null },
      agentTools: { injectIntoAgents: true, setBy: null },
      logins: [{ provider: "claude", roles: ["manager", "worker", "reviewer"], state: "logged-in", loginCommand: "claude auth login", guidance: null }],
      skillsRun: null,
      dataHome: { path: "/h/.paseo-bm", source: "default", reason: null },
    },
    ...overrides,
  } as SetupStatus;
}

/** `readyStatus` with the machine-setup part changed. */
const withSetup = (setup: Partial<NonNullable<SetupStatus["setup"]>>, rest: Partial<SetupStatus> = {}): SetupStatus => {
  const base = readyStatus(rest);
  return { ...base, setup: { ...base.setup!, ...setup } } as SetupStatus;
};

describe("what Setup says after ensure-roles", () => {
  it("celebrates roles it just created, dismissably", () => {
    const created = ["manager", "worker", "reviewer", "orchestrator"] as const;
    expect(ensureRolesLine({ created: [...created], baseProvider: "claude", model: "claude-opus-5", skipped: null })).toEqual({
      tone: "success",
      text: "paseo-bm created its roles with defaults (claude · claude-opus-5). Change them in Agents.",
      dismissable: true,
      button: null,
    });
  });

  it("names only the roles it created, as on a machine updated from 0.4.x", () => {
    expect(ensureRolesLine({ created: ["orchestrator"], baseProvider: "claude", model: "claude-opus-5", skipped: null })?.text).toBe(
      "paseo-bm created its Beads Orchestrator role with defaults (claude · claude-opus-5). Change it in Agents.",
    );
    expect(ensureRolesLine({ created: ["reviewer", "worker"], baseProvider: "claude", model: "claude-opus-5", skipped: null })?.text).toBe(
      "paseo-bm created its Beads Worker and Beads Reviewer roles with defaults (claude · claude-opus-5). Change them in Agents.",
    );
  });

  it("names the Reviewer's provider when it went to another model family", () => {
    const reviewer = { baseProvider: "codex", model: "gpt-5.6-sol" };
    const created = ["manager", "worker", "reviewer", "orchestrator"];
    expect(ensureRolesLine({ created, baseProvider: "claude", model: "claude-opus-5", reviewer, skipped: null })?.text).toBe(
      "paseo-bm created its roles with defaults (claude · claude-opus-5; the Reviewer on codex · gpt-5.6-sol, another model family). Change them in Agents.",
    );
    expect(ensureRolesLine({ created: ["reviewer"], baseProvider: "claude", model: "claude-opus-5", reviewer, skipped: null })?.text).toBe(
      "paseo-bm created its Beads Reviewer role with defaults (claude · claude-opus-5; the Reviewer on codex · gpt-5.6-sol, another model family). Change it in Agents.",
    );
  });

  it("says nothing when there was nothing to do", () => {
    expect(ensureRolesLine({ created: [], baseProvider: null, model: null, skipped: null })).toBeNull();
    expect(ensureRolesLine(null)).toBeNull();
  });

  it("offers to set up again after a cleanup, and shows no card", () => {
    const line = ensureRolesLine({ created: [], baseProvider: null, model: null, skipped: "cleaned-up" });

    expect(line).toEqual({
      tone: "warning",
      text: "paseo-bm's settings were removed. Remove the plugin with `paseo plugin remove paseo-bm`, or set it up again.",
      dismissable: false,
      button: "Set up again",
    });
  });

  it("shows a failure with its code and a way to retry", () => {
    const line = ensureRolesLine(null, new Error("E_SETUP_ROLES_FAILED: Paseo reports no available provider"));

    expect(line).toMatchObject({ tone: "danger", button: "Try again" });
    expect(line?.text).toContain("E_SETUP_ROLES_FAILED");
  });
});

describe("the two confirmations", () => {
  it("warns that the agent-tools switch is machine-wide, and defaults to cancel", () => {
    expect(AGENT_TOOLS_DIALOG.title).toBe("Allow Paseo's agent tools for every agent?");
    expect(AGENT_TOOLS_DIALOG.body).toContain("every agent on this machine");
    expect(AGENT_TOOLS_DIALOG.body).toContain("daemon.mcp.injectIntoAgents");
    expect(AGENT_TOOLS_DIALOG.confirmLabel).toBe("Allow for every agent");
    expect(AGENT_TOOLS_DIALOG.defaultAction).toBe("cancel");
  });

  it("shows the exact skills command and says whose tool it is", () => {
    const dialog = skillsDialog("npx -y skills add cuongntr/agent-skills -g -a claude-code codex -y");

    expect(dialog.title).toBe("Run the third-party skills CLI?");
    expect(dialog.body).toContain("npx -y skills add cuongntr/agent-skills -g -a claude-code codex -y");
    expect(dialog.body).toContain("another author");
    expect(dialog.body).toContain("paseo-bm never writes to your skills folders itself");
    expect(dialog.body).toContain("up to 5 minutes");
    expect(dialog.confirmLabel).toBe("Run it");
    expect(dialog.defaultAction).toBe("cancel");
  });

  it("puts a tool's Install behind its warning, untitled, with the words a screen reader hears", () => {
    expect(installDialog(tool({ path: null }))).toEqual({
      title: null,
      body: "This runs Homebrew on this machine: brew install dicklesworthstone/tap/br",
      bodyTone: "warning",
      confirmLabel: "Install br",
      confirmAccessibilityLabel: "Install br on this machine",
      cancelLabel: "Cancel",
      cancelAccessibilityLabel: "Cancel: do not install br",
      defaultAction: "cancel",
    });
    expect(installDialog(tool({ id: "bv", installCommand: "curl -fsSL x | bash" })).body).toBe(
      "This downloads and runs the project's install script from GitHub on this machine: curl -fsSL x | bash",
    );
  });
});

// ── the state of each item, shown where it is managed (0.4.0) ──────────────

describe("the Agents tab's own blocks", () => {
  it("says when paseo-bm created the roles, and with what", () => {
    const status = withSetup({
      roles: {
        present: ["manager", "worker", "reviewer"],
        missing: [],
        created: { at: "2026-09-25T09:00:00.000Z", roles: ["manager"], baseProvider: "claude", model: "claude-opus-5" },
        cleanedUpAt: null,
      },
    });

    const line = rolesCreatedLine(status);
    expect(line).toContain("Created by paseo-bm on ");
    expect(line).toContain("with defaults (claude · claude-opus-5). Change them here.");
    expect(rolesCreatedLine(readyStatus())).toBeNull();
  });

  it("names the Reviewer's provider in that line when it went to another model family", () => {
    const status = withSetup({
      roles: {
        present: ["manager", "worker", "reviewer"],
        missing: [],
        created: {
          at: "2026-09-25T09:00:00.000Z",
          roles: ["manager", "worker", "reviewer"],
          baseProvider: "claude",
          model: "claude-opus-5",
          reviewer: { baseProvider: "codex", model: "gpt-5.6-sol" },
        },
        cleanedUpAt: null,
      },
    });

    expect(rolesCreatedLine(status)).toContain(
      "with defaults (claude · claude-opus-5; the Reviewer on codex · gpt-5.6-sol, another model family). Change them here.",
    );
  });

  it("describes the agent-tools switch in each of its states", () => {
    expect(agentToolsBlock(withSetup({ agentTools: { injectIntoAgents: true, setBy: "plugin" } }))).toEqual({
      text: "On for every agent, turned on by paseo-bm",
      tone: "muted",
      button: null,
    });
    expect(agentToolsBlock(withSetup({ agentTools: { injectIntoAgents: true, setBy: null } }))).toEqual({
      text: "On for every agent",
      tone: "muted",
      button: null,
    });
    expect(agentToolsBlock(withSetup({ agentTools: { injectIntoAgents: false, setBy: null } }))).toEqual({
      text: "Off — no new Beads Manager starts until you allow them",
      tone: "warning",
      button: "Allow agent tools…",
    });
    expect(agentToolsBlock(withSetup({ agentTools: { injectIntoAgents: null, setBy: null } }))).toMatchObject({
      tone: "warning",
      button: null,
    });
    expect(agentToolsBlock({ ...readyStatus(), setup: undefined } as SetupStatus)).toBeNull();
  });

  it("shows one sign-in row per provider, and never a button that logs in", () => {
    const rows = signInRows(
      withSetup({
        logins: [
          { provider: "claude", roles: ["manager", "worker"], state: "logged-in", loginCommand: "claude auth login", guidance: null },
          { provider: "codex", roles: ["reviewer"], state: "logged-out", loginCommand: "codex login", guidance: null },
          { provider: "pi", roles: ["reviewer"], state: "logged-out", loginCommand: null, guidance: "Sign in the way Pi documents." },
          { provider: "opencode", roles: ["manager"], state: "unknown", loginCommand: "opencode providers login", guidance: null },
        ],
      }),
    );

    expect(rows).toEqual([
      { provider: "claude", usedBy: "used by Manager, Worker", text: "Signed in", tone: "muted", command: null },
      {
        provider: "codex",
        usedBy: "used by Reviewer",
        text: "Not signed in — sign in with `codex login`",
        tone: "warning",
        command: "codex login",
      },
      { provider: "pi", usedBy: "used by Reviewer", text: "Sign in the way Pi documents.", tone: "warning", command: null },
      { provider: "opencode", usedBy: "used by Manager", text: "Unknown", tone: "muted", command: null },
    ]);
  });
});

describe("the Agent skills tab", () => {
  it("says when the CLI last ran", () => {
    const status = withSetup({
      skillsRun: { at: "2026-09-25T09:30:00.000Z", command: "npx -y skills add x", code: 0, outcome: "ok" },
    });

    const now = new Date("2026-09-25T10:00:00.000Z");
    expect(skillsRunLine(status, now)).toBe(`Last run: ${localTimeText(new Date("2026-09-25T09:30:00.000Z"), now)} · exit 0`);
    expect(skillsRunLine(readyStatus(), now)).toBeNull();
  });

  it("offers the Install button only while some agent is missing a skill", () => {
    expect(anySkillMissing(readyStatus())).toBe(true); // Pi and OpenCode have none.
    const everywhere = readyStatus();
    everywhere.skills.missingRequired = { claude: 0, codex: 0, pi: 0, opencode: 0 };
    expect(anySkillMissing(everywhere)).toBe(false);
  });

  it("no longer sends anyone to the retired installer", () => {
    expect(SKILLS_COMMAND_LABEL).toBe(
      "Install the required skills for Claude Code and Codex: press Install skills, or run it yourself",
    );
    expect(SKILLS_COMMAND_LABEL).not.toContain("npx paseo-bm");
  });
});

describe("the \"This install\" block", () => {
  it("names the data folder and how it was found", () => {
    expect(dataHomeLine(readyStatus())).toEqual({ text: "Data folder: `/h/.paseo-bm` (default)", tone: "muted" });
    expect(dataHomeLine(withSetup({ dataHome: { path: "/opt/bm", source: "env", reason: null } }))?.text).toBe(
      "Data folder: `/opt/bm` (set by PASEO_BM_HOME)",
    );
    expect(dataHomeLine(withSetup({ dataHome: { path: "/opt/bm", source: "pointer", reason: null } }))?.text).toBe(
      "Data folder: `/opt/bm` (from ~/.paseo-bm/home.json)",
    );
  });

  it("reports a folder it cannot use, with the reason", () => {
    const line = dataHomeLine(withSetup({ dataHome: { path: null, source: null, reason: "PASEO_BM_HOME must be an absolute path" } }));

    expect(line).toEqual({
      text: "paseo-bm cannot use its data folder: PASEO_BM_HOME must be an absolute path",
      tone: "danger",
    });
  });

  it("points at Paseo's own commands for a plugin that will not load", () => {
    expect(PLUGIN_DIAGNOSTICS_LINE).toBe(
      "If paseo-bm does not load at all, check `paseo plugin ls` and `paseo plugin logs paseo-bm`.",
    );
  });
});

// ── "Remove paseo-bm's settings" (0.4.0, design §7.13.7) ───────────────────

describe("the two questions before a cleanup", () => {
  it("says what goes, and warns about running agents", () => {
    const warning = cleanupWarning(readyStatus());

    expect(warning).toBe(
      "This removes every bm-* provider and agent profile from Paseo (the four roles and their fallbacks). " +
        "Agents already running on these roles will fail on their next turn: archive them first. Skills, br and bv stay.",
    );
  });

  it("adds the switch clause only when paseo-bm turned it on and it is still on", () => {
    expect(cleanupWarning(withSetup({ agentTools: { injectIntoAgents: true, setBy: "plugin" } }))).toContain(
      ", and turns Paseo's agent tools back off (paseo-bm turned them on).",
    );
    // On, but somebody else turned it on: it is not ours to take away.
    expect(cleanupWarning(withSetup({ agentTools: { injectIntoAgents: true, setBy: null } }))).not.toContain("agent tools back off");
    expect(cleanupWarning(withSetup({ agentTools: { injectIntoAgents: false, setBy: "plugin" } }))).not.toContain("agent tools back off");
  });

  it("asks about the data separately, naming the folder, and defaults to keeping it", () => {
    expect(cleanupDataQuestion(readyStatus())).toBe(
      "Also delete paseo-bm's data in `/h/.paseo-bm`: history (traces), extra instructions, fallback settings and incidents? " +
        "One small file stays so the roles are not re-created before you remove the plugin, and files left by the old installer stay.",
    );
    expect(CLEANUP_DATA_DIALOG.defaultAction).toBe("keep");
    expect(CLEANUP_DATA_DIALOG.keepLabel).toBe("Keep my data");
  });

  it("draws the warning as a confirmation: untitled, in the danger colour, Cancel the default", () => {
    expect(cleanupWarningDialog(readyStatus())).toEqual({
      title: null,
      body: cleanupWarning(readyStatus()),
      bodyTone: "danger",
      confirmLabel: "Remove settings",
      confirmAccessibilityLabel: "Remove settings, then choose what happens to the data",
      cancelLabel: "Cancel",
      cancelAccessibilityLabel: "Cancel: keep paseo-bm's settings",
      defaultAction: "cancel",
    });
  });

  it("sends the answer it was given, and nothing else", () => {
    expect(cleanupInput(false)).toEqual({ confirmed: true, deleteData: false });
    expect(cleanupInput(true)).toEqual({ confirmed: true, deleteData: true });
  });
});

describe("what the screen says after a cleanup", () => {
  const base = {
    removedProviders: ["bm-manager", "bm-worker", "bm-reviewer"],
    removedProfiles: ["bm-manager", "bm-worker", "bm-reviewer"],
  };

  it("counts what went, and names the next command", () => {
    const report = cleanupReport({ ...base, agentTools: "restored", data: null });

    expect(report.lines[0]).toBe("Removed 3 providers and 3 agent profiles.");
    expect(report.lines).toContain("Paseo's agent tools are back to what they were before paseo-bm.");
    expect(report.lines).toContain("Your data was kept.");
    expect(report.nextCommand).toBe("paseo plugin remove paseo-bm");
  });

  it("explains a switch it did not turn off", () => {
    expect(cleanupReport({ ...base, agentTools: "left-on", data: null }).lines).toContain(
      "Paseo's agent tools are left on — they were not turned on by paseo-bm.",
    );
    expect(cleanupReport({ ...base, agentTools: "off", data: null }).lines).toContain("Paseo's agent tools were already off.");
  });

  it("lists what it deleted and what it kept", () => {
    const report = cleanupReport({
      ...base,
      agentTools: "off",
      data: { deleted: ["traces", "role-extras.json"], kept: ["ui/setup-state.json (it records that you removed paseo-bm's settings)"] },
    });

    expect(report.lines).toContain("Deleted: traces, role-extras.json");
    expect(report.lines.join("\n")).toContain("Kept: ui/setup-state.json");
  });

  it("says so when there was nothing to delete", () => {
    expect(cleanupReport({ ...base, agentTools: "off", data: { deleted: [], kept: [] } }).lines).toContain(
      "No data files were deleted.",
    );
  });

  it("gets the singular right", () => {
    expect(cleanupReport({ removedProviders: ["bm-manager"], removedProfiles: ["bm-manager"], agentTools: "off", data: null }).lines[0]).toBe(
      "Removed 1 provider and 1 agent profile.",
    );
  });
});
