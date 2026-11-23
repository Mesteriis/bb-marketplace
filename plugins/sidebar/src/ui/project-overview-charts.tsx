import {useId} from 'react';
import {overviewGroups, type overviewTotals, type ProjectOverviewData} from '../core/project-overview';

const labels = {
    unarchivedVisible: 'Вне архива / видимые',
    unarchivedHidden: 'Вне архива / скрытые',
    archivedVisible: 'В архиве / видимые',
    archivedHidden: 'В архиве / скрытые',
};

function share(value: number, total: number) {
    return total ? value / total * 100 : 0;
}

export function ProjectOverviewDistribution({stats}: {stats: ReturnType<typeof overviewTotals>}) {
    const title = useId();
    const rows = [
        {first: 'Вне архива', second: 'В архиве', left: stats.unarchived, right: stats.archived},
        {first: 'Видимые', second: 'Скрытые', left: stats.visible, right: stats.hidden},
        {first: 'Родительские', second: 'Подчинённые', left: stats.parent, right: stats.child},
    ];

    return <section className="overview-card overview-distribution" aria-labelledby={title}>
        <header className="overview-section-header"><h2 id={title}>Распределение тредов</h2></header>
        <ul className="overview-distribution-bars" role="list">
            {rows.map(({first, second, left, right}) => <li key={first}>
                <div className="overview-distribution-labels">
                    <span><i className="overview-distribution-first" aria-hidden="true"/>{first} <strong>{left}</strong></span>
                    <span><i className="overview-distribution-second" aria-hidden="true"/>{second} <strong>{right}</strong></span>
                </div>
                <div className="overview-distribution-track" aria-hidden="true">
                    <div className="overview-stacked-bar">
                        <i className="overview-distribution-first" style={{width: `${share(left, stats.total)}%`}}/>
                        <i className="overview-distribution-second" style={{width: `${share(right, stats.total)}%`}}/>
                    </div>
                </div>
            </li>)}
        </ul>
        {stats.total > 0 && <div className="overview-highlights">
            <span>{Math.round(share(stats.hidden, stats.total))}% тредов скрыты</span>
            <span>{Math.round(share(stats.child, stats.total))}% — субтреды</span>
        </div>}
    </section>;
}

export function ProjectOverviewBreakdown({groups}: {groups: ProjectOverviewData['groups']}) {
    return <section className="overview-card">
        <header className="overview-section-header"><h2>Архив и видимость</h2></header>
        <div className="overview-table-scroll">
            <table aria-label="Разбивка тредов">
                <thead><tr>
                    <th scope="col">Группа</th>
                    <th scope="col">Родительские</th>
                    <th scope="col">Подчинённые</th>
                    <th scope="col">Всего</th>
                </tr></thead>
                <tbody>{overviewGroups.map(key => {
                    const {parent, child} = groups[key];
                    return <tr key={key}><th scope="row">{labels[key]}</th><td>{parent}</td><td>{child}</td><td>{parent + child}</td></tr>;
                })}</tbody>
            </table>
        </div>
    </section>;
}
