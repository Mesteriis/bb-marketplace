// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CredentialsPanel, type CredentialsPanelProps } from "./credentials-panel.tsx";
import type { CredentialItem } from "./use-credentials.ts";

afterEach(cleanup);

const SECRET = "S3cr3t-PANEL-1";
const WIN: CredentialItem = {
  ref: "rh-cred:v1:local:0b8e6f4a-5c2d-4e1b-9a37-1f2e3d4c5b6a",
  kind: "password",
  label: "Windows jump",
  bind: { type: "endpoint", protocol: "rdp", host: "win.example.test", port: 3389, user: "admin", domain: "CORP" },
  createdAt: "2026-11-18T10:00:00.000Z",
  updatedAt: "2026-11-18T11:00:00.000Z",
  usedBy: [{ id: "a", name: "Windows jump" }, { id: "b", name: "Windows twin" }],
};
const KEY: CredentialItem = {
  ...WIN,
  ref: "rh-cred:v1:local:11111111-2222-4333-8444-555555555555",
  kind: "passphrase",
  label: "Build key",
  bind: { type: "key", path: "/Users/dev/.ssh/id_ed25519" },
  usedBy: [],
};

function mount(over: Partial<CredentialsPanelProps> = {}) {
  const h = {
    onCheck: vi.fn(async () => ({ state: "present" as const })),
    onChange: vi.fn(async () => {}),
    onDelete: vi.fn(async () => {}),
    onRetry: vi.fn(),
    onClose: vi.fn(),
  };
  render(<CredentialsPanel items={[WIN, KEY]} error={null} {...h} {...over} />);
  return h;
}

describe("CredentialsPanel", () => {
  it("lists each credential with what it is for and which profiles use it; no secret is ever shown", () => {
    const { container } = render(<CredentialsPanel items={[WIN, KEY]} error={null} onCheck={vi.fn()} onChange={vi.fn()} onDelete={vi.fn()} onRetry={vi.fn()} onClose={vi.fn()} />);
    const win = screen.getByRole("listitem", { name: "Windows jump" });
    expect(within(win).getByText("RDP password")).toBeTruthy();
    expect(within(win).getByText("CORP\\admin@win.example.test:3389")).toBeTruthy();
    expect(within(win).getByText("Used by: Windows jump, Windows twin")).toBeTruthy();
    const key = screen.getByRole("listitem", { name: "Build key" });
    expect(within(key).getByText("Key passphrase")).toBeTruthy();
    expect(within(key).getByText("/Users/dev/.ssh/id_ed25519")).toBeTruthy();
    expect(within(key).getByText("Not used by any profile")).toBeTruthy();
    expect(container.querySelector('input[type="password"]')).toBeNull();
  });

  it("Check asks the Keychain and says what it found, in words", async () => {
    const onCheck = vi.fn(async (_ref: string) => ({ state: "locked" as const }));
    mount({ onCheck });
    fireEvent.click(within(screen.getByRole("listitem", { name: "Windows jump" })).getByRole("button", { name: "Check" }));
    expect(await screen.findByText(/Keychain is locked/)).toBeTruthy();
    expect(onCheck).toHaveBeenCalledWith(WIN.ref);
  });

  it("each state has its own text", async () => {
    for (const [state, text] of [["present", /Found in the Keychain/], ["missing", /No longer in the Keychain/], ["denied", /refused access/], ["unavailable", /not available/]] as const) {
      cleanup();
      mount({ onCheck: vi.fn(async () => ({ state })) });
      fireEvent.click(within(screen.getByRole("listitem", { name: "Windows jump" })).getByRole("button", { name: "Check" }));
      expect(await screen.findByText(text)).toBeTruthy();
    }
  });

  it("Change password takes a password-type field, sends it once and clears it", async () => {
    const h = mount();
    const row = screen.getByRole("listitem", { name: "Windows jump" });
    fireEvent.click(within(row).getByRole("button", { name: "Change password" }));
    const input = within(row).getByLabelText("New password") as HTMLInputElement;
    expect(input.type).toBe("password");
    expect(input.autocomplete).toBe("off");
    fireEvent.change(input, { target: { value: SECRET } });
    fireEvent.click(within(row).getByRole("button", { name: "Save new password" }));
    await waitFor(() => expect(h.onChange).toHaveBeenCalledWith(WIN.ref, SECRET));
    await waitFor(() => expect(within(row).queryByLabelText("New password")).toBeNull()); // closed and gone from the DOM
    expect(document.body.innerHTML).not.toContain(SECRET);
  });

  it("an empty new password is not sent", () => {
    const h = mount();
    const row = screen.getByRole("listitem", { name: "Windows jump" });
    fireEvent.click(within(row).getByRole("button", { name: "Change password" }));
    expect((within(row).getByRole("button", { name: "Save new password" }) as HTMLButtonElement).disabled).toBe(true);
    expect(h.onChange).not.toHaveBeenCalled();
  });

  it("a failed change shows the reason and keeps the form for a retry", async () => {
    const onChange = vi.fn(async () => {
      throw new Error("keychain_locked: the Keychain is locked");
    });
    mount({ onChange });
    const row = screen.getByRole("listitem", { name: "Windows jump" });
    fireEvent.click(within(row).getByRole("button", { name: "Change password" }));
    fireEvent.change(within(row).getByLabelText("New password"), { target: { value: SECRET } });
    fireEvent.click(within(row).getByRole("button", { name: "Save new password" }));
    expect(await within(row).findByText(/Keychain is locked or needs approval/)).toBeTruthy();
    expect(within(row).getByLabelText("New password")).toBeTruthy();
  });

  it("Delete names the profiles that will ask for a password again and needs a confirmation", async () => {
    const h = mount();
    const row = screen.getByRole("listitem", { name: "Windows jump" });
    fireEvent.click(within(row).getByRole("button", { name: "Delete" }));
    expect(within(row).getByText(/Windows jump, Windows twin will ask for a password again/)).toBeTruthy();
    expect(h.onDelete).not.toHaveBeenCalled();
    fireEvent.click(within(row).getByRole("button", { name: "Keep" }));
    fireEvent.click(within(row).getByRole("button", { name: "Delete" }));
    fireEvent.click(within(row).getByRole("button", { name: "Confirm delete" }));
    await waitFor(() => expect(h.onDelete).toHaveBeenCalledWith(WIN.ref));
  });

  it("has loading, error with Retry, empty and Close", () => {
    cleanup();
    mount({ items: null });
    expect(screen.getByText("Loading credentials…")).toBeTruthy();
    cleanup();
    const failing = mount({ items: null, error: "storage unavailable" });
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(failing.onRetry).toHaveBeenCalledTimes(1);
    cleanup();
    const empty = mount({ items: [] });
    expect(screen.getByText(/No saved passwords/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(empty.onClose).toHaveBeenCalledTimes(1);
  });
});
