import type Database from 'better-sqlite3';
import { decodeDocument } from '../../core/document';
import type { LayoutDocument } from '../../core/model';
export function createLayoutStore(db: Database.Database) {
    db.exec('CREATE TABLE IF NOT EXISTS layout (id INTEGER PRIMARY KEY CHECK(id=1), document TEXT NOT NULL)');
    function read() {
        const row = db.prepare('SELECT document FROM layout WHERE id=1').get() as {
            document: string;
        } | undefined;
        if (!row)
            return { kind: 'empty' as const };
        try {
            return decodeDocument(JSON.parse(row.document));
        }
        catch {
            return { kind: 'corrupt' as const, message: 'Раскладка повреждена' };
        }
    }
    const save = db.transaction((document: LayoutDocument, expectedRevision: number) => {
        const parsed = decodeDocument(document);
        if (parsed.kind !== 'valid')
            throw new Error('Невалидная раскладка');
        const current = read();
        if (current.kind === 'corrupt' || current.kind === 'unsupported')
            throw new Error('Восстановление раскладки требует явного сброса');
        const revision = current.kind === 'empty' ? 0 : current.document.revision;
        if (revision !== expectedRevision)
            return { kind: 'conflict' as const, revision };
        const next = { ...parsed.document, revision: revision + 1 };
        db.prepare('INSERT INTO layout(id,document) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET document=excluded.document').run(JSON.stringify(next));
        return { kind: 'saved' as const, document: next };
    });
    return { read, save };
}
