import { useTelegramLocale } from "./i18n/index.tsx";
import { createContext, useId, useRef, useState } from "react";
import type { PollVoteGraph } from "../core/contract.ts";

export const LoadPollVoteHistory = createContext<((id: string, messageId: string, at?: number) => Promise<PollVoteGraph | null>) | undefined>(undefined);

const dateLabel = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });
const count = new Intl.NumberFormat();
const colors = ["#81c6ff", "#ffc47e", "#7edca4", "#e8a2fd", "#ffa1ad", "#e6df81"];
const left = 64, right = 608, top = 15, bottom = 195, width = 624;

function VoteChart({ graph, selected, choose }: { graph: PollVoteGraph; selected: number; choose: (point: number) => void }) {
  const { dates, series, chartType, percentage } = graph;
  const bars = chartType === "bar";
  const filled = bars || chartType === "area";
  const stacked = filled && (graph.stacked || percentage);
  const scaled = graph.scaled && !stacked && !percentage;
  const totals = dates.map((_, point) => series.reduce((sum, entry) => sum + entry.values[point]!, 0));
  const highest = percentage ? 100 : Math.max(1, ...(stacked ? totals : series.map(({ values }) => Math.max(...values))));
  const barWidth = Math.min(28, (right - left) / dates.length * .85);
  const start = left + (bars ? barWidth / 2 : 0);
  const end = right - (bars ? barWidth / 2 : 0);
  const span = dates.at(-1)! - dates[0]!;
  const xs = dates.map((date) => span ? start + (end - start) * (date - dates[0]!) / span : (start + end) / 2);
  const y = (value: number, maximum = highest) => bottom - (bottom - top) * value / maximum;
  const running = dates.map(() => 0);

  return <svg className="mtg-poll-vote-chart" viewBox={`0 0 ${width} 204`} aria-hidden="true"
    onClick={(event) => {
      const rect = event.currentTarget.getBoundingClientRect();
      const clicked = (event.clientX - rect.left) * width / rect.width;
      const closest = xs.reduce((current, x, i) => Math.abs(x - clicked) < Math.abs(xs[current]! - clicked) ? i : current, 0);
      choose(closest);
    }}>
    {(scaled ? [0] : [0, highest / 2, highest]).map((value) => <g key={value}>
      <line x1={left} x2={right} y1={y(value)} y2={y(value)} stroke="currentColor" opacity=".2" />
      <text x={left - 7} y={y(value) + 4} textAnchor="end" fill="currentColor" fontSize="11">
        {percentage ? `${value}%` : count.format(value)}
      </text>
    </g>)}
    {series.map(({ id, color, values }, i) => {
      const paint = color ?? colors[i % colors.length];
      const maximum = scaled ? Math.max(1, ...values) : highest;
      const lows = running.slice();
      const highs = values.map((value, point) => {
        const ordinate = percentage ? (totals[point] ? value / totals[point]! * 100 : 0) : value;
        if (!stacked) return ordinate;
        running[point] = running[point]! + ordinate;
        return running[point]!;
      });
      if (bars) {
        const size = stacked ? barWidth : barWidth / series.length;
        const columns = highs.map((value, point) => {
          const floor = y(stacked ? lows[point]! : 0, maximum);
          const height = Math.max(0, floor - y(value, maximum));
          const x = xs[point]! - barWidth / 2 + (stacked ? 0 : size * i);
          return height ? `M${x},${floor} v${-height} h${size} v${height} Z` : "";
        }).join(" ");
        return <path key={id} d={columns} fill={paint} />;
      }
      const upper = highs.map((value, point) => {
        const coord = `${xs[point]},${y(value, maximum)}`;
        if (point === 0) return `M${coord}`;
        return chartType === "step" ? `H${xs[point]} V${y(value, maximum)}` : `L${coord}`;
      }).join(" ");
      if (chartType === "area") {
        const lower = lows.map((value, point) => `L${xs[point]},${y(stacked ? value : 0, maximum)}`).reverse().join(" ");
        return <path key={id} d={`${upper} ${lower} Z`} fill={paint} fillOpacity={stacked ? .78 : .35} stroke={paint} />;
      }
      if (dates.length === 1) return <circle key={id} cx={xs[0]} cy={y(highs[0]!, maximum)} r="4" fill={paint} />;
      return <path key={id} d={upper} fill="none" stroke={paint} strokeWidth="2" />;
    })}
    <line x1={xs[selected]} x2={xs[selected]} y1={top} y2={bottom} stroke="currentColor" strokeDasharray="3 4" />
  </svg>;
}

export function PollVoteHistory({ question, load }: { question: string; load: (at?: number) => Promise<PollVoteGraph | null> }) {
  const { t: tr } = useTelegramLocale();
  const dialog = useRef<HTMLDialogElement>(null);
  const generation = useRef(0);
  const title = useId();
  const [base, setBase] = useState<PollVoteGraph>();
  const [detail, setDetail] = useState<PollVoteGraph>();
  const [point, setPoint] = useState(0);
  const [basePoint, setBasePoint] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const graph = detail ?? base;
  const selected = graph ? Math.min(point, graph.dates.length - 1) : 0;

  async function refresh(at?: number) {
    if (busy) return;
    const current = ++generation.current;
    setBusy(true);
    setError("");
    try {
      const result = await load(at);
      if (generation.current !== current) return;
      if (!result) {
        setError(at === undefined ? "Telegram has no vote history available for this poll." : "No more detail is available for this time.");
        return;
      }
      if (at === undefined) setBase(result);
      else {
        setBasePoint(selected);
        setDetail(result);
      }
      setPoint(result.dates.length - 1);
    } catch {
      if (generation.current === current) setError("Could not load the vote history. Try again.");
    } finally {
      if (generation.current === current) setBusy(false);
    }
  }

  return <>
    <button type="button" className="mtg-action" aria-haspopup="dialog" onClick={() => {
      if (!dialog.current) return;
      dialog.current.showModal();
      void refresh();
    }}>{tr("Vote history")}</button>
    <dialog ref={dialog} aria-labelledby={title} className="mtg-instant-view mtg-poll-vote-history" onClose={() => {
      generation.current++;
      setBase(undefined);
      setDetail(undefined);
      setBusy(false);
      setError("");
    }}>
      <header>
        <h2 id={title}>{tr("Vote history")}</h2>
        <button type="button" className="mtg-action" onClick={() => dialog.current?.close()}>{tr("Close statistics")}</button>
      </header>
      <p>{question}</p>
      {busy && <p role="status">{tr("Loading vote history…")}</p>}
      {error && <p role="status">{tr(error)}</p>}
      {graph ? <>
        <VoteChart graph={graph} selected={selected} choose={setPoint} />
        {graph.dates.length > 1 && <label>{tr("Time in vote history")}<input type="range" min={0} max={graph.dates.length - 1} step={1} value={selected}
            aria-valuetext={dateLabel.format(graph.dates[selected]!)} onChange={(event) => setPoint(event.currentTarget.valueAsNumber)} />
        </label>}
        <table>
          <caption>{dateLabel.format(graph.dates[selected]!)}</caption>
          <thead><tr><th scope="col">{tr("Series")}</th><th scope="col">{tr("Votes")}</th></tr></thead>
          <tbody>{graph.series.map(({ id, name, values, color }, i) => <tr key={id}>
            <th scope="row"><span aria-hidden="true" style={{ backgroundColor: color ?? colors[i % colors.length] }} />{name}</th>
            <td>{count.format(values[selected]!)}</td>
          </tr>)}</tbody>
        </table>
        {detail ? <button type="button" className="mtg-action" onClick={() => {
          setDetail(undefined);
          setPoint(basePoint);
          setError("");
        }}>{tr("Back to vote history")}</button> : graph.zoomable &&
          <button type="button" className="mtg-action" disabled={busy} onClick={() => void refresh(graph.dates[selected])}>{tr("More detail for this time")}</button>}
      </> : error && <button type="button" className="mtg-action" onClick={() => void refresh()}>{tr("Retry vote history")}</button>}
    </dialog>
  </>;
}
