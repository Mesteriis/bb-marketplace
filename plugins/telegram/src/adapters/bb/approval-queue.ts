export const approvalTimeoutMs = 120_000;

export function approvalDeadline(signal: AbortSignal) {
  const expires = Date.now() + approvalTimeoutMs;
  const reviewSignal = AbortSignal.any([signal, AbortSignal.timeout(approvalTimeoutMs)]);
  return { expires, signal: reviewSignal, active: () => !reviewSignal.aborted && Date.now() < expires };
}

// The BB composer has one pending form per thread. Read and send share
// the same lease so neither request can hide or replace the other.
export function createApprovalQueue() {
  const busy = new Set<string>();
  return {
    acquire(threadId: string): (() => void) | undefined {
      if (busy.has(threadId)) return;
      busy.add(threadId);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        busy.delete(threadId);
      };
    },
  };
}
