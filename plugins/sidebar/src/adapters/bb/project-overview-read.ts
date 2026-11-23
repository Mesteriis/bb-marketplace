import type {BbPluginApi} from '@get-bb/plugin-sdk';
import type {ProjectOverviewData} from '../../core/project-overview';

type Sdk = BbPluginApi['sdk'];
type ThreadRow = Awaited<ReturnType<Sdk['threads']['list']>>[number];
const PAGE_SIZE = 100;

async function readThreads(sdk: Sdk, projectId: string, archived: boolean) {
    const unique = new Map<string, ThreadRow>();
    for (let offset = 0; ; offset += PAGE_SIZE) {
        const rows = await sdk.threads.list({projectId, archived, includeHidden: true, limit: PAGE_SIZE, offset});
        if (rows.some(row => row.projectId !== projectId || (row.archivedAt != null) !== archived)) {
            throw new Error('Unexpected project thread page');
        }
        const previousSize = unique.size;
        for (const row of rows) unique.set(row.id, row);
        if (rows.length < PAGE_SIZE) return [...unique.values()];
        if (unique.size === previousSize) throw new Error('Project thread pagination did not advance');
    }
}

function displayRemote(value: string | null) {
    if (!value) return null;
    if (/^git@[\w.-]+:[\w./-]+$/.test(value)) return value;
    try {
        const url = new URL(value);
        if (!['https:', 'http:', 'ssh:', 'git:'].includes(url.protocol)) return null;
        url.username = '';
        url.password = '';
        url.search = '';
        url.hash = '';
        return url.toString();
    } catch {
        return null;
    }
}

export async function readProjectOverview(sdk: Sdk, projectId: string): Promise<ProjectOverviewData> {
    const project = await sdk.projects.get({projectId});
    if (project.kind !== 'standard' || project.id !== projectId) throw new Error('Standard project not found');
    const [active, archived] = await Promise.all([readThreads(sdk, projectId, false), readThreads(sdk, projectId, true)]);
    // A thread can move into the archive while the two lists are read.
    const rows = new Map([...active, ...archived].map(row => [row.id, row]));
    const groups: ProjectOverviewData['groups'] = {
        unarchivedVisible: {parent: 0, child: 0}, unarchivedHidden: {parent: 0, child: 0},
        archivedVisible: {parent: 0, child: 0}, archivedHidden: {parent: 0, child: 0},
    };
    const sample: ThreadRow[] = [];
    for (const row of rows.values()) {
        if (row.deletedAt != null) continue;
        const archive = row.archivedAt == null ? 'unarchived' : 'archived';
        const visibility = row.visibility === 'visible' ? 'Visible' : 'Hidden';
        groups[`${archive}${visibility}`][row.parentThreadId == null ? 'parent' : 'child']++;
        if (archive === 'unarchived' && row.visibility === 'visible') sample.push(row);
    }
    return {
        capturedAt: Date.now(),
        project: {
            id: project.id, name: project.name, kind: project.kind, gitRemoteUrl: displayRemote(project.gitRemoteUrl),
            createdAt: project.createdAt, updatedAt: project.updatedAt,
            sources: project.sources.map(({id, type, path, isDefault, createdAt, updatedAt}) =>
                ({id, type, path, isDefault, createdAt, updatedAt})),
        },
        groups,
        threads: sample.sort((a, b) => b.latestAttentionAt - a.latestAttentionAt).slice(0, 8).map(row => ({
            id: row.id, title: row.title ?? row.titleFallback, status: row.status, visibility: 'visible',
            providerId: row.providerId, createdAt: row.createdAt, updatedAt: row.updatedAt,
            hasPendingInteraction: row.hasPendingInteraction,
        })),
    };
}
