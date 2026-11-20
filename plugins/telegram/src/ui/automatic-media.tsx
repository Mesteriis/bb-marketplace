import { useTelegramLocale } from "./i18n/index.tsx";
import type { ZodType } from "zod";
import { useEffect, useRef, useState, type RefObject } from "react";
import { autoMediaLimits, autoMediaPolicy, autoMediaScopes, maxAutoMediaMiB, type AutoMediaLimits, type AutoMediaPolicy } from "../core/contract.ts";
import type { Chat, Message } from "../core/demo.ts";

export type PrefetchVisibleMedia = (chatId: string, messageId: string, topicId?: number) => Promise<boolean>;

export function mediaLimitsForChat(chat: Chat | undefined, policy?: AutoMediaPolicy, override?: AutoMediaLimits) {
  const scope = chat?.subtitle === "Direct message" ? "private" : chat?.subtitle === "Group" ? "group"
    : chat?.subtitle === "Channel" ? "channel" : undefined;
  return scope ? override ?? policy?.[scope] : undefined;
}

export function visibleMediaCandidates(chat: Chat | undefined, messages: readonly Message[] | undefined, policy?: AutoMediaPolicy, override?: AutoMediaLimits) {
  const limits = mediaLimitsForChat(chat, policy, override);
  if (!limits || !(limits.photo || limits.video || limits.file)) return "";
  return (messages ?? []).filter((message) => !message.outgoing && !message.retained && !message.pendingDelivery && !message.failedDelivery
    && !message.oneView && !message.photoSpoiler && /^[1-9]\d{0,15}$/.test(message.id)
    && ((limits.photo > 0 && message.hasPhoto)
      || ((limits.video > 0 || limits.file > 0) && message.document?.downloadable))).map(({ id }) => id).join(" ");
}

export function useVisibleMediaPrefetch({ list, chatId, topicId, ids, enabled, policy, override, prefetch }: {
  list: RefObject<HTMLOListElement | null>;
  chatId: string;
  topicId?: number;
  ids: string;
  enabled: boolean;
  policy?: AutoMediaPolicy;
  override?: AutoMediaLimits;
  prefetch?: PrefetchVisibleMedia;
}) {
  const attempted = useRef(new Set<string>());
  const busy = useRef(false);
  const resume = useRef<() => void>(undefined);
  useEffect(() => { attempted.current.clear(); }, [chatId, topicId, policy, override]);
  useEffect(() => {
    const history = list.current;
    if (!enabled || !ids || !prefetch || !history || typeof IntersectionObserver !== "function") return;
    const eligible = new Set(ids.split(" "));
    const visible = new Set<string>();
    let active = true;

    function pump() {
      if (!active || !prefetch || !history || history.hidden || busy.current || document.visibilityState !== "visible") return;
      const id = [...visible].find((value) => !attempted.current.has(value));
      if (!id) return;
      attempted.current.add(id);
      busy.current = true;
      void prefetch(chatId, id, topicId).catch(() => false).finally(() => {
        busy.current = false;
        resume.current?.();
      });
    }

    resume.current = pump;
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        const id = (entry.target as HTMLElement).dataset.messageId;
        if (!id) continue;
        if (entry.isIntersecting && entry.intersectionRatio > 0) visible.add(id);
        else visible.delete(id);
      }
      pump();
    }, { root: history });
    history.querySelectorAll<HTMLElement>("[data-message-id]").forEach((row) => {
      if (eligible.has(row.dataset.messageId ?? "")) observer.observe(row);
    });
    document.addEventListener("visibilitychange", pump);
    return () => {
      active = false;
      if (resume.current === pump) resume.current = undefined;
      observer.disconnect();
      document.removeEventListener("visibilitychange", pump);
    };
  }, [chatId, topicId, ids, enabled, policy, override, list, prefetch]);
}

const scopes = { private: "Private chats", group: "Groups", channel: "Channels" } as const;
const categories = { photo: "Photos", video: "Videos and GIFs", file: "Documents and audio" } as const;
const mediaTypes = ["photo", "video", "file"] as const;
const disabledLimits: AutoMediaLimits = { photo: 0, video: 0, file: 0 };

function MediaLimitFields({ limits, change }: {
  limits: AutoMediaLimits;
  change: (type: keyof AutoMediaLimits, limit: number) => void;
}) {
  const { t: tr } = useTelegramLocale();
  return mediaTypes.map((type) => <label key={type}>{categories[type]}{tr(" limit (MiB)")}<input type="number" min={0} max={maxAutoMediaMiB} step={1} required
      value={Number.isNaN(limits[type]) ? "" : limits[type]}
      onChange={(event) => change(type, event.currentTarget.valueAsNumber)} />
  </label>);
}

export function AutomaticMediaSettings({ policy, save }: {
  policy: AutoMediaPolicy;
  save: (policy: AutoMediaPolicy) => Promise<AutoMediaPolicy>;
}) {
  const { t: tr } = useTelegramLocale();
  const [draft, setDraft] = useState(policy);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const parsed = autoMediaPolicy.safeParse(draft);
  const changed = parsed.success && JSON.stringify(parsed.data) !== JSON.stringify(policy);
  return <details>
    <summary>{tr("Automatic media downloads")}</summary>
    <p>{tr("Cache originals from messages visible in BB. Set a limit to 0 to turn off automatic downloads for that type.")}</p>
    <form onSubmit={async (event) => {
      event.preventDefault();
      if (!changed || busy) return;
      setBusy(true);
      setStatus("");
      try {
        const saved = await save(parsed.data);
        setDraft(saved);
        setStatus("Automatic download settings saved.");
      } catch {
        setStatus("Could not save automatic download settings.");
      } finally { setBusy(false); }
    }}>
      <div className="mtg-auto-media-limits">
        {autoMediaScopes.map((scope) => <fieldset key={scope} disabled={busy}>
          <legend>{scopes[scope]}</legend>
          <MediaLimitFields limits={draft[scope]} change={(type, limit) =>
            setDraft((before) => ({ ...before, [scope]: { ...before[scope], [type]: limit } }))} />
        </fieldset>)}
      </div>
      <button type="submit" className="mtg-action" disabled={!changed || busy}>{tr("Save automatic downloads")}</button>
      {status && <p role="status">{tr(status)}</p>}
    </form>
  </details>;
}

type OverrideMode = "inherit" | "disabled" | "custom";
function overrideMode(limits: Record<string, number> | undefined): OverrideMode {
  if (!limits) return "inherit";
  return Object.values(limits).some(Boolean) ? "custom" : "disabled";
}

export function ChatAutomaticMedia(props: {
  value?: AutoMediaLimits;
  defaults: AutoMediaLimits;
  save: (limits: AutoMediaLimits | null) => Promise<AutoMediaLimits | null>;
}) {
  return <ChatMediaRuleEditor {...props} kind="download" schema={autoMediaLimits} disabledLimits={disabledLimits} labels={categories} />;
}

export function ChatMediaRuleEditor<K extends string>({ value, defaults, save, kind, schema, disabledLimits, labels }: {
  value?: Record<K, number>;
  defaults: Record<K, number>;
  save: (limits: Record<K, number> | null) => Promise<Record<K, number> | null>;
  kind: "download" | "playback";
  schema: ZodType<Record<K, number>>;
  disabledLimits: Record<K, number>;
  labels: Record<K, string>;
}) {
  const { t: tr } = useTelegramLocale();
  const [mode, setMode] = useState<OverrideMode>(() => overrideMode(value));
  const [limits, setLimits] = useState(value && overrideMode(value) === "custom" ? value : defaults);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const result = schema.nullable().safeParse(mode === "inherit" ? null : mode === "disabled" ? disabledLimits : limits);
  const changed = result.success && JSON.stringify(result.data) !== JSON.stringify(value ?? null);
  const download = kind === "download";
  return <details>
    <summary>{download ? tr("Automatic media downloads") : tr("Automatic playback")}</summary>
    <form onSubmit={async (event) => {
      event.preventDefault();
      if (!changed || busy) return;
      setBusy(true);
      setStatus("");
      try {
        const saved = await save(result.data);
        setMode(overrideMode(saved ?? undefined));
        setStatus(tr("Chat automatic {0} settings saved.", [kind]));
      } catch {
        setStatus(tr("Could not save this chat’s automatic {0} settings.", [kind]));
      } finally { setBusy(false); }
    }}>
      <label>{download ? tr("Download policy") : tr("Playback policy")} <select disabled={busy} value={mode} onChange={(event) => setMode(event.currentTarget.value as OverrideMode)}>
        <option value="inherit">{tr("Use defaults for this chat type")}</option>
        <option value="disabled">{tr("Turn off for this chat")}</option>
        <option value="custom">{tr("Set limits for this chat")}</option>
      </select></label>
      {mode === "custom" && <fieldset disabled={busy}>
        <legend>{download ? tr("Download limits for this chat") : tr("Playback limits for this chat")}</legend>
        {(Object.keys(labels) as K[]).map((type) => <label key={type}>{labels[type]}{tr(" limit (MiB)")}<input type="number" min={0} max={maxAutoMediaMiB} step={1} required
            value={Number.isNaN(limits[type]) ? "" : limits[type]}
            onChange={(event) => {
              const limit = event.currentTarget.valueAsNumber;
              setLimits((before) => ({ ...before, [type]: limit }));
            }} />
        </label>)}
      </fieldset>}
      <button type="submit" className="mtg-action" disabled={!changed || busy}>{tr("Save chat ")}{kind}{tr(" settings")}</button>
      {status && <p role="status">{tr(status)}</p>}
    </form>
  </details>;
}
