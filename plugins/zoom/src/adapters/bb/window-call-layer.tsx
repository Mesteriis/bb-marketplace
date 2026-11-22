import { useCallback, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { Button } from "@/components/ui/button";
import { CallPanel } from "../../ui/call-panel";
import type { WindowCalls, WindowCall } from "../../ui/window-calls";

export function visible(node: HTMLElement) {
  if (!node.isConnected || node.closest('[inert],[hidden],[aria-hidden="true"]')) return false;
  for (let el: HTMLElement | null = node; el; el = el.parentElement) {
    const style = getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden") return false;
  }
  return true;
}
function Surface({ calls, id, session }: { calls: WindowCalls; id: string; session: WindowCall }) {
  const afterExit = useRef<(() => void) | undefined>(undefined);
  const [confirm, setConfirm] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const node = ref.current!;
    let timer = 0;
    function position() {
      let rect: DOMRect | undefined;
      for (const [anchor, meeting] of calls.anchors) {
        if (meeting === id && visible(anchor)) rect = anchor.getBoundingClientRect();
      }
      node.hidden = !rect;
      node.inert = !rect;
      if (rect)
        Object.assign(node.style, {
          left: rect.x + "px",
          top: rect.y + "px",
          width: rect.width + "px",
          height: rect.height + "px",
        });
      timer = requestAnimationFrame(position);
    }
    position();
    return () => cancelAnimationFrame(timer);
  }, [calls, id]);
  const ended = useCallback(() => {
    calls.end(id);
    const action = afterExit.current;
    afterExit.current = undefined;
    action?.();
  }, [calls, id]);
  const moveToBrowser =
    session.openInBrowser &&
    (() => {
      if (session.leaving) return;
      afterExit.current = session.openInBrowser;
      calls.update(id, { leaving: true });
    });
  const lost = useCallback(() => calls.update(id, { lost: true }), [calls, id]);
  return (
    <div ref={ref} className="fixed z-40 overflow-hidden bg-background" style={{ pointerEvents: "auto" }}>
      {confirm && (
        <div role="alertdialog" aria-label="Завершить звонок?" className="flex items-center gap-2 p-2">
          <span>Выйти из встречи Zoom?</span>
          <Button onClick={() => setConfirm(false)}>Оставить</Button>
          <Button
            variant="destructive"
            onClick={() => {
              setConfirm(false);
              calls.update(id, { leaving: true });
            }}
          >
            Выйти из встречи
          </Button>
        </div>
      )}
      <CallPanel
        {...session}
        onClose={ended}
        onLost={lost}
        confirmLeave={() => setConfirm(true)}
        onOpenInBrowser={moveToBrowser}
      />
    </div>
  );
}
export function WindowCallLayer({ calls }: { calls: WindowCalls }) {
  const sessions = useSyncExternalStore(calls.subscribe, calls.snapshot);
  return createPortal(
    Array.from(sessions, ([id, session]) => <Surface key={id} calls={calls} id={id} session={session} />),
    document.body,
  );
}
