import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beadIdCandidates } from "../plugin/shared/bead-ids";
import { beadChipText } from "../plugin/client/beads-model";
import { clearBeadsCache } from "../plugin/server/beads-store";
import { handleBeadsLookup, handleChatBeads } from "../plugin/server/chat-rpc";
import type { DashboardPaseo } from "../plugin/server/dashboard-rpc";

/** Bead ids in chat: chips on cards and the "Beads in this chat" panel. */

describe("finding bead-shaped ids", () => {
  it("finds real id shapes in prose, code and commands, once each, in order", () => {
    const text = [
      "Bead `bm-dcz` is blocked by repo-37g; see cus-contact-uiux-redesign-u9zv.12.",
      "br close repo-37g --reason done. Also bm-wp-115-51j.2 and bm-dcz again.",
    ].join("\n");
    expect(beadIdCandidates(text)).toEqual(["bm-dcz", "repo-37g", "cus-contact-uiux-redesign-u9zv.12", "bm-wp-115-51j.2"]);
  });

  it("skips request ids, paths, flags and URLs, and keeps the limit", () => {
    const text = "req-20260916T062244Z at /repo/src/foo-bar.ts, --dry-run, https://x.dev/a-b and plugin/client/bead-chips.tsx";
    expect(beadIdCandidates(text)).toEqual([]);
    expect(beadIdCandidates("a-1 b-2 c-3", 2)).toEqual(["a-1", "b-2"]);
  });

  it("shows a chip title first", () => {
    expect(beadChipText({ id: "bm-dcz", title: "Role icons on the Metric graph" })).toBe("Role icons on the Metric graph · bm-dcz");
    expect(beadChipText({ id: "bm-dcz", title: null })).toBe("bm-dcz");
    expect(beadChipText({ id: "x-1", title: "a".repeat(60) }, 10)).toBe("aaaaaaaaa… · x-1");
  });
});

let workspace: string;
const WS = "wks_chat";
const bead = (id: string, title: string, status = "open") =>
  JSON.stringify({ id, title, status, priority: 2, issue_type: "task", created_at: "2026-09-16T00:00:00Z", updated_at: "2026-09-16T00:00:00Z", labels: [], dependencies: [] });

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "bm-chat-beads-"));
  mkdirSync(join(workspace, ".beads"));
  writeFileSync(join(workspace, ".beads", "issues.jsonl"), [bead("demo-a1", "First"), bead("demo-b2", "Second", "in_progress")].join("\n") + "\n");
  clearBeadsCache();
});
afterEach(() => rmSync(workspace, { recursive: true, force: true }));

function paseo(pages: Array<{ entries: unknown[]; hasOlder?: boolean; startCursor?: string }> = []): DashboardPaseo {
  const refetch = vi.fn(async (options: Record<string, unknown>) => (options.direction === "tail" ? pages[0] : pages[1]) ?? { entries: [] });
  return {
    agents: { list: vi.fn(async () => ({ entries: [] })), ref: () => ({ timeline: { refetch } }) },
    workspaces: { list: vi.fn(async () => ({ entries: [{ id: WS, directory: workspace }] })) },
    config: { get: vi.fn(async () => ({ config: {} })) },
  };
}

describe("beads.lookup", () => {
  it("returns only ids the store has, in the order asked", async () => {
    const { beads } = await handleBeadsLookup({ workspaceId: WS, ids: ["demo-b2", "feature-workflow", "demo-a1", "demo-b2"] }, paseo());
    expect(beads.map((row) => [row.id, row.title, row.status])).toEqual([
      ["demo-b2", "Second", "in_progress"],
      ["demo-a1", "First", "open"],
    ]);
    expect((await handleBeadsLookup({ workspaceId: "wks_gone", ids: ["demo-a1"] }, paseo())).beads).toEqual([]);
  });
});

describe("chat.beads", () => {
  it("lists beads named in messages and shell commands, newest mention first, counting mentions", async () => {
    const pages = [
      {
        entries: [
          { item: { type: "user_message", text: "Please implement demo-a1." }, timestamp: "2026-09-16T10:00:00Z" },
          { item: { type: "tool_call", detail: { type: "shell", command: "br update demo-a1 --status in_progress" } }, timestamp: "2026-09-16T10:01:00Z" },
          { item: { type: "assistant_message", text: "Should demo-b2 wait for demo-a1? Also feature-workflow." }, timestamp: "2026-09-16T10:02:00Z" },
        ],
        hasOlder: true,
        startCursor: "c1",
      },
      { entries: [{ item: { type: "user_message", text: "Old note about demo-b2" }, timestamp: "2026-09-16T09:00:00Z" }] },
    ];
    const result = await handleChatBeads({ workspaceId: WS, agentId: "w1" }, paseo(pages));
    expect(result.scannedItems).toBe(4);
    expect(result.beads.map((entry) => [entry.bead.id, entry.mentions, entry.lastMentionedAt])).toEqual([
      ["demo-b2", 2, "2026-09-16T10:02:00Z"],
      ["demo-a1", 3, "2026-09-16T10:02:00Z"],
    ]);
  });

  it("is empty for an unknown workspace or an agent without a timeline", async () => {
    expect(await handleChatBeads({ workspaceId: "wks_gone", agentId: "w1" }, paseo())).toEqual({ beads: [], scannedItems: 0 });
    const noRef = paseo();
    delete (noRef.agents as { ref?: unknown }).ref;
    expect(await handleChatBeads({ workspaceId: WS, agentId: "w1" }, noRef)).toEqual({ beads: [], scannedItems: 0 });
  });
});
