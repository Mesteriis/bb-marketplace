import {ageLabel} from '../core/work-status';
import {useClock} from './progress-time';
export function ProgressFreshness({updatedAt,checkedAt,failed,running,onRefresh}:{updatedAt?:number;checkedAt?:number;failed:boolean;running:boolean;onRefresh:()=>void}) {
 const now=useClock(updatedAt??checkedAt,undefined,true);
 const stale=updatedAt!==undefined&&running&&now-updatedAt>=180000;
 return <div className={'progress-freshness'+(stale||failed?' stale':'')}><span>{failed?'Не удалось перечитать план':updatedAt===undefined?'План пока не создан':`${stale?'План не обновлялся':'Обновлён'} ${ageLabel(now-updatedAt)}${stale?'':' назад'}`}</span>{stale||failed||updatedAt===undefined?<button type="button" onClick={onRefresh} title={checkedAt?`Последняя успешная проверка: ${ageLabel(now-checkedAt)} назад`:undefined}>Проверить ↻</button>:null}</div>;
}
