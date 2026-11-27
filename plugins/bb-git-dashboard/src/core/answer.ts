import { z } from "zod";
import { failure } from "./workspace.ts";

/** The plugin's RPC answer: a failure with a code, or the value with `ok: true`. */
export const answer = <T extends z.ZodRawShape>(shape: T) => z.discriminatedUnion("ok", [failure, z.object({ok: z.literal(true), ...shape})]);
