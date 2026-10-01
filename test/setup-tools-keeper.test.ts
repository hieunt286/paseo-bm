import { describe, expect, it, vi } from "vitest";
import { TOOLS_STATUS_TTL_MS, createToolsStatusKeeper } from "../plugin/server/setup-tools";

/**
 * Tools & skills waited on every visit for three `--version` runs (2026-10-01):
 * the status is kept ten minutes, read anew on Check again (`fresh`), dropped
 * after an install (`forget`), and a failed read is never kept.
 */
describe("the tools' status keeper", () => {
  const tools = [{ id: "br" }] as never;

  it("reads once within the window, and again after it, on fresh, and after forget", async () => {
    const read = vi.fn(async () => tools);
    const keeper = createToolsStatusKeeper(read);
    await keeper.get({ now: 0 });
    await keeper.get({ now: TOOLS_STATUS_TTL_MS - 1 });
    expect(read).toHaveBeenCalledTimes(1);
    await keeper.get({ now: TOOLS_STATUS_TTL_MS });
    expect(read).toHaveBeenCalledTimes(2);
    await keeper.get({ now: TOOLS_STATUS_TTL_MS + 1, fresh: true });
    expect(read).toHaveBeenCalledTimes(3);
    keeper.forget();
    await keeper.get({ now: TOOLS_STATUS_TTL_MS + 2 });
    expect(read).toHaveBeenCalledTimes(4);
  });

  it("keeps no failed read", async () => {
    const read = vi.fn().mockRejectedValueOnce(new Error("boom")).mockResolvedValue(tools);
    const keeper = createToolsStatusKeeper(read);
    await expect(keeper.get({ now: 0 })).rejects.toThrow("boom");
    await expect(keeper.get({ now: 1 })).resolves.toBe(tools);
    expect(read).toHaveBeenCalledTimes(2);
  });
});
