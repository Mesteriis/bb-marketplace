import { experimental_PluginRpcCallError, type BbPluginApi } from "@get-bb/plugin-sdk";
import { CommanderError } from "../../core/errors.ts";
import { EndpointId, type Endpoint } from "../../core/model.ts";
import { NameSegment, ResourcePath } from "../../core/path.ts";
import type { FileProvider } from "../../core/provider.ts";
import { HostFsContract } from "../../core/wire/host-fs.ts";
import { SFTP_REFUSALS, SftpRefusal, sftpMethods, type RemoteHubPort, type SftpInput, type SftpMethodName, type SftpOutput, type SftpRefusalCode } from "../../core/wire/remote-hub-sftp.ts";
import type { EndpointView } from "../../core/wire/rpc.ts";
import { createLocalProvider } from "./local-provider.ts";
import { createSftpProvider, type SftpProvider } from "./sftp-provider.ts";
import { z } from "zod";

const remoteId = "makosh-remote-hub";
const bounded = (label: string) => label.slice(0, 200).toWellFormed();
const methods: { [M in SftpMethodName]: { output: z.ZodType<SftpOutput<M>> } } = sftpMethods;

export function createEndpoints(bb: BbPluginApi) {
  const hostFs = bb.hosts.experimental_client({ contract: HostFsContract });
  const remote: RemoteHubPort = {
    async call<M extends SftpMethodName>(method: M, input: SftpInput<M>, signal: AbortSignal) {
      try {
        return await bb.sdk.plugins.callRpc({
          pluginId: remoteId, method, input, outputSchema: methods[method].output, signal,
        });
      } catch (error) {
        if (error instanceof experimental_PluginRpcCallError) {
          const key = error.message.split(":", 1)[0] as SftpRefusalCode;
          if (Object.hasOwn(SFTP_REFUSALS, key) && SFTP_REFUSALS[key] === error.code) throw new SftpRefusal(key);
        }
        throw new CommanderError("connection_failed", "Remote Hub request failed", true);
      }
    },
  };

  const hosts = new Map<string, { home: ResourcePath; provider: FileProvider }>();
  const sftp = new Map<string, { provider: SftpProvider; home: ResourcePath; closing?: Promise<void> }>();
  const loadingSftp = new Map<string, Promise<void>>();
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
      if (!EndpointId.safeParse(id).success) continue;
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
    return endpoints;
  }

  async function prepare(ids: Iterable<string>, signal: AbortSignal) {
    const wanted = new Set(ids);
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
      } catch {
        throw new CommanderError("connection_failed", "Host filesystem is unavailable", true);
      }
      hosts.set(id, { home: home.path, provider: createLocalProvider({ ...endpoint, caseSensitive: home.caseSensitive }, hostFs) });
    }));
  }

  async function prepareSftp(endpoint: Endpoint, signal: AbortSignal) {
    const cached = sftp.get(endpoint.id);
    if (cached?.provider.endpoint.readOnly === endpoint.readOnly) return;
    await loadingSftp.get(endpoint.id);
    if (sftp.get(endpoint.id)?.provider.endpoint.readOnly === endpoint.readOnly) return;
    if (closed) throw new CommanderError("cancelled", "Commander is stopping");
    const task = loadSftp(endpoint, signal);
    loadingSftp.set(endpoint.id, task);
    try {
      await task;
    } finally {
      if (loadingSftp.get(endpoint.id) === task) loadingSftp.delete(endpoint.id);
    }
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
    home: (id: string): ResourcePath => (hosts.get(id) ?? sftp.get(id))!.home,
    protectedPathsFor: (id: string) => {
      const host = hosts.get(id) ?? sftp.get(id);
      return host ? [host.home] : null;
    },
    provider(id: string): FileProvider {
      const provider = hosts.get(id)?.provider ?? sftp.get(id)?.provider;
      if (!provider) throw new CommanderError("not_found", "Endpoint is unavailable");
      return provider;
    },
    async close() {
      closed = true;
      await Promise.allSettled(loadingSftp.values());
      await Promise.allSettled([...sftp.values()].map(({ provider, closing }) => Promise.allSettled([provider.close(), closing])));
      sftp.clear();
      hosts.clear();
    },
  };
}

export type Endpoints = ReturnType<typeof createEndpoints>;
