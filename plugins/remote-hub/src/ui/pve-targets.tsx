// Proxmox guests of the saved connections: one section per connection with its own outcome (so a connection that fails
// never hides the others), a search over name, VMID, node and kind, and a card per guest. There are no power buttons:
// Remote Hub never starts or stops a guest. "Open console" is disabled with its reason; a guest links to an SSH or RDP
// profile the owner chooses, never to an address guessed from Proxmox.
import { useCallback, useEffect, useState } from "react";
import type { Profile } from "../core/profile.ts";
import { searchGuests, type PveConnectionView, type PveGuestView, type PveOutcome } from "../core/pve-targets.ts";
import type { PveApi } from "./pve-api.ts";

export interface PveTargetsProps {
  api: PveApi;
  /** The Proxmox connections to show; null = all of them. */
  profileIds: string[] | null;
  /** Saved SSH and RDP profiles a guest can be linked to. */
  linkable: Profile[];
  onConnectProfile: (profileId: string) => void;
  onClose: () => void;
}

const OUTCOME_LABEL: Record<PveOutcome, string> = {
  ok: "connected",
  empty: "no guests visible",
  no_permission: "no permission",
  login_failed: "login refused",
  unreachable: "unreachable",
  tls_untrusted: "certificate not trusted",
  cert_changed: "certificate changed",
  tfa_required: "second factor required",
  no_credential: "no saved password or token",
  error: "error",
};

function age(seconds: number): string {
  if (seconds < 90) return `${seconds} s`;
  if (seconds < 5400) return `${Math.round(seconds / 60)} min`;
  return `${Math.round(seconds / 3600)} h`;
}

/** The console is not wired in this release; the reason is shown in place of a button that would do nothing. */
export const CONSOLE_PENDING_REASON = "Console sessions arrive in the next stage of Proxmox support.";

function GuestCard(props: { guest: PveGuestView; linkable: Profile[]; onLink: (vmid: number, linkProfileId: string | null) => void; onConnectProfile: (id: string) => void }) {
  const { guest, linkable } = props;
  const linked = guest.linkedProfileId === null ? null : (linkable.find((p) => p.id === guest.linkedProfileId) ?? null);
  const reason = guest.console.available ? CONSOLE_PENDING_REASON : (guest.console.reason ?? "unavailable");
  return (
    <li className="rh-guest" aria-label={guest.name || String(guest.vmid)} data-testid="pve-guest">
      <span className="rh-guest-title">
        <strong>{guest.name || "(unnamed)"}</strong> <span className="rh-badge">{guest.kind === "qemu" ? "VM" : "LXC"}</span> <span className="rh-guest-id">#{guest.vmid}</span>
      </span>
      <span className="rh-status" data-testid="pve-guest-state">
        {guest.template ? "template" : guest.status} · node {guest.node}
      </span>
      <div className="rh-guest-actions">
        <button type="button" disabled aria-label={"Open console of " + (guest.name || guest.vmid)} title={reason}>
          Open console
        </button>
        <span className="rh-hint" data-testid="pve-console-reason">
          {reason}
        </span>
        <label>
          SSH or RDP profile
          <select
            aria-label={"Linked profile of " + (guest.name || guest.vmid)}
            value={guest.linkedProfileId ?? ""}
            onChange={(e) => props.onLink(guest.vmid, e.target.value === "" ? null : e.target.value)}
          >
            <option value="">none</option>
            {linkable.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} ({p.protocol.toUpperCase()})
              </option>
            ))}
          </select>
        </label>
        {linked !== null && (
          <button type="button" aria-label={"Connect to " + (guest.name || guest.vmid) + " through " + linked.name} onClick={() => props.onConnectProfile(linked.id)}>
            Connect through {linked.name}
          </button>
        )}
      </div>
    </li>
  );
}

export function PveTargets(props: PveTargetsProps) {
  const { api, profileIds } = props;
  const [connections, setConnections] = useState<PveConnectionView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const idsKey = profileIds === null ? "" : profileIds.join(",");

  const load = useCallback(
    async (refresh: boolean) => {
      setBusy(true);
      setError(null);
      try {
        const answer = await api.targets({ ...(idsKey === "" ? {} : { profileIds: idsKey.split(",") }), refresh });
        setConnections(answer.connections);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    },
    [api, idsKey],
  );

  useEffect(() => {
    void load(false);
  }, [load]);

  const pin = async (profileId: string, fingerprint: string) => {
    try {
      await api.pinTrust(profileId, fingerprint);
      await load(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const link = async (profileId: string, vmid: number, linkProfileId: string | null) => {
    try {
      await api.linkGuest(profileId, vmid, linkProfileId);
      await load(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <section className="rh-pve" aria-label="Proxmox guests">
      <div className="rh-pve-tools">
        <input aria-label="Search guests" placeholder="Search by name, id, node or type" value={query} onChange={(e) => setQuery(e.target.value)} />
        <button type="button" disabled={busy} onClick={() => void load(true)}>
          Refresh
        </button>
        <button type="button" onClick={props.onClose}>
          Close
        </button>
      </div>
      {error !== null && <p className="rh-error">{error}</p>}
      {connections === null && error === null && <p className="rh-hint">Reading Proxmox…</p>}
      {connections !== null && connections.length === 0 && <p className="rh-hint">No Proxmox connections yet. Add one with Add Proxmox.</p>}
      {(connections ?? []).map((c) => {
        const guests = searchGuests(c.guests, query);
        return (
          <section key={c.profileId} className="rh-pve-connection" aria-label={c.profileName} data-testid="pve-connection">
            <h3>
              {c.profileName} <span className="rh-badge" data-testid="pve-outcome">{OUTCOME_LABEL[c.outcome]}</span>
              {c.version !== null && <span className="rh-hint"> Proxmox VE {c.version}</span>}
            </h3>
            {c.stale !== null && (
              <p className="rh-hint" data-testid="pve-stale">
                Showing the last list read {age(c.stale.ageSeconds)} ago; the server cannot be reached now.
              </p>
            )}
            {c.message !== null && <p className="rh-error">{c.message}</p>}
            {c.fingerprint !== null && (c.outcome === "tls_untrusted" || c.outcome === "cert_changed") && (
              <div className="rh-cert" data-testid="pve-cert">
                <p>
                  Certificate fingerprint (SHA-256): <code>{c.fingerprint}</code>
                </p>
                <button type="button" onClick={() => void pin(c.profileId, c.fingerprint as string)}>
                  {c.outcome === "cert_changed" ? "Trust the new certificate" : "Trust this certificate"}
                </button>
              </div>
            )}
            {c.outcome === "empty" && <p className="rh-hint">The account sees no virtual machines or containers.</p>}
            {guests.length === 0 && c.guests.length > 0 && <p className="rh-hint">No guest matches.</p>}
            <ul>
              {guests.map((g) => (
                <GuestCard key={g.key} guest={g} linkable={props.linkable} onLink={(vmid, to) => void link(c.profileId, vmid, to)} onConnectProfile={props.onConnectProfile} />
              ))}
            </ul>
          </section>
        );
      })}
    </section>
  );
}
