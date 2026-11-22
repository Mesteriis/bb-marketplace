import { useEffect, useMemo, useReducer } from "react";
import { createPortal } from "react-dom";
import { Button } from "@/components/ui/button";
import { AttachedSession } from "../../ui/live-session.tsx";
import { DocumentRefs, RemoteEmbedOwner, type RemoteEmbedApi, type Surface, type Tile } from "./embed-owner.ts";

function LiveSurface({ v, owner }: { v: Surface; owner: RemoteEmbedOwner }) {
  return (
    <AttachedSession
      handle={v.handle}
      rdpHandle={v.rdpHandle}
      view={{ kind: v.kind, ...v.socket }}
      canInput={() => owner.canInput(v)}
      takeover={() => owner.takeover(v)}
      onStatus={(state) => owner.report(v, state)}
    />
  );
}
function RemoteTile({ t, owner }: { t: Tile; owner: RemoteEmbedOwner }) {
  return (
    <section className="rh-embed" hidden={!t.visible} inert={!t.visible}>
      {t.confirm && (
        <div role="alertdialog" aria-label="Закрыть графическую консоль?">
          <p>Закрытие единственного просмотра завершит консоль VNC.</p>
          <Button disabled={t.busy} onClick={() => void owner.decide(t, "keep")}>
            Оставить
          </Button>
          <Button disabled={t.busy} onClick={() => void owner.decide(t, "hide")}>
            Скрыть
          </Button>
          <Button disabled={t.busy || !t.surface?.ready} variant="destructive" onClick={() => void owner.decide(t, "end")}>
            Завершить консоль
          </Button>
        </div>
      )}
      {t.status === "choosing" && (
        <div className="rh-embed-picker">
          <h2>Выберите открытую сессию {t.provider.split("-")[1].toUpperCase()}</h2>
          {!t.options && <p>Загрузка сессий…</p>}
          {t.options?.length === 0 && <p>Подходящих открытых сессий нет.</p>}
          {t.options?.map((s) => (
            <Button key={s.generation + "." + s.sessionId} disabled={t.busy || !!t.selected} onClick={() => void owner.select(t, s)}>
              {s.pve?.guestName || s.pve?.connectionName || s.kind.toUpperCase()} · {s.sessionId}
            </Button>
          ))}
          <Button variant="outline" onClick={() => owner.cancel(t)}>
            Отмена
          </Button>
        </div>
      )}
      {t.status === "lost" && <p role="status">Связь с сессией потеряна. Выберите открытую сессию заново.</p>}
      {t.status === "denied" && <p role="status">Просмотр недоступен.</p>}
      {t.status === "ended" && <p role="status">Просмотр закрыт.</p>}
      {t.status === "cancelled" && <p role="status">Выбор отменён.</p>}
      {!t.status && <p role="status">Открытие просмотра…</p>}
      <div inert={t.confirm || t.status === "ended"} hidden={t.status === "ended"}>
        {t.surface && <LiveSurface v={t.surface} owner={owner} />}
      </div>
    </section>
  );
}
export function RemoteEmbedOverlay({ api, refs }: { api: RemoteEmbedApi; refs: DocumentRefs }) {
  const [, redraw] = useReducer((n) => n + 1, 0);
  const owner = useMemo(() => new RemoteEmbedOwner(api, refs, redraw), [api, refs]);
  useEffect(() => owner.start(), [owner]);
  return (
    <>
      {[...owner.tiles.values()].map((t) => createPortal(<RemoteTile t={t} owner={owner} />, t.target, t.instanceId + "/" + t.generation))}
    </>
  );
}
