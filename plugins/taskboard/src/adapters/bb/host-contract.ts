// Host RPC contract: create an isolated issue worktree on a host checkout.
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const hostContract = defineRpcContract({
  createWorktree: {
    input: z.object({ repoPath: z.string().min(1), branchName: z.string().min(1), baseBranch: z.string().min(1), runId: z.string().min(1) }).strict(),
    output: z.object({ worktreePath: z.string().min(1), branch: z.string().min(1) }).strict(),
  },
});
