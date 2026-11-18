// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ImportOutcome, ImportSource, ScanResult } from "../core/import-book.ts";
import { ImportPanel, type ImportApi } from "./import-panel.tsx";

afterEach(cleanup);

function fakeApi(over: Partial<ImportApi> = {}) {
  let sources: ImportSource[] = [];
  const api = {
    suggestions: vi.fn(async () => [{ kind: "ssh-config" as const, path: "/h/.ssh/config", label: "SSH config" }, { kind: "agent" as const, path: null, label: "SSH agent" }]),
    list: vi.fn(async () => sources),
    add: vi.fn(async (input) => {
      const s: ImportSource = { id: "s" + (sources.length + 1), enabled: false, useSshG: false, ...input };
      sources = [...sources, s];
      return s;
    }),
    set: vi.fn(async (input) => {
      sources = sources.map((s) => (s.id === input.id ? { ...s, ...(input.enabled !== undefined ? { enabled: input.enabled } : {}), ...(input.useSshG !== undefined ? { useSshG: input.useSshG } : {}) } : s));
      return sources.find((s) => s.id === input.id) as ImportSource;
    }),
    remove: vi.fn(async (id: string) => {
      sources = sources.filter((s) => s.id !== id);
      return { removed: true };
    }),
    scan: vi.fn(async (): Promise<ScanResult> => ({ kind: "ssh-config", scanId: "scan-1", incomplete: false, items: [], stale: [], issues: [] })),
    apply: vi.fn(async (): Promise<ImportOutcome> => ({ created: 1, updated: 0, unchanged: 0, conflicts: [], deletedLocally: [], skipped: [], markedStale: 0 })),
    trusted: vi.fn(async () => [] as Array<{ key: string; hosts: string[]; hashed: boolean; keyType: string; fingerprint: string }>),
    forget: vi.fn(async () => ({ removed: 1 })),
    rdpCerts: vi.fn(async () => [] as Array<{ host: string; port: number; fingerprint: string; addedAt: string }>),
    forgetRdpCert: vi.fn(async () => ({ removed: true })),
    ...over,
  };
  return api as unknown as ImportApi & typeof api;
}

const item = (over: Record<string, unknown> = {}) => ({ key: "build", name: "build", action: "create" as const, resolved: true, flags: [] as string[], host: "build.example.test", port: 2222, username: "ci", identityFile: null, skip: null, ...over });

async function mount(api: ImportApi, onImported = vi.fn()) {
  render(<ImportPanel api={api} onImported={onImported} onClose={() => {}} />);
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  return onImported;
}

describe("ImportPanel", () => {
  it("offers suggested sources as strings; adding one registers it OFF and nothing is scanned", async () => {
    const api = fakeApi();
    await mount(api);
    expect(screen.getByText("Nothing is read until you switch a source on.", { exact: false })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Add SSH config" }));
    await waitFor(() => expect(screen.getByLabelText("Read this source")).toBeTruthy());
    expect((screen.getByLabelText("Read this source") as HTMLInputElement).checked).toBe(false);
    expect((screen.getByRole("button", { name: "Scan SSH config" }) as HTMLButtonElement).disabled).toBe(true);
    expect(api.scan).not.toHaveBeenCalled();
  });

  it("ssh -G has its own switch, shown only for an enabled ssh config, with the warning in words", async () => {
    const api = fakeApi();
    await mount(api);
    fireEvent.click(screen.getByRole("button", { name: "Add SSH config" }));
    await waitFor(() => screen.getByLabelText("Read this source"));
    expect(screen.queryByLabelText(/ssh -G/)).toBeNull();
    fireEvent.click(screen.getByLabelText("Read this source"));
    const g = await screen.findByLabelText(/Allow ssh -G for entries I choose/);
    expect(g.parentElement?.textContent).toContain("Match exec");
    expect((g as HTMLInputElement).checked).toBe(false);
    fireEvent.click(g);
    await waitFor(() => expect(api.set).toHaveBeenCalledWith({ id: "s1", useSshG: true }));
  });

  it("scan lists entries with what would happen; new ones are ticked, already-imported ones cannot be; unresolved ones say a password cannot be saved; only ticked entries are imported", async () => {
    const api = fakeApi({
      scan: vi.fn(async (): Promise<ScanResult> => ({
        kind: "ssh-config",
        scanId: "scan-1",
        incomplete: false,
        items: [item(), item({ key: "jump", name: "jump", resolved: false, flags: ["proxy"], port: null, username: null, host: "jump" }), item({ key: "old", name: "old", action: "unchanged" })],
        stale: ["gone"],
        issues: [],
      })),
    });
    const imported = await mount(api);
    fireEvent.click(screen.getByRole("button", { name: "Add SSH config" }));
    await waitFor(() => screen.getByLabelText("Read this source"));
    fireEvent.click(screen.getByLabelText("Read this source"));
    await waitFor(() => expect((screen.getByRole("button", { name: "Scan SSH config" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Scan SSH config" }));
    const scan = await screen.findByLabelText("Scan result");
    expect(scan.textContent).toContain("ci@build.example.test:2222");
    expect(scan.textContent).toContain("Uses your SSH config as it is; a password cannot be saved for it.");
    expect(scan.textContent).toContain("goes through a proxy or jump host");
    expect(scan.textContent).toContain("No longer in the source: gone.");
    const box = (name: string) => screen.getByLabelText(name).querySelector("input[type=checkbox]") as HTMLInputElement;
    expect(box("build").checked).toBe(true);
    expect(box("old").checked).toBe(false);
    expect(box("old").disabled).toBe(true);
    expect(box("jump").checked).toBe(true);
    fireEvent.click(box("jump")); // untick jump
    fireEvent.click(screen.getByRole("button", { name: "Import selected" }));
    await waitFor(() => expect(api.apply).toHaveBeenCalledWith("s1", ["build"], "scan-1"));
    await waitFor(() => expect(imported).toHaveBeenCalled());
    expect((await screen.findByRole("status")).textContent).toBe("1 created, 0 updated, 0 unchanged.");
  });

  it("keys: public keys with fingerprints, and the private file only named; never a way to open it", async () => {
    const api = fakeApi({
      suggestions: vi.fn(async () => [{ kind: "keys-dir" as const, path: "/h/.ssh", label: "SSH keys (public files)" }]),
      scan: vi.fn(async (): Promise<ScanResult> => ({ kind: "keys-dir", keys: [{ publicPath: "/h/.ssh/id_a.pub", privatePath: "/h/.ssh/id_a", type: "ssh-ed25519", comment: "me@fixture", fingerprint: "SHA256:abc" }], issues: [] })),
    });
    await mount(api);
    fireEvent.click(screen.getByRole("button", { name: "Add SSH keys (public files)" }));
    await waitFor(() => screen.getByLabelText("Read this source"));
    fireEvent.click(screen.getByLabelText("Read this source"));
    await waitFor(() => expect((screen.getByRole("button", { name: "Scan SSH keys (public files)" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Scan SSH keys (public files)" }));
    const scan = await screen.findByLabelText("Scan result");
    expect(scan.textContent).toContain("SHA256:abc");
    expect(scan.textContent).toContain("Private key files are never opened");
    expect(scan.textContent).toContain("Private file: /h/.ssh/id_a");
    expect(screen.queryByRole("button", { name: /Import selected/ })).toBeNull();
  });

  it("an error from the service is shown, and switching a source off closes its scan", async () => {
    const api = fakeApi({ scan: vi.fn(async () => { throw new Error("source_unreadable: the file could not be read"); }) });
    await mount(api);
    fireEvent.click(screen.getByRole("button", { name: "Add SSH config" }));
    await waitFor(() => screen.getByLabelText("Read this source"));
    fireEvent.click(screen.getByLabelText("Read this source"));
    await waitFor(() => expect((screen.getByRole("button", { name: "Scan SSH config" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Scan SSH config" }));
    expect((await screen.findByRole("alert")).textContent).toContain("the file could not be read");
  });
});

describe("ImportPanel and host keys", () => {
  it("lists what is trusted for saved-password sessions and forgets a host on request", async () => {
    let list = [{ key: "k1", hosts: ["[box.example.test]:2222"], hashed: false, keyType: "ssh-ed25519", fingerprint: "SHA256:abc" }];
    const api = fakeApi({ trusted: vi.fn(async () => list), forget: vi.fn(async () => { list = []; return { removed: 1 }; }) });
    await mount(api);
    const area = await screen.findByLabelText("Trusted host keys");
    expect(area.textContent).toContain("[box.example.test]:2222");
    expect(area.textContent).toContain("SHA256:abc");
    fireEvent.click(screen.getByRole("button", { name: "Forget [box.example.test]:2222" }));
    await waitFor(() => expect(api.forget).toHaveBeenCalledWith("[box.example.test]:2222"));
    await waitFor(() => expect(screen.getByLabelText("Trusted host keys").textContent).toContain("None yet."));
  });

  it("a known_hosts scan trusts only the ticked keys, none by default, and says what it does", async () => {
    const api = fakeApi({
      suggestions: vi.fn(async () => [{ kind: "known-hosts" as const, path: "/h/.ssh/known_hosts", label: "Known hosts (host keys to trust)" }]),
      scan: vi.fn(async (): Promise<ScanResult> => ({
        kind: "known-hosts",
        scanId: "scan-kh",
        items: [
          { key: "a", hosts: ["a.example.test"], hashed: false, keyType: "ssh-ed25519", fingerprint: "SHA256:aaa", trusted: false },
          { key: "b", hosts: [], hashed: true, keyType: "ssh-rsa", fingerprint: "SHA256:bbb", trusted: true },
        ],
        issues: [],
      })),
      apply: vi.fn(async (): Promise<ImportOutcome> => ({ created: 1, updated: 0, unchanged: 0, conflicts: [], deletedLocally: [], skipped: [], markedStale: 0 })),
    });
    await mount(api);
    fireEvent.click(screen.getByRole("button", { name: "Add Known hosts (host keys to trust)" }));
    await waitFor(() => screen.getByLabelText("Read this source"));
    fireEvent.click(screen.getByLabelText("Read this source"));
    await waitFor(() => expect((screen.getByRole("button", { name: "Scan Known hosts (host keys to trust)" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Scan Known hosts (host keys to trust)" }));
    const scan = await screen.findByLabelText("Scan result");
    expect(scan.textContent).toContain("Nothing is trusted unless you tick it.");
    expect(scan.textContent).toContain("(hashed host name)");
    expect(scan.textContent).toContain("already trusted");
    const trust = screen.getByRole("button", { name: "Trust selected host keys" }) as HTMLButtonElement;
    expect(trust.disabled).toBe(true);
    fireEvent.click(screen.getByLabelText("a.example.test").querySelector("input") as HTMLInputElement);
    fireEvent.click(trust);
    await waitFor(() => expect(api.apply).toHaveBeenCalledWith("s1", ["a"], "scan-kh"));
    expect((await screen.findByRole("status")).textContent).toBe("1 host key(s) trusted, 0 already trusted.");
  });

  it("lists the RDP certificates trusted for good and forgets exactly the chosen one", async () => {
    const FP = "AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99";
    let list = [{ host: "win.example.test", port: 3389, fingerprint: FP, addedAt: "2026-11-18T10:00:00.000Z" }];
    const api = fakeApi({ rdpCerts: vi.fn(async () => list), forgetRdpCert: vi.fn(async () => { list = []; return { removed: true }; }) });
    await mount(api);
    const block = await screen.findByLabelText("Trusted RDP certificates");
    expect(block.textContent).toContain("win.example.test:3389");
    expect(block.textContent).toContain(FP);
    fireEvent.click(screen.getByLabelText("Forget certificate of win.example.test:3389"));
    await waitFor(() => expect(api.forgetRdpCert).toHaveBeenCalledWith("win.example.test", 3389, FP));
    await waitFor(() => expect(screen.getByLabelText("Trusted RDP certificates").textContent).toContain("None yet."));
  });
});
