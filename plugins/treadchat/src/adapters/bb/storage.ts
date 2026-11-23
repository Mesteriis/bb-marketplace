const prefix = "makosh-treadchat:v1:";

export function storageKey(threadId: string, field: "draft" | "viewed"): string {
  return prefix + field + ":" + encodeURIComponent(threadId);
}

export function readViewed(key: string): number | null {
  const raw = localStorage.getItem(key);
  if (raw === null) return null;
  const seq = Number(raw);
  return Number.isSafeInteger(seq) && seq >= 0 ? seq : null;
}
