import type { LayoutNode } from './model';
export type TreeEditResult = {
    ok: true;
    nodes: LayoutNode[];
} | {
    ok: false;
    reason: 'not-found' | 'invalid-target' | 'cycle' | 'invalid-index' | 'item-delete-forbidden';
};
function locate(nodes: LayoutNode[], id: string): {
    list: LayoutNode[];
    index: number;
} | null {
    for (let i = 0; i < nodes.length; i++) {
        const n = nodes[i];
        if (n.id === id)
            return { list: nodes, index: i };
        if (n.kind === 'group') {
            const r = locate(n.children, id);
            if (r)
                return r;
        }
    }
    return null;
}
export function moveNode(nodes: LayoutNode[], id: string, parentId: string | null, index: number): TreeEditResult {
    const copy = structuredClone(nodes), source = locate(copy, id);
    if (!source)
        return { ok: false, reason: 'not-found' };
    const node = source.list[source.index];
    if (parentId === id || (node.kind === 'group' && parentId !== null && locate(node.children, parentId)))
        return { ok: false, reason: 'cycle' };
    const parent = parentId === null ? null : locate(copy, parentId);
    const target = parent?.list[parent.index];
    if (parentId !== null && target?.kind !== 'group')
        return { ok: false, reason: 'invalid-target' };
    const list = target?.kind === 'group' ? target.children : copy;
    const length = list.length - (list === source.list ? 1 : 0);
    if (!Number.isInteger(index) || index < 0 || index > length)
        return { ok: false, reason: 'invalid-index' };
    source.list.splice(source.index, 1);
    list.splice(index, 0, node);
    return { ok: true, nodes: copy };
}
export function setHidden(nodes: LayoutNode[], id: string, hidden: boolean): TreeEditResult {
    const copy = structuredClone(nodes), ref = locate(copy, id);
    if (!ref)
        return { ok: false, reason: 'not-found' };
    ref.list[ref.index].hidden = hidden;
    return { ok: true, nodes: copy };
}
export function removeContainer(nodes: LayoutNode[], id: string): TreeEditResult {
    const copy = structuredClone(nodes), ref = locate(copy, id);
    if (!ref)
        return { ok: false, reason: 'not-found' };
    const n = ref.list[ref.index];
    if (n.kind === 'item')
        return { ok: false, reason: 'item-delete-forbidden' };
    ref.list.splice(ref.index, 1, ...(n.kind === 'group' ? n.children : []));
    return { ok: true, nodes: copy };
}
