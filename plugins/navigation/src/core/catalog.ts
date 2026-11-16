import type { LayoutDocument, LayoutNode } from './model';
export interface CatalogEntry {
    id: string;
    label: string;
    isVisible: boolean;
}
export function reconcileCatalog(document: LayoutDocument, entries: readonly CatalogEntry[]): LayoutDocument {
    const seen = new Set<string>();
    function visit(nodes: LayoutNode[]) { for (const n of nodes) {
        if (n.kind === 'item')
            seen.add(n.itemId);
        else if (n.kind === 'group')
            visit(n.children);
    } }
    visit(document.nodes);
    const ids = new Set<string>();
    function collect(nodes: LayoutNode[]) { for (const n of nodes) {
        ids.add(n.id);
        if (n.kind === 'group')
            collect(n.children);
    } }
    collect(document.nodes);
    const nodes = structuredClone(document.nodes);
    for (const e of entries) {
        if (seen.has(e.id) || e.id === '__bb__/new-thread')
            continue;
        let id = 'item:' + e.id;
        while (ids.has(id))
            id += ':';
        ids.add(id);
        seen.add(e.id);
        nodes.push({ kind: 'item', id, itemId: e.id, hidden: !e.isVisible });
    }
    return { ...document, nodes };
}
export function presentLayout(nodes: LayoutNode[], available: readonly string[]): LayoutNode[] {
    const ids = new Set(available), result: LayoutNode[] = [];
    for (const n of nodes) {
        if (n.hidden || (n.kind === 'item' && !ids.has(n.itemId)))
            continue;
        if (n.kind === 'separator' && (!result.length || result.at(-1)?.kind === 'separator'))
            continue;
        result.push(n.kind === 'group' ? { ...n, children: presentLayout(n.children, available) } : { ...n });
    }
    if (result.at(-1)?.kind === 'separator')
        result.pop();
    return result;
}
