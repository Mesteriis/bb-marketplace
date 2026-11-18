import { describe, expect, it } from "vitest";
import { RDP_CLOSED_REASONS, RDP_ERROR_CODES, RDP_STATES } from "./rdp-protocol.ts";
import { closeReasonText, errorCodeText, errorTextFromMessage, formatCertTime, promptReasonText, stateText } from "./rdp-texts.ts";

describe("rdp texts", () => {
  it("has a sentence for every close reason the service can return", () => {
    for (const reason of [...RDP_CLOSED_REASONS, "helper_exited", "exited"]) {
      expect(closeReasonText(reason), reason).not.toMatch(/^closed: /);
    }
    expect(closeReasonText("auth_failed")).toBe("sign-in failed: check the user name, password and domain");
    expect(closeReasonText("killed_by_close")).toBe("disconnected");
    expect(closeReasonText("server_disconnected")).toBe("the server ended the session");
    expect(closeReasonText("network_error")).toBe("network error: the server is unreachable or the connection dropped");
    expect(closeReasonText("engine_exited")).toBe("the RDP engine stopped unexpectedly");
    expect(closeReasonText("cert_rejected")).toBe("the server certificate was rejected");
    expect(closeReasonText("something_new")).toBe("closed: something_new");
    expect(closeReasonText(null)).toBe("the session ended");
  });

  it("has a text for every helper error code the TS layer expects, and passes unknown codes through", () => {
    for (const code of RDP_ERROR_CODES) expect(errorCodeText(code), code).not.toBe(code);
    expect(errorCodeText("not_ready")).toBe("the desktop is not ready yet");
    expect(errorCodeText("screenshot_too_large")).toBe("the screenshot is too large to send");
    expect(errorCodeText("session_closed")).toBe("the session has ended");
    expect(errorCodeText("mystery")).toBe("mystery");
  });

  it("reads the code the RPC layer puts in front of a helper refusal", () => {
    expect(errorTextFromMessage("not_ready: the desktop is not ready yet")).toBe("the desktop is not ready yet");
    expect(errorTextFromMessage("screenshot_too_large: too big")).toBe("the screenshot is too large to send");
    expect(errorTextFromMessage("keychain_locked: the Keychain is locked")).toMatch(/Keychain is locked or needs approval/);
    expect(errorTextFromMessage("credential_target_mismatch: x")).toMatch(/different host or user/);
    expect(errorTextFromMessage("credential_missing: gone")).toMatch(/no longer in the Keychain/);
    expect(errorTextFromMessage("connection refused")).toBe("connection refused");
    expect(errorTextFromMessage("whatever: text")).toBe("whatever: text");
  });

  it("has a text for every state", () => {
    expect(RDP_STATES.map(stateText)).toEqual([
      "connecting",
      "securing the connection (TLS)",
      "waiting for your decision on the server certificate",
      "authenticating",
      "desktop ready",
    ]);
    expect(stateText("closed")).toBe("closed");
    expect(stateText("brand_new")).toBe("brand_new");
  });

  it("formats certificate validity from epoch seconds in UTC and leaves other text alone", () => {
    expect(formatCertTime("1794882534")).toBe("2026-11-17 02:28:54 UTC");
    expect(formatCertTime("1826418534")).toBe("2027-11-17 02:28:54 UTC");
    expect(formatCertTime("2026-01-01T00:00:00Z")).toBe("2026-01-01T00:00:00Z");
  });

  it("explains every prompt reason, cert_changed in capitals for the difference", () => {
    expect(promptReasonText("cert_changed")).toBe("this is a DIFFERENT certificate than the one you trusted for this host and port");
    expect(promptReasonText("untrusted_root")).toBe("the certificate is not signed by a root this Mac trusts");
    expect(promptReasonText("hostname_mismatch")).toBe("the certificate was issued for a different host name");
    expect(promptReasonText("expired")).toBe("the certificate is expired or not yet valid");
    expect(promptReasonText("zzz")).toBe("the certificate could not be validated (zzz)");
  });
});
