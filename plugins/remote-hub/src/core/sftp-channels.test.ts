// The rules of a plugin's SFTP channels: whose a channel is, what the grant allows at each call, what a revoke does, and
// what a plugin is told when ssh could not connect. ssh and the server are a script here.
import { describe, expect, it } from "vitest";
import { PluginGrantBook, type PluginGrantRow } from "./plugin-grants.ts";
import { SftpChannels, type SftpProfileFacts, type SftpStream } from "./sftp-channels.ts";
import { SftpOpError } from "./sftp-client.ts";
import { sftpOpOutputSchema, type SftpOpInput } from "./sftp-contract.ts";
import type { SftpChannelEnd } from "./sftp-protocol.ts";
import { T } from "./sftp-wire.ts";

const u32 = (v: number) => [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];
const str = (b: number[] | string) => {
  const bytes = typeof b === "string" ? Array.from(new TextEncoder().encode(b)) : b;
  return [...u32(bytes.length), ...bytes];
};
const packet = (body: number[]) => Uint8Array.from([...u32(body.length), ...body]);
const VERSION = packet([T.VERSION, ...u32(3)]);

const SSH = "11111111-1111-4111-8111-111111111111";
const AGENT = "22222222-2222-4222-8222-222222222222";
const RDP = "33333333-3333-4333-8333-333333333333";
const NOPASS = "44444444-4444-4444-8444-444444444444";
const COMMANDER = "makosh-commander";

type Sink = { data(bytes: Uint8Array): void; closed(end: SftpChannelEnd): void };
interface Wire {
  sink: Sink;
  sent: Uint8Array[];
  closed: boolean;
}

/** What "ssh" does when a channel is opened: answer the version, end with an error, or refuse to start. */
type Behaviour = { kind: "sftp" } | { kind: "ends"; end: SftpChannelEnd } | { kind: "refuses"; code: string } | { kind: "silent" };

function setup(behaviour: Behaviour = { kind: "sftp" }, agentPresent = true) {
  const rows = new Map<string, PluginGrantRow>();
  const events: string[] = [];
  const wires: Wire[] = [];
  let n = 0;
  const profiles: Record<string, SftpProfileFacts> = {
    [SSH]: { protocol: "ssh", host: "box.test", agent: false, needsSecret: false },
    [AGENT]: { protocol: "ssh", host: "agent.test", agent: true, needsSecret: false },
    [RDP]: { protocol: "rdp", host: "desk.test", agent: false, needsSecret: false },
    [NOPASS]: { protocol: "ssh", host: "nopass.test", agent: false, needsSecret: true },
  };
  const state = { behaviour };
  const agentAsked: string[] = [];
  let channels!: SftpChannels;
  const grants = new PluginGrantBook({
    store: {
      all: () => [...rows.values()],
      get: (p, f) => rows.get(p + "|" + f) ?? null,
      put: (row) => void rows.set(row.pluginId + "|" + row.profileId, row),
      remove: (p, f) => rows.delete(p + "|" + f),
    },
    now: () => new Date("2026-11-27T10:00:00Z"),
    newId: () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`,
    profileExists: (id) => id in profiles,
    onChange: (c) => {
      if (c.state === "revoked" || c.state === "none") channels.revoked(c.pluginId, c.profileId);
    },
  });
  channels = new SftpChannels({
    grants,
    profile: (id) => profiles[id] ?? null,
    agentPresent: (host) => (agentAsked.push(host), agentPresent),
    newId: () => `00000000-0000-4000-9000-${String(++n).padStart(12, "0")}`,
    now: () => new Date("2026-11-27T10:00:00Z"),
    startTimeoutMs: 200,
    onEvent: (e) => void events.push(`${e.pluginId} ${e.state}`),
    transport: {
      async open(_profileId, sink): Promise<SftpStream> {
        const b = state.behaviour;
        if (b.kind === "refuses") throw Object.assign(new Error("refused"), { code: b.code });
        const wire: Wire = { sink, sent: [], closed: false };
        wires.push(wire);
        if (b.kind === "ends") queueMicrotask(() => sink.closed(b.end));
        return {
          generation: "ab".repeat(16),
          write: (bytes) => {
            if (wire.closed) return false;
            wire.sent.push(bytes);
            if (b.kind === "sftp" && bytes[4] === T.INIT) queueMicrotask(() => sink.data(VERSION));
            return true;
          },
          close: () => void (wire.closed = true),
        };
      },
    },
  });
  return { channels, grants, events, wires, state, agentAsked };
}

const code = async (work: Promise<unknown>): Promise<string> => {
  try {
    await work;
    return "ok";
  } catch (e) {
    return e instanceof SftpOpError ? e.code : "threw " + String(e);
  }
};
const tick = () => new Promise((r) => setTimeout(r, 0));
const realpath = (channelId: string): SftpOpInput => ({ channelId, op: "realpath", path: { text: "." } });
const mkdir = (channelId: string): SftpOpInput => ({ channelId, op: "mkdir", path: { text: "/tmp/new" } });
const idOf = (wire: Wire, i: number) => new DataView(wire.sent[i]!.buffer, wire.sent[i]!.byteOffset).getUint32(5);

describe("SftpChannels", () => {
  it("opens nothing without the owner's grant, for a missing connection, or for one that is not SSH", async () => {
    const { channels, grants, wires } = setup();
    expect(await code(channels.open(COMMANDER, SSH))).toBe("consent_required");
    expect(await code(channels.open(COMMANDER, "99999999-9999-4999-8999-999999999999"))).toBe("profile_not_found");
    expect(await code(channels.open(COMMANDER, RDP))).toBe("profile_not_sftp");
    grants.request(COMMANDER, SSH, "read");
    expect(await code(channels.open(COMMANDER, SSH))).toBe("consent_required");
    grants.grant(COMMANDER, NOPASS, "read");
    expect(await code(channels.open(COMMANDER, NOPASS))).toBe("credential_missing");
    expect(wires.length).toBe(0);
  });

  it("answers an operation with the contract's shape and never lets another plugin use or close the channel", async () => {
    const { channels, grants, wires } = setup();
    grants.grant(COMMANDER, SSH, "read");
    const { channelId, generation } = await channels.open(COMMANDER, SSH);
    expect(generation).toBe("ab".repeat(16));
    const answer = channels.op(COMMANDER, realpath(channelId));
    await tick();
    const wire = wires[0]!;
    wire.sink.data(packet([T.NAME, ...u32(idOf(wire, 1)), ...u32(1), ...str("/home/u"), ...str("l"), ...u32(0)]));
    const out = await answer;
    expect(out).toEqual({ op: "realpath", path: { text: "/home/u" } });
    expect(sftpOpOutputSchema.safeParse(out).success).toBe(true);

    grants.grant("other-plugin", SSH, "write");
    expect(await code(channels.op("other-plugin", realpath(channelId)))).toBe("channel_closed");
    expect(channels.close("other-plugin", channelId)).toBe(false);
    expect(wire.closed).toBe(false);
    expect(channels.close(COMMANDER, channelId)).toBe(true);
    expect(wire.closed).toBe(true);
    expect(await code(channels.op(COMMANDER, realpath(channelId)))).toBe("channel_closed");
  });

  it("refuses a changing operation on a read grant and sends nothing", async () => {
    const { channels, grants, wires } = setup();
    grants.grant(COMMANDER, SSH, "read");
    const { channelId } = await channels.open(COMMANDER, SSH);
    expect(await code(channels.op(COMMANDER, mkdir(channelId)))).toBe("consent_required");
    expect(wires[0]!.sent.length).toBe(1); // only the version exchange
    expect(await code(channels.op(COMMANDER, { channelId, op: "realpath", path: { bytes: "LwA=" } }))).toBe("invalid_path");
  });

  it("a revoke ends the plugin's channels to that connection at once and the next call says consent_revoked", async () => {
    const { channels, grants, wires, events } = setup();
    grants.grant(COMMANDER, SSH, "write");
    grants.grant(COMMANDER, AGENT, "write");
    grants.grant("other-plugin", SSH, "write");
    const a = await channels.open(COMMANDER, SSH);
    const b = await channels.open(COMMANDER, AGENT);
    const c = await channels.open("other-plugin", SSH);
    const reading = channels.op(COMMANDER, realpath(a.channelId));
    const changing = channels.op(COMMANDER, mkdir(a.channelId));
    await tick();
    expect(grants.revoke(COMMANDER, SSH)).toBe(true);
    expect(wires.map((w) => w.closed)).toEqual([true, false, false]);
    expect(events).toContain(`${COMMANDER} revoked`);
    // in flight: the read was not answered and the owner revoked; the change was sent and its fate is not known
    expect(await code(reading)).toBe("consent_revoked");
    expect(await code(changing)).toBe("outcome_unknown");
    expect(await code(channels.op(COMMANDER, realpath(a.channelId)))).toBe("consent_revoked");
    expect(await code(channels.open(COMMANDER, SSH))).toBe("consent_revoked");
    expect(channels.list().map((x) => x.channelId).sort()).toEqual([b.channelId, c.channelId].sort());
  });

  it("asks about the agent of the host of the connection that was refused, and only then", async () => {
    const denied: Behaviour = { kind: "ends", end: { reason: "exited", exitCode: 255, refused: null, stderr: "u@h: Permission denied (publickey).\n" } };
    const { channels, grants, agentAsked } = setup(denied, true);
    grants.grant(COMMANDER, AGENT, "read");
    await code(channels.open(COMMANDER, AGENT));
    expect(agentAsked).toEqual(["agent.test"]);
    const ok = setup({ kind: "sftp" }, true);
    ok.grants.grant(COMMANDER, AGENT, "read");
    await code(ok.channels.open(COMMANDER, AGENT));
    expect(ok.agentAsked).toEqual([]);
  });

  it("holds at most four channels per plugin, counting the ones still connecting", async () => {
    const { channels, grants } = setup();
    grants.grant(COMMANDER, SSH, "read");
    grants.grant("other-plugin", SSH, "read");
    const results = await Promise.all([1, 2, 3, 4, 5].map(() => code(channels.open(COMMANDER, SSH))));
    expect(results.filter((r) => r === "ok").length).toBe(4);
    expect(results.filter((r) => r === "limit_exceeded").length).toBe(1);
    expect(await code(channels.open("other-plugin", SSH))).toBe("ok");
    const first = channels.list().find((c) => c.pluginId === COMMANDER)!;
    channels.close(COMMANDER, first.channelId);
    expect(await code(channels.open(COMMANDER, SSH))).toBe("ok");
  });

  it("tells a plugin why ssh could not connect by code only, for a saved secret and for an agent", async () => {
    const end = (stderr: string, refused: string | null = null): Behaviour => ({ kind: "ends", end: { reason: "exited", exitCode: 255, refused, stderr } });
    const cases: Array<[Behaviour, string, boolean, string]> = [
      [{ kind: "refuses", code: "host_key_unknown" }, SSH, true, "host_key_unknown"],
      [{ kind: "refuses", code: "keychain_locked" }, SSH, true, "keychain_locked"],
      [end("WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!\nOffending key in /Users/someone/.ssh/known_hosts:3\n"), SSH, true, "host_key_changed"],
      [end("Host key verification failed.\n"), AGENT, true, "host_key_unknown"],
      [end("WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!\n"), AGENT, true, "host_key_changed"],
      [end("u@h: Permission denied (publickey).\n"), AGENT, false, "agent_unavailable"],
      [end("u@h: Permission denied (publickey).\n"), AGENT, true, "auth_failed"],
      [end("", "credential_rejected"), SSH, true, "auth_failed"],
      [end("ssh: connect to host h port 22: Connection refused\n"), SSH, true, "unreachable"],
      [{ kind: "silent" }, SSH, true, "unreachable"],
    ];
    for (const [behaviour, profileId, agentPresent, expected] of cases) {
      const { channels, grants, wires } = setup(behaviour, agentPresent);
      grants.grant(COMMANDER, profileId, "read");
      let thrown: unknown = null;
      try {
        await channels.open(COMMANDER, profileId);
      } catch (e) {
        thrown = e;
      }
      expect((thrown as SftpOpError).code, JSON.stringify(behaviour)).toBe(expected);
      // The message is the code: ssh's own words (a path, a user) are not in it.
      expect((thrown as Error).message).toBe(expected);
      expect(channels.list()).toEqual([]);
      for (const wire of wires) expect(wire.closed).toBe(true);
    }
  });

  it("a channel whose ssh ends is forgotten, and a call after it is channel_closed while the grant stands", async () => {
    const { channels, grants, wires, events } = setup();
    grants.grant(COMMANDER, SSH, "write");
    const { channelId } = await channels.open(COMMANDER, SSH);
    wires[0]!.sink.closed({ reason: "exited", exitCode: 255, refused: null, stderr: "Connection reset by peer" });
    expect(channels.list()).toEqual([]);
    expect(events).toEqual([`${COMMANDER} open`, `${COMMANDER} closed`]);
    expect(await code(channels.op(COMMANDER, mkdir(channelId)))).toBe("channel_closed");
  });
});
