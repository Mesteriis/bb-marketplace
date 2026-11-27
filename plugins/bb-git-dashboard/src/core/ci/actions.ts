import { z } from "zod";

const id = z.string().min(1).max(200).regex(/^[^\s\0]+$/);
const ref = z.string().min(1).max(250).regex(/^[A-Za-z0-9_][A-Za-z0-9_.\/-]*$/);
export const ciAction = z.discriminatedUnion("kind", [
  z.object({kind: z.literal("dispatch"), workflowId: id, ref,
    inputs: z.record(z.string().max(100), z.string().max(4000)).refine(value => Object.keys(value).length <= 25)}),
  z.object({kind: z.literal("rerun"), runId: id, failedOnly: z.boolean()}),
  z.object({kind: z.literal("cancel"), runId: id}),
]);
export type CiAction = z.infer<typeof ciAction>;

/** Lines shown in the confirmation before a CI write. `target` names the workflow or the run. */
export function describeAction(action: CiAction, target: string): string[] {
  if (action.kind === "dispatch") {
    return ["Run workflow " + target + " on " + action.ref, ...Object.entries(action.inputs).map(([name, value]) => name + " = " + value)];
  }
  if (action.kind === "rerun") return [(action.failedOnly ? "Re-run failed jobs of " : "Re-run all jobs of ") + target];
  return ["Cancel " + target];
}
