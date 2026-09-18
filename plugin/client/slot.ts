/**
 * A single-value hand-off between something that cannot talk to a surface (a
 * Command Center item, a slash command) and the surface that acts on it
 * (delta 20260918f §4.1). The newest `put` wins.
 *
 * `take()` tells readers when it clears a value, so a surface that reads the
 * slot through `useSyncExternalStore` redraws when a notice is dismissed. A
 * reader that takes again while being told gets `null` and tells nobody, so
 * there is no loop.
 *
 * Pure: no React, no React Native, no `server/` import.
 */
export interface Slot<T> {
  put(value: T): void;
  /** Returns and clears the value. */
  take(): T | null;
  /** Reads the value without clearing it. */
  peek(): T | null;
  subscribe(listener: () => void): () => void;
}

export function createSlot<T>(): Slot<T> {
  let pending: T | null = null;
  const listeners = new Set<() => void>();
  const tell = () => {
    for (const listener of listeners) listener();
  };
  return {
    put(value) {
      pending = value;
      tell();
    },
    take() {
      const value = pending;
      pending = null;
      if (value !== null) tell();
      return value;
    },
    peek: () => pending,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
