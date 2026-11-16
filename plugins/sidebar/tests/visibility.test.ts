import { expect, test } from 'vitest';
import { visibleItems, parseHidden, toggleHidden } from '../src/core/visibility';
const projects = [{ id: 'p1' }, { id: 'p2' }];
const threads = [{ id: 't1', projectId: 'p1', isHidden: false }, { id: 't2', projectId: 'p2', isHidden: false }, { id: 'internal', projectId: 'p2', isHidden: true }];
test('hidden projects also remove their pinned or ordinary threads', () => {
    expect(visibleItems(projects, threads, { projects: ['p1'], threads: [] }, false)).toEqual({ projects: [{ id: 'p2' }], threads: [threads[1]] });
});
test('show hidden restores user-hidden entries but excludes host helper threads', () => {
    expect(visibleItems(projects, threads, { projects: ['p1'], threads: ['t2'] }, true)).toEqual({ projects, threads: threads.slice(0, 2) });
});
test('hiding a thread preserves its project and restoring is reversible', () => {
    const hidden = toggleHidden({ projects: [], threads: [] }, 'threads', 't1');
    expect(visibleItems(projects, threads, hidden, false).threads).toEqual([threads[1]]);
    expect(toggleHidden(hidden, 'threads', 't1')).toEqual({ projects: [], threads: [] });
});
test('malformed stored preferences recover safely and IDs are deduplicated', () => {
    expect(parseHidden('{')).toEqual({ projects: [], threads: [] });
    expect(parseHidden('{"projects":["p1",1,"p1"],"threads":null}')).toEqual({ projects: ['p1'], threads: [] });
});
