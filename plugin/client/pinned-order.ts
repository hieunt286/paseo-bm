/**
 * The order the owner pinned on the Beads Manager screen (delta 20260917e §4.1).
 *
 * Pure on purpose: no React, no react-native. The screen has no renderer in this
 * repo, so anything that lives in a component cannot be proven by a test. Every
 * decision about WHERE a row goes is made here, and the component only draws the
 * answer.
 *
 * Owner decision Q26: pinned rows keep the owner's order at the top; everything
 * else keeps the activity sort the daemon returned. A new workspace therefore
 * still surfaces on its own, which is the whole reason the activity sort exists.
 */

/** A row the screen can show; only the id matters to this module. */
export interface Orderable {
  id: string;
}

export interface OrderedRows<Row extends Orderable> {
  /** Pinned rows, in the owner's order. */
  pinned: Row[];
  /** Everything else, in the order it arrived. */
  rest: Row[];
}

/**
 * Splits the rows into the pinned block and the rest.
 *
 * A pinned id that is not among the rows is skipped rather than dropped: the
 * workspace may be archived, or one `workspaces.list` call may simply have
 * failed. Forgetting the owner's order because of a bad read would be a worse
 * bug than showing it a moment late — pruning only happens on the next write.
 */
export function orderRows<Row extends Orderable>(rows: readonly Row[], pinned: readonly string[]): OrderedRows<Row> {
  const byId = new Map(rows.map((row) => [row.id, row]));
  const taken = new Set<string>();
  const ordered: Row[] = [];
  for (const id of pinned) {
    const row = byId.get(id);
    if (row === undefined || taken.has(id)) continue;
    ordered.push(row);
    taken.add(id);
  }
  return { pinned: ordered, rest: rows.filter((row) => !taken.has(row.id)) };
}

/**
 * Puts `id` at `index` of the pinned block, whether it was pinned before or not.
 * Out-of-range indexes clamp instead of throwing: a drop past the end of the
 * list means "last", which is what the hand did.
 */
export function pinAt(pinned: readonly string[], id: string, index: number): string[] {
  const without = pinned.filter((entry) => entry !== id);
  const at = Math.max(0, Math.min(index, without.length));
  return [...without.slice(0, at), id, ...without.slice(at)];
}

/** Moves a pinned row by `delta` places. Unpinned ids and no-op moves return the list unchanged. */
export function movePinned(pinned: readonly string[], id: string, delta: number): string[] {
  const from = pinned.indexOf(id);
  if (from < 0) return [...pinned];
  const to = Math.max(0, Math.min(from + delta, pinned.length - 1));
  if (to === from) return [...pinned];
  return pinAt(pinned, id, to);
}

export function unpin(pinned: readonly string[], id: string): string[] {
  return pinned.filter((entry) => entry !== id);
}

/**
 * Drops ids that no longer name a listed workspace.
 *
 * Called only when something is about to be WRITTEN, never on a read: see
 * `orderRows`. `known` must come from a successful listing, or this forgets the
 * owner's order on a transient failure.
 */
export function prunePinned(pinned: readonly string[], known: readonly string[]): string[] {
  const live = new Set(known);
  return pinned.filter((id) => live.has(id));
}

/**
 * Where a dragged row should land, from how far it was dragged.
 *
 * `rowHeight` of 0 means the list has not been measured yet; the row stays put
 * rather than teleporting to the top, because a drag against an unknown scale
 * is not a request to move anywhere.
 */
export function dropIndex(from: number, offsetY: number, rowHeight: number, count: number): number {
  if (rowHeight <= 0 || count <= 0) return from;
  const moved = Math.round(offsetY / rowHeight);
  return Math.max(0, Math.min(from + moved, count - 1));
}
