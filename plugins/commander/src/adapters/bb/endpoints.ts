// S16
import { EDIT_SNAPSHOT_ENDPOINT } from "../../core/edit-session.ts";
import { experimental_PluginRpcCallError, type BbPluginApi } from "@get-bb/plugin-sdk";
import { CommanderError } from "../../core/errors.ts";
import { EndpointId, type Endpoint } from "../../core/model.ts";
import { NameSegment, ResourcePath } from "../../core/path.ts";
import type { FileProvider } from "../../core/provider.ts";
import { HostFsContract } from "../../core/wire/host-fs.ts";
import { sftpFastMethods } from "./sftp-fast-wire.ts";
import { SFTP_REFUSALS, SftpRefusal, type RemoteHubPort, type SftpInput, type SftpMethodName, type SftpOutput, type SftpRefusalCode } from "../../core/wire/remote-hub-sftp.ts";
import type { EndpointView } from "../../core/wire/rpc.ts";
import { createLocalProvider, translateHostFsError } from "./local-provider.ts";
import { createSftpProvider, type SftpProvider } from "./sftp-provider.ts";
import type { ArchiveManager } from "./archive-manager.ts";
import { z } from "zod";

const remoteId = "makosh-remote-hub";
const bounded = (label: string) => label.slice(0, 200).toWellFormed();
const methods: { [M in SftpMethodName]: { output: z.ZodType<SftpOutput<M>> } } = sftpFastMethods;

/**
 * The Remote Hub refusal code inside a failed `callRpc`, or null for a transport failure.
 * BB 0.50.1 throws the SDK client's BbHttpError ("HTTP 403: host_key_unknown: …", code = the refusal
 * class); newer SDKs throw experimental_PluginRpcCallError ("host_key_unknown: …"). Both carry the
 * refusal class in `code`, which must match the class the contract gives that refusal.
 */
export function remoteHubRefusal(error: unknown): SftpRefusalCode | null {
  let code: unknown;
  let message: unknown;
  if (error instanceof experimental_PluginRpcCallError) {
    ({ code, message } = error);
  } else if (error instanceof Error && error.name === "BbHttpError") {
    code = Reflect.get(error, "code");
    message = error.message.replace(/^HTTP \d{3}: /, "");
  }
  if (typeof code !== "string" || typeof message !== "string") return null;
  // The refusal code is the text before the first ": "; without that exact separator it is not a refusal.
  const end = message.indexOf(": ");
  if (end <= 0) return null;
  const key = message.slice(0, end);
  if (!Object.hasOwn(SFTP_REFUSALS, key)) return null;
  return SFTP_REFUSALS[key as SftpRefusalCode] === code ? key as SftpRefusalCode : null;
}

const SIGN_IN_REFUSALS: ReadonlySet<SftpRefusalCode> = new Set<SftpRefusalCode>([
  "agent_unavailable", "keychain_locked", "keychain_unavailable", "keychain_needs_approval", "credential_missing", "auth_failed",
]);

export function createEndpoints(bb: BbPluginApi, archives: () => ArchiveManager | null = () => null) {
  const hostFs = bb.hosts.experimental_client({ contract: HostFsContract });
  const remote: RemoteHubPort = {
    async call<M extends SftpMethodName>(method: M, input: SftpInput<M>, signal: AbortSignal) {
      try {
        return await bb.sdk.plugins.callRpc({
          pluginId: remoteId, method, input, outputSchema: methods[method].output, signal,
        });
      } catch (error) {
        const refused = remoteHubRefusal(error);
        if (refused !== null) throw new SftpRefusal(refused);
        throw new CommanderError("connection_failed", "Remote Hub request failed", true);
      }
    },
  };

  const hosts = new Map<string, { home: ResourcePath; provider: FileProvider }>();
  const sftp = new Map<string, { provider: SftpProvider; home: ResourcePath; closing?: Promise<void> }>();
  const loadingSftp = new Map<string, Promise<void>>();
  const closing = new AbortController();
  let closed = false;

  async function list(signal: AbortSignal) {
    const [machines, result] = await Promise.all([
      bb.sdk.hosts.list(),
      remote.call("hub_sftp_profiles", {}, signal).catch(() => ({ profiles: [] })),
    ]);
    signal.throwIfAborted();
    const endpoints: z.infer<typeof EndpointView>[] = [];
    for (const host of machines) {
      const id = "host:" + host.id;
      if (id === EDIT_SNAPSHOT_ENDPOINT || !EndpointId.safeParse(id).success) continue;
      const name = bounded(host.name);
      endpoints.push({
        id, provider: "local", hostId: host.id, label: name, machine: name, readOnly: false,
        caseSensitive: hosts.get(id)?.provider.endpoint.caseSensitive ?? false,
      });
    }
    for (const profile of result.profiles) {
      endpoints.push({
        id: "sftp:" + profile.id, provider: "sftp", hostId: null, label: bounded(profile.name),
        machine: bounded(profile.host + ":" + profile.port), readOnly: profile.level !== "write" || profile.consent !== "granted",
        caseSensitive: true, consent: profile.consent,
      });
    }
    for (const endpoint of archives()?.views() ?? []) endpoints.push({ ...endpoint });
    return endpoints;
  }

  async function prepare(ids: Iterable<string>, signal: AbortSignal) {
    const wanted = new Set(ids);
    if (!wanted.size) return;
    // An archive that is not open is never copied by a plain request: the owner estimates and confirms first
    // (archive_resume). The refusal names the element, it is not swallowed.
    for (const id of [...wanted].filter((item) => item.startsWith("archive:"))) {
      wanted.delete(id);
      const manager = archives();
      if (!manager) throw new CommanderError("not_found", "Archives are unavailable");
      manager.provider(id.slice("archive:".length));
    }
    if (!wanted.size) return;
    const endpoints = await list(signal);
    await Promise.all([...wanted].map(async (id) => {
      if (closed) throw new CommanderError("cancelled", "Commander is stopping");
      const view = endpoints.find((candidate) => candidate.id === id);
      if (!view) throw new CommanderError("not_found", "Endpoint is unavailable");
      const { consent, ...endpoint } = view;
      if (endpoint.provider === "sftp") {
        if (consent !== "granted") throw new CommanderError("consent_required", "Remote Hub access is required");
        await prepareSftp(endpoint, signal);
        return;
      }
      let home;
      try {
        home = await hostFs.call("home", {}, { hostId: endpoint.hostId!, signal });
      } catch (error) {
        throw translateHostFsError("home", error, signal);
      }
      hosts.set(id, { home: home.path, provider: createLocalProvider({ ...endpoint, caseSensitive: home.caseSensitive }, hostFs) });
    }));
  }

  async function prepareSftp(endpoint: Endpoint, signal: AbortSignal) {
    while (sftp.get(endpoint.id)?.provider.endpoint.readOnly !== endpoint.readOnly) {
      signal.throwIfAborted();
      closing.signal.throwIfAborted();
      let task = loadingSftp.get(endpoint.id);
      if (!task) {
        // The shared load is registered before invoking the transport. One
        // caller dropping its request cannot abort another caller's load.
        const loadSignal = AbortSignal.any([closing.signal, AbortSignal.timeout(15_000)]);
        task = Promise.resolve().then(() => loadSftp(endpoint, loadSignal)).finally(() => {
          loadingSftp.delete(endpoint.id);
        });
        loadingSftp.set(endpoint.id, task);
      }
      await task;
    }
    signal.throwIfAborted();
  }

  async function loadSftp(endpoint: Endpoint, signal: AbortSignal) {
    const profileId = endpoint.id.slice(5);
    let home: ResourcePath;
    try {
      const { channelId } = await remote.call("hub_sftp_open", { profileId }, signal);
      try {
        const result = await remote.call("hub_sftp_op", { channelId, op: "realpath", path: { text: "." } }, signal);
        if (result.op !== "realpath") throw new Error("Unexpected response");
        const path = "text" in result.path ? Buffer.from(result.path.text) : Buffer.from(result.path.bytes, "base64");
        if (path[0] !== 47) throw new Error("Expected an absolute path");
        const segments = path.toString("latin1").split("/").slice(1).filter(Boolean).map((part) => {
          const bytes = Buffer.from(part, "latin1");
          const text = bytes.toString("utf8");
          return NameSegment.parse(Buffer.from(text).equals(bytes) ? { t: text } : { b: bytes.toString("base64") });
        });
        home = ResourcePath.parse({ segments });
      } finally {
        await remote.call("hub_sftp_close", { channelId }, AbortSignal.timeout(5000)).catch(() => {});
      }
    } catch (error) {
      if (error instanceof SftpRefusal) {
        if (error.code === "host_key_unknown" || error.code === "host_key_changed") {
          throw new CommanderError("host_key_rejected", "Remote Hub did not trust the host key");
        }
        if (error.code === "permission_denied" || error.code === "consent_revoked" || error.code === "consent_required") {
          throw new CommanderError("consent_required", "Remote Hub did not grant access");
        }
        // The same refusals the provider reports as a failed sign-in; the server or the Keychain said no, retrying will not help.
        // Remote Hub needs the owner to finish the profile: the provider calls this unsupported, final.
        if (error.code === "profile_needs_config") {
          throw new CommanderError("unsupported", "The server cannot do this operation");
        }
        if (SIGN_IN_REFUSALS.has(error.code)) {
          throw new CommanderError("auth_failed", "Sign-in to the SFTP server failed");
        }
      }
      throw new CommanderError("connection_failed", "SFTP home directory is unavailable", true);
    }
    signal.throwIfAborted();
    const previous = sftp.get(endpoint.id);
    const closing = previous?.provider.close().catch(() => {});
    sftp.set(endpoint.id, { home, provider: createSftpProvider({ endpoint, port: remote, profileId }), closing });
  }

  return {
    list, prepare, remote,
    home: (id: string): ResourcePath => id.startsWith("archive:") ? { segments: [] } : (hosts.get(id) ?? sftp.get(id))!.home,
    protectedPathsFor: (id: string) => {
      if (id.startsWith("archive:")) return [];
      const host = hosts.get(id) ?? sftp.get(id);
      return host ? [host.home] : null;
    },
    provider(id: string): FileProvider {
      if (id.startsWith("archive:")) return archives()?.provider(id.slice("archive:".length)) ?? (() => {
        throw new CommanderError("not_found", "Archive is not open");
      })();
      const provider = hosts.get(id)?.provider ?? sftp.get(id)?.provider;
      if (!provider) throw new CommanderError("not_found", "Endpoint is unavailable");
      return provider;
    },
    async close() {
      closed = true;
      closing.abort();
      await Promise.allSettled(loadingSftp.values());
      await Promise.allSettled([...sftp.values()].map(({ provider, closing }) => Promise.allSettled([provider.close(), closing])));
      sftp.clear();
      hosts.clear();
    },
  };
}

export type Endpoints = ReturnType<typeof createEndpoints>;
