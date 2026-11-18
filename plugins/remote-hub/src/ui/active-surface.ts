// Which session pages are on screen right now, so code elsewhere in the app (the split fallback in the overlay) can tell
// POSITIVELY that the owner is still where it put them. A page registers while it is mounted; a route change unmounts it.
// Host-free and module-level on purpose: the overlay and the page are separate components of one plugin app.
const showing = new Map<string, number>();

/** The session page for `sessionKey` is on screen; returns the function that says it is not any more. */
export function markSessionPage(sessionKey: string): () => void {
  showing.set(sessionKey, (showing.get(sessionKey) ?? 0) + 1);
  return () => {
    const left = (showing.get(sessionKey) ?? 1) - 1;
    if (left > 0) showing.set(sessionKey, left);
    else showing.delete(sessionKey);
  };
}

export function sessionPageShowing(sessionKey: string): boolean {
  return showing.has(sessionKey);
}
