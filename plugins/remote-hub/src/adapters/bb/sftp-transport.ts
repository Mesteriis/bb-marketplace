// Starts an SFTP channel for a saved connection (the transport port of core/sftp-channels.ts) and answers what the
// channel rules ask about a connection. The secret never passes through here: a connection with a saved credential names
// it by reference and the helper answers ssh's one prompt itself; a connection without one is left to the SSH agent or a
// plain key, with the user's own configuration.
import { statSync } from "node:fs";
import { profileToSshTarget } from "../../core/catalogue.ts";
import { CredentialError } from "../../core/credential.ts";
import { knownHostsName, parseKnownHosts } from "../../core/known-hosts.ts";
import type { Profile } from "../../core/profile.ts";
import type { SftpProfileFacts, SftpTransport } from "../../core/sftp-channels.ts";
import type { RemoteHubService } from "./service.ts";
import { knownHostsTextHolds, readUserKnownHosts } from "./user-known-hosts.ts";

export interface SftpTransportDeps {
  service: Pick<RemoteHubService, "sftpOpen" | "knownHosts">;
  profiles: { get(id: string): Profile | null };
  credentials: { authorizeSsh(ref: string, endpoint: { protocol: "ssh"; host: string; port: number; user: string | null; domain: null }, identityFile: string | undefined): "password" | "publickey" };
  env?: Record<string, string | undefined>;
  /** The user's own known_hosts text (tests give a fixture; the real file is never read by a test). */
  userKnownHosts?: () => string;
}

export function sftpProfileFacts(profile: Profile | null): SftpProfileFacts | null {
  if (profile === null) return null;
  return {
    protocol: profile.protocol,
    agent: profile.authType === "agent",
    needsSecret: profile.authType === "password" && profile.credentialRef === null,
    needsConfig: profile.needsConfig === true,
  };
}

export function createSftpTransport({ service, profiles, credentials }: SftpTransportDeps): SftpTransport {
  return {
    async open(profileId, sink) {
      const profile = profiles.get(profileId);
      if (profile === null || profile.protocol !== "ssh") throw Object.assign(new Error("no such SSH connection"), { code: "ssh_option_rejected" });
      const target = profileToSshTarget(profile);
      if (profile.credentialRef === null) return service.sftpOpen(target, null, sink);
      let authMethod: "password" | "publickey";
      try {
        authMethod = credentials.authorizeSsh(profile.credentialRef, { protocol: "ssh", host: profile.host.toLowerCase(), port: profile.port ?? 22, user: profile.username, domain: null }, target.identityFile);
      } catch (error) {
        if (error instanceof CredentialError) throw Object.assign(new Error(error.code), { code: error.code === "credential_unknown" ? "credential_missing" : error.code });
        throw error;
      }
      return service.sftpOpen({ ...target, authMethod }, profile.credentialRef, sink);
    },
  };
}

/** Whether an SSH agent socket is there at all. */
export function sshAgentPresent(env: Record<string, string | undefined>): boolean {
  const path = env.SSH_AUTH_SOCK;
  if (path === undefined || path === "") return false;
  try {
    return statSync(path).isSocket();
  } catch {
    return false;
  }
}

/**
 * Whether a connection's host key is already confirmed, for the listing a plugin sees: Remote Hub's own host keys for a
 * connection with a saved credential, the user's known_hosts for one without. A hint only; ssh decides when a channel opens.
 */
export function createHostKeyHint({ service, userKnownHosts = readUserKnownHosts }: Pick<SftpTransportDeps, "service" | "userKnownHosts">): (profile: Profile) => Promise<boolean> {
  return async (profile) => {
    if (profile.credentialRef === null) return knownHostsTextHolds(userKnownHosts(), profile.host, profile.port);
    const name = knownHostsName(profile.host, profile.port);
    const entries = await parseKnownHosts((await service.knownHosts.list()).join("\n"));
    return entries.some((entry) => entry.hosts.includes(name));
  };
}
