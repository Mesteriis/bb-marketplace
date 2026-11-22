// @vitest-environment jsdom
import { useEffect } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { RemoteEmbedOverlay } from "./embed-overlay.tsx";
import { DocumentRefs, type RemoteEmbedApi } from "./embed-owner.ts";
import type { RdpCanvasProps } from "../../ui/rdp-canvas.tsx";
import type { VncViewProps } from "../../ui/vnc-view.tsx";
import type { SshTerminalProps } from "../../ui/ssh-terminal.tsx";
import type { Provider } from "./embed-wire.ts";

const ref = "12345678-1234-4123-8123-123456789abc";
const handle = { generation: "99999999999999999999999999999999", sessionId: 7 };
vi.mock("../../ui/ssh-terminal.tsx", () => ({
  SshTerminal: ({ onLive, onStateChange }: SshTerminalProps) => (
    <>
      <button onClick={onLive}>SSH live</button>
      <button onClick={() => onStateChange?.("closed", { reason: "helper_exited", exitCode: null, signal: null })}>helper exit</button>
    </>
  ),
}));
vi.mock("../../ui/rdp-canvas.tsx", () => ({
  RdpCanvas: ({ onFullFrame }: RdpCanvasProps) => <button onClick={onFullFrame}>RDP frame</button>,
}));
const { vncDetached } = vi.hoisted(() => ({ vncDetached: vi.fn() }));
vi.mock("../../ui/vnc-view.tsx", () => ({
  VncView: ({ onViewState }: VncViewProps) => {
    useEffect(() => () => { vncDetached(); }, []);
    return <button onClick={() => onViewState?.("ready")}>VNC ready</button>;
  },
}));
afterEach(() => {
  cleanup();
  document.body.replaceChildren();
  vi.restoreAllMocks();
});
function container(provider: Provider, instanceId = "view-1") {
  const layer = document.querySelector("main") ?? document.body.appendChild(document.createElement("main"));
  layer.dataset.chertogEmbedLayer = "v1";
  const host = layer.appendChild(document.createElement("section"));
  host.dataset.liveHost = instanceId;
  const target = host.appendChild(document.createElement("div"));
  Object.assign(target.dataset, { chertogEmbedTarget: "v1", provider, instanceId, generation: "1" });
  const base = { version: "chertog.embed.v1", provider, instanceId, generation: 1 };
  const responses: Record<string, unknown>[] = [];
  target.addEventListener("chertog.embed.v1.owner", (e) => responses.push((e as CustomEvent).detail));
  const send = (fields: Record<string, unknown>) =>
    act(() => {
      target.dispatchEvent(new CustomEvent("chertog.embed.v1.host", { bubbles: true, composed: false, detail: { ...base, ...fields } }));
    });
  return { base, host, target, responses, send };
}
function setup(provider: Provider) {

  const c = container(provider);
  const kind = provider === "remote-ssh-live" ? "ssh" : provider === "remote-rdp-live" ? "rdp" : "vnc";
  const api = {
    list: vi.fn(
      async () =>
        [
          {
            ...handle,
            kind,
            state: kind === "rdp" ? "connecting" : "running",
            ...(kind === "rdp" && {
              rdp: {
                state: "desktop_ready",
                desktop: { frameId: 1, width: 2, height: 2 },
                target: { host: "rdp.test", port: 3389, username: "owner", domain: null },
                prompt: null,
                trace: [],
              },
            }),
            exitCode: null,
            signal: null,
            reason: null,
          },
        ] as Awaited<ReturnType<RemoteEmbedApi["list"]>>,
    ),
    resourceRef: vi.fn(async (_handle: typeof handle) => ref as string | null),
    attach: vi.fn(async () => ({ wsUrl: "ws://localhost/attach", token: "private-token" })),
    close: vi.fn(async () => ({})),
    takeover: vi.fn(async () => ({})),
  };
  const queries: unknown[] = [];
  const listen = (e: Event) => queries.push((e as CustomEvent).detail);
  document.addEventListener("chertog.embed.v1.query", listen);
  const root = render(<RemoteEmbedOverlay refs={new DocumentRefs()} api={api} />);
  document.removeEventListener("chertog.embed.v1.query", listen);
  expect(queries).toContainEqual({ version: "chertog.embed.v1", provider, kind: "query" });
  return { ...c, api, root, kind };
}
async function choose(c: ReturnType<typeof setup>) {
  c.send({ kind: "announce", mode: "choose" });
  expect(c.responses).toEqual([{ ...c.base, kind: "choosing" }]);
  fireEvent.click(await screen.findByRole("button", { name: c.kind.toUpperCase() + " · 7" }));
  await waitFor(() => expect(c.responses.at(-1)).toEqual({ ...c.base, kind: "selected", resourceRef: ref }));
  c.send({ kind: "announce", resourceRef: "00000000-0000-4000-8000-000000000001" });
  expect(c.api.attach).not.toHaveBeenCalled();
  c.send({ kind: "announce", resourceRef: ref });
  const button = await screen.findByRole("button", { name: { ssh: "SSH live", rdp: "RDP frame", vnc: "VNC ready" }[c.kind] });
  fireEvent.click(button);
  expect(c.responses.at(-1)).toEqual({ ...c.base, kind: "ready" });
  return button;
}
it.each(["remote-ssh-live", "remote-rdp-live", "remote-vnc-live"] as const)(
  "keeps the selected %s view across layout changes and revokes it on unmount",
  async (provider) => {
    const c = setup(provider);
    const button = await choose(c);
    c.send({ kind: "visibility", visible: false });
    expect(button.closest("[inert]")).toBeTruthy();
    c.host.parentElement!.append(c.host);
    c.send({ kind: "announce", resourceRef: ref });
    c.send({ kind: "visibility", visible: true });
    expect(button.isConnected).toBe(true);
    expect(button.closest("[inert]")).toBeNull();
    expect(c.api.attach).toHaveBeenCalledTimes(1);
    c.root.unmount();
    expect(c.responses.at(-1)).toEqual({ ...c.base, kind: "revoked" });
    const next = render(<RemoteEmbedOverlay refs={new DocumentRefs()} api={c.api} />);
    c.send({ kind: "announce", resourceRef: ref });
    expect(c.responses.at(-1)).toEqual({ ...c.base, kind: "lost" });
    expect(c.api.attach).toHaveBeenCalledTimes(1);
    next.unmount();
  },
);
it("returns the canonical SSH ref in two independent pickers, including before either selection is accepted", async () => {
  const c = setup("remote-ssh-live");
  const second = container("remote-ssh-live", "view-2");
  for (const picker of [c, second]) {
    picker.send({ kind: "announce", mode: "choose" });
    fireEvent.click(await within(picker.target).findByRole("button", { name: "SSH · 7" }));
    await waitFor(() => expect(picker.responses.at(-1)).toEqual({ ...picker.base, kind: "selected", resourceRef: ref }));
  }
  expect(c.api.resourceRef).toHaveBeenCalledTimes(2);
  expect(c.api.attach).not.toHaveBeenCalled();
});

it("reports denied when the VNC viewer is already occupied during selection", async () => {
  const c = setup("remote-vnc-live");
  c.api.resourceRef.mockResolvedValue(null);
  c.send({ kind: "announce", mode: "choose" });
  fireEvent.click(await screen.findByText("VNC · 7"));
  await waitFor(() => expect(c.responses.at(-1)).toEqual({ ...c.base, kind: "denied" }));
  expect(c.api.attach).not.toHaveBeenCalled();
});

it("keeps, hides or closes the unique VNC view only on the owner's decision", async () => {
  const c = setup("remote-vnc-live");
  await choose(c);
  const other = container("remote-vnc-live", "other");
  other.send({ kind: "announce", resourceRef: ref });
  await waitFor(() => expect(other.responses.at(-1)?.kind).toBe("denied"));
  expect(c.api.attach).toHaveBeenCalledTimes(1);
  for (const [label, status] of [
    ["Оставить", "keep"],
    ["Скрыть", "hide"],
  ]) {
    c.send({ kind: "close" });
    c.send({ kind: "close" });
    fireEvent.click(screen.getByRole("button", { name: label }));
    expect(c.responses.at(-1)).toEqual({ ...c.base, kind: status });
  }
  expect(c.api.close).not.toHaveBeenCalled();
  c.send({ kind: "close" });
  fireEvent.click(screen.getByRole("button", { name: "Завершить консоль" }));
  await waitFor(() => expect(c.responses.at(-1)?.kind).toBe("ended"));
  c.send({ kind: "release" });
  expect(c.api.close).toHaveBeenCalledTimes(1);
});
it("unmounts the unique VNC viewer exactly once on release", async () => {
  const c = setup("remote-vnc-live");
  const button = await choose(c);
  vncDetached.mockClear();
  c.send({ kind: "visibility", visible: false });
  expect(vncDetached).not.toHaveBeenCalled();
  c.send({ kind: "release" });
  c.send({ kind: "release" });
  c.send({ kind: "announce", resourceRef: ref });
  expect(button.isConnected).toBe(false);
  expect(vncDetached).toHaveBeenCalledTimes(1);
  expect(c.api.attach).toHaveBeenCalledTimes(1);
  expect(c.api.close).not.toHaveBeenCalled();
});
it("loses SSH on helper exit without reconnecting; ignores stale generations", async () => {
  const c = setup("remote-ssh-live");
  await choose(c);
  fireEvent.click(screen.getByText("helper exit"));
  c.send({ kind: "announce", resourceRef: ref });
  expect(c.responses.at(-1)).toEqual({ ...c.base, kind: "lost" });
  c.send({ kind: "release" });
  const count = c.responses.length;
  c.send({ kind: "announce", resourceRef: ref });
  expect(c.responses).toHaveLength(count);
  expect(c.api.attach).toHaveBeenCalledTimes(1);
});
it("ignores the selected UUID from a cancelled generation", async () => {
  const c = setup("remote-ssh-live");
  c.send({ kind: "announce", mode: "choose" });
  fireEvent.click(await screen.findByText("SSH · 7"));
  await waitFor(() => expect(c.responses.at(-1)?.kind).toBe("selected"));
  fireEvent.click(screen.getByText("Отмена"));
  expect(c.responses.at(-1)?.kind).toBe("cancelled");
  c.send({ kind: "release" });
  c.target.dataset.generation = "2";
  c.send({ kind: "announce", generation: 2, mode: "choose" });
  c.send({ kind: "announce", generation: 2, resourceRef: ref });
  expect(c.responses.at(-1)).toEqual({ ...c.base, generation: 2, kind: "choosing" });
  expect(c.api.attach).not.toHaveBeenCalled();
});
