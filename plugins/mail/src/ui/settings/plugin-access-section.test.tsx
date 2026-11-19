// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { setLanguage } from "../i18n/index.ts";
import { PluginAccessSection, type PluginAccessPort, type PluginAccessView } from "./plugin-access-section.tsx";

afterEach(() => {
  cleanup();
  setLanguage("en");
});

const accounts = [
  { id: "acc_1", email: "first@example.com", google: true },
  { id: "acc_2", email: "second@example.net", google: false },
];
const at = "2026-11-19T10:00:00.000Z";

function port(view: PluginAccessView, overrides: Partial<PluginAccessPort> = {}) {
  const calls: string[] = [];
  const p: PluginAccessPort = {
    load: async () => view,
    setGrant: async (pluginId, right, accountId, on) => {
      calls.push(`set ${pluginId} ${right} ${accountId} ${on}`);
      return { ok: true };
    },
    revoke: async (pluginId) => {
      calls.push(`revoke ${pluginId}`);
      return { ok: true };
    },
    dismiss: async (pluginId) => {
      calls.push(`dismiss ${pluginId}`);
      return { ok: true };
    },
    ...overrides,
  };
  return { port: p, calls };
}

const request = { pluginId: "calendar", rights: ["mail.read", "invites.read"] as const, reason: "Calendar sync", askedAt: at };
const crm = { pluginId: "crm", grants: [{ right: "mail.read" as const, accountId: "acc_1", grantedAt: at }], lastCallAt: null };

describe("PluginAccessSection", () => {
  it("with nothing asked shows the note and the empty state, no table", async () => {
    const { port: p } = port({ plugins: [], requests: [] });
    render(<PluginAccessSection port={p} accounts={accounts} />);
    expect(await screen.findByText("No plugin has asked for access to mail.")).toBeTruthy();
    expect(screen.getByText(/This governs calls from other plugins' servers/)).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("shows a request with its plugin, reason and rights; Dismiss grants nothing", async () => {
    const { port: p, calls } = port({ plugins: [], requests: [{ ...request, rights: [...request.rights] }] });
    render(<PluginAccessSection port={p} accounts={accounts} />);
    const row = await screen.findByRole("listitem", { name: "calendar" });
    expect(within(row).getByText("Calendar sync")).toBeTruthy();
    expect(within(row).getByText("Asks for: Read mail, Read invitations")).toBeTruthy();
    fireEvent.click(within(row).getByRole("button", { name: "Dismiss" }));
    await waitFor(() => expect(calls).toEqual(["dismiss calendar"]));
  });

  it("Allow… opens the asked rights checked and saves nothing until Save", async () => {
    const { port: p, calls } = port({ plugins: [], requests: [{ ...request, rights: [...request.rights] }] });
    render(<PluginAccessSection port={p} accounts={accounts} />);
    const row = await screen.findByRole("listitem", { name: "calendar" });
    fireEvent.click(within(row).getByRole("button", { name: "Allow…" }));
    const cell = (name: string) => within(row).getByRole("switch", { name }).getAttribute("aria-checked");
    // With several mailboxes nothing is checked for the owner: which mailbox is theirs to pick.
    expect(within(row).getAllByRole("switch").map((sw) => sw.getAttribute("aria-checked"))).not.toContain("true");
    expect(within(row).getByText("Asks for: Read mail, Read invitations")).toBeTruthy();
    fireEvent.click(within(row).getByRole("switch", { name: "Read mail, first@example.com" }));
    fireEvent.click(within(row).getByRole("switch", { name: "Read invitations, first@example.com" }));
    expect(cell("Read mail, first@example.com")).toBe("true");
    expect(calls).toEqual([]);
    fireEvent.click(within(row).getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(calls).toEqual(["set calendar mail.read acc_1 true", "set calendar invites.read acc_1 true", "dismiss calendar"]),
    );
  });

  it("with one mailbox Allow… checks the asked rights for it", async () => {
    const { port: p } = port({ plugins: [], requests: [{ ...request, rights: [...request.rights] }] });
    render(<PluginAccessSection port={p} accounts={[accounts[0]!]} />);
    const row = await screen.findByRole("listitem", { name: "calendar" });
    fireEvent.click(within(row).getByRole("button", { name: "Allow\u2026" }));
    expect(within(row).getByRole("switch", { name: "Read mail, first@example.com" }).getAttribute("aria-checked")).toBe("true");
    expect(within(row).getByRole("switch", { name: "Read contacts, first@example.com" }).getAttribute("aria-checked")).toBe("false");
  });

  it("a plugin with access: switches show its grants and change one at a time", async () => {
    const { port: p, calls } = port({ plugins: [crm], requests: [] });
    render(<PluginAccessSection port={p} accounts={accounts} />);
    const block = await screen.findByRole("listitem", { name: "crm" });
    expect(within(block).getByText("Never called")).toBeTruthy();
    // The header and four rights: Google keys are not offered without a sign-in to run.
    expect(within(block).getAllByRole("row")).toHaveLength(5);
    expect(within(block).queryByText("Google Calendar key")).toBeNull();
    expect(within(block).getByRole("switch", { name: "Read mail, first@example.com" }).getAttribute("aria-checked")).toBe("true");
    fireEvent.click(within(block).getByRole("switch", { name: "Read contacts, second@example.net" }));
    await waitFor(() => expect(calls).toEqual(["set crm contacts.read acc_2 true"]));
    fireEvent.click(within(block).getByRole("switch", { name: "Read mail, first@example.com" }));
    await waitFor(() => expect(calls).toEqual(["set crm contacts.read acc_2 true", "set crm mail.read acc_1 false"]));
  });

  it("a refused change says why in the plugin's block and the switch stays as it was", async () => {
    const { port: p } = port({ plugins: [crm], requests: [] }, { setGrant: async () => ({ ok: false, message: "Unknown account" }) });
    render(<PluginAccessSection port={p} accounts={accounts} />);
    const block = await screen.findByRole("listitem", { name: "crm" });
    fireEvent.click(within(block).getByRole("switch", { name: "Read contacts, first@example.com" }));
    expect((await within(block).findByRole("alert")).textContent).toBe("Unknown account");
    expect(within(block).getByRole("switch", { name: "Read contacts, first@example.com" }).getAttribute("aria-checked")).toBe("false");
  });

  it("Revoke all asks first", async () => {
    const { port: p, calls } = port({ plugins: [crm], requests: [] });
    render(<PluginAccessSection port={p} accounts={accounts} />);
    const block = await screen.findByRole("listitem", { name: "crm" });
    fireEvent.click(within(block).getByRole("button", { name: "Revoke all" }));
    expect(calls).toEqual([]);
    expect(within(block).getByText("Take away everything this plugin has?")).toBeTruthy();
    fireEvent.click(within(block).getByRole("button", { name: "Revoke" }));
    await waitFor(() => expect(calls).toEqual(["revoke crm"]));
  });

  it("a Google key: off for an account without Google sign-in, through the sign-in for one with it", async () => {
    const onGoogleGrant = vi.fn();
    const { port: p, calls } = port({ plugins: [crm], requests: [] });
    render(<PluginAccessSection port={p} accounts={accounts} onGoogleGrant={onGoogleGrant} />);
    const block = await screen.findByRole("listitem", { name: "crm" });
    const without = within(block).getByRole("switch", { name: "Google Calendar key, second@example.net" }) as HTMLButtonElement;
    expect(without.disabled).toBe(true);
    expect(within(block).getAllByText("Needs Google sign-in")).toHaveLength(2);
    fireEvent.click(within(block).getByRole("switch", { name: "Google Calendar key, first@example.com" }));
    expect(onGoogleGrant).toHaveBeenCalledWith("crm", "google.calendar", "acc_1");
    expect(calls).toEqual([]);
  });

  it("a plugin id that looks like markup is shown as text", async () => {
    const id = "<img src=x onerror=1>";
    const { port: p } = port({ plugins: [{ ...crm, pluginId: id }], requests: [{ ...request, rights: ["mail.read"], pluginId: `${id}2` }] });
    const { container } = render(<PluginAccessSection port={p} accounts={accounts} />);
    expect(await screen.findByText(id)).toBeTruthy();
    expect(screen.getByText(`${id}2`)).toBeTruthy();
    expect(container.querySelector("img")).toBeNull();
  });

  it("says when it could not load", async () => {
    const { port: p } = port({ plugins: [], requests: [] }, { load: async () => Promise.reject(new Error("down")) });
    render(<PluginAccessSection port={p} accounts={accounts} />);
    expect((await screen.findByRole("alert")).textContent).toBe("Could not load plugin access.");
  });

  it("in Russian leaves no English sentence", async () => {
    setLanguage("ru");
    const { port: p } = port({ plugins: [crm], requests: [{ ...request, rights: [...request.rights] }] });
    const { container } = render(<PluginAccessSection port={p} accounts={accounts} />);
    await screen.findByRole("listitem", { name: "crm" });
    const english = Array.from(container.querySelectorAll("p, span, th, button, h3"))
      .map((node) => (node.children.length === 0 ? node.textContent ?? "" : ""))
      .filter((text) => /[A-Za-z]{4,}/.test(text) && !/@|^crm$|^calendar$|Calendar sync|Google/.test(text));
    expect(english).toEqual([]);
  });
});
