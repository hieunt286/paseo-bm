import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

/** REQ-173: the installed package compared with npm, never an installer. */
export const updatesCheckRpc = defineRpc({
  name: "updates.check",
  input: z.object({ force: z.boolean().optional() }),
  output: z.object({
    installedVersion: z.string(),
    latestVersion: z.string().nullable(),
    updateAvailable: z.boolean().nullable(),
    checkedAt: z.string().nullable(),
    source: z.enum(["cache", "network", "none"]),
    error: z.object({ code: z.string(), message: z.string() }).nullable(),
  }),
});

export type UpdatesCheckInput = z.infer<typeof updatesCheckRpc.input>;
export type UpdatesCheckOutput = z.infer<typeof updatesCheckRpc.output>;
