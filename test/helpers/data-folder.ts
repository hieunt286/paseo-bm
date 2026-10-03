import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * A temporary data folder (`<tmp>/<prefix>XXXX/.paseo-bm`) for a test, and its
 * removal: the one copy of what nine test files each declared for themselves.
 * Call `removeDataFolders()` in the file's `afterEach`.
 */
const roots: string[] = [];

export function dataFolder(prefix = "bm-test-"): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  const home = join(root, ".paseo-bm");
  mkdirSync(home);
  return home;
}

/** Removes every folder `dataFolder` made since the last call. */
export function removeDataFolders(): void {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
}
