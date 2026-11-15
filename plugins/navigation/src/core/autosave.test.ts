import { expect, it } from 'vitest';
import { Autosave } from './autosave';
it('serializes changes made during a save using the confirmed revision', async () => {
    const calls: number[] = [];
    let finish!: (n: number) => void;
    const q = new Autosave(0, async (_nodes, revision) => { calls.push(revision); return new Promise<number>(r => finish = r); });
    q.edit([]);
    q.edit([]);
    expect(calls).toEqual([0]);
    finish(1);
    await new Promise(r => setTimeout(r, 0));
    expect(calls).toEqual([0, 1]);
    finish(2);
    await new Promise(r => setTimeout(r, 0));
    expect(q.state).toBe('saved');
});
it('retains the draft and stops writing after an error', async () => {
    const q = new Autosave(0, async () => { throw Error('Conflict'); });
    q.edit([]);
    await new Promise(r => setTimeout(r, 0));
    expect(q.state).toBe('error');
    expect(q.draft).toEqual([]);
});
