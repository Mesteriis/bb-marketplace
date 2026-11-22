import { canAttachLive, type LiveKind } from "../../core/live-session-kind.ts";
import type { SessionHandle, SessionInfo } from "../../core/rpc.ts";
import { matchesTarget, providers, query, readHost, reply, type Address, type Provider, type Status } from "./embed-wire.ts";
import type { RdpCanvasHandle } from "../../ui/rdp-canvas.tsx";
import { viewExposed } from "../../ui/watch-beat.ts";

export interface RemoteEmbedApi {
  list(): Promise<SessionInfo[]>;
  resourceRef(handle: SessionHandle, liveKind: LiveKind): Promise<string | null>;
  attach(handle: SessionHandle, liveKind: LiveKind): Promise<{ wsUrl: string; token: string }>;
  close(handle: SessionHandle): Promise<unknown>;
  takeover(handle: SessionHandle): Promise<unknown>;
}
export interface Tile extends Address {
  target: HTMLDivElement;
  visible: boolean;
  status?: Status;
  options?: SessionInfo[];
  selected?: string;
  pending?: Resource;
  accepted?: string;
  busy?: boolean;
  confirm?: boolean;
  surface?: Surface;
}
export interface Surface {
  kind: "ssh" | "rdp" | "vnc";
  handle: SessionHandle;
  provider: Provider;
  rdpHandle: { current: RdpCanvasHandle | null };
  socket: { token: string; wsUrl: string };
  tile: Tile;
  ready: boolean;
}
type Resource = { provider: Provider; handle: SessionHandle };
export class DocumentRefs {
  generations = new Map<string, number>();
  resources = new Map<string, Resource>();
}
function same(a: SessionHandle, b: SessionHandle) {
  return a.generation === b.generation && a.sessionId === b.sessionId;
}
function kind(p: Provider) {
  return p === "remote-ssh-live" ? "ssh" : p === "remote-rdp-live" ? "rdp" : "vnc";
}
function failure(error: unknown): "lost" | "denied" {
  return error && typeof error === "object" && "code" in error && error.code === "forbidden" ? "denied" : "lost";
}

export class RemoteEmbedOwner {
  tiles = new Map<string, Tile>();
  constructor(
    readonly api: RemoteEmbedApi,
    private refs: DocumentRefs,
    readonly redraw: () => void,
  ) {}
  private current(t: Tile) {
    return this.tiles.get(t.instanceId) === t && matchesTarget(t.target, t);
  }
  private active(t: Tile) {
    return this.current(t) && t.visible && viewExposed(t.target);
  }
  private status(t: Tile, status: Status) {
    if (!this.current(t)) return;
    t.status = status;
    this.redraw();
    reply(t.target, t, { kind: status });
  }
  start() {
    document.addEventListener("chertog.embed.v1.host", this.host);
    for (const provider of providers) query(provider);
    return () => {
      document.removeEventListener("chertog.embed.v1.host", this.host);
      for (const t of this.tiles.values()) this.status(t, "revoked");
      this.tiles.clear();
    };
  }
  private release(t: Tile) {
    t.surface?.rdpHandle.current?.releaseInput();
    t.surface = undefined;
    this.tiles.delete(t.instanceId);
    this.redraw();
  }
  private host = (event: Event) => {
    const incoming = readHost(event);
    if (!incoming) return;
    const { message: m, target } = incoming;
    let t = this.tiles.get(m.instanceId);
    const last = this.refs.generations.get(m.instanceId) ?? 0;
    if (m.generation < last || (m.generation === last && (!t || t.target !== target || t.provider !== m.provider))) return;
    if (m.kind === "release") {
      this.refs.generations.set(m.instanceId, m.generation);
      if (t) this.release(t);
      return;
    }
    if (m.kind === "announce") {
      if (m.generation > last) {
        if (t) this.release(t);
        this.refs.generations.set(m.instanceId, m.generation);
        t = { provider: m.provider, instanceId: m.instanceId, generation: m.generation, visible: true, target };
        this.tiles.set(t.instanceId, t);
        if ("mode" in m) {
          this.status(t, "choosing");
          void this.list(t);
        } else void this.attach(t, m.resourceRef);
      } else if (t) {
        if ("resourceRef" in m && t.selected === m.resourceRef && !t.accepted && t.status === "choosing")
          void this.attach(t, m.resourceRef);
        else if (("mode" in m ? !t.accepted : t.accepted === m.resourceRef) && t.status) {
          if (t.selected && !t.accepted && t.status === "choosing") reply(target, t, { kind: "selected", resourceRef: t.selected });
          else reply(target, t, { kind: t.status });
        }
      }
      return;
    }
    if (!t || m.generation !== t.generation) return;
    if (m.kind === "visibility") {
      if (t.visible && !m.visible) t.surface?.rdpHandle.current?.releaseInput();
      t.visible = m.visible;
    }
    if (m.kind === "close") {
      if (t.provider === "remote-vnc-live" && t.status === "lost") return this.status(t, "lost");
      if (t.surface && t.provider === "remote-vnc-live") t.confirm = true;
      else {
        t.busy = false;
        this.status(t, "ended");
      }
    }
    this.redraw();
  };
  private async list(t: Tile) {
    try {
      const rows = await this.api.list();
      if (!this.current(t) || t.status !== "choosing") return;
      t.options = rows.filter((s) => canAttachLive(s, kind(t.provider)));
      this.redraw();
    } catch (error) {
      if (t.status === "choosing") this.status(t, failure(error));
    }
  }
  async select(t: Tile, handle: SessionHandle) {
    if (!this.active(t) || t.status !== "choosing" || t.busy || t.selected) return;
    t.busy = true;
    try {
      const rows = await this.api.list();
      if (!this.active(t) || t.status !== "choosing") return;
      const s = rows.find((s) => same(s, handle) && canAttachLive(s, kind(t.provider)));
      if (!s) return this.status(t, "lost");
      const selectedHandle = { generation: s.generation, sessionId: s.sessionId };
      const ref = await this.api.resourceRef(selectedHandle, kind(t.provider));
      if (!this.active(t) || t.status !== "choosing") return;
      if (ref === null) return this.status(t, "denied");
      t.pending = { provider: t.provider, handle: selectedHandle };
      t.selected = ref;
      reply(t.target, t, { kind: "selected", resourceRef: ref });
    } catch (error) {
      if (t.status === "choosing") this.status(t, failure(error));
    } finally {
      t.busy = false;
      this.redraw();
    }
  }
  cancel(t: Tile) {
    if (this.active(t) && t.status === "choosing" && !t.accepted) this.status(t, "cancelled");
  }
  private async attach(t: Tile, ref: string) {
    t.accepted = ref;
    t.status = undefined;
    if (t.selected === ref && t.pending) this.refs.resources.set(ref, t.pending);
    const resource = this.refs.resources.get(ref);
    if (!resource || resource.provider !== t.provider) return this.status(t, "lost");
    const { handle } = resource;
    try {
      const rows = await this.api.list();
      if (!this.current(t) || t.status) return;
      const s = rows.find((row) => same(row, handle));
      if (!s || s.reason === "helper_exited") return this.status(t, "lost");
      if (s.state === "closed") return this.status(t, "ended");
      if (!canAttachLive(s, kind(t.provider))) return this.status(t, "denied");
      if (s.kind === "vnc" && [...this.tiles.values()].some(tile => tile.surface && same(tile.surface.handle, handle)))
        return this.status(t, "denied");
      const socket = await this.api.attach(handle, kind(t.provider));
      if (!this.current(t) || t.status) return;
      const surface: Surface = {
        rdpHandle: { current: null },
        kind: kind(t.provider),
        handle,
        provider: t.provider,
        socket,
        tile: t,
        ready: false,
      };
      t.surface = surface;
      this.redraw();
    } catch (error) {
      if (t.status === undefined) this.status(t, failure(error));
    }
  }
  report(v: Surface, state: "ready" | "ended" | "lost" | "denied") {
    if (v.tile.surface !== v || !this.current(v.tile)) return;
    if (state === "ready") {
      if (v.ready) return;
      v.ready = true;
    } else {
      v.tile.surface = undefined;
      v.tile.confirm = false;
    }
    if (v.tile.status !== "ended") this.status(v.tile, state);
    this.redraw();
  }
  canInput(v: Surface) {
    return v.ready && v.tile.status === "ready" && !v.tile.confirm && this.active(v.tile);
  }
  async takeover(v: Surface) {
    if (!this.canInput(v)) throw new Error("Просмотр недоступен");
    await this.api.takeover(v.handle);
  }
  async decide(t: Tile, decision: "keep" | "hide" | "end") {
    if (!t.confirm || !t.surface || t.busy || !this.active(t)) return;
    if (decision !== "end") {
      t.confirm = false;
      reply(t.target, t, { kind: decision });
    } else {
      if (!t.surface.ready) return;
      t.busy = true;
      const v = t.surface;
      try {
        await this.api.close(v.handle);
        this.report(v, "ended");
      } catch {
        if (this.current(t) && t.surface === v) this.status(t, "lost");
      } finally {
        t.busy = false;
      }
    }
    this.redraw();
  }
}
