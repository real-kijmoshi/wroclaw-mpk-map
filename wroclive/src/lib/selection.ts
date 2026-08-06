import AsyncStorage from '@react-native-async-storage/async-storage';
import { useSyncExternalStore } from 'react';

/**
 * Which lines the map shows.
 *
 * An empty selection means "everything" rather than "nothing": that is what a
 * rider expects from a map that has just been opened, and it keeps the first
 * screen useful before anyone has touched a filter.
 *
 * Kept outside React because two screens read it — the map and the picker —
 * and it is small enough that a store beats threading context through both.
 */

const STORAGE_KEY = 'wroclive.selectedLines';

let selected: string[] = [];
let hydrated = false;
const listeners = new Set<() => void>();

const emit = () => {
  for (const listener of listeners) listener();
};

const persist = () => {
  AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(selected)).catch(() => {
    // A filter that fails to persist is not worth interrupting anyone over.
  });
};

export const selectionStore = {
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  getSnapshot: () => selected,
  isHydrated: () => hydrated,

  toggle(line: string) {
    selected = selected.includes(line)
      ? selected.filter((item) => item !== line)
      : [...selected, line];
    persist();
    emit();
  },

  set(lines: string[]) {
    selected = [...new Set(lines)];
    persist();
    emit();
  },

  clear() {
    selected = [];
    persist();
    emit();
  },
};

/** Read the persisted filter once at startup. */
export async function hydrateSelection() {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (Array.isArray(parsed)) {
      selected = parsed.filter((item): item is string => typeof item === 'string');
    }
  } catch {
    // Corrupt storage just means no filter.
  } finally {
    hydrated = true;
    emit();
  }
}

export function useSelectedLines(): string[] {
  return useSyncExternalStore(
    selectionStore.subscribe,
    selectionStore.getSnapshot,
    selectionStore.getSnapshot,
  );
}
