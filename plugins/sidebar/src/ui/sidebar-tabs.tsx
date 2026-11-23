import {useRef} from 'react';
export type SidebarTab='now'|'projects';
export function SidebarTabs({tab,onChange,onCompose}:{tab:SidebarTab;onChange:(tab:SidebarTab)=>void;onCompose:()=>void}) {
 const root=useRef<HTMLDivElement>(null);
 return <div className="sidebar-heading" ref={root}><div role="tablist" aria-label="Раздел панели" className="sidebar-tabs">{(['now','projects'] as const).map(id=><button key={id} id={`makosh-sidebar-tab-${id}`} role="tab" aria-selected={tab===id} aria-controls={`makosh-sidebar-panel-${id}`} tabIndex={tab===id?0:-1} onClick={()=>onChange(id)} onKeyDown={event=>{
  const next=event.key==='Home'?'now':event.key==='End'?'projects':event.key==='ArrowLeft'||event.key==='ArrowRight'?(id==='now'?'projects':'now'):null;
  if(next){event.preventDefault();onChange(next);root.current?.querySelector<HTMLButtonElement>(`#makosh-sidebar-tab-${next}`)?.focus();}
 }}>{id==='now'?'Сегодня':'Проекты'}</button>)}</div><button type="button" className="compose-thread" aria-label="Новый чат" title="Новый чат" onClick={onCompose}>＋</button></div>;
}
