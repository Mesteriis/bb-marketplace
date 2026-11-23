import {z} from 'zod';

const timestamp = z.number().finite().nonnegative();
const counts = z.object({parent: z.number().int().nonnegative(), child: z.number().int().nonnegative()});
export const overviewGroups = ['unarchivedVisible', 'unarchivedHidden', 'archivedVisible', 'archivedHidden'] as const;

export const projectOverviewSchema = z.object({
    capturedAt: timestamp,
    project: z.object({
        id: z.string(), name: z.string(), kind: z.literal('standard'), gitRemoteUrl: z.string().nullable(),
        createdAt: timestamp, updatedAt: timestamp,
        sources: z.array(z.object({
            id: z.string(), type: z.literal('local_path'), path: z.string(), isDefault: z.boolean(),
            createdAt: timestamp, updatedAt: timestamp,
        })),
    }),
    groups: z.object({
        unarchivedVisible: counts, unarchivedHidden: counts, archivedVisible: counts, archivedHidden: counts,
    }),
    threads: z.array(z.object({
        id: z.string(), title: z.string().nullable(), status: z.string(), visibility: z.literal('visible'),
        providerId: z.string(), createdAt: timestamp, updatedAt: timestamp, hasPendingInteraction: z.boolean(),
    })).max(8),
});
export type ProjectOverviewData = z.infer<typeof projectOverviewSchema>;

export function overviewTotals(groups: ProjectOverviewData['groups']) {
    const sum = (group: z.infer<typeof counts>) => group.parent + group.child;
    const archived = sum(groups.archivedVisible) + sum(groups.archivedHidden);
    const unarchived = sum(groups.unarchivedVisible) + sum(groups.unarchivedHidden);
    const visible = sum(groups.archivedVisible) + sum(groups.unarchivedVisible);
    const hidden = sum(groups.archivedHidden) + sum(groups.unarchivedHidden);
    const parent = overviewGroups.reduce((total, key) => total + groups[key].parent, 0);
    const total = archived + unarchived;
    return {
        total, archived, unarchived, visible, hidden, parent, child: total - parent,
        unarchivedVisible: sum(groups.unarchivedVisible), sidebarParents: groups.unarchivedVisible.parent,
    };
}
