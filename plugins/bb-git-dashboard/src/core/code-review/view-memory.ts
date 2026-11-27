/**
 * What a Review keeps between visits, per thread tab or per working copy: the view the owner picked and the
 * toggles. Follows diff-review app/view-memory.ts (MIT, gpambrozio); see THIRD_PARTY_NOTICES.md. A view never picked
 * (the first look's choice) is not kept, so the next visit picks again.
 */
import { targetRequestSchema, type TargetRequest } from "./model.ts";

export type KeptView = {target: TargetRequest | null; ignoreWhitespace: boolean; onlyCommented: boolean; wrap: boolean; split: boolean};
/** The part of `localStorage` the memory uses. */
export type ViewStorage = {getItem(key: string): string | null; setItem(key: string, value: string): void};

export const NOTHING_KEPT: KeptView = {target: null, ignoreWhitespace: false, onlyCommented: false, wrap: false, split: false};
const key = (scope: string) => "git-dashboard:review-view:" + scope;
/** A thread's tab keeps its own; the working copy's Review in Git keeps one per copy. */
export const viewScope = (copyId: string, threadId: string | undefined) => threadId ? "thread:" + threadId : "copy:" + copyId;

export function readView(storage: ViewStorage | undefined, scope: string): KeptView {
  try {
    const raw = storage?.getItem(key(scope));
    if (!raw) return NOTHING_KEPT;
    const value = JSON.parse(raw) as Partial<Record<keyof KeptView, unknown>>;
    const target = value.target === null || value.target === undefined ? null : targetRequestSchema.safeParse(value.target);
    const flag = (name: "ignoreWhitespace" | "onlyCommented" | "wrap" | "split") => value[name] === true;
    return {target: target === null || !target.success ? null : target.data, ignoreWhitespace: flag("ignoreWhitespace"), onlyCommented: flag("onlyCommented"),
      wrap: flag("wrap"), split: flag("split")};
  } catch { return NOTHING_KEPT; }
}

export function keepView(storage: ViewStorage | undefined, scope: string, view: KeptView) {
  // A browser without storage just forgets.
  try { storage?.setItem(key(scope), JSON.stringify(view)); } catch { /* nothing kept */ }
}
