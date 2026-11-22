import {useCallback,useEffect,useState} from 'react';
/** Optional same-document protocol v1. No Sidebar dependency or private host DOM access. */
export function useSidebarHeaderControls(available:boolean) {
 const [tab,setTab]=useState<'now'|'projects'|null>(null);
 useEffect(()=>{
  const state=(event:Event)=>{
   const value=(event as CustomEvent).detail?.tab;
   const valid=value==='now'||value==='projects';
   setTab(valid?value:null);
   window.dispatchEvent(new CustomEvent('makosh-sidebar:v1:header',{detail:{ready:available&&valid}}));
  };
  window.addEventListener('makosh-sidebar:v1:state',state);
  window.dispatchEvent(new CustomEvent('makosh-sidebar:v1:request'));
  return ()=>{window.removeEventListener('makosh-sidebar:v1:state',state);window.dispatchEvent(new CustomEvent('makosh-sidebar:v1:header',{detail:{ready:false}}));};
 },[available]);
 const select=useCallback((next:'now'|'projects')=>window.dispatchEvent(new CustomEvent('makosh-sidebar:v1:select',{detail:{tab:next}})),[]);
 return {tab,select};
}
