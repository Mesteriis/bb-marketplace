import { useTelegramLocale } from "./i18n/index.tsx";
import { useContext, useEffect, useRef, useState } from "react";
import { chatEventFilter, groupPermissionLabels, miniAppAdministratorRightLabels, reactionKey, type AntiSpamReportResult, type ChatEventActor, type ChatEventFilter, type ChatEventPage } from "../core/contract.ts";
import { CustomEmojiLoader, InlineCustomEmoji } from "./custom-emoji.tsx";
import { StaticTelegramMarkup } from "./static-telegram-markup.tsx";

export type ChatEventLoader = (id: string, query: string, cursor?: string, filters?: ChatEventFilter[], actorId?: string) => Promise<ChatEventPage | null>;
export type ChatEventActorLoader = (id: string) => Promise<ChatEventActor[]>;
export type AntiSpamReport = (id: string, eventId: string) => Promise<AntiSpamReportResult>;

const filterLabels: Record<ChatEventFilter, string> = {
  messages: "Messages",
  members: "Members",
  settings: "Chat settings",
  invites: "Invite links",
  topics: "Topics",
  subscriptions: "Subscriptions",
};

function EventSnapshot({ text, html }: { text: string; html?: string }) {
  const fallback = <p dir="auto">{text}</p>;
  return html ? <div dir="auto"><StaticTelegramMarkup html={html} className="mtg-instant-view-static-embed" empty={fallback} /></div> : fallback;
}

function ModerationExpiry({ seconds }: { seconds: number }) {
  const { locale: uiLocale, t: tr } = useTelegramLocale();
  if (seconds === 0) return <>{tr("Indefinite")}</>;
  const date = new Date(seconds * 1000);
  return <time dateTime={date.toISOString()}>{date.toLocaleString(uiLocale)}</time>;
}

function EventComparison({ label, before, after, empty, beforeHtml, afterHtml }: {
  label: string; before: string; after: string; empty: string; beforeHtml?: string; afterHtml?: string;
}) {
  const { t: tr } = useTelegramLocale();
  return <details className="mtg-event-edit">
    <summary>{label}</summary>
    <div><strong>{tr("Before")}</strong><EventSnapshot text={before || empty} html={beforeHtml} /></div>
    <div><strong>{tr("After")}</strong><EventSnapshot text={after || empty} html={afterHtml} /></div>
  </details>;
}

function InviteEventSettings({ settings }: { settings: NonNullable<ChatEventPage["events"][number]["invite"]>["settings"] }) {
  const { locale: uiLocale, t: tr } = useTelegramLocale();
  return <ul>
    {settings.name !== undefined && <li>{tr("Name · ")}<bdi>{settings.name || tr("Unnamed link")}</bdi></li>}
    {settings.primary && <li>{tr("Primary invite link")}</li>}
    {settings.expiresAt !== undefined && <li>{tr("Expiry · ")}{settings.expiresAt === 0
      ? tr("Never") : <time dateTime={new Date(settings.expiresAt * 1000).toISOString()}>{new Date(settings.expiresAt * 1000).toLocaleString(uiLocale)}</time>}</li>}
    {settings.memberLimit !== undefined && <li>{tr("Member limit · ")}{settings.memberLimit || tr("Unlimited")}</li>}
    {settings.approval !== undefined && <li>{tr("Join approval · ")}{settings.approval ? tr("Required") : tr("Off")}</li>}
  </ul>;
}

type ReactionChange = NonNullable<ChatEventPage["events"][number]["reactionChange"]>;

function ReactionEventPolicy({ policy }: { policy: ReactionChange["before"] }) {
  const { t: tr } = useTelegramLocale();
  const loadEmoji = useContext(CustomEmojiLoader);
  if (policy.mode === "selected" && !policy.reactions.length) return <p>{tr("Emoji reactions off")}</p>;
  return <>
    {policy.mode === "all" ? <p>{tr("All standard reactions")}</p> : <p aria-label={tr("Selected reactions")}>
      {policy.reactions.map((reaction) => <span key={reactionKey(reaction)}>
        {reaction.kind === "emoji" ? reaction.emoji : loadEmoji
          ? <span role="img" aria-label={tr("Custom emoji {0}", [reaction.id])}><InlineCustomEmoji id={reaction.id} label="✦" load={loadEmoji} /></span>
          : <bdi>{tr("Custom emoji ")}{reaction.id}</bdi>}{" "}
      </span>)}
    </p>}
    <p>{tr("Maximum per message · ")}{policy.limit}</p>
  </>;
}

function ReactionEventComparison({ before, after }: ReactionChange) {
  const { t: tr } = useTelegramLocale();
  const [expanded, setExpanded] = useState(false);
  return <details onToggle={(event) => setExpanded(event.currentTarget.open)}>
    <summary>{tr("Compare reactions")}</summary>
    {expanded && <>
      <strong>{tr("Before")}</strong><ReactionEventPolicy policy={before} />
      <strong>{tr("After")}</strong><ReactionEventPolicy policy={after} />
    </>}
  </details>;
}

function AntiSpamReportAction({ submit }: { submit: () => Promise<AntiSpamReportResult> }) {
  const { t: tr } = useTelegramLocale();
  const [review, setReview] = useState(false);
  const [result, setResult] = useState<AntiSpamReportResult>();
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  async function confirm() {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    const outcome = await submit().catch(() => "unknown" as const);
    setResult(outcome);
    setReview(false);
    setBusy(false);
    pending.current = false;
  }
  if (result) return <p role="status">{result === "sent" ? tr("Report sent to Telegram.")
    : result === "unavailable" ? tr("Telegram no longer allows reporting this deletion.") : tr("Telegram did not confirm the report.")}</p>;
  if (!review) return <button type="button" className="mtg-action" onClick={() => setReview(true)}>{tr("Report false positive")}</button>;
  return <div role="group" aria-label={tr("Confirm anti-spam report")}>
    <p>{tr("Tell Telegram that its spam filter deleted this message by mistake?")}</p>
    <button type="button" className="mtg-action" disabled={busy} onClick={() => setReview(false)}>{tr("Cancel")}</button>
    <button type="button" className="mtg-action" disabled={busy} onClick={() => void confirm()}>{tr("Send report")}</button>
  </div>;
}

export function ChatEvents({ chatId, load, loadActors, openMessage, openTopic, reportAntiSpam }: {
  chatId: string; load: ChatEventLoader; loadActors?: ChatEventActorLoader;
  openMessage?: (id: string, topicId?: number) => void;
  openTopic?: (id: number, signal: AbortSignal) => Promise<boolean>;
  reportAntiSpam?: AntiSpamReport;
}) {
  const { locale: uiLocale, t: tr } = useTelegramLocale();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [categories, setCategories] = useState<ChatEventFilter[]>([]);
  const [request, setRequest] = useState<{ query: string; cursor?: string; filters?: ChatEventFilter[]; actorId?: string }>({ query: "" });
  const [actors, setActors] = useState<ChatEventActor[]>([]);
  const [actorsFailed, setActorsFailed] = useState(false);
  const [page, setPage] = useState<ChatEventPage | null>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const topicRequest = useRef<AbortController | null>(null);
  const [topicNavigation, setTopicNavigation] = useState<{ event: string; state: "loading" | "unavailable" }>();
  useEffect(() => () => topicRequest.current?.abort(), []);
  useEffect(() => {
    if (!open || !loadActors) return;
    let active = true;
    void loadActors(chatId).then((items) => {
      if (active) { setActors(items); setActorsFailed(false); }
    }, () => { if (active) setActorsFailed(true); });
    return () => { active = false; };
  }, [chatId, loadActors, open]);
  useEffect(() => {
    if (!open) return;
    let active = true;
    setLoading(true);
    setError(false);
    void load(chatId, request.query, request.cursor, request.filters, request.actorId).then((next) => {
      if (!active) return;
      if (request.cursor && !next) setError(true);
      else setPage((previous) => {
        if (!request.cursor || !next) return next;
        const events = new Map(previous?.events.map((event) => [event.id, event]));
        for (const event of next.events) events.set(event.id, event);
        return { events: [...events.values()], next: next.next };
      });
    }, () => { if (active) setError(true); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [chatId, load, open, request]);

  function search(actorId?: string) {
    setPage(undefined);
    setRequest({ query: text.trim(), filters: categories.length ? categories : undefined, actorId });
  }

  async function navigateTopic(event: string, topic: number) {
    if (!openTopic || topicRequest.current) return;
    const request = new AbortController();
    topicRequest.current = request;
    setTopicNavigation({ event, state: "loading" });
    const opened = await openTopic(topic, request.signal).catch(() => false);
    if (!request.signal.aborted) {
      topicRequest.current = null;
      setTopicNavigation(opened ? undefined : { event, state: "unavailable" });
    }
  }

  return <details onToggle={(event) => {
    const expanded = event.currentTarget.open;
    if (!expanded) {
      topicRequest.current?.abort();
      topicRequest.current = null;
      setTopicNavigation(undefined);
    }
    setOpen(expanded);
  }}>
    <summary>{tr("Recent actions")}</summary>
    {open && <>
      <details>
        <summary>{tr("Action categories")}</summary>
        <fieldset>
          <legend>{tr("Filter by action category")}</legend>
          {chatEventFilter.options.map((category) => <label key={category}>
            <input type="checkbox" checked={categories.includes(category)} onChange={(event) => {
              const checked = event.currentTarget.checked;
              setCategories((previous) => checked ? [...previous, category] : previous.filter((value) => value !== category));
            }} /> {tr(filterLabels[category])}
          </label>)}
        </fieldset>
      </details>
      <form className="mtg-composer" onSubmit={(event) => {
        event.preventDefault();
        search(request.actorId);
      }}>
        <input type="search" maxLength={128} aria-label={tr("Search recent actions")} placeholder={tr("Search actions")}
          value={text} onChange={(event) => setText(event.target.value)} />
        {(actors.length > 0 || request.actorId) && <select aria-label={tr("Administrator")} value={request.actorId ?? ""}
          onChange={(event) => search(event.currentTarget.value || undefined)}>
          <option value="">{tr("All administrators")}</option>
          {request.actorId && !actors.some(({ id }) => id === request.actorId) &&
            <option value={request.actorId}>{tr("Previously selected administrator")}</option>}
          {actors.map(({ id, name }) => <option value={id} key={id}>{name}</option>)}
        </select>}
        <button type="submit" className="mtg-action">{tr("Find")}</button>
      </form>
      {actorsFailed && page && <p role="status">{tr("Could not load administrators for filtering.")}</p>}
      {loading && <p role="status">{tr("Loading recent actions…")}</p>}
      {error && <p role="alert">{tr("Could not load recent actions. ")}<button type="button" className="mtg-action"
        onClick={() => setRequest({ ...request })}>{tr("Retry")}</button></p>}
      {page === null && <p>{tr("Recent actions are unavailable for your role or chat type.")}</p>}
      {page && !page.events.length && !page.next && <p>{tr("No matching recent actions.")}</p>}
      {!!page?.events.length && <ol aria-label={tr("Recent Telegram actions")} className="mtg-scheduled-list">
        {page.events.map((event) => <li key={event.id}>
          <bdi>{event.actor}</bdi> · {event.action}
          {event.detail && <p>{event.detail}</p>}
          {event.topic && <p><bdi>{event.topic.name}</bdi></p>}
          {event.member && <p>{tr("Affected member ")}<bdi>{event.member}</bdi></p>}
          {event.approver && <p>{tr("Approved by ")}<bdi>{event.approver}</bdi></p>}
          {event.memberChange && <p>
            {event.memberChange.field === "tag" ? tr("Member tag") : tr("Member status")}{" "}
            <del><bdi>{event.memberChange.before || tr("No tag")}</bdi></del>
            {" → "}<ins><bdi>{event.memberChange.after || tr("No tag")}</bdi></ins>
          </p>}
          {event.moderationPeriod && <p>
            {event.moderationPeriod.kind === "ban" ? tr("Ban expires") : tr("Restriction expires")}{" "}
            {event.moderationPeriod.previousUntil === undefined
              ? <ModerationExpiry seconds={event.moderationPeriod.until} />
              : <><del><ModerationExpiry seconds={event.moderationPeriod.previousUntil} /></del>
                {" → "}<ins><ModerationExpiry seconds={event.moderationPeriod.until} /></ins></>}
          </p>}
          {event.permissionChanges && <details>
            <summary>{tr("Permission changes (")}{event.permissionChanges.length})</summary>
            <ul>
              {event.permissionChanges.map((change) => <li key={change.key}>
                {tr(change.kind === "administrator" ? miniAppAdministratorRightLabels[change.key] : groupPermissionLabels[change.key])}
                {" · "}{change.enabled ? tr("Allowed") : tr("Disallowed")}
              </li>)}
            </ul>
          </details>}
          {event.edit && <EventComparison label={tr("Compare versions")} empty="No text" {...event.edit} />}
          {event.settingChange && <EventComparison label={tr("Compare settings")} empty="None" {...event.settingChange} />}
          {event.reactionChange && <ReactionEventComparison {...event.reactionChange} />}
          {event.invite && <details>
            <summary>{tr("Invite link details")}</summary>
            {event.invite.previous && <>
              <strong>{tr("Before")}</strong>
              <InviteEventSettings settings={event.invite.previous} />
              <strong>{tr("After")}</strong>
            </>}
            <InviteEventSettings settings={event.invite.settings} />
          </details>}
          {event.deleted && <details className="mtg-event-edit">
            <summary>{event.deleted.html ? tr("View deleted formatted message") : tr("View deleted text")}</summary>
            {event.deleted.author && <div>{tr("Original sender ")}<bdi>{event.deleted.author}</bdi></div>}
            <EventSnapshot text={event.deleted.text} html={event.deleted.html} />
          </details>}
          {event.richSnapshot && <details className="mtg-event-edit">
            <summary>{tr("View recorded formatted message")}</summary>
            <EventSnapshot text="Formatted message unavailable." html={event.richSnapshot} />
          </details>}
          <time>{new Date(event.date * 1000).toLocaleString(uiLocale)}</time>
          {event.reportSpamDeletion && reportAntiSpam && <AntiSpamReportAction submit={() => reportAntiSpam(chatId, event.id)} />}
          {event.message && openMessage && <button type="button" className="mtg-action"
            onClick={() => openMessage(event.message!.id, event.message!.topicId)}>{tr("Open message")}</button>}
          {event.topic && openTopic && !event.message && <button type="button" className="mtg-action"
            disabled={topicNavigation?.state === "loading"} onClick={() => void navigateTopic(event.id, event.topic!.id)}>
            {topicNavigation?.state === "loading" && topicNavigation.event === event.id ? tr("Opening topic…") : tr("Open topic")}
          </button>}
          {topicNavigation?.state === "unavailable" && topicNavigation.event === event.id && <p role="status">{tr("This topic is unavailable.")}</p>}
        </li>)}
      </ol>}
      {page?.next && !error && <button type="button" className="mtg-action" disabled={loading}
        onClick={() => setRequest({ ...request, cursor: page.next! })}>{tr("Load more actions")}</button>}
    </>}
  </details>;
}
