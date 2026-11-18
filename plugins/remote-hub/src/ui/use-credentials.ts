// The saved credentials for the Credentials screen. Host-free: the data source is the
// CredentialsApi passed in. Nothing here ever holds a secret: a password is only
// passed down (save/update), never read back.
import { useCallback, useEffect, useRef, useState } from "react";

export interface CredentialItem {
  ref: string;
  kind: "password" | "passphrase";
  label: string;
  bind: { type: "endpoint"; protocol: "ssh" | "rdp"; host: string; port: number; user: string | null; domain: string | null } | { type: "key"; path: string };
  createdAt: string;
  updatedAt: string;
  usedBy: Array<{ id: string; name: string }>;
}

export type CredentialStateName = "present" | "missing" | "locked" | "denied" | "unavailable";

export interface CredentialsApi {
  list: () => Promise<CredentialItem[]>;
  save: (input: { profileId: string; secret: string }) => Promise<{ ref: string }>;
  update: (ref: string, secret: string) => Promise<unknown>;
  remove: (ref: string) => Promise<{ unlinked: number }>;
  status: (ref: string) => Promise<{ state: CredentialStateName }>;
}

export function useCredentials(api: CredentialsApi | undefined, enabled: boolean) {
  const [items, setItems] = useState<CredentialItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const reload = useCallback(async () => {
    if (api === undefined) return;
    const mine = ++seq.current; // a superseded answer is dropped
    try {
      const next = await api.list();
      if (alive.current && mine === seq.current) {
        setItems(next);
        setError(null);
      }
    } catch (e) {
      if (alive.current && mine === seq.current) setError(e instanceof Error ? e.message : String(e));
    }
  }, [api]);
  useEffect(() => {
    if (enabled) void reload();
  }, [enabled, reload]);
  return { items, error, reload };
}
