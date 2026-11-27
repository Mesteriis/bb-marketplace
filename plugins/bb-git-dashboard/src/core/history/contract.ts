import { z } from "zod";
import { answer } from "../answer.ts";
import { id } from "../workspace.ts";
import { commitDetails, historyPage } from "./model.ts";

const path = z.string().min(1).max(4096);
export const historyContract = {
  historyPage: {input: z.object({copyId: id, offset: z.number().int().min(0).max(1_000_000)}), output: answer({value: historyPage})},
  historyRevision: {input: z.object({copyId: id}), output: answer({revision: z.string()})},
  historyCommit: {input: z.object({copyId: id, hash: z.string().max(64)}), output: answer({value: commitDetails})},
  historyPatch: {input: z.object({copyId: id, hash: z.string().max(64).nullable(), path}), output: answer({text: z.string()})},
};
