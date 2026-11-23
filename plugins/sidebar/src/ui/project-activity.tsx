import {useId, useState} from 'react';
import type {ProjectActivity} from '../core/project-activity';
import './project-activity.css';

type Day = ProjectActivity['days'][number];
type SeriesKey = 'input' | 'output' | 'created' | 'archived';
type Series = {key: SeriesKey; label: string; tone: 'primary' | 'secondary'};
const tokenSeries: readonly Series[] = [
    {key: 'input', label: 'Входные', tone: 'primary'},
    {key: 'output', label: 'Выходные', tone: 'secondary'},
];
const threadSeries: readonly Series[] = [
    {key: 'created', label: 'Созданные', tone: 'primary'},
    {key: 'archived', label: 'В текущем архиве', tone: 'secondary'},
];
const number = new Intl.NumberFormat('ru-RU');
const compact = new Intl.NumberFormat('ru-RU', {notation: 'compact', maximumFractionDigits: 1});
const date = new Intl.DateTimeFormat('ru-RU', {day: 'numeric', month: 'short', timeZone: 'UTC'});
const formatDay = (day: string) => date.format(new Date(day));
const sum = (days: Day[], key: keyof Omit<Day, 'day'>) => days.reduce((total, day) => total + day[key], 0);

function ActivityPlot({days, series, title, selected, onSelect}: {
    days: Day[]; series: readonly Series[]; title: string; selected: number; onSelect: (index: number) => void;
}) {
    const id = useId();
    const left = 56, right = 696, top = 21, bottom = 194;
    const step = (right - left) / (days.length - 1);
    const highest = Math.max(1, ...series.flatMap(({key}) => days.map(day => day[key])));
    const tick = Math.ceil(highest / 4);
    const x = (index: number) => left + index * step;
    const axisLabels = new Set([0, 1, 2, 3, 4].map(tick => Math.round(tick * (days.length - 1) / 4)));
    const y = (value: number) => bottom - value / (tick * 4) * (bottom - top);

    return <div className="overview-plot-scroll">
        <svg role="img" aria-label={title} viewBox="0 0 720 226" className="overview-plot">
            <defs>{series.map(({tone}) => <linearGradient key={tone} id={id + tone} x2="0" y2="1">
                <stop className={'plot-' + tone} offset="0%" stopColor="currentColor" stopOpacity=".32"/>
                <stop className={'plot-' + tone} offset="100%" stopColor="currentColor" stopOpacity="0"/>
            </linearGradient>)}</defs>
            {[0, 1, 2, 3, 4].map(level => <g key={level} className="overview-plot-grid">
                <path d={`M${left} ${y(level * tick)}H${right}`}/>
                <text x={left - 8} y={y(level * tick)} textAnchor="end" dominantBaseline="middle">{compact.format(level * tick)}</text>
            </g>)}
            {days.map((day, index) => axisLabels.has(index)
                && <text className="overview-plot-label" x={x(index)} y="216" key={day.day}
                    textAnchor={index === 0 ? 'start' : index === days.length - 1 ? 'end' : 'middle'}>{formatDay(day.day)}</text>)}
            <g className="overview-plot-series">{series.map(({key, tone}) => {
                const points = days.map((day, index) => `${x(index)},${y(day[key])}`).join(' ');
                return <g key={key} className={'plot-' + tone}>
                    <polygon points={`${left},${bottom} ${points} ${right},${bottom}`} fill={`url(#${id}${tone})`}/>
                    <polyline points={points} fill="none" stroke="currentColor" className="overview-plot-line"/>
                </g>;
            })}</g>
            <path className="overview-plot-marker" d={`M${x(selected)} ${top}V${bottom}`}/>
            {series.map(({key, tone}) => <circle key={key} className={`overview-plot-dot plot-${tone}`}
                cx={x(selected)} cy={y(days[selected][key])} r="4" fill="currentColor"/>)}
            {days.map((day, index) => <rect key={day.day} x={x(index) - step / 2} y={top} width={step}
                height={bottom - top} fill="transparent" onPointerEnter={() => onSelect(index)} onClick={() => onSelect(index)}/>)}
        </svg>
    </div>;
}

export function ProjectActivityChart({data}: {data: ProjectActivity}) {
    const [period, setPeriod] = useState(7);
    const [mode, setMode] = useState<'tokens' | 'threads'>('tokens');
    const [selectedDay, setSelectedDay] = useState('');
    const days = data.days.slice(-period);
    const selected = days.findIndex(day => day.day === selectedDay);
    const index = selected < 0 ? days.length - 1 : selected;
    const day = days[index];
    const tokens = mode === 'tokens';
    const series = tokens ? tokenSeries : threadSeries;
    const title = tokens ? 'Потребление токенов' : 'Активность тредов';
    const hasUsage = sum(days, 'samples') > 0;
    const input = sum(days, 'input');
    const output = sum(days, 'output');
    const cached = sum(days, 'cached');
    const share = input ? cached / input * 100 : 0;

    return <div className="overview-activity-body">
        <div className="overview-activity-controls">
            <div role="group" aria-label="Метрика">
                <button type="button" aria-pressed={tokens} onClick={() => setMode('tokens')}>Токены</button>
                <button type="button" aria-pressed={!tokens} onClick={() => setMode('threads')}>Активность</button>
            </div>
            <label>Период{' '}<select value={period} onChange={event => setPeriod(Number(event.target.value))}>
                <option value={7}>7 дней</option><option value={14}>14 дней</option>
            </select></label>
        </div>
        {tokens && !hasUsage ? <p role="status">За этот период BB не записал расход токенов.</p> : <>
            <div className="overview-activity-legend">
                <h3>{title}</h3>
                {tokens && <span>Всего <strong>{number.format(input + output)}</strong></span>}
                {series.map(({key, tone, label}) => <span key={key} className={'plot-' + tone}>
                    <i aria-hidden="true"/>{label} <strong>{number.format(sum(days, key))}</strong>
                </span>)}
            </div>
            <ActivityPlot key={mode + period} title={title} days={days} selected={index} series={series}
                onSelect={next => setSelectedDay(days[next].day)}/>
            <div className="overview-activity-day">
                <label>День{' '}<select value={day.day} onChange={event => setSelectedDay(event.target.value)}>
                    {days.map(item => <option key={item.day} value={item.day}>{formatDay(item.day)}</option>)}
                </select></label>
                <span>{tokens && !day.samples ? 'Нет записей' : series.map(({key, label}) =>
                    `${label} ${number.format(day[key])}`).join(' · ')} · UTC</span>
            </div>
            {tokens && <div className="overview-cache">
                <div><h3>Входные токены из кэша</h3><strong>{Math.round(share)}%</strong></div>
                <span className="overview-cache-track" aria-hidden="true"><i style={{width: share + '%'}}/></span>
                <small>{number.format(cached)} из {number.format(input)} входных</small>
            </div>}
        </>}
    </div>;
}
