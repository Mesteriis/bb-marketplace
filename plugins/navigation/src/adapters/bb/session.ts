import type {ExperimentalSidebarNavigationIcon} from '@get-bb/plugin-sdk/app';
import { Autosave } from '../../core/autosave';
import { decodeDocument } from '../../core/document';
import { reconcileCatalog, type CatalogEntry } from '../../core/catalog';
import type { LayoutDocument, LayoutNode } from '../../core/model';
export function createSession() {
    let snapshot = { document: null as LayoutDocument | null, draft: null as LayoutNode[] | null, entries: [] as CatalogEntry[], icons: {} as Record<string,ExperimentalSidebarNavigationIcon>, status: 'Загрузка…', error: false };
    const listeners = new Set<() => void>();
    let queue: Autosave | null = null;
    let read: (() => Promise<unknown>) | null = null;
    let loading: Promise<void> | null = null;
    let reconnect: (() => void) | null = null;
    function emit() { snapshot = { ...snapshot }; for (const listener of listeners)
        listener(); }
    function accept(value: unknown) { if (!value || typeof value !== 'object')
        throw Error('Ошибка чтения раскладки'); const v = value as {
        kind: string;
        document?: unknown;
    }; if (v.kind === 'empty')
        return { version: 1 as const, revision: 0, nodes: [] }; if (v.kind === 'valid') {
        const d = decodeDocument(v.document);
        if (d.kind === 'valid')
            return d.document;
    } throw Error('Раскладка повреждена или использует новую версию. Запись отключена'); }
    const api = { subscribe: (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; }, getSnapshot: () => snapshot,
        connect(load: () => Promise<unknown>, save: (doc: LayoutDocument, revision: number) => Promise<unknown>): void { reconnect = () => api.connect(load,save); read = load; if (queue || loading)
            return; loading = (async () => { try {
            const loadedDocument = accept(await load());
            snapshot.document = loadedDocument;
            queue = new Autosave(snapshot.document.revision, async (nodes, revision) => { const parsed = decodeDocument({ version: 1, revision, nodes }); if (parsed.kind !== 'valid')
                throw Error('Проверьте названия и структуру'); const result = await save(parsed.document, revision) as {
                kind: string;
                document?: unknown;
            }; if (result.kind !== 'saved')
                throw Error('Раскладка изменена в другом окне. Черновик сохранён в этой сессии'); const decoded = decodeDocument(result.document); if (decoded.kind !== 'valid')
                throw Error('Не удалось подтвердить запись'); snapshot.document = decoded.document; return decoded.document.revision; }, () => { snapshot.status = queue?.state === 'saving' ? 'Сохранение…' : queue?.state === 'error' ? queue.error : 'Сохранено'; snapshot.error = queue?.state === 'error'; snapshot.draft = queue?.draft ?? null; emit(); });
            snapshot.status = 'Сохранено'; snapshot.error=false;
        }
        catch (e) {
            snapshot.status = String(e);
            snapshot.error = true;
        }
        finally {
            loading = null;
            emit();
        } })(); },
        catalog(entries: CatalogEntry[], icons:Record<string,ExperimentalSidebarNavigationIcon>={}) { snapshot.entries = entries; snapshot.icons=icons; emit(); },
        edit(nodes: LayoutNode[]) { if (!queue)
            return; const checked = decodeDocument({ version: 1, revision: queue.revision, nodes }); if (checked.kind !== 'valid') {
            snapshot.draft = nodes;
            snapshot.error = true;
            snapshot.status = 'Проверьте названия групп: от 1 до 80 символов';
            emit();
            return;
        } queue.edit(checked.document.nodes); },
        async refresh(): Promise<void> { if (!queue && reconnect) { reconnect(); if(loading) await loading; return; } if (!read || snapshot.draft)
            return; try {
            const doc = accept(await read());
            if (!queue || doc.revision >= queue.revision) {
                snapshot.document = doc; snapshot.error=false; snapshot.status='Сохранено';
                if (queue)
                    queue.revision = doc.revision;
                emit();
            }
        }
        catch (e) {
            snapshot.error = true;
            snapshot.status = String(e);
            emit();
        } },
        async retry() { if (!read || !queue)
            return; try {
            const doc = accept(await read());
            queue.retry(doc.revision);
        }
        catch (e) {
            snapshot.status = String(e);
            snapshot.error = true;
            emit();
        } },
        nodes() { return snapshot.draft ?? (snapshot.document ? reconcileCatalog(snapshot.document, snapshot.entries).nodes : []); }
    };
    return api;
}
