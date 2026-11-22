import {useEffect,useRef,useState} from 'react';
import type {SidebarTab} from '../../ui/sidebar-tabs';
/** Optional same-document protocol v1 with Makosh Navigation; no plugin imports or RPC dependency. */
export function useSidebarHeader(tab:SidebarTab,onSelect:(tab:SidebarTab)=>void) {
 const [attached,setAttached]=useState(false);
 const current=useRef(tab);current.current=tab;
 useEffect(()=>{
  const announce=()=>window.dispatchEvent(new CustomEvent('makosh-sidebar:v1:state',{detail:{tab:current.current}}));
  const select=(event:Event)=>{const value=(event as CustomEvent).detail?.tab;if(value==='now'||value==='projects')onSelect(value);};
  const presence=(event:Event)=>setAttached((event as CustomEvent).detail?.ready===true);
  window.addEventListener('makosh-sidebar:v1:select',select);
  window.addEventListener('makosh-sidebar:v1:request',announce);
  window.addEventListener('makosh-sidebar:v1:header',presence);
  announce();
  return ()=>{window.removeEventListener('makosh-sidebar:v1:select',select);window.removeEventListener('makosh-sidebar:v1:request',announce);window.removeEventListener('makosh-sidebar:v1:header',presence);window.dispatchEvent(new CustomEvent('makosh-sidebar:v1:state',{detail:null}));};
 },[onSelect]);
 useEffect(()=>{window.dispatchEvent(new CustomEvent('makosh-sidebar:v1:state',{detail:{tab}}));},[tab]);
 return attached;
}
