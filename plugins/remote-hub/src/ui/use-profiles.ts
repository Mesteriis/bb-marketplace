// Loads the saved profiles and the live sessions for the catalogue and wraps the
// profile actions. Host-free: the data source is the ProfilesApi passed in.
import { useCallback, useEffect, useRef, useState } from "react";
import type { Profile, ProfileInput } from "../core/profile.ts";
import type { SessionInfo } from "../core/rpc.ts";

export interface ProfilesApi {
  list: () => Promise<Profile[]>;
  save: (input: ProfileInput) => Promise<Profile>;
  /** `deleteCredential` also deletes the profile's saved password (the server does so only when no other profile uses it). */
  remove: (id: string, deleteCredential?: boolean) => Promise<{ deleted: boolean; credentialDeleted?: boolean; credentialError?: string }>;
  duplicate: (id: string) => Promise<Profile>;
  sessions: () => Promise<Array<SessionInfo & { profileId?: string }>>;
}

/** How often the status of the profiles is refreshed from the live sessions. */
export const STATUS_REFRESH_MS = 3000;

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export function useProfiles(api: ProfilesApi | undefined) {
  const [profiles, setProfiles] = useState<Profile[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sessions, setSessions] = useState<Array<SessionInfo & { profileId?: string }>>([]);
  const alive = useRef(true);
  // A response is applied only if no newer request of its kind started after it:
  // an older answer arriving late must not undo a delete or a status change.
  const listSeq = useRef(0);
  const sessionsSeq = useRef(0);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const reloadSessions = useCallback(async () => {
    if (api === undefined) return;
    const seq = ++sessionsSeq.current;
    try {
      const next = await api.sessions();
      if (alive.current && seq === sessionsSeq.current) setSessions(next);
    } catch {
      // A status refresh that fails keeps the last known status; the list has its own error.
    }
  }, [api]);

  const reload = useCallback(async () => {
    if (api === undefined) return;
    const seq = ++listSeq.current;
    try {
      const next = await api.list();
      if (alive.current && seq === listSeq.current) {
        setProfiles(next);
        setError(null);
      }
    } catch (e) {
      if (alive.current && seq === listSeq.current) setError(message(e));
    }
    await reloadSessions();
  }, [api, reloadSessions]);

  useEffect(() => {
    void reload();
    if (api === undefined) return undefined;
    const timer = setInterval(() => void reloadSessions(), STATUS_REFRESH_MS);
    return () => clearInterval(timer);
  }, [api, reload, reloadSessions]);

  return { profiles, error, sessions, reload, reloadSessions };
}
