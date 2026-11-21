import {createContext,useCallback,useContext,useEffect,useMemo,useRef,useState,type ReactNode} from 'react';
import {useRpc,useRealtime} from '@get-bb/plugin-sdk/app';
import type {contract} from '../../../server';
import type {Plan,ProgressResult} from '../../core/progress';

type Entry={plans:Plan[];failed:boolean};
type Attention=Record<string,'needs_input'|'error'>;
const Context=createContext<{register:(id:string)=>()=>void;entries:Record<string,Entry>;availability:ProgressResult['availability']|null;attention:Attention;incomplete:boolean}>({register:()=>()=>{},entries:{},availability:null,attention:{},incomplete:false});
export function ProgressProvider({children}:{children:ReactNode}) {
 const rpc=useRpc<typeof contract>();
 const [counts,setCounts]=useState<Record<string,number>>({});
 const [entries,setEntries]=useState<Record<string,Entry>>({});
 const [availability,setAvailability]=useState<ProgressResult['availability']|null>(null);
 const [attention,setAttention]=useState<Attention>({});
 const [incomplete,setIncomplete]=useState(false);
 const [revision,setRevision]=useState(0);
 useRealtime('bars-changed',()=>setRevision(value=>value+1));
 const register=useCallback((id:string)=>{
  setCounts(old=>({...old,[id]:(old[id]??0)+1}));
  return ()=>setCounts(old=>{const next={...old};if((next[id]??0)<=1)delete next[id];else next[id]!--;return next;});
 },[]);
 const ids=Object.keys(counts).sort().join('\0');
 const rpcRef=useRef(rpc);rpcRef.current=rpc;
 useEffect(()=>{
  let live=true,inFlight=false;
  let timer:ReturnType<typeof setTimeout>|undefined;
  const refresh=async()=>{
   if(!live||inFlight||document.hidden)return;
   clearTimeout(timer);inFlight=true;
   const next:Record<string,Entry>={};
   let state:ProgressResult['availability']='ready';
   try {
    const index=await rpcRef.current.call('attention',null);
    if(live){setAttention(Object.fromEntries(index.entries.map(entry=>[entry.threadId,entry.state])));setIncomplete(index.incomplete);}
    const threadIds=ids?ids.split('\0'):[];
    for(let i=0;i<threadIds.length&&live;i+=25) {
     const batch=threadIds.slice(i,i+25);
     const result=await rpcRef.current.call('progress',{threadIds:batch});
     if(result.availability!=='ready'){state=result.availability;break;}
     for(const row of result.entries)next[row.threadId]={plans:row.plans,failed:false};
     for(const id of result.failedThreadIds)next[id]={plans:[],failed:true};
    }
   } catch {state='unavailable';}
   finally {
    inFlight=false;
    if(live){setAvailability(state);setEntries(next);timer=setTimeout(()=>void refresh(),5000);}
   }
  };
  const visible=()=>{if(!document.hidden)void refresh();};
  void refresh();
  document.addEventListener('visibilitychange',visible);
  return ()=>{live=false;clearTimeout(timer);document.removeEventListener('visibilitychange',visible);};
 },[ids,revision]);
 const value=useMemo(()=>({register,entries,availability,attention,incomplete}),[register,entries,availability,attention,incomplete]);
 return <Context.Provider value={value}>{children}</Context.Provider>;
}
export function useThreadPlans(id:string) {
 const {register,entries,availability}=useContext(Context);
 useEffect(()=>register(id),[register,id]);
 return {plans:entries[id]?.plans??[],failed:entries[id]?.failed??false,availability};
}
export function ProgressNotice() {
 const {availability,incomplete}=useContext(Context);
 if(incomplete)return <p className="progress-notice" role="status">Обзор вопросов и ошибок неполный: проверены первые 2000 сохранённых тредов.</p>;
 if(availability===null||availability==='ready')return null;
 return <p className="progress-notice" role="status">Не удалось обновить планы. Повторим автоматически.</p>;
}
export function usePlanningAttention(){return useContext(Context).attention;}
