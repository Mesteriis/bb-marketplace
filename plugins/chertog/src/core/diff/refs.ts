import { z } from "zod";
import { fileTarget } from "../panels/entry-card.ts";

export const FILE_PREVIEW_PROVIDER = "bb-file-preview";
export const DIFF_PROVIDER = "bb-diff";
export const gitShaSchema = z.string().regex(/^[a-f0-9]{40}$/i);

const workspaceFile = { environmentId: z.string(), path: z.string() };

// Both live providers use scheme F's validation while retaining the encoded
// path in the persisted reference. Only the SDK target receives a decoded path.
function isWorkspaceFile({ environmentId, path }: { environmentId: string; path: string }): boolean {
  try {
    fileTarget({ kind: "workspace", environmentId, path });
    return true;
  } catch {
    return false;
  }
}

export const filePreviewParamsSchema = z.strictObject({
  kind: z.literal("workspace"),
  ...workspaceFile,
}).refine(isWorkspaceFile, "Invalid workspace file reference");

export const diffParamsSchema = z.strictObject({
  ...workspaceFile,
  fromSha: gitShaSchema,
  toSha: gitShaSchema,
}).refine(isWorkspaceFile, "Invalid workspace file reference");
