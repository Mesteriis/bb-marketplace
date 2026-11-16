/** Thrown for conditions the caller should report, not stack-trace. */
export class SyncError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SyncError";
  }
}
