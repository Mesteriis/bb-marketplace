// The Remote Hub page: the desk with the open sessions, or one secondary screen (the editor, credentials, import, agent
// activity, adding Proxmox) in its place. The connection list lives in BB's sidebar and reaches this page through the bus.
// Every session view stays mounted while another screen is shown, so nothing live is dropped.
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { profileToRdpForm, profileToSshTarget } from "../core/catalogue.ts";
import type { DeskSession, DeskSessionState } from "../core/desk.ts";
import { profileFieldsOf, type Profile, type ProfileFields } from "../core/profile.ts";
import { errorCodeText, errorTextFromMessage } from "../core/rdp-texts.ts";
import { AgentPanel } from "./agent-panel.tsx";
import { CredentialsPanel } from "./credentials-panel.tsx";
import { useDesk } from "./desk-store.ts";
import { Desk } from "./desk/desk.tsx";
import { useDeskStore } from "./desk/desk-context.tsx";
import { DeskPane } from "./desk/desk-pane.tsx";
import { hubBus as defaultBus, type HubBus, type HubCommand } from "./hub-bus.ts";
import { tx } from "./i18n.ts";
import { ImportPanel } from "./import-panel.tsx";
import { ProfileEditor, type SecretAction } from "./profile-editor.tsx";
import { PveConsoles, type PveConsoleLaunch } from "./pve-consoles.tsx";
import { PveOnboarding } from "./pve-onboarding.tsx";
import { RdpPage, type RdpPageStatus, type RdpPrefill } from "./rdp-page.tsx";
import { SshPage, type SessionActions, type SshLaunch, type SshPageStatus } from "./ssh-page.tsx";
import { PveTargets } from "./pve-targets.tsx";
import type { PveApi } from "./pve-api.ts";
import type { AgentApi } from "./agent-panel.tsx";
import type { ImportApi } from "./import-panel.tsx";
import type { PveConsolesApi } from "./pve-consoles.tsx";
import type { RdpPageProps } from "./rdp-page.tsx";
import type { SshPageProps } from "./ssh-page.tsx";
import { useCredentials, type CredentialsApi } from "./use-credentials.ts";
import { useProfiles, type ProfilesApi } from "./use-profiles.ts";

export interface HubPageProps {
  ssh: SshPageProps;
  rdp: RdpPageProps;
  /** Saved profiles; without it the page is the plain Quick connect form. */
  profiles?: ProfilesApi;
  /** Saved passwords (the Keychain); without it there is no Credentials screen and no way to save one. */
  credentials?: CredentialsApi;
  /** Sources to import profiles from (ssh config, hosts file, keys, agent); without it there is no Import screen. */
  imports?: ImportApi;
  /** Agent access and activity (stage 4a); without it there is no such section or screen. */
  agents?: AgentApi;
  /** Proxmox VE: adding a connection and listing its guests; without it there is no Proxmox screen. */
  pve?: PveApi;
  /** Proxmox consoles (a node shell, a container terminal, a VM's graphics); without it the console buttons stay off. */
  /** A console an agent opened, to be viewed here (the Remote Hub page is where graphics have their one view). */
  adoptConsole?: PveConsoleLaunch;
  pveConsoles?: { attach: PveConsolesApi["attach"]; close: PveConsolesApi["close"]; takeover?: PveConsolesApi["takeover"]; preload?: PveConsolesApi["preload"]; tabs?: PveConsolesApi["tabs"] };
  bus?: HubBus;
}

type Screen = { type: "edit"; profile: Profile | null; key: number } | { type: "credentials" } | { type: "import" } | { type: "agents" } | { type: "add-pve" } | { type: "guests"; profileId: string; key: number };

const SSH_ID = "ssh";
const RDP_ID = "rdp";
const STATE: Record<SshPageStatus["state"] | RdpPageStatus["state"], DeskSessionState> = {
  idle: "not_connected",
  connecting: "connecting",
  waiting: "waiting",
  running: "active",
  detached: "lost",
  closed: "disconnected",
  error: "error",
};
const placeholder = (id: string, title: string): DeskSession => ({ id, kind: id === RDP_ID ? "rdp" : "ssh", title, detail: "", target: { type: "quick", kind: id === RDP_ID ? "rdp" : "ssh", nonce: 0 }, state: "not_connected", owner: "human", attempt: 0, reason: null });
const addressOf = (p: Profile): string => (p.username === null ? p.host : `${p.username}@${p.host}`);
const text = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export function HubPage(props: HubPageProps) {
  const bus = props.bus ?? defaultBus;
  const store = useDeskStore();
  const desk = useDesk(store);
  const api = props.profiles;
  const data = useProfiles(api);
  const { reload } = data;
  const [screen, setScreen] = useState<Screen | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [sshLaunch, setSshLaunch] = useState<SshLaunch | undefined>(undefined);
  const [rdpPrefill, setRdpPrefill] = useState<RdpPrefill | undefined>(undefined);
  const [consoleLaunch, setConsoleLaunch] = useState<PveConsoleLaunch | undefined>(undefined);
  const nonce = useRef(0);
  const sshActions = useRef<SessionActions | null>(null);
  const rdpActions = useRef<SessionActions | null>(null);
  const credentialsApi = props.credentials;
  const credentialData = useCredentials(credentialsApi, screen?.type === "credentials");

  const adopted = useRef(0);
  if (props.adoptConsole !== undefined && props.adoptConsole.nonce !== adopted.current && props.pveConsoles !== undefined) {
    adopted.current = props.adoptConsole.nonce;
    setConsoleLaunch(props.adoptConsole);
    setScreen(null);
  }

  /** The saved connections changed here: this page and BB's sidebar both read them again. */
  const changed = useCallback(async () => {
    bus.changed();
    await reload();
  }, [bus, reload]);

  const connect = useCallback(
    (p: Profile) => {
      if (p.protocol === "pve") return;
      setScreen(null);
      setNotice(null);
      nonce.current += 1;
      const id = p.protocol === "ssh" ? SSH_ID : RDP_ID;
      // SSH connects at once; RDP fills its form and waits for the owner (a password, Connect).
      // One SSH and one RDP session for now: connecting another connection of that kind replaces the entry.
      if (store.get().sessions.some((s) => s.id === id && !(s.target.type === "profile" && s.target.profileId === p.id))) store.close(id);
      store.open({ id, kind: p.protocol, title: p.name, detail: addressOf(p), target: { type: "profile", profileId: p.id }, state: p.protocol === "ssh" ? "connecting" : "not_connected", owner: "human", attempt: 0, reason: null });
      if (p.protocol === "ssh") setSshLaunch({ nonce: nonce.current, profileId: p.id, target: profileToSshTarget(p), ...(p.credentialRef !== null ? { credentialRef: p.credentialRef } : {}) });
      else setRdpPrefill({ nonce: nonce.current, profileId: p.id, ...profileToRdpForm(p) });
    },
    [store],
  );

  const run = useRef<(command: HubCommand) => void>(() => undefined);
  run.current = (command) => {
    const find = async (id: string): Promise<Profile | null> => data.profiles?.find((p) => p.id === id) ?? (api === undefined ? null : ((await api.list()).find((p) => p.id === id) ?? null));
    setConfirmDelete(false);
    switch (command.type) {
      case "desk":
        setScreen(null);
        return;
      case "connect":
        void find(command.profileId).then((p) => p !== null && connect(p));
        return;
      case "console":
        if (props.pveConsoles === undefined) return;
        setScreen(null);
        setConsoleLaunch({ nonce: ++nonce.current, profileId: command.profileId, connectionName: command.connectionName, request: command.request, title: command.title });
        return;
      case "edit":
        if (command.profileId === null) setScreen({ type: "edit", profile: null, key: ++nonce.current });
        else void find(command.profileId).then((p) => p !== null && setScreen({ type: "edit", profile: p, key: ++nonce.current }));
        return;
      case "add-pve":
        setScreen({ type: "add-pve" });
        return;
      case "guests":
        setScreen({ type: "guests", profileId: command.profileId, key: ++nonce.current });
        return;
      default:
        setScreen({ type: command.type });
    }
  };
  useEffect(() => bus.subscribe((command) => run.current(command)), [bus]);

  const editing = screen?.type === "edit" ? screen.profile : null;
  const save = useCallback(
    async (fields: ProfileFields, secret: SecretAction) => {
      if (api === undefined) return;
      // A new profile has no id key at all: BB's RPC refuses an undefined value.
      const saved = await api.save(editing !== null ? { id: editing.id, fields } : { fields });
      if (editing?.credentialRef != null && saved.credentialRef === null) setNotice(tx("notice.passwordForgotten"));
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
          setScreen((cur) => (cur?.type === "edit" ? { ...cur, profile: saved } : cur));
          await changed();
          throw new Error(tx("notice.savedNoPassword", { reason: errorTextFromMessage(text(e)) }));
        }
      }
      setScreen(null);
      await changed();
    },
    [api, credentialsApi, editing, changed],
  );

  const act = async (work: () => Promise<unknown>): Promise<void> => {
    setNotice(null);
    try {
      await work();
    } catch (e) {
      setNotice(text(e));
    }
    await changed();
  };

  const onSshStatus = useCallback((s: SshPageStatus) => store.patch(SSH_ID, { state: STATE[s.state], owner: s.owner, reason: s.error }), [store]);
  const onRdpStatus = useCallback((s: RdpPageStatus) => store.patch(RDP_ID, { state: STATE[s.state], owner: s.owner, reason: s.error }), [store]);
  const closeSsh = useCallback(async () => {
    await sshActions.current?.disconnect();
    store.close(SSH_ID);
  }, [store]);
  const closeRdp = useCallback(async () => {
    await rdpActions.current?.disconnect();
    store.close(RDP_ID);
  }, [store]);

  const sshSession = desk.sessions.find((s) => s.id === SSH_ID) ?? placeholder(SSH_ID, "SSH");
  const rdpSession = desk.sessions.find((s) => s.id === RDP_ID) ?? placeholder(RDP_ID, "RDP");
  const ended = (s: DeskSession): boolean => s.state === "disconnected" || s.state === "lost" || s.state === "error";
  const paneActions = (session: DeskSession, actions: { current: SessionActions | null }, close: () => Promise<void>, reconnect?: () => void) => (
    <>
      {reconnect !== undefined && ended(session) && (
        <Button type="button" size="sm" variant="outline" onClick={reconnect}>
          {tx("session.reconnect")}
        </Button>
      )}
      {!ended(session) && session.state !== "not_connected" && (
        <Button type="button" size="sm" variant="ghost" onClick={() => void actions.current?.disconnect()}>
          {tx("session.disconnect")}
        </Button>
      )}
      <Button type="button" size="sm" variant="ghost" onClick={() => void close()}>
        {tx("session.close")}
      </Button>
    </>
  );

  return (
    <div className="rh-tokens flex h-full min-h-0 flex-col bg-background text-foreground" data-testid="hub-page">
      {notice !== null && (
        <p className="shrink-0 border-b border-border px-4 py-2 text-sm text-destructive" role="alert">
          {notice}
        </p>
      )}
      {screen !== null && (
        <div className="flex min-h-0 flex-1 flex-col" data-testid="hub-screen">
          <div className="flex h-[var(--rh-header)] shrink-0 items-center gap-2 border-b border-border px-4">
            <Button type="button" size="sm" variant="ghost" onClick={() => setScreen(null)}>
              ← {tx("desk.back")}
            </Button>
            <span className="flex-1" />
            {editing !== null && api !== undefined && !confirmDelete && (
              <>
                <Button type="button" size="sm" variant="ghost" onClick={() => void act(() => api.duplicate(editing.id))}>
                  {tx("profile.duplicate")}
                </Button>
                <Button type="button" size="sm" variant="ghost" onClick={() => setConfirmDelete(true)}>
                  {tx("profile.delete")}
                </Button>
              </>
            )}
            {editing !== null && api !== undefined && confirmDelete && (
              <>
                <span className="truncate text-sm text-muted-foreground">{tx("profile.deleteConfirm", { name: editing.name })}</span>
                <Button
                  type="button"
                  size="sm"
                  variant="destructive"
                  onClick={() => {
                    setConfirmDelete(false);
                    setScreen(null);
                    void act(async () => {
                      const result = await api.remove(editing.id, true);
                      if (result.credentialError !== undefined) throw new Error(tx("notice.deletedNoPassword", { reason: errorCodeText(result.credentialError) }));
                    });
                  }}
                >
                  {tx("profile.delete")}
                </Button>
                <Button type="button" size="sm" variant="ghost" onClick={() => setConfirmDelete(false)}>
                  {tx("profile.cancel")}
                </Button>
              </>
            )}
          </div>
          <div className="rh-root min-h-0 flex-1 overflow-y-auto p-4">
            {screen.type === "edit" && (
              <ProfileEditor
                key={screen.key}
                initial={screen.profile === null ? null : profileFieldsOf(screen.profile)}
                {...(props.agents !== undefined ? { agentAccess: { api: props.agents, profileId: screen.profile === null ? null : screen.profile.id } } : {})}
                onSave={save}
                onCancel={() => setScreen(null)}
              />
            )}
            {screen.type === "credentials" && credentialsApi !== undefined && (
              <CredentialsPanel
                items={credentialData.items}
                error={credentialData.error}
                onCheck={(ref) => credentialsApi.status(ref)}
                onAllow={async (ref) => {
                  const r = await credentialsApi.allow(ref);
                  await credentialData.reload();
                  bus.changed();
                  return r;
                }}
                onAllowAll={async () => {
                  const { results } = await credentialsApi.allowAll();
                  await credentialData.reload();
                  bus.changed();
                  return results;
                }}
                onChange={async (ref, secret) => {
                  await credentialsApi.update(ref, secret);
                  await credentialData.reload();
                }}
                onDelete={async (ref) => {
                  await credentialsApi.remove(ref);
                  await credentialData.reload();
                  await changed();
                }}
                onRetry={() => void credentialData.reload()}
                onClose={() => setScreen(null)}
              />
            )}
            {screen.type === "import" && props.imports !== undefined && <ImportPanel api={props.imports} onImported={() => void changed()} onClose={() => setScreen(null)} />}
            {screen.type === "agents" && props.agents !== undefined && <AgentPanel api={props.agents} profileNames={new Map((data.profiles ?? []).map((p) => [p.id, p.name]))} onClose={() => setScreen(null)} />}
            {screen.type === "guests" && props.pve !== undefined && (
              <PveTargets
                key={screen.key}
                api={props.pve}
                profileIds={[screen.profileId]}
                linkable={(data.profiles ?? []).filter((p) => p.protocol === "ssh" || p.protocol === "rdp")}
                {...(credentialsApi !== undefined ? { onAllowAccess: (ref: string) => credentialsApi.allow(ref).finally(() => bus.changed()) } : {})}
                onConnectProfile={(id) => run.current({ type: "connect", profileId: id })}
                {...(props.pveConsoles !== undefined ? { onOpenConsole: (open: Omit<PveConsoleLaunch, "nonce">) => run.current({ type: "console", ...open }) } : {})}
                onClose={() => {
                  setScreen(null);
                  bus.changed();
                }}
              />
            )}
            {screen.type === "add-pve" && props.pve !== undefined && (
              <PveOnboarding
                api={props.pve}
                onDone={() => {
                  setScreen(null);
                  void changed();
                }}
                onCancel={() => setScreen(null)}
              />
            )}
          </div>
        </div>
      )}
      <div className={screen !== null ? "hidden" : "min-h-0 flex-1"}>
        <Desk>
          <DeskPane session={sshSession} onClose={closeSsh} actions={paneActions(sshSession, sshActions, closeSsh, sshLaunch === undefined ? undefined : () => setSshLaunch({ ...sshLaunch, nonce: ++nonce.current }))}>
            <SshPage
              {...props.ssh}
              {...(sshLaunch !== undefined ? { launch: sshLaunch } : {})}
              embedded
              onStatus={onSshStatus}
              actionsRef={sshActions}
              onSshOpen={async (target, profileId, credentialRef) => {
                try {
                  return await props.ssh.onSshOpen(target, profileId, credentialRef);
                } finally {
                  void reload();
                }
              }}
            />
          </DeskPane>
          <DeskPane session={rdpSession} onClose={closeRdp} actions={paneActions(rdpSession, rdpActions, closeRdp)}>
            <RdpPage
              {...props.rdp}
              {...(rdpPrefill !== undefined ? { prefill: rdpPrefill } : {})}
              onStatus={onRdpStatus}
              actionsRef={rdpActions}
              onRdpOpen={async (target, size, profileId, options) => {
                try {
                  return await props.rdp.onRdpOpen(target, size, profileId, options);
                } finally {
                  void reload();
                }
              }}
            />
          </DeskPane>
          {props.pveConsoles !== undefined && props.pve !== undefined && (
            <PveConsoles
              desk
              api={{ open: props.pve.openConsole, attach: props.pveConsoles.attach, close: props.pveConsoles.close, ...(props.pveConsoles.takeover !== undefined ? { takeover: props.pveConsoles.takeover } : {}), ...(props.pveConsoles.preload !== undefined ? { preload: props.pveConsoles.preload } : {}), ...(props.pveConsoles.tabs !== undefined ? { tabs: props.pveConsoles.tabs } : {}) }}
              connectionName={(id) => data.profiles?.find((p) => p.id === id)?.name ?? null}
              {...(consoleLaunch !== undefined ? { launch: consoleLaunch } : {})}
            />
          )}
        </Desk>
      </div>
    </div>
  );
}
