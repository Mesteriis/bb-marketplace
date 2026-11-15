import { expect, it } from 'vitest';
import { reconcileCatalog, presentLayout } from './catalog';
import type { LayoutDocument, LayoutNode } from './model';
const item = (id: string, hidden = false): LayoutNode => ({ id, kind: 'item', itemId: id, hidden });
const sep = (id: string): LayoutNode => ({ id, kind: 'separator', hidden: false });
it('adds new IDs once and preserves absent IDs and visibility', () => {
    const doc: LayoutDocument = { version: 1, revision: 3, nodes: [item('a'), item('b', true)] };
    const cat = [{ id: 'a', label: 'Renamed', isVisible: true }, { id: 'c', label: 'C', isVisible: true }];
    const next = reconcileCatalog(doc, cat);
    expect(next.nodes.map(n => n.kind === 'item' ? n.itemId : '')).toEqual(['a', 'b', 'c']);
    expect(reconcileCatalog(next, cat)).toEqual(next);
    expect(next.nodes[1].hidden).toBe(true);
    expect(next.revision).toBe(3);
});
it('normalizes visible separators without changing saved nodes', () => {
    const nodes = [sep('s1'), item('a'), sep('s2'), sep('s3'), item('b', true), sep('s4'), item('c'), sep('s5')];
    expect(presentLayout(nodes, ['a', 'b', 'c']).map(n => n.id)).toEqual(['a', 's2', 'c']);
    expect(nodes).toHaveLength(8);
});
