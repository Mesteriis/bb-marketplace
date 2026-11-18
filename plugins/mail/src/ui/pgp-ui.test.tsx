// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { installTestPluginRuntime } from "@get-bb/plugin-sdk/testing/app";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PgpPanel, fingerprintShown, signatureText, type PgpReadingPorts } from "./pgp-panel.tsx";
import { PgpSettings, importResultText, type PgpCertShown, type SettingsPgpPorts } from "./pgp-settings.tsx";

installTestPluginRuntime();
afterEach(cleanup);

const FINGERPRINT = "0123456789ABCDEF0123456789ABCDEF01234567";

function readingPorts(overrides: Partial<PgpReadingPorts> = {}): PgpReadingPorts {
  return {
    open: vi.fn(async () => ({
      state: "opened" as const,
      text: "Invented sealed words <b>not markup</b>",
      html: null,
      attachments: [{ fileName: "plan.pdf", size: 10 }],
      signature: { state: "valid" as const, fingerprint: FINGERPRINT, signer: null, fromSender: true },
    })),
    verify: vi.fn(async () => ({ state: "no_cert" as const, fingerprint: null, signer: "89ABCDEF01234567", fromSender: false })),
    importFromMessage: vi.fn(async () => 1),
    ...overrides,
  };
}

describe("PgpPanel", () => {
  it("decrypts only on the click and shows the text as text", async () => {
    const ports = readingPorts();
    const view = render(<PgpPanel messageId="m_1" mode="encrypted" ports={ports} />);
    expect(ports.open).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Decrypt" }));
    const text = await screen.findByLabelText("Decrypted message");
    expect(text.textContent).toBe("Invented sealed words <b>not markup</b>");
    expect(text.querySelector("b")).toBeNull();
    expect(screen.getByText(/Signed by a key you saved for this sender\./)).toBeTruthy();
    expect(screen.getByText(fingerprintShown(FINGERPRINT))).toBeTruthy();
    expect(screen.getByText(/Attachments inside \(not available here yet\): plan\.pdf/)).toBeTruthy();

    // Another message: nothing of the opened one stays on the page.
    view.rerender(<PgpPanel messageId="m_2" mode="encrypted" ports={ports} />);
    await waitFor(() => expect(screen.queryByLabelText("Decrypted message")).toBeNull());
    expect(view.container.textContent).not.toContain("Invented sealed words");
  });

  it("says why a message stays closed", async () => {
    const ports = readingPorts({
      open: vi.fn(async () => ({ state: "no_cert" as const, text: null, html: null, attachments: [], signature: null })),
    });
    render(<PgpPanel messageId="m_1" mode="encrypted" ports={ports} />);
    fireEvent.click(screen.getByRole("button", { name: "Decrypt" }));
    expect((await screen.findByRole("alert")).textContent).toBe("None of your OpenPGP keys opens this message.");
  });

  it("checks a signature and offers to save the key a message carries", async () => {
    const ports = readingPorts();
    render(<PgpPanel messageId="m_1" mode="signed" ports={ports} />);
    fireEvent.click(screen.getByRole("button", { name: "Check signature" }));
    expect(await screen.findByText(/Mail has no key for the signer/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Save the key from this message" }));
    await waitFor(() => expect(ports.importFromMessage).toHaveBeenCalledWith("m_1"));
    expect(await screen.findByText("Saved the sender's key. Check the signature again.")).toBeTruthy();
  });

  it("words each signature state", () => {
    const base = { fingerprint: FINGERPRINT, signer: null };
    expect(signatureText({ ...base, state: "valid", fromSender: false })).toMatch(/not for this sender's address/);
    expect(signatureText({ ...base, state: "invalid", fromSender: true })).toMatch(/does not match/);
    expect(fingerprintShown("ABCDEF0123")).toBe("ABCD EF01 23");
  });
});

const cert = (overrides: Partial<PgpCertShown> = {}): PgpCertShown => ({
  id: "pgp_1",
  kind: "own",
  fingerprint: FINGERPRINT,
  addresses: ["owner@example.org"],
  userIds: ["Owner <owner@example.org>"],
  createdAt: "2026-11-17T10:00:00.000Z",
  expiresAt: null,
  addedAt: "2026-11-17T10:00:00.000Z",
  source: "generated",
  expired: false,
  ...overrides,
});

const identity = (address: string) => ({
  accountId: "acc_1",
  address,
  displayName: null,
  primary: true,
  signature: null,
  sendCheck: "confirmed" as const,
});

function settingsPorts(certs: PgpCertShown[], overrides: Partial<SettingsPgpPorts> = {}): SettingsPgpPorts {
  return {
    list: vi.fn(async () => ({ certs, vaultReady: true })),
    generate: vi.fn(async () => undefined),
    importArmor: vi.fn(async () => ({ result: "added" as const, added: [cert({ id: "pgp_2", kind: "contact" })] })),
    remove: vi.fn(async () => undefined),
    exportArmor: vi.fn(async (_id: string, phrase?: string) => ({
      armor: phrase === undefined ? "invented public armor" : "invented locked armor",
      fileName: phrase === undefined ? "openpgp-public.asc" : "openpgp-private-backup.asc",
    })),
    ...overrides,
  };
}

describe("PgpSettings", () => {
  it("makes a key for an address that has none, from the interface", async () => {
    const ports = settingsPorts([]);
    render(<PgpSettings ports={ports} identities={[identity("owner@example.org")]} />);
    expect(await screen.findByText("owner@example.org has no key")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Make a key" }));
    await waitFor(() => expect(ports.generate).toHaveBeenCalledWith("acc_1", "owner@example.org"));
    expect(await screen.findByText(/Back it up/)).toBeTruthy();
  });

  it("backs a key up only with a passphrase of 8 characters, and removes it after a second click", async () => {
    const ports = settingsPorts([cert()]);
    render(<PgpSettings ports={ports} identities={[identity("owner@example.org")]} />);
    await screen.findByRole("listitem", { name: "owner@example.org" });
    expect(screen.queryByText("owner@example.org has no key")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Back up…" }));
    const make = screen.getByRole("button", { name: "Make the backup" }) as HTMLButtonElement;
    const words = ["invented", "words"].join(" ");
    fireEvent.change(screen.getByLabelText("Backup passphrase"), { target: { value: words.slice(0, 5) } });
    expect(make.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Backup passphrase"), { target: { value: words } });
    fireEvent.click(make);
    await waitFor(() => expect(ports.exportArmor).toHaveBeenCalledWith("pgp_1", words));
    expect(((await screen.findByLabelText("openpgp-private-backup.asc")) as HTMLTextAreaElement).value).toBe("invented locked armor");
    // The passphrase is gone from the page with its form.
    expect(screen.queryByLabelText("Backup passphrase")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    expect(ports.remove).not.toHaveBeenCalled();
    expect(screen.getByText(/can never be read again/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Yes, remove my key" }));
    await waitFor(() => expect(ports.remove).toHaveBeenCalledWith("pgp_1"));
  });

  it("adds a pasted key and says what went wrong with one it cannot use", async () => {
    const ports = settingsPorts([], {
      importArmor: vi
        .fn()
        .mockResolvedValueOnce({ result: "unreadable", added: [] })
        .mockResolvedValueOnce({ result: "added", added: [cert({ id: "pgp_2", kind: "contact" })] }),
    });
    render(<PgpSettings ports={ports} identities={[]} />);
    await screen.findByText(/None yet/);
    const box = screen.getByLabelText("Key text") as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: "not a key" } });
    fireEvent.click(screen.getByRole("button", { name: "Add key" }));
    expect((await screen.findByRole("alert")).textContent).toBe(importResultText("unreadable", 0));
    fireEvent.click(screen.getByRole("button", { name: "Add key" }));
    expect(await screen.findByText("Saved 1 key.")).toBeTruthy();
    expect(box.value).toBe("");
    expect(ports.importArmor).toHaveBeenLastCalledWith("not a key", undefined);
  });
});
