import {memo,useMemo,useState,useEffect,type CSSProperties} from 'react';
import {planLabels,planProgress,progressMarks,elapsed,type Plan} from '../core/progress';
import {Stream,STREAM_STYLE,progressLight} from './progress-stream';

const colors={running:'#7858CA',needs_input:'#AD6400',error:'#C5353E',done:'#18883A'};
export function ProgressStyles(){return <style>{STREAM_STYLE}</style>;}
function useClock(start:number|undefined,end:number|undefined,running:boolean) {
 const [now,setNow]=useState(()=>Date.now());
 useEffect(()=>{
  if(start===undefined||end!==undefined||!running)return;
  let timer:ReturnType<typeof setInterval>|undefined;
  const sync=()=>{clearInterval(timer);if(!document.hidden){setNow(Date.now());timer=setInterval(()=>setNow(Date.now()),1000);}};
  sync();document.addEventListener('visibilitychange',sync);
  return ()=>{clearInterval(timer);document.removeEventListener('visibilitychange',sync);};
 },[start,end,running]);
 return end??now;
}
function StepTime({start,end,running}:{start?:number;end?:number;running:boolean}) {
 const now=useClock(start,end,running);
 return start===undefined?null:<span className="step-duration">{elapsed(now-start)}</span>;
}
function PlanClock({plan,head=false,percent=0}:{plan:Plan;head?:boolean;percent?:number}) {
 const now=useClock(plan.createdAt,plan.endedAt,plan.state!=='done');
 const current=useMemo(()=>plan.stages.flatMap(s=>s.steps).find(s=>s.status==='active'),[plan]);
 if(plan.createdAt===undefined)return null;
 const duration=elapsed(now-plan.createdAt);
 const clock=`Всего: ${duration}${current?.startedAt===undefined?'':' · Шаг: '+elapsed((current.endedAt??now)-current.startedAt)}`;
 return head?<span tabIndex={0} role="img" aria-label={clock} title={clock} className="plan-head mspp-glide" style={{left:`clamp(4px, ${percent}%, calc(100% - 4px))`}}/>:<span className="progress-clock" title={clock}>{duration}</span>;
}
const completedStage=(stage:Plan['stages'][number])=>stage.steps.length>0&&stage.steps.every(step=>step.status==='done'||step.status==='skipped');
const PlanDetails=memo(function PlanDetails({plan,showCompleted}:{plan:Plan;showCompleted:boolean}) {
 return <div className="plan-steps"><strong>{plan.title}</strong><span className={`state-badge plan-${plan.state}`}>{planLabels[plan.state]}</span>
   {plan.note?<p>{plan.note}</p>:null}
   {plan.stages.filter(stage=>showCompleted||!completedStage(stage)).map((stage,i)=><div key={i}>{stage.name?<h4>{stage.name}</h4>:null}<ul>{stage.steps.map((step,j)=><li key={j} data-state={step.status}><span aria-hidden="true" className="step-dot"/>{step.title}<StepTime start={step.startedAt} end={step.endedAt??plan.endedAt} running={plan.state!=='done'}/><span className="step-state">{{pending:'Не начат',active:'В работе',done:'Готово',error:'Ошибка',skipped:'Пропущен'}[step.status]}</span></li>)}</ul></div>)}
  </div>;
});
export function PlanStrip({plan,effects=true,status,extraPlans=[],showCompleted=true}:{plan:Plan;effects?:boolean;status?:{label:string;state:string};extraPlans?:readonly Plan[];showCompleted?:boolean}) {
 const [expanded,setExpanded]=useState(false);
 const progress=useMemo(()=>planProgress(plan),[plan]);
 const marks=useMemo(()=>progressMarks(plan),[plan]);
 const color=colors[plan.state];
 const label=plan.id==='subthread-aggregate'?`Общий прогресс субтредов${plan.note?' · '+plan.note:''}`:((plan.state==='needs_input'||plan.state==='error')&&plan.note)||[progress.stage,progress.step].filter(Boolean).join(' → ')||plan.title;
 return <details className="thread-progress" style={{'--plan-color':color} as CSSProperties} onToggle={event=>{if(event.target===event.currentTarget)setExpanded(event.currentTarget.open);}}>
  <summary title={`${plan.title}: ${label}`}><span className="progress-heading"><span className="progress-caption">{label}</span><PlanClock plan={plan}/><span className="progress-fraction">{progress.total?`${progress.done}/${progress.total}`:'—'}</span>{extraPlans.length?<span className="extra-plan-count" title={`Ещё планов: ${extraPlans.length}`} aria-label={`Ещё планов: ${extraPlans.length}`}>+{extraPlans.length}</span>:null}</span>
  <div className="plan-line">
  <div className="plan-track" role="progressbar" aria-label={`${plan.title}: ${planLabels[plan.state]}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress.total?progress.percent:undefined} aria-valuetext={`${progress.done} из ${progress.total} шагов; ${label}`}>
   <div className="mspp-glide plan-fill" style={{width:`${progress.percent}%`}}><Stream bar={plan} light={progressLight(color)} effects={effects&&plan.state==='running'}/></div>
   {marks.map((mark,index)=><span key={index} tabIndex={0} role="img" aria-label={mark.label} title={mark.label} className={`plan-mark${mark.isStage?' stage-mark':''}`} style={{left:`${mark.at*100}%`}}/>)}
   <PlanClock plan={plan} head percent={progress.percent}/>
  </div>{status?<span className={`state-badge plan-${status.state}`}>{status.label}</span>:null}</div></summary>
  {expanded?<PlanDetails plan={plan} showCompleted={showCompleted}/>:null}
  {expanded&&extraPlans.length?<div className="additional-plans" aria-label="Остальные планы">{extraPlans.map(other=><div key={other.id}><div className="additional-plan-title">{other.title}</div><PlanStrip plan={other} effects={effects} showCompleted={showCompleted}/></div>)}</div>:null}
 </details>;
}
export function ThreadProgress({plans,effects=true,status}:{plans:readonly Plan[];effects?:boolean;status?:{label:string;state:string}}) {
 const [showCompleted,setShowCompleted]=useState(false);
 const visible=plans.filter(plan=>showCompleted||plan.state!=='done');
 const hasCompleted=plans.some(plan=>plan.state==='done'||plan.stages.some(completedStage));
 if(!plans.length)return null;
 return <div className="thread-plans">{visible.length?<PlanStrip plan={visible[0]!} effects={effects} status={status} extraPlans={visible.slice(1)} showCompleted={showCompleted}/>:null}{hasCompleted?<button type="button" className="completed-plans-toggle" aria-pressed={showCompleted} onClick={()=>setShowCompleted(value=>!value)}>{showCompleted?'Скрыть готовые':'Показать готовые'}</button>:null}</div>;
}
