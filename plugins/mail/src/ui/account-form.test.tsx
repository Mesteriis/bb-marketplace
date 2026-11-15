// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { installTestPluginRuntime } from "@get-bb/plugin-sdk/testing/app";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AccountForm } from "./account-form.tsx";

installTestPluginRuntime();
afterEach(cleanup);

function mount() {
  const onTest = vi.fn(async () => ({ ok: true, reason: null }));
  const onSave = vi.fn(async () => undefined);
  render(
    <AccountForm
      title="Add an account"
      initial={{ preset: "other", email: "owner@example.org", host: "imap.example.org", port: 993 }}
      onTest={onTest}
      onSave={onSave}
      ExternalLink={({ children }) => <span>{children}</span>}
    />,
  );
  fireEvent.change(screen.getByLabelText("App password"), { target: { value: "made-up-secret" } });
  return { onTest, onSave };
}

describe("AccountForm for another server", () => {
  it("requires the SMTP server before it tests or saves", async () => {
    const { onTest, onSave } = mount();
    fireEvent.click(screen.getByRole("button", { name: "Test" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Enter the SMTP server.");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onTest).not.toHaveBeenCalled();
    expect(onSave).not.toHaveBeenCalled();
  });

  it("sends the SMTP host, port and security with the account", async () => {
    const { onTest } = mount();
    fireEvent.change(screen.getByLabelText("SMTP server"), { target: { value: "smtp.example.org" } });
    fireEvent.change(screen.getByLabelText("SMTP port"), { target: { value: "2465" } });
    fireEvent.click(screen.getByRole("button", { name: "Test" }));
    await waitFor(() => expect(onTest).toHaveBeenCalled());
    expect(onTest).toHaveBeenCalledWith({
      preset: "other",
      email: "owner@example.org",
      host: "imap.example.org",
      port: 993,
      password: "made-up-secret",
      smtpHost: "smtp.example.org",
      smtpPort: 2465,
      smtpSecurity: "tls",
    });
  });
});
