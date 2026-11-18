// The owner's Proxmox operations behind the RPC layer: discovery, pinning a certificate the owner confirmed, linking a
// guest to an SSH/RDP profile, and the two onboarding modes. The checks live here (a pin only for the certificate
// the server really presented, a new password saved only for the profile it creates, a rollback when a step fails),
// so the handlers stay thin and tests drive this with fakes. Nothing here returns or logs a secret.
import type { AgentAudit } from "../../core/agent-audit.ts";
import { bindForProfile, type CredentialBook, CredentialError } from "../../core/credential.ts";
import { DEFAULT_PVE_PORT } from "../../core/catalogue.ts";
import { LOCAL_EXECUTION_HOST_ID, profileFieldsOf, type Profile, type ProfileFields } from "../../core/profile.ts";
import type { ProfileBook } from "../../core/profile-book.ts";
import { PVE_PROVISION, type PveConnect } from "../../core/pve-protocol.ts";
import { pveTrustToWire, type PveProfileTrust } from "../../core/pve-trust.ts";
import { PveDiscovery, type PveAnswer, type PveConnectionView, type PveProvisionAnswer } from "../../core/pve-targets.ts";
import type { PveGuestLinkStore } from "./pve-sqlite.ts";
import type { RemoteHubService } from "./service.ts";

export class PveRpcError extends Error {
  readonly code: "not_found" | "invalid" | "forbidden";
  constructor(code: PveRpcError["code"], message: string) {
    super(message);
    this.name = "PveRpcError";
    this.code = code;
  }
}

export interface PveRpcDeps {
  service: Pick<RemoteHubService, "pve" | "credentialVault">;
  profiles: ProfileBook;
  credentials: CredentialBook;
  links: PveGuestLinkStore;
  newId: () => string;
  now: () => Date;
  audit?: AgentAudit | undefined;
}

export type OnboardEndpoint = { host: string; port: number; trust: PveProfileTrust | null };
export type OnboardAdmin = OnboardEndpoint & { adminUser: string; adminPassword: string; aclPath: string };

const OWNER = "owner RPC";

export function createPveRpc(deps: PveRpcDeps) {
  const { service, profiles, credentials, links } = deps;

  const pveProfile = (id: string): Profile => {
    const p = profiles.get(id);
    if (p === null || p.protocol !== "pve") throw new PveRpcError("not_found", "no such Proxmox connection");
    return p;
  };

  /** What the helper needs to sign in as a saved connection; the secret is only named, the helper resolves it. */
  const connectOf = (p: Profile): PveConnect | null => {
    if (p.credentialRef === null || p.username === null) return null;
    return {
      host: p.host,
      port: p.port ?? DEFAULT_PVE_PORT,
      authMode: p.authType === "token" ? "token" : "ticket",
      user: p.username,
      credentialRef: p.credentialRef,
      trust: pveTrustToWire(p.pveTrust),
    };
  };

  const discovery = new PveDiscovery({
    profiles: () => profiles.list().filter((p) => p.protocol === "pve").map((p) => ({ id: p.id, name: p.name, credentialRef: p.credentialRef })),
    fetch: async (id): Promise<PveAnswer> => {
      const p = profiles.get(id);
      const connect = p === null ? null : connectOf(p);
      if (connect === null) return { ok: false, code: "no_credential", message: "", fingerprint: null };
      return await service.pve.targets(connect);
    },
    links: (id) => links.forProfile(id),
    now: deps.now,
  });

  const audited = async <T>(tool: string, profileId: string | null, detail: string, run: () => Promise<T>, outcomeOf: (r: T) => string): Promise<T> => {
    const ticket = deps.audit?.begin({ threadId: OWNER, projectId: "", tool, profileId, detail });
    try {
      const result = await run();
      ticket?.finish(outcomeOf(result));
      return result;
    } catch (error) {
      ticket?.finish("failed");
      throw error;
    }
  };

  const adminConnect = (a: OnboardAdmin): PveConnect => ({
    host: a.host,
    port: a.port,
    authMode: "ticket",
    user: a.adminUser,
    password: a.adminPassword,
    trust: pveTrustToWire(a.trust),
  });

  const remove = (id: string): void => {
    profiles.remove(id);
  };

  return {
    discovery,

    /** A deleted connection leaves no links and no cached lists behind. */
    onProfileDeleted(profileId: string): void {
      links.dropProfile(profileId);
      discovery.forget(profileId);
    },

    /** Every Proxmox connection (or the named ones), each with its own outcome. */
    targets: (input: { profileIds?: string[] | undefined; refresh: boolean }): Promise<PveConnectionView[]> => discovery.targets({ ...(input.profileIds === undefined ? {} : { profileIds: input.profileIds }), refresh: input.refresh }),

    /** The owner confirmed the certificate a refusal showed: trust exactly that one, for this connection only. */
    pinTrust(profileId: string, fingerprint: string): void {
      const p = pveProfile(profileId);
      if (discovery.lastPresented(profileId) !== fingerprint) {
        throw new PveRpcError("forbidden", "that is not the certificate this server presented; refresh the list and compare again");
      }
      const ticket = deps.audit?.begin({ threadId: OWNER, projectId: "", tool: "pve.pin", profileId, detail: fingerprint });
      try {
        profiles.save({ id: p.id, fields: { ...profileFieldsOf(p), pveTrust: { mode: "pin", fingerprint } } });
        discovery.forget(profileId);
        ticket?.finish("pinned");
      } catch (error) {
        ticket?.finish("failed");
        throw error;
      }
    },

    /** The owner's choice of the SSH/RDP profile that reaches a guest; never a guessed address. */
    linkGuest(profileId: string, vmid: number, linkProfileId: string | null): void {
      pveProfile(profileId);
      if (linkProfileId === null) {
        links.clear(profileId, vmid);
        return;
      }
      const target = profiles.get(linkProfileId);
      if (target === null || (target.protocol !== "ssh" && target.protocol !== "rdp")) throw new PveRpcError("invalid", "a guest links to a saved SSH or RDP profile");
      links.set(profileId, vmid, linkProfileId);
    },

    /** Mode 1, step 1: what would be created. Reads only; the admin's login is used for this call and dropped. */
    async onboardPlan(input: OnboardAdmin): Promise<PveProvisionAnswer> {
      return await audited("pve.onboard_plan", null, `${input.host}:${input.port} as ${input.adminUser}`, () => service.pve.provision({ connect: adminConnect(input), dryRun: true, aclPath: input.aclPath }), (r) => (r.ok ? "planned" : r.code));
    },

    /**
     * Mode 1, step 2, after the owner confirmed: create role, user and ACL entry, and save the new user's password in the
     * Keychain (the helper does that; it never comes here). The result is a saved connection signing in as `remotehub@pve`.
     */
    async onboardApply(input: OnboardAdmin & { name: string }): Promise<{ ok: true; profileId: string; plan: { role: string; user: string; acl: string } } | { ok: false; code: string; message: string; fingerprint: string | null }> {
      return await audited(
        "pve.onboard_apply",
        null,
        `${input.host}:${input.port} as ${input.adminUser}`,
        async () => {
          const fields: ProfileFields = {
            name: input.name,
            protocol: "pve",
            group: null,
            tags: [],
            favorite: false,
            color: null,
            host: input.host,
            port: input.port === DEFAULT_PVE_PORT ? null : input.port,
            username: PVE_PROVISION.user,
            domain: null,
            authType: "password",
            identityFile: null,
            credentialRef: null,
            rdpWidth: null,
            rdpHeight: null,
            pveTrust: input.trust,
          };
          const profile = profiles.save({ fields });
          const ref = `rh-cred:v1:${LOCAL_EXECUTION_HOST_ID}:${deps.newId()}`;
          const answer = await service.pve.provision({ connect: adminConnect(input), dryRun: false, aclPath: input.aclPath, save: { ref, bind: bindForProfile(profile) } });
          if (!answer.ok) {
            remove(profile.id);
            return answer;
          }
          try {
            await credentials.adopt({ profileId: profile.id, ref });
          } catch (error) {
            remove(profile.id);
            await service.credentialVault.delete(ref).catch(() => undefined);
            if (error instanceof CredentialError) return { ok: false as const, code: error.code, message: error.message, fingerprint: null };
            throw error;
          }
          return { ok: true as const, profileId: profile.id, plan: { role: answer.role, user: answer.user, acl: answer.acl } };
        },
        (r) => (r.ok ? "applied" : r.code),
      );
    },

    /** Mode 2: connect as is. The secret is saved for exactly this connection; nothing is created in Proxmox. */
    async onboardConnect(input: OnboardEndpoint & { name: string; authMode: "ticket" | "token"; user: string; secret: string }): Promise<{ ok: true; profileId: string } | { ok: false; code: string; message: string }> {
      const fields: ProfileFields = {
        name: input.name,
        protocol: "pve",
        group: null,
        tags: [],
        favorite: false,
        color: null,
        host: input.host,
        port: input.port === DEFAULT_PVE_PORT ? null : input.port,
        username: input.user,
        domain: null,
        authType: input.authMode === "token" ? "token" : "password",
        identityFile: null,
        credentialRef: null,
        rdpWidth: null,
        rdpHeight: null,
        pveTrust: input.trust,
      };
      const profile = profiles.save({ fields });
      try {
        await credentials.save({ profileId: profile.id, secret: input.secret });
      } catch (error) {
        remove(profile.id);
        if (error instanceof CredentialError) return { ok: false, code: error.code, message: error.message };
        throw error;
      }
      deps.audit?.begin({ threadId: OWNER, projectId: "", tool: "pve.connect_as_is", profileId: profile.id, detail: `${input.host}:${input.port} as ${input.user}` }).finish("saved");
      return { ok: true, profileId: profile.id };
    },
  };
}

export type PveRpc = ReturnType<typeof createPveRpc>;
