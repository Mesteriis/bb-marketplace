export interface Hidden {
    projects: string[];
    threads: string[];
    catalogProjects?: string[];
}
export function parseHidden(raw: string | null): Hidden {
    try {
        const value: unknown = JSON.parse(raw ?? 'null');
        const ids = (v: unknown): string[] => Array.isArray(v) ? [...new Set(v.filter((id): id is string => typeof id === 'string'))] : [];
        if (!value || typeof value !== 'object')
            return { projects: [], threads: [] };
        const object = value as Record<string, unknown>;
        return {
            projects: ids(object.projects),
            threads: ids(object.threads),
            ...(Array.isArray(object.catalogProjects) ? {catalogProjects: ids(object.catalogProjects)} : {}),
        };
    }
    catch {
        return { projects: [], threads: [] };
    }
}
export function toggleHidden(hidden: Hidden, kind: keyof Hidden, id: string): Hidden {
    const current = hidden[kind] ?? hidden.projects;
    return { ...hidden, [kind]: current.includes(id) ? current.filter(value => value !== id) : [...current, id] };
}
export function visibleItems<P extends {
    id: string;
}, T extends {
    id: string;
    projectId: string;
    isHidden: boolean;
}>(projects: readonly P[], threads: readonly T[], hidden: Hidden, show: boolean) {
    return { projects: projects.filter(p => show || !hidden.projects.includes(p.id)), threads: threads.filter(t => !t.isHidden && (show || (!hidden.threads.includes(t.id) && !hidden.projects.includes(t.projectId)))) };
}
