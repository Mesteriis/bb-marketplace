import { Check, Copy, ExternalLink, Link2, MessageSquare, X } from "lucide-react";
import { isPlainKey } from "./composer-keys.ts";
import { LoadMessagePreviewCover, PreviewCover } from "./message-content.tsx";
import { useContext, useEffect, useState, type ReactNode } from "react";
import type { InvitePreview, LinkPreviewMetadata } from "../core/contract.ts";
import type { Message } from "../core/demo.ts";
import { textWebLinks, webLink } from "../core/message-links.ts";
import { spoilerRanges } from "../core/message-spoilers.ts";
import { canonicalTelegramContentLink } from "../core/telegram-content-link.ts";
import { canonicalTelegramInviteLink } from "../core/public-chat-reference.ts";
import { useTelegramLocale } from "./i18n/index.tsx";
import { OpenTelegramMessageLink, TelegramMessageLink } from "./telegram-message-link.tsx";

export function extractSharedLinks(message: Message) {
  const text = message.photoCaption ?? message.document?.caption ?? message.text;
  const spoilers = spoilerRanges(text, message.styles);
  const links = new Map<string, { url: URL; label?: string; confirm?: boolean }>();
  for (const { offset, length, url: value, hidden } of message.links ?? []) {
    if (offset < 0 || length < 1 || offset + length > text.length
      || spoilers.some(({ start, end }) => offset < end && start < offset + length)) continue;
    const url = webLink(canonicalTelegramContentLink(value) ?? value);
    if (!url || links.has(url.href)) continue;
    const label = text.slice(offset, offset + length).trim();
    links.set(url.href, { url, label: webLink(label) ? undefined : label, confirm: hidden });
  }
  if (!spoilers.length && !message.links?.length) {
    for (const url of textWebLinks(text)) links.set(url.href, { url });
  }
  const preview = spoilers.length ? undefined : message.linkPreview;
  const previewUrl = preview ? webLink(canonicalTelegramContentLink(preview.url) ?? preview.url) : undefined;
  if (previewUrl && !links.has(previewUrl.href)) links.set(previewUrl.href, { url: previewUrl });
  return [...links.values()].map((link) => {
    const details = previewUrl?.href === link.url.href ? preview : undefined;
    const address = link.url.pathname === "/" ? link.url.host : link.url.pathname;
    return { ...link, preview: details, title: details?.title || link.label || address };
  });
}

type SharedLink = ReturnType<typeof extractSharedLinks>[number];

export function SharedLinkRow({ message, links, selected, checkbox, date, inspect }: {
  message: Message;
  links: SharedLink[];
  selected?: { href?: string };
  checkbox?: ReactNode;
  date?: ReactNode;
  inspect: (href?: string) => void;
}) {
  const { t: tr } = useTelegramLocale();
  return <li className="mtg-shared-link-row" data-context-object>
    {checkbox}
    <div className="mtg-shared-link-targets">
      {(links.length ? links : [undefined]).map((link) => <button key={link?.url.href ?? "unavailable"}
        type="button" className="mtg-file-row mtg-shared-link-select" data-search-result={message.id}
        data-link-inspect={link?.url.href ?? ""} aria-pressed={!!selected && selected.href === link?.url.href}
        onClick={() => inspect(link?.url.href)}>
        <span className="mtg-shared-link-icon"><Link2 size={17} aria-hidden="true" /></span>
        <span><bdi>{link?.title ?? tr("Link unavailable")}</bdi>{link && <small><bdi>{link.url.host}</bdi></small>}</span>
        {date}
      </button>)}
    </div>
  </li>;
}

export function SharedLinkInspector({ chatId, message, link, close, showSource, previewInvite, previewWebLink }: {
  chatId: string;
  message: Message;
  link?: SharedLink;
  close: () => void;
  showSource?: () => void;
  previewInvite?: (url: string) => Promise<InvitePreview | null>;
  previewWebLink?: (url: string) => Promise<LinkPreviewMetadata | null>;
}) {
  const { locale, t: tr } = useTelegramLocale();
  const follow = useContext(OpenTelegramMessageLink);
  const loadCover = useContext(LoadMessagePreviewCover);
  const [copied, setCopied] = useState<boolean>();
  const [invite, setInvite] = useState<InvitePreview | null>();
  const [requested, setRequested] = useState<LinkPreviewMetadata | "loading" | null>();
  const href = link?.url.href;
  const telegram = href && canonicalTelegramContentLink(href);
  const cover = link?.preview?.cover;
  const inviteUrl = href && canonicalTelegramInviteLink(href);
  const canRequest = !message.restricted && !message.retained && !message.oneView && !message.pendingDelivery && !message.failedDelivery;
  useEffect(() => {
    if (!inviteUrl || !previewInvite || !canRequest) return;
    let active = true;
    void previewInvite(inviteUrl).then(
      (value) => { if (active) setInvite(value); },
      () => { if (active) setInvite(null); },
    );
    return () => { active = false; };
  }, [inviteUrl, previewInvite, canRequest]);
  const metadata = requested && requested !== "loading" ? requested : undefined;
  const title = invite?.title || link?.preview?.title || metadata?.title || link?.title || tr("Link unavailable");
  const description = invite?.description || link?.preview?.description || metadata?.description;
  const site = invite ? tr(invite.kind) : link?.preview?.site || metadata?.site;
  const inviteMembers = invite?.memberCount === undefined ? undefined
    : tr("Members: {0}", [invite.memberCount.toLocaleString(locale)]);

  async function requestPreview() {
    if (!href || !previewWebLink || !canRequest) return;
    setRequested("loading");
    setRequested(await previewWebLink(href).catch(() => null));
  }
  async function copyLink() {
    if (!href) return;
    try {
      await navigator.clipboard.writeText(href);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  return <aside className="mtg-file-inspector mtg-link-inspector" aria-label={tr("Link details")} onKeyDown={(event) => {
    if (!isPlainKey(event, "Escape") || !(event.target instanceof Element) || event.target.closest("dialog")) return;
    event.preventDefault();
    event.stopPropagation();
    close();
  }}>
    <header>
      <span className="mtg-shared-link-icon"><Link2 size={17} aria-hidden="true" /></span>
      <div className="mtg-link-inspector-identity">
        <h3><bdi>{title}</bdi></h3>
        {link && <bdi className="mtg-link-inspector-domain" title={href}>
          {link.url.host}{link.url.pathname !== "/" ? link.url.pathname : ""}
        </bdi>}
      </div>
      <button type="button" className="mtg-library-icon" aria-label={tr("Close link details")} title={tr("Close link details")} onClick={close}>
        <X size={16} aria-hidden="true" />
      </button>
    </header>
    {cover && loadCover && !message.retained && !message.oneView && !message.pendingDelivery &&
      <div className="mtg-link-inspector-cover"><PreviewCover chatId={chatId} messageId={message.id} cover={cover} loadCover={loadCover} /></div>}
    {(site || inviteMembers) && <p className="mtg-link-inspector-domain"><bdi>{[site, inviteMembers].filter(Boolean).join(" · ")}</bdi></p>}
    {description && <p className="mtg-link-inspector-description"><bdi>{description}</bdi></p>}
    {inviteUrl && previewInvite && canRequest && invite === undefined && <p role="status">{tr("Loading link preview…")}</p>}
    {((inviteUrl && invite === null) || requested === null) && <p className="mtg-link-inspector-description" role="status">{tr("Link preview unavailable")}</p>}
    {requested === "loading" && <p role="status">{tr("Loading link preview…")}</p>}
    {link && !telegram && !description && previewWebLink && canRequest && (requested === undefined || requested === null) &&
      <button type="button" className="mtg-action mtg-link-preview-load" onClick={() => void requestPreview()}>{tr("Load link preview")}</button>}
    <div className="mtg-link-inspector-actions">
      {href && <div className="mtg-link-inspector-open">
        {telegram && follow ? <TelegramMessageLink url={telegram} follow={follow}>{tr("Open link")}</TelegramMessageLink>
          : link?.confirm ? <button type="button" className="mtg-action" data-variant="primary" onClick={() => {
            if (window.confirm(tr("Open this link?\n\n{0}", [href]))) window.open(href, "_blank", "noopener,noreferrer");
          }}>{tr("Open link")} <ExternalLink size={14} aria-hidden="true" /></button>
          : <a className="mtg-action" data-variant="primary" href={href} target="_blank" rel="noopener noreferrer">
            {tr("Open link")} <ExternalLink size={14} aria-hidden="true" />
          </a>}
      </div>}
      {href && !message.restricted && !message.retained && typeof navigator.clipboard?.writeText === "function" &&
        <button type="button" className="mtg-library-icon" aria-label={tr("Copy link")} title={tr("Copy link")} onClick={() => void copyLink()}>
          {copied ? <Check size={15} aria-hidden="true" /> : <Copy size={15} aria-hidden="true" />}
        </button>}
      {showSource && <button type="button" className="mtg-library-icon" aria-label={tr("Go to message")} title={tr("Go to message")} onClick={showSource}>
        <MessageSquare size={15} aria-hidden="true" />
      </button>}
      {copied !== undefined && <span className={copied ? "mtg-visually-hidden" : undefined} role="status">
        {tr(copied ? "Link copied" : "Could not copy.")}
      </span>}
    </div>
  </aside>;
}
