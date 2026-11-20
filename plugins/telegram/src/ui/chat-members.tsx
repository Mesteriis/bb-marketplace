import { useTelegramLocale } from "./i18n/index.tsx";
import { useEffect, useRef, useState } from "react";
import { administratorRightLabels, chatMemberFilter, groupPermissionLabels, type AdministratorRight, type ChatMemberAction, type ChatMemberFilter, type CommunityBanChange, type CommunityUnbanPreview, type CommunityUnbanTarget, type CommunityBanImpact, type EditableMemberRestriction, type ChatMemberPage, type GroupPermission, type GroupPermissionsView, type MemberBanDuration } from "../core/contract.ts";

export type SetChatMemberTag = (chatId: string, userId: string, expected: string, tag: string) => Promise<"tagSaved" | "changed" | "unavailable">;
export type ChatMemberLoader = (id: string, query: string, offset?: number, filter?: ChatMemberFilter) => Promise<ChatMemberPage | null>;
export type BanChatMember = (chatId: string, userId: string, role: "member" | "restricted", duration: MemberBanDuration) => Promise<"banned" | "changed" | "unavailable">;
export type ModerateChatMember = (input: ChatMemberAction) => Promise<"removed" | "messagesDeleted" | "changed" | "unavailable">;
export type SaveChatAdministrator = (chatId: string, userId: string, available: AdministratorRight[], selected: AdministratorRight[], expected?: AdministratorRight[])
  => Promise<"administratorSaved" | "changed" | "unavailable">;
export type DemoteChatAdministrator = (chatId: string, userId: string) => Promise<"demoted" | "changed" | "unavailable">;
export type RestrictChatMember = (chatId: string, userId: string, duration: MemberBanDuration | undefined,
  expected: GroupPermissionsView["values"], denied: GroupPermission[], previous?: EditableMemberRestriction) => Promise<"restricted" | "changed" | "unavailable">;
export type LiftChatMemberRestrictions = (chatId: string, userId: string, until: number, isMember: boolean) => Promise<"lifted" | "changed" | "unavailable">;
export type UnbanChatMember = (chatId: string, memberId: string, bannedUntil: number) => Promise<"unbanned" | "changed" | "unavailable">;
export type CommunityModeration = {
  previewUnban?: (id: string, memberId: string, bannedUntil: number) => Promise<CommunityUnbanPreview | null>;
  unban?: (change: CommunityUnbanTarget) => Promise<"communityUnbanned" | "changed" | "unavailable">;
  preview: (id: string, userId: string) => Promise<CommunityBanImpact | null>;
  ban: (change: CommunityBanChange) => Promise<"communityBanned" | "changed" | "unavailable">;
};
const banDurations = [[0, "Indefinitely"], [86400, "1 day"], [604800, "1 week"], [2592000, "30 days"]] as const;
const roles = { owner: "Owner", admin: "Administrator", member: "Member", restricted: "Restricted", banned: "Banned" } as const;
type MemberReview = { id: string; action: "demote" | "liftRestrictions" | "ban" | "unban" }
  | { id: string; action: ChatMemberAction["action"]; joinedAt: number; role: ChatMemberAction["role"] };

export function ChatMembers({ chatId, load, ban, unban, moderate, setTag, saveAdministrator, demote, restrict, liftRestrictions, communityModeration, channel = false }: {
  chatId: string; load: ChatMemberLoader; communityModeration?: CommunityModeration; ban?: BanChatMember; unban?: UnbanChatMember;
  moderate?: ModerateChatMember;
  setTag?: SetChatMemberTag; saveAdministrator?: SaveChatAdministrator; demote?: DemoteChatAdministrator; restrict?: RestrictChatMember; liftRestrictions?: LiftChatMemberRestrictions; channel?: boolean;
}) {
  const { locale: uiLocale, t: tr } = useTelegramLocale();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [request, setRequest] = useState<{ query: string; offset: number; filter?: ChatMemberFilter }>({ query: "", offset: 0 });
  const [page, setPage] = useState<ChatMemberPage | null>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [communityUnban, setCommunityUnban] = useState<{ memberId: string; bannedUntil: number; target: CommunityUnbanPreview }>();
  const [communityReview, setCommunityReview] = useState<{ userId: string; impact: CommunityBanImpact }>();
  const [communityLoading, setCommunityLoading] = useState(false);
  const communityPreviewGeneration = useRef(0);
  const [confirmMember, setConfirmMember] = useState<MemberReview>();
  const [restrictionForm, setRestrictionForm] = useState<{ id: string; expected: GroupPermissionsView["values"]; denied: GroupPermission[]; previous?: EditableMemberRestriction }>();
  const [administratorForm, setAdministratorForm] = useState<{ id: string; available: AdministratorRight[]; selected: AdministratorRight[]; expected?: AdministratorRight[] }>();
  const [tagForm, setTagForm] = useState<{ id: string; expected: string; value: string }>();
  const [savingModeration, setSavingModeration] = useState(false);
  const [duration, setDuration] = useState<MemberBanDuration | undefined>(0);
  const [feedback, setFeedback] = useState("");

  async function applyModeration(action: () => Promise<"removed" | "messagesDeleted" | "banned" | "communityBanned" | "communityUnbanned" | "unbanned" | "lifted" | "restricted" | "demoted" | "administratorSaved" | "tagSaved" | "changed" | "unavailable">) {
    if (savingModeration) return;
    setSavingModeration(true);
    setFeedback("");
    try {
      const result = await action();
      setFeedback(result === "communityUnbanned" ? "Telegram confirmed the community unban." : result === "communityBanned" ? "Member banned from the community." : result === "banned" ? "Member banned." : result === "unbanned" ? "Ban lifted."
        : result === "removed" ? "Member removed." : result === "messagesDeleted" ? "Member messages deleted."
        : result === "lifted" ? "Restrictions lifted." : result === "restricted" ? "Member restrictions saved."
        : result === "demoted" ? "Administrator rights removed." : result === "administratorSaved" ? "Administrator rights saved."
        : result === "tagSaved" ? "Member tag saved." : result === "changed" ? "Member status or group permissions changed. The list has been refreshed." : "Telegram could not change member permissions.");
    } catch {
      setFeedback("Telegram did not confirm the change. Check the refreshed list.");
    } finally {
      clearCommunityReview();
      setConfirmMember(undefined);
      setRestrictionForm(undefined);
      setAdministratorForm(undefined);
      setTagForm(undefined);
      setSavingModeration(false);
      setPage(undefined);
      setRequest((previous) => ({ ...previous, offset: 0 }));
    }
  }

  function clearCommunityReview() {
    communityPreviewGeneration.current++;
    setCommunityReview(undefined);
    setCommunityUnban(undefined);
    setCommunityLoading(false);
  }

  function reviewMember(action: MemberReview) {
    clearCommunityReview();
    setTagForm(undefined);
    setRestrictionForm(undefined);
    setAdministratorForm(undefined);
    setConfirmMember(action);
  }

  async function previewCommunity(userId: string) {
    if (!communityModeration || communityLoading || savingModeration) return;
    const generation = ++communityPreviewGeneration.current;
    setCommunityLoading(true);
    setCommunityReview(undefined);
    setConfirmMember(undefined);
    setFeedback("");
    try {
      const impact = await communityModeration.preview(chatId, userId);
      if (generation !== communityPreviewGeneration.current) return;
      if (impact) setCommunityReview({ userId, impact });
      else setFeedback("Community moderation is unavailable for this member.");
    } catch { if (generation === communityPreviewGeneration.current) setFeedback("Could not load the chats affected by a community ban."); }
    finally { if (generation === communityPreviewGeneration.current) setCommunityLoading(false); }
  }

  async function previewCommunityUnban(memberId: string, bannedUntil: number) {
    if (!communityModeration?.previewUnban || communityLoading || savingModeration) return;
    const generation = ++communityPreviewGeneration.current;
    setCommunityLoading(true);
    setCommunityUnban(undefined);
    setConfirmMember(undefined);
    setFeedback("");
    try {
      const target = await communityModeration.previewUnban(chatId, memberId, bannedUntil);
      if (generation !== communityPreviewGeneration.current) return;
      if (target) setCommunityUnban({ memberId, bannedUntil, target });
      else setFeedback("Community moderation is unavailable for this member.");
    } catch { if (generation === communityPreviewGeneration.current) setFeedback("Could not review the community unban."); }
    finally { if (generation === communityPreviewGeneration.current) setCommunityLoading(false); }
  }

  useEffect(() => {
    if (!open) return;
    let active = true;
    setLoading(true);
    setError(false);
    const resultPage = request.filter ? load(chatId, request.query, request.offset, request.filter) : load(chatId, request.query, request.offset);
    void resultPage.then((result) => {
      if (!active) return;
      if (request.offset && !result) setError(true);
      else setPage((previous) => {
        if (!result || !request.offset) return result;
        const rows = new Map(previous?.members.map((member) => [member.id, member]));
        for (const member of result.members) rows.set(member.id, member);
        return { ...result, members: [...rows.values()] };
      });
    }, () => { if (active) setError(true); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [chatId, load, open, request]);

  return <details onToggle={(event) => {
    setOpen(event.currentTarget.open);
    if (!event.currentTarget.open) {
      clearCommunityReview();
      setConfirmMember(undefined);
      setRestrictionForm(undefined);
      setAdministratorForm(undefined);
      setTagForm(undefined);
    }
  }}>
    <summary>{tr("Members")}</summary>
    {open && <>
      <label>{tr("Member list ")}<select disabled={savingModeration} value={request.filter ?? "all"} onChange={(event) => {
        const filter = chatMemberFilter.safeParse(event.currentTarget.value).data;
        clearCommunityReview();
        setConfirmMember(undefined);
        setRestrictionForm(undefined);
        setAdministratorForm(undefined);
        setTagForm(undefined);
        setFeedback("");
        setText("");
        setPage(undefined);
        setRequest({ query: "", offset: 0, filter });
      }}>
        <option value="all">{tr("All members")}</option>
        <option value="administrators">{tr("Administrators")}</option>
        <option value="contacts">{tr("My contacts")}</option>
        <option value="bots">{tr("Bots")}</option>
        <option value="banned">{tr("Banned members")}</option>
        {!channel && <option value="restricted">{tr("Restricted users")}</option>}
      </select></label>
      {request.filter !== "administrators" && request.filter !== "bots" && <form className="mtg-composer" onSubmit={(event) => {
        event.preventDefault();
        clearCommunityReview();
        setPage(undefined);
        setConfirmMember(undefined);
        setRestrictionForm(undefined);
        setAdministratorForm(undefined);
        setTagForm(undefined);
        setFeedback("");
        setRequest({ ...request, query: text.trim(), offset: 0 });
      }}>
        <input type="search" aria-label={tr("Find a member")} placeholder={tr("Find a member")} value={text} maxLength={128}
          onChange={(event) => setText(event.currentTarget.value)} />
        <button type="submit" className="mtg-action" disabled={savingModeration}>{tr("Find")}</button>
      </form>}
      {feedback && <p role="status">{tr(feedback)}</p>}
      {loading && <p role="status">{tr("Loading members…")}</p>}
      {error && <p role="alert">{tr("Telegram could not load members. ")}<button type="button" className="mtg-action"
        onClick={() => setRequest({ ...request })}>{tr("Retry")}</button></p>}
      {page === null && !loading && !error && <p>{tr("Member list is unavailable.")}</p>}
      {page && !page.members.length && page.next === null && !loading && !error && <p>{tr("No matching members.")}</p>}
      {!!page?.members.length && <ul className="mtg-scheduled-list" aria-label={tr("Telegram members")}>
        {page.members.map(({ id, name, role, tag, joinedAt, bannedUntil, restriction, canDemote, administratorRights, canEditTag }) => <li key={id}>
          <bdi>{name}</bdi> · {role === "banned" && id.startsWith("-") ? tr("Banned chat") : roles[role]}{tag && <> · <bdi>{tag}</bdi></>}
          {bannedUntil !== undefined && (bannedUntil ? <>{tr(" until ")}<time dateTime={new Date(bannedUntil * 1000).toISOString()}>
            {new Date(bannedUntil * 1000).toLocaleString(uiLocale)}</time></> : tr(" indefinitely"))}
          {restriction && (restriction.until ? <>{tr(" until ")}<time dateTime={new Date(restriction.until * 1000).toISOString()}>
            {new Date(restriction.until * 1000).toLocaleString(uiLocale)}</time></> : tr(" indefinitely"))}
          {restriction && !restriction.isMember && <>{tr(" · Outside the group")}</>}
          {setTag && canEditTag && (tagForm?.id === id
            ? <fieldset disabled={savingModeration || loading}>
              <legend>{tr("Member tag for ")}<bdi>{name}</bdi></legend>
              <label>{tr("Tag ")}<input value={tagForm.value} maxLength={32}
                onChange={(event) => setTagForm({ ...tagForm, value: event.currentTarget.value })} /></label>
              <p>{tr("Use up to 16 characters without emoji. Leave it empty to remove the tag.")}</p>
              <button type="button" className="mtg-action"
                disabled={tagForm.value.trim() === tagForm.expected || [...tagForm.value.trim()].length > 16}
                onClick={() => void applyModeration(() => setTag(chatId, id, tagForm.expected, tagForm.value.trim()))}>{tr("Save tag")}</button>
              <button type="button" className="mtg-action" onClick={() => setTagForm(undefined)}>{tr("Cancel")}</button>
            </fieldset>
            : <button type="button" className="mtg-action" disabled={loading || savingModeration} onClick={() => {
              setConfirmMember(undefined);
              setRestrictionForm(undefined);
              setAdministratorForm(undefined);
              setTagForm({ id, expected: tag ?? "", value: tag ?? "" });
            }}>{tr("Edit member tag")}</button>)}
          {saveAdministrator && !!page.grantableAdministratorRights?.length && (role === "member" || administratorRights !== undefined) &&
            (administratorForm?.id === id
              ? <fieldset disabled={savingModeration || loading}>
                <legend>{tr("Administrator rights for ")}<bdi>{name}</bdi></legend>
                {administratorForm.available.map((key) => <label key={key}>
                  <input type="checkbox" checked={administratorForm.selected.includes(key)} onChange={(event) => {
                    const selected = event.currentTarget.checked ? [...administratorForm.selected, key]
                      : administratorForm.selected.filter((right) => right !== key);
                    setAdministratorForm({ ...administratorForm, selected });
                  }} /> {tr(administratorRightLabels[key])}
                </label>)}
                <button type="button" className="mtg-action" disabled={!administratorForm.selected.length}
                  onClick={() => void applyModeration(() => saveAdministrator(chatId, id, administratorForm.available,
                    administratorForm.selected, administratorForm.expected))}>{tr("Save administrator rights")}</button>
                <button type="button" className="mtg-action" onClick={() => setAdministratorForm(undefined)}>{tr("Cancel")}</button>
              </fieldset>
              : <button type="button" className="mtg-action" disabled={loading || savingModeration} onClick={() => {
                setTagForm(undefined);
                const available = page.grantableAdministratorRights ?? [];
                setRestrictionForm(undefined);
                setConfirmMember(undefined);
                setAdministratorForm({ id, available, selected: available.filter((key) => administratorRights?.includes(key)),
                  expected: administratorRights });
              }}>{administratorRights ? tr("Edit administrator rights") : tr("Make administrator")}</button>)}
          {demote && canDemote && (confirmMember?.id === id && confirmMember.action === "demote"
            ? <div role="group" aria-label={tr("Confirm administrator demotion")}>
              <p>{tr("Remove administrator rights from ")}<bdi>{name}</bdi>?</p>
              <button type="button" className="mtg-action" disabled={savingModeration || loading}
                onClick={() => void applyModeration(() => demote(chatId, id))}>{tr("Confirm removal")}</button>
              <button type="button" className="mtg-action" disabled={savingModeration} onClick={() => setConfirmMember(undefined)}>{tr("Cancel")}</button>
            </div>
            : <button type="button" className="mtg-action" disabled={loading || savingModeration}
              onClick={() => reviewMember({ id, action: "demote" })}>{tr("Remove administrator rights")}</button>)}
          {liftRestrictions && page.canLiftRestrictions && restriction && (confirmMember?.id === id && confirmMember.action === "liftRestrictions"
            ? <div role="group" aria-label={tr("Confirm lifting Telegram restrictions")}>
              <p>{tr("Remove all custom restrictions for ")}<bdi>{name}</bdi>?</p>
              <button type="button" className="mtg-action" disabled={savingModeration || loading}
                onClick={() => void applyModeration(() => liftRestrictions(chatId, id, restriction.until, restriction.isMember))}>{tr("Confirm lifting restrictions")}</button>
              <button type="button" className="mtg-action" disabled={savingModeration} onClick={() => setConfirmMember(undefined)}>{tr("Cancel")}</button>
            </div>
            : <button type="button" className="mtg-action" disabled={loading || savingModeration}
              onClick={() => reviewMember({ id, action: "liftRestrictions" })}>{tr("Lift restrictions")}</button>)}
          {restrict && page.restrictionDefaults && (role === "member" || restriction?.values) && (restrictionForm?.id === id
            ? <fieldset disabled={savingModeration || loading}>
              <legend>{tr("Restrict ")}<bdi>{name}</bdi></legend>
              <p>{tr("Select the permissions to remove.")}</p>
              {(Object.keys(groupPermissionLabels) as GroupPermission[]).filter((key) => restrictionForm.expected[key]).map((key) =>
                <label key={key}><input type="checkbox" checked={restrictionForm.denied.includes(key)}
                  onChange={(event) => {
                    const checked = event.currentTarget.checked;
                    setRestrictionForm({ ...restrictionForm, denied: checked
                      ? [...restrictionForm.denied, key] : restrictionForm.denied.filter((denied) => denied !== key) });
                  }} /> {tr(groupPermissionLabels[key])}</label>)}
              <label>{tr("Restriction duration ")}<select value={duration ?? "current"} onChange={(event) => {
                if (event.currentTarget.value === "current") { setDuration(undefined); return; }
                const selected = banDurations.find(([seconds]) => String(seconds) === event.currentTarget.value);
                if (selected) setDuration(selected[0]);
              }}>
                {restrictionForm.previous && <option value="current">{tr("Keep current expiry")}</option>}
                {banDurations.map(([seconds, label]) => <option key={seconds} value={seconds}>{tr(label)}</option>)}
              </select></label>
              <button type="button" className="mtg-action" disabled={!restrictionForm.denied.length}
                onClick={() => void applyModeration(() => restrict(chatId, id, duration, restrictionForm.expected, restrictionForm.denied, restrictionForm.previous))}>{tr("Confirm restrictions")}</button>
              <button type="button" className="mtg-action" onClick={() => setRestrictionForm(undefined)}>{tr("Cancel")}</button>
            </fieldset>
            : <button type="button" className="mtg-action" disabled={loading || savingModeration} onClick={() => {
              if (!page.restrictionDefaults) return;
              setAdministratorForm(undefined);
              setTagForm(undefined);
              const expected = page.restrictionDefaults;
              const previous = restriction?.values ? { ...restriction, values: restriction.values } : undefined;
              const denied = previous ? (Object.keys(groupPermissionLabels) as GroupPermission[])
                .filter((key) => expected[key] === true && previous.values[key] === false) : [];
              setConfirmMember(undefined);
              setDuration(previous ? undefined : 0);
              setRestrictionForm({ id, expected, denied, previous });
            }}>{restriction ? tr("Edit restrictions") : tr("Restrict")}</button>)}
          {communityModeration && page.communityModeration && (role === "member" || role === "restricted")
            && (communityReview?.userId === id
              ? <div role="group" aria-label={tr("Review community ban")}>
                <p>{tr("Ban ")}<bdi>{name}</bdi>{tr(" from ")}<bdi>{communityReview.impact.community}</bdi>?</p>
                {!!communityReview.impact.joined.length && <><p>{tr("Chats this member has joined")}</p>
                  <ul>{communityReview.impact.joined.map((chat) => <li key={chat.id}><bdi>{chat.name}</bdi></li>)}</ul></>}
                {!!communityReview.impact.owned.length && <><p>{tr("Owned chats that will be removed from the community")}</p>
                  <ul>{communityReview.impact.owned.map((chat) => <li key={chat.id}><bdi>{chat.name}</bdi></li>)}</ul></>}
                {!communityReview.impact.canBan && <p>{tr("Removing the member’s owned chats requires the right to edit the community chat list.")}</p>}
                <button type="button" className="mtg-action" disabled={loading || savingModeration || !communityReview.impact.canBan}
                  onClick={() => void applyModeration(() => communityModeration.ban({ id: chatId, userId: id, communityId: communityReview.impact.communityId,
                    joined: communityReview.impact.joined.map((chat) => chat.id), owned: communityReview.impact.owned.map((chat) => chat.id) }))}>{tr("Confirm community ban")}</button>
                <button type="button" className="mtg-action" disabled={savingModeration} onClick={() => setCommunityReview(undefined)}>{tr("Cancel community ban")}</button>
              </div>
              : <button type="button" className="mtg-action" disabled={loading || savingModeration || communityLoading}
                onClick={() => void previewCommunity(id)}>{tr("Review community ban")}</button>)}
          {moderate && joinedAt !== undefined && (role === "member" || role === "restricted") && (
            confirmMember?.id === id && "joinedAt" in confirmMember
              ? <div role="group" aria-label={confirmMember.action === "remove" ? tr("Confirm member removal") : tr("Confirm deletion of member messages")}>
                {confirmMember.action === "remove"
                  ? <p>{tr("Remove ")}<bdi>{name}</bdi>{tr(" from this chat? They can rejoin under the chat’s rules.")}</p>
                  : <p>{tr("Delete all messages sent by ")}<bdi>{name}</bdi>{tr(" in this group for everyone?")}</p>}
                <button type="button" className="mtg-action" disabled={savingModeration || loading
                  || !(confirmMember.action === "remove" ? page.canRemoveMembers : page.canDeleteMemberMessages)}
                  onClick={() => void applyModeration(() => moderate({ id: chatId, userId: id, action: confirmMember.action,
                    joinedAt: confirmMember.joinedAt, role: confirmMember.role }))}>
                  {confirmMember.action === "remove" ? tr("Confirm member removal") : tr("Confirm deletion")}
                </button>
                <button type="button" className="mtg-action" disabled={savingModeration} onClick={() => setConfirmMember(undefined)}>{tr("Cancel")}</button>
              </div>
              : <>
                {page.canRemoveMembers && <button type="button" className="mtg-action" disabled={loading || savingModeration}
                  onClick={() => reviewMember({ id, role, joinedAt, action: "remove" })}>{tr("Remove member")}</button>}
                {page.canDeleteMemberMessages && <button type="button" className="mtg-action" disabled={loading || savingModeration}
                  onClick={() => reviewMember({ id, role, joinedAt, action: "deleteMessages" })}>{tr("Delete member messages")}</button>}
              </>)}
          {ban && page.canBan && (role === "member" || role === "restricted") && (confirmMember?.id === id && confirmMember.action === "ban"
            ? <div role="group" aria-label={tr("Confirm Telegram ban")}>
              <p>{tr("Ban ")}<bdi>{name}</bdi>{tr(" from this chat? They cannot rejoin while the ban is active.")}</p>
              <label>{tr("Ban duration ")}<select value={duration} disabled={savingModeration} onChange={(event) => {
                const selected = banDurations.find(([seconds]) => String(seconds) === event.currentTarget.value);
                if (selected) setDuration(selected[0]);
              }}>
                {banDurations.map(([seconds, label]) => <option key={seconds} value={seconds}>{tr(label)}</option>)}
              </select></label>
              <button type="button" className="mtg-action" disabled={savingModeration || loading}
                onClick={() => void applyModeration(() => ban(chatId, id, role, duration ?? 0))}>{tr("Confirm ban")}</button>
              <button type="button" className="mtg-action" disabled={savingModeration} onClick={() => setConfirmMember(undefined)}>{tr("Cancel")}</button>
            </div>
            : <button type="button" className="mtg-action" disabled={loading || savingModeration}
              onClick={() => { setDuration(0); reviewMember({ id, action: "ban" }); }}>{tr("Ban")}</button>)}
          {communityModeration?.unban && communityModeration.previewUnban && page.communityModeration
            && role === "banned" && bannedUntil !== undefined && (communityUnban?.memberId === id
              ? <div role="group" aria-label={tr("Review community unban")}>
                <p>{tr("Lift any ban for ")}<bdi>{name}</bdi>{tr(" across ")}<bdi>{communityUnban.target.community}</bdi>?</p>
                <button type="button" className="mtg-action" disabled={loading || savingModeration}
                  onClick={() => void applyModeration(() => communityModeration.unban!({ id: chatId, memberId: id,
                    communityId: communityUnban.target.communityId, bannedUntil: communityUnban.bannedUntil }))}>{tr("Confirm community unban")}</button>
                <button type="button" className="mtg-action" disabled={savingModeration}
                  onClick={() => setCommunityUnban(undefined)}>{tr("Cancel community unban")}</button>
              </div>
              : <button type="button" className="mtg-action" disabled={loading || savingModeration || communityLoading}
                onClick={() => void previewCommunityUnban(id, bannedUntil)}>{tr("Review community unban")}</button>)}
          {unban && page.canUnban && role === "banned" && bannedUntil !== undefined && (confirmMember?.id === id && confirmMember.action === "unban"
            ? <div role="group" aria-label={tr("Confirm lifting Telegram ban")}>
              <p>{tr("Lift the ban for ")}<bdi>{name}</bdi>?</p>
              <button type="button" className="mtg-action" disabled={savingModeration} onClick={() => void applyModeration(() => unban(chatId, id, bannedUntil))}>{tr("Confirm unban")}</button>
              <button type="button" className="mtg-action" disabled={savingModeration} onClick={() => setConfirmMember(undefined)}>{tr("Cancel")}</button>
            </div>
            : <button type="button" className="mtg-action" disabled={loading || savingModeration}
              onClick={() => reviewMember({ id, action: "unban" })}>{tr("Unban")}</button>)}
        </li>)}
      </ul>}
      {page?.next != null && !error && <button type="button" className="mtg-action" disabled={loading || savingModeration}
        onClick={() => setRequest({ ...request, offset: page.next! })}>{tr("Load more members")}</button>}
    </>}
  </details>;
}
