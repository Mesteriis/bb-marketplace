// Adapted from plugins/github-actions/workflows.ts (MIT, © 2026 pers0na2dev): takes an already parsed workflow
// document instead of YAML text, so the core needs no YAML parser.
import { z } from "zod";

export const dispatchInput = z.object({
  name: z.string(), description: z.string().nullable(), required: z.boolean(),
  type: z.enum(["string", "choice", "boolean", "number", "environment"]), default: z.string().nullable(), options: z.array(z.string()),
});
export type DispatchInput = z.infer<typeof dispatchInput>;
export const dispatchSpecSchema = z.object({dispatchable: z.boolean(), inputs: z.array(dispatchInput)});
export type DispatchSpec = z.infer<typeof dispatchSpecSchema>;

const none: DispatchSpec = {dispatchable: false, inputs: []};
const scalar = (value: unknown) => value === null || value === undefined || typeof value === "object" ? null : String(value);
const record = (value: unknown) => typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;

/** The `workflow_dispatch` trigger of a parsed workflow (GitHub and Gitea Actions syntax). */
export function dispatchSpec(document: unknown): DispatchSpec {
  const doc = record(document);
  if (!doc) return none;
  // YAML 1.1 readers turn a bare `on:` key into `true`.
  const on = doc.on ?? doc.true;
  if (on === "workflow_dispatch") return {dispatchable: true, inputs: []};
  if (Array.isArray(on)) return on.includes("workflow_dispatch") ? {dispatchable: true, inputs: []} : none;
  const triggers = record(on);
  if (!triggers || !("workflow_dispatch" in triggers)) return none;
  const inputs = record(record(triggers.workflow_dispatch)?.inputs);
  if (!inputs) return {dispatchable: true, inputs: []};
  return {dispatchable: true, inputs: Object.entries(inputs).map(([name, raw]) => {
    const spec = record(raw) ?? {};
    const declared = dispatchInput.shape.type.safeParse(scalar(spec.type));
    return {
      name, description: scalar(spec.description), required: spec.required === true,
      type: declared.success ? declared.data : "string", default: scalar(spec.default),
      options: Array.isArray(spec.options) ? spec.options.map(option => String(option)) : [],
    };
  })};
}
