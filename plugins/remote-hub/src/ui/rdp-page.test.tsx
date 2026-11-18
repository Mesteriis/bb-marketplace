// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RdpPage, type RdpPageProps } from "./rdp-page.tsx";
import { nonJsonPath } from "../core/json-wire.ts";
import type { SessionHandle } from "../core/rpc.ts";

const SECRET = "S3cr3t-MARK-91";
const FP = Array.from({ length: 32 }, (_, i) => (i + 10).toString(16).toUpperCase().padStart(2, "0")).join(":");
const PROMPT = { host: "rdp.test", port: 3389, fingerprint: FP, subject: "CN=rdp-test", issuer: "CN=issuer", notBefore: "1794882534", notAfter: "1826418534", reason: "untrusted_root" };
const HANDLE: SessionHandle = { generation: "a".repeat(32), sessionId: 4 };

class FakeWebSocket {
  static OPEN = 1;
  static instances: FakeWebSocket[] = [];
  readyState = 1;
  binaryType = "";
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onclose: ((e: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
    queueMicrotask(() => this.onopen?.());
  }
  send(data: string) {
    this.sent.push(data);
  }
  close(code = 1000) {
    this.readyState = 3;
    queueMicrotask(() => this.onclose?.({ code }));
  }
  get messages(): Array<Record<string, unknown>> {
    return this.sent.map((s) => JSON.parse(s) as Record<string, unknown>);
  }
}

beforeEach(() => {
  FakeWebSocket.instances = [];
  const g = globalThis as unknown as Record<string, unknown>;
  g.WebSocket = FakeWebSocket;
  g.ImageData = class {};
  g.requestAnimationFrame = (cb: () => void) => setTimeout(cb, 0);
  g.cancelAnimationFrame = (id: number) => clearTimeout(id);
  HTMLCanvasElement.prototype.getContext = (() => ({ putImageData() {} })) as never;
});
afterEach(cleanup);

function props(over: Partial<RdpPageProps> = {}): RdpPageProps & { calls: Record<string, ReturnType<typeof vi.fn>> } {
  const onRdpOpen = vi.fn(async () => HANDLE);
  let tokens = 0; // attach tokens are single-use: every attach gets a new one
  const onAttach = vi.fn(async () => ({ token: String(++tokens).padStart(32, "t"), wsUrl: "ws://x/attach" }));
  const onClose = vi.fn(async () => {});
  const onDecision = vi.fn(async () => {});
  const onScreenshot = vi.fn(async () => ({ frameId: 4, width: 800, height: 600, timestamp: 1, png: "QUJD" }));
  const onSavePng = vi.fn();
  return {
    onRdpOpen,
    onAttach,
    onClose,
    onDecision,
    onScreenshot,
    onSavePng,
    ...over,
    calls: { onRdpOpen, onAttach, onClose, onDecision, onScreenshot, onSavePng },
  } as never;
}

const type = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });
const flush = () => act(async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
});

async function connect(p: RdpPageProps, fill: Array<[string, string]> = []) {
  render(<RdpPage {...p} />);
  type("host", "rdp.test");
  type("user", "alice");
  type("password", SECRET);
  for (const [label, value] of fill) type(label, value);
  fireEvent.click(screen.getByText("Connect"));
  await flush();
  const socket = FakeWebSocket.instances[0];
  const say = (msg: unknown) => act(() => void socket?.onmessage?.({ data: JSON.stringify(msg) }));
  return { socket, say };
}

describe("RdpPage: one open at a time (P1)", () => {
  it("a second submit while the first open is pending does not open a second session", async () => {
    let finish!: (h: SessionHandle) => void;
    const onRdpOpen = vi.fn(() => new Promise<SessionHandle>((resolve) => (finish = resolve)));
    const p = props({ onRdpOpen: onRdpOpen as never });
    render(<RdpPage {...p} />);
    type("host", "rdp.test");
    type("user", "alice");
    type("password", SECRET);
    const form = screen.getByLabelText("host").closest("form") as HTMLFormElement;
    fireEvent.submit(form);
    fireEvent.submit(form); // Enter pressed again, or a second click racing the disabled state
    await flush();
    expect(onRdpOpen).toHaveBeenCalledTimes(1);
    await act(async () => finish(HANDLE));
    await flush();
    type("password", SECRET);
    fireEvent.submit(form);
    await flush();
    expect(onRdpOpen).toHaveBeenCalledTimes(2); // free again once the first open settled
  });
});

describe("RdpPage: the open payload is strict JSON", () => {
  it("target and size carry no undefined-valued key, with and without a domain", async () => {
    const p = props();
    await connect(p);
    expect(nonJsonPath(p.calls.onRdpOpen.mock.calls[0]?.[0])).toBeNull();
    expect(nonJsonPath(p.calls.onRdpOpen.mock.calls[0]?.[1])).toBeNull();
  });
});

describe("RdpPage: prefilled from a saved profile", () => {
  const PID = "11111111-2222-4333-8444-555555555555";
  const fill = (over: Record<string, unknown> = {}) => ({
    nonce: 1,
    profileId: PID,
    host: "win.example.test",
    port: 3390,
    username: "admin",
    domain: "CORP",
    width: 1920,
    height: 1080,
    ...over,
  });

  it("fills the endpoint, leaves the password empty and focused, and opens with the profile id and size", async () => {
    const p = props();
    render(<RdpPage {...p} prefill={fill()} />);
    expect((screen.getByLabelText("host") as HTMLInputElement).value).toBe("win.example.test");
    expect((screen.getByLabelText("port") as HTMLInputElement).value).toBe("3390");
    expect((screen.getByLabelText("user") as HTMLInputElement).value).toBe("admin");
    expect((screen.getByLabelText("domain") as HTMLInputElement).value).toBe("CORP");
    expect((screen.getByLabelText("password") as HTMLInputElement).value).toBe("");
    expect(document.activeElement).toBe(screen.getByLabelText("password"));
    type("password", SECRET);
    fireEvent.click(screen.getByText("Connect"));
    await flush();
    expect(p.calls.onRdpOpen.mock.calls).toEqual([
      [{ host: "win.example.test", port: 3390, username: "admin", password: SECRET, domain: "CORP" }, { width: 1920, height: 1080 }, PID],
    ]);
  });

  it("a profile without a desktop size uses the page default", async () => {
    const p = props();
    render(<RdpPage {...p} prefill={fill({ width: null, height: null })} />);
    type("password", SECRET);
    fireEvent.click(screen.getByText("Connect"));
    await flush();
    expect(p.calls.onRdpOpen.mock.calls[0]?.[1]).toEqual({ width: 1280, height: 800 });
  });

  it("editing the endpoint after the prefill ends the link: the open carries no profile id", async () => {
    const p = props();
    render(<RdpPage {...p} prefill={fill()} />);
    type("host", "other.example.test");
    type("password", SECRET);
    fireEvent.click(screen.getByText("Connect"));
    await flush();
    expect(p.calls.onRdpOpen.mock.calls[0]?.[2]).toBeUndefined();
  });

  it("the prefill is applied once per nonce: a re-render does not wipe what the user typed", () => {
    const p = props();
    const view = render(<RdpPage {...p} prefill={fill()} />);
    type("password", SECRET);
    view.rerender(<RdpPage {...p} prefill={fill()} />);
    expect((screen.getByLabelText("password") as HTMLInputElement).value).toBe(SECRET);
    view.rerender(<RdpPage {...p} prefill={fill({ nonce: 2, host: "second.example.test" })} />);
    expect((screen.getByLabelText("host") as HTMLInputElement).value).toBe("second.example.test");
    expect((screen.getByLabelText("password") as HTMLInputElement).value).toBe("");
  });
});

describe("RdpPage: the form", () => {
  it("cannot connect without host and user, and the password field is a password field", () => {
    render(<RdpPage {...props()} />);
    const connectButton = screen.getByText("Connect") as HTMLButtonElement;
    expect(connectButton.disabled).toBe(true);
    type("host", "rdp.test");
    expect(connectButton.disabled).toBe(true);
    type("user", "alice");
    expect(connectButton.disabled).toBe(false);
    expect((screen.getByLabelText("password") as HTMLInputElement).type).toBe("password");
  });

  it("opens with the default port 3389, no domain, and the 1280x800 desktop", async () => {
    const p = props();
    await connect(p);
    expect(p.calls.onRdpOpen.mock.calls).toEqual([[{ host: "rdp.test", port: 3389, username: "alice", password: SECRET }, { width: 1280, height: 800 }, undefined]]);
    expect(p.calls.onAttach.mock.calls).toEqual([[HANDLE]]);
  });

  it("passes a port and a domain through", async () => {
    const p = props();
    await connect(p, [["port", "3390"], ["domain", "CORP"]]);
    expect(p.calls.onRdpOpen.mock.calls[0][0]).toEqual({ host: "rdp.test", port: 3390, username: "alice", password: SECRET, domain: "CORP" });
  });

  it("refuses a bad port without calling anything", async () => {
    const p = props();
    render(<RdpPage {...p} />);
    type("host", "rdp.test");
    type("user", "alice");
    type("port", "99999");
    fireEvent.click(screen.getByText("Connect"));
    await flush();
    expect(p.calls.onRdpOpen).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toBe("port must be a whole number from 1 to 65535");
  });

  it("clears the password from the form at submit and never shows it again", async () => {
    const p = props();
    const { container } = render(<RdpPage {...p} />);
    type("host", "rdp.test");
    type("user", "alice");
    type("password", SECRET);
    expect((screen.getByLabelText("password") as HTMLInputElement).value).toBe(SECRET);
    fireEvent.click(screen.getByText("Connect"));
    expect((screen.getByLabelText("password") as HTMLInputElement).value).toBe(""); // cleared synchronously
    await flush();
    const socket = FakeWebSocket.instances[0];
    await act(async () => void socket.onmessage?.({ data: JSON.stringify({ type: "state", state: "authenticating" }) }));
    await act(async () => void socket.onmessage?.({ data: JSON.stringify({ type: "closed", exitCode: null, signal: null, reason: "auth_failed" }) }));
    expect(container.innerHTML).not.toContain(SECRET);
    // a reattach asks for a token for the handle only; the password is not sent again
    expect(p.calls.onRdpOpen.mock.calls.length).toBe(1);
  });

  it("shows an open failure with the helper's code turned into a sentence", async () => {
    const p = props({ onRdpOpen: vi.fn(async () => { throw new Error("rdp_open_failed: boom"); }) });
    render(<RdpPage {...p} />);
    type("host", "rdp.test");
    type("user", "alice");
    fireEvent.click(screen.getByText("Connect"));
    await flush();
    expect(screen.getByTestId("rdp-state").textContent).toContain("error");
    expect(screen.getByRole("alert").textContent).toBe("the RDP session could not be started");
  });
});

describe("RdpPage: states, texts and the certificate prompt", () => {
  it("shows the service's state as a sentence, announced as a status", async () => {
    const { say } = await connect(props());
    const state = screen.getByTestId("rdp-state");
    expect(state.getAttribute("role")).toBe("status");
    expect(state.getAttribute("aria-live")).toBe("polite");
    expect(state.textContent).toBe("state: connecting");
    await say({ type: "state", state: "tls" });
    expect(state.textContent).toBe("state: securing the connection (TLS)");
    await say({ type: "state", state: "authenticating" });
    expect(state.textContent).toBe("state: authenticating");
    await say({ type: "desktop", frameId: 1, width: 800, height: 600 });
    await say({ type: "state", state: "desktop_ready" });
    expect(state.textContent).toBe("state: desktop ready");
    expect(screen.getByText("desktop: 800x600")).toBeTruthy();
    expect(screen.getByText("alice@rdp.test:3389").tagName).toBe("STRONG");
  });

  it("a certificate prompt opens the dialog; every decision reaches onDecision with the presented fingerprint and the dialog closes", async () => {
    const p = props();
    const { say } = await connect(p);
    await say({ type: "cert_prompt", prompt: PROMPT });
    expect(screen.getByRole("alertdialog")).toBeTruthy();
    fireEvent.click(screen.getByText("Trust for this BB run"));
    await flush();
    expect(p.calls.onDecision.mock.calls).toEqual([[HANDLE, FP, "session_trust"]]);
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("Escape in the dialog is a reject with the presented fingerprint", async () => {
    const p = props();
    const { say } = await connect(p);
    await say({ type: "cert_prompt", prompt: PROMPT });
    fireEvent.keyDown(screen.getByRole("alertdialog"), { key: "Escape" });
    await flush();
    expect(p.calls.onDecision.mock.calls).toEqual([[HANDLE, FP, "reject"]]);
  });

  it("a refused decision stays on screen with the reason in words", async () => {
    const p = props({ onDecision: vi.fn(async () => { throw new Error("fingerprint_mismatch: the decision names a different certificate than the one presented"); }) });
    const { say } = await connect(p);
    await say({ type: "cert_prompt", prompt: PROMPT });
    fireEvent.click(screen.getByText("Accept once"));
    await flush();
    expect(screen.getByRole("alert").textContent).toBe("the decision named a different certificate than the one shown");
    expect(screen.getByRole("alertdialog")).toBeTruthy();
  });

  it("an attach onto a session waiting for a decision shows its prompt", async () => {
    const { say } = await connect(props());
    await say({ type: "attached", state: "cert_prompt", prompt: PROMPT, desktop: null, target: {} });
    expect(screen.getByTestId("rdp-cert-fingerprint").textContent).toBe(FP);
  });

  it("the dialog goes away when the state moves on", async () => {
    const { say } = await connect(props());
    await say({ type: "cert_prompt", prompt: PROMPT });
    await say({ type: "state", state: "authenticating" });
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it.each([
    ["auth_failed", "sign-in failed: check the user name, password and domain"],
    ["cert_rejected", "the server certificate was rejected"],
    ["server_disconnected", "the server ended the session"],
    ["network_error", "network error: the server is unreachable or the connection dropped"],
    ["engine_exited", "the RDP engine stopped unexpectedly"],
    ["killed_by_close", "disconnected"],
    ["helper_exited", "the Remote Hub helper exited"],
  ])("a session closed with %s says so", async (reason, text) => {
    const { say } = await connect(props());
    await say({ type: "closed", exitCode: null, signal: null, reason });
    expect(screen.getByTestId("rdp-state").textContent).toBe("state: closed");
    expect(screen.getByTestId("rdp-exit").textContent).toBe(text);
  });

  it("a socket loss is detached, not closed, and Reattach opens a fresh socket for the same handle", async () => {
    const p = props();
    const { socket } = await connect(p);
    await act(async () => void socket.onclose?.({ code: 1006 }));
    expect(screen.getByTestId("rdp-state").textContent).toBe("state: detached");
    fireEvent.click(screen.getByText("Reattach"));
    await flush();
    expect(p.calls.onAttach.mock.calls).toEqual([[HANDLE], [HANDLE]]);
    expect(FakeWebSocket.instances.map((w) => w.url)).toEqual([
      "ws://x/attach?attach=" + "t".repeat(31) + "1",
      "ws://x/attach?attach=" + "t".repeat(31) + "2",
    ]);
  });

  it("a rejected reattach shows an error, not a stuck state", async () => {
    const p = props();
    await connect(p);
    p.calls.onAttach.mockRejectedValueOnce(new Error("session_not_found: unknown"));
    fireEvent.click(screen.getByText("Reattach"));
    await flush();
    expect(screen.getByTestId("rdp-state").textContent).toBe("state: detached");
    expect(screen.getByRole("alert").textContent).toBe("the session is gone");
  });

  it("Disconnect closes the session and reports 'disconnected'", async () => {
    const p = props();
    await connect(p);
    fireEvent.click(screen.getByText("Disconnect"));
    await flush();
    expect(p.calls.onClose.mock.calls).toEqual([[HANDLE]]);
    expect(screen.getByTestId("rdp-exit").textContent).toBe("disconnected");
  });
});

describe("RdpPage: one session at a time on screen (N1, N4, N5)", () => {
  it("N1: while B is being opened, the page still shows A, drives A's socket and keeps A's handle", async () => {
    const A: SessionHandle = { generation: "a".repeat(32), sessionId: 1 };
    const B: SessionHandle = { generation: "a".repeat(32), sessionId: 2 };
    let finishB: (h: SessionHandle) => void = () => {};
    const open = vi.fn().mockResolvedValueOnce(A).mockImplementationOnce(() => new Promise<SessionHandle>((r) => (finishB = r)));
    const p = props({ onRdpOpen: open });
    const { socket, say } = await connect(p);
    await say({ type: "desktop", frameId: 1, width: 800, height: 600 });
    await say({ type: "state", state: "desktop_ready" });
    type("host", "other.test");
    type("user", "bob");
    fireEvent.click(screen.getByText("Connect"));
    await flush();
    // B is pending: the header and the canvas label still name A, and A keeps its handle.
    expect(screen.getByText("alice@rdp.test:3389").tagName).toBe("STRONG");
    expect(screen.queryByText("bob@other.test:3389")).toBeNull();
    expect(screen.getByRole("application").getAttribute("aria-label")).toBe("remote desktop alice@rdp.test:3389");
    expect(screen.getByTestId("rdp-connecting").textContent).toBe("connecting to bob@other.test:3389…");
    fireEvent.click(screen.getByText("Disconnect"));
    await flush();
    expect(p.calls.onClose.mock.calls).toEqual([[A]]);
    // B opens: now B is the session on screen, with its own handle and socket.
    await act(async () => finishB(B));
    await flush();
    expect(screen.getByText("bob@other.test:3389").tagName).toBe("STRONG");
    expect(screen.getByRole("application").getAttribute("aria-label")).toBe("remote desktop bob@other.test:3389");
    expect(FakeWebSocket.instances.length).toBe(2);
    expect(socket).not.toBe(FakeWebSocket.instances[1]);
  });

  it("N4: a failed first attach leaves Reattach and Disconnect available for the open session", async () => {
    const p = props();
    p.calls.onAttach.mockRejectedValueOnce(new Error("temporary: try again"));
    render(<RdpPage {...p} />);
    type("host", "rdp.test");
    type("user", "alice");
    fireEvent.click(screen.getByText("Connect"));
    await flush();
    expect(screen.getByTestId("rdp-state").textContent).toBe("state: detached");
    expect((screen.getByText("Reattach") as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByText("Disconnect") as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByText("Reattach"));
    await flush();
    expect(p.calls.onAttach.mock.calls).toEqual([[HANDLE], [HANDLE]]);
    expect(FakeWebSocket.instances.length).toBe(1);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("N4: Disconnect works on a session whose attach never succeeded", async () => {
    const p = props({ onAttach: vi.fn(async () => { throw new Error("temporary"); }) });
    render(<RdpPage {...p} />);
    type("host", "rdp.test");
    type("user", "alice");
    fireEvent.click(screen.getByText("Connect"));
    await flush();
    fireEvent.click(screen.getByText("Disconnect"));
    await flush();
    expect(p.calls.onClose.mock.calls).toEqual([[HANDLE]]);
    expect(screen.getByTestId("rdp-exit").textContent).toBe("disconnected");
  });

  it("N5: a reason the session already ended with is not replaced when Disconnect resolves", async () => {
    let finish: (v: { reason: string }) => void = () => {};
    const p = props({ onClose: vi.fn(() => new Promise<{ reason: string }>((r) => (finish = r))) as never });
    const { say } = await connect(p);
    fireEvent.click(screen.getByText("Disconnect"));
    await flush();
    await say({ type: "closed", exitCode: null, signal: null, reason: "engine_exited" });
    expect(screen.getByTestId("rdp-exit").textContent).toBe("the RDP engine stopped unexpectedly");
    await act(async () => finish({ reason: "killed_by_close" }));
    expect(screen.getByTestId("rdp-exit").textContent).toBe("the RDP engine stopped unexpectedly");
  });

  it("N5: otherwise the service's own close reason is shown", async () => {
    const p = props({ onClose: vi.fn(async () => ({ reason: "server_disconnected" })) as never });
    await connect(p);
    fireEvent.click(screen.getByText("Disconnect"));
    await flush();
    expect(screen.getByTestId("rdp-exit").textContent).toBe("the server ended the session");
  });

  it("the rest of the page is inert while the certificate dialog is open", async () => {
    const { say } = await connect(props());
    const main = document.querySelector(".rh-rdp-main") as HTMLElement;
    expect(main.hasAttribute("inert")).toBe(false);
    await say({ type: "cert_prompt", prompt: PROMPT });
    expect(main.hasAttribute("inert")).toBe(true);
    expect(main.contains(screen.getByRole("alertdialog"))).toBe(false);
  });
});

describe("RdpPage: the header buttons", () => {
  it("Ctrl+Alt+Del and Screenshot wait for the desktop; Ctrl+Alt+Del goes through the socket", async () => {
    const { socket, say } = await connect(props());
    const cad = screen.getByText("Ctrl+Alt+Del") as HTMLButtonElement;
    const shot = screen.getByText("Screenshot") as HTMLButtonElement;
    expect(cad.disabled).toBe(true);
    expect(shot.disabled).toBe(true);
    await say({ type: "desktop", frameId: 1, width: 800, height: 600 });
    await say({ type: "state", state: "desktop_ready" });
    expect(cad.disabled).toBe(false);
    fireEvent.click(cad);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 5));
    });
    expect(socket.messages.filter((m) => m.type === "input")).toEqual([{ type: "input", events: [{ kind: "ctrl_alt_del" }] }]);
  });

  it("Screenshot saves the PNG under a name with the size and frame; a refusal is explained", async () => {
    const p = props();
    const { say } = await connect(p);
    await say({ type: "desktop", frameId: 1, width: 800, height: 600 });
    await say({ type: "state", state: "desktop_ready" });
    fireEvent.click(screen.getByText("Screenshot"));
    await flush();
    expect(p.calls.onSavePng.mock.calls).toEqual([["rdp-800x600-4.png", "QUJD"]]);
    p.calls.onScreenshot.mockRejectedValueOnce(new Error("screenshot_too_large: too big"));
    fireEvent.click(screen.getByText("Screenshot"));
    await flush();
    expect(screen.getByRole("alert").textContent).toBe("the screenshot is too large to send");
  });

  it("Fit and 1:1 toggle the mode of the canvas", async () => {
    await connect(props());
    const canvas = screen.getByRole("application");
    expect(canvas.className).toContain("rh-rdp-fit");
    fireEvent.click(screen.getByText("1:1"));
    expect(canvas.className).toContain("rh-rdp-actual");
    expect(screen.getByText("Fit")).toBeTruthy();
  });

  it("shows the service's notice and an error code as a sentence", async () => {
    const { say } = await connect(props());
    await say({ type: "error", code: "not_ready" });
    expect(screen.getByRole("alert").textContent).toBe("the desktop is not ready yet");
  });
});
