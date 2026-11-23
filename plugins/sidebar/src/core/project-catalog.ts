import {isRunning} from './presentation';
import type {ProjectLocation, ThreadNode} from './tree';

export type CatalogProject = ProjectLocation & {isPersonal: boolean; href: string};
export type CatalogThread = ThreadNode['thread'] & {isHidden: boolean};
export type CatalogSort = 'activity' | 'name';

function pathKey(path: string) {
    return path.trim().replace(/\\/g, '/').replace(/\/+$/, '');
}

export function buildCatalog(
    projects: readonly CatalogProject[],
    threads: readonly CatalogThread[],
    rootPath: string,
    hiddenIds: readonly string[],
) {
    const root = pathKey(rootPath);
    const hidden = new Set(hiddenIds);
    const liveByProject = new Map<string, CatalogThread[]>();
    for (const thread of threads) {
        if (thread.isArchived || thread.isHidden) continue;
        const live = liveByProject.get(thread.projectId);
        if (live) live.push(thread);
        else liveByProject.set(thread.projectId, [thread]);
    }

    return projects.flatMap(project => {
        const path = project.path ? pathKey(project.path) : '';
        if (project.isPersonal || (root && path !== root && !path.startsWith(root + '/'))) return [];
        const relative = root ? path.slice(root.length + 1) : path.replace(/^\/+/, '');
        const folders = relative.split('/').slice(0, -1);
        const live = liveByProject.get(project.id) ?? [];
        return [{
            ...project,
            scope: root ? folders[0] ?? '' : '',
            folder: folders.join(' / '),
            hidden: hidden.has(project.id),
            empty: live.length === 0,
            attentionAt: live.reduce((latest, thread) => Math.max(latest, thread.latestAttentionAt), 0),
            waiting: live.some(thread => thread.hasPendingInteraction || thread.planAttention === 'needs_input'),
            failed: live.some(thread => thread.status === 'error' || thread.planAttention === 'error'),
            running: live.filter(isRunning).length,
            unread: live.filter(thread => thread.isUnread).length,
        }];
    });
}

export type CatalogRow = ReturnType<typeof buildCatalog>[number];

export function filterCatalog(rows: readonly CatalogRow[], options: {
    query: string;
    scope: string;
    sort: CatalogSort;
    showHidden: boolean;
    showEmpty: boolean;
}) {
    const term = options.query.trim().toLocaleLowerCase().replace(/\s*[/\\]\s*/g, '/');
    return rows.filter(row =>
        (row.hidden ? options.showHidden : !row.empty || options.showEmpty) &&
        (!options.scope || row.scope === options.scope) &&
        (!term || row.name.toLocaleLowerCase().includes(term) ||
            row.path?.toLocaleLowerCase().replace(/\\/g, '/').includes(term)),
    ).sort((a, b) =>
        (options.sort === 'activity' ? b.attentionAt - a.attentionAt : 0) ||
        a.name.localeCompare(b.name, undefined, {numeric: true}),
    );
}
