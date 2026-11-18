// The saved-profile catalogue (stage 3a): search, SSH/RDP filter, groups, a
// status derived from the live sessions, and quick actions. Presentational: the
// data and every action come in through props.
import { useState } from "react";
import { filterProfiles, groupProfiles, profileStatus, type CatalogueFilter } from "../core/catalogue.ts";
import type { Profile } from "../core/profile.ts";
import type { SessionInfo } from "../core/rpc.ts";

export interface ProfileCatalogueProps {
  /** null while loading. */
  profiles: Profile[] | null;
  error: string | null;
  sessions: Array<SessionInfo & { profileId?: string }>;
  onConnect: (profile: Profile) => void;
  onEdit: (profile: Profile) => void;
  onNew: () => void;
  onDuplicate: (profile: Profile) => void;
  /** `deleteCredential`: also delete the profile's saved password (only offered when no other profile uses it). */
  onDelete: (profile: Profile, deleteCredential: boolean) => void;
  onRetry: () => void;
  /** Opens the Credentials screen; the button shows only when this is given. */
  onShowCredentials?: () => void;
  /** Opens the Import screen; the button shows only when this is given. */
  onShowImport?: () => void;
  /** Opens the agent access and activity screen (stage 4a). */
  onShowAgents?: () => void;
}

function endpoint(p: Profile): string {
  return (p.username !== null ? p.username + "@" : "") + p.host + (p.port !== null ? ":" + p.port : "");
}

export function ProfileCatalogue(props: ProfileCatalogueProps) {
  const [query, setQuery] = useState("");
  const [protocol, setProtocol] = useState<CatalogueFilter["protocol"]>("all");
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [alsoCredential, setAlsoCredential] = useState(true);

  const { profiles } = props;
  const visible = profiles === null ? [] : filterProfiles(profiles, { query, protocol, favoritesOnly });

  return (
    <aside className="rh-catalogue" aria-label="Saved profiles">
      <div className="rh-catalogue-tools">
        <input aria-label="Search profiles" placeholder="Search" value={query} onChange={(e) => setQuery(e.target.value)} />
        <div className="rh-kind" role="toolbar" aria-label="protocol filter">
          {(["all", "ssh", "rdp"] as const).map((value) => (
            <button key={value} type="button" aria-pressed={protocol === value} onClick={() => setProtocol(value)}>
              {value === "all" ? "All" : value.toUpperCase()}
            </button>
          ))}
          <button type="button" aria-pressed={favoritesOnly} onClick={() => setFavoritesOnly(!favoritesOnly)}>
            Favorites
          </button>
        </div>
        <button type="button" className="rh-new" onClick={props.onNew}>
          New profile
        </button>
        {props.onShowCredentials !== undefined && (
          <button type="button" onClick={props.onShowCredentials}>
            Credentials
          </button>
        )}
        {props.onShowAgents !== undefined && (
          <button type="button" onClick={props.onShowAgents}>
            Agent activity
          </button>
        )}
        {props.onShowImport !== undefined && (
          <button type="button" onClick={props.onShowImport}>
            Import
          </button>
        )}
      </div>

      {profiles === null && props.error === null && <p className="rh-hint">Loading profiles…</p>}
      {props.error !== null && (
        <div>
          <p className="rh-error">{props.error}</p>
          <button type="button" onClick={props.onRetry}>
            Retry
          </button>
        </div>
      )}
      {profiles !== null && profiles.length === 0 && (
        <p className="rh-hint">No saved profiles yet. Create one with New profile, or use Quick connect.</p>
      )}
      {profiles !== null && profiles.length > 0 && visible.length === 0 && <p className="rh-hint">No profile matches.</p>}

      {groupProfiles(visible).map((group) => (
        <section key={group.group ?? "\u0000ungrouped"} role="group" aria-label={group.group ?? "Ungrouped"} className="rh-group">
          <h3>{group.group ?? "Ungrouped"}</h3>
          <ul>
            {group.profiles.map((p) => {
              const status = profileStatus(p.id, props.sessions);
              const lastError = p.recentErrors.at(-1);
              const others = p.credentialRef === null ? [] : (profiles ?? []).filter((o) => o.id !== p.id && o.credentialRef === p.credentialRef);
              return (
                <li key={p.id} aria-label={p.name} className="rh-profile" style={p.color !== null ? { borderLeftColor: p.color } : undefined}>
                  <div className="rh-profile-main">
                    <span className="rh-profile-title">
                      {p.favorite && <span aria-label="favorite">★ </span>}
                      <strong data-testid="profile-name">{p.name}</strong> <span className="rh-badge">{p.protocol.toUpperCase()}</span>
                    </span>
                    <span className="rh-profile-endpoint">{endpoint(p)}</span>
                    <span data-testid="profile-status" className="rh-status">
                      {status.state === "idle" ? "" : status.sessions > 1 ? `${status.state} ×${status.sessions}` : status.state}
                    </span>
                    {p.credentialRef !== null && <span className="rh-status">saved password</span>}
                    {p.provenance == null && p.needsConfig === true && (
                      <span className="rh-status" data-testid="profile-needs-config">
                        uses your ssh config, no saved password until you set a new host, port and user
                      </span>
                    )}
                    {p.provenance != null && (
                      <span className="rh-status" data-testid="profile-provenance">
                        {"source: " + (p.provenance.sourceKind === "ssh-config" ? "ssh config" : "hosts file")}
                        {p.provenance.stale ? " · no longer in the source" : ""}
                        {p.provenance.editedLocally ? " · edited here" : ""}
                        {!p.provenance.resolved ? " · uses your ssh config, no saved password" : ""}
                      </span>
                    )}
                    {lastError !== undefined && <span className="rh-error">last open failed: {lastError.code}</span>}
                  </div>
                  <div className="rh-profile-actions">
                    <button type="button" aria-label={"Connect " + p.name} onClick={() => props.onConnect(p)}>
                      Connect
                    </button>
                    <button type="button" aria-label={"Edit " + p.name} onClick={() => props.onEdit(p)}>
                      Edit
                    </button>
                    <button type="button" aria-label={"Duplicate " + p.name} onClick={() => props.onDuplicate(p)}>
                      Duplicate
                    </button>
                    {confirming === p.id ? (
                      <>
                        {p.credentialRef !== null && others.length === 0 && (
                          <label className="rh-check">
                            <input type="checkbox" checked={alsoCredential} onChange={(e) => setAlsoCredential(e.target.checked)} />
                            Also delete the saved password
                          </label>
                        )}
                        {p.credentialRef !== null && others.length > 0 && (
                          <span className="rh-hint">{others.map((o) => o.name).join(", ")} still uses the saved password; it stays.</span>
                        )}
                        <button
                          type="button"
                          aria-label={"Confirm delete " + p.name}
                          onClick={() => {
                            setConfirming(null);
                            props.onDelete(p, p.credentialRef !== null && others.length === 0 && alsoCredential);
                          }}
                        >
                          Delete?
                        </button>
                        <button type="button" aria-label={"Cancel delete " + p.name} onClick={() => setConfirming(null)}>
                          Keep
                        </button>
                      </>
                    ) : (
                      <button
                        type="button"
                        aria-label={"Delete " + p.name}
                        onClick={() => {
                          setAlsoCredential(true);
                          setConfirming(p.id);
                        }}
                      >
                        Delete
                      </button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </aside>
  );
}
