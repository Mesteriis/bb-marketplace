/**
 * What a Review tab keeps of a view in the plugin's database, so a thread opened again shows it as it was: unsent
 * comments, folded files and where it was scrolled. Follows diff-review shared/types.ts and app/view-state.tsx (MIT,
 * gpambrozio); see THIRD_PARTY_NOTICES.md.
 */
import { z } from "zod";
import { BODY_MAX_CHARS, severitySchema, sideSchema } from "./model.ts";

/** Most unsent comments one tab keeps for a view, and most files whose fold it remembers. */
export const MAX_DRAFTS = 200;
export const MAX_FOLDS = 5_000;

/**
 * An unsent comment, as typed. Its key says what it belongs to: `general`, `file:<path>`, `line:<path>` (with
 * `range`; one line draft per file, as the Review offers), `reply:<thread id>` or `edit:<comment id>`.
 */
export const draftSchema = z.object({
  body: z.string().max(BODY_MAX_CHARS), severity: severitySchema.nullable(),
  range: z.object({side: sideSchema, start: z.number().int().min(1), end: z.number().int().min(1)}).optional(),
}).strict();
export type Draft = z.infer<typeof draftSchema>;
export const viewStateSchema = z.object({
  savedAt: z.number().int().nonnegative(),
  drafts: z.record(z.string().max(4200), draftSchema).refine(value => Object.keys(value).length <= MAX_DRAFTS),
  /** Files folded (true) or unfolded (false) by hand; others follow their defaults. */
  folds: z.record(z.string().max(4096), z.boolean()).refine(value => Object.keys(value).length <= MAX_FOLDS),
  scroll: z.number().nonnegative(),
}).strict();
export type ViewState = z.infer<typeof viewStateSchema>;
export const EMPTY_VIEW_STATE: ViewState = {savedAt: 0, drafts: {}, folds: {}, scroll: 0};

/** A kept state as read back: anything malformed counts as nothing kept. */
export function readViewState(raw: string | null): ViewState {
  if (raw === null) return EMPTY_VIEW_STATE;
  try {
    const parsed = viewStateSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : EMPTY_VIEW_STATE;
  } catch { return EMPTY_VIEW_STATE; }
}

/** The file path a draft key is about, or null for the whole diff, a reply or an edit. */
export function draftPath(key: string): string | null {
  return key.startsWith("file:") ? key.slice(5) : key.startsWith("line:") ? key.slice(5) : null;
}

/** Drafts on files the view does not show: kept, and offered apart so they are not lost silently. */
export function orphanDrafts(state: ViewState, paths: ReadonlySet<string>): {key: string; path: string; draft: Draft}[] {
  return Object.entries(state.drafts).flatMap(([key, draft]) => {
    const path = draftPath(key);
    return path !== null && !paths.has(path) && draft.body.trim() ? [{key, path, draft}] : [];
  });
}
