import {useState,type CSSProperties} from 'react';
import {planLabels,planProgress,type Plan} from '../core/progress';
import {Stream,STREAM_STYLE,progressLight} from './progress-stream';

const colors={running:'#7858CA',needs_input:'#AD6400',error:'#C5353E',done:'#18883A'};
export function ProgressStyles(){return <style>{STREAM_STYLE}</style>;}
export function PlanStrip({plan,effects=true,status,extraPlans=[]}:{plan:Plan;effects?:boolean;status?:{label:string;state:string};extraPlans?:readonly Plan[]}) {
 const [expanded,setExpanded]=useState(false);
 const progress=planProgress(plan);
 const color=colors[plan.state];
 const steps=plan.stages.flatMap(s=>s.steps);
 const label=((plan.state==='needs_input'||plan.state==='error')&&plan.note)||[progress.stage,progress.step].filter(Boolean).join(' → ')||plan.title;
 let mark=0;
 return <details className="thread-progress" style={{'--plan-color':color} as CSSProperties} onToggle={event=>{if(event.target===event.currentTarget)setExpanded(event.currentTarget.open);}}>
  <summary title={`${plan.title}: ${label}`}><span className="progress-heading"><span className="progress-caption">{label}</span><span className="progress-fraction">{progress.done}/{progress.total}</span>{extraPlans.length?<span className="extra-plan-count" title={`Ещё планов: ${extraPlans.length}`} aria-label={`Ещё планов: ${extraPlans.length}`}>+{extraPlans.length}</span>:null}</span>
  <div className="plan-line">
  <div className="plan-track" role="progressbar" aria-label={`${plan.title}: ${planLabels[plan.state]}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress.percent} aria-valuetext={`${progress.done} из ${progress.total} шагов; ${label}`}>
   <div className="mspp-glide plan-fill" style={{width:`${progress.percent}%`}}><Stream bar={plan} light={progressLight(color)} effects={effects&&plan.state==='running'}/></div>
   {plan.stages.flatMap(stage=>stage.steps.map((step,index)=>{
    const position=++mark;
    return position<steps.length?<span key={position} title={`${stage.name}: ${step.title}`} className={`plan-mark${index===stage.steps.length-1?' stage-mark':''}`} style={{left:`${position/steps.length*100}%`}}/>:null;
   }))}
  </div>{status?<span className={`state-badge plan-${status.state}`}>{status.label}</span>:null}</div></summary>
  <div className="plan-steps"><strong>{plan.title}</strong><span className={`state-badge plan-${plan.state}`}>{planLabels[plan.state]}</span>
   {plan.note?<p>{plan.note}</p>:null}
   {plan.stages.map((stage,i)=><div key={i}>{stage.name?<h4>{stage.name}</h4>:null}<ul>{stage.steps.map((step,j)=><li key={j} data-state={step.status}><span aria-hidden="true" className="step-dot"/>{step.title}<span className="step-state">{{pending:'Не начат',active:'В работе',done:'Готово',error:'Ошибка',skipped:'Пропущен'}[step.status]}</span></li>)}</ul></div>)}
  </div>
  {expanded&&extraPlans.length?<div className="additional-plans" aria-label="Остальные планы">{extraPlans.map(other=><div key={other.id}><div className="additional-plan-title">{other.title}</div><PlanStrip plan={other} effects={effects}/></div>)}</div>:null}
 </details>;
}
export function ThreadProgress({plans,effects=true,status}:{plans:readonly Plan[];effects?:boolean;status?:{label:string;state:string}}) {
 if(!plans.length)return null;
 return <div className="thread-plans"><PlanStrip plan={plans[0]!} effects={effects} status={status} extraPlans={plans.slice(1)}/></div>;
}
