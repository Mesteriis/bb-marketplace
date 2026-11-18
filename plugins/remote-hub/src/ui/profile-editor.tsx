// Host-free profile editor (stage 3a). Sections: Connection, Authentication,
// the protocol's own fields, Source. No secret field exists here: a password is
// typed when connecting, and the credential reference is carried through as it was.
import { AgentAccessSection } from "./agent-access-section.tsx";
import type { AgentApi } from "./agent-panel.tsx";
import { useState } from "react";
import { profileFieldsSchema, type ProfileFields } from "../core/profile.ts";

/** What to do with the saved password when the profile is saved. The secret exists only in this value. */
export type SecretAction = { type: "keep" } | { type: "save"; secret: string } | { type: "remove" };

export interface ProfileEditorProps {
  /** null = a new profile. */
  initial: ProfileFields | null;
  /** Agent access for this profile (stage 4a): a separate, immediate act of the owner. Absent: no such section. */
  agentAccess?: { api: AgentApi; profileId: string | null };
  onSave: (fields: ProfileFields, secret: SecretAction) => Promise<void>;
  onCancel: () => void;
}

const BLANK: ProfileFields = {
  name: "",
  protocol: "ssh",
  group: null,
  tags: [],
  favorite: false,
  color: null,
  host: "",
  port: null,
  username: null,
  domain: null,
  authType: "agent",
  identityFile: null,
  credentialRef: null,
  rdpWidth: null,
  rdpHeight: null,
};

const orNull = (text: string): string | null => (text.trim() === "" ? null : text.trim());

/** A whole number from text, null for empty, NaN for anything else (the schema then refuses it). */
function numberOrNull(text: string): number | null {
  if (text.trim() === "") return null;
  return /^\d+$/.test(text.trim()) ? Number(text.trim()) : Number.NaN;
}

const FIELD_LABELS: Record<string, string> = {
  name: "Name",
  host: "Host",
  port: "Port",
  username: "User",
  domain: "Domain",
  identityFile: "Key file",
  rdpWidth: "Desktop width",
  authType: "Authentication type",
  color: "Colour",
  group: "Group",
  tags: "Tags",
};

export function ProfileEditor(props: ProfileEditorProps) {
  const start = props.initial ?? BLANK;
  const [name, setName] = useState(start.name);
  const [protocol, setProtocol] = useState<ProfileFields["protocol"]>(start.protocol);
  const [group, setGroup] = useState(start.group ?? "");
  const [tags, setTags] = useState(start.tags.join(", "));
  const [favorite, setFavorite] = useState(start.favorite);
  const [host, setHost] = useState(start.host);
  const [port, setPort] = useState(start.port === null ? "" : String(start.port));
  const [username, setUsername] = useState(start.username ?? "");
  const [domain, setDomain] = useState(start.domain ?? "");
  const [authType, setAuthType] = useState<ProfileFields["authType"]>(start.authType);
  const [identityFile, setIdentityFile] = useState(start.identityFile ?? "");
  const [width, setWidth] = useState(start.rdpWidth === null ? "" : String(start.rdpWidth));
  const [height, setHeight] = useState(start.rdpHeight === null ? "" : String(start.rdpHeight));
  // A password typed here lives only until Save is pressed; it is cleared at once.
  const [secret, setSecret] = useState("");
  const [removeSaved, setRemoveSaved] = useState(false);
  const [issues, setIssues] = useState<Array<{ field: string; message: string }>>([]);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const rdp = protocol === "rdp";
  const hasSaved = props.initial?.credentialRef != null;
  // The saved password is tied to its endpoint: moving the endpoint drops it (the server does that).
  const endpointMoved =
    hasSaved &&
    props.initial !== null &&
    (host.trim() !== props.initial.host ||
      (numberOrNull(port) ?? null) !== props.initial.port ||
      (orNull(username) ?? null) !== props.initial.username ||
      (orNull(domain) ?? null) !== props.initial.domain ||
      (!rdp && authType === "key" && (orNull(identityFile) ?? null) !== props.initial.identityFile));
  const effectiveAuth = rdp ? "password" : authType;
  // What a saved secret is for: a password, or the passphrase of the key file named above.
  const secretKind: "password" | "passphrase" | null =
    effectiveAuth === "password" ? "password" : effectiveAuth === "key" && orNull(identityFile) !== null ? "passphrase" : null;
  const noun = secretKind === "passphrase" ? "passphrase" : "password";

  const choose = (next: ProfileFields["protocol"]) => {
    setProtocol(next);
    if (next === "rdp") setAuthType("password");
  };

  const save = async () => {
    const candidate = {
      name,
      protocol,
      group: orNull(group),
      tags: tags
        .split(",")
        .map((t) => t.trim())
        .filter((t) => t !== ""),
      favorite,
      color: start.color,
      host: host.trim(),
      port: numberOrNull(port),
      username: orNull(username),
      domain: rdp ? orNull(domain) : null,
      authType: effectiveAuth,
      identityFile: !rdp && effectiveAuth === "key" ? orNull(identityFile) : null,
      credentialRef: start.credentialRef,
      rdpWidth: rdp ? numberOrNull(width) : null,
      rdpHeight: rdp ? numberOrNull(height) : null,
    };
    const parsed = profileFieldsSchema.safeParse(candidate);
    if (!parsed.success) {
      setIssues(
        parsed.error.issues.map((issue) => {
          const key = String(issue.path[0] ?? "name");
          return { field: key, message: (FIELD_LABELS[key] ?? key) + ": " + issue.message };
        }),
      );
      return;
    }
    setIssues([]);
    setSaveError(null);
    setSaving(true);
    const action: SecretAction = removeSaved ? { type: "remove" } : secret !== "" ? { type: "save", secret } : { type: "keep" };
    setSecret("");
    try {
      await props.onSave(parsed.data, action);
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form
      className="rh-editor"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <fieldset aria-label="Connection">
        <legend>Connection</legend>
        <label>
          Name
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label>
          Protocol
          <select value={protocol} onChange={(e) => choose(e.target.value as ProfileFields["protocol"])}>
            <option value="ssh">SSH</option>
            <option value="rdp">RDP</option>
          </select>
        </label>
        <label>
          Host
          <input value={host} onChange={(e) => setHost(e.target.value)} />
        </label>
        <label>
          Port
          <input value={port} onChange={(e) => setPort(e.target.value)} placeholder={rdp ? "3389" : "22"} />
        </label>
        <label>
          User
          <input value={username} onChange={(e) => setUsername(e.target.value)} />
        </label>
        {rdp && (
          <label>
            Domain
            <input value={domain} onChange={(e) => setDomain(e.target.value)} />
          </label>
        )}
        <label>
          Group
          <input value={group} onChange={(e) => setGroup(e.target.value)} />
        </label>
        <label>
          Tags
          <input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="comma separated" />
        </label>
        <label className="rh-check">
          <input type="checkbox" checked={favorite} onChange={(e) => setFavorite(e.target.checked)} />
          Favorite
        </label>
      </fieldset>

      <fieldset aria-label="Authentication">
        <legend>Authentication</legend>
        <label>
          Authentication type
          <select value={effectiveAuth} onChange={(e) => setAuthType(e.target.value as ProfileFields["authType"])}>
            {rdp ? (
              <option value="password">Password</option>
            ) : (
              <>
                <option value="agent">SSH agent / default keys</option>
                <option value="key">Key file</option>
                <option value="password">Password</option>
              </>
            )}
          </select>
        </label>
        {!rdp && effectiveAuth === "key" && (
          <label>
            Key file
            <input value={identityFile} onChange={(e) => setIdentityFile(e.target.value)} placeholder="/Users/you/.ssh/id_ed25519" />
          </label>
        )}
        {secretKind !== null && (
          <>
            {hasSaved ? (
              <>
                <p className="rh-hint">A {noun} is saved in the Keychain for this profile.</p>
                <label>
                  Replace the saved {noun}
                  <input type="password" autoComplete="off" value={secret} onChange={(e) => setSecret(e.target.value)} disabled={removeSaved} />
                </label>
                <label className="rh-check">
                  <input type="checkbox" checked={removeSaved} onChange={(e) => setRemoveSaved(e.target.checked)} />
                  Remove the saved {noun}
                </label>
                {endpointMoved && <p className="rh-error">Changing the host, port, user, domain or key file: the saved {noun} will be forgotten.</p>}
              </>
            ) : (
              <label>
                {secretKind === "passphrase" ? "Passphrase" : "Password"} to save in the Keychain
                <input type="password" autoComplete="off" value={secret} onChange={(e) => setSecret(e.target.value)} />
              </label>
            )}
          </>
        )}
        <p className="rh-hint">
          {secretKind !== null
            ? hasSaved
              ? `Connect uses the saved ${noun}; nothing is typed.`
              : `Leave empty to type it each time you connect, or enter one to keep it in the Keychain.`
            : effectiveAuth === "key"
              ? "Enter the key file path to keep its passphrase in the Keychain; OpenSSH asks for it in the terminal otherwise."
              : "OpenSSH uses its agent and default keys."}
        </p>
      </fieldset>

      {rdp && (
        <fieldset aria-label="RDP">
          <legend>RDP</legend>
          <label>
            Desktop width
            <input value={width} onChange={(e) => setWidth(e.target.value)} placeholder="1280" />
          </label>
          <label>
            Desktop height
            <input value={height} onChange={(e) => setHeight(e.target.value)} placeholder="800" />
          </label>
        </fieldset>
      )}

      {props.agentAccess !== undefined && <AgentAccessSection api={props.agentAccess.api} profileId={props.agentAccess.profileId} />}

      <fieldset aria-label="Source">
        <legend>Source</legend>
        <p className="rh-hint">{props.initial === null ? "Created manually." : "Created manually in Remote Hub."}</p>
      </fieldset>

      {issues.map((issue, i) => (
        <p key={i} role="alert" className="rh-error">
          {issue.message}
        </p>
      ))}
      {saveError !== null && <p className="rh-error">{saveError}</p>}
      <div className="rh-editor-actions">
        <button type="submit" disabled={saving}>
          Save
        </button>
        <button type="button" onClick={props.onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
