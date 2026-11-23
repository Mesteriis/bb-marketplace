export function threadFromPath(subPath: string): string | null {
  try {
    const id = decodeURIComponent(subPath);
    return /^thr_[a-zA-Z0-9_-]+$/.test(id) ? id : null;
  } catch {
    return null;
  }
}
