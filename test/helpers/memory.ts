import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MEMORY_DIR_NAME, MEMORY_ID_PATTERN, MEMORY_VERSION, type MemoryEntry } from "../../plugin/server/memory-store";

/**
 * Appends `n` active entries to the project memory of `workspaceId` in the data
 * folder `home`, in one write of the store's own file
 * (`<home>/memory/<workspaceId>.json`, `{ schemaVersion, entries }`, folder
 * 0700, file 0600): a full memory without `n` fsync'd `add`s. Entry `index`
 * is a `fact` by a Main, `fact <index>`, unless `entryOf` says otherwise; ids
 * are `mem-f…` and never repeat one the file holds. Returns the entries added.
 */
export function fillMemory(
  home: string,
  workspaceId: string,
  n: number,
  entryOf: (index: number) => Partial<Omit<MemoryEntry, "id" | "state">> = () => ({}),
): MemoryEntry[] {
  const dir = join(home, MEMORY_DIR_NAME);
  const path = join(dir, `${workspaceId}.json`);
  const current: MemoryEntry[] = existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as { entries: MemoryEntry[] }).entries : [];
  const taken = new Set(current.map((entry) => entry.id));
  const added: MemoryEntry[] = [];
  for (let index = 0, serial = 0; index < n; index += 1) {
    let id: string;
    do id = `mem-${(0xf000000000 + serial++).toString(16)}`;
    while (taken.has(id));
    if (!MEMORY_ID_PATTERN.test(id)) throw new Error(`fillMemory made an id the store refuses: ${id}`);
    added.push({
      id,
      kind: "fact",
      text: `fact ${index}`,
      source: "test",
      by: { role: "main", agentId: "main-1", missionId: null },
      at: "2026-10-09T10:00:00.000Z",
      supersedes: null,
      ...entryOf(index),
      state: "active",
    });
  }
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify({ schemaVersion: MEMORY_VERSION, entries: [...current, ...added] }, null, 2)}\n`, { mode: 0o600 });
  return added;
}
