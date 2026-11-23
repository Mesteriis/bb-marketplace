import {z} from 'zod';

const count = z.number().int().nonnegative();
export const activityDayCount = 14;
export const projectActivitySchema = z.object({
    days: z.array(z.object({
        day: z.iso.date(),
        input: count,
        output: count,
        cached: count,
        samples: count,
        created: count,
        archived: count,
    })).length(activityDayCount),
});
export type ProjectActivity = z.infer<typeof projectActivitySchema>;

export const tokenUsageEvent = 'thread/tokenUsage/updated';
const tokenUsage = z.object({
    tokenUsage: z.object({
        last: z.object({
            totalTokens: count,
            outputTokens: count,
            cachedInputTokens: count.optional(),
            cacheReadInputTokens: count.optional(),
        }),
    }),
});

export function readTokenDelta(data: unknown) {
    const parsed = tokenUsage.safeParse(data);
    if (!parsed.success) return null;
    const last = parsed.data.tokenUsage.last;
    // Both provider formats count cache reads inside the total.
    const output = Math.min(last.outputTokens, last.totalTokens);
    const input = last.totalTokens - output;
    const cached = Math.min(last.cacheReadInputTokens ?? last.cachedInputTokens ?? 0, input);
    return {input, output, cached};
}

export function activityDays(now: number): ProjectActivity['days'] {
    const date = new Date(now);
    date.setUTCHours(0, 0, 0, 0);
    date.setUTCDate(date.getUTCDate() - activityDayCount + 1);
    return Array.from({length: activityDayCount}, () => {
        const day = utcDay(date.getTime());
        date.setUTCDate(date.getUTCDate() + 1);
        return {day, input: 0, output: 0, cached: 0, samples: 0, created: 0, archived: 0};
    });
}

export function utcDay(timestamp: number) {
    return new Date(timestamp).toISOString().slice(0, 10);
}
