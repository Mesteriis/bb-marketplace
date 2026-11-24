import {useBbNavigate, useSdk} from '@get-bb/plugin-sdk/app';
import {toast} from 'sonner';
import type {WorktreeIssue} from '../../core/project-worktrees';
import type {ProjectAction} from '../../ui/project-action-dialog';
import {checkProjectWorktrees, mergeWorktreePrompt} from './project-worktrees';
import {readThreads} from './project-overview-read';

export function useProjectActions() {
    const sdk = useSdk();
    const navigate = useBbNavigate();

    async function run(action: ProjectAction, projectId: string, acknowledged: readonly WorktreeIssue[] = []) {
        const issues = await checkProjectWorktrees(sdk, projectId);
        if (issues.some(issue => issue.kind === 'unverified') ||
            (issues.length && JSON.stringify(issues) !== JSON.stringify(acknowledged))) return issues;
        if (action === 'delete') {
            await sdk.projects.delete({projectId}).catch(() => {
                throw new Error('Не удалось удалить проект.');
            });
            toast.success('Проект удалён');
            return [];
        }

        // Read all pages before archiving so mutations do not shift the offsets.
        const threads = await readThreads(sdk, projectId, false).catch(() => {
            throw new Error('Не удалось загрузить список тредов проекта.');
        });
        const targetIds = new Set(threads.filter(thread => thread.deletedAt == null).map(thread => thread.id));
        const archived = new Set<string>();
        let failed = 0;
        for (const threadId of targetIds) {
            if (archived.has(threadId)) continue;
            try {
                const result = await sdk.threads.archive({threadId});
                for (const id of result.archivedThreadIds) {
                    if (targetIds.has(id)) archived.add(id);
                }
            } catch {
                failed++;
            }
        }
        if (failed) throw new Error(`Архивировано: ${archived.size}. Не удалось архивировать: ${failed}.`);
        toast.success(archived.size ? `Архивировано тредов: ${archived.size}` : 'Все треды уже в архиве');
        return [];
    }

    function prepareMerge(projectId: string, environmentId: string) {
        navigate.toCompose({projectId, environmentId, initialPrompt: mergeWorktreePrompt(), focusPrompt: true});
    }

    return {run, prepareMerge};
}
