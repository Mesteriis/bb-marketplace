import { describe, expect, it } from "vitest";
import { consoleStateOf, endStateOf, reasonText, resolveConsole, VncRelay } from "./pve-console.ts";
import type { PveConnectionView } from "./pve-targets.ts";

function sink() {
  const got: { data: number[][]; passwords: string[] } = { data: [], passwords: [] };
  return { got, sink: { data: (b: Uint8Array) => got.data.push([...b]), password: (p: string) => void got.passwords.push(p) } };
}

describe("console states and reasons", () => {
  it("maps the helper's state words and end reasons", () => {
    expect(consoleStateOf("connecting")).toBe("connecting");
    expect(consoleStateOf("open")).toBe("active");
    expect(endStateOf("closed_by_user")).toBe("disconnected");
    expect(endStateOf("idle_timeout")).toBe("disconnected");
    expect(endStateOf("remote_closed")).toBe("lost");
    expect(endStateOf("websocket_error")).toBe("lost");
  });

  it("every reason the helper can report has its own text; an unknown code gets a generic line", () => {
    for (const code of ["login_failed", "no_permission", "unreachable", "tls_untrusted", "cert_changed", "websocket_error", "guest_stopped", "guest_moved", "idle_timeout"]) {
      expect(reasonText(code)).not.toContain("The console ended (");
    }
    expect(reasonText("login_failed")).toContain("ticket");
    expect(reasonText("no_permission")).toContain("VM.Console");
    expect(reasonText("something_new")).toBe("The console ended (something_new).");
  });
});

describe("VncRelay", () => {
  it("holds the greeting and the password until the one view attaches, then hands both over once, in order", () => {
    const r = new VncRelay(1024);
    r.setPassword("pw-1");
    expect(r.push(Uint8Array.of(82, 70, 66))).toBe("ok");
    const a = sink();
    expect(r.attach(a.sink)).toEqual({ ok: true });
    expect(a.got).toEqual({ data: [[82, 70, 66]], passwords: ["pw-1"] });
    // later bytes go straight to the view
    r.push(Uint8Array.of(1, 2));
    expect(a.got.data).toEqual([[82, 70, 66], [1, 2]]);
  });

  it("a password that arrives after the view attached is delivered at once", () => {
    const r = new VncRelay(1024);
    const a = sink();
    r.attach(a.sink);
    r.setPassword("late");
    expect(a.got.passwords).toEqual(["late"]);
  });

  it("refuses a second view while one is attached, and any view after the first one left", () => {
    const r = new VncRelay(1024);
    const a = sink();
    r.attach(a.sink);
    expect(r.attach(sink().sink)).toEqual({ ok: false, code: "vnc_view_taken" });
    r.detach();
    expect(r.attach(sink().sink)).toEqual({ ok: false, code: "vnc_not_resumable" });
  });

  it("never gives the password to a second view, and forgets it when the view leaves or the session ends", () => {
    const r = new VncRelay(1024);
    r.setPassword("pw-2");
    r.dispose();
    const b = sink();
    r.attach(b.sink);
    expect(b.got.passwords).toEqual([]);
    const r2 = new VncRelay(1024);
    r2.setPassword("pw-3");
    r2.detach();
    const c = sink();
    r2.attach(c.sink);
    expect(c.got.passwords).toEqual([]);
  });

  it("bounds what it holds for a view that never comes", () => {
    const r = new VncRelay(8);
    expect(r.push(new Uint8Array(8))).toBe("ok");
    expect(r.push(new Uint8Array(1))).toBe("overflow");
    const a = sink();
    r.attach(a.sink);
    expect(a.got.data).toEqual([]);
  });
});

describe("resolveConsole (a fresh read decides what is opened)", () => {
  const guest = (over: Record<string, unknown> = {}) => ({ key: "p/101", profileId: "p", vmid: 101, name: "web", kind: "lxc" as const, node: "pve2", status: "running", template: false, console: { available: true, reason: null }, linkedProfileId: null, ...over });
  const view = (over: Partial<PveConnectionView> = {}): PveConnectionView => ({
    profileId: "p",
    profileName: "lab",
    outcome: "ok",
    message: null,
    fingerprint: null,
    version: "9.0.3",
    nodes: [
      { node: "pve1", status: "online" },
      { node: "pve2", status: "online" },
      { node: "pve3", status: "offline" },
    ],
    guests: [guest(), guest({ vmid: 102, name: "vm", kind: "qemu", node: "pve1" }), guest({ vmid: 103, status: "stopped" }), guest({ vmid: 104, template: true, status: "stopped" })],
    fetchedAt: "2026-11-19T10:00:00Z",
    stale: null,
    ...over,
  });

  it("uses the guest's CURRENT node, not the one the page remembered", () => {
    expect(resolveConsole(view(), { console: "lxc", vmid: 101 })).toEqual({ ok: true, target: { kind: "lxc", node: "pve2", vmid: 101 }, guestName: "web" });
    expect(resolveConsole(view(), { console: "qemu", vmid: 102 })).toEqual({ ok: true, target: { kind: "qemu", node: "pve1", vmid: 102 }, guestName: "vm" });
  });

  it("refuses a stopped guest, a template, a missing guest and a console of the wrong kind, with a reason each", () => {
    expect(resolveConsole(view(), { console: "lxc", vmid: 103 })).toMatchObject({ ok: false, code: "guest_stopped" });
    expect(resolveConsole(view(), { console: "lxc", vmid: 104 })).toMatchObject({ ok: false, code: "guest_is_template" });
    expect(resolveConsole(view(), { console: "lxc", vmid: 999 })).toMatchObject({ ok: false, code: "guest_not_found" });
    expect(resolveConsole(view(), { console: "qemu", vmid: 101 })).toMatchObject({ ok: false, code: "unsupported_console" });
  });

  it("a node shell needs the node to be online", () => {
    expect(resolveConsole(view(), { console: "node", node: "pve1" })).toEqual({ ok: true, target: { kind: "node", node: "pve1" }, guestName: null });
    expect(resolveConsole(view(), { console: "node", node: "pve3" })).toMatchObject({ ok: false, code: "node_offline" });
    expect(resolveConsole(view(), { console: "node", node: "nope" })).toMatchObject({ ok: false, code: "guest_not_found" });
  });

  it("never opens from stale lists or a failed read, and keeps the certificate a refusal showed", () => {
    expect(resolveConsole(view({ stale: { ageSeconds: 5 } }), { console: "lxc", vmid: 101 })).toMatchObject({ ok: false, code: "unreachable" });
    const fp = Array.from({ length: 32 }, () => "AB").join(":");
    expect(resolveConsole(view({ outcome: "tls_untrusted", message: "cert", fingerprint: fp, guests: [], nodes: [] }), { console: "lxc", vmid: 101 })).toEqual({ ok: false, code: "tls_untrusted", message: "cert", fingerprint: fp });
    expect(resolveConsole(view({ outcome: "login_failed", message: "refused" }), { console: "node", node: "pve1" })).toMatchObject({ ok: false, code: "login_failed" });
  });
});
