// The GitWand UI in an iframe on a sibling loopback origin. The host entry
// computes the URL (src/core/frame-url.ts); null means no such origin exists.
import type { Ref } from "react";
import { Icon } from "@/components/ui/icon";

const SANDBOX = "allow-scripts allow-same-origin allow-forms allow-popups allow-modals";

export interface GitWandFrameProps {
  url: string | null;
  frameRef?: Ref<HTMLIFrameElement>;
}

export function GitWandFrame({ url, frameRef }: GitWandFrameProps) {
  if (url === null) {
    return (
      <div className="flex h-full w-full items-center justify-center p-6">
        <div role="status" className="flex max-w-md items-start gap-3 text-sm text-muted-foreground">
          <Icon name="MonitorOff" className="mt-0.5 size-4 shrink-0" />
          <span>GitWand открывается только в BB на этом компьютере: откройте BB по адресу http://127.0.0.1 или http://localhost.</span>
        </div>
      </div>
    );
  }
  return (
    <iframe
      ref={frameRef}
      title="GitWand"
      src={url}
      sandbox={SANDBOX}
      allow="clipboard-read; clipboard-write"
      className="block h-full w-full border-0"
    />
  );
}
