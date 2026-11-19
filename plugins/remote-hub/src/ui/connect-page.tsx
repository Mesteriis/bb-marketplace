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
import type { PveApi } from "./pve-api.ts";
import { PveOnboarding } from "./pve-onboarding.tsx";
import { PveTargets } from "./pve-targets.tsx";
import { PveConsoles, type PveConsoleLaunch, type PveConsolesApi } from "./pve-consoles.tsx";

export type ConnectKind = "ssh" | "rdp" | "pve";

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
  /** Proxmox VE: adding a connection and listing its guests; without it there is no Proxmox screen. */
  pve?: PveApi;
  /** Proxmox consoles (a node shell, a container terminal, a VM's graphics); without it the console buttons stay off. */
  /** A console an agent opened, to be viewed here (the Remote Hub page is where graphics have their one view). */
  adoptConsole?: PveConsoleLaunch;
  pveConsoles?: { attach: PveConsolesApi["attach"]; close: PveConsolesApi["close"]; takeover?: PveConsolesApi["takeover"]; preload?: PveConsolesApi["preload"]; tabs?: PveConsolesApi["tabs"] };
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
  // Proxmox: the guest list of one saved connection (or of all of them), and the Add Proxmox screen.
  const [pveList, setPveList] = useState<{ profileIds: string[] | null; key: number } | null>(null);
  const [addingPve, setAddingPve] = useState(false);
  const [consoleLaunch, setConsoleLaunch] = useState<PveConsoleLaunch | undefined>(undefined);
  const adopted = useRef(0);
  if (props.adoptConsole !== undefined && props.adoptConsole.nonce !== adopted.current && props.pveConsoles !== undefined) {
    adopted.current = props.adoptConsole.nonce;
    setConsoleLaunch(props.adoptConsole);
    setKind("pve");
  }
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
    if (p.protocol === "pve") {
      setAddingPve(false);
      setPveList({ profileIds: [p.id], key: nonce.current });
      return;
    }
    setPveList(null);
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
    onRdpOpen: async (target, size, profileId, options) => {
      try {
        return await props.rdp.onRdpOpen(target, size, profileId, options);
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
          {...(props.pve !== undefined ? { onAddPve: () => { setEditing(null); setPveList(null); setAddingPve(true); } } : {})}
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
            onAllow={async (ref) => {
              const r = await credentialsApi.allow(ref);
              await credentialData.reload();
              return r;
            }}
            onAllowAll={async () => {
              const { results } = await credentialsApi.allowAll();
              await credentialData.reload();
              return results;
            }}
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
        {addingPve && props.pve !== undefined && (
          <PveOnboarding
            api={props.pve}
            onDone={() => {
              setAddingPve(false);
              void reload();
              setPveList({ profileIds: null, key: ++nonce.current });
            }}
            onCancel={() => setAddingPve(false)}
          />
        )}
        {pveList !== null && !addingPve && props.pve !== undefined && !showCredentials && !showImport && !showAgents && editing === null && (
          <div className={kind === "pve" ? "rh-pve-list rh-pve-list-with-consoles" : "rh-pve-list"}>
          <PveTargets
            key={pveList.key}
            api={props.pve}
            profileIds={pveList.profileIds}
            linkable={(data.profiles ?? []).filter((p) => p.protocol === "ssh" || p.protocol === "rdp")}
            {...(credentialsApi !== undefined ? { onAllowAccess: (ref: string) => credentialsApi.allow(ref) } : {})}
            onConnectProfile={(id) => {
              const target = (data.profiles ?? []).find((p) => p.id === id);
              if (target !== undefined) connectProfile(target);
            }}
            {...(props.pveConsoles !== undefined
              ? {
                  onOpenConsole: (open: Omit<PveConsoleLaunch, "nonce">) => {
                    setConsoleLaunch({ ...open, nonce: ++nonce.current });
                    // The guest list stays open: the next console is one click away, not another trip through "Guests".
                    setKind("pve");
                  },
                }
              : {})}
            onClose={() => setPveList(null)}
          />
          </div>
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
        <div hidden={editing !== null || showCredentials || showImport || showAgents || addingPve || (pveList !== null && kind !== "pve")} className={pveList !== null && kind === "pve" ? "rh-connect-sessions rh-connect-sessions-beside-list" : "rh-connect-sessions"}>
          <div className="rh-kind" role="group" aria-label="connection kind">
            {api !== undefined && <span className="rh-quick">Quick connect</span>}
            <button type="button" aria-pressed={kind === "ssh"} onClick={() => setKind("ssh")}>
              SSH
            </button>
            <button type="button" aria-pressed={kind === "rdp"} onClick={() => setKind("rdp")}>
              RDP
            </button>
            {props.pveConsoles !== undefined && props.pve !== undefined && (
              <button type="button" aria-pressed={kind === "pve"} onClick={() => setKind("pve")}>
                Proxmox
              </button>
            )}
          </div>
          <div hidden={kind !== "ssh"} className="rh-kind-pane">
            <SshPage {...ssh} />
          </div>
          <div hidden={kind !== "rdp"} className="rh-kind-pane">
            <RdpPage {...rdp} />
          </div>
          {props.pveConsoles !== undefined && props.pve !== undefined && (
            <div hidden={kind !== "pve"} className="rh-kind-pane">
              <PveConsoles
                api={{ open: props.pve.openConsole, attach: props.pveConsoles.attach, close: props.pveConsoles.close, ...(props.pveConsoles.takeover !== undefined ? { takeover: props.pveConsoles.takeover } : {}), ...(props.pveConsoles.preload !== undefined ? { preload: props.pveConsoles.preload } : {}), ...(props.pveConsoles.tabs !== undefined ? { tabs: props.pveConsoles.tabs } : {}) }}
                connectionName={(id) => data.profiles?.find((p) => p.id === id)?.name ?? null}
                {...(consoleLaunch !== undefined ? { launch: consoleLaunch } : {})}
              />
            </div>
          )}
        </div>
      </div>
      </div>
    </div>
  );
}
