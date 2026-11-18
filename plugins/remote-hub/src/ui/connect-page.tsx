// The connect page: an SSH | RDP switch over the two session pages. Both stay
// mounted (the inactive one hidden) so switching never drops a live view.
import { useState } from "react";
import { RdpPage, type RdpPageProps } from "./rdp-page.tsx";
import { SshPage, type SshPageProps } from "./ssh-page.tsx";

export type ConnectKind = "ssh" | "rdp";

export interface ConnectPageProps {
  ssh: SshPageProps;
  rdp: RdpPageProps;
  initialKind?: ConnectKind;
}

export function ConnectPage(props: ConnectPageProps) {
  const [kind, setKind] = useState<ConnectKind>(props.initialKind ?? "ssh");
  return (
    <div className="rh-connect">
      <div className="rh-kind" role="group" aria-label="connection kind">
        <button type="button" aria-pressed={kind === "ssh"} onClick={() => setKind("ssh")}>
          SSH
        </button>
        <button type="button" aria-pressed={kind === "rdp"} onClick={() => setKind("rdp")}>
          RDP
        </button>
      </div>
      <div hidden={kind !== "ssh"} className="rh-kind-pane">
        <SshPage {...props.ssh} />
      </div>
      <div hidden={kind !== "rdp"} className="rh-kind-pane">
        <RdpPage {...props.rdp} />
      </div>
    </div>
  );
}
