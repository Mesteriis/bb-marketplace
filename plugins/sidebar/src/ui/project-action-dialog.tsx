import {useEffect, useId, useRef, useState} from 'react';
import type {WorktreeIssue} from '../core/project-worktrees';

export type ProjectAction = 'archive' | 'delete';
export type ProjectActionTarget = {action: ProjectAction; id: string; name: string};

export const projectActionLabels = [
    {action: 'archive', label: 'Архивировать все треды', icon: 'archive'},
    {action: 'delete', label: 'Удалить проект', icon: 'trash'},
] as const;

export function ProjectActionDialog({target, onRun, onPrepareMerge, onClose}: {
    target: ProjectActionTarget;
    onRun: (action: ProjectAction, id: string, acknowledged?: readonly WorktreeIssue[]) => Promise<WorktreeIssue[]>;
    onPrepareMerge: (projectId: string, environmentId: string) => void;
    onClose: () => void;
}) {
    const dialog = useRef<HTMLDialogElement>(null);
    const inFlight = useRef(false);
    const title = useId();
    const description = useId();
    const [pending, setPending] = useState(false);
    const [issues, setIssues] = useState<WorktreeIssue[]>([]);
    const [error, setError] = useState<string | null>(null);
    const hasDifferences = issues.some(issue => issue.kind === 'unmerged');
    const canProceedWithoutMerge = hasDifferences && issues.every(issue => issue.kind === 'unmerged');
    const deleting = target.action === 'delete';

    useEffect(() => {
        const element = dialog.current!;
        element.showModal();
        return () => element.close();
    }, []);

    function close() {
        if (inFlight.current) return;
        dialog.current?.close();
        onClose();
    }

    async function confirm(withoutMerge = false) {
        if (inFlight.current) return;
        inFlight.current = true;
        setPending(true);
        setError(null);
        try {
            const result = await onRun(target.action, target.id, withoutMerge ? issues : undefined);
            if (result.length) {
                setIssues(result);
                setPending(false);
                inFlight.current = false;
                return;
            }
        } catch (failure) {
            setError(failure instanceof Error && failure.message
                ? failure.message
                : deleting ? 'Не удалось удалить проект.' : 'Не удалось архивировать треды.');
            setPending(false);
            inFlight.current = false;
            return;
        }
        inFlight.current = false;
        close();
    }

    return <dialog ref={dialog} className="catalog-action-dialog" role="alertdialog" aria-modal="true"
        aria-labelledby={title} aria-describedby={description} onCancel={event => {
            event.preventDefault();
            close();
        }}>
        <h2 id={title}>{deleting ? 'Удалить проект?' : 'Архивировать все треды?'}</h2>
        <p id={description}>{deleting
            ? <>BB удалит проект <strong>{target.name}</strong> вместе со всеми его тредами, включая архивные.</>
            : <>BB архивирует все треды проекта <strong>{target.name}</strong>, включая скрытые и дочерние.</>}</p>
        {issues.length > 0 && <>
            <p role="status">{hasDifferences
                ? 'Есть изменения вне main. Подготовить слияние с ИИ? После слияния запустите проверку повторно.'
                : 'Не удалось закончить сверку рабочих деревьев с main.'}</p>
            <ul className="catalog-worktree-issues">
                {issues.map(issue => <li key={issue.id}>
                    <strong>{issue.name}</strong>{issue.branch && issue.branch !== issue.name && <> · {issue.branch}</>}
                    <div>{issue.kind === 'unverified' ? 'Не удалось проверить относительно main.'
                        : [issue.dirty && 'Незакоммиченные изменения', issue.committed && 'Изменения вне main'].filter(Boolean).join(' · ')}</div>
                    {issue.kind === 'unmerged' && <button type="button" disabled={pending} onClick={() => {
                        close();
                        onPrepareMerge(target.id, issue.id);
                    }}>Подготовить слияние с ИИ</button>}
                </li>)}
            </ul>
            {canProceedWithoutMerge && <p>Если продолжить без слияния, эти изменения останутся вне main.</p>}
        </>}
        {error && <p role="alert">{error}</p>}
        <div className="catalog-dialog-buttons">
            <button type="button" autoFocus disabled={pending} onClick={close}>Отмена</button>
            {canProceedWithoutMerge && <button type="button" className="catalog-destructive" disabled={pending}
                onClick={() => void confirm(true)}>Продолжить без слияния</button>}
            <button type="button" className={deleting ? 'catalog-destructive' : undefined} disabled={pending}
                onClick={() => void confirm()}>
                {pending ? 'Проверка и выполнение…' : issues.length ? (deleting ? 'Проверить и удалить' : 'Проверить и архивировать') : deleting ? 'Удалить проект' : 'Архивировать'}
            </button>
        </div>
    </dialog>;
}
