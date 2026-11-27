import { z } from "zod";

/** Where a thread sits in the diff now (`placeThread`), as the app receives it. */
export const placementSchema = z.discriminatedUnion("state", [
  z.object({state: z.enum(["anchored", "moved"]), startLine: z.number().int(), endLine: z.number().int()}),
  z.object({state: z.literal("outdated")}),
]);
