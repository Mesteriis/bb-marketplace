import { useLayoutEffect, useRef } from "react";
import type { WindowCalls } from "./window-calls";
export function CallAnchor({ calls, id }: { calls: WindowCalls; id: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const node = ref.current!;
    calls.anchors.set(node, id);
    return () => {
      calls.anchors.delete(node);
    };
  }, [calls, id]);
  return <div ref={ref} className="h-full min-h-0 w-full" />;
}
