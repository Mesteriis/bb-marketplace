import { CommanderError } from "../../core/errors.ts";

/**
 * The owner's password prompt for an archive. The password lives here only between the dialog's answer and the
 * moment the helper takes it: `ask` resolves with the bytes, the gate keeps nothing. Agents never reach it: the
 * RPC that feeds it is an owner-client call.
 */
export function createPasswordGate(deps: { publish(archiveId: string): void; timeoutMs: number }) {
  const waiting = new Map<string, { resolve(bytes: Uint8Array | null): void; timer: ReturnType<typeof setTimeout> }>();

  function settle(archiveId: string, bytes: Uint8Array | null): boolean {
    const entry = waiting.get(archiveId);
    if (!entry) return false;
    waiting.delete(archiveId);
    clearTimeout(entry.timer);
    entry.resolve(bytes);
    return true;
  }

  return {
    ask(archiveId: string): Promise<Uint8Array | null> {
      if (waiting.has(archiveId)) {
        return Promise.reject(new CommanderError("internal", "A password question is already open for this archive"));
      }
      return new Promise((resolve) => {
        const timer = setTimeout(() => settle(archiveId, null), deps.timeoutMs);
        timer.unref?.();
        waiting.set(archiveId, { resolve, timer });
        deps.publish(archiveId);
      });
    },
    pending: (archiveId: string) => waiting.has(archiveId),
    provide(archiveId: string, password: string): "accepted" | "none_pending" {
      if (password.length === 0) return "none_pending";
      return settle(archiveId, new TextEncoder().encode(password)) ? "accepted" : "none_pending";
    },
    cancel(archiveId: string): void {
      settle(archiveId, null);
    },
  };
}

export type PasswordGate = ReturnType<typeof createPasswordGate>;
