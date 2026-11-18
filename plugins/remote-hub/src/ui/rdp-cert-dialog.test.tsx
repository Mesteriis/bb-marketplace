// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RdpCertDialog } from "./rdp-cert-dialog.tsx";
import type { RdpCertPromptInfo } from "../core/rpc.ts";

afterEach(cleanup);

const FP = Array.from({ length: 32 }, (_, i) => (i * 7 + 3).toString(16).toUpperCase().padStart(2, "0")).join(":");
const PROMPT: RdpCertPromptInfo = {
  host: "rdp.test",
  port: 3389,
  fingerprint: FP,
  subject: "CN=rdp-test",
  issuer: "CN=Corp Issuing CA",
  notBefore: "1794882534",
  notAfter: "1826418534",
  reason: "untrusted_root",
};

describe("RdpCertDialog", () => {
  it("shows endpoint, fingerprint, subject, issuer, validity and the reason", () => {
    render(<RdpCertDialog prompt={PROMPT} onDecide={() => {}} />);
    expect(screen.getByText("rdp.test:3389")).toBeTruthy();
    expect(screen.getByTestId("rdp-cert-fingerprint").textContent).toBe(FP);
    expect(screen.getByTestId("rdp-cert-subject").textContent).toBe("CN=rdp-test");
    expect(screen.getByTestId("rdp-cert-issuer").textContent).toBe("CN=Corp Issuing CA");
    expect(screen.getByTestId("rdp-cert-valid").textContent).toBe("2026-11-17 02:28:54 UTC to 2027-11-17 02:28:54 UTC");
    expect(screen.getByText("the certificate is not signed by a root this Mac trusts")).toBeTruthy();
  });

  it("shows the empty-subject text as the service gives it and an empty issuer as such", () => {
    render(<RdpCertDialog prompt={{ ...PROMPT, subject: "(empty subject) SAN: DNS:san-only.example.com", issuer: "" }} onDecide={() => {}} />);
    expect(screen.getByTestId("rdp-cert-subject").textContent).toBe("(empty subject) SAN: DNS:san-only.example.com");
    expect(screen.getByTestId("rdp-cert-issuer").textContent).toBe("(empty issuer)");
  });

  it("states cert_changed prominently", () => {
    render(<RdpCertDialog prompt={{ ...PROMPT, reason: "cert_changed" }} onDecide={() => {}} />);
    const reason = screen.getByText(/^this is a DIFFERENT certificate than the one you trusted for this host and port\. A saved password is not sent to it\./);
    expect(reason.className).toContain("rh-error");
    // A changed certificate is never offered "for good": the old one has to be forgotten first.
    expect(screen.queryByText("Always trust this certificate")).toBeNull();
    expect(screen.getByText(/forget the old one \(Import screen, RDP certificates you trust\)/)).toBeTruthy();
  });

  it("every decision carries the PRESENTED fingerprint", () => {
    const onDecide = vi.fn();
    render(<RdpCertDialog prompt={PROMPT} onDecide={onDecide} />);
    fireEvent.click(screen.getByText("Accept once"));
    fireEvent.click(screen.getByText("Trust for this BB run"));
    fireEvent.click(screen.getByText("Always trust this certificate"));
    fireEvent.click(screen.getByText("Reject"));
    expect(onDecide.mock.calls).toEqual([
      [FP, "once"],
      [FP, "session_trust"],
      [FP, "always_trust"],
      [FP, "reject"],
    ]);
  });

  it("starts with focus on the dialog, no button focused, and Enter accepts nothing", () => {
    const onDecide = vi.fn();
    render(<RdpCertDialog prompt={PROMPT} onDecide={onDecide} />);
    const dialog = screen.getByRole("alertdialog");
    expect(document.activeElement).toBe(dialog);
    fireEvent.keyDown(dialog, { key: "Enter" });
    expect(onDecide).not.toHaveBeenCalled();
  });

  it("Escape is Reject, with the presented fingerprint", () => {
    const onDecide = vi.fn();
    render(<RdpCertDialog prompt={PROMPT} onDecide={onDecide} />);
    fireEvent.keyDown(screen.getByRole("alertdialog"), { key: "Escape" });
    expect(onDecide.mock.calls).toEqual([[FP, "reject"]]);
  });

  it("keeps Tab and Shift+Tab inside the dialog", () => {
    render(<RdpCertDialog prompt={PROMPT} onDecide={() => {}} />);
    const dialog = screen.getByRole("alertdialog");
    const [accept, trust, always, reject] = ["Accept once", "Trust for this BB run", "Always trust this certificate", "Reject"].map((t) => screen.getByText(t));
    fireEvent.keyDown(dialog, { key: "Tab" }); // from the dialog itself: the first button
    expect(document.activeElement).toBe(accept);
    fireEvent.keyDown(accept, { key: "Tab" });
    expect(document.activeElement).toBe(trust);
    fireEvent.keyDown(trust, { key: "Tab" });
    expect(document.activeElement).toBe(always);
    fireEvent.keyDown(always, { key: "Tab" });
    expect(document.activeElement).toBe(reject);
    fireEvent.keyDown(reject, { key: "Tab" }); // wraps
    expect(document.activeElement).toBe(accept);
    fireEvent.keyDown(accept, { key: "Tab", shiftKey: true }); // wraps backwards
    expect(document.activeElement).toBe(reject);
  });

  it("is labelled and modal for assistive technology", () => {
    render(<RdpCertDialog prompt={PROMPT} onDecide={() => {}} />);
    const dialog = screen.getByRole("alertdialog");
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(document.getElementById(dialog.getAttribute("aria-labelledby")!)?.textContent).toBe("Trust this server certificate?");
  });

  it("does nothing while disabled (a decision is in flight)", () => {
    const onDecide = vi.fn();
    render(<RdpCertDialog prompt={PROMPT} onDecide={onDecide} disabled />);
    fireEvent.keyDown(screen.getByRole("alertdialog"), { key: "Escape" });
    expect((screen.getByText("Accept once") as HTMLButtonElement).disabled).toBe(true);
    expect(onDecide).not.toHaveBeenCalled();
  });
});

describe("RdpCertDialog first use of a saved password (X1)", () => {
  it("says that accepting pins the saved password to this certificate, only for a first use", () => {
    const { rerender } = render(<RdpCertDialog prompt={{ ...PROMPT, reason: "first_use", firstUse: true }} onDecide={() => {}} />);
    expect(screen.getByTestId("rdp-cert-pins").textContent).toContain("pins the saved password to this certificate");
    expect(screen.getByText("this is the first use of the saved password")).toBeTruthy();
    rerender(<RdpCertDialog prompt={PROMPT} onDecide={() => {}} />);
    expect(screen.queryByTestId("rdp-cert-pins")).toBeNull();
  });
});
