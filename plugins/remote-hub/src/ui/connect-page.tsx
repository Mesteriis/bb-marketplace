// The connect page: the saved-profile catalogue on the left; on the right the
// profile editor or "Quick connect" (an SSH | RDP switch over the two session
// pages, nothing saved). Both session pages stay mounted (the inactive one
// hidden) so switching or editing never drops a live view.
import { useCallback, useRef, useState } from "react";
import { profileToRdpForm, profileToSshTarget } from "../core/catalogue.ts";
import { profileFieldsOf, type Profile, type ProfileFields } from "../core/profile.ts";
import { ProfileCatalogue } from "./profile-catalogue.tsx";
import { AgentPanel, type AgentApi } from "./agent-panel.tsx";
import { LiveSession, type LiveSessionApi } from "./live-session.tsx";
import { CredentialsPanel } from "./credentials-panel.tsx";
import { ImportPanel, type ImportApi } from "./import-panel.tsx";
import { ProfileEditor, type SecretAction } from "./profile-editor.tsx";
import { errorCodeText, errorTextFromMessage } from "../core/rdp-texts.ts";
import { useCredentials, type CredentialsApi } from "./use-credentials.ts";
import { RdpPage, type RdpPageProps, type RdpPrefill } from "./rdp-page.tsx";
import { SshPage, type SshLaunch, type SshPageProps } from "./ssh-page.tsx";
import { useProfiles, type ProfilesApi } from "./use-profiles.ts";

export type ConnectKind = "ssh" | "rdp";

export interface ConnectPageProps {
  ssh: SshPageProps;
  rdp: RdpPageProps;
  initialKind?: ConnectKind;
  /** Saved profiles; without it the page is the plain Quick connect form. */
  profiles?: ProfilesApi;
  /** Saved passwords (the Keychain); without it there is no Credentials screen and no way to save one. */
  credentials?: CredentialsApi;
  /** Sources to import profiles from (ssh config, hosts file, keys, agent); without it there is no Import screen. */
  imports?: ImportApi;
  /** Agent access and activity (stage 4a); without it there is no such section or screen. */
  agents?: AgentApi;
  /** Live views of sessions agents opened (stage 4c); without it the catalogue has no Watch button. */
  live?: LiveSessionApi;
}

export function ConnectPage(props: ConnectPageProps) {
  const [kind, setKind] = useState<ConnectKind>(props.initialKind ?? "ssh");
  const [editing, setEditing] = useState<{ profile: Profile | null; key: number } | null>(null);
  const [sshLaunch, setSshLaunch] = useState<SshLaunch | undefined>(undefined);
  const [rdpPrefill, setRdpPrefill] = useState<RdpPrefill | undefined>(undefined);
  const [notice, setNotice] = useState<string | null>(null);
  const [showCredentials, setShowCredentials] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [showAgents, setShowAgents] = useState(false);
  const [watched, setWatched] = useState<string | null>(null);
  const nonce = useRef(0);
  const api = props.profiles;
  const data = useProfiles(api);
  const { reload } = data;
  const credentialsApi = props.credentials;
  const credentialData = useCredentials(credentialsApi, showCredentials);

  const connectProfile = useCallback((p: Profile) => {
    setEditing(null);
    setNotice(null);
    nonce.current += 1;
    if (p.protocol === "ssh") {
      setKind("ssh");
      setSshLaunch({ nonce: nonce.current, profileId: p.id, target: profileToSshTarget(p), ...(p.credentialRef !== null ? { credentialRef: p.credentialRef } : {}) });
    } else {
      setKind("rdp");
      setRdpPrefill({ nonce: nonce.current, profileId: p.id, ...profileToRdpForm(p) });
    }
  }, []);

  const save = useCallback(
    async (fields: ProfileFields, secret: SecretAction) => {
      if (api === undefined) return;
      const before = editing?.profile ?? null;
      // A new profile has no id key at all: BB's RPC refuses an undefined value.
      const saved = await api.save(before !== null ? { id: before.id, fields } : { fields });
      if (before?.credentialRef != null && saved.credentialRef === null) {
        setNotice("The saved password was forgotten because the host, port, user or domain changed.");
      }
      // The profile is saved; the password is a second step that can fail on its own (a locked Keychain).
      if (credentialsApi !== undefined && secret.type !== "keep") {
        try {
          if (secret.type === "save") {
            if (saved.credentialRef !== null) await credentialsApi.update(saved.credentialRef, secret.secret);
            else await credentialsApi.save({ profileId: saved.id, secret: secret.secret });
          } else if (saved.credentialRef !== null) {
            await credentialsApi.remove(saved.credentialRef);
          }
        } catch (e) {
          // Stay in the editor on the saved profile, so the next Save updates it instead of creating another.
          setEditing((cur) => (cur === null ? cur : { ...cur, profile: saved }));
          await reload();
          throw new Error("The profile was saved, but not the password: " + errorTextFromMessage(e instanceof Error ? e.message : String(e)));
        }
      }
      setEditing(null);
      await reload();
    },
    [api, credentialsApi, editing, reload],
  );

  const action = useCallback(
    async (run: () => Promise<unknown>) => {
      setNotice(null);
      try {
        await run();
        await reload();
      } catch (e) {
        setNotice(e instanceof Error ? e.message : String(e));
      }
    },
    [reload],
  );

  // An open from a profile records its outcome on the profile; refresh after it.
  const ssh: SshPageProps = {
    ...props.ssh,
    ...(sshLaunch !== undefined ? { launch: sshLaunch } : {}),
    onSshOpen: async (target, profileId, credentialRef) => {
      try {
        return await props.ssh.onSshOpen(target, profileId, credentialRef);
      } finally {
        void reload();
      }
    },
  };
  const rdp: RdpPageProps = {
    ...props.rdp,
    ...(rdpPrefill !== undefined ? { prefill: rdpPrefill } : {}),
    onRdpOpen: async (target, size, profileId) => {
      try {
        return await props.rdp.onRdpOpen(target, size, profileId);
      } finally {
        void reload();
      }
    },
  };

  return (
    <div className="rh-root">
      <div className="rh-shell">
      {api !== undefined && (
        <ProfileCatalogue
          profiles={data.profiles}
          error={data.error}
          sessions={data.sessions}
          onConnect={connectProfile}
          onEdit={(profile) => setEditing({ profile, key: ++nonce.current })}
          onNew={() => setEditing({ profile: null, key: ++nonce.current })}
          onDuplicate={(p) => void action(() => api.duplicate(p.id))}
          onDelete={(p, deleteCredential) =>
            void action(async () => {
              const result = await api.remove(p.id, deleteCredential);
              if (result.credentialError !== undefined) {
                throw new Error("The profile was deleted, but its saved password was not: " + errorCodeText(result.credentialError));
              }
            })
          }
          {...(credentialsApi !== undefined ? { onShowCredentials: () => { setShowImport(false); setShowCredentials(true); } } : {})}
          {...(props.imports !== undefined ? { onShowImport: () => { setShowCredentials(false); setShowAgents(false); setEditing(null); setShowImport(true); } } : {})}
          {...(props.agents !== undefined ? { onShowAgents: () => { setShowCredentials(false); setShowImport(false); setEditing(null); setShowAgents(true); } } : {})}
          onRetry={() => void reload()}
          {...(props.live !== undefined ? { onWatchAgentSession: (key: string) => setWatched(key) } : {})}
        />
      )}
      <div className="rh-connect">
        {notice !== null && <p className="rh-error">{notice}</p>}
        {watched !== null && props.live !== undefined && (
          <section aria-label="Live view of an agent's session" className="rh-watched">
            <button type="button" onClick={() => setWatched(null)}>
              Close live view
            </button>
            <LiveSession sessionKey={watched} api={props.live} />
          </section>
        )}
        {showCredentials && credentialsApi !== undefined && (
          <CredentialsPanel
            items={credentialData.items}
            error={credentialData.error}
            onCheck={(ref) => credentialsApi.status(ref)}
            onChange={async (ref, secret) => {
              await credentialsApi.update(ref, secret);
              await credentialData.reload();
            }}
            onDelete={async (ref) => {
              await credentialsApi.remove(ref);
              await credentialData.reload();
              await reload();
            }}
            onRetry={() => void credentialData.reload()}
            onClose={() => setShowCredentials(false)}
          />
        )}
        {showImport && props.imports !== undefined && (
          <ImportPanel api={props.imports} onImported={() => void reload()} onClose={() => setShowImport(false)} />
        )}
        {showAgents && props.agents !== undefined && (
          <AgentPanel api={props.agents} profileNames={new Map((data.profiles ?? []).map((p) => [p.id, p.name]))} onClose={() => setShowAgents(false)} />
        )}
        {editing !== null && !showCredentials && !showImport && !showAgents && (
          <ProfileEditor
            key={editing.key}
            initial={editing.profile === null ? null : profileFieldsOf(editing.profile)}
            {...(props.agents !== undefined ? { agentAccess: { api: props.agents, profileId: editing.profile === null ? null : editing.profile.id } } : {})}
            onSave={save}
            onCancel={() => setEditing(null)}
          />
        )}
        <div hidden={editing !== null || showCredentials || showImport || showAgents} className="rh-connect-sessions">
          <div className="rh-kind" role="group" aria-label="connection kind">
            {api !== undefined && <span className="rh-quick">Quick connect</span>}
            <button type="button" aria-pressed={kind === "ssh"} onClick={() => setKind("ssh")}>
              SSH
            </button>
            <button type="button" aria-pressed={kind === "rdp"} onClick={() => setKind("rdp")}>
              RDP
            </button>
          </div>
          <div hidden={kind !== "ssh"} className="rh-kind-pane">
            <SshPage {...ssh} />
          </div>
          <div hidden={kind !== "rdp"} className="rh-kind-pane">
            <RdpPage {...rdp} />
          </div>
        </div>
      </div>
      </div>
    </div>
  );
}
