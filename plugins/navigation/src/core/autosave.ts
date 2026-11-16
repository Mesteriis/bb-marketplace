import type { LayoutNode } from './model';
export class Autosave {
    state: 'saved' | 'saving' | 'error' = 'saved';
    draft: LayoutNode[] | null = null;
    error = '';
    private pending: LayoutNode[] | null = null;
    constructor(public revision: number, private write: (nodes: LayoutNode[], revision: number) => Promise<number>, private changed: () => void = () => { }) { }
    edit(nodes: LayoutNode[]) { this.draft = nodes; this.pending = nodes; if (this.state !== 'error' && this.state !== 'saving')
        void this.flush(); this.changed(); }
    retry(revision: number) { this.revision = revision; this.state = 'saved'; if (this.pending)
        void this.flush(); }
    private async flush() { this.state = 'saving'; this.changed(); try {
        while (this.pending) {
            const nodes = this.pending;
            this.pending = null;
            this.revision = await this.write(nodes, this.revision);
        }
        this.state = 'saved';
        this.draft = null;
    }
    catch (e) {
        this.pending = this.draft;
        this.state = 'error';
        this.error = e instanceof Error ? e.message : 'Ошибка записи';
    } this.changed(); }
}
