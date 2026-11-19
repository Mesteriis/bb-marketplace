import { describe, expect, it } from "vitest";
import { delayBefore, isRetryable, RECONNECT_ATTEMPTS } from "./pve-reconnect.ts";

describe("reconnect policy", () => {
  it("is five attempts waiting 1, 2, 4, 8 and 16 seconds, jittered by at most a quarter", () => {
    expect(RECONNECT_ATTEMPTS).toBe(5);
    expect([1, 2, 3, 4, 5].map((n) => delayBefore(n, 0.5))).toEqual([1000, 2000, 4000, 8000, 16000]);
    expect(delayBefore(1, 0)).toBe(750);
    expect(delayBefore(1, 0.999999)).toBe(1250);
    expect(delayBefore(5, 0)).toBe(12000);
    expect(delayBefore(5, 0.999999)).toBe(20000);
  });

  it("retries only what repeating can change", () => {
    for (const c of ["remote_closed", "websocket_error", "engine_exited", "helper_exited", "unreachable", "timeout", "api_error", "node_offline"]) expect(isRetryable(c), c).toBe(true);
    for (const c of ["login_failed", "no_permission", "tls_untrusted", "cert_changed", "tfa_required", "guest_stopped", "guest_is_template", "guest_not_found", "no_credential", "unsupported_console", "idle_timeout", "closed_by_user", "vnc_not_resumable"]) expect(isRetryable(c), c).toBe(false);
  });
});
