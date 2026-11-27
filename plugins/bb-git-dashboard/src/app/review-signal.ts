import { useRealtime } from "@get-bb/plugin-sdk/app";
import { useCallback, useState } from "react";

/**
 * How many times each copy's line review changed (the server's `code-review-changed`, by copy), so a Review reloads
 * for its own copy only; `any` counts every change, for the pages that show all reviews.
 */
export function useReviewRevisions() {
  const [revisions, setRevisions] = useState<{any: number; byCopy: Record<string, number>}>({any: 0, byCopy: {}});
  useRealtime("code-review-changed", useCallback((payload: unknown) => {
    const copyId = typeof (payload as {copyId?: unknown} | null)?.copyId === "string" ? (payload as {copyId: string}).copyId : null;
    setRevisions(current => ({any: current.any + 1, byCopy: copyId ? {...current.byCopy, [copyId]: (current.byCopy[copyId] ?? 0) + 1} : current.byCopy}));
  }, []));
  return revisions;
}
