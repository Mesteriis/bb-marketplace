// The GitWand UI in an iframe on a sibling loopback origin. The host entry
// computes the URL (src/core/frame-url.ts); null means no such origin exists.

const SANDBOX = "allow-scripts allow-same-origin allow-forms allow-popups allow-modals";

export interface GitWandFrameProps {
  url: string | null;
}

export function GitWandFrame({ url }: GitWandFrameProps) {
  if (url === null) {
    return (
      <div role="status" style={{ padding: 16 }}>
        GitWand открывается только в BB на этом компьютере: откройте BB по адресу http://127.0.0.1 или http://localhost.
      </div>
    );
  }
  return (
    <iframe
      title="GitWand"
      src={url}
      sandbox={SANDBOX}
      allow="clipboard-read; clipboard-write"
      style={{ display: "block", width: "100%", height: "100%", border: 0 }}
    />
  );
}
