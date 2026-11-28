import { describe, expect, it } from "vitest";
import { CommanderError } from "../../core/errors.ts";
import { SFTP_REFUSALS, SftpRefusal } from "../../core/wire/remote-hub-sftp.ts";
import { problemOf } from "../../ui/model.ts";
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
  it("reaches the user as a failed sign-in with a Russian line and no Keychain details", () => {
    const refusal = new SftpRefusal("keychain_unavailable");
    expect(refusal.code).toBe("keychain_unavailable");
    const problem = problemOf(new CommanderError("auth_failed", "Sign-in to the SFTP server failed"));
    expect(problem).toEqual({ code: "auth_failed", message: "Вход отклонён" });
  });
});
