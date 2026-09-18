import { describe, expect, it } from "vitest";
import { soleWorkerOf } from "../plugin/shared/sole-worker";

/**
 * Delta 20260918f F12 (owner decision Q7 a): the Worker of a request is the one
 * live Worker carrying its id. An archived agent never counts: sending to it
 * would bring it back (ADR-005).
 */

const REQ = "req-20260918T063746Z";
const peer = (id: string, overrides: Partial<{ role: string; requestId: string | null; archived: boolean }> = {}) => ({
  id,
  role: "worker",
  requestId: REQ,
  archived: false,
  ...overrides,
});

describe("soleWorkerOf", () => {
  it("is the one live Worker of the request", () => {
    expect(soleWorkerOf([peer("w1"), peer("m1", { role: "manager" }), peer("w2", { requestId: "req-20260918T000000Z" })], REQ)?.id).toBe("w1");
  });

  it("is nobody when no Worker, or more than one live Worker, has the request", () => {
    expect(soleWorkerOf([peer("m1", { role: "manager" })], REQ)).toBeNull();
    expect(soleWorkerOf([peer("w1"), peer("w2")], REQ)).toBeNull();
    expect(soleWorkerOf([peer("w1")], null)).toBeNull();
  });

  it("ignores an archived Worker of the same request", () => {
    expect(soleWorkerOf([peer("w-old", { archived: true }), peer("w-new")], REQ)?.id).toBe("w-new");
    expect(soleWorkerOf([peer("w-old", { archived: true })], REQ)).toBeNull();
  });
});
