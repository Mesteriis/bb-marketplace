import { describe, expect, it } from "vitest";
import { prepareCall } from "./call.ts";
import { DomainError } from "./errors.ts";
import { FakeClock, credentials } from "./testing/fakes.ts";

const NOW = 1_700_000_030_000;

function deps(configured = true) {
  return {
    clock: new FakeClock(NOW),
    credentials: credentials(configured ? { clientId: "cid", clientSecret: "secret", publicClientId: null } : null),
    api: { zak: async () => "zak-1", profile: async () => ({ displayName: "Иван" }) },
  };
}

function payloadOf(jwt: string): Record<string, unknown> {
  const body = jwt.split(".")[1]!.replace(/-/g, "+").replace(/_/g, "/");
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(body), (c) => c.charCodeAt(0))));
}

describe("prepareCall", () => {
  it("prepares a host start for the owner's own meeting", async () => {
    const call = await prepareCall(deps(), { link: "https://us02web.zoom.us/j/1234567890?pwd=p1", asHost: true });
    expect(call.meetingNumber).toBe("1234567890");
    expect(call.passcode).toBe("p1");
    expect(call.userName).toBe("Иван");
    expect(call.zak).toBe("zak-1");
    expect(call.fallbackUrl).toBe("https://zoom.us/j/1234567890?pwd=p1");
    expect(payloadOf(call.signature)).toEqual({
      appKey: "cid",
      mn: "1234567890",
      role: 1,
      iat: 1_700_000_000,
      exp: 1_700_007_200,
      tokenExp: 1_700_007_200,
      video_webrtc_mode: 1,
    });
  });

  it("joins a pasted number as a participant", async () => {
    const call = await prepareCall(deps(), { link: "123 456 7890", asHost: false });
    expect(call.passcode).toBeNull();
    expect(payloadOf(call.signature).role).toBe(0);
    expect(call.fallbackUrl).toBe("https://zoom.us/j/1234567890");
  });

  it("refuses a link that is not Zoom's", async () => {
    const error = await prepareCall(deps(), { link: "https://example.com/j/1234567890", asHost: false }).catch((e: unknown) => e);
    expect((error as DomainError).code).toBe("invalid_link");
  });

  it("refuses when the Zoom app is not configured", async () => {
    const error = await prepareCall(deps(false), { link: "1234567890", asHost: false }).catch((e: unknown) => e);
    expect((error as DomainError).code).toBe("not_configured");
  });
});
