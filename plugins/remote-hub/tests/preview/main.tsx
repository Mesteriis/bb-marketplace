// Preview scenes with made-up data. ?scene=desk (default): the sidebar and two sessions side by side; ?scene=empty: nothing
// open; ?scene=page: the real page and sidebar over fake data sources (click through it).
import "./theme.css";
import "../../dist/app.css";
import { createRoot } from "react-dom/client";
import type { DeskSession } from "../../src/core/desk.ts";
import type { Profile } from "../../src/core/profile.ts";
import type { PveConnectionView } from "../../src/core/pve-targets.ts";
import { deskStore } from "../../src/ui/desk-store.ts";
import { Desk } from "../../src/ui/desk/desk.tsx";
import { DeskPane } from "../../src/ui/desk/desk-pane.tsx";
import { HubPage } from "../../src/ui/hub-page.tsx";
import { HubSidebarConnected } from "../../src/ui/sidebar/hub-sidebar-connected.tsx";

const scene = new URLSearchParams(location.search).get("scene") ?? "desk";
const profile = (over: Partial<Profile>): Profile => ({ executionHostId: "local", origin: "manual", createdAt: "", updatedAt: "", lastOpenedAt: null, recentErrors: [], protocol: "ssh", group: null, tags: [], favorite: false, color: null, host: "10.0.0.5", port: null, username: "root", domain: null, authType: "agent", identityFile: null, credentialRef: null, rdpWidth: null, rdpHeight: null, ...over }) as Profile;
const profiles = [
  profile({ id: "pve1", name: "Proxmox", protocol: "pve", host: "10.0.0.2", port: 8006, username: "remotehub@pve" }),
  profile({ id: "s1", name: "gateway", group: "Стенд" }),
  profile({ id: "s2", name: "win-test", protocol: "rdp", username: "admin", host: "10.0.0.70", group: "Стенд" }),
  profile({ id: "s3", name: "backup-nas", group: "Дом", host: "10.0.1.9" }),
];
const guest = (vmid: number, name: string, kind: "lxc" | "qemu", status = "running") => ({ key: `pve1/${vmid}`, profileId: "pve1", vmid, name, kind, node: "pve", status, template: false, console: { available: status === "running", reason: null }, linkedProfileId: null });
const view: PveConnectionView = { profileId: "pve1", profileName: "Proxmox", credentialRef: "c", outcome: "ok", message: null, fingerprint: null, version: "9.0", fetchedAt: null, stale: null, nodes: [{ node: "pve", status: "online" }], guests: [guest(110, "db", "lxc"), guest(112, "nginx-ui", "lxc"), guest(152, "astra-linux", "qemu", "stopped"), guest(165, "rdp-ssh-test", "lxc"), guest(170, "win11", "qemu")] };
const api = { list: async () => profiles, save: async () => profiles[1]!, remove: async () => ({ deleted: true }), duplicate: async () => profiles[1]!, sessions: async () => [] };
const pve = { targets: async () => ({ connections: [view] }) };
const never = () => new Promise<never>(() => undefined);

const session = (id: string, over: Partial<DeskSession>): DeskSession => ({ id, kind: "pve-terminal", title: id, detail: "", target: { type: "quick", kind: "ssh", nonce: Number(id.slice(1)) }, state: "active", owner: "human", attempt: 0, reason: null, ...over });
const fake = [
  session("f1", { title: "rdp-ssh-test", detail: "LXC 165 · Proxmox" }),
  session("f2", { title: "gateway", detail: "root@10.0.0.5", kind: "ssh", owner: "agent" }),
  session("f3", { title: "db", detail: "LXC 110 · Proxmox", state: "reconnecting", attempt: 2 }),
];
if (scene === "desk") {
  for (const s of fake) deskStore.open(s);
  deskStore.layout("two");
  deskStore.focus("f1");
  deskStore.focus("f2");
}

const shell = "root@rdp-ssh-test:~# systemctl status ssh\n● ssh.service - OpenBSD Secure Shell server\n     Active: active (running)\nroot@rdp-ssh-test:~# ▮";

createRoot(document.getElementById("root")!).render(
  <div className="pv-shell" data-bb-plugin="makosh-remote-hub">
    <div className="pv-rail" />
    <div className="pv-side">
      <HubSidebarConnected profiles={api as never} pve={pve} />
    </div>
    <div className="pv-main">
      {scene === "page" ? (
        <HubPage ssh={{ onSshOpen: never, onAttach: never, onClose: async () => undefined } as never} rdp={{ onRdpOpen: never, onAttach: never, onClose: async () => undefined, onDecision: never, onScreenshot: never } as never} profiles={api as never} />
      ) : (
        <Desk>
          {(scene === "desk" ? fake : []).map((s) => (
            <DeskPane key={s.id} session={deskStore.get().sessions.find((x) => x.id === s.id) ?? s} onClose={() => deskStore.close(s.id)}>
              <pre className="pv-term">{shell}</pre>
            </DeskPane>
          ))}
        </Desk>
      )}
    </div>
  </div>,
);
