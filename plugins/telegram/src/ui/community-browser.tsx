import { useTelegramLocale } from "./i18n/index.tsx";
import { UsersRound } from "lucide-react";
import { useEffect, useImperativeHandle, useRef, useState, type Ref } from "react";
import { communityCreation, communityRename, type CommunityChatChange, type CommunityChats, type CommunityBannedMembers, type CommunityListUnban, type CommunityFolderChange, type CommunityFolderMemberships, type CommunityModerationCounts, type CommunityCreation, type CommunityDeletion, type CommunityRename, type CommunityRequestBatch, type CommunityRequestDecision, type CommunityRequests, type CommunitySourceChat, type CommunitySummary } from "../core/contract.ts";
import type { Chat } from "../core/demo.ts";
import type { ForwardTarget, ChatNotificationMode, ChatNotificationState, CommunityCollapseChange, CommunityNotificationChange, CommunityPermissionChange } from "../core/contract.ts";
import { ChatNotifications } from "./chat-notifications.tsx";
import { AvatarEditor } from "./avatar-editor.tsx";
import { Avatar, type AvatarLoader } from "./avatar.tsx";
import type { CommunityAvatarVideo, GlobalSearchPage, SaveAvatarResult } from "../core/contract.ts";
import { MediaPlayer } from "./media-player.tsx";
import { GlobalSearchResults, type GlobalSearchLoader, type LoadGlobalMediaThumbnail } from "./global-search.tsx";

export type CommunityActions = {
  list: () => Promise<CommunitySummary[] | null>;
  chats: (id: string) => Promise<CommunityChats | null>;
  forwardChats?: (id: string) => Promise<ForwardTarget[] | null>;
  folders?: {
    read: (id: string) => Promise<CommunityFolderMemberships | null>;
    change: (input: CommunityFolderChange) => Promise<"queued" | "changed" | "unavailable">;
  };
  unbanListedMember?: (input: CommunityListUnban) => Promise<"communityUnbanned" | "changed" | "unavailable">;
  bannedMembers?: (id: string, offset: number) => Promise<CommunityBannedMembers | null>;
  moderationCounts?: (id: string) => Promise<CommunityModerationCounts | null>;
  collapse?: (input: CommunityCollapseChange) => Promise<"saved" | "changed" | "unavailable">;
  candidates?: () => Promise<CommunitySourceChat[] | null>;
  create?: (input: CommunityCreation) => Promise<CommunitySummary | null>;
  rename?: (input: CommunityRename) => Promise<"saved" | "changed" | "unavailable">;
  remove?: (input: CommunityDeletion) => Promise<"deleted" | "changed" | "unavailable">;
  changePermissions?: (input: CommunityPermissionChange) => Promise<"saved" | "changed" | "unavailable">;
  photos?: {
    read: (id: string) => Promise<{ version: string | null; avatarJpeg?: string; avatarFileId?: number; hasAvatarVideo?: true } | null>;
    save: (id: string, expected: string | null, base64: string) => Promise<SaveAvatarResult>;
    saveVideo?: (id: string, expected: string | null, base64: string, coverSeconds: number,
      trim?: import("../core/contract.ts").AvatarVideoTrim) => Promise<SaveAvatarResult>;
    remove: (id: string, expected: string) => Promise<SaveAvatarResult>;
  };
  avatar?: AvatarLoader;
  avatarVideo?: { read: (id: string) => Promise<CommunityAvatarVideo | null>;
    stream: (id: string, video: CommunityAvatarVideo) => Promise<string> };
  notifications?: (id: string) => Promise<ChatNotificationState | null>;
  changeNotification?: (input: CommunityNotificationChange) => Promise<"saved" | "changed" | "unavailable">;
  changeChat?: (input: CommunityChatChange) => Promise<"saved" | "requested" | "changed" | "unavailable">;
  requests?: (id: string, offset: string) => Promise<CommunityRequests | null>;
  decideAll?: (input: CommunityRequestBatch) => Promise<"saved" | "changed" | "unavailable">;
  decide?: (input: CommunityRequestDecision) => Promise<"saved" | "changed" | "unavailable">;
};

function CommunityFolders({ id, actions }: { id: string; actions: NonNullable<CommunityActions["folders"]> }) {
  const { t: tr } = useTelegramLocale();
  const [expanded, setExpanded] = useState(false);
  return <>
    <button type="button" className="mtg-action" aria-expanded={expanded}
      onClick={() => setExpanded((open) => !open)}>{tr("Community folders")}</button>
    {expanded && <CommunityFolderList id={id} actions={actions} />}
  </>;
}

function CommunityFolderList({ id, actions }: { id: string; actions: NonNullable<CommunityActions["folders"]> }) {
  const { t: tr } = useTelegramLocale();
  const [data, setData] = useState<CommunityFolderMemberships | null>();
  const [busy, setBusy] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [status, setStatus] = useState("");
  useEffect(() => {
    let active = true;
    void actions.read(id).then((result) => { if (active) setData(result); }, () => { if (active) setData(null); });
    return () => { active = false; };
  }, [actions, id, refresh]);

  return <section aria-label={tr("Community folders")}>
    {data === undefined && <p role="status">{tr("Loading folders…")}</p>}
    {data === null && <p role="status">{tr("Community folder settings are unavailable. ")}<button type="button" className="mtg-action"
      onClick={() => { setData(undefined); setRefresh((value) => value + 1); }}>{tr("Retry")}</button></p>}
    {data && data.folders.length === 0 && <p>{tr("No Telegram folders.")}</p>}
    {data && !data.canAdd && !!data.folders.length && <p>{tr("Collapse the community chats to add the community to a folder.")}</p>}
    {data && !!data.folders.length && <ul>{data.folders.map((row) => <li key={row.id}>
      <label><input type="checkbox" checked={row.included} disabled={busy || (!row.included && !data.canAdd)}
        onChange={async (event) => {
          if (busy) return;
          const included = event.currentTarget.checked;
          setBusy(true);
          setStatus("");
          try {
            const result = await actions.change({ id, folder: row.id, expectedTitle: row.title, expectedIncluded: row.included, included });
            if (result === "queued") {
              setData((current) => current && ({ ...current, folders: current.folders.map((folder) =>
                folder.id === row.id ? { ...folder, included } : folder) }));
              setStatus("Folder change queued for Telegram sync.");
            } else if (result === "changed") {
              setStatus("The folder changed in Telegram. Review the updated list.");
              setData(undefined);
              setRefresh((value) => value + 1);
            } else {
              setStatus("Could not update this folder.");
            }
          } catch {
            setStatus("Could not update this folder.");
          } finally {
            setBusy(false);
          }
        }} /> <bdi>{row.title}</bdi></label>
    </li>)}</ul>}
    {status && <p role="status">{tr(status)}</p>}
  </section>;
}

function CommunityBans({ id, load, unban }: {
  id: string; load: NonNullable<CommunityActions["bannedMembers"]>; unban?: CommunityActions["unbanListedMember"];
}) {
  const { t: tr } = useTelegramLocale();
  const [expanded, setExpanded] = useState(false);
  return <>
    <button type="button" className="mtg-action" aria-expanded={expanded}
      onClick={() => setExpanded(!expanded)}>{expanded ? tr("Hide banned members") : tr("Show banned members")}</button>
    {expanded && <CommunityBanList id={id} load={load} unban={unban} />}
  </>;
}

function CommunityBanList({ id, load, unban }: {
  id: string; load: NonNullable<CommunityActions["bannedMembers"]>; unban?: CommunityActions["unbanListedMember"];
}) {
  const { locale: uiLocale, t: tr } = useTelegramLocale();
  type ListedMember = CommunityBannedMembers["members"][number] & { offset: number };
  const [members, setMembers] = useState<ListedMember[]>([]);
  const [canUnban, setCanUnban] = useState(false);
  const [review, setReview] = useState<ListedMember>();
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState("");
  const [next, setNext] = useState<number | null>(null);
  const [pending, setPending] = useState<number | null>(0);
  const [failure, setFailure] = useState<"unavailable" | number | null>(null);
  useEffect(() => {
    if (pending === null) return;
    let active = true;
    void load(id, pending).then((page) => {
      if (!active) return;
      setCanUnban(page?.canUnban === true);
      if (!page) {
        setMembers([]);
        setNext(null);
        setFailure("unavailable");
      } else {
        setMembers((current) => [...new Map([...current, ...page.members.map((member) => ({ ...member, offset: pending }))].map((row) =>
          [`${row.sender.kind}:${row.sender.id}`, row])).values()]);
        setNext(page.next);
      }
      setPending(null);
    }, () => {
      if (!active) return;
      setFailure(pending);
      setPending(null);
    });
    return () => { active = false; };
  }, [id, load, pending]);

  return <section aria-label={tr("Community banned members")}>
    {!!members.length && <ul>{members.map((member) =>
      <li key={`${member.sender.kind}:${member.sender.id}`}>
        <bdi>{member.name}</bdi>{member.sender.kind === "chat" && tr(" · Chat")} · {member.bannedUntil
          ? new Date(member.bannedUntil * 1000).toLocaleString(uiLocale)
          : tr("Permanent ban")}
        {canUnban && unban && <button type="button" className="mtg-action" disabled={saving || pending !== null || !!review}
          aria-label={tr("Unban {0}", [member.name])} onClick={() => { setReview(member); setStatus(""); }}>{tr("Unban")}</button>}
      </li>
    )}</ul>}
    {review && unban && <div role="group" aria-label={tr("Review community unban")}>
      <p>{tr("Remove the community ban for ")}<bdi>{review.name}</bdi>?</p>
      <button type="button" className="mtg-action" disabled={saving} onClick={async () => {
        if (saving) return;
        setSaving(true);
        const { sender, offset, bannedUntil } = review;
        try {
          const result = await unban({ id, sender, offset, bannedUntil });
          if (result !== "unavailable") {
            setMembers([]);
            setNext(null);
            setPending(0);
          }
          setStatus(result === "communityUnbanned" ? "Community ban removed."
            : result === "changed" ? "The ban list changed. Review the updated list." : "Could not remove the community ban.");
        } catch { setStatus("Could not remove the community ban."); }
        finally { setReview(undefined); setSaving(false); }
      }}>{tr("Confirm unban")}</button>
      <button type="button" className="mtg-action" disabled={saving} onClick={() => setReview(undefined)}>{tr("Cancel unban")}</button>
    </div>}
    {status && <p role="status">{tr(status)}</p>}
    {pending !== null && <p role="status">{tr("Loading banned members…")}</p>}
    {failure === "unavailable" && <p role="status">{tr("Community banned members are unavailable in this Telegram connection.")}</p>}
    {typeof failure === "number" && <p role="alert">{tr("Could not load banned members. ")}<button type="button" className="mtg-action"
      onClick={() => { setPending(failure); setFailure(null); }}>{tr("Retry")}</button></p>}
    {pending === null && failure === null && (next !== null
      ? <button type="button" className="mtg-action" disabled={saving || !!review} onClick={() => setPending(next)}>{tr("Load more banned members")}</button>
      : members.length === 0 && <p role="status">{tr("No banned members.")}</p>)}
  </section>;
}

function CommunityVideo({ community, actions }: {
  community: CommunitySummary; actions: NonNullable<CommunityActions["avatarVideo"]>;
}) {
  const { t: tr } = useTelegramLocale();
  const [open, setOpen] = useState(false);
  const [video, setVideo] = useState<CommunityAvatarVideo | null>();
  useEffect(() => {
    if (!open) return;
    let active = true;
    void actions.read(community.id).then((result) => {
      if (active) setVideo(result);
    }, () => { if (active) setVideo(null); });
    return () => { active = false; };
  }, [actions, community.id, open]);

  return <details onToggle={(event) => {
    if (!event.currentTarget.open) setVideo(undefined);
    setOpen(event.currentTarget.open);
  }}>
    <summary>{tr("Community video avatar")}</summary>
    {open && (video ? <MediaPlayer chatId={`community:${community.id}`} messageId={video.photoId} playbackFileId={video.fileId}
      mime="video/mp4" loop loadLabel="Play community video avatar"
      poster={community.avatarJpeg && `data:image/jpeg;base64,${community.avatarJpeg}`}
      posterSize={{ width: 320, height: 320 }} stream={() => actions.stream(community.id, video)} />
      : video === null ? <p role="status">{tr("Community video avatar unavailable.")}</p>
        : <p role="status">{tr("Loading community video avatar…")}</p>)}
  </details>;
}

export function CommunityLabel({ group, load }: { group: CommunitySummary; load?: AvatarLoader }) {
  const initials = group.name.split(/\s+/).slice(0, 2).map((word) => Array.from(word)[0]).join("").toUpperCase();
  return <span className="mtg-community-label">
    <Avatar chat={{ id: group.id, initials, color: "#246dbd", avatarFileId: group.avatarFileId, avatarJpeg: group.avatarJpeg }} load={load} />
    <bdi>{group.name}</bdi>
  </span>;
}

function CommunityPermissions({ id, current, save, updated, reload }: {
  id: string; current: boolean; save: NonNullable<CommunityActions["changePermissions"]>;
  updated: (value: boolean) => void; reload: () => void;
}) {
  const { t: tr } = useTelegramLocale();
  const [value, setValue] = useState(current);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<"saved" | "changed" | "failed">();
  return <form onSubmit={async (event) => {
    event.preventDefault();
    if (busy || value === current || status === "changed") return;
    setBusy(true);
    setStatus(undefined);
    try {
      const result = await save({ id, expected: current, canEditChats: value });
      if (result === "saved") { updated(value); setStatus("saved"); }
      else setStatus(result === "changed" ? "changed" : "failed");
    } catch { setStatus("failed"); }
    finally { setBusy(false); }
  }}>
    <fieldset disabled={busy || status === "changed"}>
      <legend>{tr("Member permissions")}</legend>
      <label><input type="checkbox" checked={value} onChange={(event) => setValue(event.currentTarget.checked)} />{tr("Allow members to edit the chat list")}</label>
      <button type="submit" className="mtg-action" disabled={value === current}>{tr("Save member permissions")}</button>
    </fieldset>
    {status === "saved" && <p role="status">{tr("Member permissions updated.")}</p>}
    {status === "changed" && <p role="alert">{tr("Permissions changed in Telegram. ")}<button type="button" className="mtg-action" onClick={reload}>{tr("Reload communities")}</button></p>}
    {status === "failed" && <p role="alert">{tr("Could not update member permissions.")}</p>}
  </form>;
}

function CommunityCollapse({ id, collapsed, save, updated, reload }: {
  id: string; collapsed: boolean; save: NonNullable<CommunityActions["collapse"]>;
  updated: (value: boolean) => void; reload: () => void;
}) {
  const { t: tr } = useTelegramLocale();
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function update() {
    if (busy || error) return;
    setBusy(true);
    setConfirm(false);
    try {
      const result = await save({ id, expected: collapsed, collapsed: !collapsed });
      if (result === "saved") updated(!collapsed);
      else setError(result === "changed" ? "The layout changed in Telegram." : "Could not change the community layout.");
    } catch { setError("Telegram did not confirm the layout change."); }
    finally { setBusy(false); }
  }
  return <section aria-label={tr("Community chat list layout")}>
    <button type="button" className="mtg-action" disabled={busy || confirm || !!error}
      onClick={() => collapsed ? setConfirm(true) : void update()}>
      {collapsed ? tr("Expand community chats") : tr("Collapse community chats")}
    </button>
    {confirm && <div role="group" aria-label={tr("Confirm expanding community chats")}>
      <p>{tr("Expanding the chats will remove this community from Telegram chat folders.")}</p>
      <button type="button" className="mtg-action" onClick={() => void update()}>{tr("Confirm expand chats")}</button>
      <button type="button" className="mtg-action" onClick={() => setConfirm(false)}>{tr("Cancel")}</button>
    </div>}
    {error && <p role="alert">{tr(error)} <button type="button" className="mtg-action" onClick={reload}>{tr("Reload communities")}</button></p>}
  </section>;
}

function CommunityNotifications({ id, notifications, change }: {
  id: string; notifications: NonNullable<CommunityActions["notifications"]>; change: NonNullable<CommunityActions["changeNotification"]>;
}) {
  const expected = useRef<ChatNotificationMode | undefined>(undefined);
  return <ChatNotifications id={id} community chatNotificationState={async (id) => {
    const settings = await notifications(id);
    expected.current = settings?.mode;
    return settings;
  }} setChatNotificationMode={async (id, mode, muteFor) => {
    if (!expected.current) return "refused";
    const result = await change({ id, mode, muteFor, expected: expected.current });
    return result === "saved" ? "updated" : "refused";
  }} />;
}

function CommunityDelete({ group, remove, deleted, reload }: {
  group: CommunitySummary; remove: NonNullable<CommunityActions["remove"]>; deleted: () => void; reload: () => void;
}) {
  const { t: tr } = useTelegramLocale();
  const [review, setReview] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return <section aria-label={tr("Delete community")}>
    <button type="button" className="mtg-action" disabled={review || busy || !!error}
      onClick={() => setReview(true)}>{tr("Delete community")}</button>
    {review && <div role="group" aria-label={tr("Confirm community deletion")}>
      <p>{tr("Permanently delete ")}<bdi>{group.name}</bdi>?</p>
      <button type="button" className="mtg-action" onClick={async () => {
        if (busy) return;
        setBusy(true);
        setReview(false);
        try {
          const result = await remove({ id: group.id, expected: group.name });
          if (result === "deleted") deleted();
          else setError(result === "changed" ? "The community changed in Telegram." : "Could not delete the community.");
        } catch { setError("Telegram did not confirm the deletion."); }
        finally { setBusy(false); }
      }}>{tr("Confirm delete community")}</button>
      <button type="button" className="mtg-action" onClick={() => setReview(false)}>{tr("Cancel deletion")}</button>
    </div>}
    {error && <p role="alert">{tr(error)} <button type="button" className="mtg-action" onClick={reload}>{tr("Reload communities")}</button></p>}
  </section>;
}

function CommunityRequestQueue({ id, requests, decide, decideAll, refresh }: {
  id: string; requests: NonNullable<CommunityActions["requests"]>; decide?: CommunityActions["decide"]; decideAll?: CommunityActions["decideAll"];
  refresh: () => void;
}) {
  const { locale: uiLocale, t: tr } = useTelegramLocale();
  const [page, setPage] = useState<CommunityRequests | null>();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [review, setReview] = useState<{ input: CommunityRequestDecision; title: string }>();
  const [batch, setBatch] = useState<CommunityRequestBatch>();

  async function load(offset: string) {
    setError("");
    try {
      const next = await requests(id, offset);
      setPage((current) => next && offset && current ? {
        ...next, requests: [...current.requests, ...next.requests.filter((row) => !current.requests.some(({ chat }) => chat === row.chat))],
      } : next);
    } catch { setError("Could not load pending requests."); }
  }

  async function fetch(offset: string) {
    if (busy) return;
    setBusy(true);
    try { await load(offset); }
    finally { setBusy(false); }
  }

  function reviewAll(approve: boolean) {
    if (!decideAll || !page || page.next !== null || !page.requests.length || page.requests.length > 500 || busy || review || batch) return;
    setBatch({ id, approve, expected: page.requests.map(({ chat, sender, date, hidden }) => ({ chat, sender, date, hidden })) });
  }

  async function applyBatch() {
    if (!batch || !decideAll || busy) return;
    setBusy(true);
    setBatch(undefined);
    setNotice("");
    setError("");
    try {
      const result = await decideAll(batch);
      if (result === "unavailable") setError("Could not process these requests.");
      else {
        setNotice(result === "changed" ? "The pending requests changed in Telegram. Review the updated queue."
          : batch.approve ? "Pending requests approved." : "Pending requests declined.");
        await load("");
        if (result === "saved" && batch.approve) refresh();
      }
    } catch { setError("Telegram did not confirm the decision. Reload pending requests before retrying."); }
    finally { setBusy(false); }
  }

  return <section aria-label={tr("Pending community chat requests")}>
    {page === undefined && <button type="button" className="mtg-action" disabled={busy} onClick={() => void fetch("")}>
      {decide ? tr("Show pending requests") : tr("Show my pending requests")}
    </button>}
    {page === null && <p>{tr("Pending requests are unavailable.")}</p>}
    {page?.requests.length === 0 && page.next === null && <p>{tr("No pending requests.")}</p>}
    {!!page?.requests.length && <ul aria-label={tr("Pending requests")}>{page.requests.map(({ title, requester, ...row }) => <li key={row.chat}>
      <bdi>{title}</bdi> · <bdi>{requester}</bdi>{row.hidden && tr(" · Administrators only")}
      <time dateTime={new Date(row.date * 1000).toISOString()}> · {new Date(row.date * 1000).toLocaleDateString(uiLocale)}</time>
      {decide && <div>
        {([true, false] as const).map((approve) => <button type="button" key={String(approve)} className="mtg-action"
          disabled={busy || !!review || !!batch} aria-label={`${approve ? "Approve" : "Decline"} ${title}`}
          onClick={() => setReview({ input: { ...row, id, approve }, title })}>{approve ? tr("Approve") : tr("Decline")}</button>)}
      </div>}
    </li>)}</ul>}
    {review && decide && <div role="group" aria-label={tr("Confirm community request decision")}>
      <p>{review.input.approve ? tr("Approve") : tr("Decline")}{tr(" the request for ")}<bdi>{review.title}</bdi>?</p>
      <button type="button" className="mtg-action" disabled={busy} onClick={async () => {
        if (busy) return;
        setBusy(true);
        setReview(undefined);
        setError("");
        setNotice("");
        try {
          const result = await decide(review.input);
          if (result === "unavailable") setError("Could not process the request.");
          else {
            setNotice(result === "changed" ? "The request changed in Telegram." : review.input.approve ? "Request approved." : "Request declined.");
            await load("");
            if (result === "saved" && review.input.approve) refresh();
          }
        } catch { setError("Telegram did not confirm the decision. Reload pending requests before retrying."); }
        finally { setBusy(false); }
      }}>{review.input.approve ? tr("Confirm approval") : tr("Confirm decline")}</button>
      <button type="button" className="mtg-action" onClick={() => setReview(undefined)}>{tr("Cancel review")}</button>
    </div>}
    {decideAll && page?.next === null && page.requests.length > 1 && page.requests.length <= 500 && !batch && <div>
      <button type="button" className="mtg-action" disabled={busy || !!review} onClick={() => reviewAll(true)}>{tr("Approve all pending requests")}</button>
      <button type="button" className="mtg-action" disabled={busy || !!review} onClick={() => reviewAll(false)}>{tr("Decline all pending requests")}</button>
    </div>}
    {batch && <div role="group" aria-label={tr("Confirm community batch decision")}>
      <p>{batch.approve ? tr("Approve") : tr("Decline")}{tr(" all ")}{batch.expected.length}{tr(" reviewed requests?")}</p>
      <button type="button" className="mtg-action" disabled={busy} onClick={() => void applyBatch()}>
        {batch.approve ? tr("Confirm approval of all requests") : tr("Confirm decline of all requests")}
      </button>
      <button type="button" className="mtg-action" onClick={() => setBatch(undefined)}>{tr("Cancel batch review")}</button>
    </div>}
    {page?.next && <button type="button" className="mtg-action" disabled={busy || !!review || !!batch}
      onClick={() => void fetch(page.next!)}>{tr("Load more requests")}</button>}
    {notice && <p role="status">{tr(notice)}</p>}
    {!decide && page && <button type="button" className="mtg-action" disabled={busy} onClick={() => void fetch("")}>{tr("Refresh pending requests")}</button>}
    {error && <p role="alert">{tr(error)} <button type="button" className="mtg-action" disabled={busy || !!review || !!batch}
      onClick={() => void fetch("")}>{tr("Reload requests")}</button></p>}
  </section>;
}

function CommunityMembership({ group, chats, candidates, changeChat, refresh }: {
  group: CommunitySummary; chats: CommunityChats; candidates?: CommunityActions["candidates"];
  changeChat: NonNullable<CommunityActions["changeChat"]>; refresh: () => void;
}) {
  const { t: tr } = useTelegramLocale();
  const [available, setAvailable] = useState<CommunitySourceChat[]>();
  const [chat, setChat] = useState("");
  const [hidden, setHidden] = useState(false);
  const [review, setReview] = useState<{ input: CommunityChatChange; title: string }>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const source = available?.find(({ id }) => id === chat);
  const canAddDirectly = group.canManageChats || group.membersCanEditChats;
  const removable = group.canManageChats ? chats : chats.filter(({ canRemove }) => canRemove);
  return <section aria-label={canAddDirectly || removable.length ? tr("Manage community chats") : tr("Suggest a community chat")}>
    {candidates && !available && <button type="button" className="mtg-action" disabled={busy || !!review} onClick={async () => {
      if (busy) return;
      setBusy(true);
      setError("");
      try { setAvailable((await candidates() ?? []).filter(({ id }) => !chats.some((member) => member.id === id))); }
      catch { setError("Could not load eligible chats."); }
      finally { setBusy(false); }
    }}>{canAddDirectly ? tr("Find a chat to add") : tr("Find a chat to suggest")}</button>}
    {available?.length === 0 && <p>{tr("No eligible chats to add.")}</p>}
    {!!available?.length && <fieldset disabled={busy || !!review}>
      <label>{tr("Chat to add ")}<select value={chat} onChange={(event) => setChat(event.currentTarget.value)}>
        <option value="">{tr("Select a chat")}</option>
        {available.map(({ id, title, bot }) => <option key={id} value={id}>{title}{bot ? tr(" · Bot") : ""}</option>)}
      </select></label>
      <label><input type="checkbox" checked={hidden} onChange={(event) => setHidden(event.currentTarget.checked)} />{tr(" Show new chat to administrators only")}</label>
      <button type="button" className="mtg-action" disabled={!source} onClick={() => source && setReview({
        title: source.title, input: { action: "add", id: group.id, chat: source.id, hidden, expectedTitle: source.title },
      })}>{canAddDirectly ? tr("Review adding chat") : tr("Review chat suggestion")}</button>
    </fieldset>}
    {removable.length > 0 && <ul aria-label={tr("Chats you can remove")}>{removable.map(({ id, title, hidden: expectedHidden }) => <li key={id}>
      <button type="button" className="mtg-action" disabled={busy || !!review}
        onClick={() => setReview({ title, input: { action: "remove", id: group.id, chat: id, expectedHidden, expectedTitle: title } })}>{tr("Remove ")}<bdi>{title}</bdi>
      </button>
    </li>)}</ul>}
    {review && <div role="group" aria-label={tr("Confirm community chat change")}>
      <p>{review.input.action === "add" ? canAddDirectly ? tr("Add") : tr("Suggest") : tr("Remove")} <bdi>{review.title}</bdi>?</p>
      {review.input.action === "remove" && <p>{tr("Members who belong only to this chat will also leave the community.")}</p>}
      <button type="button" className="mtg-action" disabled={busy} onClick={async () => {
        if (busy) return;
        setBusy(true);
        setError("");
        setNotice("");
        setReview(undefined);
        try {
          const result = await changeChat(review.input);
          if (result === "saved") refresh();
          else if (result === "requested") {
            setNotice("Chat request sent to the community administrators.");
            setAvailable((current) => current?.filter(({ id }) => id !== review.input.chat));
            setChat("");
          }
          else setError(result === "changed" ? "The chat list changed in Telegram. Reload before trying again." : "Could not update the chat list.");
        } catch { setError("Telegram did not confirm the change. Reload before trying again."); }
        finally { setBusy(false); }
      }}>{review.input.action === "add" ? canAddDirectly ? tr("Confirm add chat") : tr("Send chat suggestion") : tr("Confirm remove chat")}</button>
      <button type="button" className="mtg-action" onClick={() => setReview(undefined)}>{tr("Cancel review")}</button>
    </div>}
    {error && <p role="alert">{tr(error)} <button type="button" className="mtg-action" onClick={refresh}>{tr("Reload chats")}</button></p>}
    {notice && <p role="status">{tr(notice)}</p>}
  </section>;
}

function CommunityName({ group, rename, updated, reload }: {
  group: CommunitySummary; rename: NonNullable<CommunityActions["rename"]>;
  updated: (name: string) => void; reload: () => void;
}) {
  const { t: tr } = useTelegramLocale();
  const [name, setName] = useState(group.name);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<"changed" | "failed">();
  const input = communityRename.safeParse({ id: group.id, name, expected: group.name });
  return <form onSubmit={async (event) => {
    event.preventDefault();
    if (busy || status === "changed" || !input.success || input.data.name === group.name) return;
    setBusy(true);
    setStatus(undefined);
    try {
      const outcome = await rename(input.data);
      if (outcome === "saved") updated(input.data.name);
      else setStatus(outcome === "changed" ? "changed" : "failed");
    } catch { setStatus("failed"); }
    finally { setBusy(false); }
  }}>
    <label>{tr("Community name ")}<input value={name} maxLength={128} disabled={busy || status === "changed"}
      onChange={(event) => setName(event.target.value)} /></label>
    <button type="submit" className="mtg-action" disabled={busy || status === "changed" || !input.success || input.data.name === group.name}>{tr("Save name")}</button>
    {status === "changed" && <p role="alert">{tr("The name changed in Telegram. ")}<button type="button" className="mtg-action" onClick={reload}>{tr("Reload communities")}</button></p>}
    {status === "failed" && <p role="alert">{tr("Could not rename this community.")}</p>}
  </form>;
}

function CommunityCreate({ actions, created }: {
  actions: Required<Pick<CommunityActions, "candidates" | "create">>; created: (group: CommunitySummary) => void;
}) {
  const { t: tr } = useTelegramLocale();
  const active = useRef(false);
  const [sources, setSources] = useState<CommunitySourceChat[] | null>();
  const [name, setName] = useState("");
  const [id, setId] = useState("");
  const [hidden, setHidden] = useState(false);
  const [review, setReview] = useState<CommunityCreation>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const { candidates, create } = actions;
  useEffect(() => {
    let current = true;
    active.current = true;
    void candidates().then(
      (rows) => { if (current) setSources(rows); },
      () => { if (current) setError("Could not load eligible chats."); },
    );
    return () => { current = false; active.current = false; };
  }, [candidates]);
  const selected = sources?.find((chat) => chat.id === id);
  return <section aria-label={tr("Create community")}>
    {sources === undefined && !error && <p role="status">{tr("Loading eligible chats…")}</p>}
    {sources === null && <p>{tr("Community creation is unavailable.")}</p>}
    {sources?.length === 0 && <p>{tr("No eligible chats owned by this account.")}</p>}
    {!!sources?.length && <form onSubmit={(event) => {
      event.preventDefault();
      if (!selected || review || busy) return;
      const input = communityCreation.safeParse({ id, name, hidden, expectedTitle: selected.title });
      if (input.success) { setError(""); setReview(input.data); }
    }}>
      <fieldset disabled={!!review || busy}>
        <label>{tr("Community name ")}<input value={name} maxLength={128} onChange={(event) => setName(event.currentTarget.value)} /></label>
        <label>{tr("First chat ")}<select value={id} onChange={(event) => setId(event.currentTarget.value)}>
          <option value="">{tr("Select a chat")}</option>
          {sources.map((source) => <option key={source.id} value={source.id}>{source.title}{source.bot ? tr(" · Bot") : ""}</option>)}
        </select></label>
        <label><input type="checkbox" checked={hidden} onChange={(event) => setHidden(event.currentTarget.checked)} />{tr(" Show chat to administrators only")}</label>
        <button type="submit" className="mtg-action" disabled={!selected || !name.trim()}>{tr("Review community")}</button>
      </fieldset>
      {review && <div role="group" aria-label={tr("Confirm community creation")}>
        <p>{tr("Create ")}<bdi>{review.name}</bdi>{tr(" with ")}<bdi>{review.expectedTitle}</bdi>?</p>
        <button type="button" className="mtg-action" disabled={busy} onClick={async () => {
          if (busy) return;
          setBusy(true);
          setReview(undefined);
          setError("");
          try {
            const result = await create(review);
            if (!active.current) return;
            if (result) created(result);
            else setError("Could not create the community. Check that the chat is still eligible.");
          } catch { if (active.current) setError("Telegram did not confirm creation. Check the communities list before retrying."); }
          finally { if (active.current) setBusy(false); }
        }}>{tr("Create community")}</button>
        <button type="button" className="mtg-action" onClick={() => setReview(undefined)}>{tr("Cancel review")}</button>
      </div>}
    </form>}
    {error && <p role="alert">{tr(error)}</p>}
  </section>;
}

export type CommunityBrowserController = { open: (group: CommunitySummary) => void };

type OpenCommunityMessage = (hit: GlobalSearchPage["hits"][number], query: string) => void;

function CommunitySearch({ id, search, loadThumbnail, openMessage }: {
  id: string; search: GlobalSearchLoader; loadThumbnail?: LoadGlobalMediaThumbnail; openMessage: OpenCommunityMessage;
}) {
  const { t: tr } = useTelegramLocale();
  const [expanded, setExpanded] = useState(false);
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<"messages" | "media">("messages");
  return <details onToggle={(event) => setExpanded(event.currentTarget.open)}>
    <summary>{tr("Search community messages")}</summary>
    {expanded && <>
      <label>{tr("Find in this community ")}<input type="search" value={query} maxLength={128}
        onChange={(event) => setQuery(event.currentTarget.value)} /></label>
      <label>{tr("Look for ")}<select value={mode} onChange={(event) => setMode(event.currentTarget.value === "media" ? "media" : "messages")}>
        <option value="messages">{tr("Messages")}</option>
        <option value="media">{tr("Media")}</option>
      </select></label>
      <GlobalSearchResults communityId={id} mode={mode} query={query.trim()} search={search} loadThumbnail={loadThumbnail}
        open={(hit) => openMessage(hit, query.trim())} />
    </>}
  </details>;
}

export function CommunityBrowser({ actions, loadChat, openChat, search, loadSearchThumbnail, openMessage, controller, changeRevision = 0 }: {
  actions: CommunityActions; loadChat: (id: string) => Promise<Chat | null>; openChat: (chat: Chat) => void;
  search?: GlobalSearchLoader; loadSearchThumbnail?: LoadGlobalMediaThumbnail; openMessage?: OpenCommunityMessage;
  changeRevision?: number;
  controller?: Ref<CommunityBrowserController>;
}) {
  const { t: tr } = useTelegramLocale();
  const dialog = useRef<HTMLDialogElement>(null);
  const revision = useRef(0);
  const [groups, setGroups] = useState<CommunitySummary[] | null>();
  const [selected, setSelected] = useState<CommunitySummary>();
  const [chats, setChats] = useState<CommunityChats | null>();
  const [moderationCounts, setModerationCounts] = useState<CommunityModerationCounts | null>();
  const [busy, setBusy] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");
  const seenChange = useRef(changeRevision);
  const selectedId = selected?.id;

  function reset() {
    revision.current++;
    setSelected(undefined);
    setChats(undefined);
    setModerationCounts(undefined);
    setBusy(false);
    setCreating(false);
    setError("");
  }

  useEffect(() => {
    if (seenChange.current === changeRevision) return;
    if (!dialog.current?.open) {
      seenChange.current = changeRevision;
      return;
    }
    if (busy || creating) return;
    seenChange.current = changeRevision;
    const version = revision.current;
    let active = true;
    const current = () => active && revision.current === version && dialog.current?.open;
    void Promise.all([
      actions.list().catch(() => null),
      selectedId ? actions.chats(selectedId).catch(() => null) : undefined,
      selectedId ? actions.moderationCounts?.(selectedId).catch(() => undefined) : undefined,
    ]).then(([groups, members, counts]) => {
      if (!current()) return;
      if (groups) {
        setGroups(groups);
        if (selectedId) {
          const group = groups.find(({ id }) => id === selectedId);
          if (!group) {
            reset();
            return;
          }
          setSelected(group);
        }
      }
      if (members) setChats(members);
      if (counts !== undefined) setModerationCounts(counts);
    });
    return () => { active = false; };
  }, [actions, busy, changeRevision, creating, selectedId]);

  async function fetchList() {
    const version = ++revision.current;
    setGroups(undefined);
    setError("");
    setBusy(true);
    try {
      const result = await actions.list();
      if (revision.current === version) setGroups(result);
    } catch { if (revision.current === version) setError("Could not load communities."); }
    finally { if (revision.current === version) setBusy(false); }
  }

  async function select(group: CommunitySummary) {
    const version = ++revision.current;
    setSelected(group);
    setChats(undefined);
    setModerationCounts(undefined);
    void actions.moderationCounts?.(group.id).then(
      (result) => { if (revision.current === version) setModerationCounts(result); },
      () => { if (revision.current === version) setModerationCounts(null); },
    );
    setError("");
    setBusy(true);
    try {
      const result = await actions.chats(group.id);
      if (revision.current === version) setChats(result);
    } catch { if (revision.current === version) setError("Could not load community chats."); }
    finally { if (revision.current === version) setBusy(false); }
  }

  async function open(id: string) {
    if (busy) return;
    const version = revision.current;
    setError("");
    setBusy(true);
    try {
      const chat = await loadChat(id);
      if (revision.current !== version || !dialog.current?.open) return;
      if (!chat || chat.id !== id) throw new Error("Chat unavailable.");
      reset();
      dialog.current?.close();
      openChat(chat);
    } catch { if (revision.current === version) setError("Could not open this chat."); }
    finally { if (revision.current === version) setBusy(false); }
  }

  useImperativeHandle(controller, () => ({ open: (group) => {
    if (!dialog.current?.open) dialog.current?.showModal();
    void select(group);
  } }));
  const viewRevision = revision.current;
  return <>
    <button type="button" aria-haspopup="dialog" onClick={() => { dialog.current?.showModal(); void fetchList(); }}>
      <UsersRound size={20} aria-hidden="true" />{tr(" Communities")}</button>
    <dialog ref={dialog} className="mtg-agent-settings mtg-chat-details" aria-label={tr("Telegram communities")} onClose={reset}
      onCancel={(event) => { event.preventDefault(); reset(); dialog.current?.close(); }}>
      <h2>{selected ? <CommunityLabel group={selected} load={actions.avatar} /> : tr("Telegram communities")}</h2>
      {selected && <button type="button" className="mtg-action" onClick={() => {
        reset();
        if (groups === undefined) void fetchList();
      }}>{tr("Back to communities")}</button>}
      <button type="button" className="mtg-action" onClick={() => { reset(); dialog.current?.close(); }}>{tr("Close communities")}</button>
      {selected && actions.notifications && actions.changeNotification && <CommunityNotifications key={`community-notifications:${selected.id}`}
        id={selected.id} notifications={actions.notifications} change={actions.changeNotification} />}
      {selected?.collapsed !== undefined && actions.collapse
        && <CommunityCollapse key={`community-collapse:${selected.id}`} id={selected.id} collapsed={selected.collapsed} save={actions.collapse}
          reload={() => { reset(); void fetchList(); }} updated={(collapsed) => {
            const update = (group: CommunitySummary) => group.id === selected.id ? { ...group, collapsed } : group;
            setSelected((current) => current && update(current));
            setGroups((current) => current?.map(update) ?? current);
          }} />}
      {selected?.canEditMemberPermissions && selected.membersCanEditChats !== undefined && actions.changePermissions
        && <CommunityPermissions key={`community-permissions:${selected.id}`} id={selected.id} current={selected.membersCanEditChats} save={actions.changePermissions}
          reload={() => { reset(); void fetchList(); }} updated={(membersCanEditChats) => {
            const update = (group: CommunitySummary) => group.id === selected.id ? { ...group, membersCanEditChats } : group;
            setSelected((current) => current && update(current));
            setGroups((current) => current?.map(update) ?? current);
          }} />}
      {selected?.canRename && actions.rename && <CommunityName key={`${selected.id}:${selected.name}`}
        group={selected} rename={actions.rename} reload={() => { reset(); void fetchList(); }} updated={(name) => {
          setSelected((current) => current?.id === selected.id ? { ...current, name } : current);
          setGroups((current) => current?.map((group) => group.id === selected.id ? { ...group, name } : group) ?? current);
        }} />}
      {selected?.hasAvatarVideo && actions.avatarVideo &&
        <CommunityVideo key={JSON.stringify([selected.id, selected.avatarFileId, selected.photoVersion])}
          community={selected} actions={actions.avatarVideo} />}
      {selected?.canRename && selected.photoVersion !== undefined && actions.photos
        && <AvatarEditor key={`photo:${selected.id}`} label="community photo" version={selected.photoVersion}
          canRemove={selected.photoVersion !== null}
          save={(base64, expected) => actions.photos!.save(selected.id, expected, base64)}
          saveVideo={actions.photos.saveVideo && ((base64, expected, coverSeconds, trim) =>
            actions.photos!.saveVideo!(selected.id, expected, base64, coverSeconds, trim))}
          remove={(expected) => actions.photos!.remove(selected.id, expected)}
          reload={async () => {
            const state = await actions.photos!.read(selected.id);
            if (state) {
              const update = (group: CommunitySummary) => group.id === selected.id ? { ...group,
                photoVersion: state.version, avatarJpeg: state.avatarJpeg, avatarFileId: state.avatarFileId,
                hasAvatarVideo: state.hasAvatarVideo } : group;
              setSelected((current) => current && update(current));
              setGroups((current) => current?.map(update) ?? current);
            }
            return { version: state?.version, canRemove: !!state?.version };
          }} />}
      {creating && actions.candidates && actions.create
        && <><button type="button" className="mtg-action" onClick={() => setCreating(false)}>{tr("Back to communities")}</button>
          <CommunityCreate actions={{ candidates: actions.candidates, create: actions.create }} created={(group) => {
          setCreating(false);
          setGroups((current) => [...(current ?? []).filter(({ id }) => id !== group.id), group]);
          void select(group);
        }} /></>}
      {!creating && !selected && groups && actions.candidates && actions.create &&
        <button type="button" className="mtg-action" onClick={() => setCreating(true)}>{tr("New community")}</button>}
      {busy && <p role="status">{tr("Loading…")}</p>}
      {error && <p role="alert">{tr(error)} <button type="button" className="mtg-action"
        onClick={() => selected ? void select(selected) : void fetchList()}>{tr("Retry")}</button></p>}
      {!selected && groups === null && <p>{tr("Communities are unavailable in this Telegram connection.")}</p>}
      {!creating && !selected && groups?.length === 0 && <p>{tr("No joined communities.")}</p>}
      {!creating && !selected && !!groups?.length && <ul aria-label={tr("Joined communities")}>{groups.map((group) => <li key={group.id}>
        <button type="button" className="mtg-action" onClick={() => void select(group)}><CommunityLabel group={group} load={actions.avatar} /></button>
      </li>)}</ul>}
      {selected && actions.folders && <CommunityFolders key={`folders:${selected.id}:${selected.collapsed}`}
        id={selected.id} actions={actions.folders} />}
      {selected && moderationCounts && <dl aria-label={tr("Community moderation")}>
        <dt>{tr("Administrators")}</dt><dd>{moderationCounts.administrators}</dd>
        <dt>{tr("Banned users")}</dt><dd>{moderationCounts.banned}</dd>
        <dt>{tr("Pending chat requests")}</dt><dd>{moderationCounts.chatRequests}</dd>
      </dl>}
      {selected && moderationCounts && actions.bannedMembers &&
        <CommunityBans key={`community-bans:${selected.id}`} id={selected.id} load={actions.bannedMembers} unban={actions.unbanListedMember} />}
      {selected && chats === null && <p>{tr("This community is unavailable.")}</p>}
      {selected && chats?.length === 0 && <p>{tr("No community chats available.")}</p>}
      {selected && !!chats?.length && <ul aria-label={tr("Community chats")}>{chats.map(({ id, title, canView, hidden }) => <li key={id}>
        {canView ? <button type="button" className="mtg-action" disabled={busy} onClick={() => void open(id)}><bdi>{title}</bdi></button>
          : <><bdi>{title}</bdi>{tr(" · History unavailable")}</>}
        {hidden && tr(" · Hidden")}
      </li>)}</ul>}
      {selected && search && openMessage && <CommunitySearch key={`community-search:${selected.id}`} id={selected.id} search={search}
        loadThumbnail={loadSearchThumbnail} openMessage={(hit, query) => {
          reset();
          dialog.current?.close();
          openMessage(hit, query);
        }} />}
      {selected && chats && (selected.canManageChats || selected.canRequestChats || chats.some(({ canRemove }) => canRemove))
        && actions.changeChat && <CommunityMembership key={`community-membership:${selected.id}`} group={selected}
        chats={chats} candidates={selected.canManageChats || selected.canRequestChats ? actions.candidates : undefined} changeChat={actions.changeChat} refresh={() => {
          if (dialog.current?.open && revision.current === viewRevision) void select(selected);
        }} />}
      {selected && (selected.canManageChats || selected.canRequestChats) && actions.requests && <CommunityRequestQueue key={`requests:${selected.id}`}
        id={selected.id} requests={actions.requests} decide={selected.canManageChats ? actions.decide : undefined}
        decideAll={selected.canManageChats ? actions.decideAll : undefined} refresh={() => {
          if (dialog.current?.open && revision.current === viewRevision) void select(selected);
        }} />}
      {selected?.canDelete && actions.remove && <CommunityDelete key={`delete:${selected.id}:${selected.name}`}
        group={selected} remove={actions.remove} reload={() => { reset(); void fetchList(); }} deleted={() => {
          setGroups((current) => current?.filter(({ id }) => id !== selected.id) ?? current);
          if (dialog.current?.open && revision.current === viewRevision) reset();
        }} />}
    </dialog>
  </>;
}
