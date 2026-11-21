// Sign-ins in flight, kept in memory: a server restart drops them and the
// user starts the connection again.
import type { PendingLogin, PendingLoginStore } from "../../core/ports.ts";

/** Consents in flight at once; the oldest is dropped beyond this. */
const MAX_PENDING = 20;

export function createPendingLogins(): PendingLoginStore {
  const logins = new Map<string, PendingLogin>();
  return {
    async put(login) {
      logins.set(login.state, login);
      while (logins.size > MAX_PENDING) {
        const oldest = logins.keys().next().value;
        if (oldest === undefined) break;
        logins.delete(oldest);
      }
    },
    async take(state) {
      const login = logins.get(state) ?? null;
      logins.delete(state);
      return login;
    },
  };
}
