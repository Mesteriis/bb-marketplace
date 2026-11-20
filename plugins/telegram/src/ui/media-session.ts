const currentControls = new WeakMap<MediaSession, () => void>();
type Tracks = { previous?: () => void; next?: () => void };

export function bindMediaSession(media: HTMLMediaElement, tracks?: Tracks, audioMetadata?: MediaMetadataInit) {
  const session = navigator.mediaSession;
  if (!session || typeof session.setActionHandler !== "function") return;
  currentControls.get(session)?.();
  const actions = new Set<MediaSessionAction>();
  const previousMetadata = session.metadata;
  let metadata: MediaMetadata | undefined;
  if (audioMetadata && typeof MediaMetadata === "function") {
    try {
      const next = new MediaMetadata(audioMetadata);
      session.metadata = next;
      metadata = next;
    } catch { /* Some hosts expose actions without writable metadata. */ }
  }

  function state(value: MediaSessionPlaybackState) {
    if (currentControls.get(session) !== release) return;
    session.playbackState = value;
  }

  function release() {
    if (currentControls.get(session) !== release) return;
    for (const action of actions) session.setActionHandler(action, null);
    state("none");
    if (metadata && session.metadata === metadata) session.metadata = previousMetadata;
    currentControls.delete(session);
  }

  function register(action: MediaSessionAction, handler?: () => void) {
    if (currentControls.get(session) !== release) return;
    try {
      if (handler) {
        session.setActionHandler(action, () => {
          if (currentControls.get(session) === release) handler();
        });
        actions.add(action);
      } else if (actions.delete(action)) session.setActionHandler(action, null);
    } catch { /* The browser may support only some actions. */ }
  }

  function setTracks(current?: Tracks) {
    register("previoustrack", current?.previous);
    register("nexttrack", current?.next);
  }

  currentControls.set(session, release);
  register("play", () => { void media.play().catch(() => {}); });
  register("pause", () => media.pause());
  register("stop", () => {
    media.pause();
    if (media.readyState >= media.HAVE_METADATA) media.currentTime = 0;
    release();
  });
  setTracks(tracks);
  state("playing");
  return { pause: () => state("paused"), release, setTracks };
}
