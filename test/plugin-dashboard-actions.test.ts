import { describe, expect, it, vi } from "vitest";
import {
  OLDER_THAN_DAYS,
  createConfirmationGate,
  describeAction,
  olderThanCutoff,
} from "../plugin/client/dashboard-model";

/**
 * WP-211.2.2: the destructive flows.
 *
 * The component itself is not rendered (this repo has no React Native
 * renderer — see plugin-launcher.test.ts), so what is exercised here is the
 * three-step contract it is built on: a preview must happen first, the gate has
 * no default yes, and the real call happens exactly once per confirmation.
 */

describe("the older-than shortcut", () => {
  it("reaches back the documented number of days, in UTC", () => {
    const now = new Date("2026-09-16T10:00:00.000Z");
    expect(OLDER_THAN_DAYS).toBe(30);
    expect(olderThanCutoff(now)).toBe("2026-08-17T10:00:00.000Z");
    expect(olderThanCutoff(now, 1)).toBe("2026-09-15T10:00:00.000Z");
  });
});

describe("the three-step contract", () => {
  /** A stand-in for the component's use of the RPCs and the gate. */
  function flow() {
    const gate = createConfirmationGate();
    // The real RPC takes the scope alongside `dryRun`, so the stub has to
    // accept it too — otherwise the confirm path below does not typecheck.
    const rpc = vi.fn(async (input: { dryRun?: boolean } & Record<string, unknown>) => ({
      deleted: { traces: 3, bytes: 4096, running: 1 },
      dryRun: input.dryRun === true,
    }));

    return {
      gate,
      rpc,
      async press(scope: { allOfWorkspace: true }) {
        const result = await rpc({ dryRun: true, ...scope });
        gate.request({ kind: "delete", scope, preview: result.deleted, running: result.deleted.running });
      },
      async confirm() {
        return gate.confirm(async (action) => {
          if (action.kind !== "delete") throw new Error("wrong action");
          return rpc({ ...action.scope });
        });
      },
    };
  }

  it("previews before anything can be deleted", async () => {
    const { press, rpc, gate } = flow();
    await press({ allOfWorkspace: true });
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc.mock.calls[0]?.[0]).toMatchObject({ dryRun: true });
    expect(gate.getPending()?.kind).toBe("delete");
  });

  it("cannot delete without a preview, because nothing is pending", async () => {
    const { confirm, rpc } = flow();
    expect(await confirm()).toBeNull();
    expect(rpc).not.toHaveBeenCalled();
  });

  it("calls the real RPC once after a confirmation, and only once", async () => {
    const { press, confirm, rpc } = flow();
    await press({ allOfWorkspace: true });
    await confirm();
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(rpc.mock.calls[1]?.[0]).not.toMatchObject({ dryRun: true });

    // Pressing confirm again does nothing: the action was consumed.
    expect(await confirm()).toBeNull();
    expect(rpc).toHaveBeenCalledTimes(2);
  });

  it("cancelling leaves the traces alone", async () => {
    const { press, confirm, rpc, gate } = flow();
    await press({ allOfWorkspace: true });
    gate.cancel();
    expect(await confirm()).toBeNull();
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it("shows the user the numbers the preview returned", async () => {
    const { press, gate } = flow();
    await press({ allOfWorkspace: true });
    const described = describeAction(gate.getPending()!);
    expect(described.body[0]).toContain("3 trace(s) (4.0 KB)");
    expect(described.body.join(" ")).toContain("cannot be undone");
    expect(described.confirmLabel).toBe("Delete");
  });
});
