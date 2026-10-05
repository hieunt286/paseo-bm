import { describe, expect, it } from "vitest";
import { rejectedInstallResult } from "../plugin/client/update-status";

describe("rejected update install RPC", () => {
  it("becomes an inline unknown result with inspection and retry recovery", () => {
    const result = rejectedInstallResult();

    expect(result.outcome).toBe("unknown");
    expect(result.message).toContain("paseo plugin ls");
    expect(result.message).toContain("paseo plugin update paseo-bm");
    expect(result.error?.code).toBe("E_UPDATE_RESULT_UNKNOWN");
  });
});
