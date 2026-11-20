import { useTelegramLocale } from "./i18n/index.tsx";
import { useRef, useState } from "react";
import type { StarAmount, StarRevenueSummary, StarSubscription, StarTransaction, StarTransactionDirection } from "../core/contract.ts";

export function formatStarBillingPeriod(seconds: number) {
  const units = [[86400, "day"], [3600, "hour"], [60, "minute"], [1, "second"]] as const;
  const [size, unit] = units.find(([size]) => seconds % size === 0)!;
  return new Intl.NumberFormat("en", { style: "unit", unit }).format(seconds / size);
}

type SubscriptionPage = { subscriptions: StarSubscription[]; next: string;
  balance?: { stars: number; nanostars: number }; requiredStars?: number };

function formatStarBalance({ stars, nanostars }: StarAmount) {
  const whole = new Intl.NumberFormat("en").format(stars === 0 && nanostars < 0 ? -0 : stars);
  const fraction = String(Math.abs(nanostars)).padStart(9, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole;
}

function StarRevenueChart({ series }: { series: NonNullable<StarRevenueSummary["daily"]>[number] }) {
  const { t: tr } = useTelegramLocale();
  const [visible, setVisible] = useState(14);
  const points = series.points.slice(-visible).reverse();
  const scale = Math.max(1, ...points.map(({ stars }) => Math.abs(stars)));
  const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeZone: "UTC" });
  const numberFormat = new Intl.NumberFormat(undefined, { maximumFractionDigits: 9 });
  return <section aria-label={series.name}>
    <h4><bdi>{series.name}</bdi></h4>
    <ul>{points.map(({ date, stars }) => <li key={date}>
      <time dateTime={new Date(date).toISOString()}>{dateFormat.format(date)}</time>
      {" · "}{numberFormat.format(stars)}{tr(" Stars")}{" "}
      <meter min={0} max={scale} value={Math.abs(stars)} aria-label={tr("{0}: {1} Stars", [dateFormat.format(date), numberFormat.format(stars)])} />
    </li>)}</ul>
    {visible < series.points.length && <button type="button" className="mtg-action"
      onClick={() => setVisible((count) => count + 14)}>{tr("Show older days")}</button>}
  </section>;
}

export type LoadStarTransactions = (offset: string, direction: StarTransactionDirection) =>
  Promise<{ transactions: StarTransaction[]; next: string; balance?: StarAmount } | null>;
type OpenStarTransactionSource = (source: NonNullable<StarTransaction["source"]>) => Promise<boolean>;

function StarTransactionDetails({ row, openSource }: { row: StarTransaction; openSource?: OpenStarTransactionSource }) {
  const { t: tr } = useTelegramLocale();
  const [status, setStatus] = useState("");
  const [opening, setOpening] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(row.id);
      setStatus("Transaction ID copied.");
    } catch { setStatus("Could not copy the transaction ID."); }
  }
  async function open() {
    if (!row.source || !openSource || opening) return;
    setOpening(true);
    setStatus("");
    try {
      if (!await openSource(row.source)) setStatus("Could not open the original message.");
    } catch { setStatus("Could not open the original message."); }
    finally { setOpening(false); }
  }
  return <details>
    <summary>{tr("Transaction details")}</summary>
    {row.counterparty && <p>{tr("Counterparty: ")}<bdi>{row.counterparty}</bdi></p>}
    <p>{tr("Transaction ID: ")}<bdi><code>{row.id}</code></bdi></p>
    <button type="button" className="mtg-action" onClick={() => void copy()}>{tr("Copy transaction ID")}</button>
    {row.source && openSource && <button type="button" className="mtg-action" disabled={opening}
      onClick={() => void open()}>{tr("Open original message")}</button>}
    {status && <p role="status">{tr(status)}</p>}
  </details>;
}

export function StarTransactions({ load, subscription, openSource, revenue, loadRevenue }: {
  load: LoadStarTransactions; subscription?: string; openSource?: OpenStarTransactionSource; revenue?: boolean;
  loadRevenue?: () => Promise<StarRevenueSummary | null>;
}) {
  const { locale: uiLocale, t: tr } = useTelegramLocale();
  const [direction, setDirection] = useState<StarTransactionDirection>(revenue ? "incoming" : "all");
  const [page, setPage] = useState<Awaited<ReturnType<typeof load>>>();
  const [summary, setSummary] = useState<StarRevenueSummary | null>();
  const [offsets, setOffsets] = useState([""]);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);

  async function show(history: string[], filter: StarTransactionDirection) {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setDirection(filter);
    setPage(undefined);
    try {
      const offset = history.at(-1)!;
      const [result, nextSummary] = await Promise.all([
        load(offset, filter).catch(() => null),
        !offset && loadRevenue ? loadRevenue().catch(() => null) : undefined,
      ]);
      setPage(result);
      if (nextSummary !== undefined) setSummary(nextSummary);
      setOffsets(history);
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }

  return <>
    <h3>{subscription ? <>{tr("Transactions for ")}<bdi>{subscription}</bdi></> : revenue ? tr("Channel Stars transactions") : tr("Stars transactions")}</h3>
    <label>{tr("Direction ")}<select value={direction} disabled={busy}
      onChange={(event) => void show([""], event.target.value as StarTransactionDirection)}>
      <option value="all">{tr("All")}</option><option value="incoming">{tr("Received")}</option><option value="outgoing">{tr("Spent")}</option>
    </select></label>
    <button type="button" className="mtg-action" disabled={busy} onClick={() => void show([""], direction)}>
      {page === undefined ? tr("Show Stars transactions") : tr("Refresh Stars transactions")}
    </button>
    {busy && <p role="status">{tr("Loading Stars transactions…")}</p>}
    {page === null && <p>{tr("Stars transactions are unavailable.")}</p>}
    {summary && <dl aria-label={tr("Channel Stars revenue summary")}>
      <dt>{tr("Total earned")}</dt><dd>{formatStarBalance(summary.total)}{tr(" Stars")}</dd>
      <dt>{tr("Current balance")}</dt><dd>{formatStarBalance(summary.current)}{tr(" Stars")}</dd>
      <dt>{tr("Available to withdraw")}</dt><dd>{formatStarBalance(summary.available)}{tr(" Stars")}</dd>
      <dt>{tr("Withdrawal status")}</dt><dd>{!summary.withdrawalEnabled ? tr("Unavailable")
        : summary.nextWithdrawalIn > 0 ? tr("Cooldown: {0}", [formatStarBillingPeriod(summary.nextWithdrawalIn)]) : tr("Enabled")}</dd>
    </dl>}
    {summary?.daily && <details>
      <summary>{tr("Daily Stars revenue")}</summary>
      {summary.daily.map((series, index) => <StarRevenueChart key={index} series={series} />)}
    </details>}
    {!summary && revenue && page?.balance && <p>{tr("Channel balance: ")}{formatStarBalance(page.balance)}{tr(" Stars")}</p>}
    {page && !page.transactions.length && <p>{tr("No Stars transactions on this page.")}</p>}
    {page && !!page.transactions.length && <ul aria-label={tr("Stars transactions")}>
      {page.transactions.map((row) => <li key={JSON.stringify([row.id, row.date, row.refund])}>
        {row.refund ? tr("Refund · ") : ""}{row.label}{row.product && <> · <bdi>{row.product}</bdi></>}
        <div>{formatStarBalance(row.amount)}{tr(" Stars · ")}{new Date(row.date * 1000).toLocaleString(uiLocale)}</div>
        <StarTransactionDetails row={row} openSource={openSource} />
      </li>)}
    </ul>}
    {!busy && offsets.length > 1 && <button type="button" className="mtg-action"
      onClick={() => void show(offsets.slice(0, -1), direction)}>{tr("Previous transactions")}</button>}
    {page?.next && <button type="button" className="mtg-action" disabled={busy}
      onClick={() => void show([...offsets, page.next], direction)}>{tr("Next transactions")}</button>}
  </>;
}

export function StarSubscriptions({ load, edit, loadTransactions, openSource }: {
  load: (offset: string) => Promise<SubscriptionPage | null>;
  edit: (offset: string, expected: StarSubscription, cancel: boolean) => Promise<"saved" | "changed" | "unavailable">;
  loadTransactions?: (offset: string, direction: StarTransactionDirection, subscription: string) => ReturnType<LoadStarTransactions>;
  openSource?: OpenStarTransactionSource;
}) {
  const { locale: uiLocale, t: tr } = useTelegramLocale();
  const [page, setPage] = useState<SubscriptionPage | null>();
  const [offsets, setOffsets] = useState([""]);
  const [review, setReview] = useState<StarSubscription>();
  const [showTransactions, setShowTransactions] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const pending = useRef(false);

  async function show(history: string[]) {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setStatus("");
    setReview(undefined);
    setShowTransactions(undefined);
    try {
      setPage(await load(history.at(-1)!).catch(() => null));
      setOffsets(history);
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }

  async function confirm() {
    if (!review || pending.current) return;
    pending.current = true;
    setBusy(true);
    const offset = offsets.at(-1)!;
    try {
      const result = await edit(offset, review, !review.canceled).catch(() => "unavailable");
      setReview(undefined);
      setStatus(result === "saved" ? review.canceled ? "Renewal enabled." : "Renewal canceled."
        : result === "changed" ? "The subscription changed. Review the current details." : "Could not confirm the subscription update.");
      setPage(await load(offset).catch(() => null));
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }

  return <>
    <h3>{tr("Stars subscriptions")}</h3>
    <button type="button" className="mtg-action" disabled={busy} onClick={() => void show([""])}>
      {page === undefined ? tr("Show Stars subscriptions") : tr("Refresh Stars subscriptions")}
    </button>
    {busy && <p role="status">{tr("Loading Stars subscriptions…")}</p>}
    {status && <p role="status">{tr(status)}</p>}
    {page === null && <p>{tr("Stars subscriptions are unavailable.")}</p>}
    {page?.balance && <p>{tr("Balance: ")}{formatStarBalance(page.balance)}{tr(" Stars")}</p>}
    {!!page?.requiredStars && <p>{tr("Needed for upcoming renewals: ")}{page.requiredStars.toLocaleString(uiLocale)}{tr(" Stars")}</p>}
    {page && !page.subscriptions.length && <p>{tr("No subscriptions on this page.")}</p>}
    {page && !!page.subscriptions.length && <ul aria-label={tr("Stars subscriptions")}>
      {page.subscriptions.map((row) => <li key={row.id}>
        <bdi>{row.title}</bdi> · {row.stars.toLocaleString(uiLocale)}{tr(" Stars every ")}{formatStarBillingPeriod(row.period)}
        {row.expires > 0 && <p>{tr("Paid through ")}{new Date(row.expires * 1000).toLocaleDateString(uiLocale)}</p>}
        <p>{row.canceledByBot ? tr("Canceled by bot") : row.canceled ? tr("Renewal canceled") : row.expiring ? tr("Expiring") : tr("Renewal enabled")}</p>
        {loadTransactions && <>
          <button type="button" className="mtg-action" aria-expanded={showTransactions === row.id}
            onClick={() => setShowTransactions((current) => current === row.id ? undefined : row.id)}>
            {showTransactions === row.id ? tr("Hide subscription transactions") : tr("Show subscription transactions")}
          </button>
          {showTransactions === row.id && <section aria-label={tr("Transactions for {0}", [row.title])}>
            <StarTransactions subscription={row.title} load={(offset, direction) => loadTransactions(offset, direction, row.id)}
              openSource={openSource} />
          </section>}
        </>}
        {!row.canceledByBot && (review?.id === row.id
          ? <div role="group" aria-label={tr("Review subscription renewal")}>
            <p>{row.canceled ? tr("Resume recurring charges for this subscription?") : tr("Stop future charges for this subscription?")}</p>
            <button type="button" className="mtg-action" disabled={busy} onClick={() => void confirm()}>
              {row.canceled ? tr("Confirm resume renewal") : tr("Confirm cancel renewal")}
            </button>
            <button type="button" className="mtg-action" disabled={busy} onClick={() => setReview(undefined)}>{tr("Keep current setting")}</button>
          </div>
          : <button type="button" className="mtg-action" disabled={busy} onClick={() => setReview(row)}>
            {row.canceled ? tr("Resume renewal") : tr("Cancel renewal")}
          </button>)}
      </li>)}
    </ul>}
    {offsets.length > 1 && <button type="button" className="mtg-action" disabled={busy}
      onClick={() => void show(offsets.slice(0, -1))}>{tr("Previous subscriptions")}</button>}
    {page?.next && <button type="button" className="mtg-action" disabled={busy}
      onClick={() => void show([...offsets, page.next])}>{tr("Next subscriptions")}</button>}
  </>;
}
