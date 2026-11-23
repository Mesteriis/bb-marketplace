// @vitest-environment jsdom
import {afterEach,expect,test} from 'vitest';
import {act,cleanup,fireEvent,render} from '@testing-library/react';
import {useSidebarHeaderControls} from './sidebar-header';
import {CompactSidebarHeader} from '../../ui/compact-sidebar-header';
afterEach(cleanup);
function Header({width=240}:{width?:number}){const {tab,select}=useSidebarHeaderControls(width>=90);return <CompactSidebarHeader tab={tab} onSelect={select} onCompose={()=>{}} width={width} controlSize={24}/>;}
test('header opts in only when Sidebar is mounted, exchanges selection and returns to the normal new-chat button',()=>{
 const events:unknown[]=[];
 const receive=(e:Event)=>events.push((e as CustomEvent).detail);
 window.addEventListener('makosh-sidebar:v1:select',receive);
 try {
  const slot=render(<Header/>);
  expect(slot.queryByRole('tablist')).toBeNull();
  act(()=>window.dispatchEvent(new CustomEvent('makosh-sidebar:v1:state',{detail:{tab:'now'}})));
  expect(slot.getByRole('tab',{name:'Сегодня'}).getAttribute('aria-selected')).toBe('true');
  fireEvent.click(slot.getByRole('tab',{name:'Проекты'}));
  expect(events).toEqual([{tab:'projects'}]);
  act(()=>window.dispatchEvent(new CustomEvent('makosh-sidebar:v1:state',{detail:null})));
  expect(slot.queryByRole('tablist')).toBeNull();expect(slot.getByRole('button',{name:'Новый чат'})).toBeTruthy();
 } finally {window.removeEventListener('makosh-sidebar:v1:select',receive);}
});
test('a header too narrow for controls refuses ownership so Sidebar can show its fallback',()=>{
 const presence:unknown[]=[];const receive=(e:Event)=>presence.push((e as CustomEvent).detail);
 window.addEventListener('makosh-sidebar:v1:header',receive);
 try {
  const slot=render(<Header width={70}/>);
  act(()=>window.dispatchEvent(new CustomEvent('makosh-sidebar:v1:state',{detail:{tab:'projects'}})));
  expect(presence.at(-1)).toEqual({ready:false});expect(slot.queryByRole('tablist')).toBeNull();
 } finally {window.removeEventListener('makosh-sidebar:v1:header',receive);}
});
