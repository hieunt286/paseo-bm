/**
 * Two tiny helpers every trace and bead view needs: chronological order and
 * first-wins de-duplication. Pure and environment-neutral.
 */

/** Oldest first by an ISO timestamp; a missing timestamp sorts first. */
export function byAt<T extends { at: string | null }>(a: T, b: T): number {
  const left = a.at ?? "";
  const right = b.at ?? "";
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Keeps the first item for each key, in the original order. */
export function uniqueBy<T>(items: readonly T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const value = key(item);
    if (seen.has(value)) return false;
    seen.add(value);
    return true;
  });
}
