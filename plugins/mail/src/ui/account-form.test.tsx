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

describe("AccountForm with Google sign-in", () => {
  function mountGmail(props: Partial<Parameters<typeof AccountForm>[0]> = {}) {
    const onGoogleSignIn = vi.fn(async (_email: string | null, _signal: AbortSignal) => ({ ok: true as const }));
    const view = render(
      <AccountForm
        title="Add an account"
        initial={{ preset: "gmail", email: "" }}
        onTest={vi.fn(async () => ({ ok: true, reason: null }))}
        onSave={vi.fn(async () => undefined)}
        onGoogleSignIn={onGoogleSignIn}
        ExternalLink={({ children }) => <span>{children}</span>}
        {...props}
      />,
    );
    return { onGoogleSignIn, view };
  }

  it("offers Google first for Gmail and keeps the app password one click away", () => {
    mountGmail();
    expect(screen.getByRole("button", { name: "Sign in with Google" })).toBeTruthy();
    expect(screen.queryByLabelText("App password")).toBeNull();
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Use an app password instead" }));

    expect(screen.getByLabelText("App password")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Save" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Sign in with Google instead" })).toBeTruthy();
  });

  it("does not offer Google without the handler or for another provider", () => {
    mountGmail({ onGoogleSignIn: undefined });
    expect(screen.queryByRole("button", { name: "Sign in with Google" })).toBeNull();
    expect(screen.getByLabelText("App password")).toBeTruthy();
    cleanup();
    mountGmail({ initial: { preset: "icloud", email: "" } });
    expect(screen.queryByRole("button", { name: "Sign in with Google" })).toBeNull();
    expect(screen.getByLabelText("App password")).toBeTruthy();
  });

  it("replacing an app password opens on the password, a Google reconnect on Google", () => {
    mountGmail({ initial: { preset: "gmail", email: "owner@example.org" } });
    expect(screen.getByLabelText("App password")).toBeTruthy();
    cleanup();
    mountGmail({ initial: { preset: "gmail", email: "owner@example.org", signIn: "google" } });
    expect(screen.queryByLabelText("App password")).toBeNull();
    expect(screen.getByRole("button", { name: "Sign in with Google" })).toBeTruthy();
  });

  it("signs in with the typed address, or any account when it is empty, and shows a refusal", async () => {
    const { onGoogleSignIn } = mountGmail();
    fireEvent.click(screen.getByRole("button", { name: "Sign in with Google" }));
    await waitFor(() => expect(onGoogleSignIn).toHaveBeenCalledTimes(1));
    expect(onGoogleSignIn.mock.calls[0]![0]).toBeNull();
    expect((await screen.findByRole("status")).textContent).toBe("Signed in with Google.");

    onGoogleSignIn.mockResolvedValueOnce({ ok: false, message: "That Google account is a different address." } as never);
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: " owner@example.org " } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in with Google" }));
    expect((await screen.findByRole("alert")).textContent).toBe("That Google account is a different address.");
    expect(onGoogleSignIn.mock.calls[1]![0]).toBe("owner@example.org");
  });

  it("stops waiting for Google when the form goes away", async () => {
    let seen: AbortSignal | null = null;
    const onGoogleSignIn = vi.fn((_email: string | null, signal: AbortSignal) => {
      seen = signal;
      return new Promise<{ ok: true }>(() => undefined);
    });
    const { view } = mountGmail({ onGoogleSignIn });
    fireEvent.click(screen.getByRole("button", { name: "Sign in with Google" }));
    await waitFor(() => expect(seen).not.toBeNull());
    expect(screen.getByRole("button", { name: "Waiting for Google\u2026" })).toBeTruthy();
    view.unmount();
    expect(seen!.aborted).toBe(true);
  });
});

