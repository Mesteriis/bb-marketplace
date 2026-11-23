import type {CSSProperties} from 'react';
import {overviewGroups, overviewTotals, type ProjectOverviewData} from '../core/project-overview';

const labels = {
    unarchivedVisible: 'Вне архива / видимые',
    unarchivedHidden: 'Вне архива / скрытые',
    archivedVisible: 'В архиве / видимые',
    archivedHidden: 'В архиве / скрытые',
};

function scale(value: number, total: number) {
    return total ? value / total * 100 : 0;
}

function Ring({title, first, second}: {title: string; first: [string, number]; second: [string, number]}) {
    const total = first[1] + second[1];
    return <section className="overview-chart">
        <h3>{title}</h3>
        <div className="overview-ring" style={{'--ring-share': `${scale(first[1], total) * 3.6}deg`} as CSSProperties} data-empty={!total}>
            <span><strong>{total}</strong>всего</span>
        </div>
        <dl className="overview-legend">
            <dt><i className="legend-primary"/>{first[0]}</dt><dd>{first[1]}</dd>
            <dt><i className="legend-secondary"/>{second[0]}</dt><dd>{second[1]}</dd>
        </dl>
    </section>;
}

function Bar({value, max, tone = 'primary'}: {value: number; max: number; tone?: 'primary' | 'secondary'}) {
    return <span className="overview-bar-track" aria-hidden="true">
        <span className={`overview-bar ${tone}`} style={{width: `${scale(value, max)}%`}}/>
    </span>;
}

export function ProjectOverviewCharts({groups}: {groups: ProjectOverviewData['groups']}) {
    const stats = overviewTotals(groups);
    const splitMax = Math.max(stats.parent, stats.child);
    const breakdownMax = Math.max(...overviewGroups.map(key => groups[key].parent + groups[key].child));

    return <section className="overview-card overview-distribution">
        <header className="overview-section-header">
            <h2>Распределение тредов</h2>
            {stats.total > 0 && <div className="overview-highlights">
                <span>{Math.round(scale(stats.hidden, stats.total))}% тредов скрыты</span>
                <span>{Math.round(scale(stats.child, stats.total))}% — субтреды</span>
            </div>}
        </header>
        <div className="overview-chart-grid">
            <Ring title="Архивность" first={['Архивные', stats.archived]} second={['Вне архива', stats.unarchived]}/>
            <Ring title="Видимость" first={['Скрытые', stats.hidden]} second={['Видимые', stats.visible]}/>
            <section className="overview-chart overview-parents">
                <h3>Родители и субтреды</h3>
                <dl>
                    <dt>Родители</dt><dd><Bar value={stats.parent} max={splitMax}/><strong>{stats.parent}</strong></dd>
                    <dt>Субтреды</dt><dd><Bar value={stats.child} max={splitMax}/><strong>{stats.child}</strong></dd>
                </dl>
            </section>
            <section className="overview-chart overview-breakdown">
                <h3>Разбивка по архиву и видимости</h3>
                <div className="overview-table-scroll">
                    <table aria-label="Разбивка тредов">
                        <thead><tr><th scope="col">Группа</th><th scope="col">Род.</th><th scope="col">Суб.</th><th scope="col">Всего</th><th className="overview-bar-column" scope="col" aria-label="Распределение"/></tr></thead>
                        <tbody>{overviewGroups.map(key => {
                            const {parent, child} = groups[key];
                            return <tr key={key}><th scope="row">{labels[key]}</th><td>{parent}</td><td>{child}</td><td>{parent + child}</td>
                                <td><div className="overview-stacked-bar" aria-hidden="true">
                                    <i className="legend-primary" style={{width: `${scale(parent, breakdownMax)}%`}}/>
                                    <i className="legend-secondary" style={{width: `${scale(child, breakdownMax)}%`}}/>
                                </div></td></tr>;
                        })}</tbody>
                    </table>
                    <div className="overview-bar-legend"><span><i className="legend-primary"/>Родители</span><span><i className="legend-secondary"/>Субтреды</span></div>
                </div>
            </section>
        </div>
    </section>;
}
