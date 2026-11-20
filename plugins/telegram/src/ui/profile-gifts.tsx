import { useTelegramLocale } from "./i18n/index.tsx";
import type { CollectibleDetails, LinkedCollectibleGift, GiftResaleAttributeId, GiftResaleAttributeOption, GiftResalePrice } from "../core/contract.ts";
import { Fragment, useEffect, useRef, useState } from "react";
import type { z } from "zod";
import { giftCollectionChange, type GiftCollectionChange, type GiftMembership, type GiftCatalog, type GiftAuctionView, type GiftAuctionBid, type GiftResalePage, type GiftResaleQuery, type GiftResalePayment, type GiftQuote, type GiftSendResult, type GiftSendOptions, type ProfileGiftCollections, type ProfileGiftPage, type schemas } from "../core/contract.ts";
import { Avatar, type AvatarLoader } from "./avatar.tsx";

import { TgsSticker, type LoadSticker } from "./tgs-sticker.tsx";

export type ProfileGiftActions = {
  reviewBid?: (id: string, bid: GiftAuctionBid) => Promise<string | null>;
  confirmBid?: (id: string, confirmation: string) => Promise<GiftSendResult>;
  auction?: (id: string, giftId: string, auctionId: string) => Promise<GiftAuctionView | null>;
  send?: (id: string, giftId: string, confirmation: string, options: GiftSendOptions) => Promise<GiftSendResult>;
  quote?: (id: string, giftId: string) => Promise<GiftQuote>;
  reviewResale?: (id: string, payment: GiftResalePayment) => Promise<string | null>;
  confirmResale?: (id: string, confirmation: string) => Promise<GiftSendResult>;
  resale?: (id: string, query: GiftResaleQuery) => Promise<GiftResalePage>;
  catalog?: (id: string) => Promise<GiftCatalog>;
  showShortcut?: (id: string) => Promise<boolean>;
  membership?: (id: string, change: GiftMembership) => Promise<"saved" | "unavailable" | "full">;
  visibility?: (id: string, gift: string, expected: boolean) => Promise<"saved" | "changed" | "unavailable">;
  pin?: (id: string, gift: string, expected: boolean) => Promise<"saved" | "changed" | "unavailable" | "full">;
  notifications?: (id: string, expected: boolean, enabled: boolean) => Promise<"saved" | "changed" | "unavailable">;
  reviewListing?: (id: string, gift: string, price: GiftResalePrice | null) => Promise<{ confirmation: string; price: GiftResalePrice | null; earningsPerMille?: number } | null>;
  confirmListing?: (id: string, gift: string, confirmation: string) => Promise<"saved" | "changed" | "unavailable" | "unknown">;
  reviewDropDetails?: (id: string, gift: string) => Promise<{ stars: number; confirmation: string } | null>;
  confirmDropDetails?: (id: string, gift: string, confirmation: string) => Promise<"removed" | "changed" | "unavailable" | "unknown">;
  transferRecipients?: (query: string) => Promise<GiftRecipient[]>;
  reviewTransfer?: (id: string, gift: string, recipient: string) => Promise<{ stars: number; name: string; confirmation: string } | null>;
  confirmTransfer?: (id: string, gift: string, confirmation: string) => Promise<"transferred" | "changed" | "unavailable" | "unknown">;
  reviewUpgrade?: (id: string, gift: string) => Promise<{ stars: number; confirmation: string; examples: string[] } | null>;
  confirmUpgrade?: (id: string, gift: string, confirmation: string, keepOriginalDetails: boolean) => Promise<"upgraded" | "changed" | "unavailable" | "unknown">;
  reviewConversion?: (id: string, gift: string) => Promise<{ stars: number; confirmation: string } | null>;
  confirmConversion?: (id: string, gift: string, confirmation: string) => Promise<"converted" | "changed" | "unavailable" | "unknown">;
  edit?: (id: string, change: GiftCollectionChange) => Promise<z.infer<typeof schemas.editProfileGiftCollection.output>>;
  artwork?: AvatarLoader;
  animation?: LoadSticker;
  collections: (id: string) => Promise<ProfileGiftCollections>;
  load: (id: string, collection?: number, offset?: string, includeHidden?: boolean) => Promise<ProfileGiftPage>;
};

function GiftArtwork({ id, gift, actions }: {
  id: string;
  gift: Pick<GiftCatalog[number], "emoji" | "artworkFileId" | "animationFileId">;
  actions: Pick<ProfileGiftActions, "artwork" | "animation">;
}) {
  const { t: tr } = useTelegramLocale();
  const { emoji, artworkFileId, animationFileId } = gift;
  const still = artworkFileId && actions.artwork
    ? <Avatar chat={{ id, color: "transparent", initials: emoji || "🎁", avatarFileId: artworkFileId }} load={actions.artwork} />
    : <span aria-hidden="true">{emoji || "🎁"}</span>;
  return animationFileId && actions.animation
    ? <TgsSticker key={animationFileId} chatId={id} messageId={String(animationFileId)} load={actions.animation}
      fallback={still} label={tr("Animated Telegram gift")} />
    : still;
}

const catalogNumber = new Intl.NumberFormat();

const gramNumber = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });

function CollectibleAttributes({ details }: { details: CollectibleDetails }) {
  const { t: tr } = useTelegramLocale();
  const entries = [["Model", details.model], ["Symbol", details.symbol], ["Backdrop", details.backdrop]] as const;
  const rarityNames = { uncommon: "Uncommon", rare: "Rare", epic: "Epic", legendary: "Legendary" };
  return <details>
    <summary>{tr("Collectible details")}</summary>
    <dl>
      {entries.map(([label, value]) => value && <Fragment key={label}>
        <dt>{label}</dt>
        <dd><bdi>{value.name}</bdi>{value.rarity !== undefined && <> · {
          typeof value.rarity === "number" ? value.rarity === 0 ? "<0.1%" : `${catalogNumber.format(value.rarity / 10)}%` : rarityNames[value.rarity]
        }</>}</dd>
      </Fragment>)}
      {details.supply && <><dt>{tr("Minted")}</dt><dd>{catalogNumber.format(details.supply.minted)}{tr(" of ")}{catalogNumber.format(details.supply.limit)}</dd></>}
    </dl>
  </details>;
}

export function CollectibleGiftDialog({ gift, close }: { gift: LinkedCollectibleGift; close: () => void }) {
  const { t: tr } = useTelegramLocale();
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { dialog.current?.showModal(); }, []);
  return <dialog ref={dialog} className="mtg-agent-settings" aria-label={tr("Collectible Telegram gift")} onClose={close}>
    <h2><bdi>{gift.title}</bdi>{gift.number !== undefined && <> #{catalogNumber.format(gift.number)}</>}</h2>
    {gift.thumbnail ? <img width={96} height={96} style={{ objectFit: "contain" }} alt=""
      src={`data:${gift.thumbnail.mime};base64,${gift.thumbnail.base64}`} /> : <p aria-hidden="true">{gift.emoji || "🎁"}</p>}
    {gift.details && <CollectibleAttributes details={gift.details} />}
    <p><a href={`https://t.me/nft/${gift.slug}`} target="_blank" rel="noopener noreferrer">{tr("Open in Telegram")}</a></p>
    <button type="button" className="mtg-action" onClick={() => dialog.current?.close()}>{tr("Close gift")}</button>
  </dialog>;
}

function GiftResaleListings({ id, recipient, giftId, actions, load }: {
  id: string; recipient?: string; giftId: string; actions: ProfileGiftActions; load: NonNullable<ProfileGiftActions["resale"]>;
}) {
  const { t: tr } = useTelegramLocale();
  const [open, setOpen] = useState(false);
  const [order, setOrder] = useState<GiftResaleQuery["order"]>("price");
  const [starsOnly, setStarsOnly] = useState(false);
  const [availableAttributes, setAvailableAttributes] = useState<GiftResaleAttributeOption[]>([]);
  const [attributes, setAttributes] = useState<GiftResaleAttributeId[]>([]);
  const [draftAttributes, setDraftAttributes] = useState<GiftResaleAttributeId[]>([]);
  const [page, setPage] = useState<GiftResalePage>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);

  const [purchase, setPurchase] = useState<{ payment: GiftResalePayment; confirmation: string }>();
  const [purchaseBusy, setPurchaseBusy] = useState(false);
  const [purchaseNotice, setPurchaseNotice] = useState("");

  async function review(payment: GiftResalePayment) {
    if (!actions.reviewResale || purchaseBusy) return;
    setPurchaseBusy(true);
    setPurchaseNotice("");
    try {
      const confirmation = await actions.reviewResale(id, payment);
      if (confirmation) setPurchase({ payment, confirmation });
      else setPurchaseNotice("The listing or price changed. Refresh the listings.");
    } catch { setPurchaseNotice("Could not check the resale price."); }
    finally { setPurchaseBusy(false); }
  }

  async function confirm() {
    if (!purchase || !actions.confirmResale || purchaseBusy) return;
    setPurchaseBusy(true);
    setPurchase(undefined);
    try {
      const result = await actions.confirmResale(id, purchase.confirmation);
      setPurchaseNotice(result === "sent" ? "Gift purchased and sent."
        : result === "changed" ? "The listing or price changed. Refresh the listings."
          : result === "unknown" ? "Telegram did not confirm delivery. Check your payment activity before trying again."
            : "The purchase could not be completed.");
    } catch { setPurchaseNotice("Telegram did not confirm delivery. Check your payment activity before trying again."); }
    finally { setPurchaseBusy(false); }
  }

  async function search(sort: GiftResaleQuery["order"], stars: boolean, offset?: string, filters = attributes) {
    if (busy || purchaseBusy || purchase) return;
    setBusy(true);
    setError(false);
    setPurchaseNotice("");
    if (!offset) setPage(undefined);
    try {
      const result = await load(id, { giftId, order: sort, starsOnly: stars, offset, ...(filters.length && { attributes: filters }) });
      if (!offset && !filters.length) setAvailableAttributes(result.attributes ?? []);
      setPage((previous) => {
        if (!previous || !offset) return result;
        const known = new Set(previous.gifts.map((gift) => gift.slug));
        return { ...result, gifts: [...previous.gifts, ...result.gifts.filter((gift) => !known.has(gift.slug))] };
      });
    } catch { setError(true); }
    finally { setBusy(false); }
  }

  return <section aria-label={tr("Resale listings")}>
    <button type="button" className="mtg-action" aria-expanded={open} disabled={busy || purchaseBusy || !!purchase} onClick={() => {
      setOpen(!open);
      if (!open) void search(order, starsOnly);
    }}>{tr("Browse resale listings")}</button>
    {open && <>
      <label>{tr("Sort listings ")}<select value={order} disabled={busy || purchaseBusy || !!purchase} onChange={(event) => {
        const next = event.target.value as GiftResaleQuery["order"];
        setOrder(next);
        void search(next, starsOnly);
      }}>
        <option value="price">{tr("Lowest price")}</option>
        <option value="recent">{tr("Recent price changes")}</option>
        <option value="number">{tr("Collectible number")}</option>
      </select></label>
      <label><input type="checkbox" checked={starsOnly} disabled={busy || purchaseBusy || !!purchase} onChange={(event) => {
        setStarsOnly(event.target.checked);
        void search(order, event.target.checked);
      }} />{tr("Stars only")}</label>
      {!!availableAttributes.length && <details className="mtg-gift-resale-attributes">
        <summary>{tr("Filter by collectible attributes")}{attributes.length ? ` (${attributes.length})` : ""}</summary>
        <div>
          {(["model", "symbol", "backdrop"] as const).map((kind) => {
            const options = availableAttributes.filter(({ attribute }) => attribute.kind === kind);
            if (!options.length) return null;
            return <fieldset key={kind} disabled={busy || purchaseBusy || !!purchase}>
              <legend>{kind === "model" ? tr("Models") : kind === "symbol" ? tr("Symbols") : tr("Backdrops")}</legend>
              {options.map(({ attribute, name }) => {
                const current = draftAttributes.some((item) => item.kind === attribute.kind && item.id === attribute.id);
                return <label key={`${attribute.kind}:${attribute.id}`}>
                  <input type="checkbox" checked={current} disabled={!current && draftAttributes.length >= 100}
                    onChange={(event) => {
                      const checked = event.currentTarget.checked;
                      setDraftAttributes((current) => checked ? [...current, attribute]
                        : current.filter((item) => item.kind !== attribute.kind || item.id !== attribute.id));
                    }} /> <bdi>{name}</bdi>
                </label>;
              })}
            </fieldset>;
          })}
        </div>
        <button type="button" className="mtg-action" disabled={busy || purchaseBusy || !!purchase}
          onClick={() => { setAttributes(draftAttributes); void search(order, starsOnly, undefined, draftAttributes); }}>{tr("Apply attribute filters")}</button>
        <button type="button" className="mtg-action" disabled={busy || purchaseBusy || !!purchase || (!attributes.length && !draftAttributes.length)}
          onClick={() => { setAttributes([]); setDraftAttributes([]); void search(order, starsOnly, undefined, []); }}>{tr("Clear attribute filters")}</button>
      </details>}
      {busy && <p role="status">{tr("Loading resale listings…")}</p>}
      {purchaseBusy && <p role="status">{tr("Checking or submitting purchase…")}</p>}
      {purchaseNotice && <p role="status">{tr(purchaseNotice)} <button type="button" className="mtg-action"
        disabled={busy || purchaseBusy || !!purchase} onClick={() => void search(order, starsOnly)}>{tr("Refresh listings")}</button></p>}
      {error && <p role="alert">{tr("Could not load resale listings. ")}<button type="button" className="mtg-action"
        onClick={() => void search(order, starsOnly, page?.next ?? undefined)}>{tr("Retry")}</button></p>}
      {page && !page.gifts.length && !page.next && <p>{tr("No matching listings.")}</p>}
      {!!page?.gifts.length && <ul className="mtg-profile-gifts">{page.gifts.map((gift) => <li key={gift.slug}>
        <GiftArtwork id={id} gift={gift} actions={actions} />
        <div>
          <a href={`https://t.me/nft/${gift.slug}`} target="_blank" rel="noopener noreferrer">
            <bdi>{gift.title}</bdi>{gift.number !== undefined && <> #{gift.number}</>}
          </a>
          {gift.details && <CollectibleAttributes details={gift.details} />}
          <div>{gift.stars !== undefined && tr("{0} Stars", [catalogNumber.format(gift.stars)])}
            {gift.stars !== undefined && gift.gramCents !== undefined && " / "}
            {gift.gramCents !== undefined && tr("{0} Gram", [gramNumber.format(gift.gramCents / 100)])}
            {gift.owned && tr(" · Yours")}</div>
          {!gift.owned && recipient && actions.reviewResale && actions.confirmResale && (purchase?.payment.slug === gift.slug
            ? <div role="group" aria-label={tr("Confirm resale purchase")}>
              <p>{tr("Send ")}<bdi>{gift.title}</bdi>{tr(" to ")}<bdi>{recipient}</bdi>{tr(" for ")}{purchase.payment.currency === "stars"
                ? tr("{0} Stars", [catalogNumber.format(purchase.payment.amount)])
                : tr("{0} Gram", [gramNumber.format(purchase.payment.amount / 100)])}?</p>
              <button type="button" className="mtg-action" onClick={() => void confirm()}>{tr("Confirm resale purchase")}</button>
              <button type="button" className="mtg-action" onClick={() => setPurchase(undefined)}>{tr("Cancel")}</button>
            </div>
            : <>
              {gift.stars !== undefined && <button type="button" className="mtg-action" disabled={busy || purchaseBusy || !!purchase}
                onClick={() => void review({ slug: gift.slug, currency: "stars", amount: gift.stars! })}>{tr("Review purchase with Stars")}</button>}
              {gift.gramCents !== undefined && <button type="button" className="mtg-action" disabled={busy || purchaseBusy || !!purchase}
                onClick={() => void review({ slug: gift.slug, currency: "gram", amount: gift.gramCents! })}>{tr("Review purchase with Gram")}</button>}
            </>)}
        </div>
      </li>)}</ul>}
      {page?.next && <button type="button" className="mtg-action" disabled={busy || purchaseBusy || !!purchase}
        onClick={() => void search(order, starsOnly, page.next ?? undefined)}>{tr("More listings")}</button>}
    </>}
  </section>;
}

function AuctionTime({ timestamp }: { timestamp: number }) {
  const { locale: uiLocale } = useTelegramLocale();
  const date = new Date(timestamp * 1000);
  return <time dateTime={date.toISOString()}>{date.toLocaleString(uiLocale)}</time>;
}

function GiftAuctionDetails({ id, recipient, giftId, auctionId, load, actions }: {
  id: string; recipient?: string; giftId: string; auctionId: string; actions: ProfileGiftActions; load: NonNullable<ProfileGiftActions["auction"]>;
}) {
  const { t: tr } = useTelegramLocale();
  const [open, setOpen] = useState(false);
  const [auction, setAuction] = useState<GiftAuctionView | null>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);

  const [amount, setAmount] = useState("");
  const [reviewed, setReviewed] = useState<{ confirmation: string; stars: number }>();
  const [bidBusy, setBidBusy] = useState(false);
  const [bidNotice, setBidNotice] = useState("");
  const stars = Number(amount);
  const threshold = auction?.state === "active" && auction.minBid
    ? Math.max(auction.minBid, auction.nextBid ?? 0, (auction.ownBid ?? 0) + 1) : undefined;
  const valid = threshold !== undefined && /^\d+$/.test(amount) && Number.isSafeInteger(stars) && stars >= threshold;

  async function review() {
    if (!actions.reviewBid || !valid || bidBusy) return;
    setBidBusy(true);
    setBidNotice("");
    try {
      const confirmation = await actions.reviewBid(id, { giftId, auctionId, stars });
      if (confirmation) setReviewed({ confirmation, stars });
      else setBidNotice("The auction changed or this bid is unavailable. Refresh the auction.");
    } catch { setBidNotice("Could not check the bid."); }
    finally { setBidBusy(false); }
  }

  async function confirm() {
    if (!actions.confirmBid || !reviewed || bidBusy) return;
    setBidBusy(true);
    setReviewed(undefined);
    try {
      const result = await actions.confirmBid(id, reviewed.confirmation);
      if (result === "sent") {
        setBidNotice("Bid placed.");
        setAmount("");
        await refresh();
      } else if (result === "changed") setBidNotice("The auction changed. Refresh it and review your bid again.");
      else if (result === "unknown") setBidNotice("Telegram did not confirm the bid. Check the auction before retrying.");
      else setBidNotice("The bid could not be placed.");
    } catch { setBidNotice("Telegram did not confirm the bid. Check the auction before retrying."); }
    finally { setBidBusy(false); }
  }

  async function refresh() {
    setBusy(true);
    setError(false);
    try { setAuction(await load(id, giftId, auctionId)); }
    catch { setError(true); }
    finally { setBusy(false); }
  }

  return <section aria-label={tr("Gift auction")}>
    <button type="button" className="mtg-action" aria-expanded={open} disabled={busy || bidBusy || !!reviewed} onClick={() => {
      setOpen(!open);
      if (!open) void refresh();
    }}>{tr("View auction")}</button>
    {open && <>
      <button type="button" className="mtg-action" disabled={busy || bidBusy || !!reviewed} onClick={() => void refresh()}>{tr("Refresh auction")}</button>
      {busy && <p role="status">{tr("Loading auction…")}</p>}
      {error && <p role="alert">{tr("Could not refresh the auction.")}</p>}
      {auction === null && <p>{tr("Auction unavailable.")}</p>}
      {auction?.state === "active" && <>
        {auction.startsAt > Date.now() / 1000 && <div>{tr("Starts ")}<AuctionTime timestamp={auction.startsAt} /></div>}
        {auction.round !== undefined && <div>{tr("Round ")}{catalogNumber.format(auction.round)}
          {auction.totalRounds !== undefined && tr(" of {0}", [catalogNumber.format(auction.totalRounds)])}</div>}
        {auction.roundEndsAt && <div>{tr("Round ends ")}<AuctionTime timestamp={auction.roundEndsAt} /></div>}
        <div>{tr("Auction ends ")}<AuctionTime timestamp={auction.endsAt} /></div>
        {auction.minBid !== undefined && <div>{tr("Minimum bid: ")}{catalogNumber.format(auction.minBid)}{tr(" Stars")}</div>}
        {auction.remaining !== undefined && <div>{catalogNumber.format(auction.remaining)}{tr(" gifts left")}</div>}
        {auction.ownBid !== undefined && <div>{tr("Your bid: ")}{catalogNumber.format(auction.ownBid)}{tr(" Stars")}</div>}
      </>}
      {auction?.state === "active" && auction.canBid && threshold !== undefined && recipient
        && actions.reviewBid && actions.confirmBid && (reviewed
        ? <div role="group" aria-label={tr("Confirm auction bid")}>
          <p>{tr("Place a bid of ")}{catalogNumber.format(reviewed.stars)}{tr(" Stars for ")}<bdi>{recipient}</bdi>?</p>
          <button type="button" className="mtg-action" onClick={() => void confirm()}>{tr("Confirm auction bid")}</button>
          <button type="button" className="mtg-action" onClick={() => setReviewed(undefined)}>{tr("Cancel")}</button>
        </div>
        : <form onSubmit={(event) => { event.preventDefault(); void review(); }}>
          <label>{tr("Bid amount in Stars ")}<input type="text" inputMode="numeric" value={amount} maxLength={16}
            disabled={busy || bidBusy} onChange={(event) => setAmount(event.target.value)} /></label>
          {threshold !== auction.minBid && <div>{tr("Your minimum next bid: ")}{catalogNumber.format(threshold)}{tr(" Stars")}</div>}
          <button type="submit" className="mtg-action" disabled={!valid || busy || bidBusy}>{tr("Review bid")}</button>
        </form>)}
      {bidNotice && <p role="status">{tr(bidNotice)}</p>}
      {auction?.state === "finished" && <>
        <div>{tr("Auction ended ")}<AuctionTime timestamp={auction.endsAt} /></div>
        {auction.averageStars !== undefined && <div>{tr("Average price: ")}{catalogNumber.format(auction.averageStars)}{tr(" Stars")}</div>}
        {auction.acquired !== undefined && <div>{tr("Gifts acquired: ")}{catalogNumber.format(auction.acquired)}</div>}
      </>}
    </>}
  </section>;
}

export function ComposerGiftShortcut({ id, recipient, actions }: {
  id: string; recipient: string; actions: ProfileGiftActions;
}) {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    let current = true;
    setVisible(false);
    void actions.showShortcut?.(id).then(
      (show) => { if (current) setVisible(show); },
      () => { if (current) setVisible(false); },
    );
    return () => { current = false; };
  }, [actions, id]);
  if (!visible || !actions.catalog) return null;
  return <div className="mtg-composer-gifts">
    <BrowseGiftCatalog id={id} recipient={recipient} load={actions.catalog} actions={actions} shortcut />
  </div>;
}

function BrowseGiftCatalog({ id, recipient, load, actions, shortcut }: {
  shortcut?: boolean;
  id: string; recipient?: string; load: NonNullable<ProfileGiftActions["catalog"]>; actions: ProfileGiftActions;
}) {
  const { t: tr } = useTelegramLocale();
  const [open, setOpen] = useState(false);
  const [gifts, setGifts] = useState<GiftCatalog>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);

  const [verification, setVerification] = useState<{ gift: string; quote?: GiftQuote; error?: boolean }>();

  async function check(gift: string) {
    if (!actions.quote) return;
    setConfirming(false);
    setOptions({ text: "", upgrade: false });
    setSendResult(undefined);
    setVerification({ gift });
    try { setVerification({ gift, quote: await actions.quote(id, gift) }); }
    catch { setVerification({ gift, error: true }); }
  }

  const [options, setOptions] = useState<GiftSendOptions>({ text: "", upgrade: false });
  const [confirming, setConfirming] = useState(false);
  const [sending, setSending] = useState(false);
  const [sendResult, setSendResult] = useState<{ gift: string; result: GiftSendResult }>();
  const checking = verification !== undefined && !verification.quote && !verification.error;

  async function send() {
    const quote = verification?.quote;
    if (!confirming || sending || !verification || quote?.state !== "available" || !quote.confirmation
      || !actions.send || !recipient) return;
    const gift = verification.gift;
    setSending(true);
    setConfirming(false);
    setVerification(undefined);
    try {
      const result = await actions.send(id, gift, quote.confirmation, options);
      setSendResult({ gift, result });
    } catch {
      setSendResult({ gift, result: "unknown" });
    } finally {
      setSending(false);
    }
  }

  async function browse() {
    setBusy(true);
    setError(false);
    try { setGifts(await load(id)); }
    catch { setError(true); }
    finally { setBusy(false); }
  }

  return <section aria-label={tr("Gift catalog")}>
    <button type="button" className="mtg-action" aria-expanded={open} disabled={busy || checking || sending} onClick={() => {
      setOpen(!open);
      if (!open) { setGifts(undefined); setVerification(undefined); setConfirming(false); setSendResult(undefined); void browse(); }
    }}>{shortcut ? tr("Send a gift") : tr("Browse gift catalog")}</button>
    {open && <>
      {busy && <p role="status">{tr("Loading gift catalog…")}</p>}
      {error && <p role="alert">{tr("Could not load the gift catalog. ")}<button type="button" onClick={() => void browse()}
        className="mtg-action" disabled={busy}>{tr("Retry")}</button></p>}
      {gifts?.length === 0 && <p>{tr("No gifts available in the catalog.")}</p>}
      {!!gifts?.length && <ul className="mtg-profile-gifts">{gifts.map((gift) => <li key={gift.id}>
        <GiftArtwork id={id} gift={gift} actions={actions} />
        <div>
          <strong><bdi>{gift.title}</bdi></strong>
          {!gift.auctionId && <div>{catalogNumber.format(gift.stars)}{tr(" Stars")}{gift.premiumOnly && tr(" · Premium")}</div>}
          {gift.supply && <div>{gift.supply.remaining === 0 ? tr("Sold out")
            : tr("{0} of {1} left", [catalogNumber.format(gift.supply.remaining), catalogNumber.format(gift.supply.total)])}</div>}
          {gift.resale && <div>{catalogNumber.format(gift.resale.count)}{tr(" listed for resale")}{gift.resale.minStars !== undefined && tr(", from {0} Stars", [catalogNumber.format(gift.resale.minStars)])}</div>}
          {gift.resale && actions.resale && <GiftResaleListings id={id} recipient={recipient} giftId={gift.id} actions={actions} load={actions.resale} />}
          {gift.auctionId && actions.auction && <GiftAuctionDetails id={id} recipient={recipient} actions={actions} giftId={gift.id} auctionId={gift.auctionId} load={actions.auction} />}
          {!gift.auctionId && actions.quote && <button type="button" className="mtg-action" aria-label={tr("Check availability for {0}", [gift.title])}
            disabled={checking || sending || confirming}
            onClick={() => void check(gift.id)}>{tr("Check availability")}</button>}
          {verification?.gift === gift.id && <p role="status">
            {verification.error ? tr("Could not check gift availability.") : verification.quote?.state === "available"
              ? tr("Current price: {0} Stars", [catalogNumber.format(verification.quote.stars)])
              : verification.quote?.reason ?? tr("Checking availability…")}
          </p>}
          {verification?.gift === gift.id && verification.quote?.state === "available" && verification.quote.confirmation
            && recipient && actions.send && (confirming
              ? <div role="group" aria-label={tr("Confirm gift")}>
                <p>{tr("Send ")}<bdi>{gift.title}</bdi>{tr(" to ")}<bdi>{recipient}</bdi>{tr(" for ")}{catalogNumber.format(
                  verification.quote.stars + (options.upgrade ? verification.quote.upgradeStars ?? 0 : 0))}{tr(" Stars?")}</p>
                {options.upgrade && <p>{tr("Includes the gift upgrade.")}</p>}
                <p>{options.showSenderPublicly ? tr("Your name and gift message can be shown publicly.")
                  : tr("Only the recipient can see your name and gift message.")}</p>
                {options.text && <p><bdi>{options.text}</bdi></p>}
                <button type="button" className="mtg-action" onClick={() => void send()}>{tr("Confirm gift send")}</button>
                <button type="button" className="mtg-action" onClick={() => setConfirming(false)}>{tr("Cancel")}</button>
              </div>
              : <>
                {!!verification.quote.textLimit && <label>{tr("Gift message")}<textarea value={options.text} maxLength={verification.quote.textLimit * 2}
                    onChange={(event) => setOptions({ ...options, text: event.target.value })} />
                </label>}
                {!!verification.quote.upgradeStars && <label>
                  <input type="checkbox" checked={options.upgrade}
                    onChange={(event) => setOptions({ ...options, upgrade: event.target.checked })} />{tr("Pay ")}{catalogNumber.format(verification.quote.upgradeStars)}{tr(" Stars for the gift upgrade")}</label>}
                <label><input type="checkbox" checked={options.showSenderPublicly === true}
                  onChange={(event) => setOptions({ ...options, showSenderPublicly: event.currentTarget.checked })} />{tr("Show my name and gift message publicly")}</label>
                <button type="button" className="mtg-action" onClick={() => setConfirming(true)}
                  disabled={Array.from(options.text).length > (verification.quote.textLimit ?? 0)}>{tr("Review gift send")}</button>
              </>)}
          {sendResult?.gift === gift.id && <p role="status">{sendResult.result === "sent" ? tr("Gift sent.")
            : sendResult.result === "changed" ? tr("The price or confirmation changed. Check availability again.")
              : sendResult.result === "unknown" ? tr("Telegram did not confirm delivery. Check your Stars activity before trying again.")
                : tr("The gift could not be sent.")}</p>}
        </div>
      </li>)}</ul>}
    </>}
  </section>;
}

function giftListingPrice(price: GiftResalePrice) {
  return price.currency === "stars" ? `${catalogNumber.format(price.amount)} Stars` : `${catalogNumber.format(price.amount / 100)} TON`;
}

function GiftListingEditor({ source, gift, current, review, confirm, busy, cancel }: {
  source: string; gift: string; current: GiftResalePrice | null; busy: boolean; cancel: () => void;
  review: NonNullable<ProfileGiftActions["reviewListing"]>; confirm: (token: string) => void;
}) {
  const { t: tr } = useTelegramLocale();
  const [currency, setCurrency] = useState<GiftResalePrice["currency"]>(current?.currency ?? "stars");
  const [amount, setAmount] = useState(current ? String(current.currency === "gram" ? current.amount / 100 : current.amount) : "");
  const [quote, setQuote] = useState<NonNullable<Awaited<ReturnType<typeof review>>>>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const value = amount.trim();
  const matched = currency === "stars" ? /^\d+$/.test(value) : /^\d+(?:[.,]\d{1,2})?$/.test(value);
  const [whole, fraction = ""] = value.split(/[.,]/);
  const units = currency === "stars" ? Number(value) : Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  const price = matched && Number.isSafeInteger(units) && units > 0 ? { currency, amount: units } : null;
  async function request(next: GiftResalePrice | null) {
    if (loading || busy) return;
    setLoading(true);
    setError("");
    try {
      const result = await review(source, gift, next);
      if (result) setQuote(result);
      else setError("Telegram did not accept the price or the gift is unavailable for resale.");
    } catch { setError("Could not review the resale price."); }
    finally { setLoading(false); }
  }
  return <div role="group" aria-label={tr("Gift resale listing")}>
    {current && <p>{tr("Listed at ")}{giftListingPrice(current)}.</p>}
    {quote ? <>
      <p>{quote.price ? tr("List the gift for {0}?", [giftListingPrice(quote.price)]) : tr("Remove this gift from sale?")}</p>
      {quote.earningsPerMille !== undefined && <p>{tr("You receive ")}{catalogNumber.format(quote.earningsPerMille / 10)}{tr("% of the sale price.")}</p>}
      <button type="button" className="mtg-action" disabled={busy} onClick={() => confirm(quote.confirmation)}>{tr("Confirm resale change")}</button>
      <button type="button" className="mtg-action" disabled={busy} onClick={() => setQuote(undefined)}>{tr("Back to resale price")}</button>
    </> : <>
      <label>{tr("Currency ")}<select value={currency} disabled={loading || busy}
        onChange={(event) => { setCurrency(event.currentTarget.value === "gram" ? "gram" : "stars"); setAmount(""); }}>
        <option value="stars">{tr("Stars")}</option><option value="gram">{tr("TON")}</option>
      </select></label>
      <label>{tr("Resale price ")}<input inputMode={currency === "stars" ? "numeric" : "decimal"} maxLength={20} value={amount}
        disabled={loading || busy} onChange={(event) => setAmount(event.currentTarget.value)} /></label>
      <button type="button" className="mtg-action" disabled={!price || loading || busy}
        onClick={() => { if (price) void request(price); }}>{tr("Review resale price")}</button>
      {current && <button type="button" className="mtg-action" disabled={loading || busy}
        onClick={() => void request(null)}>{tr("Review removal from sale")}</button>}
    </>}
    {loading && <p role="status">{tr("Checking resale price…")}</p>}
    {error && <p role="alert">{tr(error)}</p>}
    <button type="button" className="mtg-action" disabled={loading || busy} onClick={cancel}>{tr("Cancel resale change")}</button>
  </div>;
}

type GiftRecipient = { id: string; name: string; subtitle: string };

function GiftTransferReview({ source, gift, title, actions, busy, cancel, confirm }: {
  source: string; gift: string; title: string; busy: boolean;
  actions: Required<Pick<ProfileGiftActions, "transferRecipients" | "reviewTransfer">>;
  cancel: () => void; confirm: (token: string) => void;
}) {
  const { t: tr } = useTelegramLocale();
  const [query, setQuery] = useState("");
  const [recipients, setRecipients] = useState<GiftRecipient[]>();
  const [review, setReview] = useState<Awaited<ReturnType<typeof actions.reviewTransfer>>>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  async function search() {
    const term = query.trim();
    if (loading || busy || term.length < 2) return;
    setLoading(true);
    setError("");
    setRecipients(undefined);
    try { setRecipients((await actions.transferRecipients(term)).filter(({ id }) => id !== source)); }
    catch { setError("Could not find gift recipients."); }
    finally { setLoading(false); }
  }
  async function select(recipient: GiftRecipient) {
    if (loading || busy) return;
    setLoading(true);
    setError("");
    try {
      const quote = await actions.reviewTransfer(source, gift, recipient.id);
      if (quote) setReview(quote);
      else setError("This gift cannot be transferred to that recipient.");
    } catch { setError("Could not check gift transfer."); }
    finally { setLoading(false); }
  }
  return <div role="group" aria-label={tr("Gift transfer")}>
    {review ? <>
      <p>{tr("Transfer ")}<bdi>{title}</bdi>{tr(" to ")}<bdi>{review.name}</bdi>? {review.stars
        ? tr("You will pay {0} Stars.", [catalogNumber.format(review.stars)]) : tr("Telegram charges no fee.")}</p>
      <button type="button" className="mtg-action" disabled={busy} onClick={() => confirm(review.confirmation)}>{tr("Confirm gift transfer")}</button>
      <button type="button" className="mtg-action" disabled={busy} onClick={() => setReview(undefined)}>{tr("Choose another recipient")}</button>
    </> : <>
      <input aria-label={tr("Find gift recipients")} value={query} maxLength={128} disabled={loading || busy}
        onChange={(event) => setQuery(event.currentTarget.value)} onKeyDown={(event) => {
          if (event.key !== "Enter") return;
          event.preventDefault();
          void search();
        }} />
      <button type="button" className="mtg-action" disabled={loading || busy || query.trim().length < 2}
        onClick={() => void search()}>{tr("Find recipients")}</button>
      {recipients?.length === 0 && <p>{tr("No matching recipients.")}</p>}
      {!!recipients?.length && <ul aria-label={tr("Gift recipients")}>{recipients.map((recipient) => <li key={recipient.id}>
        <button type="button" className="mtg-action" disabled={loading || busy} onClick={() => void select(recipient)}>
          <bdi>{recipient.name}</bdi> · {recipient.subtitle}
        </button>
      </li>)}</ul>}
    </>}
    {loading && <p role="status">{tr("Checking gift transfer…")}</p>}
    {error && <p role="alert">{tr(error)}</p>}
    <button type="button" className="mtg-action" disabled={loading || busy} onClick={cancel}>{tr("Cancel gift transfer")}</button>
  </div>;
}

export function ProfileGifts({ id, recipient, actions, own = false }: { id: string; recipient?: string; actions: ProfileGiftActions; own?: boolean }) {
  const { t: tr } = useTelegramLocale();
  const [open, setOpen] = useState(false);
  const [collections, setCollections] = useState<ProfileGiftCollections>([]);
  const [collection, setCollection] = useState<number>();
  const [page, setPage] = useState<ProfileGiftPage>();
  const canManage = page?.canManage ?? own;
  const [includeHidden, setIncludeHidden] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [collectionsError, setCollectionsError] = useState(false);

  const [draft, setDraft] = useState<Exclude<GiftCollectionChange, { action: "move" }>>();
  const [editNotice, setEditNotice] = useState("");
  const [listing, setListing] = useState<string>();
  const [dropDetails, setDropDetails] = useState<{ gift: string; stars: number; confirmation: string }>();
  const [transfer, setTransfer] = useState<string>();
  const [upgrade, setUpgrade] = useState<{ gift: string; stars: number; confirmation: string; examples: string[]; keepOriginalDetails: boolean }>();
  const [conversion, setConversion] = useState<{ gift: string; stars: number; confirmation: string }>();
  const selectedIndex = collections.findIndex((item) => item.id === collection);
  const selectedCollection = collections[selectedIndex];
  const change = giftCollectionChange.safeParse(draft);

  async function saveCollection(input: unknown) {
    const change = giftCollectionChange.safeParse(input);
    if (!canManage || !actions.edit || busy || !change.success) return;
    setBusy(true);
    setEditNotice("");
    try {
      const result = await actions.edit(id, change.data);
      if (result.state === "saved") {
        setCollections((previous) => {
          const saved = result.collection;
          return previous.some((item) => item.id === saved.id)
            ? previous.map((item) => item.id === saved.id ? saved : item)
            : [...previous, saved];
        });
        setDraft(undefined);
        setEditNotice(change.data.action === "create" ? "Collection created." : "Collection renamed.");
      } else if (result.state === "applied") {
        setCollections(result.collections);
        setDraft(undefined);
        if (change.data.action === "delete") {
          setCollection(undefined);
          setPage(undefined);
          setEditNotice("Collection deleted.");
          try { setPage(await actions.load(id)); }
          catch { setError(true); }
        } else setEditNotice("Collection moved.");
      } else if (result.state === "changed") {
        setDraft(undefined);
        setEditNotice("The collection changed in Telegram. Reloaded the available collections.");
        const latest = await actions.collections(id);
        setCollections(latest);
        if (collection !== undefined && !latest.some((item) => item.id === collection)) {
          setCollection(undefined);
          setPage(await actions.load(id));
        }
      } else setEditNotice("Could not save the collection.");
    } catch {
      setEditNotice("Could not confirm the collection update.");
    } finally {
      setBusy(false);
    }
  }

  async function updateMembership(membership: GiftMembership) {
    if (!canManage || !actions.membership || busy) return;
    setBusy(true);
    setEditNotice("");
    try {
      const result = await actions.membership(id, membership);
      if (result === "full") {
        setEditNotice("This collection is full.");
        return;
      }
      if (result !== "saved") {
        setEditNotice("Could not update the gift collection.");
        return;
      }
      setEditNotice(membership.present ? "Gift added to collection." : "Gift removed from collection.");
      await refreshGiftPage();
    } catch {
      setEditNotice("Could not confirm the gift collection update.");
    } finally {
      setBusy(false);
    }
  }

  async function refreshGiftPage() {
    const [nextPage, nextCollections] = await Promise.allSettled([
      (includeHidden ? actions.load(id, collection, undefined, true) : actions.load(id, collection)), actions.collections(id),
    ]);
    if (nextPage.status === "fulfilled") {
      setPage(nextPage.value);
      setError(false);
    } else {
      setPage(undefined);
      setError(true);
    }
    if (nextCollections.status === "fulfilled") setCollections(nextCollections.value);
    setCollectionsError(nextCollections.status === "rejected");
  }

  async function updateProfileGift(kind: "visibility" | "pin", gift: string, expected: boolean) {
    const update = actions[kind];
    if (!canManage || !update || busy) return;
    setBusy(true);
    setEditNotice("");
    try {
      const result = await update(id, gift, expected);
      if (result === "full") {
        setEditNotice("The profile already has the maximum number of pinned gifts.");
        return;
      }
      if (result === "unavailable") {
        setEditNotice(kind === "visibility" ? "Could not update gift visibility." : "Could not update pinned gifts.");
        return;
      }
      setEditNotice(kind === "visibility"
        ? result === "changed" ? "Gift visibility changed in Telegram." : expected ? "Gift hidden from the profile." : "Gift shown on the profile."
        : result === "changed" ? "Pinned gifts changed in Telegram." : expected ? "Gift unpinned." : "Gift pinned.");
      await refreshGiftPage();
    } catch { setEditNotice(kind === "visibility" ? "Could not confirm the gift visibility update." : "Could not confirm the pinned gifts update."); }
    finally { setBusy(false); }
  }

  async function updateNotifications(enabled: boolean) {
    if (!canManage || !actions.notifications || page?.notificationsEnabled === undefined || busy) return;
    setBusy(true);
    setEditNotice("");
    try {
      const result = await actions.notifications(id, page.notificationsEnabled, enabled);
      if (result === "saved") {
        setPage((current) => current && { ...current, notificationsEnabled: enabled });
        setEditNotice(enabled ? "Gift notifications enabled." : "Gift notifications disabled.");
      } else if (result === "changed") {
        setEditNotice("Gift notifications changed in Telegram.");
        await refreshGiftPage();
      } else setEditNotice("Could not update gift notifications.");
    } catch { setEditNotice("Could not confirm the gift notification update."); }
    finally { setBusy(false); }
  }

  async function confirmListing(token: string) {
    if (!canManage || busy || !listing || !actions.confirmListing) return;
    setBusy(true);
    setListing(undefined);
    try {
      const result = await actions.confirmListing(id, listing, token);
      setEditNotice(result === "saved" ? "Resale listing updated."
        : result === "changed" ? "The gift, current listing or fee changed. Review it again."
        : result === "unknown" ? "Could not confirm the listing. Check the gift before retrying."
        : "Resale listing was unavailable.");
      await refreshGiftPage();
    } catch { setEditNotice("Could not confirm the listing. Check the gift before retrying."); }
    finally { setBusy(false); }
  }

  async function reviewDropDetails(gift: string) {
    if (!canManage || busy || !actions.reviewDropDetails) return;
    setBusy(true);
    setEditNotice("");
    try {
      const quote = await actions.reviewDropDetails(id, gift);
      if (quote) setDropDetails({ gift, ...quote });
      else setEditNotice("Original gift details cannot be removed.");
    } catch { setEditNotice("Could not check the fee for removing gift details."); }
    finally { setBusy(false); }
  }

  async function confirmDropDetails() {
    if (!canManage || busy || !dropDetails || !actions.confirmDropDetails) return;
    setBusy(true);
    setDropDetails(undefined);
    try {
      const result = await actions.confirmDropDetails(id, dropDetails.gift, dropDetails.confirmation);
      setEditNotice(result === "removed" ? "Original gift details removed."
        : result === "changed" ? "The gift or fee changed. Review it again."
        : result === "unknown" ? "Could not confirm the removal. Check the gift before retrying."
        : "Removal of original gift details was unavailable.");
      await refreshGiftPage();
    } catch { setEditNotice("Could not confirm the removal. Check the gift before retrying."); }
    finally { setBusy(false); }
  }

  async function confirmTransfer(token: string) {
    if (!canManage || busy || !transfer || !actions.confirmTransfer) return;
    setBusy(true);
    setTransfer(undefined);
    try {
      const result = await actions.confirmTransfer(id, transfer, token);
      setEditNotice(result === "transferred" ? "Gift transferred."
        : result === "changed" ? "The gift, recipient or transfer fee changed. Review it again."
        : result === "unknown" ? "Could not confirm the transfer. Check the gift before retrying."
        : "Gift transfer was unavailable.");
      await refreshGiftPage();
    } catch { setEditNotice("Could not confirm the transfer. Check the gift before retrying."); }
    finally { setBusy(false); }
  }

  async function reviewUpgrade(gift: string) {
    if (!canManage || busy || !actions.reviewUpgrade) return;
    setBusy(true);
    setEditNotice("");
    try {
      const quote = await actions.reviewUpgrade(id, gift);
      if (quote) setUpgrade({ gift, ...quote, keepOriginalDetails: false });
      else setEditNotice("This gift is no longer available for upgrade.");
    } catch { setEditNotice("Could not check gift upgrade."); }
    finally { setBusy(false); }
  }

  async function confirmUpgrade() {
    if (!canManage || busy || !upgrade || !actions.confirmUpgrade) return;
    setBusy(true);
    setUpgrade(undefined);
    try {
      const result = await actions.confirmUpgrade(id, upgrade.gift, upgrade.confirmation, upgrade.keepOriginalDetails);
      setEditNotice(result === "upgraded" ? "Gift upgraded to a collectible."
        : result === "changed" ? "The gift or upgrade price changed. Review it again."
        : result === "unknown" ? "Could not confirm the upgrade. Check the gift before retrying."
        : "Gift upgrade was unavailable.");
      await refreshGiftPage();
    } catch { setEditNotice("Could not confirm the upgrade. Check the gift before retrying."); }
    finally { setBusy(false); }
  }

  async function reviewConversion(gift: string) {
    if (!canManage || busy || !actions.reviewConversion) return;
    setBusy(true);
    setEditNotice("");
    try {
      const quote = await actions.reviewConversion(id, gift);
      if (quote) setConversion({ gift, ...quote });
      else setEditNotice("This gift is no longer available for conversion.");
    } catch { setEditNotice("Could not check gift conversion."); }
    finally { setBusy(false); }
  }

  async function confirmConversion() {
    if (!canManage || busy || !conversion || !actions.confirmConversion) return;
    setBusy(true);
    setConversion(undefined);
    try {
      const result = await actions.confirmConversion(id, conversion.gift, conversion.confirmation);
      setEditNotice(result === "converted" ? "Gift converted to Stars."
        : result === "changed" ? "The gift or conversion amount changed. Review it again."
        : result === "unknown" ? "Could not confirm conversion. Check the gift before retrying."
        : "Gift conversion was unavailable.");
      await refreshGiftPage();
    } catch { setEditNotice("Could not confirm conversion. Check the gift before retrying."); }
    finally { setBusy(false); }
  }

  async function load(selected?: number, offset?: string, loadCollections = false, hidden = includeHidden) {
    if (busy) return;
    setBusy(true);
    setError(false);
    try {
      const collectionList = loadCollections ? actions.collections(id).then(
        (value) => { setCollections(value); setCollectionsError(false); },
        () => setCollectionsError(true),
      ) : undefined;
      try {
        const result = hidden ? await actions.load(id, selected, offset, true) : await actions.load(id, selected, offset);
        setPage((previous) => offset && previous
          ? { ...result, gifts: [...previous.gifts, ...result.gifts] }
          : result);
      } finally {
        await collectionList;
      }
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  }

  return <section aria-label={tr("Profile gifts")}>
    <button type="button" className="mtg-action" aria-expanded={open} disabled={busy} onClick={() => {
      if (open) { setConversion(undefined); setOpen(false); return; }
      setOpen(true);
      if (!page) void load(collection, undefined, true);
    }}>{tr("Gifts")}</button>
    {open && <>
      {actions.catalog && <BrowseGiftCatalog id={id} recipient={recipient} load={actions.catalog} actions={actions} />}
      {canManage && actions.notifications && page?.notificationsEnabled !== undefined && <label>
        <input type="checkbox" checked={page.notificationsEnabled} disabled={busy}
          onChange={(event) => void updateNotifications(event.currentTarget.checked)} />{tr(" Notify me about new gifts")}</label>}
      {canManage && actions.visibility && <label><input type="checkbox" checked={includeHidden} disabled={busy}
        onChange={(event) => {
          const checked = event.currentTarget.checked;
          setConversion(undefined);
          setIncludeHidden(checked);
          setPage(undefined);
          void load(collection, undefined, false, checked);
        }} />{tr(" Include hidden gifts")}</label>}
      {!!collections.length && <label>{tr("Gift collection ")}<select value={collection ?? ""} disabled={busy}
        onChange={(event) => {
          const selected = event.target.value ? Number(event.target.value) : undefined;
          setConversion(undefined);
          setCollection(selected);
          setDraft(undefined);
          setEditNotice("");
          setPage(undefined);
          void load(selected);
        }}>
        <option value="">{tr("All gifts")}</option>
        {collections.map(({ id, name, count }) => <option key={id} value={id}>{name} ({count})</option>)}
      </select></label>}
      {canManage && actions.edit && <div>
        {draft?.action === "delete" ? <div role="group" aria-label={tr("Confirm deletion")}>
          <p>{tr("Delete ")}<bdi>{draft.expectedName}</bdi>{tr("? Its gifts will stay on the profile.")}</p>
          <button className="mtg-action" type="button" disabled={busy} onClick={() => void saveCollection(draft)}>{tr("Confirm delete")}</button>
          <button className="mtg-action" type="button" disabled={busy} onClick={() => setDraft(undefined)}>{tr("Cancel")}</button>
        </div> : draft ? <form onSubmit={(event) => { event.preventDefault(); void saveCollection(draft); }}>
          <label>{tr("Collection name ")}<input value={draft.name} disabled={busy}
            onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></label>
          <button className="mtg-action" type="submit" disabled={busy || !change.success}>{tr("Save collection")}</button>
          <button className="mtg-action" type="button" disabled={busy} onClick={() => setDraft(undefined)}>{tr("Cancel")}</button>
        </form> : <>
          <button className="mtg-action" type="button" disabled={busy} onClick={() => {
            setEditNotice("");
            setDraft({ action: "create", name: "" });
          }}>{tr("New gift collection")}</button>
          {selectedCollection && <button className="mtg-action" type="button" disabled={busy} onClick={() => {
            setEditNotice("");
            setDraft({ action: "rename", collection: selectedCollection.id,
              expectedName: selectedCollection.name, name: selectedCollection.name });
          }}>{tr("Rename collection")}</button>}
          {selectedCollection && <>
            <button className="mtg-action" type="button" disabled={busy || selectedIndex === 0}
              onClick={() => void saveCollection({ action: "move", collection: selectedCollection.id, direction: "up",
                expectedOrder: collections.map(({ id }) => id) })}>{tr("Move collection up")}</button>
            <button className="mtg-action" type="button" disabled={busy || selectedIndex === collections.length - 1}
              onClick={() => void saveCollection({ action: "move", collection: selectedCollection.id, direction: "down",
                expectedOrder: collections.map(({ id }) => id) })}>{tr("Move collection down")}</button>
            <button className="mtg-action" type="button" disabled={busy} onClick={() => {
              setEditNotice("");
              setDraft({ action: "delete", collection: selectedCollection.id, expectedName: selectedCollection.name });
            }}>{tr("Delete collection")}</button>
          </>}
        </>}
      </div>}
      {editNotice && <p role="status">{tr(editNotice)}</p>}
      {busy && <p role="status">{tr("Loading gifts…")}</p>}
      {collectionsError && <p role="status">{tr("Gift collections unavailable.")}</p>}
      {error && <p role="alert">{tr("Could not load gifts. ")}<button type="button" className="mtg-action"
        disabled={busy} onClick={() => void load(collection, page?.next ?? undefined)}>{tr("Retry")}</button></p>}
      {page && !page.gifts.length && !page.next && <p>{tr("No visible gifts.")}</p>}
      {!!page?.gifts.length && <ul className="mtg-profile-gifts">{page.gifts.map(({ title, emoji, slug, number, pinned, artworkFileId, animationFileId, receivedId, collectionIds, visible, conversionStars, upgradeable, transferable, canDropOriginalDetails, resaleListing, details }, index) => {
        const label = <><bdi>{title}</bdi>{number !== undefined && <> #{number}</>}</>;
        return <li key={receivedId ?? index}>
          <GiftArtwork id={id} gift={{ emoji, artworkFileId, animationFileId }} actions={actions} />
          <div>
          {slug ? <a href={`https://t.me/nft/${slug}`} target="_blank" rel="noopener noreferrer">{label}</a> : label}
          {pinned && <small>{tr(" · Pinned")}</small>}
          {visible === false && <small>{tr(" · Hidden")}</small>}
          {details && <CollectibleAttributes details={details} />}
          {canManage && actions.visibility && receivedId && visible !== undefined && <button type="button"
            className="mtg-action" disabled={busy} onClick={() => void updateProfileGift("visibility", receivedId, visible)}>
            {visible ? tr("Hide from profile") : tr("Show on profile")}
          </button>}
          {canManage && actions.pin && receivedId && visible === true && slug && <button type="button"
            className="mtg-action" disabled={busy} onClick={() => void updateProfileGift("pin", receivedId, pinned)}>
            {pinned ? tr("Unpin gift") : tr("Pin gift")}
          </button>}
          {canManage && receivedId && resaleListing && actions.reviewListing && actions.confirmListing
            && (listing === receivedId ? <GiftListingEditor source={id} gift={receivedId} current={resaleListing.current}
              busy={busy} review={actions.reviewListing} cancel={() => setListing(undefined)}
              confirm={(token) => void confirmListing(token)} />
              : <button type="button" className="mtg-action" disabled={busy || !!upgrade || !!conversion || !!transfer || !!dropDetails || !!listing}
                onClick={() => { setEditNotice(""); setListing(receivedId); }}>{tr("Manage gift resale")}</button>)}
          {canManage && receivedId && canDropOriginalDetails && actions.reviewDropDetails && actions.confirmDropDetails
            && (dropDetails?.gift === receivedId ? <div role="group" aria-label={tr("Confirm removal of gift details")}>
              <p>{tr("Permanently remove the original sender, recipient and message from ")}<bdi>{title}</bdi>{tr(" for ")}{catalogNumber.format(dropDetails.stars)}{tr(" Stars?")}</p>
              <button type="button" className="mtg-action" disabled={busy} onClick={() => void confirmDropDetails()}>{tr("Confirm removal of gift details")}</button>
              <button type="button" className="mtg-action" disabled={busy} onClick={() => setDropDetails(undefined)}>{tr("Cancel removal")}</button>
            </div> : <button type="button" className="mtg-action" disabled={busy || !!upgrade || !!conversion || !!transfer || !!dropDetails || !!listing}
              onClick={() => void reviewDropDetails(receivedId)}>{tr("Review removal of gift details")}</button>)}
          {canManage && receivedId && transferable && actions.transferRecipients && actions.reviewTransfer && actions.confirmTransfer
            && (transfer === receivedId ? <GiftTransferReview source={id} gift={receivedId} title={title} busy={busy}
              actions={{ transferRecipients: actions.transferRecipients, reviewTransfer: actions.reviewTransfer }}
              cancel={() => setTransfer(undefined)} confirm={(token) => void confirmTransfer(token)} />
              : <button type="button" className="mtg-action" disabled={busy || !!upgrade || !!conversion || !!transfer || !!dropDetails || !!listing}
                onClick={() => { setEditNotice(""); setTransfer(receivedId); }}>{tr("Review gift transfer")}</button>)}
          {canManage && receivedId && upgradeable && actions.reviewUpgrade && actions.confirmUpgrade
            && (upgrade?.gift === receivedId ? <div role="group" aria-label={tr("Confirm gift upgrade")}>
              <p>{tr("Upgrade ")}<bdi>{title}</bdi>{tr(" to a collectible? ")}{upgrade.stars
                ? tr("You will pay {0} Stars.", [catalogNumber.format(upgrade.stars)]) : tr("The upgrade is prepaid.")}</p>
              {!!upgrade.examples.length && <p>{tr("Possible models include ")}{upgrade.examples.join(", ")}.</p>}
              <label><input type="checkbox" checked={upgrade.keepOriginalDetails} disabled={busy}
                onChange={(event) => setUpgrade({ ...upgrade, keepOriginalDetails: event.currentTarget.checked })} />{tr(" Keep the original sender, recipient and message")}</label>
              <button type="button" className="mtg-action" disabled={busy} onClick={() => void confirmUpgrade()}>{tr("Confirm gift upgrade")}</button>
              <button type="button" className="mtg-action" disabled={busy} onClick={() => setUpgrade(undefined)}>{tr("Cancel gift upgrade")}</button>
            </div> : <button type="button" className="mtg-action" disabled={busy || !!upgrade || !!conversion || !!transfer || !!dropDetails || !!listing}
              onClick={() => void reviewUpgrade(receivedId)}>{tr("Review gift upgrade")}</button>)}
          {canManage && receivedId && conversionStars !== undefined && actions.reviewConversion && actions.confirmConversion
            && (conversion?.gift === receivedId ? <div role="group" aria-label={tr("Confirm gift conversion")}>
              <p>{tr("Convert ")}<bdi>{title}</bdi>{tr(" to ")}{catalogNumber.format(conversion.stars)}{tr(" Stars? This permanently removes the gift.")}</p>
              <button type="button" className="mtg-action" disabled={busy} onClick={() => void confirmConversion()}>{tr("Confirm conversion")}</button>
              <button type="button" className="mtg-action" disabled={busy} onClick={() => setConversion(undefined)}>{tr("Cancel")}</button>
            </div> : <button type="button" className="mtg-action" disabled={busy || !!conversion || !!upgrade || !!transfer || !!dropDetails || !!listing}
              onClick={() => void reviewConversion(receivedId)}>{tr("Review conversion to Stars")}</button>)}
          {canManage && actions.membership && receivedId && collectionIds && visible !== false && !!collections.length && <details>
            <summary>{tr("Edit gift collections")}</summary>
            <ul>{collections.map(({ id, name }) => {
              const present = collectionIds.includes(id);
              return <li key={id}><button type="button" className="mtg-action" disabled={busy}
                onClick={() => void updateMembership({ gift: receivedId, collection: id, present: !present })}>
                {present ? tr("Remove from") : tr("Add to")} <bdi>{name}</bdi>
              </button></li>;
            })}</ul>
          </details>}
          </div>
        </li>;
      })}</ul>}
      {page?.next && <button type="button" className="mtg-action" disabled={busy}
        onClick={() => void load(collection, page.next ?? undefined)}>{tr("More gifts")}</button>}
    </>}
  </section>;
}
