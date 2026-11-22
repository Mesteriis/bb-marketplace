import type { ZoomMeeting } from "../../core/model";
import type { PreparedCall } from "../../core/call";
import type { WindowCalls } from "../../ui/window-calls";
import { visible } from "./window-call-layer";
import { matchesTarget, query, readHost, reply, type Address, type Status } from "./embed-wire";

export interface EmbedApi {
  list(): Promise<ZoomMeeting[]>;
  select(id: string): Promise<string>;
  resolve(resourceRef: string): Promise<{ id: string; topic: string }>;
  prepare(resourceRef: string): Promise<PreparedCall>;
}
export interface View extends Address {
  target: HTMLDivElement;
  status?: Status;
  visible: boolean;
  ref?: string;
  pending?: string;
  options?: ZoomMeeting[];
  meeting?: { id: string; topic: string };
  busy?: boolean;
  prompt?: boolean;
  awaitingEnd?: boolean;
  hadCall?: boolean;
}
export class EmbedOwner {
  private views = new Map<string, View>();
  constructor(
    readonly api: EmbedApi,
    readonly calls: WindowCalls,
    readonly url: string | null,
    readonly openExternal: (url: string) => void,
    readonly redraw: () => void,
    private generations: Map<string, number>,
  ) {}
  all() {
    return [...this.views.values()];
  }
  private current(v: View) {
    return this.views.get(v.instanceId) === v && matchesTarget(v.target, v);
  }
  private interactive(v: View) {
    return this.current(v) && v.visible && visible(v.target);
  }
  private status(v: View, status: Status) {
    if (!this.current(v)) return;
    v.status = status;
    this.redraw();
    reply(v.target, v, { kind: status });
  }
  private failure(v: View, error: unknown) {
    if (v.status === "ended" || v.status === "cancelled") return;
    const code = error && typeof error === "object" && "code" in error ? error.code : null;
    this.status(v, code === "forbidden" || code === "not_found" ? "denied" : "lost");
  }
  private callsChanged = (lostDocument?: string) => {
    for (const v of this.views.values()) {
      const call = v.meeting && this.calls.snapshot().get(v.meeting.id);
      if (call) {
        v.hadCall = true;
        if (call.lost && v.status !== "lost" && v.status !== "ended") {
          v.awaitingEnd = false;
          this.status(v, "lost");
        }
      } else if (v.hadCall) {
        v.hadCall = false;
        v.awaitingEnd = false;
        v.prompt = false;
        if (v.status !== "ended") this.status(v, lostDocument === v.meeting?.id ? "lost" : "ended");
      }
    }
    this.redraw();
  };
  start() {
    document.addEventListener("chertog.embed.v1.host", this.host);
    const unsubscribe = this.calls.subscribe(this.callsChanged);
    query();
    return () => {
      document.removeEventListener("chertog.embed.v1.host", this.host);
      unsubscribe();
      for (const v of this.views.values()) this.status(v, "revoked");
      this.views.clear();
      this.calls.reset();
    };
  }
  private host = (event: Event) => {
    const parsed = readHost(event);
    if (!parsed) return;
    const { message: m, target } = parsed;
    let v = this.views.get(m.instanceId);
    if (v && (m.generation < v.generation || (m.generation === v.generation && target !== v.target))) return;
    if (m.kind === "announce") {
      if (!v || m.generation !== v.generation) {
        if (m.generation <= (this.generations.get(m.instanceId) ?? 0)) return;
        this.generations.set(m.instanceId, m.generation);
        v = { instanceId: m.instanceId, generation: m.generation, target, visible: true };
        this.views.set(v.instanceId, v);
        if ("mode" in m) {
          this.status(v, "choosing");
          void this.load(v);
        } else void this.attach(v, m.resourceRef);
      } else if ("resourceRef" in m && !v.ref && v.pending === m.resourceRef && v.status === "choosing") {
        void this.attach(v, m.resourceRef);
      } else if (("mode" in m ? !v.ref : v.ref === m.resourceRef) && v.status) {
        reply(target, v, { kind: v.status });
      }
      return;
    }
    if (m.kind === "release") {
      this.generations.set(m.instanceId, Math.max(m.generation, this.generations.get(m.instanceId) ?? 0));
      if (v && m.generation >= v.generation) this.views.delete(v.instanceId);
      this.redraw();
      return;
    }
    if (!v || v.generation !== m.generation) return;
    if (m.kind === "visibility") v.visible = m.visible;
    if (m.kind === "close") this.close(v);
    this.redraw();
  };
  private async load(v: View) {
    if (!this.current(v)) return;
    try {
      const list = await this.api.list();
      if (this.current(v) && v.status === "choosing") {
        v.options = list;
        this.redraw();
      }
    } catch (error) {
      this.failure(v, error);
    }
  }
  async select(v: View, id: string) {
    if (!this.interactive(v) || v.busy || v.pending || v.status !== "choosing") return;
    v.busy = true;
    try {
      const ref = await this.api.select(id);
      if (!this.interactive(v) || v.status !== "choosing") return;
      v.pending = ref;
      reply(v.target, v, { kind: "selected", resourceRef: ref });
    } catch (error) {
      this.failure(v, error);
    } finally {
      v.busy = false;
      this.redraw();
    }
  }
  cancel(v: View) {
    if (this.interactive(v) && v.status === "choosing") this.status(v, "cancelled");
  }
  private async attach(v: View, ref: string) {
    v.ref = ref;
    v.status = undefined;
    this.redraw();
    try {
      const meeting = await this.api.resolve(ref);
      if (!this.current(v) || v.status === "ended") return;
      v.meeting = meeting;
      v.hadCall = this.calls.snapshot().has(meeting.id);
      this.status(v, this.calls.snapshot().get(meeting.id)?.lost ? "lost" : "ready");
    } catch (error) {
      this.failure(v, error);
    }
  }
  async join(v: View) {
    if (!this.interactive(v) || v.status !== "ready" || !v.meeting || !v.ref || !this.url || v.busy || v.prompt) return;
    if (this.calls.snapshot().has(v.meeting.id)) return;
    v.busy = true;
    this.redraw();
    try {
      const call = await this.api.prepare(v.ref);
      if (!this.interactive(v) || v.status !== "ready" || v.prompt || v.awaitingEnd || call.meetingNumber !== v.meeting.id)
        return;
      this.calls.show({ call, title: v.meeting.topic, callPageUrl: this.url, openExternal: this.openExternal });
    } catch (error) {
      this.failure(v, error);
    } finally {
      v.busy = false;
      this.redraw();
    }
  }
  close(v: View) {
    if (!this.current(v) || v.awaitingEnd) return;
    if (v.status === "ended") {
      this.status(v, "ended");
      return;
    }
    const id = v.meeting?.id;
    const other =
      id &&
      (this.all().some((o) => o !== v && this.current(o) && o.meeting?.id === id && o.status !== "ended") ||
        (this.calls.calendarMeeting === id &&
          [...this.calls.anchors].some(([a, m]) => m === id && a.isConnected && !a.closest("[data-chertog-embed-target]"))));
    if (!id || !this.calls.snapshot().has(id) || other) this.status(v, "ended");
    else {
      v.prompt = true;
      this.redraw();
    }
  }
  decide(v: View, kind: "keep" | "hide" | "leave") {
    if (!this.interactive(v) || !v.prompt || !v.meeting) return;
    v.prompt = undefined;
    if (kind === "leave") {
      v.awaitingEnd = true;
      this.calls.update(v.meeting.id, { leaving: true });
    } else reply(v.target, v, { kind });
    this.redraw();
  }
}
