import { z } from "zod";
import { RUN_PERMISSION_MODES } from "../code-review/runs.ts";

/**
 * The settings the plugin's own settings section writes. Only these: secrets, accounts and the rest stay with BB's
 * settings page. An empty change, an unknown key or value is refused whole.
 */
export const mainSettings = z.object({
  projectsRoot: z.string().trim().min(1).max(4096),
  uiLanguage: z.enum(["auto", "ru", "en"]),
  overviewView: z.enum(["list", "board"]),
  inboxNotifyCi: z.boolean(),
  inboxNotifyComments: z.boolean(),
  aiPermissionMode: z.enum(RUN_PERMISSION_MODES),
  ciTemplatesFolder: z.string().trim().max(1000),
}).partial().strict().refine(values => Object.keys(values).length > 0);
export type MainSettings = z.infer<typeof mainSettings>;
