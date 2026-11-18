// The connect page: the saved-profile catalogue on the left; on the right the
// profile editor or "Quick connect" (an SSH | RDP switch over the two session
// pages, nothing saved). Both session pages stay mounted (the inactive one
// hidden) so switching or editing never drops a live view.
import { useCallback, useRef, useState } from "react";
import { profileToRdpForm, profileToSshTarget } from "../core/catalogue.ts";
import { profileFieldsOf, type Profile, type ProfileFields } from "../core/profile.ts";
import { ProfileCatalogue } from "./profile-catalogue.tsx";
import { ProfileEditor } from "./profile-editor.tsx";
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
}

export function ConnectPage(props: ConnectPageProps) {
  const [kind, setKind] = useState<ConnectKind>(props.initialKind ?? "ssh");
  const [editing, setEditing] = useState<{ profile: Profile | null } | null>(null);
  const [sshLaunch, setSshLaunch] = useState<SshLaunch | undefined>(undefined);
  const [rdpPrefill, setRdpPrefill] = useState<RdpPrefill | undefined>(undefined);
  const [notice, setNotice] = useState<string | null>(null);
  const nonce = useRef(0);
  const api = props.profiles;
  const data = useProfiles(api);
  const { reload } = data;

  const connectProfile = useCallback((p: Profile) => {
    setEditing(null);
    setNotice(null);
    nonce.current += 1;
    if (p.protocol === "ssh") {
      setKind("ssh");
      setSshLaunch({ nonce: nonce.current, profileId: p.id, target: profileToSshTarget(p) });
    } else {
      setKind("rdp");
      setRdpPrefill({ nonce: nonce.current, profileId: p.id, ...profileToRdpForm(p) });
    }
  }, []);

  const save = useCallback(
    async (fields: ProfileFields) => {
      if (api === undefined) return;
      await api.save({ id: editing?.profile?.id, fields });
      setEditing(null);
      await reload();
    },
    [api, editing, reload],
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
    onSshOpen: async (target, profileId) => {
      try {
        return await props.ssh.onSshOpen(target, profileId);
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
    <div className="rh-shell">
      {api !== undefined && (
        <ProfileCatalogue
          profiles={data.profiles}
          error={data.error}
          sessions={data.sessions}
          onConnect={connectProfile}
          onEdit={(profile) => setEditing({ profile })}
          onNew={() => setEditing({ profile: null })}
          onDuplicate={(p) => void action(() => api.duplicate(p.id))}
          onDelete={(p) => void action(() => api.remove(p.id))}
          onRetry={() => void reload()}
        />
      )}
      <div className="rh-connect">
        {notice !== null && <p className="rh-error">{notice}</p>}
        {editing !== null && (
          <ProfileEditor
            key={editing.profile?.id ?? "new"}
            initial={editing.profile === null ? null : profileFieldsOf(editing.profile)}
            onSave={save}
            onCancel={() => setEditing(null)}
          />
        )}
        <div hidden={editing !== null} className="rh-connect-sessions">
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
  );
}
