// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { installTestPluginRuntime } from "@get-bb/plugin-sdk/testing/app";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Account } from "../core/model.ts";
import { defaultSmtpPort, SmtpDialog, smtpInput } from "./smtp-dialog.tsx";

installTestPluginRuntime();
afterEach(cleanup);

const other: Account = {
  id: "acc-1",
  email: "owner@example.org",
  displayName: null,
  preset: "other",
  host: "imap.example.org",
  port: 993,
  username: "owner@example.org",
  createdAt: "2026-11-01T09:00:00.000Z",
  lastSyncAt: null,
  lastError: null,
  authFailed: false,
  smtpConfigured: false,
};

describe("smtpInput", () => {
  it("takes a host name, a port and tls or starttls; the username is optional", () => {
    expect(smtpInput("acc-1", { host: " smtp.example.org ", port: "587", security: "starttls", username: "" })).toEqual({
      accountId: "acc-1",
      host: "smtp.example.org",
      port: 587,
      security: "starttls",
    });
    expect(smtpInput("acc-1", { host: "smtp.example.org", port: "465", security: "tls", username: "me" })).toMatchObject({ username: "me" });
    expect(smtpInput("acc-1", { host: "", port: "465", security: "tls", username: "" })).toBe("Enter the SMTP server.");
    expect(smtpInput("acc-1", { host: "smtp.example.org/x", port: "465", security: "tls", username: "" })).toMatch(/host name/);
    expect(smtpInput("acc-1", { host: "smtp.example.org", port: "0", security: "tls", username: "" })).toMatch(/port/);
    expect(smtpInput("acc-1", { host: "smtp.example.org", port: "465", security: "tls", username: "a\r\nb" })).toMatch(/username/);
    expect(defaultSmtpPort("tls")).toBe(465);
    expect(defaultSmtpPort("starttls")).toBe(587);
  });
});

describe("SmtpDialog", () => {
  it("tests, then saves and closes", async () => {
    const onTest = vi.fn(async () => ({ ok: false, reason: "The SMTP server refused the login" }));
    const onSave = vi.fn(async () => ({ ok: true, reason: null }));
    const onClose = vi.fn();
    render(<SmtpDialog account={other} onClose={onClose} onTest={onTest} onSave={onSave} />);
    fireEvent.click(screen.getByRole("button", { name: "Test" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Enter the SMTP server.");
    expect(onTest).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText("SMTP server"), { target: { value: "smtp.example.org" } });
    fireEvent.change(screen.getByLabelText("Username"), { target: { value: "sender@example.org" } });
    fireEvent.click(screen.getByRole("button", { name: "Test" }));
    expect((await screen.findByRole("alert")).textContent).toBe("The SMTP server refused the login");
    expect(onTest).toHaveBeenCalledWith({
      accountId: "acc-1",
      host: "smtp.example.org",
      port: 465,
      security: "tls",
      username: "sender@example.org",
    });

    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it("starts from the preset's server for iCloud and Gmail", () => {
    render(<SmtpDialog account={{ ...other, preset: "icloud" }} onClose={() => undefined} onTest={vi.fn()} onSave={vi.fn()} />);
    expect((screen.getByLabelText("SMTP server") as HTMLInputElement).value).toBe("smtp.mail.me.com");
    expect((screen.getByLabelText("Port") as HTMLInputElement).value).toBe("587");
  });

  it("stays closed without an account", () => {
    render(<SmtpDialog account={null} onClose={() => undefined} onTest={vi.fn()} onSave={vi.fn()} />);
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
