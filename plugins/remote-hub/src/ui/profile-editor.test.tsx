// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProfileFields } from "../core/profile.ts";
import { ProfileEditor } from "./profile-editor.tsx";

afterEach(cleanup);

const type = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });

const REF = "rh-cred:v1:local:0b8e6f4a-5c2d-4e1b-9a37-1f2e3d4c5b6a";
const EXISTING: ProfileFields = {
  name: "win",
  protocol: "rdp",
  group: "lab",
  tags: ["a"],
  favorite: false,
  color: null,
  host: "win.example.test",
  port: null,
  username: "admin",
  domain: "CORP",
  authType: "password",
  identityFile: null,
  credentialRef: REF,
  rdpWidth: 1280,
  rdpHeight: 800,
};

function mount(initial: ProfileFields | null = null) {
  const onSave = vi.fn(async (_fields: ProfileFields) => {});
  const onCancel = vi.fn();
  render(<ProfileEditor initial={initial} onSave={onSave} onCancel={onCancel} />);
  return { onSave, onCancel };
}

describe("ProfileEditor", () => {
  it("has the Connection, Authentication and Source sections; no secret input for the agent", () => {
    const { container } = render(<ProfileEditor initial={null} onSave={async () => {}} onCancel={() => {}} />);
    expect(screen.getByRole("group", { name: "Connection" })).toBeTruthy();
    expect(screen.getByRole("group", { name: "Authentication" })).toBeTruthy();
    expect(screen.getByRole("group", { name: "Source" })).toBeTruthy();
    expect(container.querySelector('input[type="password"]')).toBeNull();
  });

  it("SSH password auth offers a password to keep in the Keychain; a key offers a passphrase only once a key file is named", () => {
    const { container } = render(<ProfileEditor initial={null} onSave={async () => {}} onCancel={() => {}} />);
    fireEvent.change(screen.getByLabelText("Authentication type"), { target: { value: "password" } });
    expect(screen.getByLabelText("Password to save in the Keychain")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Authentication type"), { target: { value: "key" } });
    expect(container.querySelector('input[type="password"]')).toBeNull();
    type("Key file", "/Users/me/.ssh/id_test");
    expect(screen.getByLabelText("Passphrase to save in the Keychain")).toBeTruthy();
  });

  it("saves a new SSH key profile with exactly the typed values", async () => {
    const { onSave } = mount();
    type("Name", "  build  ");
    type("Host", "build.example.test");
    type("Port", "2222");
    type("User", "ci");
    type("Group", "lab");
    type("Tags", "linux, ci, linux");
    fireEvent.change(screen.getByLabelText("Authentication type"), { target: { value: "key" } });
    type("Key file", "/Users/dev/.ssh/id_ed25519");
    fireEvent.click(screen.getByLabelText("Favorite"));
    fireEvent.click(screen.getByText("Save"));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave.mock.calls[0]?.[0]).toEqual({
      name: "build",
      protocol: "ssh",
      group: "lab",
      tags: ["linux", "ci"],
      favorite: true,
      color: null,
      host: "build.example.test",
      port: 2222,
      username: "ci",
      domain: null,
      authType: "key",
      identityFile: "/Users/dev/.ssh/id_ed25519",
      credentialRef: null,
      rdpWidth: null,
      rdpHeight: null,
      rdpOptions: null,
    });
  });

  it("refuses an invalid host with a message at the field and calls nothing", async () => {
    const { onSave } = mount();
    type("Name", "x");
    type("Host", "-oProxyCommand=evil");
    fireEvent.click(screen.getByText("Save"));
    expect((await screen.findAllByRole("alert")).some((a) => /host/i.test(a.textContent ?? ""))).toBe(true);
    expect(onSave).not.toHaveBeenCalled();
  });

  it("a port that is not a whole number is refused before saving", async () => {
    const { onSave } = mount();
    type("Name", "x");
    type("Host", "h.example.test");
    type("Port", "22x");
    fireEvent.click(screen.getByText("Save"));
    expect((await screen.findAllByRole("alert")).some((a) => /port/i.test(a.textContent ?? ""))).toBe(true);
    expect(onSave).not.toHaveBeenCalled();
  });

  it("choosing RDP shows domain and desktop size, forces password sign-in and requires a user", async () => {
    const { onSave } = mount();
    type("Name", "win");
    type("Host", "win.example.test");
    fireEvent.change(screen.getByLabelText("Protocol"), { target: { value: "rdp" } });
    expect(screen.getByLabelText("Domain")).toBeTruthy();
    expect(screen.getByLabelText("Desktop width")).toBeTruthy();
    expect((screen.getByLabelText("Authentication type") as HTMLSelectElement).value).toBe("password");
    expect(Array.from((screen.getByLabelText("Authentication type") as HTMLSelectElement).options).map((o) => o.value)).toEqual(["password"]);
    fireEvent.click(screen.getByText("Save"));
    expect((await screen.findAllByRole("alert")).some((a) => /user/i.test(a.textContent ?? ""))).toBe(true);
    expect(onSave).not.toHaveBeenCalled();
    type("User", "admin");
    type("Desktop width", "1920");
    type("Desktop height", "1080");
    fireEvent.click(screen.getByText("Save"));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave.mock.calls[0]?.[0]).toMatchObject({ protocol: "rdp", username: "admin", authType: "password", rdpWidth: 1920, rdpHeight: 1080, domain: null });
  });

  it("P1: an RDP profile shows the Balanced default, saves a chosen preset, and the switches under Advanced make it Custom", async () => {
    const { onSave } = mount();
    type("Name", "win");
    type("Host", "win.example.test");
    fireEvent.change(screen.getByLabelText("Protocol"), { target: { value: "rdp" } });
    type("User", "admin");
    const quality = screen.getByLabelText("Connection quality") as HTMLSelectElement;
    expect(quality.value).toBe("balanced");
    expect(Array.from(quality.options).map((o) => o.textContent)).toEqual(["Slow link", "Balanced (default)", "Best quality"]);
    fireEvent.change(quality, { target: { value: "slow" } });
    fireEvent.click(screen.getByText("Save"));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave.mock.calls[0]?.[0].rdpOptions).toEqual({ compression: true, colorDepth: 16, wallpaper: false, fullWindowDrag: false, menuAnimations: false, fontSmoothing: true, desktopComposition: false, themes: false });
    // Advanced: individual switches; leaving the presets shows "Custom".
    fireEvent.click(screen.getByLabelText("Desktop wallpaper"));
    expect((screen.getByLabelText("Connection quality") as HTMLSelectElement).value).toBe("custom");
    fireEvent.change(screen.getByLabelText("Colour depth"), { target: { value: "24" } });
    fireEvent.click(screen.getByText("Save"));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(2));
    expect(onSave.mock.calls[1]?.[0].rdpOptions).toEqual({ compression: true, colorDepth: 24, wallpaper: true, fullWindowDrag: false, menuAnimations: false, fontSmoothing: true, desktopComposition: false, themes: false });
  });

  it("P1: the six experience switches, compression and colour depth are all offered; an SSH profile has no such controls and saves none", async () => {
    const { onSave } = mount();
    expect(screen.queryByLabelText("Connection quality")).toBeNull();
    fireEvent.change(screen.getByLabelText("Protocol"), { target: { value: "rdp" } });
    for (const label of ["Compress the update stream", "Desktop wallpaper", "Show window contents while dragging", "Menu and window animations", "Font smoothing", "Desktop composition", "Visual themes"]) {
      expect(screen.getByLabelText(label), label).toBeTruthy();
    }
    expect(Array.from((screen.getByLabelText("Colour depth") as HTMLSelectElement).options).map((o) => o.value)).toEqual(["32", "24", "16"]);
    fireEvent.change(screen.getByLabelText("Protocol"), { target: { value: "ssh" } });
    type("Name", "box");
    type("Host", "box.example.test");
    fireEvent.click(screen.getByText("Save"));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave.mock.calls[0]?.[0].rdpOptions).toBeNull();
  });

  it("P1: editing a profile saved without options shows and keeps the default", async () => {
    const { onSave } = mount(EXISTING);
    expect((screen.getByLabelText("Connection quality") as HTMLSelectElement).value).toBe("balanced");
    fireEvent.click(screen.getByText("Save"));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave.mock.calls[0]?.[0].rdpOptions).toMatchObject({ compression: true, colorDepth: 32 });
  });

  it("editing keeps the credential reference untouched and shows where the profile came from", async () => {
    const { onSave } = mount(EXISTING);
    expect(screen.getByText(/created manually/i)).toBeTruthy();
    type("Name", "win2");
    fireEvent.click(screen.getByText("Save"));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave.mock.calls[0]?.[0]).toEqual({ ...EXISTING, name: "win2", rdpOptions: { compression: true, colorDepth: 32, wallpaper: false, fullWindowDrag: false, menuAnimations: false, fontSmoothing: true, desktopComposition: false, themes: true } });
  });

  it("shows the error of a failed save and stays editable; Cancel closes", async () => {
    const onSave = vi.fn(async () => {
      throw new Error("no such profile");
    });
    const onCancel = vi.fn();
    render(<ProfileEditor initial={null} onSave={onSave} onCancel={onCancel} />);
    type("Name", "x");
    type("Host", "h.example.test");
    fireEvent.click(screen.getByText("Save"));
    expect(await screen.findByText("no such profile")).toBeTruthy();
    expect((screen.getByText("Save") as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByText("Cancel"));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});

describe("ProfileEditor: the saved password (stage 3b-1, RDP)", () => {
  const SECRET = "S3cr3t-EDIT-1";
  const passwordField = () => screen.getByLabelText("Password to save in the Keychain") as HTMLInputElement;

  it("an RDP profile offers a password field of type password; an SSH profile does not", () => {
    const { container } = render(<ProfileEditor initial={null} onSave={async () => {}} onCancel={() => {}} />);
    expect(container.querySelector('input[type="password"]')).toBeNull();
    fireEvent.change(screen.getByLabelText("Protocol"), { target: { value: "rdp" } });
    expect(passwordField().type).toBe("password");
    expect(passwordField().autocomplete).toBe("off");
    expect(screen.getByText(/Leave empty to type it each time/)).toBeTruthy();
  });

  it("typing a password passes it as the save action, never inside the profile fields", async () => {
    const { onSave } = mount({ ...EXISTING, credentialRef: null });
    fireEvent.change(passwordField(), { target: { value: SECRET } });
    fireEvent.click(screen.getByText("Save"));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect((onSave.mock.calls[0] as unknown[])[1]).toEqual({ type: "save", secret: SECRET });
    expect(JSON.stringify((onSave.mock.calls[0] as unknown[])[0])).not.toContain(SECRET);
  });

  it("the typed password leaves the form at once: the field is empty while the save is still running", async () => {
    let finish!: () => void;
    const onSave = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)));
    render(<ProfileEditor initial={{ ...EXISTING, credentialRef: null }} onSave={onSave as never} onCancel={() => {}} />);
    fireEvent.change(passwordField(), { target: { value: SECRET } });
    fireEvent.click(screen.getByText("Save"));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(passwordField().value).toBe("");
    finish();
  });

  it("with no password typed the action is keep", async () => {
    const { onSave } = mount({ ...EXISTING, credentialRef: null });
    fireEvent.click(screen.getByText("Save"));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect((onSave.mock.calls[0] as unknown[])[1]).toEqual({ type: "keep" });
  });

  it("a profile that already has a saved password says so, can replace it or remove it", async () => {
    const { onSave } = mount(EXISTING); // EXISTING has a credentialRef
    expect(screen.getByText(/A password is saved in the Keychain/)).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Remove the saved password"));
    fireEvent.click(screen.getByText("Save"));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect((onSave.mock.calls[0] as unknown[])[1]).toEqual({ type: "remove" });
  });

  it("replacing sends the new password; removing wins over a typed replacement being ignored by the checkbox", async () => {
    const { onSave } = mount(EXISTING);
    fireEvent.change(screen.getByLabelText("Replace the saved password"), { target: { value: SECRET } });
    fireEvent.click(screen.getByText("Save"));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect((onSave.mock.calls[0] as unknown[])[1]).toEqual({ type: "save", secret: SECRET });
  });

  it("moving the endpoint of a profile with a saved password warns that the password will be forgotten", () => {
    mount(EXISTING);
    expect(screen.queryByText(/will be forgotten/)).toBeNull();
    type("Host", "other.example.test");
    expect(screen.getByText(/saved password will be forgotten/)).toBeTruthy();
  });
});
