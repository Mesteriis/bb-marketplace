// An iframe by URL for a live panel. The address is taken once, when the
// panel mounts: assigning `src` again navigates the frame, and a navigation
// is a reload. To show another URL, open another instance.
import { useState } from "react";
import { PanelStateView } from "./PanelStateView.tsx";

export interface FramePanelProps {
  /** Address of the page. Only the value at mount is used; later values are ignored. */
  src: string;
  /** Accessible name of the frame. */
  title: string;
  /** `sandbox` attribute of the iframe. Left out when not given. */
  sandbox?: string;
  /** Permissions policy of the iframe, for example "microphone; camera". Left out when not given. */
  allow?: string;
  /** Called on every `load` event of the frame. */
  onLoad?: () => void;
}

/**
 * The frame fills its container. Until the first `load` event the loading
 * state covers it; the cover is a sibling drawn after the iframe, so showing
 * and removing it never touches the iframe node.
 */
export function FramePanel({ src, title, sandbox, allow, onLoad }: FramePanelProps) {
  const [initialSrc] = useState(src);
  const [loaded, setLoaded] = useState(false);
  return (
    <div style={{ position: "relative", width: "100%", height: "100%" }}>
      <iframe
        src={initialSrc}
        title={title}
        sandbox={sandbox}
        allow={allow}
        style={{ display: "block", width: "100%", height: "100%", border: 0 }}
        onLoad={() => {
          setLoaded(true);
          onLoad?.();
        }}
      />
      {loaded ? null : (
        <div style={{ position: "absolute", inset: 0 }}>
          <PanelStateView state="loading" panelTitle={title} />
        </div>
      )}
    </div>
  );
}
