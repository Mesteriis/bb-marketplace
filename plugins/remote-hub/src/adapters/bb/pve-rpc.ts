// The owner's Proxmox operations behind the RPC layer: discovery, pinning a certificate the owner confirmed, linking a
// guest to an SSH/RDP profile, and the two onboarding modes. The checks live here (a pin only for a certificate the server
// really presented to this endpoint, an apply only for a plan the owner confirmed, a new password saved only for the
// credentials bound to this endpoint and user, what exists after a partial failure kept and reported), so the handlers stay
// thin and tests drive this with fakes. Nothing here returns or logs a secret or a server's own words.
import type { AgentAudit } from "../../core/agent-audit.ts";
import { bindForProfile, type CredentialBook, CredentialError } from "../../core/credential.ts";
import { DEFAULT_PVE_PORT } from "../../core/catalogue.ts";
import { LOCAL_EXECUTION_HOST_ID, profileFieldsOf, type Profile, type ProfileFields, type ProfileInput } from "../../core/profile.ts";
import type { ProfileBook } from "../../core/profile-book.ts";
import type { PvePlan, PveSteps } from "../../core/pve-protocol.ts";
import { PVE_PROVISION, type PveConnect } from "../../core/pve-protocol.ts";
import { resolveConsole, type ConsoleRequest } from "../../core/pve-console.ts";
import type { SessionHandle } from "../../core/rpc.ts";
import { pveTrustToWire, type PveProfileTrust } from "../../core/pve-trust.ts";
import { PveDiscovery, type PveAnswer, type PveConnectionView } from "../../core/pve-targets.ts";
import type { PveConsoleTabRow, PveConsoleTabStore, PveGuestLinkStore } from "./pve-sqlite.ts";
import { HelperRequestError, HelperRuntimeError, HelperStartError } from "./helper-process.ts";
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
  service: Pick<RemoteHubService, "pve" | "credentialVault" | "pveOpen">;
  profiles: ProfileBook;
  credentials: CredentialBook;
  links: PveGuestLinkStore;
  tabs?: PveConsoleTabStore | undefined;
  newId: () => string;
  now: () => Date;
  audit?: AgentAudit | undefined;
}

export type OnboardEndpoint = { host: string; port: number; trust: PveProfileTrust | null };
export type OnboardAdmin = OnboardEndpoint & { adminUser: string; adminPassword: string; aclPath: string; userId: string };

/** What an apply or a plan answers: the plan, the steps taken, or the failure with what each step did and what exists now. */
export type OnboardFailure = { ok: false; code: string; message: string; fingerprint: string | null; steps: PveSteps | null; profileId?: string };
export type OnboardPlanAnswer = ({ ok: true } & PvePlan) | OnboardFailure;
/** Opening a console: the session, or why not (a code from the console reasons, never a server's own words). */
export type ConsoleOpenAnswer = { ok: true; handle: SessionHandle; kind: "pve" | "vnc" } | { ok: false; code: string; message: string; fingerprint: string | null };
/** `audit: false` for an agent: its remote_connect call already has an audit row under its own thread, and this one would say "owner RPC". */
export type ConsoleOpenInput = ConsoleRequest & { profileId: string; cols: number; rows: number; audit?: boolean };
export type OnboardApplyAnswer = { ok: true; profileId: string; userId: string; steps: PveSteps } | OnboardFailure;

const OWNER = "owner RPC";

const endpointOf = (host: string, port: number): string => `${host.toLowerCase()}:${port}`;
const profileEndpoint = (p: Profile): string => endpointOf(p.host, p.port ?? DEFAULT_PVE_PORT);

export function createPveRpc(deps: PveRpcDeps) {
  const { service, profiles, credentials, links } = deps;
  /** The certificate each endpoint last showed in a refusal during onboarding (no profile exists yet to hold it). */
  const presentedByEndpoint = new Map<string, string>();

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
    profiles: () =>
      profiles
        .list()
        .filter((p) => p.protocol === "pve")
        .map((p) => ({ id: p.id, name: p.name, credentialRef: p.credentialRef, endpoint: profileEndpoint(p), revision: p.updatedAt })),
    fetch: async (id): Promise<PveAnswer> => {
      const p = profiles.get(id);
      const connect = p === null ? null : connectOf(p);
      if (connect === null) return { ok: false, code: "no_credential", message: "", fingerprint: null };
      return await service.pve.targets(connect);
    },
    links: (id) => links.forProfile(id),
    now: deps.now,
  });

  const audited = async <T>(tool: string | null, profileId: string | null, detail: string, run: () => Promise<T>, outcomeOf: (r: T) => string): Promise<T> => {
    const ticket = tool === null ? undefined : deps.audit?.begin({ threadId: OWNER, projectId: "", tool, profileId, detail });
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

  const noteRefusal = (host: string, port: number, answer: { ok: false; fingerprint: string | null }): void => {
    if (answer.fingerprint !== null) presentedByEndpoint.set(endpointOf(host, port), answer.fingerprint);
  };

  /** A certificate pin may only come from what the server presented to this endpoint in a refusal (or be the one already stored). */
  const checkOnboardTrust = (host: string, port: number, trust: PveProfileTrust | null): void => {
    if (trust !== null && trust.mode === "pin" && presentedByEndpoint.get(endpointOf(host, port)) !== trust.fingerprint) {
      throw new PveRpcError("forbidden", "that is not the certificate this server presented; run the review again and compare");
    }
  };

  const failure = (code: string, message: string, extra: Partial<OnboardFailure> = {}): OnboardFailure => ({ ok: false, code, message, fingerprint: null, steps: null, ...extra });

  const audit = (a: OnboardAdmin): string => `${a.host}:${a.port} as ${a.adminUser} user ${a.userId} acl ${a.aclPath}`;

  return {
    discovery,

    /** A deleted connection leaves no links and no cached lists behind. */
    onProfileDeleted(profileId: string): void {
      links.dropProfile(profileId);
      deps.tabs?.dropProfile(profileId);
      discovery.forget(profileId);
    },

    /** The console tabs kept for the owner: targets of connections that still exist. */
    consoleTabs(): PveConsoleTabRow[] {
      return (deps.tabs?.list() ?? []).filter((t) => profiles.get(t.profileId)?.protocol === "pve");
    },
    saveConsoleTab(tab: PveConsoleTabRow): void {
      pveProfile(tab.profileId);
      if (tab.console === "node" ? tab.node === null || tab.vmid !== null : tab.vmid === null || tab.node !== null) throw new PveRpcError("invalid", "a node shell names its node; a guest console names its VMID");
      deps.tabs?.put(tab, deps.now());
    },
    removeConsoleTab(id: string): boolean {
      return deps.tabs?.remove(id) ?? false;
    },

    /**
     * Opens a console of a saved connection: the guest's node is looked up again in a FRESH read (never from the list on the
     * page or a stale one), a stopped guest or a template is refused, and nothing is ever started. Used by the owner's page
     * and by the agent tool alike.
     */
    async openConsole(input: ConsoleOpenInput): Promise<ConsoleOpenAnswer> {
      const p = pveProfile(input.profileId);
      if (connectOf(p) === null) return { ok: false, code: "no_credential", message: "This connection has no saved password or token yet.", fingerprint: null };
      const what = input.console === "node" ? `node ${input.node}` : `${input.console} ${input.vmid}`;
      return await audited(
        input.audit === false ? null : "pve.console_open",
        p.id,
        `${p.host}:${p.port ?? DEFAULT_PVE_PORT} ${what}`,
        async (): Promise<ConsoleOpenAnswer> => {
          const [view] = await discovery.targets({ profileIds: [p.id], refresh: true });
          if (view === undefined) return { ok: false, code: "not_found", message: "no such Proxmox connection", fingerprint: null };
          // The connection may have been edited while Proxmox was read: what was read is not what would be opened.
          const now = profiles.get(p.id);
          const connect = now === null ? null : connectOf(now);
          if (now === null || connect === null || now.updatedAt !== p.updatedAt) return { ok: false, code: "api_error", message: "The connection changed while it was being read. Try again.", fingerprint: null };
          const resolved = resolveConsole(view, input);
          if (!resolved.ok) return resolved;
          try {
            const opened = await service.pveOpen({ connect, target: resolved.target, cols: input.cols, rows: input.rows, profileId: p.id, connectionName: p.name, guestName: resolved.guestName });
            return { ok: true, handle: opened.handle, kind: opened.kind };
          } catch (error) {
            if (error instanceof HelperRequestError) return { ok: false, code: error.code, message: error.message, fingerprint: null };
            if (error instanceof HelperRuntimeError || error instanceof HelperStartError) return { ok: false, code: "helper_exited", message: error.message, fingerprint: null };
            throw error;
          }
        },
        (r) => (r.ok ? "ok" : r.code),
      );
    },

    /** Every Proxmox connection (or the named ones), each with its own outcome. */
    targets: (input: { profileIds?: string[] | undefined; refresh: boolean }): Promise<PveConnectionView[]> => discovery.targets({ ...(input.profileIds === undefined ? {} : { profileIds: input.profileIds }), refresh: input.refresh }),

    /** The owner confirmed the certificate a refusal showed: trust exactly that one, for this connection as it is now. */
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

    /**
     * The generic profile save may store a certificate pin only if it is the one already stored for the same endpoint, or the one
     * the last refusal of this very connection showed. Anything else is refused: a pin is a decision about a certificate the
     * owner was shown.
     */
    checkProfileSave(input: ProfileInput): void {
      const fields = input.fields;
      if (fields.protocol !== "pve" || fields.pveTrust === null || fields.pveTrust === undefined || fields.pveTrust.mode !== "pin") return;
      const pin = fields.pveTrust;
      const existing = input.id === undefined ? null : profiles.get(input.id);
      const sameEndpoint = existing !== null && existing.protocol === "pve" && profileEndpoint(existing) === endpointOf(fields.host, fields.port ?? DEFAULT_PVE_PORT);
      if (sameEndpoint && existing.pveTrust?.mode === "pin" && existing.pveTrust.fingerprint === pin.fingerprint) return;
      if (sameEndpoint && input.id !== undefined && discovery.lastPresented(input.id) === pin.fingerprint) return;
      throw new PveRpcError("forbidden", "a certificate is trusted only by confirming the one the server presented; use the guest list to confirm it");
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

    /** Mode 1, step 1: what would be created, what the user already holds, and the digest of the state it was computed from. Reads only. */
    async onboardPlan(input: OnboardAdmin): Promise<OnboardPlanAnswer> {
      checkOnboardTrust(input.host, input.port, input.trust);
      return await audited(
        "pve.onboard_plan",
        null,
        audit(input),
        async (): Promise<OnboardPlanAnswer> => {
          const answer = await service.pve.provision({ connect: adminConnect(input), dryRun: true, aclPath: input.aclPath, userId: input.userId });
          if (!answer.ok) {
            noteRefusal(input.host, input.port, answer);
            return failure(answer.code, answer.message, { fingerprint: answer.fingerprint, steps: answer.steps });
          }
          if (answer.kind !== "plan") return failure("protocol_error", "the helper did not answer with a plan");
          return { ok: true, ...answer.plan };
        },
        (r) => (r.ok ? "planned" : r.code),
      );
    },

    /**
     * Mode 1, step 2, for the plan the owner confirmed (its digest). Creates what is missing, saves the user's new password in the
     * Keychain for every credential bound to this endpoint and user (a connection saved earlier keeps working), and keeps a
     * connection whose setup is incomplete, flagged, instead of throwing away what already exists on the server.
     */
    async onboardApply(input: OnboardAdmin & { name: string; planDigest: string; replaceRole: boolean }): Promise<OnboardApplyAnswer> {
      checkOnboardTrust(input.host, input.port, input.trust);
      return await audited(
        "pve.onboard_apply",
        null,
        audit(input),
        async (): Promise<OnboardApplyAnswer> => {
          const endpoint = endpointOf(input.host, input.port);
          // Connections already saved for this endpoint and user: a rotation must update their credentials.
          const existing = profiles.list().filter((p) => p.protocol === "pve" && profileEndpoint(p) === endpoint && p.username === input.userId);
          const saves: Array<{ ref: string; bind: ReturnType<typeof bindForProfile> }> = existing.flatMap((p) => (p.credentialRef === null ? [] : [{ ref: p.credentialRef, bind: bindForProfile(p) }]));
          // The profile that will own the new credential: one that has none yet, or a new one.
          let target: Profile | null = existing.find((p) => p.credentialRef === null) ?? null;
          let created: Profile | null = null;
          if (target === null && existing.length === 0) {
            const fields: ProfileFields = {
              name: input.name,
              protocol: "pve",
              group: null,
              tags: [],
              favorite: false,
              color: null,
              host: input.host,
              port: input.port === DEFAULT_PVE_PORT ? null : input.port,
              username: input.userId,
              domain: null,
              authType: "password",
              identityFile: null,
              credentialRef: null,
              rdpWidth: null,
              rdpHeight: null,
              pveTrust: input.trust,
            };
            created = profiles.save({ fields });
            target = created;
          }
          const newRef = `rh-cred:v1:${LOCAL_EXECUTION_HOST_ID}:${deps.newId()}`;
          if (target !== null) saves.push({ ref: newRef, bind: bindForProfile(target) });
          const answer = await service.pve.provision({
            connect: adminConnect(input),
            dryRun: false,
            aclPath: input.aclPath,
            userId: input.userId,
            ...(input.replaceRole ? { replaceRole: true } : {}),
            planDigest: input.planDigest,
            save: saves,
          });
          if (!answer.ok) {
            noteRefusal(input.host, input.port, answer);
            // The password is active on the server (and was saved before the next step) once the user step is done: keep the
            // connection, flagged, so nothing that exists is lost; re-running the setup completes it.
            const userDone = answer.steps?.user === "done";
            if (created !== null && userDone && (await credentials.status(newRef)) === "present") {
              try {
                await credentials.adopt({ profileId: created.id, ref: newRef });
                profiles.recordFailure(created.id, "setup_incomplete");
                return failure(answer.code, answer.message, { fingerprint: answer.fingerprint, steps: answer.steps, profileId: created.id });
              } catch {
                // fall through: it could not be kept
              }
            }
            if (created !== null) {
              profiles.remove(created.id);
              await service.credentialVault.delete(newRef).catch(() => undefined);
            }
            return failure(answer.code, answer.message, { fingerprint: answer.fingerprint, steps: answer.steps });
          }
          if (answer.kind !== "applied") return failure("protocol_error", "the helper did not answer with the applied steps");
          if (target !== null) {
            try {
              await credentials.adopt({ profileId: target.id, ref: newRef });
            } catch (error) {
              if (created !== null) {
                profiles.remove(created.id);
                await service.credentialVault.delete(newRef).catch(() => undefined);
              }
              if (error instanceof CredentialError) return failure(error.code, error.message, { steps: answer.steps });
              throw error;
            }
          }
          const owner = target ?? existing[0];
          if (owner === undefined) return failure("protocol_error", "no connection owns the new credential", { steps: answer.steps });
          profiles.clearFailures(owner.id);
          return { ok: true, profileId: owner.id, userId: input.userId, steps: answer.steps };
        },
        (r) => (r.ok ? "applied" : r.code),
      );
    },

    /** Mode 2: connect as is. The secret is saved for exactly this connection; nothing is created in Proxmox. */
    async onboardConnect(input: OnboardEndpoint & { name: string; authMode: "ticket" | "token"; user: string; secret: string }): Promise<{ ok: true; profileId: string } | { ok: false; code: string; message: string }> {
      checkOnboardTrust(input.host, input.port, input.trust);
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
        profiles.remove(profile.id);
        if (error instanceof CredentialError) return { ok: false, code: error.code, message: error.message };
        throw error;
      }
      deps.audit?.begin({ threadId: OWNER, projectId: "", tool: "pve.connect_as_is", profileId: profile.id, detail: `${input.host}:${input.port} as ${input.user}` }).finish("saved");
      return { ok: true, profileId: profile.id };
    },
  };
}

export type PveRpc = ReturnType<typeof createPveRpc>;

export { PVE_PROVISION };
