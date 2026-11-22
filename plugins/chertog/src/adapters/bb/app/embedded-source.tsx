import { useLayoutEffect, useRef } from "react";
import { host, paramsSchema, parseOwner, providers, query, version, type EmbedType, type HostAction } from "../../../core/embed/wire.ts";
import type { PanelOpenOutcome, PanelRegistry } from "../../../core/panels/index.ts";
import type { ContentSource } from "./content-sources.ts";

const titles: Record<EmbedType, string> = {
  "telegram-chat": "Telegram", "zoom-call": "Zoom", "remote-ssh-live": "SSH",
  "remote-rdp-live": "RDP", "remote-vnc-live": "VNC",
};
const timeout = 10000;
const unsupportedVersion = "Версия протокола владельца не поддерживается.";
type Decision = "ended" | "hide" | "keep";
type Attempt = {
  generation: number;
  incompatible?: boolean;
  phase: "choose" | "opening" | "live" | "stopped";
  uuid?: string;
  selected?: (uuid: string) => void;
  cancel?: (reason?: string) => void;
  opened?: (value: PanelOpenOutcome) => void;
  closing?: (value: Decision) => void;
  timer?: ReturnType<typeof setTimeout>;
};

function Target({ id, type, bind }: { id: string; type: EmbedType; bind(node: HTMLDivElement, id: string): () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => bind(ref.current!, id), [bind, id]);
  return <>
    <div ref={ref} className="peer h-full min-h-0 overflow-auto" data-chertog-embed-target="v1" data-instance-id={id} data-provider={type} />
    <span role="status" className="pointer-events-none absolute inset-0 hidden place-items-center text-muted-foreground peer-empty:grid">Ожидаем ответ владельца…</span>
  </>;
}

function embeddedSource(type: EmbedType): ContentSource {
  const attempts = new Map<string, Attempt>();
  const nodes = new Map<string, HTMLDivElement>();
  let registry: Pick<PanelRegistry, "report"> | undefined;

  function valid(node: HTMLDivElement, id: string, attempt: Attempt) {
    const host = node.closest("[data-live-host]");
    const layers = document.querySelectorAll('[data-chertog-embed-layer="v1"]');
    return (/^[a-zA-Z0-9_-]{1,128}$/).test(id) && node.isConnected && node.ownerDocument === document && nodes.get(id) === node &&
      layers.length === 1 && host?.parentElement === layers[0] && host?.getAttribute("data-live-host") === id &&
      layers[0]!.querySelectorAll('[data-live-host="' + id + '"]').length === 1 &&
      host.querySelectorAll('[data-chertog-embed-target="v1"]').length === 1 &&
      node.dataset.instanceId === id && node.dataset.provider === type && node.dataset.chertogEmbedTarget === "v1" &&
      node.dataset.generation === String(attempt.generation);
  }

  function send(id: string, attempt: Attempt, detail: HostAction) {
    const node = nodes.get(id);
    if (!node || !valid(node, id, attempt)) return;
    const message = host.safeParse({ version, provider: type, instanceId: id, generation: attempt.generation, ...detail });
    if (message.success) node.dispatchEvent(new CustomEvent(version + ".host", { bubbles: true, detail: message.data }));
  }
  function visibility(id: string, a: Attempt) {
    if (attempts.get(id) !== a || a.phase === "stopped") return;
    send(id, a, { kind: "visibility", visible: !nodes.get(id)?.closest('[inert],[hidden],[aria-hidden="true"]') });
  }
  function announce(id: string, a: Attempt) {
    if (a.phase === "stopped") return;
    send(id, a, a.uuid ? { kind: "announce", resourceRef: a.uuid } : { kind: "announce", mode: "choose" });
    visibility(id, a);
  }
  function stop(id: string, a: Attempt, status: "unknown" | "session-ended" | "access-denied", cancelled = false) {
    if (a.phase === "stopped") return;
    const choosing = a.phase === "choose";
    a.phase = "stopped";
    clearTimeout(a.timer);
    if (!a.closing) send(id, a, { kind: "release" });
    a.opened?.({ status });
    a.closing?.("keep");
    if (choosing) {
      const reason = a.incompatible ? unsupportedVersion : status === "access-denied"
        ? "Владелец отказал в доступе." : "Владелец панели не подтвердил доступность.";
      a.cancel?.(cancelled ? undefined : reason);
    }
    else queueMicrotask(() => {
      // A ready promise can still be settling when the owner's cleanup runs.
      if (attempts.get(id) === a) registry?.report(id, status);
    });
  }
  function watchdog(id: string, a: Attempt) {
    clearTimeout(a.timer);
    a.timer = setTimeout(() => stop(id, a, "unknown"), timeout);
  }
  function release(id: string) {
    const a = attempts.get(id);
    if (!a) return;
    attempts.delete(id);
    clearTimeout(a.timer);
    if (a.phase !== "stopped") send(id, a, { kind: "release" });
    a.phase = "stopped";
    a.opened?.({ status: "unknown" });
    a.closing?.("keep");
  }
  function start(id: string, a: Attempt) {
    attempts.set(id, a);
    const node = nodes.get(id);
    if (node) node.dataset.generation = String(a.generation);
    watchdog(id, a);
    announce(id, a);
  }

  function bind(node: HTMLDivElement, id: string) {
    nodes.set(id, node);
    const receive = (event: Event) => {
      if (!(event instanceof CustomEvent) || event.target !== node) return;
      const a = attempts.get(id);
      if (!a || a.phase === "stopped" || !valid(node, id, a)) return;
      const parsed = parseOwner(event.detail);
      if (!parsed.ok) {
        const raw = event.detail;
        if (parsed.reason === "unsupported-version" && raw.provider === type && raw.instanceId === id && raw.generation === a.generation)
          a.incompatible = true;
        return;
      }
      const m = parsed.message;
      if (m.provider !== type || m.instanceId !== id || m.generation !== a.generation) return;
      a.incompatible = false;
      if (m.kind === "choosing" && a.phase === "choose") clearTimeout(a.timer);
      if (m.kind === "selected" && a.phase === "choose") a.selected?.(m.resourceRef);
      if (m.kind === "ready" && (a.phase === "opening" || a.phase === "live")) {
        a.phase = "live";
        clearTimeout(a.timer);
        a.opened?.({ status: "live", addressee: null });
      }
      if (a.closing && (m.kind === "hide" || m.kind === "keep" || m.kind === "ended")) {
        a.closing(m.kind);
        delete a.closing;
        if (m.kind === "ended") {
          // The owner confirmed closure of this view. A sibling of the same
          // resource can still be live (e.g. a second Telegram draft).
          a.phase = "stopped";
          clearTimeout(a.timer);
          send(id, a, { kind: "release" });
        }
        return;
      }
      if (m.kind === "revoked" || m.kind === "lost" || (a.phase === "choose" && m.kind === "cancelled")) stop(id, a, "unknown", m.kind === "cancelled");
      if (m.kind === "denied") stop(id, a, "access-denied");
      if (m.kind === "ended") stop(id, a, "session-ended");
    };
    const replay = (event: Event) => {
      if (!(event instanceof CustomEvent) || event.target !== document || query.safeParse(event.detail).data?.provider !== type) return;
      const a = attempts.get(id);
      if (a) announce(id, a);
    };
    document.addEventListener(version + ".owner", receive);
    document.addEventListener(version + ".query", replay);
    const observer = new MutationObserver(() => {
      const a = attempts.get(id);
      if (a && a.phase !== "stopped") visibility(id, a);
    });
    for (let el: Element | null = node; el; el = el.parentElement)
      observer.observe(el, { attributes: true, attributeFilter: ["hidden", "inert", "aria-hidden"] });
    const a = attempts.get(id);
    if (a) { node.dataset.generation = String(a.generation); announce(id, a); }
    const pulse = setInterval(() => {
      const active = attempts.get(id);
      if (!active || (active.phase !== "live" && active.phase !== "choose")) return;
      watchdog(id, active);
      announce(id, active);
    }, 30000);
    return () => {
      clearInterval(pulse);
      observer.disconnect();
      document.removeEventListener(version + ".owner", receive);
      document.removeEventListener(version + ".query", replay);
      const active = attempts.get(id);
      if (active) stop(id, active, "unknown");
      nodes.delete(id);
    };
  }

  const title = titles[type];
  return {
    provider: {
      type, paramsSchema, multipleViews: type !== "zoom-call" && type !== "remote-vnc-live",
      capabilities: { showNativeRoute: "no", embedInstance: "yes", keepLiveInDocument: "yes",
        rebindToSession: "unverified", transferBetweenWindows: "no", restoreAfterRestart: "partial" },
      open({ instanceId: id, ref }) {
        const uuid = paramsSchema.parse(ref.params).resourceRef;
        const old = attempts.get(id);
        const a: Attempt = old?.phase === "choose" ? old : { phase: "opening", generation: (old?.generation ?? 0) + 1 };
        a.phase = "opening";
        a.uuid = uuid;
        delete a.cancel;
        delete a.selected;
        return new Promise(resolve => { a.opened = resolve; start(id, a); });
      },
      release, endsSessionOnLastClose: () => false, endSession: async () => "unknown",
    },
    sectionTitle: title, neutralLabel: title, canEndSession: false, offered: () => true,
    section: () => ({ state: "ready", items: [{ id: "choose", title: "Добавить вид " + title }] }),
    stableRefOf: () => null, refOf: () => null, label: () => ({ title }),
    stateText: (state, _ref, id) => state === "lost" && id && attempts.get(id)?.incompatible
      ? { title: "Панель недоступна", description: unsupportedVersion } : null,
    subscribe: () => () => {}, connect: value => { registry = value; },
    render: (_ref, id) => <Target type={type} id={id} bind={bind} />,
    embed: {
      target: id => <Target type={type} id={id} bind={bind} />,
      choose: (id, selected, cancel) => start(id, { phase: "choose", generation: 1, selected, cancel }),
      close(id) {
        const a = attempts.get(id);
        if (!a || a.phase === "stopped" || a.closing) return Promise.resolve("keep");
        return new Promise(resolve => {
          const timer = setTimeout(() => stop(id, a, "unknown"), timeout);
          a.closing = value => { clearTimeout(timer); resolve(value); };
          send(id, a, { kind: "close" });
        });
      },
    },
  };
}
export function embeddedSources(): ContentSource[] { return providers.map(embeddedSource); }
