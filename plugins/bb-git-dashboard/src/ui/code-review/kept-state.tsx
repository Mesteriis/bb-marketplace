import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { EMPTY_VIEW_STATE, MAX_DRAFTS, MAX_FOLDS, type Draft, type ViewState } from "../../core/code-review/view-state.ts";
import type { CodeReviewApi } from "./review-api.ts";

/** How long after the last change the state is saved, in milliseconds. */
const SAVE_AFTER = 800;

/** What a Review keeps for its view: unsent comments by key, folds by path. */
export type Kept = {
  draft(key: string): Draft | undefined;
  setDraft(key: string, draft: Draft | null): void;
  fold(path: string): boolean | undefined;
  setFold(path: string, folded: boolean): void;
};
const nothing: Kept = {draft: () => undefined, setDraft: () => {}, fold: () => undefined, setFold: () => {}};
export const KeptContext = createContext<Kept>(nothing);
export const useKept = () => useContext(KeptContext);

/** The nearest ancestor that scrolls, where the Review's position is kept. */
function scroller(element: HTMLElement | null): HTMLElement | null {
  for (let node = element?.parentElement ?? null; node; node = node.parentElement) {
    const style = getComputedStyle(node);
    if (/(auto|scroll)/.test(style.overflowY) && node.scrollHeight > node.clientHeight) return node;
  }
  return document.scrollingElement as HTMLElement | null;
}

/**
 * Loads what `scope`'s tab kept of a view when the view changes, and saves its changes a moment after the last one,
 * and when the page hides. `ready` turns on once the kept state is in, so composers start from their drafts.
 */
export function useKeptState(api: CodeReviewApi, scope: string, sessionId: string | undefined, root: React.RefObject<HTMLElement | null>) {
  const state = useRef<ViewState>(EMPTY_VIEW_STATE);
  const [ready, setReady] = useState(false);
  const [version, setVersion] = useState(0);
  const dirty = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flush = useCallback(() => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    if (!dirty.current || !sessionId) return;
    dirty.current = false;
    api.saveViewState(scope, sessionId, {...state.current, savedAt: Date.now()}).catch(() => { dirty.current = true; });
  }, [api, scope, sessionId]);
  const touch = useCallback(() => {
    dirty.current = true;
    setVersion(value => value + 1);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(flush, SAVE_AFTER);
  }, [flush]);
  useEffect(() => {
    setReady(false);
    state.current = EMPTY_VIEW_STATE;
    if (!sessionId) return;
    let active = true;
    // A state that cannot be read starts the view afresh rather than holding it back.
    api.viewState(scope, sessionId).then(kept => { if (active) state.current = kept; }, () => {}).finally(() => { if (active) setReady(true); });
    return () => { active = false; };
  }, [api, scope, sessionId]);
  useEffect(() => {
    const hide = () => { if (document.hidden) flush(); };
    document.addEventListener("visibilitychange", hide);
    window.addEventListener("pagehide", flush);
    return () => { document.removeEventListener("visibilitychange", hide); window.removeEventListener("pagehide", flush); flush(); };
  }, [flush]);
  // Once the view shows, its scroll position comes back; then each scroll is kept.
  useEffect(() => {
    if (!ready) return;
    const box = scroller(root.current);
    if (!box) return;
    const target = state.current.scroll;
    const restore = setTimeout(() => { if (target) box.scrollTop = target; }, 50);
    let pending: ReturnType<typeof setTimeout> | null = null;
    const listener = () => {
      if (pending) return;
      pending = setTimeout(() => { pending = null; state.current = {...state.current, scroll: Math.max(0, Math.round(box.scrollTop))}; touch(); }, 250);
    };
    const events: EventTarget = box === document.scrollingElement ? window : box;
    events.addEventListener("scroll", listener, {passive: true});
    return () => { clearTimeout(restore); if (pending) clearTimeout(pending); events.removeEventListener("scroll", listener); };
  }, [ready, root, touch]);
  const kept = useMemo<Kept>(() => ({
    draft: key => state.current.drafts[key],
    setDraft: (key, draft) => {
      const drafts = {...state.current.drafts};
      if (draft === null || !draft.body.trim()) delete drafts[key]; else drafts[key] = draft;
      if (Object.keys(drafts).length > MAX_DRAFTS) return;
      state.current = {...state.current, drafts};
      touch();
    },
    fold: path => state.current.folds[path],
    setFold: (path, folded) => {
      if (state.current.folds[path] === folded || (!(path in state.current.folds) && Object.keys(state.current.folds).length >= MAX_FOLDS)) return;
      state.current = {...state.current, folds: {...state.current.folds, [path]: folded}};
      touch();
    },
  }), [touch]);
  return {ready, kept, state: state.current, version};
}
