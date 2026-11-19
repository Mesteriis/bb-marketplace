// What a Proxmox console session is, as the rest of the plugin sees it (host-free).
//  - the console kinds and the states a header can show, with the concrete reason for a failure;
//  - the relay of a graphical console: the raw RFB stream cannot be resumed, so exactly one view may ever attach, bytes that
//    arrive before it attaches are held (bounded), and the short-lived VNC password is handed to that view once.
import type { PveConsoleTarget } from "./pve-protocol.ts";
import type { PveConnectionView } from "./pve-targets.ts";

export type PveConsoleKind = PveConsoleTarget["kind"];
export type PveConsoleState = "connecting" | "active" | "lost" | "disconnected" | "error";

export interface PveConsoleInfo {
  profileId: string;
  /** The connection's name as the owner saved it. */
  connectionName: string;
  console: PveConsoleKind;
  node: string;
  vmid: number | null;
  guestName: string | null;
  state: PveConsoleState;
  /** Why a console is in the `error` or `lost` state; fixed local text, never a server body. */
  reason: { code: string; text: string; fingerprint: string | null } | null;
  /** When the console became active and when it ended (ms since the epoch). */
  activeAt?: number | null;
  endedAt?: number | null;
}

/** The helper's state words for a console, as a header state. */
export function consoleStateOf(helperState: string): PveConsoleState {
  return helperState === "open" ? "active" : "connecting";
}

const REASON_TEXT: Record<string, string> = {
  login_failed: "Proxmox refused the login. Open the connection and enter its password again; Remote Hub does not retry a refused login on its own.",
  no_permission: "The account may not open this console. It needs VM.Console (guests) or Sys.Console (the node) in Proxmox.",
  unreachable: "The Proxmox endpoint did not answer. Check the address, the port and your network.",
  timeout: "Proxmox did not answer in time.",
  tls_untrusted: "The server certificate is not trusted. Confirm its fingerprint in the connection first.",
  cert_changed: "The server certificate is not the one you confirmed before. If you did not replace it, do not continue.",
  tfa_required: "This account asks for a second factor, which Remote Hub does not support.",
  api_error: "Proxmox could not open the console.",
  protocol_error: "Proxmox answered in a way Remote Hub does not understand (websocket error).",
  invalid_request: "This console cannot be opened.",
  unsupported_console: "This kind of console is not supported on this guest.",
  guest_stopped: "The guest is not running; Remote Hub never starts it.",
  guest_is_template: "A template has no console.",
  guest_not_found: "The guest no longer exists on this connection.",
  guest_moved: "The guest moved to another node; open the console again from the list.",
  no_credential: "This connection has no saved password or token yet.",
  websocket_error: "The console connection broke (websocket error).",
  remote_closed: "Proxmox closed the console.",
  upstream_stalled: "Proxmox stopped accepting input for the console, so it was closed.",
  engine_exited: "The console process ended unexpectedly.",
  helper_exited: "The Remote Hub helper ended.",
  node_offline: "The node is not online.",
  idle_timeout: "Closed because nobody was looking at it.",
  viewer_too_slow: "The viewer could not keep up with the console, so the console was closed (a graphics stream is never thinned out). Open it again.",
  viewer_failed: "The graphical viewer failed to start or stopped working, so the console was closed. Open it again.",
  vnc_start_timeout: "Proxmox closed the graphical console before it showed anything (its VNC proxy waits only about ten seconds for the viewer). A second try was made and failed too. Reconnect opens a new one.",
  view_closed: "The graphical view was closed, so the console was closed with it. Open it again to get a new one.",
  vnc_buffer_overflow: "The console sent data before a view attached, so it was closed.",
  vnc_view_taken: "This console is already open in another view.",
  vnc_not_resumable: "This graphical console cannot be reattached; disconnect and open it again.",
};

/** The text shown for a console's code or end reason. Unknown codes get a generic line, never the raw code's origin text. */
export function reasonText(code: string): string {
  return REASON_TEXT[code] ?? "The console ended (" + code + ").";
}

/** End reasons that are the owner's own doing: the console is `disconnected`. Everything else is `lost`. */
export function endStateOf(reason: string): "disconnected" | "lost" {
  return reason === "closed_by_user" || reason === "idle_timeout" || reason === "view_closed" || reason === "killed_by_close" ? "disconnected" : "lost";
}

export interface VncViewSink {
  /** Raw RFB bytes for noVNC. */
  data(bytes: Uint8Array): void;
  /** The one-time password for the view's RFB authentication. */
  password(password: string): void;
}

/** Unacknowledged console bytes a graphical view may have outstanding on its socket; beyond that the console is closed, never thinned out. */
export const VNC_VIEW_BACKLOG_BYTES = 4 * 1024 * 1024;
/** What the page's channel holds for noVNC before noVNC installs its handler; beyond that the viewer has failed. */
export const VNC_CHANNEL_BACKLOG_BYTES = 1024 * 1024;

export type VncAttachRefusal = "vnc_view_taken" | "vnc_not_resumable";

/**
 * The relay for one graphical console. Where the password lives: here, in the service's memory, from the helper's event until
 * it is delivered to the view (once, then forgotten), or until the session ends. It is never written anywhere else.
 */
export class VncRelay {
  private buffered: Uint8Array[] = [];
  private bufferedBytes = 0;
  private password: string | null = null;
  private sink: VncViewSink | null = null;
  private everAttached = false;
  private disposed = false;

  constructor(private readonly maxBuffered: number) {}

  /** Bytes from the console. `overflow`: nobody is looking and the held bytes passed the cap, so the console cannot be kept. */
  push(bytes: Uint8Array): "ok" | "overflow" {
    if (this.disposed) return "ok";
    if (this.sink !== null) {
      this.sink.data(bytes);
      return "ok";
    }
    this.bufferedBytes += bytes.byteLength;
    if (this.bufferedBytes > this.maxBuffered) {
      this.buffered = [];
      this.bufferedBytes = 0;
      return "overflow";
    }
    this.buffered.push(bytes);
    return "ok";
  }

  setPassword(password: string): void {
    if (this.disposed) return;
    if (this.sink !== null) {
      this.sink.password(password);
      return;
    }
    this.password = password;
  }

  attach(sink: VncViewSink): { ok: true } | { ok: false; code: VncAttachRefusal } {
    if (this.sink !== null) return { ok: false, code: "vnc_view_taken" };
    if (this.everAttached) return { ok: false, code: "vnc_not_resumable" };
    this.everAttached = true;
    this.sink = sink;
    if (this.password !== null) {
      const password = this.password;
      this.password = null;
      sink.password(password);
    }
    for (const bytes of this.buffered) sink.data(bytes);
    this.buffered = [];
    this.bufferedBytes = 0;
    return { ok: true };
  }

  /** The view went away: the stream is not resumable, so nothing more is kept for a later one. */
  detach(): void {
    this.sink = null;
    this.buffered = [];
    this.bufferedBytes = 0;
    this.password = null;
  }

  get attached(): boolean {
    return this.sink !== null;
  }

  /** The session ended: forget everything. */
  dispose(): void {
    this.disposed = true;
    this.detach();
  }
}

/** What the owner (or an agent) asks to open: a node shell, or a console of one guest by its VMID. */
export type ConsoleRequest = { console: "node"; node: string } | { console: "lxc" | "qemu"; vmid: number };

export type ConsoleResolution =
  | { ok: true; target: PveConsoleTarget; guestName: string | null }
  | { ok: false; code: string; message: string; fingerprint: string | null };

/**
 * Turns a FRESH read of the connection into the console to open. The node is a location, looked up again every time (a guest may
 * have moved); a stopped guest or a template is refused, and nothing is ever started.
 */
export function resolveConsole(view: PveConnectionView, want: ConsoleRequest): ConsoleResolution {
  const refuse = (code: string): ConsoleResolution => ({ ok: false, code, message: reasonText(code), fingerprint: null });
  if (view.outcome !== "ok" && view.outcome !== "empty") {
    // A failed live read, whatever the stale lists say: a console is never opened from old data.
    return { ok: false, code: view.outcome === "error" ? "api_error" : view.outcome, message: view.message ?? reasonText("api_error"), fingerprint: view.fingerprint };
  }
  if (view.stale !== null) return refuse("unreachable");
  if (want.console === "node") {
    const node = view.nodes.find((n) => n.node === want.node);
    if (node === undefined) return refuse("guest_not_found");
    if (node.status !== "online") return refuse("node_offline");
    return { ok: true, target: { kind: "node", node: node.node }, guestName: null };
  }
  const guest = view.guests.find((g) => g.vmid === want.vmid);
  if (guest === undefined) return refuse("guest_not_found");
  if (guest.kind !== want.console) return refuse("unsupported_console");
  if (guest.template) return refuse("guest_is_template");
  if (guest.status !== "running") return refuse("guest_stopped");
  return { ok: true, target: { kind: guest.kind, node: guest.node, vmid: guest.vmid }, guestName: guest.name };
}
