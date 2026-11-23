import {isRunning} from '../core/presentation';
import type {CatalogThread} from '../core/project-catalog';
import {Glyph} from './glyph';

function threadStatus(thread: CatalogThread) {
    if (thread.hasPendingInteraction || thread.planAttention === 'needs_input') return {text: 'Ждёт ответа', tone: 'waiting'};
    if (thread.status === 'error' || thread.planAttention === 'error') return {text: 'Ошибка', tone: 'failed'};
    if (thread.status === 'stopping') return {text: 'Останавливается', tone: 'running'};
    if (isRunning(thread)) return {text: 'В работе', tone: 'running'};
    if (thread.isUnread) return {text: 'Новый ответ', tone: 'unread'};
    return {text: 'Нет активности', tone: 'muted'};
}

export function CatalogThreads({label, threads, activeThreadId, onOpen}: {
    label: string;
    threads: readonly CatalogThread[];
    activeThreadId: string | null;
    onOpen: (id: string, split: boolean) => void;
}) {
    if (!threads.length) return <p className="catalog-empty" role="status">Нет неархивных тредов.</p>;
    const sorted = [...threads].sort((a, b) => b.latestAttentionAt - a.latestAttentionAt);
    return <ul className="catalog-threads" aria-label={label}>
        {sorted.map(thread => {
            const status = threadStatus(thread);
            return <li key={thread.id} className="catalog-thread">
                <a href={thread.href} aria-current={thread.id === activeThreadId ? 'page' : undefined}
                    onClick={event => {
                        if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
                        event.preventDefault();
                        onOpen(thread.id, false);
                    }}>
                    <span className="catalog-thread-title" title={thread.displayTitle}>{thread.displayTitle}</span>
                    <span className={`catalog-thread-status ${status.tone}`}>{status.text}</span>
                </a>
                <button type="button" className="catalog-split" aria-label={`Открыть рядом: ${thread.displayTitle}`}
                    title="Открыть рядом" onClick={() => onOpen(thread.id, true)}><Glyph kind="split"/></button>
            </li>;
        })}
    </ul>;
}
