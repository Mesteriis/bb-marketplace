import type {BbPluginApi} from '@get-bb/plugin-sdk';
import {activityDays, readTokenDelta, tokenUsageEvent, utcDay} from '../../core/project-activity';
import {readProjectThreads} from './project-overview-read';

type Sdk = BbPluginApi['sdk'];
const pageSize = 100;
const concurrency = 6;

async function readRecentUsage(
    sdk: Sdk, threadId: string, start: number,
    record: (createdAt: number, data: unknown) => void,
) {
    let beforeSeq: number | undefined;
    for (;;) {
        const rows = await sdk.threads.events.list({
            threadId, types: [tokenUsageEvent], order: 'desc', limit: String(pageSize),
            ...(beforeSeq === undefined ? {} : {beforeSeq: String(beforeSeq)}),
        });
        for (const row of rows) {
            if (row.type === tokenUsageEvent && row.createdAt >= start) record(row.createdAt, row.data);
        }
        if (rows.length < pageSize || rows.some(row => row.createdAt < start)) return;
        const oldest = rows[rows.length - 1].seq;
        if (beforeSeq !== undefined && oldest >= beforeSeq) throw new Error('Token event pagination did not advance');
        beforeSeq = oldest;
    }
}

export async function readProjectActivity(sdk: Sdk, projectId: string) {
    const now = Date.now();
    const project = await sdk.projects.get({projectId});
    if (project.id !== projectId || project.kind !== 'standard') throw new Error('Standard project not found');
    const days = activityDays(now);
    const start = Date.parse(days[0].day);
    const byDay = new Map(days.map(day => [day.day, day]));
    const threads = await readProjectThreads(sdk, projectId);
    const dayFor = (timestamp: number) => timestamp >= start && timestamp <= now
        ? byDay.get(utcDay(timestamp)) : undefined;

    for (const thread of threads) {
        const created = dayFor(thread.createdAt);
        const archived = thread.archivedAt == null ? undefined : dayFor(thread.archivedAt);
        if (created) created.created++;
        if (archived) archived.archived++;
    }
    const record = (timestamp: number, payload: unknown) => {
        const day = dayFor(timestamp);
        const delta = readTokenDelta(payload);
        if (!day || !delta) return;
        day.input += delta.input;
        day.output += delta.output;
        day.cached += delta.cached;
        day.samples++;
    };
    for (let offset = 0; offset < threads.length; offset += concurrency) {
        await Promise.all(threads.slice(offset, offset + concurrency).map(thread => readRecentUsage(sdk, thread.id, start, record)));
    }
    return {days};
}
