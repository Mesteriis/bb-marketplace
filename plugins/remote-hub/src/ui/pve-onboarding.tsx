// Adding a Proxmox connection, two ways.
//  1. A restricted user (recommended): the administrator's login is used for this one setup and is never stored. The
//     screen first asks Proxmox what it would do and shows exactly what will be created, then waits for a confirmation.
//     The new user's password goes straight into the Keychain from the helper; this screen never sees it.
//  2. Connect as is: the typed password or API token is saved for this connection, and nothing is created in Proxmox.
// A certificate that is not trusted shows its fingerprint and waits for the owner to confirm it.
import { useState } from "react";
import { PVE_PROVISION } from "../core/pve-protocol.ts";
import type { PveProfileTrust } from "../core/pve-trust.ts";
import { adviceFor, outcomeOfFailure } from "../core/pve-targets.ts";
import type { PveAction, PveAdminInput, PveApi, PveFailure } from "./pve-api.ts";

export interface PveOnboardingProps {
  api: PveApi;
  onDone: (profileId: string) => void;
  onCancel: () => void;
}

type Mode = "restricted" | "as_is";
interface Plan {
  role: PveAction;
  user: PveAction;
  acl: PveAction;
}

const ROLE_TEXT: Record<PveAction, string> = {
  create: "will be created",
  keep: "already exists with these privileges; it stays as it is",
  update: "exists with other privileges; it will be changed to these",
  rotate_password: "",
};
const USER_TEXT: Record<PveAction, string> = {
  create: "will be created with a generated password",
  rotate_password: "already exists; its password will be replaced by a new generated one",
  keep: "",
  update: "",
};
const ACL_TEXT: Record<PveAction, string> = {
  create: "will be added",
  keep: "already exists; it stays as it is",
  update: "",
  rotate_password: "",
};

const portOf = (text: string): number | null => (/^\d{1,5}$/.test(text.trim()) && Number(text) >= 1 && Number(text) <= 65535 ? Number(text) : null);

export function PveOnboarding(props: PveOnboardingProps) {
  const { api } = props;
  const [mode, setMode] = useState<Mode>("restricted");
  const [name, setName] = useState("Proxmox");
  const [host, setHost] = useState("");
  const [port, setPort] = useState("8006");
  const [adminUser, setAdminUser] = useState("root@pam");
  const [adminPassword, setAdminPassword] = useState("");
  const [aclPath, setAclPath] = useState("/");
  const [authMode, setAuthMode] = useState<"ticket" | "token">("ticket");
  const [user, setUser] = useState("");
  const [secret, setSecret] = useState("");
  const [trust, setTrust] = useState<PveProfileTrust | null>(null);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [failure, setFailure] = useState<{ code: string; message: string; fingerprint: string | null } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [working, setWorking] = useState(false);

  const forget = () => {
    setAdminPassword("");
    setSecret("");
  };

  const endpoint = () => {
    const p = portOf(port);
    if (host.trim() === "") return "Enter the Proxmox host name or address.";
    if (p === null) return "The port is a number from 1 to 65535.";
    return { host: host.trim(), port: p };
  };

  const fail = (f: PveFailure | { code: string; message: string }) => {
    setFailure({ code: f.code, message: f.message, fingerprint: "fingerprint" in f ? f.fingerprint : null });
  };

  const run = async (work: () => Promise<void>) => {
    setWorking(true);
    setProblem(null);
    setFailure(null);
    try {
      await work();
    } catch (e) {
      setProblem(e instanceof Error ? e.message : String(e));
    } finally {
      setWorking(false);
    }
  };

  const adminInput = (ep: { host: string; port: number }, withTrust: PveProfileTrust | null): PveAdminInput => ({ ...ep, trust: withTrust, adminUser: adminUser.trim(), adminPassword, aclPath: aclPath.trim() });

  const review = (withTrust: PveProfileTrust | null) =>
    run(async () => {
      const ep = endpoint();
      if (typeof ep === "string") return setProblem(ep);
      if (adminUser.trim() === "" || adminPassword === "") return setProblem("Enter the administrator's user and password.");
      const answer = await api.onboardPlan(adminInput(ep, withTrust));
      if (answer.ok) setPlan({ role: answer.role, user: answer.user, acl: answer.acl });
      else fail(answer);
    });

  const apply = () =>
    run(async () => {
      const ep = endpoint();
      if (typeof ep === "string") return setProblem(ep);
      const answer = await api.onboardApply({ ...adminInput(ep, trust), name: name.trim() === "" ? "Proxmox" : name.trim() });
      if (answer.ok) {
        forget();
        props.onDone(answer.profileId);
      } else {
        setPlan(null);
        fail(answer);
      }
    });

  const connectAsIs = () =>
    run(async () => {
      const ep = endpoint();
      if (typeof ep === "string") return setProblem(ep);
      if (user.trim() === "" || secret === "") return setProblem("Enter the user (or token id) and the password (or token secret).");
      const answer = await api.onboardConnect({ ...ep, trust, name: name.trim() === "" ? "Proxmox" : name.trim(), authMode, user: user.trim(), secret });
      if (answer.ok) {
        forget();
        props.onDone(answer.profileId);
      } else {
        fail(answer);
      }
    });

  const confirmCertificate = () => {
    if (failure?.fingerprint == null) return;
    const next: PveProfileTrust = { mode: "pin", fingerprint: failure.fingerprint };
    setTrust(next);
    setFailure(null);
    if (mode === "restricted") void review(next);
  };

  const certificateFailure = failure !== null && failure.fingerprint !== null && (failure.code === "tls_untrusted" || failure.code === "cert_changed");

  return (
    <form
      className="rh-editor rh-pve-onboarding"
      aria-label="Add Proxmox"
      onSubmit={(event) => {
        event.preventDefault();
        if (working) return;
        if (plan !== null) void apply();
        else if (mode === "restricted") void review(trust);
        else void connectAsIs();
      }}
    >
      <fieldset aria-label="Proxmox server" disabled={working || plan !== null}>
        <legend>Proxmox server</legend>
        <label>
          Name
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label>
          Host
          <input value={host} onChange={(e) => setHost(e.target.value)} placeholder="pve.example.com" />
        </label>
        <label>
          Port
          <input value={port} onChange={(e) => setPort(e.target.value)} />
        </label>
        <label className="rh-check">
          <input type="radio" name="pve-mode" checked={mode === "restricted"} onChange={() => setMode("restricted")} />
          Create a restricted user for Remote Hub (recommended)
        </label>
        <label className="rh-check">
          <input type="radio" name="pve-mode" checked={mode === "as_is"} onChange={() => setMode("as_is")} />
          Connect as is, with a login or API token I already have
        </label>
      </fieldset>

      {mode === "restricted" ? (
        <fieldset aria-label="Administrator login" disabled={working || plan !== null}>
          <legend>Administrator login (used once, never stored)</legend>
          <label>
            Administrator user
            <input value={adminUser} onChange={(e) => setAdminUser(e.target.value)} />
          </label>
          <label>
            Administrator password
            <input type="password" autoComplete="off" value={adminPassword} onChange={(e) => setAdminPassword(e.target.value)} />
          </label>
          <label>
            Permission path
            <input value={aclPath} onChange={(e) => setAclPath(e.target.value)} />
          </label>
          <p className="rh-hint">Use / for the whole cluster, or /pool/&lt;name&gt; to limit the new user to one resource pool.</p>
        </fieldset>
      ) : (
        <fieldset aria-label="Login" disabled={working}>
          <legend>Login saved for this connection</legend>
          <label>
            Sign in with
            <select value={authMode} onChange={(e) => setAuthMode(e.target.value as "ticket" | "token")}>
              <option value="ticket">User and password</option>
              <option value="token">API token</option>
            </select>
          </label>
          <label>
            {authMode === "token" ? "API token id (user@realm!name)" : "User (name@realm)"}
            <input value={user} onChange={(e) => setUser(e.target.value)} />
          </label>
          <label>
            {authMode === "token" ? "API token secret" : "Password"}
            <input type="password" autoComplete="off" value={secret} onChange={(e) => setSecret(e.target.value)} />
          </label>
          <p className="rh-hint">Saved in the macOS Keychain for this connection only. Nothing is created in Proxmox. An API token may not be accepted for consoles on every Proxmox version.</p>
        </fieldset>
      )}

      {plan !== null && (
        <section aria-label="What will be created" data-testid="pve-plan">
          <h3>What Remote Hub will create in Proxmox</h3>
          <ul>
            <li>
              Role <strong>{PVE_PROVISION.role}</strong> with only {PVE_PROVISION.privileges.join(", ")}: {ROLE_TEXT[plan.role]}.
            </li>
            <li>
              User <strong>{PVE_PROVISION.user}</strong> (realm pve): {USER_TEXT[plan.user]}.
            </li>
            <li>
              Permission on <strong>{aclPath.trim()}</strong> giving that user that role: {ACL_TEXT[plan.acl]}.
            </li>
          </ul>
          <p className="rh-hint">
            The administrator login is used for this one step and is not stored. The new password goes only to the macOS Keychain. To remove everything later, delete the user and the role in Proxmox
            (<code>pveum user delete {PVE_PROVISION.user}</code>, <code>pveum role delete {PVE_PROVISION.role}</code>) and delete this connection here.
          </p>
        </section>
      )}

      {certificateFailure && failure !== null && (
        <div className="rh-cert" data-testid="pve-onboard-cert">
          <p className="rh-error">{adviceFor(outcomeOfFailure(failure.code), null)}</p>
          <p>
            Certificate fingerprint (SHA-256): <code>{failure.fingerprint}</code>
          </p>
          <button type="button" onClick={confirmCertificate}>
            {failure.code === "cert_changed" ? "Trust the new certificate" : "Trust this certificate"}
          </button>
        </div>
      )}
      {failure !== null && !certificateFailure && (
        <p role="alert" className="rh-error" data-testid="pve-onboard-error">
          {adviceFor(outcomeOfFailure(failure.code), failure.message) ?? failure.message}
        </p>
      )}
      {problem !== null && (
        <p role="alert" className="rh-error">
          {problem}
        </p>
      )}

      <div className="rh-editor-actions">
        <button type="submit" disabled={working}>
          {plan !== null ? "Create and save" : mode === "restricted" ? "Review what will be created" : "Save connection"}
        </button>
        {plan !== null && (
          <button type="button" disabled={working} onClick={() => setPlan(null)}>
            Back
          </button>
        )}
        <button
          type="button"
          onClick={() => {
            forget();
            props.onCancel();
          }}
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
