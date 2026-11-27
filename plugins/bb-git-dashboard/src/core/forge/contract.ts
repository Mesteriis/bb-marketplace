import { z } from "zod";
import { account } from "../providers.ts";
import { id } from "../workspace.ts";

const kind = z.enum(["github", "gitlab", "gitea", "azure"]);
export const linkTarget = z.object({accountId: id, repoId: z.string().min(1).max(500)});
export const forgeStatus = z.object({
  remote: z.object({host: z.string(), path: z.string()}).nullable(),
  detection: z.object({
    kind: kind.nullable(), origin: z.string().nullable(), host: z.string(),
    status: z.enum(["known", "probed", "cached", "unknown", "unreachable"]),
  }).nullable(),
  candidates: z.array(account),
  chosen: z.string().nullable(),
  reason: z.enum(["owner", "organization", "visible", "host", "ambiguous", "none", "linked"]),
  linked: linkTarget.nullable(),
  error: z.string().nullable(),
});
