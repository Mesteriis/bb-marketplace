import type {useSdk} from '@get-bb/plugin-sdk/app';
import {z} from 'zod';
import type {WorktreeIssue} from '../../core/project-worktrees';

type Sdk = ReturnType<typeof useSdk>;
type Environment = Awaited<ReturnType<Sdk['environments']['list']>>[number];
const pageSize = 100;
const mainRef = 'refs/heads/main';

const gitStatus = z.discriminatedUnion('outcome', [
    z.object({outcome: z.literal('available'), workspace: z.object({
        workingTree: z.object({fileCount: z.number().int().nonnegative(), hasUncommittedChanges: z.boolean()}),
        branch: z.object({currentBranch: z.string().nullable()}),
        mergeBase: z.object({
            mergeBaseBranch: z.string(),
            baseRef: z.string().nullable(),
            aheadCount: z.number().int().nonnegative(),
            squashMergeCheckComplete: z.boolean(),
            hasCommittedUnmergedChanges: z.boolean(),
        }).nullable(),
    })}),
    z.object({outcome: z.enum(['not_applicable', 'unavailable', 'failed'])}),
]);

async function inspectWorktree(sdk: Sdk, environment: Environment): Promise<WorktreeIssue | null> {
    const worktree = {id: environment.id, name: environment.name || environment.branchName || environment.id,
        branch: environment.branchName};
    const unverified = {kind: 'unverified', ...worktree} as const;
    try {
        const response = await sdk.plugins.callRpc({
            pluginId: 'bb--git', method: 'workspaceStatus',
            input: {environmentId: environment.id, mergeBaseBranch: mainRef},
            outputSchema: gitStatus,
        });
        if (response.outcome !== 'available') return unverified;
        const {workingTree, mergeBase, branch} = response.workspace;
        if (!mergeBase?.baseRef || mergeBase.mergeBaseBranch !== mainRef) return unverified;

        const dirty = workingTree.hasUncommittedChanges || workingTree.fileCount > 0;
        const committed = mergeBase.hasCommittedUnmergedChanges ||
            (mergeBase.aheadCount > 0 && !mergeBase.squashMergeCheckComplete);
        return dirty || committed
            ? {...worktree, branch: branch.currentBranch, kind: 'unmerged', dirty, committed}
            : null;
    } catch {
        return unverified;
    }
}

export async function checkProjectWorktrees(sdk: Sdk, projectId: string): Promise<WorktreeIssue[]> {
    const seen = new Set<string>();
    const worktrees: Environment[] = [];
    for (let offset = 0; ; offset += pageSize) {
        const page = await sdk.environments.list({projectId, limit: pageSize, offset}).catch(() => {
            throw new Error('Не удалось получить рабочие окружения проекта.');
        });
        for (const environment of page) {
            if (environment.projectId !== projectId || seen.has(environment.id)) {
                throw new Error('Список рабочих окружений изменился. Повторите проверку.');
            }
            seen.add(environment.id);
            if (environment.status === 'destroyed' || environment.lifecycle.phase === 'destroyed' ||
                environment.hostLifecycle === 'removed') continue;
            if (environment.isWorktree || environment.workspaceProvisionType === 'managed-worktree' ||
                environment.environmentProviderId === 'git-worktree') worktrees.push(environment);
        }
        if (page.length < pageSize) break;
    }

    const issues: WorktreeIssue[] = [];
    // Limit concurrent Git reads, including for projects with many remote worktrees.
    const batchSize = 4;
    for (let index = 0; index < worktrees.length; index += batchSize) {
        const results = await Promise.all(worktrees.slice(index, index + batchSize)
            .map(environment => inspectWorktree(sdk, environment)));
        for (const result of results) if (result) issues.push(result);
    }
    return issues;
}

export function mergeWorktreePrompt() {
    return [
        'Проверь в выбранном рабочем дереве, какие изменения ещё отсутствуют в локальной ветке main.',
        'Проверь незакоммиченные и неотслеживаемые файлы. Если их принадлежность или назначение неясны, сначала уточни у меня, что включать.',
        'Сохрани нужные изменения и выполни локальное слияние в main по правилам репозитория. При риске потерять данные или при неоднозначном конфликте остановись и задай вопрос.',
        'Проверь результат слияния и сообщи, что попало в main и какие проверки прошли. Не выполняй push, удаление проекта или рабочего дерева и архивацию тредов.',
    ].join('\n');
}
