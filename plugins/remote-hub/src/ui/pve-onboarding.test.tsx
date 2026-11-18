// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PveApi } from "./pve-api.ts";
import { PveOnboarding } from "./pve-onboarding.tsx";

afterEach(cleanup);

const FP = "B6:88:41:D8:62:DD:80:8C:E2:A8:39:E1:26:D1:66:00:9D:51:54:09:DD:16:E2:A7:CB:DF:0D:3B:E1:1D:43:2E";
const ADMIN_PW = "Admin-PW-77x";

function api(over: Partial<PveApi> = {}) {
  return {
    targets: vi.fn(),
    pinTrust: vi.fn(),
    linkGuest: vi.fn(),
    onboardPlan: vi.fn(async () => ({ ok: true as const, role: "create" as const, user: "create" as const, acl: "create" as const })),
    onboardApply: vi.fn(async () => ({ ok: true as const, profileId: "new-profile", role: "create" as const, user: "create" as const, acl: "create" as const })),
    onboardConnect: vi.fn(async () => ({ ok: true as const, profileId: "as-is-profile" })),
    ...over,
  } as unknown as PveApi & Record<"onboardPlan" | "onboardApply" | "onboardConnect", ReturnType<typeof vi.fn>>;
}

function fillAdmin(host = "pve.test") {
  fireEvent.change(screen.getByLabelText("Host"), { target: { value: host } });
  fireEvent.change(screen.getByLabelText("Administrator password"), { target: { value: ADMIN_PW } });
}

describe("restricted user mode", () => {
  it("shows exactly what will be created and creates nothing before the owner confirms", async () => {
    const a = api();
    render(<PveOnboarding api={a} onDone={vi.fn()} onCancel={vi.fn()} />);
    fillAdmin();
    fireEvent.click(screen.getByRole("button", { name: "Review what will be created" }));
    const plan = await screen.findByTestId("pve-plan");
    expect(plan.textContent).toContain("RemoteHubConsole");
    expect(plan.textContent).toContain("Sys.Audit, Sys.Console, VM.Audit, VM.Console");
    expect(plan.textContent).toContain("remotehub@pve");
    expect(plan.textContent).toContain("will be created with a generated password");
    expect(plan.textContent).toContain("pveum user delete remotehub@pve");
    expect(a.onboardPlan).toHaveBeenCalledWith({ host: "pve.test", port: 8006, trust: null, adminUser: "root@pam", adminPassword: ADMIN_PW, aclPath: "/" });
    expect(a.onboardApply).not.toHaveBeenCalled();
  });

  it("applies only after the confirmation, with the same inputs, then hands over the new connection and forgets the password", async () => {
    const a = api();
    const onDone = vi.fn();
    render(<PveOnboarding api={a} onDone={onDone} onCancel={vi.fn()} />);
    fillAdmin();
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "My PVE" } });
    fireEvent.click(screen.getByRole("button", { name: "Review what will be created" }));
    await screen.findByTestId("pve-plan");
    fireEvent.click(screen.getByRole("button", { name: "Create and save" }));
    await waitFor(() => expect(onDone).toHaveBeenCalledWith("new-profile"));
    expect(a.onboardApply).toHaveBeenCalledWith({ host: "pve.test", port: 8006, trust: null, adminUser: "root@pam", adminPassword: ADMIN_PW, aclPath: "/", name: "My PVE" });
  });

  it("an existing setup is described as such: kept role and ACL, replaced password", async () => {
    const a = api({ onboardPlan: vi.fn(async () => ({ ok: true as const, role: "keep" as const, user: "rotate_password" as const, acl: "keep" as const })) } as never);
    render(<PveOnboarding api={a} onDone={vi.fn()} onCancel={vi.fn()} />);
    fillAdmin();
    fireEvent.click(screen.getByRole("button", { name: "Review what will be created" }));
    const plan = await screen.findByTestId("pve-plan");
    expect(plan.textContent).toContain("already exists with these privileges; it stays as it is");
    expect(plan.textContent).toContain("its password will be replaced by a new generated one");
  });

  it("Back returns to the form without applying", async () => {
    const a = api();
    render(<PveOnboarding api={a} onDone={vi.fn()} onCancel={vi.fn()} />);
    fillAdmin();
    fireEvent.click(screen.getByRole("button", { name: "Review what will be created" }));
    await screen.findByTestId("pve-plan");
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.queryByTestId("pve-plan")).toBeNull();
    expect(a.onboardApply).not.toHaveBeenCalled();
  });

  it("asks nothing of the server when the form is incomplete", async () => {
    const a = api();
    render(<PveOnboarding api={a} onDone={vi.fn()} onCancel={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Review what will be created" }));
    expect((await screen.findAllByRole("alert"))[0]?.textContent).toContain("host");
    fireEvent.change(screen.getByLabelText("Host"), { target: { value: "pve.test" } });
    fireEvent.click(screen.getByRole("button", { name: "Review what will be created" }));
    await waitFor(() => expect(screen.getAllByRole("alert").some((e) => e.textContent?.includes("administrator"))).toBe(true));
    expect(a.onboardPlan).not.toHaveBeenCalled();
  });

  it("an untrusted certificate shows its fingerprint; trusting it repeats the review with that pin", async () => {
    const plan = vi.fn(async (input: { trust: unknown }) =>
      input.trust === null
        ? { ok: false as const, code: "tls_untrusted", message: "", fingerprint: FP }
        : { ok: true as const, role: "create" as const, user: "create" as const, acl: "create" as const },
    );
    const a = api({ onboardPlan: plan } as never);
    render(<PveOnboarding api={a} onDone={vi.fn()} onCancel={vi.fn()} />);
    fillAdmin();
    fireEvent.click(screen.getByRole("button", { name: "Review what will be created" }));
    const cert = await screen.findByTestId("pve-onboard-cert");
    expect(cert.textContent).toContain(FP);
    fireEvent.click(screen.getByRole("button", { name: "Trust this certificate" }));
    await screen.findByTestId("pve-plan");
    expect(plan).toHaveBeenLastCalledWith(expect.objectContaining({ trust: { mode: "pin", fingerprint: FP } }));
  });

  it("a refused administrator login is explained with the action to take", async () => {
    const a = api({ onboardPlan: vi.fn(async () => ({ ok: false as const, code: "login_failed", message: "", fingerprint: null })) } as never);
    render(<PveOnboarding api={a} onDone={vi.fn()} onCancel={vi.fn()} />);
    fillAdmin();
    fireEvent.click(screen.getByRole("button", { name: "Review what will be created" }));
    expect((await screen.findByTestId("pve-onboard-error")).textContent).toContain("refused the login");
  });

  it("Cancel leaves without any call", () => {
    const a = api();
    const onCancel = vi.fn();
    render(<PveOnboarding api={a} onDone={vi.fn()} onCancel={onCancel} />);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalled();
    expect(a.onboardPlan).not.toHaveBeenCalled();
  });
});

describe("connect as is mode", () => {
  function choose() {
    fireEvent.click(screen.getByLabelText(/Connect as is/));
  }

  it("saves a login for this connection and creates nothing in Proxmox", async () => {
    const a = api();
    const onDone = vi.fn();
    render(<PveOnboarding api={a} onDone={onDone} onCancel={vi.fn()} />);
    choose();
    fireEvent.change(screen.getByLabelText("Host"), { target: { value: "pve.test" } });
    fireEvent.change(screen.getByLabelText("User (name@realm)"), { target: { value: "me@pve" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "pw-1234567" } });
    fireEvent.click(screen.getByRole("button", { name: "Save connection" }));
    await waitFor(() => expect(onDone).toHaveBeenCalledWith("as-is-profile"));
    expect(a.onboardConnect).toHaveBeenCalledWith({ host: "pve.test", port: 8006, trust: null, name: "Proxmox", authMode: "ticket", user: "me@pve", secret: "pw-1234567" });
    expect(a.onboardPlan).not.toHaveBeenCalled();
    expect(a.onboardApply).not.toHaveBeenCalled();
  });

  it("an API token is entered as a token id and secret", async () => {
    const a = api();
    render(<PveOnboarding api={a} onDone={vi.fn()} onCancel={vi.fn()} />);
    choose();
    fireEvent.change(screen.getByLabelText("Host"), { target: { value: "pve.test" } });
    fireEvent.change(screen.getByLabelText("Sign in with"), { target: { value: "token" } });
    fireEvent.change(screen.getByLabelText("API token id (user@realm!name)"), { target: { value: "me@pve!rh" } });
    fireEvent.change(screen.getByLabelText("API token secret"), { target: { value: "tok" } });
    fireEvent.click(screen.getByRole("button", { name: "Save connection" }));
    await waitFor(() => expect(a.onboardConnect).toHaveBeenCalledWith(expect.objectContaining({ authMode: "token", user: "me@pve!rh", secret: "tok" })));
  });
});
