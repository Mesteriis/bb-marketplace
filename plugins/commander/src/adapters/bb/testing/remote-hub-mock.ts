// In-memory Remote Hub SFTP helper, modelled on the schemas in src/core/wire/remote-hub-sftp.ts.
// It validates every request with the mirrored schema (so a stray field fails loudly) and answers
// with refusals as the host does: SftpRefusal with a stable code. Test-only; not shipped.
import { randomUUID } from "node:crypto";
import {
  SFTP_LIMITS,
  SftpRefusal,
  type SftpLevel,
  type SftpMethodName,
  type SftpInput,
  type SftpOp,
  type SftpOpInput,
  type SftpOutput,
  type SftpRefusalCode,
  type RemoteHubPort,
  levelAllows,
  neededLevel,
  sftpMethods,
} from "../../../core/wire/remote-hub-sftp.ts";

export type MockConsent = "none" | "pending" | "granted" | "revoked";

export interface RemoteHubMockOptions {
  consent?: MockConsent;
  level?: SftpLevel;
  hostKey?: "trusted" | "unknown" | "changed";
  /** The helper restarts once, after this many operations; channels of the old generation die. */
  generationBumpAfter?: number;
  /** false: rename with overwrite is refused as unsupported (no posix-rename). */
  posixRename?: boolean;
  /** Every write operation fails with this refusal. */
  failWrite?: "unreachable";
  /** The next operation fails with this refusal, then the mock behaves again. */
  failNext?: SftpRefusalCode;
  /** Creates /big with this many files. */
  dirSize?: number;
  /** Adds this field to every operation reply, to prove that the client's schema refuses it. */
  leakField?: "password";
}

export interface MockCall {
  method: SftpMethodName;
  input: unknown;
}

interface FsNode {
  kind: "file" | "dir";
  data: Uint8Array;
}

interface Channel {
  alive: boolean;
  generation: string;
}

const MTIME = 1795790479;
const PROFILE = "5b568675-f842-4a96-83e0-78ae53d96024";
const SLASH = 0x2f;
const decoder = () => new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

function bytesOf(path: string | Uint8Array): Uint8Array {
  return typeof path === "string" ? new TextEncoder().encode(path) : path;
}

function wireBytes(path: { text: string } | { bytes: string }): Uint8Array {
  return "text" in path ? new TextEncoder().encode(path.text) : new Uint8Array(Buffer.from(path.bytes, "base64"));
}

function wireOf(bytes: Uint8Array): { text: string } | { bytes: string } {
  try {
    return { text: decoder().decode(bytes) };
  } catch {
    return { bytes: Buffer.from(bytes).toString("base64") };
  }
}

function keyOf(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

function parentOf(bytes: Uint8Array): Uint8Array | null {
  if (bytes.length === 1 && bytes[0] === SLASH) return null;
  const index = bytes.lastIndexOf(SLASH);
  if (index <= 0) return new Uint8Array([SLASH]);
  return bytes.slice(0, index);
}

function nameOf(bytes: Uint8Array): Uint8Array {
  const index = bytes.lastIndexOf(SLASH);
  return bytes.slice(index + 1);
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function newGeneration(): string {
  return randomUUID().replace(/-/g, "");
}

export class RemoteHubMock implements RemoteHubPort {
  readonly calls: MockCall[] = [];
  private readonly nodes = new Map<string, { path: Uint8Array; node: FsNode }>();
  private readonly channels = new Map<string, Channel>();
  private consent: MockConsent;
  private hostKey: "trusted" | "unknown" | "changed";
  private generation = newGeneration();
  private operations = 0;
  private bumped = false;
  private failNext: SftpRefusalCode | undefined;
  private readonly options: RemoteHubMockOptions;

  constructor(options: RemoteHubMockOptions = {}) {
    this.options = options;
    this.consent = options.consent ?? "granted";
    this.hostKey = options.hostKey ?? "trusted";
    this.failNext = options.failNext;
    this.seedDir("/");
    if (options.dirSize !== undefined) {
      this.seedDir("/big");
      for (let index = 0; index < options.dirSize; index++) {
        this.seedFile(`/big/f${String(index).padStart(5, "0")}`, "");
      }
    }
  }

  seedDir(path: string | Uint8Array): void {
    this.put(bytesOf(path), { kind: "dir", data: new Uint8Array() });
  }

  seedFile(path: string | Uint8Array, data: string | Uint8Array): void {
    const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
    this.put(bytesOf(path), { kind: "file", data: bytes });
  }

  bytesAt(path: string | Uint8Array): Uint8Array | undefined {
    return this.nodes.get(keyOf(bytesOf(path)))?.node.data;
  }

  exists(path: string | Uint8Array): boolean {
    return this.nodes.has(keyOf(bytesOf(path)));
  }

  revoke(): void {
    this.consent = "revoked";
  }

  channelAlive(): boolean {
    return [...this.channels.values()].some((channel) => channel.alive);
  }

  /** Counts recorded calls: "open", "close", or "op:<operation>". */
  opCount(key: "open" | "close" | `op:${SftpOp}`): number {
    return this.calls.filter((call) => {
      if (key === "open") return call.method === "hub_sftp_open";
      if (key === "close") return call.method === "hub_sftp_close";
      return call.method === "hub_sftp_op" && (call.input as { op: string }).op === key.slice(3);
    }).length;
  }

  async call<M extends SftpMethodName>(method: M, input: SftpInput<M>, _signal: AbortSignal): Promise<SftpOutput<M>> {
    this.calls.push({ method, input });
    const parsed = sftpMethods[method].input.parse(input);
    switch (method) {
      case "hub_sftp_open":
        return this.open((parsed as { profileId: string }).profileId) as SftpOutput<M>;
      case "hub_sftp_close":
        return this.close((parsed as { channelId: string }).channelId) as SftpOutput<M>;
      case "hub_sftp_op":
        return this.operate(parsed as SftpOpInput) as SftpOutput<M>;
      default:
        throw new Error(`remote-hub-mock does not model ${method}`);
    }
  }

  private put(path: Uint8Array, node: FsNode): void {
    this.nodes.set(keyOf(path), { path, node });
  }

  private refuse(code: SftpRefusalCode): never {
    throw new SftpRefusal(code);
  }

  private open(profileId: string): { channelId: string; generation: string } {
    if (profileId !== PROFILE) this.refuse("profile_not_found");
    if (this.consent === "revoked") this.refuse("consent_revoked");
    if (this.consent !== "granted") this.refuse("consent_required");
    if (this.hostKey === "unknown") this.refuse("host_key_unknown");
    if (this.hostKey === "changed") this.refuse("host_key_changed");
    const channelId = randomUUID();
    this.channels.set(channelId, { alive: true, generation: this.generation });
    return { channelId, generation: this.generation };
  }

  private close(channelId: string): { closed: boolean } {
    const channel = this.channels.get(channelId);
    if (channel) channel.alive = false;
    return { closed: channel !== undefined };
  }

  private operate(input: SftpOpInput): unknown {
    const channel = this.channels.get(input.channelId);
    if (!channel || !channel.alive) this.refuse("channel_closed");
    if (this.consent === "revoked") {
      channel.alive = false;
      this.refuse("consent_revoked");
    }
    if (this.consent !== "granted") this.refuse("consent_required");
    if (!levelAllows(this.options.level ?? "write", neededLevel(input.op))) this.refuse("permission_denied");
    if (this.failNext) {
      const code = this.failNext;
      this.failNext = undefined;
      this.refuse(code);
    }
    if (input.op === "write" && this.options.failWrite) this.refuse(this.options.failWrite);

    const output = this.execute(input);
    this.operations += 1;
    if (!this.bumped && this.options.generationBumpAfter === this.operations) {
      this.bumped = true;
      this.generation = newGeneration();
      for (const old of this.channels.values()) old.alive = false;
    }
    return this.options.leakField ? { ...output, [this.options.leakField]: "hunter2" } : output;
  }

  private attrsOf(node: FsNode) {
    return {
      type: node.kind === "dir" ? ("dir" as const) : ("file" as const),
      size: String(node.data.length),
      mtime: MTIME,
      mode: node.kind === "dir" ? 0o40755 : 0o100644,
      linkTarget: null,
    };
  }

  private lookup(bytes: Uint8Array): FsNode {
    const found = this.nodes.get(keyOf(bytes));
    if (!found) this.refuse("no_such_file");
    return found.node;
  }

  private requireParent(bytes: Uint8Array): void {
    const parent = parentOf(bytes);
    if (parent && this.lookup(parent).kind !== "dir") this.refuse("no_such_file");
  }

  private execute(input: SftpOpInput): Record<string, unknown> {
    switch (input.op) {
      case "list": {
        const dirBytes = wireBytes(input.path);
        if (this.lookup(dirBytes).kind !== "dir") this.refuse("no_such_file");
        const children = [...this.nodes.values()]
          .filter(({ path }) => {
            const parent = parentOf(path);
            return parent !== null && keyOf(parent) === keyOf(dirBytes) && path.length > 0;
          })
          .sort((a, b) => keyOf(a.path).localeCompare(keyOf(b.path)));
        if (children.length > SFTP_LIMITS.listTotal) this.refuse("limit_exceeded");
        const start = input.cursor ? Number(input.cursor) : 0;
        const size = input.limit ?? SFTP_LIMITS.listPage;
        const page = children.slice(start, start + size);
        const next = start + size < children.length ? String(start + size) : null;
        return {
          op: "list",
          entries: page.map(({ path, node }) => ({ name: wireOf(nameOf(path)), attrs: this.attrsOf(node) })),
          nextCursor: next,
        };
      }
      case "stat": {
        const node = this.lookup(wireBytes(input.path));
        return { op: "stat", attrs: this.attrsOf(node) };
      }
      case "realpath":
        return { op: "realpath", path: input.path };
      case "read": {
        const node = this.lookup(wireBytes(input.path));
        if (node.kind !== "file") this.refuse("failure");
        const offset = Number(input.offset);
        const chunk = node.data.slice(offset, offset + input.length);
        return {
          op: "read",
          data: Buffer.from(chunk).toString("base64"),
          eof: offset + input.length >= node.data.length,
        };
      }
      case "write": {
        const path = wireBytes(input.path);
        const exists = this.nodes.get(keyOf(path));
        if (input.create === "exclusive" && exists) this.refuse("exists");
        if (input.create === "existing" && !exists) this.refuse("no_such_file");
        this.requireParent(path);
        const data = new Uint8Array(Buffer.from(input.data, "base64"));
        const offset = Number(input.offset);
        const previous = input.create === "existing" && exists ? exists.node.data : new Uint8Array();
        const next = new Uint8Array(Math.max(previous.length, offset + data.length));
        next.set(previous, 0);
        next.set(data, offset);
        this.put(path, { kind: "file", data: next });
        return { op: "write", written: data.length };
      }
      case "mkdir": {
        const path = wireBytes(input.path);
        if (this.nodes.has(keyOf(path))) this.refuse("exists");
        this.requireParent(path);
        this.put(path, { kind: "dir", data: new Uint8Array() });
        return { op: "mkdir" };
      }
      case "rename": {
        const from = wireBytes(input.from);
        const to = wireBytes(input.to);
        const node = this.lookup(from);
        const target = this.nodes.get(keyOf(to));
        if (target && !input.overwrite) this.refuse("exists");
        if (target && input.overwrite && this.options.posixRename === false) this.refuse("unsupported");
        this.requireParent(to);
        this.nodes.delete(keyOf(from));
        this.put(to, node);
        return { op: "rename" };
      }
      case "remove": {
        const path = wireBytes(input.path);
        const node = this.lookup(path);
        if (input.kind === "dir" && node.kind === "dir") {
          const hasChild = [...this.nodes.values()].some(({ path: child }) => {
            const parent = parentOf(child);
            return parent !== null && keyOf(parent) === keyOf(path);
          });
          if (hasChild) this.refuse("not_empty");
        }
        this.nodes.delete(keyOf(path));
        return { op: "remove" };
      }
    }
  }
}

