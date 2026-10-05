import { describe, expect, it, vi } from "vitest";
import { handleUpdatesInstall, installedNpmVersion, UPDATE_COMMAND, UPDATE_INSTALL_MAX_BUFFER, UPDATE_INSTALL_TIMEOUT_MS } from "../plugin/server/update-install";
import { updatesInstallRpc } from "../plugin/shared/contracts";

function listing(version: string, identity: Record<string, unknown> = { kind: "npm", packageName: "paseo-bm-plugin" }): string {
  return JSON.stringify([{ id: "paseo-bm", currentRevision: version, installation: { identity } }]);
}

describe("updates.install", () => {
  it("recognises only the fixed npm installation identity", () => {
    expect(installedNpmVersion(listing("0.5.3"))).toBe("0.5.3");
    expect(installedNpmVersion(listing("0.5.3", { kind: "directory" }))).toBe("unsupported");
    expect(installedNpmVersion(JSON.stringify({ plugins: [{ id: "other" }] }))).toBe("unsupported");
  });

  it("runs fixed inspect/update/inspect argv and confirms the target version", async () => {
    const run = vi.fn()
      .mockResolvedValueOnce({ code: 0, output: listing("0.5.3"), timedOut: false })
      .mockResolvedValueOnce({ code: 0, output: '{"status":"running"}', timedOut: false })
      .mockResolvedValueOnce({ code: 0, output: listing("0.5.4"), timedOut: false });
    const output = await handleUpdatesInstall({ find: () => "/bin/paseo", run, latestVersion: () => "0.5.4" });
    expect(updatesInstallRpc.output.parse(output)).toEqual({ outcome: "updated", message: expect.stringContaining("0.5.4"), command: UPDATE_COMMAND, error: null });
    expect(run.mock.calls).toEqual([
      ["/bin/paseo", ["plugin", "ls", "--json"], 5_000, UPDATE_INSTALL_MAX_BUFFER],
      ["/bin/paseo", ["plugin", "update", "paseo-bm", "--json"], UPDATE_INSTALL_TIMEOUT_MS, UPDATE_INSTALL_MAX_BUFFER],
      ["/bin/paseo", ["plugin", "ls", "--json"], 5_000, UPDATE_INSTALL_MAX_BUFFER],
    ]);
  });

  it("refuses directory installs before running an update", async () => {
    const run = vi.fn().mockResolvedValue({ code: 0, output: listing("0.3.1", { kind: "directory" }), timedOut: false });
    const output = await handleUpdatesInstall({ find: () => "/bin/paseo", run, latestVersion: () => "0.5.4" });
    expect(output).toMatchObject({ outcome: "failed", error: { code: "E_UPDATE_SOURCE_UNSUPPORTED" } });
    expect(run).toHaveBeenCalledOnce();
  });

  it("reports timeout and an unconfirmed post-reload version as unknown", async () => {
    for (const update of [
      { code: 1, output: "", timedOut: true },
      { code: 0, output: "ok", timedOut: false },
    ]) {
      const run = vi.fn()
        .mockResolvedValueOnce({ code: 0, output: listing("0.5.3"), timedOut: false })
        .mockResolvedValueOnce(update)
        .mockResolvedValueOnce({ code: 0, output: listing("0.5.3"), timedOut: false });
      const output = await handleUpdatesInstall({ find: () => "/bin/paseo", run, latestVersion: () => "0.5.4" });
      expect(output).toMatchObject({ outcome: "unknown", error: { code: "E_UPDATE_RESULT_UNKNOWN" } });
      expect(output.message).toContain("paseo plugin ls");
    }
  });

  it("redacts command failures and never runs without a known target", async () => {
    const source = { code: 0, output: listing("0.5.3"), timedOut: false };
    const noTarget = await handleUpdatesInstall({ find: () => "/bin/paseo", run: vi.fn().mockResolvedValue(source), latestVersion: () => null });
    expect(noTarget).toMatchObject({ outcome: "failed", error: { code: "E_UPDATE_TARGET_UNKNOWN" } });
    const run = vi.fn().mockResolvedValueOnce(source).mockResolvedValueOnce({ code: 2, output: "token=very-secret\nfailed", timedOut: false });
    const failed = await handleUpdatesInstall({ find: () => "/bin/paseo", run, latestVersion: () => "0.5.4", env: { PASEO_PASSWORD: "very-secret" } });
    expect(failed).toMatchObject({ outcome: "failed", error: { code: "E_UPDATE_INSTALL_FAILED" } });
    expect(failed.message).not.toContain("very-secret");
  });
});
