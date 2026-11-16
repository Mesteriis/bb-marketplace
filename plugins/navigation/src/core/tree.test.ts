import { it, expect } from 'vitest';
import { moveNode, setHidden, removeContainer } from './tree';
import type { LayoutNode } from './model';
const a: LayoutNode = { kind: 'item', id: 'a', itemId: 'aa', hidden: false };
const b: LayoutNode = { kind: 'item', id: 'b', itemId: 'bb', hidden: true };
const g: LayoutNode = { kind: 'group', id: 'g', name: 'Group', icon: 'Folder', hidden: false, children: [b] };
it('moves a hidden item out of a group without mutating input', () => {
    const input = [a, g];
    const r = moveNode(input, 'b', null, 1);
    expect(r.ok).toBe(true);
    if (r.ok) {
        expect(r.nodes.map(n => n.id)).toEqual(['a', 'b', 'g']);
        expect(r.nodes[1].hidden).toBe(true);
    }
    expect(g.children).toEqual([b]);
});
it('refuses cycles and invalid insertion indices', () => {
    expect(moveNode([g], 'g', 'g', 0).ok).toBe(false);
    expect(moveNode([a, g], 'a', null, 5).ok).toBe(false);
});
it('preserves child visibility when a group is hidden and unwrapped', () => {
    const r = setHidden([g], 'g', true);
    expect(r.ok).toBe(true);
    if (r.ok && r.nodes[0].kind === 'group')
        expect(r.nodes[0].children[0].hidden).toBe(true);
    const unwrapped = removeContainer([a, g], 'g');
    if (!unwrapped.ok)
        throw Error('unwrap failed');
    expect(unwrapped.nodes).toEqual([a, b]);
    expect(removeContainer([a], 'a').ok).toBe(false);
});
