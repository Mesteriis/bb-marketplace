import { useEffect, useMemo, useReducer, useRef } from "react";
import { createPortal } from "react-dom";
import { Button } from "@/components/ui/button";
import { CallAnchor } from "../../ui/call-anchor";
import type { WindowCalls } from "../../ui/window-calls";
import { EmbedOwner, type View, type EmbedApi } from "./embed-owner";
import { WindowCallLayer } from "./window-call-layer";

function Tile({ owner, view: v }: { owner: EmbedOwner; view: View }) {
  if (v.prompt)
    return (
      <div role="alertdialog" aria-label="Выйти из встречи?" className="flex flex-wrap items-center gap-2 p-3">
        <p>Вы закрываете последний вид звонка. Выйти из встречи?</p>
        <Button onClick={() => owner.decide(v, "keep")}>Оставить</Button>
        <Button onClick={() => owner.decide(v, "hide")}>Скрыть</Button>
        <Button variant="destructive" onClick={() => owner.decide(v, "leave")}>
          Выйти из встречи
        </Button>
      </div>
    );
  if (v.status === "choosing")
    return (
      <div className="flex h-full flex-col gap-2 overflow-auto p-3">
        <h2>Выберите встречу Zoom</h2>
        {!v.options && <p>Загружаю встречи…</p>}
        {v.options?.length === 0 && <p>Предстоящих встреч нет</p>}
        {v.options?.map((m) => (
          <Button key={m.id} disabled={v.busy || !!v.pending} onClick={() => void owner.select(v, m.id)}>
            {m.topic || "Встреча Zoom"}
          </Button>
        ))}
        <Button variant="outline" onClick={() => owner.cancel(v)}>
          Отмена
        </Button>
      </div>
    );
  if ((v.status === "ready" || v.status === "lost") && v.meeting && owner.calls.snapshot().has(v.meeting.id)) {
    return <CallAnchor calls={owner.calls} id={v.meeting.id} />;
  }
  if (v.status === "ready" && v.meeting)
    return (
      <div className="flex flex-wrap items-center gap-2 p-3">
        <h2>{v.meeting.topic || "Встреча Zoom"}</h2>
        {owner.url ? (
          <Button disabled={v.busy} onClick={() => void owner.join(v)}>
            Войти в звонок
          </Button>
        ) : (
          <p>Для звонка откройте BB по локальному адресу.</p>
        )}
      </div>
    );
  return (
    <p role="status" className="p-3">
      {v.status === "denied"
        ? "Нет доступа к встрече Zoom"
        : v.status === "ended"
          ? "Вид закрыт"
          : v.status === "lost"
            ? "Связь со звонком потеряна"
            : v.status === "cancelled"
              ? "Выбор отменён"
              : "Проверяю встречу…"}
    </p>
  );
}
export function EmbedOverlay({
  api,
  calls,
  url,
  openExternal,
  generations,
}: {
  generations?: Map<string, number>;
  api: EmbedApi;
  calls: WindowCalls;
  url: string | null;
  openExternal: (url: string) => void;
}) {
  const [, redraw] = useReducer((n) => n + 1, 0);
  const localGenerations = useRef(new Map<string, number>());
  const owner = useMemo(
    () => new EmbedOwner(api, calls, url, openExternal, redraw, generations ?? localGenerations.current),
    [api, calls, url, openExternal, generations],
  );
  useEffect(() => owner.start(), [owner]);
  return (
    <>
      <WindowCallLayer calls={calls} />
      {owner.all().map((v) =>
        createPortal(
          <div className="h-full" hidden={!v.visible} inert={!v.visible}>
            <Tile owner={owner} view={v} />
          </div>,
          v.target,
          v.instanceId + "/" + v.generation,
        ),
      )}
    </>
  );
}
