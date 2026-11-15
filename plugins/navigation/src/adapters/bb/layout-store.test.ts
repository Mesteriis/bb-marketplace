import Database from 'better-sqlite3';
import { it, expect } from 'vitest';
import { createLayoutStore } from './layout-store';
it('persists a layout and refuses a stale revision', () => {
    const db = new Database(':memory:');
    try {
        const store = createLayoutStore(db);
        expect(store.read().kind).toBe('empty');
        const doc = { version: 1 as const, revision: 0, nodes: [] };
        expect(store.save(doc, 0)).toEqual({ kind: 'saved', document: { ...doc, revision: 1 } });
        expect(store.save(doc, 0).kind).toBe('conflict');
        expect(store.read()).toEqual({ kind: 'valid', document: { ...doc, revision: 1 } });
    }
    finally {
        db.close();
    }
});
