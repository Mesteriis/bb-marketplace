import { useTelegramLocale } from "./i18n/index.tsx";
import { useState } from "react";
import { autoMediaScopes, autoPlaybackLimits, autoPlaybackPolicy, disabledAutoPlayback, maxAutoMediaMiB, type AutoPlaybackLimits, type AutoPlaybackPolicy, type VideoQuality } from "../core/contract.ts";
import { ChatMediaRuleEditor } from "./automatic-media.tsx";
import type { Chat, Message } from "../core/demo.ts";

export function playbackLimitsForChat(chat: Chat | undefined, policy?: AutoPlaybackPolicy, override?: AutoPlaybackLimits) {
  const scope = chat?.subtitle === "Direct message" ? "private" : chat?.subtitle === "Group" ? "group"
    : chat?.subtitle === "Channel" ? "channel" : undefined;
  return scope ? override ?? policy?.[scope] : undefined;
}

export function mayAutoplayMessage(message: Message, limits: AutoPlaybackLimits | undefined, canStreamQuality = false) {
  if (!limits || message.retained || message.pendingDelivery || message.failedDelivery || message.oneView || message.videoSpoiler
    || message.collectionKind === "sticker" || message.tgsSticker
    || !/^[1-9]\d{0,15}$/.test(message.id)) return false;
  const file = message.document;
  if (!file?.downloadable || !file.playbackMime || !file.sizeBytes || file.approximateSize) return false;
  const limit = message.animation ? limits.gif : message.videoNote ? limits.videoNote
    : file.playbackMime.startsWith("video/") ? limits.video : 0;
  const budget = limit * 1024 * 1024;
  return budget > 0 && (file.sizeBytes <= budget || (canStreamQuality && !message.animation && !message.videoNote
    && !!file.videoQualities?.some(({ sizeBytes }) => sizeBytes !== undefined && sizeBytes <= budget)));
}

export function chooseAutoplayVideoQuality(qualities: readonly VideoQuality[],
  budget: { originalBytes: number; limitBytes: number }, viewport: { width: number; height: number }) {
  const candidates = qualities.flatMap(({ fileId, width, height, sizeBytes }) =>
    sizeBytes === undefined || sizeBytes > budget.limitBytes || sizeBytes >= budget.originalBytes ? []
      : [{ fileId, sizeBytes, scale: Math.min(viewport.width / width, viewport.height / height) }]);
  candidates.sort((a, b) => {
    const aFits = a.scale <= 1;
    const bFits = b.scale <= 1;
    if (aFits !== bFits) return aFits ? -1 : 1;
    return aFits
      ? a.sizeBytes - b.sizeBytes || b.scale - a.scale
      : a.scale - b.scale || a.sizeBytes - b.sizeBytes;
  });
  return candidates[0]?.fileId;
}

const chatLabels = { private: "Private chats", group: "Groups", channel: "Channels" } as const;
const kinds = ["video", "gif", "videoNote"] as const;
const playbackLabels = { video: "Videos", gif: "GIFs", videoNote: "Video messages" } as const;

export function ChatAutomaticPlayback(props: {
  value?: AutoPlaybackLimits;
  defaults: AutoPlaybackLimits;
  save: (limits: AutoPlaybackLimits | null) => Promise<AutoPlaybackLimits | null>;
}) {
  return <ChatMediaRuleEditor {...props} kind="playback" schema={autoPlaybackLimits} disabledLimits={disabledAutoPlayback} labels={playbackLabels} />;
}

export function AutomaticPlaybackSettings({ policy, save }: {
  policy: AutoPlaybackPolicy;
  save: (policy: AutoPlaybackPolicy) => Promise<AutoPlaybackPolicy>;
}) {
  const { t: tr } = useTelegramLocale();
  const [draft, setDraft] = useState(policy);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const parsed = autoPlaybackPolicy.safeParse(draft);
  const changed = parsed.success && JSON.stringify(parsed.data) !== JSON.stringify(policy);
  return <details>
    <summary>{tr("Automatic playback")}</summary>
    <p>{tr("Play visible media without sound. Set a limit to 0 to disable automatic playback for that type.")}</p>
    <form onSubmit={async (event) => {
      event.preventDefault();
      if (!changed || busy) return;
      setBusy(true);
      setStatus("");
      try {
        setDraft(await save(parsed.data));
        setStatus("Automatic playback settings saved.");
      } catch {
        setStatus("Could not save automatic playback settings.");
      } finally { setBusy(false); }
    }}>
      <div className="mtg-auto-media-limits">
        {autoMediaScopes.map((scope) => <fieldset key={scope} disabled={busy}>
          <legend>{tr(chatLabels[scope])}</legend>
          {kinds.map((kind) => <label key={kind}>{tr(playbackLabels[kind])}{tr(" limit (MiB)")}<input type="number" min={0} max={maxAutoMediaMiB} step={1} required
              value={Number.isNaN(draft[scope][kind]) ? "" : draft[scope][kind]}
              onChange={(event) => {
                const limit = event.currentTarget.valueAsNumber;
                setDraft((before) => ({ ...before, [scope]: { ...before[scope], [kind]: limit } }));
              }} />
          </label>)}
        </fieldset>)}
      </div>
      <button type="submit" className="mtg-action" disabled={!changed || busy}>{tr("Save automatic playback")}</button>
      {status && <p role="status">{tr(status)}</p>}
    </form>
  </details>;
}
