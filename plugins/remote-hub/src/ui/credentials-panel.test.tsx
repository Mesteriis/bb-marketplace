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
    expect(within(win).getByText("RDP: пароль")).toBeTruthy();
    expect(within(win).getByText("CORP\\admin@win.example.test:3389")).toBeTruthy();
    expect(within(win).getByText("Используют: Windows jump, Windows twin")).toBeTruthy();
    const key = screen.getByRole("listitem", { name: "Build key" });
    expect(within(key).getByText("Парольная фраза ключа")).toBeTruthy();
    expect(within(key).getByText("/Users/dev/.ssh/id_ed25519")).toBeTruthy();
    expect(within(key).getByText("Не используется ни одним подключением")).toBeTruthy();
    expect(container.querySelector('input[type="password"]')).toBeNull();
  });

  it("Check asks the Keychain and says what it found, in words", async () => {
    const onCheck = vi.fn(async (_ref: string) => ({ state: "locked" as const }));
    mount({ onCheck });
    fireEvent.click(within(screen.getByRole("listitem", { name: "Windows jump" })).getByRole("button", { name: "Проверить" }));
    expect(await screen.findByText(/заблокирована/)).toBeTruthy();
    expect(onCheck).toHaveBeenCalledWith(WIN.ref);
  });

  it("each state has its own text", async () => {
    for (const [state, text] of [["present", /Есть в Связке ключей/], ["missing", /В Связке ключей его больше нет/], ["denied", /Связка ключей отказала в доступе/], ["unavailable", /Связка ключей недоступна/]] as const) {
      cleanup();
      mount({ onCheck: vi.fn(async () => ({ state })) });
      fireEvent.click(within(screen.getByRole("listitem", { name: "Windows jump" })).getByRole("button", { name: "Проверить" }));
      expect(await screen.findByText(text)).toBeTruthy();
    }
  });

  it("Change password takes a password-type field, sends it once and clears it", async () => {
    const h = mount();
    const row = screen.getByRole("listitem", { name: "Windows jump" });
    fireEvent.click(within(row).getByRole("button", { name: "Сменить пароль" }));
    const input = within(row).getByLabelText("Новый пароль") as HTMLInputElement;
    expect(input.type).toBe("password");
    expect(input.autocomplete).toBe("off");
    fireEvent.change(input, { target: { value: SECRET } });
    fireEvent.click(within(row).getByRole("button", { name: "Сохранить новый пароль" }));
    await waitFor(() => expect(h.onChange).toHaveBeenCalledWith(WIN.ref, SECRET));
    await waitFor(() => expect(within(row).queryByLabelText("Новый пароль")).toBeNull()); // closed and gone from the DOM
    expect(document.body.innerHTML).not.toContain(SECRET);
  });

  it("an empty new password is not sent", () => {
    const h = mount();
    const row = screen.getByRole("listitem", { name: "Windows jump" });
    fireEvent.click(within(row).getByRole("button", { name: "Сменить пароль" }));
    expect((within(row).getByRole("button", { name: "Сохранить новый пароль" }) as HTMLButtonElement).disabled).toBe(true);
    expect(h.onChange).not.toHaveBeenCalled();
  });

  it("a failed change shows the reason and keeps the form for a retry", async () => {
    const onChange = vi.fn(async () => {
      throw new Error("keychain_locked: the Keychain is locked");
    });
    mount({ onChange });
    const row = screen.getByRole("listitem", { name: "Windows jump" });
    fireEvent.click(within(row).getByRole("button", { name: "Сменить пароль" }));
    fireEvent.change(within(row).getByLabelText("Новый пароль"), { target: { value: SECRET } });
    fireEvent.click(within(row).getByRole("button", { name: "Сохранить новый пароль" }));
    expect(await within(row).findByText(/Keychain is locked/)).toBeTruthy();
    expect(within(row).getByLabelText("Новый пароль")).toBeTruthy();
  });

  it("Delete names the profiles that will ask for a password again and needs a confirmation", async () => {
    const h = mount();
    const row = screen.getByRole("listitem", { name: "Windows jump" });
    fireEvent.click(within(row).getByRole("button", { name: "Удалить" }));
    expect(within(row).getByText(/Снова спросят пароль: Windows jump, Windows twin/)).toBeTruthy();
    expect(h.onDelete).not.toHaveBeenCalled();
    fireEvent.click(within(row).getByRole("button", { name: "Оставить" }));
    fireEvent.click(within(row).getByRole("button", { name: "Удалить" }));
    fireEvent.click(within(row).getByRole("button", { name: "Подтвердить удаление" }));
    await waitFor(() => expect(h.onDelete).toHaveBeenCalledWith(WIN.ref));
  });

  it("an unfinished save is listed as such with only Delete (which retries the cleanup)", () => {
    const orphan: CredentialItem = { ...WIN, ref: "rh-cred:v1:local:22222222-2222-4222-8222-222222222222", label: "Unfinished save (cleanup pending)", orphaned: true, usedBy: [] };
    mount({ items: [orphan] });
    const row = screen.getByRole("listitem", { name: "Unfinished save (cleanup pending)" });
    expect(within(row).getByText(/не завершилось/)).toBeTruthy();
    expect(within(row).queryByRole("button", { name: "Проверить" })).toBeNull();
    expect(within(row).queryByRole("button", { name: "Сменить пароль" })).toBeNull();
    expect(within(row).getByRole("button", { name: "Удалить" })).toBeTruthy();
  });

  it("has loading, error with Retry, empty and Close", () => {
    cleanup();
    mount({ items: null });
    expect(screen.getByText("Загружаю учётные данные…")).toBeTruthy();
    cleanup();
    const failing = mount({ items: null, error: "storage unavailable" });
    fireEvent.click(screen.getByRole("button", { name: "Повторить" }));
    expect(failing.onRetry).toHaveBeenCalledTimes(1);
    cleanup();
    const empty = mount({ items: [] });
    expect(screen.getByText(/Сохранённых паролей пока нет/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Закрыть" }));
    expect(empty.onClose).toHaveBeenCalledTimes(1);
  });
});

describe("Allow access (macOS asks the owner)", () => {
  it("a row's Allow access asks for exactly that item and shows the state afterwards", async () => {
    const onAllow = vi.fn(async (_ref: string) => ({ state: "present" as const }));
    mount({ onAllow });
    const row = screen.getByRole("listitem", { name: "Windows jump" });
    fireEvent.click(within(row).getByRole("button", { name: "Разрешить доступ" }));
    await waitFor(() => expect(onAllow).toHaveBeenCalledWith(WIN.ref));
    expect(await within(row).findByText("Есть в Связке ключей.")).toBeTruthy();
    expect(onAllow).toHaveBeenCalledTimes(1);
  });

  it("a refusal or a timeout is shown with its own text, and a state that still needs approval says what to do", async () => {
    const onAllow = vi.fn(async (_ref: string): Promise<{ state: "present" | "needs_approval" }> => {
      throw new Error("allow_timed_out: macOS did not get an answer");
    });
    mount({ onAllow });
    const row = screen.getByRole("listitem", { name: "Windows jump" });
    fireEvent.click(within(row).getByRole("button", { name: "Разрешить доступ" }));
    expect(await within(row).findByText(/did not get an answer to its dialog in time/)).toBeTruthy();
    const check = vi.fn(async () => ({ state: "needs_approval" as const }));
    cleanup();
    mount({ onCheck: check, onAllow });
    const again = screen.getByRole("listitem", { name: "Windows jump" });
    fireEvent.click(within(again).getByRole("button", { name: "Проверить" }));
    expect(await within(again).findByText(/выберите «Всегда разрешать»/)).toBeTruthy();
  });

  it("without the action there is no button (agents and read-only views never get one)", () => {
    mount();
    expect(screen.queryByRole("button", { name: "Разрешить доступ" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Разрешить доступ ко всем/ })).toBeNull();
  });

  it("Allow access for all reports each credential that failed, by name", async () => {
    const onAllowAll = vi.fn(async () => [
      { label: "Windows jump", ok: true, code: null },
      { label: "Build key", ok: false, code: "keychain_denied" },
    ]);
    mount({ onAllow: vi.fn(), onAllowAll });
    fireEvent.click(screen.getByRole("button", { name: "Разрешить доступ ко всем сохранённым записям" }));
    expect(await screen.findByText(/Build key: The Keychain refused access/)).toBeTruthy();
    expect(onAllowAll).toHaveBeenCalledTimes(1);
  });
});
