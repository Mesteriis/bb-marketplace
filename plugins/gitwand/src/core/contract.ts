// Wire contract between the BB page and the plugin server: plain zod schemas,
// wrapped for BB RPC in server.ts.
import { z } from "zod";

export const statusSchema = z
  .object({
    platform: z.string().nullable(),
    runtime: z.object({ version: z.string(), source: z.enum(["dev", "installed"]), commit: z.string() }).strict().nullable(),
    runtimeError: z.string().nullable(),
    bridge: z.object({ state: z.enum(["no-runtime", "stopped", "starting", "running", "failed"]), detail: z.string().nullable() }).strict(),
    tools: z.object({ git: z.boolean(), gh: z.boolean(), glab: z.boolean() }).strict(),
    update: z.object({ state: z.enum(["unchecked", "disabled", "none", "available", "needs-plugin", "error"]), detail: z.string().nullable() }).strict(),
    /** Something the user has to do, e.g. reload the plugin after a runtime change. */
    notice: z.string().nullable(),
  })
  .strict();

export type GitWandStatus = z.infer<typeof statusSchema>;

export const repoSchema = z.object({ path: z.string().nullable(), problem: z.string().nullable() }).strict();

export const rpcSchemas = {
  status: { input: z.null(), output: statusSchema },
  restart: { input: z.null(), output: statusSchema },
  rollback: { input: z.null(), output: statusSchema },
  check_updates: { input: z.null(), output: statusSchema },
  install_update: { input: z.object({ version: z.string().min(1) }).strict(), output: statusSchema },
  repo_for_thread: { input: z.object({ threadId: z.string().min(1) }).strict(), output: repoSchema },
};
