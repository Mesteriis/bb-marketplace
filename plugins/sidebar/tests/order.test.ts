import { expect, test } from 'vitest';
import { buildProjectTree } from '../src/core/tree';
const thread = (id: string, projectId: string, time: number, isPinned = false) => ({ id, projectId, title: id, titleFallback: null, parentThreadId: null, isArchived: false, isPinned, latestAttentionAt: time });
test('recent project outranks alphabetically earlier project; empty projects follow', () => {
    const tree = buildProjectTree({ projects: [{ id: 'a', name: 'Alpha', path: null }, { id: 'z', name: 'Zulu', path: null }, { id: 'e', name: 'Empty', path: null }], threads: [thread('old', 'a', 100), thread('yesterday', 'z', 200, true)] });
    expect(tree.unrooted.map(n => n.project?.id)).toEqual(['z', 'a', 'e']);
});
test('folders and their children sort by newest activity, ties alphabetically', () => {
    const tree = buildProjectTree({ projects: [{ id: 'a', name: 'Alpha', path: '/aaa/Alpha' }, { id: 'z', name: 'Zulu', path: '/personal/Zulu' }, { id: 'b', name: 'Beta', path: '/personal/Beta' }], threads: [thread('old', 'a', 100), thread('new', 'z', 200), thread('tie', 'b', 200)] });
    expect(tree.roots.map(n => n.label)).toEqual(['personal', 'aaa/Alpha']);
    expect(tree.roots[0]?.children.map(n => n.project?.id)).toEqual(['b', 'z']);
});
