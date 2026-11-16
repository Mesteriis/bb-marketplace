import { useSyncExternalStore } from 'react';
import { parseHidden, toggleHidden, type Hidden } from '../../core/visibility';
const KEY = 'makosh-sidebar:hidden:v1';
const EVENT = 'makosh-sidebar:preferences';
let cachedRaw: string | null | undefined;
let cached: Hidden = { projects: [], threads: [] };
function snapshot() {
    let raw: string | null = null;
    try {
        raw = localStorage.getItem(KEY);
    }
    catch { /* Read-only storage: show everything. */ }
    if (raw !== cachedRaw) {
        cachedRaw = raw;
        cached = parseHidden(raw);
    }
    return cached;
}
function subscribe(listener: () => void) {
    const changed = (event: StorageEvent) => { if (event.key === KEY || event.key === null)
        listener(); };
    window.addEventListener('storage', changed);
    window.addEventListener(EVENT, listener);
    return () => { window.removeEventListener('storage', changed); window.removeEventListener(EVENT, listener); };
}
export function useHidden() { return useSyncExternalStore(subscribe, snapshot, snapshot); }
export function toggle(kind: keyof Hidden, id: string) {
    // Write first: failure leaves the visible state intact and is reported by the UI.
    localStorage.setItem(KEY, JSON.stringify(toggleHidden(snapshot(), kind, id)));
    window.dispatchEvent(new Event(EVENT));
}
