// Adapted from Plan Progress 0.6.0 (MIT, Yuri Smirnov).
// One track implementation for the composer and sidebar; see THIRD_PARTY_NOTICES.md.
import {memo,useMemo,type CSSProperties} from 'react';
import {compactProgressMarks,elapsed,planLabels,planProgress,progressMarks,type Plan} from '../core/progress';
import {Stream,hex,mix,rgb,WHITE,progressLight} from './progress-stream';
import {useClock} from './progress-time';
export const PLAN_COLORS={running:'#7858CA',needs_input:'#AD6400',error:'#C5353E',done:'#18883A'};
export const PLAN_ICONS:Partial<Record<Plan['state'],string>>={needs_input:'M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3M12 17h.01',error:'M18 6 6 18M6 6l12 12',done:'M20 6 9 17l-5-5'};
function Head({plan,percent,compact}:{plan:Plan;percent:number;compact:boolean}) {
 const now=useClock(plan.createdAt,plan.endedAt,plan.state!=='done');
 const where=useMemo(()=>{
  const steps=plan.stages.flatMap(s=>s.steps);
  const index=steps.findIndex(s=>s.status==='active'||s.status==='error');
  const selected=index<0?steps.findIndex(s=>s.status==='pending'):index;
  let start=0,stage=plan.stages.length-1;
  for(let i=0;i<plan.stages.length;i++){if(selected>=start&&selected<start+plan.stages[i]!.steps.length){stage=i;break;}start+=plan.stages[i]!.steps.length;}
  return {step:steps[selected],stepTitle:steps[selected]?.title,stage:plan.stages[stage]?.name??'',first:selected===start};
 },[plan]);
 const duration=plan.createdAt===undefined?null:elapsed(now-plan.createdAt);
 const stepDuration=where.step?.startedAt===undefined?null:elapsed((where.step.endedAt??now)-where.step.startedAt);
 const asks=(plan.state==='needs_input'||plan.state==='error')&&plan.note;
 const single=plan.stages.length===1;
 const label=asks||(plan.state==='done'?(duration??planLabels.done):single?(where.stage||where.stepTitle||plan.title):where.stage)||plan.title;
 const step=asks||plan.state==='done'||(single&&!where.stage)?undefined:where.stepTitle;
 const clock=[duration?`Всего: ${duration}`:null,stepDuration?`Шаг: ${stepDuration}`:null].filter(Boolean).join(' · ');
 const icon=PLAN_ICONS[plan.state];
 return <span className="mspp-glide pp-track-head" tabIndex={0} role="img" aria-label={clock||`${label}${step?' · '+step:''}`} title={[label,step,clock].filter(Boolean).join(' · ')} style={{left:`${percent}%`,transform:`translateX(-${percent}%)`,backgroundColor:PLAN_COLORS[plan.state],fontSize:compact?10:12}}>
  {icon?<svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true"><path d={icon} fill="none" stroke="currentColor" strokeWidth="3.6" strokeLinecap="round" strokeLinejoin="round"/></svg>:null}
  <span className="pp-head-label"><span>{label}</span>{step&&step!==label?<><i className={where.first?'pp-stage-separator':'pp-step-separator'}/><span>{step}</span></>:null}</span>
  {duration?<span className="pp-head-clock">{duration}</span>:null}
 </span>;
}
export const PlanTrack=memo(function PlanTrack({plan,effects=true,compact=false}:{plan:Plan;effects?:boolean;compact?:boolean}) {
 const progress=useMemo(()=>planProgress(plan),[plan]);
 const marks=useMemo(()=>compact?compactProgressMarks(plan):progressMarks(plan),[plan,compact]);
 const color=PLAN_COLORS[plan.state],light=progressLight(color);
 const percent=plan.state==='done'?100:progress.percent;
 const fill:CSSProperties={width:`${percent}%`,background:`linear-gradient(90deg, ${rgb(hex(color),.05)}, ${rgb(hex(color),.33)})`};
 return <div className={`pp-track${compact?' pp-track-compact':''}`} style={{height:compact?20:22}} role="progressbar" aria-label={`${plan.title}: ${planLabels[plan.state]}${progress.step?', '+progress.step:''}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress.total?percent:undefined} aria-valuetext={`${progress.done} из ${progress.total} шагов; ${[progress.stage,progress.step].filter(Boolean).join(' → ')}`}>
  <div className="pp-track-background"><div className="mspp-glide pp-track-fill" style={fill}><Stream bar={plan} light={light} effects={effects}/></div></div>
  {marks.map((mark,index)=><span key={index} tabIndex={0} role="img" aria-label={mark.label} title={mark.label} className={`pp-track-mark${mark.isStage?' pp-track-stage':''}${mark.passed?' pp-track-passed':''}`} style={{left:`${mark.at*100}%`,'--passed-color':rgb(mix(light,WHITE,.45),.9)} as CSSProperties}>
   <span className="pp-track-tick"/><span className="pp-track-tip" style={mark.at<.25?{left:0,transform:'none'}:mark.at>.75?{left:'auto',right:0,transform:'none'}:undefined}>{mark.label}</span>
  </span>)}
  <Head plan={plan} percent={percent} compact={compact}/>
 </div>;
});
export const PLAN_TRACK_STYLE=`
.pp-track{position:relative;min-width:0;flex:1;isolation:isolate}
.pp-track-background{position:absolute;inset:0;border-radius:999px;overflow:hidden;background:rgba(128,128,128,.16)}
.pp-track-fill{position:absolute;inset:0 auto 0 0;overflow:hidden}
.pp-track-mark{position:absolute;top:0;bottom:0;width:10px;transform:translateX(-50%);display:flex;align-items:center;justify-content:center}
.pp-track-tick{width:3px;height:3px;border-radius:999px;background:rgba(168,166,158,.85)}
.pp-track-stage .pp-track-tick{height:10px}.pp-track-passed .pp-track-tick{background:var(--passed-color)}
.pp-track-tip{position:absolute;bottom:100%;left:50%;transform:translateX(-50%);z-index:20;margin-bottom:4px;padding:3px 7px;border-radius:7px;background:var(--popover,var(--background,#242434));color:var(--popover-foreground,var(--foreground,#ddd));box-shadow:0 2px 8px #0005;border:1px solid var(--border,#555);font-size:11px;line-height:1.4;white-space:pre-line;width:max-content;max-width:230px;overflow-wrap:anywhere;opacity:0;pointer-events:none;transition:opacity .12s}
.pp-track-mark:hover .pp-track-tip,.pp-track-mark:focus-visible .pp-track-tip{opacity:1}
.pp-track-head{position:absolute;inset-block:0;max-width:55%;box-sizing:border-box;border-radius:999px;padding:0 9px;display:flex;align-items:center;gap:5px;color:white;white-space:nowrap;z-index:1;font-weight:500}
.pp-track-head svg{flex-shrink:0}.pp-head-label{display:flex;align-items:center;gap:5px;min-width:0}.pp-head-label>span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.pp-head-label>span:first-child{flex-shrink:1}.pp-head-label>span:last-child{min-width:0}
.pp-head-clock{display:none;font-variant-numeric:tabular-nums}.pp-track:hover .pp-head-clock,.pp-track:focus-within .pp-head-clock{display:inline}.pp-track:has(.pp-head-clock):hover .pp-head-label,.pp-track:has(.pp-head-clock):focus-within .pp-head-label{display:none}
.pp-stage-separator{height:10px;width:2px;background:#fffb;border-radius:2px;flex-shrink:0}.pp-step-separator{height:3px;width:3px;background:#fffc;border-radius:50%;flex-shrink:0}
.pp-track-head:focus-visible,.pp-track-mark:focus-visible{outline:1px solid currentColor;outline-offset:1px}.pp-track-mark:hover,.pp-track-mark:focus-visible{z-index:3}
@keyframes pp-step-pulse{50%{opacity:.5}}
.makosh-sidebar .plan-steps li[data-state=active] .step-dot{animation:pp-step-pulse 2s cubic-bezier(.4,0,.6,1) infinite}
.makosh-sidebar .plan-steps li[data-state=pending],.makosh-sidebar .plan-steps li[data-state=done],.makosh-sidebar .plan-steps li[data-state=skipped]{color:var(--muted-foreground)}
.makosh-sidebar .plan-steps li[data-state=active]{font-weight:500;color:var(--foreground)}
.makosh-sidebar .plan-steps li[data-state=error]{color:var(--plan-error)}
@media(prefers-reduced-motion:reduce){.pp-track-tip{transition:none}.makosh-sidebar .plan-steps li[data-state=active] .step-dot{animation:none}}
`;
