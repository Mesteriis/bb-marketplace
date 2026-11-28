import { describe, expect, it } from "vitest";
import { SFTP_REFUSALS } from "../../core/wire/remote-hub-sftp.ts";
import { remoteHubRefusal } from "./endpoints.ts";

const httpError = (code: string, message: string) => Object.assign(new Error(message), { name: "BbHttpError", code });

describe("an unreachable Keychain reported by Remote Hub", () => {
  it("is a contract refusal of class conflict", () => {
    expect(SFTP_REFUSALS.keychain_unavailable).toBe("conflict");
  });
  it("is recognised in a failed callRpc only with its class", () => {
    expect(remoteHubRefusal(httpError("conflict", "HTTP 409: keychain_unavailable: cannot read the credential"))).toBe("keychain_unavailable");
    expect(remoteHubRefusal(httpError("forbidden", "HTTP 403: keychain_unavailable: cannot read the credential"))).toBeNull();
  });
});
