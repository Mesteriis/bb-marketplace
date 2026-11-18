// Adding a Proxmox connection, two ways.
//  1. A restricted user (recommended): the administrator's login is used for this one setup and is never stored. The
//     screen first asks Proxmox what it would do and shows exactly what will be created, then waits for a confirmation.
//     The new user's password goes straight into the Keychain from the helper; this screen never sees it.
//  2. Connect as is: the typed password or API token is saved for this connection, and nothing is created in Proxmox.
// A certificate that is not trusted shows its fingerprint and waits for the owner to confirm it.
import { useState } from "react";
import { PVE_PROVISION, type PvePlan, type PveSteps } from "../core/pve-protocol.ts";
import type { PveProfileTrust } from "../core/pve-trust.ts";
import { adviceFor, outcomeOfFailure } from "../core/pve-targets.ts";
import type { PveAdminInput, PveApi, PveFailure } from "./pve-api.ts";

export interface PveOnboardingProps {
  api: PveApi;
  onDone: (profileId: string) => void;
  onCancel: () => void;
}

type Mode = "restricted" | "as_is";

const USER_ID = /^[A-Za-z0-9._-]{1,64}@pve$/;

const ROLE_TEXT: Record<PvePlan["role"], string> = {
  create: "will be created",
  keep: "already exists with exactly these privileges; it stays as it is",
  differs: "exists with other privileges",
};
const USER_TEXT: Record<PvePlan["user"], string> = {
  create: "will be created with a generated password",
  rotate_password: "was created by Remote Hub before; its password will be replaced by a new generated one",
  name_taken: "already exists and was not created by Remote Hub; nothing will be written. Choose another name",
};
const ACL_TEXT: Record<PvePlan["acl"], string> = {
  create: "will be added",
  keep: "already exists; it stays as it is",
};
const STEP_TEXT: Record<PveSteps[keyof PveSteps], string> = {
  done: "done",
  kept: "already in place",
  failed: "failed",
  not_attempted: "not attempted",
  unknown: "unknown (the request was sent and no answer came; check in Proxmox)",
};
const FAILURE_TEXT: Record<string, string> = {
  plan_changed: "Proxmox changed after you reviewed the plan. Nothing was written. Enter the password again to review the current state.",
  plan_required: "The plan was not confirmed. Review it first.",
  name_taken: "That user already exists and was not created by Remote Hub. Choose another user name.",
  role_differs: "The role exists with other privileges. Confirm replacing it in the review, or leave it.",
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
  const [userId, setUserId] = useState<string>(PVE_PROVISION.user);
  const [authMode, setAuthMode] = useState<"ticket" | "token">("ticket");
  const [user, setUser] = useState("");
  const [secret, setSecret] = useState("");
  const [trust, setTrust] = useState<PveProfileTrust | null>(null);
  const [plan, setPlan] = useState<PvePlan | null>(null);
  const [replaceRole, setReplaceRole] = useState(false);
  const [failure, setFailure] = useState<PveFailure | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  // The administrator password lives in this component's state only while a review is open. It is cleared on success,
  // on cancel, after any failed attempt (the owner types it again), and it goes with the component when it unmounts.
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
    forget();
    setFailure({ ok: false, code: f.code, message: f.message, fingerprint: "fingerprint" in f ? f.fingerprint : null, steps: "steps" in f ? f.steps : null, ...("profileId" in f && f.profileId !== undefined ? { profileId: f.profileId } : {}) });
  };

  const run = async (work: () => Promise<void>) => {
    setWorking(true);
    setProblem(null);
    setFailure(null);
    setNotice(null);
    try {
      await work();
    } catch (e) {
      forget();
      setProblem(e instanceof Error ? e.message : String(e));
    } finally {
      setWorking(false);
    }
  };

  const adminInput = (ep: { host: string; port: number }, withTrust: PveProfileTrust | null): PveAdminInput => ({ ...ep, trust: withTrust, adminUser: adminUser.trim(), adminPassword, aclPath: aclPath.trim(), userId: userId.trim() });

  const review = () =>
    run(async () => {
      const ep = endpoint();
      if (typeof ep === "string") return setProblem(ep);
      if (adminUser.trim() === "" || adminPassword === "") return setProblem("Enter the administrator's user and password.");
      if (!USER_ID.test(userId.trim())) return setProblem("The new user is name@pve: letters, digits, dot, dash or underscore, then @pve.");
      const answer = await api.onboardPlan(adminInput(ep, trust));
      if (answer.ok) {
        setReplaceRole(false);
        setPlan({ role: answer.role, user: answer.user, acl: answer.acl, userId: answer.userId, rolePrivs: answer.rolePrivs, extras: answer.extras, digest: answer.digest });
      } else fail(answer);
    });

  const apply = (confirmed: PvePlan) =>
    run(async () => {
      const ep = endpoint();
      if (typeof ep === "string") return setProblem(ep);
      if (adminPassword === "") return setProblem("Enter the administrator's password again: it is used for each step and never kept.");
      const answer = await api.onboardApply({ ...adminInput(ep, trust), name: name.trim() === "" ? "Proxmox" : name.trim(), planDigest: confirmed.digest, replaceRole });
      if (answer.ok) {
        forget();
        props.onDone(answer.profileId);
      } else {
        setPlan(null);
        setReplaceRole(false);
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
    setTrust({ mode: "pin", fingerprint: failure.fingerprint });
    setFailure(null);
    setNotice("Certificate trusted for this server. Enter the password again to continue.");
  };

  const certificateFailure = failure !== null && failure.fingerprint !== null && (failure.code === "tls_untrusted" || failure.code === "cert_changed");
  const blocked = plan !== null && (plan.user === "name_taken" || (plan.role === "differs" && !replaceRole));
  const locked = working || plan !== null;

  return (
    <form
      className="rh-editor rh-pve-onboarding"
      aria-label="Add Proxmox"
      onSubmit={(event) => {
        event.preventDefault();
        if (working) return;
        if (plan !== null) {
          if (!blocked) void apply(plan);
        } else if (mode === "restricted") void review();
        else void connectAsIs();
      }}
    >
      <fieldset aria-label="Proxmox server" disabled={locked}>
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
        <fieldset aria-label="Administrator login" disabled={locked}>
          <legend>Administrator login (used for this setup only, never stored)</legend>
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
          <label>
            New user for Remote Hub
            <input value={userId} onChange={(e) => setUserId(e.target.value)} />
          </label>
          <p className="rh-hint">Use / for the whole cluster, or /pool/&lt;name&gt; to limit the new user to one resource pool. The user is always in the pve realm.</p>
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
              Role <strong>{PVE_PROVISION.role}</strong> with only {PVE_PROVISION.privileges.join(", ")}: {ROLE_TEXT[plan.role]}
              {plan.role === "differs" && plan.rolePrivs !== null ? ` (now: ${plan.rolePrivs === "" ? "no privileges" : plan.rolePrivs})` : ""}.
            </li>
            <li>
              User <strong>{plan.userId}</strong>: {USER_TEXT[plan.user]}.
            </li>
            <li>
              Permission on <strong>{aclPath.trim()}</strong> giving that user that role: {ACL_TEXT[plan.acl]}.
            </li>
          </ul>
          {plan.role === "differs" && (
            <label className="rh-check">
              <input type="checkbox" checked={replaceRole} onChange={(e) => setReplaceRole(e.target.checked)} />
              Replace the role&apos;s privileges with the four above. This also narrows the role for everyone who holds it.
            </label>
          )}
          {plan.user === "rotate_password" && (plan.extras.acl.length > 0 || plan.extras.groups.length > 0 || plan.extras.tokens.length > 0) && (
            <div data-testid="pve-plan-extras">
              <p>This user already holds more than Remote Hub grants. None of it is removed:</p>
              <ul>
                {plan.extras.acl.map((g) => (
                  <li key={`${g.path}|${g.role}`}>
                    Permission {g.role} on {g.path}
                  </li>
                ))}
                {plan.extras.groups.map((g) => (
                  <li key={`g|${g}`}>Member of group {g}</li>
                ))}
                {plan.extras.tokens.map((t) => (
                  <li key={`t|${t}`}>API token {t}</li>
                ))}
              </ul>
            </div>
          )}
          <p className="rh-hint">
            The administrator login is used for each step of this setup and is not stored; you will not be asked again after you confirm. The new password goes only to the macOS Keychain. To remove everything later, delete the user and the
            role in Proxmox (<code>pveum user delete {plan.userId}</code>, <code>pveum role delete {PVE_PROVISION.role}</code>) and delete this connection here.
          </p>
        </section>
      )}

      {notice !== null && <p className="rh-hint">{notice}</p>}

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
        <div role="alert" className="rh-error" data-testid="pve-onboard-error">
          <p>{FAILURE_TEXT[failure.code] ?? adviceFor(outcomeOfFailure(failure.code), failure.message) ?? failure.message}</p>
          {failure.steps != null && (
            <ul data-testid="pve-onboard-steps">
              <li>Role: {STEP_TEXT[failure.steps.role]}</li>
              <li>User: {STEP_TEXT[failure.steps.user]}</li>
              <li>Permission: {STEP_TEXT[failure.steps.acl]}</li>
            </ul>
          )}
          {failure.profileId !== undefined && (
            <p>
              Setup is incomplete. The new login is already saved in a connection marked &quot;setup incomplete&quot;. Run the setup again to finish it.{" "}
              <button type="button" onClick={() => props.onDone(failure.profileId as string)}>
                Keep the connection and close
              </button>
            </p>
          )}
        </div>
      )}
      {problem !== null && (
        <p role="alert" className="rh-error">
          {problem}
        </p>
      )}

      <div className="rh-editor-actions">
        <button type="submit" disabled={working || blocked}>
          {plan !== null ? "Create and save" : mode === "restricted" ? "Review what will be created" : "Save connection"}
        </button>
        {plan !== null && (
          <button
            type="button"
            disabled={working}
            onClick={() => {
              setPlan(null);
              setReplaceRole(false);
            }}
          >
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
