import type { PaseoCliDeps } from "../../plugin/server/paseo-cli";

/**
 * A fake `paseo` CLI: every run answers exit `code` (0 by default) with no
 * output, and its arguments are kept in `calls`. Nothing is run.
 */
export function fakeCli(code = 0): { cli: PaseoCliDeps; calls: string[][] } {
  const calls: string[][] = [];
  const cli: PaseoCliDeps = { find: () => "/bin/paseo", run: async (_file, args) => (calls.push(args), { code, output: "", timedOut: false }) };
  return { cli, calls };
}
