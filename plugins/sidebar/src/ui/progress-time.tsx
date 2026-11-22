import {useEffect,useState} from 'react';
import {elapsed} from '../core/progress';
/** Tick only the small time readout; never the plan/step tree. */
export function useClock(start:number|undefined,end:number|undefined,running:boolean) {
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
export function StepTime({start,end,running}:{start?:number;end?:number;running:boolean}) {
 const now=useClock(start,end,running);
 return start===undefined?null:<span className="step-duration">{elapsed(now-start)}</span>;
}
