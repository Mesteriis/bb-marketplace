// The Credentials screen (stage 3b): what is saved in the Keychain, what each
// credential is for, which profiles use it, and the actions on it. It shows
// metadata only; a password can be changed (typed once, sent, cleared) but is
// never displayed.
import { useState } from "react";
import { errorCodeText, errorTextFromMessage } from "../core/rdp-texts.ts";
import type { CredentialItem, CredentialStateName } from "./use-credentials.ts";

export interface CredentialsPanelProps {
  /** null while loading. */
  items: CredentialItem[] | null;
  error: string | null;
  onCheck: (ref: string) => Promise<{ state: CredentialStateName }>;
  /** "Allow access": macOS may show its own dialog for this item. */
  onAllow?: (ref: string) => Promise<{ state: CredentialStateName }>;
  onAllowAll?: () => Promise<Array<{ label: string; ok: boolean; code: string | null }>>;
  onChange: (ref: string, secret: string) => Promise<void>;
  onDelete: (ref: string) => Promise<void>;
  onRetry: () => void;
  onClose: () => void;
}

const STATE_TEXT: Record<CredentialStateName, string> = {
  present: "Found in the Keychain.",
  missing: "No longer in the Keychain: save the password again.",
  locked: "The login Keychain is locked (or macOS has not allowed this Remote Hub build to read it). Unlock it in Keychain Access, then use Allow access.",
  needs_approval: "macOS has not allowed this Remote Hub build to read this password (the helper was updated). Press Allow access and choose Always Allow.",
  denied: "The Keychain refused access.",
  unavailable: "The Keychain is not available.",
};

function bindText(item: CredentialItem): string {
  if (item.orphaned === true) return "A save did not finish and its Keychain item could not be removed. Delete it to retry the cleanup.";
  if (item.bind.type === "key") return item.bind.path;
  const b = item.bind;
  return (b.domain !== null ? b.domain + "\\" : "") + (b.user !== null ? b.user + "@" : "") + b.host + ":" + b.port;
}

function kindText(item: CredentialItem): string {
  if (item.kind === "passphrase") return "Key passphrase";
  return item.bind.type === "endpoint" ? item.bind.protocol.toUpperCase() + " password" : "Password";
}

function Row(props: { item: CredentialItem; onCheck: CredentialsPanelProps["onCheck"]; onAllow: CredentialsPanelProps["onAllow"]; onChange: CredentialsPanelProps["onChange"]; onDelete: CredentialsPanelProps["onDelete"] }) {
  const { item } = props;
  const [state, setState] = useState<string | null>(null);
  const [changing, setChanging] = useState(false);
  const [secret, setSecret] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setProblem(null);
    try {
      await work();
    } catch (e) {
      setProblem(errorTextFromMessage(e instanceof Error ? e.message : String(e)));
    } finally {
      setBusy(false);
    }
  };

  return (
    <li aria-label={item.label} className="rh-profile">
      <div className="rh-profile-main">
        <span className="rh-profile-title">
          <strong>{item.label}</strong> <span className="rh-badge">{kindText(item)}</span>
        </span>
        <span className="rh-profile-endpoint">{bindText(item)}</span>
        <span className="rh-status">{item.usedBy.length > 0 ? "Used by: " + item.usedBy.map((u) => u.name).join(", ") : "Not used by any profile"}</span>
        {state !== null && <span className="rh-status">{state}</span>}
        {problem !== null && <span className="rh-error">{problem}</span>}
      </div>
      <div className="rh-profile-actions">
        {item.orphaned !== true && (
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                setState(STATE_TEXT[(await props.onCheck(item.ref)).state]);
              })
            }
          >
            Check
          </button>
        )}
        {item.orphaned !== true && props.onAllow !== undefined && (
          <button
            type="button"
            disabled={busy}
            title="macOS asks you once; choose Always Allow. Other sessions pause while its dialog is open."
            onClick={() =>
              void run(async () => {
                setState(STATE_TEXT[(await props.onAllow!(item.ref)).state]);
              })
            }
          >
            Allow access
          </button>
        )}
        {!changing && item.orphaned !== true && (
          <button type="button" onClick={() => setChanging(true)}>
            Change password
          </button>
        )}
        {changing && (
          <>
            <label>
              New password
              <input type="password" autoComplete="off" value={secret} onChange={(e) => setSecret(e.target.value)} />
            </label>
            <button
              type="button"
              disabled={busy || secret === ""}
              onClick={() => {
                const typed = secret;
                setSecret(""); // gone from the form at once
                void run(async () => {
                  await props.onChange(item.ref, typed);
                  setChanging(false);
                  setState("Password changed.");
                });
              }}
            >
              Save new password
            </button>
            <button
              type="button"
              onClick={() => {
                setSecret("");
                setChanging(false);
              }}
            >
              Cancel
            </button>
          </>
        )}
        {confirming ? (
          <>
            {item.usedBy.length > 0 && <span className="rh-hint">{item.usedBy.map((u) => u.name).join(", ")} will ask for a password again.</span>}
            <button type="button" aria-label="Confirm delete" disabled={busy} onClick={() => void run(async () => props.onDelete(item.ref))}>
              Delete?
            </button>
            <button type="button" onClick={() => setConfirming(false)}>
              Keep
            </button>
          </>
        ) : (
          <button type="button" onClick={() => setConfirming(true)}>
            Delete
          </button>
        )}
      </div>
    </li>
  );
}

export function CredentialsPanel(props: CredentialsPanelProps) {
  const [walking, setWalking] = useState(false);
  const [walked, setWalked] = useState<string | null>(null);
  const allowAll = async () => {
    if (props.onAllowAll === undefined) return;
    setWalking(true);
    setWalked(null);
    try {
      const results = await props.onAllowAll();
      const failed = results.filter((r) => !r.ok);
      setWalked(failed.length === 0 ? `Access allowed for ${results.length} saved credential${results.length === 1 ? "" : "s"}.` : failed.map((r) => `${r.label}: ${errorCodeText(r.code ?? "keychain_unavailable")}`).join(" "));
    } catch (e) {
      setWalked(errorTextFromMessage(e instanceof Error ? e.message : String(e)));
    } finally {
      setWalking(false);
    }
  };
  return (
    <section className="rh-credentials" aria-label="Saved credentials">
      <div className="rh-credentials-head">
        <h2>Credentials</h2>
        <button type="button" onClick={props.onClose}>
          Close
        </button>
      </div>
      <p className="rh-hint">Passwords live in the macOS Keychain. This list shows what each one is for; it never shows the password.</p>
      {props.onAllowAll !== undefined && (
        <p>
          <button type="button" disabled={walking} onClick={() => void allowAll()} title="One macOS dialog per saved credential; choose Always Allow. Other sessions pause while a dialog is open.">
            Allow access for all saved credentials
          </button>{" "}
          <span className="rh-hint">After a Remote Hub update macOS asks once per saved credential.</span>
        </p>
      )}
      {walked !== null && <p role="status" className="rh-hint">{walked}</p>}
      {props.items === null && props.error === null && <p className="rh-hint">Loading credentials…</p>}
      {props.error !== null && (
        <div>
          <p className="rh-error">{props.error}</p>
          <button type="button" onClick={props.onRetry}>
            Retry
          </button>
        </div>
      )}
      {props.items !== null && props.items.length === 0 && <p className="rh-hint">No saved passwords yet. Save one from a profile.</p>}
      {props.items !== null && props.items.length > 0 && (
        <ul className="rh-credential-list">
          {props.items.map((item) => (
            <Row key={item.ref} item={item} onCheck={props.onCheck} onAllow={props.onAllow} onChange={props.onChange} onDelete={props.onDelete} />
          ))}
        </ul>
      )}
    </section>
  );
}
