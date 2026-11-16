import type { DecodeResult, LayoutDocument, LayoutNode } from './model';
export function decodeDocument(input: unknown): DecodeResult {
    const bad = (): DecodeResult => ({ kind: 'corrupt', message: 'Повреждённая или слишком большая раскладка' });
    try {
        if (!input || typeof input !== 'object')
            return bad();
        const d = input as Record<string, unknown>;
        if (typeof d.version === 'number' && d.version > 1)
            return { kind: 'unsupported' };
        if (d.version !== 1 || !Number.isSafeInteger(d.revision) || (d.revision as number) < 0 || !Array.isArray(d.nodes))
            return bad();
        const ids = new Set<string>(), refs = new Set<string>(), seen = new Set<object>();
        const stack = d.nodes.map(n => ({ n, depth: 0 }));
        let count = 0;
        while (stack.length) {
            const { n, depth } = stack.pop()!;
            if (!n || typeof n !== 'object' || seen.has(n) || ++count > 4096)
                return bad();
            seen.add(n);
            if (typeof n.id !== 'string' || !n.id || n.id.length > 256 || ids.has(n.id) || typeof n.hidden !== 'boolean')
                return bad();
            ids.add(n.id);
            if (n.kind === 'group') {
                if (depth >= 64 || typeof n.name !== 'string' || !n.name.trim() || [...n.name.trim()].length > 80 || typeof n.icon !== 'string' || !n.icon || n.icon.length > 80 || !Array.isArray(n.children))
                    return bad();
                stack.push(...n.children.map((c: unknown) => ({ n: c, depth: depth + 1 })));
            }
            else if (n.kind === 'item') {
                if (typeof n.itemId !== 'string' || !n.itemId || n.itemId.length > 256 || refs.has(n.itemId))
                    return bad();
                refs.add(n.itemId);
            }
            else if (n.kind !== 'separator')
                return bad();
        }
        const raw = JSON.stringify(input);
        if (new TextEncoder().encode(raw).length > 262144)
            return bad();
        function clean(nodes: LayoutNode[]): LayoutNode[] { return nodes.map(n => n.kind === 'group' ? { kind: n.kind, id: n.id, hidden: n.hidden, name: n.name.trim(), icon: n.icon, children: clean(n.children) } : n.kind === 'item' ? { kind: n.kind, id: n.id, hidden: n.hidden, itemId: n.itemId } : { kind: n.kind, id: n.id, hidden: n.hidden }); }
        return { kind: 'valid', document: { version: 1, revision: d.revision as number, nodes: clean(d.nodes as LayoutNode[]) } };
    }
    catch {
        return bad();
    }
}
