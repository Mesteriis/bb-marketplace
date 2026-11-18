// Helper wire messages for the helper-owned known_hosts overlay (stage 3c-2). Lines and host names only: no
// message carries a path, because the helper alone decides where the overlay is.
import { z } from "zod";

const idSchema = z.number().int().min(0);

export const knownHostsListRequestSchema = z.object({ type: z.literal("known_hosts.list"), id: idSchema });
export const knownHostsAddRequestSchema = z.object({
  type: z.literal("known_hosts.add"),
  id: idSchema,
  lines: z.array(z.string().min(1).max(4096)).max(2000),
});
export const knownHostsRemoveRequestSchema = z.object({ type: z.literal("known_hosts.remove"), id: idSchema, host: z.string().min(1).max(255) });
export const knownHostsLinesSchema = z.object({ type: z.literal("known_hosts.lines"), id: idSchema, lines: z.array(z.string()) });
export const knownHostsDoneSchema = z.object({ type: z.literal("known_hosts.done"), id: idSchema, count: z.number().int().min(0) });

export const knownHostsRequestSchemas = [knownHostsListRequestSchema, knownHostsAddRequestSchema, knownHostsRemoveRequestSchema] as const;
export const knownHostsResponseSchemas = [knownHostsLinesSchema, knownHostsDoneSchema] as const;
