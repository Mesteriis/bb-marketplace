// The SFTP channels other plugins hold (see sftp-contract.ts). A channel belongs to the plugin that opened it and to one
// saved connection; nobody else can use or close it. Every open and every operation asks the grant book again, so a revoke
// takes effect at once: the plugin's channels to that connection are ended and the next call is refused. Pure: starting ssh
// is behind the transport port.
import { PluginGrantBook } from "./plugin-grants.ts";
import { SftpClient, SftpOpError } from "./sftp-client.ts";
import { attrsOut, fromBase64, pathBytes, pathOut, toBase64 } from "./sftp-codec.ts";
import { neededLevel, SFTP_LIMITS, type SftpOpInput, type SftpOpOutput, type SftpPath, type SftpRefusalCode } from "./sftp-contract.ts";
import { classifyChannelEnd, classifyOpenRefusal } from "./sftp-failure.ts";
import type { SftpChannelEnd } from "./sftp-protocol.ts";

export interface SftpStream {
  /** The helper generation the channel lives in. */
  generation: string;
  /** False when the stream is gone and nothing was sent. */
  write(bytes: Uint8Array): boolean;
  close(): void;
}

export interface SftpTransport {
  /**
   * Starts ssh with the sftp subsystem for a saved connection. Bytes of the server go to `sink.data`; `sink.closed` is the
   * last call. A refusal before ssh starts is thrown as an object with the helper's `code`.
   */
  open(profileId: string, sink: { data(bytes: Uint8Array): void; closed(end: SftpChannelEnd): void }): Promise<SftpStream>;
}

export interface SftpProfileFacts {
  protocol: string;
  /** Where it connects (the name the owner saved). */
  host: string;
  /** Signs in with the SSH agent (no saved secret, no key file of its own). */
  agent: boolean;
  /** A password connection without a saved password: nobody can type it for a channel. */
  needsSecret: boolean;
  /** An imported alias that was never resolved to where it really goes. */
  needsConfig?: boolean;
}

export type SftpChannelState = "open" | "closed" | "revoked" | "hostkey_changed";

export interface SftpChannelsDeps {
  grants: PluginGrantBook;
  transport: SftpTransport;
  profile(profileId: string): SftpProfileFacts | null;
  /** Whether the SSH agent ssh uses for this host is there at all (asked only after an agent connection was refused). */
  agentPresent(host: string): boolean;
  newId(): string;
  now(): Date;
  /** How long the server may take to answer the version exchange. */
  startTimeoutMs?: number;
  /** Identifiers only. */
  onEvent?(event: { pluginId: string; profileId: string; channelId: string; state: SftpChannelState }): void;
}

interface Channel {
  channelId: string;
  pluginId: string;
  profileId: string;
  generation: string;
  openedAt: string;
  client: SftpClient;
  stream: SftpStream;
}

/** Channels remembered after they ended, so a late call is answered by what the owner decided, not by "unknown". */
const TOMBSTONES = 256;

export class SftpChannels {
  private readonly channels = new Map<string, Channel>();
  private readonly gone = new Map<string, { pluginId: string; profileId: string }>();
  /** Opens in flight per plugin: they count against the limit before they have an id. */
  private readonly opening = new Map<string, number>();

  constructor(private readonly deps: SftpChannelsDeps) {}

  private held(pluginId: string): number {
    let n = this.opening.get(pluginId) ?? 0;
    for (const c of this.channels.values()) if (c.pluginId === pluginId) n += 1;
    return n;
  }

  /** Opens a channel for `pluginId` (the caller the host reported). Throws SftpOpError. */
  async open(pluginId: string, profileId: string): Promise<{ channelId: string; generation: string }> {
    const profile = this.deps.profile(profileId);
    if (profile === null) throw new SftpOpError("profile_not_found");
    if (profile.protocol !== "ssh") throw new SftpOpError("profile_not_sftp");
    const allowed = this.deps.grants.check(pluginId, profileId, "read");
    if (!allowed.ok) throw new SftpOpError(allowed.code);
    if (profile.needsConfig === true) throw new SftpOpError("profile_needs_config");
    if (profile.needsSecret) throw new SftpOpError("credential_missing");
    if (this.held(pluginId) >= SFTP_LIMITS.channelsPerPlugin) throw new SftpOpError("limit_exceeded");

    this.opening.set(pluginId, (this.opening.get(pluginId) ?? 0) + 1);
    try {
      let stream: SftpStream | null = null;
      let ended: SftpChannelEnd | null = null;
      let onEnd: (() => void) | null = null;
      let channelId: string | null = null;
      const client = new SftpClient((bytes) => {
        if (stream === null || !stream.write(bytes)) client.end();
      });
      const early: Uint8Array[] = [];
      const sink = {
        data: (bytes: Uint8Array) => {
          if (stream === null) early.push(bytes);
          else client.feed(bytes);
        },
        closed: (end: SftpChannelEnd) => {
          ended = end;
          client.end();
          onEnd?.();
          if (channelId !== null) this.drop(channelId, classifyChannelEnd(end, null) === "host_key_changed" ? "hostkey_changed" : "closed");
        },
      };
      try {
        stream = await this.deps.transport.open(profileId, sink);
      } catch (error) {
        const code = (error as { code?: unknown } | null)?.code;
        throw new SftpOpError(typeof code === "string" ? classifyOpenRefusal(code) : "failure");
      }
      const opened = stream;
      try {
        const version = client.start();
        // Every way it can fail is answered below; an early end must not leave it unhandled.
        version.catch(() => undefined);
        for (const bytes of early.splice(0)) client.feed(bytes);
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => reject(new SftpOpError("unreachable")), this.deps.startTimeoutMs ?? 45_000);
          const fail = (): void => {
            clearTimeout(timer);
            reject(new SftpOpError(ended === null ? "failure" : classifyChannelEnd(ended, profile.agent ? (this.deps.agentPresent(profile.host) ? "present" : "absent") : null)));
          };
          onEnd = fail;
          if (ended !== null) return fail();
          version.then(
            () => {
              clearTimeout(timer);
              resolve();
            },
            // The client gave up: the stream ended (told through `closed`, now or in a moment) or the server is not SFTP 3.
            () => (ended !== null ? fail() : setTimeout(() => (ended !== null ? fail() : (clearTimeout(timer), reject(new SftpOpError("profile_not_sftp")))), 50)),
          );
        });
      } catch (error) {
        onEnd = null;
        client.end();
        opened.close();
        throw error;
      }
      onEnd = null;
      // The owner may have revoked while ssh was connecting.
      const still = this.deps.grants.check(pluginId, profileId, "read");
      if (!still.ok) {
        client.end();
        opened.close();
        throw new SftpOpError(still.code);
      }
      channelId = this.deps.newId();
      this.channels.set(channelId, { channelId, pluginId, profileId, generation: opened.generation, openedAt: this.deps.now().toISOString(), client, stream: opened });
      this.deps.onEvent?.({ pluginId, profileId, channelId, state: "open" });
      return { channelId, generation: opened.generation };
    } finally {
      const left = (this.opening.get(pluginId) ?? 1) - 1;
      if (left <= 0) this.opening.delete(pluginId);
      else this.opening.set(pluginId, left);
    }
  }

  /** Ends a channel and remembers whose it was. */
  private drop(channelId: string, state: Exclude<SftpChannelState, "open">): void {
    const channel = this.channels.get(channelId);
    if (channel === undefined) return;
    this.channels.delete(channelId);
    this.gone.set(channelId, { pluginId: channel.pluginId, profileId: channel.profileId });
    if (this.gone.size > TOMBSTONES) this.gone.delete(this.gone.keys().next().value as string);
    channel.client.end();
    channel.stream.close();
    this.deps.onEvent?.({ pluginId: channel.pluginId, profileId: channel.profileId, channelId, state });
  }

  /** The plugin closes its own channel. False when it has no such channel. */
  close(pluginId: string, channelId: string): boolean {
    if (this.channels.get(channelId)?.pluginId !== pluginId) return false;
    this.drop(channelId, "closed");
    return true;
  }

  /** The owner revoked: every channel of that plugin to that connection ends now. */
  revoked(pluginId: string, profileId: string): number {
    const ids = [...this.channels.values()].filter((c) => c.pluginId === pluginId && c.profileId === profileId).map((c) => c.channelId);
    for (const id of ids) this.drop(id, "revoked");
    return ids.length;
  }

  /** A connection was deleted or changed: its channels end. */
  profileGone(profileId: string): void {
    for (const c of [...this.channels.values()]) if (c.profileId === profileId) this.drop(c.channelId, "closed");
  }

  closeAll(): void {
    for (const id of [...this.channels.keys()]) this.drop(id, "closed");
  }

  /** For the owner's page: who holds what. No paths, no file names. */
  list(): Array<{ channelId: string; pluginId: string; profileId: string; openedAt: string }> {
    return [...this.channels.values()].map(({ channelId, pluginId, profileId, openedAt }) => ({ channelId, pluginId, profileId, openedAt }));
  }

  /** One operation. Throws SftpOpError. */
  async op(pluginId: string, input: SftpOpInput): Promise<SftpOpOutput> {
    const channel = this.channels.get(input.channelId);
    if (channel === undefined || channel.pluginId !== pluginId) {
      const was = this.gone.get(input.channelId);
      if (was !== undefined && was.pluginId === pluginId) {
        const now = this.deps.grants.check(pluginId, was.profileId, neededLevel(input.op));
        if (!now.ok) throw new SftpOpError(now.code);
      }
      throw new SftpOpError("channel_closed");
    }
    const allowed = this.deps.grants.check(pluginId, channel.profileId, neededLevel(input.op));
    if (!allowed.ok) throw new SftpOpError(allowed.code);
    try {
      return await run(channel.client, input);
    } catch (error) {
      if (error instanceof SftpOpError && error.code === "channel_closed") {
        // Nothing was sent. If the reason is that the owner revoked, say that.
        const now = this.deps.grants.check(pluginId, channel.profileId, neededLevel(input.op));
        if (!now.ok) throw new SftpOpError(now.code);
      }
      if (error instanceof SftpOpError) throw error;
      throw new SftpOpError("failure");
    }
  }
}

function bytesOf(path: SftpPath): Uint8Array {
  const bytes = pathBytes(path);
  if (bytes === null) throw new SftpOpError("invalid_path");
  return bytes;
}

async function run(client: SftpClient, input: SftpOpInput): Promise<SftpOpOutput> {
  switch (input.op) {
    case "list": {
      const page = await client.list(bytesOf(input.path), input.cursor, input.limit ?? SFTP_LIMITS.listPage);
      return { op: "list", entries: page.entries.map((e) => ({ name: pathOut(e.name), attrs: attrsOut(e.attrs) })), nextCursor: page.nextCursor };
    }
    case "stat":
      return { op: "stat", attrs: attrsOut(await client.stat(bytesOf(input.path), input.follow)) };
    case "realpath":
      return { op: "realpath", path: pathOut(await client.realpath(bytesOf(input.path))) };
    case "read": {
      const got = await client.read(bytesOf(input.path), BigInt(input.offset), input.length);
      return { op: "read", data: toBase64(got.data), eof: got.eof };
    }
    case "write": {
      const done = await client.write(bytesOf(input.path), BigInt(input.offset), fromBase64(input.data), input.create);
      return { op: "write", written: done.written };
    }
    case "mkdir":
      await client.mkdir(bytesOf(input.path));
      return { op: "mkdir" };
    case "rename":
      await client.rename(bytesOf(input.from), bytesOf(input.to), input.overwrite);
      return { op: "rename" };
    case "remove":
      await client.remove(bytesOf(input.path), input.kind);
      return { op: "remove" };
  }
}

export type { SftpRefusalCode };
