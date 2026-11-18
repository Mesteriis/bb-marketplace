// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PveApi } from "./pve-api.ts";
import { PveOnboarding } from "./pve-onboarding.tsx";

afterEach(cleanup);

const FP = "B6:88:41:D8:62:DD:80:8C:E2:A8:39:E1:26:D1:66:00:9D:51:54:09:DD:16:E2:A7:CB:DF:0D:3B:E1:1D:43:2E";
const ADMIN_PW = "Admin-PW-77x";

const DIGEST = "a".repeat(64);
const PLAN = { ok: true as const, role: "create" as const, user: "create" as const, acl: "create" as const, userId: "remotehub@pve", rolePrivs: null, extras: { acl: [], groups: [], tokens: [] }, digest: DIGEST };
const DONE = { role: "done" as const, user: "done" as const, acl: "done" as const };

function api(over: Partial<PveApi> = {}) {
  return {
    targets: vi.fn(),
    pinTrust: vi.fn(),
    linkGuest: vi.fn(),
    onboardPlan: vi.fn(async () => PLAN),
    onboardApply: vi.fn(async () => ({ ok: true as const, profileId: "new-profile", userId: "remotehub@pve", steps: DONE })),
    onboardConnect: vi.fn(async () => ({ ok: true as const, profileId: "as-is-profile" })),
    ...over,
  } as unknown as PveApi & Record<"onboardPlan" | "onboardApply" | "onboardConnect", ReturnType<typeof vi.fn>>;
}

function fillAdmin(host = "pve.test") {
  fireEvent.change(screen.getByLabelText("Host"), { target: { value: host } });
  fireEvent.change(screen.getByLabelText("Administrator password"), { target: { value: ADMIN_PW } });
}
const passwordField = () => screen.getByLabelText("Administrator password") as HTMLInputElement;
const review = () => fireEvent.click(screen.getByRole("button", { name: "Review what will be created" }));

describe("restricted user mode", () => {
  it("shows exactly what will be created and creates nothing before the owner confirms", async () => {
    const a = api();
    render(<PveOnboarding api={a} onDone={vi.fn()} onCancel={vi.fn()} />);
    fillAdmin();
    review();
    const plan = await screen.findByTestId("pve-plan");
    expect(plan.textContent).toContain("RemoteHubConsole");
    expect(plan.textContent).toContain("Sys.Audit, Sys.Console, VM.Audit, VM.Console");
    expect(plan.textContent).toContain("remotehub@pve");
    expect(plan.textContent).toContain("will be created with a generated password");
    expect(plan.textContent).toContain("pveum user delete remotehub@pve");
    expect(a.onboardPlan).toHaveBeenCalledWith({ host: "pve.test", port: 8006, trust: null, adminUser: "root@pam", adminPassword: ADMIN_PW, aclPath: "/", userId: "remotehub@pve" });
    expect(a.onboardApply).not.toHaveBeenCalled();
  });

  it("says truthfully that the administrator login is used for this setup only, never stored", () => {
    render(<PveOnboarding api={api()} onDone={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByText(/used for this setup only, never stored/)).toBeTruthy();
    expect(document.body.textContent).not.toContain("used once");
  });

  it("applies the confirmed plan's digest, then hands over the new connection and clears the password", async () => {
    const a = api();
    const onDone = vi.fn();
    render(<PveOnboarding api={a} onDone={onDone} onCancel={vi.fn()} />);
    fillAdmin();
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "My PVE" } });
    review();
    await screen.findByTestId("pve-plan");
    fireEvent.click(screen.getByRole("button", { name: "Create and save" }));
    await waitFor(() => expect(onDone).toHaveBeenCalledWith("new-profile"));
    expect(a.onboardApply).toHaveBeenCalledWith({ host: "pve.test", port: 8006, trust: null, adminUser: "root@pam", adminPassword: ADMIN_PW, aclPath: "/", userId: "remotehub@pve", name: "My PVE", planDigest: DIGEST, replaceRole: false });
    expect(passwordField().value).toBe("");
  });

  it("a different user name can be chosen and is validated as name@pve", async () => {
    const a = api();
    render(<PveOnboarding api={a} onDone={vi.fn()} onCancel={vi.fn()} />);
    fillAdmin();
    fireEvent.change(screen.getByLabelText("New user for Remote Hub"), { target: { value: "bad@pam" } });
    review();
    expect((await screen.findAllByRole("alert"))[0]?.textContent).toContain("@pve");
    expect(a.onboardPlan).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("New user for Remote Hub"), { target: { value: "rh-two@pve" } });
    review();
    await screen.findByTestId("pve-plan");
    expect(a.onboardPlan).toHaveBeenCalledWith(expect.objectContaining({ userId: "rh-two@pve" }));
  });

  it("an existing managed setup is described: kept role and ACL, replaced password, and what else the user holds", async () => {
    const extras = { acl: [{ path: "/", role: "PVEAdmin" }], groups: ["admins"], tokens: ["ci"] };
    const a = api({ onboardPlan: vi.fn(async () => ({ ...PLAN, role: "keep" as const, user: "rotate_password" as const, acl: "keep" as const, extras })) } as never);
    render(<PveOnboarding api={a} onDone={vi.fn()} onCancel={vi.fn()} />);
    fillAdmin();
    review();
    const plan = await screen.findByTestId("pve-plan");
    expect(plan.textContent).toContain("already exists with exactly these privileges; it stays as it is");
    expect(plan.textContent).toContain("its password will be replaced by a new generated one");
    const more = screen.getByTestId("pve-plan-extras").textContent ?? "";
    expect(more).toContain("Permission PVEAdmin on /");
    expect(more).toContain("Member of group admins");
    expect(more).toContain("API token ci");
    expect(more).toContain("None of it is removed");
  });

  it("a user that is not ours blocks the apply and says to choose another name", async () => {
    const a = api({ onboardPlan: vi.fn(async () => ({ ...PLAN, user: "name_taken" as const })) } as never);
    render(<PveOnboarding api={a} onDone={vi.fn()} onCancel={vi.fn()} />);
    fillAdmin();
    review();
    const plan = await screen.findByTestId("pve-plan");
    expect(plan.textContent).toContain("was not created by Remote Hub");
    expect((screen.getByRole("button", { name: "Create and save" }) as HTMLButtonElement).disabled).toBe(true);
    expect(a.onboardApply).not.toHaveBeenCalled();
  });

  it("a role with other privileges needs its own confirmation, worded as affecting everyone who holds it", async () => {
    const a = api({ onboardPlan: vi.fn(async () => ({ ...PLAN, role: "differs" as const, rolePrivs: "Sys.Modify,VM.Audit" })) } as never);
    render(<PveOnboarding api={a} onDone={vi.fn()} onCancel={vi.fn()} />);
    fillAdmin();
    review();
    const plan = await screen.findByTestId("pve-plan");
    expect(plan.textContent).toContain("exists with other privileges (now: Sys.Modify,VM.Audit)");
    expect(plan.textContent).toContain("narrows the role for everyone who holds it");
    const create = screen.getByRole("button", { name: "Create and save" }) as HTMLButtonElement;
    expect(create.disabled).toBe(true);
    fireEvent.click(screen.getByLabelText(/Replace the role/));
    expect(create.disabled).toBe(false);
    fireEvent.click(create);
    await waitFor(() => expect(a.onboardApply).toHaveBeenCalledWith(expect.objectContaining({ replaceRole: true })));
  });

  it("when the server changed since the review, nothing was written, the password is cleared and the review starts again", async () => {
    const steps = { role: "not_attempted" as const, user: "not_attempted" as const, acl: "not_attempted" as const };
    const a = api({ onboardApply: vi.fn(async () => ({ ok: false as const, code: "plan_changed", message: "", fingerprint: null, steps })) } as never);
    render(<PveOnboarding api={a} onDone={vi.fn()} onCancel={vi.fn()} />);
    fillAdmin();
    review();
    await screen.findByTestId("pve-plan");
    fireEvent.click(screen.getByRole("button", { name: "Create and save" }));
    expect((await screen.findByTestId("pve-onboard-error")).textContent).toContain("Proxmox changed after you reviewed the plan");
    expect(screen.queryByTestId("pve-plan")).toBeNull();
    expect(passwordField().value).toBe("");
  });

  it("a partly done setup lists what exists on the server and offers to keep the incomplete connection", async () => {
    const steps = { role: "done" as const, user: "done" as const, acl: "failed" as const };
    const a = api({ onboardApply: vi.fn(async () => ({ ok: false as const, code: "api_error", message: "Proxmox answered with status 500", fingerprint: null, steps, profileId: "kept-profile" })) } as never);
    const onDone = vi.fn();
    render(<PveOnboarding api={a} onDone={onDone} onCancel={vi.fn()} />);
    fillAdmin();
    review();
    await screen.findByTestId("pve-plan");
    fireEvent.click(screen.getByRole("button", { name: "Create and save" }));
    const list = (await screen.findByTestId("pve-onboard-steps")).textContent ?? "";
    expect(list).toContain("Role: done");
    expect(list).toContain("User: done");
    expect(list).toContain("Permission: failed");
    expect(screen.getByTestId("pve-onboard-error").textContent).toContain("setup incomplete");
    expect(passwordField().value).toBe("");
    fireEvent.click(screen.getByRole("button", { name: "Keep the connection and close" }));
    expect(onDone).toHaveBeenCalledWith("kept-profile");
  });

  it("Back returns to the form without applying", async () => {
    const a = api();
    render(<PveOnboarding api={a} onDone={vi.fn()} onCancel={vi.fn()} />);
    fillAdmin();
    review();
    await screen.findByTestId("pve-plan");
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.queryByTestId("pve-plan")).toBeNull();
    expect(a.onboardApply).not.toHaveBeenCalled();
  });

  it("asks nothing of the server when the form is incomplete", async () => {
    const a = api();
    render(<PveOnboarding api={a} onDone={vi.fn()} onCancel={vi.fn()} />);
    review();
    expect((await screen.findAllByRole("alert"))[0]?.textContent).toContain("host");
    fireEvent.change(screen.getByLabelText("Host"), { target: { value: "pve.test" } });
    review();
    await waitFor(() => expect(screen.getAllByRole("alert").some((e) => e.textContent?.includes("administrator"))).toBe(true));
    expect(a.onboardPlan).not.toHaveBeenCalled();
  });

  it("an untrusted certificate shows its fingerprint; trusting it keeps the pin and asks for the password again", async () => {
    const plan = vi.fn(async (input: { trust: unknown }) => (input.trust === null ? { ok: false as const, code: "tls_untrusted", message: "", fingerprint: FP } : PLAN));
    const a = api({ onboardPlan: plan } as never);
    render(<PveOnboarding api={a} onDone={vi.fn()} onCancel={vi.fn()} />);
    fillAdmin();
    review();
    const cert = await screen.findByTestId("pve-onboard-cert");
    expect(cert.textContent).toContain(FP);
    expect(passwordField().value).toBe("");
    fireEvent.click(screen.getByRole("button", { name: "Trust this certificate" }));
    fireEvent.change(passwordField(), { target: { value: ADMIN_PW } });
    review();
    await screen.findByTestId("pve-plan");
    expect(plan).toHaveBeenLastCalledWith(expect.objectContaining({ trust: { mode: "pin", fingerprint: FP } }));
  });

  it("a refused administrator login is explained with the action to take, and the password is cleared", async () => {
    const a = api({ onboardPlan: vi.fn(async () => ({ ok: false as const, code: "login_failed", message: "", fingerprint: null })) } as never);
    render(<PveOnboarding api={a} onDone={vi.fn()} onCancel={vi.fn()} />);
    fillAdmin();
    review();
    expect((await screen.findByTestId("pve-onboard-error")).textContent).toContain("refused the login");
    expect(passwordField().value).toBe("");
  });

  it("Cancel clears the password and leaves without any call", () => {
    const a = api();
    const onCancel = vi.fn();
    render(<PveOnboarding api={a} onDone={vi.fn()} onCancel={onCancel} />);
    fillAdmin();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalled();
    expect(passwordField().value).toBe("");
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
