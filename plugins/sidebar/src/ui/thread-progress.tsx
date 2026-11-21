import {memo,useMemo,useState,type CSSProperties} from 'react';
import {planLabels,planProgress,type Plan} from '../core/progress';
import {STREAM_STYLE} from './progress-stream';
import {PlanTrack,PLAN_TRACK_STYLE} from './plan-track';
import {StepTime} from './progress-time';

const colors={running:'#7858CA',needs_input:'#AD6400',error:'#C5353E',done:'#18883A'};
export function ProgressStyles(){return <style>{STREAM_STYLE}{PLAN_TRACK_STYLE}</style>;}
const completedStage=(stage:Plan['stages'][number])=>stage.steps.length>0&&stage.steps.every(step=>step.status==='done'||step.status==='skipped');
const PlanDetails=memo(function PlanDetails({plan,showCompleted}:{plan:Plan;showCompleted:boolean}) {
 return <div className="plan-steps"><strong>{plan.title}</strong><span className={`state-badge plan-${plan.state}`}>{planLabels[plan.state]}</span>
   {plan.note?<p>{plan.note}</p>:null}
   {plan.stages.filter(stage=>showCompleted||!completedStage(stage)).map((stage,i)=><div key={i}>{stage.name?<h4>{stage.name}</h4>:null}<ul>{stage.steps.map((step,j)=><li key={j} data-state={step.status}><span aria-hidden="true" className="step-dot"/>{step.title}<StepTime start={step.status==='pending'?undefined:step.startedAt} end={step.endedAt??plan.endedAt} running={plan.state!=='done'}/><span className="step-state">{{pending:'Не начат',active:'В работе',done:'Готово',error:'Ошибка',skipped:'Пропущен'}[step.status]}</span></li>)}</ul></div>)}
  </div>;
});
export function PlanStrip({plan,effects=true,status,extraPlans=[],showCompleted=true}:{plan:Plan;effects?:boolean;status?:{label:string;state:string;onActivate?:()=>void};extraPlans?:readonly Plan[];showCompleted?:boolean}) {
 const [expanded,setExpanded]=useState(false);
 const progress=useMemo(()=>planProgress(plan),[plan]);
 const color=colors[plan.state];
 const label=plan.id==='subthread-aggregate'?`Общий прогресс субтредов${plan.note?' · '+plan.note:''}`:((plan.state==='needs_input'||plan.state==='error')&&plan.note)||[progress.stage,progress.step].filter(Boolean).join(' → ')||plan.title;
 return <details className="thread-progress" style={{'--plan-color':color} as CSSProperties} onToggle={event=>{if(event.target===event.currentTarget)setExpanded(event.currentTarget.open);}}>
  <summary title={`${plan.title}: ${label}`}><span className="progress-heading"><span className="progress-caption">{label}</span><span className="progress-fraction">{progress.total?`${progress.done}/${progress.total}`:'—'}</span>{extraPlans.length?<span className="extra-plan-count" title={`Ещё планов: ${extraPlans.length}`} aria-label={`Ещё планов: ${extraPlans.length}`}>+{extraPlans.length}</span>:null}</span>
  <div className="plan-line">
  <PlanTrack plan={plan} effects={effects} compact/>{status?(status.onActivate?<button type="button" className={`state-badge plan-${status.state}`} title="Открыть нужный субтред" onClick={event=>{event.preventDefault();event.stopPropagation();status.onActivate?.();}}>{status.label} ↗</button>:<span className={`state-badge plan-${status.state}`}>{status.label}</span>):null}</div></summary>
  {expanded?<PlanDetails plan={plan} showCompleted={showCompleted}/>:null}
  {expanded&&extraPlans.length?<div className="additional-plans" aria-label="Остальные планы">{extraPlans.map(other=><div key={other.id}><div className="additional-plan-title">{other.title}</div><PlanStrip plan={other} effects={effects} showCompleted={showCompleted}/></div>)}</div>:null}
 </details>;
}
export function ThreadProgress({plans,effects=true,status}:{plans:readonly Plan[];effects?:boolean;status?:{label:string;state:string;onActivate?:()=>void}}) {
 const [showCompleted,setShowCompleted]=useState(false);
 const visible=plans.filter(plan=>showCompleted||plan.state!=='done');
 const hasCompleted=plans.some(plan=>plan.state==='done'||plan.stages.some(completedStage));
 if(!plans.length)return null;
 return <div className="thread-plans">{visible.length?<PlanStrip plan={visible[0]!} effects={effects} status={status} extraPlans={visible.slice(1)} showCompleted={showCompleted}/>:null}{hasCompleted?<button type="button" className="completed-plans-toggle" aria-pressed={showCompleted} onClick={()=>setShowCompleted(value=>!value)}>{showCompleted?'Скрыть готовые':'Показать готовые'}</button>:null}</div>;
}
