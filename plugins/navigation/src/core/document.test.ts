import { expect, it } from 'vitest';
import { decodeDocument } from './document';
const doc = (nodes: unknown[] = []) => ({ version: 1, revision: 0, nodes });
const group = (name: string) => ({ kind: 'group', id: 'g', name, icon: 'Folder', hidden: false, children: [] });
it('normalizes a valid name and accepts 80 Unicode code points', () => {
    expect(decodeDocument(doc([group('  Работа  ')])).kind).toBe('valid');
    expect(decodeDocument(doc([group('😀'.repeat(80))])).kind).toBe('valid');
    expect(decodeDocument(doc([group('😀'.repeat(81))])).kind).toBe('corrupt');
    expect(decodeDocument(doc([group('  ')])).kind).toBe('corrupt');
});
it('rejects duplicate item references and negative revisions', () => {
    expect(decodeDocument(doc([{ kind: 'item', id: '1', itemId: 'mail', hidden: false }, { kind: 'item', id: '2', itemId: 'mail', hidden: false }])).kind).toBe('corrupt');
    expect(decodeDocument({ ...doc(), revision: -1 }).kind).toBe('corrupt');
});
it('preserves unsupported versions and rejects cycles without overflowing', () => {
    expect(decodeDocument({ ...doc(), version: 2 }).kind).toBe('unsupported');
    const g = group('Loop');
    (g.children as unknown[]).push(g);
    expect(decodeDocument(doc([g])).kind).toBe('corrupt');
});
it('rejects over-limit depth and duplicate node identities', () => {
    let root = group('Root'), cur = root;
    for (let i = 0; i < 64; i++) {
        const next = { ...group('Nested'), id: 'n' + i };
        (cur.children as unknown[]).push(next);
        cur = next;
    }
    expect(decodeDocument(doc([root])).kind).toBe('corrupt');
    expect(decodeDocument(doc([group('A'), group('B')])).kind).toBe('corrupt');
});
