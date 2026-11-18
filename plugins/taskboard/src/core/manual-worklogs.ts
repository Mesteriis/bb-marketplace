import { z } from "zod";
import { idSchema } from "./model.ts";
import { DomainError } from "./errors.ts";
import type { LifecycleDeps, TimeEntry } from "./lifecycle.ts";

export const prepareWorklogSchema = z.object({
  taskId: idSchema,
  entryId: idSchema.optional(),
  durationSeconds: z.number().int().min(1).max(31_536_000),
  comment: z.string().max(4000),
}).strict();

/** Standalone entries use their own id as the unique submission correlation.
 * No development run, thread, status transition or remote write is created. */
export function prepareWorklog(input: z.infer<typeof prepareWorklogSchema>, deps: LifecycleDeps): TimeEntry {
  const parsed = prepareWorklogSchema.parse(input);
  if (deps.store.getTask(parsed.taskId) === null) throw new DomainError("not_found", "Task not found");
  const id = parsed.entryId ?? deps.idgen.newId();
  if (deps.lifecycle.getRun(id) !== null) throw new DomainError("conflict", "Entry id is already used by a development run");
  const existing = deps.lifecycle.getTimeEntry(id);
  if (existing !== null) {
    if (existing.taskId !== parsed.taskId || existing.durationSeconds !== parsed.durationSeconds || existing.comment !== parsed.comment) {
      throw new DomainError("conflict", "This entry id already identifies another time submission");
    }
    return existing;
  }
  const entry: TimeEntry = { id, runId: id, taskId: parsed.taskId, state: "pending", durationSeconds: parsed.durationSeconds, comment: parsed.comment, createdAtIso: deps.clock.now().toISOString(), submittedAtIso: null };
  deps.lifecycle.saveTimeEntry(entry);
  return entry;
}
