// Page-session memory with a size bound (slice 3i review): sets and maps the
// page keeps for as long as it is open drop their oldest entries (insertion
// order) instead of growing without end. Pure.

/** Adds `value` as the newest entry, then drops the oldest past `max`. */
export function addBounded<T>(set: Set<T>, value: T, max: number): void {
  set.delete(value);
  set.add(value);
  for (const oldest of set) {
    if (set.size <= max) break;
    set.delete(oldest);
  }
}

/** Sets `key` as the newest entry, then drops the oldest past `max`. */
export function setBounded<K, V>(map: Map<K, V>, key: K, value: V, max: number): void {
  map.delete(key);
  map.set(key, value);
  for (const oldest of map.keys()) {
    if (map.size <= max) break;
    map.delete(oldest);
  }
}
