import {useRef} from 'react';
export function CompactSidebarHeader({tab,onSelect,onCompose,width,controlSize}:{tab:'now'|'projects'|null;onSelect:(tab:'now'|'projects')=>void;onCompose:()=>void;width:number;controlSize:number}) {
 const root=useRef<HTMLDivElement>(null);
 if(tab===null||width<90)return <button type="button" title="Новый чат" aria-label="Новый чат" onClick={onCompose}>＋</button>;
 return <div ref={root} className={'makosh-navigation-sidebar-header'+(width<180?' compact':'')} style={{height:controlSize,maxWidth:width}}><div role="tablist" aria-label="Раздел панели">{(['now','projects'] as const).map(id=><button type="button" key={id} id={`makosh-sidebar-tab-${id}`} role="tab" aria-selected={tab===id} aria-controls={`makosh-sidebar-panel-${id}`} tabIndex={tab===id?0:-1} title={id==='now'?'Сейчас':'Проекты'} aria-label={id==='now'?'Сейчас':'Проекты'} onClick={()=>onSelect(id)} onKeyDown={event=>{
  const next=event.key==='Home'?'now':event.key==='End'?'projects':event.key==='ArrowLeft'||event.key==='ArrowRight'?(id==='now'?'projects':'now'):null;
  if(next){event.preventDefault();onSelect(next);root.current?.querySelector<HTMLButtonElement>(`#makosh-sidebar-tab-${next}`)?.focus();}
 }}>{width<180?(id==='now'?'◉':'⌑'):(id==='now'?'Сейчас':'Проекты')}</button>)}</div><button type="button" className="compose" title="Новый чат" aria-label="Новый чат" onClick={onCompose}>＋</button></div>;
}
