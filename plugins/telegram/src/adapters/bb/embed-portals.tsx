import { createAccountDrafts, type AccountDrafts } from "../../ui/local-drafts.ts";
import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { z } from "zod";

const version = "chertog.embed.v1";
const provider = "telegram-chat";
const address = { version: z.literal(version), provider: z.literal(provider),
  instanceId: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/), generation: z.number().int().positive() };
const ref = z.uuidv4().regex(/^[a-f0-9-]+$/);
const hostMessage = z.union([
  z.strictObject({ ...address, kind: z.literal("announce"), mode: z.literal("choose") }),
  z.strictObject({ ...address, kind: z.literal("announce"), resourceRef: ref }),
  z.strictObject({ ...address, kind: z.literal("visibility"), visible: z.boolean() }),
  z.strictObject({ ...address, kind: z.enum(["release", "close"]) }),
]);

function ownedTarget(node: EventTarget | null, id: string, generation?: number): node is HTMLDivElement {
  if (!(node instanceof HTMLDivElement) || node.ownerDocument !== document || !node.isConnected) return false;
  const layers = document.querySelectorAll('[data-chertog-embed-layer="v1"]');
  const host = node.closest("[data-live-host]");
  return layers.length === 1 && host?.parentElement === layers[0] && host.getAttribute("data-live-host") === id
    && layers[0]!.querySelectorAll(`[data-live-host="${id}"]`).length === 1
    && host.querySelectorAll('[data-chertog-embed-target="v1"]').length === 1
    && node.dataset.chertogEmbedTarget === "v1" && node.dataset.instanceId === id && node.dataset.provider === provider
    && (generation === undefined || node.dataset.generation === String(generation));
}
type Status = "choosing" | "ready" | "denied" | "ended" | "lost" | "revoked" | "cancelled";
// Lifetime follows the host instance. Recovery can replace its generation without
// replacing a draft. The server resolves the account/chat/topic UUID before lookup.
function instanceDrafts() {
  let current: { resource: string; drafts: AccountDrafts } | undefined;
  return (resource: string) => {
    if (current?.resource !== resource)
      current = { resource, drafts: createAccountDrafts() };
    return current.drafts;
  };
}
export type EmbedPanel = {
  drafts: ReturnType<typeof instanceDrafts>;
  resourceRef?: string; closing: boolean; visible: boolean;
  status: (kind: Status) => void; select: (uuid: string) => void; keep: () => void; hide: () => void;
};
type View = { id: string; generation: number; node: HTMLDivElement; panel: EmbedPanel; pending?: string; last?: Status };

function finished(view: View) {
  return view.last === "cancelled" || view.last === "ended" || view.last === "lost";
}

export function TelegramPortals({ renderPanel }: { renderPanel: (panel: EmbedPanel) => ReactNode }) {
  const [views, setViews] = useState<View[]>([]);
  useEffect(() => {
    const active = new Map<string, View>(), generations = new Map<string, number>();
    // An announcement owns one generation, but the draft belongs to the instance on this node.
    const drafts = new Map<string, { node: HTMLDivElement; store: EmbedPanel["drafts"] }>();
    function refresh() { setViews([...active.values()]); }
    function reply(v: View, kind: string, resourceRef?: string) {
      if (active.get(v.id) !== v || !ownedTarget(v.node, v.id, v.generation)) return;
      v.node.dispatchEvent(new CustomEvent(version + ".owner", { bubbles: true, detail: {
        version, provider, kind, instanceId: v.id, generation: v.generation, ...(resourceRef && { resourceRef }),
      } }));
    }
    const receive = (event: Event) => {
      if (!(event instanceof CustomEvent)) return;
      const m = hostMessage.safeParse(event.detail).data;
      const node = event.target;
      if (!m || !ownedTarget(node, m.instanceId, m.generation)) return;
      const old = active.get(m.instanceId);
      const seen = generations.get(m.instanceId) ?? 0;
      if (m.generation < seen || (m.generation === seen && old?.node !== node)) return;
      if (m.kind !== "announce") {
        if (!old || old.generation !== m.generation) return;
        if (m.kind === "release") { active.delete(old.id); drafts.delete(old.id); }
        else if (m.kind === "close") {
          if (old.last === "ended") { reply(old, "ended"); return; }
          old.panel.closing = true;
        }
        else if ("visible" in m) old.panel.visible = m.visible;
        refresh();
        return;
      }
      const uuid = "resourceRef" in m ? m.resourceRef : undefined;
      if (old?.generation === m.generation) {
        if (old.panel.resourceRef === uuid) {
          if (old.last) reply(old, old.last);
          return;
        }
        if (finished(old) || !uuid || old.panel.resourceRef || old.pending !== uuid) return;
        old.panel.resourceRef = uuid;
        old.pending = undefined;
        old.last = undefined;
        refresh();
        return;
      }
      const previous = drafts.get(m.instanceId);
      const store = previous?.node === node ? previous.store : instanceDrafts();
      drafts.set(m.instanceId, { node, store });
      const view: View = { id: m.instanceId, generation: m.generation, node, panel: {
        drafts: store,
        resourceRef: uuid, visible: !node.closest("[inert],[hidden]"), closing: false,
        status(kind) {
          if (active.get(view.id) !== view || finished(view)) return;
          view.last = kind;
          reply(view, kind);
          if (finished(view)) refresh();
        },
        select(value) {
          if (finished(view) || view.pending || view.panel.resourceRef || !ref.safeParse(value).success) return;
          view.pending = value;
          reply(view, "selected", value);
        },
        keep() { view.panel.closing = false; reply(view, "keep"); refresh(); },
        hide() { view.panel.closing = false; reply(view, "hide"); refresh(); },
      } };
      generations.set(view.id, view.generation);
      active.set(view.id, view);
      refresh();
    };
    document.addEventListener(version + ".host", receive);
    const observer = new MutationObserver(() => {
      let changed = false;
      for (const view of active.values()) if (!ownedTarget(view.node, view.id, view.generation)) {
        active.delete(view.id); changed = true;
      }
      for (const [id, entry] of drafts) {
        if (!ownedTarget(entry.node, id)) drafts.delete(id);
      }
      if (changed) refresh();
    });
    observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true,
      attributeFilter: ["data-live-host","data-generation","data-provider","data-instance-id","data-chertog-embed-target","data-chertog-embed-layer"] });
    document.dispatchEvent(new CustomEvent(version + ".query", { detail: { version, provider, kind: "query" } }));
    return () => {
      observer.disconnect();
      document.removeEventListener(version + ".host", receive);
      for (const view of active.values()) reply(view, "revoked");
      active.clear();
      drafts.clear();
    };
  }, []);
  return <>{views.map(v => createPortal(<div inert={!v.panel.visible} style={{height:"100%"}}>{finished(v)
      ? <p role="status">{v.last === "lost" ? "Связь с Telegram потеряна." : v.last === "ended" ? "Вид закрыт." : "Выбор отменён."}</p>
      : renderPanel(v.panel)}</div>,
    v.node, v.id + ":" + v.generation))}</>;
}
