// In-memory Remote Hub SFTP helper, modelled on the schemas in src/core/wire/remote-hub-sftp.ts.
// It validates every request with the mirrored schema (a stray field fails loudly) and answers with
// refusals as the host does: SftpRefusal with a stable code. Test-only; not shipped.
import { randomUUID } from "node:crypto";
import {
  SFTP_LIMITS,
  SftpRefusal,
  type RemoteHubPort,
  type SftpInput,
  type SftpLevel,
  type SftpMethodName,
  type SftpOp,
  type SftpOpInput,
  type SftpOutput,
  type SftpPath,
  type SftpRefusalCode,
  levelAllows,
  neededLevel,
  sftpMethods,
} from "../../../core/wire/remote-hub-sftp.ts";

export type MockConsent = "none" | "pending" | "granted" | "revoked";

export interface RemoteHubMockOptions {
  consent?: MockConsent;
  level?: SftpLevel;
  hostKey?: "trusted" | "unknown" | "changed";
  /** The helper restarts once, after this many applied operations; channels of the old generation die. */
  generationBumpAfter?: number;
  /** false: any rename with overwrite is refused as unsupported (no posix-rename). */
  posixRename?: boolean;
  /** Every write operation fails with this refusal. */
  failWrite?: "unreachable";
  /** The next operation fails with this refusal, then the mock behaves again. */
  failNext?: SftpRefusalCode;
  /** Every operation fails with this refusal. */
  failAll?: SftpRefusalCode;
  /** The detail text the refusal carries (the host's own text, which a client must not show). */
  refusalDetail?: string;
  /** The channel cannot be opened: hub_sftp_open is refused with this code. */
  openFailure?: SftpRefusalCode;
  /**
   * The next operation fails at the transport: "drop" applies it and then loses the reply;
   * "abort" fails before anything is applied, as a cancelled call does.
   */
  faultNext?: "drop" | "abort";
  /** Reads answer with more bytes than asked ("oversize") or an empty chunk without eof ("empty-no-eof"). */
  readFault?: "oversize" | "empty-no-eof";
  /** Every operation is answered with the reply of another operation. */
  misreply?: boolean;
  /** A stat right after a rename is refused with `failure`: the rename landed, the final stat did not. */
  statFailsAfterRename?: boolean;
  /** Extra names listed under the root, as the server would send them (hostile names included). */
  extraNames?: SftpPath[];
  /** Creates /big with this many files. */
  dirSize?: number;
  /** Adds this field to every operation reply, to prove that the client's schema refuses it. */
  leakField?: "password";
  /** Runs inside hub_sftp_open, with the number of opens so far (this one included): the test may abort here. */
  onOpen?: (opened: number) => void;
  /** Every write reply says this many bytes were written, whatever was sent. */
  writtenOverride?: number;
}

export interface MockCall {
  method: SftpMethodName;
  input: unknown;
}

interface FsNode {
  kind: "file" | "dir";
  data: Uint8Array;
  mtime: number;
}

interface Channel {
  alive: boolean;
  generation: string;
}

const MTIME = 1795790479;
const PROFILE = "5b568675-f842-4a96-83e0-78ae53d96024";
const SLASH = 0x2f;

function bytesOf(path: string | Uint8Array): Uint8Array {
  return typeof path === "string" ? new TextEncoder().encode(path) : path;
}

function wireBytes(path: SftpPath): Uint8Array {
  return "text" in path ? new TextEncoder().encode(path.text) : new Uint8Array(Buffer.from(path.bytes, "base64"));
}

function wireOf(bytes: Uint8Array): SftpPath {
  try {
    return { text: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes) };
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
  return bytes.slice(bytes.lastIndexOf(SLASH) + 1);
}

function newGeneration(): string {
  return randomUUID().replace(/-/g, "");
}

export class RemoteHubMock implements RemoteHubPort {
  readonly calls: MockCall[] = [];
  private readonly nodes = new Map<string, { path: Uint8Array; node: FsNode }>();
  private readonly channels = new Map<string, Channel>();
  private consent: MockConsent;
  private readonly hostKey: "trusted" | "unknown" | "changed";
  private generation = newGeneration();
  private applied = 0;
  private bumped = false;
  private failNext: SftpRefusalCode | undefined;
  private fault: "drop" | "abort" | undefined;
  private armed: "drop" | "abort" | undefined;
  private lastApplied: SftpOp | undefined;
  private readonly options: RemoteHubMockOptions;

  constructor(options: RemoteHubMockOptions = {}) {
    this.options = options;
    this.consent = options.consent ?? "granted";
    this.hostKey = options.hostKey ?? "trusted";
    this.failNext = options.failNext;
    this.fault = options.faultNext;
    this.seedDir("/");
    if (options.dirSize !== undefined) {
      this.seedDir("/big");
      for (let index = 0; index < options.dirSize; index++) {
        this.seedFile(`/big/f${String(index).padStart(5, "0")}`, "");
      }
    }
  }

  seedDir(path: string | Uint8Array): void {
    this.put(bytesOf(path), { kind: "dir", data: new Uint8Array(), mtime: MTIME });
  }

  seedFile(path: string | Uint8Array, data: string | Uint8Array): void {
    const content = typeof data === "string" ? new TextEncoder().encode(data) : data;
    this.put(bytesOf(path), { kind: "file", data: content, mtime: MTIME });
  }

  setMtime(path: string | Uint8Array, seconds: number): void {
    const found = this.nodes.get(keyOf(bytesOf(path)));
    if (!found) throw new Error("setMtime: no such path in the mock");
    found.node.mtime = seconds;
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

  /** Arms a transport fault for the next MUTATION; reads before it do not consume it. */
  arm(fault: "drop" | "abort"): void {
    this.armed = fault;
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
    throw new SftpRefusal(code, this.options.refusalDetail);
  }

  private open(profileId: string): { channelId: string; generation: string } {
    this.options.onOpen?.(this.opCount("open"));
    if (profileId !== PROFILE) this.refuse("profile_not_found");
    if (this.consent === "revoked") this.refuse("consent_revoked");
    if (this.consent !== "granted") this.refuse("consent_required");
    if (this.hostKey === "unknown") this.refuse("host_key_unknown");
    if (this.hostKey === "changed") this.refuse("host_key_changed");
    if (this.options.openFailure) this.refuse(this.options.openFailure);
    const channelId = randomUUID();
    this.channels.set(channelId, { alive: true, generation: this.generation });
    return { channelId, generation: this.generation };
  }

  private close(channelId: string): { closed: boolean } {
    const channel = this.channels.get(channelId);
    if (channel) channel.alive = false;
    return { closed: channel !== undefined };
  }

  private operate(input: SftpOpInput): Record<string, unknown> {
    const channel = this.channels.get(input.channelId);
    if (!channel || !channel.alive) this.refuse("channel_closed");
    if (this.consent === "revoked") {
      channel.alive = false;
      this.refuse("consent_revoked");
    }
    if (this.consent !== "granted") this.refuse("consent_required");
    if (!levelAllows(this.options.level ?? "write", neededLevel(input.op))) this.refuse("permission_denied");
    if (this.options.failAll) this.refuse(this.options.failAll);
    if (this.failNext) {
      const code = this.failNext;
      this.failNext = undefined;
      this.refuse(code);
    }
    if (input.op === "write" && this.options.failWrite) this.refuse(this.options.failWrite);
    if (input.op === "stat" && this.options.statFailsAfterRename && this.lastApplied === "rename") this.refuse("failure");

    // faultNext hits the next operation of any kind; arm() hits only the next mutation and skips reads.
    const reads = input.op === "list" || input.op === "stat" || input.op === "realpath" || input.op === "read";
    const fault = reads ? this.fault : (this.armed ?? this.fault);
    this.fault = undefined;
    if (!reads) this.armed = undefined;
    if (fault === "abort") {
      throw new DOMException("The operation was aborted.", "AbortError");
    }

    const output = this.execute(input);
    this.lastApplied = input.op;
    this.applied += 1;
    if (!this.bumped && this.options.generationBumpAfter === this.applied) {
      this.bumped = true;
      this.generation = newGeneration();
      for (const old of this.channels.values()) old.alive = false;
    }
    if (fault === "drop") throw new Error("socket hang up");

    if (this.options.misreply) return { op: input.op === "remove" ? "mkdir" : "remove" };
    if (input.op === "write" && this.options.writtenOverride !== undefined) {
      return { ...output, written: this.options.writtenOverride };
    }
    return this.options.leakField ? { ...output, [this.options.leakField]: "hunter2" } : output;
  }

  private attrsOf(node: FsNode) {
    return {
      type: node.kind === "dir" ? ("dir" as const) : ("file" as const),
      size: String(node.data.length),
      mtime: node.mtime,
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

  private hasChildren(dir: Uint8Array): boolean {
    return [...this.nodes.values()].some(({ path }) => {
      const parent = parentOf(path);
      return parent !== null && keyOf(parent) === keyOf(dir);
    });
  }

  private execute(input: SftpOpInput): Record<string, unknown> {
    switch (input.op) {
      case "list": {
        const dir = wireBytes(input.path);
        if (this.lookup(dir).kind !== "dir") this.refuse("no_such_file");
        const children = [...this.nodes.values()]
          .filter(({ path }) => {
            const parent = parentOf(path);
            return parent !== null && keyOf(parent) === keyOf(dir);
          })
          .sort((a, b) => keyOf(a.path).localeCompare(keyOf(b.path)));
        if (children.length > SFTP_LIMITS.listTotal) this.refuse("limit_exceeded");
        const rows: Array<{ name: SftpPath; attrs: ReturnType<RemoteHubMock["attrsOf"]> }> = children.map(({ path, node }) => ({
          name: wireOf(nameOf(path)),
          attrs: this.attrsOf(node),
        }));
        if (keyOf(dir) === keyOf(new Uint8Array([SLASH]))) {
          for (const name of this.options.extraNames ?? []) {
            rows.push({ name, attrs: { type: "file", size: "0", mtime: MTIME, mode: 0o100644, linkTarget: null } });
          }
        }
        const start = input.cursor ? Number(input.cursor) : 0;
        const size = input.limit ?? SFTP_LIMITS.listPage;
        const next = start + size < rows.length ? String(start + size) : null;
        return { op: "list", entries: rows.slice(start, start + size), nextCursor: next };
      }
      case "stat":
        return { op: "stat", attrs: this.attrsOf(this.lookup(wireBytes(input.path))) };
      case "realpath":
        return { op: "realpath", path: input.path };
      case "read": {
        const node = this.lookup(wireBytes(input.path));
        if (node.kind !== "file") this.refuse("failure");
        if (this.options.readFault === "empty-no-eof") return { op: "read", data: "", eof: false };
        if (this.options.readFault === "oversize") {
          return { op: "read", data: Buffer.alloc(input.length + 1).toString("base64"), eof: true };
        }
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
        this.put(path, { kind: "file", data: next, mtime: MTIME });
        return { op: "write", written: data.length };
      }
      case "mkdir": {
        const path = wireBytes(input.path);
        if (this.nodes.has(keyOf(path))) this.refuse("exists");
        this.requireParent(path);
        this.put(path, { kind: "dir", data: new Uint8Array(), mtime: MTIME });
        return { op: "mkdir" };
      }
      case "rename": {
        const from = wireBytes(input.from);
        const to = wireBytes(input.to);
        const node = this.lookup(from);
        // Real SFTP without posix-rename has no atomic overwrite at all, present target or not.
        if (input.overwrite && this.options.posixRename === false) this.refuse("unsupported");
        const target = this.nodes.get(keyOf(to));
        if (target && !input.overwrite) this.refuse("exists");
        this.requireParent(to);
        this.nodes.delete(keyOf(from));
        this.put(to, node);
        return { op: "rename" };
      }
      case "remove": {
        const path = wireBytes(input.path);
        const node = this.lookup(path);
        if (input.kind === "file" && node.kind === "dir") this.refuse("permission_denied");
        if (input.kind === "dir" && node.kind === "file") this.refuse("permission_denied");
        if (input.kind === "dir" && this.hasChildren(path)) this.refuse("not_empty");
        this.nodes.delete(keyOf(path));
        return { op: "remove" };
      }
    }
  }
}
