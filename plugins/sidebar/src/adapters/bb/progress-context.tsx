import {createContext,useCallback,useContext,useEffect,useMemo,useRef,useState,type ReactNode} from 'react';
import {useRpc,useRealtime} from '@get-bb/plugin-sdk/app';
import type {contract} from '../../../server';
import {aggregateProgress,type Plan,type ProgressResult,type ProgressThread} from '../../core/progress';

type Entry={plans:Plan[];failed:boolean};
// A hung transport must not stop the recovery loop forever.
async function bounded<T>(request:Promise<T>):Promise<T> {
 let timer:ReturnType<typeof setTimeout>|undefined;
 try {return await Promise.race([request,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('Progress request timed out')),10000);})]);}
 finally {clearTimeout(timer);}
}
type Attention=Record<string,'needs_input'|'error'>;
const Context=createContext<{register:(id:string)=>()=>void;entries:Record<string,Entry>;availability:ProgressResult['availability']|null;attention:Attention;incomplete:boolean}>({register:()=>()=>{},entries:{},availability:null,attention:{},incomplete:false});
export function ProgressProvider({children}:{children:ReactNode}) {
 const rpc=useRpc<typeof contract>();
 const [counts,setCounts]=useState<Record<string,number>>({});
 const [entries,setEntries]=useState<Record<string,Entry>>({});
 const [availability,setAvailability]=useState<ProgressResult['availability']|null>(null);
 const [attention,setAttention]=useState<Attention>({});
 const [incomplete,setIncomplete]=useState(false);
 const refreshRef=useRef<(()=>void)|null>(null);
 useRealtime('bars-changed',()=>refreshRef.current?.());
 const register=useCallback((id:string)=>{
  setCounts(old=>({...old,[id]:(old[id]??0)+1}));
  return ()=>setCounts(old=>{const next={...old};if((next[id]??0)<=1)delete next[id];else next[id]!--;return next;});
 },[]);
 const ids=Object.keys(counts).sort().join('\0');
 const rpcRef=useRef(rpc);rpcRef.current=rpc;
 useEffect(()=>{
  let live=true,inFlight=false,pending=false;
  let timer:ReturnType<typeof setTimeout>|undefined;
  const refresh=async()=>{
   if(!live||document.hidden)return;
   if(inFlight){pending=true;return;}
   pending=false;
   clearTimeout(timer);inFlight=true;
   const next:Record<string,Entry>={};
   let state:ProgressResult['availability']='ready';
   try {
    try {
     const index=await bounded(rpcRef.current.call('attention',null));
     if(live){setAttention(Object.fromEntries(index.entries.map(entry=>[entry.threadId,entry.state])));setIncomplete(index.incomplete);}
    } catch {state='unavailable';}
    if(!live)return;
    const threadIds=ids?ids.split('\0'):[];
    for(let i=0;i<threadIds.length&&live;i+=25) {
     const batch=threadIds.slice(i,i+25);
     const result=await bounded(rpcRef.current.call('progress',{threadIds:batch}));
     if(result.availability!=='ready'){state=result.availability;break;}
     for(const row of result.entries)next[row.threadId]={plans:row.plans,failed:false};
     for(const id of result.failedThreadIds)next[id]={plans:[],failed:true};
    }
   } catch {state='unavailable';}
   finally {
    inFlight=false;
    if(live){setAvailability(state);setEntries(old=>Object.fromEntries((ids?ids.split('\0'):[]).map(id=>{
      const fresh=next[id];
      return [id,fresh&&!fresh.failed?fresh:{plans:old[id]?.plans??[],failed:true}];
     })));timer=setTimeout(()=>void refresh(),pending?0:5000);}
   }
  };
  const visible=()=>{if(!document.hidden)void refresh();};
  refreshRef.current=()=>void refresh();
  void refresh();
  document.addEventListener('visibilitychange',visible);
  return ()=>{live=false;refreshRef.current=null;clearTimeout(timer);document.removeEventListener('visibilitychange',visible);};
 },[ids]);
 const value=useMemo(()=>({register,entries,availability,attention,incomplete}),[register,entries,availability,attention,incomplete]);
 return <Context.Provider value={value}>{children}</Context.Provider>;
}
export function useThreadPlans(id:string,descendants:readonly Omit<ProgressThread,'plans'>[]=[]) {
 const {register,entries,availability}=useContext(Context);
 useEffect(()=>register(id),[register,id]);
 useObserveThreadPlans(descendants.map(t=>t.id));
 const descendantsKey=JSON.stringify(descendants);
 const plans=useMemo(()=>{
  const aggregate=aggregateProgress(descendants.map(t=>({...t,plans:entries[t.id]?.plans??[]})));
  return aggregate?[aggregate,...[...(entries[id]?.plans??[])].sort((a,b)=>(a.createdAt??a.updatedAt)-(b.createdAt??b.updatedAt)||a.id.localeCompare(b.id))]:entries[id]?.plans??[];
 },[id,descendantsKey,entries]);
 return {plans,failed:entries[id]?.failed||descendants.some(t=>entries[t.id]?.failed),availability};
}
export function ProgressNotice() {
 const {availability,incomplete}=useContext(Context);
 if(incomplete)return <p className="progress-notice" role="status">Обзор вопросов и ошибок неполный: проверены первые 2000 сохранённых тредов.</p>;
 if(availability===null||availability==='ready')return null;
 return <p className="progress-notice" role="status">Не удалось обновить планы. Повторим автоматически.</p>;
}
export function usePlanningAttention(){return useContext(Context).attention;}

/** Keep active descendants observed even while their rows are folded. */
export function useObserveThreadPlans(threadIds:readonly string[]) {
 const {register}=useContext(Context);
 const ids=[...new Set(threadIds)].sort().join('\0');
 useEffect(()=>{
  const release=(ids?ids.split('\0'):[]).map(register);
  return ()=>release.forEach(unregister=>unregister());
 },[register,ids]);
}
